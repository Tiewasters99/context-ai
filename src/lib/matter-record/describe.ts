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

/** One plain-language line for one row. Never throws, never returns empty. */
export function describeEvent(event: LedgerEvent, people: People = {}): string {
  const who = actorSentence(event, people);
  const payload = event.payload ?? {};
  switch (event.kind) {
    case 'tool.invoked':
      return describeToolInvoked(event, people);
    case 'completion.received':
      return describeCompletion(event, people);
    case 'acl.changed':
      return describeAcl(event, people);
    case 'seal.changed':
      return describeSeal(event);
    case 'file.exported': {
      const title = str(payload.title) ?? 'a document';
      const dest = str(payload.destination);
      return `${who} exported ${title}${dest ? ` (${dest})` : ''}`;
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
    case 'completion.received':
      return 'AI answer';
    case 'acl.changed':
      return 'Access';
    case 'seal.changed':
      return 'Seal';
    case 'file.exported':
      return 'Export';
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
    default:
      return kind;
  }
}

/** The header line: what `verify_chain` said, in words that do not shout. */
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
        'No acts have been written to this matter’s Record so far, so there is nothing to check.',
    };
  }
  if (checkable.length === 0) {
    return {
      ok: true,
      line: 'Record shown — the integrity check could not be run here',
      meaning:
        'The entries are listed, but the check that recomputes their hashes did not answer for ' +
        'this account — usually because it is not in this database yet. The entries below are ' +
        'shown as the Record holds them; their chain has not been confirmed in this view.',
    };
  }
  if (bad) {
    return {
      ok: false,
      line: `Record check failed at entry ${bad.firstBadSeq ?? '?'} in ${bad.matterName}`,
      meaning:
        'Every entry is chained to the one before it by a hash. One entry no longer matches its hash, ' +
        'so the chain cannot be confirmed from that point on. Entries before it still check out. ' +
        'Nothing in the product can edit or delete an entry, so this is worth showing to whoever ' +
        'administers the database before the Record is relied on.',
    };
  }
  const acrossMatters =
    checkable.length > 1 ? ` across ${checkable.length} matters` : '';
  const line = `Record intact — ${total} ${total === 1 ? 'entry' : 'entries'} verified${acrossMatters}`;
  const meaning =
    'Each entry is chained to the one before it by a hash, and every hash was recomputed and matched. ' +
    'The chain shows the entries have not been altered or removed since they were written.';
  if (unavailable.length > 0) {
    return {
      ok: true,
      line: `${line} (${unavailable.length} could not be checked)`,
      meaning:
        meaning +
        ' Some matters could not be checked from this account — usually because the check is not ' +
        'available in this database yet.',
    };
  }
  return { ok: true, line, meaning };
}
