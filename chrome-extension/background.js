// Service worker for the Contextspaces Chrome extension.
//
// Centralises all API calls so the content script and picker don't
// have to know about base URLs or token storage. Speaks a small
// message protocol:
//
//   { type: 'getToken' }                 → { token | null }
//   { type: 'setToken', token }          → { ok }
//   { type: 'listMatters' }              → { matters | error }
//   { type: 'listDocuments', matterId }  → { documents | error }
//   { type: 'pushToDrive', documentId }  → { result | error }

const BASE = 'https://www.contextspaces.ai';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ error: err?.message || String(err) }));
  return true; // keep the channel open for async response
});

async function handle(msg) {
  switch (msg.type) {
    case 'getToken':
      return { token: await getToken() };
    case 'setToken': {
      await chrome.storage.local.set({ csp_token: (msg.token || '').trim() });
      return { ok: true };
    }
    case 'listMatters':
      return apiGet('/api/ext/matters');
    case 'listDocuments': {
      if (!msg.matterId) return { error: 'matterId required' };
      return apiGet(`/api/ext/documents?matter=${encodeURIComponent(msg.matterId)}`);
    }
    case 'pushToDrive': {
      if (!msg.documentId) return { error: 'documentId required' };
      return apiPost('/api/ext/push-to-drive', { documentId: msg.documentId, folderName: 'Contextspaces' });
    }
    default:
      return { error: `unknown_message: ${msg.type}` };
  }
}

async function getToken() {
  const { csp_token } = await chrome.storage.local.get('csp_token');
  return csp_token || null;
}

async function apiGet(path) {
  const token = await getToken();
  if (!token) return { error: 'not_signed_in' };
  const resp = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) return { error: body.error || `http_${resp.status}` };
  return body;
}

async function apiPost(path, payload) {
  const token = await getToken();
  if (!token) return { error: 'not_signed_in' };
  const resp = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) return { error: body.error || `http_${resp.status}`, detail: body.detail || null };
  return body;
}
