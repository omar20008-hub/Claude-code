import { describe, it, expect } from 'vitest';
import {
  parseCitations,
  parseSourceBasis,
  stripCitationMarkup,
  parseKnowledgeAnswer,
} from '@/server/agents/citations';

/**
 * Citation parsing (§16, §51).
 *
 * The Knowledge workflow returns no structured sources array — its system
 * prompt tells the model to write citations inline, in Arabic markers. So the
 * SaaS has to read them back out of prose written by a language model, which
 * means the parser has to survive the ways a model actually varies its output:
 * a different dash, a translated marker, a missing basis line.
 *
 * The fixtures below are shaped exactly like the workflow's instructions:
 *
 *   المصدر: المستندات
 *   ...text... [ملف: سياسة الموارد البشرية.pdf]
 *   ...text... [ويب: example.com — https://example.com/page]
 */

describe('source basis', () => {
  it('reads the Arabic basis line the workflow prescribes', () => {
    expect(parseSourceBasis('المصدر: المستندات\n\nالإجابة هنا.')).toBe('documents');
    expect(parseSourceBasis('المصدر: الإنترنت\n\nالإجابة هنا.')).toBe('web');
    expect(parseSourceBasis('المصدر: المستندات + الإنترنت\n\nالإجابة.')).toBe('both');
  });

  it('reads an English basis line, which the model produces for English answers', () => {
    expect(parseSourceBasis('Source: documents\n\nThe answer.')).toBe('documents');
    expect(parseSourceBasis('Source: the web\n\nThe answer.')).toBe('web');
    expect(parseSourceBasis('Sources: documents and the web')).toBe('both');
  });

  it('reports "none" rather than guessing when no basis is declared', () => {
    expect(parseSourceBasis('مجرد إجابة بدون مصدر.')).toBe('none');
    expect(parseSourceBasis('')).toBe('none');
  });

  it('does not mistake a combined basis for a single one', () => {
    // Order matters: "documents + web" must be tested before either term alone,
    // or a combined answer is misreported as documents-only.
    expect(parseSourceBasis('المصدر: المستندات + الإنترنت')).not.toBe('documents');
  });
});

describe('citation extraction', () => {
  it('extracts document citations in the workflow’s exact format', () => {
    const answer = `المصدر: المستندات

مدة الإجازة السنوية ٢١ يوم عمل [ملف: سياسة الموارد البشرية.pdf]، وتزيد بعد خمس سنوات [ملف: دليل الموظف.docx].`;

    const citations = parseCitations(answer);

    expect(citations).toEqual([
      { kind: 'document', label: 'سياسة الموارد البشرية.pdf' },
      { kind: 'document', label: 'دليل الموظف.docx' },
    ]);
  });

  it('extracts web citations and splits the site label from the URL', () => {
    const answer = `المصدر: الإنترنت

حسب الموقع الرسمي [ويب: hrsd.gov.sa — https://hrsd.gov.sa/ar/policies].`;

    const citations = parseCitations(answer);

    expect(citations).toEqual([
      { kind: 'web', label: 'hrsd.gov.sa', url: 'https://hrsd.gov.sa/ar/policies' },
    ]);
  });

  it('tolerates the separators a language model actually varies between', () => {
    // Em dash, en dash, hyphen, and no separator at all.
    for (const separator of ['—', '–', '-', '']) {
      const citations = parseCitations(`[ويب: example.com ${separator} https://example.com/a]`);
      expect(citations[0]?.url, `separator "${separator}"`).toBe('https://example.com/a');
      expect(citations[0]?.label).toBe('example.com');
    }
  });

  it('accepts English markers, since the agent answers in the asker’s language', () => {
    const answer = 'Annual leave is 21 days [file: HR Policy.pdf] per [web: gov.sa — https://gov.sa/x].';
    const citations = parseCitations(answer);

    expect(citations).toContainEqual({ kind: 'document', label: 'HR Policy.pdf' });
    expect(citations).toContainEqual({
      kind: 'web',
      label: 'gov.sa',
      url: 'https://gov.sa/x',
    });
  });

  it('derives a label from the hostname when the model omits one', () => {
    const citations = parseCitations('[ويب: https://www.example.com/deep/path]');
    // `www.` stripped: a user reading a source list wants the site, not the CNAME.
    expect(citations[0]).toEqual({
      kind: 'web',
      label: 'example.com',
      url: 'https://www.example.com/deep/path',
    });
  });

  it('picks up a bare URL the model wrote outside the bracket form', () => {
    const citations = parseCitations('See https://example.com/report for detail.');
    expect(citations).toEqual([
      { kind: 'web', label: 'example.com', url: 'https://example.com/report' },
    ]);
  });

  it('does not list one URL twice when it appears bracketed and bare', () => {
    const answer = `[ويب: example.com — https://example.com/a]

Full text at https://example.com/a`;
    const citations = parseCitations(answer);
    expect(citations).toHaveLength(1);
  });

  it('strips trailing punctuation from a bare URL', () => {
    const citations = parseCitations('راجع https://example.com/policy.');
    expect(citations[0]?.url).toBe('https://example.com/policy');
  });

  it('de-duplicates repeated citations, preserving first-seen order', () => {
    const answer = `[ملف: A.pdf] ثم [ملف: B.pdf] ثم [ملف: A.pdf] مرة أخرى.`;
    expect(parseCitations(answer).map((c) => c.label)).toEqual(['A.pdf', 'B.pdf']);
  });

  it('invents nothing when there is nothing to find', () => {
    // The single most important assertion in this file: no citations rather
    // than plausible-looking ones (§52).
    expect(parseCitations('لا أعرف الإجابة.')).toEqual([]);
    expect(parseCitations('')).toEqual([]);
    expect(parseCitations('[ملف: ]')).toEqual([]);
  });
});

describe('markup stripping', () => {
  it('removes the basis line and the inline markers from displayed prose', () => {
    const answer = `المصدر: المستندات

مدة الإجازة ٢١ يومًا [ملف: سياسة.pdf] حسب اللائحة.`;

    const stripped = stripCitationMarkup(answer);

    expect(stripped).not.toContain('المصدر:');
    expect(stripped).not.toContain('[ملف:');
    expect(stripped).toContain('مدة الإجازة ٢١ يومًا');
    expect(stripped).toContain('حسب اللائحة');
  });

  it('does not leave a space stranded before Arabic punctuation', () => {
    const stripped = stripCitationMarkup('الإجابة [ملف: x.pdf]، ثم التفاصيل.');
    expect(stripped).toContain('الإجابة،');
  });
});

describe('full answer parsing', () => {
  it('produces answer, citations and basis from one workflow response', () => {
    const raw = `المصدر: المستندات + الإنترنت

بحسب سياسة الموارد البشرية، مدة الإجازة ٢١ يوم عمل [ملف: سياسة الموارد البشرية.pdf].
وهذا يتوافق مع نظام العمل [ويب: hrsd.gov.sa — https://hrsd.gov.sa/ar/labor-law].`;

    const result = parseKnowledgeAnswer(raw);

    expect(result.sourceBasis).toBe('both');
    expect(result.citations).toHaveLength(2);
    expect(result.answer).not.toContain('[ملف:');
    expect(result.answer).toContain('مدة الإجازة ٢١ يوم عمل');
    // The workflow emits no confidence score, so none is reported (§16, §52).
    expect(result.confidence).toBeUndefined();
  });

  it('infers the basis from citations when the model omits the basis line', () => {
    const result = parseKnowledgeAnswer('الإجابة [ملف: A.pdf] والمزيد [ويب: b.com — https://b.com].');
    expect(result.sourceBasis).toBe('both');
  });

  it('reports "none" for an answer with neither a basis line nor citations', () => {
    const result = parseKnowledgeAnswer('لم أجد إجابة في المستندات.');
    expect(result.sourceBasis).toBe('none');
    expect(result.citations).toEqual([]);
  });
});
