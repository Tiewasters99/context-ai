// Portfolio detection against real files. Run from the repo root:
//   node scripts/_test-pdf-portfolio.mjs <portfolio.pdf> <ordinary.pdf>
// Defaults to the 2026-09-03 Fifth Circuit E-Record wrapper and a filed brief
// from the same docket pull when those paths exist on this machine.
import fs from 'node:fs';
import assert from 'node:assert';
import { detectPdfPortfolio, mightBePortfolio } from '../lib/pdf-portfolio.mjs';

const [portfolioPath, ordinaryPath] = [
  process.argv[2] || 'C:/Users/equai/Atkinson_25-20513_Docket/EROA/E-Record_25-20513_portfolio_wrapper.pdf',
  process.argv[3] || 'C:/Users/equai/Atkinson_25-20513_Docket/ATK5C_046_ReplyBrief.pdf',
];

for (const p of [portfolioPath, ordinaryPath]) {
  if (!fs.existsSync(p)) { console.log(`skip: ${p} not found`); process.exit(0); }
}

const t0 = Date.now();
const wrapper = fs.readFileSync(portfolioPath);
assert.strictEqual(mightBePortfolio(wrapper), true, 'marker scan must flag the E-Record');
const found = await detectPdfPortfolio(wrapper);
assert.ok(found, 'E-Record must be detected as a portfolio');
assert.strictEqual(found.pageCount, 1);
assert.strictEqual(found.isCollection, true);
assert.strictEqual(found.attachments.length, 6);
const total = found.attachments.reduce((s, a) => s + a.bytes.length, 0);
assert.ok(total > 200 * 1024 * 1024, `attachments should carry the record (${total} bytes)`);
for (const a of found.attachments) {
  assert.ok(a.bytes.subarray(0, 5).toString('latin1').startsWith('%PDF-'), `${a.filename} must be a PDF`);
}
console.log(`  ok  portfolio: ${found.attachments.length} attachments, ${(total / 1048576).toFixed(1)} MB, ${Date.now() - t0} ms`);
for (const a of found.attachments) console.log(`      ${a.name}  ←  ${a.filename}  (${(a.bytes.length / 1048576).toFixed(1)} MB)`);

// The wrapper buffer must survive detection (pdf.js detaches what it is given).
assert.strictEqual(wrapper.length > 0 && wrapper.subarray(0, 5).toString('latin1'), '%PDF-', 'caller buffer must not be detached');
console.log('  ok  caller buffer intact after detection');

const t1 = Date.now();
const brief = fs.readFileSync(ordinaryPath);
const none = await detectPdfPortfolio(brief);
assert.strictEqual(none, null, 'an ordinary brief must not be treated as a portfolio');
console.log(`  ok  ordinary PDF → null (${Date.now() - t1} ms)`);
console.log('PASS');
