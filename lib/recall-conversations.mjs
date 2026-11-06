// Recall — the Orchestrator reading the user's own earlier conversations.
//
// Eden, 2026-11-05: "When I asked, the Orchestrator said it had no knowledge
// of chats outside its current conversation. … This is a key tool that we
// need." Every exchange is already written to ai_sessions / ai_messages (051,
// and since 128 the matter-less ones too); these two tools let the pen read
// them back:
//
//   search_past_chats  find earlier conversations by words, matter, date
//   read_past_chat      read one of them, in order
//
// Whose conversations: the CALLER'S OWN (owner_id = the signed-in user),
// read through the user-scoped client, so RLS (_ledger_visible, the seal)
// answers on top of that. A teammate's conversation in a shared matter is
// theirs, not something the Orchestrator should quote back to someone else.
//
// The seal, the same rule every reading tool follows:
//   * a turn OUTSIDE the seal (sealOutsidePen) never sees a sealed (Tier B/C)
//     conversation — not its text, not its title, not that it exists;
//   * a SEALED turn sees only conversations in its own matter. Recall is not
//     a way for a sealed room to read the rest of the account, nor for the
//     rest of the account to read the room.
//
// Read-only. Nothing here writes; continuing a conversation is the panel's
// job (the sidebar, or the open_past_chat action).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEALED = new Set(['B', 'C']);
const MAX_RESULTS = 25;
const DEFAULT_RESULTS = 10;
const CANDIDATE_SESSIONS = 300;     // sessions considered per search
const EXCERPTS_PER_CONVERSATION = 3;
const EXCERPT_RADIUS = 220;          // characters either side of a hit
const READ_CHAR_BUDGET = 60_000;     // read_past_chat's text per call

export const RECALL_TOOL_NAMES = Object.freeze(['search_past_chats', 'read_past_chat']);

export const RECALL_TOOLS = Object.freeze([
  {
    name: 'search_past_chats',
    description:
      "Search the user's own earlier conversations with you (the Orchestrator) — every past " +
      'conversation is saved. Use it whenever the user refers to something discussed before ' +
      '("what did we find on…", "last week you told me…", "the conversation about…", "I had asked ' +
      'you to…"), or asks what conversations they have had about a matter. Never say you have no ' +
      'memory of earlier conversations without searching first. Give words to look for, and/or a ' +
      'matter, and/or dates. A matter includes its sub-matters. Returns each conversation\'s id, ' +
      'title, matter, when it was last active, and excerpts around the words. Read one in full with ' +
      'read_past_chat. Quote it as the record of a past conversation, with its date — it is what ' +
      'was SAID then, not a source document; for facts, cite the documents themselves.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words to find in the conversation (names, terms, a phrase). Optional if a matter or dates are given.',
        },
        matter: {
          type: 'string',
          description: 'Optional: a matter (name or id). Its sub-matters are included.',
        },
        since: { type: 'string', description: 'Optional: earliest date, YYYY-MM-DD.' },
        until: { type: 'string', description: 'Optional: latest date, YYYY-MM-DD (inclusive).' },
        limit: { type: 'integer', description: `How many conversations, at most ${MAX_RESULTS} (default ${DEFAULT_RESULTS}).` },
      },
    },
  },
  {
    name: 'read_past_chat',
    description:
      'Read one of the user\'s earlier conversations with you, message by message with times — ' +
      'by the conversation_id that search_past_chats returned. A long conversation comes back ' +
      'in parts: pass from_message to continue where the last part stopped.',
    input_schema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: 'The conversation_id from search_past_chats.' },
        from_message: { type: 'integer', description: 'Optional: start at this message number (0-based). Default 0.' },
      },
      required: ['conversation_id'],
    },
  },
]);

/** The text of a stored message, whatever shape its content jsonb took. */
export function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string' && content.text) return content.text;
    if (content.error && typeof content.error.message === 'string') return `[error: ${content.error.message}]`;
  }
  return '';
}

/** Search terms: quoted phrases kept whole, other words split; tiny words dropped. */
export function queryTerms(q) {
  if (typeof q !== 'string') return [];
  const out = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(q)) !== null) {
    const t = (m[1] ?? m[2] ?? '').trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (t.length >= 2) out.push(t);
  }
  return [...new Set(out.map((t) => t.toLowerCase()))].slice(0, 8);
}

/** An ILIKE pattern that matches the term literally. */
function likePattern(term) {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Excerpts around the first hits of any term, for the search result. */
export function excerptsFor(text, terms, max = EXCERPTS_PER_CONVERSATION) {
  const lower = text.toLowerCase();
  const spans = [];
  for (const t of terms) {
    let from = 0;
    while (spans.length < max * 3) {
      const i = lower.indexOf(t, from);
      if (i < 0) break;
      spans.push([Math.max(0, i - EXCERPT_RADIUS), Math.min(text.length, i + t.length + EXCERPT_RADIUS)]);
      from = i + t.length;
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  return merged.slice(0, max).map(([a, b]) =>
    `${a > 0 ? '…' : ''}${text.slice(a, b).replace(/\s+/g, ' ').trim()}${b < text.length ? '…' : ''}`);
}

function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/**
 * The caller's user id. The endpoint passes it (the `sub` of the bearer the
 * user-scoped client already carries); it only NARROWS a read that RLS has
 * already decided, so it is a filter, not an authority.
 */
async function callerId(supabase, userId) {
  if (typeof userId === 'string' && UUID_RE.test(userId)) return userId;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user?.id) throw new Error('recall: no signed-in user');
  return data.user.id;
}

/** A matter (name or id) and every sub-matter beneath it, under the user's RLS. */
async function matterWithDescendants(supabase, matter) {
  let roots;
  if (UUID_RE.test(matter)) {
    roots = [matter];
  } else {
    const { data, error } = await supabase
      .from('matterspaces')
      .select('id, name')
      .ilike('name', likePattern(matter.trim()).replace(/^%|%$/g, ''))
      .limit(10);
    if (error) throw new Error(`recall: ${error.message}`);
    roots = (data ?? []).map((r) => r.id);
    if (roots.length === 0) {
      const { data: loose } = await supabase
        .from('matterspaces').select('id').ilike('name', likePattern(matter.trim())).limit(10);
      roots = (loose ?? []).map((r) => r.id);
    }
  }
  const all = new Set(roots);
  let frontier = roots;
  for (let depth = 0; depth < 6 && frontier.length; depth++) {
    const { data } = await supabase.from('matterspaces').select('id').in('parent_matterspace_id', frontier);
    frontier = (data ?? []).map((r) => r.id).filter((id) => !all.has(id));
    frontier.forEach((id) => all.add(id));
  }
  return [...all];
}

/**
 * The seal, applied to a query on ai_sessions. Outside the seal: no sealed
 * tier. Inside: this matter only.
 */
function sealScope(q, { sealOutsidePen, matterId }) {
  if (sealOutsidePen) return q.not('tier', 'in', '(B,C)');
  if (!matterId) return q.eq('id', '00000000-0000-0000-0000-000000000000'); // a sealed run with no matter sees nothing
  return q.eq('matterspace_id', matterId);
}

export async function searchConversations(supabase, args = {}, { sealOutsidePen = true, matterId = null, currentSessionId = null, userId = null } = {}) {
  const terms = queryTerms(args.query);
  const limit = Math.max(1, Math.min(MAX_RESULTS, Number.isInteger(args.limit) ? args.limit : DEFAULT_RESULTS));
  const hasMatter = typeof args.matter === 'string' && args.matter.trim();
  if (!terms.length && !hasMatter && !validDate(args.since) && !validDate(args.until)) {
    return { error: 'Give words to look for, a matter, or dates.' };
  }

  const me = await callerId(supabase, userId);
  let q = supabase
    .from('ai_sessions')
    .select('id, title, matterspace_id, matter_name, tier, created_at, updated_at')
    .eq('owner_id', me)
    .order('updated_at', { ascending: false })
    .limit(CANDIDATE_SESSIONS);
  q = sealScope(q, { sealOutsidePen, matterId });
  if (hasMatter) {
    const ids = await matterWithDescendants(supabase, args.matter.trim());
    if (ids.length === 0) return { conversations: [], note: `No matter matching "${args.matter}" is visible to you.` };
    q = q.in('matterspace_id', ids);
  }
  if (validDate(args.since)) q = q.gte('updated_at', `${args.since}T00:00:00Z`);
  if (validDate(args.until)) q = q.lte('created_at', `${args.until}T23:59:59.999Z`);
  const { data: sessions, error } = await q;
  if (error) throw new Error(`recall: ${error.message}`);
  if (!sessions?.length) return { conversations: [] };

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const summary = (s, extra = {}) => ({
    conversation_id: s.id,
    title: s.title,
    matter: s.matter_name ?? null,
    started: s.created_at,
    last_active: s.updated_at,
    ...(s.id === currentSessionId ? { current: true } : {}),
    ...extra,
  });

  if (!terms.length) {
    return { conversations: sessions.slice(0, limit).map((s) => summary(s)) };
  }

  // Messages carrying EVERY term first; if none, any term.
  const ids = [...byId.keys()];
  const fetchHits = async (mode) => {
    let mq = supabase
      .from('ai_messages')
      .select('session_id, seq, role, content, created_at')
      .in('session_id', ids)
      .order('created_at', { ascending: false })
      .limit(400);
    if (mode === 'all') {
      for (const t of terms) mq = mq.ilike('content->>text', likePattern(t));
    } else {
      mq = mq.or(terms.map((t) => `content->>text.ilike.${likePattern(t).replace(/[,()]/g, ' ')}`).join(','));
    }
    const { data, error: mErr } = await mq;
    if (mErr) throw new Error(`recall: ${mErr.message}`);
    return data ?? [];
  };
  let hits = await fetchHits('all');
  let matched = 'all words';
  if (!hits.length && terms.length > 1) { hits = await fetchHits('any'); matched = 'some of the words'; }

  // Titles match too: a conversation whose first question names the thing.
  const titleHits = sessions.filter((s) => terms.every((t) => (s.title ?? '').toLowerCase().includes(t)));

  const grouped = new Map();
  for (const h of hits) {
    const g = grouped.get(h.session_id) ?? [];
    g.push(h);
    grouped.set(h.session_id, g);
  }
  for (const s of titleHits) if (!grouped.has(s.id)) grouped.set(s.id, []);

  const conversations = [...grouped.entries()]
    .map(([sid, msgs]) => {
      const s = byId.get(sid);
      const excerpts = [];
      for (const m of msgs.sort((a, b) => a.seq - b.seq)) {
        for (const e of excerptsFor(messageText(m.content), terms, EXCERPTS_PER_CONVERSATION - excerpts.length)) {
          excerpts.push({ message: m.seq, who: m.role === 'user' ? 'user' : 'you', at: m.created_at, text: e });
        }
        if (excerpts.length >= EXCERPTS_PER_CONVERSATION) break;
      }
      return summary(s, { matching_messages: msgs.length, excerpts });
    })
    .sort((a, b) => (b.last_active > a.last_active ? 1 : -1))
    .slice(0, limit);

  return { matched, conversations };
}

export async function getConversation(supabase, args = {}, { sealOutsidePen = true, matterId = null, userId = null } = {}) {
  const id = typeof args.conversation_id === 'string' ? args.conversation_id.trim() : '';
  if (!UUID_RE.test(id)) return { error: 'conversation_id must be the id search_past_chats returned.' };
  const from = Math.max(0, Number.isInteger(args.from_message) ? args.from_message : 0);

  const me = await callerId(supabase, userId);
  let q = supabase
    .from('ai_sessions')
    .select('id, title, matterspace_id, matter_name, tier, created_at, updated_at')
    .eq('id', id)
    .eq('owner_id', me);
  q = sealScope(q, { sealOutsidePen, matterId });
  const { data: s, error } = await q.maybeSingle();
  if (error) throw new Error(`recall: ${error.message}`);
  // One answer for "not yours", "sealed from here" and "no such id": the
  // difference is itself something the seal does not disclose.
  if (!s) return { error: 'No conversation of yours with that id can be read from here.' };

  const { data: rows, error: mErr } = await supabase
    .from('ai_messages')
    .select('seq, role, content, created_at')
    .eq('session_id', id)
    .in('role', ['user', 'assistant'])
    .gte('seq', from)
    .order('seq', { ascending: true });
  if (mErr) throw new Error(`recall: ${mErr.message}`);

  const messages = [];
  let used = 0;
  let next = null;
  for (const r of rows ?? []) {
    const text = messageText(r.content);
    if (used + text.length > READ_CHAR_BUDGET && messages.length) { next = r.seq; break; }
    used += text.length;
    messages.push({ message: r.seq, who: r.role === 'user' ? 'user' : 'you', at: r.created_at, text });
  }
  return {
    conversation_id: s.id,
    title: s.title,
    matter: s.matter_name ?? null,
    started: s.created_at,
    last_active: s.updated_at,
    messages,
    ...(next !== null ? { more: true, continue_from_message: next } : {}),
  };
}

/** Dispatch for the loop. Returns the JSON-able result. */
export async function runRecallTool(supabase, name, args, opts) {
  if (name === 'search_past_chats') return searchConversations(supabase, args, opts);
  if (name === 'read_past_chat') return getConversation(supabase, args, opts);
  throw new Error(`recall: unknown tool ${name}`);
}
