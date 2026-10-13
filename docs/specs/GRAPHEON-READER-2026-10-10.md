# The Grapheon Reader

**Date:** 10 October 2026, after the first clip was laid over a passage of *The Innocents Abroad*
**Owner:** Eden Quainton
**Status:** Design. Builds in parallel with the Contextspaces launch (15 October); nothing here is on the launch path.
**Entity:** Grapheon.ai, LLC (NJ) — the merchant and publisher of record, never Quainton Law and not Contextspaces.

## What it is

A reader app, like a Kindle, for **rich-media editions**: a book whose pages carry clips, stills and (later) narration where its plates and passages sit. A niche product for bibliophiles — and for a bibliophile the making is the point, so the app has its own Workshop. Four rooms:

| Room | What happens there |
|---|---|
| **Store** | Editions from the Grapheon library, and editions other people have published. Browse, sample, buy. |
| **My Library** | What the reader owns, and what they are making. Downloaded for reading offline. |
| **The Reader** | The page as in Contextspaces today: the text layer, highlights, a small badge after an illustrated passage, the clip in a panel that can be moved beside the words. |
| **The Workshop** | The bench beside the page, as in Contextspaces today: snip a plate or keep a passage, take it to Flow or Midjourney, bring the result back, lay it on the page. Take a book from the Grapheon library or upload a PDF, illustrate it, read it, publish it. |

The whole loop lives in the Reader; nobody needs a Contextspaces account to make an edition. Contextspaces keeps its own Workshop for books filed in matters (the law-student case), and the two run the same bench code (`WorkshopPanel`, `AnimationLayer`, the page) against different stores. The object both sides make is the **edition**: a book, its media, and where each piece sits — which the reader app opens and sells without any knowledge of matters, serverspaces or the Vault. A one-way bridge from Contextspaces ("Publish as edition" from a matter's bench) is a later convenience, not the foundation.

This is Phase E of the Workshop spec (`BOOK-WORKSHOP-2026-10-07.md`), made its own product, with the bench inside it.

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

An edition is the working object and the sold object: a draft while its maker benches it, a frozen version once published; buyers get later versions free.

```
editions                      one row per edition
  id, slug, title, author, description, cover_path
  publisher_user_id             who is making / published it (Grapheon's own user for the library)
  source_document_id            the Contextspaces document it was bridged from (nullable; usually null)
  price_cents, currency         0 = free
  status                        draft | review | published | withdrawn
  rights                        'public_domain' | 'own' | 'licensed'  + rights_note (the attestation)
  version, published_at, created_at

edition_assets                one row per file
  id, edition_id, kind          'book' (the PDF) | 'media' | 'cover'
  storage_path                  bucket `editions` (private); path <edition_id>/<file>
  bytes, sha256, mime
  version_from                  the version this file first shipped in (publishing freezes, it never copies)

edition_bench_items           the Workshop bench: migration 106's shape, keyed by edition
  id, edition_id, page, kind (snip | snippet | media), rect, turn, text, asset_id, parent_id, label, sort_order

edition_illustrations         what is laid on the page: 062's shape, keyed by edition; edited live on a draft,
  id, edition_id, page, rect, turn, loops, label, asset_id → edition_assets, version_from
                              a published version serves the rows with version_from <= version

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

RLS: `editions` readable by anyone when `status = 'published'`, by the publisher always; `edition_bench_items` and draft-state `edition_illustrations` publisher-only; `edition_assets` never readable directly — files are served by `api/editions.mjs` as short-lived signed URLs after an ownership check (free editions need sign-in but no purchase); `edition_marks`/`edition_progress` owner-only; `edition_purchases` owner-only, written only by the Stripe webhook (service role).

**Format:** PDF, as the Workshop works on it. Facsimile editions of public-domain books are the pitch and the rectangle is the unit of illustration. EPUB (reflowing, phone-friendly) is a later addition that would attach illustrations to text anchors instead of rectangles; the `document_annotations.text_anchor` work (#215) is the seed. Not in this spec.

## The Workshop in the Reader

**New edition** in My Library: pick a book from the Grapheon library (a PD text already in the `editions` bucket, copied as the new edition's `book` asset) or upload a PDF. The draft opens in the Reader with the bench beside the page — the same `WorkshopPanel` and `AnimationLayer` as Contextspaces, against `edition_bench_items` / `edition_illustrations` / `edition_assets` instead of 106 / 062 / the Vault. Snip, keep a passage, download at 1–3×, bring the result back (an upload straight to the `editions` bucket; nothing is transcribed or metered), lay it on the page, read it back. The maker reads their own draft exactly as a buyer will.

**Publish**: title and author (from the PDF's metadata when it has any), description, price, rights attestation; the jacket captured from page 1 (`captureJacket`). Status `draft` → `published` at version 1. Editing continues on the draft underneath; **Publish update** freezes version n+1 — the store serves the latest, My Library offers the update to owners. Nothing is copied at publish time: assets and illustrations carry the version they first shipped in.

**The bridge from Contextspaces** (later, optional): "Publish as edition" on a matter's bench copies that document's PDF, its 062 rows and their media into a new draft edition owned by the same user, who then finishes it in the Reader. Only the Library serverspace sees the button (D5).

## The reader app

Its own Vite entry, `edition.html` → `src/edition/`, deployed by the same Vercel project (as `reader.html` is) and reached at **read.grapheon.ai** by a host-based rewrite; Grapheon's own domain from day one so the address never says Contextspaces. One Supabase project, one sign-in (a Contextspaces account is a reader account; a reader account can stay a reader account), its own Terms and Privacy pages (D4).

Routes: `/` the Store, `/e/<slug>` an edition's page (sample pages, buy), `/library` My Library (owned and in the making), `/read/<edition id>` the Reader — with the bench when the edition is the reader's own draft.

The Reader reuses the page and the bench, not copies of them. Phase 1's first task extracts the book part of `DocumentReader.tsx` into `src/components/reader/PdfBook.tsx`: the pdfjs pipeline, `ReaderStyle`, the text layer and selection guard, `AnnotationsOverlay` + the highlight menu + Undo, `AnimationLayer`, the page counter, the find box, the sidebar with its Workshop tab and the toolbar's Workshop button. `DocumentReader` then renders `PdfBook` with the matter parts (notes rail, cross-references, Brief Desk, Orchestrator context, filing) around it. "One copy. One Reader."

`PdfBook` takes its data through three small interfaces so it does not know where it is:
- a **source**: `{ openPdf(): Promise<PDFDocumentProxy>, illustrations: Illustration[], mediaUrl(assetId): Promise<string> }`
- a **marks store**: `{ list, create, update, remove }` — `document_annotations` in Contextspaces, `edition_marks` in the Reader.
- a **bench store** (null for a book the reader cannot edit): `{ list, createSnip, createSnippet, bringIn(file), update, remove, lay(media, source) }` — 106 / 062 / store-only ingest in Contextspaces, `edition_bench_items` / `edition_illustrations` / the `editions` bucket in the Reader. `WorkshopPanel` already speaks to the page only through props; this is those props given a home.

Offline (Phase 3): a service worker caches the app shell; **Download** on an edition fetches the PDF and media into the Cache API keyed by edition and version, the manifest and marks into IndexedDB; marks sync up when online (last write wins — one reader, one device at a time is the common case).

Phone: the page fits the width, pinch to zoom, the clip panel opens full-width below the passage instead of beside it. Tested on the iPhone before any phase ships (the standing rule).

## Store and purchase (Phase 2)

- Store page: covers in a grid, Grapheon library first, then others; an edition page with the cover, description, a three-page sample (the first three pages rendered server-side as images, no PDF leaves), the price, **Buy** or **Read** (owned or free).
- Buy: Stripe Checkout (one-time payment) in Grapheon.ai LLC's account, `api/editions-checkout.mjs`; the webhook writes `edition_purchases`; return to the edition page, which now says **Read**.
- Refund: through the Stripe dashboard; the webhook sets `refunded_at` and the Reader stops serving the files.
- Pricing is the publisher's; Grapheon library editions are priced by Eden.

## Merchandise (Phase 2b) — a picture from the bench on a tee, a tote, a print

Eden, 2026-10-13: "connect the book to a Printify store so that the user could turn PD work, either his or her own derivative work, or work from the book itself, into salable products."

**What is there already.** The old Grapheon site (`grapheon-ai` repo) has a Printify integration from the Amin era: `lib/printify.ts` (526 lines, plain `fetch`, typed, retries — reusable as it stands), a live t-shirt designer at `grapheon.ai/marketplace/customize` that takes `?imageUrl=&title=`, puts the picture on a blueprint with a live overlay and makes the Printify product with mockups, and a Printify shop, **"Reading Wizard" (id 25109380)**, with its token on that deployment. What stops it being a store: the marketplace listing and the order live in the browser's local storage with a placeholder owner, Stripe there is in test mode, and the Stripe webhook never places the Printify order. It demonstrates a product; it does not sell one.

**The bridge (PR #416, Library reader, 2026-10-13).** A Shirt button on a snip card or a still's row sets the picture out in the public `cover-images` bucket under the reader's own folder and opens the old designer on it in a new tab. Library serverspace books only; matter material never reaches a public bucket. The same one-line prop (`merch={mine}`) goes on the Reader's Read route when #413 lands. The bridge stays until 2b replaces it.

**2b, in the Reader.** The sale happens where the picture is. No configurator port — the Reader's own sheet:

- **The product sheet.** From a snip, a still, or an edition illustration on the bench: *Tee or tote* opens a sheet beside the page — the picture, three or four products (unisex tee, tote, an art print; a mug if the picture is wide), the colour and size the buyer picks, the mockup when Printify has drawn it (3–10 s; the sheet polls), the price, **Buy**. Placement: centred on the print area, scaled to fit, with a "fill" toggle. No free drag in 2b.
- **Making the product.** `api/merch.mjs` (one door: bearer → the reader's rights checked as the user → service role for Printify): `products` (the curated blueprints with the chosen provider, from a small table so Eden can change them without a deploy), `make` (the image to Printify by `file_url` from a signed URL of the editions bucket, or as bytes for a snip drawn in the browser; `createPrintifyProduct`; returns the product and mockups), `mockups` (poll), `checkout`, `order`. Shipping in 2b is a flat rate per product and region offered as Stripe `shipping_options` (Printify's `calculateShippingCost` sets the rate table; the buyer's address is only known inside Checkout, so no per-address quote before it). A country pick in the sheet, with a live quote, is a later refinement.
- **Paying.** Stripe Checkout in **Grapheon.ai LLC's account (D3)**, one-time payment, `shipping_address_collection` on (US first; then the countries the provider ships to), Stripe Tax on; metadata = `merch_product_id`, `variant_id`, `quantity`. The webhook (`api/merch-webhook.mjs`, signature checked) on `checkout.session.completed`: write `merch_orders`, `createPrintifyOrder` with the session's shipping address and the line item, `submitOrderToProduction`, store the Printify order id. Printify bills Grapheon's card per order; the margin is the difference. Refunds through the Stripe dashboard; the webhook cancels the Printify order if it has not gone to production.
- **Status.** *My orders* in the Reader: placed → in production → shipped (tracking from `getOrderStatus`, polled; Printify's own webhooks later). An email on shipment through Resend.
- **Rights.** A public-domain plate from the book: anyone may make it. A reader's own still brought in: the reader may. A **publisher's illustration** in a bought edition: only with the publisher's leave — `editions.merch_allowed` (default false), shown on the edition page; the publisher's share of merch margin is a Phase 4 (Stripe Connect) question, not 2b. The rights attestation on publish covers merch of the publisher's own illustrations.
- **Tables.** `merch_blueprints` (curated: blueprint id, provider id, label, base cents, positions), `merch_products` (owner, edition or Library document, bench item, blueprint, Printify product id and image id, variant ids, mockup URLs, price cents, created), `merch_orders` (buyer, product, variant, quantity, Stripe session id, Printify order id, status, amounts, timestamps; the address stays in Stripe and Printify, not here). RLS: owners read their products; buyers read their orders; the service role writes from the webhook. Invoker wrappers as always.
- **Port list** from `grapheon-ai`: `lib/printify.ts` → `api/_lib/printify.mjs` near-verbatim (ESM, no Next). **Not ported:** the 1,197-line configurator, `lib/marketplace.ts` (local storage, `ME_ID`, bids, wishlist), `lib/orders.ts`, the `bakeCreation.ts` overlays (text on the picture — maybe later), the test-mode Stripe route. Env: `PRINTIFY_API_TOKEN`, `PRINTIFY_SHOP_ID` (placeholders first, the standing rule) — reuse "Reading Wizard" or make a shop named for the Reader (D10).
- **Phone.** The sheet is full-width below the page; Buy is Stripe's own page, which already works on the phone.
- **Test.** A real tote from the page-29 plate of *Through the Russian Revolution*, bought with a real card in live mode, delivered — the acceptance test. Before that: Stripe test mode, and Printify orders created but **not** sent to production (an order waits on hold until `send_to_production`; it can be cancelled there, so the whole loop runs without a print).

Sessions: 3–4, after Phase 2's checkout exists (it shares the Stripe account, the webhook plumbing and the Terms).

**Decisions for Eden (2b).** **D8** Products: tee + tote + print to start? **D9** Margin and shipping: Printify base cost + a flat 40%, rounded to .99, with shipping shown as its own flat line (US, then others)? **D10** Shop: keep "Reading Wizard" or a new shop under the LLC's Printify account? **D11** Illustrations: `merch_allowed` off by default, the publisher turns it on? **D12** Does the Contextspaces Library reader keep the bridge button, or send to the Reader's sheet once 2b exists (recommended: the Reader; one store)?

## Creator publishing (Phase 4)

Anyone with an account can publish. The bench is already in the app from Phase 1, so the work is policy and payouts:

- **Rights attestation** on publish: public domain (with the edition year), their own work, or licensed (with the licensor named). Stored on the edition; shown on its page.
- **Takedown**: a `report` link on every edition page to a Grapheon address; `withdrawn` status pulls it from the store and the files from new readers (owners keep what they bought, unless the claim is upheld — Eden's call, written into the Terms).
- **Payouts**: Stripe Connect Express. The publisher onboards once (Stripe collects identity and tax forms and files 1099s); each sale splits at checkout — publisher share and Grapheon's cut (D6) — by `transfer_data`. No money is held by Grapheon.
- **Invitation first**: `publisher_accounts` rows are created by Eden for the first publishers; open sign-up for publishers when the policy has been tested.
- Generated media: follows the commercial-use terms of the plan it was made on (the Workshop spec's rule); the attestation covers it.

## Phases

| Phase | Ships | Sessions |
|---|---|---|
| **1** | `PdfBook` extracted and used by `DocumentReader` (no visible change — its own PR first); the `editions` tables and bucket (migration); `edition.html` at read.grapheon.ai with sign-in, My Library, **New edition** (library pick or upload), the Reader with the bench on a draft, **Publish** to version 1. Eden uploads *Innocents Abroad*, benches it in the Reader, lays the Flow clip, reads it back at read.grapheon.ai. | 5–7 |
| **2** | The Store, edition pages with samples, Stripe Checkout in Grapheon's account, `edition_purchases`, the webhook, Read-after-buy, **Publish update**. A second account buys *Innocents Abroad*. | 3–4 |
| **2b** | Merchandise: the product sheet, `api/merch.mjs` with the ported Printify client, `merch_*` tables, Stripe Checkout with shipping and tax, the webhook that places and submits the Printify order, My orders. A real tote arrives. | 3–4 |
| **3** | PWA: installable, offline downloads, progress and marks sync. Read on the phone in airplane mode. | 2–3 |
| **4** | Creator publishing opened: rights attestation enforced, takedown, Stripe Connect payouts, publisher invitations. | 3–4 |
| **5** | App Store / Play wrappers (reader-only); the bridge from a Contextspaces matter, if wanted. | 2 + review time |

Phase 1 can start now, in parallel with the launch. It touches `DocumentReader.tsx` (the extraction) — coordinate with any session working in the Reader that week, and land the extraction as its own PR before anything else.

## Decisions for Eden

- **D1 Name and address.** "Grapheon Reader" at read.grapheon.ai, or a name of its own? The address needs a DNS record on grapheon.ai pointing at Vercel (one trip; memo on request).
- **D2 Format.** PDF-only for Phases 1–4 (recommended); EPUB later.
- **D3 Stripe.** A Grapheon.ai LLC Stripe account, separate from Contextspaces'. Needs the LLC's EIN and a bank account; Eden creates it, pastes keys into `.env` placeholders (the standing API-key rule).
- **D4 Terms and Privacy** for the Reader, separate from Contextspaces' (the `/terms` work in hand for the launch can be the template). Needed before Phase 2 takes money.
- **D5 Who makes editions in Phases 1–3.** Everyone can bench a book for themselves from Phase 1 (a reader illustrating their own copy is the product); **publishing to the Store** is Eden's account only until Phase 4 opens it. The Contextspaces bridge button, if built, shows only in the Library serverspace.
- **D6 Grapheon's cut** on third-party sales (Phase 4). Kindle Direct is 30% or 70% depending on price band; Gumroad 10% + fees. A flat 20% is a reasonable opening position.
- **D7 Reading Room.** Does the Office's free Reading Room keep showing text-only copies of books that now have paid editions, or does a shelf book link to its edition in the store? Recommended: both — the Reading Room is the sample.

## Not in this spec

- Narration (Workshop Phase C) — it belongs in editions as an `audio` asset with timing data, once it exists.
- In-app generation (Workshop Phase D).
- DRM beyond signed URLs and account-bound downloads. A determined buyer can keep the PDF; Kindle's DRM is broken daily and the Grapheon library's texts are public domain — the value is the edition, not the lock.
- Social features, reviews, ratings.
- Subscriptions ("all you can read"). One-time purchases only, until there are enough editions to make a subscription worth more than a book.
