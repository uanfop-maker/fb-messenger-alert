'use strict';

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PLAY_BEEP') {
    chrome.storage.local.get(['customSoundB64', 'customSoundMime', 'soundChoice'], (d) => {
      const choice = d.soundChoice || '1';
      if (choice === 'custom' && d.customSoundB64) {
        playCustomSound(d.customSoundB64, d.customSoundMime);
      } else {
        playBundledSound(['1', '2', '3'].includes(choice) ? choice : '1');
      }
    });
  }
});

function playBundledSound(n) {
  try {
    const audio = new Audio(chrome.runtime.getURL(`sound${n}.wav`));
    audio.play().catch(e => console.warn('[Offscreen] 播放失敗:', e.message));
  } catch (e) {
    console.warn('[Offscreen] 音效失敗:', e.message);
  }
}

function playCustomSound(b64, mime) {
  try {
    const audio = new Audio(`data:${mime || 'audio/mpeg'};base64,${b64}`);
    audio.play().catch(() => playBundledSound('1'));
  } catch (e) {
    playBundledSound('1');
  }
}
