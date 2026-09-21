// GET /api/dropbox-callback
//
// Dropbox redirects the user's browser here after they approve (or refuse) the
// connection. The route verifies the signed state, matches the PKCE verifier
// held in an HttpOnly cookie, exchanges the code, stores an encrypted refresh
// token on the connections row (service role, bypassing RLS), and sends the
// browser back to /app/connections.
//
// This URL is what goes in the Dropbox App Console under OAuth 2 → Redirect
// URIs:
//
//     https://www.contextspaces.ai/api/dropbox-callback
//
// Env required on Vercel: see api/dropbox-connect.mjs.

import { dropbox } from '../lib/cloud-drives/dropbox.mjs';
import { makeCallbackHandler } from '../lib/cloud-drives/routes.mjs';

export default makeCallbackHandler(dropbox);
