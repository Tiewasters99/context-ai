// An in-memory stand-in for the supabase-js query builder — just the calls
// processDocument and lib/reprocess.mjs make (select / insert / update /
// delete with eq, neq, gt, lte, in, order, limit, single, maybeSingle). For
// unit tests that must run with no network and no database. Rows are returned
// whole (column lists are not projected); inserted rows get an id and a
// strictly increasing created_at, like the database's defaults.
import { randomUUID } from 'node:crypto';

export function fakeSupabase(seed = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => structuredClone(r));
  // Now, like the database's default: seeded rows carry past timestamps, and
  // anything this fake inserts must sort after them.
  let clock = Date.now();
  const tick = () => new Date((clock += 1000)).toISOString();
  // A hook a test can set to make the next write to a table fail.
  const failures = {};

  class Query {
    constructor(table) {
      this.table = table;
      this.op = 'select';
      this.filters = [];
      this.orderBy = null;
      this.limitN = null;
      this.one = null;
      this.wantCount = false;
    }
    select() { return this; }
    insert(rows) { this.op = 'insert'; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
    update(patch) { this.op = 'update'; this.patch = patch; return this; }
    delete(opts) { this.op = 'delete'; this.wantCount = opts?.count === 'exact'; return this; }
    eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
    neq(c, v) { this.filters.push((r) => r[c] !== v); return this; }
    gt(c, v) { this.filters.push((r) => r[c] > v); return this; }
    lte(c, v) { this.filters.push((r) => r[c] <= v); return this; }
    in(c, vs) { this.filters.push((r) => vs.includes(r[c])); return this; }
    contains() { return this; }
    order(c, { ascending = true } = {}) { this.orderBy = [c, ascending]; return this; }
    limit(n) { this.limitN = n; return this; }
    single() { this.one = 'single'; return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    then(resolve, reject) {
      try { resolve(this.exec()); } catch (err) { reject(err); }
    }
    exec() {
      const rows = (tables[this.table] ||= []);
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      const fail = failures[`${this.table}.${this.op}`];
      if (fail) { delete failures[`${this.table}.${this.op}`]; return { data: null, error: { message: fail } }; }
      if (this.op === 'insert') {
        const added = this.rows.map((r) => ({ id: randomUUID(), created_at: tick(), ...structuredClone(r) }));
        rows.push(...added);
        return { data: this.one ? added[0] : added, error: null };
      }
      if (this.op === 'update') {
        for (const r of hit) Object.assign(r, structuredClone(this.patch));
        return { data: null, error: null };
      }
      if (this.op === 'delete') {
        tables[this.table] = rows.filter((r) => !hit.includes(r));
        return { data: null, error: null, ...(this.wantCount ? { count: hit.length } : {}) };
      }
      let out = hit.map((r) => structuredClone(r));
      if (this.orderBy) {
        const [c, asc] = this.orderBy;
        out.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (this.limitN != null) out = out.slice(0, this.limitN);
      if (this.one === 'single') {
        return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: `expected 1 row, got ${out.length}` } };
      }
      if (this.one === 'maybe') return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    }
  }

  return {
    from: (t) => new Query(t),
    rpc: async () => ({ data: null, error: null }),
    tables,
    failNext: (tableOp, message) => { failures[tableOp] = message; },
  };
}

// Stub the embeddings endpoint(s) on globalThis.fetch: every input gets a
// 1024-dim vector. Returns a restore function.
export function stubEmbeddings() {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (/\/v1\/embeddings\b/.test(String(url))) {
      const body = JSON.parse(init.body || '{}');
      const input = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({ data: input.map((_, i) => ({ index: i, embedding: new Array(1024).fill(0.001) })) }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected network call in a unit test: ${url}`);
  };
  return () => { globalThis.fetch = real; };
}
