'use strict';

const $ = (id) => document.getElementById(id);
const status = $('status');

const KEYS = ['botToken', 'chatId', 'threadId', 'enabled', 'tgEnabled', 'soundMode', 'beepIntervalSec', 'sleepStart', 'sleepEnd'];

let _soundMode = 'once';

// ─── Sound mode UI ────────────────────────────────────────────
document.querySelectorAll('.radio-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    _soundMode = btn.dataset.mode;
    updateModeUI();
  });
});

function updateModeUI() {
  document.querySelectorAll('.radio-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === _soundMode);
  });
  $('intervalRow').classList.toggle('hidden', _soundMode !== 'continuous');
}

// ─── Load saved config ────────────────────────────────────────
chrome.storage.sync.get(KEYS, (data) => {
  $('botToken').value = data.botToken || '';
  $('chatId').value = data.chatId || '';
  $('threadId').value = data.threadId || '';
  $('enabled').checked = data.enabled !== false;
  $('tgEnabled').checked = data.tgEnabled !== false;
  $('beepIntervalSec').value = data.beepIntervalSec || 15;
  $('sleepStart').value = data.sleepStart || '';
  $('sleepEnd').value = data.sleepEnd || '';
  _soundMode = data.soundMode || 'once';
  updateModeUI();
});

// ─── Save ─────────────────────────────────────────────────────
$('saveBtn').addEventListener('click', () => {
  const cfg = {
    botToken: $('botToken').value.trim(),
    chatId: $('chatId').value.trim(),
    threadId: $('threadId').value.trim(),
    enabled: $('enabled').checked,
    tgEnabled: $('tgEnabled').checked,
    soundMode: _soundMode,
    beepIntervalSec: parseInt($('beepIntervalSec').value) || 15,
    sleepStart: $('sleepStart').value,
    sleepEnd: $('sleepEnd').value,
  };
  chrome.storage.sync.set(cfg, () => showStatus('✅ 已儲存'));
});

// ─── Test sound ───────────────────────────────────────────────
$('testSoundBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'TEST_SOUND' });
  showStatus('🔔 音效測試中…');
});

// ─── Test TG ──────────────────────────────────────────────────
$('testTgBtn').addEventListener('click', () => {
  const botToken = $('botToken').value.trim();
  const chatId = $('chatId').value.trim();
  const threadId = $('threadId').value.trim();
  if (!botToken || !chatId) { showStatus('❌ 請先填入 Bot Token 和 Chat ID', true); return; }
  showStatus('📲 傳送測試訊息…');
  chrome.runtime.sendMessage({ type: 'TEST_TG', botToken, chatId, threadId }, (resp) => {
    if (resp && resp.ok) showStatus('✅ TG 測試成功！');
    else showStatus(`❌ 失敗：${resp ? resp.description : '無回應'}`, true);
  });
});

function showStatus(msg, isError) {
  status.textContent = msg;
  status.className = 'status' + (isError ? ' error' : '');
  setTimeout(() => { status.textContent = ''; }, 3500);
}
