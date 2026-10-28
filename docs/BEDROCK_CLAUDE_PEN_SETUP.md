# Sealed chat pen: Claude Opus 5 via Bedrock, in our own AWS account

> **2026-10-20 status — the sealed default is now Claude Opus 4.6.** AWS opened
> Opus 4.6 to this account on the **classic Bedrock runtime**
> (`bedrock-runtime.<region>.amazonaws.com`), through the `us.` geographic
> inference profile `us.anthropic.claude-opus-4-6-v1` (the base id refuses
> on-demand calls). Opus 4.6 is not in the bedrock-mantle catalog, and every
> Claude id on mantle — like the whole Claude 5 generation on both planes — is
> still "not available for this account". So the default pen is
> `PENS.bedrockRuntime` (route `invoke`, `lib/bedrock-runtime.mjs`):
> InvokeModelWithResponseStream, SigV4 service `bedrock`, the Messages body
> with `anthropic_version: bedrock-2023-05-31`, AWS event-stream framing.
> Live-verified 2026-10-21 with the pen's own key: a two-round tool turn with
> adaptive thinking, and `scripts/_verify-bedrock-pen.mjs`'s live section.
>
> **What the seal claims on this route** (AWS "Data retention" and "Abuse
> detection" pages, read 2026-10-20; re-verify before anything client-facing):
>
> - The account retention mode is set **per Region** and governs bedrock-runtime
>   as well as mantle; the runtime's setting is read and written on the Bedrock
>   control plane (`GET/PUT https://bedrock.<region>.amazonaws.com/data-retention`).
>   This account: **`none` in us-east-1** (both planes); us-east-2 and us-west-2
>   are `inherit`. The live verify reads it with the pen's own key and fails
>   unless it is `none`.
> - AWS: "There is no data retention change to Claude models released before
>   Claude Fable 5", and Opus 4.6 is not among the models whose traffic it
>   retains for abuse detection.
> - **Residency changes from single-Region to US-only.** A `us.` profile
>   processes in us-east-1, us-east-2 or us-west-2 ("Geographic cross-Region
>   inference"); CloudTrail in us-east-1 records the Region that served each
>   call (`additionalEventData.inferenceRegion`). `global.` profiles route
>   worldwide and the code deliberately never sends one to the runtime.
>   Recommended: set `none` in us-east-2 and us-west-2 as well (one control-plane
>   PUT per Region, owner credentials — the pen key cannot write it).
> - Opus 4.6 is not frontier, so a sealed `escalate: true` still goes to
>   first-party Claude and is recorded as an escalation, exactly as with Kimi.
>
> **Access, as it happened:** the first calls on 2026-10-20 succeeded, then
> lapsed with "not authorized to perform the required AWS Marketplace actions"
> (the account's Marketplace subscription had not completed); AWS accepted the
> Opus 4.6 request and it has answered since 2026-10-21. Opus 4.6 in us-west-2,
> Haiku 4.5 and Sonnet 4.5/4.6 still return that Marketplace error. The pen key
> stays invoke-only — it is never given Marketplace permissions.
>
> `BEDROCK_MODEL` unset = Opus 4.6. `moonshotai.kimi-k2.5` selects the previous
> default (status below); `anthropic.claude-opus-5` the mantle Messages route.

> **2026-09-18 status (superseded 2026-10-20, above).** The Claude 5 generation (Opus 5 / 4.8 / 4.7, Sonnet 5) is
> account-gated on Bedrock for this account on both planes and both Regions
> ("not available for this account… contact AWS Sales"; support case
> 178785685000654; `docs/strategy/004`, "Invoke tests 2026-09-18"). Until AWS
> lifts it, the sealed pen defaults to **Kimi K2.5** (`moonshotai.kimi-k2.5`) on
> the same account under the same `data_retention_mode: none`, through the
> OpenAI-compatible `/v1/chat/completions` route on bedrock-mantle (verified:
> answers and drives the tool loop). Set `BEDROCK_MODEL=anthropic.claude-opus-5`
> to return to the Messages route when access lands; nothing else changes.
> While the sealed pen is not frontier Claude, `escalate` is a recorded
> escalation to first-party Claude again. Everything below describes the
> Claude configuration.

Built 2026-08-27 (pen upgraded 4.8 → Opus 5 same day — Eden's call: Opus 5 is
the stronger legal-reasoning model; 4.8 remains the Tier-A writing pen).
Tier-B (sealed) matters chat through **Claude Opus 5 on Amazon Bedrock's
Messages API** (`bedrock-mantle.us-east-1.api.aws`) in our
own AWS account, with the account pinned to **`data_retention_mode: none`** —
contractual zero retention: no request or response is written to durable
storage by AWS or shared with the model provider. This replaces both halves of
the old Tier-B arrangement at once: the sealed pen becomes *frontier* Claude
instead of Kimi, and the escalation path to `api.anthropic.com` (which retains
for 30 days) becomes unreachable.

Two properties worth stating to a client, both verified against AWS's
data-retention documentation on 2026-08-27 (re-verify before anything
client-facing):

- Under mode `none`, Messages requests are **never retained** — and the
  account **structurally cannot invoke** a model that requires retention
  (e.g. Claude Fable 5 lists as `unavailable`). The seal is enforced by AWS
  against our own future convenience, not remembered by us.
- The **regional** endpoint pins processing to `us-east-1` (10% price premium
  over the global endpoint — the pen's ledger prices carry it). The global
  endpoint routes worldwide; we deliberately do not use it.

The code is fully wired and fail-closed. **Since 2026-09-19 "fail-closed"
means exactly that: until the credentials below exist, a Tier-B matter is
REFUSED — in plain language, with nothing sent anywhere.** There is no
Fireworks fallback and no implicit escalation to `api.anthropic.com`; a key
for some other provider is not a sealed pen (Eden's decision: refuse, don't
fall back). On a development checkout with no `BEDROCK_` keys, sealed matters
therefore have no AI at all, and the refusal says so. **The cutover is one
retention setting + one IAM user + three env vars. No code changes.**

## Provisioning (Eden, one time, ~20 minutes)

Same AWS account as the embeddings work: **Contextspaces (956035085448)**,
us-east-1. Bedrock is serverless — no endpoint, no instance, no quota case.

1. **Model access.** Unlike 4.8 (open to all Bedrock customers), **Opus 5 is
   access-gated** — request it. Easiest route: Bedrock console → **Model
   catalog** → open the **Claude Opus 5** card → **Request model access** →
   short use-case form → Submit. (The classic page also works:
   `console.aws.amazon.com/bedrock/home?region=us-east-1#/modelaccess`.)
   Retention facts verified 2026-08-27 by live probe in this account: Opus 5
   and 4.8 both list `none` in `allowed_modes`; Fable/Mythos 5 do not.

2. **Pin the account to zero retention.** There is no console UI for this at
   launch — it is one API call. From CloudShell in the console (it already
   has your admin credentials), or any shell with admin keys:

   ```bash
   # short-term bearer token for the call (12h max, admin identity)
   export AWS_BEARER_TOKEN_BEDROCK=$(aws-bedrock-token-generator get-token 2>/dev/null || true)
   curl -X PUT https://bedrock.us-east-1.amazonaws.com/data-retention \
     -H "Authorization: Bearer $AWS_BEARER_TOKEN_BEDROCK" \
     -H "Content-Type: application/json" \
     -d '{ "mode": "none" }'
   ```

   (If the token generator isn't installed, the same PUT exists on the
   bedrock-mantle plane at `/v1/data_retention` with an `x-api-key` header.)

   **Consequence, deliberate:** with mode `none`, this account can never
   invoke a model whose only allowed mode is `provider_data_share` (Claude
   Fable 5, Claude Mythos 5). Nothing in Contextspaces uses those from this
   account, and refusing them structurally is the point. Later, an
   Organizations SCP can deny `bedrock:PutAccountDataRetention` unless
   `bedrock:DataRetentionMode` is `none`, so nobody can quietly relax it.

3. **Invoke-only credentials.** IAM → create a user `contextspaces-bedrock`
   with a single inline policy — invoke plus the two read actions the verify
   harness uses to *prove* the retention mode:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": [
         "bedrock-mantle:CreateInference",
         "bedrock-mantle:GetModel",
         "bedrock-mantle:GetAccountDataRetention"
       ],
       "Resource": "*"
     }]
   }
   ```

   Create an access key for it. This key can ask Claude questions and read
   the retention configuration — nothing else. (Once the console shows the
   Opus 5 model ARN, narrow `CreateInference`'s Resource to it.)

4. **Env vars, two places** (`.env` already carries the PASTE placeholders;
   the Fly worker does not chat, so it needs nothing):

   | Var | Value |
   |---|---|
   | `BEDROCK_AWS_ACCESS_KEY_ID` | from step 3 |
   | `BEDROCK_AWS_SECRET_ACCESS_KEY` | from step 3 |
   | `BEDROCK_REGION` | `us-east-1` (the default if unset) |

   - Local `.env` (replace the placeholders — never paste keys into chat)
   - Vercel → Project → Settings → Environment Variables → redeploy

   These are deliberately NOT the `AWS_ACCESS_KEY_ID` pair: that key is
   invoke-only on the SageMaker voyage endpoint and cannot call Bedrock.

5. **Verify.**

   ```
   node scripts/_verify-bedrock-pen.mjs
   ```

   The offline sections always run (pen choice, wire shape, egress
   hostnames). With the keys present, the live section reads the model's
   effective `data_retention_mode` through the pen's own key — it FAILS
   unless the mode is `none`, so a half-done step 2 cannot pass — and makes
   one one-line real invoke. Then, against prod after the Vercel deploy:

   ```
   node scripts/_verify-assistant-tiers.mjs
   ```

## What changes when it goes live

- Sealed (Tier B) chat runs on Claude Opus 5 with zero retention in our
  account. The ledger stamps `provider: 'aws-bedrock'` on every message.
- The **Escalate** control becomes moot: the sealed default already is the
  frontier pen, inside the seal, so `escalate: true` is answered by the same
  Bedrock pen and recorded as an ordinary (non-escalation) turn.
- There is **no fallback pen**. As of 2026-09-19 the Tier-B provider set is
  exactly `{aws-bedrock}`: Kimi K3 / Fireworks is gone (its US hosting was
  never established) and first-party `anthropic` is out of the allowlist. A
  server without the Bedrock key refuses a sealed matter rather than serving
  it from outside the seal, and `/api/llm` — which has no `aws-bedrock`
  route — now refuses **every** browser-driven model call bound to a sealed
  matter (Editor, Bucketizer, cite-check, Moot Bench). The one remaining way
  out of the seal is the in-app Assistant's explicit per-request
  `escalate: true`, which is written to `ai_messages` as `escalation: true`
  and is itself refused if that record cannot be opened. Proof:
  `node scripts/_verify-sealed-no-fallback.mjs` (offline, no secrets).
- Pricing on the ledger: $5.50 / $27.50 per million tokens (Opus 5 lists at
  the same $5 / $25 as 4.8, plus the regional endpoint's 10% residency
  premium).
