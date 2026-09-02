// Probe: the reader's clean-copy extraction — furniture stripping, gap-derived
// paragraph breaks, reflow — against a faked two-page PDF shaped like the
// litigation documents it exists for. Node 22.18+ strips the .ts types.
// Untracked by convention — scripts/_* are probes, not code.
import {
  pdfDocumentText,
  selectionHtml,
  reflowedHtml,
} from '../src/lib/reader-copy.ts';

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}`); if (detail) console.log(`      ${detail}`); }
};

// One text line = one item with an EOL and a y position (transform[5]).
const line = (text, y) => ({ str: text, hasEOL: true, transform: [1, 0, 0, 1, 72, y] });

const page1 = [
  line('CONFIDENTIAL DRAFT', 720),
  line('The underlying data supporting the use-of-force statistics chart prepared by the Investi-', 676),
  line("gation Division's tracking unit for this litigation, including the case management sys-", 654),
  line("tem extract and the tracking unit's Excel workbooks from which the chart was derived,", 632),
  line('in native format. The parties agreed that production would follow within fourteen', 610),
  line('1', 566),
];
const page2 = [
  line('CONFIDENTIAL DRAFT', 720),
  line('days of the deposition, subject to the protective order entered in this matter.', 676),
  line('Basis: the witness testified that the chart was prepared at the direction of counsel.', 632),
  line('2', 588),
];

const fakePdf = {
  numPages: 2,
  getPage: async (n) => ({
    getTextContent: async () => ({ items: n === 1 ? page1 : page2 }),
  }),
};

const text = await pdfDocumentText(fakePdf);
console.log('---\n' + text + '\n---');

check('running heads stripped', !text.includes('CONFIDENTIAL DRAFT'));
check('page numbers shed', !/^\s*[12]\s*$/m.test(text));
check('hyphen healed', text.includes("Investigation Division's tracking unit"));
check('second hyphen healed', text.includes('case management system extract'));
check('sentence flows across the page seam', text.includes('within fourteen days of the deposition'));
check('Basis is its own paragraph', /\n\nBasis: the witness/.test(text));
check('no styling characters, plain text', !/[<>]/.test(text));

const html = reflowedHtml(text);
check('html is bare paragraphs', /^<p>/.test(html) && !/style=|span|color/i.test(html));
check('html has two paragraphs', (html.match(/<p>/g) ?? []).length === 2);

const sel = selectionHtml('line one\nline two\n\nnext para & <tag>');
check(
  'selection html escapes and structures',
  sel === '<p>line one<br>line two</p><p>next para &amp; &lt;tag&gt;</p>',
  sel,
);

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
