// Trademark Clearance — search-term generation (spec §3, §7).
//
//   node --test scripts/_test-trademark-queries.mjs
//
// The EQUAZIA golden set; the well-formedness rules; the EQUASITE-via-Q5
// lesson; multi-word quoting; the caps; Q8's exclusion check rescuing a
// known mark; regeneration keeping run queries; the procedure hash.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateQueries, queryProblems, cmMatches, variantsOf, planRegeneration, nextManualSeq,
  decompositionProblems, classGroup,
} from '../lib/trademark/queries.mjs';
import { exclusionCheck, proposeExclusions } from '../lib/trademark/triage.mjs';
import { PROCEDURE, procedureHash, procedureText, canonicalJson } from '../lib/trademark/procedure.mjs';

const GOLDEN_INPUT = {
  mark: 'EQUAZIA',
  decomposition: { opening: 'equa', hinge: 'z', ending: 'ia' },
  searchClasses: ['009', '042', '045'],
  knownMarks: [{ name: 'EQUALL', owner: 'Equall Inc.' }],
  foreignEquivalents: ['equazione', 'equacion'],
  exclusions: ['equal', 'equat', 'equator', 'equit'],
};
const CLS = 'IC:(009 042 045 a b 200)';

const bySeq = (qs) => Object.fromEntries(qs.map((q) => [q.seq, q]));
const termsOf = (query) => {
  const m = /^CM:\(([^)]*)\)/.exec(query);
  return m ? m[1].split(' ') : [];
};

test('the EQUAZIA golden set (spec §3)', () => {
  const { queries, warnings } = generateQueries(GOLDEN_INPUT);
  const q = bySeq(queries);
  assert.deepEqual(warnings, []);
  assert.equal(q[0].query, 'SN:90562533');
  assert.equal(q[0].purpose, 'selftest');
  assert.equal(q[1].query, 'CM:equazia');
  assert.equal(q[2].query, 'CM:*equaz*');
  assert.equal(q[3].query, 'CM:equa?ia AND LD:true');
  for (const v of ['equasia', 'ekwazia', 'equazzia', 'equaxia', 'ekwasia']) {
    assert.ok(termsOf(q[4].query).includes(v), `Q4 has ${v}: ${q[4].query}`);
  }
  assert.ok(q[4].query.endsWith(') AND LD:true'), 'Q4 is live-only and NOT class-filtered (a rare string)');
  for (const s of ['equas*', 'ekwaz*', 'equax*']) assert.ok(termsOf(q[5].query).includes(s), `Q5 has ${s}: ${q[5].query}`);
  assert.ok(q[5].query.endsWith(`AND LD:true AND ${CLS}`));
  for (const e of ['*azia', '*azya', '*asia']) assert.ok(termsOf(q[6].query).includes(e), `Q6 has ${e}: ${q[6].query}`);
  assert.ok(q[6].query.endsWith(`AND LD:true AND ${CLS}`));
  assert.equal(q[7].query, `CM:equa* AND LD:true AND ${CLS}`);
  assert.equal(q[8].query, `CM:equa* AND LD:true AND ${CLS} AND NOT CM:(equal* equat* equator* equit*)`);
  assert.equal(q[9].query, 'CM:equall');
  assert.equal(q[9].purpose, 'known');
  assert.equal(q[10].query, 'ON:"equall inc"');
  assert.equal(q[10].purpose, 'owner');
  assert.equal(q[11].query, `CM:(equazione equacion) AND LD:true AND ${CLS}`);
  assert.equal(q[11].purpose, 'foreign');
  assert.deepEqual(queries.map((x) => x.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('the class-filter rule: rare strings unfiltered, broad strings filtered, known names no filters at all', () => {
  const q = bySeq(generateQueries(GOLDEN_INPUT).queries);
  for (const n of [1, 2, 4]) assert.ok(!q[n].query.includes('IC:'), `Q${n} has no class filter`);
  for (const n of [5, 6, 7, 8, 11]) {
    assert.ok(q[n].query.includes(CLS), `Q${n} is class-filtered`);
    assert.deepEqual(q[n].class_filter, ['009', '042', '045']);
    assert.equal(q[n].live_only, true);
  }
  for (const n of [9, 10]) {
    assert.ok(!q[n].query.includes('LD:') && !q[n].query.includes('IC:'), `Q${n} (known) has no LD and no class filter`);
    assert.equal(q[n].live_only, false);
  }
});

test('every generated query is well formed', () => {
  for (const q of generateQueries(GOLDEN_INPUT).queries) {
    assert.deepEqual(queryProblems(q.query), [], `Q${q.seq}: ${q.query}`);
    assert.ok(!/"[^"]*[*?][^"]*"/.test(q.query), `no wildcard inside quotes: ${q.query}`);
    assert.equal(q.generator_version, 'tm-queries/1');
  }
});

test('the well-formedness check catches what it should', () => {
  assert.ok(queryProblems('CM:(equa* AND LD:true').includes('unbalanced parentheses'));
  assert.ok(queryProblems('CM:"equa*"').some((p) => p.startsWith('wildcard inside quotes')));
  assert.ok(queryProblems('cm:equa*').some((p) => p.startsWith('field tag must be upper case')));
  assert.ok(queryProblems('CM:EQUAZIA').some((p) => p.startsWith('terms are lower case')));
  assert.ok(queryProblems('CM:equa* AND IC:(9 042)').some((p) => p.startsWith('class must be three digits')));
  assert.ok(queryProblems('CM:equa* AND LD:yes').some((p) => p.startsWith('LD: takes')));
  assert.deepEqual(queryProblems('ON:"world wide" AND FD:[20230701 TO *]'), []);
});

test('the lesson: EQUASITE is caught by Q5 (equas*) and by nothing earlier', () => {
  const qs = generateQueries(GOLDEN_INPUT).queries;
  const first = qs.find((q) => cmMatches(q.query, 'EQUASITE'));
  assert.equal(first?.seq, 5, `first query to catch EQUASITE: Q${first?.seq}`);
  for (const q of qs.filter((x) => x.seq < 5)) assert.equal(cmMatches(q.query, 'EQUASITE'), false, `Q${q.seq} must not catch it`);
});

test('the prefix sweep catches EQUALL, and the narrowed sweep would lose it (why the exclusion check exists)', () => {
  const q = bySeq(generateQueries(GOLDEN_INPUT).queries);
  assert.equal(cmMatches(q[7].query, 'EQUALL'), true);
  assert.equal(cmMatches(q[8].query, 'EQUALL'), false);
  assert.equal(cmMatches(q[9].query, 'EQUALL'), true, 'but the known-mark query still finds it');
});

test('a multi-word mark: the exact query is a quoted phrase, and no wildcard sits inside quotes', () => {
  const { queries } = generateQueries({
    mark: 'Blue Equazia', decomposition: { opening: 'equa', hinge: 'z', ending: 'ia' }, searchClasses: ['042'],
    knownMarks: [{ name: 'Equall Copilot', owner: 'Equall, Inc.' }],
  });
  const q = bySeq(queries);
  assert.equal(q[1].query, 'CM:"blue equazia"');
  assert.equal(q[9].query, 'CM:"equall copilot"');
  assert.equal(q[10].query, 'ON:"equall inc"');
  for (const x of queries) assert.deepEqual(queryProblems(x.query), [], x.query);
  assert.equal(cmMatches(q[1].query, 'BLUE EQUAZIA SOFTWARE'), true);
  assert.equal(cmMatches(q[1].query, 'EQUAZIA BLUE'), false);
});

test('a decomposition that does not spell the mark is refused, with a sentence', () => {
  assert.deepEqual(decompositionProblems('EQUAZIA', { opening: 'equa', hinge: 'z', ending: 'ia' }), []);
  assert.match(decompositionProblems('EQUAZIA', { opening: 'equ', hinge: 'z', ending: 'ia' }).join(' '), /not the mark/);
  assert.match(decompositionProblems('EQUAZIA', { opening: 'EQUA', hinge: 'z', ending: 'ia' }).join(' '), /lower-case/);
  assert.throws(() => generateQueries({ ...GOLDEN_INPUT, decomposition: { opening: 'x', hinge: '', ending: 'y' } }), /not the mark/);
});

test('caps: Q4 holds at most variantCap terms, Q5 stemCap, Q6 endingCap; no duplicates; never the word itself', () => {
  const cap = PROCEDURE.substitutions.variantCap;
  const q = bySeq(generateQueries(GOLDEN_INPUT).queries);
  const v = termsOf(q[4].query);
  assert.ok(v.length <= cap && v.length > 0);
  assert.equal(new Set(v).size, v.length);
  assert.ok(!v.includes('equazia'));
  assert.ok(termsOf(q[5].query).length <= PROCEDURE.substitutions.stemCap);
  assert.ok(termsOf(q[6].query).length <= PROCEDURE.substitutions.endingCap);
  assert.equal(variantsOf('equazia', { cap: 3 }).length, 3);
  assert.deepEqual(variantsOf('equazia', { cap: 3 }), ['equasia', 'equazzia', 'equaxia'], 'tier 1 singles come first');
});

test('Q8 waits for Q7: without confirmed exclusions it is not generated, and the warning says why', () => {
  const { queries, warnings } = generateQueries({ ...GOLDEN_INPUT, exclusions: null });
  assert.equal(queries.find((q) => q.seq === 8), undefined);
  assert.ok(warnings.some((w) => /Q8/.test(w)));
  assert.equal(queries.find((q) => q.purpose === 'known')?.seq, 9, 'numbers do not shift when Q8 is absent');
});

test('the exclusion check: equal* would swallow the known mark EQUALL and a noted hit EQUALITY AI; the hit is rescued', () => {
  const check = exclusionCheck({
    exclusions: ['equal', 'equat'],
    knownMarks: [{ name: 'EQUALL', owner: 'Equall Inc.' }],
    hits: [
      { serial: '11111111', mark: 'EQUALITY AI', bin: 'note' },
      { serial: '22222222', mark: 'EQUATOR', bin: 'dismiss' },
      { serial: '33333333', mark: 'EQUASITE', bin: 'flag' },
    ],
  });
  assert.ok(check.swallowed.some((s) => s.kind === 'known' && s.name === 'EQUALL' && s.stem === 'equal'));
  assert.ok(check.swallowed.some((s) => s.kind === 'hit' && s.serial === '11111111'));
  assert.ok(!check.swallowed.some((s) => s.serial === '22222222'), 'a dismissed hit is not protected');
  assert.ok(!check.swallowed.some((s) => s.serial === '33333333'), 'an exclusion that does not match swallows nothing');
  assert.deepEqual(check.rescue, ['EQUALITY AI'], 'the known mark already has its own query; the hit gets one');
  const { queries } = generateQueries({ ...GOLDEN_INPUT, rescued: check.rescue.concat(['EQUALL']) });
  const rescued = queries.filter((q) => q.purpose === 'rescued');
  assert.deepEqual(rescued.map((q) => q.query), ['CM:"equality ai"'], 'EQUALL is not duplicated');
  assert.equal(rescued[0].seq, 12);
});

test('proposed exclusions come from Q7\'s captured marks: the defaults that occur, then frequent stems', () => {
  const marks = ['EQUAL TIME', 'EQUALIZER', 'EQUATION LABS', 'EQUITY ONE', 'EQUASITE', 'EQUALL',
    'EQUINE', 'EQUINOX', 'EQUINEX', 'EQUINO', 'EQUINA', 'EQUINI'];
  const p = proposeExclusions(marks, 'equa');
  assert.deepEqual(p.proposed.filter((x) => x.source === 'default').map((x) => x.stem), ['equal', 'equat'], 'equator / equit do not occur here');
  assert.equal(p.overThreshold, false);
  assert.equal(proposeExclusions(Array.from({ length: 80 }, (_, i) => `EQUA${i}`), 'equa').overThreshold, true);
});

test('regeneration replaces only queries not yet run; manual queries stay', () => {
  const existing = [
    { id: 'a', seq: 0, purpose: 'selftest', query: 'SN:90562533', run_count: 1 },
    { id: 'b', seq: 1, purpose: 'exact', query: 'CM:equazia', run_count: 0 },
    { id: 'c', seq: 9, purpose: 'known', query: 'CM:oldname', run_count: 2 },
    { id: 'd', seq: 100, purpose: 'manual', query: 'CM:equaz?a', run_count: 0 },
  ];
  const { queries } = generateQueries(GOLDEN_INPUT);
  const plan = planRegeneration(existing, queries);
  assert.deepEqual(plan.remove, ['b'], 'only the un-run generated query is removed');
  assert.ok(!plan.insert.some((q) => q.query === 'SN:90562533'), 'the run self-test is not duplicated');
  const known = plan.insert.find((q) => q.query === 'CM:equall');
  assert.ok(known && known.seq !== 9, 'a new query never takes the number of a run one');
  assert.equal(new Set(plan.insert.map((q) => q.seq)).size, plan.insert.length);
  assert.ok(plan.insert.every((q) => ![0, 9, 100].includes(q.seq)));
  assert.equal(nextManualSeq(existing), 101);
});

test('classGroup pads and sorts', () => {
  assert.equal(classGroup(['42', '009']), 'IC:(009 042 a b 200)');
  assert.equal(classGroup([]), '');
});

test('the procedure: every row has a why; the hash is stable and moves with the data', async () => {
  for (const r of PROCEDURE.substitutions.rows) assert.ok(r.why && r.why.length > 10, r.id);
  for (const n of PROCEDURE.classes.notes) assert.ok(n.why, n.code);
  for (const f of PROCEDURE.forbidden.phrases) assert.ok(f.why, f.phrase);
  assert.ok(PROCEDURE.selftest.why && PROCEDURE.exclusions.why.equa && PROCEDURE.endings.why);
  assert.equal(PROCEDURE.syntax.verified, '2026-10-18');
  const h1 = await procedureHash();
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(await procedureHash(), h1);
  const changed = { ...PROCEDURE, selftest: { ...PROCEDURE.selftest, serial: '00000000' } };
  assert.notEqual(await procedureHash(changed), h1);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  assert.ok(procedureText().startsWith('substitutions.json {'));
});
