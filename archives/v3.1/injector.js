// FB Alert Injector — runs in MAIN world (same JS context as FB's page code)
// Intercepts real page fetch/XHR/WebSocket, dispatches events to isolated content.js
(function () {
  'use strict';

  const CHANNEL = '__fb_alert_v3__';
  const seenIds = new Set();
  let lastFire = 0;
  const COOLDOWN = 6000;

  // ─── Page name (extracted once from inline scripts) ───────────
  let _pageName = '';

  function findPageName() {
    if (_pageName) return _pageName;
    try {
      const assetId = new URLSearchParams(location.search).get('asset_id');
      if (!assetId) return '';

      for (const s of document.querySelectorAll('script')) {
        const text = s.textContent || '';
        if (!text.includes(assetId)) continue;

        // Look for scope_name associated with this asset
        const re = /"scope_name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          try {
            const name = JSON.parse('"' + m[1] + '"');
            if (name && name.length > 1 && name.length < 60) {
              _pageName = name;
              return name;
            }
          } catch (e) {}
        }
        // Also try "name":"..." near asset_id occurrence
        const idx = text.indexOf(assetId);
        const nearby = text.slice(Math.max(0, idx - 200), idx + 200);
        const nameM = nearby.match(/"name"\s*:\s*"((?:[^"\\]|\\.){2,60})"/);
        if (nameM) {
          try {
            const name = JSON.parse('"' + nameM[1] + '"');
            if (name && name.length > 1 && name.length < 60) {
              _pageName = name;
              return name;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    return '';
  }

  function fire(senderName, messageText) {
    const now = Date.now();
    if (now - lastFire < COOLDOWN) return;
    lastFire = now;
    const pageName = findPageName();
    window.dispatchEvent(new CustomEvent(CHANNEL, {
      detail: { senderName: senderName || '', messageText: messageText || '', pageName }
    }));
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
            const parts = t.match(/\{[^\x00-\x1f]{5,}\}/g);
            if (parts) parts.forEach(scanText);
          }).catch(() => {});
        }
      } catch (e) {}
    });
    return ws;
  };
  window.WebSocket.prototype = _WS.prototype;

  // ─── Scanner ─────────────────────────────────────────────────
  function scanText(text) {
    if (!text || text.length > 1500000) return;
    const segs = text.split(/\r?\n/).filter(s => s.trim().startsWith('{'));
    if (!segs.length && text.trim().startsWith('{')) segs.push(text.trim());
    for (const seg of segs) {
      try { dig(JSON.parse(seg), 0); } catch (e) {}
    }
  }

  function dig(obj, depth) {
    if (depth > 12 || !obj || typeof obj !== 'object') return;

    // Pattern A: object with message_id + body/text
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

    // Pattern B: nested {message: {id, text}}
    if (obj.message && typeof obj.message === 'object' && !Array.isArray(obj.message)) {
      const m = obj.message;
      const id = String(m.id || m.message_id || '');
      const text = m.text || m.body || '';
      if (id && text && tryMarkSeen(id)) {
        fire(nameOf(obj.actor || obj.sender || m.sender), text);
        return;
      }
    }

    // Recurse
    if (Array.isArray(obj)) {
      for (let i = 0; i < Math.min(obj.length, 40); i++) dig(obj[i], depth + 1);
    } else {
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

  function tryMarkSeen(id) {
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    if (seenIds.size > 600) seenIds.delete(seenIds.values().next().value);
    return true;
  }

  // Try to cache page name early (after DOM ready)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', findPageName);
  } else {
    setTimeout(findPageName, 500);
  }

  console.log('[FB Alert Injector] 主世界 ✅', location.href);
})();
