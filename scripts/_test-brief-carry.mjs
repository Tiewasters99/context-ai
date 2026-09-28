// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-brief-carry.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { carryPlan, carryNote } from '../src/lib/brief/confirmations-core.ts';

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
