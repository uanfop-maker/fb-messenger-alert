// FB Alert Content Script v4.6 — DOM-based per-thread detection
(function () {
  'use strict';

  const threadState = {};
  let _cfg = {};
  let _pageName = '';

  // Guard: stop all activity if extension context is invalidated
  function isAlive() { try { return !!chrome.runtime?.id; } catch(e) { return false; } }

  function safeSend(msg) {
    if (!isAlive()) return;
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch(e) {}
  }

  function reloadCfg() {
    if (!isAlive()) return;
    try { chrome.storage.sync.get(null, (d) => { _cfg = d || {}; }); } catch(e) {}
  }
  reloadCfg();
  try { chrome.storage.onChanged.addListener(reloadCfg); } catch(e) {}

  // ─── Page name (from data-surface, URL-independent) ──────────
  function getPageName() {
    if (_pageName) return _pageName;
    // Try URL first for asset_id
    const urlM = location.href.match(/asset_id=(\d+)/);
    // Search for business_scope:page:{id}:{name} in any data-surface element
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

  // ─── Find the thread_row wrapper span (ancestor of titleEl) ──
  // Walk UP from titleEl until we find an element whose data-surface
  // contains "thread_row\d+" but NOT "thread_title" — that's the row wrapper.
  function findRowWrapper(titleEl) {
    let el = titleEl.parentElement;
    for (let i = 0; i < 40 && el && el !== document.body; i++) {
      const s = el.getAttribute ? (el.getAttribute('data-surface') || '') : '';
      if (s && /thread_row\d+/.test(s) && !s.includes('thread_title')) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  // ─── DOM helpers ─────────────────────────────────────────────
  function isUnread(previewWrapper, titleEl) {
    // Primary: check previewWrapper (.xr9ek0c) for bold class or fontWeight
    if (previewWrapper) {
      if (previewWrapper.classList.contains('x117nqv4')) return true;
      try {
        const fw = parseFloat(window.getComputedStyle(previewWrapper).fontWeight);
        if (!isNaN(fw) && fw >= 600) return true;
      } catch (e) {}
    }
    // Fallback: check sender name div inside titleEl for bold class
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
    const surface = titleEl.getAttribute('data-surface') || '';
    const idxM = surface.match(/thread_row(\d+)/);
    if (!idxM) return null;
    const threadIdx = parseInt(idxM[1]);

    const sender = titleEl.textContent.trim();
    if (!sender) return null;

    // Find the thread_row wrapper span (common ancestor of titleEl and .xr9ek0c)
    const rowWrapper = findRowWrapper(titleEl);
    if (!rowWrapper) return null;

    const previewWrapper = rowWrapper.querySelector('.xr9ek0c');
    const previewEl = previewWrapper && previewWrapper.querySelector('._4ik4');
    const messageText = (previewEl && previewEl.textContent.trim()) || '';

    const tsEl = rowWrapper.querySelector('abbr[data-utime]') ||
                 rowWrapper.querySelector('[data-utime]');
    const dataUtime = tsEl ? parseFloat(tsEl.getAttribute('data-utime')) : 0;

    return {
      threadIdx,
      sender,
      messageText,
      dataUtime,
      unread: isUnread(previewWrapper, titleEl),
    };
  }

  // ─── Telegram ────────────────────────────────────────────────
  function sendTelegram(pageName, sender, messageText) {
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
  }

  // ─── Main scan ───────────────────────────────────────────────
  let _firstScanDone = false;

  function scanThreads() {
    if (!isAlive()) { clearInterval(_scanTimer); return; }
    if (_cfg.enabled === false) return;

    const pageName = getPageName();
    // Select all thread title elements (covers thread_row0, thread_row1, ...)
    const titleEls = document.querySelectorAll(
      '[data-surface*="thread_list/thread_row"][data-surface*="thread_title"]'
    );

    let hasAnyUnread = false;
    const seen = new Set();

    for (const titleEl of titleEls) {
      const data = getThreadData(titleEl);
      if (!data) continue;

      const { threadIdx, sender, messageText, dataUtime, unread } = data;

      // Deduplicate: FB sometimes renders the same thread_row twice (SSR + hydration)
      if (seen.has(threadIdx)) continue;
      seen.add(threadIdx);

      const key = `t${threadIdx}`;
      const prev = threadState[key];

      if (unread) hasAnyUnread = true;

      // Detect new message: unread AND (first time seeing this thread change, or preview/time changed)
      // Skip outgoing messages (FB prefixes them with "你:" or "You:")
      const isOutgoing = messageText.startsWith('你:') || messageText.startsWith('You:');
      const isNewMessage = !_firstScanDone
        ? false
        : unread && !isOutgoing && (!prev ||
            (dataUtime > 0 && dataUtime > (prev.dataUtime || 0)) ||
            (messageText && messageText !== prev.previewText));

      if (isNewMessage) {
        sendTelegram(pageName, sender, messageText);
        safeSend({ type: 'NEW_MESSAGE', senderName: sender, messageText, pageName, pageUrl: getPageUrl() });
      }

      threadState[key] = { sender, previewText: messageText, dataUtime, unread };
    }

    safeSend({ type: 'UNREAD_STATUS', hasUnread: hasAnyUnread });

    if (!_firstScanDone) _firstScanDone = true;
  }

  // ─── Init ────────────────────────────────────────────────────
  let _scanTimer;
  function init() {
    setTimeout(() => {
      scanThreads();
      _scanTimer = setInterval(scanThreads, 2000);
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
