// The monitor must never report health it did not establish (2026-09-20).
//
// The ready-but-empty check (migration 059/081) answers the monitor's
// headline question: are there documents marked `ready` with nothing indexed
// behind them? On 2026-09-20 that RPC hit the statement timeout at ~46k
// documents, and the monitor printed "All documents are ready, and every
// text-bearing document is searchable." and exited 0 — a failed check reading
// as an all-clear, the same silent-success shape as the scans it was built to
// catch. What must hold now:
//   - a transient failure is retried before it is believed;
//   - a check that did not run marks the run degraded: NOT GREEN, exit 1;
//   - a missing RPC is not retried (it will not fix itself) but is still
//     degraded — "I could not look" is not "nothing to see";
//   - an explicit --no-empty-check skip stays green, with the note;
//   - a healthy run reads exactly as before.
// No network, no database: the client is a stub.
//   node scripts/_test-monitor-empty-check.mjs
import assert from 'node:assert';
import { fetchReadyEmpty, isTransient, render, alertHeadline } from './ingest-monitor.mjs';

let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };

// A stub of the two chains fetchReadyEmpty uses: rpc().order().range() and
// from().select().in(). `answers` is consumed one call at a time.
function stubClient(answers, rows = []) {
  const calls = { rpc: 0 };
  return {
    calls,
    rpc() {
      const chain = {
        order: () => chain,
        range: () => {
          const a = answers[Math.min(calls.rpc++, answers.length - 1)];
          return Promise.resolve(a === 'ok' ? { data: rows, error: null } : { data: null, error: { message: a } });
        },
      };
      return chain;
    },
    from() {
      const chain = { select: () => chain, in: () => Promise.resolve({ data: [], error: null }) };
      return chain;
    },
  };
}

const TIMEOUT = 'canceling statement due to statement timeout';

{
  assert(isTransient(TIMEOUT));
  assert(isTransient('TypeError: fetch failed'));
  assert(isTransient('57014'));
  assert(!isTransient('Could not find the function public.ready_but_empty'));
  assert(!isTransient('permission denied for function ready_but_empty'));
  ok('isTransient: timeouts and dropped connections yes; a missing function or a refusal no');
}

{
  const sb = stubClient(['ok'], [{ document_id: 'd1', matterspace_id: 'm', source_filename: 'a.pdf' }]);
  const r = await fetchReadyEmpty(sb, null);
  assert.strictEqual(r.degraded, false);
  assert.strictEqual(r.note, null);
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(sb.calls.rpc, 1);
  ok('a healthy check returns its rows, not degraded, in one call');
}

{
  const sb = stubClient([TIMEOUT, TIMEOUT, 'ok'], []);
  const r = await fetchReadyEmpty(sb, null);
  assert.strictEqual(r.degraded, false, 'a timeout that clears on retry is not a degraded run');
  assert.strictEqual(sb.calls.rpc, 3);
  ok('a transient timeout is retried, and the answer on the third try counts');
}

{
  const sb = stubClient([TIMEOUT], []);
  const r = await fetchReadyEmpty(sb, null);
  assert.strictEqual(r.degraded, true);
  assert.match(r.note, /failed: .*statement timeout/);
  assert.strictEqual(sb.calls.rpc, 3, 'three attempts, then it stops');
  ok('a check that keeps timing out is degraded, with the reason, after three attempts');
}

{
  const sb = stubClient(['Could not find the function public.ready_but_empty (PGRST202)'], []);
  const r = await fetchReadyEmpty(sb, null);
  assert.strictEqual(r.degraded, true, 'a missing RPC is still "I could not look"');
  assert.match(r.note, /paste migration 059/);
  assert.strictEqual(sb.calls.rpc, 1, 'not retried — it will not fix itself');
  ok('a missing RPC is degraded too, named as such, and not retried');
}

// --- what the reader sees -------------------------------------------------------
const healthy = { total: 0, needsHuman: 0, autoRetryable: 0, groups: [] };
const base = { report: healthy, escalate: [], escalatedRows: [], jobs: [], matter: null, staleMin: 45 };

{
  const green = render({ ...base, emptyNote: null, emptyDegraded: false });
  assert.match(green, /All documents are ready, and every text-bearing document is searchable\./);
  assert(!/NOT GREEN/.test(green));
  ok('a healthy run still reads "All documents are ready…"');
}

{
  const degraded = render({ ...base, emptyNote: `failed: ${TIMEOUT}`, emptyDegraded: true });
  assert.match(degraded, /NOT GREEN/);
  assert(!/All documents are ready/.test(degraded), 'it must not claim health it did not establish');
  assert.match(degraded, /statement timeout/, 'the reason is in the digest');
  assert.match(degraded, /migration 081/, 'and what to do about it');
  ok('a degraded run says NOT GREEN, with the reason, instead of the all-clear');
}

{
  const busy = render({
    ...base,
    report: { total: 2, needsHuman: 2, autoRetryable: 0, groups: [{ cls: 'corrupt', label: 'Corrupt', count: 2, severity: 'blocking' }] },
    escalate: [{ cls: 'corrupt', label: 'Corrupt', count: 2, severity: 'blocking', action: 'Re-upload them.', examples: [{ id: 'd9', cls: 'corrupt', error: 'Invalid PDF structure' }] }],
    emptyNote: `failed: ${TIMEOUT}`, emptyDegraded: true,
  });
  assert.match(busy, /NOT GREEN/);
  assert.match(busy, /NOT covered by the counts below/, 'the counts are explicitly incomplete');
  ok('with other failures too, the digest says the counts do not cover the unchecked class');
}

{
  const skipped = render({ ...base, emptyNote: 'skipped (--no-empty-check)', emptyDegraded: false });
  assert.match(skipped, /All documents are ready/);
  assert.match(skipped, /skipped \(--no-empty-check\)/, 'the skip is still disclosed');
  ok('an explicit --no-empty-check skip stays green and says so');
}

{
  assert.match(alertHeadline({ workers: null, stalledCount: 0, staleMin: 45, emptyDegraded: true }), /did NOT run — health unverified/);
  assert.strictEqual(alertHeadline({ workers: null, stalledCount: 0, staleMin: 45, emptyDegraded: false }), null);
  ok('the email alert line says the check did not run');
}

console.log(`\nPASS (${n} checks)`);
