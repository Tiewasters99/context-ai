// The Courtroom — adversarial procedure (spec §5, Phase 2).
//
//   {OBJECTION → RULING → STRIKE}  +  leakage measurement  +  Twin Panel delta
//
// Deterministic first (house rule): span NOMINATION, leakage DETECTION, and
// the twin DELTA are pure code. The model appears at exactly two judgment
// points — the opposing-counsel agent deciding whether to stand (and on what
// ground), and the judge ruling — both through the same ports seam the
// engine uses, so the eval drives the whole procedure with canned outputs.
//
// The signature mechanic: a SUSTAINED objection does not clean the record.
// Jurors heard the words; the transcript keeps them, flagged with the judge's
// disregard instruction (prompts.ts renders the flag). Deliberation then
// measures LEAKAGE — does the stricken moment resurface, does anyone police
// it, does it survive into final ballots — and the opt-in Twin Panel runs the
// same jurors against a record that never contained the material at all, so
// the report can price the moment the objection couldn't cure.

import type {
  Ballot, CandidateSpan, DeliberationResult, DeliberationTurn, EnginePorts,
  JurorProfile, LeakageFinding, LeakageSighting, Objection, ObjectionGround,
  Ruling, Segment, Strike, TwinDeltaRow, TwinResult,
} from './types.ts';
import {
  OBJECTION_SCHEMA, RULING_SCHEMA, JUDGE_SYSTEM, OPPOSING_SYSTEM,
  judgeTask, opposingTask, paragraphize, segmentLabel,
} from './prompts.ts';

export const MAX_OBJECTIONS_PER_SEGMENT = 2;
export const MAX_CANDIDATES_PER_SEGMENT = 4;

/* ======================= Deterministic span nomination ==================== */

// Pattern sets are deliberately coarse: nomination only puts a ¶ in front of
// the opposing-counsel agent, which decides whether an objection is actually
// worth standing for. Order = precedence when one ¶ matches several tags.

const NOMINATION_PATTERNS: [ObjectionGround, RegExp][] = [
  // Quoted out-of-court statements offered through counsel's mouth.
  ['hearsay', /(?:\bquote\b|["“][^"”]{8,}["”]|\bwrote\b|\bsaid\b|\btestified\b|\btold\b)/i],
  // Counsel asserting what someone knew, wanted, intended, believed.
  ['speculation', /\b(?:knew|intended|wanted|believed|thought|decided|realized|felt)\b/i],
  // Argumentative characterization dressed as fact.
  ['characterization', /\b(?:clearly|obviously|plainly|monopolist|scheme|ambush|greed|goug\w+|bull\w+|lie[ds]?|lying|cheat\w*|shopping for a lawsuit|bet that went bad)\b/i],
  // Naked appeals to sympathy/outrage untethered from an exhibit.
  ['prejudice', /\b(?:punish|outrage\w*|send a message|imagine if|no one is safe)\b/i],
];

/** Nominate up to MAX_CANDIDATES_PER_SEGMENT ¶-spans of one `ours` segment. */
export function nominateSpans(segment: Segment): CandidateSpan[] {
  const out: CandidateSpan[] = [];
  const paras = paragraphize(segment.transcript);
  for (let i = 0; i < paras.length && out.length < MAX_CANDIDATES_PER_SEGMENT; i++) {
    for (const [tag, re] of NOMINATION_PATTERNS) {
      if (re.test(paras[i])) {
        out.push({ segment_id: segment.id, para: i + 1, tag, text: paras[i] });
        break; // one nomination per ¶, highest-precedence tag
      }
    }
  }
  return out;
}

/* ===================== The procedure (LLM judgment points) ================ */

function normalizeGround(v: unknown): ObjectionGround {
  return v === 'hearsay' || v === 'characterization' || v === 'speculation' || v === 'prejudice'
    ? v : 'characterization';
}

export interface ProcedureRun {
  candidates: CandidateSpan[];
  objections: Objection[];
  rulings: Ruling[];
  strikes: Strike[];
}

/**
 * Run {OBJECTION → RULING → STRIKE} over every `ours` segment. Ports carry
 * the two agents; stage names 'objection' and 'ruling' let the live layer
 * route models per spec §7 (opposing counsel = economy model).
 */
export async function runProcedure(
  segments: Segment[],
  ports: EnginePorts,
  checkAbort: () => void,
): Promise<ProcedureRun> {
  const run: ProcedureRun = { candidates: [], objections: [], rulings: [], strikes: [] };
  const ordered = [...segments].sort((a, b) => a.position - b.position);

  for (const seg of ordered) {
    if (seg.side !== 'ours') continue; // §5: opposing counsel reviews OUR advocacy
    const candidates = nominateSpans(seg);
    run.candidates.push(...candidates);
    if (candidates.length === 0) continue;

    checkAbort();
    ports.onProgress?.({
      stage: 'objections',
      detail: `Opposing counsel is reviewing ${segmentLabel(seg)}`,
    });
    const decision = await ports.structured<{ objections?: unknown[] }>({
      stage: 'objection',
      system: OPPOSING_SYSTEM,
      prompt: opposingTask(seg, candidates),
      toolName: 'stand_and_object',
      toolDescription: 'Decide which nominated spans, if any, merit a stated objection.',
      schema: OBJECTION_SCHEMA,
      maxTokens: 1024,
    });

    const paraText = new Map(candidates.map((c) => [c.para, c.text]));
    const objections = (Array.isArray(decision?.objections) ? decision.objections : [])
      .map((o) => (o ?? {}) as Record<string, unknown>)
      .filter((o) => paraText.has(Number(o.para))) // only nominated ¶s are objectable
      .slice(0, MAX_OBJECTIONS_PER_SEGMENT)
      .map((o): Objection => ({
        segment_id: seg.id,
        para: Number(o.para),
        ground: normalizeGround(o.ground),
        basis: String(o.basis ?? ''),
      }));

    for (const objection of objections) {
      run.objections.push(objection);
      await ports.saveEvent?.(objection, 'objection');

      checkAbort();
      ports.onProgress?.({
        stage: 'ruling',
        detail: `The Court is ruling on the ${objection.ground} objection to ${segmentLabel(seg)} ¶${objection.para}`,
      });
      const raw = await ports.structured<Record<string, unknown>>({
        stage: 'ruling',
        system: JUDGE_SYSTEM,
        prompt: judgeTask(seg, objection, paraText.get(objection.para) ?? ''),
        toolName: 'rule_on_objection',
        toolDescription: 'Rule on the pending objection with a one-paragraph, FRE-grounded explanation.',
        schema: RULING_SCHEMA,
        maxTokens: 700,
      });

      const sustained = raw?.ruling === 'sustained';
      const ruling: Ruling = {
        segment_id: seg.id,
        para: objection.para,
        ground: objection.ground,
        ruling: sustained ? 'sustained' : 'overruled',
        explanation: String(raw?.explanation ?? ''),
        ...(sustained
          ? {
              disregard_instruction: String(
                raw?.disregard_instruction ??
                'The jury will disregard the statement just made by counsel.',
              ),
            }
          : {}),
      };
      run.rulings.push(ruling);
      await ports.saveEvent?.(ruling, 'ruling');

      if (sustained) {
        const strike: Strike = {
          segment_id: seg.id,
          para: objection.para,
          ground: objection.ground,
          instruction: ruling.disregard_instruction ?? '',
          text: paraText.get(objection.para) ?? '',
        };
        run.strikes.push(strike);
        await ports.saveEvent?.(strike, 'strike');
      }
    }
  }
  return run;
}

/* ========================== Leakage measurement =========================== */

/** "Seg 2 ¶4" — the locator jurors cite for a stricken ¶. */
export function strikeLocator(strike: Strike, segments: Segment[]): string {
  const seg = segments.find((s) => s.id === strike.segment_id);
  return `Seg ${(seg?.position ?? 0) + 1} ¶${strike.para}`;
}

const POLICE_RE = /\b(?:disregard|stricken|struck|instructed|told (?:us|not) to|not supposed to consider|the judge said)\b/i;

/** Distinctive word-shingles of the stricken text, for quote matching. */
function shingles(text: string, size = 4): string[] {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i++) out.push(words.slice(i, i + size).join(' '));
  return out;
}

function mentionsStrike(text: string, locator: string, strikeShingles: string[]): boolean {
  if (text.includes(locator)) return true;
  const hay = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ');
  return strikeShingles.some((s) => hay.includes(s));
}

/**
 * Deterministic scan: for each strike, find every deliberation turn and
 * ballot reason that resurfaces the stricken span (by locator or by verbatim
 * overlap), split into policing ("we were told to disregard that") and
 * genuine leakage; final-ballot reliance is tracked separately because it is
 * the number that prices the moment.
 */
export function measureLeakage(
  strikes: Strike[],
  segments: Segment[],
  turns: DeliberationTurn[],
  finalBallots: Ballot[],
  panel: JurorProfile[],
): LeakageFinding[] {
  const seatOf = new Map(panel.map((j) => [j.id, j.seat]));
  return strikes.map((strike) => {
    const locator = strikeLocator(strike, segments);
    const grams = shingles(strike.text);
    const resurfaced: LeakageSighting[] = [];
    const policed: LeakageSighting[] = [];
    const inFinal: LeakageSighting[] = [];

    for (const t of turns) {
      if (!mentionsStrike(t.speech, locator, grams)) continue;
      const sighting: LeakageSighting = {
        seat: t.seat,
        juror_id: t.juror_id,
        round: t.round,
        where: 'speech',
        excerpt: t.speech.length > 220 ? t.speech.slice(0, 217) + '…' : t.speech,
      };
      (POLICE_RE.test(t.speech) ? policed : resurfaced).push(sighting);
    }

    for (const b of finalBallots) {
      for (const r of b.reasons) {
        const blob = `${r.reason} ${r.locator} ${r.quote}`;
        if (!mentionsStrike(blob, locator, grams)) continue;
        inFinal.push({
          seat: seatOf.get(b.juror_id) ?? 0,
          juror_id: b.juror_id,
          round: b.round,
          where: 'ballot',
          excerpt: r.reason,
        });
        break; // one sighting per juror ballot
      }
    }

    return { strike, locator, resurfaced, policed, in_final_ballots: inFinal };
  });
}

/* ============================ Twin Panel delta ============================ */

function tally(ballots: Ballot[]): { ours: number; theirs: number; undecided: number } {
  const t = { ours: 0, theirs: 0, undecided: 0 };
  for (const b of ballots) t[b.leaning] += 1;
  return t;
}

function lastBallots(d: DeliberationResult): Ballot[] {
  return d.rounds.length ? d.rounds[d.rounds.length - 1].ballots : d.firstBallots;
}

/** Per-juror final-position delta between the main panel and its clean twin. */
export function computeTwinDelta(
  main: DeliberationResult,
  twin: DeliberationResult,
  panel: JurorProfile[],
): TwinResult {
  const mainFinal = lastBallots(main);
  const twinFinal = lastBallots(twin);
  const mainOf = new Map(mainFinal.map((b) => [b.juror_id, b]));
  const twinOf = new Map(twinFinal.map((b) => [b.juror_id, b]));
  const delta: TwinDeltaRow[] = panel
    .map((j) => {
      const m = mainOf.get(j.id);
      const t = twinOf.get(j.id);
      if (!m || !t) return null;
      return {
        juror_id: j.id,
        seat: j.seat,
        main: { leaning: m.leaning, conviction: m.conviction },
        twin: { leaning: t.leaning, conviction: t.conviction },
      };
    })
    .filter((r): r is TwinDeltaRow => r !== null);
  return {
    deliberation: twin,
    delta,
    main_tally: tally(mainFinal),
    twin_tally: tally(twinFinal),
  };
}
