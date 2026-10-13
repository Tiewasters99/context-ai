// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-brief-carry.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { carryPlan, carryNote, openProblems, latestByCite, briefParagraphs, matchText, answersProblem, rewordedNote } from '../src/lib/brief/confirmations-core.ts';

const row = (o) => ({ id: o.id, document_id: 'v8', cite_raw: o.raw, context: o.ctx ?? '', pm_from: o.from ?? null,
  authority_document_id: null, authority_title: null, authority_page: null, status: o.status ?? 'confirmed',
  note: o.note ?? '', initials: 'EQ', user_id: 'u', created_at: o.at ?? '2026-09-28T12:41:00Z' });

const V9 = `Mr. Bushell seeks declaratory relief under CPLR 3001 on each question. The Holder Rule, 16 C.F.R. § 433.2, applies.
Matter of Trump v. Engoron, 222 A.D.3d 505, 506 (1st Dep’t 2023), decided a different question about stays.
Administrative Code § 20-393(4) was never the basis of the charge.`;
const V9P = V9.split(String.fromCharCode(10));

test('carry: same words, same sentence → carried; sentence changed → read again; words gone → gone', () => {
  const plan = carryPlan([
    row({ id: '1', raw: 'CPLR 3001', ctx: 'Mr. Bushell seeks declaratory relief under CPLR 3001 on each question.' }),
    row({ id: '2', raw: '222 A.D.3d 505, 506', ctx: 'Matter of Trump v. Engoron, 222 A.D.3d 505, 506 (1st Dep’t 2023), held that a stay was required.' }),
    row({ id: '3', raw: 'CPLR 7805', ctx: 'and a stay under CPLR 7805.' }),
    row({ id: '4', raw: '16 C.F.R. § 433.2', ctx: '' }),
  ], V9P);
  assert.deepEqual(plan.carry.map((r) => r.row.id), ['1', '4']);
  assert.deepEqual(plan.changed.map((r) => r.row.id), ['2']);
  assert.equal(plan.changed[0].paragraph, V9P[1]);
  assert.deepEqual(plan.gone.map((r) => r.id), ['3']);
});

test('carry: only the LATEST reading of each occurrence is considered; whitespace differences do not matter', () => {
  const plan = carryPlan([
    row({ id: 'a', raw: 'CPLR 3001', ctx: 'Mr. Bushell seeks declaratory relief under CPLR 3001 on each question.', status: 'problem', at: '2026-09-28T10:00:00Z' }),
    row({ id: 'b', raw: 'CPLR  3001', ctx: 'Mr. Bushell seeks   declaratory relief under CPLR 3001 on each question.', status: 'confirmed', at: '2026-09-28T11:00:00Z' }),
  ], V9P);
  assert.equal(plan.carry.length, 1);
  assert.equal(plan.carry[0].row.status, 'confirmed');
});

test('the carried row says where it came from and who read it', () => {
  const n = carryNote(row({ id: '1', raw: 'x', note: 'pin checked' }), 'Bushell-Verified-Petition-Art78-v8');
  assert.match(n, /^carried from “Bushell-Verified-Petition-Art78-v8” — confirmed by EQ .*; same words, same sentence\. pin checked$/);
});

test('open problems: a flag redrafted away stays open and says so, until resolved by hand (¶ 90, 10-02)', () => {
  const OLD = 'where “there are plausible ways to complete a proposed transaction lawfully,” the speech';
  const NEW = 'However, if . . . there are plausible ways to complete a proposed transaction lawfully';
  const brief = `90. The speech subdivision (17) forbids concerns lawful activity. ${NEW}, speech is protected.
65. Only pro-rata distribution is sought.`;
  const flag = row({ id: 'p90', raw: OLD, ctx: '90. Speech proposing a commercial transaction loses protection only…', from: 5000, status: 'problem', note: 'Does not quite state the law correctly', at: '2026-10-02T00:59:47Z' });
  const newOk = row({ id: 'c90', raw: NEW, ctx: '90. The speech subdivision (17)…', from: 5010, at: '2026-10-02T09:53:12Z' });
  const p65 = row({ id: 'p65', raw: 'pro-rata distribution', ctx: '65. Only pro-rata…', status: 'problem', at: '2026-10-02T00:32:43Z' });
  const rows = [flag, newOk, p65];

  // Confirming the NEW wording does not answer the old flag: different words.
  const open = openProblems(rows, brief);
  assert.deepEqual(open.map((o) => [o.row.id, o.inBrief]), [['p90', false], ['p65', true]]);

  // Resolving by hand: a confirmed reading of the SAME occurrence, with the note.
  const resolved = row({ id: 'r90', raw: OLD, ctx: flag.context, from: flag.pm_from, note: 'Redrafted to quote the holding', at: '2026-10-02T10:30:00Z' });
  const after = [...rows, resolved];
  assert.deepEqual(openProblems(after, brief).map((o) => o.row.id), ['p65']);
  // …and the flag's own occurrence now reads green in the counts.
  const latest = latestByCite(after).find((r) => r.cite_raw === OLD);
  assert.equal(latest?.id, 'r90');
  assert.equal(latest?.status, 'confirmed');
});

test('carry ignores the paragraph number, quote marks and dashes, and writes the NEW version’s words (Bushell, 10-13)', () => {
  const NEW = [
    '19. The First Department held exhaustion is not required. Matter of Rosenblum, 75 A.D.3d 426, 426–27 (1st Dep’t 2010).',
    '4. The second question is whether the Department may enforce its statute. Administrative Code § 20-393(4).',
  ];
  const plan = carryPlan([
    row({ id: 'q', raw: '75 A.D.3d 426, 426-27', ctx: "17. The First Department held exhaustion is not required. Matter of Rosenblum, 75 A.D.3d 426, 426-27 (1st Dep't 2010)." }),
    row({ id: 'n', raw: 'Administrative Code § 20-393(4)', ctx: '3. The second question is whether the Department may enforce its statute. Administrative Code § 20-393(4).' }),
    row({ id: 'w', raw: 'Administrative Code § 20-393(4)', ctx: '3. The second question is whether the Department may enforce its statutes as written. Administrative Code § 20-393(4).' }),
  ], NEW);
  const byId = Object.fromEntries(plan.carry.map((c) => [c.row.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), ['n', 'q']);
  assert.equal(byId.q.context, NEW[0]);                 // stored in the new words, so it turns green there
  assert.equal(byId.q.cite_raw, '75 A.D.3d 426, 426–27');
  assert.equal(byId.q.differs, 'number');
  assert.equal(byId.n.differs, 'number');
  assert.match(carryNote(byId.q.row, 'v18', byId.q.differs), /paragraph renumbered$/);
  // the same cite read in an older wording of that paragraph: the carried reading already covers it
  assert.deepEqual(plan.changed, []);
  assert.equal(plan.already, 1);
  assert.equal(matchText('“A—B”'), '"A-B"');
});

test('carry twice adds nothing: readings already on the new version are skipped', () => {
  const NEW = ['Mr. Bushell seeks relief under CPLR 3001 on each question.'];
  const old = [row({ id: '1', raw: 'CPLR 3001', ctx: NEW[0] })];
  const first = carryPlan(old, NEW);
  const target = first.carry.map((c) => ({ ...c.row, id: 't1', document_id: 'v9', cite_raw: c.cite_raw, context: c.context, note: carryNote(c.row, 'v8') }));
  const again = carryPlan(old, NEW, target);
  assert.equal(again.carry.length, 0);
  assert.equal(again.already, 1);
});

test('an open problem goes across open even when its words are gone; an answered one does not go red', () => {
  const NEW = ['However, there are plausible ways to complete a transaction, so the speech is protected.', 'Only pro-rata distribution is sought.'];
  const gone = row({ id: 'p90', raw: 'plausible ways to complete a proposed transaction lawfully', ctx: '90. where there are plausible ways to complete a proposed transaction lawfully', status: 'problem', at: '2026-10-02T00:59:47Z' });
  const answered = row({ id: 'p65', raw: 'pro-rata distribution', ctx: 'Only pro-rata distribution is sought.', status: 'problem', at: '2026-10-02T00:32:43Z' });
  const answer = row({ id: 'c65', raw: 'pro-rata distribution', ctx: '65. Language of g(4) confirmed: pro-rata distribution', at: '2026-10-02T09:00:00Z' });
  const plan = carryPlan([gone, answered, answer], NEW);
  assert.deepEqual(plan.openFlags.map((r) => r.id), ['p90']);
  assert.ok(!plan.carry.some((c) => c.row.status === 'problem'));
  // and once it is on the new version, it is not carried again
  const again = carryPlan([gone, answered, answer], NEW, [{ ...gone, id: 'x', document_id: 'v9' }]);
  assert.deepEqual(again.openFlags, []);
});

test('briefParagraphs names a sentence the way the desk does: footnote text left out, hard breaks add nothing', () => {
  const doc = { type: 'doc', content: [
    { type: 'heading', content: [{ type: 'text', text: 'ARGUMENT' }] },
    { type: 'paragraph', content: [
      { type: 'text', text: '12. The rule  applies.' },
      { type: 'footnote', content: [{ type: 'text', text: 'See CPLR 7803.' }] },
      { type: 'hardBreak' },
      { type: 'text', text: ' It always has.' },
    ] },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted.' }] }] },
  ] };
  assert.deepEqual(briefParagraphs(doc), ['ARGUMENT', '12. The rule applies. It always has.', 'See CPLR 7803.', 'Quoted.']);
});

test('the Log says "Resolved" only for a confirmation that answers a problem; a carried or reviewed line is not one', () => {
  const p = row({ id: 'p', raw: 'CPLR 3001', status: 'problem', at: '2026-10-01T10:00:00Z' });
  const fix = row({ id: 'f', raw: 'CPLR 3001', note: 'pin added', at: '2026-10-01T11:00:00Z' });
  const carried = row({ id: 'c', raw: 'CPLR 3001', note: 'carried from “v8” — confirmed by EQ', at: '2026-10-01T12:00:00Z' });
  const plain = row({ id: 'k', raw: 'CPLR 7803', note: 'checked', at: '2026-10-01T12:00:00Z' });
  const all = [p, fix, carried, plain];
  assert.equal(answersProblem(all, fix), true);
  assert.equal(answersProblem(all, carried), false);
  assert.equal(answersProblem(all, plain), false);
  assert.match(rewordedNote(row({ id: 'r', raw: 'x' }), 'v18'), /^read on “v18” by EQ .*reworded since, and the change was reviewed against that reading$/);
});
