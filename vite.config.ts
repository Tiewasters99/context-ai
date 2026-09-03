import { defineConfig, loadEnv } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import llmProxy from './vite-claude-proxy'
import pdfjsAssets from './vite-pdfjs-assets'

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

export default defineConfig(({ mode }) => {
  // Load .env so ANTHROPIC_API_KEY is available to the proxy plugin
  const env = loadEnv(mode, process.cwd(), '');
  Object.assign(process.env, env);

  return {
    plugins: [react(), tailwindcss(), llmProxy(), pdfjsAssets(), readingRoomRoute()],
    build: {
      rolldownOptions: {
        // Two doors: the workspace, and the Reader standing on its own.
        input: { main: 'index.html', reader: 'reader.html' },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  };
})
