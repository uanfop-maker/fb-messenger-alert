'use strict';

const $ = (id) => document.getElementById(id);
const status = $('status');

const KEYS = ['botToken', 'chatId', 'threadId', 'enabled', 'soundEnabled', 'tgEnabled'];

// ─── Load saved config ────────────────────────────────────────────
chrome.storage.sync.get(KEYS, (data) => {
  $('botToken').value = data.botToken || '';
  $('chatId').value = data.chatId || '';
  $('threadId').value = data.threadId || '';
  $('enabled').checked = data.enabled !== false;
  $('soundEnabled').checked = data.soundEnabled !== false;
  $('tgEnabled').checked = data.tgEnabled !== false;
});

// ─── Save ─────────────────────────────────────────────────────────
$('saveBtn').addEventListener('click', () => {
  const cfg = {
    botToken: $('botToken').value.trim(),
    chatId: $('chatId').value.trim(),
    threadId: $('threadId').value.trim(),
    enabled: $('enabled').checked,
    soundEnabled: $('soundEnabled').checked,
    tgEnabled: $('tgEnabled').checked,
  };
  chrome.storage.sync.set(cfg, () => {
    showStatus('✅ 已儲存');
  });
});

// ─── Test sound ───────────────────────────────────────────────────
$('testSoundBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'TEST_SOUND' });
  showStatus('🔔 音效測試中…');
});

// ─── Test TG ──────────────────────────────────────────────────────
$('testTgBtn').addEventListener('click', () => {
  const botToken = $('botToken').value.trim();
  const chatId = $('chatId').value.trim();
  const threadId = $('threadId').value.trim();
  if (!botToken || !chatId) {
    showStatus('❌ 請先填入 Bot Token 和 Chat ID', true);
    return;
  }
  showStatus('📲 傳送測試訊息…');
  chrome.runtime.sendMessage({ type: 'TEST_TG', botToken, chatId, threadId }, (resp) => {
    if (resp && resp.ok) {
      showStatus('✅ TG 測試成功！');
    } else {
      showStatus(`❌ 失敗：${resp ? resp.description : '無回應'}`, true);
    }
  });
});

function showStatus(msg, isError) {
  status.textContent = msg;
  status.className = 'status' + (isError ? ' error' : '');
  setTimeout(() => { status.textContent = ''; }, 3500);
}
