// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-brief-carry.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { carryPlan, carryNote, openProblems, latestByCite } from '../src/lib/brief/confirmations-core.ts';

const row = (o) => ({ id: o.id, document_id: 'v8', cite_raw: o.raw, context: o.ctx ?? '', pm_from: o.from ?? null,
  authority_document_id: null, authority_title: null, authority_page: null, status: o.status ?? 'confirmed',
  note: o.note ?? '', initials: 'EQ', user_id: 'u', created_at: o.at ?? '2026-09-28T12:41:00Z' });

const V9 = `Mr. Bushell seeks declaratory relief under CPLR 3001 on each question. The Holder Rule, 16 C.F.R. § 433.2, applies.
Matter of Trump v. Engoron, 222 A.D.3d 505, 506 (1st Dep’t 2023), decided a different question about stays.
Administrative Code § 20-393(4) was never the basis of the charge.`;

test('carry: same words, same sentence → carried; sentence changed → read again; words gone → gone', () => {
  const plan = carryPlan([
    row({ id: '1', raw: 'CPLR 3001', ctx: 'Mr. Bushell seeks declaratory relief under CPLR 3001 on each question.' }),
    row({ id: '2', raw: '222 A.D.3d 505, 506', ctx: 'Matter of Trump v. Engoron, 222 A.D.3d 505, 506 (1st Dep’t 2023), held that a stay was required.' }),
    row({ id: '3', raw: 'CPLR 7805', ctx: 'and a stay under CPLR 7805.' }),
    row({ id: '4', raw: '16 C.F.R. § 433.2', ctx: '' }),
  ], V9);
  assert.deepEqual(plan.carry.map((r) => r.id), ['1', '4']);
  assert.deepEqual(plan.changed.map((r) => r.id), ['2']);
  assert.deepEqual(plan.gone.map((r) => r.id), ['3']);
});

test('carry: only the LATEST reading of each occurrence is considered; whitespace differences do not matter', () => {
  const plan = carryPlan([
    row({ id: 'a', raw: 'CPLR 3001', ctx: 'Mr. Bushell seeks declaratory relief under CPLR 3001 on each question.', status: 'problem', at: '2026-09-28T10:00:00Z' }),
    row({ id: 'b', raw: 'CPLR  3001', ctx: 'Mr. Bushell seeks   declaratory relief under CPLR 3001 on each question.', status: 'confirmed', at: '2026-09-28T11:00:00Z' }),
  ], V9);
  assert.equal(plan.carry.length, 1);
  assert.equal(plan.carry[0].status, 'confirmed');
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
