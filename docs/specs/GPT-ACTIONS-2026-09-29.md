# Contextspaces as a Custom GPT with Actions — scope (2026-09-29)

**Why.** ChatGPT's custom MCP connectors ("Developer mode" apps) are set up and used
on desktop web only; the ChatGPT phone app will not load them. James Bushell has no
laptop. A **Custom GPT with Actions** runs in the ChatGPT iOS and Android apps with
nothing to enable: the user opens the GPT, signs in to Contextspaces once through
OAuth in the in-app browser, and asks. This also makes true what
`docs/strategy/001-avoid-rented-land.md` already claims: REST + Custom GPT support.
Today there is no OpenAPI document in the repo.

**Shape.** One serverless function, `api/gpt/[op].mjs`, is a thin REST facade over the
same tool core the MCP endpoint uses (`lib/mcp-core.mjs` `callTool`). Same bearer
tokens, same per-matter grants, same RLS as the user. A static OpenAPI 3.1 document
describes it. A confidential OAuth client (id + secret) is added beside the existing
public PKCE flow, because GPT Actions do not do PKCE.

## 1. What the GPT can do (operations)

Fifteen operations, each mapped to an existing MCP tool; read-mostly, no deletes, no
moves, no PDF editing, no sandbox.

| operationId | MCP tool | Notes |
|---|---|---|
| `listMatters` | `list_matters` | The map; the GPT is told to call it first. |
| `listMatterContents` | `list_matter_contents` | One matter's documents. |
| `searchMatter` | `search` (matter set) | Page:line passages. `limit ≤ 20`. |
| `searchAll` | `search` (matter omitted) | Every matter the user can read. |
| `grepMatter` | `grep` | Exact phrase. |
| `getPassage` | `get_passage` | One passage with its neighbours. |
| `getOutline` | `get_outline` | A document's headings/pages. |
| `getMatterState` | `get_matter_state` | The lawyer's notes on the matter. |
| `setMatterState` | `set_matter_state` | Write, small. |
| `fileText` | `file_document` (utf8 only, ≤ 200 KB) | A note or a draft into a matter. |
| `checkIngest` | `check_ingest_status` | |
| `myTasks` | `my_tasks` | |
| `claimTask` / `postResult` | `claim_task` / `post_result` | The agents platform, so a phone can pick up and answer a task. |
| `createChart` | `create_chart` | Returns the SVG's document id, not the SVG. |

Not exposed: `get_media` (signed URLs leaving through a third party), `assemble_documents`,
`edit_pdf`, `move_document`, `copy_document`, `create_matter`, `send_to_sandbox`,
`create_deck`, `ingest_document` (force re-runs), `ask_human` (no channel back).
Add later if wanted; each is one row in the table.

**Response caps** (Actions truncate silently past ~100 KB): passage text ≤ 4,000
characters per passage, ≤ 20 passages; contents lists paged at 200 with a `next`
cursor; every response carries `{ matter: {id, name}, truncated: bool }` so the GPT can
say "there is more".

## 2. Auth

- **Token check** — factor the MCP endpoint's bearer resolution out of `api/mcp.mjs`
  into `lib/oauth-bearer.mjs` (`resolveBearer(req) → { userId, grant }`), so the
  facade and the MCP endpoint cannot drift. Per-matter grants (the consent screen's
  ticks) apply exactly as for MCP; the pause (099) refuses as it does today.
- **Confidential client** — GPT Actions send `client_id` + `client_secret` to the
  token URL (POST body or Basic) with **no `code_verifier`**. Today `/api/oauth-token`
  requires PKCE and `/api/oauth-approve` requires `code_challenge`. Add:
  - a client record kind `typ:"client", confidential:true, secret_hash` minted by an
    admin script (`scripts/register-oauth-client.mjs <name> <redirect_uri…>`) with
    `MCP_OAUTH_SECRET`; prints `client_id` (the signed JWT) and the one-time secret;
  - `/api/oauth-approve`: `code_challenge` optional when the client is confidential;
  - `/api/oauth-token`: when the client is confidential, require the secret (constant-time
    compare against `secret_hash`) instead of PKCE; everything else unchanged
    (refresh tokens, grant ids, expiry).
  - **Built 2026-09-29 (steps 1–2).** `lib/oauth-bearer.mjs` holds `authenticate`
    (alias `resolveBearer`), `AuthError`, `adminClient`, `userScopedClient`,
    `callToolOptsFor`; `api/mcp.mjs` imports and re-exports them. `lib/oauth-clients.mjs`
    mints and checks confidential clients. The token endpoint takes the secret in the
    POST body **or** as HTTP Basic (OpenAI's docs list the fields but not their
    transport), on the code exchange and on every refresh; a confidential client that
    sent a `code_challenge` is still held to the verifier (no downgrade). The metadata
    advertises `none`, `client_secret_post`, `client_secret_basic`. `scripts/register-oauth-client.mjs
    --name … --redirect … --out <file>` writes id + secret to the file and prints only
    its path (never run it where stdout is captured in a chat). Harness:
    `scripts/_verify-oauth-confidential.mjs` (60 checks).
- **Redirect URIs** — a GPT's callback is `https://chat.openai.com/aip/g-<GPT_ID>/oauth/callback`
  (and the `chatgpt.com` twin). The GPT id exists only after the GPT is created, so
  set-up is: create the GPT in the builder → copy the callback → run the script with
  it → paste id + secret into the builder's OAuth panel. Documented on a new page
  `/gpt-connect` (sibling of `ChatGPTConnect.tsx`), with the phone framing.
- **Scope** — one scope, `contextspaces`, informational; matter rights come from the
  consent screen, as now.

**Built 2026-09-29 (mint on the server).** `MCP_OAUTH_SECRET` is a Sensitive variable in Vercel, so
the local script cannot obtain it. `POST /api/oauth-client-mint` mints the confidential client where
the secret already lives and returns only the client id + one-time secret; callable by a signed-in
user whose email is in `OAUTH_CLIENT_ADMIN_EMAILS` (unset = endpoint off, 503). Page:
`/app/connections/gpt-client` (`src/pages/GptClientMint.tsx`). Harness `scripts/_verify-oauth-client-mint.mjs`.

**Built 2026-09-29 (wildcard callback).** Live test showed the builder issues a NEW callback id
(`/aip/g-<id>/oauth/callback`) on every save of the OAuth settings, and a new client id is such a
save, so a client pinned to one id is refused on the next attempt. A confidential client may now
register one whole-segment wildcard in the path (`https://chat.openai.com/aip/*/oauth/callback`);
host and the rest of the path stay exact, public clients stay exact-match only, and the code still
binds the exact callback it was minted for (`lib/oauth-clients.mjs` `redirectUriAllowed`). The
mint page is prefilled with the two wildcard lines.

## 3. The OpenAPI document

`api/gpt/openapi.mjs` serves `/api/gpt/openapi.json`: OpenAPI 3.1, `servers` derived
from the request host (works on previews), one path per operation, request bodies from
the MCP tools' own `inputSchema` (trimmed to the exposed parameters), response schemas
hand-written and small, `x-openai-isConsequential: true` on `fileText`,
`setMatterState`, `claimTask`, `postResult` (so ChatGPT asks before each write) and
`false` on every read (no "Allow?" tap on every search). Under 30 operations, as OpenAI
requires. A harness (`scripts/_verify-gpt-openapi.mjs`) validates the document against
the OpenAPI 3.1 JSON schema and checks every `operationId` maps to a tool that exists.

**Built 2026-09-29 (steps 3–4).** `lib/gpt-ops.mjs` is the whole contract: the `OPS` table
(15 operations), `shapeArgs` (only exposed parameters pass, typed against the tool's own
`inputSchema`, clamped: passages ≤ 20, contents page 200, grep ≤ 200 matches / 400 context
chars, `getPassage` ≤ 2 context pages; `fileText` text extensions only, ≤ 200 KB, utf8 forced),
`capResult` (strings > 4,000 chars cut, then the largest array halved until the JSON is under
90,000 chars; `truncated:true` either way), `httpFor` (sealed/paused/agent-scope → 403,
"not found" → 404, bad input → 400, meter refusal → 429 + Retry-After, else 500) and
`buildOpenApi(origin)`. One Vercel function, `api/gpt/[op].mjs`, serves every operation AND
the document (`GET /api/gpt/openapi.json`, rewritten to `/api/gpt/openapi`; the handler also
answers the `.json` spelling itself); `api/gpt/openapi.mjs` was not created. Response
envelope: `{ok, op, matter:{id,name,short_code}|null, truncated, data}`; errors
`{ok:false, error, message}`. `createChart` is marked consequential too (it files a
document). Harness: `scripts/_verify-gpt-openapi.mjs` (73 checks, fakes, no database).

## 4. The GPT itself (builder settings)

- Name **Contextspaces**; description "Your matters, documents and record, from
  Contextspaces, with page:line citations."
- Instructions (kept in `docs/specs/gpt-instructions.md` and pasted): call
  `listMatters` first in a conversation; stay inside the matter the user names; cite
  every fact to document and page; never answer from memory what the record can be
  asked; say plainly when a search returns nothing; never describe a sealed matter's
  content (the API refuses; explain the refusal).
- Actions: import from `https://www.contextspaces.ai/api/gpt/openapi.json`; auth OAuth
  (client id, secret, authorize `https://www.contextspaces.ai/oauth/authorize` (the existing consent page, as the OAuth metadata names it), token
  `https://www.contextspaces.ai/api/oauth-token`, scope `contextspaces`, token
  exchange POST); privacy policy URL — the builder requires one; the repo has no `/privacy` route today, so step 5 adds a short static page.
- Sharing: "Anyone with the link" for James and any client; each user signs in with
  their own Contextspaces account, so what they see is theirs by RLS. Listing in the
  GPT Store is a later, separate step (OpenAI review).

**Built 2026-09-29 (step 5).** Public routes `/gpt-connect` (`src/pages/GptConnect.tsx`: the
phone reader's page — steps, can/cannot, how information is handled, switching it off, a
lawyer's set-up footnote; `GPT_LINK` constant to fill once the GPT exists) and `/privacy`
(`src/pages/Privacy.tsx`, operated by Grapheon.ai, LLC; the landing footer's Privacy link now
points here). `docs/specs/gpt-instructions.md` holds the paste-ready builder text (name,
description, instructions, starters, Actions/OAuth settings, first-test script). Connections ›
ChatGPT carries a callout to the phone route. Remaining: step 6 (Eden: create the GPT, mint
the client, test on an iPhone).

## 5. Build plan and estimate

| Step | Work | Est. |
|---|---|---|
| 1 | `lib/oauth-bearer.mjs` factored out of `api/mcp.mjs`; MCP keeps working (harness: `_verify-mcp-auth`) | 1 h |
| 2 | Confidential client: register script, approve + token changes, harness for both flows | 2 h |
| 3 | `api/gpt/[op].mjs` facade over `callTool`, caps, error shapes (401/403/404/429 as JSON) | 2 h |
| 4 | `api/gpt/openapi.mjs` + validator harness | 1.5 h |
| 5 | `/gpt-connect` page, `/privacy` page, `docs/specs/gpt-instructions.md` | 1.5 h |
| 6 | Create the GPT, register the client, end-to-end on an iPhone (sign-in, `listMatters`, `searchMatter`, `fileText` with the consequential prompt) | 1.5 h |

About one working day (≈ 9.5 h), then James tests on his phone. No migration: grants, pause and
the seal already live in the database and are enforced by the shared core.

## 6. Risks and limits (stated, not solved)

- **Actions time out at ~45 s** and do not stream. Long searches are already fast (one
  RPC, 0.2–3 s); `fileText` of a large document would queue, and the response says so.
- **Response size.** Capped as above; the GPT is told there may be more.
- **OpenAI can change the Actions OAuth contract** (it has: token exchange method,
  callback host). The confidential-client code path is small and isolated.
- **Sealed matters.** The seal is enforced by the core as for MCP (aal2 required); the
  GPT cannot step up, so sealed matters simply do not answer, with the reason.
- **Vercel function count.** Two new functions (`gpt/[op]`, `gpt/openapi`); well under
  the plan's limit.

## 7. What is NOT in scope

Publishing to the GPT Store; a Contextspaces "app" in ChatGPT's app directory; any
change to the MCP connector; write operations beyond the four listed; media downloads.
