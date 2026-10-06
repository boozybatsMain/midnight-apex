// MIDNIGHT APEX — track centerline math (pure, Node-safe: no DOM / WebGL).
//
// The circuit is authored as a closed polyline of street-corner points, each corner filleted with a
// circular arc of a chosen radius (exactly like real city streets: straights + constant-radius corners).
// The piecewise-constant curvature is lightly smoothed (≈ clothoid entries/exits), re-integrated into
// heading/position in fine steps, closed exactly, and resampled uniformly every ~1 m into
// position / heading / curvature tables that every query uses.
//
// Map orientation used in comments: +X = east, +Z = south (top-down view with X right, Z down).
// Driving direction is clockwise on that map (mostly right-hand turns). s = 0 is the start/finish line.
import * as THREE from 'three';
import { CONFIG, wrapAngle } from '../config.js';

// [x, z, radius] — corner points in driving order. Consecutive points are joined by straights.
export const CORNERS = [
  [-330, 0, 40], //   C0  N → E   onto the start/finish boulevard
  [300, 0, 38], //    C1  E → S   T1 — heavy braking at the end of the boulevard
  [300, 150, 34], //  C2  S → E   T2 (left) — city block sequence
  [430, 150, 34], //  C3  E → S   T3
  [430, 420, 44], //  C4  S → W   T4 onto the waterfront drive
  [335, 420, 30], //  C5  chicane: right flick
  [295, 394, 30], //  C6  chicane: left
  [255, 420, 30], //  C7  chicane: right, back onto the waterfront line
  [120, 420, 260], // C8  fast waterfront sweeper (right 30°)
  [-10, 345, 260], // C9  … and back left 30° (flat-out S)
  [-450, 345, 44], // C10 W → N   onto Harbor Ave
  [-450, 215, 36], // C11 N → E   inner street
  [-75, 215, 26], //  C12 E → N   hairpin (left) …
  [-75, 145, 26], //  C13 N → W   … hairpin exit
  [-330, 145, 36], // C14 W → N   last corner before the boulevard
];

const START_INTO_STRAIGHT = 150; // start line distance (m) after the end of corner C0's arc
const SMOOTH = 9; // curvature smoothing half-window (m) → short clothoid-like transitions
const FINE_DS = 0.25;
const GRID_LATERAL = 3.6; // start grid columns (± m from centerline)
const GRID_FIRST = 9; // pole position distance behind the line (m)
const GRID_PITCH = 6.5; // distance between consecutive (staggered) slots (m)
const LAMP_TARGET_SPACING = 31;
const LAMP_HEAD_U = 7.3; // lateral position of the luminaire (over the road edge)
const LAMP_HEAD_H = 8.8; // luminaire height
const LAMP_POLE_U = 10.6; // pole on the sidewalk

const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------

function filletCorners(corners) {
  const n = corners.length;
  const fillets = [];
  for (let i = 0; i < n; i++) {
    const [px, pz] = corners[(i - 1 + n) % n];
    const [cx, cz, R] = corners[i];
    const [nx, nz] = corners[(i + 1) % n];
    let d0x = cx - px, d0z = cz - pz, d1x = nx - cx, d1z = nz - cz;
    const l0 = Math.hypot(d0x, d0z), l1 = Math.hypot(d1x, d1z);
    d0x /= l0; d0z /= l0; d1x /= l1; d1z /= l1;
    const theta = Math.atan2(d0x * d1z - d0z * d1x, d0x * d1x + d0z * d1z); // + = right turn
    const t = R * Math.tan(Math.abs(theta) / 2); // tangent length of the fillet
    fillets.push({ x: cx, z: cz, theta, R, t, l1, d0x, d0z, d1x, d1z });
  }
  // Program of [length, curvature, cornerIndex] pieces starting at the end of corner 0's arc.
  const pieces = [];
  const problems = [];
  for (let k = 0; k < n; k++) {
    const i = k % n, j = (k + 1) % n;
    const f = fillets[i], g = fillets[j];
    const straight = f.l1 - f.t - g.t;
    if (straight < -1e-6) problems.push(`corners ${i}->${j} overlap by ${(-straight).toFixed(1)} m`);
    pieces.push([Math.max(0, straight), 0, -1]);
    pieces.push([Math.abs(g.theta) * g.R, Math.sign(g.theta) / g.R, j]);
  }
  // Start state: on the straight after corner 0, START_INTO_STRAIGHT meters past its arc end.
  const f0 = fillets[0];
  const into = Math.min(START_INTO_STRAIGHT, pieces[0][0] * 0.5);
  pieces[0][0] -= into; // the remaining part of that straight comes first…
  pieces.push([into, 0, -1]); // …and the piece before the line closes the loop.
  const start = {
    x: f0.x + f0.d1x * (f0.t + into),
    z: f0.z + f0.d1z * (f0.t + into),
    h: Math.atan2(f0.d1x, f0.d1z),
  };
  return { pieces, start, problems, fillets };
}

function integrate(pieces, start, smooth) {
  const total = pieces.reduce((a, p) => a + p[0], 0);
  const M = Math.round(total / FINE_DS);
  const ds = total / M;
  // Cell-averaged curvature (exact integral of the piecewise-constant program per cell → exact total turn).
  const k = new Float64Array(M);
  let pi = 0, p0 = 0;
  for (let i = 0; i < M; i++) {
    const a = i * ds, b = a + ds;
    let acc = 0;
    let q = pi, q0 = p0;
    while (q < pieces.length && q0 < b) {
      const q1 = q0 + pieces[q][0];
      const lo = Math.max(a, q0), hi = Math.min(b, q1);
      if (hi > lo) acc += (hi - lo) * pieces[q][1];
      if (q1 <= b) { q0 = q1; q++; pi = q; p0 = q0; } else break;
    }
    k[i] = acc / ds;
  }
  // Periodic box filter applied twice (triangular kernel) — preserves the total turning exactly.
  let ks = k;
  const w = Math.max(1, Math.round(smooth / ds));
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float64Array(M);
    let sum = 0;
    for (let j = -w; j <= w; j++) sum += ks[(j + M) % M];
    for (let i = 0; i < M; i++) {
      out[i] = sum / (2 * w + 1);
      sum += ks[(i + w + 1) % M] - ks[(i - w + M) % M];
    }
    ks = out;
  }
  // Integrate heading (κ > 0 → right turn → heading decreases) and position (midpoint rule).
  const x = new Float64Array(M + 1), z = new Float64Array(M + 1), h = new Float64Array(M + 1);
  x[0] = start.x; z[0] = start.z; h[0] = start.h;
  for (let i = 0; i < M; i++) {
    const hm = h[i] - ks[i] * ds * 0.5;
    x[i + 1] = x[i] + Math.sin(hm) * ds;
    z[i + 1] = z[i] + Math.cos(hm) * ds;
    h[i + 1] = h[i] - ks[i] * ds;
  }
  // Distribute the (tiny) closure error linearly along the loop.
  const ex = x[M] - x[0], ez = z[M] - z[0];
  for (let i = 0; i <= M; i++) { x[i] -= (ex * i) / M; z[i] -= (ez * i) / M; }
  return { x, z, h, k: ks, M, ds, total, closure: Math.hypot(ex, ez), turn: h[M] - h[0] };
}

/** Build the uniformly resampled centerline tables (exported for tests / tooling). */
export function buildCenterline(corners = CORNERS, { smooth = SMOOTH, spacing = 1 } = {}) {
  const prog = filletCorners(corners);
  const fine = integrate(prog.pieces, prog.start, smooth);
  const length = fine.total;
  const N = Math.max(16, Math.round(length / spacing));
  const ds = length / N;
  const px = new Float64Array(N), pz = new Float64Array(N), hd = new Float64Array(N), kap = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const f = (i * ds) / fine.ds;
    const j = Math.min(fine.M - 1, Math.floor(f)), t = f - j;
    px[i] = fine.x[j] + (fine.x[j + 1] - fine.x[j]) * t;
    pz[i] = fine.z[j] + (fine.z[j + 1] - fine.z[j]) * t;
    hd[i] = fine.h[j] + (fine.h[j + 1] - fine.h[j]) * t;
    const ja = Math.round(f - 0.5);
    const jb = Math.min(fine.M - 1, Math.max(0, ja)), jc = Math.min(fine.M - 1, jb + 1);
    kap[i] = (fine.k[jb] + fine.k[jc]) * 0.5;
  }
  // Corner arcs along s (raw, unsmoothed extents).
  const corners_s = [];
  let s = 0;
  for (const [len, kk, ci] of prog.pieces) {
    if (ci >= 0) {
      const f = prog.fillets[ci];
      corners_s.push({ index: ci, s0: s, s1: s + len, apex: s + len / 2, kappa: kk, radius: f.R, angle: f.theta, x: f.x, z: f.z, d0: [f.d0x, f.d0z], d1: [f.d1x, f.d1z] });
    }
    s += len;
  }
  return { px, pz, hd, kap, N, ds, length, problems: prog.problems, closure: fine.closure, turn: fine.turn, corners: corners_s };
}

// ---------------------------------------------------------------------------------------------
// Derived features (junctions, side streets, lamps, kerbs) — shared by the road shader & environment.
// ---------------------------------------------------------------------------------------------

function nearestSample(c, x, z, skipS, skipRange) {
  let md = Infinity, mi = -1;
  for (let i = 0; i < c.N; i += 2) {
    if (skipS !== undefined) {
      let d = Math.abs(i * c.ds - skipS);
      d = Math.min(d, c.length - d);
      if (d < skipRange) continue;
    }
    const d = (c.px[i] - x) ** 2 + (c.pz[i] - z) ** 2;
    if (d < md) { md = d; mi = i; }
  }
  return { d: Math.sqrt(md), i: mi };
}

/**
 * Shoreline of the bay south of the waterfront drive: water where z > shoreZ(x).
 * Follows the waterfront section of the circuit at a fixed offset (promenade + quay).
 */
function buildShoreline(c) {
  const X0 = -4000, STEP = 5, n = 1601;
  const tab = new Float32Array(n).fill(-Infinity);
  for (let i = 0; i < c.N; i++) {
    const s = i * c.ds;
    if (s < 880 || s > 1800) continue; // the waterfront drive (T4 → Harbor Ave corner)
    const k = Math.round((c.px[i] - X0) / STEP);
    for (let q = k - 1; q <= k + 1; q++) if (q >= 0 && q < n) tab[q] = Math.max(tab[q], c.pz[i] + SHORE_OFFSET);
  }
  // extend flat beyond both ends of the waterfront
  let first = tab.findIndex((v) => v > -Infinity), last = n - 1 - [...tab].reverse().findIndex((v) => v > -Infinity);
  for (let q = 0; q < first; q++) tab[q] = tab[first];
  for (let q = last + 1; q < n; q++) tab[q] = tab[last];
  // smooth (shore is a gentle curve, not a copy of the chicane)
  const sm = new Float32Array(n);
  for (let q = 0; q < n; q++) {
    let a = 0, w = 0;
    for (let o = -8; o <= 8; o++) { const v = tab[Math.min(n - 1, Math.max(0, q + o))]; a += v; w++; }
    sm[q] = a / w;
  }
  // never closer than SHORE_OFFSET to the road (the smoothing can pull it in at the chicane)
  for (let q = 0; q < n; q++) sm[q] = Math.max(sm[q], tab[q] - 4);
  const shoreZ = (x) => {
    const f = (x - X0) / STEP;
    const q = Math.max(0, Math.min(n - 2, Math.floor(f))), t = Math.max(0, Math.min(1, f - q));
    return sm[q] + (sm[q + 1] - sm[q]) * t;
  };
  return { shoreZ, isWater: (x, z) => z > shoreZ(x) };
}

const SHORE_OFFSET = 42;
const OVERPASS_X = 190;

function buildFeatures(c, wallOffset) {
  const wrap = (s) => ((s % c.length) + c.length) % c.length;
  const sdist = (a, b) => { const d = Math.abs(wrap(a) - wrap(b)); return Math.min(d, c.length - d); };
  const shore = buildShoreline(c);
  const sideStreets = []; // { x0, z0, x1, z1, halfWidth, s, side, s2? }  (side: +1 right / −1 left of the track)
  const crosswalks = []; // s positions of zebra crossings
  const SIDE_HALF = 11; // side street half width incl. sidewalks (no-build corridor)
  const MIN_CLEAR = wallOffset + SIDE_HALF + 6;

  // March outwards; returns { len, hit } — hit = sample index of another part of the circuit we ran into.
  const rayStreet = (x0, z0, dx, dz, maxLen, s) => {
    let len = 0;
    for (let d = 10; d <= maxLen; d += 4) {
      const x = x0 + dx * d, z = z0 + dz * d;
      if (shore.isWater(x, z + 12)) return { len, hit: -1 };
      const n = nearestSample(c, x, z, s, 80);
      if (n.d < wallOffset + 2) return { len: d, hit: n.i };
      if (n.d < MIN_CLEAR) { /* passing close to another road at a shallow angle → stop here */
        // allow if we are heading straight into it (connector), checked by continuing the march
      }
      len = d;
    }
    return { len, hit: -1 };
  };
  const nearExisting = (x0, z0, x1, z1) => sideStreets.some((st) => {
    // midpoint distance + parallel check
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, ex = x1 - x0, ez = z1 - z0;
    const fx = st.x1 - st.x0, fz = st.z1 - st.z0;
    const L1 = Math.hypot(ex, ez), L2 = Math.hypot(fx, fz);
    const par = Math.abs(ex * fx + ez * fz) / (L1 * L2) > 0.9;
    const t = Math.max(0, Math.min(1, ((mx - st.x0) * fx + (mz - st.z0) * fz) / (L2 * L2)));
    const d = Math.hypot(st.x0 + fx * t - mx, st.z0 + fz * t - mz);
    return par && d < 40;
  });
  const addStreet = (x0, z0, dx, dz, s, side, corner, maxLen) => {
    const r = rayStreet(x0, z0, dx, dz, maxLen, s);
    if (r.hit >= 0) {
      // connector to another part of the circuit: end at that road's barrier line
      const hs = r.hit * c.ds;
      const L = Math.max(0, r.len - wallOffset - 1);
      if (L < 30) return false;
      const x1 = x0 + dx * L, z1 = z0 + dz * L;
      if (nearExisting(x0, z0, x1, z1)) return false;
      sideStreets.push({ x0, z0, x1, z1, halfWidth: SIDE_HALF, s, side, corner, s2: hs });
      return true;
    }
    if (r.len < (corner ? 40 : 90)) return false;
    const x1 = x0 + dx * r.len, z1 = z0 + dz * r.len;
    if (nearExisting(x0, z0, x1, z1)) return false;
    sideStreets.push({ x0, z0, x1, z1, halfWidth: SIDE_HALF, s, side, corner });
    return true;
  };

  // 1) City corners (~90°, tight): the two streets continue straight on beyond the intersection.
  const cityCorners = c.corners.filter((k) => Math.abs(Math.abs(k.angle) - Math.PI / 2) < 0.2 && k.radius <= 60);
  for (const k of cityCorners) {
    for (const [dx, dz] of [[k.d0[0], k.d0[1]], [-k.d1[0], -k.d1[1]]]) addStreet(k.x, k.z, dx, dz, k.apex, -Math.sign(k.kappa), true, 170);
    // crosswalks just before / after the intersection, unless another corner is right there (hairpin)
    const before = wrap(k.s0 - 9), after = wrap(k.s1 + 9);
    const clash = (s) => c.corners.some((o) => o !== k && (sdist(s, o.s0) < 25 || sdist(s, o.s1) < 25 || (wrap(s) > o.s0 && wrap(s) < o.s1)));
    if (!clash(before)) crosswalks.push(before);
    if (!clash(after)) crosswalks.push(after);
  }

  // 2) Mid-block cross streets on long straights.
  const runs = [];
  let runStart = -1;
  for (let i = 0; i <= c.N; i++) {
    const straight = i < c.N && Math.abs(c.kap[i]) < 1 / 3000;
    if (straight && runStart < 0) runStart = i;
    if (!straight && runStart >= 0) { runs.push([runStart * c.ds, (i - 1) * c.ds]); runStart = -1; }
  }
  for (const [a, b] of runs) {
    const len = b - a;
    if (len < 200) continue;
    const count = Math.floor((len - 100) / 140);
    for (let q = 1; q <= count; q++) {
      const s = a + (len * q) / (count + 1);
      if (sdist(s, 0) < 110) continue; // keep the start/finish area clean
      const i = Math.round(s / c.ds) % c.N;
      const h = c.hd[i];
      const rx = -Math.cos(h), rz = Math.sin(h);
      let any = false;
      for (const side of [1, -1]) {
        const x0 = c.px[i] + rx * side * (wallOffset + 1), z0 = c.pz[i] + rz * side * (wallOffset + 1);
        if (addStreet(x0, z0, rx * side, rz * side, s, side, false, 170)) any = true;
      }
      if (any) crosswalks.push(wrap(s - SIDE_HALF - 5));
    }
  }
  // crosswalks where connectors meet another part of the circuit
  for (const st of sideStreets) {
    if (st.s2 === undefined) continue;
    const near = c.corners.some((o) => sdist(st.s2, o.apex) < (o.s1 - o.s0) / 2 + 30);
    if (!near && sdist(st.s2, 0) > 110) crosswalks.push(wrap(st.s2 + SIDE_HALF + 5));
  }
  // Junction mouths: stretches of sidewalk where a side street opens onto the circuit (no curb, no lamps).
  const mouths = [];
  for (const st of sideStreets) {
    if (st.corner) {
      const k = c.corners.find((o) => Math.abs(o.apex - st.s) < 1e-6);
      mouths.push({ s0: wrap(k.s0 - 4), s1: wrap(k.s1 + 4), side: st.side });
    } else {
      mouths.push({ s0: wrap(st.s - st.halfWidth + 1.5), s1: wrap(st.s + st.halfWidth - 1.5), side: st.side });
    }
    if (st.s2 !== undefined) {
      const i = Math.round(st.s2 / c.ds) % c.N;
      const h = c.hd[i];
      const side2 = Math.sign((st.x1 - c.px[i]) * -Math.cos(h) + (st.z1 - c.pz[i]) * Math.sin(h)) || 1;
      mouths.push({ s0: wrap(st.s2 - st.halfWidth + 1.5), s1: wrap(st.s2 + st.halfWidth - 1.5), side: side2 });
    }
  }
  const inMouth = (s, side, pad = 0) => mouths.some((m) => m.side === side && (m.s0 <= m.s1 ? s > m.s0 - pad && s < m.s1 + pad : s > m.s0 - pad || s < m.s1 + pad));

  // Elevated highway (purely visual) crossing the circuit north–south at x = OVERPASS_X.
  const overpassS = [];
  for (let i = 0; i < c.N; i++) {
    const j = (i + 1) % c.N;
    if ((c.px[i] - OVERPASS_X) * (c.px[j] - OVERPASS_X) <= 0 && c.px[i] !== c.px[j]) overpassS.push(i * c.ds);
  }

  // de-duplicate crosswalks closer than 20 m
  crosswalks.sort((a, b) => a - b);
  const cw = [];
  for (const s of crosswalks) if (!cw.length || s - cw[cw.length - 1] > 20) cw.push(s);

  // 3) Kerbs (red/white rumble strips) on the inside of tight corners, and on the outside at the exit.
  const kerb = new Int8Array(c.N); // +1 kerb on the right edge, −1 on the left, 0 none
  const kerbOut = new Int8Array(c.N);
  for (let i = 0; i < c.N; i++) {
    const k = c.kap[i];
    if (Math.abs(k) > 1 / 75) kerb[i] = Math.sign(k);
  }
  for (const k of c.corners) {
    if (k.radius > 75) continue;
    const i0 = Math.round(k.apex / c.ds), i1 = Math.round((k.s1 + 20) / c.ds);
    for (let i = i0; i <= i1; i++) kerbOut[((i % c.N) + c.N) % c.N] = -Math.sign(k.kappa);
  }

  // drop crosswalks under the overpass
  const cw2 = cw.filter((s) => overpassS.every((o) => sdist(s, o) > 16));
  return { sideStreets, mouths, inMouth, crosswalks: cw2, kerb, kerbOut, overpass: { x: OVERPASS_X, s: overpassS, width: 15, height: 9.5 }, shoreZ: shore.shoreZ, isWater: shore.isWater, shoreOffset: SHORE_OFFSET };
}

// ---------------------------------------------------------------------------------------------
// TrackPath
// ---------------------------------------------------------------------------------------------

let cached = null;

/** Pure-math track path (Node-safe). See CONTRACTS.md §1. */
export function createTrackPath() {
  const halfWidth = CONFIG.track.roadWidth / 2;
  const wallOffset = halfWidth + CONFIG.track.wallMargin;
  if (!cached) {
    const c = buildCenterline();
    cached = { c, features: buildFeatures(c, wallOffset) };
  }
  const { c, features } = cached;
  const { px, pz, hd, kap, N, ds, length } = c;
  const wrap = (s) => ((s % length) + length) % length;

  // Lamps: evenly spaced (integer count so the pattern closes seamlessly).
  const lampCount = Math.round(length / LAMP_TARGET_SPACING);
  const lampSpacing = length / lampCount;

  // Lamp table: opposite pairs at s = (k + 0.5)·spacing. Cool LED on the boulevard & waterfront,
  // warm sodium in the old blocks. Removed at junction mouths and under the overpass.
  const sdistW = (a, b) => { const d = Math.abs(wrap(a) - wrap(b)); return Math.min(d, length - d); };
  const zoneOf = (s) => {
    const apex = (ci) => c.corners.find((k) => k.index === ci).apex;
    const a1 = apex(1), a4 = apex(4), a10 = apex(10), a0 = apex(0);
    if (s >= a1 && s < a4) return 'sodium';
    if (s >= a4 && s < a10) return 'led';
    if (s >= a10 && s < a0) return 'sodium';
    return 'led';
  };
  const LAMP_COLORS = { led: [0.78, 0.88, 1.0], sodium: [1.0, 0.56, 0.2] };
  const lamps = [];
  for (let k = 0; k < lampCount; k++) {
    const s = wrap((k + 0.5) * lampSpacing);
    const kind = zoneOf(s);
    const under = features.overpass.s.some((o) => sdistW(s, o) < 14);
    const present = [-1, 1].map((side) => !under && !features.inMouth(s, side, 4));
    lamps.push({ k, s, kind, color: LAMP_COLORS[kind], left: present[0], right: present[1] });
  }

  // --- sample interpolation helpers ---
  const locate = (s) => {
    const f = wrap(s) / ds;
    const i = Math.floor(f) % N;
    return [i, f - Math.floor(f)];
  };
  const headingAt = (s) => {
    const [i, t] = locate(s);
    const j = (i + 1) % N;
    let dh = hd[j] - hd[i];
    if (j === 0) dh = hd[j] - (hd[i] - (c.turn)); // unwrap across the seam (total turn = −2π)
    return hd[i] + dh * t;
  };

  // --- coarse spatial grid for global projection fallback ---
  const G = 20, MARGIN = 50;
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (let i = 0; i < N; i++) {
    minx = Math.min(minx, px[i]); maxx = Math.max(maxx, px[i]);
    minz = Math.min(minz, pz[i]); maxz = Math.max(maxz, pz[i]);
  }
  const gx0 = minx - MARGIN, gz0 = minz - MARGIN;
  const GW = Math.ceil((maxx - minx + 2 * MARGIN) / G), GH = Math.ceil((maxz - minz + 2 * MARGIN) / G);
  const cellLists = Array.from({ length: GW * GH }, () => []);
  for (let i = 0; i < N; i++) {
    const cx0 = Math.max(0, Math.floor((px[i] - MARGIN - gx0) / G)), cx1 = Math.min(GW - 1, Math.floor((px[i] + MARGIN - gx0) / G));
    const cz0 = Math.max(0, Math.floor((pz[i] - MARGIN - gz0) / G)), cz1 = Math.min(GH - 1, Math.floor((pz[i] + MARGIN - gz0) / G));
    for (let gz = cz0; gz <= cz1; gz++) for (let gx = cx0; gx <= cx1; gx++) cellLists[gz * GW + gx].push(i);
  }
  const cellStart = new Int32Array(GW * GH + 1);
  for (let k = 0; k < GW * GH; k++) cellStart[k + 1] = cellStart[k] + cellLists[k].length;
  const cellIdx = new Int32Array(cellStart[GW * GH]);
  for (let k = 0; k < GW * GH; k++) cellIdx.set(cellLists[k], cellStart[k]);

  const d2 = (i, x, z) => { const dx = px[i] - x, dz = pz[i] - z; return dx * dx + dz * dz; };

  function nearestGlobal(x, z) {
    const gx = Math.floor((x - gx0) / G), gz = Math.floor((z - gz0) / G);
    let best = -1, bd = Infinity;
    if (gx >= 0 && gz >= 0 && gx < GW && gz < GH) {
      const k = gz * GW + gx;
      for (let q = cellStart[k]; q < cellStart[k + 1]; q++) {
        const i = cellIdx[q];
        const d = d2(i, x, z);
        if (d < bd) { bd = d; best = i; }
      }
    }
    if (best < 0) {
      for (let i = 0; i < N; i++) { const d = d2(i, x, z); if (d < bd) { bd = d; best = i; } }
    }
    return best;
  }

  const WIN = 24;
  const FAR2 = (wallOffset * 2.5) ** 2;

  const track = {
    length,
    halfWidth,
    wallOffset,
    startS: 0,
    lampSpacing,
    lampCount,
    /** Extra (non-contract) data for the world builders. */
    samples: { px, pz, hd, kap, N, ds },
    corners: c.corners,
    features,

    getPointAt(s, out = new THREE.Vector3()) {
      const [i, t] = locate(s);
      const j = (i + 1) % N;
      return out.set(px[i] + (px[j] - px[i]) * t, 0, pz[i] + (pz[j] - pz[i]) * t);
    },
    getTangentAt(s, out = new THREE.Vector3()) {
      const h = headingAt(s);
      return out.set(Math.sin(h), 0, Math.cos(h));
    },
    getRightAt(s, out = new THREE.Vector3()) {
      const h = headingAt(s);
      return out.set(-Math.cos(h), 0, Math.sin(h));
    },
    getHeadingAt(s) {
      return wrapAngle(headingAt(s));
    },
    getCurvatureAt(s) {
      const [i, t] = locate(s);
      return kap[i] + (kap[(i + 1) % N] - kap[i]) * t;
    },

    /**
     * Closest centerline point to pos (x, z). Local search around hintS when given (per-frame fast path),
     * global spatial-grid lookup otherwise or when the hint turns out to be far off.
     */
    project(pos, hintS, out) {
      const x = pos.x, z = pos.z;
      let best = -1, bd = Infinity;
      if (hintS != null && Number.isFinite(hintS)) {
        const c0 = Math.round(wrap(hintS) / ds) % N;
        let bo = 0;
        for (let o = -WIN; o <= WIN; o++) {
          const i = (c0 + o + N) % N;
          const d = d2(i, x, z);
          if (d < bd) { bd = d; best = i; bo = o; }
        }
        if (bo === WIN || bo === -WIN) {
          // keep walking downhill beyond the window (car moved fast or hint stale)
          const dir = Math.sign(bo);
          for (let step = 0; step < 600; step++) {
            const i = (best + dir + N) % N;
            const d = d2(i, x, z);
            if (d >= bd) break;
            bd = d; best = i;
          }
        }
        if (bd > FAR2) best = -1; // suspicious → global
      }
      if (best < 0) { best = nearestGlobal(x, z); bd = d2(best, x, z); }

      // Refine on the two adjacent segments.
      let bs = best * ds, bestD = bd, qx = px[best], qz = pz[best];
      for (const a of [(best - 1 + N) % N, best]) {
        const b = (a + 1) % N;
        const ex = px[b] - px[a], ez = pz[b] - pz[a];
        const L2 = ex * ex + ez * ez;
        let t = ((x - px[a]) * ex + (z - pz[a]) * ez) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = px[a] + ex * t, cz = pz[a] + ez * t;
        const d = (x - cx) ** 2 + (z - cz) ** 2;
        if (d <= bestD) { bestD = d; bs = (a + t) * ds; qx = cx; qz = cz; }
      }
      const h = headingAt(bs);
      const lateral = (x - qx) * -Math.cos(h) + (z - qz) * Math.sin(h);
      const res = out || {};
      res.s = wrap(bs);
      res.lateral = lateral;
      res.distance = Math.sqrt(bestD);
      return res;
    },

    getStartGrid(slot = 0) {
      const k = Math.max(0, Math.min(7, slot | 0));
      const s = wrap(track.startS - GRID_FIRST - k * GRID_PITCH);
      const p = track.getPointAt(s);
      const r = track.getRightAt(s);
      p.addScaledVector(r, k % 2 === 0 ? -GRID_LATERAL : GRID_LATERAL);
      return { position: p, heading: wrapAngle(headingAt(s)), s, lateral: k % 2 === 0 ? -GRID_LATERAL : GRID_LATERAL };
    },

    getMinimapPolyline(n = 256) {
      const out = [];
      const p = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        track.getPointAt((i / n) * length, p);
        out.push([p.x, p.z]);
      }
      return out;
    },

    /** Lamp k: s position along the track (lamps on both sides, opposite pairs). */
    getLampS(k) {
      return wrap((k + 0.5) * lampSpacing);
    },
    grid: { lateral: GRID_LATERAL, first: GRID_FIRST, pitch: GRID_PITCH },
    lamps,
    lampGeometry: { lateral: LAMP_HEAD_U, height: LAMP_HEAD_H, poleLateral: LAMP_POLE_U },
  };
  return track;
}

export { UP };
