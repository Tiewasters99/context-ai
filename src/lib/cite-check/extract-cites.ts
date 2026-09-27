import { generateStructured } from '@/lib/llm';
import {
  buildRepairContent,
  runWithContract,
  trimmedText,
  type ContractAttempt,
  type ContractCheck,
} from '@/lib/llm/contract';
import { normalizeQuoteText } from '@/lib/bucketizer/quote';
import type { Cite, AuthorityType } from './types';

export const AUTHORITY_TYPES: AuthorityType[] = ['statute', 'regulation', 'case', 'treatise', 'rule', 'other'];

/** More citations than any brief holds: the answer is not a citation list. */
export const MAX_EXTRACTED_CITES = 1_500;

/**
 * Shortest `raw` that can be checked against the draft. Under this a substring
 * search matches almost anything, so the fabrication guard below would be
 * worthless — and nothing that short is a citation.
 */
const MIN_RAW_CHARS = 4;

const EXTRACT_SYSTEM = `You are a legal citation extractor. Read the draft and extract every legal citation with the surrounding proposition.

For each distinct citation in the text, include it in the citations array. Extract every citation — if the same case is cited multiple times, emit one entry per location.

Rules:
  - Don't invent citations. If you're not sure something is a real cite, omit it.
  - Statutes (11 U.S.C. § 523(a)(7), CPLR § 214(2), 6 RCNY § 6-47) are authority_type = "statute".
  - Federal regulations (12 C.F.R. § 1026.x, eCFR) are authority_type = "regulation".
  - Cases are authority_type = "case".
  - "court" is the court level (e.g., "S.Ct.", "2d Cir.", "N.Y.", "1st Dep't"); null for statutes.
  - "pin_cite" is the page or section pin (e.g., "282", "44", "486-87") if present.
  - "signal" is "see", "see also", "accord", "cf.", "but see", "e.g.", "compare", or null.
  - "doctrinal_subject" is an array of subject tags ("consumer protection", "bankruptcy", "First Amendment", etc).
  - "location" is a short snippet of surrounding text (~80 chars) so a human can find this cite in the draft.
  - "proposition" is the claim the cite is supporting, drawn from the surrounding sentence (1-2 sentences max).`;

const CITE_SCHEMA = {
  type: 'object',
  properties: {
    citations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          raw: { type: 'string' },
          citation_bluebook: { type: ['string', 'null'] },
          case_name: { type: ['string', 'null'] },
          court: { type: ['string', 'null'] },
          year: { type: ['integer', 'null'] },
          pin_cite: { type: ['string', 'null'] },
          proposition: { type: ['string', 'null'] },
          signal: { type: ['string', 'null'] },
          authority_type: { type: 'string', enum: ['statute', 'regulation', 'case', 'treatise', 'rule', 'other'] },
          doctrinal_subject: { type: 'array', items: { type: 'string' } },
          location: { type: ['string', 'null'] },
        },
        required: ['raw', 'authority_type'],
      },
    },
  },
  required: ['citations'],
} as const;

interface RawCite {
  raw?: string;
  citation_bluebook?: string | null;
  case_name?: string | null;
  court?: string | null;
  year?: number | null;
  pin_cite?: string | null;
  proposition?: string | null;
  signal?: string | null;
  authority_type?: string;
  doctrinal_subject?: string[];
  location?: string | null;
}

// ---------------------------------------------------------------------------
// The output contract
// ---------------------------------------------------------------------------

/**
 * IS THIS CITATION ACTUALLY IN THE BRIEF?
 *
 * The extractor's one unforgivable failure is inventing a citation. A brief
 * that never cited *Graham v. Connor* comes back with it in the Table of
 * Authorities, and the attorney — who asked this tool precisely because
 * hallucinated cites are the thing that gets lawyers sanctioned — now has one
 * in a document that looks checked.
 *
 * So the model is not trusted for existence either. `raw` is supposed to be
 * the citation as it appears in the draft; if neither it nor the surrounding
 * `location` snippet can be found in the draft text, the entry is SET ASIDE,
 * never returned. Nothing is repaired or fuzzy-matched into place.
 *
 * The comparison folds whitespace (`normalizeQuoteText`, shared with the
 * evidence lane, which also folds the non-breaking spaces a PDF text layer
 * emits), the typographic quotes and dashes Word substitutes, and case —
 * because a section symbol spaced differently is the same citation, while a
 * different case name is a different case. As a last resort it retries with
 * ALL whitespace removed, which covers "§ 523(a)(7)" against "§523(a)(7)".
 */
function foldForSearch(input: string): string {
  return normalizeQuoteText(input)
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .toLowerCase();
}

/**
 * The draft, folded once. A 300 KB brief with 200 citations would otherwise be
 * re-folded up to four hundred times on the browser's main thread.
 */
interface FoldedDraft { spaced: string; tight: string }
function foldDraft(draft: string): FoldedDraft {
  const spaced = foldForSearch(draft ?? '');
  return { spaced, tight: spaced.replace(/\s+/g, '') };
}

function foundIn(hay: FoldedDraft, needle: string): boolean {
  const wanted = foldForSearch(needle);
  if (wanted.length < MIN_RAW_CHARS) return false;
  if (hay.spaced.includes(wanted)) return true;
  return hay.tight.includes(wanted.replace(/\s+/g, ''));
}

/** The same question, for one citation against one draft. */
export function appearsInDraft(draft: string, needle: string): boolean {
  return foundIn(foldDraft(draft), needle);
}

export interface ExtractContract {
  cites: Cite[];
  /** Entries returned that are not in the draft. Dropped, and counted. */
  setAside: number;
  /** The same citation at the same place, returned twice. Folded, and counted. */
  duplicates: number;
}

/**
 * Validate the extractor's answer against the draft it was given.
 *
 * `{"citations":[]}` is a VALID answer — a brief with no citations is a real
 * thing, and repairing it would be paying twice to be told the same true
 * thing. What is not valid is an answer that is not a citations array at all,
 * which is what today's `Array.isArray(...) ? ... : []` silently turned into
 * "this brief has no citations" — a clean report on an unread brief.
 */
export function checkExtractContract(raw: unknown, draftText: string): ContractCheck<ExtractContract> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'the answer was not an object' };
  }
  const root = raw as Record<string, unknown>;
  if (!Array.isArray(root.citations)) {
    const named = ['cites', 'citation', 'results', 'authorities'].find((k) => Array.isArray(root[k]));
    return {
      ok: false,
      reason: named
        ? `no "citations" array — the list was called "${named}"`
        : 'no "citations" array',
    };
  }
  if (root.citations.length > MAX_EXTRACTED_CITES) {
    return {
      ok: false,
      reason: `${root.citations.length} citations — no brief holds that many, so the answer is not a citation list`,
    };
  }

  // Folded once for the whole answer, not once per citation.
  const hay = foldDraft(draftText);
  const cites: Cite[] = [];
  const seen = new Set<string>();
  let setAside = 0;
  let duplicates = 0;
  let nonObjects = 0;

  for (let i = 0; i < root.citations.length; i++) {
    const entry = root.citations[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { nonObjects += 1; continue; }
    const c = entry as Record<string, unknown>;

    const rawText = trimmedText(c.raw);
    if (!rawText) return { ok: false, reason: `citation ${i + 1} has no "raw" text` };

    // The enumeration. Today an unknown value is silently rewritten to
    // "other", which puts a statute in the Table of Authorities' Other
    // section and hides it from the statute lookup.
    const typeText = trimmedText(c.authority_type)?.toLowerCase();
    if (!typeText || !AUTHORITY_TYPES.includes(typeText as AuthorityType)) {
      return {
        ok: false,
        reason: `the authority_type for "${rawText}" was ${typeText ? `"${typeText}"` : 'missing'} — `
          + `it must be one of ${AUTHORITY_TYPES.join(', ')}`,
      };
    }

    if (c.year != null && !Number.isInteger(c.year)) {
      return { ok: false, reason: `the year for "${rawText}" was not a whole number` };
    }
    for (const key of ['citation_bluebook', 'case_name', 'court', 'pin_cite', 'proposition', 'signal', 'location'] as const) {
      if (c[key] != null && typeof c[key] !== 'string') {
        return { ok: false, reason: `the ${key} for "${rawText}" was not text` };
      }
    }
    if (c.doctrinal_subject != null
      && (!Array.isArray(c.doctrinal_subject) || c.doctrinal_subject.some((s) => typeof s !== 'string'))) {
      return { ok: false, reason: `the doctrinal_subject for "${rawText}" was not a list of words` };
    }

    const location = trimmedText(c.location);
    if (!foundIn(hay, rawText) && !(location && foundIn(hay, location))) {
      setAside += 1;
      continue;
    }

    // "Emit one entry per location" — the same citation at the same place
    // twice is the model repeating itself, and would double-count the report.
    const key = `${foldForSearch(rawText)}\u0000${location ? foldForSearch(location) : ''}`;
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);

    cites.push(normaliseCite({
      raw: rawText,
      citation_bluebook: trimmedText(c.citation_bluebook),
      case_name: trimmedText(c.case_name),
      court: trimmedText(c.court),
      year: typeof c.year === 'number' ? c.year : null,
      pin_cite: trimmedText(c.pin_cite),
      proposition: trimmedText(c.proposition),
      signal: trimmedText(c.signal),
      authority_type: typeText,
      doctrinal_subject: Array.isArray(c.doctrinal_subject) ? (c.doctrinal_subject as string[]) : [],
      location,
    }));
  }

  if (!cites.length && root.citations.length) {
    if (setAside) {
      return {
        ok: false,
        reason: `none of the ${root.citations.length} citations returned appears in the draft`,
      };
    }
    if (nonObjects) return { ok: false, reason: 'no entry in "citations" was an object' };
  }

  return { ok: true, value: { cites, setAside, duplicates } };
}

export function buildExtractRepairContent(original: string, reason: string, sent: unknown): string {
  return buildRepairContent({
    original,
    reason,
    sent,
    shape:
      `{"citations":[{"raw":"<the citation exactly as it appears in the draft above>",`
      + `"citation_bluebook":"<the normalised form>","case_name":"<or null>","court":"<or null>",`
      + `"year":<a whole number or null>,"pin_cite":"<or null>","proposition":"<one or two sentences>",`
      + `"signal":"<or null>","authority_type":"statute|regulation|case|treatise|rule|other",`
      + `"doctrinal_subject":["<subject>"],"location":"<~80 characters of the surrounding text>"}]}`,
    rules:
      `If the draft cites nothing, answer {"citations":[]}. `
      + `Every "raw" must be copied out of the draft above — do not write a citation that is not there — `
      + `and "authority_type" must be exactly one of the six words listed.`,
  });
}

/**
 * The sentence the run shows when the extractor could not be read, twice.
 * It says what did not happen: no citation was checked, so nothing about this
 * brief has been established either way.
 */
export const EXTRACT_CONTRACT_FAILURE =
  'The model’s answer could not be read as a list of citations. No citation was checked, '
  + 'and nothing was saved. Try again, or run the brief through a different model.';

export interface ExtractionOutcome extends ExtractContract {
  /** True when the first answer was off-contract and the repair turn fixed it. */
  repaired: boolean;
  /** How many sections the draft was read in (1 for anything short). */
  sections: number;
}

/**
 * THE ANSWER HAS A CEILING, SO A LONG BRIEF IS READ IN SECTIONS.
 *
 * Every citation comes back in one tool call, with a proposition and a
 * location snippet each, and one call's answer stops at `maxTokens`. A
 * 48,000-character brief (09-27, the first real Brief Desk run) needed more
 * than 16,000 tokens to list its citations: the answer was cut off mid-list,
 * arrived as a broken tool call, failed the contract twice, and the lawyer
 * was told the model's answer "could not be read". Nothing was wrong with the
 * brief or the model.
 *
 * So the draft is split at paragraph breaks into sections of at most
 * SECTION_CHARS, each read by its own call (with its own contract check and
 * repair turn, against its own text), a few at a time, and the lists joined in
 * document order. A section is sized so its answer sits far below the
 * ceiling. A short draft is one section: exactly the call it always was.
 *
 * If ANY section cannot be read, the whole extraction fails and says which:
 * a citation list with a hole in it would print as a complete report.
 */
export const SECTION_CHARS = 10_000;
const SECTION_CONCURRENCY = 3;

/**
 * The draft in sections of at most `max` characters, split at blank lines; a
 * paragraph longer than `max` is split at a sentence end (else at a space).
 * Joined back with the separators they were cut at, the sections are the draft.
 */
export function splitForExtraction(text: string, max = SECTION_CHARS): string[] {
  if (text.length <= max) return [text];
  const sections: string[] = [];
  let cur = '';
  const push = () => { if (cur) { sections.push(cur); cur = ''; } };
  // Paragraphs with their trailing separator attached, so nothing is dropped.
  const paras = text.match(/[\s\S]*?(?:\n{2,}|$)/g)?.filter((p) => p.length) ?? [text];
  for (const para of paras) {
    if (cur.length + para.length <= max) { cur += para; continue; }
    push();
    let rest = para;
    while (rest.length > max) {
      const window = rest.slice(0, max);
      const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'));
      const space = window.lastIndexOf(' ');
      const cut = sentence > max * 0.5 ? sentence + 2 : space > max * 0.5 ? space + 1 : max;
      sections.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    cur = rest;
  }
  push();
  return sections;
}

async function extractSection(
  sectionText: string,
  opts: { modelId: string; signal?: AbortSignal; matterId?: string },
): Promise<{ ok: true; value: ExtractContract; repaired: boolean } | { ok: false; reason: string }> {
  // The repair turn is the same call with the same 'citecheck.extract' label,
  // so it is metered and recorded like the first. A 402, a 429 or a sealed
  // refusal is thrown straight through — it is a fact about the server, not
  // about this brief, and must never be flattened into "no citations found".
  const call = async ({ userContent }: ContractAttempt) => generateStructured<unknown>({
    modelId: opts.modelId,
    signal: opts.signal,
    // The brief is the prompt here, so this is the single largest piece of
    // matter content the cite-check run sends anywhere. It binds.
    matterId: opts.matterId,
    feature: 'citecheck.extract',
    system: EXTRACT_SYSTEM,
    userContent,
    toolName: 'record_citations',
    toolDescription: 'Record every legal citation extracted from the draft.',
    inputSchema: CITE_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 16000,
  });
  const outcome = await runWithContract<ExtractContract>({
    userContent: sectionText,
    call,
    validate: (raw) => checkExtractContract(raw, sectionText),
    repair: buildExtractRepairContent,
  });
  return outcome.ok ? { ok: true, value: outcome.value, repaired: outcome.repaired } : { ok: false, reason: outcome.reason };
}

export async function extractCitations(
  draftText: string,
  opts: {
    modelId: string;
    signal?: AbortSignal;
    matterId?: string;
    /** Called as each section finishes: (done, total). */
    onSection?: (done: number, total: number) => void;
  } = { modelId: 'claude-opus-4-8' },
): Promise<ExtractionOutcome> {
  const sections = splitForExtraction(draftText);
  const results: Awaited<ReturnType<typeof extractSection>>[] = new Array(sections.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < sections.length) {
      const i = next++;
      results[i] = await extractSection(sections[i], opts);
      opts.onSection?.(++done, sections.length);
      // One unreadable section fails the whole run; stop spending on the rest.
      if (!results[i].ok) next = sections.length;
    }
  };
  await Promise.all(Array.from({ length: Math.min(SECTION_CONCURRENCY, sections.length) }, worker));

  const failed = results.findIndex((r) => r && !r.ok);
  if (failed >= 0) {
    const r = results[failed] as { ok: false; reason: string };
    const where = sections.length > 1 ? ` in section ${failed + 1} of ${sections.length}` : '';
    throw new Error(`${EXTRACT_CONTRACT_FAILURE} (Twice${where}: ${r.reason}.)`);
  }
  const ok = results as { ok: true; value: ExtractContract; repaired: boolean }[];
  return {
    cites: ok.flatMap((r) => r.value.cites),
    setAside: ok.reduce((n, r) => n + r.value.setAside, 0),
    duplicates: ok.reduce((n, r) => n + r.value.duplicates, 0),
    repaired: ok.some((r) => r.repaired),
    sections: sections.length,
  };
}

function normaliseCite(c: RawCite): Cite {
  // The type has already been checked against the enumeration by the contract
  // above; this is the shape conversion, not a second chance to guess.
  const t = AUTHORITY_TYPES.includes(c.authority_type as AuthorityType)
    ? (c.authority_type as AuthorityType)
    : 'other';
  return {
    raw: c.raw ?? null,
    citation_bluebook: c.citation_bluebook ?? c.raw ?? null,
    case_name: c.case_name ?? null,
    court: c.court ?? null,
    year: typeof c.year === 'number' ? c.year : null,
    pin_cite: c.pin_cite ?? null,
    proposition: c.proposition ?? null,
    signal: c.signal ?? null,
    authority_type: t,
    doctrinal_subject: Array.isArray(c.doctrinal_subject) ? c.doctrinal_subject : [],
    location: c.location ?? null,
  };
}
