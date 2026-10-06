import { VehiclePhysics } from '../src/vehicle/physics.js';
import { AIDriver } from '../src/vehicle/ai.js';
const { createTrackPath } = await import('../src/world/trackPath.js');
const track = createTrackPath();
const ph = new VehiclePhysics(); const g = track.getStartGrid(0); ph.reset(g.position, g.heading);
const ai = new AIDriver({ track, physics: ph, skill: 0.9, seed: 1 });
const DT = 1 / 120; let c = {}; const cnt = { frames: 0, v: 0, straight: 0, steer: 0, thr: 0, slide: 0, all: 0, nitroOut: 0, active: 0 };
for (let i = 0; i < 120 * 160; i++) {
  if (i % 2 === 0) {
    c = { ...ai.update(DT * 2, { raceActive: true, cars: [] }) };
    const vAbs = Math.max(0, ph.speed);
    const lookN = Math.min(190, Math.max(40, vAbs * 2.2));
    const st = ai._minPlan(ai.s + 4, lookN) > vAbs + 1.5;
    cnt.frames++; if (vAbs > 18) cnt.v++; if (st) cnt.straight++; if (Math.abs(c.steer) < 0.4) cnt.steer++; if (c.throttle > 0.9) cnt.thr++; if (Math.abs(ph.slipAngle) < 0.08) cnt.slide++;
    if (vAbs > 18 && st && Math.abs(c.steer) < 0.4 && c.throttle > 0.9 && c.brake === 0) cnt.all++;
    if (c.nitro) cnt.nitroOut++;
  }
  ph.step(DT, c); if (ph.nitroActive) cnt.active++;
}
console.log(cnt, 'nitro tank end', ph.nitro.toFixed(2));
