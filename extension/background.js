const DEFAULT_SERVER = 'http://127.0.0.1:8787';

async function serverUrl() {
  try {
    const { server } = await chrome.storage.local.get('server');
    return (server || DEFAULT_SERVER).replace(/\/+$/, '');
  } catch {
    return DEFAULT_SERVER;
  }
}

function badge(text, color) {
  chrome.action.setBadgeText({ text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  enableSidePanel();
});
chrome.runtime.onStartup.addListener(() => {
  enableSidePanel();
});
enableSidePanel();

function enableSidePanel() {
  try {
    chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch?.(() => {});
  } catch { /* older chrome */ }
}

async function post(path, body) {
  const base = await serverUrl();
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function get(path) {
  const base = await serverUrl();
  const res = await fetch(base + path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ingest') {
    post('/ingest', { messages: msg.messages, context: msg.context })
      .then((out) => {
        const mean = Number(out?.stats?.mean ?? 0);
        badge(`${mean >= 0 ? '+' : ''}${mean.toFixed(1)}`, mean >= 0.12 ? '#166534' : mean <= -0.12 ? '#7f1d1d' : '#3f3f46');
        sendResponse({ ok: true, accepted: out.accepted, stats: out.stats });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg?.type === 'stats') {
    const q = msg.channelKey ? `?channel=${encodeURIComponent(msg.channelKey)}` : '';
    get(`/stats${q}`)
      .then((out) => sendResponse({ ok: true, stats: out.stats }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg?.type === 'hello') {
    post('/ingest', { messages: [], context: msg.context })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg?.type === 'ping') {
    get('/health')
      .then((out) => sendResponse({ ok: true, health: out }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  return false;
});
