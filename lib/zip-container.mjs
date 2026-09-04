// .zip archives at ingest (Phase 3 of the ingestion plan, 2026-09-04).
//
// The web Vault expands a .zip in the browser and files each entry on its
// own (src/lib/vault-zip.ts) — fast feedback, and the right place for a
// hundred-file production. Every other path stored the archive as an
// unreadable blob: the MCP file_document tool (refused it since Phase 1),
// the Discovery intake, and 33 archives already in the vault (DeCamara,
// 2026-05-25: deposition transcript packages, court-reporter exports,
// share links) that never became searchable. This module reads an archive
// the same way the browser does, so the pipeline can unpack it into a
// folder like a PDF portfolio, and a re-run of those 33 files them.
//
// Same rules as the browser: folder structure is flattened to the basename
// (the path inside the archive is kept on the child as container_entry),
// hidden and system files are skipped (__MACOSX/, .DS_Store, dotfiles,
// Thumbs.db), nested archives are expanded depth-first, and there is a cap
// on the number of files so a runaway archive cannot flood a matter.
//
// Reads with JSZip in memory. A zip of hundreds of megabytes is a worker
// job (needsWorkerIngest routes every .zip there), and the worker has 4 GB.

import { VAULT_MAX_BYTES, extOf } from './ingest-formats.mjs';
import { safeFilename, stripExt } from './container-unpack.mjs';

export const ZIP_MAX_FILES = 500;
export const ZIP_MAX_DEPTH = 3;

// PK\x03\x04 (a local file header), PK\x05\x06 (an empty archive's end
// record) or PK\x07\x08 (a spanned archive). Word/Excel/PowerPoint files are
// zips too — see ooxmlKind for telling them apart.
export function looksLikeZip(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b &&
    ((b[2] === 0x03 && b[3] === 0x04) || (b[2] === 0x05 && b[3] === 0x06) || (b[2] === 0x07 && b[3] === 0x08));
}

// An Office Open XML package looks like a zip because it is one. Unpacking
// it would file its XML parts as documents; this says which format it
// really is, so the caller can route it to the right extractor instead.
// → '.docx' | '.xlsx' | '.pptx' | null
function ooxmlKind(zip) {
  if (!zip.file('[Content_Types].xml')) return null;
  if (zip.file('word/document.xml')) return '.docx';
  if (zip.file('xl/workbook.xml')) return '.xlsx';
  if (zip.file('ppt/presentation.xml')) return '.pptx';
  return '.docx';
}

const SKIP_SEGMENT = /^(__MACOSX|\.[^/]*|Thumbs\.db|desktop\.ini)$/i;

function skipPath(p) {
  return p.split('/').some((seg) => SKIP_SEGMENT.test(seg));
}

// Read an archive into the entries the container unpacker files.
//
// → { entries: [{ title, filename, bytes, entry }], skipped: [{ entry, reason }],
//     ooxml: '.docx' | '.xlsx' | '.pptx' | null, truncated: boolean }
//
// `entry` is the path inside the archive (nested archives contribute
// "outer.zip/inner/file.pdf"); `filename` is the flattened, sanitised
// basename, made unique within this archive by prefixing the parent
// folder and then a counter, so two "Exhibit A.pdf" in different folders
// both survive. Throws when the bytes are not a readable archive — the
// document then fails with that cause, as it should.
export async function listZipEntries(buf, { maxFiles = ZIP_MAX_FILES, maxDepth = ZIP_MAX_DEPTH } = {}) {
  const JSZip = (await import('jszip')).default;
  const entries = [];
  const skipped = [];
  const used = new Map(); // lower-cased filename → count
  let truncated = false;

  const uniqueName = (base, dir) => {
    const key = (s) => s.toLowerCase();
    if (!used.has(key(base))) { used.set(key(base), 1); return base; }
    const parentSeg = dir ? safeFilename(dir.split('/').filter(Boolean).pop() || '', '') : '';
    const withDir = parentSeg ? `${parentSeg}_${base}` : null;
    if (withDir && !used.has(key(withDir))) { used.set(key(withDir), 1); return withDir; }
    const ext = extOf(base);
    const stem = stripExt(base);
    for (let n = 2; ; n++) {
      const cand = `${stem}-${n}${ext}`;
      if (!used.has(key(cand))) { used.set(key(cand), 1); return cand; }
    }
  };

  const walk = async (bytes, prefix, depth) => {
    const zip = await JSZip.loadAsync(bytes);
    if (depth === 0) {
      const kind = ooxmlKind(zip);
      if (kind) return kind;
    }
    const files = Object.values(zip.files).filter((f) => !f.dir).sort((a, b) => a.name.localeCompare(b.name));
    for (const f of files) {
      const entry = prefix ? `${prefix}/${f.name}` : f.name;
      if (skipPath(f.name)) { skipped.push({ entry, reason: 'hidden or system file' }); continue; }
      if (entries.length >= maxFiles) { truncated = true; skipped.push({ entry, reason: `beyond the ${maxFiles}-file cap` }); continue; }
      const base = f.name.split('/').pop();
      const dir = f.name.includes('/') ? f.name.slice(0, f.name.lastIndexOf('/')) : '';
      if (extOf(base) === '.zip') {
        if (depth + 1 >= maxDepth) { skipped.push({ entry, reason: 'nested too deep' }); continue; }
        let inner;
        try { inner = Buffer.from(await f.async('uint8array')); }
        catch (err) { skipped.push({ entry, reason: `could not read (${err.message})` }); continue; }
        try {
          await walk(inner, entry, depth + 1);
        } catch (err) {
          skipped.push({ entry, reason: `nested archive unreadable (${err.message})` });
        }
        continue;
      }
      let bytes;
      try { bytes = Buffer.from(await f.async('uint8array')); }
      catch (err) { skipped.push({ entry, reason: `could not read (${err.message})` }); continue; }
      if (!bytes.length) { skipped.push({ entry, reason: 'empty file' }); continue; }
      if (bytes.length > VAULT_MAX_BYTES) { skipped.push({ entry, reason: 'over the storage cap' }); continue; }
      const filename = uniqueName(safeFilename(base, 'file.bin'), dir);
      entries.push({ title: stripExt(base) || base, filename, bytes, entry });
    }
    return null;
  };

  const ooxml = await walk(buf instanceof Uint8Array ? Buffer.from(buf) : buf, '', 0);
  if (ooxml) return { entries: [], skipped: [], ooxml, truncated: false };
  return { entries, skipped, ooxml: null, truncated };
}
