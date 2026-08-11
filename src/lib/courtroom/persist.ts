// The Courtroom — persistence (migration 046). Plain Supabase under the
// matter's existing RLS; every row carries matterspace_id so the policy
// wrapper never joins. Everything stays in the matter (spec §2.4).

import { supabase } from '@/lib/supabase';
import { persistVaultFile, resolveMatter } from '@/lib/vault-persist';
import type {
  Ballot, DeliberationTurn, JurorProfile, MockTrial, Objection, PanelSize,
  Reaction, Ruling, Segment, SegmentKind, Side, Strike, TrialMode, TrialStatus,
  UsageRecord, VenueMix,
} from './types.ts';
import type { ExhibitConfigEvent, ExhibitEventRow, ExhibitSessionEvent } from './exhibits.ts';

export interface TrialListRow extends MockTrial {
  matterspace: { name: string } | null;
}

const TRIAL_SELECT = '*, matterspace:matterspaces(name)';

export async function listTrials(): Promise<TrialListRow[]> {
  const { data, error } = await supabase
    .from('mock_trials')
    .select(TRIAL_SELECT)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as TrialListRow[];
}

export async function getTrial(id: string): Promise<TrialListRow | null> {
  const { data, error } = await supabase
    .from('mock_trials')
    .select(TRIAL_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as TrialListRow) ?? null;
}

export async function createTrial(input: {
  matterspaceId: string;
  title: string;
  modelId: string;
  venueMix: VenueMix & { panel_size: PanelSize };
  seed: number;
  mode?: TrialMode;
}): Promise<TrialListRow> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { data, error } = await supabase
    .from('mock_trials')
    .insert({
      matterspace_id: input.matterspaceId,
      title: input.title,
      model_id: input.modelId,
      venue_mix: input.venueMix,
      seed: input.seed,
      mode: input.mode ?? 'quick',
      created_by: userId,
    })
    .select(TRIAL_SELECT)
    .single();
  if (error) throw new Error(error.message);
  return data as unknown as TrialListRow;
}

export async function updateTrial(
  id: string,
  patch: Partial<{ status: TrialStatus; title: string; model_id: string; usage: UsageRecord }>,
): Promise<void> {
  const { error } = await supabase
    .from('mock_trials')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteTrial(id: string): Promise<void> {
  const { error } = await supabase.from('mock_trials').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/* ================================ Jurors ================================== */

/** Persist a freshly sampled panel; assigns real UUIDs to the profiles. */
export async function saveJurors(
  trial: Pick<MockTrial, 'id' | 'matterspace_id'>,
  panel: JurorProfile[],
): Promise<JurorProfile[]> {
  const withIds = panel.map((j) => ({ ...j, id: crypto.randomUUID() }));
  const rows = withIds.map((j) => ({
    id: j.id,
    trial_id: trial.id,
    matterspace_id: trial.matterspace_id,
    seat: j.seat,
    profile: j,
    persona_sheet: j.voice.backstory,
  }));
  const { error } = await supabase.from('mock_trial_jurors').insert(rows);
  if (error) throw new Error(error.message);
  return withIds;
}

export async function listJurors(trialId: string): Promise<JurorProfile[]> {
  const { data, error } = await supabase
    .from('mock_trial_jurors')
    .select('id, seat, profile')
    .eq('trial_id', trialId)
    .order('seat', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({ ...(row.profile as JurorProfile), id: row.id, seat: row.seat }));
}

/** Drop the whole panel (used by "resample" before empanelment). */
export async function deleteJurors(trialId: string): Promise<void> {
  const { error } = await supabase.from('mock_trial_jurors').delete().eq('trial_id', trialId);
  if (error) throw new Error(error.message);
}

/** Reroll support: bump the stored seed so a resample stays reproducible. */
export async function updateTrialSeed(trialId: string, seed: number): Promise<void> {
  const { error } = await supabase
    .from('mock_trials')
    .update({ seed, updated_at: new Date().toISOString() })
    .eq('id', trialId);
  if (error) throw new Error(error.message);
}

/** Persist a lawyer's edit to one juror on the panel sheet. */
export async function updateJuror(juror: JurorProfile): Promise<void> {
  const { error } = await supabase
    .from('mock_trial_jurors')
    .update({ profile: juror, persona_sheet: juror.voice.backstory })
    .eq('id', juror.id);
  if (error) throw new Error(error.message);
}

/* =============================== Segments ================================= */

export async function addSegment(
  trial: Pick<MockTrial, 'id' | 'matterspace_id'>,
  input: {
    kind: SegmentKind; side: Side; transcript: string;
    position: number; sourceDocumentId?: string | null;
  },
): Promise<Segment> {
  const { data, error } = await supabase
    .from('mock_trial_segments')
    .insert({
      trial_id: trial.id,
      matterspace_id: trial.matterspace_id,
      kind: input.kind,
      side: input.side,
      transcript: input.transcript,
      position: input.position,
      source_document_id: input.sourceDocumentId ?? null,
    })
    .select('id, kind, side, transcript, position, source_document_id')
    .single();
  if (error) throw new Error(error.message);
  return data as Segment;
}

export async function listSegments(trialId: string): Promise<Segment[]> {
  const { data, error } = await supabase
    .from('mock_trial_segments')
    .select('id, kind, side, transcript, position, source_document_id')
    .eq('trial_id', trialId)
    .order('position', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Segment[];
}

export async function deleteSegment(id: string): Promise<void> {
  const { error } = await supabase.from('mock_trial_segments').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/* ===================== Session data (reactions/ballots) =================== */

export async function saveReaction(
  trial: Pick<MockTrial, 'id' | 'matterspace_id'>,
  r: Reaction,
): Promise<void> {
  const { error } = await supabase.from('mock_trial_reactions').upsert({
    trial_id: trial.id,
    matterspace_id: trial.matterspace_id,
    juror_id: r.juror_id,
    segment_id: r.segment_id,
    payload: { salience: r.salience, confusions: r.confusions, credibility: r.credibility, gut: r.gut },
  }, { onConflict: 'juror_id,segment_id' });
  if (error) throw new Error(error.message);
}

export async function saveBallot(
  trial: Pick<MockTrial, 'id' | 'matterspace_id'>,
  b: Ballot,
): Promise<void> {
  const { error } = await supabase.from('mock_trial_ballots').upsert({
    trial_id: trial.id,
    matterspace_id: trial.matterspace_id,
    juror_id: b.juror_id,
    round: b.round,
    leaning: b.leaning,
    conviction: b.conviction,
    reasons: b.reasons,
  }, { onConflict: 'juror_id,round' });
  if (error) throw new Error(error.message);
}

/** Objections, rulings, and strikes (Full Trial) land in mock_trial_events
 *  with the ¶ number on the span columns (paragraph granularity). */
export async function saveProcedureEvent(
  trial: Pick<MockTrial, 'id' | 'matterspace_id'>,
  e: Objection | Ruling | Strike,
  type: 'objection' | 'ruling' | 'strike',
): Promise<void> {
  const actor = type === 'objection' ? 'opposing_counsel' : 'judge';
  const { error } = await supabase.from('mock_trial_events').insert({
    trial_id: trial.id,
    matterspace_id: trial.matterspace_id,
    segment_id: e.segment_id,
    type,
    actor,
    payload: e,
    span_start: e.para,
    span_end: e.para,
  });
  if (error) throw new Error(error.message);
}

/** Deliberation turns land in mock_trial_events as type 'note' (Phase 1). */
export async function saveTurn(
  trial: Pick<MockTrial, 'id' | 'matterspace_id'>,
  t: DeliberationTurn,
): Promise<void> {
  const { error } = await supabase.from('mock_trial_events').insert({
    trial_id: trial.id,
    matterspace_id: trial.matterspace_id,
    type: 'note',
    actor: `${t.role}:${t.seat}`,
    payload: { round: t.round, juror_id: t.juror_id, responding_to: t.responding_to, speech: t.speech },
  });
  if (error) throw new Error(error.message);
}

/** Wipe a half-finished session so an interrupted run can restart cleanly.
 *  Exhibit CONFIG events (actor 'exhibit': registrations, the witness) are
 *  trial configuration, not session data — they survive the wipe. Session
 *  publication events (actor 'exhibit_session') go with everything else. */
export async function clearSessionData(trialId: string): Promise<void> {
  for (const table of ['mock_trial_reactions', 'mock_trial_ballots', 'mock_trial_reports']) {
    const { error } = await supabase.from(table).delete().eq('trial_id', trialId);
    if (error) throw new Error(error.message);
  }
  const { error } = await supabase
    .from('mock_trial_events')
    .delete()
    .eq('trial_id', trialId)
    .neq('actor', 'exhibit');
  if (error) throw new Error(error.message);
}

/* ================================ Exhibits ================================ */

/** Config events: registrations, edits, the witness. Survive session wipes. */
export async function saveExhibitConfigEvent(
  trial: Pick<MockTrial, 'id' | 'matterspace_id'>,
  payload: ExhibitConfigEvent,
): Promise<void> {
  const { error } = await supabase.from('mock_trial_events').insert({
    trial_id: trial.id,
    matterspace_id: trial.matterspace_id,
    type: 'note', // the table's type CHECK predates exhibits; actor carries the kind
    actor: 'exhibit',
    payload,
  });
  if (error) throw new Error(error.message);
}

/** A publication — session data, wiped with the run it happened in. */
export async function saveExhibitPublication(
  trial: Pick<MockTrial, 'id' | 'matterspace_id'>,
  payload: ExhibitSessionEvent,
  segmentId: string | null,
): Promise<void> {
  const { error } = await supabase.from('mock_trial_events').insert({
    trial_id: trial.id,
    matterspace_id: trial.matterspace_id,
    segment_id: segmentId,
    type: 'note',
    actor: 'exhibit_session',
    payload,
  });
  if (error) throw new Error(error.message);
}

/** All exhibit events in insertion order — the fold's input. */
export async function listExhibitEvents(trialId: string): Promise<ExhibitEventRow[]> {
  const { data, error } = await supabase
    .from('mock_trial_events')
    .select('actor, payload')
    .eq('trial_id', trialId)
    .in('actor', ['exhibit', 'exhibit_session'])
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as ExhibitEventRow[];
}

/* ================================ Report ================================== */

export async function saveReport(
  trial: Pick<MockTrial, 'id' | 'matterspace_id'>,
  markdown: string,
  documentId: string | null,
): Promise<void> {
  const { error } = await supabase.from('mock_trial_reports').upsert({
    trial_id: trial.id,
    matterspace_id: trial.matterspace_id,
    markdown,
    document_id: documentId,
  }, { onConflict: 'trial_id' });
  if (error) throw new Error(error.message);
}

export async function getReport(
  trialId: string,
): Promise<{ markdown: string; document_id: string | null } | null> {
  const { data, error } = await supabase
    .from('mock_trial_reports')
    .select('markdown, document_id')
    .eq('trial_id', trialId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

/**
 * File the Rehearsal Report into the matter as a real document through the
 * normal Vault upload path (documents row + storage + ingest), so it becomes
 * searchable record like everything else (spec §9). Returns the document id,
 * or null if the matter could not be resolved.
 */
export async function fileReportToMatter(
  trial: Pick<MockTrial, 'matterspace_id' | 'title'>,
  markdown: string,
): Promise<string | null> {
  const matter = await resolveMatter(trial.matterspace_id);
  if (!matter) return null;
  const safeTitle = trial.title.replace(/[\\/:*?"<>|]/g, '-');
  const file = new File(
    [markdown],
    `Rehearsal Report — ${safeTitle}.md`,
    { type: 'text/markdown' },
  );
  const { documentId } = await persistVaultFile(matter, file);
  return documentId;
}
