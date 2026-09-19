# 004 — Sealed pens: what Bedrock actually permits, model by model

**Date:** 2026-09-16
**Author:** Claude (Fable 5.1), for Eden Quainton's review
**Question asked:** We have assumed Fable is the only route to the most advanced intelligence and that it cannot run inside the seal. Does GPT-6 Astra on Bedrock offer zero retention and no training? Are Gemini and Grok on Bedrock? Does this change the tier design?
**Status:** Answered from AWS's own documentation (read 2026-09-16) plus a probe script for the account-specific confirmation. Two asks for Eden at the end.

---

## 1. Answer in one paragraph

On Bedrock the question is never whether the model vendor sees or trains on the content. AWS's data-retention page states that under every mode content is not shared with the model provider, and no AWS page mentions training at all. The only variable is whether *AWS itself* retains inputs and outputs for abuse review, and for how long. That is what the seal's `none` claim is about. Measured on that axis, Astra does not get us out of the Fable problem for free: it retains classifier-flagged traffic for 30 days by default, and full zero retention is something "eligible customers may request through their AWS account team." Fable 5.1 is stricter still: all traffic retained 30 days, human review possible, with a program exception that expires at the end of 2026. Grok 4.6 is absent from AWS's retention-required list and is probably zero-retention by default, unconfirmed. Gemini is not on Bedrock at all. The structural conclusion is the useful one: define Tier B eligibility as a *property of the model in our account* (its `allowed_modes` includes `none`), not as a vendor list. That keeps model agnosticism by construction and turns Astra into a configuration change the day the account team grants it.

## 2. The ladder, as AWS documents it

| Model (Bedrock) | Retention under our account today | Path to `none` | Modalities | Price per 1M tokens (in / out) |
|---|---|---|---|---|
| Claude Opus 4.8 | `allowed_modes` includes `none` (AWS's own worked example). Already the Tier A pen. | Already there | Text, image | $5 / $25 (+10% in-Region) |
| Claude Opus 5 | `none` confirmed by live probe of our account 08-27 (sealed pen of record). Not named on the retention page; "no data retention change to Claude models released before Claude Fable 5." | Already there | Text, image | $5 / $25 |
| **GPT-6 Astra** (GA 2026-09-08) | "Classifier-flagged traffic will be retained for up to 30 days for automated offline abuse detection." Not shared with OpenAI. | "Eligible customers may request full ZDR through their AWS account team." No expiry stated. | Text + image in; **no video, no audio**. 1.05M context. | $11 / $55 (≤272K input); $22 / $82.50 above |
| **Claude Fable 5.1** | `allowed_modes: ["aws_review", "provider_data_share"]`. "All traffic will be retained for up to 30 days for automated offline abuse detection. Classifier-flagged traffic will be subject to potential human review performed by AWS." Not shared with Anthropic. | "Customers that are eligible for the Enterprise Frontier Safeguards program will receive ZDR through December 31, 2026. After ZDR ends, all traffic will be retained for up to 30 days." "ZDR eligibility for Claude models is managed by Anthropic." | Text, image | ~2× Opus |
| **Grok 4.6** (GA 2026-08-18) | Not listed among models for which AWS "may be required to store inputs and outputs." The abuse-detection page says "by default, Amazon Bedrock does not store model inputs or outputs." **Inferred by omission; unconfirmed until the probe runs.** | Probe | Text + image; no video. 500K context. Reasoning effort configurable. | $2.20 / $6.60 |
| Gemini (any) | **Not on Bedrock.** | n/a | (Google's path: Vertex AI, see §4) | n/a |

Sources: AWS Bedrock *Data retention* page; *Abuse detection* page; model cards for GPT-6 Astra and Grok 4.6; all read 2026-09-16. Claude rows (prices, Opus 5 `none`): the 08-27 session records, not today's fetch. Exact quotations are in the session record; the probe below reads the same fields live.

Two mechanics that matter operationally:

- **Retention mode is per Region.** Our account's `none` was set in us-east-1 on 08-27 (both the mantle and classic planes). Astra's OpenAI-compatible (`bedrock-mantle`) endpoint is **us-west-2 only**. Any Astra use through that endpoint needs the mode set in us-west-2 too, or the Astra pen is refused there (a good failure, but a surprise). Grok's mantle endpoint is also us-west-2.
- **Only `bedrock-mantle` exposes `allowed_modes`.** The control plane does not. So the probe must go through mantle, per Region, with a key that has GetModel. Our pen key does (the verifier already reads the field).

## 3. The design change: Tier B is a retention-mode gate, not a vendor list

Today `lib/ai-tier-policy.mjs` says Tier B = `{aws-bedrock, fireworks, anthropic}` and `choosePen` hard-codes Opus 5 on Bedrock. That conflates *transport* (Bedrock) with *guarantee* (`none`). The honest rule, which is also the model-agnostic one:

> A model may serve a sealed matter if and only if, in our account and in the Region we call it, its `data_retention.allowed_modes` includes `none`, and our effective mode there is `none`.

Consequences:

1. **The sealed pen registry becomes data, verified by probe.** `scripts/_probe-bedrock-retention.mjs` (this PR) lists the account's catalog per Region with `allowed_modes` and prints the sealed-eligible set. Run it after any account change; the W4 CI job can run it against prod on a schedule once the key is a CI secret.
2. **Astra becomes a config change**, not a design decision, the day AWS grants `none` for it. Same for any future model. Same for Fable if Anthropic ever lists `none`.
3. **The Tier B pen menu can offer more than one sealed pen** (Opus 5 today; Grok 4.6 if the probe confirms; Astra if granted), which is the agnosticism Eden wants: the user picks the mind, the seal picks the terms.
4. **Fireworks leaves the Tier B set.** Its zero retention is real but its US hosting was never established; with the Bedrock pen live it is idle. First-party `anthropic` (30-day retention) leaves too, per the 09-10 roadmap.
   > **DONE 2026-09-19.** `TIER_PROVIDERS.B = {aws-bedrock}`. Both providers are out, and a server without the Bedrock pen now refuses a sealed matter instead of falling back (Eden's decision, prompted by the 09-19 ship-readiness audit). The only remaining exit from the seal is `/api/assistant`'s explicit per-request `escalate: true`, recorded as `escalation: true` and itself refused when the record cannot be opened. Asserted offline by `scripts/_verify-sealed-no-fallback.mjs`. Item 1 (the registry as probe-verified data) and item 3 (a menu of several sealed pens) are still unbuilt: the set is a literal today.

Is the highest reasoning tier ever needed for legal work? Eden's instinct is consistent with the record we have, which is thin and should be stated as such: Eden's own 08-27 judgment when choosing the sealed pen was that Opus 5 "is superior analytically" for legal reasoning, and Fable sits in the product only as a premium Tier A option at twice the price. No measured comparison of Fable against Opus 5 on legal tasks exists in this repo. Where Fable's extra capacity is documented to matter, it is very long agentic runs and design-heavy output, neither of which is the solo litigator's day. The right posture is: Opus 5 is the sealed pen of record; Astra is added when granted; Fable is a Tier A option for cost-insensitive unsealed work, never the seal's dependency. That is not defensive; it is the documented state of the vendors' terms.

## 4. Video is the real gap, and it is not a reasoning gap

Eden's point stands: video understanding matters at every level of litigation practice (body-cam, surveillance, deposition video, cell-phone footage), and Gemini's multimodal strength is real. Gemini cannot be inside the seal via Bedrock because it is not there. Three paths, none verified for retention today:

| Path | Where it runs | What we know | What we do not know |
|---|---|---|---|
| **Gemini on Vertex AI** with a zero-retention / abuse-monitoring exception | Google Cloud, a second cloud account | Google states it does not train on Vertex customer data; a ZDR option exists on certain endpoints; the abuse-logging exception is requestable; invoiced billing accounts are out of scope for prompt logging. | Whether ZDR holds for video inputs ("may not be possible with some Advanced AI features"). The exception is an account-team conversation. |
| **Twelve Labs Pegasus 1.2 + Marengo 2.7** on Bedrock | Our AWS account, fully managed | Pegasus is a video-to-text model (summaries, Q&A over visual content); Marengo produces video embeddings for search. Regions: Pegasus in us-west-2 / us-east-2 / us-west-1, **not us-east-1**; Marengo in us-east-1. | Retention status was on no AWS page fetched. Legal-video quality unmeasured. |
| **Amazon Nova** (video input) | Our AWS account | First-party AWS model family; video input supported. | Retention status not on the pages fetched; quality unmeasured. |

Recommendation: keep Gemini as the **Tier A** video path (today's behavior), and scope a small **sealed video-understanding evaluation** as its own item (W12 in the roadmap): one public-domain or fictional clip set, three questions per clip, Pegasus vs Nova vs Gemini, plus the probe for their retention fields. Do not pick a sealed video model from marketing.

## 5. Actions

**For Eden (two conversations, both short):**

1. **AWS account team:** request full zero retention for `openai.gpt-6-astra` on account 956035085448 (us-east-1 and us-west-2). The docs say this is per-account, per-model, "in coordination with the model provider." The account has Business Support+; the same channel as the SageMaker quota case.
2. **Anthropic representative:** written confirmation that Opus 5's `allowed_modes` includes `none` in our account (the 08-27 probe showed it; a sentence in writing is what a client questionnaire wants), and whether Enterprise Frontier Safeguards eligibility is available to us for Fable, noting the documented 2026-12-31 expiry.

**To run once the Bedrock key placeholders in `.env` are filled** (the values are in Vercel; never paste them in chat):

```
node scripts/_probe-bedrock-retention.mjs
node scripts/_probe-bedrock-retention.mjs --region us-west-2 openai.gpt-6-astra xai.grok-4.6
```

**Build (Opus session, after the probe):** W8 in the roadmap memory. Make `TIER_PROVIDERS.B` a function of a `sealed_pens` list that the probe can regenerate; add Grok 4.6 and Astra as sealed pens gated on their probe result; drop `fireworks` and first-party `anthropic` from B; set the retention mode in us-west-2. Proof: `_verify-bedrock-pen.mjs` live section extended to every listed sealed pen.

## 6. What this does to the tier table in the pitch

Nothing in the marketing changes except that it gets shorter. "Sealed matters are processed only by models that our account can run under a zero-retention mode, verified by reading the provider's own catalog, and the list is yours to see." That is a stronger sentence than naming a vendor, and it is the sentence the memo in 003 could not write.

## Probe run 2026-09-18 (new IAM key; `scripts/_probe-bedrock-retention.mjs`)

Account-level `data_retention`: **us-east-1 `none`** (set 08-27, confirmed); **us-west-2 `inherit`**. The catalog listing (`GET /v1/models`) and the classic `bedrock:ListFoundationModels` both return 403: the IAM user `contextspaces-bedrocck` has no listing permission, so the probe fell back to per-id GETs. Findings from those:

| Region | Model | allowed_modes | Sealed-eligible | Available to this account? |
|---|---|---|---|---|
| us-east-1 | anthropic.claude-opus-5 | aws_review, default, none, provider_data_share | **yes** | no — "not available for this account" (model access not yet granted) |
| us-east-1 | anthropic.claude-opus-4-8 | same | **yes** | no — same |
| us-east-1 | anthropic.claude-sonnet-5 | same | **yes** | no — same |
| us-east-1 | openai.gpt-5.6-sol | default, aws_review, provider_data_share | no | no |
| us-west-2 | openai.gpt-6-astra | default, provider_data_share, aws_review | no (confirms §2) | no |
| us-west-2 | **xai.grok-4.6** | default, aws_review, none, provider_data_share | **yes** | **yes** — effective mode `default`; set `none` in us-west-2 before use |

- **Grok 4.6 in us-west-2 is the one sealed pen usable today** without another AWS trip. Its effective mode is `default`, so the sealed path must request/set `none` (Tier B gate: "allowed_modes includes none in our account", now verified for this model).
- **Claude 5 family (Opus 5 / Opus 4.8 / Sonnet 5) is sealed-eligible by catalog terms in us-east-1** but the account has not enabled model access; that is a Bedrock console "Model access" request, then re-probe. They 404 in us-west-2 under these ids (catalogs are per Region).
- **Second run, same day, after the IAM listing policy (`bedrock-catalog-read`: bedrock-mantle:ListModels/GetModel, bedrock:ListFoundationModels):** catalog 200 — **55 models in us-east-1, 49 in us-west-2**. What the catalog settles:
  - **Fable is `anthropic.claude-fable-5`** (not `-5-1`), us-east-1 only; `allowed_modes = aws_review, provider_data_share`; the catalog's own note: "This model is not available under data retention mode 'none'." Confirms §3: Fable is never a sealed pen under the Tier B gate. `anthropic.claude-mythos-*` is not in the catalog.
  - **Every current OpenAI frontier id refuses `none`**: gpt-6-astra (us-west-2 only), gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5 (+2026-04-23), gpt-5.4 (+2026-03-05). Only the open-weight `openai.gpt-oss-120b` / `-20b` / `-safeguard-*` allow `none`.
  - **Sealed-eligible frontier-class pens (allowed_modes includes `none`)**: Anthropic **Opus 5, Opus 4.8, Opus 4.7, Sonnet 5** (us-east-1 only) and Haiku 4.5 (both Regions); **xAI Grok 4.6** (us-west-2 only) and Grok 4.3 (both); DeepSeek v3.2 / v3.1; Qwen3-235B-2507, Qwen3-Coder-480B, Qwen3-VL-235B, Qwen3-Next-80B; ZAI GLM-5 / 4.7; Kimi K2.5 / K2-Thinking; MiniMax M2.5; Mistral Large 3 (675B); Gemma 4 31B. Full list in the probe output (both Regions, 2026-09-18).
  - **Not on bedrock-mantle at all**: Kimi K3 (only K2.5 / K2-Thinking), Amazon Nova 2 Pro / Nova Premier, TwelveLabs Pegasus 1.2 / Marengo 2.7. The mantle surface is the OpenAI-compatible catalog; Amazon's own and the video models live on the classic Bedrock runtime, so the W12 video-pen question needs a classic-API probe (`bedrock:GetFoundationModelAvailability` is now granted to the key).
  - **Effective mode**: every us-east-1 row is `none` (account setting, 08-27); every us-west-2 row is `default` (account `inherit`). A sealed pen in us-west-2 (Grok 4.6) needs the Region's account mode set to `none` first — one `PUT /v1/data_retention` with the new key, or the console. ⚠ Setting it makes Astra/Sol/Terra/Luna/5.x calls in that Region fail (they refuse `none`), which is the intended fence.
  - **Open**: whether Bedrock model access is enabled for the Claude 5 family in this account. The first run's per-id GETs said "not available for this account"; the catalog listing carries no availability field, so the listing does not answer it. Test = one InvokeModel/chat call, or the console's Model access page.
- Probe fixes this run: ids containing `:` were percent-encoded in the path, which broke the SigV4 match (401); blank rows had hidden the 404/401 statuses. Both fixed.

## Invoke tests 2026-09-18 (same key, after IAM grants for invoke on the classic plane)

What actually answers a 5-token question, by plane, under account retention mode `none` (mantle: both Regions; classic: us-east-1):

| Plane | Model / id | Result |
|---|---|---|
| mantle us-east-1 | `deepseek.v3.2` (`/v1/chat/completions`) | **200 "OK"** |
| mantle us-east-1 | `openai.gpt-oss-20b` | 200 (answers; spends its budget on reasoning tokens) |
| mantle us-east-1 | `anthropic.claude-opus-5`, `-opus-4-8`, `-sonnet-5`, `-haiku-4-5` (`/anthropic/v1/messages`) | 403 "not available for this account… contact AWS Sales"; catalog `status: unavailable` |
| mantle us-west-2 | `xai.grok-4.6` | `/v1/responses` hangs to timeout (twice); `/v1/chat/completions` "isn't supported on this route"; `/v1/messages` 404 |
| classic us-east-1 | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | **200 "OK"** (bare id → 400, on-demand needs the inference profile) |
| classic us-east-1 + us-west-2 | `anthropic.claude-opus-5`, `-opus-4-8`, `-opus-4-7`, `-sonnet-5`, also `us.`/`global.` profiles | 403 "not available for this account" — while `GetFoundationModelAvailability` says AUTHORIZED + agreement AVAILABLE + entitlement AVAILABLE |
| classic us-east-1 | `amazon.nova-lite-v1:0` (control) | 200 "OK." |

Reading: the 08-28 agreements are in place and the account is entitled on paper, but AWS enforces a separate account-level gate on the
Claude 5 generation (Opus 5, Opus 4.8, Opus 4.7, Sonnet 5) on both planes and both Regions. The only Anthropic model the account can run
is Haiku 4.5, on the classic plane. That is an AWS Sales/support matter (case 178785685000654), not a configuration we can change.

Consequences for the ladder:
1. **Tier B today** = a sealed pen that is not Anthropic: `deepseek.v3.2` is verified end-to-end; `gpt-oss-120b`, `qwen3-235b-a22b-2507`,
   `zai.glm-5`, `moonshotai.kimi-k2.5`, `minimax-m2.5`, `mistral-large-3-675b` are sealed-eligible by catalog and untested. `bedrockTurn`
   speaks only the Anthropic Messages route; an OpenAI-compatible branch (`/v1/chat/completions`) plus a `BEDROCK_MODEL` override is the build.
2. **Anthropic fallback** = Haiku 4.5 on the classic runtime (retention proof = classic `/data-retention` = `none` since 08-27) — not frontier.
3. **Grok 4.6** stays on the bench until its mantle route works.
4. Classic-plane retention in us-west-2 is still `inherit`; set it to `none` if a classic pen ever runs there.
