# 001 — Don't Build on Rented Land

**Date:** 2026-05-14
**Author:** Eden Quainton (synthesized from a conversation with Claude)
**Status:** Operating principle — apply to every feature decision

---

## TL;DR

Before recommending or building any feature, ask:

> *Would a paralegal at a small firm that doesn't use Claude find this useful?*

If yes, it's durable — ship it.
If it only makes sense as "thing Claude can call," it's on rented land — propose a Claude-agnostic shape before building, or accept the dependency explicitly and price it into the roadmap.

One-line override when in doubt: **build the thing that still works if Claude shuts down tomorrow; make Claude's involvement an accelerator, not the foundation.**

---

## The threat we're actually designing against

It's tempting to frame the risk as "Anthropic copies Contextspaces feature-for-feature." That's dramatic but unlikely — their economics push them to stay horizontal. They want to be the brain, not the chair.

The quieter, more dangerous version: **retrieval-over-your-files becomes table stakes** in every LLM product. Lawyers shrug because Claude's built-in is "good enough" even when it isn't. You don't get killed; you get crowded into irrelevance.

Design against commoditization, not against direct copying.

## The defensible shape

Anything that requires *being a legal company*:

- Parallel citations (knowing what one is, parsing, validating)
- NYSCEF / PACER docket structure
- Ethics walls across matters
- Conflict checking
- Fee-application discipline (court-billing rules)
- Court rules (FRCP, local rules, judges' rules)
- Malpractice-carrier integration
- Retention policies (state-bar required)
- Bar-association deliverables

Horizontal players (Anthropic, OpenAI) won't build these because their unit economics don't support a vertical product. They'd cannibalize their own pricing if they tried.

## Honest caveats

**They don't have to build it themselves.** Anthropic can partner with Thomson Reuters or LexisNexis to bring vertical-aware Claude to lawyers. Not fully eliminable. Mitigation: ship faster than enterprise partnerships negotiate. Enterprise legal-tech deals move on quarter timescales; you can ship a year of product before they close.

**Data gravity is real but not infinite.** 18 months of matters + metadata + audit logs is a real switching cost. Anthropic can't replicate it by shipping a feature — they'd have to convince thousands of lawyers to upload their case histories into Claude itself, which conflict-of-interest rules and confidentiality concerns make hard. But lawyers *do* switch tools. Keep export easy and migration painless — counterintuitively that's what makes them comfortable trusting you with everything.

**Pricing direction works in our favor.** Lawyers compare to Westlaw ($300+/seat/month), Spellbook, Casetext. Anthropic prices Claude as a horizontal tool ($20–200/seat). If they ever went vertical they'd cannibalize their horizontal product. Their economics structurally don't let them undercut us in our lane.

## MCP rails are a channel, not the product

Today Claude/MCP, tomorrow OpenAI's connector spec, the day after Gemini's. Start being multi-client now while you only have to write it once.

If "Contextspaces" means *"thing you connect to Claude,"* it can be shut off.
If it means *"legal system of record that any LLM can query — privilege intact, audit-logged, conflict-checked,"* it survives client-side churn entirely.

This is also why we shipped REST + Custom GPT support alongside MCP, and why the LLM adapter layer (see [`feedback_model_agnostic_architecture`](../../../.claude/projects/C--Users-equai/memory/feedback_model_agnostic_architecture.md)) never bakes one provider's API shape into feature code.

## Credibility moat Anthropic structurally can't touch

- Bar association relationships
- Ethics-committee engagement
- CLE accreditation
- Free-for-bar plays (Docket Monitor MIT)
- Malpractice-carrier conversations
- Court-clerk relationships

None of this is engineering. All of it is moat. Anthropic is a $40B horizontal AI company; they will never have a bar association relationship — that's a different kind of company. Compound these.

## Worked examples (passes vs fails)

**Passes the rented-land test (durable):**

- *Cite-checker* — paralegals have checked cites since the 1980s. Claude makes it faster, but the workflow exists without Claude.
- *Docket Monitor* — depends on email-to-SMS, PACER, court rules. Anthropic isn't going to integrate with PACER.
- *Matter membership / ethics walls* — firms organize partner-vs-associate access regardless of AI tooling.
- *Connect (live transcription)* — depends on real-time audio + voice biometrics + legal-grade timestamping. Vertical workflow.

**Fails the test (rented land if shipped naked):**

- *"Vault that Claude can search"* on its own — generic RAG. Anthropic ships this for free with Claude.
- *"Ask Claude about your matter"* — same.
- *Pure chat-over-documents* — every horizontal LLM does this.

These features aren't *wrong* — they're necessary plumbing. But they have to be embedded in workflows that survive Claude's absence (cite-checking, drafting templates, deposition prep, fee applications). Standalone, they're commodity.

## Operating checklist

When proposing or reviewing a feature:

1. State the user's job-to-be-done in one sentence *without mentioning Claude or any LLM*. If you can't, it's rented land — go back and reshape.
2. Ask whether it requires legal-vertical knowledge to build well (citation formats, court rules, ethics walls, bar standards). If yes, durable. If no, what makes it ours?
3. Check whether the feature works if the LLM is offline / down / replaced. If not, can it degrade gracefully to a non-LLM workflow?
4. Make sure the artifact (matter, document, memo, citation) is portable — exportable, not lock-in.
5. Note the *credibility* hook: is there a bar / ethics / CLE / malpractice angle that compounds over time?

If a feature passes 1–4 cleanly and has a (5) hook, ship it confidently.
If it fails 1–3, either reshape or accept the dependency loudly in the roadmap.
