// The Orchestrator's field guide — how Equazia.ai itself works, room by room,
// kept as data the model looks up instead of prose it is asked to remember.
//
// Why (Eden, 2026-11-04): "Nothing is more frustrating than an in-app
// assistant that doesn't understand the app." The Orchestrator has no memory
// between turns; everything it knows about the app is assembled per turn from
// lib/orchestrator-system.mjs, whose header rightly says keep it short. A
// site's worth of "how do I…" answers cannot live there, so they live here:
// one entry per question people actually ask, in the Orchestrator's own voice,
// found by app_guide when the question is about the app rather than the
// documents. The entries ship with the code, so the guide describes the build
// that is live, and scripts/_test-orchestrator-guide.mjs keeps every route in
// it real and every answer inside the asking account's plan.
//
// Writing an entry: say where the thing is, then the steps, then the one
// thing people get wrong. Short sentences. No feature is described that is
// not on main. Every "how do I" Eden asks in a session becomes an entry in
// the same PR as the answer.

import { canOpenPathname } from './surfaces.mjs';

/**
 * @typedef {object} GuideEntry
 * @property {string} id        stable slug
 * @property {string} title     what the entry answers, as a short heading
 * @property {string[]} routes  the rooms it concerns (plan gating; [] = everywhere)
 * @property {string[]} asks    phrasings people use, for the lookup
 * @property {string} text      the answer, in the Orchestrator's voice
 */

/** @type {GuideEntry[]} */
export const GUIDE = [
  {
    id: 'move-documents-sub-matter',
    title: 'Move a group of documents into a sub-matter (folder)',
    routes: ['/app/vault', '/app/matterspace/<id>'],
    asks: [
      'how do I move a group of documents from a matter to a sub-matter',
      'move all these documents into a folder',
      'put the docket in its own sub-matter',
      'organize the files into folders',
      'move many documents at once',
      'bulk move documents',
    ],
    text:
      'In the Vault, open the matter the documents are in. Above the list is a Folders row: ' +
      'its chips are this matter\'s sub-matters, and "New folder" makes one (a folder IS a sub-matter — ' +
      'the same thing under two names). Press "Select all" in that row to take every document in the ' +
      'listing, or select a run: click one document\'s corner check, then hold the mouse down on it and ' +
      'sweep down the list to the last one; Shift-click another check takes the range; Ctrl-click adds ' +
      'or removes one. A plain click still opens the document, and clicking the background leaves the ' +
      'selection alone — Esc or Clear empties it. Then drag any selected document onto the folder chip ' +
      '(or onto the sub-matter in the sidebar); the whole selection moves. Right-click → Cut, then ' +
      'right-click the folder → Paste, does the same, as do Ctrl+X and Ctrl+V. Documents move whole: ' +
      'text, page citations and the stored file follow, and the move is written to the matter\'s Record. ' +
      'A sealed matter refuses a move that would carry a document out of the seal. ' +
      'In this panel, move_document proposes ONE document at a time, so for a batch send them to the ' +
      'Vault selection rather than proposing moves one by one.',
  },
  {
    id: 'select-many-documents',
    title: 'Select several documents in the Vault',
    routes: ['/app/vault'],
    asks: [
      'how do I select multiple documents',
      'select all documents',
      'selecting more than one file',
      'I keep losing my selection',
    ],
    text:
      'The Vault selects like File Explorer. Each row has a small corner check at its left: click it to ' +
      'select that document; hold the mouse down on a check and sweep down (or up) the list to select ' +
      'everything you pass; Shift-click a second check for the range between; Ctrl-click to add or ' +
      'remove one. "Select all" in the Folders row above the list takes the whole listing (a search box ' +
      'filter narrows what it takes), and Ctrl+A does the same while the pointer is over the list. ' +
      'Dragging a box across empty space catches what it touches. A plain click on a document opens it ' +
      'rather than selecting it; a click on the background leaves the selection as it was. Esc or the ' +
      'Clear button empties it. Dragging any selected document carries the whole selection.',
  },
  {
    id: 'new-folder-sub-matter',
    title: 'Make a folder (sub-matter) inside a matter',
    routes: ['/app/vault', '/app/matterspace/<id>'],
    asks: [
      'how do I create a folder',
      'add a sub-matter',
      'make a subfolder for exhibits',
      'what is the difference between a folder and a sub-matter',
    ],
    text:
      'A folder and a sub-matter are the same thing: a matter nested inside another, with its own ' +
      'Vault, tabs and Record, inheriting the parent\'s seal. In the Vault, "New folder" in the Folders ' +
      'row above the list makes one inside the open matter; on the matter\'s own page, its sub-matters ' +
      'are listed and the sidebar shows them nested under the parent. From this panel, ' +
      'create_sub_matter proposes one for the user to confirm when they are inside a matter.',
  },
  {
    id: 'cut-copy-paste-documents',
    title: 'Cut, copy and paste documents between matters',
    routes: ['/app/vault'],
    asks: [
      'how do I copy a document to another matter',
      'cut and paste files',
      'paste into a folder',
    ],
    text:
      'Right-click a document in the Vault (or a selection of them): Cut moves, Copy copies. Then ' +
      'right-click the destination — a folder chip above the list, or a matter in the sidebar — and ' +
      'choose "Paste … into <name>". Ctrl+X, Ctrl+C and Ctrl+V work the same way, Ctrl+V pasting into ' +
      'the matter that is open. The paste runs under the same SecureSpace checks as a drag: a sealed ' +
      'document cannot be pasted out of its seal. A copy is a second filed document; the original stays.',
  },
  {
    id: 'work-in-word-import',
    title: 'Edit a Word document in Word and bring the edit back',
    routes: ['/app/document/<id>', '/app/vault'],
    asks: [
      'how do I edit a docx in Word',
      'open this in Word',
      'work in Word',
      'import from Word',
      'save a new version of a Word document',
      'versions of a document',
    ],
    text:
      'Open the .docx in the document reader. Its toolbar has "Work in Word" and "Import from Word" ' +
      'side by side (also in the Vault row\'s right-click menu, and in the phone "more" menu). Work in ' +
      'Word puts a tagged copy of the file in the browser\'s Downloads folder; open it in Word, edit, ' +
      'save. Import from Word opens a file picker: choose the edited file, give the version a label ' +
      '(prefilled, e.g. "v.2"), Save. The file becomes the document\'s current version — re-read and ' +
      're-indexed — and every earlier version stays under the History (versions) button. The tag inside ' +
      'the file is how Equazia knows which document it is; a file tagged for another document is ' +
      'refused, an untagged file is accepted with a caution. There is no autosave: each Save in Equazia ' +
      'is an explicit version. The Equazia for Word add-in (AppSource) does the same from inside Word.',
  },
  {
    id: 'upload-progress-line',
    title: 'What the progress bar under a new upload means',
    routes: ['/app/vault'],
    asks: [
      'why does my upload take so long',
      'what does indexed OCR\'d citable mean',
      'the document says extracting',
      'can I open a document before it finishes',
    ],
    text:
      'A document you file is read page by page, OCR\'d where it is a scan, and indexed so it can be ' +
      'searched and cited by page — the bar under it shows how far that has got, and its line reads ' +
      '"indexed, OCR\'d, citable". A plain file store does none of this, which is why a drop into ' +
      'OneDrive is instant and this is not. A PDF can be opened and read as soon as its bytes have ' +
      'landed ("Open now" on the row); search and citations wait for the index. check_ingest_status ' +
      'gives the real picture for one document; a row showing an error can be re-queued with ingest_document.',
  },
  {
    id: 'reader-light-dark',
    title: 'Light and dark reading in the document reader',
    routes: ['/app/document/<id>'],
    asks: [
      'how do I switch to dark mode',
      'light mode for reading',
      'the page is too bright',
      'where is the theme toggle',
    ],
    text:
      'In the document reader the last control on the toolbar, at the far right, is a sun or moon: it ' +
      'switches the reading surface between parchment and dark, and the choice is remembered in this ' +
      'browser. On a narrow window the toolbar\'s right end can be cut off; widen the window or use the ' +
      'phone "more" menu. The Brief Desk does not yet have the toggle.',
  },
  {
    id: 'second-factor-sealed-only',
    title: 'When a second factor (two-factor code) is asked for',
    routes: [],
    asks: [
      'why am I being asked for a code',
      'two factor authentication',
      'do I need an authenticator app',
      'this matter is sealed confirm it\'s you',
    ],
    text:
      'A second factor — an authenticator app or a passkey — is needed only to open a sealed matter. ' +
      'Nothing else in Equazia.ai requires one. Opening a sealed matter without one shows "This matter ' +
      'is sealed. Confirm it\'s you." in place of the matter; confirming once keeps sealed matters open ' +
      'for the rest of the session. Someone with no factor is pointed to Settings → Account → Second ' +
      'factor, where adding one takes a minute. A matter inside a sealed parent is sealed by inheritance, ' +
      'so it asks too. The sidebar does not list sealed matters until the factor is confirmed; a green ' +
      'strip at the top says so and offers Confirm.',
  },
];

/** The tool the Orchestrator calls. Pure lookup; nothing leaves the matter. */
export const GUIDE_TOOL = Object.freeze({
  name: 'app_guide',
  description:
    'Look up how Equazia.ai itself works: where a control is, the steps to do something in the app, ' +
    'what a button or a bar means. Call it BEFORE answering any question about the app (not about ' +
    'the documents) — "how do I move these files", "where is dark mode", "why is it asking for a code". ' +
    'It returns the team\'s own written answer, which beats recollection. If it returns nothing, say ' +
    'the guide has no entry yet, answer from the map if it covers the point, and offer relay_feedback.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The user\'s question about the app, in their words.' },
    },
    required: ['question'],
    additionalProperties: false,
  },
});

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'into', 'on', 'for', 'and', 'or', 'is', 'it',
  'how', 'do', 'i', 'my', 'me', 'can', 'we', 'this', 'that', 'these', 'those', 'from', 'with', 'at',
  'what', 'where', 'why', 'does', 'be', 'are', 'there', 'you', 'your', 'our']);

/** Lower-case word stems, stop words out, trailing s/es/ing/ed trimmed crudely. */
export function guideTokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9+]+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, (m, _p, off) => (off > 3 ? '' : m)));
}

/** Entries the plan may be told about: every route in the entry opens for it. */
export function guideForPlan(plan) {
  if (!plan) return GUIDE;
  return GUIDE.filter((e) => e.routes.every((r) => canOpenPathname(r.replace(/<[^>]+>/g, 'x'), plan)));
}

/** Titles only, for the system prompt. */
export function guideIndex(plan) {
  return guideForPlan(plan).map((e) => e.title);
}

/**
 * The best entries for a question — by overlap between the question's tokens
 * and each entry's title + asks (weighted) + text. Never more than three, and
 * none that shares nothing with the question.
 */
export function lookupGuide(question, plan, limit = 3) {
  const q = new Set(guideTokens(question));
  if (q.size === 0) return [];
  const scored = guideForPlan(plan).map((e) => {
    const head = new Set(guideTokens(`${e.title} ${e.asks.join(' ')}`));
    const body = new Set(guideTokens(e.text));
    let score = 0;
    for (const t of q) {
      if (head.has(t)) score += 3;
      else if (body.has(t)) score += 1;
    }
    return { e, score };
  }).filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.e);
}

/** What the tool returns. */
export function renderGuide(entries) {
  return entries.map((e) => `${e.title}\n${e.text}`).join('\n\n');
}

/** The prompt paragraph, with the index, added when app_guide is on the menu. */
export function guidePromptBlock(plan) {
  const titles = guideIndex(plan);
  return 'THE FIELD GUIDE\n\n' +
    'For how the app itself works — where a control is, the steps to do something, what a bar or a ' +
    'button means — call app_guide before answering; the guide is written by the team room by room ' +
    'and beats recollection. Answer from what it returns, in your own words, at the length the ' +
    'question deserves. If it returns nothing, say the guide has no entry yet, answer from the map ' +
    'if the map covers it, and offer to pass the gap along with relay_feedback so an entry gets ' +
    'written. It currently covers: ' + titles.join('; ') + '.';
}
