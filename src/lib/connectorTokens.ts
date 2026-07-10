// Client-side helpers for connector token management.
//
// Tokens are generated in the browser because hashing can only be verified
// server-side (token_hash is the only thing stored); we never need the
// server to "know" the plaintext. RLS on connector_tokens (migration 003)
// ensures a user can only insert rows with their own user_id.

export interface NewConnectorToken {
  token: string;       // opaque secret — shown to user once, never stored
  tokenHash: string;   // sha256 hex of token — stored in connector_tokens.token_hash
  tokenPrefix: string; // first 16 chars of token — stored for display
}

export async function generateConnectorToken(): Promise<NewConnectorToken> {
  // 32 bytes of CSPRNG entropy
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = base64url(bytes);
  const token = `csp_${secret}`;

  const hashBytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  const tokenHash = Array.from(new Uint8Array(hashBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const tokenPrefix = token.slice(0, 16);
  return { token, tokenHash, tokenPrefix };
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Canonical MCP endpoint URL — what users paste into their Claude client.
// Use www explicitly: Vercel's apex -> www 307 redirect is auth-safe in a
// browser but some MCP clients and curl -L variants drop the Authorization
// header on cross-host redirects. Canonical URL sidesteps the ambiguity.
export const MCP_ENDPOINT_URL = 'https://www.contextspaces.ai/api/mcp';

// A ready-to-paste Claude Desktop HTTP MCP config block.
export function claudeDesktopConfigSnippet(token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        contextspaces: {
          url: MCP_ENDPOINT_URL,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

// Legacy Gemini CLI: HTTP MCP shape with `url` (sunsets 2026-06-18 for
// Google One / unpaid tiers — Google is unifying CLI surfaces under
// Antigravity). Keep this snippet around for users who haven't migrated
// yet, but the page directs new users at antigravityConfigSnippet.
export function geminiConfigSnippet(token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        contextspaces: {
          url: MCP_ENDPOINT_URL,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

// Antigravity CLI (Google's replacement for Gemini CLI). Same protocol,
// two cosmetic differences from the Gemini CLI shape:
//   - file lives at ~/.gemini/config/mcp_config.json (not ~/.gemini/settings.json)
//   - the field is `serverUrl`, not `url`
// The Bearer-token + headers convention is unchanged.
export function antigravityConfigSnippet(token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        contextspaces: {
          serverUrl: MCP_ENDPOINT_URL,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

// ChatGPT itself cannot use the tokens above: OpenAI's connector flow
// speaks OAuth (PKCE, via CIMD or dynamic client registration) and will
// not present a static bearer token or API key. The ChatGPT page walks
// the user through that OAuth flow instead.
//
// The OpenAI *API* is the exception — the Responses API's `mcp` tool
// takes arbitrary headers, so a connector token works there. This is the
// block that page offers for scripted / SDK use.
export function openaiResponsesSnippet(token: string): string {
  return JSON.stringify(
    {
      model: 'gpt-5',
      tools: [
        {
          type: 'mcp',
          server_label: 'contextspaces',
          server_url: MCP_ENDPOINT_URL,
          headers: { Authorization: `Bearer ${token}` },
          require_approval: 'never',
        },
      ],
      input: 'List my matters, then search the Peloso deposition for causation.',
    },
    null,
    2,
  );
}

// Grok exposes MCP servers via its settings UI (URL + Bearer token).
// For users on a CLI / scripted setup, the same JSON shape works as a
// custom-config block — Grok's MCP handling is the same Streamable
// HTTP protocol Claude and Gemini speak.
export function grokConfigSnippet(token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        contextspaces: {
          url: MCP_ENDPOINT_URL,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}
