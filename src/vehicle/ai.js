// MIDNIGHT APEX — AI drivers.
//
// Racing line (computed once per track, cached in a WeakMap):
//   lateral offsets w(s) (+ = right of the centerline) minimising Σ|P[i-1] - 2P[i] + P[i+1]|² (≈ ∫κ² ds, i.e. a
//   minimum-curvature, outside-inside-outside line) under |w| ≤ wallOffset - margin. Solved by projected gradient
//   descent on a coarse → fine hierarchy (16 m → 6 m → 2 m) so long wavelengths converge quickly.
// Speed plan (per driver, depends on skill): v ≤ sqrt(μ·(g + c·v²) / |κ|) with aero downforce, then a backward
//   pass (braking, friction-ellipse aware) and a forward pass (engine) around the closed loop.
// Control: pure pursuit on the (avoidance-shifted) line with speed-scaled look-ahead + yaw-rate damping;
//   throttle/brake track the speed plan with a short preview. Overtaking, side-by-side spacing, nitro on straights,
//   mild rubber-banding and stuck/wrong-way recovery on top.
// Racecraft (rivals only, not the autopilot): per-lap pace / in-lap form variation, occasional small mistakes at
//   corners (late braking + running wide, missed apex, scruffy exit), and a personality from `aggression`:
//   attackers brake later, follow closer and commit to moves earlier; defenders cover the inside of the next corner
//   when someone is lining them up. Passing / defending offsets fade out wherever the line sweeps across the road,
//   off-line cars slow for the tighter path, and a predictive wall guard catches exit drift, so all of it costs
//   time but keeps cars off the barriers. Mistakes and pace draw from a per-driver seeded PRNG (reproducible).
import * as THREE from 'three';
import { CONFIG, clamp, lerp, damp, wrapAngle } from '../config.js';

const G = CONFIG?.physics?.gravity ?? 9.81;
const LINE_MARGIN = 1.6; // racing line keeps the car centre this far inside the barrier face
const LINE_CACHE = new WeakMap();

const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// signed arc-length difference wrapped to [-L/2, L/2)
const wrapS = (d, L) => d - Math.round(d / L) * L;

function mulberry32(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Racing line
// ---------------------------------------------------------------------------------------------------------------

/** Projected-gradient minimum-curvature smoothing of offsets w on a closed loop. */
function relaxMinCurvature(cx, cz, nx, nz, w, limit, iters) {
  const N = w.length;
  const px = new Float64Array(N), pz = new Float64Array(N);
  const dx = new Float64Array(N), dz = new Float64Array(N);
  const eta = 0.055; // < 2 / λmax(Δ⁴) = 1/8 → stable
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < N; i++) {
      px[i] = cx[i] + nx[i] * w[i];
      pz[i] = cz[i] + nz[i] * w[i];
    }
    for (let i = 0; i < N; i++) {
      const a = i === 0 ? N - 1 : i - 1, b = i === N - 1 ? 0 : i + 1;
      dx[i] = px[a] - 2 * px[i] + px[b];
      dz[i] = pz[a] - 2 * pz[i] + pz[b];
    }
    for (let i = 0; i < N; i++) {
      const a = i === 0 ? N - 1 : i - 1, b = i === N - 1 ? 0 : i + 1;
      const gx = dx[a] - 2 * dx[i] + dx[b];
      const gz = dz[a] - 2 * dz[i] + dz[b];
      const g = nx[i] * gx + nz[i] * gz;
      const v = w[i] - eta * g;
      w[i] = v > limit ? limit : v < -limit ? -limit : v;
    }
  }
}

function sampleCenter(track, N) {
  const L = track.length;
  const cx = new Float64Array(N), cz = new Float64Array(N), nx = new Float64Array(N), nz = new Float64Array(N);
  const p = new THREE.Vector3(), r = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const s = (i / N) * L;
    track.getPointAt(s, p);
    track.getRightAt(s, r);
    cx[i] = p.x;
    cz[i] = p.z;
    nx[i] = r.x;
    nz[i] = r.z;
  }
  return { cx, cz, nx, nz };
}

// periodic linear resample of an offset array to a new count
function resampleLoop(w, M) {
  const N = w.length, out = new Float64Array(M);
  for (let j = 0; j < M; j++) {
    const f = (j / M) * N, i = Math.floor(f), t = f - i;
    out[j] = w[i % N] * (1 - t) + w[(i + 1) % N] * t;
  }
  return out;
}

function buildRacingLine(track) {
  const L = track.length;
  const limit = Math.max(0.5, (track.wallOffset ?? 9.2) - LINE_MARGIN);
  // coarse → fine hierarchy
  const levels = [
    { ds: 16, iters: 2500 },
    { ds: 6, iters: 1200 },
    { ds: 2, iters: 500 },
  ];
  let w = null, geo = null;
  for (const lv of levels) {
    const N = Math.max(48, Math.round(L / lv.ds));
    geo = sampleCenter(track, N);
    w = w ? resampleLoop(w, N) : new Float64Array(N);
    relaxMinCurvature(geo.cx, geo.cz, geo.nx, geo.nz, w, limit, lv.iters);
  }
  const N = w.length;
  const step = L / N;
  const { cx, cz, nx, nz } = geo;
  const px = new Float64Array(N), pz = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    px[i] = cx[i] + nx[i] * w[i];
    pz[i] = cz[i] + nz[i] * w[i];
  }
  // segment lengths along the line (i → i+1)
  const seg = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    seg[i] = Math.hypot(px[j] - px[i], pz[j] - pz[i]);
  }
  // signed curvature of the line (+ = bends right), 3-point circle over ±K samples, then smoothed
  const K = 2;
  const kRaw = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i - K + N) % N, b = (i + K) % N;
    const ax = px[i] - px[a], az = pz[i] - pz[a];
    const bx = px[b] - px[i], bz = pz[b] - pz[i];
    const cxv = px[b] - px[a], czv = pz[b] - pz[a];
    const cross = ax * bz - az * bx; // > 0 → heading increases → LEFT turn
    const den = Math.hypot(ax, az) * Math.hypot(bx, bz) * Math.hypot(cxv, czv);
    kRaw[i] = den > 1e-9 ? (-2 * cross) / den : 0;
  }
  const kap = new Float64Array(N);
  const W = 3;
  for (let i = 0; i < N; i++) {
    let acc = 0;
    for (let j = -W; j <= W; j++) acc += kRaw[(i + j + N) % N];
    kap[i] = acc / (2 * W + 1);
  }
  return { N, step, L, limit, w, px, pz, seg, kap, corners: findCorners(kap, w, step, L) };
}

/**
 * Corner apexes on the line: local |κ| maxima tighter than ~90 m radius, ≥ 70 m apart. side: +1 = right-hander
 * (the apex, i.e. the inside, is on the + lateral side). Taken from the line's offset at the apex, which sits on
 * the inside by construction (independent of the curvature sign convention).
 */
function findCorners(kap, w, step, L) {
  const N = kap.length;
  const out = [];
  const W = Math.max(2, Math.round(30 / step));
  for (let i = 0; i < N; i++) {
    const a = Math.abs(kap[i]);
    if (a < 0.011) continue;
    let isMax = true;
    for (let j = -W; j <= W && isMax; j++) if (j && Math.abs(kap[(i + j + N) % N]) > a) isMax = false;
    if (!isMax) continue;
    const s = i * step;
    const side = Math.sign(w[i]) || 1;
    if (out.length && s - out[out.length - 1].s < 70) {
      if (a > out[out.length - 1].k) out[out.length - 1] = { s, k: a, side };
      continue;
    }
    out.push({ s, k: a, side });
  }
  if (out.length > 1 && out[0].s + L - out[out.length - 1].s < 70) out.pop();
  return out;
}

/** Racing line for a track (cached). Exposed for debug overlays: { N, step, w, px, pz, kap, limit }. */
export function getRacingLine(track) {
  if (!track || !(track.length > 0)) return null;
  let line = LINE_CACHE.get(track);
  if (!line) {
    line = buildRacingLine(track);
    LINE_CACHE.set(track, line);
  }
  return line;
}

// ---------------------------------------------------------------------------------------------------------------
// Speed plan
// ---------------------------------------------------------------------------------------------------------------

function buildSpeedPlan(line, physics, { mu, brakeDecel, vTop }) {
  const { N, kap, seg } = line;
  const spec = physics?.spec || {};
  const m = physics?.mass || 1450;
  const cDown = (0.5 * 1.225 * (spec.clA ?? 1.05)) / m; // downforce accel per v²
  const cDrag = (0.5 * 1.225 * (spec.cdA ?? 1.0)) / m;
  const v = new Float64Array(N);
  const aLatMax = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const k = Math.abs(kap[i]);
    const den = k - mu * cDown;
    v[i] = den > 1e-5 ? Math.min(vTop, Math.sqrt((mu * G) / den)) : vTop;
  }
  const latCap = (vi) => mu * (G + cDown * vi * vi);
  // backward (braking) pass, twice around the loop for wrap-around
  for (let pass = 0; pass < 2; pass++) {
    for (let n = N - 1; n >= 0; n--) {
      const i = n, j = (n + 1) % N;
      const vj = v[j];
      const aLat = vj * vj * Math.abs(kap[i]);
      const cap = latCap(vj);
      const ell = Math.sqrt(Math.max(0.05, 1 - (aLat / cap) ** 2));
      const dec = brakeDecel * ell + cDrag * vj * vj;
      const lim = Math.sqrt(vj * vj + 2 * dec * seg[i]);
      if (lim < v[i]) v[i] = lim;
    }
  }
  // forward (acceleration) pass
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const vi = v[i];
      const acc = physics?.estimateAccel ? Math.max(0.3, physics.estimateAccel(vi)) : Math.max(0.3, 8 - 0.0012 * vi * vi);
      const aLat = vi * vi * Math.abs(kap[i]);
      const ell = Math.sqrt(Math.max(0.1, 1 - (aLat / latCap(vi)) ** 2));
      const lim = Math.sqrt(vi * vi + 2 * acc * ell * seg[i]);
      if (lim < v[j]) v[j] = lim;
    }
  }
  for (let i = 0; i < N; i++) aLatMax[i] = latCap(v[i]);
  return v;
}

// ---------------------------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------------------------

const NEUTRAL = Object.freeze({ throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false });

export class AIDriver {
  constructor({ track, physics, skill = 0.8, aggression = 0.5, laneBias = 0, seed = 1 } = {}) {
    this.track = track || null;
    this.physics = physics || null;
    this.skill = clamp(Number.isFinite(+skill) ? +skill : 0.8, 0.4, 1);
    this.aggression = clamp(Number.isFinite(+aggression) ? +aggression : 0.5, 0, 1);
    this.laneBias = Number.isFinite(+laneBias) ? +laneBias : 0;
    this.seed = seed | 0 || 1;
    const rnd = mulberry32(this.seed * 7919 + 13);
    const sk = clamp((this.skill - 0.7) / 0.25, 0, 1.2); // 0 at 0.7, 1 at 0.95
    // skill → how close to the physical limit this driver plans, and small personal quirks
    this.muFrac = Math.min(0.985, lerp(0.88, 0.99, sk) * (1 + (rnd() - 0.5) * 0.02));
    this.brakeFrac = lerp(0.84, 0.97, sk) * (1 + (rnd() - 0.5) * 0.04);
    this.noiseAmp = lerp(0.7, 0.12, clamp(sk, 0, 1)); // m of line wobble
    this.speedNoise = lerp(0.03, 0.006, clamp(sk, 0, 1));
    this._phase = [rnd() * 6.283, rnd() * 6.283, rnd() * 6.283];
    this.fq = [6.283 / (140 + rnd() * 120), 6.283 / (260 + rnd() * 200), 6.283 / (90 + rnd() * 80)];
    this.nitroEager = lerp(0.6, 1, rnd()) * lerp(0.7, 1, this.aggression);
    this.reaction = lerp(0.2, 0.1, clamp(sk, 0, 1));
    // personality: attackers brake a touch later and follow closer; defenders cover the inside line
    const ag = this.aggression;
    this.brakeFrac *= 1 + 0.03 * (ag - 0.5);
    this.attack = ag;
    this.defend = 1 - ag;
    this.mistakeRate = lerp(0.13, 0.05, clamp(sk, 0, 1)) * lerp(0.75, 1.3, ag); // per corner (~10 corners a lap)
    this.paceSpread = lerp(0.022, 0.012, clamp(sk, 0, 1)); // per-lap pace variation (fraction of speed)
    this._rnd = mulberry32(this.seed * 104729 + 71);
    this.paceLap = 1;
    this.mistake = null; // { kind: 'lateBrake' | 'wide' | 'badExit', s (apex), side (+1 right-hander), amt 0.55..1 }
    this._cornerIdx = -1;
    this._lastS = null;
    this._defendT = 0;
    this._defendSide = 0;
    this._defendCd = 0;
    this.stats = { mistakes: 0, defends: 0, laps: 0 };

    this.line = null;
    this.plan = null;
    this._planKey = '';
    this.s = null;
    this.lateral = 0;
    this.avoid = 0;
    this.targetLateral = 0;
    this.targetSpeed = 0;
    this.mode = 'idle'; // 'idle' | 'race' | 'recover'
    this._stuckT = 0;
    this._wrongT = 0;
    this._recoverT = 0;
    this._recoverSteer = 0;
    this._raceT = 0;
    this._nitroHold = 0;
    this._steerOut = 0;
    this._wallRisk = 0;
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this.controls = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false, hold: false };
    this.debug = { avoidTarget: 0, latMin: 0, latMax: 0, blockedAhead: false, followSpeed: Infinity, squeezedBehind: false };
    // build line + speed plan now (load time), not on the first race frame
    if (this.track && this.physics) {
      try {
        this._ensurePlan();
      } catch (e) {
        console.warn('[ai] racing line build failed', e);
      }
    }
  }

  _ensurePlan() {
    if (!this.line) this.line = getRacingLine(this.track);
    if (!this.line) return false;
    const key = `${this.muFrac.toFixed(3)}`;
    if (!this.plan || this._planKey !== key) {
      // usable lateral μ of this car (front-limited, ≈ 97 % of the front tire's μ in steady state)
      const sp = this.physics?.spec || {};
      const muCar = 0.97 * (sp.muLat ?? 1.2) * (sp.frontGrip ?? 1);
      const mu = muCar * this.muFrac;
      const brakeMax = 0.9 * (sp.muLong ?? 1.25) * G; // measured ≈ 11.7 m/s² avg incl. drag at μ 1.25
      this.plan = buildSpeedPlan(this.line, this.physics, { mu, brakeDecel: brakeMax * this.brakeFrac, vTop: 95 });
      this._planKey = key;
    }
    return true;
  }

  /** interpolated line offset (+ right) at centerline arc length s */
  lineOffsetAt(s) {
    const ln = this.line;
    const f = ((((s % ln.L) + ln.L) % ln.L) / ln.L) * ln.N;
    const i = Math.floor(f) % ln.N, t = f - Math.floor(f);
    return ln.w[i] * (1 - t) + ln.w[(i + 1) % ln.N] * t;
  }

  planSpeedAt(s) {
    const ln = this.line;
    const f = ((((s % ln.L) + ln.L) % ln.L) / ln.L) * ln.N;
    const i = Math.floor(f) % ln.N, t = f - Math.floor(f);
    return this.plan[i] * (1 - t) + this.plan[(i + 1) % ln.N] * t;
  }

  /** min planned speed over [s0, s0 + dist] */
  _minPlan(s0, dist) {
    const ln = this.line;
    let v = Infinity;
    const n = Math.max(1, Math.ceil(dist / ln.step));
    for (let k = 0; k <= n; k++) v = Math.min(v, this.planSpeedAt(s0 + k * ln.step));
    return v;
  }

  _curvAt(s) {
    const ln = this.line;
    const i = Math.floor(((((s % ln.L) + ln.L) % ln.L) / ln.L) * ln.N) % ln.N;
    return ln.kap[i];
  }

  /** Next corner apex ahead of the car: { c, d } (d = distance along the centerline). */
  _nextCorner(L) {
    const C = this.line.corners;
    if (!C || !C.length) return null;
    let best = null, bd = Infinity;
    for (let i = 0; i < C.length; i++) {
      const d = ((C[i].s - this.s) % L + L) % L;
      if (d < bd) { bd = d; best = i; }
    }
    return { c: C[best], i: best, d: bd };
  }

  /** Per-lap pace draws and corner-mistake rolls (once per corner, decided ~70-300 m before the apex). */
  _racecraft(dt, L) {
    const rnd = this._rnd;
    if (this._lastS == null || (this._lastS > L * 0.75 && this.s < L * 0.25)) {
      // a fresh lap: most laps a little off the planned limit, the odd one right on it
      this.paceLap = 1 - (0.002 + rnd() * rnd() * this.paceSpread * 2);
      if (this._lastS != null) this.stats.laps++;
    }
    this._lastS = this.s;
    if (this.mistake && wrapS(this.s - this.mistake.s, L) > 100) this.mistake = null;
    const nc = this._nextCorner(L);
    if (!nc || nc.i === this._cornerIdx) return;
    this._cornerIdx = nc.i;
    if (this.mistake || this._raceT < 8 || rnd() >= this.mistakeRate) return;
    const r = rnd();
    const kind = r < 0.2 + 0.4 * this.attack && nc.d > 120 ? 'lateBrake' : r < 0.75 ? 'wide' : 'badExit';
    this.mistake = { kind, s: nc.c.s, side: nc.c.side, amt: 0.55 + 0.45 * rnd() };
    this.stats.mistakes++;
  }

  // smooth bump around the apex of the current mistake (0..1), d = s - apex (m)
  _mistakeBump(d, kind) {
    if (kind === 'badExit') return 0;
    const pre = kind === 'lateBrake' ? 35 : 55;
    return smoothstep(-pre, -12, d) * (1 - smoothstep(25, 80, d));
  }

  /** Lateral offset (m, + right) a mistake adds at centerline s: running wide = toward the outside of the corner. */
  _mistakeLat(s, L) {
    const m = this.mistake;
    const b = this._mistakeBump(wrapS(s - m.s, L), m.kind);
    return b > 0 ? -m.side * b * (m.kind === 'lateBrake' ? 2.4 + 1.2 * m.amt : 2.8 + 1.6 * m.amt) : 0;
  }

  /** Speed factor a mistake imposes at centerline s (lifting / scrubbing speed around the apex). */
  _mistakeSpeed(s, L) {
    const m = this.mistake;
    const b = this._mistakeBump(wrapS(s - m.s, L), m.kind);
    return 1 - b * (m.kind === 'lateBrake' ? 0.09 + 0.06 * m.amt : 0.07 + 0.05 * m.amt);
  }

  update(dt, ctx = {}) {
    const out = this.controls;
    out.handbrake = false;
    out.nitro = false;
    const ph = this.physics, track = this.track;
    if (!ph || !track || !this._ensurePlan()) return Object.assign(out, NEUTRAL);
    dt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;
    ctx = ctx || {};

    // ---- where are we --------------------------------------------------------------------------------------
    const pr = track.project(ph.position, this.s ?? undefined);
    this.s = pr.s;
    this.lateral = pr.lateral;
    const L = track.length;
    const v = ph.speed; // signed forward speed
    const vAbs = Math.max(0, v);

    if (!ctx.raceActive) {
      this.mode = 'idle';
      this._stuckT = this._wrongT = this._recoverT = 0;
      this._raceT = 0;
      this.mistake = null;
      this._cornerIdx = -1;
      this._lastS = null;
      this._defendT = 0;
      this.paceLap = 1;
      out.throttle = 0;
      out.brake = 1;
      out.steer = 0;
      out.hold = true; // physics: hold the brake without engaging reverse
      return out;
    }
    out.hold = false;
    this._raceT += dt;

    const h = ph.heading;
    const fx = Math.sin(h), fz = Math.cos(h);
    const tan = track.getTangentAt(this.s, this._tmp);
    const along = fx * tan.x + fz * tan.z; // 1 = facing race direction

    // ---- recovery: stuck, or facing the wrong way --------------------------------------------------------------
    if (this.mode === 'recover') {
      this._recoverT -= dt;
      if (this._recoverT <= 0) {
        this.mode = 'race';
        this._stuckT = 0;
        this._wrongT = 0;
      }
    }
    const roadHeading = Math.atan2(tan.x, tan.z);
    const hErr = wrapAngle(roadHeading - h); // > 0 → nose points right of the road direction
    // nose pointing into a nearby barrier (right side: hErr > 0, left side: hErr < 0)
    const facingWall = Math.abs(this.lateral) > (track.wallOffset ?? 9.2) - 2.2 && hErr * Math.sign(this.lateral) > 0.6;
    if (this.mode !== 'recover') {
      const wantMove = this._raceT > 2.5;
      if (wantMove && Math.abs(v) < 1.6) this._stuckT += dt * (facingWall ? 2.5 : 1);
      else this._stuckT = Math.max(0, this._stuckT - dt * 2);
      if (along < -0.2 && Math.abs(v) < 12) this._wrongT += dt;
      else this._wrongT = Math.max(0, this._wrongT - dt);
      if (this._stuckT > 1.4 || this._wrongT > 2.5) {
        this.mode = 'recover';
        this._recoverT = 1.5;
        // reverse away: steer so that backing up swings the nose toward the road direction (& away from the wall)
        const want = Math.atan2(tan.x, tan.z);
        const err = wrapAngle(want - h);
        const wallSide = Math.sign(this.lateral) || 1;
        this._recoverSteer = Math.abs(err) > 0.25 ? Math.sign(err) : wallSide * 0.6;
      }
    }
    if (this.mode === 'recover') {
      out.throttle = 0;
      out.brake = 1; // physics engages reverse when (nearly) stopped
      out.steer = this._recoverSteer;
      if (ph.gear > 0 && v > 1) out.steer = 0;
      this._steerOut = out.steer;
      return out;
    }
    this.mode = 'race';

    // ---- rubber band vs the player -----------------------------------------------------------------------------
    // Behind the player: +6 % power, +3 % grip, +3.6 % planned speed. Ahead of the player: −10 % power, −3 % grip
    // and up to −6.5 % planned (corner) speed — this circuit is cornering-limited, so a leader that is far ahead
    // has to back off in the corners for the player to catch up; planning slower than the limit never runs wide.
    let k = 0;
    const selfP = Number.isFinite(ctx.selfProgress) ? ctx.selfProgress : null;
    const playerP = Number.isFinite(ctx.playerProgress) ? ctx.playerProgress : null;
    if (selfP != null && playerP != null) {
      const gap = playerP - selfP; // > 0 → we're behind the player
      k = gap > 0 ? smoothstep(30, 250, gap) : -smoothstep(30, 250, -gap);
    }
    ph.powerScale = k >= 0 ? 1 + 0.06 * k : 1 + 0.1 * k;
    ph.gripScale = 1 + 0.03 * k;
    let planScale = k >= 0 ? 1 + 0.036 * k : 1 + 0.065 * k;
    // racecraft (rivals only): this lap's pace + slow in-lap form drift, and corner mistakes
    const craft = !this.isAutopilot;
    if (craft) {
      this._racecraft(dt, L);
      planScale *= this.paceLap * (1 - 0.004 * (0.5 + 0.5 * Math.sin(this.s * this.fq[1] * 0.37 + this._phase[2])));
    }

    // ---- traffic: overtake / avoid / keep spacing ------------------------------------------------------------
    // Cars alongside impose hard lateral constraints on our target (≥ SEP apart, both cars apply it, so they
    // part symmetrically); a slower car ahead in our path makes us pick the side with room, or tuck in behind.
    const lineHere = this.lineOffsetAt(this.s);
    const limit = this.line.limit;
    const SEP = 3.0;
    let latMin = -limit, latMax = limit;
    let avoidTarget = 0;
    let followSpeed = Infinity;
    let blockedAhead = false;
    let squeezedBehind = false;
    let threatBehind = false;
    const atk = craft ? this.attack : 0.5;
    const cars = Array.isArray(ctx.cars) ? ctx.cars : [];
    for (const c of cars) {
      if (!c || c.physics === ph || !c.physics) continue;
      let ds = (Number.isFinite(c.s) ? c.s : 0) - this.s;
      ds -= Math.round(ds / L) * L; // wrap to [-L/2, L/2]
      if (ds < -22 || ds > 32) continue;
      const cl = Number.isFinite(c.lateral) ? c.lateral : 0;
      const dl = cl - this.lateral;
      const cv = c.physics.speed ?? 0;
      if (ds < -5.8) {
        // someone lining us up from behind (same lane-ish, closing)
        if (ds > -15 && Math.abs(dl) < 4 && cv > vAbs + 0.5) threatBehind = true;
        continue;
      }
      if (Math.abs(ds) < 5.8) {
        // alongside / overlapping: stay on our side of them
        if (Math.abs(dl) < SEP + 1.5) {
          if (dl > 0) latMax = Math.min(latMax, cl - SEP);
          else latMin = Math.max(latMin, cl + SEP);
          if (ds > 0.5 && Math.abs(dl) < 2.2) squeezedBehind = true; // nose behind theirs and overlapping
        }
      } else if (ds > 0) {
        // ahead of us
        const myPathLat = lerp(this.lateral, lineHere + this.avoid, smoothstep(0, 25, ds));
        const inPath = Math.abs(cl - myPathLat) < SEP;
        const closing = vAbs - cv;
        if (inPath && (closing > -0.5 || ds < 12)) {
          const leftRoom = cl + limit, rightRoom = limit - cl; // free road on its left (−) / right (+) side
          const pref = Math.sign(lineHere - cl) || Math.sign(this.lateral - cl) || 1;
          let side = rightRoom > leftRoom + 1.5 ? 1 : leftRoom > rightRoom + 1.5 ? -1 : pref;
          if ((side > 0 ? rightRoom : leftRoom) < SEP) side = -side;
          const roomOk = (side > 0 ? rightRoom : leftRoom) >= SEP;
          const want = clamp(cl + side * (SEP + 0.3), -limit, limit) - lineHere;
          const urgency = smoothstep(30 + 12 * atk, 7, ds);
          if (Math.abs(want) * urgency > Math.abs(avoidTarget)) avoidTarget = want * urgency;
          // can't get by (yet): keep a speed-scaled gap — only while there's no room or we still overlap them
          const dSafe = (6.5 + 0.12 * vAbs) * lerp(1.15, 0.85, atk);
          const overlapping = Math.abs(dl) < 2.3;
          if (!roomOk || (overlapping && ds < dSafe + 4)) {
            blockedAhead = true;
            followSpeed = Math.min(followSpeed, Math.max(0, cv + (ds - dSafe) * 0.8));
          }
        }
      }
    }
    if (latMin > latMax) {
      // squeezed between cars/wall: aim for the middle and back off if we're the one behind
      const mid = (latMin + latMax) / 2;
      latMin = latMax = clamp(mid, -limit, limit);
      squeezedBehind = true;
    }
    if (squeezedBehind) {
      blockedAhead = true;
      followSpeed = Math.min(followSpeed, vAbs - 1.5);
    }
    // leaving the line mid-corner costs a lot of exit speed: overtaking shifts are mostly made on straights /
    // braking zones (the hard side-by-side constraints above still always apply)
    const kNear = Math.max(Math.abs(this._curvAt(this.s + 10)), Math.abs(this._curvAt(this.s + 25)));
    avoidTarget *= 1 - 0.65 * (1 - 0.45 * atk) * smoothstep(0.006, 0.02, kNear);
    // defending: cover the inside of the next corner when someone is lining us up (not while passing ourselves)
    if (craft) {
      this._defendCd -= dt;
      if (threatBehind && this._defendT <= 0 && this._defendCd <= 0 && avoidTarget === 0 && kNear < 0.008) {
        this._defendCd = 2.5;
        const nc = this._nextCorner(L);
        if (nc && nc.d > 35 && nc.d < 170 && this._rnd() < 0.45 * this.defend) {
          this._defendT = 1.2 + 1.4 * this.defend;
          this._defendSide = nc.c.side;
          this.stats.defends++;
        }
      }
      if (this._defendT > 0) {
        this._defendT -= dt;
        if (avoidTarget === 0) avoidTarget = clamp(this._defendSide * (limit - 1.0) - lineHere, -3.2, 3.2) * smoothstep(0, 0.6, this._defendT);
      }
    }
    this.avoid = damp(this.avoid, avoidTarget, avoidTarget === 0 ? 1.0 : 3.2, dt);
    const dbg = this.debug; // inspection aid for benches/tests (reused object, no per-frame garbage)
    dbg.avoidTarget = avoidTarget;
    dbg.latMin = latMin;
    dbg.latMax = latMax;
    dbg.blockedAhead = blockedAhead;
    dbg.followSpeed = followSpeed;
    dbg.squeezedBehind = squeezedBehind;

    // ---- steering: pure pursuit on the shifted line -----------------------------------------------------------
    const Ld = clamp(6.5 + 0.38 * vAbs, 7, 42);
    const sT = this.s + Ld;
    const noise = this.noiseAmp * (0.6 * Math.sin(sT * this.fq[0] + this._phase[0]) + 0.4 * Math.sin(sT * this.fq[1] + this._phase[1]));
    const kAhead = Math.abs(this._curvAt(sT));
    const bias = this.laneBias * 0.5 * (1 - smoothstep(0.004, 0.015, kAhead));
    const mLat = craft && this.mistake ? this._mistakeLat(sT, L) : 0;
    // Where the line sweeps across the road (S-bends, corner entries / exits) the car is already crossing at up to
    // ~20°: a passing / defending offset there turns into a lateral overshoot into the barrier, so it is faded out
    // and moves are made where the line runs straight along the road.
    let slope = 0, kPath = 0;
    for (let k = 0; k <= 5; k++) {
      const sk = this.s + ((Ld + 45) * k) / 5;
      slope = Math.max(slope, Math.abs(this.lineOffsetAt(sk + 6) - this.lineOffsetAt(sk - 6)) / 12);
      kPath = Math.max(kPath, Math.abs(this._curvAt(sk)));
    }
    const crossK = (1 - smoothstep(0.08, 0.2, slope)) * (1 - 0.8 * smoothstep(0.006, 0.016, kPath));
    let wT = this.lineOffsetAt(sT) + this.avoid * crossK + noise + bias + mLat;
    // Off-line moves (passing, defending, mistakes, wobble) may not take the car nearer a barrier than the racing
    // line itself goes there, less a margin: corner exits already run the line out to the limit, and an extra
    // metre of "avoid" there was what clipped the outside wall. Side-by-side spacing still wins over this.
    const lineT = this.lineOffsetAt(sT);
    const soft = limit - 1.1;
    if (wT > soft && wT > lineT) wT = Math.max(soft, lineT);
    else if (wT < -soft && wT < lineT) wT = Math.min(-soft, lineT);
    wT = clamp(wT, latMin, latMax);
    this.targetLateral = wT;
    const tp = track.getPointAt(sT, this._tmp);
    const rt = track.getRightAt(sT, this._tmp2);
    const tx = tp.x + rt.x * wT - ph.position.x;
    const tz = tp.z + rt.z * wT - ph.position.z;
    const fwd = tx * fx + tz * fz;
    const right = -tx * fz + tz * fx; // right = (-cos h, sin h)
    const d2 = Math.max(4, fwd * fwd + right * right);
    let kappa = (2 * right) / d2; // + = turn right
    if (fwd < 0) kappa = Math.sign(right || 1) * 0.2; // target behind: turn hard toward it
    const wb = ph.spec?.wheelBase ?? 2.7;
    let delta = Math.atan(wb * kappa);
    // yaw-rate damping: compare desired vs actual yaw rate (yawRate + = turning left)
    const rDes = -vAbs * kappa;
    delta += clamp(0.06 * (ph.yawRate - rDes), -0.08, 0.08) * smoothstep(5, 15, vAbs);
    const maxSteer = ph.maxSteerAt ? ph.maxSteerAt(vAbs) : 0.5;
    let steer = clamp(delta / maxSteer, -1, 1);
    // wall guard: if very close to a barrier and heading toward it, steer away firmly. Predictive (where we'll be
    // in ~0.55 s at the current lateral speed) so a car drifting out of a corner exit is caught before contact.
    const hw = track.wallOffset ?? 9.2;
    const latVel = ph.velocity.dot(track.getRightAt(this.s, this._tmp2));
    const outward = Math.sign(latVel) === Math.sign(this.lateral) && Math.abs(latVel) > 0.5;
    const latPred = Math.abs(this.lateral) + (outward ? Math.abs(latVel) * 0.55 : 0);
    this._wallRisk = outward ? smoothstep(hw - 1.9, hw - 0.9, latPred) : 0;
    if (outward && (Math.abs(this.lateral) > hw - 2.0 || this._wallRisk > 0)) {
      const gain = Math.max(smoothstep(hw - 2.0, hw - 1.2, Math.abs(this.lateral)), this._wallRisk * 0.8);
      steer = lerp(steer, -Math.sign(this.lateral), gain * 0.7);
    }
    this._steerOut = steer;
    out.steer = steer;

    // ---- speed: follow the plan with a short preview -------------------------------------------------------------
    // Never plan past the grip actually available: the plan already sits at muFrac of μ, so any speed scale s
    // (rubber band, speed noise) needs s² · muFrac ≤ gripScale. Over-driving here was what put cars in the wall.
    const vLim = Math.sqrt((0.985 * (ph.gripScale || 1)) / this.muFrac);
    planScale = Math.min(planScale, vLim / (1 + this.speedNoise));
    const noiseV = 1 + this.speedNoise * Math.sin(this.s * this.fq[2] + this._phase[2]);
    const preview = vAbs * this.reaction + 2;
    const mis = craft ? this.mistake : null;
    let vT = this._minPlan(this.s, preview) * noiseV * planScale;
    if (mis) {
      const d = wrapS(this.s - mis.s, L);
      // late braking: in the braking zone, aim for the speed the plan wanted 8-14 m earlier (capped at +8 %)...
      if (mis.kind === 'lateBrake' && d > -170 && d < -18) vT = Math.min(this._minPlan(this.s - 8 - 6 * mis.amt, preview) * noiseV * planScale, vT * 1.08);
      // ...and pay for it (and for any other slip) with speed scrubbed around the apex
      vT *= this._mistakeSpeed(this.s, L);
    }
    // off-line penalty: the plan assumes the racing line; if we're far off it (overtaking), be a bit more careful
    const offLine = Math.abs(this.lateral - lineHere);
    // (any deviation from the max-radius line in a corner tightens the path; ~1.4 % speed per metre, ≤ 8 %)
    // (judged against the tightest bit of the next ~60 m, so the car brakes for it in time)
    let kBrake = 0;
    for (let k = 0; k <= 4; k++) kBrake = Math.max(kBrake, Math.abs(this._curvAt(this.s + 4 + k * 14)));
    const offK = 1 - Math.min(0.08, 0.014 * Math.max(0, offLine - 0.6)) * smoothstep(0.004, 0.02, kBrake);
    vT *= offK;
    if (blockedAhead) vT = Math.min(vT, followSpeed + 1);
    // badly misaligned with the road (spun / turning around): crawl through a tight turn instead of flooring it
    const misAlign = Math.abs(hErr);
    if (misAlign > 0.8) vT = Math.min(vT, lerp(16, 4.5, smoothstep(0.8, 2.0, misAlign)));
    this.targetSpeed = vT;
    // feed-forward: planned acceleration just ahead (slope of the plan) + proportional speed error
    const dFF = Math.max(6, vAbs * 0.35);
    let vA = this.planSpeedAt(this.s + preview + dFF) * noiseV * planScale * offK * (mis ? this._mistakeSpeed(this.s + preview + dFF, L) : 1);
    if (blockedAhead) vA = Math.min(vA, followSpeed + 1);
    const aPlan = clamp((vA * vA - vT * vT) / (2 * dFF), -14, 10);
    const err = vT - v;
    const aCmd = aPlan + err * 2.2;
    let thr = 0, brk = 0;
    if (aCmd >= 0 || err > 0) {
      thr = err > 0.5 ? 1 : clamp(0.45 + err * 0.9 + aCmd * 0.15, 0.08, 1);
    } else {
      // what drag + engine braking already provide, the brakes don't need to
      const coast = 0.00033 * v * v + 0.6;
      const need = -aCmd - coast;
      if (need > 0.2) brk = clamp(need / 14.5, 0, 1);
      else thr = clamp(0.35 + aCmd * 0.25, 0, 0.45);
    }
    // running out of road on an exit: ease the throttle (less understeer, the nose tucks back in)
    if (this._wallRisk > 0) thr *= 1 - 0.6 * this._wallRisk;
    // traction management: ease off while sliding
    const slide = Math.abs(ph.slipAngle || 0);
    if (slide > 0.12) thr *= 1 - smoothstep(0.12, 0.35, slide) * 0.7;
    // scruffy corner exit: hesitant on the throttle for a few car lengths
    if (mis && mis.kind === 'badExit') {
      const d = wrapS(this.s - mis.s, L);
      if (d > 0 && d < 90) thr = Math.min(thr, 0.32 + 0.2 * (1 - mis.amt) + 0.6 * smoothstep(60, 90, d));
    }
    out.throttle = thr;
    out.brake = brk;

    // ---- nitro on straights ---------------------------------------------------------------------------------------
    if (this._nitroHold > 0) this._nitroHold -= dt;
    // worth it when nothing in the next ~2.2 s of travel needs a lower speed than now (no braking zone ahead)
    const lookN = clamp(vAbs * 2.2, 40, 190);
    const straightAhead = this._minPlan(this.s + 4, lookN) > vAbs + 1.5;
    if (vAbs > 18 && straightAhead && Math.abs(steer) < 0.4 && !blockedAhead && brk === 0 && thr > 0.9 && slide < 0.08) {
      if (this._nitroHold <= 0 && ph.nitro > 0.08 * (2 - this.nitroEager)) this._nitroHold = 0.8 * this.nitroEager;
    }
    out.nitro = this._nitroHold > 0 && straightAhead && brk === 0;
    return out;
  }
}
