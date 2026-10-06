// Procedural supercar model for MIDNIGHT APEX (CONTRACTS.md §3).
// Geometry (lofted body, greenhouse, parts, wheels) is generated once and shared by every car; each car only
// clones the few materials whose colour/state differ (paint livery, light gains, calipers, rims, flames).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG, LAYERS } from '../config.js';
import { buildBodyShell, buildGreenhouse, SurfaceCaster } from './carBody.js';
import { buildCarParts, buildWheelGeometries } from './carParts.js';
import {
  makeLiveryTexture, getMaskTexture, getCarbonTexture, getHoneycombTexture, getTireTextures, getDiscTexture,
  getShadowTexture, getConeTexture, getDropletNormalTexture, getRimBlurTexture,
  liveryStripeStyle, STRIPE, HEADLAMP, BEAM_DECAL, getHeadlightCookie, lowBeamProfile,
} from './carTextures.js';

const C = CONFIG.car;
const WHEEL_KEYS = ['fl', 'fr', 'rl', 'rr'];
const CAL_ALPHA = { fl: 0, fr: (70 * Math.PI) / 180, rl: (70 * Math.PI) / 180, rr: 0 }; // trailing/leading caliper position
const WING_BY_NAME = { YOU: true, RAZOR: true, VENOM: false, GHOST: true, NOVA: false, SHADE: true, BLAZE: false, FROST: false };
const RIM_TINT = { YOU: 0xffffff, RAZOR: 0xffffff, VENOM: 0x5a5a60, GHOST: 0xffffff, NOVA: 0x3a3a40, SHADE: 0xd8b070, BLAZE: 0x45454a, FROST: 0xffffff };
// HDR gains for the multiplexed emissive material: [DRL+markers, projector cores, tail LEDs, reverse, exhaust glow]
const GAIN = { drl: 2.6, headOn: 4, headOff: 0.2, tail: 2.6, brake: 7, revOn: 9, revOff: 0.04, exhaustIdle: 0.02, nitro: 1.4 };
// additive road-pool decal brightness (AI cars have no real lights; the player's real spots do most of the work)
const DECAL_GAIN = { ai: 0.15, player: 0.1 };
// default candela of the player's low beams in the cookie's reference direction (straight ahead, horizon)
const HEADLIGHT_CD = 1800;

// distance (m) beyond which a car switches to its low-detail body/wheels (THREE.LOD, per camera)
const LOD_DIST = 38;

const hdr = (hex, k) => new THREE.Color(hex).multiplyScalar(k);
const lum = (hex) => { const c = new THREE.Color(hex); return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; };

function stripAttrs(g, keep = ['position', 'normal', 'uv']) {
  const c = g.clone();
  for (const k of Object.keys(c.attributes)) if (!keep.includes(k)) c.deleteAttribute(k);
  return c;
}

// ------------------------------------------------------------------------------------------------
// Shared resources (built lazily on first createCarModel call — no work at import time)
// ------------------------------------------------------------------------------------------------
let SHARED = null;
function getShared(quality = 'high') {
  if (SHARED) return SHARED;
  const low = quality === 'low';
  const T = [performance.now()];
  const body = buildBodyShell();
  T.push(performance.now());
  const caster = new SurfaceCaster(body.geometry);
  const gh = buildGreenhouse(caster, body.uvScale);
  T.push(performance.now());
  const S = { body, caster, gh };
  const parts = buildCarParts(S);
  T.push(performance.now());
  const wheels = buildWheelGeometries();
  const wheelsLo = buildWheelGeometries({ lod: true });
  // coarse shell for distant cars (same UV layout so the livery maps identically)
  const bodyLo = buildBodyShell({ M: 26, spacing: 0.08, uvScale: body.uvScale });
  T.push(performance.now());
  const layout = { uvScale: body.uvScale, vSideAtY: body.vSideAtY, vTopAtX: body.vTopAtX, uAtZ: body.uAtZ };
  const tireTex = getTireTextures(wheels.treadV[0], wheels.treadV[1]);
  const pb = parts.buckets;
  // rain beads: body UVs span ~4.6 m × ~3.6 m, so repeat ≈ 12 gives ~0.38 m tiles (beads of 2–6 mm)
  const drops = getDropletNormalTexture().clone();
  drops.repeat.set(9, 7);
  drops.needsUpdate = true;
  const glassDrops = getDropletNormalTexture().clone();
  glassDrops.repeat.set(9, 7);
  glassDrops.needsUpdate = true;

  // one geometry per material
  const geos = {
    paint: mergeGeometries([stripAttrs(body.geometry), stripAttrs(gh.paint), stripAttrs(pb.paint)].filter(Boolean)),
    paintLo: mergeGeometries([stripAttrs(bodyLo.geometry), stripAttrs(gh.paint), stripAttrs(pb.paint)].filter(Boolean)),
    trim: mergeGeometries([stripAttrs(gh.trim), stripAttrs(pb.trim)]),
    glass: gh.glass,
    carbon: pb.carbon,
    wing: pb.wing,
    mesh: pb.mesh,
    chrome: pb.chrome,
    interior: pb.interior,
    emissive: pb.emissive,
    tailHousing: pb.tailHousing,
    flame: pb.flame,
  };
  for (const g of Object.values(geos)) g?.computeBoundingSphere();

  const mats = {
    trim: new THREE.MeshPhysicalMaterial({ color: 0x040405, roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x080a0e, roughness: 0.025, metalness: 0, transparent: true, opacity: 0.62, envMapIntensity: 1.7, ior: 1.52,
      normalMap: low ? null : glassDrops, normalScale: new THREE.Vector2(0.4, 0.4),
      // premultiplied-style blend: reflections are added at full strength, the interior shows through (1 - opacity)
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, depthWrite: false,
    }),
    carbon: new THREE.MeshPhysicalMaterial({ map: getCarbonTexture(), roughness: 0.5, metalness: 0.2, clearcoat: 0.55, clearcoatRoughness: 0.12, envMapIntensity: 0.55 }),
    mesh: new THREE.MeshStandardMaterial({ map: getHoneycombTexture(), roughness: 0.45, metalness: 0.6 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xd9dce2, metalness: 1, roughness: 0.14 }),
    interior: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 }),
    tire: new THREE.MeshStandardMaterial({ map: tireTex.map, normalMap: tireTex.normal, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.6, metalness: 0 }), // damp rubber
    disc: new THREE.MeshStandardMaterial({ map: getDiscTexture(), metalness: 0.85, roughness: 0.4 }),
    shadow: new THREE.MeshBasicMaterial({
      map: getShadowTexture([C.trackWidth / 2, -C.trackWidth / 2].flatMap((x) => [C.frontAxleZ, C.rearAxleZ].map((z) => ({ x, z }))), 2.7, 5.6),
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    cone: new THREE.MeshBasicMaterial({
      map: getConeTexture(), color: hdr(0xfff4e0, DECAL_GAIN.ai), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
  };

  // headlight beam decal: trapezoid on the road ahead of the bumper (pattern = the low-beam profile, see carTextures)
  const cone = new THREE.BufferGeometry();
  {
    const { z0, z1, w0, w1 } = BEAM_DECAL;
    const n = 16;
    const pos = [];
    const uv = [];
    const idx = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const z = z0 + (z1 - z0) * t;
      const w = w0 + (w1 - w0) * t;
      pos.push(-w, 0.012, z, w, 0.012, z);
      uv.push(1, t, 0, t);
      if (i < n) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    }
    cone.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    cone.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    cone.setIndex(idx);
    cone.computeVertexNormals();
  }
  // every lit car material: bounded punctual specular (see SPEC_CLIP_GLSL)
  for (const [k, m] of Object.entries(mats)) if (m.isMeshStandardMaterial && k !== 'glass') carShader(m, 'apex-car-' + k);
  carShader(mats.glass, 'apex-car-glass', glassDropsPatch);
  // speed-blur disc covering the spoke face (wheel space: axle = X, outer face +X)
  const blurGeo = new THREE.CircleGeometry(0.245, 40).rotateY(Math.PI / 2).translate(0.1, 0, 0);
  // distant wheels: the rim becomes a flat disc showing the time-averaged spoke pattern
  const rimDiscGeo = new THREE.CircleGeometry(0.262, 20).rotateY(Math.PI / 2).translate(0.105, 0, 0);
  const shadowGeo = new THREE.PlaneGeometry(2.7, 5.6).rotateX(-Math.PI / 2).translate(0, 0.006, 0);

  SHARED = { ...S, parts, wheels, wheelsLo, layout, mats, geos, cone, shadowGeo, blurGeo, rimDiscGeo, low, mask: getMaskTexture(layout), drops };
  T.push(performance.now());
  if (typeof window !== 'undefined' && window.__carTiming !== undefined) window.__carTiming = T.slice(1).map((t, i) => +(t - T[i]).toFixed(1));
  return SHARED;
}

// ------------------------------------------------------------------------------------------------
// Shader patches shared by every lit car material
// ------------------------------------------------------------------------------------------------
// Punctual lights (moon, the player's headlights) on mirror-smooth coats give 100–1000× HDR pin-points that bloom
// and streak into a white-out on the car ahead. Real lamps have a size, so: widen the lobe a little for direct
// light only (min roughness), then soft-clip the direct specular sum (linear below ~1.2, saturating at ~3.5).
// Environment (IBL) reflections are untouched.
const SPEC_CLIP_GLSL = `
vec3 apexSpecClip(vec3 c) {
  float m = max(max(c.r, c.g), c.b);
  if (m <= 1.2) return c;
  float k = 1.2 + (m - 1.2) / (1.0 + (m - 1.2) / 2.3);
  return c * (k / m);
}`;
function specClipPatch(sh, { nearSoft = false } = {}) {
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\n' + SPEC_CLIP_GLSL)
    .replace('#include <lights_fragment_begin>', `
      float apexRoughIBL = material.roughness;
      material.roughness = max(material.roughness, 0.08);
      #ifdef USE_CLEARCOAT
        float apexCcRoughIBL = material.clearcoatRoughness;
        material.clearcoatRoughness = max(material.clearcoatRoughness, 0.09);
      #endif
      #include <lights_fragment_begin>
      reflectedLight.directSpecular = apexSpecClip(reflectedLight.directSpecular);
      material.roughness = apexRoughIBL;
      #ifdef USE_CLEARCOAT
        clearcoatSpecularDirect = apexSpecClip(clearcoatSpecularDirect);
        material.clearcoatRoughness = apexCcRoughIBL;
        ${nearSoft ? `// Paint seen from a few decimetres (hood cam): the flat hood mirrors the static night-city env map at
        // ~6 screen px per env texel, so its flat neon boxes and window pixels read as hard mosaic blocks. Close to
        // the lens, sample a blurrier PMREM level so the coat shows soft glows instead (≈ out-of-focus reflections).
        material.clearcoatRoughness = max(material.clearcoatRoughness, uNearSoft * (1.0 - smoothstep(0.7, 2.6, length(vViewPosition))));` : ''}
      #endif
    `);
}
function carShader(m, key, ...extra) {
  m.onBeforeCompile = (sh) => {
    specClipPatch(sh);
    for (const f of extra) f(sh);
  };
  m.customProgramCacheKey = () => key;
  m.needsUpdate = true;
}

// Clear-coated metallic paint with a procedural micro-flake layer (object-space hash, shown only near pixel size),
// analytic anti-aliased racing stripes (crisp at any distance), and the bounded punctual specular above.
function makePaintMaterial(map, mask, envMap, drops, stripe) {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map, roughness: 1, metalness: 1, roughnessMap: mask, metalnessMap: mask,
    clearcoat: 1, clearcoatMap: mask, clearcoatRoughness: 0.03, envMapIntensity: 1.0,
    // rain beads sit on the clear coat only (base layer keeps its flakes)
    clearcoatNormalMap: drops || null, clearcoatNormalScale: new THREE.Vector2(0.32, 0.32),
  });
  if (envMap) m.envMap = envMap;
  const uniforms = {
    uFlake: { value: 0.1 },
    uNearSoft: { value: 0.2 },
    uStripeCol: { value: new THREE.Color(stripe?.accent ?? 0xffffff) },
    uPinCol: { value: new THREE.Color(stripe?.pin ?? 0x000000) },
    // inner edge, outer edge, pin width (arc metres from the top centreline), u where the stripes start
    uStripe: { value: new THREE.Vector4(STRIPE.inner, STRIPE.outer, STRIPE.pin, stripe?.u0 ?? 0) },
    uUvScale: { value: stripe?.uvScale ?? 1 },
    uStripeOn: { value: stripe ? 1 : 0 },
  };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    specClipPatch(sh, { nearSoft: true });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCarPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCarPos = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vCarPos;
        uniform float uFlake, uNearSoft, uUvScale, uStripeOn;
        uniform vec3 uStripeCol, uPinCol;
        uniform vec4 uStripe;
        float apexBand(float x, float a, float b, float aa) { return smoothstep(a - aa, a + aa, x) * (1.0 - smoothstep(b - aa, b + aa, x)); }
        ` + DROP_FADE_GLSL)
      .replace('#include <map_fragment>', `#include <map_fragment>
      if (uStripeOn > 0.5) {
        // twin stripes + pinstripes, drawn in body-UV space: v = 0.5 is the top centreline, |v − 0.5|·uvScale = arc m
        float g = abs(vMapUv.y - 0.5) * uUvScale;
        float aa = max(fwidth(g), 1e-5) * 0.7;
        float stripe = apexBand(g, uStripe.x, uStripe.y, aa);
        float pin = apexBand(g, uStripe.x - uStripe.z, uStripe.x, aa) + apexBand(g, uStripe.y, uStripe.y + uStripe.z, aa);
        float ua = max(fwidth(vMapUv.x), 1e-6);
        float along = smoothstep(uStripe.w - ua, uStripe.w + ua, vMapUv.x);
        // panel gaps (matte in the mask) stay on top of the stripes
        float keep = smoothstep(0.1, 0.3, texture2D(clearcoatMap, vClearcoatMapUv).r) * along;
        diffuseColor.rgb = mix(diffuseColor.rgb, uPinCol, clamp(pin, 0.0, 1.0) * keep);
        diffuseColor.rgb = mix(diffuseColor.rgb, uStripeCol, stripe * keep);
      }`)
      .replace('#include <clearcoat_normal_fragment_maps>', THREE.ShaderChunk.clearcoat_normal_fragment_maps
        .replace('clearcoatMapN.xy *= clearcoatNormalScale;', 'clearcoatMapN.xy *= clearcoatNormalScale * apexDropFade(vClearcoatNormalMapUv);'))
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        // metallic flakes: two octaves (1.5 mm / 0.4 mm cells); each shows only while its cells are about a pixel
        // (bigger reads as a blocky mosaic up close, smaller aliases into glitter)
        vec3 fl = vec3(0.0);
        for (int o = 0; o < 2; o++) {
          vec3 fp = vCarPos * (o == 0 ? 650.0 : 2600.0);
          float w = length(fwidth(fp));
          float fade = smoothstep(0.22, 0.5, w) * (1.0 - smoothstep(0.7, 1.5, w));
          vec3 cell = floor(fp);
          vec3 h = fract(sin(vec3(dot(cell, vec3(127.1, 311.7, 74.7)), dot(cell, vec3(269.5, 183.3, 246.1)),
                                  dot(cell, vec3(113.5, 271.9, 124.6)))) * 43758.5453) * 2.0 - 1.0;
          fl += h * fade * (o == 0 ? 1.0 : 0.6);
        }
        normal = normalize(normal + fl * uFlake);
      }`);
  };
  m.customProgramCacheKey = () => 'apex-carpaint-v2';
  return m;
}

// Unlit HDR emitters (DRLs, projectors, tail LEDs, reverse, exhaust glow) in one draw call:
// vertex colour × per-channel gain (uniform array, one per car).
function makeEmissiveMaterial(gains) {
  const m = new THREE.MeshBasicMaterial({ vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGain = { value: gains };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float chan;\nvarying float vChan;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvChan = chan;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGain[5];\nvarying float vChan;')
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
        int ci = int(vChan + 0.5);
        float g = ci == 0 ? uGain[0] : ci == 1 ? uGain[1] : ci == 2 ? uGain[2] : ci == 3 ? uGain[3] : uGain[4];
        diffuseColor.rgb *= g;
      }`);
  };
  m.customProgramCacheKey = () => 'apex-car-emissive';
  return m;
}

// Rain-bead normals alias into glitter once a bead is ~1 px: fade them out by screen-space texel density.
const DROP_FADE_GLSL = `
float apexDropFade(vec2 uv) {
  float tpp = length(fwidth(uv)) * 512.0; // texels per pixel (droplet texture is 512²)
  return 1.0 - smoothstep(1.2, 3.5, tpp);
}`;
function glassDropsPatch(sh) {
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\n' + DROP_FADE_GLSL)
    .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps
      .replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale * apexDropFade(vNormalMapUv);'));
}

// Nitro flame: volumetric, ray-marched inside a lathe hull per exhaust (vertex `color` = nozzle, car-local).
// Blue envelope, white-hot core at the nozzle and a train of shock diamonds; additive, with an optically-thick
// soft saturation so looking straight down the flame (chase cam) can't exceed ~1.7 → a glint, not a bloom bomb.
function makeFlameMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uInt: { value: 0 }, uLen: { value: 0.5 }, uTime: { value: 0 } },
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 vPos;
      varying vec3 vO;
      varying vec3 vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vPos = mv.xyz;
        vO = (modelViewMatrix * vec4(color, 1.0)).xyz;
        vA = normalize(mat3(modelViewMatrix) * vec3(0.0, 0.0, -1.0));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uInt;
      uniform float uLen;
      uniform float uTime;
      varying vec3 vPos;
      varying vec3 vO;
      varying vec3 vA;
      float flameR(float t) { return 0.03 * (1.0 + 0.55 * t) * (1.0 - smoothstep(0.4, 1.0, t)) + 0.004; }
      void main() {
        vec3 V = normalize(vPos);
        vec3 A = normalize(vA);
        float ca = dot(V, A);
        float sa = sqrt(max(1.0 - ca * ca, 1e-4));
        // march the chord through the hull from this front-face entry point
        float chord = min(uLen + 0.2, 0.15 / max(sa, 0.1));
        const int N = 12;
        float ds = chord / float(N);
        vec3 acc = vec3(0.0);
        for (int i = 0; i < N; i++) {
          vec3 q = vPos + V * (ds * (float(i) + 0.5)) - vO;
          float s = dot(q, A);
          float t = s / uLen;
          if (t < -0.06 || t > 1.0) continue;
          float R = flameR(max(t, 0.0));
          float rr = max(dot(q, q) - s * s, 0.0) / (R * R);
          float env = exp(-rr * 1.6) * (1.0 - smoothstep(0.45, 1.0, t)) * smoothstep(-0.06, 0.02, t);
          float core = exp(-rr * 4.0) * exp(-max(t, 0.0) * 8.0);
          float ph = t * 4.6 - 0.3 + 0.04 * sin(uTime * 31.0);
          float dia = pow(0.5 + 0.5 * cos(6.2832 * ph), 14.0) * exp(-rr * 3.0) * smoothstep(0.04, 0.1, t) * (1.0 - smoothstep(0.2, 0.8, t));
          vec3 blue = mix(vec3(0.10, 0.27, 1.0), vec3(0.36, 0.17, 1.0), smoothstep(0.2, 0.9, t));
          acc += (blue * env * 6.0 + vec3(0.62, 0.8, 1.0) * (core * 24.0 + dia * 26.0)) * ds;
        }
        vec3 c = acc * uInt;
        float m = max(max(c.r, c.g), c.b);
        c *= 1.7 * (1.0 - exp(-m / 1.7)) / max(m, 1e-4);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

function setEnv(mats, envMap) {
  if (!envMap) return;
  for (const m of mats) if (m && 'envMap' in m) { m.envMap = envMap; m.needsUpdate = true; }
}

// ------------------------------------------------------------------------------------------------
/**
 * createCarModel(opts) → CarModel (see CONTRACTS.md §3).
 * Extra optional opts: number (door number), wing (bool), headlightIntensity (candela for the player SpotLights).
 */
export function createCarModel({
  color = 0x0a3cff, accent = 0x00e5ff, name = 'CAR', isPlayer = false, quality = 'high', envMap = null,
  number, wing, headlightIntensity = HEADLIGHT_CD,
} = {}) {
  const S = getShared(quality);
  const P = S.parts;
  const G = S.geos;
  const key = String(name || '').toUpperCase();
  const liveryIndex = CONFIG.liveries.findIndex((l) => l.name === key);
  const num = number ?? (liveryIndex >= 0 ? liveryIndex + 1 : 9);
  const hasWing = wing ?? WING_BY_NAME[key] ?? true;

  const root = new THREE.Group();
  root.name = `car-${key || 'CAR'}`;
  const bodyPivot = new THREE.Group(); // pitch/roll pivot at wheel-centre height
  bodyPivot.position.y = C.wheelRadius;
  root.add(bodyPivot);
  const body = new THREE.Group();
  body.position.y = -C.wheelRadius;
  bodyPivot.add(body);

  // ---- per-car materials
  // racing stripes are drawn analytically by the paint shader (crisp from the hood cam), not into the canvas
  const livery = makeLiveryTexture(S.layout, { color, accent, number: num, name: key === 'YOU' ? 'APEX' : key, quality, stripes: false });
  const stripe = { ...liveryStripeStyle(color, accent), u0: S.layout.uAtZ(STRIPE.zStart), uvScale: S.layout.uvScale };
  const paint = makePaintMaterial(livery, S.mask, envMap, S.low ? null : S.drops, stripe);
  const gains = [GAIN.drl, GAIN.headOn, GAIN.tail, GAIN.revOff, GAIN.exhaustIdle];
  const caliperColor = lum(accent) < 0.08 ? 0xd10f1f : accent;
  const mats = {
    paint,
    emissive: makeEmissiveMaterial(gains),
    tailHousing: new THREE.MeshPhysicalMaterial({ color: 0x1a0003, roughness: 0.08, metalness: 0, clearcoat: 1, emissive: 0xff1200, emissiveIntensity: 0.12 }),
    flame: makeFlameMaterial(),
    caliper: new THREE.MeshPhysicalMaterial({ color: caliperColor, roughness: 0.3, metalness: 0.15, clearcoat: 0.8, clearcoatRoughness: 0.1 }),
    rim: new THREE.MeshStandardMaterial({ vertexColors: true, color: RIM_TINT[key] ?? 0xffffff, metalness: 1, roughness: 0.24, side: THREE.DoubleSide }),
    rimLo: new THREE.MeshStandardMaterial({ map: getRimBlurTexture(), color: RIM_TINT[key] ?? 0xffffff, metalness: 0.7, roughness: 0.4 }),
    rimBlur: new THREE.MeshStandardMaterial({
      map: getRimBlurTexture(), color: RIM_TINT[key] ?? 0xffffff, metalness: 0.65, roughness: 0.42, transparent: true, opacity: 0, depthWrite: false,
    }),
  };
  for (const k of ['tailHousing', 'caliper', 'rim', 'rimLo', 'rimBlur']) carShader(mats[k], 'apex-car-' + k);
  const shared = S.mats;
  setEnv([paint, shared.trim, shared.glass, shared.carbon, shared.chrome, shared.mesh, mats.tailHousing, mats.caliper, mats.rim, shared.tire, shared.disc], envMap);

  // ---- static body meshes: one draw call per material, in two detail levels (THREE.LOD switches per camera)
  const lod = new THREE.LOD();
  lod.name = 'bodyLOD';
  body.add(lod);
  const hi = new THREE.Group();
  const lo = new THREE.Group();
  lod.addLevel(hi, 0);
  lod.addLevel(lo, LOD_DIST, 0.12);
  const add = (parent, geo, mat, { shadow = false, order = 0 } = {}) => {
    if (!geo) return null;
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    m.renderOrder = order;
    parent.add(m);
    return m;
  };
  const flames = [];
  for (const [grp, detail] of [[hi, true], [lo, false]]) {
    add(grp, detail ? G.paint : G.paintLo, paint, { shadow: true });
    add(grp, G.trim, shared.trim, { shadow: detail });
    add(grp, G.carbon, shared.carbon, { shadow: detail });
    if (hasWing) add(grp, G.wing, shared.carbon, { shadow: true });
    add(grp, G.mesh, shared.mesh);
    if (detail) {
      add(grp, G.chrome, shared.chrome);
      add(grp, G.interior, shared.interior);
    }
    add(grp, G.emissive, mats.emissive);
    add(grp, G.tailHousing, mats.tailHousing);
    const fl = add(grp, G.flame, mats.flame, { order: 2 });
    if (fl) {
      fl.visible = false;
      fl.layers.set(LAYERS.NO_REFLECTION); // main cameras only: never mirrored in the wet road
      flames.push(fl);
    }
    add(grp, G.glass, shared.glass, { order: 1 });
  }

  // ---- wheels: instanced (tire, rim, disc spin; calipers only steer)
  const wx = C.trackWidth / 2;
  const wheelLocal = {
    fl: new THREE.Vector3(wx, 0, C.frontAxleZ),
    fr: new THREE.Vector3(-wx, 0, C.frontAxleZ),
    rl: new THREE.Vector3(wx, 0, C.rearAxleZ),
    rr: new THREE.Vector3(-wx, 0, C.rearAxleZ),
  };
  const wheelLod = new THREE.LOD();
  wheelLod.name = 'wheelLOD';
  root.add(wheelLod);
  const wHi = new THREE.Group();
  const wLo = new THREE.Group();
  wheelLod.addLevel(wHi, 0);
  wheelLod.addLevel(wLo, LOD_DIST, 0.12);
  const inst = (parent, geo, mat, shadow) => {
    const m = new THREE.InstancedMesh(geo, mat, 4);
    m.castShadow = shadow;
    parent.add(m);
    return m;
  };
  const W = S.wheels;
  const tires = inst(wHi, W.tire, shared.tire, true);
  const rims = inst(wHi, W.rim, mats.rim, true);
  const discs = inst(wHi, W.disc, shared.disc, false);
  const calipers = inst(wHi, W.caliper, mats.caliper, false);
  const blurs = inst(wHi, S.blurGeo, mats.rimBlur, false);
  const tiresLo = inst(wLo, S.wheelsLo.tire, shared.tire, true);
  const rimsLo = inst(wLo, S.rimDiscGeo, mats.rimLo, false);
  blurs.renderOrder = 1;
  blurs.visible = false;

  // ---- ground: soft contact shadow + headlight beam decal
  const contact = new THREE.Mesh(S.shadowGeo, shared.shadow);
  contact.name = 'contactShadow';
  contact.renderOrder = -1;
  root.add(contact);
  // the player's real spot lights already light the road, so its decal only adds a faint diffuse glow
  const coneMat = isPlayer ? shared.cone.clone() : shared.cone;
  if (isPlayer) coneMat.color.copy(hdr(0xfff4e0, DECAL_GAIN.player));
  const cone = new THREE.Mesh(S.cone, coneMat);
  cone.name = 'beamDecal';
  cone.renderOrder = 1;
  cone.frustumCulled = false;
  cone.layers.set(LAYERS.NO_REFLECTION);
  root.add(cone);

  // ---- real headlights for the player only (no shadows): low-beam spot lights shaped by a light cookie
  // (SpotLight.map, the same profile as the decal): soft cut-off ~0.6° below the horizon with a right-hand kink,
  // even road illuminance from ~4 m to ~15 m, soft fade to ~45 m, wide soft sides. `intensity` = candela straight
  // ahead on the horizon (the cookie's 1.0); the hot zone just below the cut-off is ≈ 5.7× that.
  const spots = [];
  if (isPlayer) {
    const cookie = getHeadlightCookie(HEADLAMP.angle);
    for (const s of [1, -1]) {
      const L = new THREE.SpotLight(0xf1f4ff, headlightIntensity, 90, HEADLAMP.angle, HEADLAMP.penumbra, 2);
      L.map = cookie;
      L.position.set(HEADLAMP.x * s, HEADLAMP.y, HEADLAMP.z);
      L.target.position.set(HEADLAMP.x * s, HEADLAMP.y, HEADLAMP.z + 30); // level: the cookie carries the aim
      L.castShadow = false;
      L.shadow.camera.near = 0.05; // the cookie is projected through this frustum: don't drop points near the lamp
      body.add(L, L.target);
      spots.push(L);
    }
  }

  // ---- state
  const qFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  const qId = new THREE.Quaternion();
  const qYaw = new THREE.Quaternion();
  const qSpin = new THREE.Quaternion();
  const qCal = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const X = new THREE.Vector3(1, 0, 0);
  const Y = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const pos = new THREE.Vector3();
  const mtx = new THREE.Matrix4();
  const st = { steerAngle: 0, wheelSpinFront: 0, wheelSpinRear: 0, pitch: 0, roll: 0, brake: 0, reversing: false, nitro: 0, headlights: true };
  let time = 0;

  function updateWheels() {
    for (let i = 0; i < 4; i++) {
      const k = WHEEL_KEYS[i];
      const front = k[0] === 'f';
      const right = k[1] === 'r';
      pos.copy(wheelLocal[k]).setY(C.wheelRadius);
      // + steer = turn right = front of the wheel toward −X = negative yaw
      qYaw.setFromAxisAngle(Y, front ? -st.steerAngle : 0);
      // + spin rolls the wheel forward (top moves toward +Z) — same sign on both sides because the flip is applied first
      qSpin.setFromAxisAngle(X, front ? st.wheelSpinFront : st.wheelSpinRear);
      const flip = right ? qFlip : qId;
      q.copy(qYaw).multiply(qSpin).multiply(flip);
      mtx.compose(pos, q, one);
      tires.setMatrixAt(i, mtx);
      rims.setMatrixAt(i, mtx);
      discs.setMatrixAt(i, mtx);
      blurs.setMatrixAt(i, mtx);
      tiresLo.setMatrixAt(i, mtx);
      rimsLo.setMatrixAt(i, mtx);
      qCal.setFromAxisAngle(X, CAL_ALPHA[k]);
      q.copy(qYaw).multiply(flip).multiply(qCal);
      mtx.compose(pos, q, one);
      calipers.setMatrixAt(i, mtx);
    }
    tires.instanceMatrix.needsUpdate = true;
    rims.instanceMatrix.needsUpdate = true;
    discs.instanceMatrix.needsUpdate = true;
    calipers.instanceMatrix.needsUpdate = true;
    blurs.instanceMatrix.needsUpdate = true;
    tiresLo.instanceMatrix.needsUpdate = true;
    rimsLo.instanceMatrix.needsUpdate = true;
  }
  updateWheels();
  for (const m of [tires, rims, discs, calipers, blurs, tiresLo, rimsLo]) m.computeBoundingSphere();
  // wheel angular speed (rad/s) estimated in update() from the accumulated spin → drives the rim blur
  let lastSpin = 0;
  let omega = 0;

  function applyLights() {
    gains[1] = st.headlights ? GAIN.headOn : GAIN.headOff;
    gains[2] = GAIN.tail + GAIN.brake * st.brake;
    gains[3] = st.reversing ? GAIN.revOn : GAIN.revOff;
    gains[4] = GAIN.exhaustIdle + GAIN.nitro * st.nitro;
    mats.tailHousing.emissiveIntensity = 0.08 + 0.3 * st.brake;
    cone.visible = !!st.headlights;
    for (const L of spots) L.visible = !!st.headlights;
    for (const f of flames) f.visible = st.nitro > 0.02;
  }
  applyLights();

  return {
    root,
    body,
    dimensions: { length: C.length, width: C.width, height: C.height },
    wheelLocal,
    exhaustLocal: P.rear.exhausts.map((v) => v.clone()),
    tailLightLocal: P.rear.tail.map((v) => v.clone()),
    headlightLocal: P.front.headlights.filter((_, i) => i % 2 === 0).map((v) => v.clone()),
    materials: { ...mats, ...shared },
    spotLights: spots,
    /**
     * Low-beam intensity multiplier for a direction in the lamp frame (car-local, +Z forward): tx = tan(horizontal
     * angle, + = car's RIGHT), ty = tan(vertical angle, + = up). spot.intensity × this = candela in that direction
     * (1 at the horizon straight ahead, ≈5.7 just below the cut-off, ≈0.2 one degree above it).
     */
    headlightProfile: lowBeamProfile,
    headlamp: { ...HEADLAMP }, // lamp position (x = ±x) / cone used by the spot lights, car-local metres
    beamDecal: cone, // additive headlight pool on the road (core may hide it when the camera is inside it)
    contactShadow: contact,
    setState(s = {}) {
      if (s.steerAngle !== undefined) st.steerAngle = +s.steerAngle || 0;
      if (s.wheelSpinFront !== undefined) st.wheelSpinFront = +s.wheelSpinFront || 0;
      if (s.wheelSpinRear !== undefined) st.wheelSpinRear = +s.wheelSpinRear || 0;
      if (s.pitch !== undefined) st.pitch = +s.pitch || 0;
      if (s.roll !== undefined) st.roll = +s.roll || 0;
      if (s.brake !== undefined) st.brake = Math.min(1, Math.max(0, +s.brake || 0));
      if (s.reversing !== undefined) st.reversing = !!s.reversing;
      if (s.nitro !== undefined) st.nitro = Math.min(1, Math.max(0, +s.nitro || 0));
      if (s.headlights !== undefined) st.headlights = !!s.headlights;
      bodyPivot.rotation.set(st.pitch, 0, st.roll);
      updateWheels();
      applyLights();
    },
    update(dt = 0) {
      time += dt;
      if (dt > 0) {
        const spin = st.wheelSpinRear;
        const w = Math.abs(spin - lastSpin) / dt;
        lastSpin = spin;
        omega += (Math.min(w, 400) - omega) * Math.min(1, dt * 8);
        // spokes start to strobe around 25–30 rad/s (~35 km/h); fully blurred by ~80 rad/s (~100 km/h)
        const b = Math.min(1, Math.max(0, (omega - 22) / 55));
        mats.rimBlur.opacity = 0.95 * b * b * (3 - 2 * b);
        blurs.visible = mats.rimBlur.opacity > 0.01;
      }
      if (flames.length && flames[0].visible) {
        // nitro flame flicker: length + brightness jitter (the hull stays put; the shader shortens the volume)
        const f = 0.75 + 0.25 * Math.sin(time * 61) * Math.sin(time * 37.3) + 0.15 * Math.random();
        const u = mats.flame.uniforms;
        u.uLen.value = 0.28 + 0.3 * st.nitro * (0.8 + 0.3 * f);
        u.uInt.value = st.nitro * (0.75 + 0.35 * f);
        u.uTime.value = time;
        gains[4] = GAIN.exhaustIdle + GAIN.nitro * st.nitro * (0.8 + 0.4 * f);
      }
    },
    dispose() {
      livery.dispose();
      for (const m of Object.values(mats)) m.dispose();
      if (coneMat !== shared.cone) coneMat.dispose();
      root.removeFromParent();
    },
  };
}
