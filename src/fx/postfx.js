// MIDNIGHT APEX — cinematic post-processing stack (owner: fx).
//
// Chain (all intermediate targets are HalfFloat / linear HDR):
//   RenderPass (arms the scene-depth snapshot used by soft particles, see sceneDepth.js)
//   → UnrealBloomPass (custom soft-knee, firefly-clamped bright pass, reduced res; its final
//                full-res additive blend is skipped — the cinematic pass samples the bloom composite itself)
//   → AnamorphicStreakPass (tiny horizontal Kawase-style streak of small, genuinely hot lights, 'high' only)
//   → RadialPrePass  (half res, only while the speed blur is visible: short jittered radial blur of
//                     scene + bloom — the "fine" half of a two-level 8×8-tap radial blur)
//   → CinematicPass  (ONE full-screen pass: radial speed blur (coarse taps over the pre-pass) + spectral
//                     chromatic aberration, lens warp, anamorphic streak add, impact flash, tone mapping
//                     (renderer.toneMapping/exposure, same as OutputPass) + sRGB encode, display-space grade,
//                     vignette, film grain)
//   → SMAAPass ('high') / FXAAPass ('low')
//
// The CinematicPass *is* the output pass: it applies renderer.toneMapping + toneMappingExposure and the
// renderer.outputColorSpace transfer exactly like three's OutputPass, so a separate OutputPass would only cost
// another full-screen read/write. Grading/grain/vignette then happen in display space where they are predictable.
//
// Speed blur: zoom blur toward the screen centre that only affects the periphery (NFS style). The player car is
// protected by a soft elliptical "focus" mask (default: the chase-cam car, bottom centre; core may override it
// per camera via set({ focus, focusRadius })): pixels inside it are not blurred, and taps that land inside it are
// rejected for pixels outside it — otherwise the road below/around the car pulls in magnified copies of the car.
// Taps are jittered per pixel with interleaved gradient noise that also changes every frame, so the 64 effective
// taps never form discrete ghost images.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { createSceneDepth } from './sceneDepth.js';

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Bloom bright pass replacement: 4 bilinear taps (= 4x4 box) with Karis weighting so single hot pixels
// (distant lamps, sparks, specular glints on wet asphalt) don't shimmer, a soft knee instead of the default
// hard step, and a luminance clamp so HDR emissives (intensity 20+) can't blow the bloom up.
const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float luminosityThreshold;
uniform float smoothWidth;
uniform vec2 srcTexel;
uniform float maxLum;
varying vec2 vUv;
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  vec3 a = texture2D(tDiffuse, vUv + srcTexel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture2D(tDiffuse, vUv + srcTexel * vec2( 1.0, -1.0)).rgb;
  vec3 c = texture2D(tDiffuse, vUv + srcTexel * vec2(-1.0,  1.0)).rgb;
  vec3 d = texture2D(tDiffuse, vUv + srcTexel * vec2( 1.0,  1.0)).rgb;
  float wa = 1.0 / (1.0 + lum(a)), wb = 1.0 / (1.0 + lum(b)), wc = 1.0 / (1.0 + lum(c)), wd = 1.0 / (1.0 + lum(d));
  vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
  // a single NaN/Inf pixel from any shader would be smeared over the whole frame by the blur chain
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  float l = lum(col);
  float knee = max(smoothWidth, 1e-4);
  float soft = clamp(l - luminosityThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, l - luminosityThreshold) / max(l, 1e-4);
  col *= contrib;
  float lc = lum(col);
  if (lc > maxLum) col *= maxLum / lc;
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Anamorphic streaks: downsample the bloom bright-pass into a short & wide target, then 3 horizontal blur
// passes with exponentially growing tap spacing (1, 4, 16 texels) — a long exponential horizontal tail
// for ~4 tiny draws. Very "night street racing" when a headlight or street lamp is in frame.
// Streaks are reserved for small, genuinely hot sources (lamps, headlights, tail lights): the local average
// of the bright pass (a wide bloom mip, σ ≈ 40 px) is subtracted first, so a large brightly *lit* surface
// (paint of a car ahead in the player's headlights, a lit wall) — whose local average ≈ itself — produces no
// streak, while a point light — whose local average is a tiny fraction of its peak — keeps its full streak.
const STREAK_DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tWide;
uniform vec2 srcTexel;
uniform float threshold;
uniform float isolate;
varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  c += texture2D(tSrc, vUv + srcTexel * vec2(-1.5, -0.5)).rgb;
  c += texture2D(tSrc, vUv + srcTexel * vec2( 1.5, -0.5)).rgb;
  c += texture2D(tSrc, vUv + srcTexel * vec2(-1.5,  0.5)).rgb;
  c += texture2D(tSrc, vUv + srcTexel * vec2( 1.5,  0.5)).rgb;
  c *= 0.25;
  c = max(c - texture2D(tWide, vUv).rgb * isolate, 0.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= max(l - threshold, 0.0) / max(l, 1e-4);
  gl_FragColor = vec4(min(c, vec3(40.0)), 1.0);
}`;

const STREAK_BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
uniform float stepPx;
uniform float atten;
varying vec2 vUv;
void main() {
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = -3; i <= 3; i++) {
    float fi = float(i);
    float w = pow(atten, abs(fi) * stepPx);
    sum += texture2D(tSrc, vUv + vec2(fi * stepPx * texel.x, 0.0)).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / wsum, 1.0);
}`;

class AnamorphicStreakPass extends Pass {
  constructor(bloomPass) {
    super();
    this.needsSwap = false;
    this.bloomPass = bloomPass;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.rtA = new THREE.WebGLRenderTarget(16, 16, opts);
    this.rtB = new THREE.WebGLRenderTarget(16, 16, opts);
    this.rtA.texture.name = 'Streak.A';
    this.rtB.texture.name = 'Streak.B';
    this.down = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: null },
        tWide: { value: null },
        srcTexel: { value: new THREE.Vector2() },
        threshold: { value: 1.6 },
        isolate: { value: 1.0 },
      },
      vertexShader: FS_VERT,
      fragmentShader: STREAK_DOWN_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.blur = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: null },
        texel: { value: new THREE.Vector2() },
        stepPx: { value: 1 },
        atten: { value: 0.93 },
      },
      vertexShader: FS_VERT,
      fragmentShader: STREAK_BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(null);
  }
  get texture() {
    return this.rtB.texture;
  }
  setSize(width, height) {
    // width/height = composer effective resolution. Streak target: 1/8 wide, 1/4 tall (thin lines, cheap).
    const w = Math.max(16, Math.round(width / 8));
    const h = Math.max(16, Math.round(height / 4));
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    this.blur.uniforms.texel.value.set(1 / w, 1 / h);
  }
  render(renderer) {
    const bp = this.bloomPass;
    const src = bp.renderTargetBright;
    // blurred bright-pass mip (σ ≈ 40 CSS px) = local average for the hot-point isolation
    const wide = bp.renderTargetsVertical[Math.min(2, bp.nMips - 1)];
    this.down.uniforms.tWide.value = wide.texture;
    this.down.uniforms.tSrc.value = src.texture;
    this.down.uniforms.srcTexel.value.set(1 / src.width, 1 / src.height);
    this.quad.material = this.down;
    renderer.setRenderTarget(this.rtA);
    this.quad.render(renderer);
    this.quad.material = this.blur;
    const steps = [1, 4, 16];
    let read = this.rtA;
    let write = this.rtB;
    for (let i = 0; i < steps.length; i++) {
      this.blur.uniforms.tSrc.value = read.texture;
      this.blur.uniforms.stepPx.value = steps[i];
      renderer.setRenderTarget(write);
      this.quad.render(renderer);
      const t = read;
      read = write;
      write = t;
    }
    // after 3 passes the result is in rtB (A->B, B->A, A->B)
  }
  dispose() {
    this.rtA.dispose();
    this.rtB.dispose();
    this.down.dispose();
    this.blur.dispose();
    this.quad.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Speed-blur helpers shared by the pre-pass and the cinematic pass.
const BLUR_COMMON = /* glsl */ `
uniform vec2 uFocus;     // protected region centre (uv, v up from the bottom)
uniform vec2 uFocusR;    // protected region radii in screen-height units (x, y)
uniform float uFrame;    // frame counter → per-frame jitter rotation
// interleaved gradient noise (Jimenez): well-distributed per-pixel jitter, de-bands/de-ghosts the taps
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float frameJitter(vec2 fragCoord, float salt) { return fract(ign(fragCoord) + uFrame * 0.6180340 + salt); }
// 1 inside the protected (player car) ellipse, soft 0..1 rim, 0 outside
float protectMask(vec2 uv, float aspectX) {
  vec2 d = (uv - uFocus) * vec2(aspectX, 1.0) / uFocusR;
  return 1.0 - smoothstep(0.5, 1.0, length(d));
}
// blur span (fraction of the distance to the centre) as a function of the normalized radius:
// nothing in the central 30 %, quadratic ramp to the corners
float blurEdge(float rN) { float e = smoothstep(0.3, 1.0, rN); return e * e; }
`;

// Half-res "fine" radial blur of scene + bloom. Every texel averages FTAPS jittered taps over 1/CTAPS of the
// local blur span (with overlap), so the cinematic pass' CTAPS coarse taps over this texture integrate
// CTAPS × FTAPS samples along the zoom line with no gaps. Output is premultiplied by alpha = "not the protected
// car" (0 inside the focus ellipse): the coarse taps then reject the car for free (Σ w·rgb / Σ w·a) instead of
// evaluating the mask per tap — that per-tap mask cost ~0.65 ms at 1080p, more than the whole blur.
const RADIAL_PRE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float uBloomOn;
uniform vec2 uResolution;   // full-res size (aspect + pixel spans)
uniform float uBlur;
uniform float uFine;        // fraction of the span covered here
varying vec2 vUv;
${BLUR_COMMON}
vec3 src(vec2 uv) { return texture2D(tDiffuse, uv).rgb + texture2D(tBloom, uv).rgb * uBloomOn; }
void main() {
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 c = vUv - 0.5;
  float rN = length(c * aspect) / (0.5 * length(aspect));
  float prot = protectMask(vUv, aspect.x);
  float span = uBlur * blurEdge(rN) * (1.0 - prot) * uFine;
  float cov = 1.0 - prot;
  if (span * length(c * uResolution) < 0.75) { gl_FragColor = vec4(src(vUv) * cov, cov); return; }
  float j = frameJitter(gl_FragCoord.xy, 0.5);
  vec3 sum = vec3(0.0);
  float ws = 0.0;
  for (int i = 0; i < FTAPS; i++) {
    float t = (float(i) + j) / float(FTAPS);
    vec2 tuv = 0.5 + c * (1.0 - span * t);
    // never drag the protected car into its surroundings
    float keep = 1.0 - protectMask(tuv, aspect.x) * (1.0 - prot);
    sum += src(tuv) * keep;
    ws += keep;
  }
  gl_FragColor = vec4((ws > 0.05 ? sum / ws : src(vUv)) * cov, cov);
}`;

class RadialPrePass extends Pass {
  constructor({ fineTaps = 8, coarseTaps = 8 } = {}) {
    super();
    this.needsSwap = false;
    this.coarseTaps = coarseTaps;
    this.rt = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, depthBuffer: false });
    this.rt.texture.name = 'RadialBlur.pre';
    this.uniforms = {
      tDiffuse: { value: null },
      tBloom: { value: null },
      uBloomOn: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uBlur: { value: 0 },
      uFine: { value: 1.35 / coarseTaps },
      // replaced by the cinematic pass' uniform objects in createPostFX (shared focus / frame counter)
      uFocus: { value: new THREE.Vector2(0.5, 0.36) },
      uFocusR: { value: new THREE.Vector2(0.3, 0.17) },
      uFrame: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'RadialPrePass',
      uniforms: this.uniforms,
      defines: { FTAPS: fineTaps },
      vertexShader: FS_VERT,
      fragmentShader: RADIAL_PRE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }
  get texture() {
    return this.rt.texture;
  }
  setSize(width, height) {
    this.uniforms.uResolution.value.set(width, height);
    this.rt.setSize(Math.max(16, Math.round(width / 2)), Math.max(16, Math.round(height / 2)));
  }
  render(renderer, writeBuffer, readBuffer) {
    const bp = this.bloomPass;
    const bloomOn = !!(bp && bp.enabled && bp.skipBlend);
    this.uniforms.tBloom.value = bloomOn ? bp.renderTargetsHorizontal[0].texture : null;
    this.uniforms.uBloomOn.value = bloomOn ? 1 : 0;
    this.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.rt);
    this.quad.render(renderer);
  }
  dispose() {
    this.rt.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// The cinematic pass: everything per-pixel in one go.
const CINEMATIC_FRAG = /* glsl */ `
#include <common>
#include <tonemapping_pars_fragment>

uniform sampler2D tDiffuse;
uniform sampler2D tStreak;
uniform sampler2D tBloom;   // bloom composite (half res) — added here instead of a full-res additive blend pass
uniform sampler2D tBlur;    // half-res radial pre-blur (scene + bloom, premultiplied by not-car alpha), uBlurOn = 1
uniform float uBloomOn;
uniform float uBlurOn;
uniform vec2 uResolution;
uniform float uTime;
uniform float uBlur;        // radial speed blur length at the frame corners (fraction of the radius)
uniform float uCA;          // chromatic aberration (fraction of the radius at the corners)
uniform float uWarp;        // pincushion warp (nitro)
uniform float uZoom;        // nitro zoom punch
uniform float uVignette;
uniform float uGrain;
uniform float uImpact;      // 0..1 desaturate + flash
uniform float uStreak;      // anamorphic streak strength
uniform vec3 uStreakTint;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform float uBlackLift;
varying vec2 vUv;
${BLUR_COMMON}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 srcFull(vec2 uv) { return texture2D(tDiffuse, uv).rgb + texture2D(tBloom, uv).rgb * uBloomOn; }

void main() {
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 c = vUv - 0.5;
  // normalized radius: 0 at the centre, 1 in the corners (aspect-correct)
  float rN = length(c * aspect) / (0.5 * length(aspect));
  float r2 = rN * rN;

  // Lens: zoom punch + pincushion. Both pull samples toward the centre so we never sample outside the frame.
  vec2 dir = c * (1.0 - uZoom) * (1.0 - uWarp * r2);
  vec2 uv = 0.5 + dir;

  // the protected car region is neither blurred nor (much) fringed
  float prot = protectMask(uv, aspect.x);
  float blurSpan = uBlur * blurEdge(rN) * (1.0 - prot);
  float caSpan = uCA * r2 * (1.0 - 0.6 * prot);
  float dirPx = length(dir * uResolution);
  float blurPx = blurSpan * dirPx;
  float caPx = caSpan * dirPx;
  float jitter = frameJitter(gl_FragCoord.xy, 0.0);

  vec3 col;
#ifdef SPEED_BLUR
  // (variant compiled only while the speed blur is on: the slow-speed variant below carries no blur loop,
  //  so it keeps the register budget / occupancy of a plain CA pass)
  if (blurPx > 1.0) {
    // coarse taps over the pre-blurred half-res image (CTAPS × FTAPS effective samples), spectral CA folded in
    float span = blurSpan + caSpan;
    float chroma = clamp(caSpan / span * 1.6 + 0.12, 0.0, 1.0);
    vec3 sum = vec3(0.0);
    vec3 wsum = vec3(0.0);
    for (int i = 0; i < CTAPS; i++) {
      float t = (float(i) + jitter) / float(CTAPS);
      vec2 tuv = 0.5 + dir * (1.0 - span * t);
      // spectral weights: red from the outer taps, green mid, blue from the inner taps
      vec3 spec = vec3(1.0 - t, 1.0 - abs(2.0 * t - 1.0), t) * 2.0;
      // smooth falloff along the trail: the pixel's own neighbourhood dominates, the far end feathers out
      vec3 w = mix(vec3(1.0), spec, chroma) * (1.0 - 0.6 * t * t);
      vec4 s = texture2D(tBlur, tuv); // premultiplied: taps on the protected car carry ~0 weight
      sum += s.rgb * w;
      wsum += w * s.a;
    }
    vec3 blurred = sum / max(wsum, vec3(1e-4));
    // all taps rejected (right next to the car) → stay sharp; tiny spans fade in from the sharp image
    float cover = clamp(wsum.g * 2.5 / float(CTAPS), 0.0, 1.0);
    col = mix(srcFull(uv), blurred, smoothstep(1.0, 5.0, blurPx) * cover);
  } else if (caPx > 0.6) {
    // fixed 3-tap spectral fringe in the (barely blurred) middle ring
    float j = (jitter - 0.5) * 0.3333;
    vec3 a = srcFull(0.5 + dir * (1.0 - caSpan * (0.1667 + j)));
    vec3 b = srcFull(0.5 + dir * (1.0 - caSpan * (0.5 + j)));
    vec3 d = srcFull(0.5 + dir * (1.0 - caSpan * (0.8333 + j)));
    col = vec3(a.r * 0.6 + b.r * 0.4, a.g * 0.25 + b.g * 0.5 + d.g * 0.25, b.b * 0.4 + d.b * 0.6);
  } else {
    col = srcFull(uv);
  }
#else
  if (caPx > 0.6) {
    // chromatic fringe only (low speed): a few full-res spectral taps
    float fn = clamp(ceil(caPx / 2.0), 3.0, float(CATAPS));
    vec3 sum = vec3(0.0);
    vec3 wsum = vec3(0.0);
    for (int i = 0; i < CATAPS; i++) {
      if (float(i) >= fn) break;
      float t = (float(i) + jitter) / fn;
      vec2 tuv = 0.5 + dir * (1.0 - caSpan * t);
      vec3 w = vec3(1.0 - t, 1.0 - abs(2.0 * t - 1.0), t) * 2.0 + 0.12;
      sum += srcFull(tuv) * w;
      wsum += w;
    }
    col = sum / max(wsum, vec3(1e-4));
  } else {
    col = srcFull(uv);
  }
#endif

#ifdef USE_STREAKS
  col += texture2D(tStreak, uv).rgb * uStreakTint * uStreak;
#endif
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);

  // impact: brief desaturation + exposure flash (HDR, so highlights bloom out)
  float lumHdr = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(lumHdr) * vec3(1.05, 1.0, 0.95), uImpact * 0.4);
  col *= 1.0 + uImpact * 0.6;

  // ---- tone mapping + output transfer (same as OutputPass) ----
#if defined( LINEAR_TONE_MAPPING )
  col = LinearToneMapping(col);
#elif defined( REINHARD_TONE_MAPPING )
  col = ReinhardToneMapping(col);
#elif defined( CINEON_TONE_MAPPING )
  col = CineonToneMapping(col);
#elif defined( ACES_FILMIC_TONE_MAPPING )
  col = ACESFilmicToneMapping(col);
#elif defined( AGX_TONE_MAPPING )
  col = AgXToneMapping(col);
#elif defined( NEUTRAL_TONE_MAPPING )
  col = NeutralToneMapping(col);
#endif
  col = clamp(col, 0.0, 1.0);
#ifdef SRGB_TRANSFER
  col = sRGBTransferOETF(vec4(col, 1.0)).rgb;
#endif

  // ---- display-space grade: split-tone (teal shadows / warm highlights), saturation, S-curve ----
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float shadowW = 1.0 - smoothstep(0.0, 0.45, l);
  float highW = smoothstep(0.5, 1.0, l);
  col += uShadowTint * shadowW + uHighlightTint * highW;
  col = mix(vec3(l), col, uSaturation);
  col = clamp(col, 0.0, 1.0);
  col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);
  col = uBlackLift + col * (1.0 - uBlackLift);

  // vignette (stronger with speed/nitro — set from JS)
  float vig = 1.0 - uVignette * smoothstep(0.25, 1.15, rN);
  col *= vig;

  // animated film grain, strongest in the mids, gone in highlights
  float g = hash12(gl_FragCoord.xy + vec2(fract(uTime * 13.17) * 997.0, fract(uTime * 7.31) * 613.0)) - 0.5;
  col += g * uGrain * (1.0 - l * 0.8);

  gl_FragColor = vec4(col, 1.0);
}`;

class CinematicPass extends Pass {
  constructor({ coarseTaps = 8, caTaps = 6, streaks = true } = {}) {
    super();
    this.uniforms = {
      tDiffuse: { value: null },
      tStreak: { value: null },
      tBloom: { value: null },
      tBlur: { value: null },
      uBloomOn: { value: 0 },
      uBlurOn: { value: 0 },
      uFocus: { value: new THREE.Vector2(0.5, 0.36) },
      uFocusR: { value: new THREE.Vector2(0.3, 0.17) },
      uFrame: { value: 0 },
      toneMappingExposure: { value: 1 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uBlur: { value: 0 },
      uCA: { value: 0.004 },
      uWarp: { value: 0 },
      uZoom: { value: 0 },
      uVignette: { value: 0.32 },
      uGrain: { value: 0.035 },
      uImpact: { value: 0 },
      uStreak: { value: 0.35 },
      uStreakTint: { value: new THREE.Color(0.55, 0.75, 1.25) },
      uSaturation: { value: 1.1 },
      uContrast: { value: 0.22 },
      uShadowTint: { value: new THREE.Vector3(-0.012, 0.006, 0.02) },
      uHighlightTint: { value: new THREE.Vector3(0.025, 0.008, -0.02) },
      uBlackLift: { value: 0.012 },
    };
    const mk = (name) =>
      new THREE.ShaderMaterial({
        name,
        uniforms: this.uniforms,
        defines: { CTAPS: coarseTaps, CATAPS: caTaps },
        vertexShader: FS_VERT,
        fragmentShader: CINEMATIC_FRAG,
        depthTest: false,
        depthWrite: false,
        toneMapped: false, // we do it ourselves (renderer would only add it when rendering to screen)
      });
    // two programs sharing the uniforms: CA-only (slow) and speed blur (fast). Both are compiled on the first
    // render so switching never hitches.
    this.material = mk('CinematicPass');
    this.materialBlur = mk('CinematicPass.blur');
    this.streaks = streaks;
    this.quad = new FullScreenQuad(this.material);
    this._warm = null;
    this._tm = null;
    this._cs = null;
  }
  _syncDefines(renderer) {
    if (this._tm === renderer.toneMapping && this._cs === renderer.outputColorSpace) return;
    this._tm = renderer.toneMapping;
    this._cs = renderer.outputColorSpace;
    const d = { CTAPS: this.material.defines.CTAPS, CATAPS: this.material.defines.CATAPS };
    if (this.streaks) d.USE_STREAKS = '';
    if (THREE.ColorManagement.getTransfer(this._cs) === THREE.SRGBTransfer) d.SRGB_TRANSFER = '';
    const tm = this._tm;
    if (tm === THREE.LinearToneMapping) d.LINEAR_TONE_MAPPING = '';
    else if (tm === THREE.ReinhardToneMapping) d.REINHARD_TONE_MAPPING = '';
    else if (tm === THREE.CineonToneMapping) d.CINEON_TONE_MAPPING = '';
    else if (tm === THREE.ACESFilmicToneMapping) d.ACES_FILMIC_TONE_MAPPING = '';
    else if (tm === THREE.AgXToneMapping) d.AGX_TONE_MAPPING = '';
    else if (tm === THREE.NeutralToneMapping) d.NEUTRAL_TONE_MAPPING = '';
    this.material.defines = d;
    this.material.needsUpdate = true;
    this.materialBlur.defines = { ...d, SPEED_BLUR: '' };
    this.materialBlur.needsUpdate = true;
    this._warm = this._warm || new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
    this._needsWarm = true;
  }
  setSize(width, height) {
    this.uniforms.uResolution.value.set(width, height);
  }
  render(renderer, writeBuffer, readBuffer) {
    this._syncDefines(renderer);
    const bp = this.bloomPass;
    const bloomOn = !!(bp && bp.enabled && bp.skipBlend);
    this.uniforms.tBloom.value = bloomOn ? bp.renderTargetsHorizontal[0].texture : null;
    this.uniforms.uBloomOn.value = bloomOn ? 1 : 0;
    this.uniforms.tDiffuse.value = readBuffer.texture;
    const pre = this.prePass;
    const blurOn = !!(pre && pre.enabled);
    this.uniforms.tBlur.value = blurOn ? pre.texture : null;
    this.uniforms.uBlurOn.value = blurOn ? 1 : 0;
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
    if (this._needsWarm) {
      // compile the variant that isn't used this frame (into a 4×4 scratch target)
      this._needsWarm = false;
      this.quad.material = blurOn ? this.material : this.materialBlur;
      renderer.setRenderTarget(this._warm);
      this.quad.render(renderer);
    }
    this.quad.material = blurOn ? this.materialBlur : this.material;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.quad.render(renderer);
  }
  dispose() {
    this.material.dispose();
    this.materialBlur.dispose();
    if (this._warm) this._warm.dispose();
    this.quad.dispose();
  }
}

// ---------------------------------------------------------------------------------------------

// UnrealBloomPass.render (three r186) without its last step (the additive blend onto readBuffer).
function renderBloomNoBlend(bp, renderer, readBuffer) {
  renderer.getClearColor(bp._oldClearColor);
  bp._oldClearAlpha = renderer.getClearAlpha();
  const oldAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setClearColor(bp.clearColor, 0);
  const quad = bp._fsQuad;
  // 1. bright pass
  bp.highPassUniforms.tDiffuse.value = readBuffer.texture;
  bp.highPassUniforms.luminosityThreshold.value = bp.threshold;
  quad.material = bp.materialHighPassFilter;
  renderer.setRenderTarget(bp.renderTargetBright);
  renderer.clear();
  quad.render(renderer);
  // 2. separable blur down the mip chain
  let input = bp.renderTargetBright;
  for (let i = 0; i < bp.nMips; i++) {
    const m = bp.separableBlurMaterials[i];
    quad.material = m;
    m.uniforms.colorTexture.value = input.texture;
    m.uniforms.direction.value = UnrealBloomPass.BlurDirectionX;
    renderer.setRenderTarget(bp.renderTargetsHorizontal[i]);
    renderer.clear();
    quad.render(renderer);
    m.uniforms.colorTexture.value = bp.renderTargetsHorizontal[i].texture;
    m.uniforms.direction.value = UnrealBloomPass.BlurDirectionY;
    renderer.setRenderTarget(bp.renderTargetsVertical[i]);
    renderer.clear();
    quad.render(renderer);
    input = bp.renderTargetsVertical[i];
  }
  // 3. composite the mips → renderTargetsHorizontal[0] (sampled by the cinematic pass)
  quad.material = bp.compositeMaterial;
  bp.compositeMaterial.uniforms.bloomStrength.value = bp.strength;
  bp.compositeMaterial.uniforms.bloomRadius.value = bp.radius;
  bp.compositeMaterial.uniforms.bloomTintColors.value = bp.bloomTintColors;
  renderer.setRenderTarget(bp.renderTargetsHorizontal[0]);
  renderer.clear();
  quad.render(renderer);
  renderer.setClearColor(bp._oldClearColor, bp._oldClearAlpha);
  renderer.autoClear = oldAutoClear;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export function createPostFX({ renderer, scene, camera, quality } = {}) {
  const high = (quality ?? 'high') !== 'low';
  const composer = new EffectComposer(renderer);
  const size = renderer.getSize(new THREE.Vector2());

  const renderPass = new RenderPass(scene, camera);
  // Arm the scene-depth snapshot for the main scene render: the first soft-particle draw blits the opaque depth
  // (see sceneDepth.js). Nothing is copied when no soft particles are on screen.
  const sceneDepth = createSceneDepth(renderer);
  const renderPassRender = renderPass.render.bind(renderPass);
  renderPass.render = (r, writeBuffer, readBuffer, deltaTime, maskActive) => {
    sceneDepth.begin(r, renderPass.renderToScreen ? null : readBuffer);
    try {
      renderPassRender(r, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      sceneDepth.end();
    }
  };
  composer.addPass(renderPass);

  // --- bloom ---
  // threshold is in linear HDR (before tone mapping): only emissives / lamps / sparks / specular glints bloom.
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.42, 0.6, 0.9);
  bloomPass.highPassUniforms.srcTexel = { value: new THREE.Vector2(1 / size.x, 1 / size.y) };
  bloomPass.highPassUniforms.maxLum = { value: 24 };
  bloomPass.highPassUniforms.smoothWidth.value = 0.45; // soft knee width
  bloomPass.materialHighPassFilter.dispose();
  bloomPass.materialHighPassFilter = new THREE.ShaderMaterial({
    uniforms: bloomPass.highPassUniforms,
    vertexShader: FS_VERT,
    fragmentShader: BRIGHT_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  // Run the bloom chain at ~half of the CSS resolution regardless of the device pixel ratio
  // (UnrealBloomPass already halves whatever it gets; we pre-scale away the extra DPR).
  const bloomSetSize = bloomPass.setSize.bind(bloomPass);
  bloomPass.setSize = (w, h) => {
    const pr = Math.max(1, renderer.getPixelRatio());
    const s = (high ? 1 : 0.75) / pr;
    bloomPass.highPassUniforms.srcTexel.value.set(1 / w, 1 / h);
    bloomSetSize(Math.max(64, Math.round(w * s)), Math.max(64, Math.round(h * s)));
  };
  // The stock pass ends with a full-resolution additive blend of the bloom onto the HDR frame (a whole
  // RGBA16F read-modify-write). The cinematic pass samples the half-res bloom composite directly instead.
  bloomPass.skipBlend = true;
  // Soft ceiling on the bloom composite: normal lamp / neon halos (bloom luminance < knee, ~98 % of a race frame)
  // are untouched, but a large bright *area* — a barrier lit point-blank by the headlights, a car ahead in the
  // beam — can no longer flood a third of the frame with white glow (it saturates toward knee + range).
  const cm = bloomPass.compositeMaterial;
  cm.uniforms.bloomKnee = { value: 0.6 };
  cm.uniforms.bloomRange = { value: 1.0 };
  const cmFrag = cm.fragmentShader
    .replace('uniform float bloomRadius;', 'uniform float bloomRadius;\nuniform float bloomKnee;\nuniform float bloomRange;')
    .replace(
      'float bloomAlpha =',
      `float bl = dot(bloom, vec3(0.2126, 0.7152, 0.0722));
      if (bl > bloomKnee) { float over = bl - bloomKnee; bloom *= (bloomKnee + over / (1.0 + over / bloomRange)) / bl; }
      float bloomAlpha =`,
    );
  if (cmFrag.includes('bloomKnee + over')) {
    cm.fragmentShader = cmFrag;
    cm.needsUpdate = true;
  }
  const bloomRender = bloomPass.render.bind(bloomPass);
  bloomPass.render = (r, writeBuffer, readBuffer, deltaTime, maskActive) => {
    if (!bloomPass.skipBlend || bloomPass.renderToScreen) return bloomRender(r, writeBuffer, readBuffer, deltaTime, maskActive);
    renderBloomNoBlend(bloomPass, r, readBuffer);
  };
  composer.addPass(bloomPass);

  // --- anamorphic streaks (high only) ---
  let streakPass = null;
  if (high) {
    streakPass = new AnamorphicStreakPass(bloomPass);
    composer.addPass(streakPass);
  }

  // --- speed blur pre-pass (half res; enabled only while the blur is visible) ---
  const COARSE = high ? 8 : 6;
  const prePass = new RadialPrePass({ fineTaps: high ? 8 : 6, coarseTaps: COARSE });
  prePass.bloomPass = bloomPass;
  prePass.enabled = false;
  composer.addPass(prePass);

  // --- cinematic (+ tone mapping / output) ---
  const cinematic = new CinematicPass({ coarseTaps: COARSE, caTaps: high ? 6 : 4, streaks: !!streakPass });
  cinematic.bloomPass = bloomPass;
  cinematic.prePass = prePass;
  if (streakPass) cinematic.uniforms.tStreak.value = streakPass.texture;
  // the pre-pass shares the focus / jitter uniforms
  prePass.uniforms.uFocus = cinematic.uniforms.uFocus;
  prePass.uniforms.uFocusR = cinematic.uniforms.uFocusR;
  prePass.uniforms.uFrame = cinematic.uniforms.uFrame;
  composer.addPass(cinematic);

  // --- anti-aliasing (on the display-referred image, as SMAA/FXAA expect) ---
  const aaPass = high ? new SMAAPass() : new FXAAPass();
  composer.addPass(aaPass);

  // make sure every pass got the right (pixel-ratio aware) size
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);

  // --- dynamic state ---
  const target = { speed: 0, nitro: 0, impact: 0, shake: 0 };
  const cur = { speed: 0, nitro: 0, impact: 0, shake: 0, nitroPulse: 0, prevNitro: 0 };
  let time = 0;
  let frame = 0;
  let lastNow = performance.now();
  // Speed-blur protected region (the player car). Default = chase cams: car at the bottom centre.
  // focus = [u, v] in uv (v up from the bottom); focusRadius = [rx, ry] (or one number) in screen-height units.
  const DEFAULT_FOCUS = [0.5, 0.36];
  const DEFAULT_FOCUS_R = [0.3, 0.17];
  const setFocus = (focus, radius) => {
    const f = cinematic.uniforms.uFocus.value;
    const r = cinematic.uniforms.uFocusR.value;
    if (focus === null) f.fromArray(DEFAULT_FOCUS);
    else if (focus !== undefined) {
      const fx = Array.isArray(focus) ? focus[0] : focus.x;
      const fy = Array.isArray(focus) ? focus[1] : focus.y;
      if (Number.isFinite(+fx) && Number.isFinite(+fy)) f.set(+fx, +fy);
    }
    if (radius === null) r.fromArray(DEFAULT_FOCUS_R);
    else if (radius !== undefined) {
      const rx = typeof radius === 'number' ? radius : Array.isArray(radius) ? radius[0] : radius.x;
      const ry = typeof radius === 'number' ? radius : Array.isArray(radius) ? radius[1] : radius.y;
      // radius 0 = protect nothing (tiny ellipse far off-screen)
      if (!(+rx > 0) || !(+ry > 0)) { r.set(1e-3, 1e-3); f.set(-10, -10); }
      else r.set(+rx, +ry);
    }
  };

  // Tunables (exposed for live tweaking; values chosen for the wet neon night look)
  const params = {
    bloomStrength: 0.42,
    bloomRadius: 0.6,
    bloomThreshold: 0.9,
    bloomKnee: 0.6, // bloom composite soft ceiling (see above): knee and extra range above it
    bloomRange: 1.0,
    blurMax: 0.12, // radial blur span at the corners at top speed
    nitroBlur: 0.07,
    caBase: 0.0035,
    caSpeed: 0.006,
    caNitro: 0.01,
    vignette: 0.34,
    grain: 0.032,
    streak: high ? 0.32 : 0,
    exposure: null, // null = leave renderer.toneMappingExposure alone
  };

  function update(dt) {
    time += dt;
    // smooth inputs so per-frame physics noise doesn't flicker the image
    cur.speed = approach(cur.speed, clamp01(target.speed), 6, dt);
    cur.nitro = approach(cur.nitro, clamp01(target.nitro), target.nitro > cur.nitro ? 10 : 3, dt);
    cur.shake = approach(cur.shake, clamp01(target.shake), 12, dt);
    // impact: snap up, decay on our own (core may set it once or as a decaying value)
    cur.impact = Math.max(cur.impact * Math.exp(-5 * dt), clamp01(target.impact));
    target.impact *= Math.exp(-5 * dt); // a one-shot set({impact:1}) decays even if never reset
    // nitro activation punch
    if (target.nitro > 0.5 && cur.prevNitro <= 0.5) cur.nitroPulse = 1;
    cur.prevNitro = target.nitro;
    cur.nitroPulse *= Math.exp(-4.5 * dt);

    const s = cur.speed;
    const n = cur.nitro;
    const u = cinematic.uniforms;
    u.uTime.value = time;
    u.uFrame.value = frame = (frame + 1) % 4096;
    const sp = smooth(0.3, 1.05, s);
    u.uBlur.value = params.blurMax * sp * sp + params.nitroBlur * n + 0.04 * cur.nitroPulse;
    // the half-res pre-pass only runs while the blur is at least ~1.5 px at the frame corners
    const res = u.uResolution.value;
    const cornerPx = 0.5 * Math.hypot(res.x, res.y);
    prePass.enabled = params.blurMax + params.nitroBlur > 0 && u.uBlur.value * cornerPx > 1.5;
    prePass.uniforms.uBlur.value = u.uBlur.value;
    u.uCA.value = params.caBase + params.caSpeed * sp + params.caNitro * n + 0.012 * cur.impact + 0.004 * cur.shake;
    u.uWarp.value = 0.05 * n + 0.08 * cur.nitroPulse;
    u.uZoom.value = 0.012 * n + 0.03 * cur.nitroPulse;
    u.uVignette.value = params.vignette + 0.12 * sp + 0.1 * n + 0.15 * cur.impact;
    u.uGrain.value = params.grain;
    u.uImpact.value = cur.impact;
    u.uStreak.value = params.streak;
    bloomPass.strength = params.bloomStrength * (1 + 0.25 * n + 0.6 * cur.impact);
    bloomPass.radius = params.bloomRadius;
    bloomPass.threshold = params.bloomThreshold;
    cm.uniforms.bloomKnee.value = params.bloomKnee;
    cm.uniforms.bloomRange.value = params.bloomRange;
    if (params.exposure != null) renderer.toneMappingExposure = params.exposure;
  }

  const api = {
    composer,
    renderPass,
    bloomPass,
    streakPass,
    radialPrePass: prePass,
    cinematicPass: cinematic,
    aaPass,
    params,
    /** Scene-depth snapshot (soft particles); other modules may sample it — see src/fx/sceneDepth.js. */
    sceneDepth,
    render(dt) {
      const now = performance.now();
      if (dt === undefined || !Number.isFinite(dt)) dt = (now - lastNow) / 1000;
      lastNow = now;
      dt = Math.min(Math.max(dt, 0), 0.1);
      update(dt);
      composer.render(dt);
    },
    setSize(w, h) {
      if (w === undefined || h === undefined) {
        renderer.getSize(size);
        w = size.x;
        h = size.y;
      }
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    },
    setCamera(cam) {
      if (cam) renderPass.camera = cam;
    },
    // focus / focusRadius (optional): speed-blur protected region, see setFocus above. null = default.
    // e.g. hood/bumper cam: set({ focus: [0.5, -0.05], focusRadius: [1.2, 0.3] }) protects the bonnet,
    // focusRadius: 0 protects nothing.
    set({ speed, nitro, impact, shake, focus, focusRadius } = {}) {
      if (speed !== undefined) target.speed = +speed || 0;
      if (nitro !== undefined) target.nitro = +nitro || 0;
      if (impact !== undefined) target.impact = Math.max(target.impact, +impact || 0);
      if (shake !== undefined) target.shake = +shake || 0;
      if (focus !== undefined || focusRadius !== undefined) setFocus(focus, focusRadius);
    },
    dispose() {
      composer.passes.forEach((p) => p.dispose && p.dispose());
      composer.dispose();
      sceneDepth.dispose();
    },
  };
  return api;
}
