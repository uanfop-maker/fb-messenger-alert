'use strict';

const $ = (id) => document.getElementById(id);
const status = $('status');

const KEYS = ['botToken', 'chatId', 'threadId', 'enabled', 'tgEnabled', 'soundMode', 'beepIntervalSec', 'sleepStart', 'sleepEnd'];

let _soundMode = 'once';
let _soundChoice = '1';

// ─── Sound mode UI ────────────────────────────────────────────
document.querySelectorAll('.radio-btn[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    _soundMode = btn.dataset.mode;
    updateModeUI();
  });
});

function updateModeUI() {
  document.querySelectorAll('.radio-btn[data-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === _soundMode);
  });
  $('intervalRow').classList.toggle('hidden', _soundMode !== 'continuous');
}

// ─── Sound choice UI ─────────────────────────────────────────
document.querySelectorAll('.radio-btn[data-choice]').forEach((btn) => {
  btn.addEventListener('click', () => {
    _soundChoice = btn.dataset.choice;
    updateChoiceUI();
  });
});

function updateChoiceUI() {
  document.querySelectorAll('.radio-btn[data-choice]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.choice === _soundChoice);
  });
  $('customSoundSection').style.display = _soundChoice === 'custom' ? '' : 'none';
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

chrome.storage.local.get(['soundChoice', 'customSoundName'], (d) => {
  _soundChoice = d.soundChoice || '1';
  updateChoiceUI();
  if (d.customSoundName) {
    $('soundName').textContent = d.customSoundName;
    $('clearSound').style.display = '';
  }
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
  chrome.storage.sync.set(cfg, () => {});
  chrome.storage.local.set({ soundChoice: _soundChoice }, () => showStatus('✅ 已儲存'));
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

// ─── Custom sound upload ──────────────────────────────────────
$('soundFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showStatus('❌ 檔案過大（上限 5MB）', true); return; }
  const reader = new FileReader();
  reader.onload = (ev) => {
    const arr = new Uint8Array(ev.target.result);
    let b64 = '';
    const chunk = 8192;
    for (let i = 0; i < arr.length; i += chunk) {
      b64 += String.fromCharCode(...arr.subarray(i, i + chunk));
    }
    b64 = btoa(b64);
    chrome.storage.local.set({ customSoundB64: b64, customSoundMime: file.type, customSoundName: file.name }, () => {
      $('soundName').textContent = file.name;
      $('clearSound').style.display = '';
      showStatus('✅ 音效已上傳：' + file.name);
    });
  };
  reader.readAsArrayBuffer(file);
  e.target.value = '';
});

$('clearSound').addEventListener('click', () => {
  chrome.storage.local.remove(['customSoundB64', 'customSoundMime', 'customSoundName'], () => {
    $('soundName').textContent = '未選擇音效';
    $('clearSound').style.display = 'none';
    showStatus('已清除自訂音效');
  });
});
