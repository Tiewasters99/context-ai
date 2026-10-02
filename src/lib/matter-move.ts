// What moving a matter in the sidebar changes, worked out BEFORE the move.
//
// Why (Eden, 09-30): a drag dropped Legal › Teman, twenty sub-matters and
// all, onto a different client's matter. Access to a matter flows down from
// every matter above it (matter_role() walks matter_ancestry(), migration
// 016) and so does an agent's grant (agent-scope.ts) — so a re-parent is a
// sharing change, and nothing said so. This module answers "who and what
// would gain or lose sight of it" from data the browser already has, so the
// sidebar can ask first when the answer is not "nobody".
//
// Display only. The server decides access; this never grants or refuses
// anything, it only decides whether to ask and what to say. Where the browser
// cannot know (a sharing list it may not read), it says less, never something
// false: the answer is marked uncertain and the dialog is shown.
//
// Pure: imports only the scope rule, so a node harness can drive it.

import {
  agentCoversMatter,
  ancestorsInclusive,
  isEffectivelySealed,
  type ScopeMatter,
} from './agent-scope.ts';

export interface MoveTreeMatter extends ScopeMatter {
  name: string;
}

export interface MoveAgent {
  id: string;
  label: string;
  matter_scope: readonly string[] | null | undefined;
  scope_all?: boolean | null;
}

export interface MoveInput {
  /** Every matter of the serverspace the browser holds (the sidebar tree). */
  matters: readonly MoveTreeMatter[];
  matterId: string;
  /** null = the top level of the serverspace. */
  newParentId: string | null;
  /**
   * Who is shared on each matter (matterspace_members user ids). A matter
   * absent from the map, or mapped to null, is one whose list could not be
   * read — and row-level security filters silently, so only a matter that is
   * in the loaded tree counts as read.
   */
  membersOf: ReadonlyMap<string, readonly string[] | null>;
  /** Everyone on the serverspace (they reach every matter in it), or null if unread. */
  serverspaceMembers: readonly string[] | null;
  me: string;
  /** The signed-in user's own live agents; null = they could not be read. */
  agents: readonly MoveAgent[] | null;
}

export interface PeopleChange {
  /** People counted from lists that were read. */
  userIds: string[];
  /** The matters (above the moved one) those people are shared on. */
  via: string[];
  /** Matters above whose sharing list could not be read; anyone there changes too. */
  unreadable: string[];
  /** False when a list needed to rule someone out was not read: `userIds` may overstate. */
  certain: boolean;
}

export interface MoveImpact {
  matterId: string;
  oldParentId: string | null;
  newParentId: string | null;
  /** Sub-matters that move with it. */
  descendantCount: number;
  gain: PeopleChange;
  lose: PeopleChange;
  /** True when the mover's own access to it would come only from a matter it is leaving. */
  selfLoses: boolean;
  agentsGain: MoveAgent[];
  agentsLose: MoveAgent[];
  /** Agents could not be read, so nothing can be said about them. */
  agentsUnknown: boolean;
  sealedBefore: boolean;
  sealedAfter: boolean;
  /** The nearest sealed matter above (or the matter itself), before and after. */
  sealBeforeId: string | null;
  sealAfterId: string | null;
  /** Anything at all would change, or could not be ruled out: ask first. */
  changed: boolean;
}

/** The tree with one matter given a new parent. */
export function withParent<T extends ScopeMatter>(matters: readonly T[], matterId: string, newParentId: string | null): T[] {
  return matters.map((m) => (m.id === matterId ? { ...m, parent_matterspace_id: newParentId } : m));
}

/** The matter and everything beneath it. */
export function subtreeIds(matters: readonly ScopeMatter[], matterId: string): string[] {
  const kids = new Map<string, string[]>();
  for (const m of matters) {
    if (!m.parent_matterspace_id) continue;
    const list = kids.get(m.parent_matterspace_id) ?? [];
    list.push(m.id);
    kids.set(m.parent_matterspace_id, list);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [matterId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const k of kids.get(id) ?? []) stack.push(k);
  }
  return out;
}

/**
 * The matters above `matterId` (not itself), nearest first, and the first
 * parent on the way up that is NOT in the tree, if any: a matter the browser
 * cannot see, whose sharing list (and everything above it) is unknown.
 */
export function ancestorsAbove(matters: readonly ScopeMatter[], matterId: string): { ids: string[]; hiddenParent: string | null } {
  // The walk names a parent it cannot find and stops there.
  const byId = new Map(matters.map((m) => [m.id, m] as const));
  const walk = ancestorsInclusive(matters, matterId).slice(1);
  const hidden = walk.findIndex((id) => !byId.has(id));
  return hidden < 0
    ? { ids: walk, hiddenParent: null }
    : { ids: walk.slice(0, hidden), hiddenParent: walk[hidden] };
}

/** The nearest sealed matter on the way up (the matter itself first), or null. */
export function sealingMatter(matters: readonly ScopeMatter[], matterId: string): string | null {
  const byId = new Map(matters.map((m) => [m.id, m] as const));
  for (const id of ancestorsInclusive(matters, matterId)) {
    const m = byId.get(id);
    if (m && m.ai_tier !== 'A') return id;
  }
  return null;
}

function peopleOn(membersOf: MoveInput['membersOf'], ids: readonly string[]): { who: Map<string, string[]>; unreadable: string[] } {
  const who = new Map<string, string[]>();   // user id -> matters they are on
  const unreadable: string[] = [];
  for (const id of ids) {
    const list = membersOf.get(id);
    if (!list) { unreadable.push(id); continue; }
    for (const u of list) who.set(u, [...(who.get(u) ?? []), id]);
  }
  return { who, unreadable };
}

/**
 * People who reach the moved matter through `from` ancestors and through
 * nothing that stays (`keep`): they are the ones whose sight of it changes.
 */
function difference(
  from: { who: Map<string, string[]>; unreadable: string[] },
  keep: { who: Map<string, string[]>; unreadable: string[] },
  alwaysReach: Set<string>,
  alwaysCertain: boolean,
): PeopleChange {
  const userIds: string[] = [];
  const via = new Set<string>();
  for (const [u, on] of from.who) {
    if (alwaysReach.has(u) || keep.who.has(u)) continue;
    userIds.push(u);
    for (const id of on) via.add(id);
  }
  // An unread list on BOTH sides is a matter above both places (it stays
  // above the moved matter): whoever is on it keeps their sight of it.
  const keepUnread = new Set(keep.unreadable);
  return {
    userIds,
    via: [...via],
    unreadable: [...new Set(from.unreadable)].filter((id) => !keepUnread.has(id)),
    // Someone counted here may still reach it through a list that was not read.
    certain: alwaysCertain && keep.unreadable.length === 0,
  };
}

export function computeMoveImpact(input: MoveInput): MoveImpact {
  const { matters, matterId, newParentId, membersOf, serverspaceMembers, me, agents } = input;
  const before = matters;
  const after = withParent(matters, matterId, newParentId);
  const oldParentId = matters.find((m) => m.id === matterId)?.parent_matterspace_id ?? null;

  // People. The serverspace's members reach every matter in it, before and
  // after (a move never leaves the serverspace), and so do the people shared
  // on the matter itself; the mover can see it already.
  const oldUp = ancestorsAbove(before, matterId);
  const newUp = ancestorsAbove(after, matterId);
  const oldSide = peopleOn(membersOf, oldUp.ids);
  const newSide = peopleOn(membersOf, newUp.ids);
  if (oldUp.hiddenParent) oldSide.unreadable.push(oldUp.hiddenParent);
  if (newUp.hiddenParent) newSide.unreadable.push(newUp.hiddenParent);
  const own = membersOf.get(matterId);
  const always = new Set<string>([...(serverspaceMembers ?? []), ...(own ?? []), me]);
  const alwaysCertain = serverspaceMembers !== null && !!own;

  const gain = difference(newSide, oldSide, always, alwaysCertain);
  const lose = difference(oldSide, newSide, always, alwaysCertain);

  // The mover. Only claimed when every list that could keep them in was read.
  const selfLoses =
    oldSide.who.has(me)
    && !newSide.who.has(me)
    && !(serverspaceMembers ?? []).includes(me)
    && !(own ?? []).includes(me)
    && alwaysCertain
    && newSide.unreadable.length === 0;

  // Agents: what each one sees of the moved matter and its sub-matters.
  const subtree = subtreeIds(before, matterId);
  const agentsGain: MoveAgent[] = [];
  const agentsLose: MoveAgent[] = [];
  for (const a of agents ?? []) {
    let gained = false;
    let lost = false;
    for (const id of subtree) {
      const was = agentCoversMatter(before, a, id);
      const will = agentCoversMatter(after, a, id);
      if (will && !was) gained = true;
      if (was && !will) lost = true;
    }
    if (gained) agentsGain.push(a);
    if (lost) agentsLose.push(a);
  }

  const sealedBefore = isEffectivelySealed(before, matterId);
  const sealedAfter = isEffectivelySealed(after, matterId);

  const changed =
    gain.userIds.length > 0 || gain.unreadable.length > 0
    || lose.userIds.length > 0 || lose.unreadable.length > 0
    || selfLoses
    || agentsGain.length > 0 || agentsLose.length > 0
    || agents === null
    || sealedBefore !== sealedAfter;

  return {
    matterId,
    oldParentId,
    newParentId,
    descendantCount: subtree.length - 1,
    gain,
    lose,
    selfLoses,
    agentsGain,
    agentsLose,
    agentsUnknown: agents === null,
    sealedBefore,
    sealedAfter,
    sealBeforeId: sealingMatter(before, matterId),
    sealAfterId: sealingMatter(after, matterId),
    changed,
  };
}

// ── the words ────────────────────────────────────────────────────────

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Teman" / "Teman and its sub-matter" / "Teman and its 20 sub-matters". */
export function whatMoves(name: string, descendantCount: number): string {
  if (descendantCount <= 0) return name;
  if (descendantCount === 1) return `${name} and its sub-matter`;
  return `${name} and its ${descendantCount} sub-matters`;
}

/** Names to show after a count: at most four, then "and N others". */
function namesList(labels: readonly string[]): string {
  if (labels.length <= 4) return joinNames(labels);
  return `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} others`;
}

export interface MoveLine {
  text: string;
  /** 'warn' is styled as a warning (leaving a SecureSpace, losing your own access). */
  tone: 'warn' | 'seal' | 'plain';
}

export interface MoveWords {
  /** "Move Teman into UKC?" */
  title: string;
  /** "Move into UKC" */
  action: string;
  lines: MoveLine[];
  /** The move should not be offered at all. */
  blocked: boolean;
}

/**
 * Everything the confirmation says, from the impact. `nameOf` names a matter
 * (or the serverspace, for null); `labelOf` names a person.
 */
export function moveWords(
  impact: MoveImpact,
  nameOf: (matterId: string) => string,
  labelOf: (userId: string) => string,
  serverspaceName: string,
): MoveWords {
  const name = nameOf(impact.matterId);
  const what = whatMoves(name, impact.descendantCount);
  const dest = impact.newParentId ? nameOf(impact.newParentId) : serverspaceName;
  const title = impact.newParentId ? `Move ${name} into ${dest}?` : `Move ${name} to the top of ${dest}?`;
  const action = impact.newParentId ? `Move into ${dest}` : `Move to the top of ${dest}`;
  const lines: MoveLine[] = [];

  if (impact.selfLoses) {
    lines.push({
      tone: 'warn',
      text: `You would lose access to ${name} yourself, and could not move it back. Ask an owner of ${serverspaceName} to move it.`,
    });
    return { title, action, lines, blocked: true };
  }

  // The seal first: it is the line that matters most.
  if (impact.sealedBefore && !impact.sealedAfter) {
    const from = impact.sealBeforeId ? nameOf(impact.sealBeforeId) : 'its SecureSpace';
    lines.push({
      tone: 'warn',
      text: `It will leave its SecureSpace (${from}): outside AI will be able to see ${what}.`,
    });
  } else if (!impact.sealedBefore && impact.sealedAfter) {
    const into = impact.sealAfterId ? nameOf(impact.sealAfterId) : 'a SecureSpace';
    lines.push({
      tone: 'seal',
      text: `It will be sealed inside the SecureSpace ${into}: no outside AI will be able to see it.`,
    });
  }

  const people = (c: PeopleChange, verb: string) => {
    if (c.userIds.length) {
      const n = c.userIds.length;
      const count = c.certain ? plural(n, 'person', 'people') : `Up to ${plural(n, 'person', 'people')}`;
      const on = joinNames(c.via.map(nameOf));
      lines.push({
        tone: 'plain',
        text: `${count} on ${on} ${verb} ${what}: ${namesList(c.userIds.map(labelOf))}.`,
      });
    }
    if (c.unreadable.length) {
      const on = joinNames(c.unreadable.map(nameOf));
      lines.push({
        tone: 'plain',
        text: `Anyone shared on ${on} ${verb} ${what}. That sharing list is not visible to you, so we can't say who.`,
      });
    }
  };
  people(impact.gain, 'will be able to see');
  people(impact.lose, 'will no longer see');

  const agents = (list: MoveAgent[], verb: string) => {
    if (!list.length) return;
    lines.push({
      tone: 'plain',
      text: `${plural(list.length, 'agent', 'agents')} (${joinNames(list.map((a) => a.label))}) ${verb}.`,
    });
  };
  agents(impact.agentsGain, 'will be able to see it');
  agents(impact.agentsLose, 'will no longer see it');
  if (impact.agentsUnknown) {
    lines.push({ tone: 'plain', text: 'Your agents could not be checked, so we can\'t say whether any of them will gain or lose sight of it.' });
  }

  if (!lines.length) {
    // Asked because something could not be ruled out, with nothing specific to say.
    lines.push({ tone: 'plain', text: `We could not fully check who can see ${what}, so we are asking before moving it.` });
  }

  return { title, action, lines, blocked: false };
}

/** The Undo toast's text. */
export function movedText(name: string, destName: string, toTop: boolean): string {
  return toTop ? `Moved ${name} to the top of ${destName}` : `Moved ${name} into ${destName}`;
}
