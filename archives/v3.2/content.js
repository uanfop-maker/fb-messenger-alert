// FB Alert Content Script — isolated world v3.2
// Receives events from injector.js (main world) via CustomEvent
// Handles chrome.* APIs + fallback badge/title polling

(function () {
  'use strict';

  const CHANNEL = '__fb_alert_v3__';
  // No time-based cooldown — injector deduplicates per message ID

  // ─── Page info ────────────────────────────────────────────────
  function getPageName() {
    // Try title: "[Page Name] | Meta Business Suite"
    const t = document.title.replace(/^\(\d+\)\s*/, '');
    const parts = t.split('|');
    const fromTitle = parts.length > 1 ? parts[0].trim() : '';

    if (fromTitle && fromTitle !== 'Meta Business Suite' && fromTitle !== '收件匣' && fromTitle !== 'Inbox') {
      return fromTitle;
    }

    // Try DOM: look for the account/page switcher button text
    // FB Business Suite shows the selected page name in navigation
    const selectors = [
      '[data-testid="page_header_name"]',
      'h1',
      '[aria-label*="目前的粉絲專頁"]',
      '[aria-label*="Current Page"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const txt = (el.textContent || el.getAttribute('aria-label') || '').trim();
        if (txt && txt.length < 60 && txt !== 'Meta Business Suite') return txt;
      }
    }

    // Fallback: check role="banner" h1-like elements
    const bannerEls = document.querySelectorAll('[role="banner"] span, [role="navigation"] span');
    for (const el of bannerEls) {
      const txt = (el.textContent || '').trim();
      if (txt.length > 1 && txt.length < 50 && /^[^\d]/.test(txt)) return txt;
    }

    return fromTitle || '未知粉絲頁';
  }

  function getPageUrl() {
    const m = location.href.match(/asset_id=(\d+)/);
    return m
      ? `https://business.facebook.com/latest/inbox/messenger?asset_id=${m[1]}`
      : location.href;
  }

  // ─── Core trigger ─────────────────────────────────────────────
  function onNewMessage(senderName, messageText, injectedPageName) {
    const pageName = injectedPageName || getPageName();
    const pageUrl = getPageUrl();
    console.log(`[FB Alert v3] 🔔 ${senderName || '?'} | ${(messageText || '').slice(0, 40)} | ${pageName}`);

    chrome.runtime.sendMessage({
      type: 'NEW_MESSAGE',
      senderName: senderName || '訪客',
      messageText: messageText || '（請點連結查看訊息）',
      pageName,
      pageUrl,
    });
  }

  // ─── Receive from main world injector ────────────────────────
  window.addEventListener(CHANNEL, (evt) => {
    const { senderName, messageText, pageName: injectedPage } = evt.detail || {};
    onNewMessage(senderName, messageText, injectedPage);
  });

  // ─── Fallback 1: document.title polling ───────────────────────
  let lastTitleCount = -1;

  function checkTitle() {
    const m = document.title.match(/^\((\d+)\)/);
    const count = m ? parseInt(m[1], 10) : 0;
    if (lastTitleCount >= 0 && count > lastTitleCount) {
      onNewMessage('訪客', '（請點連結查看訊息）');
    }
    lastTitleCount = count;
  }

  // ─── Fallback 2: DOM unread badge polling ─────────────────────
  // FB Business Suite shows unread count as a red badge on tabs
  let lastBadgeMax = -1;

  function checkBadges() {
    let max = 0;

    // Look for small elements (badge-like) containing just a number
    document.querySelectorAll('span, div').forEach((el) => {
      if (!el.childElementCount && el.offsetWidth > 0 && el.offsetWidth < 35 && el.offsetHeight < 35) {
        const txt = (el.textContent || '').trim();
        if (/^\d{1,3}$/.test(txt)) {
          const n = parseInt(txt, 10);
          if (n > 0) max = Math.max(max, n);
        }
      }
    });

    // Also check aria-label on tabs for unread count
    document.querySelectorAll('[role="tab"], [role="button"]').forEach((el) => {
      const label = el.getAttribute('aria-label') || '';
      const m = label.match(/(\d+)\s*(unread|未讀)/i);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });

    if (lastBadgeMax >= 0 && max > lastBadgeMax) {
      onNewMessage('訪客', '（請點連結查看訊息）');
    }
    lastBadgeMax = max;
  }

  // ─── Init ─────────────────────────────────────────────────────
  function startPolling() {
    checkTitle();
    checkBadges();

    const titleEl = document.querySelector('title');
    if (titleEl) new MutationObserver(checkTitle).observe(titleEl, { childList: true });

    setInterval(checkTitle, 2000);
    setInterval(checkBadges, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPolling);
  } else {
    startPolling();
  }

  console.log('[FB Alert v3] 隔離環境 ✅', location.href);
})();
