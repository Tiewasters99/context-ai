// public.document_citations for the case documents ALREADY in the Vault
// (Brief Desk D2, migration 101).
//
//   node scripts/backfill-document-citations.mjs --dry-run              counts only, writes nothing
//   node scripts/backfill-document-citations.mjs --dry-run --doc <id>   one document
//   node scripts/backfill-document-citations.mjs --apply                every case document
//   node scripts/backfill-document-citations.mjs --apply --doc <id>
//
// ⛔ --apply runs only on Eden's words "approved: backfill document_citations",
// and only after migration 101 is pasted.
//
// New uploads get their rows at ingest (lib/ingest-core.mjs,
// upsertDocumentCitations — this script calls the same function). This pass
// writes ONLY public.document_citations. It reads documents.metadata.westlaw_case
// and, per document, the page keys in passages.metadata; it touches no passage,
// no document, no embedding, no storage object — nothing leaves Postgres and
// no provider is called.
//
// Why it reads passages and is not the "one statement over documents.metadata"
// the spec sketched: each row carries the star level its reporter's pages are
// marked at (printed_page = level 1, star_pages "2"/"3" for a parallel
// reporter), and which level belongs to which reporter is decided by page
// (lib/bluebook.mjs levelsForReporters). documents.metadata.westlaw_pages keeps
// only the first and last page, so the levels are read back from the passages
// (starLevelsFromPassages), the same shape ingest has in hand.
//
// Sealed matters are included: the rows are an index of metadata already in
// the same database, and both resolvers drop a sealed matter from scope at
// aal1 exactly as search does.
//
// Idempotent: a document's rows are deleted and re-inserted from the same
// inputs, so a second --apply writes the same rows. The dry run compares what
// it would write with what is there.
//
// Output is document ids, counts and reporter names — never passage text.
// Needs .env: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { documentCitationRows, starLevelsFromPassages } from '../lib/bluebook.mjs';
import { upsertDocumentCitations } from '../lib/ingest-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const APPLY = args.includes('--apply');
const onlyDoc = args.includes('--doc') ? args[args.indexOf('--doc') + 1] : null;
if (DRY === APPLY) {
  console.error('Say --dry-run or --apply (exactly one). --apply needs Eden\'s "approved: backfill document_citations".');
  process.exit(2);
}

const envFile = process.env.ENV_FILE || path.join(ROOT, '.env');
const env = Object.fromEntries(
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; }),
);
const sb = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const CHUNK = 200;       // documents per page
const PAGE = 1000;       // passages per request (PostgREST's cap)

/** The page keys of one document's summary_level = 0 passages. */
async function passageMetas(documentId) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('passages')
      .select('printed_page:metadata->printed_page, printed_page_end:metadata->printed_page_end, star_pages:metadata->star_pages')
      .eq('document_id', documentId).eq('summary_level', 0)
      .order('id').range(from, from + PAGE - 1);
    if (error) throw new Error(`passages ${documentId}: ${error.message}`);
    out.push(...data);
    if (data.length < PAGE) return out;
  }
}

/** What is in document_citations now for these documents, or null before 101. */
async function existingRows(ids) {
  const { data, error } = await sb.from('document_citations')
    .select('document_id, reporter, volume, page, case_name, star_level').in('document_id', ids);
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return null;
    throw new Error(`document_citations: ${error.message}`);
  }
  return data;
}

const key = (r) => `${r.reporter}|${r.volume}|${r.page}|${r.case_name ?? ''}|${r.star_level ?? ''}`;
const sameRows = (a, b) => a.length === b.length && a.map(key).sort().join('\n') === b.map(key).sort().join('\n');

const totals = { documents: 0, with_reporters: 0, rows: 0, star_level_null: 0, unchanged: 0, would_change: 0, written: 0, failed: 0 };
const byReporter = new Map();
let tableAbsent = false;
let after = null;

for (;;) {
  let q = sb.from('documents')
    .select('id, westlaw_case:metadata->westlaw_case')
    .eq('metadata->westlaw_case->>kind', 'case')
    .order('id').limit(CHUNK);
  if (onlyDoc) q = q.eq('id', onlyDoc);
  else if (after) q = q.gt('id', after);
  const { data: docs, error } = await q;
  if (error) throw new Error(`documents: ${error.message}`);
  if (!docs.length) break;
  after = docs[docs.length - 1].id;

  const existing = await existingRows(docs.map((d) => d.id));
  if (existing === null) tableAbsent = true;

  for (const d of docs) {
    totals.documents += 1;
    const hasReporters = Array.isArray(d.westlaw_case?.reporters) && d.westlaw_case.reporters.length > 0;
    const levels = hasReporters ? starLevelsFromPassages(await passageMetas(d.id)) : {};
    const rows = documentCitationRows(d.westlaw_case, levels);
    if (rows.length) totals.with_reporters += 1;
    totals.rows += rows.length;
    for (const r of rows) {
      if (r.star_level === null) totals.star_level_null += 1;
      byReporter.set(r.reporter, (byReporter.get(r.reporter) || 0) + 1);
    }
    const have = (existing || []).filter((e) => e.document_id === d.id);
    if (sameRows(have, rows)) { totals.unchanged += 1; continue; }
    totals.would_change += 1;
    if (DRY) continue;
    try {
      const r = await upsertDocumentCitations(sb, d.id, d.westlaw_case, levels);
      if (r.skipped) { console.error(`stopped: ${r.skipped}`); process.exit(1); }
      totals.written += 1;
    } catch (err) {
      totals.failed += 1;
      console.error(`  ${d.id}: ${err.message}`);
    }
  }
  process.stdout.write(`  … ${totals.documents} documents\n`);
  if (onlyDoc || docs.length < CHUNK) break;
}

console.log(`\n${DRY ? 'DRY RUN — nothing written' : 'APPLIED'}${tableAbsent ? ' (document_citations is absent: migration 101 not applied yet)' : ''}`);
console.log(JSON.stringify(totals, null, 2));
console.log('rows by reporter:', Object.fromEntries([...byReporter].sort((a, b) => b[1] - a[1])));
if (totals.failed) process.exit(1);
