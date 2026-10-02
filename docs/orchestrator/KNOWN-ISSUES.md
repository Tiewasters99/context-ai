# Known issues — what goes wrong, why, and what to do

*For the Orchestrator, read when someone reports a problem. Draft 1, 2026-10-02, for Eden's review — not yet wired in.*

How to use this: match what the person **sees** to a symptom below, then explain the cause in a sentence and offer the fix. Before calling anything a bug, establish exactly what they see and where (most "missing" things exist somewhere else). If nothing here fits, or the fix below doesn't work, write it up for Eden (see the last section) — never guess at a cause, and never say something was fixed unless you checked.

---

## Brief Desk

**"Searching [another client's matter] for § …" during a cite check, or Find in corpus looks in the wrong place.**
The desk searches the brief's *record*: the matter the person chose under "Record: … · change", otherwise the matter the brief is filed in. A brief filed in the wrong matter searches the wrong one. A tab opened before the brief was moved keeps searching the old matter until reloaded.
*They can:* reload the tab (F5); check "Record: …" in the desk header and change it; move the brief into the right matter (Vault, Cut → Paste, or drag).
*Escalate:* if after a reload it still names a matter the brief has no connection to.

**A brief brought in from Contextspaces landed in another client's matter.**
The Brief Desk home remembers the last "File it in" choice; bringing in a document files it there. (10-02: a Bushell v20 was filed under DeCamara this way.)
*They can:* move it (Vault → Cut → right-click the right matter → Paste). Before bringing a document in, check "File it in".

**"This brief was changed in another window after you opened it."**
Two windows were editing the same brief; the desk refuses to save over the other one's work. Nothing was overwritten.
*They can:* keep what is on screen with **Save as v…** (a new version in the Vault), then reconcile versions with **Compare**.

**"Read-only: this brief is being edited in another window (since 10:02)."**
One person edits a brief at a time. Another window (often the same person's other tab, or a laptop left open) holds it. A window that is closed lets go within about 2½ minutes.
*They can:* close the other window, or press **Take over editing** (the other window becomes read-only and keeps its text on screen).

**"Editing moved to another window."**
Someone took over editing. This window stopped saving at once.
*They can:* **Save as v…** keeps whatever is on screen as a new version.

**A red flag on a passage stays open after a redraft fixed it, or a fixed flag has no note saying why.**
A flag belongs to the exact words that were flagged. Confirming the *new* wording is a different set of words, so nothing asks how the old flag was answered.
*They can:* Log → **Open problems** → **Resolve with a note…** on that flag. Flags whose words are gone are tagged "no longer in the brief".

**"I saved v19 but can't find it."**
**Save as** files the new version in the same matter as the version saved from — which may differ from where the original Word file sits (e.g. the desk copy in "Bushell", the Word original in its sub-folder "Article 78 Petition Exhibits"). The save notice names the matter. Opening a sub-folder shows only that sub-folder.
*They can:* open the parent matter; sort by date (newest first).

**Find in corpus shows a case but not the footnote the brief cites ("at n.1").**
Word footnotes are at the very end of the document, after the signature. Once PR #351 is live they sit under a "Footnotes" heading and a cite with "n.1" opens at that note; until then, scroll to the end. Word footnotes became searchable on 10-02; documents indexed before then were backfilled the same day.
*Check:* the document is a Word file; search its text for the note's words.

**"Find in document" in the case pane does nothing.**
Since 10-02 it searches as you type; before, only Enter ran it and the arrows sat disabled.

**The ✕ in the case pane did nothing.** Fixed 10-02 (the document viewer's own ✕ was not connected).

**Dragging the scrollbar on a long PDF in the case pane froze it.** Fixed 10-02 (pages are drawn when the drag pauses).

**A brief freezes for several seconds on opening.** *Open, not diagnosed* (seen on Bushell v18, every open). Ask which brief, how long, every time or the first time; write it up for Eden with that.

## Vault, files and matters

**"My document isn't in the Vault."**
Almost always it is in a different matter or sub-folder, or the Vault list was opened before the document arrived. The Vault re-reads its list when its tab comes back into view (since 10-02).
*Check:* search for it by name (word order and punctuation don't matter since 10-01: "Verified Petition v. 18" finds `Bushell-Verified-Petition-Art78-v18-FILING`).

**A search by name misses a file whose name has hyphens or underscores.** Fixed 10-01 (Vault and Brief Desk match word by word).

**"Couldn't load this matter's documents (… TypeError: Failed to fetch)."**
The browser could not reach the server — usually a dropped or switching connection (Wi-Fi after sleep, VPN), sometimes a browser extension. The server answers normally; nothing is lost.
*They can:* reload; if it persists, try an Incognito window (extensions off). *Escalate:* if Incognito fails too.

**Moving or copying files.** Select several (Ctrl/Shift-click or drag a box); drag onto a folder, or right-click → Cut/Copy, then right-click a folder or a sidebar matter → Paste here. Ctrl+X/C/V work in the list.

**A move or copy into or out of a SecureSpace is refused.** By design: a sealed document never moves or copies to anything less sealed, and entering a sealed matter asks for the second factor. The refusal says so in words.

**Renaming a matter or sub-matter.** Sidebar: hover → pencil (or double-click the name). Or click the name at the top of the matter's page.

## Searching and the record

**A document isn't searchable yet.** It may still be processing, or awaiting OCR (scans, stamp-only pages).
*Check:* `check_ingest_status`; retry with `ingest_document` if it shows an error. Never say it is done when it is queued.

**A sealed matter's documents are found by text but not by meaning.** Sealed matters are searched text-only unless a zero-retention route is configured (the "sealed embedding hold"). Expected, not broken.

## Connections and outside AI

**An AI (Grok, Claude, ChatGPT) can or cannot see a matter.**
A matter's Share dialog lists **AI with access**: agents and why they see it ("this matter", "via Bushell", "All matters"), plus one line for assistants connected with full access. Agents are scoped; full-access assistants see everything the person can, except SecureSpaces.
*They can:* Share → AI with access → Edit matters / Revoke, or **Connect an agent to this matter**.

**Opus in claude.ai "saved" a version.** Through the connector an outside AI cannot edit a Brief Desk brief; it can only file a new document. Its "v19" is a separate document.

**A Custom GPT can't be shared.** OpenAI's limit, not ours (paused 09-30).

## Site-wide

**The whole site or the connector returns 402 / "deployment paused".** Vercel billing, not the app (08-28). Only Eden can fix it, in Vercel → Billing.

**PDF OCR, transcription and Gemini all fail at once ("dunning decision is deny").** A past-due Google Cloud balance (09-03). Eden pays it; it recovers within minutes.

---

## Writing it up for Eden

When something doesn't fit above, or the fix didn't work, give Eden one short note:
- **What they saw**, in their words, and **where** (page, brief or document name, matter).
- **When**, and whether it happens **every time**.
- **What you checked** and what it showed (tool results, not impressions).
- **What you told them** to do in the meantime.

Never offer a fix that changes the product itself, the database, or another person's documents. Those go to Eden.
