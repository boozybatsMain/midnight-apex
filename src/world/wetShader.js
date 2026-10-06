// MIDNIGHT APEX — wet surface shading shared by the road, sidewalks, city ground and water.
//
// All wet surfaces are MeshStandardMaterials patched via onBeforeCompile so they keep three.js lighting
// (moonlight + shadows, the player's SpotLight headlights, IBL). On top of that we add:
//   • procedural asphalt/concrete detail (albedo / roughness / normal) from tiling data textures,
//   • puddles (mirror-smooth, rain ripples) from a macro noise field,
//   • a half-res PLANAR REFLECTION (mirror camera rendered by the environment) sampled at the fragment's
//     projected position, distorted by the surface normal and streaked vertically (the classic wet-street
//     smear of neon and lamps toward the viewer), weighted by the GGX environment BRDF (Fresnel),
//   • analytic streetlight pools (road only): lamps are evenly spaced along the track so each fragment
//     evaluates its 3 nearest lamp pairs as virtual point lights through three's own RE_Direct (GGX).
import * as THREE from 'three';
import { createAsphaltDetailTexture, createMacroTexture } from './textures.js';

let sharedTextures = null;
function getTextures() {
  if (!sharedTextures) sharedTextures = { detail: createAsphaltDetailTexture(), macro: createMacroTexture() };
  return sharedTextures;
}

const blackTex = (() => {
  let t = null;
  return () => {
    if (!t) {
      t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
      t.needsUpdate = true;
    }
    return t;
  };
})();

/** Uniforms shared by every wet material (the environment writes the reflection uniforms each frame). */
export function createWetShared({ quality = 'high' } = {}) {
  const tex = getTextures();
  return {
    quality,
    uniforms: {
      uTime: { value: 0 },
      uRain: { value: 1 },
      uReflTex: { value: blackTex() },
      uReflMatrix: { value: new THREE.Matrix4() },
      uReflOn: { value: 0 },
      uDetailTex: { value: tex.detail },
      uMacroTex: { value: tex.macro },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------------------------

export const WET_PARS = /* glsl */ `
uniform float uTime;
uniform float uRain;
uniform sampler2D uReflTex;
uniform mat4 uReflMatrix;
uniform float uReflOn;
uniform sampler2D uDetailTex;
uniform sampler2D uMacroTex;
varying vec3 vWPos;

float wHash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 wHash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }

// Expanding rain-drop rings on standing water → xz normal perturbation. Two offset cell layers.
vec2 rainRipples(vec2 p, float t) {
  vec2 acc = vec2(0.0);
  for (int layer = 0; layer < 3; layer++) {
    float fl = float(layer);
    vec2 q = p * (1.7 + fl * 0.63) + fl * 17.31;
    vec2 cell = floor(q);
    vec2 f = fract(q);
    vec2 h = wHash22(cell + fl * 7.0);
    vec2 c = 0.3 + 0.4 * h;
    float ph = fract(t * (0.75 + 0.5 * h.x) + h.y);
    vec2 d = f - c;
    float r = length(d);
    float x = r - ph * 0.38;
    float fade = (1.0 - ph) * (1.0 - ph);
    float wave = sin(x * 60.0) * exp(-x * x * 420.0) * fade;
    acc += (d / max(r, 1e-3)) * wave;
  }
  return acc * 0.33;
}

// HDR soft knee for reflected radiance: below ~4 untouched, above it compresses toward ~12, so a very hot
// source (lamp lens, headlight, anything the NO_REFLECTION layer missed) still streaks but can't turn the
// mip-blurred lookups into a giant glowing blob.
const vec3 W_LUM = vec3(0.2126, 0.7152, 0.0722);
vec3 reflKnee(vec3 c) {
  float l = dot(c, W_LUM);
  float e = max(l - 4.0, 0.0);
  return c * ((l - e + e / (1.0 + e * 0.125)) / max(l, 1e-4));
}
vec2 reflUV(vec3 wpos) {
  vec4 c = uReflMatrix * vec4(wpos, 1.0);
  return c.xy / max(c.w, 1e-4);
}
// Planar reflection lookup with a vertical streak blur (taps along the screen's vertical axis).
vec3 sampleReflectionUV(vec2 uv, float streak, float lod) {
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  for (int i = 0; i < 7; i++) {
    float t = (float(i) - 1.5) / 5.5; // −0.27 … 0.82 : longer toward the viewer
    float w = exp(-t * t * 3.0);
    vec2 tuv = clamp(uv + vec2(0.0, t * streak), vec2(0.001), vec2(0.999));
    acc += reflKnee(textureLod(uReflTex, tuv, lod + abs(t) * 1.5).rgb) * w;
    ws += w;
  }
  return acc / ws;
}
vec3 sampleReflection(vec3 wpos, vec2 distort, float streak, float lod) {
  return sampleReflectionUV(reflUV(wpos) + distort, streak, lod);
}
// Wide glossy lookup: 4 rotated taps on a coarse mip (vertically elongated like the streaks). This is what
// dim, non-emissive things (car bodies, facades) look like in rough wet asphalt: a soft dark smear.
vec3 sampleReflectionSoft(vec2 uv, float lod) {
  vec2 px = exp2(lod) / vec2(textureSize(uReflTex, 0));
  vec3 acc = textureLod(uReflTex, clamp(uv + px * vec2(0.85, 0.7), vec2(0.001), vec2(0.999)), lod).rgb;
  acc += textureLod(uReflTex, clamp(uv + px * vec2(-0.85, 1.6), vec2(0.001), vec2(0.999)), lod).rgb;
  acc += textureLod(uReflTex, clamp(uv + px * vec2(0.45, -1.1), vec2(0.001), vec2(0.999)), lod).rgb;
  acc += textureLod(uReflTex, clamp(uv + px * vec2(-0.45, -0.25), vec2(0.001), vec2(0.999)), lod).rgb;
  return reflKnee(acc * 0.25);
}
`;

// Planar reflection + Fresnel; replaces the IBL specular where enabled. Expects: nW (world normal),
// wet (0..1 reflection strength), puddle (0..1), and three's lighting locals.
//
// Physically: a water film reflects with Schlick Fresnel (F0 = 0.02), i.e. ~9 % looking down at the road
// right behind the car and 50–80 % at the grazing angles further away. Rough wet asphalt spreads that
// reflection into a wide lobe, so only bright sources (neon, lamps, tail lights) survive as crisp streaks;
// dim content (car bodies, facades) turns into a low-contrast smear, more so the steeper we look down.
// Puddles keep a sharper mirror, which reads best at a distance where the Fresnel is high.
export const WET_REFLECT = /* glsl */ `
{
  if (uReflOn > 0.5) {
    float rr = material.roughness;
    float streak = mix(0.012, 0.22, smoothstep(0.04, 0.55, rr));
    vec3 nV = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
    vec3 nV0 = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    vec2 distort = (nV.xy - nV0.xy) * (0.03 + 0.08 * rr);
    // Fresnel on the macro surface (geometric normal + a bit of the ripples, so micro-normals don't sparkle)
    vec3 nF = normalize(mix(normalize(vNormal), normal, 0.35));
    float NdV = saturate(dot(nF, geometryViewDir));
    float steep = smoothstep(0.1, 0.42, NdV);        // 0 = grazing (far road), 1 = looking down (near car)
    // Distant puddles: the drop rings are sub-pixel there but still stir the water. An animated vertical
    // jitter + short streak + brightness ripple keeps big uniform glows from reading as flat painted patches.
    float farP = puddle * (1.0 - steep);
    float shim = texture2D(uDetailTex, vWPos.xz * 0.05 + vec2(uTime * 0.11, uTime * 0.37)).b
               + texture2D(uDetailTex, vWPos.xz * 0.13 - vec2(uTime * 0.23, uTime * 0.05)).b - 1.0;
    vec2 ruv = reflUV(vWPos) + distort + vec2(shim * 0.004, shim * 0.02) * farP;
    streak = max(streak, 0.07 * farP);
    float fres = 0.02 + (max(1.0 - rr * 0.6, 0.02) - 0.02) * pow(1.0 - NdV, 5.0);
    // rain roughens the water statistically: distant puddles reflect a softened mirror, not a hard one
    vec3 sharp = sampleReflectionUV(ruv, streak, rr * 3.2 + farP * (0.6 + 1.0 * uRain));
    float lodS = rr * 3.2 + mix(1.4, 3.4, steep) - puddle * (1.0 - steep) * 0.9;
    vec3 soft = sampleReflectionSoft(ruv, lodS);
    // emissive sources keep their crisp streak (max channel, so saturated red tail lights / blue neon count)
    float hot = smoothstep(0.3, 2.2, max(max(sharp.r, sharp.g), sharp.b));
    float blurAmt = (1.0 - hot) * mix(0.3, 1.0, steep) * (1.0 - 0.45 * puddle * (1.0 - steep));
    vec3 refl = mix(sharp, soft, blurAmt);
    // mid/dark tones: lower contrast, esp. near field. Light sources get the HDR punch instead: they are
    // orders of magnitude brighter than lit surfaces, so even ~5 % Fresnel leaves a visible coloured streak.
    refl *= mix(mix(0.9, 0.4, steep), mix(1.25, 2.6, steep), hot);
    vec3 planar = refl * fres * wet * (1.0 + shim * 0.9 * farP);
    // The planar reflection replaces the IBL. Only rough asphalt keeps a hint of the (very blurred) env glow:
    // in smooth puddles the PMREM's stylised neon boxes would otherwise show up as crisp, flat coloured patches
    // that match nothing in the actual street.
    float ibl = 0.15 * smoothstep(0.18, 0.45, rr);
    reflectedLight.indirectSpecular = reflectedLight.indirectSpecular * ibl + planar;
  }
}
`;

// ---------------------------------------------------------------------------------------------
// Road material
// ---------------------------------------------------------------------------------------------

/**
 * @param shared  createWetShared() result
 * @param data    { length, kerbTex, lampTex, lampSpacing, lampCount, lampU, lampH, crosswalks[], grid }
 */
export function createRoadMaterial(shared, data) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.0, envMapIntensity: 1.0 });
  const uniforms = {
    ...shared.uniforms,
    uTrackLen: { value: data.length },
    uKerbTex: { value: data.kerbTex },
    uLampTex: { value: data.lampTex },
    uLampSpacing: { value: data.lampSpacing },
    uLampCount: { value: data.lampCount },
    uLampU: { value: data.lampU },
    uLampH: { value: data.lampH },
    uMarkTex: { value: data.markTex },
    uExtra: { value: (data.extraPools || []).slice(0, 4).concat([0, 0, 0, 0].map(() => new THREE.Vector4())).slice(0, 4) },
    uGrid: { value: new THREE.Vector3(data.grid.lateral, data.grid.first, data.grid.pitch) },
    uStartGlow: { value: 1 },
  };
  mat.userData.uniforms = uniforms;
  mat.customProgramCacheKey = () => 'mapex-road-v2-' + shared.quality;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aRoad;
attribute vec2 aRight;
varying vec4 vRoad;
varying vec2 vRight;
varying vec3 vWPos;`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
vRoad = aRoad;
vRight = aRight;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);

    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
${WET_PARS}
varying vec4 vRoad;
varying vec2 vRight;
uniform float uTrackLen;
uniform sampler2D uKerbTex;
uniform sampler2D uLampTex;
uniform float uLampSpacing;
uniform float uLampCount;
uniform float uLampU;
uniform float uLampH;
uniform sampler2D uMarkTex;
uniform vec4 uExtra[4];
uniform vec3 uGrid;

float aaLine(float x, float w) { float a = fwidth(x) * 0.75 + 1e-4; return 1.0 - smoothstep(w * 0.5 - a, w * 0.5 + a, abs(x)); }
float aaBand(float x, float a0, float a1) { float a = fwidth(x) * 0.75 + 1e-4; return smoothstep(a0 - a, a0 + a, x) * (1.0 - smoothstep(a1 - a, a1 + a, x)); }
float wrapD(float d, float L) { return d - L * floor(d / L + 0.5); }
`)
      // --- surface definition (albedo, markings, puddles) ---
      .replace('#include <color_fragment>', `#include <color_fragment>
float ru = vRoad.x, rv = vRoad.y, surf = vRoad.z, kap = vRoad.w;
float au = abs(ru);
vec3 R3 = vec3(vRight.x, 0.0, vRight.y);
vec3 F3 = vec3(vRight.y, 0.0, -vRight.x);
vec4 det = texture2D(uDetailTex, vec2(ru, rv) * 0.25);
vec4 det2 = texture2D(uDetailTex, vec2(ru, rv) * 0.0731 + vec2(0.37, 0.11));
vec4 mac = texture2D(uMacroTex, vec2(ru, rv) / 48.0);
vec4 mac2 = texture2D(uMacroTex, vec2(rv, ru) / 151.0 + 0.5);
float walk = clamp(surf, 0.0, 1.0);                 // 1 on sidewalks
float curbF = step(1.5, surf) * step(surf, 2.5);    // curb faces
float isRoad = 1.0 - max(walk, curbF);

// ---- asphalt ----
float stain = mac.g;
float patchM = smoothstep(0.86, 0.9, stain);
float alb = 0.04 * (0.75 + 0.5 * det.b) * (0.88 + 0.24 * det2.b) * mix(1.0, 0.8, patchM) * (0.88 + 0.24 * mac2.g);
vec3 col = vec3(alb) * vec3(1.0, 0.985, 0.97);
float seam = mac.b * (1.0 - patchM);
col = mix(col, vec3(0.014), seam * 0.5);

// water collects in the gutters, in the wheel ruts and in random dips
float lanePos = fract((ru + 8.0) / 4.0);
float rut = exp(-pow((lanePos - 0.28) * 8.0, 2.0)) + exp(-pow((lanePos - 0.72) * 8.0, 2.0));
float gutter = smoothstep(6.8, 9.6, au) * isRoad;
float pud = mac.r * 0.85 + mac2.r * 0.3 + gutter * 0.32 + rut * 0.06 + patchM * 0.08;
float puddle = smoothstep(0.655, 0.815, pud) * isRoad; // soft shores: no hard-edged mirror patches
float rough = (0.36 + 0.18 * det.a + 0.1 * (1.0 - mac.a)) * mix(1.0, 0.8, rut * 0.5);
rough = mix(rough, 0.2, seam);
float metal = 0.0;
float wet = 0.55 + 0.25 * mac.a;

// ---- markings (paint) ----
float straightish = 1.0 - smoothstep(1.0 / 90.0, 1.0 / 60.0, abs(kap));
float dash = aaBand(fract(rv / 12.0) * 12.0, 0.0, 3.0);
float paintW = 0.0; vec3 paintC = vec3(0.78);
float laneL = (aaLine(ru - 4.0, 0.13) + aaLine(ru + 4.0, 0.13)) * dash * straightish;
float edgeL = aaLine(au - 7.85, 0.16);
float yellowL = (aaLine(ru - 0.13, 0.1) + aaLine(ru + 0.13, 0.1)) * straightish;
paintW = max(laneL, edgeL);

// crosswalks + stop lines (signed distance to the nearest crosswalk centre, precomputed per meter)
float zebra = 0.0, stopL = 0.0;
{
  float d = texture2D(uMarkTex, vec2(rv / uTrackLen, 0.5)).r;
  if (abs(d) < 6.0) {
    zebra = aaBand(d, -2.0, 2.0) * aaBand(fract(ru / 1.1 + 0.25) * 1.1, 0.0, 0.55) * step(au, 7.4);
    stopL = max(aaBand(d, -3.4, -2.9) * aaBand(ru, 0.35, 7.6), aaBand(d, 2.9, 3.4) * aaBand(ru, -7.6, -0.35));
  }
}
yellowL *= 1.0 - zebra;
laneL *= 1.0 - zebra;
paintW = max(paintW, max(zebra, stopL));

// start / finish: chequered band + grid boxes
float d0 = wrapD(rv, uTrackLen);
float chk = 0.0, chkWhite = 0.0;
if (abs(d0) < 1.4 && au < 7.95) {
  float cell = mod(floor(ru / 0.8) + floor((d0 + 1.2) / 0.8), 2.0);
  chk = aaBand(d0, -1.2, 1.2);
  chkWhite = cell;
}
float gridM = 0.0;
if (d0 < 0.0 && d0 > -70.0) {
  float k = clamp(floor((-d0 - uGrid.y + 2.6 + uGrid.z * 0.5) / uGrid.z), 0.0, 7.0);
  float sk = -(uGrid.y + k * uGrid.z);
  float lat = mod(k, 2.0) < 0.5 ? -uGrid.x : uGrid.x;
  float front = sk + 2.6;
  gridM = aaBand(d0, front - 0.16, front) * step(abs(ru - lat), 1.4);
  gridM = max(gridM, aaLine(abs(ru - lat) - 1.35, 0.13) * aaBand(d0, front - 1.4, front));
}
paintW = max(paintW, gridM);
paintW = max(paintW, chk * chkWhite);
// pole position text-free "GRID" stripe accent: thin yellow line along the pit side of the grid
float paintY = yellowL * (1.0 - chk);

// wear: paint is worn away in the wheel paths and by age
float wearM = smoothstep(0.18, 0.55, mac.a * 0.8 + det.b * 0.35 + (1.0 - rut) * 0.15);
paintW *= wearM; paintY *= wearM;
float paint = max(paintW, paintY) * isRoad;
col = mix(col, vec3(0.62, 0.62, 0.6), paintW * isRoad);
col = mix(col, vec3(0.62, 0.42, 0.04), paintY * isRoad);
col = mix(col, vec3(0.012), chk * (1.0 - chkWhite) * isRoad);
rough = mix(rough, 0.32, paint);

// ---- kerbs (red/white rumble strips at apexes / exits) ----
vec4 kb = texture2D(uKerbTex, vec2(rv / uTrackLen, 0.5));
float kerbSide = ru < 0.0 ? max(kb.r, kb.b) : max(kb.g, kb.a);
float kerbM = kerbSide * aaBand(au, 7.55, 9.25) * isRoad;
float kStripe = step(0.5, fract(rv / 2.0));
vec3 kerbC = mix(vec3(0.55, 0.035, 0.03), vec3(0.62, 0.62, 0.6), kStripe);
col = mix(col, kerbC * (0.85 + 0.3 * det.b), kerbM);
rough = mix(rough, 0.3, kerbM);
puddle *= 1.0 - kerbM;

// ---- manholes and drain grates ----
{
  float mi = floor(rv / 43.0);
  float mh = wHash12(vec2(mi, 3.7));
  float lane = floor(mh * 4.0);
  vec2 mc = vec2(-6.0 + lane * 4.0 + (mh - 0.5) * 1.2, mi * 43.0 + 21.5);
  float dm = length(vec2(ru, rv) - mc);
  if (dm < 0.42 && mh > 0.25) {
    float ring = aaBand(dm, 0.36, 0.40);
    float grid = step(0.5, fract((ru + rv) * 6.0)) * 0.5 + 0.5;
    col = mix(vec3(0.05, 0.048, 0.045) * grid, vec3(0.01), ring);
    metal = 0.75; rough = 0.38; puddle *= 0.2; paint = 0.0;
  }
  float gi = floor(rv / 24.0);
  float gv = rv - gi * 24.0 - 12.0;
  float gate = aaBand(au, 8.55, 9.15) * aaBand(gv, -0.5, 0.5) * isRoad;
  if (gate > 0.0) {
    float slots = step(0.5, fract(gv * 6.0));
    col = mix(col, vec3(0.03) * slots, gate);
    metal = mix(metal, 0.8, gate); rough = mix(rough, 0.45, gate);
  }
}

// ---- sidewalk pavers + curb faces ----
if (walk > 0.001 || curbF > 0.5) {
  float pu = (au - 9.8) / 0.6, pv = rv / 0.6;
  float joint = max(aaLine(fract(pu) - 0.5, 0.04 / 0.6 * 2.0) , aaLine(fract(pv + 0.5 * step(0.5, fract(pu * 0.5))) - 0.5, 0.04 / 0.6 * 2.0));
  float tileVar = wHash12(floor(vec2(pu, pv + 0.5 * step(0.5, fract(pu * 0.5)))));
  vec3 wc = vec3(0.16, 0.155, 0.15) * (0.75 + 0.35 * tileVar) * (0.8 + 0.4 * det.b) * (0.8 + 0.3 * mac.g);
  wc = mix(wc, vec3(0.05), joint * 0.7);
  // curb stone edge band (granite) on the first 0.3 m
  float curbTop = aaBand(au, 9.8, 10.1);
  wc = mix(wc, vec3(0.2, 0.2, 0.21) * (0.8 + 0.4 * det2.b), curbTop);
  vec3 cc = vec3(0.19, 0.19, 0.2) * (0.75 + 0.45 * det.b);
  vec3 sideC = mix(wc, cc, curbF);
  col = mix(col, sideC, max(walk, curbF));
  rough = mix(rough, mix(0.42 + 0.2 * det.a + joint * 0.2, 0.5, curbF), max(walk, curbF));
  float wp = smoothstep(0.8, 0.86, mac.r * 0.9 + mac2.r * 0.3) * walk * (1.0 - joint);
  puddle = max(puddle, wp * 0.85);
  wet = mix(wet, 0.5, walk);
}

// puddles: darker, mirror smooth
col *= mix(1.0, 0.55, puddle);
rough = mix(rough, 0.035, puddle);
wet = mix(wet, 1.0, puddle);
diffuseColor.rgb = col;
`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = rough;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = metal;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
vec3 nW = transformNormalByInverseViewMatrix(normal, viewMatrix);
{
  float flatW = step(0.7, nW.y);
  // fade micro-normals with distance (they would only alias/sparkle; roughness takes over)
  float px = length(fwidth(vec2(ru, rv)));
  float near = 1.0 - smoothstep(0.02, 0.12, px);
  vec2 dn = ((det.rg * 2.0 - 1.0) * 0.28 * near + (det2.rg * 2.0 - 1.0) * 0.22);
  dn *= (1.0 - puddle * 0.97) * (1.0 - paint * 0.5) * (1.0 + walk * 0.6);
  // kerb ridges catch the light
  dn.x += kerbM * sin(rv * 3.14159) * 0.12;
  vec2 rip = vec2(0.0);
  if (puddle > 0.02 && px < 0.05) rip = rainRipples(vWPos.xz, uTime) * puddle * uRain * (1.0 - smoothstep(0.012, 0.05, px));
  // low-frequency undulation (road is never perfectly flat → wobbly reflections)
  vec2 und = (mac2.rg - 0.5) * 0.06;
  vec3 pert = R3 * (dn.x + und.x) + F3 * (dn.y + und.y) + vec3(rip.x, 0.0, rip.y) * 0.35;
  nW = normalize(nW + pert * flatW);
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}`)
      // --- streetlight pools + planar reflection, before the final composition ---
      .replace('#include <aomap_fragment>', `
{
  // Analytic streetlights: lamp k sits at s=(k+0.5)*spacing, heads at lateral ±uLampU, height uLampH.
  vec3 RV = (viewMatrix * vec4(R3, 0.0)).xyz;
  vec3 FV = (viewMatrix * vec4(F3, 0.0)).xyz;
  vec3 UV3 = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
  float kc = floor(rv / uLampSpacing - 0.5); // lamp pair just behind; kc + 1 = just ahead
  float stretch = 1.0 - kap * ru; // arc length at this lateral offset vs centerline
  for (int o = 0; o <= 1; o++) {
    float k = kc + float(o);
    float dv = ((k + 0.5) * uLampSpacing - rv) * stretch;
    int ki = int(mod(k, uLampCount));
    for (int sd = 0; sd < 2; sd++) {
      vec4 L = texelFetch(uLampTex, ivec2(ki, sd), 0);
      if (L.a < 0.5) continue;
      float side = sd == 0 ? -1.0 : 1.0;
      float du = side * uLampU - ru;
      float h = uLampH - vWPos.y;
      vec3 lv = du * RV + dv * FV + h * UV3;
      float d2 = dot(lv, lv);
      vec3 ld = lv * inversesqrt(d2);
      float cosD = h * inversesqrt(d2);               // angle from straight down
      float cutoff = smoothstep(0.18, 0.55, cosD);      // flat-glass luminaire cutoff
      if (cutoff <= 0.0) continue;
      IncidentLight il;
      il.direction = ld;
      il.color = L.rgb * (cutoff / (d2 + 4.0));
      il.visible = true;
      RE_Direct(il, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
    }
  }
  // extra pools (sodium fixtures under the elevated highway): uExtra[i] = (s, u, height, intensity)
  for (int i = 0; i < 4; i++) {
    vec4 E = uExtra[i];
    float dv = wrapD(E.x - rv, uTrackLen) * stretch;
    if (abs(dv) > 18.0 || E.w <= 0.0) continue;
    float h = E.z - vWPos.y;
    vec3 lv = (E.y - ru) * RV + dv * FV + h * UV3;
    float d2 = dot(lv, lv);
    IncidentLight il;
    il.direction = lv * inversesqrt(d2);
    il.color = vec3(1.0, 0.52, 0.16) * E.w / (d2 + 4.0);
    il.visible = true;
    RE_Direct(il, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  }
}
${WET_REFLECT}
#include <aomap_fragment>`);
  };
  return mat;
}

// ---------------------------------------------------------------------------------------------
// Generic wet ground (city streets/plazas beyond the circuit, side streets).
// ---------------------------------------------------------------------------------------------

export function createGroundMaterial(shared, { tint = 1 } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0 });
  mat.customProgramCacheKey = () => 'mapex-ground-v1';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared.uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + WET_PARS)
      .replace('#include <color_fragment>', `#include <color_fragment>
vec2 gp = vWPos.xz;
vec4 det = texture2D(uDetailTex, gp * 0.25);
vec4 mac = texture2D(uMacroTex, gp / 48.0);
vec4 mac2 = texture2D(uMacroTex, gp / 173.0 + 0.3);
float puddle = smoothstep(0.67, 0.79, mac.r * 0.8 + mac2.r * 0.35);
vec3 col = vec3(0.045 * ${tint.toFixed(3)}) * (0.7 + 0.6 * det.b) * (0.8 + 0.4 * mac2.g);
col = mix(col, vec3(0.012), mac.b * 0.8);
float rough = 0.42 + 0.2 * det.a;
float wet = 0.5;
col *= mix(1.0, 0.55, puddle);
rough = mix(rough, 0.04, puddle);
wet = mix(wet, 1.0, puddle);
diffuseColor.rgb = col;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = rough;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
vec3 nW = vec3(0.0, 1.0, 0.0);
{
  float gpx = length(fwidth(gp));
  vec2 dn = (det.rg * 2.0 - 1.0) * 0.3 * (1.0 - puddle) * (1.0 - smoothstep(0.02, 0.12, gpx));
  vec2 rip = rainRipples(gp, uTime) * puddle * uRain * 0.4 * (1.0 - smoothstep(0.012, 0.05, gpx));
  nW = normalize(vec3(dn.x + rip.x, 1.0, dn.y + rip.y));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}`)
      .replace('#include <aomap_fragment>', WET_REFLECT + '\n#include <aomap_fragment>');
  };
  return mat;
}
