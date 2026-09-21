// Choosing the documents to classify — the decisions, with nothing attached.
//
// Eden's report: "Classify new document in the Bucketizer does not open up
// documents." The button listed the matter's UNCLASSIFIED documents and, when
// there were none, returned without a word; there was no way to pick a
// document and no way to read one again. Everything that decides what the
// button says, which documents may be chosen, and what a re-run is allowed to
// write lives here.
//
// Pure: no supabase, no React, no clock. Every input arrives as an argument,
// which is what lets `scripts/_verify-bucketizer-chooser.mjs` assert these
// rules offline instead of describing them.
//
// ONE PREDICATE, NOT TWO. The count on the button and the state beside each
// row in the chooser are the same computation (`buildChooserRows`). Two
// predicates would drift, and "Classify new documents (3)" sitting next to a
// chooser showing four unclassified documents is the kind of small lie this
// surface cannot afford.

import { describeTextStatus } from '../../../lib/ingest-formats.mjs';
import { isFiledOutline } from './outline-model';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A document row, as the inventory reads it. */
export interface ChooserDocument {
  id: string;
  title: string | null;
  /** What it was uploaded as. Searched alongside the title. */
  source_filename?: string | null;
  matterspace_id: string;
  processing_status: string;
  processing_error?: string | null;
  doc_type?: string | null;
  page_count?: number | null;
  /** `documents.metadata->>text_status` — why a ready document holds no text. */
  text_status?: string | null;
  metadata?: {
    bucketizer?: { no_buckets_at?: string; tree_source_at?: string };
    /** Pages a PDF still owes OCR. `held` = a sealed matter would not send them out. */
    ocr_pending?: { pages?: number[] | null; page_count?: number | null; held?: boolean; reason?: string } | null;
  } | null;
}

/** The classification rows a document already carries. */
export interface ChooserClassification {
  document_id: string;
  status: 'proposed' | 'confirmed' | 'rejected';
  proposed_at?: string | null;
  decided_at?: string | null;
}

// ---------------------------------------------------------------------------
// What a row can be
// ---------------------------------------------------------------------------

export type ChooserState =
  /** Never examined, and ready to read. The "not yet classified" set. */
  | 'unclassified'
  /** Has classification rows. Choosing it reads the document again. */
  | 'classified'
  /** Examined once and nothing fitted (the `no_buckets_at` sentinel). */
  | 'examined_empty'
  /**
   * HELD by the seal with part of it indexed: a mixed PDF in a SecureSpace,
   * whose typed pages were read locally and whose scanned pages would have had
   * to leave. It CAN be classified — classification reads passage text, not
   * vectors — but only from the pages that were read, so it is offered with
   * that said out loud and never swept up by "classify everything".
   */
  | 'held_partial'
  /** Still being ingested, failed, or held with nothing read. */
  | 'not_ready'
  /** Ready, but the file holds no text to read. */
  | 'no_text'
  /** A trial outline this matter filed. Never classified into its own tree. */
  | 'outline';

export interface ChooserRow {
  id: string;
  title: string;
  /** The document's OWN matter — it may be a sub-matter of the tree's. */
  matterId: string;
  /** That matter's name, for grouping the list and the confirmation. */
  matterName?: string;
  /** The uploaded filename, so a search for "114-A.pdf" finds it. */
  filename?: string | null;
  state: ChooserState;
  /**
   * A pleading this matter's tree was generated FROM. Still choosable — an
   * attorney may well want the complaint filed under the claims it pleads —
   * but never swept into "classify everything not yet classified", which is
   * how a run meant for one new upload classified the complaint instead.
   */
  treeSource: boolean;
  /** The short line beside the title: what has happened to this document. */
  status: string;
  /**
   * Why this row cannot be chosen. A blocked document is SHOWN with its
   * reason rather than hidden: a person who uploaded a scan an hour ago needs
   * to see it sitting there waiting for OCR, not wonder where it went.
   */
  blockedReason?: string;
  /** A caution on a row that CAN be chosen (part of it is unreadable today). */
  caution?: string;
  /** Classification rows this document already carries. */
  rows: number;
  /** How many of those you decided — confirmed or rejected. */
  decided: number;
  doc_type: string | null;
  page_count: number | null;
}

/** The document shape the estimate and the run need. Structural on purpose. */
export interface RunnableDoc {
  id: string;
  title: string;
  doc_type: string | null;
  page_count: number | null;
}

/**
 * `text_status` values that mean there are no passages to read.
 *
 * Taken from `lib/ingest-formats.mjs` TEXT_STATUS, not invented here.
 * `ocr_pending` is deliberately ABSENT: those documents have their text pages
 * indexed and only the scanned pages outstanding, so they can be classified —
 * with a caution, because part of the record is not in what the model reads.
 * `generated` is a deliverable this product filed (a chart's SVG); its sources
 * are the searchable copies.
 */
const NO_TEXT_STATUSES = new Set([
  'image_only', 'no_text', 'portfolio', 'media_no_transcript',
  'binary_stored', 'unsupported', 'archive', 'generated',
]);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `18 Sep 2026`. UTC, so the same row reads the same on every machine. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Why a document that is not `ready` cannot be read, in the Vault's terms. */
function notReadyReason(doc: ChooserDocument): string {
  const status = doc.processing_status;
  const detail = doc.processing_error ? ` ${doc.processing_error}` : '';
  if (status === 'error') return `Ingestion failed — retry it in the Vault, then classify it.${detail}`;
  if (status === 'held') {
    return 'Held: this matter is sealed and this step has no sealed route, so nothing in this '
      + `file could be read here.${detail}`;
  }
  if (status === 'embedding') return 'Still processing — about to be ready.';
  return `Still processing (${status}) — about to be ready.`;
}

/**
 * Pages of a held document that WERE read locally.
 *
 * A mixed PDF in a SecureSpace finishes `held` with its typed pages indexed
 * and its scanned pages recorded as not read (`lib/ingest-core.mjs`, the
 * `ocrHeldBySeal` branch). Those typed pages are real passages, and the
 * classifier reads passage text — so the document is classifiable, on part of
 * itself. Zero means nothing was read and there is nothing to classify.
 */
function heldTypedPages(doc: ChooserDocument): number {
  const ocr = doc.metadata?.ocr_pending;
  if (!ocr || !ocr.held) return 0;
  const total = Number(ocr.page_count);
  const unread = Array.isArray(ocr.pages) ? ocr.pages.length : 0;
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, total - unread);
}

// ---------------------------------------------------------------------------
// The one predicate
// ---------------------------------------------------------------------------

/**
 * Every document in this matter tree, with what has happened to it.
 *
 * `matterIds` is the matter and its sub-matters, from `matterspace_descendants`.
 * Rows outside it are DROPPED here as well as in the query — strict matter
 * isolation is a contract, and a contract enforced in one place only is a
 * contract held by whoever writes the next caller.
 */
export function buildChooserRows(input: {
  matterIds: string[];
  documents: ChooserDocument[];
  classifications: ChooserClassification[];
  /** matterspace id → name, for grouping the list and the confirmation. */
  matterNames?: Map<string, string>;
}): ChooserRow[] {
  const inTree = new Set(input.matterIds);

  const byDoc = new Map<string, { rows: number; decided: number; last: string | null }>();
  for (const c of input.classifications) {
    const agg = byDoc.get(c.document_id) ?? { rows: 0, decided: 0, last: null };
    agg.rows += 1;
    if (c.status === 'confirmed' || c.status === 'rejected') agg.decided += 1;
    const at = c.decided_at || c.proposed_at || null;
    if (at && (!agg.last || at > agg.last)) agg.last = at;
    byDoc.set(c.document_id, agg);
  }

  const rows: ChooserRow[] = [];
  for (const doc of input.documents) {
    if (!inTree.has(doc.matterspace_id)) continue;

    const title = doc.title || doc.source_filename || 'Untitled document';
    const agg = byDoc.get(doc.id) ?? { rows: 0, decided: 0, last: null };
    const treeSource = Boolean(doc.metadata?.bucketizer?.tree_source_at);
    const base = {
      id: doc.id,
      title,
      matterId: doc.matterspace_id,
      matterName: input.matterNames?.get(doc.matterspace_id),
      filename: doc.source_filename ?? null,
      treeSource,
      rows: agg.rows,
      decided: agg.decided,
      doc_type: doc.doc_type ?? null,
      page_count: doc.page_count ?? null,
    };
    const sourceNote = treeSource ? ' · used to build the tree' : '';

    // An outline this matter filed is not evidence about the matter. See
    // `isFiledOutline`: classifying it would file the outline under the very
    // elements it quotes, and the next evidence pass would quote the outline
    // quoting the deposition.
    if (isFiledOutline(title)) {
      rows.push({
        ...base,
        state: 'outline',
        status: 'a trial outline filed from this matter',
        blockedReason: 'This is one of this matter\'s own trial outlines. Classifying it would '
          + 'file the outline under the elements it quotes.',
      });
      continue;
    }

    if (doc.processing_status !== 'ready') {
      // A sealed matter's mixed PDF is `held` WITH its typed pages indexed.
      // Excluding it on status alone would put a filed document out of reach
      // of the tree for a reason that is about OCR, not about the text the
      // classifier actually reads.
      const typed = doc.processing_status === 'held' ? heldTypedPages(doc) : 0;
      if (typed > 0) {
        const unread = doc.metadata?.ocr_pending?.pages?.length ?? 0;
        rows.push({
          ...base,
          state: 'held_partial',
          status: agg.rows > 0
            ? `classified ${formatDay(agg.last)} · held, read in part${sourceNote}`
            : `held — ${typed} page${typed === 1 ? '' : 's'} read, ${unread} not${sourceNote}`,
          caution: `This matter is sealed and ${unread} scanned page${unread === 1 ? ' was' : 's were'} `
            + `not sent out for OCR. It will be classified from the ${typed} page`
            + `${typed === 1 ? '' : 's'} that were read — not from the whole document.`,
        });
        continue;
      }
      rows.push({
        ...base,
        state: 'not_ready',
        status: doc.processing_status === 'error' ? 'ingestion failed'
          : doc.processing_status === 'held' ? 'held'
            : `still processing (${doc.processing_status})`,
        blockedReason: notReadyReason(doc),
      });
      continue;
    }

    if (doc.text_status && NO_TEXT_STATUSES.has(doc.text_status)) {
      const { label, detail } = describeTextStatus(doc.text_status);
      rows.push({
        ...base,
        state: 'no_text',
        status: label.toLowerCase(),
        blockedReason: `${detail} There is nothing for the classifier to read.`,
      });
      continue;
    }

    const caution = doc.text_status === 'ocr_pending'
      ? 'Some scanned pages are still waiting for OCR — it will be read from the text it has today.'
      : undefined;

    if (agg.rows > 0) {
      rows.push({
        ...base,
        state: 'classified',
        status: (agg.last ? `classified ${formatDay(agg.last)}` : 'already classified') + sourceNote,
        caution,
      });
      continue;
    }

    const sentinel = doc.metadata?.bucketizer?.no_buckets_at;
    if (sentinel) {
      rows.push({
        ...base,
        state: 'examined_empty',
        status: `read ${formatDay(sentinel)} — no bucket fitted${sourceNote}`,
        caution,
      });
      continue;
    }

    rows.push({
      ...base,
      state: 'unclassified',
      status: treeSource ? 'used to build the tree — not yet classified' : 'not yet classified',
      caution,
    });
  }

  rows.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return rows;
}

/** A row a run may be pointed at. */
export function isChoosable(row: ChooserRow): boolean {
  return !row.blockedReason;
}

/**
 * "Everything not yet classified": never examined, readable today, and not a
 * pleading the tree was built from.
 *
 * Two exclusions that each answer something that happened:
 *
 *  - a no-text scan used to be counted here forever. The button said "(5)",
 *    every run read nothing, wrote nothing and said nothing, and the count
 *    never moved;
 *  - the COMPLAINT used to be counted here. Eden uploaded one document, was
 *    asked whether to run "1 document", said yes — and the run classified the
 *    complaint the tree had been generated from, because his upload was still
 *    processing and the complaint was the only ready document with no rows.
 *    A pleading the tree was drawn from is not a new document; it is offered
 *    in the chooser, labelled, and chosen deliberately or not at all.
 */
export function freshCandidates(rows: ChooserRow[]): RunnableDoc[] {
  return rows.filter((r) => r.state === 'unclassified' && !r.treeSource).map(toRunnable);
}

/** The ids of that same set — what "Select these" puts in the selection. */
export function freshCandidateRows(rows: ChooserRow[]): ChooserRow[] {
  return rows.filter((r) => r.state === 'unclassified' && !r.treeSource);
}

/**
 * Every choosable document under a set of matters (a folder and everything
 * beneath it). Blocked rows are left out, and the caller is shown what it
 * actually selected — a count with names, never a folder and a promise.
 */
export function choosableIn(rows: ChooserRow[], matterIds: Iterable<string>): ChooserRow[] {
  const wanted = new Set(matterIds);
  return rows.filter((r) => wanted.has(r.matterId) && isChoosable(r));
}

/**
 * The chosen documents, by name, grouped by the matter they live in — what
 * the confirmation shows instead of a bare count. A dialog that says "Classify
 * 1 document?" and runs something else is how this went wrong.
 */
export function groupChosen(
  rows: ChooserRow[],
  selected: Iterable<string>,
): { matterName: string; titles: string[] }[] {
  const wanted = new Set(selected);
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    if (!wanted.has(row.id) || !isChoosable(row)) continue;
    const key = row.matterName ?? 'This matter';
    const list = groups.get(key) ?? [];
    list.push(row.title);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([matterName, titles]) => ({ matterName, titles }))
    .sort((a, b) => a.matterName.localeCompare(b.matterName));
}

function toRunnable(row: ChooserRow): RunnableDoc {
  return { id: row.id, title: row.title, doc_type: row.doc_type, page_count: row.page_count };
}

/**
 * The chosen documents, as the run takes them.
 *
 * THE ISOLATION CHECK LIVES HERE. `rows` only ever holds this matter tree, so
 * an id from anywhere else — a stale selection, a caller that grew a second
 * source — is dropped rather than classified into a matter it does not belong
 * to. Blocked rows are dropped for the same reason: the chooser disables them,
 * and this makes that a fact rather than a UI state.
 */
export function docRowsForRun(rows: ChooserRow[], selected: Iterable<string>): RunnableDoc[] {
  const wanted = new Set(selected);
  return rows.filter((r) => wanted.has(r.id) && isChoosable(r)).map(toRunnable);
}

// ---------------------------------------------------------------------------
// What the button says
// ---------------------------------------------------------------------------

export interface ClassifyAction {
  label: string;
  /** The quiet count beside it. Never part of the promise the label makes. */
  badge: string | null;
  /** Always true now: step 2 is choosing, and choosing opens a list. */
  opensChooser: true;
}

/**
 * What step 2's button says.
 *
 * It used to say "Classify new documents (N)" and start a run on whatever N
 * turned out to be — which is how a run meant for one upload classified the
 * complaint. The button now opens the list, every time: the person sees the
 * names before anything is read, and "everything not yet classified" is one
 * option inside that list rather than the thing the button does.
 */
export function classifyAction(unclassified: number | null): ClassifyAction {
  return {
    label: 'Choose documents…',
    badge: unclassified === null ? null
      : unclassified > 0 ? `${unclassified} not yet classified`
        : 'nothing new',
    opensChooser: true,
  };
}

/**
 * What the surface says when the click finds nothing new. Quiet, in the
 * surface's own voice, and never a no-op: it names the two things a person
 * can do next, and the surface renders both as controls.
 */
export const NOTHING_NEW_MESSAGE =
  'Nothing new to classify. Everything readable here is already in the tree, was used to '
  + 'build it, or is waiting in the chooser for you to choose it. Upload documents to this '
  + 'matter\'s Vault, or choose documents to classify again.';

// ---------------------------------------------------------------------------
// Re-classification
// ---------------------------------------------------------------------------

export interface ChosenSummary {
  documents: number;
  /** Chosen documents that already carry classification rows. */
  alreadyClassified: number;
  /** Of those, how many carry a decision the attorney made. */
  withDecisions: number;
}

export function summarizeChosen(rows: ChooserRow[], selected: Iterable<string>): ChosenSummary {
  const wanted = new Set(selected);
  const chosen = rows.filter((r) => wanted.has(r.id) && isChoosable(r));
  return {
    documents: chosen.length,
    alreadyClassified: chosen.filter((r) => r.rows > 0).length,
    withDecisions: chosen.filter((r) => r.decided > 0).length,
  };
}

/**
 * The sentences the estimate dialog owes a re-run, before it starts. Empty
 * when nothing chosen has been classified before.
 */
export function reclassifyNotices(summary: ChosenSummary): string[] {
  const out: string[] = [];
  if (summary.alreadyClassified > 0) {
    out.push(
      `${summary.alreadyClassified} of these ${summary.alreadyClassified === 1 ? 'was' : 'were'} `
      + 'classified before. Each is read again in full, and charged again.',
    );
  }
  if (summary.withDecisions > 0) {
    out.push(
      `${summary.withDecisions} document${summary.withDecisions === 1 ? '' : 's'} already `
      + `${summary.withDecisions === 1 ? 'has' : 'have'} decisions you made; those stay as they are. `
      + 'A re-run refreshes only proposals you have not decided, and adds new ones.',
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// What a re-run is allowed to write
// ---------------------------------------------------------------------------
//
// The rule — never touch a CONFIRMED or REJECTED row, refresh an undecided
// one, insert a missing one, delete nothing — now lives in
// `lib/bucketizer-writes.mjs`, and this module re-exports it.
//
// It moved because the run it governs now also happens on the Fly worker
// (`lib/bucketizer-run.mjs`), which cannot import a browser module, and this
// discipline is the last thing that should be re-derived on the server: a
// server-side re-run that overwrote a confirmed row would destroy a decision
// an attorney made and took responsibility for, and it would do it silently,
// overnight, with the laptop shut. One copy, both sides.
export {
  planClassificationWrites,
  sentinelAfterRun,
} from '../../../lib/bucketizer-writes.mjs';

export type {
  ExistingClassification,
  ProposedClassification,
  WritePlan,
} from '../../../lib/bucketizer-writes.mjs';
