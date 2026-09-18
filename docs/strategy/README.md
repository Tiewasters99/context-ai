# Strategy

Internal memos, thought pieces, and operating principles. Not feature wishlists (that's `IDEA_VAULT.md`) and not handoff state (that's the dated handoff files at repo root). This is where the *why* lives — the principles that should be brought to bear when proposing or reviewing any future change.

Numbering is chronological by creation, not priority. Read them all when onboarding a new contributor.

## Memos

- [001 — Don't build on rented land](./001-avoid-rented-land.md) *(2026-05-14)*  
  The operating principle for evaluating every feature. One-line test: "Would a paralegal at a small firm without Claude find this useful?"

- [002 — Claude.ai web OAuth regression & the Desktop-first decision](./002-claude-ai-web-oauth-regression.md) *(2026-05-14)*  
  Investigation log + decision rationale for routing "Connect to Claude" onboarding through Claude Desktop and acknowledging the upstream-Anthropic regression in the UI footnote.

- [003 — Critique of the Gemini "Local Inference" Blueprint](./003-local-inference-critique-2026-09-16.md) *(2026-09-16)*  
  Why "local on-prem inference only" is the top rung of a ladder Contextspaces already has (Tier C), not the architecture. No pivot; four adjustments (Defensible-AI sales frame, citations-verified export gate, open-weight embeddings evaluation, Tier C re-sequenced: private instance → BYOH adapter → partner appliance).

- [004 — Sealed pens: what Bedrock actually permits, model by model](./004-sealed-pens-retention-ladder-2026-09-16.md) *(2026-09-16)*  
  Astra retains flagged traffic (ZDR by account-team request); Fable 5.1 requires `aws_review` (program ZDR expires 2026-12-31); Grok 4.6 likely `none` (probe); Gemini not on Bedrock. Design change: Tier B = "allowed_modes includes none in our account", verified by `scripts/_probe-bedrock-retention.mjs`. Video is the real gap (W12).

- [005 — "Defensible AI": the external frame for the Record](./005-defensible-ai-positioning.md) *(2026-09-16)*  
  Sales language for W1/W5/W6 (insurer, bar, client as buyers); what we can and cannot say. UI stays discreet.

- [006 — Seal by privilege class, not by matter](./006-seal-by-privilege-not-by-matter-2026-09-18.md) *(2026-09-18)*  
  Retention is not what preserves privilege; reach is. The sealed unit becomes the privileged container (own pen, no cross-container retrieval, no outbound tools); a modest tool-capable pen suffices (Kimi K2.5 live); SecureChat as a communication to counsel; classification attorney-confirmed; the Record shows class and reach. Companion: `docs/blog/2026-09-18-…privileged.md` (DRAFT) and `docs/templates/client-memo-ai-and-privilege.md` (DRAFT).
