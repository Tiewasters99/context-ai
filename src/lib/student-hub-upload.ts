// Student Hub — "add a chapter" pipeline. The student experience of what
// used to be a local toolchain: page images (or a PDF) go into the private
// scan bucket, a server endpoint transcribes them in resumable batches,
// one model call maps the chapter's § structure from the running heads,
// one call per § names the cases and materials, and the confirmed plan is
// seeded as student_hub_texts + student_hub_sessions rows.
//
// Everything runs under the signed-in student's own JWT: storage RLS
// (migration 038) locks the scan to their account, table RLS (037/039)
// owns the rows. No privileged path exists anywhere in this flow.
//
// Deterministic first (the running-head page ranges, tiling repair, seam
// merges are plain code); the model is consulted only at the two judgment
// points — naming sections and naming items.

import { supabase } from '@/lib/supabase';
import { generateStructured } from '@/lib/llm';
import { DEFAULT_MODEL_ID, SCAN_BUCKET } from '@/lib/student-hub';
import { PDFJS_DOC_PARAMS } from '@/lib/pdfjs';

export interface StageProgress {
  stage: 'pages' | 'ocr' | 'map' | 'segment' | 'seed';
  done: number;
  total: number;
  note?: string;
}
export type OnProgress = (p: StageProgress) => void;

export interface PlanItem {
  title: string;
  kind: 'case' | 'material';
  citation: string;
  /** Scan page range, 1-based inclusive. */
  first: number;
  last: number;
  /** Set when deterministic validation had to repair or doubt this item. */
  flagged?: string;
}

export interface PlanSection {
  title: string;
  first: number;
  last: number;
  items: PlanItem[];
}

export interface ChapterPlan {
  prefix: string;
  pagePaths: string[];
  pageTexts: string[];
  bookTitle: string;
  chapterTitle: string;
  sections: PlanSection[];
  modelId: string;
}

const PAGE_LONG_EDGE = 1700; // ~200 DPI for a casebook page — matches the seeded chapters
const JPEG_QUALITY = 0.8;
const OCR_BATCH = 6;
const UPLOAD_CONCURRENCY = 3;

/* ========================= intake ========================= */

/** Reading order for a picked batch of page images (vFlat names its exports
 *  "Chapter 4 - 12.jpg", so plain lexicographic order shuffles pages). */
export function orderPageFiles(files: File[]): File[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...files].sort((a, b) => collator.compare(a.name, b.name));
}

async function toPageJpeg(source: ImageBitmapSource): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(1, PAGE_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', JPEG_QUALITY);
    });
  } finally {
    bitmap.close();
  }
}

/** Downscale/recompress one picked page; falls back to the original bytes
 *  if the browser can't decode it (the scan is still usable, just bigger). */
async function compressPage(file: File): Promise<Blob> {
  try {
    return await toPageJpeg(file);
  } catch {
    return file;
  }
}

/** Render a scanned PDF's pages to JPEG blobs, one at a time (memory-safe
 *  for big vFlat exports — only ever one page's canvas alive). */
export async function* pdfPageBlobs(file: File): AsyncGenerator<{ blob: Blob; n: number; total: number }> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  const pdf = await pdfjsLib.getDocument({
    data: await file.arrayBuffer(),
    ...PDFJS_DOC_PARAMS,
  }).promise;
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = PAGE_LONG_EDGE / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', JPEG_QUALITY);
      });
      page.cleanup();
      yield { blob, n: i, total: pdf.numPages };
    }
  } finally {
    await pdf.destroy();
  }
}

/* ========================= upload ========================= */

const pagePath = (prefix: string, n: number) => `${prefix}/page_${String(n).padStart(4, '0')}.jpg`;

async function uploadOne(path: string, blob: Blob): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    // No upsert: bucket RLS (038) has no UPDATE policy, so overwrites are
    // denied. A page that already exists is the same page — keep it.
    const { error } = await supabase.storage
      .from(SCAN_BUCKET)
      .upload(path, blob, { contentType: 'image/jpeg' });
    if (!error || /already exists/i.test(error.message)) return;
    if (attempt >= 2) throw new Error(`upload failed: ${path}: ${error.message}`);
    await sleep(1000 * (attempt + 1));
  }
}

export async function newScanPrefix(kind: string): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const uid = data.user?.id;
  if (!uid) throw new Error('Not signed in');
  return `${uid}/${kind}-${Date.now().toString(36)}`;
}

export const newChapterPrefix = (): Promise<string> => newScanPrefix('chapter');

/** Every object name directly under a bucket folder (paginated past the
 *  per-call cap — a chapter can run 300 pages). */
async function listAll(folder: string): Promise<Set<string>> {
  const names = new Set<string>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage
      .from(SCAN_BUCKET)
      .list(folder, { limit: 1000, offset });
    if (error || !data?.length) break;
    for (const entry of data) names.add(entry.name);
    if (data.length < 1000) break;
  }
  return names;
}

export async function uploadPageFiles(
  prefix: string,
  files: File[],
  onProgress: OnProgress,
): Promise<string[]> {
  const ordered = orderPageFiles(files);
  const paths: string[] = ordered.map((_, i) => pagePath(prefix, i + 1));
  const already = await listAll(prefix); // resume: an interrupted run re-sends nothing
  let done = 0;
  let next = 0;
  onProgress({ stage: 'pages', done, total: ordered.length });
  const worker = async () => {
    while (next < ordered.length) {
      const i = next++;
      if (!already.has(paths[i].slice(prefix.length + 1))) {
        await uploadOne(paths[i], await compressPage(ordered[i]));
      }
      onProgress({ stage: 'pages', done: ++done, total: ordered.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, ordered.length) }, worker));
  return paths;
}

export async function uploadPdfPages(
  prefix: string,
  pdf: File,
  onProgress: OnProgress,
): Promise<string[]> {
  const paths: string[] = [];
  for await (const { blob, n, total } of pdfPageBlobs(pdf)) {
    const path = pagePath(prefix, n);
    await uploadOne(path, blob);
    paths.push(path);
    onProgress({ stage: 'pages', done: n, total });
  }
  return paths;
}

/* ========================== OCR =========================== */

async function authToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in');
  return token;
}

/** Transcriptions already persisted under {prefix}/ocr — the resume set. */
async function existingOcr(prefix: string): Promise<Map<number, string>> {
  const names = [...(await listAll(`${prefix}/ocr`))].filter((n) => /^page_\d+\.txt$/.test(n));
  const found = new Map<number, string>();
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const name = names[next++];
      const { data: blob } = await supabase.storage
        .from(SCAN_BUCKET)
        .download(`${prefix}/ocr/${name}`);
      if (blob) found.set(parseInt(name.match(/\d+/)![0], 10), await blob.text());
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, names.length) }, worker));
  return found;
}

export async function ocrPages(
  prefix: string,
  pagePaths: string[],
  onProgress: OnProgress,
  signal?: AbortSignal,
): Promise<string[]> {
  const total = pagePaths.length;
  const texts = new Array<string>(total).fill('');
  const have = await existingOcr(prefix);
  for (const [n, text] of have) if (n >= 1 && n <= total) texts[n - 1] = text;

  const pending: { path: string; n: number }[] = [];
  for (let i = 0; i < total; i++) {
    if (!have.has(i + 1)) pending.push({ path: pagePaths[i], n: i + 1 });
  }
  let done = total - pending.length;
  onProgress({ stage: 'ocr', done, total });
  if (!pending.length) return texts;

  const token = await authToken();
  const batches: { path: string; n: number }[][] = [];
  for (let i = 0; i < pending.length; i += OCR_BATCH) batches.push(pending.slice(i, i + OCR_BATCH));

  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      for (let attempt = 0; ; attempt++) {
        const res = await fetch('/api/student-hub-ocr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ pages: batch }),
          signal,
        });
        if (res.ok) {
          const body = (await res.json()) as { pages: { n: number; text: string }[] };
          for (const p of body.pages) texts[p.n - 1] = p.text;
          done += batch.length;
          onProgress({ stage: 'ocr', done, total });
          break;
        }
        const detail = await res.text();
        if (attempt >= 2 || (res.status < 500 && res.status !== 429)) {
          throw new Error(`Reading pages failed (${res.status}): ${detail.slice(0, 200)}`);
        }
        await sleep(2000 * (attempt + 1));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, batches.length) }, worker));
  return texts;
}

/* ===================== any-text intake ===================== */

/** Per-page text from a PDF's own text layer — the born-digital shortcut.
 *  Returns null when the layer is too thin to be the real text (a scan). */
export async function pdfTextPages(file: File): Promise<string[] | null> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  const pdf = await pdfjsLib.getDocument({
    data: await file.arrayBuffer(),
    ...PDFJS_DOC_PARAMS,
  }).promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        const it = item as { str?: string; hasEOL?: boolean };
        if (it.str) text += it.str;
        if (it.hasEOL) text += '\n';
      }
      pages.push(text.trim());
      page.cleanup();
    }
    const chars = pages.reduce((n, t) => n + t.length, 0);
    return chars / pdf.numPages >= 200 ? pages : null;
  } finally {
    await pdf.destroy();
  }
}

export interface UploadedText {
  text: string;
  /** Storage paths when the upload was a scan that went through OCR. */
  pages: string[] | null;
  /** The book's own cover — page one of a born-digital PDF, rendered at
   *  upload time. Scans don't need one (their first page IS the cover) and
   *  plain text has none to give. */
  cover: Blob | null;
}

/** Page one of a PDF as a JPEG — the cover a born-digital book brought with
 *  it. Best-effort: a book without a cover still reads. */
export async function pdfCoverBlob(file: File): Promise<Blob | null> {
  try {
    for await (const { blob } of pdfPageBlobs(file)) return blob;
  } catch { /* the plate stands in */ }
  return null;
}

/** One picked image, sized down to serve as a cover. Throws when the browser
 *  cannot decode the picked file. */
export function coverJpeg(file: File): Promise<Blob> {
  return toPageJpeg(file);
}

const isPlainTextFile = (f: File) =>
  /\.(txt|md|markdown)$/i.test(f.name) || f.type.startsWith('text/');
const isPdfFile = (f: File) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';

/** Turn any picked file — .txt/.md, a PDF, or a set of page images — into
 *  reading text. A PDF with a real text layer reads itself (free, instant);
 *  scans take the same storage + OCR path a chapter does, so the filed
 *  reading keeps its page images for the reader. */
export async function readUploadedText(
  files: File[],
  onProgress: OnProgress,
  signal?: AbortSignal,
): Promise<UploadedText> {
  if (files.length === 1 && isPlainTextFile(files[0])) {
    return { text: (await files[0].text()).trim(), pages: null, cover: null };
  }
  if (files.length === 1 && isPdfFile(files[0])) {
    const layer = await pdfTextPages(files[0]);
    if (layer) {
      return { text: layer.join('\n\n').trim(), pages: null, cover: await pdfCoverBlob(files[0]) };
    }
    const prefix = await newScanPrefix('text');
    const paths = await uploadPdfPages(prefix, files[0], onProgress);
    const texts = await ocrPages(prefix, paths, onProgress, signal);
    return { text: texts.join('\n\n').trim(), pages: paths, cover: null };
  }
  const prefix = await newScanPrefix('text');
  const paths = await uploadPageFiles(prefix, files, onProgress);
  const texts = await ocrPages(prefix, paths, onProgress, signal);
  return { text: texts.join('\n\n').trim(), pages: paths, cover: null };
}

/* ===================== chapter mapping ===================== */

// The casebook's own navigation: verso running heads carry the chapter,
// recto heads carry the current §. A page's first lines are enough.
function runningHeads(pageTexts: string[]): string {
  return pageTexts
    .map((t, i) => {
      const head = t
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(' / ')
        .slice(0, 110);
      return `p.${i + 1}: ${head || '(blank)'}`;
    })
    .join('\n');
}

interface ChapterMap {
  book_title: string;
  chapter_title: string;
  sections: { title: string; first_page: number; last_page: number }[];
}

export async function mapChapter(
  pageTexts: string[],
  modelId: string,
  signal?: AbortSignal,
): Promise<{ bookTitle: string; chapterTitle: string; sections: { title: string; first: number; last: number }[] }> {
  const opening = pageTexts.slice(0, 3).join('\n\n').slice(0, 4000);
  const result = await generateStructured<ChapterMap>({
    modelId,
    signal,
    system:
      'You are mapping one scanned chapter of a law-school casebook from OCR text. ' +
      'The running heads navigate it: left-hand (verso) pages repeat the chapter title, right-hand (recto) pages ' +
      'carry the current section title, usually with a § number. From the per-page head lines, determine the ' +
      'chapter title, the book title if the heads or opening reveal it, and the ordered list of sections with the ' +
      'SCAN page range each spans. Section titles keep their § numbering (e.g. "§ 1 Mutual Assent"). Sections must ' +
      'tile the chapter in order: the first starts on page 1, each next starts right after the previous ends, the ' +
      'last ends on the final page. OCR noise is expected — read through it.',
    userContent:
      `The chapter opens:\n${opening}\n\n` +
      `First lines of each scan page:\n${runningHeads(pageTexts)}`,
    toolName: 'record_chapter_map',
    toolDescription: 'Record the chapter title, book title, and ordered sections with scan-page ranges.',
    inputSchema: {
      type: 'object',
      properties: {
        book_title: {
          type: 'string',
          description: 'Casebook title if evident (e.g. "Cases and Comment on Contracts"), else empty.',
        },
        chapter_title: {
          type: 'string',
          description: 'Chapter designation and name, e.g. "Chapter 4 — Identifying the Bargain".',
        },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Section title with its § number, e.g. "§ 1 Mutual Assent".' },
              first_page: { type: 'integer', description: 'SCAN page where the section starts.' },
              last_page: { type: 'integer', description: 'SCAN page where the section ends.' },
            },
            required: ['title', 'first_page', 'last_page'],
          },
        },
      },
      required: ['book_title', 'chapter_title', 'sections'],
    },
    maxTokens: 2048,
  });

  const total = pageTexts.length;
  const sections = (result.sections ?? [])
    .filter((s) => s.title?.trim())
    .sort((a, b) => a.first_page - b.first_page)
    .map((s) => ({
      title: s.title.trim(),
      first: Math.max(1, Math.min(total, Math.round(s.first_page) || 1)),
      last: Math.max(1, Math.min(total, Math.round(s.last_page) || total)),
    }));
  if (!sections.length) sections.push({ title: '§ 1', first: 1, last: total });
  // Tile deterministically: trust the starts, derive the ends.
  sections[0].first = 1;
  for (let i = 0; i < sections.length - 1; i++) {
    if (sections[i + 1].first <= sections[i].first) sections[i + 1].first = sections[i].first + 1;
    sections[i].last = sections[i + 1].first - 1;
  }
  sections[sections.length - 1].last = total;

  return {
    bookTitle: (result.book_title ?? '').trim(),
    chapterTitle: (result.chapter_title ?? '').trim() || 'Uploaded chapter',
    sections,
  };
}

/* ===================== § segmentation ====================== */

// The prompt that mapped chapters 1–3 without ever misreading a caption;
// ported verbatim from the local pipeline (segment_sections.py).
const SEGMENT_SYSTEM =
  'You are mapping the structure of a section of a Contracts casebook from noisy OCR text. ' +
  'Identify every item in reading order: principal cases (set out at length under an all-caps ' +
  "caption with court and year) as kind 'case', and everything between them (comments, notes, " +
  "problems, article excerpts like Fuller & Perdue) grouped into coherent kind 'material' items. " +
  'Consecutive notes/problems following a case belong in ONE material item (title it e.g. ' +
  "'Notes and problems after Hawkins v. McGee'). Items must tile the section: the first item " +
  "starts on the section's first page, each next item starts where the previous ends (they may " +
  'share a page), through the last page. Use SCAN page numbers from the page markers.';

interface RecordedItem {
  title: string;
  kind: 'case' | 'material';
  citation: string;
  first_page: number;
  last_page: number;
}

async function segmentSection(
  section: { title: string; first: number; last: number },
  pageTexts: string[],
  modelId: string,
  signal?: AbortSignal,
): Promise<PlanItem[]> {
  const body = pageTexts
    .slice(section.first - 1, section.last)
    .map((t, i) => `===== SCAN PAGE ${section.first + i} =====\n${t}`)
    .join('\n');
  const result = await generateStructured<{ items: RecordedItem[] }>({
    modelId,
    signal,
    system: SEGMENT_SYSTEM,
    userContent: `Section: ${section.title}\n\n${body}`,
    toolName: 'record_items',
    toolDescription: 'Record the ordered items (principal cases and materials) of this casebook section.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description:
                  "Case name in ordinary caption form (e.g. 'Hawkins v. McGee') or a short material title " +
                  "(e.g. 'Fuller & Perdue, The Reliance Interest in Contract Damages' or 'Comment: The Expectation Interest').",
              },
              kind: { type: 'string', enum: ['case', 'material'] },
              citation: { type: 'string', description: 'Reporter citation and year for cases; empty for materials.' },
              first_page: {
                type: 'integer',
                description: 'SCAN page where the item starts (from the ===== SCAN PAGE N ===== markers).',
              },
              last_page: { type: 'integer', description: 'SCAN page where the item ends.' },
            },
            required: ['title', 'kind', 'citation', 'first_page', 'last_page'],
          },
        },
      },
      required: ['items'],
    },
    maxTokens: 4096,
  });

  const items: PlanItem[] = (result.items ?? [])
    .filter((it) => it.title?.trim())
    .map((it) => ({
      title: it.title.trim(),
      kind: it.kind === 'case' ? 'case' : 'material',
      citation: (it.citation ?? '').trim(),
      first: Math.round(it.first_page),
      last: Math.round(it.last_page),
    }));

  // Deterministic tiling repair: clamp into the section, keep order, close gaps.
  let prevLast = section.first - 1;
  for (const it of items) {
    if (it.first < section.first || it.first > section.last) {
      it.flagged = `page range repaired (was ${it.first}–${it.last})`;
      it.first = Math.min(Math.max(it.first, section.first), section.last);
    }
    if (it.first > prevLast + 1) {
      it.flagged = it.flagged || `gap before this item closed (started p.${it.first})`;
      it.first = prevLast + 1;
    }
    if (it.last < it.first) it.last = it.first;
    if (it.last > section.last) {
      it.flagged = it.flagged || `page range repaired (ran past § end)`;
      it.last = section.last;
    }
    prevLast = it.last;
  }
  if (items.length && items[items.length - 1].last < section.last) {
    items[items.length - 1].last = section.last;
  }
  return items;
}

const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Chapters 2 and 3 both had one case straddling a § boundary, detected as
 *  the same title closing one section and opening the next; merge forward. */
function mergeSeams(sections: PlanSection[]): void {
  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i];
    const b = sections[i + 1];
    const lastA = a.items[a.items.length - 1];
    const firstB = b.items[0];
    if (!lastA || !firstB || normTitle(lastA.title) !== normTitle(firstB.title)) continue;
    firstB.first = lastA.first;
    firstB.flagged = `continues from ${a.title}; merged`;
    a.items.pop();
    if (a.items.length) {
      const prev = a.items[a.items.length - 1];
      prev.last = a.last = Math.max(prev.first, lastA.first - 1);
    }
    b.first = lastA.first;
  }
}

/* ======================= the pipeline ======================= */

export async function buildChapterPlan(
  prefix: string,
  pagePaths: string[],
  pageTexts: string[],
  onProgress: OnProgress,
  modelId: string = DEFAULT_MODEL_ID,
  signal?: AbortSignal,
): Promise<ChapterPlan> {
  onProgress({ stage: 'map', done: 0, total: 1 });
  const { bookTitle, chapterTitle, sections } = await mapChapter(pageTexts, modelId, signal);
  onProgress({ stage: 'map', done: 1, total: 1, note: chapterTitle });

  const planSections: PlanSection[] = [];
  for (let i = 0; i < sections.length; i++) {
    onProgress({ stage: 'segment', done: i, total: sections.length, note: sections[i].title });
    const items = await segmentSection(sections[i], pageTexts, modelId, signal);
    planSections.push({ ...sections[i], items });
  }
  mergeSeams(planSections);
  onProgress({ stage: 'segment', done: sections.length, total: sections.length });

  return { prefix, pagePaths, pageTexts, bookTitle, chapterTitle, sections: planSections, modelId };
}

/* ========================= seeding ========================= */

/** "Chapter 4 — Whatever" -> "ch. 4"; anything else -> "" */
const chapterShort = (chapterTitle: string) => {
  const m = chapterTitle.match(/chapter\s+(\d+)/i);
  return m ? `ch. ${m[1]}` : '';
};

export async function seedChapter(plan: ChapterPlan, onProgress: OnProgress): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error('Not signed in');

  const title = plan.bookTitle ? `${plan.bookTitle} · ${plan.chapterTitle}` : plan.chapterTitle;
  const { data: existing, error: dupErr } = await supabase
    .from('student_hub_texts')
    .select('id')
    .eq('title', title)
    .limit(1);
  if (dupErr) throw new Error(dupErr.message);
  if (existing?.length) throw new Error(`"${title}" is already in your library.`);

  const { data: text, error: textErr } = await supabase
    .from('student_hub_texts')
    .insert({ owner_id: uid, title })
    .select('id')
    .single();
  if (textErr) throw new Error(textErr.message);

  const ch = chapterShort(plan.chapterTitle);
  const rows: Record<string, unknown>[] = [];
  let sort = 0;
  for (const sec of plan.sections) {
    const secNo = sec.title.split(/\s+/).slice(0, 2).join(' '); // "§ 1"
    for (const it of sec.items) {
      sort += 1;
      rows.push({
        owner_id: uid,
        text_id: text.id,
        chapter: plan.chapterTitle,
        section: sec.title,
        kind: it.kind,
        sort,
        title: it.title,
        citation: it.citation,
        source_label: ch ? `your casebook · ${ch}, ${secNo}` : `your casebook · ${secNo}`,
        reading: plan.pageTexts.slice(it.first - 1, it.last).join('\n'),
        pages: plan.pagePaths.slice(it.first - 1, it.last),
        model_id: plan.modelId,
      });
    }
  }

  onProgress({ stage: 'seed', done: 0, total: rows.length });
  for (let i = 0; i < rows.length; i += 12) {
    const chunk = rows.slice(i, i + 12);
    const { error } = await supabase.from('student_hub_sessions').insert(chunk);
    if (error) throw new Error(error.message);
    onProgress({ stage: 'seed', done: Math.min(i + 12, rows.length), total: rows.length });
  }
  return text.id as string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
