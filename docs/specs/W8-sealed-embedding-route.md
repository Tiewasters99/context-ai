# W8b — Open-weight embedding route on our own infrastructure

**Date:** 2026-09-16 · **Status:** EVALUATED (this laptop) → SPEC for an Opus build session · **Why:** the sealed embeddings endpoint `voyage-4-embed` (Voyage on SageMaker, ml.g6.2xlarge) has been blocked on GPU capacity since late August; sealed matters are text-search-only and carry `embedding_pending`. The blocker was instance capacity, not SageMaker. A ~570M-parameter open-weight embedding model needs no g6 instance.

## 1. Evaluation (2026-09-16)

Harness: `scripts/_eval-embed-routes.mjs`. Corpus chunked with the repo's own `extractPages` + `chunkPages`; 57–60 lawyer-style questions generated once by Claude Opus 4.8 with a paraphrase instruction and cached; each question's source passage is the target. BM25 in JS stands in for the tsvector stage; RRF(BM25, vector) stands in for the two-stage hybrid. Public-domain legal texts only. Machine: laptop RTX 5070 Ti 12 GB, Ollama 0.34.

**Corpus 1 — *Common Sense in Law* (Vinogradoff), 255 passages, 57 questions, GPU**

| route | R@1 | R@5 | R@10 | MRR | passages/s |
|---|---|---|---|---|---|
| text-only (BM25 ≈ tsvector stage) | 0.439 | 0.667 | 0.807 | 0.551 | — |
| text-embedding-3-small @1024 (Tier A today) | 0.544 | 0.895 | 0.930 | 0.700 | 200.9 (API) |
| hybrid RRF(BM25, openai) | 0.614 | 0.842 | 0.860 | 0.707 | |
| **bge-m3** (Ollama, 1024) | **0.789** | **0.947** | **0.982** | **0.866** | 17.7 |
| hybrid RRF(BM25, bge-m3) | 0.684 | 0.860 | 0.860 | 0.748 | |
| qwen3-embedding:0.6b (Ollama, 1024, query instruction) | 0.702 | 0.947 | 0.965 | 0.823 | 14.6 |
| hybrid RRF(BM25, qwen3) | 0.632 | 0.860 | 0.860 | 0.721 | |

**Corpus 2 — *Law and Public Opinion in England* (Dicey), 595 passages, 60 questions, GPU** (qwen3 omitted: the three-model run was killed for system memory; bge-m3 is the candidate)

| route | R@1 | R@5 | R@10 | MRR | passages/s |
|---|---|---|---|---|---|
| text-only (BM25 ≈ tsvector stage) | 0.483 | 0.750 | 0.817 | 0.617 | — |
| text-embedding-3-small @1024 (Tier A today) | 0.483 | 0.717 | 0.817 | 0.576 | 34.0 (API) |
| hybrid RRF(BM25, openai) | 0.500 | 0.817 | 0.933 | 0.641 | |
| **bge-m3** (Ollama, 1024) | **0.667** | **0.917** | **0.950** | **0.779** | 24.5 |
| hybrid RRF(BM25, bge-m3) | 0.633 | 0.917 | 0.950 | 0.753 | |

**CPU-only throughput (Ollama `num_gpu: 0`, corpus 1):**

| route | R@1 | R@5 | R@10 | MRR | passages/s |
|---|---|---|---|---|---|
| bge-m3 [CPU] | 0.789 | 0.947 | 0.982 | 0.866 | **1.8** |
| qwen3-embedding:0.6b [CPU] | 0.684 | 0.947 | 0.965 | 0.812 | 0.8 |

Quality is identical on CPU (same weights). Throughput was measured while the corpus-2 GPU run was also using the machine, so 1.8 p/s is a floor for this laptop CPU, not a ceiling; a Fly `shared-cpu-4x` is weaker than a laptop CPU. At 1.8 p/s a 400-page deposition (~600–800 passages) takes 6–8 minutes on the background queue, which is tolerable; a 20,000-passage production takes ~3 hours, which is not.

### What the numbers say, and what they do not

- **bge-m3 beat the Tier A route on both corpora** (R@5 0.947 vs 0.895; 0.917 vs 0.717), and both open models are natively 1024-dimensional, so `passages.embedding vector(1024)` and the search RPC's `p_embedding_model` need no migration.
- On corpus 2 the Tier A route, truncated to 1024 dimensions as the schema requires, did **no better than text-only** (R@5 0.717 vs 0.750). That is a finding about the current Tier A configuration worth its own follow-up: `text-embedding-3-small` is natively 1536-dimensional and the 1024 truncation may be costing more than assumed. Not in scope here.
- Vector search with bge-m3 adds a lot over text-only (R@5 0.667→0.947 and 0.750→0.917). That is the case for finishing sealed embeddings at all; sealed matters today get the text-only row.
- Hybrid RRF helped the weaker vector route (openai on corpus 2: 0.717→0.817) and did not help bge-m3. Do not read this as "drop the text stage": in production the text stage is what keeps sealed matters searchable while vectors are absent, and on name-heavy litigation corpora exact-term matching matters more than in 19th-century prose. Re-check on a fictional litigation set.
- Limits: two old public-domain books, ≤800 passages each, synthetic questions, one machine. No deposition transcripts, no scanned productions, no Bates-numbered exhibits. Retrieval quality on those is unmeasured and must be measured on a fictional set (the Calder v. Atlas Freight fixtures) before any switch of the Tier A route. **For Tier B the comparison is against nothing** (no vectors today), so the bar is "better than text-only", which is cleared by a wide margin.

## 2. Decision

- **Tier B primary route = `bge-m3` on infrastructure in our account.** Voyage on SageMaker stays configured as an alternative; whichever is `routeReady` first serves. Rows are stamped with the route's model name, so two sealed matters may legitimately hold different spaces; one matter never mixes (existing rule).
- **Tier A unchanged** (`text-embedding-3-small`) until a fictional-litigation eval is run; re-embedding the Tier A corpus is a cost with no privilege upside.
- **Tier C reserved** for the same route hosted by the firm (private instance) or a local endpoint (W9).

## 3. Hosting (pick by the CPU number)

| Option | Plumbing already present | Cost shape | Notes |
|---|---|---|---|
| **A. Fly machine running Ollama or TEI (text-embeddings-inference) on CPU**, private network, no public port | `openAiCompatible({ dimensionsParam: false })` in `lib/embed-routes.mjs:90-117` | Cheapest; shared-cpu-4x / 8 GB; always-on ~$20–40/mo | Only if CPU throughput ≥ ~2 passages/s; ingest is a background queue, search embeds one query. |
| **B. Fly GPU machine (a10 / l40s) on demand** | same | ~$1–2/hr while up; the 09-06 HOLD makes up-when-needed real | Capacity has been easier to get than SageMaker g6 in ewr; verify at build time. |
| **C. SageMaker CPU/small-GPU endpoint (ml.c6i / ml.g5.xlarge) with the Hugging Face TEI container serving `BAAI/bge-m3`** | SigV4 route `voyage-4-sagemaker` pattern (`buildRequest`/`parse`/`unavailable`) | Same VPC story as Voyage; different instance family, so a different quota | Keeps everything inside the account already documented in `docs/SEALED_EMBEDDINGS_SETUP.md`. |

Recommendation: **C** (SageMaker `ml.g5.xlarge` or similar small GPU with the TEI container serving `BAAI/bge-m3`; same account, same runbook family, no SageMaker-vs-Fly split in the security story, and the g5 family has its own quota separate from the g6 that has been unobtainable). The CPU number (1.8 p/s on a laptop CPU under load) does not clear the ~2 p/s bar on Fly's shared CPUs; keep **A** only as a documented fallback for a private instance with no GPU budget, where ingest volume is one firm's. Either way the model weights run in infrastructure we control: architectural zero retention, rung 1 of the ladder in strategy 003 §4.1.

## 4. Build

1. `lib/embed-routes.mjs`: add route `bge-m3-selfhosted` (`provider: 'selfhosted'`, `model: 'bge-m3'`, `dim: 1024`, `zdr: true`, `requiredEnv: ['EMBED_SELFHOSTED_URL', 'EMBED_SELFHOSTED_KEY']`, `dimensionsParam: false`, `unavailable()` recognising connection refused / 503 as parked). `TIER_ROUTES.B` becomes an ordered list `['bge-m3-selfhosted', 'voyage-4-sagemaker']`; `resolveRoute` returns the first `routeReady`. Add the **runtime 1024-length assert** the 09-16 code map found missing (`lib/ingest-core.mjs` after `parse`), throwing before any DB write.
2. `scripts/reembed-matter.mjs`: add `--route <key>` (today the route is derived only from tier); the backfill must **restamp** `embedding_model` on rows stamped `voyage-4` with null vectors (sealed rows written under the HOLD).
3. `lib/mcp-core.mjs handleSearch`: no change if `routeForTier` returns the ready route; verify the `byRoute` grouping keys on `route.model`.
4. Hosting per §3; env vars in Vercel + Fly; `docs/SEALED_EMBEDDINGS_SETUP.md` gains a section.
5. Proof: `_verify-seal-pipes.mjs` extended with the new hostname (must be ours; asserts no api.openai.com / voyageai call for sealed); `_verify-embed-hold.mjs` still passes with the endpoint parked; live: `reembed-matter --dry-run` then real on the sealed fixture `0b7bf8ef-…`, `check_ingest_status` reports `semantic_search: true`.

## 5. Kickoff prompt (Opus session)

"Read `docs/specs/W8-sealed-embedding-route.md` §2–§5 and `lib/embed-routes.mjs`, `lib/ingest-core.mjs` embedBatch/embedAndInsert, `scripts/reembed-matter.mjs`. Add the `bge-m3-selfhosted` route, the ordered Tier B route list, the 1024 runtime assert, `--route` on reembed, and the restamp. Hosting per §3 (state which and why in the PR). Extend `_verify-seal-pipes.mjs`; keep `_verify-embed-hold.mjs` green. Fresh worktree; one PR; no Co-Authored-By. Do not touch Tier A."
