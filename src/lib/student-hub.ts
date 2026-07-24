// Student Hub data layer — casebook reading sessions, generated study aids
// (case brief + section outline), and the Socratic cold-call transcript.
//
// All model calls go through the provider-agnostic adapter layer
// (src/lib/llm); nothing here names a provider. Persistence is plain
// Supabase with owner-only RLS (migration 037).
//
// Copyright guardrail (docs/student-hub/student-hub-design.md): the reading
// is the student's own scanned casebook. It stays locked to their account,
// and every generation prompt instructs the model to paraphrase editorial
// matter and keep quotation to short phrases — derived artifacts are the
// student's work product; the scan itself is never reproduced.

import { supabase } from '@/lib/supabase';
import { generateStructured, type LLMMessage } from '@/lib/llm';

export interface BriefField {
  label: string;
  content: string;
}

export interface OutlineSection {
  heading: string;
  items: string[];
}

/** A page highlight, as fractions of the page image (resolution-independent). */
export interface Highlight {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Resource {
  title: string;
  url: string;
}

export interface OutlineMark {
  note?: string;
  refs?: { id: string; title: string }[];
}

/**
 * The student's layer on a generated outline, keyed by position so the
 * outline itself can be regenerated without losing the layer:
 * marks["2.4"] = section 2, item 4; custom["2"] = the student's own
 * points appended to section 2.
 */
export interface OutlineAnnotations {
  marks?: Record<string, OutlineMark>;
  custom?: Record<string, string[]>;
}

export interface StudyText {
  id: string;
  owner_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface StudySession {
  id: string;
  owner_id: string;
  /** The text (scanned casebook/chapter) this reading belongs to; null = loose reading from the shelf. */
  text_id: string | null;
  chapter: string;
  section: string;
  kind: 'case' | 'material';
  sort: number;
  title: string;
  citation: string;
  source_label: string;
  reading: string;
  /** Ordered storage paths of the scanned pages backing this reading, if any. */
  pages: string[] | null;
  brief: BriefField[] | null;
  outline: OutlineSection[] | null;
  notes: string;
  highlights: Highlight[];
  annotations: OutlineAnnotations;
  resources: Resource[];
  model_id: string;
  created_at: string;
  updated_at: string;
}

export interface StudyMessage {
  id: string;
  session_id: string;
  role: 'professor' | 'student';
  content: string;
  created_at: string;
}

export const DEFAULT_MODEL_ID = 'claude-opus-4-8';

// Private bucket; objects live under the owner's uid folder and RLS keeps
// them owner-only (migration 038) — the scan never leaves the account.
export const SCAN_BUCKET = 'student-hub-scans';

/** Short-lived signed URLs for a session's scanned pages, in reading order. */
export async function getPageUrls(paths: string[]): Promise<string[]> {
  const { data, error } = await supabase.storage
    .from(SCAN_BUCKET)
    .createSignedUrls(paths, 3600);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((d) => d.signedUrl)
    .filter((u): u is string => !!u);
}

/* ============================ CRUD ============================ */

export async function listTexts(): Promise<StudyText[]> {
  const { data, error } = await supabase
    .from('student_hub_texts')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as StudyText[];
}

/** All readings of one text, in shelf order (chapter/section grouping is by field). */
export async function listReadings(textId: string): Promise<StudySession[]> {
  const { data, error } = await supabase
    .from('student_hub_sessions')
    .select('*')
    .eq('text_id', textId)
    .order('sort', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as StudySession[];
}

/** Which of these readings have cold-call transcripts under way. */
export async function sessionsWithTranscripts(sessionIds: string[]): Promise<Set<string>> {
  if (!sessionIds.length) return new Set();
  const { data, error } = await supabase
    .from('student_hub_messages')
    .select('session_id')
    .in('session_id', sessionIds);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((r) => r.session_id as string));
}

/** Loose readings only — filed from the shelf, not part of any text. */
export async function listSessions(): Promise<StudySession[]> {
  const { data, error } = await supabase
    .from('student_hub_sessions')
    .select('*')
    .is('text_id', null)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as StudySession[];
}

export async function getSession(id: string): Promise<StudySession | null> {
  const { data, error } = await supabase
    .from('student_hub_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as StudySession) ?? null;
}

export async function createSession(input: {
  title: string;
  citation: string;
  sourceLabel: string;
  reading: string;
  modelId: string;
}): Promise<StudySession> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { data, error } = await supabase
    .from('student_hub_sessions')
    .insert({
      owner_id: userId,
      title: input.title,
      citation: input.citation,
      source_label: input.sourceLabel,
      reading: input.reading,
      model_id: input.modelId,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as StudySession;
}

export async function updateSession(
  id: string,
  patch: Partial<Pick<StudySession,
    'title' | 'citation' | 'source_label' | 'brief' | 'outline' | 'model_id' |
    'notes' | 'highlights' | 'annotations' | 'resources'>>,
): Promise<void> {
  const { error } = await supabase
    .from('student_hub_sessions')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteSession(id: string): Promise<void> {
  const { error } = await supabase.from('student_hub_sessions').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export type MessageThread = 'coldcall' | 'ask';

export async function listMessages(
  sessionId: string,
  thread: MessageThread = 'coldcall',
): Promise<StudyMessage[]> {
  const { data, error } = await supabase
    .from('student_hub_messages')
    .select('*')
    .eq('session_id', sessionId)
    .eq('thread', thread)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as StudyMessage[];
}

export async function addMessage(
  sessionId: string,
  role: 'professor' | 'student',
  content: string,
  thread: MessageThread = 'coldcall',
): Promise<StudyMessage> {
  const { data, error } = await supabase
    .from('student_hub_messages')
    .insert({ session_id: sessionId, role, content, thread })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as StudyMessage;
}

/** Every reading across the library — for cross-references between cases. */
export async function listAllReadings(): Promise<Pick<StudySession, 'id' | 'title' | 'kind' | 'citation'>[]> {
  const { data, error } = await supabase
    .from('student_hub_sessions')
    .select('id,title,kind,citation')
    .not('text_id', 'is', null)
    .order('sort', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Pick<StudySession, 'id' | 'title' | 'kind' | 'citation'>[];
}

/* ==================== Caption extraction ==================== */

const PARAPHRASE_RULE =
  'The reading is the student\'s own scanned casebook. Paraphrase editorial matter; ' +
  'quote only short, pointed phrases (a sentence at most) where the exact words carry legal weight.';

/** Pull the case caption out of a pasted reading so the student doesn't type it. */
export async function extractCaption(
  modelId: string,
  reading: string,
  signal?: AbortSignal,
): Promise<{ title: string; citation: string; source_label: string }> {
  return generateStructured({
    modelId,
    signal,
    system:
      'You identify the principal case in a law-school casebook reading and return its caption. ' +
      'If several cases appear, the principal case is the first one set out at length.',
    userContent: reading.slice(0, 8000),
    toolName: 'record_caption',
    toolDescription: 'Record the caption of the principal case in this reading.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Case name, e.g. "Hawkins v. McGee". If no case, a short title for the reading.',
        },
        citation: {
          type: 'string',
          description: 'Reporter citation and year, e.g. "84 N.H. 114, 146 A. 641 (1929)". Empty if none.',
        },
        source_label: {
          type: 'string',
          description: 'Short provenance line if the text reveals one (chapter/section), else empty.',
        },
      },
      required: ['title', 'citation', 'source_label'],
    },
    maxTokens: 400,
  });
}

/* ======================= Study aids ======================= */

export async function generateBrief(
  session: StudySession,
  signal?: AbortSignal,
): Promise<BriefField[]> {
  const result = await generateStructured<{ fields: BriefField[] }>({
    modelId: session.model_id,
    signal,
    system: [
      'You prepare a classic case brief for a first-year law student, from the casebook reading they provide.',
      'Field labels: Citation, Facts, Procedural posture, Issue and Holding (one pair per issue, numbered when there are several),',
      'Reasoning, Key move (the analytical move the professor will press on), Disposition — and, when the reading pairs the',
      'principal case with others or with commentary, a final "Pair with" field connecting them.',
      'Be specific to this reading; no generic filler. Write in complete sentences a student could speak aloud in class.',
      PARAPHRASE_RULE,
    ].join(' '),
    userContent: session.reading,
    toolName: 'record_brief',
    toolDescription: 'Record the case brief as ordered label/content fields.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['label', 'content'],
          },
        },
      },
      required: ['fields'],
    },
    maxTokens: 4096,
  });
  return result.fields;
}

export async function generateOutline(
  session: StudySession,
  signal?: AbortSignal,
): Promise<OutlineSection[]> {
  const result = await generateStructured<{ sections: OutlineSection[] }>({
    modelId: session.model_id,
    signal,
    system: [
      'You prepare a section outline of a casebook reading for a first-year law student — the skeleton they will fold',
      'into their course outline. Roman-numeral section headings (include the numeral in the heading text); under each,',
      'tight entries a student can review in the minutes before class. Cover the doctrine, the principal case\'s moves,',
      'any paired case or commentary, and end with a section anticipating the hypotheticals a professor would pose.',
      'Use the vocabulary of the reading itself; gloss any term of art the reading does not define.',
      PARAPHRASE_RULE,
    ].join(' '),
    userContent: session.reading,
    toolName: 'record_outline',
    toolDescription: 'Record the section outline.',
    inputSchema: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string' },
              items: { type: 'array', items: { type: 'string' } },
            },
            required: ['heading', 'items'],
          },
        },
      },
      required: ['sections'],
    },
    maxTokens: 4096,
  });
  return result.sections;
}

/* ====================== The professor ====================== */

// Minimal prompt, maximal context (design doc): brief situational framing
// plus the student's own reading. Socratic by default; follows the student
// into tutoring and back.
export function professorSystem(session: StudySession): string {
  return [
    'You are helping a first-year law student prepare for class on the reading below, which the student scanned',
    'from their own casebook. Default to Socratic questioning, as their professor would: one question at a time,',
    'then wait. But follow the student\'s lead — if they say they don\'t understand, shift into explanation and work',
    'it through with them until it is solid, then pick the questioning back up. The goal is that they walk into',
    'class genuinely prepared.',
    PARAPHRASE_RULE,
    '',
    'The reading:',
    '',
    session.reading,
  ].join('\n');
}

// The study aide answers directly — the counterpoint to the Socratic
// professor. It handles vocabulary, procedure, and legal history ("what is
// an action in assumpsit?") and ties them to modern law.
export function aideSystem(session: StudySession): string {
  return [
    'You are the study aide at a first-year law student\'s elbow while they read their casebook. Unlike their',
    'professor, you answer directly and plainly — no Socratic games. When the question is about vocabulary,',
    'procedure, or legal history (an action in assumpsit, a writ, a nonsuit, a remittitur), explain what it was',
    'and what it corresponds to today. When the question is about the reading, ground your answer in it.',
    'Keep answers short and precise; go deeper only when asked.',
    PARAPHRASE_RULE,
    '',
    'The reading:',
    '',
    session.reading,
  ].join('\n');
}

// The cold call opens with a fixed student line so the professor speaks
// first — same device as Moot Bench's OPENING.
export const COLD_CALL_OPENING: LLMMessage = {
  role: 'user',
  content: '(The student takes a seat in the front row and opens the casebook.) I\'m ready to be called on.',
};

export function professorHistory(messages: StudyMessage[]): LLMMessage[] {
  return [
    COLD_CALL_OPENING,
    ...messages.map((m): LLMMessage => ({
      role: m.role === 'professor' ? 'assistant' : 'user',
      content: m.content,
    })),
  ];
}

/* ======================= Transcript ======================= */

export function formatTranscript(session: StudySession, messages: StudyMessage[]): string {
  const when = new Date(session.created_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  const lines = [
    `COLD CALL — ${session.title}`,
    session.citation ? session.citation : null,
    `Prepared ${when}`,
    '',
  ].filter((l): l is string => l !== null);
  for (const m of messages) {
    lines.push(m.role === 'professor' ? 'THE PROFESSOR:' : 'THE STUDENT:');
    lines.push(m.content.trim());
    lines.push('');
  }
  return lines.join('\n');
}
