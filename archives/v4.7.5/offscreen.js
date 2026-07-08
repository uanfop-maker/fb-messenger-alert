'use strict';

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PLAY_BEEP') {
    chrome.storage.local.get('customSoundB64', (d) => {
      if (d.customSoundB64) playCustomSound(d.customSoundB64);
      else playGeneratedBeep();
    });
  }
});

function playCustomSound(b64) {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const ctx = new AudioContext();
    ctx.decodeAudioData(bytes.buffer, (buffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0);
    }, () => playGeneratedBeep());
  } catch (e) {
    playGeneratedBeep();
  }
}

function playGeneratedBeep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.5, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  } catch (e) {
    console.warn('[Offscreen] 音效失敗:', e.message);
  }
}
