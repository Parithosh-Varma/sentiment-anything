/**
 * Thin LocalJev client for POST /v1/systemone.
 *
 * LocalJev returns calibrated probabilities for typed questions (noul / choice /
 * score). It serializes calls internally because the model has limited inflight
 * capacity, so we queue requests here and never block the ingest path on it.
 */

const DEFAULTS = {
  base: process.env.JEV_URL || 'http://127.0.0.1:8080',
  model: process.env.JEV_MODEL || 'localjev-latest',
  timeoutMs: Number(process.env.JEV_TIMEOUT_MS || 30000),
};

export class JevClient {
  constructor(opts = {}) {
    this.base = (opts.base || DEFAULTS.base).replace(/\/+$/, '');
    this.model = opts.model || DEFAULTS.model;
    this.timeoutMs = opts.timeoutMs || DEFAULTS.timeoutMs;

    this.chain = Promise.resolve();
    this.inflight = 0;
    this.calls = 0;
    this.failures = 0;
    this.lastLatencyMs = null;
    this.lastError = null;
    this.lastOkAt = null;
    this.serverModel = null;
    this.enabled = true;
  }

  get busy() {
    return this.inflight > 0;
  }

  status() {
    return {
      enabled: this.enabled,
      online: this.lastOkAt !== null && (!this.lastError || this.lastOkAt > this.lastErrorAt),
      base: this.base,
      model: this.serverModel || this.model,
      calls: this.calls,
      failures: this.failures,
      lastLatencyMs: this.lastLatencyMs,
      lastError: this.lastError,
      busy: this.busy,
    };
  }

  /** Queue a decision. Calls are serialized; each one is individually timed out. */
  decide(state, questions, { timeoutMs } = {}) {
    const run = () => this.#decide(state, questions, timeoutMs || this.timeoutMs);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async #decide(state, questions, timeoutMs) {
    if (!this.enabled) throw new Error('jev disabled');
    const started = Date.now();
    this.inflight++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.base}/v1/systemone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, state, questions }),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`jev ${res.status}: ${text.slice(0, 220)}`);
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`jev non-JSON: ${text.slice(0, 160)}`);
      }
      this.calls++;
      this.lastLatencyMs = Date.now() - started;
      this.lastOkAt = Date.now();
      this.lastError = null;
      if (body.model) this.serverModel = body.model;
      return { answers: body.answers || {}, usage: body.usage || {}, ms: this.lastLatencyMs };
    } catch (err) {
      this.failures++;
      this.lastError = err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(err.message || err);
      this.lastErrorAt = Date.now();
      throw err;
    } finally {
      clearTimeout(timer);
      this.inflight--;
    }
  }

  async health({ timeoutMs = 2000 } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.base}/health`, { signal: ac.signal });
      if (!res.ok) return { ok: false, status: res.status };
      const body = await res.json();
      return { ok: body.status === 'ok', ...body };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
