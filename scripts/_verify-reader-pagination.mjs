// Probe: the reader's pagination geometry, in a real browser.
//
// HubReader paginates a text reading by laying it out in one tall CSS
// multi-column box and stepping horizontally one column per page. The whole
// mechanism rests on two readings of the layout — scrollWidth for the page
// count, each paragraph's offsetLeft for the paragraph → page map — so this
// probe puts the component's own CSS and its own formulas in front of Chrome
// and checks that both come back sane, on a desktop and on a phone.
//
// Needs the dev server up (npm run dev) for the font. Untracked by convention.

import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer';

const COLUMN_GAP = 64;
const TEXT_COLUMN_MAX = 620;
const FONT_URL = 'http://localhost:5173/node_modules/@fontsource-variable/cormorant-garamond/index.css';

const source = readFileSync(new URL('../src/components/student-hub/HubReader.tsx', import.meta.url), 'utf8');
const css = source.match(/const READER_CSS = `([\s\S]*?)`;\n/)?.[1];
if (!css) throw new Error('Could not lift READER_CSS out of HubReader.tsx');

const SENTENCES = [
  'The doctrine of consideration has never been a single rule, and the cases collected here do not pretend otherwise.',
  'Holmes put the bargain theory in its narrowest form, and for a generation the casebooks put Holmes first.',
  'Section 90 was the answer the Restatement gave, and it is the answer this chapter takes up next.',
  'What the second reading gives you is the sound of the thing, which is where the argument has to start.',
];
const paragraphs = Array.from({ length: 40 }, (_, i) => (
  Array.from({ length: 4 }, (_, j) => SENTENCES[(i + j) % SENTENCES.length]).join(' ')
));

const body = paragraphs.map((t, i) => `<p data-para="${i}">${t}</p>`).join('');

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${FONT_URL}">
<style>html,body{margin:0;padding:0;height:100%}</style>
<style>${css}</style>
</head><body>
<div class="hub-reader parchment">
  <div class="hub-reader-chrome"><h1 class="hub-reader-title">A reading</h1></div>
  <div class="hub-reader-stage">
    <div class="hub-reader-area" id="area">
      <div class="hub-reader-view" id="view">
        <div class="hub-reader-track" id="track">${body}</div>
      </div>
    </div>
  </div>
</div>
</body></html>`;

/** The component's own geometry, run in the page. */
const layout = `(fontSize) => {
  const gap = ${COLUMN_GAP};
  const area = document.getElementById('area');
  const view = document.getElementById('view');
  const track = document.getElementById('track');
  const w = area.clientWidth;
  const h = area.clientHeight;
  const narrow = w > 0 && w < 768;
  const gutter = narrow ? 52 : 72;
  const colW = Math.max(180, Math.min(${TEXT_COLUMN_MAX}, w - gutter * 2));
  const pageH = Math.max(120, h);
  const step = colW + gap;
  Object.assign(view.style, { width: colW + 'px', height: pageH + 'px' });
  Object.assign(track.style, {
    width: colW + 'px', height: pageH + 'px',
    columnWidth: colW + 'px', columnGap: gap + 'px',
    fontSize: fontSize + 'px',
  });
  // Force layout before reading it back.
  void track.offsetWidth;
  const count = Math.max(1, Math.round(track.scrollWidth / step));
  const map = [];
  track.querySelectorAll('[data-para]').forEach((el) => {
    map[Number(el.dataset.para)] = Math.max(0, Math.min(count - 1, Math.round(el.offsetLeft / step)));
  });
  // Which pages actually carry a line of type. A paragraph longer than a page
  // starts on one page and runs onto the next, so its start is not the whole
  // story — the line boxes are.
  const left = track.getBoundingClientRect().left;
  const range = document.createRange();
  range.selectNodeContents(track);
  const covered = new Set();
  for (const rect of range.getClientRects()) {
    if (rect.width === 0 && rect.height === 0) continue;
    covered.add(Math.round((rect.left - left) / step));
  }
  return {
    w, h, colW, pageH, step, scrollWidth: track.scrollWidth, count, map,
    covered: [...covered].sort((a, b) => a - b),
  };
}`;

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}`);
    if (detail !== undefined) console.log(`      ${detail}`);
  }
}

const browser = await puppeteer.launch({ headless: true });
try {
  for (const view of [
    { name: 'desktop 1440x900', width: 1440, height: 900 },
    { name: 'iphone 390x844', width: 390, height: 844, deviceScaleFactor: 3 },
  ]) {
    const page = await browser.newPage();
    await page.setViewport({ width: view.width, height: view.height, deviceScaleFactor: view.deviceScaleFactor ?? 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);

    for (const fontSize of [14, 18, 30]) {
      const r = await page.evaluate(`(${layout})(${fontSize})`);
      const label = `${view.name} @ ${fontSize}px`;

      check(`${label} — the page box has room`, r.colW >= 180 && r.pageH >= 200, JSON.stringify(r));
      check(`${label} — more than one page`, r.count > 1, `count ${r.count}`);
      check(
        `${label} — scrollWidth is whole columns`,
        Math.abs(r.scrollWidth - (r.count * r.colW + (r.count - 1) * COLUMN_GAP)) <= 2
          || Math.abs(r.scrollWidth - r.count * r.step) <= 2,
        `scrollWidth ${r.scrollWidth}, count ${r.count}, step ${r.step}`,
      );
      check(`${label} — every paragraph has a page`, r.map.length === paragraphs.length && r.map.every((p) => Number.isInteger(p)), JSON.stringify(r.map));
      check(`${label} — pages in range`, r.map.every((p) => p >= 0 && p < r.count), JSON.stringify(r.map));
      check(`${label} — the map never runs backwards`, r.map.every((p, i) => i === 0 || p >= r.map[i - 1]), JSON.stringify(r.map));
      check(
        `${label} — every page carries type, and none runs past the end`,
        r.covered.length === r.count && r.covered[0] === 0 && r.covered[r.covered.length - 1] === r.count - 1,
        `count ${r.count}, pages with type ${r.covered.length} (${r.covered[0]}…${r.covered[r.covered.length - 1]})`,
      );
    }

    // Bigger type must not lose the reader's place: the anchor paragraph is
    // still findable and still lands on a page that exists.
    const small = await page.evaluate(`(${layout})(14)`);
    const large = await page.evaluate(`(${layout})(30)`);
    check(
      `${view.name} — larger type makes more pages`,
      large.count > small.count,
      `14px ${small.count} pages, 30px ${large.count} pages`,
    );
    const anchor = Math.floor(paragraphs.length / 2);
    check(
      `${view.name} — the anchor paragraph survives the change`,
      large.map[anchor] >= 0 && large.map[anchor] < large.count,
      `anchor ${anchor}: ${small.map[anchor]} → ${large.map[anchor]}`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}

console.log('');
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
