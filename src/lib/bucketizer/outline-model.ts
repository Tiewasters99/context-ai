// The trial outline, assembled.
//
// DETERMINISTIC, END TO END. No model call happens in this file or anywhere
// downstream of it. The outline spec settled that in v1 ("No model call in
// v1 — feedback: agent-economics-deterministic-first"), and it is also the
// only way the byte-identical test in the harness can mean anything: the same
// tree and the same confirmed evidence produce the same document, today and in
// a month, on any machine.
//
// The judgment in this lane was spent earlier and once — a model chose which
// passages support which bucket and where the quotable span starts, an
// attorney confirmed or rejected each one, and this file does arithmetic over
// the result. Every factual sentence in the finished outline is either a
// quotation the database holds verbatim, a citation computed from the
// passage's own columns, or the attorney's own words from a node description.
//
// GAPS COME FIRST, and that is the whole argument for the form. A trial
// outline that opens with what is proved is a comfort; one that opens with the
// elements carrying no confirmed evidence is a work list three weeks before a
// summary-judgment deadline.
//
// Pure: no supabase, no `@/` import, no clock. `generatedAt` is passed in, so
// the harness can assert two runs are identical.

import {
  PDF_INDEX_PAGE_NOTE,
  buildCite,
  readerUrl,
  shortTitle,
  type Cite,
  type CiteDocument,
  type CitePassage,
} from './cite';

export type OutlineNodeKind = 'claim' | 'element' | 'theme' | 'subissue';

export interface OutlineTreeNode {
  id: string;
  parent_id: string | null;
  kind: OutlineNodeKind | string;
  label: string;
  description: string | null;
  position: number;
}

export interface OutlineClassification {
  id: string;
  node_id: string;
  document_id: string;
  status: 'proposed' | 'confirmed' | 'rejected';
  confidence: number | null;
  rationale: string | null;
  /** Set when the evidence pass has run over this pair. */
  evidence_run_at?: string | null;
  evidence_failed?: string | null;
}

export interface OutlineEvidenceRow {
  id: string;
  node_id: string;
  document_id: string;
  passage_id: string;
  quote: string;
  rationale: string | null;
  status: 'proposed' | 'confirmed' | 'rejected';
  position: number;
}

export interface OutlineDocument extends CiteDocument {
  id: string;
  title: string;
  doc_type?: string | null;
  witness_name?: string | null;
}

export type OutlinePassage = CitePassage & { id: string };

export interface OutlineMatter {
  id: string;
  title: string;
  shortCode?: string | null;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export interface OutlineEvidence {
  id: string;
  documentId: string;
  documentTitle: string;
  passageId: string;
  /** The passage's own characters, validated when it was recorded. */
  quote: string;
  rationale: string | null;
  status: 'proposed' | 'confirmed';
  cite: Cite;
  readerUrl: string;
}

export interface OutlineFiledDocument {
  id: string;
  title: string;
  status: 'confirmed' | 'proposed';
  confidence: number | null;
  rationale: string | null;
  readerUrl: string;
  /** Why this document carries no quoted evidence, when it carries none. */
  evidenceState: 'quoted' | 'none_found' | 'not_run' | 'failed';
  evidenceNote: string | null;
}

export interface OutlineSection {
  node: OutlineTreeNode;
  /** `I`, `I.A`, `I.A.1` — computed here so both renderers agree. */
  number: string;
  /** `I.A` → the heading line reads `I.A. Objective unreasonableness`. */
  heading: string;
  /** The node's description, verbatim: it is what the attorney wrote. */
  mustProve: string;
  confirmed: OutlineEvidence[];
  proposed: OutlineEvidence[];
  documents: OutlineFiledDocument[];
  children: OutlineSection[];
}

export type GapKind = 'empty' | 'unconfirmed' | 'thin';

export interface OutlineGap {
  number: string;
  label: string;
  kind: OutlineNodeKind | string;
  gap: GapKind;
  /** One sentence naming exactly what is missing. */
  reason: string;
}

export interface OutlineWitness {
  name: string;
  /** How many confirmed quotations this witness carries, and where. */
  cites: { number: string; cite: string; documentId: string }[];
}

export interface OutlineDocumentIndexEntry {
  id: string;
  title: string;
  readerUrl: string;
  /** Outline numbers this document is cited under. */
  numbers: string[];
  quotes: number;
}

export interface OutlineCounts {
  claims: number;
  elements: number;
  subissues: number;
  themes: number;
  documentsFiled: number;
  evidenceConfirmed: number;
  evidenceProposed: number;
  pairsWithEvidence: number;
  pairsNotRun: number;
  pairsFailed: number;
  citeTiers: {
    page_line: number;
    page_line_inferred: number;
    page_only: number;
    document_page: number;
    no_page: number;
  };
}

export interface OutlineModel {
  matter: OutlineMatter;
  generatedAt: string;
  /** `2026-09-20 1432` — the version, and the filename's tail. */
  version: string;
  /** Null until counsel marks the outline reviewed; the legend keys off it. */
  reviewedAt: string | null;
  counts: OutlineCounts;
  /** The standing citation notes this particular outline has to carry. */
  citationNotes: string[];
  gaps: OutlineGap[];
  claims: OutlineSection[];
  themes: OutlineSection[];
  witnesses: OutlineWitness[];
  documents: OutlineDocumentIndexEntry[];
}

export const DRAFT_LEGEND = 'DRAFT — NOT REVIEWED BY COUNSEL';

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

const ROMAN = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
] as const;

export function roman(n: number): string {
  let rest = Math.max(1, Math.floor(n));
  let out = '';
  for (const [value, sym] of ROMAN) {
    while (rest >= value) { out += sym; rest -= value; }
  }
  return out;
}

/** 1 → A, 26 → Z, 27 → AA. */
export function alpha(n: number, lower = false): string {
  let rest = Math.max(1, Math.floor(n));
  let out = '';
  while (rest > 0) {
    const r = (rest - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return lower ? out.toLowerCase() : out;
}

/** Depth 0 = I, 1 = A, 2 = 1, 3 = a, and lower-case roman past that. */
function levelNumber(depth: number, index: number): string {
  switch (depth) {
    case 0: return roman(index);
    case 1: return alpha(index);
    case 2: return String(index);
    case 3: return alpha(index, true);
    default: return roman(index).toLowerCase();
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface BuildOutlineInput {
  matter: OutlineMatter;
  nodes: OutlineTreeNode[];
  classifications: OutlineClassification[];
  evidence: OutlineEvidenceRow[];
  documents: OutlineDocument[];
  passages: OutlinePassage[];
  /** ISO string. Injected, never read from a clock, so runs are comparable. */
  generatedAt: string;
  reviewedAt?: string | null;
  /** An element with fewer confirmed quotations than this is "thin". */
  thinBelow?: number;
}

export function buildOutline(input: BuildOutlineInput): OutlineModel {
  const thinBelow = input.thinBelow ?? 3;
  const docById = new Map(input.documents.map((d) => [d.id, d]));
  const passageById = new Map(input.passages.map((p) => [p.id, p]));
  const nodeById = new Map(input.nodes.map((n) => [n.id, n]));

  const byParent = new Map<string, OutlineTreeNode[]>();
  for (const n of input.nodes) {
    const key = n.parent_id && nodeById.has(n.parent_id) ? n.parent_id : 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(n);
  }
  // Tree order, with the id as the last tiebreaker — two nodes at the same
  // position with the same label would otherwise reorder between runs, and the
  // byte-identical guarantee would be a coincidence.
  for (const list of byParent.values()) {
    list.sort((a, b) =>
      (a.position - b.position)
      || a.label.localeCompare(b.label)
      || a.id.localeCompare(b.id));
  }

  // --- evidence, keyed by node ---------------------------------------------
  const evidenceByNode = new Map<string, OutlineEvidenceRow[]>();
  for (const e of input.evidence) {
    if (e.status === 'rejected') continue;
    if (!evidenceByNode.has(e.node_id)) evidenceByNode.set(e.node_id, []);
    evidenceByNode.get(e.node_id)!.push(e);
  }
  for (const list of evidenceByNode.values()) {
    // The attorney's order first; `position` is what reordering writes.
    list.sort((a, b) => (a.position - b.position) || a.id.localeCompare(b.id));
  }

  // --- classifications, keyed by node --------------------------------------
  const classByNode = new Map<string, OutlineClassification[]>();
  for (const c of input.classifications) {
    if (c.status === 'rejected') continue;
    if (!classByNode.has(c.node_id)) classByNode.set(c.node_id, []);
    classByNode.get(c.node_id)!.push(c);
  }
  for (const list of classByNode.values()) {
    list.sort((a, b) => {
      // Confirmed first, then by confidence descending, then id.
      const rank = (s: string) => (s === 'confirmed' ? 0 : 1);
      return (rank(a.status) - rank(b.status))
        || ((b.confidence ?? -1) - (a.confidence ?? -1))
        || a.id.localeCompare(b.id);
    });
  }

  const counts: OutlineCounts = {
    claims: 0, elements: 0, subissues: 0, themes: 0,
    documentsFiled: 0, evidenceConfirmed: 0, evidenceProposed: 0,
    pairsWithEvidence: 0, pairsNotRun: 0, pairsFailed: 0,
    citeTiers: { page_line: 0, page_line_inferred: 0, page_only: 0, document_page: 0, no_page: 0 },
  };
  const filedDocIds = new Set<string>();
  const witnessCites = new Map<string, OutlineWitness['cites']>();
  const docIndex = new Map<string, OutlineDocumentIndexEntry>();
  const gaps: OutlineGap[] = [];
  let anyTranscriptCite = false;
  let inferredLines = 0;
  let pageOnlyCites = 0;

  const toEvidence = (row: OutlineEvidenceRow, sectionNumber: string): OutlineEvidence | null => {
    const doc = docById.get(row.document_id);
    const passage = passageById.get(row.passage_id);
    // A passage that is gone means the document was re-ingested, and the quote
    // is no longer anchored to anything the database can show. Dropping it is
    // the fidelity rule, not an error: a cite that cannot be turned to is not
    // a cite. It stays in the table so the attorney can see it disappeared.
    if (!doc || !passage) return null;
    const cite = buildCite(passage, doc);
    counts.citeTiers[cite.tier] += 1;
    if (cite.isTranscript) anyTranscriptCite = true;
    if (cite.tier === 'page_line_inferred') inferredLines += 1;
    if (cite.tier === 'page_only') pageOnlyCites += 1;

    if (row.status === 'confirmed') {
      if (cite.witness) {
        const list = witnessCites.get(cite.witness) ?? [];
        list.push({ number: sectionNumber, cite: cite.text, documentId: doc.id });
        witnessCites.set(cite.witness, list);
      }
      const entry = docIndex.get(doc.id) ?? {
        id: doc.id, title: doc.title, readerUrl: readerUrl(doc.id, null), numbers: [], quotes: 0,
      };
      if (!entry.numbers.includes(sectionNumber)) entry.numbers.push(sectionNumber);
      entry.quotes += 1;
      docIndex.set(doc.id, entry);
    }

    return {
      id: row.id,
      documentId: doc.id,
      documentTitle: doc.title,
      passageId: passage.id,
      quote: row.quote,
      rationale: row.rationale,
      status: row.status === 'confirmed' ? 'confirmed' : 'proposed',
      cite,
      readerUrl: readerUrl(doc.id, cite.page),
    };
  };

  const buildSection = (
    node: OutlineTreeNode,
    number: string,
    depth: number,
    isTheme = false,
  ): OutlineSection => {
    if (node.kind === 'claim') counts.claims += 1;
    else if (node.kind === 'element') counts.elements += 1;
    else if (node.kind === 'theme') counts.themes += 1;
    else counts.subissues += 1;

    const rows = evidenceByNode.get(node.id) ?? [];
    const confirmed: OutlineEvidence[] = [];
    const proposed: OutlineEvidence[] = [];
    for (const row of rows) {
      const item = toEvidence(row, number);
      if (!item) continue;
      if (item.status === 'confirmed') { confirmed.push(item); counts.evidenceConfirmed += 1; }
      else { proposed.push(item); counts.evidenceProposed += 1; }
    }

    const quotedDocs = new Set(rows.map((r) => r.document_id));
    const documents: OutlineFiledDocument[] = (classByNode.get(node.id) ?? []).map((c) => {
      const doc = docById.get(c.document_id);
      filedDocIds.add(c.document_id);
      let evidenceState: OutlineFiledDocument['evidenceState'];
      let evidenceNote: string | null = null;
      if (quotedDocs.has(c.document_id)) {
        evidenceState = 'quoted';
        counts.pairsWithEvidence += 1;
      } else if (c.evidence_failed) {
        evidenceState = 'failed';
        evidenceNote = c.evidence_failed;
        counts.pairsFailed += 1;
      } else if (c.evidence_run_at) {
        evidenceState = 'none_found';
        evidenceNote = 'read for quotable evidence; none of the recorded passages supports this issue';
      } else {
        evidenceState = 'not_run';
        evidenceNote = 'not yet read for quotable evidence';
        counts.pairsNotRun += 1;
      }
      return {
        id: c.document_id,
        title: doc?.title ?? '(deleted document)',
        status: c.status === 'confirmed' ? 'confirmed' : 'proposed',
        confidence: c.confidence,
        rationale: c.rationale,
        readerUrl: readerUrl(c.document_id, null),
        evidenceState,
        evidenceNote,
      };
    });

    const children = (byParent.get(node.id) ?? []).map((child, i) =>
      buildSection(child, `${number}.${levelNumber(depth + 1, i + 1)}`, depth + 1, isTheme));

    const section: OutlineSection = {
      node,
      number,
      heading: `${number}. ${node.label}`,
      mustProve: (node.description ?? '').trim() || node.label,
      confirmed,
      proposed,
      documents,
      children,
    };

    // --- gaps, measured on this node and everything under it ---------------
    //
    // Themes are deliberately not gap-tested. A gap is an element or issue the
    // case has to PROVE and currently cannot; a theme is a cross-reference a
    // trial team keeps for its own convenience, and an empty one is a filing
    // cabinet nobody has needed yet, not a hole in the case. Listing them here
    // would pad the work list with things that are not work.
    if (!isTheme && (node.kind !== 'claim' || !children.length)) {
      const confirmedHere = countDeep(section, (s) => s.confirmed.length);
      const proposedHere = countDeep(section, (s) => s.proposed.length);
      const docsHere = countDeep(section, (s) => s.documents.length);
      if (!confirmedHere && !proposedHere && !docsHere) {
        gaps.push({
          number, label: node.label, kind: node.kind, gap: 'empty',
          reason: 'no documents are filed under it and no evidence has been recorded',
        });
      } else if (!confirmedHere) {
        gaps.push({
          number, label: node.label, kind: node.kind, gap: 'unconfirmed',
          reason: proposedHere
            ? `${proposedHere} quotation${proposedHere === 1 ? '' : 's'} proposed, none confirmed by counsel`
            : `${docsHere} document${docsHere === 1 ? '' : 's'} filed here, but no quoted evidence confirmed`,
        });
      } else if (confirmedHere < thinBelow) {
        gaps.push({
          number, label: node.label, kind: node.kind, gap: 'thin',
          reason: `${confirmedHere} confirmed quotation${confirmedHere === 1 ? '' : 's'}`,
        });
      }
    }

    return section;
  };

  const roots = byParent.get('root') ?? [];
  const claimRoots = roots.filter((n) => n.kind !== 'theme');
  const themeRoots = roots.filter((n) => n.kind === 'theme');

  const claims = claimRoots.map((n, i) => buildSection(n, levelNumber(0, i + 1), 0));
  const themes = themeRoots.map((n, i) => buildSection(n, `T${i + 1}`, 1, true));

  counts.documentsFiled = filedDocIds.size;

  // Gaps first, and in the order a trial team works them: nothing at all,
  // then nothing confirmed, then thin. Within a kind, outline order.
  const gapRank: Record<GapKind, number> = { empty: 0, unconfirmed: 1, thin: 2 };
  gaps.sort((a, b) =>
    (gapRank[a.gap] - gapRank[b.gap]) || compareNumbers(a.number, b.number));

  const citationNotes: string[] = [];
  if (anyTranscriptCite) citationNotes.push(PDF_INDEX_PAGE_NOTE);
  if (pageOnlyCites > 0) {
    citationNotes.push(
      `${pageOnlyCites} citation${pageOnlyCites === 1 ? '' : 's'} below give${pageOnlyCites === 1 ? 's' : ''} `
      + 'a page and no line numbers. Those transcripts were indexed before the transcript '
      + 'parser could read their line numbering, and no line number has been supplied for '
      + 'them here. Re-indexing those depositions would produce page:line citations; until '
      + 'then the page is the whole of the coordinate.',
    );
  }
  if (inferredLines > 0) {
    citationNotes.push(
      `${inferredLines} citation${inferredLines === 1 ? '' : 's'} carry line numbers counted by `
      + 'position down the page rather than read from numbers printed on it, because the '
      + 'transcript\'s text layer carries none. They locate the testimony on the page; they '
      + 'are not the reporter\'s line numbers.',
    );
  }

  const witnesses: OutlineWitness[] = [...witnessCites.entries()]
    .map(([name, cites]) => ({ name, cites }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const documents = [...docIndex.values()]
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

  return {
    matter: input.matter,
    generatedAt: input.generatedAt,
    version: versionStamp(input.generatedAt),
    reviewedAt: input.reviewedAt ?? null,
    counts,
    citationNotes,
    gaps,
    claims,
    themes,
    witnesses,
    documents,
  };
}

function countDeep(section: OutlineSection, of: (s: OutlineSection) => number): number {
  return of(section) + section.children.reduce((n, c) => n + countDeep(c, of), 0);
}

/** `I.A.2` sorts after `I.A.10`? No: segment by segment, numerics numerically. */
function compareNumbers(a: string, b: string): number {
  const as = a.split('.');
  const bs = b.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i] ?? '';
    const y = bs[i] ?? '';
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny) && x !== '' && y !== '') {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x.localeCompare(y);
    }
  }
  return 0;
}

/** `2026-09-20 1432`, from the injected timestamp. UTC, so it never drifts. */
export function versionStamp(generatedAt: string): string {
  const d = new Date(generatedAt);
  if (Number.isNaN(d.getTime())) return String(generatedAt).slice(0, 16);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

/**
 * The run of characters every filed outline's title contains.
 *
 * It is how the classifier knows not to file an outline into the buckets the
 * outline itself summarises. That matters more than it sounds: a filed `.md`
 * is ingested like any document, so without this the next "Classify new
 * documents" would put the outline under the very elements it quotes, and the
 * next evidence pass would quote the outline quoting the deposition — a
 * second-hand citation wearing a first-hand one's clothes.
 *
 * The marker lives in the TITLE rather than in `documents.metadata` because
 * `persistVaultFile` fires ingestion without waiting and ingestion rewrites
 * that metadata; a flag written here a moment later would race it. The title
 * is what `persistVaultFile` derives from the filename, and it is stable.
 */
export const OUTLINE_TITLE_MARKER = ' — Trial Outline ';

/**
 * Is this document one of this product's own filed outlines?
 *
 * Used by the classifier to keep an outline out of its own buckets. Without
 * it, the next "Classify new documents" would file the outline under the
 * elements it quotes, and the next evidence pass would quote the outline
 * quoting the deposition — a citation at one remove that reads exactly like a
 * citation to the transcript, which is the worst thing this product could put
 * into a brief. Excluded by construction, not by the attorney noticing.
 */
export function isFiledOutline(title: string | null | undefined): boolean {
  return typeof title === 'string' && title.includes(OUTLINE_TITLE_MARKER);
}

/**
 * The filed name. Dated and timed, so a re-run is a NEW version and never
 * overwrites one already filed — the duplicate guard has nothing to trip on
 * and the record of what the outline said last week survives.
 *
 * The Word copy carries "(Word)" because `persistVaultFile` strips the
 * extension to make the title: without it both files would sit in the Vault
 * under one identical name.
 */
export function outlineFilename(model: OutlineModel, ext: '.md' | '.docx'): string {
  const base = `${shortTitle(model.matter.title, 48)}${OUTLINE_TITLE_MARKER}${model.version}`;
  const safe = base.replace(/[\\/:*?"<>|]+/g, '-');
  return ext === '.docx' ? `${safe} (Word)${ext}` : `${safe}${ext}`;
}
