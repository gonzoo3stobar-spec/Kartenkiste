// Immediate shutter feedback; no assets or network requests required.
let shutterAudio = null;
export function shutterFeedback(video) {
  try { navigator.vibrate?.(35); } catch { /* optional hardware */ }
  try {
    video?.animate?.([{ opacity: 0.35 }, { opacity: 1 }], { duration: 160 });
  } catch { /* optional animation */ }
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    if (!shutterAudio || shutterAudio.state === 'closed') shutterAudio = new Audio();
    const ctx = shutterAudio;
    const play = () => {
      if (ctx.state !== 'running') return;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      const t = ctx.currentTime;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1200, t);
      osc.frequency.exponentialRampToValueAtTime(300, t + 0.065);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.075);
      osc.connect(gain).connect(ctx.destination);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
      osc.start(t); osc.stop(t + 0.08);
    };
    if (ctx.state === 'running') play();
    else ctx.resume().then(play).catch(() => {});
  } catch { /* feedback must never prevent a scan */ }
}
