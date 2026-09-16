# W6 — Document states, transition gates, and citation verification

**Date:** 2026-09-16 · **Status:** SPEC for an Opus build session · **Owner of the thesis:** Eden (write-side, 08-25) · **Adds:** the citations-verified state agreed 09-16 (from strategy memo 003 §5.2)
**Depends on:** W1 ledger (`lib/ledger.mjs`, `record()`); can be built before W1 merges with a stubbed `record` that console.logs.
**Seal-adjacent:** yes. One-day wait before merge; adversarial review by a session that did not write it.

## 1. What this is

Read-side enforcement (the seal) says which minds may read a matter. Write-side enforcement says **which artifacts may move, in what state**. Two real failures in August motivated it: a privileged document staged outside the do-not-send folder with only a note, and a bracketed draft that read as client-ready and was nearly sent. Both were convention; this makes them state.

The 09-16 addition: a **citation-verification record per citation** and a derived document state, so that a brief cannot be sent or filed through the platform while a cite-check has flagged citations no human has verified. SB 574 (passed the California Legislature 2026-08-31, awaiting the Governor) would require, per the Sullivan & Cromwell summary of the bill, "reasonable steps" to "verify the accuracy" of AI output including "all case and statutory citations" (proposed Bus. & Prof. Code § 6068.1(a)(3)(B)), and would bar any filed paper from containing a citation not "personally verified" by a responsible attorney (proposed Code Civ. Proc. § 128.7(b)(2)). The bill text was not retrievable on 09-16; confirm wording against the enrolled text before any UI string quotes it.

## 2. Honest scope (read this before building)

The browser mints signed download URLs directly from Supabase Storage (`src/lib/pdf-source.ts:43,96`, `src/lib/discovery.ts:620`; RLS at `002_documents_and_passages.sql:350` lets any matter member read `vault-documents`). An API-level gate therefore **cannot** stop a human from downloading a file. That is correct: download is the human taking possession, which is the "humans commit" channel. **v1 gates govern the platform sending or delivering on the user's behalf**: Gmail send, Drive export, extension push-to-Drive, productions/deliveries, and MCP file tools. A storage-policy gate that would also block raw download is **v2**, seal-adjacent, and needs its own spec.

Nothing here is a prison. Gates fire only on the transitions listed, only for documents that carry a blocking state, and every refusal is a plain-language sentence in the existing style. Documents that have never been cite-checked pass with an advisory, not a block.

## 3. Data model

```sql
-- 06x_document_states.sql (verify prod columns first: the migrations folder drifts from prod;
-- probe the PostgREST OpenAPI spec per project_dev_environment_cautions before ALTERing).
alter table public.documents
  add column if not exists review_state text not null default 'draft'
    check (review_state in ('draft','reviewed','client_ready')),
  add column if not exists do_not_send boolean not null default false,
  add column if not exists do_not_send_reason text,
  add column if not exists citation_state text not null default 'unchecked'
    check (citation_state in ('unchecked','pending','verified'));
-- citation_state is DERIVED (see §4) — written only by the RPC below, never by the client.

create table if not exists public.citation_verifications (
  id uuid primary key default gen_random_uuid(),
  cite_check_run_id uuid not null references public.cite_check_runs(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  citation_key text not null,          -- stable key from the run's report entry (citation string + pin)
  verified_by uuid not null,           -- auth.uid() at write time, stamped by the RPC
  verified_at timestamptz not null default now(),
  note text,                           -- optional: "read the case; supports the proposition"
  unique (cite_check_run_id, citation_key)
);
-- RLS: SELECT for matter members (via document → matterspace); INSERT only through
-- `verify_citation(run_id, citation_key, note)` — SECURITY DEFINER wrapped in an INVOKER
-- plpgsql fn (feedback_rls_security_invoker_wrappers) that stamps auth.uid(); NO update, NO delete
-- (a verification is withdrawn by inserting a `withdrawn` row? No — keep v1 simple: verifications are
-- permanent; a re-run of cite-check starts a new run with no verifications).
```

Provenance stamp for generated artifacts (folds Grok §7): any document the platform creates (edit_pdf, assemble_documents, Editor export, deck composer) writes `metadata.provenance = { session_id, model, provider, source_document_ids, created_by_kind: 'user'|'charter'|'connector' }`. One helper, `stampProvenance(meta, ctx)`, in `lib/provenance.mjs`; call sites are the existing creators.

## 4. Derived states and the lint

- `citation_state`:
  - `unchecked` — no `cite_check_runs` row with `status='complete'` for this document.
  - `pending` — latest complete run has ≥1 report entry with flag in {red, lean_red, blue?} (decide: **red and lean_red block; blue (unverifiable) blocks; green and lean_green do not**) that has no `citation_verifications` row.
  - `verified` — every blocking entry of the latest complete run has a verification row.
  - Recomputed by a trigger on `citation_verifications` insert and on `cite_check_runs` status change. Function `recompute_citation_state(document_id)`.
- `review_state` is set by the user (Reviewed / Client-ready in the document menu). **`client_ready` is refused by the lint** when the file's extracted text contains `[` `]` bracket placeholders, `TODO`/`TBD`/`XXX`, tracked changes or comments (docx: `w:ins`/`w:del`/`w:comment` parts present), or `citation_state = 'pending'`. `lib/document-lint.mjs` returns `{ ok, reasons[] }`; runs server-side inside the state-change RPC. Reasons are sentences: "Two bracketed placeholders remain (pages 3, 7)."
- `do_not_send` is a user toggle with a reason; it never auto-sets.

## 5. Gates (v1 call sites, from the 09-16 code map)

One function: `assertMayLeave(supabase, documentId, transition)` in `lib/document-gates.mjs`, `transition ∈ {'send','export','deliver','mcp_file'}`. Refuses (throws `DocumentStateError`, plain language) when `do_not_send` is true, or `citation_state = 'pending'`; passes with `advisory` when `review_state != 'client_ready'` or `citation_state = 'unchecked'` (the API returns the advisory in the response; the UI shows it once).

| Surface | File | Insert after |
|---|---|---|
| Gmail send | `api/gmail-send.mjs` handler @38 | `storage_path` check @81, before download @140 |
| Drive export | `api/drive-export.mjs` handler @41 | check @86, before download @151 |
| Extension push | `api/ext/push-to-drive.mjs` @26 | check @61, before download @112 |
| Deliveries | `src/lib/discovery.ts createDelivery` @589 (insert @600) — move the gate server-side: a trigger on `deliveries` insert or the API that inserts it | before insert |
| MCP file tools | `lib/mcp-core.mjs callTool` @929 — for tools in the egress class (get_media, assemble_documents, send_to_sandbox? no: sandbox is internal) | inside `callTool`, after the seal check |

Each refusal and each advisory is recorded through W1: `record({ type: 'file.gate', payload: { document_id, transition, result: 'refused'|'advisory', reasons } })` (add `'file.gate'` to `EVENT_TYPES`). Each verification insert records `citation.verified` `{ document_id, run_id, citation_key }` — this is the supervision log the insurer and the bar will ask for (strategy 003 §5.1).

## 6. UI (discreet; no new chrome)

- **CiteCheckSurface → CiteDetail** (`src/components/matter/CiteCheckSurface.tsx:460-479`): add one control per citation, "Mark verified" with an optional one-line note, which calls `verify_citation`. Verified entries show who/when in the existing detail style. The flag chips at :378-420 get a small count "3 to verify".
- **Document menu**: "Reviewed", "Client-ready" (runs the lint; shows reasons inline if refused), "Do not send…" (reason). State shows as one quiet word next to the title, same weight as the seal lock.
- **Refusal copy**, e.g.: "This brief has 2 citations the cite-check flagged that no one has marked verified. Verify them in Cite-check, then send." Never "compliance", never "audit".

## 7. Proof

`scripts/_verify-document-gates.mjs` (PGlite, offline): migration applies over stub tables; `verify_citation` stamps `auth.uid()` and refuses a forged `verified_by`; `citation_state` recomputes on insert and on run status; lint refuses brackets/TODO/tracked changes and passes clean text; `assertMayLeave` refuses `do_not_send` and `pending`, advises on `unchecked`, passes `verified`+`client_ready`; ledger events emitted (stub `record`). Plus the existing `_verify-seal-pipes.mjs` still green (gates must not change egress hostnames).

## 8. Kickoff prompt (Opus session)

"Read `docs/specs/W6-document-states-and-citation-verification.md` and build exactly it: migration `06x_document_states.sql` (execute in PGlite first; probe prod columns before ALTER), `lib/document-lint.mjs`, `lib/document-gates.mjs`, `lib/provenance.mjs`, the five gate call sites, the CiteDetail verify control, the document-menu states, `_verify-document-gates.mjs`. If W1's `lib/ledger.mjs` is not on main yet, stub `record` locally with a TODO. Fresh worktree from origin/main; one PR; no Co-Authored-By. Do not touch `mcp-core.mjs` beyond `callTool`."
