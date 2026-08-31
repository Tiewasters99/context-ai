// FileSaver → Contextspaces chat sync bridge.
//
// Eden's decision (2026-07-10): FileSaver demotes to a capture agent; chats
// and their attachments become first-class searchable documents in
// Contextspaces. This script is the bridge: it reads captured conversations
// from the LOCAL FileSaver store (no dependency on FileSaver's cloud) plus
// Claude Code's own session files, renders each conversation to markdown,
// and ingests it through the standard pipeline into a "Chats" space.
//
// Sources:
//   A. C:/Users/equai/FileSaver/chat-log.jsonl — append-only capture log
//      (claude.ai / chatgpt / gemini / midjourney / elevenlabs / veed via the
//      Chrome extension, plus claude-desktop drafts). Many snapshot records
//      per conversation; we keep the fullest per conversationId.
//   B. C:/Users/equai/.claude/projects/**/*.jsonl — Claude Code sessions
//      (ground truth). Only user/assistant text is digested; tool dumps are
//      skipped so the index holds the conversation, not the machinery.
//
// Update semantics: a state file maps conversation-key → content hash +
// document id. Re-runs only touch conversations whose content grew/changed
// (delete passages → re-ingest). Safe to run repeatedly / on a schedule.
//
// Usage:
//   node scripts/sync-chats.mjs --dry-run
//   node scripts/sync-chats.mjs --limit 5          (validate)
//   node scripts/sync-chats.mjs                    (full backfill / incremental)
//   node scripts/sync-chats.mjs --source claude    (one source bucket)
//
// Env (./.env): VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY

import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { processDocument } from '../lib/ingest-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));
const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY');

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

let _ownerId = null; // resolved lazily by ownerId(); declared up top (TDZ)

const CHAT_LOG = 'C:/Users/equai/FileSaver/chat-log.jsonl';
const CLAUDE_PROJECTS = 'C:/Users/equai/.claude/projects';
const STATE_FILE = 'C:/Users/equai/FileSaver/sync-state.json';

const args = parseArgs(process.argv.slice(2));
const DRY = !!args['dry-run'];
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;
const ONLY_SOURCE = args.source ? String(args.source).toLowerCase() : null;

// Source → sub-matter display name. Claude Code gets its own bucket.
const SOURCE_BUCKET = {
  'extension-claude': 'Claude',
  'extension-chatgpt': 'ChatGPT',
  'extension-gemini': 'Gemini',
  'extension-kimi': 'Kimi',
  'extension-midjourney': 'Midjourney',
  'extension-elevenlabs': 'ElevenLabs',
  'extension-veed': 'Veed',
  'claude-desktop': 'Claude Desktop drafts',
  'claude-code': 'Claude Code',
};

// ---------------------------------------------------------------------------
// 1. Collect conversations
// ---------------------------------------------------------------------------

// Source A: chat-log.jsonl → fullest record per conversation key.
//
// The capture log is snapshot-heavy: the extension records the compose box
// as the user types (kind=draft, hundreds of incremental snapshots of the
// same text) and re-captures a conversation's messages as it grows. Dedup
// therefore groups by conversation identity (id → url → title → day) and
// keeps the FULLEST snapshot per group; drafts for a conversation that was
// also captured as real messages are dropped as redundant compose remnants.
async function collectCaptured() {
  const messages = new Map(); // convKey -> record
  const drafts = new Map();   // groupKey -> record (longest text wins)
  const artifacts = new Map(); // `${source}:${ident}` -> latest artifacts line
  const rl = readline.createInterface({ input: fs.createReadStream(CHAT_LOG) });
  for await (const line of rl) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    const source = j.source || 'unknown';
    const ident = j.conversationId || normUrl(j.url) || (j.title ? `t:${j.title}` : `d:${(j.ts || '').slice(0, 10)}`);
    if (j.kind === 'artifacts') {
      // Deliverables captured alongside the chat (created files, legacy
      // artifacts). Latest snapshot per conversation wins; the content lives
      // on disk under ~/FileSaver/artifacts and is read at render time.
      const key = `${source}:${ident}`;
      const prev = artifacts.get(key);
      if (!prev || (j.ts || '') >= (prev.ts || '')) artifacts.set(key, j);
      continue;
    }
    if (j.kind === 'draft') {
      const text = (j.draft || '').trim();
      if (text.length < 80) continue;
      const key = `draft:${source}:${ident}`;
      const prev = drafts.get(key);
      if (!prev || text.length > prev.text.length) {
        drafts.set(key, { key, source, title: j.title, ts: j.ts, url: j.url, text, ident: `${source}:${ident}` });
      }
      continue;
    }
    if (j.kind === 'messages') {
      const msgs = Array.isArray(j.messages) ? j.messages : [];
      if (msgs.length === 0) continue;
      const key = `conv:${source}:${ident}`;
      const prev = messages.get(key);
      const size = JSON.stringify(msgs).length;
      if (!prev || size > prev._size) {
        messages.set(key, { key, source, title: j.title, ts: j.ts, url: j.url, messages: msgs, _size: size, ident: `${source}:${ident}` });
      }
    }
  }
  // Attach each conversation's artifact set; a conversation whose transcript
  // never got captured but whose artifacts did still becomes a (minimal)
  // record, so the deliverable is searchable even without the chat around it.
  for (const rec of messages.values()) {
    const art = artifacts.get(rec.ident);
    if (art) rec.artifacts = art;
  }
  for (const [identKey, art] of artifacts) {
    const convKey = `conv:${identKey}`;
    if (!messages.has(convKey)) {
      messages.set(convKey, {
        key: convKey, source: art.source || 'unknown', title: art.title,
        ts: art.ts, url: art.url, messages: [], _size: 0, ident: identKey, artifacts: art,
      });
    }
  }
  // Drop drafts whose conversation was captured as messages.
  const capturedIdents = new Set([...messages.values()].map((m) => m.ident));
  const keptDrafts = [...drafts.values()].filter((d) => !capturedIdents.has(d.ident));
  return [...messages.values(), ...keptDrafts];
}

// Conversation URLs sometimes carry volatile query params; strip them.
function normUrl(u) {
  if (!u) return null;
  try { const url = new URL(u); return url.origin + url.pathname; } catch { return u; }
}

// Source B: Claude Code session JSONLs → conversational digest.
async function collectClaudeCode() {
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(CLAUDE_PROJECTS, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const projDir = path.join(CLAUDE_PROJECTS, d.name);
    let files = [];
    try { files = (await fsp.readdir(projDir)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const full = path.join(projDir, f);
      let stat; try { stat = await fsp.statSync ? fs.statSync(full) : await fsp.stat(full); } catch { continue; }
      if (stat.size > 200 * 1024 * 1024) continue; // pathological; skip
      const turns = [];
      let firstUser = null;
      let lastTs = null;
      const rl = readline.createInterface({ input: fs.createReadStream(full) });
      for await (const line of rl) {
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.timestamp) lastTs = j.timestamp;
        const msg = j.message;
        if (!msg || (j.type !== 'user' && j.type !== 'assistant')) continue;
        const texts = [];
        if (typeof msg.content === 'string') texts.push(msg.content);
        else if (Array.isArray(msg.content)) {
          for (const b of msg.content) if (b?.type === 'text' && b.text) texts.push(b.text);
        }
        const text = texts.join('\n').trim();
        if (!text) continue;
        // Skip harness noise (system reminders arrive as user text).
        if (j.type === 'user' && /^<(system-reminder|local-command|command-name|task-notification)/.test(text)) continue;
        turns.push({ role: j.type, text });
        if (j.type === 'user' && !firstUser) firstUser = text;
      }
      const totalChars = turns.reduce((s, t) => s + t.text.length, 0);
      if (turns.length < 2 || totalChars < 400) continue; // empty/trivial sessions
      out.push({
        key: `cc:${d.name}:${f.replace(/\.jsonl$/, '')}`,
        source: 'claude-code',
        title: (firstUser || 'Claude Code session').replace(/\s+/g, ' ').slice(0, 80),
        ts: lastTs || stat.mtime.toISOString(),
        url: null,
        project: d.name.replace(/^C--/, '').replace(/-/g, '/'),
        turns,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Render a conversation to markdown
// ---------------------------------------------------------------------------
function renderMarkdown(conv) {
  const bucket = SOURCE_BUCKET[conv.source] || conv.source;
  const when = (conv.ts || '').slice(0, 10);
  const lines = [
    `# ${conv.title || 'Untitled conversation'}`,
    '',
    `*Source: ${bucket}${conv.project ? ` · ${conv.project}` : ''}${when ? ` · ${when}` : ''}${conv.url ? ` · ${conv.url}` : ''}*`,
    '',
  ];
  // Strip embedded base64 blobs (data URIs, bare base64 runs): they carry no
  // searchable signal and their token density (~1.3 chars/token vs the 4 the
  // pipeline assumes) blows the embeddings per-input limit.
  const scrub = (s) => s
    .replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]+/gi, '[embedded file]')
    .replace(/[A-Za-z0-9+/=]{2000,}/g, '[binary data]');
  if (conv.text) {
    lines.push(scrub(conv.text));
  } else if (conv.messages) {
    for (const m of conv.messages) {
      const who = m.role === 'user' ? 'User' : 'Assistant';
      const content = scrub((typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).trim());
      if (!content) continue;
      lines.push(`**${who}:**`, '', content, '');
    }
  } else if (conv.turns) {
    for (const t of conv.turns) {
      lines.push(`**${t.role === 'user' ? 'User' : 'Assistant'}:**`, '', t.text, '');
    }
  }
  renderArtifactSection(lines, scrub, conv.artifacts);
  return lines.join('\n');
}

// Deliverables captured for this conversation: inline each text file's content
// (read from ~/FileSaver/artifacts at render time — the log line is only a
// pointer), and name the binary outputs whose bytes we can't fetch yet. The
// document hash covers this section, so a new revision re-ingests naturally.
const FILESAVER_DIR = 'C:/Users/equai/FileSaver';
function renderArtifactSection(lines, scrub, art) {
  const files = Array.isArray(art?.artifacts) ? art.artifacts : [];
  const presented = Array.isArray(art?.presented) ? art.presented : [];
  if (!files.length && !presented.length) return;
  lines.push('', '## Files & artifacts created in this conversation', '');
  for (const a of files) {
    let body = '';
    try {
      const parts = String(a.relPath || '').split('/').filter((s) => s && s !== '..');
      if (parts.length) body = fs.readFileSync(path.join(FILESAVER_DIR, ...parts), 'utf-8');
    } catch { /* file missing on disk — still list it by name below */ }
    lines.push(`### ${a.name}${a.title && a.title !== a.name ? ` — ${a.title}` : ''}`, '');
    lines.push(body ? scrub(body.slice(0, 200_000)) : '*(content not on disk)*', '');
  }
  // Binary container outputs (.docx/.pdf renderings, etc.) — dedupe by name,
  // skip ones whose text source was captured above under the same basename.
  const capturedBases = new Set(files.map((f) => (f.name || '').toLowerCase().replace(/\.[^.]+$/, '').replace(/[_\s-]+/g, '')));
  const seen = new Set();
  for (const p of presented) {
    const key = `${p.name}|${p.mime_type}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const base = (p.name || '').toLowerCase().replace(/\.[^.]+$/, '').replace(/[_\s-]+/g, '');
    if (base && capturedBases.has(base)) continue;
    lines.push(`- Output file presented in chat (binary, not yet archived): **${p.name}** (${p.mime_type || 'unknown type'})`);
  }
  lines.push('');
}

// ---------------------------------------------------------------------------
// 3. Matterspace tree: Chats → per-source sub-matters (create if missing)
// ---------------------------------------------------------------------------
async function ensureMatters(neededBuckets) {
  // Hierarchy: Clientspace → Serverspace → Matterspace. Chats get their own
  // serverspace, with one matterspace per source (Claude, Claude Code, …).
  // Anchor on the LEGAL serverspace's clientspace + owner: that is Eden's
  // workspace. (There are multiple clientspaces — never pick blindly, chats
  // are personal.) Membership = visibility boundary: ONLY the owner is added,
  // so synced chats stay private even from colleagues who share Legal.
  const { data: legal, error: legalErr } = await supabase.from('serverspaces')
    .select('id, clientspace_id').eq('name', 'Legal').single();
  if (legalErr || !legal) throw new Error(`cannot resolve Eden's clientspace via Legal: ${legalErr?.message}`);
  const { data: legalOwner } = await supabase.from('serverspace_members')
    .select('user_id').eq('serverspace_id', legal.id).eq('role', 'owner').single();
  if (!legalOwner) throw new Error('cannot resolve owner user from Legal serverspace');

  let { data: chatSS } = await supabase.from('serverspaces')
    .select('id').eq('name', 'Chats').eq('clientspace_id', legal.clientspace_id).maybeSingle();
  if (!chatSS) {
    const { data: ins, error } = await supabase.from('serverspaces')
      .insert({ clientspace_id: legal.clientspace_id, name: 'Chats', description: 'AI conversations, captured and searchable (synced from FileSaver + Claude Code)', icon: '💬' })
      .select('id').single();
    if (error) throw new Error(`create serverspace Chats: ${error.message}`);
    chatSS = ins;
    log('  + created serverspace: Chats');
  }
  // Owner membership (idempotent).
  const { data: existingMember } = await supabase.from('serverspace_members')
    .select('id').eq('serverspace_id', chatSS.id).eq('user_id', legalOwner.user_id).maybeSingle();
  if (!existingMember) {
    const { error: memErr } = await supabase.from('serverspace_members')
      .insert({ serverspace_id: chatSS.id, user_id: legalOwner.user_id, role: 'owner' });
    if (memErr) throw new Error(`add owner membership: ${memErr.message}`);
    log('  + owner membership added (owner only — chats stay private)');
  }

  const bucketIds = {};
  for (const bucket of neededBuckets) {
    const sc = 'chats-' + bucket.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const { data: hit } = await supabase.from('matterspaces')
      .select('id').eq('short_code', sc).maybeSingle();
    if (hit) { bucketIds[bucket] = hit.id; continue; }
    const { data: ins, error } = await supabase.from('matterspaces')
      .insert({ name: bucket, short_code: sc, serverspace_id: chatSS.id })
      .select('id').single();
    if (error) throw new Error(`create matterspace ${bucket}: ${error.message}`);
    log(`  + created space: Chats / ${bucket} (${sc})`);
    bucketIds[bucket] = ins.id;
  }
  return bucketIds;
}

// ---------------------------------------------------------------------------
// 4. Ingest one conversation (create or update)
// ---------------------------------------------------------------------------
async function upsertConversation(conv, matterId, state) {
  const md = renderMarkdown(conv);
  const hash = sha(md);
  const st = state[conv.key];
  if (st && st.hash === hash) return 'unchanged';

  const fileName = `${slug(conv.title || conv.key)}.md`;
  const buf = Buffer.from(md, 'utf8');

  let docId = st?.docId ?? null;
  if (docId) {
    // Verify the doc still exists (user may have deleted it in the UI —
    // deletion wins; we don't resurrect).
    const { data: doc } = await supabase.from('documents').select('id').eq('id', docId).maybeSingle();
    if (!doc) { delete state[conv.key]; docId = null; }
  }

  if (!docId) {
    const { data: doc, error } = await supabase.from('documents').insert({
      matterspace_id: matterId,
      title: conv.title || 'Untitled conversation',
      doc_type: 'other',
      source_filename: fileName,
      file_size_bytes: buf.length,
      processing_status: 'pending',
      created_by: await ownerId(),
    }).select('id').single();
    if (error) throw new Error(`create document: ${error.message}`);
    docId = doc.id;
    const storagePath = `${matterId}/${docId}/${fileName}`;
    const { error: upErr } = await supabase.storage.from('vault-documents')
      .upload(storagePath, buf, { contentType: 'text/markdown', upsert: true });
    if (upErr) throw new Error(`upload: ${upErr.message}`);
    await supabase.from('documents').update({ storage_path: storagePath }).eq('id', docId);
  } else {
    // Content changed: replace the stored file + clear old passages.
    const storagePath = `${matterId}/${docId}/${fileName}`;
    await supabase.storage.from('vault-documents').upload(storagePath, buf, { contentType: 'text/markdown', upsert: true });
    await supabase.from('passages').delete().eq('document_id', docId);
    await supabase.from('documents').update({
      storage_path: storagePath, file_size_bytes: buf.length,
      processing_status: 'pending', processing_error: null, ingested_at: null,
    }).eq('id', docId);
  }

  await processDocument(supabase, { documentId: docId, fileBuf: buf, ext: '.md', openaiApiKey: OPENAI_API_KEY });

  state[conv.key] = { hash, docId, ts: conv.ts };
  return st ? 'updated' : 'created';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
log('Collecting conversations…');
const captured = await collectCaptured();
const claudeCode = await collectClaudeCode();
let convs = [...captured, ...claudeCode];
if (ONLY_SOURCE) convs = convs.filter((c) => (SOURCE_BUCKET[c.source] || c.source).toLowerCase().includes(ONLY_SOURCE));
log(`Conversations: captured=${captured.length} claude-code=${claudeCode.length} selected=${convs.length}`);

const state = await loadState();
const pending = convs.filter((c) => {
  const md = null; // cheap pre-filter: only hash when needed
  const st = state[c.key];
  return !st; // new ones first; changed ones detected in upsert
});
log(`New (never synced): ${pending.length}  |  previously synced: ${convs.length - pending.length} (changes detected per-item)`);

if (DRY) {
  const byBucket = {};
  for (const c of convs) { const b = SOURCE_BUCKET[c.source] || c.source; byBucket[b] = (byBucket[b] || 0) + 1; }
  for (const [b, n] of Object.entries(byBucket)) log(`  ${String(n).padStart(5)}  ${b}`);
  log('\n(--dry-run; nothing changed)');
  process.exit(0);
}

const buckets = [...new Set(convs.map((c) => SOURCE_BUCKET[c.source] || c.source))];
const bucketIds = await ensureMatters(buckets);

const summary = { created: 0, updated: 0, unchanged: 0, failed: 0 };
let done = 0;
for (const conv of convs) {
  if (summary.created + summary.updated >= LIMIT) break;
  const bucket = SOURCE_BUCKET[conv.source] || conv.source;
  try {
    const res = await upsertConversation(conv, bucketIds[bucket], state);
    summary[res]++;
    if (res !== 'unchanged') {
      log(`  [${++done}] ${res}: [${bucket}] ${String(conv.title || conv.key).slice(0, 70)}`);
      if (done % 10 === 0) await saveState(state); // periodic checkpoint
    }
  } catch (err) {
    summary.failed++;
    log(`  ✗ [${bucket}] ${String(conv.title || conv.key).slice(0, 60)} — ${(err.message || err).slice(0, 120)}`);
  }
}
await saveState(state);

log(`\n=== Done ===`);
log(`  created: ${summary.created}  updated: ${summary.updated}  unchanged: ${summary.unchanged}  failed: ${summary.failed}`);

// ---- helpers ---------------------------------------------------------------
async function ownerId() {
  if (_ownerId) return _ownerId;
  const { data, error } = await supabase.from('documents').select('created_by').not('created_by', 'is', null).limit(1).single();
  if (error || !data?.created_by) throw new Error(`cannot resolve owner user id: ${error?.message ?? 'no documents'}`);
  _ownerId = data.created_by;
  return _ownerId;
}
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'conversation'; }
async function loadState() { try { return JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')); } catch { return {}; } }
async function saveState(s) { await fsp.writeFile(STATE_FILE, JSON.stringify(s, null, 1)); }
function parseArgs(argv) { const out = { _: [] }; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2), v = argv[i + 1]; if (v && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true; } else out._.push(a); } return out; }
async function loadEnv(file) { try { const t = await fsp.readFile(file, 'utf8'); for (const line of t.split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2]; if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v.trim(); } } catch {} }
function requireEnv(n) { const v = process.env[n]; if (!v) { console.error(`Missing env ${n}`); process.exit(1); } return v; }
function log(...a) { console.log(...a); }
