/**
 * Per-message intent classification via LocalJev.
 *
 * Every accepted message is queued here and classified by the model — there is
 * no keyword shortcut for messages that reach the model. Three things keep the
 * live pipeline honest:
 *
 *   1. batching   — up to JEV_INTENT_BATCH messages share one /v1/systemone call
 *   2. caching    — identical bodies ("gg", "lol") are answered once
 *   3. fallback   — if the backend is down or rate-limited past the retry
 *                   budget, a heuristic label is applied and marked as such
 *                   (`intentSource: 'heuristic'`) so jev-driven and
 *                   best-effort labels are never confused.
 *
 * Ingest is never blocked: messages are broadcast first, intent arrives later as
 * an `update` event (the panel patches the row in place).
 */

const LABELS = ['question', 'request', 'complaint', 'praise', 'neutral'];

const CRITERIA = {
  question: 'asks for information',
  request: 'asks for a change or feature',
  complaint: 'negative, reporting a problem',
  praise: 'positive, thanking or complimenting',
  neutral: 'none of the above',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function oneLine(text, max = 400) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function questionFor(text) {
  return {
    type: 'choice',
    instructions: `Message: "${oneLine(text)}" — what is the author doing?`,
    criteria: CRITERIA,
  };
}

/** Best-effort label used only when jev cannot answer. */
export function heuristicIntent(text) {
  const t = oneLine(text).toLowerCase();
  if (!t) return 'neutral';

  if (/(please add|please fix|can we get|could we get|can you (add|fix|ban|remove)|bring back|add more|more maps|nerf|buff|suggest|request(ing)?\b|would be nice|should add)/.test(t)) {
    return 'request';
  }
  if (t.endsWith('?') || /^(how|what|when|where|why|who|which|is|are|was|can|could|does|did|do|any(one|body))\b/.test(t)) {
    return 'question';
  }
  if (/(broken|bug|crash|lag|laggy|freeze|stutter|trash|terrible|awful|hate|worst|unplayable|scam|refund|angry|annoy|sucks|disappoint|unfair|nerf)/.test(t)) {
    return 'complaint';
  }
  if (/(thanks|thank you|thx|love|great|awesome|amazing|nice|perfect|appreciate|well done|gg|wp|good job)/.test(t)) {
    return 'praise';
  }
  return 'neutral';
}

export class IntentEngine {
  constructor({
    jev,
    logger = console,
    batchSize = Number(process.env.JEV_INTENT_BATCH || 6),
    maxBatch = Math.max(6, Number(process.env.JEV_INTENT_BATCH_MAX || 10)),
    maxQueue = Number(process.env.JEV_INTENT_MAX_QUEUE || 600),
    cacheSize = Number(process.env.JEV_INTENT_CACHE || 4000),
    retries = Number(process.env.JEV_INTENT_RETRIES || 3),
    backoffMs = Number(process.env.JEV_INTENT_BACKOFF_MS || 800),
    backoffCapMs = Number(process.env.JEV_INTENT_BACKOFF_CAP_MS || 30000),
    enabled = process.env.JEV_INTENT !== '0',
    now = Date.now,
  } = {}) {
    this.jev = jev;
    this.logger = logger;
    this.enabled = enabled && Boolean(jev);

    this.batchSize = Math.max(1, Math.min(batchSize, maxBatch));
    this.maxBatch = Math.max(this.batchSize, maxBatch);
    this.maxQueue = Math.max(20, maxQueue);
    this.retries = Math.max(0, retries);
    this.backoffMs = Math.max(0, backoffMs);
    this.backoffCapMs = Math.max(this.backoffMs, backoffCapMs);
    this.cacheSize = Math.max(0, cacheSize);
    this.now = now;

    /** @type {Array<{msg: object, attempts: number, queuedAt: number}>} */
    this.queue = [];
    /** @type {Map<string, {intent: string, prob: number}>} */
    this.cache = new Map();

    this.running = false;
    this.stopped = false;
    this.failures = 0;
    this.overflow = 0;
    this.resolved = 0;
    this.cachedHits = 0;
    this.heuristic = 0;
    this.failedCalls = 0;
    this.lastError = null;
    this.lastErrorAt = null;
    this.lastLatencyMs = null;
    this.lastOkAt = null;
    this.recent = [];
    this.generation = 0;
    this.kickTimer = null;

    /** @type {(msg: object) => void} | null */
    this.onResolve = null;
  }

  // ------------------------------------------------------------------ public
  enqueue(msg) {
    if (!msg || !msg.text || msg.intent) return;
    if (!this.enabled) {
      this.#apply(msg, heuristicIntent(msg.text), 0, 'heuristic');
      return;
    }

    const hit = this.cache.get(this.#key(msg.text));
    if (hit) {
      this.cachedHits++;
      this.#apply(msg, hit.intent, hit.prob, 'jev', { cached: true });
      return;
    }

    if (this.queue.length >= this.maxQueue) {
      this.overflow++;
      const victim = this.queue.shift();
      if (victim) this.#fallback({ item: victim, text: victim.msg.text }, 'queue overflow');
    }

    this.queue.push({ msg, attempts: 0, queuedAt: this.now(), gen: this.generation });
    this.#schedule();
  }

  /** Drop pending work (used by POST /clear). Replies for dropped work are ignored. */
  reset() {
    this.generation++;
    this.queue.length = 0;
  }

  status() {
    const cutoff = this.now() - 60000;
    this.recent = this.recent.filter((t) => t >= cutoff);
    return {
      enabled: this.enabled,
      queue: this.queue.length,
      inflight: this.running ? 1 : 0,
      batchSize: this.batchSize,
      cache: this.cache.size,
      resolved: this.resolved,
      cached: this.cachedHits,
      heuristic: this.heuristic,
      overflow: this.overflow,
      failedCalls: this.failedCalls,
      perMin: this.recent.length,
      lastLatencyMs: this.lastLatencyMs,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      online: this.lastOkAt !== null && (!this.lastErrorAt || this.lastOkAt > this.lastErrorAt),
    };
  }

  /** Resolves once the queue is empty (used by tests and the digest CLI). */
  async drain(timeoutMs = 120000) {
    const deadline = this.now() + timeoutMs;
    while ((this.running || this.queue.length) && this.now() < deadline) {
      await sleep(10);
    }
  }

  stop() {
    this.stopped = true;
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = null;
  }

  // ----------------------------------------------------------------- internal
  #key(text) {
    return oneLine(text, 280).toLowerCase();
  }

  #schedule() {
    if (this.running || this.stopped || this.kickTimer) return;
    // let the ingest response go out before the first jev resolution lands
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      this.#kick();
    }, 0);
  }

  #kick() {
    if (this.running || this.stopped || !this.queue.length) return;
    this.running = true;
    this.#loop()
      .catch((err) => {
        this.lastError = err.message;
        this.lastErrorAt = this.now();
        this.logger.error?.('[intent]', err.message);
      })
      .finally(() => {
        this.running = false;
        if (this.queue.length && !this.stopped) this.#schedule();
      });
  }

  async #loop() {
    while (this.queue.length && !this.stopped) {
      const gen = this.generation;
      // serve cache hits without touching the model
      const batch = [];
      while (batch.length < this.batchSize && this.queue.length) {
        const item = this.queue.shift();
        if (item.gen !== gen) continue;
        // snapshot the body: it may be edited while the request is in flight
        const text = item.msg.text;
        const hit = this.cache.get(this.#key(text));
        if (hit) {
          this.cachedHits++;
          this.#apply(item.msg, hit.intent, hit.prob, 'jev', { cached: true, text });
          continue;
        }
        batch.push({ item, text });
      }
      if (!batch.length) continue;

      const state = {
        chat: 'discord-style chat',
        messages: batch.map((entry) => oneLine(entry.text)),
      };
      const questions = {};
      batch.forEach((entry, i) => {
        questions[`m${i}`] = questionFor(entry.text);
      });

      const t0 = this.now();
      try {
        const res = await this.jev.decide(state, questions);
        this.lastLatencyMs = this.now() - t0;
        this.lastOkAt = this.now();
        this.#absorb(batch, res, gen);
        this.failures = 0;
        if (this.batchSize < this.maxBatch) this.batchSize++;
      } catch (err) {
        this.failures++;
        this.failedCalls++;
        this.lastError = err.message;
        this.lastErrorAt = this.now();
        for (const entry of batch) entry.item.attempts++;

        const retry = [];
        for (const entry of batch) {
          if (entry.item.gen !== this.generation) continue;   // cleared mid-flight
          if (entry.text !== entry.item.msg.text) continue;   // edited: the newer entry owns it
          if (entry.item.attempts < this.retries) retry.push(entry.item);
          else this.#fallback(entry, err.message);
        }
        this.queue.unshift(...retry);
        this.batchSize = Math.max(2, Math.floor(this.batchSize / 2));

        if (retry.length) {
          const wait = Math.min(
            this.backoffCapMs,
            this.backoffMs * 2 ** Math.max(0, this.failures - 1),
          );
          if (wait) await sleep(wait);
        }
      }
    }
  }

  #absorb(batch, res, gen) {
    if (gen !== this.generation) return; // cleared while in flight
    const answers = res?.answers || res || {};
    batch.forEach((entry, i) => {
      const a = answers[`m${i}`];
      const choice = a && typeof a.choice === 'string' ? a.choice : null;
      if (!choice || !LABELS.includes(choice)) {
        this.#fallback(entry, 'no answer');
        return;
      }
      const prob = Number(a.probabilities?.[choice] ?? a.confidence ?? 0) || 0;
      // cache under the text that was actually classified, not the current body
      this.cache.set(this.#key(entry.text), { intent: choice, prob });
      if (this.cache.size > this.cacheSize) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.#apply(entry.item.msg, choice, prob, 'jev', { text: entry.text });
    });
  }

  #fallback(entry, reason) {
    const { item, text } = entry || {};
    if (!item) return;
    if (item.gen !== this.generation) return;
    if (text !== undefined && item.msg.text !== text) return; // edited; newer revision owns it
    this.heuristic++;
    this.#apply(item.msg, heuristicIntent(item.msg.text), 0, 'heuristic', { reason });
  }

  #apply(msg, intent, prob, source, { cached = false, reason = '', text } = {}) {
    if (!msg || msg.intent) return;
    if (text !== undefined && msg.text !== text) return;
    msg.intent = intent;
    msg.intentProb = Math.round(prob * 1000) / 1000;
    msg.intentSource = source;
    msg.intentCached = cached || undefined;
    const now = this.now();
    msg.intentAt = now;
    if (source === 'heuristic' && reason) msg.intentReason = reason;
    this.resolved++;
    this.recent.push(now);
    if (this.recent.length > 600) {
      const cutoff = now - 60000;
      let drop = 0;
      while (drop < this.recent.length && this.recent[drop] < cutoff) drop++;
      if (drop) this.recent.splice(0, drop);
    }
    try {
      this.onResolve?.(msg);
    } catch (err) {
      this.logger.error?.('[intent:onResolve]', err.message);
    }
  }
}

export { LABELS, CRITERIA };
export default IntentEngine;
