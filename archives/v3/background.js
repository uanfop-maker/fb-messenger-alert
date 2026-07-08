'use strict';

// ─── Message handler ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'NEW_MESSAGE') {
    handleNewMessage(msg);
  } else if (msg.type === 'TEST_TG') {
    testTelegram(msg.botToken, msg.chatId, msg.threadId)
      .then(sendResponse);
    return true; // keep channel open for async
  } else if (msg.type === 'TEST_SOUND') {
    playSound();
  }
});

// ─── Handle new message ───────────────────────────────────────────
async function handleNewMessage({ senderName, messageText, pageName, pageUrl }) {
  const cfg = await chrome.storage.sync.get(['enabled', 'soundEnabled', 'tgEnabled', 'botToken', 'chatId', 'threadId']);
  if (cfg.enabled === false) return;

  if (cfg.soundEnabled !== false) {
    await playSound();
  }

  if (cfg.tgEnabled !== false && cfg.botToken && cfg.chatId) {
    await sendTelegram(cfg.botToken, cfg.chatId, cfg.threadId, senderName, messageText, pageName, pageUrl);
  }
}

// ─── Sound via offscreen document ────────────────────────────────
async function playSound() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'FB 私訊通知音效',
      });
    }
    chrome.runtime.sendMessage({ type: 'PLAY_BEEP' }).catch(() => {});
  } catch (e) {
    // Fallback: chrome.notifications (OS sound)
    chrome.notifications.create('sound-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: '📨 FB 新私訊',
      message: '有新的 FB Messenger 私訊',
    });
  }
}

// ─── Show chrome notification ─────────────────────────────────────
function showNotification(pageName, senderName, messageText) {
  chrome.notifications.create('fb-' + Date.now(), {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: `📨 FB 新私訊${pageName ? ' — ' + pageName : ''}`,
    message: `${senderName || '訪客'}：${messageText || '（非文字訊息）'}`,
  });
}

// ─── Telegram ─────────────────────────────────────────────────────
async function sendTelegram(botToken, chatId, threadId, senderName, messageText, pageName, pageUrl) {
  const text = [
    '📨 FB 私訊通知',
    `🏪 粉絲頁：${pageName || '未知'}`,
    `👤 發訊者：${senderName || '訪客'}`,
    `💬 ${messageText || '（非文字訊息）'}`,
    `🔗 ${pageUrl}`,
  ].join('\n');

  const body = { chat_id: chatId, text };
  if (threadId) body.message_thread_id = parseInt(threadId, 10);

  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!data.ok) console.warn('[BG] TG error:', data.description);
  } catch (e) {
    console.warn('[BG] TG fetch failed:', e.message);
  }
}

async function testTelegram(botToken, chatId, threadId) {
  const body = { chat_id: chatId, text: '✅ FB Messenger 提醒插件測試成功！\n\n如果你看到這則訊息，代表 TG 轉發功能正常。' };
  if (threadId) body.message_thread_id = parseInt(threadId, 10);
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await resp.json();
  } catch (e) {
    return { ok: false, description: e.message };
  }
}
