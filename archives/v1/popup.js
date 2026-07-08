const $ = id => document.getElementById(id);

const KEYS = ['botToken', 'chatId', 'enabled', 'soundEnabled', 'tgEnabled'];

// Load saved config
chrome.storage.sync.get(KEYS, data => {
  $('botToken').value = data.botToken || '';
  $('chatId').value = data.chatId || '';
  $('enabled').checked = data.enabled !== false;
  $('soundEnabled').checked = data.soundEnabled !== false;
  $('tgEnabled').checked = data.tgEnabled !== false;
});

// Save button
$('saveBtn').addEventListener('click', () => {
  const cfg = {
    botToken: $('botToken').value.trim(),
    chatId: $('chatId').value.trim(),
    enabled: $('enabled').checked,
    soundEnabled: $('soundEnabled').checked,
    tgEnabled: $('tgEnabled').checked,
  };
  chrome.storage.sync.set(cfg, () => {
    const s = $('status');
    s.textContent = '✅ 已儲存';
    s.className = 'status';
    setTimeout(() => { s.textContent = ''; }, 2000);
  });
});

// Test TG connection
function testTelegram(token, chatId) {
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: '✅ FB Messenger 提醒插件連線成功！' }),
  })
    .then(r => r.json())
    .then(d => {
      const s = $('status');
      if (d.ok) {
        s.textContent = '✅ Telegram 測試成功！';
        s.className = 'status';
      } else {
        s.textContent = `❌ 失敗：${d.description}`;
        s.className = 'status error';
      }
    })
    .catch(e => {
      $('status').textContent = `❌ 錯誤：${e.message}`;
      $('status').className = 'status error';
    });
}
