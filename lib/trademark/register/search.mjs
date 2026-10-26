// lib/trademark/register/search.mjs — the agent's query set, run on the
// register copy.
//
// The queries are the SAME strings the agent hands a person for tmsearch
// (lib/trademark/queries.mjs generateQueries; the syntax table is spec §3,
// [V 10-18, USPTO "Federal trademark searching: Field tag searching"]). This
// file parses each string and translates it to one SQL WHERE clause, so a
// query means the same thing on both sources as far as the copy can say:
//
//   CM:term      a whole word of any CM variant (word mark, pseudo mark,
//                translation, transliteration, numeral reading) or a whole
//                run-together variant — exactly lib/trademark/queries.mjs
//                termMatchesMark, the rule the tests already pin.
//                Wildcards: * = any run of letters/digits, ? = one.
//   CM:"a b"     the words a b in that order inside one variant
//   CM:(x y z)   any of them (a space inside parentheses is OR)
//   SN: RN:      serial / registration number
//   LD:true|false  live / dead (status-codes.json; [M])
//   IC:code      the international class (009, A, B, 200)
//   ON: OW:      an owner name (word or quoted phrase). OW: on tmsearch also
//                covers the owner's address and entity; the copy reads owner
//                NAMES only (documented limit)
//   AT:          the attorney name
//   GS:          a word of the goods and services
//   FD:[a TO b]  filing date range, YYYYMMDD or *
//   AND, OR, AND NOT, NOT, parentheses
//
// NOT EXPRESSIBLE on the copy (the query is refused with this reason, never
// run as something else): CC: (coordinated class — needs the USPTO's
// coordination table, which is not in the bulk XML), and every other field
// tag. tmsearch's own tokenization of marks is not published; the copy's is
// termMatchesMark's. Whether they agree on every record is exactly what the
// recall gate measures.
//
// Results: the parse.mjs row shape tm_record_results already accepts, at
// most 500 rows (the run log's limit), ordered live first, then by closeness
// to the clearance's mark (trigram similarity of the run-together marks, and
// a Double Metaphone match), with the class overlap. The total count of
// matches is returned separately, so a capped run records a gap exactly as a
// capped tmsearch export does.

import { joinedMark, normalizeMark } from './normalize.mjs';

export const ENGINE_VERSION = 'tm-register-search/1';
export const MAX_ROWS = 500;

export class RegisterQueryUnsupported extends Error {
  constructor(message) { super(message); this.name = 'RegisterQueryUnsupported'; this.code = 'not_expressible'; }
}

// ---------------------------------------------------------------------------
// Lexer and parser
// ---------------------------------------------------------------------------
const OPS = new Set(['AND', 'OR', 'NOT']);

export function lex(q) {
  const s = String(q ?? '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(' || ch === ')') { out.push({ t: ch }); i++; continue; }
    if (ch === '"') {
      const j = s.indexOf('"', i + 1);
      if (j === -1) throw new RegisterQueryUnsupported('unbalanced quotes');
      out.push({ t: 'phrase', v: s.slice(i + 1, j) }); i = j + 1; continue;
    }
    if (ch === '[') {
      const j = s.indexOf(']', i + 1);
      if (j === -1) throw new RegisterQueryUnsupported('unbalanced range brackets');
      out.push({ t: 'range', v: s.slice(i + 1, j) }); i = j + 1; continue;
    }
    let j = i;
    while (j < s.length && !/[\s()"[]/.test(s[j])) j++;
    const word = s.slice(i, j);
    i = j;
    const tag = /^([A-Za-z]{2}):(.*)$/.exec(word);
    if (tag) {
      out.push({ t: 'tag', v: tag[1].toUpperCase() });
      if (tag[2]) out.push({ t: 'word', v: tag[2] });
      continue;
    }
    if (OPS.has(word)) { out.push({ t: word }); continue; }
    out.push({ t: 'word', v: word });
  }
  return out;
}

/**
 * The query as a tree: {op:'and'|'or', args} | {op:'not', arg} | {field, kind:'word'|'phrase'|'range', value}.
 * Adjacency is OR inside parentheses and AND at the top level.
 */
export function parseQuery(q) {
  const toks = lex(q);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];

  function primary(field, inGroup) {
    const tk = next();
    if (!tk) throw new RegisterQueryUnsupported('the query ends too early');
    if (tk.t === 'tag') return primary(tk.v, inGroup);
    if (tk.t === '(') {
      const e = expr(field, true);
      if (next()?.t !== ')') throw new RegisterQueryUnsupported('unbalanced parentheses');
      return e;
    }
    if (tk.t === 'word' || tk.t === 'phrase' || tk.t === 'range') {
      return { field: field ?? 'CM', kind: tk.t, value: tk.v };
    }
    throw new RegisterQueryUnsupported(`unexpected "${tk.t}"`);
  }
  function unary(field, inGroup) {
    if (peek()?.t === 'NOT') { next(); return { op: 'not', arg: unary(field, inGroup) }; }
    return primary(field, inGroup);
  }
  function andExpr(field, inGroup) {
    const args = [unary(field, inGroup)];
    for (;;) {
      const tk = peek();
      if (!tk || tk.t === ')' || tk.t === 'OR') break;
      if (tk.t === 'AND') {
        next();
        if (peek()?.t === 'NOT') { next(); args.push({ op: 'not', arg: unary(field, inGroup) }); } else args.push(unary(field, inGroup));
        continue;
      }
      if (inGroup) break; // adjacency inside parentheses is OR (handled by expr)
      args.push(unary(field, inGroup));
    }
    return args.length === 1 ? args[0] : { op: 'and', args };
  }
  function expr(field, inGroup) {
    const args = [andExpr(field, inGroup)];
    for (;;) {
      const tk = peek();
      if (!tk || tk.t === ')') break;
      if (tk.t === 'OR') { next(); args.push(andExpr(field, inGroup)); continue; }
      if (inGroup) { args.push(andExpr(field, inGroup)); continue; }
      break;
    }
    return args.length === 1 ? args[0] : { op: 'or', args };
  }
  const tree = expr(null, false);
  if (p !== toks.length) throw new RegisterQueryUnsupported('unbalanced parentheses');
  return tree;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------
/** A CM-style term → the regex body: * any letters/digits, ? one. */
export function termRegex(term) {
  const t = String(term).toLowerCase();
  if (!/^[a-z0-9?*]+$/.test(t)) throw new RegisterQueryUnsupported(`a term may hold letters, digits, ? and * only ("${term}")`);
  if (!/[a-z0-9]/.test(t)) throw new RegisterQueryUnsupported(`a term needs at least one letter or digit ("${term}")`);
  return t.replace(/\*/g, '[a-z0-9]*').replace(/\?/g, '[a-z0-9]');
}

/** The anchored pattern for a word or a phrase inside a ' v1 | v2 ' text column. */
export function wordPattern(kind, value) {
  if (kind === 'phrase') {
    const ws = normalizeMark(value).split(' ').filter(Boolean);
    if (!ws.length) throw new RegisterQueryUnsupported('an empty quoted phrase');
    return `(^|[ |])${ws.map((w) => termRegex(w)).join(' ')}([ |]|$)`;
  }
  return `(^|[ |])${termRegex(value)}([ |]|$)`;
}

const UNSUPPORTED = {
  CC: 'CC: (coordinated class) needs the USPTO coordination table, which is not in the bulk XML; run it on tmsearch',
};

/**
 * The tree → {sql, params}. `params` is extended in place (positional $n).
 */
export function toSql(node, params = []) {
  const add = (v) => { params.push(v); return `$${params.length}`; };
  const walk = (n) => {
    if (n.op === 'and') return `(${n.args.map(walk).join(' and ')})`;
    if (n.op === 'or') return `(${n.args.map(walk).join(' or ')})`;
    if (n.op === 'not') return `(not ${walk(n.arg)})`;
    const { field, kind, value } = n;
    if (UNSUPPORTED[field]) throw new RegisterQueryUnsupported(UNSUPPORTED[field]);
    switch (field) {
      case 'CM':
        if (kind === 'range') throw new RegisterQueryUnsupported('CM: takes a word or a quoted phrase');
        return `(r.cm_text ~ ${add(wordPattern(kind, value))})`;
      case 'ON': case 'OW':
        if (kind === 'range') throw new RegisterQueryUnsupported(`${field}: takes a word or a quoted phrase`);
        return `(r.owner_text ~ ${add(wordPattern(kind, value))})`;
      case 'GS':
        if (kind === 'range') throw new RegisterQueryUnsupported('GS: takes a word or a quoted phrase');
        return `(r.gs_text ~ ${add(wordPattern(kind, value))})`;
      case 'AT':
        if (kind === 'range') throw new RegisterQueryUnsupported('AT: takes a word or a quoted phrase');
        return `((' ' || regexp_replace(lower(coalesce(r.attorney_name, '')), '[^a-z0-9]+', ' ', 'g') || ' ') ~ ${add(wordPattern(kind, value))})`;
      case 'SN': {
        const d = String(value).replace(/\D/g, '');
        if (!/^\d{8}$/.test(d)) throw new RegisterQueryUnsupported(`SN: takes an 8-digit serial number ("${value}")`);
        return `(r.serial = ${add(d)})`;
      }
      case 'RN': {
        const d = String(value).replace(/\D/g, '').replace(/^0+/, '');
        if (!d) throw new RegisterQueryUnsupported(`RN: takes a registration number ("${value}")`);
        return `(r.registration_number = ${add(d)})`;
      }
      case 'LD':
        if (value === 'true') return '(r.live)';
        if (value === 'false') return '(not r.live)';
        throw new RegisterQueryUnsupported(`LD: takes true or false ("${value}")`);
      case 'IC': {
        const v = String(value).toUpperCase();
        let code;
        if (/^\d{1,3}$/.test(v)) code = v === '200' ? '200' : v.padStart(3, '0');
        else if (v === 'A' || v === 'B') code = v;
        else throw new RegisterQueryUnsupported(`IC: takes a class code (009, A, B, 200) ("${value}")`);
        return `(r.int_classes @> array[${add(code)}]::text[])`;
      }
      case 'FD': {
        if (kind !== 'range') {
          const d = /^(\d{4})(\d{2})(\d{2})$/.exec(String(value));
          if (!d) throw new RegisterQueryUnsupported(`FD: takes YYYYMMDD or [from TO to] ("${value}")`);
          return `(r.filing_date = ${add(`${d[1]}-${d[2]}-${d[3]}`)}::date)`;
        }
        const m = /^\s*(\S+)\s+TO\s+(\S+)\s*$/.exec(value);
        if (!m) throw new RegisterQueryUnsupported(`FD: range must be [from TO to] ("${value}")`);
        const bound = (b) => {
          if (b === '*') return null;
          const d = /^(\d{4})(\d{2})(\d{2})$/.exec(b);
          if (!d) throw new RegisterQueryUnsupported(`FD: dates are YYYYMMDD or * ("${b}")`);
          return `${d[1]}-${d[2]}-${d[3]}`;
        };
        const lo = bound(m[1]); const hi = bound(m[2]);
        const parts = [];
        if (lo) parts.push(`r.filing_date >= ${add(lo)}::date`);
        if (hi) parts.push(`r.filing_date <= ${add(hi)}::date`);
        return parts.length ? `(${parts.join(' and ')})` : '(r.filing_date is not null)';
      }
      default:
        throw new RegisterQueryUnsupported(`${field}: is not a field the register copy holds; run this query on tmsearch`);
    }
  };
  return { sql: walk(node), params };
}

/** Whether the copy can run this query string, and if not, why. */
export function expressible(query) {
  try { toSql(parseQuery(query)); return { ok: true }; } catch (err) {
    if (err instanceof RegisterQueryUnsupported) return { ok: false, reason: err.message };
    throw err;
  }
}

/**
 * Run one query on the copy.
 * @param {object} db  register db adapter
 * @param {string} query  the query string exactly as generated
 * @param {{mark?:string, searchClasses?:string[], limit?:number, asOf?:string|null}} [o]
 * @returns {Promise<{count:number, rows:object[]}>}
 */
export async function runQuery(db, query, { mark = '', searchClasses = [], limit = MAX_ROWS, asOf = null } = {}) {
  const { sql: where, params } = toSql(parseQuery(query));
  const qj = joinedMark(mark);
  const qn = normalizeMark(mark);
  const pj = `$${params.push(qj)}`;
  const pn = `$${params.push(qn)}`;
  const cls = [...new Set((searchClasses ?? []).map((c) => (/^\d+$/.test(String(c)) ? String(c).padStart(3, '0') : String(c).toUpperCase())))];
  const pc = `$${params.push(cls)}::text[]`;
  const pl = `$${params.push(Math.max(0, Math.min(MAX_ROWS, limit)))}`;
  const total = await db.query(`select count(*)::int as n from register_records r where ${where}`, params.slice(0, params.length - 4));
  const res = await db.query(`
    select r.serial, r.registration_number, r.mark, r.owner, r.status_code, r.live, r.int_classes, r.goods,
           to_char(r.filing_date, 'YYYY-MM-DD') as filing_date, to_char(r.registration_date, 'YYYY-MM-DD') as registration_date,
           to_char(r.abandonment_date, 'YYYY-MM-DD') as abandonment_date, to_char(r.cancellation_date, 'YYYY-MM-DD') as cancellation_date,
           r.pseudo_marks, r.design_codes, to_char(r.as_of, 'YYYY-MM-DD') as row_as_of,
           round((similarity(r.mark_joined, ${pj}) * 100)::numeric)::int as closeness,
           (r.dm_codes && register_dm(${pn}, ${pj})) as sounds_alike,
           array(select unnest(r.int_classes) intersect select unnest(${pc}) order by 1) as class_overlap
      from register_records r
     where ${where}
     order by r.live desc, closeness desc, sounds_alike desc, r.serial
     limit ${pl}`, params);
  return { count: total.rows[0]?.n ?? 0, rows: res.rows.map((r) => toRunRow(r, asOf)) };
}

/** A register row → the parse.mjs row shape (serial, mark, owner, status, live, classes, goods, …, raw). */
export function toRunRow(r, asOf = null) {
  const bits = [];
  if (r.status_code) bits.push(`status code ${r.status_code}`);
  if (r.abandonment_date) bits.push(`abandoned ${r.abandonment_date}`);
  if (r.cancellation_date) bits.push(`cancelled ${r.cancellation_date}`);
  const goods = (Array.isArray(r.goods) ? r.goods : []).map((g) => `IC ${g.class}: ${g.text}`).join('; ');
  // Clipped to the hit table's limits (migration 121: mark and owner 500, status 200): a register mark can be longer.
  const clip = (v, n) => (v == null ? null : String(v).length > n ? `${String(v).slice(0, n - 1)}…` : String(v));
  return {
    serial: r.serial,
    registration_number: r.registration_number ?? null,
    mark: clip(r.mark, 500),
    owner: clip(r.owner, 500),
    status: clip(`${r.live ? 'LIVE' : 'DEAD'}${bits.length ? ` — ${bits.join(', ')}` : ''}`, 200),
    live: Boolean(r.live),
    classes: r.int_classes ?? [],
    goods: goods ? goods.slice(0, 4000) : null,
    filing_date: r.filing_date ?? null,
    // Strings, like an export's unmapped columns, so the hit's raw reads the same everywhere.
    raw: {
      source: 'register_copy',
      ...(asOf ? { as_of: String(asOf) } : {}),
      ...(r.closeness != null ? { closeness: String(r.closeness) } : {}),
      sounds_alike: r.sounds_alike ? 'yes' : 'no',
      class_overlap: (r.class_overlap ?? []).join(' '),
      ...(r.pseudo_marks?.length ? { pseudo_mark: r.pseudo_marks.join(' | ') } : {}),
      ...(r.design_codes?.length ? { design_codes: r.design_codes.join(' ') } : {}),
      ...(r.registration_date ? { registration_date: r.registration_date } : {}),
    },
  };
}
