# CLAUDE.md — context-ai (ContextSpaces)

## ⚠️ MERGE WARNING: `lib/mcp-core.mjs` and `api/mcp.mjs` (2026-08-08)

The branch `feat/av-ocr-ingest-sliders` (AI Courtroom work) carries an **old
copy** of `lib/mcp-core.mjs` / `api/mcp.mjs`. It predates tools that are now
**live in production** from main: `get_matter_state`, `set_matter_state`,
`create_matter`, `move_document`, `copy_document`, `send_to_sandbox`,
`assemble_documents`.

When merging that branch (or any long-lived branch) into main:

- **Keep main's version** of `lib/mcp-core.mjs` and `api/mcp.mjs`, then
  re-apply only the branch's genuinely new changes on top.
- Never resolve conflicts in these files by taking the branch's copy
  wholesale — that silently deletes deployed MCP tools, and the next Vercel
  deploy removes them from production.
- The branch's `assemble_documents` work is already on main (commit
  `98cd463`, ported 2026-08-08) — those edits are redundant; drop them.

## Commit authorship

Commits and PRs are authored solely by Eden Quainton (Tiewasters99). Never
add `Co-Authored-By` or AI-attribution trailers.

## Deploys

Pushing to `main` auto-deploys via Vercel (site + `/api/*` including the
hosted MCP endpoint at `/api/mcp`). claude.ai chats cache the connector's
tool list — after deploying new MCP tools, verify in a **new** chat.
