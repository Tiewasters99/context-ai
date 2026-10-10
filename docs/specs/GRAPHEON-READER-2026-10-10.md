# The Grapheon Reader

**Date:** 10 October 2026, after the first clip was laid over a passage of *The Innocents Abroad*
**Owner:** Eden Quainton
**Status:** Design. Builds in parallel with the Contextspaces launch (15 October); nothing here is on the launch path.
**Entity:** Grapheon.ai, LLC (NJ) — the merchant and publisher of record, never Quainton Law and not Contextspaces.

## What it is

A reader app, like a Kindle, for **rich-media editions**: a book whose pages carry clips, stills and (later) narration where its plates and passages sit, made on the Workshop bench in Contextspaces. Three rooms:

| Room | What happens there |
|---|---|
| **Store** | Editions from the Grapheon library, and editions other people have published. Browse, sample, buy. |
| **My Library** | What the reader owns. Downloaded for reading offline. |
| **The Reader** | The page as in Contextspaces today: the text layer, highlights, a small badge after an illustrated passage, the clip in a panel that can be moved beside the words. |

Contextspaces keeps the *making* side (the Workshop, the Vault, the matter). The Grapheon Reader is the *publishing, selling and reading* side. The seam between them is one object, the **edition**: a package exported from a book and its 062 illustrations, which the reader app opens without any knowledge of matters, serverspaces or the Vault.

This is Phase E of the Workshop spec (`BOOK-WORKSHOP-2026-10-07.md`), made its own product.

## Why web-first

Kindle does not sell books inside its iOS app: Apple takes 30% of in-app digital sales and dictates the flow, so Amazon sells on the web and the app only reads. The same shape here: **buy on the web** (Stripe), **read anywhere** — a web app that installs to the phone's home screen (a PWA) with offline downloads. An App Store wrapper (Capacitor, the same move scoped for Contextspaces in `OPUS-HANDOFF-IOS-APP-2026-10-08.txt`) comes last, for discoverability, and reads only — App Store rule 3.1.3(b), "reader apps".

## What is already there

- The page: `src/pages/DocumentReader.tsx` renders a PDF through pdfjs `TextLayer`, with `AnnotationsOverlay` (highlights, 020/048), `AnimationLayer` (062 illustrations, the badge and the movable panel, #380), the selection guard (`src/lib/pdf-text-selection.ts`, #378), the highlight menu (#376). This is the Reader; it is 4,700 lines and knows about matters, Brief Desk panes, notes rails, cross-references and the Orchestrator.
- The bench: migration 106, `WorkshopPanel.tsx`, store-only media in the matter.
- Illustrations: migration 062 `document_animations` — `document_id`, `media_document_id`, `page`, `rect`, `turn`, `loops`, `label`.
- A standalone entry already exists: `reader.html` → `src/reader/ReadingRoom.tsx`, the Office's Reading Room (`/read/<item>`), text-only, signs nobody in, fed by `GET /api/office?book=`. It proves the pattern (its own Vite entry, a Vercel rewrite, one deploy) but renders flowing text, not the PDF page, so it cannot carry a rectangle.
- Payments: Stripe is live for Contextspaces subscriptions (`api/billing-*.mjs`, webhook, portal). **That account belongs to Contextspaces; the Reader needs Grapheon.ai LLC's own Stripe account** (D3 below).
- Covers: `captureJacket` in `src/lib/office-publish.ts` already makes a jacket image at publish time.

## The edition

An edition is a frozen snapshot, versioned; buyers get later versions free.

```
editions                      one row per edition
  id, slug, title, author, description, cover_path
  publisher_user_id             who published it (Grapheon's own user for the library)
  source_document_id            the Contextspaces document it was exported from (nullable: a straight upload)
  price_cents, currency         0 = free
  status                        draft | review | published | withdrawn
  rights                        'public_domain' | 'own' | 'licensed'  + rights_note (the attestation)
  version, published_at, created_at

edition_assets                one row per file in the package
  id, edition_id, kind          'book' (the PDF) | 'media' | 'cover'
  storage_path                  bucket `editions` (private); path <edition_id>/<version>/<file>
  bytes, sha256, mime

edition_illustrations         062 rows, snapshotted at publish
  id, edition_id, page, rect, turn, loops, label, asset_id → edition_assets

edition_purchases             ownership
  id, user_id, edition_id, stripe_session_id, amount_cents, currency, created_at, refunded_at

edition_marks                 the reader's own highlights and notes, per edition
  id, user_id, edition_id, page, rects, color, note, created_at
  (the document_annotations shape, without matters)

edition_progress              where they are
  user_id, edition_id, page, updated_at

publisher_accounts            payouts (Phase 4)
  user_id, stripe_connect_account_id, status, created_at
```

RLS: `editions` readable by anyone when `status = 'published'`, by the publisher always; `edition_assets` never readable directly — files are served by `api/editions.mjs` as short-lived signed URLs after an ownership check (free editions need sign-in but no purchase); `edition_marks`/`edition_progress` owner-only; `edition_purchases` owner-only, written only by the Stripe webhook (service role).

**Format:** PDF, as the Workshop works on it. Facsimile editions of public-domain books are the pitch and the rectangle is the unit of illustration. EPUB (reflowing, phone-friendly) is a later addition that would attach illustrations to text anchors instead of rectangles; the `document_annotations.text_anchor` work (#215) is the seed. Not in this spec.

## Publishing from the Workshop

A **Publish as edition** button on the bench (visible only to users in the Library serverspace, D5):

1. Export: copy the PDF and every media file laid on the page (062 rows for the document) into the `editions` bucket under a new version; snapshot the 062 rows into `edition_illustrations`; capture the jacket (`captureJacket`) for the cover.
2. Metadata: title and author from the document; description, price, rights attestation typed in a small form.
3. Status `draft` → **Publish** flips to `published`. Republishing makes version n+1; the store serves the latest, My Library offers the update.

A straight upload (Phase 4) is the same flow without a source document: upload a PDF, lay illustrations in a cut-down Workshop inside the reader app, publish.

## The reader app

Its own Vite entry, `edition.html` → `src/edition/`, deployed by the same Vercel project (as `reader.html` is) and reached at **read.grapheon.ai** by a host-based rewrite; Grapheon's own domain from day one so the address never says Contextspaces. One Supabase project, one sign-in (a Contextspaces account is a reader account; a reader account can stay a reader account), its own Terms and Privacy pages (D4).

Routes: `/` the Store, `/e/<slug>` an edition's page (sample pages, buy), `/library` My Library, `/read/<edition id>` the Reader.

The Reader reuses the page, not a copy of it. Phase 1's first task extracts the book part of `DocumentReader.tsx` into `src/components/reader/PdfBook.tsx`: the pdfjs pipeline, `ReaderStyle`, the text layer and selection guard, `AnnotationsOverlay` + the highlight menu + Undo, `AnimationLayer`, the page counter and the find box. `DocumentReader` then renders `PdfBook` with the matter parts (notes rail, cross-references, Brief Desk, Orchestrator context, Workshop) around it. "One copy. One Reader."

`PdfBook` takes its data through two small interfaces so it does not know where it is:
- a **source**: `{ openPdf(): Promise<PDFDocumentProxy>, illustrations: Illustration[], mediaUrl(assetId): Promise<string> }`
- a **marks store**: `{ list, create, update, remove }` — `document_annotations` in Contextspaces, `edition_marks` in the Reader.

Offline (Phase 3): a service worker caches the app shell; **Download** on an edition fetches the PDF and media into the Cache API keyed by edition and version, the manifest and marks into IndexedDB; marks sync up when online (last write wins — one reader, one device at a time is the common case).

Phone: the page fits the width, pinch to zoom, the clip panel opens full-width below the passage instead of beside it. Tested on the iPhone before any phase ships (the standing rule).

## Store and purchase (Phase 2)

- Store page: covers in a grid, Grapheon library first, then others; an edition page with the cover, description, a three-page sample (the first three pages rendered server-side as images, no PDF leaves), the price, **Buy** or **Read** (owned or free).
- Buy: Stripe Checkout (one-time payment) in Grapheon.ai LLC's account, `api/editions-checkout.mjs`; the webhook writes `edition_purchases`; return to the edition page, which now says **Read**.
- Refund: through the Stripe dashboard; the webhook sets `refunded_at` and the Reader stops serving the files.
- Pricing is the publisher's; Grapheon library editions are priced by Eden.

## Creator publishing (Phase 4)

Anyone with an account can publish. The shape is the Workshop's, so the work is mostly policy:

- **Rights attestation** on publish: public domain (with the edition year), their own work, or licensed (with the licensor named). Stored on the edition; shown on its page.
- **Takedown**: a `report` link on every edition page to a Grapheon address; `withdrawn` status pulls it from the store and the files from new readers (owners keep what they bought, unless the claim is upheld — Eden's call, written into the Terms).
- **Payouts**: Stripe Connect Express. The publisher onboards once (Stripe collects identity and tax forms and files 1099s); each sale splits at checkout — publisher share and Grapheon's cut (D6) — by `transfer_data`. No money is held by Grapheon.
- **Invitation first**: `publisher_accounts` rows are created by Eden for the first publishers; open sign-up for publishers when the policy has been tested.
- Generated media: follows the commercial-use terms of the plan it was made on (the Workshop spec's rule); the attestation covers it.

## Phases

| Phase | Ships | Sessions |
|---|---|---|
| **1** | `PdfBook` extracted and used by `DocumentReader` (no visible change); `editions` + `edition_assets` + `edition_illustrations` + `edition_marks` + `edition_progress` (migration); **Publish as edition** on the bench; `edition.html` with My Library (editions the signed-in user published) and the Reader. Eden reads *Innocents Abroad* with its clip at read.grapheon.ai. | 4–6 |
| **2** | The Store, edition pages with samples, Stripe Checkout in Grapheon's account, `edition_purchases`, the webhook, Read-after-buy. A second account buys *Innocents Abroad*. | 3–4 |
| **3** | PWA: installable, offline downloads, progress and marks sync. Read on the phone in airplane mode. | 2–3 |
| **4** | Creator publishing: upload without a source document, the cut-down bench, rights attestation, takedown, Stripe Connect payouts. | 4–5 |
| **5** | App Store / Play wrappers (reader-only). | 2 + review time |

Phase 1 can start now. It touches `DocumentReader.tsx` (the extraction) — coordinate with any session working in the Reader that week, and land the extraction as its own PR before anything else.

## Decisions for Eden

- **D1 Name and address.** "Grapheon Reader" at read.grapheon.ai, or a name of its own? The address needs a DNS record on grapheon.ai pointing at Vercel (one trip; memo on request).
- **D2 Format.** PDF-only for Phases 1–4 (recommended); EPUB later.
- **D3 Stripe.** A Grapheon.ai LLC Stripe account, separate from Contextspaces'. Needs the LLC's EIN and a bank account; Eden creates it, pastes keys into `.env` placeholders (the standing API-key rule).
- **D4 Terms and Privacy** for the Reader, separate from Contextspaces' (the `/terms` work in hand for the launch can be the template). Needed before Phase 2 takes money.
- **D5 Who publishes in Phase 1.** Only the Library serverspace (Eden's own editions), recommended; opened in Phase 4.
- **D6 Grapheon's cut** on third-party sales (Phase 4). Kindle Direct is 30% or 70% depending on price band; Gumroad 10% + fees. A flat 20% is a reasonable opening position.
- **D7 Reading Room.** Does the Office's free Reading Room keep showing text-only copies of books that now have paid editions, or does a shelf book link to its edition in the store? Recommended: both — the Reading Room is the sample.

## Not in this spec

- Narration (Workshop Phase C) — it belongs in editions as an `audio` asset with timing data, once it exists.
- In-app generation (Workshop Phase D).
- DRM beyond signed URLs and account-bound downloads. A determined buyer can keep the PDF; Kindle's DRM is broken daily and the Grapheon library's texts are public domain — the value is the edition, not the lock.
- Social features, reviews, ratings.
- Subscriptions ("all you can read"). One-time purchases only, until there are enough editions to make a subscription worth more than a book.
