// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-brief-edit-lease.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextLeaseState, isLeaseMissing } from '../src/lib/brief/edit-lease-core.ts';

const ME = 'u-me';
const row = (o) => ({ holder_is_me: false, holder_user: 'u-other', holder_name: 'Bob', claimed_at: '2026-10-02T10:02:00Z', ...o });

test('holding, someone else holding, and a hold lost', () => {
  assert.deepEqual(nextLeaseState({ kind: 'checking' }, row({ holder_is_me: true, holder_user: ME }), ME), { kind: 'mine' });
  const theirs = nextLeaseState({ kind: 'checking' }, row(), ME);
  assert.equal(theirs.kind, 'theirs');
  assert.equal(theirs.lost, false, 'opened second: read-only, nothing lost');
  assert.equal(theirs.holderName, 'Bob');
  const lost = nextLeaseState({ kind: 'mine' }, row(), ME);
  assert.equal(lost.lost, true, 'held, then taken over: lost');
  assert.equal(nextLeaseState(lost, row(), ME).lost, true, 'and it stays "lost" on later renewals');
  assert.equal(nextLeaseState({ kind: 'checking' }, row({ holder_user: ME }), ME).sameUser, true, 'my own other window');
  assert.equal(nextLeaseState({ kind: 'checking' }, row({ holder_name: '' }), ME).holderName, 'someone');
});

test('nobody holding (a viewer) is "off": the desk behaves as before', () => {
  assert.deepEqual(nextLeaseState({ kind: 'checking' }, null, ME), { kind: 'off' });
});

test('105 not pasted yet is recognised, and a real error is not', () => {
  assert.equal(isLeaseMissing({ code: 'PGRST202', message: 'Could not find the function public.claim_brief_edit' }), true);
  assert.equal(isLeaseMissing({ code: '42883', message: 'function public.claim_brief_edit(...) does not exist' }), true);
  assert.equal(isLeaseMissing({ code: '28000', message: 'not signed in' }), false);
  assert.equal(isLeaseMissing(null), false);
});
