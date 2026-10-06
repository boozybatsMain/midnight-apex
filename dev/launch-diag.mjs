import * as THREE from 'three';
import { VehiclePhysics } from '../src/vehicle/physics.js';
const p = new VehiclePhysics(); p.reset(new THREE.Vector3(), 0);
let t = 0, lim = 0;
for (let i = 0; i < 120 * 4; i++) {
  p.step(1 / 120, { throttle: 1 }); t += 1 / 120;
  if (p.onLimiter) lim += 1 / 120;
  if (i % 24 === 0) console.log(`t${t.toFixed(2)} v${p.speedKmh.toFixed(1)} rpm${p.rpm.toFixed(0)} g${p.gear} spin${p.wheelspin.toFixed(2)} lim${p.onLimiter ? 1 : 0} gLong${p.gLong.toFixed(2)} skidR${p.skid.rl.toFixed(2)} shifting${p.shifting ? 1 : 0}`);
}
console.log('limiter time', lim.toFixed(2));
