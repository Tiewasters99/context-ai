# The Workshop beside a book

**Date:** 7 October 2026
**Owner:** Eden Quainton
**Status:** Design for decision. Nothing here is built.

## What it is

A book in the Library serverspace opens in the Reader with empty space on either side of the page. The Workshop uses that space: a panel beside the page where you bring in a picture or a clip you made elsewhere, or make one here, and pin it to the book at the page you are on. A pinned picture or clip is a **plate** (the word for an illustration bound into a printed book). Plates travel with the book: in the Reader they sit in the margin at their page; when the book is filed to the Office Library, they go with it, and the Reading Room shows the book with its plates, moving where a plate is a clip.

The panel is hidden by default. One control on the Reader's toolbar shows it; the choice is remembered on that device. A person who only wants to read never sees it.

## Where the material comes from

Two sources, in this order of importance:

1. **Import.** Drop or choose a file: an image or a clip from Google Flow, Midjourney, Astra, Runway, Kling, a phone. This is where the Flow credits and the current TikTok workflow are, and it costs nothing new. Flow's and Midjourney's credits cannot be spent through an API, so import is the only way those two reach the book.
2. **Generate.** A prompt box with the open page's text (or the selection) pre-filled, a provider picker, the cost shown before the call, and the result landing in the panel as a plate to keep or discard. First providers: **GPT (gpt-image)** for stills, **Runway** for clips, because Astra already proves Runway suits the work. Each is an adapter (`lib/gen-image-openai.mjs`, `lib/gen-video-runway.mjs`); Kling and Google Veo are later adapters behind the same picker. Clip generation is asynchronous (a task that is polled); the panel shows it working and keeps the page usable.

A plate made from an imported file is identical to a generated one once it is in the book: the provider is a label on the plate, not a different kind of thing. (The Studio / Film Builder brief of 27 September makes the same rule for takes; the adapters here should be the ones the Studio uses.)

## Where plates live

| | |
|---|---|
| Table | `book_plates`: id, document_id, matterspace_id, page, kind (`image` \| `video`), storage_path, thumb_path, width, height, duration_sec, prompt, provider, source (`import` \| `generated`), caption, sort_order, created_by, created_at. RLS as `documents` (matter membership). |
| Originals | A private bucket, `book-plates`, under the matter's path (`<matter>/<document>/<plate>.<ext>`), checked by `lib/storage-path.mjs` like every other object. |
| Public copies | Only when the book is on an Office shelf: the plate's file is copied into the public `cover-images` bucket the Office already uses for jackets and page images (`office_items/<item>/plates/<plate>.<ext>`), and `api/office?book=` lists them. Taking a book off the shelf removes the copies. The Reading Room stays one-way glass: it never sees the private bucket. |

Limits: images up to 25 MB, clips up to 200 MB and 60 s for v1. A clip is stored as uploaded; playback in the Reader and the Reading Room uses the browser's own player.

## What the person sees

**Reader, panel hidden (default).** A small bookmark-and-image icon on the toolbar, lit when the book has plates. Plates for the current page show as a thin strip in the margin: a thumbnail per plate; click opens it full size, a clip plays in place.

**Reader, panel shown.** The panel takes the outer margin (the side with more room; right by default). Top: *Bring in* (drop zone / choose file) and *Make* (prompt, provider, cost, Go). Below: the plates pinned at this page, each with caption, provider label, "move to page", delete. Drag a plate from the panel onto a page to re-pin it.

**Office Library / Reading Room.** Between pages, where a plate is pinned, the plate: an image at the page's width, a clip with controls, muted autoplay off. The book's card on the shelf shows the first plate as a second face of the jacket when the person chooses it.

## What is deliberately not in v1

- No editing of images (crop, inpaint). Bring the edited file back in instead.
- No audio, no music, no multi-clip sequencing — that is the Studio's job.
- No plates on documents outside the Library serverspace. The matter-work Reader is unchanged.
- No public plates without filing: a plate is private until the book is on a shelf.

## Build order

| Phase | Ships | Size |
|---|---|---|
| A | Table + private bucket + migration; panel with **import only**; plates in the Reader margin and full-size view. | 1 PR, the largest |
| B | Plates travel with filing: public copies, `api/office` serves them, the Reading Room renders them. | 1 PR |
| C | **Make an image** (GPT) with the page text pre-filled; cost line. | 1 PR |
| D | **Make a clip** (Runway), asynchronous. | 1 PR, needs a Runway API key in `.env` (placeholder first) |
| E | Kling / Veo adapters; the Studio uses the same adapters. | later |

A is useful on its own with the Flow and Midjourney material already being made.

## Decisions for Eden

1. **Plates per page or per book?** This design pins each plate to a page (so a clip for chapter 3 sits at chapter 3). The alternative — one gallery for the whole book — is simpler but loses the "illustrated edition" feel.
2. **The Reading Room.** Showing clips there makes the public page heavier; fine for a few plates, not for dozens. Cap at 12 plates per book in the Reading Room, or no cap?
3. **Runway key.** Phase D needs one; the placeholder goes into `.env` first, then you paste it there (never in chat).
4. **Which side.** Right margin by default; or follow the Reader's sidebar (page thumbnails) so the two never share a side?
