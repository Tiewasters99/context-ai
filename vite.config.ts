import { defineConfig, loadEnv } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import llmProxy from './vite-claude-proxy'
import pdfjsAssets from './vite-pdfjs-assets'
import appVersion, { resolveBuildId } from './vite-app-version'

// Computed once, here, so the id compiled into the bundle and the id written
// to /version.json cannot drift apart.
const BUILD_ID = resolveBuildId()

// The Reading Room answers at /read/<book>. In production vercel.json
// rewrites that to reader.html; this does the same under vite dev, so the
// office can be pointed at a local reader with ?reader=http://localhost:5199.
function readingRoomRoute(): Plugin {
  return {
    name: 'reading-room-route',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const m = req.url?.match(/^\/read\/([^/?#]+)(\?.*)?$/)
        if (m) req.url = `/reader.html?book=${m[1]}${m[2] ? `&${m[2].slice(1)}` : ''}`
        next()
      })
    },
  }
}

// The Grapheon Reader answers under /reader (and at read.grapheon.ai in
// production, a host rewrite in vercel.json). Under vite dev the same
// prefix serves edition.html, so /reader, /reader/new and /reader/read/<id>
// all open the app and it reads the route from the address.
function editionRoute(): Plugin {
  return {
    name: 'edition-route',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/reader(\/|\?|$)/.test(req.url)) req.url = '/edition.html'
        next()
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Load .env so ANTHROPIC_API_KEY is available to the proxy plugin
  const env = loadEnv(mode, process.cwd(), '');
  Object.assign(process.env, env);

  return {
    plugins: [react(), tailwindcss(), llmProxy(), pdfjsAssets(), readingRoomRoute(), editionRoute(), appVersion(BUILD_ID)],
    build: {
      rolldownOptions: {
        // Three doors: the workspace, the Reading Room standing on its own,
        // and the Grapheon Reader (editions).
        input: { main: 'index.html', reader: 'reader.html', edition: 'edition.html' },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  };
})
