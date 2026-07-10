// Moot Bench data layer — oral-argument prep sessions, their transcripts,
// and sharing a finished transcript into a matter's Thread.
//
// All model calls go through the provider-agnostic adapter layer
// (src/lib/llm); nothing here names a provider. Persistence is plain
// Supabase with owner-only RLS (migration 034).

import { supabase } from '@/lib/supabase';

export interface PrepSource {
  name: string;
  content: string;
}

export interface PrepSession {
  id: string;
  owner_id: string;
  matterspace_id: string | null;
  title: string;
  model_id: string;
  sources: PrepSource[];
  bench_memo: string | null;
  status: 'memo' | 'prepping' | 'ended';
  created_at: string;
  updated_at: string;
}

export interface PrepMessage {
  id: string;
  session_id: string;
  role: 'bench' | 'counsel';
  content: string;
  created_at: string;
}

export async function listSessions(): Promise<PrepSession[]> {
  const { data, error } = await supabase
    .from('argument_prep_sessions')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as PrepSession[];
}

export async function getSession(id: string): Promise<PrepSession | null> {
  const { data, error } = await supabase
    .from('argument_prep_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PrepSession) ?? null;
}

export async function createSession(input: {
  title: string;
  modelId: string;
  matterspaceId: string | null;
  sources: PrepSource[];
}): Promise<PrepSession> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { data, error } = await supabase
    .from('argument_prep_sessions')
    .insert({
      owner_id: userId,
      title: input.title,
      model_id: input.modelId,
      matterspace_id: input.matterspaceId,
      sources: input.sources,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as PrepSession;
}

export async function updateSession(
  id: string,
  patch: Partial<Pick<PrepSession, 'bench_memo' | 'status' | 'matterspace_id' | 'model_id'>>,
): Promise<void> {
  const { error } = await supabase
    .from('argument_prep_sessions')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteSession(id: string): Promise<void> {
  const { error } = await supabase.from('argument_prep_sessions').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function listMessages(sessionId: string): Promise<PrepMessage[]> {
  const { data, error } = await supabase
    .from('argument_prep_messages')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as PrepMessage[];
}

export async function addMessage(
  sessionId: string,
  role: 'bench' | 'counsel',
  content: string,
): Promise<PrepMessage> {
  const { data, error } = await supabase
    .from('argument_prep_messages')
    .insert({ session_id: sessionId, role, content })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as PrepMessage;
}

/* ============================ Prompts ============================ */

export function benchMemoInstruction(): string {
  return [
    'You are preparing a candid bench memo for the lawyer who will argue this matter.',
    'From the documents provided, produce a memo with these sections:',
    '',
    '1. QUESTIONS PRESENTED — each issue the court must decide, stated neutrally.',
    '2. THE STRONGEST CASE AGAINST US — the best version of the opposing argument, argued honestly.',
    '3. WEAK POINTS — where our record, authority, or logic is thinnest; the concessions a careful advocate should be ready to make and cabin.',
    '4. LIKELY QUESTIONS FROM THE BENCH — the ten to fifteen questions a well-prepared, skeptical judge is most likely to ask, roughly in the order argument tends to reach them.',
    '5. SUGGESTED ANSWERS — for each question, the answer a strong advocate gives: direct first sentence, then the support, with record or authority cites where the documents supply them.',
    '',
    'Be specific to these documents — no generic advice. Where the documents identify the court, judge, or procedural posture, use it.',
  ].join('\n');
}

export function hotBenchSystem(session: PrepSession): string {
  const sources = session.sources
    .map((s) => `--- ${s.name} ---\n${s.content}`)
    .join('\n\n');
  return [
    'You are a hot bench — a skeptical, well-prepared appellate judge conducting a moot argument to prepare counsel for the real thing.',
    '',
    'Rules of the exercise:',
    '- Ask ONE question at a time. Never deliver two questions in a single turn.',
    '- Start with the weakest point of counsel\'s case, not a warm-up.',
    '- Press follow-ups: if counsel evades, dodges, or answers a different question, say so and re-ask. If counsel concedes too much, pursue the concession to its limit.',
    '- Interrupting is in character: if an answer opens a hole, cut to it.',
    '- Stay grounded in the record and authorities from the documents below. Quote them back at counsel where it stings.',
    '- Occasionally shift to a different issue without warning, the way a real bench does.',
    '- Brief asides of evaluation are allowed ("That answer will not survive Justice —\'s follow-up"), but stay in the exercise; do not lapse into a coaching monologue unless counsel asks for a time-out by saying "off the record".',
    '- When counsel says "off the record", step out of character, give frank coaching on the last few answers, then resume the bench when counsel says "back on the record".',
    '',
    session.bench_memo ? `The bench memo for this argument:\n\n${session.bench_memo}\n` : '',
    'The record and briefs:',
    '',
    sources,
  ].join('\n');
}

/* ====================== Transcript + sharing ====================== */

export function formatTranscript(session: PrepSession, messages: PrepMessage[]): string {
  const when = new Date(session.created_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  const lines = [
    `MOOT BENCH TRANSCRIPT — ${session.title}`,
    `Prepared ${when} · the bench: ${session.model_id}`,
    '',
  ];
  for (const m of messages) {
    lines.push(m.role === 'bench' ? 'THE COURT:' : 'COUNSEL:');
    lines.push(m.content.trim());
    lines.push('');
  }
  return lines.join('\n');
}

/** Post the transcript into the matter's Thread so the team can read it. */
export async function shareToThread(
  session: PrepSession,
  messages: PrepMessage[],
): Promise<void> {
  if (!session.matterspace_id) throw new Error('This session is not attached to a matter.');
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { error } = await supabase.from('matter_comments').insert({
    matterspace_id: session.matterspace_id,
    user_id: userId,
    parent_id: null,
    body: formatTranscript(session, messages),
  });
  if (error) throw new Error(error.message);
}
