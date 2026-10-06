// AI recovery scenarios: nose into the barrier, facing backwards, stopped sideways. node dev/ai-recovery-test.mjs
import { VehiclePhysics } from '../src/vehicle/physics.js';
import { AIDriver } from '../src/vehicle/ai.js';
import { createTrackPath } from '../src/world/track.js';
const track = createTrackPath();
const L = track.length, DT = 1 / 120;
function scenario(label, s, lat, headingOffset) {
  const ph = new VehiclePhysics();
  const p = track.getPointAt(s).addScaledVector(track.getRightAt(s), lat), t = track.getTangentAt(s);
  ph.reset(p, Math.atan2(t.x, t.z) + headingOffset);
  const ai = new AIDriver({ track, physics: ph, skill: 0.85, seed: 5 });
  let prog = 0, prevS = s, c = {}, tt = 0, recovered = null, walls = 0;
  for (let i = 0; i < 120 * 20; i++) {
    if (i % 2 === 0) c = { ...ai.update(DT * 2, { raceActive: true, cars: [], selfProgress: prog, playerProgress: prog }) };
    ph.step(DT, c);
    const pr = track.project(ph.position, prevS);
    const lim = track.wallOffset - 0.95;
    if (Math.abs(pr.lateral) > lim) { walls++; const r = track.getRightAt(pr.s), sg = Math.sign(pr.lateral); ph.position.addScaledVector(r, -(Math.abs(pr.lateral) - lim) * sg); const vn = ph.velocity.dot(r) * sg; if (vn > 0) ph.velocity.addScaledVector(r, -vn * 1.3 * sg); }
    let d = pr.s - prevS; d -= Math.round(d / L) * L; prog += d; prevS = pr.s;
    tt += DT;
    if (process.argv.includes('-v') && label.startsWith(process.argv[3] || 'facing') && i % 30 === 0 && tt < 12) console.log(`   t${tt.toFixed(2)} v${ph.speed.toFixed(1)} g${ph.gear} lat${pr.lateral.toFixed(1)} hdgErr${(((ph.heading - Math.atan2(track.getTangentAt(pr.s).x, track.getTangentAt(pr.s).z)) % 6.283 + 9.42) % 6.283 - 3.14).toFixed(2)} thr${c.throttle?.toFixed(2)} brk${c.brake?.toFixed(2)} st${c.steer?.toFixed(2)} mode ${ai.mode} stuck${ai._stuckT.toFixed(1)} wrong${ai._wrongT.toFixed(1)}`);
    if (recovered == null && prog > 60 && ph.speed > 15) recovered = tt;
  }
  console.log(`${label.padEnd(34)} → ${recovered != null ? `racing again after ${recovered.toFixed(1)} s` : 'NOT RECOVERED'}; progress after 20 s ${prog.toFixed(0)} m, mode ${ai.mode}`);
}
scenario('nose into right barrier (60°)', 120, 8.1, -1.05);
scenario('nose into left barrier (70°)', 120, -8.1, 1.2);
scenario('facing backwards mid-road', 120, 0, Math.PI);
scenario('sideways at the wall (90°)', 420, 8.0, -Math.PI / 2);
scenario('backwards at the wall in a corner', 425, -7.5, Math.PI * 0.9);
