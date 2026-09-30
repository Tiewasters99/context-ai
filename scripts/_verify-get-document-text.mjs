// get_document_text (lib/mcp-core.mjs handleGetDocumentText) — driven with an
// in-memory PostgREST-shaped client, no database, no network.
//
// What it proves
// ---------------------------------------------------------------------------
//   ORDER   passages come back in sequence order, summary_level 0 only, with
//           page and line coordinates and the full text.
//   BUDGET  the character budget is honoured, at least one passage is always
//           returned, and next_offset points at the first passage not sent;
//           the last call returns next_offset null and no "more".
//   SHAPE   document header, matter id (for the GPT envelope), passage_count,
//           returned, text_chars; a not-yet-indexed document says so.
//   TOOLS   the tool is listed, dispatched by callTool's switch, classed as a
//           read by the meter, and exposed as getDocumentText by the GPT.
//
//   node scripts/_verify-get-document-text.mjs

process.env.VITE_SUPABASE_URL ||= 'https://stub.supabase.test';
process.env.VITE_SUPABASE_ANON_KEY ||= 'stub-anon';

let failures = 0; let passes = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + String(detail).slice(0, 160) : ''}`);
  if (ok) passes += 1; else failures += 1;
};

const { handleGetDocumentText, TOOLS, DOCUMENT_TEXT_MAX_CHARS } = await import('../lib/mcp-core.mjs');
const { toolClass } = await import('../lib/connector-meter.mjs');
const { OPS } = await import('../lib/gpt-ops.mjs');
const src = (await import('node:fs')).readFileSync(new URL('../lib/mcp-core.mjs', import.meta.url), 'utf8');

// A PostgREST-shaped fake: from().select().eq().order().range() / .single() /
// { count:'exact', head:true }. Enough for this handler and nothing more.
function fakeDb(tables) {
  return {
    from(table) {
      const rows = tables[table] || [];
      const q = { filters: [], order: null, range: null, count: false, head: false, single: false };
      const api = {
        select(_cols, opts = {}) { q.count = opts.count === 'exact'; q.head = !!opts.head; return api; },
        eq(k, v) { q.filters.push((r) => r[k] === v); return api; },
        order(k, { ascending = true } = {}) { q.order = (a, b) => (ascending ? a[k] - b[k] : b[k] - a[k]); return api; },
        range(a, b) { q.range = [a, b]; return api; },
        single() { q.single = true; return api; },
        then(resolve) {
          let out = rows.filter((r) => q.filters.every((f) => f(r)));
          if (q.order) out = [...out].sort(q.order);
          const count = out.length;
          if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
          if (q.single) return resolve(out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: `expected one row, got ${out.length}` } });
          if (q.head) return resolve({ data: null, error: null, count });
          return resolve({ data: out, error: null, count: q.count ? count : null });
        },
      };
      return api;
    },
  };
}

const DOC = 'd1';
const passages = Array.from({ length: 7 }, (_, i) => ({
  id: `p${i}`, document_id: DOC, summary_level: 0, sequence_number: i,
  page_start: i + 1, page_end: i + 1, line_start: 1, line_end: 25,
  text: `Passage ${i} ` + 'x'.repeat(3000), passage_type: 'body', witness_name: null, speaker: null,
}));
const db = fakeDb({
  documents: [
    { id: DOC, title: 'Verified Petition v12', doc_type: 'brief', page_count: 7, matterspace_id: 'm1', processing_status: 'ready' },
    { id: 'd2', title: 'Still extracting', doc_type: 'other', page_count: null, matterspace_id: 'm1', processing_status: 'extracting' },
  ],
  passages: [
    ...passages,
    { id: 's1', document_id: DOC, summary_level: 1, sequence_number: 0, page_start: 1, page_end: 7, line_start: null, line_end: null, text: 'a summary that must not appear' },
    // out of order in storage, in order in the answer
  ].reverse(),
});

console.log('\n--- reading in order, under a budget ---');
{
  const r = await handleGetDocumentText(db, { doc: DOC });
  check(r.document.id === DOC && r.document.title === 'Verified Petition v12' && r.matter.id === 'm1', 'document header and matter id');
  check(r.passage_count === 7, 'passage_count counts level-0 passages only', r.passage_count);
  check(r.passages.map((p) => p.id).join(',') === 'p0,p1,p2', 'default budget (12,000 chars) fits three 3,000-char passages, in sequence order', r.passages.map((p) => p.id).join(','));
  check(r.returned === 3 && r.next_offset === 3 && /4 more passage/.test(r.more || ''), 'returned 3, next_offset 3, "4 more"');
  check(r.passages[0].page_start === 1 && r.passages[0].line_end === 25 && r.passages[0].text.startsWith('Passage 0 '), 'each passage carries page/line and the full text');
  check(!r.passages.some((p) => /summary/.test(p.text)), 'the summary-level passage is not in the text');
  check(r.text_chars === r.passages.reduce((n, p) => n + p.text.length, 0), 'text_chars is the sum sent');

  const r2 = await handleGetDocumentText(db, { doc: DOC, offset: r.next_offset });
  check(r2.passages.map((p) => p.id).join(',') === 'p3,p4,p5' && r2.next_offset === 6, 'the next call continues exactly where the last stopped');
  const r3 = await handleGetDocumentText(db, { doc: DOC, offset: r2.next_offset });
  check(r3.passages.map((p) => p.id).join(',') === 'p6' && r3.next_offset === null && !('more' in r3), 'the last call ends with next_offset null and no "more"');
  const small = await handleGetDocumentText(db, { doc: DOC, limit: 100 });
  check(small.passages.length === 1 && small.next_offset === 1, 'a budget smaller than one passage still returns one passage');
  const big = await handleGetDocumentText(db, { doc: DOC, limit: 10 ** 9 });
  check(big.passages.length === 3 && big.text_chars <= DOCUMENT_TEXT_MAX_CHARS, `limit is capped at ${DOCUMENT_TEXT_MAX_CHARS} characters (a huge limit reads no more than the default)`);
  const neg = await handleGetDocumentText(db, { doc: DOC, offset: -3 });
  check(neg.offset === 0, 'a negative offset reads from the top');
  const empty = await handleGetDocumentText(db, { doc: 'd2' });
  check(empty.passage_count === 0 && empty.passages.length === 0 && /Not indexed yet/.test(empty.note || ''), 'a document still processing says so instead of returning nothing');
  let threw = null; try { await handleGetDocumentText(db, {}); } catch (e) { threw = e; }
  check(!!threw && /doc is required/.test(threw.message), 'doc is required');
  threw = null; try { await handleGetDocumentText(db, { doc: 'nope' }); } catch (e) { threw = e; }
  check(!!threw && /get_document_text/.test(threw.message), 'an unknown document is an error naming the tool');
}

console.log('\n--- wiring ---');
{
  const t = TOOLS.find((x) => x.name === 'get_document_text');
  check(!!t && t.inputSchema.required.join() === 'doc' && 'offset' in t.inputSchema.properties && 'limit' in t.inputSchema.properties, 'listed in TOOLS with doc required, offset and limit optional');
  check(/case 'get_document_text':\s*return handleGetDocumentText\(supabase, args\);/.test(src), 'dispatched by callTool (so the seal, the agent scope, the pause and the Record all apply — the arg is named doc, which every check already keys on)');
  check(toolClass('get_document_text') === 'read', 'the meter counts it as a read');
  const op = OPS.find((o) => o.id === 'getDocumentText');
  check(!!op && op.tool === 'get_document_text' && op.consequential === false && op.params.join() === 'doc,offset,limit', 'exposed to the GPT as getDocumentText, not consequential');
  check(/get_document_text \{doc\}/.test(src), 'the task-board hint tells an assistant it exists');
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : `GET_DOCUMENT_TEXT HOLDS — ${passes} checks: a document read in order, under a budget, through the same door as every other tool.`}\n`);
process.exit(failures ? 1 : 0);
