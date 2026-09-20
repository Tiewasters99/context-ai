# What Discovery does, and what it leaves to you

Wording for the product, not internal notes. Everything below is written so it
can be shown in the app — on the Discovery home screen, in the review room, or
in a "What this version does" panel — without editing.

The short version, which belongs somewhere a first-time user cannot miss:

> **Review is manual in this version.** Contextspaces handles the mechanics of a
> production — intake, normalization, Bates numbering, endorsements, the
> package, the load file and the delivery record. It does not decide what is
> responsive, what is privileged, or what a request asks for. Those calls are
> yours, and the software records them; it does not make them.

---

## What it does

- **Takes in a production.** A ZIP or a folder of files from opposing counsel,
  or your own client's files. It reads Concordance `.dat` load files and trusts
  the Bates numbers and document breaks already in them.
- **Normalizes to a viewable set.** PDFs pass through; TIFFs and images become
  page-sized display PDFs. Anything it cannot render honestly as pages stays in
  its native format and is produced with a Bates slip-sheet.
- **Keeps the triplet.** For every document: the display PDF, the original
  native bytes, and a metadata row with a sha256 of the file as received.
- **Tags.** Preset tags (Privileged, Hot Doc, Confidential, Non-Responsive) plus
  your own. A tag is either an *endorsement*, which is burned onto the produced
  pages, or an *annotation*, which stays internal.
- **Withholds what you mark.** Tagging a document Privileged or Non-Responsive
  removes it from the produced set and, for Privileged, starts a privilege-log
  entry for it.
- **Numbers.** Bates prefix, digit width, start number and corner. Every number
  ever assigned in a matter is recorded and can never be reused — including
  after a failed run. Supplemental productions continue from where the matter
  left off.
- **Packages.** IMAGES, NATIVES, a Concordance `.dat` and Opticon `.opt` load
  file, the privilege log, and a transmittal letter, in one ZIP with a recorded
  sha256.
- **Records delivery.** Who received it, when, by what method, and the sha256 of
  exactly what they got.

## What it does not do

- **No responsiveness review.** There is no AI classification of documents
  against your requests, and no scoring, ranking or suggested calls. Every
  responsiveness decision is made by a person.
- **No mapping to requests.** You can record which requests a production
  responds to as free text ("RFP Nos. 1–24"). Nothing links a document to a
  numbered request, and nothing reports which requests are unanswered.
- **No search across a production.** The review list filters on what is on the
  screen — filename, tag, status. There is no full-text search of the
  production's contents from the Discovery surface. (Documents the intake
  indexes are searchable from the matter's own search, separately.)
- **The privilege log is typed by you.** Author, addressee, cc, subject matter
  and the basis for withholding are entered by hand for every withheld
  document. For an `.eml` the sender, recipients, subject and date are
  pre-filled from the message headers; for everything else — including `.msg`
  files and attachments — the fields start empty.
- **No collection.** Nothing collects from a phone, a laptop, a mail server or a
  cloud account, and nothing preserves or images a device. Discovery starts from
  files you already have.
- **Office documents and Outlook `.msg` files are produced natively.** They are
  not converted to a display PDF, so what a reviewer sees in the browser is a
  slip-sheet with the Bates number and the filename, not the document's pages.
  Download the native to read it.
- **No deduplication.** Two identical files in one intake become two produced
  documents with two Bates ranges. If a production needs to be de-duplicated,
  do it before intake.
- **Documents that fail to normalize are left out of the produced set.** They
  are recorded on the production as errored items, but the package does not
  contain them and nothing in the package says they were excluded. Check the
  item list for errors before you stamp.
- **No redaction.** Endorsements are stamped on pages; nothing is burned over or
  removed from a page's content.
- **No entitlement or billing gate.** Discovery is open to anyone with access to
  the matter.

## Words to avoid in the interface

Saying any of these would be untrue of this version:

- "AI-powered review", "automatic privilege detection", "smart tagging"
- "finds responsive documents", "suggests what to produce"
- "searches your production" (the review list filters; it does not search text)
- "complete privilege log" (it is a log of what you typed)
