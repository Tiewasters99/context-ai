# Ingestion monitoring — off the laptop

Ingestion health used to depend on one Windows PC. The nightly suite and the
six-hourly monitor were Scheduled Tasks on Eden's laptop; both were being killed
(`LastTaskResult 0xC000013A`), the suite has never recorded a green night, and
with the lid shut nothing watched production at all. Meanwhile `/api/health`
checked environment variables and an OAuth round-trip and knew nothing about
whether anything was *processing*: if the Fly worker stopped, an uploaded
document sat in `pending` forever, the Vault showed a spinner with no words, and
no alert fired anywhere.

Four pieces fix that, and they are deliberately independent — each works on its
own, and the one that does the alerting needs no credential at all.

| Piece | What it knows | What it needs |
| --- | --- | --- |
| `supabase/migrations/066_worker_heartbeats.sql` | one row per worker process | a paste in the SQL editor |
| `lib/worker-heartbeat.mjs` + three lines in `worker/discovery-worker.mjs` | writes that row every ~60 s and on every completion | **a Fly worker deploy** |
| `/api/health` → `checks.ingestion` | aggregate liveness, queue depth, oldest stuck document | nothing (auto-deploys with main) |
| `.github/workflows/ingest-nightly.yml` | watch / monitor / nightly suite | see [Secrets](#the-secrets-to-add) |

## The order of operations

Nothing below is destructive and nothing has to happen the same day, but the
order matters: the heartbeat table must exist before the worker writes to it.

1. **Merge PR #169** (this change is stacked on it).
2. **Paste migration 066.** Supabase dashboard → SQL Editor → paste the whole of
   `supabase/migrations/066_worker_heartbeats.sql` → Run. It is idempotent: if
   in doubt, paste it again.
3. **Reload the API schema** so PostgREST publishes the two new functions —
   in the same SQL editor window:
   ```sql
   notify pgrst, 'reload schema';
   ```
4. **Merge this PR.** Vercel deploys `/api/health` automatically. Open
   <https://www.contextspaces.ai/api/health> — `checks.ingestion.available`
   should now be `true`, with `worker_alive: false` and a reason saying no
   worker has ever reported in. That is correct: the worker has not been
   redeployed yet.
5. **Deploy the Fly worker.** *This step is required* — the heartbeat lives in
   the worker's own code, and until the machines run the new image nothing
   writes a beat.
   ```
   flyctl deploy -a contextspaces-worker --remote-only
   ```
   (From this PC, `flyctl` needs the local IPv4 proxy — see the dev-environment
   memo.) Within a minute, `/api/health` should show `worker_alive: true` and
   `seconds_since_beat` under 60.
6. **Add the repository secrets and variable** — the table below, in one visit.
7. **Run the workflow once by hand.** GitHub → **Actions** → *Ingestion —
   nightly suite, monitor, liveness watch* → **Run workflow** → set *Which job
   to run by hand* to `all` → Run.
8. **Turn on GitHub's failure email for yourself** (this is the alert channel):
   <https://github.com/settings/notifications> → **Actions** → tick **Email**
   and choose **Only notify for failed workflows**. Also make sure the repo is
   *Watched* (repo page → Watch → All Activity or Custom → Actions). GitHub
   sends nothing for a workflow you are not watching.
9. **Retire the two Windows tasks** — only after three green nights (below).

## The secrets to add

GitHub → the repo → **Settings** → **Secrets and variables** → **Actions**.
Two tabs on the one page: *Secrets* and *Variables*.

### Secrets tab

| Name | What it is | Where the value comes from |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | **Required** for the monitor and the suite. The full-privilege database key. | `SUPABASE_SERVICE_ROLE_KEY` in `C:\Users\equai\context-ai\.env` |
| `SUPABASE_URL` | The project URL (`https://<ref>.supabase.co`). Not actually sensitive — it ships inside the browser bundle — but it lives here so the list is in one place. | `VITE_SUPABASE_URL` in the same `.env` |
| `OPENAI_API_KEY` | Suite only: embeddings, so a document can be proved searchable. | `.env` |
| `GOOGLE_API_KEY` | Suite only: Gemini OCR and A/V transcription. | `.env` |
| `GMAIL_ADDRESS` | Optional. The mailbox the digest and the suite report are sent to. Without it they are printed to the run log only. | `.env` |
| `GMAIL_APP_PASSWORD` | Optional, and required if `GMAIL_ADDRESS` is set. A Google **app password**, not the account password. | `.env` |
| `INGEST_MONITOR_FILENAME_OWNERS` | Optional. Your own auth user id, so the digest may print **your** filenames. Empty = no filenames at all, including yours (PR #169). | Supabase → Authentication → your user's id |
| `INGEST_ALERT_TO` | Optional. An extra recipient for **urgent** digests only — a carrier email-to-SMS gateway address works well, e.g. `5551234567@vtext.com`. Routine digests never go here. | you |
| `SUITE_CREATED_BY` | Optional. The auth user id the suite files its fixtures as. Without it the suite borrows the most recent `created_by` it finds in the scratch matter. | Supabase → Authentication |

### Variables tab

| Name | What it is |
| --- | --- |
| `SUITE_MATTER` | **Required to run the suite.** The `short_code` (or uuid) of the scratch matter the suite files its ~25 fixtures into and then cleans up. Give it a matterspace of its own — ideally in its own serverspace — so a bug in a gate can never touch a client matter. |
| `HEALTH_URL` | Optional. Overrides `https://www.contextspaces.ai/api/health` for the liveness watch (a preview deployment, say). |

**Every one of these may be absent.** With no secrets set, the `monitor` and
`suite` jobs print a `::notice::` saying what to add and finish **green**; only
the `watch` job does any work. That is deliberate: a workflow that mails a red
result every night for a reason nobody intends to fix is a workflow that gets
muted, and a muted workflow protects nothing.

## The security trade-off, stated plainly

`SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security completely. In GitHub
Actions it becomes a **fourth copy** of that key (the others: this laptop's
`.env`, Vercel, Fly). Anyone who can push a workflow file to this repository can
read it, and a compromise of the GitHub account is therefore a compromise of the
whole database. Today that account is Eden's alone and carries 2FA, which is the
only thing standing between the two.

**Could a lower-privilege credential do the job?** For the alert, yes — and that
is exactly what the `watch` job is. Migration 066's `ingest_worker_status()` is
granted to `anon` and returns seven numbers with no identifier of any kind, so
the whole liveness check runs against the public `/api/health` with **no secret
at all**. That is the least-privilege path and it is the one that fires the
alert.

For the other two, no. The monitor reads `documents` and `processing_jobs`
across every tenant and calls `ready_but_empty()`, which migration 059 grants to
`service_role` only, on purpose. The suite is worse: it uploads ~25 fixtures,
writes documents and passages, queues jobs at BULK priority, exercises the
deployed worker and then deletes everything again. A key that could do that
under RLS would be a service-role key wearing a different name.

**The alternative, and why it is not the recommendation.** A Vercel cron hitting
a token-protected endpoint that runs the read-only checks server-side would keep
the key where it already is. It is a real option for the **monitor**, and worth
building if the number of copies of that key ever becomes a compliance question
(it will, in a SOC 2 or ZDR conversation). It cannot host the **suite**: a
Vercel function's budget is 60–300 s against a suite that takes 3–7 minutes, and
Hobby-tier crons run once a day with no `workflow_dispatch` equivalent to
re-run one by hand.

**Recommendation.** Do steps 1–5 and 8 now: they cost nothing, expose nothing,
and on their own satisfy "worker down 10 min → the UI says so and an alert
fires". Add `SUPABASE_SERVICE_ROLE_KEY` when you want the nightly suite, which
is the only way to reach "green three nights from non-laptop infrastructure",
and rotate that key the moment GitHub access is ever in doubt.

## Schedules, and what they honestly promise

All times UTC. GitHub runs scheduled workflows **on the default branch only**,
so nothing here fires until this merges to `main`, and the hosted scheduler is
routinely 5–30 minutes late.

| Job | Cron | Roughly |
| --- | --- | --- |
| `suite` | `0 7 * * *` | 03:00 New York in summer, 02:00 in winter |
| `monitor` | `20 */6 * * *` | every six hours |
| `watch` | `40 * * * *` | hourly |

So the **email** alert catches a worker outage within about an hour, not ten
minutes — an hourly cron on a best-effort scheduler cannot promise better. The
ten-minute promise is kept where it can be: the person watching the spinner is
told within ~60 seconds, by `ingest_status_for_me()`. If you want a ten-minute
*email* too, point any free uptime monitor at
`https://www.contextspaces.ai/api/health` and alert on the keyword
`"degraded": true`. The endpoint is unauthenticated and numbers-only precisely
so that this is possible without handing a third party a credential.

Runner minutes, for a private repo on the Free plan (2,000/month, billed by the
started minute): hourly watch ≈ 24/day, six-hourly monitor ≈ 8/day, nightly
suite ≈ 10/day — about 1,300/month, which leaves room for CI. Making the watch
half-hourly costs about 1,950 and is at the edge. The cadence is the cron line
and nothing else depends on it.

## What "green" looks like

- **`watch`** — green every hour. Its log ends `Ingestion healthy — processing normally`.
- **`/api/health`** — `"degraded": false`, and under `checks.ingestion`:
  `worker_alive: true`, `seconds_since_beat` under 120,
  `oldest_processing_seconds` under 1,800.
- **`monitor`** — green. ⚠ It will stay **red** until the zero-byte `CORR-037`
  row in the Patel demo matter is deleted; that row has kept the monitor's G9
  gate red since 2026-09-15 and is a one-line delete, not a bug in this change.
- **`suite`** — green, three nights running. Each run attaches an artifact
  `ingest-suite-<run id>` holding `logs/ingest-suite.jsonl` and
  `logs/ingest-suite-checkpoint.json`; the last line of the jsonl should read
  `"pass": true`, and the emailed report says `PASS (green 3 nights)`.

Three green nights is the moment to retire the Windows tasks. In an elevated
PowerShell:

```powershell
Unregister-ScheduledTask -TaskName 'Contextspaces Ingestion Suite'   -Confirm:$false
Unregister-ScheduledTask -TaskName 'Contextspaces Ingestion Monitor' -Confirm:$false
```

(`Disable-ScheduledTask` instead of `Unregister-` if you would rather keep them
switched off than remove them.) Nothing else on the laptop depends on either
task; the suite and the monitor still run by hand from a checkout exactly as
they do today.

## Reading the numbers

`/api/health` → `checks.ingestion`:

| Field | Meaning |
| --- | --- |
| `available` | `false` means "we cannot tell" — usually migration 066 is not pasted. Never an alert. |
| `worker_alive` | a worker beat within `alive_window_minutes` (10) |
| `seconds_since_beat` | `null` = no worker has **ever** beaten. Unknown is not the same as dead, and a brand-new deployment reads as unknown. |
| `queue_depth` | `processing_jobs` queued + running, across the install |
| `documents_processing` | documents in `pending`/`extracting`/`chunking`/`embedding` |
| `oldest_processing_seconds` | age of the oldest of those, by `updated_at` |
| `degraded` (top level) | worker down, or a document processing for over 30 minutes. A long queue alone is reported but is not "degraded" — it is a queue. |

There is deliberately nothing here that identifies a document, a matter or a
person; that is what makes the endpoint safe to leave unauthenticated. Anything
per-document goes to the monitor's digest instead, which runs under the service
role and goes to one mailbox.
