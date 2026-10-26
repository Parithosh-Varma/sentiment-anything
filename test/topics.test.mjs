import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TopicEngine } from '../server/topics.mjs';

const jev = { status: () => ({ online: false }), busy: true, decide: async () => ({ answers: {} }) };
const logger = { warn() {}, error() {}, log() {} };
const CH = 'ZNW.io::general';

function msg(id, author, text, extra = {}) {
  return { id, author, text, score: 0, seq: msg.n = (msg.n || 0) + 1, receivedAt: Date.now(), channelKey: CH, ...extra };
}

test('edited message replaces its topic contribution instead of adding one', () => {
  const engine = new TopicEngine({ jev, logger });

  engine.observe(msg('m1', 'mira', 'ranked mode is cooked'));
  engine.observe(msg('m2', 'kade', 'ranked mode again, still cooked'));

  let rows = engine.rank(CH, { minCount: 1 });
  assert.equal(rows.find((r) => r.key === 'ranked mode').count, 2);

  // same DOM id, new body -> replace
  engine.observe(msg('m2', 'kade', 'queue times are long'), { replace: true });

  rows = engine.rank(CH, { minCount: 1 });
  assert.equal(rows.find((r) => r.key === 'ranked mode').count, 1, 'old mention removed');
  assert.equal(rows.find((r) => r.key === 'queue time').count, 1, 'new mention added');
  assert.equal(engine.channels.get(CH).recent.length, 2, 'no duplicate in the raw window');
});

test('an edited message that no longer mentions a topic drops out entirely', () => {
  const engine = new TopicEngine({ jev, logger });

  engine.observe(msg('a', 'mira', 'wuthering waves is great'));
  engine.observe(msg('b', 'kade', 'wuthering waves again'));
  engine.observe(msg('b', 'kade', 'unrelated body'), { replace: true });

  const rows = engine.rank(CH, { minCount: 1 });
  const topic = rows.find((r) => r.key === 'wuthering wave');
  assert.equal(topic.count, 1);
});

test('reply previews never reach the topic counter', () => {
  const engine = new TopicEngine({ jev, logger });

  // the content field is the body only; replyTo is carried separately and ignored
  engine.observe(msg('a1', 'mira', 'minecraft server is laggy', { replyTo: null }));
  engine.observe(msg('a2', 'mira', 'minecraft server needs a restart', { replyTo: null }));
  engine.observe(msg('b1', 'Blubbll', 'im not gonna tell a rando', { replyTo: { author: 'Copilot Guy', text: 'minecraft server' } }));
  engine.observe(msg('b2', 'kade', 'same here', { replyTo: { author: 'Copilot Guy', text: 'minecraft server' } }));

  const topic = engine.rank(CH, { minCount: 1 }).find((r) => r.display.toLowerCase() === 'minecraft server');
  assert.equal(topic.count, 2, 'only the two real bodies count');
  assert.equal(topic.authors, 1, 'repliers are not attributed to the quoted topic');
});

test('topics aggregate intents and relabel when jev answers late', () => {
  const engine = new TopicEngine({ jev, logger });

  // ingest order: messages land first, intent arrives later
  engine.observe(msg('m1', 'mira', 'ranked mode is cooked'));
  engine.observe(msg('m2', 'kade', 'ranked mode again, still cooked'));
  engine.observe(msg('m3', 'nova', 'ranked mode queue is broken'));

  let row = engine.rank(CH, { minCount: 1 }).find((r) => r.key === 'ranked mode');
  assert.equal(row.intents.complaint, 0, 'no intents before jev');

  engine.setIntent({ id: 'm1', channelKey: CH, intent: 'complaint', intentProb: 0.91 });
  engine.setIntent({ id: 'm2', channelKey: CH, intent: 'complaint', intentProb: 0.88 });
  engine.setIntent({ id: 'm3', channelKey: CH, intent: 'question', intentProb: 0.72 });

  row = engine.rank(CH, { minCount: 1 }).find((r) => r.key === 'ranked mode');
  assert.equal(row.intents.complaint, 2);
  assert.equal(row.intents.question, 1);
  assert.deepEqual(row.dominant, { label: 'complaint', count: 2 });
});

test('an edit clears the old intent and the next jev answer replaces it', () => {
  const engine = new TopicEngine({ jev, logger });

  engine.observe(msg('m1', 'mira', 'ranked mode is cooked', { intent: 'complaint' }));
  engine.observe(msg('m2', 'kade', 'ranked mode again', { intent: 'complaint' }));

  engine.observe(msg('m1', 'mira', 'ranked mode is great now', { intent: null }), { replace: true });
  engine.setIntent({ id: 'm1', channelKey: CH, intent: 'praise' });

  const row = engine.rank(CH, { minCount: 1 }).find((r) => r.key === 'ranked mode');
  assert.equal(row.intents.complaint, 1, 'other message keeps its label');
  assert.equal(row.intents.praise, 1, 'edited message takes the new label');
});

test('a split intent count has no dominant label', () => {
  const engine = new TopicEngine({ jev, logger });

  engine.observe(msg('t1', 'mira', 'ranked mode is cooked', { intent: 'complaint' }));
  engine.observe(msg('t2', 'kade', 'ranked mode queue is broken', { intent: 'question' }));

  const row = engine.rank(CH, { minCount: 1 }).find((r) => r.key === 'ranked mode');
  assert.equal(row.intents.complaint, 1);
  assert.equal(row.intents.question, 1);
  assert.equal(row.dominant, null, 'ties are not reported as dominant');
});
