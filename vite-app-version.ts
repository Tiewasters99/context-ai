import type { Plugin } from 'vite'

// Which build this is, written down in two places that must agree.
//
// Every merge to main deploys a new bundle, and a tab that was already open
// keeps running the old one. The person sees a feature that shipped hours ago
// as simply missing — and, because the old hashed chunks are deleted, a lazy
// import from that tab can 404 outright. Neither is visible from inside the
// old bundle unless the build is named somewhere the browser can re-read.
//
// So: one id, two places.
//   1. compiled into the bundle as __APP_BUILD_ID__ (src/lib/app-version.ts)
//   2. written to /version.json at the site root, which a tab re-fetches
//
// They are the same string because the id is computed once, in vite.config.ts,
// and handed to this plugin. If the two ever disagree the banner would fire on
// every load; scripts/_test-app-version.mjs and the build check in the PR both
// compare them.

/** Where the deployed id is published. Same constant on both sides. */
export const VERSION_FILE = 'version.json'

/**
 * The build id.
 *
 * On Vercel this is the commit being built — `VERCEL_GIT_COMMIT_SHA`, which
 * Vercel sets for every deployment, system environment variables enabled or
 * not. `GITHUB_SHA` is the same idea for a CI build of this repo. Locally
 * there is no commit to name (the working tree is usually dirty anyway), so
 * the fallback is the moment of the build: two `npm run build` runs a minute
 * apart produce different ids, which is exactly the behaviour a local test of
 * the banner needs.
 *
 * Trimmed to 12 hex characters: long enough to be unique across this repo's
 * history, short enough to read in a console.
 */
export function resolveBuildId(
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
): string {
  const sha = (env.VERCEL_GIT_COMMIT_SHA ?? env.GITHUB_SHA ?? '').trim()
  if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha.slice(0, 12).toLowerCase()
  return `local-${new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`
}

/**
 * Emits /version.json next to index.html and defines __APP_BUILD_ID__.
 *
 * Under `vite dev` the same JSON is served from memory, so a dev tab reads the
 * id it was built with and the banner stays quiet — a dev server that
 * announced a new version on every hot reload would be worse than no banner.
 */
export default function appVersion(buildId: string): Plugin {
  const body = `${JSON.stringify({ buildId, builtAt: new Date().toISOString() }, null, 2)}\n`
  let emitted = false

  return {
    name: 'app-version',

    config() {
      return { define: { __APP_BUILD_ID__: JSON.stringify(buildId) } }
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== `/${VERSION_FILE}`) return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(body)
      })
    },

    generateBundle() {
      // index.html and reader.html are two inputs of ONE build, so this fires
      // once; the flag is insurance, because emitting the same fileName twice
      // is a hard error and would break the build rather than the banner.
      if (emitted) return
      emitted = true
      this.emitFile({ type: 'asset', fileName: VERSION_FILE, source: body })
    },
  }
}
