// Procedural supercar body: lofted shell (superellipse cross-sections swept along Z), wheel-arch cut-outs,
// greenhouse loft, and an axis-aligned surface caster used to drape details (lights, intakes, vents) onto the body.
//
// Car local space: +Z forward, +Y up, +X = car's LEFT. Ground at y = 0, origin halfway between the axles.
import * as THREE from 'three';
import { CONFIG } from '../config.js';

const C = CONFIG.car;
export const Z_FRONT = C.length / 2 + 0.01; // 2.285
export const Z_REAR = -C.length / 2 + 0.01; // -2.265
export const BODY_LEN = Z_FRONT - Z_REAR;
export const WHEEL_Y = C.wheelRadius;
export const ARCHES = [
  { z: C.frontAxleZ, r: 0.392, xInner: 0.48 },
  { z: C.rearAxleZ, r: 0.398, xInner: 0.58 },
];

export const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// Fritsch–Carlson monotone cubic through [x, y] pairs (x ascending): smooth profiles without overshoot.
export function monotone(pts) {
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d = [];
  const m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] > x) hi = mid; else lo = mid; }
    const h = xs[hi] - xs[lo];
    const t = (x - xs[lo]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h * m[lo] + (-2 * t3 + 3 * t2) * ys[hi] + (t3 - t2) * h * m[hi];
  };
}

// ---------------------------------------------------------------------------------------------
// Body design curves (z ascending: rear → front). Heights in meters above the ground.
// ---------------------------------------------------------------------------------------------
const P = {
  // plan-view max half width (before the end rounding)
  W: monotone([[-2.265, 0.9], [-2.05, 0.945], [-1.75, 0.97], [-1.4, 0.975], [-1.05, 0.955], [-0.7, 0.905], [-0.25, 0.882],
    [0.3, 0.885], [0.8, 0.925], [1.3, 0.962], [1.62, 0.955], [2.285, 0.9]]),
  // shoulder envelope height (= superellipse top = fender peaks)
  top: monotone([[-2.265, 0.945], [-2.2, 0.962], [-2.05, 0.955], [-1.7, 0.968], [-1.35, 0.975], [-1.0, 0.958], [-0.6, 0.905],
    [0.0, 0.87], [0.6, 0.86], [1.0, 0.85], [1.35, 0.815], [1.6, 0.765], [1.85, 0.69], [2.05, 0.6], [2.2, 0.52], [2.285, 0.45]]),
  // height of the widest point
  yc: monotone([[-2.265, 0.62], [-1.9, 0.62], [-1.35, 0.62], [-0.9, 0.57], [0.0, 0.56], [0.9, 0.58], [1.35, 0.6],
    [1.75, 0.5], [2.285, 0.3]]),
  // bottom (floor / diffuser rising at the rear)
  bot: monotone([[-2.265, 0.32], [-2.1, 0.3], [-1.85, 0.24], [-1.62, 0.16], [-1.45, 0.145], [1.6, 0.135], [2.05, 0.125], [2.285, 0.13]]),
  // superellipse exponents (higher = crisper shoulder)
  nT: monotone([[-2.265, 6.5], [-2.1, 6.8], [-1.7, 6.5], [-1.0, 6.0], [-0.4, 4.2], [0.6, 4.2], [1.35, 6.5], [1.9, 5.0], [2.285, 4.0]]),
  nB: monotone([[-2.265, 5], [-1.6, 4.2], [0, 3.6], [1.6, 4], [2.285, 4.2]]),
  tumble: monotone([[-2.265, 0.03], [-1.35, 0.05], [-0.5, 0.1], [0.6, 0.1], [1.35, 0.045], [2.285, 0.03]]),
  tuck: monotone([[-2.265, 0.05], [-1.6, 0.08], [-0.6, 0.2], [0.6, 0.2], [1.5, 0.1], [2.285, 0.06]]),
  // centerline dip below the shoulder envelope (negative = central hump, e.g. engine cover)
  valley: monotone([[-2.265, 0.004], [-2.12, 0.03], [-1.75, 0.05], [-1.35, 0.058], [-1.1, 0.075], [-0.9, 0.1], [-0.6, 0.12],
    [0.85, 0.12], [1.15, 0.1], [1.6, 0.085], [2.0, 0.05], [2.285, 0.02]]),
  valleyW: monotone([[-2.265, 0.66], [-1.6, 0.64], [-1.0, 0.62], [0, 0.6], [1.3, 0.56], [2.285, 0.62]]),
};

// plan-view rounding of the nose and tail: W *= (1 - u^p)^(1/p)
const FRONT_ROUND_Z = 1.62;
const REAR_ROUND_Z = -2.07;
function endRound(z) {
  if (z > FRONT_ROUND_Z) {
    const u = clamp01((z - FRONT_ROUND_Z) / (Z_FRONT - FRONT_ROUND_Z));
    return Math.pow(Math.max(0, 1 - Math.pow(u, 1.85)), 1 / 1.85);
  }
  if (z < REAR_ROUND_Z) {
    const u = clamp01((REAR_ROUND_Z - z) / (REAR_ROUND_Z - Z_REAR));
    return Math.pow(Math.max(0, 1 - Math.pow(u, 4.6)), 1 / 4.6);
  }
  return 1;
}

// centreline bottom height of the body at z (floor / diffuser)
export function bodyBottomY(z) {
  return P.bot(z);
}

// plan-view half width at z (outline seen from above, before arch flares)
export function planHalfWidth(z) {
  return P.W(z) * endRound(z);
}

// Nose / tail rake: the top of the nose recedes, the tail's lower half tucks forward under the ducktail.
export function warpZ(z, y) {
  if (z > 1.85) {
    const s = (z - 1.85) / (Z_FRONT - 1.85);
    return z - 0.13 * smoothstep(0.16, 0.54, y) * s * s;
  }
  if (z < -1.95) {
    const s = (-1.95 - z) / (-1.95 - Z_REAR);
    return z + 0.07 * (1 - smoothstep(0.32, 0.66, y)) * s * s;
  }
  return z;
}

function sectionParams(z) {
  const top = P.top(z);
  const yc = P.yc(z);
  const bot = P.bot(z);
  return {
    W: P.W(z) * endRound(z),
    yc,
    Ht: Math.max(0.02, top - yc),
    Hb: Math.max(0.02, yc - bot),
    nT: P.nT(z),
    nB: P.nB(z),
    tumble: P.tumble(z),
    tuck: P.tuck(z),
    valley: P.valley(z),
    valleyW: P.valleyW(z),
  };
}

// Outside distance from the tombstone-shaped arch opening (arc on top, vertical sides below the axle).
function tombDist(dz, dy, r) {
  if (dy > 0) return Math.hypot(dz, dy) - r;
  return Math.abs(dz) - r;
}

// Displacement along the section normal: flared arch lips + the rear side-intake scoop.
function displacement(z, y, nx) {
  const side = smoothstep(0.05, 0.55, nx);
  if (side <= 0) return 0;
  let d = 0;
  for (const a of ARCHES) {
    const e = tombDist(z - a.z, y - WHEEL_Y, a.r);
    if (e > -0.01 && e < 0.3) {
      // sharp rolled lip right at the edge + broad fender swell
      d += 0.016 * Math.exp(-(((e - 0.012) / 0.03) ** 2)) + 0.018 * Math.exp(-(((e - 0.06) / 0.11) ** 2)) * smoothstep(-0.05, 0.25, y - WHEEL_Y + 0.25);
    }
  }
  // side intake scoop ahead of the rear wheel: deepest at the back, sharp rear wall
  const zs = z;
  if (zs < -0.18 && zs > -1.02) {
    const fz = smoothstep(-0.18, -0.78, zs) * (1 - smoothstep(-0.9, -0.97, zs));
    const fy = smoothstep(0.33, 0.4, y) * (1 - smoothstep(0.7, 0.77, y));
    d -= 0.095 * fz * fy;
  }
  // door crease: the upper door stands proud of a sharp line rising from the front wheel to the intake
  if (zs > -0.5 && zs < 1.05) {
    const fz = smoothstep(1.05, 0.88, zs) * smoothstep(-0.5, -0.3, zs);
    const yl = 0.565 + 0.085 * (1.0 - zs) / 1.45;
    d += 0.011 * fz * smoothstep(yl - 0.012, yl + 0.012, y) * (1 - smoothstep(yl + 0.08, yl + 0.26, y));
  }
  return d * side;
}

// Dense half-section at z: from the top centre, out over the shoulder, down the side, under to the bottom centre.
// Returns flat arrays (x, y, nx, ny) with displacement applied. Pieces are parameterised so sampling stays uniform.
const N1 = 70;
const N2 = 120;
const N3 = 60;
const DENSE = N1 + N2 + N3;
export function denseHalf(z, out) {
  const q = sectionParams(z);
  const xs = out?.x || new Float64Array(DENSE);
  const ys = out?.y || new Float64Array(DENSE);
  const nxs = out?.nx || new Float64Array(DENSE);
  const nys = out?.ny || new Float64Array(DENSE);
  const kT = Math.pow(0.5, 1 / q.nT);
  const kB = Math.pow(0.5, 1 / q.nB);
  let i = 0;
  const push = (X, Yn) => {
    // X, Yn normalised superellipse coords; Yn in [-1, 1]
    let x;
    let y;
    if (Yn >= 0) {
      x = q.W * X * (1 - q.tumble * Yn * Yn);
      y = q.yc + q.Ht * Yn;
      const xr = q.W > 1e-4 ? x / q.W : 0;
      // flat-bottomed valley with defined walls (hood between raised fenders / central engine-cover hump)
      const prof = q.valley > 0 ? 1 - smoothstep(q.valleyW - 0.2, q.valleyW + 0.14, xr) : Math.exp(-((xr / q.valleyW) ** 2));
      y -= q.valley * prof * Yn ** 4;
    } else {
      x = q.W * X * (1 - q.tuck * Yn * Yn);
      y = q.yc + q.Hb * Yn;
    }
    xs[i] = x;
    ys[i] = y;
    i++;
  };
  for (let k = 0; k < N1; k++) {
    const X = (k / N1) * kT;
    push(X, Math.pow(1 - Math.pow(X, q.nT), 1 / q.nT));
  }
  for (let k = 0; k < N2; k++) {
    const t = k / (N2 - 1);
    const Yn = kT + (-kB - kT) * t;
    const n = Yn >= 0 ? q.nT : q.nB;
    push(Math.pow(Math.max(0, 1 - Math.pow(Math.abs(Yn), n)), 1 / n), Yn);
  }
  for (let k = 1; k <= N3; k++) {
    const X = kB * (1 - k / N3);
    push(X, -Math.pow(1 - Math.pow(X, q.nB), 1 / q.nB));
  }
  // normals (2D, outward): rotate tangent. Points run clockwise when viewed from +Z with x ≥ 0 (top → side → bottom)
  for (let k = 0; k < DENSE; k++) {
    const a = Math.max(0, k - 1);
    const b = Math.min(DENSE - 1, k + 1);
    let tx = xs[b] - xs[a];
    let ty = ys[b] - ys[a];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    nxs[k] = -ty;
    nys[k] = tx;
    if (k === 0) { nxs[k] = 0; nys[k] = 1; }
    if (k === DENSE - 1) { nxs[k] = 0; nys[k] = -1; }
  }
  // displacement along normals
  for (let k = 0; k < DENSE; k++) {
    const dd = displacement(z, ys[k], nxs[k]);
    if (dd !== 0) {
      xs[k] += nxs[k] * dd;
      ys[k] += nys[k] * dd;
    }
  }
  return { x: xs, y: ys, nx: nxs, ny: nys, q };
}

// x of the outermost body surface at height y for (unwarped) station z. NaN if y is outside the section.
const _dh = { x: new Float64Array(DENSE), y: new Float64Array(DENSE), nx: new Float64Array(DENSE), ny: new Float64Array(DENSE) };
export function outerX(z, y) {
  const h = denseHalf(z, _dh);
  let best = NaN;
  for (let k = 0; k < DENSE - 1; k++) {
    const y0 = h.y[k];
    const y1 = h.y[k + 1];
    if ((y0 - y) * (y1 - y) <= 0 && y0 !== y1) {
      const t = (y - y0) / (y1 - y0);
      const x = h.x[k] + (h.x[k + 1] - h.x[k]) * t;
      if (!(x <= best)) best = x;
    }
  }
  return best;
}

// Resample a dense half curve to M+1 points at FIXED dense-index positions (identical for every station), so
// grid lines run consistently along the body and glossy reflections stay smooth. Extra density at the corners.
const _mapCache = new Map();
function sampleMap(M) {
  if (_mapCache.has(M)) return _mapCache.get(M);
  const n = DENSE;
  const rho = (d) => 1
    + 0.9 * Math.exp(-(((d - N1) / 16) ** 2)) // shoulder corner
    + 0.6 * Math.exp(-(((d - (N1 + N2)) / 14) ** 2)) // lower corner
    - 0.55 * smoothstep(N1 + N2 + 10, N1 + N2 + 30, d); // underside needs few samples
  const cum = [0];
  for (let d = 1; d < n; d++) cum.push(cum[d - 1] + 0.5 * (rho(d - 1) + rho(d)));
  const total = cum[n - 1];
  const out = new Float64Array(M + 1);
  let j = 1;
  for (let m = 0; m <= M; m++) {
    const target = (m / M) * total;
    while (j < n - 1 && cum[j] < target) j++;
    out[m] = j - 1 + clamp01((target - cum[j - 1]) / (cum[j] - cum[j - 1] || 1));
  }
  out[M] = n - 1;
  _mapCache.set(M, out);
  return out;
}
function resampleHalf(h, M, out, base) {
  const n = DENSE;
  const al = new Float64Array(n);
  for (let k = 1; k < n; k++) al[k] = al[k - 1] + Math.hypot(h.x[k] - h.x[k - 1], h.y[k] - h.y[k - 1]);
  const map = sampleMap(M);
  for (let m = 0; m <= M; m++) {
    const f = map[m];
    const k0 = Math.min(n - 2, Math.floor(f));
    const t = f - k0;
    const o = (base + m) * 4;
    out[o] = h.x[k0] + (h.x[k0 + 1] - h.x[k0]) * t;
    out[o + 1] = h.y[k0] + (h.y[k0 + 1] - h.y[k0]) * t;
    out[o + 2] = al[k0] + (al[k0 + 1] - al[k0]) * t; // true arc length from the top centre
    out[o + 3] = h.nx[k0] + (h.nx[k0 + 1] - h.nx[k0]) * t;
  }
}

function stationList(spacing = 0.034) {
  const dens = (z) => {
    let d = 1 + 2.2 * Math.exp(-(((z - Z_FRONT) / 0.12) ** 2)) + 2.2 * Math.exp(-(((z - Z_REAR) / 0.12) ** 2));
    d += 6 * Math.exp(-(((z - Z_FRONT) / 0.02) ** 2)) + 6 * Math.exp(-(((z - Z_REAR) / 0.02) ** 2));
    for (const a of ARCHES) d += 1.6 * Math.exp(-(((Math.abs(z - a.z) - a.r) / 0.05) ** 2));
    d += 1.2 * Math.exp(-(((z + 0.94) / 0.06) ** 2)); // scoop rear wall
    return d / spacing;
  };
  const steps = 4000;
  const cum = [0];
  for (let i = 1; i <= steps; i++) {
    const z0 = Z_REAR + ((i - 1) / steps) * BODY_LEN;
    const z1 = Z_REAR + (i / steps) * BODY_LEN;
    cum.push(cum[i - 1] + 0.5 * (dens(z0) + dens(z1)) * (z1 - z0));
  }
  const total = cum[steps];
  const count = Math.round(total);
  const zs = [];
  let j = 0;
  for (let k = 0; k <= count; k++) {
    const target = (k / count) * total;
    while (j < steps && cum[j + 1] < target) j++;
    const t = (target - cum[j]) / (cum[j + 1] - cum[j] || 1);
    zs.push(Z_REAR + ((j + clamp01(t)) / steps) * BODY_LEN);
  }
  zs[0] = Z_REAR;
  zs[zs.length - 1] = Z_FRONT;
  return zs;
}

// ---------------------------------------------------------------------------------------------
// Body shell
// ---------------------------------------------------------------------------------------------
export function buildBodyShell({ M = 56, spacing = 0.034, uvScale = 0 } = {}) {
  const zs = stationList(spacing);
  const S = zs.length;
  const R = 2 * M + 1;
  const half = new Float64Array(S * (M + 1) * 4);
  const cornerArc = new Float64Array(S); // arc length where the bottom surface starts (for UV compression)
  for (let i = 0; i < S; i++) {
    const h = denseHalf(zs[i], _dh);
    resampleHalf(h, M, half, i * (M + 1));
    // arc length to start of piece 3 (bottom)
    let arc = 0;
    for (let k = 1; k < N1 + N2; k++) arc += Math.hypot(h.x[k] - h.x[k - 1], h.y[k] - h.y[k - 1]);
    cornerArc[i] = arc;
  }
  // UV v: arc from the top centre, compressed beyond the bottom corner (the floor is plain dark)
  const gArc = (s, i) => (s <= cornerArc[i] ? s : cornerArc[i] + (s - cornerArc[i]) * 0.12);
  let gMax = 0;
  for (let i = 0; i < S; i++) gMax = Math.max(gMax, gArc(half[(i * (M + 1) + M) * 4 + 2], i));
  const UV_S = uvScale || 2 * gMax / 0.94; // v ∈ [0.03, 0.97]; strips beyond hold solid swatches

  const pos = new Float32Array(S * R * 3);
  const uv = new Float32Array(S * R * 2);
  const nx2 = new Float32Array(S * R);
  for (let i = 0; i < S; i++) {
    for (let j = 0; j < R; j++) {
      const left = j >= M;
      const k = left ? j - M : M - j;
      const o = (i * (M + 1) + k) * 4;
      const x = half[o] * (left ? 1 : -1);
      const y = half[o + 1];
      const z = warpZ(zs[i], y);
      const vi = i * R + j;
      pos[vi * 3] = x;
      pos[vi * 3 + 1] = y;
      pos[vi * 3 + 2] = z;
      uv[vi * 2] = (zs[i] - Z_REAR) / BODY_LEN;
      uv[vi * 2 + 1] = 0.5 + (left ? 1 : -1) * gArc(half[o + 2], i) / UV_S;
      nx2[vi] = half[o + 3];
    }
  }

  // ---- arch cut: drop triangles inside the tombstone tunnels, snap boundary vertices onto the cut surface
  const archOf = (x, y, z) => {
    for (let a = 0; a < ARCHES.length; a++) {
      const A = ARCHES[a];
      if (Math.abs(x) > A.xInner && tombDist(z - A.z, y - WHEEL_Y, A.r) < 0) return a;
    }
    return -1;
  };
  const inside = new Int8Array(S * R);
  for (let v = 0; v < S * R; v++) inside[v] = archOf(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
  const idx = [];
  const snap = new Uint8Array(S * R);
  for (let i = 0; i < S - 1; i++) {
    for (let j = 0; j < R - 1; j++) {
      const a = i * R + j;
      const b = a + 1;
      const c = a + R;
      const d = c + 1;
      for (const tri of [[a, c, b], [b, c, d]]) {
        const n = (inside[tri[0]] >= 0) + (inside[tri[1]] >= 0) + (inside[tri[2]] >= 0);
        if (n === 3) continue;
        // skip degenerate triangles at the pinched tips
        idx.push(tri[0], tri[1], tri[2]);
        if (n > 0) for (const t of tri) if (inside[t] >= 0) snap[t] = 1;
      }
    }
  }
  for (let v = 0; v < S * R; v++) {
    if (!snap[v]) continue;
    const A = ARCHES[inside[v]];
    let x = pos[v * 3];
    let y = pos[v * 3 + 1];
    let z = pos[v * 3 + 2];
    const dz = z - A.z;
    const dy = y - WHEEL_Y;
    const dT = -tombDist(dz, dy, A.r);
    const dX = Math.abs(x) - A.xInner;
    if (dX < dT) {
      x = Math.sign(x) * A.xInner;
    } else {
      if (dy > 0) {
        const r = Math.hypot(dz, dy) || 1e-6;
        z = A.z + (dz / r) * A.r;
        y = WHEEL_Y + (dy / r) * A.r;
      } else {
        z = A.z + Math.sign(dz || 1) * A.r;
      }
      if (Math.abs(nx2[v]) > 0.35) {
        const ox = outerX(z, y);
        if (Number.isFinite(ox)) x = Math.sign(x) * ox;
      }
    }
    pos[v * 3] = x;
    pos[v * 3 + 1] = y;
    pos[v * 3 + 2] = z;
    uv[v * 2] = (z - Z_REAR) / BODY_LEN;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  // lookup helpers for texture layout: arc length (UV v) at a given (z, y) on the side or (z, x) on the top
  const stationIndex = (z) => {
    let lo = 0;
    let hi = S - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (zs[mid] > z) hi = mid; else lo = mid; }
    return lo;
  };
  const vAt = (z, sel) => {
    // sel(k, o) returns true for the half-sample at which to read; we interpolate linearly along samples
    const i = stationIndex(z);
    return [i, Math.min(S - 1, i + 1)].map((ii) => sel(ii));
  };
  const vSideAtY = (z, y, left = true) => {
    const r = vAt(z, (i) => {
      // outermost crossing of height y
      let best = null;
      for (let k = 0; k < M; k++) {
        const o0 = (i * (M + 1) + k) * 4;
        const o1 = o0 + 4;
        const y0 = half[o0 + 1];
        const y1 = half[o1 + 1];
        if ((y0 - y) * (y1 - y) <= 0 && y0 !== y1) {
          const t = (y - y0) / (y1 - y0);
          const x = half[o0] + (half[o1] - half[o0]) * t;
          const s = half[o0 + 2] + (half[o1 + 2] - half[o0 + 2]) * t;
          if (!best || x > best.x) best = { x, s };
        }
      }
      return best ? gArc(best.s, i) : NaN;
    });
    const i = stationIndex(z);
    const t = clamp01((z - zs[i]) / ((zs[Math.min(S - 1, i + 1)] - zs[i]) || 1));
    const g = r[0] + (r[1] - r[0]) * t;
    return 0.5 + (left ? 1 : -1) * g / UV_S;
  };
  const vTopAtX = (z, x) => {
    const ax = Math.abs(x);
    const r = vAt(z, (i) => {
      for (let k = 0; k < M; k++) {
        const o0 = (i * (M + 1) + k) * 4;
        const o1 = o0 + 4;
        if (half[o0] <= ax && half[o1] >= ax && half[o1] > half[o0]) {
          const t = (ax - half[o0]) / (half[o1] - half[o0]);
          return half[o0 + 2] + (half[o1 + 2] - half[o0 + 2]) * t;
        }
      }
      return NaN;
    });
    const i = stationIndex(z);
    const t = clamp01((z - zs[i]) / ((zs[Math.min(S - 1, i + 1)] - zs[i]) || 1));
    const g = r[0] + (r[1] - r[0]) * t;
    return 0.5 + (x >= 0 ? 1 : -1) * g / UV_S;
  };
  const uAtZ = (z) => (z - Z_REAR) / BODY_LEN;

  return { geometry: geo, stations: zs, M, uvScale: UV_S, vSideAtY, vTopAtX, uAtZ, cornerArc };
}

// ---------------------------------------------------------------------------------------------
// Axis-aligned surface caster: drape details onto any mesh geometry along ±X / ±Y / ±Z.
// ---------------------------------------------------------------------------------------------
const AXES = { x: [1, 2, 0], y: [2, 0, 1], z: [0, 1, 2] }; // [plane a, plane b, depth axis] component indices
export class SurfaceCaster {
  constructor(geometry, cell = 0.04) {
    this.geo = geometry.index ? geometry : geometry;
    this.pos = geometry.attributes.position.array;
    this.nrm = geometry.attributes.normal?.array;
    this.uv = geometry.attributes.uv?.array;
    this.index = geometry.index ? geometry.index.array : null;
    this.triCount = this.index ? this.index.length / 3 : this.pos.length / 9;
    this.cell = cell;
    this.grids = {};
  }
  _tri(t, k) {
    return this.index ? this.index[t * 3 + k] : t * 3 + k;
  }
  _grid(axis) {
    if (this.grids[axis]) return this.grids[axis];
    const [ia, ib] = AXES[axis];
    const p = this.pos;
    let minA = Infinity, minB = Infinity, maxA = -Infinity, maxB = -Infinity;
    for (let v = 0; v < p.length; v += 3) {
      minA = Math.min(minA, p[v + ia]); maxA = Math.max(maxA, p[v + ia]);
      minB = Math.min(minB, p[v + ib]); maxB = Math.max(maxB, p[v + ib]);
    }
    const cs = this.cell;
    const na = Math.max(1, Math.ceil((maxA - minA) / cs) + 1);
    const nb = Math.max(1, Math.ceil((maxB - minB) / cs) + 1);
    const cells = Array.from({ length: na * nb }, () => []);
    for (let t = 0; t < this.triCount; t++) {
      const v0 = this._tri(t, 0) * 3;
      const v1 = this._tri(t, 1) * 3;
      const v2 = this._tri(t, 2) * 3;
      const a0 = Math.floor((Math.min(p[v0 + ia], p[v1 + ia], p[v2 + ia]) - minA) / cs);
      const a1 = Math.floor((Math.max(p[v0 + ia], p[v1 + ia], p[v2 + ia]) - minA) / cs);
      const b0 = Math.floor((Math.min(p[v0 + ib], p[v1 + ib], p[v2 + ib]) - minB) / cs);
      const b1 = Math.floor((Math.max(p[v0 + ib], p[v1 + ib], p[v2 + ib]) - minB) / cs);
      for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) cells[a * nb + b].push(t);
    }
    return (this.grids[axis] = { minA, minB, na, nb, cells });
  }
  // Ray along `axis` coming from the `dir` side (dir=+1: from +∞ travelling toward −∞; returns the max-depth hit).
  // a, b = coordinates in the plane (for 'z': x,y; for 'x': z... see AXES ordering: x→(y,z)? no: x → (ia=1:y, ib=2:z)).
  cast(axis, dir, a, b, out = {}) {
    const g = this._grid(axis);
    const [ia, ib, id] = AXES[axis];
    const ca = Math.floor((a - g.minA) / this.cell);
    const cb = Math.floor((b - g.minB) / this.cell);
    if (ca < 0 || cb < 0 || ca >= g.na || cb >= g.nb) return null;
    const list = g.cells[ca * g.nb + cb];
    const p = this.pos;
    let best = null;
    let bestD = -Infinity;
    for (const t of list) {
      const i0 = this._tri(t, 0);
      const i1 = this._tri(t, 1);
      const i2 = this._tri(t, 2);
      const ax = p[i0 * 3 + ia], ay = p[i0 * 3 + ib];
      const bx = p[i1 * 3 + ia], by = p[i1 * 3 + ib];
      const cx = p[i2 * 3 + ia], cy = p[i2 * 3 + ib];
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(det) < 1e-12) continue;
      const l0 = ((by - cy) * (a - cx) + (cx - bx) * (b - cy)) / det;
      const l1 = ((cy - ay) * (a - cx) + (ax - cx) * (b - cy)) / det;
      const l2 = 1 - l0 - l1;
      if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
      const depth = l0 * p[i0 * 3 + id] + l1 * p[i1 * 3 + id] + l2 * p[i2 * 3 + id];
      const sd = depth * dir;
      if (sd > bestD) {
        bestD = sd;
        best = { i0, i1, i2, l0, l1, l2, depth };
      }
    }
    if (!best) return null;
    const point = out.point || new THREE.Vector3();
    const normal = out.normal || new THREE.Vector3();
    const comp = [0, 0, 0];
    comp[ia] = a;
    comp[ib] = b;
    comp[id] = best.depth;
    point.set(comp[0], comp[1], comp[2]);
    if (this.nrm) {
      const n = this.nrm;
      normal.set(
        best.l0 * n[best.i0 * 3] + best.l1 * n[best.i1 * 3] + best.l2 * n[best.i2 * 3],
        best.l0 * n[best.i0 * 3 + 1] + best.l1 * n[best.i1 * 3 + 1] + best.l2 * n[best.i2 * 3 + 1],
        best.l0 * n[best.i0 * 3 + 2] + best.l1 * n[best.i1 * 3 + 2] + best.l2 * n[best.i2 * 3 + 2],
      ).normalize();
    }
    let uvOut = null;
    if (this.uv) {
      const u = this.uv;
      uvOut = [
        best.l0 * u[best.i0 * 2] + best.l1 * u[best.i1 * 2] + best.l2 * u[best.i2 * 2],
        best.l0 * u[best.i0 * 2 + 1] + best.l1 * u[best.i1 * 2 + 1] + best.l2 * u[best.i2 * 2 + 1],
      ];
    }
    return { point, normal, uv: uvOut };
  }
  // Convenience: world-like helpers
  topY(x, z) { const h = this.cast('y', 1, z, x); return h ? h.point.y : NaN; } // y-axis plane = (z, x)
  frontZ(x, y) { const h = this.cast('z', 1, x, y); return h ? h.point.z : NaN; }
  rearZ(x, y) { const h = this.cast('z', -1, x, y); return h ? h.point.z : NaN; }
  sideX(y, z, left = true) { const h = this.cast('x', left ? 1 : -1, y, z); return h ? h.point.x : NaN; }
}

// Plane coordinate convention for SurfaceCaster.cast(axis, dir, a, b):
//   axis 'x' → (a, b) = (y, z);  axis 'y' → (a, b) = (z, x);  axis 'z' → (a, b) = (x, y).
export function planeToVec(axis, a, b, depth, out = new THREE.Vector3()) {
  if (axis === 'x') return out.set(depth, a, b);
  if (axis === 'y') return out.set(b, depth, a);
  return out.set(a, b, depth);
}

// Build a patch draped on a surface. grid(u, v) → [a, b] in the plane coords of `axis`.
// Rays that miss drop their triangles. `offset` lifts the patch along the surface normal (avoid z-fighting).
export function drapePatch(caster, axis, dir, grid, nu, nv, { offset = 0.003, uvFn = null, flip = false } = {}) {
  const pos = [];
  const nrm = [];
  const uvs = [];
  const ok = [];
  const hit = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const [a, b] = grid(i / nu, j / nv);
      const h = caster.cast(axis, dir, a, b, hit);
      if (h) {
        const p = h.point.clone().addScaledVector(h.normal, offset);
        pos.push(p.x, p.y, p.z);
        nrm.push(h.normal.x, h.normal.y, h.normal.z);
        ok.push(1);
      } else {
        pos.push(0, 0, 0);
        nrm.push(0, 1, 0);
        ok.push(0);
      }
      const uvv = uvFn ? uvFn(i / nu, j / nv) : [i / nu, j / nv];
      uvs.push(uvv[0], uvv[1]);
    }
  }
  const idx = [];
  const W = nu + 1;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * W + i;
      const b = a + 1;
      const c = a + W;
      const d = c + 1;
      if (!(ok[a] && ok[b] && ok[c] && ok[d])) continue;
      idx.push(a, b, d, a, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  // make winding agree with the normal
  fixWinding(geo, flip);
  return geo;
}

// Ensure each triangle's winding matches its vertex normals (so FrontSide rendering works for draped parts).
export function fixWinding(geo, flip = false) {
  const p = geo.attributes.position.array;
  const n = geo.attributes.normal.array;
  const idx = geo.index.array;
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const fn = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    e1.set(p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]);
    e2.set(p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]);
    fn.crossVectors(e1, e2);
    const dot = fn.x * (n[a * 3] + n[b * 3] + n[c * 3]) + fn.y * (n[a * 3 + 1] + n[b * 3 + 1] + n[c * 3 + 1]) + fn.z * (n[a * 3 + 2] + n[b * 3 + 2] + n[c * 3 + 2]);
    if ((dot < 0) !== flip) { idx[t + 1] = c; idx[t + 2] = b; }
  }
  geo.index.needsUpdate = true;
}

// Tube following a 2D polyline draped onto the surface (light pipes, trim lines).
export function drapeTube(caster, axis, dir, path2D, radius, { offset = 0.004, radial = 6, closed = false, samples = 0 } = {}) {
  const pts = [];
  const hit = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
  for (const [a, b] of path2D) {
    const h = caster.cast(axis, dir, a, b, hit);
    if (h) pts.push(h.point.clone().addScaledVector(h.normal, offset + radius * 0.6));
  }
  if (pts.length < 2) return null;
  const curve = new THREE.CatmullRomCurve3(pts, closed, 'centripetal');
  return new THREE.TubeGeometry(curve, samples || Math.max(8, Math.round(pts.length * 1.6)), radius, radial, closed);
}

// ---------------------------------------------------------------------------------------------
// Greenhouse (cabin): separate loft sitting on the body, split into glass / black trim / paint regions.
// ---------------------------------------------------------------------------------------------
export const GH = {
  zFront: 1.13,
  zRear: -1.32,
  zShieldTop: 0.2, // windshield → roof
  zWinRear: -0.6, // side window rear edge
  zRoofRear: -0.7, // roof → rear glass
  zGlassRear: -1.2, // rear glass end
  pBelt: 0.03,
  pWin: 0.6,
  pA: 0.69,
};
const GHP = {
  roof: monotone([[-1.32, 0.94], [-1.0, 1.05], [-0.7, 1.138], [-0.4, 1.192], [-0.12, 1.215], [0.12, 1.206], [0.35, 1.172],
    [0.6, 1.085], [0.88, 0.955], [1.13, 0.80]]),
  Wg: monotone([[-1.32, 0.42], [-1.0, 0.585], [-0.7, 0.69], [-0.3, 0.742], [0.3, 0.748], [0.8, 0.722], [1.13, 0.685]]),
  lean: monotone([[-1.32, 0.16], [-0.7, 0.2], [0.2, 0.2], [1.13, 0.18]]),
  m: monotone([[-1.32, 3.4], [-0.4, 3.1], [0.6, 3.1], [1.13, 3.2]]),
};

function ghStations() {
  const marks = [GH.zFront, GH.zShieldTop, GH.zWinRear, GH.zRoofRear, GH.zGlassRear, GH.zRear];
  const zs = [];
  const n = 78;
  for (let i = 0; i <= n; i++) {
    // denser near the windshield base where the cabin rises quickly
    const t = i / n;
    const tt = 1 - Math.pow(1 - t, 1.25);
    zs.push(GH.zFront + (GH.zRear - GH.zFront) * tt);
  }
  for (const m of marks) zs.push(m);
  zs.sort((a, b) => b - a);
  const out = [];
  for (const z of zs) if (!out.length || Math.abs(out[out.length - 1] - z) > 0.006) out.push(z);
  for (const m of marks) {
    // snap the closest station exactly onto each mark
    let bi = 0;
    for (let i = 1; i < out.length; i++) if (Math.abs(out[i] - m) < Math.abs(out[bi] - m)) bi = i;
    out[bi] = m;
  }
  return out; // descending z (front → rear)
}

function ghParams() {
  const ps = [0];
  const add = (a, b, n) => { for (let i = 1; i <= n; i++) ps.push(a + ((b - a) * i) / n); };
  add(0, GH.pBelt, 2);
  add(GH.pBelt, GH.pWin, 13);
  add(GH.pWin, GH.pA, 3);
  add(GH.pA, 1, 11);
  return ps;
}

export function ghRegion(z, p) {
  // returns 'glass' | 'trim' | 'paint'
  if (z > GH.zWinRear) {
    if (p < GH.pBelt) return 'trim';
    if (p < GH.pWin) return 'glass';
    if (p < GH.pA) return 'trim';
    if (z > GH.zShieldTop) return 'glass';
    return 'paint';
  }
  if (p < GH.pA) return 'paint';
  if (z > GH.zRoofRear) return 'trim';
  if (z > GH.zGlassRear) return 'glass';
  return 'paint';
}

// Greenhouse section point. bodyTop(x, z) gives the body's top surface height.
function ghPoint(z, p, bodyTop, inset = 0) {
  const roof = GHP.roof(z);
  const Wg = GHP.Wg(z) - inset;
  const lean = GHP.lean(z);
  const m = GHP.m(z);
  const B0 = bodyTop(0, z) - 0.012;
  const Hg = Math.max(0, roof - inset - B0);
  const al = (p * Math.PI) / 2;
  const X = Math.pow(Math.cos(al), 2 / m);
  const Y = Math.pow(Math.sin(al), 2 / m);
  const yh = Hg * Y;
  const x = Wg * X * (1 - lean * Y);
  const base = bodyTop(x, z) - 0.012;
  const s = smoothstep(0, 0.5, p);
  const y = B0 + yh + (Number.isFinite(base) ? (base - B0) * (1 - s) : 0) - inset * 0.5 * Y;
  return [x, y];
}

export function buildGreenhouse(bodyCaster, uvScale, { inset = 0 } = {}) {
  const zs = ghStations();
  const ps = ghParams();
  const Ph = ps.length; // samples per half (0..1)
  const R = 2 * Ph - 1; // ring: left base → top → right base
  const S = zs.length;
  const bodyTop = (x, z) => {
    const y = bodyCaster.topY(x, z);
    return Number.isFinite(y) ? y : 0.8;
  };
  const pos = new Float32Array(S * R * 3);
  const uv = new Float32Array(S * R * 2);
  const pr = new Float32Array(S * R); // p value per vertex
  for (let i = 0; i < S; i++) {
    const z = zs[i];
    const half = ps.map((p) => ghPoint(z, p, bodyTop, inset));
    // arc lengths from the roof centre (p=1) downwards
    const arc = new Array(Ph).fill(0);
    for (let k = Ph - 2; k >= 0; k--) arc[k] = arc[k + 1] + Math.hypot(half[k][0] - half[k + 1][0], half[k][1] - half[k + 1][1]);
    for (let j = 0; j < R; j++) {
      const left = j < Ph; // j=0 left base ... j=Ph-1 top ... j=R-1 right base
      const k = left ? j : R - 1 - j;
      const [x, y] = half[k];
      const vi = i * R + j;
      pos[vi * 3] = left ? x : -x;
      pos[vi * 3 + 1] = y;
      pos[vi * 3 + 2] = z;
      uv[vi * 2] = (z - Z_REAR) / BODY_LEN;
      uv[vi * 2 + 1] = 0.5 + (left ? 1 : -1) * arc[k] / uvScale;
      pr[vi] = ps[k];
    }
  }
  // triangles grouped by region
  const groups = { glass: [], trim: [], paint: [] };
  for (let i = 0; i < S - 1; i++) {
    for (let j = 0; j < R - 1; j++) {
      const a = i * R + j;
      const b = a + 1;
      const c = a + R;
      const d = c + 1;
      const zc = (zs[i] + zs[i + 1]) / 2;
      const pc = (pr[a] + pr[b]) / 2;
      const reg = ghRegion(zc, pc);
      // stations descend in z; ring j goes +X → top → −X. Outward winding: (a, c, b), (b, c, d)
      groups[reg].push(a, c, b, b, c, d);
    }
  }
  const all = [...groups.glass, ...groups.trim, ...groups.paint];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(all);
  geo.computeVertexNormals();
  const make = (list) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', geo.attributes.position);
    g.setAttribute('normal', geo.attributes.normal);
    g.setAttribute('uv', geo.attributes.uv);
    g.setIndex(list);
    return compactIndexed(g);
  };
  return { full: geo, glass: make(groups.glass), trim: make(groups.trim), paint: make(groups.paint), stations: zs, params: ps };
}

// Re-pack an indexed geometry so it only contains referenced vertices (keeps merges small).
export function compactIndexed(g) {
  const idx = g.index.array;
  const map = new Map();
  const attrs = Object.keys(g.attributes);
  const out = {};
  for (const k of attrs) out[k] = [];
  const nidx = [];
  for (let t = 0; t < idx.length; t++) {
    const v = idx[t];
    let nv = map.get(v);
    if (nv === undefined) {
      nv = map.size;
      map.set(v, nv);
      for (const k of attrs) {
        const a = g.attributes[k];
        for (let c = 0; c < a.itemSize; c++) out[k].push(a.array[v * a.itemSize + c]);
      }
    }
    nidx.push(nv);
  }
  const ng = new THREE.BufferGeometry();
  for (const k of attrs) ng.setAttribute(k, new THREE.Float32BufferAttribute(out[k], g.attributes[k].itemSize));
  ng.setIndex(nidx);
  return ng;
}
