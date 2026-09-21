// The first five minutes of a brand-new account, asserted.
//
// Run:  node --import ./scripts/_node-src-loader.mjs --test scripts/_test-first-run.mjs
// (The loader is needed because first-run.ts imports '@/lib/plan'.)
//
// Offline by construction: no network, no database, no React rendering. The
// rules live in src/components/firstrun/first-run.ts as pure functions, the
// create path takes its client as an argument so scripts/_fake-supabase.mjs
// can drive it, and the React wiring that a Node harness cannot mount is
// asserted against the source text at the bottom — deliberately narrow
// assertions, each naming the one expression that would have to change for the
// behaviour to regress.
//
// Untracked by convention elsewhere in scripts/, but this one is a gate: it
// exits non-zero through `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPLETION_KINDS,
  CONNECTIONS_PATH,
  FIRST_RUN_DISMISS_PREFIX,
  MAX_WORKSPACE_NAME,
  RECORD_TAB,
  STEP_IDS,
  UNKNOWN_FACTS,
  createFirstServerspace,
  defaultWorkspaceName,
  dismissKey,
  hasAnyMatter,
  pickFirstMatter,
  pickFirstServerspace,
  readDismissed,
  recordPathFor,
  shouldShowFirstRun,
  stepDone,
  stepReady,
  vaultPathFor,
  writeDismissed,
} from '../src/components/firstrun/first-run.ts';
import { FIRST_RUN_COPY, NAME_TOKEN } from '../src/components/firstrun/copy.ts';
import { fakeSupabase } from './_fake-supabase.mjs';
import { VAULT_MAX_BYTES, formatBytes } from '../lib/ingest-formats.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');

// ---------------------------------------------------------------------------
// 1. Who sees the docket
// ---------------------------------------------------------------------------

const SETTLED = { plan: 'free', planLoading: false, serverspacesLoading: false, dismissed: false };

test('a brand-new free account sees the docket', () => {
  assert.equal(shouldShowFirstRun(SETTLED), true);
});

test('every paid tier sees it too — only workshop is different', () => {
  for (const plan of ['free', 'basic', 'pro', 'max']) {
    assert.equal(shouldShowFirstRun({ ...SETTLED, plan }), true, plan);
  }
  assert.equal(shouldShowFirstRun({ ...SETTLED, plan: 'workshop' }), false);
});

test('an account part-way through still sees it — that is what the ticks are for', () => {
  // Visibility does not depend on the facts at all: a serverspace with no
  // matter is exactly the case requirement 4 names, and the docket marks
  // step 1 done rather than disappearing.
  assert.equal(shouldShowFirstRun(SETTLED), true);
  const partly = { ...UNKNOWN_FACTS, hasServerspace: true, hasMatter: false };
  assert.equal(stepDone('workspace', partly), true);
  assert.equal(stepDone('matter', partly), false);
});

test('dismissed is final — it outranks every other condition', () => {
  assert.equal(shouldShowFirstRun({ ...SETTLED, dismissed: true }), false);
  assert.equal(
    shouldShowFirstRun({ plan: null, planLoading: true, serverspacesLoading: true, dismissed: true }),
    false,
  );
});

test('nothing is shown while the plan is unknown — never a flash of onboarding at Eden', () => {
  assert.equal(shouldShowFirstRun({ ...SETTLED, planLoading: true }), false);
  assert.equal(shouldShowFirstRun({ ...SETTLED, plan: null }), false);
  // The dangerous case: a workshop account mid-read must not be shown the
  // docket for a moment and then have it taken away.
  assert.equal(shouldShowFirstRun({ ...SETTLED, plan: null, planLoading: true }), false);
});

test('nothing is shown while the serverspaces list is still loading', () => {
  assert.equal(shouldShowFirstRun({ ...SETTLED, serverspacesLoading: true }), false);
});

// ---------------------------------------------------------------------------
// 2. Remembering the dismissal, per user
// ---------------------------------------------------------------------------

function memoryStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    size: () => map.size,
  };
}

test('the key names the user, so one lawyer\'s dismissal is not the next one\'s', () => {
  const store = memoryStore();
  assert.equal(dismissKey('user-a'), `${FIRST_RUN_DISMISS_PREFIX}user-a`);
  writeDismissed(store, 'user-a');
  assert.equal(readDismissed(store, 'user-a'), true);
  assert.equal(readDismissed(store, 'user-b'), false);
});

test('a store that throws reads as NOT dismissed — the list is shown, never hidden by an error', () => {
  const angry = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.equal(readDismissed(angry, 'user-a'), false);
  assert.equal(writeDismissed(angry, 'user-a'), false);
  assert.equal(readDismissed(null, 'user-a'), false);
  assert.equal(readDismissed(memoryStore(), null), false);
});

test('no column is added: the dismissal is a browser key, not a profile field', () => {
  // Migration 062 revoked column-level UPDATE on profiles for everyone but the
  // service role, and there is no UI-preferences column there anyway. If this
  // ever moves to the database, this test is the place that says so.
  assert.ok(FIRST_RUN_DISMISS_PREFIX.startsWith('cs.'));
  assert.ok(!src('src/hooks/useFirstRun.ts').includes("from('profiles')"));
});

// ---------------------------------------------------------------------------
// 3. Ticks come from data, and an unreadable fact is never a tick
// ---------------------------------------------------------------------------

test('every step has copy, a tick rule and a ready rule', () => {
  assert.deepEqual([...STEP_IDS], ['workspace', 'matter', 'documents', 'ask', 'connect', 'record']);
  for (const id of STEP_IDS) {
    assert.ok(FIRST_RUN_COPY.steps[id], id);
    assert.ok(FIRST_RUN_COPY.steps[id].title, id);
    assert.ok(FIRST_RUN_COPY.steps[id].detail, id);
    assert.ok(FIRST_RUN_COPY.doneNote[id], id);
    assert.ok(FIRST_RUN_COPY.doneTitle[id], id);
  }
});

test('each tick mirrors exactly one fact', () => {
  const all = {
    hasServerspace: true,
    hasMatter: true,
    hasDocument: true,
    hasAssistantRun: true,
    hasAiConnection: true,
    hasRecordEntry: true,
  };
  for (const id of STEP_IDS) assert.equal(stepDone(id, all), true, id);

  const none = { ...all, hasServerspace: false, hasMatter: false, hasDocument: false, hasAssistantRun: false, hasAiConnection: false, hasRecordEntry: false };
  for (const id of STEP_IDS) assert.equal(stepDone(id, none), false, id);

  // One fact at a time: nothing bleeds between steps.
  const pairs = [
    ['documents', 'hasDocument'],
    ['ask', 'hasAssistantRun'],
    ['connect', 'hasAiConnection'],
    ['record', 'hasRecordEntry'],
  ];
  for (const [step, fact] of pairs) {
    const only = { ...none, [fact]: true };
    assert.equal(stepDone(step, only), true, step);
    for (const other of STEP_IDS) {
      if (other !== step) assert.equal(stepDone(other, only), false, `${step} bled into ${other}`);
    }
  }
});

test('a fact that could not be READ is null, and null is not a tick', () => {
  for (const id of STEP_IDS) {
    const done = stepDone(id, UNKNOWN_FACTS);
    // The two facts that come from the serverspaces query are known booleans;
    // the four that come from their own reads are unknown until they land.
    if (id === 'workspace' || id === 'matter') assert.equal(done, false, id);
    else assert.equal(done, null, id);
  }
  // Nothing anywhere may treat null as true.
  for (const id of STEP_IDS) assert.notEqual(stepDone(id, UNKNOWN_FACTS), true, id);
});

test('a step whose action has nowhere to go is inert, and step 1 retires once it is done', () => {
  const empty = { ...UNKNOWN_FACTS };
  assert.equal(stepReady('workspace', empty), true);
  assert.equal(stepReady('matter', empty), false);
  for (const id of ['documents', 'ask', 'record']) assert.equal(stepReady(id, empty), false, id);
  // Connections needs no matter and no serverspace: it is an account setting.
  assert.equal(stepReady('connect', empty), true);

  const withSpace = { ...empty, hasServerspace: true };
  assert.equal(stepReady('workspace', withSpace), false, 'create-the-first-one is finished for good');
  assert.equal(stepReady('matter', withSpace), true);

  const withMatter = { ...withSpace, hasMatter: true };
  for (const id of ['documents', 'ask', 'record']) assert.equal(stepReady(id, withMatter), true, id);
  // Opening the Vault or the Record a second time is an ordinary thing to want.
  assert.equal(stepReady('documents', { ...withMatter, hasDocument: true }), true);
});

// ---------------------------------------------------------------------------
// 4. The name the first workspace is given
// ---------------------------------------------------------------------------

const FALLBACK = FIRST_RUN_COPY.workspaceFallbackName;

test('the workspace name comes from the account, in a stated order', () => {
  assert.equal(
    defaultWorkspaceName({ display_name: 'Quainton Law', full_name: 'Eden Q' }, 'e@x.com', FALLBACK),
    'Quainton Law',
  );
  // handle_new_user writes display_name, but a Google or Apple sign-in puts
  // the name under full_name / name and leaves display_name absent.
  assert.equal(defaultWorkspaceName({ full_name: 'Eden Quainton' }, 'e@x.com', FALLBACK), 'Eden Quainton');
  assert.equal(defaultWorkspaceName({ name: 'Eden Quainton' }, 'e@x.com', FALLBACK), 'Eden Quainton');
  assert.equal(defaultWorkspaceName({}, 'equainton@gmail.com', FALLBACK), 'equainton');
  assert.equal(defaultWorkspaceName(null, null, FALLBACK), FALLBACK);
  assert.equal(defaultWorkspaceName(undefined, undefined, FALLBACK), FALLBACK);
});

test('an empty or whitespace name falls through rather than creating a blank workspace', () => {
  assert.equal(defaultWorkspaceName({ display_name: '   ' }, 'e@x.com', FALLBACK), 'e');
  assert.equal(defaultWorkspaceName({ display_name: '', full_name: '\n\t' }, null, FALLBACK), FALLBACK);
  assert.equal(defaultWorkspaceName({ display_name: 42 }, null, FALLBACK), FALLBACK);
});

test('a name is one line and fits the rail', () => {
  assert.equal(defaultWorkspaceName({ display_name: 'A\u0007B  C\nD' }, null, FALLBACK), 'A B C D');
  const long = 'x'.repeat(200);
  assert.equal(defaultWorkspaceName({ display_name: long }, null, FALLBACK).length, MAX_WORKSPACE_NAME);
});

test('the name is shown before the click, because a serverspace cannot be renamed', () => {
  assert.ok(FIRST_RUN_COPY.steps.workspace.detail.includes(NAME_TOKEN));
  assert.ok(FIRST_RUN_COPY.steps.workspace.alternate, 'there must be a way to name it yourself');
  // And the docket must actually substitute it.
  assert.match(src('src/components/firstrun/FirstRunDocket.tsx'), /replace\(NAME_TOKEN, state\.workspaceName\)/);
  // No sentence anywhere promises a rename the product does not have.
  assert.ok(!/rename/i.test(JSON.stringify(FIRST_RUN_COPY)));
});

// ---------------------------------------------------------------------------
// 5. Which matter steps 3, 4 and 6 point at
// ---------------------------------------------------------------------------

const matter = (id, name, extra = {}) => ({
  id, name, short_code: null, parent_matterspace_id: null, ai_tier: 'A', ...extra,
});

test('no serverspaces, no target', () => {
  assert.equal(pickFirstMatter([]), null);
  assert.equal(pickFirstServerspace([]), null);
  assert.equal(hasAnyMatter([]), false);
  assert.equal(hasAnyMatter([{ id: 's', name: 'S', matterspaces: [] }]), false);
});

test('the target is the first serverspace that HAS a root matter, not simply the first', () => {
  const spaces = [
    { id: 's1', name: 'Empty', matterspaces: [] },
    { id: 's2', name: 'Second', matterspaces: [matter('m1', 'Anlauf')] },
  ];
  // Step 2 still creates into the first serverspace...
  assert.deepEqual(pickFirstServerspace(spaces), { id: 's1', name: 'Empty' });
  // ...but steps 3/4/6 have to point at a matter that exists.
  assert.equal(pickFirstMatter(spaces).matterId, 'm1');
  assert.equal(pickFirstMatter(spaces).serverspaceId, 's2');
  assert.equal(hasAnyMatter(spaces), true);
});

test('the target is deterministic: name order, then id — never render order', () => {
  const spaces = [{
    id: 's1',
    name: 'S',
    matterspaces: [matter('m3', 'zeta'), matter('m1', 'Alpha'), matter('m2', 'alpha')],
  }];
  assert.equal(pickFirstMatter(spaces).matterId, 'm1', 'case-folded name first, id breaks the tie');
  // Reversing the input must not change the answer.
  const reversed = [{ ...spaces[0], matterspaces: [...spaces[0].matterspaces].reverse() }];
  assert.equal(pickFirstMatter(reversed).matterId, 'm1');
});

test('a sub-matter is never the target — a first matter is a root', () => {
  const spaces = [{
    id: 's1',
    name: 'S',
    matterspaces: [
      matter('child', 'Aaa', { parent_matterspace_id: 'root' }),
      matter('root', 'Zzz'),
    ],
  }];
  assert.equal(pickFirstMatter(spaces).matterId, 'root');
});

test('the vault link uses short_code when there is one, the uuid when there is not', () => {
  const withCode = [{ id: 's', name: 'S', matterspaces: [matter('m-uuid', 'M', { short_code: 'anlauf' })] }];
  assert.equal(vaultPathFor(pickFirstMatter(withCode)), '/app/vault?matter=anlauf');
  const without = [{ id: 's', name: 'S', matterspaces: [matter('m-uuid', 'M')] }];
  assert.equal(vaultPathFor(pickFirstMatter(without)), '/app/vault?matter=m-uuid');
  // A short code with a character that means something in a query string.
  const odd = [{ id: 's', name: 'S', matterspaces: [matter('m', 'M', { short_code: 'a&b' })] }];
  assert.equal(vaultPathFor(pickFirstMatter(odd)), '/app/vault?matter=a%26b');
});

test('a sealed target is reported sealed, for the Assistant strip', () => {
  const tier = (t) => pickFirstMatter([{ id: 's', name: 'S', matterspaces: [matter('m', 'M', { ai_tier: t })] }]).sealed;
  assert.equal(tier('A'), false);
  assert.equal(tier('B'), true);
  assert.equal(tier('C'), true);
});

// ---------------------------------------------------------------------------
// 6. The links, against the code that reads them
// ---------------------------------------------------------------------------

test('the Record link uses the capital-R tab name MatterspaceView actually matches', () => {
  const target = pickFirstMatter([{ id: 's', name: 'S', matterspaces: [matter('m-1', 'M')] }]);
  assert.equal(recordPathFor(target), '/app/matterspace/m-1?tab=Record');
  // MatterspaceView compares ?tab= against this list exactly — a lowercase
  // 'record' silently falls through to the default tab.
  const view = src('src/pages/MatterspaceView.tsx');
  assert.ok(view.includes(`'${RECORD_TAB}'`), 'Record is no longer a tab name');
  assert.match(view, /const tabs = \[[^\]]*'Record'/);
});

test('Connections is where the outside-AI page really is', () => {
  assert.equal(CONNECTIONS_PATH, '/app/connections');
  assert.match(src('src/App.tsx'), /path="connections" element=\{<Connections \/>\}/);
});

test('the ledger kinds a model call actually writes', () => {
  const describe = src('src/lib/matter-record/describe.ts');
  for (const kind of COMPLETION_KINDS) {
    assert.ok(describe.includes(`case '${kind}'`), `${kind} is no longer a ledger event kind`);
  }
});

// ---------------------------------------------------------------------------
// 7. Creating the first workspace — once, and only on a click
// ---------------------------------------------------------------------------

const seeded = () => fakeSupabase({ clientspaces: [{ id: 'cs-1', user_id: 'user-a' }], serverspaces: [] });

test('one click creates exactly one workspace, with the name and the cover it was given', async () => {
  const db = seeded();
  const out = await createFirstServerspace(db, { userId: 'user-a', name: 'Quainton', coverUrl: '/templates/core.webp' });
  assert.equal(out.ok, true);
  assert.equal(out.created, true);
  assert.equal(db.tables.serverspaces.length, 1);
  assert.equal(db.tables.serverspaces[0].name, 'Quainton');
  assert.equal(db.tables.serverspaces[0].clientspace_id, 'cs-1');
  assert.equal(db.tables.serverspaces[0].cover_url, '/templates/core.webp');
  assert.equal(out.serverspaceId, db.tables.serverspaces[0].id);
});

test('a second click writes nothing and hands back the one that exists', async () => {
  const db = seeded();
  const first = await createFirstServerspace(db, { userId: 'user-a', name: 'Quainton', coverUrl: null });
  const second = await createFirstServerspace(db, { userId: 'user-a', name: 'Quainton', coverUrl: null });
  assert.equal(db.tables.serverspaces.length, 1, 'a double-click must not make two workspaces');
  assert.equal(second.ok, true);
  assert.equal(second.created, false, 'the second call reports that it wrote nothing');
  assert.equal(second.serverspaceId, first.serverspaceId);
});

test('an account that already had a serverspace is never given another', async () => {
  const db = fakeSupabase({
    clientspaces: [{ id: 'cs-1', user_id: 'user-a' }],
    serverspaces: [{ id: 'ss-old', clientspace_id: 'cs-1', name: 'Already here' }],
  });
  const out = await createFirstServerspace(db, { userId: 'user-a', name: 'New', coverUrl: null });
  assert.equal(out.ok, true);
  assert.equal(out.created, false);
  assert.equal(out.serverspaceId, 'ss-old');
  assert.equal(db.tables.serverspaces.length, 1);
});

test('a missing clientspace fails with its own reason and writes nothing', async () => {
  const db = fakeSupabase({ clientspaces: [], serverspaces: [] });
  const out = await createFirstServerspace(db, { userId: 'user-a', name: 'X', coverUrl: null });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no_clientspace');
  assert.equal(db.tables.serverspaces.length, 0);
  // The component turns this reason into a sentence, because the server has none.
  assert.ok(FIRST_RUN_COPY.noClientspace.length > 20);
});

test('a failed read stops before the insert and carries the server\'s own words', async () => {
  const db = seeded();
  db.failNext('serverspaces.select', 'JWT expired');
  const out = await createFirstServerspace(db, { userId: 'user-a', name: 'X', coverUrl: null });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'read_failed');
  assert.equal(out.message, 'JWT expired');
  assert.equal(db.tables.serverspaces.length, 0, 'a failed read must never become a blind insert');
});

test('a failed insert says so, and says what the server said', async () => {
  const db = seeded();
  db.failNext('serverspaces.insert', 'new row violates row-level security policy');
  const out = await createFirstServerspace(db, { userId: 'user-a', name: 'X', coverUrl: null });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'insert_failed');
  assert.equal(out.message, 'new row violates row-level security policy');
});

test('the create path is the only thing in the docket that writes', () => {
  // Nothing is created without a click, and only step 1 creates at all
  // without a dialog: every other step navigates or opens the product's own
  // modal, which has its own submit button.
  const docket = src('src/components/firstrun/FirstRunDocket.tsx');
  assert.ok(!docket.includes('supabase'), 'the component must not talk to the database itself');
  assert.ok(!/\.insert\(/.test(docket));
  assert.ok(!/\.delete\(/.test(docket));
  assert.ok(!/\.update\(/.test(docket));
});

// ---------------------------------------------------------------------------
// 8. Sealed from the start — the tier that reaches the existing create path
// ---------------------------------------------------------------------------

test('the docket hands its seal choice to the product\'s own New Matter dialog', () => {
  const docket = src('src/components/firstrun/FirstRunDocket.tsx');
  assert.match(docket, /<NewMatterModal[\s\S]*?sealed=\{sealFirstMatter\}/);
  assert.match(docket, /setSealFirstMatter\(e\.target\.checked\)/);
});

test('that dialog writes tier B, and only when sealed', () => {
  // The seal is enforced server-side off this column; the dialog writes it at
  // insert so there is no unsealed instant. If this expression changes, the
  // docket's offer stops meaning what its sentence says.
  const modal = src('src/components/matter/NewMatterModal.tsx');
  assert.match(modal, /\.\.\.\(sealed \? \{ ai_tier: 'B' as const \} : \{\}\)/);
});

test('the seal sentence says only what the audit permits', () => {
  const { sentence, prospective } = FIRST_RUN_COPY.seal;
  const all = `${sentence} ${prospective}`;
  // The sealed pen is not Claude and has never been; naming a frontier model
  // inside the seal is the one claim the 2026-09-19 audit forbids outright.
  assert.ok(!/claude/i.test(all), 'the sealed model must not be named Claude');
  assert.ok(!/anthropic|openai|gpt|kimi|gemini/i.test(all));
  // The two limits a person is owed before they choose.
  assert.match(sentence, /never reach a general-purpose AI provider/);
  assert.match(sentence, /exact words and phrases/, 'word search, not semantic search');
  assert.match(prospective, /from the moment it is set/, 'the seal is prospective');
  // Nothing absolute about retention or recording, which the ledger cannot keep.
  assert.ok(!/\bevery exchange\b/i.test(JSON.stringify(FIRST_RUN_COPY)));
});

// ---------------------------------------------------------------------------
// 9. The words, and the things they claim
// ---------------------------------------------------------------------------

test('the accepted-types sentence matches what the Vault actually accepts', () => {
  const detail = FIRST_RUN_COPY.steps.documents.detail;
  // The cap is a number the pipeline enforces, not a round figure chosen here.
  assert.equal(formatBytes(VAULT_MAX_BYTES), '500 MB');
  assert.ok(detail.includes('500 MB'), 'the size cap has drifted from lib/ingest-formats.mjs');
  for (const kind of ['PDF', 'Word', 'text', 'spreadsheets', 'slides', 'email', '.zip']) {
    assert.ok(detail.includes(kind), `${kind} is missing from the accepted-types sentence`);
  }
  // And it names the click the Vault really needs — its home screen has no
  // drop zone, and there is no ?view= parameter to open one.
  assert.ok(detail.includes('Import/Display Documents'));
  assert.match(src('src/pages/Vault.tsx'), /Import\/Display Documents/);
});

test('the quote before a big upload is a thing that exists', () => {
  assert.ok(FIRST_RUN_COPY.steps.documents.detail.includes('quoted before it runs'));
  assert.match(src('src/pages/Vault.tsx'), /useUploadEstimateGate\(\)/);
});

test('no sentence claims anything about users, outcomes or how long it takes', () => {
  const words = JSON.stringify(FIRST_RUN_COPY).toLowerCase();
  for (const phantom of ['most users', 'most lawyers', 'typically', 'in practice', 'in minutes', 'in seconds', 'you\'ll find']) {
    assert.ok(!words.includes(phantom), `phantom expertise: "${phantom}"`);
  }
  // Eden's standing copy rule.
  assert.ok(!/\blives\b/.test(words), 'the word "lives" is never used in copy');
  // The Record's ledger is best-effort, so no sentence may say "every".
  assert.ok(!/every model call|all ai use|complete record/.test(words));
});

test('Bucketizer and Discovery are a closing line, not steps', () => {
  const ids = STEP_IDS.join(' ');
  assert.ok(!/bucketizer|discovery/i.test(ids));
  assert.match(FIRST_RUN_COPY.closing, /Bucketizer sorts a record into your case theory/);
  assert.match(FIRST_RUN_COPY.closing, /Discovery builds a production/);
  const titles = STEP_IDS.map((id) => FIRST_RUN_COPY.steps[id].title).join(' ');
  assert.ok(!/bucketizer|discovery/i.test(titles));
});

test('every string a person reads is in copy.ts and nowhere else', () => {
  // The rule Eden edits by: one file holds the words. The component may hold
  // class names and the odd punctuation, but no sentence.
  const docket = src('src/components/firstrun/FirstRunDocket.tsx');
  const code = docket.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  for (const id of STEP_IDS) {
    assert.ok(!code.includes(FIRST_RUN_COPY.steps[id].title), `${id}'s title is hard-coded in the component`);
  }
  assert.ok(!code.includes(FIRST_RUN_COPY.heading));
  assert.ok(!code.includes(FIRST_RUN_COPY.closing));
  assert.ok(!code.includes(FIRST_RUN_COPY.seal.sentence));
  assert.match(docket, /FIRST_RUN_COPY/);
});

// ---------------------------------------------------------------------------
// 10. The wiring a Node harness cannot mount
// ---------------------------------------------------------------------------

test('the docket renders nothing at all when it is not being shown', () => {
  assert.match(src('src/components/firstrun/FirstRunDocket.tsx'), /if \(!state\.show\) return null;/);
});

test('a hidden docket issues no queries — a workshop dashboard costs nothing extra', () => {
  const hook = src('src/hooks/useFirstRun.ts');
  assert.match(hook, /enabled: show && !!userId/);
});

test('a double-click cannot reach the database twice', () => {
  const hook = src('src/hooks/useFirstRun.ts');
  // Belt: an in-flight ref that survives re-renders.
  assert.match(hook, /const inFlight = useRef\(false\)/);
  assert.match(hook, /if \(!userId \|\| inFlight\.current\) return;/);
  // Braces: the fresh read inside createFirstServerspace, which survives a
  // remount and a stale React Query cache. Asserted for real above.
  assert.match(src('src/components/firstrun/first-run.ts'), /const existing = await client\n?\s*\.?from\('serverspaces'\)/);
});

test('the Dashboard shows the docket and defers its three empty places to it', () => {
  const dash = src('src/pages/Dashboard.tsx');
  assert.match(dash, /<FirstRunDocket state=\{firstRun\} \/>/);
  // The greeting drops "back" for someone who has never been here.
  assert.match(dash, /firstRun\.show && serverspaces\.length === 0\s*\n?\s*\? FIRST_RUN_COPY\.dashboard\.greetingNew/);
  // The serverspaces panel stops repeating the instruction the docket gives.
  assert.match(dash, /serverspaces\.length === 0 && firstRun\.show/);
  assert.match(dash, /serverspaces\.length === 0 && !firstRun\.show/);
  // The deadlines section is left out while there is no matter to have one.
  assert.match(dash, /!\(firstRun\.show && !firstRun\.facts\.hasMatter\)/);
  // The quick action is not the same button twice.
  assert.match(dash, /\.filter\(\(\) => !\(firstRun\.show && serverspaces\.length === 0\)\)/);
  // The original strings survive for an account that dismissed the docket.
  assert.ok(dash.includes('No serverspaces yet.'));
});

test('the docket opens the Assistant scoped to the matter, and spends nothing doing it', () => {
  const docket = src('src/components/firstrun/FirstRunDocket.tsx');
  assert.match(docket, /runInAssistant\(\{\s*matterId: target\.matterId/);
  // A command with no prompt opens the panel scoped to the matter without a
  // model call (lib/assistant-bus.ts). Sending one here would spend money on
  // a question nobody asked.
  assert.ok(!/prompt:/.test(docket), 'the docket must not send a prompt of its own');
});
