// MIDNIGHT APEX — the street circuit: centerline math (trackPath.js) + road meshes.
//
// Meshes (all in track.group):
//   • one continuous road ribbon (asphalt + curb faces + raised sidewalks) with the wet road shader
//     (markings, kerbs, crosswalks, grid, puddles, streetlight pools, planar reflection) — 1 draw call
//   • concrete jersey barriers whose road-side toe sits exactly at ±wallOffset — 1 draw call
//   • chevron boards on the outside of tight corners (instanced) — 1 draw call
//   • start/finish gantry with an LED "MIDNIGHT APEX" banner and start lights — ~3 draw calls
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createTrackPath } from './trackPath.js';
import { createWetShared, createRoadMaterial } from './wetShader.js';
import { makeCanvas, canvasTexture } from './textures.js';

export { createTrackPath };

const CURB_H = 0.15; // sidewalk curb face height
const WALK_IN = 9.8; // road edge / curb line (barrier base spans wallOffset … 9.8)
const WALK_OUT = 14.8; // back edge of the sidewalk

/** Track rows: dense on curves, sparse on straights. */
function rowIndices(track) {
  const { N, kap } = track.samples;
  const rows = [];
  for (let i = 0; i < N; i++) {
    const curvy = Math.abs(kap[i]) > 1 / 1500 || Math.abs(kap[(i + 2) % N]) > 1 / 1500 || Math.abs(kap[(i - 2 + N) % N]) > 1 / 1500;
    if (curvy || i % 4 === 0) rows.push(i);
  }
  rows.push(N); // closing row (same position as row 0, v = length)
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Data textures for the road shader
// ---------------------------------------------------------------------------------------------

function createKerbTexture(track) {
  const { N } = track.samples;
  const { kerb, kerbOut } = track.features;
  const data = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    data[i * 4] = kerb[i] < 0 ? 255 : 0;
    data[i * 4 + 1] = kerb[i] > 0 ? 255 : 0;
    data[i * 4 + 2] = kerbOut[i] < 0 ? 255 : 0;
    data[i * 4 + 3] = kerbOut[i] > 0 ? 255 : 0;
  }
  const t = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** Marking data per meter (half float): R = signed distance to the nearest crosswalk centre (±40 m). */
function createMarkTexture(track) {
  const { N, ds } = track.samples;
  const L = track.length;
  const cw = track.features.crosswalks;
  const data = new Uint16Array(N * 4);
  for (let i = 0; i < N; i++) {
    const s = i * ds;
    let best = 40;
    for (const c of cw) {
      let d = s - c;
      d -= L * Math.round(d / L);
      if (Math.abs(d) < Math.abs(best)) best = d;
    }
    data[i * 4] = THREE.DataUtils.toHalfFloat(Math.max(-40, Math.min(40, best)));
    data[i * 4 + 1] = data[i * 4 + 2] = data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(0);
  }
  const t = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  t.wrapS = THREE.RepeatWrapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** Per-lamp light (rgb = color × intensity, a = present). Row 0 = left side, row 1 = right side. */
export function lampIntensity(kind) {
  return kind === 'sodium' ? 175 : 150;
}
function createLampTexture(track) {
  const n = track.lampCount;
  const data = new Float32Array(n * 2 * 4);
  for (const l of track.lamps) {
    const I = lampIntensity(l.kind);
    for (let side = 0; side < 2; side++) {
      const present = side === 0 ? l.left : l.right;
      const o = (side * n + l.k) * 4;
      data[o] = l.color[0] * I;
      data[o + 1] = l.color[1] * I;
      data[o + 2] = l.color[2] * I;
      data[o + 3] = present ? 1 : 0;
    }
  }
  const t = new THREE.DataTexture(data, n, 2, THREE.RGBAFormat, THREE.FloatType);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Road ribbon (asphalt + curb faces + sidewalks)
// ---------------------------------------------------------------------------------------------

function buildRoadGeometry(track) {
  const { px, pz, hd, kap, N, ds } = track.samples;
  const rows = rowIndices(track);
  // Cross-section columns: [u, y (before mouth flattening), normalLat (−1/0/+1, 0 = up), surf, sideIndex]
  // sideIndex: −1 left sidewalk part, +1 right, 0 road. Hard edges = separate columns.
  const C = [
    [-WALK_OUT, -0.03, -1, 2, -1], [-WALK_OUT, CURB_H, -1, 2, -1],
    [-WALK_OUT, CURB_H, 0, 1, -1], [-12.3, CURB_H, 0, 1, -1], [-WALK_IN, CURB_H, 0, 1, -1],
    [-WALK_IN, CURB_H, 1, 2, -1], [-WALK_IN, 0, 1, 2, -1],
    [-WALK_IN, 0, 0, 0, 0], [-4.9, 0, 0, 0, 0], [0, 0, 0, 0, 0], [4.9, 0, 0, 0, 0], [WALK_IN, 0, 0, 0, 0],
    [WALK_IN, 0, -1, 2, 1], [WALK_IN, CURB_H, -1, 2, 1],
    [WALK_IN, CURB_H, 0, 1, 1], [12.3, CURB_H, 0, 1, 1], [WALK_OUT, CURB_H, 0, 1, 1],
    [WALK_OUT, CURB_H, 1, 2, 1], [WALK_OUT, -0.03, 1, 2, 1],
  ];
  const strips = [[0, 1], [2, 3], [3, 4], [5, 6], [7, 8], [8, 9], [9, 10], [10, 11], [12, 13], [14, 15], [15, 16], [17, 18]];
  const nc = C.length, nr = rows.length;
  const pos = new Float32Array(nr * nc * 3);
  const nor = new Float32Array(nr * nc * 3);
  const road = new Float32Array(nr * nc * 4);
  const right = new Float32Array(nr * nc * 2);
  const L = track.length;
  for (let r = 0; r < nr; r++) {
    const i = rows[r] % N;
    const s = rows[r] * ds;
    const h = hd[i];
    const rx = -Math.cos(h), rz = Math.sin(h);
    const k = kap[i];
    const mouthL = track.features.inMouth(s % L, -1) ? 1 : 0;
    const mouthR = track.features.inMouth(s % L, 1) ? 1 : 0;
    for (let c = 0; c < nc; c++) {
      const [u, y0, nl, surf0, side] = C[c];
      const mouth = side < 0 ? mouthL : side > 0 ? mouthR : 0;
      const y = mouth ? (y0 > 0 ? 0 : y0) : y0;
      const surf = mouth && surf0 === 1 ? 0 : mouth && surf0 === 2 ? 2 : surf0;
      const o = r * nc + c;
      pos[o * 3] = px[i] + rx * u;
      pos[o * 3 + 1] = y;
      pos[o * 3 + 2] = pz[i] + rz * u;
      if (nl === 0) { nor[o * 3] = 0; nor[o * 3 + 1] = 1; nor[o * 3 + 2] = 0; }
      else { nor[o * 3] = rx * nl; nor[o * 3 + 1] = 0; nor[o * 3 + 2] = rz * nl; }
      road[o * 4] = u;
      road[o * 4 + 1] = s;
      road[o * 4 + 2] = surf;
      road[o * 4 + 3] = k;
      right[o * 2] = rx;
      right[o * 2 + 1] = rz;
    }
  }
  const idx = [];
  for (let r = 0; r < nr - 1; r++) {
    for (const [a, b] of strips) {
      const a0 = r * nc + a, b0 = r * nc + b, a1 = (r + 1) * nc + a, b1 = (r + 1) * nc + b;
      // winding: columns go left→right (−u → +u), rows go forward → (a0, b0, a1) is CCW seen from the normal side.
      idx.push(a0, b0, a1, b0, b1, a1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aRoad', new THREE.BufferAttribute(road, 4));
  g.setAttribute('aRight', new THREE.BufferAttribute(right, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

// ---------------------------------------------------------------------------------------------
// Jersey barriers
// ---------------------------------------------------------------------------------------------

// Single-slope concrete barrier profile: [outward distance from the wall line, height]. The road face
// leans back only 5° so a car touching ±wallOffset is visually in contact over its whole flank.
const JERSEY = [[0, 0], [0.005, 0.08], [0.04, 0.45], [0.075, 0.82], [0.29, 0.82], [0.4, 0.45], [0.58, 0.08], [0.6, 0]];

function buildBarrierGeometry(track) {
  const { px, pz, hd, N, ds } = track.samples;
  const rows = rowIndices(track);
  const W = track.wallOffset;
  const segs = JERSEY.length - 1;
  // painted (red/white) zones near tight corners
  const paintAt = new Float32Array(N);
  for (const k of track.corners) {
    if (k.radius > 75) continue;
    for (let s = k.s0 - 30; s <= k.s1 + 30; s += 1) paintAt[((Math.round(s / ds) % N) + N) % N] = 1;
  }
  const verts = [], norms = [], attrs = [], idx = [];
  let base = 0;
  for (const side of [-1, 1]) {
    for (let r = 0; r < rows.length; r++) {
      const i = rows[r] % N;
      const s = rows[r] * ds;
      const h = hd[i];
      const rx = -Math.cos(h), rz = Math.sin(h);
      for (let q = 0; q < segs; q++) {
        const [d0, y0] = JERSEY[q], [d1, y1] = JERSEY[q + 1];
        // normal of this face in (outward, up) plane; outward = side·right
        let nx = -(y1 - y0), ny = d1 - d0; // rotate segment direction by −90° → faces the road for the front faces
        const nl = Math.hypot(nx, ny);
        nx /= nl; ny /= nl;
        for (const [d, y] of [[d0, y0], [d1, y1]]) {
          const lat = side * (W + d);
          verts.push(px[i] + rx * lat, y, pz[i] + rz * lat);
          norms.push(rx * side * nx, ny, rz * side * nx);
          attrs.push(s, y, side, paintAt[i]);
        }
      }
    }
    const per = segs * 2;
    for (let r = 0; r < rows.length - 1; r++) {
      for (let q = 0; q < segs; q++) {
        const a0 = base + r * per + q * 2, b0 = a0 + 1, a1 = a0 + per, b1 = b0 + per;
        if (side > 0) idx.push(a0, b0, a1, b0, b1, a1);
        else idx.push(a0, a1, b0, b0, a1, b1);
      }
    }
    base += rows.length * per;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  g.setAttribute('aBar', new THREE.Float32BufferAttribute(attrs, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function createBarrierMaterial(shared) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0 });
  mat.customProgramCacheKey = () => 'mapex-barrier-v1';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared.uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aBar;\nvarying vec4 vBar;\nvarying vec3 vWPosB;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvBar = aBar;\nvWPosB = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uDetailTex;
uniform sampler2D uMacroTex;
uniform float uTime;
varying vec4 vBar;
varying vec3 vWPosB;
float bHash(float n) { return fract(sin(n * 91.345) * 47453.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float bs = vBar.x, by = vBar.y, bside = vBar.z, bpaint = vBar.w;
vec4 bd = texture2D(uDetailTex, vec2(bs * 0.5, by * 0.5 + bside * 0.3));
vec4 bm = texture2D(uMacroTex, vec2(bs / 40.0, by / 12.0 + bside * 0.25));
float block = floor(bs / 4.0);
float jl = fract(bs / 4.0) * 4.0;
float joint = 1.0 - smoothstep(0.015, 0.05, min(jl, 4.0 - jl));
float blockVar = bHash(block * 1.7 + bside);
vec3 conc = vec3(0.30, 0.30, 0.29) * (0.8 + 0.25 * blockVar) * (0.75 + 0.45 * bd.b);
// red / white painted blocks near tight corners
vec3 paintC = mod(block, 2.0) < 0.5 ? vec3(0.62, 0.05, 0.04) : vec3(0.68, 0.68, 0.66);
conc = mix(conc, paintC * (0.85 + 0.2 * bd.b), bpaint * smoothstep(0.05, 0.12, by));
// road grime at the base and rain streaks running down
float grime = 1.0 - smoothstep(0.0, 0.35, by);
float streaks = smoothstep(0.55, 0.8, texture2D(uMacroTex, vec2(bs / 6.0, by / 30.0)).a);
conc *= 1.0 - grime * 0.55;
conc *= 1.0 - streaks * 0.25 * (1.0 - by / 0.81);
conc = mix(conc, vec3(0.02), joint);
// scuffs (tyre rubber) on the road face
float scuff = smoothstep(0.72, 0.9, bm.g) * step(by, 0.6) * (1.0 - bpaint * 0.3);
conc = mix(conc, vec3(0.02), scuff * 0.7);
diffuseColor.rgb = conc;
float bRough = mix(0.55, 0.38, bpaint) + 0.15 * bd.a;
// retro-reflectors every 8 m on the road face
float rl = fract(bs / 8.0 + 0.5 * step(0.0, bside)) * 8.0 - 4.0;
float refl = (1.0 - smoothstep(0.05, 0.07, abs(rl))) * (1.0 - smoothstep(0.035, 0.05, abs(by - 0.6)));
`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = bRough;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec3 nWb = transformNormalByInverseViewMatrix(normal, viewMatrix);
  vec2 dn = (bd.rg * 2.0 - 1.0) * 0.4;
  vec3 tb = normalize(cross(nWb, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
  nWb = normalize(nWb + tb * dn.x + vec3(0.0, dn.y, 0.0));
  normal = normalize((viewMatrix * vec4(nWb, 0.0)).xyz);
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float camD = length(cameraPosition - vWPosB);
  float facing = abs(dot(normalize(cameraPosition - vWPosB), transformNormalByInverseViewMatrix(normal, viewMatrix)));
  float retro = refl * smoothstep(140.0, 15.0, camD) * (0.4 + 0.6 * facing);
  vec3 rc = bside > 0.0 ? vec3(1.0, 0.45, 0.05) : vec3(1.0, 0.9, 0.75);
  totalEmissiveRadiance += rc * retro * 6.0;
}`);
  };
  return mat;
}

// ---------------------------------------------------------------------------------------------
// Chevron boards on the outside of tight corners
// ---------------------------------------------------------------------------------------------

function createChevronTexture() {
  const c = makeCanvas(256, 128);
  const g = c.getContext('2d');
  g.fillStyle = '#0a0a0a';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#ffcc00';
  for (let i = 0; i < 3; i++) {
    const x = 40 + i * 70;
    g.beginPath();
    g.moveTo(x, 14); g.lineTo(x + 42, 64); g.lineTo(x, 114); g.lineTo(x - 22, 114); g.lineTo(x + 20, 64); g.lineTo(x - 22, 14);
    g.closePath();
    g.fill();
  }
  g.strokeStyle = '#ffcc00';
  g.lineWidth = 6;
  g.strokeRect(3, 3, 250, 122);
  return canvasTexture(c);
}

function buildChevrons(track) {
  const list = [];
  for (const k of track.corners) {
    if (k.radius > 75) continue;
    const outside = -Math.sign(k.kappa); // side of the outer barrier
    for (let s = k.s0 - 6; s <= k.s1 + 2; s += 5.5) list.push({ s, side: outside, turn: Math.sign(k.kappa) });
  }
  const geo = new THREE.PlaneGeometry(1.9, 0.95);
  const tex = createChevronTexture();
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.4, metalness: 0.1 });
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3(), t = new THREE.Vector3(), r = new THREE.Vector3();
  list.forEach((c, i) => {
    track.getPointAt(c.s, p);
    track.getTangentAt(c.s, t);
    track.getRightAt(c.s, r);
    p.addScaledVector(r, c.side * (track.wallOffset + 0.3));
    p.y = 1.35;
    // board faces the track (normal = −side·right); arrows (texture +u) point along the direction of travel
    const n = r.clone().multiplyScalar(-c.side);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(n.x, n.z));
    const planeX = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    sc.set(planeX.dot(t) >= 0 ? 1 : -1, 1, 1);
    m.compose(p, q, sc);
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.name = 'chevrons';
  return mesh;
}

// ---------------------------------------------------------------------------------------------
// Start / finish gantry
// ---------------------------------------------------------------------------------------------

function createBannerTexture() {
  const W = 2048, H = 256;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  // row 0: title
  g.font = 'italic 900 104px "Arial Black", "Helvetica Neue", Arial, sans-serif';
  const grad = g.createLinearGradient(300, 0, W - 300, 0);
  grad.addColorStop(0, '#ff2bd6');
  grad.addColorStop(0.5, '#ffffff');
  grad.addColorStop(1, '#00e5ff');
  g.fillStyle = grad;
  g.fillText('MIDNIGHT  APEX', W / 2, 64);
  // row 1: ticker
  g.font = 'italic 800 84px "Arial Black", Arial, sans-serif';
  g.fillStyle = '#ffb000';
  g.textAlign = 'left';
  const ticker = 'NEON DISTRICT CIRCUIT   ✦   START / FINISH   ✦   ';
  g.font = `italic 800 ${Math.floor(84 * Math.min(1, (W - 20) / g.measureText(ticker).width))}px "Arial Black", Arial, sans-serif`;
  g.fillText(ticker, 10, 192);
  const t = canvasTexture(c, { mips: false });
  t.wrapS = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearFilter;
  return t;
}

function createLedMaterial(tex, uniforms, size) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uText: { value: tex },
      uTime: uniforms.uTime,
      uLights: { value: 0 },
      uGo: { value: 0 },
      uBright: { value: 7 },
      uSize: { value: new THREE.Vector2(size[0], size[1]) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uText;
      uniform float uTime, uLights, uGo, uBright;
      uniform vec2 uSize;
      varying vec2 vUv;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        vec2 grid = floor(uSize / 0.035);            // 3.5 cm LED pitch
        vec2 cell = floor(vUv * grid);
        vec2 f = fract(vUv * grid) - 0.5;
        vec2 cuv = (cell + 0.5) / grid;
        vec3 col;
        if (uLights > 0.5 || uGo > 0.5) {
          vec2 pm = cuv * uSize;                      // meters on the panel
          float idx = clamp(floor((pm.x - uSize.x * 0.5) / 1.7 + 2.5), 0.0, 4.0);
          vec2 c = vec2(uSize.x * 0.5 + (idx - 2.0) * 1.7, uSize.y * 0.5);
          float disc = 1.0 - step(0.5, length(pm - c));
          vec3 on = uGo > 0.5 ? vec3(0.1, 1.0, 0.3) : vec3(1.0, 0.04, 0.02);
          float lit = uGo > 0.5 ? 1.0 : step(idx + 0.5, uLights);
          col = mix(vec3(0.05, 0.0, 0.0), on, lit) * disc;
        } else {
          float phase = mod(uTime, 16.0);
          float ticker = step(9.0, phase);
          vec2 tuv = ticker < 0.5 ? vec2(cuv.x, 0.5 + cuv.y * 0.5) : vec2(cuv.x * 0.85 + uTime * 0.06, cuv.y * 0.5);
          col = texture2D(uText, tuv).rgb;
          col *= 0.8 + 0.2 * sin(uTime * 2.0 - cuv.x * 9.0);
        }
        // LED dot mask; fades to its average once the dots are sub-pixel (no moiré)
        float dotm = 1.0 - smoothstep(0.28, 0.45, length(f));
        float px = max(fwidth(vUv.x * grid.x), fwidth(vUv.y * grid.y));
        dotm = mix(dotm, 0.55, smoothstep(0.35, 0.9, px));
        gl_FragColor = vec4(vec3(0.004, 0.004, 0.006) + col * dotm * uBright, 1.0);
        #include <fog_fragment>
      }`,
    fog: true,
  });
}

function buildGantry(track, shared) {
  const g = new THREE.Group();
  g.name = 'gantry';
  const s = track.startS;
  const p = track.getPointAt(s), t = track.getTangentAt(s);
  const heading = Math.atan2(t.x, t.z);
  g.position.copy(p);
  g.rotation.y = heading; // local +Z = travel direction, local −X = right (heading convention)
  const span = track.wallOffset + 1.5; // towers stand on the sidewalks
  const H = 8.2;
  const metal = new THREE.MeshStandardMaterial({ color: 0x1a1c22, roughness: 0.35, metalness: 0.85 });
  const parts = [];
  const box = (w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const b = new THREE.BoxGeometry(w, h, d);
    b.rotateX(rx); b.rotateY(ry); b.rotateZ(rz);
    b.translate(x, y, z);
    parts.push(b);
  };
  // towers: 4 posts + braces each
  for (const sx of [-1, 1]) {
    const x = sx * span;
    for (const ox of [-0.4, 0.4]) for (const oz of [-0.4, 0.4]) box(0.12, H, 0.12, x + ox, H / 2, oz);
    for (let y = 0.6; y < H - 0.5; y += 1.2) {
      box(0.06, 1.3, 0.06, x - 0.4, y + 0.6, 0, 0, 0, 0); // filler
      box(0.05, 1.15, 0.05, x, y + 0.6, -0.4, 0, 0, 0.6);
      box(0.05, 1.15, 0.05, x, y + 0.6, 0.4, 0, 0, -0.6);
      box(0.05, 1.15, 0.05, x - 0.4, y + 0.6, 0, 0.6, 0, 0);
      box(0.05, 1.15, 0.05, x + 0.4, y + 0.6, 0, -0.6, 0, 0);
    }
    box(1.3, 0.25, 1.3, x, 0.12, 0); // base plate
  }
  // beam truss
  const bw = span * 2 + 1.0, by0 = H - 1.5, by1 = H;
  for (const y of [by0, by1]) for (const z of [-0.55, 0.55]) box(bw, 0.14, 0.14, 0, y, z);
  for (let x = -span; x < span; x += 1.4) {
    box(0.06, 1.7, 0.06, x + 0.7, (by0 + by1) / 2, -0.55, 0, 0, 0.75);
    box(0.06, 1.7, 0.06, x + 0.7, (by0 + by1) / 2, 0.55, 0, 0, -0.75);
  }
  const trussGeo = mergeGeometries(parts);
  const truss = new THREE.Mesh(trussGeo, metal);
  truss.castShadow = true;
  g.add(truss);
  // LED banner faces (front: facing oncoming cars = local −Z; back: +Z)
  const tex = createBannerTexture();
  const panelW = span * 2 - 1.2, panelH = 1.25;
  const led = createLedMaterial(tex, shared.uniforms, [panelW, panelH]);
  const panel = new THREE.PlaneGeometry(panelW, panelH);
  const front = panel.clone().rotateY(Math.PI).translate(0, (by0 + by1) / 2, -0.62);
  const back = panel.clone().translate(0, (by0 + by1) / 2, 0.62);
  // mirror the back face UVs so the text reads correctly from behind
  const banner = new THREE.Mesh(mergeGeometries([front, back]), led);
  g.add(banner);
  // dark panel backing box behind the LEDs
  const backing = new THREE.Mesh(new THREE.BoxGeometry(panelW + 0.2, panelH + 0.2, 1.1), metal);
  backing.position.y = (by0 + by1) / 2;
  g.add(backing);
  return { group: g, led };
}

// ---------------------------------------------------------------------------------------------
// createTrack
// ---------------------------------------------------------------------------------------------

export function createTrack({ renderer, quality } = {}) {
  const q = quality || 'high';
  const track = createTrackPath();
  const group = new THREE.Group();
  group.name = 'track';

  const wet = createWetShared({ quality: q });
  if (renderer && renderer.capabilities) {
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    wet.uniforms.uDetailTex.value.anisotropy = Math.min(q === 'low' ? 4 : 16, maxAniso);
    wet.uniforms.uMacroTex.value.anisotropy = Math.min(q === 'low' ? 2 : 8, maxAniso);
  }

  // Road ribbon
  const kerbTex = createKerbTexture(track);
  const lampTex = createLampTexture(track);
  const markTex = createMarkTexture(track);
  const roadMat = createRoadMaterial(wet, {
    length: track.length,
    kerbTex,
    lampTex,
    markTex,
    // two sodium fixtures under the deck at each overpass crossing (the regular lamps are omitted there)
    extraPools: track.features.overpass.s.flatMap((s) => [new THREE.Vector4(s - 3, -3.5, track.features.overpass.height - 0.1, 110), new THREE.Vector4(s + 3, 3.5, track.features.overpass.height - 0.1, 110)]),
    lampSpacing: track.lampSpacing,
    lampCount: track.lampCount,
    lampU: track.lampGeometry.lateral,
    lampH: track.lampGeometry.height,
    crosswalks: track.features.crosswalks,
    grid: track.grid,
  });
  const road = new THREE.Mesh(buildRoadGeometry(track), roadMat);
  road.name = 'road';
  road.receiveShadow = true;
  road.frustumCulled = false; // one huge mesh, always partly visible
  group.add(road);

  // Barriers
  const barrier = new THREE.Mesh(buildBarrierGeometry(track), createBarrierMaterial(wet));
  barrier.name = 'barriers';
  barrier.castShadow = true;
  barrier.receiveShadow = true;
  barrier.frustumCulled = false;
  group.add(barrier);

  // Chevrons
  group.add(buildChevrons(track));

  // Gantry
  const gantry = buildGantry(track, wet);
  group.add(gantry.group);

  track.group = group;
  track.wet = wet; // shared wet-surface uniforms (environment drives the planar reflection through these)
  track.roadMesh = road;
  track.barrierMesh = barrier;
  track.reflectionHidden = [road]; // meshes that must not be drawn into the planar reflection
  track.quality = q;

  /** Optional: drive the start lights on the gantry banner (n red lights 0..5, go = green). */
  track.setStartLights = (n = 0, go = false) => {
    gantry.led.uniforms.uLights.value = n;
    gantry.led.uniforms.uGo.value = go ? 1 : 0;
  };

  let clock = 0;
  track.update = (dt = 0, { time } = {}) => {
    clock = time != null ? time : clock + dt;
    wet.uniforms.uTime.value = clock;
  };
  return track;
}
