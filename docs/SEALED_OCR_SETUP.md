# Sealed OCR: AWS Textract, in our own AWS account

Decided 2026-09-04 (Eden's decision 2 in the ingestion plan, Phase 4). A
scanned page in a **SecureSpace (Tier B) matter** is read by **Amazon
Textract** running in our own AWS account — the same account that holds the
sealed embedding endpoint (`docs/SEALED_EMBEDDINGS_SETUP.md`) and the Bedrock
pen. No model provider is in the loop. Documents **outside** a SecureSpace
keep Gemini, with Anthropic vision as the fallback (and, once both are
measured, the other way round — a config flip, see the end of this page).

The code is wired and **fail-closed**: until the three env vars below exist
on the worker, a sealed matter's scans behave exactly as they do today — the
typed pages are indexed and searchable, the scanned pages are recorded as
*held by the SecureSpace seal* with a reason that names what is missing, and
nothing is retried. **The cutover is provisioning + three env vars + one
requeue script. No code changes.**

## Why Textract can carry privileged material

- The bytes go to `textract.us-east-1.amazonaws.com` signed with a key that
  can do exactly one thing (`textract:DetectDocumentText`), in an account we
  hold. No third party's model sees the page.
- Textract is a service, not a chat model: there is no prompt and nothing is
  "generated"; it returns the lines it read and their positions.
- AWS's one data-use clause — content processed by its AI services *may* be
  used to improve those services unless the account opts out — is closed by
  an **AWS Organizations AI-services opt-out policy**, set once, **before the
  first job**. The route will not run until a person attests that policy is in
  force (`TEXTRACT_AI_OPT_OUT_CONFIRMED`), because no API an invoke-only key
  can call will confirm it. That is the same posture as the Bedrock pen's
  retention check: refuse until proven.

## Provisioning (Eden, one time, ~30 minutes)

1. **AWS Organizations opt-out — first.** The account must be the management
   account of an Organization (or a member of one). If it is standalone:
   AWS console → AWS Organizations → *Create an organization* (all features).
   Then: Organizations → Policies → **AI services opt-out policies** →
   *Enable* → *Create policy*:

   ```json
   {
     "services": {
       "default": {
         "opt_out_policy": { "@@assign": "optOut" }
       }
     }
   }
   ```

   Name it `ai-services-opt-out`, save, then **attach it to the Root** of
   the organization (Policies → the policy → Targets → Attach → Root). This
   opts every AWS AI service in the account out of content use for service
   improvement. Note the date; that is the value for step 4.

2. **Invoke-only credentials.** IAM → Users → *Create user*
   `contextspaces-textract` (no console access) → attach one inline policy,
   nothing broader:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": "textract:DetectDocumentText",
       "Resource": "*"
     }]
   }
   ```

   Create an access key for it (*Application running outside AWS*). This key
   can read a page of text and do nothing else. Do **not** reuse the SageMaker
   key from the embeddings setup — it cannot call Textract, and it should not
   be able to.

3. **Region.** Textract runs in `us-east-1` by default here (`AWS_REGION`
   already says so on the worker). `TEXTRACT_AWS_REGION` overrides it if you
   ever want another.

4. **Env vars, three places** (never paste keys into chat):

   | Var | Value |
   |---|---|
   | `TEXTRACT_AWS_ACCESS_KEY_ID` | from step 2 |
   | `TEXTRACT_AWS_SECRET_ACCESS_KEY` | from step 2 |
   | `TEXTRACT_AI_OPT_OUT_CONFIRMED` | the date you attached the policy, e.g. `2026-09-05` |

   - Local `.env` (replace the `PASTE` placeholders)
   - Fly, **the one that matters** — every scanned PDF is OCR'd by the worker:

     ```
     flyctl secrets set -a contextspaces-worker TEXTRACT_AWS_ACCESS_KEY_ID=… TEXTRACT_AWS_SECRET_ACCESS_KEY=… TEXTRACT_AI_OPT_OUT_CONFIRMED=2026-09-05
     ```

   - Vercel → Project → Settings → Environment Variables (a scanned **image**
     — a JPEG or PNG of a page — is OCR'd inline by `/api/ingest` and the MCP
     `file_document` path, so a sealed matter's photos need the route there too)

5. **Verify before any real sealed content.**

   ```
   node scripts/_verify-ocr-routes.mjs             # Tier B must resolve to aws-textract
   node scripts/_verify-ocr-routes.mjs --live B    # OCRs a two-page fictional fixture through Textract
   ```

   The live run prints the text it read, the request count and the cost
   (a fraction of a cent). If it fails with `AccessDeniedException`, the IAM
   policy is wrong; with `UnrecognizedClientException`, the key was mistyped.

6. **Deploy nothing.** The worker reads its env on every job. The secrets set
   in step 4 restart the machines; from then on a sealed matter's scans go to
   Textract.

7. **Re-run what the seal held.**

   ```
   node scripts/requeue-sealed-ocr.mjs             # dry run: how many, which
   node scripts/requeue-sealed-ocr.mjs --apply     # queues them (bulk priority)
   ```

   Both kinds are found: ready documents whose scanned pages were held
   (`metadata.ocr_pending.held`), and documents parked as `held` because the
   whole file needed OCR. Each gets one worker job. Follow with
   `node scripts/ingest-monitor.mjs`.

## What a person sees

- Vault row while held: **Ready — 2 pages not OCR'd — SecureSpace seal**, with
  the reason on hover naming this page. After the requeue: **Ready**.
- `check_ingest_status` on a document Textract read:
  *OCR: 12 pages read by AWS Textract (our own AWS account) at well under a
  cent — inside the seal.* The same record is on the row as
  `metadata.ocr_route` (`id`, `model`, `pages`, `estimated_usd`, `sealed`).
- Monitor: `ocr_held_sealed` stays a benign class; after provisioning it
  should count down to zero.

## Cost and limits

- **$1.50 per 1,000 pages** (DetectDocumentText). A 5,000-page sealed
  production is $7.50.
- Synchronous Textract reads **one page per request** and a page of at most
  **10 MB**; the route splits the PDF page by page (pdf-lib) and sends each
  inline, four at a time. A single page over 10 MB (rare — a 600 dpi colour
  scan) fails with the size in the reason; re-scan smaller or split it.
- Reading order is Textract's own: correct for ordinary pages, and a
  two-column exhibit may interleave the columns. That is a fidelity limit to
  know about, not something the route papers over.
- Handwriting is read (Textract does that well); it is transcribed as text,
  not summarised.

## The unsealed routes, for completeness

Tier A (matters outside a SecureSpace) uses Gemini first and **Anthropic
vision** (`claude-opus-5`, `lib/ocr-anthropic.mjs`) when Gemini fails — the
09-03 billing block on the Gemini project took every scan in the queue down
with it; now the next route reads the pages instead. Needs
`ANTHROPIC_API_KEY` on the worker (`flyctl secrets set …`). The Anthropic
route is roughly 5–15× the Gemini rate per page, so every document it reads
records the estimate (`metadata.ocr_route.estimated_usd`), and
`check_ingest_status` says it out loud.

To make Anthropic the primary once both are measured, set on the worker:

```
OCR_TIER_A_ROUTES=anthropic-vision,gemini-flash
```

and to use a cheaper Anthropic model:

```
ANTHROPIC_OCR_MODEL=claude-sonnet-5
```

No deploy for either. The sealed list takes no override — it is policy, not
preference.

## What this does NOT cover

Transcription of recordings in a sealed matter stays **held** (no sealed
transcription route yet; the researched candidate is Azure AI Speech batch).
Tier C (Silo) has no cloud OCR route and never will; a local route joins when
the Silo box exists.
