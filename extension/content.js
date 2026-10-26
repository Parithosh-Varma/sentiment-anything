/**
 * Discord DOM scraper.
 *
 * Reads only what is rendered on screen (no token, no API calls, no automation).
 * Parsing lives in extract.js; this file handles context, batching and retries
 * because MV3 service workers get killed when idle.
 */
(() => {
  if (window.__discordLiveSentiment) return;
  window.__discordLiveSentiment = true;

  const X = globalThis.__dsExtract;
  if (!X) {
    console.warn('[discord-sentiment] extract.js missing; check manifest script order');
    return;
  }

  const MSG_SEL = X.SELECTORS.message;
  const ROOT_SEL = '[data-list-id="chat-messages"]';
  const MAX_QUEUE = 3000;
  const FLUSH_MS = 350;

  const store = new X.SeenStore({ limit: 6000 });
  let queue = [];
  let pendingEls = new Set();
  let flushTimer = null;
  let lastHref = location.href;
  let lastFlushOk = Date.now();
  let sendFailures = 0;
  let hud = null;
  let hudEnabled = true;
  let lastStats = null;

  // ---------------------------------------------------------------- context
  function getContext() {
    const rawTitle = document.title.replace(/^\(\d+\)\s*/, '').trim();
    const parts = rawTitle.split(' | ');
    let channel = (parts[0] || '').replace(/^#/, '').trim();
    let guild = (parts[1] || '').trim();

    const m = location.pathname.match(/\/channels\/(@me|\d{2,})\/(\d{2,})/);
    if (!channel || channel.toLowerCase() === 'discord') {
      const el = document.querySelector('[class*="channelName"] [class*="name"], h1[class*="title"], [class*="title"] h1');
      channel = el ? el.textContent.trim().replace(/^#/, '') : '';
    }
    if (!channel) channel = m ? (m[1] === '@me' ? 'dm' : `channel-${m[2]}`) : 'unknown';
    if (!guild) guild = m ? (m[1] === '@me' ? 'Direct Messages' : 'Discord') : 'Discord';

    return {
      channel,
      guild,
      channelKey: `${guild}::${channel}`,
      url: location.href,
    };
  }

  // --------------------------------------------------------------- pipeline
  function extract(el) {
    const msg = X.parseMessage(el, getContext());
    if (!msg) return null;

    const verdict = store.check(msg);
    if (verdict === 'skip') return null;

    msg.text = msg.content; // wire name used by the server and panels
    msg.update = verdict === 'update';
    return msg;
  }

  function enqueue(el) {
    const msg = extract(el);
    if (!msg) return;
    if (queue.length >= MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE + 1);
    queue.push(msg);
    scheduleFlush();
  }

  function scan(root = document) {
    if (!root.querySelectorAll) return;
    for (const el of root.querySelectorAll(MSG_SEL)) enqueue(el);
  }

  function scheduleFlush(delay = FLUSH_MS) {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, delay);
  }

  function flush() {
    if (!queue.length) return;
    const batch = queue.splice(0, queue.length);
    const ctx = getContext();
    try {
      chrome.runtime.sendMessage({ type: 'ingest', context: ctx, messages: batch }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          queue = batch.concat(queue).slice(-MAX_QUEUE);
          sendFailures++;
          setHudState();
          scheduleFlush(Math.min(5000, 1000 + sendFailures * 500));
          return;
        }
        sendFailures = 0;
        lastFlushOk = Date.now();
        if (res.stats) lastStats = res.stats;
        setHudState();
      });
    } catch {
      queue = batch.concat(queue).slice(-MAX_QUEUE);
      scheduleFlush(2000);
    }
  }

  // ------------------------------------------------------------------- HUD
  function buildHud() {
    if (hud) return hud;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;z-index:2147483000;right:16px;bottom:16px;pointer-events:none;';
    const el = host.attachShadow({ mode: 'open' });
    el.innerHTML = `
      <style>
        .pill{display:flex;align-items:center;gap:8px;font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
          background:rgba(13,15,19,.94);color:#e6e8ee;border:1px solid rgba(255,255,255,.12);
          padding:8px 11px;border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.4);backdrop-filter:blur(8px)}
        .dot{width:7px;height:7px;border-radius:50%;background:#4ade80;box-shadow:0 0 8px #4ade8080}
        .dot.off{background:#f87171;box-shadow:0 0 8px #f8717180}
        .dot.idle{background:#fbbf24;box-shadow:0 0 8px #fbbf2480}
        .v{font-weight:700}
        .p{color:#4ade80}.n{color:#f87171}.m{color:#8b93a5}
      </style>
      <div class="pill">
        <span class="dot" id="dot"></span>
        <span id="state">connecting</span>
        <span class="m" id="rate">0/min</span>
        <span class="v" id="score">±0.00</span>
      </div>`;
    document.documentElement.appendChild(host);
    hud = {
      host,
      dot: el.getElementById('dot'),
      state: el.getElementById('state'),
      rate: el.getElementById('rate'),
      score: el.getElementById('score'),
    };
    return hud;
  }

  function setHudState() {
    if (!hudEnabled) {
      if (hud) hud.host.style.display = 'none';
      return;
    }
    const h = buildHud();
    h.host.style.display = 'block';

    const offline = sendFailures > 0;
    const idle = !offline && Date.now() - lastFlushOk > 45000;
    h.dot.className = `dot ${offline ? 'off' : idle ? 'idle' : ''}`;
    h.state.textContent = offline ? 'server offline' : idle ? 'idle' : 'live';

    if (lastStats) {
      h.rate.textContent = `${lastStats.perMin ?? 0}/min`;
      const m = Number(lastStats.mean ?? 0);
      h.score.textContent = `${m >= 0 ? '+' : ''}${m.toFixed(2)}`;
      h.score.className = `v ${m > 0.12 ? 'p' : m < -0.12 ? 'n' : 'm'}`;
    }
    if (queue.length) h.rate.textContent = `${queue.length} queued`;
  }

  // ---------------------------------------------------------- observation
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.(MSG_SEL)) pendingEls.add(node);
        else if (node.querySelectorAll) {
          for (const el of node.querySelectorAll(MSG_SEL)) pendingEls.add(el);
        }
      }
    }
    if (pendingEls.size) {
      const batch = [...pendingEls];
      pendingEls = new Set();
      for (const el of batch) enqueue(el);
    }
  });

  function startObserving() {
    const root = document.querySelector(ROOT_SEL) || document.body;
    observer.disconnect();
    observer.observe(root, { childList: true, subtree: true });
  }

  function onNavigate() {
    pendingEls = new Set();
    startObserving();
    scan();
    setHudState();
    try {
      chrome.runtime.sendMessage({ type: 'hello', context: getContext() });
    } catch { /* extension reloaded */ }
  }

  // Poll for SPA channel switches (Discord uses history.pushState).
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      onNavigate();
    }
  }, 900);

  setInterval(setHudState, 2000);
  setInterval(() => {
    try {
      chrome.runtime.sendMessage({ type: 'stats', channelKey: getContext().channelKey }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res?.stats) lastStats = res.stats;
      });
    } catch { /* extension reloaded */ }
  }, 4000);

  chrome.storage?.sync?.get({ hud: true }, (v) => {
    hudEnabled = v?.hud !== false;
    setHudState();
  });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'sync' && changes.hud) {
      hudEnabled = changes.hud.newValue !== false;
      setHudState();
    }
  });

  // ------------------------------------------------------------------ boot
  function boot() {
    if (!document.querySelector(ROOT_SEL) && !document.querySelector(MSG_SEL)) {
      setTimeout(boot, 700);
      return;
    }
    startObserving();
    scan(); // backfill whatever is already rendered
    setHudState();
    try {
      chrome.runtime.sendMessage({ type: 'hello', context: getContext() });
    } catch { /* extension reloaded */ }
    console.log('[discord-sentiment] attached', getContext());
  }

  boot();
})();
