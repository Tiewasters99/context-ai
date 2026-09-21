// GET /api/microsoft-callback
//
// Microsoft redirects the user's browser here after they approve (or refuse)
// the OneDrive connection. The route verifies the signed state, matches the
// PKCE verifier held in an HttpOnly cookie, exchanges the code, stores an
// encrypted refresh token on the connections row (service role, bypassing
// RLS), and sends the browser back to /app/connections.
//
// This URL is what goes in the Entra app registration as the redirect URI:
//
//     https://www.contextspaces.ai/api/microsoft-callback
//
// Env required on Vercel: see api/microsoft-connect.mjs.

import { onedrive } from '../lib/cloud-drives/onedrive.mjs';
import { makeCallbackHandler } from '../lib/cloud-drives/routes.mjs';

export default makeCallbackHandler(onedrive);
