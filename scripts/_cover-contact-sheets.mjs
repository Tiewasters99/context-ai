// Render the core cover set as contact sheets, so the whole thing can be
// approved (or a mistake spotted) at a glance instead of by reading 299 file
// paths. This is the same tool the set was CHOSEN with: the library was
// reviewed over sheets like these, because the two previous attempts to sort
// these images by filename were both thrown away.
//
//   node scripts/_cover-contact-sheets.mjs                  → docs/covers/
//   node scripts/_cover-contact-sheets.mjs <outdir> <cols> <rows> <tile>
//
// Sheets are grouped by category and written as WebP so they stay small
// enough to live in the repo. Regenerate after editing core-covers.json.
// Untracked by convention — scripts/_*.mjs are probes, not code.

import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [outArg, colsArg, rowsArg, tileArg] = process.argv.slice(2);
const OUT = join(ROOT, outArg || 'docs/covers');
const COLS = Number(colsArg || 12);
const ROWS = Number(rowsArg || 9);
const TILE = Number(tileArg || 128);
const PER = COLS * ROWS;

const manifest = JSON.parse(readFileSync(join(ROOT, 'public/templates/manifest.json'), 'utf8'));
const core = JSON.parse(readFileSync(join(ROOT, 'public/templates/core-covers.json'), 'utf8'));
const byFile = new Map(manifest.map((t) => [t.file, t]));

// Category order, largest first, so a sheet reads as one register at a time.
const items = core.core.map((f) => byFile.get(f)).filter(Boolean);
const order = [...new Set(items.map((t) => t.category))]
  .sort((a, b) => items.filter((t) => t.category === b).length - items.filter((t) => t.category === a).length);
const ordered = order.flatMap((c) => items.filter((t) => t.category === c));

mkdirSync(OUT, { recursive: true });

let sheet = 0;
for (let start = 0; start < ordered.length; start += PER) {
  const slice = ordered.slice(start, start + PER);
  sheet += 1;
  const composites = [];
  for (let i = 0; i < slice.length; i += 1) {
    const src = join(ROOT, 'public', slice[i].file.replace(/^\//, ''));
    composites.push({
      input: await sharp(src).resize(TILE, TILE, { fit: 'cover' }).toBuffer(),
      left: (i % COLS) * TILE,
      top: Math.floor(i / COLS) * TILE,
    });
  }
  const out = join(OUT, `core-covers-${sheet}.webp`);
  await sharp({
    create: {
      width: COLS * TILE,
      height: Math.ceil(slice.length / COLS) * TILE,
      channels: 3,
      background: { r: 18, g: 18, b: 26 },
    },
  }).composite(composites).webp({ quality: 80 }).toFile(out);
  console.log(out, `${slice.length} covers`);
}
console.log(`${sheet} sheet(s), ${ordered.length} covers`);
