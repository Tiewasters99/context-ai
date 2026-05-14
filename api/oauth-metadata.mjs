// OAuth metadata documents — served at the well-known URLs that MCP clients
// (claude.ai, Claude Desktop's connector UI) probe to discover our flow.
//
// Routing (vercel.json):
//   /.well-known/oauth-authorization-server  → /api/oauth-metadata?wk=as
//   /.well-known/oauth-protected-resource    → /api/oauth-metadata?wk=pr
//
// Both responses are static-ish JSON. The issuer / endpoint URLs are
// derived from the request host so this works in preview deploys too.

export default async function handler(req, res) {
  // CORS — these metadata docs are public reads.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  res.setHeader('cache-control', 'public, max-age=300');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }

  // Derive the canonical https origin for this deployment.
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString();
  const origin = `${proto}://${host}`;

  // Identify which metadata doc was requested. The vercel.json rewrite
  // adds ?wk=as|pr; for direct hits we fall back to inspecting the URL.
  const wk = (
    req.query?.wk
    || ((req.url || '').includes('oauth-protected-resource') ? 'pr' : 'as')
  ).toString();

  res.setHeader('content-type', 'application/json');

  if (wk === 'pr') {
    // OAuth 2.0 Protected Resource Metadata (RFC 9728).
    return res.end(JSON.stringify({
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
    }, null, 2));
  }

  // OAuth 2.0 Authorization Server Metadata (RFC 8414).
  return res.end(JSON.stringify({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth-token`,
    registration_endpoint: `${origin}/api/oauth-register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp'],
    // We don't issue ID tokens / userinfo — just OAuth for resource access.
  }, null, 2));
}
