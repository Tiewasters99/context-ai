# Equazia for Word: AppSource store listing (draft, 2026-11-02)

Paste-ready text for Partner Center → **Marketplace listings → English (United States)**.
Limits are from Microsoft's pages, cited per field. Everything here is a draft
for Eden's approval.

Sources:
- L = https://learn.microsoft.com/en-us/partner-center/marketplace-offers/create-effective-office-store-listings
- I = https://learn.microsoft.com/en-us/partner-center/marketplace-offers/craft-effective-appsource-store-images
- P = https://learn.microsoft.com/en-us/legal/marketplace/certification-policies
- C = https://learn.microsoft.com/en-us/partner-center/marketplace-offers/checklist

---

## 1. App name

**Equazia**  (7 characters; L: maximum 50, recommended 30)

Why not "Equazia for Word":
- L, "Use a succinct and descriptive name": "Don't include the Microsoft product name because it already appears on your landing page, and in Microsoft Marketplace and in-product Store search results." "for Word" is the Microsoft product name.
- L, "Use a consistent add-in name": the Partner Center name must equal the manifest `DisplayName`, which is `Equazia` (public/addin/manifest.xml:22). C, Step 7: "This must be the same or very similar to the app name provided in the app manifest."
- "Equazia for Word" stays the name used in prose (the Privacy and Support pages, the pane's HTML title), where it identifies the app to readers; the privacy-policy rule (C, Step 6) asks that the policy name the app being submitted, and it does.

**EDEN — naming tension, not resolved here.** Two rules push against a bare brand name:
- L: "Make the purpose or benefits of your solution clear. Don't rely on your brand to communicate what your solution does." Suggested pattern "Function + for + brand".
- P 1100.7: "The title may not include your brand or service unless your offer targets a larger organization or enterprise."

Read literally, 1100.7 would forbid "Equazia" and also "Brief Citation Check for Equazia". The reviewer may accept a brand-only name, or may ask for a descriptive one. Any rename must change the manifest `DisplayName` too (and bump the manifest Version). Eden decides; this package submits "Equazia".

## 2. Summary

L / P 100.1.2: maximum 100 characters, recommended 70, key message in the first 30; "Don't repeat the name."

> Check every citation in your brief against the matter, and save Word drafts to it as versions.

(94 characters.)

Shorter alternative (64): `Check every citation in a brief against the record, inside Word.`

## 3. Description (HTML)

Limits: L table: Description maximum 10,000 characters, recommended 300 to 500 words; L prose: "The maximum length for descriptions is 4,000 characters." Written to the lower figure: the HTML below is under 4,000 characters including tags. Plain tags only (`<p> <b> <ul> <li> <a>`).
Disclosure rules applied: C Step 7 ("If your app requires additional services or accounts, the long description should include information like their names and links to how to acquire them"), P 100.4 and P 1100.1 (disclose features that require an extra charge). L: no "free", no "sale", no exclamation points; no superlatives; no competitor names (P 100.1.3).

```html
<p>Equazia brings the matter into Word. Lawyers and paralegals keep a brief, a motion or a memo in Word, and the pane beside the page connects it to the matter it belongs to in Equazia.ai: the pleadings, transcripts, exhibits and cases already filed there.</p>
<p><b>Save to Equazia.</b> Store the Word document in its matter as a new version, labelled as you choose (v.1, v.2, Filed). The .docx is kept exactly as Word has it, searchable with the rest of the matter, under the matter's own access rules. Every save is a version; earlier versions stay available.</p>
<p><b>Confirm this brief.</b> When the draft is ready, the pane reads every citation in it and checks each one against the matter: whether the authority is there, and where. Each citation becomes a row. Click a row and Word selects that citation in your document. Open the row to see where the authority was found, by title and page, and open it in Equazia at that page; then mark the citation Confirmed or Problem with your initials. If you ask it to, the pane adds a Word comment recording the reading; otherwise it writes nothing into your text.</p>
<p><b>Open in Word from Equazia.</b> A .docx stored in Equazia.ai can be opened in Word from the document's menu; the file carries a tag naming its document, so the pane recognises it when you press Equazia on the Home tab, so the next Save adds a version to the same document.</p>
<p><b>Who it is for.</b> Litigators, appellate lawyers, law-firm associates and paralegals who check a brief's citations against the record before filing, and anyone who wants a matter's Word drafts kept with the rest of the matter rather than in a separate folder.</p>
<p><b>Requirements.</b></p>
<ul>
<li>An Equazia.ai account and a paid Equazia.ai subscription are required. Sign-in is with your Equazia.ai email and password. Plans and sign-up: <a href="https://www.equazia.ai">https://www.equazia.ai</a>.</li>
<li>The documents to check against must be in a matter in your Equazia.ai account.</li>
<li>Word on Windows, Word on Mac and Word on the web, with Microsoft 365. Adding Word comments requires a version of Word that supports Word comments for add-ins (Word API 1.4).</li>
</ul>
<p><b>Your documents.</b> Nothing is sent from Word until you press Save to Equazia or Confirm this brief. How Equazia.ai handles the document is described at <a href="https://www.equazia.ai/privacy">https://www.equazia.ai/privacy</a>. Help: <a href="https://www.equazia.ai/support">https://www.equazia.ai/support</a>.</p>
```

Note for Eden: P 100.4 also says "Within the offer listing, you may not redirect or up-sell customers to software or services outside Marketplace." The www.equazia.ai link above is written as the required account disclosure (C Step 7), not as a pitch. If the reviewer reads it as a redirect, the fallback is to keep the sentence and drop the link.

## 4. Search keywords

No page read for this package states a number or length limit for search keywords; Partner Center shows its own limit on the form. Enter as many of these as the form accepts, in this order:

1. citation check
2. cite check
3. brief
4. legal
5. litigation
6. law firm
7. table of authorities
8. matter management
9. document versions
10. paralegal

(L: "Include keywords that customers might search for." P 100.1.3: no tags referencing competing offers; none above do.)

## 5. Categories and industries

Submission guide Step 5: "select at least one and up to three categories"; "You can optionally select up to two industries. If your product isn't specific to an industry, don't select one." P 100.2: the description must be relevant to the categories and industries chosen.

- Category 1: **Productivity**
- Category 2: **Document management** (if offered under that name; otherwise Content management)
- Industry: **Legal** if Partner Center lists it (it is a sub-option under "Professional Services" in some versions of the form); otherwise **Professional Services**. Eden picks from the live list.

## 6. Logo

- File: `public/addin/logo-300.png`, 300 x 300 PNG, made from `public/icon-512.png` (resized with sharp, no other change).
- Rule applied, P 100.3: "Logos are uploaded as a `.png` file between 216- and 350-pixels square." 300 is inside that range. "An optional 48-pixel square logo may be added later" (not made).
- No padding or background rule appears on I, L or P 100.3; none was applied.
- L: the store logo and the manifest icon "should be of the same logo or icon". They are (both from `public/icon-512.png`).
- Manifest icons (L table, task pane add-ins): IconUrl "Must be 32 x 32 pixels" → `icon-32.png`; high-DPI "the image must be 64 x 64 pixels" → `icon-64.png` (fixed in this PR; it pointed at the 80 px icon and the store validator rejected it). Ribbon button images 16/32/80 are command icons under a separate rule and are present.

## 7. Screenshots (EDEN takes them, in real Word)

**The two Microsoft sources give different sizes. Eden confirms at upload; the Partner Center uploader states its own requirement next to the box.**
- I: "Provide at least one image that is 1366w x 768h pixels and no greater than 1024 KB."
- P 100.3: "Images must be 1280x720 pixel `.png` files."
- C Step 7: "One screenshot is required."

Recommendation: capture at 1366 x 768 or larger, export PNG at **1366 x 768**, each under **1024 KB**; keep a 1280 x 720 PNG export of each beside it in case the uploader asks for that size. Both are 16:9, so one capture serves both.

Image rules from I that matter here: show real content rather than an empty document (use the "AppSource Review" sample brief, never a client document); no personal information; "Don't show unrelated user interface elements such as task bars, ribbons, excessive empty space, or other applications" (crop to the page and the pane); one point per image; captions must not cover content.

| # | What to capture | Caption (on the image or in the caption field) |
|---|---|---|
| 1 | Word with the Equazia pane open, document line reading "Not in Equazia yet", matter tree with "AppSource Review" selected, label box "v.1" | Save the Word draft to its matter as a version |
| 2 | Pane after Save: "In Equazia as … · v.1" | Every save is a version, kept with the matter |
| 3 | Confirm this brief finished: the cite table with several rows and flags | Every citation in the brief, checked against the matter |
| 4 | A row clicked: the cite selected in the Word page, the open row showing title, page and "Open in Equazia" | Click a row and Word finds the citation |
| 5 | The open row with initials "MS", Confirmed, and the Word comment visible in the margin | Sign off each citation with your initials |
