// FB Business Messenger Alert — Content Script v3
// Primary: fetch/XHR/WebSocket interception
// Fallback: DOM badge polling + title watch

(function () {
  'use strict';

  // ─── Deduplication & cooldown ──────────────────────────────────
  const seenIds = new Set();
  let lastTriggerTime = 0;
  const COOLDOWN_MS = 8000;

  // ─── Core trigger ──────────────────────────────────────────────
  function onNewMessage(senderName, messageText) {
    const now = Date.now();
    if (now - lastTriggerTime < COOLDOWN_MS) return;
    lastTriggerTime = now;

    const pageName = getPageName();
    const pageUrl = getPageUrl();
    console.log(`[FB Alert v3] 🔔 新訊息 | ${senderName} | ${messageText?.slice(0, 40)}`);

    chrome.runtime.sendMessage({
      type: 'NEW_MESSAGE',
      senderName: senderName || '訪客',
      messageText: messageText || '（請點連結查看訊息）',
      pageName,
      pageUrl,
    });
  }

  function getPageName() {
    const t = document.title.replace(/^\(\d+\)\s*/, '');
    const parts = t.split('|');
    return parts.length > 1 ? parts[0].trim() : (t.trim() || '未知粉絲頁');
  }

  function getPageUrl() {
    const m = location.href.match(/asset_id=(\d+)/);
    return m
      ? `https://business.facebook.com/latest/inbox/messenger?asset_id=${m[1]}`
      : location.href;
  }

  // ─── Strategy 1: Fetch interceptor ────────────────────────────
  // Must be installed at document_start to intercept all FB API calls
  const _origFetch = window.fetch;
  window.fetch = function (...args) {
    const req = args[0];
    const url = typeof req === 'string' ? req : (req && req.url) || '';
    return _origFetch.apply(this, args).then((resp) => {
      if (isFbApi(url)) {
        resp.clone().text().then((t) => scanJson(t)).catch(() => {});
      }
      return resp;
    });
  };

  // ─── Strategy 2: XHR interceptor ──────────────────────────────
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._fbUrl = url;
    return _origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (isFbApi(this._fbUrl || '')) {
      this.addEventListener('load', function () {
        scanJson(this.responseText);
      });
    }
    return _origSend.apply(this, arguments);
  };

  // ─── Strategy 3: WebSocket interceptor ────────────────────────
  const _OrigWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const ws = protocols ? new _OrigWS(url, protocols) : new _OrigWS(url);
    ws.addEventListener('message', (evt) => {
      if (typeof evt.data === 'string') {
        scanJson(evt.data);
      } else {
        // Binary MQTT — convert and look for JSON fragments
        const blob = evt.data instanceof Blob ? evt.data : new Blob([evt.data]);
        blob.text().then((txt) => {
          const frags = txt.match(/\{"[^}]{0,2000}\}/g);
          if (frags) frags.forEach((f) => scanJson(f));
        }).catch(() => {});
      }
    });
    return ws;
  };
  window.WebSocket.prototype = _OrigWS.prototype;

  function isFbApi(url) {
    return url && (
      url.includes('facebook.com/api/graphql') ||
      url.includes('business.facebook.com') ||
      url.includes('/messaging') ||
      url.includes('/inbox') ||
      url.includes('graphql')
    );
  }

  // ─── JSON scanner ─────────────────────────────────────────────
  function scanJson(text) {
    if (!text || text.length > 1500000) return;

    // FB often sends ndjson (one JSON per line)
    const lines = text.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('{')) {
        try { extractMessages(JSON.parse(t)); } catch (e) {}
      }
    }
    // Also try whole text as one JSON
    if (text.trim().startsWith('{')) {
      try { extractMessages(JSON.parse(text)); } catch (e) {}
    }
  }

  function extractMessages(obj, depth) {
    depth = depth || 0;
    if (depth > 15 || !obj || typeof obj !== 'object') return;

    // Pattern A: {message_id, body, author/sender}
    const mid = obj.message_id || obj.messageId;
    if (mid) {
      const id = String(mid);
      const text = obj.body || obj.text || (obj.message && (obj.message.text || obj.message.body)) || '';
      const sender = nameFrom(obj.author || obj.sender || obj.actor);
      if (text && !seenIds.has(id)) {
        markSeen(id);
        onNewMessage(sender, text);
        return;
      }
    }

    // Pattern B: {message: {id, text}} or {node: {id, message: ...}}
    if (obj.message && typeof obj.message === 'object') {
      const msg = obj.message;
      const id = String(msg.id || msg.message_id || '');
      const text = msg.text || msg.body || '';
      if (id && text && !seenIds.has(id)) {
        markSeen(id);
        const sender = nameFrom(obj.actor || obj.sender || obj.author || msg.sender);
        onNewMessage(sender, text);
        return;
      }
    }

    // Recurse — skip meta keys to avoid huge string scans
    if (Array.isArray(obj)) {
      for (let i = 0; i < Math.min(obj.length, 50); i++) {
        extractMessages(obj[i], depth + 1);
      }
    } else {
      for (const k of Object.keys(obj)) {
        if (k === '__typename' || k === 'extensions' || k === 'tracing') continue;
        extractMessages(obj[k], depth + 1);
      }
    }
  }

  function nameFrom(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    return obj.name || obj.displayName || obj.username || '';
  }

  function markSeen(id) {
    seenIds.add(id);
    if (seenIds.size > 800) {
      seenIds.delete(seenIds.values().next().value);
    }
  }

  // ─── Strategy 4: DOM badge polling ────────────────────────────
  // FB Business Suite shows unread count as small badge on tabs
  // e.g., "所有訊息 ①" — the number appears as a DOM element
  let lastBadgeCount = -1;

  function checkBadges() {
    let maxBadge = 0;

    // Approach A: look for small visible elements containing only a number
    document.querySelectorAll('span, div').forEach((el) => {
      if (!el.childElementCount && el.offsetWidth > 0 && el.offsetWidth < 35 && el.offsetHeight < 35) {
        const txt = (el.textContent || '').trim();
        if (/^\d{1,3}$/.test(txt)) {
          const n = parseInt(txt, 10);
          if (n > 0) maxBadge = Math.max(maxBadge, n);
        }
      }
    });

    // Approach B: aria-label with unread count on navigation tabs
    document.querySelectorAll('[role="tab"], [aria-label]').forEach((el) => {
      const label = el.getAttribute('aria-label') || '';
      const m = label.match(/(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > 0 && n < 10000) maxBadge = Math.max(maxBadge, n);
      }
    });

    if (lastBadgeCount >= 0 && maxBadge > lastBadgeCount) {
      onNewMessage('訪客', '（請點連結查看訊息）');
    }
    lastBadgeCount = maxBadge;
  }

  // ─── Strategy 5: Title polling (fallback) ─────────────────────
  let lastTitleCount = -1;

  function checkTitle() {
    const m = document.title.match(/^\((\d+)\)/);
    const count = m ? parseInt(m[1], 10) : 0;
    if (lastTitleCount >= 0 && count > lastTitleCount) {
      onNewMessage('訪客', '（請點連結查看訊息）');
    }
    lastTitleCount = count;
  }

  // ─── Init ─────────────────────────────────────────────────────
  // Start polling after DOM is ready
  function startPolling() {
    checkTitle();
    checkBadges();
    setInterval(checkTitle, 2000);
    setInterval(checkBadges, 3000);

    // Also observe title element
    const titleEl = document.querySelector('title');
    if (titleEl) new MutationObserver(checkTitle).observe(titleEl, { childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPolling);
  } else {
    startPolling();
  }

  console.log('[FB Alert v3] 注入成功 ✅', location.href);
})();
