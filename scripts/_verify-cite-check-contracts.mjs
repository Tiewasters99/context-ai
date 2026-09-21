// Probe: cite-check holds the model to its output contract, and a citation it
// could not check says so. Entirely offline — no network, no .env, no
// database, no model. Node 22.18+ strips the .ts types.
//
// WHAT IS ASSERTED, AND WHY EACH ONE IS A BUG THAT SHIPPED
//
//   1. EXTRACTION IS NOT SILENTLY EMPTY. `extract-cites.ts` did
//      `Array.isArray(result?.citations) ? result.citations : []`, so ANY
//      answer that was not the expected object — a sealed pen writing prose, a
//      list under a different key, a tool call that did not parse — became
//      "this brief cites nothing". The run then finished `complete`, with a
//      Table of Authorities that was empty because nobody read the brief. It
//      now validates, repairs once, and otherwise refuses to finish.
//
//   2. NO CITATION IS INVENTED. `raw` is supposed to be the citation as it
//      appears in the draft. If it is not in the draft, the entry is set aside
//      — never returned, never put in the Table of Authorities. A hallucinated
//      cite arriving in a document that LOOKS checked is the single worst
//      thing this feature could produce.
//
//   3. NO RATING IS INVENTED. `rateConfidence` used to read
//      `result?.rating === 'high' || result?.rating === 'low' ? … : 'medium'`
//      — so `{}`, `"very high"` and a refusal-shaped object all came out as
//      MEDIUM confidence, printed in a report an attorney signs.
//
//   4. "NOT CHECKED" IS ITS OWN ANSWER. A citation whose checker could not be
//      read is reported as not checked — never as "not found" and never as
//      verified. PR #171's builder found a 402 being flattened into "cite not
//      found", which tells a lawyer a real case does not exist; this asserts
//      the whole class stays closed, on the contract path and on the refusal
//      path.
//
//   5. THE METER AND THE SEAL. 402, 429 and a sealed refusal reach the caller
//      with the server's own sentence — on the FIRST turn and on the REPAIR
//      turn — and stop the run rather than marking a citation.
//
//   6. THE ARITHMETIC RECONCILES. extracted = checked + not checked, in the
//      tally, on the run row and in the rendered report.
//
//   7. THE REPAIR IS A REAL CALL. It goes through the same /api/llm with the
//      same feature label ('citecheck.extract', 'citecheck.check') and the
//      same matter id, so it is metered and written to the matter's Record
//      exactly like the first turn.
//
// Run with the '@/' loader:
//   node --import ./scripts/_node-src-loader.mjs scripts/_verify-cite-check-contracts.mjs
//
// Untracked by convention elsewhere in scripts/, but this one runs in CI.

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}`); if (detail !== undefined) console.log(`      ${detail}`); }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// `@/lib/supabase` reads import.meta.env at module scope and cannot be loaded
// by plain node, so it is swapped for a proxy onto a fixture. Everything
// between the call site and `fetch` — structured.ts, auth.ts, refusals.ts, the
// adapter — is the REAL module, which is the point: the envelope examined
// below is the one the product sends.
// ---------------------------------------------------------------------------
const SUPABASE_STUB = 'data:text/javascript,' + encodeURIComponent(
  'export const supabase = new Proxy({}, { get: (_t, k) => globalThis.__ccSupabase[k] });',
);
register(
  new URL(`data:text/javascript,${encodeURIComponent(`
    const STUB = ${JSON.stringify(SUPABASE_STUB)};
    export async function resolve(specifier, context, next) {
      if (specifier === '@/lib/supabase') return { url: STUB, format: 'module', shortCircuit: true };
      return next(specifier, context);
    }
  `)}`).href,
  pathToFileURL('./'),
);

const {
  extractCitations, checkExtractContract, buildExtractRepairContent,
  appearsInDraft, EXTRACT_CONTRACT_FAILURE, AUTHORITY_TYPES,
} = await import('../src/lib/cite-check/extract-cites.ts');
const { checkOne, checkRatingContract, buildRatingRepairContent, decideFlag } =
  await import('../src/lib/cite-check/check.ts');
const {
  FLAG_LABEL, UNREADABLE_CHECK_DETAIL, citesChecked, citesAccountedFor, tallyFlags,
} = await import('../src/lib/cite-check/types.ts');
const { renderReport, renderToa } = await import('../src/lib/cite-check/render.ts');
const { LLM_FEATURES } = await import('../src/lib/llm/features.ts');

const MATTER = '2f1a9f4e-6c3b-4a17-9d21-0b6e8c5a7d10';

// ---------------------------------------------------------------------------
// The draft. Real cites, real spacing quirks — a curly apostrophe, a
// non-breaking space, a section symbol spaced two different ways.
// ---------------------------------------------------------------------------
const DRAFT = [
  'The Court applies the objective-reasonableness standard of Graham v. Connor, 490 U.S. 386, 396 (1989).',
  'A discharge is excepted from bankruptcy under 11 U.S.C. § 523(a)(7), and the City’s',
  'reliance on CPLR §214(2) is misplaced. See also 6 RCNY § 6-47 (the pen-and-yard rule),',
  'and 12 C.F.R. § 1026.36 (the servicing rule).',
].join('\n');

const GRAHAM = 'Graham v. Connor, 490 U.S. 386, 396 (1989)';

const citeEntry = (over = {}) => ({
  raw: GRAHAM,
  citation_bluebook: GRAHAM,
  case_name: 'Graham v. Connor',
  court: 'S.Ct.',
  year: 1989,
  pin_cite: '396',
  proposition: 'Excessive-force claims are judged by objective reasonableness.',
  signal: null,
  authority_type: 'case',
  doctrinal_subject: ['civil rights'],
  location: 'objective-reasonableness standard of Graham v. Connor',
  ...over,
});

// ---------------------------------------------------------------------------
section('1. The extraction contract — what is refused, what is set aside');
// ---------------------------------------------------------------------------

const extract = (raw, draft = DRAFT) => checkExtractContract(raw, draft);

check('a well-formed answer passes',
  (() => { const r = extract({ citations: [citeEntry()] }); return r.ok && r.value.cites.length === 1; })());
check('a non-object is refused', extract('no citations here, your honour').ok === false);
check('null is refused', extract(null).ok === false);
check('an array is refused', extract([citeEntry()]).ok === false);
check('prose in place of the tool call is refused, not read as an empty brief',
  extract({ text: 'I found four citations in the brief.' }).reason === 'no "citations" array');
check('a list under the wrong key is refused, and the key is named',
  extract({ cites: [citeEntry()] }).reason === 'no "citations" array — the list was called "cites"');

// EMPTY IS VALID. A brief with no citations is a real thing, and repairing it
// would be paying a second time to be told the same true thing.
check('{"citations":[]} is a VALID answer — an uncited brief is not a broken answer',
  (() => { const r = extract({ citations: [] }); return r.ok && r.value.cites.length === 0; })());

// THE ENUMERATION. Today an unknown value is silently rewritten to "other".
check('an authority_type outside the enumeration is refused',
  (extract({ citations: [citeEntry({ authority_type: 'caselaw' })] }).reason ?? '')
    .includes('it must be one of ' + AUTHORITY_TYPES.join(', ')));
check('and the reason names the citation it was wrong about',
  (extract({ citations: [citeEntry({ authority_type: 'caselaw' })] }).reason ?? '').includes(GRAHAM));
check('a missing authority_type is refused',
  (extract({ citations: [citeEntry({ authority_type: undefined })] }).reason ?? '').includes('missing'));
check('every listed authority_type is accepted',
  AUTHORITY_TYPES.every((t) => extract({ citations: [citeEntry({ authority_type: t })] }).ok));
check('case is forgiven on the enumeration — "Case" is the same word',
  extract({ citations: [citeEntry({ authority_type: 'Case' })] }).ok === true);

check('a year that is not a whole number is refused',
  extract({ citations: [citeEntry({ year: '1989' })] }).reason === `the year for "${GRAHAM}" was not a whole number`);
check('a null year is fine — not every authority has one',
  extract({ citations: [citeEntry({ year: null })] }).ok === true);
check('a case_name that is an object is refused',
  (extract({ citations: [citeEntry({ case_name: { v: 'Graham' } })] }).reason ?? '').includes('case_name'));
check('a doctrinal_subject that is a string, not a list, is refused',
  (extract({ citations: [citeEntry({ doctrinal_subject: 'civil rights' })] }).reason ?? '')
    .includes('was not a list of words'));
check('an entry with no "raw" is refused', extract({ citations: [{ authority_type: 'case' }] }).reason === 'citation 1 has no "raw" text');

// FABRICATION. The one unforgivable failure.
{
  const invented = 'Miranda v. Arizona, 384 U.S. 436 (1966)';
  const r = extract({ citations: [citeEntry(), citeEntry({ raw: invented, citation_bluebook: invented, location: null })] });
  check('a citation that is not in the draft is SET ASIDE, not returned',
    r.ok && r.value.cites.length === 1 && r.value.setAside === 1, JSON.stringify(r.value ?? r.reason));
  check('and the one that survives is the one actually in the draft',
    r.ok && r.value.cites[0].raw === GRAHAM);
}
{
  const invented = 'Miranda v. Arizona, 384 U.S. 436 (1966)';
  const r = extract({ citations: [citeEntry({ raw: invented, citation_bluebook: invented, location: null })] });
  check('an answer where EVERY citation is invented is refused, and repaired once',
    r.ok === false && r.reason === 'none of the 1 citations returned appears in the draft', r.reason);
}
check('a citation found only by its location snippet is kept',
  extract({ citations: [citeEntry({ raw: 'Graham, supra', location: 'objective-reasonableness standard of Graham v. Connor' })] })
    .ok === true);

// The in-draft comparison, on the spacing a real brief carries.
check('a section symbol spaced differently still matches',
  appearsInDraft(DRAFT, '11 U.S.C. §523(a)(7)') && appearsInDraft(DRAFT, 'CPLR § 214(2)'));
check('a non-breaking space in the draft still matches an ordinary one',
  appearsInDraft(DRAFT, '12 C.F.R. § 1026.36'));
check('a straight apostrophe matches the curly one Word inserted',
  appearsInDraft(DRAFT, "the City's"));
check('a line break in the draft does not hide a citation that spans it',
  appearsInDraft(DRAFT, 'excepted from bankruptcy under 11 U.S.C. § 523(a)(7), and the City’s reliance'));
check('a citation that is genuinely absent does NOT match',
  appearsInDraft(DRAFT, 'Miranda v. Arizona, 384 U.S. 436 (1966)') === false);
check('a two-character needle is refused rather than matched everywhere',
  appearsInDraft(DRAFT, 'v.') === false);

// Duplicates — "one entry per location", so the same cite in the same place twice.
{
  const r = extract({ citations: [citeEntry(), citeEntry()] });
  check('the same citation at the same place twice is folded, and counted',
    r.ok && r.value.cites.length === 1 && r.value.duplicates === 1, JSON.stringify(r.value ?? r.reason));
}
{
  const r = extract({ citations: [citeEntry(), citeEntry({ location: 'A discharge is excepted from bankruptcy' })] });
  check('the same case cited in two places stays two entries',
    r.ok && r.value.cites.length === 2 && r.value.duplicates === 0);
}
check('an answer holding more citations than any brief is refused',
  (extract({ citations: Array.from({ length: 1501 }, () => citeEntry()) }).reason ?? '')
    .includes('no brief holds that many'));

// ---------------------------------------------------------------------------
section('2. The rating contract');
// ---------------------------------------------------------------------------

check('a well-formed rating passes',
  (() => {
    const r = checkRatingContract({ rating: 'high', justification: 'The pin supports the proposition.' });
    return r.ok && r.value.rating === 'high';
  })());
check('"High " is the same rating, typed differently',
  (() => { const r = checkRatingContract({ rating: 'High ', justification: 'x' }); return r.ok && r.value.rating === 'high'; })());
check('a non-object is refused', checkRatingContract('high').ok === false);
check('{} is refused — it used to come out as MEDIUM',
  checkRatingContract({}).reason === 'no "rating"');
check('a word outside the three is refused, not mapped to medium',
  checkRatingContract({ rating: 'very high', justification: 'x' }).reason
    === 'the rating was "very high" — it must be exactly high, medium or low');
check('a numeric rating is refused', checkRatingContract({ rating: 0.9, justification: 'x' }).ok === false);
check('a rating with no justification is refused',
  checkRatingContract({ rating: 'low' }).reason === 'no "justification" for the rating');
check('an empty justification is refused', checkRatingContract({ rating: 'low', justification: '   ' }).ok === false);

// ---------------------------------------------------------------------------
section('3. The repair prompts');
// ---------------------------------------------------------------------------
{
  const body = buildExtractRepairContent('THE BRIEF', 'no "citations" array', { text: 'I found four.' });
  check('the extract repair keeps the brief above it', body.startsWith('THE BRIEF\n\n'));
  check('the extract repair shows the model its own answer', body.includes('"I found four."'));
  check('the extract repair names the precise reason', body.includes('Reason: no "citations" array.'));
  check('the extract repair says an empty list is allowed',
    body.includes('If the draft cites nothing, answer {"citations":[]}'));
  check('the extract repair forbids a citation that is not in the draft',
    body.includes('do not write a citation that is not there'));
}
{
  const body = buildRatingRepairContent('{"citation":"…"}', 'the rating was "very high"', { rating: 'very high' });
  check('the rating repair restates the three words',
    body.includes('{"rating":"high|medium|low","justification":"<one or two sentences>"}'));
  check('the rating repair names the reason', body.includes('Reason: the rating was "very high".'));
}

// ---------------------------------------------------------------------------
section('4. Extraction, end to end, through the real /api/llm envelope');
// ---------------------------------------------------------------------------

// The egress witness. Any url but the two the run is allowed is a failure.
const seen = [];
let llmReplies = [];
let legalSourceReply = { found: false };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (url === '/api/legal-source') {
    seen.push({ url, env: JSON.parse(init.body) });
    return new Response(JSON.stringify(legalSourceReply), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url !== '/api/llm') throw new Error(`cite-check harness saw egress to ${url}`);
  seen.push({ url, init, env: JSON.parse(init.body) });
  const next = llmReplies.shift();
  if (!next) throw new Error('the harness ran out of scripted replies — an unexpected model call');
  if (next.status && next.status !== 200) {
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  }
  return new Response(JSON.stringify({ content: [{ type: 'tool_use', input: next.input }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

/** Rows the harness watched anyone try to write. Nothing may reach these. */
let writes = [];
const q = (result) => {
  const chain = {
    select: () => chain, eq: () => chain, or: () => chain, order: () => chain,
    limit: () => chain, range: () => chain,
    maybeSingle: async () => result,
    single: async () => result,
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  };
  return chain;
};
globalThis.__ccSupabase = {
  auth: {
    getSession: async () => ({ data: { session: null } }),
    getUser: async () => ({ data: { user: { id: '11111111-2222-4333-8444-555555555555' } }, error: null }),
  },
  from: (table) => ({
    ...q({ data: null, error: null }),
    insert: (row) => { writes.push({ table, row }); return q({ data: { id: 'written' }, error: null }); },
    update: (row) => { writes.push({ table, row }); return q({ data: null, error: null }); },
  }),
};

const llmCalls = () => seen.filter((s) => s.url === '/api/llm');
const reset = (replies) => { seen.length = 0; writes = []; llmReplies = replies; };

// -- a valid first answer: one call, and the bytes are what they always were --
{
  reset([{ input: { citations: [citeEntry()] } }]);
  const out = await extractCitations(DRAFT, { modelId: 'claude-opus-4-8', matterId: MATTER });
  check('valid first answer: one citation returned', out.cites.length === 1 && out.cites[0].raw === GRAHAM);
  check('valid first answer: no repair was bought', out.repaired === false);
  check('valid first answer: exactly ONE call to /api/llm', llmCalls().length === 1, llmCalls().length);

  const env = llmCalls()[0].env;
  check('the envelope names the act — citecheck.extract', env.feature === 'citecheck.extract');
  check('and it is a label the server will accept', LLM_FEATURES.includes(env.feature));
  check('the envelope binds the call to the matter', env.matterId === MATTER);
  check('the request body is the draft, unchanged by the contract check',
    env.body.includes(DRAFT.slice(0, 80)) && !env.body.includes('could not be used'));
  check('the recorded fields carry no text from the brief',
    !JSON.stringify({ feature: env.feature, matterId: env.matterId }).includes('Graham'));
}

// -- invalid → repair → valid ---------------------------------------------
{
  reset([
    { input: { text: 'I found four citations.' } },
    { input: { citations: [citeEntry()] } },
  ]);
  const out = await extractCitations(DRAFT, { modelId: 'claude-opus-4-8', matterId: MATTER });
  check('invalid then valid: the repaired answer is used', out.cites.length === 1);
  check('invalid then valid: it says it was repaired', out.repaired === true);
  check('invalid then valid: exactly TWO calls — one repair, never two', llmCalls().length === 2, llmCalls().length);

  const repair = llmCalls()[1].env;
  check('THE REPAIR IS METERED AND RECORDED: same feature label', repair.feature === 'citecheck.extract');
  check('the repair is bound to the same matter', repair.matterId === MATTER);
  check('the repair shows the model its own answer and the reason',
    repair.body.includes('Your previous answer could not be used')
    && repair.body.includes('no \\"citations\\" array'));
  check('the repair is the same model, tool and allowance — only the content differs',
    repair.model === llmCalls()[0].env.model
    && JSON.parse(repair.body).max_tokens === JSON.parse(llmCalls()[0].env.body).max_tokens
    && JSON.stringify(JSON.parse(repair.body).tools) === JSON.stringify(JSON.parse(llmCalls()[0].env.body).tools));
}

// -- invalid twice: a plain failure, and NOTHING saved ----------------------
{
  reset([
    { input: { text: 'I found four citations.' } },
    { input: 'still not an object' },
  ]);
  let threw = null;
  try { await extractCitations(DRAFT, { modelId: 'claude-opus-4-8', matterId: MATTER }); } catch (e) { threw = e; }
  check('invalid twice: it throws rather than reporting an uncited brief', threw instanceof Error);
  check('invalid twice: the sentence says no citation was checked',
    (threw?.message ?? '').startsWith(EXTRACT_CONTRACT_FAILURE), threw?.message);
  check('invalid twice: and it names what was wrong', /Twice: .+\.\)$/.test(threw?.message ?? ''), threw?.message);
  check('invalid twice: exactly two calls — a third is not paid for', llmCalls().length === 2, llmCalls().length);
  check('invalid twice: NOTHING was written', writes.length === 0, JSON.stringify(writes));
  check('invalid twice: the failure is not an empty citation list',
    !(threw?.message ?? '').includes('0 citations'));
}

// -- 402 on the first turn: the wallet's sentence, and no repair ------------
{
  reset([{ status: 402, body: { error: 'budget_exhausted', message: 'This month’s AI budget is spent.' } }]);
  let threw = null;
  try { await extractCitations(DRAFT, { modelId: 'claude-opus-4-8', matterId: MATTER }); } catch (e) { threw = e; }
  check('402 on extraction: the server’s own sentence reaches the caller',
    threw?.message === 'This month’s AI budget is spent.', threw?.message);
  check('402 on extraction: it is a refusal, not a contract failure',
    threw?.name === 'ServerRefusalError' && threw?.refusal?.kind === 'budget');
  check('402 on extraction: NO repair turn was bought on a spent wallet',
    llmCalls().length === 1, llmCalls().length);
}

// -- 402 on the REPAIR turn: still the wallet, never "unreadable" -----------
{
  reset([
    { input: { text: 'prose' } },
    { status: 402, body: { error: 'budget_exhausted', message: 'This month’s AI budget is spent.' } },
  ]);
  let threw = null;
  try { await extractCitations(DRAFT, { modelId: 'claude-opus-4-8', matterId: MATTER }); } catch (e) { threw = e; }
  check('402 mid-repair: the wallet’s sentence, not the contract’s',
    threw?.name === 'ServerRefusalError' && !(threw?.message ?? '').includes('could not be read'), threw?.message);
}

// -- a sealed refusal is shown verbatim ------------------------------------
{
  reset([{ status: 403, body: { error: 'tier_violation', message: 'This matter is sealed. Only the sealed pen may answer here.' } }]);
  let threw = null;
  try { await extractCitations(DRAFT, { modelId: 'claude-opus-4-8', matterId: MATTER }); } catch (e) { threw = e; }
  check('a sealed refusal is passed through word for word',
    threw?.message === 'This matter is sealed. Only the sealed pen may answer here.', threw?.message);
  check('and it is recognised as final — nothing retries it', threw?.refusal?.kind === 'sealed');
}

// ---------------------------------------------------------------------------
section('5. Checking one citation — and the citation that could not be checked');
// ---------------------------------------------------------------------------

const CITE = {
  raw: GRAHAM,
  citation_bluebook: GRAHAM,
  case_name: 'Graham v. Connor',
  court: 'S.Ct.',
  year: 1989,
  pin_cite: '396',
  proposition: 'Excessive-force claims are judged by objective reasonableness.',
  signal: null,
  authority_type: 'case',
  doctrinal_subject: ['civil rights'],
  location: 'objective-reasonableness standard of Graham v. Connor',
};
const FOUND = { found: true, full_text: 'The reasonableness of a particular use of force…', source_url: 'https://example.invalid/graham', source_label: 'CourtListener' };

// -- valid rating, source found: unchanged behaviour ------------------------
{
  reset([{ input: { rating: 'high', justification: 'The pin supports the proposition.' } }]);
  legalSourceReply = FOUND;
  const r = await checkOne(CITE, { modelId: 'claude-opus-4-8', matterId: MATTER });
  check('a checked citation keeps its rating', r.rating === 'high');
  check('a checked, verified, well-pinned citation is green', r.flag === 'green', r.flag);
  check('exactly one model call', llmCalls().length === 1);
  check('the envelope names the act — citecheck.check', llmCalls()[0].env.feature === 'citecheck.check');
  check('and the authority is saved', writes.some((w) => w.table === 'authorities'));
}

// -- invalid → repair → valid ----------------------------------------------
{
  reset([
    { input: { rating: 'very high', justification: 'It is a landmark case.' } },
    { input: { rating: 'high', justification: 'The pin supports the proposition.' } },
  ]);
  legalSourceReply = FOUND;
  const r = await checkOne(CITE, { modelId: 'claude-opus-4-8', matterId: MATTER });
  check('an off-contract rating is repaired once and then used', r.rating === 'high' && r.flag === 'green');
  check('exactly TWO model calls', llmCalls().length === 2, llmCalls().length);
  check('THE REPAIR IS METERED AND RECORDED: same feature label and matter',
    llmCalls()[1].env.feature === 'citecheck.check' && llmCalls()[1].env.matterId === MATTER);
  check('the repair shows the model the word it used', llmCalls()[1].env.body.includes('very high'));
}

// -- invalid twice: NOT CHECKED --------------------------------------------
{
  reset([
    { input: { rating: 'very high', justification: 'It is a landmark case.' } },
    { input: { verdict: 'sound' } },
  ]);
  legalSourceReply = FOUND;
  const r = await checkOne(CITE, { modelId: 'claude-opus-4-8', matterId: MATTER });

  check('the citation is reported as NOT CHECKED', r.flag === 'unchecked', r.flag);
  check('and it carries no rating at all — not "medium"', r.rating === null, r.rating);
  check('the note is the exact sentence, in words a lawyer can act on',
    r.flags.some((f) => f.kind === 'unreadable' && f.detail === UNREADABLE_CHECK_DETAIL),
    JSON.stringify(r.flags));
  check('the label a reader sees says not checked', FLAG_LABEL[r.flag] === UNREADABLE_CHECK_DETAIL);

  // THE WHOLE POINT. Never "not found", never verified.
  check('it is NOT reported as verified', r.flag !== 'green' && r.flag !== 'lean-green');
  check('it is NOT reported as a fabrication', r.flag !== 'red' && r.flag !== 'lean-red');
  check('it is NOT reported as "not found on the free DBs"',
    r.flag !== 'blue' && !r.flags.some((f) => f.kind === 'fetch'), JSON.stringify(r.flags));
  check('NOTHING was persisted from the failed attempt — no authority row',
    !writes.some((w) => w.table === 'authorities'), JSON.stringify(writes));
  check('and no verification was logged either',
    !writes.some((w) => w.table === 'authority_verifications'), JSON.stringify(writes));
  check('exactly two calls — a third is not paid for', llmCalls().length === 2, llmCalls().length);
}

// -- unreadable beats every other signal ------------------------------------
check('decideFlag returns unchecked even where the source WAS verified and the rating would be high',
  decideFlag({ verification_status: 'verified', rating: 'high', flags: [], unreadable: true }) === 'unchecked');
check('decideFlag is unchanged when the answer WAS readable',
  decideFlag({ verification_status: 'verified', rating: 'high', flags: [] }) === 'green'
  && decideFlag({ verification_status: 'verified', rating: 'low', flags: [] }) === 'red'
  && decideFlag({ verification_status: 'partial', rating: 'medium', flags: [{ kind: 'fetch', detail: 'x' }] }) === 'blue');

// -- 402 on the rating stops the run; it does NOT mark the citation ---------
{
  reset([{ status: 402, body: { error: 'budget_exhausted', message: 'This month’s AI budget is spent.' } }]);
  legalSourceReply = FOUND;
  let threw = null;
  try { await checkOne(CITE, { modelId: 'claude-opus-4-8', matterId: MATTER }); } catch (e) { threw = e; }
  check('402 mid-run: the run stops', threw?.name === 'ServerRefusalError');
  check('402 mid-run: with the server’s own sentence',
    threw?.message === 'This month’s AI budget is spent.', threw?.message);
  check('402 mid-run: the citation is NOT quietly marked "not checked"', threw !== null);
  check('402 mid-run: and no repair was bought', llmCalls().length === 1, llmCalls().length);
}
{
  // retry-after is 130s deliberately: `waitOutRateWindow` sits out a window up
  // to 120s, so a shorter one would make this harness sleep. Past the ceiling
  // the refusal is handed straight to the caller, which is the path under test.
  reset([
    { input: { verdict: 'sound' } },
    { status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': '130' } },
  ]);
  legalSourceReply = FOUND;
  let threw = null;
  try { await checkOne(CITE, { modelId: 'claude-opus-4-8', matterId: MATTER }); } catch (e) { threw = e; }
  check('429 on the repair turn: it is the rate window, not a contract failure',
    threw?.refusal?.kind === 'rate' && threw?.refusal?.retryAfterSeconds === 130, threw?.message);
  check('429 on the repair turn: the sentence says when to come back, and never "unreadable"',
    /130 seconds/.test(threw?.message ?? '') && !(threw?.message ?? '').includes('unreadable'),
    threw?.message);
}

// -- a 402 from the SOURCE lookup is still not "cite not found" (PR #171) ----
{
  reset([]);
  const realLegal = legalSourceReply;
  globalThis.fetch = (async (url, init) => {
    if (url === '/api/legal-source') {
      return new Response(JSON.stringify({ error: 'budget_exhausted', message: 'This month’s AI budget is spent.' }), {
        status: 402, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected ${url}`);
  });
  let threw = null;
  try { await checkOne(CITE, { modelId: 'claude-opus-4-8', matterId: MATTER }); } catch (e) { threw = e; }
  check('a 402 from the source lookup stops the run, and is not flattened into "not found"',
    threw?.name === 'ServerRefusalError' && threw?.refusal?.kind === 'budget', threw?.message);
  legalSourceReply = realLegal;
}

globalThis.fetch = realFetch;

// ---------------------------------------------------------------------------
section('6. The arithmetic reconciles');
// ---------------------------------------------------------------------------

const result = (flag, rating) => ({
  cite: { ...CITE, citation_bluebook: `${GRAHAM} [${flag}]` },
  authority_id: null, source_label: 'CourtListener', source_url: null,
  rating, justification: rating ? 'because' : '',
  verification_status: rating ? 'verified' : 'partial',
  flags: flag === 'unchecked' ? [{ kind: 'unreadable', detail: UNREADABLE_CHECK_DETAIL }] : [],
  flag,
});

const mix = [
  result('green', 'high'), result('green', 'high'),
  result('lean-green', 'medium'),
  result('lean-red', 'low'),
  result('red', 'low'),
  result('blue', 'medium'),
  result('unchecked', null), result('unchecked', null), result('unchecked', null),
];
const counts = tallyFlags(mix);

check('every extracted citation lands in exactly one bucket',
  citesAccountedFor(counts) === mix.length, `${citesAccountedFor(counts)} vs ${mix.length}`);
check('extracted = checked + not checked',
  mix.length === citesChecked(counts) + counts.not_checked,
  `${mix.length} = ${citesChecked(counts)} + ${counts.not_checked}`);
check('the not-checked count is the number that could not be read', counts.not_checked === 3, counts.not_checked);
check('the checked count excludes them', citesChecked(counts) === 6, citesChecked(counts));

{
  const md = renderReport('Opposition Brief.docx', mix, { counts, setAside: 2 });
  check('the report states what was extracted', md.includes('**Citations extracted:** 9'));
  check('the report states checked and not checked separately',
    md.includes('**Checked:** 6 · **Not checked:** 3'), md.split('\n').slice(0, 10).join(' | '));
  check('the report explains what "not checked" means, in a lawyer’s words',
    md.includes('neither verified nor') && md.includes('still need checking by hand'));
  check('the report declares the entries set aside as not in the draft',
    md.includes('could not be found in the draft'));
  check('a not-checked citation prints no confidence it was never given',
    md.includes('- **Confidence:** not rated') && !md.includes('- **Confidence:** null'));
  check('and it is labelled not checked in its own entry',
    md.includes(`- **Status:** ${UNREADABLE_CHECK_DETAIL}`));
  check('the numbers in the header add up on the page',
    (() => {
      const extracted = Number(/\*\*Citations extracted:\*\* (\d+)/.exec(md)[1]);
      const ck = Number(/\*\*Checked:\*\* (\d+)/.exec(md)[1]);
      const nc = Number(/\*\*Not checked:\*\* (\d+)/.exec(md)[1]);
      return extracted === ck + nc;
    })());
}
{
  const toa = renderToa(mix);
  check('the Table of Authorities legend names the not-checked glyph',
    toa.includes('— not checked'));
  check('a not-checked citation still appears in the Table of Authorities, glyphed',
    toa.includes('— **' + GRAHAM + ' [unchecked]**'), toa.split('\n').filter((l) => l.includes('unchecked')).join(' | '));
}

// A run from before this existed has no `not_checked` key at all.
check('an old run’s counts still reconcile, read with ?? 0',
  citesAccountedFor({ green: 2, lean_green: 1, lean_red: 0, red: 0, blue: 1 }) === 4);

// ---------------------------------------------------------------------------
console.log('');
if (failures) {
  console.log(`${failures} check${failures === 1 ? '' : 's'} FAILED`);
} else {
  console.log('ALL CHECKS PASSED');
}
process.exit(failures ? 1 : 0);
