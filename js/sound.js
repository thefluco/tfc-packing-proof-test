// Sound and vibration (design note section 5): a short beep means good, a long buzz means retake, three buzzes mean
// STOP. Vibration works on Android phones. The sound needs one tap on the page first (browsers start audio muted).
let ac = null;

function ctx() {
  try {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    return ac;
  } catch { return null; }
}

// Any tap unlocks the sound for the rest of the session.
export function unlock() {
  const go = () => { ctx(); window.removeEventListener('pointerdown', go, true); };
  window.addEventListener('pointerdown', go, true);
}

function tone(freq, ms, at = 0, type = 'sine', vol = 0.18) {
  const a = ctx();
  if (!a) return;
  try {
    const o = a.createOscillator(), g = a.createGain(), t = a.currentTime + at;
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.setValueAtTime(vol, t + ms / 1000 - 0.02); g.gain.linearRampToValueAtTime(0, t + ms / 1000);
    o.connect(g); g.connect(a.destination);
    o.start(t); o.stop(t + ms / 1000 + 0.01);
  } catch { /* no sound */ }
}
const vibrate = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch { /* not supported */ } };

export const last = { kind: '' };   // for the tests
export function good() { last.kind = 'good'; tone(1320, 130); vibrate(80); }
export function retake() { last.kind = 'retake'; tone(200, 700, 0, 'square', 0.12); vibrate(700); }
export function stop() { last.kind = 'stop'; for (const t of [0, 0.45, 0.9]) tone(170, 320, t, 'square', 0.16); vibrate([320, 130, 320, 130, 320]); }
