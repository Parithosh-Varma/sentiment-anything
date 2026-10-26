/**
 * "Most talked about" tracking.
 *
 * Division of labour:
 *   - statistics  -> what words/phrases keep appearing and who keeps saying them
 *   - LocalJev    -> the judgement calls: is this a real topic or a passing word,
 *                    which one is hottest right now, and what's the stance on it
 *
 * Jev is slow-ish (~1s) and capacity-limited, so it runs on a timer against a
 * window of messages, never inline with ingest. If it's down, ranking still works.
 */

import { isEmotionWord } from './sentiment.mjs';

const WINDOW_MS = 30 * 60 * 1000;
const CYCLE_MS = 12_000;
const VERDICT_TTL = 10 * 60 * 1000;
const STANCE_TTL = 5 * 60 * 1000;

// Adjectives/size words: fine as a qualifier ("new map"), never as a topic head.
const QUALIFIER = new Set(
  `new old big small huge whole entire actual real same different another first last next other single top bottom main random entire`
    .split(/\s+/),
);

// Generic nouns: fine as the tail of a phrase ("queue times"), never the head.
const NOUN_GENERIC = new Set(
  `mode game map time character level server servers thing things stuff way ways lot lots bit part parts side point reason update patch version build`
    .split(/\s+/),
);

const GENERIC = new Set([...QUALIFIER, ...NOUN_GENERIC,
  'please', 'sorry', 'thanks', 'hey', 'hello', 'hi', 'yea', 'yes', 'no', 'maybe', 'sure', 'okay', 'ok',
  'now', 'later', 'soon', 'again', 'still', 'also', 'just', 'even', 'very', 'really', 'quite', 'rather',
  'pretty', 'fairly', 'enough', 'more', 'most', 'less', 'least', 'few', 'many', 'some', 'any', 'all',
  'every', 'each', 'both', 'either', 'neither']);

const STOP = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves
im ive id ill youre theyre doesnt dont didnt isnt wasnt werent couldnt wouldnt shouldnt cant wont aint gotta wanna gonna kinda sorta lemme gimme dunno
lol lmao lmfao haha hahaha hehe yeah yep yup nah nope ok okay sure still even just really actually literally honestly basically pretty quite tbh ngl imo ima bruh bro dude man guys yall u ur r n b c k thx ty pls plz omg wtf wth smh rn fr ong istg wdym lowkey highkey deadass bc cuz cause tho thru til till abt yooo yoo yea
one two three four five six seven eight nine ten min mins sec secs hr hrs am pm ppl
get got gets getting go goes going went gone make makes made making say says said see seen saw look looks looking know knows knew think thinks thought want wants wanted need needs needed use uses used using take takes took put puts give gives gave come comes came lie lied lies
feel feels felt compare compared revert main maining seem seems seemed mean means meant play plays played playing try tries trying wait waits waiting keep keeps kept happen happens happening turn turns move moves hit hits pick picks
thing things stuff way ways lot lots bit much many more most some any all every each other others else
today tonight yesterday tomorrow now later soon single month months week weeks year years day days
people person someone anyone everyone nobody anybody somebody guy guys girl girls boy boys
message messages chat chats channel channels discord edit edited
also said like just maybe probably definitely obviously apparently
`.split(/\s+/),
);

const PLURAL_EXCEPTIONS = new Set(['news', 'series', 'always', 'less', 'css', 'sms', 'gas', 'this', 'was', 'has', 'does', 'besides', 'yes']);

const ALLOW_INSIDE = new Set(['of', 'the', 'and', 'vs', 'x', 'in', 'de', 'la']);

const MODE_CRITERIA = {
  hype: 'Excitement, praise, celebration',
  complaints: 'Complaints, frustration, disappointment',
  help: 'Questions, troubleshooting, asking for help',
  debate: 'Disagreement, argument, strong opposing views',
  casual: 'Casual chatter, jokes, memes',
  news: 'Announcements, news, updates',
};

const STANCE_CRITERIA = {
  positive: 'Participants like it or speak well of it',
  negative: 'Participants dislike it or complain about it',
  mixed: 'Opinions are divided, both praise and criticism',
  neutral: 'Mentioned factually, no real feelings either way',
};

// --------------------------------------------------------------------- words
function stem(word) {
  if (word.length <= 3 || PLURAL_EXCEPTIONS.has(word)) return word;
  if (word.endsWith("'s")) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
  return word;
}

function cleanText(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/<a?:\w+:\d+>/g, ' ')
    .replace(/@[\w._-]+/g, ' ')
    .replace(/#[\w-]+/g, ' ')
    .replace(/:\w{2,32}:/g, ' ')
    .replace(/[\u200b-\u200d]/g, ' ');
}

/** key -> display string, for one message. Unigrams and bigrams only. */
function candidatesFrom(text) {
  const out = new Map();
  const add = (key, display) => {
    if (!key || key.length < 3 || key.length > 48) return;
    const existing = out.get(key);
    if (!existing || display.length > existing.length) out.set(key, display);
  };

  for (const clause of cleanText(text).split(/[.!?;\n,()\[\]"“”]+/)) {
    const parts = clause.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || [];
    const toks = [];
    for (const raw of parts) {
      const bare = raw.replace(/['’]s$/i, '').replace(/^[-']+|[-']+$/g, '');
      if (!bare) continue;
      const lower = bare.toLowerCase();
      if (STOP.has(lower) || /^\d+$/.test(lower)) continue;
      if (lower.length < 2) continue;
      toks.push({ w: stem(lower), raw: lower, display: bare, cap: /^[A-Z]/.test(bare) });
    }

    for (let i = 0; i < toks.length; i++) {
      const a = toks[i];
      const aDisplay = a.cap ? a.display : a.raw;
      if (!GENERIC.has(a.w) && !isEmotionWord(a.w)) add(a.w, aDisplay);

      const b = toks[i + 1];
      if (b && !isEmotionWord(a.w) && !isEmotionWord(b.w) && !NOUN_GENERIC.has(a.w) && !QUALIFIER.has(b.w)) {
        add(`${a.w} ${b.w}`, `${aDisplay} ${b.cap ? b.display : b.raw}`);
      }
    }
  }

  return out;
}

// ------------------------------------------------------------------- engine
export class TopicEngine {
  constructor({ jev, cycleMs = CYCLE_MS, windowMs = WINDOW_MS, logger = console } = {}) {
    this.jev = jev;
    this.cycleMs = cycleMs;
    this.windowMs = windowMs;
    this.log = logger;
    this.channels = new Map();
    this.timer = null;
    this.running = false;
    this.backoffUntil = 0;
    this.fails = 0;
    this.lastCycleAt = null;
    this.lastCycleMs = null;
    this.cycles = 0;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.cycle().catch((err) => this.log.error?.('[topics] cycle', err.message));
    }, this.cycleMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  channel(key) {
    let ch = this.channels.get(key);
    if (!ch) {
      ch = {
        key,
        topics: new Map(),
        recent: [],
        dirty: false,
        seen: 0,
        lastMsgAt: 0,
        hot: null,
        mode: null,
        jevAt: null,
      };
      this.channels.set(key, ch);
    }
    return ch;
  }

  /**
   * @param {object} msg  a scored message ({id, channelKey, text, author, score, receivedAt})
   * @param {{replace?: boolean}} opts  replace=true re-indexes an edited/re-rendered message
   */
  observe(msg, { replace = false } = {}) {
    if (!msg || !msg.channelKey || !msg.text) return;
    const ch = this.channel(msg.channelKey);
    const key = msg.id || `seq:${msg.seq}`;
    const at = msg.receivedAt || Date.now();

    ch.dirty = true;
    ch.lastMsgAt = at;
    if (!replace) ch.seen++;

    // keep the raw window consistent; edits must not create a second entry
    const recentIdx = replace ? ch.recent.findIndex((m) => m.id === key) : -1;
    const recentEntry = { id: key, author: msg.author, text: msg.text, at };
    if (recentIdx >= 0) ch.recent[recentIdx] = recentEntry;
    else ch.recent.push(recentEntry);
    if (ch.recent.length > 300) ch.recent.splice(0, ch.recent.length - 300);

    const candidates = candidatesFrom(msg.text);

    // an edited message may no longer mention a topic it used to count toward
    if (replace) {
      for (const [topicKey, topic] of ch.topics) {
        if (!topic.ids.has(key) || candidates.has(topicKey)) continue;
        topic.ids.delete(key);
        topic.events = topic.events.filter((e) => e.id !== key);
      }
    }

    for (const [topicKey, display] of candidates) {
      let topic = ch.topics.get(topicKey);
      if (!topic) {
        topic = { key: topicKey, displays: new Map(), events: [], ids: new Set(), jev: null, stance: null };
        ch.topics.set(topicKey, topic);
      }

      if (topic.ids.has(key)) {
        if (replace) {
          const ev = topic.events.find((e) => e.id === key);
          if (ev) {
            ev.text = msg.text;
            ev.score = msg.score || 0;
            ev.author = msg.author;
            ev.t = at;
            ev.intent = msg.intent || null;
            ev.intentProb = msg.intentProb || 0;
          }
        }
        continue;
      }

      topic.ids.add(key);
      topic.displays.set(display, (topic.displays.get(display) || 0) + 1);
      topic.events.push({
        id: key,
        t: at,
        author: msg.author,
        score: msg.score || 0,
        text: msg.text,
        seq: msg.seq,
        intent: msg.intent || null,
        intentProb: msg.intentProb || 0,
      });
    }
  }

  /**
   * Attach a late-arriving jev intent to every topic this message contributed to.
   * No re-indexing and no counting changes — just relabeling.
   */
  setIntent(msg) {
    if (!msg || !msg.channelKey || !msg.id) return;
    const ch = this.channels.get(msg.channelKey);
    if (!ch) return;
    for (const topic of ch.topics.values()) {
      if (!topic.ids.has(msg.id)) continue;
      for (const ev of topic.events) {
        if (ev.id !== msg.id) continue;
        ev.intent = msg.intent || null;
        ev.intentProb = msg.intentProb || 0;
      }
    }
  }

  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const ch of this.channels.values()) {
      for (const [key, topic] of ch.topics) {
        if (!topic.events.length) continue;
        if (topic.events[topic.events.length - 1].t < cutoff) {
          ch.topics.delete(key);
          continue;
        }
        topic.events = topic.events.filter((e) => e.t >= cutoff);
        if (topic.events.length < 2) {
          topic.ids = new Set(topic.events.map((e) => e.id));
        }
      }
      ch.recent = ch.recent.filter((m) => m.at >= cutoff).slice(-300);
    }
  }

  displayOf(topic) {
    let best = topic.key;
    let bestCount = -1;
    for (const [display, count] of topic.displays) {
      if (count > bestCount || (count === bestCount && display.length > best.length)) {
        best = display;
        bestCount = count;
      }
    }
    return best;
  }

  /** Internal rows sorted by volume, with redundant phrases folded. */
  rank(channelKey, { minCount = 2, limit = 24, now = Date.now() } = {}) {
    const ch = this.channels.get(channelKey);
    if (!ch) return [];

    const rows = [];
    for (const topic of ch.topics.values()) {
      const events = topic.events;
      if (events.length < minCount) continue;
      if (topic.jev && topic.jev.isTopic < 0.4) continue;

      const authors = new Map();
      const intents = { question: 0, request: 0, complaint: 0, praise: 0, neutral: 0 };
      let sum = 0;
      let recent = 0;
      let prior = 0;
      const fiveMin = now - 5 * 60 * 1000;
      const tenMin = now - 10 * 60 * 1000;
      for (const e of events) {
        authors.set(e.author, (authors.get(e.author) || 0) + 1);
        if (e.intent && intents[e.intent] != null) intents[e.intent]++;
        sum += e.score;
        if (e.t >= fiveMin) recent++;
        else if (e.t >= tenMin) prior++;
      }

      const words = topic.key.split(' ').length;
      // one-word topics need corroboration, two-word phrases are self-evidencing
      if (words === 1 && authors.size < 2 && events.length < 4) continue;

      rows.push({
        key: topic.key,
        display: this.displayOf(topic),
        count: events.length,
        words,
        weight:
          events.length *
          (1 + 0.3 * (words - 1)) *
          (topic.jev ? 0.35 + 0.65 * Math.max(0, Math.min(1, topic.jev.isTopic)) : 0.8),
        authors: authors.size,
        topAuthor: [...authors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '',
        sentiment: Math.round((sum / events.length) * 1000) / 1000,
        velocity: recent - prior,
        recent,
        lastAt: events[events.length - 1].t,
        intents,
        dominant: dominantIntent(intents),
        jev: topic.jev,
        stance: topic.stance,
        samples: events.slice(-2).map((e) => `${e.author}: ${e.text.slice(0, 140)}`),
        _topic: topic,
      });
    }

    rows.sort((a, b) => b.weight - a.weight || b.authors - a.authors || b.recent - a.recent);

    // "ranked" vs "ranked mode": when they describe the same thing, keep one row
    // and label it with the more specific phrase.
    const kept = [];
    for (const row of rows) {
      const host = kept.find(
        (k) =>
          k.key !== row.key &&
          k.count >= row.count * 0.6 &&
          (k.key.includes(row.key) || row.key.includes(k.key)),
      );
      if (host) {
        if (row.words > host.words && row.count >= host.count * 0.6) {
          host.display = row.display;
          host.key = row.key;
          host.words = row.words;
        }
        continue;
      }
      kept.push(row);
    }

    return kept.slice(0, limit);
  }

  rankAll(opts = {}) {
    const merged = new Map();
    for (const key of this.channels.keys()) {
      for (const row of this.rank(key, opts)) {
        const prev = merged.get(row.key);
        if (!prev) {
          merged.set(row.key, { ...row });
        } else {
          prev.count += row.count;
          prev.authors = Math.max(prev.authors, row.authors);
          prev.velocity += row.velocity;
          prev.sentiment = Math.round(((prev.sentiment + row.sentiment) / 2) * 1000) / 1000;
          prev.samples = [...prev.samples, ...row.samples].slice(0, 4);
          for (const [label, count] of Object.entries(row.intents || {})) {
            prev.intents[label] = (prev.intents[label] || 0) + count;
          }
          prev.dominant = dominantIntent(prev.intents);
        }
      }
    }
    return [...merged.values()].sort((a, b) => b.count - a.count).slice(0, opts.limit || 24);
  }

  snapshot(channelKey, opts = {}) {
    const rows = channelKey ? this.rank(channelKey, opts) : this.rankAll(opts);
    const ch = channelKey ? this.channels.get(channelKey) : null;
    const total = ch ? ch.recent.length : [...this.channels.values()].reduce((a, c) => a + c.recent.length, 0);
    const now = Date.now();

    return {
      channelKey: channelKey || null,
      generatedAt: new Date(now).toISOString(),
      windowMinutes: Math.round(this.windowMs / 60000),
      messagesInWindow: total,
      hot: ch?.hot && now - ch.hot.at < VERDICT_TTL ? ch.hot : null,
      mode: ch?.mode && now - ch.mode.at < VERDICT_TTL ? ch.mode : null,
      jev: {
        ...this.jev.status(),
        lastCycleAt: this.lastCycleAt,
        lastCycleMs: this.lastCycleMs,
        cycles: this.cycles,
        backoff: this.backoffUntil > now,
      },
      topics: rows.map((r) => ({
        key: r.key,
        display: r.display,
        count: r.count,
        authors: r.authors,
        topAuthor: r.topAuthor,
        sentiment: r.sentiment,
        velocity: r.velocity,
        share: total ? Math.round((r.count / total) * 1000) / 1000 : 0,
        lastAt: new Date(r.lastAt).toISOString(),
        jev: r.jev ? { isTopic: r.jev.isTopic, confidence: r.jev.confidence } : null,
        verified: r.jev ? r.jev.isTopic >= 0.5 : null,
        stance: r.stance ? { label: r.stance.label, confidence: r.stance.confidence } : null,
        intents: r.intents,
        dominant: r.dominant,
        samples: r.samples,
      })),
    };
  }

  // --------------------------------------------------------------- jev side
  async cycle() {
    if (this.running || Date.now() < this.backoffUntil) return;
    const now = Date.now();
    this.prune(now);

    const dirty = [...this.channels.values()]
      .filter((c) => c.dirty && c.recent.length >= 2)
      .sort((a, b) => b.lastMsgAt - a.lastMsgAt);
    const ch = dirty[0];
    if (!ch) return;

    const rows = this.rank(ch.key, { limit: 8, minCount: 2, now });
    if (!rows.length) {
      ch.dirty = false;
      return;
    }

    const questions = {};
    const pending = rows.filter((r) => !r.jev || now - r.jev.at > VERDICT_TTL).slice(0, 8);

    pending.forEach((row, i) => {
      questions[`v${i}`] = {
        type: 'noul',
        instructions: `If someone summarized this conversation in one sentence, would they mention "${row.display}"?`,
        criteria: null,
      };
    });

    const hotCandidates = rows.slice(0, 8);
    const hotCriteria = {};
    hotCandidates.forEach((row, i) => {
      hotCriteria[`t${i}`] = `Discussion about ${row.display}`;
    });
    hotCriteria.none = 'No single dominant subject';

    questions.hot = {
      type: 'choice',
      instructions: 'Which single subject is this conversation mostly about right now?',
      criteria: hotCriteria,
    };

    questions.mode = {
      type: 'choice',
      instructions: 'What kind of conversation is this?',
      criteria: MODE_CRITERIA,
    };

    const state = ch.recent
      .slice(-14)
      .map((m) => `${m.author}: ${m.text.slice(0, 200)}`)
      .join('\n')
      .slice(0, 2600);

    this.running = true;
    const started = Date.now();
    try {
      const { answers } = await this.jev.decide(state, questions);

      pending.forEach((row, i) => {
        const a = answers[`v${i}`];
        if (a && a.type === 'noul') {
          row._topic.jev = { isTopic: a.noul, confidence: Math.abs(a.noul - 0.5) * 2, at: Date.now() };
        }
      });

      const hot = answers.hot;
      if (hot && hot.type === 'choice' && hot.choice !== 'none') {
        const idx = Number(String(hot.choice).replace('t', ''));
        const pick = hotCandidates[idx];
        if (pick) {
          const p = hot.probabilities?.[hot.choice];
          ch.hot = { display: pick.display, key: pick.key, confidence: typeof p === 'number' ? p : hot.confidence ?? 0, at: Date.now() };
        } else {
          ch.hot = null;
        }
      } else if (hot) {
        ch.hot = null;
      }

      const mode = answers.mode;
      if (mode && mode.type === 'choice') {
        const mp = mode.probabilities?.[mode.choice];
        ch.mode = {
          label: mode.choice,
          confidence: typeof mp === 'number' ? mp : mode.confidence ?? 0,
          at: Date.now(),
        };
      }

      ch.jevAt = Date.now();
      this.lastCycleAt = new Date().toISOString();
      this.lastCycleMs = Date.now() - started;
      this.cycles++;
      this.fails = 0;
      this.backoffUntil = 0;

      // One stance decision per cycle, round-robin over the top topics.
      await this.maybeStance(ch, rows);
      ch.dirty = false;
    } catch (err) {
      this.fails++;
      const delay = Math.min(60_000, 2000 * 2 ** Math.min(5, this.fails));
      this.backoffUntil = Date.now() + delay;
      this.log.warn?.(`[topics] jev unavailable (${err.message}); backing off ${delay}ms`);
    } finally {
      this.running = false;
    }
  }

  async maybeStance(ch, rows) {
    if (this.jev.busy) return;
    const now = Date.now();
    const target = rows
      .filter((r) => r.count >= 3 && (!r.stance || now - r.stance.at > STANCE_TTL))
      .sort((a, b) => (a.stance?.at || 0) - (b.stance?.at || 0) || b.count - a.count)[0];
    if (!target) return;

    const lines = target._topic.events
      .slice(-10)
      .map((e) => `${e.author}: ${e.text.slice(0, 180)}`)
      .join('\n')
      .slice(0, 2200);

    try {
      const { answers } = await this.jev.decide(lines, {
        stance: {
          type: 'choice',
          instructions: `How do the people in this conversation feel about "${target.display}"?`,
          criteria: STANCE_CRITERIA,
        },
      });
      const a = answers.stance;
      if (a && a.type === 'choice') {
        const sp = a.probabilities?.[a.choice];
        target._topic.stance = {
          label: a.choice,
          confidence: typeof sp === 'number' ? sp : a.confidence ?? 0,
          at: Date.now(),
        };
      }
    } catch {
      // stance is a bonus; verdict/headline results already landed
    }
  }

  /** Compact block for /digest. */
  digestSection(channelKey, limit = 8) {
    const snap = this.snapshot(channelKey, { limit });
    if (!snap.topics.length) return '';

    const arrow = (v) => (v > 0 ? `↑${v}` : v < 0 ? `↓${Math.abs(v)}` : '–');
    const lines = [];
    lines.push(`Most talked about (last ${snap.windowMinutes} min):`);
    snap.topics.forEach((t, i) => {
      const stance = t.stance ? `, stance ${t.stance.label} ${t.stance.confidence.toFixed(2)}` : '';
      const verified = t.jev ? (t.jev.isTopic >= 0.5 ? ' ✓' : ' ~') : '';
      const doing = intentText(t.intents);
      lines.push(
        `  ${i + 1}. ${t.display}${verified} — ${t.count} msgs, ${t.authors} ${t.authors === 1 ? 'person' : 'people'}, ${arrow(t.velocity)}`
        + `, sentiment ${t.sentiment >= 0 ? '+' : ''}${t.sentiment.toFixed(2)}${stance}`
        + (doing ? ` · ${doing}` : ''),
      );
    });
    if (snap.hot) lines.push(`Hot right now: ${snap.hot.display} (jev ${snap.hot.confidence.toFixed(2)})`);
    if (snap.mode) lines.push(`Mode: ${snap.mode.label} (jev ${snap.mode.confidence.toFixed(2)})`);
    return lines.join('\n');
  }
}

/** {label, count} for the most common non-neutral intent, or null. */
function dominantIntent(intents) {
  let best = null;
  for (const [label, count] of Object.entries(intents || {})) {
    if (label === 'neutral' || !count) continue;
    if (!best || count > best.count) best = { label, count };
  }
  return best;
}

/** "6 complaint, 2 question" — at most two labels, neutral omitted. */
function intentText(intents) {
  return Object.entries(intents || {})
    .filter(([label, count]) => label !== 'neutral' && count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([label, count]) => `${count} ${label}`)
    .join(', ');
}

export { candidatesFrom, dominantIntent, intentText };
export default TopicEngine;
