# Shared Worker Runbook

One always-on process that runs every heavy job Contextspaces has: Discovery
productions (ZIP intake → normalize → Bates-stamp → package) **and** document
ingestion (`ingest_document`) for files too big for the 60-second serverless
budget — large scans needing OCR, hour-long recordings, `.wma` needing ffmpeg.

**How work arrives:** `/api/ingest` measures each upload; small files process
inline exactly as before (no worker dependency), heavy ones become a row in
`processing_jobs`. The worker claims rows atomically (`claim_discovery_job`,
`FOR UPDATE SKIP LOCKED` — safe to run several workers) and runs the same
`lib/ingest-core.mjs` pipeline with no timeout. The Vault UI just polls
document status and can't tell the difference.

## Run it locally (works today, zero setup)

Requires: Node 20+, ffmpeg on PATH, and `.env` at the repo root with
`VITE_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`.

```powershell
cd C:\Users\equai\context-ai-backend
npm run worker          # poll loop, Ctrl-C to stop
npm run worker:once     # drain the queue, then exit
```

Leave a terminal running `npm run worker` and every queued document processes
within ~5 seconds of upload. This is the interim host until Fly is set up.

## Host it on Fly.io (~$3–6/mo, one-time setup ~10 min)

Fly is chosen because everything after account creation is CLI — no dashboard
round-trips. **The one browser step:** create the account + add a card at
https://fly.io/app/sign-up. Everything else from a terminal:

```powershell
# 1. Install the CLI (once)
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"

# 2. Log in (opens browser once)
fly auth login

# 3. From the repo root (fly.toml already written):
cd C:\Users\equai\context-ai-backend
fly launch --no-deploy --copy-config --name contextspaces-worker

# 4. Secrets — copy values from .env
fly secrets set VITE_SUPABASE_URL="..." SUPABASE_SERVICE_ROLE_KEY="..." OPENAI_API_KEY="..." GOOGLE_API_KEY="..."

# 5. Ship it
fly deploy

# Watch it work / check health later:
fly logs
```

## Migration 044 — deploy the worker BEFORE running the SQL

Order matters here, and the intuitive order is the wrong one.

044 gives `claim_discovery_job` a reaper: any job whose worker has not
heartbeated for 5 minutes is reclaimed, and after `max_attempts` it is failed
for good. That is only safe once a worker is actually heartbeating.

**Deploy the worker first, then run the migration.** A worker running ahead of
the migration is harmless — `heartbeat_job` and `recover_stranded_documents`
do not exist yet so the calls log a failure and continue, and the `heartbeat_at`
column in the progress update makes that one statement fail silently. Nothing
throws; the only visible loss is the progress note until the SQL lands.

The reverse order opens a real window. Between the migration landing and the
new worker booting, the reaper is live and nothing is beating, so every job
already running longer than 5 minutes gets reclaimed mid-flight — and a long
OCR or transcription pass can burn all three attempts and be marked
permanently failed before the deploy finishes.

## Migration 057 — job priority (2026-08-23)

`processing_jobs.priority` (default 0) decides who goes next; the claim is
`order by priority desc, created_at`. The bulk scripts — `bulk-import` and
`ingest-monitor --fix` — enqueue at -10. The web and MCP paths never mention
priority: a BEFORE INSERT trigger demotes a matter's eleventh-and-later queued
job to -10 on its own, so one client's production cannot hold another
client's single upload. Only the service role can raise priority above 0;
authenticated callers are clamped.

Apply order relative to the worker deploy does not matter — the worker's
`claim_discovery_job(p_worker)` call and every interactive enqueue are
unchanged. The two CLI scripts DO name the column and fail loudly
(`column "priority" does not exist`) if run before the SQL is pasted.

Verify on a real Postgres without Docker:

    npm i --no-save @electric-sql/pglite
    node scripts/_verify-job-priority.mjs

Known limits, on purpose: strict priority means bulk never runs while normal
work is queued; two tenants bulk-uploading at once are FIFO between themselves
(fair sharing is the next rule, and `serverspace_id` is already on the job for
it); the burst rule is per matter.

## Also in the pending-dashboard batch

Run `supabase/migrations/032_processing_jobs_rls.sql` in the Supabase SQL
editor (Dashboard → SQL Editor → paste → Run). It closes a pre-existing gap:
the queue table had no row-level security, so any signed-in user could read
every matter's queue. The migration scopes select/insert to matter access and
reserves update/delete for the worker's service role. **The queue works before
this migration runs** — it's a security hardening, not a dependency.

## Phase 4 (2026-09-04) — two machines, OCR routes, long recordings, resumable uploads

**Two machines, always on.** `fly scale count 2 -a contextspaces-worker`
(Eden's decision 3, ~$10–15/mo). The claim is `FOR UPDATE SKIP LOCKED`, so
two workers never take one job, and the idle sweeps are jittered per process.
Confirm both are claiming after a busy hour:

    select claimed_by, count(*) from processing_jobs
     where claimed_at > now() - interval '1 hour' group by 1;

**OCR by tier** (`lib/ocr-routes.mjs`; the worker passes the provider to the
pipeline, which asks only "does this tier have a route?"):

| Tier | Routes, in order | Secrets on the worker |
|---|---|---|
| A (unsealed) | Gemini → Anthropic vision (fallback) | `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY` |
| B (SecureSpace) | AWS Textract in our own account, nothing else | `TEXTRACT_AWS_ACCESS_KEY_ID`, `TEXTRACT_AWS_SECRET_ACCESS_KEY`, `TEXTRACT_AI_OPT_OUT_CONFIRMED` — see `docs/SEALED_OCR_SETUP.md` |
| C (Silo) | none | — |

    fly secrets set -a contextspaces-worker ANTHROPIC_API_KEY="..."        # the Tier A fallback
    fly secrets set -a contextspaces-worker OCR_TIER_A_ROUTES="anthropic-vision,gemini-flash"   # flip the order, no deploy

Every OCR'd document records `metadata.ocr_route` (route, model, pages, a
dollar estimate, and which route failed first); `check_ingest_status` reads it
back as a sentence. Anthropic is roughly 5–15× the Gemini rate per page.
`node scripts/_verify-ocr-routes.mjs` shows what each tier resolves to from an
environment; `--live A` (or `B`) OCRs a two-page fixture through it.

**Long recordings.** Audio over twenty minutes is cut into parts by ffmpeg
(`lib/media-segments.mjs`), each part transcribed on its own, timestamps
shifted back, parts joined with a seam line (speaker labels restart per
part). Video is not segmented. `node scripts/_smoke-av-segments.mjs` proves it
end to end with a synthesized 21-minute file.

**Resumable uploads.** The browser sends files of 50 MB and up in 6 MB TUS
chunks (`lib/tus-upload.mjs`); a dropped connection continues from the last
byte the server has and a closed tab resumes on the next try. Nothing changes
for the worker — the bytes land in the same bucket path. `node
scripts/_smoke-resumable-upload.mjs test-box` drives it against the real
bucket with an interruption.

## Troubleshooting

- **Docs stuck in "pending" > 1 min** → no worker is running. Start one
  (`npm run worker`) or check `fly logs`. Queue state:
  `select job_type, status, progress_note, error from processing_jobs order by created_at desc limit 10;`
- **`ffmpeg exit`/spawn errors** → ffmpeg missing on the host. Local: install
  ffmpeg; Fly: the Dockerfile installs it — rebuild.
- **Job stuck in `running` after a crash** → re-queue it:
  `update processing_jobs set status='queued', claimed_by=null where id='...';`
- **Retry a failed document** → the Vault's Retry button re-fires
  `/api/ingest`, which re-queues heavy files (dedupe prevents doubles).
