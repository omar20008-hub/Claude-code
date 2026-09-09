import type { Citation, KnowledgeAskResult } from './contracts';

/**
 * Citation extraction for the Knowledge agent.
 *
 * The RAG workflow returns no structured sources array. Its system prompt
 * instructs the model to write citations inline, in a fixed shape:
 *
 *   المصدر: المستندات                     <- basis line, first line of the answer
 *   ...text... [ملف: سياسة الموارد البشرية.pdf]
 *   ...text... [ويب: example.com — https://example.com/page]
 *
 * So the SaaS has to read them back out of prose. Two consequences shape this
 * module:
 *
 *  1. It must be forgiving. A language model does not emit a fixed format
 *     reliably: it varies the dash (—, –, -), sometimes translates the markers
 *     when answering in English, and occasionally omits the basis line. Each of
 *     those is handled explicitly rather than producing zero citations.
 *  2. It must never invent. If nothing matches, the result is an empty citation
 *     list and a basis of 'none' — the UI then says no source was cited rather
 *     than showing a fabricated one (§52).
 *
 * The UI labels these as parsed from the answer text
 * (`knowledge.sources.parsedNotice`) so a user knows their provenance.
 */

/** `[ملف: name]`, `[file: name]`, `[document: name]`, `[مستند: name]`. */
const DOCUMENT_CITATION =
  /\[\s*(?:ملف|مستند|file|document|doc)\s*[:：]\s*([^\]]+?)\s*\]/giu;

/**
 * `[ويب: site — url]` / `[web: site - url]`. The separator is optional so a
 * citation carrying only a URL, or only a site name, still resolves.
 */
const WEB_CITATION =
  /\[\s*(?:ويب|الويب|web|site|url)\s*[:：]\s*([^\]]+?)\s*\]/giu;

/** A bare URL, used as a last resort when the bracket form is absent. */
const BARE_URL = /https?:\/\/[^\s<>()[\]"']+/giu;

/** The basis line, in either language. */
const BASIS_LINE =
  /^\s*(?:المصدر|المصادر|source|sources)\s*[:：]\s*(.+)$/imu;

/**
 * Reads the leading "basis" declaration.
 *
 * Order matters: "documents + web" has to be tested before either single term,
 * or a combined answer is misreported as documents-only.
 */
export function parseSourceBasis(answer: string): KnowledgeAskResult['sourceBasis'] {
  const match = BASIS_LINE.exec(answer);
  if (!match || !match[1]) return 'none';

  const value = match[1].toLowerCase();

  const mentionsDocuments =
    /المستندات|المستند|الوثائق|document|documents|file|files/u.test(value);
  const mentionsWeb = /الإنترنت|الانترنت|الويب|internet|web|online/u.test(value);

  if (mentionsDocuments && mentionsWeb) return 'both';
  if (mentionsDocuments) return 'documents';
  if (mentionsWeb) return 'web';
  return 'none';
}

/**
 * Splits a web citation body into its site label and URL.
 *
 * Accepts "site — https://…", "site - https://…", "site https://…" and a bare
 * URL, deriving the label from the hostname when no label was written.
 */
function splitWebCitation(body: string): Citation {
  const urlMatch = body.match(/https?:\/\/[^\s<>()[\]"']+/u);
  const url = urlMatch?.[0];

  // Everything before the URL, minus any trailing separator, is the label.
  let label = url ? body.slice(0, body.indexOf(url)) : body;
  label = label.replace(/[—–\-–—:|]+\s*$/u, '').trim();

  if (label.length === 0 && url) {
    try {
      label = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      label = url;
    }
  }

  return { kind: 'web', label: label || (url ?? body.trim()), url };
}

/** Case-insensitive de-duplication key. */
function citationKey(citation: Citation): string {
  return `${citation.kind}:${(citation.url ?? citation.label).toLowerCase()}`;
}

/**
 * Extracts every citation from an answer, in the order it appears, without
 * duplicates.
 */
export function parseCitations(answer: string): Citation[] {
  const found: Citation[] = [];
  const seen = new Set<string>();

  const add = (citation: Citation): void => {
    // Guard against a model emitting an empty bracket.
    if (citation.label.trim().length === 0 && !citation.url) return;
    const key = citationKey(citation);
    if (seen.has(key)) return;
    seen.add(key);
    found.push(citation);
  };

  // Bracketed document citations.
  for (const match of answer.matchAll(DOCUMENT_CITATION)) {
    const label = match[1]?.trim();
    if (label) add({ kind: 'document', label });
  }

  // Bracketed web citations.
  const bracketedUrls = new Set<string>();
  for (const match of answer.matchAll(WEB_CITATION)) {
    const body = match[1]?.trim();
    if (!body) continue;
    const citation = splitWebCitation(body);
    if (citation.url) bracketedUrls.add(citation.url);
    add(citation);
  }

  // Bare URLs the model wrote outside the bracket form. Skipped when already
  // captured above, so one link never appears twice.
  for (const match of answer.matchAll(BARE_URL)) {
    const url = match[0].replace(/[.,;:!?)\]]+$/u, '');
    if (bracketedUrls.has(url)) continue;
    // Inside a bracketed citation we already parsed — don't double count.
    if ([...bracketedUrls].some((known) => known.startsWith(url))) continue;
    try {
      add({ kind: 'web', label: new URL(url).hostname.replace(/^www\./, ''), url });
    } catch {
      // Not a parseable URL; ignore rather than adding a broken citation.
    }
  }

  return found;
}

/**
 * Removes the machine-readable citation markers from the prose so the chat
 * bubble reads naturally, while the structured list is rendered separately.
 *
 * The basis line is stripped too — it becomes a labelled badge above the
 * sources list instead of a stray first line.
 */
export function stripCitationMarkup(answer: string): string {
  return answer
    .replace(BASIS_LINE, '')
    .replace(DOCUMENT_CITATION, '')
    .replace(WEB_CITATION, '')
    // Collapse the double spaces and orphaned punctuation the removals leave.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,؛،!؟])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Full parse of a Knowledge agent answer.
 *
 * `answer` keeps the original prose (minus the markers) for display;
 * `citations` and `sourceBasis` carry the structure the UI needs.
 */
export function parseKnowledgeAnswer(rawAnswer: string): KnowledgeAskResult {
  const citations = parseCitations(rawAnswer);
  let sourceBasis = parseSourceBasis(rawAnswer);

  // The model sometimes omits the basis line but still cites. Infer it from the
  // citations rather than reporting 'none' against visible evidence.
  if (sourceBasis === 'none' && citations.length > 0) {
    const hasDocuments = citations.some((c) => c.kind === 'document');
    const hasWeb = citations.some((c) => c.kind === 'web');
    if (hasDocuments && hasWeb) sourceBasis = 'both';
    else if (hasDocuments) sourceBasis = 'documents';
    else if (hasWeb) sourceBasis = 'web';
  }

  return {
    answer: stripCitationMarkup(rawAnswer),
    citations,
    sourceBasis,
    // The workflow emits no confidence score, so none is reported (§16).
    confidence: undefined,
  };
}
