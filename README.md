# Project Overview

## Goal

Save people time by instantly showing what a community or audience is actually talking about, whether they are complaining, praising, or asking questions. The tool works across live and static sources, including Discord, YouTube comments, livestream chats, and other feeds.

## How It Works

The system uses JEV to make fast decisions and analyze sentiment. Each message receives a sentiment score, and those scores are rolled up into an overall summary of what the chat is saying.

## Use Cases

### For Developers
- A daily digest summarizing community feedback.
- See what users like, dislike, and are asking for without reading every message.

### For Forex Traders
- Sentiment scores from trading communities and news chats can act as an additional confluence signal.
- Use alongside existing strategies, not as a standalone signal.

---

# Implementation

## Discord live sentiment + topics

**Current status:** the engine and the Discord live connector are built. YouTube comments, livestream chat and cross-source rollups are not wired yet — see [Roadmap](#roadmap).

A Chrome extension that watches the Discord conversation **you can already see** in your browser tab
and streams it to a local server. The server scores every message, then — the main objective —
works out **what is actually being talked about most**, and asks [LocalJev](#localjev) for the
judgement calls.

No bot token. No Discord API calls. No user-token scraping. It reads rendered text off the page,
the same pixels you're looking at.

```
Discord tab (DOM) ──> extension ──> localhost:8787 ──> topics + scores + digest
                                     │
                                     └──> LocalJev :8080  (is this a topic? which one is hottest? stance?)
```

### Quick start

```bash
cd sentiment
npm start            # server on http://127.0.0.1:8787
```

Load the extension once:

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → pick `sentiment/extension`
4. Go to `https://discord.com/channels/...` (the web app, not the desktop client)
5. Click the extension icon → the side panel opens

Then watch topics live:

```bash
npm run topics       # ranked board, refreshes every 2.5s
npm run watch        # raw message stream with per-message scores
npm run dev          # server + message stream together
```

LocalJev must be running (`http://127.0.0.1:8080`). If it isn't, everything still works — ranking
falls back to pure statistics and the board shows `jev offline`.

### Most talked about — the main objective

Two layers, because one is fast and dumb and the other is slow and opinionated:

**1. Statistics (instant, every message).** Extracts unigrams and bigrams per message, drops
stopwords/filler/emotion words, stems plurals, and counts:

- how many messages mention a phrase (`count`)
- how many distinct people (`authors`) — one person spamming is not "talked about"
- velocity — mentions in the last 5 min vs the 5 min before
- mean sentiment of the messages around it

**2. LocalJev (every ~12s, batched).** Makes the calls statistics cannot:

| Question | Type | Used for |
| --- | --- | --- |
| "If someone summarized this conversation in one sentence, would they mention *X*?" | `noul` × up to 8 | drops junk n-grams (threshold 0.4) and weights the ranking |
| "Which single subject is this conversation mostly about right now?" | `choice` | the `hot` line |
| "What kind of conversation is this?" | `choice` | `mode`: complaints / hype / help / debate / casual / news |
| "How do the people here feel about *X*?" | `choice` | per-topic stance, one topic per cycle, round-robin |

The summary-phrased question matters: asked "is X a real subject?", jev says yes to everything
(~0.9 for junk). Asked "would someone summarizing mention X?", the same model returns 0.95 for
`ranked mode` and 0.30 for `months` — that separation is what makes the filter work.

Ranking weight = `mentions × phrase-specificity × jev trust`. Verified topics float above raw
keyword noise; low-confidence phrases are dropped rather than shown.

```
$ npm run topics
Discord topics  all channels
jev online localjev-0.2 · 930ms · 2 cycles
────────────────────────────────────────────────────────────
#  topic                     volume               msgs  ppl    vel   sent  stance
1. ranked mode               ████████████████    5    3     +5   -0.17  negative 0.70 ✓
2. queue times               █████████████       4    4     +4   +0.36  –          ✓
3. new map                   █████████████       4    3     +4   +0.36  positive 0.90 ✓
4. emblem                    ██████████          3    3     +3   +0.28  –          ✓
5. rewards                   ██████████          3    2     +3   +0.39  –          ✓
6. matchmaking               ██████████          3    3     +3   -0.44  –          ✓
────────────────────────────────────────────────────────────
14 msgs in 30m window · ✓ jev-confirmed topic, ~ uncertain
```

Read that as: the server is arguing about **ranked mode** (5 messages, 3 people, negative), the
**new map** is well liked (+0.36, stance positive 0.90), and **matchmaking** is the sore point.

### LocalJev

[LocalJev](https://github.com/razorback16/openjev) is a local, Jev-compatible **decision** API —
not a chat API. You give it a `state` (the recent conversation) and typed questions, and it returns
calibrated probabilities. That's a good fit here: topic extraction and stance are classifications,
and probabilities are more useful than prose.

Config via env:

| Variable | Default | |
| --- | --- | --- |
| `JEV_URL` | `http://127.0.0.1:8080` | LocalJev base URL |
| `JEV_MODEL` | `localjev-latest` | model alias |
| `JEV_TIMEOUT_MS` | `30000` | per-decision timeout |
| `JEV_INTENT` | `1` | per-message intent (set `0` to skip jev and use the heuristic only) |
| `JEV_INTENT_BATCH` | `6` | messages per decision; grows toward `JEV_INTENT_BATCH_MAX` (10) |
| `JEV_INTENT_MAX_QUEUE` | `600` | pending cap; overflow is labelled heuristically and marked |
| `JEV_INTENT_RETRIES` | `3` | attempts per message before falling back |
| `JEV_INTENT_CACHE` | `4000` | identical-text cache entries |
| `JEV_INTENT_BATCH_MAX` | `10` | ceiling the adaptive batch grows toward |
| `JEV_INTENT_BACKOFF_MS` | `800` | first retry delay; doubles per consecutive failure |
| `JEV_INTENT_BACKOFF_CAP_MS` | `30000` | retry delay cap |

Check it from the server: `curl -s localhost:8787/jev`.

### What the chat is doing — intent

Every accepted message is classified by LocalJev into one of five labels:

| Label | Means | Example |
| --- | --- | --- |
| `question` | asks for information | "how do i reset my password" |
| `request` | wants a change or feature | "can we get a wipe already" |
| `complaint` | negative, reporting a problem | "ranked mode is completely broken" |
| `praise` | positive, thanking or complimenting | "thanks for the fast fix" |
| `neutral` | none of the above | "lol that was insane" |

Unlike the topic cycle (one decision every ~12s), intent runs **per message**:

- up to `JEV_INTENT_BATCH` messages share one `/v1/systemone` call (starts at 6, grows to 10);
- identical bodies are cached, so a channel saying "gg" all day costs one decision;
- ingest is never blocked — the message is broadcast first, intent arrives as an
  `update` event and the panel patches the row in place;
- if jev is down or rate-limited past `JEV_INTENT_RETRIES`, a heuristic label is applied and
  marked `intentSource: "heuristic"`, so model labels and best-effort labels are never mixed silently.

Intent is rolled up everywhere it matters:

- `/stats` → `intents: {question, request, complaint, praise, neutral}` for the window;
- `/topics` → each topic carries `intents` and `dominant` (e.g. 6 complaining, 2 asking);
- side panel → a chip per message, a "what they're doing" line, and a breakdown per topic;
- `/digest` → `· 2 complaint, 1 question` appended to each topic line.

### Message extraction

`extension/extract.js` turns a message row into independent fields — it never merges them:

```js
{
  id: "111-1002",
  author: "Blubbll",
  ts: "2026-10-26T18:32:26.000Z",
  content: "im not gonna tell a rando",        // body only
  replyTo: { author: "Copilot Guy", text: "how" }, // quote only
  edited: false, bot: false, reactions: 0, attachments: 0
}
```

Rules it enforces:

- **Content is read only from the content node** (`[id^="message-content-"]`, `[data-message-content]`,
  `[class*="messageContent"]`, and case variants). There is no fall back to the row's `textContent`.
- **The reply bar is a sibling, not a source.** It is matched by `[id^="message-reply-context"]`,
  `[class*="repliedMessage"]`, `[class*="replyBar"]`, `[class*="replyContext"]`,
  `[class*="reply-preview"]`. Its text goes to `replyTo.text` and nowhere else.
- **The content node is cloned and stripped** of reply previews, embeds, attachments, reactions,
  timestamps and edit markers before text is read. A content node nested *inside* the reply bar is
  rejected, not trusted.
- **Attachments only** → `content: "[attachment]"`. No body and no attachment → the row is dropped
  (system message / divider), never filled with the quote.
- **Dedupe by DOM id** (`chat-messages-<channel>-<id>`). Re-renders and MutationObserver re-fires are
  skipped; a changed body is sent as an update and the server replaces the row in place
  (`revision`, `edited: true`) instead of appending a second message.
- **Grouped messages inherit the author** from the nearest previous row that has a header.

Why this matters for topics: a quoted `how` used to become the body, so the replier was credited with
the quoted text and the phrase was counted twice. `content` is the only field the topic counter sees.

```bash
npm test   # 13 tests: normal, reply, reply-to-reply, attachment-only, duplicate, grouped
```

### What you get

**Side panel** — rolling sentiment, rate, trend, sparkline, mix, a "what they're doing" intent line,
then the topic board with the `hot` subject, conversation `mode` and a per-topic intent breakdown,
then the live scored feed with an intent chip on every message.

**On-page pill** (bottom right of Discord) — connection state, msgs/min, current score.

**Terminal** — `npm run topics` for the board, `npm run watch` for the message stream.

**Digest** — one block meant to be read by a human or an LLM:

```bash
curl -s "http://127.0.0.1:8787/digest"
curl -s "http://127.0.0.1:8787/digest?channel=Test%20Server::general&window=300000"
```

```
# Sentiment digest — Test Server #general
Window: last 10 min · 14 messages · 8 msg/min
Mean sentiment: +0.09 (neutral) · trend +0.48 warming ↑
Mix: 42% positive / 25% negative / 33% neutral

Most talked about (last 30 min):
  1. ranked mode ✓ — 5 msgs, 3 people, ↑5, sentiment -0.17, stance negative 0.70
  2. queue times ✓ — 4 msgs, 4 people, ↑4, sentiment +0.36
  3. new map ✓ — 4 msgs, 3 people, ↑4, sentiment +0.36, stance positive 0.90
Hot right now: ranked mode (jev 0.90)
Mode: complaints (jev 0.85)
```

Everything is appended to `data/transcript-YYYY-MM-DD.jsonl`, so history survives restarts and can
be re-analyzed later. Each line is a message, except late intent labels which land as
`{"type":"intent","id":…,"channelKey":…,"seq":…,"intent":…}` patches — apply them in order, or join
on `id` + `channelKey`.

### Sentiment scoring

`server/sentiment.mjs` — VADER-style lexicon tuned for chat register: ~440 weighted words including
Discord slang (`goated`, `mid`, `ratio`, `copium`, `cooked`, `cracked`), negation windows
(`not bad` → positive), boosters (`really good` > `good`), ALL CAPS and `!!!` amplification, unicode
emoji and `:shortcode:` weighting. Normalizes to `[-1, 1]`; ±0.12 is neutral.

Deliberately not an LLM: instant, free, offline, deterministic, no rate limits. Also shallow —
sarcasm and inversion are missed. The lexicon is reused by the topic extractor to keep feeling-words
(`cooked`, `garbage`) from being ranked as subjects.

### Endpoints

| Endpoint | What |
| --- | --- |
| `GET /` | status page |
| `GET /health` | uptime, counts, transcript path, jev status |
| `GET /topics?channel=&limit=` | ranked topics, hot subject, mode, jev stats |
| `GET /jev` | LocalJev health + cycle telemetry |
| `GET /digest?channel=&window=` | LLM-friendly summary (topics + sentiment + intent) |
| `GET /intents` | classifier queue, latency, cache and fallback counters |
| `POST /ingest` | what the extension posts: `{context, messages[]}` |
| `GET /stream` | SSE: `hello`, `message`, `update` (edits + late intent), `stats` |
| `GET /feed?since=&limit=&channel=` | backfill |
| `GET /stats?channel=&window=` | sentiment aggregate |
| `GET /transcript?format=txt\|jsonl` | full buffer |
| `POST /clear` | wipe buffers; drops pending intent work |

### Limits, honestly

- **Only what's on screen.** The extension scrapes rendered messages. Messages that scroll out of the
  virtualized list before they're observed are missed; a channel you never open is never sampled.
- **DOM drift.** Discord ships obfuscated class names. Selectors lean on stable hooks
  (`li[id^="chat-messages-"]`, `[id^="message-content-"]`, `time[datetime]`) plus fallbacks, but a big
  redesign can break extraction. Symptom: side panel connected, no messages.
- **Topic extraction is an approximation.** No POS tagger: unigrams and bigrams with stopword and
  emotion-word filtering. Junk phrases that repeat (`single game`) can still surface, and synonyms
  (`old maps` vs `new map`) are kept separate unless one is a substring of the other.
- **Intent is per message, but jev is not infinitely fast.** Throughput is roughly 6–8 messages per
  1–1.5s decision on this machine. Bursts queue; past `JEV_INTENT_MAX_QUEUE` the overflow gets a
  heuristic label (marked `heuristic`, so you can tell). A 429 from the backend halves the batch and
  backs off exponentially.
- **Jev cycles are throttled.** One batched topic decision per ~12s on the busiest channel, plus the
  per-message intent queue. If jev is down, rankings degrade to statistics-only (still useful) and
  intent falls back to heuristics; both resume automatically.
- **Personal use only.** It reads your own view of a chat you're in.
- Chrome shows `server offline` in the pill until `npm start` is running. The content script queues
  up to 3000 messages and retries.

### Files

```
extension/
  manifest.json        MV3, side panel, localhost host permission
  extract.js           message parser (fields, reply separation, dedupe store)
  content.js           DOM wiring, MutationObserver, on-page pill, retry queue
  background.js        relays batches to the server, sets the badge
  sidepanel.html/css/js  live dashboard (sentiment + topic board)
server/
  index.mjs            ingest, SSE, stats, topics, digest, JSONL transcript
  sentiment.mjs        lexicon scorer
  topics.mjs           candidate extraction, ranking, jev adjudication cycle
  intent.mjs           per-message jev intent classifier (batch, cache, fallback)
  jev.mjs              LocalJev /v1/systemone client (queued, timed out)
cli/
  topics.mjs           ranked topic board
  watch.mjs            live message stream / --digest
scripts/dev.mjs        server + watcher together
test/
  extract.test.mjs     parser fixtures (reply/attachment/duplicate/grouped)
  topics.test.mjs      edit-in-place and reply-exclusion guarantees
  intent.test.mjs      batching, cache, 429 fallback, queue overflow
data/                  transcript-YYYY-MM-DD.jsonl
```

## Roadmap

The goal is multi-source. The engine is source-agnostic; the reach is not yet.

1. **Source identity + static timestamps.** `source::community::channel`, and windows computed from
   each message's own `ts` so a historical comment import does not land "now".
2. **YouTube comments** — static backfill plus live polling, same ingest contract.
3. **Livestream chat** — YouTube Live / Twitch / Kick connector.
4. **Cross-source topics** — aggregate the same phrase across Discord, comments and chat.
5. **Scheduled daily digest** — the developer use case, delivered instead of curled.
6. **Trading register** — extend the lexicon (hawkish, dump, rug, liquidation, risk-off), add a time
   series and a multi-source watchlist for the confluence use case.
