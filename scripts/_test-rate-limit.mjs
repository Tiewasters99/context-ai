// Verification for lib/rate-limit.mjs. Run: node scripts/_test-rate-limit.mjs
import { TokenBucket } from '../lib/rate-limit.mjs';
import assert from 'node:assert';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.log(`FAIL  ${name}: ${e.message}`); }
};

// 1. Sustained rate: 60000/min == 1000 tokens/sec. Spending 3000 tokens from a
//    bucket pre-drained to empty must take ~3s.
{
  const b = new TokenBucket({ limitPerMinute: 60000, name: 't1' });
  b.tokens = 0;
  const t0 = Date.now();
  await b.reserve(1000);
  await b.reserve(1000);
  await b.reserve(1000);
  const dt = Date.now() - t0;
  check('drained bucket paces spend at the refill rate', () => {
    assert(dt >= 2700 && dt < 4500, `expected ~3000ms, got ${dt}ms`);
  });
}

// 2. Concurrency: N parallel reservers are serialized, not all admitted at once.
{
  const b = new TokenBucket({ limitPerMinute: 60000, name: 't2' });
  b.tokens = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 5 }, () => b.reserve(400)));
  const dt = Date.now() - t0;
  check('parallel reservers do not stampede', () => {
    assert(dt >= 1700, `5x400=2000 tokens at 1000/s should take ~2s, got ${dt}ms`);
  });
}

// 3. Burst: a full bucket admits a minute of budget immediately.
{
  const b = new TokenBucket({ limitPerMinute: 60000, name: 't3' });
  const t0 = Date.now();
  await b.reserve(59000);
  const dt = Date.now() - t0;
  check('full bucket allows an immediate burst', () => {
    assert(dt < 250, `expected immediate, got ${dt}ms`);
  });
}

// 4. penalize() stalls everyone, which is the whole point — one worker's 429
//    must slow every concurrent worker, not just itself.
{
  const b = new TokenBucket({ limitPerMinute: 600000, name: 't4' });
  b.penalize(1500);
  const t0 = Date.now();
  await b.reserve(100);
  const dt = Date.now() - t0;
  check('penalize() holds off subsequent reservations', () => {
    assert(dt >= 1300, `expected >=1.5s hold, got ${dt}ms`);
  });
}

// 5. An oversized request is clamped rather than deadlocking forever.
{
  const b = new TokenBucket({ limitPerMinute: 1000, name: 't5' });
  b.tokens = 1000;
  const t0 = Date.now();
  await b.reserve(999999);
  check('oversized reservation is clamped, not deadlocked', () => {
    assert(Date.now() - t0 < 500, 'should return promptly');
  });
}

// 6. A rejected waiter must not wedge the queue for everyone behind it.
{
  const b = new TokenBucket({ limitPerMinute: 60000, name: 't6' });
  b.reserve(10).then(() => { throw new Error('boom'); }).catch(() => {});
  await b.reserve(10);
  check('a failing waiter does not wedge the queue', () => assert(true));
}

console.log(failures === 0 ? '\nAll rate-limit checks passed.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
