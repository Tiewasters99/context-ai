// The Orchestrator's document tasks (2026-10-17): send_to_sandbox,
// copy_document, assemble_documents, edit_pdf, create_deck, create_chart —
// proposed by the model, run by the browser through /api/sandbox on the press.
//
//   A. the menu: an ordinary run offers all six, with mcp-core's own schemas;
//      a sealed run drops the two that copy out of the matter and the two the
//      bucket refuses on a sealed matter (096), and keeps deck and chart; a
//      chartered run offers none; a narrowed run only what it was narrowed to.
//   B. the loop (offline, a stubbed sealed pen): a proposal is forwarded as a
//      `confirm` event and never executed; a second proposal in the same turn
//      is refused; a sealed deck is filed into the bound matter whatever
//      matter the model named; a Sandbox copy from a sealed run is refused.
//   C. the system prompt: the Sandbox is explained as an option, one step at
//      a time; the Brief Desk allows a practice copy and still no moves.
//   D. the browser's words: the sentence before the press, the note after it
//      (which must carry every new id — it is all the model sees of the result).
//   E. the server's door: a sealed document copied, moved or sent to the
//      Sandbox out of its seal is refused, and nothing is written to the Record.
//
//   node --test --import ./scripts/_node-src-loader.mjs scripts/_test-orchestrator-sandbox.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { orchestratorMenu, runAssistantStream, bedrockCredsFromEnv, SANDBOX_ACTIONS } from '../lib/assistant-core.mjs';
import { TOOLS } from '../lib/mcp-core.mjs';
import { buildOrchestratorSystem } from '../lib/orchestrator-system.mjs';
import { proposalSentence, resultNote, documentIdsOf, matterKeyOf, isSandboxAction } from '../src/lib/orchestrator-sandbox.ts';

const SIX = ['send_to_sandbox', 'copy_document', 'assemble_documents', 'edit_pdf', 'create_deck', 'create_chart'];
const names = (menu) => new Set(menu.tools.map((t) => t.name));

test('A. an ordinary run offers all six, each with mcp-core’s schema and the proposal wording', () => {
  const menu = orchestratorMenu();
  for (const n of SIX) {
    const t = menu.tools.find((x) => x.name === n);
    assert.ok(t, `${n} offered`);
    assert.deepEqual(t.input_schema, TOOLS.find((x) => x.name === n).inputSchema, `${n}: the browser can pass args straight through`);
    assert.match(t.description, /does NOT run directly/, `${n} says it is a proposal`);
    assert.ok(!menu.runTools.has(n), `${n} is not a server-run tool`);
  }
  assert.deepEqual([...SANDBOX_ACTIONS].sort(), [...SIX].sort());
  for (const n of ['move_document', 'create_sub_matter', 'sign_out', 'search', 'relay_feedback']) assert.ok(names(menu).has(n), `${n} still offered`);
});

test('A. a sealed run keeps deck and chart only', () => {
  const sealed = names(orchestratorMenu({ sealed: true }));
  for (const n of ['send_to_sandbox', 'copy_document', 'assemble_documents', 'edit_pdf', 'move_document', 'relay_feedback']) {
    assert.ok(!sealed.has(n), `${n} not offered inside a seal`);
  }
  assert.ok(sealed.has('create_deck') && sealed.has('create_chart'), 'deck and chart are filed inside the matter');
});

test('A. a chartered run offers none; a narrowed run only its list', () => {
  const chartered = names(orchestratorMenu({ charter: { allowed_tools: ['search'] } }));
  for (const n of SIX) assert.ok(!chartered.has(n), `${n} not in a charter run`);
  const narrowed = names(orchestratorMenu({ narrow: new Set(['search', 'create_deck']) }));
  assert.deepEqual([...narrowed].sort(), ['create_deck', 'search']);
});

// ── B. the loop, offline ────────────────────────────────────────────────
const CREDS = bedrockCredsFromEnv({ BEDROCK_AWS_ACCESS_KEY_ID: 'AKIDTEST', BEDROCK_AWS_SECRET_ACCESS_KEY: 'testsecret' });

function stubSupabase() {
  const table = (name) => {
    const q = {
      select() { return q; }, eq() { return q; }, in() { return q; }, order() { return q; },
      limit() { return Promise.resolve({ data: [], error: null }); },
      maybeSingle() {
        return Promise.resolve(name === 'matterspaces'
          ? { data: { id: 'm-1', parent_matterspace_id: null, ai_tier: 'B' }, error: null }
          : { data: null, error: null });
      },
      single() { return Promise.resolve({ data: null, error: { message: 'stub' } }); },
      insert() {
        const ins = {
          select() { return ins; },
          single() {
            return Promise.resolve(name === 'ai_sessions'
              ? { data: { id: 'sess-1', matterspace_id: 'm-1', tier: 'B', status: 'open' }, error: null }
              : { data: null, error: null });
          },
          then(res) { return Promise.resolve({ data: null, error: null }).then(res); },
        };
        return ins;
      },
      update() { return { eq: () => Promise.resolve({ data: null, error: null }), then: (r) => Promise.resolve({ error: null }).then(r) }; },
    };
    return q;
  };
  return { from: table, rpc: async () => ({ data: [], error: null }) };
}

const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
const callRound = (calls) => sse([
  { choices: [{ index: 0, delta: { tool_calls: calls.map((c, i) => ({ index: i, id: `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
]);
const answer = sse([
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'Set up for you to confirm.' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
]);

async function sealedTurn(calls) {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return new Response(bodies.length === 1 ? callRound(calls) : answer, { status: 200 });
  };
  const events = [];
  try {
    await runAssistantStream({
      supabase: stubSupabase(), anthropicKey: 'ak', fireworksKey: 'fk', bedrockCreds: CREDS, openaiApiKey: 'ok',
      messages: [{ role: 'user', content: 'Build the update deck.' }], matterId: 'm-1', emit: (ev) => events.push(ev),
    });
  } finally { globalThis.fetch = realFetch; }
  const toolResults = (bodies[1]?.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content));
  return { events, bodies, toolResults };
}

test('B. a proposal is forwarded, never run; one per turn; a sealed deck stays in the bound matter', async () => {
  const deck = { matter: 'some-other-matter', title: 'Update', slides: [{ title: 'Where we are' }] };
  const { events, toolResults, bodies } = await sealedTurn([
    { name: 'create_deck', args: deck },
    { name: 'create_chart', args: { matter: 'm-1', type: 'bar', categories: ['a'], series: [{ name: 's', values: [1] }] } },
  ]);
  const confirms = events.filter((e) => e.type === 'confirm');
  assert.equal(confirms.length, 1, 'exactly one proposal reaches the browser');
  assert.equal(confirms[0].action, 'create_deck');
  assert.equal(confirms[0].input.matter, 'm-1', 'the sealed pen’s deck is filed in the sealed matter, not the one it named');
  assert.equal(confirms[0].input.title, 'Update');
  assert.equal(bodies.length, 2, 'the turn finishes after the proposal');
  assert.match(toolResults[0], /awaiting_confirmation/);
  assert.match(toolResults[1], /one document step per turn/);
  assert.ok(!events.some((e) => e.type === 'tool' && SIX.includes(e.name)), 'nothing server-side ran a document task');
});

test('B. a sealed run cannot propose a Sandbox copy, even by naming the tool', async () => {
  const { events, toolResults } = await sealedTurn([{ name: 'send_to_sandbox', args: { document_ids: ['d-1'] } }]);
  assert.equal(events.filter((e) => e.type === 'confirm').length, 0, 'no proposal reaches the browser');
  assert.match(toolResults[0], /not available/);
});

test('C. the system prompt: an option, one step at a time; the desk allows a practice copy', () => {
  const sys = buildOrchestratorSystem({ matterId: 'm', matterName: 'Patel', route: '/app/matterspace/m' });
  assert.match(sys, /DOCUMENT WORK AND THE SANDBOX/);
  assert.match(sys, /The Sandbox is an option, not a rule/);
  assert.match(sys, /one step at a time/);
  assert.match(sys, /combine PDFs into a binder/, 'the what-can-you-do line names it');
  assert.doesNotMatch(sys, /heavier document work .* through Claude over the MCP connector/, 'no longer sent away to claude.ai');
  const desk = buildOrchestratorSystem({ matterId: 'm', brief: { title: 'Opp Brief' } });
  assert.match(desk, /Do not offer to move documents/, 'still no moves from the desk');
  assert.match(desk, /One exception: a practice copy/);
  assert.match(desk, /send_to_sandbox for the brief/);
});

test('D. the sentence before the press names the documents and where the result lands', () => {
  const title = (id) => ({ d1: 'Declaration of Counsel', d2: 'Ex. 1', d3: 'Ex. 2' })[id] ?? id;
  assert.ok(SIX.every(isSandboxAction) && !isSandboxAction('move_document'));
  assert.equal(
    proposalSentence('assemble_documents', { matter: 'pw-open', document_ids: ['d1', 'd2', 'd3'], filename: 'Binder.pdf' }, title, 'Patel World — Open Record'),
    'Combine 3 PDFs into one, in this order: 1. “Declaration of Counsel”; 2. “Ex. 1”; 3. “Ex. 2”? The new PDF, “Binder.pdf”, is filed in “Patel World — Open Record”; the sources are untouched.',
  );
  assert.match(proposalSentence('send_to_sandbox', { document_ids: ['d1'] }, title), /^Copy “Declaration of Counsel” to your Sandbox\? The original stays filed where it is\.$/);
  assert.match(
    proposalSentence('edit_pdf', { document_id: 'd2', pages: '1-13,18-30', rotate: [{ pages: '22', degrees: 90 }] }, title),
    /Edit “Ex\. 1”: keep pages 1-13,18-30, in that order; rotate 22 by 90°\?/,
  );
  assert.deepEqual(documentIdsOf('edit_pdf', { document_id: 'd2', inserts: [{ at: 1, document_id: 'd3', pages: '1' }] }), ['d2', 'd3']);
  assert.equal(matterKeyOf('copy_document', { to_matter: 'x' }), 'x');
  assert.equal(matterKeyOf('create_deck', { matter: 'y' }), 'y');
});

test('D. the note after the press carries every new id and the link', () => {
  const sbx = resultNote('send_to_sandbox', {
    boxes: [{ box: { id: 'b1', short_code: 'sbx-pw-open', name: 'Patel World — Open Record' }, documents: [{ document_id: 'n1', title: 'Opp Brief', copied_from: 'd1' }] }],
  });
  assert.match(sbx, /short_code sbx-pw-open/);
  assert.match(sbx, /id n1/);
  const merged = resultNote('assemble_documents', {
    document_id: 'n9', filename: 'Binder.pdf', page_count: 40, matter: { name: 'Box', short_code: 'sbx-x' },
    manifest: [{ title: 'Declaration', pages_from: 1, pages_to: 4 }], download_url: 'https://example.test/x',
  });
  assert.match(merged, /id n9/);
  assert.match(merged, /pp\. 1–4: “Declaration”/);
  assert.match(merged, /\[Download\]\(https:\/\/example\.test\/x\)/);
  assert.doesNotMatch(resultNote('edit_pdf', { document_id: 'n3', filename: 'e.pdf', page_count: 2, download_url: null }), /Download/, 'no link when none was minted');
});

test('D. a download link in a note becomes a link run; only https; other markup unchanged', async () => {
  const { runsOf } = await import('../src/lib/prose.ts');
  const runs = runsOf('Done. [Download](https://x.supabase.co/storage/v1/a.pdf?token=t) — 15 minutes. **bold** `c` *i*');
  assert.deepEqual(runs.find((r) => r.href), { text: 'Download', href: 'https://x.supabase.co/storage/v1/a.pdf?token=t' });
  assert.ok(runs.some((r) => r.bold && r.text === 'bold') && runs.some((r) => r.code) && runs.some((r) => r.italic));
  assert.ok(!runsOf('[x](javascript:alert(1)) [y](http://e.test)').some((r) => r.href), 'no link for a non-https target');
});

test('B. the last round may still propose one document task (a deck outlined over every round is not lost)', async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  const deckRound = sse([
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Here is the outline.' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_d', type: 'function', function: { name: 'create_deck', arguments: JSON.stringify({ matter: 'elsewhere', title: 'Update', slides: [{ title: 'Where we are' }] }) } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ]);
  globalThis.fetch = async (u, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return new Response(JSON.stringify(body).includes('SEARCH BUDGET USED') ? deckRound : callRound([{ name: 'grep', args: { pattern: 'chiller' } }]), { status: 200 });
  };
  const events = [];
  let text = '';
  try {
    await runAssistantStream({
      supabase: stubSupabase(), anthropicKey: 'ak', fireworksKey: 'fk', bedrockCreds: CREDS, openaiApiKey: 'ok',
      messages: [{ role: 'user', content: 'Make a client deck.' }], matterId: 'm-1',
      emit: (ev) => { events.push(ev); if (ev.type === 'text') text += ev.text ?? ev.delta ?? ''; },
    });
  } finally { globalThis.fetch = realFetch; }
  const last = bodies[bodies.length - 1];
  assert.ok(JSON.stringify(last).includes('SEARCH BUDGET USED'), 'the turn reached its final round');
  assert.notEqual(last.tool_choice, 'none', 'tools stay callable on the final round while a proposal is possible');
  assert.match(JSON.stringify(last), /you may still propose that ONE task/);
  const finalTools = last.tools.map((t) => t.function.name);
  assert.ok(finalTools.length > 0 && finalTools.every((n) => SANDBOX_ACTIONS.has(n)), `only proposals on the last round: ${finalTools}`);
  assert.ok(!finalTools.includes('grep') && !finalTools.includes('search'), 'no more searching');
  const confirms = events.filter((e) => e.type === 'confirm');
  assert.equal(confirms.length, 1, 'the deck reaches the browser as a proposal');
  assert.equal(confirms[0].action, 'create_deck');
  assert.equal(confirms[0].input.matter, 'm-1', 'still filed in the bound sealed matter');
  assert.ok(!events.some((e) => e.type === 'tool' && e.name === 'create_deck'), 'never run server-side');
});

test('B. a final round with no document task on the menu keeps tool_choice none', async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => { const b = JSON.parse(init.body); bodies.push(b); return new Response(JSON.stringify(b).includes('SEARCH BUDGET USED') ? answer : callRound([{ name: 'grep', args: { pattern: 'x' } }]), { status: 200 }); };
  try {
    await runAssistantStream({
      supabase: stubSupabase(), anthropicKey: 'ak', fireworksKey: 'fk', bedrockCreds: CREDS, openaiApiKey: 'ok',
      messages: [{ role: 'user', content: 'Search.' }], matterId: 'm-1', toolNames: ['grep'], emit: () => {},
    });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(bodies[bodies.length - 1].tool_choice, 'none');
});

// ── copy_document's passage copy (live failure 2026-10-18: a 467-passage
// deposition timed out at 100 rows a batch and left a 'ready' copy holding
// part of its text, which the duplicate guard would return on a retry) ──
function copyFake({ failInsert }) {
  const MSRC = 'c0000000-0000-4000-8000-000000000003', SRC = 'a0000000-0000-4000-8000-000000000001', BOX = 'b0000000-0000-4000-8000-000000000002';
  const state = { inserted: 0, batches: [], deletedDocs: [], removed: [] };
  const passages = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, sequence_number: i, summary_level: 0, text: `t${i}` }));
  const chain = (result) => {
    const q = { select: () => q, eq: () => q, order: () => q, limit: () => Promise.resolve(result()), maybeSingle: () => Promise.resolve(result()), single: () => Promise.resolve(result()), then: (r) => Promise.resolve(result()).then(r) };
    return q;
  };
  const sb = {
    from(t) {
      if (t === 'matterspaces') return chain(() => ({ data: { id: BOX, name: 'Box', short_code: 'sbx-x' }, error: null }));
      if (t === 'passages') {
        return {
          ...chain(() => ({ data: passages, error: null })),
          insert(rows) {
            state.batches.push(rows.length);
            const err = failInsert(rows);
            if (!err) state.inserted += rows.length;
            return Promise.resolve({ error: err ? { message: err } : null });
          },
        };
      }
      // documents
      let docsQuery = 0;
      return {
        select: () => chain(() => (docsQuery++, { data: { id: SRC, matterspace_id: MSRC, title: 'Bhatt Dep.', storage_path: `${MSRC}/${SRC}/bhatt.pdf`, source_filename: null }, error: null })),
        insert: () => chain(() => ({ data: { id: 'new-doc', title: 'Bhatt Dep.' }, error: null })),
        update: () => chain(() => ({ error: null })),
        delete: () => ({ eq: (k, v) => { state.deletedDocs.push(v); return Promise.resolve({ error: null }); } }),
      };
    },
    storage: { from: () => ({ copy: async () => ({ error: null }), remove: async (paths) => { state.removed.push(...paths); return { error: null }; } }) },
    auth: { getUser: async () => ({ data: { user: { id: 'u-1' } } }) },
  };
  return { sb, state, SRC, BOX };
}

test('copy_document: big batches that time out are halved, and the copy completes', async () => {
  const { handleCopyDocument } = await import('../lib/mcp-core.mjs');
  const { sb, state, SRC, BOX } = copyFake({ failInsert: (rows) => (rows.length > 10 ? 'canceling statement due to statement timeout' : null) });
  const out = await handleCopyDocument(sb, { document_ids: [SRC], to_matter: BOX });
  assert.equal(out.copies[0].passages, 100);
  assert.equal(state.inserted, 100, 'every passage copied');
  assert.ok(Math.max(...state.batches) <= 40, `first try is at most 40 rows: ${state.batches}`);
  assert.deepEqual(state.deletedDocs, [], 'nothing removed on success');
});

test('copy_document: a copy that still fails is removed whole, and says so', async () => {
  const { handleCopyDocument } = await import('../lib/mcp-core.mjs');
  let n = 0;
  const { sb, state, SRC, BOX } = copyFake({ failInsert: () => (++n > 1 ? 'permission denied for table passages' : null) });
  await assert.rejects(handleCopyDocument(sb, { document_ids: [SRC], to_matter: BOX }), /partial copy was removed/);
  assert.ok(state.inserted > 0, 'part of the text had gone in');
  assert.deepEqual(state.deletedDocs, ['new-doc'], 'the half-made copy is deleted (its passages cascade)');
});

// E. the server's door (api/sandbox.mjs → guardSandboxCrossing): whatever a
// pen proposes, a sealed document does not reach a less sealed matter. The
// sealed run never offers these tools (A, B); this is the second wall.
const SEALED_M = '11111111-1111-4111-8111-111111111111';
const OPEN_M = '22222222-2222-4222-8222-222222222222';
const SEALED_DOC = '33333333-3333-4333-8333-333333333333';
function crossingClient() {
  const rpcs = [];
  const matters = { [SEALED_M]: { id: SEALED_M, parent_matterspace_id: null, ai_tier: 'B' }, [OPEN_M]: { id: OPEN_M, parent_matterspace_id: null, ai_tier: 'A' } };
  return {
    rpcs,
    rpc: async (name, args) => { rpcs.push(name); return name === 'matter_entry' ? { data: 'open', error: null } : { data: { ok: true }, error: null }; },
    from: (table) => ({
      select: () => ({
        in: async (_c, ids) => ({ data: table === 'documents' ? ids.filter((i) => i === SEALED_DOC).map((id) => ({ id, title: 'Sealed doc', matterspace_id: SEALED_M })) : [], error: null }),
        eq: (_c, id) => ({ maybeSingle: async () => ({ data: matters[id] ?? null, error: null }) }),
      }),
    }),
  };
}

test('E. the server refuses a sealed document copied, moved or sent to the Sandbox out of its seal, and records nothing', async () => {
  const { guardSandboxCrossing } = await import('../lib/seal-crossing.mjs');
  const cases = [
    ['copy_document', { document_id: SEALED_DOC, to_matter: 'patel-open' }, 'sealed_copy_refused'],
    ['move_document', { document_id: SEALED_DOC, to_matter: 'patel-open' }, 'sealed_move_refused'],
    ['send_to_sandbox', { document_ids: [SEALED_DOC] }, 'sealed_copy_refused'],
  ];
  for (const [action, args, code] of cases) {
    const sb = crossingClient();
    const out = await guardSandboxCrossing({ action, args, userClient: sb, userId: 'u-1', resolveDestination: async () => ({ id: OPEN_M }) });
    assert.equal(out.refusal?.status, 409, action);
    assert.equal(out.refusal.body.error, code, action);
    assert.ok(!sb.rpcs.includes('ledger_append'), `${action}: a refused crossing writes no export to the Record`);
  }
  // Within the seal (same tier) it goes ahead, written to the Record first.
  const sb = crossingClient();
  const ok = await guardSandboxCrossing({ action: 'copy_document', args: { document_id: SEALED_DOC, to_matter: 'x' }, userClient: sb, userId: 'u-1', resolveDestination: async () => ({ id: SEALED_M }) });
  assert.equal(ok.refusal, undefined);
  assert.ok(sb.rpcs.includes('ledger_append'));
});

// F. finding a document by name (2026-10-18): search matches the words
// inside documents, not their names, and a 2,663-document matter lists in
// three pages of ~140 KB; the sealed pen read page 1 and said a document on
// page 2 was not there. list_matter_contents takes `title` instead.
test('F. list_matter_contents `title`: every word, edge punctuation dropped, LIKE wildcards literal', async () => {
  const { handleListMatterContents } = await import('../lib/mcp-core.mjs');
  const ilikes = [];
  const chain = {
    eq: () => chain, order: () => chain, ilike: (col, pat) => { ilikes.push([col, pat]); return chain; },
    range: async () => ({ data: [{ id: 'd-1', title: 'Anderson v Owens-Corning Fiberglas Corp', doc_type: 'other' }], error: null, count: 1 }),
  };
  const sb = {
    from: (t) => t === 'documents'
      ? { select: () => chain }
      : { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'm-1', short_code: 'm', name: 'M' }, error: null }) }), ilike: () => ({ maybeSingle: async () => ({ data: { id: 'm-1', short_code: 'm', name: 'M' }, error: null }) }) }) },
  };
  const r = await handleListMatterContents(sb, { matter: 'm', title: '  Anderson v. Owens-Corning  50%_off ' });
  assert.deepEqual(ilikes, [['title', '%Anderson%'], ['title', '%v%'], ['title', '%Owens-Corning%'], ['title', '%50\\%\\_off%']]);
  assert.equal(r.title_filter, 'Anderson v Owens-Corning 50%_off');
  assert.equal(r.document_count, 1);
  const schema = TOOLS.find((t) => t.name === 'list_matter_contents');
  assert.ok(schema.inputSchema.properties.title && /by name, pass `title`/.test(schema.description));
});
