# Contextspaces — Polish Spec + Positioning (Fable pass, 2026-07-05)

**Status:** Document only. No code written, no branches created, `main` untouched. This file is
untracked; commit or discard as you see fit. Prepared for Opus review.

**Method:** Read-only walk of `C:\Users\equai\context-ai` on branch `feat/av-ocr-ingest-sliders`
(tip `87e087b`, 2026-07-06) compared against production `main` (tip `310e21a`, 2026-06-17).
Every claim below was verified against the actual files cited.

---

## 0. The headline fact

**Production is three weeks behind the code.** `feat/av-ocr-ingest-sliders` is **35 commits
ahead of `main`**, and those commits are the product: mobile support, OCR + A/V transcription
on web upload, the in-app assistant (answer + cite, streaming), zip upload, MCP `grep` and
`file_document` tools, Google Drive export, the Chrome extension backend, inline rename,
sub-matter creation everywhere. Users at contextspaces.ai are using the June 17 build.
Most items below are already fixed on this branch — they just aren't shipped.

---

## 1. Ranked polish punch-list

Ranked by impact ÷ effort. "Ship" items are merge-and-deploy; "Fix" items are new (small) work.

| # | Item | Impact | Effort | Where |
|---|------|--------|--------|-------|
| 1 | **Ship the branch.** Merge `feat/av-ocr-ingest-sliders` → `main`, deploy. Delivers items marked ⬆ below for free. | Massive | ~½ day review | whole branch |
| 2 | **Gate for #1: flip `DEV_BYPASS_AUTH` back to `false`.** On this branch it is `true` (`src/App.tsx:34`, "TODO: Remove this bypass"); `main` correctly has `false`. Merging as-is would remove the login gate from production. | Critical | 1 line | `src/App.tsx:34` |
| 3 | **Settings 404.** Settings is linked in 3 places (`src/components/layout/Sidebar.tsx:283`, `:474`, Dashboard gear) but no `/app/settings` route exists — every click lands on `NotFound`, whose heading is near-black on the dark shell (`src/pages/NotFound.tsx:6`) so it looks like a blank crash. Either add a minimal settings page or remove the links; fix the NotFound color either way. | High | 2–4 h | `src/App.tsx` routes, `Sidebar.tsx`, `NotFound.tsx` |
| 4 | **Wire the orphaned ExportMenu.** `src/components/reader/ExportMenu.tsx` is fully built (connector-driven Export/Share, gmail-send, Drive) but has **zero imports**. Swap it in for the two inline buttons at `src/pages/DocumentReader.tsx:908-925`, per its own header comment. | High | ½ day | `DocumentReader.tsx` |
| 5 | **Dead "Create Serverspace" on first run.** The Dashboard quick action navigates to `path: '#'` (`src/pages/Dashboard.tsx:17`, rendered `:263-275`), and the zero-state text "No serverspaces yet. Create one to get started." (`:168`) has no link. A brand-new user's only real affordance is a small `+` in the sidebar. Make both open the New Serverspace modal. | High (first-run) | 1–2 h | `Dashboard.tsx` |
| 6 | **Silent data loss in the Vault.** (a) Zip import: skipped/truncated entries only `console.warn` (`src/pages/Vault.tsx:260-261`); (b) failed drag-move logs and leaves the optimistic UI looking successful (`:195`); (c) **failed delete still removes the row** — user believes a document is deleted when it isn't (`:348-351`). Surface all three with the banner pattern already used in `DocumentReader.tsx:936-963`. | High (trust) | ½ day | `Vault.tsx` |
| 7 | **Rewrite the landing hero.** Current copy is generic productivity-speak: "Your workspace, simplified. / The productivity platform that gets out of your way…" (`src/pages/Landing.tsx:96-103`). Nothing signals legal, matters, or citations. Replace with the positioning in §3. Also: footer About/Contact/Privacy/Terms are all `href="#"` (`:225-233`) — for a product asking lawyers to upload client files, dead Privacy/Terms links are a credibility hole. | High (conversion) | 2–3 h, copy only | `Landing.tsx` |
| 8 | **Failed ingests are invisible.** No component in `src/` references a failed document status; recovery exists only as a CLI script (`scripts/reprocess-failed…`). A doc that fails ingest just never becomes searchable — the user can't see it failed or retry. Add an "Error" state in the Vault file list with a Retry button hitting the existing reprocess path. | High (trust) | ~1 day | Vault list + existing ingest plumbing |
| 9 | **Fake notification dot / dead top-bar buttons.** Header Search and Bell have no `onClick`, and the Bell shows a permanent gold unread dot (`src/components/layout/MainLayout.tsx:81-88`). Remove until real. | Med | &lt;1 h | `MainLayout.tsx` |
| 10 | **Three dead Vault menu items + contradictory storage numbers.** "Bring Your Own Key", "Storage", "Vault Settings" (`Vault.tsx:33-42`) have no handler in `renderContent()` (`:526-588`) — they highlight, then silently show Home. Storage copy says "up to 100GB" (`:40`), the footer hardcodes "0 / 5 GB (Free)" that never updates (`:820-823`), Landing says 5 GB (`Landing.tsx:12`). Hide the dead items; pick one number. | Med | 2–3 h | `Vault.tsx`, `Landing.tsx` |
| 11 | **Mobile parity for the two core screens.** ⬆ The branch's mobile pass covered Dashboard/Reader/Vault/etc., but `MatterspaceView.tsx:190` and `ServerspaceView.tsx:117` still hardcode desktop card padding, grab cursors, and `select-none` with no `isMobile` branch. Mirror Dashboard's treatment. | Med | ~1 h each | `MatterspaceView.tsx`, `ServerspaceView.tsx` |
| 12 | **"Coming soon" occupies a primary mobile tab.** Document Builder is an explicit stub (`src/pages/DocumentBuilder.tsx:6-9`, "Coming soon" pill `:32`) yet has a sidebar entry and a bottom-tab slot ("Docs"). Hide it from nav until real — a thumb-nav tab that dead-ends is worse than a missing feature. | Med | &lt;1 h | `DocumentBuilder.tsx`, `MobileTabBar` |
| 13 | **One `alert()` and text-only loaders.** `src/components/layout/CoverImage.tsx:295` uses a native `alert()`; several screens show bare "Loading…" text instead of the existing `Spinner`. Align on the app's banner/spinner patterns. | Low | 1–2 h | `CoverImage.tsx` + grep "Loading" |
| 14 | **Sidebar assistant highlight desyncs.** `Sidebar.tsx` tracks its own `aiAssistantEnabled` (`:62`, `:449`) separate from `MainLayout`'s real `assistantOpen`; closing the panel via its X leaves the sidebar item lit. Lift the state. | Low | 1–2 h | `Sidebar.tsx`, `MainLayout.tsx` |
| 15 | **Label-level naming pass.** UI stacks Contextspace / Serverspace / Matterspace / Clientspace, and uses "matter" and "matterspace" interchangeably in labels. Don't rename the architecture — just standardize user-facing labels on **Matter** (and keep "Serverspace" only where the tier is the point). | Low–Med | copy pass | grep UI strings |

Explicitly **not** in scope (bigger than polish, already tracked elsewhere): shared ingestion
worker, Skills feature build, .eml parser (no `.eml` ingestion exists anywhere in `api/` —
only `gmail-send.mjs` touches rfc822, for sending), nested pages, OnlyOffice editing.

---

## 2. The single biggest adoption/conversion blocker

**The deploy gap (item #1).** The sharpest symptom: a litigator's first real upload is almost
always a **scanned PDF** — a filed exhibit, a produced document. On production `main`, the web
ingest endpoint has no OCR, so that first upload "succeeds" and then returns nothing searchable.
The product fails its first five minutes for exactly its target user, and the fix has been
written and committed for weeks (`b027e8e`, `87e087b` — OCR is additive and key-gated in
`api/ingest.mjs:107-140`). Mobile support and the in-app assistant are similarly finished and
invisible.

**Fix (one batched trip, ~half a day):**
1. On the branch: flip `DEV_BYPASS_AUTH` → `false` (`src/App.tsx:34`).
2. Merge `feat/av-ocr-ingest-sliders` → `main` (Opus review; no refactors needed — it's a
   fast-forward-style history of small commits).
3. One Vercel dashboard trip: confirm `GOOGLE_API_KEY` is set in production env (OCR + A/V
   silently no-op without it), then deploy.
4. Same trip, Supabase dashboard: finish the pending auth **redirect-URL** config from the
   go-live checklist — if signup emails redirect wrong, no polish matters because new users
   can't get in at all. Worth verifying with one fresh-email signup after deploy.

Runner-up (if the gap were already closed): the first-run dead end — items #5 + #7. A new
user sees an empty dashboard whose only create button does nothing, reached from a landing
page that never says the product is for lawyers.

---

## 3. Positioning

**For solo and small-firm litigators drowning in case documents, Contextspaces is the
matter-native AI workspace: every document lives in exactly one matter — isolation is a hard
architectural contract, not a folder convention — everything you upload (including scanned
PDFs, depositions, and recordings) becomes searchable with page:line citations you can put in
a brief, and any AI you already use (Claude, Gemini, Grok) connects to your matters rather
than your matters being pasted into a chatbot.** It beats document management incumbents
(iManage, NetDocuments) because it's self-serve, AI-native, and priced for a firm of one
instead of an IT procurement cycle; it beats the "upload PDFs to ChatGPT" workflow because
that commingles clients, forgets everything, and can't cite to a page and line — the two
things a lawyer's ethics and a judge's patience actually demand; and it beats generic
workspaces (Notion, Drive) because they don't know what a matter, a deposition, or a
privilege call is. The wedge is the first scanned exhibit: upload it, ask a question, get an
answer with a citation you can check — value that stands on its own with no AI subscription
required, and compounds when you plug your model in.

**Copy direction for the landing hero (replaces "Your workspace, simplified"):**
> **Every case file, one question away.**
> Contextspaces turns your matter documents — even scanned exhibits and depositions — into
> answers with page:line citations. Your clients stay separated. Your AI plugs in. Built by a
> litigator.

---

*Prepared by Fable, 2026-07-05 brief. Working tree was left untouched apart from this file.*
