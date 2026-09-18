// READ-ONLY audit: documents whose indexed text is nothing but court filing
// stamps — the scanned page that was indexed as its header line and never
// OCR'd (2026-09-18: ECF 53 and ECF 58 in decamara-v-bryn-mawr, ingested
// 2026-05-25, "ready" with one passage each reading only
// "Case 2:25-cv-02287-MAK  Document 53  Filed 02/25/26  Page 1 of 2").
//
// Why a separate audit: ready_but_empty() (migration 059), the monitor and
// the 2026-08-22 audit all look for ZERO passages. A stamp-only document has
// one passage per page — the stamp — so every one of them reads as healthy.
//
// What it reports, per matter:
//   STAMP_ONLY  every passage of the document is stamp lines and nothing else
//               (the whole document was a scan that was never OCR'd)
//   PARTIAL     some pages of an otherwise-indexed document are stamp lines
//               only (scanned exhibit pages lost by the pre-2026-09-04
//               document-wide OCR rule)
// and, for each, the page count the stamps themselves claim ("Page 1 of 7")
// beside the stored page_count.
//
// Nothing is written to the database, nothing is re-queued. The list goes to
// a JSON + CSV file OUTSIDE the repo (document titles are client data).
//
//   node scripts/audit-stamp-only.mjs [--out DIR] [--matter short_code|uuid]
//
// Method: documents are listed page by page (PostgREST silently caps a
// response at 1,000 rows — every list here pages), then their passages are
// probed in batches of document ids with a server-side regex that only
// accepts a passage made entirely of stamp-looking lines, so the full text
// of the index never crosses the wire. Each hit is then confirmed here with
// the stricter isStampOnlyText() from lib/court-stamps.mjs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isStampOnlyText, stampedPageCount } from '../lib/court-stamps.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- stamp recognition --------------------------------------------------------

// What counts as a stamp lives in lib/court-stamps.mjs, shared with the
// pipeline. The prefilter below only narrows what crosses the wire: the whole
// passage is one or more lines that start the way a stamp line starts
// (Postgres ARE, case-insensitive). Loose on purpose; isStampOnlyText decides.
export const PREFILTER_REGEX = String.raw`^\s*((case|usca|appellate case|filed|nyscef|document|doc|dkt|page|entered|date filed|received|desc|index no)[^\n]{0,240}\s*)+$`;

// ---- the audit --------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const outDir = arg('--out') || path.resolve(__dirname, '..', '..', 'context-ai-scratch', 'ingestion-diagnostics');
  const onlyMatter = arg('--matter');

  const env = await loadEnv(path.resolve(__dirname, '..', '.env'));
  const U = env.VITE_SUPABASE_URL;
  const K = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!U || !K) throw new Error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env');
  const H = { apikey: K, authorization: `Bearer ${K}` };

  const get = async (p, { attempts = 4 } = {}) => {
    for (let a = 1; ; a++) {
      const r = await fetch(`${U}/rest/v1/${p}`, { headers: H });
      const t = await r.text();
      if (r.ok) return JSON.parse(t);
      if (a >= attempts) throw new Error(`${r.status} ${p.slice(0, 120)}: ${t.slice(0, 300)}`);
      await new Promise((res) => setTimeout(res, 1500 * a));
    }
  };
  const count = async (p) => {
    const r = await fetch(`${U}/rest/v1/${p}`, { method: 'HEAD', headers: { ...H, prefer: 'count=exact' } });
    const range = r.headers.get('content-range') || '';
    const n = Number(range.split('/')[1]);
    if (!r.ok || !Number.isFinite(n)) throw new Error(`count ${r.status} ${p.slice(0, 120)}`);
    return n;
  };
  const pageAll = async (base, order = 'id') => {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const rows = await get(`${base}&order=${order}&limit=1000&offset=${offset}`);
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  };

  const started = new Date();
  const matters = await pageAll('matterspaces?select=id,short_code,name');
  const matterById = new Map(matters.map((m) => [m.id, m]));
  let docFilter = '';
  if (onlyMatter) {
    const m = matters.find((x) => x.id === onlyMatter || x.short_code === onlyMatter);
    if (!m) throw new Error(`matter not found: ${onlyMatter}`);
    docFilter = `&matterspace_id=eq.${m.id}`;
  }
  const docs = await pageAll(`documents?select=id,matterspace_id,title,source_filename,page_count,processing_status,created_at,ingested_at,text_status:metadata->>text_status${docFilter}`);
  console.log(`${docs.length} documents across ${new Set(docs.map((d) => d.matterspace_id)).size} matters; probing passages…`);

  // Stamp-only passages, by document.
  const hits = new Map(); // document_id -> [{page_start, text}]
  const BATCH = 120;
  const rx = encodeURIComponent(PREFILTER_REGEX);
  for (let i = 0; i < docs.length; i += BATCH) {
    const ids = docs.slice(i, i + BATCH).map((d) => d.id);
    const rows = await pageAll(`passages?select=id,document_id,page_start,page_end,text&document_id=in.(${ids.join(',')})&text=imatch.${rx}`);
    for (const p of rows) {
      if (!isStampOnlyText(p.text)) continue;
      if (!hits.has(p.document_id)) hits.set(p.document_id, []);
      hits.get(p.document_id).push(p);
    }
    if ((i / BATCH) % 20 === 0) process.stdout.write(`  ${Math.min(i + BATCH, docs.length)}/${docs.length}\r`);
  }
  console.log(`\n${hits.size} document(s) carry at least one stamp-only passage; classifying…`);

  const docById = new Map(docs.map((d) => [d.id, d]));
  const findings = [];
  for (const [docId, stampPassages] of hits) {
    const d = docById.get(docId);
    const total = await count(`passages?select=id&document_id=eq.${docId}`);
    // A page is stamp-only when EVERY passage covering it is stamp lines. The
    // chunker can split a page into a content passage and a stamp passage
    // (a screenshot page with its own text layer, 26-2098_Documents p. 675):
    // that page was read, and counting it would call a healthy page lost.
    const stampIds = new Set(stampPassages.map((p) => p.id));
    let stampPages = [...new Set(stampPassages.map((p) => p.page_start))].sort((a, b) => a - b);
    if (stampPassages.length < total) {
      const spans = await pageAll(`passages?select=id,page_start,page_end&document_id=eq.${docId}`);
      stampPages = stampPages.filter((n) => spans
        .filter((s) => s.page_start <= n && (s.page_end ?? s.page_start) >= n)
        .every((s) => stampIds.has(s.id)));
    }
    if (!stampPages.length) continue;
    const claimed = Math.max(0, ...stampPassages.map((p) => stampedPageCount(p.text) || 0)) || null;
    const m = matterById.get(d.matterspace_id) || {};
    findings.push({
      class: stampPassages.length === total ? 'STAMP_ONLY' : 'PARTIAL',
      matter: m.short_code || d.matterspace_id,
      matter_name: m.name || null,
      document_id: docId,
      title: d.title,
      source_filename: d.source_filename,
      processing_status: d.processing_status,
      text_status: d.text_status || null,
      stored_page_count: d.page_count,
      stamped_page_count: claimed,
      page_count_wrong: claimed != null && d.page_count != null && claimed !== d.page_count && stampPassages.length === total,
      passages_total: total,
      passages_stamp_only: stampPassages.length,
      stamp_only_pages: stampPages,
      created_at: d.created_at,
      ingested_at: d.ingested_at,
      sample: stampPassages[0].text.replace(/\s+/g, ' ').slice(0, 140),
    });
  }
  findings.sort((a, b) => (a.class === b.class ? 0 : a.class === 'STAMP_ONLY' ? -1 : 1) || a.matter.localeCompare(b.matter) || String(a.title).localeCompare(String(b.title)));

  // Per matter.
  const byMatter = new Map();
  for (const f of findings) {
    const k = f.matter;
    if (!byMatter.has(k)) byMatter.set(k, { matter: k, matter_name: f.matter_name, stamp_only: 0, partial: 0, partial_pages: 0, page_count_wrong: 0 });
    const r = byMatter.get(k);
    if (f.class === 'STAMP_ONLY') r.stamp_only++; else { r.partial++; r.partial_pages += f.stamp_only_pages.length; }
    if (f.page_count_wrong) r.page_count_wrong++;
  }
  const summary = [...byMatter.values()].sort((a, b) => b.stamp_only - a.stamp_only || b.partial - a.partial);

  await fs.mkdir(outDir, { recursive: true });
  const stamp = started.toISOString().slice(0, 10);
  const jsonPath = path.join(outDir, `stamp-only-audit-${stamp}.json`);
  const csvPath = path.join(outDir, `stamp-only-audit-${stamp}.csv`);
  await fs.writeFile(jsonPath, JSON.stringify({ run_at: started.toISOString(), documents_scanned: docs.length, summary, findings }, null, 2));
  const cols = ['class', 'matter', 'document_id', 'title', 'source_filename', 'processing_status', 'stored_page_count', 'stamped_page_count', 'passages_total', 'passages_stamp_only', 'stamp_only_pages', 'created_at', 'ingested_at', 'sample'];
  const esc = (v) => { const s = Array.isArray(v) ? v.join(' ') : v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  await fs.writeFile(csvPath, [cols.join(','), ...findings.map((f) => cols.map((c) => esc(f[c])).join(','))].join('\n'));

  console.log(`\nBy matter (${findings.filter((f) => f.class === 'STAMP_ONLY').length} stamp-only documents, ${findings.filter((f) => f.class === 'PARTIAL').length} partial):`);
  console.log('  matter'.padEnd(46) + 'stamp_only  partial(pages)  page_count_wrong');
  for (const r of summary) console.log(`  ${r.matter.padEnd(44)}${String(r.stamp_only).padStart(10)}  ${String(r.partial).padStart(7)}(${r.partial_pages})${String(r.page_count_wrong).padStart(18)}`);
  console.log(`\nList: ${csvPath}\n      ${jsonPath}`);
}

async function loadEnv(file) {
  const out = { ...process.env };
  try {
    const txt = await fs.readFile(file, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.replace(/^﻿/, '').match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* env from the process only */ }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
}
