// FB Alert Content Script v4.8.3 — audio played directly in page context (no offscreen)
(function () {
  'use strict';

  // ─── Context invalidation guard ───────────────────────────────
  // Two-layer defense:
  // 1. port.onDisconnect → killScript() when extension reloads (proactive)
  // 2. try-catch in callbacks — only killScript() on CONTEXT errors;
  //    other errors are swallowed so next timer tick can retry normally.
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
    const msg = (e && e.message) || '';
    return msg.includes('Extension context') || msg.includes('extension context');
  }

  try {
    const _port = chrome.runtime.connect({ name: 'fb-alert-cs' });
    _port.onDisconnect.addListener(killScript);
  } catch (e) {
    killScript();
    return;
  }

  function isAlive() { return !_dead; }

  function safeSend(msg) {
    if (!isAlive()) return;
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
    if (!isAlive()) return;
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

  function playAudioInContent(force) {
    try {
      const mode = _cfg.soundMode || 'once';
      if (!force && (mode === 'off' || inSleepWindow())) return;
      chrome.storage.local.get(['soundChoice', 'customSoundB64', 'customSoundMime'], (d) => {
        try {
          const choice = d.soundChoice || '1';
          let url;
          if (choice === 'custom' && d.customSoundB64) {
            url = `data:${d.customSoundMime || 'audio/mpeg'};base64,${d.customSoundB64}`;
          } else {
            const n = ['1', '2', '3'].includes(choice) ? choice : '1';
            url = chrome.runtime.getURL(`sound${n}.wav`);
          }
          new Audio(url).play().catch(() => {});
        } catch (e) {}
      });
    } catch (e) {}
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
    } catch (e) {}
  }

  // ─── Title watch ──────────────────────────────────────────────
  let _lastTitleCount = 0;

  function getTitleCount() {
    const m = document.title.match(/\((\d+)\)/);
    return m ? parseInt(m[1]) : 0;
  }

  function onTitleChange() {
    try {
      if (!isAlive() || _cfg.enabled === false || !_firstScanDone) return;
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
      if (!isAlive() || _cfg.enabled === false) return;
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
        const isNewMessage = _firstScanDone && data.unread && !isOutgoing && (!prev ||
          (data.dataUtime > 0 && data.dataUtime > (prev.dataUtime || 0)) ||
          (data.messageText && data.messageText !== prev.previewText));
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
      if (!isAlive()) return;
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
