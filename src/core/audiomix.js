// Audio director: maps game/physics state to the audio module's contract every frame
// (engine, opponents with stereo pan, skid, nitro, wind, shifts, backfires, impacts, scrapes).
import * as THREE from 'three';
import { clamp } from '../config.js';
import { smoothstep } from './util.js';

const _camRight = new THREE.Vector3();
const EMPTY = [];

export class AudioDirector {
  constructor(audio) {
    this.audio = audio;
    this.opp = [];
    this._pool = [];
    for (let i = 0; i < 4; i++) this._pool.push({ rpm: 0, throttle: 0, distance: 0, pan: 0 });
    this._sorted = [];
    this._engine = { rpm: 0, maxRpm: 8000, throttle: 0, load: 0, gear: 1, speedKmh: 0 };
    this.scrapeCooldown = 0;
    this.quietTimer = 0;
  }

  /** Engine + continuous layers for the player car. */
  update(dt, { player, cars, camera, mode, raceLive }) {
    const A = this.audio;
    const ph = player.physics;
    const e = this._engine;
    const paused = mode === 'paused';

    // --- Player engine ---
    e.maxRpm = ph.maxRpm || 8000;
    e.speedKmh = paused ? 0 : ph.speedKmh || 0;
    if (paused) {
      e.rpm = ph.idleRpm || 900;
      e.throttle = 0;
      e.load = 0;
    } else {
      e.rpm = player.displayRpm;
      e.throttle = raceLive ? ph.throttle || 0 : player.rev.throttle;
      // Free-revving on the grid has little load; on the move load follows the pedal.
      e.load = raceLive ? clamp(e.throttle * (ph.gear > 0 ? 1 : 0.7), 0, 1) : e.throttle * 0.3;
    }
    e.gear = raceLive ? ph.gear : 0;
    A.setEngine(e);

    // --- Opponents: nearest 4 to the camera, panned by camera-relative x ---
    const opp = this.opp;
    opp.length = 0;
    if (!paused) {
      _camRight.setFromMatrixColumn(camera.matrixWorld, 0);
      const sorted = this._sorted;
      sorted.length = 0;
      for (let i = 0; i < cars.length; i++) if (cars[i] !== player) sorted.push(cars[i]);
      sorted.sort(byDist);
      const n = Math.min(4, sorted.length);
      for (let i = 0; i < n; i++) {
        const c = sorted[i];
        const o = this._pool[i];
        const dx = c.renderPos.x - camera.position.x;
        const dz = c.renderPos.z - camera.position.z;
        const d = Math.hypot(dx, dz) || 1;
        o.rpm = c.displayRpm;
        o.throttle = raceLive ? c.physics.throttle || 0 : c.rev.throttle;
        o.distance = d;
        o.pan = clamp((dx * _camRight.x + dz * _camRight.z) / d, -1, 1);
        opp.push(o);
      }
    }
    A.setOpponents(paused ? EMPTY : opp);

    // --- Tyres, nitro, wind ---
    if (paused) {
      A.setSkid(0);
      A.setNitro(false);
      A.setWind(0);
    } else {
      const sk = ph.skid || {};
      const maxSkid = Math.max(sk.fl || 0, sk.fr || 0, sk.rl || 0, sk.rr || 0);
      A.setSkid(clamp((maxSkid - 0.22) / 0.6, 0, 1) * smoothstep(0.8, 5, Math.abs(ph.speed || 0)));
      A.setNitro(!!ph.nitroActive);
      A.setWind(ph.speedKmh || 0);
    }

    if (!paused) {
      this._oneShots(dt, player, cars, raceLive);
    }
    A.update(dt);
  }

  _oneShots(dt, player, cars, raceLive) {
    const A = this.audio;
    const ph = player.physics;

    // Gear changes.
    const sc = ph.shiftCount || 0;
    if (raceLive && sc !== player.lastShiftCount) A.playShift(!!ph.lastShiftUp);
    player.lastShiftCount = sc;

    // Lift-off backfire at high rpm (+ occasional crackle on the overrun).
    player.backfireCooldown -= dt;
    const thr = raceLive ? ph.throttle || 0 : player.rev.throttle;
    const rpmN = player.displayRpm / (ph.maxRpm || 8000);
    // Physics reports sharp high-rpm lifts via backfireCount; on the grid we detect blips ourselves.
    const bfc = ph.backfireCount || 0;
    const physLift = raceLive && bfc !== player.lastBackfireCount;
    player.lastBackfireCount = bfc;
    if (player.backfireCooldown <= 0) {
      const lift = physLift || (!raceLive && player.prevThrottle > 0.6 && thr < 0.25 && rpmN > 0.6);
      const overrun = raceLive && thr < 0.05 && rpmN > 0.55 && (ph.speedKmh || 0) > 60 && Math.random() < dt * 0.9;
      if (lift || overrun) {
        A.playBackfire();
        player.backfire = lift ? 0.14 : 0.08;
        player.backfireCooldown = lift ? 0.35 : 0.5;
      }
    }
    player.prevThrottle = thr;

    // Impacts and scrapes (player at full volume, nearby AI attenuated by distance).
    this.scrapeCooldown -= dt;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      const con = c.contact;
      c.impactCooldown -= dt;
      const att = c.isPlayer ? 1 : clamp(1 - c.distToCam / 70, 0, 1) * 0.7;
      if (att <= 0.02) continue;
      const hit = Math.max(con.wallImpact, c.isPlayer || con.carOther !== player.index ? con.carImpact : 0);
      if (hit > 2 && c.impactCooldown <= 0) {
        A.playImpact(clamp(hit / 16, 0.12, 1) * att);
        c.impactCooldown = 0.18;
      }
      if (c.isPlayer && con.wallTouching && con.wallScrape > 2.5) {
        A.playScrape(clamp(con.wallScrape / 30, 0.15, 1));
      } else if (c.isPlayer && con.carOther >= 0 && con.carImpact < 2) {
        // rubbing door-to-door
        const o = cars[con.carOther];
        if (o) {
          const rv = Math.hypot(o.physics.velocity.x - ph.velocity.x, o.physics.velocity.z - ph.velocity.z);
          if (rv > 2) A.playScrape(clamp(rv / 25, 0.1, 0.6));
        }
      }
    }
  }
}

function byDist(a, b) {
  return a.distToCam - b.distToCam;
}
