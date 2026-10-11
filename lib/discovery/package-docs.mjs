// Grapheon Discovery — one produced document's share of the package.
//
// A professional production volume has four parts, and every produced
// document appears in the first three, cross-referenced by the fourth:
//
//   IMAGES/   the Bates-stamped pages (one PDF per document; a native gets a
//             one-page slip sheet carrying its Bates number)
//   NATIVES/  the original file, for documents produced natively
//             (spreadsheets, audio/video, anything that cannot honestly be
//             reduced to pages)
//   TEXT/     the document's extracted text, one .txt per document, named by
//             its first Bates number, pages separated by form feeds
//   DATA/     the load files (loadfile.dat metadata, loadfile.opt image
//             cross-reference) that let Relativity, Concordance etc. ingest
//             the other three
//
// Both the worker (worker/discovery-worker.mjs packageProduction) and the
// offline harness (scripts/_verify-discovery-pipeline.mjs) call this, so the
// layout the harness checks is the layout the worker writes.
//
// Packaging never calls an AI or OCR service. The text comes from what
// already exists: the display PDF's own text layer, the OCR the matter's
// corpus already holds for a scanned page, or the native file's contents.

import { extOf } from './util.mjs';

// No redaction exists in Discovery yet. When it does, the text of a redacted
// document must come from the REDACTED image, never from the display PDF or
// the native below — or TEXT/ hands over exactly what was blacked out.

const FORM_FEED = '\f';

// Natives whose contents lib/ingest-core.mjs extractPages reads as text.
// Anything else (A/V, .msg, archives, images, unknown binaries) would come
// back as bytes read as UTF-8, so it gets an empty text file instead.
const TEXT_NATIVE_EXTS = new Set([
  '.docx', '.doc', '.rtf', '.xlsx', '.xls', '.pptx', '.eml',
  '.txt', '.csv', '.tsv', '.md', '.html', '.htm', '.xml', '.json',
]);

// A display page with fewer letters and digits than this is treated as having
// no text layer (a scan), and the corpus's OCR for that page is used instead.
const THIN_PAGE_CHARS = 20;

const contentLen = (s) => (String(s ?? '').match(/[\p{L}\p{N}]/gu) ?? []).length;

/**
 * Lay `pages` pieces of text into exactly `count` slots: extra pages fold
 * into the last slot, missing ones are empty. TEXT/ files then always hold
 * count-1 form feeds, so page N of the text is page N of the image.
 */
export function fitPages(texts, count) {
  const n = Math.max(1, count | 0);
  const out = Array.from({ length: n }, () => '');
  texts.forEach((t, i) => {
    const slot = Math.min(i, n - 1);
    out[slot] = out[slot] ? `${out[slot]}\n${t ?? ''}` : String(t ?? '');
  });
  return out;
}

async function extract(buf, ext) {
  const { extractPages } = await import('../ingest-core.mjs');
  const pages = await extractPages(buf, ext);
  return (pages ?? []).map((p) => String(p?.text ?? ''));
}

/**
 * The text for one produced document.
 *
 * @param {object} a
 * @param {object} a.item          production_items row
 * @param {number} a.pages         produced page count (1 for a native)
 * @param {() => Promise<Buffer>} a.readDisplay  the unstamped display PDF
 * @param {() => Promise<Buffer>} a.readNative   the original file
 * @param {() => Promise<Map<number,string>|null>} [a.corpusPages]
 *        page number -> text already in the matter's corpus for this document
 *        (OCR'd scans); called only when the text layer is thin
 * @returns {Promise<{text: string, source: 'text-layer'|'corpus'|'mixed'|'native'|'none', chars: number}>}
 */
export async function documentText({ item, pages, readDisplay, readNative, corpusPages }) {
  const ext = extOf(item.original_filename ?? '');

  if (item.kind === 'native') {
    if (!TEXT_NATIVE_EXTS.has(ext)) return { text: '', source: 'none', chars: 0 };
    let texts;
    try {
      texts = await extract(await readNative(), ext);
    } catch {
      return { text: '', source: 'none', chars: 0 };
    }
    const text = texts.join(FORM_FEED);
    const chars = contentLen(text);
    return { text: chars ? text : '', source: chars ? 'native' : 'none', chars };
  }

  let layer = [];
  try {
    layer = await extract(await readDisplay(), '.pdf');
  } catch {
    layer = [];
  }
  const slots = fitPages(layer, pages);
  let fromLayer = 0;
  let fromCorpus = 0;
  let corpus;
  for (let i = 0; i < slots.length; i++) {
    if (contentLen(slots[i]) >= THIN_PAGE_CHARS) { fromLayer += 1; continue; }
    if (corpus === undefined) corpus = corpusPages ? await corpusPages().catch(() => null) : null;
    const ocr = corpus?.get(i + 1);
    if (ocr && contentLen(ocr) > contentLen(slots[i])) { slots[i] = ocr; fromCorpus += 1; }
    else if (contentLen(slots[i])) fromLayer += 1;
  }
  const text = slots.join(FORM_FEED);
  const chars = contentLen(text);
  const source = !chars ? 'none'
    : fromCorpus && fromLayer ? 'mixed'
      : fromCorpus ? 'corpus' : 'text-layer';
  return { text, source, chars };
}

/**
 * Group a document's corpus passages (summary_level 0) into page -> text.
 * @param {Array<{text: string, page_start: number|null, sequence_number: number}>} passages
 */
export function passagesToPages(passages) {
  const byPage = new Map();
  for (const p of [...(passages ?? [])].sort((a, b) => a.sequence_number - b.sequence_number)) {
    const page = Number(p.page_start) || 1;
    byPage.set(page, byPage.has(page) ? `${byPage.get(page)}\n${p.text}` : String(p.text ?? ''));
  }
  return byPage;
}

/**
 * Write one produced document into the volume and return its load-file row.
 *
 * @param {object} a
 * @param {object} a.item
 * @param {string} a.volumeName
 * @param {boolean} a.confidential
 * @param {(path: string) => Promise<Buffer>} a.read   storage read
 * @param {(buf: Buffer, name: string) => void} a.append  add a file to the ZIP
 * @param {(item: object) => Promise<Map<number,string>|null>} [a.corpusPages]
 * @param {string} a.stampedPath   storage path of the stamped PDF
 */
export async function packageDocument({ item, volumeName, confidential, read, append, corpusPages, stampedPath }) {
  const isNative = item.kind === 'native';
  const pages = isNative ? 1 : (item.page_count ?? 1);
  const ext = extOf(item.original_filename ?? '');

  const imagePath = `IMAGES/${item.bates_first}.pdf`;
  append(await read(stampedPath), `${volumeName}/${imagePath}`);

  let nativeBuf = null;
  const readNative = async () => (nativeBuf ??= await read(item.native_storage_path));

  let nativeLink = '';
  if (isNative) {
    nativeLink = `NATIVES/${item.bates_first}${ext}`;
    append(await readNative(), `${volumeName}/${nativeLink}`);
  }

  const { text, source, chars } = await documentText({
    item,
    pages,
    readDisplay: () => read(item.display_storage_path),
    readNative,
    corpusPages: corpusPages ? () => corpusPages(item) : null,
  });
  const textLink = `TEXT/${item.bates_first}.txt`;
  // Written even when empty: every produced document has a text file, so the
  // receiving side never has to ask whether one was forgotten.
  append(Buffer.from(text, 'utf8'), `${volumeName}/${textLink}`);

  const m = item.source_metadata ?? {};
  return {
    pages,
    textSource: source,
    textChars: chars,
    datRow: {
      bates_first: item.bates_first,
      bates_last: item.bates_last,
      pages,
      custodian: m.custodian ?? '',
      author: m.author ?? '',
      to: m.to ?? '',
      cc: m.cc ?? '',
      bcc: m.bcc ?? '',
      subject: m.subject ?? '',
      date: m.date ?? '',
      filename: item.original_filename,
      file_ext: ext.replace(/^\./, '').toUpperCase(),
      file_size: item.file_size_bytes ?? '',
      sha256: item.sha256 ?? '',
      volume: volumeName,
      produced_as: isNative ? 'NATIVE' : 'IMAGE',
      native_link: nativeLink,
      text_link: textLink,
      confidentiality: confidential ? 'CONFIDENTIAL' : '',
      image_path: imagePath,
    },
  };
}
