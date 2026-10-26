import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntentEngine, heuristicIntent } from '../server/intent.mjs';

class FakeJev {
  constructor({ label = () => 'neutral', failures = 0, delayMs = 0 } = {}) {
    this.label = label;
    this.failures = failures;
    this.delayMs = delayMs;
    this.calls = [];
    this.messages = 0;
  }

  async decide(state, questions) {
    this.calls.push(state.messages);
    this.messages += state.messages.length;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failures > 0) {
      this.failures--;
      throw new Error('jev 429: inference backend returned HTTP 429');
    }
    const answers = {};
    state.messages.forEach((text, i) => {
      const choice = this.label(text);
      answers[`m${i}`] = { type: 'choice', choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 };
    });
    return { answers };
  }
}

function setup(jev, opts = {}) {
  const engine = new IntentEngine({
    jev,
    batchSize: 3,
    maxBatch: opts.maxBatch || 3,
    retries: 1,
    backoffMs: 0,
    backoffCapMs: 0,
    ...opts,
  });
  const resolved = [];
  engine.onResolve = (m) => resolved.push(m);
  return { engine, resolved };
}

const m = (id, text) => ({ id, text, channelKey: 'S::g', author: 'a', seq: Number(id) || 1 });

test('every message is classified, batched into one request per batch', async () => {
  const jev = new FakeJev({ label: () => 'question' });
  const { engine, resolved } = setup(jev);

  const msgs = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'].map((id) => m(id, `msg ${id}`));
  msgs.forEach((x) => engine.enqueue(x));
  await engine.drain(2000);

  assert.equal(jev.calls.length, 3, '3 messages per request');
  assert.deepEqual(jev.calls.map((c) => c.length), [3, 3, 1]);
  assert.equal(resolved.length, 7);
  assert.ok(msgs.every((x) => x.intent === 'question' && x.intentSource === 'jev'));
});

test('identical text is answered once and served from cache', async () => {
  const jev = new FakeJev({ label: () => 'praise' });
  const { engine } = setup(jev);

  const a = m('a1', 'thanks, works now');
  engine.enqueue(a);
  await engine.drain(2000);

  const b = m('b1', 'Thanks,  works now');
  engine.enqueue(b);
  await engine.drain(2000);

  assert.equal(a.intent, 'praise');
  assert.equal(b.intent, 'praise');
  assert.equal(b.intentCached, true);
  assert.equal(jev.messages, 1, 'model saw the text once');
  assert.equal(engine.status().cached, 1);
});

test('retries then falls back to a marked heuristic label', async () => {
  const jev = new FakeJev({ failures: 99 });
  const { engine } = setup(jev, { batchSize: 2, retries: 2 });

  const a = m('a1', 'the lag is terrible');
  const b = m('b1', 'how do i reset my password');
  engine.enqueue(a);
  engine.enqueue(b);
  await engine.drain(3000);

  assert.equal(jev.calls.length, 2, 'one retry before giving up');
  assert.equal(a.intent, 'complaint');
  assert.equal(b.intent, 'question');
  assert.equal(a.intentSource, 'heuristic');
  assert.match(a.intentReason, /429/);
  assert.equal(engine.status().heuristic, 2);
});

test('queue overflow degrades instead of growing without bound', async () => {
  const jev = new FakeJev({ delayMs: 5 });
  const { engine } = setup(jev, { maxQueue: 20, batchSize: 3 });

  const msgs = Array.from({ length: 40 }, (_, i) => m(`x${i}`, `message number ${i}`));
  msgs.forEach((x) => engine.enqueue(x));

  const st = engine.status();
  assert.ok(st.queue <= 20, `queue capped, got ${st.queue}`);
  assert.ok(st.overflow >= 19, `overflow counted, got ${st.overflow}`);
  assert.ok(st.heuristic >= 19, 'overflow labelled immediately');

  await engine.drain(5000);
  assert.equal(engine.status().resolved, 40);
});

test('disabled engine labels heuristically and never calls jev', async () => {
  const jev = new FakeJev();
  const { engine } = setup(jev, { enabled: false });

  const a = m('a1', 'please add a replay system');
  engine.enqueue(a);

  assert.equal(jev.calls.length, 0);
  assert.equal(a.intent, 'request');
  assert.equal(a.intentSource, 'heuristic');
});

test('heuristic labels cover the four intents', () => {
  assert.equal(heuristicIntent('how do i reset my password'), 'question');
  assert.equal(heuristicIntent('anyone know the restart time?'), 'question');
  assert.equal(heuristicIntent('can we get a wipe already'), 'request');
  assert.equal(heuristicIntent('please add a replay system'), 'request');
  assert.equal(heuristicIntent('the lag makes it unplayable'), 'complaint');
  assert.equal(heuristicIntent('thanks for the fast fix'), 'praise');
  assert.equal(heuristicIntent('gg wp'), 'praise');
  assert.equal(heuristicIntent('lol'), 'neutral');
});
