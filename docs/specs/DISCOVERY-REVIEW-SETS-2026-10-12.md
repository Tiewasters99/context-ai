# Discovery: review across the matter, production sets

**Status:** APPROVED by Eden 2026-10-12 (all four questions as recommended). Nothing here is built yet; R1 is next.
**Date:** 2026-10-12. **Author:** Claude Code (Opus), from Eden's notes after the 10-11 live check.

## 1. What Eden described

The workflow attorneys expect from the large vendors (pre-AI, but the standard):

1. Everything collected sits in **one repository** for the matter.
2. Reviewers **tag documents as they go**: Privileged, Attorneys' Eyes Only, Confidential, Irrelevant, Non-Responsive, Hot Doc, plus the firm's own tags.
3. From those tags you build **sets**, and you choose how to stamp and run each **production** from a set.
4. Privileged and non-responsive documents never get into a production set. Confidential and AEO documents are produced with the marking burned on.

## 2. Where Contextspaces is today

- The repository already exists: the matter's **Vault** (documents in the matter and its folders and sub-matters).
- Tags exist, but **they live on production items**, not on documents (`document_tags.production_item_id`, migration 030). So a document can only be tagged after it has been put into a production, and tagging is repeated for each production.
- Since #400, a production can be **filled from the Vault** (`intake_documents`), and since #401 the preset tags include AEO and Irrelevant, and the load file carries each designation.
- The Review Room reviews **one production at a time**.

The gap is that review happens inside a production, not across the matter.

## 3. Proposal

### 3.1 Tags belong to documents

A tag is applied to a **matter document**: one place, seen everywhere.

- New table `document_review_tags (tag_def_id, document_id, matterspace_id, created_by, created_at)`, unique `(tag_def_id, document_id)`, with the same matter-access RLS as the rest of Discovery. Tag definitions stay in `document_tag_defs` (one list per matter, presets as today).
- **When a production is built from a set, the document's tags are copied onto its production items** (`document_tags`) at that moment. The production then behaves exactly as today: exclusions, endorsements, the privilege log, the DAT. Nothing in stamping or packaging changes.
- **Tagging in the Review Room writes to the document** when the item came from the matter (it has a `document_id`), so the two never disagree. Once a production is stamped, its copy is frozen, which is correct: the production records what was produced, even if a tag later changes.

### 3.2 A matter-wide review table

A new **Review** tab in Discovery (beside the production list):

- one row per matter document: name, folder, date, custodian/from/to where known, page count, and a chip for each tag;
- filter by tag (has / has not), folder, file type, date, and the matter's own search (words or meaning, as in the Vault);
- **bulk tagging:** select rows, apply or remove a tag;
- opening a row shows the document in the same viewer as the Review Room, with the same keyboard tagging (P, C, H, N…).

Incoming productions are reviewed here too: their documents are already filed in the matter when they come in.

### 3.3 Sets

A **set** is a saved, named question: "everything tagged Responsive in Custodian: Patel, not tagged Privileged or Irrelevant".

- Stored as a rule (`discovery_sets (id, matterspace_id, name, rule jsonb, created_by, …)`), so it stays current as review continues. The count is shown live.
- Building a production from a set **freezes the list at that moment** and starts a normal outgoing production with those documents (the #400 job). From then on it is an ordinary production: stamp position, designations, PDF or TIFF, delivery.
- **Privileged, Non-Responsive and Irrelevant are always excluded** from a production built from a set, whatever the rule says, and the screen says how many were held back and why. This makes the exclusion hard to get wrong.
- A set can also be built by hand: tick documents in the review table and "Save as set".

### 3.4 Privilege log across the matter

Documents tagged Privileged anywhere in the matter draft a privilege-log entry once, at the document. A production's privilege log is drawn from those entries for the documents its set held back. Today's per-production log stays as it is for existing productions.

## 4. Order of work (each a separate PR)

| Phase | What | Migration |
|---|---|---|
| **R1** | Tags on documents (`document_review_tags`); the Review tab with filters and bulk tagging; Review Room tagging writes through to the document | yes (112+) |
| **R2** | Sets (rule + frozen list); "Produce this set" (uses #400's job; copies tags onto items) | yes |
| **R3** | Matter-wide privilege log; tag filters in the Vault and in search (if Eden wants, see Q1) | maybe |
| **R4** | Optional AI suggestions ("looks privileged", "possible hot document") as suggestions only, never applied without a person; works in sealed matters through the sealed route | no |

R1 and R2 need no AI and work the same in sealed matters. Producing documents is deterministic, so a sealed matter loses nothing here.

## 5. Questions for Eden (decided 2026-10-12: all as recommended)

1. **Should review tags show outside Discovery?** For example, filtering the Vault or search to "Hot Doc". **Decided:** *yes, read-only chips in the Vault in R3; tagging stays in Discovery.*
2. **One tag list or two?** Some firms keep "issue codes" (subject tags such as "Damages" or "Notice") separate from "designations" (privilege and confidentiality). **Decided:** *one list now, with a "kind" label (designation, exclusion, issue, note) so the review table can group them.*
3. **Can a production still be made the current way** (upload or pick, then tag inside the production)? **Decided:** *yes. Sets are the main path, and the current path stays for one-off productions and incoming volumes.*
4. **Who may tag?** Today any member of the matter. **Decided:** *unchanged for now. A "reviewer" role can come later.*

## 6. Not in scope

Predictive coding / technology-assisted review, email threading, near-duplicate detection, and redaction. These are worth their own specs; redaction is the one attorneys will ask about first.
