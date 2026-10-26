/**
 * Discord-style message extraction.
 *
 * Contract: a message is parsed into independent fields —
 *   { author, timestamp, replyTo: {author, text} | null, content }
 *
 * `content` NEVER falls back to the container's text and NEVER includes the
 * reply preview. If a message has no body, it is either '[attachment]' or it
 * is dropped, but it is never replaced by the quoted text.
 *
 * Classic script (not an ES module) so it can be listed before content.js in
 * the manifest, and evaluated directly in tests via node:vm.
 */
(function (root) {
  'use strict';

  const SELECTORS = {
    // a rendered message row
    message: 'li[id^="chat-messages-"], [role="listitem"][id^="chat-messages-"]',

    // the actual body. Ordered most-specific first.
    content: [
      '[id^="message-content-"]',
      '[data-message-content]',
      '[class*="messageContent"]',
      '[class*="message-content"]',
      '[class*="message_content"]',
      '[class*="msgContent"]',
    ],

    // the reply preview bar
    replyContext: [
      '[id^="message-reply-context"]',
      '[class*="repliedMessage"]',
      '[class*="replyBar"]',
      '[class*="replyBar"]',
      '[class*="replyContext"]',
      '[class*="replyContext"]',
      '[class*="reply-preview"]',
      '[class*="replyPreview"]',
    ],

    replyText: [
      '[class*="repliedTextContent"]',
      '[class*="replyText"]',
      '[class*="reply-content"]',
      '[class*="replyContent"]',
    ],

    replyAuthor: [
      '[class*="replyAvatar"] img[alt]',
      '[class*="replyAuthor"]',
      '[class*="username"]',
    ],

    header: 'h3',
    username: '[class*="username"], [class*="headerText"] span, [class*="userTag"]',
    timestamp: 'time[datetime]',
    edited: '[class*="edited"]',

    // never contributes to body text
    strip: [
      '[id^="message-reply-context"]',
      '[class*="repliedMessage"]',
      '[class*="replyBar"]',
      '[class*="replyContext"]',
      '[class*="replyPreview"]',
      '[class*="reply-preview"]',
      '[class*="embedWrapper"]',
      '[class*="Embed"]',
      '[class*="embed"]',
      '[class*="attachment"]',
      '[class*="Attachment"]',
      '[class*="reaction"]',
      'time',
      '[class*="timestamp"]',
      '[class*="edited"]',
      '[class*="botTag"]',
      'svg',
      'button',
    ],
  };

  const REPLY_ALL = SELECTORS.replyContext.join(',');
  const STRIP_ALL = SELECTORS.strip.join(',');

  // ------------------------------------------------------------------ utils
  function qs(rootEl, sels, stopAt) {
    for (const sel of sels) {
      for (const node of rootEl.querySelectorAll(sel)) {
        if (stopAt && inside(node, stopAt)) continue;
        return node;
      }
    }
    return null;
  }

  function inside(node, ancestor) {
    let n = node;
    while (n) {
      if (n === ancestor) return true;
      n = n.parentNode;
    }
    return false;
  }

  function inReplyBar(node, rootEl) {
    let n = node;
    while (n && n !== rootEl) {
      if (n.nodeType === 1 && safeMatches(n, REPLY_ALL)) return true;
      n = n.parentNode;
    }
    return false;
  }

  function safeMatches(node, sel) {
    try {
      return node.matches ? node.matches(sel) : false;
    } catch {
      return false;
    }
  }

  function normalize(text) {
    return String(text || '')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Walk DOM and build text, keeping <br>/<img alt> meaningful. */
  function nodeText(node, out = []) {
    const kids = node.childNodes || [];
    for (const child of kids) {
      if (child.nodeType === 3) {
        out.push(child.nodeValue);
      } else if (child.nodeType === 1) {
        const tag = (child.tagName || '').toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE') continue;
        if (tag === 'BR') {
          out.push(' ');
          continue;
        }
        if (tag === 'IMG') {
          const alt = (child.getAttribute('alt') || '').trim();
          if (alt) out.push(` ${alt} `);
          continue;
        }
        const block = tag === 'DIV' || tag === 'P' || tag === 'LI' || tag === 'BLOCKQUOTE' || tag === 'PRE';
        if (block) out.push(' ');
        nodeText(child, out);
        if (block) out.push(' ');
      }
    }
    return out.join('');
  }

  function textOf(node) {
    const clone = node.cloneNode(true);
    for (const sel of SELECTORS.strip) {
      clone.querySelectorAll(sel).forEach((n) => n.remove());
    }
    // any nested reply bar must not leak into the body either
    clone.querySelectorAll(REPLY_ALL).forEach((n) => n.remove());
    return normalize(nodeText(clone));
  }

  // -------------------------------------------------------------- author
  const authorCache = new WeakMap();

  function readHeaderAuthor(el) {
    const header = el.querySelector(SELECTORS.header);
    if (!header) return '';
    const nameEl = header.querySelector(SELECTORS.username);
    if (nameEl && nameEl.textContent.trim()) return nameEl.textContent.trim().slice(0, 60);

    const clone = header.cloneNode(true);
    clone.querySelectorAll('time, [class*="timestamp"], [class*="liver"], [class*="botTag"], svg').forEach((n) => n.remove());
    const text = normalize(nodeText(clone));
    return text ? text.split(' ').slice(0, 3).join(' ').slice(0, 60) : '';
  }

  /** Grouped messages have no header: inherit from the nearest previous row. */
  function resolveAuthor(el, depth = 0) {
    if (authorCache.has(el)) return authorCache.get(el);
    const own = readHeaderAuthor(el);
    if (own) {
      authorCache.set(el, own);
      return own;
    }
    if (depth < 50) {
      const prev = el.previousElementSibling;
      if (prev && (prev.id || '').startsWith('chat-messages-')) {
        const inherited = resolveAuthor(prev, depth + 1);
        if (inherited) {
          authorCache.set(el, inherited);
          return inherited;
        }
      }
    }
    return '';
  }

  // --------------------------------------------------------------- reply
  function readReply(el) {
    const bar = qs(el, SELECTORS.replyContext);
    if (!bar) return null;

    const textEl = qs(bar, SELECTORS.replyText) || bar;
    let text = textOf(textEl);

    let author = '';
    for (const sel of SELECTORS.replyAuthor) {
      const node = bar.querySelector(sel);
      if (!node) continue;
      const value = sel.includes('img')
        ? (node.getAttribute('alt') || '').trim()
        : normalize(node.textContent);
      if (value) {
        author = value.slice(0, 60);
        break;
      }
    }
    if (!author) {
      const labelled = el.querySelector('[aria-label^="Reply to"], [class*="replyLink"][aria-label]');
      const label = labelled ? labelled.getAttribute('aria-label') || '' : bar.getAttribute('aria-label') || '';
      const m = label.match(/reply to\s+(.+)$/i);
      if (m) author = m[1].trim().slice(0, 60);
    }

    // if the bar's text included the author, strip it
    if (author) {
      const a = author.toLowerCase();
      for (const prefix of [`@${a} `, `${a}: `, `${a} `]) {
        if (text.toLowerCase().startsWith(prefix)) {
          text = text.slice(prefix.length);
          break;
        }
      }
    }

    text = text.slice(0, 160).trim();
    if (!text) return null;
    return { author: author || '', text };
  }

  // --------------------------------------------------------------- content
  function pickContentNode(el, replyBar) {
    for (const sel of SELECTORS.content) {
      for (const node of el.querySelectorAll(sel)) {
        if (inReplyBar(node, el)) continue;         // inside the quote, not the body
        if (replyBar && inside(node, replyBar)) continue;
        if (node.querySelector(SELECTORS.header)) continue; // wrapper, not the body
        return node;
      }
    }
    return null;
  }

  function countAttachments(el) {
    const nodes = el.querySelectorAll(
      '[class*="attachment"], [class*="Attachment"], [class*="imageWrapper"],'
        + ' [class*="embedWrapper"], [class*="sticker"], [class*="Sticker"]',
    );
    return nodes.length;
  }

  function hashOf(parts) {
    let h = 2166136261;
    const s = parts.join('\u0001');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  /**
   * @param {Element} el  a message row
   * @param {object} ctx  {channelKey, channel, guild, url}
   */
  function parseMessage(el, ctx = {}) {
    if (!el || !el.id || !el.id.startsWith('chat-messages-')) return null;

    const replyBar = qs(el, SELECTORS.replyContext);
    const replyTo = replyBar ? readReply(el) : null;
    const contentNode = pickContentNode(el, replyBar);

    let content = contentNode ? textOf(contentNode) : '';
    const attachments = countAttachments(el);
    if (!content && attachments) content = '[attachment]';
    if (!content) return null; // system message, divider, or unparseable body

    const timeEl = el.querySelector(SELECTORS.timestamp);
    const header = el.querySelector(SELECTORS.header);
    const author = resolveAuthor(el) || 'unknown';
    const id = el.id.replace(/^chat-messages-/, '');

    return {
      id,
      author,
      ts: (timeEl && timeEl.getAttribute('datetime')) || null,
      content: content.slice(0, 2000),
      replyTo,
      edited: Boolean(el.querySelector(SELECTORS.edited)),
      bot: header ? /\b(BOT|APP)\b/.test(header.textContent || '') : false,
      reactions: el.querySelectorAll('[class*="reactionInner"]').length,
      attachments,
      channelKey: ctx.channelKey || '',
      channel: ctx.channel || '',
      guild: ctx.guild || '',
      url: ctx.url || '',
      hash: '',
    };
  }

  // ------------------------------------------------------------ dedupe
  function stamp(msg) {
    msg.hash = hashOf([
      msg.channelKey,
      msg.author,
      msg.content,
      msg.replyTo ? `${msg.replyTo.author}\u0002${msg.replyTo.text}` : '',
      msg.edited ? '1' : '0',
    ]);
    return msg;
  }

  /** Returns 'new' | 'update' | 'skip' and remembers the latest content hash. */
  class SeenStore {
    constructor({ limit = 5000 } = {}) {
      this.limit = limit;
      this.map = new Map();
    }

    key(msg) {
      return `${msg.channelKey || ''}|${msg.id}`;
    }

    check(msg) {
      const key = this.key(msg);
      const hash = msg.hash || stamp(msg).hash;
      const prev = this.map.get(key);
      if (prev === undefined) {
        this.map.set(key, hash);
        this.trim();
        return 'new';
      }
      if (prev !== hash) {
        this.map.delete(key);
        this.map.set(key, hash);
        return 'update';
      }
      this.map.delete(key);
      this.map.set(key, hash);
      return 'skip';
    }

    trim() {
      while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    }

    get size() {
      return this.map.size;
    }
  }

  root.__dsExtract = { SELECTORS, parseMessage, readReply, SeenStore, nodeText, normalize, stamp, hashOf };
})(typeof globalThis !== 'undefined' ? globalThis : this);
