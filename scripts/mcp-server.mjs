// Contextspaces MCP server — local stdio variant.
//
// Exposes five retrieval tools to MCP-compatible clients running on the same
// machine (Claude Desktop, Claude Code, etc.). The hosted HTTP variant for
// external customers lives at api/mcp.mjs and shares the retrieval logic
// in lib/mcp-core.mjs.
//
// This stdio variant authenticates via service_role (full DB bypass), which
// is appropriate for a single-user local machine. The HTTP variant uses
// per-user bearer tokens and user-scoped Supabase clients so Postgres RLS
// can enforce matter isolation across customers.
//
// Env: loads ~/context-ai/.env on startup. Requires VITE_SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, and OPENAI_API_KEY (the last only when search
// is called).
//
// Stdout is reserved for JSON-RPC per the MCP spec. Diagnostic output goes
// to stderr so the client's parser is never poisoned.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOLS, callTool } from '../lib/mcp-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const server = new Server(
  { name: 'contextspaces-retrieval', version: '0.2.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    const result = await callTool(supabase, name, args, {
      openaiApiKey: process.env.OPENAI_API_KEY,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `ERROR: ${err.message || String(err)}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('contextspaces MCP server (stdio) listening\n');


// -----------------------------------------------------------------------------
// Env loader (mirrors the helper in scripts/ingest.mjs)
// -----------------------------------------------------------------------------
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

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
