// FB Alert Content Script v4.9.0 — singleton AudioContext unlocked by user gesture
(function () {
  'use strict';

  // Only activate on FB Business inbox/messenger pages
  if (!location.pathname.includes('/inbox') && !location.pathname.includes('/messenger')) return;

  // ─── Context invalidation guard ───────────────────────────────
  let _dead = false;
  let _scanTimer = null;
  let _titleObserver = null;

  function killScript() {
    _dead = true;
    if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
    if (_titleObserver) { _titleObserver.disconnect(); _titleObserver = null; }
    _cfg = {};
  }

  function isContextError(e) {
    const msg = (e && (e.message || String(e))) || '';
    return msg.includes('Extension context') || msg.includes('extension context');
  }

  // chrome.runtime.id becomes undefined immediately on invalidation — faster than port disconnect
  function alive() { return !_dead && !!(chrome.runtime && chrome.runtime.id); }

  // SPA navigation guard: kill if page changed to a non-inbox/messenger URL
  function onValidPage() {
    return location.pathname.includes('/inbox') || location.pathname.includes('/messenger');
  }

  // Global backstop: catch uncatchable async/constructor context errors
  window.addEventListener('unhandledrejection', (ev) => {
    if (isContextError(ev.reason)) { ev.preventDefault(); killScript(); }
  });
  window.addEventListener('error', (ev) => {
    if (isContextError(ev.error)) { ev.preventDefault(); killScript(); }
  }, true);

  // Auto-reconnect port when SW wakes from sleep; only kill on true context invalidation
  function connectPort() {
    try {
      const port = chrome.runtime.connect({ name: 'fb-alert-cs' });
      port.onDisconnect.addListener(() => {
        if (!alive()) { killScript(); return; }
        // SW went to sleep — reconnect after 1s to re-establish channel
        setTimeout(() => { if (alive()) connectPort(); }, 1000);
      });
    } catch (e) {
      if (isContextError(e)) killScript();
    }
  }
  connectPort();

  function safeSend(msg) {
    if (!alive()) return;
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) {
      if (isContextError(e)) killScript();
    }
  }

  // ─── State ────────────────────────────────────────────────────
  const threadState = {};
  let _cfg = {};
  let _pageName = '';

  const _notified = new Map();
  function shouldNotify(sender, messageText, dataUtime) {
    // Use dataUtime (message timestamp) as key when available — stable across re-renders
    const key = (dataUtime > 0) ? `${sender}|${dataUtime}` : `${sender}|${messageText}`;
    const now = Date.now();
    for (const [k, ts] of _notified) { if (now - ts > 300000) _notified.delete(k); }
    if (_notified.has(key)) return false;
    _notified.set(key, now);
    return true;
  }

  function reloadCfg() {
    if (!alive()) return;
    try {
      chrome.storage.sync.get(null, (d) => { _cfg = d || {}; });
    } catch (e) {
      if (isContextError(e)) killScript();
    }
  }
  reloadCfg();
  try { chrome.storage.onChanged.addListener(reloadCfg); } catch (e) {}

  // ─── Page helpers ─────────────────────────────────────────────
  function getPageName() {
    if (_pageName) return _pageName;
    const urlM = location.href.match(/asset_id=(\d+)/);
    const allEls = document.querySelectorAll('[data-surface*="business_scope:page:"]');
    for (const el of allEls) {
      const s = el.getAttribute('data-surface') || '';
      const m = urlM
        ? s.match(new RegExp(`business_scope:page:${urlM[1]}:([^"\/\\\\]+)`))
        : s.match(/business_scope:page:\d+:([^"\/\\\\]+)/);
      if (m && m[1]) { _pageName = m[1]; return _pageName; }
    }
    return '未知粉絲頁';
  }

  function getPageUrl() {
    const m = location.href.match(/asset_id=(\d+)/);
    return m ? `https://business.facebook.com/latest/inbox/messenger?asset_id=${m[1]}` : location.href;
  }

  // ─── DOM helpers ─────────────────────────────────────────────
  function findRowWrapper(titleEl) {
    let el = titleEl.parentElement;
    for (let i = 0; i < 40 && el && el !== document.body; i++) {
      const s = el.getAttribute ? (el.getAttribute('data-surface') || '') : '';
      if (s && /thread_row\d+/.test(s) && !s.includes('thread_title')) return el;
      el = el.parentElement;
    }
    return null;
  }

  function isUnread(previewWrapper, titleEl) {
    if (previewWrapper) {
      if (previewWrapper.classList.contains('x117nqv4')) return true;
      try {
        const fw = parseFloat(window.getComputedStyle(previewWrapper).fontWeight);
        if (!isNaN(fw) && fw >= 600) return true;
      } catch (e) {}
    }
    if (titleEl) {
      const nameDiv = titleEl.querySelector('div');
      if (nameDiv && nameDiv.classList.contains('x117nqv4')) return true;
      try {
        const fw = nameDiv && parseFloat(window.getComputedStyle(nameDiv).fontWeight);
        if (!isNaN(fw) && fw >= 600) return true;
      } catch (e) {}
    }
    return false;
  }

  function getThreadData(titleEl) {
    try {
      const surface = titleEl.getAttribute('data-surface') || '';
      const idxM = surface.match(/thread_row(\d+)/);
      if (!idxM) return null;
      const threadIdx = parseInt(idxM[1]);
      const sender = titleEl.textContent.trim();
      if (!sender) return null;
      const rowWrapper = findRowWrapper(titleEl);
      if (!rowWrapper) return null;
      const previewWrapper = rowWrapper.querySelector('.xr9ek0c');
      const previewEl = previewWrapper && previewWrapper.querySelector('._4ik4');
      const messageText = (previewEl && previewEl.textContent.trim()) || '';
      const tsEl = rowWrapper.querySelector('abbr[data-utime]') || rowWrapper.querySelector('[data-utime]');
      const dataUtime = tsEl ? parseFloat(tsEl.getAttribute('data-utime')) : 0;
      return { threadIdx, sender, messageText, dataUtime, unread: isUnread(previewWrapper, titleEl) };
    } catch (e) { return null; }
  }

  // ─── Audio (played directly in page context) ─────────────────
  function inSleepWindow() {
    const { sleepStart, sleepEnd } = _cfg;
    if (!sleepStart || !sleepEnd) return false;
    const now = new Date();
    const [sh, sm] = sleepStart.split(':').map(Number);
    const [eh, em] = sleepEnd.split(':').map(Number);
    const cur = now.getHours() * 60 + now.getMinutes();
    const s = sh * 60 + sm;
    const e = eh * 60 + em;
    return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e);
  }

  // Singleton AudioContext — created once, unlocked by first user gesture on the FB page
  let _actx = null;
  function _getCtx() {
    if (!_actx) {
      try { _actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    }
    return _actx;
  }
  // Unlock on any user interaction so ctx.state becomes 'running'
  ['click', 'keydown', 'pointerdown'].forEach(function (ev) {
    document.addEventListener(ev, function _unlock() {
      const c = _getCtx();
      if (c && c.state === 'suspended') c.resume().catch(() => {});
      document.removeEventListener(ev, _unlock);
    }, { once: true, passive: true, capture: true });
  });

  // Original v4.6 beep: 880→1100→880Hz oscillator, 0.6s
  // Falls back to sound1.wav if AudioContext is still suspended (no user gesture yet)
  function playOriginalBeep() {
    try {
      const ctx = _getCtx();
      if (!ctx || ctx.state === 'suspended') {
        new Audio(chrome.runtime.getURL('sound1.wav')).play().catch(() => {});
        return;
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t = ctx.currentTime;
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.setValueAtTime(1100, t + 0.12);
      osc.frequency.setValueAtTime(880, t + 0.24);
      gain.gain.setValueAtTime(0.6, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
      osc.start(t);
      osc.stop(t + 0.6);
    } catch (e) {}
  }

  function playAudioInContent(force) {
    try {
      if (!alive()) return;
      const mode = _cfg.soundMode || 'once';
      if (!force && (mode === 'off' || inSleepWindow())) return;
      chrome.storage.local.get(['soundChoice', 'customSoundB64', 'customSoundMime'], (d) => {
        try {
          if (!alive()) return;
          const choice = d.soundChoice || '1';
          if (choice === '1') { playOriginalBeep(); return; }
          if (choice === 'custom' && d.customSoundB64) {
            const url = `data:${d.customSoundMime || 'audio/mpeg'};base64,${d.customSoundB64}`;
            new Audio(url).play().catch(() => {});
            return;
          }
          const n = ['2', '3'].includes(choice) ? choice : '2';
          const url = chrome.runtime.getURL(`sound${n}.wav`);
          new Audio(url).play().catch(() => {});
        } catch (e) { if (isContextError(e)) killScript(); }
      });
    } catch (e) { if (isContextError(e)) killScript(); }
  }

  // Listen for alarm-triggered audio from background (continuous mode)
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'PLAY_AUDIO') playAudioInContent(true);
    });
  } catch (e) {}

  // ─── Telegram ────────────────────────────────────────────────
  function sendTelegram(pageName, sender, messageText) {
    try {
      const { botToken, chatId, threadId, tgEnabled } = _cfg;
      if (tgEnabled === false || !botToken || !chatId) return;
      const text = [
        '📨 FB 私訊通知',
        `🏪 粉絲頁：${pageName || '未知'}`,
        `👤 發訊者：${sender || '訪客'}`,
        `💬 ${messageText || '（非文字訊息）'}`,
        `🔗 ${getPageUrl()}`,
      ].join('\n');
      const body = { chat_id: chatId, text };
      if (threadId) body.message_thread_id = parseInt(threadId, 10);
      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => {});
    } catch (e) { if (isContextError(e)) killScript(); }
  }

  // ─── Title watch ──────────────────────────────────────────────
  let _lastTitleCount = 0;

  function getTitleCount() {
    const m = document.title.match(/\((\d+)\)/);
    return m ? parseInt(m[1]) : 0;
  }

  function onTitleChange() {
    try {
      if (!alive() || _cfg.enabled === false || !_firstScanDone) return;
      const count = getTitleCount();
      if (count > _lastTitleCount) {
        _lastTitleCount = count;
        const pageName = getPageName();
        const titleEls = Array.from(document.querySelectorAll(
          '[data-surface*="thread_list/thread_row"][data-surface*="thread_title"]'
        ));
        let foundAny = false;
        for (const titleEl of titleEls) {
          const data = getThreadData(titleEl);
          if (!data || !data.unread) continue;
          const isOutgoing = data.messageText.startsWith('你:') || data.messageText.startsWith('You:');
          if (isOutgoing) continue;
          if (shouldNotify(data.sender, data.messageText, data.dataUtime)) {
            sendTelegram(pageName, data.sender, data.messageText);
            playAudioInContent();
            safeSend({ type: 'NEW_MESSAGE', senderName: data.sender, messageText: data.messageText, pageName, pageUrl: getPageUrl() });
            foundAny = true;
          }
        }
        if (!foundAny && shouldNotify('__offscreen__', String(count), 0)) {
          sendTelegram(pageName, '（未知）', '（新訊息在畫面外，請捲動查看）');
          playAudioInContent();
          safeSend({ type: 'NEW_MESSAGE', senderName: '未知', messageText: '（新訊息在畫面外）', pageName, pageUrl: getPageUrl() });
        }
        safeSend({ type: 'UNREAD_STATUS', hasUnread: true });
      }
      _lastTitleCount = count;
    } catch (e) {
      if (isContextError(e)) killScript();
    }
  }

  // ─── Scan ─────────────────────────────────────────────────────
  let _firstScanDone = false;

  function scanThreads() {
    try {
      if (!alive() || _cfg.enabled === false) return;
      const titleEls = Array.from(document.querySelectorAll(
        '[data-surface*="thread_list/thread_row"][data-surface*="thread_title"]'
      ));
      let hasAnyUnread = false;
      const seen = new Set();
      for (const titleEl of titleEls) {
        const data = getThreadData(titleEl);
        if (!data) continue;
        if (seen.has(data.threadIdx)) continue;
        seen.add(data.threadIdx);
        const key = `t${data.threadIdx}`;
        const prev = threadState[key];
        if (data.unread) hasAnyUnread = true;
        const isOutgoing = data.messageText.startsWith('你:') || data.messageText.startsWith('You:');
        // Only notify on truly new messages: new thread or newer timestamp
        // Removed messageText diff — FB re-renders text each scan causing false duplicates
        const isNewMessage = _firstScanDone && data.unread && !isOutgoing && (
          !prev ||
          (data.dataUtime > 0 && data.dataUtime > (prev.dataUtime || 0))
        );
        if (isNewMessage && shouldNotify(data.sender, data.messageText, data.dataUtime)) {
          const pageName = getPageName();
          sendTelegram(pageName, data.sender, data.messageText);
          playAudioInContent();
          safeSend({ type: 'NEW_MESSAGE', senderName: data.sender, messageText: data.messageText, pageName, pageUrl: getPageUrl() });
        }
        threadState[key] = { sender: data.sender, previewText: data.messageText, dataUtime: data.dataUtime, unread: data.unread };
      }
      safeSend({ type: 'UNREAD_STATUS', hasUnread: hasAnyUnread || getTitleCount() > 0 });
      if (!_firstScanDone) { _firstScanDone = true; _lastTitleCount = getTitleCount(); }
    } catch (e) {
      if (isContextError(e)) killScript();
    }
  }

  // ─── Init ────────────────────────────────────────────────────
  function safeCall(fn) {
    if (!onValidPage()) return;  // SPA nav away from inbox: skip but preserve _notified state
    try { fn(); } catch (e) { if (isContextError(e)) killScript(); }
  }

  function init() {
    // Set baseline immediately so MutationObserver doesn't fire with stale 0 during init
    _lastTitleCount = getTitleCount();
    const titleEl = document.querySelector('title');
    if (titleEl) {
      _titleObserver = new MutationObserver(() => safeCall(onTitleChange));
      _titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
    setTimeout(() => {
      if (!alive()) return;
      _lastTitleCount = getTitleCount();
      safeCall(scanThreads);
      _scanTimer = setInterval(() => safeCall(scanThreads), 2000);
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
