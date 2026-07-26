# Grapheon Discovery — Design

End-to-end discovery for document-intensive litigation, built as a module
inside Contextspaces with clean boundaries so it can later ship as a
standalone product (market comp: Discovery Genie, ~$300/mo for document
production alone).

## The model

A **Production** is a named, dated set of documents belonging to exactly one
matter, with a direction and a lifecycle:

- `incoming` — opposing counsel produced to us: detect → intake → index → review.
- `outgoing` — our client's files: intake → review/tag → withhold privileged →
  Bates stamp → package → deliver.

Lifecycle: `intake → processing → review → stamped → packaged → delivered`
(incoming productions stop at `review`). Per-matter isolation is a hard
contract: a production lives inside one matterspace.

## The triplet

Every intake item normalizes to:

1. **Display PDF** — the click-through rendering. PDFs pass through; TIFFs and
   images are converted to PDF (sharp + pdf-lib). No page-image rasterization
   anywhere: Bates stamps and endorsements are drawn as vector text overlays
   with pdf-lib, so files stay small and text stays searchable.
2. **Native file** — always retained; the only artifact for file types that
   don't render honestly as pages (spreadsheets, A/V, .msg, etc.). Natives get
   a Bates slip-sheet and a Bates-numbered filename at production time.
3. **Metadata row** — `production_items`: sha256 (dedup + chain of custody),
   original path inside the production, sizes/dates, parsed load-file fields,
   email headers where extractable.

Display PDFs are also ingested through the existing `processDocument` pipeline
(per-page extraction, OCR fallback, embeddings) so every produced document is
immediately searchable matter-wide with page-accurate citations.

## Schema

Migration `030_discovery_productions.sql`: `productions`, `production_items`,
`document_tag_defs` + `document_tags`, `bates_registry`,
`privilege_log_entries`, `deliveries`, `processing_jobs`; storage bucket
`discovery-files` (`{matterspace_id}/{production_id}/{item_id}/...`). RLS via
the SECURITY INVOKER wrapper pattern (see migration 022's header for why).

**bates_registry is the legally load-bearing table**: one row per Bates number
ever assigned in the matter, unique-constrained, no UPDATE/DELETE policies.
Supplemental productions continue from the matter's high-water mark. A stamped
production locks (trigger-enforced); late additions go in a supplement.

## Tagging

Presets: **Privileged, Hot Doc, Confidential, Non-Responsive**, plus custom.
Two kinds, set per tag def:

- **Endorsements** (`is_endorsement`) burn onto produced pages
  (PRIVILEGED, CONFIDENTIAL).
- **Annotations** stay internal (Hot Doc, Non-Responsive, custom).

Behavior keys: `privileged` → excluded from the produced set + auto-drafts a
`privilege_log_entries` row (author, addressee, cc, subject matter, basis:
attorney-client / work-product / marital / physician-patient /
pastor-parishioner / custom). `non_responsive` → excluded.

## Bates

Configured per production at stamp time: prefix (`LIT_`), pad width
(7 → `LIT_0000001`), start number (suggested from the registry high-water
mark), position (lower/upper × left/center/right). Natives get one number on
a generated slip-sheet plus the number as produced filename
(`LIT_0000042.xlsx`). Pre-stamp display PDFs are retained — stamping is
non-destructive internally, immutable externally.

## Packaging & delivery

```
<production name>/
  IMAGES/   LIT_0000001.pdf ...      (stamped + endorsed display PDFs)
  NATIVES/  LIT_0000042.xlsx ...
  DATA/     loadfile.dat             (Concordance: þ-qualified, 0x14-separated)
  PrivilegeLog.pdf                   (optional include)
  ProductionLetter.pdf               (generated cover: ranges, counts, designations)
```

ZIP always; a merged single PDF is added when the volume is small and has no
natives. Package sha256 recorded. `deliveries` is the service record: who,
what, when, how, hash. Incoming load files (`.dat`/`.opt`) are parsed on
intake — opposing counsel's own Bates numbers and document breaks are trusted
over filename guessing.

## Heavy processing

Vercel's 60s timeout can't process multi-GB productions, so all heavy work
runs in `worker/discovery-worker.mjs`, which claims jobs from
`processing_jobs` (atomic `claim_discovery_job` RPC, `FOR UPDATE SKIP
LOCKED`). The same worker:

- runs locally (`node worker/discovery-worker.mjs`) or deploys as a
  long-running service (Railway/Fly) — built for hosted from day one;
- intakes very large productions directly from a local folder
  (`--intake <folder> --production <id>`), bypassing browser upload limits;
- reports `progress` / `progress_note` that the UI polls.

Job types: `intake_zip`, `intake_files`, `intake_folder`, `stamp_production`,
`package_production`.

## Phases

1. **Review core** — schema, worker, ZIP/folder intake, normalize, review
   room, keyboard tagging. *(usable on a real incoming production)*
2. **Production out** — Bates engine + registry, endorsements, privilege log,
   packaging, retained copy. *(can produce to opposing counsel)*
3. **Automation** — Gmail detection of incoming productions, watched folders,
   `.dat`/`.opt` emission refinements, in-app delivery via expiring links,
   supplemental-production flow, deficiency tracking.

## Standalone-readiness rules

- All discovery code lives in `lib/discovery/`, `worker/`,
  `src/pages/discovery/` + `src/lib/discovery.ts`.
- No coupling to `content_items` or other workspace features; the only shared
  dependencies are matters/auth/storage and the ingest pipeline.
- The worker takes its config entirely from env vars.
