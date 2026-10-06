// prints a speed trace of one AI lap (s, speed, plan, lateral vs line) — node dev/ai-trace.mjs
import { VehiclePhysics } from '../src/vehicle/physics.js';
import { AIDriver, getRacingLine } from '../src/vehicle/ai.js';
const { createTrackPath } = await import('../src/world/trackPath.js');
const track = createTrackPath();
const line = getRacingLine(track);
const ph = new VehiclePhysics();
const g = track.getStartGrid(0);
ph.reset(g.position, g.heading);
const ai = new AIDriver({ track, physics: ph, skill: Number(process.argv[2] || 0.92), seed: 1 });
const DT = 1 / 120;
let t = 0, last = -999, prog = 0, prevS = track.project(ph.position).s, c = {};
const rows = [];
while (t < 200 && prog < track.length * 2) {
  if (Math.round(t * 120) % 2 === 0) c = { ...ai.update(DT * 2, { raceActive: true, cars: [] }) };
  ph.step(DT, c);
  let d = ai.s - prevS; d -= Math.round(d / track.length) * track.length; prog += d; prevS = ai.s;
  if (prog > track.length && prog - last >= 25) {
    last = prog;
    const s = ai.s;
    rows.push(`s${s.toFixed(0).padStart(5)} t${t.toFixed(1).padStart(6)} v${ph.speedKmh.toFixed(0).padStart(4)} plan${(ai.planSpeedAt(s) * 3.6).toFixed(0).padStart(4)} tgt${(ai.targetSpeed * 3.6).toFixed(0).padStart(4)} lat${ai.lateral.toFixed(1).padStart(6)} line${ai.lineOffsetAt(s).toFixed(1).padStart(6)} R${(1 / Math.max(1e-4, Math.abs(line.kap[Math.floor(s / line.step) % line.N]))).toFixed(0).padStart(6)} thr${c.throttle.toFixed(2)} brk${c.brake.toFixed(2)} st${c.steer.toFixed(2)} g${ph.gear} slip${(ph.slipAngle * 57.3).toFixed(1)} n${c.nitro ? 1 : 0}`);
  }
  t += DT;
}
console.log(rows.join('\n'));
