# AppSource policy checklist: Equazia for Word (2026-11-02)

Rules read on 2026-11-02 from:
- P = Microsoft Marketplace certification policies, https://learn.microsoft.com/en-us/legal/marketplace/certification-policies (sections 100, 1100, 1120; also 1000.5, which the checklist points to)
- G = submission guide, https://learn.microsoft.com/en-us/partner-center/marketplace-offers/add-in-submission-guide
- C = publishing checklist, https://learn.microsoft.com/en-us/partner-center/marketplace-offers/checklist
- L = listings guide, https://learn.microsoft.com/en-us/partner-center/marketplace-offers/create-effective-office-store-listings
- I = store images guide, https://learn.microsoft.com/en-us/partner-center/marketplace-offers/craft-effective-appsource-store-images
- V = manifest validation, https://learn.microsoft.com/en-us/office/dev/add-ins/testing/troubleshoot-manifest#microsoft-365-and-copilot-store-validation

Status: **PASS** = met in this branch; **FIX** = changed in this PR (pending approval where noted); **EDEN** = needs Eden (a decision, a test on a device, or something outside the repo).

## Section 100: general

| Policy | Rule (one line) | Status | Evidence |
|---|---|---|---|
| 100.1 | Listing clearly and accurately communicates value and requirements; one distinct product. | PASS | docs/appsource/LISTING.md §3 |
| 100.1.1 | Accurate, descriptive title; title on own website matches Marketplace. | EDEN | Name "Equazia" = manifest DisplayName (public/addin/manifest.xml:22). L asks for a descriptive "Function for Brand" name and 1100.7 restricts brand in the title. LISTING.md §1 |
| 100.1.2 | Summary, at most 100 characters. | PASS | LISTING.md §2 (94 characters) |
| 100.1.3 | Description names audience, value, supported Microsoft products, prerequisites; no comparative marketing. | PASS | LISTING.md §3: audience, Word on Windows/Mac/web + Microsoft 365, account + subscription prerequisite; no competitor named |
| 100.2 | Categories and industries accurate; description relevant to them. | EDEN | LISTING.md §5 (Productivity; Legal if offered). Eden picks from the live list |
| 100.3 | Logo .png 216 to 350 px square; images 1280x720 .png; good quality. | FIX (logo) / EDEN (screenshots) | public/addin/logo-300.png (300 x 300 PNG). Screenshots not taken; I says ≥1 image 1366 x 768 ≤1024 KB, P 100.3 says 1280 x 720 PNG; LISTING.md §7 |
| 100.4 | Listing must accurately describe pricing "including currency", extra charges, dependencies on other services/accounts; no redirect or up-sell outside Marketplace in the listing. | **EDEN** | LISTING.md §3 "Requirements" discloses the Equazia.ai account + paid subscription and links it, as C Step 7 requires, but names no price or currency. Eden: add the plan price in USD to the Requirements list, or accept that the reviewer may ask for it. The link could be read as a redirect under the same rule; fallback noted in LISTING.md §3 |
| 100.5 | Terms, privacy policy, documentation, links functional and safe. | PASS | https://www.equazia.ai/terms (src/pages/Terms.tsx), /privacy (src/pages/Privacy.tsx), /support (src/pages/Support.tsx, new). No link downloads a file |
| 100.6 | Listing links to the offer's privacy policy; no third-party personal information. | FIX, pending approval | Privacy section for the add-in: src/pages/Privacy.tsx:104-130; docs/appsource/PRIVACY-ADDITION.md |
| 100.7 | Content original or licensed; follow Microsoft trademark guidelines; no business-program references. | PASS | Logo from the Equazia icon (public/icon-512.png). "Word", "Microsoft 365" used only to name supported products |
| 100.8 | Significant value; not a simple utility. | PASS | Save to Equazia (versions in the matter) + Confirm this brief (citation check with sign-off) |
| 100.10 | No inappropriate content. | PASS | n/a for a legal work tool |
| 100.11 | Secure; no unexpected executable code; no credentials in the listing. | PASS | HTTPS only (manifest SourceLocation line 40); no credentials in LISTING.md; test password goes only in Notes for certification |
| 100.12 | Delivers what the listing says; UI not unfinished; loading indicators on long waits. | PASS, EDEN to confirm on device | Confirm shows staged progress (spec WORD-ADDIN §Confirm); listing claims checked against src/addin/AddinPane.tsx (row open = title/page + "Open in Equazia", not an in-pane Reader) |
| 100.13 | Right offer type, targeting, billing configuration. | EDEN | Partner Center: Office Add-in offer; "additional purchases" ticked (SUBMISSION-SHEET Step 3) |
| 100.14 | Submission includes instructions and resources for certification. | FIX / EDEN | docs/appsource/NOTES-FOR-CERTIFICATION.md. EDEN: create the test account, its subscription, the "AppSource Review" matter and its sample cases; fill in the password |
| 100.15 | Supporting documents contain no credentials or confidential data. | PASS | No optional PDF planned; if one is added, no credentials in it |

## Section 1100: Microsoft 365

| Policy | Rule (one line) | Status | Evidence |
|---|---|---|---|
| 1100.1 | Listing describes only this add-in; discloses charged features. | PASS | LISTING.md §3 |
| 1100.1 | Tick "requires purchase of a service" on Product setup if applicable. | EDEN | SUBMISSION-SHEET.md Step 3: tick it (subscription required) |
| 1100.1 | Clear value proposition and seamless first run; value clear before sign-in. | PASS, EDEN to judge | Sign-in screen says what the pane is (src/addin/AddinPane.tsx ~159-161); manifest GetStarted strings. Eden may want one line on the sign-in screen naming Save / Confirm before sign-in |
| 1100.3 | No selling on mobile. | PASS | Mobile not opted in (SUBMISSION-SHEET Step 3: Apple Store = No) |
| 1100.4 | No unexpected changes to the document. | PASS | Writes only on user action: custom properties on Save (src/addin/office.ts:197-206), the matter setting when a matter is picked (office.ts:134, AddinPane.tsx pickMatter), comments only when ticked (AddinPane.tsx:658-662, office.ts:168). All disclosed in Privacy and Notes |
| 1100.4 | Nothing launched outside the add-in without explicit permission. | PASS | Browser opens only on a click: "Open in Equazia", the sign-up link (AddinPane.tsx:175) |
| 1100.4 | Never ask for Microsoft credentials except via approved OAuth. | PASS | Sign-in asks for the Equazia.ai email + password only (AddinPane.tsx SignIn) |
| 1100.5 | Consent before publishing personal information. | PASS | Add-in publishes nothing |
| 1100.5 | No transmitting customer content without notifying the user. | PASS | Content leaves Word only on Save to Equazia / Confirm this brief, both explicit buttons; stated in Privacy (Privacy.tsx:104-130) |
| 1100.5 | Valid HTTPS. | PASS | Validator: "Secure Desktop Source Location", "Secure Icon URL" (below) |
| 1100.5 | Pop-ups only on explicit user action, not blocked by default blocker. | PASS | All openUrl calls are click handlers; office.ts:213-218 uses Office.context.ui.openBrowserWindow first, window.open fallback |
| 1100.5 | No unreasonably high permissions. | PASS | `ReadWriteDocument` (manifest:42), needed for comments and custom properties; not full control |
| 1100.5 | Correctly sized and formatted icon in the manifest. | FIX | HighResolutionIconUrl pointed at the 80 px icon; store validator failed it ("Icon size should be 64*64"). Now icon-64.png (manifest:25); validator passes |
| 1100.5 | Clear and simple sign in / sign out / sign-up for external accounts. | FIX + **EDEN** | Sign-up line is now a real link (AddinPane.tsx:141, 171-176) opening https://www.equazia.ai/auth. **But** src/pages/Auth.tsx:12 has `SIGNUPS_OPEN = false`: the Sign Up tab says onboarding is by invitation and to email info@equazia.ai, and Supabase sign-ups are disabled. A reviewer following the link will not find a self-serve sign-up. Eden: open sign-ups (flip the flag + Supabase setting) before submitting, or declare the offer as targeting organisations (1100.5 enterprise carve-out, see FAQ link in C) in the Notes. `/auth` also has no parameter to open on the Sign Up tab |
| 1100.6 | Declare cryptography use on the form. | EDEN | TLS (HTTPS) only, plus SHA-256 hashing of saved files for integrity (WORD-ROUNDTRIP spec, document_versions.sha256). SUBMISSION-SHEET has the suggested answer |
| 1100.7 | Language support specified in manifest; primary language matches. | PASS | DefaultLocale en-US (manifest:21); listing in English (United States) |
| 1100.7 | Title may not include brand or service unless enterprise-targeted. | EDEN | See 100.1.1 and LISTING.md §1 |
| 1100.7 | Not a duplicate of an add-in already submitted. | PASS | First submission |
| 1100.8 | Pricing changes preserve existing users' functionality. | PASS (n/a at v1) | — |

## Section 1120: Office Add-ins

| Policy | Rule (one line) | Status | Evidence |
|---|---|---|---|
| 1120.1 | Use the Microsoft-hosted Office.js. | PASS | addin.html:15 `https://appsforoffice.microsoft.com/lib/1/hosted/office.js` |
| 1120.1 | Latest released manifest schema. | PASS | Validator: "Valid Manifest Schema" |
| 1120.1 | Valid Support URL in the add-in only manifest. | FIX | manifest:26 → https://www.equazia.ai/support (validator: "valid and reachable"; note the URL already returns 200 through the site's catch-all rewrite, so the Support page itself is live only after this PR deploys) |
| 1120.1 | High-resolution icon mandatory. | FIX | manifest:25 icon-64.png (64 x 64) |
| 1120.1 | SourceLocation points to a valid address. | PASS | manifest:40 https://www.equazia.ai/addin; validator "source location URLs are valid" |
| 1120.1 | Version incremented on updates. | PASS (first submission) | manifest:19 `1.0.0.0`; bump on every later package |
| 1120.2 | iOS/Android: no purchase UI, no "free", privacy/terms pages free of commerce UI. | PASS by not opting in | Do not opt in to mobile / Apple Store. Terms page contains pricing, so opting in would fail this rule. The validator lists "Word on iPad" as a platform the manifest allows; mobile is opt-in on the form |
| 1120.3 | Follow design guidelines; work in the browsers Office uses. | **EDEN (risk)** | Manifest requires only WordApi 1.1, so the validator says the add-in "will be tested" on Word 2016 and 2019 on Windows. Perpetual Word 2016/2019 can run add-ins in Internet Explorer 11 (Trident) or legacy Edge; the pane is a modern Vite/React bundle and is not built for IE11. Options: raise the requirement (e.g. WordApi 1.3, which the custom-property tag already needs) so those hosts do not offer the add-in, or test there. Not changed here because the brief said keep WordApi 1.1 unless the validator objects; it did not |
| 1120.3 | All features work touch-only. | EDEN | Everything is buttons, checkboxes and text inputs; no hover-only or keyboard-only control seen in AddinPane.tsx. Test on a touch device |
| 1120.3 | No deprecated functionality. | PASS | getFileAsync, Word.run, settings, customProperties, insertComment are current APIs |
| 1120.3 | Compatible with latest Edge, Chrome, Firefox, Safari (macOS) — Word on the web. | EDEN | Test Word on the web in all four |
| 1120.3 | Works in every host in Hosts. | PASS | Hosts = Document (Word) only (manifest:32) |
| 1120.3 | Supports Office on the web and Mac. | **EDEN** | Not yet tested on Mac or on the web. Mac testing must be done before submission |
| 1120.3 | Task pane add-ins using the add-in only manifest must support add-in commands. | PASS | VersionOverrides PrimaryCommandSurface button on the Home tab (manifest:44-80) |
| 1120.3 | SSO: notes + fallback. | PASS (n/a) | No SSO; Notes say so |
| 1120.4 / 1120.5 | Outlook / Excel custom functions. | n/a | Word only |
| 1000.5 | Linked SaaS offer: same publisher. | n/a unless linked | Only if Eden links a SaaS offer later |

## Other items from C and G

| Item | Status | Evidence |
|---|---|---|
| ProviderName matches Partner Center publisher name (C Step 3, G Step 2) | EDEN | manifest:20 "Equazia.ai, Inc."; the Partner Center publisher must read the same |
| App name in Partner Center matches DisplayName (G Step 2, L) | EDEN | "Equazia" both places |
| EULA link or Standard Contract (G Step 5, C Step 6) | EDEN | https://www.equazia.ai/terms, or tick Microsoft's Standard Contract (irreversible once published) |
| Privacy policy separate from Terms (C Step 6) | PASS | /privacy and /terms are separate pages |
| Support link is an https URL, not an email (C Step 6) | PASS | https://www.equazia.ai/support |
| Accessibility (C) | EDEN | Not audited in this PR |
| Partner Center account in the Microsoft 365 and Copilot program (C, G Step 1) | EDEN | Not created here |
| Store logo matches manifest icon (L) | PASS | Both from public/icon-512.png |

## Validator output (verbatim)

Command: `npx -y office-addin-manifest validate -p public/addin/manifest.xml` (production store validation, per V). Run 2026-11-02 against this branch's manifest. Before the fix it ended:

```
Error #1: 
Incorrect High Resolution Icon Dimensions: The manifest high resolution icon dimensions are incorrect.
  - Details: Icon incorrectly Sized - Your icon Width*Height is: 80*80. Icon size should be 64*64

The manifest is not valid.
```

After the fix (no errors, no warnings):

```
Validation Information: 
Manifest ID Valid Prefix: The product ID in the manifest has a valid prefix
  - Details: b0260b0e-fcca-41bf-b897-35fc551e5a21

Manifest ID Correct Structure: The structure of the product ID is correct.
  - Details: b0260b0e-fcca-41bf-b897-35fc551e5a21

Package Type Identified: Package of your add-in was parsed successfully.

Correct Package: Your package matches the submission type.

Valid Manifest Schema: Your manifest does adhere to the current set of XML schema definitions for Add-in manifests.

Manifest Version Correct Structure: The manifest version number has the correct structure for the platform that it supports.

Manifest Version Correct Value: The manifest version number is greater or equal to 1.0.

Desktop Source Location Present: A desktop or default source location URL is found.

Secure Desktop Source Location: The manifest desktop source location URLs use HTTPS.

The manifest source location URLs are valid.: The manifest source location URLs are valid.

Supported Office Identified: Supported Office products were successfully determined.

Support URL Present: The manifest support URL is present.
  - Details: https://www.equazia.ai/support

Valid and reachabe Support URL: The manifest support URL is valid and reachable.
  - Details: https://www.equazia.ai/support

Valid OnlineMeetingCommandSurface ExtensionPoint.: OnlineMeetingCommandSurface ExtensionPoint extracted from manifest is found to be valid.

Valid Manifest Resource Urls: The manifest Resource URLs are valid.

Valid Manifest AppDomain Urls: The manifest AppDomain URLs are valid.

High Resolution Icon Present: A high resolution icon element was expected and is present.
  - Details: https://www.equazia.ai/addin/icon-64.png

Supported High Resolution Icon URL File Extension: The manifest high resolution icon URL has a valid image file extension.
  - Details: png

Secure High Resolution Icon URL: The manifest high resolution icon URL uses HTTPS.
  - Details: https://www.equazia.ai/addin/icon-64.png

Correct High Resolution Icon Dimensions: The manifest high resolution icon dimensions are correct.

Icon Present: A icon element was expected and is present.
  - Details: https://www.equazia.ai/addin/icon-32.png

Supported Icon URL File Extension: The manifest icon URL has a valid image file extension.
  - Details: png

The manifest icon URL uses HTTPS.: Secure Icon URL
  - Details: https://www.equazia.ai/addin/icon-32.png

Correct Icon Dimensions: The manifest icon dimensions are correct.

All GetStarted strings are present in Resources: All GetStarted strings are present in Resources

Acceptance Test Completed: Acceptance test service has finished checking provided add-in.


Based on the requirements specified in your manifest, your add-in can run on the following platforms; your add-in will be tested on these platforms when you submit it to the Office Store:
  - Word on iPad
  - Word on Mac (Microsoft 365)
  - Word 2016 or later on Mac
  - Word 2019 or later on Mac
  - Word on the web
  - Word 2016 or later on Windows
  - Word 2019 or later on Windows
  - Word on Windows (Microsoft 365)
Important: This analysis is based on the requirements specified in your manifest and does not account for any runtime JavaScript calls within your add-in. For information about which API sets and features are supported on each platform, see Office Add-in host and platform availability. (https://docs.microsoft.com/office/dev/add-ins/overview/office-add-in-availability).

*This does not include mobile apps. You can opt-in to support mobile apps when you submit your add-in.

The manifest is valid.
```

Note: the validator checks the icon at its live URL. `icon-64.png` already exists on production (it shipped with PR #504), so the pass is real before this PR deploys. The "reachable" support check passes today only because the site's catch-all rewrite serves the landing page at /support; the Support page itself appears once this PR is deployed.
