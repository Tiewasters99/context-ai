# Notes for certification (paste into Partner Center → Review and publish → Notes for certification)

Before pasting: Eden fills in the password, confirms the test account has an
active subscription and the matter "AppSource Review" with the sample
documents, and deletes this paragraph. Text below the line is the paste.

---

Equazia connects a Word document to a legal matter stored in Equazia.ai. An Equazia.ai account with a paid subscription is required; the test account below has one.

TEST ACCOUNT
Email: appsource-review@equazia.ai
Password: <Eden fills in>
Sign-in is email and password in the task pane. There is no single sign-on and no Microsoft sign-in.

The account contains a matter named "AppSource Review" holding the cases a sample brief cites. Any .docx that cites cases works; a brief citing the cases in that matter shows the most.

STEPS (Word on Windows, Mac or the web)
1. Open any .docx in Word.
2. Home tab → Equazia. The task pane opens.
3. Sign in with the account above.
4. The pane shows "Not in Equazia yet" and the list of matters. Choose "AppSource Review".
5. Leave the label as "v.1" and press Save to Equazia. The pane then shows the document as in Equazia, v.1.
6. Press Confirm this brief. Progress is shown; when it finishes, one row appears per citation, each with where it was found (title and page) or "not in the matter".
7. Click a row. Word selects that citation in the document and scrolls to it.
8. Open the row. It shows the authority's title and page, with "Open in Equazia" to view it in the browser at that page.
9. Type "MS" in the "initials" box above the rows, then press Confirm on the open row. The row is marked confirmed.
10. Optional: tick "Also add a Word comment on this cite" before pressing Confirm (shown on Word versions supporting Word API 1.4). A Word comment recording the reading is added on that citation; the crossed-comment button beside Confirm/Problem removes it.

WHAT THE ADD-IN WRITES TO THE DOCUMENT
Nothing in the text, unless the comment box in step 10 is ticked. When the user chooses a matter and presses Save to Equazia (steps 4 and 5), it stores the document's Equazia identifier and matter identifier as custom document properties, and the chosen matter in the add-in's document settings, so the file is recognised when reopened. Nothing is sent to Equazia until Save to Equazia or Confirm this brief is pressed.

New users create an account from the link on the sign-in screen ("Create one at www.equazia.ai"), which opens https://www.equazia.ai/auth.

Support: https://www.equazia.ai/support
Privacy: https://www.equazia.ai/privacy
Terms: https://www.equazia.ai/terms
