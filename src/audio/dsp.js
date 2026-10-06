// Procedural buffer generation + small WebAudio helpers for the audio module.
// Everything is generated once at init (a few ms) and shared by all voices.

export function makeRng(seed = 1) {
  let s = (seed | 0) || 0x2545f491;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Seamless looping white noise (independent channels => decorrelated stereo). */
export function makeNoiseBuffer(ctx, seconds = 4, channels = 1, seed = 1) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(channels, len, ctx.sampleRate);
  const rnd = makeRng(seed);
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
  }
  return buf;
}

/**
 * Sparse "droplet" texture: Poisson-distributed tiny resonant plinks (decaying sines with a short
 * noise tick). Events are written modulo the buffer length so the loop is seamless.
 */
export function makeDropletBuffer(ctx, { seconds = 5, rate = 70, fMin = 1800, fMax = 6500, decay = 0.006, tick = 0.5, channels = 2, seed = 7, thud = 0 } = {}) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(channels, len, sr);
  const rnd = makeRng(seed);
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    let t = 0;
    for (;;) {
      t += -Math.log(1 - rnd() * 0.999) / rate; // exponential inter-arrival
      if (t >= seconds) break;
      const start = Math.floor(t * sr);
      const amp = Math.pow(rnd(), 2.2) * 0.9 + 0.05;
      const f0 = fMin * Math.pow(fMax / fMin, rnd());
      const dec = decay * (0.5 + rnd());
      const n = Math.floor(dec * 6 * sr);
      // rising pitch "plip" (drop cavity collapsing) + broadband tick
      const chirp = 1 + rnd() * 0.6;
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const tt = i / sr;
        const env = Math.exp(-tt / dec);
        const f = f0 * (1 + (chirp - 1) * (1 - env));
        ph += (2 * Math.PI * f) / sr;
        let v = Math.sin(ph) * env * amp;
        if (i < 48) v += (rnd() * 2 - 1) * tick * amp * (1 - i / 48);
        if (thud > 0) v += Math.sin((2 * Math.PI * 180 * i) / sr) * Math.exp(-tt / 0.012) * thud * amp;
        d[(start + i) % len] += v;
      }
    }
  }
  return buf;
}

/**
 * "Grit" control signal for scrapes: positive envelope with random spiky bursts (stick-slip
 * friction). Used as an AudioParam modulator, seamless loop.
 */
export function makeGritBuffer(ctx, seconds = 3, seed = 11) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const rnd = makeRng(seed);
  let t = 0;
  while (t < seconds) {
    t += -Math.log(1 - rnd() * 0.999) / 55;
    const start = Math.floor(t * sr);
    const amp = 0.3 + rnd() * 0.9;
    const dec = 0.002 + rnd() * 0.012;
    const n = Math.floor(dec * 5 * sr);
    for (let i = 0; i < n; i++) d[(start + i) % len] += amp * Math.exp(-i / sr / dec);
  }
  // slow undulation (pressure variations)
  let ph = 0;
  for (let i = 0; i < len; i++) {
    ph = (i / len) * Math.PI * 2;
    d[i] = Math.min(2.2, d[i] * 0.8 + 0.25 + 0.12 * Math.sin(ph * 7) + 0.08 * Math.sin(ph * 13));
  }
  return buf;
}

/**
 * Stereo reverb impulse response for a wet street canyon: discrete early reflections from building
 * façades (slap-back) + a diffuse tail whose high frequencies decay faster (air/wet surfaces).
 */
export function makeStreetIR(ctx, seconds = 1.7, seed = 23) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  const rnd = makeRng(seed);
  const rt60 = Math.min(1.35, seconds * 0.8);
  const k = 6.91 / rt60;
  const taps = [
    [0.009, 0.55, 0.3], [0.017, 0.4, 0.75], [0.029, 0.42, 0.2], [0.043, 0.33, 0.85],
    [0.061, 0.3, 0.4], [0.083, 0.36, 0.65], [0.112, 0.28, 0.15], [0.137, 0.22, 0.9], [0.171, 0.16, 0.5],
  ];
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const fade = Math.min(1, t / 0.02); // diffuse tail builds up after the first reflections
      // time-varying one-pole LP: tail gets darker as it decays
      const a = 0.85 - 0.7 * Math.min(1, t / seconds);
      lp += a * (rnd() * 2 - 1 - lp);
      d[i] = lp * Math.exp(-k * t) * fade * 0.5;
    }
    for (const [t, g, pan] of taps) {
      const w = c === 0 ? 1 - pan : pan;
      const i0 = Math.floor((t + (rnd() - 0.5) * 0.002) * sr);
      // short smeared reflection (3 samples) so it isn't a pure digital click
      for (let j = 0; j < 4; j++) if (i0 + j < len) d[i0 + j] += g * w * (j === 0 ? 0.6 : j === 1 ? 1 : j === 2 ? 0.5 : 0.2);
    }
    // fade the very end to avoid truncation clicks
    const fl = Math.floor(sr * 0.05);
    for (let i = 0; i < fl; i++) d[len - 1 - i] *= i / fl;
  }
  return buf;
}

/** Transparent safety clipper curve: identity below `knee`, smooth tanh-like shoulder up to `ceil`. */
export function makeSafetyCurve(knee = 0.7, ceil = 0.966, n = 4096) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const ax = Math.abs(x);
    let y = ax;
    if (ax > knee) {
      const r = ceil - knee;
      y = knee + r * Math.tanh((ax - knee) / r);
    }
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

/** Distortion curve for crunchy one-shots. */
export function makeDriveCurve(amount = 4, n = 2048) {
  const curve = new Float32Array(n);
  const k = amount;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

/** Equal-power helpers */
export const dbToGain = (db) => Math.pow(10, db / 20);
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
