# DeCamara docket pull — run plan

Case: **De Camara et al v. Bryn Mawr College et al, 2:25-cv-02287-MAK (E.D. Pa.)**
Judge Mark A. Kearney. Filed 05/05/2025, terminated 04/20/2026, last filing 05/11/2026.
On appeal: USCA 3d Cir. 26-02097 and 26-02098.

## Scope (from the free enumeration pass, 2026-08-05)

| | |
|---|---|
| Docket rows | 97 |
| Rows with a document | 82 |
| Leaf documents (mains + attachments) | 181 |
| Entries that are multi-document menus | 32 |
| Entries that are a single document | 50 |
| Total pages | 8,664 |
| Documents at/over the 30-page cap | 49 |
| Enumeration errors | 0 |

## Cost

PACER bills $0.10/page, capped at $3.00 (30 pages) per document.

- Known-page documents: **$213.30**
- 41 leaves reported no page count on the menu; worst case they are all
  capped documents, adding up to $123 → **ceiling ≈ $336**.
- The docket report itself: $3.00 (30-page cap).
- Written opinions are free under the PACER fee schedule; several orders here
  are likely flagged as such, so actual spend should land under the estimate.

Note: for the 50 single-document entries the `/doc1/` page *is* the PACER
transaction receipt (it states "Billable Pages" and "Cost"), so the
enumeration pass has probably already registered those charges. The runner
captures the stated cost from each receipt so true spend can be reported.

## Method (carried over from the GateGuard pull, 1:21-cv-09321 SDNY)

Per document: receipt form → GET with form fields + `got_receipt=1` → HTML
wrapper → iframe src → PDF blob → save. Multi-document entries are recursed
through the "Document Selection Menu". Every fetch wrapped in a 90s
AbortController timeout — one hung fetch froze the first GateGuard runner.

Keep the CM/ECF tab untouched during the run; any navigation destroys the
in-page state. `DC2287_000_DocketSheet.html` holds every doc1 link, so a
crashed run can be rebuilt without re-billing the docket report.

## Destination

- Local: `C:\Users\equai\DeCamara_v_BrynMawr_Docket\`
  named `DC2287_<entry>_<desc>[_attN_label].pdf`
- Contextspaces: **DeCamara v. Bryn Mawr → Docket**
  (`decamara-docket`, `bcac513c-8c47-4e89-b04e-2884c7991be3`), created 2026-08-05.
- Ingest with `scripts/ingest.mjs --matter decamara-docket`, then
  `scripts/ocr-scanned.mjs --matter decamara-docket` for scanned orders/exhibits.

## Blocker

Chrome blocks automatic multi-file downloads for `ecf.paed.uscourts.gov`.
Fix: `chrome://settings/content/automaticDownloads` → "Allowed to
automatically download multiple files" → Add → `[*.]uscourts.gov`.

A localhost bridge (`_docket-bridge.mjs`) was built as an alternative that
would write files directly to the archive folder, but Chrome's Local Network
Access permission blocks page→localhost requests too, so it needs a click
either way. The downloads route is the one already proven on GateGuard.
