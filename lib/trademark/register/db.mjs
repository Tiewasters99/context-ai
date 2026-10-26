// lib/trademark/register/db.mjs — one door to the register copy's database.
//
// The register copy is a SEPARATE database (db/tm-register/schema.sql). Its
// address is TM_REGISTER_DB_URL in the server's environment:
//
//   unset                     the feature is OFF: every caller says "not available"
//   pglite:memory             an in-memory PGlite (tests)
//   pglite:<directory>        a PGlite data directory on this machine (local builds)
//   postgres://… postgresql://…  a hosted Postgres (when Eden chooses one),
//                             through the `postgres` driver, loaded only then
//
// Both drivers are imported lazily, so with the feature off nothing is loaded
// and no connection is made. PGlite is a harness-only dependency (never in
// package.json; CI installs it with --no-save); `postgres` is a dependency,
// used only for a postgres:// URL.
//
// The adapter: { kind, query(sql, params) → {rows}, exec(sql), transaction(fn), close() }.

export const REGISTER_DB_ENV = 'TM_REGISTER_DB_URL';

const cache = new Map();

/** The configured URL, or null when the feature is off. */
export function registerDbUrl(env = process.env) {
  const u = String(env?.[REGISTER_DB_ENV] ?? '').trim();
  return u || null;
}

export class RegisterDbError extends Error {
  constructor(message, code = 'register_unavailable') { super(message); this.name = 'RegisterDbError'; this.code = code; }
}

async function openPglite(where) {
  let PGlite; let pg_trgm; let fuzzystrmatch;
  try {
    // Specifiers in variables: PGlite is never installed on the hosted server,
    // and the bundler must not try to trace it.
    const base = '@electric-sql/pglite';
    ({ PGlite } = await import(base));
    ({ pg_trgm } = await import(`${base}/contrib/pg_trgm`));
    ({ fuzzystrmatch } = await import(`${base}/contrib/fuzzystrmatch`));
  } catch {
    throw new RegisterDbError('A pglite: register URL needs PGlite (npm i --no-save @electric-sql/pglite@0.5.8).');
  }
  const db = where === 'memory'
    ? new PGlite({ extensions: { pg_trgm, fuzzystrmatch } })
    : new PGlite(where, { extensions: { pg_trgm, fuzzystrmatch } });
  await db.waitReady;
  return {
    kind: 'pglite',
    query: (sql, params = []) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction((tx) => fn({
      kind: 'pglite', query: (s, p = []) => tx.query(s, p), exec: (s) => tx.exec(s),
    })),
    close: () => db.close(),
  };
}

async function openPostgres(url) {
  let postgres;
  try {
    ({ default: postgres } = await import('postgres'));
  } catch {
    throw new RegisterDbError('A postgres:// register URL needs the postgres driver (npm i postgres).');
  }
  const sql = postgres(url, { max: 4, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} });
  const wrap = (s) => ({
    kind: 'postgres',
    query: async (q, p = []) => ({ rows: await s.unsafe(q, p) }),
    exec: async (q) => { await s.unsafe(q).simple(); },
  });
  return {
    ...wrap(sql),
    transaction: (fn) => sql.begin((tx) => fn(wrap(tx))),
    close: () => sql.end({ timeout: 5 }),
  };
}

/**
 * Open (once per process and URL) the register database.
 * @param {string} url
 * @param {{cached?:boolean}} [o]  cached:false = a new handle every call (tests)
 */
export async function openRegisterDb(url, { cached = true } = {}) {
  if (!url) throw new RegisterDbError('The register copy is not configured on this server.', 'not_configured');
  if (cached && cache.has(url)) return cache.get(url);
  const p = (async () => {
    if (url.startsWith('pglite:')) return openPglite(url.slice('pglite:'.length) || 'memory');
    if (/^postgres(ql)?:\/\//.test(url)) return openPostgres(url);
    throw new RegisterDbError(`${REGISTER_DB_ENV} must be pglite:memory, pglite:<directory> or a postgres:// URL.`, 'bad_config');
  })();
  if (!cached) return p;
  cache.set(url, p);
  try { return await p; } catch (err) { cache.delete(url); throw err; }
}

/** Forget a cached connection (tests). */
export async function closeRegisterDb(url) {
  const p = cache.get(url);
  cache.delete(url);
  if (p) { try { (await p).close(); } catch { /* already closed */ } }
}
