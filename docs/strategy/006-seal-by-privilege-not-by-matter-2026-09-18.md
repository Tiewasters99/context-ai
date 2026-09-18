# 006 — Seal by privilege class, not by matter

**Date:** 2026-09-18 · **Status:** Design principle, adopted in conversation with Eden 2026-09-18; build sequencing proposed below, not yet scheduled · **Supersedes in part:** the per-matter seal as the *unit* of sealing (the seal mechanism itself is unchanged) · **Related:** 003 (no pivot to local inference), 004 (retention ladder; invoke tests), 005 (Defensible AI), security/provenance roadmap W1–W12.

## The sentence

The thing that puts privilege at risk is not what a model provider retains. It is what a model can reach. A model's retrieval and context are class-blind, so any privileged document a session can see will shape that session's output, and any outbound tool the session holds can carry the result out. The unit of sealing should therefore be the privileged material itself, not the matter it sits in, and the privileged unit needs a modest tool-capable model far more than it needs a frontier one.

## 1. Correcting our own premise

Since 08-21 the sealed tier has been argued from retention: zero data retention (ZDR) in our own AWS account, no training, no provider access. That is worth having, and 004 now proves it on demand. But it is not what preserves privilege, and saying so would be a representation we cannot stand behind (005, "what we cannot say").

Under the usual rule, disclosure to a vendor bound by confidentiality is disclosure to the lawyer's agent, not to a third party. Copy services and e-discovery hosts have been treated that way for decades. Retention for thirty days by such a vendor does not by itself waive anything. What waives, or breaches Rule 1.6, is one of three things:

1. **Disclosure outside the circle.** A provider mode under which humans may read the content. On Bedrock that is exactly what `aws_review` means, and it is the only mode Fable 5 runs under (004). Fable therefore never touches privileged material. This is the one place retention terms and privilege actually meet.
2. **Commingling across clients.** An assistant with memory, or retrieval that spans matters, builds one client's work product on another client's confidences. No waiver, but a conflicts and confidentiality problem, and a screened lawyer's screen fails.
3. **Agentic egress.** A session holding privileged text calls a tool that transmits: a web search whose query the model composed from the context, an email it attached the wrong draft to, a sub-agent on a provider with different terms.

ZDR removes the vendor copy. That means nothing to subpoena, nothing to breach, no provider staff to see it, and the strongest available evidence of reasonable steps. It does not stop 2 or 3. Only reach does.

## 2. The mechanism, stated plainly

Retrieval brings the most relevant text to bear on a question. On a legal question inside a matter, the most relevant text is very often the privileged analysis. Once it is in context it shapes the output, and the output inherits none of its labels. Three ordinary examples:

- A non-privileged meet-and-confer letter is drafted with the strategy memo in context. Paragraph three carries phrasing that exists only in the memo. The letter is filed.
- A deposition summary is written with the attorney's annotated copy in context. The summary adopts the attorney's mental impressions as if the witness said them. It goes to an expert who is not inside the same privilege.
- A search query is composed from a settlement-authority figure that came from a client communication. The figure is now in a search provider's log.

None of these is a breach or a bug. Each is a feature working as designed on a corpus that was never partitioned by class.

The same mechanism defeats the discipline lawyers actually use today. A rule of "no privileged material in the AI project" governs what the lawyer pastes. It does not govern what a connector can search. If a document-store connector is in scope for the privileged folder, one "search my files for that old settlement" returns privileged snippets into the conversation, to the provider, before the lawyer has read anything. The boundary that matters is the model's reach, not the lawyer's paste.

## 3. Two cases where the harm is not theoretical

**The production that assembles itself.** An agent with the document store and email connected is told to gather everything responsive to a request about the Q3 pricing decision and draft the transmittal. The general counsel's exposure analysis is the most relevant document on that decision; it ranks first and goes into the set; the transmittal paraphrases it. The associate skims four hundred documents and approves. Clawback under FRE 502(b) requires reasonable steps to prevent the disclosure, and courts have refused it where the privilege review was a cursory pass over a mechanically selected set (*Victor Stanley, Inc. v. Creative Pipe, Inc.*, 250 F.R.D. 251 (D. Md. 2008), keyword screening the party could not defend — **cite to be verified by counsel before external use**). Because the transmittal used the analysis, the adversary argues subject-matter waiver under 502(a).

**The client who prepared for litigation in a chatbot.** A founder receives a demand letter, retains counsel, and between calls works through the case in a consumer assistant with memory on: pastes the lawyer's advice, writes the timeline including what the lawyer was not told, asks how bad it is. Forty chats. Discovery requests all AI communications concerning the dispute. In *United States v. Heppner*, No. 25 Cr. 503 (JSR) (S.D.N.Y. Feb. 17, 2026), ECF No. 27, the court held a defendant's exchanges with a generative-AI platform were protected neither by privilege nor by work product (**read by the matrix verifier by OCR of a scanned memorandum; counsel to read the memorandum before relying on it externally**). The founder's own worst assessment is produced in the founder's words, and the pasted advice was disclosed to a third party by the client.

The first is the litigator's risk under a settled doctrine. The second reaches every practice area, because every client thinks before they call. A close third is the lateral hire whose screen is defeated by a firm-wide assistant with cross-matter memory, which ends in a disqualification motion.

## 4. What follows for the design

**4.1 The sealed unit is the privileged container.** A privileged folder inside an otherwise open matter, sealed on its own: its own pen, no cross-folder retrieval, no outbound tools. Everything else in the matter runs on Tier A frontier models with no privilege question. This is cleaner than "seal the whole matter and accept a weaker model everywhere," and it is the only arrangement under which the mechanism in §2 cannot start: a non-privileged session never had the memo, so it cannot write the paragraph, adopt the impression, or compose the query.

**4.2 The privileged pen does not need frontier intelligence.** On the privileged set the work is retrieval, verbatim quotation, comparison, summary, and drafting help, all reviewed by the attorney. What the pen needs is a reliable tool loop, long context, and instruction following. On 2026-09-18 all seven sealed-eligible open-weight models on our Bedrock account issued a correct `get_passage` tool call on the first try (Kimi K2.5 496 ms, GLM-5 627 ms, Mistral Large 3 596 ms, gpt-oss-120b 651 ms, Qwen3-235B 847 ms, DeepSeek v3.2 1.5 s, MiniMax M2.5 14.6 s). Kimi K2.5 is the sealed pen of record as of PR #149, verified live in production the same day. Strategic legal reasoning on privileged material stays available through the recorded escalation path, with the document text never leaving the seal (roadmap unchanged).

**4.3 Classification at ingestion, attorney-confirmed.** A document enters a privileged container by an attorney's decision, proposed by a classifier and confirmed by initials, never automatically. The classifier's proposal and the attorney's confirmation are both rows in the Record. This is the intelligence-first pattern: the system makes the lawyer think about the right thing at the right moment rather than deciding for them.

**4.4 SecureChat is a communication to counsel.** The client channel is privileged on the ordinary elements when four facts are provable: counsel's written instruction to use it; the channel scoped to the matter and monitored by counsel; the model running in counsel's own account with no provider access and zero retention (Kimi as open weights in our AWS account is stronger here than any first-party frontier API, because the model vendor is not in the loop at all); and the transcript **delivered** to counsel, not merely available. The client is told, inside the channel, that what they write is a communication to their lawyer. Work product is the second layer for material prepared at counsel's direction. "Non-discoverable" means withheld and logged; the facts stay discoverable; no court has ruled on this configuration, so the Record is what will carry the first one.

**4.5 The Record shows class and reach.** For every document: which container it sat in, when, and on whose confirmation. For every model touch: which model, under what retention terms, from which container. For every tool call that could egress: what it carried. This is 005's exhibit, and it is what turns "we took reasonable steps" into something a carrier, a bar, or a 502(b) motion can read.

## 5. What does not change

The seal mechanism (egress enforced at the data; server-side refusal; the seal governs MCP) is unchanged; it is applied at a finer grain. The three-tier ladder is unchanged; Tier C remains a tier (003). The pitch order in 005 is unchanged. The positioning rule holds: we never say the platform preserves or guarantees privilege. We say what left the matter, to whom, under what terms, and who confirmed each classification.

## 6. Proposed sequencing (for Eden to confirm; Opus builds)

1. **Privileged container as a sealed unit.** Folders and sub-matters are the same container and `ai_tier` inherits downward, so a sealed sub-matter inside an open matter already exists. What does NOT exist is the isolation: a search scoped to the parent includes its descendants (`lib/mcp-core.mjs`, matterspace_descendants), so an open session can reach a sealed child today. The build is: exclude any descendant whose effective tier exceeds the session's from retrieval, grep, outline and listing; outbound-tool absence for sealed contexts already holds at matter grain and carries over. Smallest change with the largest effect, but real work, not configuration.
2. **Classification proposal + attorney confirmation at ingestion**, recorded (extends the P1 truth/feedback loop).
3. **SecureChat delivery to counsel** and the in-channel notice to the client.
4. **Record rows for container membership and per-touch model/terms** (W1/W5 as specced, with the container as a new column).
5. Escalation from a privileged container: recorded, document text never leaves; unchanged design, verify it holds at folder grain.

Open questions for Eden: whether a privileged container may exist outside any matter (a client's "before we have a matter" channel); whether the classifier runs on the sealed pen or on a deterministic rule set first; and what the in-channel notice to the client should say, since it is a representation.

## Sources and verification state

- Bedrock facts: 004 (probe runs and invoke tests 2026-09-18, this account). Verified by live calls this session.
- Tool-call test: seven models, one prompt, `/v1/chat/completions` on bedrock-mantle us-east-1, 2026-09-18. Session record only; rerun before quoting timings externally.
- *Heppner*: verifier's OCR reading of ECF No. 27 (see `jurisdictions.yaml`, us-sdny). Counsel to read before external use.
- *Victor Stanley*: cited from memory; verify before external use.
- Vendor-as-agent rule, FRE 502(a)/(b), Rule 1.6(c): stated at the level of general doctrine; jurisdiction-specific authority to be pulled from the rules matrix before any client-facing use.
