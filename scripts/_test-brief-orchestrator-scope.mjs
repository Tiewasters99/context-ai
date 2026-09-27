// The Brief Desk binds the Orchestrator to the RECORD, and tells it about the
// brief (09-27: bound to the case's own folder, "Disability", it said it could
// not look into DeCamara and offered to move documents).
//
//   A. the system prompt: with `brief`, the desk section is present, the
//      record matter is named as the bound one, A-cites are explained, the
//      Vault offers stand down; without it, none of that; the route reads as
//      the Brief Desk.
//   B. nearestCommonAncestor: sibling folders → their parent; one id → itself;
//      an unknown id is ignored; no shared ancestor → null.
//   C. the surface layer: what the desk publishes wins over what the pane's
//      Reader publishes, for the matter only; the Reader's document survives.
//   D. wiring, read from source: the desk's Ask binds to the record root,
//      never the pane document's matter; the desk clears the surface on
//      unmount; the API forwards the brief block, bounded.
//
//   node --test --import ./scripts/_node-src-loader.mjs scripts/_test-brief-orchestrator-scope.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildOrchestratorSystem } from '../lib/orchestrator-system.mjs';
import { nearestCommonAncestor, isSealedIn } from '../src/lib/matter-tree.ts';
import {
  setOrchestratorContext, clearOrchestratorContext, setSurfaceContext, clearSurfaceContext, getOrchestratorContext,
} from '../src/lib/orchestrator-context.ts';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('A. the system prompt names the record and explains the desk', () => {
  const sys = buildOrchestratorSystem({
    matterId: 'm-root', matterName: 'DeCamara v. Bryn Mawr', route: '/app/brief/5ad0',
    brief: {
      title: 'DeCamara-Appellants-Opening-Brief',
      caption: 'Nos. 26-2097 & 26-2098 IN THE UNITED STATES COURT OF APPEALS FOR THE THIRD CIRCUIT',
      recordMatterName: 'DeCamara v. Bryn Mawr',
      appendixMatterName: 'Appeal – Joint Appendix (FINAL, frozen 2026-09-26)',
      casesMatterName: 'Appeal',
      citesChecked: 145,
    },
  });
  assert.match(sys, /ON THE BRIEF DESK/);
  assert.match(sys, /You are on the Brief Desk\. A brief has been filed here/, 'it is told where it is and that a brief is filed');
  assert.match(sys, /Your first job in this room is that brief: help research it, edit it and revise it\./, 'its primary job');
  assert.match(sys, /Ordinary questions about the workspace or the law are welcome too/, 'general questions still welcome');
  assert.match(sys, /You do not edit the brief yourself/, 'proposals, not edits');
  assert.match(sys, /The user is on the Brief Desk \(\/app\/brief\/5ad0\)/);
  assert.match(sys, /On the desk: the brief “DeCamara-Appellants-Opening-Brief”\. Its last check covered 145 cites\./);
  assert.match(sys, /THIRD CIRCUIT/, 'the caption is quoted');
  assert.match(sys, /The record it draws on is the matter “DeCamara v\. Bryn Mawr” — the one you are bound to; search it\./);
  assert.match(sys, /open in the Joint Appendix filed under “Appeal – Joint Appendix \(FINAL, frozen 2026-09-26\)”/);
  assert.match(sys, /"A-10", "JA 1845", "Appx\. 59"/, 'record cites are explained');
  assert.match(sys, /Do not offer to move documents, create sub-matters or re-queue imports from here/);
  assert.match(sys, /They are working inside the matter "DeCamara v\. Bryn Mawr" \(id m-root\)/, 'the bound matter is the record');
});

test('A. without a brief, none of the desk section appears; a title is required', () => {
  const plain = buildOrchestratorSystem({ matterId: 'm', matterName: 'X', route: '/app/matterspace/m' });
  assert.doesNotMatch(plain, /ON THE BRIEF DESK/);
  assert.doesNotMatch(plain, /On the desk/);
  const untitled = buildOrchestratorSystem({ matterId: 'm', brief: { recordMatterName: 'R' } });
  assert.doesNotMatch(untitled, /ON THE BRIEF DESK/, 'no title, no desk');
});

test('A. the desk tells the pen that the reader document is the authority, not the brief', () => {
  const sys = buildOrchestratorSystem({
    matterId: 'm', brief: { title: 'B' }, documentId: 'd1', documentTitle: 'Morgan v. Allison Crane', page: 3,
  });
  assert.match(sys, /IN THE READER/);
  assert.match(sys, /is the authority beside the brief, not the brief itself/);
});

test('B. nearestCommonAncestor', () => {
  const m = [
    { id: 'legal', parent_matterspace_id: null },
    { id: 'dec', parent_matterspace_id: 'legal' },
    { id: 'appeal', parent_matterspace_id: 'dec' },
    { id: 'gb', parent_matterspace_id: 'appeal' },
    { id: 'disability', parent_matterspace_id: 'gb' },
    { id: 'ja-final', parent_matterspace_id: 'dec' },
    { id: 'other', parent_matterspace_id: null },
  ];
  assert.equal(nearestCommonAncestor(m, ['ja-final', 'disability']), 'dec', 'sibling branches meet at the case');
  assert.equal(nearestCommonAncestor(m, ['ja-final', 'appeal']), 'dec');
  assert.equal(nearestCommonAncestor(m, ['disability', 'gb']), 'gb', 'a folder and its child → the folder');
  assert.equal(nearestCommonAncestor(m, ['ja-final']), 'ja-final', 'one id → itself');
  assert.equal(nearestCommonAncestor(m, ['ja-final', 'nope']), 'ja-final', 'an unknown id is ignored');
  assert.equal(nearestCommonAncestor(m, ['ja-final', 'other']), null, 'no shared ancestor');
  assert.equal(nearestCommonAncestor(m, []), null);
});

test('B. isSealedIn: own tier or any ancestor\'s', () => {
  const m = [
    { id: 'legal', parent_matterspace_id: null, ai_tier: 'A' },
    { id: 'dec', parent_matterspace_id: 'legal', ai_tier: 'A' },
    { id: 'ja', parent_matterspace_id: 'dec', ai_tier: 'B' },
    { id: 'vol', parent_matterspace_id: 'ja', ai_tier: 'A' },
    { id: 'silo', parent_matterspace_id: null, ai_tier: 'C' },
  ];
  assert.equal(isSealedIn(m, 'dec'), false);
  assert.equal(isSealedIn(m, 'ja'), true, 'its own tier');
  assert.equal(isSealedIn(m, 'vol'), true, 'inherited from the parent');
  assert.equal(isSealedIn(m, 'silo'), true);
  assert.equal(isSealedIn(m, 'nope'), false);
  assert.equal(isSealedIn(m, null), false);
});

test('D. wiring: a sealed brief is never bound to an open record', () => {
  const desk = read('src/pages/brief/BriefDesk.tsx');
  assert.match(desk, /const briefSealed = isSealedIn\(allMatters, meta\.matterspace_id\)/);
  assert.match(desk, /if \(chosenRootId && keepsTheSeal\(chosenRootId\)\) return chosenRootId;/, 'a kept choice is re-checked against the seal');
  assert.match(desk, /return derived && keepsTheSeal\(derived\) \? derived : meta\.matterspace_id;/, 'a derived root that leaves the seal falls back to the brief\'s matter');
  assert.match(desk, /if \(!keepsTheSeal\(matterId\)\) \{\s*p\.setNotice\('This brief is in a SecureSpace/, 'the picker refuses an open record for a sealed brief');
});

test('C. the surface layer wins for the matter and keeps the reader document', () => {
  clearOrchestratorContext(); clearSurfaceContext();
  setOrchestratorContext({ matterId: 'disability', matterName: 'Disability', documentId: 'd1', documentTitle: 'Morgan', page: 4 });
  setSurfaceContext({ matterId: 'dec', matterName: 'DeCamara v. Bryn Mawr', brief: { title: 'B', recordMatterName: 'DeCamara v. Bryn Mawr' } });
  const ctx = getOrchestratorContext();
  assert.equal(ctx.matterId, 'dec');
  assert.equal(ctx.matterName, 'DeCamara v. Bryn Mawr');
  assert.equal(ctx.documentId, 'd1', 'the pane document is still known');
  assert.equal(ctx.brief?.title, 'B');
  clearOrchestratorContext();
  assert.equal(getOrchestratorContext().matterId, 'dec', 'the pane closing does not unbind the desk');
  clearSurfaceContext();
  assert.equal(getOrchestratorContext().matterId, undefined);
});

test('D. wiring: the desk binds Ask to the record root and clears the surface on unmount', () => {
  const desk = read('src/pages/brief/BriefDesk.tsx');
  assert.match(desk, /runInAssistant\(\{\s*matterId: recordRootId,\s*matterName: recordRootName \?\? undefined,/, 'Ask about this binds to the record');
  assert.doesNotMatch(desk, /matterId = d\.matterspace_id/, 'the pane document\'s matter no longer becomes the scope');
  assert.match(desk, /useEffect\(\(\) => \(\) => clearSurfaceContext\(\), \[\]\)/, 'unmount clears the surface');
  assert.match(desk, /setSurfaceContext\(\{\s*matterId: recordRootId,/, 'the surface is the record root');
  assert.match(desk, /record_root_matter_id/, 'the choice is kept on the brief');
  assert.match(desk, /recordMatterId: recordRootId,/, 'Confirm looks cases up in the record too');
  const confirm = read('src/lib/brief/confirm.ts');
  assert.match(confirm, /const lookupMatterId = opts\.recordMatterId \?\? matterId;/);
  assert.match(confirm, /await resolveAll\(lookupMatterId, entries/, 'resolution runs in the record');
  assert.match(confirm, /matterspace_id: matterId,/, "the run row stays on the brief's own matter");
  const home = read('src/pages/brief/BriefDeskHome.tsx');
  assert.match(home, /<MatterTreePick value=\{chosen\?\.id \?\? null\}/, 'import chooses the matter from the tree');
  assert.doesNotMatch(home, /<select/, 'the flat drop-down is gone from import');
  const api = read('api/assistant.mjs');
  assert.match(api, /caption: pick\(c\.brief\.caption, 600\)/, 'the caption is bounded');
  assert.match(api, /recordMatterName: pick\(c\.brief\.recordMatterName\)/);
  const panel = read('src/components/ai/Assistant.tsx');
  assert.match(panel, /getOrchestratorContext\(\)\.brief\?\.title/, 'the panel shows what it knows');
});
