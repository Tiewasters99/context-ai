// Telling a person with an open tab that the app has moved on.
//
// Every merge to main deploys a new bundle. A tab that was already open keeps
// running the old one for as long as it stays open — which, for a lawyer with
// a matter up all afternoon, is hours. On 2026-09-20 that cost three separate
// rounds of "the pin still doesn't work" → "sorry, pin works, I forgot to
// refresh". A paying user has no such second guess: to them the feature was
// announced and is not there.
//
// It gets worse than absence. `/assets/*` is served `max-age=0,
// must-revalidate` (checked against production on 2026-09-20), so a stale
// tab's dynamic import goes to the network and 404s — the old hashed chunk was
// deleted by the deploy. Opening a PDF in the Editor, or a .pptx in the
// Reader, simply fails.
//
// Two facts, therefore, and one line for each:
//
//   newer-build   /version.json names a build this bundle is not. Quiet,
//                 dismissible, no urgency.
//   stale-chunk   an import just failed in the way a deleted chunk fails.
//                 Something the person asked for did not happen, so this
//                 outranks the quiet line.
//
// WHAT THIS NEVER DOES IS RELOAD BY ITSELF. Before today two places did
// (main.tsx and EditorRoom.tsx), and both were wrong for the same reason: a
// reload throws away the manuscript in the Editor desk and the half-typed
// question in the Assistant composer, neither of which is persisted anywhere.
// A reload is the person's decision, taken at a stopping point of their
// choosing. See the PR for the full inventory of what a refresh costs.
//
// The store is the shape refusal-bus.ts uses — a DOM CustomEvent read through
// useSyncExternalStore — for the same reason: half the callers (main.tsx's
// window listener, the Editor's catch) are not components.

declare const __APP_BUILD_ID__: string | undefined

/**
 * The build this bundle IS. Replaced at build time by vite-app-version.ts;
 * 'dev' anywhere the define never ran (a node harness, an editor's language
 * server), where a version check is meaningless anyway.
 */
export const BUILD_ID: string =
  typeof __APP_BUILD_ID__ === 'string' && __APP_BUILD_ID__ ? __APP_BUILD_ID__ : 'dev'

/** The build the server is serving, published by the same plugin. */
export const VERSION_URL = '/version.json'

export const UPDATE_NOTICE_EVENT = 'cs:app-update'

/**
 * At most one check a minute, whatever asks for it. Route changes are the
 * reason: clicking through six matters must cost one request, not six.
 */
export const CHECK_THROTTLE_MS = 60_000

/** And a check every five minutes while the tab is actually being looked at. */
export const POLL_INTERVAL_MS = 5 * 60_000

/**
 * Dismissed means dismissed. The same build does not come back for half an
 * hour, and then only when the person returns to the tab — never while they
 * are working in it.
 */
export const DISMISS_QUIET_MS = 30 * 60_000

// ---------------------------------------------------------------------------
// The two sentences.
//
// "your work is saved" is NOT said, and that is a finding rather than
// caution: the Editor's manuscript, the Assistant's unsent text, a Vault
// upload in flight and a Bucketizer run's in-memory progress are all lost by a
// reload. "At a stopping point" is the true version of the same reassurance,
// and it is the sentence a colleague would use.
// ---------------------------------------------------------------------------

export const NEWER_BUILD_LINE =
  'A newer version of Contextspaces is available. Refresh when you are at a stopping point.'

export const STALE_CHUNK_LINE = 'This tab is out of date — refresh to continue.'

export type UpdateReason = 'newer-build' | 'stale-chunk'

export type UpdateNotice = {
  reason: UpdateReason
  /** The build waiting on the server, where we know it. */
  buildId: string | null
  message: string
}

export type CheckTrigger = 'focus' | 'route' | 'interval'

export type CheckOutcome = 'hidden' | 'throttled' | 'unknown' | 'same' | 'shown' | 'quiet'

let current: UpdateNotice | null = null
let lastCheckedAt = 0
let lastRemoteId: string | null = null
/** buildId → when it was dismissed. Per id, so a SECOND deploy is not muted. */
const dismissedAt = new Map<string, number>()

function announce(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(UPDATE_NOTICE_EVENT))
}

/** For useSyncExternalStore — a stable reference between changes. */
export function currentUpdateNotice(): UpdateNotice | null {
  return current
}

export function subscribeUpdateNotice(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(UPDATE_NOTICE_EVENT, onChange)
  return () => window.removeEventListener(UPDATE_NOTICE_EVENT, onChange)
}

export function dismissUpdateNotice(): void {
  if (!current) return
  // Dismissal is recorded against the build, not against the reason: waving
  // away "this tab is out of date" and then being told the quiet version of
  // the same news five minutes later is the nagging this is meant to avoid.
  // It does not mute the urgent line — announceStaleChunk never consults this
  // record, so the next failed import says so immediately.
  if (current.buildId) dismissedAt.set(current.buildId, Date.now())
  current = null
  announce()
}

/** Forget everything. Nothing in the app calls this; the harness does. */
export function resetAppVersionState(): void {
  current = null
  lastCheckedAt = 0
  lastRemoteId = null
  dismissedAt.clear()
  announce()
}

/**
 * Decide what a freshly-read remote id means, and show the line if it means
 * anything. Separate from the fetch so that a focus can re-evaluate what we
 * already know without going to the network — the 60-second throttle would
 * otherwise be able to swallow the end of a dismissal window.
 */
export function reportRemoteBuildId(
  remoteId: string | null,
  trigger: CheckTrigger,
  localId: string = BUILD_ID,
  now: number = Date.now(),
): CheckOutcome {
  if (!remoteId) return 'unknown'
  lastRemoteId = remoteId
  if (remoteId === localId) return 'same'

  // The louder line is already up and says the same thing more urgently.
  if (current?.reason === 'stale-chunk') return 'quiet'
  if (current?.reason === 'newer-build' && current.buildId === remoteId) return 'shown'

  const dismissed = dismissedAt.get(remoteId)
  if (dismissed !== undefined) {
    const windowPassed = now - dismissed >= DISMISS_QUIET_MS
    if (!(trigger === 'focus' && windowPassed)) return 'quiet'
  }

  current = { reason: 'newer-build', buildId: remoteId, message: NEWER_BUILD_LINE }
  announce()
  return 'shown'
}

/**
 * An import failed in the way a deleted chunk fails. Outranks the quiet line:
 * this one is about something that just did not happen.
 */
export function announceStaleChunk(): void {
  if (current?.reason === 'stale-chunk') return
  current = { reason: 'stale-chunk', buildId: lastRemoteId, message: STALE_CHUNK_LINE }
  announce()
}

/** A hidden tab is never checked — no fetch, no timer work, no banner. */
export function isTabVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/**
 * Read the deployed build id. Every failure — offline, a 404, an HTML error
 * page where JSON was expected — answers null and says nothing to anyone. A
 * version check that complained about the network would be noise about noise.
 */
export async function fetchDeployedBuildId(fetchImpl?: typeof fetch): Promise<string | null> {
  const doFetch =
    fetchImpl ??
    (typeof fetch === 'function'
      ? (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)
      : null)
  if (!doFetch) return null
  try {
    const res = await doFetch(VERSION_URL, { cache: 'no-store', credentials: 'omit' })
    if (!res.ok) return null
    const body: unknown = await res.json()
    const id = (body as { buildId?: unknown } | null)?.buildId
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

/**
 * One check. Called on focus, on a visibility change back to visible, on a
 * route change, and on the five-minute timer.
 */
export async function checkForNewerBuild(
  trigger: CheckTrigger,
  opts: {
    localId?: string
    fetchImpl?: typeof fetch
    now?: number
    visible?: boolean
  } = {},
): Promise<CheckOutcome> {
  const now = opts.now ?? Date.now()
  const localId = opts.localId ?? BUILD_ID
  const visible = opts.visible ?? isTabVisible()
  if (!visible) return 'hidden'

  // Coming back to the tab is the moment a dismissed notice may return, and
  // that must not depend on a request the throttle might skip.
  const reshown =
    trigger === 'focus' && lastRemoteId
      ? reportRemoteBuildId(lastRemoteId, 'focus', localId, now) === 'shown'
      : false

  if (now - lastCheckedAt < CHECK_THROTTLE_MS) return reshown ? 'shown' : 'throttled'
  lastCheckedAt = now

  const remote = await fetchDeployedBuildId(opts.fetchImpl)
  const outcome = reportRemoteBuildId(remote, trigger, localId, now)
  return reshown && outcome !== 'shown' ? 'shown' : outcome
}

// ---------------------------------------------------------------------------
// The stale-chunk safety net.
// ---------------------------------------------------------------------------

/**
 * How a browser says "that module is gone". Transcribed from
 * isStaleChunkFailure in src/lib/editor/extract-manuscript.ts rather than
 * imported from it: that function guards pdfjs, this one guards the whole
 * shell, and neither should be able to break the other by editing a regex.
 */
const STALE_CHUNK_MESSAGE =
  /fake worker|dynamically imported module|module script failed|importing a module|failed to fetch dynamically imported/i

export function isStaleChunkFailure(err: unknown): boolean {
  if (!err) return false
  const msg = err instanceof Error ? err.message : String(err)
  return STALE_CHUNK_MESSAGE.test(msg)
}

/**
 * Listen for the two ways a deleted chunk reaches the page.
 *
 * `vite:preloadError` is Vite's own signal for a preloaded chunk that 404'd.
 * We deliberately do NOT call preventDefault() on it: a prevented
 * vite:preloadError makes the failing import() resolve `undefined`, so the
 * caller dies on a destructure with a message that names nothing. Letting it
 * reject means the caller's own error slot still fires, next to the button
 * that was pressed — and this banner explains why.
 *
 * `unhandledrejection` is the rest: there are no React.lazy routes in this
 * app, but `await import('pdfjs-dist')`, mammoth, jszip and the Editor's own
 * modules are all split chunks, and a rejected one that nobody catches would
 * otherwise be a dead button and a console line.
 */
export function installStaleChunkGuard(
  target: EventTarget | undefined = typeof window === 'undefined' ? undefined : window,
): () => void {
  if (!target) return () => {}

  // A dropped connection fails an import with the same words a deleted chunk
  // does, and "refresh to continue" while the wifi is off refreshes into a
  // blank page. When the browser is sure it is offline, say nothing: the
  // import will be retried, and if the chunk really is gone it will fail
  // again with the network back.
  const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false

  const onPreloadError = () => {
    if (!offline()) announceStaleChunk()
  }
  const onRejection = (event: Event) => {
    const reason = (event as { reason?: unknown }).reason
    if (isStaleChunkFailure(reason) && !offline()) announceStaleChunk()
  }

  target.addEventListener('vite:preloadError', onPreloadError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('vite:preloadError', onPreloadError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
