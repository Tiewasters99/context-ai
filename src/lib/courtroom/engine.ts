// The Courtroom — the trial state machine (spec §5) and deliberation
// protocol (spec §6). Deterministic scaffolding; the model appears only at
// judgment points (reactions, ballots, speech) through injected ports, so
// the eval harness can drive the whole machine with canned outputs.
//
//   EMPANEL → [SEGMENT → REACTIONS]+ → DELIBERATE → BALLOTS → REPORT
//
// Anti-flatness countermeasures (§6), all engine-enforced:
//   1. secret first ballot before any discussion;
//   2. jurors argue from their own private salience notes (recorded at
//      segment time, divergent by design);
//   3. structured turns — profile-selected foreman opens with the split,
//      speaking priority goes to jurors in conflict with the emerging
//      majority, every turn responds to a named prior speaker and must carry
//      a record cite;
//   4. re-ballot each round, conviction movement tracked juror-by-juror;
//   5. stop conditions: unanimity | two rounds without movement (hung) |
//      MAX_ROUNDS.

import type {
  Ballot, BallotReason, ConfusionPoint, CredibilityImpression,
  DeliberationResult, DeliberationTurn, EnginePorts, JurorProfile, Leaning,
  Reaction, RoundRecord, SalienceItem, Segment, SessionResult,
} from './types.ts';
import {
  BALLOT_SCHEMA, REACTION_SCHEMA, buildJurorPrompt, caseDigest, computeSplit,
  deliberationRecord, firstBallotTask, foremanTask, reactionTask, reballotTask,
  renderOwnReactions, speakerTask, JUROR_SYSTEM,
} from './prompts.ts';

export const MAX_ROUNDS = 5;
export const MAX_SPEAKERS_PER_ROUND = 4;

export interface EngineInput {
  trialTitle: string;
  jurors: JurorProfile[];
  segments: Segment[];
  maxRounds?: number;
}

/* ========================= Deterministic selectors ======================== */

const COMM_WEIGHT: Record<string, number> = {
  talkative: 1.0, blunt: 0.9, friendly: 0.8, reserved: 0.6,
};

/** Foreman = highest authority_orientation × communication weight (§6.3). */
export function chooseForeman(jurors: JurorProfile[]): JurorProfile {
  return [...jurors].sort((a, b) => {
    const score = (j: JurorProfile) =>
      j.reasoning.attitudes.authority_orientation * (COMM_WEIGHT[j.reasoning.communication] ?? 0.7);
    return score(b) - score(a) || a.seat - b.seat;
  })[0];
}

/** The leaning currently held by the most jurors ('undecided' never wins). */
export function emergingMajority(ballots: Ballot[]): Leaning {
  const split = computeSplit(ballots);
  return split.theirs > split.ours ? 'theirs' : 'ours';
}

/**
 * Speaking priority (§6.3): jurors whose ballot conflicts with the emerging
 * majority go first (strongest conviction first — they anchor disagreement),
 * then the most movable members of the majority (lowest conviction). The
 * foreman opened the round and does not re-take the floor.
 */
export function speakingOrder(
  jurors: JurorProfile[],
  ballots: Ballot[],
  foremanId: string,
  maxSpeakers: number = MAX_SPEAKERS_PER_ROUND,
): JurorProfile[] {
  const majority = emergingMajority(ballots);
  const ballotOf = new Map(ballots.map((b) => [b.juror_id, b]));
  const eligible = jurors.filter((j) => j.id !== foremanId);
  const conflicted = eligible.filter((j) => ballotOf.get(j.id)?.leaning !== majority);
  const aligned = eligible.filter((j) => ballotOf.get(j.id)?.leaning === majority);
  conflicted.sort((a, b) =>
    (ballotOf.get(b.id)?.conviction ?? 0) - (ballotOf.get(a.id)?.conviction ?? 0) ||
    (COMM_WEIGHT[b.reasoning.communication] ?? 0) - (COMM_WEIGHT[a.reasoning.communication] ?? 0) ||
    a.seat - b.seat,
  );
  aligned.sort((a, b) =>
    (ballotOf.get(a.id)?.conviction ?? 8) - (ballotOf.get(b.id)?.conviction ?? 8) ||
    a.seat - b.seat,
  );
  return [...conflicted, ...aligned].slice(0, maxSpeakers);
}

/** Movement metric (§6.4): Σ |Δconviction| + 2·(leaning changed). */
export function computeMovement(
  prev: Ballot[],
  next: Ballot[],
): { total: number; byJuror: Record<string, number> } {
  const prevOf = new Map(prev.map((b) => [b.juror_id, b]));
  const byJuror: Record<string, number> = {};
  let total = 0;
  for (const b of next) {
    const p = prevOf.get(b.juror_id);
    if (!p) continue;
    const m = Math.abs(b.conviction - p.conviction) + (b.leaning !== p.leaning ? 2 : 0);
    byJuror[b.juror_id] = m;
    total += m;
  }
  return { total, byJuror };
}

export function isUnanimous(ballots: Ballot[]): boolean {
  if (ballots.length === 0) return false;
  const first = ballots[0].leaning;
  return first !== 'undecided' && ballots.every((b) => b.leaning === first);
}

/* ============================ Output guards =============================== */

// The ports return model output; normalize it so one malformed field never
// crashes a session (a juror turn must never silently vanish — spec §7).

function clamp17(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 4;
  return Math.max(1, Math.min(7, v));
}

function asLeaning(v: unknown): Leaning {
  return v === 'ours' || v === 'theirs' || v === 'undecided' ? v : 'undecided';
}

function normalizeBallot(jurorId: string, round: number, raw: unknown): Ballot {
  const r = (raw ?? {}) as Record<string, unknown>;
  const reasons = Array.isArray(r.reasons) ? (r.reasons as BallotReason[]) : [];
  return {
    juror_id: jurorId,
    round,
    leaning: asLeaning(r.leaning),
    conviction: clamp17(r.conviction),
    reasons: reasons.slice(0, 3).map((x) => ({
      reason: String(x?.reason ?? ''),
      quote: String(x?.quote ?? ''),
      locator: String(x?.locator ?? ''),
    })),
  };
}

function normalizeReaction(jurorId: string, segmentId: string, raw: unknown): Reaction {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    juror_id: jurorId,
    segment_id: segmentId,
    salience: (Array.isArray(r.salience) ? r.salience : []) as SalienceItem[],
    confusions: (Array.isArray(r.confusions) ? r.confusions : []) as ConfusionPoint[],
    credibility: (Array.isArray(r.credibility) ? r.credibility : []) as CredibilityImpression[],
    gut: String(r.gut ?? ''),
  };
}

/* ============================== The session =============================== */

export async function runSession(input: EngineInput, ports: EnginePorts): Promise<SessionResult> {
  const { trialTitle, jurors, segments } = input;
  const maxRounds = input.maxRounds ?? MAX_ROUNDS;
  const digest = caseDigest(trialTitle, segments);
  const ordered = [...segments].sort((a, b) => a.position - b.position);

  /* ---- Phase 1: per-segment private reactions, every juror (§5). ---- */
  const reactions: Reaction[] = [];
  const reactionsByJuror = new Map<string, Reaction[]>();
  for (const seg of ordered) {
    for (const juror of jurors) {
      ports.onProgress?.({
        stage: 'reactions',
        detail: `${juror.display_name} (seat ${juror.seat}) is reacting to Seg ${seg.position + 1} (${seg.kind})`,
        seat: juror.seat,
      });
      const raw = await ports.structured<unknown>({
        stage: 'reaction',
        jurorId: juror.id,
        system: JUROR_SYSTEM,
        prompt: buildJurorPrompt(digest, juror, reactionTask(seg)),
        toolName: 'record_reaction',
        toolDescription: 'Record this juror\'s private structured reaction to the segment just heard.',
        schema: REACTION_SCHEMA,
        maxTokens: 2048,
      });
      const reaction = normalizeReaction(juror.id, seg.id, raw);
      reactions.push(reaction);
      const mine = reactionsByJuror.get(juror.id) ?? [];
      mine.push(reaction);
      reactionsByJuror.set(juror.id, mine);
      await ports.saveReaction?.(reaction);
    }
  }

  const notesOf = (j: JurorProfile) => renderOwnReactions(reactionsByJuror.get(j.id) ?? []);

  /* ---- Phase 2: secret first ballot, before any discussion (§6.1). ---- */
  const castBallots = async (round: number, task: string, turnsSoFar: DeliberationTurn[]) => {
    const shared = digest + deliberationRecord(turnsSoFar);
    const ballots: Ballot[] = [];
    for (const juror of jurors) {
      ports.onProgress?.({
        stage: round === 0 ? 'first_ballot' : 'reballot',
        detail: `${juror.display_name} (seat ${juror.seat}) is casting a ballot`,
        seat: juror.seat,
        round,
      });
      const raw = await ports.structured<unknown>({
        stage: round === 0 ? 'first_ballot' : 'reballot',
        jurorId: juror.id,
        system: JUROR_SYSTEM,
        prompt: buildJurorPrompt(shared, juror, notesOf(juror) + '\n\n' + task),
        toolName: 'cast_ballot',
        toolDescription: 'Cast this juror\'s ballot: leaning, conviction 1-7, and three record-cited reasons.',
        schema: BALLOT_SCHEMA,
        maxTokens: 1024,
      });
      const ballot = normalizeBallot(juror.id, round, raw);
      ballots.push(ballot);
      await ports.saveBallot?.(ballot);
    }
    return ballots;
  };

  const firstBallots = await castBallots(0, firstBallotTask(), []);

  /* ---- Phase 3: structured deliberation rounds (§6). ---- */
  const foreman = chooseForeman(jurors);
  const allTurns: DeliberationTurn[] = [];
  const rounds: RoundRecord[] = [];
  const movementByJuror: Record<string, number> = {};
  let prevBallots = firstBallots;
  let zeroMovementStreak = 0;
  let stop: DeliberationResult['stop_reason'] = 'max_rounds';

  for (let round = 1; round <= maxRounds; round++) {
    const roundTurns: DeliberationTurn[] = [];
    const speak = async (
      juror: JurorProfile,
      role: 'foreman' | 'speaker',
      respondingTo: string | null,
      task: string,
    ) => {
      ports.onProgress?.({
        stage: 'deliberation',
        detail: `${juror.display_name} (seat ${juror.seat}) has the floor`,
        seat: juror.seat,
        round,
      });
      const shared = digest + deliberationRecord([...allTurns, ...roundTurns]);
      const speech = await ports.speech({
        stage: role === 'foreman' ? 'foreman' : 'deliberation',
        jurorId: juror.id,
        system: JUROR_SYSTEM,
        prompt: buildJurorPrompt(shared, juror, notesOf(juror) + '\n\n' + task),
        maxTokens: 700,
      });
      const turn: DeliberationTurn = {
        round, juror_id: juror.id, seat: juror.seat, role,
        responding_to: respondingTo, speech: speech.trim(),
      };
      roundTurns.push(turn);
      await ports.saveTurn?.(turn);
      return turn;
    };

    // Foreman opens with the split (never argues in the opening).
    await speak(foreman, 'foreman', null, foremanTask(computeSplit(prevBallots), round));

    // Conflict-first speaking order; each turn answers the previous speaker.
    let lastSpeakerName = `${foreman.display_name} (the foreman)`;
    for (const juror of speakingOrder(jurors, prevBallots, foreman.id)) {
      await speak(juror, 'speaker', lastSpeakerName, speakerTask(lastSpeakerName, round));
      lastSpeakerName = juror.display_name;
    }

    allTurns.push(...roundTurns);

    // Re-ballot everyone; track movement.
    const ballots = await castBallots(round, reballotTask(round), allTurns);
    const movement = computeMovement(prevBallots, ballots);
    for (const [id, m] of Object.entries(movement.byJuror)) {
      movementByJuror[id] = (movementByJuror[id] ?? 0) + m;
    }
    rounds.push({ round, turns: roundTurns, ballots, movement: movement.total });
    prevBallots = ballots;

    if (isUnanimous(ballots)) { stop = 'unanimous'; break; }
    zeroMovementStreak = movement.total === 0 ? zeroMovementStreak + 1 : 0;
    if (zeroMovementStreak >= 2) { stop = 'hung'; break; }
  }

  const totalMovement = Object.values(movementByJuror).reduce((s, m) => s + m, 0);

  return {
    reactions,
    deliberation: {
      firstBallots,
      rounds,
      stop_reason: stop,
      movement_by_juror: movementByJuror,
      total_movement: totalMovement,
      foreman_juror_id: foreman.id,
    },
  };
}

/**
 * Runtime flatness check (§6.6): flat deliberation is a defect, not a result.
 * The UI surfaces this on the report; the eval harness fails the build on it.
 */
export function flatnessAlarm(result: SessionResult): string | null {
  const d = result.deliberation;
  if (isUnanimous(d.firstBallots)) {
    return 'Round-0 ballots were unanimous before any discussion — deliberation had nothing to do.';
  }
  if (d.total_movement === 0) {
    return 'Zero conviction movement across all rounds — the panel never genuinely engaged.';
  }
  return null;
}
