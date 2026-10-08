# The Workshop beside a book

**Date:** 7 October 2026, revised 8 October after Eden's Beagle example and the discovery of migration 062
**Owner:** Eden Quainton
**Status:** Phase A built (PR pending). B–E are design.

## What it is

A book in the Library serverspace opens in the Reader. The Workshop is a bench beside the page: snip a plate off the page (or keep a passage of text), take it away to make something from it (a clip in Google Flow, a still in Midjourney), bring the result back, and lay the two side by side before deciding whether the book should carry it. If it should, one click lays the result on the page where the plate sits; a reader taps the plate and it plays. The book is otherwise unchanged.

The bench is hidden by default: a **Workshop** tab in the Reader's existing left sidebar, which is itself closed until the sidebar button is pressed. A person who only wants to read never sees it.

## What was already there

Migration 062, "living illustrations": a clip (an ordinary document filed in the same matter) attached to a rectangle on one page, with the quarter turn that makes a sideways plate upright; tapping the plate plays the clip. One is attached today, the dragonfly plate in *Literature*. The Workshop is the bench that feeds 062; 062 is the decision made.

## The bench (Phase A, built)

| Item | What it is |
|---|---|
| **Snip** | A rectangle drawn on the page, plus a quarter turn. A recipe, not pixels: re-rendered from the PDF each time it is shown or downloaded. *Rotate* is one more quarter turn; *crop* is drawing the rectangle again; *resize* is the download size (1×, 2×, 3×). |
| **Snippet** | A passage of the page's text (paste, or *Use selection*). For the law-student case: the paragraph a clip should illustrate. |
| **Brought in** | A clip or a still from Flow, Midjourney, Astra, Runway or a phone, filed in the matter as a document **stored without a transcript** (no Gemini call), shown under the snip or snippet it was made from. |
| **Lay on page** | The media item laid where its plate sits, upright per the snip's turn: a 062 row. A still is shown where a clip would play. |

Table `document_workshop_items` (migration 106): `page`, `kind` (snip / snippet / media), `rect`, `turn`, `text`, `media_document_id`, `parent_id`. RLS as 062: author or matter access, and a media item must point at a file the author can reach.

The store-only path (`/api/ingest` with `storeOnly: true`) accepts media and image files only and marks the row with the reason; nothing is read, quoted, metered or sent to the worker.

## Phases

| Phase | Ships |
|---|---|
| **A** | The bench as above. *Built.* |
| **B** | The book carries its illustrations into the Office Library and the Reading Room: public copies of laid-on media for a book on a shelf, served by `api/office?book=`, shown between pages. The Reading Room stays one-way glass (it never sees the private bucket). |
| **C** | Narration: an ElevenLabs voice per book, one audio file per chapter, Play audio, page sync from the timing data. |
| **D** | Generate inside the app: GPT for stills, Runway for clips, as adapters behind one picker, cost shown first. An open model on our own box (see the Princeton Compute note) is a later adapter on the same picker. |
| **E** | Paid editions: a storefront on the Stripe setup, a purchase, a reader that checks it. Separate from the free Reading Room. |

## Not in A

- No retouching beyond crop, rotate and size.
- No plates on documents outside a matter (the bench needs a matter to file into).
- No public exposure: a brought-in file is private to the matter until Phase B.
- The Vault's upload path is unchanged; only the Workshop uses store-only.

## Decided

- Per page: every item on the bench belongs to a page, and laying on the page uses the snip's own rectangle.
- Left side, as a sidebar tab, so it shares the one toggle the Reader already has.
- Rights: PD text and plates are clean; generated media follows the commercial-use terms of the plan it was made on.
