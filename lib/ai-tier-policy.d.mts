export type AiTier = 'A' | 'B' | 'C';

export function providerAllowed(
  tier: string,
  provider: string,
  opts?: { escalation?: boolean },
): boolean;
export function isEscalation(tier: string, provider: string): boolean;
export function isSealedTier(tier: string | null | undefined): boolean;
export function strongerTier(a: string | null | undefined, b: string | null | undefined): AiTier;
export function walkEffectiveTier(
  fetchRow: (id: string) => Promise<{ id: string; parent_matterspace_id: string | null; ai_tier: string | null } | null>,
  matterId: string,
): Promise<AiTier | null>;
export function verifyUser(supabaseUrl: string, anonKey: string, bearer: string | undefined): Promise<string | null>;
export function fetchMatterTier(supabaseUrl: string, serviceKey: string, matterId: string): Promise<AiTier | null>;
// `supabase` is a supabase-js client (user-scoped or service-role); typed
// loosely so this plain-JS module does not drag the SDK types into callers.
export function matterTierWithClient(supabase: unknown, matterId: string): Promise<AiTier | null>;
export function sealedMatterIds(supabase: unknown): Promise<Set<string>>;

/** The AI pause (migration 070). Inherited down the matter chain like the seal. */
export interface AiPause {
  paused: boolean;
  /** True when migration 070 is not in this database — treat as unpaused. */
  notDeployed?: boolean;
  /** Set only when the read itself failed; callers refuse on it. */
  error?: string;
  matterId?: string;
  matterName?: string | null;
  at?: string | null;
  by?: string | null;
  byName?: string | null;
  note?: string | null;
  /** True when the pause comes from an ancestor rather than this matter. */
  inherited?: boolean;
}
export function isPauseNotDeployed(error: unknown): boolean;
export function aiPausedMessage(pause: Pick<AiPause, 'byName' | 'at'> | null | undefined): string;
export function walkEffectivePause(
  fetchRow: (id: string) => Promise<Record<string, unknown> | null>,
  matterId: string,
): Promise<AiPause>;
export function fetchMatterPause(supabaseUrl: string, serviceKey: string, matterId: string): Promise<AiPause>;
export function matterPauseWithClient(supabase: unknown, matterId: string): Promise<AiPause>;
export function pausedMatterIds(supabase: unknown): Promise<{ ids: Set<string>; notDeployed: boolean }>;

export function gateLlmRequest(opts: {
  supabaseUrl?: string;
  anonKey?: string;
  serviceKey?: string;
  bearer?: string;
  provider: string;
  matterId?: string;
}): Promise<
  | { ok: true; userId: string; tier?: AiTier; escalation: boolean }
  | {
      ok: false; status: number; error: string; tier?: AiTier; provider?: string;
      /** Present on 'ai_paused' and 'ai_pause_unknown': the sentence to show. */
      message?: string;
      paused?: { by?: string | null; at?: string | null; matterId?: string; inherited?: boolean };
    }
>;
