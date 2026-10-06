// MIDNIGHT APEX — vehicle dynamics.
//
// Single-track ("bicycle") model integrated in world space at the CG:
//   * body-frame velocities: vx forward, vy LEFT (ISO frame), yaw rate r (+ = heading increasing = turning left)
//   * front / rear lateral tire forces from slip angles through a simplified Pacejka magic formula
//   * longitudinal weight transfer (from smoothed acceleration) + aero downforce (∝ v²) set the axle loads
//   * combined slip via a friction ellipse per axle: wheelspin / braking eats lateral grip → power oversteer
//   * handbrake blends the rear axle into a locked-wheel sliding-friction model → drift initiation
//   * arcade-sim assists: speed-sensitive steering, counter-steer (front wheels follow the velocity), slip-angle
//     restoring / damping torque, drift speed retention and throttle-sustained drift
//   * below ~3 m/s the state is blended into a kinematic model (no jitter, no creep, tight low-speed turns)
// Public conventions follow CONTRACTS.md (steer + = right, steerAngle + = right, slipAngle + = velocity to the
// car's right, lateral offsets + = right).
import * as THREE from 'three';
import { CONFIG, clamp, lerp, damp } from '../config.js';

const G = CONFIG?.physics?.gravity ?? 9.81;
const RHO = 1.225; // air density kg/m³
const DEG = Math.PI / 180;
const RPM_PER_RADS = 60 / (Math.PI * 2);

const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const approach = (cur, target, maxDelta) => (cur < target ? Math.min(cur + maxDelta, target) : Math.max(cur - maxDelta, target));
// Smooth sign: linear inside ±w so resistive forces fade to zero at standstill instead of chattering.
const ssign = (v, w) => clamp(v / w, -1, 1);
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

// Simplified Pacejka magic formula, normalised to a peak of ~1 (caller scales by μ·Fz). Odd in alpha.
function magic(alpha, B, C, E) {
  const x = B * alpha;
  return Math.sin(C * Math.atan(x - E * (x - Math.atan(x))));
}

export const DEFAULT_SPEC = {
  // chassis
  mass: 1450,
  inertia: 2500, // yaw inertia kg·m²
  wheelBase: CONFIG.car.wheelBase,
  frontWeight: 0.45, // static fraction of weight on the front axle
  cgHeight: 0.44,
  wheelRadius: CONFIG.car.wheelRadius,

  // tires — lateral μ, longitudinal μ, magic-formula shape (peak ≈ 7–8° slip, gentle fall-off for drifting)
  muLat: 1.5, // arcade-sim grip: ~1.5 g steady cornering (+ downforce at speed)
  muLong: 1.25,
  frontGrip: 1.0,
  rearGrip: 1.1, // rear has more grip than the front → stable, front-first saturation (mild understeer at the limit)
  lockedMu: 0.78, // sliding friction factor of a locked (handbrake) rear axle
  // Rear is stiffer per unit load than the front (understeer gradient → stable at 250 km/h) and keeps ~94 % of
  // its peak when sliding (long, controllable drifts); the front peaks at ~9° and fades to ~0.85 when overdriven.
  Bf: 13, Cf: 1.4, Ef: 0,
  Br: 17, Cr: 1.25, Er: -0.8,

  // aero / resistance
  cdA: 0.78, // drag area (includes wing drag)
  clA: 1.05, // downforce area
  downForceFront: 0.45,
  crr: 0.012,

  // engine / drivetrain (RWD)
  idleRpm: 900,
  maxRpm: 8000,
  upshiftRpm: 7600,
  partUpshiftRpm: 4300,
  kickdownRpm: 6300,
  brakeDownRpm: 5600,
  coastDownRpm: 3000,
  launchRpm: 4200,
  // [rpm, N·m] — peak ~650 N·m mid-range
  torqueCurve: [[0, 320], [900, 380], [2000, 470], [3000, 565], [4000, 632], [4800, 650], [6000, 650], [7000, 642], [7600, 626], [8000, 598], [9000, 460]],
  gearRatios: [2.78, 2.05, 1.6, 1.3, 1.1, 0.92],
  finalDrive: 3.42,
  reverseRatio: 3.2,
  driveEff: 0.9,
  topSpeed: 308, // km/h — soft ECU governor (the car would otherwise pull to the 6th-gear limiter)
  topSpeedNitro: 345, // nitro overrides the governor; the 6th-gear rev limiter then caps it at ~336 km/h
  upshiftTime: 0.15,
  downshiftTime: 0.09,
  minShiftInterval: 0.32,
  limiterCut: 0.055,
  engineBrakeTorque: 85,
  tcsSlipLow: 0.32, // traction control: allowed excess over the combined-slip limit at low speed (power oversteer)...
  tcsSlipHigh: 0.03, // ...and at high speed (no snap spins at 200 km/h)
  tcsSlipDrift: 0.45, // extra allowance while drifting (throttle sustains the slide)

  // brakes
  brakeForce: 23000, // N total at full pedal (ABS limits per axle)
  brakeBias: 0.62,

  // steering + assists
  maxSteerLow: 32 * DEG,
  maxSteerHigh: 4.2 * DEG,
  steerFalloffKmh: 52, // max angle = high + (low-high) / (1 + (kmh/k)²): 32° → ~10° @100 → ~5.4° @250
  steerRateLow: 10, // normalised steer units per second (core already ramps keyboard input; this mostly tames AI/gamepad)
  steerRateHigh: 5,
  counterSteer: 0.6, // front wheels turn toward the velocity by this fraction of body slip
  counterSteerDeadzone: 0.05,
  escSlip: 0.06, // grip-mode stabiliser: slip angle (rad) above which it pushes back…
  escGain: 7, // …with this yaw accel per rad of excess slip
  escDamp: 0.9, // …plus damping of slip-angle growth (1/s)
  maxSlip: 0.7, // rad (~40°) — beyond this a restoring yaw torque fades in
  slipRestore: 7.0,
  slipDamp: 4.0, // damping of body-slip rate while drifting (1/s) — smooth, steady held angles
  driftThrottleRelief: 0.2, // rear grip reduction while drifting on throttle (sustains the slide)
  driftAngleGain: 5.0, // drift-angle controller: yaw accel (rad/s²) per rad of slip-angle error
  driftAngleMin: 0.14, // held slip angle with throttle but neutral-ish steer (rad, ~8°)…
  driftAngleRange: 0.52, // …plus this much at full steer into the drift (→ ~38°)
  driftSpeedRetain: 0.5, // fraction of drift scrub given back while on throttle
  maxYawRate: 5,

  // nitro
  nitroBoost: 0.45, // +45 % drive force
  nitroPush: 1.2, // m/s² extra push (not traction limited)
  nitroDuration: 5, // seconds for a full tank
  nitroRefill: 1 / 90, // tank per second, passive
  nitroDriftRefill: 0.1, // tank per second at drift = 1

  reverseMaxSpeed: 12.5, // m/s (45 km/h)

  // visual body motion
  pitchPerG: 2.2 * DEG,
  rollPerG: 2.6 * DEG,
  bodyFreq: 9,
  bodyDamp: 0.5,
  maxBodyAngle: 4.2 * DEG,
};

export class VehiclePhysics {
  constructor(spec = {}) {
    const S = (this.spec = { ...DEFAULT_SPEC, ...(spec || {}) });
    this.mass = S.mass;
    this.inertia = S.inertia;
    this.halfLength = CONFIG.car.collisionHalfLength;
    this.halfWidth = CONFIG.car.collisionHalfWidth;
    this.maxRpm = S.maxRpm;
    this.idleRpm = S.idleRpm;
    this.gearCount = S.gearRatios.length;

    // CG geometry: a = CG→front axle, b = CG→rear axle. The public `position` is the contract origin (midway
    // between the axles); the CG sits (b - a)/2 along +forward from it (i.e. slightly behind for a 45/55 car).
    this._a = S.wheelBase * (1 - S.frontWeight);
    this._b = S.wheelBase * S.frontWeight;
    this._cgOff = (this._b - this._a) / 2;
    // Effective mass of an axle for a lateral force (translation + yaw), used to clamp tire forces at crawl speed.
    this._mEffF = 1 / (1 / S.mass + (this._a * this._a) / S.inertia);
    this._mEffR = 1 / (1 / S.mass + (this._b * this._b) / S.inertia);

    // Tunables other systems may modulate (AI rubber-banding, surfaces...).
    this.powerScale = 1;
    this.gripScale = 1;
    this.dragScale = 1; // aero drag multiplier (core lowers it in another car's slipstream)

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.skid = { fl: 0, fr: 0, rl: 0, rr: 0 };
    this.nitro = 1;
    this.shiftCount = 0;
    this.lastShiftUp = true;
    this.backfireCount = 0;
    this.wheelSpinFront = 0;
    this.wheelSpinRear = 0;
    this._clearDynamics();
  }

  _clearDynamics() {
    const S = this.spec;
    this.heading = this.heading || 0;
    this.velocity.set(0, 0, 0);
    this.yawRate = 0;
    this.speed = 0;
    this.speedKmh = 0;
    this.rpm = S.idleRpm;
    this.gear = 1;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = 0;
    this.steerAngle = 0;
    this.slipAngle = 0;
    this.drift = 0;
    this.skid.fl = this.skid.fr = this.skid.rl = this.skid.rr = 0;
    this.nitroActive = false;
    this.nitroLevel = 0; // smoothed 0..1 nitro intensity (visual helper)
    this.pitch = 0;
    this.roll = 0;
    this.wheelspin = 0;
    this.reversing = false;
    this.shifting = false;
    this.onLimiter = false;
    this.load = 0;
    this.gLong = 0; // + = accelerating (g)
    this.gLat = 0; // + = accelerating toward the car's right, i.e. turning right (g)
    this.frontSlip = 0;
    this.rearSlip = 0;

    this._steer = 0;
    this._hb = 0;
    this._axS = 0;
    this._pitchV = 0;
    this._rollV = 0;
    this._wRear = 0;
    this._shiftTimer = 0;
    this._sinceShift = 1;
    this._limiterTimer = 0;
    this._revTimer = 0;
    this._betaPrev = 0;
    this._betaRate = 0;
    this._thrPrev = 0;
    this._driftLatch = false;
  }

  /** Place the car at rest. `opts.nitro` optionally sets the tank. */
  reset(position, heading = 0, opts = {}) {
    if (position) this.position.set(num(position.x), 0, num(position.z));
    this.heading = num(heading);
    this._clearDynamics();
    this.heading = num(heading);
    if (opts && opts.nitro != null) this.nitro = clamp(num(opts.nitro, 1), 0, 1);
  }

  addNitro(amount) {
    this.nitro = clamp(this.nitro + num(amount), 0, 1);
  }

  /** World-space impulse (N·s) at a world point: changes linear velocity and yaw rate (r × J about +Y). */
  applyImpulse(impulse, point) {
    if (!impulse) return;
    let jx = num(impulse.x), jz = num(impulse.z);
    // Robustness: cap the velocity change of a single impulse.
    const dv = Math.hypot(jx, jz) / this.mass;
    if (dv > 40) {
      const k = 40 / dv;
      jx *= k;
      jz *= k;
    }
    this.velocity.x += jx / this.mass;
    this.velocity.z += jz / this.mass;
    this.velocity.y = 0;
    if (point) {
      const sh = Math.sin(this.heading), ch = Math.cos(this.heading);
      const rx = num(point.x, this.position.x) - (this.position.x + sh * this._cgOff);
      const rz = num(point.z, this.position.z) - (this.position.z + ch * this._cgOff);
      const torque = rz * jx - rx * jz; // (r × J).y — + rotates toward increasing heading
      const dr = clamp(torque / this.inertia, -4, 4);
      this.yawRate = clamp(this.yawRate + dr, -this.spec.maxYawRate, this.spec.maxYawRate);
    }
  }

  /** Pick the natural gear for the current speed (e.g. after teleporting / setting velocity directly). */
  syncGear() {
    const S = this.spec;
    const sh = Math.sin(this.heading), ch = Math.cos(this.heading);
    const vx = this.velocity.x * sh + this.velocity.z * ch;
    if (vx < 0.5) return;
    let g = 1;
    while (g < this.gearCount && (vx / S.wheelRadius) * this._ratio(g) * RPM_PER_RADS > S.upshiftRpm - 800) g++;
    this.gear = g;
    this._wRear = vx / S.wheelRadius;
    this.rpm = Math.max(S.idleRpm, this._wRear * this._ratio(g) * RPM_PER_RADS);
  }

  /** Max front-wheel angle (rad) at a forward speed (m/s). */
  maxSteerAt(speed) {
    const S = this.spec;
    const k = (Math.abs(speed) * 3.6) / S.steerFalloffKmh;
    return S.maxSteerHigh + (S.maxSteerLow - S.maxSteerHigh) / (1 + k * k);
  }

  _torqueAt(rpm) {
    const c = this.spec.torqueCurve;
    if (rpm <= c[0][0]) return c[0][1];
    for (let i = 1; i < c.length; i++) {
      if (rpm <= c[i][0]) {
        const t = (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
        return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t;
      }
    }
    return c[c.length - 1][1];
  }

  _ratio(gear = this.gear) {
    const S = this.spec;
    if (gear < 0) return S.reverseRatio * S.finalDrive;
    return S.gearRatios[clamp(gear, 1, this.gearCount) - 1] * S.finalDrive;
  }

  _setGear(g, up) {
    if (g === this.gear) return;
    const S = this.spec;
    const isUp = up ?? g > this.gear;
    this.gear = g;
    this.shiftCount++;
    this.lastShiftUp = isUp;
    this._sinceShift = 0;
    this._shiftTimer = g > 0 && this.speedKmh > 3 ? (isUp ? S.upshiftTime : S.downshiftTime) : 0;
  }

  /** Approximate max straight-line acceleration (m/s²) at speed v — used by the AI speed planner. */
  estimateAccel(v, nitro = false) {
    const S = this.spec;
    v = Math.max(0.5, v);
    let best = 0;
    for (let g = 1; g <= this.gearCount; g++) {
      const ratio = this._ratio(g);
      const rpm = Math.max((v / S.wheelRadius) * ratio * RPM_PER_RADS, S.launchRpm);
      if (rpm > S.maxRpm) continue;
      const f = (this._torqueAt(rpm) * ratio * S.driveEff) / S.wheelRadius;
      if (f > best) best = f;
    }
    if (nitro) best *= 1 + S.nitroBoost;
    const fzR = this.mass * G * (1 - S.frontWeight) + 0.5 * RHO * S.clA * v * v * (1 - S.downForceFront) + 0.15 * this.mass * G;
    best = Math.min(best, S.muLong * fzR * this.gripScale) * this.powerScale;
    const vGov = (nitro ? S.topSpeedNitro : S.topSpeed) / 3.6;
    best *= 1 - smoothstep(vGov - 2, vGov + 0.3, v);
    const drag = 0.5 * RHO * S.cdA * v * v + S.crr * this.mass * G;
    return (best - drag) / this.mass + (nitro ? S.nitroPush : 0);
  }

  step(dt, controls = {}) {
    dt = num(dt);
    if (!(dt > 0)) return;
    dt = Math.min(dt, 1 / 20);
    const S = this.spec;
    const c = controls || {};
    const m = this.mass, I = this.inertia, L = S.wheelBase, a = this._a, b = this._b, R = S.wheelRadius;

    const inThr = clamp(num(c.throttle), 0, 1);
    const inBrk = clamp(num(c.brake), 0, 1);
    const inSteer = clamp(num(c.steer), -1, 1);
    const hbIn = c.handbrake ? 1 : 0;

    // ---- kinematic state in the body frame -------------------------------------------------------------
    const h0 = this.heading;
    const sh = Math.sin(h0), ch = Math.cos(h0);
    const cgx = this.position.x + sh * this._cgOff;
    const cgz = this.position.z + ch * this._cgOff;
    const V = this.velocity;
    let vx = V.x * sh + V.z * ch; // forward
    let vy = V.x * ch - V.z * sh; // left
    let r = this.yawRate;
    const spd = Math.hypot(vx, vy);

    // ---- gear direction: NFS-style reverse by holding brake at a standstill -------------------------------
    if (this.gear > 0) {
      if (inBrk > 0.3 && inThr < 0.05 && vx < 0.6 && !c.hold && !hbIn) {
        this._revTimer += dt;
        if (this._revTimer > 0.22 && vx < 0.25) this._setGear(-1, false);
      } else this._revTimer = 0;
    } else if ((inThr > 0.05 && vx > -0.6) || vx > 3) {
      this._setGear(1, true);
    }
    const reverse = this.gear < 0;
    const thrIn = reverse ? inBrk : inThr;
    const brkIn = reverse ? inThr : inBrk;

    // pedal smoothing (fast — feels direct but avoids force steps)
    this.throttle = approach(this.throttle, thrIn, dt * (thrIn > this.throttle ? 7 : 12));
    this.brake = approach(this.brake, brkIn, dt * 9);
    // NFS-style "brake to drift": throttle and brake held together at speed while steering acts like a
    // light handbrake (clutch-kick feel) — a deliberate drift trigger that plain trail-braking never fires.
    const powerBrake = !reverse && inThr > 0.5 && inBrk > 0.5 && Math.abs(inSteer) > 0.3 && vx > 14 ? 0.75 : 0;
    this._hb = approach(this._hb, Math.max(hbIn, powerBrake), dt * 10);
    this.handbrake = this._hb;

    // ---- nitro ----------------------------------------------------------------------------------------------
    this.nitroActive = !!c.nitro && this.nitro > 0.002 && !reverse && this.throttle > 0.3 && vx > 1;
    if (this.nitroActive) this.nitro = Math.max(0, this.nitro - dt / S.nitroDuration);
    this.nitroLevel = approach(this.nitroLevel, this.nitroActive ? 1 : 0, dt * 6);

    // ---- steering ---------------------------------------------------------------------------------------------
    const maxSteer = this.maxSteerAt(vx);
    const rate = lerp(S.steerRateLow, S.steerRateHigh, smoothstep(0, 60, Math.abs(vx)));
    this._steer = approach(this._steer, inSteer, rate * dt);
    // Body slip (left-positive): angle of the velocity relative to the nose.
    const beta = vx > 1 ? Math.atan2(vy, vx) : 0;
    const absBeta = Math.abs(beta);
    // Counter-steer assist: front wheels follow the velocity vector once the car slides.
    const csBeta = Math.sign(beta) * Math.max(0, absBeta - S.counterSteerDeadzone);
    let dStd = -this._steer * maxSteer + S.counterSteer * smoothstep(4, 12, vx) * csBeta; // left-positive
    dStd = clamp(dStd, -S.maxSteerLow, S.maxSteerLow);
    this.steerAngle = -dStd;

    // Drift latch: the slide-sustaining assists only engage after a real drift initiation (big slip angle or
    // handbrake), so ordinary limit cornering stays planted.
    if (vx < 5 || absBeta < 0.06) this._driftLatch = false;
    else if (absBeta > 0.24 || (this._hb > 0.5 && absBeta > 0.08)) this._driftLatch = true;
    const driftAmt = this._driftLatch ? smoothstep(0.08, 0.3, absBeta) * smoothstep(6, 14, vx) : 0;
    // NFS-style drift control: throttle + steering INTO the slide holds the angle; neutral/counter steer recovers.
    // beta > 0 → nose points right of the velocity (right-hand drift) → "into" = steer right (+).
    const steerInto = clamp(inSteer * Math.sign(beta), 0, 1);
    const sustain = reverse ? 0 : this.throttle * (0.3 + 0.7 * steerInto);

    // ---- axle loads: static + longitudinal transfer + downforce ---------------------------------------------
    const v2 = vx * vx + vy * vy;
    const down = 0.5 * RHO * S.clA * v2;
    const transfer = (m * this._axS * S.cgHeight) / L;
    const Fzf = Math.max(0.15 * m * G, m * G * S.frontWeight + down * S.downForceFront - transfer);
    const Fzr = Math.max(0.15 * m * G, m * G * (1 - S.frontWeight) + down * (1 - S.downForceFront) + transfer);

    // ---- tire kinematics --------------------------------------------------------------------------------------
    const grip = this.gripScale;
    const cd = Math.cos(dStd), sd = Math.sin(dStd);
    const vyF = vy + a * r; // lateral velocity at the front axle
    const vyR = vy - b * r; // ... and at the rear axle
    const vfL = vx * cd + vyF * sd; // front wheel frame: rolling direction
    const vfT = -vx * sd + vyF * cd; // front wheel frame: lateral
    const alphaF = Math.atan2(vfT, Math.max(Math.abs(vfL), 1));
    const alphaR = Math.atan2(vyR, Math.max(Math.abs(vx), 1));
    this.frontSlip = alphaF;
    this.rearSlip = alphaR;

    const muF = S.muLat * S.frontGrip * grip;
    const muR = S.muLat * S.rearGrip * grip * (1 - S.driftThrottleRelief * sustain * driftAmt);
    let FyF = -muF * Fzf * magic(alphaF, S.Bf, S.Cf, S.Ef);
    let FyR = -muR * Fzr * magic(alphaR, S.Br, S.Cr, S.Er);

    // ---- drivetrain ---------------------------------------------------------------------------------------------
    const ratio = this._ratio();
    const dir = reverse ? -1 : 1;
    const rpmWheel = Math.abs(this._wRear) * ratio * RPM_PER_RADS;
    const launch = this.gear === 1 || reverse ? S.idleRpm + this.throttle * (S.launchRpm - S.idleRpm) : 0;
    const rpmEng = Math.max(S.idleRpm, rpmWheel, launch);
    this._shiftTimer -= dt;
    this._limiterTimer -= dt;
    this._sinceShift += dt;
    this.shifting = this._shiftTimer > 0;
    if (rpmEng >= S.maxRpm && this.throttle > 0.05 && this._limiterTimer <= -0.02) this._limiterTimer = S.limiterCut;
    this.onLimiter = this._limiterTimer > 0;
    const cut = this.shifting || this.onLimiter;
    const tq = cut ? 0 : this._torqueAt(rpmEng) * this.throttle;
    this.load = cut ? 0 : this.throttle;
    const boost = 1 + S.nitroBoost * this.nitroLevel;
    let Fdrive = ((tq * ratio * S.driveEff) / R) * boost * this.powerScale * (1 - 0.85 * this._hb) * dir;
    if (reverse) Fdrive *= 1 - smoothstep(S.reverseMaxSpeed * 0.7, S.reverseMaxSpeed, -vx);
    else {
      const vGov = lerp(S.topSpeed, S.topSpeedNitro, this.nitroLevel) / 3.6;
      Fdrive *= 1 - smoothstep(vGov - 2, vGov + 0.3, vx);
    }
    // engine braking opposes wheel rotation, fades out with throttle and at crawl speed (clutch opens)
    const ebT = S.engineBrakeTorque * smoothstep(S.idleRpm, S.maxRpm, rpmEng) * (1 - smoothstep(0, 0.15, this.throttle));
    const Feb = this.shifting ? 0 : -((ebT * ratio) / R) * ssign(vx, 0.5) * smoothstep(1.5, 5, Math.abs(vx));

    // ---- longitudinal tire forces ------------------------------------------------------------------------------
    const Fb = this.brake * S.brakeForce;
    let FxF = -Fb * S.brakeBias * ssign(vfL, 0.4) - S.crr * Fzf * ssign(vfL, 0.4);
    let FxR = Fdrive + Feb - Fb * (1 - S.brakeBias) * ssign(vx, 0.4) - S.crr * Fzr * ssign(vx, 0.4);

    const capXF = S.muLong * grip * Fzf;
    const capXR = S.muLong * grip * Fzr;
    const fyCapF = muF * Fzf, fyCapR = muR * Fzr;
    // ABS + EBD, lateral-aware: braking may only use what the friction ellipse leaves after cornering (keeps the
    // car steerable and stops trail-braking from snapping the rear out); the rear keeps an extra margin.
    const uyF0 = Math.min(1, Math.abs(FyF) / fyCapF);
    FxF = clamp(FxF, -capXF * Math.max(0.3, 0.97 * Math.sqrt(1 - uyF0 * uyF0) + 0.04), capXF * 0.97);
    if (FxR * vx < 0 && !this._hb) {
      const uyRb = Math.min(1, Math.abs(FyR) / fyCapR);
      const lim = capXR * Math.max(0.2, 0.85 * Math.sqrt(1 - uyRb * uyRb));
      if (Math.abs(FxR) > lim) FxR = Math.sign(FxR) * lim;
    }

    // Rear traction control, combined-slip aware: the drive force may exceed what the friction ellipse leaves
    // after cornering only by an allowance — generous at low speed (power oversteer, launch wheelspin) and while
    // drifting (throttle holds the slide), tiny at high speed (no snap spins).
    const uyR0 = Math.min(1, Math.abs(FyR) / fyCapR);
    const allowance = lerp(S.tcsSlipLow, S.tcsSlipHigh, smoothstep(5, 70, Math.abs(vx) * 3.6)) + S.tcsSlipDrift * driftAmt * sustain;
    const driveCap = capXR * (Math.sqrt(1 - uyR0 * uyR0) + allowance);
    const driving = Fdrive * dir > 0 && Math.abs(Fdrive) > Math.abs(FxR - Fdrive);
    if (driving && Math.abs(FxR) > driveCap) FxR = Math.sign(FxR) * driveCap;
    // wheelspin: how far the delivered force pushes the rear tire past its friction ellipse
    const spin = driving ? smoothstep(1.02, 1.3, Math.hypot(FxR / capXR, uyR0)) : 0;

    // friction ellipse per axle
    let ux = FxF / capXF, uy = FyF / fyCapF, mag = Math.hypot(ux, uy);
    if (mag > 1) {
      FxF /= mag;
      FyF /= mag;
    }
    ux = FxR / capXR;
    uy = FyR / fyCapR;
    mag = Math.hypot(ux, uy);
    if (mag > 1) {
      FxR /= mag;
      FyR /= mag;
    }
    FyR *= 1 - 0.3 * spin; // a spinning tire loses extra side grip

    // handbrake: blend rear axle into a locked wheel sliding opposite its contact-patch velocity
    const lock = this._hb * smoothstep(0.5, 3, spd);
    if (lock > 0) {
      const vc = Math.max(Math.hypot(vx, vyR), 0.5);
      const fs = S.muLong * S.lockedMu * grip * Fzr;
      FxR = lerp(FxR, (-fs * vx) / vc, lock);
      FyR = lerp(FyR, (-fs * vyR) / vc, lock);
    }

    // crawl-speed stabiliser: a tire can't push harder than what would cancel its lateral slip in one step
    const capLatF = (this._mEffF * Math.abs(vfT)) / dt * 0.5;
    const capLatR = (this._mEffR * Math.abs(vyR)) / dt * 0.5;
    FyF = clamp(FyF, -capLatF, capLatF);
    FyR = clamp(FyR, -capLatR, capLatR);

    // ---- body forces & yaw moment ------------------------------------------------------------------------------
    const FfX = FxF * cd - FyF * sd;
    const FfY = FxF * sd + FyF * cd;
    let Fx = FfX + FxR;
    let Fy = FfY + FyR;
    let Mz = a * FfY - b * FyR;

    // drift speed retention: give back part of the scrub while drifting on throttle (NFS-style flow)
    if (spd > 1 && driftAmt > 0 && this.throttle > 0.1 && !reverse) {
      const along = (Fx * vx + Fy * vy) / spd;
      if (along < 0) {
        const give = -along * S.driftSpeedRetain * driftAmt * this.throttle;
        Fx += (give * vx) / spd;
        Fy += (give * vy) / spd;
      }
    }
    // aero drag
    const dragK = 0.5 * RHO * S.cdA * spd * this.dragScale;
    Fx -= dragK * vx;
    Fy -= dragK * vy;
    if (this.nitroLevel > 0) Fx += m * S.nitroPush * this.nitroLevel;

    // slip-angle stabiliser: restoring torque past maxSlip + damping of slip-angle rate while sliding
    const betaRaw = vx > 1 ? (beta - this._betaPrev) / dt : 0;
    this._betaPrev = beta;
    this._betaRate = damp(this._betaRate, clamp(betaRaw, -6, 6), 25, dt);
    const excess = absBeta > S.maxSlip ? (absBeta - S.maxSlip) * Math.sign(beta) : 0;
    Mz += I * (S.slipRestore * excess * smoothstep(3, 8, vx) + S.slipDamp * this._betaRate * driftAmt);
    // ESC-like stabiliser for grip driving: when no drift is latched (and no handbrake), gently resist body slip
    // beyond a few degrees and damp its growth — trail-braking and lift-off stay tidy; deliberate drifts bypass it.
    if (driftAmt === 0 && this._hb < 0.05 && vx > 6) {
      const ex = Math.sign(beta) * Math.max(0, absBeta - S.escSlip);
      Mz += I * (S.escGain * ex + S.escDamp * this._betaRate) * smoothstep(6, 14, vx);
    }
    // Drift-angle controller (arcade): while a drift is latched, steer the body slip toward a target set by how
    // far the driver steers INTO the slide and how much throttle is held. Neutral steer / lift → target 0 →
    // the car straightens itself; full lock + throttle → ~38° held indefinitely.
    if (driftAmt > 0) {
      const betaT = Math.sign(beta) * (S.driftAngleMin + S.driftAngleRange * steerInto) * smoothstep(0.05, 0.7, this.throttle) * (reverse ? 0 : 1);
      Mz += I * S.driftAngleGain * (beta - betaT) * driftAmt; // β > 0 needs + (nose-left) torque to shrink
    }

    // ---- integrate (world-space velocity, so no rotating-frame error) ------------------------------------------
    const ax = Fx / m, ay = Fy / m;
    vx += ax * dt;
    vy += ay * dt;
    r += (Mz / I) * dt;

    // low-speed blend into a kinematic (no-slip) model: no jitter and tight turning when crawling
    const wDyn = smoothstep(1.2, 3.5, spd);
    if (wDyn < 1) {
      const rKin = (vx * Math.tan(dStd)) / L;
      const k = (1 - wDyn) * (1 - Math.exp(-dt * 30));
      r = lerp(r, rKin, k);
      vy = lerp(vy, rKin * b, k);
    }
    // standstill: parking friction so nothing creeps
    if (this.throttle < 0.02 && Math.hypot(vx, vy) < 0.6) {
      const dec = (this.brake > 0.05 || this._hb > 0.05 ? 8 : 1.5) * dt;
      const sp = Math.hypot(vx, vy);
      const k = sp > dec ? (sp - dec) / sp : 0;
      vx *= k;
      vy *= k;
      r *= Math.exp(-dt * 12);
      if (k === 0 && Math.abs(r) < 0.01) r = 0;
    }
    r = clamp(r, -S.maxYawRate, S.maxYawRate);

    V.x = vx * sh + vy * ch;
    V.z = vx * ch - vy * sh;
    V.y = 0;
    let h1 = h0 + r * dt;
    if (h1 > 1000 || h1 < -1000) h1 = Math.atan2(Math.sin(h1), Math.cos(h1));
    const ncgx = cgx + V.x * dt, ncgz = cgz + V.z * dt;
    this.heading = h1;
    this.yawRate = r;
    this.position.set(ncgx - Math.sin(h1) * this._cgOff, 0, ncgz - Math.cos(h1) * this._cgOff);

    // ---- wheels, engine rpm, gearbox ------------------------------------------------------------------------------
    const wFree = vx / R;
    // rear wheel speed: free rolling + slip ratio under wheelspin (+ a launch flare at crawl speed)
    let wTarget = wFree * (1 + 0.25 * spin) + dir * spin * 10 * (1 - smoothstep(5, 25, Math.abs(vx)));
    wTarget = lerp(wTarget, 0, lock);
    this._wRear = damp(this._wRear, wTarget, 22, dt);
    this.wheelSpinRear += this._wRear * dt;
    this.wheelSpinFront += (vfL / R) * dt;
    this.wheelspin = spin;

    let rpmT = Math.max(S.idleRpm, Math.abs(this._wRear) * this._ratio() * RPM_PER_RADS, this.gear === 1 || reverse ? S.idleRpm + this.throttle * (S.launchRpm - S.idleRpm) : 0);
    if (this.onLimiter) rpmT = S.maxRpm - 320;
    rpmT = Math.min(rpmT, S.maxRpm + 60);
    this.rpm = damp(this.rpm, rpmT, this.shifting ? 24 : 18, dt);

    this._autoShift(vx);

    // backfire event on a sharp lift at high rpm (audio/fx hook)
    if (this._thrPrev > 0.7 && this.throttle < 0.25 && this.rpm > 4800 && !reverse) this.backfireCount++;
    this._thrPrev = this.throttle;

    // ---- nitro refill ----------------------------------------------------------------------------------------------
    if (!this.nitroActive) this.nitro = Math.min(1, this.nitro + dt * S.nitroRefill);

    // ---- outputs ----------------------------------------------------------------------------------------------------
    const spdN = Math.hypot(vx, vy);
    this.speed = vx;
    this.speedKmh = spdN * 3.6;
    this.reversing = reverse;
    this.slipAngle = spdN > 1 ? Math.atan2(-vy, Math.max(Math.abs(vx), 0.01)) : 0;
    const driftT = smoothstep(0.12, 0.45, Math.abs(this.slipAngle)) * smoothstep(8, 15, vx);
    this.drift = damp(this.drift, driftT, driftT > this.drift ? 8 : 4, dt);
    this.nitro = Math.min(1, this.nitro + dt * S.nitroDriftRefill * this.drift);
    this.gLong = ax / G;
    this.gLat = -ay / G;

    // skid / screech per wheel
    const sp = smoothstep(2, 7, spdN);
    const sF = Math.max(smoothstep(0.11, 0.24, Math.abs(alphaF)), smoothstep(0.85, 1.1, Math.abs(FxF) / capXF) * 0.4);
    const sR = Math.max(smoothstep(0.1, 0.22, Math.abs(alphaR)), spin, lock, smoothstep(0.85, 1.1, Math.abs(FxR) / capXR) * 0.4);
    const side = clamp(this.gLat * 0.5, -0.3, 0.3); // + turning right → left wheels are outside (more load/noise)
    const skF = sF * sp, skR = clamp(Math.max(sR, this.drift), 0, 1) * sp;
    this.skid.fl = clamp(skF * (1 + side), 0, 1);
    this.skid.fr = clamp(skF * (1 - side), 0, 1);
    this.skid.rl = clamp(skR * (1 + side), 0, 1);
    this.skid.rr = clamp(skR * (1 - side), 0, 1);

    // smoothed weight transfer → visual pitch / roll (damped spring: weighty, slight overshoot)
    this._axS = damp(this._axS, clamp(ax, -2 * G, 2 * G), 8, dt);
    const mb = S.maxBodyAngle;
    const pitchT = clamp((-ax / G) * S.pitchPerG, -mb, mb);
    const rollT = clamp((ay / G) * S.rollPerG, -mb, mb);
    const w = S.bodyFreq, z = S.bodyDamp;
    this._pitchV += (w * w * (pitchT - this.pitch) - 2 * z * w * this._pitchV) * dt;
    this.pitch = clamp(this.pitch + this._pitchV * dt, -mb, mb);
    this._rollV += (w * w * (rollT - this.roll) - 2 * z * w * this._rollV) * dt;
    this.roll = clamp(this.roll + this._rollV * dt, -mb, mb);

    // last-resort NaN guard
    if (!Number.isFinite(this.position.x + this.position.z + V.x + V.z + this.yawRate + this.heading)) {
      if (!Number.isFinite(this.position.x + this.position.z)) this.position.set(cgx, 0, cgz);
      if (!Number.isFinite(this.heading)) this.heading = 0;
      V.set(0, 0, 0);
      this.yawRate = 0;
      this._axS = 0;
    }
  }

  _autoShift(vx) {
    const S = this.spec;
    if (this.gear < 1) return;
    const R = S.wheelRadius;
    if (Math.abs(vx) < 2.5 && this.gear > 1) {
      this._setGear(1, false);
      return;
    }
    if (this._shiftTimer > 0 || this._sinceShift < S.minShiftInterval) return;
    const g = this.gear;
    // shift on the higher of rolling rpm and actual engine rpm (wheelspin revs the engine → auto upshifts)
    const rpmRoll = (Math.max(vx, 0) / R) * this._ratio(g) * RPM_PER_RADS;
    const rpmUp = Math.max(rpmRoll, (Math.max(this._wRear, 0) * this._ratio(g) * RPM_PER_RADS) * 0.985);
    const thr = this.throttle;
    const upRpm = thr > 0.1 ? lerp(S.partUpshiftRpm, S.upshiftRpm, smoothstep(0.25, 0.85, thr)) : S.maxRpm - 150;
    if (g < this.gearCount && rpmUp > upRpm && vx > 8) {
      this._setGear(g + 1, true);
      return;
    }
    if (g > 1) {
      const target = this.brake > 0.15 ? S.brakeDownRpm : thr > 0.6 ? S.kickdownRpm : S.coastDownRpm;
      const limit = Math.min(target, upRpm - 500, S.maxRpm - 600);
      let ng = g;
      while (ng > 1 && (rpmRoll * this._ratio(ng - 1)) / this._ratio(g) < limit) ng--;
      if (ng !== g) this._setGear(ng, false);
    }
  }
}
