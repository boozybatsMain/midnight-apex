// Keyboard + Gamepad input for MIDNIGHT APEX.
// Produces smoothed driving controls ({ throttle, brake, steer, handbrake, nitro }) and
// edge-triggered UI actions (camera, reset, pause, mute, confirm, debug) consumed by the game.
import { clamp } from '../config.js';
import { approach, smoothstep } from './util.js';

const KEYS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  nitro: ['ShiftLeft', 'ShiftRight', 'KeyN'],
};
const ACTION_KEYS = {
  KeyC: 'camera',
  KeyR: 'reset',
  Escape: 'pause',
  KeyP: 'pause',
  KeyM: 'mute',
  Enter: 'confirm',
  NumpadEnter: 'confirm',
  Backquote: 'debug',
};
// Keys whose default browser behaviour (page scroll, focus moves) must be suppressed.
const PREVENT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'PageUp', 'PageDown', 'Home', 'End']);

// Standard gamepad mapping indices.
const GP = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, DUP: 12, DDOWN: 13, DLEFT: 14, DRIGHT: 15 };
const STICK_DEADZONE = 0.12;
const TRIGGER_DEADZONE = 0.04;

// Digital steering feel (units of full lock per second).
const STEER_RISE = 6.0; // ramp toward lock
const STEER_FALL = 10.0; // self-centering / counter-steer is faster
const PEDAL_RISE = 7.0;
const PEDAL_FALL = 11.0;

export class Input {
  constructor(target = window) {
    this.down = new Set();
    this.actions = { camera: false, reset: false, pause: false, mute: false, confirm: false, debug: false };
    this.controls = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false };
    // Raw (unsmoothed) driver intent, useful for revving during the countdown.
    this.raw = { throttle: 0, brake: 0, steer: 0 };
    this.lastDevice = 'keyboard';
    this.enabled = true;
    this.onGesture = null; // called on the first key/pointer gesture (audio unlock)

    this._gpConnected = false;
    this._gpPrev = new Uint8Array(17);
    this._gp = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false, active: false };

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = () => this.down.clear();
    this._onPointer = () => this._gesture();
    target.addEventListener('keydown', this._onKeyDown, { passive: false });
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
    target.addEventListener('pointerdown', this._onPointer);
    target.addEventListener('gamepadconnected', () => { this._gpConnected = true; });
    target.addEventListener('gamepaddisconnected', () => { this._gpConnected = this._anyGamepad() != null; });
    this._gpConnected = this._anyGamepad() != null;
  }

  _gesture() {
    if (this.onGesture) this.onGesture();
  }

  _onKeyDown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // leave browser shortcuts alone
    if (PREVENT.has(e.code)) e.preventDefault();
    this.lastDevice = 'keyboard';
    this._gesture();
    if (e.repeat) return;
    this.down.add(e.code);
    const action = ACTION_KEYS[e.code];
    if (action) this.actions[action] = true;
  }

  _onKeyUp(e) {
    this.down.delete(e.code);
  }

  _held(list) {
    for (let i = 0; i < list.length; i++) if (this.down.has(list[i])) return true;
    return false;
  }

  /** Returns and clears an edge-triggered action. */
  consume(name) {
    const v = this.actions[name];
    this.actions[name] = false;
    return v;
  }

  clearActions() {
    for (const k in this.actions) this.actions[k] = false;
  }

  /** Zero the smoothed controls (e.g. on restart / reset). */
  resetControls() {
    const c = this.controls;
    c.throttle = c.brake = c.steer = 0;
    c.handbrake = c.nitro = false;
  }

  _anyGamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) return pads[i];
    return null;
  }

  // Gamepad button helpers (methods rather than per-frame closures: no allocations).
  _bVal(b, i) {
    const x = b[i];
    return x ? (typeof x === 'object' ? x.value : x) : 0;
  }

  _bPressed(b, i) {
    const x = b[i];
    return x ? !!x.pressed || this._bVal(b, i) > 0.5 : false;
  }

  _bEdge(b, i) {
    const p = this._bPressed(b, i) ? 1 : 0;
    const was = this._gpPrev[i];
    this._gpPrev[i] = p;
    return p === 1 && was === 0;
  }

  _pollGamepad() {
    const g = this._gp;
    g.active = false;
    if (!this._gpConnected) return;
    const pad = this._anyGamepad();
    if (!pad) return;
    const b = pad.buttons;

    let sx = pad.axes[0] || 0;
    const ax = Math.abs(sx);
    sx = ax < STICK_DEADZONE ? 0 : Math.sign(sx) * Math.pow((ax - STICK_DEADZONE) / (1 - STICK_DEADZONE), 1.35);
    if (this._bPressed(b, GP.DLEFT)) sx = -1;
    if (this._bPressed(b, GP.DRIGHT)) sx = 1;
    let rt = this._bVal(b, GP.RT);
    let lt = this._bVal(b, GP.LT);
    rt = rt < TRIGGER_DEADZONE ? 0 : rt;
    lt = lt < TRIGGER_DEADZONE ? 0 : lt;
    if (this._bPressed(b, GP.DUP)) rt = Math.max(rt, 1);
    if (this._bPressed(b, GP.DDOWN)) lt = Math.max(lt, 1);

    g.steer = sx;
    g.throttle = rt;
    g.brake = lt;
    g.handbrake = this._bPressed(b, GP.X) || this._bPressed(b, GP.A);
    g.nitro = this._bPressed(b, GP.B) || this._bPressed(b, GP.RB);
    g.active = sx !== 0 || rt > 0 || lt > 0 || g.handbrake || g.nitro;

    if (this._bEdge(b, GP.Y)) this.actions.camera = true;
    if (this._bEdge(b, GP.START)) this.actions.pause = true;
    if (this._bEdge(b, GP.BACK)) this.actions.reset = true;
    if (this._bEdge(b, GP.A)) this.actions.confirm = true;
    if (g.active) {
      if (this.lastDevice !== 'gamepad') this._gesture();
      this.lastDevice = 'gamepad';
    }
  }

  /**
   * Update smoothed controls. `speedKmh` reduces maximum steering lock at speed
   * (the physics adds its own speed sensitivity, so this is gentle).
   */
  update(dt, speedKmh = 0) {
    this._pollGamepad();
    const c = this.controls;
    const raw = this.raw;
    if (!this.enabled) {
      raw.throttle = raw.brake = raw.steer = 0;
      c.throttle = approach(c.throttle, 0, PEDAL_FALL, dt);
      c.brake = approach(c.brake, 0, PEDAL_FALL, dt);
      c.steer = approach(c.steer, 0, STEER_FALL, dt);
      c.handbrake = c.nitro = false;
      return c;
    }
    const g = this._gp;
    const kThrottle = this._held(KEYS.throttle) ? 1 : 0;
    const kBrake = this._held(KEYS.brake) ? 1 : 0;
    const kSteer = (this._held(KEYS.right) ? 1 : 0) - (this._held(KEYS.left) ? 1 : 0);

    raw.throttle = Math.max(kThrottle, g.throttle);
    raw.brake = Math.max(kBrake, g.brake);
    raw.steer = kSteer !== 0 ? kSteer : g.steer;

    // Pedals: digital keys ramp, analog triggers pass through directly.
    const tThrottle = kThrottle;
    const tBrake = kBrake;
    c.throttle = approach(c.throttle, tThrottle, tThrottle > c.throttle ? PEDAL_RISE : PEDAL_FALL, dt);
    c.brake = approach(c.brake, tBrake, tBrake > c.brake ? PEDAL_RISE : PEDAL_FALL, dt);
    if (g.throttle > c.throttle) c.throttle = g.throttle;
    if (g.brake > c.brake) c.brake = g.brake;

    // Steering: high speed trims maximum lock a little (1.0 → 0.8 by ~280 km/h; the physics adds its own falloff).
    const maxLock = 1 - 0.2 * smoothstep(60, 280, speedKmh);
    if (kSteer !== 0) {
      const target = kSteer * maxLock;
      const towardLock = Math.sign(target) === Math.sign(c.steer) && Math.abs(target) > Math.abs(c.steer);
      const rate = c.steer === 0 || towardLock ? STEER_RISE : STEER_FALL;
      c.steer = approach(c.steer, target, rate, dt);
    } else if (g.steer !== 0) {
      // Analog stick: light smoothing only, still speed-limited.
      c.steer = approach(c.steer, g.steer * (0.25 + 0.75 * maxLock), 14, dt);
    } else {
      c.steer = approach(c.steer, 0, STEER_FALL, dt);
    }
    c.steer = clamp(c.steer, -1, 1);
    c.handbrake = this.down.has('Space') || g.handbrake;
    c.nitro = this._held(KEYS.nitro) || g.nitro;
    return c;
  }
}
