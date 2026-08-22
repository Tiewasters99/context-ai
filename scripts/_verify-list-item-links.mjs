// End-to-end verification of the list-item → page / sub-matter links as the
// REAL user (never the service role), so RLS is genuinely exercised. Mirrors
// exactly the calls ListView.tsx makes:
//
//   (a) "Open as page"     — create a content_items row of type 'page' in the
//                            list's space, store linked_page_id on the item.
//   (b) "Make sub-matter"  — insert a matterspaces row under the list's matter
//                            (the NewMatterModal path), seed it with a list of
//                            the same name, store linked_matter_id on the item.
//   (c) the dead-link sweep — the id probes that clear a marker whose target
//                            has been deleted.
//
// Everything it creates is deleted again at the end.
//
//   node scripts/_verify-list-item-links.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const txt = await fs.readFile(path.join(here, '..', '.env'), 'utf8');
const env = {};
for (const line of txt.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const URL_ = env.VITE_SUPABASE_URL;
const SRK = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.VITE_SUPABASE_ANON_KEY;
const EMAIL = process.env.VERIFY_EMAIL || 'equainton@gmail.com';

const j = async (res) => {
  const t = await res.text();
  try { return { status: res.status, body: t ? JSON.parse(t) : null }; } catch { return { status: res.status, body: t }; }
};
let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => {
  console.log(`  FAIL  ${m}\n        ${typeof d === 'string' ? d : JSON.stringify(d).slice(0, 300)}`);
  failures++;
};

// ── sign in as the real user (service role only mints the link) ─────────
let r = await j(await fetch(`${URL_}/auth/v1/admin/generate_link`, {
  method: 'POST',
  headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', email: EMAIL }),
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
const RET = { ...UH, Prefer: 'return=representation' };

const rest = (q, init) => fetch(`${URL_}/rest/v1/${q}`, init).then(j);

// ── pick a host matterspace the user can actually write to ─────────────
const hosts = await rest('matterspaces?select=id,name,serverspace_id&order=created_at.asc&limit=25', { headers: UH });
if (!Array.isArray(hosts.body) || hosts.body.length === 0) {
  console.log('no accessible matterspace found'); process.exit(1);
}
const host = hosts.body[hosts.body.length - 1];
console.log(`host matter: "${host.name}" (${host.id})\n`);

const stamp = Date.now().toString(36);
const ITEM_A = { id: randomUUID(), text: `Verification item A ${stamp}`, done: false, due: null, linked_page_id: null, linked_matter_id: null };
const ITEM_B = { id: randomUUID(), text: `Verification item B ${stamp}`, done: false, due: null, linked_page_id: null, linked_matter_id: null };

const created = { contentItems: [], matterspaces: [] };

// ── the scratch list ───────────────────────────────────────────────────
let res = await rest('content_items?select=*', {
  method: 'POST', headers: RET,
  body: JSON.stringify({
    space_id: host.id, space_type: 'matterspace', content_type: 'list',
    title: `Scratch — list-item links ${stamp}`,
    content: { items: [ITEM_A, ITEM_B] }, created_by: uid,
  }),
});
const list = Array.isArray(res.body) ? res.body[0] : null;
if (!list) { fail('create scratch list', res.body); process.exit(1); }
created.contentItems.push(list.id);
pass(`scratch list created (${list.id})`);

try {
  // ── (a) "Open as page" ───────────────────────────────────────────────
  res = await rest('content_items?select=*', {
    method: 'POST', headers: RET,
    body: JSON.stringify({
      space_id: list.space_id, space_type: list.space_type, content_type: 'page',
      title: ITEM_A.text, content: {}, created_by: uid,
    }),
  });
  const page = Array.isArray(res.body) ? res.body[0] : null;
  if (!page) fail('create linked page (INSERT..RETURNING under RLS)', res.body);
  else {
    created.contentItems.push(page.id);
    pass(`linked page created in the same space (${page.id})`);

    const withPage = [{ ...ITEM_A, linked_page_id: page.id }, ITEM_B];
    res = await rest(`content_items?id=eq.${list.id}`, {
      method: 'PATCH', headers: UH, body: JSON.stringify({ content: { items: withPage } }),
    });
    if (res.status >= 300) fail('store linked_page_id on the item', res.body);
    else pass('linked_page_id stored on the item');
  }

  // ── (b) "Make sub-matter" ────────────────────────────────────────────
  res = await rest('matterspaces?select=id,name,short_code,parent_matterspace_id,serverspace_id', {
    method: 'POST', headers: RET,
    body: JSON.stringify({
      serverspace_id: host.serverspace_id,
      parent_matterspace_id: host.id,
      name: ITEM_B.text,
      short_code: `scratch-verify-${stamp}`,
      description: null,
    }),
  });
  const sub = Array.isArray(res.body) ? res.body[0] : null;
  if (!sub) fail('create sub-matter under the list\'s matter', res.body);
  else {
    created.matterspaces.push(sub.id);
    if (sub.parent_matterspace_id === host.id) pass('sub-matter nests under the list\'s matter');
    else fail('sub-matter parent', sub);
    if (sub.serverspace_id === host.serverspace_id) pass('sub-matter inherits the parent serverspace');
    else fail('sub-matter serverspace', sub);

    res = await rest('content_items?select=*', {
      method: 'POST', headers: RET,
      body: JSON.stringify({
        space_id: sub.id, space_type: 'matterspace', content_type: 'list',
        title: ITEM_B.text, content: { items: [] }, created_by: uid,
      }),
    });
    const seeded = Array.isArray(res.body) ? res.body[0] : null;
    if (!seeded) fail('seed the sub-matter with a list of the same name', res.body);
    else {
      created.contentItems.push(seeded.id);
      pass(`sub-matter seeded with list "${seeded.title}"`);
    }

    const current = await rest(`content_items?id=eq.${list.id}&select=content`, { headers: UH });
    const items = current.body?.[0]?.content?.items ?? [];
    const withMatter = items.map((i) => (i.id === ITEM_B.id ? { ...i, linked_matter_id: sub.id } : i));
    res = await rest(`content_items?id=eq.${list.id}`, {
      method: 'PATCH', headers: UH, body: JSON.stringify({ content: { items: withMatter } }),
    });
    if (res.status >= 300) fail('store linked_matter_id on the item', res.body);
    else pass('linked_matter_id stored on the item');
  }

  // ── reload: both links survive a round trip ──────────────────────────
  const reload = await rest(`content_items?id=eq.${list.id}&select=content`, { headers: UH });
  const back = reload.body?.[0]?.content?.items ?? [];
  const a = back.find((i) => i.id === ITEM_A.id);
  const b = back.find((i) => i.id === ITEM_B.id);
  if (a?.linked_page_id) pass('after reload, item A still carries linked_page_id');
  else fail('item A lost linked_page_id', back);
  if (b?.linked_matter_id) pass('after reload, item B still carries linked_matter_id');
  else fail('item B lost linked_matter_id', back);

  // ── (c) the dead-link sweep ──────────────────────────────────────────
  // Live targets are seen, so nothing is cleared.
  const liveP = await rest(`content_items?select=id&id=in.(${a.linked_page_id})`, { headers: UH });
  const liveM = await rest(`matterspaces?select=id&id=in.(${b.linked_matter_id})`, { headers: UH });
  if (liveP.body?.length === 1 && liveM.body?.length === 1) pass('sweep sees both live targets (markers stay)');
  else fail('sweep probe on live targets', { liveP: liveP.body, liveM: liveM.body });

  // Delete the targets; the same probes must now come back empty, which is
  // what makes the markers clear on the next load.
  await rest(`content_items?id=eq.${a.linked_page_id}`, { method: 'DELETE', headers: UH });
  created.contentItems = created.contentItems.filter((x) => x !== a.linked_page_id);
  const deadP = await rest(`content_items?select=id&id=in.(${a.linked_page_id})`, { headers: UH });
  if (deadP.status === 200 && deadP.body?.length === 0) pass('deleted page reads back as gone (marker clears)');
  else fail('sweep probe after deleting the page', deadP);

  const deadIdM = b.linked_matter_id;
  await rest(`content_items?space_id=eq.${deadIdM}`, { method: 'DELETE', headers: UH });
  await rest(`matterspaces?id=eq.${deadIdM}`, { method: 'DELETE', headers: UH });
  const deadM = await rest(`matterspaces?select=id&id=in.(${deadIdM})`, { headers: UH });
  if (deadM.status === 200 && deadM.body?.length === 0) {
    pass('deleted sub-matter reads back as gone (marker clears)');
    created.matterspaces = created.matterspaces.filter((x) => x !== deadIdM);
  } else fail('sweep probe after deleting the sub-matter', deadM);

  // ── the disabled case: a list filed straight into a serverspace ──────
  const ssList = await rest(
    'content_items?select=id,space_type&content_type=eq.list&space_type=eq.serverspace&limit=1',
    { headers: UH },
  );
  console.log(
    `\n  note  lists filed directly in a serverspace: ${
      Array.isArray(ssList.body) ? ssList.body.length : '?'
    } found — those rows have no parent matterspace, so "Make sub-matter" renders disabled.`,
  );
} finally {
  // ── cleanup ────────────────────────────────────────────────────────────
  for (const id of created.matterspaces) {
    await rest(`content_items?space_id=eq.${id}`, { method: 'DELETE', headers: UH });
    await rest(`matterspaces?id=eq.${id}`, { method: 'DELETE', headers: UH });
  }
  for (const id of created.contentItems) {
    await rest(`content_items?id=eq.${id}`, { method: 'DELETE', headers: UH });
  }
  const leftovers = await rest(
    `content_items?select=id&id=in.(${created.contentItems.join(',') || '00000000-0000-0000-0000-000000000000'})`,
    { headers: UH },
  );
  console.log(`\ncleanup: ${leftovers.body?.length === 0 ? 'all scratch objects removed' : 'CHECK — leftovers ' + JSON.stringify(leftovers.body)}`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
