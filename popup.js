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

// ─── Page groups (分類群組) — dynamic table ───────────────────
let _groups = [];

function parsePageGroups(text) {
  const rows = [];
  text.split('\n').forEach((line) => {
    const parts = line.split(/\t|,/).map((s) => s.trim());
    let name = '', id = '', group = '';
    if (parts.length >= 3) [name, id, group] = parts;
    else if (parts.length === 2) [id, group] = parts;
    else return;
    if (!/^\d+$/.test(id) || !group) return; // 跳過表頭或無效行
    rows.push({ name, id, group });
  });
  return rows;
}

function cleanGroups(rows) {
  return rows
    .map((r) => ({ name: (r.name || '').trim(), id: (r.id || '').trim(), group: (r.group || '').trim() }))
    .filter((r) => /^\d+$/.test(r.id) && r.group);
}

function buildGroupRow(row) {
  const div = document.createElement('div');
  div.className = 'group-row';
  div.innerHTML =
    '<input class="gname" type="text" placeholder="粉專名稱（可留空）">' +
    '<input class="gid" type="text" placeholder="Page ID">' +
    '<input class="ggroup" type="text" placeholder="群組">' +
    '<button class="gdel" type="button" title="刪除這列">✕</button>';
  const nameInput = div.querySelector('.gname');
  const idInput = div.querySelector('.gid');
  const groupInput = div.querySelector('.ggroup');
  nameInput.value = row.name;
  idInput.value = row.id;
  groupInput.value = row.group;
  nameInput.addEventListener('input', () => { row.name = nameInput.value; maybeGrow(row); });
  idInput.addEventListener('input', () => { row.id = idInput.value; maybeGrow(row); });
  groupInput.addEventListener('input', () => { row.group = groupInput.value; maybeGrow(row); });
  div.querySelector('.gdel').addEventListener('click', () => {
    const idx = _groups.indexOf(row);
    if (idx === -1) return;
    _groups.splice(idx, 1);
    if (_groups.length === 0) _groups.push({ name: '', id: '', group: '' });
    renderGroupTable();
  });
  return div;
}

// 只有「目前最後一列」被打字，且該列至少有一格非空，才自動 append 一條新空白列
// append 而非整表重繪，這樣打字中不會斷焦點/跳游標
function maybeGrow(row) {
  const idx = _groups.indexOf(row);
  if (idx === -1 || idx !== _groups.length - 1) return;
  if (!row.name && !row.id && !row.group) return;
  const newRow = { name: '', id: '', group: '' };
  _groups.push(newRow);
  $('groupTable').appendChild(buildGroupRow(newRow));
}

function renderGroupTable() {
  const container = $('groupTable');
  container.innerHTML = '';
  _groups.forEach((row) => container.appendChild(buildGroupRow(row)));
}

chrome.storage.sync.get(['pageGroups'], (d) => {
  const saved = Array.isArray(d.pageGroups) ? d.pageGroups : [];
  _groups = saved.length
    ? saved.map((r) => ({ name: r.name || '', id: r.id || '', group: r.group || '' }))
    : [{ name: '', id: '', group: '' }];
  renderGroupTable();
});

// 「解析貼上內容」：把快速貼上文字框的內容解析後覆蓋整個表格
$('parsePasteBtn').addEventListener('click', () => {
  const rows = parsePageGroups($('pageGroups').value);
  _groups = rows.length ? rows : [{ name: '', id: '', group: '' }];
  renderGroupTable();
  showStatus(rows.length ? `✅ 已解析 ${rows.length} 筆，記得按「儲存設定」` : '⚠️ 沒解析到有效的列', !rows.length);
});

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
    pageGroups: cleanGroups(_groups),
  };
  chrome.storage.sync.set(cfg, () => {});
  chrome.storage.local.set({ soundChoice: _soundChoice }, () => showStatus('✅ 已儲存'));
});

// Original v4.6 beep: 880→1100→880Hz oscillator (Web Audio API)
function playOriginalBeepInPopup() {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.setValueAtTime(880, ctx.currentTime);
  osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.12);
  osc.frequency.setValueAtTime(880, ctx.currentTime + 0.24);
  gain.gain.setValueAtTime(0.6, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.6);
}

// ─── Test sound (plays directly in popup — user gesture context) ──
$('testSoundBtn').addEventListener('click', () => {
  if (_soundChoice === '1') {
    try { playOriginalBeepInPopup(); showStatus('🔔 音效測試中…'); } catch (e) { showStatus('❌ 音效播放失敗', true); }
    return;
  }
  chrome.storage.local.get(['customSoundB64', 'customSoundMime'], (d) => {
    let url;
    if (_soundChoice === 'custom' && d.customSoundB64) {
      url = `data:${d.customSoundMime || 'audio/mpeg'};base64,${d.customSoundB64}`;
    } else {
      const n = ['2', '3'].includes(_soundChoice) ? _soundChoice : '2';
      url = chrome.runtime.getURL(`sound${n}.wav`);
    }
    new Audio(url).play().catch(e => showStatus('❌ 音效播放失敗', true));
  });
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
