'use strict';
// FB Alert Background Service Worker v4.8.6
// Audio is now played directly by content.js; background only manages continuous-mode alarms

let _s = {};
chrome.storage.sync.get(null, (d) => { _s = d || {}; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    for (const [k, { newValue }] of Object.entries(changes)) _s[k] = newValue;
    updateAlarms();
  }
});

let _hasUnread = false;

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

// Send PLAY_AUDIO to content script (tab ID persisted in storage across SW restarts)
async function playSound() {
  const data = await chrome.storage.local.get('_fbTabId');
  if (!data._fbTabId) return;
  chrome.tabs.sendMessage(data._fbTabId, { type: 'PLAY_AUDIO' }).catch(() => {});
}

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Persist tab ID so we can reach content script after SW restart
  if (sender && sender.tab) {
    chrome.storage.local.set({ _fbTabId: sender.tab.id });
  }

  if (msg.type === 'NEW_MESSAGE') {
    const mode = _s.soundMode || 'once';
    if (mode === 'continuous') updateAlarms();
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
    const body = { chat_id: chatId, text: '✅ FB Messenger 提醒 v4.8.6 測試成功！' };
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
