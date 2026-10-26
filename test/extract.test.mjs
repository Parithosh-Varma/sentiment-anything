import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

// extract.js is a classic script (no exports) so it can be loaded by a content
// script before content.js. Evaluate it in a bare context to get its API.
const source = fs.readFileSync(new URL('../extension/extract.js', import.meta.url), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'extract.js' });
const X = sandbox.__dsExtract;

const CTX = { channelKey: 'ZNW.io::general', channel: 'general', guild: 'ZNW.io', url: 'https://example.test/channels/1/2' };

function row(html) {
  const { document } = parseHTML(`<html><body><ul id="list">${html}</ul></body></html>`);
  return document.getElementById('list');
}

function parse(list, id, ctx = CTX) {
  return X.parseMessage(list.querySelector(`#chat-messages-${id}`), ctx);
}

// ------------------------------------------------------------------ fixtures
const normal = `
<li id="chat-messages-111-1001" class="messageListItem">
  <div class="container">
    <h3 class="header"><span class="username">mira</span><time datetime="2026-10-26T18:32:20.000Z">18:32</time></h3>
    <div id="message-content-1001" class="messageContent"><div class="markup">hello there</div></div>
  </div>
</li>`;

const reply = `
<li id="chat-messages-111-1002" class="messageListItem">
  <div class="container">
    <div id="message-reply-context-1002" class="repliedMessage">
      <div class="replyAvatar"><img alt="Copilot Guy" src="a.png"></div>
      <div class="repliedTextContent">how</div>
    </div>
    <h3 class="header"><span class="username">Blubbll</span><time datetime="2026-10-26T18:32:26.000Z">18:32</time></h3>
    <div id="message-content-1002" class="messageContent">im not gonna tell a rando</div>
  </div>
</li>`;

const replyToReply = `
<li id="chat-messages-111-1003" class="messageListItem">
  <div class="container">
    <div id="message-reply-context-1003" class="repliedMessage">
      <div class="replyAvatar"><img alt="Blubbll" src="b.png"></div>
      <div class="repliedTextContent">
        <span class="replyContext">how</span>
        im not gonna tell a rando
      </div>
    </div>
    <h3 class="header"><span class="username">mira</span></h3>
    <div id="message-content-1003" class="messageContent">fair enough</div>
  </div>
</li>`;

const attachmentOnly = `
<li id="chat-messages-111-1004" class="messageListItem">
  <div class="container">
    <div id="message-reply-context-1004" class="repliedMessage">
      <div class="replyAvatar"><img alt="Copilot Guy" src="a.png"></div>
      <div class="repliedTextContent">how</div>
    </div>
    <h3 class="header"><span class="username">Blubbll</span></h3>
    <div id="message-content-1004" class="messageContent"></div>
    <div class="messageAttachment"><a href="#">screenshot.png</a></div>
  </div>
</li>`;

const grouped = `
<li id="chat-messages-111-1005" class="messageListItem">
  <div class="container">
    <h3 class="header"><span class="username">mira</span></h3>
    <div id="message-content-1005" class="messageContent">first line</div>
  </div>
</li>
<li id="chat-messages-111-1006" class="messageListItem">
  <div class="container">
    <div id="message-content-1006" class="messageContent">second line without a header</div>
  </div>
</li>`;

const brokenDom = `
<li id="chat-messages-111-1007" class="messageListItem">
  <div class="container">
    <div id="message-reply-context-1007" class="repliedMessage">
      <div class="repliedTextContent">quoted text only</div>
    </div>
    <h3 class="header"><span class="username">Blubbll</span></h3>
  </div>
</li>`;

// --------------------------------------------------------------------- tests
test('normal message splits author, timestamp and content', () => {
  const list = row(normal);
  const msg = parse(list, '111-1001');
  assert.equal(msg.author, 'mira');
  assert.equal(msg.content, 'hello there');
  assert.equal(msg.replyTo, null);
  assert.equal(msg.ts, '2026-10-26T18:32:20.000Z');
  assert.equal(msg.id, '111-1001');
});

test('reply message: quoted text goes to replyTo, body stays the real body', () => {
  const list = row(reply);
  const msg = parse(list, '111-1002');

  assert.equal(msg.replyTo.author, 'Copilot Guy');
  assert.equal(msg.replyTo.text, 'how');
  assert.equal(msg.content, 'im not gonna tell a rando');

  // the regression: body must never be the quoted text
  assert.notEqual(msg.content, 'how');
  assert.ok(!msg.content.split(' ').includes('how'));
});

test('reply to a reply: nested quote is stripped, immediate quote kept', () => {
  const list = row(replyToReply);
  const msg = parse(list, '111-1003');

  assert.equal(msg.replyTo.author, 'Blubbll');
  assert.equal(msg.replyTo.text, 'im not gonna tell a rando');
  assert.equal(msg.content, 'fair enough');
});

test('attachment-only message with a reply preview is not filled with the quote', () => {
  const list = row(attachmentOnly);
  const msg = parse(list, '111-1004');

  assert.equal(msg.replyTo.text, 'how');
  assert.equal(msg.content, '[attachment]');
  assert.equal(msg.attachments, 1);
});

test('re-rendered duplicate is skipped, changed content is an update', () => {
  const list = row(normal);
  const store = new X.SeenStore();

  const first = parse(list, '111-1001');
  assert.equal(store.check(first), 'new');

  const again = parse(list, '111-1001');
  assert.equal(store.check(again), 'skip');

  const contentEl = list.querySelector('#message-content-1001');
  contentEl.textContent = 'hello there, edited';
  const changed = parse(list, '111-1001');
  assert.equal(store.check(changed), 'update');
  assert.equal(changed.content, 'hello there, edited');

  const settled = parse(list, '111-1001');
  assert.equal(store.check(settled), 'skip');
});

test('grouped messages inherit the author from the previous header', () => {
  const list = row(grouped);
  const first = parse(list, '111-1005');
  const second = parse(list, '111-1006');

  assert.equal(first.author, 'mira');
  assert.equal(second.author, 'mira');
  assert.equal(second.content, 'second line without a header');
});

test('a message whose only text is nested in the reply bar is dropped, not quoted', () => {
  const list = row(brokenDom);
  const msg = X.parseMessage(list.querySelector('#chat-messages-111-1007'), CTX);
  assert.equal(msg, null);
});

test('embeds and timestamps never leak into content', () => {
  const list = row(`
    <li id="chat-messages-111-1008">
      <div class="container">
        <h3 class="header"><span class="username">mira</span></h3>
        <div id="message-content-1008" class="messageContent">
          look at this
          <div class="embedWrapper">Embedded title that should not count</div>
        </div>
      </div>
    </li>`);
  const msg = parse(list, '111-1008');
  assert.equal(msg.content, 'look at this');
});

test('emoji image alt text survives, custom emoji keeps its shortcode', () => {
  const list = row(`
    <li id="chat-messages-111-1009">
      <div class="container">
        <h3 class="header"><span class="username">mira</span></h3>
        <div id="message-content-1009" class="messageContent">
          nice <img class="emoji" alt="🔥"> <img class="emoji" alt=":kekw:">
        </div>
      </div>
    </li>`);
  const msg = parse(list, '111-1009');
  assert.match(msg.content, /🔥/);
  assert.match(msg.content, /:kekw:/);
});

test('reply text is excluded from the topic counter input', () => {
  const list = row(reply);
  const msg = parse(list, '111-1002');
  // topics are built from msg.content only
  assert.equal(msg.replyTo.text, 'how');
  assert.equal(msg.content, 'im not gonna tell a rando');
  assert.ok(!msg.content.includes(msg.replyTo.text));
});
