// Grapheon Discovery — shared utilities for the worker-side engine.

import crypto from 'node:crypto';

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// LIT_ + 7 + 42 -> "LIT_0000042"
export function formatBates(prefix, pad, seq) {
  return `${prefix ?? ''}${String(seq).padStart(pad, '0')}`;
}

// Mirror of scripts/ingest.mjs — Supabase Storage rejects [ ] { } and a few
// other characters that are legal on local filesystems.
export function sanitizeStorageName(name) {
  return name
    .replace(/[\[\]{}]/g, '')
    .replace(/[^\w/!\-.*'() ]/g, '_')
    .replace(/_+/g, '_');
}

export function mimeFor(ext) {
  const m = {
    '.pdf': 'application/pdf',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.msg': 'application/vnd.ms-outlook',
    '.eml': 'message/rfc822',
    '.zip': 'application/zip',
  };
  return m[ext] || 'application/octet-stream';
}

// Junk entries inside production ZIPs that are never discovery documents.
export function isJunkPath(p) {
  const base = p.split('/').pop() ?? p;
  return (
    p.includes('__MACOSX/') ||
    base === '.DS_Store' ||
    base === 'Thumbs.db' ||
    base === 'desktop.ini' ||
    base.startsWith('._')
  );
}

export function extOf(filename) {
  const m = /\.[^.]+$/.exec(filename);
  return m ? m[0].toLowerCase() : '';
}

// Minimal .env loader (same behavior as scripts/ingest.mjs — existing env wins).
export async function loadEnv(envPath) {
  const fs = await import('node:fs/promises');
  try {
    const text = await fs.readFile(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = val;
    }
  } catch { /* no .env is fine; env may come from the host */ }
}
