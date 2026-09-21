// /api/dropbox-connect — start, probe or end the Dropbox connection.
//
//   GET     → { configured, missing_env }   (no session; a fact about this
//             deployment, so the Connections card can say "Not available yet")
//   POST    → { url }                       the Dropbox authorization URL
//   DELETE  → revoke at Dropbox, then delete the row
//
// The flow itself lives in lib/cloud-drives/routes.mjs, and the Dropbox
// specifics (one scope, the App folder, the ASCII-escaped argument header) in
// lib/cloud-drives/dropbox.mjs.
//
// Env required on Vercel: DROPBOX_APP_KEY, DROPBOX_APP_SECRET,
// MCP_OAUTH_SECRET, CONNECTIONS_ENC_KEY, VITE_SUPABASE_URL,
// VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY. Without the first two
// every call answers 503 not_configured.

import { dropbox } from '../lib/cloud-drives/dropbox.mjs';
import { makeConnectHandler } from '../lib/cloud-drives/routes.mjs';

export default makeConnectHandler(dropbox);
