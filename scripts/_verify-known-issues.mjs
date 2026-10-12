// The Orchestrator's known-issues lookup (Fable's review, 10-02, P1).
//
//   node scripts/_verify-known-issues.mjs
//
// Offline: no .env, no network. Fails when an entry is unsound, when the
// generated table is stale, when an entry quotes product wording that no
// longer exists (the entry is out of date — edit or close it), when a
// realistic complaint stops matching its entry, or when the lookup could
// leak the team's notes or reach an outside connector.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import KNOWN from '../lib/known-issues.generated.mjs';
import { matchKnownIssues, fixStatus, parseEntry, entryProblems } from '../lib/known-issues.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

console.log('\n--- the entries ---------------------------------------------');
const dir = path.join(ROOT, 'docs', 'orchestrator', 'known-issues');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
const parsed = files.map((f) => parseEntry(fs.readFileSync(path.join(dir, f), 'utf8'), f));
const problems = parsed.flatMap(entryProblems);
check(problems.length === 0, `all ${parsed.length} entries are sound`, problems.join('; '));
let gen = '';
try {
  gen = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-known-issues.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) { gen = String(e.stdout ?? '') + String(e.stderr ?? ''); }
check(/generated copy current/.test(gen), 'lib/known-issues.generated.mjs matches the entries', gen.trim());

// Every quoted product string must still be in the product.
const SOURCES = ['src', 'lib', 'api'];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => {
  const p = path.join(d, x.name);
  if (x.isDirectory()) return x.name === 'node_modules' ? [] : walk(p);
  return /\.(tsx?|mjs|js)$/.test(x.name) && !/known-issues\.generated\.mjs$/.test(x.name) ? [p] : [];
});
const corpus = SOURCES.flatMap((s) => walk(path.join(ROOT, s))).map((f) => fs.readFileSync(f, 'utf8')).join('\n').toLowerCase().replace(/[’]/g, "'");
const stale = [];
for (const e of KNOWN.entries) for (const s of e.symptoms) if (!corpus.includes(s.toLowerCase().replace(/[’]/g, "'"))) stale.push(`${e.id}: "${s}"`);
check(stale.length === 0, 'every quoted on-screen string still exists in the product', stale.join('; '));
const fixedOff = KNOWN.entries.filter((e) => e.status === 'fixed' && !KNOWN.order.includes(String(e.fixed_in).slice(0, 12)));
check(fixedOff.length === 0, "every fixed entry's commit is on main (first parent)", fixedOff.map((e) => e.id).join(', '));

console.log('\n--- matching what people actually say -----------------------');
const top = (words, surface) => matchKnownIssues(KNOWN, { words, surface, now: Date.parse('2026-10-05') })[0]?.id;
const CASES = [
  ['It says "This brief was changed in another window after you opened it"', 'brief-desk', 'brief-changed-elsewhere'],
  ["I can't type in the brief, it says Read-only: this brief is being edited in another window", 'brief-desk', 'brief-read-only-held'],
  ['the cite check is searching another client’s matter', 'brief-desk', 'brief-record-wrong-matter'],
  ['I saved v19 but can’t find it', 'brief-desk', 'brief-saved-version-missing'],
  ['the footnote the brief cites is missing, no footnotes in the case', 'brief-desk', 'footnote-not-found'],
  ["Couldn't load this matter's documents (list documents: TypeError: Failed to fetch)", 'vault', 'vault-failed-to-fetch'],
  ['my documents are stuck processing for an hour', 'vault', 'processing-paused'],
  ['This room is not part of your plan', 'any', 'plan-room-closed'],
  ['I misspelled a sub-matter, how do I rename it', 'matter', 'rename-matter'],
  ['sharing says No Contextspaces account for my colleague', 'matter', 'share-no-account'],
  ["I never got the password reset email", 'sign-in', 'mail-not-arriving'],
  ['the transcript cite points at the wrong page, off by one', 'reader', 'printed-page-off'],
];
for (const [said, where, want] of CASES) {
  const got = top(said, where);
  check(got === want, `"${said.slice(0, 60)}…" → ${want}`, `got ${got}`);
}
check(matchKnownIssues(KNOWN, { words: 'what is the holding of Graham v. Connor' }).length === 0, 'an ordinary legal question matches nothing');

console.log('\n--- "fixed" is judged against the user\'s own version --------');
const order = ['aaaaaaaaaaa1', 'aaaaaaaaaaa2', 'aaaaaaaaaaa3', 'aaaaaaaaaaa4'];
check(fixStatus('aaaaaaaaaaa2', { build: 'aaaaaaaaaaa3', serverBuild: 'aaaaaaaaaaa4', order }) === 'in_your_build', 'their tab is newer than the fix → in your version');
check(fixStatus('aaaaaaaaaaa3', { build: 'aaaaaaaaaaa1', serverBuild: 'aaaaaaaaaaa4', order }) === 'reload_to_get_it', 'their tab predates the fix, the server has it → reload');
check(fixStatus('aaaaaaaaaaa4', { build: 'aaaaaaaaaaa1', serverBuild: 'aaaaaaaaaaa2', order }) === 'not_yet_live', 'neither has it → not live yet');
check(fixStatus('aaaaaaaaaaa2', { build: 'bbbbbbbbbbbb', order }) === 'in_your_build', 'a build newer than the table has the fix');
check(fixStatus('aaaaaaaaaaa2', { build: 'local-20261005T120000Z', order }) === 'fixed', 'a local build: plain "fixed"');

console.log('\n--- what it must never do -----------------------------------');
const all = matchKnownIssues(KNOWN, { words: KNOWN.entries.flatMap((e) => e.words).join(' '), limit: 999 });
check(all.every((m) => !('note' in m)), "the team's notes never come back from the lookup");
const core = fs.readFileSync(path.join(ROOT, 'lib', 'mcp-core.mjs'), 'utf8');
check(!/name:\s*'known_issues'/.test(core), "known_issues is not in mcp-core's TOOLS (outside connectors never get it)");
const ac = fs.readFileSync(path.join(ROOT, 'lib', 'assistant-core.mjs'), 'utf8');
check(/name: 'known_issues'/.test(ac) && /KNOWN_ISSUES_TOOL\]/.test(ac), 'the in-app Orchestrator is offered it');
check(!/LEAVES_THE_MATTER = Object\.freeze\(new Set\(\[[^\]]*known_issues/.test(ac), 'it is not treated as leaving the matter (read-only, local)');
const sys = fs.readFileSync(path.join(ROOT, 'lib', 'orchestrator-system.mjs'), 'utf8');
check(/call known_issues with their words/.test(sys), 'the prompt tells it to look before explaining');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
