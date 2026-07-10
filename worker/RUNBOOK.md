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

## Also in the pending-dashboard batch

Run `supabase/migrations/032_processing_jobs_rls.sql` in the Supabase SQL
editor (Dashboard → SQL Editor → paste → Run). It closes a pre-existing gap:
the queue table had no row-level security, so any signed-in user could read
every matter's queue. The migration scopes select/insert to matter access and
reserves update/delete for the worker's service role. **The queue works before
this migration runs** — it's a security hardening, not a dependency.

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
