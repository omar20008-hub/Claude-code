# Agent contracts

What the three n8n workflows actually do, discovered by reading their live
definitions rather than assumed from the brief. Everything in this document was
verified against the running n8n instance.

Read this first. Several findings contradict what a reader would reasonably
expect, and the SaaS is built to the reality.

---

## Summary of the three workflows

| | Knowledge | Creative | Advertising |
|---|---|---|---|
| Workflow ID | `pOwwQdXNflGHVaV8` | `7GYulsPGi7WFpJzx` | `Pm3x6FweL5opKlj0` |
| Name | Agentic RAG — Google Drive + Web Fallback | استوديو المحتوى المرئي — Gemini + Veo + Google Drive | محادثة إنشاء إعلان على Meta Ads |
| Trigger | `chatTrigger` | `chatTrigger` | `chatTrigger` |
| Webhook ID | `bba97385-5d58-421b-b1b4-693ff678ac83` | `8f794ade-d341-404e-926e-761c859069fc` | `ff63d651-30aa-4e08-adf4-7f11687177a7` |
| Response mode | `streaming` | `responseNodes` | `responseNodes` |
| File uploads | no | no | yes, first message only |
| Returns an execution ID | no | no | no |
| Calls back into the SaaS | no | no | no |

---

## The five findings that shaped the architecture

### 1. All three are chat triggers, not JSON webhooks

Every workflow is an `@n8n/n8n-nodes-langchain.chatTrigger`. There is no REST
endpoint, no request schema, and no structured response. The transport is n8n's
hosted-chat envelope:

```
POST {N8N_BASE_URL}/webhook/{webhookId}/chat
Content-Type: application/json

{ "action": "sendMessage", "sessionId": "...", "chatInput": "...", "files": [...] }
```

Consequences the SaaS absorbs, all inside `src/server/agents/`:

- **Correlation is ours.** No workflow returns an execution ID, so
  `agent_requests.n8n_execution_id` is usually null and honestly so. The SaaS
  sends `X-Correlation-Id` on every call so an operator can match a request to
  an execution by timestamp and correlation value.
- **Three wire formats.** `lastNode` returns one JSON document; `streaming`
  returns newline-delimited token frames; `responseNodes` returns one frame per
  "Respond to Chat" node. `parseChatFrames` and `joinFrames` normalise all
  three. The join is format-sensitive: token frames must be concatenated with no
  separator, whole messages with a blank line. Getting it backwards either runs
  paragraphs together or shreds sentences.
- **Conversation memory is a capability.** All three keep a 10-turn
  `memoryBufferWindow` keyed on `sessionId`. That value is effectively a handle
  to a conversation's history, so the SaaS generates it with 24 bytes of entropy
  and never returns it to the browser.

### 2. §24's callback architecture does not exist in these workflows

The brief describes `n8n → callback → SaaS backend`. None of the three
workflows has a node that calls back.

`POST /api/v1/webhooks/n8n` is nevertheless implemented and tested in full —
HMAC-SHA256 signature, timestamp window, database-backed nonce replay
protection, secret rotation, idempotent application. It receives no traffic
today. It exists so that adopting the callback pattern is a workflow change
rather than a SaaS project, and so the security work is done before it is
needed rather than after. See [n8n-integration.md](./n8n-integration.md).

### 3. The Creative workflow cannot generate video

The Content Director agent's system prompt forbids it outright:

> قيد مهم: توليد الفيديو معطّل حاليًا وغير متاح.
> لا تختر أبدًا content_type = "video" مهما طلب المستخدم.

The workflow's own sticky note records the cause:

> السبب: نماذج Veo مدفوعة والحصة المجانية صفر على المفتاح الحالي.

The Veo branch exists and is wired, but is unreachable. A video request produces
a key-frame **image** instead.

The SaaS therefore:

- reports `video_generation` as unavailable from `CreativeAgentAdapter.capabilities()`;
- disables the Video option in Creative Studio **and explains why**, rather than
  hiding it — a user who asked for a video product deserves to know;
- sets `downgradedFrom: 'VIDEO'` on the result and badges the asset in the
  library, so the reason is still visible months later.

Also worth knowing: the node named "Nano Banana" actually calls
**Pollinations.ai** (`image.pollinations.ai/prompt/...?model=flux`). Asset
metadata records `pollinations/flux`, which is what really ran.

### 4. The Advertising workflow never launches anything

Every Meta object is created paused. From the workflow's Graph API calls:

```js
// Create Paused Campaign
{ name, objective, status: 'PAUSED', special_ad_categories: [] }
// Create Paused Ad Set
{ ..., status: 'PAUSED' }
// Create Paused Ad
{ ..., status: 'PAUSED' }
```

There is no activation step anywhere. The success message tells the user:

> راجعها في Ads Manager وفعّلها يدوياً قبل أن يبدأ الصرف.

So "launch" in this product means **create the objects on Meta, paused**. A
successful submission moves a campaign to `PAUSED`, never `ACTIVE`, and both
languages say so on the wizard, on the campaign list and on the detail page.
Reporting `ACTIVE` would tell a user money is being spent when it is not.

### 5. Meta performance metrics are unobtainable

The advertising workflow contains no Insights node and no reporting call. It
creates objects and stops.

Impressions, clicks, CTR, CPC, conversions and ROAS therefore cannot be read
through this integration. The `campaign_metrics` table exists and the analytics
layer computes every derived rate correctly, but nothing writes to it, so
`getCampaignPerformance` returns `{ available: false }` and the UI renders an
explanation naming the cause. Zeros would read as "nobody saw this ad".

---

## Knowledge Agent — `pOwwQdXNflGHVaV8`

**Input**

```json
{ "action": "sendMessage", "sessionId": "aiw_<24 bytes base64url>", "chatInput": "<question>" }
```

**Output** — newline-delimited token frames that concatenate into one markdown
answer. No structured fields.

**Citations are prose.** The system prompt instructs the model to write them
inline:

```
المصدر: المستندات
…text… [ملف: سياسة الموارد البشرية.pdf]
…text… [ويب: example.com — https://example.com/page]
```

`src/server/agents/citations.ts` parses these back into structured
`Citation[]`, tolerating the variations a language model actually produces:
different dashes, English markers on English answers, a missing basis line, a
bare URL. When nothing matches it returns an empty list — never an invented
source. The UI labels the sources panel with
`knowledge.sources.parsedNotice` so a user knows where they came from.

**Not available**

| Capability | Why |
|---|---|
| Confidence score | The workflow emits none. `confidence` stays `undefined` and the indicator is hidden. |
| Structured sources | Parsed from prose, as above. |
| `locale` parameter | The trigger has no such field. The agent's own prompt says "reply in the same language the user writes in", so language rides on the question. The adapter prepends a one-line steer only when the UI locale and the apparent language of the question disagree. |
| Per-tenant Drive folder | One folder, one credential, inside n8n. See below. |
| Document count | Never reported. The UI says so rather than showing `0`. |

**Knowledge source**

- Google Drive folder `1REHc656Hc9jGmB3-y_40cvnVeVTSvyVt` ("n8n agent")
- Credential `aCAwt610o8fHdgLF`, held by n8n. **The SaaS stores no Google token.**
- Reindexed every 6 hours by the `Refresh Index Every 6h` schedule trigger.
- Formats: PDF (Gemini OCR, cached as `<name>.ocr.txt`), DOC/DOCX (via a
  temporary Google Doc conversion), Google Docs, `text/*`.
- Vector store is **in-memory** under key `gdrive_agentic_kb`, so the index is
  lost on an n8n restart until the next scheduled rebuild.

---

## Creative Agent — `7GYulsPGi7WFpJzx`

**Input**

```json
{ "action": "sendMessage", "sessionId": "aiw_gen_<16 bytes>", "chatInput": "<description>" }
```

`loadPreviousSession: notSupported`, so every generation uses a fresh session
id; there is no history to reuse.

**Brief schema** produced by the Content Director:

```json
{
  "content_type": "image | text",
  "title": "…",
  "image_prompt": "<English, cinematic>",
  "video_prompt": "<English — filled but unused>",
  "aspect_ratio": "16:9 | 9:16",
  "duration_seconds": 5,
  "caption": "<Arabic marketing copy>",
  "reply": "<Arabic, 1-2 lines>"
}
```

**Output** — several streamed messages: a brief acknowledgement, then the image
inline as a markdown `data:` URI, then an approval prompt.

**Dimensions** — 16:9 → 1280×720, 9:16 → 768×1280. No other sizes.

**The blocking approval.** After showing the image the workflow reaches a
`sendAndWait` node asking whether to save to Google Drive, and waits up to two
hours on a separate approval webhook. The SaaS does not answer it: it takes the
inline image it already has and stores it in its own object storage, which is
what the asset library reads. The pending n8n execution times out harmlessly.

---

## Advertising Agent — `Pm3x6FweL5opKlj0`

**Input** — one message carrying the whole brief, with the creative attached.

```json
{
  "action": "sendMessage",
  "sessionId": "aiw_ad_<campaign uuid>",
  "chatInput": "<labelled Arabic brief>",
  "files": [{ "name": "creative.jpg", "type": "image/jpeg", "data": "<base64>" }]
}
```

The workflow's own subtitle states attachments are read on the **first message
only**:

> أرفق المادة الإعلانية مع أول رسالة — المرفقات لا تُقبل في الردود اللاحقة.

so the SaaS sends everything in one shot. That also makes the intake agent's
`complete` flag true on the first pass, so it proceeds straight to creation
rather than interrogating a caller that cannot answer interactively. It gives up
after six rounds.

**Fixed configuration** (from the workflow's `Ad Config` node)

| Setting | Value |
|---|---|
| Ad account | `act_125720069264571` |
| Page | `1322234657642558` |
| Graph API | `v26.0` |
| Currency | `SAR` |
| Objective | `OUTCOME_TRAFFIC` |
| Default country | `SA` |
| Schedule offset | `+0300` (Riyadh) |
| Credential | `ptyUVppYMrGDiu1P`, held by n8n |

**Ad set defaults**: `billing_event: IMPRESSIONS`,
`optimization_goal: LINK_CLICKS`, `bid_strategy: LOWEST_COST_WITHOUT_CAP`,
`lifetime_budget` in **minor units** (major × 100).

**Creative validation**, mirrored client-side and server-side so a user learns
about a problem before submission:

| Rule | Value |
|---|---|
| Minimum short side | 1080 px |
| Max image | 30 MiB |
| Max video | 4 GiB |
| Ratio tolerance | 3% |
| Primary text | ≤ 125 characters |
| Headline | ≤ 40 characters |
| Schedule | end date strictly after start date |

Placements and their required ratios:

| Placement (Meta's own string) | Ratio | Catalogue key |
|---|---|---|
| `Feed 1:1` | 1.0 | `feed_square` |
| `Feed 4:5` | 0.8 | `feed_portrait` |
| `Stories / Reels 9:16` | 0.5625 | `stories_reels` |
| `Landscape 1.91:1` | 1.9104 | `landscape` |

The catalogue key column is not decoration: next-intl resolves a translation key
by splitting on dots, so `Landscape 1.91:1` cannot be a key. Meta's vocabulary
stays out of the catalogue entirely.

**Accepted media**: `image/jpeg`, `image/png`, `image/webp`, `video/mp4`,
`video/quicktime`.

**Output** — the success message prints the created IDs:

```
Campaign: 120…
Ad Set:   120…
Ad:       120…
```

`extractMetaIds` prefers a structured frame when one is present and falls back
to this text form, which is what the current workflow actually emits. Success is
defined as Meta returning object IDs — anything else is a failure, however
cheerfully the agent phrased it.

---

## Credential ownership

**No third-party credential is stored by this application.** Google Drive OAuth
and the Meta Graph token both live in n8n's credential store. The SaaS holds:

- the n8n base URL and webhook IDs (server-side environment only, never sent to
  a browser);
- optional header auth for the n8n webhooks;
- the callback signing secrets.

`integrations.encrypted_credentials` exists for a future integration the SaaS
owns directly, and is null today. The Settings page states where each credential
actually lives rather than implying this workspace holds a token it has never
seen.

---

## Replacing n8n

Nothing outside `src/server/agents/` knows n8n exists. The rest of the
application speaks only `AgentRequest` / `AgentResponse` from
`contracts.ts`. Moving to LangGraph, the Claude Agent SDK or bespoke
infrastructure means writing three new adapters against that interface.

An adapter must also report its own limits through `capabilities()`. The UI
renders "not available" states from those declarations, not from hard-coded
copy, so a replacement that *can* generate video turns the feature on by
reporting that it can.
