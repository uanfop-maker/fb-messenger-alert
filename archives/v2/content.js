// FB Business Messenger Alert — Content Script v2
// Uses document.title change + XHR interception for reliable detection

(function () {
  'use strict';

  let config = { botToken: '', chatId: '', enabled: true, soundEnabled: true, tgEnabled: true };
  let audioCtx = null;
  let audioUnlocked = false;

  // ─── Config ───────────────────────────────────────────────────
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
  chrome.storage.onChanged.addListener(() => loadConfig());

  // ─── Audio ────────────────────────────────────────────────────
  // Unlock AudioContext on first user interaction (Chrome autoplay policy)
  function unlockAudio() {
    if (audioUnlocked) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Resume if suspended
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().then(() => { audioUnlocked = true; });
    } else {
      audioUnlocked = true;
    }
  }
  document.addEventListener('click', unlockAudio, { once: false, passive: true });
  document.addEventListener('keydown', unlockAudio, { once: false, passive: true });
  // Try to init immediately (works if page had prior interaction)
  setTimeout(unlockAudio, 1000);

  function playBeep() {
    if (!config.soundEnabled) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.5, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
      osc.start(audioCtx.currentTime);
      osc.stop(audioCtx.currentTime + 0.5);
    } catch (e) {
      console.warn('[FB Alert] 音效失敗:', e);
    }
  }

  // ─── Page name ───────────────────────────────────────────────
  function getPageName() {
    // FB Business title format: "粉絲頁名稱 | Meta Business Suite"
    const t = document.title.replace(/^\(\d+\)\s*/, ''); // remove unread count
    const parts = t.split('|');
    if (parts.length > 1) return parts[0].trim();
    return t.trim() || '未知粉絲頁';
  }

  function getAssetId() {
    const m = location.href.match(/asset_id=(\d+)/);
    return m ? m[1] : '';
  }

  // ─── Telegram ─────────────────────────────────────────────────
  function sendToTelegram(senderName, messageText) {
    if (!config.tgEnabled || !config.botToken || !config.chatId) return;
    const pageName = getPageName();
    const assetId = getAssetId();
    const url = assetId
      ? `https://business.facebook.com/latest/inbox/messenger?asset_id=${assetId}`
      : location.href;
    const text = [
      '📨 FB 私訊通知',
      `🏪 粉絲頁：${pageName}`,
      `👤 發訊者：${senderName || '訪客'}`,
      messageText ? `💬 ${messageText}` : '💬 （非文字訊息）',
      `🔗 ${url}`,
    ].join('\n');

    fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, text }),
    })
      .then(r => r.json())
      .then(d => { if (!d.ok) console.warn('[FB Alert] TG error:', d); })
      .catch(e => console.warn('[FB Alert] TG 失敗:', e));
  }

  // ─── Detection Strategy 1: document.title watch ──────────────
  // FB puts unread count in title: "(3) 收件匣 | Meta Business Suite"
  let lastUnreadCount = 0;
  let lastTitleChangeTime = 0;

  function checkTitle() {
    const title = document.title;
    const m = title.match(/^\((\d+)\)/);
    const count = m ? parseInt(m[1], 10) : 0;

    if (count > lastUnreadCount) {
      const now = Date.now();
      // Debounce: don't fire twice within 3s
      if (now - lastTitleChangeTime > 3000) {
        lastTitleChangeTime = now;
        console.log(`[FB Alert] 新訊息！未讀數 ${lastUnreadCount} → ${count}`);
        onNewMessage('訪客', '（請點連結查看訊息）');
      }
    }
    lastUnreadCount = count;
  }

  // Watch title via MutationObserver on <title> element
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(checkTitle).observe(titleEl, { childList: true });
  }
  // Also poll every 2s as fallback
  setInterval(checkTitle, 2000);

  // ─── Detection Strategy 2: Intercept XHR/Fetch ───────────────
  // FB Business uses GraphQL — intercept responses containing message data
  let lastApiMessageKey = '';

  function tryParseMessage(text) {
    // Look for message content in FB GraphQL responses
    if (!text || text.length > 500000) return null;
    try {
      // FB often sends multiple JSON objects separated by newlines (multipart)
      const lines = text.split('\n').filter(l => l.trim().startsWith('{'));
      for (const line of lines) {
        const d = JSON.parse(line);
        // Find message sender and text in GraphQL response
        const json = JSON.stringify(d);
        if (!json.includes('"message"') && !json.includes('"body"')) continue;

        // Try to extract sender name and message body
        const senderMatch = json.match(/"name"\s*:\s*"([^"]{1,80})"/);
        const msgMatch = json.match(/"text"\s*:\s*"([^"]{1,500})"|"body"\s*:\s*"([^"]{1,500})"/);
        if (senderMatch || msgMatch) {
          return {
            sender: senderMatch ? senderMatch[1] : '訪客',
            text: msgMatch ? (msgMatch[1] || msgMatch[2] || '') : '',
          };
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function handleApiResponse(responseText, url) {
    if (!url.includes('threads') && !url.includes('messaging') && !url.includes('graphql')) return;
    const parsed = tryParseMessage(responseText);
    if (parsed) {
      const key = `${parsed.sender}::${parsed.text.slice(0, 50)}`;
      if (key !== lastApiMessageKey) {
        lastApiMessageKey = key;
        // Only fire if we think it's truly a new incoming message
        // (title-based detection handles the main trigger; this enriches data)
      }
    }
  }

  // Override fetch to intercept API responses
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    return origFetch.apply(this, args).then(resp => {
      const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url) || '';
      if (url.includes('facebook.com') && (url.includes('graphql') || url.includes('api'))) {
        resp.clone().text().then(t => handleApiResponse(t, url)).catch(() => {});
      }
      return resp;
    });
  };

  // ─── Main trigger ─────────────────────────────────────────────
  let lastTriggerTime = 0;

  function onNewMessage(sender, text) {
    if (!config.enabled) return;
    const now = Date.now();
    if (now - lastTriggerTime < 3000) return; // global debounce
    lastTriggerTime = now;

    playBeep();
    sendToTelegram(sender, text);
  }

  // ─── Init ─────────────────────────────────────────────────────
  loadConfig(() => {
    // Initialize unread count baseline
    const m = document.title.match(/^\((\d+)\)/);
    lastUnreadCount = m ? parseInt(m[1], 10) : 0;
    console.log('[FB Alert] v2 啟動 ✅  初始未讀數:', lastUnreadCount, ' | Bot:', config.botToken ? '已設定' : '未設定');
  });
})();
