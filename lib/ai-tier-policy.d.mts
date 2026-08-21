export function providerAllowed(tier: string, provider: string): boolean;
export function isEscalation(tier: string, provider: string): boolean;
export function verifyUser(supabaseUrl: string, anonKey: string, bearer: string | undefined): Promise<string | null>;
export function fetchMatterTier(supabaseUrl: string, serviceKey: string, matterId: string): Promise<string | null>;
export function gateLlmRequest(opts: {
  supabaseUrl?: string;
  anonKey?: string;
  serviceKey?: string;
  bearer?: string;
  provider: string;
  matterId?: string;
}): Promise<
  | { ok: true; userId: string; tier?: string; escalation: boolean }
  | { ok: false; status: number; error: string; tier?: string; provider?: string }
>;
