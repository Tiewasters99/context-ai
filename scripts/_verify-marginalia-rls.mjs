// End-to-end verification of the marginalia write/read path as the REAL
// user (not service role), so RLS is genuinely exercised. Checks the bug
// class that bit migrations 022 and 047: INSERT .. RETURNING failing the
// SELECT policy. Also proves the PostgREST embed syntax the reader uses
// (FK-disambiguated profiles join) actually resolves.
//
// Creates one note + one link on a real document, then DELETES both.
import fs from 'node:fs/promises';

const txt = await fs.readFile('C:/Users/equai/context-ai/.env', 'utf8');
const env = {};
for (const line of txt.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const URL_ = env.VITE_SUPABASE_URL;
const SRK = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.VITE_SUPABASE_ANON_KEY;

const j = async (res) => {
  const t = await res.text();
  try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: t }; }
};
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => { console.log(`  FAIL  ${m}\n        ${typeof d === 'string' ? d : JSON.stringify(d).slice(0, 300)}`); failures++; };
let failures = 0;

// ── sign in as the real user ──────────────────────────────────────────
let r = await j(await fetch(`${URL_}/auth/v1/admin/generate_link`, {
  method: 'POST',
  headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', email: 'equainton@gmail.com' }),
}));
const tokenHash = r.body?.hashed_token ?? r.body?.properties?.hashed_token;
if (!tokenHash) { console.log('generate_link failed', r.status); process.exit(1); }
r = await j(await fetch(`${URL_}/auth/v1/verify`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
}));
const jwt = r.body?.access_token;
const uid = r.body?.user?.id;
if (!jwt) { console.log('verify failed', r.status, JSON.stringify(r.body).slice(0, 200)); process.exit(1); }
console.log(`signed in as ${r.body.user.email}\n`);
const UH = { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };

// ── pick a real document, preferring a transcript (exercises page:line) ─
let doc = null;
for (const q of [
  'documents?select=id,title,matterspace_id,doc_type&doc_type=in.(deposition,transcript)&matterspace_id=not.is.null&limit=1',
  'documents?select=id,title,matterspace_id,doc_type&matterspace_id=not.is.null&limit=1',
]) {
  const g = await j(await fetch(`${URL_}/rest/v1/${q}`, { headers: UH }));
  if (Array.isArray(g.body) && g.body.length) { doc = g.body[0]; break; }
}
if (!doc) { console.log('no accessible document found'); process.exit(1); }
console.log(`test document: "${doc.title}" (${doc.doc_type ?? 'n/a'})\n`);

// ── 1. INSERT .. RETURNING as the real user (the 42501 bug class) ──────
const ins = await j(await fetch(`${URL_}/rest/v1/document_annotations?select=id,visibility,line_start`, {
  method: 'POST',
  headers: { ...UH, Prefer: 'return=representation' },
  body: JSON.stringify({
    document_id: doc.id,
    user_id: uid,
    page: 1,
    color: 'gold',
    note: '[automated verification note — safe to delete]',
    anchor_text: 'verification anchor',
    rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }],
    visibility: 'matter',
  }),
}));
const noteId = Array.isArray(ins.body) ? ins.body[0]?.id : null;
if (noteId) pass('INSERT .. RETURNING on document_annotations (RLS SELECT policy passes)');
else { fail('INSERT .. RETURNING on document_annotations', ins.body); process.exit(1); }

// ── 2. annotation_links insert ────────────────────────────────────────
const lnk = await j(await fetch(`${URL_}/rest/v1/annotation_links?select=id`, {
  method: 'POST',
  headers: { ...UH, Prefer: 'return=representation' },
  body: JSON.stringify({
    annotation_id: noteId,
    target_document_id: doc.id,
    target_page: 2,
    label: 'verification link',
  }),
}));
const linkId = Array.isArray(lnk.body) ? lnk.body[0]?.id : null;
if (linkId) pass('INSERT .. RETURNING on annotation_links');
else fail('INSERT .. RETURNING on annotation_links', lnk.body);

// ── 3. the reader's exact SELECT (FK-disambiguated embeds) ────────────
const SEL =
  'id,document_id,user_id,page,color,note,anchor_text,rects,visibility,line_start,line_end,created_at,updated_at,' +
  'author:profiles!document_annotations_user_id_fkey(id,display_name,email,avatar_url),' +
  'links:annotation_links(id,target_document_id,target_page,target_line,label,target:documents(id,title))';
const read = await j(await fetch(
  `${URL_}/rest/v1/document_annotations?select=${encodeURIComponent(SEL)}&document_id=eq.${doc.id}&order=created_at.asc`,
  { headers: UH },
));
if (Array.isArray(read.body)) {
  const row = read.body.find((a) => a.id === noteId);
  if (!row) fail('reader SELECT returned rows but not the new note', read.body);
  else {
    pass('reader SELECT with author + links embeds resolves');
    if (row.author && 'display_name' in row.author) pass(`  author embed populated (${row.author.display_name ?? row.author.email})`);
    else fail('  author embed empty — FK name wrong?', row.author);
    if (Array.isArray(row.links) && row.links.length === 1 && row.links[0].target?.title) pass(`  links embed populated (target: "${row.links[0].target.title}")`);
    else fail('  links embed wrong shape', row.links);
  }
} else fail('reader SELECT failed', read.body);

// ── 4. the incoming-links (cross-reference) query ─────────────────────
const INC =
  'id,target_page,target_line,label,' +
  'annotation:document_annotations!annotation_links_annotation_id_fkey(id,document_id,page,note,anchor_text,user_id,document:documents(id,title))';
const inc = await j(await fetch(
  `${URL_}/rest/v1/annotation_links?select=${encodeURIComponent(INC)}&target_document_id=eq.${doc.id}`,
  { headers: UH },
));
if (Array.isArray(inc.body) && inc.body.some((x) => x.annotation?.document?.title)) pass('cross-reference SELECT (listIncomingLinks) resolves');
else fail('cross-reference SELECT failed', inc.body);

// ── 5. visibility flip (private) ──────────────────────────────────────
const upd = await j(await fetch(`${URL_}/rest/v1/document_annotations?id=eq.${noteId}&select=visibility`, {
  method: 'PATCH',
  headers: { ...UH, Prefer: 'return=representation' },
  body: JSON.stringify({ visibility: 'private' }),
}));
if (Array.isArray(upd.body) && upd.body[0]?.visibility === 'private') pass('visibility flip to private (author still sees own row)');
else fail('visibility flip failed', upd.body);

// ── 6. check constraint actually enforces the enum ────────────────────
const bad = await j(await fetch(`${URL_}/rest/v1/document_annotations?id=eq.${noteId}`, {
  method: 'PATCH', headers: UH, body: JSON.stringify({ visibility: 'public' }),
}));
if (bad.status >= 400) pass('visibility CHECK constraint rejects unknown values');
else fail('CHECK constraint did not reject visibility=public', bad.body);

// ── cleanup ───────────────────────────────────────────────────────────
if (linkId) await fetch(`${URL_}/rest/v1/annotation_links?id=eq.${linkId}`, { method: 'DELETE', headers: UH });
const del = await fetch(`${URL_}/rest/v1/document_annotations?id=eq.${noteId}`, { method: 'DELETE', headers: UH });
const gone = await j(await fetch(`${URL_}/rest/v1/document_annotations?select=id&id=eq.${noteId}`, { headers: UH }));
if (del.status < 300 && Array.isArray(gone.body) && gone.body.length === 0) pass('cleanup: test note + link deleted');
else fail('cleanup left rows behind', gone.body);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
