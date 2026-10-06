import { VehiclePhysics } from '../src/vehicle/physics.js';
import { AIDriver, getRacingLine } from '../src/vehicle/ai.js';
import { createTrackPath } from '../src/world/track.js';
const track = createTrackPath();
let t0 = performance.now(); getRacingLine(track); console.log('racing line build ms', (performance.now() - t0).toFixed(1));
const ph = new VehiclePhysics(); const g = track.getStartGrid(0); ph.reset(g.position, g.heading);
const ai = new AIDriver({ track, physics: ph, skill: 0.9 });
t0 = performance.now(); ai.update(1 / 60, { raceActive: true, cars: [] }); console.log('first AI update (speed plan) ms', (performance.now() - t0).toFixed(2));
const cars = [{ physics: ph, s: 0, lateral: 0, progress: 0 }];
for (let i = 0; i < 4; i++) { const p = new VehiclePhysics(); p.reset(track.getStartGrid(i + 1).position, 0); cars.push({ physics: p, s: 0, lateral: 0, progress: 0 }); }
let c = {}; const N = 120 * 60;
let tp = 0, ta = 0;
for (let i = 0; i < N; i++) {
  let a = performance.now();
  if (i % 2 === 0) c = ai.update(1 / 60, { raceActive: true, cars, selfProgress: 0, playerProgress: 0 });
  let b = performance.now(); ph.step(1 / 120, c); let e = performance.now();
  ta += b - a; tp += e - b;
}
console.log(`physics.step avg ${(tp / N * 1000).toFixed(2)} µs, ai.update avg ${(ta / (N / 2) * 1000).toFixed(2)} µs`);
console.log(`per frame @60fps with 5 cars (2 steps each + 1 AI each): ${((tp / N * 2 + ta / (N / 2)) * 5).toFixed(3)} ms`);
