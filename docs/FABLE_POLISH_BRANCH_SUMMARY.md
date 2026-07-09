# Branch `fable/polish-2026-07-05` — merged to main 2026-07-09

Originally 12 polish commits based on `feat/av-ocr-ingest-sliders`. Rebased onto live
`main` (6a6ad5f) after a parallel session shipped the ingest backlog to production.
Nine commits survived the rebase; three were dropped, each for a reason worth knowing:

- **Auth gate commit** — dropped as already upstream (main already has `DEV_BYPASS_AUTH=false`).
- **ExportMenu wiring** — SKIPPED: main lacks `ExportMenu.tsx`, `lib/export-connectors.ts`,
  and `api/gmail-send.mjs` (the export baseline 3a3880f was never cherry-picked). Wire it
  when that lands — the wiring commit exists on `fable/polish-backup-pre-rebase` (4a517ca).
- **Mobile parity for Matterspace/ServerspaceView** — DROPPED: live main has NO mobile
  support at all (feature-branch commit bd1008a "Make Contextspaces work on mobile" was
  never cherry-picked; `useIsMobile`, the drawer, and MobileTabBar don't exist on main).
  **Shipping bd1008a is the biggest remaining piece of the backlog.**

## What shipped (9 commits)

1. Real `/app/settings` page (account, sign out, Connections) — sidebar links no longer 404;
   readable 404 page.
2. Working Dashboard "Create Serverspace" via shared `NewServerspaceModal`; Document
   Builder stub removed from sidebar nav.
3. Top bar: dead Search/Bell buttons (fake unread dot) removed.
4. Vault: dead BYOK/Storage/Settings menu items and hardcoded "0 / 5 GB" meter removed.
5. CoverImage: inline error instead of native `alert()`.
6. Vault: zip skips/truncation, failed moves, failed deletes surface a dismissible notice;
   failed delete keeps the row.
7. Landing: "Every case file, one question away." hero + litigator subhead; dead footer
   links removed (Privacy/Terms pages need Eden-authored content).
8. Sidebar assistant highlight follows real panel state.

## Still open

- Cherry-pick mobile support (bd1008a) to main, then re-apply the dropped mobile-parity
  commit (on `fable/polish-backup-pre-rebase`, 8731268).
- Export baseline (3a3880f + gmail-send) → then the ExportMenu wiring commit.
- Vercel `GOOGLE_API_KEY` in Production env (gates OCR/A-V that is already deployed);
  Supabase redirect URLs (gates signup). Verify with a fresh-email signup + scanned-PDF upload.
