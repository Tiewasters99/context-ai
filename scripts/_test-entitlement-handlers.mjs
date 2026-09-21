// The handler half of "hidden also means locked" — the real endpoints, driven
// offline with global fetch replaced by a witness.
//
// The database half is scripts/_verify-entitlements.mjs (migration 083 in
// PGlite). This file asserts the part a migration cannot: that each gated
// endpoint asks lib/entitlements.mjs BEFORE it does any work, that the answer
// reaches the person as a sentence, that an unreadable plan is a 503 and never
// a demotion, that every one of api/mediation.mjs's four model calls is
// metered BEFORE the provider is contacted, and that the Student Hub's invite
// cap stops a second mail from going out.
//
// Offline by construction. globalThis.fetch is a local function for the
// duration of every case, and each case asserts what the witness SAW as well
// as what came back — "no model call" is only worth something if something was
// watching the wire.
//
//   node --test scripts/_test-entitlement-handlers.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

// Env first: the handlers read process.env at import time.
process.env.VITE_SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
process.env.OPENAI_API_KEY = 'openai-key';
process.env.ANTHROPIC_API_KEY = 'anthropic-key';
process.env.GOOGLE_API_KEY = 'google-key';
process.env.DEEPGRAM_API_KEY = 'deepgram-key';
process.env.RESEND_API_KEY = 'resend-key';

const { requireEntitlement, NOT_IN_PLAN, PLAN_UNREADABLE } = await import('../lib/entitlements.mjs');
const mediationHandler = (await import('../api/mediation.mjs')).default;
const meetingFlagHandler = (await import('../api/meeting-flag.mjs')).default;
const meetingChatHandler = (await import('../api/meeting-chat.mjs')).default;
const ocrHandler = (await import('../api/student-hub-ocr.mjs')).default;
const inviteModule = await import('../api/student-hub-invite.mjs');
const inviteHandler = inviteModule.default;

const USER = '11111111-1111-1111-1111-111111111111';
const CASE = '22222222-2222-2222-2222-222222222222';
const GROUP = '33333333-3333-3333-3333-333333333333';
const PARTY_A = '44444444-4444-4444-4444-444444444444';
const PARTY_B = '55555555-5555-5555-5555-555555555555';

const MODEL_HOSTS = ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com'];

/* ── a fake Vercel req/res ─────────────────────────────────────────────── */
function fakeRes() {
  const chunks = [];
  const headers = {};
  return {
    statusCode: 200,
    headers,
    setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
    write(b) { chunks.push(Buffer.from(b)); return true; },
    end(b) { if (b) chunks.push(Buffer.from(b)); return this; },
    flushHeaders() {},
    text() { return Buffer.concat(chunks).toString(); },
    json() { try { return JSON.parse(this.text()); } catch { return null; } },
  };
}
const req = (body) => ({ method: 'POST', headers: { authorization: 'Bearer tok' }, body });

/* ── the witness ───────────────────────────────────────────────────────── */
const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u); } };

/**
 * Replace global fetch for one case.
 *
 * `routes` is an ordered list of [test, answer]; the first test whose RegExp
 * (or function) matches the url wins. Everything unmatched throws, so a
 * request this file did not expect is a failure and not a silent pass.
 */
function witness(routes) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body ?? null; }
    seen.push({ url: u, host: hostOf(u), method, body, headers: init.headers || {} });
    for (const [match, answer] of routes) {
      const hit = typeof match === 'function' ? match(u, init) : match.test(u);
      if (hit) {
        const out = typeof answer === 'function' ? await answer(u, init) : answer;
        if (out instanceof Response) return out;
        return new Response(JSON.stringify(out ?? null), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
    }
    throw new Error(`unexpected request: ${method} ${u}`);
  };
  return {
    seen,
    restore() { globalThis.fetch = original; },
    hosts: () => [...new Set(seen.map((r) => r.host))],
    modelCalls: () => seen.filter((r) => MODEL_HOSTS.includes(r.host)),
    hits: (re) => seen.filter((r) => re.test(r.url)),
  };
}

/**
 * What a request asked to be sent back. supabase-js hands fetch a plain object
 * on a GET and a real Headers on a POST, so both have to be read.
 */
const acceptOf = (init) => {
  const h = init?.headers;
  if (!h) return '';
  try { if (typeof h.get === 'function') return String(h.get('accept') || ''); } catch { /* not a Headers */ }
  return String(h.accept || h.Accept || '');
};

/** PostgREST answers a list, or ONE object when the client asked for one. */
const rows = (list) => (_u, init) => {
  const accept = acceptOf(init);
  if (accept.includes('vnd.pgrst.object')) {
    return new Response(JSON.stringify(list[0] ?? null), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify(list), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

const AUTH = [/\/auth\/v1\/user/, { id: USER, email: 'someone@example.test', user_metadata: { full_name: 'Someone' } }];
const profiles = (tier) => [/\/rest\/v1\/profiles/, rows([{ pricing_tier: tier }])];
const METER_OK = { allowed: true, status: 200, reason: 'ok', event_id: 'ev-1' };
const METER_SPENT = {
  allowed: false, status: 402, reason: 'over_monthly_budget',
  message: "You have reached this month's included AI usage. It resets at the start of next month.",
};
const meter = (answer) => [/\/rest\/v1\/rpc\/usage_consume/, answer];

/* ======================================================================== */
/* 1. lib/entitlements.mjs itself                                            */
/* ======================================================================== */

test('a core surface is answered without asking the database at all', async () => {
  const w = witness([]);
  try {
    const gate = await requireEntitlement(USER, 'vault', { bearer: 'tok' });
    assert.equal(gate.ok, true);
    assert.equal(w.seen.length, 0, 'the core product pays no latency for this file existing');
  } finally { w.restore(); }
});

test('a frozen surface refuses a free account with the sentence and 403', async () => {
  const w = witness([profiles('free')]);
  try {
    const gate = await requireEntitlement(USER, 'mediation', { bearer: 'tok' });
    assert.equal(gate.ok, false);
    assert.equal(gate.status, 403);
    assert.equal(gate.message, 'This room is not part of your plan.');
    assert.equal(gate.message, NOT_IN_PLAN);
  } finally { w.restore(); }
});

test('workshop passes every surface, frozen and beta alike', async () => {
  for (const id of ['mediation', 'connect', 'agents', 'mootBench', 'studentHub', 'editor', 'office']) {
    const w = witness([profiles('workshop')]);
    try {
      const gate = await requireEntitlement(USER, id, { bearer: 'tok' });
      assert.equal(gate.ok, true, `${id} should be open to workshop`);
      assert.equal(gate.plan, 'workshop');
    } finally { w.restore(); }
  }
});

test('a beta surface passes exactly the plans plan.ts shows it to', async () => {
  for (const tier of ['free', 'basic', 'pro', 'max']) {
    const w = witness([profiles(tier)]);
    try {
      const gate = await requireEntitlement(USER, 'studentHub', { bearer: 'tok' });
      assert.equal(gate.ok, false, `${tier} must not open a beta surface`);
      assert.equal(gate.status, 403);
    } finally { w.restore(); }
  }
});

test('the tier comes from the row, never from the request', async () => {
  const w = witness([profiles('free')]);
  try {
    const gate = await requireEntitlement(USER, 'mediation', {
      bearer: 'tok',
      // Nothing a caller can say about itself is consulted; these are noise.
      plan: 'workshop', pricing_tier: 'workshop', tier: 'workshop',
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.plan, 'free');
  } finally { w.restore(); }
});

test('a brand-new account with no profiles row reads as free, NOT as an outage', async () => {
  const w = witness([[/\/rest\/v1\/profiles/, rows([])]]);
  try {
    const gate = await requireEntitlement(USER, 'connect', { bearer: 'tok' });
    assert.equal(gate.status, 403, 'an absent row is an answer, not a failure');
    assert.equal(w.hits(/profiles/).length, 1, 'and it is not retried');
  } finally { w.restore(); }
});

test('an unreadable plan is retried once and then answered 503, never 403', async () => {
  const w = witness([[/\/rest\/v1\/profiles/, () => new Response('gateway', { status: 502 })]]);
  try {
    const gate = await requireEntitlement(USER, 'mediation', { bearer: 'tok' });
    assert.equal(gate.status, 503, 'a workshop account must never be told it has been demoted');
    assert.equal(gate.message, PLAN_UNREADABLE);
    assert.match(gate.message, /try again/i);
    assert.equal(w.hits(/profiles/).length, 2, 'exactly one retry');
  } finally { w.restore(); }
});

test('a single dropped connection is not an outage — the retry is believed', async () => {
  let n = 0;
  const w = witness([[/\/rest\/v1\/profiles/, () => {
    n += 1;
    if (n === 1) throw new Error('socket hang up');
    return rows([{ pricing_tier: 'workshop' }])('', {});
  }]]);
  try {
    const gate = await requireEntitlement(USER, 'mediation', { bearer: 'tok' });
    assert.equal(gate.ok, true);
    assert.equal(n, 2);
  } finally { w.restore(); }
});

test('a surface nobody declared is a server error, not an open door', async () => {
  const w = witness([]);
  try {
    const gate = await requireEntitlement(USER, 'courtroom', { bearer: 'tok' });
    assert.equal(gate.ok, false);
    assert.equal(gate.status, 500);
    assert.equal(w.seen.length, 0);
  } finally { w.restore(); }
});

/* ======================================================================== */
/* 2. Connect — /api/meeting-flag and /api/meeting-chat                      */
/* ======================================================================== */

test('Connect refuses a free account in plain words, and does no work', async () => {
  const w = witness([AUTH, profiles('free')]);
  const res = fakeRes();
  try {
    await meetingFlagHandler(req({ transcript: 'x'.repeat(4000), meetingId: 'm-1' }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().message, NOT_IN_PLAN);
    assert.equal(w.modelCalls().length, 0);
    assert.equal(w.hits(/rpc\/usage_consume/).length, 0, 'nothing was charged for a room they cannot enter');
  } finally { w.restore(); }
});

test('Connect lets workshop through', async () => {
  const w = witness([AUTH, profiles('workshop')]);
  const res = fakeRes();
  try {
    // A short transcript returns early, well past the gate.
    await meetingFlagHandler(req({ transcript: 'too short', meetingId: 'm-1' }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { flags: [] });
  } finally { w.restore(); }
});

test('Connect answers 503 while the plan cannot be read', async () => {
  const w = witness([AUTH, [/\/rest\/v1\/profiles/, () => new Response('', { status: 500 })]]);
  const res = fakeRes();
  try {
    await meetingFlagHandler(req({ transcript: 'too short' }), res);
    assert.equal(res.statusCode, 503);
    assert.match(res.json().message, /try again/i);
    assert.equal(res.headers['retry-after'], '5');
  } finally { w.restore(); }
});

test('the meetings chat refuses a free account before any model call', async () => {
  const w = witness([AUTH, profiles('free')]);
  const res = fakeRes();
  try {
    await meetingChatHandler(req({ messages: [{ role: 'user', content: 'what did they agree?' }] }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'not_in_plan');
    assert.equal(w.modelCalls().length, 0);
  } finally { w.restore(); }
});

/* ======================================================================== */
/* 3. The Student Hub — OCR and the invitation cap                           */
/* ======================================================================== */

const OCR_BODY = { pages: [{ path: `${USER}/torts/page_0001.jpg`, n: 1 }] };

test('Student Hub OCR refuses a pro account, and spends no OCR', async () => {
  const w = witness([AUTH, profiles('pro')]);
  const res = fakeRes();
  try {
    await ocrHandler({ ...req(OCR_BODY) }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().message, NOT_IN_PLAN);
    assert.equal(w.modelCalls().length, 0);
    assert.equal(w.hits(/rpc\/usage_consume/).length, 0);
  } finally { w.restore(); }
});

test('Student Hub OCR lets workshop reach the meter (and the meter still binds)', async () => {
  const w = witness([AUTH, profiles('workshop'), meter(METER_SPENT)]);
  const res = fakeRes();
  try {
    await ocrHandler({ ...req(OCR_BODY) }, res);
    assert.equal(res.statusCode, 402, 'past the plan gate, refused by the wallet');
    assert.equal(w.hits(/rpc\/usage_consume/).length, 1);
    assert.equal(w.modelCalls().length, 0);
  } finally { w.restore(); }
});

const inviteRoutes = (tier, charge) => [
  AUTH,
  profiles(tier),
  [/\/rest\/v1\/student_hub_groups/, rows([{ id: GROUP, name: 'Section B', text_id: 't-1', created_by: USER }])],
  [/\/rest\/v1\/student_hub_group_members/, rows([{ email: 'sam@example.test', user_id: null }])],
  [/\/rest\/v1\/student_hub_texts/, rows([{ title: 'Torts' }])],
  [/\/rest\/v1\/rpc\/student_hub_invite_charge/, charge],
  [/api\.resend\.com/, { id: 'mail-1' }],
];
const INVITE = { groupId: GROUP, email: 'sam@example.test' };

test('an invitation is refused when the Student Hub is not in the plan', async () => {
  const w = witness([AUTH, profiles('max')]);
  const res = fakeRes();
  try {
    await inviteHandler(req(INVITE), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().message, NOT_IN_PLAN);
    assert.equal(w.hits(/resend/).length, 0);
  } finally { w.restore(); }
});

test('the first invitation goes out, and is charged before it does', async () => {
  const w = witness(inviteRoutes('workshop', { allowed: true, status: 200, reason: 'ok' }));
  const res = fakeRes();
  try {
    await inviteHandler(req(INVITE), res);
    assert.equal(res.statusCode, 200);
    const charged = w.seen.findIndex((r) => /invite_charge/.test(r.url));
    const mailed = w.seen.findIndex((r) => /resend/.test(r.url));
    assert.ok(charged >= 0 && mailed >= 0 && charged < mailed, 'charged, then sent');
    assert.equal(w.hits(/resend/).length, 1, 'exactly one mail');
  } finally { w.restore(); }
});

test('a capped seat is refused in plain words and NO mail is sent', async () => {
  const w = witness(inviteRoutes('workshop', {
    allowed: false, status: 429, reason: 'invite_seat_cap', retry_after_seconds: 3600,
    message: 'That seat has already been sent its invitation three times today. Try again tomorrow, '
      + 'or ask them to check their spam folder.',
  }));
  const res = fakeRes();
  try {
    await inviteHandler(req(INVITE), res);
    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error, 'invite_seat_cap');
    assert.match(res.json().message, /three times today/);
    assert.equal(res.headers['retry-after'], '3600');
    assert.equal(w.hits(/resend/).length, 0, 'the whole point: the mail does not go');
  } finally { w.restore(); }
});

test('an owner over the daily cap is refused the same way', async () => {
  const w = witness(inviteRoutes('workshop', {
    allowed: false, status: 429, reason: 'invite_daily_cap', retry_after_seconds: 1800,
    message: 'You have sent as many study-group invitations as Contextspaces allows in a day. '
      + 'Try again tomorrow.',
  }));
  const res = fakeRes();
  try {
    await inviteHandler(req({ groupId: GROUP, email: 'other@example.test' }), res);
    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error, 'invite_daily_cap');
    assert.equal(w.hits(/resend/).length, 0);
  } finally { w.restore(); }
});

test('while the cap is NOT DEPLOYED the invitation still goes out (loudly)', async () => {
  const w = witness(inviteRoutes('workshop',
    () => new Response(JSON.stringify({ code: 'PGRST202', message: 'Could not find the function' }), { status: 404 })));
  const res = fakeRes();
  try {
    await inviteHandler(req(INVITE), res);
    assert.equal(res.statusCode, 200, 'a merge that lands before the paste must not break invitations');
    assert.equal(w.hits(/resend/).length, 1);
  } finally { w.restore(); }
});

test('once the cap EXISTS, any error refuses — the consumeIpUsage rule', async () => {
  const w = witness(inviteRoutes('workshop',
    () => new Response(JSON.stringify({ message: 'deadlock detected' }), { status: 500 })));
  const res = fakeRes();
  try {
    await inviteHandler(req(INVITE), res);
    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error, 'invite_cap_unavailable');
    assert.equal(w.hits(/resend/).length, 0);
  } finally { w.restore(); }
});

test('chargeInvite reads the RPC answer straight through', async () => {
  const answers = [
    [{ data: { allowed: true, status: 200, reason: 'ok' }, error: null }, true],
    [{ data: { allowed: false, status: 429, reason: 'invite_seat_cap', message: 'no' }, error: null }, false],
    [{ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }, true],
    [{ data: null, error: { code: '40P01', message: 'deadlock detected' } }, false],
    [{ data: null, error: null }, false],
  ];
  for (const [rpcResult, expected] of answers) {
    const admin = { rpc: async () => rpcResult };
    const out = await inviteModule.chargeInvite(admin, { groupId: GROUP, email: 'a@b.test', senderId: USER });
    assert.equal(out.allowed, expected, JSON.stringify(rpcResult));
  }
  const threw = { rpc: async () => { throw new Error('ECONNRESET'); } };
  assert.equal((await inviteModule.chargeInvite(threw, { groupId: GROUP, email: 'a@b.test', senderId: USER })).allowed, false);
});

/* ======================================================================== */
/* 4. Mediation — the gate at the door, and the meter on every model call    */
/* ======================================================================== */

const caseRow = (over = {}) => ({
  id: CASE,
  created_by: USER,
  title: 'Doe v. Roe',
  status: 'framework',
  mediator_model: 'gpt-5.5',     // the REST path — no SDK in the way
  invite_code: 'CM-ABCD-EFGH',
  scheduling_round: 1,
  scheduled_date: null,
  legal_framework: null,
  settlement_draft: null,
  attorney_review_status: null,
  created_at: '2026-09-01T00:00:00Z',
  ...over,
});
const parties = (over = {}) => ([
  {
    id: PARTY_A, case_id: CASE, user_id: USER, label: 'A', display_name: 'Doe', fee_paid: true,
    intake_summary: 'i', position_paper: 'p', demand: 'd', analysis: 'a', caucus_started_at: null,
    ...over,
  },
  {
    id: PARTY_B, case_id: CASE, user_id: 'other-user', label: 'B', display_name: 'Roe', fee_paid: true,
    intake_summary: 'i', position_paper: 'p', demand: 'd', analysis: 'a', caucus_started_at: null,
  },
]);

const OPENAI_REPLY = {
  choices: [{ message: { role: 'assistant', content: 'The framework, such as it is.' } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
};

const mediationRoutes = ({ tier = 'workshop', meterAnswer = METER_OK, over = {}, partyOver = {}, extra = [] } = []) => [
  AUTH,
  profiles(tier),
  meter(meterAnswer),
  ...extra,
  [/\/rest\/v1\/mediation_cases/, (u, init) => {
    if ((init.method || 'GET').toUpperCase() !== 'GET') return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    return rows([caseRow(over)])(u, init);
  }],
  [/\/rest\/v1\/mediation_parties/, (u, init) => {
    if ((init.method || 'GET').toUpperCase() !== 'GET') return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    return rows(parties(partyOver))(u, init);
  }],
  [/\/rest\/v1\/mediation_messages/, rows([])],
  [/\/rest\/v1\/mediation_offers/, rows([{ id: 'o-1', from_party: PARTY_B, terms: '$100,000', shared: true, status: 'accepted' }])],
  [/\/rest\/v1\/mediation_date_proposals/, rows([])],
  [/api\.openai\.com/, OPENAI_REPLY],
];

test('a free account cannot open a mediation — 403, nothing written, nothing spent', async () => {
  const w = witness([AUTH, profiles('free')]);
  const res = fakeRes();
  try {
    await mediationHandler(req({ action: 'cases.create', title: 'Doe v. Roe', displayName: 'Doe' }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().message, NOT_IN_PLAN);
    assert.equal(w.hits(/mediation_cases/).length, 0, 'no case row was written');
    assert.equal(w.modelCalls().length, 0);
  } finally { w.restore(); }
});

test('a free account cannot JOIN a mediation either', async () => {
  const w = witness([AUTH, profiles('free')]);
  const res = fakeRes();
  try {
    await mediationHandler(req({ action: 'join', inviteCode: 'CM-ABCD-EFGH', displayName: 'Roe' }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(w.hits(/mediation_/).length, 0);
  } finally { w.restore(); }
});

test('workshop opens a mediation', async () => {
  const w = witness([
    AUTH, profiles('workshop'),
    [/\/rest\/v1\/mediation_cases/, rows([caseRow()])],
    [/\/rest\/v1\/mediation_parties/, rows([parties()[0]])],
  ]);
  const res = fakeRes();
  try {
    await mediationHandler(req({ action: 'cases.create', title: 'Doe v. Roe', displayName: 'Doe' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().id, CASE);
  } finally { w.restore(); }
});

test('a case already on foot is NOT stopped by the plan gate', async () => {
  // The whole reason the gate sits at cases.create/join and not on the whole
  // endpoint: there is another human being on the far side of a live case.
  const w = witness(mediationRoutes({ tier: 'free', over: { status: 'framework' } }));
  const res = fakeRes();
  try {
    await mediationHandler(req({ action: 'case.get', caseId: CASE }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().case.id, CASE);
  } finally { w.restore(); }
});

const MODEL_ACTIONS = [
  { name: 'framework.issue', body: { action: 'framework.issue', caseId: CASE }, over: { status: 'framework' } },
  { name: 'day.open', body: { action: 'day.open', caseId: CASE }, over: { status: 'pre_mediation', legal_framework: 'F' } },
  {
    name: 'chat.send',
    body: { action: 'chat.send', caseId: CASE, message: 'Where are we weakest?' },
    over: { status: 'pre_mediation', legal_framework: 'F' },
  },
  {
    name: 'settlement.draft',
    body: { action: 'settlement.draft', caseId: CASE },
    over: { status: 'settlement_draft', legal_framework: 'F' },
  },
];

for (const step of MODEL_ACTIONS) {
  test(`mediation meters BEFORE the model on ${step.name}`, async () => {
    const w = witness(mediationRoutes({ over: step.over }));
    const res = fakeRes();
    try {
      await mediationHandler(req(step.body), res);
      assert.equal(res.statusCode, 200, res.text());
      const metered = w.seen.findIndex((r) => /rpc\/usage_consume/.test(r.url));
      const called = w.seen.findIndex((r) => MODEL_HOSTS.includes(r.host));
      assert.ok(metered >= 0, 'the turn was metered at all');
      assert.ok(called >= 0, 'the mediator really was called');
      assert.ok(metered < called, 'and the meter came first');
      const charge = w.seen[metered].body;
      assert.equal(charge.p_kind, 'mediation');
      assert.ok(charge.p_cents_estimate > 0, 'a real estimate, not zero');
    } finally { w.restore(); }
  });

  test(`mediation refuses ${step.name} over budget with ZERO model calls`, async () => {
    const w = witness(mediationRoutes({ over: step.over, meterAnswer: METER_SPENT }));
    const res = fakeRes();
    try {
      await mediationHandler(req(step.body), res);
      assert.equal(res.statusCode, 402);
      assert.match(res.json().message, /included AI usage/i);
      assert.equal(w.modelCalls().length, 0, 'not one token of our money was spent');
    } finally { w.restore(); }
  });

  test(`mediation refuses ${step.name} over the rate window too`, async () => {
    const w = witness(mediationRoutes({
      over: step.over,
      meterAnswer: {
        allowed: false, status: 429, reason: 'over_rate_limit', retry_after_seconds: 60,
        message: 'Too many requests in a row. Give it a moment and try again.',
      },
    }));
    const res = fakeRes();
    try {
      await mediationHandler(req(step.body), res);
      assert.equal(res.statusCode, 429);
      assert.equal(res.headers['retry-after'], '60');
      assert.equal(w.modelCalls().length, 0);
    } finally { w.restore(); }
  });
}

test('the mediation meter is charged to the caller, not to a body field', async () => {
  const w = witness(mediationRoutes({ over: { status: 'framework' } }));
  const res = fakeRes();
  try {
    await mediationHandler(
      { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { action: 'framework.issue', caseId: CASE, userId: 'someone-else' } },
      res,
    );
    const charge = w.hits(/rpc\/usage_consume/)[0];
    assert.equal(charge.body.p_user, null, 'the RPC reads auth.uid() from the token and ignores p_user');
    assert.match(String(charge.headers.authorization || ''), /Bearer tok/);
  } finally { w.restore(); }
});
