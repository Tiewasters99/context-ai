// ZIP expansion for Vault uploads.
//
// When a .zip is dropped or chosen, expand it client-side via JSZip and
// hand the contained files back to the normal upload flow. Each contained
// file becomes its own documents row, indexed individually. Folder
// structure inside the zip is flattened — the basename becomes the
// document filename. The original path is stashed on the File object
// (`sourcePath`) for any caller that wants to group by folder later.
//
// Why client-side: Vercel serverless functions cap at 30 s and a zip
// of 100 PDFs would never finish there. JSZip in the browser handles
// extraction + per-file upload with progress feedback the user can see.
//
// Nested zips: expanded recursively (depth-first). Hidden/system files
// (.DS_Store, __MACOSX/, dotfiles) are skipped.

import JSZip from 'jszip';

// Soft caps. Beyond these we refuse the zip — keeps a runaway upload from
// flooding a matter or holding the browser tab for minutes.
export const MAX_ZIP_SIZE_BYTES = 250 * 1024 * 1024; // 250 MB
export const MAX_FILES_PER_ZIP = 500;

export function isZip(file: File): boolean {
  if (file.type === 'application/zip' || file.type === 'application/x-zip-compressed') {
    return true;
  }
  return file.name.toLowerCase().endsWith('.zip');
}

export interface ZipExpansionResult {
  files: File[];
  skipped: string[];
  truncatedAt: number | null;
}

export async function expandZip(zipFile: File): Promise<ZipExpansionResult> {
  if (zipFile.size > MAX_ZIP_SIZE_BYTES) {
    throw new Error(
      `Zip is too large — ${(zipFile.size / 1048576).toFixed(0)} MB; cap is ${
        MAX_ZIP_SIZE_BYTES / 1048576
      } MB. Split the archive and try again.`,
    );
  }

  const zip = await JSZip.loadAsync(zipFile);
  const files: File[] = [];
  const skipped: string[] = [];
  let truncatedAt: number | null = null;

  // Object.entries preserves the zip's directory order which is usually
  // a sensible reading order (matches the user's mental model of "open the
  // folder, see exhibits in order"). JSZip exposes both files and dirs;
  // we drop dirs (entry.dir = true) and process file entries only.
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (isHiddenPath(path)) {
      skipped.push(path);
      continue;
    }
    if (files.length >= MAX_FILES_PER_ZIP) {
      truncatedAt = files.length;
      break;
    }

    const blob = await entry.async('blob');
    const baseName = path.split('/').pop() || path;

    // Recursively expand nested zips. Their contents merge into the same
    // flat list; their own paths are dropped (the user just sees the
    // leaves).
    if (baseName.toLowerCase().endsWith('.zip')) {
      const nestedZip = new File([blob], baseName, { type: 'application/zip' });
      try {
        const nested = await expandZip(nestedZip);
        for (const nf of nested.files) {
          if (files.length >= MAX_FILES_PER_ZIP) {
            truncatedAt = files.length;
            break;
          }
          files.push(nf);
        }
        skipped.push(...nested.skipped.map((p) => `${path}/${p}`));
      } catch (e) {
        skipped.push(`${path} (nested zip failed: ${(e as Error).message})`);
      }
      continue;
    }

    const file = new File([blob], baseName, { type: guessMime(baseName) });
    // Stash the original path in the zip — non-enumerable so it doesn't
    // surprise serializers, but readable when needed.
    Object.defineProperty(file, 'sourcePath', {
      value: path,
      enumerable: false,
      configurable: true,
    });
    files.push(file);
  }

  return { files, skipped, truncatedAt };
}

// Hidden / system entries we never want to ingest.
function isHiddenPath(path: string): boolean {
  const parts = path.split('/');
  for (const p of parts) {
    if (!p) continue;
    if (p.startsWith('.') && p !== '.') return true; // .DS_Store, .git, etc.
    if (p === '__MACOSX') return true;
    if (p.toLowerCase() === 'thumbs.db') return true;
  }
  return false;
}

// Lightweight MIME guess so the contained File constructs cleanly — the
// downstream Supabase upload uses File.type as Content-Type and falls back
// to a server-side guess if missing.
function guessMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop() || '';
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'doc': return 'application/msword';
    case 'txt': return 'text/plain';
    case 'md': case 'markdown': return 'text/markdown';
    case 'csv': return 'text/csv';
    case 'json': return 'application/json';
    case 'html': case 'htm': return 'text/html';
    case 'epub': return 'application/epub+zip';
    case 'fountain': return 'text/plain';
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'bmp': return 'image/bmp';
    case 'tiff': case 'tif': return 'image/tiff';
    default: return 'application/octet-stream';
  }
}
