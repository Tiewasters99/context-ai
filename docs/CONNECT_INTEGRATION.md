# Grapheon Connect → Contextspaces integration spec

**Date written:** 2026-05-12
**Author:** Claude (Grapheon Connect terminal)
**Reader:** Claude (Contextspaces terminal) + user
**Status:** Spec ready for implementation. User has approved the merge in principle but has not picked integration pattern yet (see "Open decisions").

---

## TL;DR

Fold Grapheon Connect — the live meeting transcription + AI advisor PWA at `connect.grapheon.ai` — into Contextspaces (becoming Grapheon Legal). Meetings become a feature OF a matter. Connect's standalone Vercel project and Supabase instance get retired; everything moves into the Contextspaces repo and Supabase project.

The strategic reason: Grapheon Legal is the flagship suite (per `project_grapheon_positioning.md`). Connect doesn't make sense as a standalone product when its highest-leverage use is "I just had a client meeting — drop the transcript into the matter file."

---

## What Connect is today

Live at `https://connect.grapheon.ai`. Working end-to-end. Built over 2026-05-07 → 2026-05-09. Code at `C:\Users\equai\Grapheon\meet\`.

**Features in production:**

1. **Live transcription** via Deepgram nova-3 streaming WebSocket. Phone-on-table or phone-in-hand. AudioWorklet downsamples mic to 16kHz Int16 PCM.
2. **Multi-device sync** via Supabase Realtime broadcast on a `session:${id}` channel. Phone captures; laptop reads + chats. QR-code pairing.
3. **Real-time Claude chat** using Claude Opus 4.7 with `thinking: { type: 'adaptive' }` + `output_config: { effort: 'high' }`, prompt caching on the transcript prefix, server-side web_search tool (`web_search_20260209`, max_uses 5).
4. **Proactive flagging** — background loop scans the transcript every 90s and surfaces unprompted "Watchpoints" inline in the chat pane: contradictions, factual errors, commitments, opportunities, risks. Bounded to 30 flags/session, only fires when transcript has grown ≥200 chars since last scan.
5. **Late-joiner backfill** — finalized chunks persist to a `transcript_chunks` table; new device joining mid-session loads history before subscribing to live broadcasts.
6. **Wake Lock + silent audio loopback** so phones don't suspend mic capture when the screen sleeps.
7. **Identity**: assistant identifies as "Grapheon AI" per system prompt; if pushed, says it was built on top of Claude Opus 4.7. Persona/branding rules per feedback memories.
8. **PWA install** — manifest, icon, viewport set up for "Add to Home Screen."
9. **Pages**: `/` (landing), `/s/[id]` (session), `/meetings` (history), `/help`, `/pricing`, `/settings` (placeholder), `/signin` (placeholder). Pricing page marketing-only, no Stripe wiring.

**Stack:** Next.js 16.2.6 (App Router, Turbopack), React 19, Tailwind v4 with Contextspaces palette, Supabase JS, Anthropic SDK 0.95.1, Deepgram SDK 5.1.0.

---

## Integration target

Meetings live inside Contextspaces as a feature of a matter:

- **Matter card** gets a "Meetings" section showing the list of meetings linked to this matter (date, duration, preview, segment count).
- **"+ New meeting"** button on the matter card creates a meeting record pre-linked to that matter and opens the session UI.
- **"Save to matter"** button on an ongoing/orphan meeting lets the user link it to a matter retroactively.
- **Meeting detail view** = the same split-pane UI Connect has today (transcript on the left, Grapheon chat on the right), rendered inside Contextspaces' shell.

Mobile (phone-on-table) experience: opening the meeting URL on a phone shows the same UI optimized for mobile. No Contextspaces chrome needed on the meeting page itself — the phone is in capture role.

---

## Architectural patterns — pick one

### Pattern A: full merge into Contextspaces (recommended)

Connect's runtime moves entirely into `~/context-ai`. The standalone Connect Vercel project and Supabase instance get decommissioned.

- All Connect pages and API routes ported into the Contextspaces app
- Meetings UI lives at `contextspaces.ai/m/[meetingId]` (or similar)
- Contextspaces auth gates access (no more "anyone with the publishable key reads any session" v1 hack)
- Schema lives in Contextspaces' Supabase (single source of truth)
- Phone access: just open `contextspaces.ai/m/[id]` from phone — works the same way Connect does today

**Pros:** single codebase, single Supabase, single auth, single deploy. Connect's data joins Contextspaces' relational model (meetings ↔ matters). Aligns with Grapheon Legal positioning.

**Cons:** Contextspaces sign-in gates phone usage. (Mitigation: long-lived session cookies; meetings page works once signed-in.)

### Pattern B: keep Connect as a thin PWA, sync to Contextspaces

`connect.grapheon.ai` stays as a focused mobile-discreet PWA, but writes through to Contextspaces' Supabase via the existing connector-token MCP layer.

**Pros:** the Connect mobile PWA stays optimized for the phone-in-hand use case without Contextspaces chrome.

**Cons:** two front-ends to maintain, cross-project auth dance, more places to ship bugs.

### Recommendation: **Pattern A**

Mobile responsiveness of the Contextspaces app gets us 95% of Pattern B's value. The auth gate is a *feature* once we charge money. And we want meeting transcripts joined to matters at the database level, not just by FK.

---

## Database schema (Contextspaces Supabase)

New migration file. Suggest naming: `010_meetings.sql` (or whatever the next number is — `~/context-ai/supabase/migrations/`).

```sql
create table public.meetings (
  id uuid primary key default uuid_generate_v4(),
  matterspace_id uuid references public.matterspaces(id) on delete set null,
  created_by uuid references public.profiles(id) not null,
  title text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'active' check (status in ('active', 'ended', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_meetings_matterspace on public.meetings(matterspace_id);
create index idx_meetings_created_by on public.meetings(created_by);

create table public.meeting_chunks (
  id uuid primary key default uuid_generate_v4(),
  meeting_id uuid references public.meetings(id) on delete cascade not null,
  text text not null,
  speaker int,
  start_seconds double precision not null,
  end_seconds double precision not null,
  created_at timestamptz not null default now()
);

create index idx_meeting_chunks_meeting on public.meeting_chunks(meeting_id, created_at);

create table public.meeting_messages (
  id uuid primary key default uuid_generate_v4(),
  meeting_id uuid references public.meetings(id) on delete cascade not null,
  role text not null check (role in ('user', 'assistant', 'flag')),
  flag_type text check (flag_type in ('contradiction', 'factual_error', 'commitment', 'opportunity', 'risk')),
  content text not null,
  anchor text,
  created_at timestamptz not null default now()
);

create index idx_meeting_messages_meeting on public.meeting_messages(meeting_id, created_at);

-- RLS — adapt to Contextspaces' existing patterns (this is a sketch)
alter table public.meetings enable row level security;
alter table public.meeting_chunks enable row level security;
alter table public.meeting_messages enable row level security;

create policy meetings_owner on public.meetings
  for all using (created_by = auth.uid()) with check (created_by = auth.uid());

create policy meeting_chunks_via_meeting on public.meeting_chunks
  for all using (
    exists (select 1 from public.meetings m where m.id = meeting_chunks.meeting_id and m.created_by = auth.uid())
  );

create policy meeting_messages_via_meeting on public.meeting_messages
  for all using (
    exists (select 1 from public.meetings m where m.id = meeting_messages.meeting_id and m.created_by = auth.uid())
  );
```

`matterspace_id` is nullable so users can have meetings not yet linked to a matter — link via UI later.

Schema rename from Connect's current `transcript_chunks`: that table can be dropped after migration — its data is in a separate Supabase project (`wdtaueaihyuloeiiquxf`) and won't migrate. Connect's existing meetings stay accessible on `connect.grapheon.ai` until that domain is sunset, then the data is gone.

---

## Files to port from Connect

All paths are from `C:\Users\equai\Grapheon\meet\`:

| Connect file | Notes for porting |
|---|---|
| `src/lib/deepgram.ts` | Live client. **Port as-is**, no changes. |
| `src/lib/transcript.ts` | Reducer for chunk → transcript state. **Port as-is**. |
| `src/lib/realtime.ts` | Supabase Realtime broadcast + persistence helpers. **Refactor**: replace channel name `session:${id}` → `meeting:${id}`; `persistChunk` writes to `meeting_chunks` (with meeting_id) instead of `transcript_chunks` (with session_id); `loadTranscriptHistory` queries `meeting_chunks` by meeting_id. |
| `src/lib/sessions.ts` | Lists meetings. **Replace** with a Contextspaces-style helper that queries `meetings` table with auth-scoped client, optionally filtered by matterspace_id. |
| `src/lib/supabase.ts` | Browser Supabase client. **Use Contextspaces' existing client**, not this one. |
| `public/pcm-worklet.js` | AudioWorklet. **Port as-is** to Contextspaces' `public/`. |
| `src/app/api/deepgram/token/route.ts` | **Port as-is**. Already handles the Member-scope fallback gracefully. Needs `DEEPGRAM_API_KEY` env. |
| `src/app/api/claude/chat/route.ts` | **Port with minor refactor**: per the new `feedback_model_agnostic_architecture` memory, abstract the Anthropic SDK behind an LLM-adapter layer rather than baking Opus 4.7 + Anthropic's thinking shape directly into the route. |
| `src/app/api/claude/flag/route.ts` | Same — same adapter abstraction. Schema for flags is documented. |
| `src/components/ShareDialog.tsx` | QR + native share. **Port as-is**. |
| `src/components/AppShell.tsx` | **Don't port** — Contextspaces has its own shell. The meetings page uses the Contextspaces shell instead. |
| `src/app/s/[id]/page.tsx` | The session UI. **Port heavily refactored**: drop AppShell wrapper; integrate with Contextspaces auth and matter context; rename `id` → `meetingId`; replace `transcript_chunks` writes with `meeting_chunks`; add "Save to matter" / "Link to matter" UI if not pre-linked. |
| `src/app/meetings/page.tsx` | The meeting history list. **Port heavily refactored**: same auth integration, route under Contextspaces, optional filter by matterspace. |

**Do not port** Connect's home page (`src/app/page.tsx`) or pricing/help/signin pages — Contextspaces has its own marketing surface.

---

## Environment variables (Contextspaces Vercel project)

Add:
- `DEEPGRAM_API_KEY` — currently `4e93ecf861797331e35f1d54da26d5f97ef39761` in Connect's `.env.local`. Should rotate before pasting anywhere durable; user has been reminded.
- `ANTHROPIC_API_KEY` — currently the `sk-ant-api03-Ntq2L...AAA` key in Connect's `.env.local`. Same rotation note.
- (Optional) `CLAUDE_MODEL` / `CLAUDE_FLAG_MODEL` for future model-swap without redeploy. Per `feedback_model_agnostic_architecture`, prefer abstracting via adapter rather than env-pinning a provider's model ID.

`NEXT_PUBLIC_SUPABASE_*` already in Contextspaces — uses its own keys, not Connect's.

---

## Open decisions (need user input)

1. **Route shape**: `/m/[id]`, `/meetings/[id]`, `/matters/[matterId]/meetings/[id]`? My take: `/m/[id]` for the live session (mobile-friendly short URL — easy to QR), with the meeting record carrying the matterspace_id internally. Matter card UI link nav to `/m/[id]`.

2. **"Start meeting" entry points**: from a matter card AND from a global "+ New meeting" button somewhere in the Contextspaces shell? My take: yes both, but from the matter card it's pre-linked; global is unlinked-then-link-later.

3. **What happens to `connect.grapheon.ai`?** Three options: (a) sunset entirely, (b) redirect to `contextspaces.ai/m/new`, (c) keep alive as a free-tier no-auth funnel for non-Contextspaces users. My take: (b) for the first month while existing users migrate, then sunset to (a).

4. **Pricing model when bundled with Grapheon Legal**: should Connect remain its own SKU ($19/mo standalone) or fold into the Grapheon Legal firm-bundle pricing ($200-500/seat)? My take: do both — standalone tier exists for solo lawyers who only want Connect, bundled into the firm tier for everyone else. But this is a business call.

5. **LLM adapter abstraction**: per `feedback_model_agnostic_architecture`, do we build the adapter layer for Connect's calls now (before porting) or port-then-refactor? My take: port-then-refactor — get Connect working in Contextspaces first, then extract the adapter as a separate cleanup.

---

## Step-by-step TODO for the Contextspaces terminal

Suggested order. Each step deployable on its own.

1. **Read this doc + `project_grapheon_connect.md` + `feedback_model_agnostic_architecture.md`** to absorb context.
2. **Write the migration** at `~/context-ai/supabase/migrations/0XX_meetings.sql` from the schema above. Run via Supabase dashboard SQL editor (Contextspaces' instance, not Connect's).
3. **Port the AudioWorklet** to `~/context-ai/public/pcm-worklet.js`. No code change.
4. **Port the lib layer**: `~/context-ai/src/lib/deepgram.ts`, `transcript.ts`. Refactor `realtime.ts` for new schema.
5. **Port API routes** to `~/context-ai/src/app/api/deepgram/token/route.ts` and the Claude routes. Add env vars to Vercel.
6. **Build the meeting session page** at `~/context-ai/src/app/m/[id]/page.tsx`, using Contextspaces' auth + shell. Add "Save to matter" UI for unlinked meetings.
7. **Add Meetings section to matter card** — list of meetings linked to this matter, "+ New meeting" button creating a meeting pre-linked to this matter.
8. **(Optional) Global meetings list page** at `~/context-ai/src/app/meetings/page.tsx`.
9. **Sunset connect.grapheon.ai**: redirect or take down, user's call.

Total scope: ~1-2 focused days. Schema migration is the riskiest piece because it touches matterspaces FK; everything else is mostly mechanical porting.

---

## Reference: live system at the moment of writing

- **Deployment:** `https://connect.grapheon.ai` (Vercel project `quainton-law/grapheon-connect`)
- **Supabase project (to be retired):** `wdtaueaihyuloeiiquxf`
- **Tables in use:** `transcript_chunks` (open RLS — anyone with publishable key can read/write any session)
- **Lines of code:** ~2000 across src/, mostly TypeScript
- **Open follow-ups deferred:** Capacitor wrap for iOS App Store (waiting on user's Apple Developer enrollment), Stripe wiring on pricing page, transcript export to .txt/.md, hardening of open RLS before public launch (the merge into Contextspaces auth solves this naturally).

Done. Pick up from here.
