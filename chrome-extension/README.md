# Contextspaces Chrome Extension

Sideload-first MVP that adds an **Attach from Contextspaces** button to Gmail compose. When you pick a Vault document, the extension pushes it to your Google Drive's `Contextspaces` folder and shows a toast pointing you at Gmail's Drive-attach button to finish inserting it. (Direct DOM-injection of a binary attachment into Gmail compose is fragile across UI updates; the Drive bridge is the durable path.)

## Prerequisites

- A Contextspaces account at https://www.contextspaces.ai
- Google Drive connected on `/app/connections` (the extension reuses the same Drive integration the in-app export button uses)
- A `csp_*` token — generate one at https://www.contextspaces.ai/app/connections/claude (same token format Claude Desktop uses)

## Sideload

1. Open Chrome → `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked**
4. Select the `chrome-extension/` directory in this repo
5. Pin the Contextspaces icon to your toolbar
6. Click the icon → paste your `csp_*` token → **Save token**

## Use

1. Open Gmail (`mail.google.com`)
2. Start a new email — the **Contextspaces** button appears next to Send
3. Click it → pick a matter → pick a document
4. The extension pushes the file to your Drive's `Contextspaces` folder
5. Click Gmail's **Drive icon** in the compose toolbar → the file is in your `Contextspaces` folder, ready to insert

## What's coming

This extension is the foundation for three planned surfaces:

- **Snip-to-Contextspaces** — capture a Google Books page and ingest into a matter
- **Save-attachment-to-matter** — save a Gmail message's attachment into a matter
- **Save-any-page** — drop a web page into a matter as a saved PDF/HTML

All three share the same auth, picker, and backend skeleton this MVP builds.

## Architecture notes

- `manifest.json` — Manifest V3, content script scoped to `mail.google.com`
- `background.js` — service worker, owns API calls and token storage
- `popup/` — extension toolbar popup (paste token, sign out)
- `content/gmail.js` — observes Gmail's compose dialogs, injects the button
- `picker/` — iframe modal for matter + document selection
- Server endpoints used:
  - `GET /api/ext/matters`
  - `GET /api/ext/documents?matter=<uuid>`
  - `POST /api/ext/push-to-drive` (body `{ documentId }`) — reuses the existing `/api/drive-export` Google Drive pipeline with `csp_*` auth instead of Supabase session
