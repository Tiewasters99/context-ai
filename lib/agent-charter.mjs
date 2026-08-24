// Agents — the server side of a charter.
//
// A charter is a page the user wrote: who the agent is, what its job is,
// which tools it may use, and when it runs. This module does three things
// and stops:
//
//   1. loadCharter()      — fetch one charter for a run, through the
//                           USER-SCOPED Supabase client so RLS decides
//                           whether the user may see it. Built-in agents
//                           (the "On duty" docket) resolve from code here,
//                           server-side, so the browser never supplies the
//                           prose that shapes a run.
//   2. narrowToolNames()  — intersect the charter's tool list with the set
//                           the Orchestrator already allows. A charter can
//                           only NARROW. This is the whole security story
//                           of the toolset: there is no path by which a
//                           charter adds a tool.
//   3. buildCharterAppendix() — render the charter as a block appended to
//                           the Orchestrator's system prompt: identity,
//                           the job in the user's own words, and a plain
//                           statement of what it may touch.
//
// What is NOT here, deliberately: the pen. Which model answers is decided
// by the matter's SecureSpace tier (lib/ai-tier-policy.mjs), never by a
// charter and never by the client. And no separate run log: a charter run
// is an Orchestrator run, recorded in ai_sessions / ai_messages with the
// charter id stamped into the message content.

import { TOOLS } from './mcp-core.mjs';

const BUILTIN_PREFIX = 'builtin:';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agents that exist as standing things rather than as something the
 * user wrote — the left-hand "On duty" docket. Their charters live here,
 * in code, because they are part of the product rather than part of a
 * user's workspace.
 *
 * v1 honesty rule: only `support` and `ingestion` have anything real to do
 * on demand today. Nothing here is scheduled — there is no scheduler in
 * this codebase — and the UI says so on every row rather than implying
 * background activity that does not happen.
 */
export const BUILTIN_CHARTERS = {
  support: {
    key: 'support',
    name: 'Support',
    purpose:
      'Diagnose what is actually happening in this Contextspaces instance and either fix it '
      + 'within the guardrails or say plainly that a person has to.',
    instructions:
      'You are the support agent for this Contextspaces instance. Someone has a problem: a '
      + 'document that will not open, an import that seems stuck, a tab that looks empty, a '
      + 'feature they cannot find.\n\n'
      + 'Work from evidence, not from guesswork. Establish exactly what they are seeing and '
      + 'where they are seeing it before reasoning about causes — by a wide margin the most '
      + 'common cause is that the thing exists but is not where they are looking. Where a tool '
      + 'can show you the real state (check_ingest_status for imports, list_matter_contents for '
      + 'what is actually filed), read it before explaining.\n\n'
      + 'You may fix things that are safe and reversible: re-queueing a document for ingestion '
      + 'is the main one. Anything that deletes, moves, or rewrites work product is not yours to '
      + 'do — describe it and let the user do it.\n\n'
      + 'When the problem is beyond what you can see or fix, say so in one sentence, say what '
      + 'you established, and say that it needs a person. Do not speculate about causes you have '
      + 'no evidence for, and never claim to have fixed something you only queued.',
    allowed_tools: [
      'list_matters', 'list_matter_contents', 'check_ingest_status', 'ingest_document',
      'get_outline', 'search',
    ],
  },
  ingestion: {
    key: 'ingestion',
    name: 'Ingestion watcher',
    purpose:
      'Watch what is coming into the vault: what is still processing, what failed, and what '
      + 'should be retried.',
    instructions:
      'Your job is the state of ingestion. Read it before you say anything about it: '
      + 'check_ingest_status gives you the real queue and document state, including whether the '
      + 'background worker looks alive.\n\n'
      + 'Report what you find in plain terms — how many documents are still processing, which '
      + 'ones errored and with what error, and how long anything has been sitting. Where a '
      + 'document failed for a reason a retry can cure, offer to re-queue it with '
      + 'ingest_document; that only enqueues work, so say it is processing, never that it is '
      + 'done.\n\n'
      + 'If check_ingest_status warns the worker may not be running, pass that along exactly — '
      + 'a queue that is not draining is a different problem from a document that failed, and '
      + 'the user needs to know which one they have.',
    allowed_tools: [
      'check_ingest_status', 'ingest_document', 'list_matter_contents', 'list_matters',
    ],
  },
  morning_brief: {
    key: 'morning_brief',
    name: 'Morning brief',
    purpose:
      'One short brief on where the practice stands: what moved, what is due, and what is '
      + 'waiting on someone.',
    instructions:
      'Produce a brief a lawyer can read standing up. Read the docket state for the matters in '
      + 'scope with get_matter_state, and where a thread turns on something in the record, look '
      + 'it up rather than characterising it from memory.\n\n'
      + 'Lead with anything overdue or due today, then anything waiting on someone outside the '
      + 'firm, then what actually moved since the last brief. Three to six lines. No headings, '
      + 'no restatement of things that did not change, and no invented activity — a quiet day '
      + 'is a legitimate brief and should be reported as one.',
    allowed_tools: ['get_matter_state', 'list_matters', 'search', 'get_passage'],
  },
  docket_monitor: {
    key: 'docket_monitor',
    name: 'Docket monitor',
    purpose:
      'Keep the Practice Docket honest: what each thread says, what it should say, and what is '
      + 'about to come due.',
    instructions:
      'You maintain the docket, not the case. Read the current state of the threads in scope '
      + 'with get_matter_state before proposing anything.\n\n'
      + 'Say which entries have gone stale — a next step that has plainly already happened, a '
      + 'deadline in the past, a "waiting on" that has since come back. Propose the corrected '
      + 'wording and, when the user agrees, write it with set_matter_state so the change lands '
      + 'as an append-only ledger event.\n\n'
      + 'Never invent a deadline or a status. If the record does not tell you whether something '
      + 'happened, say that it does not and ask.',
    allowed_tools: ['get_matter_state', 'set_matter_state', 'list_matters', 'search'],
  },
};

/** mcp-core's own one-line description of a tool, for the prompt. */
function toolDescription(name) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return null;
  // The schemas carry long, carefully-written descriptions. The charter
  // block only needs the first sentence — the full schema goes to the model
  // anyway as part of the tool definitions.
  const first = String(t.description || '').split(/(?<=\.)\s/)[0];
  return first || t.description || null;
}

/**
 * The tools a charter run may actually use: the charter's list, intersected
 * with what the Orchestrator allows AND with what mcp-core actually
 * implements. Order follows the allowed set so the prompt reads the same
 * way every time.
 *
 * @param {string[]|null|undefined} charterTools names the charter asked for
 * @param {Set<string>|string[]} allowedNames the Orchestrator's allow-list
 * @returns {string[]}
 */
export function narrowToolNames(charterTools, allowedNames) {
  const allowed = allowedNames instanceof Set ? allowedNames : new Set(allowedNames || []);
  const implemented = new Set(TOOLS.map((t) => t.name));
  const asked = new Set(
    (Array.isArray(charterTools) ? charterTools : [])
      .filter((n) => typeof n === 'string' && n.trim())
      .map((n) => n.trim()),
  );
  return [...allowed].filter((n) => asked.has(n) && implemented.has(n));
}

/**
 * Load the charter for a run.
 *
 * `charterId` is either a uuid (a row in agent_charters — read through the
 * caller's USER-SCOPED client, so RLS answers "may this user see it?") or
 * `builtin:<key>` (an on-duty agent, resolved from code above).
 *
 * Returns a normalised charter, or null when it does not exist / is not
 * visible / the table has not been created yet. A null is not an error: the
 * run simply proceeds as an ordinary Orchestrator turn.
 *
 * @returns {Promise<null | {id:string, source:'stored'|'builtin', name:string,
 *   purpose:string, instructions:string, allowed_tools:string[],
 *   matterspace_id:string|null, trigger_kind:string, enabled:boolean}>}
 */
export async function loadCharter(supabase, charterId) {
  if (typeof charterId !== 'string' || !charterId.trim()) return null;
  const id = charterId.trim();

  if (id.startsWith(BUILTIN_PREFIX)) {
    const b = BUILTIN_CHARTERS[id.slice(BUILTIN_PREFIX.length)];
    if (!b) return null;
    return {
      id,
      source: 'builtin',
      name: b.name,
      purpose: b.purpose,
      instructions: b.instructions,
      allowed_tools: [...b.allowed_tools],
      matterspace_id: null,
      trigger_kind: 'on_demand',
      enabled: true,
    };
  }

  if (!UUID_RE.test(id)) return null;
  try {
    const { data, error } = await supabase
      .from('agent_charters')
      .select('id, name, purpose, instructions, allowed_tools, matterspace_id, trigger_kind, enabled')
      .eq('id', id)
      .maybeSingle();
    // A missing table (migration 052 not yet applied) is a configuration
    // state, not a failure of the turn: run without a charter and let the
    // UI explain. Anything else is logged and treated the same way.
    if (error) {
      console.warn('[agents] charter lookup failed:', error.message);
      return null;
    }
    if (!data) return null;
    return {
      id: data.id,
      source: 'stored',
      name: data.name || 'Agent',
      purpose: data.purpose || '',
      instructions: data.instructions || '',
      allowed_tools: Array.isArray(data.allowed_tools) ? data.allowed_tools : [],
      matterspace_id: data.matterspace_id ?? null,
      trigger_kind: data.trigger_kind || 'on_demand',
      enabled: data.enabled !== false,
    };
  } catch (err) {
    console.warn('[agents] charter lookup failed:', err?.message || err);
    return null;
  }
}

/**
 * The charter, rendered for the system prompt. Explains the job and states
 * the boundary; it does not stack rules on top of the Orchestrator prompt,
 * which already knows how to behave.
 *
 * @param {object} charter   from loadCharter()
 * @param {string[]} toolNames  the NARROWED list actually in force
 */
export function buildCharterAppendix(charter, toolNames) {
  const lines = [];
  lines.push('THIS RUN HAS A CHARTER');
  lines.push('');
  lines.push(
    `You are running as "${charter.name}" — an agent this user set up inside Contextspaces. `
    + 'Everything above still holds; the charter below says what this particular run is for. '
    + 'It was written by the user, so where it and your own instincts differ about the shape of '
    + 'the answer, follow the charter.',
  );
  if (charter.purpose?.trim()) {
    lines.push('');
    lines.push(`PURPOSE\n${charter.purpose.trim()}`);
  }
  if (charter.instructions?.trim()) {
    lines.push('');
    lines.push(`THE JOB, IN THE USER'S WORDS\n${charter.instructions.trim()}`);
  }
  lines.push('');
  if (toolNames.length) {
    const listed = toolNames
      .map((n) => {
        const d = toolDescription(n);
        return d ? `- ${n} — ${d}` : `- ${n}`;
      })
      .join('\n');
    lines.push(
      'WHAT THIS AGENT MAY USE\nThis charter narrows you to these tools for this run; nothing '
      + 'else is available to you, and that is deliberate:\n' + listed,
    );
  } else {
    lines.push(
      'WHAT THIS AGENT MAY USE\nThis charter grants no tools. You cannot search, read documents, '
      + 'or change anything on this run — answer from the conversation itself, and if the '
      + 'question needs the record, say plainly that this agent has not been given access to it.',
    );
  }
  return lines.join('\n');
}
