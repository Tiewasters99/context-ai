# 002 — Claude.ai Web OAuth Regression & the Desktop-First Decision

**Date:** 2026-05-14
**Status:** Decision implemented; revisit when upstream fix lands

---

## TL;DR

claude.ai web Custom Connectors have been broken industry-wide since ~April 15, 2026 — a regression introduced by Anthropic's Connections → Customize UI migration. Every third-party MCP server (including Anthropic's own Salesforce Hosted MCP) hits the same failure mode: OAuth completes successfully on the server side, then claude.ai never attaches the Bearer token to the `/mcp` requests that follow.

**Decision:** Lead all "Connect to Claude" onboarding through **Claude Desktop**. Acknowledge the web limitation in a footnote on `/connect`. Re-enable web automatically (no code change required) when the upstream fix ships.

## Symptom

The Vercel function logs show the same pattern across every attempt:

```
GET  /.well-known/oauth-protected-resource  → 200
GET  /.well-known/oauth-authorization-server → 200
POST /api/oauth-register                    → 201
POST /api/oauth-approve                     → 200
GET  /.well-known/oauth-protected-resource  → 200  (re-fetch)
GET  /.well-known/oauth-authorization-server → 200  (re-fetch)
POST /api/oauth-token                       → 200  (token issued)
[nothing — no /api/mcp call follows]
```

User-visible result: "Authorization with the MCP server failed. ... reference: `ofid_<hex>`".

## Investigation log

Four hypotheses, four shipped fixes, none of which moved the needle on claude.ai web (the underlying server hardening is keep-worthy regardless):

1. **`afa7595`** — Fix `oauth-approve` to validate Supabase session via `sb.auth.getUser()` instead of HS256 verify (Supabase had rotated to ECC signing keys, our local verifier couldn't keep up). Made `/api/oauth-approve` work; didn't unblock the symptom.
2. **`d1bdf47`** — Diagnostic logging on `/api/oauth-token` to surface which check rejects what. Confirmed that *we* never reject anything — the flow always succeeds on our side.
3. **`7569af3`** — RFC 9068 conformance on the access token: JOSE header `typ: at+jwt`, payload claims `iss` and `client_id` alongside `sub`/`aud`/`exp`. Strict OAuth clients reject access tokens missing these. Didn't move the symptom.
4. **`3cf709d`** — Wrap the access token in an opaque `cspa_` envelope (base64url of the inner JWT) so the OAuth client can't introspect it. RFC 6749 §1.4 explicitly says access tokens are opaque to the client. Didn't move the symptom either.

After four shipped fixes and three full retry cycles, the pattern was identical: server flow completes 200, no `/api/mcp` call follows.

## Why it isn't us

Searched GitHub for similar reports. Found a cluster of open issues with our exact pattern:

- [claude-ai-mcp#155](https://github.com/anthropics/claude-ai-mcp/issues/155) — "claude.ai connector completes OAuth flow but never attaches Bearer token to MCP requests"
- [claude-ai-mcp#171](https://github.com/anthropics/claude-ai-mcp/issues/171) — Salesforce Hosted MCP: OAuth completes but claude.ai fails with "Authorization with the MCP server failed"
- [claude-ai-mcp#100](https://github.com/anthropics/claude-ai-mcp/issues/100) — duplicate target for #155
- [modelcontextprotocol#2157](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2157) — upstream spec-side tracking

Notes from those threads:

- Anthropic support has acknowledged this internally as an "auth state synchronization lag" client-side issue.
- It affects **Anthropic's own Salesforce Hosted MCP**. That fact rules out the "intentional sabotage of competitors" hypothesis — they wouldn't break their own flagship enterprise integration on purpose.
- It does *not* affect Anthropic-curated Pre-built connectors (Notion, Drive, Slack, Gmail). Only Custom Connectors are broken.
- Regression began around April 15, 2026 with the Connections → Customize UI migration.
- No documented workaround for claude.ai web. The acknowledged path is Claude Desktop or Claude Code.

## Strategic read (extends [001-avoid-rented-land](./001-avoid-rented-land.md))

The bug is genuine engineering regression at the technical level. But the *prioritization* — four weeks unfixed, multiple support tickets, affects their own product — is a choice. Possible reasons:

1. **Custom Connectors are anti-monetization.** Pre-built connectors are revenue-aligned partners; Custom is anyone-can-plug-in-anything. Pre-built gets engineering attention.
2. **Desktop is the "real" surface for power users.** Web is increasingly positioned for casual chat + Anthropic-curated workflows.
3. **Resource allocation.** Whatever team owns Custom Connectors is small, overloaded, bug isn't loud on their internal metrics.

My weighting: ~50% genuine deprioritization, ~30% structural disincentive to fix, ~20% "engineering will get to it eventually." Functionally indistinguishable from intent for the next few months.

**Implication for Contextspaces:** Don't bet distribution on claude.ai web Custom Connectors. Treat Desktop + Claude Code as the production surface. claude.ai web as "when it works" bonus. This compounds with the multi-client architecture principle: OpenAI connector / Gemini / REST API are first-class alongside MCP, not afterthoughts.

## Decision

1. **`/connect` page** leads with Claude Desktop: install → generate token → paste config. (`bc26dbc`)
2. **claude.ai web** is acknowledged in an "Other clients" footnote at the bottom of `/connect`, with a link to upstream issue #155 and a statement that we'll re-enable web automatically when the fix ships.
3. **No further server-side work** on the OAuth flow. The four fixes shipped (`afa7595` → `3cf709d`) leave the server in good shape; when Anthropic's fix lands, claude.ai web will Just Work against the current build with no further code change.
4. **For sharing access** (Ty Clevenger and future colleagues): route them through Claude Desktop. Static `csp_*` token flow via the matter-membership system, not OAuth.

## Revisit when

- claude-ai-mcp#155 closes with a fix
- A user reports that claude.ai web suddenly works against our deployed code (no action required from us — the marker log line `[oauth-token] issued: build=...` will tell us which version served the successful call)
- We decide to publish a generic JWKS endpoint + asymmetric signing (would unblock claude.ai web in some configurations even before they fix their bug — but adds key-rotation complexity we don't currently need)
