// The Courtroom — the Rehearsal Report (spec §9). The report is the work
// product: a linear, citable, lawyerly memo filed into the matter.
//
// Deterministic first (house rule): every ranking, grouping, table, and cite
// is computed in code from the session data. The model contributes exactly
// one synthesis paragraph per narrative section (sections 1-3), through the
// same ports seam the engine uses — so the eval can run the whole composer
// with canned prose.
//
// Rails honored here: no verdict probabilities, no strike advice, no
// demographic aggregation — pushback clusters are labeled by ATTITUDE, and
// jurors appear as seat + name + occupation only. Every quoted juror claim
// about evidence carries its locator (deposition-fidelity culture).

import type {
  Ballot, DeliberationResult, EnginePorts, JurorProfile, Reaction, ReportInput,
} from './types.ts';
import {
  CALIBRATION_DISCLAIMER, NOT_FOR_JURY_SELECTION, REPORT_SYSTEM,
  reportSynthesisTask,
} from './prompts.ts';
import { formatUsage } from './meter.ts';

/* ========================= Deterministic aggregation ====================== */

interface RankedMoment {
  locator: string;
  quote: string;
  moment: string;
  seats: number[];
  whys: string[];
}

/** Cross-panel salience: moments ranked by how many jurors flagged them. */
export function rankSalience(reactions: Reaction[], panel: JurorProfile[]): RankedMoment[] {
  const seatOf = new Map(panel.map((j) => [j.id, j.seat]));
  const byLocator = new Map<string, RankedMoment>();
  for (const r of reactions) {
    for (const s of r.salience) {
      const key = s.locator.trim();
      if (!key) continue;
      const entry = byLocator.get(key) ?? {
        locator: key, quote: s.quote, moment: s.moment, seats: [], whys: [],
      };
      const seat = seatOf.get(r.juror_id);
      if (seat !== undefined && !entry.seats.includes(seat)) entry.seats.push(seat);
      if (s.why_it_stuck) entry.whys.push(s.why_it_stuck);
      byLocator.set(key, entry);
    }
  }
  return [...byLocator.values()]
    .sort((a, b) => b.seats.length - a.seats.length || a.locator.localeCompare(b.locator))
    .map((m) => ({ ...m, seats: [...m.seats].sort((x, y) => x - y) }));
}

interface GroupedConfusion { locator: string; points: string[]; seats: number[] }

export function groupConfusions(reactions: Reaction[], panel: JurorProfile[]): GroupedConfusion[] {
  const seatOf = new Map(panel.map((j) => [j.id, j.seat]));
  const byLocator = new Map<string, GroupedConfusion>();
  for (const r of reactions) {
    for (const c of r.confusions) {
      const key = c.locator.trim() || '(unlocated)';
      const entry = byLocator.get(key) ?? { locator: key, points: [], seats: [] };
      entry.points.push(c.point);
      const seat = seatOf.get(r.juror_id);
      if (seat !== undefined && !entry.seats.includes(seat)) entry.seats.push(seat);
      byLocator.set(key, entry);
    }
  }
  return [...byLocator.values()].sort((a, b) => b.seats.length - a.seats.length);
}

/** The attitude a juror's resistance most plausibly runs on: their most
 *  extreme scale, labeled high/low — never a demographic label (§2.3). */
export function attitudeClusterLabel(j: JurorProfile): string {
  const entries = Object.entries(j.reasoning.attitudes) as [string, number][];
  entries.sort((a, b) => Math.abs(b[1] - 4) - Math.abs(a[1] - 4));
  const [key, value] = entries[0];
  const name = key.replace(/_/g, '-');
  return value >= 4 ? `high ${name}` : `low ${name}`;
}

interface PushbackEntry {
  cluster: string;
  seat: number;
  name: string;
  occupation: string;
  reason: string;
  quote: string;
  locator: string;
}

/** Juror-reasoning resistance to OUR presentation, from final-ballot reasons
 *  of jurors not leaning "ours", grouped by attitude cluster. */
export function pushbackMap(
  deliberation: DeliberationResult,
  panel: JurorProfile[],
): Map<string, PushbackEntry[]> {
  const finals = finalBallots(deliberation);
  const byId = new Map(panel.map((j) => [j.id, j]));
  const clusters = new Map<string, PushbackEntry[]>();
  for (const b of finals) {
    if (b.leaning === 'ours') continue;
    const j = byId.get(b.juror_id);
    if (!j) continue;
    const cluster = attitudeClusterLabel(j);
    for (const r of b.reasons) {
      if (!r.reason) continue;
      const list = clusters.get(cluster) ?? [];
      list.push({
        cluster, seat: j.seat, name: j.display_name,
        occupation: j.reasoning.occupation_detail,
        reason: r.reason, quote: r.quote, locator: r.locator,
      });
      clusters.set(cluster, list);
    }
  }
  return clusters;
}

export function finalBallots(d: DeliberationResult): Ballot[] {
  return d.rounds.length ? d.rounds[d.rounds.length - 1].ballots : d.firstBallots;
}

const LEANING_LABEL: Record<string, string> = {
  ours: 'with us', theirs: 'against us', undecided: 'undecided',
};

/* ============================ Markdown assembly =========================== */

function tallyLine(ballots: Ballot[]): string {
  const t = { ours: 0, theirs: 0, undecided: 0 };
  for (const b of ballots) t[b.leaning] += 1;
  return `${t.ours} with us · ${t.theirs} against us · ${t.undecided} undecided`;
}

/**
 * Compose the full §9 report (sections 1-4 + 6; section 5 is Phase 2) as
 * markdown. `ports.speech` supplies the three narrative paragraphs.
 */
export async function composeReport(
  input: ReportInput,
  ports: Pick<EnginePorts, 'speech' | 'onProgress'>,
): Promise<string> {
  const { panel, reactions, deliberation } = input;
  const seatName = (id: string) => {
    const j = panel.find((x) => x.id === id);
    return j ? `${j.display_name} (seat ${j.seat})` : id;
  };

  const ranked = rankSalience(reactions, panel);
  const confusions = groupConfusions(reactions, panel);
  const pushback = pushbackMap(deliberation, panel);
  const finals = finalBallots(deliberation);

  const synth = async (
    section: 'what_landed' | 'what_confused' | 'pushback',
    digest: string,
  ): Promise<string> => {
    ports.onProgress?.({ stage: 'report', detail: `Drafting the ${section.replace(/_/g, ' ')} narrative` });
    if (!digest.trim()) return '';
    const text = await ports.speech({
      stage: 'report',
      system: REPORT_SYSTEM,
      prompt: reportSynthesisTask(section, digest),
      maxTokens: 500,
    });
    return text.trim();
  };

  /* ---- 1. What landed ---- */
  const landedDigest = ranked.slice(0, 8)
    .map((m) => `- [${m.locator}] "${m.quote}" — flagged by seats ${m.seats.join(', ')}. Why it stuck: ${m.whys.slice(0, 3).join(' / ')}`)
    .join('\n');
  const landedProse = await synth('what_landed', landedDigest);
  const landedList = ranked.slice(0, 8).map((m, i) =>
    `${i + 1}. **"${m.quote}"** — ${m.locator} · flagged by ${m.seats.length} juror${m.seats.length === 1 ? '' : 's'} (seats ${m.seats.join(', ')})\n   ${m.moment}`,
  ).join('\n');

  /* ---- 2. What confused ---- */
  const confusedDigest = confusions
    .map((c) => `- [${c.locator}] seats ${c.seats.join(', ')}: ${c.points.slice(0, 3).join(' / ')}`)
    .join('\n');
  const confusedProse = await synth('what_confused', confusedDigest);
  const confusedList = confusions.length
    ? confusions.map((c) =>
        `- **${c.locator}** (seats ${c.seats.join(', ')}): ${c.points.map((p) => `“${p}”`).join('; ')}`,
      ).join('\n')
    : '_No juror recorded a confusion point. That is rare — and worth a raised eyebrow._';

  /* ---- 3. Pushback map ---- */
  const pushbackDigest = [...pushback.entries()]
    .map(([cluster, entries]) =>
      `Cluster "${cluster}":\n` +
      entries.map((e) => `  - seat ${e.seat} (${e.occupation}): "${e.reason}" [${e.locator}: "${e.quote}"]`).join('\n'),
    ).join('\n');
  const pushbackProse = await synth('pushback', pushbackDigest);
  const pushbackList = pushback.size
    ? [...pushback.entries()].map(([cluster, entries]) =>
        `**${cluster}**\n` +
        entries.map((e) =>
          `- ${e.name} (seat ${e.seat}, ${e.occupation}): “${e.reason}” — citing [${e.locator}] "${e.quote}"`,
        ).join('\n'),
      ).join('\n\n')
    : '_No juror finished the session leaning against us. Treat that with suspicion, not comfort — see the calibration note below._';

  /* ---- 4. Deliberation movement (fully deterministic) ---- */
  const firstOf = new Map(deliberation.firstBallots.map((b) => [b.juror_id, b]));
  const movementRows = panel.map((j) => {
    const first = firstOf.get(j.id);
    const last = finals.find((b) => b.juror_id === j.id);
    if (!first || !last) return null;
    const moved = deliberation.movement_by_juror[j.id] ?? 0;
    const movedRound = deliberation.rounds.find((r) => {
      const prev = r.round === 1 ? first : deliberation.rounds[r.round - 2]?.ballots.find((b) => b.juror_id === j.id);
      const cur = r.ballots.find((b) => b.juror_id === j.id);
      return prev && cur && (prev.leaning !== cur.leaning || prev.conviction !== cur.conviction);
    });
    const movedOn = movedRound
      ? movedRound.turns
          .filter((t) => t.juror_id !== j.id)
          .map((t) => seatName(t.juror_id))
          .slice(0, 2).join(', ')
      : '';
    const citedMoment = last.reasons.find((r) => r.locator)?.locator ?? '';
    return `| ${j.seat} | ${j.display_name} | ${LEANING_LABEL[first.leaning]} (${first.conviction}/7) | ${LEANING_LABEL[last.leaning]} (${last.conviction}/7) | ${moved} | ${moved > 0 ? `round ${movedRound?.round ?? '—'}${movedOn ? `, after ${movedOn}` : ''}${citedMoment ? `, citing ${citedMoment}` : ''}` : 'held firm'} |`;
  }).filter((r): r is string => r !== null);

  const roundLines = deliberation.rounds.map((r) =>
    `- Round ${r.round}: ${tallyLine(r.ballots)} · movement ${r.movement}`,
  ).join('\n');

  const stopLabel: Record<string, string> = {
    unanimous: 'the panel reached unanimity',
    hung: 'two rounds passed without movement (hung)',
    max_rounds: 'the round limit was reached',
  };

  /* ---- 6. Ballots ---- */
  const ballotBlocks = finals.map((b) => {
    const j = panel.find((x) => x.id === b.juror_id);
    const reasons = b.reasons
      .map((r) => `    - ${r.reason}${r.locator ? ` — [${r.locator}]${r.quote ? ` "${r.quote}"` : ''}` : ''}`)
      .join('\n');
    return `- **Seat ${j?.seat ?? '?'} — ${j?.display_name ?? b.juror_id}** (${j?.reasoning.occupation_detail ?? ''}): ${LEANING_LABEL[b.leaning]}, conviction ${b.conviction}/7\n${reasons}`;
  }).join('\n');

  /* ---- Assemble ---- */
  return [
    `# Rehearsal Report — ${input.trialTitle}`,
    '',
    `${input.matterName} · ${input.generatedAt} · Quick Panel of ${panel.length} · panel model: ${input.modelName}`,
    '',
    `> ${NOT_FOR_JURY_SELECTION}`,
    '',
    '## 1. What landed',
    '',
    landedProse,
    '',
    landedList || '_No salience data was recorded._',
    '',
    '## 2. What confused',
    '',
    confusedProse,
    '',
    confusedList,
    '',
    '## 3. Pushback map',
    '',
    '_Resistance from the jurors\' own reasoning — not legal objections — grouped by attitude cluster._',
    '',
    pushbackProse,
    '',
    pushbackList,
    '',
    '## 4. Deliberation movement',
    '',
    `First ballot: ${tallyLine(deliberation.firstBallots)}. Deliberation ran ${deliberation.rounds.length} round${deliberation.rounds.length === 1 ? '' : 's'}; it ended because ${stopLabel[deliberation.stop_reason]}. Foreman: ${seatName(deliberation.foreman_juror_id)}.`,
    '',
    roundLines,
    '',
    '| Seat | Juror | First ballot | Final ballot | Movement | Moved on |',
    '|---|---|---|---|---|---|',
    ...movementRows,
    '',
    '## 5. Strike & leakage panel',
    '',
    '_Ships with Full Trial (Phase 2) — objections, rulings, disregard instructions, and the Twin Panel delta._',
    '',
    '## 6. This panel\'s ballots',
    '',
    `> ${CALIBRATION_DISCLAIMER}`,
    '',
    `Final tally: **${tallyLine(finals)}**.`,
    '',
    ballotBlocks,
    '',
    '---',
    '',
    `Session metering: ${formatUsage(input.usage)}.`,
    '',
  ].join('\n');
}
