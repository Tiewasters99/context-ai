// Types for lib/llm-record.mjs — consumed by vite-claude-proxy.ts, which
// mirrors /api/llm in dev. Same reason lib/llm-sealed-route.d.mts exists: the
// module is plain JS and the proxy is type-checked.

import type { LedgerActor, LedgerResult } from './ledger.d.mts';

export const LLM_FEATURES: readonly string[];
export const UNSPECIFIED_FEATURE: 'unspecified';

export function normalizeFeature(value: unknown): string;
export function newCallId(): string;

export interface LedgerRpcClient {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
}

export function ledgerClientFor(opts: {
  supabaseUrl?: string | null;
  anonKey?: string | null;
  bearer?: string | null;
  fetchImpl?: typeof fetch | null;
  timeoutMs?: number;
}): LedgerRpcClient | null;

export function llmExchangeUnrecordedMessage(): string;
export function exchangeUnrecordedRefusal(): {
  status: number;
  body: { error: 'exchange_unrecorded'; tier: 'B'; message: string };
};

/** Fields both rows share. */
interface LlmRecordCommon {
  matterId?: string | null;
  actor?: LedgerActor | null;
  feature: string;
  callId: string;
  tier?: string | null;
  provider?: string | null;
  model?: string | null;
  clientProvider?: string | null;
  clientModel?: string | null;
  sealed?: boolean;
  streaming?: boolean;
  byok?: boolean;
  documentIds?: unknown;
}

export function recordLlmRequested(
  client: LedgerRpcClient | null,
  o: LlmRecordCommon & {
    maxOutputTokens?: number | null;
    refused?: string | null;
    status?: number | null;
    strict?: boolean;
  },
): Promise<LedgerResult>;

export function recordLlmReceived(
  client: LedgerRpcClient | null,
  o: LlmRecordCommon & {
    outcome?: string;
    status?: number | null;
    tokens?: { input?: number | null; output?: number | null } | null;
    ms?: number | null;
  },
): Promise<LedgerResult>;
