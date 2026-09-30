# "Check this brief" from the GPT — the cite check as a server job (scope, 2026-09-30)

**Why.** The Contextspaces GPT works end to end on a phone (docs/specs/GPT-ACTIONS-2026-09-29.md,
PRs #320–#325, tested 2026-09-30). Eden's next question: "What if James takes the latest brief and
asks ChatGPT to analyse it, checking the cases against the Article 78 Exhibits and the Motion to
Dismiss?" Today the GPT can only read the brief piecemeal through search and reason about what it
finds; the Brief Desk's deterministic check ("Locate every cite": extract → rate → resolve against
the matter's corpus) runs in the browser, on the desk, and nowhere else. This scope makes that
machine pass a **server job** that the desk, the MCP connector and the GPT can all start and read.

**What stays human.** `cite_confirmations` (migration 103) is the lawyer's own reading — Confirm /
Problem clicks with initials — and is append-only, `user_id = auth.uid()`. No server job and no GPT
writes it. The job produces the machine pass exactly as the desk does: a `cite_check_runs` row.

## 0. What exists (verified 2026-09-30 against `origin/main` ff25ec8)

- **The desk's run** (`src/lib/brief/confirm.ts` `confirmBrief`): flush → `takeSnapshot` (frozen
  `draft_snapshots` row + `.md` published to storage + reindex) → `toPlainText(body)` via
  `lib/brief-md.mjs` → `cite_check_runs` row 'running' with `snapshot_id` → `extractCitations`
  (one model call, sectioned) → `diffForConfirm` (unchanged cites carry) → `checkOne` per new/stale
  cite (rating model call + `/api/legal-source` + `persist.ts` writes to `authorities`,
  `authority_propositions`, `authority_verifications`, `matter_authorities`) → `resolveAll` via the
  101 RPCs `resolve_citation` / `passage_for_printed_page` → `linkAuthorityToMatter` → run
  'complete' with `counts`, `report` (DeskEntry[]), `toa_markdown`, `report_markdown` →
  `recordEvent('cite.checked')`. On open, the desk re-anchors any run it has not seen
  (`BriefDesk.tsx` ~511), so **a run completed elsewhere appears on the next open with no desk
  change.**
- **Pure already** (Node-tested): `lib/brief-md.mjs`, `resolve.ts` (client passed in), `record-cite.ts`,
  `docket-cite.ts`, `depo-cite.ts`, `doc-abbrev.ts`, `index-cite.ts`, `provision-core.ts`,
  `confirmations-core.ts`, `cite-words.ts`, `anchor.ts` (needs a PM node only for the mark
  functions; `citeKey`/`diffForConfirm` are plain). `cite-check/render.ts`, `types.ts`.
- **Browser-bound today**: the two prompts and contracts (`src/lib/cite-check/extract-cites.ts`,
  `check.ts`) reach the model through `generateStructured` → `/api/llm` with the user's session;
  `persist.ts` hard-imports the browser client; `confirm.ts`, `draft-store.ts` (Blob, storage,
  `triggerIngest`), `provision-search.ts`. `assistant-match.ts` is the per-click fallback, not part
  of the run.
- **The server-run precedent** (migration 079, `api/bucketizer-run.mjs`, `lib/bucketizer-run.mjs`,
  `worker/discovery-worker.mjs`): the API checks access as the user and writes runs with the
  service role; one `processing_jobs` row per unit with a `job_type`; the worker claims with
  `claim_discovery_job`, checks scope in `assertJobScope`, dispatches by `job_type`, reports
  `progress`/`progress_note`, heartbeats; model calls go through `serverLlmCall`
  (`lib/llm-server-call.mjs`: gate → seal → meter → clamp → ledger, `userId` from the run row, no
  JWT); refusals (402/429/pause/seal) `haltRun` → paused/held; an env switch
  (`BUCKETIZER_SERVER_RUNS`) keeps an old worker from marking a new job kind as error.
- **The worker image** copies only `lib/` and `worker/` (`worker/Dockerfile`, `node:22-slim`).
  `lib/` imports nothing from `src/`; the convention is to move a core into `lib/*.mjs` and have
  `src/` re-export it (the Bucketizer did exactly this). `cite-check/lib/sources.mjs` (the free-source
  fetchers) is outside both directories.
- **Run lifecycle gaps**: `cite_check_runs.status` ∈ running | complete | interrupted | error (no
  queued/paused/held), no one-active index, cancel is an `AbortSignal`.
- **A bug found in passing**: `check.ts` posts to `/api/legal-source` with no bearer;
  `api/legal-source.mjs` answers 401 `missing_bearer`; `refusals.ts` files it under 'other' and the
  check reports `{found:false}`. Free-database lookups from the desk appear to fail silently today.
  Fix in its own small PR first (send `llmAuthHeader()`), then measure how many "blue" rows turn.
- **MCP** has no brief or cite-check tool. `file_document` with `doc_type:'brief'` and a `.md`
  filename creates a desk body (the way a drafting session files a first cut).

## 1. The shape

One run, three doors, one report.

```
desk "Locate every cite"  ─┐
MCP  check_brief           ├─►  POST /api/brief-check  ─►  cite_check_runs (queued)  ─►  processing_jobs
GPT  checkBrief            ─┘        (as the user)          + draft_snapshots row        job_type brief_cite_check
                                                                                              │
                          worker: lib/brief-check-run.mjs  ◄───────────────────────────────────┘
                          extract → diff → rate → resolve → link → run 'complete'
                          → report filed as a document (optional, decision C3) → events 'cite.checked'
                                                                                              │
desk (next open re-anchors)  ◄──  cite_check_runs  ──►  MCP brief_check_status / brief_check_report  ──►  GPT
```

- **Input** is the brief's live body (`draft_bodies.body`), the same JSON the desk checks; the job
  snapshots it first so the run is bound to a `sha256`. A brief that has no desk body (a docx in
  the Vault never opened in the desk) is refused with "open it in the Brief Desk once" in V1;
  importing server-side is `import-docx.ts` (environment-neutral) and can be added later.
- **Output** is the same `cite_check_runs` row the desk writes, so the desk, the cite log export,
  carry-forward and the Cite Verification Record all keep working unchanged.

## 2. The pieces

### C1 — Move the core to `lib/` (no behaviour change)

- `lib/cite-check-core.mjs`: the extraction and rating prompts + contracts from
  `extract-cites.ts` / `check.ts`, taking an `llm(callSpec)` function and a `sources` fetcher as
  arguments; `persist.ts` becomes `lib/cite-check-persist.mjs` with the client passed in;
  `cite-check/lib/sources.mjs` moves to `lib/legal-sources.mjs` (the API and the CLI import it from
  there). `src/lib/cite-check/*` re-export, as `md.ts` and `resolve.ts` already do. Do not fork
  the prompts; the CLI's older `anthropic.mjs` copy is retired.
- `lib/brief-check-run.mjs`: `runBriefCheck({ db, run, body, llm, sources, log, signal })` — the
  orchestration of `confirmBrief` minus snapshot/publish and minus the browser, callable from the
  browser too (with `generateStructured` and the browser client injected) so the desk and the
  worker run **one** function. The stale set is computed from the saved JSON (`Node.fromJSON` with
  the brief schema, or a plain walk for the `stale` attr).
- Harness: the existing desk harnesses keep passing; a new `_verify-cite-check-core.mjs` drives
  extraction + rating with a fake `llm` on the DeCamara fixture and asserts the DeskEntry shape is
  byte-identical to the browser path's.

### C2 — The job (migration 104, worker, API)

- **104_brief_check_jobs.sql**: `cite_check_runs.status` gains `queued`, `paused`, `held`,
  `cancelled`; columns `requested_via text` ('desk'|'mcp'|'gpt'), `job_id uuid`, `progress int`,
  `progress_note text`, `pause_reason text`, `model_id text`, `record_matter_id uuid`; partial
  unique index: one active run (queued|running|paused) per `document_id`. Members keep SELECT;
  INSERT/UPDATE by the service role only for the new statuses (the browser path still inserts its
  own 'running' rows as today).
- **`POST /api/brief-check`** (`api/brief-check.mjs`, maxDuration 15): actions `start`
  `{document_id, all?, model_id?}`, `status {run_id}`, `cancel {run_id}`. `start`: verify the
  caller can read the document as the user; refuse a sealed matter's brief unless the tier's sealed
  pen exists (the same answer `serverLlmCall` would give, but before a row is written); take the
  snapshot with the service role (`draft_snapshots` insert with `created_by` = the user; the storage
  publish of the `.md` is **skipped** in V1 — the desk's next snapshot publishes); insert the run
  (`queued`, `requested_via`, `created_by` = the user, `snapshot_id`, `record_matter_id` from
  `documents.metadata.record_matter_id`); insert one `processing_jobs` row
  `job_type='brief_cite_check'`, payload `{run_id}`, priority 0. Off switch `BRIEF_SERVER_RUNS=1`
  (503 `not_enabled` otherwise), as the Bucketizer.
- **Worker** (`worker/discovery-worker.mjs`): `assertJobScope` branch (run's matter = job's matter);
  `dispatch` → `runBriefCheckJob` in `lib/brief-check-job.mjs`: load run + body, `runBriefCheck` with
  `llm = serverLlmCall({userId: run.created_by, matterId, feature: 'citecheck.check', model:
  run.model_id})`, `sources = legalSources()`, progress every cite (`progress_note` "12 of 41:
  Matter of Trump v. Engoron"), heartbeat; on a refusal `haltRun` → paused (402/429) or held
  (pause/seal), job deleted, `last_error`; cancel = run 'cancelled' checked between cites. Ledger
  rows as `actor_kind='system'` with the requester as `actor_ref`, exactly as Bucketizer runs.
- Harness `_verify-brief-check-job.mjs` (PGlite, 100/101/103/104 + 079's job tables): start refuses
  a non-member and a bodiless brief; one active run per document; the worker path with a fake llm
  produces a 'complete' run with counts and a report; a 429 from the llm parks the run paused with
  nothing lost; cancel between cites; the desk's `loadLatestRun` reads the row.

### C3 — Three doors

- **MCP tools** (`lib/mcp-core.mjs`, through `callTool` so the Record sees them): `check_brief
  {document, all?}` → `{run_id, status:'queued', cites_carried?, note}`; `brief_check_status
  {run_id}` → `{status, progress, progress_note, counts, sha256, started_at, completed_at,
  last_error}`; `brief_check_report {run_id, part: 'summary'|'red'|'blue'|'all', offset}` → rows
  `{citation, flag, proposition, pin, source_label, authority: {document_id, title, page} | null,
  note}` paged 50, each row's `authority` openable with `get_passage`. `check_brief` is a costed
  tool for the meter (`connector-meter` class).
- **GPT operations** (`lib/gpt-ops.mjs` OPS): `checkBrief` (consequential: it spends the account's
  AI usage), `briefCheckStatus`, `briefCheckReport` (reads). Actions time out at 45 s, so
  `checkBrief` returns at once and the instructions tell the GPT: say it will take a few minutes,
  check status when the user asks or on their next message, then read the report and summarise the
  reds first, citing each authority by document and page.
- **Desk**: "Locate every cite" keeps the browser path in V1 (it is faster to first feedback and
  shows marks live); a "Run on the server" entry in the same menu starts the job, and the toolbar
  shows "Server run: 12 of 41" while one is active. A server run's marks appear on the next open,
  as today.
- **Report as a document (decision C3)**: on completion the worker files `report_markdown` as
  `Cite check — <brief title> — <date>.md` into the brief's matter (`file_document` path, doc_type
  'other', `metadata.cite_check_run_id`), so a person can read it in the Vault and the GPT can
  search it like anything else. One document per run; never overwrites.

### C4 — `getDocumentText` (independent, one hour, ships first)

`get_document_text {document, offset, limit}` tool + `getDocumentText` GPT operation: the
document's passages in order (page-ordered, `summary_level = 0`), ≤ 12,000 characters per call
with `next_offset`, so the GPT can read a brief top to bottom instead of through search hits. The
Brief Desk spec already lists this as the gap in "Send to your assistant" (§3.6). Same caps and
seal as everything else.

## 3. Decisions Eden owes (each one line)

- **D1 Who may start a check.** Any member who can read the brief (James can), or only members who
  can edit the matter? Recommendation: any reader; the run spends usage (D2) and writes nothing a
  reader could not already see.
- **D2 Whose usage is charged.** `serverLlmCall` meters `run.created_by`, so a check James starts
  is charged to James's account. Alternative: charge the matter's serverspace owner. Recommendation:
  the requester in V1 (it is what every other tool does); revisit when client accounts are a thing.
- **D3 File the report into the matter** as a document on completion? Recommendation: yes.
- **D4 Model for the rating pass.** The desk uses the user's chosen model; the job takes
  `model_id` from the request or the account default. Recommendation: account default, Tier B
  matters through the sealed pen as `serverLlmCall` already decides.
- **D5 The `/api/legal-source` bug**: fix first as its own PR, before C1, and re-run one brief to see
  how many "not found" rows were the bug.

## 4. Estimate and order

| Step | Work | Est. |
|---|---|---|
| 0 | `/api/legal-source` bearer fix (D5) | 0.5 h |
| C4 | `get_document_text` + `getDocumentText` + harness + instructions line | 1 h |
| C1 | core → `lib/` (prompts, persist, sources), `runBriefCheck`, harness | 4 h |
| C2 | migration 104, `/api/brief-check`, worker job, harness | 6 h |
| C3 | MCP tools, GPT ops + OpenAPI, desk "Run on the server", report filing, instructions | 4 h |
| — | Eden: paste 104, set `BRIEF_SERVER_RUNS=1`, **redeploy the worker** (Fly), one brief end to end on the phone | 1 h |

About two working days of build. **The worker redeploy is the operational gate**: the Fly deploy
token in `.env` is still a placeholder and flyctl needs the IPv4 proxy from this PC
(project_dev_environment_cautions); nothing in C1–C3 reaches production until the worker ships.

## 5. Risks and limits (stated, not solved)

- **Cost per run** is the desk's cost today (one extraction call + one rating call per new cite);
  a 40-cite brief is ~41 model calls. The meter and the 402/429 pause apply as for the Bucketizer.
- **Runs are not instant.** Minutes, not seconds; the GPT must not pretend otherwise (instructions).
- **The GPT's summary is a reading of the report**, and the report is the machine pass; the
  lawyer's confirmations remain the only attestation. The instructions say so in one sentence.
- **Bodiless briefs** (a docx never opened in the desk) are refused in V1.
- **December 11.** ChatGPT is retiring GPTs into "plugins"; the operations here are plain REST over
  the same OAuth and survive whatever container OpenAI puts them in. If the plugin form changes the
  auth or schema contract, it is the facade that adapts, not this job.

## 6. Not in scope

Human confirmations from the GPT (the Cite Verification Record's `propose_attestation` idea is the
right door for that, later); assistant-match batching; importing a docx server-side; corpus-first
rating (`check.ts` reusing `resolve_citation` before the free sources, the 09-16 memo's idea);
anything in the desk's UI beyond the one menu entry and the progress line.
