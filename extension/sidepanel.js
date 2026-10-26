const $ = (id) => document.getElementById(id);

const DEFAULT_SERVER = 'http://127.0.0.1:8787';
const MAX_ROWS = 160;

const state = {
  server: DEFAULT_SERVER,
  lastSeq: 0,
  paused: false,
  connected: false,
  messages: [],
  byId: new Map(),
  stats: null,
  channelKey: null,
  source: null,
  pollTimer: null,
};

const fmt = (n) => (n >= 0 ? '+' : '') + Number(n || 0).toFixed(2);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ settings
async function loadSettings() {
  const { server } = await chrome.storage.local.get({ server: DEFAULT_SERVER });
  state.server = (server || DEFAULT_SERVER).replace(/\/+$/, '');
  $('serverInput').value = state.server;
  const { hud } = await chrome.storage.sync.get({ hud: true });
  $('hudToggle').checked = hud !== false;
}

$('serverInput').addEventListener('change', async (e) => {
  const v = (e.target.value || DEFAULT_SERVER).trim().replace(/\/+$/, '');
  state.server = v;
  await chrome.storage.local.set({ server: v });
  connect();
});

$('hudToggle').addEventListener('change', (e) => {
  chrome.storage.sync.set({ hud: e.target.checked });
});

$('pauseBtn').addEventListener('click', (e) => {
  state.paused = !state.paused;
  e.target.classList.toggle('active', state.paused);
  e.target.textContent = state.paused ? 'resume' : 'pause';
  if (state.paused) $('statusDot').className = 'dot';
  else connect();
});

$('clearBtn').addEventListener('click', async () => {
  try {
    await fetch(`${state.server}/clear`, { method: 'POST' });
  } catch { /* ignore */ }
  state.messages = [];
  state.lastSeq = 0;
  state.stats = null;
  $('feed').innerHTML = '<div class="empty">cleared.</div>';
  renderStats();
});

// ------------------------------------------------------------------- status
function setStatus(mode) {
  const dot = $('statusDot');
  dot.className = 'dot ' + (mode === 'live' ? 'live' : mode === 'off' ? 'off' : '');
}

// ------------------------------------------------------------------ connect
function stopStream() {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function connect() {
  stopStream();
  if (state.paused) return;
  setStatus('idle');

  await hydrate();
  openStream();
}

async function hydrate() {
  try {
    const res = await fetch(`${state.server}/feed?limit=120`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.lastSeq = data.lastSeq || 0;
    for (const m of data.messages) pushMessage(m);
    const s = await fetch(`${state.server}/stats${state.channelKey ? `?channel=${encodeURIComponent(state.channelKey)}` : ''}`, { cache: 'no-store' });
    if (s.ok) state.stats = (await s.json()).stats;
    renderStats();
    setStatus('live');
  } catch {
    setStatus('off');
  }
}

function openStream() {
  let src;
  try {
    src = new EventSource(`${state.server}/stream`);
  } catch {
    setStatus('off');
    startPolling();
    return;
  }
  state.source = src;

  src.addEventListener('hello', (ev) => {
    const data = JSON.parse(ev.data);
    state.lastSeq = Math.max(state.lastSeq, data.lastSeq || 0);
    if (data.stats) state.stats = data.stats;
    renderStats();
    setStatus('live');
  });

  src.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    pushMessage(m);
  });

  src.addEventListener('update', (ev) => {
    try { pushMessage(JSON.parse(ev.data)); } catch { /* ignore malformed */ }
  });

  src.addEventListener('stats', (ev) => {
    const data = JSON.parse(ev.data);
    state.stats = data.stats;
    renderStats();
  });

  src.onopen = () => {
    state.connected = true;
    setStatus('live');
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  };

  src.onerror = () => {
    state.connected = false;
    setStatus('off');
    // EventSource retries on its own; add a poll-based safety net.
    if (!state.pollTimer) startPolling();
  };
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${state.server}/feed?since=${state.lastSeq}&limit=50`, { cache: 'no-store' });
      const data = await res.json();
      for (const m of data.messages) pushMessage(m);
      const s = await fetch(`${state.server}/stats${state.channelKey ? `?channel=${encodeURIComponent(state.channelKey)}` : ''}`, { cache: 'no-store' });
      if (s.ok) {
        state.stats = (await s.json()).stats;
        renderStats();
        setStatus('live');
      }
    } catch {
      setStatus('off');
    }
  }, 2500);
}

// ---------------------------------------------------------------- rendering
function chipClass(score) {
  return score > 0.12 ? 'pos' : score < -0.12 ? 'neg' : '';
}

function clockOf(m) {
  const t = new Date(m.receivedAt || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

const INTENT_LABEL = {
  question: 'asks',
  request: 'wants',
  complaint: 'complains',
  praise: 'praises',
};

function intentChip(m) {
  if (!m.intent || m.intent === 'neutral') return '';
  const label = INTENT_LABEL[m.intent] || m.intent;
  const src = m.intentSource === 'heuristic' ? ' · heuristic' : '';
  const prob = m.intentProb ? ` ${Math.round(m.intentProb * 100)}%` : '';
  return `<span class="intent ${m.intent}" title="${esc(m.intent + prob + src)}">${label}</span>`;
}

function rowHtml(m) {
  const isObj = m.replyTo && typeof m.replyTo === 'object';
  const replyText = isObj ? m.replyTo.text : typeof m.replyTo === 'string' ? m.replyTo : '';
  const replyAuthor = isObj ? m.replyTo.author : '';
  return `
    <div class="chip ${chipClass(m.score)}" title="${esc(m.label || '')}">${fmt(m.score)}</div>
    <div class="body">
      ${replyText ? `<div class="reply">↳ ${replyAuthor ? esc(replyAuthor) + ': ' : ''}${esc(replyText.slice(0, 70))}</div>` : ''}
      <div class="who">${intentChip(m)}${esc(m.author)}<span class="time">${clockOf(m)}${m.edited ? ' ·edited' : ''}${m.backfill ? ' ·backfill' : ''}</span></div>
      <div class="txt">${linkify(esc(m.text))}</div>
    </div>`;
}

function pushMessage(m) {
  if (!m || !m.seq) return;

  const key = m.id || `seq-${m.seq}`;
  const feed = $('feed');
  const existing = state.byId.get(key);

  // same DOM id -> this is an edit or a re-render, patch the row in place
  if (existing && existing.isConnected) {
    existing.innerHTML = rowHtml(m);
    if (m.guild || m.channel) $('channel').textContent = `${m.guild ? m.guild + ' ' : ''}#${m.channel || '?'}`;
    return;
  }

  if (!state.rendered) state.rendered = new Set();
  if (state.rendered.has(m.seq)) return;
  state.rendered.add(m.seq);
  if (state.rendered.size > 4000) state.rendered = new Set([...state.rendered].slice(-2000));

  state.messages.push(m);
  if (state.messages.length > MAX_ROWS) state.messages.shift();

  const empty = feed.querySelector('.empty');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = 'msg';
  el.dataset.id = key;
  el.innerHTML = rowHtml(m);
  feed.appendChild(el);
  state.byId.set(key, el);

  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;
  if (nearBottom) feed.scrollTop = feed.scrollHeight;

  while (feed.children.length > MAX_ROWS) {
    const first = feed.firstChild;
    if (first?.dataset?.id) state.byId.delete(first.dataset.id);
    feed.removeChild(first);
  }

  $('feedCount').textContent = `${state.messages.length}`;
  if (m.guild || m.channel) {
    $('channel').textContent = `${m.guild ? m.guild + ' ' : ''}#${m.channel || '?'}`;
  }
}

function linkify(html) {
  return html.replace(/https?:\/\/\S+/g, (u) => `<a href="${u}" target="_blank" rel="noreferrer" style="color:#7c9cff">${u}</a>`);
}

function renderStats() {
  const s = state.stats;
  if (!s) return;

  const mean = Number(s.mean || 0);
  const meanEl = $('mean');
  meanEl.textContent = fmt(mean);
  meanEl.className = 'score ' + (mean > 0.12 ? 'pos' : mean < -0.12 ? 'neg' : '');

  $('rate').textContent = s.perMin ?? 0;
  $('count').textContent = s.count ?? 0;
  const trend = Number(s.trend || 0);
  $('trend').textContent = fmt(trend);
  $('trend').style.color = trend > 0.08 ? 'var(--pos)' : trend < -0.08 ? 'var(--neg)' : 'var(--muted)';

  $('gaugeMark').style.left = `${((mean + 1) / 2) * 100}%`;

  const pos = s.positives || 0;
  const neg = s.negatives || 0;
  const total = Math.max(1, s.count || 1);
  $('mixP').style.width = `${(pos / total) * 100}%`;
  $('mixN').style.width = `${(neg / total) * 100}%`;
  const line = intentLine(s.intents);
  $('intentLine').textContent = line ? `what they're doing: ${line}` : '';
  $('mixPos').textContent = `${Math.round((pos / total) * 100)}% positive`;
  $('mixNeg').textContent = `${Math.round((neg / total) * 100)}% negative`;

  drawSpark(s.spark || []);
}

// ------------------------------------------------------------------- topics
async function loadTopics() {
  try {
    const res = await fetch(`${state.server}/topics?limit=6`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderTopics(await res.json());
  } catch {
    const badge = $('jevBadge');
    badge.className = 'jevBadge off';
    badge.textContent = 'jev offline';
  }
}

function renderTopics(snap) {
  const jev = snap.jev || {};
  const badge = $('jevBadge');
  if (jev.lastError && !jev.online) {
    badge.className = 'jevBadge off';
    badge.textContent = 'jev down';
    badge.title = jev.lastError;
  } else {
    badge.className = 'jevBadge';
    badge.textContent = jev.lastLatencyMs ? `jev ${(jev.lastLatencyMs / 1000).toFixed(1)}s` : 'jev –';
    badge.title = `${jev.model || ''} · ${jev.cycles || 0} cycles`;
  }

  const hot = snap.hot;
  const mode = snap.mode;
  const hotEl = $('hotLine');
  if (hot) {
    hotEl.innerHTML = `<span>hot</span> <b>${esc(hot.display)}</b>`
      + `<span style="opacity:.55">${(hot.confidence || 0).toFixed(2)}</span>`
      + (mode ? ` <span class="mode">· ${esc(mode.label)}</span>` : '');
  } else {
    hotEl.innerHTML = mode
      ? `<span class="mode">${esc(mode.label)}</span> <span style="opacity:.55">${(mode.confidence || 0).toFixed(2)}</span>`
      : '<span>waiting for jev…</span>';
  }

  const list = $('topicList');
  const topics = (snap.topics || []).slice(0, 6);
  if (!topics.length) {
    list.innerHTML = '<div class="empty">no topics yet</div>';
    return;
  }
  const max = Math.max(...topics.map((t) => t.count), 1);
  list.innerHTML = topics
    .map((t, i) => {
      const w = Math.max(5, Math.round((t.count / max) * 100));
      const cls = t.sentiment > 0.12 ? 'pos' : t.sentiment < -0.12 ? 'neg' : 'neu';
      const vel = t.velocity > 0 ? ' <span class="v">↑</span>' : '';
      const doing = intentLine(t.intents);
      const title = [
        `${t.authors} ${t.authors === 1 ? 'person' : 'people'}`,
        doing,
        (t.samples || []).join('  |  '),
      ].filter(Boolean).join(' · ');
      return `<div class="topicRow" title="${esc(title)}">
        <span class="topicRank">${i + 1}</span>
        <span class="topicName">${esc(t.display)}${vel}${doing ? `<span class="topicDoing">${esc(doing)}</span>` : ''}</span>
        <span class="topicBar"><i style="width:${w}%"></i></span>
        <span class="topicCount">${t.count}</span>
        <span class="topicSent ${cls}">${t.sentiment >= 0 ? '+' : ''}${Number(t.sentiment || 0).toFixed(1)}</span>
      </div>`;
    })
    .join('');
}

const INTENT_VERB = {
  complaint: 'complaining',
  question: 'asking',
  request: 'requesting',
  praise: 'praising',
};

/** "6 complaining, 2 asking" — top two non-neutral, or ''. */
function intentLine(intents) {
  return Object.entries(intents || {})
    .filter(([label, count]) => label !== 'neutral' && count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([label, count]) => `${count} ${INTENT_VERB[label] || label}`)
    .join(', ');
}

function drawSpark(values) {
  const canvas = $('spark');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  const h = 44;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const pts = values.map((v) => (v === null ? null : Number(v)));
  const step = w / Math.max(1, pts.length - 1);

  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  let started = false;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  let prev = null;
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i];
    if (v === null) { prev = null; continue; }
    const x = i * step;
    const y = h / 2 - (v / 1) * (h / 2 - 4);
    ctx.strokeStyle = v >= 0 ? '#45d483' : '#f0655f';
    ctx.beginPath();
    if (prev) { ctx.moveTo(prev.x, prev.y); } else { ctx.moveTo(x, y); }
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = v >= 0 ? '#45d483' : '#f0655f';
    ctx.beginPath();
    ctx.arc(x, y, 1.6, 0, Math.PI * 2);
    ctx.fill();
    prev = { x, y };
    started = true;
  }
  if (!started) {
    ctx.fillStyle = '#4b5364';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('no data yet', 8, h / 2 - 6);
  }
}

// -------------------------------------------------------------------- boot
loadSettings().then(() => {
  connect();
  loadTopics();
  setInterval(loadTopics, 3000);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !state.paused && !state.connected) connect();
});
