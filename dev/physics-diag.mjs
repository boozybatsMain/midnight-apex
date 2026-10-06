import * as THREE from 'three';
import { VehiclePhysics } from '../src/vehicle/physics.js';
const DT=1/120;
for (const kmh of [100,160,220]) for (const steer of [0.15,0.3,0.6,1]) for (const mode of ['hold','coast']) {
  const p = new VehiclePhysics(); p.reset(new THREE.Vector3(),0);
  p.velocity.set(0,0,kmh/3.6); p.syncGear();
  let out='';
  for (let i=0;i<120*4;i++){
    const err = kmh/3.6 - p.speed;
    const thr = mode==='hold'? Math.max(0,Math.min(1,err*0.5+0.3)) : 0;
    p.step(DT,{throttle:thr,brake:0,steer});
    if (i===120*2 || i===120*4-1) out += ` | t${(i/120).toFixed(1)} v${p.speedKmh.toFixed(0)} g${p.gLat.toFixed(2)} aF${(p.frontSlip*57.3).toFixed(1)} aR${(p.rearSlip*57.3).toFixed(1)} beta${(p.slipAngle*57.3).toFixed(1)} d${(p.steerAngle*57.3).toFixed(1)} thr${p.throttle.toFixed(2)} gear${p.gear}`;
  }
  console.log(kmh, steer, mode, out);
}
