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
- **Numbers.** Bates prefix, digit width, start number and corner. A
  production's range is reserved once, before the first page is stamped, so an
  interrupted run picks up where it stopped and hands out exactly the same
  numbers rather than burning them. Every number ever assigned in a matter is
  recorded and can never be reused. Supplemental productions continue from
  where the matter left off — including past a range another production has
  reserved but not yet finished.
- **De-duplicates exact copies.** Two byte-identical files in one production
  are produced once, under one Bates number. The second copy keeps its place in
  the record and is listed in the package as a duplicate of the first, with the
  number it was produced at.
- **Accounts for every document.** Anything taken in that could not be rendered
  is recorded with a reason and listed in the package's exceptions report — by
  original path, sha256 and reason. The package states the arithmetic:
  *received = produced + withheld as privileged + duplicates + exceptions*. If
  those figures do not add up, the package is not produced at all.
- **Packages.** IMAGES, NATIVES, a Concordance `.dat` and Opticon `.opt` load
  file, an exceptions report, a duplicates report, a reconciliation statement,
  the privilege log, and a transmittal letter, in one ZIP with a recorded
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
- **De-duplication is exact only.** Two files are treated as the same document
  when their bytes are identical (sha256), within one production. A document
  that differs by a byte — a re-saved PDF, the same email collected from two
  custodians, a near-duplicate draft — is produced as its own document.
  Family-level and near-duplicate analysis is not in this version.
- **Documents that fail to normalize are not produced.** They are recorded with
  a reason and listed, by original path and hash, in the package's exceptions
  report — so the receiving party is told what was left out — but the software
  cannot render them and does not try again. Review the exceptions before you
  package; a corrupt or unsupported file is a document you may still owe.
- **No redaction.** Endorsements are stamped on pages; nothing is burned over or
  removed from a page's content.
- **A long intake holds its place in the queue.** One ZIP is one job, so a very
  large incoming production occupies the worker until it finishes; other work
  in other matters waits behind it. Pressing Stamp or Package is not affected —
  those jump ahead of queued bulk work — but a second large intake does queue.
- **No entitlement or billing gate.** Discovery is open to anyone with access to
  the matter.

## Words to avoid in the interface

Saying any of these would be untrue of this version:

- "AI-powered review", "automatic privilege detection", "smart tagging"
- "finds responsive documents", "suggests what to produce"
- "searches your production" (the review list filters; it does not search text)
- "complete privilege log" (it is a log of what you typed)
