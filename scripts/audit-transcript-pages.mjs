// READ-ONLY audit: which transcripts are cited by the reporter's PRINTED page
// and which are still cited by the PDF's page INDEX.
//
// Why this exists (recorded 2026-09-19): every full-size transcript in the
// corpus was indexed with page_start = the PDF's page index. On a clean PDF
// the two agree by luck; on an exhibit-wrapped copy every cite in the document
// is one page high, and on a printed-out text file the number means nothing at
// all. A cite that is off by one is far more dangerous than one that is
// obviously broken, because it reads like a real cite and gets typed into a
// brief.
//
// This script answers three questions per document:
//   1. What does the detector make of it — mapping, confidence, and why?
//   2. Is the claim on the row (documents.metadata.transcript_pages) current?
//   3. If this document were re-indexed today, HOW MANY of its citations
//      would change, and by how much?
//
// It never prints a word of transcript text. Ids, page numbers, counts and
// the detector's own reason, and nothing else.
//
//   node scripts/audit-transcript-pages.mjs --fixture <file.json>
//       Run the detector over page text held in a local JSON file. This is the
//       offline mode: no network, no database, no credentials.
//       { "documents": [ { "id": "...", "pages": [ { "pageNumber": 1, "text": "..." } ] } ] }
//
//   node scripts/audit-transcript-pages.mjs --passages <file.json>
//       Report over passages already parsed, without re-parsing anything.
//       { "documents": [ { "id": "...", "page_count": 172,
//                          "transcript_pages": { ...the recorded verdict... },
//                          "passages": [ { "id": "...", "page_start": 16,
//                                          "metadata": { "printed_page": 15 } } ] } ] }
//
//   node scripts/audit-transcript-pages.mjs --db [--matter <short_code>] [--limit N]
//       The same report read from the live database. Reads only
//       documents.metadata.transcript_pages and the passages' own coordinates
//       — it does NOT re-parse any file and does not select passage text.
//       Requires VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env, and
//       the explicit --db flag. Eden runs this one; nothing else should.
//
// Nothing is ever written.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chunkPages, analyzeTranscriptPages } from '../lib/ingest-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const shortId = (id) => String(id ?? '').slice(0, 8) || '(no id)';
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);

function offsetsOf(verdict) {
  if (!verdict?.segments?.length) return '—';
  return verdict.segments
    .map((s) => `${s.from_pdf}–${s.to_pdf}:${s.offset >= 0 ? '+' : ''}${s.offset}`)
    .join(' ');
}

// ---- report rows -------------------------------------------------------------

function rowFromVerdict(id, verdict, { citations = null, changing = null, maxShift = null } = {}) {
  return {
    id: shortId(id),
    transcript: verdict.is_transcript,
    method: verdict.method,
    confidence: verdict.confidence,
    claimed: verdict.claimed,
    pages: verdict.pages_total,
    transcript_pages: verdict.transcript_pages,
    evidence: verdict.evidence_pages,
    mapped: verdict.mapped_pages,
    offsets: offsetsOf(verdict),
    citations,
    changing,
    maxShift,
    reason: verdict.reason,
  };
}

function print(rows) {
  const head = ['document', 'method', 'conf', 'claim', 'pp', 'tx', 'evid', 'mapd', 'cites', 'change', 'offsets'];
  const w = [10, 17, 7, 6, 5, 5, 5, 5, 6, 7, 28];
  console.log(head.map((h, i) => pad(h, w[i])).join(' '));
  console.log(w.map((n) => '-'.repeat(n)).join(' '));
  for (const r of rows) {
    console.log([
      pad(r.id, w[0]), pad(r.method, w[1]), pad(r.confidence, w[2]),
      pad(r.claimed ? 'yes' : 'no', w[3]),
      padL(r.pages ?? '—', w[4]), padL(r.transcript_pages ?? '—', w[5]),
      padL(r.evidence ?? '—', w[6]), padL(r.mapped ?? '—', w[7]),
      padL(r.citations ?? '—', w[8]), padL(r.changing ?? '—', w[9]),
      pad(r.offsets, w[10]),
    ].join(' '));
    if (r.reason) console.log(`${' '.repeat(2)}${r.reason}`);
    if (r.maxShift) console.log(`${' '.repeat(2)}largest shift: ${r.maxShift} page(s)`);
  }

  const transcripts = rows.filter((r) => r.transcript);
  const byIndex = transcripts.filter((r) => !r.claimed);
  const changing = rows.reduce((s, r) => s + (r.changing || 0), 0);
  console.log('');
  console.log(`documents            ${rows.length}`);
  console.log(`read as transcripts  ${transcripts.length}`);
  console.log(`cite the printed pg  ${transcripts.length - byIndex.length}`);
  console.log(`cite the PDF index   ${byIndex.length}${byIndex.length ? `  (${byIndex.map((r) => r.id).join(', ')})` : ''}`);
  console.log(`citations that would change if re-indexed today: ${changing}`);
}

// ---- modes -------------------------------------------------------------------

// Page text in hand: run the real detector and the real chunker, and count how
// many of the passages the chunker produces would cite a different page.
export function auditFixture(doc) {
  const pages = (doc.pages || []).map((p, i) => ({ pageNumber: p.pageNumber ?? i + 1, text: p.text ?? '' }));
  const verdict = analyzeTranscriptPages(pages);
  const passages = chunkPages(pages, { witness_name: doc.witness_name || null });
  let changing = 0;
  let maxShift = 0;
  for (const p of passages) {
    const printed = p.metadata?.printed_page;
    if (typeof printed !== 'number') continue;
    if (printed !== p.page_start) {
      changing += 1;
      maxShift = Math.max(maxShift, Math.abs(printed - p.page_start));
    }
  }
  return rowFromVerdict(doc.id, verdict, { citations: passages.length, changing, maxShift: maxShift || null });
}

// Passages already parsed: nothing is re-parsed. The recorded verdict on the
// document is the source of truth, exactly as item 3 of the build intended —
// "so a later audit can list 'transcripts cited by PDF index' without
// re-parsing".
export function auditParsed(doc) {
  const recorded = doc.transcript_pages || doc.metadata?.transcript_pages || null;
  const passages = doc.passages || [];
  const verdict = recorded || {
    is_transcript: passages.some((p) => p.metadata?.page_source || p.line_start != null),
    method: 'none', confidence: 'none', claimed: false,
    pages_total: doc.page_count ?? null, transcript_pages: null,
    evidence_pages: null, mapped_pages: null, segments: [],
    reason: 'no printed-page verdict on this document — indexed before the detector existed',
  };
  let changing = 0;
  let maxShift = 0;
  for (const p of passages) {
    const printed = p.metadata?.printed_page;
    if (typeof printed !== 'number') continue;
    if (printed !== p.page_start) {
      changing += 1;
      maxShift = Math.max(maxShift, Math.abs(printed - p.page_start));
    }
  }
  return rowFromVerdict(doc.id, verdict, { citations: passages.length, changing, maxShift: maxShift || null });
}

// ---- the live database (Eden only) -------------------------------------------

async function loadEnv(file) {
  const out = {};
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

async function auditDatabase({ matter, limit }) {
  const env = await loadEnv(path.resolve(__dirname, '..', '.env'));
  const U = env.VITE_SUPABASE_URL;
  const K = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!U || !K) throw new Error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env');
  const H = { apikey: K, authorization: `Bearer ${K}` };
  const get = async (pathAndQuery) => {
    const res = await fetch(`${U}/rest/v1/${pathAndQuery}`, { headers: H });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  };

  let q = 'documents?select=id,page_count,metadata,matterspace_id&processing_status=eq.ready'
    + `&order=id&limit=${limit}`;
  if (matter) {
    const [m] = await get(`matterspaces?select=id&short_code=eq.${encodeURIComponent(matter)}&limit=1`);
    if (!m) throw new Error(`no matter with short_code ${matter}`);
    q += `&matterspace_id=eq.${m.id}`;
  }
  const docs = await get(q);
  // A silent truncation would read as "and that is all of them", which is the
  // failure mode this whole lane exists to prevent.
  if (docs.length >= limit) {
    console.log(`NOTE: showing the first ${limit} ready documents only (--limit). Raise --limit or narrow with --matter.\n`);
  }
  const rows = [];
  for (const d of docs) {
    const recorded = d.metadata?.transcript_pages || null;
    // Only transcripts are interesting, and only their coordinates are read —
    // never `text`.
    const passages = await get(
      `passages?select=id,page_start,metadata&document_id=eq.${d.id}&summary_level=eq.0&order=sequence_number&limit=5000`);
    const looksTranscript = recorded?.is_transcript || passages.some((p) => p.metadata?.page_source);
    if (!looksTranscript) continue;
    rows.push(auditParsed({ id: d.id, page_count: d.page_count, transcript_pages: recorded, passages }));
  }
  return rows;
}

// ---- main ---------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const fixture = arg('--fixture');
  const parsed = arg('--passages');
  const db = argv.includes('--db');

  if (!fixture && !parsed && !db) {
    console.log(`Usage:
  node scripts/audit-transcript-pages.mjs --fixture <file.json>     page text, offline
  node scripts/audit-transcript-pages.mjs --passages <file.json>    parsed passages, offline
  node scripts/audit-transcript-pages.mjs --db [--matter <code>] [--limit N]

Reports, per document: the printed-page mapping the detector finds, its
confidence and reason, and how many of that document's citations would change
if it were re-indexed today. No transcript text is printed and nothing is
written.`);
    return;
  }

  let rows;
  if (fixture) {
    const data = JSON.parse(await fs.readFile(path.resolve(fixture), 'utf8'));
    rows = (data.documents || []).map(auditFixture);
  } else if (parsed) {
    const data = JSON.parse(await fs.readFile(path.resolve(parsed), 'utf8'));
    rows = (data.documents || []).map(auditParsed);
  } else {
    console.log('Reading the live database, read-only. Nothing is written and no text is selected.\n');
    rows = await auditDatabase({ matter: arg('--matter'), limit: Number(arg('--limit') || 500) });
  }
  print(rows);
}

// Run only when invoked directly — the offline harness imports auditFixture /
// auditParsed to prove the report without a database.
const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
