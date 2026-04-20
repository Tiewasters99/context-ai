// Local development harness for api/mcp.mjs.
//
// Spins up a plain Node HTTP server on PORT (default 3001), loads .env, and
// delegates every request to the Vercel-style default handler exported by
// api/mcp.mjs. Used to test the HTTP MCP endpoint end-to-end against a real
// Supabase project + OpenAI key before deploying to Vercel.
//
// Usage:
//   node scripts/mcp-http-local.mjs
//   curl -i -X POST http://localhost:3001/mcp \
//     -H 'authorization: Bearer csp_your_token' \
//     -H 'content-type: application/json' \
//     -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'

import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

// Import AFTER env is loaded — the handler reads env vars at import time.
const { default: mcpHandler } = await import('../api/mcp.mjs');

const PORT = Number(process.env.PORT || 3001);

const server = createServer(async (req, res) => {
  // Mimic Vercel's automatic JSON body parsing.
  if (req.method !== 'GET' && req.method !== 'OPTIONS' && req.method !== 'DELETE') {
    try {
      req.body = await parseJsonBody(req);
    } catch (err) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ error: 'invalid_json', detail: err.message }));
    }
  }

  // Log each request for dev visibility.
  const auth = req.headers.authorization || '';
  const tokenPrefix = auth.startsWith('Bearer ') ? auth.slice(7, 19) + '…' : '(none)';
  process.stderr.write(
    `${req.method} ${req.url}  auth=${tokenPrefix}\n`
  );

  try {
    await mcpHandler(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'handler_crash', message: String(err) }));
    }
  }
});

server.listen(PORT, () => {
  process.stderr.write(`contextspaces HTTP MCP listening on http://localhost:${PORT}\n`);
});


// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function loadEnv(envPath) {
  try {
    const text = await fs.readFile(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      let val = m[2];
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = val;
    }
  } catch {}
}
