'use strict';
// FB Alert Background Service Worker v4.0
// Handles sound orchestration: one-time beep or continuous alarm
// TG notifications are sent directly from content.js

// ─── Settings cache ───────────────────────────────────────────
let _s = {};
chrome.storage.sync.get(null, (d) => { _s = d || {}; });
chrome.storage.onChanged.addListener((changes) => {
  for (const [k, { newValue }] of Object.entries(changes)) _s[k] = newValue;
  updateAlarms();
});

// ─── Unread state (reported by content.js) ───────────────────
let _hasUnread = false;

// ─── Sleep window check ───────────────────────────────────────
function inSleepWindow() {
  const { sleepStart, sleepEnd } = _s;
  if (!sleepStart || !sleepEnd) return false;
  const now = new Date();
  const [sh, sm] = sleepStart.split(':').map(Number);
  const [eh, em] = sleepEnd.split(':').map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e);
}

// ─── Offscreen document ───────────────────────────────────────
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'FB 私訊通知音效',
    });
  }
}

async function playSound() {
  try {
    await ensureOffscreen();
    chrome.runtime.sendMessage({ type: 'PLAY_BEEP' }).catch(() => {});
  } catch (e) {
    chrome.notifications.create('snd_' + Date.now(), {
      type: 'basic', iconUrl: 'icon128.png',
      title: '📨 FB 新私訊', message: '有新 FB Messenger 訊息',
    });
  }
}

// ─── Alarm management (continuous mode) ──────────────────────
function updateAlarms() {
  const mode = _s.soundMode || 'once';
  if (mode === 'continuous' && _hasUnread) {
    const sec = Math.max(5, parseInt(_s.beepIntervalSec) || 15);
    chrome.alarms.create('beepAlarm', { periodInMinutes: sec / 60 });
  } else {
    chrome.alarms.clear('beepAlarm');
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'beepAlarm') return;
  if (!_hasUnread) { chrome.alarms.clear('beepAlarm'); return; }
  if (!inSleepWindow()) await playSound();
});

// ─── Message handler ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Pass PLAY_BEEP through to offscreen (don't handle here)
  if (msg.type === 'PLAY_BEEP') return false;

  if (msg.type === 'NEW_MESSAGE') {
    const mode = _s.soundMode || 'once';
    if (mode !== 'off' && !inSleepWindow()) {
      playSound();
      if (mode === 'continuous') updateAlarms();
    }
    return false;
  }

  if (msg.type === 'UNREAD_STATUS') {
    const prev = _hasUnread;
    _hasUnread = msg.hasUnread;
    if (prev !== _hasUnread) updateAlarms();
    return false;
  }

  if (msg.type === 'TEST_SOUND') {
    playSound();
    return false;
  }

  if (msg.type === 'TEST_TG') {
    const { botToken, chatId, threadId } = msg;
    const body = { chat_id: chatId, text: '✅ FB Messenger 提醒 v4.0 測試成功！' };
    if (threadId) body.message_thread_id = parseInt(threadId, 10);
    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()).then(sendResponse).catch(e => sendResponse({ ok: false, description: e.message }));
    return true;
  }

  return false;
});
