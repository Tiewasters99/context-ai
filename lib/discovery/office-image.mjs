// Grapheon Discovery — Word documents and email produced as IMAGES.
//
// Professional productions image what reads as pages (Word files, email) and
// produce natively only what cannot honestly be reduced to pages
// (spreadsheets, audio/video). This module turns a Word file or an email into
// a display PDF with LibreOffice running headless in the worker, so it can be
// Bates-stamped page by page like any PDF. The native bytes are still kept.
//
// LibreOffice is in the worker's Docker image (worker/Dockerfile). Where it
// is not installed (a laptop, CI, the offline harness) officeAvailable() is
// false and normalize.mjs keeps today's behaviour: the file is produced
// natively behind a Bates slip sheet. A conversion that fails or times out
// falls back the same way. Imaging never makes a file unproducible.
//
// Nothing leaves the machine: soffice runs locally on a temp copy.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const WORD_EXTS = new Set(['.doc', '.docx', '.rtf', '.odt', '.wpd']);
export const EMAIL_EXTS = new Set(['.eml']);

const CONVERT_TIMEOUT_MS = 180_000;

let cachedBinary;
/** The soffice binary, or null when LibreOffice is not installed. */
export function sofficeBinary() {
  if (cachedBinary !== undefined) return cachedBinary;
  if (process.env.DISCOVERY_OFFICE_IMAGING === 'off') return (cachedBinary = null);
  for (const bin of [process.env.SOFFICE_PATH, 'soffice', 'libreoffice'].filter(Boolean)) {
    try {
      const r = spawnSync(bin, ['--version'], { timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (r.status === 0) return (cachedBinary = bin);
    } catch { /* try the next name */ }
  }
  return (cachedBinary = null);
}

export const officeAvailable = () => sofficeBinary() !== null;

/**
 * Convert a file to PDF with headless LibreOffice.
 * @param {Buffer} buf
 * @param {string} ext  e.g. '.docx', '.html'
 * @returns {Promise<Buffer>}
 */
export async function sofficeToPdf(buf, ext, { timeoutMs = CONVERT_TIMEOUT_MS } = {}) {
  const bin = sofficeBinary();
  if (!bin) throw new Error('LibreOffice is not installed on this machine');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'disc-img-'));
  try {
    const input = path.join(dir, `in${ext}`);
    await fs.writeFile(input, buf);
    // A private profile per call: two conversions sharing the default profile
    // lock each other out, and a crashed one leaves the lock behind.
    const profile = pathToFileURL(path.join(dir, 'profile')).href;
    await new Promise((resolve, reject) => {
      const child = spawn(bin, [
        `-env:UserInstallation=${profile}`,
        '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo',
        '--convert-to', 'pdf', '--outdir', dir, input,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`LibreOffice took longer than ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`LibreOffice exit ${code}: ${err.slice(-300)}`));
      });
    });
    const out = await fs.readFile(path.join(dir, 'in.pdf')).catch(() => null);
    if (!out?.length) throw new Error('LibreOffice produced no PDF');
    return out;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * An email as a printable page: the header block, the body, and the names of
 * its attachments, exactly as lib/eml-extract.mjs reads them (the same text
 * the corpus indexes). Body text is never rewritten.
 * @param {Buffer} buf  the .eml bytes
 * @returns {Promise<string>} a complete HTML document
 */
export async function emailToHtml(buf) {
  const { extractEmlPages } = await import('../eml-extract.mjs');
  const text = (extractEmlPages(buf) ?? []).map((p) => p.text ?? '').join('\n\n');
  const split = text.search(/\r?\n\r?\n/);
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? '' : text.slice(split).replace(/^\s+/, '');
  const rows = head.split(/\r?\n/).filter(Boolean).map((line) => {
    const i = line.indexOf(':');
    return i > 0
      ? `<tr><th>${escapeHtml(line.slice(0, i))}:</th><td>${escapeHtml(line.slice(i + 1).trim())}</td></tr>`
      : `<tr><td colspan="2">${escapeHtml(line)}</td></tr>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: 8.5in 11in; margin: 0.8in; }
body { font-family: 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif; font-size: 10.5pt; }
table { border-collapse: collapse; margin-bottom: 10pt; }
th { text-align: left; vertical-align: top; padding-right: 10pt; white-space: nowrap; }
td { vertical-align: top; }
hr { border: 0; border-top: 1px solid #000; margin: 6pt 0 12pt; }
pre { font-family: inherit; white-space: pre-wrap; word-wrap: break-word; margin: 0; }
</style></head><body><table>${rows}</table><hr><pre>${escapeHtml(body)}</pre></body></html>`;
}

/**
 * Image a Word file or an email. Returns null for any other type.
 * @param {Buffer} buf
 * @param {string} ext
 * @param {{ toPdf?: (buf: Buffer, ext: string) => Promise<Buffer> }} [opts]
 *        the converter; defaults to sofficeToPdf (injectable for tests)
 */
export async function imageOfficeFile(buf, ext, { toPdf = sofficeToPdf } = {}) {
  if (WORD_EXTS.has(ext)) return toPdf(buf, ext);
  if (EMAIL_EXTS.has(ext)) return toPdf(Buffer.from(await emailToHtml(buf), 'utf8'), '.html');
  return null;
}

