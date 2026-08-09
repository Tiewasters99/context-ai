#!/usr/bin/env node
// The Courtroom — eval harness (spec §11). Run:
//
//     node scripts/courtroom-eval.mjs --mock
//
// --mock injects canned juror outputs (no API keys needed) and exercises the
// DETERMINISTIC machinery end to end, straight from the TypeScript sources
// (Node ≥22.18 type stripping; the courtroom lib keeps relative .ts imports
// for exactly this reason). Checks:
//
//   1. sampler determinism — same seed ⇒ identical panel; new seed ⇒ new panel
//   2. the rail, mechanically — race-mix changes cannot move attitudes
//   3. deliberation state machine — three golden scenarios hit their scripted
//      stop conditions (unanimous / hung / max_rounds) with the exact
//      movement metric
//   4. FLATNESS ALARM — a zero-movement suite fails the build; a flat control
//      run must trip the runtime alarm; kill switch (ports.signal) throws
//      SessionAborted on the next juror turn; all-undecided majority edge case
//   5. FULL TRIAL (Phase 2) — deterministic span nomination; scripted
//      objection → sustained ruling → strike; the main record keeps the
//      stricken ¶ flagged with the instruction while the twin record omits
//      it (¶ numbering unshifted); leakage detection separates resurfacing
//      from policing from final-ballot reliance; Twin Panel delta; report §5
//   6. demographic-keying scan — regex over prompt templates, every prompt
//      the engine actually built, every output, and the reports
//   7. prompt-cache ordering — [shared record][boundary][persona][task]
//   8. report composition — §9 sections, disclaimers, resolvable cites
//
// Golden scenarios: PI, contract, and LABIB_STERIS_PLACEHOLDER (authored
// generic antitrust facts; Eden supplies the anonymized Labib/Steris record
// before the antitrust eval is considered real — spec §12.6).

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = (f) => path.join(here, '..', 'src', 'lib', 'courtroom', f);

if (!process.argv.includes('--mock')) {
  console.error('Live mode is not wired up (no API keys in this environment). Run with --mock.');
  process.exit(2);
}

const { samplePanel } = await import(`file://${lib('sampler.ts')}`);
const { runSession, flatnessAlarm, computeMovement, emergingMajority, SessionAborted } = await import(`file://${lib('engine.ts')}`);
const { composeReport } = await import(`file://${lib('report.ts')}`);
const prompts = await import(`file://${lib('prompts.ts')}`);
const { CACHE_BOUNDARY, CALIBRATION_DISCLAIMER, NOT_FOR_JURY_SELECTION, paragraphize } = prompts;

const fixtures = [
  (await import('./courtroom-fixtures/pi-case.mjs')).default,
  (await import('./courtroom-fixtures/contract-dispute.mjs')).default,
  (await import('./courtroom-fixtures/antitrust-placeholder.mjs')).default,
];

/* ============================= Test scaffold ============================== */

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail && !pass ? ` — ${detail}` : ''}`);
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ============================== Mock ports ================================ */

// Canned outputs keyed off the prompts the ENGINE builds — the mock parses
// segment numbers, rounds, and responding-to names back out of the real
// prompt text, so the templates themselves are under test too.

function words(text, n) {
  return text.split(/\s+/).slice(0, n).join(' ');
}

function makeMockPorts(fixture, capture) {
  const seatOf = (jurorId) => Number(String(jurorId).replace('seat-', ''));

  const scriptedBallot = (seat, round) => {
    const script = fixture.ballots[seat];
    const rounds = Object.keys(script).map(Number).filter((r) => r <= round).sort((a, b) => b - a);
    const [leaning, conviction] = script[rounds[0]];
    return { leaning, conviction };
  };

  const reasonPool = (segIdx) => {
    const seg = fixture.segments[segIdx];
    const paras = paragraphize(seg.transcript);
    return paras.map((p, i) => ({
      quote: words(p, 9),
      locator: `Seg ${seg.position + 1} ¶${i + 1}`,
    }));
  };

  return {
    structured: async (call) => {
      capture.prompts.push(call);
      const seat = seatOf(call.jurorId ?? 'seat-0');

      if (call.stage === 'reaction') {
        const m = call.prompt.match(/PRIVATE REACTION to Seg (\d+)/);
        if (!m) throw new Error('reaction task did not name a segment');
        const seg = fixture.segments[Number(m[1]) - 1];
        const paras = paragraphize(seg.transcript);
        const salience = [0, 1, 2].map((i) => {
          const pi = (seat + i) % paras.length; // salience divergence by seat
          return {
            moment: `What was said in paragraph ${pi + 1}`,
            quote: words(paras[pi], 9),
            locator: `Seg ${seg.position + 1} ¶${pi + 1}`,
            why_it_stuck: `In my line of work you check the paperwork, and this read like the paperwork.`,
          };
        });
        const out = {
          salience,
          confusions: seat % 4 === 0
            ? [{ point: 'The timeline between the notice and the response was never pinned down.', locator: `Seg ${seg.position + 1} ¶1` }]
            : [],
          credibility: seat % 3 === 0
            ? [{ subject: 'presenting counsel', impression: 'Organized; leaned on the documents rather than adjectives.' }]
            : [],
          gut: seat % 2 === 0
            ? 'Still listening, but the documents are doing the talking so far.'
            : 'Something about the sequence of events does not sit right with me yet.',
        };
        capture.outputs.push(JSON.stringify(out));
        return out;
      }

      // Ballots (first_ballot => round 0; reballot parses the round).
      const round = call.stage === 'first_ballot'
        ? 0
        : Number(call.prompt.match(/BALLOT, ROUND (\d+)/)?.[1] ?? -1);
      if (round < 0) throw new Error('reballot task did not name a round');
      const { leaning, conviction } = scriptedBallot(seat, round);
      const pool = reasonPool(0);
      const out = {
        leaning,
        conviction,
        reasons: [0, 1, 2].map((i) => {
          const p = pool[(seat + i) % pool.length];
          return {
            reason: leaning === 'theirs'
              ? 'The other side\'s account of this moment held up better under the questioning.'
              : leaning === 'ours'
                ? 'The presenting side tied this moment to a document, and the document held.'
                : 'Neither side closed the gap on this moment for me.',
            quote: p.quote,
            locator: p.locator,
          };
        }),
      };
      capture.outputs.push(JSON.stringify(out));
      return out;
    },

    speech: async (call) => {
      capture.prompts.push(call);
      let text;
      if (call.stage === 'foreman') {
        const round = call.prompt.match(/OPEN ROUND (\d+) AS FOREMAN/)?.[1] ?? '?';
        const p = reasonPool(0)[0];
        text = `All right — round ${round}. The ballots are split, so let's use the time. The moment I keep hearing about is [${p.locator}] "${p.quote}". Whoever voted against the room, take the floor first and tell us what you saw there.`;
      } else if (call.stage === 'deliberation') {
        const respondingTo = call.prompt.match(/Respond to (.+?) by name/)?.[1] ?? 'the foreman';
        const seat = seatOf(call.jurorId ?? 'seat-1');
        const pool = reasonPool(fixture.segments.length > 1 ? 1 : 0);
        const p = pool[seat % pool.length];
        text = `${respondingTo}, I hear you, but I keep coming back to [${p.locator}] "${p.quote}". Where I work, the record is what saves you or sinks you, and that line cuts against the story we were just told. Convince me on that moment and you might move me; wave at it and you will not.`;
      } else {
        // report synthesis
        text = 'The panel rewarded specificity: the moments that traveled were the ones tied to a document with a date on it, and the panel repeated those cites back in its own reasons, while the uncited characterizations evaporated by the first ballot.';
      }
      capture.outputs.push(text);
      return text;
    },

    onProgress: () => {},
  };
}

/* ========================= 1-2: sampler guarantees ======================== */

console.log('\n— Sampler —');
{
  const mix = structuredClone((await import(`file://${lib('sampler.ts')}`)).DEFAULT_VENUE_MIX);
  const a = samplePanel(mix, 42, 12);
  const b = samplePanel(mix, 42, 12);
  check('same seed + same mix ⇒ identical panel', deepEqual(a, b));
  const c = samplePanel(mix, 43, 12);
  check('different seed ⇒ different panel', !deepEqual(a, c));

  // The rail, mechanically: two mixes differing ONLY in race weights, same
  // seed. Compositions may differ in race; every juror's REASONING must be
  // byte-identical (attitudes conditioned on occupation + experience only).
  const mixA = structuredClone(mix);
  const mixB = structuredClone(mix);
  mixA.race_ethnicity = { White: 100, Black: 0, Hispanic: 0, Asian: 0, 'Native American': 0, 'Multiracial/Other': 0 };
  mixB.race_ethnicity = { White: 0, Black: 100, Hispanic: 0, Asian: 0, 'Native American': 0, 'Multiracial/Other': 0 };
  const pa = samplePanel(mixA, 7, 12);
  const pb = samplePanel(mixB, 7, 12);
  const raceDiffers = pa.some((j, i) => j.composition.race_ethnicity !== pb[i].composition.race_ethnicity);
  const reasoningIdentical = pa.every((j, i) => deepEqual(j.reasoning, pb[i].reasoning));
  const namesIdentical = pa.every((j, i) => j.display_name === pb[i].display_name);
  check('race-mix change actually changes composition', raceDiffers);
  check('race-mix change CANNOT move reasoning (attitudes/experiences identical)', reasoningIdentical);
  check('display names are uncorrelated with race mix', namesIdentical);
}

/* ==================== 3: state machine on golden scenarios ================ */

console.log('\n— Deliberation state machine (3 golden scenarios) —');
const sessionResults = [];
const allCaptures = [];
for (const fixture of fixtures) {
  const capture = { prompts: [], outputs: [], reports: [] };
  allCaptures.push(capture);
  const panel = samplePanel(
    structuredClone((await import(`file://${lib('sampler.ts')}`)).DEFAULT_VENUE_MIX),
    fixture.seed,
    fixture.panelSize,
  );
  const ports = makeMockPorts(fixture, capture);
  const result = await runSession(
    { trialTitle: fixture.trialTitle, jurors: panel, segments: fixture.segments },
    ports,
  );
  sessionResults.push({ fixture, panel, result, capture });

  const d = result.deliberation;
  check(`${fixture.name}: stop = ${fixture.expect.stop}`, d.stop_reason === fixture.expect.stop, `got ${d.stop_reason}`);
  check(`${fixture.name}: rounds = ${fixture.expect.rounds}`, d.rounds.length === fixture.expect.rounds, `got ${d.rounds.length}`);
  check(`${fixture.name}: total movement = ${fixture.expect.movement}`, d.total_movement === fixture.expect.movement, `got ${d.total_movement}`);
  check(`${fixture.name}: every juror reacted to every segment`,
    result.reactions.length === fixture.segments.length * fixture.panelSize,
    `got ${result.reactions.length}`);
  check(`${fixture.name}: secret first ballot precedes deliberation (round 0, full panel)`,
    d.firstBallots.length === fixture.panelSize && d.firstBallots.every((b) => b.round === 0));
  // Movement metric self-consistency: recompute from the raw ballots.
  let recomputed = 0;
  let prev = d.firstBallots;
  for (const r of d.rounds) {
    recomputed += computeMovement(prev, r.ballots).total;
    prev = r.ballots;
  }
  check(`${fixture.name}: movement metric consistent with raw ballots`, recomputed === d.total_movement, `recomputed ${recomputed}`);
  check(`${fixture.name}: every speaking turn carries a record cite`,
    d.rounds.every((r) => r.turns.every((t) => /\[Seg \d+ ¶\d+\]/.test(t.speech))));
  check(`${fixture.name}: every non-foreman turn answers a named prior speaker`,
    d.rounds.every((r) => r.turns.every((t) => t.role === 'foreman' || (t.responding_to ?? '').length > 0)));
}

/* ============================ 4: flatness alarm =========================== */

console.log('\n— Flatness alarm —');
{
  const suiteMovement = sessionResults.map((s) => s.result.deliberation.total_movement);
  const nonzero = suiteMovement.filter((m) => m > 0).length;
  check('suite is not flat (zero total movement would fail the build)', suiteMovement.reduce((a, b) => a + b, 0) > 0);
  check(`nonzero movement on at least 2 of 3 golden scenarios (${nonzero}/3)`, nonzero >= 2);

  // Positive control: a scripted flat panel must trip the runtime alarm.
  const flatFixture = structuredClone(fixtures[1]);
  flatFixture.ballots = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [i + 1, { 0: [i < 6 ? 'ours' : 'theirs', 5] }]),
  );
  const capture = { prompts: [], outputs: [], reports: [] };
  const panel = samplePanel(
    structuredClone((await import(`file://${lib('sampler.ts')}`)).DEFAULT_VENUE_MIX), 99, 12,
  );
  const flat = await runSession(
    { trialTitle: flatFixture.trialTitle, jurors: panel, segments: flatFixture.segments },
    makeMockPorts(flatFixture, capture),
  );
  check('flat control run: zero movement detected', flat.deliberation.total_movement === 0);
  check('flat control run: runtime flatness alarm trips', flatnessAlarm(flat) !== null);
  check('golden scenarios: runtime alarm stays quiet', sessionResults.every((s) => flatnessAlarm(s.result) === null));
}

/* ================== 4b: kill switch + majority edge cases ================= */

console.log('\n— Kill switch (SessionAborted) and majority edge cases —');
{
  // Abort mid-session: stop the signal after the 10th juror call (still inside
  // the reaction phase — a full contract run makes 36 reaction calls alone) and
  // the engine must throw SessionAborted before the next juror speaks.
  const fixture = fixtures[1];
  const capture = { prompts: [], outputs: [], reports: [] };
  const panel = samplePanel(
    structuredClone((await import(`file://${lib('sampler.ts')}`)).DEFAULT_VENUE_MIX),
    fixture.seed,
    fixture.panelSize,
  );
  const ports = makeMockPorts(fixture, capture);
  const controller = new AbortController();
  const inner = ports.structured;
  ports.structured = async (call) => {
    const out = await inner(call);
    if (capture.prompts.length >= 10) controller.abort();
    return out;
  };
  ports.signal = controller.signal;
  let thrown = null;
  try {
    await runSession(
      { trialTitle: fixture.trialTitle, jurors: panel, segments: fixture.segments },
      ports,
    );
  } catch (e) {
    thrown = e;
  }
  check('aborting the signal mid-session throws SessionAborted', thrown instanceof SessionAborted, `got ${thrown?.name ?? 'no error'}`);
  check('abort takes effect on the next juror turn (one call after the abort, not a full round)',
    capture.prompts.length === 10, `got ${capture.prompts.length} calls`);

  // emergingMajority: an all-undecided panel has NO emerging majority — it must
  // not manufacture a phantom 'ours' majority that marks everyone conflicted.
  const undecided = (id) => ({ juror_id: id, round: 0, leaning: 'undecided', conviction: 2, reasons: [] });
  const allUndecided = Array.from({ length: 12 }, (_, i) => undecided(`seat-${i + 1}`));
  check("all-undecided panel: emerging majority is 'undecided'", emergingMajority(allUndecided) === 'undecided');
  const oneVote = [...allUndecided.slice(0, 11), { ...undecided('seat-12'), leaning: 'ours' }];
  check("a single decided ballot still yields that side as the emerging majority", emergingMajority(oneVote) === 'ours');
}

/* ============ 5 (Phase 2): Full Trial — strike, leakage, twin ============= */

console.log('\n— Full Trial: objection → ruling → strike → leakage → Twin Panel (§5) —');
{
  const { nominateSpans } = await import(`file://${lib('procedure.ts')}`);
  const fixture = fixtures[1]; // the contract dispute

  // Deterministic nomination: the closing's "bet that went bad" is the one
  // characterization on this record; the opening offers nothing objectionable.
  // ¶1 "a bet that went bad" → characterization; ¶2 "the words they wrote" →
  // hearsay-shaped. Nomination is deliberately coarse — counsel (scripted
  // below) stands on ¶1 only, exercising the decline-the-loser path for ¶2.
  const spans = nominateSpans(fixture.segments[2]);
  check('nomination flags both closing ¶s (¶1 characterization, ¶2 hearsay-shaped)',
    spans.length === 2 &&
    spans[0].para === 1 && spans[0].tag === 'characterization' &&
    spans[1].para === 2 && spans[1].tag === 'hearsay',
    JSON.stringify(spans.map((s) => [s.para, s.tag])));
  check('nomination leaves the clean opening alone (Seg 1: no candidates)',
    nominateSpans(fixture.segments[0]).length === 0,
    JSON.stringify(nominateSpans(fixture.segments[0]).map((s) => [s.para, s.tag])));

  // Full session: scripted opposing counsel + judge; twin ballots differ only
  // in seat 4, which flips sides when it never hears the stricken line.
  const INSTRUCTION =
    'You will disregard counsel\'s characterization of the defendant\'s decision as a bet that went bad; you may consider the evidence of what the defendant did.';
  const twinBallots = structuredClone(fixture.ballots);
  twinBallots[4] = { 0: ['ours', 4], 1: ['theirs', 3] };

  const capture = { prompts: [], outputs: [], reports: [] };
  allCaptures.push(capture); // demographic scan covers the procedure prompts too
  const panel = samplePanel(
    structuredClone((await import(`file://${lib('sampler.ts')}`)).DEFAULT_VENUE_MIX),
    fixture.seed,
    fixture.panelSize,
  );
  const base = makeMockPorts(fixture, capture);
  const twinBase = makeMockPorts({ ...fixture, ballots: twinBallots }, capture);
  const strip = (call) => ({ ...call, stage: call.stage.replace(/^twin_/, '') });

  let deliberationTurnsSeen = 0;
  const ports = {
    structured: async (call) => {
      if (call.stage === 'objection') {
        capture.prompts.push(call);
        const out = {
          objections: [{
            para: 1,
            ground: 'characterization',
            basis: 'Objection, Your Honor — counsel is testifying. "A bet that went bad" is argument dressed as evidence.',
          }],
        };
        capture.outputs.push(JSON.stringify(out));
        return out;
      }
      if (call.stage === 'ruling') {
        capture.prompts.push(call);
        const out = {
          ruling: 'sustained',
          explanation: 'Sustained. Counsel may argue the inferences the evidence supports, but "a bet that went bad" characterizes the defendant\'s judgment rather than the record; under Rule 611(a) the Court confines closing to the evidence and fair inference.',
          disregard_instruction: INSTRUCTION,
        };
        capture.outputs.push(JSON.stringify(out));
        return out;
      }
      if (call.stage.startsWith('twin_')) return twinBase.structured(strip(call));
      const out = await base.structured(call);
      // Ballot-leakage plant: seat 4's re-ballots keep leaning on the
      // stricken line despite the instruction.
      if (call.stage === 'reballot' && call.jurorId === 'seat-4') {
        out.reasons[0] = {
          reason: 'That bet-that-went-bad framing is still how I read Section 14, whatever the ruling was.',
          quote: 'a bet that went bad',
          locator: 'Seg 3 ¶1',
        };
      }
      return out;
    },
    speech: async (call) => {
      if (call.stage.startsWith('twin_')) return twinBase.speech(strip(call));
      if (call.stage === 'deliberation') {
        deliberationTurnsSeen += 1;
        // First speaker resurfaces the stricken moment; second polices it.
        if (deliberationTurnsSeen === 1) {
          capture.prompts.push(call);
          const text = 'Say what you want about the ruling — counsel had it right. It was a bet that went bad [Seg 3 ¶1], and Section 14 does not rescue a bad bet. The hedge was on the table in 2023 and they passed.';
          capture.outputs.push(text);
          return text;
        }
        if (deliberationTurnsSeen === 2) {
          capture.prompts.push(call);
          const text = 'Hold on — we were told to disregard the "bet that went bad" line, so set it aside. Rule on what is left: the certified-mail clause was theirs [Seg 3 ¶2] and they did not follow it.';
          capture.outputs.push(text);
          return text;
        }
      }
      return base.speech(call);
    },
    onProgress: () => {},
  };

  const res = await runSession(
    {
      trialTitle: fixture.trialTitle,
      jurors: panel,
      segments: fixture.segments,
      mode: 'full',
      twinPanel: true,
    },
    ports,
  );

  /* ---- The procedure ---- */
  check('opposing counsel reviewed only OUR segments (1 objection on this record)',
    res.procedure?.objections.length === 1 && res.procedure.objections[0].para === 1);
  check('the Court ruled once, sustained, with a disregard instruction',
    res.procedure?.rulings.length === 1 &&
    res.procedure.rulings[0].ruling === 'sustained' &&
    res.procedure.rulings[0].disregard_instruction === INSTRUCTION);
  check('a sustained ruling produced exactly one strike carrying the ¶ text',
    res.procedure?.strikes.length === 1 &&
    res.procedure.strikes[0].para === 1 &&
    res.procedure.strikes[0].text.includes('bet that went bad') &&
    res.procedure.strikes[0].instruction === INSTRUCTION);

  /* ---- The two records ---- */
  const mainReaction = capture.prompts.find(
    (p) => p.stage === 'reaction' && p.prompt.includes('[Seg 3 (closing, ours)]\n¶1 [STRICKEN'),
  );
  check('main panel record keeps the stricken ¶, flagged with the instruction (they heard it)',
    Boolean(mainReaction) &&
    mainReaction.prompt.includes(INSTRUCTION) &&
    mainReaction.prompt.includes('bet that went bad'));
  const twinReaction = capture.prompts.find(
    (p) => p.stage === 'reaction' && p.prompt.includes('[Seg 3 (closing, ours)]\n¶2 '),
  );
  check('twin record omits the stricken ¶ entirely, with ¶ numbering unshifted',
    Boolean(twinReaction) &&
    !twinReaction.prompt.includes('bet that went bad') &&
    !twinReaction.prompt.includes('STRICKEN') &&
    twinReaction.prompt.includes('¶2 The certified-mail clause'));

  /* ---- Leakage measurement ---- */
  const r1 = res.deliberation.rounds[0].turns.filter((t) => t.role === 'speaker');
  const finding = res.leakage?.[0];
  check('leakage: the resurfacing turn is detected (and only that turn)',
    Boolean(finding) &&
    finding.resurfaced.length === 1 &&
    finding.resurfaced[0].seat === r1[0].seat &&
    finding.resurfaced[0].round === 1,
    JSON.stringify(finding?.resurfaced.map((s) => [s.seat, s.round])));
  check('leakage: the policing turn is detected as policing, not leakage',
    Boolean(finding) &&
    finding.policed.length === 1 &&
    finding.policed[0].seat === r1[1].seat);
  check('leakage: seat 4\'s final ballot still leans on the stricken span',
    Boolean(finding) &&
    finding.in_final_ballots.length === 1 &&
    finding.in_final_ballots[0].seat === 4);

  /* ---- Twin Panel delta ---- */
  check('twin panel deliberated separately (its own rounds, its own stop)',
    res.twin?.deliberation.rounds.length === 3 && res.twin.deliberation.stop_reason === 'hung',
    `got ${res.twin?.deliberation.rounds.length} rounds, ${res.twin?.deliberation.stop_reason}`);
  check('twin delta prices the moment: 7-5 with it, 6-6 without it',
    deepEqual(res.twin?.main_tally, { ours: 7, theirs: 5, undecided: 0 }) &&
    deepEqual(res.twin?.twin_tally, { ours: 6, theirs: 6, undecided: 0 }));
  const moved = res.twin?.delta.filter((d) => d.main.leaning !== d.twin.leaning) ?? [];
  check('twin delta names seat 4 as the juror the stricken moment moved',
    moved.length === 1 && moved[0].seat === 4 &&
    moved[0].main.leaning === 'ours' && moved[0].twin.leaning === 'theirs');

  /* ---- Report §5 ---- */
  const md = await composeReport({
    trialTitle: fixture.trialTitle,
    matterName: 'Eval Matter',
    modelName: 'Mock Panel',
    panel,
    segments: fixture.segments,
    reactions: res.reactions,
    deliberation: res.deliberation,
    usage: null,
    generatedAt: 'August 9, 2026',
    mode: 'full',
    procedure: res.procedure,
    leakage: res.leakage,
    twin: res.twin,
  }, ports);
  capture.reports.push(md);
  check('report header says Full Trial', md.includes('Full Trial, panel of 12'));
  const s5 = md.slice(md.indexOf('## 5. Strike & leakage panel'), md.indexOf('## 6.'));
  check('report §5 renders the ruling, the instruction, and the stricken span',
    s5.includes('SUSTAINED') && s5.includes(INSTRUCTION) && s5.includes('Stricken — Seg 3 ¶1'));
  check('report §5 renders leakage, policing, and final-ballot reliance',
    s5.includes('resurfaced in deliberation') &&
    s5.includes('reminded the room') &&
    s5.includes('still lean'));
  check('report §5 renders the Twin Panel delta table and the moved juror',
    s5.includes('| Twin (never heard it) | 6 | 6 | 0 |') &&
    s5.includes('seat 4 (ours 3/7 → theirs 3/7)'));
  check('full-trial report still contains no verdict-probability language',
    !/\b(probability|likelihood|odds|win rate|% chance|chance of (winning|prevailing))\b/i.test(md));
}

/* ======================= 7 (early): report composition ==================== */

console.log('\n— Report composition (§9) —');
const reportMarkdowns = [];
for (const s of sessionResults) {
  const md = await composeReport({
    trialTitle: s.fixture.trialTitle,
    matterName: 'Eval Matter',
    modelName: 'Mock Panel',
    panel: s.panel,
    segments: s.fixture.segments,
    reactions: s.result.reactions,
    deliberation: s.result.deliberation,
    usage: null,
    generatedAt: 'August 8, 2026',
  }, makeMockPorts(s.fixture, s.capture));
  reportMarkdowns.push(md);
  s.capture.reports.push(md);
}
{
  const md = reportMarkdowns[0];
  for (const heading of ['## 1. What landed', '## 2. What confused', '## 3. Pushback map', '## 4. Deliberation movement', '## 6. This panel\'s ballots']) {
    check(`report carries "${heading}"`, md.includes(heading));
  }
  check('report carries the §9 calibration disclaimer verbatim',
    reportMarkdowns.every((m) => m.includes(CALIBRATION_DISCLAIMER)));
  check('report carries the not-for-jury-selection statement',
    reportMarkdowns.every((m) => m.includes(NOT_FOR_JURY_SELECTION)));
  check('report contains no verdict-probability language',
    reportMarkdowns.every((m) => !/\b(probability|likelihood|odds|win rate|% chance|chance of (winning|prevailing))\b/i.test(m)));
  // Cites resolve: every "Seg N ¶M" in the report points at a real paragraph.
  const citesResolve = sessionResults.every((s, i) => {
    const md2 = reportMarkdowns[i];
    const cites = [...md2.matchAll(/Seg (\d+) ¶(\d+)/g)];
    return cites.length > 0 && cites.every(([, seg, para]) => {
      const segment = s.fixture.segments[Number(seg) - 1];
      return segment && Number(para) <= paragraphize(segment.transcript).length;
    });
  });
  check('every Seg/¶ cite in every report resolves to a real paragraph', citesResolve);
}

/* ====================== 5: demographic-keying scan ======================== */

console.log('\n— Demographic-keying scan (§2.3 rail) —');
{
  const DEMO = '(black|white|hispanic|latino|latina|latinx|asian|native american|indigenous|african[- ]american|caucasian|man|woman|male|female|nonbinary|non-binary|person of color)';
  const PATTERNS = [
    new RegExp(`\\bas an? ${DEMO}\\b`, 'i'),
    new RegExp(`\\bspeaking as an? ${DEMO}\\b`, 'i'),
    new RegExp(`\\bbecause (i am|i'm) an? ${DEMO}\\b`, 'i'),
    new RegExp(`\\b(we|people) ${DEMO}s? (tend to|always|never|usually)\\b`, 'i'),
  ];
  const scan = (label, text) => {
    for (const re of PATTERNS) {
      const m = text.match(re);
      if (m) return `${label}: "${m[0]}"`;
    }
    return null;
  };

  const offenders = [];
  const promptSource = fs.readFileSync(lib('prompts.ts'), 'utf8');
  const hit = scan('prompts.ts', promptSource);
  if (hit) offenders.push(hit);
  for (const capture of allCaptures) {
    for (const p of capture.prompts) {
      const h = scan(`prompt(${p.stage})`, `${p.system}\n${p.prompt}`);
      if (h) { offenders.push(h); break; }
    }
    for (const o of capture.outputs) {
      const h = scan('output', o);
      if (h) { offenders.push(h); break; }
    }
    for (const r of capture.reports) {
      const h = scan('report', r);
      if (h) { offenders.push(h); break; }
    }
  }
  check('no demographic-as-reasoning patterns in templates, prompts, outputs, or reports',
    offenders.length === 0, offenders.join(' | '));
  // The prohibition itself must be present in the juror system prompt.
  check('juror system prompt forbids demographic self-reference',
    promptSource.includes('as a [demographic]'));
  // And composition truly never enters a prompt: no age-band or race token
  // from the composition layer appears in any captured juror prompt.
  const compositionLeaks = [];
  for (const s of sessionResults) {
    for (const p of s.capture.prompts) {
      if (p.stage === 'report') continue;
      for (const j of s.panel) {
        if (p.prompt.includes(`race: ${j.composition.race_ethnicity}`) ||
            p.prompt.includes(j.composition.age_band) ||
            new RegExp(`race[_/ -]?ethnicity`, 'i').test(p.prompt)) {
          compositionLeaks.push(`${p.stage}: composition field in prompt`);
          break;
        }
      }
    }
  }
  check('composition layer never enters a juror prompt', compositionLeaks.length === 0, compositionLeaks[0] ?? '');
}

/* ======================= 6: prompt-cache ordering ========================= */

console.log('\n— Prompt-cache ordering (§7) —');
{
  // Juror prompts only: opposing counsel, the judge, and report synthesis are
  // not panel calls and deliberately do not share the juror prefix shape.
  const jurorPrompts = allCaptures.flatMap((c) => c.prompts).filter((p) => p.jurorId);
  const ordered = jurorPrompts.every((p) => {
    const b = p.prompt.indexOf(CACHE_BOUNDARY);
    const record = p.prompt.indexOf('REHEARSAL RECORD');
    const persona = p.prompt.indexOf('YOU ARE:');
    const task = p.prompt.indexOf('TASK —');
    return b > 0 && record >= 0 && record < b && persona > b && task > persona &&
      p.prompt.indexOf(CACHE_BOUNDARY, b + 1) === -1;
  });
  check('every juror prompt is [shared record][boundary][persona][task]', ordered,
    `${jurorPrompts.length} prompts inspected`);
  // Shared prefixes really are shared: within one reaction batch (same
  // segment), all 12 jurors carry a byte-identical prefix.
  const s0 = sessionResults[0];
  const firstSegPrompts = s0.capture.prompts
    .filter((p) => p.stage === 'reaction' && /PRIVATE REACTION to Seg 1\b/.test(p.prompt))
    .slice(0, s0.fixture.panelSize)
    .map((p) => p.prompt.slice(0, p.prompt.indexOf(CACHE_BOUNDARY)));
  check('reaction batch shares one byte-identical cacheable prefix',
    firstSegPrompts.length > 0 && firstSegPrompts.every((x) => x === firstSegPrompts[0]));
}

/* ================================ Summary ================================= */

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length} checks · ${results.length - failed.length} passed · ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.error(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('The Courtroom eval suite passed (mock mode).');
