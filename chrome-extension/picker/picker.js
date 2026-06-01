const $ = (s) => document.querySelector(s);

function postParent(type, payload) {
  parent.postMessage({ source: 'csp-picker', type, payload }, '*');
}

$('#close').addEventListener('click', () => postParent('close'));

function showError(msg) {
  $('#loading').hidden = true;
  $('#error').hidden = false;
  $('#error').textContent = msg;
}

async function start() {
  const { matters, error } = await chrome.runtime.sendMessage({ type: 'listMatters' });
  $('#loading').hidden = true;
  if (error === 'not_signed_in') {
    $('#not-signed-in').hidden = false;
    return;
  }
  if (error) {
    showError(`Couldn't load matters: ${error}`);
    return;
  }
  if (!matters || matters.length === 0) {
    showError('You have no matters yet. Create one in Contextspaces first.');
    return;
  }

  const sel = $('#matter-select');
  for (const m of matters) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.serverspace_name ? `${m.serverspace_name} / ${m.name}` : m.name;
    sel.appendChild(opt);
  }
  $('#matter-pick').hidden = false;
  $('#doc-list').hidden = false;

  sel.addEventListener('change', () => loadDocs(sel.value));
  loadDocs(sel.value);
}

async function loadDocs(matterId) {
  const ul = $('#doc-ul');
  ul.innerHTML = '';
  $('#doc-list-status').textContent = 'Loading documents…';
  $('#doc-list-status').hidden = false;

  const { documents, error } = await chrome.runtime.sendMessage({
    type: 'listDocuments',
    matterId,
  });
  if (error) {
    $('#doc-list-status').textContent = `Error: ${error}`;
    return;
  }
  if (!documents || documents.length === 0) {
    $('#doc-list-status').textContent = 'No documents in this matter yet.';
    return;
  }
  $('#doc-list-status').hidden = true;

  for (const d of documents) {
    const li = document.createElement('li');
    const ready = d.processing_status === 'ready' || d.processing_status === 'indexed';
    if (!ready) li.classList.add('disabled');
    const title = document.createElement('div');
    title.className = 'doc-title';
    title.textContent = d.title || d.source_filename || 'Untitled';
    const meta = document.createElement('div');
    meta.className = 'doc-meta';
    const bits = [];
    if (d.source_filename) bits.push(d.source_filename);
    if (d.doc_type && d.doc_type !== 'other') bits.push(d.doc_type);
    if (!ready) bits.push(`status: ${d.processing_status}`);
    meta.textContent = bits.join(' · ');
    li.appendChild(title);
    li.appendChild(meta);
    if (ready) {
      li.addEventListener('click', () => {
        postParent('selected', {
          documentId: d.id,
          documentName: d.title || d.source_filename,
        });
      });
    }
    ul.appendChild(li);
  }
}

start();
