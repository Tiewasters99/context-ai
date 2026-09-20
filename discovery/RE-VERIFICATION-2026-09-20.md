# Discovery, re-verified against today's worker (2026-09-20)

**Verdict: WORKS, with 1 break fixed (F0) and 9 defects reported (F1–F9).**

> ⚠ **Merging does not ship the fix.** `lib/discovery/` and `worker/` run on the
> Fly worker, which only updates with `flyctl deploy` (through the local IPv4
> proxy — see `project_dev_environment_cautions`). A Vercel deploy on merge does
> not touch it. Until the worker is redeployed, a production containing a
> non-Latin filename still fails at stamping in production.

`lib/discovery/` had one commit (`4a37deb`, 2026-06-11) and `worker/e2e-live-test.mjs`
was unchanged since, while the queue underneath Discovery was rewritten for
ingestion. The 2026-09-19 audit called Discovery FRAGILE on exactly that basis:
no evidence anyone had re-verified it. This is that evidence, obtained without
touching production.

- **Offline proof:** `node scripts/_verify-discovery-pipeline.mjs` — 95 checks
  passing plus 1 standing WARN (F2), locally and in CI. The real migration files `030 + 032 + 044 +
  045 + 055 + 057 + 058 + 059 + 060` executed in order inside PGlite, the real
  `lib/discovery/*` engine driven end to end over a synthetic production,
  storage stubbed in memory, and the worker's orchestration transcribed with
  source-grep drift guards. It is a CI step. The drift guards are deliberately
  forgiving of the next builder: the dispatch check is a **superset** test, so
  adding a job type does not turn it red, and the `--intake` heartbeat gap is a
  **WARN** that flips to a PASS when someone fixes it rather than a check that
  fails on the fix.
- **Live proof, not yet taken:** `worker/e2e-live-test.mjs` has been brought up
  to today's contract and left **UNRUN**. `node worker/e2e-live-test.mjs --plan`
  prints the whole procedure and touches nothing.

Nothing in this change alters the worker's main loop, the Discovery list UI, or
any migration.

---

## 1. The contract, job type by job type

| job | enqueued by | payload | claims | writes |
|---|---|---|---|---|
| `intake_zip` | `src/pages/discovery/DiscoveryHome.tsx:361-366` via `enqueueJob` (`src/lib/discovery.ts:516-530`) | `{storage_paths[], ingest:true}` | `claim_discovery_job` → `worker/discovery-worker.mjs:175` | `production_items`, storage, `productions.status` → `processing` → `review` |
| `intake_files` | same call site, when the drop is not a single `.zip` | `{storage_paths[], ingest:true}` | `worker:176` | same |
| `intake_folder` | **the worker itself**, `worker:1002-1010`, inserted `status:'running'` | `{local_path, ingest:true}` | never claimed — it runs in-process | same |
| `stamp_production` | `src/pages/discovery/ProducePanel.tsx:155-160` | `{}` | `worker:178` | `bates_registry` (one row/page), `production_items.bates_*`, `productions` → `stamped` + `locked_at` |
| `package_production` | `src/pages/discovery/ProducePanel.tsx:293-298` | `{include_privilege_log}` | `worker:179` | storage package, `productions.package_sha256` → `packaged` |
| `ingest_document` | `api/ingest.mjs:256-260`, the worker's own OCR sweep `worker:355-359`, and migration `058:116-118` | `{document_id, force?, ocr_retry?}` | `worker:180` | `documents`, `passages` |

Every enqueue goes through the plain `processing_jobs` insert, mentions no
priority and no `serverspace_id`, and relies on 057's `BEFORE INSERT` trigger to
fill both. **Verified in PGlite: it does** (`_verify-discovery-pipeline.mjs`,
section "queue contract").

What the queue migrations changed, and whether Discovery survives it:

| migration | change | effect on Discovery |
|---|---|---|
| 044 / 045 | `heartbeat_at`, `attempts`, `max_attempts`; the claim reaps a job whose worker stopped beating | ✅ intake/stamp/package are all wrapped in `withHeartbeat` (`worker:132`), so a long job is not reaped. ⚠️ except the CLI path — **F2** below. ⚠️ a reaped stamp is re-run — **F1**. |
| 055 / 058 | bounded recovery sweep | ✅ it only ever looks at `documents` and only ever mints `ingest_document`; Discovery's four job types are invisible to it. Asserted. |
| 057 | `priority`, `serverspace_id`, burst demotion, clamp | ✅ stamped and clamped correctly. ⚠️ two fairness gaps — **F3**, **F4**. |
| 059 | `ready_but_empty()` | ✅ read-only monitor; it correctly reports a production's un-indexed display PDFs and folds duplicate copies into `has_indexed_twin`. |
| 060 | `held` | ✅ a held job is claimed by nothing and swept by nothing. ⚠️ a held *intake* leaves the production stuck — **F5**. |
| PR #153 (`force` + swap) | `ingest_document force:true` re-runs through `lib/reprocess.mjs` | ✅ no Discovery job type sets `force`; the swap path is not on Discovery's road. `markStoredWithoutText` and the ready path both **merge** prior metadata (`lib/ingest-core.mjs:1117-1122`, `:1065-1072`), so a production document keeps its `metadata.production_id` backlink through a re-run. Checked; not a defect. |

**A sealed matter behaves sanely.** `processDocument` refuses only the steps that
have no local substitute (OCR, transcription); extraction, chunking and the
tsvector still run, so a sealed production's text PDFs are stored, stamped and
word-searchable. A sealed *scan* throws `SealedPipeError`, and
`ingestDisplayPdf` catches it (`worker:592-603`) and parks that one document at
`held` — intake carries on, the item stays `ready`, and the production still
reaches `review`. Nothing leaks and nothing is stuck. The latent hole is F5.

---

## 2. Findings

### FIXED

**F0 — a foreign filename killed a whole production. (was: BROKEN AT stamp)**
`lib/discovery/bates-stamp.mjs` drew every string with `StandardFonts.Helvetica`.
The 14 standard PDF fonts are WinAnsi (CP1252) and pdf-lib **throws** rather than
substituting — from `widthOfTextAtSize` as well as `drawText`. So one file named
`Договор.xlsx`, `供給契約書.msg`, or anything with an emoji made
`stamp_production` fail on its slip sheet, **after** the earlier documents' Bates
numbers were already written to `bates_registry` — numbers a matter can never
reuse, because 030 gives that table no DELETE policy (`030:330-335`). A
non-Latin author or subject matter in a privilege-log entry did the same to
`package_production`. Email productions carry foreign-language filenames and
custodian names as a matter of course, so this is a normal input, not an edge
case. Reproduced, then fixed, in `_verify-discovery-pipeline.mjs`.

The fix grades text by what it means:
- **descriptive** text (the filename on a slip sheet, privilege-log fields, the
  matter name on a transmittal) is folded to drawable characters — accents
  outside CP1252 to their base letter, the rest to `?` — with the true value
  still in `production_items.original_filename` and the DAT's FILENAME column;
- **load-bearing** text (the Bates number, an endorsement burned on the page as a
  legal designation) must read exactly as recorded, so it refuses with a message
  naming the characters, and refuses **before** anything is drawn.

The zero-cost guarantee is complete for the **prefix** only: it is constant
across a production, so a bad one now fails on the first document with no Bates
numbers spent. An undrawable **endorsement** still fails at the first item
carrying that tag, which may be item N — the refusal is clean and immediate, but
items 1…N−1 are already in the registry. Pre-flighting endorsements before the
stamp loop is a change to `stampProduction`, i.e. the worker, and belongs with
F1.

### REPORTED, not fixed

**F1 — a crashed stamp burns Bates numbers and cannot be retried in place.**
`worker/discovery-worker.mjs:769-819`. Stamping writes registry rows as it goes
and sets `productions.status='stamped'` only at the end. Since 044, a worker that
dies mid-stamp no longer leaves the job wedged at `running`: the reaper requeues
it and a later claim re-runs `stampProduction` from the same `bates_start` — which
now collides with its own half-written rows (`worker:758-767`) and errors, three
times, until the budget is spent. Recoverable (re-open the Produce panel; it
defaults to `high-water + 1`) but it leaves a permanent gap in the matter's
numbering, and nothing tells the user why. A fix belongs in the worker's stamp
loop — either a per-production advisory lock, or write the registry rows in one
transaction, or resume from the item that has no `bates_first`. Out of this
lane's scope.

**F2 — `--intake` is not heartbeat-protected, and its payload is not portable.**
`worker/discovery-worker.mjs:1002-1015`. The CLI path inserts its job as
`status:'running'` with `claimed_at = now()` and then calls `intakeFolder`
directly — **not** through `withHeartbeat`. Only the per-file `progress()` call
refreshes `heartbeat_at`. One slow file (a 2,000-page scan going through OCR)
exceeds the 5-minute staleness window, 044's reaper requeues the job, and one of
the two always-on Fly machines then claims an `intake_folder` job whose
`payload.local_path` is a folder on the operator's laptop. It fails, and
`worker:163-165` sets the production to `error`. This is the single most
dangerous thing about the old live test, which drove intake exactly this way; the
rewritten test no longer does. Asserted as a KNOWN GAP in the harness so the
check flips the day it is fixed.

**F3 — 057's fairness promise does not cover Discovery.** A production's intake
is **one** job that runs for as long as the production takes. The burst rule
counts *rows*, so it can never demote it, and the worker runs one job at a time.
057's header says "a lawyer's single deposition video never waits behind a
stranger's production" — for a ZIP intake that is not true today.

**F4 — the opposite bite: an interactive Stamp or Package click gets demoted.**
`057:130-138`. The burst rule is per matter. Ten queued jobs in the matter — a
vault upload of a deposition batch into the same matter the production lives in —
and the next normal-priority insert is written at `-10`. That next insert is the
lawyer pressing "Stamp". Asserted in the harness.

**F5 — a held intake would strand a production silently.** `worker:244-256`.
`holdJob` parks the job and, if the payload names a document, the document. It
writes nothing to `productions`, and the `continue` at `worker:156` skips the
error branch that would set `productions.status='error'`. So a held intake leaves
the production at `processing` with no worker, no error, and nothing for the UI to
say. Latent today — the only refusal inside intake is swallowed by
`ingestDisplayPdf` — but it is the behaviour the moment any intake step refuses.
Asserted in the harness.

**F6 — no deduplication, and the index that would enable it is never queried.**
`030:122` creates `idx_production_items_sha (matterspace_id, sha256)`. Nothing
reads it. Two byte-identical files in one intake become two produced documents
with two Bates ranges and two manifest rows. Asserted.

**F7 — items that fail normalization vanish from the produced set with no
manifest.** `partitionItems` (`worker:835-870`) selects `status='ready'`, so an
errored item is silently absent from the stamp, the package and the load file.
The item row records the error, but nothing in the delivered package says a
document was left out. For a production that is a real exposure. Asserted.

**F8 — ZIP intake buffers the archive (memory ceiling, measured).**
`worker:383` → `worker:1058`. `downloadFromStorage` does
`Buffer.from(await blob.arrayBuffer())`, so the whole archive lands in memory
before `fs.writeFile` puts it on disk; only after that does `node-stream-zip`
read entries from the file. Measured on this machine (Windows, **Node v24.14.0**
— note CI and the worker image are Node 22, so treat these as indicative rather
than the deployed figure) in a clean process, sampling RSS through the exact
Blob → `arrayBuffer()` → `Buffer` → `writeFile` sequence:

| archive | peak RSS above baseline | ratio |
|---|---|---|
| 200 MB (4,096 × 50 KB entries) | 804 MB | 4.0× |
| 500 MB (10,240 entries) | 2,007 MB | 4.0× |

One of those copies is an artifact of the harness sourcing the bytes from disk
rather than from the network, so the worker's own floor is nearer **2–3×**; the
*sustained* hold is 1× (`zipBuf` stays alive for the whole loop) plus each
entry's own buffer. On the Fly machine's 4 GB that puts the practical ceiling at
roughly a **1–1.3 GB archive**, and exceeding it is an OOM SIGKILL: no catch
block, no error written, a silently burned attempt, and 044's reaper hands it
back twice more. `packageProduction` has the mirror-image problem on the way out
(`worker:979`, `fs.readFile(tmpZip)` before upload).

The fix is contained but it is a worker change (stream the storage download
straight to the temp file, and stream the package back up), so it is reported
rather than made. Until then, `--intake <folder>` is the safe path for anything
over a few hundred MB — it reads one file at a time and never holds the archive.

**F9 — Office documents and `.msg` get a slip-sheet, not a display PDF.**
`lib/discovery/normalize.mjs:67-69`. `.docx/.xlsx/.pptx/.msg` fall through to
`kind:'native'`, so the reviewer sees a Bates slip-sheet in the browser and must
download the native to read the document. What it would take, honestly:
- **Office → PDF** needs a real renderer. LibreOffice headless in
  `worker/Dockerfile` is the obvious route: `soffice --convert-to pdf`, one
  subprocess per file, roughly +600 MB of image, a new timeout and OOM surface
  per conversion, and fidelity that is good but not Word-identical. Budget it as
  a Phase-3 feature with its own harness, not a patch.
- **`.msg`** is a different problem: it is a CFBF container, not a document. It
  needs parsing (`@kenjiuno/msgreader` or similar) into headers + body +
  attachments, then the body rendered and each attachment intaken as its own
  item with its own Bates number — which is a production-structure decision
  (are attachments separate documents?), not a rendering one. The headers alone
  would already be worth having: they are what the privilege log asks for, and
  today only `.eml` pre-fills them (`normalize.mjs:56-60`).

Neither was built here. Both are correctly described in `discovery/LIMITS.md`.

**Not mine:** `listProductionItems` (`src/lib/discovery.ts:288`) is unpaged and
truncates at 1,000 rows — another builder is fixing that pagination now.

---

## 3. Running the live test

`node worker/e2e-live-test.mjs --plan` prints the procedure: what to set, what it
writes, how long it takes, what pass looks like, and what happens if it fails
midway. The two things to know before reading it:

1. **Default mode now goes through the deployed worker.** It uploads the
   fixtures to `discovery-files` exactly as the browser does, enqueues
   `intake_files`, and **polls** each job to a terminal status. The old version
   enqueued a job and then ran a local worker assuming the local one would take
   it — with two always-on Fly machines since 2026-09-04, either may claim
   first, and a local `--once` that finds an empty queue exits 0 having done
   nothing. That race is why the old test could have "passed" without proving
   anything.
2. **`--local-worker` reproduces the old behaviour** for an undeployed branch,
   and the header states its two hazards: `--once` drains every tenant's queue
   using this checkout's code, and `--intake` is F2.

It also now refuses to guess a tenant (`DISCOVERY_E2E_SERVERSPACE` is required —
it used to take `serverspaces.limit(1)`), skips rather than fails the corpus
checks when there is no `OPENAI_API_KEY`, asserts 057's and 060's columns on
every job it enqueues, continues Bates numbering from the matter's own
high-water mark, and has a `--cleanup` that walks the storage tree to full depth
(the natives live a level below the item folder) and also removes the copies
intake mirrors into `vault-documents` (`worker:579-581`), plus the corpus
documents and job rows — and deliberately does not touch `bates_registry`,
because a Bates number that has been assigned must never become reusable.

One thing a green live run does **not** prove: it drives the worker **deployed
on Fly**, and the fixtures are all ASCII, so it would have passed identically
before and after the F0 fix. The offline harness is what covers the checkout.
