// FB Business Messenger Alert — Content Script
// Monitors new incoming messages, plays sound, forwards to Telegram

(function () {
  'use strict';

  let config = { botToken: '', chatId: '', enabled: true, soundEnabled: true, tgEnabled: true };
  let lastMessageKey = '';
  let observer = null;
  let observerRetries = 0;
  const MAX_RETRIES = 20;

  // Load config from storage
  function loadConfig(cb) {
    chrome.storage.sync.get(['botToken', 'chatId', 'enabled', 'soundEnabled', 'tgEnabled'], (data) => {
      config = {
        botToken: data.botToken || '',
        chatId: data.chatId || '',
        enabled: data.enabled !== false,
        soundEnabled: data.soundEnabled !== false,
        tgEnabled: data.tgEnabled !== false,
      };
      if (cb) cb();
    });
  }

  // Listen for config changes from popup
  chrome.storage.onChanged.addListener(() => loadConfig());

  // Generate beep using Web Audio API (no external file needed)
  function playBeep() {
    if (!config.soundEnabled) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.4, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.4);
    } catch (e) {
      console.warn('[FB Alert] 聲音播放失敗:', e);
    }
  }

  // Extract current fan page name from DOM
  function getPageName() {
    // Try account switcher / nav label (FB Business shows the current page name there)
    const selectors = [
      '[data-pagelet="LeftRail"] [role="heading"]',
      'nav [role="img"][aria-label]',
      '[aria-label*="帳號"] span',
      '[data-testid="page-account-switcher"] span',
      // Page name often appears in sidebar near the logo
      'aside h1, aside h2',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const text = (el.getAttribute('aria-label') || el.textContent || '').trim();
        if (text && text.length < 80 && !text.includes('http')) return text;
      }
    }
    // Fallback: document title (usually "粉絲頁名稱 | Meta Business Suite")
    const title = document.title;
    const parts = title.split('|');
    if (parts.length > 1) return parts[0].trim();
    return title.trim() || '未知粉絲頁';
  }

  // Send message to Telegram
  function sendToTelegram(senderName, messageText, pageAssetId) {
    if (!config.tgEnabled || !config.botToken || !config.chatId) return;
    const pageName = getPageName();
    const url = `https://business.facebook.com/latest/inbox/messenger?asset_id=${pageAssetId || ''}`;
    const text = `📨 FB 私訊通知\n🏪 粉絲頁：${pageName}\n👤 發訊者：${senderName}\n💬 ${messageText || '（非文字訊息）'}\n🔗 ${url}`;
    fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, text }),
    }).catch((e) => console.warn('[FB Alert] TG 發送失敗:', e));
  }

  // Extract asset_id from current URL
  function getAssetId() {
    const m = location.href.match(/asset_id=(\d+)/);
    return m ? m[1] : '';
  }

  // Extract sender name from a message node
  function extractSender(el) {
    // FB Business inbox: sender name is usually in aria-label or a heading near the message
    const aria = el.closest('[aria-label]');
    if (aria) {
      const label = aria.getAttribute('aria-label');
      if (label && label.length < 100) return label;
    }
    // Try to find name in heading tags near the message
    const heading = el.querySelector('h4, h3, [role="heading"]');
    if (heading) return heading.textContent.trim();
    return '未知發送者';
  }

  // Extract message text from a message node
  function extractText(el) {
    // Remove images, icons; get plain text
    const clone = el.cloneNode(true);
    clone.querySelectorAll('img, svg, [role="img"]').forEach(e => e.remove());
    return clone.textContent.trim().slice(0, 500);
  }

  // Generate a key for deduplication
  function makeKey(sender, text) {
    return `${sender}::${text}`;
  }

  // Called when we detect a new incoming message element
  function handleNewMessage(msgEl) {
    if (!config.enabled) return;

    const senderName = extractSender(msgEl);
    const messageText = extractText(msgEl);
    const key = makeKey(senderName, messageText);

    if (key === lastMessageKey) return; // deduplicate
    lastMessageKey = key;

    console.log(`[FB Alert] 新訊息 from: ${senderName} → ${messageText.slice(0, 80)}`);

    playBeep();
    sendToTelegram(senderName, messageText, getAssetId());
  }

  // Selector strategies for detecting new messages in FB Business inbox
  // FB changes DOM frequently — we try multiple strategies
  const MSG_SELECTORS = [
    // Thread message bubbles
    '[data-testid="message-container"]',
    '[data-testid="outgoing_message"]',
    '[data-testid="incoming_message"]',
    // Generic: divs with role=row that contain text
    '[role="row"]',
    // Class-based fallbacks (brittle but common)
    'div[class*="message"] div[class*="bubble"]',
    'div[class*="MessageContent"]',
  ];

  // Determine if an added node is likely a new incoming message
  function isIncomingMessage(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    // Check if it matches any of our selectors
    for (const sel of MSG_SELECTORS) {
      if (node.matches(sel) || node.querySelector(sel)) return true;
    }
    // Heuristic: element added to a thread container with text content
    const text = node.textContent.trim();
    if (text.length > 0 && text.length < 2000 && node.querySelector('span,p,div')) {
      // Check if it's inside the message thread area
      const inThread = node.closest('[role="main"], [aria-label*="訊息"], [aria-label*="Message"]');
      if (inThread) return true;
    }
    return false;
  }

  // Watch a specific container for new messages
  function watchContainer(container) {
    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (isIncomingMessage(node)) {
            // Small delay to let DOM settle
            setTimeout(() => handleNewMessage(node), 100);
          }
        }
      }
    });

    observer.observe(container, { childList: true, subtree: true });
    console.log('[FB Alert] 監聽啟動 ✅', container);
  }

  // Find the best container to observe
  function findContainer() {
    // FB Business inbox thread area
    const candidates = [
      document.querySelector('[role="main"]'),
      document.querySelector('[aria-label*="訊息"]'),
      document.querySelector('[aria-label*="Message"]'),
      document.querySelector('[aria-label*="Conversation"]'),
      document.querySelector('[data-testid="MWThreadList"]'),
      document.body,
    ];
    return candidates.find(Boolean);
  }

  // Start observing; retry until the container exists
  function startObserver() {
    const container = findContainer();
    if (container) {
      watchContainer(container);
    } else if (observerRetries < MAX_RETRIES) {
      observerRetries++;
      setTimeout(startObserver, 1500);
    } else {
      // Last resort: watch body
      console.warn('[FB Alert] 找不到訊息容器，改監聽 body');
      watchContainer(document.body);
    }
  }

  // Re-init when URL changes (SPA navigation between pages/inboxes)
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      observerRetries = 0;
      setTimeout(startObserver, 2000);
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Init
  loadConfig(() => {
    startObserver();
    console.log('[FB Alert] 插件已載入，等待新訊息...');
  });
})();
