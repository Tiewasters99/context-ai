# Does the sealed pen's preamble help?

`scripts/eval-sealed-pen.mjs` answers that with a number instead of an opinion.
Nobody has run it yet — this document is how, what it costs, and how to read
what comes back.

## Why there is anything to measure

Inside a sealed matter (SecureSpace Tier B) every model call is served by the
sealed pen — today Kimi K2.5 in our own AWS account. What that pen receives as
its system prompt is whatever the *feature* wrote: `CLASSIFY_SYSTEM` and
`TREE_SYSTEM` (`lib/bucketizer-core.mjs`), `EVIDENCE_SYSTEM`
(`src/lib/bucketizer/evidence-prompt.ts`), cite-check's two prompts, the
Assistant's Orchestrator (`lib/orchestrator-system.mjs`). Every one of those was
written for, and tuned on, frontier Claude.

`lib/pen-preambles.mjs` puts a few sentences in front of them — where the pen
is, what it may draw on, what to do when the material does not answer, that a
quotation is copied and carries its page, that a specified format is returned
exactly, and that a lawyer reviews everything. That is a judgement about a
prompt, and a judgement about a prompt is worth what can be measured about it.

## What it does

For each sampled document it runs Bucketizer classification twice through the
**real** sealed route (`lib/llm-sealed-route.mjs`) — once with the preamble and
once without — and compares the two arms.

| Measure | What it is worth |
| --- | --- |
| **Agreement with the existing labels** | The demo matter's ~3,900 classifications were produced by Claude. Agreement is *not* correctness; Claude is not ground truth. But a large move in either direction means the preamble changed behaviour. |
| **Planted hot documents found (recall)** | Real ground truth. `patel-world` was *built*: each demo document carries `metadata.hot` — 3 or 2 means the trial team must find it, 0 means it is noise that must stay unfiled. This is the number that matters. |
| **Planted noise left unfiled** | The other half of the same truth. A prompt that files everything scores perfect recall and is useless. |
| **JSON-contract failures** | Answers that could not be used even after one repair. The preamble's "return exactly that and nothing around it" sentence is aimed squarely at this; if it does not move, that sentence is decoration. |
| **Repair rate** | How often the one repair retry (PR #168) had to fire. |
| **Input/output tokens, cost** | The preamble is ~250 tokens of input on every sealed call in the product. This is what that costs. |

## The matter

The default — and the only matter on the built-in allow-list — is
`patel-world`, the fictional mass-tort demo record described in
`C:\Users\equai\patel-world\DEMO-SCRIPT.md`. Everything in it was written for a
demo. The ground-truth keys (`metadata.hot`, `metadata.planted_buckets`) are the
same ones `patel-world/scripts/eval-bucketizer.mjs` scores against.

Any other matter is **refused**. A client matter's documents are not an
evaluation corpus — running this against one would send every sampled document
to the pen twice to measure a prompt. `--matter-ok-i-am-eden` overrides that for
one run; it exists so the refusal is a decision rather than a wall, and it
should almost never be typed.

## Running it

```bash
# 1. The estimate. Contacts no model. This is the normal first command.
node scripts/eval-sealed-pen.mjs --n 50 --seed 1

# 2. The real run, once you have read the estimate.
node scripts/eval-sealed-pen.mjs --n 50 --seed 1 --yes-spend

# 3. The pipeline, with a stubbed pen and no database. What CI runs.
node scripts/eval-sealed-pen.mjs --dry
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--matter <short_code>` | `patel-world` | Must be on `FICTIONAL_MATTERS` or need `--matter-ok-i-am-eden`. |
| `--n <N>` | `50` | Documents sampled. Both arms run on each. |
| `--seed <int>` | `1` | The sample is deterministic in the seed: the same seed always redraws the same documents, and `--n 50` begins with the same documents `--n 20` used. |
| `--yes-spend` | off | Required before any model is contacted. |
| `--matter-ok-i-am-eden` | off | Overrides the allow-list for one run. |
| `--dry` | off | Stubbed pen, built-in fixture corpus, zero network. |
| `--out <path>` | `reports/sealed-pen-eval-<matter>-n<N>-s<seed>.md` | Where the report is written. |

A live run needs `SUPABASE_URL` (or `VITE_SUPABASE_URL`) and
`SUPABASE_SERVICE_ROLE_KEY` for the corpus, and `BEDROCK_AWS_ACCESS_KEY_ID` /
`BEDROCK_AWS_SECRET_ACCESS_KEY` (plus `BEDROCK_REGION`, `BEDROCK_MODEL`) for the
pen. It **reads** the database and never writes to it: no classification is
created, changed or deleted.

## What it costs

Priced from `lib/usage-prices.mjs`, at the rate of the pen that actually answers
(`moonshotai.kimi-k2.5` → **$0.60 / $2.50** per million input/output tokens,
mirrored there from `PENS.bedrockOpen.pricePerM`).

One classify call is one document's excerpts up to
`CLASSIFY_INPUT_CHAR_BUDGET` (60,000 characters) plus the outline, and asks for
a 4,000-token answer:

| Sample | Per call | **N = 50, both arms** |
| --- | --- | --- |
| A full 60k-character document | ~$0.03 | **~$3.50** |
| A typical 20k-character document | ~$0.02 | **~$2.50** |

So **budget about $3.50 for `--n 50`**, including the 10% the estimator adds for
repair retries. The script prints its own estimate from the bodies it has
actually built before it asks for `--yes-spend`, so trust that line over this
table.

Two caveats the script repeats on every run:

- **That rate is an estimate.** Bedrock has not published a list price for this
  pen; `PENS.bedrockOpen.pricePerM` says so, and this table inherits the
  caveat. Correct both when the first invoice arrives.
- The estimator deliberately errs **high** (every input byte at the input rate,
  the full output allowance at the output rate), exactly as the spend cap's
  estimator does. The report prints the actual token cost afterwards.

## Reading the report

The report is markdown, and contains **no document text** — not a passage, not a
rationale, not a title. Every figure in it is a count, a rate or a token total.
That is asserted by `scripts/_verify-sealed-preamble.mjs`, which plants a canary
string in the dry corpus and fails if it reaches stdout or the file.

- **A difference of one or two documents in a 50-document sample is noise.**
  Re-run with a different `--seed` before believing a small move.
- **Recall and "noise left unfiled" move together or not at all.** A prompt that
  raises recall by filing more documents has not improved anything; look at both
  rows before concluding.
- **Contract failures are the cleanest signal.** They are a property of the
  answer's shape, not of anybody's judgement about a document, so they need no
  interpretation.
- **Agreement with the existing labels is agreement with Claude.** Use it to see
  whether the preamble did anything at all; use the planted-truth rows to see
  whether what it did was good.

## What it does not measure

- **It is not the sealed pen against Claude.** Both arms are the sealed pen.
- **It is not the product's classify path.** `src/lib/bucketizer/classify-run.ts`
  *windows* a large outline across several calls; this makes one call per
  document against the whole outline, exactly as `scripts/bucketize.mjs` does. A
  matter whose outline is large enough to window will not reproduce the
  product's numbers, and the report says so.
- **It measures classification only.** Tree generation, evidence and cite-check
  carry the same preamble and are not scored here; classification is the one
  act with ~3,900 existing labels and a planted truth to score against.

## A dry run's numbers mean nothing

`--dry` answers every call from a fixture that fails the contract on a fixed
cadence. It proves the pipeline runs end to end — translation, preamble, SigV4
signing, SSE parsing, the contract check, the one repair, scoring, the report —
and nothing else. The report it writes says so in a banner. Only a
`--yes-spend` run measures the preamble.
