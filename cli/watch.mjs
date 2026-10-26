#!/usr/bin/env node
/**
 * Live sentiment monitor. Streams what the extension is capturing.
 *
 *   npm run watch
 *   npm run watch -- --channel "general"
 *   node cli/watch.mjs --digest          # one-shot summary, then exit
 *   node cli/watch.mjs --url http://127.0.0.1:8787
 */
const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

const BASE = (flag('url', process.env.SENTIMENT_URL || 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const CHANNEL = flag('channel', '');
const DIGEST_ONCE = has('digest');

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const COLORS = [C.cyan, C.magenta, C.blue, C.yellow, C.green, C.red];
const colorFor = (name) => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return COLORS[h % COLORS.length];
};

const fmt = (n) => (n >= 0 ? '+' : '') + Number(n).toFixed(2);
const spark = (values) => {
  const chars = '▁▂▃▄▅▆▇█';
  return values.map((v) => (v === null ? '·' : chars[Math.max(0, Math.min(7, Math.round(((v + 1) / 2) * 7)))])).join('');
};

const pad2 = (n) => String(n).padStart(2, '0');
const clock = (d = new Date()) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

function printMessage(m) {
  const name = (m.author || 'unknown').slice(0, 18).padEnd(18);
  const score = fmt(m.score || 0).padStart(6);
  const color = (m.score || 0) > 0.12 ? C.green : (m.score || 0) < -0.12 ? C.red : C.gray;
  const chan = CHANNEL ? '' : `${C.dim}#${(m.channel || '?').slice(0, 14)}${C.reset} `;
  const text = (m.text || '').replace(/\s+/g, ' ');
  console.log(
    `${C.dim}${clock(new Date(m.receivedAt || Date.now()))}${C.reset} ${color}${score}${C.reset} ${chan}${colorFor(m.author || '')}${name}${C.reset} ${text}`,
  );
}

function printStats(s, label = 'rolling') {
  if (!s || !s.count) return;
  const mean = Number(s.mean || 0);
  const color = mean > 0.12 ? C.green : mean < -0.12 ? C.red : C.gray;
  const arrow = s.trend > 0.08 ? `${C.green}↑${C.reset}` : s.trend < -0.08 ? `${C.red}↓${C.reset}` : `${C.dim}→${C.reset}`;
  const pct = (n) => `${Math.round((n / Math.max(1, s.count)) * 100)}%`;
  console.log(
    `\n${C.dim}─${C.reset} ${C.bold}${label}${C.reset} ${C.dim}${s.count} msgs${C.reset} ` +
      `${color}${fmt(mean)}${C.reset} ${arrow} ${C.dim}${s.perMin}/min · ${pct(s.positives)} pos / ${pct(s.negatives)} neg${C.reset}`,
  );
  if (s.spark?.length) console.log(`  ${C.dim}${spark(s.spark)}${C.reset}`);
  if (s.authors?.length) {
    console.log(`  ${s.authors.map((a) => `${colorFor(a.author)}${a.author}${C.reset}${C.dim}:${fmt(a.mean)}${C.reset}`).join('  ')}`);
  }
  console.log('');
}

async function showDigest() {
  const url = `${BASE}/digest${CHANNEL ? `?channel=${encodeURIComponent(CHANNEL)}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  console.log(text);
}

async function stream() {
  const url = `${BASE}/stream${CHANNEL ? `?channel=${encodeURIComponent(CHANNEL)}` : ''}`;
  const res = await fetch(url, { headers: { Accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`stream failed: HTTP ${res.status}`);

  console.log(`${C.bold}listening${C.reset} ${C.dim}${BASE}${C.reset}${CHANNEL ? ` ${C.dim}channel=${CHANNEL}${C.reset}` : ''}\n`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!chunk.trim() || chunk.startsWith(':')) continue;

      let event = 'message';
      const dataLines = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;

      let data;
      try { data = JSON.parse(dataLines.join('\n')); } catch { continue; }

      if (event === 'message') printMessage(data);
      else if (event === 'hello') printStats(data.stats, 'current window');
      else if (event === 'stats') printStats(data.stats, 'rolling 10m');
    }
  }
}

process.on('SIGINT', () => {
  console.log(`\n${C.dim}stopped${C.reset}`);
  process.exit(0);
});

try {
  if (DIGEST_ONCE) await showDigest();
  else await stream();
} catch (err) {
  console.error(`${C.red}error${C.reset} ${err.message}`);
  console.error(`${C.dim}is the server running?  npm start${C.reset}`);
  process.exit(1);
}
