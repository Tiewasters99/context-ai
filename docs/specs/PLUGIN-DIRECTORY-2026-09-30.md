# Contextspaces in ChatGPT's plugin directory — scope (2026-09-30)

**Why.** On 2026-09-30 OpenAI removed link sharing for custom GPTs on individual plans: the Contextspaces
GPT built that night (docs/specs/GPT-ACTIONS-2026-09-29.md) works for Eden and cannot be handed to
James or anyone else. GPTs are being retired into **plugins**; a plugin is a package of instructions
("skills") plus an MCP server, and "custom actions don't transfer." What a plugin needs is what
Contextspaces has had since July: the hosted MCP server at `/api/mcp` with OAuth sign-in and per-matter
consent. A plugin **published to OpenAI's universal directory** can be installed by any ChatGPT
account, on the phone, by link or by name, and each person signs in with their own Contextspaces
account. Not rented land: no seat bought per client; the directory is a distribution channel, the
data and the rules stay ours. This is also what `docs/strategy/001-avoid-rented-land.md` promises.

Every requirement below is quoted or tightly paraphrased from OpenAI's pages as fetched on
2026-09-29/30 (developers.openai.com/plugins/*, learn.chatgpt.com/docs/*). help.openai.com refuses
automated fetches, so consumer-plan facts (can a **free** account install a plugin?) are unstated;
noted where it matters.

## 0. Where we already stand (verified in the repo)

| Requirement | Status |
|---|---|
| Remote MCP server, Streamable HTTP, production HTTPS | ✅ `api/mcp.mjs` at `https://www.contextspaces.ai/api/mcp` |
| OAuth 2.1: auth code + PKCE S256, DCR, refresh | ✅ `api/oauth-*.mjs`; metadata publishes `code_challenge_methods_supported: ['S256']`, `registration_endpoint`, `token_endpoint_auth_methods_supported` |
| Protected-resource metadata (`resource`, `authorization_servers`) and AS metadata (`issuer` = origin) | ✅ `api/oauth-metadata.mjs`; `resource` = `${origin}/api/mcp` |
| 401 with `WWW-Authenticate … resource_metadata=` | ✅ `api/mcp.mjs` |
| DCR client persists (ChatGPT registers once and reuses) | ✅ stateless client JWT, 10-year expiry. ⚠ rotating `MCP_OAUTH_SECRET` retires it — never during a review |
| Per-tool `annotations` (`readOnlyHint`, `destructiveHint`, `openWorldHint`) | ❌ none on any of the 25 tools |
| Per-tool `securitySchemes` + `_meta["mcp/www_authenticate"]` on auth errors (what makes ChatGPT show the sign-in card for a tool) | ❌ neither |
| Token audience verified by the resource server | ⚠ `authenticate` checks signature, `typ`, `sub`, grant; it does not compare `aud` to the resource. Add. |
| Domain verification file `/.well-known/openai-apps-challenge` (plain-text token) | ❌ trivial, when the portal issues the token |
| Privacy policy URL | ✅ `/privacy` (Eden to review the text) |
| Terms of service URL, support URL, website URL | ❌ no `/terms`, no `/support`; landing footer's Terms and Contact point at `#` |
| Listing assets (square icon ≥ 48 px, logo; PNG/SVG) | ❌ none in repo |
| Reviewer test account with sample data, password sign-in, no MFA | ❌ sign-ups closed; needs an account and a demo matter that is **not** client data |
| Platform organisation with verified identity, project on global data residency | ⚠ Grapheon.ai, LLC org exists (`org_7b45c0f2-…`); business verification not done; residency to confirm |
| Mobile | ✅ the same server; "Plugins work … on the web, desktop, and mobile" |

## 1. The package

A ZIP with one plugin root. No secrets inside; auth is discovered from the server and configured in
the portal.

```
contextspaces-plugin/
  plugin.json                 root manifest (Agent Plugins schema 1.0.0)
  mcp.json                    the one MCP server
  skills/
    contextspaces-matters/
      SKILL.md                the GPT's instructions, as a skill
  assets/
    icon.png  logo.png        square, ≥48 px, ≤5 MiB (+ dark variants optional)
```

`plugin.json` (draft; every limit from the submission page):

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "contextspaces",
  "version": "1.0.0",
  "description": "Your matters, documents and record in Contextspaces, with page:line citations.",
  "author": { "name": "Grapheon.ai, LLC", "url": "https://www.contextspaces.ai" },
  "homepage": "https://www.contextspaces.ai",
  "extensions": {
    "com.openai": {
      "interface": {
        "displayName": "Contextspaces",
        "shortDescription": "Your matters, cited",
        "longDescription": "…tasks, intended users, limitations (≤ 4000 chars)…",
        "developerName": "(set from the verified identity)",
        "category": "Productivity",
        "capabilities": ["Search a matter's documents with page:line citations", "Read a document top to bottom", "Find an exact phrase", "See where a matter stands", "File a note (with confirmation)"],
        "websiteURL": "https://www.contextspaces.ai",
        "supportURL": "https://www.contextspaces.ai/support",
        "privacyPolicyURL": "https://www.contextspaces.ai/privacy",
        "termsOfServiceURL": "https://www.contextspaces.ai/terms",
        "defaultPrompt": ["Where do things stand on my case?", "What does the petition say about the Holder Rule?", "List the documents in my matter."],
        "composerIcon": "./assets/icon.png",
        "logo": "./assets/logo.png"
      },
      "review": {
        "test_cases": { "positive": [ "…5…" ], "negative": [ "…3…" ] },
        "demo_recording_url": "…"
      },
      "publication": { "release_notes": "First release." }
    }
  }
}
```

`mcp.json`:

```json
{ "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": { "contextspaces": { "type": "streamable-http", "url": "https://www.contextspaces.ai/api/mcp" } } }
```

Rules that bite: `name` is kebab-case and becomes the identifier; no "MCP" or "Plugin" in the display
name; `description` ≤ 1,024 characters (two pages disagree; stay under the smaller); no `apps` /
`.app.json`; **the server origin can never change after submission** (a path change needs a new
version; a host change needs a new plugin) — so decide `www.contextspaces.ai` vs `contextspaces.ai`
now, and it is `www`, the origin every metadata document already names.

## 2. Server changes (one PR, `feat/mcp-plugin-ready`)

1. **Annotations on every tool** in `TOOLS` (`lib/mcp-core.mjs`), explicit booleans, with a one-line
   justification each kept in the spec for the portal form:
   - read-only, closed-world: `list_matters`, `list_matter_contents`, `search`, `grep`, `get_passage`,
     `get_outline`, `get_document_text`, `get_matter_state`, `check_ingest_status`, `my_tasks`,
     `get_media` → `readOnlyHint:true, destructiveHint:false, openWorldHint:false`.
   - writes that create: `file_document`, `create_chart`, `create_deck`, `create_matter`,
     `copy_document`, `assemble_documents`, `send_to_sandbox`, `set_matter_state`, `claim_task`,
     `post_result`, `ask_human`, `ingest_document` → `readOnlyHint:false, destructiveHint:false`.
   - `move_document`, `edit_pdf` (a new copy, but reorders/deletes pages in it: keep `false`, say why),
     nothing deletes → `destructiveHint:false` throughout, stated honestly ("Being able to undo an
     action does not, by itself, justify `false`" — none of ours removes anything).
   Harness: every tool has all three booleans; the read set matches `connector-meter` `READ_TOOLS`.
2. **`securitySchemes: [{ type: 'oauth2', scopes: ['mcp'] }]` on every tool**, and on an auth failure
   inside a tool call a result whose `_meta["mcp/www_authenticate"]` carries `error` and
   `error_description` (today auth fails at the HTTP layer only; keep that, add the tool-level form
   for a token that is valid at the door but refused for a matter — the seal/pause refusals stay as
   they are, they are not auth).
3. **Audience check** in `lib/oauth-bearer.mjs`: an access token whose `aud` is not this deployment's
   `/api/mcp` is refused with 401 `invalid_token`. Harness in `_verify-oauth-confidential.mjs`.
4. **Response hygiene** (rejection reason 3 on OpenAI's list: "returns user-related data types that
   are not disclosed in your privacy policy"): audit `list_matter_contents`, `search`, `my_tasks`,
   `get_matter_state` for `created_at`/`updated_at`, uploader ids, internal counters; keep document
   and matter ids (needed to call again), drop the rest or name them in `/privacy` ("document
   timestamps and identifiers are returned to a connected assistant so it can cite and follow up").
5. **Server `instructions`** (`api/mcp.mjs`): the first 512 characters carry the weight — lead with
   "call list_matters first; cite document and page; sealed matters do not answer".
6. **`/.well-known/openai-apps-challenge`**: a static file under `public/.well-known/` holding the
   exact token the portal issues (plain text, nothing else); a vercel.json header for `text/plain`.
7. **Pages**: `/terms` (Eden drafts; I scaffold the page in the `/privacy` style) and `/support`
   (what it is, how to reach us, the status page `/api/health`, the connect page); landing footer
   links fixed. `/privacy` must state: categories of personal data, purposes, recipients (Supabase,
   Vercel, model providers, OpenAI when used through ChatGPT), retention, controls — the guideline's
   minimum list; and the data an assistant receives (passages, titles, ids, timestamps).

Nothing here changes what claude.ai, Grok or the Chrome extension see; annotations and
`securitySchemes` are additive MCP metadata.

## 3. The reviewer account and the demo matter

OpenAI signs in as a test user and runs the eight test cases. Requirements: a dedicated account,
"not a real user's account", password sign-in that needs no MFA, email code, magic link or private
network; sample data that covers every test case; kept alive for future reviews.

- **Account**: `reviewer@contextspaces.ai` (or a Grapheon mailbox), created by Eden while sign-ups
  are closed (the invitation path, or directly in Supabase Auth), password only, second factor never
  enrolled. Membership in one demo serverspace only.
- **Demo matter**: public-record material only. The Kaya › SEC demo import (public SEC filings,
  `project_kaya_sec_demo_import_2026_09_16`) is the candidate; add one public court opinion set and a
  short "brief" .md so `get_document_text`, `search`, `grep`, `get_outline`, `get_matter_state` and
  `file_document` all have something to touch. **Never a client matter.**
- **Ledger note**: the matter's state carries a headline and next action so "where do things stand"
  has an answer.

## 4. Test cases and the recording

Five positive (prompt, tools triggered, expected behaviour), three negative (prompt, why the plugin
must not act), each run in the demo account before submission:

| # | Prompt | Tools | Expected |
|---|---|---|---|
| P1 | "What matters can I see?" | `list_matters` | the demo tree, nothing else |
| P2 | "Where do things stand on <demo matter>?" | `get_matter_state` | headline + next action, quoted as the lawyer's |
| P3 | "What does the 10-K say about revenue recognition? Cite the page." | `search` | passages with document + page |
| P4 | "Read the <short brief> from the top and summarise each section." | `get_document_text` (paged) | section summaries, names the document first |
| P5 | "File a note in <demo matter>: reviewed by OpenAI." | `set_matter_state` | asks for confirmation, then files; `get_matter_state` shows it |
| N1 | "Delete the 10-K." | none | says it cannot delete documents |
| N2 | "What is in the Smith matter?" (not a member) | `list_matters` at most | says no such matter is visible; does not guess |
| N3 | "Give me legal advice on whether to settle." | none | reports the record only; advice is for the lawyer |

Demo recording: one continuous screen capture, desktop web first then the iPhone app, showing
sign-in, P1–P5 and one negative; hosted where a reviewer can open it without an account (an
unlisted video). Length and format are unstated; five minutes is plenty.

## 5. Identity, organisation, portal

- Platform org **Grapheon.ai, LLC** (`org_7b45c0f2-42a0-4d77-be46-d3121e027403`): complete **business
  verification** in org settings ("Publishing under an unverified individual or business name will
  result in rejection"; documents unstated, expect formation papers + EIN). Use a project with
  **global** data residency.
- The submitter is an org owner (or has Apps Management Write).
- Flow: upload ZIP → automated metadata/skill checks (skill scans "can take up to 2 hours") → connect
  the MCP server (URL, OAuth, domain verification, complete the OAuth once as the reviewer account)
  → tool scan → Review details (test account credentials, sign-in instructions) → attestations →
  submit. One review at a time; feedback by email; appeal by reply. "Review timelines may vary."
- After approval: **Publish** when we choose; discoverable by direct link and exact-name search;
  there is no unlisted mode, only a country allowlist (`publication.countries`) — set `["US"]` for the
  first release. OpenAI rescans the server daily; changed tools keep the old definition until the
  update passes, so tool schemas must stay backward compatible once live.

## 6. Decisions Eden owes (one line each)

- **P1 Terms of service.** You draft `/terms` (I scaffold the page and a plain first draft for you to
  cut). Required for submission.
- **P2 Support contact.** An address that is monitored (a Grapheon mailbox, not your personal Gmail)
  for `/support` and the listing. Required.
- **P3 Business verification** for Grapheon.ai, LLC in the OpenAI Platform org. Yours to do; blocks
  submission.
- **P4 The demo matter.** Confirm the SEC demo content may be shown to OpenAI reviewers and that
  nothing client-related sits in that serverspace.
- **P5 Countries.** US only for the first release, or wider.
- **P6 James before approval.** Reviews take an unstated time. If he needs access sooner: he asks
  which ChatGPT plan he has; on Plus/Pro he can add the connector himself on a computer (developer
  mode, our existing connect page) and use it on the phone afterwards if plugins created that way
  appear there — a fact to test with your own account first; on Free, he waits for the directory.

## 7. Order and estimate

| Step | Work | Who | Est. |
|---|---|---|---|
| 1 | Server PR: annotations, securitySchemes + `_meta` auth result, audience check, response hygiene, instructions, well-known file, harnesses | me | 5 h |
| 2 | `/terms` scaffold + draft, `/support`, footer links, `/privacy` additions | me, then Eden edits | 2 h + Eden |
| 3 | Reviewer account + demo matter + ledger note | Eden (account), me (content) | 1.5 h |
| 4 | Package: `plugin.json`, `mcp.json`, `SKILL.md`, icons; a harness that validates the manifest against the schema URL and the limits above | me | 2 h |
| 5 | Business verification; challenge token file; portal upload; run the 8 cases as the reviewer; recording | Eden (verification, recording), me (cases, ZIP) | 2 h + Eden |
| 6 | Submit; answer review email; publish; fill `/gpt-connect` with the directory link | both | — |

About one and a half days of build, plus your verification and recording, plus OpenAI's review
clock. The build can start now; nothing in steps 1–4 waits on OpenAI.

## 8. Risks, stated

- **Free-plan users.** Whether a free ChatGPT account can install a directory plugin is not stated
  on any page we could read. If not, the phone route for a client requires ChatGPT Plus, which is
  the client's subscription, not ours.
- **Review outcome.** OpenAI "may reject or remove any plugin at any time." The prohibited list names
  "legal or quasi-legal services that facilitate fraud, evasion, or misrepresentation", not legal
  practice tools; our privacy and consent story is stronger than most. Restricted data: no PCI, PHI,
  SSNs or credentials may be collected by the plugin — none is asked for; matter content the user
  has already filed is theirs.
- **The origin is forever.** `https://www.contextspaces.ai/api/mcp`; a move to another host means a
  new plugin and every user reinstalls.
- **Secret rotation** (`MCP_OAUTH_SECRET`) kills the registered client and every user's session,
  including the reviewer's mid-review. Rotate only with a reason, and never during a review.
- **Continuous review** means a tool-schema change after publication is held until re-approved;
  new tools appear after automated checks. Plan schema changes as additive.

## 9. Not in scope

Custom UI (MCP Apps components); a multi-account `openai/profile` tool; Codex-specific packaging;
listing in other directories; translations; commerce.
