// FB Alert Content Script v4.0 — DOM-based per-thread detection
// Isolated world: full DOM access, can fetch api.telegram.org
(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────
  const threadState = {}; // key: 't{idx}' → { sender, previewText, dataUtime, unread }
  let _cfg = {};
  let _pageName = '';

  // ─── Config ──────────────────────────────────────────────────
  function reloadCfg() {
    chrome.storage.sync.get(null, (d) => { _cfg = d || {}; });
  }
  reloadCfg();
  chrome.storage.onChanged.addListener(reloadCfg);

  // ─── Page name (from data-surface) ───────────────────────────
  function getPageName() {
    if (_pageName) return _pageName;
    const m = location.href.match(/asset_id=(\d+)/);
    if (!m) return '未知粉絲頁';
    const assetId = m[1];
    const el = document.querySelector(`[data-surface*="business_scope:page:${assetId}:"]`);
    if (el) {
      const surface = el.getAttribute('data-surface') || '';
      const re = new RegExp(`business_scope:page:${assetId}:([^/"\\\\]+)`);
      const rm = surface.match(re);
      if (rm && rm[1]) { _pageName = rm[1]; return _pageName; }
    }
    return '未知粉絲頁';
  }

  function getPageUrl() {
    const m = location.href.match(/asset_id=(\d+)/);
    return m ? `https://business.facebook.com/latest/inbox/messenger?asset_id=${m[1]}` : location.href;
  }

  // ─── DOM helpers ─────────────────────────────────────────────
  function isUnread(previewWrapper) {
    if (!previewWrapper) return false;
    try {
      const fw = parseFloat(window.getComputedStyle(previewWrapper).fontWeight);
      if (!isNaN(fw)) return fw >= 600;
    } catch (e) {}
    // Fallback: FB's atomic CSS bold class
    return previewWrapper.classList.contains('x117nqv4');
  }

  function getThreadData(titleEl) {
    const surface = titleEl.getAttribute('data-surface') || '';
    const idxM = surface.match(/thread_row(\d+)/);
    if (!idxM) return null;
    const threadIdx = parseInt(idxM[1]);

    const sender = titleEl.textContent.trim();
    if (!sender) return null;

    // Walk up to find container holding both title and .xr9ek0c (message preview)
    let container = titleEl.parentElement;
    for (let i = 0; i < 10 && container; i++) {
      if (container.querySelector('.xr9ek0c')) break;
      container = container.parentElement;
    }
    if (!container) return null;

    const previewWrapper = container.querySelector('.xr9ek0c');
    const previewEl = previewWrapper && previewWrapper.querySelector('._4ik4');
    const messageText = (previewEl && previewEl.textContent.trim()) || '';

    const tsEl = container.querySelector('abbr.timestamp[data-utime]');
    const dataUtime = tsEl ? parseFloat(tsEl.getAttribute('data-utime')) : 0;

    return { threadIdx, sender, messageText, dataUtime, unread: isUnread(previewWrapper) };
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
    if (_cfg.enabled === false) return;

    const pageName = getPageName();
    // Select all thread title elements (covers thread_row0, thread_row1, ...)
    const titleEls = document.querySelectorAll(
      '[data-surface*="thread_list/thread_row"][data-surface*="thread_title"]'
    );

    let hasAnyUnread = false;

    for (const titleEl of titleEls) {
      const data = getThreadData(titleEl);
      if (!data) continue;

      const { threadIdx, sender, messageText, dataUtime, unread } = data;
      const key = `t${threadIdx}`;
      const prev = threadState[key];

      if (unread) hasAnyUnread = true;

      // Detect new message: unread AND (first time seeing this thread change, or preview/time changed)
      // Skip outgoing messages (FB prefixes them with "你:" or "You:")
      const isOutgoing = messageText.startsWith('你:') || messageText.startsWith('You:');
      const isNewMessage = !_firstScanDone
        ? false // Don't alert on initial page load
        : unread && !isOutgoing && (!prev ||
            (dataUtime > 0 && dataUtime > (prev.dataUtime || 0)) ||
            (messageText && messageText !== prev.previewText));

      if (isNewMessage) {
        console.log(`[FB Alert v4] 🔔 ${sender} | ${messageText.slice(0, 40)} | ${pageName}`);
        sendTelegram(pageName, sender, messageText);
        chrome.runtime.sendMessage({
          type: 'NEW_MESSAGE',
          senderName: sender,
          messageText,
          pageName,
          pageUrl: getPageUrl(),
        }).catch(() => {});
      }

      threadState[key] = { sender, previewText: messageText, dataUtime, unread };
    }

    // Tell background about unread status (for continuous alarm)
    chrome.runtime.sendMessage({ type: 'UNREAD_STATUS', hasUnread: hasAnyUnread }).catch(() => {});

    if (!_firstScanDone) _firstScanDone = true;
  }

  // ─── Init ────────────────────────────────────────────────────
  function init() {
    // Initial scan after short delay (let React render)
    setTimeout(() => {
      scanThreads();
      setInterval(scanThreads, 2000);
    }, 1500);
    console.log('[FB Alert v4] ✅ DOM scanner started', location.href);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
