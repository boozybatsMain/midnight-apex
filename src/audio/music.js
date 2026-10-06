// Procedural dark-synthwave loop (A minor, 120 BPM): four-on-the-floor kick, gated-reverb snare,
// 16th hats, octave-bouncing saw bass, detuned saw pad with sidechain pump, dotted-8th delayed arp.
// Scheduled with a look-ahead scheduler ("A Tale of Two Clocks"): a coarse JS timer schedules notes
// slightly ahead on the sample-accurate AudioContext clock.

import { midiToHz } from './dsp.js';

const BPM = 120;
const STEP = 60 / BPM / 4; // 16th note
const STEPS_PER_BAR = 16;
// Song form (bars). Each section: chord indices into PROGRESSION + which parts play.
const FORM = [
  { bars: [0, 1, 2, 3, 4, 5, 6, 7], kick: 1, snare: 1, hats: 1, bass: 1, pad: 1, arp: 0, crash: 1 }, // A
  { bars: [0, 1, 2, 3, 4, 5, 6, 7], kick: 1, snare: 1, hats: 1, bass: 1, pad: 1, arp: 1, crash: 1 }, // B
  { bars: [0, 1, 6, 7], kick: 0, snare: 0, hats: 0.5, bass: 0, pad: 1, arp: 1, crash: 0 }, // breakdown
  { bars: [0, 1, 6, 7], kick: 1, snare: 2, hats: 1, bass: 0.5, pad: 1, arp: 0, crash: 0 }, // build (snare roll)
  { bars: [0, 1, 2, 3, 4, 5, 6, 7], kick: 1, snare: 1, hats: 1, bass: 1, pad: 1, arp: 2, crash: 1 }, // B2 (arp up)
];
const SONG = [];
for (const sec of FORM) sec.bars.forEach((chord, i) => SONG.push({ chord, sec, first: i === 0, last: i === sec.bars.length - 1, idx: i, n: sec.bars.length }));
const BARS = SONG.length; // 32 bars = 64 s per cycle at 120 BPM

// chord per bar: bass root (midi) + pad voicing + arp tones
const PROGRESSION = [
  { root: 33, pad: [57, 60, 64], arp: [69, 72, 76, 81] }, // Am
  { root: 29, pad: [57, 60, 65], arp: [65, 69, 72, 77] }, // F
  { root: 36, pad: [55, 60, 64], arp: [67, 72, 76, 79] }, // C
  { root: 31, pad: [55, 59, 62], arp: [67, 71, 74, 79] }, // G
  { root: 33, pad: [57, 60, 64], arp: [69, 72, 76, 81] }, // Am
  { root: 29, pad: [57, 60, 65], arp: [65, 69, 72, 77] }, // F
  { root: 38, pad: [57, 62, 65], arp: [62, 65, 69, 74] }, // Dm
  { root: 28, pad: [56, 59, 64], arp: [64, 68, 71, 76] }, // E (harmonic-minor dominant)
];
// 16th bass pattern (semitone offsets from the root; null = rest)
const BASS = [0, 12, 0, 12, 0, 12, 0, 12, 0, 12, 0, 12, 0, 12, 7, 12];
const HAT_VEL = [0.55, 0.25, 0.4, 0.25, 0.55, 0.25, 0.4, 0.3, 0.55, 0.25, 0.4, 0.25, 0.55, 0.25, 0.45, 0.3];
const ARP_ORDER = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 3, 2, 1, 2];

export function createMusic(ctx, destination, reverbIn, noiseBuffer) {
  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(destination);

  // gentle master tone for the music bus: roll off sub rumble + harsh top so it sits under the engine
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 38;
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 9000;
  hp.connect(tone).connect(out);

  // sidechain-pumped bus for bass + pad + arp
  const pump = ctx.createGain();
  pump.connect(hp);
  const drums = ctx.createGain();
  drums.gain.value = 0.9;
  drums.connect(hp);

  // pad bus with slowly sweeping low-pass
  const padFilter = ctx.createBiquadFilter();
  padFilter.type = 'lowpass';
  padFilter.frequency.value = 1100;
  padFilter.Q.value = 2.5;
  const padGain = ctx.createGain();
  padGain.gain.value = 0.5;
  padFilter.connect(padGain).connect(pump);
  const padLfo = ctx.createOscillator();
  padLfo.frequency.value = 1 / 16; // one sweep per 8 bars
  const padLfoAmt = ctx.createGain();
  padLfoAmt.gain.value = 500;
  padLfo.connect(padLfoAmt).connect(padFilter.frequency);

  // tempo-synced dotted-8th feedback delay for the arp
  const delay = ctx.createDelay(1.0);
  delay.delayTime.value = STEP * 3;
  const fb = ctx.createGain();
  fb.gain.value = 0.38;
  const dTone = ctx.createBiquadFilter();
  dTone.type = 'lowpass';
  dTone.frequency.value = 2600;
  delay.connect(dTone).connect(fb).connect(delay);
  const dOut = ctx.createGain();
  dOut.gain.value = 0.45;
  dTone.connect(dOut).connect(pump);

  const verbSend = ctx.createGain();
  verbSend.gain.value = 1;
  if (reverbIn) verbSend.connect(reverbIn);
  const padVerb = ctx.createGain();
  padVerb.gain.value = 0.25;
  padGain.connect(padVerb).connect(verbSend);

  let timer = null;
  let on = false;
  let started = false;
  let nextTime = 0;
  let step = 0;
  let level = 0.2;
  let stopTimer = null;

  const voices = new Set(); // keep refs until ended (and allow hard stop)
  const track = (src, stopAt) => {
    voices.add(src);
    src.onended = () => {
      voices.delete(src);
      try { src.disconnect(); } catch (e) { /* ignore */ }
    };
    src.stop(stopAt);
  };

  function noiseSrc(t) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuffer;
    s.loop = true;
    s.start(t, Math.random() * (noiseBuffer.duration - 0.5));
    return s;
  }

  function kick(t) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.95, t + 0.004);
    g.gain.setTargetAtTime(0.0001, t + 0.03, 0.09);
    o.connect(g).connect(drums);
    o.start(t);
    track(o, t + 0.55);
    // sidechain duck
    pump.gain.setValueAtTime(1, t);
    pump.gain.linearRampToValueAtTime(0.42, t + 0.012);
    pump.gain.setTargetAtTime(1, t + 0.04, 0.09);
  }

  function snare(t, vel = 1) {
    const n = noiseSrc(t);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.42 * vel, t + 0.002);
    g.gain.setTargetAtTime(0.0001, t + 0.01, 0.055);
    n.connect(bp).connect(g);
    g.connect(drums);
    // big 80s reverb send
    const vs = ctx.createGain();
    vs.gain.value = 0.9;
    g.connect(vs).connect(verbSend);
    track(n, t + 0.4);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(210, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.06);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.3 * vel, t + 0.002);
    og.gain.setTargetAtTime(0.0001, t + 0.005, 0.03);
    o.connect(og).connect(drums);
    o.start(t);
    track(o, t + 0.3);
  }

  function hat(t, vel, open) {
    const n = noiseSrc(t);
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = open ? 6500 : 7800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16 * vel, t + 0.001);
    g.gain.setTargetAtTime(0.0001, t + 0.002, open ? 0.06 : 0.014);
    n.connect(hpf).connect(g).connect(drums);
    track(n, t + (open ? 0.4 : 0.12));
  }

  function bass(t, midi, dur) {
    const f = midiToHz(midi);
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    o1.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.value = f;
    o2.detune.value = -9;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 5;
    lp.frequency.setValueAtTime(1900, t);
    lp.frequency.setTargetAtTime(260, t, 0.045);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.004);
    g.gain.setTargetAtTime(0.13, t + 0.01, 0.06);
    g.gain.setTargetAtTime(0.0001, t + dur, 0.015);
    const m = ctx.createGain();
    m.gain.value = 0.5;
    o1.connect(lp);
    o2.connect(m).connect(lp);
    lp.connect(g).connect(pump);
    o1.start(t);
    o2.start(t);
    track(o1, t + dur + 0.12);
    track(o2, t + dur + 0.12);
  }

  function pad(t, notes, dur) {
    for (const m of notes) {
      for (const det of [-8, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiToHz(m);
        o.detune.value = det + (Math.random() - 0.5) * 4;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.05, t + 0.45);
        g.gain.setValueAtTime(0.05, t + dur - 0.05);
        g.gain.setTargetAtTime(0.0001, t + dur - 0.05, 0.25);
        o.connect(g).connect(padFilter);
        o.start(t);
        track(o, t + dur + 1.4);
      }
    }
  }

  function arp(t, midi) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = midiToHz(midi);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.003);
    g.gain.setTargetAtTime(0.0001, t + 0.01, 0.05);
    o.connect(lp).connect(g);
    g.connect(pump);
    g.connect(delay);
    o.start(t);
    track(o, t + 0.35);
  }

  function crash(t) {
    const n = noiseSrc(t);
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = 5200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.002);
    g.gain.setTargetAtTime(0.0001, t + 0.01, 0.45);
    n.connect(hpf).connect(g);
    g.connect(drums);
    g.connect(verbSend);
    track(n, t + 2.6);
  }

  function scheduleStep(s, t) {
    const barIdx = Math.floor(s / STEPS_PER_BAR) % BARS;
    const i = s % STEPS_PER_BAR;
    const bar = SONG[barIdx];
    const sec = bar.sec;
    const ch = PROGRESSION[bar.chord];
    if (bar.first && i === 0 && sec.crash) crash(t);
    if (sec.kick && i % 4 === 0) kick(t);
    if (sec.snare === 1 && (i === 4 || i === 12)) snare(t);
    else if (sec.snare === 2) {
      // build: half-time snare, then 8ths, then a 16th roll in the last bar (rising velocity)
      const roll = bar.last ? true : bar.idx >= bar.n - 2 ? i % 2 === 0 : i === 8;
      if (roll) snare(t, bar.last ? 0.35 + 0.65 * (i / 15) : 0.8);
    }
    if (sec.hats >= 1 || (sec.hats > 0 && i % 4 === 2)) hat(t, HAT_VEL[i], i % 4 === 2);
    const b = BASS[i];
    if (sec.bass >= 1 || (sec.bass > 0 && bar.idx >= bar.n / 2)) bass(t, ch.root + b, STEP * 0.8);
    if (i === 0 && sec.pad) pad(t, ch.pad, STEP * STEPS_PER_BAR);
    if (sec.arp === 1 && i % 2 === 0) arp(t, ch.arp[ARP_ORDER[i] % ch.arp.length]);
    else if (sec.arp === 2) arp(t, ch.arp[ARP_ORDER[i] % ch.arp.length] + (i % 2 ? 12 : 0));
  }

  function schedule(ahead = 0.16) {
    if (!on) return;
    const now = ctx.currentTime;
    if (nextTime < now - 0.05) nextTime = now + 0.03; // fell behind (tab throttled): skip, never burst
    while (nextTime < now + ahead) {
      scheduleStep(step, nextTime);
      nextTime += STEP;
      step = (step + 1) % (STEPS_PER_BAR * BARS);
    }
  }

  return {
    get on() { return on; },
    setLevel(v) {
      level = v;
      if (on) out.gain.setTargetAtTime(level, ctx.currentTime, 0.5);
    },
    start(fromBar = 0) {
      if (on) return;
      on = true;
      if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
      if (!started) { padLfo.start(); started = true; }
      step = (Math.max(0, fromBar | 0) % BARS) * STEPS_PER_BAR;
      nextTime = ctx.currentTime + 0.08;
      out.gain.cancelScheduledValues(ctx.currentTime);
      out.gain.setValueAtTime(out.gain.value, ctx.currentTime);
      out.gain.setTargetAtTime(level, ctx.currentTime, 0.9);
      schedule();
      if (typeof setInterval !== 'undefined' && !(ctx instanceof (globalThis.OfflineAudioContext || Object))) {
        timer = setInterval(() => schedule(), 25);
      }
    },
    stop() {
      if (!on) return;
      on = false;
      if (timer) { clearInterval(timer); timer = null; }
      out.gain.cancelScheduledValues(ctx.currentTime);
      out.gain.setValueAtTime(out.gain.value, ctx.currentTime);
      out.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
    },
    /** Called from the game loop too (keeps scheduling robust if timers are throttled). */
    pump(ahead) { schedule(ahead); },
  };
}
