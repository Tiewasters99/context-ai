# The Courtroom — Exhibits from the Matter & Argument by Voice

**Build spec · 2026-08-11 · branch `feat/courtroom` · status: for Eden's review**

Companion to `MOCK_TRIAL_SPEC_2026-08-07.md` (the controlling spec) and the
Phase-3 room. The scene seams this spec wires up already exist and are
verified: `setExhibit` / `armExhibit` / `atLectern` / `say` / `setWitnessPortrait`
(commits `9f29206`, `9a62b31`).

---

## §1 Controlling idea

The pitch has always been: *your* matters brought to life in the courtroom
where *you* might actually argue — not canned. Two gaps remain between the
room and that sentence:

1. The evidence screen shows a demo image. It should show **the matter's own
   documents**, published by the courtroom move (offer → colloquy → click).
2. Argument arrives typed. It should also arrive **spoken** — the lawyer's
   own delivery, which is the thing being rehearsed.

Design discipline throughout (the house rule): **deterministic first, a model
only at judgment points.** Rendering, colloquy text, transcription, and
record-keeping are all deterministic. The only model calls added by this spec
are ones that already exist in Phase 2 (the opposing-counsel objection agent
and the judge), invoked at exactly one new judgment point (§2.4).

---

## §2 Exhibits from the matter

### 2.1 What an exhibit is

```
{ exhibit_no: "PX-4",            // or DX-n; free-text, defaulted by side
  doc_id: <matter vault uuid>,   // the real document
  page: 3,                       // for PDFs; ignored for images
  title: "Skyline photograph, August 2024",
  status: "pre_admitted" | "to_offer" | "admitted" | "refused" }
```

**Storage: event-sourced, no migration.** `mock_trial_events` already takes
arbitrary jsonb payloads. Exhibits are events:

- `exhibit_registered` — the row above, when the lawyer lists it
- `exhibit_offered` / `exhibit_ruling` — the §2.4 colloquy outcome
- `exhibit_published` — the moment it went up on the screen (with segment ref)
- `witness_seated` — doc_id of a portrait image + display name (§2.6)

The exhibit list is a fold over the trial's events. Append-only matches the
trial-record character of the thing; nothing to migrate, nothing to keep in
sync.

### 2.2 The Exhibits drawer (TrialRoom)

A slim panel alongside the session: list the registered exhibits with number,
title, status chip; an **Add exhibit** flow that picks a document from the
matter (same document listing the rest of the suite uses), assigns the next
number for the chosen side (PX-n / DX-n), captures title + status, and for
PDFs a page number (numeric input in v1; thumbnail strip is polish, not
required). Reorder and renumber allowed until first publication.

### 2.3 Getting pixels to the screen

Client-side only, machinery we already ship:

- **PDFs** → `pdfjs-dist` (already used by `DocumentReader`) renders the
  chosen page to an offscreen canvas at ~1600px wide → `canvas.toDataURL`
  → `scene.setExhibit(dataURL, label)`. The scene's loader takes data URLs
  today (verified — it goes through `new Image()`).
- **Images** (JPG/PNG in the vault) → the signed URL directly.

No server rendering, no uploads, no third-party calls: the exhibit never
leaves the platform (the Rule 1.6 posture from the original research).

Label format on the screen: `` `${exhibit_no} · ${title}` `` — the way the
record knows it.

### 2.4 The publication move

Colloquy text is a **deterministic template keyed to status** — the theater
is scripted; only rulings think.

**Pre-admitted** (the flow Eden scripted, verbatim shape):

> Counsel: "Your Honor, I would like to publish to the jury {PX-4}, which has
> been admitted as a full exhibit." → Judge: "Any objection?" → Opposing: "No
> objection, Your Honor." → screen arms (gold light) → **the click on the
> screen publishes.**

No model call. Stipulated is stipulated — opposing never auto-objects to a
pre-admitted publish (open question §6.2 if Eden disagrees).

**To-offer** (not yet admitted):

> Counsel: "Your Honor, I offer {PX-7} into evidence." → **the existing
> Phase-2 opposing-counsel agent** decides objection (foundation / hearsay /
> the §Phase-2 grounds) against the record so far → objection, if any, is
> spoken (`say('opposing', …)`) → **the existing judge agent** rules →
> admitted ⇒ arm + click publishes; refused ⇒ `exhibit_ruling` event, screen
> stays dark, the moment is in the record (and priced like any Phase-2
> objection — the only new model spend in this spec).

### 2.5 The record (what jurors see)

Publication writes `exhibit_published` and injects into the active segment's
context a record line, e.g.:

```
[PX-4 PUBLISHED TO THE JURY — "Skyline photograph, August 2024". Content: <first ~400 chars of the document's extracted text for that page, or "photograph/image" for images>]
```

Jurors cite `PX-n` in reactions and deliberation the way they cite record
¶s today. **The image itself is not sent to jurors** — text description only
(economics; a juror panel is 12 parallel calls). v2 option, explicitly
deferred: attach the image on Fable-powered runs where the surface is already
cost-insensitive.

### 2.6 Witnesses from the matter

The same drawer seats witnesses: pick an image document (or an uploaded
photo) + display name → `witness_seated` event → `setWitnessPortrait(signedUrl)`.
Waist-up, front-facing guidance shown inline (the SOURCES.md format rules).
Clearing the stand is `setWitnessPortrait(null)` + event.

### 2.7 Cost

Zero marginal model cost for pre-admitted publication and all rendering.
`to_offer` publication = one opposing-counsel call + one judge call, the
existing Phase-2 unit price. Everything else is client CPU.

---

## §3 Argument by voice

### 3.1 One seam

All capture converges to **text arriving at the same two sinks** the typed
argue bar already uses: `scene.say(atLectern(), text)` for the room, and a
**segment buffer** for the record. Voice is an input method, not a new
pipeline. (Model-agnostic rail: nothing provider-shaped enters feature code;
transcription sits behind one `transcribe` adapter.)

### 3.2 v1 — the computer's own mic (Web Speech API)

Push-to-talk in the argue bar (`⌘/Ctrl+Space` and a mic button):

- **Interim results stream into the lectern bubble live** — the room captions
  the lawyer as they speak. Finalized phrases append to the segment buffer.
- Web Speech API (`webkitSpeechRecognition`): $0, streaming, no audio stored,
  supported in Chrome and iOS/macOS Safari (Eden's two surfaces).
- Fallback path (browser unsupported, or dictation quality complaints):
  `MediaRecorder` → the existing `transcribe-av` pipeline → text lands in the
  buffer on completion. Metered, non-streaming; clearly labeled.

### 3.3 "Rest" semantics (record discipline)

Speaking (or typing) accumulates a draft. An explicit **"Rest segment"**
action turns the buffer into a real `mock_trial_segments` row — *verbatim,
no normalization* (the deposition-fidelity rule extends to the lawyer's own
words) — and the engine runs reactions/objections on it exactly as if it had
been composed in `SegmentComposer`. **No new engine paths.** Discard is
equally explicit.

### 3.4 v2 — the phone as microphone

The room shows a QR (short-lived signed token) → the phone opens
`/app/courtroom/mic/:trial` → same Web Speech capture running on the phone →
finalized lines relayed over a Supabase Realtime channel to the desktop
session, into the same seam. iPhone-first testing per the house rule.

### 3.5 Connect — performed advocacy (closes the Phase-2 acceptance item)

Record the delivery on video in Grapheon Connect → the file lands in the
matter → the media pipeline transcribes it (already works) →
`SegmentComposer` gains **"Import from a recording"**: pick the media doc,
its transcript becomes the segment text, the video stays attached as the
artifact. Optional replay in the room: timed `say()` chunks paced by the
transcript timestamps.

### 3.6 Cost

Web Speech path: $0. Whisper-path transcription: existing media-pipeline
rates, metered into `mock_trials.usage`. Juror economics unchanged.

---

## §4 Build order & acceptance

| Phase | Scope | Accept when |
|---|---|---|
| **A — Exhibits v1** | Drawer, events, pdfjs/image render, both colloquies, record injection, witness seating | A real PX from a real matter document is published in a live session by the click, and a juror cites it in deliberation |
| **B — Mic v1** | Push-to-talk, live bubble captioning, rest→segment | An opening argued by voice produces a segment and the panel reacts to it |
| **C — Phone + Connect** | QR mic relay; Import-from-recording; room replay | Eden argues from the iPhone; a Connect video becomes a segment |

A and B are independent; either can ship first. C depends on B's seam.

---

## §5 Rails (unchanged, restated)

- No composition field ever conditions a visual or a colloquy.
- Exhibits and audio stay in-platform; no third-party upload.
- Bios/personas remain display-and-reasoning texture per the controlling
  spec; nothing in this spec feeds demographics anywhere new.
- The record is verbatim; stricken-material mechanics from Phase 2 apply to
  exhibit-derived lines like any other record line.

## §6 Open questions for Eden

1. **Numbering default**: PX-n for our side / DX-n for theirs, editable —
   fine? Any house convention to mirror instead?
2. **Pre-admitted objections**: confirmed that opposing never objects to a
   stipulated publish? (Spec says never; flag if you want the theater.)
3. **Priority inside Phase C**: phone-as-mic vs Connect import — which first?
