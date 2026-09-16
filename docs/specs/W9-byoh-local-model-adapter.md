# W9 — Bring-your-own-hardware local model adapter (Tier C, step 1)

**Date:** 2026-09-16 · **Status:** SPEC for an Opus build session · **Sequence:** after the private-instance runbook (W10) is real for at least one firm; before any appliance conversation.
**Origin:** Eden's 08-13 local-models thesis (Ollama installed 08-12), re-sequenced 09-16 (strategy 003 §5.4): private instance → BYOH adapter → partner appliance.

## 1. What it is

A provider named `local` in the model registry whose adapter talks to an OpenAI-compatible endpoint on the user's own machine or LAN (Ollama `http://localhost:11434/v1`, vLLM, llama.cpp server, LM Studio all speak it). Tier C ("Silo") permits `local` and nothing else, so a Tier C matter's chat, Editor pass, cite-check reasoning and search-query embedding run on hardware the firm controls. Desktop-only by nature; the phone cannot reach the PC.

What it is **not**: full siloing. Ingest embeddings, OCR and transcription run on the server (Fly worker / Vercel) and cannot reach the user's localhost. Tier C ingest therefore stays `held` until the W8 embedding route exists in a form the firm hosts (private instance) or until a server-side local route exists. Say this in the UI: "This matter's chat runs on your machine. Documents are indexed by words only until a sealed index is configured."

## 2. Transport: browser-direct, not through `/api/llm`

Vercel functions cannot reach the user's localhost. The adapter calls the local endpoint **from the browser**. Localhost is exempt from mixed-content blocking, so `https://contextspaces.ai` → `http://localhost:11434` works; Ollama must be started with `OLLAMA_ORIGINS=https://www.contextspaces.ai` (document this; the settings panel shows the exact line).

Consequence for the gate: today every model call goes through `/api/llm`, which reads the matter's tier from the DB and refuses disallowed providers server-side. A browser-direct call bypasses that path, so the server-side guarantee for Tier C is different in kind: **the server refuses every cloud provider for a Tier C matter (already true: `TIER_PROVIDERS.C = ∅`), and the client's only permitted path is local.** The client cannot be made to prove it used local; it can be prevented from using anything else. That is the same shape as the seal (server-side refusal of egress), and it is the honest claim: "no cloud model can be used on this matter through the platform."

Ledger: browser-direct calls still write `ai_sessions`/`ai_messages` through the user-scoped client (as Tier A/B do), with `provider: 'local'`, `model: <name reported by the endpoint>`, `endpoint_host: 'localhost'`. W1's `completion.received` event carries the same.

## 3. Changes (from the 09-16 code map)

| File | Change |
|---|---|
| `src/lib/llm/types.ts:42` | `ProviderId` union += `'local'` |
| `src/lib/llm/providers.ts` | New entry `{ id: 'local', name: 'Your machine', models: [] }` — models are **discovered** at runtime from `GET {base}/v1/models` (Ollama lists pulled models); cache in localStorage; `tier: 'local'` |
| `src/lib/llm/adapters.ts:231-238` | `local` adapter = the OpenAI-compatible adapter (chat completions, streaming, tools where the endpoint supports them; structured output via JSON mode with a fallback parse) |
| `src/lib/llm/generate.ts:81`, `converse.ts:41`, `structured.ts:40` | If `provider === 'local'`: POST to `${localBase}/v1/chat/completions` directly instead of `/api/llm`; still send `matterId` to a new lightweight `/api/llm-attest` that only checks the matter's tier permits `local` (so a Tier A/B matter cannot be quietly run on an unknown local model either — the tier decides both ways) |
| `lib/ai-tier-policy.mjs:59-63` | `TIER_PROVIDERS.C = new Set(['local'])`; `A` += `'local'` (a user may prefer local for an unsealed matter too); `B` unchanged (sealed = verified zero-retention pens only; a local model is *more* private but unverifiable by the server, so it is C's, not B's) |
| `vite-claude-proxy.ts` | No change needed for browser-direct; add nothing |
| Settings → Connections page | "Local model endpoint" card: base URL (default `http://localhost:11434`), Test button (calls `/v1/models`, shows the list), the `OLLAMA_ORIGINS` line to copy, status dot. Discreet, in the existing Connections page. |
| Matter menu | Tier C ("Silo") becomes selectable once a local endpoint tests OK; the SealMatterModal explains the ingest limitation in one sentence |

## 4. Proof

`scripts/_verify-local-adapter.mjs` (offline, stubbed fetch): request shape to `/v1/chat/completions`; streaming parse; `matterId` attestation call happens before the local call; Tier A/B/C matrix (C refuses every cloud provider; A permits local; B refuses local); ledger row shape. Manual: Ollama with any small model, a Tier C fixture matter, one chat turn, `_verify-seal-pipes.mjs` still SEALED.

## 5. Kickoff prompt (Opus session)

"Read `docs/specs/W9-byoh-local-model-adapter.md`. Build the `local` provider exactly as specified: types, registry with runtime model discovery, adapter, browser-direct transport with the `/api/llm-attest` tier check, tier policy change, Connections card, Silo selectable. Prove with `_verify-local-adapter.mjs`. Fresh worktree; one PR; no Co-Authored-By. Do not change `/api/llm` routing for any other provider."
