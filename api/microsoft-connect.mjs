// /api/microsoft-connect — start, probe or end the OneDrive connection.
//
//   GET     → { configured, missing_env }   (no session; a fact about this
//             deployment, so the Connections card can say "Not available yet")
//   POST    → { url }                       the Microsoft authorization URL
//   DELETE  → disconnect
//
// The flow itself lives in lib/cloud-drives/routes.mjs, and the Microsoft
// specifics (least-privilege scopes, PKCE, rotating refresh tokens) in
// lib/cloud-drives/onedrive.mjs.
//
// Env required on Vercel: MS_OAUTH_CLIENT_ID, MS_OAUTH_CLIENT_SECRET,
// MS_OAUTH_TENANT (optional; defaults to `common`), MCP_OAUTH_SECRET,
// CONNECTIONS_ENC_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY. Without the first two every call answers
// 503 not_configured.

import { onedrive } from '../lib/cloud-drives/onedrive.mjs';
import { makeConnectHandler } from '../lib/cloud-drives/routes.mjs';

export default makeConnectHandler(onedrive);
