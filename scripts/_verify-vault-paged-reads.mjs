// Probe: the Vault's document read at real-matter scale. Entirely offline —
// no network, no .env, no database. Node 22.18+ strips the .ts types.
//
// The bug this exists to keep fixed: PostgREST answers an unbounded `select`
// with at most `db-max-rows` rows (1,000 here) and a 200. The Vault's file
// list WAS that read, so a matter tree with more than a thousand documents
// showed a thousand of them — in the list, in the count, and in the
// "Search files…" filter — with nothing on the screen saying to look again.
//
// What is asserted, and why each one is the difference between a paged read
// that works and one that looks like it works:
//
//   1. WHOLE. 2,500 and 12,000 documents come back complete, in order, each
//      exactly once.
//   2. TIES. The 12,000-row fixture gives every row the SAME created_at,
//      which is what a dropped folder actually writes. `.range()` re-runs the
//      query per page, so rows the ORDER BY calls equal may land on two pages
//      or none. The negative control at the end proves the fixture has teeth:
//      the same loop WITHOUT the `.order('id')` tiebreaker loses rows.
//   3. THE COUNT IS THE SERVER'S. `total` is `count: 'exact'`, not
//      `rows.length` — so a badge is right even when the list is windowed —
//      and it is asked for ONCE, not on every page.
//   4. THE CEILING SAYS SO. Stopping early sets `truncated` and produces the
//      "Showing the first N of M" sentence; a whole list says nothing.
//   5. A FAILURE IS NOT AN EMPTY FOLDER. Transient errors retry; a persistent
//      one throws, because a matter rendered as empty is a lie the user
//      cannot see through (2026-08-10, "Blue Book / Robert Frost not
//      showing up").
//
// Untracked by convention elsewhere in scripts/, but this one runs in CI.

import {
  fetchMatterDocumentRows,
  VAULT_DOCUMENT_CEILING,
} from '../src/lib/vault-documents.ts';
import { fetchPaged, showingOf } from '../src/lib/paged.ts';

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}`); if (detail !== undefined) console.log(`      ${detail}`); }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * `count` documents spread over `batches` upload batches. Every row inside a
 * batch shares a created_at to the millisecond — which is not a contrived
 * case: dropping a folder on the Vault inserts hundreds of rows in one
 * round-trip and Postgres stamps them identically.
 */
function syntheticDocuments({ count, batches, matterIds }) {
  const rows = [];
  const perBatch = Math.ceil(count / batches);
  for (let i = 0; i < count; i++) {
    const batch = Math.floor(i / perBatch);
    rows.push({
      id: `doc-${String(i).padStart(6, '0')}`,
      title: `Exhibit A`,                    // titles tie too, deliberately
      source_filename: `exhibit-${i}.pdf`,
      file_size_bytes: 1024 * (i % 97),
      processing_status: i % 50 === 0 ? 'extracting' : 'ready',
      processing_error: null,
      matterspace_id: matterIds[i % matterIds.length],
      storage_path: `m/${i}/exhibit.pdf`,
      created_at: `2026-09-${String(1 + (batch % 28)).padStart(2, '0')}T10:00:00.000Z`,
    });
  }
  return rows;
}

/**
 * A stand-in for PostgREST that behaves the way the real one does where it
 * matters: it caps every page at db-max-rows however wide the `.range()` is,
 * it answers `count: 'exact'` with the true total, and — the point of the
 * fixture — it puts rows the ORDER BY calls EQUAL in an arbitrary order that
 * differs from page to page, exactly as a re-planned query may.
 */
function fakePostgrest(rows, { dbMaxRows = 1000, failFirst = 0 } = {}) {
  const calls = { ranges: [], countRequests: 0, orders: [], attempts: 0 };
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

  const run = (q, from, to) => {
    calls.attempts += 1;
    if (calls.attempts <= failFirst) {
      return Promise.resolve({ data: null, error: { message: 'JWT expired' }, count: null });
    }
    const matched = rows.filter((r) =>
      q.filters.every(([op, col, val]) => (op === 'in' ? val.includes(r[col]) : r[col] === val)),
    );
    // Arbitrary, per-page ordering among rows that tie on every sort key.
    const jitter = new Map(matched.map((r) => [r.id, rnd()]));
    const sorted = [...matched].sort((a, b) => {
      for (const o of q.orders) {
        if (a[o.col] === b[o.col]) continue;
        const c = a[o.col] < b[o.col] ? -1 : 1;
        return o.ascending ? c : -c;
      }
      return jitter.get(a.id) - jitter.get(b.id);
    });
    const width = Math.min(to - from + 1, dbMaxRows);
    calls.ranges.push([from, to]);
    calls.orders.push(q.orders.map((o) => `${o.col}${o.ascending ? '' : ' desc'}`));
    return Promise.resolve({
      data: sorted.slice(from, from + width),
      error: null,
      count: q.count === 'exact' ? matched.length : null,
    });
  };

  const db = {
    calls,
    from(table) {
      if (table !== 'documents') throw new Error(`unexpected table: ${table}`);
      return {
        select(columns, options) {
          const q = { columns, count: options?.count ?? null, filters: [], orders: [] };
          if (q.count === 'exact') calls.countRequests += 1;
          const builder = {
            in(col, vals) { q.filters.push(['in', col, vals]); return builder; },
            eq(col, val) { q.filters.push(['eq', col, val]); return builder; },
            order(col, opts) { q.orders.push({ col, ascending: opts?.ascending !== false }); return builder; },
            range(from, to) { return run(q, from, to); },
          };
          return builder;
        },
      };
    },
  };
  return db;
}

/** The order the Vault asks for: created_at DESC, id DESC. */
const expectedOrder = (rows) =>
  [...rows].sort((a, b) =>
    a.created_at === b.created_at
      ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
      : (a.created_at < b.created_at ? 1 : -1),
  ).map((r) => r.id);

const noSleep = () => Promise.resolve();

// ---------------------------------------------------------------------------

section('1. A matter tree of 2,500 documents — what an unpaged read showed 1,000 of');
{
  const matterIds = ['m-root', 'm-sub-a', 'm-sub-b'];
  const rows = syntheticDocuments({ count: 2500, batches: 25, matterIds });
  const db = fakePostgrest(rows);
  const res = await fetchMatterDocumentRows(db, matterIds, { delay: noSleep });

  check('2,500 rows come back — not the 1,000 an unpaged read returned', res.rows.length === 2500, `got ${res.rows.length}`);
  check('each document exactly once', new Set(res.rows.map((r) => r.id)).size === 2500);
  check('in the order the Vault asks for (newest first)',
    res.rows.map((r) => r.id).join() === expectedOrder(rows).join());
  check('the list is whole, so it says nothing to the reader', showingOf(res, 'documents') === null);
  check('three pages were fetched, 1,000 rows apart',
    db.calls.ranges.length === 3 && db.calls.ranges[0][0] === 0 && db.calls.ranges[1][0] === 1000 && db.calls.ranges[2][0] === 2000,
    JSON.stringify(db.calls.ranges));
}

section('2. 12,000 documents, every created_at identical — the dropped-folder case');
{
  const matterIds = ['m-fleming'];
  const rows = syntheticDocuments({ count: 12000, batches: 1, matterIds });
  check('the fixture really does tie', new Set(rows.map((r) => r.created_at)).size === 1);

  const db = fakePostgrest(rows);
  const res = await fetchMatterDocumentRows(db, matterIds, { delay: noSleep });

  check('all 12,000 arrive', res.rows.length === 12000, `got ${res.rows.length}`);
  check('none duplicated, none dropped, despite 12,000 tied sort keys',
    new Set(res.rows.map((r) => r.id)).size === 12000);
  check('order held across all twelve pages', res.rows.map((r) => r.id).join() === expectedOrder(rows).join());
  check('the default ceiling (20,000) did not stop it', res.truncated === false);
  check('nothing to tell the reader — the list is the matter', showingOf(res, 'documents') === null);
  check('the query ends with the unique tiebreaker `id`',
    db.calls.orders.every((o) => o[o.length - 1] === 'id desc'), JSON.stringify(db.calls.orders[0]));

  // The fixture has teeth: the same loop without the tiebreaker loses rows.
  const naiveDb = fakePostgrest(rows);
  const naive = await fetchPaged((from, to) => naiveDb
    .from('documents')
    .select('id, created_at')
    .in('matterspace_id', matterIds)
    .order('created_at', { ascending: false })
    .range(from, to));
  check('CONTROL — the same read WITHOUT `.order(\'id\')` does not return 12,000 distinct rows',
    new Set(naive.rows.map((r) => r.id)).size < 12000,
    `distinct: ${new Set(naive.rows.map((r) => r.id)).size}`);
}

section('3. The count is the server\'s, and is asked for once');
{
  const matterIds = ['m-fleming'];
  const rows = syntheticDocuments({ count: 12000, batches: 4, matterIds });
  const db = fakePostgrest(rows);
  const res = await fetchMatterDocumentRows(db, matterIds, { ceiling: 5000, delay: noSleep });

  check('the badge number is the 12,000 that EXIST, not the 5,000 held', res.total === 12000, `total ${res.total}`);
  check('the rows held stop at the ceiling', res.rows.length === 5000, `got ${res.rows.length}`);
  check('count: exact was requested exactly once, not once per page', db.calls.countRequests === 1,
    `${db.calls.countRequests} count requests over ${db.calls.ranges.length} pages`);
  check('the first 5,000 are still the right 5,000, in order',
    res.rows.map((r) => r.id).join() === expectedOrder(rows).slice(0, 5000).join());
}

section('4. The ceiling message — shown when it is hit, and only then');
{
  const matterIds = ['m-fleming'];
  const rows = syntheticDocuments({ count: 12000, batches: 4, matterIds });

  const cut = await fetchMatterDocumentRows(fakePostgrest(rows), matterIds, { ceiling: 5000, delay: noSleep });
  check('a truncated read reports it', cut.truncated === true);
  const notice = showingOf(cut, 'documents');
  check('and says both numbers, in the surface\'s own words',
    notice === 'Showing the first 5,000 of 12,000 documents. Narrow the list to see the rest.', notice);

  const whole = await fetchMatterDocumentRows(fakePostgrest(rows), matterIds, { delay: noSleep });
  check('a whole read says NOTHING — no false alarm on a normal matter',
    whole.truncated === false && showingOf(whole, 'documents') === null);
  check('the shipped ceiling is above any real matter tree', VAULT_DOCUMENT_CEILING === 20000);

  const exact = await fetchMatterDocumentRows(fakePostgrest(rows.slice(0, 2000)), matterIds, { ceiling: 2000, delay: noSleep });
  check('a list that is exactly the ceiling is not called truncated',
    exact.rows.length === 2000 && exact.truncated === false && showingOf(exact, 'documents') === null);
}

section('5. A failed read is never rendered as an empty folder');
{
  const matterIds = ['m-fleming'];
  const rows = syntheticDocuments({ count: 2500, batches: 5, matterIds });

  const flaky = fakePostgrest(rows, { failFirst: 2 });
  const res = await fetchMatterDocumentRows(flaky, matterIds, { delay: noSleep });
  check('two transient failures are retried, and the list still arrives whole',
    res.rows.length === 2500 && new Set(res.rows.map((r) => r.id)).size === 2500, `got ${res.rows.length}`);

  const dead = fakePostgrest(rows, { failFirst: Number.MAX_SAFE_INTEGER });
  let threw = null;
  try {
    await fetchMatterDocumentRows(dead, matterIds, { attempts: 2, delay: noSleep });
  } catch (e) { threw = e; }
  check('a persistent failure THROWS rather than returning zero documents', threw instanceof Error);
  check('and the error names the list that broke', /list documents/.test(threw?.message ?? ''), threw?.message);
  check('it gave up after the attempts it was allowed', dead.calls.attempts === 2, `${dead.calls.attempts} attempts`);
}

section('6. Nothing to read costs nothing');
{
  const db = fakePostgrest([]);
  const res = await fetchMatterDocumentRows(db, [], { delay: noSleep });
  check('an empty matter set makes no request at all',
    res.rows.length === 0 && res.total === 0 && res.truncated === false && db.calls.ranges.length === 0);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
