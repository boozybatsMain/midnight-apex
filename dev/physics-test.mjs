// Node test bench for VehiclePhysics (run: node dev/physics-test.mjs)
import * as THREE from 'three';
import { VehiclePhysics } from '../src/vehicle/physics.js';

const DT = 1 / 120;
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : String(v));
const mk = () => {
  const p = new VehiclePhysics();
  p.reset(new THREE.Vector3(0, 0, 0), 0);
  return p;
};
const ctl = (o = {}) => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false, ...o });
let failures = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`);
  if (!ok) failures++;
};

// ---- tire curve peaks
{
  const p = mk();
  const S = p.spec;
  const magic = (al, B, C, E) => { const x = B * al; return Math.sin(C * Math.atan(x - E * (x - Math.atan(x)))); };
  for (const [n, B, C, E] of [['front', S.Bf, S.Cf, S.Ef], ['rear', S.Br, S.Cr, S.Er]]) {
    let best = 0, bestA = 0;
    for (let a = 0; a < 1.2; a += 0.001) { const f = magic(a, B, C, E); if (f > best) { best = f; bestA = a; } }
    console.log(`tire ${n}: peak ${fmt(best, 3)} at ${fmt(bestA * 57.3, 1)}°, 20°→${fmt(magic(0.349, B, C, E), 3)}, 45°→${fmt(magic(0.785, B, C, E), 3)}, 90°→${fmt(magic(1.57, B, C, E), 3)}`);
  }
}

// ---- straight line acceleration
function accelRun(nitro = false, seconds = 60) {
  const p = mk();
  const marks = {};
  let t = 0, top = 0, shifts = [], lastGear = 1;
  while (t < seconds) {
    p.step(DT, ctl({ throttle: 1, nitro }));
    if (nitro) p.nitro = 1; // infinite for top speed test
    t += DT;
    for (const k of [100, 200, 250, 300]) if (!marks[k] && p.speedKmh >= k) marks[k] = t;
    if (p.gear !== lastGear) { shifts.push(`${lastGear}->${p.gear}@${fmt(p.speedKmh, 0)}km/h/${fmt(p.rpm, 0)}rpm`); lastGear = p.gear; }
    top = Math.max(top, p.speedKmh);
  }
  return { marks, top, shifts, p };
}
{
  const r = accelRun(false);
  console.log('accel:', JSON.stringify(Object.fromEntries(Object.entries(r.marks).map(([k, v]) => [k, +v.toFixed(2)]))), 'top', fmt(r.top, 1), 'rpm', fmt(r.p.rpm, 0), 'gear', r.p.gear);
  console.log('  shifts:', r.shifts.join(' '));
  check('0-100 ≈ 3.4 s', r.marks[100] > 3.0 && r.marks[100] < 3.9, fmt(r.marks[100]));
  check('top ≈ 305 km/h', r.top > 295 && r.top < 315, fmt(r.top, 1));
  const n = accelRun(true);
  console.log('nitro accel:', JSON.stringify(Object.fromEntries(Object.entries(n.marks).map(([k, v]) => [k, +v.toFixed(2)]))), 'top', fmt(n.top, 1));
  check('nitro top ≈ 335 km/h', n.top > 325 && n.top < 345, fmt(n.top, 1));
}

// ---- nitro duration
{
  const p = mk();
  let t = 0;
  for (let i = 0; i < 120 * 2; i++) p.step(DT, ctl({ throttle: 1 }));
  p.nitro = 1;
  while (p.nitro > 0.003 && t < 20) { p.step(DT, ctl({ throttle: 1, nitro: true })); t += DT; }
  check('nitro tank ≈ 5 s', t > 4.6 && t < 5.6, fmt(t));
}

// ---- braking 100 -> 0
{
  const p = mk();
  while (p.speedKmh < 100) p.step(DT, ctl({ throttle: 1 }));
  const x0 = p.position.clone();
  let t = 0;
  while (p.speed > 0.05 && t < 10) { p.step(DT, ctl({ brake: 1 })); t += DT; }
  const d = p.position.distanceTo(x0);
  check('brake 100-0 ~33-38 m', d > 30 && d < 40, `${fmt(d, 1)} m in ${fmt(t)} s`);
}

// ---- steady state lateral g (constant radius-ish via steering sweep at constant speed)
function steadyLat(kmh, steer) {
  const p = mk();
  p.velocity.set(0, 0, kmh / 3.6);
  p.speed = kmh / 3.6;
  p.syncGear();
  let gl = 0, n = 0, rate = 0;
  for (let i = 0; i < 120 * 6; i++) {
    // speed hold controller
    const err = kmh / 3.6 - p.speed;
    p.step(DT, ctl({ throttle: clamp01(err * 0.5 + 0.3), brake: clamp01(-err * 0.3), steer }));
    if (i > 120 * 4) { gl += Math.abs(p.gLat); rate += Math.abs(p.yawRate); n++; }
  }
  return { g: gl / n, kmh: p.speedKmh, slip: p.slipAngle * 57.3, yaw: rate / n, R: p.speed / Math.max(1e-3, rate / n), drift: p.drift };
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
{
  let best = { g: 0 };
  for (const s of [0.3, 0.5, 0.7, 0.85, 1]) {
    const r = steadyLat(100, s);
    console.log(`  100km/h steer ${s}: lat ${fmt(r.g)} g, speed ${fmt(r.kmh, 0)}, R ${fmt(r.R, 1)} m, slip ${fmt(r.slip, 1)}°, drift ${fmt(r.drift)}`);
    if (r.g > best.g) best = r;
  }
  check('max lateral g @100 ≈ 1.1-1.5', best.g > 1.05 && best.g < 1.6, fmt(best.g));
  for (const kmh of [60, 160, 220]) {
    const r = steadyLat(kmh, 1);
    console.log(`  ${kmh}km/h full steer: lat ${fmt(r.g)} g, R ${fmt(r.R, 1)} m, slip ${fmt(r.slip, 1)}°, speed ${fmt(r.kmh, 0)}`);
  }
}

// ---- at rest: no creep, no jitter
{
  const p = mk();
  for (let i = 0; i < 120 * 5; i++) p.step(DT, ctl());
  check('no creep at rest', p.position.length() < 1e-4 && p.speed === 0, `pos ${p.position.length().toExponential(2)} rpm ${fmt(p.rpm, 0)} gear ${p.gear}`);
  for (let i = 0; i < 120 * 2; i++) p.step(DT, ctl({ steer: 1 }));
  check('steer at rest: no motion', p.position.length() < 1e-4, `heading ${fmt(p.heading, 4)}`);
  // slow tight turn
  const q = mk();
  for (let i = 0; i < 120 * 6; i++) q.step(DT, ctl({ throttle: q.speedKmh < 10 ? 0.3 : 0, steer: 1 }));
  check('slow turn works (heading changes)', Math.abs(q.heading) > 1, `heading ${fmt(q.heading)} speed ${fmt(q.speedKmh, 1)} slip ${fmt(q.slipAngle, 3)}`);
}

// ---- reverse
{
  const p = mk();
  let t = 0;
  for (; t < 4; t += DT) p.step(DT, ctl({ brake: 1 }));
  check('reverse engages via brake hold', p.gear === -1 && p.speed < -3, `gear ${p.gear} speed ${fmt(p.speed)} kmh ${fmt(p.speedKmh, 1)}`);
  for (t = 0; t < 6; t += DT) p.step(DT, ctl({ brake: 1 }));
  check('reverse speed capped ~45', p.speedKmh < 48, fmt(p.speedKmh, 1));
  for (t = 0; t < 4; t += DT) p.step(DT, ctl({ throttle: 1 }));
  check('back to forward with throttle', p.gear >= 1 && p.speed > 3, `gear ${p.gear} speed ${fmt(p.speed)}`);
}

// ---- handbrake drift initiation + recovery
{
  const p = mk();
  while (p.speedKmh < 110) p.step(DT, ctl({ throttle: 1 }));
  let maxSlip = 0, t = 0, log = [];
  const seq = (dur, c) => { for (let e = 0; e < dur; e += DT, t += DT) { p.step(DT, ctl(c)); maxSlip = Math.max(maxSlip, Math.abs(p.slipAngle)); if (Math.round(t * 120) % 30 === 0) log.push(`${fmt(t, 2)}s v${fmt(p.speedKmh, 0)} slip${fmt(p.slipAngle * 57.3, 0)} drift${fmt(p.drift)} r${fmt(p.yawRate)} st${fmt(p.steerAngle * 57.3, 0)}`); } };
  seq(0.35, { throttle: 0.4, steer: 1, handbrake: true });
  seq(1.6, { throttle: 1, steer: 0.4 });
  const driftMid = p.drift, slipMid = p.slipAngle;
  seq(2.5, { throttle: 0.6, steer: 0 });
  console.log('  ' + log.join('\n  '));
  check('handbrake initiates drift', maxSlip > 0.3 && driftMid > 0.3, `maxSlip ${fmt(maxSlip * 57.3, 0)}° driftMid ${fmt(driftMid)} slipMid ${fmt(slipMid * 57.3, 0)}`);
  check('drift recovers (straightens)', Math.abs(p.slipAngle) < 0.08 && p.speedKmh > 40, `slip ${fmt(p.slipAngle * 57.3, 1)}° v ${fmt(p.speedKmh, 0)} drift ${fmt(p.drift)}`);
  check('nitro refilled while drifting', true, `nitro ${fmt(p.nitro, 3)}`);
}

// ---- dt stability: same maneuver at different dt
{
  const res = [];
  for (const dt of [1 / 240, 1 / 120, 1 / 60, 1 / 30]) {
    const p = mk();
    let t = 0;
    for (; t < 4; t += dt) p.step(dt, ctl({ throttle: 1 }));
    for (; t < 7; t += dt) p.step(dt, ctl({ throttle: 1, steer: 0.6 }));
    for (; t < 8; t += dt) p.step(dt, ctl({ brake: 1, steer: -0.5, handbrake: t < 7.3 }));
    res.push({ dt, x: p.position.x, z: p.position.z, v: p.speedKmh, ok: Number.isFinite(p.position.x) });
  }
  console.log('  dt runs:', res.map((r) => `dt=1/${Math.round(1 / r.dt)} (${fmt(r.x, 1)},${fmt(r.z, 1)}) v${fmt(r.v, 0)}`).join(' | '));
  const d = Math.hypot(res[0].x - res[1].x, res[0].z - res[1].z);
  check('dt stable (1/240 vs 1/120 close)', res.every((r) => r.ok) && d < 3, `diff ${fmt(d)} m`);
}

// ---- impulses: huge impulse, no NaN
{
  const p = mk();
  while (p.speedKmh < 150) p.step(DT, ctl({ throttle: 1 }));
  p.applyImpulse(new THREE.Vector3(1e7, 0, -3e6), new THREE.Vector3(1, 0, 2));
  for (let i = 0; i < 600; i++) p.step(DT, ctl({ throttle: 1, steer: Math.sin(i * 0.05) }));
  check('huge impulse stays finite', Number.isFinite(p.position.x) && Number.isFinite(p.heading), `v ${fmt(p.speedKmh, 0)} r ${fmt(p.yawRate)}`);
}

// ---- random fuzz: controls noise, never NaN
{
  const p = mk();
  let bad = false;
  for (let i = 0; i < 120 * 60; i++) {
    const k = Math.floor(i / 60) * 7919;
    p.step(DT, ctl({ throttle: (k % 3) / 2, brake: (k % 5) === 0 ? 1 : 0, steer: ((k % 11) - 5) / 5, handbrake: k % 13 === 0, nitro: k % 7 === 0 }));
    if (!Number.isFinite(p.position.x + p.position.z + p.heading + p.rpm + p.pitch + p.roll)) { bad = true; break; }
  }
  check('fuzz finite', !bad, `pos ${fmt(p.position.x, 0)},${fmt(p.position.z, 0)}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
