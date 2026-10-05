// What breaks in Contextspaces, and why — the Orchestrator's known-issues
// lookup (Fable's review of 10-02, P1; docs/orchestrator/known-issues/).
//
// One Markdown file per issue, with a deliberately small header the parser
// below reads (no YAML dependency): `key: value` lines and `key:` followed by
// `- item` lines. The body below the header is for people and is not read.
// scripts/build-known-issues.mjs compiles the files, plus main's commit order,
// into lib/known-issues.generated.mjs; the tool reads only that.
//
// Two audiences, two fields: `say` is what the person hears; `note` is for the
// team and is NEVER returned by the lookup (it goes to an escalation report).
// Matching is deterministic — exact product strings first, then plain words —
// so it is testable offline and cannot invent an entry.

export const STATUSES = ['open', 'fixed', 'by-design'];

/** Where a person can be standing. 'any' matches everywhere. */
export const SURFACES = ['any', 'brief-desk', 'vault', 'reader', 'matter', 'cite-check', 'connections', 'settings', 'sign-in', 'assistant'];

/** Fields that are lists; everything else is a single line of text. */
const LIST_FIELDS = new Set(['surfaces', 'symptoms', 'words', 'user_can', 'orchestrator_can', 'seen']);
const REQUIRED = ['id', 'title', 'status', 'surfaces', 'cause', 'say', 'escalate_when'];

/** Parse one entry file. Throws with the file's name and line on anything it does not understand. */
export function parseEntry(text, name = 'entry') {
  const src = text.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(src);
  if (!m) throw new Error(`${name}: no --- header ---`);
  const out = {};
  let list = null;
  m[1].split('\n').forEach((line, i) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      if (!list) throw new Error(`${name}:${i + 2}: a "- item" with no list above it`);
      out[list].push(item[1].trim());
      return;
    }
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${name}:${i + 2}: cannot read "${line}"`);
    const [, key, value] = kv;
    if (LIST_FIELDS.has(key)) {
      if (value) throw new Error(`${name}:${i + 2}: "${key}" is a list — put each item on its own "- " line`);
      out[key] = [];
      list = key;
    } else {
      out[key] = value.trim();
      list = null;
    }
  });
  for (const k of LIST_FIELDS) out[k] = out[k] ?? [];
  return out;
}

/** Problems with an entry, as sentences; [] when it is sound. */
export function entryProblems(e) {
  const p = [];
  for (const k of REQUIRED) if (!e[k] || (Array.isArray(e[k]) && !e[k].length)) p.push(`${e.id ?? '?'}: missing ${k}`);
  if (e.id && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.id)) p.push(`${e.id}: id must be kebab-case`);
  if (e.status && !STATUSES.includes(e.status)) p.push(`${e.id}: status must be one of ${STATUSES.join(', ')}`);
  if (e.status === 'fixed' && !/^[0-9a-f]{7,40}$/.test(e.fixed_in ?? '')) p.push(`${e.id}: a fixed entry needs fixed_in (a commit on main)`);
  for (const s of e.surfaces ?? []) if (!SURFACES.includes(s)) p.push(`${e.id}: unknown surface "${s}"`);
  // What the person hears carries no developer time and no operator business.
  const spoken = [e.say, ...(e.user_can ?? [])].join(' ');
  const FORBIDDEN = [/\bPR\s*#?\d/i, /#\d{3}\b/, /\b[0-9a-f]{7,40}\b/, /\bEden\b/, /\bmigration\b/i, /vercel|dunning|past[- ]due|google cloud|fly\.io|supabase|postgrest|github/i];
  for (const re of FORBIDDEN) if (re.test(spoken)) p.push(`${e.id}: "say"/"user_can" must not mention ${re}`);
  return p;
}

/** Which surface a route is (the panel sends the route). */
export function surfaceForRoute(route) {
  const r = String(route ?? '');
  if (/^\/app\/brief/.test(r)) return 'brief-desk';
  if (/^\/app\/vault/.test(r)) return 'vault';
  if (/^\/app\/document/.test(r)) return 'reader';
  if (/^\/app\/(matterspace|serverspace)/.test(r)) return 'matter';
  if (/^\/app\/connections/.test(r)) return 'connections';
  if (/^\/app\/settings/.test(r)) return 'settings';
  if (/^\/(auth|login|signup)/.test(r)) return 'sign-in';
  return 'any';
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

/**
 * Where a fix stands for this person: in the version their tab runs, on the
 * server but not in their tab yet, or not live at all. `order` is main's
 * first-parent commits (12 hex), oldest first. A build or a fix the table does
 * not know is newer than the table — it has the fix.
 */
export function fixStatus(fixedIn, { build, serverBuild, order = [] } = {}) {
  const at = new Map(order.map((c, i) => [c, i]));
  const idx = (sha) => (sha && /^[0-9a-f]{7,40}$/i.test(sha) ? at.get(sha.slice(0, 12).toLowerCase()) : undefined);
  const fix = idx(fixedIn);
  if (fix === undefined) return 'in_your_build';
  if (!build || !/^[0-9a-f]{7,40}$/i.test(build)) return 'fixed';
  const b = idx(build);
  if (b === undefined || b >= fix) return 'in_your_build';
  const s = idx(serverBuild);
  return s === undefined || s >= fix ? 'reload_to_get_it' : 'not_yet_live';
}

const STATUS_WORDS = {
  open: 'Still open — not fixed yet.',
  'by-design': 'Works as designed.',
  in_your_build: 'Fixed in the version their tab is running. If they still see it, it is something else — check, or write it up.',
  reload_to_get_it: 'Fixed, but their tab is running an older version: a reload at a stopping point (after their work is saved) brings the fix.',
  not_yet_live: 'Fixed, but not live yet.',
  fixed: 'Fixed. If they still see it, a reload at a stopping point is the first step.',
};

/**
 * The entries that match what the person said, best first (at most `limit`),
 * each with where it stands for them. Never returns an entry's `note`.
 */
export function matchKnownIssues(data, { words = '', surface = 'any', build, serverBuild, limit = 5, now = Date.now() } = {}) {
  const q = norm(words);
  const tokens = new Set(q.split(/[^a-z0-9§']+/).filter((t) => t.length > 2));
  const order = data.order ?? [];
  const dated = new Map((data.dates ?? []).map(([c, d]) => [c, d]));
  const scored = [];
  for (const e of data.entries ?? []) {
    const here = e.surfaces.includes('any') || surface === 'any' || e.surfaces.includes(surface);
    let score = 0;
    for (const s of e.symptoms) if (s && q.includes(norm(s))) score += 10;
    for (const w of e.words) {
      const nw = norm(w);
      if (nw.includes(' ') ? q.includes(nw) : tokens.has(nw)) score += 3;
    }
    if (!score) continue;
    if (!here) score -= 4; // another room's entry can still match, but ranks below this room's
    if (score <= 0) continue;
    // A fix older than 60 days on main has answered its stale tabs; it retires.
    if (e.status === 'fixed') {
      const d = dated.get(String(e.fixed_in).slice(0, 12));
      if (d && now - Date.parse(d) > 60 * 864e5) continue;
    }
    scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id));
  return scored.slice(0, limit).map(({ e }) => {
    const where = e.status === 'fixed' ? fixStatus(e.fixed_in, { build, serverBuild, order }) : e.status;
    return {
      id: e.id,
      title: e.title,
      status: where,
      status_means: STATUS_WORDS[where],
      cause: e.cause,
      say: e.say,
      user_can: e.user_can,
      orchestrator_can: e.orchestrator_can,
      escalate_when: e.escalate_when,
      ...(e.seen.length ? { seen: e.seen } : {}),
    };
  });
}
