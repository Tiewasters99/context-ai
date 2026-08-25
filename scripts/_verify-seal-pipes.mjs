// Prove that a sealed matter's content does not reach an outside provider.
//
// What this is
// ---------------------------------------------------------------------------
// The claim Phase A makes — "nothing from a Tier-B or Tier-C matter leaves" —
// is a claim about the NETWORK, so it is tested at the network. This script
// replaces the global `fetch` with a recorder, runs the real ingest and search
// code paths from lib/ingest-core.mjs and lib/mcp-core.mjs, and then asserts on
// the hostnames those code paths tried to reach. No mock of the guard, no
// reimplementation of the policy: the actual pipeline runs, and the recorder is
// the witness.
//
// The database underneath is a stub — a chainable object that answers the
// handful of supabase-js calls these two modules make, and remembers what was
// written. That is on purpose:
//
//   * it runs offline, so this is provable before anything is deployed and
//     before migration 060 is pasted;
//   * it touches no client data, and cannot. The corpus below is a fictional
//     matter about a fictional dispute — per the standing rule, sealed or
//     client content never goes through a harness.
//
// What it does NOT prove: that prod's tiers are what you think they are. After
// 060 is applied, re-run the live check (a magiclink session, a real test
// matter re-tiered to B, then deleted) exactly as _verify-mcp-seal.mjs does —
// this script proves the code, that one proves the deployment.
//
//   node scripts/_verify-seal-pipes.mjs
//
// No .env, no network, no prod. Exit 0 = sealed.

import { EMBEDDING_DIM, processDocument } from '../lib/ingest-core.mjs';
import { ROUTES, TIER_ROUTES } from '../lib/embed-routes.mjs';
import { handleSearch } from '../lib/mcp-core.mjs';
import { isSealedPipeError } from '../lib/seal-pipes.mjs';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
// The witness. Every provider hostname the app can reach, and a recorder that
// stands in for fetch so no call can slip through unlogged.
// ---------------------------------------------------------------------------
const PROVIDER_HOSTS = [
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.deepgram.com',
  'api.anthropic.com',
  'api.fireworks.ai',
  'api.voyageai.com',
];

const realFetch = globalThis.fetch;
let calls = [];

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  calls.push(new URL(url).hostname);
  // Answer as OpenAI's embeddings endpoint would, so the UNSEALED control case
  // below runs to completion and proves the harness can see a real call.
  if (url.includes('api.openai.com/v1/embeddings')) {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({
      data: inputs.map(() => ({ embedding: Array(EMBEDDING_DIM).fill(0.01) })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`unexpected outbound call to ${url}`);
};

const providerCalls = () => calls.filter((h) => PROVIDER_HOSTS.includes(h));
const reset = () => { calls = []; };

// ---------------------------------------------------------------------------
// The stub database. Chainable and thenable like a supabase-js builder, over
// three in-memory tables. Only the calls these code paths actually make are
// implemented — an unimplemented one throws rather than quietly returning
// empty, because a guard that is skipped because its lookup silently failed is
// exactly the bug this file exists to catch.
// ---------------------------------------------------------------------------
const db = { matterspaces: [], documents: [], passages: [] };

function makeClient() {
  const rowsOf = (t) => db[t] ?? (() => { throw new Error(`stub: no table ${t}`); })();
  return {
    from(table) {
      const state = { table, op: 'select', filters: [], payload: null };
      const apply = () => {
        let rows = rowsOf(state.table);
        for (const [col, val, kind] of state.filters) {
          rows = kind === 'in'
            ? rows.filter((r) => val.includes(r[col]))
            : rows.filter((r) => r[col] === val);
        }
        return rows;
      };
      const run = () => {
        const rows = apply();
        if (state.op === 'update') {
          for (const r of rows) Object.assign(r, state.payload);
          return { data: rows, error: null };
        }
        if (state.op === 'delete') {
          for (const r of rows) rowsOf(state.table).splice(rowsOf(state.table).indexOf(r), 1);
          return { data: null, error: null };
        }
        return { data: rows, error: null };
      };
      const builder = {
        select() { return builder; },
        insert(rows) {
          rowsOf(state.table).push(...(Array.isArray(rows) ? rows : [rows]));
          return builder;
        },
        update(payload) { state.op = 'update'; state.payload = payload; return builder; },
        delete() { state.op = 'delete'; return builder; },
        eq(col, val) { state.filters.push([col, val, 'eq']); return builder; },
        neq(col, val) { state.filters.push([col, val, 'neq']); return builder; },
        in(col, vals) { state.filters.push([col, vals, 'in']); return builder; },
        order() { return builder; },
        limit() { return builder; },
        single() { const { data, error } = run(); return Promise.resolve({ data: data[0] ?? null, error }); },
        maybeSingle() { const { data, error } = run(); return Promise.resolve({ data: data[0] ?? null, error }); },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return builder;
    },
    async rpc(name, params) {
      if (name === 'matterspace_descendants') {
        // Walks the stub's parent links exactly as the real recursive CTE
        // does. It has to: the seal is INHERITED, and the sealed matter in
        // this fixture is Tier A on its own row. A stub that returned only
        // the root would quietly turn the inheritance test into a no-op.
        const out = [];
        const queue = [params.p_root];
        while (queue.length) {
          const id = queue.shift();
          out.push({ id });
          for (const m of db.matterspaces) {
            if (m.parent_matterspace_id === id) queue.push(m.id);
          }
        }
        return { data: out, error: null };
      }
      if (name === 'search_passages') {
        // The stub stands in for migration 056 only in the one respect this
        // test is about: whether an embedding was supplied. Recording it is
        // the point — the assertion below is that the sealed group's RPC was
        // called with none.
        searchRpcCalls.push({
          ids: params.p_matterspace_ids,
          hadEmbedding: params.p_query_embedding !== null && params.p_query_embedding !== undefined,
          model: params.p_embedding_model ?? null,
        });
        const scope = new Set(params.p_matterspace_ids);
        const hits = db.passages
          .filter((p) => scope.has(p.matterspace_id))
          .filter((p) => p.text.toLowerCase().includes(String(params.p_query_text).toLowerCase()))
          .slice(0, params.p_limit ?? 5)
          .map((p) => ({
            passage_id: 'p-' + p.sequence_number,
            document_id: p.document_id,
            document_title: 'Fictional memo',
            doc_type: 'other',
            page_start: p.page_start, page_end: p.page_end,
            line_start: p.line_start, line_end: p.line_end,
            witness_name: null, examination_type: null, passage_type: p.passage_type,
            text: p.text, hybrid_score: 0.5, text_rank: 0.5, vector_score: 0,
          }));
        return { data: hits, error: null };
      }
      throw new Error(`stub: no rpc ${name}`);
    },
  };
}
const searchRpcCalls = [];

const supabase = makeClient();

// ---------------------------------------------------------------------------
// A fictional corpus. Two matters under one root: one sealed, one not.
// ---------------------------------------------------------------------------
const SEALED = '11111111-1111-4111-8111-111111111111';
const OPEN = '22222222-2222-4222-8222-222222222222';
const PARENT_SEALED = '33333333-3333-4333-8333-333333333333';
const DOC_SEALED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOC_OPEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DOC_SCAN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DOC_AUDIO = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

db.matterspaces.push(
  { id: PARENT_SEALED, parent_matterspace_id: null, ai_tier: 'B', name: 'Vashti v. Ormsby (fiction)' },
  // Tier A on its own row: sealed ONLY by inheritance from the parent. If the
  // guard read the row instead of walking the chain, this matter would leak.
  { id: SEALED, parent_matterspace_id: PARENT_SEALED, ai_tier: 'A', name: 'Vashti — Exhibits' },
  { id: OPEN, parent_matterspace_id: null, ai_tier: 'A', name: 'Public Domain Reading' },
);

const TEXT = Buffer.from(
  'The Vashti letter is dated the ninth of March and was never sent.\n\n' +
  'Ormsby denied receiving it, which is the whole of the dispute.\n\n' +
  'A third paragraph exists so that chunking has something to chunk.\n',
  'utf8',
);

const newDoc = (id, matterspace_id, source_filename) => {
  db.documents.push({
    id, matterspace_id, source_filename, witness_name: null,
    processing_status: 'pending', processing_error: null,
  });
};
const docById = (id) => db.documents.find((d) => d.id === id);

// ---------------------------------------------------------------------------
// 1. Control: an UNSEALED matter still embeds. If this fails, the harness is
//    lying and every "no calls" result below is worthless.
// ---------------------------------------------------------------------------
console.log('\n--- control: unsealed ingest still reaches OpenAI ---------------');
reset();
newDoc(DOC_OPEN, OPEN, 'reading.txt');
const openResult = await processDocument(supabase, {
  documentId: DOC_OPEN, fileBuf: TEXT, ext: '.txt', openaiApiKey: 'sk-test',
});
check(providerCalls().includes('api.openai.com'), 'unsealed ingest DID call api.openai.com',
  `calls=[${providerCalls().join(', ')}]`);
check(openResult.passageCount > 0, `unsealed ingest produced passages`, `n=${openResult.passageCount}`);
check(db.passages.filter((p) => p.matterspace_id === OPEN).every((p) => Array.isArray(p.embedding)),
  'unsealed passages carry embeddings');

// ---------------------------------------------------------------------------
// 2. Sealed text ingest: zero egress, and still searchable.
// ---------------------------------------------------------------------------
console.log('\n--- sealed ingest: text ----------------------------------------');
reset();
newDoc(DOC_SEALED, SEALED, 'letter.txt');
const sealedResult = await processDocument(supabase, {
  documentId: DOC_SEALED, fileBuf: TEXT, ext: '.txt', openaiApiKey: 'sk-test',
});
check(providerCalls().length === 0, 'sealed ingest made ZERO provider calls',
  `calls=[${providerCalls().join(', ')}]`);
const sealedPassages = db.passages.filter((p) => p.matterspace_id === SEALED);
check(sealedPassages.length > 0, 'sealed matter still got passages (text search survives)',
  `n=${sealedPassages.length}`);
check(sealedPassages.every((p) => p.embedding === null), 'every sealed passage has a null embedding');
// Phase A left this to the column default because migration 056's FULL-TEXT
// stage filtered on it, so any other value made a sealed matter unfindable.
// 061 removed that filter, and the stamp now means one thing only: which space
// this row's vector lives in. It is written explicitly, and for a passage with
// no vector it names the space the row would join if it were ever embedded.
check(sealedPassages.every((p) => p.embedding_model === 'text-embedding-3-small'),
  'unembedded passages are stamped with the tier-A space they would join',
  [...new Set(sealedPassages.map((p) => p.embedding_model))].join(', '));
check(docById(DOC_SEALED).processing_status === 'ready',
  'sealed text document is genuinely ready, not held', docById(DOC_SEALED).processing_status);
check(sealedResult.embedded === false, 'processDocument reports it did not embed');

// ---------------------------------------------------------------------------
// 3. Sealed scan and sealed recording: refused, not silently filed as ready.
// ---------------------------------------------------------------------------
console.log('\n--- sealed ingest: scan + recording ----------------------------');
reset();
newDoc(DOC_SCAN, SEALED, 'scan.jpg');
let scanErr = null;
try {
  await processDocument(supabase, {
    documentId: DOC_SCAN, fileBuf: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), ext: '.jpg',
    openaiApiKey: 'sk-test', ocr: async () => [{ pageNumber: 1, text: 'should never run' }],
  });
} catch (err) { scanErr = err; }
check(isSealedPipeError(scanErr), 'a sealed scan refuses OCR', scanErr?.code ?? 'no error thrown');
check(providerCalls().length === 0, 'the refused scan made ZERO provider calls');
check(docById(DOC_SCAN).processing_status !== 'ready',
  'the refused scan was NOT marked ready', docById(DOC_SCAN).processing_status);

reset();
newDoc(DOC_AUDIO, SEALED, 'deposition.mp3');
let audioErr = null;
try {
  await processDocument(supabase, {
    documentId: DOC_AUDIO, fileBuf: Buffer.from('ID3fake'), ext: '.mp3',
    openaiApiKey: 'sk-test', transcribe: async () => [{ pageNumber: 1, text: 'should never run' }],
  });
} catch (err) { audioErr = err; }
check(isSealedPipeError(audioErr), 'a sealed recording refuses transcription',
  audioErr?.code ?? 'no error thrown');
check(providerCalls().length === 0, 'the refused recording made ZERO provider calls');

// ---------------------------------------------------------------------------
// 4. Search: a sealed scope is never embedded, and still returns hits.
// ---------------------------------------------------------------------------
console.log('\n--- sealed search ----------------------------------------------');
reset();
searchRpcCalls.length = 0;
const sealedSearch = await handleSearch(supabase, { matter: SEALED, q: 'Ormsby' },
  { openaiApiKey: 'sk-test' });
check(providerCalls().length === 0, 'sealed search made ZERO provider calls',
  `calls=[${providerCalls().join(', ')}]`);
check(searchRpcCalls.length > 0 && searchRpcCalls.every((c) => !c.hadEmbedding),
  'search_passages was called with NO query embedding for the sealed scope');
check(sealedSearch.result_count > 0, 'sealed search still returned results',
  `n=${sealedSearch.result_count}`);
check(sealedSearch.sealed_text_only === true, 'the result says it was text-only');
check(/sealed/i.test(sealedSearch.note ?? ''), 'the note explains why', sealedSearch.note?.slice(0, 60));

// Control again: an unsealed scope embeds as before.
reset();
searchRpcCalls.length = 0;
const openSearch = await handleSearch(supabase, { matter: OPEN, q: 'Ormsby' },
  { openaiApiKey: 'sk-test' });
check(providerCalls().includes('api.openai.com'), 'unsealed search DID embed the query');
check(searchRpcCalls.every((c) => c.hadEmbedding), 'unsealed scope got its embedding');
check(openSearch.sealed_text_only === undefined, 'unsealed result carries no seal notice');

// ---------------------------------------------------------------------------
// 5. Phase B: give Tier B a zero-retention route and prove the wiring.
//
// No such route is permitted in lib/embed-routes.mjs yet — that is a
// procurement decision, not a code one. What IS a code question is whether the
// day it is permitted, the two embedding spaces stay apart. So register a
// fake one here and watch where the bytes go.
// ---------------------------------------------------------------------------
console.log('\n--- phase B wiring: a permitted route for Tier B ----------------');

const ZDR_HOST = 'zdr.example-provider.test';
ROUTES['fake-zdr'] = {
  id: 'fake-zdr',
  provider: 'fake-zdr',
  model: 'zdr-embed-1',
  dim: EMBEDDING_DIM,
  url: `https://${ZDR_HOST}/v1/embeddings`,
  keyEnv: 'FAKE_ZDR_API_KEY',
  headers: (k) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' }),
  body: (texts) => ({ model: 'zdr-embed-1', input: texts }),
  parse: (json) => json.data.map((d) => d.embedding),
};
TIER_ROUTES.B = 'fake-zdr';
process.env.FAKE_ZDR_API_KEY = 'zdr-test-key';

// Teach the recorder to answer as the fake provider too.
const baseFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.includes(ZDR_HOST)) {
    calls.push(new URL(url).hostname);
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({
      data: inputs.map(() => ({ embedding: Array(EMBEDDING_DIM).fill(0.02) })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return baseFetch(input, init);
};

reset();
const DOC_ZDR = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
newDoc(DOC_ZDR, SEALED, 'second-letter.txt');
const zdrResult = await processDocument(supabase, {
  documentId: DOC_ZDR, fileBuf: TEXT, ext: '.txt', openaiApiKey: 'sk-test',
});
check(calls.includes(ZDR_HOST), 'sealed ingest now reaches the ZERO-RETENTION provider',
  `calls=[${calls.join(', ')}]`);
check(!calls.includes('api.openai.com'),
  'and still never reaches OpenAI — no fallback, ever');
const zdrPassages = db.passages.filter((p) => p.document_id === DOC_ZDR);
check(zdrPassages.every((p) => Array.isArray(p.embedding)), 'the sealed passages got real vectors');
check(zdrPassages.every((p) => p.embedding_model === 'zdr-embed-1'),
  'stamped with the ZDR model, not the tier-A one',
  [...new Set(zdrPassages.map((p) => p.embedding_model))].join(', '));
check(zdrResult.embeddingModel === 'zdr-embed-1', 'processDocument reports which space it used');

// The cross-wiring assertion: one search spanning BOTH tiers.
reset();
searchRpcCalls.length = 0;
const mixed = await handleSearch(supabase, { q: 'Ormsby' }, { openaiApiKey: 'sk-test' });
check(calls.includes('api.openai.com') && calls.includes(ZDR_HOST),
  'a mixed-scope search embeds the query once per space',
  `calls=[${calls.join(', ')}]`);

const sealedRpc = searchRpcCalls.filter((c) => c.ids.includes(SEALED));
const openRpc = searchRpcCalls.filter((c) => c.ids.includes(OPEN));
check(sealedRpc.length > 0 && sealedRpc.every((c) => c.model === 'zdr-embed-1'),
  'the sealed group is queried with the ZDR model',
  sealedRpc.map((c) => c.model).join(', '));
check(openRpc.length > 0 && openRpc.every((c) => c.model === 'text-embedding-3-small'),
  'the tier-A group is queried with the OpenAI model',
  openRpc.map((c) => c.model).join(', '));
check(!searchRpcCalls.some((c) => c.ids.includes(SEALED) && c.ids.includes(OPEN)),
  'NO RPC ever mixes matters from two spaces in one call');
check(mixed.result_count > 0, 'the mixed search still returns results', `n=${mixed.result_count}`);
check(mixed.sealed_text_only === undefined,
  'and carries no text-only notice, because nothing was downgraded');

TIER_ROUTES.B = null; // leave policy as we found it

// ---------------------------------------------------------------------------
globalThis.fetch = realFetch;
console.log(`\n${failures === 0 ? 'SEALED — no sealed content left the process.' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
