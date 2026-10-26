import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { score } from './sentiment.mjs';
import { JevClient } from './jev.mjs';
import { TopicEngine } from './topics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const RING_SIZE = 8000;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

/** @type {Array<object>} */
const ring = [];
const seen = new Set();
const sseClients = new Set();
let seq = 0;
const startedAt = Date.now();
let lastContext = null;

const jev = new JevClient();
const topics = new TopicEngine({
  jev,
  cycleMs: Math.max(3000, Number(process.env.JEV_CYCLE_MS || 12000)),
});
topics.start();

await fs.mkdir(DATA_DIR, { recursive: true });

const pad = (n) => String(n).padStart(2, '0');
function dayStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let transcriptPath = path.join(DATA_DIR, `transcript-${dayStamp()}.jsonl`);
let writeChain = Promise.resolve();

function persist(msg) {
  writeChain = writeChain
    .then(async () => {
      const nextPath = path.join(DATA_DIR, `transcript-${dayStamp()}.jsonl`);
      if (nextPath !== transcriptPath) transcriptPath = nextPath;
      await fs.appendFile(transcriptPath, JSON.stringify(msg) + '\n', 'utf8');
    })
    .catch((err) => console.error('[persist]', err.message));
  return writeChain;
}

function keyOf(m) {
  return `${m.channelKey || 'unknown'}|${m.id || `${m.author}:${m.ts}:${m.text.slice(0, 40)}`}`;
}

function remember(m) {
  ring.push(m);
  if (ring.length > RING_SIZE) {
    const drop = ring.shift();
    if (drop) seen.delete(keyOf(drop));
  }
}

function windowList(channelKey, windowMs = DEFAULT_WINDOW_MS) {
  const cutoff = Date.now() - windowMs;
  return ring.filter((m) => (!channelKey || m.channelKey === channelKey) && m.receivedAt >= cutoff);
}

function computeStats(list, windowMs = DEFAULT_WINDOW_MS) {
  if (!list.length) {
    return {
      count: 0, mean: 0, label: 'neutral', positives: 0, negatives: 0, neutrals: 0,
      perMin: 0, trend: 0, spark: [], authors: [], extremes: { positive: [], negative: [] },
      windowMinutes: Math.round(windowMs / 60000),
    };
  }
  const values = list.map((m) => m.score ?? 0);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / list.length;
  const positives = values.filter((v) => v > 0.12).length;
  const negatives = values.filter((v) => v < -0.12).length;
  const spanMs = Math.max(60_000, Date.now() - list[0].receivedAt);
  const perMin = Math.round((list.length / (Math.min(windowMs, spanMs) / 60000)) * 10) / 10;

  // sparkline: 24 buckets. Time buckets when the data spans the window,
  // otherwise index buckets so a fresh burst still renders a shape.
  const buckets = 24;
  const now = Date.now();
  const spark = Array.from({ length: buckets }, () => null);
  const span = Math.max(1, list[list.length - 1].receivedAt - list[0].receivedAt);
  const byIndex = span < windowMs / 3;
  for (let i = 0; i < list.length; i++) {
    const idx = byIndex
      ? Math.min(buckets - 1, Math.max(0, buckets - list.length + i))
      : Math.min(buckets - 1, Math.max(0, Math.floor(((list[i].receivedAt - (now - windowMs)) / windowMs) * buckets)));
    const b = (spark[idx] ?? { sum: 0, n: 0 });
    b.sum += values[i];
    b.n += 1;
    spark[idx] = b;
  }
  const sparkLine = spark.map((b) => (b && b.n ? Math.round((b.sum / b.n) * 100) / 100 : null));

  const third = Math.max(1, Math.floor(list.length / 3));
  const early = values.slice(0, third);
  const late = values.slice(-third);
  const trend = Math.round((avg(late) - avg(early)) * 100) / 100;

  const byAuthor = new Map();
  for (const m of list) {
    const a = byAuthor.get(m.author) ?? { author: m.author, count: 0, sum: 0 };
    a.count += 1;
    a.sum += m.score ?? 0;
    byAuthor.set(m.author, a);
  }
  const authors = [...byAuthor.values()]
    .map((a) => ({ author: a.author, count: a.count, mean: Math.round((a.sum / a.count) * 100) / 100 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const scored = list.filter((m) => Math.abs(m.score ?? 0) > 0.35);
  const extremes = {
    positive: scored.filter((m) => m.score > 0).sort((a, b) => b.score - a.score).slice(0, 3)
      .map((m) => ({ author: m.author, score: m.score, text: m.text.slice(0, 160) })),
    negative: scored.filter((m) => m.score < 0).sort((a, b) => a.score - b.score).slice(0, 3)
      .map((m) => ({ author: m.author, score: m.score, text: m.text.slice(0, 160) })),
  };

  return {
    count: list.length,
    mean: Math.round(mean * 1000) / 1000,
    label: mean > 0.12 ? 'positive' : mean < -0.12 ? 'negative' : 'neutral',
    positives, negatives, neutrals: list.length - positives - negatives,
    perMin, trend, spark: sparkLine, authors, extremes,
    windowMinutes: Math.round(windowMs / 60000),
  };
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function ingestBatch(messages, context) {
  if (context && context.channelKey) lastContext = context;
  let accepted = 0;
  let skipped = 0;
  const added = [];

  for (const raw of messages) {
    if (!raw || typeof raw.text !== 'string') { skipped++; continue; }
    const text = raw.text.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    if (!text) { skipped++; continue; }

    const ctx = raw.channelKey ? raw : { ...(lastContext || {}), ...raw };
    const message = {
      id: String(raw.id || '').slice(0, 120),
      author: String(raw.author || 'unknown').slice(0, 80),
      text,
      ts: raw.ts || new Date().toISOString(),
      receivedAt: Date.now(),
      channel: ctx.channel || '',
      guild: ctx.guild || '',
      channelKey: ctx.channelKey || `${ctx.guild || 'discord'}::${ctx.channel || 'unknown'}`,
      url: ctx.url || '',
      edited: Boolean(raw.edited),
      backfill: Boolean(raw.backfill),
      bot: Boolean(raw.bot),
      replyTo: raw.replyTo ? String(raw.replyTo).slice(0, 200) : '',
      reactions: Number(raw.reactions || 0),
      attachments: Number(raw.attachments || 0),
      seq: 0,
    };

    const key = keyOf(message);
    if (seen.has(key)) { skipped++; continue; }

    const s = score(message.text);
    message.score = s.score;
    message.label = s.label;
    message.magnitude = s.magnitude;
    message.seq = ++seq;

    seen.add(key);
    remember(message);
    topics.observe(message);
    persist(message);
    added.push(message);
    accepted++;
  }

  for (const m of added) broadcast('message', m);
  if (accepted) {
    const stats = computeStats(windowList(lastContext?.channelKey, DEFAULT_WINDOW_MS));
    broadcast('stats', { channelKey: lastContext?.channelKey || null, stats });
  }

  return { accepted, skipped, added };
}

function digest(channelKey, windowMs) {
  const list = windowList(channelKey, windowMs);
  const stats = computeStats(list, windowMs);
  const ctx = list.at(-1) || (lastContext && lastContext.channelKey === channelKey ? lastContext : null);
  const header = ctx
    ? `${ctx.guild ? `${ctx.guild} ` : ''}#${ctx.channel || 'unknown'}`
    : channelKey || 'all channels';

  if (!stats.count) {
    return `# Sentiment digest — ${header}\nNo messages in the last ${stats.windowMinutes} min.\n`;
  }

  const pct = (n) => `${Math.round((n / stats.count) * 100)}%`;
  const fmt = (n) => (n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2));
  const arrow = stats.trend > 0.08 ? 'warming ↑' : stats.trend < -0.08 ? 'cooling ↓' : 'flat →';

  const lines = [];
  lines.push(`# Sentiment digest — ${header}`);
  lines.push(
    `Window: last ${stats.windowMinutes} min · ${stats.count} messages · ${stats.perMin} msg/min`,
  );
  lines.push(
    `Mean sentiment: ${fmt(stats.mean)} (${stats.label}) · trend ${fmt(stats.trend)} ${arrow}`,
  );
  lines.push(
    `Mix: ${pct(stats.positives)} positive / ${pct(stats.negatives)} negative / ${pct(stats.neutrals)} neutral`,
  );
  lines.push(
    `Spark: ${stats.spark.map((v) => (v === null ? '·' : v.toFixed(1))).join(' ')}`,
  );

  const topicBlock = topics.digestSection(channelKey);
  if (topicBlock) {
    lines.push('');
    lines.push(topicBlock);
    lines.push('');
  }

  if (stats.authors.length) {
    lines.push(`Voices: ${stats.authors.map((a) => `${a.author} ${fmt(a.mean)} (${a.count})`).join(', ')}`);
  }
  if (stats.extremes.positive.length) {
    lines.push('Most positive:');
    for (const e of stats.extremes.positive) lines.push(`  ${fmt(e.score)} ${e.author}: "${e.text}"`);
  }
  if (stats.extremes.negative.length) {
    lines.push('Most negative:');
    for (const e of stats.extremes.negative) lines.push(`  ${fmt(e.score)} ${e.author}: "${e.text}"`);
  }
  const recent = list.slice(-12);
  lines.push('Recent:');
  for (const m of recent) lines.push(`  ${fmt(m.score)} ${m.author}: ${m.text.slice(0, 140)}`);
  return lines.join('\n') + '\n';
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (route === '/health') {
      return json(res, 200, {
        ok: true,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        messages: ring.length,
        channels: [...new Set(ring.map((m) => m.channelKey))],
        streamClients: sseClients.size,
        transcript: transcriptPath,
        jev: jev.status(),
      });
    }

    if (route === '/ingest' && req.method === 'POST') {
      const body = await readBody(req);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (!messages.length) return json(res, 200, { ok: true, accepted: 0, skipped: 0, stats: computeStats(windowList(body.context?.channelKey)) });
      const result = ingestBatch(messages, body.context);
      const stats = computeStats(windowList(body.context?.channelKey));
      return json(res, 200, { ok: true, ...result, added: undefined, stats });
    }

    if (route === '/feed' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      const limit = Math.min(1000, Number(url.searchParams.get('limit') || 200));
      const channelKey = url.searchParams.get('channel');
      const list = ring.filter((m) => m.seq > since && (!channelKey || m.channelKey === channelKey)).slice(-limit);
      return json(res, 200, { messages: list, lastSeq: seq });
    }

    if (route === '/topics' && req.method === 'GET') {
      const channelKey = url.searchParams.get('channel') || null;
      const limit = Math.min(40, Number(url.searchParams.get('limit') || 12));
      return json(res, 200, { ok: true, ...topics.snapshot(channelKey, { limit }) });
    }

    if (route === '/jev' && req.method === 'GET') {
      const health = await jev.health();
      return json(res, 200, {
        ok: true,
        health,
        ...jev.status(),
        topics: {
          running: topics.running,
          cycles: topics.cycles,
          lastCycleAt: topics.lastCycleAt,
          lastCycleMs: topics.lastCycleMs,
          backoffUntil: topics.backoffUntil ? new Date(topics.backoffUntil).toISOString() : null,
          channels: [...topics.channels.keys()],
        },
      });
    }

    if (route === '/stats' && req.method === 'GET') {
      const channelKey = url.searchParams.get('channel') || undefined;
      const windowMs = Math.max(60_000, Number(url.searchParams.get('window') || DEFAULT_WINDOW_MS));
      return json(res, 200, { channelKey: channelKey || null, stats: computeStats(windowList(channelKey, windowMs), windowMs) });
    }

    if (route === '/digest' && req.method === 'GET') {
      const channelKey = url.searchParams.get('channel') || undefined;
      const windowMs = Math.max(60_000, Number(url.searchParams.get('window') || DEFAULT_WINDOW_MS));
      const text = digest(channelKey, windowMs);
      if (url.searchParams.get('format') === 'json') {
        return json(res, 200, { text, stats: computeStats(windowList(channelKey, windowMs), windowMs) });
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(text);
    }

    if (route === '/transcript' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      const list = ring.filter((m) => m.seq > since);
      if (url.searchParams.get('format') === 'jsonl') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
        return res.end(list.map((m) => JSON.stringify(m)).join('\n') + '\n');
      }
      const text = list
        .map((m) => `${new Date(m.receivedAt).toISOString().slice(11, 19)} ${m.score >= 0 ? '+' : ''}${m.score.toFixed(2)} ${m.author}: ${m.text}`)
        .join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(text + '\n');
    }

    if (route === '/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 1500\n\n`);
      const channelKey = url.searchParams.get('channel') || undefined;
      const hello = { lastSeq: seq, stats: computeStats(windowList(channelKey)) };
      res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
      sseClients.add(res);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
      req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
      return;
    }

    if (route === '/clear' && req.method === 'POST') {
      ring.length = 0;
      seen.clear();
      topics.channels.clear();
      return json(res, 200, { ok: true });
    }

    if (route === '/') {
      const stats = computeStats(windowList(undefined));
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Discord sentiment</title>
<style>body{font:14px ui-sans-serif,system-ui;background:#0d0f13;color:#e6e8ee;padding:32px;max-width:720px;margin:0 auto}
code{background:#1a1e26;padding:2px 6px;border-radius:4px}.big{font-size:48px;font-weight:700}
.p{color:#4ade80}.n{color:#f87171}.muted{color:#8b93a5}</style></head><body>
<h1>Discord live sentiment</h1>
<div class="big ${stats.mean >= 0 ? 'p' : 'n'}">${stats.mean >= 0 ? '+' : ''}${stats.mean.toFixed(2)}</div>
<p class="muted">${stats.count} messages · ${stats.perMin}/min · ${stats.positives} pos / ${stats.negatives} neg</p>
<p class="muted">Endpoints: <code>/stream</code> <code>/feed</code> <code>/stats</code> <code>/digest</code> <code>/transcript</code></p>
<p class="muted">Transcript file: <code>${transcriptPath}</code></p>
</body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    json(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    json(res, 400, { ok: false, error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Discord live sentiment server`);
  console.log(`  http://${HOST}:${PORT}   (dashboard: /   digest: /digest)`);
  console.log(`  topics -> http://${HOST}:${PORT}/topics   jev -> ${jev.base}`);
  console.log(`  transcript -> ${path.join(DATA_DIR, `transcript-${dayStamp()}.jsonl`)}`);
  console.log(`  waiting for extension…\n`);
});
