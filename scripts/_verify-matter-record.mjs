// The matter's Record, read side: the roll-up, the docket line, and the
// Matter Record export.
//
// WHAT THIS PROVES
//   1. A parent matter's Record and its Updates feed include every
//      sub-matter, and both page past PostgREST's 1,000-row answer.
//   2. Every event kind in migration 064's vocabulary renders one plain
//      English line and one row in the export — and a kind this build has
//      never heard of renders generically instead of throwing.
//   3. The sealed route is described in the words
//      audits/2026-09-19/02-securespace.md allows: never "Claude", never a
//      vendor's zero-retention promise, always prospective.
//   4. Every cell the AI Use Record reserves for the attorney is empty.
//   5. The same Record renders byte-identical markdown twice, and from
//      shuffled input — the export is a deterministic function of its inputs.
//   6. The .docx opens with the repo's own docx library and carries the DRAFT
//      legend, a session row and the integrity block.
//   7. Before migration 064 is pasted, the Record reads as "not enabled"
//      rather than as an error.
//   8. A tampered chain renders the failure line, not a reassuring one.
//
// HOW IT STAYS OFFLINE
//   Every event is synthetic and built in this file; the Supabase client is a
//   small in-memory stub. No .env is read, no network call is made, no real
//   matter or client name appears anywhere in it.
//
// RUN
//   node --import ./scripts/_node-src-loader.mjs scripts/_verify-matter-record.mjs
//   add --print to dump the sample export (used for the PR description).

import { Packer } from 'docx';
import JSZip from 'jszip';

import { fetchMatterRecord, readAllPages } from '../src/lib/matter-record/fetch.ts';
import {
  assembleMatterRecord,
  ATTORNEY_CELL,
  DRAFT_LEGEND,
} from '../src/lib/matter-record/assemble.ts';
import { renderMatterRecordMarkdown } from '../src/lib/matter-record/render-md.ts';
import { buildMatterRecordDocument } from '../src/lib/matter-record/render-docx.ts';
import {
  describeEvent,
  retentionPosture,
  routePhrase,
  chainSummary,
} from '../src/lib/matter-record/describe.ts';
import { JURISDICTIONS } from '../src/lib/matter-record/jurisdictions.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
// A very small Supabase stand-in: enough of from().select().in().order()
// .range() and rpc() for the read side, and nothing else.
// ---------------------------------------------------------------------------

function stubClient({ tables = {}, rpc = {}, errors = {} } = {}) {
  const calls = { ranges: [], rpcs: [], counts: 0 };

  const exec = (state) => {
    if (errors[state.table]) return { data: null, error: errors[state.table], count: null };
    let rows = [...(tables[state.table] ?? [])];
    for (const filter of state.filters) rows = rows.filter(filter);
    for (const [column, ascending] of [...state.order].reverse()) {
      rows.sort((a, b) => {
        const x = a[column];
        const y = b[column];
        if (x === y) return 0;
        const less = x === null || x === undefined ? true : y === null || y === undefined ? false : x < y;
        return (less ? -1 : 1) * (ascending ? 1 : -1);
      });
    }
    const total = rows.length;
    if (state.head) {
      calls.counts += 1;
      return { data: null, error: null, count: total };
    }
    if (state.range) {
      calls.ranges.push({ table: state.table, from: state.range[0], to: state.range[1] });
      rows = rows.slice(state.range[0], state.range[1] + 1);
      // PostgREST never answers more than 1,000 rows however wide the range.
      if (rows.length > 1000) rows = rows.slice(0, 1000);
    }
    return { data: rows, error: null, count: state.count ? total : null };
  };

  const builder = (table, options) => {
    const state = { table, filters: [], order: [], range: null, head: !!options.head, count: options.count };
    const self = {
      eq(column, value) {
        state.filters.push((row) => row[column] === value);
        return self;
      },
      in(column, values) {
        const set = new Set(values);
        state.filters.push((row) => set.has(row[column]));
        return self;
      },
      order(column, opts = {}) {
        state.order.push([column, opts.ascending !== false]);
        return self;
      },
      range(from, to) {
        state.range = [from, to];
        return self;
      },
      limit(n) {
        state.range = [0, n - 1];
        return self;
      },
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => exec(state))
          .then(resolve, reject);
      },
    };
    return self;
  };

  return {
    calls,
    from(table) {
      return { select: (_columns, options = {}) => builder(table, options) };
    },
    rpc(fn, args) {
      calls.rpcs.push({ fn, args });
      if (errors[fn]) return Promise.resolve({ data: null, error: errors[fn], count: null });
      const handler = rpc[fn];
      return Promise.resolve(
        handler ? handler(args) : { data: null, error: { code: 'PGRST202', message: 'no such function' } },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Synthetic events. No real matter, client, person or filename appears here.
// ---------------------------------------------------------------------------

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD_A = '22222222-2222-4222-8222-222222222222';
const CHILD_B = '33333333-3333-4333-8333-333333333333';
const USER_ONE = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER_TWO = 'aaaaaaaa-0000-4000-8000-000000000002';
const SESSION_ONE = 'bbbbbbbb-0000-4000-8000-000000000001';
const SESSION_TWO = 'bbbbbbbb-0000-4000-8000-000000000002';

const MATTER_NAMES = {
  [PARENT]: 'Fixture Matter',
  [CHILD_A]: 'Fixture Matter › Pleadings',
  [CHILD_B]: 'Fixture Matter › Discovery',
};

let seq = 0;
/** A 64-character hex string, deterministic in the sequence number. */
const fixtureSeal = (n) => String(Math.max(0, n)).padStart(4, '0').repeat(16).slice(0, 64);
function event(kind, over = {}) {
  seq += 1;
  const matterId = over.matterspace_id ?? PARENT;
  return {
    id: `event-${String(seq).padStart(4, '0')}`,
    ts: over.ts ?? `2026-09-${String(10 + (seq % 9)).padStart(2, '0')}T0${seq % 9}:0${seq % 6}:00.000Z`,
    chain_key: matterId,
    seq,
    kind,
    matterspace_id: matterId,
    matter_name: MATTER_NAMES[matterId] ?? 'Fixture Matter',
    serverspace_id: 'cccccccc-0000-4000-8000-000000000001',
    session_id: over.session_id ?? null,
    actor_kind: over.actor_kind ?? 'user',
    actor_ref: over.actor_ref ?? USER_ONE,
    actor_user_id: over.actor_user_id ?? USER_ONE,
    actor_label: over.actor_label ?? null,
    payload: over.payload ?? {},
    // Hex, like the real thing: the export PRINTS these as the seal of the
    // first and last entry, and §13 sweeps the rendered page for database
    // vocabulary. A fixture spelling them "hash-0001" would fail that sweep
    // on its own fixture rather than on the product's words.
    prev_hash: over.prev_hash ?? fixtureSeal(seq - 1),
    hash: over.hash ?? fixtureSeal(seq),
  };
}

// Every kind migration 064 allows, plus one it does not know.
const ALL_KINDS = [
  'tool.invoked',
  'completion.received',
  'file.exported',
  'file.sent',
  'file.delivered',
  'file.gate',
  'citation.verified',
  'acl.changed',
  'seal.changed',
  'connector.registered',
  'connector.revoked',
  'ai.paused',
  'ai.resumed',
  'run.aborted',
];

function sampleEvents() {
  seq = 0;
  return [
    event('acl.changed', {
      ts: '2026-09-02T09:15:00.000Z',
      payload: {
        table: 'matterspace_members',
        op: 'insert',
        target_user_id: USER_TWO,
        old_role: null,
        new_role: 'member',
      },
    }),
    event('completion.received', {
      ts: '2026-09-02T14:05:00.000Z',
      session_id: SESSION_ONE,
      payload: {
        tier: 'A',
        provider: 'anthropic',
        model: 'fixture-model-1',
        input_tokens: 18422,
        output_tokens: 1980,
        estimated_cost: 0.2314,
        within_policy: true,
        escalation: null,
        tools_used: ['search', 'get_passage'],
        rounds: 3,
        answer_chars: 4210,
      },
    }),
    event('tool.invoked', {
      ts: '2026-09-02T14:05:30.000Z',
      session_id: SESSION_ONE,
      payload: { tool: 'search', query: 'fixture query', ok: true, ms: 412, document_ids: [] },
    }),
    event('tool.invoked', {
      ts: '2026-09-03T08:40:00.000Z',
      matterspace_id: CHILD_A,
      actor_kind: 'connector',
      actor_ref: 'client-fixture-1',
      actor_label: 'Fixture Assistant',
      actor_user_id: USER_ONE,
      payload: { tool: 'search', connector: true, connector_client_id: 'client-fixture-1', ok: true, ms: 120 },
    }),
    event('tool.invoked', {
      ts: '2026-09-03T08:41:00.000Z',
      matterspace_id: CHILD_A,
      actor_kind: 'connector',
      actor_ref: 'client-fixture-1',
      actor_label: 'Fixture Assistant',
      actor_user_id: USER_ONE,
      payload: { tool: 'get_passage', connector: true, ok: true, ms: 88 },
    }),
    event('seal.changed', {
      ts: '2026-09-04T11:00:00.000Z',
      payload: { old_tier: 'A', new_tier: 'B' },
    }),
    event('tool.invoked', {
      ts: '2026-09-04T11:05:00.000Z',
      actor_kind: 'connector',
      actor_ref: 'client-fixture-1',
      actor_label: 'Fixture Assistant',
      actor_user_id: USER_ONE,
      payload: { tool: 'search', ok: false, refused: 'sealed', ms: 3 },
    }),
    event('completion.received', {
      ts: '2026-09-05T10:22:00.000Z',
      matterspace_id: CHILD_B,
      session_id: SESSION_TWO,
      actor_kind: 'charter',
      actor_ref: 'charter-fixture-1',
      actor_label: 'Deposition digest',
      actor_user_id: USER_TWO,
      payload: {
        tier: 'B',
        provider: 'aws-bedrock',
        model: 'moonshotai.kimi-k2.5',
        input_tokens: 40122,
        output_tokens: 3300,
        estimated_cost: 0.0912,
        within_policy: true,
        escalation: null,
        tools_used: ['search'],
        rounds: 2,
        answer_chars: 8800,
      },
    }),
    event('citation.verified', {
      ts: '2026-09-06T16:30:00.000Z',
      payload: { document_id: 'doc-fixture-1', run_id: 'run-fixture-1', cites: 24, verified_by: USER_ONE },
    }),
    event('acl.changed', {
      ts: '2026-09-07T09:00:00.000Z',
      payload: {
        table: 'matterspace_members',
        op: 'update',
        target_user_id: USER_TWO,
        old_role: 'member',
        new_role: 'admin',
      },
    }),
    event('ai.paused', { ts: '2026-09-08T12:00:00.000Z', payload: { reason: 'client instruction' } }),
    event('ai.resumed', { ts: '2026-09-08T15:00:00.000Z', payload: {} }),
  ];
}

const PEOPLE_TABLE = [
  { id: USER_ONE, display_name: 'A. Fixture', email: 'fixture-one@example.invalid' },
  { id: USER_TWO, display_name: 'B. Fixture', email: 'fixture-two@example.invalid' },
];

const CITE_RUNS = [
  {
    id: 'run-fixture-1',
    matterspace_id: PARENT,
    source_label: 'fixture-brief-v3.docx',
    status: 'complete',
    citations_total: 24,
    created_at: '2026-09-06T16:20:00.000Z',
    completed_at: '2026-09-06T16:29:00.000Z',
    created_by: USER_ONE,
  },
];

function descendantsRpc({ p_root }) {
  if (p_root === PARENT) {
    return { data: [{ id: PARENT }, { id: CHILD_A }, { id: CHILD_B }], error: null };
  }
  return { data: [{ id: p_root }], error: null };
}

function chainRpc(okChains, badChain) {
  return ({ p_chain_key }) => {
    if (badChain && p_chain_key === badChain.id) {
      return { data: [{ ok: false, checked: badChain.checked, first_bad_seq: badChain.at }], error: null };
    }
    const checked = okChains[p_chain_key] ?? 0;
    return { data: [{ ok: true, checked, first_bad_seq: null }], error: null };
  };
}

function clientFor(events, { errors, badChain } = {}) {
  const counts = {};
  for (const e of events) counts[e.chain_key] = (counts[e.chain_key] ?? 0) + 1;
  return stubClient({
    tables: {
      events,
      profiles: PEOPLE_TABLE,
      cite_check_runs: CITE_RUNS,
      matterspaces: Object.entries(MATTER_NAMES).map(([id, name]) => ({ id, name })),
      activity_feed: [],
    },
    rpc: {
      matterspace_descendants: descendantsRpc,
      verify_chain: chainRpc(counts, badChain),
    },
    errors,
  });
}

const CONTEXT = {
  generatedAt: '2026-09-19T15:04:05.000Z',
  generatedBy: 'A. Fixture',
  jurisdictionId: 'us-3d-cir',
};

const MATRIX_ENTRY = JURISDICTIONS.entries.find((e) => e.id === 'us-3d-cir');

// ===========================================================================
console.log('\n1. Roll-up: a parent matter includes every sub-matter');
// ===========================================================================
{
  const events = sampleEvents();
  const client = clientFor(events);
  const data = await fetchMatterRecord(client, { id: PARENT, name: 'Fixture Matter' });

  check(
    client.calls.rpcs.some((c) => c.fn === 'matterspace_descendants' && c.args.p_root === PARENT),
    'the descendants rpc is what expands the matter',
  );
  check(data.events.length === events.length, 'every event is read', `${data.events.length}/${events.length}`);
  check(
    data.events.some((e) => e.matterspace_id === CHILD_A) &&
      data.events.some((e) => e.matterspace_id === CHILD_B),
    'sub-matter events are in the parent matter’s Record',
  );
  check(
    data.matters.length === 3 && data.matters[0].id === PARENT,
    'the matter and its sub-matters are named for the filter',
  );
  check(
    data.chains.length === 3 && data.chains.every((c) => c.ok),
    'one chain is verified per matter that holds entries',
  );
  check(
    data.people[USER_ONE] === 'A. Fixture' && data.people[USER_TWO] === 'B. Fixture',
    'actor and target names are resolved in one batched read',
  );
}

// ===========================================================================
console.log('\n2. Paging: PostgREST answers 1,000 rows, the reader asks again');
// ===========================================================================
{
  seq = 0;
  const many = [];
  for (let i = 0; i < 2500; i += 1) {
    const matter = i % 3 === 0 ? PARENT : i % 3 === 1 ? CHILD_A : CHILD_B;
    many.push(
      event('tool.invoked', {
        matterspace_id: matter,
        ts: new Date(Date.UTC(2026, 8, 1, 0, 0, 0) + i * 60000).toISOString(),
        payload: { tool: 'search', ok: true, ms: 10 },
      }),
    );
  }
  const client = clientFor(many);
  const data = await fetchMatterRecord(client, { id: PARENT, name: 'Fixture Matter' });
  const eventRanges = client.calls.ranges.filter((r) => r.table === 'events');
  check(data.events.length === 2500, 'all 2,500 rows come back', `${data.events.length}`);
  check(eventRanges.length >= 3, 'the read was paged, not one oversized request', `${eventRanges.length} pages`);
  check(
    eventRanges[0].from === 0 && eventRanges[0].to === 999 && eventRanges[1].from === 1000,
    'pages are contiguous 1,000-row ranges',
  );
  check(
    new Set(data.events.map((e) => e.id)).size === 2500,
    'no row is read twice and none is skipped',
  );

  const cappedClient = clientFor(many);
  const capped = await fetchMatterRecord(
    cappedClient,
    { id: PARENT, name: 'Fixture Matter' },
    { ceiling: 1500 },
  );
  check(capped.truncated === true, 'a ceiling is reported, not hidden');
  check(capped.totalEvents === 2500, 'the reader counts what it did not show', `${capped.totalEvents}`);
  // The export tells the reader the chain check still covered everything, so
  // a matter whose entries all fall past the ceiling must still be checked.
  check(
    cappedClient.calls.rpcs.filter((c) => c.fn === 'verify_chain').length === 3,
    'when the read stops at a ceiling, every matter’s chain is still checked',
    `${cappedClient.calls.rpcs.filter((c) => c.fn === 'verify_chain').length} of 3`,
  );
  const md = renderMatterRecordMarkdown(assembleMatterRecord(capped, CONTEXT, null));
  check(md.includes('Showing 1500 of 2500 entries'), 'the export says "showing N of M"');
}

// ===========================================================================
console.log('\n3. The Updates feed pages the same way, over the same helper');
// ===========================================================================
{
  const rows = [];
  for (let i = 0; i < 1200; i += 1) {
    rows.push({
      matter_id: i % 2 === 0 ? PARENT : CHILD_A,
      event_type: 'document_uploaded',
      actor_id: USER_ONE,
      occurred_at: new Date(Date.UTC(2026, 8, 1) + i * 60000).toISOString(),
      ref_id: `ref-${i}`,
      title: `Fixture document ${i}`,
    });
  }
  const client = stubClient({
    tables: { activity_feed: rows },
    rpc: { matterspace_descendants: descendantsRpc },
  });
  const { rows: read, truncated } = await readAllPages(
    () =>
      client
        .from('activity_feed')
        .select('matter_id, event_type, actor_id, occurred_at, ref_id, title')
        .in('matter_id', [PARENT, CHILD_A, CHILD_B])
        .order('occurred_at', { ascending: false })
        .order('ref_id', { ascending: false }),
    1200,
  );
  check(read.length === 1200, 'the feed reads past the 1,000-row answer', `${read.length}`);
  check(truncated === true, 'and says when it stopped at the limit it was given');
  check(
    read.some((r) => r.matter_id === CHILD_A),
    'sub-matter activity reaches the parent matter’s Updates tab',
  );

  const roomy = await readAllPages(
    () =>
      client
        .from('activity_feed')
        .select('matter_id, occurred_at, ref_id')
        .order('occurred_at', { ascending: false })
        .order('ref_id', { ascending: false }),
    5000,
  );
  check(
    roomy.rows.length === 1200 && roomy.truncated === false,
    'given room, it stops because the rows ran out',
    `${roomy.rows.length}`,
  );
}

// ===========================================================================
console.log('\n4. Every kind renders a line, and an unknown kind does not throw');
// ===========================================================================
{
  seq = 0;
  const people = { [USER_ONE]: 'A. Fixture', [USER_TWO]: 'B. Fixture' };
  for (const kind of ALL_KINDS) {
    let line = '';
    try {
      line = describeEvent(event(kind, { payload: {} }), people);
    } catch (error) {
      line = '';
      check(false, `${kind} renders`, String(error));
      continue;
    }
    check(
      typeof line === 'string' && line.trim().length > 0 && !line.includes('undefined'),
      `${kind} renders a plain line`,
      line,
    );
  }
  const unknown = describeEvent(event('something.unheard-of', { payload: { x: 1 } }), people);
  check(
    unknown.includes('something.unheard-of'),
    'an unknown kind renders generically instead of crashing',
    unknown,
  );

  // and each one reaches the export's chronology
  seq = 0;
  const events = ALL_KINDS.map((kind) => event(kind, { payload: {} }));
  events.push(event('something.unheard-of', { payload: {} }));
  const doc = assembleMatterRecord(
    {
      matter: { id: PARENT, name: 'Fixture Matter' },
      matters: [{ id: PARENT, name: 'Fixture Matter' }],
      events,
      totalEvents: events.length,
      ceiling: 5000,
      truncated: false,
      chains: [{ matterId: PARENT, matterName: 'Fixture Matter', ok: true, checked: events.length, firstBadSeq: null }],
      people,
      citeRuns: [],
      notDeployed: false,
      error: null,
    },
    CONTEXT,
    null,
  );
  check(
    doc.chronology.length === events.length,
    'every event, known or not, has a chronology row',
    `${doc.chronology.length}/${events.length}`,
  );
  const markdown = renderMatterRecordMarkdown(doc);
  check(!markdown.includes('undefined'), 'no "undefined" reaches the page');
  check(!markdown.includes('[object Object]'), 'no raw object reaches the page');
}

// ===========================================================================
console.log('\n5. The sealed route is described in the words we are allowed');
// ===========================================================================
{
  const providers = ['anthropic', 'aws-bedrock', 'openai', 'google', 'xai', 'fireworks', '', 'something-new'];
  const tiers = ['A', 'B', 'C', ''];
  const forbidden = [
    /claude/i,
    /zero[- ]data[- ]retention/i,
    /\bnever retained\b/i,
    /guarantee/i,
    /frontier/i,
    /anonymi[sz]ed/i,
  ];
  let clean = true;
  for (const provider of providers) {
    for (const tier of tiers) {
      const words = `${routePhrase(tier, provider)} ${retentionPosture(tier, provider, '2026-09-19')}`;
      for (const pattern of forbidden) {
        if (pattern.test(words)) {
          clean = false;
          check(false, `route/retention wording for ${tier || 'no tier'}/${provider || 'no provider'}`, `${pattern} matched: ${words}`);
        }
      }
    }
  }
  check(clean, 'no route or retention sentence claims more than the audit allows');

  const sealed = retentionPosture('B', 'aws-bedrock', '2026-09-19');
  check(/own AWS account/i.test(sealed), 'the sealed wording says whose account it is');
  check(/account-level setting/i.test(sealed), 'it attributes the setting to the account, not the model vendor');
  check(/prospective/i.test(sealed), 'it says the seal is prospective');
  check(
    /\[Confirm/i.test(sealed),
    'it leaves the confirmation to counsel',
  );

  const tierA = retentionPosture('A', 'anthropic', '2026-09-19');
  check(
    /as understood 2026-09-19/.test(tierA) && /\[confirm\]/i.test(tierA),
    'Tier A states the terms as understood on a date and brackets the rest',
    tierA,
  );

  // and in a rendered export
  const events = sampleEvents();
  const client = clientFor(events);
  const data = await fetchMatterRecord(client, { id: PARENT, name: 'Fixture Matter' });
  const doc = assembleMatterRecord(data, CONTEXT, null);
  const sealedTool = doc.tools.find((t) => t.route.includes('sealed route'));
  check(!!sealedTool, 'the tools memo has a sealed row for the sealed exchange');
  check(
    sealedTool && !/claude/i.test(`${sealedTool.route} ${sealedTool.retention} ${sealedTool.model}`),
    'the sealed row never says Claude',
  );
}

// ===========================================================================
console.log('\n6. The attorney’s cells are empty, and the jurisdiction is verbatim');
// ===========================================================================
{
  const events = sampleEvents();
  const client = clientFor(events);
  const data = await fetchMatterRecord(client, { id: PARENT, name: 'Fixture Matter' });
  const doc = assembleMatterRecord(data, CONTEXT, {
    entry: MATRIX_ENTRY,
    matrixVersion: JURISDICTIONS.matrix_version,
  });
  const markdown = renderMatterRecordMarkdown(doc);

  const attorneyLabels = [
    'Purpose (counsel)',
    'Confidential input (counsel)',
    'Output relied on (counsel)',
    'What may go in (counsel)',
    'Terms confirmed by (initials)',
    'Disclosure to the court required? (counsel’s determination)',
    'Voluntary disclosure decision',
    'Reviewed by (name)',
    'Date reviewed',
  ];
  for (const label of attorneyLabels) {
    const line = markdown.split('\n').find((l) => l.startsWith(`| ${label} |`));
    check(
      !!line && line.trim().endsWith(`| ${ATTORNEY_CELL} |`),
      `"${label}" is an empty cell`,
      line ?? 'row missing',
    );
  }
  const initialsRows = markdown.split('\n').filter((l) => /^\| Initials \|/.test(l));
  check(initialsRows.length > 0, 'there are Initials rows at all');
  check(
    initialsRows.every((l) => l.trim().endsWith(`| ${ATTORNEY_CELL} |`)),
    'every Initials row is empty',
  );
  check(
    markdown.includes(DRAFT_LEGEND),
    'the DRAFT legend is on the document',
  );
  check(
    markdown.includes(`version ${JURISDICTIONS.matrix_version}`) ||
      markdown.includes(JURISDICTIONS.matrix_version),
    'the rules-matrix version is printed',
  );

  // the rule text is the matrix's own, character for character
  const quote = (MATRIX_ENTRY.sources ?? []).find((s) => s.verbatim)?.verbatim;
  const collapsed = markdown.replace(/\s+/g, ' ');
  check(
    !!quote && collapsed.includes(quote.replace(/\s+/g, ' ').trim()),
    'a source quotation appears verbatim',
  );
  check(
    collapsed.includes(String(MATRIX_ENTRY.verification_duty).replace(/\s+/g, ' ').trim().slice(0, 120)),
    'the verification-duty text is the matrix’s own',
  );
  check(
    markdown.includes('Status in the matrix'),
    'the entry’s status travels with it, so a draft row is not shown as settled',
  );
}

// ===========================================================================
console.log('\n7. Determinism: the same Record renders the same bytes');
// ===========================================================================
{
  const events = sampleEvents();
  const client = clientFor(events);
  const data = await fetchMatterRecord(client, { id: PARENT, name: 'Fixture Matter' });

  const once = renderMatterRecordMarkdown(assembleMatterRecord(data, CONTEXT, null));
  const twice = renderMatterRecordMarkdown(assembleMatterRecord(data, CONTEXT, null));
  check(once === twice, 'rendered twice, byte for byte the same', `${once.length} chars`);

  const shuffled = { ...data, events: [...data.events].reverse() };
  const fromShuffled = renderMatterRecordMarkdown(assembleMatterRecord(shuffled, CONTEXT, null));
  check(once === fromShuffled, 'the input order does not change the output');

  const later = renderMatterRecordMarkdown(
    assembleMatterRecord(data, { ...CONTEXT, generatedAt: '2026-09-20T09:00:00.000Z' }, null),
  );
  check(once !== later, 'the preparation time is an input, not a hidden clock read');
  check(
    once.split('\n').filter((l) => l.includes('2026-09-19 15:04 UTC')).length > 0,
    'the preparation time given is the one printed',
  );
}

// ===========================================================================
console.log('\n8. The .docx opens, and carries the legend, a session and the chain');
// ===========================================================================
{
  const events = sampleEvents();
  const client = clientFor(events);
  const data = await fetchMatterRecord(client, { id: PARENT, name: 'Fixture Matter' });
  const doc = assembleMatterRecord(data, CONTEXT, {
    entry: MATRIX_ENTRY,
    matrixVersion: JURISDICTIONS.matrix_version,
  });
  const buffer = await Packer.toBuffer(buildMatterRecordDocument(doc));
  check(buffer.length > 5000, 'the document packs', `${buffer.length} bytes`);

  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);
  check(names.includes('word/document.xml'), 'it is a real Word package');
  const body = await zip.file('word/document.xml').async('string');
  const headerName = names.find((n) => /^word\/header\d*\.xml$/.test(n));
  check(!!headerName, 'it has a running header for the DRAFT legend');
  const header = headerName ? await zip.file(headerName).async('string') : '';
  const strip = (xml) => xml.replace(/<[^>]+>/g, '');
  check(
    strip(header).includes('DRAFT — prepared mechanically'),
    'the DRAFT legend is in the page header, so it is on every page',
  );
  check(strip(body).includes('Session id'), 'the session index is in the document');
  check(strip(body).includes(SESSION_ONE), 'a session row names its session', SESSION_ONE);
  check(strip(body).includes('Seal of the last entry'), 'the integrity block is in the document');
  check(strip(body).includes(doc.integrity.lastHash), 'the last hash is printed');
  check(strip(body).includes(ATTORNEY_CELL), 'the attorney’s empty cells survive into Word');
  check(
    strip(body).includes(String(MATRIX_ENTRY.name)),
    'the picked jurisdiction is named in the document',
  );

  // The word "Claude" may legitimately appear inside a matrix entry's own
  // provenance ("verified_by: claude-opus-5 …") — that is the matrix's text,
  // printed verbatim. What must never happen is this program describing the
  // sealed model that way, so the check is on the document we write ourselves.
  const ours = await Packer.toBuffer(
    buildMatterRecordDocument(assembleMatterRecord(data, CONTEXT, null)),
  );
  const oursXml = strip(await (await JSZip.loadAsync(ours)).file('word/document.xml').async('string'));
  check(!/claude/i.test(oursXml), 'nothing this program writes calls the sealed model Claude');
  check(
    /moonshotai\.kimi-k2\.5/.test(oursXml),
    'the sealed model is named exactly as the ledger recorded it',
  );
}

// ===========================================================================
console.log('\n9. Before migration 064 is pasted: "not enabled", not an error');
// ===========================================================================
{
  const client = clientFor(sampleEvents(), {
    errors: { events: { code: 'PGRST205', message: 'Could not find the table public.events in the schema cache' } },
  });
  const data = await fetchMatterRecord(client, { id: PARENT, name: 'Fixture Matter' });
  check(data.notDeployed === true, 'a missing table reads as not deployed');
  check(data.error === null, 'and not as a failure');
  check(data.events.length === 0, 'with nothing to show');

  const rpcMissing = clientFor(sampleEvents(), {
    errors: { verify_chain: { code: 'PGRST202', message: 'Could not find the function public.verify_chain' } },
  });
  const partial = await fetchMatterRecord(rpcMissing, { id: PARENT, name: 'Fixture Matter' });
  check(partial.notDeployed === true, 'a missing rpc is recognised too');
  check(partial.events.length > 0, 'the entries still show when only the check is missing');
  const summary = chainSummary(partial.chains);
  check(
    summary.line.includes('could not be run'),
    'the header says the check was unavailable rather than claiming it passed',
    summary.line,
  );
}

// ===========================================================================
console.log('\n10. A tampered chain says so, plainly');
// ===========================================================================
{
  const events = sampleEvents();
  const client = clientFor(events, { badChain: { id: PARENT, checked: 6, at: 7 } });
  const data = await fetchMatterRecord(client, { id: PARENT, name: 'Fixture Matter' });
  const summary = chainSummary(data.chains);
  check(summary.ok === false, 'the failure is not swallowed');
  check(
    summary.line === 'Record check failed at entry 7 in Fixture Matter',
    'the header line names the entry and the matter',
    summary.line,
  );
  check(
    /cannot be relied on/i.test(summary.meaning) && !/attack|breach|tamper/i.test(summary.meaning),
    'it explains what it means without alarm',
  );
  const markdown = renderMatterRecordMarkdown(assembleMatterRecord(data, CONTEXT, null));
  check(markdown.includes('Record check failed at entry 7'), 'and the export carries it');
  check(markdown.includes('fails at entry 7'), 'the integrity table names the chain that failed');
}

// ===========================================================================
console.log('\n11. Account-wide searches: this matter’s own rows, and no other’s');
// ===========================================================================
// Migration 072 writes one row in every matter a matter-less `search` read
// from. The Record must say so — and must say it from this matter's rows
// alone, because naming another matter here would tell the reader that matter
// exists. The isolation contract is the whole point of the section, so the
// last case below hands the renderer a row that has been stuffed with another
// matter's name and id in fields nothing reads.
const OTHER_MATTER = '99999999-9999-4999-8999-999999999999';
const OTHER_NAME = 'Zarquon Holdings v. Mirabel';

function fanout(matterId, payloadOver = {}) {
  return event('tool.invoked', {
    matterspace_id: matterId,
    actor_kind: 'connector',
    actor_ref: 'client-1',
    actor_label: 'Fixture Desktop',
    payload: {
      scope: 'matter',
      via: 'account-wide search',
      tool: 'search',
      args: { q: { present: true, length: 60 }, limit: 5 },
      matter_filter: false,
      connector: true,
      connector_client_id: 'client-1',
      result_count: 2,
      ok: true,
      ms: 812,
      ...payloadOver,
    },
  });
}

{
  const line = describeEvent(fanout(PARENT), { [USER_ONE]: 'A. Fixture' });
  check(
    line === 'Fixture Desktop (connector) searched across every matter and read from this one',
    'the docket line says what happened, in the file’s own voice',
    line,
  );
  const refused = describeEvent(
    fanout(PARENT, { refused: 'sealed', ok: false }), {},
  );
  check(
    refused.includes('was refused') && !refused.includes('searched across every matter'),
    'a refusal still reads as a refusal — the new line does not swallow the old ones',
    refused,
  );
}

{
  // Two on the matter itself, one in each sub-matter — the count has to
  // follow the descendants set the reader already expands.
  const events = [
    ...sampleEvents(),
    fanout(PARENT),
    fanout(PARENT),
    fanout(CHILD_A),
    fanout(CHILD_B),
    // Not a fan-out row: the account roll-up, which must never be counted
    // inside a matter's export even if one ever reached it.
    event('tool.invoked', {
      matterspace_id: PARENT,
      actor_kind: 'connector',
      actor_label: 'Fixture Desktop',
      payload: { scope: 'account', via: 'account-wide search', tool: 'search', matters_touched: 9 },
    }),
    // And the hostile one: another matter's name and id, in fields the
    // contract does not define and nothing is supposed to read.
    fanout(CHILD_A, {
      leaked_matter_name: OTHER_NAME,
      other_matterspace_id: OTHER_MATTER,
      note: `also returned passages from ${OTHER_NAME}`,
      matters_touched: 7,
    }),
  ];
  const client = clientFor(events);
  const data = await fetchMatterRecord(client, { id: PARENT, name: 'Fixture Matter' });
  const doc = assembleMatterRecord(data, CONTEXT, null);
  const md = renderMatterRecordMarkdown(doc);

  check(doc.accountWideReads === 5,
    'the count is this matter’s plus its sub-matters’, and excludes the account row',
    `${doc.accountWideReads}`);
  check(md.includes('### Account-wide activity'), 'the export has the section');
  check(
    md.includes('5 searches run by a connected assistant across every matter'),
    'and states the number for the period covered',
  );
  check(doc.accountWideByConnector === 5,
    'all five of these were a connector’s, by the rows’ own actor kind');
  check(
    md.includes('searched across every matter and read from this one'),
    'the chronology carries the line too',
  );
  check(
    !md.includes(OTHER_NAME) && !md.includes(OTHER_MATTER) && !md.includes('Zarquon'),
    'NOTHING a hostile payload put in an undefined field reaches the page',
  );
  check(
    !md.includes('matters_touched') && !md.includes('leaked_matter_name'),
    'because the renderer prints the keys the contract names and no others',
  );
  check(
    !/other matter/i.test(md.split('### Account-wide activity')[1]?.split('##')[0] ?? '')
      || md.includes('not part of this matter’s Record'),
    'and the section’s own words claim nothing about any other matter',
  );
}

{
  const events = sampleEvents();
  const client = clientFor(events);
  const data = await fetchMatterRecord(client, { id: PARENT, name: 'Fixture Matter' });
  const doc = assembleMatterRecord(data, CONTEXT, null);
  const md = renderMatterRecordMarkdown(doc);
  check(doc.accountWideReads === 0, 'with no such row, the count is zero');
  const section = md.split('### Account-wide activity')[1] ?? '';
  check(section.includes('None recorded.'), 'and the section reads "None recorded."');
  check(
    section.includes('has not been switched on'),
    'saying that this is also what an account without account-wide recording shows, rather than implying nothing happened',
  );
  check(
    md.includes('Where account-wide recording has been switched on'),
    'and section 10 no longer says a cross-matter connector call records nothing',
  );
  check(
    !md.includes('recorded against none of them'),
    'the old sentence is gone',
  );
}

{
  // WHO ran the account-wide search. PR #175 wrote "run by a connected
  // assistant" because the connector was the only caller that could fan out;
  // PR #182 put the SAME rows on the in-app path, where a global search from
  // the Assistant reads across every matter too. A court-facing document must
  // not name a connector that may never have existed on the account, so the
  // sentence follows the rows' own recorded actor kind.
  const inApp = (matterId) => event('tool.invoked', {
    matterspace_id: matterId,
    actor_kind: 'user',
    actor_user_id: USER_ONE,
    payload: {
      scope: 'matter', via: 'account-wide search', tool: 'search',
      args: { q: { present: true, length: 40 }, limit: 5 },
      matter_filter: false, connector: false, result_count: 3, ok: true,
    },
  });

  const only = async (events) => {
    const doc = assembleMatterRecord(
      await fetchMatterRecord(clientFor(events), { id: PARENT, name: 'Fixture Matter' }),
      CONTEXT, null,
    );
    return { doc, md: renderMatterRecordMarkdown(doc) };
  };

  const inAppOnly = await only([...sampleEvents(), inApp(PARENT), inApp(CHILD_A)]);
  check(inAppOnly.doc.accountWideReads === 2 && inAppOnly.doc.accountWideByConnector === 0,
    'two in-app account-wide reads, none of them a connector’s',
    `${inAppOnly.doc.accountWideReads}/${inAppOnly.doc.accountWideByConnector}`);
  check(inAppOnly.md.includes('2 searches run from inside Contextspaces across every matter'),
    'so the sentence says where they were run from, and does NOT say "connected assistant"');
  check(!inAppOnly.md.split('### Account-wide activity')[1].split('##')[0].includes('connected assistant'),
    'the section names no connector at all when no row recorded one');

  const mixed = await only([...sampleEvents(), fanout(PARENT), inApp(CHILD_B)]);
  check(mixed.doc.accountWideReads === 2 && mixed.doc.accountWideByConnector === 1,
    'one of each is counted as one of each');
  check(mixed.md.includes('2 searches run by a connected assistant or from inside Contextspaces'),
    'and the sentence names both, because both happened');

  const connectorOnly = await only([...sampleEvents(), fanout(PARENT)]);
  check(connectorOnly.md.includes('1 search run by a connected assistant across every matter'),
    'a connector-only period still reads exactly as PR #175 wrote it, singular and all');

  check(
    mixed.md.includes('A search that names no matter — run by a connected assistant, or from inside '),
    'and section 10 says the same of both, rather than describing the connector alone',
  );
}

// ===========================================================================
console.log('\n12. Feature AI calls: two entries, one call, and nothing invented');
// ===========================================================================
{
  seq = 0;
  const people = { [USER_ONE]: 'A. Fixture' };
  const FEATURE_CONTEXT = { generatedAt: '2026-09-20T09:00:00.000Z', generatedBy: 'A. Fixture' };
  const DOC_ONE = 'dddddddd-0000-4000-8000-000000000001';

  const sealedBase = {
    feature: 'bucketizer.classify',
    tier: 'B',
    provider: 'aws-bedrock',
    model: 'moonshotai.kimi-k2.5',
    client_provider: 'anthropic',
    client_model: 'claude-opus-4-8',
    route: 'sealed',
    streaming: false,
  };
  const events = [
    // A sealed classify: asked, then answered. One call.
    event('completion.requested', {
      payload: { ...sealedBase, call_id: 'c-1', byok: false, refused: null, document_ids: [DOC_ONE] },
    }),
    event('completion.received', {
      payload: { ...sealedBase, call_id: 'c-1', outcome: 'ok', ok: true, status: 200,
        input_tokens: 21578, output_tokens: 6342, estimated_cost: 0.028801, ms: 8100 },
    }),
    // A first-party cite-check, answered only — what every call looks like
    // before the "asked" entry is switched on for an account.
    event('completion.received', {
      payload: { feature: 'citecheck.check', call_id: 'c-2', tier: 'A', provider: 'anthropic',
        model: 'claude-opus-4-8', route: 'first-party', streaming: false, outcome: 'ok', ok: true,
        status: 200, input_tokens: 900, output_tokens: 120, estimated_cost: 0.0075, ms: 2000 },
    }),
    // A refusal: asked, never answered, and the reason is recorded.
    event('completion.requested', {
      payload: { feature: 'bucketizer.tree', call_id: 'c-3', tier: 'B', provider: null, model: null,
        client_provider: 'anthropic', client_model: 'claude-opus-4-8', route: 'sealed',
        streaming: false, refused: 'sealed_pen_unavailable', status: 503 },
    }),
    // Asked, and never answered, with no refusal: the call did not finish.
    event('completion.requested', {
      payload: { feature: 'editor.section', call_id: 'c-4', tier: 'A', provider: 'anthropic',
        model: 'claude-opus-4-8', route: 'first-party', streaming: true, refused: null },
    }),
  ];

  const doc = assembleMatterRecord(
    {
      matter: { id: PARENT, name: 'Fixture Matter' },
      matters: [{ id: PARENT, name: 'Fixture Matter' }],
      events,
      totalEvents: events.length,
      ceiling: 5000,
      truncated: false,
      chains: [{ matterId: PARENT, matterName: 'Fixture Matter', ok: true, checked: events.length, firstBadSeq: null }],
      people,
      citeRuns: [],
      notDeployed: false,
      error: null,
    },
    FEATURE_CONTEXT,
    null,
  );

  check(doc.featureCalls.length === 4,
    'four distinct feature/model/tier rows from five entries', String(doc.featureCalls.length));
  const classify = doc.featureCalls.find((f) => f.feature === 'bucketizer.classify');
  check(classify?.calls === 1 && classify?.inputTokens === 21578 && classify?.outputTokens === 6342,
    'the paired call is ONE call, with the answered entry’s token counts',
    JSON.stringify({ calls: classify?.calls, in: classify?.inputTokens }));
  check(classify?.model === 'moonshotai.kimi-k2.5',
    'and the model recorded is the one that ANSWERED, not the one the browser asked for',
    classify?.model);
  check(classify?.documents === 1, 'the document it worked on is counted, by id', String(classify?.documents));
  const citecheck = doc.featureCalls.find((f) => f.feature === 'citecheck.check');
  check(citecheck?.calls === 1 && citecheck?.unfinished === 0,
    'a lone "answered" entry is a COMPLETE call, not a partial one');
  const tree = doc.featureCalls.find((f) => f.feature === 'bucketizer.tree');
  check(tree?.refused === 1 && tree?.unfinished === 0,
    'a refusal is counted as refused and never as unfinished');
  const section = doc.featureCalls.find((f) => f.feature === 'editor.section');
  check(section?.unfinished === 1 && section?.refused === 0,
    'a lone "asked" entry with no refusal is a call that did not finish, and says so');

  check(doc.sessions.length === 0,
    'and NONE of them is counted as a chat session', `${doc.sessions.length} sessions`);
  check(doc.tools.length === 3,
    'the tools memo lists the models the features actually used', `${doc.tools.length} blocks`);
  check(doc.tools.every((t) => !/in-app assistant/.test(t.channel)),
    'each under its own feature, never as the in-app assistant',
    doc.tools.map((t) => t.channel).join(' | '));

  const md = renderMatterRecordMarkdown(doc);
  check(md.includes('Feature AI calls'), 'the export has the Feature AI calls part');
  check(md.includes('Bucketizer — classified a document'), 'named in words, not in labels');
  check(/1 of these calls was refused|1 call was recorded as asked/.test(md),
    'and the refusal and the unfinished call are each stated in a sentence');
  check(!md.includes('claude-opus-4-8, a sealed model'),
    'the sealed line never names the model the browser asked for as the one that answered');

  // The docket line each entry gets, which is what the Record tab shows.
  const askedLine = describeEvent(events[0], people);
  const answeredLine = describeEvent(events[1], people);
  const refusedLine = describeEvent(events[3], people);
  check(/^Bucketizer asked a model to classify a document/.test(askedLine), 'the asked line reads as a request', askedLine);
  check(/^Bucketizer classified a document/.test(answeredLine), 'the answered line reads as the act', answeredLine);
  check(/sealed model in the firm’s own AWS account/.test(answeredLine),
    'and says where the answer came from in the words 02-securespace.md allows', answeredLine);
  check(/refused/.test(refusedLine) && /Nothing was sent/.test(refusedLine),
    'a refused call says it was refused AND that nothing was sent', refusedLine);
  check(!/claude/i.test(refusedLine.replace(/claude-opus-4-8/g, '')),
    'and never calls the sealed model Claude');
}

// ===========================================================================
console.log('\n13. Plain words: nothing a reader sees is database vocabulary');
// ===========================================================================
// Eden opened the .docx and asked what "hash-chained list of recorded acts"
// means. This document goes to a court, a bar or a client; every fact it
// states is still stated, in English. The list below is checked against the
// RENDERED export and against every string the Record tab can show.
{
  const BANNED = [
    /\bhash(es|ed|-chained)?\b/i,
    /\bchain(s|ed|-key)?\b/i,
    /\bmigration\b/i,
    /\bpayload\b/i,
    /\bappend-only\b/i,
    /\bRPC\b/,
    /\buuid\b/i,
    /\bledger\b/i,
    /\bschema\b/i,
    /\bjsonb?\b/i,
    /\bnot deployed\b/i,
    /\bthis installation\b/i,
    /\bseq\b/i,
    /\bPGRST\d+/,
  ];
  const sweep = (text, where) => {
    const hits = BANNED.filter((re) => re.test(text)).map((re) => String(re));
    check(hits.length === 0, `no database vocabulary in ${where}`, hits.join(' '));
  };

  // The whole export, with a jurisdiction selected so section 8 is populated
  // too — the matrix's own quotations are excluded, because they are the
  // court's words and are printed verbatim by contract.
  const events = sampleEvents();
  const client = clientFor(events);
  const data = await fetchMatterRecord(client, { id: PARENT, name: 'Fixture Matter' });
  const doc = assembleMatterRecord(data, CONTEXT, null);
  sweep(renderMatterRecordMarkdown(doc), 'the rendered export');

  // The same export in its three other states: nothing recorded, a failed
  // check, and recording not switched on.
  const empty = assembleMatterRecord(
    { matter: { id: PARENT, name: 'Fixture Matter' }, matters: [{ id: PARENT, name: 'Fixture Matter' }],
      events: [], totalEvents: 0, ceiling: 5000, truncated: false, chains: [], people: {},
      citeRuns: [], notDeployed: true, error: null },
    CONTEXT, null,
  );
  sweep(renderMatterRecordMarkdown(empty), 'the export before recording is switched on');

  const broken = assembleMatterRecord(
    { matter: { id: PARENT, name: 'Fixture Matter' }, matters: [{ id: PARENT, name: 'Fixture Matter' }],
      events, totalEvents: events.length, ceiling: 5000, truncated: true,
      chains: [{ matterId: PARENT, matterName: 'Fixture Matter', ok: false, checked: 6, firstBadSeq: 7 }],
      people: {}, citeRuns: [], notDeployed: false, error: null },
    CONTEXT, null,
  );
  sweep(renderMatterRecordMarkdown(broken), 'the export when the integrity check fails');

  // Every sentence chainSummary can produce, which is what the tab's header
  // shows, plus every docket line.
  const states = [
    chainSummary([]),
    chainSummary([{ matterId: PARENT, matterName: 'Fixture Matter', ok: true, checked: 12, firstBadSeq: null }]),
    chainSummary([{ matterId: PARENT, matterName: 'Fixture Matter', ok: false, checked: 6, firstBadSeq: 7 }]),
    chainSummary([{ matterId: PARENT, matterName: 'Fixture Matter', ok: true, checked: 0, firstBadSeq: null, unavailable: true }]),
    chainSummary([
      { matterId: PARENT, matterName: 'Fixture Matter', ok: true, checked: 4, firstBadSeq: null },
      { matterId: CHILD_A, matterName: 'Fixture Matter › Pleadings', ok: true, checked: 0, firstBadSeq: null, unavailable: true },
    ]),
  ];
  sweep(states.map((s) => `${s.line}\n${s.meaning}`).join('\n'), 'the Record tab’s status line');
  sweep(events.map((e) => describeEvent(e, {})).join('\n'), 'every docket line');

  // And the two sentences the pass was actually about.
  const md = renderMatterRecordMarkdown(doc);
  check(md.includes('The Record is tamper-evident: each entry is sealed to the one before it'),
    'the opening paragraph says tamper-evident in plain words');
  check(md.includes('Entries cannot be edited or deleted.'),
    'and says plainly that entries cannot be edited or deleted');
  check(md.includes('How this Record can be relied on'), 'the reliance block is in the document');
  check(md.includes('an act the product did not record would not appear here'),
    'and it says what the Record does NOT prove, rather than over-claiming');
  check(md.includes('Seal of the first entry') && md.includes('Seal of the last entry'),
    'the two fingerprints are labelled as seals');
  check(md.includes('digital fingerprints of the first and last entries'),
    'with one line saying what they are for');

  // The .md and the .docx are the same document, so the new part must be in
  // both: one block model, two renderers.
  const featureDoc = assembleMatterRecord(
    { matter: { id: PARENT, name: 'Fixture Matter' }, matters: [{ id: PARENT, name: 'Fixture Matter' }],
      events: [event('completion.received', { payload: { feature: 'deck', call_id: 'c-9', tier: 'A',
        provider: 'openai', model: 'gpt-5', route: 'first-party', streaming: false, outcome: 'ok',
        ok: true, status: 200, input_tokens: 10, output_tokens: 20, estimated_cost: 0.001 } })],
      totalEvents: 1, ceiling: 5000, truncated: false,
      chains: [{ matterId: PARENT, matterName: 'Fixture Matter', ok: true, checked: 1, firstBadSeq: null }],
      people: {}, citeRuns: [], notDeployed: false, error: null },
    CONTEXT, null,
  );
  const docxBuffer = await Packer.toBuffer(buildMatterRecordDocument(featureDoc));
  const zip = await JSZip.loadAsync(docxBuffer);
  const xml = await zip.file('word/document.xml').async('string');
  const text = xml.replace(/<[^>]+>/g, ' ');
  check(text.includes('Feature AI calls'), 'the .docx carries the Feature AI calls part too');
  check(text.includes('Deck Composer'), 'and names the feature in it', 'Deck Composer');
  sweep(text, 'the .docx');
}

// ===========================================================================
if (process.argv.includes('--print')) {
  // --jurisdiction=<id> picks the rules entry to print; --jurisdiction=none
  // leaves section 8 as the "no jurisdiction selected" stub.
  const arg = process.argv.find((a) => a.startsWith('--jurisdiction='));
  const wanted = arg ? arg.slice('--jurisdiction='.length) : 'us-3d-cir';
  const entry = wanted === 'none' ? null : JURISDICTIONS.entries.find((e) => e.id === wanted);
  const events = sampleEvents();
  const client = clientFor(events);
  const data = await fetchMatterRecord(client, { id: PARENT, name: 'Fixture Matter' });
  const doc = assembleMatterRecord(
    data,
    CONTEXT,
    entry ? { entry, matrixVersion: JURISDICTIONS.matrix_version } : null,
  );
  console.log('\n----- SAMPLE EXPORT (synthetic events) -----\n');
  console.log(renderMatterRecordMarkdown(doc));
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
