// Grapheon Discovery — a production packaged as one or more volumes.
//
// Until 2026-10-13 a production was one ZIP, written one document at a time,
// read back whole into memory and uploaded in a single request. That holds at
// 300 documents; at 9,000 pages it ran past the job watchdog, and a package
// near the storage limit (2 GB per object) could not be uploaded at all.
//
// This module is the packaging loop the worker runs and the offline harness
// drives (scripts/_verify-discovery-pipeline.mjs, scripts/_test-production-
// volume.mjs), so what the harness checks is what the worker writes:
//
//   * several documents are packaged at once (lib/discovery/pool.mjs), and
//     released into the ZIP in Bates order, so the output is the same as one
//     at a time: same entries, same order, same load file;
//   * "Split into volumes of about N pages" (Eden, 2026-10-13: vendors
//     deliver ~2,500-page volumes). A document is never split, and neither is
//     an email family. Bates numbers run on across volumes; each volume is
//     its own folder and ZIP (NAME_VOL001 ...) with its own IMAGES/, NATIVES/,
//     TEXT/ and DATA/ load files; the production's own papers (letter,
//     privilege log, reconciliation, exceptions, duplicates) go in the last
//     volume, and its reconciliation lists every volume;
//   * a production that would come near the storage limit is split even when
//     nobody asked, and the panel says so;
//   * each finished volume is uploaded and checkpointed (package/volumes.json),
//     so a job cut off by a restart starts again at the next volume rather
//     than at document one.
//
// A production that is not split, and fits, comes out exactly as before: one
// folder named after the production, one ZIP, the same files.

import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runOrdered } from './pool.mjs';
import { emitDat, emitOpt } from './loadfile.mjs';
import { parentIdOf } from './families.mjs';

export const DEFAULT_VOLUME_PAGES = 2500;

/** A volume is closed once it holds this many bytes (DISCOVERY_VOLUME_MAX_BYTES, default 1.5 GB). */
export function volumeMaxBytes(env = process.env) {
  const n = Number(env.DISCOVERY_VOLUME_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 1.5e9;
}

// What one TIFF page is assumed to weigh when deciding, before anything is
// written, whether an unsplit production would come near the limit. A Group IV
// letter page at 300 dpi is ~30–80 KB; colour pages go out as JPEG and weigh
// far more. Erring large only means splitting a little early.
const EST_TIFF_PAGE_BYTES = 150 * 1024;
const EST_PDF_PAGE_BYTES = 40 * 1024;

const pagesOf = (item) => (item.kind === 'native' ? 1 : (item.page_count ?? 1));

/** The email family an item belongs to (its email's id), or null for a loose document. */
export function familyKeyOf(item) {
  return parentIdOf(item) ?? (item?.source_metadata?.family ? item.id : null);
}

/**
 * The production cut into units that may not be split: a loose document, or
 * an email with its attachments (contiguous in Bates order).
 * @returns {Array<{ start: number, end: number, pages: number }>}  end exclusive
 */
export function planUnits(produced) {
  const units = [];
  for (let i = 0; i < produced.length; i++) {
    const key = familyKeyOf(produced[i]);
    const last = units[units.length - 1];
    if (key && last && last.key === key) {
      last.end = i + 1;
      last.pages += pagesOf(produced[i]);
    } else {
      units.push({ key, start: i, end: i + 1, pages: pagesOf(produced[i]) });
    }
  }
  return units.map(({ start, end, pages }) => ({ start, end, pages }));
}

/**
 * Volumes by page count alone: greedy, whole units, a unit larger than the
 * limit gets a volume to itself. With no limit, one volume.
 * @returns {Array<{ start: number, end: number, pages: number }>}
 */
export function planVolumes(produced, { maxPages = null } = {}) {
  const units = planUnits(produced);
  if (!maxPages) {
    return units.length ? [{ start: 0, end: produced.length, pages: units.reduce((n, u) => n + u.pages, 0) }] : [];
  }
  const vols = [];
  for (const u of units) {
    const cur = vols[vols.length - 1];
    if (cur && cur.pages + u.pages <= maxPages) { cur.end = u.end; cur.pages += u.pages; }
    else vols.push({ ...u });
  }
  return vols;
}

/** A rough upper estimate of the package's size, before anything is written. */
export function estimatePackageBytes(produced, imageFormat) {
  let bytes = 0;
  for (const it of produced) {
    const pages = pagesOf(it);
    if (it.kind === 'native') bytes += (it.file_size_bytes ?? 0) + EST_PDF_PAGE_BYTES;
    else if (imageFormat === 'tiff') bytes += pages * EST_TIFF_PAGE_BYTES;
    else bytes += Math.max(it.file_size_bytes ?? 0, pages * EST_PDF_PAGE_BYTES);
  }
  return bytes;
}

/** NAME for an unsplit production; NAME_VOL001, NAME_VOL002 ... once split. */
export function volumeNameFor(baseName, index, split) {
  return split ? `${baseName}_VOL${String(index + 1).padStart(3, '0')}` : baseName;
}

/**
 * What a checkpoint is valid for: the same documents, numbered the same way,
 * packaged with the same choices. Anything else starts over.
 */
export function packagingKey({ produced, imageFormat, maxPages, includePrivilegeLog }) {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify({ imageFormat, maxPages: maxPages ?? null, includePrivilegeLog: !!includePrivilegeLog }));
  for (const it of produced) h.update(`|${it.id}:${it.bates_first}:${it.bates_last}`);
  return h.digest('hex');
}

// Entries that are already compressed are STORED: deflating a TIFF, a JPEG or
// a PDF costs CPU for a few percent at best. Text and load files deflate.
const STORED_EXTS = new Set([
  '.pdf', '.tif', '.tiff', '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.zip', '.docx', '.xlsx', '.pptx', '.mp3', '.mp4', '.m4a', '.mov', '.aac', '.ogg', '.webm',
]);
const storedEntry = (name) => STORED_EXTS.has(path.extname(name).toLowerCase());

/**
 * A ZIP being written to a temp file, with back-pressure: drain() waits until
 * archiver has written most of what was appended, so buffers handed to it
 * do not pile up in memory faster than the disk takes them.
 */
export async function openZipArchive({ dir = os.tmpdir(), maxPending = 64 } = {}) {
  const archiver = (await import('archiver')).default;
  const file = path.join(dir, `disc-pkg-${crypto.randomUUID()}.zip`);
  const out = createWriteStream(file);
  const archive = archiver('zip', { zlib: { level: 6 } });
  let appended = 0;
  let written = 0;
  let waiters = [];
  let failed = null;
  archive.on('entry', () => {
    written += 1;
    if (appended - written <= maxPending / 2) { const w = waiters; waiters = []; w.forEach((r) => r()); }
  });
  const closed = new Promise((resolve, reject) => {
    out.on('close', resolve);
    const fail = (err) => { failed = err; waiters.forEach((r) => r()); waiters = []; reject(err); };
    archive.on('error', fail);
    out.on('error', fail);
  });
  closed.catch(() => {});
  archive.pipe(out);
  let bytes = 0;
  return {
    file,
    get bytes() { return bytes; },
    append(buf, name) {
      appended += 1;
      bytes += buf.length;
      archive.append(buf, { name, store: storedEntry(name) });
    },
    async drain() {
      if (failed) throw failed;
      if (appended - written <= maxPending) return;
      await new Promise((r) => waiters.push(r));
      if (failed) throw failed;
    },
    async close() {
      await archive.finalize();
      await closed;
      const st = await fs.stat(file);
      return { file, bytes: st.size };
    },
    async abort() {
      try { archive.abort(); } catch { /* already finished */ }
      await fs.unlink(file).catch(() => {});
    },
  };
}

class SplitRequired extends Error {}

/**
 * Package a production's produced documents into one or more volumes.
 *
 * @param {object} o
 * @param {object[]} o.produced              stamped items, in Bates order
 * @param {'pdf'|'tiff'} o.imageFormat
 * @param {string} o.baseName                the production's folder name
 * @param {number|null} [o.maxPages]         "split into volumes of about N pages"; null = not asked
 * @param {boolean} [o.includePrivilegeLog]  (part of the checkpoint key)
 * @param {number} [o.maxBytes]              close a volume at this size (default volumeMaxBytes())
 * @param {number} [o.hardLimitBytes]        an unsplit package that grows past this is redone split (default 1.9 GB)
 * @param {number} [o.concurrency]
 * @param {(item: object) => Promise<{ files: Array<{name: string, buf: Buffer}>, datRow: object, pages: number, textChars: number, textSource?: string }>} o.packageOne
 *        one document's share, with entry names RELATIVE to the volume folder (IMAGES/…)
 * @param {(item: object, datRow: object) => object} [o.rowFor]  add family / duplicate columns
 * @param {(a: { append: (buf: Buffer, name: string) => void, volumes: object[], textless: string[], totalPages: number }) => Promise<void>} o.productionFiles
 *        the production's own papers, appended (names relative) to the last volume
 * @param {(a: { name: string, index: number, split: boolean, file: string, bytes: number }) => Promise<{ storage_path: string, sha256: string }>} o.storeVolume
 * @param {(storagePath: string) => Promise<boolean>} [o.exists]
 * @param {{ load: () => Promise<object|null>, save: (m: object) => Promise<void> }} [o.checkpoint]
 * @param {(pct: number, note: string) => Promise<void>|void} [o.progress]
 * @param {() => Promise<object>} [o.openArchive]  (tests); default openZipArchive()
 */
export async function packageVolumes(o) {
  try {
    return await packageVolumesOnce(o, { forceSplit: false });
  } catch (err) {
    if (!(err instanceof SplitRequired)) throw err;
    return packageVolumesOnce(o, { forceSplit: true });
  }
}

async function packageVolumesOnce(o, { forceSplit }) {
  const {
    produced, imageFormat, baseName, maxPages = null, includePrivilegeLog = false,
    concurrency = 6, packageOne, rowFor = (_it, row) => row, productionFiles, storeVolume,
    exists = async () => true, checkpoint = null, progress = () => {},
    openArchive = () => openZipArchive(),
  } = o;
  const hardLimitBytes = o.hardLimitBytes ?? 1.9e9;
  // A volume closes at this size, never past the hard limit (with room for
  // the document that tips it over).
  const maxBytes = Math.min(o.maxBytes ?? volumeMaxBytes(), hardLimitBytes * 0.8);
  const n = produced.length;
  const key = packagingKey({ produced, imageFormat, maxPages, includePrivilegeLog });

  // Split if asked, or if the whole would come near the storage limit.
  let split = !!maxPages || forceSplit;
  let autoSplit = !maxPages && (forceSplit || estimatePackageBytes(produced, imageFormat) > maxBytes);
  if (autoSplit) split = true;

  // Resume: the volumes an earlier attempt finished, if it was packaging the
  // same thing the same way and their ZIPs are still there.
  const volumes = [];
  let startAt = 0;
  const prior = checkpoint ? await checkpoint.load().catch(() => null) : null;
  if (prior && prior.key === key && Array.isArray(prior.volumes)) {
    split = !!prior.split;
    autoSplit = !!prior.auto_split;
    for (const v of prior.volumes) {
      if (v.start !== startAt || !(await exists(v.storage_path))) break;
      volumes.push(v);
      startAt = v.end;
    }
    if (prior.complete && startAt === n && volumes.length === prior.volumes.length) {
      return summarize(volumes, { split, autoSplit, resumed: volumes.length, finished: true });
    }
  }
  const resumed = volumes.length;
  const saveCheckpoint = async (complete) => {
    if (!checkpoint || !split) return;
    await checkpoint.save({
      version: 1, key, split, auto_split: autoSplit, max_pages: maxPages ?? null,
      image_format: imageFormat, complete, volumes,
    });
  };

  // Where each unit starts, and how many pages it holds.
  const unitAt = new Map(planUnits(produced).map((u) => [u.start, u]));

  let vol = null;   // { name, index, start, archive, rows, pages, textless }
  const openVolume = async (start) => {
    const index = volumes.length;
    vol = {
      name: volumeNameFor(baseName, index, split), index, start,
      archive: await openArchive(), rows: [], pages: 0, textless: [],
    };
  };
  const closeVolume = async (end, isLast) => {
    const v = vol;
    const append = (buf, name) => v.archive.append(buf, `${v.name}/${name}`);
    append(emitDat(v.rows), 'DATA/loadfile.dat');
    append(emitOpt(v.rows, v.name), 'DATA/loadfile.opt');
    if (split) append(volumeText(v, { end, produced, isLast }), 'DATA/VOLUME.txt');
    const all = [...volumes, describe(v, end, produced)];
    if (isLast) {
      await productionFiles({
        append, volumes: all, split,
        textless: all.flatMap((x) => x.textless), totalPages: all.reduce((s, x) => s + x.pages, 0),
      });
    }
    const { file, bytes } = await v.archive.close();
    if (!split && bytes > hardLimitBytes) {
      await fs.unlink(file).catch(() => {});
      throw new SplitRequired(`package would be ${bytes} bytes`);
    }
    await progress(Math.min(99, 90 + (9 * end) / Math.max(1, n)), `Uploading ${v.name}…`);
    let stored;
    try {
      stored = await storeVolume({ name: v.name, index: v.index, split, file, bytes });
    } finally {
      await fs.unlink(file).catch(() => {});
    }
    volumes.push({ ...describe(v, end, produced), ...stored, bytes });
    vol = null;
    await saveCheckpoint(isLast);
  };

  let released = startAt;
  const textSources = new Map();
  try {
    if (startAt < n) await openVolume(startAt);
    await runOrdered(
      produced.slice(startAt),
      { concurrency },
      (item) => packageOne(item),
      async (doc, item, k) => {
        const i = startAt + k;
        const unit = unitAt.get(i);
        // A new volume only between units, and only once this one holds something.
        if (unit && split && vol.rows.length && (
          (maxPages && vol.pages + unit.pages > maxPages) || vol.archive.bytes >= maxBytes)) {
          await closeVolume(i, false);
          await openVolume(i);
        }
        if (!split && vol.archive.bytes > hardLimitBytes) throw new SplitRequired('unsplit package too large');
        for (const f of doc.files) vol.archive.append(f.buf, `${vol.name}/${f.name}`);
        vol.rows.push(rowFor(item, { ...doc.datRow, volume: vol.name }));
        vol.pages += doc.pages;
        if (!doc.textChars) vol.textless.push(item.bates_first);
        if (doc.textSource) textSources.set(item.id, doc.textSource);
        released = i + 1;
        await vol.archive.drain();
        await progress((released / n) * 90, `Packaging ${item.bates_first}${split ? ` (${vol.name})` : ''}`);
      },
    );
    if (vol) await closeVolume(n, true);
  } catch (err) {
    if (vol) await vol.archive.abort?.();
    throw err;
  }

  return summarize(volumes, { split, autoSplit, resumed, textSources });
}

function describe(v, end, produced) {
  const first = produced[v.start];
  const last = produced[end - 1];
  return {
    name: v.name, index: v.index, start: v.start, end,
    docs: end - v.start, pages: v.pages,
    bates_first: first?.bates_first ?? '', bates_last: last?.bates_last ?? '',
    textless: v.textless,
  };
}

function summarize(volumes, { split, autoSplit, resumed, textSources = new Map() }) {
  return {
    volumes,
    split,
    autoSplit,
    resumed,
    totalPages: volumes.reduce((s, v) => s + v.pages, 0),
    textless: volumes.flatMap((v) => v.textless ?? []),
    textSources,
  };
}

function volumeText(v, { end, produced, isLast }) {
  const d = describe(v, end, produced);
  const lines = [
    'PRODUCTION VOLUME',
    '',
    `Volume:       ${d.name}`,
    `Bates range:  ${d.bates_first} - ${d.bates_last}`,
    `Documents:    ${d.docs}`,
    `Pages:        ${d.pages}`,
    `Text files with no extractable text: ${d.textless.length}`,
    '',
    isLast
      ? 'This is the last volume. The production\'s reconciliation, covering every volume, is'
      : 'The production\'s reconciliation, covering every volume, is in the last volume:',
    isLast ? 'DATA/RECONCILIATION.txt in this folder.' : 'its DATA/RECONCILIATION.txt.',
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}
