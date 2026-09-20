// A tab that has been open since this morning is running this morning's
// bundle. This is the harness for telling it so.
//
//   node --test scripts/_test-app-version.mjs
//
// Offline by construction: `fetch` is a local function that counts its own
// calls, `window` is a bare EventTarget and `document` is an object with a
// visibilityState. Nothing here opens a socket, and nothing renders — the
// store is where every decision is made, exactly as refusal-bus.ts is tested
// through src/lib/llm/refusals.ts rather than through a banner.
//
// What it holds to:
//   a differing build id shows the line, once
//   the same build id shows nothing
//   a dismissed build stays quiet — and a SECOND deploy is not muted by it
//   a dismissed build returns on a focus, but only after thirty minutes
//   a fetch that fails says nothing to anyone
//   a hidden tab is never asked at all
//   a stale chunk says "out of date" and outranks the quiet line
//   nothing in here ever reloads
//   and the id in /version.json is the id compiled into the bundle

import test from 'node:test';
import assert from 'node:assert/strict';

// Guards are read at call time, not import time, so these may be installed
// after the module is loaded — but installing them first keeps every test
// honest about which globals it depends on.
globalThis.window = new EventTarget();
globalThis.document = { visibilityState: 'visible' };

const {
  BUILD_ID,
  VERSION_URL,
  NEWER_BUILD_LINE,
  STALE_CHUNK_LINE,
  CHECK_THROTTLE_MS,
  POLL_INTERVAL_MS,
  DISMISS_QUIET_MS,
  announceStaleChunk,
  checkForNewerBuild,
  currentUpdateNotice,
  dismissUpdateNotice,
  fetchDeployedBuildId,
  installStaleChunkGuard,
  isStaleChunkFailure,
  isTabVisible,
  reportRemoteBuildId,
  resetAppVersionState,
  subscribeUpdateNotice,
} = await import('../src/lib/app-version.ts');

const { default: appVersion, resolveBuildId, VERSION_FILE } = await import(
  '../vite-app-version.ts'
);

const HERE = 'aaaaaaaaaaaa';
const THERE = 'bbbbbbbbbbbb';
const THIRD = 'cccccccccccc';

/** A fetch that answers with one build id and remembers being called. */
function serverSaying(buildId, { ok = true, body } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      json: async () => (body !== undefined ? body : { buildId }),
    };
  };
  impl.calls = calls;
  return impl;
}

/** A fetch that is offline. */
function serverDown() {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    throw new TypeError('Failed to fetch');
  };
  impl.calls = calls;
  return impl;
}

/** Count banner changes the way useSyncExternalStore would see them. */
function watchNotices() {
  const seen = [];
  const stop = subscribeUpdateNotice(() => seen.push(currentUpdateNotice()));
  return { seen, stop };
}

test.beforeEach(() => {
  globalThis.document.visibilityState = 'visible';
  resetAppVersionState();
});

// ---------------------------------------------------------------------------
test('the build id is one string in two places', async (t) => {
  await t.test('Vercel names the commit it is building', () => {
    assert.equal(
      resolveBuildId({ VERCEL_GIT_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567' }),
      '0123456789ab',
    );
  });

  await t.test('a CI build of this repo falls back to GITHUB_SHA', () => {
    assert.equal(resolveBuildId({ GITHUB_SHA: 'ABCDEF1234567890' }), 'abcdef123456');
  });

  await t.test('locally there is no commit, so the id is the moment of the build', () => {
    const id = resolveBuildId({}, Date.UTC(2026, 8, 20, 14, 5, 6, 789));
    assert.equal(id, 'local-20260920T140506Z');
    // Two builds a minute apart are two different ids — which is what makes
    // the banner testable on a laptop.
    assert.notEqual(id, resolveBuildId({}, Date.UTC(2026, 8, 20, 14, 6, 6, 0)));
  });

  await t.test('an empty or junk VERCEL_GIT_COMMIT_SHA is not trusted as an id', () => {
    assert.match(resolveBuildId({ VERCEL_GIT_COMMIT_SHA: '   ' }), /^local-/);
    assert.match(resolveBuildId({ VERCEL_GIT_COMMIT_SHA: 'not-a-sha' }), /^local-/);
  });

  await t.test('the compiled constant and /version.json carry the SAME id', () => {
    const plugin = appVersion(THERE);

    // 1. what gets compiled into the bundle
    const defined = plugin.config().define.__APP_BUILD_ID__;
    assert.equal(JSON.parse(defined), THERE);

    // 2. what gets written next to index.html
    const emitted = [];
    plugin.generateBundle.call({ emitFile: (f) => emitted.push(f) });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].fileName, VERSION_FILE);
    assert.equal(JSON.parse(emitted[0].source).buildId, THERE);

    // index.html and reader.html are two inputs of one build; a second call
    // must not try to emit the same file again.
    plugin.generateBundle.call({ emitFile: (f) => emitted.push(f) });
    assert.equal(emitted.length, 1);
  });

  await t.test('outside a vite build the constant degrades to dev, never to a crash', () => {
    assert.equal(BUILD_ID, 'dev');
  });
});

// ---------------------------------------------------------------------------
test('a newer build shows one quiet line', async (t) => {
  await t.test('different id → the banner, once', async () => {
    const server = serverSaying(THERE);
    const { seen, stop } = watchNotices();

    const outcome = await checkForNewerBuild('focus', { localId: HERE, fetchImpl: server });

    assert.equal(outcome, 'shown');
    assert.equal(server.calls.length, 1);
    assert.equal(server.calls[0].url, VERSION_URL);
    assert.equal(server.calls[0].init.cache, 'no-store');
    assert.equal(currentUpdateNotice().reason, 'newer-build');
    assert.equal(currentUpdateNotice().message, NEWER_BUILD_LINE);
    assert.equal(seen.length, 1, 'one announcement, not one per check');
    stop();
  });

  await t.test('checking again does not redraw it', () => {
    const { seen, stop } = watchNotices();
    reportRemoteBuildId(THERE, 'interval', HERE);
    reportRemoteBuildId(THERE, 'interval', HERE);
    reportRemoteBuildId(THERE, 'focus', HERE);
    assert.equal(seen.length, 1);
    stop();
  });

  await t.test('same id → nothing at all', async () => {
    const server = serverSaying(HERE);
    const { seen, stop } = watchNotices();

    const outcome = await checkForNewerBuild('focus', { localId: HERE, fetchImpl: server });

    assert.equal(outcome, 'same');
    assert.equal(currentUpdateNotice(), null);
    assert.equal(seen.length, 0);
    stop();
  });
});

// ---------------------------------------------------------------------------
test('dismissed means dismissed', async (t) => {
  await t.test('the same build does not come back', () => {
    reportRemoteBuildId(THERE, 'focus', HERE);
    dismissUpdateNotice();
    assert.equal(currentUpdateNotice(), null);

    assert.equal(reportRemoteBuildId(THERE, 'interval', HERE), 'quiet');
    assert.equal(reportRemoteBuildId(THERE, 'route', HERE), 'quiet');
    assert.equal(reportRemoteBuildId(THERE, 'focus', HERE), 'quiet');
    assert.equal(currentUpdateNotice(), null);
  });

  await t.test('nor on the five-minute timer once the half hour is up', () => {
    const t0 = Date.now();
    reportRemoteBuildId(THERE, 'focus', HERE, t0);
    dismissUpdateNotice();
    const later = t0 + DISMISS_QUIET_MS + 1;
    assert.equal(reportRemoteBuildId(THERE, 'interval', HERE, later), 'quiet');
    assert.equal(reportRemoteBuildId(THERE, 'route', HERE, later), 'quiet');
  });

  await t.test('it returns on the NEXT FOCUS after thirty minutes, and not before', () => {
    const t0 = Date.now();
    reportRemoteBuildId(THERE, 'focus', HERE, t0);
    dismissUpdateNotice();

    assert.equal(
      reportRemoteBuildId(THERE, 'focus', HERE, t0 + DISMISS_QUIET_MS - 1),
      'quiet',
      'twenty-nine minutes is still quiet',
    );
    assert.equal(reportRemoteBuildId(THERE, 'focus', HERE, t0 + DISMISS_QUIET_MS), 'shown');
    assert.equal(currentUpdateNotice().buildId, THERE);
  });

  await t.test('a SECOND deploy is not muted by the first dismissal', () => {
    reportRemoteBuildId(THERE, 'focus', HERE);
    dismissUpdateNotice();
    assert.equal(reportRemoteBuildId(THIRD, 'interval', HERE), 'shown');
    assert.equal(currentUpdateNotice().buildId, THIRD);
  });

  await t.test('a focus can bring it back without a request — the throttle must not swallow it', async () => {
    const t0 = Date.now();
    const server = serverSaying(THERE);

    await checkForNewerBuild('focus', { localId: HERE, fetchImpl: server, now: t0 });
    // Guard against a polluted store: this subtest only means something if
    // the line was genuinely up before it was dismissed.
    assert.equal(currentUpdateNotice()?.reason, 'newer-build');
    dismissUpdateNotice();
    assert.equal(server.calls.length, 1);

    // Back to the tab half an hour later, but inside the 60-second fetch
    // throttle (the interval ran a moment ago). The line still returns.
    const later = t0 + DISMISS_QUIET_MS;
    await checkForNewerBuild('interval', { localId: HERE, fetchImpl: server, now: later });
    const outcome = await checkForNewerBuild('focus', {
      localId: HERE,
      fetchImpl: server,
      now: later + 1,
    });

    assert.equal(outcome, 'shown');
    assert.equal(currentUpdateNotice().reason, 'newer-build');
  });
});

// ---------------------------------------------------------------------------
test('a check that cannot be made is silent', async (t) => {
  await t.test('a failed fetch says nothing', async () => {
    const server = serverDown();
    const { seen, stop } = watchNotices();

    const outcome = await checkForNewerBuild('focus', { localId: HERE, fetchImpl: server });

    assert.equal(outcome, 'unknown');
    assert.equal(currentUpdateNotice(), null);
    assert.equal(seen.length, 0);
    stop();
  });

  await t.test('a 404, an HTML error page and a JSON body with no buildId are all silent', async () => {
    assert.equal(await fetchDeployedBuildId(serverSaying(THERE, { ok: false })), null);
    assert.equal(
      await fetchDeployedBuildId(async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      })),
      null,
    );
    assert.equal(await fetchDeployedBuildId(serverSaying(null, { body: {} })), null);
    assert.equal(await fetchDeployedBuildId(serverSaying(null, { body: { buildId: 7 } })), null);
    assert.equal(currentUpdateNotice(), null);
  });
});

// ---------------------------------------------------------------------------
test('a hidden tab is never asked', async (t) => {
  await t.test('no fetch, no banner', async () => {
    globalThis.document.visibilityState = 'hidden';
    const server = serverSaying(THERE);

    assert.equal(isTabVisible(), false);
    for (const trigger of ['focus', 'route', 'interval']) {
      assert.equal(
        await checkForNewerBuild(trigger, { localId: HERE, fetchImpl: server }),
        'hidden',
      );
    }

    assert.equal(server.calls.length, 0, 'a hidden tab must cost nothing');
    assert.equal(currentUpdateNotice(), null);
  });

  await t.test('and it resumes the moment the tab comes back', async () => {
    globalThis.document.visibilityState = 'hidden';
    const server = serverSaying(THERE);
    await checkForNewerBuild('focus', { localId: HERE, fetchImpl: server });
    assert.equal(server.calls.length, 0);

    globalThis.document.visibilityState = 'visible';
    assert.equal(
      await checkForNewerBuild('focus', { localId: HERE, fetchImpl: server }),
      'shown',
    );
    assert.equal(server.calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
test('clicking through the app costs one request a minute', async () => {
  const t0 = Date.now();
  const server = serverSaying(HERE);

  for (let i = 0; i < 6; i += 1) {
    await checkForNewerBuild('route', { localId: HERE, fetchImpl: server, now: t0 + i * 1_000 });
  }
  assert.equal(server.calls.length, 1, 'six matters opened in six seconds, one check');

  await checkForNewerBuild('route', {
    localId: HERE,
    fetchImpl: server,
    now: t0 + CHECK_THROTTLE_MS,
  });
  assert.equal(server.calls.length, 2);

  assert.equal(POLL_INTERVAL_MS, 5 * 60_000, 'the idle poll is five minutes');
  assert.ok(POLL_INTERVAL_MS > CHECK_THROTTLE_MS, 'the timer can never be throttled away');
});

// ---------------------------------------------------------------------------
test('a stale chunk says so, and outranks the quiet line', async (t) => {
  await t.test('vite:preloadError puts the out-of-date line up', () => {
    const target = new EventTarget();
    const uninstall = installStaleChunkGuard(target);

    assert.equal(currentUpdateNotice(), null);
    target.dispatchEvent(new Event('vite:preloadError'));

    assert.equal(currentUpdateNotice().reason, 'stale-chunk');
    assert.equal(currentUpdateNotice().message, STALE_CHUNK_LINE);
    uninstall();
  });

  await t.test('a rejected dynamic import does too', () => {
    const target = new EventTarget();
    const uninstall = installStaleChunkGuard(target);

    const rejection = new Event('unhandledrejection');
    rejection.reason = new TypeError(
      'Failed to fetch dynamically imported module: https://www.contextspaces.ai/assets/pdf-Ck1s2A.js',
    );
    target.dispatchEvent(rejection);

    assert.equal(currentUpdateNotice().reason, 'stale-chunk');
    uninstall();
  });

  await t.test('an unrelated rejection is left alone', () => {
    const target = new EventTarget();
    const uninstall = installStaleChunkGuard(target);

    const rejection = new Event('unhandledrejection');
    rejection.reason = new Error('over_monthly_budget');
    target.dispatchEvent(rejection);

    assert.equal(currentUpdateNotice(), null);
    uninstall();
  });

  await t.test('the shapes a browser actually uses', () => {
    for (const msg of [
      'Failed to fetch dynamically imported module: /assets/x.js',
      'error loading dynamically imported module',
      'Importing a module script failed.',
      'Setting up fake worker failed',
    ]) {
      assert.ok(isStaleChunkFailure(new Error(msg)), msg);
    }
    assert.equal(isStaleChunkFailure(null), false);
    assert.equal(isStaleChunkFailure(new Error('NetworkError')), false);
  });

  await t.test('the urgent line is not replaced by the quiet one', () => {
    announceStaleChunk();
    assert.equal(reportRemoteBuildId(THERE, 'focus', HERE), 'quiet');
    assert.equal(currentUpdateNotice().reason, 'stale-chunk');
  });

  await t.test('but the quiet line yields to it', () => {
    reportRemoteBuildId(THERE, 'focus', HERE);
    assert.equal(currentUpdateNotice().reason, 'newer-build');
    announceStaleChunk();
    assert.equal(currentUpdateNotice().reason, 'stale-chunk');
  });

  await t.test('dismissing it buys no quiet — the next failure says so again', () => {
    announceStaleChunk();
    dismissUpdateNotice();
    assert.equal(currentUpdateNotice(), null);
    announceStaleChunk();
    assert.equal(currentUpdateNotice().reason, 'stale-chunk');
  });

  await t.test('but waving it away does mute the quiet version of the same news', () => {
    reportRemoteBuildId(THERE, 'interval', HERE);
    announceStaleChunk();
    assert.equal(currentUpdateNotice().buildId, THERE);
    dismissUpdateNotice();
    assert.equal(reportRemoteBuildId(THERE, 'interval', HERE), 'quiet');
    assert.equal(currentUpdateNotice(), null);
  });

  await t.test('an import that failed because the wifi is off says nothing', () => {
    // node's own `navigator` is a getter, so it is shadowed rather than set.
    const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const pretend = (onLine) =>
      Object.defineProperty(globalThis, 'navigator', { value: { onLine }, configurable: true });

    pretend(false);
    const target = new EventTarget();
    const uninstall = installStaleChunkGuard(target);

    target.dispatchEvent(new Event('vite:preloadError'));
    const rejection = new Event('unhandledrejection');
    rejection.reason = new TypeError('Failed to fetch dynamically imported module: /assets/x.js');
    target.dispatchEvent(rejection);
    assert.equal(currentUpdateNotice(), null, 'refreshing while offline lands on a blank page');

    // Back online, the same failure is news again.
    pretend(true);
    target.dispatchEvent(new Event('vite:preloadError'));
    assert.equal(currentUpdateNotice().reason, 'stale-chunk');

    uninstall();
    if (real) Object.defineProperty(globalThis, 'navigator', real);
  });

  await t.test('it announces once per failure, not once per listener call', () => {
    const { seen, stop } = watchNotices();
    announceStaleChunk();
    announceStaleChunk();
    announceStaleChunk();
    assert.equal(seen.length, 1);
    stop();
  });
});

// ---------------------------------------------------------------------------
test('what the two lines say', async (t) => {
  await t.test('neither promises that the work is saved', () => {
    // It is not. The Editor Room holds the manuscript, the editorial pass
    // already paid for and every accept/decline ruling in React state and
    // writes none of it anywhere; the Assistant's conversation and unsent
    // question are unpersisted; a Page saves on blur alone; an in-flight
    // Vault upload leaves an orphan row. So the reassurance is the true one.
    for (const line of [NEWER_BUILD_LINE, STALE_CHUNK_LINE]) {
      assert.doesNotMatch(line, /your work is saved/i);
      assert.doesNotMatch(line, /saved/i);
    }
    assert.match(NEWER_BUILD_LINE, /stopping point/i);
  });

  await t.test('they are sentences, not machine codes', () => {
    for (const line of [NEWER_BUILD_LINE, STALE_CHUNK_LINE]) {
      assert.doesNotMatch(line, /[_{}]|[A-Z]{4,}/);
      assert.ok(line.length < 120, 'one line, not a paragraph');
      assert.match(line, /[.!]$/);
    }
    assert.match(NEWER_BUILD_LINE, /Contextspaces/);
    assert.match(STALE_CHUNK_LINE, /out of date/i);
  });

  await t.test('nothing in this module reloads anything', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../src/lib/app-version.ts', import.meta.url), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    assert.doesNotMatch(code, /location\.reload/);

    // And the two places that used to reload on their own no longer do.
    for (const file of ['../src/main.tsx', '../src/pages/editor/EditorRoom.tsx']) {
      const body = await readFile(new URL(file, import.meta.url), 'utf8');
      const live = body
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      assert.doesNotMatch(live, /location\.reload/, `${file} still reloads by itself`);
      assert.doesNotMatch(live, /chunk-reload-at/, `${file} still carries the old loop guard`);
    }
  });
});
