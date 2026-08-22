// Render the SecureSpace design artboards to PNGs + one PDF, locally,
// using the system Chrome (no canvas export involved).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';

const SRC = 'C:/Users/equai/AppData/Local/Temp/claude/C--Users-equai/9d6f7dcd-e009-40e1-b674-5692d3558a38/scratchpad/securespace';
const desktop = existsSync('C:/Users/equai/Desktop') ? 'C:/Users/equai/Desktop' : 'C:/Users/equai/OneDrive/Desktop';
const OUT = join(desktop, 'SecureSpace-snapshots');
mkdirSync(OUT, { recursive: true });

const TIER_B = {
  '{{tierColor}}': '#5aa88f',
  '{{tierBorder}}': 'rgba(90,168,143,0.45)',
  '{{bannerBg}}': 'rgba(90,168,143,0.08)',
  '{{bannerBorder}}': 'rgba(90,168,143,0.3)',
  '{{bannerLine}}': 'TIER B \u00b7 SEALED \u00b7 US-HOSTED, ZERO DATA RETENTION \u00b7 SESSIONS ARE ATTORNEY WORK PRODUCT',
  '{{tierCode}}': 'TIER B',
  '{{tierName}}': 'SEALED',
};
const MODELS = [
  { name: 'Kimi K3', host: 'Fireworks \u00b7 US \u00b7 zero retention' },
  { name: 'Claude Opus', host: 'escalation \u00b7 logged per call' },
];

function toStandalone(file) {
  let s = readFileSync(join(SRC, file), 'utf8');
  // resolve the Matter artboard's template for Tier B
  for (const [hole, val] of Object.entries(TIER_B)) s = s.split(hole).join(val);
  s = s.replace(/<sc-for[^>]*>([\s\S]*?)<\/sc-for>/g, (_, inner) =>
    MODELS.map((m) => inner.split('{{m.name}}').join(m.name).split('{{m.host}}').join(m.host)).join(''),
  );
  const helmet = s.match(/<helmet>([\s\S]*?)<\/helmet>/)?.[1] ?? '';
  const body = (s.match(/<\/helmet>([\s\S]*?)<\/x-dc>/)?.[1] ?? '');
  return `<!doctype html><html><head><meta charset="utf-8">${helmet}</head><body style="margin:0">${body}</body></html>`;
}

const BOARDS = [
  { file: 'Landing.dc.html', out: '1-securespaces-ai.png', w: 1200, h: 1560 },
  { file: 'Main.dc.html', out: '2-my-securespace.png', w: 1280, h: 820 },
  { file: 'Matter.dc.html', out: '3-sealed-matter.png', w: 1280, h: 820 },
  { file: 'Session.dc.html', out: '4-live-session.png', w: 1280, h: 820 },
];

const browser = await puppeteer.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const pngs = [];
for (const b of BOARDS) {
  await page.setViewport({ width: b.w, height: b.h, deviceScaleFactor: 2 });
  await page.setContent(toStandalone(b.file), { waitUntil: 'domcontentloaded', timeout: 60000 });
  // wait for webfonts, but never hang on them
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 8000))]));
  await new Promise((r) => setTimeout(r, 400));
  const buf = await page.screenshot({ type: 'png' });
  writeFileSync(join(OUT, b.out), buf);
  pngs.push({ ...b, buf });
  console.log(`rendered ${b.out} (${Math.round(buf.length / 1024)} KB)`);
}
await browser.close();

const pdf = await PDFDocument.create();
for (const b of pngs) {
  const img = await pdf.embedPng(b.buf);
  const pageW = b.w * 0.75, pageH = b.h * 0.75; // 96 css px -> 72 pt
  const p = pdf.addPage([pageW, pageH]);
  p.drawImage(img, { x: 0, y: 0, width: pageW, height: pageH });
}
writeFileSync(join(OUT, 'SecureSpace-snapshots.pdf'), await pdf.save());
console.log(`wrote SecureSpace-snapshots.pdf`);
console.log(`ALL -> ${OUT}`);
