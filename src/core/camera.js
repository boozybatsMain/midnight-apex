// Camera rig: spring-damped chase cameras, hood/bumper cams, and scripted cinematic shots
// (menu attract orbit, intro sweep, finish orbit). All math is allocation-free per frame.
import * as THREE from 'three';
import { CONFIG, LAYERS, clamp, damp, lerp, wrapAngle } from '../config.js';
import { dampAngle, easeInOutCubic, smoothstep, wobble } from './util.js';

export const CAMERA_MODES = ['chase-far', 'chase-near', 'hood', 'bumper'];

const CHASE = {
  'chase-far': { dist: 6.2, height: 2.0, lookH: 1.0, lookAhead: 2.6, fov: 62, fovMax: 85 },
  'chase-near': { dist: 4.75, height: 1.62, lookH: 0.92, lookAhead: 2.4, fov: 63, fovMax: 87 },
};
// Cockpit cams are rigidly mounted on the body (they pitch / roll with it, so the hood never swims in
// frame). `shake` scales the high-speed buzz / impact shake: a hood-mounted camera shakes WITH the hood.
const COCKPIT = {
  hood: { x: 0, y: 1.08, z: 0.25, lookY: 0.78, fov: 66, fovMax: 78, shake: 0.35 },
  bumper: { x: 0, y: 0.5, z: 2.4, lookY: 0.42, fov: 68, fovMax: 92, shake: 1.2 },
};
const HOOD_LENS_HEIGHT = 0.2; // hood cam: lens height above the hood surface (m)
const HOOD_FRAC = 0.15; // ...and how much of the frame (from the bottom) the hood centre fills at cruising FOV (fenders sit a bit higher)
const BODY_PIVOT_Y = CONFIG.car.wheelRadius; // the car model pitches / rolls its body about wheel-centre height

// Menu attract shots, in car-local space (+X = car's left, +Z = forward). Each lerps from a→b.
const SHOT_LEN = 7.0;
const SHOTS = [
  { kind: 'orbit', fov: 44 },
  { kind: 'dolly', from: [3.3, 0.42, 4.2], to: [3.0, 0.5, -2.4], lookFrom: [0, 0.5, 0.9], lookTo: [0, 0.6, -1.0], fov: 38 },
  { kind: 'dolly', from: [-4.2, 2.8, -6.8], to: [-3.0, 0.8, -5.0], lookFrom: [0, 0.4, 0.2], lookTo: [0, 0.65, 0.0], fov: 42 },
  { kind: 'dolly', from: [1.2, 0.36, 5.6], to: [-1.0, 0.45, 4.7], lookFrom: [0, 0.55, 0], lookTo: [0, 0.55, 0], fov: 36 },
];

const UP = new THREE.Vector3(0, 1, 0);

export class CameraRig {
  constructor(camera, { track } = {}) {
    this.camera = camera;
    // Game cameras see the NO_REFLECTION layer (flames, sparks, rain...) that the wet-road mirror skips.
    camera.layers.enable(LAYERS.NO_REFLECTION);
    this.track = track || null;
    this.modeIndex = 0;
    this.script = 'chase'; // 'chase' | 'orbit' | 'intro' | 'finish'
    this.scriptT = 0;
    this.scriptDuration = 2.6;
    this.onScriptEnd = null;

    // Chase state.
    this.yaw = 0;
    this.dist = CHASE['chase-far'].dist;
    this.height = CHASE['chase-far'].height;
    this.accel = 0;
    this._prevSpeed = 0;
    this.fov = 62;
    this.nitroKick = 0;
    this.roll = 0;
    this.trauma = 0;
    this.time = 0;
    this._camS = undefined;
    this.cockpit = {}; // per-model hood/bumper placement (see calibrate)
    this._proj = { s: 0, lateral: 0, distance: 0 };

    this.velocity = new THREE.Vector3();
    this.position = camera.position;
    this._prevPos = new THREE.Vector3();
    this._hasPrev = false;

    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._fromPos = new THREE.Vector3();
    this._fromLook = new THREE.Vector3();
    this._fromFov = 62;
    this._fromPending = false;
    this.blendTime = 0;
    this._f = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._camUp = new THREE.Vector3(0, 1, 0); // camera up for lookAt (tilted by the body in cockpit cams)
    this._bodyRot = { cp: 1, sp: 0, cr: 1, sr: 0 };
  }

  get mode() {
    return CAMERA_MODES[this.modeIndex];
  }

  /**
   * Fit the hood / bumper cameras to the actual car model by ray-casting its body: find the
   * windshield base (where the top surface starts rising steeply) and sit just above the hood
   * in front of it; put the bumper cam just ahead of the front-most body point.
   */
  calibrate(model) {
    const target = (model && (model.body || model.root)) || null;
    if (!target) return;
    target.updateWorldMatrix(true, true);
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const inv = new THREE.Matrix4().copy(target.matrixWorld).invert();
    const origin = new THREE.Vector3();
    const hits = [];
    const topAt = (z) => {
      // ray in model-local space → world
      origin.set(0, 4, z).applyMatrix4(target.matrixWorld);
      ray.set(origin, down);
      hits.length = 0;
      ray.intersectObject(target, true, hits);
      for (const h of hits) {
        const m = h.object.material;
        if (m && (m.transparent || m.blending === THREE.AdditiveBlending)) continue; // glass, glows
        return h.point.clone().applyMatrix4(inv).y;
      }
      return null;
    };
    let front = null;
    for (let z = 3; z > 1; z -= 0.02) {
      if (topAt(z) != null) { front = z; break; }
    }
    // Walk back from the front axle until the surface climbs steeply (windshield / A-pillar).
    let zw = null, prevY = null;
    for (let z = 1.6; z > -0.6; z -= 0.04) {
      const y = topAt(z);
      if (y == null) continue;
      if (prevY != null && (y - prevY) / 0.04 > 0.55) { zw = z + 0.04; break; }
      prevY = y;
    }
    const C = this.cockpit;
    if (zw != null) {
      // Lens 0.2 m above the hood, just ahead of the windshield base.
      const zc = zw + 0.32;
      const hy = topAt(zc) ?? 0.9;
      const camY = hy + HOOD_LENS_HEIGHT;
      // Hood silhouette: the highest ray (in the car's vertical mid-plane) that still hits the body.
      const dir = new THREE.Vector3();
      const rot = new THREE.Matrix4().extractRotation(target.matrixWorld);
      origin.set(0, camY, zc).applyMatrix4(target.matrixWorld);
      ray.far = 4;
      let sil = null;
      for (let a = -2; a >= -60; a -= 0.25) {
        const t = (a * Math.PI) / 180;
        dir.set(0, Math.sin(t), Math.cos(t)).applyMatrix4(rot);
        ray.set(origin, dir);
        hits.length = 0;
        ray.intersectObject(target, true, hits);
        if (hits.some((h) => !(h.object.material && (h.object.material.transparent || h.object.material.blending === THREE.AdditiveBlending)))) { sil = -t; break; }
      }
      ray.far = Infinity;
      // Tilt the view down so that silhouette sits HOOD_FRAC up from the bottom of the frame at the
      // FOV of a typical racing speed: tan(γ) = (1 − 2f)·tan(fov/2), look-down β = silhouette − γ.
      const H = COCKPIT.hood;
      const fovRef = lerp(H.fov, H.fovMax, 0.45);
      const gamma = Math.atan((1 - 2 * HOOD_FRAC) * Math.tan((fovRef * Math.PI) / 360));
      const beta = sil != null ? clamp(sil - gamma, -0.02, 0.12) : 0.03;
      C.hood = { ...H, z: zc, y: camY, lookY: camY - Math.tan(beta) * 30 };
      this.hoodSilhouette = sil;
    }
    if (front != null) C.bumper = { ...COCKPIT.bumper, z: front + 0.06 };
    this.calibration = { front, windshield: zw };
  }

  cycle() {
    this.modeIndex = (this.modeIndex + 1) % CAMERA_MODES.length;
    const cfg = CHASE[this.mode];
    if (cfg) { this.dist = cfg.dist; this.height = cfg.height; }
    return this.mode;
  }

  setMode(name) {
    const i = CAMERA_MODES.indexOf(name);
    if (i >= 0) this.modeIndex = i;
  }

  /** Switch to a scripted shot. 'intro' calls onEnd when finished. */
  setScript(name, { duration, onEnd, blend = 0 } = {}) {
    this.script = name;
    this.scriptT = 0;
    if (duration) this.scriptDuration = duration;
    this.onScriptEnd = onEnd || null;
    // Optional eased blend from the current camera pose into the new shot (no hard cut).
    this.blendTime = blend;
    this._fromPos.copy(this._pos);
    this._fromLook.copy(this._look);
    this._fromFov = this.fov;
    this._fromPending = blend > 0; // converted to car-local space on the next update
  }

  // World → car-local (inverse of _local) so a blend source pose travels with a moving car.
  _toLocal(car, v) {
    const h = car.renderHeading;
    const s = Math.sin(h), c = Math.cos(h);
    const dx = v.x - car.renderPos.x, dz = v.z - car.renderPos.z;
    return v.set(dx * c - dz * s, v.y - car.renderPos.y, dx * s + dz * c);
  }

  addTrauma(x) {
    this.trauma = Math.min(1, this.trauma + x);
  }

  /** Re-initialise chase smoothing directly behind `car` (no swing-in). */
  snap(car) {
    const cfg = CHASE[this.mode] || CHASE['chase-far'];
    this.yaw = car.renderHeading;
    this.dist = cfg.dist;
    this.height = cfg.height;
    this.accel = 0;
    this._prevSpeed = car.physics.speed;
    this._hasPrev = false;
  }

  // Car-local (x, y, z) → world, using heading h about +Y.
  _local(car, h, x, y, z, out) {
    const s = Math.sin(h), c = Math.cos(h);
    const p = car.renderPos;
    return out.set(p.x + x * c + z * s, p.y + y, p.z - x * s + z * c);
  }

  update(dt, car) {
    if (!car) return;
    this.time += dt;
    this.scriptT += dt;
    const cam = this.camera;
    const ph = car.physics;
    const kmh = ph.speedKmh || 0;
    let fovTarget = 62;
    let fovLambda = 3;
    let shakeScale = 1;
    let roll = 0;
    this._camUp.set(0, 1, 0);

    // Track yaw continuously (used when leaving scripted shots).
    if (this.script === 'orbit') {
      this._orbit(car);
      fovTarget = this._shotFov;
      fovLambda = 50;
      shakeScale = 0;
      this.yaw = car.renderHeading;
    } else if (this.script === 'intro') {
      const t = clamp(this.scriptT / this.scriptDuration, 0, 1);
      fovTarget = this._intro(car, t);
      fovLambda = 60;
      shakeScale = 0.3;
      if (t >= 1) {
        this.script = 'chase';
        this.snap(car);
        const cb = this.onScriptEnd;
        this.onScriptEnd = null;
        if (cb) cb();
      }
    } else if (this.script === 'finish') {
      this.yaw = dampAngle(this.yaw, car.renderHeading, 3, dt);
      const a = Math.PI * 0.82 + this.scriptT * 0.22;
      const r = 7.4 + Math.sin(this.scriptT * 0.3) * 0.8;
      this._local(car, this.yaw, Math.sin(a) * r, 1.35 + Math.sin(this.scriptT * 0.21) * 0.35, Math.cos(a) * r, this._pos);
      this._local(car, this.yaw, 0, 0.6, 0.6, this._look);
      fovTarget = 50;
      shakeScale = 0.2;
    } else {
      const mode = this.mode;
      if (CHASE[mode]) {
        const r = this._chase(dt, car, CHASE[mode]);
        fovTarget = r;
        roll = this.roll;
      } else {
        const cfg = this.cockpit[mode] || COCKPIT[mode];
        fovTarget = this._cockpit(car, cfg);
        shakeScale = cfg.shake ?? 1;
      }
    }

    // Blend in from the previous shot's pose (kept in car-local space so it moves with the car).
    if (this._fromPending) {
      this._toLocal(car, this._fromPos);
      this._toLocal(car, this._fromLook);
      this._fromPending = false;
    }
    if (this.blendTime > 0 && this.scriptT < this.blendTime) {
      const e = easeInOutCubic(this.scriptT / this.blendTime);
      const fp = this._local(car, car.renderHeading, this._fromPos.x, this._fromPos.y, this._fromPos.z, this._tmp);
      this._pos.lerpVectors(fp, this._pos, e);
      const fl = this._local(car, car.renderHeading, this._fromLook.x, this._fromLook.y, this._fromLook.z, this._tmp2);
      this._look.lerpVectors(fl, this._look, e);
      fovTarget = lerp(this._fromFov, fovTarget, e);
      fovLambda = 60;
    }

    // --- FOV: speed widening + nitro kick ---
    this.nitroKick = damp(this.nitroKick, ph.nitroActive && this.script === 'chase' ? 1 : 0, ph.nitroActive ? 4 : 2, dt);
    this.fov = damp(this.fov, fovTarget + this.nitroKick * 6, fovLambda, dt);

    // --- Shake: road buzz at very high speed + impact trauma ---
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const tr = this.trauma * this.trauma;
    const buzz = smoothstep(235, 330, kmh) * 0.022 + (ph.nitroActive ? 0.006 : 0);
    const t = this.time;
    const ampPos = (buzz + tr * 0.28) * shakeScale;
    if (ampPos > 1e-5) {
      // Camera basis from the look direction (good enough for an offset).
      this._f.subVectors(this._look, this._pos).normalize();
      this._right.crossVectors(this._f, UP).normalize();
      this._up.crossVectors(this._right, this._f);
      const fb = 23, ft = 11;
      const sx = wobble(t * fb, 1.3) * buzz + wobble(t * ft, 4.1) * tr * 0.28;
      const sy = wobble(t * fb * 1.13, 7.7) * buzz + wobble(t * ft * 1.21, 2.2) * tr * 0.28;
      this._pos.addScaledVector(this._right, sx * shakeScale).addScaledVector(this._up, sy * shakeScale);
      this._look.addScaledVector(this._right, sx * 0.5 * shakeScale).addScaledVector(this._up, sy * 0.5 * shakeScale);
      roll += wobble(t * ft * 0.9, 9.1) * tr * 0.035 * shakeScale;
    }

    // Never below the road surface.
    if (this._pos.y < 0.3) this._pos.y = 0.3;

    cam.position.copy(this._pos);
    cam.up.copy(this._camUp);
    cam.lookAt(this._look);
    if (roll !== 0) cam.rotateZ(roll);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }

    // Camera velocity for rain streak stretching; zero on cuts/teleports.
    if (this._hasPrev && dt > 0) {
      this.velocity.subVectors(cam.position, this._prevPos).divideScalar(dt);
      if (this.velocity.lengthSq() > 160 * 160) this.velocity.set(0, 0, 0);
    } else this.velocity.set(0, 0, 0);
    this._prevPos.copy(cam.position);
    this._hasPrev = true;
  }

  _chase(dt, car, cfg) {
    const ph = car.physics;
    const P = car.renderPos;
    const h = car.renderHeading;
    const v = ph.velocity;
    const spd = Math.hypot(v.x, v.z);
    const kmh = ph.speedKmh || 0;

    // Trail direction: blend heading toward the velocity direction so drifts swing the car
    // out sideways in frame (only moving forward; reversing keeps the camera behind).
    let targetYaw = h;
    if (ph.speed > 2.5) {
      const slip = wrapAngle(Math.atan2(v.x, v.z) - h);
      targetYaw = h + clamp(slip, -1.2, 1.2) * 0.6 * smoothstep(2.5, 12, spd);
    }
    this.yaw = dampAngle(this.yaw, targetYaw, 6.5, dt);

    // Longitudinal acceleration lag: accelerating pulls the camera back, braking pushes it in.
    const acc = dt > 0 ? (ph.speed - this._prevSpeed) / dt : 0;
    this._prevSpeed = ph.speed;
    this.accel = damp(this.accel, clamp(acc, -35, 35), 3.5, dt);
    const sp = smoothstep(0, 300, kmh);
    // Partial dolly-zoom: as the FOV widens with speed the camera creeps in, so the car keeps
    // most of its on-screen size while the world stretches past (the classic racing-game trick).
    const zoomK = Math.tan((cfg.fov * Math.PI) / 360) / Math.tan((this.fov * Math.PI) / 360);
    const dolly = lerp(1, zoomK, 0.62);
    const distT = cfg.dist * dolly + 0.45 * sp + clamp(this.accel * 0.04, -0.45, 0.5);
    this.dist = damp(this.dist, distT, 4.5, dt);
    this.height = damp(this.height, cfg.height * lerp(1, zoomK, 0.45), 3.5, dt);

    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    this._pos.set(P.x - s * this.dist, P.y + this.height, P.z - c * this.dist);
    const ahead = cfg.lookAhead + 2.5 * sp;
    this._look.set(P.x + s * ahead, P.y + cfg.lookH - 0.12 * sp, P.z + c * ahead);

    // Keep the camera out of buildings when the car hugs a barrier.
    const tr = this.track;
    if (tr && tr.project) {
      const pr = tr.project(this._pos, this._camS, this._proj);
      this._camS = pr.s;
      const lim = tr.wallOffset + 1.6;
      if (Math.abs(pr.lateral) > lim) {
        tr.getRightAt(pr.s, this._r);
        this._pos.addScaledVector(this._r, (Math.sign(pr.lateral) * lim - pr.lateral));
      }
    }

    // Gentle bank into corners (lateral acceleration ≈ yawRate·speed).
    const lat = (ph.yawRate || 0) * spd;
    this.roll = damp(this.roll, clamp(lat * 0.0016, -0.035, 0.035), 3, dt);
    return lerp(cfg.fov, cfg.fovMax, Math.pow(smoothstep(0, 310, kmh), 1.15));
  }

  _cockpit(car, cfg) {
    const ph = car.physics;
    const h = car.renderHeading;
    // Rigid mount: body-local offsets rotated by the visual body pitch / roll about the body pivot
    // (same Euler order as the model: v' = Rx(pitch) · Rz(roll) · v), then placed with the heading.
    const p = ph.pitch || 0, r = ph.roll || 0;
    const B = this._bodyRot;
    B.cp = Math.cos(p); B.sp = Math.sin(p); B.cr = Math.cos(r); B.sr = Math.sin(r);
    this._bodyPoint(car, h, cfg.x, cfg.y, cfg.z, this._pos);
    this._bodyPoint(car, h, cfg.x, cfg.lookY, cfg.z + 30, this._look);
    // Body "up" in world space (the horizon tilts with the car, the hood stays put in frame).
    const ux = -B.sr, uy = B.cr * B.cp, uz = B.cr * B.sp;
    const sh = Math.sin(h), ch = Math.cos(h);
    this._camUp.set(ux * ch + uz * sh, uy, -ux * sh + uz * ch);
    this.roll = 0;
    this.yaw = h;
    const kmh = ph.speedKmh || 0;
    return lerp(cfg.fov, cfg.fovMax, Math.pow(smoothstep(0, 310, kmh), 1.15));
  }

  // Body-local point (car-local coords at rest) → world, through the current body pitch / roll.
  _bodyPoint(car, h, x, y, z, out) {
    const { cp, sp, cr, sr } = this._bodyRot;
    y -= BODY_PIVOT_Y;
    const x1 = x * cr - y * sr, y1 = x * sr + y * cr; // roll about Z
    const y2 = y1 * cp - z * sp, z2 = y1 * sp + z * cp; // pitch about X
    return this._local(car, h, x1, y2 + BODY_PIVOT_Y, z2, out);
  }

  _orbit(car) {
    const t = this.scriptT;
    const n = Math.floor(t / SHOT_LEN);
    const shot = SHOTS[n % SHOTS.length];
    const u = (t - n * SHOT_LEN) / SHOT_LEN;
    const h = car.renderHeading;
    this._shotFov = shot.fov;
    if (shot.kind === 'orbit') {
      const a = 2.2 + u * 1.25;
      const r = 6.8 - u * 0.9;
      this._local(car, h, Math.sin(a) * r, 1.05 + Math.sin(u * Math.PI) * 0.35, Math.cos(a) * r, this._pos);
      this._local(car, h, 0, 0.55, 0, this._look);
    } else {
      const e = easeInOutCubic(u) * 0.7 + u * 0.3;
      const f = shot.from, to = shot.to, lf = shot.lookFrom, lt = shot.lookTo;
      this._local(car, h, lerp(f[0], to[0], e), lerp(f[1], to[1], e), lerp(f[2], to[2], e), this._pos);
      this._local(car, h, lerp(lf[0], lt[0], e), lerp(lf[1], lt[1], e), lerp(lf[2], lt[2], e), this._look);
    }
  }

  // Sweep from in front of the car, around its left flank, to the chase position.
  _intro(car, t) {
    const cfg = CHASE[this.mode] || CHASE['chase-far'];
    const e = easeInOutCubic(t);
    const h = car.renderHeading;
    const a = e * Math.PI;
    const r = lerp(6.0, cfg.dist, e);
    const y = lerp(0.55, cfg.height, e) + Math.sin(e * Math.PI) * 0.55;
    this._local(car, h, Math.sin(a) * r, y, Math.cos(a) * r, this._pos);
    this._local(car, h, 0, lerp(0.55, cfg.lookH, e), lerp(0, cfg.lookAhead, e), this._look);
    this.yaw = h;
    this.dist = r;
    this.height = cfg.height;
    return lerp(42, cfg.fov, e);
  }
}
