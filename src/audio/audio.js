// MIDNIGHT APEX — procedural audio (WebAudio only, no files).
//
// Graph overview:
//   engine worklet ─┐                                   ┌─> reverb (street-canyon IR convolver) ─┐
//   turbo/BOV ──────┤                                   │                                        │
//   opponents ──────┼─ live bus (watchdog/pause duck) ──┼─────────────────────────────────────── ├─> pre-master
//   skid/scrape/... ┘                                   │                                        │
//   one-shot SFX ──────── fx bus ──────────────────────┤                                        │
//   wind/road/rain-on-car ─ env bus ───────────────────┘                                        │
//   ambience bed / music / UI ──────────────────────────────────────────────────────────────────┘
//   pre-master -> glue compressor -> limiter -> master gain (volume/mute) -> safety soft-clip -> out
//
// Every public method is a safe no-op before init() or if WebAudio is unavailable, and never throws.

import { loadEngineWorklet } from './engineWorklet.js';
import { makeNoiseBuffer, makeDropletBuffer, makeGritBuffer, makeStreetIR, makeSafetyCurve, makeDriveCurve, makeRng, midiToHz } from './dsp.js';
import { createMusic } from './music.js';

// Mix levels (linear). Tuned with the offline analysis bench (dev/audio.html).
const MIX = {
  engine: 1.0,
  turbo: 1.0,
  opponents: 0.75,
  skid: 1.4,
  scrape: 1.0,
  nitro: 1.0,
  env: 1.0,
  ambience: 0.7,
  music: 0.075,
  ui: 0.7,
  fx: 1.0,
  reverbReturn: 0.55,
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function createAudio(options = {}) {
  let ctx = null;
  let G = null; // audio graph (exists once init() succeeded synchronously)
  let initPromise = null;
  let warned = 0;
  const rnd = makeRng((Date.now() & 0xffff) + 99);

  // Desired state (kept before init and re-applied once the graph exists).
  const S = {
    volume: clamp(num(options.volume, 0.9), 0, 1.5),
    muted: !!options.muted,
    ambience: false,
    music: false,
    paused: false,
    wet: 0.85, // the circuit is soaked: tire noise leans toward hiss
    engine: { rpm: 900, maxRpm: 8000, throttle: 0, load: 0, gear: 1, speedKmh: 0 },
    nitro: false,
    skid: 0,
    wind: 0,
  };

  const isOfflineCtx = (c) => typeof OfflineAudioContext !== 'undefined' && c instanceof OfflineAudioContext;
  const now = () => (ctx ? ctx.currentTime : 0);
  // Wall clock in ms. Offline renders (tests) use the render clock so time-based logic stays valid.
  const perfNow = () => (ctx && isOfflineCtx(ctx) ? ctx.currentTime * 1000 : typeof performance !== 'undefined' ? performance.now() : Date.now());

  function warn(e) {
    if (warned++ < 5) console.warn('[audio]', e && e.message ? e.message : e);
  }

  // Wrap a method: no-op before init, never throws into the game loop.
  const safe = (fn, fallback) => (...args) => {
    if (!G) return typeof fallback === 'function' ? fallback(...args) : fallback;
    try {
      return fn(...args);
    } catch (e) {
      warn(e);
      return typeof fallback === 'function' ? undefined : fallback;
    }
  };

  // ------------------------------------------------------------------------------------------
  // Node helpers
  // ------------------------------------------------------------------------------------------
  const gainNode = (v = 0) => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };
  const filt = (type, f, q = 0.707, gdb = 0) => {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    b.gain.value = gdb;
    return b;
  };
  const chain = (...nodes) => {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  };
  // Looping buffer source started at a random offset (decorrelates layers sharing one buffer).
  const loopSrc = (buffer, rate = 1) => {
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(now(), rnd() * buffer.duration * 0.95);
    return s;
  };
  // One-shot noise source (auto cleanup).
  const shotNoise = (t, dur, buffer) => {
    const s = ctx.createBufferSource();
    s.buffer = buffer || G.noise;
    s.loop = true;
    s.start(t, rnd() * (s.buffer.duration - 0.6));
    s.stop(t + dur);
    return s;
  };
  // Disconnect a set of nodes when `src` ends (keeps the graph from accumulating).
  const cleanup = (src, nodes) => {
    src.onended = () => {
      for (const n of nodes) {
        try { n.disconnect(); } catch (e) { /* already gone */ }
      }
    };
  };
  // Smooth param target with change threshold (avoids flooding the automation timeline).
  const lastSet = new WeakMap();
  const setP = (param, v, tau = 0.05, eps = 1e-4) => {
    const prev = lastSet.get(param);
    if (prev !== undefined && Math.abs(prev - v) <= eps) return;
    lastSet.set(param, v);
    param.setTargetAtTime(v, now(), tau);
  };
  // Hard (re)start of an envelope: cancel pending automation, hold current value.
  const holdParam = (param, t) => {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
    else {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
    }
  };

  // ------------------------------------------------------------------------------------------
  // Graph construction
  // ------------------------------------------------------------------------------------------
  function buildGraph() {
    const g = {};
    G = g; // helpers below rely on G.noise
    g.noise = makeNoiseBuffer(ctx, 4.3, 1, 1234);
    g.noiseStereo = makeNoiseBuffer(ctx, 5.1, 2, 777);
    g.grit = makeGritBuffer(ctx, 3.1, 31);
    g.driveCurve = makeDriveCurve(5);

    // --- master chain
    g.pre = gainNode(1);
    g.glue = ctx.createDynamicsCompressor();
    g.glue.threshold.value = -16;
    g.glue.knee.value = 10;
    g.glue.ratio.value = 2.5;
    g.glue.attack.value = 0.012;
    g.glue.release.value = 0.25;
    g.limiter = ctx.createDynamicsCompressor();
    g.limiter.threshold.value = -4;
    g.limiter.knee.value = 0;
    g.limiter.ratio.value = 20;
    g.limiter.attack.value = 0.001;
    g.limiter.release.value = 0.12;
    g.master = gainNode(S.muted ? 0 : S.volume);
    g.safety = ctx.createWaveShaper();
    g.safety.curve = makeSafetyCurve(0.72, 0.955);
    chain(g.pre, g.glue, g.limiter, g.master, g.safety, ctx.destination);

    // --- reverb (wet street canyon)
    g.verbIn = gainNode(1);
    g.verb = ctx.createConvolver();
    g.verb.normalize = true;
    g.verbReturn = gainNode(MIX.reverbReturn);
    chain(g.verbIn, filt('highpass', 160, 0.7), g.verb, g.verbReturn, g.pre);
    // IR generation is the heaviest bit of init — defer a tick so the gesture handler returns fast.
    const setIR = () => { try { g.verb.buffer = makeStreetIR(ctx, 1.4, 23); } catch (e) { warn(e); } };
    if (isOfflineCtx(ctx)) setIR();
    else setTimeout(setIR, 0);

    // --- buses
    // continuous car layers (ducked by pause / watchdog; silent until the game feeds setEngine)
    g.live = gainNode(isOfflineCtx(ctx) ? 1 : 0);
    g.live.connect(g.pre);
    g.fx = gainNode(MIX.fx);
    g.fx.connect(g.pre);
    g.env = gainNode(MIX.env);
    g.env.connect(g.live);
    g.amb = gainNode(0);
    g.amb.connect(g.pre);
    g.ui = gainNode(MIX.ui);
    g.ui.connect(g.pre);
    g.engineBus = gainNode(MIX.engine);
    g.engineBus.connect(g.live);
    // reverb sends of all live layers go through one gate (pause / watchdog duck them together)
    g.liveVerb = gainNode(isOfflineCtx(ctx) ? 1 : 0);
    g.liveVerb.connect(g.verbIn);
    const engVerb = gainNode(0.07);
    g.engineBus.connect(engVerb).connect(g.liveVerb);

    buildTurbo(g);
    buildSkid(g);
    buildScrape(g);
    buildNitro(g);
    buildWind(g);
    buildAmbience(g);
    g.music = createMusic(ctx, g.pre, g.verbIn, g.noise);
    g.music.setLevel(MIX.music);
    return g;
  }

  // Source gate: open while a layer is audible, closes shortly after it fell silent so the
  // downstream filters receive silence and the browser can skip processing them (CPU).
  const makeGate = () => ({ node: gainNode(0), open: false });
  function setGate(gt, on, closeDelay = 0.7) {
    if (on === gt.open) return;
    gt.open = on;
    const t = now();
    const p = gt.node.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(on ? 1 : p.value, t);
    if (!on) p.setValueAtTime(0, t + closeDelay);
  }

  function buildTurbo(g) {
    // Compressor whistle: two partials + narrow band of noise, all tracking spool speed.
    const t = {};
    t.osc = ctx.createOscillator();
    t.osc.type = 'sine';
    t.osc.frequency.value = 2000;
    t.osc2 = ctx.createOscillator();
    t.osc2.type = 'triangle';
    t.osc2.frequency.value = 4030;
    t.gate = makeGate();
    t.bp = filt('bandpass', 2000, 9);
    t.g1 = gainNode(1);
    t.g2 = gainNode(0.25);
    t.gn = gainNode(2.2);
    t.out = gainNode(0);
    t.osc.connect(t.g1).connect(t.out);
    t.osc2.connect(t.g2).connect(t.out);
    chain(loopSrc(g.noise, 1.0), t.gate.node, t.bp, t.gn, t.out);
    t.out.connect(g.engineBus);
    t.osc.start();
    t.osc2.start();
    g.turbo = t;
    g.spool = 0;
    g.lastBov = -10;
  }

  function buildSkid(g) {
    const s = {};
    s.gate = makeGate();
    loopSrc(g.noise).connect(s.gate.node);
    const src = s.gate.node;
    // resonant squeal: two narrow bands (rubber stick-slip modes) with a wobbling centre
    s.bp1 = filt('bandpass', 1150, 22);
    s.bp2 = filt('bandpass', 2380, 16);
    s.squeal = gainNode(0);
    src.connect(s.squeal);
    s.squeal.connect(s.bp1);
    const b2g = gainNode(0.55);
    s.squeal.connect(b2g).connect(s.bp2);
    // wobble LFOs into the filter centres
    s.lfo = ctx.createOscillator();
    s.lfo.frequency.value = 6.3;
    const la = gainNode(55);
    s.lfo.connect(la);
    la.connect(s.bp1.frequency);
    const la2 = gainNode(110);
    s.lfo.connect(la2).connect(s.bp2.frequency);
    s.lfo2 = ctx.createOscillator();
    s.lfo2.frequency.value = 1.7;
    const lb = gainNode(35);
    s.lfo2.connect(lb).connect(s.bp1.frequency);
    s.lfo.start();
    s.lfo2.start();
    s.out = gainNode(MIX.skid);
    s.bp1.connect(s.out);
    s.bp2.connect(s.out);
    // wet hiss: water being squeezed out of the tread
    s.hiss = gainNode(0);
    chain(src, s.hiss, filt('bandpass', 2600, 0.75), filt('highshelf', 5000, 0.7, 4), s.out);
    // tread scrub rumble
    s.scrub = gainNode(0);
    chain(src, s.scrub, filt('lowpass', 380, 0.9), s.out);
    s.out.connect(g.live);
    const sv = gainNode(0.12);
    s.out.connect(sv).connect(g.liveVerb);
    s.wob = 0;
    s.wobT = 0;
    s.prev = 0;
    g.skid = s;
  }

  function buildScrape(g) {
    const s = {};
    s.gate = makeGate();
    loopSrc(g.noise, 1.0).connect(s.gate.node);
    const src = s.gate.node;
    s.vca = gainNode(0); // modulated by grit (stick-slip bursts)
    s.bpLow = filt('bandpass', 1300, 1.0);
    s.bpRing = filt('bandpass', 3150, 11);
    s.bpRing2 = filt('bandpass', 5350, 15);
    const gl = gainNode(1.0);
    const gr = gainNode(1.8);
    const gr2 = gainNode(1.2);
    src.connect(s.bpLow).connect(gl).connect(s.vca);
    src.connect(s.bpRing).connect(gr).connect(s.vca);
    src.connect(s.bpRing2).connect(gr2).connect(s.vca);
    const grit = loopSrc(g.grit, 1.0);
    grit.connect(s.vca.gain);
    s.grit = grit;
    s.out = gainNode(0);
    const shaper = ctx.createWaveShaper();
    shaper.curve = g.driveCurve;
    chain(s.vca, shaper, s.out);
    s.out.connect(g.live);
    const sv = gainNode(0.25);
    s.out.connect(sv).connect(g.liveVerb);
    s.level = 0;
    s.target = 0;
    s.lastCall = -1;
    g.scrape = s;
  }

  function buildNitro(g) {
    const n = {};
    n.gate = makeGate();
    loopSrc(g.noise, 1.11).connect(n.gate.node);
    const src = n.gate.node;
    n.out = gainNode(0);
    const hiss = gainNode(0.5);
    chain(src, filt('bandpass', 2300, 0.6), hiss, n.out);
    const air = gainNode(0.22);
    chain(src, filt('highpass', 6500, 0.7), air, n.out);
    const rumble = gainNode(1.6);
    chain(src, filt('lowpass', 150, 1.2), filt('lowpass', 220, 0.7), rumble, n.out);
    // pressure flutter on the hiss
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 11;
    const la = gainNode(0.18);
    lfo.connect(la).connect(hiss.gain);
    lfo.start();
    n.out.connect(g.live);
    g.nitroL = n;
  }

  function buildWind(g) {
    const w = {};
    // tire/road roar (coarse wet asphalt)
    w.roarLP = filt('lowpass', 200, 0.8);
    w.roar = gainNode(0);
    chain(loopSrc(g.noise, 0.9), w.roarLP, filt('lowpass', 900, 0.6), w.roar, g.env);
    // tire spray hiss on the wet surface
    w.hissBP = filt('bandpass', 1800, 0.55);
    w.hiss = gainNode(0);
    chain(loopSrc(g.noise, 1.03), w.hissBP, w.hiss, g.env);
    // wind with slow gusts
    w.windBP = filt('bandpass', 500, 0.55);
    w.wind = gainNode(0);
    w.gust = gainNode(1);
    chain(loopSrc(g.noiseStereo, 1.0), w.windBP, w.gust, w.wind, g.env);
    const l1 = ctx.createOscillator();
    l1.frequency.value = 0.13;
    const l2 = ctx.createOscillator();
    l2.frequency.value = 0.31;
    const la = gainNode(0.22);
    const lb = gainNode(0.14);
    l1.connect(la).connect(w.gust.gain);
    l2.connect(lb).connect(w.gust.gain);
    l1.start();
    l2.start();
    // rain hitting the car body
    w.rain = gainNode(0);
    const carDrops = makeDropletBuffer(ctx, { seconds: 4.2, rate: 150, fMin: 2400, fMax: 9000, decay: 0.0028, tick: 0.9, thud: 0.25, seed: 91 });
    chain(loopSrc(carDrops), filt('highpass', 1200, 0.7), w.rain, g.env);
    w.lastSpeed = -1;
    g.wind = w;
  }

  function buildAmbience(g) {
    const a = {};
    a.gate = makeGate();
    a.gateM = makeGate();
    loopSrc(g.noiseStereo).connect(a.gate.node);
    loopSrc(g.noise, 0.6).connect(a.gateM.node);
    // rain bed: decorrelated stereo noise, shaped like distant heavy rain on everything
    const bed = gainNode(0.05);
    chain(a.gate.node, filt('highpass', 420, 0.6), filt('lowpass', 7200, 0.6), filt('peaking', 2600, 0.8, 3), bed, g.amb);
    const lowBed = gainNode(0.035);
    chain(a.gate.node, filt('bandpass', 850, 0.5), lowBed, g.amb);
    // drop plinks / puddle patter
    const drops = makeDropletBuffer(ctx, { seconds: 6.3, rate: 85, fMin: 1500, fMax: 6000, decay: 0.006, tick: 0.35, seed: 47 });
    const dg = gainNode(0.09);
    a.gateD = makeGate();
    chain(loopSrc(drops), a.gateD.node, filt('highpass', 700, 0.7), dg, g.amb);
    // distant city: low traffic rumble with slow swells + faint far tire hiss
    const city = gainNode(0.075);
    chain(a.gateM.node, filt('lowpass', 170, 0.8), filt('lowpass', 260, 0.6), city, g.amb);
    const cl = ctx.createOscillator();
    cl.frequency.value = 0.045;
    const cla = gainNode(0.03);
    cl.connect(cla).connect(city.gain);
    cl.start();
    const far = gainNode(0.008);
    chain(a.gateM.node, filt('bandpass', 1100, 0.7), far, g.amb);
    a.nextThunder = 0;
    g.ambL = a;
  }

  // ------------------------------------------------------------------------------------------
  // Engines (worklet or native fallback)
  // ------------------------------------------------------------------------------------------
  function buildWorkletEngines(g) {
    const node = new AudioWorkletNode(ctx, 'apex-engine', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { seed: 1337 },
    });
    node.onprocessorerror = (e) => warn(e);
    const p = (n) => node.parameters.get(n);
    g.eng = {
      kind: 'worklet',
      node,
      rpm: p('rpm'),
      throttle: p('throttle'),
      load: p('load'),
      nitro: p('nitro'),
      cut: p('cut'),
      maxRpm: p('maxRpm'),
      gain: p('gain'),
      pops(n, strength) { node.port.postMessage({ type: 'pops', n, strength }); },
    };
    node.connect(g.engineBus);

    const opp = new AudioWorkletNode(ctx, 'apex-opponents', {
      numberOfInputs: 0,
      numberOfOutputs: 2, // 0: dry (distance-attenuated), 1: reverb send (sqrt attenuation)
      outputChannelCount: [2, 2],
      processorOptions: { seed: 4242 },
    });
    opp.onprocessorerror = (e) => warn(e);
    g.oppBus = gainNode(MIX.opponents);
    opp.connect(g.oppBus, 0).connect(g.live);
    g.oppVerb = gainNode(MIX.opponents);
    opp.connect(g.oppVerb, 1);
    g.oppVerb.connect(g.liveVerb);
    g.opp = {
      kind: 'worklet',
      node: opp,
      buf: new Float32Array(20),
      send(arr) { opp.port.postMessage(arr); },
    };
  }

  // Native fallback (no AudioWorklet): oscillator stack with the same controls. Simpler but OK.
  function buildNativeEngines(g) {
    const out = gainNode(0);
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeDriveCurve(3);
    shaper.oversample = '2x';
    const lp = filt('lowpass', 1500, 0.8);
    const body = filt('peaking', 280, 0.9, 5);
    const sum = gainNode(0.35);
    chain(sum, shaper, body, lp, out, g.engineBus);
    const mk = (type, gv) => {
      const o = ctx.createOscillator();
      o.type = type;
      const gg = gainNode(gv);
      o.connect(gg).connect(sum);
      o.start();
      return o;
    };
    const o1 = mk('sawtooth', 0.5);
    const o2 = mk('square', 0.3);
    const o3 = mk('sine', 0.6);
    const cutG = gainNode(1);
    out.disconnect();
    chain(out, cutG, g.engineBus);
    g.eng = {
      kind: 'native',
      apply(e) {
        const f = (e.rpm / 60) * 4;
        const t = now();
        o1.frequency.setTargetAtTime(f, t, 0.015);
        o2.frequency.setTargetAtTime(f / 2, t, 0.015);
        o3.frequency.setTargetAtTime(f / 4, t, 0.015);
        const L = Math.max(e.throttle, e.load);
        const rn = clamp((e.rpm - 700) / (e.maxRpm - 700), 0, 1);
        lp.frequency.setTargetAtTime(900 + 3500 * L + 2000 * rn, t, 0.04);
        out.gain.setTargetAtTime(0.12 * (0.35 + 0.65 * rn) * (0.4 + 0.6 * L), t, 0.03);
      },
      cutFor(dur) {
        const t = now();
        cutG.gain.setTargetAtTime(0.25, t, 0.01);
        cutG.gain.setTargetAtTime(1, t + dur, 0.03);
      },
      pops() {},
    };
    // opponents: saw -> LP -> pan -> gain
    g.oppBus = gainNode(MIX.opponents);
    g.oppBus.connect(g.live);
    const voices = [];
    for (let i = 0; i < 4; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const l = filt('lowpass', 1200, 0.7);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const gg = gainNode(0);
      if (pan) chain(o, l, pan, gg, g.oppBus);
      else chain(o, l, gg, g.oppBus);
      o.start();
      voices.push({ o, l, pan, gg });
    }
    g.opp = {
      kind: 'native',
      buf: new Float32Array(20),
      send(arr) {
        const t = now();
        for (let i = 0; i < 4; i++) {
          const v = voices[i];
          const o = i * 5;
          v.o.frequency.setTargetAtTime((arr[o] / 60) * 4, t, 0.05);
          v.gg.gain.setTargetAtTime(arr[o + 2] * 0.05 * (0.4 + 0.6 * arr[o + 1]), t, 0.05);
          if (v.pan) v.pan.pan.setTargetAtTime(arr[o + 3], t, 0.05);
          v.l.frequency.setTargetAtTime(Math.min(arr[o + 4], 2500), t, 0.05);
        }
      },
    };
  }

  // ------------------------------------------------------------------------------------------
  // init / lifecycle
  // ------------------------------------------------------------------------------------------
  let unlockBound = null;
  function addUnlock() {
    if (unlockBound || typeof window === 'undefined' || isOfflineCtx(ctx)) return;
    unlockBound = () => {
      if (ctx && ctx.state !== 'running' && !hiddenSuspended) ctx.resume().catch(() => {});
      if (ctx && ctx.state === 'running') removeUnlock();
    };
    for (const ev of ['pointerdown', 'keydown', 'touchend', 'mousedown']) window.addEventListener(ev, unlockBound, true);
  }
  function removeUnlock() {
    if (!unlockBound) return;
    for (const ev of ['pointerdown', 'keydown', 'touchend', 'mousedown']) window.removeEventListener(ev, unlockBound, true);
    unlockBound = null;
  }

  let hiddenSuspended = false;
  function onVisibility() {
    if (!ctx || isOfflineCtx(ctx)) return;
    if (document.hidden) {
      if (ctx.state === 'running') {
        hiddenSuspended = true;
        ctx.suspend().catch(() => {});
      }
    } else if (hiddenSuspended) {
      hiddenSuspended = false;
      ctx.resume().catch(() => {});
    }
  }

  // Watchdog: if the game stops feeding the engine (debugger, frozen loop, menu), fade the
  // continuous car layers instead of droning on the last value forever.
  let lastFeed = 0;
  let watchdogTimer = null;
  let liveOn = false;
  function watchdog() {
    if (!G) return;
    const stale = perfNow() - lastFeed > 450;
    const want = !stale && !S.paused;
    if (want !== liveOn) {
      liveOn = want;
      setP(G.live.gain, want ? 1 : 0, want ? 0.04 : 0.12);
      setP(G.liveVerb.gain, want ? 1 : 0, want ? 0.04 : 0.12);
    }
  }

  function init() {
    if (initPromise) {
      if (ctx && ctx.state === 'suspended' && !isOfflineCtx(ctx) && !hiddenSuspended) ctx.resume().catch(() => {});
      return initPromise;
    }
    // Synchronous part (runs inside the user gesture): context + native graph + resume.
    let ok = true;
    try {
      if (options.context) ctx = options.context;
      else {
        const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
        if (!AC) throw new Error('WebAudio unavailable');
        ctx = new AC({ latencyHint: 'interactive' });
      }
      buildGraph();
      if (!isOfflineCtx(ctx)) {
        if (ctx.state !== 'running') ctx.resume().catch(() => {});
        addUnlock();
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
        lastFeed = perfNow();
        watchdogTimer = setInterval(watchdog, 150);
      } else {
        liveOn = true;
      }
    } catch (e) {
      warn(e);
      G = null;
      ok = false;
    }
    if (!ok) {
      initPromise = Promise.resolve(false);
      return initPromise;
    }
    initPromise = (async () => {
      let worklet = false;
      try {
        worklet = options.forceNative ? false : await loadEngineWorklet(ctx);
      } catch (e) {
        worklet = false;
      }
      try {
        if (worklet) buildWorkletEngines(G);
        else buildNativeEngines(G);
      } catch (e) {
        warn(e);
        try { buildNativeEngines(G); } catch (e2) { warn(e2); }
      }
      // re-apply state requested before the engines existed
      applyEngine();
      if (S.ambience) api.setAmbience(true);
      if (S.music) api.setMusic(true);
      return true;
    })();
    return initPromise;
  }

  // ------------------------------------------------------------------------------------------
  // Player engine
  // ------------------------------------------------------------------------------------------
  let lastEngT = 0;
  let prevThr = 0;
  let lastWhineF = -1;

  function applyEngine() {
    const g = G;
    if (!g || !g.eng) return;
    const e = S.engine;
    if (g.eng.kind === 'worklet') {
      setP(g.eng.rpm, e.rpm, 0.012, 1);
      setP(g.eng.throttle, e.throttle, 0.018, 0.003);
      setP(g.eng.load, e.load, 0.03, 0.003);
      setP(g.eng.maxRpm, e.maxRpm, 0.01, 1);
      setP(g.eng.nitro, S.nitro ? 1 : 0, 0.08, 0.01);
    } else g.eng.apply(e);
  }

  function setEngine(p) {
    if (!p || typeof p !== 'object') p = {};
    const e = S.engine;
    e.maxRpm = clamp(num(p.maxRpm, e.maxRpm), 2000, 16000);
    e.rpm = clamp(num(p.rpm, e.rpm), 0, e.maxRpm * 1.08);
    e.throttle = clamp(num(p.throttle, e.throttle), 0, 1);
    e.load = clamp(num(p.load, e.throttle), 0, 1);
    e.gear = num(p.gear, e.gear);
    e.speedKmh = Math.abs(num(p.speedKmh, e.speedKmh));
    if (!G) return;
    lastFeed = perfNow();
    if (!liveOn && !S.paused) watchdog();
    applyEngine();

    // --- turbo spool (lagged first-order) + whistle
    const tNow = perfNow();
    const dt = clamp((tNow - (lastEngT || tNow)) / 1000, 0, 0.1);
    lastEngT = tNow;
    const rn = clamp((e.rpm - 700) / (e.maxRpm - 700), 0, 1);
    const L = Math.max(e.throttle, e.load);
    const spoolTarget = clamp((rn - 0.22) / 0.55, 0, 1) * Math.pow(L, 1.3) * (S.nitro ? 1.1 : 1);
    const tau = spoolTarget > G.spool ? 0.6 : 0.22;
    G.spool += (spoolTarget - G.spool) * (1 - Math.exp(-dt / tau));
    const sp = G.spool;
    const tb = G.turbo;
    setP(tb.osc.frequency, 1700 + 5200 * sp + 500 * rn, 0.05, 8);
    setP(tb.osc2.frequency, (1700 + 5200 * sp + 500 * rn) * 2.02, 0.05, 16);
    setP(tb.bp.frequency, 1700 + 5200 * sp + 500 * rn, 0.05, 8);
    setP(tb.out.gain, 0.03 * sp * sp * MIX.turbo, 0.05, 0.0005);
    setGate(tb.gate, sp > 0.02);

    // --- lift-off: blow-off valve vents boost
    if (prevThr > 0.55 && e.throttle < 0.2 && sp > 0.45 && now() - G.lastBov > 0.7) {
      playBlowOff(sp);
      G.spool *= 0.3;
    }
    prevThr = e.throttle;

    // --- drivetrain whine: loud straight-cut reverse gear; faint final-drive whine going forward
    const rev = e.gear < 0;
    const whine = rev ? clamp(e.speedKmh / 35, 0, 1) : clamp(e.speedKmh / 140, 0, 1) * (0.35 + 0.65 * L);
    if (whine > 0.01 || lastWhineF > 0) {
      if (!G.whine) buildWhine();
      const f = rev ? 380 + e.speedKmh * 28 : 160 + e.speedKmh * 10.5;
      setP(G.whine.osc.frequency, f, 0.05, 2);
      setP(G.whine.bp.frequency, f, 0.05, 2);
      setP(G.whine.g.gain, rev ? 0.03 * Math.sqrt(whine) * (0.4 + 0.6 * e.throttle) : 0.0035 * whine, 0.08, 0.0002);
      lastWhineF = whine > 0.01 ? whine : 0;
    }
  }

  function buildWhine() {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const g = gainNode(0);
    const bp = filt('bandpass', 1200, 0.8);
    chain(osc, g, bp, G.engineBus);
    osc.start();
    G.whine = { osc, g, bp };
  }

  function playBlowOff(strength = 1) {
    const t = now() + 0.005;
    G.lastBov = now();
    const s = clamp(strength, 0.2, 1.2);
    // "psshh": noise through a falling band-pass
    const src = shotNoise(t, 0.75);
    const bp = filt('bandpass', 3800, 1.3);
    bp.frequency.setValueAtTime(4200, t);
    bp.frequency.exponentialRampToValueAtTime(1300, t + 0.45);
    const hp = filt('highpass', 700, 0.7);
    const env = gainNode(0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.55 * s, t + 0.012);
    env.gain.setTargetAtTime(0, t + 0.03, 0.15);
    // compressor surge flutter "chu-tu-tu-tu": AM at a decaying rate
    const flutter = gainNode(0.55);
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(34, t);
    lfo.frequency.exponentialRampToValueAtTime(13, t + 0.5);
    const depth = gainNode(0);
    depth.gain.setValueAtTime(0.1, t);
    depth.gain.linearRampToValueAtTime(0.45, t + 0.12);
    depth.gain.setTargetAtTime(0, t + 0.35, 0.1);
    lfo.connect(depth).connect(flutter.gain);
    lfo.start(t);
    lfo.stop(t + 0.75);
    chain(src, bp, hp, env, flutter, G.fx);
    const vs = gainNode(0.3);
    flutter.connect(vs).connect(G.verbIn);
    cleanup(src, [src, bp, hp, env, flutter, vs, lfo, depth]);
  }

  // ------------------------------------------------------------------------------------------
  // Opponents
  // ------------------------------------------------------------------------------------------
  // Voice slots keep their identity across frames: incoming entries (whose order may change, e.g.
  // "nearest 4, sorted by distance") are matched to slots by continuity of distance/pan/rpm, so a
  // voice keeps following the same car (no timbre swaps, no fake doppler spikes on re-ordering).
  const slots = [0, 1, 2, 3].map(() => ({ active: false, d: 0, pan: 0, rpm: 0, vr: 0, t: 0 }));
  const slotItem = [null, null, null, null];
  const pairs = [];
  let lastOppSend = -1e9;

  function matchSlots(items, tNow) {
    for (let k = 0; k < 4; k++) slotItem[k] = null;
    const valid = [];
    for (let i = 0; i < items.length && valid.length < 4; i++) if (items[i] && typeof items[i] === 'object') valid.push(items[i]);
    pairs.length = 0;
    for (let i = 0; i < valid.length; i++) {
      const it = valid[i];
      const d = Math.max(0, num(it.distance, 50));
      const pan = clamp(num(it.pan, 0), -1, 1);
      const rpm = num(it.rpm, 3000);
      for (let k = 0; k < 4; k++) {
        const sl = slots[k];
        if (!sl.active || tNow - sl.t > 500) continue;
        pairs.push({ i, k, c: Math.abs(d - sl.d) + 6 * Math.abs(pan - sl.pan) + Math.abs(rpm - sl.rpm) / 800 });
      }
    }
    pairs.sort((a, b) => a.c - b.c);
    const usedI = [false, false, false, false];
    for (const p of pairs) {
      if (usedI[p.i] || slotItem[p.k] || p.c > 40) continue;
      slotItem[p.k] = valid[p.i];
      usedI[p.i] = true;
    }
    for (let i = 0; i < valid.length; i++) {
      if (usedI[i]) continue;
      let k = slotItem.findIndex((x, kk) => !x && !slots[kk].active);
      if (k < 0) k = slotItem.findIndex((x) => !x);
      if (k < 0) break;
      slotItem[k] = valid[i];
      slots[k].active = false; // new source in this slot: reset its doppler history
      usedI[i] = true;
    }
  }

  function setOpponents(list) {
    if (!G || !G.opp) return;
    const arr = G.opp.buf;
    const tNow = perfNow();
    matchSlots(Array.isArray(list) ? list : [], tNow);
    for (let k = 0; k < 4; k++) {
      const it = slotItem[k];
      const o = k * 5;
      const sl = slots[k];
      if (!it) {
        arr[o + 2] = 0;
        sl.active = false;
        continue;
      }
      const d = Math.max(0, num(it.distance, 50));
      const pan = clamp(num(it.pan, 0), -1, 1);
      const rpm = clamp(num(it.rpm, 3000), 500, 12000);
      // radial velocity from the distance derivative -> doppler factor (smoothed, clamped);
      // physically impossible jumps (re-assignment, teleport/reset) restart the estimate.
      if (sl.active) {
        const dt = (tNow - sl.t) / 1000;
        if (dt > 0.004) {
          const vr = (d - sl.d) / dt;
          if (Math.abs(vr) > 160) sl.vr = 0;
          else sl.vr += (vr - sl.vr) * Math.min(1, dt * 6);
          sl.d = d;
          sl.t = tNow;
        }
      } else {
        sl.active = true;
        sl.d = d;
        sl.t = tNow;
        sl.vr = 0;
      }
      sl.pan = pan;
      sl.rpm = rpm;
      const dop = clamp(343 / (343 + sl.vr), 0.85, 1.18);
      arr[o] = rpm * dop;
      arr[o + 1] = clamp(num(it.throttle, 0.5), 0, 1);
      arr[o + 2] = 1 / (1 + Math.pow(d / 11, 1.55)); // distance attenuation
      arr[o + 3] = pan;
      arr[o + 4] = 11000 / (1 + d / 28); // air absorption
    }
    if (tNow - lastOppSend > 30 || G.opp.kind === 'native') {
      lastOppSend = tNow;
      G.opp.send(arr);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Continuous layers
  // ------------------------------------------------------------------------------------------
  function setSkid(v) {
    const x = clamp(num(v, 0), 0, 1);
    S.skid = x;
    if (!G) return;
    const s = G.skid;
    const wet = S.wet;
    const tau = x >= s.prev ? 0.035 : 0.09; // fast attack, slower release
    s.prev = x;
    setGate(s.gate, x > 0.004);
    setP(s.squeal.gain, 0.2 * Math.pow(x, 1.35) * (1.15 - 0.55 * wet), tau, 0.002);
    setP(s.hiss.gain, 0.11 * Math.pow(x, 0.9) * (0.35 + 0.65 * wet), tau, 0.002);
    setP(s.scrub.gain, 0.12 * x, tau, 0.002);
    const f = 1050 + 260 * x + s.wob;
    setP(s.bp1.frequency, f, 0.06, 4);
    setP(s.bp2.frequency, f * 2.07, 0.06, 8);
  }

  function setNitro(active) {
    const on = !!active;
    if (on === S.nitro) return;
    S.nitro = on;
    if (!G) return;
    const t = now() + 0.005;
    setGate(G.nitroL.gate, on, 1.2);
    setP(G.nitroL.out.gain, on ? 0.16 * MIX.nitro : 0, on ? 0.07 : 0.18, 0.001);
    if (G.eng && G.eng.kind === 'worklet') setP(G.eng.nitro, on ? 1 : 0, 0.08, 0.01);
    if (on) {
      // solenoid kick + rising whoosh
      const src = shotNoise(t, 0.9);
      const bp = filt('bandpass', 500, 1.1);
      bp.frequency.setValueAtTime(450, t);
      bp.frequency.exponentialRampToValueAtTime(3600, t + 0.4);
      const env = gainNode(0);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.26, t + 0.05);
      env.gain.setTargetAtTime(0, t + 0.25, 0.15);
      chain(src, bp, env, G.fx);
      const vs = gainNode(0.3);
      env.connect(vs).connect(G.verbIn);
      cleanup(src, [src, bp, env, vs]);
      thump(t, 70, 0.35, 0.06);
    } else {
      const src = shotNoise(t, 0.6);
      const hp = filt('highpass', 2800, 0.7);
      const env = gainNode(0);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.09, t + 0.01);
      env.gain.setTargetAtTime(0, t + 0.03, 0.11);
      chain(src, hp, env, G.fx);
      cleanup(src, [src, hp, env]);
    }
  }

  function setWind(speedKmh) {
    const v = Math.abs(num(speedKmh, 0));
    S.wind = v;
    if (!G) return;
    const w = G.wind;
    if (Math.abs(v - w.lastSpeed) < 0.8) return;
    w.lastSpeed = v;
    const s = clamp(v / 300, 0, 1.25);
    setP(w.roar.gain, 0.2 * Math.pow(s, 1.1), 0.1, 0.0005);
    setP(w.roarLP.frequency, 110 + 420 * s, 0.1, 3);
    setP(w.hiss.gain, 0.06 * Math.pow(s, 1.2) * (0.3 + 0.7 * S.wet), 0.1, 0.0005);
    setP(w.hissBP.frequency, 1300 + 2800 * s, 0.1, 10);
    setP(w.wind.gain, 0.16 * s * s, 0.12, 0.0005);
    setP(w.windBP.frequency, 380 + 1300 * s, 0.12, 5);
    setP(w.rain.gain, (0.035 + 0.06 * Math.min(1, s * 1.6)) * S.wet, 0.2, 0.0005);
  }

  function setScrapeLevel(x) {
    const s = G.scrape;
    if (Math.abs(x - s.level) < 0.02 && !(x === 0 && s.level > 0)) return;
    s.level = x;
    setGate(s.gate, x > 0);
    const tau = x > 0 ? 0.02 : 0.07;
    setP(s.out.gain, 0.17 * Math.pow(x, 0.8) * MIX.scrape, tau, 0.001);
    setP(s.bpRing.frequency, 2900 + 900 * x, 0.05, 10);
    setP(s.bpLow.frequency, 1100 + 700 * x, 0.05, 10);
    setP(s.grit.playbackRate, 0.7 + 0.8 * x, 0.05, 0.02);
  }

  function playScrape(intensity) {
    const x = clamp(num(intensity, 0.5), 0, 1);
    const s = G.scrape;
    s.lastCall = perfNow();
    // rate-limited: only move the target when it changes meaningfully
    s.target = Math.max(x, s.target * 0.85);
    setScrapeLevel(s.target);
  }

  // ------------------------------------------------------------------------------------------
  // One-shots
  // ------------------------------------------------------------------------------------------
  function thump(t, f0, peak, tau, dest) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0 * 1.9, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + tau * 3);
    const gg = gainNode(0);
    gg.gain.setValueAtTime(0, t);
    gg.gain.linearRampToValueAtTime(peak, t + 0.004);
    gg.gain.setTargetAtTime(0, t + 0.01, tau);
    chain(o, gg, dest || G.fx);
    o.start(t);
    o.stop(t + tau * 8 + 0.05);
    cleanup(o, [o, gg]);
  }

  function noiseHit(t, { type = 'bandpass', f = 1000, q = 1, peak = 0.3, attack = 0.002, tau = 0.05, dest, verb = 0, drive = false, fEnd } = {}) {
    const dur = attack + tau * 7 + 0.05;
    const src = shotNoise(t, dur);
    const fl = filt(type, f, q);
    if (fEnd) {
      fl.frequency.setValueAtTime(f, t);
      fl.frequency.exponentialRampToValueAtTime(fEnd, t + tau * 3);
    }
    const env = gainNode(0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + attack);
    env.gain.setTargetAtTime(0, t + attack, tau);
    const nodes = [src, fl, env];
    let last = env;
    chain(src, fl, env);
    if (drive) {
      const sh = ctx.createWaveShaper();
      sh.curve = G.driveCurve;
      env.connect(sh);
      last = sh;
      nodes.push(sh);
    }
    last.connect(dest || G.fx);
    if (verb > 0) {
      const vs = gainNode(verb);
      last.connect(vs).connect(G.verbIn);
      nodes.push(vs);
    }
    cleanup(src, nodes);
  }

  let lastShift = -1;
  function playShift(up) {
    const t = now() + 0.004;
    if (now() - lastShift < 0.05) return;
    lastShift = now();
    const e = S.engine;
    const L = Math.max(e.throttle, e.load);
    // gearbox clunk: dull thud + small dog-ring click
    noiseHit(t, { type: 'lowpass', f: 260, q: 0.8, peak: 1.4, tau: 0.02 });
    thump(t, 48, 0.12, 0.018);
    noiseHit(t + 0.006, { type: 'bandpass', f: 2900, q: 3, peak: 0.35, attack: 0.001, tau: 0.006 });
    if (up) {
      // ignition cut during the shift (sequential-box "bwaap-BWAAP")
      if (L > 0.35 && G.eng) {
        if (G.eng.kind === 'worklet') {
          G.eng.cut.cancelScheduledValues(t);
          G.eng.cut.setValueAtTime(1, t);
          G.eng.cut.setValueAtTime(0, t + 0.075);
          lastSet.delete(G.eng.cut);
        } else G.eng.cutFor(0.075);
        if (e.rpm > 0.55 * e.maxRpm && rnd() < 0.4) G.eng.pops(1, 0.45 + rnd() * 0.3); // unburnt fuel on the cut
      }
      if ((L > 0.5 || G.spool > 0.35) && now() - G.lastBov > 0.45) {
        playBlowOff(Math.max(0.45, G.spool));
        G.spool *= 0.55;
      }
    } else if (L < 0.3 && G.eng && rnd() < 0.5) {
      // downshift blip on overrun: a couple of crackles
      G.eng.pops(1 + Math.floor(rnd() * 2), 0.6);
    }
  }

  function playBackfire() {
    const t0 = now() + 0.004;
    const n = 1 + Math.floor(rnd() * 3);
    let t = t0;
    for (let i = 0; i < n; i++) {
      const s = (i === 0 ? 1 : 0.5 + rnd() * 0.45);
      noiseHit(t, { type: 'lowpass', f: 2200 + rnd() * 1800, q: 0.9, peak: 0.55 * s, attack: 0.0006, tau: 0.016 + rnd() * 0.02, verb: 0.6, drive: true });
      thump(t, 70 + rnd() * 30, 0.45 * s, 0.03);
      t += 0.035 + rnd() * 0.09;
    }
    if (G.eng) G.eng.pops(1 + Math.floor(rnd() * 3), 0.8);
  }

  let lastImpact = -1;
  let lastImpactI = 0;
  function playImpact(intensity) {
    const i = clamp(num(intensity, 0.5), 0, 1);
    const tn = now();
    if (tn - lastImpact < 0.09 && i < lastImpactI + 0.25) return; // rate limit
    lastImpact = tn;
    lastImpactI = i;
    const t = tn + 0.004;
    const I = 0.3 + 0.7 * i;
    // low body thump
    thump(t, 62, 0.75 * I, 0.07 + 0.05 * i);
    // crunch: broadband distorted burst + mid "crumple"
    noiseHit(t, { type: 'lowpass', f: 1600 + 4200 * i, q: 0.7, peak: 0.55 * I, attack: 0.0015, tau: 0.045 + 0.06 * i, drive: true, verb: 0.35 });
    noiseHit(t + 0.004, { type: 'bandpass', f: 700, q: 1.3, peak: 0.45 * I, tau: 0.07 + 0.08 * i, fEnd: 380 });
    // plastic/metal debris: a scatter of resonant pings
    const pieces = 2 + Math.round(6 * i);
    for (let k = 0; k < pieces; k++) {
      const dt = rnd() * (0.05 + 0.3 * i);
      noiseHit(t + dt, {
        type: 'bandpass',
        f: 1500 + rnd() * 5500,
        q: 18 + rnd() * 30,
        peak: (0.25 + rnd() * 0.35) * I,
        attack: 0.001,
        tau: 0.03 + rnd() * 0.12,
        verb: 0.25,
      });
    }
    // glass/carbon tinkle on hard hits
    if (i > 0.55) {
      for (let k = 0; k < 6; k++) {
        noiseHit(t + 0.03 + rnd() * 0.45, { type: 'bandpass', f: 5200 + rnd() * 4800, q: 50, peak: 0.25 * i, attack: 0.0005, tau: 0.015 + rnd() * 0.03, verb: 0.3 });
      }
    }
  }

  function tone(t, { f, type = 'sine', peak = 0.1, attack = 0.003, hold = 0.1, release = 0.04, dest, lp = 0, verb = 0, fEnd, detune = 0 }) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (fEnd) o.frequency.exponentialRampToValueAtTime(fEnd, t + attack + hold);
    o.detune.value = detune;
    const gg = gainNode(0);
    gg.gain.setValueAtTime(0, t);
    gg.gain.linearRampToValueAtTime(peak, t + attack);
    gg.gain.setValueAtTime(peak, t + attack + hold);
    gg.gain.setTargetAtTime(0, t + attack + hold, release);
    const nodes = [o, gg];
    let last = o;
    if (lp > 0) {
      const l = filt('lowpass', lp, 0.7);
      o.connect(l);
      last = l;
      nodes.push(l);
    }
    last.connect(gg);
    gg.connect(dest || G.ui);
    if (verb > 0) {
      const vs = gainNode(verb);
      gg.connect(vs).connect(G.verbIn);
      nodes.push(vs);
    }
    o.start(t);
    o.stop(t + attack + hold + release * 8 + 0.02);
    cleanup(o, nodes);
  }

  function playBeep(final) {
    const t = now() + 0.004;
    if (final) {
      tone(t, { f: 1568, type: 'square', peak: 0.075, hold: 0.55, release: 0.12, lp: 5000, verb: 0.25 });
      tone(t, { f: 1568, type: 'sine', peak: 0.12, hold: 0.55, release: 0.14, verb: 0.15 });
      tone(t, { f: 784, type: 'sawtooth', peak: 0.05, hold: 0.5, release: 0.15, lp: 2500 });
      thump(t, 55, 0.4, 0.09, G.ui);
    } else {
      tone(t, { f: 784, type: 'square', peak: 0.07, hold: 0.15, release: 0.03, lp: 4200, verb: 0.2 });
      tone(t, { f: 784, type: 'sine', peak: 0.11, hold: 0.15, release: 0.035 });
    }
  }

  function playUI(kind) {
    const t = now() + 0.003;
    switch (kind) {
      case 'hover':
        tone(t, { f: 2600, fEnd: 1800, type: 'sine', peak: 0.12, attack: 0.002, hold: 0.014, release: 0.014 });
        noiseHit(t, { type: 'highpass', f: 6000, q: 0.7, peak: 0.08, attack: 0.0008, tau: 0.005, dest: G.ui });
        break;
      case 'select':
        tone(t, { f: 520, fEnd: 1040, type: 'sawtooth', peak: 0.07, attack: 0.003, hold: 0.07, release: 0.04, lp: 3200 });
        tone(t + 0.07, { f: 1560, type: 'square', peak: 0.045, attack: 0.002, hold: 0.06, release: 0.06, lp: 4500, verb: 0.2 });
        noiseHit(t, { type: 'bandpass', f: 1500, fEnd: 6000, q: 0.9, peak: 0.06, attack: 0.03, tau: 0.06, dest: G.ui });
        break;
      case 'lap': {
        const notes = [76, 80, 83, 88];
        notes.forEach((m, k) => {
          tone(t + k * 0.075, { f: midiToHz(m), type: 'square', peak: 0.045, attack: 0.003, hold: 0.06, release: 0.12, lp: 4200, verb: 0.35 });
          tone(t + k * 0.075, { f: midiToHz(m), type: 'sawtooth', peak: 0.035, attack: 0.003, hold: 0.06, release: 0.12, lp: 3000, detune: 9 });
        });
        noiseHit(t, { type: 'bandpass', f: 900, fEnd: 5000, q: 0.8, peak: 0.05, attack: 0.08, tau: 0.08, dest: G.ui });
        break;
      }
      case 'finish': {
        // rising arpeggio into a big A-major chord swell with a crash
        const arp = [57, 61, 64, 69, 73, 76, 81, 85];
        arp.forEach((m, k) => tone(t + k * 0.065, { f: midiToHz(m), type: 'square', peak: 0.04, hold: 0.05, release: 0.1, lp: 4000, verb: 0.35 }));
        const tc = t + arp.length * 0.065;
        for (const m of [45, 57, 61, 64, 69, 73]) {
          for (const det of [-7, 8]) tone(tc, { f: midiToHz(m), type: 'sawtooth', peak: 0.018, attack: 0.02, hold: 1.1, release: 0.5, lp: 2600, verb: 0.3, detune: det });
        }
        noiseHit(tc, { type: 'highpass', f: 4500, q: 0.7, peak: 0.08, attack: 0.002, tau: 0.45, dest: G.ui, verb: 0.4 });
        thump(tc, 50, 0.3, 0.12, G.ui);
        break;
      }
      default:
        tone(t, { f: 1800, type: 'sine', peak: 0.05, hold: 0.02, release: 0.02 });
    }
  }

  // Distant police siren somewhere in the city: slow wail, far away (low-passed, reverberant).
  function playSiren() {
    const t = now() + 0.05;
    const dur = 11 + rnd() * 6;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    const base = 700 + rnd() * 80;
    o.frequency.setValueAtTime(base, t);
    let tt = t;
    while (tt < t + dur) {
      const per = 3.4 + rnd() * 0.8;
      o.frequency.linearRampToValueAtTime(base * 1.95, tt + per * 0.45);
      o.frequency.linearRampToValueAtTime(base, tt + per);
      tt += per;
    }
    // slow pitch drift (source moving) on top
    o.detune.setValueAtTime(0, t);
    o.detune.linearRampToValueAtTime((rnd() - 0.5) * 120, t + dur);
    const lp = filt('lowpass', 1500, 0.7);
    const env = gainNode(0);
    const pk = 0.016 + rnd() * 0.01;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(pk, t + dur * 0.4);
    env.gain.linearRampToValueAtTime(pk * 0.7, t + dur * 0.7);
    env.gain.linearRampToValueAtTime(0, t + dur);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : gainNode(1);
    if (pan.pan) {
      pan.pan.setValueAtTime(rnd() * 1.6 - 0.8, t);
      pan.pan.linearRampToValueAtTime(rnd() * 1.6 - 0.8, t + dur);
    }
    chain(o, lp, env, pan, G.amb);
    const vs = gainNode(0.8);
    env.connect(vs).connect(G.verbIn);
    o.start(t);
    o.stop(t + dur + 0.1);
    cleanup(o, [o, lp, env, pan, vs]);
  }

  function playThunder() {
    const t = now() + 0.01;
    const dur = 4.5 + rnd() * 3;
    const src = shotNoise(t, dur + 1);
    const lp1 = filt('lowpass', 140 + rnd() * 120, 0.9);
    const lp2 = filt('lowpass', 320, 0.6);
    const env = gainNode(0);
    const pk = 0.18 + rnd() * 0.12;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(pk * 0.5, t + 0.25);
    // rolling: a few swells
    let tt = t + 0.25;
    while (tt < t + dur * 0.6) {
      const step = 0.25 + rnd() * 0.6;
      env.gain.linearRampToValueAtTime(pk * (0.4 + rnd() * 0.6), tt + step);
      tt += step;
    }
    env.gain.setTargetAtTime(0, tt, dur * 0.18);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : gainNode(1);
    if (pan.pan) pan.pan.value = rnd() * 1.4 - 0.7;
    chain(src, lp1, lp2, env, pan, G.amb);
    const vs = gainNode(0.25);
    env.connect(vs).connect(G.verbIn);
    cleanup(src, [src, lp1, lp2, env, pan, vs]);
  }

  // ------------------------------------------------------------------------------------------
  // Global
  // ------------------------------------------------------------------------------------------
  function setAmbience(on) {
    S.ambience = !!on;
    if (!G) return;
    setP(G.amb.gain, S.ambience ? MIX.ambience : 0, S.ambience ? 1.2 : 0.6, 0.001);
    for (const gt of [G.ambL.gate, G.ambL.gateM, G.ambL.gateD]) setGate(gt, S.ambience, 4);
    if (S.ambience && !G.ambL.nextThunder) G.ambL.nextThunder = now() + 14 + rnd() * 20;
    if (S.ambience && !G.ambL.nextSiren) G.ambL.nextSiren = now() + 30 + rnd() * 40;
  }

  function setMusic(on) {
    S.music = !!on;
    if (!G) return;
    if (S.music) G.music.start();
    else G.music.stop();
  }

  function applyMaster() {
    if (!G) return;
    setP(G.master.gain, S.muted ? 0 : S.volume, 0.06, 0.0005);
  }

  function update(dt) {
    if (!G) return;
    const tNow = perfNow();
    // scrape: auto-release when the game stops calling playScrape
    const sc = G.scrape;
    if (sc.target > 0 && tNow - sc.lastCall > 90) {
      sc.target = 0;
      setScrapeLevel(0);
    } else if (sc.target > 0) {
      sc.target *= Math.exp(-num(dt, 0.016) * 2.5);
    }
    // skid squeal pitch wander (random walk, applied on next setSkid)
    const sk = G.skid;
    sk.wobT -= num(dt, 0.016);
    if (sk.wobT <= 0) {
      sk.wobT = 0.08 + rnd() * 0.15;
      sk.wob = clamp(sk.wob + (rnd() - 0.5) * 90, -110, 110);
      if (S.skid > 0.02) setSkid(S.skid);
    }
    // thunder
    if (S.ambience && G.ambL.nextThunder && now() > G.ambL.nextThunder) {
      G.ambL.nextThunder = now() + 25 + rnd() * 40;
      playThunder();
    }
    if (S.ambience && G.ambL.nextSiren && now() > G.ambL.nextSiren) {
      G.ambL.nextSiren = now() + 70 + rnd() * 80;
      playSiren();
    }
    if (S.music) G.music.pump();
  }

  const api = {
    init,
    setEngine: (p) => {
      try { setEngine(p); } catch (e) { warn(e); }
    },
    setOpponents: safe(setOpponents),
    setSkid: (v) => {
      try { setSkid(v); } catch (e) { warn(e); }
    },
    setNitro: (a) => {
      try { setNitro(a); } catch (e) { warn(e); }
    },
    setWind: (v) => {
      try { setWind(v); } catch (e) { warn(e); }
    },
    playShift: safe(playShift),
    playBackfire: safe(playBackfire),
    playImpact: safe(playImpact),
    playScrape: safe(playScrape),
    playBeep: safe(playBeep),
    playUI: safe(playUI),
    playBlowOff: safe(playBlowOff),
    playThunder: safe(playThunder),
    playSiren: safe(playSiren),
    setAmbience: (on) => {
      try { setAmbience(on); } catch (e) { warn(e); }
    },
    setMusic: (on) => {
      try { setMusic(on); } catch (e) { warn(e); }
    },
    setMasterVolume(v) {
      S.volume = clamp(num(v, S.volume), 0, 1.5);
      try { applyMaster(); } catch (e) { warn(e); }
    },
    toggleMute() {
      S.muted = !S.muted;
      try { applyMaster(); } catch (e) { warn(e); }
      return S.muted;
    },
    setMuted(m) {
      S.muted = !!m;
      try { applyMaster(); } catch (e) { warn(e); }
      return S.muted;
    },
    /** Optional: duck car layers while the game is paused (music/ambience keep going, softer). */
    setPaused(p) {
      S.paused = !!p;
      if (!G) return;
      try {
        watchdog();
        setP(G.fx.gain, S.paused ? 0 : MIX.fx, 0.08, 0.001);
        G.music.setLevel(S.paused ? MIX.music * 0.6 : MIX.music);
      } catch (e) { warn(e); }
    },
    /** Optional: road wetness 0..1 (default 0.85 for the rain-soaked circuit). */
    setWet(w) {
      S.wet = clamp(num(w, S.wet), 0, 1);
    },
    update: (dt) => {
      try { update(dt); } catch (e) { warn(e); }
    },
    get muted() { return S.muted; },
    get ready() { return !!(G && G.eng); },
    get context() { return ctx; },
    get engineKind() { return G && G.eng ? G.eng.kind : null; },
    /** Debug/test handle on the internal graph (do not use from game code). */
    get _graph() { return G; },
    /** Debug/test: schedule music this far ahead (offline rendering). */
    _pumpMusic(ahead) {
      if (G && G.music.on) G.music.pump(ahead);
    },
    dispose() {
      try {
        if (watchdogTimer) clearInterval(watchdogTimer);
        removeUnlock();
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
        if (G && G.music) G.music.stop();
        if (ctx && !isOfflineCtx(ctx) && !options.context) ctx.close();
      } catch (e) { /* ignore */ }
      G = null;
    },
  };
  return api;
}
