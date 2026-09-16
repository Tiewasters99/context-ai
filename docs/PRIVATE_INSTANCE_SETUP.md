# Private instance setup — one firm, its own stack (W10)

**Date:** 2026-09-16 · **Status:** RUNBOOK v0 (not yet exercised; the first private instance is the first end-to-end run of this document and of the migrations folder) · **Why first:** it is the only coherent form of "the data never leaves the firm" for a buyer without an IT function (strategy 003 §4.2, §5.4).

A private instance is the same code, deployed under the firm's own accounts: its own Supabase project, its own Vercel project (or any Node host), its own Fly worker, its own model keys or its own AWS account with Bedrock retention pinned to `none`. Contextspaces sells software and configuration; the firm owns every account and every key. Whole stack is environment-variable configuration except the literals listed in §5.

## 0. Before the first instance: prove the migration chain

The live database is **not** the migrations folder (project_dev_environment_cautions: 020/021 were never applied to prod; RLS drifted at 047). A fresh project runs the folder for the first time ever. Do this before touching a customer project:

1. `npm i --no-save @electric-sql/pglite @electric-sql/pglite-pgvector` and write `scripts/_verify-migration-chain.mjs`: run every file in `supabase/migrations/` in order into PGlite; assert it completes; assert the table/column set equals what `_probe-schema-drift.mjs` sees in prod (diff both ways). Fix the chain until both hold. That script becomes a CI job (W4).
2. Migrations that touch older tables must `create table if not exists` the base table (cautions memory) so they apply to both prod and a fresh project.

## 1. Accounts the firm creates (the firm's names, the firm's cards)

| Account | Purpose | Notes |
|---|---|---|
| Supabase project (US region) | DB, auth, storage (`vault-documents` bucket) | Run the migration chain (§0). Enable pgvector. Create storage buckets per `supabase/` setup. |
| Vercel project (or Node host) | Site + `/api/*` incl. the MCP endpoint | Custom domain `<firm>.contextspaces.ai` or the firm's own domain. |
| Fly app | Worker (`fly.toml`: app name, region) | `flyctl launch` from `worker/Dockerfile`; secrets = §2. |
| AWS account | Bedrock pen (Opus 5 under `data_retention_mode: none`), Textract OCR (with Organizations AI opt-out set BEFORE the first job), SageMaker/embedding route (W8) | Follow `docs/BEDROCK_CLAUDE_PEN_SETUP.md` and `docs/SEALED_OCR_SETUP.md` and `docs/SEALED_EMBEDDINGS_SETUP.md` in the firm's account. Set retention `none` in **every Region** a pen uses (mantle AND classic planes). Run `scripts/_probe-bedrock-retention.mjs` and file the output in the firm's Record. |
| Google Cloud project | OAuth client (Calendar/Drive connections) + Gemini key for Tier A OCR/transcription if the firm allows Tier A | New OAuth client per instance: redirect URI is a literal in code (§5). |
| Optional: OpenAI, Anthropic first-party, Fireworks, xAI, Moonshot keys | Tier A pens the firm chooses to allow | A firm that wants sealed-only sets `serverspaces.default_ai_tier = 'B'` (the SecureSpaces door) and leaves these unset; missing keys refuse, never fall back. |
| Resend (email), Deepgram (meetings), Stripe (mediation) | Only if those modules are used | Each is a `PASTE` placeholder otherwise. |

## 2. Environment variables (inventory from the 09-16 code map)

Set in Vercel (site + api), Fly secrets (worker), and the operator's local `.env` for scripts. `PASTE` = absent; the code treats it as unset.

**Supabase:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (worker + api only, never the browser).
**Pens (any subset):** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `FIREWORKS_API_KEY`, `XAI_API_KEY`, `MOONSHOT_API_KEY`; model pins `CLAUDE_MODEL`, `CLAUDE_FLAG_MODEL`, `ANTHROPIC_OCR_MODEL`, `GEMINI_OCR_MODEL`, `OCR_TIER_A_ROUTES`.
**Bedrock pen:** `BEDROCK_AWS_ACCESS_KEY_ID`, `BEDROCK_AWS_SECRET_ACCESS_KEY`, `BEDROCK_AWS_SESSION_TOKEN` (optional), `BEDROCK_REGION`.
**Sealed embeddings (SageMaker or W8 route):** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (optional), `AWS_REGION`, `SAGEMAKER_VOYAGE_ENDPOINT` (or the W8 route's variables).
**Sealed OCR:** `TEXTRACT_AWS_ACCESS_KEY_ID`, `TEXTRACT_AWS_SECRET_ACCESS_KEY`, `TEXTRACT_AWS_SESSION_TOKEN` (optional), `TEXTRACT_AWS_REGION`, `TEXTRACT_AI_OPT_OUT_CONFIRMED=true` (only after the Organizations opt-out is set).
**OAuth / MCP:** `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `MCP_OAUTH_SECRET`, `MCP_SIGNING_KEY_ID`, `MCP_SIGNING_KEY_JWK_B64`, `CONNECTIONS_ENC_KEY` — **all freshly generated per instance**; never copy from another instance.
**Modules:** `RESEND_API_KEY`, `RESEND_FROM`, `GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD` (monitor mail), `DEEPGRAM_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `MEDIATION_FEE_CENTS`, `MEDIATION_FEE_WAIVED`.
**Deploy / tuning:** `SITE_ORIGIN` (the instance's URL), `WORKER_ID`, `JOB_TIMEOUT_MINUTES`, `EMBED_TPM_LIMIT`.

Reference points in code: `api/assistant.mjs:29-38`, `lib/assistant-core.mjs:114-122`, `lib/embed-routes.mjs:178`, `lib/ocr-routes.mjs:98`, `api/calendar-import.mjs:39-64`, `api/google-callback.mjs:45`, `api/student-hub-invite.mjs:113-130`, `api/mediation.mjs:271-281`, `worker/discovery-worker.mjs:77-92`, `lib/rate-limit.mjs:110`.

## 3. Instance policy (one row)

`serverspaces.default_ai_tier` + `entry_door` (09-10 roadmap): a firm that enters through the SecureSpaces door is born sealed; no matter can be unsealed by accident. Set at workspace creation. Verify with `_verify-assistant-tiers.mjs <apiBase>` against the new instance.

## 4. Deploy order

1. Supabase project → migration chain (§0) → buckets → first user via `scripts/_gen-recovery-link.mjs` pattern.
2. Vercel project → env vars → deploy → `node scripts/_verify-llm-gate.mjs <apiBase>` (gate closed to unauthenticated calls).
3. Fly worker → secrets → deploy → `node scripts/_smoke-ingest-feedback.mjs test-box` against the instance.
4. AWS: Bedrock pen runbook → retention `none` per Region → `_verify-bedrock-pen.mjs` live → `_probe-bedrock-retention.mjs`; Textract opt-out → `_proof-sealed-textract.mjs`; embedding route → `_verify-voyage-route.mjs` or W8's verifier.
5. Egress proof: `node scripts/_verify-seal-pipes.mjs` (offline) and the live re-tier proof from the seal-pipes memory, against the instance, fictional content only. File the outputs in the firm's Record.

## 5. Literals that must change per instance (code map 09-16)

These are hard-coded today; the W10 build turns each into `SITE_ORIGIN`/config so a second instance is env-only:

- `api/google-callback.mjs:27-28` `REDIRECT_URI`, `APP_CONNECTIONS`; `api/google-connect.mjs:24` same URI.
- `src/lib/connectorTokens.ts:43` `MCP_ENDPOINT_URL`.
- `api/student-hub-invite.mjs:38-39` `DEFAULT_FROM`, `HUB_URL`; `.env.example:8`.
- `src/reader/ReadingRoom.tsx:61` host regex; `src/App.tsx:79` subdomain boot; `src/pages/OAuthAuthorize.tsx:4`; `src/pages/mediation/MediationCenter.tsx:275`.
- `chrome-extension/background.js:13` `BASE`; `chrome-extension/manifest.json:25` host permission; `popup/popup.js:37` (the extension needs a per-instance build or a configurable base).
- `fly.toml:13-14` app name + region.
- No Supabase project-ref literal in shipped code (env-driven already).

## 6. What the firm gets in writing

The Record export (W5) for the instance: accounts and Regions, retention mode per pen (probe output), egress harness results, migration chain proof, and the statement the seal-pipes work licenses: "No third party outside the firm's own accounts received matter content; every model that processed sealed content ran under a zero-retention mode verified from the provider's catalog."

## 7. Kickoff prompt (Opus session, W10)

"Read `docs/PRIVATE_INSTANCE_SETUP.md`. (1) Write `scripts/_verify-migration-chain.mjs` per §0 and make the chain pass in PGlite; fix migrations that fail on a fresh project with `if not exists` guards only (no behavior changes). (2) Replace the §5 literals with `SITE_ORIGIN`/config reads, defaulting to today's values so prod is byte-identical. (3) Add `docs/PRIVATE_INSTANCE_SETUP.md` corrections you discover. One PR; fresh worktree; no Co-Authored-By."
