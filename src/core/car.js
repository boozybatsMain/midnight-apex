// A racer = visual model + physics + optional AI + per-car bookkeeping used by the core.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createContactState } from './collisions.js';

const WHEELS = ['fl', 'fr', 'rl', 'rr'];

export class RaceCar {
  constructor({ index, livery, isPlayer, model, physics, ai }) {
    this.index = index;
    this.name = livery.name;
    this.color = livery.color;
    this.accent = livery.accent;
    this.isPlayer = isPlayer;
    this.model = model;
    this.physics = physics;
    this.ai = ai || null;
    this.active = true;

    this.s = 0;
    this.lateral = 0;
    this.gridSlot = index;
    this.gridOffset = 0; // distance from grid slot to start line (for DNF estimates)

    this.prevPos = new THREE.Vector3();
    this.prevHeading = 0;
    this.renderPos = new THREE.Vector3();
    this.renderHeading = 0;

    this.controls = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false };
    this.contact = createContactState();
    this.ghost = 0; // seconds of no car-car collision after a reset
    this.stuckTimer = 0;

    // Countdown free-rev simulation (physics has no neutral) + AI rev blips.
    this.rev = { rpm: 0, throttle: 0, blipTimer: Math.random(), blipHold: 0, blipAmount: 0 };
    this.launchBlend = 1; // 1 = physics rpm fully, <1 blends from rev rpm after GO

    // Effects state.
    this.skidOn = { fl: false, fr: false, rl: false, rr: false };
    this.skidIds = {};
    for (const w of WHEELS) this.skidIds[w] = `${index}-${w}`;
    this.wheelWorld = { fl: new THREE.Vector3(), fr: new THREE.Vector3(), rl: new THREE.Vector3(), rr: new THREE.Vector3() };
    this.exhaustWorld = [];
    const ex = (model && model.exhaustLocal) || [];
    for (let i = 0; i < ex.length; i++) this.exhaustWorld.push(new THREE.Vector3());
    this.lastShiftCount = 0;
    this.nitroVis = 0;
    this.distToCam = 0;
    this.blinkTimer = 0;
    this.backfire = 0; // seconds of exhaust pop flame left
    this.prevThrottle = 0;
    this.lastBackfireCount = 0;
    this.backfireCooldown = 0;
    this.impactCooldown = 0;
    this.displayRpm = 900;

    this._tan = new THREE.Vector3();
    this._proj = { s: 0, lateral: 0, distance: 0 };
    this.state = {
      steerAngle: 0, wheelSpinFront: 0, wheelSpinRear: 0, pitch: 0, roll: 0,
      brake: 0, reversing: false, nitro: 0, headlights: true,
    };
  }

  /** Place at rest. */
  place(position, heading) {
    const ph = this.physics;
    ph.reset(position, heading);
    this.prevPos.copy(ph.position);
    this.prevHeading = ph.heading;
    this.renderPos.copy(ph.position);
    this.renderHeading = ph.heading;
    this.stuckTimer = 0;
    this.launchBlend = 1;
    this.rev.rpm = ph.idleRpm || 900;
    this.rev.throttle = 0;
    this.lastShiftCount = ph.shiftCount || 0;
    this.lastBackfireCount = ph.backfireCount || 0;
    this.backfire = 0;
    for (const w of WHEELS) this.skidOn[w] = false;
    this.syncModel();
  }

  savePrev() {
    this.prevPos.copy(this.physics.position);
    this.prevHeading = this.physics.heading;
  }

  /** Render interpolation between the last two physics states. */
  interpolate(alpha) {
    const ph = this.physics;
    this.renderPos.lerpVectors(this.prevPos, ph.position, alpha);
    this.renderPos.y = 0;
    let dh = ph.heading - this.prevHeading;
    if (dh > Math.PI) dh -= Math.PI * 2;
    else if (dh < -Math.PI) dh += Math.PI * 2;
    this.renderHeading = this.prevHeading + dh * alpha;
  }

  syncModel() {
    const root = this.model && this.model.root;
    if (!root) return;
    root.position.set(this.renderPos.x, 0, this.renderPos.z);
    root.rotation.y = this.renderHeading;
  }

  /** World positions of wheel contact patches and exhaust tips (from render transform). */
  updateAnchors() {
    const h = this.renderHeading;
    const s = Math.sin(h), c = Math.cos(h);
    const p = this.renderPos;
    const wl = this.model.wheelLocal || DEFAULT_WHEELS;
    for (const w of WHEELS) {
      const l = wl[w];
      this.wheelWorld[w].set(p.x + l.x * c + l.z * s, 0.02, p.z - l.x * s + l.z * c);
    }
    const ex = this.model.exhaustLocal || [];
    for (let i = 0; i < this.exhaustWorld.length; i++) {
      const l = ex[i];
      this.exhaustWorld[i].set(p.x + l.x * c + l.z * s, l.y, p.z - l.x * s + l.z * c);
    }
  }
}

const c = CONFIG.car;
const DEFAULT_WHEELS = {
  fl: new THREE.Vector3(c.trackWidth / 2, 0, c.frontAxleZ),
  fr: new THREE.Vector3(-c.trackWidth / 2, 0, c.frontAxleZ),
  rl: new THREE.Vector3(c.trackWidth / 2, 0, c.rearAxleZ),
  rr: new THREE.Vector3(-c.trackWidth / 2, 0, c.rearAxleZ),
};

export { WHEELS };
