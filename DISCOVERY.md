# Knowledge Map — Phase 0 Discovery

*2026-07-30 · precedes migration 042 and the `/app/map` build. The build spec
("Chart Reimagined") was written stack-agnostic; this file records how it maps
onto the actual codebase and which parts were adapted, with Eden's sign-off.*

## Stack (spec assumed Next.js — it isn't)

Vite 8 + React 19 SPA, react-router-dom 7, Tailwind 4, TanStack Query 5.
Deployed on Vercel; `/api/*.mjs` serverless functions; everything else rewrites
to `index.html`. Auth is Supabase; the authenticated landing is `/app` →
`Dashboard` (`src/App.tsx`). The SPA talks to Supabase directly with the user's
JWT and lets Postgres RLS filter — there is deliberately no app-side ACL logic.

## Data model

- One self-referencing table, `public.matterspaces` (no separate `matters`).
  `short_code` is globally unique but **nullable** → map URLs are
  `/app/map/{short_code || id}`.
- Every row carries a denormalized `serverspace_id` (trigger-enforced,
  migration 008) so RLS never walks the tree.
- No rolled-up document counts anywhere; the map RPC computes them.

## Adaptations from the spec (all confirmed by Eden 2026-07-30)

1. **`matter_events` name collision.** Migration 025 already owns that name —
   it is the per-matter *calendar*. The spec's append-only ledger log is
   therefore named **`matter_state_events`**.
2. **Deadlines are derived, not duplicated.** `next_deadline` lives in the
   calendar (`matter_events`: earliest future, uncompleted). The ledger keeps
   only `status` / `headline` / `next_action` as manual fields. Deadline edits
   from the map write calendar rows, so the map, the Calendar tab, and the
   Dashboard widget can never disagree.
3. **Ingest events are NOT instrumented in app code.** Six independent code
   paths insert into `documents` (web vault, MCP `file_document`, Fly worker,
   two CLI scripts, ad-hoc scripts). Instead of six emission points (or a
   trigger), the existing `activity_feed` view (migration 024) already unions
   ingests + content + comments + cite-checks + meetings + calendar — always
   consistent by construction, history included. **Heat reads from the view.**
   `matter_state_events` records only what no source table shows: state edits,
   `deadline_passed`, `briefing_run`, `note`, and the reserved `time_note`.
4. **No cron yet.** There is no scheduling infrastructure (no Vercel crons, no
   pg_cron, the Fly worker is a job-queue poller). "Overdue" is computed at
   read time by the map RPC; the `deadline_passed` *event row* is deferred
   until the Briefing Engine needs it, at which point pg_cron in Supabase is
   the natural home (`matter_state_events` already accepts the type).
5. **Rollout without a flag system.** The app has no feature flags. The map
   ships at `/app/map` (+ a link on the Dashboard and a mobile tab); the
   post-login default flips to it once Eden has lived with it.
6. **Serverspaces are the top level** of the map (the "continents"); matters
   nest inside. The owner-only **Chats serverspace (~576 conversation
   sub-matters) renders collapsed and dimmed** — one quiet circle, diving into
   it goes to the serverspace view instead of exploding 576 leaves.

## RLS pattern (non-negotiable house rule)

New per-matter tables use the **SECURITY INVOKER plpgsql wrapper** pattern from
migrations 022/025 (`_matter_state_access` mirrors `_matter_events_access`),
never bare SECURITY DEFINER helpers in policies — see 022's header for the
`.insert().select()` failure it prevents. All map/ledger reads go through
invoker functions, so co-counsel see exactly their slice of the map for free.

## Encodings (as agreed; resist adding more)

- **Radius** = `log2(doc_count + 2)`, summed up the tree by `d3.pack`.
- **Fill temperature** = activity decay, half-life 7 days, over
  `max(occurred_at)` from `activity_feed`. Ramp runs the CVD-safe blue→gold
  axis (`#333c52 → #e8b84a`), lightness-monotonic, landing on the house gold.
  The dim cool end is deliberate (dormant matters recede); names are always
  labeled, so color never carries identity.
- **Pull** = one ring treatment per node, never more: slow pulse for a
  deadline within 7 days, steady heavier ring for overdue.

## Where things live

| Piece | Path |
|---|---|
| Ledger + RPCs | `supabase/migrations/042_matter_state_ledger.sql` (applied by hand, Supabase SQL editor) |
| Map data hook | `src/hooks/useMatterMap.ts` (RPC `get_matter_map`) |
| Pure model (hierarchy/heat/pull/color) | `src/lib/map-model.ts` |
| The map | `src/pages/KnowledgeMap.tsx` → routes `/app/map`, `/app/map/:code` |
| MCP tools | `get_matter_state` / `set_matter_state` in `lib/mcp-core.mjs` |
| Briefing stub | `api/briefing-delta.mjs`, reachable as `GET /api/briefing/delta?since=…` |
