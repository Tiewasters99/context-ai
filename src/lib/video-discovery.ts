import { supabase } from '@/lib/supabase';
import { parseRefusalBody } from '@/lib/llm/refusals';

// Session-authed bridge to /api/video-discovery — the Video Room's one door
// (migration 119). The server runs every read and write as the caller, so RLS
// decides what exists; this file only shapes the request and the error.

export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mpg', '.mpeg', '.avi', '.webm', '.wmv', '.3gp', '.m4v'];

export function isVideoFilename(name: string | null | undefined): boolean {
  const s = String(name ?? '').toLowerCase();
  const i = s.lastIndexOf('.');
  return i >= 0 && VIDEO_EXTENSIONS.includes(s.slice(i));
}

export type EventType =
  | 'BRIEFING' | 'ENTRY' | 'FORCE_CONTACT' | 'RESTRAINT_APPLIED' | 'POSITION_CHANGE'
  | 'VERBAL' | 'MEDICAL' | 'TRANSPORT' | 'CAMERA' | 'OTHER';
export type CoverageStatus = 'CLEAR' | 'PARTIAL' | 'OCCLUDED';
export type Position = 'PRONE' | 'SUPINE' | 'SIDE' | 'SEATED' | 'STANDING' | 'KNEELING' | 'CARRIED' | 'UNKNOWN';
export type Basis = 'visual' | 'audio' | 'both';
export type Confidence = 'high' | 'medium' | 'low';
export type ClaimFinding = 'CORROBORATES' | 'REFUTES' | 'CANNOT_DETERMINE_FROM_FOOTAGE';

export interface VideoActor {
  id: string; label: string; identifying_marks: string; role_observed: string; first_seen_sec: number;
}
export interface VideoEvent {
  start_sec: number; end_sec: number | null; type: EventType; actor_ids: string[];
  description: string; basis: Basis; confidence: Confidence; verbatim_quote: string | null;
}
export interface CoverageInterval {
  start_sec: number; end_sec: number; status: CoverageStatus; obstructed_by: string[]; what_is_not_visible: string;
}
export interface PositionInterval {
  start_sec: number; end_sec: number; position: Position; restrained: boolean; basis: Basis; confidence: Confidence;
}
export interface TranscriptLine { start_sec: number; speaker: string; text: string }
export interface EventGraph {
  video: { duration_sec: number | null; has_audio: boolean; camera_description: string };
  actors: VideoActor[];
  events: VideoEvent[];
  camera_coverage: CoverageInterval[];
  subject_position: PositionInterval[];
  transcript: TranscriptLine[];
}
export interface Measures {
  position_totals_sec: Record<string, number>;
  restrained_total_sec: number;
  coverage_sec: Record<CoverageStatus, number>;
  longest_position: { position: string; total_sec: number } | null;
  event_count: number;
  actor_count: number;
  low_confidence_events: number;
}

export type AnalysisStatus = 'queued' | 'running' | 'ready' | 'error' | 'held';
export interface VideoAnalysis {
  id: string;
  document_id: string;
  matterspace_id: string;
  status: AnalysisStatus;
  progress: number;
  progress_note: string | null;
  error: string | null;
  provider: string | null;
  model: string | null;
  event_graph: EventGraph | null;
  duration_sec: number | null;
  windows: number | null;
  media_expires_at: string | null;
  job_id: string | null;
  created_at: string;
  updated_at: string;
  measures?: Measures | null;
}
export interface VideoReview {
  id: string; analysis_id: string; status: 'reviewed' | 'problem'; note: string; initials: string; user_id: string; created_at: string;
}
export interface InterrogationResult {
  answer_markdown: string;
  cited_intervals: { start_sec: number; end_sec: number; what_is_seen: string }[];
  line_of_sight: { status: CoverageStatus; basis: string; what_cannot_be_seen: string };
  claim_assessments: { claim_text: string; finding: ClaimFinding; basis: string }[];
  limitations: string[];
  timestamps?: { sec: number; display: string }[];
}
export interface VideoInterrogation {
  id: string | null;
  analysis_id: string | null;
  question: string;
  start_sec: number | null;
  end_sec: number | null;
  claims: string[];
  result: InterrogationResult | null;
  outcome: 'ok' | 'provider_error' | 'media_expired' | 'refused';
  model: string | null;
  created_at: string;
}
export interface VideoRoomStatus {
  document: {
    id: string; title: string; source_filename: string | null; storage_path: string | null;
    matterspace_id: string; is_video: boolean; file_size_bytes: number | null;
  };
  analysis: VideoAnalysis | null;
  reviews: VideoReview[];
  interrogations: VideoInterrogation[];
}

export class VideoApiError extends Error {
  status: number;
  code: string;
  body: Record<string, unknown>;
  constructor(status: number, code: string, message: string, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) throw new VideoApiError(401, 'not_authenticated', 'Sign in to use the Video Room.', {});
  const res = await fetch('/api/video-discovery', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof data.error === 'string' ? data.error : `http_${res.status}`;
    const message = typeof data.message === 'string' && data.message
      ? data.message
      : parseRefusalBody(res.status, data as never, res.headers.get('retry-after')).message;
    throw new VideoApiError(res.status, code, message, data);
  }
  return data as T;
}

export const videoRoom = {
  status: (documentId: string) => call<VideoRoomStatus>({ action: 'status', document_id: documentId }),
  analyze: (documentId: string) => call<{ analysis: VideoAnalysis; job: { id: string } | null }>({ action: 'analyze', document_id: documentId }),
  interrogate: (documentId: string, args: { question: string; start_sec?: number | null; end_sec?: number | null; claims?: string[] }) =>
    call<{ interrogation: VideoInterrogation; recorded: boolean }>({ action: 'interrogate', document_id: documentId, ...args }),
  review: (documentId: string, args: { analysis_id: string; status: 'reviewed' | 'problem'; initials: string; note?: string }) =>
    call<{ review: VideoReview }>({ action: 'review', document_id: documentId, ...args }),
};

/** [mm:ss], or h:mm:ss past the hour. */
export function fmtTime(sec: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const rr = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}s`;
  return r ? `${m}m ${r}s` : `${m}m`;
}

/** "mm:ss", "h:mm:ss" or seconds → seconds, or null. */
export function parseTime(text: string): number | null {
  const t = text.trim().replace(/^\[|\]$/g, '');
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(':').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const n = parts.map(Number);
  return parts.length === 3 ? n[0] * 3600 + n[1] * 60 + n[2] : n[0] * 60 + n[1];
}

/** The latest review for an analysis, if any. */
export function latestReview(reviews: VideoReview[], analysisId: string | null | undefined): VideoReview | null {
  if (!analysisId) return null;
  return reviews.filter((r) => r.analysis_id === analysisId).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}
