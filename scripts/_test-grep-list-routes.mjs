// grep's three routes and list_matter_contents paging — offline.
//   node scripts/_test-grep-list-routes.mjs
//
// The DeCamara brief (2026-09-24): grep over the 53,734-passage matter tree
// timed out every time, and the listing stopped at 1,000 of 6,977 documents
// without saying so.
import assert from 'node:assert/strict';
import { grepCandidates, handleListMatterContents } from '../lib/mcp-core.mjs';

let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };

// A stand-in that records which filters each query used.
function stub(tables) {
  const calls = [];
  return {
    calls,
    from(table) {
      const st = { table, filters: [], order: [], range: null, count: false };
      const rows = () => {
        let r = (tables[table] || []).map((x) => ({ ...x }));
        for (const [col, val, kind] of st.filters) {
          if (kind === 'in') r = r.filter((x) => val.includes(x[col]));
          else if (kind === 'eq') r = r.filter((x) => x[col] === val);
          else if (kind === 'ilike') { const s = String(val).replace(/^%|%$/g, '').toLowerCase(); r = r.filter((x) => String(x[col]).toLowerCase().includes(s)); }
          else if (kind === 'imatch') { const re = new RegExp(val, 'i'); r = r.filter((x) => re.test(String(x[col]))); }
          else if (kind === 'fts') { const words = String(val).toLowerCase().split(/\s+/); r = r.filter((x) => words.every((w) => String(x[col]).toLowerCase().includes(w))); }
        }
        for (const [col, asc] of [...st.order].reverse()) r.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
        const total = r.length;
        if (st.range) r = r.slice(st.range[0], st.range[1] + 1);
        return { r, total };
      };
      const b = {
        select(_c, o = {}) { st.count = !!o.count; return b; },
        eq(c, v) { st.filters.push([c, v, 'eq']); return b; },
        in(c, v) { st.filters.push([c, v, 'in']); return b; },
        ilike(c, v) { st.filters.push([c, v, 'ilike']); return b; },
        like(c, v) { st.filters.push([c, v, 'ilike']); return b; },
        filter(c, op, v) { st.filters.push([c, v, op]); return b; },
        textSearch(c, v) { st.filters.push(['text', v, 'fts']); return b; },
        order(c, o = {}) { st.order.push([c, o.ascending !== false]); return b; },
        range(a, z) { st.range = [a, z]; return b; },
        limit() { return b; },
        maybeSingle() { return Promise.resolve({ data: rows().r[0] ?? null, error: null }); },
        then(res, rej) {
          calls.push({ table, kinds: st.filters.map((f) => f[2]) });
          const { r, total } = rows();
          return Promise.resolve({ data: r, error: null, count: st.count ? total : null }).then(res, rej);
        },
      };
      return b;
    },
  };
}

const passages = [
  { id: 'p1', document_id: 'd1', matterspace_id: 'm1', sequence_number: 0, summary_level: 0, page_start: 1, page_end: 1, line_start: null, text: 'The court need consider only the cited materials.' },
  { id: 'p2', document_id: 'd2', matterspace_id: 'm1', sequence_number: 0, summary_level: 0, page_start: 1, page_end: 1, line_start: null, text: 'No genuine dispute as to any material fact.' },
];
const documents = Array.from({ length: 2500 }, (_, i) => ({ id: `d${i + 1}`, matterspace_id: 'm1', title: `Doc ${String(i + 1).padStart(4, '0')}`, doc_type: 'other', created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z` }));

// 1. A literal with words goes through the full-text index, and ILIKE confirms.
{
  const sb = stub({ passages, documents });
  const r = await grepCandidates(sb, { matterIds: ['m1'], pattern: 'cited materials', useRegex: false, caseSensitive: false });
  assert.equal(r.scan.method, 'index');
  assert.deepEqual(r.candidates.map((p) => p.id), ['p1']);
  assert(sb.calls.some((c) => c.table === 'passages' && c.kinds.includes('fts') && c.kinds.includes('ilike')));
  ok('a literal with words is answered from the full-text index, confirmed by ILIKE');
}

// 2. A regex — or a fragment the index cannot hold — scans documents in batches.
{
  const sb = stub({ passages, documents });
  const r = await grepCandidates(sb, { matterIds: ['m1'], pattern: 'genuine\\s+dispute', useRegex: true, caseSensitive: false });
  assert.equal(r.scan.method, 'scan');
  assert.deepEqual(r.candidates.map((p) => p.id), ['p2']);
  assert.equal(r.scan.documents_total, 2500);
  assert.equal(r.scan.documents_scanned, 2500);
  assert.equal(r.scan.incomplete, false);
  assert(sb.calls.filter((c) => c.table === 'passages' && c.kinds.includes('in')).length > 1, 'more than one document batch');
  const frag = await grepCandidates(stub({ passages, documents }), { matterIds: ['m1'], pattern: 'materia', useRegex: false, caseSensitive: false });
  assert.deepEqual(frag.candidates.map((p) => p.id).sort(), ['p1', 'p2'], 'a fragment still found (index misses, scan finds)');
  ok('a regex, or a word fragment, scans every document in batches and says it was complete');
}

// 3. The listing pages through all of a large matter, with the true total.
{
  const sb = stub({ documents, matterspaces: [{ id: 'm1', short_code: 'big', name: 'Big', description: null }] });
  const first = await handleListMatterContents(sb, { matter: 'big' });
  assert.equal(first.document_count, 2500, 'the true total, not the page size');
  assert.equal(first.returned, 1000);
  assert.equal(first.next_offset, 1000);
  const seen = new Set();
  let off = 0;
  while (off !== null) {
    const r = await handleListMatterContents(sb, { matter: 'big', offset: off, sort: 'title' });
    for (const d of r.others ?? r.other ?? Object.values(r).find(Array.isArray) ?? []) seen.add(d.id);
    off = r.next_offset;
  }
  assert.equal(seen.size, 2500, 'every document, once');
  ok('list_matter_contents pages through 2,500 documents with the true total and next_offset');
}

console.log(`\nPASS (${n} checks)`);
