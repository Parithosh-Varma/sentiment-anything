#!/usr/bin/env node
/**
 * Live "most talked about" board, backed by jev decisions.
 *
 *   npm run topics
 *   node cli/topics.mjs --once
 *   node cli/topics.mjs --json
 *   node cli/topics.mjs --channel "Test Server::general" --interval 2000
 */
const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

const BASE = (flag('url', process.env.SENTIMENT_URL || 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const CHANNEL = flag('channel', '');
const INTERVAL = Number(flag('interval', 2500));
const ONCE = has('once') || has('json') || !process.stdout.isTTY;
const AS_JSON = has('json');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

const clamp = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const padL = (s, n) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const col = (n) => (n > 0.12 ? C.green : n < -0.12 ? C.red : C.gray);
const fmt = (n) => (n >= 0 ? '+' : '') + Number(n).toFixed(2);
const arrow = (v) => (v > 0 ? `${C.green}↑${v}${C.reset}` : v < 0 ? `${C.red}↓${Math.abs(v)}${C.reset}` : `${C.dim}–${C.reset}`);

async function snapshot() {
  const q = new URLSearchParams();
  if (CHANNEL) q.set('channel', CHANNEL);
  q.set('limit', '14');
  const res = await fetch(`${BASE}/topics?${q}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function render(snap) {
  const width = Math.min(process.stdout.columns || 100, 110);
  const rows = snap.topics || [];
  const max = Math.max(1, ...rows.map((r) => r.count));
  const out = [];

  const jev = snap.jev || {};
  const jevState = jev.lastError && !jev.online
    ? `${C.red}offline${C.reset} ${C.dim}${clamp(jev.lastError, 40)}${C.reset}`
    : `${C.green}online${C.reset} ${C.dim}${jev.model || '?'} · ${jev.lastLatencyMs ?? '–'}ms · ${jev.cycles ?? 0} cycles${C.reset}`;

  out.push(`${C.bold}Discord topics${C.reset} ${C.dim}${snap.channelKey || 'all channels'}${C.reset}`);
  out.push(`${C.dim}jev${C.reset} ${jevState}`);
  if (snap.hot) {
    out.push(`${C.dim}hot right now${C.reset} ${C.bold}${snap.hot.display}${C.reset} ${C.dim}(jev ${snap.hot.confidence.toFixed(2)})${C.reset}`);
  }
  if (snap.mode) {
    out.push(`${C.dim}mode${C.reset} ${C.yellow}${snap.mode.label}${C.reset} ${C.dim}(${snap.mode.confidence.toFixed(2)})${C.reset}`);
  }
  out.push(`${C.dim}${'─'.repeat(width)}${C.reset}`);

  if (!rows.length) {
    out.push(`${C.dim}no topics yet — waiting for messages${C.reset}`);
    return out.join('\n');
  }

  out.push(
    `${C.dim}${pad('#', 3)}${pad('topic', 26)}${pad('volume', 20)}${padL('msgs', 5)}${padL('ppl', 5)}${padL('vel', 7)}${padL('sent', 7)}  stance        doing${C.reset}`,
  );

  rows.forEach((r, i) => {
    const barLen = Math.max(1, Math.round((r.count / max) * 16));
    const bar = `${C.cyan}${'█'.repeat(barLen)}${C.reset}${' '.repeat(16 - barLen)}`;
    const verified = r.jev ? (r.jev.isTopic >= 0.5 ? `${C.green}✓${C.reset}` : `${C.yellow}~${C.reset}`) : ' ';
    const stance = r.stance
      ? `${r.stance.label} ${C.dim}${r.stance.confidence.toFixed(2)}${C.reset}`
      : `${C.dim}–${C.reset}`;
    const name = clamp(r.display, 24);
    const velRaw = r.velocity > 0 ? `+${r.velocity}` : r.velocity < 0 ? `${r.velocity}` : '·';
    const velCell = r.velocity > 0 ? `${C.green}${velRaw}${C.reset}` : r.velocity < 0 ? `${C.red}${velRaw}${C.reset}` : `${C.dim}·${C.reset}`;
    const velPad = ' '.repeat(Math.max(0, 7 - velRaw.length)) + velCell;
    const doing = Object.entries(r.intents || {})
      .filter(([label, count]) => label !== 'neutral' && count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([label, count]) => `${count}${label.slice(0, 4)}`)
      .join(',');
    out.push(
      `${C.dim}${pad(String(i + 1) + '.', 3)}${C.reset}${pad(name, 26)}${bar}${C.dim}${padL(String(r.count), 5)}${padL(String(r.authors), 5)}${C.reset}${velPad}${col(r.sentiment)}${padL(fmt(r.sentiment), 7)}${C.reset}  ${stance} ${verified}  ${C.dim}${doing || '–'}${C.reset}`,
    );
  });

  out.push(`${C.dim}${'─'.repeat(width)}${C.reset}`);
  out.push(`${C.dim}${snap.messagesInWindow ?? 0} msgs in ${snap.windowMinutes}m window · ✓ jev-confirmed topic, ~ uncertain · ${new Date(snap.generatedAt).toLocaleTimeString()}${C.reset}`);
  return out.join('\n');
}

async function loop() {
  if (AS_JSON) {
    console.log(JSON.stringify(await snapshot(), null, 2));
    return;
  }
  if (ONCE) {
    console.log(render(await snapshot()));
    return;
  }

  process.stdout.write('\x1b[?25l');
  const cleanup = () => {
    process.stdout.write('\x1b[?25h');
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  while (true) {
    try {
      const snap = await snapshot();
      process.stdout.write('\x1b[H\x1b[2J' + render(snap) + '\n');
    } catch (err) {
      process.stdout.write('\x1b[H\x1b[2J');
      console.log(`${C.red}error${C.reset} ${err.message}\n${C.dim}is the server running? npm start${C.reset}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

loop().catch((err) => {
  console.error(`${C.red}error${C.reset} ${err.message}`);
  process.exit(1);
});
