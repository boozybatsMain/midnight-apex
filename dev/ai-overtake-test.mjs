// Overtake scenario: a slow blocker on the racing line, a fast AI behind. node dev/ai-overtake-test.mjs
import * as THREE from 'three';
import { VehiclePhysics } from '../src/vehicle/physics.js';
import { AIDriver } from '../src/vehicle/ai.js';
import { createTrackPath } from '../src/world/track.js';
const track = createTrackPath();
const L = track.length, DT = 1 / 120;
function run(gapStart, blockerPower, label, blockerSkill = 0.75) {
  const mk = (s, lat, skill, seed) => {
    const ph = new VehiclePhysics();
    const p = track.getPointAt(s).addScaledVector(track.getRightAt(s), lat), t = track.getTangentAt(s);
    ph.reset(p, Math.atan2(t.x, t.z));
    return { ph, ai: new AIDriver({ track, physics: ph, skill, seed }), s, prog: s, prevS: s, lateral: lat };
  };
  const s0 = 200;
  const blocker = mk(s0 + gapStart, 0, blockerSkill, 9), racer = mk(s0, 0, 0.95, 2);
  blocker.ph.powerScale = blockerPower;
  const cars = [blocker, racer];
  const ctx = cars.map((c) => ({ physics: c.ph, s: c.s, lateral: c.lateral, progress: c.prog }));
  let t = 0, hits = 0, touching = false, passedAt = null, minSep = 99, walls = 0, inWall = [false, false];
  let ctl = [{}, {}];
  while (t < 90) {
    if (Math.round(t * 120) % 2 === 0) cars.forEach((c, i) => { const o = c.ai.update(DT * 2, { raceActive: true, selfProgress: c.prog, playerProgress: c.prog, cars: ctx }); ctl[i] = { ...o }; if (i === 0) c.ph.powerScale = blockerPower; });
    cars.forEach((c, i) => c.ph.step(DT, ctl[i]));
    // collisions: wall clamp + 3-circle car contact
    cars.forEach((c, i) => {
      const pr = track.project(c.ph.position, c.s); c.s = pr.s; c.lateral = pr.lateral;
      let d = c.s - c.prevS; d -= Math.round(d / L) * L; c.prog += d; c.prevS = c.s;
      const lim = track.wallOffset - 0.95;
      if (Math.abs(pr.lateral) > lim) { if (!inWall[i]) walls++; inWall[i] = true; const r = track.getRightAt(pr.s), sg = Math.sign(pr.lateral); c.ph.position.addScaledVector(r, -(Math.abs(pr.lateral) - lim) * sg); const vn = c.ph.velocity.dot(r) * sg; if (vn > 0) c.ph.velocity.addScaledVector(r, -vn * 1.3 * sg); } else inWall[i] = false;
      Object.assign(ctx[i], { s: c.s, lateral: c.lateral, progress: c.prog });
    });
    const a = blocker.ph, b = racer.ph; let hit = false;
    for (const oa of [-1.55, 0, 1.55]) for (const ob of [-1.55, 0, 1.55]) {
      const ax = a.position.x + Math.sin(a.heading) * oa, az = a.position.z + Math.cos(a.heading) * oa;
      const bx = b.position.x + Math.sin(b.heading) * ob, bz = b.position.z + Math.cos(b.heading) * ob;
      const dx = bx - ax, dz = bz - az, dd = Math.hypot(dx, dz);
      minSep = Math.min(minSep, dd);
      if (dd < 1.96) { hit = true; const nx = dx / dd, nz = dz / dd, pen = 1.96 - dd; a.position.x -= nx * pen / 2; a.position.z -= nz * pen / 2; b.position.x += nx * pen / 2; b.position.z += nz * pen / 2;
        const rv = (b.velocity.x - a.velocity.x) * nx + (b.velocity.z - a.velocity.z) * nz;
        if (rv < 0) { const j = -1.3 * rv / (2 / 1450); const pt = new THREE.Vector3((ax + bx) / 2, 0, (az + bz) / 2); a.applyImpulse(new THREE.Vector3(-nx * j, 0, -nz * j), pt); b.applyImpulse(new THREE.Vector3(nx * j, 0, nz * j), pt); } }
    }
    if (hit && !touching) { hits++; if (process.argv.includes('-v')) { let ds = racer.s - blocker.s; ds -= Math.round(ds / L) * L; console.log(`   contact t${t.toFixed(1)} s${racer.s.toFixed(0)} ds(racer-blocker)${ds.toFixed(1)} latR${racer.lateral.toFixed(1)} latB${blocker.lateral.toFixed(1)} vR${racer.ph.speedKmh.toFixed(0)} vB${blocker.ph.speedKmh.toFixed(0)} avoidR${racer.ai.avoid.toFixed(1)} avoidB${blocker.ai.avoid.toFixed(1)} kappa${(track.getCurvatureAt(racer.s)*1000).toFixed(1)}`); } } touching = hit;
    if (passedAt == null && racer.prog > blocker.prog + 10) passedAt = t;
    if (process.argv.includes('-d') && passedAt == null && Math.round(t * 120) % 60 === 0) { const d = racer.ai.debug || {}; console.log(`   t${t.toFixed(1)} s${racer.s.toFixed(0)} gap${(blocker.prog - racer.prog).toFixed(1)} latR${racer.lateral.toFixed(1)} latB${blocker.lateral.toFixed(1)} vR${racer.ph.speedKmh.toFixed(0)} vB${blocker.ph.speedKmh.toFixed(0)} tgtV${(racer.ai.targetSpeed*3.6).toFixed(0)} avT${(d.avoidTarget??0).toFixed(1)} av${racer.ai.avoid.toFixed(1)} lat[${(d.latMin??0).toFixed(1)},${(d.latMax??0).toFixed(1)}] blk${d.blockedAhead?1:0} sq${d.squeezedBehind?1:0} fol${Number.isFinite(d.followSpeed)?(d.followSpeed*3.6).toFixed(0):"-"} thr${ctl[1].throttle?.toFixed(2)} brk${ctl[1].brake?.toFixed(2)} st${ctl[1].steer?.toFixed(2)} slip${(racer.ph.slipAngle*57.3).toFixed(0)} g${racer.ph.gear} pw${blocker.ph.powerScale}`); }
    t += DT;
  }
  console.log(`${label}: passed ${passedAt != null ? 'at ' + passedAt.toFixed(1) + ' s' : 'NO'}, car contacts ${hits}, min circle sep ${minSep.toFixed(2)} m, wall contacts ${walls}, final gap ${(racer.prog - blocker.prog).toFixed(0)} m`);
}
run(40, 0.55, 'slow blocker 55% power');
run(40, 0.75, 'blocker 75% power');
run(25, 0.9, 'near-equal blocker 90%');
run(30, 0.85, 'weak driver (skill 0.55, 85%)', 0.55);
