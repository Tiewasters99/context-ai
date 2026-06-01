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

// Watch the whole page for compose windows mounting.
const observer = new MutationObserver(() => scanForComposeWindows());
observer.observe(document.body, { childList: true, subtree: true });
scanForComposeWindows();

function scanForComposeWindows() {
  // Gmail compose dialogs are positioned dialogs with role="dialog" and
  // contain a Send button identifiable by its data tooltip / aria-label.
  const dialogs = document.querySelectorAll('div[role="dialog"]');
  for (const dlg of dialogs) {
    if (dlg.querySelector(`#${BUTTON_ID}`)) continue;
    const sendBtn = findSendButton(dlg);
    if (!sendBtn) continue;
    injectButton(dlg, sendBtn);
  }
}

function findSendButton(dlg) {
  // Send button has role="button" and either data-tooltip starting with
  // "Send" or aria-label starting with "Send".
  const candidates = dlg.querySelectorAll('div[role="button"]');
  for (const b of candidates) {
    const tip = b.getAttribute('data-tooltip') || '';
    const lab = b.getAttribute('aria-label') || '';
    if (/^Send\b/i.test(tip) || /^Send\b/i.test(lab)) return b;
  }
  return null;
}

function injectButton(dlg, sendBtn) {
  // Sit immediately to the right of Send in the toolbar.
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
  // Insert after the parent containing send (Gmail puts each toolbar
  // item in a sibling div; appending after sendBtn's parent works).
  const slot = sendBtn.parentElement || sendBtn;
  slot.parentElement?.insertBefore(btn, slot.nextSibling);
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
