// Validate public/templates/core-covers.json — the allow-list of covers a
// non-workshop account may be offered (see src/lib/covers.ts).
//
// Run:  node scripts/_validate-cover-manifest.mjs
//
// The core set was chosen by LOOKING at every image, over contact sheets, not
// by matching filenames: the last two attempts to classify this library by
// keyword were both thrown away after misfiling about a third of it. The
// keyword list below is therefore NOT how the set was built. It is belt and
// braces — a mechanical floor under the eye, so that a cover whose own
// filename says "a beautiful woman in a bikini" can never re-enter the core
// set through a careless paste, however the set was arrived at.
//
// What this checks:
//   1. every core path exists on disk, and is in manifest.json
//   2. no duplicate paths, and the list is sorted (so diffs stay readable)
//   3. no core file is larger than MAX_BYTES
//   4. no core filename matches the exclusion keyword list
//   5. `featured` is exactly 8 and every one of them is in `core`
//   6. the categories cover-plates.ts draws book plates from are represented
// and prints the per-category counts.

import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'public/templates/manifest.json');
const CORE = join(ROOT, 'public/templates/core-covers.json');

/** A cover is a page background; anything much over this is a mistake. */
export const MAX_BYTES = 3 * 1024 * 1024;

/** cover-plates.ts hands a book with no cover one of these. */
export const PLATE_CATEGORIES = ['Literary', 'Still Life', 'Alhambra'];

// Matched against the hyphen-separated tokens of the file's basename. These
// are Midjourney filenames, i.e. the prompt: a prompt that ASKED for a person
// reliably produced one. (The converse does not hold, which is exactly why
// the set was built by eye.)
export const EXCLUDE_TOKENS = new Set([
  // people as the subject
  'man', 'mans', 'men', 'woman', 'womans', 'women', 'womens', 'boy', 'boys',
  'girl', 'girls', 'child', 'children', 'kid', 'kids', 'baby', 'teenager',
  'teen', 'lady', 'ladies', 'person', 'people', 'family', 'lover', 'lovers',
  'couple', 'her', 'his', 'she', 'he', 'figure', 'faces', 'face', 'portrait',
  'portraits', 'selfie', 'crowd', 'audience',
  // roles — the picture is of somebody doing a job
  'lawyer', 'lawyers', 'jury', 'juror', 'jurors', 'judge', 'professor',
  'editor', 'monk', 'monks', 'apprentice', 'violinist', 'saxophonist',
  'accordionist', 'musician', 'musicians', 'fisherman', 'ornithologist',
  'ballerina', 'dancer', 'dancers', 'dancing', 'walker', 'choir', 'band',
  'peasant', 'retiree', 'retired', 'knight', 'shopping', 'luthier', 'luthiers',
  'vocalist', 'beauty', 'beautiful', 'gorgeous', 'handsome', 'pretty',
  'attractive', 'enchantingly', 'soulfully',
  // sexualised, undressed, intimate
  'bikini', 'swimsuit', 'lingerie', 'nude', 'naked', 'nymphs', 'nymph',
  'kisses', 'kissing', 'lying', 'waking', 'asleep', 'hippy', 'velvet',
  // named real-person likenesses
  'nathalie', 'portman', 'anna', 'armas', 'arma', 'helen', 'troy', 'hera',
  'zeus', 'circe', 'gavroche', 'ipanema',
  // brands, marques, trademarks
  'nvidia', 'jaguar', 'cadillac', 'vw', 'auburn', 'superman', 'steinway',
  'yquem', 'faberge', 'deepmind', 'garpheon', 'grapheon',
  // text-bearing
  'calligraphy', 'quran', 'page', 'pages', '1s', 'zeros', 'printed', 'map',
  'maps', 'sign', 'logo', 'poster', 'newspaper', 'letter', 'roadmap',
  // violence, prisons, party politics, protest
  'war', 'gun', 'blood', 'fallen', 'riot', 'protest', 'protests',
  'revolutionaries', 'revolutionary', 'sandinista', 'rikers', 'medication',
  'tightrope', 'tightwire', 'highwire', 'wire',
  // an identifiable religious rite as the subject
  'krishna', 'holi', 'religious', 'ghats',
  // placeholders, prompt plumbing, not pictures
  'blank', 'httpss', 'mj', 'expand', 'referenced', 'refering', 'reference',
  'omni', 'imagin', 'upload',
]);

/** Substrings the token list is too blunt (or too broad) to express. */
export const EXCLUDE_PHRASES = [
  'a-jury-of-twelve', 'corporate-boardroom', 'a-group-of-revolutionaries',
  'down-and-out', 'a-ribbon-for-your-hair', 'i-made-a-garland',
  'this-person-surrounded', 'listening-to-folk-music', 'something-amazing',
  'talking-horse', 'a-silk-market', 'bookstore', 'central-park-cycling',
  'a-hollywood-studio', 'a-roller-coaster', 'political', 'in-memory-of',
  'the-life-and-death', 'medication-time', 'a-religious-festival',
  'festival-in-india', 'covered-in-paint', 'a-high-wire', 'on-a-high-wire',
  'balancing', 'a-diesel-truck', 'the-interior-of-a-tavern',
  'greenwich-village-bar', 'tenor-sax-laid-against-the-bar',
  'greenwich-village-cafe', 'cherry-blossoms-in-bloom',
];

/** Why this filename is barred from the core set, or null. */
export function excludedByName(file) {
  const base = file.replace(/^.*\//, '').replace(/\.[a-z0-9]+$/i, '');
  for (const p of EXCLUDE_PHRASES) if (base.includes(p)) return `phrase "${p}"`;
  for (const tok of base.split('-')) if (EXCLUDE_TOKENS.has(tok)) return `token "${tok}"`;
  return null;
}

// ── run ───────────────────────────────────────────────────────────────────

const problems = [];
const fail = (m) => problems.push(m);

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const core = JSON.parse(readFileSync(CORE, 'utf8'));

if (!Array.isArray(core.core)) fail('core-covers.json: "core" is not an array');
if (!Array.isArray(core.featured)) fail('core-covers.json: "featured" is not an array');

const byFile = new Map(manifest.map((t) => [t.file, t]));
const coreFiles = core.core ?? [];
const coreSet = new Set(coreFiles);

if (coreSet.size !== coreFiles.length) {
  const seen = new Set();
  for (const f of coreFiles) {
    if (seen.has(f)) fail(`duplicate core entry: ${f}`);
    seen.add(f);
  }
}

const sorted = [...coreFiles].sort();
if (sorted.join('\n') !== coreFiles.join('\n')) {
  fail('core list is not sorted — keep it alphabetical so diffs stay readable');
}

const counts = {};
for (const file of coreFiles) {
  const entry = byFile.get(file);
  if (!entry) { fail(`core entry is not in manifest.json: ${file}`); continue; }
  counts[entry.category] = (counts[entry.category] || 0) + 1;

  const onDisk = join(ROOT, 'public', file.replace(/^\//, ''));
  if (!existsSync(onDisk)) { fail(`core entry has no file on disk: ${file}`); continue; }
  const { size } = statSync(onDisk);
  if (size > MAX_BYTES) {
    fail(`core entry is ${(size / 1048576).toFixed(1)} MB, over the ${MAX_BYTES / 1048576} MB cap: ${file}`);
  }

  const why = excludedByName(file);
  if (why) fail(`core entry matches the exclusion list by ${why}: ${file}`);
}

if ((core.featured ?? []).length !== 8) {
  fail(`featured must hold exactly 8 covers, found ${(core.featured ?? []).length}`);
}
for (const f of core.featured ?? []) {
  if (!f?.file) { fail(`featured entry has no "file": ${JSON.stringify(f)}`); continue; }
  if (!coreSet.has(f.file)) fail(`featured cover is not in the core set: ${f.file}`);
  if (!byFile.has(f.file)) fail(`featured cover is not in manifest.json: ${f.file}`);
}

const plateCount = PLATE_CATEGORIES.reduce((n, c) => n + (counts[c] || 0), 0);
if (plateCount < 15) {
  fail(`only ${plateCount} core covers in ${PLATE_CATEGORIES.join(' / ')} — cover-plates.ts draws every book plate from these, so the shelf would repeat itself`);
}

console.log(`manifest: ${manifest.length} covers`);
console.log(`core:     ${coreFiles.length} covers offered to every non-workshop account`);
console.log(`featured: ${(core.featured ?? []).length}`);
console.log('');
for (const cat of Object.keys(counts).sort()) {
  const total = manifest.filter((t) => t.category === cat).length;
  console.log(`  ${cat.padEnd(16)} ${String(counts[cat]).padStart(4)} of ${total}`);
}
const missing = [...new Set(manifest.map((t) => t.category))].filter((c) => !counts[c]);
for (const cat of missing.sort()) {
  const total = manifest.filter((t) => t.category === cat).length;
  console.log(`  ${cat.padEnd(16)}    0 of ${total}`);
}
console.log('');
console.log(`  book plates (${PLATE_CATEGORIES.join(' / ')}): ${plateCount}`);
console.log('');

if (problems.length) {
  for (const p of problems) console.log(`FAIL  ${p}`);
  console.log(`\n${problems.length} problem(s).`);
  process.exit(1);
}
console.log('PASS  core cover set is valid.');
