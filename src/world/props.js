// MIDNIGHT APEX — street furniture & set dressing:
//   traffic signals at the junction crosswalks (animated, instanced), an elevated highway crossing the
//   circuit (piers, deck, parapets, deck lamps, moving traffic lights), the waterfront quay with railing
//   and promenade lamps, bus shelters with lit ads, small props (hydrants, bins, bollards, newspaper
//   boxes), manhole steam plumes and blinking aircraft-warning beacons on the towers.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, tileableFbm, normalizeField } from './textures.js';
import { lampIntensity } from './track.js';
import { haloMaterial } from './lamps.js';

const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);

function colored(geo, color) {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (geo.index) geo = geo.toNonIndexed();
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  return geo;
}

/** Place a local-space geometry at (x, y, z) with yaw (rotation about Y). */
function placed(geo, x, y, z, yaw = 0) {
  const g = geo.clone();
  _q.setFromAxisAngle(UP, yaw);
  _m.compose(new THREE.Vector3(x, y, z), _q, _s);
  g.applyMatrix4(_m);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Traffic signals
// ---------------------------------------------------------------------------------------------

function signalLampMaterial(timeU) {
  return new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uTime: timeU },
    fog: true,
    vertexShader: /* glsl */ `
      attribute vec2 aSig; // lamp (0 red, 1 amber, 2 green), phase offset
      varying vec2 vSig;
      varying vec2 vUv;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vSig = aSig; vUv = uv;
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vSig;
      varying vec2 vUv;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        if (r > 1.0) discard;
        float t = mod(uTime + vSig.y, 22.0);
        float state = t < 10.0 ? 2.0 : t < 13.0 ? 1.0 : 0.0; // green → amber → red
        float on = step(abs(vSig.x - state), 0.1);
        vec3 col = vSig.x < 0.5 ? vec3(1.0, 0.06, 0.03) : vSig.x < 1.5 ? vec3(1.0, 0.55, 0.02) : vec3(0.05, 1.0, 0.45);
        float lens = 1.0 - smoothstep(0.75, 1.0, r);
        vec3 c = col * mix(0.035, 9.0, on) * (0.6 + 0.4 * lens);
        gl_FragColor = vec4(c, 1.0);
        #include <fog_fragment>
      }`,
  });
}

function buildTrafficSignals(track, timeU, rnd) {
  const W = track.wallOffset;
  const poleParts = [];
  const heads = []; // { pos: Vector3, yaw }
  const p = new THREE.Vector3(), t = new THREE.Vector3(), r = new THREE.Vector3();
  const mastLocal = (() => {
    // local frame: +X toward the road center, base at origin
    const parts = [];
    const pole = new THREE.CylinderGeometry(0.11, 0.15, 7.2, 10); pole.translate(0, 3.6, 0); parts.push(pole);
    const base = new THREE.CylinderGeometry(0.28, 0.32, 0.5, 10); base.translate(0, 0.25, 0); parts.push(base);
    const arm = new THREE.CylinderGeometry(0.07, 0.1, 9.6, 8); arm.rotateZ(Math.PI / 2); arm.translate(4.8, 6.9, 0); parts.push(arm);
    const brace = new THREE.CylinderGeometry(0.04, 0.04, 3.2, 6); brace.rotateZ(Math.PI / 2 - 0.42); brace.translate(1.45, 6.25, 0); parts.push(brace);
    const box = new THREE.BoxGeometry(0.3, 0.45, 0.25); box.translate(0, 2.8, 0.18); parts.push(box); // pedestrian push box
    return mergeGeometries(parts);
  })();
  const housing = new THREE.BoxGeometry(0.42, 1.12, 0.32);
  for (const sc of track.features.crosswalks) {
    for (const dir of [1, -1]) {
      // dir 1: signals for race direction, pole on the right before the crosswalk; dir −1 on the left after it
      const s = sc - dir * 5.5;
      track.getPointAt(s, p); track.getTangentAt(s, t); track.getRightAt(s, r);
      const side = dir; // +1 right, −1 left
      const base = p.clone().addScaledVector(r, side * (W + 2.4));
      const towardCenter = r.clone().multiplyScalar(-side);
      const yaw = Math.atan2(-towardCenter.z, towardCenter.x);
      poleParts.push(placed(mastLocal, base.x, 0, base.z, yaw));
      // facing oncoming traffic of that direction: normal = −dir·tangent
      const face = t.clone().multiplyScalar(-dir);
      const fyaw = Math.atan2(face.x, face.z);
      for (const off of [4.4, 8.4]) {
        const hp = base.clone().addScaledVector(towardCenter, off); hp.y = 6.25;
        heads.push({ pos: hp, yaw: fyaw, phase: (sc * 0.37) % 22 + (dir > 0 ? 0 : 11) });
      }
      // a pedestrian head on the pole
      const pp = base.clone().addScaledVector(face, 0.25); pp.y = 3.6;
      heads.push({ pos: pp, yaw: fyaw, phase: (sc * 0.37) % 22 + (dir > 0 ? 0 : 11), small: true });
    }
  }
  const group = new THREE.Group();
  group.name = 'trafficSignals';
  if (!poleParts.length) return group;
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.6 });
  const poles = new THREE.Mesh(mergeGeometries(poleParts), metal);
  poles.castShadow = true;
  group.add(poles);
  const hMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.6, metalness: 0.3 });
  const housings = new THREE.InstancedMesh(housing, hMat, heads.length);
  const lampGeo = new THREE.PlaneGeometry(0.26, 0.26);
  const lamps = new THREE.InstancedMesh(lampGeo, signalLampMaterial(timeU), heads.length * 3);
  const sig = new Float32Array(heads.length * 3 * 2);
  heads.forEach((h, i) => {
    _q.setFromAxisAngle(UP, h.yaw);
    const sc = h.small ? 0.6 : 1;
    _m.compose(h.pos, _q, new THREE.Vector3(sc, sc, sc));
    housings.setMatrixAt(i, _m);
    const fwd = new THREE.Vector3(Math.sin(h.yaw), 0, Math.cos(h.yaw));
    for (let k = 0; k < 3; k++) {
      const lp = h.pos.clone().addScaledVector(fwd, 0.165 * sc);
      lp.y += (0.34 - k * 0.34) * sc;
      _m.compose(lp, _q, new THREE.Vector3(sc, sc, sc));
      lamps.setMatrixAt(i * 3 + k, _m);
      sig[(i * 3 + k) * 2] = k; // 0 top = red, 1 amber, 2 bottom = green
      sig[(i * 3 + k) * 2 + 1] = h.phase;
    }
  });
  lamps.geometry.setAttribute('aSig', new THREE.InstancedBufferAttribute(sig, 2));
  housings.instanceMatrix.needsUpdate = true;
  lamps.instanceMatrix.needsUpdate = true;
  housings.castShadow = true;
  housings.computeBoundingSphere();
  lamps.computeBoundingSphere();
  group.add(housings, lamps);
  return group;
}

// ---------------------------------------------------------------------------------------------
// Elevated highway
// ---------------------------------------------------------------------------------------------

function buildOverpass(track, timeU, rnd) {
  const ov = track.features.overpass;
  const X = ov.x, HW = ov.width / 2, DECK0 = ov.height, DECK1 = ov.height + 1.5;
  const Z0 = -1500, Z1 = 2600;
  const parts = [];
  const box = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); parts.push(g); };
  const L = Z1 - Z0;
  // deck (split in segments for culling-friendly bounding volumes later) + parapets
  box(ov.width, DECK1 - DECK0, L, X, (DECK0 + DECK1) / 2, (Z0 + Z1) / 2);
  box(0.35, 1.05, L, X - HW + 0.175, DECK1 + 0.52, (Z0 + Z1) / 2);
  box(0.35, 1.05, L, X + HW - 0.175, DECK1 + 0.52, (Z0 + Z1) / 2);
  box(0.4, 0.5, L, X, DECK1 + 0.25, (Z0 + Z1) / 2); // median
  // girders under the deck
  box(1.0, 0.9, L, X - HW * 0.55, DECK0 - 0.45, (Z0 + Z1) / 2);
  box(1.0, 0.9, L, X + HW * 0.55, DECK0 - 0.45, (Z0 + Z1) / 2);
  // piers: avoid the circuit corridor
  const W = track.wallOffset;
  const piers = [];
  for (let z = Z0 + 20; z < Z1; z += 38) {
    const pr = track.project({ x: X, z });
    if (pr.distance < W + 7) continue;
    const water = track.features.isWater(X, z);
    const h = DECK0 - 0.9 + (water ? 1.3 : 0);
    const y0 = water ? -1.3 : 0;
    box(2.4, h, 2.4, X, y0 + h / 2, z);
    box(ov.width * 0.95, 1.3, 2.6, X, DECK0 - 1.55, z);
    piers.push(z);
  }
  // sodium fixtures under the deck (two rows), emissive
  const fixtures = [];
  for (let z = Z0 + 6; z < Z1; z += 12) {
    for (const x of [X - HW * 0.25, X + HW * 0.25]) {
      const g = new THREE.BoxGeometry(0.5, 0.12, 1.2); g.translate(x, DECK0 - 0.06, z); fixtures.push(g);
    }
  }
  const fixMesh = new THREE.Mesh(mergeGeometries(fixtures), new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 4.6, 1.4) }));
  fixMesh.name = 'overpassFixtures';
  const geo = mergeGeometries(parts);
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.8, metalness: 0.0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'overpass';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // deck lamps (fed to the streetlight system)
  const extraLights = [];
  const lampH = track.lampGeometry.height;
  const arm = track.lampGeometry.poleLateral - track.lampGeometry.lateral;
  let k = 0;
  for (let z = Z0 + 15; z < Z1; z += 42, k++) {
    const side = k % 2 ? 1 : -1;
    const bx = X + side * (HW - 0.3);
    const base = new THREE.Vector3(bx, DECK1, z);
    const dir = new THREE.Vector3(-side, 0, 0);
    const head = base.clone().addScaledVector(dir, arm); head.y = DECK1 + lampH;
    extraLights.push({ base, dir, head, color: new THREE.Color(1.0, 0.56, 0.2), intensity: 175 });
  }
  // moving traffic: headlight / taillight pairs as glowing sprites
  const n = 70;
  const traffic = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), trafficMaterial(timeU), n);
  const attr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const dirSign = i % 2 ? 1 : -1;
    const lane = dirSign * (2.0 + (rnd() < 0.5 ? 0 : 3.6));
    attr.set([X + lane, dirSign * (12 + rnd() * 9), rnd() * L, rnd()], i * 4);
    traffic.setMatrixAt(i, _m.identity());
  }
  traffic.geometry.setAttribute('aCar', new THREE.InstancedBufferAttribute(attr, 4));
  traffic.material.uniforms.uRange.value.set(Z0, L, DECK1 + 0.75);
  traffic.frustumCulled = false;
  traffic.name = 'overpassTraffic';
  const group = new THREE.Group();
  group.name = 'overpass';
  group.add(mesh, traffic, fixMesh);
  return { group, extraLights, traffic };
}

function trafficMaterial(timeU) {
  return new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uTime: timeU, uRange: { value: new THREE.Vector3() } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
    vertexShader: /* glsl */ `
      attribute vec4 aCar; // x, speed (signed), z phase, seed
      uniform float uTime;
      uniform vec3 uRange; // z0, length, y
      varying vec2 vP;
      varying vec3 vCol;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        float z = uRange.x + mod(aCar.z + uTime * aCar.y, uRange.y);
        // each instance draws one car: two lights seen from the front (white) or back (red)
        vec3 center = vec3(aCar.x, uRange.z, z);
        vec3 toCam = cameraPosition - center;
        float facing = sign(aCar.y) * sign(toCam.z); // > 0 → we see its front
        vCol = facing > 0.0 ? vec3(1.0, 0.95, 0.85) * 3.0 : vec3(1.0, 0.05, 0.02) * 2.2;
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 wp = center + right * position.x * 2.2 + up * position.y * 0.7;
        vP = position.xy * vec2(2.2, 0.7);
        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vP;
      varying vec3 vCol;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        float a = exp(-dot(vP - vec2(-0.75, 0.0), vP - vec2(-0.75, 0.0)) * 18.0) + exp(-dot(vP - vec2(0.75, 0.0), vP - vec2(0.75, 0.0)) * 18.0);
        gl_FragColor = vec4(vCol * a, 1.0);
        #ifdef USE_FOG
          float fogFactor = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);
          gl_FragColor.rgb *= 1.0 - fogFactor * 0.8;
        #endif
      }`,
  });
}

// ---------------------------------------------------------------------------------------------
// Waterfront: quay wall + railing + promenade lamps
// ---------------------------------------------------------------------------------------------

function buildWaterfront(track, rnd) {
  const shoreZ = track.features.shoreZ;
  const verts = [], idx = [];
  const X0 = -1400, X1 = 1600, STEP = 4;
  let n = 0;
  for (let x = X0; x <= X1; x += STEP) {
    const z = shoreZ(x);
    verts.push(x, 0.0, z, x, -1.4, z);
    if (n > 0) { const b = (n - 1) * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    n++;
  }
  const wallGeo = new THREE.BufferGeometry();
  wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  wallGeo.setIndex(idx);
  wallGeo.computeVertexNormals();
  // railing: posts + two rails, merged with vertex colours
  const parts = [colored(wallGeo, 0x2b2b2e)];
  const post = new THREE.BoxGeometry(0.08, 1.1, 0.08); post.translate(0, 0.55, 0);
  const postC = colored(post, 0x1c1e22);
  const railParts = [];
  for (let x = X0; x <= X1; x += 2.5) {
    const z = shoreZ(x) - 0.6;
    if (track.project({ x, z }).distance < track.wallOffset + 10) continue;
    railParts.push(placed(postC, x, 0, z));
  }
  for (let x = X0; x < X1; x += 10) {
    const z0 = shoreZ(x) - 0.6, z1 = shoreZ(x + 10) - 0.6;
    const len = Math.hypot(10, z1 - z0);
    const yaw = Math.atan2(10, z1 - z0) - Math.PI / 2;
    for (const y of [1.05, 0.55]) {
      const rail = new THREE.BoxGeometry(len, 0.06, 0.06);
      railParts.push(placed(colored(rail, 0x30333a), x + 5, y, (z0 + z1) / 2, yaw));
    }
  }
  const geo = mergeGeometries(parts.concat(railParts));
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.4 }));
  mesh.name = 'waterfront';
  mesh.receiveShadow = true;
  // promenade globe lamps
  const lampPos = [];
  for (let x = X0 + 10; x < X1; x += 24) {
    const z = shoreZ(x) - 3.5;
    if (track.project({ x, z }).distance < track.wallOffset + 8) continue;
    lampPos.push(new THREE.Vector3(x, 0, z));
  }
  return { mesh, lampPos };
}

// ---------------------------------------------------------------------------------------------
// Small props, bus shelters
// ---------------------------------------------------------------------------------------------

function buildStreetFurniture(track, rnd, timeU) {
  const W = track.wallOffset;
  const L = track.length;
  const feat = track.features;
  const parts = [];
  const p = new THREE.Vector3(), t = new THREE.Vector3(), r = new THREE.Vector3();
  const lampNear = (s) => {
    const k = Math.round(s / track.lampSpacing - 0.5);
    const ls = (k + 0.5) * track.lampSpacing;
    return Math.abs(ls - s) < 3.0;
  };
  const crossNear = (s) => feat.crosswalks.some((c) => Math.abs(((s - c + L * 1.5) % L) - L / 2) < 9);
  const okAt = (s, side) => !feat.inMouth(s, side, 3) && !lampNear(s) && !crossNear(s) && Math.min(s, L - s) > 25;
  const lateralOf = (u) => W + 0.6 + u; // on the sidewalk (starts at 9.8)

  // prop prototypes (local: +Z faces the road)
  const hydrant = (() => {
    const a = new THREE.CylinderGeometry(0.14, 0.16, 0.6, 10); a.translate(0, 0.3, 0);
    const b = new THREE.SphereGeometry(0.15, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2); b.translate(0, 0.6, 0);
    const c = new THREE.CylinderGeometry(0.05, 0.05, 0.42, 6); c.rotateZ(Math.PI / 2); c.translate(0, 0.42, 0);
    return mergeGeometries([colored(a, 0xb81d12), colored(b, 0xb81d12), colored(c, 0x8a8a8a)]);
  })();
  const bin = (() => {
    const a = new THREE.CylinderGeometry(0.3, 0.27, 0.95, 12, 1, false); a.translate(0, 0.475, 0);
    const b = new THREE.CylinderGeometry(0.33, 0.33, 0.06, 12); b.translate(0, 0.97, 0);
    return mergeGeometries([colored(a, 0x1f3326), colored(b, 0x111111)]);
  })();
  const newsbox = (() => {
    const a = new THREE.BoxGeometry(0.5, 1.0, 0.45); a.translate(0, 0.5, 0);
    return colored(a, 0x1652a8);
  })();
  const bollard = (() => {
    const a = new THREE.CylinderGeometry(0.09, 0.1, 0.9, 8); a.translate(0, 0.45, 0);
    const b = new THREE.CylinderGeometry(0.095, 0.095, 0.08, 8); b.translate(0, 0.75, 0);
    return mergeGeometries([colored(a, 0x2b2b2b), colored(b, 0xd8c020)]);
  })();
  const dumpster = (() => {
    const a = new THREE.BoxGeometry(1.9, 1.2, 1.1); a.translate(0, 0.65, 0);
    const b = new THREE.BoxGeometry(1.95, 0.08, 1.2); b.rotateX(-0.12); b.translate(0, 1.3, -0.05);
    return mergeGeometries([colored(a, 0x234a2a), colored(b, 0x1b3a20)]);
  })();
  const protos = [hydrant, bin, newsbox, bollard, dumpster];
  const weights = [0.24, 0.3, 0.16, 0.18, 0.12];
  for (const side of [-1, 1]) {
    let s = 20 + rnd() * 10;
    while (s < L - 20) {
      s += 9 + rnd() * 22;
      if (!okAt(s, side)) continue;
      let q = rnd(), k = 0;
      while (k < weights.length - 1 && q > weights[k]) { q -= weights[k]; k++; }
      track.getPointAt(s, p); track.getRightAt(s, r);
      const lat = protos[k] === dumpster ? 13.6 : lateralOf(rnd() < 0.5 ? 0.9 : 3.6);
      const pos = p.clone().addScaledVector(r, side * lat);
      const n = r.clone().multiplyScalar(-side);
      parts.push(placed(protos[k], pos.x, 0.15, pos.z, Math.atan2(n.x, n.z)));
    }
  }
  // bus shelters (frame + glass + lit ad panel)
  const shelterFrame = [], shelterGlass = [], adPanels = [];
  let shelters = 0;
  for (let s = 140; s < L - 60 && shelters < 9; s += 260 + rnd() * 120) {
    const side = rnd() < 0.5 ? 1 : -1;
    if (!okAt(s, side) || !okAt(s + 3, side) || !okAt(s - 3, side)) continue;
    track.getPointAt(s, p); track.getRightAt(s, r); track.getTangentAt(s, t);
    const base = p.clone().addScaledVector(r, side * 13.2);
    const n = r.clone().multiplyScalar(-side);
    const yaw = Math.atan2(n.x, n.z);
    const local = [];
    const bx = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); local.push(g); };
    bx(4.2, 0.1, 1.7, 0, 2.55, 0.1); // roof
    for (const x of [-2.0, 2.0]) for (const z of [-0.65, 0.75]) bx(0.07, 2.5, 0.07, x, 1.4, z);
    bx(3.2, 0.08, 0.45, 0, 0.6, -0.4); // bench
    for (const g of local) shelterFrame.push(placed(colored(g, 0x2a2c30), base.x, 0.15, base.z, yaw));
    const glass = new THREE.BoxGeometry(4.0, 2.0, 0.03); glass.translate(0, 1.35, -0.68);
    shelterGlass.push(placed(glass, base.x, 0.15, base.z, yaw));
    const ad = new THREE.PlaneGeometry(1.25, 1.9);
    ad.rotateY(Math.PI / 2); ad.translate(2.04, 1.35, 0.05);
    const adBack = new THREE.PlaneGeometry(1.25, 1.9);
    adBack.rotateY(-Math.PI / 2); adBack.translate(1.96, 1.35, 0.05);
    const k = shelters % 6;
    for (const g of [ad, adBack]) {
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, ((k % 3) + uv.getX(i)) / 3, (1 - Math.floor(k / 3) + uv.getY(i)) / 2);
      adPanels.push(placed(g, base.x, 0.15, base.z, yaw));
    }
    shelters++;
  }
  const group = new THREE.Group();
  group.name = 'streetFurniture';
  const vmat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.35 });
  if (parts.length || shelterFrame.length) {
    const m = new THREE.Mesh(mergeGeometries(parts.concat(shelterFrame)), vmat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = 'smallProps';
    group.add(m);
  }
  if (shelterGlass.length) {
    const gm = new THREE.Mesh(mergeGeometries(shelterGlass), new THREE.MeshStandardMaterial({ color: 0x0c1418, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.35 }));
    gm.name = 'shelterGlass';
    group.add(gm);
  }
  return { group, adPanels };
}

// ---------------------------------------------------------------------------------------------
// Steam plumes from manholes
// ---------------------------------------------------------------------------------------------
//
// Thin, wispy vapour rather than opaque white sprites: each puff is a camera-facing quad whose density is
// a scrolling tileable fBm (two octaves, counter-scrolling) under a soft radial mask, thinning out as it
// expands. Steam has no colour of its own at night — it is LIT: every vent gets a baked light colour at the
// base and at head height from the streetlights around it (same lamps / intensities as the road pools)
// plus a tint from the nearest neon, so plumes glow sodium-orange, LED-white or magenta depending on where
// they are. Puffs fade out before they reach the camera (driving through a plume never whites out the
// screen) and are collapsed in the vertex shader once fully faded, so they cost nothing up close.

function steamNoiseTexture() {
  const N = 128;
  const a = normalizeField(tileableFbm(N, 4, 4, 77, 0.55));
  const b = normalizeField(tileableFbm(N, 9, 3, 191, 0.5));
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = Math.round(a[i] * 255);
    data[i * 4 + 1] = Math.round(b[i] * 255);
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function steamMaterial(timeU) {
  return new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uTime: timeU, uNoise: { value: steamNoiseTexture() } },
    transparent: true,
    depthWrite: false,
    fog: true,
    vertexShader: /* glsl */ `
      attribute vec4 aPuff;   // base x, base z, phase, seed
      attribute vec3 aLitLo;  // baked light colour at the vent (radiance per unit density)
      attribute vec3 aLitHi;  // … at ~7 m
      attribute vec2 aWind;   // drift direction (xz)
      uniform float uTime;
      varying vec2 vUv;
      varying vec4 vP;        // x = alpha, y = seed, z = phase, w = world y
      varying vec3 vCol;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        float seed = aPuff.w;
        float ph = fract(uTime * (0.13 + 0.05 * seed) + aPuff.z);
        // fast jet out of the grate that slows as it cools, then drifts with the wind
        float rise = 7.0 * (1.0 - pow(1.0 - ph, 1.8));
        vec3 c = vec3(aPuff.x, 0.2 + rise, aPuff.y);
        float sway = sin(uTime * 0.6 + seed * 6.3) * 0.45 + sin(uTime * 1.7 + seed * 2.1) * 0.15;
        c.xz += aWind * (ph * ph * 3.0 + sway * ph) + vec2(seed - 0.5, fract(seed * 7.13) - 0.5) * 0.6 * ph;
        float size = 0.45 + ph * 4.2;
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        float rot = seed * 6.28 + uTime * 0.25 * (seed - 0.5);
        vec2 q = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * position.xy;
        vec3 wp = c + (right * q.x + up * q.y) * size;
        // density: born thin, densest just above the grate, thinning as the puff expands and cools
        float a = smoothstep(0.0, 0.08, ph) * pow(1.0 - ph, 1.3) * (0.9 / (0.9 + ph * 2.0));
        // fade before the camera reaches the puff (no white-out when driving through) …
        vec4 cv = viewMatrix * vec4(c, 1.0);
        float dist = -cv.z;
        a *= smoothstep(1.2, 7.5, dist - size * 0.35);
        // … and keep huge on-screen puffs faint (screen-space size ≈ size / dist)
        a *= 1.0 - smoothstep(0.35, 1.1, size / max(dist, 0.1));
        vUv = uv;
        vP = vec4(a, seed, ph, wp.y);
        vCol = mix(aLitLo, aLitHi, clamp(c.y / 7.0, 0.0, 1.0));
        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        if (a < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // fully faded: collapse (no fill cost)
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uNoise;
      uniform float uTime;
      varying vec2 vUv;
      varying vec4 vP;
      varying vec3 vCol;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        vec2 q = vUv * 2.0 - 1.0;
        float r = length(q);
        float mask = 1.0 - smoothstep(0.25, 1.0, r);
        float seed = vP.y;
        // two counter-scrolling noise octaves → wisps that curl and tear instead of a solid ball
        vec2 o = vec2(seed * 3.7, seed * 1.3);
        float n1 = texture2D(uNoise, vUv * 0.55 + o + vec2(0.0, -uTime * 0.035)).r;
        float n2 = texture2D(uNoise, vUv * 1.1 + o.yx + vec2(uTime * 0.02, -uTime * 0.06)).g;
        float wisp = smoothstep(0.2, 0.78, n1 * 0.65 + n2 * 0.55 - r * 0.25);
        float d = mask * wisp;
        // no hard line where the sprite meets the asphalt
        d *= smoothstep(0.0, 0.9, vP.w);
        float a = d * vP.x * 1.4;
        if (a < 0.003) discard;
        gl_FragColor = vec4(vCol, a);
        #include <fog_fragment>
      }`,
  });
}

/** Light arriving at p from the streetlights near arc length s (same lamps / falloff as the road pools). */
function steamLightAt(track, p, sNear, lampIntensity) {
  const out = new THREE.Color(0, 0, 0);
  const geo = track.lampGeometry;
  if (!track.lamps || !geo) return out;
  const L = track.length;
  const q = new THREE.Vector3(), r = new THREE.Vector3();
  for (const l of track.lamps) {
    let ds = Math.abs(l.s - sNear);
    ds = Math.min(ds, L - ds);
    if (ds > 70) continue;
    track.getPointAt(l.s, q);
    track.getRightAt(l.s, r);
    for (const side of [-1, 1]) {
      if (!(side < 0 ? l.left : l.right)) continue;
      const hx = q.x + r.x * side * geo.lateral, hz = q.z + r.z * side * geo.lateral;
      const dx = hx - p.x, dy = geo.height - p.y, dz = hz - p.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      // luminaires throw light downward; steam beside / above the head still catches some scatter
      const cosD = dy / Math.sqrt(d2);
      const cut = 0.25 + 0.75 * THREE.MathUtils.smoothstep(cosD, -0.1, 0.5);
      const I = lampIntensity(l.kind) * cut / (d2 + 4);
      out.r += l.color[0] * I; out.g += l.color[1] * I; out.b += l.color[2] * I;
    }
  }
  return out;
}

function buildSteam(track, timeU, rnd, lampIntensity) {
  const L = track.length;
  const vents = [];
  const ventS = [];
  // pick a few spots on straights, in the lanes, away from corners
  const cands = [180, 300, 560, 760, 1450, 1650, 2050, 2450, 2850];
  for (const s of cands) {
    if (s > L) continue;
    const lat = (rnd() < 0.5 ? -1 : 1) * (2 + rnd() * 4);
    const p = track.getPointAt(s), r = track.getRightAt(s);
    vents.push(p.addScaledVector(r, lat));
    ventS.push(s);
  }
  // neon spill tints (magenta / cyan / violet / amber), one per vent
  const NEON = [[1.0, 0.18, 0.62], [0.15, 0.75, 1.0], [0.62, 0.3, 1.0], [1.0, 0.55, 0.15], [0.3, 1.0, 0.6]];
  const per = 16;
  const n = vents.length * per;
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), steamMaterial(timeU), n);
  const attr = new Float32Array(n * 4);
  const lo = new Float32Array(n * 3), hi = new Float32Array(n * 3), wind = new Float32Array(n * 2);
  const tmp = new THREE.Vector3();
  // radiance per unit density ≈ albedo × irradiance × phase; tuned so a plume under a lamp reads as a soft
  // glow (~0.1–0.25 HDR), never as a white wall.
  const K = 0.16;
  const AMB = [0.008, 0.009, 0.014];
  vents.forEach((v, i) => {
    const e0 = steamLightAt(track, tmp.set(v.x, 0.8, v.z), ventS[i], lampIntensity);
    const e1 = steamLightAt(track, tmp.set(v.x, 6.5, v.z), ventS[i], lampIntensity);
    const nc = NEON[Math.floor(rnd() * NEON.length)];
    const nk = 0.02 + rnd() * 0.035;
    const wa = rnd() * Math.PI * 2;
    for (let k = 0; k < per; k++) {
      const j = i * per + k;
      attr.set([v.x, v.z, k / per + rnd() * 0.04, rnd()], j * 4);
      lo.set([AMB[0] + e0.r * K + nc[0] * nk, AMB[1] + e0.g * K + nc[1] * nk, AMB[2] + e0.b * K + nc[2] * nk], j * 3);
      hi.set([AMB[0] + e1.r * K + nc[0] * nk * 1.4, AMB[1] + e1.g * K + nc[1] * nk * 1.4, AMB[2] + e1.b * K + nc[2] * nk * 1.4], j * 3);
      wind.set([Math.cos(wa) * 0.7 + 0.7, Math.sin(wa) * 0.7], j * 2);
    }
  });
  for (let i = 0; i < n; i++) mesh.setMatrixAt(i, _m.identity());
  mesh.geometry.setAttribute('aPuff', new THREE.InstancedBufferAttribute(attr, 4));
  mesh.geometry.setAttribute('aLitLo', new THREE.InstancedBufferAttribute(lo, 3));
  mesh.geometry.setAttribute('aLitHi', new THREE.InstancedBufferAttribute(hi, 3));
  mesh.geometry.setAttribute('aWind', new THREE.InstancedBufferAttribute(wind, 2));
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.name = 'steam';
  return { mesh, vents };
}

// ---------------------------------------------------------------------------------------------
// Aircraft warning beacons
// ---------------------------------------------------------------------------------------------

function beaconMaterial(timeU) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: timeU },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec2 aB; // phase, size
      uniform float uTime;
      varying vec2 vP;
      varying float vOn;
      void main() {
        vec3 c = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float dist = length(cameraPosition - c);
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        float size = aB.y * (1.0 + dist * 0.004); // stay visible at distance
        vec3 wp = c + (right * position.x + up * position.y) * size;
        vP = position.xy * 2.0;
        float t = fract(uTime * 0.75 + aB.x);
        vOn = smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.3, 0.45, t));
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vP;
      varying float vOn;
      void main() {
        float r2 = dot(vP, vP);
        float a = exp(-r2 * 30.0) * 3.0 + exp(-r2 * 5.0) * 0.4;
        gl_FragColor = vec4(vec3(1.0, 0.05, 0.02) * a * (0.06 + vOn * 2.0), 1.0);
      }`,
  });
}

// ---------------------------------------------------------------------------------------------
// createProps
// ---------------------------------------------------------------------------------------------

export function createProps({ track, city, shared, quality = 'high' } = {}) {
  const group = new THREE.Group();
  group.name = 'props';
  const rnd = mulberry32(31337);
  const timeU = shared.uniforms.uTime;
  const reflectHidden = [];

  // traffic signals
  group.add(buildTrafficSignals(track, timeU, rnd));

  // overpass
  const ov = buildOverpass(track, timeU, rnd);
  group.add(ov.group);

  // waterfront
  const wf = buildWaterfront(track, rnd);
  group.add(wf.mesh);

  // promenade lamps (short poles + globes + halos)
  if (wf.lampPos.length) {
    const pole = new THREE.CylinderGeometry(0.06, 0.09, 4.2, 8); pole.translate(0, 2.1, 0);
    const poles = new THREE.InstancedMesh(pole, new THREE.MeshStandardMaterial({ color: 0x1d1f24, roughness: 0.4, metalness: 0.7 }), wf.lampPos.length);
    const globes = new THREE.InstancedMesh(new THREE.SphereGeometry(0.28, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 6.5, 4) }), wf.lampPos.length);
    const halos = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), haloMaterial(), wf.lampPos.length);
    const hattr = new Float32Array(wf.lampPos.length * 4);
    wf.lampPos.forEach((pp, i) => {
      _m.makeTranslation(pp.x, 0, pp.z); poles.setMatrixAt(i, _m);
      _m.makeTranslation(pp.x, 4.35, pp.z); globes.setMatrixAt(i, _m); halos.setMatrixAt(i, _m);
      hattr.set([1.4, 0.95, 0.6, 3.0], i * 4);
    });
    halos.geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(hattr, 4));
    halos.frustumCulled = false;
    poles.computeBoundingSphere(); globes.computeBoundingSphere();
    group.add(poles, globes, halos);
  }

  // street furniture + bus shelters
  const sf = buildStreetFurniture(track, rnd, timeU);
  group.add(sf.group);
  reflectHidden.push(...sf.group.children.filter((c) => c.name === 'smallProps'));

  // steam
  let steam = null;
  if (quality !== 'low') {
    steam = buildSteam(track, timeU, rnd, lampIntensity);
    group.add(steam.mesh);
    reflectHidden.push(steam.mesh);
  }

  // aircraft beacons
  if (city && city.beacons.length) {
    const n = city.beacons.length;
    const b = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), beaconMaterial(timeU), n);
    const attr = new Float32Array(n * 2);
    city.beacons.forEach((p, i) => {
      _m.makeTranslation(p[0], p[1], p[2]);
      b.setMatrixAt(i, _m);
      attr[i * 2] = rnd() < 0.5 ? 0 : rnd();
      attr[i * 2 + 1] = 1.6;
    });
    b.geometry.setAttribute('aB', new THREE.InstancedBufferAttribute(attr, 2));
    b.frustumCulled = false;
    b.name = 'beacons';
    group.add(b);
  }

  // rooftop water tanks
  if (city && city.tanks.length) {
    const tank = mergeGeometries([
      colored((() => { const g = new THREE.CylinderGeometry(1.6, 1.6, 3.2, 12); g.translate(0, 4.4, 0); return g; })(), 0x3b2a1f),
      colored((() => { const g = new THREE.ConeGeometry(1.75, 1.0, 12); g.translate(0, 6.5, 0); return g; })(), 0x2a2018),
      ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, c]) => colored((() => { const g = new THREE.BoxGeometry(0.15, 2.8, 0.15); g.translate(a * 1.1, 1.4, c * 1.1); return g; })(), 0x222222)),
    ]);
    const tanks = new THREE.InstancedMesh(tank, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), city.tanks.length);
    city.tanks.forEach((p, i) => { _m.makeTranslation(p[0], p[1], p[2]); tanks.setMatrixAt(i, _m); });
    tanks.castShadow = true;
    tanks.computeBoundingSphere();
    group.add(tanks);
  }

  return {
    group,
    extraLights: ov.extraLights,
    adPanels: sf.adPanels,
    reflectHidden,
    steamVents: steam ? steam.vents : [],
    update() {},
  };
}
