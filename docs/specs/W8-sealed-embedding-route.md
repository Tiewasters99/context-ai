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

**Corpus 2 — *Law and Public Opinion in England* (Dicey), GPU:** PENDING_CORPUS2

**CPU-only throughput (Ollama `num_gpu: 0`, corpus 1):** PENDING_CPU

### What the numbers say, and what they do not

- Both open-weight models **match or beat** the Tier A route on this material, and both are natively 1024-dimensional, so `passages.embedding vector(1024)` and the search RPC's `p_embedding_model` need no migration.
- Vector search adds a lot over text-only (R@5 from ~0.67 to ~0.95). That is the case for finishing sealed embeddings at all; sealed matters today get the first row.
- Hybrid RRF did **not** beat pure vector on these small corpora; BM25's weaker ranking drags the fusion. Do not read this as "drop the text stage": in production the text stage is what makes sealed matters searchable while vectors are absent, and on larger, name-heavy litigation corpora exact-term matching matters more than in 19th-century prose. Re-check on a fictional litigation set.
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

Recommendation: **A if the CPU number clears ~2 p/s, else C** (same account, same runbook family, no SageMaker-vs-Fly split in the security story). Either way the model weights run in infrastructure we control: architectural zero retention, rung 1 of the ladder in strategy 003 §4.1.

## 4. Build

1. `lib/embed-routes.mjs`: add route `bge-m3-selfhosted` (`provider: 'selfhosted'`, `model: 'bge-m3'`, `dim: 1024`, `zdr: true`, `requiredEnv: ['EMBED_SELFHOSTED_URL', 'EMBED_SELFHOSTED_KEY']`, `dimensionsParam: false`, `unavailable()` recognising connection refused / 503 as parked). `TIER_ROUTES.B` becomes an ordered list `['bge-m3-selfhosted', 'voyage-4-sagemaker']`; `resolveRoute` returns the first `routeReady`. Add the **runtime 1024-length assert** the 09-16 code map found missing (`lib/ingest-core.mjs` after `parse`), throwing before any DB write.
2. `scripts/reembed-matter.mjs`: add `--route <key>` (today the route is derived only from tier); the backfill must **restamp** `embedding_model` on rows stamped `voyage-4` with null vectors (sealed rows written under the HOLD).
3. `lib/mcp-core.mjs handleSearch`: no change if `routeForTier` returns the ready route; verify the `byRoute` grouping keys on `route.model`.
4. Hosting per §3; env vars in Vercel + Fly; `docs/SEALED_EMBEDDINGS_SETUP.md` gains a section.
5. Proof: `_verify-seal-pipes.mjs` extended with the new hostname (must be ours; asserts no api.openai.com / voyageai call for sealed); `_verify-embed-hold.mjs` still passes with the endpoint parked; live: `reembed-matter --dry-run` then real on the sealed fixture `0b7bf8ef-…`, `check_ingest_status` reports `semantic_search: true`.

## 5. Kickoff prompt (Opus session)

"Read `docs/specs/W8-sealed-embedding-route.md` §2–§5 and `lib/embed-routes.mjs`, `lib/ingest-core.mjs` embedBatch/embedAndInsert, `scripts/reembed-matter.mjs`. Add the `bge-m3-selfhosted` route, the ordered Tier B route list, the 1024 runtime assert, `--route` on reembed, and the restamp. Hosting per §3 (state which and why in the PR). Extend `_verify-seal-pipes.mjs`; keep `_verify-embed-hold.mjs` green. Fresh worktree; one PR; no Co-Authored-By. Do not touch Tier A."
