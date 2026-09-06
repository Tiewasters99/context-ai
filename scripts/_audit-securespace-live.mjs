// SecureSpace live audit (2026-09-04) — exercises BOTH use cases on PROD with a
// fictional born-sealed fixture matter, then deletes everything it made.
//
//   node scripts/_audit-securespace-live.mjs
//
// Use case 1 — sealed chat:   /api/assistant on a Tier-B matter → which pen?
// Use case 2 — sealed upload: a .txt and an image-only PDF through the deployed
//              worker → status / passages / embedding space; then the sealed
//              pen is asked to find the text through its tools.
// Gate probes: /api/llm bound to the sealed matter for openai / google /
//              anthropic — the last one is the known escalation hole.
//
// Fictional content ONLY. Signs in as the real user via magiclink (the
// repo's established harness pattern). Cleans up in `finally`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }),
);
const SB = env.VITE_SUPABASE_URL, SRK = env.SUPABASE_SERVICE_ROLE_KEY, ANON = env.VITE_SUPABASE_ANON_KEY;
const BASE = process.argv[2] || 'https://www.contextspaces.ai';
const supabase = createClient(SB, SRK, { auth: { persistSession: false } });
const H = { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json' };
const tag = Date.now().toString(36);
const SERVERSPACE = '7b98c8f9-2bd8-4603-aa11-6797075fb363'; // Product Development

const log = (m) => console.log(m);
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${JSON.stringify(d).slice(0, 500)}` : ''}`);
const note = (m) => console.log(`  NOTE  ${m}`);

// ── sign in as the real user ───────────────────────────────────────────────
async function signIn() {
  let r = await fetch(`${SB}/auth/v1/admin/generate_link`, {
    method: 'POST', headers: H, body: JSON.stringify({ type: 'magiclink', email: 'equainton@gmail.com' }),
  });
  const b = await r.json();
  const th = b?.hashed_token ?? b?.properties?.hashed_token;
  r = await fetch(`${SB}/auth/v1/verify`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: th }),
  });
  const v = await r.json();
  if (!v?.access_token) throw new Error('sign-in failed: ' + JSON.stringify(v).slice(0, 200));
  return v.access_token;
}

async function ask(jwt, matterId, text, extra = {}) {
  const res = await fetch(`${BASE}/api/assistant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: text }], matterId, context: { route: '/audit' }, ...extra }),
  });
  if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) {
    return { status: res.status, events: [], body: await res.text().catch(() => '') };
  }
  const events = [];
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) { try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* skip */ } }
    }
  }
  return { status: res.status, events };
}
const ev = (events, type) => events.find((e) => e.type === type);
const textOf = (events) => events.filter((e) => e.type === 'text').map((e) => e.text).join('');

async function llm(jwt, provider, model, matterId) {
  const body = provider === 'google'
    ? JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with one word: fixture.' }] }], generationConfig: { maxOutputTokens: 8 } })
    : provider === 'openai'
      ? JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with one word: fixture.' }] })
      : JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with one word: fixture.' }] });
  const res = await fetch(`${BASE}/api/llm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ provider, model, body, ...(matterId ? { matterId } : {}) }),
  });
  const t = await res.text();
  return { status: res.status, body: t.slice(0, 300) };
}

// ── fixture ────────────────────────────────────────────────────────────────
const made = { matter: null, docs: [], jobs: [], sessions: [] };

async function fileViaQueue(matterId, createdBy, { title, filename, bytes, contentType }) {
  const { data: row, error } = await supabase.from('documents').insert({
    matterspace_id: matterId, title, doc_type: 'other', source_filename: filename,
    file_size_bytes: bytes.length, processing_status: 'pending', created_by: createdBy,
  }).select('id').single();
  if (error) throw new Error(`insert ${title}: ${error.message}`);
  made.docs.push(row.id);
  const storagePath = `${matterId}/${row.id}/${filename}`;
  const { error: upErr } = await supabase.storage.from('vault-documents').upload(storagePath, bytes, { contentType, upsert: true });
  if (upErr) throw new Error(`upload ${title}: ${upErr.message}`);
  await supabase.from('documents').update({ storage_path: storagePath }).eq('id', row.id);
  const { data: job, error: qErr } = await supabase.from('processing_jobs').insert({
    matterspace_id: matterId, job_type: 'ingest_document', payload: { document_id: row.id },
  }).select('id').single();
  if (qErr) throw new Error(`enqueue ${title}: ${qErr.message}`);
  made.jobs.push(job.id);
  return row.id;
}

async function waitTerminal(id, ms = 7 * 60_000) {
  const t0 = Date.now(); let last = '';
  while (Date.now() - t0 < ms) {
    const { data } = await supabase.from('documents').select('processing_status, processing_error, metadata').eq('id', id).single();
    const s = data?.processing_status;
    if (s !== last) { log(`       ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s  ${s}`); last = s; }
    if (['ready', 'error', 'held'].includes(s)) return data;
    await new Promise((r) => setTimeout(r, 4000));
  }
  return { processing_status: 'TIMEOUT' };
}

(async () => {
  log(`target: ${BASE}\n`);
  const { count: queued } = await supabase.from('processing_jobs').select('id', { count: 'exact', head: true }).eq('status', 'queued');
  const { count: running } = await supabase.from('processing_jobs').select('id', { count: 'exact', head: true }).eq('status', 'running');
  note(`worker queue right now: ${queued} queued, ${running} running`);

  const jwt = await signIn();
  pass('signed in as the real user (magiclink)');

  const { data: m, error: mErr } = await supabase.from('matterspaces').insert({
    serverspace_id: SERVERSPACE, parent_matterspace_id: null,
    name: `SecureSpace audit fixture (fictional) ${tag}`, short_code: `ss-audit-${tag}`, ai_tier: 'B',
  }).select('id, name').single();
  if (mErr) throw new Error('fixture matter: ' + mErr.message);
  made.matter = m.id;
  pass(`fixture matter created, born sealed (Tier B): ${m.id}`);

  try {
    // ── USE CASE 1: sealed chat ──────────────────────────────────────────
    log('\n--- use case 1: sealed chat on prod ---------------------------------');
    const PROMPT = 'Reply with exactly the single word: sealed. Do not use any tools.';
    let out = await ask(jwt, m.id, PROMPT);
    let s = ev(out.events, 'session'), d = ev(out.events, 'done'), e = ev(out.events, 'error');
    if (s?.sessionId) made.sessions.push(s.sessionId);
    if (out.status !== 200) fail(`assistant HTTP ${out.status}`, out.body);
    if (s) note(`session event: tier=${s.tier} provider=${s.provider} model=${s.model} escalation=${s.escalation}`);
    if (s?.provider === 'aws-bedrock') pass('sealed pen = Claude via Bedrock in our AWS account');
    else if (s?.provider === 'fireworks') fail('sealed pen fell to Kimi/Fireworks — Bedrock keys NOT configured on prod');
    else if (e) fail(`refused/errored: ${e.code ?? ''} ${e.message ?? e.error ?? ''}`, e);
    else fail('no session event', { status: out.status, body: out.body, events: out.events.slice(0, 3) });
    const txt = textOf(out.events).trim();
    if (d && !e && txt) pass(`answered: "${txt.slice(0, 60)}" (${d.usage?.input}/${d.usage?.output} tok; done.provider=${d.provider} done.model=${d.model})`);
    else fail('did not complete', { d, e, txt: txt.slice(0, 200) });

    out = await ask(jwt, m.id, PROMPT, { escalate: true });
    s = ev(out.events, 'session'); e = ev(out.events, 'error');
    if (s?.sessionId) made.sessions.push(s.sessionId);
    if (s) note(`escalate:true → provider=${s.provider} model=${s.model} escalation=${s.escalation}`);
    if (s?.provider === 'aws-bedrock' && s?.escalation === false) pass('escalate:true stays inside the seal');
    else if (s?.provider === 'anthropic' && s?.escalation === true) fail('escalate:true LEFT the seal to api.anthropic.com (recorded escalation) — Bedrock not configured');
    else fail('escalate case', { s, e });

    // ledger
    const { data: sess } = await supabase.from('ai_sessions').select('id, tier').eq('matterspace_id', m.id);
    const { data: msgs } = await supabase.from('ai_messages').select('role, provider, model, within_policy').in('session_id', (sess ?? []).map((x) => x.id));
    if ((sess ?? []).length) pass(`ledger: ${sess.length} ai_sessions (tier ${[...new Set(sess.map((x) => x.tier))].join(',')}), ${(msgs ?? []).length} ai_messages: ${JSON.stringify((msgs ?? []).map((x) => `${x.role}:${x.provider ?? '-'}:${x.within_policy}`))}`);
    else fail('ledger: NO ai_sessions rows written for the sealed chat');

    // ── gate probes: /api/llm bound to the sealed matter ─────────────────
    log('\n--- /api/llm gate on the sealed matter --------------------------------');
    let r = await llm(jwt, 'openai', 'gpt-4o', m.id);
    if (r.status === 403) pass(`openai on sealed matter → 403 ${r.body.slice(0, 80)}`); else fail(`openai on sealed matter → ${r.status}`, r.body);
    r = await llm(jwt, 'google', 'gemini-2.5-flash', m.id);
    if (r.status === 403) pass(`google on sealed matter → 403`); else fail(`google on sealed matter → ${r.status}`, r.body);
    r = await llm(jwt, 'anthropic', 'claude-opus-4-8', m.id);
    if (r.status === 200) fail(`anthropic (api.anthropic.com, 30-day retention) on sealed matter → 200 — content LEFT the seal via /api/llm (Workbench/Editor/cite-check path)`);
    else if (r.status === 403) pass(`anthropic on sealed matter → 403`);
    else note(`anthropic on sealed matter → ${r.status} ${r.body.slice(0, 120)}`);

    // ── USE CASE 2: privileged document into the sealed matter ───────────
    log('\n--- use case 2: upload into the sealed matter (deployed worker) --------');
    const { data: anyDoc } = await supabase.from('documents').select('created_by').not('created_by', 'is', null).limit(1).single();
    const createdBy = anyDoc?.created_by;
    const realTxt = Buffer.from(
      `Audit fixture ${tag}. This fictional memorandum concerns the courier Vermilionledger. ` +
      'The courier badge number in this fictional file is 7731 and the delivery was to the Harbor Street office. ' +
      'Nothing in this document is real; it exists to prove a sealed text file is indexed and answerable without leaving the seal. '.repeat(2),
      'utf8');
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 300]);
    page.drawRectangle({ x: 50, y: 50, width: 200, height: 200, borderWidth: 2 });
    const scanBytes = Buffer.from(await pdf.save());

    const txtId = await fileViaQueue(m.id, createdBy, { title: 'Audit fixture memo (fictional)', filename: `audit-${tag}.txt`, bytes: realTxt, contentType: 'text/plain' });
    const pdfId = await fileViaQueue(m.id, createdBy, { title: 'Audit fixture scan (fictional, image-only)', filename: `audit-scan-${tag}.pdf`, bytes: scanBytes, contentType: 'application/pdf' });
    pass('two fixtures filed + queued (a .txt with a sentinel word; an image-only PDF)');

    log('  waiting on the .txt …');
    const t = await waitTerminal(txtId);
    const { data: ps } = await supabase.from('passages').select('id, embedding_model, embedding').eq('document_id', txtId);
    const withVec = (ps ?? []).filter((p) => p.embedding != null).length;
    note(`.txt → status=${t.processing_status} passages=${(ps ?? []).length} withEmbedding=${withVec} model=${[...new Set((ps ?? []).map((p) => p.embedding_model))].join(',') || '-'} text_status=${t.metadata?.text_status ?? '-'} err=${(t.processing_error ?? '').slice(0, 160)}`);
    if (t.processing_status === 'ready' && (ps ?? []).length > 0) pass('.txt indexed inside the seal (local extraction)');
    else fail('.txt did not index', t);
    if (withVec > 0 && (ps ?? []).every((p) => p.embedding_model === 'voyage-4')) pass('vectors came from the sealed route (voyage-4 on SageMaker) — semantic search is ON for sealed matters');
    else if (withVec === 0) note('no vectors: sealed route not serving (endpoint down/unprovisioned) — sealed search is full-text only');
    else fail('vectors stamped with a NON-sealed model', ps?.slice(0, 2));

    log('  waiting on the image-only PDF …');
    const p2 = await waitTerminal(pdfId);
    note(`scan → status=${p2.processing_status} text_status=${p2.metadata?.text_status ?? '-'} err=${(p2.processing_error ?? '').slice(0, 200)}`);
    if (p2.processing_status === 'held') pass('sealed scan HELD — OCR refused rather than sent to Gemini');
    else if (p2.processing_status === 'ready') fail('sealed scan came back READY — check whether OCR ran (Gemini) or it was stored unread', p2);
    else fail('sealed scan ended in an unexpected state', p2);

    // the sealed pen reads the sealed document through its tools
    log('\n--- use case 2b: the sealed pen reads the document ----------------------');
    out = await ask(jwt, m.id, 'Search this matter for the word Vermilionledger and quote, verbatim, the sentence that states the courier badge number. Then say which document it came from.');
    s = ev(out.events, 'session'); d = ev(out.events, 'done'); e = ev(out.events, 'error');
    if (s?.sessionId) made.sessions.push(s.sessionId);
    const ans = textOf(out.events).trim();
    note(`provider=${s?.provider} tools=${JSON.stringify(d?.used_tools ?? d?.usedTools ?? '-')}`);
    if (/7731/.test(ans)) pass(`the sealed pen found the sentinel via tools: "${ans.replace(/\s+/g, ' ').slice(0, 160)}"`);
    else fail('the sealed pen did NOT surface the document content', { ans: ans.slice(0, 300), e });
  } finally {
    log('\ncleanup');
    try {
      if (made.sessions.length) await supabase.from('ai_messages').delete().in('session_id', made.sessions);
      await supabase.from('ai_sessions').delete().eq('matterspace_id', made.matter);
      for (const id of made.docs) {
        const { data: objs } = await supabase.storage.from('vault-documents').list(`${made.matter}/${id}`);
        if (objs?.length) await supabase.storage.from('vault-documents').remove(objs.map((o) => `${made.matter}/${id}/${o.name}`));
      }
      await supabase.from('processing_jobs').delete().eq('matterspace_id', made.matter);
      await supabase.from('passages').delete().eq('matterspace_id', made.matter);
      await supabase.from('documents').delete().eq('matterspace_id', made.matter);
      const { error: dErr } = await supabase.from('matterspaces').delete().eq('id', made.matter);
      if (dErr) throw dErr;
      const { count } = await supabase.from('matterspaces').select('id', { count: 'exact', head: true }).in('ai_tier', ['B', 'C']);
      log(`  fixture removed; sealed matters remaining in prod: ${count}`);
    } catch (err) {
      log(`  CLEANUP PROBLEM: ${err.message} — fixture matter ${made.matter} may remain; remove by hand.`);
    }
  }
})().catch((err) => { console.error('audit aborted:', err.message); process.exit(1); });
