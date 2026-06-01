const $ = (s) => document.querySelector(s);

async function refresh() {
  const { token } = await chrome.runtime.sendMessage({ type: 'getToken' });
  if (token) {
    $('#status').textContent = 'Signed in';
    $('#status').className = 'status-ok';
    $('#connected').hidden = false;
    $('#connect').hidden = true;
  } else {
    $('#status').textContent = 'Not signed in';
    $('#status').className = 'muted';
    $('#connected').hidden = true;
    $('#connect').hidden = false;
  }
}

$('#save').addEventListener('click', async () => {
  const token = $('#token-input').value.trim();
  if (!token.startsWith('csp_')) {
    $('#status').textContent = 'Token should start with csp_';
    $('#status').className = 'status-err';
    return;
  }
  await chrome.runtime.sendMessage({ type: 'setToken', token });
  $('#token-input').value = '';
  refresh();
});

$('#reset').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'setToken', token: '' });
  refresh();
});

$('#open-connections').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://www.contextspaces.ai/app/connections/claude' });
});

refresh();
