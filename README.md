# Discord live sentiment + topics

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

## Quick start

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

## Most talked about — the main objective

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

## LocalJev

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

Check it from the server: `curl -s localhost:8787/jev`.

## What you get

**Side panel** — rolling sentiment, rate, trend, sparkline, mix, then the topic board with the
`hot` subject and conversation `mode`, then the live scored feed.

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
be re-analyzed later.

## Sentiment scoring

`server/sentiment.mjs` — VADER-style lexicon tuned for chat register: ~440 weighted words including
Discord slang (`goated`, `mid`, `ratio`, `copium`, `cooked`, `cracked`), negation windows
(`not bad` → positive), boosters (`really good` > `good`), ALL CAPS and `!!!` amplification, unicode
emoji and `:shortcode:` weighting. Normalizes to `[-1, 1]`; ±0.12 is neutral.

Deliberately not an LLM: instant, free, offline, deterministic, no rate limits. Also shallow —
sarcasm and inversion are missed. The lexicon is reused by the topic extractor to keep feeling-words
(`cooked`, `garbage`) from being ranked as subjects.

## Endpoints

| Endpoint | What |
| --- | --- |
| `GET /` | status page |
| `GET /health` | uptime, counts, transcript path, jev status |
| `GET /topics?channel=&limit=` | ranked topics, hot subject, mode, jev stats |
| `GET /jev` | LocalJev health + cycle telemetry |
| `GET /digest?channel=&window=` | LLM-friendly summary (topics + sentiment) |
| `POST /ingest` | what the extension posts: `{context, messages[]}` |
| `GET /stream` | SSE: `hello`, `message`, `stats` |
| `GET /feed?since=&limit=&channel=` | backfill |
| `GET /stats?channel=&window=` | sentiment aggregate |
| `GET /transcript?format=txt\|jsonl` | full buffer |
| `POST /clear` | wipe buffers |

## Limits, honestly

- **Only what's on screen.** The extension scrapes rendered messages. Messages that scroll out of the
  virtualized list before they're observed are missed; a channel you never open is never sampled.
- **DOM drift.** Discord ships obfuscated class names. Selectors lean on stable hooks
  (`li[id^="chat-messages-"]`, `[id^="message-content-"]`, `time[datetime]`) plus fallbacks, but a big
  redesign can break extraction. Symptom: side panel connected, no messages.
- **Topic extraction is an approximation.** No POS tagger: unigrams and bigrams with stopword and
  emotion-word filtering. Junk phrases that repeat (`single game`) can still surface, and synonyms
  (`old maps` vs `new map`) are kept separate unless one is a substring of the other.
- **Jev cycles are throttled.** One batched decision per ~12s per busiest channel, with backoff to
  60s on failure. On a busy server you get a near-real-time view, not per-message labelling.
- **Jev is a 26B model, ~1s per batch here.** If it's down, rankings degrade to statistics-only
  (still useful) and resume automatically.
- **Personal use only.** It reads your own view of a chat you're in.
- Chrome shows `server offline` in the pill until `npm start` is running. The content script queues
  up to 3000 messages and retries.

## Files

```
extension/
  manifest.json        MV3, side panel, localhost host permission
  content.js           DOM scraper + MutationObserver + on-page pill + retry queue
  background.js        relays batches to the server, sets the badge
  sidepanel.html/css/js  live dashboard (sentiment + topic board)
server/
  index.mjs            ingest, SSE, stats, topics, digest, JSONL transcript
  sentiment.mjs        lexicon scorer
  topics.mjs           candidate extraction, ranking, jev adjudication cycle
  jev.mjs              LocalJev /v1/systemone client (queued, timed out)
cli/
  topics.mjs           ranked topic board
  watch.mjs            live message stream / --digest
scripts/dev.mjs        server + watcher together
data/                  transcript-YYYY-MM-DD.jsonl
```
