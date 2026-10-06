// MIDNIGHT APEX — camera-following rain (owner: fx).
//
// Draw calls: 2 (streaks + splashes), zero CPU work per drop.
//  • Streaks: one InstancedMesh-style draw of N thin capsule quads. Every drop has a fixed random seed; its world
//    position is seed·box + fall offset (offset accumulated on the CPU in double precision, per speed class), then
//    wrapped into a box that follows the camera (vertex shader `mod`). Drops are therefore world-stable (correct
//    parallax when driving through them) yet always surround the camera. Each drop is drawn as a motion-blur streak
//    along its velocity *relative to the camera*: at speed the rain rushes at you in long radial streaks.
//    Pixel-accurate width with a 0.8 px floor + coverage fade (no aliasing shimmer), refraction-ish bright rims
//    on near drops, optional headlight-beam lighting, edge fades to hide wrap-around.
//  • Splashes: instanced ripple rings on the road + tiny crown bounces, laid out in world-space tiles around the
//    camera with hashed positions per (tile, index, cycle) — fully shader-animated and world-stable.
// Both meshes live on LAYERS.NO_REFLECTION: the wet-road planar reflection skips them (a mirrored 14k-instance
// rain draw costs real time and the reflection of falling streaks is invisible on real wet asphalt anyway).
import * as THREE from 'three';
import { LAYERS } from '../config.js';

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

const LIGHT_PARS = /* glsl */ `
uniform vec3 uHeadPos;
uniform vec3 uHeadDir;
uniform float uHeadOn;
// fake headlight beam: bright inside a widening cone in front of the car
float headlight(vec3 p) {
  vec3 v = p - uHeadPos;
  float along = dot(v, uHeadDir);
  if (along <= 0.2 || uHeadOn < 0.5) return 0.0;
  float lat = length(v - uHeadDir * along);
  float cone = 1.0 - smoothstep(0.25 * along + 0.5, 0.42 * along + 1.2, lat);
  float range = 1.0 - smoothstep(6.0, 45.0, along);
  return cone * range * range;
}
`;

const STREAK_VS = /* glsl */ `
attribute vec4 aSeed; // xyz = position in box (0..1), w = random (intensity cull / brightness)
uniform vec3 uBox;
uniform vec3 uCenter;
uniform vec3 uOffsets[3];
uniform vec3 uFall;
uniform vec3 uCamVel;
uniform float uShutter;
uniform float uMaxLen;
uniform float uIntensity;
uniform float uWidth;
uniform vec2 uViewport;
${LIGHT_PARS}
varying vec4 vSeg;
varying vec3 vSegInfo;
varying float vBright;
varying float vFogDepth;
varying vec3 vTint;
void main() {
  if (aSeed.w > uIntensity) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float r2 = fract(aSeed.x * 91.7 + aSeed.y * 13.3);
  float r3 = fract(aSeed.z * 47.1 + aSeed.w * 7.9);
  int cls = int(r2 * 2.999);
  float speedK = cls == 0 ? 0.82 : (cls == 1 ? 1.0 : 1.18);
  vec3 p0 = aSeed.xyz * uBox + uOffsets[cls];
  vec3 rel = mod(p0 - uCenter + 0.5 * uBox, uBox) - 0.5 * uBox;
  vec3 p = uCenter + rel;
  if (p.y < -0.05) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec3 e = abs(rel) / (0.5 * uBox);
  float edge = (1.0 - smoothstep(0.7, 1.0, max(e.x, e.z))) * (1.0 - smoothstep(0.8, 1.0, e.y));
  vec3 vr = uFall * speedK - uCamVel;
  vec3 tail = vr * uShutter;
  float tl = length(tail);
  if (tl > uMaxLen) tail *= uMaxLen / tl;
  vec3 a = (viewMatrix * vec4(p, 1.0)).xyz;
  vec3 b = (viewMatrix * vec4(p - tail, 1.0)).xyz;
  if (a.z > -0.12 && b.z > -0.12) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  if (a.z > -0.12) { vec3 t = a; a = b; b = t; }
  // --- capsule quad in screen space (see particles.js segmentQuad) ---
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
  vec2 q = position.xy * 2.0;
  float t = q.y * 0.5 + 0.5;
  vec4 c = mix(ca, cb, t);
  float w = uWidth * (0.7 + 0.6 * r3);
  float trueW = 0.5 * w * projectionMatrix[1][1] * hv.y / c.w;
  float wpx = max(trueW, 0.8);
  float along = t * len + q.y * wpx;
  c.xy += (perp * q.x * wpx + dir * q.y * wpx) * c.w / hv;
  gl_Position = c;
  vSeg = vec4(q.x * wpx * c.w, along * c.w, c.w, 0.0);
  float cover = clamp(trueW / wpx, 0.0, 1.0);
  vSegInfo = vec3(len, wpx, cover);
  float depth = -a.z;
  vFogDepth = depth;
  // brightness: most drops are faint, some catch a light; near drops fade (out of focus, avoid lens smears)
  float catchLight = 0.35 + 1.4 * pow(fract(aSeed.w * 37.17 + r2), 6.0);
  float nearFade = smoothstep(0.25, 1.4, depth);
  // energy spreads along long streaks (sqrt: keep fast rain dramatic)
  float spread = inversesqrt(1.0 + len / (14.0 * wpx));
  vBright = catchLight * edge * nearFade * spread * (1.0 + 5.0 * headlight(p));
  // a few drops refract neon: pink / cyan tints
  float hue = fract(r3 * 5.31);
  vTint = hue < 0.12 ? vec3(1.0, 0.45, 0.8) : (hue < 0.24 ? vec3(0.45, 0.85, 1.0) : vec3(0.82, 0.88, 1.0));
}`;

const STREAK_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
${FOG_PARS}
varying vec4 vSeg;
varying vec3 vSegInfo;
varying float vBright;
varying float vFogDepth;
varying vec3 vTint;
void main() {
  float invW = 1.0 / vSeg.z;
  float across = vSeg.x * invW;
  float along = vSeg.y * invW;
  float len = vSegInfo.x;
  float h = clamp(along, 0.0, len);
  float d = length(vec2(across, along - h)) / vSegInfo.y;
  if (d > 1.0) discard;
  // refraction look: on wide (near) drops, bright rims and a dimmer core; thin drops are just soft lines
  float soft = 1.0 - smoothstep(0.3, 1.0, d);
  float rim = smoothstep(0.35, 0.75, d) * (1.0 - smoothstep(0.75, 1.0, d));
  float wide = smoothstep(1.5, 4.0, vSegInfo.y);
  float prof = mix(soft, 0.35 * soft + 0.9 * rim, wide);
  // slightly brighter head (leading end)
  float head = len > 1e-3 ? mix(0.7, 1.0, h / len) : 1.0;
  float a = prof * head * vSegInfo.z * vBright * uOpacity;
  vec3 col = uColor * vTint;
#ifdef USE_FOG
  a *= 1.0 - fogFactorAt(vFogDepth);
#endif
  if (a < 0.002) discard;
  gl_FragColor = vec4(col * a, 0.0); // additive (premultiplied with zero alpha)
}`;

const SPLASH_VS = /* glsl */ `
attribute vec4 aSeed; // xy = tile slot offset, z = index inside tile, w = random
uniform vec3 uCamPos;
uniform float uTile;
uniform float uTime;
uniform float uPeriod;
uniform float uDuration;
uniform float uIntensity;
${LIGHT_PARS}
varying vec2 vUv;
varying float vAge;
varying float vKind;
varying float vBright;
varying float vFogDepth;
varying float vSeed;
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  if (aSeed.w > uIntensity) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec2 tile = floor(uCamPos.xz / uTile) + aSeed.xy;
  float k = aSeed.z;
  float phase = hash13(vec3(tile, k + 0.5));
  float period = uPeriod * (0.7 + 0.6 * hash13(vec3(tile.yx, k + 7.1)));
  float t = uTime / period + phase;
  float cycle = floor(t);
  float age = fract(t) * period;
  if (age > uDuration) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec2 pos = (tile + vec2(hash13(vec3(tile, k * 1.31 + cycle)), hash13(vec3(tile.yx, k * 2.17 + cycle * 1.7)))) * uTile;
  vec3 c = vec3(pos.x, 0.012, pos.y);
  // fade with distance from the camera (tiles are square; the effect area is round)
  float dist = length(c.xz - uCamPos.xz);
  float distFade = 1.0 - smoothstep(uTile * 1.4, uTile * 2.4, dist);
  float x = age / uDuration;
  vAge = x;
  vKind = position.z;
  vec4 mv;
  if (position.z < 0.5) {
    // flat expanding ripple ring on the road
    float r = mix(0.015, 0.075 + 0.05 * aSeed.w, sqrt(x));
    vec3 wp = c + vec3(position.x, 0.0, position.y) * 2.0 * r;
    mv = viewMatrix * vec4(wp, 1.0);
    vUv = position.xy * 2.0;
  } else {
    // crown: tiny upward bounce, camera-facing, only near the camera
    if (dist > uTile * 1.2 || x > 0.5) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    float hgt = 0.05 + 0.05 * aSeed.w;
    mv = viewMatrix * vec4(c + vec3(0.0, hgt * 0.5 * sqrt(x * 2.0), 0.0), 1.0);
    mv.xy += position.xy * vec2(0.05, hgt) * (0.6 + 0.8 * x);
    vUv = position.xy * 2.0;
  }
  vSeed = aSeed.w;
  vFogDepth = -mv.z;
  vBright = distFade * (0.55 + 0.45 * fract(aSeed.w * 13.1)) * (1.0 + 4.0 * headlight(c + vec3(0.0, 0.5, 0.0)));
  gl_Position = projectionMatrix * mv;
}`;

const SPLASH_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
${FOG_PARS}
varying vec2 vUv;
varying float vAge;
varying float vKind;
varying float vBright;
varying float vFogDepth;
varying float vSeed;
void main() {
  float r = length(vUv);
  float a;
  if (vKind < 0.5) {
    // thin, broken ripple ring that fades as it expands + a tiny bright impact point
    float ang = atan(vUv.y, vUv.x);
    float broken = 0.45 + 0.55 * abs(sin(ang * 2.5 + vSeed * 6.28));
    float ring = (1.0 - smoothstep(0.0, 0.09, abs(r - 0.8))) * broken;
    float core = (1.0 - smoothstep(0.0, 0.3, r)) * (1.0 - smoothstep(0.0, 0.2, vAge));
    a = (ring * 0.55 + core * 1.4) * pow(max(1.0 - vAge, 0.0), 2.0);
  } else {
    // a few droplets in a small crown: dots along an arc
    vec2 p = vUv;
    float dots = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i) - 1.0;
      vec2 c = vec2(fi * 0.55, 0.15 + 0.55 * (1.0 - abs(fi)) * (1.0 - vAge * 1.2));
      dots += 1.0 - smoothstep(0.0, 0.35, length((p - c) * vec2(1.0, 0.6)));
    }
    a = dots * (1.0 - vAge * 2.0);
  }
  a *= vBright * uOpacity;
#ifdef USE_FOG
  a *= 1.0 - fogFactorAt(vFogDepth);
#endif
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * a, 0.0);
}`;

function additive(mat) {
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

export function createRain({ scene, quality } = {}) {
  const high = (quality ?? 'high') !== 'low';
  const group = new THREE.Group();
  group.name = 'fx-rain';
  if (scene) scene.add(group);

  // ---------------- streaks ----------------
  const COUNT = high ? 14000 : 6000;
  const box = new THREE.Vector3(40, 20, 40);
  const seeds = new Float32Array(COUNT * 4);
  for (let i = 0; i < COUNT; i++) {
    seeds[i * 4] = Math.random();
    seeds[i * 4 + 1] = Math.random();
    seeds[i * 4 + 2] = Math.random();
    seeds[i * 4 + 3] = (i + Math.random()) / COUNT; // stratified so setIntensity thins out evenly
  }
  // shuffle the stratified w so culling isn't spatially ordered
  for (let i = COUNT - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = seeds[i * 4 + 3];
    seeds[i * 4 + 3] = seeds[j * 4 + 3];
    seeds[j * 4 + 3] = t;
  }
  const quad = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
  const streakGeo = new THREE.InstancedBufferGeometry();
  streakGeo.setAttribute('position', new THREE.Float32BufferAttribute(quad, 3));
  streakGeo.setIndex([0, 1, 2, 0, 2, 3]);
  streakGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  streakGeo.instanceCount = COUNT;

  const head = {
    uHeadPos: { value: new THREE.Vector3() },
    uHeadDir: { value: new THREE.Vector3(0, 0, 1) },
    uHeadOn: { value: 0 },
  };
  const fall = new THREE.Vector3(1.2, -9.5, 0.6); // m/s (slight wind)
  const offsets = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const offD = [new Float64Array(3), new Float64Array(3), new Float64Array(3)];
  const speedK = [0.82, 1.0, 1.18];

  const streakMat = additive(
    new THREE.ShaderMaterial({
      name: 'fx-rain-streaks',
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        ...head,
        uBox: { value: box },
        uCenter: { value: new THREE.Vector3() },
        uOffsets: { value: offsets },
        uFall: { value: fall },
        uCamVel: { value: new THREE.Vector3() },
        uShutter: { value: 1 / 45 },
        uMaxLen: { value: 2.6 },
        uIntensity: { value: 1 },
        uWidth: { value: 0.0045 },
        uViewport: { value: new THREE.Vector2(1920, 1080) },
        uColor: { value: new THREE.Color(0.6, 0.66, 0.78) },
        uOpacity: { value: 1.25 },
      },
      vertexShader: STREAK_VS,
      fragmentShader: STREAK_FS,
      fog: true,
    }),
  );
  const streaks = new THREE.Mesh(streakGeo, streakMat);
  streaks.name = 'fx-rain-streaks';
  streaks.frustumCulled = false;
  streaks.renderOrder = 5;
  const vp = new THREE.Vector2();
  streaks.onBeforeRender = (renderer) => {
    const rt = renderer.getRenderTarget();
    if (rt) streakMat.uniforms.uViewport.value.set(rt.width, rt.height);
    else streakMat.uniforms.uViewport.value.copy(renderer.getDrawingBufferSize(vp));
    streakMat.uniformsNeedUpdate = true;
  };

  // ---------------- splashes ----------------
  const TILE = 6;
  const R = 2; // tiles each side → 5x5 tiles = 30 m square
  const PER_TILE = high ? 70 : 32;
  const nTiles = (2 * R + 1) * (2 * R + 1);
  const SPL = nTiles * PER_TILE;
  const sSeeds = new Float32Array(SPL * 4);
  let si = 0;
  for (let tz = -R; tz <= R; tz++) {
    for (let tx = -R; tx <= R; tx++) {
      for (let k = 0; k < PER_TILE; k++) {
        sSeeds[si * 4] = tx;
        sSeeds[si * 4 + 1] = tz;
        sSeeds[si * 4 + 2] = k;
        sSeeds[si * 4 + 3] = Math.random();
        si++;
      }
    }
  }
  const splashGeo = new THREE.InstancedBufferGeometry();
  // 8 verts: ground ring quad (z=0) + crown billboard (z=1)
  splashGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
      -0.5, 0, 1, 0.5, 0, 1, 0.5, 1, 1, -0.5, 1, 1,
    ], 3),
  );
  splashGeo.setIndex([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7]);
  splashGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(sSeeds, 4));
  splashGeo.instanceCount = SPL;
  const splashMat = additive(
    new THREE.ShaderMaterial({
      name: 'fx-rain-splashes',
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        ...head,
        uCamPos: { value: new THREE.Vector3() },
        uTile: { value: TILE },
        uTime: { value: 0 },
        uPeriod: { value: 0.9 },
        uDuration: { value: 0.32 },
        uIntensity: { value: 1 },
        uColor: { value: new THREE.Color(0.5, 0.56, 0.66) },
        uOpacity: { value: 0.22 },
      },
      vertexShader: SPLASH_VS,
      fragmentShader: SPLASH_FS,
      fog: true,
      side: THREE.DoubleSide,
    }),
  );
  splashMat.polygonOffset = true;
  splashMat.polygonOffsetFactor = -2;
  splashMat.polygonOffsetUnits = -4;
  const splashes = new THREE.Mesh(splashGeo, splashMat);
  splashes.name = 'fx-rain-splashes';
  splashes.frustumCulled = false;
  splashes.renderOrder = 0;

  group.add(streaks, splashes);
  streaks.layers.set(LAYERS.NO_REFLECTION);
  splashes.layers.set(LAYERS.NO_REFLECTION);

  // ---------------- state ----------------
  let intensity = 1;
  let autoHead = true;
  let time = 0;
  const camPos = new THREE.Vector3();
  const lastCam = new THREE.Vector3();
  let haveCam = false;
  const camVel = new THREE.Vector3();
  const fwd = new THREE.Vector3();

  function setIntensity(v) {
    intensity = Math.min(1, Math.max(0, +v || 0));
    streakMat.uniforms.uIntensity.value = intensity;
    splashMat.uniforms.uIntensity.value = intensity;
    group.visible = intensity > 0.001;
  }

  function update(dt = 1 / 60, camera, velocity) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    time += dt;
    // accumulate fall offsets per speed class in double precision, wrapped to the box
    for (let c = 0; c < 3; c++) {
      const o = offD[c];
      o[0] = (o[0] + fall.x * speedK[c] * dt) % box.x;
      o[1] = (o[1] + fall.y * speedK[c] * dt) % box.y;
      o[2] = (o[2] + fall.z * speedK[c] * dt) % box.z;
      offsets[c].set(o[0], o[1], o[2]);
    }
    if (camera) {
      camera.getWorldPosition(camPos);
      if (velocity) {
        camVel.set(velocity.x || 0, velocity.y || 0, velocity.z || 0);
      } else if (haveCam && dt > 0) {
        const k = 1 - Math.exp(-10 * dt);
        const ix = (camPos.x - lastCam.x) / dt, iy = (camPos.y - lastCam.y) / dt, iz = (camPos.z - lastCam.z) / dt;
        if (ix * ix + iy * iy + iz * iz < 150 * 150) {
          camVel.x += (ix - camVel.x) * k;
          camVel.y += (iy - camVel.y) * k;
          camVel.z += (iz - camVel.z) * k;
        }
      }
      lastCam.copy(camPos);
      haveCam = true;
      // box centre: ahead of the camera (horizontal forward), bottom just under the road
      camera.getWorldDirection(fwd);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
      fwd.normalize();
      const c = streakMat.uniforms.uCenter.value;
      c.set(camPos.x + fwd.x * box.x * 0.28, Math.max(camPos.y, box.y * 0.5 - 1.0), camPos.z + fwd.z * box.z * 0.28);
      splashMat.uniforms.uCamPos.value.set(camPos.x + fwd.x * TILE * 0.8, 0, camPos.z + fwd.z * TILE * 0.8);
      // Until the game supplies the real headlights (setHeadlights), assume a chase camera: the player's
      // beams start ~8 m ahead of the camera and point along its horizontal forward direction.
      if (autoHead) {
        head.uHeadPos.value.set(camPos.x + fwd.x * 8, 0.7, camPos.z + fwd.z * 8);
        head.uHeadDir.value.copy(fwd);
        head.uHeadOn.value = 1;
      }
    }
    streakMat.uniforms.uCamVel.value.copy(camVel);
    splashMat.uniforms.uTime.value = time;
  }

  return {
    group,
    update,
    setIntensity,
    // Optional: light the rain inside the player's headlight beams (world position + forward direction).
    setHeadlights(position, direction, on = true) {
      autoHead = false;
      if (position) head.uHeadPos.value.set(position.x, position.y ?? 0.7, position.z);
      if (direction) head.uHeadDir.value.set(direction.x, direction.y || 0, direction.z).normalize();
      head.uHeadOn.value = on ? 1 : 0;
    },
    // Optional: wind / fall speed (m/s); default (1.2, -9.5, 0.6)
    setWind(x = 1.2, z = 0.6, fallSpeed = 9.5) {
      fall.set(x, -Math.abs(fallSpeed), z);
    },
    meshes: { streaks, splashes },
    uniforms: { streaks: streakMat.uniforms, splashes: splashMat.uniforms },
    dispose() {
      group.removeFromParent();
      streakGeo.dispose();
      splashGeo.dispose();
      streakMat.dispose();
      splashMat.dispose();
    },
  };
}
