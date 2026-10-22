// scripts/tm-register/_args.mjs — the register scripts' argument reader.
export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) out[k] = true; else { out[k] = v; i++; }
    } else out._.push(a);
  }
  return out;
}

/** --db, else TM_REGISTER_DB_URL. */
export function dbUrl(a) {
  const u = typeof a.db === 'string' ? a.db : process.env.TM_REGISTER_DB_URL;
  if (!u) { console.error('Give --db <url> (pglite:<dir>, pglite:memory or postgres://…) or set TM_REGISTER_DB_URL.'); process.exit(2); }
  return u;
}
