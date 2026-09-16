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
