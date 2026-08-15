// Serve pdfjs's runtime asset directories at /pdfjs/*.
//
// pdfjs needs more than its worker script. Character maps (CJK encodings),
// the standard-14 font programs (Courier/Helvetica/Times — the fonts court
// transcripts are set in), WASM decoders for JPEG2000 and JBIG2 images (how
// scanned exhibits are compressed) and an ICC profile all live as loose
// files in the package and are fetched at runtime from URLs the embedding
// app must supply. They are not part of the JS bundle, so Vite never emits
// them, and without them pdfjs can stall mid-render with no error.
//
// Dev: a middleware streams the files straight out of node_modules.
// Build: the directories are copied into dist/pdfjs/ alongside the bundle.
// Both expose the same paths, so the URLs in src/lib/pdfjs.ts hold in
// either mode.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

const PDFJS_DIR = path.dirname(
  createRequire(import.meta.url).resolve('pdfjs-dist/package.json'),
);

const ASSET_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

const MIME: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.icc': 'application/vnd.iccprofile',
};

export default function pdfjsAssets(): Plugin {
  return {
    name: 'pdfjs-assets',

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0];
        if (!url?.startsWith('/pdfjs/')) return next();

        const rel = decodeURIComponent(url.slice('/pdfjs/'.length));
        if (!ASSET_DIRS.includes(rel.split('/')[0])) return next();

        const file = path.join(PDFJS_DIR, rel);
        // Keep the middleware from being a directory-traversal read primitive.
        if (!file.startsWith(PDFJS_DIR + path.sep)) return next();

        fs.readFile(file, (err, buf) => {
          if (err) return next();
          res.setHeader(
            'Content-Type',
            MIME[path.extname(file)] ?? 'application/octet-stream',
          );
          res.setHeader('Cache-Control', 'no-cache');
          res.end(buf);
        });
      });
    },

    writeBundle(options) {
      const outDir = options.dir ?? 'dist';
      for (const dir of ASSET_DIRS) {
        const from = path.join(PDFJS_DIR, dir);
        if (!fs.existsSync(from)) continue;
        fs.cpSync(from, path.join(outDir, 'pdfjs', dir), { recursive: true });
      }
    },
  };
}
