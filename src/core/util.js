// Small shared helpers for the game core (no side effects at import time).
import { wrapAngle } from '../config.js';

export const TAU = Math.PI * 2;

export const smoothstep = (e0, e1, x) => {
  const t = x <= e0 ? 0 : x >= e1 ? 1 : (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
};

export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Frame-rate independent exponential smoothing of an angle (shortest way round).
export const dampAngle = (a, b, lambda, dt) => a + wrapAngle(b - a) * (1 - Math.exp(-lambda * dt));

// Move `v` toward `target` by at most `rate * dt`.
export const approach = (v, target, rate, dt) => {
  const d = target - v;
  const m = rate * dt;
  return d > m ? v + m : d < -m ? v - m : target;
};

export const ordinal = (n) => {
  const s = ['TH', 'ST', 'ND', 'RD'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

export const formatTime = (t) => {
  if (t == null || !isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
};

export const hexColor = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);

// Cheap smooth 1D value noise (sum of incommensurate sines) — used for camera shake.
export const wobble = (t, seed = 0) =>
  Math.sin(t * 1.0 + seed) * 0.5 + Math.sin(t * 2.31 + seed * 1.7) * 0.3 + Math.sin(t * 5.13 + seed * 2.9) * 0.2;

/**
 * Error-isolating call wrapper: a failing subsystem logs once (with its name) and the
 * game loop keeps running. `fn` should be a pre-bound function so the hot path does not allocate.
 */
export function createGuard() {
  const failed = new Map();
  function guard(name, fn, a, b, c) {
    try {
      return fn(a, b, c);
    } catch (e) {
      const n = (failed.get(name) || 0) + 1;
      failed.set(name, n);
      if (n === 1) console.error(`[core] subsystem "${name}" threw (further errors suppressed):`, e);
      return undefined;
    }
  }
  guard.failures = failed;
  return guard;
}

// Fallback no-op objects matching module contracts, used if a module fails to construct.
const noop = () => {};
export const NOOP_AUDIO = {
  init: noop, setEngine: noop, setOpponents: noop, setSkid: noop, setNitro: noop, setWind: noop,
  playShift: noop, playBackfire: noop, playImpact: noop, playScrape: noop, playBeep: noop, playUI: noop,
  setAmbience: noop, setMusic: noop, setMasterVolume: noop, toggleMute: () => false, update: noop,
};
export const NOOP_PARTICLES = {
  emitSmoke: noop, emitSpray: noop, emitSparks: noop, emitNitroFlame: noop, addSkidMark: noop, update: noop,
};
export const NOOP_RAIN = { update: noop, setIntensity: noop };
export const NOOP_HUD = {
  showMenu: noop, hideMenu: noop, showHUD: noop, setTrack: noop, update: noop, showCountdown: noop,
  hideCountdown: noop, flash: noop, showPause: noop, showResults: noop, hideResults: noop,
};
