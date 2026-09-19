# 003 — Critique of the Gemini "Local Inference" Blueprint

**Date:** 2026-09-16
**Author:** Claude (Fable 5.1), at Eden Quainton's request, for Eden's review
**Subject:** *Architectural and Strategic Blueprint for an AI-Native Legal Workspace for Solo and Small Firms* (Gemini Deep Research, Downloads, 2026-09-16)
**Status:** DRAFT for Eden's review. Strategic critique; recommends no architectural pivot and four adjustments, none adopted until Eden decides.

**Disclosure.** This is a Claude model critiquing a memo whose central prescription is to stop using Claude and its peers. Every load-bearing claim below is therefore something Eden can check without trusting the author: the memo's own citations, the Contextspaces code and tier policy, the hardware arithmetic, and the three market facts verified today (Part 7).

---

## 1. Verdict

The memo's diagnosis is largely right and its prescription is largely wrong. It correctly identifies the buyer's fear ("how do you know what it will do?"), correctly reads *United States v. Heppner* as a warning about provider terms, correctly says governance belongs in deterministic code rather than in a system prompt, and correctly sees an audit trail as the sales object. Contextspaces already embodies every one of those points, some built, some in the W1–W7 workstreams.

The memo then collapses a ladder into its top rung. Zero third-party retention is the goal; local inference is one of at least three ways to reach it, and for the solo and small-firm buyer it is the most expensive, the lowest quality, and the hardest to operate. The memo never considers a hybrid, never prices its own appliance business, never runs the memory arithmetic for a deposition-length document, and cites Harvey's Tenet as support when Tenet is a 2.8-trillion-parameter model post-trained on roughly 150 B300 GPUs. That is the opposite of a consumer graphics card in a solo lawyer's office.

Contextspaces has the right shape: per-matter seal, three tiers (A frontier, B sealed with contractual zero retention in our own AWS account, C silo), fail-closed pipes, a ledger in progress. Tier C is where the memo's idea lives, and it should stay a tier. The pivot question is answered in Part 6: no architectural pivot; re-sequence Tier C; adopt four specific things.

---

## 2. The memo's prescriptions mapped to Contextspaces

| Memo prescription | Contextspaces status (code-verified 09-10 roadmap; re-read today) |
|---|---|
| Deterministic control plane outside the model's context | Exists: server-side tier policy (`lib/ai-tier-policy.mjs`), fail-closed seal pipes, hostname allowlists, MCP seal, network-level verify harness. Kill switch = W3, planned. |
| Zero Data Retention as a structural fact | Tier B: Claude Opus 5 via Bedrock under account-level `data_retention_mode: none`, in our AWS account (built, live-verified 08-27). Tier C: local only, refused until hardware exists. |
| Data never leaves the firm | Tier C (Silo) is that tier. Per-firm private instance (own Supabase, own keys) is the recorded flagship deployment. Not built. |
| Citation check against a primary-law database with string matching | Cite-check engine exists (`cite_check_runs` is first-class, `/api/legal-source` gated for sealed matters). Court-database lookup is deterministic; whether the case supports the proposition is not. |
| Mandatory click-to-verify citations before export | Not built. Maps cleanly onto W6 document-state gates. **Adopt** (Part 5). |
| Defensible AI supervision log for carriers and bars | W1 append-only hash-chained ledger + W5 the matter's Record. Ranked CRITICAL already. The memo's framing is better sales language than ours. **Adopt the framing.** |
| Constrained JSON decoding | Provider adapters handle structured output; irrelevant to hallucination (Part 4.5). |
| Open-weight models to cut cost | Kimi already a pen — K2.5 inside the seal on Bedrock, K3 on Fireworks as a **Tier A** Editor choice (the Fireworks Tier-B fallback was removed 2026-09-19). BYOK tier exists, so token cost is the user's at the low end. |
| Local inference for everyone | Not planned as the architecture. Planned as Tier C and as the 08-13 Ollama adapter (step 1) and Silo Matter (step 2). |
| Hardware-as-a-service appliance at $249/mo | Not planned. Recommend never as our own lease book (Part 6). |

---

## 3. What the memo gets right, and whose thesis it is

The memo's strongest paragraphs are Eden's own 08-13 thesis, over-extended. Eden's position then: a real migration to local models is coming as people learn to use AI and models improve; lawyers in particular will want perfect siloing for their most sensitive matters; the goal is to stay one step ahead. That thesis is scoped to *the most sensitive matters* and to *a tier*. The memo takes the same instinct and applies it to *all matters* and to *the architecture*. The divergence is scope and timing, not direction.

Three further things the memo has right and Contextspaces should say more loudly:

- **Heppner's second ground is the product's reason to exist.** Provider terms that permit logging, training and disclosure defeat a reasonable expectation of confidentiality. The sealed pen answers that structurally, and `src/lib/securechat.ts` already encodes exactly this reading.
- **The insurer and the bar are the buyers of the audit trail.** The "Silent AI" coverage gap (sanctions excluded; misrepresentation on renewal applications) is a genuine pressure point, and the artifact that answers it is a record of who reviewed what, when. That is W5's export.
- **Governance in code, not in prompts.** Contextspaces' rule since July has been deterministic first, models at judgment points. The memo's "stateless worker inside a state machine" is a stricter version of the same rule.

---

## 4. Where the memo goes wrong

### 4.1 It confuses the goal with one means of reaching it

The goal is that no third party can retain, train on, or disclose matter content. The seal-pipes work already ranks the ways of getting there:

1. Architectural: weights run in infrastructure we control (Tier C; also Voyage on SageMaker in our VPC).
2. Contractual and enforceable: Bedrock under `data_retention_mode: none`, pinnable by AWS policy so the account structurally cannot invoke a retention-requiring model (Tier B pen).
3. Vendor promise: sales-gated zero-retention arrangements with the model vendor.
4. Default terms: 30-day retention, sometimes training (consumer products; first-party APIs by default).

Heppner was decided against rung 4. The memo argues as if only rung 1 exists. Nothing in Heppner, Rule 1.6(c), ABA Formal Opinions 477R or 512, or the state guidance the memo cites imposes a physical air-gap. The standard is reasonable efforts to prevent unauthorized disclosure. Eden should confirm that reading, but the memo asserts a physical standard no rule imposes and cites none that does.

### 4.2 It inverts the market

On-premises inference is an enterprise buying motion. The buyer needs an IT function, capital budget, and someone to own the box when it fails. The memo's target, the solo and small firm, has none of those, and the memo concedes as much when it invents a "Managed Appliance Lease" to abstract the complexity away. That lease is a hardware business: procurement, shipping, warranty, remote support, replacement units, end-of-life. It is a different company with different margins and a balance sheet. The AmLaw 100 firm that can afford on-prem is the one Harvey already sells to.

The memo also does not run its own logic to the end. "Data never traverses a public network or resides on external servers" indicts Supabase, Vercel, Fly, OneDrive, Clio and the firm's email host, not only the model API. Followed consistently it eliminates any SaaS workspace, including the memo's own. The only coherent version of the memo is a per-firm private instance, which is already Contextspaces' recorded flagship. Read that way, the memo is an argument for sequencing we already have.

### 4.3 The hardware arithmetic omits the part that matters for legal work

The memo prices a 70B model at 4-bit as roughly 40 GB of weights fitting on two RTX 4090s (48 GB total). It then invokes vLLM's PagedAttention as if it removes the need for KV-cache memory. It does not; it removes fragmentation. The cache itself scales with context length, and legal documents are long.

Assumptions Eden can check: Llama 3.3 70B and Qwen 2.5 72B both use 80 layers, 8 key-value heads, head dimension 128, stored in 16-bit.

| Quantity | Value |
|---|---|
| KV cache per token (2 × 80 × 8 × 128 × 2 bytes) | ≈ 320 KiB |
| KV cache at 32k tokens | ≈ 10 GiB |
| KV cache at 128k tokens | ≈ 40 GiB |
| Weights at 4-bit (memo's figure) | ≈ 40 GB |
| Two RTX 4090s | 48 GB |
| Headroom for context after weights | ≈ 8 GB, roughly 20k tokens, roughly 60 pages of transcript at the conversion below |
| One 400-page deposition at ~250 words/page (≈ 325 tokens/page) | ≈ 130k tokens |

A deposition does not fit. Eight-bit KV quantization halves the cache and still does not fit at 128k. A Mac Studio with 128 GB of unified memory fits in memory, but the memo does not measure time-to-first-token for a 130k-token prompt on Apple Silicon, and its "sub-two-second" figure is lifted from a blog post about a short-passage RAG demo, not a long-document legal workload.

Two further points on quality. The candidate models the memo names (Llama 3.1 and 3.3 70B, Qwen 2.5 72B, DeepSeek-R1 distills) are 2024 to early-2025 releases; the memo does not assess what actually fits on one consumer GPU in September 2026, and I am not substituting my own picks from memory. And the memo's claim that these models "rival proprietary frontier models" for legal reasoning is asserted from hardware blogs, not measured. The whole reason a lawyer would pay for the product is that its reasoning over their record is trustworthy. The memo trades that for a guarantee the lawyer can get another way.

### 4.4 It misreads its own evidence on Harvey

The memo says Harvey "pivoted to Kimi K3 to reduce operational costs" and that a lower-cost workspace "must adopt a similar open-weights strategy." Per the reports checked today, Harvey's Tenet is post-trained on the open-weight Kimi K3 base, a 2.8-trillion-parameter model, over two months on roughly 150 Nvidia B300 GPUs. None of the reports describes it running on customer hardware. Open weights, yes; local inference, no. Harvey moved to owning its model, not to putting it in the customer's office. Contextspaces already runs Kimi K3 as a pen. The direction the memo points to with Harvey is the direction we are already in.

The Guardrails AI acquisition points the same way. Guardrails built an open-source guardrails framework and a simulation environment for testing agent behavior, a control plane rather than a model. It is evidence for the memo's determinism section, not for its inference section.

### 4.5 The determinism section is right in instinct and overclaims in detail

Two specific overclaims:

- **Constrained decoding buys syntax, not truth.** Forcing valid JSON drops parse failures to zero. It does nothing about a fabricated citation that is perfectly well-formed. The memo presents this as "absolute structural predictability" as if it were a correctness guarantee.
- **String-matching a citation proves existence, not support.** Checking a cite against CourtListener tells you the case exists and the reporter cite is well-formed. Whether the case stands for the proposition it is cited for requires reading it, which is a judgment. The memo's blanket rejection of any model-as-judge would break the half of cite-checking that matters most, and it sits badly with SB 574 itself, which (per the Sullivan & Cromwell summary of the bill; the bill text was not retrievable today) would bar filing any paper containing a citation not "personally verified" by a responsible attorney. Verification of a citation by a person presupposes judgment, not lookup.

The correct line is the one Contextspaces already holds: deterministic code owns control flow, state, refusal and the record; the model is invoked at judgment points and its output is recorded and reviewable. That is a hybrid, and the memo's architecture, read carefully, is also a hybrid. It just declines to say so.

### 4.6 Local inference does not reach Heppner's first ground

Judge Rakoff's ruling rested on two grounds: the defendant's AI use was self-directed, with no lawyer in the conversation and no counsel direction; and the provider's terms permitted logging, training and disclosure. Local inference addresses the second ground only. A client running a model on their own laptop and then handing the output to counsel would still fail the first ground. The answer to the first ground is a workflow in which AI use inside a matter is directed by counsel and recorded as such. That is W7, the Heppner client workspace, and it is a software and role-model problem, not a hardware problem.

Two cautions for anything client-facing, per the sourcing rule in the drafting skill: Contextspaces should never say it "preserves" or "solves" privilege. Privilege attaches through counsel direction and confidentiality, not through software. What the product can truthfully say is that no third party received the content and that the record of counsel direction exists.

### 4.7 The pricing argument dissolves at the low end

The memo's cost case is that frontier API tokens make cloud inference unaffordable for a solo practitioner, citing Harvey's reported cost per seat. Harvey's per-seat compute cost is the cost of multi-day agentic workloads at enterprise scale, and the memo's figure for it is unsourced beyond a vendor comparison page. A solo lawyer's actual monthly token spend on drafting, search and cite-checking is a fraction of a $299 seat. Contextspaces' BYOK tier makes that spend the user's own and visible, which is a more honest answer to the cost fear than a leased GPU with a fixed monthly fee.

---

## 5. What to adopt from the memo (recommendations, pending Eden)

1. **The "Defensible AI" sales frame.** The memo's pitch — when your carrier or the bar asks, the platform produces the supervision log — is the correct external language for W1 (ledger) and W5 (the Record). The in-product language stays discreet per the 09-10 aesthetics rule; the sales language can be this blunt. No re-ranking needed; W1 and W5 are already CRITICAL. This is confirmation, not a change.

2. **A "citations verified" state as a W6 export gate.** SB 574 (if signed) would require "reasonable steps" to "verify the accuracy" of AI output including "all case and statutory citations" (proposed Bus. & Prof. Code § 6068.1(a)(3)(B)), and would bar any filed paper from containing a citation not "personally verified" by a responsible attorney (proposed Code Civ. Proc. § 128.7(b)(2)). Quoted fragments are from the Sullivan & Cromwell memo of 2026-09-11; the memo's phrase "personally read and verified" does not appear there and should not be reused until checked against the enrolled text. Add to the W6 document-state spec: a document with unverified citations cannot reach `client_ready` or a filing export; each citation carries who verified it and when; the verification events land in the ledger. Small, high-value, and it turns a statute into a feature the same way the seal turned a privilege risk into one.

3. **Evaluate an open-weight embedding model on our own infrastructure.** The sealed-embeddings endpoint (`voyage-4-embed` on SageMaker) has been blocked on GPU capacity since late August, and sealed matters are text-search-only until it lands. Embedding models are small enough to run on CPU or a modest GPU on infrastructure we already control, which is architectural zero retention without the capacity lottery. Caveats: retrieval quality must be measured against the current model on real matters before switching; embedding spaces do not mix, so it is a per-matter re-embed, which the schema already supports. This is an evaluation, not a decision.

4. **Re-sequence Tier C.** Keep the tier; change the order in which it becomes real:
   - **Private instance first.** Whole stack is already env-var configuration. The firm's own Supabase, own subdomain, own model keys or own AWS account with retention pinned to none. This is the coherent version of the memo, and it serves the buyer who can actually pay for isolation.
   - **BYOH adapter second.** The 08-13 step 1: an Ollama or vLLM adapter in the provider registry, desktop-only, so a firm with its own box can point a sealed matter at it. The user owns the hardware and its failures.
   - **Appliance only through a hardware partner, never our lease book.** If a buyer wants the box delivered, it ships from a vendor whose business is boxes, pre-imaged with the private instance. Contextspaces sells software and configuration.

---

## 6. Is a pivot necessary?

No architectural pivot. The memo describes, at its best, the shape Contextspaces already has: a per-matter seal that governs every exit, a tier whose processing path is contractually zero-retention inside our own account, a tier whose processing path is local, deterministic gates that refuse rather than degrade, and a record of who did what. Where the memo differs, it differs by insisting that the top rung of the ladder be the only rung, and it reaches that conclusion by omitting the KV-cache arithmetic, misreading Harvey, ignoring the buyer's IT capacity, and treating a bill on the Governor's desk as enacted law.

Two honest concessions, because they are where the memo's suspicion is right today:

- Tier B's allowlist still carries first-party `anthropic` (30-day retention) as a recorded escalation fallback for servers where the Bedrock pen is unprovisioned. The 09-10 roadmap already lists dropping it once the Bedrock pen is live-verified. Do that.
  > **Done 2026-09-19.** Dropped, along with Fireworks. Tier B is `{aws-bedrock}`; an unprovisioned server refuses a sealed matter rather than serving it from outside the seal. The concession above is no longer owed.
- Per the 08-25 research recorded in the seal-pipes memory, Anthropic's strongest models (Fable and Mythos 5) did not permit retention mode `none` on Bedrock; only Opus and Sonnet did. Re-verify before any client conversation, but as recorded, the strongest frontier model is unavailable inside the seal. That is a real limit of the contractual rung and worth stating plainly rather than hiding.

The positioning line that answers the memo in one sentence is already in the Offering Memorandum's verification thesis: the answer to model risk is model neutrality plus a verifiable corpus that any model can be made to check and a human reviews, not the exclusion of the most capable models from the room.

---

## 7. Facts checked today (2026-09-16)

| Memo claim | Finding | Source |
|---|---|---|
| Harvey raised $550M at $15.5B and acquired Guardrails AI "late 2026" | Confirmed; announced 2026-09-09. Fourth acquisition of 2026. | [Artificial Lawyer](https://www.artificiallawyer.com/2026/09/09/harvey-raises-550m-at-15-5bn-val-buys-guardrails-ai/), [Harvey blog](https://www.harvey.ai/blog/guardrails-ai-joins-harvey), [Unite.AI](https://www.unite.ai/harvey-acquires-guardrails-ai-its-fourth-acquisition-of-2026/) |
| California SB 574 "passed unanimously in August 2026" and "codifies" duties | Cleared the Legislature 2026-08-31 (Assembly 75-0). On Governor Newsom's desk. **Not yet law.** The memo treats it as enacted. | [Sullivan & Cromwell](https://www.sullcrom.com/insights/memo/2026/September/California-Legislature-Passes-Rules-Generative-AI-Use-Legal-Practitioners), [Farella](https://www.fbm.com/publications/californias-sb-574-new-ai-rules-for-lawyers-and-arbitrators/), [Digital Democracy](https://calmatters.digitaldemocracy.org/bills/ca_202520260sb574) |
| Harvey "pivoted to Kimi K3" to cut frontier API costs, supporting a local open-weights strategy | Harvey Tenet is post-trained on the open-weight Kimi K3 base (2.8T parameters) over ~2 months on ~150 Nvidia B300 GPUs; served by Harvey. Open weights, not local inference. | [TNW](https://thenextweb.com/news/harvey-tenet-legal-model-kimi-k3-chinese-base), [SCMP](https://www.scmp.com/tech/tech-trends/article/3364827/openai-backed-legal-tech-firm-pivots-chinese-kimi-k3-open-weight-model), [Dataconomy](https://dataconomy.com/2026/08/21/openai-backed-harvey-launches-new-legal-model-based-on/) |
| Attorneys must have "personally read and verified" every citation | Not the bill's words as far as could be checked. S&C's summary quotes "reasonable steps" to "verify the accuracy" (§ 6068.1) and "personally verified" (CCP § 128.7). Bill text (LegiScan) returned 403 today; confirm against the enrolled text before quoting. | [Sullivan & Cromwell](https://www.sullcrom.com/insights/memo/2026/September/California-Legislature-Passes-Rules-Generative-AI-Use-Legal-Practitioners) |
| *U.S. v. Heppner*, 25 Cr. 503 (Rakoff, J.), two grounds | Consistent with the reading already encoded in `src/lib/securechat.ts`. Not independently re-read today; the memo cites the memorandum opinion via Akin Gump. | Memo's citation 16 |
| Harvey compute cost ">$1,200 per seat" | Unverified. Sourced in the memo to an Irys comparison page. Do not reuse. | — |
| Competitor pricing table (Irys $299, Legora $99–249, Eve $150–300) | Unverified today. Sourced in the memo largely to Irys's own comparison pages and SEO content. Re-verify before any pitch use. | — |

A note on the memo's sourcing generally: of its 68 citations, the market and pricing claims rest mainly on vendor comparison pages, aggregator news and SEO blogs; the hardware claims rest on GPU retailer and hosting-provider blogs; the legal claims are the best-sourced section (law-firm client alerts, the bill text, the ABA opinion). Weight the memo accordingly.
