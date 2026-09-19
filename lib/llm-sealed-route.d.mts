// Types for lib/llm-sealed-route.mjs — consumed by vite-claude-proxy.ts,
// which mirrors /api/llm's routing in dev. Same reason lib/ai-tier-policy.d.mts
// exists: the module is plain JS and the proxy is type-checked.

import type { AiTier } from './ai-tier-policy.d.mts';

export const SEALED_PROVIDER: 'aws-bedrock';

export interface SealedRefusalBody {
  error: 'sealed_pen_unavailable' | 'sealed_pen_error' | 'sealed_route_untranslatable';
  tier: AiTier;
  provider?: string;
  message: string;
}

export interface SealedPen {
  provider: 'aws-bedrock';
  model: string;
  label: string;
  route?: 'messages' | 'chat';
}

export type SealedRoute =
  | { refusal: { status: number; body: SealedRefusalBody } }
  | { pen: SealedPen; provider: 'aws-bedrock'; send: () => Promise<Response> };

export function sealedRouteFor(opts: {
  gate: { ok: boolean; error?: string; tier?: AiTier | null; status?: number };
  provider: string;
  model?: string;
  body: unknown;
  env?: Record<string, string | undefined>;
}): SealedRoute | null;
