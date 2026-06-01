// Gmail content script — injects the "Attach from Contextspaces" button
// into Gmail compose windows. When clicked, opens the picker iframe;
// when the user picks a document, we push it to their Drive and either
// (a) auto-trigger Gmail's Insert-from-Drive picker, or (b) fall back
// to a clear "your file is in Drive — click the Drive icon to insert"
// toast.
//
// Gmail's DOM is volatile but the compose toolbar is identifiable by a
// few stable hooks (the Send button's role="button" + aria-label, and
// the toolbar's role="toolbar" ancestor). MutationObserver re-runs
// injection whenever Gmail mounts a new compose window.

const BUTTON_ID = 'csp-gmail-attach-btn';
const PICKER_FRAME_ID = 'csp-gmail-picker-frame';
const TOAST_ID = 'csp-gmail-toast';

console.log('[Contextspaces] content script loaded on', location.href);

// Watch the whole page for compose windows mounting. Gmail mounts /
// unmounts compose dialogs dynamically as the user opens "Compose" or
// switches between inbox views, so we re-scan on any DOM mutation
// (throttled by a microtask) and on a 1s interval as a safety net.
let scanScheduled = false;
function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  queueMicrotask(() => { scanScheduled = false; scanForComposeWindows(); });
}
const observer = new MutationObserver(scheduleScan);
observer.observe(document.body, { childList: true, subtree: true });
setInterval(scheduleScan, 1000);
scanForComposeWindows();

function scanForComposeWindows() {
  // Permissive detection: any element with role="button" whose
  // aria-label OR data-tooltip starts with "Send". This catches both
  // the full-screen compose ("Send") and the bottom-right inline
  // compose ("Send (Ctrl-Enter)"), and survives Gmail's variation
  // across consumer/Workspace accounts and languages-as-long-as-they-
  // -use-English-aria. Each Send button maps to one compose toolbar,
  // so injection is naturally idempotent via the BUTTON_ID check.
  const sendCandidates = document.querySelectorAll(
    'div[role="button"][aria-label], div[role="button"][data-tooltip]'
  );
  let sendCount = 0;
  for (const b of sendCandidates) {
    const lab = b.getAttribute('aria-label') || '';
    const tip = b.getAttribute('data-tooltip') || '';
    if (!/^Send\b/i.test(lab) && !/^Send\b/i.test(tip)) continue;
    sendCount++;
    // The compose's toolbar row is the Send button's parent element;
    // we check it (not the whole document) for an existing CSP button
    // so multi-compose windows each get their own button.
    const slot = b.parentElement;
    if (!slot) continue;
    const row = slot.parentElement || slot;
    if (row.querySelector(`#${BUTTON_ID}`)) continue;
    injectButton(b);
  }
  if (sendCount === 0 && !window.__cspNoSendLoggedRecently) {
    window.__cspNoSendLoggedRecently = true;
    setTimeout(() => { window.__cspNoSendLoggedRecently = false; }, 5000);
    console.log('[Contextspaces] no Send button found yet — waiting for compose to open');
  }
}

function injectButton(sendBtn) {
  // Find the closest compose dialog ancestor — that's the scope for
  // openPicker so messages from the picker iframe route back to the
  // right compose if there are multiple open.
  const dlg = sendBtn.closest('div[role="dialog"]') || sendBtn.parentElement;
  const btn = document.createElement('div');
  btn.id = BUTTON_ID;
  btn.className = 'csp-attach-btn';
  btn.setAttribute('role', 'button');
  btn.setAttribute('tabindex', '0');
  btn.title = 'Attach from Contextspaces';
  btn.innerHTML = `
    <span class="csp-attach-icon" aria-hidden="true">⌘</span>
    <span class="csp-attach-label">Contextspaces</span>
  `;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPicker(dlg);
  });
  // Insert after the parent containing Send. Gmail wraps each toolbar
  // item in a sibling div; inserting after sendBtn.parentElement keeps
  // us aligned in the same row.
  const slot = sendBtn.parentElement || sendBtn;
  slot.parentElement?.insertBefore(btn, slot.nextSibling);
  console.log('[Contextspaces] injected button next to Send');
}

function openPicker(composeDlg) {
  // Reuse the iframe if it's already open.
  let frame = document.getElementById(PICKER_FRAME_ID);
  if (frame) {
    frame.style.display = 'block';
    return;
  }

  frame = document.createElement('iframe');
  frame.id = PICKER_FRAME_ID;
  frame.src = chrome.runtime.getURL('picker/picker.html');
  frame.className = 'csp-picker-frame';
  document.body.appendChild(frame);

  // Close on Escape.
  const onKey = (e) => {
    if (e.key === 'Escape') closePicker();
  };
  document.addEventListener('keydown', onKey);

  // Click-outside to close.
  const onClick = (e) => {
    if (frame && !frame.contains(e.target) && e.target !== frame) closePicker();
  };
  setTimeout(() => document.addEventListener('mousedown', onClick), 0);

  function closePicker() {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousedown', onClick);
    frame?.remove();
  }

  // Listen for the picker's "selected" message.
  window.addEventListener('message', async function onMessage(ev) {
    if (!ev.data || ev.data.source !== 'csp-picker') return;
    if (ev.data.type === 'close') { closePicker(); return; }
    if (ev.data.type === 'selected') {
      const { documentId, documentName } = ev.data.payload || {};
      closePicker();
      await handleSelectedDocument(composeDlg, documentId, documentName);
    }
  });
}

async function handleSelectedDocument(composeDlg, documentId, documentName) {
  if (!documentId) return;
  showToast(`Pushing "${documentName || 'document'}" to Drive…`);
  const result = await chrome.runtime.sendMessage({
    type: 'pushToDrive',
    documentId,
  });
  if (result?.error) {
    if (result.error === 'drive_not_connected') {
      showToast(
        'Drive not connected. Open contextspaces.ai → Connections → connect Google Drive, then try again.',
        'error',
        10000,
      );
    } else if (result.error === 'drive_needs_reconnect') {
      showToast('Reconnect Google Drive on Contextspaces — your token expired.', 'error', 10000);
    } else {
      const detailMsg = result.detail?.error?.message || result.error;
      showToast(`Drive push failed: ${detailMsg}`, 'error', 10000);
    }
    return;
  }
  // Success — file is in Drive. The cleanest reliable next step is to
  // tell the user to click Gmail's Drive icon. Auto-clicking it is
  // technically possible but Gmail's Drive picker iframe is gated by
  // Google's own auth flow and we can't pre-select a file across that
  // boundary without breakage. So: provide a clear pointer.
  const link = result.webViewLink || 'https://drive.google.com/drive/u/0/my-drive';
  showToast(
    `"${result.name}" is in your Contextspaces Drive folder. Click Gmail's Drive icon (bottom of compose) to insert it. <a href="${link}" target="_blank" rel="noreferrer">Open in Drive</a>`,
    'ok',
    14000,
  );
}

function showToast(html, kind = 'ok', durationMs = 6000) {
  document.getElementById(TOAST_ID)?.remove();
  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.className = `csp-toast csp-toast-${kind}`;
  toast.innerHTML = `
    <span class="csp-toast-msg">${html}</span>
    <button class="csp-toast-close" aria-label="Dismiss">×</button>
  `;
  toast.querySelector('.csp-toast-close')?.addEventListener('click', () => toast.remove());
  document.body.appendChild(toast);
  if (durationMs > 0) {
    setTimeout(() => toast.remove(), durationMs);
  }
}
