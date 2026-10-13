# Discovery: review across the matter, production sets

**Status:** APPROVED by Eden 2026-10-12 (all four questions as recommended). R1 (#411) and R2 (#414) are live; R3 is migration 116. Amended 2026-10-13: Privileged documents go into a set's production and are withheld at stamping (see §3.3).
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
- **Non-Responsive and Irrelevant are always left out** of a production built from a set, whatever the rule says. **Privileged documents go into the production, are withheld when it is stamped, and appear on its privilege log.** The screen says how many of each before the production is made. This keeps the exclusion hard to get wrong and keeps every privileged document accounted for in the production that withheld it.
  - *Decision, 2026-10-13 (Eden): "keep it, privileged in and withheld at stamp."* The 10-12 text said Privileged was excluded at the set; R2 (#414) shipped the behavior above instead, live check 4 passed on it, and Eden confirmed it.
- A set can also be built by hand: tick documents in the review table and "Save as set".

### 3.4 Privilege log across the matter

Documents tagged Privileged anywhere in the matter draft a privilege-log entry once, at the document (`document_privilege_entries`, migration 116), listed and edited on Discovery's **Privilege log** tab and exported as CSV. When a Privileged document goes into an outgoing production (and is withheld there at stamping, §3.3), the production's entry is **copied** from the document's entry and linked to it. Until the production is stamped the two stay in step: an edit on either side reaches the other (and the other unstamped productions). Once stamped, the production keeps its own copy, because it records what was logged when the production was made. Removing the Privileged tag keeps the entry (it is listed again if the document is re-tagged). Today's per-production log keeps working for existing productions; their entries are linked to the document's entry where the item came from the matter.

## 4. Order of work (each a separate PR)

| Phase | What | Migration |
|---|---|---|
| **R1** | Tags on documents (`document_review_tags`); the Review tab with filters and bulk tagging; Review Room tagging writes through to the document | yes (112+) |
| **R2** | Sets (rule + frozen list); "Produce this set" (uses #400's job; copies tags onto items) | yes |
| **R3** | Matter-wide privilege log (Privilege log tab, CSV export); read-only review-tag chips in the Vault (Q1) | yes (116) |
| **R4** | Optional AI suggestions ("looks privileged", "possible hot document") as suggestions only, never applied without a person; works in sealed matters through the sealed route | no |

R1 and R2 need no AI and work the same in sealed matters. Producing documents is deterministic, so a sealed matter loses nothing here.

## 5. Questions for Eden (decided 2026-10-12: all as recommended)

1. **Should review tags show outside Discovery?** For example, filtering the Vault or search to "Hot Doc". **Decided:** *yes, read-only chips in the Vault in R3; tagging stays in Discovery.*
2. **One tag list or two?** Some firms keep "issue codes" (subject tags such as "Damages" or "Notice") separate from "designations" (privilege and confidentiality). **Decided:** *one list now, with a "kind" label (designation, exclusion, issue, note) so the review table can group them.*
3. **Can a production still be made the current way** (upload or pick, then tag inside the production)? **Decided:** *yes. Sets are the main path, and the current path stays for one-off productions and incoming volumes.*
4. **Who may tag?** Today any member of the matter. **Decided:** *unchanged for now. A "reviewer" role can come later.*

## 6. Not in scope

Predictive coding / technology-assisted review, email threading, near-duplicate detection, and redaction. These are worth their own specs; redaction is the one attorneys will ask about first.
