// FB Alert Injector — runs in MAIN world (same JS context as FB's page code)
// v3.2: LightSpeed array detection + DOM-based sender/page name + no time cooldown
(function () {
  'use strict';

  const CHANNEL = '__fb_alert_v3__';
  const seenIds = new Set();

  let _pageName = '';

  // ─── Page name from data-surface ─────────────────────────────
  function findPageName() {
    if (_pageName) return _pageName;
    try {
      const assetId = new URLSearchParams(location.search).get('asset_id');
      if (assetId) {
        // Primary: data-surface attribute contains page name
        const el = document.querySelector(`[data-surface*="business_scope:page:${assetId}:"]`);
        if (el) {
          const surface = el.getAttribute('data-surface') || '';
          const re = new RegExp(`business_scope:page:${assetId}:([^/"\\\\]+)`);
          const m = surface.match(re);
          if (m && m[1] && m[1].length < 60) {
            _pageName = m[1];
            return _pageName;
          }
        }

        // Fallback: scope_name in inline scripts
        for (const s of document.querySelectorAll('script')) {
          const text = s.textContent || '';
          if (!text.includes(assetId)) continue;
          const re2 = /"scope_name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
          let m2;
          while ((m2 = re2.exec(text)) !== null) {
            try {
              const name = JSON.parse('"' + m2[1] + '"');
              if (name && name.length > 1 && name.length < 60) {
                _pageName = name;
                return name;
              }
            } catch (e) {}
          }
        }
      }
    } catch (e) {}
    return '';
  }

  // ─── Sender name from DOM thread list ────────────────────────
  function getSenderFromDOM() {
    // thread_row0 = most recently active conversation (top of list)
    // data-surface contains ".../thread_row0/lib:thread_title"
    const titleEl = document.querySelector(
      '[data-surface*="/thread_row0"][data-surface*="thread_title"]'
    );
    if (titleEl) {
      const text = titleEl.textContent.trim();
      if (text && text.length > 0 && text.length < 60) return text;
    }
    return '';
  }

  // ─── Dispatch event ──────────────────────────────────────────
  function dispatch(senderName, messageText, pageName) {
    window.dispatchEvent(new CustomEvent(CHANNEL, {
      detail: { senderName: senderName || '訪客', messageText: messageText || '', pageName: pageName || '' }
    }));
  }

  function fire(senderName, messageText) {
    const pageName = findPageName();
    if (senderName) {
      dispatch(senderName, messageText, pageName);
    } else {
      // DOM updates async after WebSocket → wait briefly
      setTimeout(() => {
        const name = getSenderFromDOM();
        dispatch(name || '訪客', messageText, findPageName() || pageName);
      }, 200);
    }
  }

  // ─── Deduplication ────────────────────────────────────────────
  function tryMarkSeen(id) {
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    if (seenIds.size > 1000) seenIds.delete(seenIds.values().next().value);
    return true;
  }

  // ─── Scanner ─────────────────────────────────────────────────
  function scanText(text) {
    if (!text || text.length > 2000000) return;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || (t[0] !== '{' && t[0] !== '[')) continue;
      try { dig(JSON.parse(t), 0); } catch (e) {}
    }
    // Also try whole text if single chunk
    if (lines.length === 1) {
      try { dig(JSON.parse(text.trim()), 0); } catch (e) {}
    }
  }

  function dig(obj, depth) {
    if (depth > 15 || obj === null || obj === undefined) return;

    // ── Pattern C: LightSpeed upsertMessage array ────────────
    // Format 1: [5, "upsertMessage", "TEXT", [9], [19,type], [19,senderId], ...]
    // Format 2: [5, "upsertMessage", [9], [19,"contentTypes"], [19,senderId], "mid.$...", ts, "TEXT", ...]
    if (Array.isArray(obj) && obj.length >= 3 && obj[0] === 5 && obj[1] === 'upsertMessage') {
      let text = null, msgId = null;

      // Format 1: text is a non-empty string at index 2, not "contentTypes"
      if (typeof obj[2] === 'string' && obj[2].length > 0 && obj[2] !== 'contentTypes') {
        text = obj[2];
        // Find mid.$... anywhere in array
        for (let i = 3; i < obj.length && i < 20; i++) {
          if (typeof obj[i] === 'string' && obj[i].startsWith('mid.')) { msgId = obj[i]; break; }
        }
        msgId = msgId || ('ls1_' + text.slice(0, 40));
      }
      // Format 2: text appears after "mid.$..." (index ~7+)
      else if (
        (obj[2] === null || (Array.isArray(obj[2]) && obj[2][0] === 9)) &&
        Array.isArray(obj[3]) && obj[3][0] === 19
      ) {
        // Scan for mid.$... and take the string after it as text
        for (let i = 3; i < obj.length && i < 25; i++) {
          if (typeof obj[i] === 'string' && obj[i].startsWith('mid.')) {
            msgId = obj[i];
            // Text is typically 2 slots after mid
            if (typeof obj[i + 2] === 'string' && obj[i + 2].length > 0) {
              text = obj[i + 2];
            } else if (typeof obj[i + 1] === 'string' && !obj[i + 1].startsWith('[') && obj[i + 1].length > 0) {
              text = obj[i + 1];
            }
            break;
          }
        }
        // Also try: text could be at fixed positions
        if (!text) {
          for (let i = 5; i < Math.min(obj.length, 15); i++) {
            if (typeof obj[i] === 'string' && obj[i].length > 0 &&
                !obj[i].startsWith('mid.') && !obj[i].startsWith('{')) {
              text = obj[i]; break;
            }
          }
        }
      }

      if (text && text.length > 0 && text.length < 2000) {
        const id = msgId || ('txt_' + text.slice(0, 50));
        if (tryMarkSeen(id)) {
          fire('', text); // let DOM supply sender name
        }
      }
      return;
    }

    // ── Pattern A: {message_id, body/text} ───────────────────
    if (typeof obj === 'object' && !Array.isArray(obj)) {
      const mid = obj.message_id || obj.messageId;
      if (mid) {
        const id = String(mid);
        const text = obj.body || obj.text ||
          (obj.message && (obj.message.text || obj.message.body)) || '';
        if (text && tryMarkSeen(id)) {
          fire(nameOf(obj.author || obj.sender || obj.actor), text);
          return;
        }
      }

      // Pattern B: {message: {id, text}}
      if (obj.message && typeof obj.message === 'object' && !Array.isArray(obj.message)) {
        const m = obj.message;
        const id = String(m.id || m.message_id || '');
        const text = m.text || m.body || '';
        if (id && text && tryMarkSeen(id)) {
          fire(nameOf(obj.actor || obj.sender || m.sender), text);
          return;
        }
      }
    }

    // ── Recurse ───────────────────────────────────────────────
    if (Array.isArray(obj)) {
      for (let i = 0; i < Math.min(obj.length, 50); i++) {
        if (obj[i] && typeof obj[i] === 'object') dig(obj[i], depth + 1);
      }
    } else if (typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        if (k !== '__typename' && k !== 'extensions' && k !== 'tracing') {
          dig(obj[k], depth + 1);
        }
      }
    }
  }

  function nameOf(o) {
    if (!o) return '';
    if (typeof o === 'string') return o;
    return o.name || o.displayName || o.username || '';
  }

  // ─── Fetch interceptor ────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await _fetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (url && url.includes('facebook')) {
        resp.clone().text().then(scanText).catch(() => {});
      }
    } catch (e) {}
    return resp;
  };

  // ─── XHR interceptor ─────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) {
    this._alertUrl = url;
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      if ((this._alertUrl || '').includes('facebook')) {
        scanText(this.responseText);
      }
    });
    return _send.apply(this, arguments);
  };

  // ─── WebSocket interceptor ────────────────────────────────────
  const _WS = window.WebSocket;
  window.WebSocket = function (url, proto) {
    const ws = proto !== undefined ? new _WS(url, proto) : new _WS(url);
    ws.addEventListener('message', function (evt) {
      try {
        if (typeof evt.data === 'string') {
          scanText(evt.data);
        } else {
          const blob = evt.data instanceof Blob ? evt.data : new Blob([evt.data]);
          blob.text().then(t => {
            scanText(t);
          }).catch(() => {});
        }
      } catch (e) {}
    });
    return ws;
  };
  window.WebSocket.prototype = _WS.prototype;

  // ─── Init ─────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', findPageName);
  } else {
    setTimeout(findPageName, 500);
  }

  console.log('[FB Alert Injector v3.2] 主世界 ✅', location.href);
})();
