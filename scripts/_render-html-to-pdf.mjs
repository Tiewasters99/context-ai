// Render a local HTML file to a PDF with the system Chrome (puppeteer).
//   node scripts/_render-html-to-pdf.mjs <in.html> <out.pdf> [title]
// Used to file artifact pages (e.g. the wiring diagram) into Contextspaces
// as real PDFs, so they open in the reader with diagrams intact.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';

const [inPath, outPath, title = 'Document'] = process.argv.slice(2);
if (!inPath || !outPath) { console.error('usage: _render-html-to-pdf.mjs <in.html> <out.pdf> [title]'); process.exit(1); }

// The artifact files are body fragments (the publisher wraps them); make a
// standalone page, force the light palette, and let webfonts load.
const body = readFileSync(inPath, 'utf8');
const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><title>${title}</title>
<style>@page { size: Letter; margin: 14mm 12mm; } body { margin: 0 !important; } main { max-width: none !important; padding: 0 !important; } pre { white-space: pre; font-size: 10.5px !important; line-height: 1.38 !important; page-break-inside: avoid; } h2 { page-break-after: avoid; } table { page-break-inside: auto; } tr { page-break-inside: avoid; }</style>
</head><body>${body}</body></html>`;
const tmp = resolve(outPath + '.tmp.html');
writeFileSync(tmp, html);

const browser = await puppeteer.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.goto(pathToFileURL(tmp).href, { waitUntil: 'networkidle0', timeout: 60000 });
await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 8000))]));
await page.emulateMediaType('screen');
const pdf = await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false });
await browser.close();
writeFileSync(outPath, pdf);
console.log(`wrote ${outPath} (${Math.round(pdf.length / 1024)} KB)`);
