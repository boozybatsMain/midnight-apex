// MIDNIGHT APEX — downtown buildings.
//
// Layout: an occupancy raster (2 m cells) blocks the circuit corridor (≥ wallOffset + 6 m), side streets,
// the overpass corridor and the bay. Street frontage is filled first (contiguous buildings facing the
// circuit, storefronts at street level), then block interiors (towers), then an outer ring; a fog-free
// skyline ring far away sells the horizon.
//
// Rendering: every building in a chunk is merged into one BufferGeometry sharing ONE material. Facades
// use a 2D texture ARRAY (office / residential / glass / brick / storefront / roof) whose window cells are
// lit per-cell in the shader (hash of cell + building seed → on/off, colour temperature, brightness),
// with an analytic LOD that fades sub-pixel windows to their average (no sparkle at distance).
import * as THREE from 'three';
import { mulberry32 } from './textures.js';

const LAYER = { office: 0, residential: 1, glass: 2, brick: 3, store: 4, roof: 5, emissive: 6, plain: 7 };
const STYLE_CELL = {
  // [cell width (m), floor height (m)]
  0: [1.6, 3.8],
  1: [3.2, 3.0],
  2: [2.0, 3.6],
  3: [3.4, 3.8],
};
const STORE_H = 5.0;
const STORE_W = 7.0;
const TEX = 512; // per layer, 8×8 cells of 64 px
const CELLS = 8;

// ---------------------------------------------------------------------------------------------
// Facade texture array
// ---------------------------------------------------------------------------------------------

function drawFacadeLayer(kind, seed) {
  // Direct pixel rasterizer (canvas 2D would premultiply alpha and lose the wall RGB where alpha = 0).
  // Row 0 = bottom of the texture (v = 0).
  const buf = new Uint8Array(TEX * TEX * 4);
  const rnd = mulberry32(seed);
  const P = TEX / CELLS;
  const lin = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  // alpha encodes the surface: 255 = window glass (lit interior in rgb), 128 = sign band (emissive rgb),
  // 0 = wall (rgb = albedo detail, 0.5 = neutral).
  const rect = (cx, cy, x0, y0, x1, y1, r, gg, b, a) => {
    const X0 = Math.round(cx * P + x0 * P), X1 = Math.max(X0 + 1, Math.round(cx * P + x1 * P));
    const Y0 = Math.round(cy * P + y0 * P), Y1 = Math.max(Y0 + 1, Math.round(cy * P + y1 * P));
    const R8 = lin(r), G8 = lin(gg), B8 = lin(b);
    for (let y = Math.max(0, Y0); y < Math.min(TEX, Y1); y++) {
      for (let x = Math.max(0, X0); x < Math.min(TEX, X1); x++) {
        const o = (y * TEX + x) * 4;
        buf[o] = R8; buf[o + 1] = G8; buf[o + 2] = B8; buf[o + 3] = a;
      }
    }
  };
  const vgrad = (cx, cy, x0, y0, x1, y1, top, bot, a = 255) => {
    const steps = 10;
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps, t1 = (i + 1) / steps;
      const t = (t0 + t1) / 2;
      const col = [0, 1, 2].map((k) => bot[k] + (top[k] - bot[k]) * t);
      rect(cx, cy, x0, y0 + (y1 - y0) * t0, x1, y0 + (y1 - y0) * t1, col[0], col[1], col[2], a);
    }
  };
  // base wall
  for (let i = 0; i < TEX * TEX; i++) { buf[i * 4] = buf[i * 4 + 1] = buf[i * 4 + 2] = 128; buf[i * 4 + 3] = 0; }
  for (let cy = 0; cy < CELLS; cy++) {
    for (let cx = 0; cx < CELLS; cx++) {
      const r = () => rnd();
      if (kind === LAYER.office) {
        rect(cx, cy, 0, 0, 1, 1, 0.42, 0.42, 0.44, 0); // panel
        rect(cx, cy, 0, 0, 1, 0.2, 0.28, 0.28, 0.3, 0); // spandrel
        const k = 0.75 + r() * 0.35;
        vgrad(cx, cy, 0.05, 0.2, 0.95, 0.98, [0.95 * k, 0.95 * k, 0.95 * k], [0.32 * k, 0.32 * k, 0.33 * k]);
        rect(cx, cy, 0.05, 0.9, 0.95, 0.95, 1, 1, 1, 255); // ceiling light panel
        if (r() < 0.55) rect(cx, cy, 0.05 + r() * 0.3, 0.2, 0.55 + r() * 0.4, 0.36 + r() * 0.08, 0.08, 0.08, 0.09, 255); // desks/partitions
        if (r() < 0.12) rect(cx, cy, 0.3 + r() * 0.4, 0.2, 0.4 + r() * 0.4, 0.62, 0.05, 0.05, 0.05, 255); // person
        if (r() < 0.3) { // blinds lowered to some height
          const yb = 0.35 + r() * 0.55;
          for (let y = yb; y < 0.98; y += 0.045) rect(cx, cy, 0.05, y, 0.95, Math.min(0.98, y + 0.025), 0.6 * k, 0.58 * k, 0.55 * k, 255);
        }
        rect(cx, cy, 0, 0.2, 0.05, 1, 0.2, 0.2, 0.22, 0); // mullion
        rect(cx, cy, 0.95, 0.2, 1, 1, 0.2, 0.2, 0.22, 0);
      } else if (kind === LAYER.residential) {
        const tone = 0.42 + r() * 0.12;
        rect(cx, cy, 0, 0, 1, 1, tone, tone, tone, 0);
        rect(cx, cy, 0, 0.0, 1, 0.04, tone * 0.7, tone * 0.7, tone * 0.7, 0); // slab joint
        const x0 = 0.24, x1 = 0.76, y0 = 0.3, y1 = 0.86;
        rect(cx, cy, x0 - 0.03, y0 - 0.04, x1 + 0.03, y1 + 0.03, 0.25, 0.25, 0.25, 0); // frame/reveal
        const k = 0.7 + r() * 0.4;
        vgrad(cx, cy, x0, y0, x1, y1, [0.9 * k, 0.78 * k, 0.6 * k], [0.45 * k, 0.36 * k, 0.26 * k]);
        // a table lamp glow
        if (r() < 0.5) { const lx = x0 + 0.08 + r() * 0.35; rect(cx, cy, lx, y0 + 0.08, lx + 0.1, y0 + 0.24, 1, 0.85, 0.6, 255); }
        const cur = r();
        if (cur < 0.45) { // side curtains
          const w = 0.1 + r() * 0.08;
          rect(cx, cy, x0, y0, x0 + w, y1, 0.22 * k, 0.15 * k, 0.1 * k, 255);
          rect(cx, cy, x1 - w, y0, x1, y1, 0.22 * k, 0.15 * k, 0.1 * k, 255);
        } else if (cur < 0.65) { // sheer curtain with folds
          for (let x = x0; x < x1; x += 0.04) rect(cx, cy, x, y0, x + 0.02, y1, 0.75 * k, 0.65 * k, 0.5 * k, 255);
        } else if (cur < 0.8) { // blinds
          for (let y = y0; y < y1; y += 0.05) rect(cx, cy, x0, y, x1, y + 0.025, 0.55 * k, 0.5 * k, 0.42 * k, 255);
        }
        if (r() < 0.3) { // balcony railing (wall)
          rect(cx, cy, 0.08, 0.04, 0.92, 0.07, 0.2, 0.2, 0.2, 0);
          rect(cx, cy, 0.08, 0.26, 0.92, 0.29, 0.25, 0.25, 0.25, 0);
          for (let x = 0.1; x < 0.92; x += 0.06) rect(cx, cy, x, 0.07, x + 0.015, 0.26, 0.22, 0.22, 0.22, 0);
        }
        // AC unit under some windows
        if (r() < 0.2) rect(cx, cy, 0.62, 0.08, 0.84, 0.22, 0.62, 0.62, 0.6, 0);
      } else if (kind === LAYER.glass) {
        rect(cx, cy, 0, 0, 1, 0.12, 0.3, 0.32, 0.36, 0);
        const k = 0.65 + r() * 0.5;
        const cool = r() < 0.5;
        const top = cool ? [0.85 * k, 0.92 * k, 1 * k] : [1 * k, 0.9 * k, 0.75 * k];
        vgrad(cx, cy, 0.02, 0.12, 0.98, 0.99, top, [top[0] * 0.3, top[1] * 0.3, top[2] * 0.3]);
        for (let x = 0.15; x < 0.95; x += 0.28) rect(cx, cy, x, 0.94, x + 0.12, 0.97, 1, 1, 1, 255);
        if (r() < 0.35) rect(cx, cy, 0.02, 0.12, 0.98, 0.3 + r() * 0.5, 0.12, 0.12, 0.13, 255); // dim lower part
        if (r() < 0.25) for (let y = 0.5; y < 0.99; y += 0.05) rect(cx, cy, 0.02, y, 0.98, y + 0.028, 0.5 * k, 0.5 * k, 0.5 * k, 255);
        rect(cx, cy, 0.0, 0.12, 0.02, 1, 0.25, 0.26, 0.28, 0);
        rect(cx, cy, 0.98, 0.12, 1, 1, 0.25, 0.26, 0.28, 0);
      } else if (kind === LAYER.brick) {
        // brick courses
        for (let y = 0; y < 1; y += 0.06) {
          const off = (Math.round(y / 0.06) % 2) * 0.09;
          for (let x = -0.18 + off; x < 1; x += 0.18) {
            const t = 0.38 + r() * 0.2;
            rect(cx, cy, Math.max(0, x + 0.008), y + 0.008, Math.min(1, x + 0.172), y + 0.052, t, t, t, 0);
          }
        }
        const x0 = 0.28, x1 = 0.72, y0 = 0.2, y1 = 0.84;
        rect(cx, cy, x0 - 0.05, y1, x1 + 0.05, y1 + 0.07, 0.7, 0.7, 0.68, 0); // lintel
        rect(cx, cy, x0 - 0.04, y0 - 0.05, x1 + 0.04, y0, 0.65, 0.65, 0.62, 0); // sill
        const k = 0.65 + r() * 0.4;
        vgrad(cx, cy, x0, y0, x1, y1, [1 * k, 0.8 * k, 0.55 * k], [0.4 * k, 0.28 * k, 0.18 * k]);
        if (r() < 0.5) { rect(cx, cy, x0, y0, x0 + 0.1, y1, 0.3 * k, 0.12 * k, 0.08 * k, 255); rect(cx, cy, x1 - 0.1, y0, x1, y1, 0.3 * k, 0.12 * k, 0.08 * k, 255); }
      } else if (kind === LAYER.store) {
        rect(cx, cy, 0, 0, 1, 1, 0.35, 0.35, 0.36, 0);
        const shut = r() < 0.2;
        if (shut) {
          for (let y = 0.05; y < 0.7; y += 0.025) rect(cx, cy, 0.04, y, 0.96, y + 0.015, 0.55, 0.55, 0.56, 0);
          if (r() < 0.6) { // graffiti tag
            const h = r();
            const col = [[0.9, 0.2, 0.6], [0.2, 0.8, 0.9], [0.95, 0.75, 0.1]][Math.floor(h * 3)];
            for (let i = 0; i < 6; i++) rect(cx, cy, 0.15 + r() * 0.6, 0.2 + r() * 0.35, 0.25 + r() * 0.6, 0.25 + r() * 0.35, col[0] * 0.5, col[1] * 0.5, col[2] * 0.5, 0);
          }
        } else {
          const type = r();
          const hue = r();
          const base = hue < 0.5 ? [1, 0.74, 0.46] : hue < 0.78 ? [0.78, 0.9, 1] : hue < 0.9 ? [1, 0.5, 0.8] : [0.55, 1, 0.75];
          const k = 0.22 + r() * 0.26;
          if (type < 0.3) {
            // convenience store / pharmacy: bright ceiling, shelves of products
            vgrad(cx, cy, 0.04, 0.05, 0.96, 0.7, base.map((v) => v * k * 1.3), base.map((v) => v * k * 0.45));
            rect(cx, cy, 0.04, 0.64, 0.96, 0.68, base[0] * 0.9, base[1] * 0.9, base[2] * 0.9, 255);
            for (let y = 0.15; y < 0.6; y += 0.11) {
              rect(cx, cy, 0.08, y, 0.6, y + 0.015, 0.1, 0.1, 0.1, 255);
              for (let x = 0.09; x < 0.58; x += 0.035) {
                const pc = [r(), r(), r()];
                rect(cx, cy, x, y + 0.017, x + 0.025, y + 0.06 + r() * 0.03, pc[0] * k * 1.4, pc[1] * k * 1.4, pc[2] * k * 1.4, 255);
              }
            }
          } else if (type < 0.62) {
            // bar / restaurant: warm, dim, pendant lamps, table & people silhouettes
            const w = [1, 0.62, 0.3];
            vgrad(cx, cy, 0.04, 0.05, 0.96, 0.7, w.map((v) => v * k * 0.9), w.map((v) => v * k * 0.25));
            for (let x = 0.1; x < 0.9; x += 0.13 + r() * 0.05) {
              rect(cx, cy, x, 0.52, x + 0.004, 0.7, 0.1, 0.08, 0.06, 255);
              rect(cx, cy, x - 0.025, 0.47, x + 0.03, 0.53, 1, 0.75, 0.4, 255); // pendant lamp
              if (r() < 0.6) rect(cx, cy, x - 0.02, 0.05, x + 0.035, 0.28 + r() * 0.1, 0.03, 0.02, 0.02, 255); // person
            }
            rect(cx, cy, 0.04, 0.05, 0.96, 0.17, 0.06, 0.035, 0.02, 255); // bar counter
          } else if (type < 0.8) {
            // boutique: dark interior, spot-lit mannequins
            vgrad(cx, cy, 0.04, 0.05, 0.96, 0.7, base.map((v) => v * k * 0.5), base.map((v) => v * k * 0.15));
            for (let x = 0.15; x < 0.85; x += 0.22) {
              rect(cx, cy, x - 0.06, 0.05, x + 0.09, 0.62, 0.9 * k * 2, 0.85 * k * 2, 0.8 * k * 2, 255); // light cone
              rect(cx, cy, x, 0.08, x + 0.035, 0.5, 0.05, 0.05, 0.06, 255); // mannequin
              rect(cx, cy, x - 0.01, 0.38, x + 0.045, 0.46, 0.6 * r(), 0.3 * r(), 0.5 * r(), 255);
            }
          } else {
            // lobby / closed office: very dim with a lit reception desk
            vgrad(cx, cy, 0.04, 0.05, 0.96, 0.7, [0.09, 0.09, 0.1], [0.03, 0.03, 0.035]);
            rect(cx, cy, 0.35, 0.05, 0.65, 0.2, 0.5, 0.42, 0.3, 255);
          }
          rect(cx, cy, 0.78, 0.05, 0.94, 0.62, base[0] * k * 0.6, base[1] * k * 0.6, base[2] * k * 0.6, 255); // door
          if (r() < 0.35) { // poster / menu board
            const pc = [r(), r(), r()];
            rect(cx, cy, 0.45, 0.32, 0.58, 0.58, pc[0] * 0.8, pc[1] * 0.8, pc[2] * 0.8, 255);
          }
          if (r() < 0.4) { // awning (wall colour band)
            const ac = [[0.35, 0.05, 0.05], [0.05, 0.2, 0.12], [0.1, 0.1, 0.12], [0.3, 0.2, 0.05]][Math.floor(r() * 4)];
            rect(cx, cy, 0.02, 0.69, 0.98, 0.74, ac[0], ac[1], ac[2], 0);
          }
        }
        // sign band (emissive), lightbox with "lettering"
        const sh = r();
        const sc = [[1, 0.15, 0.6], [0.1, 0.85, 1], [1, 0.62, 0.1], [0.65, 0.25, 1], [1, 0.95, 0.85], [0.2, 1, 0.45], [1, 0.25, 0.2]][Math.floor(sh * 7)];
        const dark = r() < 0.5;
        rect(cx, cy, 0.05, 0.75, 0.95, 0.94, dark ? 0.02 : sc[0] * 0.45, dark ? 0.02 : sc[1] * 0.45, dark ? 0.02 : sc[2] * 0.45, 255);
        let x = 0.12 + r() * 0.1;
        const letters = 4 + Math.floor(r() * 6);
        for (let i = 0; i < letters && x < 0.86; i++) {
          const w = 0.04 + r() * 0.04;
          rect(cx, cy, x, 0.79, x + w, 0.9, dark ? sc[0] : 1, dark ? sc[1] : 1, dark ? sc[2] : 1, 255);
          x += w + 0.025;
        }
        rect(cx, cy, 0, 0, 1, 0.05, 0.25, 0.25, 0.25, 0);
      } else if (kind === LAYER.roof) {
        for (let i = 0; i < 40; i++) {
          const t = 0.35 + r() * 0.25;
          const x = r(), y = r();
          rect(cx, cy, x, y, Math.min(1, x + 0.05 + r() * 0.3), Math.min(1, y + 0.05 + r() * 0.3), t, t, t, 0);
        }
        rect(cx, cy, 0, 0, 1, 0.01, 0.25, 0.25, 0.25, 0);
        rect(cx, cy, 0, 0, 0.01, 1, 0.25, 0.25, 0.25, 0);
      }
    }
  }
  return buf;
}

function createFacadeArray() {
  const layers = 6;
  const data = new Uint8Array(TEX * TEX * 4 * layers);
  for (let l = 0; l < layers; l++) {
    data.set(drawFacadeLayer(l, 1000 + l * 77), l * TEX * TEX * 4);
  }
  const tex = new THREE.DataArrayTexture(data, TEX, TEX, layers);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------------------------
// Building material
// ---------------------------------------------------------------------------------------------
//
// Facade shading is resolution-independent where it matters and filtered where it doesn't:
//   NEAR (cells ≥ ~6 px): every window is analytic — the opening, a recessed glass plane (the view ray is
//     walked into the reveal, so at street-level grazing angles you see the jambs / sill / soffit), frames
//     and mullions on the glass plane, and behind the glass an INTERIOR-MAPPED room (ray vs. room box:
//     floor, ceiling with a light panel, side walls, and the drawn window content on the back wall).
//     Glass Fresnel hands the grazing views over to the env reflection.
//   MID: the window rect is box-filtered over the pixel footprint (exact coverage, also across cell
//     boundaries), so small windows stay crisp dots separated by darker spandrels instead of a mip-blurred
//     mosaic of blocks.
//   FAR (cells < ~3 px): the expected emission with soft floor-band variation (value noise, no blocks).
// Lower floors get a STREET-LIGHT WASH: a top-down irradiance map baked from the actual streetlights
// (colour × intensity / distance², luminaire cutoff) and faded with height, so facades facing the road are
// lit warm (sodium) or cool (LED) exactly where the lamps are.

// window opening in cell units (x0, y0, x1, y1) per facade layer — must match drawFacadeLayer()
const WIN_RECT = [
  [0.05, 0.2, 0.95, 0.98],
  [0.24, 0.3, 0.76, 0.86],
  [0.02, 0.12, 0.98, 0.99],
  [0.28, 0.2, 0.72, 0.84],
  [0.04, 0.05, 0.96, 0.7],
];
const glslVec4 = (a) => `vec4(${a.map((v) => v.toFixed(3)).join(', ')})`;

// The only spot lights in the scene are the player's low beams. Their cut-off sits ~0.6° below the horizon and
// the barriers would block them before the facades (spots cast no shadows), so buildings get nothing visible from
// them, yet every lit program pays for the spot loop plus the light-cookie varyings and texture fetches
// (SpotLight.map). The facade shaders are compiled without spot lights: the chunks that reference them are
// inlined with the spot counts forced to 0. (three substitutes light counts textually, so #undef won't work.)
const SPOT_CHUNKS = new Set([
  'worldpos_vertex', 'shadowmap_pars_vertex', 'shadowmap_vertex', 'lights_pars_begin',
  'shadowmap_pars_fragment', 'shadowmask_pars_fragment', 'lights_fragment_begin',
]);
export function stripSpotLights(src) {
  return src.replace(/#include <(\w+)>/g, (m, name) => (SPOT_CHUNKS.has(name) && THREE.ShaderChunk[name]
    ? THREE.ShaderChunk[name].replace(/NUM_SPOT_LIGHT_COORDS|NUM_SPOT_LIGHT_MAPS|NUM_SPOT_LIGHTS/g, '0')
    : m));
}
const cellM = (l) => (l === LAYER.store ? [STORE_W, STORE_H] : STYLE_CELL[l]);

export function createBuildingMaterial(facadeTex, { far = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0, fog: !far, envMapIntensity: 0.55 });
  const uniforms = {
    uFacade: { value: facadeTex },
    uTime: { value: 0 },
    uWinBright: { value: far ? 0.9 : 1.0 },
    uHaze: { value: new THREE.Color(0.05, 0.03, 0.06) },
    uStreetLight: { value: blackTexture() },
    uSLBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
    uSLOn: { value: 0 },
    uLite: { value: 0 }, // 1 while rendering the (half-res, blurred) planar reflection: skip the near detail
    uSLGain: { value: 0.45 }, // ≈ NdotL / π with a little artistic lift (matches the road pools)
  };
  mat.userData.uniforms = uniforms;
  mat.userData.noSpots = true; // see stripSpotLights
  mat.customProgramCacheKey = () => 'mapex-bldg-v3-' + (far ? 'far' : 'near') + (mat.userData.noSpots ? '-nospot' : '');
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 aFUv;
attribute vec4 aB;
attribute vec3 aWall;
varying vec2 vFUv;
varying vec4 vB;
varying vec3 vWall;
varying vec3 vWPosC;
varying vec3 vWN;`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
vFUv = aFUv; vB = aB; vWall = aWall;
vWPosC = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWN = mat3(modelMatrix) * objectNormal;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
precision highp sampler2DArray;
uniform sampler2DArray uFacade;
uniform float uTime;
uniform float uWinBright;
uniform vec3 uHaze;
uniform sampler2D uStreetLight;
uniform vec4 uSLBounds;
uniform float uSLOn;
uniform float uSLGain;
uniform float uLite;
varying vec2 vFUv;
varying vec4 vB;
varying vec3 vWall;
varying vec3 vWPosC;
varying vec3 vWN;
float cHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float cNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cHash(i), cHash(i + vec2(1.0, 0.0)), f.x), mix(cHash(i + vec2(0.0, 1.0)), cHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// ∫ of a periodic pulse (1 on [a,b) of every unit cell) from 0 to x, and its box-filtered average over width w
float bPulseI(float x, float a, float b) { return floor(x) * (b - a) + clamp(fract(x), a, b) - a; }
float bPulse(float x, float a, float b, float w) { w = max(w, 1e-4); return (bPulseI(x + 0.5 * w, a, b) - bPulseI(x - 0.5 * w, a, b)) / w; }
// soft (≈1 px) inside test for a rect
float bInRect(vec2 p, vec4 r, vec2 aa) {
  vec2 a = smoothstep(r.xy - aa, r.xy + aa, p) * (1.0 - smoothstep(r.zw - aa, r.zw + aa, p));
  return a.x * a.y;
}
vec4 bWinRect(float L) {
  return L < 0.5 ? ${glslVec4(WIN_RECT[0])} : L < 1.5 ? ${glslVec4(WIN_RECT[1])} : L < 2.5 ? ${glslVec4(WIN_RECT[2])} : L < 3.5 ? ${glslVec4(WIN_RECT[3])} : ${glslVec4(WIN_RECT[4])};
}
vec2 bCellM(float L) {
  return L < 0.5 ? vec2(${cellM(0).join(', ')}) : L < 1.5 ? vec2(${cellM(1).join(', ')}) : L < 2.5 ? vec2(${cellM(2).join(', ')}) : L < 3.5 ? vec2(${cellM(3).join(', ')}) : vec2(${cellM(4).join(', ')});
}
// rooms behind the windows are this many window bays wide (open-plan offices / shop floors span several)
float bRoomBays(float L) { return L < 0.5 ? 5.0 : L < 1.5 ? 1.0 : L < 2.5 ? 4.0 : L < 3.5 ? 1.0 : 3.0; }
// x = reveal depth (m), y = room depth (m), z = frame width (m), w = transom height (fraction of the opening, 0 = none)
vec4 bWinParams(float L) {
  return L < 0.5 ? vec4(0.09, 5.5, 0.035, 0.2) : L < 1.5 ? vec4(0.2, 3.8, 0.05, 0.72) : L < 2.5 ? vec4(0.05, 6.5, 0.025, 0.0) : L < 3.5 ? vec4(0.24, 4.0, 0.06, 0.61) : vec4(0.12, 5.0, 0.05, 0.0);
}
`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float layer = vB.x;
vec3 emis = vec3(0.0);
float bRough = 0.8;
float bMetal = 0.0;
vec3 alb = vWall;
vec3 Nw = normalize(vWN);
if (layer > 6.5) {
  // plain (rooftop machinery, masts)
  alb = vWall;
  bRough = 0.6;
} else if (layer > 5.5) {
  // emissive band (crown / edge lights): vWall holds the HDR colour
  alb = vec3(0.02);
  emis = vWall;
} else if (layer > 4.5) {
  // roofs
  alb = vWall * texture(uFacade, vec3(vFUv / 8.0, layer)).rgb * 2.0;
  bRough = 0.75;
} else {
  vec2 fuv = vFUv;
  vec2 cell = floor(fuv);
  vec2 fc = fuv - cell;
  vec4 tx = texture(uFacade, vec3(fuv / 8.0, layer));
  vec2 dfx = dFdx(fuv), dfy = dFdy(fuv);
  vec2 fw = abs(dfx) + abs(dfy);
  float fwm = max(fw.x, fw.y);
  bool store = layer > 3.5;
  vec4 wr = bWinRect(layer);
  float seed = vB.y;
  float h1 = cHash(cell + seed * 31.7);
  float h2 = cHash(cell.yx * 1.37 + seed * 7.3);
  float floorOn = cHash(vec2(cell.y * 3.1, seed * 13.0));
  float lit = vB.z;
  float on = store ? step(h1, 0.82) : step(mix(h1, floorOn, 0.45), lit);
  vec3 tint = h2 < 0.45 ? vec3(1.0, 0.72, 0.42) : h2 < 0.75 ? vec3(1.0, 0.9, 0.75) : h2 < 0.93 ? vec3(0.72, 0.85, 1.0) : (h1 < 0.5 ? vec3(0.45, 0.55, 1.0) : vec3(1.0, 0.45, 0.8));
  if (store) tint = vec3(1.0);
  float hb = fract(h1 * 13.37);
  float bright = (0.18 + 1.1 * hb * hb) * uWinBright;
  if (store) bright = (0.35 + 0.45 * hb) * uWinBright;
  // TV flicker in a few residential windows
  if (h2 > 0.93 && h1 < 0.5) bright *= 0.7 + 0.3 * sin(uTime * 7.0 + h1 * 50.0) * sin(uTime * 3.1 + h2 * 20.0);
  vec3 roomL = tint * bright * on;
  // this cell's window: average of the drawn content, and whether there is glass at all (shuttered shops)
  vec4 cAvg = textureLod(uFacade, vec3((cell + (wr.xy + wr.zw) * 0.5) / 8.0, layer), 3.0);
  float hasGlass = smoothstep(0.45, 0.8, cAvg.a);
  // storefront cells are exactly one shop tall: the top band is the illuminated sign
  float signB = store ? smoothstep(0.55, 0.95, tx.a) * smoothstep(0.735, 0.745, fc.y) : 0.0;
  vec3 signE = tx.rgb * signB * uWinBright * (1.2 + 1.6 * h2) * step(0.25, h1);
  vec3 wallAlb = vWall * tx.rgb * 2.0;
  const vec3 GLASS = vec3(0.012, 0.014, 0.018);

  // ---- MID: box-filtered window coverage, per-cell light ----
  float cov = bPulse(fuv.x, wr.x, wr.z, fw.x) * bPulse(fuv.y, wr.y, wr.w, fw.y) * hasGlass;
  vec3 midE = cAvg.rgb * roomL * cov * 1.15;
  vec3 midAlb = mix(wallAlb, GLASS, cov);
  float midR = mix(0.62, 0.07, cov);
  float midM = 0.0;

  // ---- NEAR: analytic opening + reveal + frames + interior-mapped room ----
  float nearW = (1.0 - smoothstep(0.07, 0.17, fwm)) * (1.0 - uLite);
  float ilod = log2(max(max(length(dfx), length(dfy)) * 77.0, 1.0));  // interior content mip (isotropic: seen through glass)
  if (nearW > 0.0) {
    vec2 cm = bCellM(layer);
    vec4 wp = bWinParams(layer);
    vec3 Tw = normalize(cross(vec3(0.0, 1.0, 0.0), Nw));           // u grows to the viewer's right
    vec3 Vw = normalize(cameraPosition - vWPosC);
    vec3 vt = vec3(dot(Vw, Tw), Vw.y, max(dot(Vw, Nw), 0.03));     // view vector in facade space
    vec2 P = fc * cm;                                               // metres inside the cell
    vec2 pxm = max(fw * cm, vec2(1e-4));                            // one pixel in metres
    vec4 W = wr * cm.xyxy;
    float inO = bInRect(P, W, pxm) * hasGlass;
    vec3 oAlb = midAlb; vec3 oE = vec3(0.0); float oR = 0.62; float oM = 0.0;
    if (inO > 0.0) {
      // walk the view ray into the reveal down to the recessed glass plane
      vec2 Pg = P - vt.xy / vt.z * wp.x;
      float inG = bInRect(Pg, W, pxm);
      // frame around the glass + transom / mullions
      vec2 dE = min(Pg - W.xy, W.zw - Pg);
      float fr = wp.z;
      float frameM = 1.0 - smoothstep(fr - pxm.x, fr + pxm.x, min(dE.x, dE.y));
      float mw = fr * 0.55;
      if (wp.w > 0.0) frameM = max(frameM, 1.0 - smoothstep(mw - pxm.y, mw + pxm.y, abs(Pg.y - mix(W.y, W.w, wp.w))));
      if (layer > 0.5 && layer < 1.5 || layer > 2.5 && layer < 3.5)
        frameM = max(frameM, 1.0 - smoothstep(mw - pxm.x, mw + pxm.x, abs(Pg.x - (W.x + W.z) * 0.5)));
      if (store) {
        frameM = max(frameM, 1.0 - smoothstep(mw - pxm.x, mw + pxm.x, abs(Pg.x - 0.404 * cm.x)));
        frameM = max(frameM, 1.0 - smoothstep(mw - pxm.x, mw + pxm.x, abs(Pg.x - 0.78 * cm.x)));
        frameM = max(frameM, (1.0 - smoothstep(mw - pxm.y, mw + pxm.y, abs(Pg.y - 0.62 * cm.y))) * step(0.78 * cm.x, Pg.x));
      }
      // interior: ray vs. the room box behind the glass (side walls at the cell edges, floor / ceiling at
      // the slab lines, back wall at the room depth)
      vec3 d = vec3(-vt.x, -vt.y, vt.z);
      float bays = bRoomBays(layer);
      float bay = mod(cell.x, bays);                     // which bay of its room this window is
      vec2 Pr = Pg + vec2(bay * cm.x, 0.0);              // position in room space
      vec2 rs = vec2(bays * cm.x, cm.y);                 // room size (width, floor height)
      vec2 sg = step(0.0, d.xy);
      vec2 dd = (sg * 2.0 - 1.0) * max(abs(d.xy), vec2(1e-4));
      vec2 tXY = (sg * rs - Pr) / dd;
      float tZ = wp.y / d.z;
      float t = min(min(tXY.x, tXY.y), tZ);
      vec3 H = vec3(Pr + d.xy * t, d.z * t);
      float depthN = clamp(H.z / wp.y, 0.0, 1.0);
      // which surface the ray hits — selected without divergent branches, one texture fetch for both walls
      float isBack = step(tZ, min(tXY.x, tXY.y));
      float isSide = (1.0 - isBack) * step(tXY.x, tXY.y);
      float isCeil = (1.0 - isBack) * (1.0 - isSide) * step(0.0, d.y);
      float isFloor = (1.0 - isBack) * (1.0 - isSide) * (1.0 - isCeil);
      // back wall: the drawn window content (curtains, desks, shelves, people) stretched over the wall;
      // side walls: the same kind of content seen along the room depth, dimmer toward the window
      vec2 bb = clamp(H.xy / cm, vec2(0.0), vec2(bays - 0.001, 0.999));
      vec2 cuvB = vec2(cell.x - bay + floor(bb.x), cell.y) + mix(wr.xy, wr.zw, fract(bb));
      vec2 cuvS = cell + vec2(3.0 + sg.x, 0.0) + mix(wr.xy, wr.zw, vec2(depthN, clamp(H.y / cm.y, 0.0, 1.0)));
      vec3 wallTex = textureLod(uFacade, vec3(mix(cuvS, cuvB, isBack) / 8.0, layer), ilod).rgb;
      // ceiling with a light fitting halfway into each bay; dim floor
      vec2 q = vec2((fract(H.x / cm.x) - 0.5) * 2.4, (depthN - 0.5) * 3.0);
      vec3 ceilC = vec3(0.24) + vec3(1.15) * exp(-dot(q, q) * 2.6);
      vec3 floorC = vec3(0.16, 0.13, 0.11) * (0.6 + 0.8 * depthN) * (0.7 + 0.6 * h1);
      vec3 room = wallTex * (isBack * 0.95 + isSide * (0.3 + 0.35 * depthN)) + ceilC * isCeil + floorC * isFloor;
      room *= 1.0 - 0.25 * depthN;
      float fresG = 0.04 + 0.96 * pow(1.0 - vt.z, 5.0);
      vec3 inside = room * roomL * (1.0 - fresG) * 1.1;
      vec3 frameC = vWall * 0.35 + vec3(0.02);
      // compose the opening: reveal (where the ray hits the jamb first) → glass / frame
      vec3 revealAlb = wallAlb * 0.6;
      oAlb = mix(revealAlb, mix(GLASS, frameC, frameM), inG);
      oE = inside * (1.0 - frameM) * inG;
      oR = mix(0.7, mix(0.05, 0.38, frameM), inG);
      oM = frameM * 0.55 * inG;
    }
    vec3 nAlb = mix(wallAlb, oAlb, inO);
    vec3 nE = oE * inO;
    float nR = mix(0.62, oR, inO);
    float nM = oM * inO;
    midAlb = mix(midAlb, nAlb, nearW);
    midE = mix(midE, nE, nearW);
    midR = mix(midR, nR, nearW);
    midM = mix(midM, nM, nearW);
  }

  // ---- FAR: expected emission with soft floor-band variation (sub-pixel windows never sparkle) ----
  float lod = smoothstep(0.3, 0.75, fwm);
  float duty = (wr.z - wr.x) * (wr.w - wr.y);
  emis = midE + signE;
  if (lod > 0.0) {
    vec3 avgE = vec3(0.3, 0.24, 0.18) * uWinBright * (store ? 0.9 * 0.8 : lit * 0.33) * duty * 1.6;
    // per-floor bands that vary smoothly along the facade (whole office floors lit / dark), moderate contrast
    float zone = cNoise(vec2(fuv.x / 3.5, fuv.y) + seed * 3.7) * 0.7 + cNoise(fuv / vec2(9.0, 4.0) + seed * 1.3) * 0.3;
    avgE *= 0.45 + 1.1 * smoothstep(0.8 - lit - 0.2, 0.8 - lit + 0.2, zone);
    emis = mix(emis, avgE, lod);
  }
  alb = mix(midAlb, mix(vWall * 0.9, GLASS, duty * 0.6), lod);
  alb = mix(alb, GLASS, signB);
  bRough = mix(midR, mix(0.62, 0.3, duty), lod);
  bMetal = midM * (1.0 - lod);
  // accent: LED strips along the floor slabs of some modern towers (vB.w = palette index + 1)
  if (vB.w > 0.5 && (layer < 0.5 || (layer > 1.5 && layer < 2.5))) {
    float slab = fract(fuv.y);
    float band = (1.0 - smoothstep(0.0, 0.035, abs(slab - 0.02))) * step(0.5, fract(cell.y * 0.5 + 0.25 * seed));
    vec3 ac = vB.w < 1.5 ? vec3(0.1, 0.9, 1.6) : vB.w < 2.5 ? vec3(1.6, 0.2, 1.1) : vB.w < 3.5 ? vec3(1.5, 1.4, 1.3) : vec3(1.6, 0.7, 0.1);
    emis += ac * band * (1.0 - lod * 0.6) * 1.6;
  }
  #ifdef FAR_SKYLINE
  alb *= 0.25;
  #endif
}
// street-level light: a faint bounce from the lit street everywhere, plus the baked streetlight wash on
// facades near the lamps (warm sodium / cool LED pools that fade out above the luminaires)
float streetGlow = exp(-max(vWPosC.y, 0.0) / 6.0);
emis += alb * vec3(1.0, 0.72, 0.5) * streetGlow * 0.16;
if (uSLOn > 0.5 && layer < 6.5 && vWPosC.y < 9.5) {
  vec2 slUV = (vWPosC.xz + Nw.xz * 1.2 - uSLBounds.xy) * uSLBounds.zw;
  vec3 sl = texture(uStreetLight, slUV).rgb;
  float prof = (1.0 - smoothstep(2.0, 9.5, vWPosC.y)) * (1.0 - abs(Nw.y));
  emis += alb * sl * sl * 6.0 * prof * uSLGain;
}
diffuseColor.rgb = alb;
`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = bRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = bMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = emis;');
    if (far) {
      sh.fragmentShader = '#define FAR_SKYLINE\n' + sh.fragmentShader;
      // distant skyline: own haze instead of scene fog (FogExp2 would erase it completely)
      sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
{
  float dist = length(vWPosC - cameraPosition);
  float hz = clamp(0.35 + dist / 7000.0, 0.0, 0.8);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, hz * (1.0 - smoothstep(60.0, 260.0, vWPosC.y) * 0.25));
}`);
    }
    if (mat.userData.noSpots) {
      sh.vertexShader = stripSpotLights(sh.vertexShader);
      sh.fragmentShader = stripSpotLights(sh.fragmentShader);
    }
  };
  return mat;
}

let _black = null;
function blackTexture() {
  if (!_black) {
    _black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    _black.needsUpdate = true;
  }
  return _black;
}

// ---------------------------------------------------------------------------------------------
// Street-light wash map (top-down, baked once from the real lamp list)
// ---------------------------------------------------------------------------------------------

/**
 * posts: [{ head: Vector3 (luminaire position), color: THREE.Color, intensity }]
 * Returns { texture, bounds: Vector4(x0, z0, 1/width, 1/depth) }. rgb = sqrt(E / 6) where E is the
 * irradiance (colour × intensity × cutoff / (d² + 4)) at y = 2.5 m — the same falloff as the road pools.
 */
export function createStreetLightMap(posts, { x0 = -1150, z0 = -950, x1 = 1250, z1 = 900, cell = 3 } = {}) {
  const W = Math.ceil((x1 - x0) / cell), H = Math.ceil((z1 - z0) / cell);
  const acc = new Float32Array(W * H * 3);
  const Y = 2.5, R = 36;
  for (const p of posts) {
    if (!p || !p.head) continue;
    const I = p.intensity || 150;
    const c = p.color;
    const dy = p.head.y - Y;
    const gx0 = Math.max(0, Math.floor((p.head.x - R - x0) / cell)), gx1 = Math.min(W - 1, Math.ceil((p.head.x + R - x0) / cell));
    const gz0 = Math.max(0, Math.floor((p.head.z - R - z0) / cell)), gz1 = Math.min(H - 1, Math.ceil((p.head.z + R - z0) / cell));
    for (let gz = gz0; gz <= gz1; gz++) {
      const z = z0 + (gz + 0.5) * cell;
      for (let gx = gx0; gx <= gx1; gx++) {
        const x = x0 + (gx + 0.5) * cell;
        const dx = x - p.head.x, dz = z - p.head.z;
        const h2 = dx * dx + dz * dz;
        if (h2 > R * R) continue;
        const d2 = h2 + dy * dy;
        const cosD = dy / Math.sqrt(d2);
        const t = Math.min(1, Math.max(0, (cosD - 0.12) / (0.55 - 0.12)));
        const cut = t * t * (3 - 2 * t) * (1 - h2 / (R * R)); // luminaire cutoff, fade at the splat radius
        const e = (I * cut) / (d2 + 4);
        const k = (gz * W + gx) * 3;
        acc[k] += c.r * e; acc[k + 1] += c.g * e; acc[k + 2] += c.b * e;
      }
    }
  }
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    for (let k = 0; k < 3; k++) data[i * 4 + k] = Math.round(Math.sqrt(Math.min(1, acc[i * 3 + k] / 6)) * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return { texture: tex, bounds: new THREE.Vector4(x0, z0, 1 / (W * cell), 1 / (H * cell)) };
}

// ---------------------------------------------------------------------------------------------
// Geometry accumulation
// ---------------------------------------------------------------------------------------------

class GeoAcc {
  constructor() { this.p = []; this.n = []; this.uv = []; this.b = []; this.w = []; this.i = []; this.v = 0; }
  quad(a, b, c, d, n, uvs, attrB, wall) {
    // a,b,c,d counter-clockwise seen from the normal side
    const base = this.v;
    for (const [k, q] of [a, b, c, d].entries()) {
      this.p.push(q[0], q[1], q[2]);
      this.n.push(n[0], n[1], n[2]);
      this.uv.push(uvs[k][0], uvs[k][1]);
      this.b.push(attrB[0], attrB[1], attrB[2], attrB[3]);
      this.w.push(wall[0], wall[1], wall[2]);
    }
    this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.v += 4;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('aFUv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aB', new THREE.Float32BufferAttribute(this.b, 4));
    g.setAttribute('aWall', new THREE.Float32BufferAttribute(this.w, 3));
    g.setIndex(this.v > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * Emit an oriented box (4 sides + top). Frame: center (cx, cz), unit axis A (local x), B = perpendicular.
 * opts: { style, seed, lit, wall, store (bool: storefront band on sides), uOff, vOff, storeRow, top: bool }
 */
function emitBox(acc, cx, cz, ax, az, hw, hd, y0, y1, o) {
  const bx = -az, bz = ax; // B axis
  const corner = (sa, sb, y) => [cx + ax * hw * sa + bx * hd * sb, y, cz + az * hw * sa + bz * hd * sb];
  // sides: [normal sign along A or B, corners (left, right) as seen from outside]
  // l → r runs to the viewer's right (u grows along cross(up, n)): the facade shader rebuilds its tangent
  // frame from the normal alone for the window reveals / interior mapping.
  const sides = [
    { n: [ax, 0, az], l: [1, 1], r: [1, -1], w: hd * 2 }, // +A
    { n: [-ax, 0, -az], l: [-1, -1], r: [-1, 1], w: hd * 2 }, // −A
    { n: [bx, 0, bz], l: [-1, 1], r: [1, 1], w: hw * 2 }, // +B
    { n: [-bx, 0, -bz], l: [1, -1], r: [-1, -1], w: hw * 2 }, // −B
  ];
  const [cw, fh] = STYLE_CELL[o.style] || [3, 3.5];
  let si = 0;
  for (const s of sides) {
    const L = (y) => corner(s.l[0], s.l[1], y), R = (y) => corner(s.r[0], s.r[1], y);
    const uo = o.uOff + si * 3.0;
    si++;
    let yStart = y0;
    if (o.store && y0 < 0.5 && y1 > STORE_H + 2) {
      const u1 = s.w / STORE_W;
      const row = o.storeRow + si;
      quad(acc, L(y0), R(y0), R(STORE_H), L(STORE_H), s.n, [[uo, row], [uo + u1, row], [uo + u1, row + 1], [uo, row + 1]], [LAYER.store, o.seed, 0.8, 0], o.storeWall);
      yStart = STORE_H;
    }
    const vb = o.store ? STORE_H : 0;
    const u1 = s.w / cw;
    const v0 = (yStart - vb) / fh + o.vOff, v1 = (y1 - vb) / fh + o.vOff;
    quad(acc, L(yStart), R(yStart), R(y1), L(y1), s.n, [[uo, v0], [uo + u1, v0], [uo + u1, v1], [uo, v1]], [o.layer ?? o.style, o.seed, o.lit, o.accent || 0], o.wall);
  }
  if (o.top !== false) {
    const a = corner(-1, -1, y1), b = corner(-1, 1, y1), c = corner(1, 1, y1), d = corner(1, -1, y1);
    const ru = (p) => [p[0] / 10, p[2] / 10];
    quad(acc, a, b, c, d, [0, 1, 0], [ru(a), ru(b), ru(c), ru(d)], [o.roofLayer ?? LAYER.roof, o.seed, 0, 0], o.roofWall || [0.09, 0.09, 0.095]);
  }
}

function quad(acc, a, b, c, d, n, uvs, attrB, wall) {
  // ensure CCW about n
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0) acc.quad(d, c, b, a, n, [uvs[3], uvs[2], uvs[1], uvs[0]], attrB, wall);
  else acc.quad(a, b, c, d, n, uvs, attrB, wall);
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

const PALETTE = {
  0: [[0.1, 0.11, 0.13], [0.14, 0.14, 0.15], [0.08, 0.09, 0.11]],
  1: [[0.26, 0.25, 0.23], [0.22, 0.22, 0.24], [0.3, 0.27, 0.2], [0.28, 0.17, 0.13], [0.3, 0.3, 0.31]],
  2: [[0.05, 0.07, 0.09], [0.06, 0.06, 0.08], [0.08, 0.1, 0.12]],
  3: [[0.33, 0.16, 0.11], [0.22, 0.13, 0.1], [0.3, 0.2, 0.15]],
};
const CROWN_COLORS = [[0.15, 1.6, 2.6], [2.6, 0.25, 1.8], [2.4, 2.3, 2.1], [2.7, 1.0, 0.2], [1.0, 0.4, 2.8]];

class Occupancy {
  constructor(x0, z0, x1, z1, cell) {
    this.x0 = x0; this.z0 = z0; this.cell = cell;
    this.W = Math.ceil((x1 - x0) / cell); this.H = Math.ceil((z1 - z0) / cell);
    this.occ = new Uint8Array(this.W * this.H);
    this.dist = new Float32Array(this.W * this.H).fill(1e9);
  }
  idx(x, z) {
    const gx = Math.floor((x - this.x0) / this.cell), gz = Math.floor((z - this.z0) / this.cell);
    if (gx < 0 || gz < 0 || gx >= this.W || gz >= this.H) return -1;
    return gz * this.W + gx;
  }
  stampDist(x, z, R) {
    const c = this.cell;
    const gx0 = Math.max(0, Math.floor((x - R - this.x0) / c)), gx1 = Math.min(this.W - 1, Math.floor((x + R - this.x0) / c));
    const gz0 = Math.max(0, Math.floor((z - R - this.z0) / c)), gz1 = Math.min(this.H - 1, Math.floor((z + R - this.z0) / c));
    for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) {
      const px = this.x0 + (gx + 0.5) * c, pz = this.z0 + (gz + 0.5) * c;
      const d = Math.hypot(px - x, pz - z);
      const k = gz * this.W + gx;
      if (d < this.dist[k]) this.dist[k] = d;
    }
  }
  /** Test an oriented rect; mark = true → occupy it. Returns false if any sample is blocked. */
  rect(cx, cz, ax, az, hw, hd, margin = 0, mark = false) {
    const bx = -az, bz = ax;
    const step = this.cell * 0.75;
    const W2 = hw + margin, D2 = hd + margin;
    for (let a = -W2; a <= W2 + 1e-6; a += Math.min(step, W2)) {
      for (let b = -D2; b <= D2 + 1e-6; b += Math.min(step, D2)) {
        const x = cx + ax * a + bx * b, z = cz + az * a + bz * b;
        const k = this.idx(x, z);
        if (mark) { if (k >= 0) this.occ[k] = 1; }
        else if (k < 0 || this.occ[k]) return false;
      }
    }
    return true;
  }
}

function layoutCity(track, quality) {
  const rnd = mulberry32(4242);
  const R = (a, b) => a + (b - a) * rnd();
  const { px, pz, N } = track.samples;
  const L = track.length;
  const feat = track.features;
  const X0 = -1150, X1 = 1250, Z0 = -950, Z1 = 900;
  const occ = new Occupancy(X0, Z0, X1, Z1, 2);
  // distance-to-centerline field (stamped)
  for (let i = 0; i < N; i += 2) occ.stampDist(px[i], pz[i], 40);
  const CLEAR = track.wallOffset + 6.2; // ≥ wallOffset + 6 m from the centerline
  for (let k = 0; k < occ.occ.length; k++) {
    const gx = k % occ.W, gz = Math.floor(k / occ.W);
    const x = X0 + (gx + 0.5) * 2, z = Z0 + (gz + 0.5) * 2;
    if (occ.dist[k] < CLEAR) occ.occ[k] = 1;
    else if (feat.isWater(x, z + feat.shoreOffset + 4)) occ.occ[k] = 1; // keep the waterfront promenade open
    else if (Math.abs(x - feat.overpass.x) < feat.overpass.width / 2 + 4) occ.occ[k] = 1;
  }
  // side streets
  for (const st of feat.sideStreets) {
    const dx = st.x1 - st.x0, dz = st.z1 - st.z0, len = Math.hypot(dx, dz);
    const ax = dx / len, az = dz / len;
    occ.rect((st.x0 + st.x1) / 2, (st.z0 + st.z1) / 2, ax, az, len / 2 + st.halfWidth, st.halfWidth, 0, true);
  }

  const buildings = [];
  const frontage = [];
  const zoneOf = (s) => {
    const apex = (ci) => track.corners.find((k) => k.index === ci).apex;
    if (s >= apex(1) && s < apex(4)) return 'east';
    if (s >= apex(4) && s < apex(10)) return 'water';
    if (s >= apex(10) && s < apex(0)) return 'alley';
    return 'downtown';
  };
  const pickStyle = (zone) => {
    const r = rnd();
    if (zone === 'downtown') return r < 0.35 ? 0 : r < 0.65 ? 2 : r < 0.85 ? 1 : 3;
    if (zone === 'alley') return r < 0.55 ? 1 : r < 0.85 ? 3 : 0;
    if (zone === 'water') return r < 0.45 ? 2 : r < 0.7 ? 1 : 0;
    return r < 0.4 ? 3 : r < 0.75 ? 1 : 0;
  };
  const heightFor = (zone, frontageB) => {
    const r = rnd();
    if (zone === 'downtown') return frontageB ? (r < 0.18 ? R(90, 170) : R(24, 75)) : r < 0.35 ? R(90, 185) : R(30, 90);
    if (zone === 'alley') return frontageB ? R(12, 34) : r < 0.2 ? R(50, 110) : R(18, 45);
    if (zone === 'water') return frontageB ? (r < 0.25 ? R(70, 140) : R(18, 50)) : r < 0.3 ? R(80, 160) : R(25, 70);
    return frontageB ? R(15, 45) : r < 0.25 ? R(60, 120) : R(20, 55);
  };

  const addBuilding = (cx, cz, ax, az, hw, hd, h, style, zone, front, extra = {}) => {
    const pal = PALETTE[style];
    const b = {
      cx, cz, ax, az, hw, hd, h, style, zone, front,
      seed: Math.floor(rnd() * 997) + 1,
      lit: style === 0 ? R(0.12, 0.55) : style === 2 ? R(0.15, 0.6) : R(0.15, 0.45),
      wall: pal[Math.floor(rnd() * pal.length)].map((v) => v * R(0.85, 1.15)),
      store: front || rnd() < 0.3,
      ...extra,
    };
    buildings.push(b);
    return b;
  };

  // 1) Street frontage along both sides of the circuit.
  const FRONT = CLEAR + 0.6;
  const p = new THREE.Vector3(), t = new THREE.Vector3(), r = new THREE.Vector3();
  for (const side of [-1, 1]) {
    let s = 0;
    while (s < L) {
      let w = R(12, 34);
      let placed = false;
      for (let attempt = 0; attempt < 3 && !placed; attempt++) {
        const sc = s + w / 2;
        track.getPointAt(sc, p); track.getTangentAt(sc, t); track.getRightAt(sc, r);
        const d = R(16, 34);
        const front = FRONT + R(0, 1.2);
        const cx = p.x + r.x * side * (front + d / 2), cz = p.z + r.z * side * (front + d / 2);
        // local A axis along the street, B axis pointing away from the street
        let ax = t.x, az = t.z;
        // B = (−az, ax) must equal side·right → flip A if needed
        if (-az * r.x * side + ax * r.z * side < 0) { ax = -ax; az = -az; }
        if (occ.rect(cx, cz, ax, az, w / 2, d / 2, 0.4)) {
          occ.rect(cx, cz, ax, az, w / 2, d / 2, 0.4, true);
          const zone = zoneOf(sc % L);
          const style = pickStyle(zone);
          const h = heightFor(zone, true);
          const b = addBuilding(cx, cz, ax, az, w / 2, d / 2, h, style, zone, true);
          frontage.push({ b, s: sc % L, side, x: p.x + r.x * side * front, z: p.z + r.z * side * front, nx: -r.x * side, nz: -r.z * side, tx: t.x, tz: t.z, width: w, height: h, zone });
          placed = true;
          s += w + R(0, 0.6);
        } else w *= 0.6;
        if (w < 8) break;
      }
      if (!placed) s += 3;
    }
  }

  // 2) Block interiors: jittered candidates, larger footprints and towers.
  const center = [-20, 160];
  const cands = [];
  for (let z = -650; z <= 700; z += 14) for (let x = -900; x <= 1000; x += 14) cands.push([x + R(-5, 5), z + R(-5, 5)]);
  for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
  for (const [x, z] of cands) {
    const k = occ.idx(x, z);
    if (k < 0 || occ.occ[k]) continue;
    const dC = Math.hypot(x - center[0], z - center[1]);
    const dTrack = occ.dist[k];
    let w = R(16, 44), d = R(16, 44);
    let ok = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (occ.rect(x, z, 1, 0, w / 2, d / 2, 2.5)) { ok = true; break; }
      w *= 0.75; d *= 0.75;
      if (w < 9 || d < 9) break;
    }
    if (!ok) continue;
    occ.rect(x, z, 1, 0, w / 2, d / 2, 2.5, true);
    const near = dTrack < 90;
    const zoneR = rnd();
    const zone = dC < 420 ? 'downtown' : zoneR < 0.5 ? 'east' : 'alley';
    const style = pickStyle(zone);
    const falloff = Math.exp(-(dC * dC) / (2 * 520 * 520));
    let h = heightFor(zone, false) * (0.55 + 0.75 * falloff);
    if (dC > 900) h *= 0.6;
    addBuilding(x, z, 1, 0, w / 2, d / 2, Math.max(10, h), style, zone, false, { store: near && rnd() < 0.6 });
  }
  return { buildings, frontage, occ };
}

// ---------------------------------------------------------------------------------------------
// Geometry from the layout
// ---------------------------------------------------------------------------------------------

function buildBuildingGeometry(b, acc, extras, rnd) {
  const R = (a, c) => a + (c - a) * rnd();
  const accent = (b.style === 0 || b.style === 2) && b.h > 45 && rnd() < 0.28 ? 1 + Math.floor(rnd() * 4) : 0;
  const base = {
    accent,
    style: b.style, seed: b.seed, lit: b.lit, wall: b.wall,
    uOff: Math.floor(rnd() * 8), vOff: Math.floor(rnd() * 8), storeRow: Math.floor(rnd() * 8),
    storeWall: [0.13, 0.13, 0.14],
  };
  // tiers: podium + optional setbacks for tall buildings
  const tiers = [];
  if (b.h > 60 && rnd() < 0.75) {
    const ph = b.store ? R(12, 24) : R(8, 18);
    tiers.push({ hw: b.hw, hd: b.hd, y0: 0, y1: ph, ox: 0, oz: 0 });
    let hw = b.hw * R(0.6, 0.85), hd = b.hd * R(0.6, 0.85);
    let y = ph;
    const ox = R(-1, 1) * (b.hw - hw) * 0.5, oz = R(-1, 1) * (b.hd - hd) * 0.5;
    if (rnd() < 0.45 && b.h > 110) {
      const y2 = y + (b.h - y) * R(0.55, 0.75);
      tiers.push({ hw, hd, y0: y, y1: y2, ox, oz });
      y = y2;
      hw *= R(0.65, 0.85); hd *= R(0.65, 0.85);
    }
    tiers.push({ hw, hd, y0: y, y1: b.h, ox, oz });
  } else {
    tiers.push({ hw: b.hw, hd: b.hd, y0: 0, y1: b.h, ox: 0, oz: 0 });
  }
  const bx = -b.az, bz = b.ax;
  tiers.forEach((tr, i) => {
    const cx = b.cx + b.ax * tr.ox + bx * tr.oz, cz = b.cz + b.az * tr.ox + bz * tr.oz;
    // snap the facade start so whole floors line up across tiers
    emitBox(acc, cx, cz, b.ax, b.az, tr.hw, tr.hd, tr.y0, tr.y1, { ...base, store: i === 0 && b.store, vOff: base.vOff });
    // parapet cap (slightly proud, plain dark)
    emitBox(acc, cx, cz, b.ax, b.az, tr.hw + 0.25, tr.hd + 0.25, tr.y1, tr.y1 + 0.9, { ...base, layer: LAYER.plain, wall: b.wall.map((v) => v * 0.6), store: false, roofLayer: LAYER.roof });
  });
  const top = tiers[tiers.length - 1];
  const tcx = b.cx + b.ax * top.ox + bx * top.oz, tcz = b.cz + b.az * top.ox + bz * top.oz;
  // rooftop machinery
  const nProps = Math.floor(R(0, 3.5));
  for (let i = 0; i < nProps; i++) {
    const w = R(1.5, Math.min(6, top.hw)), d = R(1.5, Math.min(6, top.hd));
    const ox = R(-1, 1) * Math.max(0, top.hw - w - 1), oz = R(-1, 1) * Math.max(0, top.hd - d - 1);
    emitBox(acc, tcx + b.ax * ox + bx * oz, tcz + b.az * ox + bz * oz, b.ax, b.az, w / 2, d / 2, b.h, b.h + R(1.2, 3.2), { ...base, layer: LAYER.plain, wall: [0.16, 0.16, 0.17], store: false, roofLayer: LAYER.plain, roofWall: [0.12, 0.12, 0.13] });
  }
  // crown lights / edge strips on some tall towers
  if (b.h > 70 && rnd() < 0.45) {
    const col = CROWN_COLORS[Math.floor(rnd() * CROWN_COLORS.length)];
    const y = b.h - 0.6;
    emitBox(acc, tcx, tcz, b.ax, b.az, top.hw + 0.3, top.hd + 0.3, y, y + 0.45, { ...base, layer: LAYER.emissive, wall: col, store: false, top: false });
    if (rnd() < 0.22) {
      for (const [sa, sb] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const ex = tcx + b.ax * top.hw * sa + bx * top.hd * sb, ez = tcz + b.az * top.hw * sa + bz * top.hd * sb;
        emitBox(acc, ex, ez, b.ax, b.az, 0.18, 0.18, top.y0 + 2, b.h - 0.6, { ...base, layer: LAYER.emissive, wall: col.map((v) => v * 0.7), store: false, top: false });
      }
    }
  }
  // antenna mast with aircraft warning light
  if (b.h > 95 && rnd() < 0.6) {
    const mh = R(8, 28);
    emitBox(acc, tcx, tcz, b.ax, b.az, 0.25, 0.25, b.h, b.h + mh, { ...base, layer: LAYER.plain, wall: [0.2, 0.2, 0.21], store: false, roofLayer: LAYER.plain, roofWall: [0.2, 0.2, 0.2] });
    extras.beacons.push([tcx, b.h + mh + 0.3, tcz]);
  } else if (b.h > 80) {
    // corner beacons on the roof
    extras.beacons.push([tcx + b.ax * top.hw * 0.9 + bx * top.hd * 0.9, b.h + 1.2, tcz + b.az * top.hw * 0.9 + bz * top.hd * 0.9]);
  }
  // water tank on mid-rise residential/brick roofs
  if ((b.style === 1 || b.style === 3) && b.h < 60 && rnd() < 0.35) {
    extras.tanks.push([tcx + b.ax * top.hw * 0.4, b.h, tcz + b.az * top.hw * 0.4]);
  }
}

function buildSkyline(acc, rnd, track) {
  const R = (a, b) => a + (b - a) * rnd();
  const cx = -20, cz = 200;
  const beacons = [];
  for (let i = 0; i < 380; i++) {
    const a = rnd() * Math.PI * 2;
    const rad = R(1500, 2650);
    const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
    // a denser skyline across the bay (south) and behind downtown (north)
    const dense = Math.abs(Math.sin(a)) > 0.6 ? 1 : 0.55;
    if (rnd() > dense) continue;
    const w = R(25, 80), d = R(25, 80);
    const h = Math.pow(rnd(), 2.2) * 300 + 30;
    const style = rnd() < 0.5 ? 2 : rnd() < 0.5 ? 0 : 1;
    const pal = PALETTE[style];
    const ang = rnd() < 0.7 ? 0 : R(0, Math.PI);
    const ax = Math.cos(ang), az = Math.sin(ang);
    emitBox(acc, x, z, ax, az, w / 2, d / 2, 0, h, {
      style, seed: Math.floor(rnd() * 997) + 1, lit: R(0.3, 0.7), wall: pal[0], uOff: Math.floor(rnd() * 8), vOff: Math.floor(rnd() * 8), storeRow: 0, store: false,
    });
    if (h > 150) beacons.push([x, h + 2, z]);
    if (h > 120 && rnd() < 0.5) {
      const col = CROWN_COLORS[Math.floor(rnd() * CROWN_COLORS.length)];
      emitBox(acc, x, z, ax, az, w / 2 + 0.6, d / 2 + 0.6, h - 1.5, h - 0.3, { style, seed: 1, lit: 0, wall: col.map((v) => v * 1.5), layer: LAYER.emissive, store: false, top: false, uOff: 0, vOff: 0, storeRow: 0 });
    }
  }
  return beacons;
}

// ---------------------------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------------------------

export function createCity({ track, quality = 'high' } = {}) {
  const group = new THREE.Group();
  group.name = 'city';
  const facade = createFacadeArray();
  const material = createBuildingMaterial(facade);
  const farMaterial = createBuildingMaterial(facade, { far: true });
  const layout = layoutCity(track, quality);
  const rnd = mulberry32(99);
  const extras = { beacons: [], tanks: [] };
  // chunk buildings spatially (frustum culling) — 260 m tiles
  const CH = 260;
  const chunks = new Map();
  for (const b of layout.buildings) {
    const key = `${Math.floor(b.cx / CH)},${Math.floor(b.cz / CH)}`;
    if (!chunks.has(key)) chunks.set(key, new GeoAcc());
    buildBuildingGeometry(b, chunks.get(key), extras, rnd);
  }
  const meshes = [];
  for (const [key, acc] of chunks) {
    const mesh = new THREE.Mesh(acc.build(), material);
    mesh.name = 'buildings-' + key;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    meshes.push(mesh);
    group.add(mesh);
  }
  // skyline
  const skyAcc = new GeoAcc();
  const skyBeacons = buildSkyline(skyAcc, mulberry32(7), track);
  const skyline = new THREE.Mesh(skyAcc.build(), farMaterial);
  skyline.name = 'skyline';
  skyline.frustumCulled = false;
  group.add(skyline);

  return {
    group,
    material,
    farMaterial,
    buildings: layout.buildings,
    frontage: layout.frontage,
    occupancy: layout.occ,
    beacons: extras.beacons.concat(skyBeacons),
    tanks: extras.tanks,
    meshes,
    skyline,
    update(time) {
      material.userData.uniforms.uTime.value = time;
      farMaterial.userData.uniforms.uTime.value = time;
    },
    /** true while the planar reflection renders: the buildings drop their near-field window detail there. */
    setLite(on) {
      material.userData.uniforms.uLite.value = on ? 1 : 0;
    },
    /** Bake the street-light wash for the facades from the real lamp list (lamps.posts). Optional. */
    setStreetLights(posts) {
      if (!posts || !posts.length) return;
      const m = createStreetLightMap(posts);
      const u = material.userData.uniforms;
      u.uStreetLight.value = m.texture;
      u.uSLBounds.value.copy(m.bounds);
      u.uSLOn.value = 1;
    },
  };
}
