// "Keyboard player" simulation: AI intent → digital keys (with latency + hysteresis) → core's keyboard
// smoothing (replicated from src/core/input.js) → physics. Checks a human-like digital driver can lap cleanly.
import { VehiclePhysics } from '../src/vehicle/physics.js';
import { AIDriver } from '../src/vehicle/ai.js';
import { createTrackPath } from '../src/world/track.js';
const track = createTrackPath();
const DT = 1 / 120;
const approach = (c, t, r, dt) => (c < t ? Math.min(c + r * dt, t) : Math.max(c - r * dt, t));
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
for (const skill of [0.8, 0.9]) for (const latency of (process.argv.includes("-v") ? [0.08] : [0.08, 0.16])) {
  const ph = new VehiclePhysics(); const g = track.getStartGrid(0); ph.reset(g.position, g.heading);
  const ai = new AIDriver({ track, physics: ph, skill, seed: 3 });
  const c = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false };
  const queue = []; let keys = { l: 0, r: 0, w: 0, s: 0 }; let t = 0, prog = 0, prevS = null, walls = 0, inWall = false, maxSlip = 0, lapT = [], lap0 = 0;
  while (t < 170 && lapT.length < 2) {
    if (Math.round(t * 120) % 2 === 0) {
      const a = ai.update(DT * 2, { raceActive: true, cars: [] });
      // hysteresis on the digital steering decision; a human taps
      const st = a.steer;
      const want = { r: st > (keys.r ? 0.12 : 0.3) ? 1 : 0, l: st < -(keys.l ? 0.12 : 0.3) ? 1 : 0, w: a.throttle > 0.45 ? 1 : 0, s: a.brake > 0.15 ? 1 : 0 };
      queue.push({ at: t + latency, k: want });
    }
    while (queue.length && queue[0].at <= t) keys = queue.shift().k;
    // core Input.update (keyboard path)
    c.throttle = approach(c.throttle, keys.w, keys.w > c.throttle ? 7 : 11, DT);
    c.brake = approach(c.brake, keys.s, keys.s > c.brake ? 7 : 11, DT);
    const kSteer = keys.r - keys.l;
    const maxLock = 1 - 0.38 * smooth(40, 260, ph.speedKmh);
    if (kSteer !== 0) {
      const target = kSteer * maxLock;
      const toward = Math.sign(target) === Math.sign(c.steer) && Math.abs(target) > Math.abs(c.steer);
      c.steer = approach(c.steer, target, c.steer === 0 || toward ? 6 : 10, DT);
    } else c.steer = approach(c.steer, 0, 10, DT);
    ph.step(DT, c);
    const pr = track.project(ph.position, prevS ?? undefined);
    if (prevS != null) { let d = pr.s - prevS; d -= Math.round(d / track.length) * track.length; prog += d; }
    prevS = pr.s;
    if (Math.abs(pr.lateral) > track.wallOffset - 0.95) { if (!inWall) walls++; inWall = true;
      const r = track.getRightAt(pr.s); const sg = Math.sign(pr.lateral); ph.position.addScaledVector(r, -(Math.abs(pr.lateral) - (track.wallOffset - 0.95)) * sg);
      const vn = ph.velocity.dot(r) * sg; if (vn > 0) ph.velocity.addScaledVector(r, -vn * 1.3 * sg); } else inWall = false;
    maxSlip = Math.max(maxSlip, Math.abs(ph.slipAngle));
    if (Math.abs(ph.slipAngle) > 0.2 && !ph._logged && process.argv.includes('-v')) { ph._logged = true; console.log(`  slide t${t.toFixed(1)} s${pr.s.toFixed(0)} v${ph.speedKmh.toFixed(0)} slip${(ph.slipAngle*57.3).toFixed(0)} steer${c.steer.toFixed(2)} thr${c.throttle.toFixed(2)} brk${c.brake.toFixed(2)} gear${ph.gear} latch${ph._driftLatch}`); }
    if (Math.abs(ph.slipAngle) < 0.05) ph._logged = false;
    if (prog > track.length * (lapT.length + 1) - 40 && prog > 0 && Math.floor((prog + 40) / track.length) > lapT.length) { lapT.push(t - lap0); lap0 = t; }
    t += DT;
  }
  console.log(`keyboard skill ${skill} latency ${latency}s: laps ${lapT.map((x) => x.toFixed(1)).join(', ')} wall hits ${walls} maxSlip ${(maxSlip * 57.3).toFixed(1)}°`);
}
