// MIDNIGHT APEX — streetlights along the circuit: instanced poles + luminaires, emissive lenses,
// camera-facing glow halos (rain scattering) and faint volumetric light cones. The lamps sit exactly
// where the road shader's analytic light pools expect them (track.lamps / track.lampGeometry).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { lampIntensity } from './track.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Pole geometry in a local frame: base at origin, arm toward +X, lens bottom at (armLen, headH). */
function poleGeometry(armLen, headH) {
  const parts = [];
  const height = headH + 0.3;
  const pole = new THREE.CylinderGeometry(0.075, 0.13, height, 10, 1);
  pole.translate(0, height / 2, 0);
  parts.push(pole);
  const plinth = new THREE.CylinderGeometry(0.2, 0.24, 0.6, 10);
  plinth.translate(0, 0.3, 0);
  parts.push(plinth);
  const arm = new THREE.CylinderGeometry(0.05, 0.06, armLen, 8);
  arm.rotateZ(Math.PI / 2);
  arm.translate(armLen / 2, headH + 0.24, 0);
  parts.push(arm);
  // luminaire housing (flat LED / cobra head)
  const head = new THREE.BoxGeometry(0.95, 0.16, 0.42);
  head.translate(armLen - 0.1, headH + 0.1, 0);
  parts.push(head);
  return mergeGeometries(parts);
}

export function haloMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aColor; // rgb, size
      varying vec3 vColor;
      varying vec2 vP;
      void main() {
        vec3 center = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 toCam = normalize(cameraPosition - center);
        center += toCam * 0.9; // pull toward the camera so the housing does not clip the glow
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        float size = aColor.a;
        vec3 wp = center + (right * position.x + up * position.y) * size;
        vP = position.xy * 2.0;
        vColor = aColor.rgb;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying vec2 vP;
      void main() {
        float r2 = dot(vP, vP);
        float core = exp(-r2 * 40.0) * 2.0;
        float halo = exp(-r2 * 6.0) * 0.22 + exp(-r2 * 2.0) * 0.05;
        float a = (core + halo) * (1.0 - smoothstep(0.8, 1.0, sqrt(r2)));
        gl_FragColor = vec4(vColor * a, 1.0);
      }`,
  });
}

function coneMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: uniforms.uTime, uRain: uniforms.uRain },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      varying vec3 vColor;
      varying float vY;
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vW;
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vY = uv.y;
        vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        vColor = aColor;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uRain;
      varying vec3 vColor;
      varying float vY;
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vW;
      void main() {
        float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
        float along = pow(vY, 1.4);                  // brighter near the luminaire (uv.y = 1 at top)
        float streaks = 0.75 + 0.25 * sin(vW.x * 9.0 + vW.z * 7.0 + uTime * 30.0 + vW.y * 2.0);
        float a = edge * along * streaks * 0.05 * (0.4 + 0.6 * uRain);
        gl_FragColor = vec4(vColor * a, 1.0);
      }`,
  });
}

export function createLamps({ track, shared, quality = 'high', extraLights = [] } = {}) {
  const group = new THREE.Group();
  group.name = 'streetlights';
  const { lateral: headU, height: headH, poleLateral: poleU } = track.lampGeometry;
  const armLen = poleU - headU;
  const posts = [];
  const p = new THREE.Vector3(), r = new THREE.Vector3();
  for (const l of track.lamps) {
    for (const side of [-1, 1]) {
      if (!(side < 0 ? l.left : l.right)) continue;
      track.getPointAt(l.s, p);
      track.getRightAt(l.s, r);
      const base = p.clone().addScaledVector(r, side * poleU);
      const dir = r.clone().multiplyScalar(-side); // toward the road
      const head = p.clone().addScaledVector(r, side * headU);
      head.y = headH;
      const c = new THREE.Color(l.color[0], l.color[1], l.color[2]);
      posts.push({ base, dir, head, color: c, intensity: lampIntensity(l.kind) });
    }
  }
  // extra lamps (overpass, promenade…) supplied by the environment: { base, dir, head, color, intensity, armLen, height }
  for (const e of extraLights) posts.push(e);

  const count = posts.length;
  const poleGeo = poleGeometry(armLen, headH);
  const metal = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.45, metalness: 0.7 });
  const poles = new THREE.InstancedMesh(poleGeo, metal, count);
  poles.castShadow = true;
  poles.receiveShadow = false;
  poles.name = 'lampPoles';

  const lensGeo = new THREE.PlaneGeometry(0.82, 0.32).rotateX(Math.PI / 2); // faces down
  const lensMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(14, 14, 14) });
  const lenses = new THREE.InstancedMesh(lensGeo, lensMat, count);
  lenses.name = 'lampLenses';

  const haloGeo = new THREE.PlaneGeometry(1, 1);
  const halos = new THREE.InstancedMesh(haloGeo, haloMaterial(), count);
  halos.name = 'lampHalos';
  halos.frustumCulled = false;
  const haloAttr = new Float32Array(count * 4);

  const coneH = headH - 0.05;
  const coneGeo = new THREE.CylinderGeometry(0.35, 6.2, coneH, 20, 1, true);
  coneGeo.translate(0, -coneH / 2, 0); // apex at the luminaire, base on the ground
  const cones = quality === 'low' ? null : new THREE.InstancedMesh(coneGeo, coneMaterial(shared.uniforms), count);
  const coneAttr = new Float32Array(count * 3);

  posts.forEach((P, i) => {
    const yaw = Math.atan2(-P.dir.z, P.dir.x);
    _q.setFromAxisAngle(UP, yaw);
    _m.compose(P.base, _q, _s);
    poles.setMatrixAt(i, _m);
    _p.copy(P.head).addScaledVector(P.dir, -0.1);
    _p.y = P.head.y + 0.015;
    _m.compose(_p, _q, _s);
    lenses.setMatrixAt(i, _m);
    const k = (P.intensity || 150) / 150;
    lenses.setColorAt(i, P.color.clone().multiplyScalar(k));
    _m.compose(_p, _q, _s);
    halos.setMatrixAt(i, _m);
    haloAttr.set([P.color.r * 1.5 * k, P.color.g * 1.5 * k, P.color.b * 1.5 * k, 3.6], i * 4);
    if (cones) {
      _m.compose(_p, _q, _s);
      cones.setMatrixAt(i, _m);
      coneAttr.set([P.color.r * k, P.color.g * k, P.color.b * k], i * 3);
    }
  });
  poles.instanceMatrix.needsUpdate = true;
  lenses.instanceMatrix.needsUpdate = true;
  halos.instanceMatrix.needsUpdate = true;
  halos.geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(haloAttr, 4));
  group.add(poles, lenses, halos);
  if (cones) {
    cones.instanceMatrix.needsUpdate = true;
    cones.geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(coneAttr, 3));
    cones.frustumCulled = false;
    cones.name = 'lampCones';
    group.add(cones);
  }
  poles.computeBoundingSphere();
  lenses.computeBoundingSphere();
  return { group, posts, poles, lenses, halos, cones, smallStuff: cones ? [cones] : [] };
}
