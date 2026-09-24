// All-matters search: one call per route, batches only as a fallback — offline.
// node scripts/_test-search-all-matters.mjs
//
// 2026-09-24: the matter-omitted search fanned out 312 matters as 27
// parallel 12-matter RPCs; each was an exact vector scan, and together they
// timed each other out — 11–15 of 27 skipped on every search. One call over
// all of them takes the HNSW branch and answers in under a second.
import assert from 'node:assert/strict';
import { handleSearch } from '../lib/mcp-core.mjs';

// No network: the query embedding fails, so every group searches on text.
// The fan-out under test does not depend on which half of the score runs.
globalThis.fetch = async () => { throw new Error('offline test: no network'); };

let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };

const MATTERS = Array.from({ length: 40 }, (_, i) => ({ id: `m-${String(i).padStart(3, '0')}`, ai_tier: null }));

function makeClient({ failWhole = false, failEvery = false } = {}) {
  const calls = [];
  let active = 0;
  let peak = 0;
  const table = (name) => {
    const state = { name, in: null };
    const run = () => {
      if (name === 'matterspaces') {
        if (state.in?.col === 'ai_tier') return { data: [], error: null };
        return { data: MATTERS.map((m) => ({ id: m.id, short_code: m.id, name: m.id })), error: null };
      }
      if (name === 'documents') return { data: (state.in?.vals ?? []).map((id) => ({ id, matterspace_id: 'm-000' })), error: null };
      if (name === 'passages') return { data: [], error: null };
      return { data: [], error: null };
    };
    const b = {
      select() { return b; },
      in(col, vals) { state.in = { col, vals }; return b; },
      eq() { return b; }, is() { return b; }, order() { return b; }, limit() { return b; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  return {
    calls,
    peak: () => peak,
    from: table,
    async rpc(name, params) {
      if (name === 'matterspace_descendants') return { data: [{ id: params.p_root }], error: null };
      assert.equal(name, 'search_passages');
      const ids = params.p_matterspace_ids;
      calls.push(ids.length);
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      const whole = ids.length === MATTERS.length;
      if (failEvery || (failWhole && whole)) {
        return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
      }
      return {
        data: [{
          passage_id: `p-${ids[0]}`, document_id: `d-${ids[0]}`, document_title: 'Memo', doc_type: 'other',
          page_start: 1, page_end: 1, line_start: null, line_end: null, witness_name: null,
          examination_type: null, passage_type: 'body', text: 'text', hybrid_score: 0.5, text_rank: 0.5, vector_score: 0,
        }],
        error: null,
      };
    },
  };
}

const opts = { openaiApiKey: 'sk-offline' };

// 1. The normal case: ONE call over all 40 matters, no note about skipped groups.
{
  const sb = makeClient();
  const out = await handleSearch(sb, { q: 'dean' }, opts);
  assert.deepEqual(sb.calls, [40], `expected one call over all 40 matters, got ${JSON.stringify(sb.calls)}`);
  assert(!/failed and were skipped/.test(JSON.stringify(out)), 'no skipped-groups note on success');
  ok('one call over every matter, not ceil(40/12) = 4 batches');
}

// 2. The one call times out: fall back to 12-matter batches, at most 4 at a time.
{
  const sb = makeClient({ failWhole: true });
  const out = await handleSearch(sb, { q: 'dean' }, opts);
  assert.equal(sb.calls[0], 40, 'the whole call is tried first');
  assert.deepEqual(sb.calls.slice(1).sort((a, b) => b - a), [12, 12, 12, 4], 'then 12-matter batches');
  assert(sb.peak() <= 4, `fallback batches must queue, peak concurrency was ${sb.peak()}`);
  assert(!/failed and were skipped/.test(JSON.stringify(out)),
    'a failed whole call that the batches recovered is not reported as skipped');
  assert.equal(out.result_count, 4, 'results from every recovered batch are merged');
  ok('a timed-out whole call falls back to queued batches and recovers every matter');
}

// 3. Everything fails: the note still says so, counting the batches that failed.
{
  const sb = makeClient({ failEvery: true });
  const out = await handleSearch(sb, { q: 'dean' }, opts);
  assert.match(JSON.stringify(out), /4 of 4 matter groups failed and were skipped \(statement timeout/);
  ok('when the fallback batches fail too, the note reports them — nothing silent');
}

console.log(`\nPASS (${n} checks)`);
