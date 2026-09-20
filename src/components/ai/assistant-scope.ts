// What the Assistant panel SAYS about where it is and who will answer.
//
// The panel used to say nothing until after the first reply: a lawyer standing
// in a sealed matter saw an ordinary chat box, and only learned which matter it
// was scoped to, that the matter was sealed, and which model had answered once
// an answer had already been produced. Every sentence below is therefore meant
// to be readable BEFORE the first message.
//
// Pure on purpose — no React, no supabase, no `import.meta.env`. The facts are
// read elsewhere (useMatterAiState) under the user's own RLS; this file only
// decides what may be said about them, so the wording is testable offline
// (scripts/_test-sealed-assistant-scope.mjs).
//
// Two rules govern everything here:
//
//   1. THE SERVER IS THE AUTHORITY. Whatever the browser predicts, the pen is
//      chosen server-side from the matter's tier (lib/ai-tier-policy.mjs,
//      lib/assistant-core.mjs). When the stream's `session` event names a
//      different pen than we predicted, the strip adopts the server's answer
//      and says so. It never argues, and it never keeps the prediction up.
//   2. AN UNKNOWN FACT IS NOT A CLAIM. A tier we could not read is rendered as
//      the matter's name and nothing else — never as "not sealed", which is
//      exactly the silence this change exists to end.

import type { AssistantCommand } from '@/lib/assistant-bus';

export type AiTier = 'A' | 'B' | 'C';

/** The pen the server reports in its `session` event. */
export interface LivePen {
  tier?: string;
  provider?: string;
  model?: string;
}

/** Everything the strip is allowed to know. */
export interface ScopeFacts {
  name?: string;
  /** `null` = unknown: not read yet, unreadable, or migration 051 absent. */
  tier?: AiTier | null;
  paused?: boolean;
  /** aiPausedSentence() from src/lib/ai-pause.ts — passed in, never imported. */
  pausedSentence?: string;
  livePen?: LivePen | null;
}

// ─── The sentences ────────────────────────────────────────────────────────

/**
 * The sealed pen, named. The product's own label for it lives in `PENS` in
 * lib/assistant-core.mjs — "Kimi K2.5 (Bedrock, our AWS account, zero
 * retention)". It is NOT Claude: AWS gates the Claude 5 generation for this
 * account, and the 2026-09-19 audit is explicit that the claim to make is a
 * zero-retention model in the firm's own AWS account.
 */
export const SEALED_PEN_DEFAULT_LABEL = 'Kimi K2.5';

export function sealedPenSentence(label: string = SEALED_PEN_DEFAULT_LABEL): string {
  return `Answers come from the sealed model — ${label} in the firm's own AWS account. Zero data retention. Nothing reaches an outside provider.`;
}

/** Tier A, the unsealed default (PENS.anthropic). */
export const OPEN_PEN_DEFAULT_LABEL = 'Claude Opus 4.8';

export function openPenSentence(label: string = OPEN_PEN_DEFAULT_LABEL): string {
  return `Answers come from ${label}. This matter is not sealed.`;
}

/**
 * Tier C, in the words the product already uses for it
 * (PEN_BY_TIER.C.detail, src/lib/agent-charters.ts).
 */
export const SILO_SENTENCE =
  'No cloud model answers inside this matter. Tier C — Silo. Runs are refused until the Silo appliance is connected.';

/**
 * The one thing worth knowing before typing into a sealed matter. Sealed
 * matters carry no embeddings (TIER_ROUTES.B, lib/embed-routes.mjs), so the
 * assistant's `search` falls back to Postgres full-text: it matches words, not
 * meaning. Saying so is the difference between a useful answer and a shrug.
 */
export const SEALED_SEARCH_NOTE =
  'Inside a sealed matter the assistant finds passages by their words, not by meaning — use the document’s own terms.';

/** The strip after "clear" on a scope the page put there. */
export function unscopedStripText(name?: string): string {
  return name
    ? `Asking without a matter — not scoped to ${name}.`
    : 'Asking without a matter.';
}

// ─── Starter prompts ──────────────────────────────────────────────────────

export interface Starter {
  /** What the button reads. */
  label: string;
  /** What lands in the conversation, or in the input when `select` is set. */
  text: string;
  /** A span of `text` to select so the user types over it. */
  select?: [number, number];
}

// A blank the user fills: the panel puts the sentence in the input and selects
// the placeholder rather than sending a question about the word "term".
const TERM_PREFIX = 'Find where the word “';
const TERM_SLOT = 'term';
const TERM_SUFFIX = '” appears and quote the passages with page numbers.';

/**
 * Three openings for a sealed matter. Generic to any litigation matter, and
 * written for word search: each one either needs no search at all, or hands
 * the search a literal string. No claim about what the model is good at.
 */
export const SEALED_STARTERS: Starter[] = [
  {
    label: 'List the documents in this matter and what each one is.',
    text: 'List the documents in this matter and what each one is.',
  },
  {
    label: `${TERM_PREFIX}…${TERM_SUFFIX}`,
    text: `${TERM_PREFIX}${TERM_SLOT}${TERM_SUFFIX}`,
    select: [TERM_PREFIX.length, TERM_PREFIX.length + TERM_SLOT.length],
  },
  {
    label: 'Summarize the most recent order in this matter, with page cites.',
    text: 'Summarize the most recent order in this matter, with page cites.',
  },
];

// ─── The pen's name ───────────────────────────────────────────────────────

/**
 * Friendly pen names — an EXACT map from the model ids `PENS`
 * (lib/assistant-core.mjs) actually emits. Anything else is shown as itself,
 * which is what the old substring matcher only claimed to do.
 *
 * The bug this replaces: `model.includes('kimi') → 'Kimi K3'` dates from when
 * the Tier-B fallback was Kimi K3 on Fireworks — a pen PR #159 deleted. The
 * sealed pen is `moonshotai.kimi-k2.5`, so every sealed answer was labelled
 * with the name of a different model on a different host. A version guessed
 * from a substring is a guess; this map is not, and an id it does not know is
 * printed rather than approximated.
 *
 * BETTER STILL, and not done here: the server already knows the pretty name —
 * `PENS.*.label`. The `session` event carries `{tier, provider, model}` and no
 * label (lib/assistant-core.mjs:649). Adding `label: pen.label` there is one
 * line, and then this map becomes a fallback for old streams instead of a
 * second place where a model gets named. That line is a server edit and is
 * left for the lane that owns lib/.
 */
const PEN_NAMES: Record<string, string> = {
  'moonshotai.kimi-k2.5': 'Kimi K2.5',
  'anthropic.claude-opus-5': 'Opus 5',
  'claude-opus-5': 'Opus 5',
  'anthropic.claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-8': 'Opus 4.8',
};

export function penLabel(model: string): string {
  const id = (model ?? '').trim();
  return PEN_NAMES[id] ?? id;
}

/** B and C are both "sealed" to the user: content stays inside. */
export function isSealedTier(tier: AiTier | null | undefined): boolean {
  return tier === 'B' || tier === 'C';
}

// ─── The description the panel renders ────────────────────────────────────

export interface ScopeDescription {
  /** Does the strip get the sealed treatment? */
  sealed: boolean;
  /** Is the tier still unknown — say the name, claim nothing. */
  unknown: boolean;
  /** Strip line 1, split so the name can be emphasised. */
  lead: string;
  name: string;
  tail: string;
  /** Strip line 2: who will answer (or, after a reply, who did). */
  penNote: string;
  /** The header's one-word pen name; empty while it is not known. */
  penChip: string;
  /** The server's answer differed from the prediction — keep line 2 up. */
  corrected: boolean;
  /**
   * The server named a pen where the strip had predicted nothing. Worth
   * showing — it is the first time the panel can say who answered — but it is
   * NOT a correction: nothing was claimed, so nothing was wrong.
   */
  named: boolean;
  paused: boolean;
  /** Shown in place of the input when AI is paused on this matter. */
  pauseNote: string;
  /** Empty unless the scope is sealed. */
  searchNote: string;
  starters: Starter[];
}

/**
 * Everything the strip says about a matter the panel is bound to — by a
 * command, or simply by being on the matter's page.
 */
export function describeScope(facts: ScopeFacts): ScopeDescription {
  const name = facts.name?.trim() || 'this matter';
  const live = facts.livePen?.model ? facts.livePen : null;

  // The server's word wins outright once it has spoken.
  const predictedSealed = isSealedTier(facts.tier);
  const liveSealed = live ? (live.tier ?? 'A') !== 'A' : null;
  const sealed = liveSealed ?? predictedSealed;
  const unknown = !live && (facts.tier === null || facts.tier === undefined);

  let penNote = '';
  let penChip = '';
  if (live) {
    const label = penLabel(live.model ?? '');
    penChip = label;
    if (liveSealed) {
      // Only the Bedrock pen carries the seal's claim. If the server ever
      // answers a sealed matter from somewhere else, say which somewhere —
      // do not lend it the sentence about our own AWS account.
      penNote = live.provider === 'aws-bedrock'
        ? sealedPenSentence(label)
        : `Answered by ${label} (${live.provider ?? 'an unnamed provider'}).`;
    } else {
      penNote = openPenSentence(label);
    }
  } else if (facts.tier === 'B') {
    penNote = sealedPenSentence();
    penChip = SEALED_PEN_DEFAULT_LABEL;
  } else if (facts.tier === 'C') {
    penNote = SILO_SENTENCE;
    penChip = '';
  } else if (facts.tier === 'A') {
    penNote = openPenSentence();
    penChip = 'Opus 4.8';
  }

  // Did the first reply contradict what the strip promised? Both the seal and
  // the model's name count: a sealed matter answered by another pen, or the
  // same tier answered by a different model, are each worth a visible line.
  //
  // A PREDICTION IS A PREREQUISITE. Where the tier could not be read the strip
  // said only the matter's name, so a sealed first reply is news, not a
  // correction — calling it one would invent a claim the panel never made.
  const predicted = facts.tier === 'A' || facts.tier === 'B' || facts.tier === 'C';
  const predictedChip = facts.tier === 'B'
    ? SEALED_PEN_DEFAULT_LABEL
    : facts.tier === 'A' ? 'Opus 4.8' : '';
  const corrected = Boolean(
    live && predicted && (liveSealed !== predictedSealed || predictedChip !== penChip),
  );
  const named = Boolean(live) && !predicted;

  return {
    sealed,
    unknown,
    lead: sealed ? 'Sealed room — ' : 'In ',
    name,
    tail: sealed ? ' · no training · zero data retention' : '',
    penNote,
    penChip,
    corrected,
    named,
    paused: Boolean(facts.paused),
    pauseNote: facts.paused
      ? (facts.pausedSentence?.trim() || 'AI is paused on this matter. Nothing is being sent to any model.')
      : '',
    searchNote: sealed ? SEALED_SEARCH_NOTE : '',
    starters: sealed ? SEALED_STARTERS : [],
  };
}

// ─── The door on the matter page ──────────────────────────────────────────

/** What the matter header's button reads. */
export function askAssistantLabel(sealed: boolean): string {
  return sealed ? 'Ask the sealed assistant' : 'Ask the assistant';
}

/**
 * The command the door dispatches. `sealed` is a display hint only — the
 * server reads the tier from the database whatever this says — but it lets the
 * panel show the sealed strip on the first frame instead of after the first
 * answer.
 */
export function askAssistantCommand(matter: {
  id: string;
  name: string;
  sealed: boolean;
}): AssistantCommand {
  return { matterId: matter.id, matterName: matter.name, sealed: matter.sealed };
}
