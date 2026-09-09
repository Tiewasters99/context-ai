// Student Hub — a scanned reading's pages, edited.
//
// A book that came in as a scan can lose the pages it never needed (a
// front matter the reader skips, a blank verso) and take in pages from
// elsewhere — a cleaner copy of a page the scanner smeared, from another
// edition. The edits are staged in the page editor (ScanPagesEditor) and
// applied here in one pass: the new images go into the reading's own scan
// folder, the OCR endpoint reads them and leaves its sidecar beside each,
// and the reading is rebuilt page by page from the sidecars — so the
// assistant's copy, the book's glass and the highlights all follow the
// pages. The images of the cut pages leave the account unless another
// reading still turns them.

import {
  getPageTexts, rememberPageText, removeScanPages, updateSession,
  type Highlight, type StudySession,
} from '@/lib/student-hub';
import { transcribePages, uploadPageBlob } from '@/lib/student-hub-upload';

/** A page the student is putting in: its image, ready to file. */
export interface NewPage {
  id: string;
  blob: Blob;
  /** An object URL for the tile; whoever made it lets it go. */
  previewUrl: string;
  label: string;
}

/** The student's changes, staged until saved. */
export interface PageEdits {
  /** Positions (0-based) of the current pages that go. */
  deleted: ReadonlySet<number>;
  /** New pages, keyed by the position of the current page they go before —
   *  the page count for "after the last". */
  inserts: ReadonlyMap<number, readonly NewPage[]>;
}

export type PlannedPage =
  | { kind: 'kept'; index: number }
  | { kind: 'new'; page: NewPage };

/** The pages in the order they will read once the edits are applied. */
export function plannedPages(count: number, edits: PageEdits): PlannedPage[] {
  const out: PlannedPage[] = [];
  for (let i = 0; i <= count; i += 1) {
    for (const page of edits.inserts.get(i) ?? []) out.push({ kind: 'new', page });
    if (i < count && !edits.deleted.has(i)) out.push({ kind: 'kept', index: i });
  }
  return out;
}

export function hasEdits(edits: PageEdits): boolean {
  if (edits.deleted.size) return true;
  for (const list of edits.inserts.values()) if (list.length) return true;
  return false;
}

export interface PageEditResult {
  pages: string[];
  texts: string[];
  reading: string;
  highlights: Highlight[];
}

const UPLOAD_CONCURRENCY = 3;
const prefixOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

/** Apply the edits: file the new images, read them, rebuild the reading,
 *  carry the highlights over, and save — in that order, so a failure
 *  partway leaves the reading as it was (at worst with an unused image in
 *  its folder). */
export async function applyPageEdits(
  session: StudySession,
  edits: PageEdits,
  onProgress: (note: string) => void,
): Promise<PageEditResult> {
  const current = session.pages ?? [];
  if (!current.length) throw new Error('This reading has no scanned pages to edit.');
  const plan = plannedPages(current.length, edits);
  if (!plan.length) throw new Error('A reading needs at least one page — keep one, or put one in.');

  onProgress('Reading the pages you kept…');
  const keptTexts = await getPageTexts(current);
  const kept = plan.filter((p): p is { kind: 'kept'; index: number } => p.kind === 'kept');
  if (kept.length && session.reading.trim() && kept.every((p) => !keptTexts[p.index])) {
    // The sidecars should say what the reading says; if none of them can be
    // read, rebuilding would empty the assistant's copy. Better not to.
    throw new Error('The transcriptions of these pages could not be read, so the pages were left as they were. Try again in a moment.');
  }

  // New images go into the reading's own folder, under names that can never
  // collide with the scan's page_NNNN.jpg or with one another.
  const stamp = Date.now().toString(36);
  const prefix = prefixOf(current[0]);
  const fresh = plan.flatMap((p, k) => (
    p.kind === 'new' ? [{ page: p.page, path: `${prefix}/ins_${stamp}_${String(k + 1).padStart(4, '0')}.jpg` }] : []
  ));
  if (fresh.length) {
    let filed = 0;
    let next = 0;
    onProgress(`Filing new page 1 of ${fresh.length}…`);
    const worker = async () => {
      while (next < fresh.length) {
        const f = fresh[next++];
        await uploadPageBlob(f.path, f.page.blob);
        filed += 1;
        if (filed < fresh.length) onProgress(`Filing new page ${filed + 1} of ${fresh.length}…`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, fresh.length) }, worker));
    onProgress(`Reading ${fresh.length} new page${fresh.length === 1 ? '' : 's'}…`);
  }
  const read = await transcribePages(
    fresh.map((f, i) => ({ path: f.path, n: i + 1 })),
    (done, total) => onProgress(`Read new page ${done} of ${total}…`),
  );
  const freshText = new Map<string, string>();
  fresh.forEach((f, i) => freshText.set(f.page.id, (read.get(i + 1) ?? '').trim()));

  // The pages as they will read, and where each kept page now stands, so
  // the highlights can follow it (a highlight on a cut page goes with it).
  const pages: string[] = [];
  const texts: string[] = [];
  const newIndex = new Map<number, number>();
  let f = 0;
  for (const p of plan) {
    if (p.kind === 'kept') {
      newIndex.set(p.index, pages.length);
      pages.push(current[p.index]);
      texts.push(keptTexts[p.index] ?? '');
    } else {
      pages.push(fresh[f++].path);
      texts.push(freshText.get(p.page.id) ?? '');
    }
  }
  const reading = texts.join('\n\n').trim();
  const highlights = (session.highlights ?? []).flatMap((h) => {
    const at = newIndex.get(h.page);
    return at === undefined ? [] : [{ ...h, page: at }];
  });

  onProgress('Filing the reading…');
  await updateSession(session.id, { pages, reading, highlights });
  pages.forEach((p, i) => rememberPageText(p, texts[i]));

  const cut = current.filter((_, i) => edits.deleted.has(i));
  try {
    await removeScanPages(cut);
  } catch {
    /* an unused image left behind costs nothing the reading needs */
  }
  return { pages, texts, reading, highlights };
}
