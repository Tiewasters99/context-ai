// agent_charters — read/write, under the user's own RLS.
//
// A charter is a row the user owns: name, purpose, instructions, the tools
// it may use, and a trigger. Nothing here decides which model answers —
// that follows the matter's SecureSpace tier and is read-only in the UI.
//
// Migration 052 is hand-applied like every other migration in this repo, so
// the table may not exist yet on a given deployment. `isTableMissing()` lets
// the surface say "agent storage isn't enabled yet" plainly instead of
// throwing a PostgREST error at the user.

import { supabase } from '@/lib/supabase';

export type TriggerKind = 'on_demand' | 'schedule' | 'on_document';

export interface TriggerConfig {
  /** schedule: how often. */
  cadence?: 'daily' | 'weekdays' | 'weekly';
  /** schedule: local time of day, "HH:MM". */
  at?: string;
  /** on_document: what counts as a document landing. */
  scope?: 'matter';
}

export interface AgentCharter {
  id: string;
  owner_id: string;
  matterspace_id: string | null;
  name: string;
  purpose: string;
  instructions: string;
  allowed_tools: string[];
  trigger_kind: TriggerKind;
  trigger_config: TriggerConfig;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type CharterDraft = Pick<
  AgentCharter,
  'name' | 'purpose' | 'instructions' | 'allowed_tools' | 'trigger_kind' | 'trigger_config'
> & { matterspace_id: string | null; enabled: boolean };

const COLUMNS =
  'id, owner_id, matterspace_id, name, purpose, instructions, allowed_tools, trigger_kind, trigger_config, enabled, created_at, updated_at';

/** True when the failure is "migration 052 has not been applied here". */
export function isTableMissing(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === 'PGRST205' || e.code === '42P01') return true;
  const m = (e.message || '').toLowerCase();
  return m.includes('agent_charters') && (m.includes('does not exist') || m.includes('could not find'));
}

export class CharterStorageMissing extends Error {
  constructor() {
    super('agent_charters table not found');
    this.name = 'CharterStorageMissing';
  }
}

function normalise(row: Record<string, unknown>): AgentCharter {
  return {
    ...(row as unknown as AgentCharter),
    purpose: (row.purpose as string) ?? '',
    instructions: (row.instructions as string) ?? '',
    allowed_tools: Array.isArray(row.allowed_tools) ? (row.allowed_tools as string[]) : [],
    trigger_config: (row.trigger_config as TriggerConfig) ?? {},
  };
}

export async function listCharters(): Promise<AgentCharter[]> {
  const { data, error } = await supabase
    .from('agent_charters')
    .select(COLUMNS)
    .order('updated_at', { ascending: false });
  if (error) {
    if (isTableMissing(error)) throw new CharterStorageMissing();
    throw new Error(error.message);
  }
  return (data ?? []).map((r) => normalise(r as Record<string, unknown>));
}

export async function createCharter(draft: CharterDraft): Promise<AgentCharter> {
  // owner_id defaults to auth.uid() in the table; the insert policy carries
  // the author clause so INSERT..RETURNING passes the SELECT policy (047).
  const { data, error } = await supabase
    .from('agent_charters')
    .insert({
      matterspace_id: draft.matterspace_id,
      name: draft.name,
      purpose: draft.purpose,
      instructions: draft.instructions,
      allowed_tools: draft.allowed_tools,
      trigger_kind: draft.trigger_kind,
      trigger_config: draft.trigger_config,
      enabled: draft.enabled,
    })
    .select(COLUMNS)
    .single();
  if (error) {
    if (isTableMissing(error)) throw new CharterStorageMissing();
    throw new Error(error.message);
  }
  return normalise(data as Record<string, unknown>);
}

export async function updateCharter(id: string, draft: CharterDraft): Promise<AgentCharter> {
  const { data, error } = await supabase
    .from('agent_charters')
    .update({
      matterspace_id: draft.matterspace_id,
      name: draft.name,
      purpose: draft.purpose,
      instructions: draft.instructions,
      allowed_tools: draft.allowed_tools,
      trigger_kind: draft.trigger_kind,
      trigger_config: draft.trigger_config,
      enabled: draft.enabled,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(COLUMNS)
    .single();
  if (error) {
    if (isTableMissing(error)) throw new CharterStorageMissing();
    throw new Error(error.message);
  }
  return normalise(data as Record<string, unknown>);
}

export async function deleteCharter(id: string): Promise<void> {
  const { error } = await supabase.from('agent_charters').delete().eq('id', id);
  if (error) {
    if (isTableMissing(error)) throw new CharterStorageMissing();
    throw new Error(error.message);
  }
}

// ─── The pen a charter's matter implies ──────────────────────────────────
// Display only. The tier is enforced server-side (lib/ai-tier-policy.mjs)
// and is never a client choice — a charter that could pick its own model
// would be a hole in the seal. This mirrors the policy for the UI's benefit;
// the seal is INHERITED, so we walk the matter's ancestors the way the
// server does and take the strongest tier on the chain.

export type AiTier = 'A' | 'B' | 'C';

export interface PenForTier {
  tier: AiTier;
  label: string;
  detail: string;
}

const TIER_RANK: Record<AiTier, number> = { A: 0, B: 1, C: 2 };

export const PEN_BY_TIER: Record<AiTier, PenForTier> = {
  A: {
    tier: 'A',
    label: 'Claude Opus 4.8',
    detail: 'Tier A — US frontier. This matter is not sealed.',
  },
  B: {
    tier: 'B',
    label: 'Kimi K3, US-hosted, zero data retention',
    detail: 'Tier B — sealed. Claude only as a recorded escalation you ask for.',
  },
  C: {
    tier: 'C',
    label: 'No cloud model',
    detail: 'Tier C — Silo. Runs are refused until the Silo appliance is connected.',
  },
};

interface TierRow {
  id: string;
  parent_matterspace_id: string | null;
  ai_tier: AiTier | null;
}

/** The matter's effective tier: the strongest tier on its ancestor chain. */
export async function effectiveTier(matterId: string): Promise<AiTier | null> {
  let id: string | null = matterId;
  let tier: AiTier = 'A';
  const seen = new Set<string>();
  for (let depth = 0; id && depth < 32; depth++) {
    if (seen.has(id)) break;
    seen.add(id);
    const res = await supabase
      .from('matterspaces')
      .select('id, parent_matterspace_id, ai_tier')
      .eq('id', id)
      .maybeSingle();
    const row = res.data as TierRow | null;
    // ai_tier arrives with migration 051. Where it hasn't been applied the
    // column is missing: report null and let the caller say so plainly
    // rather than claiming Tier A.
    if (res.error || !row) return depth === 0 ? null : tier;
    const t: AiTier = row.ai_tier ?? 'A';
    if (TIER_RANK[t] > TIER_RANK[tier]) tier = t;
    id = row.parent_matterspace_id;
  }
  return tier;
}
