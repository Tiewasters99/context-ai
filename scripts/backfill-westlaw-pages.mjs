// Westlaw star pages for the documents ALREADY in the Vault.
//
//   node scripts/backfill-westlaw-pages.mjs                 dry run: counts only, writes nothing
//   node scripts/backfill-westlaw-pages.mjs --doc <id>      dry run for one document
//   node scripts/backfill-westlaw-pages.mjs --apply --doc <id>
//   node scripts/backfill-westlaw-pages.mjs --apply --all
//
// New uploads get their star pages at ingest (lib/ingest-core.mjs). This is
// the one-time pass for what was indexed before 2026-09-23. It changes ONE
// thing: it merges the page keys lib/cite-page.mjs reads into
// passages.metadata. Passage text, embeddings and ids are untouched — nothing
// is re-embedded (no provider call, no cost), and everything that points at a
// passage (Bucketizer outlines, annotations) keeps pointing at the same row.
//
// Skipped, always:
//   - sealed matters (ai_tier B/C, and everything filed under one). Nothing
//     leaves the database here, but a sealed matter is Eden's call by name.
//   - a passage that already carries a printed page from another detector
//     (the transcript one): that page was measured, this one would be too,
//     and two measurements are not merged here.
//
// Output is document ids, counts and page ranges — never passage text.
// Needs .env: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and
// SUPABASE_ACCESS_TOKEN (for the one candidate query; the rest is PostgREST).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { westlawStarPages, westlawPageMeta, METHOD } from '../lib/westlaw-pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = process.env.ENV_FILE || path.join(ROOT, '.env');
const env = Object.fromEntries(
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; }),
);
const URL_ = env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const PAT = env.SUPABASE_ACCESS_TOKEN;
const REF = new URL(URL_).hostname.split('.')[0];

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALL = args.includes('--all');
const onlyDoc = args.includes('--doc') ? args[args.indexOf('--doc') + 1] : null;
if (APPLY && !ALL && !onlyDoc) {
  console.error('--apply needs --doc <id> or --all');
  process.exit(2);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`sql ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function rest(pathAndQuery, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`${URL_}/rest/v1/${pathAndQuery}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
    if (r.ok) return r.status === 204 ? null : r.json();
    if (attempt >= 4 || r.status < 500) throw new Error(`${init.method || 'GET'} ${pathAndQuery.slice(0, 60)} → ${r.status} ${(await r.text()).slice(0, 200)}`);
    await new Promise((res) => setTimeout(res, 500 * attempt));
  }
}

// Every Westlaw delivery outside a sealed matter (or one named document).
async function candidates() {
  const docFilter = onlyDoc ? `and d.id = '${onlyDoc.replace(/[^0-9a-f-]/gi, '')}'` : '';
  return sql(`
    with recursive sealed as (
      select id from matterspaces where ai_tier in ('B','C')
      union
      select m.id from matterspaces m join sealed s on m.parent_matterspace_id = s.id
    ),
    w as (
      select distinct document_id from passages
      where summary_level = 0 and text ilike '%no claim to original u.s. government works%'
    )
    select d.id, lower(substring(d.source_filename from '\\.([A-Za-z0-9]+)$')) as ext,
           d.matterspace_id, (d.matterspace_id in (select id from sealed)) as sealed
    from w join documents d on d.id = w.document_id
    where true ${docFilter}
    order by d.id`);
}

async function passagesOf(docId) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const page = await rest(
      `passages?document_id=eq.${docId}&summary_level=eq.0&select=id,sequence_number,page_start,metadata,text` +
      `&order=sequence_number.asc,id.asc&offset=${from}&limit=1000`,
    );
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// Which reason a declined document falls under, for the tally.
const reasonKey = (r) => r.claimed ? 'claimed'
  : /no star pages/.test(r.reason) ? 'declined: no star pages'
  : /restart/.test(r.reason) ? 'declined: pagination restarts'
  : /stray/.test(r.reason) ? 'declined: more stray numbers than markers'
  : `declined: ${r.reason}`;

const tally = {};
const byExt = {};
const report = [];
let toWrite = 0;
let written = 0;
let keptOther = 0;

const docs = await candidates();
console.log(`${docs.length} Westlaw document(s)${onlyDoc ? ' (one named)' : ''}; ${APPLY ? 'APPLYING' : 'dry run — nothing is written'}`);

for (const d of docs) {
  if (d.sealed) {
    tally['skipped: sealed matter'] = (tally['skipped: sealed matter'] || 0) + 1;
    report.push({ id: d.id, ext: d.ext, outcome: 'skipped: sealed matter' });
    continue;
  }
  const rows = await passagesOf(d.id);
  const r = westlawStarPages(rows);
  const key = reasonKey(r);
  tally[key] = (tally[key] || 0) + 1;
  byExt[d.ext] ??= { docs: 0, claimed: 0 };
  byExt[d.ext].docs++;
  if (r.claimed) byExt[d.ext].claimed++;

  const patches = [];
  if (r.claimed) {
    rows.forEach((row, i) => {
      const meta = westlawPageMeta(r.pages[i], row.page_start);
      if (!meta) return;
      const cur = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      // A page another detector measured is left as it is.
      if (cur.printed_page != null && cur.printed_page_method !== METHOD) { keptOther++; return; }
      if (cur.printed_page === meta.printed_page && cur.printed_page_end === meta.printed_page_end &&
          cur.printed_page_method === METHOD) return;   // already written
      patches.push({ id: row.id, metadata: { ...cur, ...meta } });
    });
  }
  toWrite += patches.length;
  report.push({
    id: d.id, ext: d.ext, outcome: key, passages: rows.length,
    paged: r.pages.filter(Boolean).length, first: r.first, last: r.last,
    markers: r.markers, skipped_cites: (r.rejected || 0) + (r.skipped || 0), to_write: patches.length,
  });

  if (APPLY && patches.length) {
    // Eight at a time: one PATCH per passage, merged metadata as read above.
    for (let k = 0; k < patches.length; k += 8) {
      await Promise.all(patches.slice(k, k + 8).map((p) =>
        rest(`passages?id=eq.${p.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ metadata: p.metadata }),
        })));
      written += Math.min(8, patches.length - k);
    }
  }
}

const outFile = path.join(ROOT, `westlaw-pages-${APPLY ? 'applied' : 'dryrun'}-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), apply: APPLY, tally, byExt, report }, null, 2));

console.log('\nBy outcome:');
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log('\nBy format (claimed / documents):');
for (const [k, v] of Object.entries(byExt).sort((a, b) => b[1].docs - a[1].docs)) console.log(`  .${k.padEnd(5)} ${v.claimed} / ${v.docs}`);
console.log(`\nPassages that would get a page: ${toWrite.toLocaleString()}${APPLY ? ` — written: ${written.toLocaleString()}` : ''}`);
if (keptOther) console.log(`Passages left alone (a printed page from another detector): ${keptOther}`);
console.log(`Per-document report (ids and numbers only): ${outFile}`);
