# cite-check

CLI that extracts every legal citation from a draft, verifies it against free legal databases (with Westlaw paste as fallback), persists verified records to the Contextspaces authorities store, and emits a flagged Table of Authorities + per-cite verification report.

## Usage

```bash
node cite-check/cli.mjs <draft.docx|draft.md> [--matter <short_code>] [--no-store]
```

Flags:
- `--matter <short_code>` — if set, every verified authority is linked to the named matter via `matter_authorities`. The matter must exist in Contextspaces (create it from the Vault rail if not).
- `--no-store` — skip persistence; useful for a dry run.

## Outputs

Both written next to the draft:
- `<draft>.toa.md` — clean Table of Authorities with verification flags.
- `<draft>.cite-report.md` — verbose per-cite audit trail (status, confidence, source, pin/signal, draft snippet).

## Environment

Reads `~/context-ai/.env`:
- `VITE_SUPABASE_URL` — Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY` — service-role key (CLI runs locally; RLS isn't the safety boundary).
- `ANTHROPIC_API_KEY` — for citation extraction + confidence rating.
- `CONTEXTSPACES_USER_EMAIL` _(optional)_ — defaults to `equainton@gmail.com`. Used to resolve the `contributor_user_id` for new authority records.

## Flag legend

- `✓ green` — verified against a free DB or already in the store; high confidence.
- `⚠ yellow` — citation valid but proposition is parallel/distant, pin missing, or rating is medium.
- `✗ red` — likely fabrication, mis-attribution, or proposition contradicts the source. Do not rely.
- `◇ blue` — Tier 3 (memorandum decision, unpublished, or otherwise off the free DBs). Paste the opinion text from Westlaw to upgrade to verified.

## Pipeline

1. Read the draft as plain text (mammoth for `.docx`).
2. Anthropic extracts every legal citation with surrounding proposition + pin + signal.
3. For each cite:
   - Look up in Contextspaces `authorities` (your private library + community pool).
   - If miss, fetch from Cornell LII (statutes / regs) or CourtListener (cases).
   - Score confidence with Anthropic given the retrieved source text.
   - Persist new verified records to Supabase (`authorities` + `authority_verifications`).
4. If `--matter` set, link to that matter via `matter_authorities`.
5. Emit the TOA and the report.

## Phase 1 limits (deliberate)

- **Proposition match** is not yet implemented (i.e., we don't compare the lawyer's "cited for" string against the case's actual holding). Schema supports it via `authority_propositions`; the check arrives in Phase 1.5.
- **Bluebook validation** is lenient — well-known reporter format and pin-cite presence only. Full Bluebook compliance is a later pass.
- **Westlaw paste** is flagged but not yet interactive. When a cite hits Tier 3, the report tells you which case needs the paste; a follow-up pass ingests it.
- **Free-DB coverage** is Cornell LII + CourtListener. Google Scholar / Justia / NY Slip Op are deferred — they don't have stable APIs and HTML scraping is brittle.

## Storage scope

Authorities created by the CLI default to `visibility = 'private'` — they're in your library only. The schema is ready for `community` once enough records accumulate to be valuable to share; the switch is a single field update on the records you elect to share.
