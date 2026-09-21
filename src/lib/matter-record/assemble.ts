// Assembling the Matter Record.
//
// Events in, a document model out — deterministically. Nothing in this file
// reads the clock, the locale or the network: the same events plus the same
// ExportContext always assemble to the same bytes, which is what makes the
// export something a lawyer can hand over twice and be believed.
//
// The shape follows the AI Use Record the attorney already keeps by hand
// (the `ai-use-record` skill): a tools memo, a session index, then the
// mechanical sections the ledger can fill. Every cell the skill reserves for
// the attorney's judgment — purpose, what confidential material went in, what
// was relied on, the disclosure decision, initials — is left empty here. The
// assistant fills the mechanical cells; the attorney fills the judgment cells.

import {
  actorName,
  isoDay,
  isoMinute,
  describeEvent,
  featureOwner,
  featurePhrase,
  isAccountWideRead,
  isFeatureCall,
  kindLabel,
  providerLabel,
  retentionPosture,
  routePhrase,
  tierLabel,
  chainSummary,
  type People,
} from './describe';
import type {
  ChainStatus,
  ExportContext,
  JurisdictionEntry,
  LedgerEvent,
  MatterRecordData,
  MatterRef,
} from './types';

/** What a cell the attorney must fill looks like, everywhere. */
export const ATTORNEY_CELL = '[ ]';

export const DRAFT_LEGEND =
  'DRAFT — prepared mechanically from the matter’s record; not reviewed by counsel.';

export interface ToolRow {
  /** The heading this block gets: the model and where it ran, or the client. */
  title: string;
  channel: string;
  model: string;
  provider: string;
  tier: string;
  route: string;
  retention: string;
  firstUse: string;
  lastUse: string;
  uses: number;
}

export interface SessionRow {
  sessionId: string;
  matterName: string;
  firstDay: string;
  lastDay: string;
  actor: string;
  models: string;
  provider: string;
  tier: string;
  route: string;
  exchanges: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  costRecorded: boolean;
  toolsUsed: string;
  withinPolicy: string;
  escalations: string;
  errors: number;
}

/**
 * One model, used by one feature, on one tier — with every call it made
 * summed. A Bucketizer run is four hundred calls, and four hundred rows in a
 * document a court reads is not an account of anything; one row that says
 * "Bucketizer classified documents four hundred times on this model, between
 * these two dates, at this cost" is.
 */
export interface FeatureCallRow {
  feature: string;
  /** "Bucketizer — classified a document" */
  title: string;
  model: string;
  provider: string;
  tier: string;
  route: string;
  retention: string;
  calls: number;
  refused: number;
  refusedReasons: string;
  failed: number;
  unfinished: number;
  streamed: number;
  inputTokens: number;
  outputTokens: number;
  tokensReportedFor: number;
  cost: number;
  costRecorded: boolean;
  documents: number;
  firstUse: string;
  lastUse: string;
}

export interface ConnectorRow {
  client: string;
  tool: string;
  calls: number;
  refusedSealed: number;
  failed: number;
  firstUse: string;
  lastUse: string;
}

export interface LineRow {
  when: string;
  what: string;
  who: string;
  matter: string;
  kind: string;
}

export interface CiteRunRow {
  runId: string;
  brief: string;
  status: string;
  citations: number;
  when: string;
  matter: string;
  requestedBy: string;
}

export interface IntegrityBlock {
  chains: ChainStatus[];
  headline: string;
  meaning: string;
  ok: boolean;
  entriesShown: number;
  entriesTotal: number | null;
  truncated: boolean;
  ceiling: number;
  firstHash: string | null;
  lastHash: string | null;
  firstEntryAt: string | null;
  lastEntryAt: string | null;
  generatedAt: string;
  generatedBy: string;
}

export interface MatterRecordDoc {
  title: string;
  matter: MatterRef;
  subMatters: MatterRef[];
  fromDay: string | null;
  toDay: string | null;
  generatedAt: string;
  generatedBy: string;
  notDeployed: boolean;
  error: string | null;
  tools: ToolRow[];
  sessions: SessionRow[];
  /** One row per feature × model × tier, with every call it made summed. */
  featureCalls: FeatureCallRow[];
  connectors: ConnectorRow[];
  inAppToolCalls: number;
  agentToolCalls: number;
  /**
   * How many account-wide searches read from THIS matter or one of its
   * sub-matters, counted from this matter's own rows (migration 072). It says
   * nothing about any other matter, because nothing it is counted from does.
   */
  accountWideReads: number;
  /**
   * How many of those were made by a CONNECTED ASSISTANT, from the row's own
   * recorded actor kind. The fan-out in 072 is not the connector's alone — the
   * in-app assistant's own global search takes the same path — so the export
   * has to say which, and cannot call them all connectors.
   */
  accountWideByConnector: number;
  access: LineRow[];
  exports: LineRow[];
  citeRuns: CiteRunRow[];
  chronology: LineRow[];
  integrity: IntegrityBlock;
  jurisdiction: { entry: JurisdictionEntry; matrixVersion: string } | null;
  matrixVersion: string | null;
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter((v): v is string => !!v);
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Events, in the one order the whole document uses. */
export function chronological(events: LedgerEvent[]): LedgerEvent[] {
  return [...events].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    if (a.chain_key !== b.chain_key) return a.chain_key < b.chain_key ? -1 : 1;
    return a.seq - b.seq;
  });
}

function channelFor(event: LedgerEvent): string {
  // A feature's own model call is not the in-app assistant, and a tools memo
  // that called it one would be wrong about the most common kind of AI use on
  // a matter. The feature is named first, because that is what counsel has to
  // reason about when they say what may go into it.
  if (isFeatureCall(event)) {
    return `Contextspaces feature — ${featureOwner(event.payload?.feature)}`;
  }
  switch (event.actor_kind) {
    case 'charter':
      return 'Contextspaces agent charter';
    case 'connector':
      return 'Connected assistant (MCP)';
    case 'system':
      return 'Contextspaces worker';
    default:
      return 'Contextspaces in-app assistant';
  }
}

// ---------------------------------------------------------------------------
// 1. Tools memo — every model and every connected client that touched it
// ---------------------------------------------------------------------------

/**
 * The tools memo.
 *
 * Feature model calls do NOT come from the raw entries here: one call leaves
 * up to two of them, so counting entries would double every feature's use
 * count, and counting only the answered ones would lose a call that was made
 * and never came back. They come from the paired rows instead, which is the
 * one place a call is a call.
 */
function buildTools(events: LedgerEvent[], asOfDay: string, featureCalls: FeatureCallRow[]): ToolRow[] {
  const byKey = new Map<string, ToolRow>();

  const touch = (key: string, make: () => ToolRow, ts: string) => {
    const existing = byKey.get(key);
    if (!existing) {
      const row = make();
      row.firstUse = isoDay(ts);
      row.lastUse = isoDay(ts);
      row.uses = 1;
      byKey.set(key, row);
      return;
    }
    existing.uses += 1;
    const day = isoDay(ts);
    if (day < existing.firstUse) existing.firstUse = day;
    if (day > existing.lastUse) existing.lastUse = day;
  };

  for (const event of events) {
    if (event.kind === 'completion.received') {
      if (isFeatureCall(event)) continue;   // counted from featureCalls below
      const model = str(event.payload?.model) ?? 'not recorded';
      const provider = str(event.payload?.provider) ?? '';
      const tier = str(event.payload?.tier) ?? '';
      const channel = channelFor(event);
      // "a|" and "b|" keep the models above the connected clients; the rest of
      // the key is what makes two rows different.
      touch(
        `a|${channel}|${provider}|${model}|${tier}`,
        () => ({
          title: `${model} (${providerLabel(provider)})`,
          channel,
          model,
          provider: providerLabel(provider),
          tier: tierLabel(tier),
          route: routePhrase(tier, provider),
          retention: retentionPosture(tier, provider, asOfDay),
          firstUse: '',
          lastUse: '',
          uses: 0,
        }),
        event.ts,
      );
      continue;
    }
    if (event.kind === 'tool.invoked' && event.actor_kind === 'connector') {
      const client = str(event.actor_label) ?? str(event.actor_ref) ?? 'a connected assistant';
      touch(
        `b|${client}`,
        () => ({
          title: `${client} — a connected assistant`,
          channel: 'Connected assistant (MCP)',
          model: 'not reported by the client',
          provider: 'not reported by the client',
          tier: 'n.a.',
          route: 'read this matter through the Contextspaces connector',
          retention:
            'The connected assistant runs outside Contextspaces; what its own provider does ' +
            'with what it read is governed by that provider’s terms, not by this record. ' +
            '[Confirm which assistant, on what account, and on what terms.]',
          firstUse: '',
          lastUse: '',
          uses: 0,
        }),
        event.ts,
      );
    }
  }

  // A feature's model, once per feature and tier, with the calls that
  // actually reached a model. A refused call reached none, so it is not a use
  // of the model — it is recorded, in full, in the Feature AI calls part.
  for (const call of featureCalls) {
    const reached = call.calls - call.refused;
    if (reached <= 0 || call.model === 'not recorded') continue;
    byKey.set(`a|${call.title}|${call.model}|${call.tier}`, {
      title: `${call.model} (${call.provider}) — ${call.title}`,
      channel: `Contextspaces feature — ${call.title.split(' — ')[0]}`,
      model: call.model,
      provider: call.provider,
      tier: call.tier,
      route: call.route,
      retention: call.retention,
      firstUse: call.firstUse,
      lastUse: call.lastUse,
      uses: reached,
    });
  }

  return [...byKey.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, row]) => row);
}

// ---------------------------------------------------------------------------
// 2. Session index — one row per AI session
// ---------------------------------------------------------------------------

interface SessionAcc {
  key: string;
  sessionId: string;
  matterName: string;
  firstTs: string;
  lastTs: string;
  actors: Set<string>;
  models: Set<string>;
  providers: Set<string>;
  tiers: Set<string>;
  tools: Set<string>;
  exchanges: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  costRecorded: boolean;
  withinPolicy: Set<string>;
  escalations: Set<string>;
  errors: number;
}

function buildSessions(events: LedgerEvent[], people: People): SessionRow[] {
  const acc = new Map<string, SessionAcc>();

  for (const event of events) {
    if (event.kind !== 'completion.received' && event.kind !== 'tool.invoked') continue;
    // A feature's model call belongs to no chat session — it has no session id
    // and no turn before it. Counting one as a session would invent a session
    // that never happened AND count its exchange twice, since the same call
    // also has an "asked" row. They get their own part, below.
    if (isFeatureCall(event)) continue;
    const sessionId = str(event.session_id);
    // A tool call outside any session belongs to the connector section, not
    // to the session index: there is no session to index it under.
    if (!sessionId && event.kind === 'tool.invoked') continue;
    const key = sessionId ?? `no-session:${event.id}`;
    let row = acc.get(key);
    if (!row) {
      row = {
        key,
        sessionId: sessionId ?? 'not recorded',
        matterName: str(event.matter_name) ?? 'this matter',
        firstTs: event.ts,
        lastTs: event.ts,
        actors: new Set<string>(),
        models: new Set<string>(),
        providers: new Set<string>(),
        tiers: new Set<string>(),
        tools: new Set<string>(),
        exchanges: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        costRecorded: false,
        withinPolicy: new Set<string>(),
        escalations: new Set<string>(),
        errors: 0,
      };
      acc.set(key, row);
    }
    if (event.ts < row.firstTs) row.firstTs = event.ts;
    if (event.ts > row.lastTs) row.lastTs = event.ts;
    row.actors.add(actorName(event, people));

    if (event.kind === 'tool.invoked') {
      const tool = str(event.payload?.tool);
      if (tool) row.tools.add(tool);
      continue;
    }

    row.exchanges += 1;
    row.models.add(str(event.payload?.model) ?? 'not recorded');
    row.providers.add(str(event.payload?.provider) ?? '');
    row.tiers.add(str(event.payload?.tier) ?? '');
    row.inputTokens += num(event.payload?.input_tokens) ?? 0;
    row.outputTokens += num(event.payload?.output_tokens) ?? 0;
    const cost = num(event.payload?.estimated_cost);
    if (cost !== null) {
      row.cost += cost;
      row.costRecorded = true;
    }
    for (const tool of stringList(event.payload?.tools_used)) row.tools.add(tool);
    const within = event.payload?.within_policy;
    row.withinPolicy.add(
      within === true ? 'yes' : within === false ? 'no' : 'not recorded',
    );
    const escalation = event.payload?.escalation;
    if (escalation === true) row.escalations.add('yes');
    else if (typeof escalation === 'string' && escalation.trim()) {
      row.escalations.add(escalation.trim());
    }
    if (str(event.payload?.error)) row.errors += 1;
  }

  return [...acc.values()]
    .sort((a, b) =>
      a.firstTs !== b.firstTs ? (a.firstTs < b.firstTs ? -1 : 1) : a.key < b.key ? -1 : 1,
    )
    .map((row) => {
      const providers = [...row.providers].filter(Boolean).sort();
      const tiers = [...row.tiers].filter(Boolean).sort();
      const provider = providers.length === 1 ? providers[0] : '';
      const tier = tiers.length === 1 ? tiers[0] : '';
      const within = [...row.withinPolicy].sort();
      return {
        sessionId: row.sessionId,
        matterName: row.matterName,
        firstDay: isoDay(row.firstTs),
        lastDay: isoDay(row.lastTs),
        actor: [...row.actors].sort().join('; ') || 'A member',
        models: sortedUnique(row.models).join('; '),
        provider:
          providers.length === 0
            ? 'not recorded'
            : providers.map((p) => providerLabel(p)).join('; '),
        tier: tiers.length === 0 ? 'not recorded' : tiers.map((t) => tierLabel(t)).join('; '),
        route:
          providers.length === 1 && tiers.length <= 1
            ? routePhrase(tier, provider)
            : 'more than one route in this session — see the chronology',
        exchanges: row.exchanges,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cost: row.cost,
        costRecorded: row.costRecorded,
        toolsUsed: sortedUnique(row.tools).join(', ') || 'none recorded',
        withinPolicy: within.length === 1 ? within[0] : within.join('/'),
        escalations: [...row.escalations].sort().join('; ') || 'none',
        errors: row.errors,
      };
    });
}

// ---------------------------------------------------------------------------
// 2b. Feature AI calls — every model call the product made on this matter
// ---------------------------------------------------------------------------
// One call leaves up to two entries: "asked" before the model was contacted,
// and "answered" afterwards. They carry the same call id, so one call is one
// line here even though it is two entries in the chronology.
//
// Three shapes, and each is reported as what it is:
//
//   asked + answered   an ordinary call.
//   answered alone     also an ordinary call. It is what every call looks like
//                      until the second kind of entry is switched on for this
//                      account, and a reader must not be told a complete call
//                      was somehow partial.
//   asked alone        either a REFUSAL (the entry says so, and nothing was
//                      sent) or a call that never came back. The second is
//                      counted separately and named, never quietly dropped.

interface FeatureAcc {
  key: string;
  feature: string;
  model: string;
  provider: unknown;
  tier: unknown;
  firstTs: string;
  lastTs: string;
  calls: number;
  refused: number;
  refusedReasons: Set<string>;
  failed: number;
  unfinished: number;
  streamed: number;
  inputTokens: number;
  outputTokens: number;
  tokensReportedFor: number;
  cost: number;
  costRecorded: boolean;
  documents: Set<string>;
}

/** The two entries of one call, or whichever of them exists. */
interface CallPair {
  asked: LedgerEvent | null;
  answered: LedgerEvent | null;
}

function pairFeatureCalls(events: LedgerEvent[]): CallPair[] {
  const byCall = new Map<string, CallPair>();
  const order: string[] = [];
  for (const event of events) {
    if (!isFeatureCall(event)) continue;
    // An entry with no call id cannot be paired with anything, so it is its
    // own call rather than being merged with an unrelated one.
    const id = str(event.payload?.call_id) ?? `solo:${event.id}`;
    let pair = byCall.get(id);
    if (!pair) {
      pair = { asked: null, answered: null };
      byCall.set(id, pair);
      order.push(id);
    }
    if (event.kind === 'completion.requested') pair.asked = pair.asked ?? event;
    else pair.answered = pair.answered ?? event;
  }
  return order.map((id) => byCall.get(id)!);
}

function buildFeatureCalls(events: LedgerEvent[], asOfDay: string): FeatureCallRow[] {
  const acc = new Map<string, FeatureAcc>();

  for (const pair of pairFeatureCalls(events)) {
    // The answered entry is the authority on the model and the counts; the
    // asked entry is the authority on a refusal. Either may be missing.
    const primary = pair.answered ?? pair.asked;
    if (!primary) continue;
    const feature = str(primary.payload?.feature) ?? 'unspecified';
    const model = str(primary.payload?.model) ?? 'not recorded';
    const provider = primary.payload?.provider ?? null;
    const tier = primary.payload?.tier ?? null;
    const key = `${feature}\u0000${model}\u0000${String(provider)}\u0000${String(tier)}`;
    const ts = pair.asked?.ts ?? primary.ts;

    let row = acc.get(key);
    if (!row) {
      row = {
        key,
        feature,
        model,
        provider,
        tier,
        firstTs: ts,
        lastTs: ts,
        calls: 0,
        refused: 0,
        refusedReasons: new Set<string>(),
        failed: 0,
        unfinished: 0,
        streamed: 0,
        inputTokens: 0,
        outputTokens: 0,
        tokensReportedFor: 0,
        cost: 0,
        costRecorded: false,
        documents: new Set<string>(),
      };
      acc.set(key, row);
    }
    if (ts < row.firstTs) row.firstTs = ts;
    const lastTs = pair.answered?.ts ?? ts;
    if (lastTs > row.lastTs) row.lastTs = lastTs;
    row.calls += 1;

    const refused = str(pair.asked?.payload?.refused);
    if (refused) {
      row.refused += 1;
      row.refusedReasons.add(refused);
    } else if (!pair.answered) {
      row.unfinished += 1;
    }

    for (const id of stringList(pair.asked?.payload?.document_ids)) row.documents.add(id);

    if (pair.answered) {
      const outcome = str(pair.answered.payload?.outcome);
      if (outcome && outcome !== 'ok') row.failed += 1;
      if (pair.answered.payload?.streaming === true) row.streamed += 1;
      const input = num(pair.answered.payload?.input_tokens);
      const output = num(pair.answered.payload?.output_tokens);
      if (input !== null || output !== null) {
        row.inputTokens += input ?? 0;
        row.outputTokens += output ?? 0;
        row.tokensReportedFor += 1;
      }
      const cost = num(pair.answered.payload?.estimated_cost);
      if (cost !== null) {
        row.cost += cost;
        row.costRecorded = true;
      }
    }
  }

  return [...acc.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((row) => ({
      feature: row.feature,
      title: `${featureOwner(row.feature)} — ${featurePhrase(row.feature)}`,
      model: row.model,
      provider: providerLabel(row.provider),
      tier: tierLabel(row.tier),
      route: routePhrase(row.tier, row.provider),
      retention: retentionPosture(row.tier, row.provider, asOfDay),
      calls: row.calls,
      refused: row.refused,
      refusedReasons: [...row.refusedReasons].sort().join(', ') || 'none',
      failed: row.failed,
      unfinished: row.unfinished,
      streamed: row.streamed,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      tokensReportedFor: row.tokensReportedFor,
      cost: row.cost,
      costRecorded: row.costRecorded,
      documents: row.documents.size,
      firstUse: isoDay(row.firstTs),
      lastUse: isoDay(row.lastTs),
    }));
}

// ---------------------------------------------------------------------------
// 3. Connector activity
// ---------------------------------------------------------------------------

function buildConnectors(events: LedgerEvent[]): {
  rows: ConnectorRow[];
  inApp: number;
  agent: number;
} {
  const byKey = new Map<string, ConnectorRow>();
  let inApp = 0;
  let agent = 0;

  for (const event of events) {
    if (event.kind !== 'tool.invoked') continue;
    if (event.actor_kind === 'charter') agent += 1;
    if (event.actor_kind === 'user' || event.actor_kind === 'system') inApp += 1;
    if (event.actor_kind !== 'connector') continue;

    const client = str(event.actor_label) ?? str(event.actor_ref) ?? 'a connected assistant';
    const tool = str(event.payload?.tool) ?? 'not recorded';
    const key = `${client}\u0000${tool}`;
    const day = isoDay(event.ts);
    let row = byKey.get(key);
    if (!row) {
      row = {
        client,
        tool,
        calls: 0,
        refusedSealed: 0,
        failed: 0,
        firstUse: day,
        lastUse: day,
      };
      byKey.set(key, row);
    }
    row.calls += 1;
    if (str(event.payload?.refused) === 'sealed') row.refusedSealed += 1;
    if (event.payload?.ok === false) row.failed += 1;
    if (day < row.firstUse) row.firstUse = day;
    if (day > row.lastUse) row.lastUse = day;
  }

  const rows = [...byKey.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, row]) => row);
  return { rows, inApp, agent };
}

// ---------------------------------------------------------------------------
// 4-6. Access and seal · exports and deliveries · the chronology
// ---------------------------------------------------------------------------

const ACCESS_KINDS = new Set(['acl.changed', 'seal.changed']);
const EXPORT_KINDS = new Set(['file.exported', 'file.sent', 'file.delivered', 'file.gate']);

function toLine(event: LedgerEvent, people: People): LineRow {
  return {
    when: isoMinute(event.ts),
    what: describeEvent(event, people),
    who: actorName(event, people),
    matter: str(event.matter_name) ?? 'this matter',
    kind: kindLabel(event.kind),
  };
}

// ---------------------------------------------------------------------------
// The whole document
// ---------------------------------------------------------------------------

export function assembleMatterRecord(
  data: MatterRecordData,
  context: ExportContext,
  jurisdiction?: { entry: JurisdictionEntry; matrixVersion: string } | null,
): MatterRecordDoc {
  const events = chronological(data.events);
  const people = data.people ?? {};
  const asOfDay = isoDay(context.generatedAt);

  const connectors = buildConnectors(events);
  const featureCalls = buildFeatureCalls(events, asOfDay);
  const summary = chainSummary(data.chains);

  const citeRuns: CiteRunRow[] = [...data.citeRuns]
    .sort((a, b) => {
      const at = a.created_at ?? '';
      const bt = b.created_at ?? '';
      if (at !== bt) return at < bt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    })
    .map((run) => ({
      runId: run.id,
      brief: run.source_label,
      status: run.status,
      citations: run.citations_total ?? 0,
      when: run.created_at ? isoDay(run.created_at) : 'not recorded',
      matter:
        data.matters.find((m) => m.id === run.matterspace_id)?.name ?? 'this matter',
      requestedBy: run.created_by ? people[run.created_by] ?? 'A member' : 'not recorded',
    }));

  const first = events[0] ?? null;
  const last = events[events.length - 1] ?? null;

  return {
    title: `Matter Record — ${data.matter.name}`,
    matter: data.matter,
    subMatters: data.matters.slice(1),
    fromDay: first ? isoDay(first.ts) : null,
    toDay: last ? isoDay(last.ts) : null,
    generatedAt: context.generatedAt,
    generatedBy: context.generatedBy,
    notDeployed: data.notDeployed,
    error: data.error,
    tools: buildTools(events, asOfDay, featureCalls),
    sessions: buildSessions(events, people),
    featureCalls,
    connectors: connectors.rows,
    inAppToolCalls: connectors.inApp,
    agentToolCalls: connectors.agent,
    // Counted from the rows already read for this matter and its descendants,
    // over the period those rows cover. Never from another matter's chain,
    // and never from the account chain — see docs/THE_MATTER_RECORD.md.
    accountWideReads: events.filter((e) => isAccountWideRead(e)).length,
    accountWideByConnector: events.filter(
      (e) => isAccountWideRead(e) && e.actor_kind === 'connector',
    ).length,
    access: events.filter((e) => ACCESS_KINDS.has(e.kind)).map((e) => toLine(e, people)),
    exports: events.filter((e) => EXPORT_KINDS.has(e.kind)).map((e) => toLine(e, people)),
    citeRuns,
    chronology: events.map((e) => toLine(e, people)),
    integrity: {
      chains: data.chains,
      headline: summary.line,
      meaning: summary.meaning,
      ok: summary.ok,
      entriesShown: events.length,
      entriesTotal: data.totalEvents,
      truncated: data.truncated,
      ceiling: data.ceiling,
      firstHash: first ? first.hash : null,
      lastHash: last ? last.hash : null,
      firstEntryAt: first ? isoMinute(first.ts) : null,
      lastEntryAt: last ? isoMinute(last.ts) : null,
      generatedAt: isoMinute(context.generatedAt),
      generatedBy: context.generatedBy,
    },
    jurisdiction: jurisdiction ?? null,
    matrixVersion: jurisdiction?.matrixVersion ?? null,
  };
}
