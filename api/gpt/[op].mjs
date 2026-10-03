// POST /api/gpt/<operationId> — Contextspaces for a Custom GPT (Actions).
// GET  /api/gpt/openapi.json  — the OpenAPI 3.1 document the GPT imports.
//
// A thin REST face on the same tool core the MCP endpoint uses. The
// operation table, argument shaping, response caps and error mapping all
// live in lib/gpt-ops.mjs; this file only supplies the real collaborators:
// the shared bearer check (lib/oauth-bearer.mjs — the very functions
// api/mcp.mjs runs), the tool core and the meter.
//
// Same env as api/mcp.mjs. See docs/specs/GPT-ACTIONS-2026-09-29.md.

import { createGptHandler } from '../../lib/gpt-ops.mjs';
import { callTool } from '../../lib/mcp-core.mjs';
import { runMeteredToolCall } from '../../lib/connector-meter.mjs';
import {
  AuthError, authenticate, callToolOptsFor, userScopedClient,
  SUPABASE_URL, SUPABASE_ANON_KEY, SERVICE_KEY,
} from '../../lib/oauth-bearer.mjs';
import { userJwtConfigured } from '../../lib/supabase-user-jwt.mjs';

function configMissing() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('VITE_SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('VITE_SUPABASE_ANON_KEY');
  if (!SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!userJwtConfigured()) missing.push('MCP_SIGNING_KEY_JWK_B64 + MCP_SIGNING_KEY_ID');
  return missing;
}

export default createGptHandler({
  authenticate, userScopedClient, callToolOptsFor, callTool, runMeteredToolCall, AuthError,
  env: process.env, configMissing,
});
