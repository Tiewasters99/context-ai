# Privacy page: the Equazia for Word section (FOR EDEN'S APPROVAL)

Status: **DRAFT, awaiting Eden's approval.** Added to `src/pages/Privacy.tsx`
(lines 104 to 130, between "Integrations you switch on" and "What we do not
do"), delimited by `BEGIN` / `END` comments. Nothing else in the policy was
changed.

## Why it is needed

Microsoft's submission checklist (Step 6) and submission guide (Step 5) say the
privacy policy linked from the listing must include:

1. "Information on your policies regarding users' personal information."
2. "A reference to the app OR your service overall, not only your website."
3. "A description of your service that includes the name of the app you're submitting."
4. "A valid link that doesn't generate a 404 error."

The existing page already covers (1) and refers to the service, not only the
website (2). It did not name the add-in (3). This section names it, and states
exactly what the add-in sends and stores. (4): https://www.equazia.ai/privacy
returns 200.

Terms of Use are separate, as the checklist requires ("A Terms of Use policy
isn't considered a privacy policy"): `src/pages/Terms.tsx`, served at
https://www.equazia.ai/terms (route in `src/App.tsx`, `/terms`).

## The text (as it appears on the page)

### Equazia for Word (the Word add-in)

Equazia for Word is a task pane that runs inside Microsoft Word as a page
served from www.equazia.ai. It signs in with your Equazia.ai account (email and
password); it does not ask for your Microsoft account.

When you press **Save to Equazia** or **Confirm this brief**, the add-in sends
the contents of the open document to Equazia.ai. Save to Equazia stores the
document in the matter you chose, as a new version, under the same rules as a
file uploaded on the website: the same per-matter access, the same storage, the
same Record. Confirm this brief reads the document's citations and checks them
against that matter as described under AI models above. Nothing is sent until
you press one of those buttons.

The add-in writes nothing into the text of your document except Word comments
you explicitly ask it to add. To recognise the document the next time it is
opened, it stores a document identifier (and the matter's identifier) as custom
document properties inside the .docx, and remembers the matter you chose in the
add-in settings saved with the document.

No information goes to Microsoft from the add-in beyond what Office itself
collects as part of running add-ins (Office's own telemetry, under Microsoft's
terms).

## Points for Eden to check before approving

- **Two facts added beyond the brief I was given**, because the code does them:
  (a) the matter's identifier is stored as a second custom property
  (`EquaziaMatterId`, `src/addin/office.ts` ~line 197); (b) the chosen matter
  is remembered in the add-in's Office settings, which Word saves inside the
  document (`Office.context.document.settings.saveAsync`, `src/addin/office.ts`
  line 134). Leaving either out would make the "writes nothing" sentence
  inaccurate.
- "Confirm this brief ... as described under AI models above": Confirm sends
  passages to a model provider through `/api/llm` exactly as the Desk does; the
  sentence points to the existing AI models section rather than restating it.
- **Bump the date.** `UPDATED` at the top of `src/pages/Privacy.tsx` still
  reads "26 October 2026". The policy's own "Changes" section says the date
  changes when the page changes. Not bumped here so that the date is set on the
  day Eden approves.
