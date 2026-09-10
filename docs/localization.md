# Localization

Arabic and English, both complete from the first commit. The architecture is
localization-first: there is no default language that other languages are
retrofitted onto.

---

## The principle

**No user-facing string is authored inside a component.** That constraint does
more work than it appears to:

- The API returns error **codes**, never messages. The browser renders
  `errors.<code>` from its own catalogue, so one backend serves an Arabic and an
  English user correctly without knowing which is which.
- Notifications store an i18n key plus parameters, never rendered text. A
  notification created while a user was reading Arabic renders in English after
  they switch.
- Audit rows store `campaign.launched`, never "Launched a campaign". An event
  recorded by an Arabic-speaking colleague renders in English for whoever reads
  it next.

Anything that freezes prose into a database row or an HTTP response makes the
language of the *writer* win over the language of the *reader*. That is the bug
this architecture exists to prevent.

---

## Locale resolution

In priority order:

1. **The URL prefix.** `/ar/...` or `/en/...` always wins, so a shared link
   opens in the language it was shared in.
2. **The `AIW_LOCALE` cookie**, set by the switcher and mirrored from the
   signed-in user's saved preference.
3. **`Accept-Language`**, negotiated with q-values — not header order. `q=0`
   is honoured as "explicitly not acceptable".
4. **`DEFAULT_LOCALE`** (`ar`).

Every page lives under `/[locale]/`, including the default. That is deliberate:

- `<html dir>` is correct in the first byte, so an Arabic user never sees a
  frame of left-to-right layout;
- any page is linkable in a specific language;
- caches key on the URL rather than needing `Vary: Cookie`.

An authenticated user's choice is written to `users.locale_preference`, so it
follows them to another device and gives notifications and email a language when
the user is not present.

---

## Catalogue structure

`messages/en.json` and `messages/ar.json`, ~723 keys each, organised by feature
with semantic names:

```
dashboard.metrics.totalRequests
agents.knowledge.title
campaigns.status.PAUSED
errors.field.too_short
activity.actions.campaign.launched
```

Never `text1`, `label2`, `button3`.

### Keys must not contain dots

next-intl resolves a key by **splitting on dots** and walking the object. A
catalogue entry literally named `"auth.login"` is a different thing from a
nested `auth: { login: … }`, and the lookup misses it.

This shipped and was caught late. `activity.actions` held 26 flat keys named
`auth.login`, `campaign.launched` and so on, so the entire Activity page
rendered raw key paths **in both languages**. The same flaw hid in the
`"Landscape 1.91:1"` placement label.

Neither existing i18n test could see it: both flatten the catalogue with dots,
which makes a literal dotted key indistinguishable from a nested path. It
surfaced only as a `MISSING_MESSAGE` line in the server log during an
end-to-end run.

There is now a test that walks the raw objects instead of a flattened view, and
external vocabulary (Meta's placement strings) is mapped to slugs so it never
becomes a catalogue key.

---

## Arabic that reads like Arabic

Professional Saudi/Gulf business register, not machine translation:

| English | Arabic | Note |
|---|---|---|
| Dashboard | لوحة التحكم | The standard term; not a literal "board of control". |
| AI Agents | الوكلاء الأذكياء | |
| Creative Studio | استوديو المحتوى | |
| Activity | سجل النشاط | "Activity log" — clearer than a bare "نشاط". |
| Organization | المنشأة | The register Saudi business software uses, not "منظمة". |
| Total AI Requests | إجمالي طلبات الذكاء الاصطناعي | |
| Advertising spend | الإنفاق الإعلاني | |

Agent names follow the brief's own phrasing: وكيل المعرفة، وكيل صناعة المحتوى،
وكيل الحملات الإعلانية.

### Digits

Arabic UI uses **Western (Latin) digits**, not Arabic-Indic. Saudi business
software overwhelmingly does: an invoice reading ٣٥٠٫٠٠ ر.س. looks archaic next
to 350.00 ر.س. Configured once, in `localeConfig.ar.numberingSystem = 'latn'`,
with Arabic month names and the Gregorian calendar.

### Plurals

Arabic distinguishes **six** categories — zero, one, two, few (3–10), many
(11–99), other (100+). Every count-bearing message supplies all six:

```json
"unreadCount": "{count, plural, zero {لا إشعارات غير مقروءة} one {إشعار واحد غير مقروء} two {إشعاران غير مقروءين} few {# إشعارات غير مقروءة} many {# إشعارًا غير مقروء} other {# إشعار غير مقروء}}"
```

A hand-rolled `n === 1` check produces grammatically wrong output for 3, 11 and
100. The test suite renders each message across all six bands and asserts they
differ.

---

## Formatting

`src/i18n/format.ts` is the only place a number or date is formatted. It also
handles the problem `toLocaleString` does not: **bidi isolation**.

A Latin filename inside Arabic prose reorders under the Unicode bidirectional
algorithm — "HR Policy.pdf" can render with the extension displaced, which reads
as a corrupted filename to an Arabic speaker. Two tools:

- `isolate(text)` wraps a run in U+2068/U+2069.
- The `.force-ltr` and `.bidi-isolate` CSS classes do the same for rendered
  elements — used for email addresses, Meta IDs, correlation references, URLs
  and filenames throughout the UI.

Money is stored in minor units and converted exactly once, in
`formatCurrencyMinor`, so no other code has to remember which unit it is
holding.

---

## What the tests enforce

[`tests/i18n/`](../tests/i18n/) — 30 tests:

**catalogues.test.ts**
- identical key sets across locales
- no empty or `TODO` values
- every message compiles as valid ICU **in its own locale**
- identical argument names across locales, compared by walking the parsed ICU
  AST — a regex cannot tell `{count}` from literal text inside a plural branch
- every plural covers the categories the language actually distinguishes,
  read from `Intl.PluralRules`
- Arabic plurals render distinctly across all six bands
- no Latin-script prose in the Arabic catalogue (product names allowed)
- **no key whose own name contains a dot**

**usage.test.ts** — statically extracts every literal `t('key')` call, resolves
it against the namespace bound to that translator, and checks both catalogues.
This exists because a bug of exactly that shape shipped: `t('backToLogin')`
called in the `auth.resetPassword` namespace, where the key did not exist. Both
catalogues were internally consistent, so no other test could see it.

Verified non-vacuous: introducing a bad key fails with an exact file:line. The
extractor is scope-tolerant, so a file binding the same translator name in two
components produces no false positives, and it counts dynamic keys separately
rather than guessing at them.

**rtl.test.ts** — locale negotiation including q-values, direction detection,
bidi isolation, and currency/byte formatting in both locales.

**E2E** — every page in both languages and both directions; see
[rtl-ltr.md](./rtl-ltr.md).

---

## Adding a language

1. Add it to `locales` in `src/i18n/config.ts` with its direction, BCP-47 tag,
   endonym, numbering system and font stack.
2. Create `messages/<code>.json`. The catalogue tests will list every missing
   key.
3. If it is RTL, nothing else is needed — the design system is already
   direction-agnostic.
4. If its plural rules differ, the plural-coverage test names the categories it
   requires.

No component changes. That is the point of the architecture.
