# Sealed embeddings: voyage-4 on SageMaker, in our own AWS account

Decided 2026-08-25. Tier-B matters embed through a **voyage-4 model package
(sold by MongoDB on AWS Marketplace) deployed as a SageMaker endpoint inside
our own AWS account**. The zero-retention claim is architectural: the text
goes to `runtime.sagemaker.<region>.amazonaws.com` — our account, our region —
and no third party is in a position to retain it. This is deliberately NOT the
direct Voyage API (`api.voyageai.com`), whose default terms take a perpetual
training licence and whose hosting region is undocumented.

The code is fully wired and fail-closed: until the endpoint and credentials
below exist, Tier B behaves exactly as it does today (text-only search,
scans/recordings held). **The cutover is provisioning + four env vars. No code
changes.**

## Provisioning (Eden, one time, ~an hour)

1. **AWS account.** Create one (or use an existing one dedicated to
   Contextspaces). Enable MFA on the root user, then work from an IAM
   identity, never root.

2. **Subscribe to the model.** AWS Marketplace → search "Voyage" → the
   **voyage-4** model package **sold by MongoDB, Inc.** (their listings are
   the maintained ones; the older Voyage-AI-branded listings are being
   retired). Accept the offer. Software fee is hourly while an endpoint runs.

3. **Deploy the endpoint.** SageMaker → Inference → Endpoints → create from
   the marketplace model package:
   - Region: **us-east-1** (or set `AWS_REGION` to whatever you choose).
   - Instance: **ml.g6.2xlarge** (the listing's recommended real-time size).
   - Endpoint name: `voyage-4-embed` (or set `SAGEMAKER_VOYAGE_ENDPOINT`).
   - Everything else default. No public network access is needed beyond the
     SageMaker runtime API itself.

4. **Invoke-only credentials.** IAM → create a user `contextspaces-embed`
   with a single inline policy — nothing broader:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": "sagemaker:InvokeEndpoint",
       "Resource": "arn:aws:sagemaker:us-east-1:<ACCOUNT_ID>:endpoint/voyage-4-embed"
     }]
   }
   ```

   Create an access key for it. This key can do exactly one thing: ask that
   one endpoint for embeddings.

5. **Env vars, three places** (`.env` already carries the PASTE placeholders):

   | Var | Value |
   |---|---|
   | `AWS_ACCESS_KEY_ID` | from step 4 |
   | `AWS_SECRET_ACCESS_KEY` | from step 4 |
   | `AWS_REGION` | `us-east-1` |
   | `SAGEMAKER_VOYAGE_ENDPOINT` | `voyage-4-embed` |

   - Local `.env` (replace the placeholders — never paste keys into chat)
   - Vercel → Project → Settings → Environment Variables (search + inline
     ingest run there)
   - Fly: `flyctl secrets set -a contextspaces-worker AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_REGION=us-east-1 SAGEMAKER_VOYAGE_ENDPOINT=voyage-4-embed`
     (the worker embeds during background ingest)

6. **Verify before any real sealed content.**

   ```
   node scripts/_verify-voyage-route.mjs
   ```

   Sections 1–2 are the offline proof (SigV4 known-answer test, request
   shape) and always run. Section 3 goes live once the env vars are real:
   fictional text only, two calls, asserts 1024-dimension vectors and that
   document- vs query-encoding actually differ. It also prints the endpoint's
   real response shape — `parse()` in `lib/embed-routes.mjs` accepts two
   candidate shapes until then; simplify it to the one that is real.

7. **Backfill any already-sealed matters** (fills the null embeddings Phase A
   left, into the voyage-4 space):

   ```
   node scripts/reembed-matter.mjs --matter <short_code> --dry-run   # count first
   node scripts/reembed-matter.mjs --matter <short_code>
   ```

## Cost, and the switch you control

The endpoint bills **by the hour while it exists** (marketplace software fee
+ instance; order of $3–4/hr all-in, so ~$2,500/mo if left up 24/7). Two ways
to run it:

- **Always on** — sealed semantic search and sealed ingest just work, and the
  bill is what it is.
- **Up only while working sealed matters** — delete/recreate the endpoint (the
  model package makes this a few clicks, config is not lost). While it is
  down, the code degrades exactly the way the seal already behaves: sealed
  ingest of TEXT still succeeds (indexed for text search, embeddings backfill
  later via `reembed-matter`), and sealed SEARCH answers on full text with a
  note saying the embedding step was unavailable. Nothing errors, nothing
  falls back to another provider, nothing is lost.

Start with the endpoint up only when needed; move to always-on when sealed
work is daily.

## What this does NOT cover

OCR and transcription for sealed matters remain held (Phase A behaviour).
The researched recommendation for those is AWS Textract (+ an Organizations
AI-services opt-out set BEFORE the first job) and Azure AI Speech batch —
both separate provisioning decisions. The same AWS account created here is
the natural home for Textract when that decision is made.
