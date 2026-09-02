// Probe: findQuote — the assistant's "take me there" locator.
import { findQuote } from '../src/lib/student-hub-reflow.ts';

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}`, detail ?? ''); }
};

const hay = 'The eye’s plain version is a thing apart,\nThe vulgate of experience. Of this,\nA few words, an and yet, and yet, and yet —';

// Exact words, straight apostrophe, different case and wrapping.
let r = findQuote(hay, "the eye's plain version is a thing apart");
check('case/quote/wrap-insensitive', r && r.at === 0, JSON.stringify(r));

// A phrase mid-text; offsets must point at the original characters.
r = findQuote(hay, 'The vulgate of experience');
check('mid-text offset', r && hay.slice(r.at, r.at + r.len) === 'The vulgate of experience', r && hay.slice(r.at, r.at + r.len));

// Em dash vs hyphen.
r = findQuote(hay, 'and yet, and yet -');
check('dash softened', !!r, JSON.stringify(r));

// Absent phrase.
check('absent -> null', findQuote(hay, 'stevens never wrote this line') === null);

// Too short to trust.
check('short -> null', findQuote(hay, 'a') === null);

// Multi-space and newline collapse in the needle.
r = findQuote(hay, 'thing  apart,\nThe   vulgate');
check('needle whitespace collapsed', r && hay.slice(r.at, r.at + r.len).startsWith('thing apart'), r && hay.slice(r.at, r.at + r.len));

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
