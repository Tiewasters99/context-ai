# Partner Center submission sheet: Equazia for Word

Field by field, in the order of Microsoft's step-by-step guide
(https://learn.microsoft.com/en-us/partner-center/marketplace-offers/add-in-submission-guide).
Microsoft says to expect four to six weeks and more than one submission.

Before starting (EDEN):
- [ ] PR merged and deployed, so https://www.equazia.ai/support and the new Privacy section are live.
- [ ] Privacy section approved (docs/appsource/PRIVACY-ADDITION.md) and its `UPDATED` date bumped.
- [ ] Sign-up decision made (POLICY-CHECKLIST 1100.5: `SIGNUPS_OPEN = false` in src/pages/Auth.tsx).
- [x] Word-version decision made: WordApi 1.4 (Word 2021 / Microsoft 365); Word 2016/2019 excluded (POLICY-CHECKLIST 1120.3).
- [ ] Tested on Word for Mac and Word on the web (1120.3).
- [ ] Test account `appsource-review@equazia.ai` created, subscribed, with the matter "AppSource Review" and its sample cases.
- [ ] Five screenshots taken (docs/appsource/LISTING.md §7).
- [ ] Partner Center account enrolled in the Microsoft 365 and Copilot program, publisher name "Equazia.ai, Inc.".

## Step 1: Select the type of app

- partner.microsoft.com/dashboard → **Marketplace offers** → tab **Microsoft 365 and Copilot** → **+ New offer** → **Office Add-in**.

## Step 2: Name your app

- Name: **Equazia** (must equal manifest `DisplayName`, public/addin/manifest.xml:22). Press **Check availability**. Naming tension (1100.7 / listing guide): LISTING.md §1.
- Publisher: the account whose publisher name reads **Equazia.ai, Inc.** (manifest `ProviderName`, line 20). Cannot be changed after creation.
- **Create**.

## Step 3: Product setup

| Question | Answer | Why |
|---|---|---|
| Will your app be listed in the Apple Store? | **No** | Opting into iOS brings 1120.2 (no purchase UI, no paid-account language; Privacy and Terms pages free of commerce UI; Terms has pricing) |
| Does your app use Microsoft Entra ID or SSO? | **No** | Sign-in is Equazia.ai email + password |
| Does your app require additional purchases? | **Yes** (tick) | An Equazia.ai subscription is required (1100.1). The test account goes in Step 9 |
| Connect lead management CRM? | No (optional) | — |

**Save draft.**

## Step 4: Packages

- Upload `public/addin/manifest.xml` (download the merged copy from https://www.equazia.ai/addin/manifest.xml, or take it from the repo at main).
- Expect "manifest checks passed", Status **Complete**. The same checks were run locally: `npx -y office-addin-manifest validate -p public/addin/manifest.xml` → "The manifest is valid." (full output in POLICY-CHECKLIST.md).
- If the form asks about cryptography (1100.6): the add-in uses HTTPS (TLS) for all traffic and SHA-256 to fingerprint saved files; it implements no cryptography of its own. EDEN confirms the answer.

## Step 5: Properties

| Field | Value |
|---|---|
| Categories (1 to 3) | Productivity; Document management (or the nearest offered) |
| Industries (0 to 2) | Legal if listed; otherwise Professional Services (EDEN picks from the live list) |
| Legal: Standard Contract **or** EULA link | EDEN decides. EULA link: `https://www.equazia.ai/terms`. Standard Contract cannot be undone once published |
| Privacy policy link | `https://www.equazia.ai/privacy` |
| Support document link | `https://www.equazia.ai/support` |

**Save.**

## Step 6: Languages

- **Manage additional languages** → English (United States) only (manifest DefaultLocale en-US, line 21) → **Update**.

## Step 7: Listing (English)

All from docs/appsource/LISTING.md:

| Field | Source |
|---|---|
| Name | LISTING.md §1 |
| Summary (≤100) | LISTING.md §2 |
| Description (HTML) | LISTING.md §3, paste the HTML block |
| Search keywords | LISTING.md §4 |
| Logo | `public/addin/logo-300.png` (300 x 300 PNG; policy 100.3: 216 to 350 px square) |
| Screenshots (≥1) | Eden's five, LISTING.md §7 (1366 x 768 PNG ≤1024 KB per the images guide; 1280 x 720 PNG per policy 100.3; use whichever the uploader states) with the captions there |
| Video (optional) | None. If added: YouTube or Vimeo direct link only (100.3) |

## Step 8: Availability

- EDEN chooses: publish on approval, or a scheduled date. "The Schedule option cannot be changed/updated after the first publish."
- **Save draft.**

## Step 9: Notes for certification

- Paste docs/appsource/NOTES-FOR-CERTIFICATION.md (the part below the line), with the password filled in.
- Do not give an employee's email for sign-in help: "Our reviewers won't be able to contact you for sign-in information."
- Optional: **Additional certification info** accepts a PDF with screenshots of the steps; it persists across submissions.
- If Eden chooses the enterprise route for 1100.5 (sign-up managed by the firm, not in the add-in), say so here, per the FAQ the guide links.

## Step 10: Final check (Microsoft's top five rejection causes)

- [ ] Valid Terms of Use link — https://www.equazia.ai/terms
- [ ] Valid Privacy policy link — https://www.equazia.ai/privacy (names "Equazia for Word")
- [ ] Testing instructions — Step 9
- [ ] Service/account disclosures — description "Requirements" list
- [ ] Additional purchases ticked (Step 3) and disclosed in the description

Then **Review and publish** → submit. Microsoft: "Expect a response within three to four business days from our reviewers if there are any issues."
