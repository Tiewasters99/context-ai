# Compliance tab — one page

**Date:** 2026-10-12 · **Status:** DRAFT spec for Eden's reading; nothing built · **Builds on:** the AI Use Record rules matrix (`src/lib/matter-record/jurisdictions.ts`, matrix 2026-09-21.2, printed by the Record export), `lib/ai-tier-policy.mjs` (tiers A/B/C), `docs/strategy/005-defensible-ai-positioning.md`, `docs/strategy/006-seal-by-privilege-not-by-matter-2026-09-18.md`, `lib/transcribe-gemini.mjs` · **Asked for by Eden, 10-12:** "a button or a tab entitled compliance that would list a vendor's terms on opt out and provide an analysis of the issues with each AI use, including the advantages/possible limitations of sealing a matter … include Gemini/Antigravity since I would like us to wrap their video capabilities within our discovery tools."

## 0. The sentence

Before a lawyer sends anything out of a matter, one page answers the three questions that actually decide it: the ethics rule, the privilege, and the protective order. It never answers with a verdict. It answers with the vendor's own terms, dated and linked, the matter's own facts, and the questions the lawyer still has to answer in their own name.

## 1. What exists (verified in the code today)

| Piece | State | Where |
| --- | --- | --- |
| Jurisdiction rules (disclosure, certification, verification, confidentiality duties), 15 entries, verbatim from the matrix, no characterisation added | Built; printed in the Record export | `src/lib/matter-record/jurisdictions.ts` |
| Models used per session and on what terms, connector activity, seal changes | Built; the Record tab and export | `lib/ledger.mjs`, `RecordTab` |
| Tier policy: A any US provider; B sealed = our own Bedrock account, retention `none`, refuse rather than fall back; C local only | Built, server-enforced | `lib/ai-tier-policy.mjs` |
| Video and audio transcription: upload to Google's Gemini Developer API Files API, verbatim timestamped transcript plus `[mm:ss] VISUAL:` notes for video, file deleted after (best effort) | Built, at ingestion only | `lib/transcribe-gemini.mjs`, `lib/ingest-core.mjs` |
| A sealed matter refuses transcription (the recording would leave the seal); the file is kept and says why it has no transcript | Built | `lib/ingest-core.mjs` ~730 |
| Per-provider agent tokens (Claude, ChatGPT, Gemini, Grok) and BYOK keys | Built | `src/lib/agentTokens.ts`, `lib/llm-record.mjs` |

What does not exist: any page that states a vendor's retention, access and training terms; any reading of a protective order against a proposed use; any statement of what Contextspaces itself retains and through whom.

## 2. What the tab shows (four panes; one under the other on a phone)

**A. The three questions, as the reading order.** Ethics (Rule 1.6 and Formal Op. 512: authorization plus reasonable efforts; consent where the tool learns or retains), privilege (separate from ethics; third-party processing does not invariably waive; work product differs), protective order (who may receive, permitted uses, undertakings, derived materials; silence about AI removes nothing). Static text, Eden's words, one screen.

**B. Vendor cards.** One card per route, every line dated and linked to a primary source, nothing filled without one. Fields: *what is retained and for how long · who can access it (employees, contractors, sub-processors) · what the opt-out actually switches off · training use · enterprise route and how it differs · undertaking available (signed DPA, Exhibit A capacity) · modalities (video?) · verified on · verified by.* Status `draft` until two reads, as the matrix does.

Seed cards, in this order:

| Card | What the sources already show (all to be re-verified before the card is `verified`) |
| --- | --- |
| **Contextspaces itself** | The honest card. Tier A text: Anthropic API or our Bedrock account. OCR and transcription: Google Gemini Developer API, paid tier (confirm the key's tier), file uploaded then deleted; Google states paid prompts and files are not used to improve products and are logged "for a limited period" for abuse detection; the Files API is outside ZDR and relies on our delete. Embeddings: OpenAI (confirm). Sealed matters: Bedrock `none`, no transcription. Hosting: Supabase, Vercel, Fly, AWS. |
| **Google Gemini API** | Paid tier: no training; abuse logging for a limited period; context cache and Files API are outside ZDR; "If your workload requires guaranteed zero data retention or enterprise data processing agreements, use Vertex AI" (ai.google.dev ZDR page, updated 2026-09-14). Free tier trains and may be human-read. |
| **Google Antigravity** | Individual terms: Google records "Interactions" while the service runs, uses them "to evaluate, develop, and improve Google and Alphabet research", "employees and contractors may access, view, review and use Interactions"; opt-out in settings; deletion on request. Workspace or Google Cloud sign-in: "the terms below do not apply to you" and the administrator's terms govern. Forum reports that the visible toggle is telemetry, not training: unconfirmed. Antigravity is an IDE, not an API; what it sends to a Gemini endpoint is governed by that endpoint's terms. |
| **Anthropic API** | Default retention of inputs and outputs (sources disagree 7 vs 30 days: read the commercial policy); ZDR per organisation by approval; Files API outside ZDR; covered models (Fable 5.1 / Mythos 5.1) require retention and are not ZDR-eligible; no training on commercial data. |
| **OpenAI API** | Abuse logs up to 30 days by default; no training since March 2023 unless opted in; ZDR and Modified Abuse Monitoring by approval; files, vector stores, batches outside ZDR; image inputs may be retained when flagged. |
| **ChatGPT and Claude consumer apps** | What most lawyers actually have. Separate card, because the consumer terms differ from the API terms above, and because Op. 512's consent rule bites hardest here. |

**C. Uses × questions.** Rows are the things a litigator does: summarize a deposition; draft a brief; review discovery video; cite-check; client chat; let an outside assistant (Claude, ChatGPT, Antigravity) read the matter through a connector. Columns: what leaves the matter · to whom · under which card · what the Record logs · consent or undertaking still needed. Filled from the tier policy and the ledger, not typed by hand, so it is true for *this* matter.

**D. Sealing, both directions.** *What it buys:* no first-party frontier API in the loop; retention `none` in our own account; refusal rather than fallback; the Record shows nothing left. *What it costs:* a narrower model set; no video or audio transcription today (Gemini is not on Bedrock); no outside connectors; Tier C waits on hardware. *What it does not do:* it is not an Exhibit A undertaking; it does not make anything privileged; it does not satisfy an order that names the recipients. Language rule from 005: we say what left, to whom, under what terms, and who confirmed it. We never say "preserves privilege" or "complies with".

**E. Read this order against this use** (the one LLM step). The lawyer points at the protective order in the matter and names the use. The assistant returns the paragraph table the 10-12 memo produced by hand: provision · page · how it bears on the use · whether an undertaking or consent path exists (¶7(e)-style written consent, ¶15-style modification). Marked DRAFT, pinned to the order's page:line, saved to the Record as a note the lawyer initials or rejects. The assistant proposes; it does not clear.

## 3. Video, specifically (Gemini, Antigravity, the discovery tools)

- The wrap already exists at ingestion: a video filed in a matter becomes a timestamped transcript with factual visual notes, searchable and citable to `[h:mm:ss]`. That is the Gemini video capability inside our discovery tools today, under our key and our card.
- The gap is on demand: in the Review Room, "ask this video" (where does the officer first draw the weapon; list every person who enters the frame) with answers pinned to timestamps, and a frame grab as an exhibit. Same `transcribe-gemini` route, a new prompt, no new vendor. Scope and price belong to a Discovery spec, not here; this tab only has to state the card it runs under.
- Route choice to decide: Developer API paid tier (today) versus Vertex AI (Google's own answer for guaranteed ZDR and a DPA). The card states whichever is live. The BYOK Gemini key path stays for a lawyer who wants their own account on the hook.
- Antigravity cannot be wrapped; it is the lawyer's desktop tool. Its card exists so a lawyer using it alongside us can see the two sets of terms side by side.
- Sealed matters: video stays untranscribed until a video-capable model sits in our Bedrock account under `none`. The card says so in one line.

## 4. Data model and placement

- **No migration for v1.** Cards and the three-questions text ship as a versioned, build-time file like `jurisdictions.ts` (`cards_version` printed on the page and in the Record export). The uses × questions pane is derived. Pane E writes a Record note through the ledger's existing note path; if a new event kind is wanted, that is one line in a later migration and Eden applies it.
- **Where:** a tab on the matter page beside Record (the matter is the unit the questions attach to), and the same page under Settings → AI for the account-wide view with no matter facts. Phone: panes stack; pane C collapses to one use per card.
- **Name:** Eden asked for "Compliance". Strategy 005's UI rule says the interface stays discreet ("the matter's Record", never "audit log" or "compliance"). Eden decides; alternatives that say what the page does: **Terms**, **Before it leaves**.

## 5. Decisions Eden owes (one line each)

| # | Decision | Recommended |
| --- | --- | --- |
| 1 | Tab name: Compliance, Terms, or Before it leaves | Terms |
| 2 | Contextspaces' own card lists our sub-processors by name | Yes; 005 already says we build on Supabase, Vercel, Fly, AWS |
| 3 | Gemini route for transcription: stay on the Developer API paid tier or move to Vertex | Confirm the paid tier this week; Vertex when the first client asks for a DPA |
| 4 | Pane E (order reading) in v1 or v2 | v1; it is the one thing a lawyer cannot get from a vendor page |
| 5 | Two-read rule before any card shows `verified` | Yes, the matrix rule, Eden is the second read |

## 6. Build

Fable: the six cards with sources, panes A and D text, pane E prompt and output shape (two sessions). Opus: the page, the derived pane C, the Record note (one PR, no migration). Terms change monthly, so each card carries its date and the quarterly matrix sweep covers the cards too.

## 7. What the market does with video (asked 10-12; vendor pages, not independent tests)

No PI platform documents video analysis. Eve's own pages describe deposition transcripts, medical records and MRI comparison; its discovery guide mentions transcribing audio and video to searchable text in general terms. EvenUp and Supio publish nothing on video. The tools that do touch litigation video are a different kind: Veritone Redact and Amped FIVE (forensic enhancement and redaction, law-enforcement market), and transcription tools (Rev, Otter) that some attorneys point at dashcam footage. Nothing found that answers questions about what is on screen with timestamps, which is what the ingest route already does.
