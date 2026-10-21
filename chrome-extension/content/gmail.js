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

console.log('[Equazia.ai] content script loaded on', location.href);

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
    console.log('[Equazia.ai] no Send button found yet — waiting for compose to open');
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
  btn.title = 'Attach from Equazia.ai';
  // Inline SVG: the Equazia.ai serif "E" (Playfair Display, drawn as a path)
  // in the brand gold, so it reads at toolbar scale without icon fonts.
  btn.innerHTML = `
    <svg class="csp-attach-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path transform="matrix(0.02542 0 0 -0.02542 4.291 21.000)" fill="currentColor" d="M569 708Q565 664 563 623Q562 582 562 560Q562 540 563 522Q564 504 565 492H542Q532 565 511 608Q490 650 457 668Q423 685 378 685H337Q308 685 293 680Q278 675 273 660Q268 645 268 614V94Q268 63 273 48Q278 33 293 28Q308 23 337 23H386Q431 23 466 43Q500 62 525 109Q549 156 562 236H585Q582 204 582 152Q582 129 583 87Q584 45 589 0Q538 2 474 2Q410 3 360 3Q335 3 296 3Q257 3 212 2Q167 2 121 2Q75 1 34 0V20Q66 22 82 28Q98 34 103 52Q109 70 109 106V602Q109 639 103 656Q98 674 81 680Q65 687 34 688V708Q75 707 121 706Q167 706 212 706Q257 705 296 705Q335 705 360 705Q406 705 464 706Q523 706 569 708ZM413 366Q413 366 413 356Q413 346 413 346H238Q238 346 238 356Q238 366 238 366ZM442 498Q438 441 438 411Q439 381 439 356Q439 331 440 301Q441 271 445 214H422Q417 249 403 279Q390 309 365 328Q340 346 300 346V366Q330 366 351 379Q372 391 385 412Q399 432 407 455Q415 478 419 498Z"/>
    </svg>
    <span class="csp-attach-label">Equazia.ai</span>
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
  console.log('[Equazia.ai] injected button next to Send');
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
        'Drive not connected. Open Equazia.ai → Connections → connect Google Drive, then try again.',
        'error',
        10000,
      );
    } else if (result.error === 'drive_needs_reconnect') {
      showToast('Reconnect Google Drive on Equazia.ai — your token expired.', 'error', 10000);
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
