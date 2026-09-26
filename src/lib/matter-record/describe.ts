// Turning one ledger row into one line a lawyer can read.
//
// Two rules govern every string in this file:
//
//   1. Nothing is invented. Model ids, provider ids, tool names and tiers are
//      printed as the payload recorded them. The only prose this file adds is
//      the sentence that says what kind of act the row was.
//   2. Nothing claims more than `audits/2026-09-19/02-securespace.md` allows.
//      The sealed route is "a model served from Amazon Bedrock in the firm's
//      own AWS account under an account-level setting that forbids retention";
//      it is not any vendor's promise, it is not called Claude, and the seal
//      is prospective. Tier A is "first-party provider terms", with the
//      retention period left for the attorney to confirm — the AI Use Record
//      skill's rule: never assert a provider's terms as fact.
//
// An unknown event kind renders a generic line rather than throwing: the
// vocabulary in migration 064 already has kinds nothing writes yet, and a
// Record that crashes on a row it does not recognise is worse than one that
// says less about it.
//
//   3. Plain words, always. Everything in this file is read by a lawyer, a
//      court, a bar or a client — never by an engineer. No "hash", no "chain",
//      no "payload", no "migration", no "not deployed" reaches a reader. The
//      underlying facts are all still stated; they are stated in English.
//      scripts/_verify-matter-record.mjs holds the word list and fails the
//      build if one of them comes back.

import type { LedgerEvent } from './types';

export type People = Record<string, string>;

/** ISO day, in UTC, with no locale anywhere: renders identically everywhere. */
export function isoDay(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts).slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** ISO minute, in UTC. */
export function isoMinute(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

/**
 * Migration 072 writes one row in every matter a matter-less `search` read
 * from, marked `scope: 'matter'` and `via: 'account-wide search'`. Those two
 * keys are a READ CONTRACT (docs/THE_MATTER_RECORD.md), not a payload
 * convention, which is why they are named once, here.
 */
export const FANOUT_SCOPE = 'matter';
export const FANOUT_VIA = 'account-wide search';

/** True for a row saying "an account-wide search read from THIS matter". */
export function isAccountWideRead(event: LedgerEvent): boolean {
  return (
    event.kind === 'tool.invoked' &&
    str(event.payload?.scope) === FANOUT_SCOPE &&
    str(event.payload?.via) === FANOUT_VIA
  );
}

// ---------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------

/** The actor, named the way the Record should name them. */
export function actorName(event: LedgerEvent, people: People = {}): string {
  const label = str(event.actor_label);
  switch (event.actor_kind) {
    case 'user': {
      const named = event.actor_user_id ? people[event.actor_user_id] : null;
      return named || label || 'A member';
    }
    case 'charter':
      return label ? `the ${label} agent` : 'an agent';
    case 'connector':
      return label ? `${label} (connector)` : 'a connected assistant';
    case 'system':
      return label || str(event.actor_ref) || 'the system';
    default:
      return label || 'A member';
  }
}

/** The same, capitalised for the start of a sentence. */
export function actorSentence(event: LedgerEvent, people: People = {}): string {
  const name = actorName(event, people);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function personName(userId: unknown, people: People = {}): string {
  const id = str(userId);
  if (!id) return 'Someone';
  return people[id] || 'A member';
}

// ---------------------------------------------------------------------------
// Routes and retention — the careful words
// ---------------------------------------------------------------------------

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  fireworks: 'Fireworks',
  'aws-bedrock': 'Amazon Bedrock',
};

export function providerLabel(provider: unknown): string {
  const id = str(provider);
  if (!id) return 'provider not recorded';
  return PROVIDER_LABELS[id] ?? id;
}

export function tierLabel(tier: unknown): string {
  switch (str(tier)) {
    case 'A':
      return 'A (unsealed)';
    case 'B':
      return 'B (sealed)';
    case 'C':
      return 'C (no external route)';
    default:
      return 'not recorded';
  }
}

/** True when the matter was sealed for this exchange. */
export function isSealedRoute(tier: unknown, provider: unknown): boolean {
  return str(tier) === 'B' && str(provider) === 'aws-bedrock';
}

/**
 * How the request reached the model. Short enough for a column; it never
 * names a model, because the model is its own column and comes from the row.
 */
export function routePhrase(tier: unknown, provider: unknown): string {
  const id = str(provider);
  if (isSealedRoute(tier, provider)) {
    return 'sealed route — Amazon Bedrock in the firm’s own AWS account';
  }
  if (id === 'aws-bedrock') {
    return 'Amazon Bedrock in the firm’s own AWS account';
  }
  if (!id) return 'route not recorded';
  return `${providerLabel(id)} first-party API`;
}

/**
 * What may be said about retention on that route, on the date of the export.
 *
 * The AI Use Record skill's rule (SKILL.md, step 2): never assert a
 * provider's retention or training terms as fact — write "per [provider]
 * commercial terms as understood [date]" and leave the period bracketed for
 * the attorney. The sealed wording is 02-securespace.md's, no wider.
 */
export function retentionPosture(
  tier: unknown,
  provider: unknown,
  asOfDay: string,
): string {
  if (isSealedRoute(tier, provider)) {
    return (
      'Served inside the seal: a model in the firm’s own AWS account, under an ' +
      'account-level setting that forbids retention. That setting is the AWS ' +
      'account’s, not a promise by the model’s vendor. Sealing is prospective — ' +
      'it does not reach anything processed before this matter was sealed. ' +
      '[Confirm the account setting for the period covered.]'
    );
  }
  if (str(tier) === 'C') {
    return 'No external route is permitted on this tier. [Confirm.]';
  }
  const name = providerLabel(provider);
  if (!str(provider)) {
    return `Terms not recorded for this exchange. [Confirm what governed it.]`;
  }
  return (
    `Per ${name}’s first-party commercial terms as understood ${asOfDay}. ` +
    'Retention period and training posture: [confirm].'
  );
}

// ---------------------------------------------------------------------------
// What happened
// ---------------------------------------------------------------------------

// Plain verbs for the tools a connected assistant or an agent actually calls.
// Anything not listed reads "used the <name> tool", which is still a true
// sentence — the Record never guesses what a tool it does not know about did.
const TOOL_PHRASES: Record<string, string> = {
  search: 'searched this matter',
  get_passage: 'read a passage',
  grep: 'searched this matter for a phrase',
  list_matters: 'listed the matters',
  list_matter_contents: 'listed this matter’s contents',
  get_matter_state: 'read this matter’s state',
  set_matter_state: 'updated this matter’s state',
  create_matter: 'created a matter',
  move_document: 'moved a document',
  copy_document: 'copied a document',
  file_document: 'filed a document',
  ingest_document: 'filed a document for indexing',
  check_ingest_status: 'checked an upload',
  get_media: 'opened a media file',
  get_outline: 'read an outline',
  assemble_documents: 'assembled documents into one PDF',
  edit_pdf: 'edited a PDF into a new copy',
  create_deck: 'built a slide deck',
  create_chart: 'built a chart',
  send_to_sandbox: 'copied documents to the sandbox',
};

export function toolPhrase(tool: unknown): string {
  const name = str(tool);
  if (!name) return 'used a tool';
  return TOOL_PHRASES[name] ?? `used the ${name} tool`;
}

// ---------------------------------------------------------------------------
// Features — the model calls the product makes on a lawyer's behalf
// ---------------------------------------------------------------------------
// `/api/llm` is one endpoint behind six surfaces, so the label the caller
// sends is the only thing that can turn "a model was called" into an answer to
// the question a court actually asks: what was it used FOR. The labels are an
// allow-list validated server-side (lib/llm-record.mjs); an unrecognised one
// arrives here as 'unspecified', which these lines say plainly rather than
// dressing up.

/** Who, in the product, the call belongs to. */
const FEATURE_OWNERS: Record<string, string> = {
  bucketizer: 'Bucketizer',
  citecheck: 'Cite-Check',
  editor: 'the Editor',
  deck: 'Deck Composer',
  workbench: 'the AI Workbench',
  moot: 'Moot Bench',
};

/** What the call was doing. Past tense: these rows record what happened. */
const FEATURE_PHRASES: Record<string, string> = {
  'bucketizer.tree': 'proposed a structure of issues for this matter',
  'bucketizer.classify': 'classified a document',
  'bucketizer.evidence': 'gathered evidence for an issue',
  'citecheck.extract': 'read the citations out of a draft',
  'citecheck.check': 'checked a citation',
  'editor.light': 'edited a draft',
  'editor.plan': 'read a draft for its argument',
  'editor.section': 'edited a section of a draft',
  'editor.critic': 'read an edited draft as a critic',
  deck: 'built a slide deck',
  workbench: 'answered an instruction in the AI Workbench',
  'moot.generate': 'prepared a bench memo',
  'moot.converse': 'argued a moot session',
};

/** "Bucketizer", "Cite-Check" — the surface a reader would recognise. */
export function featureOwner(feature: unknown): string {
  const id = str(feature);
  if (!id || id === 'unspecified') return 'A Contextspaces feature';
  return FEATURE_OWNERS[id.split('.')[0]] ?? 'A Contextspaces feature';
}

/** "classified a document" — what the call did. */
export function featurePhrase(feature: unknown): string {
  const id = str(feature);
  if (!id) return 'called a model';
  return FEATURE_PHRASES[id] ?? 'called a model';
}

/** True for a row written by a feature's own model call, rather than by chat. */
export function isFeatureCall(event: LedgerEvent): boolean {
  return (
    (event.kind === 'completion.requested' || event.kind === 'completion.received') &&
    typeof event.payload?.feature === 'string'
  );
}

/** How the answer arrived, for the end of a feature line. */
function routeTail(event: LedgerEvent): string {
  const provider = event.payload?.provider;
  const model = str(event.payload?.model);
  if (isSealedRoute(event.payload?.tier, provider)) {
    return model
      ? ` — ${model}, a sealed model in the firm’s own AWS account`
      : ' — a sealed model in the firm’s own AWS account';
  }
  if (str(event.payload?.route) === 'sealed') {
    // Tier B, but no sealed model was ever chosen — the call was refused
    // before one could be. Saying which model was asked for would say the
    // opposite of what happened.
    return ' — the sealed route, before any model was chosen';
  }
  if (!model) return '';
  return ` — ${model}, ${providerLabel(provider)} direct`;
}

/** Why a feature call was refused, in words rather than in codes. */
const REFUSAL_PHRASES: Record<string, string> = {
  tier_violation: 'the model it asked for is outside this matter’s seal',
  ai_paused: 'AI is paused on this matter',
  ai_pause_unknown: 'whether AI is paused could not be checked',
  sealed_pen_unavailable: 'the sealed model is not available on this server',
  sealed_route_untranslatable: 'the request could not be carried to the sealed model unchanged',
  sealed_pen_error: 'the sealed model could not answer',
  budget_exhausted: 'this month’s included AI usage is spent',
  over_monthly_budget: 'this month’s included AI usage is spent',
  over_kind_budget: 'this month’s included AI usage is spent',
  over_rate_limit: 'too many requests in a short time',
  request_too_large: 'the request was too large to send',
  no_api_key: 'this server has no key for that model',
};

function describeFeatureRequested(event: LedgerEvent): string {
  const who = featureOwner(event.payload?.feature);
  const what = featurePhrase(event.payload?.feature);
  const refused = str(event.payload?.refused);
  if (refused) {
    const why = REFUSAL_PHRASES[refused];
    return `${who} asked to ${asInfinitive(what)} and was refused${why ? ` — ${why}` : ''}. Nothing was sent`;
  }
  return `${who} asked a model to ${asInfinitive(what)}${routeTail(event)}`;
}

function describeFeatureReceived(event: LedgerEvent): string {
  const who = featureOwner(event.payload?.feature);
  const what = featurePhrase(event.payload?.feature);
  const outcome = str(event.payload?.outcome);
  if (outcome === 'provider_error') {
    return `${who} asked a model to ${asInfinitive(what)} and the model could not answer${routeTail(event)}`;
  }
  if (outcome === 'stream_error') {
    return `${who} asked a model to ${asInfinitive(what)} and the answer stopped part-way${routeTail(event)}`;
  }
  return `${who} ${what}${routeTail(event)}`;
}

/** "classified a document" → "classify a document". Small, and only for these. */
function asInfinitive(phrase: string): string {
  const [verb, ...rest] = phrase.split(' ');
  const base = verb
    .replace(/^proposed$/, 'propose')
    .replace(/^classified$/, 'classify')
    .replace(/^gathered$/, 'gather')
    .replace(/^read$/, 'read')
    .replace(/^checked$/, 'check')
    .replace(/^edited$/, 'edit')
    .replace(/^built$/, 'build')
    .replace(/^answered$/, 'answer')
    .replace(/^prepared$/, 'prepare')
    .replace(/^argued$/, 'argue')
    .replace(/^called$/, 'call');
  return [base, ...rest].join(' ');
}

function describeToolInvoked(event: LedgerEvent, people: People): string {
  const who = actorSentence(event, people);
  const phrase = toolPhrase(event.payload?.tool);
  if (str(event.payload?.refused) === 'sealed') {
    return `${who} was refused — this matter is sealed (${str(event.payload?.tool) ?? 'tool call'})`;
  }
  if (str(event.payload?.refused)) {
    return `${who} was refused (${str(event.payload?.refused)}) — ${phrase}`;
  }
  if (event.payload?.ok === false) {
    return `${who} ${phrase} — the call failed`;
  }
  // Migration 072's fan-out row: a search that named no matter at all and
  // returned passages from this one. The row says that this matter was read
  // from and nothing else — it carries no other matter's id, name or count,
  // and this line adds none.
  if (str(event.payload?.via) === FANOUT_VIA) {
    return `${who} searched across every matter and read from this one`;
  }
  return `${who} ${phrase}`;
}

function describeCompletion(event: LedgerEvent, people: People): string {
  const model = str(event.payload?.model) ?? 'model not recorded';
  const provider = providerLabel(event.payload?.provider);
  const route = isSealedRoute(event.payload?.tier, event.payload?.provider)
    ? ', sealed route'
    : '';
  const asked =
    event.actor_kind === 'charter' || event.actor_kind === 'connector'
      ? ` for ${actorName(event, people)}`
      : '';
  const failed = str(event.payload?.error) ? ' — the exchange ended in an error' : '';
  return `The assistant answered${asked} — ${model} on ${provider}${route}${failed}`;
}

/** "a member", "an admin" — the role word is the row's, the article is ours. */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

function describeAcl(event: LedgerEvent, people: People): string {
  const target = personName(event.payload?.target_user_id, people);
  const where =
    str(event.payload?.table) === 'serverspace_members'
      ? 'the serverspace'
      : 'this matter';
  const oldRole = str(event.payload?.old_role);
  const newRole = str(event.payload?.new_role);
  switch (str(event.payload?.op)) {
    case 'insert':
      return `${target} was added to ${where}${
        newRole ? ` as ${article(newRole)} ${newRole}` : ''
      }`;
    case 'delete':
      return `${target} was removed from ${where}${oldRole ? ` (was ${oldRole})` : ''}`;
    case 'update':
      return `${target}’s role in ${where} changed${
        oldRole && newRole ? ` from ${oldRole} to ${newRole}` : ''
      }`;
    default:
      return `Membership of ${where} changed for ${target}`;
  }
}

function describeSeal(event: LedgerEvent): string {
  const oldTier = str(event.payload?.old_tier);
  const newTier = str(event.payload?.new_tier);
  if (!oldTier && !newTier) return 'Seal changed (the tiers were not recorded)';
  return `Seal changed: Tier ${tierLabel(oldTier)} → Tier ${tierLabel(newTier)}`;
}

function factorKind(value: unknown): string {
  if (value === 'totp') return ' (authenticator app)';
  if (value === 'webauthn') return ' (passkey)';
  return '';
}

/** One plain-language line for one row. Never throws, never returns empty. */
export function describeEvent(event: LedgerEvent, people: People = {}): string {
  const who = actorSentence(event, people);
  const payload = event.payload ?? {};
  switch (event.kind) {
    case 'tool.invoked':
      return describeToolInvoked(event, people);
    case 'completion.requested':
      return describeFeatureRequested(event);
    case 'completion.received':
      // A feature's own model call and a chat answer are the same kind of row
      // and are not the same kind of act, so they do not read alike.
      return isFeatureCall(event) ? describeFeatureReceived(event) : describeCompletion(event, people);
    case 'acl.changed':
      return describeAcl(event, people);
    case 'seal.changed':
      return describeSeal(event);
    case 'file.exported': {
      const title = str(payload.title) ?? 'a document';
      const dest = str(payload.destination);
      // S4a: the Reader's Download button, on any matter.
      if (dest === 'download') return `${who} downloaded ${title}`;
      return `${who} exported ${title}${dest ? ` (${dest})` : ''}`;
    }
    // S4a (migration 096): a sealed matter's file handed out to be read or
    // downloaded — by the Reader through /api/document-url, or by get_media.
    case 'file.opened': {
      const title = str(payload.title) ?? 'a document';
      const how = str(payload.via) === 'connector' ? ' through a connected assistant' : '';
      return payload.purpose === 'download'
        ? `${who} opened ${title} to download it${how}`
        : `${who} opened ${title}${how}`;
    }
    case 'file.sent': {
      const ids = Array.isArray(payload.document_ids) ? payload.document_ids.length : null;
      const channel = str(payload.channel) ?? 'a channel';
      const what = ids === null ? 'documents' : `${ids} document${ids === 1 ? '' : 's'}`;
      return `${who} sent ${what} by ${channel}`;
    }
    case 'file.delivered': {
      const to = str(payload.recipient) ?? 'a recipient';
      const bates = str(payload.bates_range);
      return `A production was delivered to ${to}${bates ? ` (${bates})` : ''}`;
    }
    case 'file.gate': {
      const named = str(payload.gate);
      const gate = named ? `the ${named} gate` : 'a send gate';
      return payload.allowed === false
        ? `A document was stopped at ${gate}${
            str(payload.reason) ? ` — ${str(payload.reason)}` : ''
          }`
        : `A document passed ${gate}`;
    }
    case 'citation.verified': {
      const cites = num(payload.cites);
      const run = str(payload.run_id);
      return `${cites === null ? 'Citations' : `${cites} citation${cites === 1 ? '' : 's'}`} verified${
        run ? ` (run ${run})` : ''
      }`;
    }
    case 'connector.registered':
      return `${str(payload.client_name) ?? 'A connected assistant'} was connected`;
    case 'connector.revoked':
      return `${str(payload.client_name) ?? 'A connected assistant'} was disconnected`;
    case 'ai.paused':
      return `AI was paused on this matter${
        str(payload.reason) ? ` — ${str(payload.reason)}` : ''
      }`;
    case 'ai.resumed':
      return 'AI was resumed on this matter';
    case 'run.aborted':
      return `${who} stopped a run in progress`;
    // 094 / S1 — account-chain rows. The factor's own name is never stored,
    // only its kind: an authenticator app or a passkey.
    case 'auth.factor_enrolled':
      return `${who} added a second factor${factorKind(payload.factor_type)}`;
    case 'auth.factor_unenrolled':
      return `${who} removed a second factor${factorKind(payload.factor_type)}`;
    case 'auth.stepup':
      return `${who} confirmed a second factor to open a sealed matter`;
    default:
      // A kind this build does not know. Say who and what it was called,
      // and say no more than that.
      return `${who} — recorded act "${event.kind}"`;
  }
}

/** A short label for the kind, for filters and for the export's Kind column. */
export function kindLabel(kind: string): string {
  switch (kind) {
    case 'tool.invoked':
      return 'Tool call';
    case 'completion.requested':
      return 'AI call asked';
    case 'completion.received':
      return 'AI answer';
    case 'acl.changed':
      return 'Access';
    case 'seal.changed':
      return 'Seal';
    case 'file.exported':
      return 'Export';
    case 'file.opened':
      return 'Opened';
    case 'file.sent':
      return 'Send';
    case 'file.delivered':
      return 'Delivery';
    case 'file.gate':
      return 'Send gate';
    case 'citation.verified':
      return 'Cite check';
    case 'connector.registered':
      return 'Connector added';
    case 'connector.revoked':
      return 'Connector removed';
    case 'ai.paused':
      return 'AI paused';
    case 'ai.resumed':
      return 'AI resumed';
    case 'run.aborted':
      return 'Run stopped';
    case 'auth.factor_enrolled':
      return 'Factor added';
    case 'auth.factor_unenrolled':
      return 'Factor removed';
    case 'auth.stepup':
      return 'Factor confirmed';
    default:
      return kind;
  }
}

/** The header line: what the integrity check said, in words that do not shout. */
export function chainSummary(
  chains: { ok: boolean; checked: number; firstBadSeq: number | null; matterName: string; unavailable?: boolean }[],
): { ok: boolean; line: string; meaning: string } {
  const checkable = chains.filter((c) => !c.unavailable);
  const total = checkable.reduce((n, c) => n + c.checked, 0);
  const bad = checkable.find((c) => !c.ok);
  const unavailable = chains.filter((c) => c.unavailable);

  if (chains.length === 0) {
    return {
      ok: true,
      line: 'Record intact — nothing recorded yet',
      meaning:
        'Nothing has been recorded on this matter so far, so there is nothing to check.',
    };
  }
  if (checkable.length === 0) {
    return {
      ok: true,
      line: 'Record shown — the integrity check could not be run here',
      meaning:
        'The entries are listed, but the check that re-verifies each entry’s seal did not answer ' +
        'for this account — usually because it has not been switched on here yet. The entries ' +
        'below are shown exactly as the Record holds them; they have simply not been re-verified ' +
        'in this view.',
    };
  }
  if (bad) {
    return {
      ok: false,
      line: `Record check failed at entry ${bad.firstBadSeq ?? '?'} in ${bad.matterName}`,
      meaning:
        'Each entry is sealed to the one before it. One entry no longer matches its seal, so the ' +
        'entries from that point on cannot be relied on until this is explained. The entries ' +
        'before it still check out. Nothing in the product can edit or delete an entry, so this ' +
        'should be raised with whoever administers this account before the Record is relied on.',
    };
  }
  const acrossMatters =
    checkable.length > 1 ? ` across ${checkable.length} matters` : '';
  const line = `Record intact — ${total} ${total === 1 ? 'entry' : 'entries'} verified${acrossMatters}`;
  const meaning =
    'Each entry is sealed to the one before it, and every seal was re-checked and matched. Any ' +
    'later change to an entry, removal of one, or insertion of one would have shown up here.';
  if (unavailable.length > 0) {
    return {
      ok: true,
      line: `${line} (${unavailable.length} could not be checked)`,
      meaning:
        meaning +
        ' Some matters could not be checked from this account — usually because the check has not ' +
        'been switched on here yet.',
    };
  }
  return { ok: true, line, meaning };
}
