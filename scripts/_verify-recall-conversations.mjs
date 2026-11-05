// Recall harness. Offline by default: the pure pieces (query terms, excerpts,
// message text), the menu (who is offered the tools), and the seal scope on a
// fake query builder. With --live <user-uuid> it also runs the two tools
// read-only against the project in .env with the service role (RLS bypassed;
// the owner filter and the seal scope are the code under test).
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import {
  queryTerms, excerptsFor, messageText, searchConversations, getConversation, RECALL_TOOL_NAMES,
} from '../lib/recall-conversations.mjs';
import { orchestratorMenu } from '../lib/assistant-core.mjs';

let fail = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ── pure pieces
check('terms: words + phrase, deduped, lowercased',
  JSON.stringify(queryTerms('Dr. Bedard "Mount Sinai" bedard x')) === JSON.stringify(['dr', 'bedard', 'mount sinai']),
  JSON.stringify(queryTerms('Dr. Bedard "Mount Sinai" bedard x')));
check('terms: empty', queryTerms('').length === 0 && queryTerms(undefined).length === 0);
const long = `${'a '.repeat(400)}the Bates stamp MS-0042 ${'b '.repeat(400)}`;
const ex = excerptsFor(long, ['bates']);
check('excerpt: centred on the hit, elided both sides', ex.length === 1 && ex[0].startsWith('…') && ex[0].endsWith('…') && ex[0].includes('Bates stamp MS-0042'));
check('message text: {text}', messageText({ text: 'hi', used_tools: [] }) === 'hi');
check('message text: blocks', messageText([{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }]) === 'a\n\nb');

// ── the menu
const names = (o) => new Set(o.tools.map((t) => t.name));
const plain = names(orchestratorMenu({}));
check('menu: an ordinary turn has both recall tools + open_conversation',
  RECALL_TOOL_NAMES.every((n) => plain.has(n)) && plain.has('open_conversation'));
check('menu: a sealed turn still has recall (scoped to its matter inside)',
  RECALL_TOOL_NAMES.every((n) => names(orchestratorMenu({ sealed: true })).has(n)));
check('menu: a charter run has no recall',
  RECALL_TOOL_NAMES.every((n) => !names(orchestratorMenu({ charter: { allowed_tools: ['search'] } })).has(n)));
check('menu: a narrowed run without recall has none',
  RECALL_TOOL_NAMES.every((n) => !names(orchestratorMenu({ narrow: new Set(['search']) })).has(n)));

// ── the seal scope, on a recording fake
function fakeClient(log) {
  const builder = () => {
    const b = {};
    for (const m of ['select', 'eq', 'order', 'limit', 'not', 'in', 'gte', 'lte', 'ilike', 'or']) {
      b[m] = (...a) => { log.push([m, ...a]); return b; };
    }
    b.maybeSingle = async () => ({ data: null, error: null });
    b.then = (res) => res({ data: [], error: null });
    return b;
  };
  return { from: (t) => { log.push(['from', t]); return builder(); } };
}
const U = '4ac2bcd9-be25-4c4a-9687-356ba470dbad';
const M = '98f90e6e-1726-4164-8965-5968b8c1c760';
{
  const log = [];
  await searchConversations(fakeClient(log), { query: 'bedard' }, { sealOutsidePen: true, userId: U });
  check('seal: outside the seal excludes tiers B and C',
    log.some(([m, c, op, v]) => m === 'not' && c === 'tier' && op === 'in' && v === '(B,C)'));
  check('owner: narrowed to the caller', log.some(([m, c, v]) => m === 'eq' && c === 'owner_id' && v === U));
}
{
  const log = [];
  await searchConversations(fakeClient(log), { query: 'bedard' }, { sealOutsidePen: false, matterId: M, userId: U });
  check('seal: a sealed turn reads only its own matter',
    log.some(([m, c, v]) => m === 'eq' && c === 'matterspace_id' && v === M) && !log.some(([m]) => m === 'not'));
}
{
  const log = [];
  const r = await getConversation(fakeClient(log), { conversation_id: M }, { sealOutsidePen: true, userId: U });
  check('get: unreadable id gives one undisclosing answer', /can be read from here/.test(r.error ?? ''));
  check('get: outside the seal excludes sealed tiers', log.some(([m, c]) => m === 'not' && c === 'tier'));
}
check('get: rejects a non-uuid', /conversation_id/.test((await getConversation(fakeClient([]), { conversation_id: 'x' }, { userId: U })).error ?? ''));

// ── live, read-only:  --live <user-uuid> <word> <matter> <its sub-matter>
const liveAt = process.argv.indexOf('--live');
if (liveAt > 0) {
  const [userId, word, matter, sub] = process.argv.slice(liveAt + 1);
  const env = {};
  for (const l of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const sb = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const opts = { sealOutsidePen: true, userId };
  const a = await searchConversations(sb, { query: word }, opts);
  check(`live: "${word}" finds a conversation with excerpts`,
    (a.conversations ?? []).length > 0 && a.conversations[0].excerpts.length > 0);
  const b = await searchConversations(sb, { matter }, opts);
  check('live: a matter search reaches its sub-matter', (b.conversations ?? []).some((c) => c.matter === sub));
  if (a.conversations?.[0]) {
    const g = await getConversation(sb, { conversation_id: a.conversations[0].conversation_id }, opts);
    check('live: get_conversation returns messages in order',
      (g.messages ?? []).length > 0 && g.messages.every((m, i, arr) => i === 0 || arr[i - 1].message < m.message),
      `${(g.messages ?? []).length} messages`);
  }
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
