# Sealed chat pen: Claude Opus 4.8 via Bedrock, in our own AWS account

Built 2026-08-27. Tier-B (sealed) matters chat through **Claude Opus 4.8 on
Amazon Bedrock's Messages API** (`bedrock-mantle.us-east-1.api.aws`) in our
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

The code is fully wired and fail-closed: until the credentials below exist,
Tier B behaves exactly as it does today (Kimi K3 when `FIREWORKS_API_KEY` is
set, refusal otherwise). **The cutover is one retention setting + one IAM user
+ three env vars. No code changes.**

## Provisioning (Eden, one time, ~20 minutes)

Same AWS account as the embeddings work: **Contextspaces (956035085448)**,
us-east-1. Bedrock is serverless — no endpoint, no instance, no quota case.

1. **Model access.** Bedrock console → Model access → Claude Opus 4.8 is open
   to all Bedrock customers; confirm it shows as available for the account.

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
   Opus 4.8 model ARN, narrow `CreateInference`'s Resource to it.)

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

- Sealed (Tier B) chat runs on Claude Opus 4.8 with zero retention in our
  account. The ledger stamps `provider: 'aws-bedrock'` on every message.
- The **Escalate** control becomes moot: the sealed default already is the
  frontier pen, inside the seal, so `escalate: true` is answered by the same
  Bedrock pen and recorded as an ordinary (non-escalation) turn.
- Kimi K3 / Fireworks stays wired as the fallback pen for servers without
  the Bedrock key, and `api.anthropic.com` remains reachable from a sealed
  matter ONLY via that fallback's recorded escalation. Removing the fallback
  entirely is a policy decision noted in `lib/ai-tier-policy.mjs`.
- Pricing on the ledger: $5.50 / $27.50 per million tokens (list $5 / $25
  plus the regional endpoint's 10% residency premium).
