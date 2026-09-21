# CI

`.github/workflows/ci.yml` runs on every pull request and on every push to
`main`. Before this file existed the repo had no `.github/` at all: the ~30
harnesses in `scripts/` were run by hand, which meant Eden was the only check
on every PR.

**No secrets.** The workflow declares none, reads none, and nothing in it
needs `.env`. A harness that needs a key or a live database is not in CI —
those are listed under [Deliberately not in CI](#deliberately-not-in-ci).

**The other workflow.** `.github/workflows/ingest-nightly.yml` is scheduled,
not per-PR: an hourly liveness watch (no secrets), a six-hourly ingestion
monitor and the nightly ingestion suite (both secret-bearing, and both skipping
with a notice when the secrets are absent). It is documented on its own in
[docs/INGEST_MONITORING.md](INGEST_MONITORING.md) — including which repository
secrets to add and the trade-off in putting a service-role key in GitHub. It
does not run here and nothing in `ci.yml` depends on it.

## What runs

| Step | Command | Notes |
| --- | --- | --- |
| Install | `npm ci` | Node 22 (`engines: ">=22"`, `worker/Dockerfile` pins `node:22-slim`). `PUPPETEER_SKIP_DOWNLOAD=1` — nothing here drives a browser. |
| Types | `npx tsc -b` | |
| Bundle | `npx vite build` | |
| Lint | `npm run lint` | **Non-blocking** — see below. |
| PGlite | `npm i --no-save @electric-sql/pglite@0.5.8 @electric-sql/pglite-pgvector@0.0.9` | Harness-only; `--no-save` keeps it out of `package.json`. |

Then the offline harnesses, one step each, each with
`if: ${{ !cancelled() }}` so a red one does not hide the rest (the count is
left out of this sentence on purpose — it went stale twice in a week; count
the `run:` lines in `ci.yml`):
Then the twenty-three offline harnesses, one step each, each with
Then the twenty-four offline harnesses, one step each, each with
Then the twenty-five offline harnesses, in twenty-four steps — the two
Bucketizer evidence harnesses share one — each with `if: ${{ !cancelled() }}`
so a red one does not hide the rest:
Then the twenty-three offline harness steps, one step each, each with
`if: ${{ !cancelled() }}` so a red one does not hide the rest:

| Harness | What it proves | How it stays offline |
| --- | --- | --- |
| `_verify-seal-pipes.mjs` | Sealed content reaches no provider but our own SageMaker endpoint. | Stubs `fetch` with an egress witness; deletes any ambient `AWS_*` first. |
| `_verify-bedrock-pen.mjs` | `choosePen` matrix, SigV4 wire shape, SSE accumulation for the sealed pen. | Sections 1–3 are stubbed; the live section self-skips when `../.env` is absent or the `BEDROCK_*` values are `PASTE`. |
| `_verify-voyage-route.mjs` | `lib/aws-sigv4.mjs` reproduces AWS's published worked example; request shape. | Sections 1–2 are pure computation; section 3 skips without `SAGEMAKER_VOYAGE_ENDPOINT`. |
| `_verify-embed-hold.mjs` | A parked embedding endpoint yields a typed error after one call, not a retry loop. | Default mode stubs `fetch`; `--live` / `--deployed` are opt-in flags CI never passes. |
| `_verify-sealed-no-fallback.mjs` | A sealed matter with no sealed pen refuses; it is never served quietly by another provider. | Stubs `fetch` and records every request, so each case asserts what was contacted, not just what was decided. |
| `_verify-sealed-meetings.mjs` | A sealed meeting's verbatim transcript never reaches first-party Anthropic; `/api/meeting-chat` and `/api/meeting-flag` are driven with a fake req/res. | Stubbed `fetch` answers for Supabase; every key in the file is a fake string. |
| `_verify-llm-sealed-route.mjs` | `/api/llm` on a sealed matter reaches the sealed pen or is refused — never forwarded to the provider the browser named. Includes the spend cap meeting the seal. | Drives the real handler with stubbed `fetch` and a stubbed meter RPC. |
| `_verify-sealed-preamble.mjs` | The sealed pen's preamble (`lib/pen-preambles.mjs`) leads a sealed system prompt exactly once, is absent from every first-party pen including a Tier-B escalation, and its version reaches the Record. Also the eval kit's guards, sampler, estimator and `--dry` path. | Stubbed Supabase + witnessed `fetch` for the Assistant loop; the eval's `--dry` stubs its own pen and restores `fetch`. See `docs/SEALED_PEN_EVAL.md`. |
| `_verify-agent-charter.mjs` | A charter can only take tools away. | Part 2 runs only when an API URL is given as `argv[2]`. |
| `_verify-agent-tools.mjs` | The Agents tab never offers a tool the server would drop. | Reads four source files and compares names. |
| `_verify-job-priority.mjs` | Migration 057 — queue priority, partial indexes, single RPC overload. | PGlite: real Postgres in WASM, running the real migration files. |
| `_verify-recovery-sweep.mjs` | Migration 058 at production scale (1,641 error jobs per victim). | PGlite. |
| `_verify-ready-but-empty.mjs` | Migration 059 returns exactly the empty-but-ready rows. | PGlite. |
| `_verify-held-status.mjs` | Migration 060 — a `held` row is picked up by nothing. | PGlite. |
| `_verify-search-model-scope.mjs` | Migration 061 — no cosine across two embedding spaces, and migration 074 leaves that untouched. | PGlite + pgvector. |
| `_verify-search-rls-authorize.mjs` | Migration 078 — the search runs the access check once per MATTER instead of once per passage, so the search itself is `SECURITY DEFINER`. Creates `anon` / `authenticated` / `service_role` (BYPASSRLS) for real, enables RLS with production's own `can_access_matter` → `matter_role` → `matter_ancestry`, and asserts from inside `SET ROLE` with `request.jwt.claims` set: every answer byte-identical to **074 under RLS** for an authorized caller; zero rows from a matter smuggled into `p_matterspace_ids`; zero rows for `anon` even handed every id in the database; a bypassing caller's array passed through unreduced; both of 074's branches; `anon` holds neither EXECUTE on the core nor USAGE on its private schema. Negative control: the reduction is deleted from the real migration file and the forbidden matter comes straight back. | PGlite + pgvector, real roles and real RLS. |
| `_verify-search-scope-router.mjs` | Migration 074 — the search timeout fix. Runs 056 → 061 → 074 over one corpus and requires every answer to be **byte-identical**, then pushes 074's `contextspaces.search_exact_max` GUC below the corpus so the whole battery runs again on the ANN branch. Asserts on each branch separately that a matter left out of `p_matterspace_ids` (the sealed/paused descendant case, PRs #181/#179) cannot be reached, with a negative control that puts it back. Also: the exact branch's ORDER BY provably cannot use the HNSW index, the ten-argument signature and fifteen columns are unchanged, 074 is idempotent, and 056 → 074 with no 061 in between still carries 061's guarantees. | PGlite + pgvector. |
| `_verify-profiles-rls.mjs` | Migration 062 — `profiles` exposes no email column, and the policy wrapper is SECURITY INVOKER. | PGlite. |
| `_verify-usage-budget.mjs` | Migration 063 — the spend cap's database half: budgets hold, every admitted request is recorded, an unknown tier falls back to `free`. | PGlite. |
| `_test-usage-meter.mjs` | The spend cap's handler half — `lib/usage-meter.mjs` and `lib/usage-prices.mjs` (31 tests). | `node --test`; the RPC is stubbed, no database and no network. |
| `_verify-office-tenancy.mjs` | The Office serves one owner's published room; a widened query cannot widen the room. | Drives the pure exports of `api/office.mjs` with stubbed rows for two tenants. |
| `_test-stamp-scans.mjs` | A CM/ECF-stamped scan routes to OCR, keeps its real page count, and a forced re-run swaps text in rather than wiping it. | In-memory fake Supabase; OCR and embeddings are stubs. |
| `_verify-reflow.mjs` | The deterministic reading reflow. | Imports `src/lib/*.ts` via Node's built-in type stripping (needs Node ≥ 22.18). |
| `_verify-findquote.mjs` | The assistant's "take me there" locator. | Same. |
| `_verify-reader-copy.mjs` | Reader clean-copy extraction against a faked two-page PDF. | Same, plus `node --import ./scripts/_node-src-loader.mjs` — `reader-copy.ts` imports through the vite `@/` alias, which plain node cannot resolve. |
| `_verify-matter-record.mjs` | The Record's read side: the sub-matter roll-up, paging past 1,000 rows, a plain line for every event kind (and for one it has never heard of), the sealed-route wording, the attorney's cells left empty, a byte-identical markdown export, a `.docx` that opens, the not-deployed state and a tampered chain. | Synthetic events and an in-memory Supabase stub, both built inside the harness; `node --import ./scripts/_node-src-loader.mjs` for the `src/` imports. |
| `_verify-llm-record.mjs` | Migration 073 — every model call a FEATURE makes through `/api/llm` reaches the matter's Record, and nothing about the Record reaches a provider: every feature label round-trips and an invented one becomes `unspecified`; sentinels planted in the system prompt, the messages, the document ids, the model name and the provider's error body appear in no stored row; sealed + a real write failure refuses with zero provider requests and settles the pre-charge; sealed + "not pasted yet" (PGRST202 **and** 23514 on `events_kind_check`) behaves exactly as main; unsealed + a failure still answers; streaming and non-streaming each leave a paired row; the substituted pen is the model recorded. | Drives the real `api/llm.mjs` with a fake req/res and a witnessing `fetch` stub; `node --import ./scripts/_node-src-loader.mjs` for the one `src/` import. Its negative control imports `origin/main:api/llm.mjs` (materialised under a gitignored `.tmp-negative/` at repo depth so its own `../lib/...` imports resolve) and compares the Tier-A provider request byte for byte; where that ref is not fetched — a shallow CI checkout — it prints SKIP. |
| `_verify-ledger-account.mjs` | Migration 072 — a cross-matter connector call is recorded on the account chain and fanned out into each matter it read from, with neither record revealing the other's matters; `ai_sessions` / `ai_messages` are immutable; 072 no-ops without 064. | PGlite, twice over: once on a database that has 064 (the negative control runs first, on 064 alone) and once on a clean one that never saw it. The real `lib/ledger.mjs` is driven through a supabase-shaped adapter, so the redaction is tested as it runs. |
| `_verify-discovery-pipeline.mjs` | A document production survives the queue that was rewritten around it: intake → tag → privilege log → Bates → package → delivery, over 030 + 032 + 044 + 045 + 055 + 057 + 058 + 059 + 060 executed in order. Gapless and re-runnable numbering, the lock guard, `package_sha256` against the stored bytes, withheld items absent from the package and present in the log. | PGlite for the real migrations, an in-memory Map for storage, the real `lib/discovery/*` engine. The worker cannot be imported (top-level script, service-role key, poll loop), so its orchestration is transcribed and the last section greps `worker/discovery-worker.mjs` for the invariants it transcribes. Those guards are a superset test and a WARN, never a check that reddens on somebody else's fix. |
| `_verify-ingest-day-one.mjs` | Day one for a new paying user: accepted/refused types, serverless-budget routing, the suite's deadlines and checkpoint, digest privacy. Runs `_verify-ocr-routes.mjs` as a child and asserts its exit code. | Pure computation plus stubbed fetch; reads no `.env`. |
| `_verify-worker-heartbeat.mjs` | Migration 066 — the worker heartbeat, the aggregate liveness functions, **two tenants each seeing only their own queue numbers**, the worker hunk swallowing every kind of heartbeat failure, the sentence the Vault shows, and the nightly workflow's own YAML. | PGlite for the migration; a stub client for the worker hunk; Node type stripping for `src/lib/ingest-service-notice.ts`; and it spawns `ingest-suite.mjs --dry-run`, which exits before the first request. |
| `_verify-bucketizer-scale.mjs` | Whole-document windowing, the resumable run, the meter pause, the deterministic merge, and the paged read shared with Discovery. | Same; the model, the database and PostgREST all arrive as injected deps. |
| `_verify-bucketizer-evidence.mjs` | Migration 068 — `bucketizer_evidence`, the pair-level run state, and the cascade that takes a quotation with its passage when a document is re-ingested. | PGlite. Shares one CI step with the harness below. |
| `_verify-bucketizer-outline.mjs` | Verbatim quotation (a span the stored passage does not hold is dropped, never repaired), citations that degrade where the record has no line numbers, gaps-first assembly, a byte-identical `.md` on a re-run, and a real `.docx` read back with the repo's own docx library. | Same as `_verify-reader-copy.mjs`; every effect is an injected dep. |
| `_verify-export-gate.mjs` | A sealed matter's document does not leave for an outside service without the user being told, and, where a Record exists, without it being written down: 409 with an egress witness of zero storage reads and zero outside requests, a confirmation that must be literally `true`, a metadata-only `file.exported`, fail-closed on an unreadable (including inherited) tier, and an unsealed export byte-identical to main's. Runs its whole table against every destination — Google Drive, the extension's push, Gmail, **and both `/api/cloud-export` drives**. | Stubs `fetch` and answers as Supabase, Google, Microsoft and Dropbox, so the real `supabase-js` client and the real tier walk run unmodified. Its negative control reconstructs each ungated handler by deleting the marked gate block and watches the document's own bytes leave; the "the reconstruction IS `origin/main`'s file" assertion prints SKIP where the base ref is not fetched. |
| `_verify-cloud-drives.mjs` | OneDrive and Dropbox export. Migration 075 from three drift states (026→029→075, 026→075 with 029 never applied, and no `connections` table at all), idempotent, converging to exactly one `kind` check. Then: the authorize URL asks for the app-folder scope and nothing wider, PKCE is S256 and the verifier lives in an HttpOnly cookie rather than in the state; a state minted for the other drive, a forged state and a code with no cookie are each refused with nothing exchanged; Microsoft's rotating refresh token is written back and Dropbox's is not; the upload lands at `Contextspaces/<matter>/<file>` inside the app folder with sanitized names and never-overwrite flags, over the provider's upload-session API for a large file, with the `Dropbox-API-Arg` header ASCII-escaped; every endpoint answers 503 `not_configured` while the two applications are unregistered; and `api/drive-export.mjs` is byte-for-byte `origin/main`'s. | PGlite for the migration; `fetch` stubbed and witnessed for everything else. **No request reaches Microsoft or Dropbox** — there are no app registrations yet, and the harness must keep working on the day there are. The seal is not re-proved here; it lives in `_verify-export-gate.mjs` above. |
| `_verify-cite-check-contracts.mjs` | Cite-check's two model calls held to their output contracts, which matters most inside the seal: extraction that is not a citations array is repaired once and then refused, rather than becoming "this brief cites nothing"; a citation whose `raw` is not in the draft is set aside; a rating outside {high, medium, low} is repaired once and then reported as **not checked** — never as "not found" and never as verified, with no `authorities` row written; 402 / 429 / a sealed refusal pass through with the server's own sentence on the FIRST turn and on the REPAIR turn; and the report's arithmetic reconciles (extracted = checked + not checked). | Drives the real `extractCitations` and `checkOne` through the real `structured.ts`, `auth.ts`, `refusals.ts` and adapter. `@/lib/supabase` is swapped by a second resolve hook for a fixture that records every attempted write, and `/api/llm` + `/api/legal-source` are replaced by an egress witness — any other url throws. `node --import ./scripts/_node-src-loader.mjs` for the `@/` imports. |
| `_validate-cover-manifest.mjs` + `_test-cover-gating.mjs` | The cover picker: `core-covers.json` is sorted, points only at files that exist and are under the size cap, and holds no filename the exclusion list bars; then the gate itself — core for every plan but `workshop`, core while the plan is still loading, and **nothing** (never everything) if the allow-list will not load. | One step, two commands. Both read files off disk; the second imports `src/lib/covers.ts` via Node type stripping, which is why that module has no `@/` imports and no React. |
| `_test-ingest-estimate.mjs` | What a big upload will cost, before it draws on the month: the arithmetic over the real price table (it imports `lib/ocr-routes.mjs` and `lib/ocr-textract.mjs` and reddens if a mirrored rate has drifted), the four-axis threshold matrix in both directions, sealed vs unsealed rates on the same files, "the first N of these fit", and the handler's refusal to take the browser's arithmetic on trust — including that an ordinary upload's request body is still byte for byte the one `/api/ingest` has always taken. | Pure functions over `lib/ingest-estimate.mjs`; no file is parsed, no provider called, no database touched. The wiring in `src/` is checked by narrow source assertions rather than by mounting anything. |

The first fourteen were executed on `main` at `b97d6c6` before the workflow was
written. Seven of the next eight arrived with PRs #156–#163, each proving
something the workflow was not yet watching — the seal, the spend cap, profile
privacy, Office tenancy. The eighth, `_test-stamp-scans.mjs`, predates #155 and
was simply missed: it appeared in neither table here. All eight were added at
`0ed288d`, where each was run from a checkout with no `.env` and each exits 0.
`_verify-bedrock-pen.mjs` changed after #155 and was re-run at `0ed288d` too:
still green. The last two — `_verify-ingest-day-one.mjs` and
`_verify-worker-heartbeat.mjs` — came with the ingestion work of 2026-09-19/20
and were each run from a checkout with no `.env` before being added here. The
PGlite harnesses finish in ~1.4–2.2 s each.
still green. The three Bucketizer harnesses came with PRs #168 and #177 and
were each run from a checkout with no `.env`. The PGlite harnesses finish in
~1.4–2.2 s each; the eight added at `0ed288d` cost about 5.5 s of harness time
in total.

`_verify-matter-record.mjs` arrived with the Record's read side: 87 checks,
run from a checkout with no `.env`, exit 0, about a second. It builds its own
synthetic events and its own Supabase stub, so it needs neither PGlite nor a
network. It has since grown two sections — the feature AI calls the export
pairs, and a word-list sweep that fails the build if database vocabulary
("hash", "chain", "migration", "payload", "not deployed", …) reaches anything
a reader sees.

`_verify-llm-record.mjs` arrived with migration 073 and the write side of the
same lane. Run from a checkout with no `.env`, exit 0, about a second; the
negative control ran locally against a fetched `origin/main` and is expected
to print SKIP in CI, where the checkout is shallow.

`_verify-export-gate.mjs` arrived with PR #167 and was added to `ci.yml` in
that PR, but its row here was missed; it is filled in above by the OneDrive /
Dropbox change, which extends the same harness rather than writing a second
one. `_verify-cloud-drives.mjs` is that change's own harness: run from a
checkout with no `.env`, exit 0, about three seconds including PGlite. Both
were re-run together after the extension, and both are green.

### Lint is non-blocking, for now

`npm run lint` on `main` at `b97d6c6` reports **68 problems (60 errors, 8
warnings)** — overwhelmingly `react-hooks/set-state-in-effect` and
`@typescript-eslint/no-explicit-any` in `src/`. Blocking on that today would
fail every PR for debt none of them introduced, and a mass fix deserves its own
change. So the step carries `continue-on-error: true`. When the count reaches
zero, delete that line and the comment above it in `ci.yml`.

## Deliberately not in CI

These are the **LIVE** harnesses. Each one signs in against production
Supabase (usually a service-role magic link), or calls a paid provider, or
needs a running server. They read `.env`, which CI does not have and must not
have. Run them by hand from a checkout that does.

PRs #156–#163 added no new LIVE harness. Two on this list were *changed* in
that window — `_verify-llm-gate.mjs` grew the sealed-route cases and
`_verify-assistant-tiers.mjs` followed the same refusal — and both remain live
for the same reason as before: they sign in and spend money.

| Harness | Why it cannot run in CI |
| --- | --- |
| `_verify-llm-gate.mjs` | Magic-link sign-in; hits prod `/api/llm`; **temporarily re-tiers a real matter to B**. |
| `_verify-mcp-seal.mjs` | Same, against the real database through `lib/mcp-core.mjs`; seals and restores a real matter. |
| `_verify-assistant-tiers.mjs` | Real chat turns against prod `/api/assistant`; costs tokens. |
| `_verify-securespace-rls.mjs` | Real-user RLS proof for migration 051; writes and deletes rows. |
| `_verify-marginalia-rls.mjs` | Real-user RLS proof; writes and deletes a note and a link. |
| `_verify-list-item-links.mjs` | Real-user RLS proof; creates a page and a sub-matter, then deletes them. |
| `_verify-recovery-budget.mjs` | Writes throwaway documents and queue rows to prod, calls `recover_stranded_documents`. |
| `_verify-search-two-stage.mjs` | Embeds the query at OpenAI and runs `search_passages` against prod. |
| `_verify-anytext-session.mjs`, `_verify-anytext-delete.mjs` | Real Supabase session / delete path. |
| `_verify-invite-endpoint.mjs`, `_verify-invite-live.mjs` | Needs `RESEND_API_KEY` and the deployed invite endpoint. |
| `_verify-portfolio-unpack.mjs` | Service-role unpack of a real document, by id. |
| `_verify-pdfjs-assets.mjs` | Reads a real PDF out of Storage with the service role. |
| `_verify-reader-pagination.mjs` | Puppeteer against a running dev server. |
| `_verify-reflow-spacing.mjs` | Fetches a real book from prod `/api/office`, and shells out to `git` to build the `origin/main` comparison. |
| `_verify-ocr-routes.mjs` | Its plan-only mode does run offline, but it asserts nothing and always exits 0 — it just reports which OCR routes this environment has keys for. The proof is `--live`, which needs keys and costs money. Not a gate. |
| `worker/e2e-live-test.mjs` | Drives a whole document production through the **deployed** Fly worker against prod, with the service role: uploads to `discovery-files`, enqueues `intake_files`, stamps, packages, downloads. Every run permanently spends Bates numbers in the sandbox matter (`bates_registry` is `ON DELETE RESTRICT` by design), so `--cleanup` can never fully undo it. `--plan` prints the whole procedure and touches nothing; `scripts/_verify-discovery-pipeline.mjs` is the offline stand-in that CI runs instead. |

### Offline, but not yet a gate — the `_test-*` probes

These ten were run once on `main` at `b97d6c6` with no `.env` present and all
exit 0. They are not in the workflow yet: the ones marked **prints only** have
no failure path — they exit 0 whatever they find, so adding them would buy a
green tick and no signal. Each needs an exit code before it becomes a step;
that is a follow-up, not this change.

Two other `_test-*` files do assert, and so are steps rather than probes:
`_test-usage-meter.mjs` (a `node --test` suite) and `_test-stamp-scans.mjs`
(`node:assert`, "PASS (14 checks)"). Both are in the "What runs" table above.
The distinction is not the prefix — it is whether the file can fail.

| Probe | Exits non-zero on failure? |
| --- | --- |
| `_test-desk-text.mjs` | yes |
| `_test-docx-redline.mjs` | yes |
| `_test-rate-limit.mjs` | yes |
| `_test-triage.mjs` | yes |
| `_test-pdf-portfolio.mjs` | yes |
| `_test-embed-shrink.mjs` | **prints only** |
| `_test-transcript-parse.mjs` | **prints only** |
| `_test-ingest-containers.mjs` | **prints only** |
| `_test-ingest-ocr.mjs` | **prints only** |
| `_test-ocr-routes.mjs` | **prints only** (stubbed hosts) |

The rest of `scripts/` is live by construction and belongs in the table above:
`_test-ingest-formats.mjs`, `_test-tiff-ocr.mjs` and `_test-kimi-editor.mjs`
read `.env` (the last calls Fireworks and Moonshot), and every `_smoke-*.mjs`
runs against prod.

Two corrections to the ship-readiness audit of 2026-09-19
(`02-securespace.md`, Definition of Done item 1): it lists `_verify-llm-gate`
and `_verify-mcp-seal` among the harnesses to run in CI. Both are LIVE — each
signs in with the service role and re-tiers a production matter — so neither
can go in a secret-free workflow. `_verify-seal-pipes` and
`_verify-bedrock-pen` are in, as that item expects. The gap the audit is really
pointing at (does the deployed seal still hold?) is DoD item 2's scheduled
prod run, which is a separate piece of work and needs secrets.

## Adding a harness

**The rule, and it has teeth: a new offline `_verify-*` harness is added to
`ci.yml` in the same PR that introduces it.** Between #155 and this change,
eight PRs landed seven offline harnesses and not one of them entered CI — for a
few days the seal's no-fallback rule, the spend cap, profile privacy and Office
tenancy were guarded by nothing but a one-off local run on the author's
machine, which is exactly the state CI was created to end. A harness that is
not a step is a harness nobody runs after the week it was written. Writing the
proof and wiring the proof are one piece of work, not two; if the harness is
LIVE by construction, the same PR adds its row to
[Deliberately not in CI](#deliberately-not-in-ci) instead, with the reason.

1. Write it as `scripts/_verify-<thing>.mjs`, exiting non-zero on failure
   (count failures, `process.exit(failures ? 1 : 0)`). The existing harnesses
   are the template; `_verify-job-priority.mjs` is the PGlite one.
2. Make it offline by construction: stub `fetch`, or run the real migration
   files in PGlite, or read source files. Anything that reads `.env` or signs
   in belongs in the LIVE table above, not in CI. If a harness has both, make
   the live half opt-in — a flag or an argument, never "on when the key
   happens to be set".
3. Run it from a checkout with **no `.env`** and confirm it exits 0. That is
   what CI has.
4. Add one step to `ci.yml` with `if: ${{ !cancelled() }}`, and a row to the
   "What runs" table here.
5. If it needs a package the repo does not depend on, install it in the job
   with `npm i --no-save <pkg>@<exact-version>` — pinned, so CI and a local run
   execute the same thing.
