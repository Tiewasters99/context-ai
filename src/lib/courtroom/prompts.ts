// The Courtroom — prompt construction (spec §2 rails baked in).
//
// Prompt-cache architecture (spec §7): every juror call is ordered
//
//     [system: shared juror instructions]
//     [user:   shared case digest + transcript-so-far]   ← identical across
//              --- CACHE BOUNDARY ---                       all 12 jurors
//     [user:   juror persona][task]                      ← per-juror suffix
//
// so twelve juror calls share one cacheable prefix and deliberation appends
// to it. The llm layer doesn't expose explicit cache_control breakpoints;
// this ordering makes provider-side prefix caching land on its own.
//
// THE RAIL, IN TEXT: a juror's persona block renders ONLY the reasoning
// layer. Composition (age/gender/race/education) never enters any prompt.
// The system prompt additionally forbids demographic self-reference —
// "as a [demographic], I ..." is defined as a malfunction, and the eval
// harness regex-scans prompts and outputs for exactly that shape.

import type {
  Ballot, DeliberationTurn, JurorProfile, Reaction, Segment,
} from './types.ts';

/* ========================== Exported constants ============================ */

/** Visible in the UI and printed on every report (spec §2.2). */
export const NOT_FOR_JURY_SELECTION =
  'The Courtroom is a rehearsal instrument for your argument. It is not a jury-selection tool: ' +
  'it performs no voir dire simulation, no juror scoring, no strike recommendations, and no ' +
  'matching against real venire members.';

/** The §9 standing calibration block, verbatim. */
export const CALIBRATION_DISCLAIMER =
  'AI panels are a rehearsal instrument. Peer-reviewed comparisons show LLM jurors apply ' +
  'materially different decision thresholds than human juries (e.g., 21% vs. 49% conviction on ' +
  'identical facts). Read reactions and reasoning as directional feedback on the argument — ' +
  'never as a verdict prediction.';

/** Marks the shared-prefix / per-juror-suffix seam inside the user prompt. */
export const CACHE_BOUNDARY = '\n======== END OF SHARED RECORD ========\n';

/* ======================= Transcript locators (cites) ====================== */

/** "Seg 2 (cross, theirs)" — the transcript-anchored locator stem. */
export function segmentLabel(seg: Segment): string {
  return `Seg ${seg.position + 1} (${seg.kind}, ${seg.side})`;
}

/** Split a transcript into numbered paragraphs for stable ¶-locators. */
export function paragraphize(transcript: string): string[] {
  return transcript
    .split(/\n\s*\n|\n(?=\S)/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
}

function renderSegment(seg: Segment): string {
  const paras = paragraphize(seg.transcript);
  const body = paras.map((p, i) => `¶${i + 1} ${p}`).join('\n');
  return `[${segmentLabel(seg)}]\n${body}`;
}

/* ========================= Shared prefix builders ========================= */

/** The shared case digest + transcript-so-far. Identical for every juror. */
export function caseDigest(trialTitle: string, segments: Segment[]): string {
  const ordered = [...segments].sort((a, b) => a.position - b.position);
  return [
    `REHEARSAL RECORD — ${trialTitle}`,
    '',
    'What follows is the courtroom record you have heard so far, presented segment by',
    'segment. "ours" marks counsel presenting to you; "theirs" marks the opposing side',
    '(counsel may perform both). Cite this record by locator, e.g. "Seg 1 ¶3".',
    '',
    ordered.map(renderSegment).join('\n\n'),
  ].join('\n');
}

/** Deliberation-so-far appended to the shared prefix (still shared). */
export function deliberationRecord(turns: DeliberationTurn[]): string {
  if (turns.length === 0) return '';
  const lines = turns.map((t) => {
    const who = t.role === 'foreman' ? `FOREMAN (seat ${t.seat})` : `JUROR seat ${t.seat}`;
    return `${who} [round ${t.round}]: ${t.speech}`;
  });
  return ['', 'DELIBERATION SO FAR:', ...lines].join('\n');
}

/* ============================ System prompt =============================== */

/**
 * Shared across all jurors (cacheable). The rails live here: record-cited
 * reasoning only, no demographic self-reference, no verdict-prediction
 * framing — the juror decides as this one person, not as a statistic.
 */
export const JUROR_SYSTEM = [
  'You are one juror on a mock civil jury inside a rehearsal exercise for the lawyer',
  'presenting the case. You are not an assistant here; you are this one particular person,',
  'sitting in this box, with your own working life, your own history, and your own way of',
  'weighing what you hear. React the way you actually would — including boredom, irritation,',
  'confusion, and being unpersuaded. Flattery of counsel is a failure of the exercise.',
  '',
  'Non-negotiable rules of the exercise:',
  '1. GROUND EVERYTHING IN THE RECORD. Every reaction, reason, and argument you give must',
  '   cite the record: a short verbatim quote plus its locator (e.g. "Seg 2 ¶4"). If you',
  '   cannot point to the moment, you cannot use it.',
  '2. YOUR REASONS COME FROM YOUR LIFE AND THE RECORD — your work, your experiences, and',
  '   what was actually said. Never explain your view by reference to your demographic',
  '   category: a sentence shaped like "as a [demographic], I ..." is a malfunction of the',
  '   simulation, not a reason. Speaking from a lived experience ("when I got sued, nobody',
  '   explained the process to me either") is exactly right.',
  '3. STAY IN THE BOX. You know only what the record contains. Do not invent evidence,',
  '   outside law, or facts about the parties beyond the record.',
  '4. DISAGREEMENT IS THE POINT. If the record does not persuade you, say so and say why.',
  '   Do not drift toward the group; hold your view until an argument grounded in the',
  '   record actually moves you.',
].join('\n');

/* ============================ Persona rendering =========================== */

const ATTITUDE_LABELS: Record<string, [string, string]> = {
  // key: [low-end description, high-end description]
  institutional_trust: ['deeply skeptical of institutions', 'trusts institutions to mostly work'],
  claims_consciousness: ['thinks people sue too much', 'thinks people with real grievances should press them'],
  authority_orientation: ['chafes at authority', 'defers to rules and the judge\'s framing'],
  risk_tolerance: ['cautious, hates uncertainty', 'comfortable with risk and rough edges'],
  corporate_skepticism: ['gives companies the benefit of the doubt', 'assumes companies cut corners'],
  personal_responsibility_ethic: ['looks first at circumstances', 'looks first at what each person chose to do'],
};

function attitudeLine(key: string, value: number): string {
  const [low, high] = ATTITUDE_LABELS[key];
  const stance = value <= 2 ? low : value >= 6 ? high : `between the poles (${low} vs. ${high})`;
  return `- ${key.replace(/_/g, ' ')}: ${value}/7 — ${stance}`;
}

/**
 * Renders ONLY the reasoning layer + voice. Composition demographics are
 * deliberately absent — that is the §2.3 rail, enforced structurally.
 */
export function personaBlock(j: JurorProfile): string {
  const a = j.reasoning.attitudes;
  return [
    `YOU ARE: ${j.display_name}, seat ${j.seat}.`,
    `Work: ${j.reasoning.occupation_detail}.`,
    `Life: ${j.reasoning.life_experiences.join('; ')}.`,
    `Backstory: ${j.voice.backstory}`,
    `How you speak: ${j.voice.register}.`,
    `How you decide (private self-knowledge, never quoted aloud):`,
    ...Object.entries(a).map(([k, v]) => attitudeLine(k, v)),
    `- cognitive style: ${j.reasoning.cognitive_style}; communication: ${j.reasoning.communication}; what sticks with you: ${j.reasoning.salience_bias}.`,
  ].join('\n');
}

/** [shared prefix][CACHE_BOUNDARY][persona][task] — the one assembly point. */
export function buildJurorPrompt(sharedPrefix: string, juror: JurorProfile, task: string): string {
  return sharedPrefix + CACHE_BOUNDARY + personaBlock(juror) + '\n\n' + task;
}

/* ============================== Task blocks =============================== */

export function reactionTask(seg: Segment): string {
  return [
    `TASK — PRIVATE REACTION to ${segmentLabel(seg)}.`,
    'You have just heard this segment. Privately record, for your own notes (no other juror',
    'sees this):',
    '- salience: the 3-5 moments that stuck with you, each with the verbatim quote, its',
    '  locator, and one sentence on why it stuck for YOU in particular;',
    '- confusions: anything you did not follow or that raised a question nobody answered,',
    '  with the locator of where you got lost (empty list if nothing);',
    '- credibility: your impression of anyone whose words or conduct this segment put in',
    '  front of you — counsel included (empty list if no impression formed);',
    '- gut: one blunt sentence, in your own voice, on where you stand right now.',
  ].join('\n');
}

/** JSON Schema for a structured reaction. */
export const REACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    salience: {
      type: 'array', minItems: 3, maxItems: 5,
      items: {
        type: 'object',
        properties: {
          moment: { type: 'string', description: 'What happened, in your words' },
          quote: { type: 'string', description: 'Short verbatim quote from the record' },
          locator: { type: 'string', description: 'e.g. "Seg 1 ¶3"' },
          why_it_stuck: { type: 'string' },
        },
        required: ['moment', 'quote', 'locator', 'why_it_stuck'],
      },
    },
    confusions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { point: { type: 'string' }, locator: { type: 'string' } },
        required: ['point', 'locator'],
      },
    },
    credibility: {
      type: 'array',
      items: {
        type: 'object',
        properties: { subject: { type: 'string' }, impression: { type: 'string' } },
        required: ['subject', 'impression'],
      },
    },
    gut: { type: 'string' },
  },
  required: ['salience', 'confusions', 'credibility', 'gut'],
};

export function firstBallotTask(): string {
  return [
    'TASK — SECRET FIRST BALLOT.',
    'Deliberation has not begun. No juror has spoken. Cast your private ballot on the case',
    'as presented: your leaning ("ours" = the presenting side has the better of it so far,',
    '"theirs" = the opposing side does, "undecided" if you genuinely cannot lean), your',
    'conviction from 1 (barely) to 7 (immovable), and exactly three reasons — each grounded',
    'in a verbatim quote from the record with its locator. Vote your honest read, not the',
    'verdict you suspect is wanted.',
  ].join('\n');
}

export function reballotTask(round: number): string {
  return [
    `TASK — BALLOT, ROUND ${round}.`,
    'Considering the record AND the deliberation so far: cast your ballot again. Change',
    'your leaning or conviction ONLY if something a fellow juror grounded in the record',
    'actually moved you — and if it did, one of your three reasons should cite the moment',
    'they pointed to. Digging in is legitimate; drifting with the room is not.',
  ].join('\n');
}

/** JSON Schema for a structured ballot. */
export const BALLOT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    leaning: { type: 'string', enum: ['ours', 'theirs', 'undecided'] },
    conviction: { type: 'integer', minimum: 1, maximum: 7 },
    reasons: {
      type: 'array', minItems: 3, maxItems: 3,
      items: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
          quote: { type: 'string' },
          locator: { type: 'string' },
        },
        required: ['reason', 'quote', 'locator'],
      },
    },
  },
  required: ['leaning', 'conviction', 'reasons'],
};

/* ========================= Deliberation speech ============================ */

export interface BallotSplit {
  ours: number;
  theirs: number;
  undecided: number;
}

export function foremanTask(split: BallotSplit, round: number): string {
  return [
    `TASK — OPEN ROUND ${round} AS FOREMAN.`,
    `The secret ballot stands at: ${split.ours} for the presenting side, ${split.theirs} for the`,
    `opposing side, ${split.undecided} undecided. You were chosen foreman. In 3-6 sentences, in`,
    'your own voice: state the split, name the one or two record moments the room most needs',
    'to talk through (verbatim quote + locator each), and invite whoever disagrees with the',
    'majority to go first. Do not argue your own view yet.',
  ].join('\n');
}

export function speakerTask(respondingTo: string, round: number): string {
  return [
    `TASK — SPEAK IN ROUND ${round}.`,
    `Respond to ${respondingTo} by name. In 3-7 sentences, in your own voice: engage what`,
    'they actually said, then make your point. Your turn MUST contain at least one verbatim',
    'record quote with its locator ("Seg 2 ¶4") — that is the price of the floor. Speak from',
    'your own experience and the record; do not summarize the group.',
  ].join('\n');
}

/* ===================== Report synthesis (prose only) ====================== */

export const REPORT_SYSTEM = [
  'You are drafting sections of a Rehearsal Report for the lawyer who just performed before',
  'a mock AI jury panel. Voice: a candid senior colleague writing an internal memo — plain,',
  'specific, useful tomorrow morning. Every claim about the evidence must keep the record',
  'cite it arrives with. Never attribute a juror\'s reasoning to a demographic category;',
  'jurors are identified by seat, name, occupation, and attitude cluster only. Never predict',
  'a verdict or estimate win probability.',
].join('\n');

/**
 * One short synthesis paragraph per report section; the numbers and lists
 * around it are computed deterministically in report.ts (deterministic first,
 * model only at the judgment point).
 */
export function reportSynthesisTask(
  section: 'what_landed' | 'what_confused' | 'pushback',
  dataDigest: string,
): string {
  const intro: Record<typeof section, string> = {
    what_landed:
      'Below is the aggregated salience data (moments ranked by how many jurors flagged them, with cites and the flagging seats). Write ONE tight paragraph (3-5 sentences) telling counsel what actually landed and why it worked, keyed to the cites.',
    what_confused:
      'Below are the confusion points jurors recorded, with transcript locations. Write ONE tight paragraph (3-5 sentences) telling counsel what confused this panel and which sentence to rewrite first, keyed to the cites.',
    pushback:
      'Below are the panel\'s resistance points grouped by attitude cluster, quoted in the jurors\' own words. Write ONE tight paragraph (3-5 sentences) mapping where the resistance lives and what it responds to. Refer to clusters by their attitude labels only.',
  };
  return [intro[section], '', dataDigest].join('\n');
}

/* ============================ Small helpers =============================== */

export function computeSplit(ballots: Ballot[]): BallotSplit {
  const split: BallotSplit = { ours: 0, theirs: 0, undecided: 0 };
  for (const b of ballots) split[b.leaning] += 1;
  return split;
}

/** Render a reaction back into the juror's own private-notes context. */
export function renderOwnReactions(reactions: Reaction[]): string {
  if (reactions.length === 0) return '';
  const lines: string[] = ['', 'YOUR PRIVATE NOTES FROM THE SESSION (yours alone):'];
  for (const r of reactions) {
    for (const s of r.salience) lines.push(`- [${s.locator}] "${s.quote}" — ${s.why_it_stuck}`);
    for (const c of r.confusions) lines.push(`- confused at [${c.locator}]: ${c.point}`);
    if (r.gut) lines.push(`- gut: ${r.gut}`);
  }
  return lines.join('\n');
}
