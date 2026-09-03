// Verifies src/lib/student-hub-reflow.ts against a real book and a handful of
// synthetic shapes, running the version on origin/main beside the working
// copy so a change shows up as a before/after, not a feeling.
//
//   node scripts/_verify-reflow.mjs
//
// The real book is Tender Is the Night as the public office feed serves it
// (351 page-cited passages from the vault's PDF text layer — a double-spaced
// extraction, every line its own block). No test runner in the repo, so the
// module is transpiled with the TypeScript compiler API and imported.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reflow-verify-'));

const TENDER_FEED = 'https://www.contextspaces.ai/api/office?book=6f38440f-293d-4e56-923f-fe54ffdfb174';

async function load(src, name) {
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const file = path.join(tmp, `reflow-${name}.mjs`);
  fs.writeFileSync(file, outputText);
  return import(pathToFileURL(file).href);
}

const OLD = await load(execSync('git show origin/main:src/lib/student-hub-reflow.ts', { encoding: 'utf8' }), 'main');
const NEW = await load(fs.readFileSync('src/lib/student-hub-reflow.ts', 'utf8'), 'working');

let failures = 0;
const assert = (cond, what) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${what}`); if (!cond) failures += 1; };

const END = /[.!?][)\]'"’”»]*$/;
function report(label, mod, text) {
  const out = mod.reflowReading(text);
  const paras = mod.readingParagraphs(out);
  const prose = paras.filter((p) => !p.verse);
  const midSentence = prose.filter((p) => !END.test(p.text.trim()) && /\p{Ll}/u.test(p.text)).length;
  const lowerStarts = prose.filter((p) => /^[a-zà-ÿ]/.test(p.text)).length;
  const avg = Math.round(prose.reduce((a, p) => a + p.text.length, 0) / Math.max(1, prose.length));
  const idempotent = mod.reflowReading(out) === out;
  console.log(`  ${label}: paragraphs=${paras.length} (verse ${paras.length - prose.length}) midSentenceEnds=${midSentence} lowercaseStarts=${lowerStarts} avgLen=${avg} idempotent=${idempotent}`);
  return { out, idempotent };
}

// ---- the real book ---------------------------------------------------------
console.log('== Tender Is the Night (live office feed) ==');
let tender = null;
try {
  const r = await fetch(`${TENDER_FEED}&fresh=${Date.now()}`);
  if (r.ok) tender = (await r.json()).pages.map((p) => p.text ?? '').join('\n\n');
} catch { /* offline — the synthetic cases still run */ }
if (tender) {
  const before = report('main   ', OLD, tender);
  const after = report('working', NEW, tender);
  assert(after.idempotent, 'working copy is idempotent on the whole book');
  for (const [needle, what] of [
    ['Marseilles and the Italian border', 'line seam joined before a capitalised word'],
    ['deserted after its English clientele', 'line seam joined before a capitalised word (2)'],
    ['not from the necessity of stimulating', 'passage seam joined'],
    ['floundered a minute in the sea. When he had gone, beach and bay', 'sentence end at the wrap joined'],
    ['\nCHAPTER  1\n', 'CHAPTER 1 stands alone'],
    ['\nCHAPTER  20\n', 'CHAPTER 20 stands alone'],
    ['bored by the fact—moreover, just any direction', 'an em dash cut by the wrap closes back up'],
  ]) {
    assert(after.out.includes(needle), `${what}   (main: ${before.out.includes(needle) ? 'had it' : 'lacked it'})`);
  }
} else {
  console.log('  (feed unreachable — skipped)');
}

// ---- synthetic shapes ------------------------------------------------------
console.log('== synthetic ==');
const para = (n) => `This is paragraph number ${n} of a pasted chapter, long enough to read as prose and to carry a measure of its own across the page. It ends with a full stop.`;
const pasted = Array.from({ length: 12 }, (_, i) => para(i + 1)).join('\n\n');
assert(NEW.reflowReading(pasted) === pasted, 'pasted paragraphs pass through untouched');

const frost = [
  'Whose woods these are I think I know.', 'His house is in the village though;',
  'He will not see me stopping here', 'To watch his woods fill up with snow.', '',
  'My little horse must think it queer', 'To stop without a farmhouse near',
  'Between the woods and frozen lake', 'The darkest evening of the year.',
];
const stanzas = frost.join('\n');
assert(NEW.reflowReading(stanzas) === stanzas, 'stanzas are verse, byte-identical');
const spacedPoem = frost.filter(Boolean).join('\n\n');
assert(NEW.reflowReading(spacedPoem) === OLD.reflowReading(spacedPoem), 'double-spaced short poem: as on main (too narrow to read as wrapped prose)');

const outline = [
  'I. The technology', 'What a world model is', 'II. Three hypotheticals', 'An industrial catastrophe',
  'A robot in a bedroom', 'III. Limits of traditional tort liability', 'Reasonable person', 'Design defect',
  'IV. What replaces traditional law',
].join('\n\n');
assert(NEW.reflowReading(outline) === OLD.reflowReading(outline), 'outline of short unpunctuated lines: as on main');

const wrapped = [
  'CHAPTER 3',
  'The morning came up grey over the harbour and the boats went out one by one',
  'into a sea that had no colour yet, and the men on them did not speak because',
  'there was nothing to say that the cold had not said. She watched them go.',
  'Then she turned back.',
  'The kettle was on and the fire was low and the letter she had not opened',
  'lay where she had left it on the table, and she did not open it now either.',
].join('\n');
const w = NEW.reflowReading(wrapped);
assert(w.startsWith('CHAPTER 3\n\nThe morning'), 'single-spaced: a heading inside the block stands alone');
assert(w.includes('Then she turned back.\n\nThe kettle'), 'single-spaced: a short sentence-ended line still ends its paragraph');
assert(NEW.reflowReading(w) === w, 'single-spaced sample idempotent');

const spaced = [
  'PART ONE',
  'The morning came up grey over the harbour and the boats went out one by one',
  'into a sea that had no colour yet, and the men on them did not speak because',
  'there was nothing to say that the cold had not already said. She watched. The',
  'Marseilles boat was last. Then she turned back to the house, where the kettle',
  'was on and the fire was low and the letter she had not opened lay on the table.',
  '“You came back,” he said from the doorway, not looking up from the paper he',
  'had been reading since the boats went out. “I thought you might not.”',
  '“I always come back,” she said.',
  'He folded the paper. Outside the last of the boats had gone round the point',
  'and the harbour was empty and grey and very quiet.',
].join('\n\n');
const sp = NEW.reflowReading(spaced);
assert(sp.startsWith('PART ONE\n\nThe morning'), 'double-spaced: heading stands alone');
assert(sp.includes('She watched. The Marseilles boat'), 'double-spaced: a sentence end at the wrap is joined');
assert(sp.includes('on the table.\n\n“You came back,”'), 'double-spaced: a quotation opens a paragraph');
assert(sp.includes('I thought you might not.”\n\n“I always come back,” she said.\n\nHe folded'), 'double-spaced: dialogue paragraphs kept apart');
assert(NEW.reflowReading(sp) === sp, 'double-spaced sample idempotent');

const spacedDash = 'She looked at the sea —\n\nand then away — and said nothing, which was\n\nher way with him.';
assert(NEW.reflowReading(spacedDash) === 'She looked at the sea — and then away — and said nothing, which was her way with him.', 'a spaced em dash keeps its space');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
