// Drives particle effects from physics state: wet-road spray, tire smoke, skid marks,
// nitro / backfire flames and collision sparks. Emission runs at a fixed tick rate per car
// (independent of frame rate); AI cars get a reduced budget that falls off with distance.
import * as THREE from 'three';
import { clamp } from '../config.js';
import { smoothstep } from './util.js';

const WHEELS = ['fl', 'fr', 'rl', 'rr'];
const SKID_ON = 0.35;

const _F = new THREE.Vector3();
const _R = new THREE.Vector3();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();

export class EffectsDirector {
  constructor(particles, { quality = 'high' } = {}) {
    this.particles = particles;
    this.low = quality === 'low';
  }

  /** End every skid strip of a car (after resets/teleports). */
  /** Clear every particle/skid mark (on restart), if the module supports it. */
  clear(cars) {
    if (typeof this.particles.clear === 'function') this.particles.clear();
    for (const car of cars) for (const w of WHEELS) car.skidOn[w] = false;
  }

  endSkids(car) {
    const P = this.particles;
    for (const w of WHEELS) {
      if (car.skidOn[w]) P.addSkidMark(car.skidIds[w], car.wheelWorld[w], _R.set(1, 0, 0), 0);
      car.skidOn[w] = false;
    }
  }

  // The particle module is rate-based (it scales spawn counts by its own frame dt), so every
  // emitter is called exactly once per frame per source; distant AI cars are skipped entirely.
  update(dt, cars, camPos, raceLive) {
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      car.distToCam = Math.hypot(car.renderPos.x - camPos.x, car.renderPos.z - camPos.z);
      car.updateAnchors();
      this._contacts(car);
      if (!car.isPlayer && car.distToCam > 170) {
        if (car.skidOn.rl || car.skidOn.rr || car.skidOn.fl || car.skidOn.fr) this.endSkids(car);
        continue;
      }
      this._emit(car, dt, raceLive);
    }
  }

  _emit(car, dt, raceLive) {
    const P = this.particles;
    const ph = car.physics;
    const h = car.renderHeading;
    _F.set(Math.sin(h), 0, Math.cos(h));
    _R.set(-Math.cos(h), 0, Math.sin(h));
    const kmh = ph.speedKmh || 0;
    const v = ph.velocity;
    const near = car.isPlayer || car.distToCam < 60;
    const lowScale = this.low ? 0.6 : 1;

    // --- Wet-road spray kicked up behind the tyres (the signature wet look) ---
    if (kmh > 30) {
      const inten = clamp((kmh - 30) / 190, 0, 1) * (car.isPlayer ? 1 : 0.75) * lowScale;
      for (let k = 0; k < 4; k++) {
        const w = WHEELS[k];
        const front = k < 2;
        if (front && !car.isPlayer) continue;
        const left = k === 0 || k === 2; // +X local = car's left = −R
        const wi = front ? inten * 0.35 : inten;
        // Emit just behind and outboard of the contact patch; the particle module derives the
        // fling / wake motion from the car's own velocity (passed unscaled).
        _p.copy(car.wheelWorld[w]).addScaledVector(_F, -0.42).addScaledVector(_R, left ? -0.08 : 0.08);
        _p.y = 0.12;
        P.emitSpray(_p, v, wi);
      }
      // Turbulent mist wake behind the car body at speed.
      if (near && kmh > 90) {
        const wake = smoothstep(90, 260, kmh) * (car.isPlayer ? 0.9 : 0.6) * lowScale;
        _p.set(car.renderPos.x, 0.35, car.renderPos.z).addScaledVector(_F, -2.6);
        P.emitSpray(_p, v, wake);
      }
    }

    // --- Tyre smoke + skid marks ---
    const braking = (ph.brake || 0) > 0.5 && (ph.speed || 0) > 3;
    const hand = !!car.controls.handbrake;
    const skid = ph.skid || {};
    const marks = car.isPlayer || car.distToCam < 120;
    for (let k = 0; k < 4; k++) {
      const w = WHEELS[k];
      const front = k < 2;
      const sv = skid[w] || 0;
      let on = sv > SKID_ON && (Math.abs(ph.speed || 0) > 1.5 || !front);
      if (front && !(braking || hand) && sv < 0.6) on = false;
      if (!raceLive && Math.abs(ph.speed || 0) < 0.5) on = false;
      const inten = clamp((sv - SKID_ON) / (1 - SKID_ON), 0, 1);
      if (on && marks) {
        P.addSkidMark(car.skidIds[w], car.wheelWorld[w], _R, 0.25 + 0.75 * inten);
        car.skidOn[w] = true;
      } else if (car.skidOn[w]) {
        P.addSkidMark(car.skidIds[w], car.wheelWorld[w], _R, 0);
        car.skidOn[w] = false;
      }
      if (on && (near || !front)) {
        _p.copy(car.wheelWorld[w]);
        _p.y = 0.2;
        P.emitSmoke(_p, v, inten * (car.isPlayer ? 0.85 : 0.6) * lowScale);
      }
    }

    // --- Nitro flames / backfire pops ---
    const ex = car.exhaustWorld;
    if (ex.length) {
      _d.copy(_F).negate();
      const fl = ph.nitroActive ? 1 : car.backfire > 0 ? 0.45 : 0;
      if (fl > 0 && (near || car.distToCam < 150)) {
        // Passing the car velocity lets a fresh flame slot dead-reckon from its very first frame.
        for (let i = 0; i < ex.length; i++) P.emitNitroFlame(ex[i], _d, fl, ph.velocity);
      }
    }
    if (car.backfire > 0) car.backfire -= dt;
  }

  _contacts(car) {
    const P = this.particles;
    const c = car.contact;
    if (c.wallTouching && (c.wallImpact > 1.2 || c.wallScrape > 4)) {
      const inten = clamp(c.wallImpact / 14 + c.wallScrape / 45, 0.1, 1);
      if (car.isPlayer || car.distToCam < 120) P.emitSparks(c.wallPoint, c.wallNormal, inten, car.physics.velocity);
    }
    // Both cars of a pair record the hit; only the lower index emits so sparks aren't doubled.
    if (c.carImpact > 2.0 && c.carOther > car.index && (car.isPlayer || car.distToCam < 120)) {
      P.emitSparks(c.carPoint, c.carNormal, clamp(c.carImpact / 12, 0.15, 1), car.physics.velocity);
    }
  }
}
