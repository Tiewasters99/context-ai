// Local receiver for browser-side PACER downloads.
//
//   node scripts/_docket-bridge.mjs <outputDir> [port]
//
// The CM/ECF page fetches each PDF in its own context (so it carries the
// PACER session cookies) and POSTs the bytes here. Writing from Node instead
// of a.download avoids Chrome's multiple-automatic-downloads block and lets
// the runner report per-file success.
//
// http://localhost is a "potentially trustworthy origin", so an HTTPS page may
// call it without mixed-content blocking; the PNA header below satisfies
// Chrome's private-network preflight.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR = process.argv[2] || path.resolve('docket-out');
const PORT = Number(process.argv[3] || 8787);

await fs.mkdir(OUT_DIR, { recursive: true });

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// Strip anything the filesystem or a shell would choke on.
function safeName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180) || 'unnamed';
}

let written = 0;
let bytesTotal = 0;

const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, outDir: OUT_DIR, written, bytesTotal }));
  }

  // Report which files are already on disk so a re-run skips them (no re-billing).
  if (url.pathname === '/have') {
    let names = [];
    try { names = await fs.readdir(OUT_DIR); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, names }));
  }

  if (url.pathname === '/save' && req.method === 'POST') {
    const name = safeName(url.searchParams.get('name') || '');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const buf = Buffer.concat(chunks);
        const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
        const target = path.join(OUT_DIR, name);
        await fs.writeFile(target, buf);
        written++; bytesTotal += buf.length;
        console.log(
          `[${String(written).padStart(3)}] ${isPdf ? 'PDF ' : 'RAW '} ` +
          `${(buf.length / 1024).toFixed(0).padStart(6)} KB  ${name}`
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, bytes: buf.length, isPdf }));
      } catch (err) {
        console.log(`WRITE ERROR ${name}: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`docket-bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`writing to ${OUT_DIR}`);
});
