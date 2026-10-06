// Node race simulation: 5 AI cars x N laps on the real track path (run: node dev/ai-race-test.mjs [laps] [--stub])
import * as THREE from 'three';
import { existsSync } from 'node:fs';
import { VehiclePhysics } from '../src/vehicle/physics.js';
import { AIDriver, getRacingLine } from '../src/vehicle/ai.js';
import { CONFIG } from '../src/config.js';

const args = process.argv.slice(2);
const LAPS = parseInt(args.find((a) => /^\d+$/.test(a)) || '3', 10);
const useStub = args.includes('--stub');
const solo = args.includes('--solo');
const VERBOSE = args.includes('-v');
const fromTrackJs = args.includes('--trackjs');
const specArg = args.indexOf('--spec');
const SPEC = specArg >= 0 ? JSON.parse(args[specArg + 1]) : {};
let createTrackPath;
if (!useStub && !fromTrackJs && existsSync(new URL('../src/world/trackPath.js', import.meta.url))) ({ createTrackPath } = await import('../src/world/trackPath.js'));
else ({ createTrackPath } = await import('../src/world/track.js'));

const t0 = performance.now();
const track = createTrackPath();
const tLine0 = performance.now();
const line = getRacingLine(track);
const tLine = performance.now() - tLine0;
console.log(`track length ${track.length.toFixed(1)} m, wallOffset ${track.wallOffset}, racing line ${line.N} pts in ${tLine.toFixed(1)} ms (track build ${(tLine0 - t0).toFixed(1)} ms), line limit ±${line.limit.toFixed(2)}`);
let kmax = 0; for (let i = 0; i < line.N; i++) kmax = Math.max(kmax, Math.abs(line.kap[i]));
console.log(`line min radius ${(1 / kmax).toFixed(1)} m`);

const DT = CONFIG.physics.fixedDt;
const NCARS = solo ? 1 : 5;
const skArg = args.indexOf('--skills');
const skills = skArg >= 0 ? args[skArg + 1].split(',').map(Number) : [0.92, 0.95, 0.85, 0.78, 0.72];
const cars = [];
for (let i = 0; i < NCARS; i++) {
  const ph = new VehiclePhysics(SPEC);
  const g = track.getStartGrid(i);
  ph.reset(g.position, g.heading);
  const ai = new AIDriver({ track, physics: ph, skill: skills[i], aggression: 0.3 + 0.15 * i, laneBias: (i % 2 ? 1 : -1) * 0.8, seed: i + 1 });
  const pr = track.project(ph.position);
  cars.push({ id: i, ph, ai, s: pr.s, lateral: pr.lateral, lap: 0, progress: 0, lapStart: 0, laps: [], wallHits: 0, wallFrames: 0, maxLat: 0, finished: false, recov: 0, carHits: 0, prevS: pr.s, startOffset: 0, maxSpeed: 0, nitroT: 0 });
}
// progress: laps * L + s, with s measured relative to the start line (grid is behind the line → negative)
const L = track.length;
const rel = (s) => { let d = s - track.startS; d -= Math.round(d / L) * L; return d; };
for (const c of cars) { c.progress = rel(c.s); }

const ctxCars = cars.map((c) => ({ physics: c.ph, s: c.s, lateral: c.lateral, progress: c.progress }));
let t = 0, frame = 0;
const maxT = LAPS * 120 + 30;
const halfW = CONFIG.car.collisionHalfWidth;
const tmpR = new THREE.Vector3(), tmpP = new THREE.Vector3();
let controls = cars.map(() => ({ throttle: 0, brake: 1, steer: 0 }));
const player = 0; // car 0 = "player" for rubber band reference
while (t < maxT && !cars.every((c) => c.finished)) {
  // AI at 60 Hz
  if (frame % 2 === 0) {
    for (const c of cars) {
      controls[c.id] = { ...c.ai.update(DT * 2, { raceActive: t > 0.5, selfProgress: c.progress, playerProgress: cars[player].progress, cars: ctxCars }) };
      if (c.ai.mode === 'recover' && c.lastMode !== 'recover') c.recov++;
      c.lastMode = c.ai.mode;
    }
  }
  for (const c of cars) {
    c.ph.step(DT, controls[c.id]);
    if (c.ph.nitroActive && !c.finished) c.nitroT += DT;
  }
  // walls
  for (const c of cars) {
    const pr = track.project(c.ph.position, c.s);
    c.s = pr.s; c.lateral = pr.lateral;
    const lim = track.wallOffset - halfW;
    if (!c.finished) c.maxLat = Math.max(c.maxLat, Math.abs(pr.lateral));
    if (Math.abs(pr.lateral) > lim) {
      if (!c.finished) c.wallFrames++;
      if (!c.inWall && !c.finished) { c.wallHits++; if (VERBOSE) console.log(`  t${t.toFixed(1)} car ${c.id} wall s${pr.s.toFixed(0)} lat${pr.lateral.toFixed(2)} v${c.ph.speedKmh.toFixed(0)} avoid${c.ai.avoid.toFixed(2)} mode ${c.ai.mode}`); }
      c.inWall = true;
      track.getRightAt(pr.s, tmpR);
      const sgn = Math.sign(pr.lateral);
      c.ph.position.addScaledVector(tmpR, -(Math.abs(pr.lateral) - lim) * sgn);
      const vn = c.ph.velocity.dot(tmpR) * sgn;
      if (vn > 0) c.ph.velocity.addScaledVector(tmpR, -vn * 1.3 * sgn);
      c.ph.velocity.multiplyScalar(0.995);
    } else c.inWall = false;
  }
  // car-car: 3 circles per car (front / mid / rear, r = 0.98) ≈ oriented box
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    const a = cars[i].ph, b = cars[j].ph;
    if (Math.abs(a.position.x - b.position.x) > 6 || Math.abs(a.position.z - b.position.z) > 6) { if (cars[i].touch) cars[i].touch[j] = false; continue; }
    let hit = false;
    for (const oa of [-1.55, 0, 1.55]) for (const ob of [-1.55, 0, 1.55]) {
      const ax = a.position.x + Math.sin(a.heading) * oa, az = a.position.z + Math.cos(a.heading) * oa;
      const bx = b.position.x + Math.sin(b.heading) * ob, bz = b.position.z + Math.cos(b.heading) * ob;
      const dx = bx - ax, dz = bz - az, d = Math.hypot(dx, dz);
      if (d < 1.96 && d > 1e-6) {
        hit = true;
        const nx = dx / d, nz = dz / d, pen = 1.96 - d;
        a.position.x -= nx * pen / 2; a.position.z -= nz * pen / 2; b.position.x += nx * pen / 2; b.position.z += nz * pen / 2;
        const rv = (b.velocity.x - a.velocity.x) * nx + (b.velocity.z - a.velocity.z) * nz;
        if (rv < 0) {
          const jImp = -(1 + 0.3) * rv / (1 / a.mass + 1 / b.mass);
          tmpP.set((ax + bx) / 2, 0, (az + bz) / 2);
          a.applyImpulse(new THREE.Vector3(-nx * jImp, 0, -nz * jImp), tmpP);
          b.applyImpulse(new THREE.Vector3(nx * jImp, 0, nz * jImp), tmpP);
        }
      }
    }
    if (hit && !cars[i].touch?.[j] && !cars[i].finished && !cars[j].finished) { cars[i].carHits++; cars[j].carHits++; if (VERBOSE) console.log(`  t${t.toFixed(1)} car hit ${i}-${j} s${cars[i].s.toFixed(0)}`); }
    (cars[i].touch ||= {})[j] = hit;
  }
  // progress / laps
  for (const c of cars) {
    let d = c.s - c.prevS; d -= Math.round(d / L) * L;
    c.progress += d; c.prevS = c.s;
    c.maxSpeed = Math.max(c.maxSpeed, c.ph.speedKmh);
    const lapsDone = Math.floor(c.progress / L);
    if (lapsDone > c.lap && !c.finished) {
      c.laps.push(t - c.lapStart); c.lapStart = t; c.lap = lapsDone;
      if (c.lap >= LAPS) { c.finished = true; c.finishT = t; }
    }
  }
  for (let i = 0; i < cars.length; i++) Object.assign(ctxCars[i], { s: cars[i].s, lateral: cars[i].lateral, progress: cars[i].progress });
  if (frame % 60 === 0 && t > 3) {
    const order = cars.filter((c) => !c.finished).sort((a, b) => b.progress - a.progress).map((c) => c.id).join('');
    if (globalThis.__lastOrder && order.length === globalThis.__lastOrder.length && order !== globalThis.__lastOrder) { globalThis.__overtakes = (globalThis.__overtakes || 0) + 1; if (VERBOSE) console.log(`  t${t.toFixed(1)} order ${globalThis.__lastOrder} -> ${order}`); }
    globalThis.__lastOrder = order;
  }
  t += DT; frame++;
  if (!Number.isFinite(cars[0].ph.position.x)) { console.log('NaN!'); break; }
}
const wallLim = track.wallOffset - halfW;
console.log(`\nsim ${t.toFixed(1)} s in ${((performance.now() - t0) / 1000).toFixed(2)} s wall time`);
let ok = true;
for (const c of cars) {
  const laps = c.laps.map((x) => x.toFixed(2)).join(', ');
  console.log(`car ${c.id} skill ${skills[c.id]}: laps [${laps}] finished ${c.finished ? c.finishT.toFixed(2) : 'NO'} | wall contacts ${c.wallHits} (${(c.wallFrames * DT).toFixed(2)} s) maxLat ${c.maxLat.toFixed(2)}/${wallLim.toFixed(2)} | car hits ${c.carHits} | recoveries ${c.recov} | vmax ${c.maxSpeed.toFixed(0)} km/h nitro ${c.nitroT.toFixed(1)} s`);
  if (!c.finished) ok = false;
}
console.log(`position changes: ${globalThis.__overtakes || 0}`);
console.log(ok ? 'ALL CARS FINISHED' : 'SOME CARS DID NOT FINISH');
