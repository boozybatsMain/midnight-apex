// MIDNIGHT APEX — GPU-friendly pooled particles (owner: fx).
//
// Draw calls (each layer's mesh is hidden when it has nothing alive, so idle cost is 0):
//   smoke  — 1 draw: analytic GPU simulation (spawn data written once, motion = closed-form drag/buoyancy/wind
//            integration in the vertex shader), premultiplied "over" blending, soft noise-puff atlas.
//   spray  — 1 draw: same analytic scheme; two kinds in one buffer: wet mist puffs (mostly "over") and fine
//            droplets rendered as motion-blurred streaks (additive), with tail-light red pick-up near the car.
//   hot    — 1 draw: sparks (CPU-simulated: gravity, drag, bounce on y=0) + nitro flames (per-exhaust slots) +
//            nitro embers, all as camera-facing capsule "segment sprites", additive HDR.
//   skids  — 1 draw: ring buffer of joined quads per trackId, dark translucent with tread pattern, polygonOffset.
// No per-frame allocations; uploads only the dirty ranges of the instance buffers.
//
// Every layer lives on LAYERS.NO_REFLECTION: visible to the game cameras, never drawn into the wet-road planar
// reflection (no mirrored nitro flames / sparks / spray, and the reflection pass skips these draws entirely).
// Smoke and spray mist are soft particles: they fade where they intersect opaque geometry (car bodies,
// barriers) using the scene-depth snapshot armed by postfx (sceneDepth.js); without postfx they render as before.
import * as THREE from 'three';
import { LAYERS } from '../config.js';
import { SOFT_PARTICLE_GLSL, softParticleUniforms, bindSoftParticles } from './sceneDepth.js';

// ------------------------------------------------------------------------------------------------
// shared GLSL

const FOG_PARS = /* glsl */ `
#ifdef USE_FOG
uniform vec3 fogColor;
#ifdef FOG_EXP2
uniform float fogDensity;
#else
uniform float fogNear;
uniform float fogFar;
#endif
float fogFactorAt(float depth) {
#ifdef FOG_EXP2
  return 1.0 - exp(-fogDensity * fogDensity * depth * depth);
#else
  return smoothstep(fogNear, fogFar, depth);
#endif
}
#endif
`;

// Camera-facing capsule around the screen-space segment a→b (both in view space).
// Pixel-correct width with a ≥0.8 px floor (thin streaks stay anti-aliased: we widen and fade instead of alias).
// Outputs screen-linear varyings (multiplied by w; divided back in the fragment shader — "noperspective").
const SEGMENT_VS = /* glsl */ `
uniform vec2 uViewport;
varying vec4 vSeg;   // (acrossPx * w, alongPx * w, w, unused)
varying vec3 vSegInfo; // (lenPx, widthPx, coverage)
vec4 segmentQuad(vec3 a, vec3 b, float worldWidth, vec2 q) {
  const float near = 0.06;
  if (b.z > -near) { float t = (a.z + near) / (a.z - b.z); b = mix(a, b, clamp(t, 0.0, 1.0)); }
  vec4 ca = projectionMatrix * vec4(a, 1.0);
  vec4 cb = projectionMatrix * vec4(b, 1.0);
  vec2 hv = 0.5 * uViewport;
  vec2 sa = ca.xy / ca.w * hv;
  vec2 sb = cb.xy / cb.w * hv;
  vec2 d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1e-3 ? d / len : vec2(0.0, 1.0);
  vec2 perp = vec2(dir.y, -dir.x); // keeps CCW winding
  float t = q.y * 0.5 + 0.5;
  vec4 c = mix(ca, cb, t);
  float trueW = 0.5 * worldWidth * projectionMatrix[1][1] * hv.y / c.w; // half width in px
  float wpx = max(trueW, 0.8);
  float along = t * len + q.y * wpx;            // caps extend by the radius
  vec2 offPx = perp * q.x * wpx + dir * q.y * wpx;
  c.xy += offPx * c.w / hv;
  vSeg = vec4(q.x * wpx * c.w, along * c.w, c.w, 0.0);
  vSegInfo = vec3(len, wpx, clamp(trueW / wpx, 0.0, 1.0));
  return c;
}
`;

const SEGMENT_FS = /* glsl */ `
varying vec4 vSeg;
varying vec3 vSegInfo;
// returns (normalized distance from the segment core [0..1+], along 0..1)
vec2 segmentCoords() {
  float invW = 1.0 / vSeg.z;
  float across = vSeg.x * invW;
  float along = vSeg.y * invW;
  float len = vSegInfo.x;
  float h = clamp(along, 0.0, len);
  float dist = length(vec2(across, along - h)) / vSegInfo.y;
  return vec2(dist, len > 1e-3 ? h / len : 0.0);
}
`;

// ------------------------------------------------------------------------------------------------
// procedural textures

function hash2(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
function valueNoise(x, y, s, period) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const p = (i) => ((i % period) + period) % period;
  const a = hash2(p(xi), p(yi), s), b = hash2(p(xi + 1), p(yi), s);
  const c = hash2(p(xi), p(yi + 1), s), d = hash2(p(xi + 1), p(yi + 1), s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, s) {
  let f = 0, amp = 0.5, fr = 1;
  for (let o = 0; o < 5; o++) {
    f += amp * valueNoise(x * fr, y * fr, s + o * 17, 64 * fr);
    amp *= 0.5;
    fr *= 2;
  }
  return f / 0.96875;
}

// 2x2 atlas of billowy puffs. A = density, R = smooth "thickness", G = detail noise.
// Each puff = a cluster of soft metaballs (cauliflower silhouette) eroded by domain-warped fbm.
function makePuffAtlas(size = 256) {
  const cell = size / 2;
  const data = new Uint8Array(size * size * 4);
  let seedState = 1234567;
  const rand = () => ((seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let cy = 0; cy < 2; cy++) {
    for (let cx = 0; cx < 2; cx++) {
      const seed = 11 + cy * 2 + cx;
      const blobs = [];
      const nb = 16 + Math.floor(rand() * 6);
      for (let b = 0; b < nb; b++) {
        const a = rand() * Math.PI * 2, rr = Math.sqrt(rand()) * 0.24;
        blobs.push([Math.cos(a) * rr, Math.sin(a) * rr, 0.08 + rand() * 0.14]);
      }
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const u = (x + 0.5) / cell - 0.5, v = (y + 0.5) / cell - 0.5;
          const r = Math.sqrt(u * u + v * v) * 2; // 0 centre, 1 at the cell edge
          const wx = fbm(u * 3 + 5, v * 3, seed + 50) - 0.5;
          const wy = fbm(u * 3, v * 3 + 9, seed + 80) - 0.5;
          const uu = u + wx * 0.08, vv = v + wy * 0.08;
          let m = 0;
          for (const [bx, by, br] of blobs) {
            const dx = uu - bx, dy = vv - by;
            const q = 1 - (dx * dx + dy * dy) / (br * br);
            if (q > 0) m += q * q;
          }
          const n = fbm(u * 7 + wx * 2.5 + 10, v * 7 + wy * 2.5 + 10, seed);
          // noise erodes the thin outskirts much more than the dense core → wispy, irregular edges
          const edgeK = 1 - Math.min(m, 1) * 0.6;
          let d = m * (0.8 + 0.5 * (n - 0.5)) - 0.14 + (n - 0.5) * 0.7 * edgeK;
          d = Math.max(0, Math.min(1, d * 1.6));
          d = d * d * (3 - 2 * d);
          d *= Math.min(1, Math.max(0, (1 - r) / 0.12)); // never touch the cell border
          const thick = Math.min(1, m * 0.6);
          const i = ((cy * cell + y) * size + cx * cell + x) * 4;
          data[i] = Math.round(thick * 255);
          data[i + 1] = Math.round(n * 255);
          data[i + 2] = 255;
          data[i + 3] = Math.round(d * 255);
        }
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------------------------------------
// analytic puff layer (smoke & spray)

// per-instance layout (4 x vec4):
//   iA = (p0.xyz, birth)  iB = (v0.xyz, life)  iC = (size0, size1, rot0, rotSpeed)  iD = (seed, alpha, kind, tint)
const PUFF_STRIDE = 16;

const PUFF_COMMON_VS = /* glsl */ `
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
attribute vec4 iD;
uniform float uTime;
uniform vec3 uWind;
uniform vec3 uCamVel;
varying vec2 vUv;
varying float vAlpha;
varying float vUp;
varying float vWorldY;
varying float vFogDepth;
varying vec3 vTint;
varying float vThin;
varying vec2 vLight;
varying float vVar;
varying float vSoftR;   // soft-particle fade distance (m)
// closed-form motion with linear drag k, constant acceleration acc and wind:
// v(t) = vt + (v0 - vt) e^-kt,  p(t) = p0 + vt t + (v0 - vt)(1 - e^-kt)/k,  vt = wind + acc/k
void puffMotion(float age, float k, vec3 acc, vec3 wind, out vec3 p, out vec3 v) {
  vec3 vt = wind + acc / k;
  float e = exp(-k * age);
  p = iA.xyz + vt * age + (iB.xyz - vt) * (1.0 - e) / k;
  v = vt + (iB.xyz - vt) * e;
}
// camera-facing rotated billboard; writes ground-fade/lighting varyings
vec4 puffBillboard(vec3 p, float size, float rot) {
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float cs = cos(rot), sn = sin(rot);
  vLight = vec2(sn, cs) * 0.5; // screen-up expressed in (atlas) texture space
  vec2 q = position.xy;
  vec2 r = vec2(cs * q.x - sn * q.y, sn * q.x + cs * q.y);
  vec2 off = r * size;
  mv.xy += off;
  vUp = r.y * 2.0;
  // world-space height of this corner (camera right/up rows of the view matrix) → soft ground intersection
  vWorldY = p.y + off.x * viewMatrix[1][0] + off.y * viewMatrix[1][1];
  vFogDepth = -mv.z;
  return projectionMatrix * mv;
}
// billboard stretched along its apparent (camera-relative) motion: motion-blurred mist / spray sheets
vec4 puffStretched(vec3 p, float size, vec3 vrel, float blurTime) {
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vec3 vv = (viewMatrix * vec4(vrel, 0.0)).xyz;
  // apparent screen motion expressed in metres at the particle's depth: v.xy + xy * v.z / -z
  vec2 sv = vv.xy + mv.xy * vv.z / max(-mv.z, 0.1);
  float sl = length(sv);
  vec2 dir = sl > 1e-4 ? sv / sl : vec2(0.0, 1.0);
  vec2 perp = vec2(dir.y, -dir.x);
  float stretch = 1.0 + min(sl * blurTime / size, 2.2);
  vec2 q = position.xy;
  vec2 off = (perp * q.x + dir * q.y * stretch) * size;
  mv.xy += off;
  vUp = (perp.y * q.x + dir.y * q.y) * 2.0;
  vWorldY = p.y + off.x * viewMatrix[1][0] + off.y * viewMatrix[1][1];
  vFogDepth = -mv.z;
  return projectionMatrix * mv;
}
`;

const PUFF_FS_COMMON = /* glsl */ `
uniform sampler2D uTex;
varying vec2 vUv;
varying float vAlpha;
varying float vUp;
varying float vWorldY;
varying float vFogDepth;
varying vec3 vTint;
varying float vThin;
varying vec2 vLight;
varying float vVar;
varying float vSoftR;
${FOG_PARS}
${SOFT_PARTICLE_GLSL}
`;

const SMOKE_VS = /* glsl */ `
uniform float uDrag;
uniform vec3 uAccel;
uniform vec3 uNeonA;
uniform vec3 uNeonB;
uniform vec3 uTailColor;
uniform vec4 uNear;     // near-camera fade: smoothstep(x + y·size, z + w·size, depth)
${PUFF_COMMON_VS}
void main() {
  float life = iB.w;
  float age = max(uTime - iA.w, 0.0);
  float x = age / life;
  if (x >= 1.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float seed = iD.x;
  vec3 p, v;
  puffMotion(age, uDrag * (0.75 + 0.5 * seed), uAccel * (0.7 + 0.6 * fract(seed * 7.13)), uWind * (0.6 + 0.8 * fract(seed * 3.7)), p, v);
  float grow = 1.0 - pow(max(1.0 - x, 0.0), 3.2);
  float size = mix(iC.x, iC.y, grow);
  p.y = max(p.y, size * 0.3); // roll along the ground
  gl_Position = puffBillboard(p, size, iC.z + iC.w * age);
  float cell = floor(fract(seed * 13.7) * 4.0);
  vUv = (position.xy + 0.5) * 0.5 + vec2(mod(cell, 2.0), floor(cell * 0.5)) * 0.5;
  float fadeIn = smoothstep(0.0, 0.04, x);
  float fadeOut = pow(max(1.0 - x, 0.0), 1.35);
  // keep giant puffs from smearing over the lens: the camera "sees through" smoke it is inside of, and big
  // puffs fade with their apparent size (size / depth) so a burnout never turns the screen into a white wall
  float nearFade = smoothstep(uNear.x + uNear.y * size, uNear.z + uNear.w * size, vFogDepth);
  vAlpha = iD.y * fadeIn * fadeOut * nearFade;
  vSoftR = 0.25 + 0.2 * size;
  vThin = 1.0 - 0.55 * x; // older smoke is thinner, less self-shadowed
  vVar = 0.8 + 0.4 * fract(seed * 23.71);
  // fake neon colour pick-up: slow world-space variation between two city light colours
  float n = 0.5 + 0.5 * sin(p.x * 0.045 + 1.7 * sin(p.z * 0.033) + seed);
  vTint = mix(uNeonA, uNeonB, n) + uTailColor * iD.w * exp(-age * 4.0);
}`;

const SMOKE_FS = /* glsl */ `
uniform vec3 uColor;
${PUFF_FS_COMMON}
void main() {
  // ageing smoke diffuses: sample progressively blurrier mips (vThin: 1 → 0.45 over the lifetime)
  float bias = (1.0 - vThin) * 3.0;
  vec4 t = texture2D(uTex, vUv, bias);
  float dens = smoothstep(0.02, 0.85, t.a);
  float a = dens * vAlpha * smoothstep(0.0, 0.45, vWorldY);
  if (a < 0.002) discard;
  a *= softParticleFade(vFogDepth, vSoftR); // no hard slices through car bodies / barriers
  if (a < 0.002) discard;
  // self-shadowing: density between this texel and the light (above, in screen space) darkens it,
  // so billows get lit tops and soft shaded undersides regardless of the sprite's rotation
  float occl = texture2D(uTex, vUv + vLight * 0.09, bias + 1.5).a;
  float shade = clamp(occl - t.a * 0.5, 0.0, 1.0);
  float light = mix(1.0, 0.66, shade) * (0.84 + 0.16 * clamp(vUp, -1.0, 1.0));
  light = light * vVar + 0.12 * (1.0 - dens); // thin edges scatter a little more light
  vec3 col = uColor * light + vTint * (0.6 + 0.4 * t.g);
#ifdef USE_FOG
  col = mix(col, fogColor, fogFactorAt(vFogDepth));
#endif
  gl_FragColor = vec4(col * a, a);
}`;

const SPRAY_VS = /* glsl */ `
uniform vec2 uDrag;     // mist, droplet
uniform vec3 uAccelMist;
uniform vec3 uAccelDrop;
uniform float uShutter;
uniform vec3 uTailColor;
uniform vec4 uNear;     // near-camera fade of mist puffs: smoothstep(x + y·size, z + w·size, depth)
${SEGMENT_VS}
${PUFF_COMMON_VS}
varying float vKind;
void main() {
  float life = iB.w;
  float age = max(uTime - iA.w, 0.0);
  float x = age / life;
  if (x >= 1.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float seed = iD.x;
  vKind = iD.z;
  vec3 p, v;
  if (iD.z < 0.5) {
    // --- mist puff ---
    puffMotion(age, uDrag.x * (0.7 + 0.6 * seed), uAccelMist, uWind, p, v);
    float grow = 1.0 - pow(max(1.0 - x, 0.0), 1.8);
    float size = mix(iC.x, iC.y, grow);
    p.y = max(p.y, size * 0.22);
    gl_Position = puffStretched(p, size, v - uCamVel, uShutter * 4.0);
    float cell = floor(fract(seed * 13.7) * 4.0);
    vUv = (position.xy + 0.5) * 0.5 + vec2(mod(cell, 2.0), floor(cell * 0.5)) * 0.5;
    float fadeIn = smoothstep(0.0, 0.12, x);
    float fadeOut = pow(max(1.0 - x, 0.0), 1.3);
    // fade puffs that would cover a big part of the screen (apparent size ≈ size / depth): the plume
    // stays a mist trail behind the car instead of a white wall sweeping over the lens
    float nearFade = smoothstep(uNear.x + uNear.y * size, uNear.z + uNear.w * size, vFogDepth);
    vAlpha = iD.y * fadeIn * fadeOut * nearFade;
    vSoftR = 0.2 + 0.18 * size;
    // red glow from the tail lights while the mist is still right behind the car
    vTint = uTailColor * iD.w * exp(-age * 4.0);
    vThin = 1.0 - x;
    vVar = 1.0;
  } else {
    // --- droplet: motion-blurred streak relative to the camera ---
    puffMotion(age, uDrag.y, uAccelDrop, uWind * 0.3, p, v);
    if (p.y < 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    vec3 vr = v - uCamVel;
    vec3 a = (viewMatrix * vec4(p, 1.0)).xyz;
    vec3 b = (viewMatrix * vec4(p - vr * uShutter, 1.0)).xyz;
    if (a.z > -0.08) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    gl_Position = segmentQuad(a, b, iC.x, position.xy * 2.0);
    vFogDepth = -a.z;
    vWorldY = 1.0;
    vUv = vec2(0.0);
    vUp = 0.0;
    vAlpha = iD.y * smoothstep(0.0, 0.1, x) * (1.0 - x) * smoothstep(0.3, 1.2, vFogDepth);
    vTint = uTailColor * iD.w * exp(-age * 5.0) * 2.0;
    vThin = 0.0;
    vVar = 1.0;
    vSoftR = 0.0;
  }
}`;

const SPRAY_FS = /* glsl */ `
uniform vec3 uMistColor;
uniform vec3 uDropColor;
${SEGMENT_FS}
${PUFF_FS_COMMON}
varying float vKind;
void main() {
  if (vKind < 0.5) {
    vec4 t = texture2D(uTex, vUv, 1.6); // biased mip: soft, diffuse mist rather than billowy smoke
    // wispy breakup from the detail channel so overlapping puffs don't merge into a flat sheet
    float a = smoothstep(0.0, 0.8, t.a) * (0.55 + 0.9 * t.g * t.g) * vAlpha * smoothstep(0.0, 0.35, vWorldY);
    if (a < 0.002) discard;
    a *= softParticleFade(vFogDepth, vSoftR);
    if (a < 0.002) discard;
    float light = (0.7 + 0.3 * clamp(vUp, -1.0, 1.0)) * mix(1.0, 0.7, t.r * vThin);
    vec3 col = uMistColor * light + vTint;
    float fog = 0.0;
#ifdef USE_FOG
    fog = fogFactorAt(vFogDepth);
    col = mix(col, fogColor, fog);
#endif
    // half "over" (occludes a little: wet haze), half additive (scatters city light) — keeps the
    // road reflections readable through the plume
    gl_FragColor = vec4(col * a, a * 0.5);
  } else {
    vec2 sc = segmentCoords();
    float core = 1.0 - smoothstep(0.35, 1.0, sc.x);
    float a = core * vAlpha * vSegInfo.z * mix(1.0, 0.35, sc.y);
    // longer streaks spread the same light over more pixels
    a *= clamp(6.0 * vSegInfo.y / (vSegInfo.x + 6.0 * vSegInfo.y), 0.15, 1.0);
    if (a < 0.002) discard;
    vec3 col = uDropColor + vTint;
#ifdef USE_FOG
    col *= 1.0 - fogFactorAt(vFogDepth);
#endif
    gl_FragColor = vec4(col * a, 0.0); // additive
  }
}`;

function createInstancedQuadGeometry(buffer, stride, attrs) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
  );
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  attrs.forEach((name, i) => geo.setAttribute(name, new THREE.InterleavedBufferAttribute(buffer, 4, i * 4)));
  geo.instanceCount = 0;
  return geo;
}

function premultipliedBlend(mat) {
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.blendSrcAlpha = THREE.OneFactor;
  mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  return mat;
}

function setViewportUniform(mat) {
  const v = new THREE.Vector2();
  return (renderer) => {
    const rt = renderer.getRenderTarget();
    if (rt) mat.uniforms.uViewport.value.set(rt.width, rt.height);
    else renderer.getDrawingBufferSize(v), mat.uniforms.uViewport.value.copy(v);
    mat.uniformsNeedUpdate = true;
  };
}

class PuffLayer {
  constructor(capacity, material, name) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * PUFF_STRIDE);
    for (let i = 0; i < capacity; i++) {
      this.data[i * PUFF_STRIDE + 3] = -1e6; // birth
      this.data[i * PUFF_STRIDE + 7] = 1; // life
    }
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, PUFF_STRIDE, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    this.geometry = createInstancedQuadGeometry(this.buffer, PUFF_STRIDE, ['iA', 'iB', 'iC', 'iD']);
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.material = material;
    this.head = 0;
    this.used = 0;
    this.dirtyStart = -1;
    this.dirtyCount = 0;
    this.lastDeath = -1; // time at which the last particle dies
  }
  // returns float offset of a fresh slot
  alloc(deathTime) {
    const i = this.head;
    this.head = (i + 1) % this.capacity;
    if (this.used < this.capacity) this.used++;
    if (this.dirtyStart < 0) this.dirtyStart = i;
    if (this.dirtyCount < this.capacity) this.dirtyCount++;
    if (deathTime > this.lastDeath) this.lastDeath = deathTime;
    return i * PUFF_STRIDE;
  }
  flush(time) {
    const b = this.buffer;
    if (this.dirtyCount > 0) {
      b.clearUpdateRanges();
      const s = this.dirtyStart, n = this.dirtyCount;
      if (s + n <= this.capacity) b.addUpdateRange(s * PUFF_STRIDE, n * PUFF_STRIDE);
      else {
        b.addUpdateRange(s * PUFF_STRIDE, (this.capacity - s) * PUFF_STRIDE);
        b.addUpdateRange(0, (s + n - this.capacity) * PUFF_STRIDE);
      }
      b.needsUpdate = true;
      this.dirtyStart = -1;
      this.dirtyCount = 0;
    }
    this.geometry.instanceCount = this.used;
    this.mesh.visible = this.used > 0 && time < this.lastDeath + 0.05;
  }
  clear() {
    for (let i = 0; i < this.capacity; i++) this.data[i * PUFF_STRIDE + 3] = -1e6;
    this.buffer.clearUpdateRanges();
    this.buffer.needsUpdate = true; // no ranges → full re-upload
    this.used = 0;
    this.head = 0;
    this.dirtyStart = -1;
    this.dirtyCount = 0;
    this.lastDeath = -1;
    this.mesh.visible = false;
  }
}

// ------------------------------------------------------------------------------------------------
// "hot" layer: sparks + nitro flames + embers (additive segment sprites, CPU-written each frame)

// per instance: iA = (a.xyz, width), iB = (b.xyz, intensity), iC = (color.rgb, kind)
const HOT_STRIDE = 12;

const HOT_VS = /* glsl */ `
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
${SEGMENT_VS}
varying vec4 vCol;
varying float vKind;
varying float vFogDepth;
void main() {
  vec3 a = (viewMatrix * vec4(iA.xyz, 1.0)).xyz;
  vec3 b = (viewMatrix * vec4(iB.xyz, 1.0)).xyz;
  if (a.z > -0.08) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  gl_Position = segmentQuad(a, b, iA.w, position.xy * 2.0);
  vCol = vec4(iC.rgb, iB.w);
  vKind = iC.w;
  vFogDepth = -a.z;
}`;

const HOT_FS = /* glsl */ `
uniform float uTime;
${SEGMENT_FS}
${FOG_PARS}
varying vec4 vCol;
varying float vKind;
varying float vFogDepth;
void main() {
  vec2 sc = segmentCoords();
  float d = sc.x, h = sc.y;
  float k = vKind;
  vec3 col;
  float a;
  if (k < 0.5) {
    // spark streak: hot white core, coloured halo, head brighter than the tail
    float core = 1.0 - smoothstep(0.0, 0.55, d);
    float halo = 1.0 - smoothstep(0.3, 1.0, d);
    a = (halo * 0.5 + core) * mix(1.0, 0.2, h) * vSegInfo.z;
    col = mix(vCol.rgb, vec3(1.0, 0.95, 0.85) * max(vCol.r, 1.0), core * 0.5);
  } else if (k < 1.5) {
    // flame body: tapered teardrop along the axis, flickering noise, shock diamonds
    float len = vSegInfo.x / max(vSegInfo.y, 1e-3);
    float axial = clamp(len / 3.0, 0.0, 1.0);            // 0 when seen head-on
    float prof = mix(0.55, 1.0, sin(3.14159 * pow(max(h, 0.0), 0.55))) * mix(1.0, 0.45, h);
    prof = mix(1.0, prof, axial);
    float body = 1.0 - smoothstep(prof * 0.1, prof, d);
    body *= body;
    float diamonds = pow(max(0.5 + 0.5 * cos(h * 24.0 - uTime * 11.0), 0.0), 8.0) * (1.0 - h) * axial;
    a = body * pow(max(1.0 - h, 0.0), 1.1) * (1.0 + 1.0 * diamonds);
    // seen head-on (chase cam) the whole flame collapses onto a small disc: don't let it stack into a hot blob
    a *= mix(0.55, 1.0, axial);
    // blue body → violet tip
    col = mix(vCol.rgb, vec3(0.9, 0.3, 2.2) * length(vCol.rgb) * 0.5, smoothstep(0.3, 1.0, h));
    // white-hot centre line
    col += vec3(0.6, 0.85, 1.6) * (1.0 - smoothstep(0.0, 0.25, d)) * pow(max(1.0 - h, 0.0), 2.0) * 0.45;
  } else {
    // round glow (nozzle / embers)
    float g = exp(-d * d * 3.0);
    a = g * vSegInfo.z;
    col = vCol.rgb;
  }
  a *= vCol.a;
  if (a < 0.002) discard;
#ifdef USE_FOG
  col *= 1.0 - fogFactorAt(vFogDepth);
#endif
  gl_FragColor = vec4(col * a, 0.0);
}`;

// ------------------------------------------------------------------------------------------------
// skid marks

// per vertex (interleaved): (x, y, z, birth), (across -1..1, along m, alpha, 0)
const SKID_STRIDE = 8;

const SKID_VS = /* glsl */ `
attribute vec4 sA;
attribute vec4 sB;
uniform float uTime;
uniform float uHead;
uniform float uCapacity;
uniform float uLifetime;
varying vec3 vInfo;
varying float vFogDepth;
void main() {
  float seg = floor(float(gl_VertexID) / 4.0);
  // ring-buffer age: oldest segments fade out before they get overwritten
  float rel = mod(uHead - seg - 1.0 + uCapacity, uCapacity) / uCapacity;
  float ringFade = 1.0 - smoothstep(0.75, 1.0, rel);
  float timeFade = 1.0 - smoothstep(uLifetime * 0.6, uLifetime, uTime - sA.w);
  vInfo = vec3(sB.x, sB.y, sB.z * ringFade * timeFade);
  vec4 mv = viewMatrix * vec4(sA.xyz, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const SKID_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
${FOG_PARS}
varying vec3 vInfo;
varying float vFogDepth;
float h11(float x) { return fract(sin(x * 127.1) * 43758.5453); }
void main() {
  float u = vInfo.x;          // -1..1 across the tyre
  float v = vInfo.y;          // metres along the strip
  float edge = 1.0 - smoothstep(0.7, 1.0, abs(u));
  // tread: longitudinal grooves + rubber streak noise
  float grooves = 0.75 + 0.25 * smoothstep(0.2, 0.8, abs(sin(u * 7.5)));
  float streak = 0.75 + 0.25 * h11(floor(u * 9.0 + 3.0) + floor(v * 2.5) * 0.37);
  float a = vInfo.z * edge * grooves * streak * uOpacity;
  if (a < 0.003) discard;
  vec3 col = uColor;
#ifdef USE_FOG
  col = mix(col, fogColor, fogFactorAt(vFogDepth));
  a *= 1.0 - fogFactorAt(vFogDepth) * 0.6;
#endif
  gl_FragColor = vec4(col * a, a);
}`;

// ------------------------------------------------------------------------------------------------

export function createParticles({ scene, quality } = {}) {
  const high = (quality ?? 'high') !== 'low';
  const group = new THREE.Group();
  group.name = 'fx-particles';
  if (scene) scene.add(group);

  const fogUniforms = () => THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
  const puffTex = makePuffAtlas(high ? 256 : 128);

  // shared dynamic uniforms
  const uTime = { value: 0 };
  const uCamVel = { value: new THREE.Vector3() };
  const uWind = { value: new THREE.Vector3(0.9, 0, 0.5) };

  // ---------------- smoke ----------------
  const smokeMat = premultipliedBlend(
    new THREE.ShaderMaterial({
      name: 'fx-smoke',
      uniforms: {
        ...fogUniforms(),
        uTime,
        uWind,
        uCamVel,
        ...softParticleUniforms(),
        uTex: { value: puffTex },
        uDrag: { value: 1.25 },
        uAccel: { value: new THREE.Vector3(0, 0.5, 0) },
        uColor: { value: new THREE.Color(0.34, 0.35, 0.38) },
        uNeonA: { value: new THREE.Color(0.06, 0.015, 0.05) },
        uNeonB: { value: new THREE.Color(0.015, 0.04, 0.07) },
        uTailColor: { value: new THREE.Color(0.2, 0.01, 0.015) },
        uNear: { value: new THREE.Vector4(0.4, 0.2, 0.4, 0.85) },
      },
      vertexShader: SMOKE_VS,
      fragmentShader: SMOKE_FS,
      fog: true,
    }),
  );
  const smoke = new PuffLayer(high ? 2400 : 1200, smokeMat, 'fx-smoke');
  smoke.mesh.renderOrder = 2;
  smoke.mesh.onBeforeRender = (renderer, _scene, camera) => bindSoftParticles(renderer, camera, smokeMat);

  // ---------------- spray ----------------
  const sprayMat = premultipliedBlend(
    new THREE.ShaderMaterial({
      name: 'fx-spray',
      uniforms: {
        ...fogUniforms(),
        uTime,
        uWind,
        uCamVel,
        ...softParticleUniforms(),
        uTex: { value: puffTex },
        uViewport: { value: new THREE.Vector2(1920, 1080) },
        uDrag: { value: new THREE.Vector2(1.6, 0.9) },
        uAccelMist: { value: new THREE.Vector3(0, -0.25, 0) },
        uAccelDrop: { value: new THREE.Vector3(0, -9.81, 0) },
        uShutter: { value: 1 / 50 },
        uMistColor: { value: new THREE.Color(0.28, 0.3, 0.34) },
        uDropColor: { value: new THREE.Color(0.55, 0.62, 0.75) },
        uTailColor: { value: new THREE.Color(0.2, 0.008, 0.012) },
        uNear: { value: new THREE.Vector4(0.5, 0.3, 0.6, 1.1) },
      },
      vertexShader: SPRAY_VS,
      fragmentShader: SPRAY_FS,
      fog: true,
    }),
  );
  const spray = new PuffLayer(high ? 3600 : 1800, sprayMat, 'fx-spray');
  spray.mesh.renderOrder = 3;
  const sprayViewport = setViewportUniform(sprayMat);
  spray.mesh.onBeforeRender = (renderer, _scene, camera) => {
    sprayViewport(renderer);
    bindSoftParticles(renderer, camera, sprayMat);
  };

  // ---------------- hot (sparks + flames + embers) ----------------
  const SPARK_CAP = high ? 800 : 400;
  const FLAME_SLOTS = 24;
  const FLAME_INST = 3; // outer body, inner core, nozzle glow
  const HOT_CAP = SPARK_CAP + FLAME_SLOTS * FLAME_INST;
  const hotData = new Float32Array(HOT_CAP * HOT_STRIDE);
  const hotBuf = new THREE.InstancedInterleavedBuffer(hotData, HOT_STRIDE, 1).setUsage(THREE.DynamicDrawUsage);
  const hotGeo = createInstancedQuadGeometry(hotBuf, HOT_STRIDE, ['iA', 'iB', 'iC']);
  const hotMat = new THREE.ShaderMaterial({
    name: 'fx-hot',
    uniforms: { ...fogUniforms(), uTime, uViewport: { value: new THREE.Vector2(1920, 1080) } },
    vertexShader: HOT_VS,
    fragmentShader: HOT_FS,
    fog: true,
  });
  premultipliedBlend(hotMat);
  const hotMesh = new THREE.Mesh(hotGeo, hotMat);
  hotMesh.name = 'fx-hot';
  hotMesh.frustumCulled = false;
  hotMesh.visible = false;
  hotMesh.renderOrder = 4;
  hotMesh.onBeforeRender = setViewportUniform(hotMat);

  // spark CPU state
  const sp = {
    px: new Float32Array(SPARK_CAP), py: new Float32Array(SPARK_CAP), pz: new Float32Array(SPARK_CAP),
    vx: new Float32Array(SPARK_CAP), vy: new Float32Array(SPARK_CAP), vz: new Float32Array(SPARK_CAP),
    age: new Float32Array(SPARK_CAP), life: new Float32Array(SPARK_CAP), size: new Float32Array(SPARK_CAP),
    heat: new Float32Array(SPARK_CAP), kind: new Uint8Array(SPARK_CAP), // 0 = spark, 1 = nitro ember
    head: 0, alive: 0,
  };
  sp.life.fill(0);
  sp.age.fill(1);

  // flame slots (matched to exhausts by proximity, so a flame stays attached to its exhaust)
  const fl = {
    px: new Float32Array(FLAME_SLOTS), py: new Float32Array(FLAME_SLOTS), pz: new Float32Array(FLAME_SLOTS),
    dx: new Float32Array(FLAME_SLOTS), dy: new Float32Array(FLAME_SLOTS), dz: new Float32Array(FLAME_SLOTS),
    vx: new Float32Array(FLAME_SLOTS), vy: new Float32Array(FLAME_SLOTS), vz: new Float32Array(FLAME_SLOTS),
    inten: new Float32Array(FLAME_SLOTS), sinceRefresh: new Float32Array(FLAME_SLOTS).fill(99),
    refreshed: new Uint8Array(FLAME_SLOTS), emitTime: new Float32Array(FLAME_SLOTS),
    seed: new Float32Array(FLAME_SLOTS), level: new Float32Array(FLAME_SLOTS),
    hasVel: new Uint8Array(FLAME_SLOTS), // 1 once the slot's velocity was measured from two emissions
  };

  // ---------------- skids ----------------
  const SKID_CAP = high ? 4000 : 2000;
  const skidData = new Float32Array(SKID_CAP * 4 * SKID_STRIDE);
  for (let i = 0; i < SKID_CAP * 4; i++) skidData[i * SKID_STRIDE + 3] = -1e6;
  const skidBuf = new THREE.InterleavedBuffer(skidData, SKID_STRIDE).setUsage(THREE.DynamicDrawUsage);
  const skidGeo = new THREE.BufferGeometry();
  skidGeo.setAttribute('sA', new THREE.InterleavedBufferAttribute(skidBuf, 4, 0));
  skidGeo.setAttribute('sB', new THREE.InterleavedBufferAttribute(skidBuf, 4, 4));
  // three needs a 'position' attribute to know the vertex count
  skidGeo.setAttribute('position', new THREE.InterleavedBufferAttribute(skidBuf, 3, 0));
  const skidIndex = new (SKID_CAP * 4 > 65535 ? Uint32Array : Uint16Array)(SKID_CAP * 6);
  for (let i = 0; i < SKID_CAP; i++) {
    const v = i * 4, o = i * 6;
    skidIndex[o] = v; skidIndex[o + 1] = v + 2; skidIndex[o + 2] = v + 1;
    skidIndex[o + 3] = v + 1; skidIndex[o + 4] = v + 2; skidIndex[o + 5] = v + 3;
  }
  skidGeo.setIndex(new THREE.BufferAttribute(skidIndex, 1));
  skidGeo.setDrawRange(0, 0);
  const skidMat = premultipliedBlend(
    new THREE.ShaderMaterial({
      name: 'fx-skids',
      uniforms: {
        ...fogUniforms(),
        uTime,
        uHead: { value: 0 },
        uCapacity: { value: SKID_CAP },
        uLifetime: { value: 120 },
        uColor: { value: new THREE.Color(0.003, 0.003, 0.0035) },
        uOpacity: { value: 0.9 },
      },
      vertexShader: SKID_VS,
      fragmentShader: SKID_FS,
      fog: true,
    }),
  );
  skidMat.polygonOffset = true;
  skidMat.polygonOffsetFactor = -2;
  skidMat.polygonOffsetUnits = -4;
  skidMat.side = THREE.DoubleSide;
  const skidMesh = new THREE.Mesh(skidGeo, skidMat);
  skidMesh.name = 'fx-skids';
  skidMesh.frustumCulled = false;
  skidMesh.renderOrder = -1; // ground layer: before other transparents
  skidMesh.visible = false;
  const skid = { head: 0, used: 0, dirtyStart: -1, dirtyCount: 0, tracks: new Map() };
  const SKID_HALF_W = 0.13;
  const SKID_Y = 0.012;

  group.add(skidMesh, smoke.mesh, spray.mesh, hotMesh);
  // game cameras see this layer, the wet-road reflection camera doesn't (see CONTRACTS.md "Render layers")
  for (const m of [skidMesh, smoke.mesh, spray.mesh, hotMesh]) m.layers.set(LAYERS.NO_REFLECTION);

  // ---------------- state ----------------
  let time = 0;
  let frameDt = 1 / 60;
  let frame = 0;
  const camPos = new THREE.Vector3();
  const lastCamPos = new THREE.Vector3();
  let haveCam = false;
  const camVelRaw = new THREE.Vector3();
  const rnd = Math.random;
  const lodScale = (x, y, z) => {
    if (!haveCam) return 1;
    const dx = x - camPos.x, dy = y - camPos.y, dz = z - camPos.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return d < 25 ? 1 : Math.max(0.12, 1 - (d - 25) / 90);
  };
  // stochastic rounding: unbiased particle counts at any frame rate
  const countFor = (rate) => {
    const x = rate * frameDt;
    const n = Math.floor(x);
    return n + (rnd() < x - n ? 1 : 0);
  };
  const vx = (v) => (v ? v.x || 0 : 0);
  const vy = (v) => (v ? v.y || 0 : 0);
  const vz = (v) => (v ? v.z || 0 : 0);

  // ---------------- emitters ----------------
  function emitSmoke(position, velocity, intensity = 1) {
    if (!position || !(intensity > 0)) return;
    const I = Math.min(intensity, 1.5);
    const px = position.x, py = position.y || 0, pz = position.z;
    const ex = vx(velocity), ey = vy(velocity), ez = vz(velocity);
    const lod = lodScale(px, py, pz);
    const n = countFor((high ? 36 : 20) * I * lod);
    const D = smoke.data;
    for (let k = 0; k < n; k++) {
      const tau = rnd() * frameDt; // sub-frame spawn time: continuous trails at any speed
      const life = 2.2 + rnd() * 1.6;
      const o = smoke.alloc(time + frameDt + life);
      D[o] = px - ex * tau + (rnd() - 0.5) * 0.3;
      D[o + 1] = Math.max(0.1, py + 0.12 + rnd() * 0.15);
      D[o + 2] = pz - ez * tau + (rnd() - 0.5) * 0.3;
      D[o + 3] = time + frameDt - tau;
      // smoke is dragged along in the car's wake, then billows out sideways and up
      D[o + 4] = ex * 0.35 + (rnd() - 0.5) * 3.2;
      D[o + 5] = ey * 0.3 + 0.6 + rnd() * 1.4;
      D[o + 6] = ez * 0.35 + (rnd() - 0.5) * 3.2;
      D[o + 7] = life;
      const big = 1 / Math.max(lod, 0.35); // far emitters spawn fewer, bigger puffs
      D[o + 8] = (0.8 + rnd() * 0.5) * Math.min(big, 1.6);
      D[o + 9] = (4.2 + rnd() * 2.8) * Math.min(big, 1.4);
      D[o + 10] = rnd() * 6.283;
      D[o + 11] = (rnd() - 0.5) * 0.8;
      D[o + 12] = rnd();
      D[o + 13] = Math.min(1, (0.28 + rnd() * 0.14) * Math.min(I, 1) * Math.min(big, 1.5));
      D[o + 14] = 0;
      D[o + 15] = 1; // tail-light pick-up
    }
  }

  function emitSpray(position, velocity, intensity = 1) {
    if (!position || !(intensity > 0)) return;
    const px = position.x, py = position.y || 0, pz = position.z;
    const ex = vx(velocity), ey = vy(velocity), ez = vz(velocity);
    const speed = Math.sqrt(ex * ex + ez * ez);
    // spray scales with speed; a little even when slow if the caller insists (intensity > 1)
    const s = Math.min(1.5, intensity * Math.min(1, Math.max(0.15, (speed - 2) / 22)));
    if (s <= 0.01) return;
    const lod = lodScale(px, py, pz);
    const inv = speed > 0.1 ? 1 / speed : 0;
    const fx = ex * inv, fz = ez * inv; // travel direction
    const D = spray.data;
    // --- mist ---
    const nm = countFor((high ? 46 : 26) * s * lod);
    for (let k = 0; k < nm; k++) {
      const tau = rnd() * frameDt;
      const life = 1.0 + rnd() * 0.9;
      const o = spray.alloc(time + frameDt + life);
      const side = (rnd() - 0.5) * 1.6;
      D[o] = px - ex * tau - fz * side * 0.15;
      D[o + 1] = py + 0.15 + rnd() * 0.25;
      D[o + 2] = pz - ez * tau + fx * side * 0.15;
      D[o + 3] = time + frameDt - tau;
      // flung off the tread and dragged along in the car's wake (exaggerated so the plume hangs behind the
      // car instead of instantly whipping past the chase camera), rises and spreads sideways
      const inh = 0.68 + rnd() * 0.18;
      D[o + 4] = ex * inh - fz * side * 1.5 + (rnd() - 0.5) * 0.8;
      D[o + 5] = ey * 0.2 + 0.5 + rnd() * 1.4;
      D[o + 6] = ez * inh + fx * side * 1.5 + (rnd() - 0.5) * 0.8;
      D[o + 7] = life;
      const big = 1 / Math.max(lod, 0.4);
      D[o + 8] = 0.6 + rnd() * 0.35;
      D[o + 9] = (2.4 + rnd() * 1.6) * Math.min(big, 1.5) * (0.7 + 0.3 * Math.min(speed / 50, 1.4));
      D[o + 10] = rnd() * 6.283;
      D[o + 11] = (rnd() - 0.5) * 1.2;
      D[o + 12] = rnd();
      D[o + 13] = Math.min(0.6, (0.16 + rnd() * 0.1) * Math.min(s, 1.2) * Math.min(big, 1.6));
      D[o + 14] = 0;
      D[o + 15] = 1; // tail-light pick-up
    }
    // --- droplets (near the camera only: they're sub-pixel further away) ---
    if (lod > 0.45) {
      const nd = countFor((high ? 130 : 60) * s * lod);
      for (let k = 0; k < nd; k++) {
        const tau = rnd() * frameDt;
        const life = 0.3 + rnd() * 0.35;
        const o = spray.alloc(time + frameDt + life);
        const side = (rnd() - 0.5) * 1.4;
        D[o] = px - ex * tau - fz * side * 0.1;
        D[o + 1] = py + 0.1 + rnd() * 0.35;
        D[o + 2] = pz - ez * tau + fx * side * 0.1;
        D[o + 3] = time + frameDt - tau;
        const inh = 0.6 + rnd() * 0.25;
        D[o + 4] = ex * inh - fz * side * 2.0 + (rnd() - 0.5) * 1.2;
        D[o + 5] = 1.2 + rnd() * 3.2;
        D[o + 6] = ez * inh + fx * side * 2.0 + (rnd() - 0.5) * 1.2;
        D[o + 7] = life;
        D[o + 8] = 0.008 + rnd() * 0.01; // width (m)
        D[o + 9] = 0;
        D[o + 10] = 0;
        D[o + 11] = 0;
        D[o + 12] = rnd();
        D[o + 13] = (0.35 + rnd() * 0.5) * Math.min(s, 1.2);
        D[o + 14] = 1;
        D[o + 15] = 1;
      }
    }
  }

  function spawnSpark(x, y, z, vxx, vyy, vzz, life, size, heat, kind) {
    const i = sp.head;
    sp.head = (i + 1) % SPARK_CAP;
    sp.px[i] = x; sp.py[i] = y; sp.pz[i] = z;
    sp.vx[i] = vxx; sp.vy[i] = vyy; sp.vz[i] = vzz;
    sp.age[i] = 0; sp.life[i] = life; sp.size[i] = size; sp.heat[i] = heat; sp.kind[i] = kind;
  }

  let lastSparkTime = -1;
  // emitSparks(position, normal, intensity, velocity?) — optional 4th arg: the scraping car's world velocity.
  // Without it, sparks near the camera inherit the camera's motion (the player is almost always the one scraping).
  function emitSparks(position, normal, intensity = 1, velocity) {
    if (!position || !(intensity > 0)) return;
    const I = Math.min(intensity, 2);
    const continuous = time - lastSparkTime < 0.12;
    lastSparkTime = time;
    // continuous scraping is rate-based (frame-rate independent); a fresh hit is a burst
    const n = continuous ? countFor(380 * I) : Math.round(I * 34 * (0.6 + 0.8 * rnd()));
    let ix = 0, iy = 0, iz = 0;
    if (velocity) {
      ix = vx(velocity); iy = vy(velocity); iz = vz(velocity);
    } else if (haveCam) {
      const dx = position.x - camPos.x, dz = position.z - camPos.z;
      if (dx * dx + dz * dz < 400) { ix = camVelRaw.x; iz = camVelRaw.z; }
    }
    let nx = vx(normal), ny = vy(normal), nz = vz(normal);
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    for (let k = 0; k < n; k++) {
      const sp0 = 2 + rnd() * 7 * I;
      const tx = (rnd() - 0.5) * 7, tz = (rnd() - 0.5) * 7;
      spawnSpark(
        position.x + (rnd() - 0.5) * 0.15, Math.max(0.03, (position.y || 0.35) + (rnd() - 0.5) * 0.2), position.z + (rnd() - 0.5) * 0.15,
        ix * (0.75 + rnd() * 0.2) + nx * sp0 + tx,
        iy * 0.5 + ny * sp0 + 1 + rnd() * 4.5,
        iz * (0.75 + rnd() * 0.2) + nz * sp0 + tz,
        0.25 + rnd() * 0.6, 0.016 + rnd() * 0.018, 0.75 + rnd() * 0.25, 0,
      );
    }
  }

  // emitNitroFlame(position, direction, intensity, velocity?): call every frame while nitro burns (one call per
  // exhaust). Calls are matched to persistent slots so each flame stays glued to its exhaust tip; a slot keeps
  // dead-reckoning and fades for ~0.12 s after its last call (a single call = a short burst).
  // At 80 m/s an exhaust moves ~1.3 m per frame, so a slot whose velocity isn't known yet (first frame) is matched
  // along the car's line of travel instead of by plain distance: the flame points backwards, so the tip must have
  // moved forward (−direction) with only a small sideways drift. Nearest-sideways wins, so neighbouring tips never
  // swap. (Before, every fresh slot predicted zero motion, never matched again and stayed behind in world space —
  // a trail of stale flames on the road behind every car on nitro that read as huge "reflections".)
  // Optional `velocity` (the car's world velocity) makes the very first frame exact as well.
  function emitNitroFlame(position, direction, intensity = 1, velocity) {
    if (!position || !(intensity > 0)) return;
    let dx = vx(direction), dy = vy(direction), dz = vz(direction);
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    const py0 = position.y || 0;
    const hasV = !!velocity;
    let best = -1, bestD = Infinity;
    let free = -1, oldest = -1, oldestT = -1;
    for (let i = 0; i < FLAME_SLOTS; i++) {
      if (fl.sinceRefresh[i] > 0.3) { if (free < 0) free = i; continue; }
      if (fl.refreshed[i]) continue; // already matched since the last update
      if (fl.sinceRefresh[i] > oldestT) { oldestT = fl.sinceRefresh[i]; oldest = i; }
      const te = time - fl.emitTime[i];
      let score;
      if (fl.hasVel[i]) {
        // predicted position: last emission + measured velocity × time since then
        const ex = fl.px[i] + fl.vx[i] * te - position.x;
        const ey = fl.py[i] + fl.vy[i] * te - py0;
        const ez = fl.pz[i] + fl.vz[i] * te - position.z;
        score = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (score > 0.6) continue;
      } else {
        // displacement since the last emission, split along / across the direction of travel (−direction)
        const mx = position.x - fl.px[i], my = py0 - fl.py[i], mz = position.z - fl.pz[i];
        const along = -(mx * dx + my * dy + mz * dz);
        if (along < -0.3 || along > 0.3 + 120 * Math.max(te, 1 / 60)) continue;
        const ax = mx + dx * along, ay = my + dy * along, az = mz + dz * along;
        score = Math.sqrt(ax * ax + ay * ay + az * az);
        if (score > 0.15 + 0.35 * Math.max(along, 0)) continue;
      }
      if (score < bestD) { bestD = score; best = i; }
    }
    let i = best;
    if (i < 0) {
      i = free >= 0 ? free : oldest >= 0 ? oldest : 0;
      // initial motion for dead reckoning: the caller's velocity, else the camera's when the emitter is near it
      // (the chase camera rides with the player's car), else none
      let pvx = 0, pvy = 0, pvz = 0;
      if (hasV) { pvx = vx(velocity); pvy = vy(velocity); pvz = vz(velocity); }
      else if (haveCam) {
        const cx = position.x - camPos.x, cz = position.z - camPos.z;
        if (cx * cx + cz * cz < 45 * 45) { pvx = camVelRaw.x; pvy = camVelRaw.y; pvz = camVelRaw.z; }
      }
      fl.vx[i] = pvx; fl.vy[i] = pvy; fl.vz[i] = pvz;
      fl.hasVel[i] = hasV ? 1 : 0;
      fl.seed[i] = rnd() * 100;
      fl.level[i] = 0;
    } else if (hasV) {
      fl.vx[i] = vx(velocity); fl.vy[i] = vy(velocity); fl.vz[i] = vz(velocity);
      fl.hasVel[i] = 1;
    } else if (time - fl.emitTime[i] > 1e-4) {
      // velocity estimate for dead reckoning between calls
      const inv = 1 / (time - fl.emitTime[i]);
      const nvx = (position.x - fl.px[i]) * inv, nvy = (py0 - fl.py[i]) * inv, nvz = (position.z - fl.pz[i]) * inv;
      const k = fl.hasVel[i] ? 0.7 : 1;
      fl.vx[i] += (nvx - fl.vx[i]) * k; fl.vy[i] += (nvy - fl.vy[i]) * k; fl.vz[i] += (nvz - fl.vz[i]) * k;
      fl.hasVel[i] = 1;
    }
    fl.px[i] = position.x; fl.py[i] = position.y || 0; fl.pz[i] = position.z;
    fl.dx[i] = dx; fl.dy[i] = dy; fl.dz[i] = dz;
    fl.inten[i] = Math.min(intensity, 1.5);
    fl.sinceRefresh[i] = 0;
    fl.refreshed[i] = 1;
    fl.emitTime[i] = time;
    // a few drifting blue embers / afterburn
    if (rnd() < 13 * frameDt * intensity) {
      spawnSpark(
        position.x + dx * 0.5, (position.y || 0) + dy * 0.5, position.z + dz * 0.5,
        fl.vx[i] * 0.9 + dx * (2 + rnd() * 3) + (rnd() - 0.5) * 1.2,
        fl.vy[i] * 0.9 + dy * 2 + 0.2 + rnd() * 0.8,
        fl.vz[i] * 0.9 + dz * (2 + rnd() * 3) + (rnd() - 0.5) * 1.2,
        0.08 + rnd() * 0.1, 0.012 + rnd() * 0.012, 1, 1,
      );
    }
  }

  function writeSkidVertex(v, x, z, birth, across, along, alpha) {
    const o = v * SKID_STRIDE;
    skidData[o] = x; skidData[o + 1] = SKID_Y; skidData[o + 2] = z; skidData[o + 3] = birth;
    skidData[o + 4] = across; skidData[o + 5] = along; skidData[o + 6] = alpha; skidData[o + 7] = 0;
  }

  function addSkidMark(trackId, position, right, intensity = 1) {
    if (trackId === undefined || !position) return;
    const id = String(trackId);
    if (!(intensity > 0.02)) { skid.tracks.delete(id); return; }
    let rx = vx(right), rz = vz(right);
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    const x = position.x, z = position.z;
    const a = Math.min(1, intensity);
    const st = skid.tracks.get(id);
    if (!st) {
      skid.tracks.set(id, { x, z, rx, rz, a, along: 0 });
      return;
    }
    const ddx = x - st.x, ddz = z - st.z;
    const d2 = ddx * ddx + ddz * ddz;
    if (d2 > 36) { st.x = x; st.z = z; st.rx = rx; st.rz = rz; st.a = a; return; } // teleport / reset: new strip
    if (d2 < 0.2 * 0.2) { st.a = Math.max(st.a, a * 0.5); return; }
    const d = Math.sqrt(d2);
    const seg = skid.head;
    skid.head = (seg + 1) % SKID_CAP;
    if (skid.used < SKID_CAP) skid.used++;
    if (skid.dirtyStart < 0) skid.dirtyStart = seg;
    if (skid.dirtyCount < SKID_CAP) skid.dirtyCount++;
    const v0 = seg * 4;
    const along1 = st.along + d;
    writeSkidVertex(v0, st.x + st.rx * SKID_HALF_W, st.z + st.rz * SKID_HALF_W, time, 1, st.along, st.a);
    writeSkidVertex(v0 + 1, st.x - st.rx * SKID_HALF_W, st.z - st.rz * SKID_HALF_W, time, -1, st.along, st.a);
    writeSkidVertex(v0 + 2, x + rx * SKID_HALF_W, z + rz * SKID_HALF_W, time, 1, along1, a);
    writeSkidVertex(v0 + 3, x - rx * SKID_HALF_W, z - rz * SKID_HALF_W, time, -1, along1, a);
    st.x = x; st.z = z; st.rx = rx; st.rz = rz; st.a = a; st.along = along1 % 1000;
  }

  // ---------------- per-frame ----------------
  const tmpV = new THREE.Vector3();

  function updateSparks(dt) {
    let n = 0;
    const D = hotData;
    const g = 9.81;
    for (let i = 0; i < SPARK_CAP; i++) {
      if (sp.age[i] >= sp.life[i]) continue;
      sp.age[i] += dt;
      if (sp.age[i] >= sp.life[i]) continue;
      const kind = sp.kind[i];
      const drag = kind === 1 ? 3.5 : 0.9;
      const f = Math.exp(-drag * dt);
      sp.vx[i] *= f; sp.vz[i] *= f;
      sp.vy[i] = sp.vy[i] * f - (kind === 1 ? -0.5 : g) * dt;
      sp.px[i] += sp.vx[i] * dt; sp.py[i] += sp.vy[i] * dt; sp.pz[i] += sp.vz[i] * dt;
      if (sp.py[i] < 0.01 && kind === 0) {
        sp.py[i] = 0.01;
        if (sp.vy[i] < 0) {
          sp.vy[i] *= -0.32;
          sp.vx[i] *= 0.65; sp.vz[i] *= 0.65;
        }
        sp.age[i] += 0.04; // cool down on impact
      }
      const x = sp.age[i] / sp.life[i];
      const o = n * HOT_STRIDE;
      // streak = camera-relative motion blur
      const sh = 0.016;
      const rvx = sp.vx[i] - camVelRaw.x, rvy = sp.vy[i] - camVelRaw.y, rvz = sp.vz[i] - camVelRaw.z;
      let lx = rvx * sh, ly = rvy * sh, lz = rvz * sh;
      const ll = Math.sqrt(lx * lx + ly * ly + lz * lz);
      if (ll > 0.5) { const s = 0.5 / ll; lx *= s; ly *= s; lz *= s; }
      D[o] = sp.px[i]; D[o + 1] = sp.py[i]; D[o + 2] = sp.pz[i];
      D[o + 3] = sp.size[i] * (kind === 1 ? 1 + x * 2 : 1);
      D[o + 4] = sp.px[i] - lx; D[o + 5] = sp.py[i] - ly; D[o + 6] = sp.pz[i] - lz;
      if (kind === 0) {
        // blackbody-ish cooling: white-yellow → orange → deep red
        const h = sp.heat[i] * (1 - x);
        D[o + 7] = 1 - x * x;
        D[o + 8] = 16 * Math.min(1, h * 1.6);
        D[o + 9] = 16 * Math.max(0.06, h * h * 0.7);
        D[o + 10] = 16 * Math.max(0.0, h * h * h * 0.3);
        D[o + 11] = 0;
      } else {
        D[o + 7] = (1 - x) * (1 - x) * 0.7;
        D[o + 8] = 1.4; D[o + 9] = 1.3; D[o + 10] = 5;
        D[o + 11] = 2;
      }
      n++;
    }
    sp.alive = n;
    return n;
  }

  function updateFlames(dt, n0) {
    let n = n0;
    const D = hotData;
    for (let i = 0; i < FLAME_SLOTS; i++) {
      if (fl.sinceRefresh[i] > 0.3) continue;
      if (fl.refreshed[i]) fl.sinceRefresh[i] = 0;
      else fl.sinceRefresh[i] += dt;
      fl.refreshed[i] = 0;
      const t = fl.sinceRefresh[i];
      // attack fast, release over ~0.12 s
      const target = t < 0.04 ? fl.inten[i] : 0;
      fl.level[i] += (target - fl.level[i]) * (1 - Math.exp(-(target > fl.level[i] ? 30 : 14) * dt));
      const L = fl.level[i];
      if (L < 0.01 && t > 0.05) { fl.sinceRefresh[i] = 99; continue; }
      const x = fl.px[i] + fl.vx[i] * t, y = fl.py[i] + fl.vy[i] * t, z = fl.pz[i] + fl.vz[i] * t;
      const dx = fl.dx[i], dy = fl.dy[i], dz = fl.dz[i];
      // flicker: a few incommensurate sines + a little per-frame noise (pure noise strobes at 60 fps)
      const ph = fl.seed[i] + time;
      const flick = 0.86 + 0.09 * Math.sin(ph * 47) + 0.07 * Math.sin(ph * 83 + 1.3) + 0.08 * (rnd() - 0.5);
      const len = (0.5 + 0.4 * L) * flick;
      // outer body: blue → violet, soft and wide
      let o = n * HOT_STRIDE;
      D[o] = x; D[o + 1] = y; D[o + 2] = z; D[o + 3] = 0.3 * (0.9 + 0.2 * Math.sin(ph * 61)) * (0.7 + 0.3 * L);
      D[o + 4] = x + dx * len; D[o + 5] = y + dy * len; D[o + 6] = z + dz * len; D[o + 7] = L;
      // HDR kept moderate (≈ lum 0.5): the flame reads hot through the bloom without flooding the frame
      D[o + 8] = 0.16; D[o + 9] = 0.42; D[o + 10] = 2.6; D[o + 11] = 1;
      n++;
      // inner core: short, white-cyan, very hot
      o = n * HOT_STRIDE;
      const lc = len * (0.5 + 0.06 * Math.sin(ph * 71));
      D[o] = x; D[o + 1] = y; D[o + 2] = z; D[o + 3] = 0.11;
      D[o + 4] = x + dx * lc; D[o + 5] = y + dy * lc; D[o + 6] = z + dz * lc; D[o + 7] = L;
      D[o + 8] = 0.35; D[o + 9] = 0.8; D[o + 10] = 2.8; D[o + 11] = 1;
      n++;
      // nozzle glow (lights the bumper area; bloom does the rest)
      o = n * HOT_STRIDE;
      D[o] = x - dx * 0.02; D[o + 1] = y - dy * 0.02; D[o + 2] = z - dz * 0.02; D[o + 3] = 0.34 * flick;
      D[o + 4] = x + dx * 0.08; D[o + 5] = y + dy * 0.08; D[o + 6] = z + dz * 0.08; D[o + 7] = L * 0.5;
      D[o + 8] = 0.25; D[o + 9] = 0.45; D[o + 10] = 2.2; D[o + 11] = 2;
      n++;
    }
    return n;
  }

  function flushSkids() {
    if (skid.dirtyCount > 0) {
      skidBuf.clearUpdateRanges();
      const s = skid.dirtyStart, c = skid.dirtyCount, F = 4 * SKID_STRIDE;
      if (s + c <= SKID_CAP) skidBuf.addUpdateRange(s * F, c * F);
      else {
        skidBuf.addUpdateRange(s * F, (SKID_CAP - s) * F);
        skidBuf.addUpdateRange(0, (s + c - SKID_CAP) * F);
      }
      skidBuf.needsUpdate = true;
      skid.dirtyStart = -1;
      skid.dirtyCount = 0;
    }
    skidGeo.setDrawRange(0, skid.used * 6);
    skidMat.uniforms.uHead.value = skid.head;
    skidMesh.visible = skid.used > 0;
  }

  function update(dt = 1 / 60, camera) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    if (dt > 0) frameDt = dt;
    time += dt;
    frame++;
    uTime.value = time;
    if (camera) {
      camera.getWorldPosition(tmpV);
      if (haveCam && dt > 0) {
        const ivx = (tmpV.x - lastCamPos.x) / dt, ivy = (tmpV.y - lastCamPos.y) / dt, ivz = (tmpV.z - lastCamPos.z) / dt;
        // reject camera cuts (teleports) and smooth the estimate
        if (ivx * ivx + ivy * ivy + ivz * ivz < 150 * 150) {
          const k = 1 - Math.exp(-12 * dt);
          camVelRaw.x += (ivx - camVelRaw.x) * k;
          camVelRaw.y += (ivy - camVelRaw.y) * k;
          camVelRaw.z += (ivz - camVelRaw.z) * k;
        }
      }
      lastCamPos.copy(tmpV);
      camPos.copy(tmpV);
      haveCam = true;
    }
    uCamVel.value.copy(camVelRaw);

    smoke.flush(time);
    spray.flush(time);

    const ns = updateSparks(dt);
    const nTotal = updateFlames(dt, ns);
    if (nTotal > 0) {
      hotBuf.clearUpdateRanges();
      hotBuf.addUpdateRange(0, nTotal * HOT_STRIDE);
      hotBuf.needsUpdate = true;
    }
    hotGeo.instanceCount = nTotal;
    hotMesh.visible = nTotal > 0;

    flushSkids();
  }

  function clear() {
    smoke.clear();
    spray.clear();
    sp.age.fill(1);
    sp.life.fill(0);
    fl.sinceRefresh.fill(99);
    fl.refreshed.fill(0);
    fl.hasVel.fill(0);
    skid.tracks.clear();
    for (let i = 0; i < SKID_CAP * 4; i++) skidData[i * SKID_STRIDE + 6] = 0;
    skidBuf.clearUpdateRanges();
    skidBuf.needsUpdate = true;
    skid.used = 0;
    skid.head = 0;
    skid.dirtyStart = -1;
    skid.dirtyCount = 0;
    skidGeo.setDrawRange(0, 0);
    skidMesh.visible = false;
    hotMesh.visible = false;
  }

  return {
    group,
    emitSmoke,
    emitSpray,
    emitSparks,
    emitNitroFlame,
    addSkidMark,
    update,
    clear,
    // tuning handles (optional)
    uniforms: {
      wind: uWind.value,
      smokeColor: smokeMat.uniforms.uColor.value,
      mistColor: sprayMat.uniforms.uMistColor.value,
      smokeNear: smokeMat.uniforms.uNear.value,
      mistNear: sprayMat.uniforms.uNear.value,
    },
    meshes: { smoke: smoke.mesh, spray: spray.mesh, hot: hotMesh, skids: skidMesh },
    stats() {
      return {
        smoke: smoke.mesh.visible ? smoke.used : 0,
        spray: spray.mesh.visible ? spray.used : 0,
        hot: hotGeo.instanceCount,
        flames: fl.sinceRefresh.reduce((n, t) => n + (t <= 0.3 ? 1 : 0), 0),
        skids: skid.used,
        drawCalls: [smoke.mesh, spray.mesh, hotMesh, skidMesh].filter((m) => m.visible).length,
      };
    },
    dispose() {
      group.removeFromParent();
      [smokeMat, sprayMat, hotMat, skidMat].forEach((m) => m.dispose());
      [smoke.geometry, spray.geometry, hotGeo, skidGeo].forEach((g) => g.dispose());
      puffTex.dispose();
    },
  };
}
