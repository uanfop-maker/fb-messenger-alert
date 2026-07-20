'use strict';
// FB Alert Background Service Worker v4.12.0
// Changes: multi-tab unread map / system notification fallback / keepalive 30s

let _s = {};
chrome.storage.sync.get(null, (d) => { _s = d || {}; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    for (const [k, { newValue }] of Object.entries(changes)) _s[k] = newValue;
    updateAlarms();
  }
});

// L1: keepalive every 30s (was 24s which is below Chrome alarm minimum)
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });

// M1: per-tab unread map so multiple tabs don't clobber each other
const _unreadTabs = new Map();
let _prevAnyUnread = false;

function hasAnyUnread() {
  for (const v of _unreadTabs.values()) if (v) return true;
  return false;
}

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

// Broadcast PLAY_AUDIO to all tabs that currently have unread
async function playSound() {
  const unreadTabIds = [..._unreadTabs.entries()].filter(([, u]) => u).map(([id]) => id);
  if (unreadTabIds.length) {
    for (const tabId of unreadTabIds) {
      chrome.tabs.sendMessage(tabId, { type: 'PLAY_AUDIO' }).catch(() => {});
    }
    return;
  }
  // Fallback: last known tab (persisted across SW restarts)
  const d = await chrome.storage.local.get('_fbTabId');
  if (d._fbTabId) chrome.tabs.sendMessage(d._fbTabId, { type: 'PLAY_AUDIO' }).catch(() => {});
}

function updateAlarms() {
  const mode = _s.soundMode || 'once';
  if (mode === 'continuous' && hasAnyUnread()) {
    const sec = Math.max(5, parseInt(_s.beepIntervalSec) || 15);
    chrome.alarms.create('beepAlarm', { periodInMinutes: sec / 60 });
  } else {
    chrome.alarms.clear('beepAlarm');
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepalive') return;
  if (alarm.name !== 'beepAlarm') return;
  if (!hasAnyUnread()) { chrome.alarms.clear('beepAlarm'); return; }
  if (!inSleepWindow()) await playSound();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender && sender.tab) {
    chrome.storage.local.set({ _fbTabId: sender.tab.id });
  }

  if (msg.type === 'NEW_MESSAGE') {
    if (_s.soundMode === 'continuous') updateAlarms();
    return false;
  }

  if (msg.type === 'UNREAD_STATUS') {
    if (sender && sender.tab) {
      _unreadTabs.set(sender.tab.id, msg.hasUnread);
    }
    const now = hasAnyUnread();
    if (now !== _prevAnyUnread) {
      _prevAnyUnread = now;
      updateAlarms();
    }
    return false;
  }

  // H2: system notification when AudioContext blocked by autoplay policy
  if (msg.type === 'SHOW_NOTIFICATION') {
    chrome.notifications.create('fb-alert-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icon48.png',
      title: msg.title || 'FB 新私訊',
      message: msg.body || '有新訊息',
    });
    return false;
  }

  if (msg.type === 'TEST_SOUND') {
    playSound();
    return false;
  }

  if (msg.type === 'TEST_TG') {
    const { botToken, chatId, threadId } = msg;
    const body = { chat_id: chatId, text: '✅ FB Messenger 提醒 v4.12.0 測試成功！' };
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
