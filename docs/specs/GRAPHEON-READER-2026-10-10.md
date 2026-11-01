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

**The bridge (PR #416, Library reader, 2026-10-13).** A Shirt button on a snip card or a still's row sets the picture out in the public `cover-images` bucket under the reader's own folder and opens the old designer on it in a new tab. Library serverspace books only; matter material never reaches a public bucket. The same one-line prop (`merch={mine}`) goes on the Reader's Read route when #413 lands. The bridge stayed until 2b replaced it and was removed with part 2 on 2026-10-14 (D12: one store); `src/lib/grapheon-merch.ts` keeps only the upload half, which the sheet uses.

**2b, in the Reader.** The sale happens where the picture is. (Build order: part 1, 2026-10-13, the backend — `lib/printify.mjs`, migration 117, `api/merch.mjs`, `api/grapheon-webhook.mjs`, harness; part 2, 2026-10-14, `MerchSheet.tsx` beside the page with the orders view, `src/lib/merch-sheet.ts` for its arithmetic, the bridge button removed. Grapheon.ai LLC's live Stripe keys went in the same night.) No configurator port — the Reader's own sheet:

- **The product sheet.** From a snip, a still, or an edition illustration on the bench: *Tee or tote* opens a sheet beside the page — the picture, three or four products (unisex tee, tote, an art print; a mug if the picture is wide), the colour and size the buyer picks, the mockup when Printify has drawn it (3–10 s; the sheet polls), the price, **Buy**. Placement: centred on the print area, scaled to fit, with a "fill" toggle. No free drag in 2b.
- **Making the product.** `api/merch.mjs` (one door: bearer → the reader's rights checked as the user → service role for Printify): `products` (the curated blueprints with the chosen provider, from `merch_blueprints`, so Eden can change them without a deploy), `make` (the picture to Printify by `file_url` from the reader's own `cover-images/<uid>/prints/` folder, the one the bench writes; `createPrintifyProduct`; the variants priced from the cost Printify reports on the made product — cost is not in the catalog), `mockups` (poll), `checkout`, `order`, `orders`. Shipping in 2b is a flat rate per product and region offered as Stripe `shipping_options` (Printify's `calculateShippingCost` sets the rate table; the buyer's address is only known inside Checkout, so no per-address quote before it). A country pick in the sheet, with a live quote, is a later refinement.
- **Paying.** Stripe Checkout in **Grapheon.ai LLC's account (D3)**, one-time payment, `shipping_address_collection` on (US first; then the countries the provider ships to), Stripe Tax on; metadata = `merch_product_id`, `variant_id`, `quantity`. The webhook (`api/grapheon-webhook.mjs`, one endpoint for Grapheon's account dispatching on `metadata.kind`; signature checked) on `checkout.session.completed`: write `merch_orders`, `createPrintifyOrder` with the session's shipping address and the line item, `submitOrderToProduction`, store the Printify order id. Printify bills Grapheon's card per order; the margin is the difference. Refunds through the Stripe dashboard; the webhook cancels the Printify order if it has not gone to production.
- **Status.** *My orders* in the Reader: placed → in production → shipped (tracking from `getOrderStatus`, polled; Printify's own webhooks later). An email on shipment through Resend.
- **Rights.** A public-domain plate from the book: anyone may make it. A reader's own still brought in: the reader may. A **publisher's illustration** in a bought edition is in copyright and is **not offered in 2b at all**. It becomes available only when two things are true together: the publisher has turned merch on for the edition (`editions.merch_allowed`, default false), and a merch agreement between the publisher and Grapheon.ai LLC is on file that fixes the publisher's share and how it is paid (the switch cannot be turned on without the agreement; the agreement is the licence). Grapheon never keeps the whole margin on someone else's work — that is the rule, not a Phase 4 detail. Paying the share out needs Stripe Connect, so the publisher path ships with Phase 4; until then `merch_allowed` stays false and the edition page says merch of the publisher's illustrations is not yet offered. The rights attestation on publish covers the publisher's own illustrations.
- **Tables.** `merch_blueprints` (curated: blueprint id, provider id, label, base cents, positions), `merch_products` (owner, edition or Library document, bench item, blueprint, Printify product id and image id, variant ids, mockup URLs, price cents, created), `merch_orders` (buyer, product, variant, quantity, Stripe session id, Printify order id, status, amounts, timestamps; the address stays in Stripe and Printify, not here). RLS: owners read their products; buyers read their orders; the service role writes from the webhook. Invoker wrappers as always.
- **Port list** from `grapheon-ai`: `lib/printify.ts` → `lib/printify.mjs` near-verbatim (ESM, no Next; config injectable for the harness). **Not ported:** the 1,197-line configurator, `lib/marketplace.ts` (local storage, `ME_ID`, bids, wishlist), `lib/orders.ts`, the `bakeCreation.ts` overlays (text on the picture — maybe later), the test-mode Stripe route. Env: `PRINTIFY_API_TOKEN`, `PRINTIFY_SHOP_ID`, `GRAPHEON_STRIPE_SECRET_KEY`, `GRAPHEON_STRIPE_WEBHOOK_SECRET` (never Contextspaces' `STRIPE_*`), `MERCH_SEND_TO_PRODUCTION` (0 = orders wait on hold), `GRAPHEON_STRIPE_TAX` (placeholders first, the standing rule) — reuse "Reading Wizard" or make a shop named for the Reader (D10).
- **Phone.** The sheet is full-width below the page; Buy is Stripe's own page, which already works on the phone.
- **Test.** A real tote from the page-29 plate of *Through the Russian Revolution*, bought with a real card in live mode, delivered — the acceptance test. Before that: Stripe test mode, and Printify orders created but **not** sent to production (an order waits on hold until `send_to_production`; it can be cancelled there, so the whole loop runs without a print).

Sessions: 3–4, after Phase 2's checkout exists (it shares the Stripe account, the webhook plumbing and the Terms).

**Decisions (2b) — taken 2026-10-13.** **D8** Products: tee, tote, print to start. **D9** Margin: Printify base cost + a flat 40%, rounded to .99; shipping shown as its own flat line (US first). **D10** Shop: keep "Reading Wizard" (25109380). **D11** Publisher illustrations: off by default; on only with the publisher's switch *and* an executed merch agreement with Grapheon.ai LLC that fixes the publisher's share — rights protection is built into enabling, so no publisher's plate is ever sold with Grapheon taking the whole margin (Eden: "They'll never want to put their work up for use with Grapheon taking the margin"). **D12** One store: the Reader's sheet. The Contextspaces Library reader's bridge button is removed when 2b ships.

## The Library membership (Phase 2S) — the Reader and the Library, $9.99 a month

*Added 2026-10-28. Eden: "I'd like to offer a bundled package of Grapheon Reader and my Library, updated daily with cleaned, curated daily additions." Price $9.99 a month, cancel any time; browse for free; the membership is needed to read a whole book, to keep books on the device, and to read everything in the Library.*

**Why now.** This spec excluded subscriptions "until there are enough editions to make a subscription worth more than a book." The Library serverspace in Contextspaces held 376 cleaned public-domain PDFs on 2026-10-28 (History 91, Law 88, Literature 100, Science 97; 301 with a chosen cover), and Eden adds to it in batches of 15–70 every few days. That is the trigger. Phase 2S puts the Library in the Store behind one recurring price. Phase 2's per-edition **Buy** survives for editions other people publish (Phase 4); it is no longer needed to sell the Library.

**What is sold.** One membership, "Grapheon Reader + Library": every Library edition, read in full, in the Reader, on any signed-in device, with offline copies once Phase 3 ships; new books as they are released; the Workshop on any Library book for the member's own copy (as D5 already allows). Editions published by other people are not in the membership (D15). Merchandise (2b) is unchanged: anyone, member or not, may order a print of a public-domain plate.

### Browsing for free — the sample wall

Kindle's rule: anyone can read into a book, then the book stops. The same here, with the page as the unit.

- **The sample is a PDF, not a set of pictures.** At publish (and at every *Publish update*), the server cuts the first N pages of the book into a second PDF with `pdf-lib` (already a dependency) and stores it as `edition_assets.kind = 'sample'` in a **public** bucket `edition-samples/<edition id>/<version>.pdf`, cacheable at the edge. Nothing else about an edition becomes public. The three-page server-rendered images in Phase 2 are replaced by this; the Store card still shows the cover and description.
- **N** = 10% of the book's pages, floor 8, ceiling 30 (D13). A 220-page novel samples 22 pages; a 60-page pamphlet samples 8.
- **The Reader opens the sample as it opens any book** — `PdfBook` with a `PdfSource` pointed at the sample file, no marks store, no bench. "One copy. One Reader." When the reader reaches the last sample page, a card stands where the next page would be: the book's title, the page count, *Continue with a Grapheon Reader + Library membership — $9.99 a month, cancel any time*, **Join**, and *Already a member? Sign in*. Find, zoom and the illustrations laid within the sampled pages all work; a clip laid beyond page N is not in the sample.
- **No sign-in to browse.** The Store, an edition's page and its sample are open to anyone, as Kindle's *Look Inside* is (D13). Sign-in happens at **Join**.

### What the membership gates

Three things, stated plainly because a web app cannot gate its own installation:

1. **Reading past the sample** of any Library edition. `api/editions.mjs` `book` and `sign` answer for a Library edition only when `_edition_can_read` says yes, and for a Library edition that now means *member* (below).
2. **Download** (Phase 3): keeping a book on the device for offline reading. Members only. The downloaded manifest carries `current_period_end`; opening a downloaded book offline is allowed until that date plus three days of grace (D16), after which the Reader asks for a connection to confirm the membership. Marks made offline sync up as before.
3. **The whole Library**, including each day's release. Non-members see every book in the Store and may sample every one.

The Reader app itself (the PWA at read.grapheon.ai, installed to a phone's home screen or not) is open to everyone — it has to be, for the sample to work. "Download the Reader" in the pitch means: install it, join, and the books come with you.

### Entitlement — the one thing that must be right

Today `_edition_can_read` returns true for any signed-in user when `status = 'published' and price_cents = 0`. Library editions must **not** be created at price 0 and called gated; they would be free. The migration adds an explicit access mode and routes it through a membership check:

```
editions
  + access      text not null default 'paid'  check (access in ('free', 'paid', 'library'))
                existing rows: 'free' where price_cents = 0, else 'paid'
  + collection_key text, volume smallint        -- "Leaves of Grass" vol 2 of 2 (metadata, below)
  + release_on  date                             -- the release queue (below)

reader_subscriptions          one row per member
  user_id                     pk → auth.users
  stripe_customer_id          text not null
  stripe_subscription_id      text not null unique
  status                      text not null      -- Stripe's own: incomplete | trialing | active | past_due | canceled | unpaid
  current_period_end          timestamptz not null
  cancel_at_period_end        boolean not null default false
  price_id                    text not null      -- the price consented to
  consent_session_id          text               -- Stripe Checkout Session id = the proof of consent
  consented_at                timestamptz
  created_at, updated_at

_reader_is_member(p_user uuid) returns boolean   security invoker, plpgsql
  status in ('active', 'trialing') and current_period_end > now()
  or status = 'past_due' and current_period_end + interval '7 days' > now()      -- D16 grace

_edition_can_read(p_edition)   new clause, before the purchases check:
  if access = 'library' then return status = 'published' and _reader_is_member(auth.uid());
  -- a withdrawn Library book leaves the Library for members too (the Terms say so); purchases are the only thing that survive withdrawal
  the price_cents = 0 clause applies only when access = 'free'.
```

RLS: `reader_subscriptions` readable by its owner (so the app can show *Member until 24 Nov*), written only by the Stripe webhook (service role). Invoker wrappers as always. `api/editions.mjs` keeps answering AS THE USER, so the gate is one function in one place.

**As built (migration 126, 2026-10-29) — two refinements on the safe side.** (1) For an edition that is *not* in the Library, `access` **follows the price** through a trigger (0 → `free`, more → `paid`, on insert and on every change of `price_cents`), because the Reader's publish dialog says "0 is free" and creates drafts without an access value; a fixed default of `paid` would have made every new $0 edition unreadable. A Library edition is never derived. (2) Only the **service role** may set `access = 'library'`: 112's update policy lets a publisher change any column of their own row, and without the guard a third-party publisher could place their book inside the membership (D15). The mirror script runs with the service role. Harness: `scripts/_verify-reader-membership-126.mjs`.

**Lapse** (D16): when a membership ends — cancelled at period end, or a failed renewal past the grace — `_reader_is_member` turns false and the Reader stops serving Library books and refuses new downloads. `edition_marks` and `edition_progress` are kept, untouched; a member who returns finds every highlight where it was. Nothing is deleted on lapse.

### Paying — Grapheon's Stripe account (D3), recurring

- **One product, one price**: *Grapheon Reader + Library*, $9.99 a month, recurring, in Grapheon.ai LLC's Stripe account (the merch account). Env `READER_PRICE_ID`. No annual price in 2S (D14).
- **Join** → `api/reader-subscribe.mjs` (bearer → the user's email → Stripe Checkout Session `mode = 'subscription'`, `line_items = [{ price: READER_PRICE_ID, quantity: 1 }]`, `customer_email` or the existing `stripe_customer_id`, `metadata.kind = 'reader_subscription'` on the Session **and** `subscription_data.metadata.kind = 'reader_subscription'` so every later subscription event carries it, `consent_collection.terms_of_service = 'required'` (needs the Terms URL in the Stripe account's public details — T12), `automatic_tax` on when D20 says so, `success_url = /library?joined=1`, `cancel_url` = the edition page the reader came from).
- **Manage membership** in the Reader's account menu → `api/reader-portal.mjs` → a Stripe Customer Portal session (a portal configuration in Grapheon's account: cancel **at period end**, update the card, see invoices; no plan switching). This is the online cancellation NY GBL § 527-a requires of an offer accepted online, and the "click to quit" California's law requires; it costs no code beyond the session call.
- **The webhook** `api/grapheon-webhook.mjs` grows a second kind. Today it dispatches `kind = 'merch'` on `checkout.session.completed`, `checkout.session.expired` and `charge.refunded`. It adds, for `kind = 'reader_subscription'`: `checkout.session.completed` (write `consent_session_id`, `consented_at`, then fetch the subscription and upsert), `customer.subscription.created | updated | deleted` (upsert `status`, `current_period_end`, `cancel_at_period_end`, `price_id` from the object — order-independent, the object is the truth, as `billing-webhook.mjs` does), `invoice.payment_failed` (status comes through the subscription object; the event is logged and triggers the failed-renewal email). The endpoint's event list in the Stripe dashboard must be widened to match. Unknown kinds remain a 200.
- **Refunds**: none for a membership month except where law requires or the price-increase rule applies (Terms T13); through the Stripe dashboard when they happen. A refund does not change entitlement; cancellation does.
- **Receipts** come from Stripe (enable customer emails for successful payments in the account). The Reader sends its own mail (below) for what Stripe does not say.

### The Library in the Store — mirroring 376 books

`scripts/library-to-editions.mjs` (service role, run from the clean clone, idempotent, keyed by `editions.source_document_id`), and then the same code as the nightly `release` job's first step, so a book Eden files into the Library appears in the queue the next morning without a click:

1. **Read** every `ready` PDF document in the Library serverspace `c7117b5e-…` not yet mirrored.
2. **Parse the filename** — the grammar Eden already uses is the contract (D18): `Title - Cleaned.pdf`, `Title - Cleaned, Vol II.pdf`, `Title Vol I - Cleaned, Part 2.pdf`. Strip ` - Cleaned`; `Vol`/`Part` tokens become `collection_key` (the title without them) and `volume` (roman or arabic, in order; a Vol with Parts counts Parts within the Vol). The Store shows a collection as **one card** — "Leaves of Grass · 2 volumes" — opening to its volumes in order.
3. **Author** (D18): from the PDF's own metadata when it names one; otherwise from `library-authors.csv` in the repo, which the script writes once with every title and an empty author column for Eden to fill — 2 of 376 documents carry an author today, and a store browses by author.
4. **Create the edition**: `publisher_user_id` = Eden's account (D19), `access = 'library'`, `rights = 'public_domain'`, `rights_note` = the source and the cleaning, `price_cents = 0` (unused under `library`), `status = 'draft'`, `cover_path` from the document's `cover_url` (copied into the `editions` bucket as a `cover` asset; a book with no chosen cover — 75 today — gets `captureJacket`'s page one, and shows a chosen cover the day Eden picks one in Contextspaces and the nightly mirror notices the change).
5. **Copy the book** server-side (`copy_book`'s storage `/object/copy` path, nothing through a browser), **cut the sample**, record both assets.
6. **Queue** it: `release_on` = the next free day (below).

Storage: the Library's PDFs are copied, not linked — the Reader never reads from a matter. Expect the `editions` bucket to roughly equal the Library's size (the `documents` table has no size column; measure the bucket after the first run).

### The release queue — "updated daily" as a promise the system keeps

Eden's additions arrive in bursts (15 on 10-27, 69 on 10-21, 71 on 10-16). A daily cadence should not depend on him uploading daily.

- **Launch**: the first 376 are published together (one `publish_edition` each) the day the Store opens — a store with eight books is not a library.
- **After launch**: new mirrored editions enter the queue; the `release` job publishes up to **3 a day** (D17) in `created_at` order, oldest first, skipping none; a batch of 69 feeds 23 days. Eden may set `release_on` by hand to hold or hurry a book. A volume set releases together.
- **"New this week"**: a shelf at the top of the Store (editions with `published_at` in the last 7 days), and the digest email.

**Jobs** — the repo's first Vercel crons (`vercel.json` has none today; three daily-or-better schedules need the team's Pro plan — Hobby allows two crons, once a day): `api/reader-cron.mjs?job=…`, called by Vercel with `Authorization: Bearer ${CRON_SECRET}`, refusing anything else.

| job | when | does |
|---|---|---|
| `release` | daily 06:00 ET | mirror new Library books into the queue; publish up to 3 whose `release_on` ≤ today |
| `digest` | Mondays 08:00 ET | "New this week" email to members (and to non-members who asked for it) |
| `reminders` | daily | the yearly membership reminder (price, frequency, how to cancel) to each member on their anniversary — California's law; sent to everyone, since one rule is cheaper than fifty |

### Mail — Resend, from read@grapheon.ai (T9)

Service mail, each with the member's membership facts and an unsubscribe for anything that is not about their account: **welcome** (what the membership is, renews monthly, how to cancel — the acknowledgment NY § 527-a wants the consumer to be able to keep), **renewal failed** (we will retry; access pauses after 7 days), **cancelled** (reads until the period end, marks kept), **price change** (30 days ahead; see Terms), **yearly reminder**, **weekly digest**. Templates in `lib/reader-mail.mjs`; the domain grapheon.ai is already verified with Resend (Quorium).

### Metadata, covers and the Office

- **Titles** are shown cleaned; the filename stays in `rights_note` for provenance.
- **The Reading Room** (`/read/<item>`, text-only, fed by `api/office?book=`) today serves the whole text of any book on an Office shelf, free. With a paid Library that is a free copy of the same book. D7 is revised: the Reading Room serves the **same first N pages** as the sample, ending in the same card, with a link to the edition at read.grapheon.ai. `api/office.mjs` learns a `limit` from the mirrored edition's sample length (two items on the shelves today; no migration pain).
- **Contextspaces' Library** is untouched: it stays Eden's private serverspace, the Vault list and The Office keep their cover thumbnails (#473), and filing a book to the Office keeps working.

### What 2S does not do

- No annual plan, no family plan, no trial (D14; a trial is a free-to-pay conversion with its own disclosure rules — later, if ever).
- No bundling of third-party editions (D15).
- No DRM beyond the signed URL and the entitlement check, as before.
- No in-app purchase on iOS or Android (Phase 5 wrappers read only; the membership is bought on the web — Apple rule 3.1.3(b)).

### Build order and sessions

1. Land #413 (or re-cut it on current main) — the Reader has to exist. Eden: `publisher_accounts` row, D1 DNS.
2. Migration: `access`, `collection_key`, `volume`, `release_on`, `reader_subscriptions`, `_reader_is_member`, the new `_edition_can_read` clause; PGlite harness (the `_verify-editions-migration.mjs` pattern). **Eden applies.**
3. `scripts/library-to-editions.mjs` + the sample cutter + `library-authors.csv`; dry run, then the real run into drafts (nothing published yet).
4. `api/reader-subscribe.mjs`, `api/reader-portal.mjs`, the webhook branch, harness; Eden creates the product/price and the portal configuration in Grapheon's Stripe account and pastes `READER_PRICE_ID`.
5. The Store: grid by shelf, collections, "New this week", edition page, the sample in the Reader with the wall card, Join, Manage membership, *Member until* in the account menu.
6. `api/reader-cron.mjs` + `vercel.json` crons + `lib/reader-mail.mjs`; Reading Room limit.
7. Terms and Privacy pages with the membership section (T13–T18) published before Join is enabled; `consent_collection` on.
8. Launch day: publish the 376; Eden joins with a real card as the first member; cancel-at-period-end checked end to end.

Four to five sessions after #413 lands. Nothing here touches Contextspaces' billing, tables or Stripe account.

### Compliance notes for the build (verified 2026-10-28, scope stated)

- **ROSCA** (federal) is in force: clear disclosure of the material terms before the charge, express informed consent, a simple cancellation mechanism. The checkout page states the price and renewal; the consent checkbox and the portal satisfy the rest.
- **The FTC's 2024 "click-to-cancel" amendments were vacated** by the Eighth Circuit on 2025-07-08 (*Custom Communications v. FTC*, procedural grounds); the FTC issued an Advance Notice of Proposed Rulemaking on 2026-03-11 to start over. Build to the vacated rule's shape anyway (cancel as easily as you joined); it costs nothing and it is where the agency is heading.
- **New York GBL § 527-a**: online acceptance → online cancellation; acknowledgment the consumer can keep; a price increase needs fresh consent, or a 14-day cancel after the charge with a pro-rata refund. Pending bills would let a website link satisfy the cancellation mechanism; not confirmed enacted.
- **California Bus. & Prof. Code § 17600 et seq.** as amended by AB 2863 (effective 2025-07-01): express affirmative consent; proof of consent kept three years or one year after termination, whichever is longer (hence `consent_session_id`); a yearly reminder naming the product, the charge and how to cancel; cancellation in the channel used to join. Law-firm summaries, not the statute, were read; check the codified text before launch.
- **New Jersey**: the 2023 law is narrow (service contracts for property, one-year terms); S2062 (introduced 2026-01-13) would add a general auto-renewal law with a same-medium cancellation rule; status not confirmed.
- **Sales tax** (D20, Terms T6): a subscription to digital books is taxable in some states, including possibly New Jersey. Stripe Tax decides per address once the account is registered where it must be; the recommendation is on from the first charge.

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
| **2S** | The Library membership: `access` + `reader_subscriptions` migration, the Library mirrored into editions (376 at launch) with cleaned titles, authors and volume sets, the sample PDF and its wall card, Join (Stripe Checkout, subscription, Grapheon's account) and Manage membership (Customer Portal), the webhook's subscription kind, the release queue and crons, the mails, the Reading Room limit, the membership Terms. Eden joins with a real card; a cancellation runs to period end. **After #413 lands.** | 4–5 |
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
- **D7 Reading Room.** Does the Office's free Reading Room keep showing text-only copies of books that now have paid editions, or does a shelf book link to its edition in the store? Recommended: both — the Reading Room is the sample. **Revised 2026-10-28 (Phase 2S):** the Reading Room serves the same first N pages as the edition's sample and ends in the same card; a full free text would undercut the membership.

**Phase 2S decisions (2026-10-28).** Decided by Eden already: $9.99 a month, cancel any time, browse free, the membership gates full reading, downloads and the whole Library.

- **D13 The sample.** 10% of the book's pages, floor 8, ceiling 30; open to anyone without sign-in (Kindle's *Look Inside*). Alternative: a fixed 10 pages for every book; or sign-in required to sample (costs browsers, gains emails).
- **D14 One price.** Monthly only in 2S. An annual price (say $79.99) and a free trial are each a later decision with their own disclosure rules; neither is needed to open.
- **D15 Third-party editions** stay one-time purchases outside the membership until Phase 4's publisher agreement says how a pool would be shared (never the whole margin on someone else's work).
- **D16 Grace.** A failed renewal keeps access 7 days while Stripe retries; a downloaded book opens offline until `current_period_end` + 3 days. Marks and progress are never deleted on lapse.
- **D17 Release cadence.** 3 a day from the queue, oldest first; volume sets together; the digest on Mondays. Alternative: 1 a day (a 69-book batch then lasts ten weeks).
- **D18 Metadata.** The filename grammar (`Title - Cleaned, Vol II.pdf`) is the parser's contract; authors from PDF metadata, else `library-authors.csv` that Eden fills once (2 of 376 have an author today). Alternative: I propose authors for the 376 in the CSV and Eden checks them.
- **D19 Publisher of record** for Library editions: Eden's own account, shown in the Store as "Grapheon Library".
- **D20 Sales tax** on the membership: Stripe Tax on from the first charge (ties to Terms T6). Alternative: off until the first registration threshold is reached, accepting the exposure.

## Not in this spec

- Narration (Workshop Phase C) — it belongs in editions as an `audio` asset with timing data, once it exists.
- In-app generation (Workshop Phase D).
- DRM beyond signed URLs and account-bound downloads. A determined buyer can keep the PDF; Kindle's DRM is broken daily and the Grapheon library's texts are public domain — the value is the edition, not the lock.
- Social features, reviews, ratings.
- ~~Subscriptions ("all you can read")~~ — **superseded 2026-10-28** by *The Library membership (Phase 2S)*: the Library passed the "enough editions" bar at 376. Third-party editions remain one-time purchases (D15).
