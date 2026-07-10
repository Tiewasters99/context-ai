// Client helpers for the Contextspaces Mediation Center.
// All server calls go through POST /api/mediation with { action, ...payload },
// authenticated by the caller's Supabase Bearer JWT (the house convention).

import { supabase } from '@/lib/supabase';

export class MediationApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function medApi<T = unknown>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new MediationApiError('Not signed in.', 401);

  const res = await fetch('/api/mediation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new MediationApiError(body?.error || `Request failed (${res.status}).`, res.status);
  }
  return body as T;
}

/* ── Types — mirror serializeCaseForParty in lib/mediation-core.mjs ──────── */

export interface MediatorModelInfo {
  id: string;
  label: string;
  provider: 'anthropic' | 'openai';
  blurb: string;
  available: boolean;
}

export interface PartyMe {
  id: string;
  label: string;
  displayName: string;
  feePaid: boolean;
  intakeSummary: string | null;
  positionPaper: string | null;
  demand: string | null;
  analysis: string | null;
  caucusStartedAt: string | null;
}

export interface PartyOther {
  label: string;
  displayName: string;
  feePaid: boolean;
  intakeSubmitted: boolean;
  positionSubmitted: boolean;
  analysisSubmitted: boolean;
}

export interface CaseView {
  id: string;
  title: string;
  status: string;
  mediatorModel: string;
  feePaid: boolean;
  feesWaived: boolean;
  scheduledDate: string | null;
  schedulingRound: number;
  legalFramework: string | null;
  settlementDraft: string | null;
  attorneyReviewStatus: string | null;
  inviteCode?: string;
  createdAt: string;
  me: PartyMe;
  other: PartyOther | null;
}

export interface DocketCase {
  id: string;
  title: string;
  status: string;
  mediator_model: string;
  scheduled_date: string | null;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  party_id: string | null;
  channel: string;
  sender: string;
  content: string;
  created_at: string;
}

export interface Offer {
  id: string;
  terms: string;
  shared: boolean;
  status: string;
  created_at: string;
}

export interface RelayedOffer {
  id: string;
  terms: string;
  status: string;
  created_at?: string;
}

/* ── Display helpers ─────────────────────────────────────────────────────── */

export const MEDIATOR_LABELS: Record<string, string> = {
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-fable-5': 'Claude Fable 5',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.6-sol': 'GPT-5.6 Sol',
};

const STATUS_LABELS: Record<string, string> = {
  awaiting_party: 'Awaiting the other party',
  intake: 'Initial summaries',
  scheduling: 'Fixing the day',
  position_papers: 'Positions & demands',
  framework: 'The legal framework',
  analysis: 'Written analyses',
  pre_mediation: 'Confidential assessment',
  mediation_day: 'Mediation day',
  settlement_draft: 'Settlement draft',
  attorney_review: 'Attorney review',
  settled: 'Settled',
  unresolved: 'Concluded without agreement',
  closed: 'Closed',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] || status;
}

export function mediatorMonogram(label: string): string {
  return label
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function countWords(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

export function formatDateLong(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatDateShort(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
