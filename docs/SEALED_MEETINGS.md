# A meeting in a sealed matter

_2026-09-20. What Contextspaces promises about a meeting whose matter is sealed
(SecureSpace Tier B), and what it does not._

## The promise

**A sealed meeting's transcript never reaches a provider outside the seal — and
the meeting still has an assistant.**

Both halves matter. The first was won in PR #162, which found that
`/api/meeting-chat` and `/api/meeting-flag` were sending verbatim transcripts to
first-party Anthropic on sealed matters and closed it by refusing. The second is
Eden's decision of 2026-09-20, in his words:

> "sealed chat should be answered by Kimi with whatever agentic harness Kimi can
> run inside the sealed space."

So a sealed meeting is not a degraded meeting with the AI switched off. It is a
meeting answered by the pen that lives inside the seal.

## What happens, by tier

| | Tier A (open) | Tier B (sealed) | Tier C (silo) |
|---|---|---|---|
| Live transcription (`/api/deepgram-token`) | Deepgram | **refused** (`lib/seal-pipes.mjs`) | **refused** |
| Chat (`/api/meeting-chat`) | Claude Opus, first-party, with web search | **the sealed pen** — Kimi K2.5 in our own AWS account, zero retention, through the Assistant's agentic harness | **refused** |
| Automatic flagging (`/api/meeting-flag`) | Claude Opus every 90s | **refused, quietly** | **refused** |
| Recording the exchange | not recorded | `ai_sessions` / `ai_messages`, with model, provider, tokens and cost | n/a |

Chat and flagging differ on purpose. Chat is a question a person asks. Flagging
is a timer that scans the whole transcript every ninety seconds, unprompted, and
a decision about the first is not a licence for the second. Flagging inside the
seal is a separate decision and it has not been made.

## What the sealed meeting assistant can and cannot do

It is the same loop that answers sealed chat (`runAssistantStream`,
`lib/assistant-core.mjs`), so it has the same tools, and every one of them keeps
the meeting's content inside Contextspaces:

- **`search`** — inside a sealed matter this embeds nothing. The query is not
  posted to an embedding provider; the search is Postgres full-text only, and it
  says so in its own results (`lib/seal-pipes.mjs`, `sealedSearchNote`). Exact
  words rank normally; a paraphrase may not surface.
- **`grep`, `get_passage`, `get_outline`, `list_matter_contents`,
  `list_matters`, `get_matter_state`, `set_matter_state`** — the user's own
  database, under the user's own RLS. Nothing leaves.
- **`ingest_document` / `check_ingest_status`** — enqueue only, and a sealed
  document parks as `held` rather than going to an outside extractor.
- **`web_search`** — the one tool that would leave. It belongs to the Tier-A
  meeting route and is **not in this harness's tool set at all**. There is
  nothing to disable.
- **`open_document`, `open_matter`, `create_sub_matter`, `move_document`,
  `relay_feedback`** — offered by the harness but inert from a meeting panel,
  which has no handler for them. The pen is told so and told not to call them.
  `relay_feedback` is the one to watch: it writes the user's words into the
  Contextspaces admin matter's chronology, which is a cross-matter write. It
  never leaves Contextspaces and never reaches a model, but it should be
  narrowed away structurally — see the PR.

## Long meetings

The sealed pen's context is smaller than first-party Claude's, and a long
meeting will not fit. **Nothing is ever truncated silently.** When the
transcript is larger than the budget, the most recent part is sent and the
answer opens by saying exactly how much:

> This answer covers only the most recent part of the meeting — the last 412 of
> 1,050 transcript lines. The rest is longer than the sealed pen can hold, so it
> was not sent and I have not read it. Ask about a specific moment and I can look
> for it in the matter record.

In lines, not minutes: the browser renders the transcript for the server with
`renderTranscriptForClaude()`, which drops each line's start and end times, so
no timestamp ever reaches the server. A duration would be a guess dressed as a
measurement.

The pen is told the same thing in its own instructions, so it cannot answer as
though it had read the whole meeting, and it is pointed at the matter record —
`search`, `grep`, `get_passage` — for anything said earlier that was filed.

## When it cannot answer

Two refusals, both in the product's own voice, both the same sentences sealed
chat uses, because they come from the same functions
(`sealedPenUnavailableMessage` / `sealedPenErrorMessage`):

- **No sealed pen on this server** (`503 sealed_pen_unavailable`) — the
  `BEDROCK_*` keys are unset or still `PASTE`. Nothing was sent. The meeting
  keeps running and stays recorded.
- **The sealed pen was reached and could not answer** (`502 sealed_pen_error`) —
  credentials rejected, model gated for the account, a region error. This one
  does *not* claim nothing was sent, because the turn did reach the sealed
  provider, which is inside the seal. What it promises is that no other provider
  was asked.

There is no third outcome. A sealed meeting is never quietly handed to another
model: the request that serves it holds no Anthropic key, no Fireworks key and
no OpenAI key, so there is nothing to fall back to.

## Where this lives

| | |
|---|---|
| The seal lookup, shared with flagging | `lib/meeting-seal.mjs` |
| The sealed meeting turn | `lib/meeting-sealed-chat.mjs` |
| The route | `api/meeting-chat.mjs` |
| The pen, the loop, the ledger | `lib/assistant-core.mjs` |
| Proof, offline | `scripts/_verify-sealed-meetings.mjs` |

## Not yet true

- **The pen's context window is not declared anywhere in the codebase.** `PENS`
  carries prices, a route and a thinking headroom but no context size, so the
  windowing budget uses the repo's own figure for the Kimi K2.x family
  (`src/lib/llm/providers.ts`). A `contextTokens` field on `PENS[*]` is the fix.
- **No live Bedrock call has been made from this path.** Every check is offline.
  The in-app check is in the PR.
- **Sealed flagging.** Refused, pending a decision.
