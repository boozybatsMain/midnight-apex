// Detail parts for the procedural car: everything is built once (shared by all cars) and sorted into
// per-material buckets that carModel.js merges into one mesh per material.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CONFIG } from '../config.js';
import {
  ARCHES, WHEEL_Y, Z_FRONT, Z_REAR, SurfaceCaster, drapePatch, drapeTube, outerX, fixWinding, buildGreenhouse,
  planHalfWidth, smoothstep, clamp01, bodyBottomY,
} from './carBody.js';
import { SWATCH_UV } from './carTextures.js';

const C = CONFIG.car;
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------------------------------------
// geometry utilities
// ------------------------------------------------------------------------------------------------
// Normalise attributes so geometries can be merged: indexed, position/normal/uv/color only.
export function prep(geo, { uv = null, color = null, chan = undefined } = {}) {
  let g = geo;
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = new Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(idx);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  if (uv || !g.attributes.uv) {
    const a = new Float32Array(n * 2);
    const u = uv || [0, 0];
    for (let i = 0; i < n; i++) { a[i * 2] = u[0]; a[i * 2 + 1] = u[1]; }
    g.setAttribute('uv', new THREE.BufferAttribute(a, 2));
  }
  if (color || !g.attributes.color) {
    const a = new Float32Array(n * 3);
    const c = color || [1, 1, 1];
    for (let i = 0; i < n; i++) { a[i * 3] = c[0]; a[i * 3 + 1] = c[1]; a[i * 3 + 2] = c[2]; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  }
  if (chan !== undefined) g.setAttribute('chan', new THREE.BufferAttribute(new Float32Array(n).fill(chan), 1));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color', 'chan'].includes(k)) g.deleteAttribute(k);
  g.morphAttributes = {};
  return g;
}

// Box-projected UVs (for tiled carbon / mesh textures). Returns a non-indexed geometry.
export function boxUV(geo, scale = 8) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  const p = g.attributes.position.array;
  const uv = new Float32Array((p.length / 3) * 2);
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let t = 0; t < p.length / 9; t++) {
    const o = t * 9;
    e1.set(p[o + 3] - p[o], p[o + 4] - p[o + 1], p[o + 5] - p[o + 2]);
    e2.set(p[o + 6] - p[o], p[o + 7] - p[o + 1], p[o + 8] - p[o + 2]);
    n.crossVectors(e1, e2);
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const x = p[o + k * 3];
      const y = p[o + k * 3 + 1];
      const z = p[o + k * 3 + 2];
      let u;
      let v;
      if (ax >= ay && ax >= az) { u = z; v = y; } else if (ay >= az) { u = x; v = z; } else { u = x; v = y; }
      uv[(t * 3 + k) * 2] = u * scale;
      uv[(t * 3 + k) * 2 + 1] = v * scale;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

// Strip between two rails of points; flips so its normals agree with `expect(i) → Vector3` at the first sample.
function strip(railA, railB, expect, { color = null } = {}) {
  const n = railA.length;
  const pos = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    railA[i].toArray(pos, i * 6);
    railB[i].toArray(pos, i * 6 + 3);
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (expect) {
    const mid = Math.floor(n / 2);
    const nn = new THREE.Vector3().fromBufferAttribute(g.attributes.normal, mid * 2);
    if (nn.dot(expect(mid)) < 0) {
      for (let t = 0; t < idx.length; t += 3) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
      g.setIndex(idx);
      g.computeVertexNormals();
    }
  }
  return prep(g, { color });
}

// Loft rings (arrays of Vector3 with equal counts). closed = ring wraps around.
function loftRings(rings, { closed = false, outward = null } = {}) {
  const m = rings[0].length;
  const pos = [];
  for (const r of rings) for (const p of r) pos.push(p.x, p.y, p.z);
  const idx = [];
  const segs = closed ? m : m - 1;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * m + j;
      const b = i * m + ((j + 1) % m);
      const c = a + m;
      const d = b + m;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (outward) {
    // compare against the direction from a reference point
    const p = new THREE.Vector3().fromBufferAttribute(g.attributes.position, Math.floor(rings.length / 2) * m);
    const n = new THREE.Vector3().fromBufferAttribute(g.attributes.normal, Math.floor(rings.length / 2) * m);
    if (n.dot(p.clone().sub(outward)) < 0) {
      for (let t = 0; t < idx.length; t += 3) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
      g.setIndex(idx);
      g.computeVertexNormals();
    }
  }
  return g;
}

// Planar (z,y) shape extruded along X; (sx, sy) = (z, y). Returns geometry spanning x ∈ [x0, x0 + depth].
function extrudeZY(shapePts, depth, x0, bevel = 0) {
  // shape coords (sx, sy) = (y, z) so that (sx, sy, d) → (x=d, y=sx, z=sy) is a proper rotation
  const shape = new THREE.Shape(shapePts.map(([z, y]) => new THREE.Vector2(y, z)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: depth - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 12,
  });
  const m = new THREE.Matrix4().set(0, 0, 1, x0 + bevel, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1);
  g.applyMatrix4(m);
  return g;
}

// Planar (x,z) plan-view shape extruded along Y.
function extrudeXZ(shapePts, depth, y0, bevel = 0) {
  // (sx, sy, d) → (x = -sx, y = d, z = sy) : det +1
  const shape = new THREE.Shape(shapePts.map(([x, z]) => new THREE.Vector2(-x, z)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: depth - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 12,
  });
  const m = new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, 1, y0 + bevel, 0, 1, 0, 0, 0, 0, 0, 1);
  g.applyMatrix4(m);
  return g;
}

function mirrorX(geo) {
  // mirror across x = 0 with winding fix (for left/right symmetric parts)
  const g = prep(geo.clone());
  g.applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
  const idx = g.index.array;
  for (let t = 0; t < idx.length; t += 3) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
  g.index.needsUpdate = true;
  return g;
}
const both = (geo) => [geo, mirrorX(geo)];

// ------------------------------------------------------------------------------------------------
// All small light emitters share one material; `chan` selects a per-car gain (see carModel EMISSIVE_CHANNELS).
export const EMISSIVE = {
  drl: { chan: 0, color: [1, 0.97, 0.92] },
  marker: { chan: 0, color: [1, 0.03, 0.012] },
  headCore: { chan: 1, color: [1, 1, 1] },
  tailLED: { chan: 2, color: [1, 0.028, 0.012] },
  reverse: { chan: 3, color: [1, 1, 1] },
  exhaustGlow: { chan: 4, color: [0.16, 0.34, 1] },
};
class Buckets {
  constructor() { this.map = {}; }
  add(name, geo, opts = {}) {
    if (!geo) return;
    if (EMISSIVE[name]) {
      opts = { color: EMISSIVE[name].color, ...opts, chan: EMISSIVE[name].chan };
      name = 'emissive';
    }
    const list = Array.isArray(geo) ? geo : [geo];
    for (const g of list) (this.map[name] ||= []).push(prep(g, opts));
  }
  merged() {
    const out = {};
    for (const [k, list] of Object.entries(this.map)) {
      out[k] = mergeGeometries(list, false);
      out[k].computeBoundingSphere();
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------------
// Body-attached parts
// ------------------------------------------------------------------------------------------------
function archLiners(B) {
  for (const A of ARCHES) {
    const R = A.r + 0.004;
    const yLowF = Math.max(0.1, bodyBottomY(A.z + R) + 0.004);
    const yLowR = Math.max(0.1, bodyBottomY(A.z - R) + 0.004);
    const path = [];
    const n = 44;
    // tombstone: front vertical side (up), arc over the top, rear vertical side (down) — ends at the body's bottom
    for (let i = 0; i <= 6; i++) path.push([A.z + R, yLowF + ((WHEEL_Y - yLowF) * i) / 6]);
    for (let i = 1; i < n; i++) {
      const a = (i / n) * Math.PI;
      path.push([A.z + Math.cos(a) * R, WHEEL_Y + Math.sin(a) * R]);
    }
    for (let i = 0; i <= 6; i++) path.push([A.z - R, WHEEL_Y - ((WHEEL_Y - yLowR) * i) / 6]);
    const inner = [];
    const outer = [];
    for (const [z, y] of path) {
      let ox = outerX(z, Math.max(y, 0.16));
      if (!Number.isFinite(ox)) ox = 0.9;
      inner.push(V3(A.xInner, y, z));
      outer.push(V3(ox + 0.004, y, z));
    }
    const liner = strip(inner, outer, (i) => V3(0, WHEEL_Y - inner[i].y, A.z - inner[i].z).normalize());
    // inner wall (closes the wheel well), facing the wheel (+X)
    const wallPts = path.map(([z, y]) => new THREE.Vector2(y, z));
    const wall = new THREE.ShapeGeometry(new THREE.Shape(wallPts), 24);
    wall.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, A.xInner, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
    const wn = new Float32Array(wall.attributes.position.count * 3);
    for (let i = 0; i < wn.length; i += 3) wn[i] = 1;
    wall.setAttribute('normal', new THREE.BufferAttribute(wn, 3));
    fixWinding(wall);
    // uv for the textured plastic
    for (const g of [liner, wall]) {
      const p = g.attributes.position.array;
      const uv = new Float32Array((p.length / 3) * 2);
      for (let i = 0; i < p.length / 3; i++) { uv[i * 2] = (p[i * 3 + 2] + p[i * 3]) * 6; uv[i * 2 + 1] = p[i * 3 + 1] * 6; }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    B.add('mesh', both(prep(liner)));
    B.add('mesh', both(prep(wall)));
  }
}

function sideSkirts(B) {
  const rings = [];
  const z0 = -0.93;
  const z1 = 0.935;
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const z = z1 + (z0 - z1) * (i / n);
    const ox = outerX(z, 0.2);
    const e = Math.min(smoothstep(0, 0.07, z1 - z), smoothstep(0, 0.07, z - z0)); // taper into the body at the ends
    const out = 0.004 + 0.034 * e;
    rings.push([
      V3(ox - 0.03, 0.245, z),
      V3(ox + out * 0.5, 0.215, z),
      V3(ox + out, 0.165, z),
      V3(ox + out + 0.004 * e, 0.112, z),
      V3(ox + out - 0.012, 0.098, z),
      V3(ox - 0.08, 0.1, z),
    ]);
  }
  const g = loftRings(rings, { outward: V3(0, 0.3, 0) });
  B.add('carbon', both(boxUV(g, 9)));
}

function splitter(B, caster) {
  // plan outline follows the nose footprint just above the blade (y = 0.15): a lip that protrudes ~6 cm at
  // the centre and tucks back to the body line at the corners, back edge hidden under the bumper
  const zBack = 1.8;
  let xs = outerX(zBack, 0.16);
  xs = Number.isFinite(xs) ? Math.min(0.9, xs - 0.005) : 0.82;
  const pts = [];
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const x = -xs + (2 * xs * i) / n;
    let fz = caster.frontZ(x, 0.16);
    if (!Number.isFinite(fz)) fz = zBack + 0.02;
    const ext = 0.058 * (1 - (x / xs) ** 6) + 0.006;
    pts.push([x, Math.max(zBack + 0.01, fz + ext)]);
  }
  pts.push([xs, zBack], [-xs, zBack]);
  const g = extrudeXZ(pts.reverse(), 0.022, 0.082, 0.004);
  B.add('carbon', boxUV(g, 9));
}

// Draped patch with tiled UVs in plane coordinates
function drape(caster, axis, dir, grid, nu, nv, offset, uvScale = 8) {
  return drapePatch(caster, axis, dir, grid, nu, nv, { offset, uvFn: (u, v) => grid(u, v).map((c) => c * uvScale) });
}
// horizontal slice [min, max] of a convex polygon (pts [a, b]) at b = y
function slice(poly, y) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [a0, b0] = poly[i];
    const [a1, b1] = poly[(i + 1) % poly.length];
    if ((b0 - y) * (b1 - y) <= 0 && b0 !== b1) {
      const a = a0 + ((a1 - a0) * (y - b0)) / (b1 - b0);
      lo = Math.min(lo, a);
      hi = Math.max(hi, a);
    }
  }
  return [lo, hi];
}
function drapePoly(caster, axis, dir, poly, nu, nv, offset, uvScale = 8) {
  const bs = poly.map((p) => p[1]);
  const b0 = Math.min(...bs) + 1e-4;
  const b1 = Math.max(...bs) - 1e-4;
  return drape(caster, axis, dir, (u, v) => {
    const b = b0 + (b1 - b0) * v;
    const [lo, hi] = slice(poly, b);
    return [lo + (hi - lo) * u, b];
  }, nu, nv, offset, uvScale);
}

function frontEnd(B, caster) {
  const out = {};
  // central intake and corner intakes (honeycomb), draped on the nose
  B.add('mesh', drapePoly(caster, 'z', 1, [[-0.4, 0.15], [0.4, 0.15], [0.34, 0.31], [-0.34, 0.31]], 30, 8, 0.003, 10));
  const sideIntake = [[0.47, 0.152], [0.78, 0.152], [0.83, 0.24], [0.76, 0.35], [0.6, 0.345], [0.47, 0.24]];
  for (const s of [1, -1]) B.add('mesh', drapePoly(caster, 'z', 1, sideIntake.map(([x, y]) => [x * s, y]), 18, 10, 0.003, 10));
  // carbon blades inside the corner intakes
  for (const s of [1, -1]) {
    const g = drapeTube(caster, 'z', 1, [[0.5 * s, 0.25], [0.66 * s, 0.262], [0.8 * s, 0.25]], 0.009, { offset: 0.006, radial: 6 });
    if (g) B.add('carbon', boxUV(g, 9));
  }

  // headlights: slim angular units wrapped over the nose corners (draped from above)
  const zA = 1.7;
  const zB = 2.11;
  const band = (s, t) => {
    const z = zA + (zB - zA) * s;
    const xo = planHalfWidth(z) * 0.985 + 0.01;
    const w = 0.125 - 0.06 * s;
    return [z, xo - w * (1 - t)];
  };
  out.headlights = [];
  for (const sg of [1, -1]) {
    const grid = (u, v) => { const [z, x] = band(u, v); return [z, x * sg]; };
    const housing = drapePatch(caster, 'y', 1, grid, 24, 6, { offset: 0.0025 });
    B.add('trim', housing);
    // chrome reflector bowl behind the (dark) lens: makes the unit read as a headlight
    const refl = drapePatch(caster, 'y', 1, (u, v) => { const [z, x] = band(0.1 + 0.8 * u, 0.32 + 0.5 * v); return [z, x * sg]; }, 18, 4, { offset: 0.0034 });
    B.add('chrome', refl);
    // DRL signature: light pipe along the inner edge that hooks diagonally to the outer front corner (arrow)
    const pts = [];
    for (let i = 0; i <= 12; i++) { const [z, x] = band(0.04 + 0.6 * (i / 12), 0.17); pts.push([z, x * sg]); }
    for (let i = 1; i <= 7; i++) { const [z, x] = band(0.64 + 0.33 * (i / 7), 0.17 + 0.75 * (i / 7)); pts.push([z, x * sg]); }
    B.add('drl', drapeTube(caster, 'y', 1, pts, 0.0065, { offset: 0.004, radial: 6 }));
    const pts2 = [];
    for (let i = 0; i <= 6; i++) { const [z, x] = band(0.08 + 0.42 * (i / 6), 0.9); pts2.push([z, x * sg]); }
    B.add('drl', drapeTube(caster, 'y', 1, pts2, 0.0035, { offset: 0.004, radial: 5 }), { color: [0.9, 0.95, 1] });
    // projector lenses (chrome bezel + glowing core) seated in the reflector
    for (const s of [0.3, 0.52]) {
      const [z, x] = band(s, 0.58);
      const h = caster.cast('y', 1, z, x * sg);
      if (!h) continue;
      const p = h.point.clone().addScaledVector(h.normal, 0.005);
      const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 0, 1), h.normal.clone().lerp(V3(0, 0.2, 1).normalize(), 0.55).normalize());
      const bez = new THREE.TorusGeometry(0.021, 0.0045, 6, 20);
      bez.applyQuaternion(q).translate(p.x, p.y, p.z);
      B.add('trim', bez);
      const lens = new THREE.SphereGeometry(0.017, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      lens.rotateX(Math.PI / 2).applyQuaternion(q).translate(p.x, p.y, p.z);
      B.add('headCore', lens);
      out.headlights.push(p.clone());
    }
  }
  // amber side markers on the front corners
  for (const s of [1, -1]) {
    B.add('drl', drapePatch(caster, 'x', s, (u, v) => [0.37 + 0.025 * v, 1.86 + 0.09 * u], 4, 1, { offset: 0.002 }), { color: [1, 0.42, 0.04] });
  }
  return out;
}

function rearEnd(B, caster) {
  const out = { exhausts: [], tail: [] };
  // rear fascia: upper honeycomb grille between the lamp clusters, carbon blade, lower exhaust housing
  B.add('mesh', drape(caster, 'z', -1, (u, v) => { const y = 0.535 + 0.235 * v; const w = 0.545; return [-w + 2 * w * u, y]; }, 30, 8, 0.003, 10));
  B.add('mesh', drape(caster, 'z', -1, (u, v) => { const y = 0.322 + 0.17 * v; const w = 0.44 - 0.05 * (1 - v) * (1 - v); return [-w + 2 * w * u, y]; }, 24, 6, 0.003, 10));
  B.add('carbon', drape(caster, 'z', -1, (u, v) => { const y = 0.495 + 0.035 * v; const w = 0.66 - 0.04 * v; return [-w + 2 * w * u, y]; }, 30, 2, 0.007, 9));
  // red reflectors low on the bumper corners
  for (const s of [1, -1]) B.add('tailHousing', drape(caster, 'z', -1, (u, v) => [s * (0.66 + 0.18 * u), 0.405 + 0.022 * v], 8, 1, 0.004));
  // tail light housings (dark red glass): full-width band + corner clusters
  B.add('tailHousing', drape(caster, 'z', -1, (u, v) => [-0.885 + 1.77 * u, 0.775 + 0.06 * v], 48, 3, 0.004));
  for (const s of [1, -1]) {
    B.add('tailHousing', drapePoly(caster, 'z', -1, [[0.56, 0.775], [0.895, 0.775], [0.9, 0.66], [0.84, 0.63], [0.62, 0.63]].map(([x, y]) => [x * s, y]), 14, 6, 0.004));
  }
  // LED light pipes
  const bar = [];
  for (let i = 0; i <= 40; i++) bar.push([-0.87 + (1.74 * i) / 40, 0.805]);
  B.add('tailLED', drapeTube(caster, 'z', -1, bar, 0.0085, { offset: 0.006, radial: 6 }));
  for (const s of [1, -1]) {
    const c1 = [[0.6, 0.787], [0.6, 0.69], [0.65, 0.655], [0.88, 0.655]].map(([x, y]) => [x * s, y]);
    const c2 = [[0.66, 0.745], [0.885, 0.745]].map(([x, y]) => [x * s, y]);
    const c3 = [[0.7, 0.7], [0.885, 0.7]].map(([x, y]) => [x * s, y]);
    for (const c of [c1, c2, c3]) {
      const d = [];
      for (let i = 0; i < c.length - 1; i++) for (let k = 0; k < 6; k++) d.push([c[i][0] + ((c[i + 1][0] - c[i][0]) * k) / 6, c[i][1] + ((c[i + 1][1] - c[i][1]) * k) / 6]);
      d.push(c[c.length - 1]);
      B.add('tailLED', drapeTube(caster, 'z', -1, d, 0.0075, { offset: 0.006, radial: 6 }));
    }
    const p = caster.cast('z', -1, 0.75 * s, 0.72);
    if (p) out.tail.push(p.point.clone().add(V3(0, 0, -0.01)));
    // red rear side markers
    B.add('marker', drapePatch(caster, 'x', s, (u, v) => [0.62 + 0.025 * v, -2.02 + 0.08 * u], 4, 1, { offset: 0.002 }));
    // reverse lights (white) under the bar
    B.add('reverse', drape(caster, 'z', -1, (u, v) => [s * (0.12 + 0.12 * u), 0.748 + 0.018 * v], 6, 1, 0.005));
  }
  // quad exhaust tips through the rear mesh
  const tipProfile = [[0.042, 0.16], [0.042, 0.012], [0.0445, 0.003], [0.049, 0.0], [0.0535, 0.004], [0.0555, 0.016], [0.0555, 0.16]].map(([r, h]) => new THREE.Vector2(r, h));
  for (const x of [-0.29, -0.12, 0.12, 0.29]) {
    const y = 0.41;
    const rz = caster.rearZ(x, y);
    const zt = (Number.isFinite(rz) ? rz : -2.2) - 0.045;
    const tip = new THREE.LatheGeometry(tipProfile, 28);
    tip.rotateX(Math.PI / 2).translate(x, y, zt);
    B.add('chrome', tip);
    const ring = new THREE.TorusGeometry(0.062, 0.008, 6, 24);
    ring.translate(x, y, zt + 0.035);
    B.add('trim', ring);
    const glow = new THREE.CircleGeometry(0.043, 20);
    glow.rotateY(Math.PI).translate(x, y, zt + 0.035);
    B.add('exhaustGlow', glow);
    // dark inner pipe wall behind the glow
    out.exhausts.push(V3(x, y, zt));
  }
  // nitro flames: a closed lathe hull per tip that bounds a ray-marched flame volume (carModel's flame shader).
  // The hull starts just inside the pipe so the hot core lights the tip opening; `color` carries the nozzle
  // position (car-local) so the shader knows each flame's axis.
  const hull = [[0.0, -0.03], [0.05, -0.03], [0.062, 0.06], [0.07, 0.22], [0.062, 0.42], [0.045, 0.6], [0.022, 0.74], [0.0, 0.8]]
    .map(([r, h]) => new THREE.Vector2(r, h));
  for (const e of out.exhausts) {
    const g = new THREE.LatheGeometry(hull, 14);
    g.rotateX(-Math.PI / 2); // lathe axis +Y → −Z (out of the pipe, backwards)
    g.translate(e.x, e.y, e.z);
    B.add('flame', g, { color: [e.x, e.y, e.z] });
  }
  // diffuser: carbon plate under the rear + vertical fins
  const plate = drape(caster, 'y', -1, (u, v) => [-2.26 + 0.7 * v, -0.86 + 1.72 * u], 24, 14, 0.003, 9);
  B.add('carbon', plate);
  for (const x of [-0.5, -0.25, 0, 0.25, 0.5]) {
    const top = [];
    const bot = [];
    for (let i = 0; i <= 12; i++) {
      const z = -1.62 - 0.62 * (i / 12);
      const h = caster.cast('y', -1, z, x);
      const yb = h ? h.point.y : 0.15;
      top.push([z, yb + 0.01]);
      bot.push([z, Math.min(yb - 0.02, 0.14 + 0.11 * (i / 12))]);
    }
    const rz = caster.rearZ(x, 0.2);
    const zEnd = Number.isFinite(rz) ? rz - 0.01 : -2.25;
    top.push([zEnd, 0.29]);
    bot.push([zEnd, 0.255]);
    const shape = [...bot, ...top.reverse()];
    B.add('carbon', boxUV(extrudeZY(shape, 0.018, x - 0.009, 0.003), 9));
  }
  // diffuser trailing-edge blade framing the fins
  B.add('carbon', drape(caster, 'z', -1, (u, v) => { const w = 0.62 + 0.05 * v; return [-w + 2 * w * u, 0.286 + 0.03 * v]; }, 30, 2, 0.012, 9));
  return out;
}

function sideDetails(B, caster) {
  // honeycomb mesh at the back of the side intake scoop
  for (const s of [1, -1]) {
    B.add('mesh', drapePoly(caster, 'x', s, [[0.44, -0.93], [0.7, -0.93], [0.69, -0.66], [0.6, -0.57], [0.44, -0.6]].map(([y, z]) => [y, z]), 8, 12, 0.003, 10));
  }
  // mirrors: body-colour housing on a black stalk, chrome glass facing back
  const housing = new THREE.SphereGeometry(1, 24, 14);
  housing.scale(0.12, 0.052, 0.07);
  // flatten the back slightly
  const hp = housing.attributes.position;
  for (let i = 0; i < hp.count; i++) if (hp.getZ(i) < -0.03) hp.setZ(i, -0.03 + (hp.getZ(i) + 0.03) * 0.35);
  housing.computeVertexNormals();
  // carbon cap: the upper/outer shell of the housing, slightly proud of the body-colour lower half
  const cap = new THREE.SphereGeometry(1, 24, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
  cap.scale(0.123, 0.054, 0.073);
  const cp = cap.attributes.position;
  for (let i = 0; i < cp.count; i++) if (cp.getZ(i) < -0.03) cp.setZ(i, -0.03 + (cp.getZ(i) + 0.03) * 0.35);
  cap.computeVertexNormals();
  cap.rotateZ(-0.08).translate(0.985, 0.957, 0.7);
  B.add('carbon', both(boxUV(cap, 14)));
  housing.rotateZ(-0.08).translate(0.985, 0.955, 0.7);
  B.add('paint', both(housing), { uv: SWATCH_UV.paint });
  const glass = new THREE.CircleGeometry(1, 24);
  glass.scale(0.1, 0.04, 1).rotateY(Math.PI).rotateZ(-0.08).translate(0.985, 0.955, 0.653);
  B.add('chrome', both(glass));
  const stalk = new RoundedBoxGeometry(0.16, 0.018, 0.05, 2, 0.008);
  stalk.rotateZ(0.32).translate(0.905, 0.91, 0.71);
  B.add('trim', both(stalk));
}

function rearWing(B0, caster) {
  const B = { add: (name, g, o) => B0.add(name === 'carbon' ? 'wing' : name, g, o) };
  // inverted cambered airfoil (z, y) — leading edge forward
  const chord = 0.32;
  const foil = [];
  const n = 18;
  const camber = (t) => 0.028 * Math.sin(Math.PI * t) + 0.05 * t * t; // trailing edge kicks up
  const thick = (t) => 0.024 * (1.45 * Math.sqrt(t) - 0.6 * t - 1.6 * t * t + 1.1 * t * t * t - 0.35 * t ** 4);
  for (let i = 0; i <= n; i++) { const t = (i / n) ** 1.3; foil.push([-t * chord, camber(t) + Math.max(0.0015, thick(t))]); }
  for (let i = n; i >= 0; i--) { const t = (i / n) ** 1.3; foil.push([-t * chord, camber(t) - Math.max(0.0015, thick(t) * 0.6)]); }
  const zLE = -1.86;
  const yLE = 1.115;
  const shape = foil.map(([z, y]) => [z + zLE, y + yLE]);
  const span = 0.8;
  B.add('carbon', boxUV(extrudeZY(shape, span * 2, -span, 0.003), 9));
  // gurney flap
  B.add('carbon', boxUV(extrudeZY([[zLE - chord - 0.004, yLE + 0.05], [zLE - chord + 0.006, yLE + 0.05], [zLE - chord + 0.006, yLE + 0.09], [zLE - chord - 0.004, yLE + 0.09]], span * 2, -span), 9));
  // endplates
  for (const s of [1, -1]) {
    const ep = [[zLE + 0.04, yLE - 0.07], [zLE - chord - 0.03, yLE - 0.05], [zLE - chord - 0.02, yLE + 0.12], [zLE - 0.06, yLE + 0.06], [zLE + 0.05, yLE + 0.01]];
    B.add('carbon', boxUV(extrudeZY(ep, 0.012, s > 0 ? span : -span - 0.012, 0.002), 9));
  }
  // swan-neck uprights: rise from the deck behind the cabin, hook over and grab the wing from above
  for (const s of [1, -1]) {
    const x = 0.36 * s;
    const deck = caster.topY(x, -1.98);
    const yd = Number.isFinite(deck) ? deck : 0.95;
    const prof = [
      [-1.9, yd - 0.02], [-2.06, yd - 0.02], [-2.04, yd + 0.06], [-2.0, yLE + 0.06], [-1.96, yLE + 0.12], [-1.9, yLE + 0.13],
      [-1.86, yLE + 0.09], [-1.9, yLE + 0.075], [-1.94, yLE + 0.04], [-1.95, yd + 0.06],
    ];
    B.add('carbon', boxUV(extrudeZY(prof, 0.024, x - 0.012, 0.004), 9));
  }
  // high-mount brake light strip under the trailing edge
  return V3(0, yLE + 0.05, zLE - chord + 0.004);
}

// centre high-mount brake light on the roof's rear edge (all cars, wing or not)
function highMountStop(B, ghCaster) {
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push([-0.665, -0.22 + (0.44 * i) / 10]);
  B.add('tailLED', drapeTube(ghCaster, 'y', 1, pts, 0.0055, { offset: 0.004, radial: 6 }));
}

// raised blades over the painted engine-cover vent slots (adds real depth seen from the chase cam)
function engineCoverBlades(B, caster) {
  for (const sg of [1, -1]) {
    for (let k = 0; k < 6; k++) {
      const z = -1.42 - k * 0.085 - 0.022;
      const base = [];
      const top = [];
      const n = 8;
      for (let i = 0; i <= n; i++) {
        const x = sg * (0.075 + (0.33 * i) / n);
        const h = caster.cast('y', 1, z, x);
        const y = h ? h.point.y : 0.95;
        base.push(V3(x, y - 0.003, z + 0.012));
        top.push(V3(x, y + 0.013, z - 0.012));
      }
      B.add('trim', strip(base, top, () => V3(0, 0.6, 1).normalize()));
    }
  }
}

function engineLouvres(B, ghCaster) {
  for (let k = 0; k < 7; k++) {
    const z = -0.76 - k * 0.064;
    const base = [];
    const top = [];
    const n = 16;
    for (let i = 0; i <= n; i++) {
      const x = -0.42 + (0.84 * i) / n;
      const h = ghCaster.cast('y', 1, z, x);
      const y = h ? h.point.y : 1.0;
      base.push(V3(x, y - 0.004, z + 0.004));
      top.push(V3(x, y + 0.016, z - 0.016));
    }
    B.add('trim', strip(base, top, () => V3(0, 0.4, 1).normalize()));
    const back = top.map((p) => p.clone().add(V3(0, -0.02, -0.008)));
    B.add('trim', strip(top, back, () => V3(0, 0.6, -1).normalize()));
  }
}

function wiper(B, caster) {
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const x = 0.42 - 0.62 * (i / 10);
    const z = 1.03 + 0.03 * (i / 10);
    const y = caster.topY(x, z);
    pts.push(V3(x, (Number.isFinite(y) ? y : 0.8) + 0.012, z));
  }
  B.add('trim', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.006, 5, false));
}

function interior(B, caster, uvScale) {
  const leather = [0.2, 0.035, 0.03];
  const black = [0.035, 0.035, 0.04];
  // floor/tub cover hides the painted body top inside the cabin
  const floor = drapePatch(caster, 'y', 1, (u, v) => [-0.66 + 1.68 * v, -0.71 + 1.42 * u], 18, 24, { offset: 0.006 });
  B.add('interior', floor, { color: black });
  // inner cabin shell (headliner / door cards): inset greenhouse, faces inward
  const shell = buildGreenhouse(caster, uvScale, { inset: 0.018 }).full;
  const idx = shell.index.array;
  for (let t = 0; t < idx.length; t += 3) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
  shell.index.needsUpdate = true;
  const nrm = shell.attributes.normal.array;
  for (let i = 0; i < nrm.length; i++) nrm[i] = -nrm[i];
  B.add('interior', shell, { color: [0.05, 0.05, 0.055] });
  for (const sx of [0.34, -0.34]) {
    const back = new RoundedBoxGeometry(0.46, 0.66, 0.11, 2, 0.04);
    back.rotateX(-0.32).translate(sx, 0.74, -0.5);
    const head = new RoundedBoxGeometry(0.26, 0.14, 0.1, 2, 0.04);
    head.rotateX(-0.32).translate(sx, 1.01, -0.6);
    const bolsterL = new RoundedBoxGeometry(0.07, 0.5, 0.16, 2, 0.03);
    bolsterL.rotateX(-0.32).translate(sx + 0.22, 0.72, -0.46);
    const bolsterR = bolsterL.clone().translate(-0.44, 0, 0);
    const cushion = new RoundedBoxGeometry(0.46, 0.12, 0.5, 2, 0.04);
    cushion.translate(sx, 0.5, -0.2);
    B.add('interior', [back, head, bolsterL, bolsterR, cushion], { color: leather });
  }
  const dash = new RoundedBoxGeometry(1.42, 0.16, 0.5, 2, 0.05);
  dash.translate(0, 0.8, 0.66);
  const console = new RoundedBoxGeometry(0.22, 0.26, 0.95, 2, 0.04);
  console.translate(0, 0.62, 0.05);
  const binnacle = new RoundedBoxGeometry(0.34, 0.08, 0.16, 2, 0.03);
  binnacle.translate(0.34, 0.89, 0.5);
  B.add('interior', [dash, console, binnacle], { color: black });
  // steering wheel
  const wheel = new THREE.TorusGeometry(0.17, 0.02, 8, 36);
  wheel.rotateX(-0.42).translate(0.34, 0.84, 0.3);
  const hub = new THREE.CylinderGeometry(0.05, 0.05, 0.06, 16);
  hub.rotateX(Math.PI / 2 - 0.42).translate(0.34, 0.84, 0.31);
  B.add('interior', [wheel, hub], { color: [0.06, 0.06, 0.065] });
  // instrument glow
  const cluster = new THREE.PlaneGeometry(0.26, 0.06);
  cluster.rotateX(-0.25).rotateY(Math.PI).translate(0.34, 0.885, 0.42);
  B.add('drl', cluster, { color: [0.03, 0.12, 0.22] });
}

// ------------------------------------------------------------------------------------------------
// Wheels (axle along X, outer face toward +X, centred at the origin)
// ------------------------------------------------------------------------------------------------
function lathe(profile, segs) {
  const g = new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(r, h)), segs);
  g.rotateZ(-Math.PI / 2); // lathe axis Y → X ; (r,h) → x = h
  return g;
}

export function buildWheelGeometries({ lod = false } = {}) {
  // --- tire: rounded sidewalls, slight bulge, flat tread
  const halfP = [[0.35, 0.0], [0.35, 0.05], [0.3498, 0.08], [0.349, 0.098], [0.3465, 0.112], [0.3425, 0.123], [0.336, 0.131],
    [0.326, 0.137], [0.313, 0.1405], [0.298, 0.1415], [0.283, 0.1405], [0.27, 0.1375], [0.261, 0.133], [0.2555, 0.127]];
  const profile = [];
  for (let i = halfP.length - 1; i > 0; i--) profile.push([halfP[i][0], -halfP[i][1]]);
  for (let i = 0; i < halfP.length; i++) profile.push(halfP[i]);
  if (lod) {
    // keep every other profile point (tread edges + sidewall bulge survive)
    const keep = profile.filter((_, i) => i % 2 === 0 || i === profile.length - 1);
    profile.length = 0;
    profile.push(...keep);
  }
  // reorder so lathe normals face outward: go from outer bead (h+) to inner bead (h−)
  profile.reverse();
  const TSEG = lod ? 24 : 48;
  const tire = lathe(profile, TSEG);
  // arc-length v so the tread texture is uniform
  const arc = [0];
  for (let i = 1; i < profile.length; i++) arc.push(arc[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  const L = arc[arc.length - 1];
  const uv = tire.attributes.uv;
  const segs = TSEG;
  for (let i = 0; i <= segs; i++) for (let j = 0; j < profile.length; j++) uv.setY(i * profile.length + j, arc[j] / L);
  let tv0 = 1;
  let tv1 = 0;
  for (let j = 0; j < profile.length; j++) if (Math.abs(profile[j][1]) <= 0.1) { tv0 = Math.min(tv0, arc[j] / L); tv1 = Math.max(tv1, arc[j] / L); }
  prep(tire);
  if (lod) return { tire, treadV: [tv0, tv1] };

  // --- rim: barrel + lip (lathe), twin-spoke concave face, hub + centre-lock
  const parts = [];
  const barrel = lathe([[0.257, 0.116], [0.264, 0.117], [0.268, 0.112], [0.266, 0.105], [0.257, 0.101], [0.246, 0.097],
    [0.239, 0.088], [0.235, 0.07], [0.233, 0.03], [0.233, -0.126]], 44);
  {
    const p = barrel.attributes.position;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const h = p.getX(i);
      const c = h > 0.096 ? 0.95 : h > 0.06 ? 0.35 : 0.06;
      col[i * 3] = c; col[i * 3 + 1] = c; col[i * 3 + 2] = c * 1.03;
    }
    barrel.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  parts.push(prep(barrel));
  const rh = 0.07;
  const rr = 0.238;
  const silver = [0.62, 0.63, 0.66];
  const bright = [0.92, 0.93, 0.95];
  const gun = [0.055, 0.055, 0.06];
  for (let p = 0; p < 5; p++) {
    const ap = (p / 5) * Math.PI * 2;
    for (const sgn of [-1, 1]) {
      const rails = [[], [], [], [], [], []];
      const K = 10;
      for (let k = 0; k <= K; k++) {
        const t = k / K;
        const r = rh + (rr - rh) * t;
        const a = ap + sgn * (0.05 + 0.115 * t * t + 0.02 * t);
        const hw = 0.0225 - 0.0075 * t;
        const hf = 0.04 + 0.054 * (1 - Math.pow(1 - t, 1.7));
        const d = 0.046 - 0.016 * t;
        const er = V3(0, Math.cos(a), Math.sin(a));
        const et = V3(0, -Math.sin(a), Math.cos(a));
        const pt = (o, h) => V3(h, 0, 0).addScaledVector(er, r).addScaledVector(et, o);
        rails[0].push(pt(-hw, hf - d));
        rails[1].push(pt(-hw, hf - 0.008));
        rails[2].push(pt(-hw + 0.006, hf));
        rails[3].push(pt(hw - 0.006, hf));
        rails[4].push(pt(hw, hf - 0.008));
        rails[5].push(pt(hw, hf - d));
      }
      const am = ap + sgn * 0.1;
      const etm = V3(0, -Math.sin(am), Math.cos(am));
      parts.push(strip(rails[0], rails[1], () => etm.clone().negate(), { color: gun }));
      parts.push(strip(rails[1], rails[2], () => etm.clone().negate().add(V3(1, 0, 0)), { color: bright }));
      parts.push(strip(rails[2], rails[3], () => V3(1, 0, 0), { color: silver }));
      parts.push(strip(rails[3], rails[4], () => etm.clone().add(V3(1, 0, 0)), { color: bright }));
      parts.push(strip(rails[4], rails[5], () => etm.clone(), { color: gun }));
    }
  }
  const hub = lathe([[0.078, -0.02], [0.078, 0.03], [0.075, 0.046], [0.05, 0.056], [0.036, 0.063], [0.028, 0.066], [0.001, 0.066]], 32);
  parts.push(prep(hub, { color: [0.08, 0.08, 0.085] }));
  const nut = new THREE.CylinderGeometry(0.031, 0.031, 0.026, 6);
  nut.rotateZ(-Math.PI / 2).translate(0.078, 0, 0);
  parts.push(prep(nut, { color: [0.85, 0.85, 0.88] }));
  const cap = new THREE.CylinderGeometry(0.017, 0.022, 0.012, 18);
  cap.rotateZ(-Math.PI / 2).translate(0.096, 0, 0);
  parts.push(prep(cap, { color: [0.75, 0.05, 0.04] }));
  const rim = mergeGeometries(parts, false);

  // --- brake disc (friction ring + bell)
  const dparts = [];
  const ringF = new THREE.RingGeometry(0.108, 0.19, 48, 1);
  ringF.rotateY(Math.PI / 2).translate(-0.013, 0, 0);
  const ringB = new THREE.RingGeometry(0.108, 0.19, 48, 1);
  ringB.rotateY(-Math.PI / 2).translate(-0.045, 0, 0);
  const edge = new THREE.CylinderGeometry(0.19, 0.19, 0.032, 48, 1, true);
  edge.rotateZ(-Math.PI / 2).translate(-0.029, 0, 0);
  const bell = new THREE.CircleGeometry(0.108, 32);
  bell.rotateY(Math.PI / 2).translate(0.012, 0, 0);
  {
    const u = bell.attributes.uv;
    for (let i = 0; i < u.count; i++) { u.setXY(i, 0.5 + (u.getX(i) - 0.5) * (0.108 / 0.19), 0.5 + (u.getY(i) - 0.5) * (0.108 / 0.19)); }
  }
  const bellSide = new THREE.CylinderGeometry(0.108, 0.108, 0.025, 32, 1, true);
  bellSide.rotateZ(-Math.PI / 2).translate(0.0, 0, 0);
  dparts.push(prep(ringF), prep(ringB), prep(edge, { uv: [0.5, 0.97] }), prep(bell), prep(bellSide, { uv: [0.5, 0.5] }));
  const disc = mergeGeometries(dparts, false);

  // --- caliper: 6-piston monoblock (annular sector straddling the disc), at the rear-top of the wheel
  const thC = (125 * Math.PI) / 180;
  const cal = [];
  const span = 0.52;
  for (let i = 0; i <= 12; i++) { const a = thC - span + (2 * span * i) / 12; cal.push([Math.cos(a) * 0.222, Math.sin(a) * 0.222]); }
  for (let i = 12; i >= 0; i--) { const a = thC - span + (2 * span * i) / 12; cal.push([Math.cos(a) * 0.148, Math.sin(a) * 0.148]); }
  const caliper = extrudeZY(cal, 0.078, -0.066, 0.009);
  prep(caliper);

  return { tire, rim, disc, caliper, treadV: [tv0, tv1], caliperAngle: thC };
}

// ------------------------------------------------------------------------------------------------
export function buildCarParts(S, { wing = true } = {}) {
  const B = new Buckets();
  const caster = S.caster;
  archLiners(B);
  sideSkirts(B);
  splitter(B, caster);
  const front = frontEnd(B, caster);
  const rear = rearEnd(B, caster);
  sideDetails(B, caster);
  const ghCaster = new SurfaceCaster(S.gh.full);
  engineLouvres(B, ghCaster);
  highMountStop(B, ghCaster);
  engineCoverBlades(B, caster);
  wiper(B, caster);
  interior(B, caster, S.body.uvScale);
  let hmsl = null;
  if (wing) hmsl = rearWing(B, caster);
  return { buckets: B.merged(), front, rear, hmsl };
}
