export type AiTier = 'A' | 'B' | 'C';

export function providerAllowed(tier: string, provider: string): boolean;
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
export function gateLlmRequest(opts: {
  supabaseUrl?: string;
  anonKey?: string;
  serviceKey?: string;
  bearer?: string;
  provider: string;
  matterId?: string;
}): Promise<
  | { ok: true; userId: string; tier?: AiTier; escalation: boolean }
  | { ok: false; status: number; error: string; tier?: AiTier; provider?: string }
>;
