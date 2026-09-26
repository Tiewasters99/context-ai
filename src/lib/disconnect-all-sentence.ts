// The confirm sentence for "Disconnect everything" (migration 095), and its
// matter-sized sibling. Import-free, so scripts/_verify-disconnect-all.mjs can
// run it against the counts the database actually returns.
//
// The sentence is the whole of the confirmation: it names what will go BEFORE
// the press, from disconnect_all_preview — the same selection the press then
// acts on — so what it says and what happens cannot differ.

export interface DisconnectCounts {
  scope: 'account' | 'matter';
  matter_id?: string | null;
  /** Full-access OAuth connections (Approved AI clients). */
  assistants: number;
  /** Agents: connector tokens of kind 'agent', however they connected. */
  agents: number;
  /** Pasted connector tokens (Claude Desktop, the Chrome extension, …). */
  apps: number;
  /** Agents written in Contextspaces (agent_charters) that will be switched off. */
  charters: number;
  /** Matters AI will be paused on afterwards, inherited or not. */
  matters: number;
  matters_paused_now?: number;
  /** Matter scope: account-wide connections that must go everywhere. */
  outright?: boolean;
  done?: boolean;
}

const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : Number(x) || 0);

function count(k: number, one: string, many: string): string {
  return `${k} ${k === 1 ? one : many}`;
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Read the RPC's jsonb into numbers, whatever arrived. */
export function normaliseCounts(raw: unknown): DisconnectCounts {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    scope: r.scope === 'matter' ? 'matter' : 'account',
    matter_id: typeof r.matter_id === 'string' ? r.matter_id : null,
    assistants: n(r.assistants),
    agents: n(r.agents),
    apps: n(r.apps),
    charters: n(r.charters),
    matters: n(r.matters),
    matters_paused_now: n(r.matters_paused_now),
    outright: r.outright === true,
    done: r.done === true,
  };
}

/** "3 assistants, 2 agents, 1 connected app; AI paused on 41 matters". */
export function countsLine(c: DisconnectCounts): string {
  const connected = [
    c.assistants ? count(c.assistants, 'assistant', 'assistants') : '',
    c.agents ? count(c.agents, 'agent', 'agents') : '',
    c.apps ? count(c.apps, 'connected app', 'connected apps') : '',
  ].filter(Boolean);
  const head = connected.length ? connected.join(', ') : 'nothing connected';
  const own = c.charters ? `; ${count(c.charters, 'agent you built here', 'agents you built here')} switched off` : '';
  const paused = c.matters ? `; AI paused on ${count(c.matters, 'matter', 'matters')}` : '';
  return `${head}${own}${paused}`;
}

/** The whole-account confirmation, before the press. */
export function accountSentence(c: DisconnectCounts): string {
  const connected = [
    c.assistants ? count(c.assistants, 'assistant', 'assistants') : '',
    c.agents ? count(c.agents, 'agent', 'agents') : '',
    c.apps ? count(c.apps, 'connected app', 'connected apps') : '',
  ].filter(Boolean);
  const acts: string[] = [];
  if (connected.length) acts.push(`disconnects ${list(connected)}`);
  if (c.charters) acts.push(`switches off ${count(c.charters, 'agent you built here', 'agents you built here')}`);
  if (c.matters) acts.push(`pauses AI on ${count(c.matters, 'matter', 'matters')}`);
  const first = acts.length
    ? `This ${list(acts)}.`
    : 'Nothing is connected to your account and there are no matters of yours to pause.';
  return (
    `${first} Every other browser signed in to your account is signed out; this one stays signed in. ` +
    'Nothing comes back by itself: you reconnect each one, and resume AI on each matter, when you choose.'
  );
}

/** The matter's confirmation, before the press. */
export function matterSentence(c: DisconnectCounts, matterName: string): string {
  const name = matterName.trim() || 'this matter';
  const parts: string[] = [`This pauses AI on ${name} for everyone`];
  if (c.agents) {
    parts.push(`disconnects ${count(c.agents, 'agent of yours that can see it', 'agents of yours that can see it')}`);
  }
  let first = `${list(parts)}.`;
  const everywhere = [
    c.assistants ? count(c.assistants, 'assistant', 'assistants') : '',
    c.apps ? count(c.apps, 'connected app', 'connected apps') : '',
  ].filter(Boolean);
  if (everywhere.length) {
    const are = c.assistants + c.apps === 1 ? 'reaches' : 'reach';
    const them = c.assistants + c.apps === 1 ? 'it is' : 'they are';
    first +=
      ` Your ${list(everywhere)} ${are} every matter you have, so ${them} disconnected from all of them, ` +
      'not just this one.';
  }
  return `${first} Other people's connections are not touched; the pause stops them here.`;
}
