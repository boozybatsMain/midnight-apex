// Drift scenarios (node dev/drift-tune.mjs '{"driftThrottleRelief":0.3}')
import * as THREE from 'three';
import { VehiclePhysics } from '../src/vehicle/physics.js';
const SPEC = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const DT = 1 / 120;
const f1 = (v) => v.toFixed(0).padStart(4);
function run(name, v0, phases) {
  const p = new VehiclePhysics(SPEC); p.reset(new THREE.Vector3(), 0);
  p.velocity.set(0, 0, v0 / 3.6); p.syncGear();
  let t = 0, out = [], heading0 = p.heading;
  for (const [dur, c] of phases) {
    for (let e = 0; e < dur - 1e-9; e += DT, t += DT) {
      p.step(DT, { throttle: 0, brake: 0, steer: 0, ...c });
      if (Math.round(t * 120) % 30 === 0) out.push(`${f1(p.slipAngle * 57.3)}°/${f1(p.speedKmh)}`);
    }
  }
  console.log(`${name.padEnd(28)} turn ${f1((p.heading - heading0) * 57.3)}° | ` + out.join(' '));
}
run('hb drift hold steer 1', 110, [[0.35, { throttle: 0.5, steer: 1, handbrake: true }], [3, { throttle: 1, steer: 1 }], [2, { throttle: 0.6 }]]);
run('hb drift hold steer 0.6', 110, [[0.35, { throttle: 0.5, steer: 1, handbrake: true }], [3, { throttle: 1, steer: 0.6 }], [2, { throttle: 0.6 }]]);
run('hb drift hold steer 0.3', 110, [[0.35, { throttle: 0.5, steer: 1, handbrake: true }], [3, { throttle: 1, steer: 0.3 }], [2, { throttle: 0.6 }]]);
run('hb drift countersteer', 110, [[0.35, { throttle: 0.5, steer: 1, handbrake: true }], [3, { throttle: 1, steer: -0.5 }], [2, { throttle: 0.6 }]]);
run('hb drift lift', 110, [[0.35, { throttle: 0.5, steer: 1, handbrake: true }], [3, { throttle: 0, steer: 0.6 }]]);
run('hb 160 drift steer 0.7', 160, [[0.3, { throttle: 0.5, steer: 1, handbrake: true }], [3, { throttle: 1, steer: 0.7 }], [2, { throttle: 0.6 }]]);
run('brake-tap 140 steer 1', 140, [[0.4, { brake: 1, steer: 1 }], [3, { throttle: 1, steer: 1 }], [2, { throttle: 0.6 }]]);
run('power oversteer 40', 40, [[3, { throttle: 1, steer: 1 }], [2, { throttle: 0.5 }]]);
run('grip turn 100 steer1 thr', 100, [[3, { throttle: 1, steer: 1 }]]);
run('lift mid corner 120', 120, [[1.5, { throttle: 0.6, steer: 0.8 }], [2, { throttle: 0, steer: 0.8 }]]);
run('slalom 150', 150, [[0.6, { throttle: 1, steer: 1 }], [0.6, { throttle: 1, steer: -1 }], [0.6, { throttle: 1, steer: 1 }], [0.6, { throttle: 1, steer: -1 }], [2, { throttle: 1 }]]);
