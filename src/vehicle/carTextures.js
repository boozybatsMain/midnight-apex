// Canvas-generated textures for the car: livery (per car), surface mask (shared), carbon weave, honeycomb mesh,
// tire sidewall/tread, brake disc, soft contact shadow, headlight road cone, nitro flame.
import * as THREE from 'three';

const cache = {};
const hasDOM = () => typeof document !== 'undefined';

function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined' && !hasDOM()) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
const hex = (c) => '#' + new THREE.Color(c).getHexString();
function mixHex(a, b, t) {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  return '#' + ca.lerp(cb, t).getHexString();
}
function luminance(c) {
  const k = new THREE.Color(c);
  return 0.2126 * k.r + 0.7152 * k.g + 0.0722 * k.b;
}

// ------------------------------------------------------------------------------------------------
// Body layout drawing: everything is expressed in car space ((z, y) on the sides, (z, x) on top) and
// mapped through the body's UV layout (u = along length, v = arc length from the top centre).
// ------------------------------------------------------------------------------------------------
function makeMapper(layout, W, H) {
  const px = (u) => u * W;
  const py = (v) => (1 - v) * H;
  const side = (z, y, left) => [px(layout.uAtZ(z)), py(layout.vSideAtY(z, y, left))];
  const top = (z, x) => [px(layout.uAtZ(z)), py(layout.vTopAtX(z, x))];
  return { px, py, side, top, W, H };
}
function pathFrom(ctx, pts, close = true) {
  ctx.beginPath();
  let first = true;
  for (const p of pts) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (first) { ctx.moveTo(p[0], p[1]); first = false; } else ctx.lineTo(p[0], p[1]);
  }
  if (close) ctx.closePath();
}
// sample a polyline in design space densely (so the non-linear UV mapping stays accurate)
function densify(pts, step = 0.02) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [a0, b0] = pts[i];
    const [a1, b1] = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(a1 - a0, b1 - b0) / step));
    for (let k = 0; k < n; k++) out.push([a0 + ((a1 - a0) * k) / n, b0 + ((b1 - b0) * k) / n]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
const sidePts = (M, pts, left) => densify(pts).map(([z, y]) => M.side(z, y, left));
const topPts = (M, pts, sgn = 1) => densify(pts).map(([z, x]) => M.top(z, x * sgn));

// Panel gaps, vents, intakes — drawn identically in the livery (dark colour) and the mask (matte, no clearcoat).
function drawDetails(ctx, M, { gap, dark, scale, gapsOnly = false }) {
  const lw = Math.max(1.5, 2.6 * scale);
  if (gapsOnly) dark = 'rgba(0,0,0,0)';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const left of [true, false]) {
    const sgn = left ? 1 : -1;
    // ---- underbody / lower sill (always dark)
    ctx.fillStyle = dark;
    for (let z = -2.27; z < 2.29; z += 0.01) {
      const [x0, y0] = M.side(z, 0.175, left);
      if (!Number.isFinite(y0)) continue;
      const yEdge = left ? M.H * 0.013 : M.H * 0.987; // keep the swatch rows intact
      ctx.fillRect(x0 - 1, Math.min(y0, yEdge), M.W * 0.01 / 4.55 + 2, Math.abs(yEdge - y0));
    }
    // ---- lower door blade: dark band between the arches (visually lowers the body)
    ctx.fillStyle = dark;
    pathFrom(ctx, sidePts(M, [[0.97, 0.37], [0.6, 0.36], [0.0, 0.345], [-0.4, 0.35], [-0.96, 0.4], [-0.96, 0.17], [0.97, 0.17]], left));
    ctx.fill();
    // ---- side intake: deep part dark
    ctx.fillStyle = dark;
    pathFrom(ctx, sidePts(M, [[-0.5, 0.43], [-0.97, 0.41], [-0.97, 0.72], [-0.62, 0.71], [-0.5, 0.6], [-0.5, 0.43]], left));
    ctx.fill();
    // ---- door shut lines
    ctx.strokeStyle = gap;
    ctx.lineWidth = lw;
    pathFrom(ctx, sidePts(M, [[0.86, 0.83], [0.9, 0.6], [0.88, 0.36], [0.8, 0.27], [-0.12, 0.27], [-0.2, 0.33], [-0.2, 0.42]], left), false);
    ctx.stroke();
    // door rear edge rises along the intake's leading edge
    pathFrom(ctx, sidePts(M, [[-0.2, 0.42], [-0.1, 0.62], [0.0, 0.82]], left), false);
    ctx.stroke();
    // door handle (flush, dark recess)
    ctx.fillStyle = gap;
    pathFrom(ctx, sidePts(M, [[0.02, 0.765], [-0.17, 0.765], [-0.17, 0.79], [0.02, 0.79]], left));
    ctx.fill();
    // front fender vent behind the front wheel
    ctx.fillStyle = dark;
    for (let k = 0; k < 3; k++) {
      const y = 0.5 + k * 0.045;
      pathFrom(ctx, sidePts(M, [[0.95 - k * 0.012, y], [0.905 - k * 0.012, y], [0.89 - k * 0.012, y + 0.025], [0.935 - k * 0.012, y + 0.025]], left));
      ctx.fill();
    }
    // ---- top: front lid outline
    ctx.strokeStyle = gap;
    ctx.lineWidth = lw;
    pathFrom(ctx, topPts(M, [[1.07, 0.5], [1.5, 0.53], [1.85, 0.52], [2.0, 0.42], [2.07, 0.2], [2.09, 0.0]], sgn), false);
    ctx.stroke();
    // hood nostril vents
    ctx.fillStyle = dark;
    pathFrom(ctx, topPts(M, [[1.7, 0.1], [1.92, 0.12], [1.9, 0.36], [1.72, 0.3]], sgn));
    ctx.fill();
    // engine cover lid outline + vent slots
    ctx.strokeStyle = gap;
    pathFrom(ctx, topPts(M, [[-1.3, 0.47], [-1.6, 0.5], [-1.98, 0.48], [-2.03, 0.3], [-2.04, 0.0]], sgn), false);
    ctx.stroke();
    ctx.fillStyle = dark;
    for (let k = 0; k < 6; k++) {
      const z0 = -1.42 - k * 0.085;
      pathFrom(ctx, topPts(M, [[z0, 0.07], [z0 - 0.04, 0.07], [z0 - 0.045, 0.4], [z0 - 0.005, 0.4]], sgn));
      ctx.fill();
    }
  }
  // fuel door (right rear haunch)
  ctx.strokeStyle = gap;
  ctx.lineWidth = lw;
  pathFrom(ctx, topPts(M, [[-1.5, 0.68], [-1.62, 0.68], [-1.62, 0.8], [-1.5, 0.8]], -1));
  ctx.stroke();
}

// Hood nostril vents seen up close (hood cam): slatted ducts instead of flat black decals. Drawn into the livery
// (colour) and into the surface mask (glossy slat tops between satin gaps, so the slats catch reflections).
function drawHoodLouvres(ctx, M, scale, { mask = false } = {}) {
  const poly = [[1.7, 0.1], [1.92, 0.12], [1.9, 0.36], [1.72, 0.3]];
  const slat = mask ? `rgb(255,${Math.round(0.22 * 255)},${Math.round(0.1 * 255)})` : '#30333b';
  const gapCol = mask ? `rgb(40,${Math.round(0.6 * 255)},0)` : '#000000';
  for (const sgn of [1, -1]) {
    ctx.save();
    pathFrom(ctx, topPts(M, poly, sgn));
    ctx.clip();
    if (!mask) {
      // duct floor: darker toward the back (depth)
      const [xa] = M.top(1.7, 0.2 * sgn);
      const [xb] = M.top(1.92, 0.2 * sgn);
      const g = ctx.createLinearGradient(xa, 0, xb, 0);
      g.addColorStop(0, '#020203');
      g.addColorStop(1, '#0b0c0f');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, M.W, M.H);
    }
    // slats across the duct: a lit top face + a black shadow gap behind it
    ctx.lineCap = 'butt';
    const pitch = 0.03;
    for (let z = 1.712; z < 1.93; z += pitch) {
      const a = M.top(z, 0.07 * sgn);
      const b = M.top(z + 0.012, 0.4 * sgn);
      const w = (0.013 / 4.55) * M.W; // slat face ≈ 13 mm
      ctx.strokeStyle = slat;
      ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.strokeStyle = gapCol;
      ctx.lineWidth = w * 0.6;
      ctx.beginPath(); ctx.moveTo(a[0] + w * 0.8, a[1]); ctx.lineTo(b[0] + w * 0.8, b[1]); ctx.stroke();
    }
    ctx.restore();
    if (!mask) {
      // thin lit lip around the opening
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = Math.max(1, 1.6 * scale);
      pathFrom(ctx, topPts(M, poly, sgn));
      ctx.stroke();
    }
  }
}

// Racing-stripe geometry (arc metres from the top centreline) + colours. The paint shader draws the stripes
// analytically (crisp at any magnification, e.g. from the hood cam); the canvas only draws them when asked.
export const STRIPE = { inner: 0.035, outer: 0.105, pin: 0.0056, zStart: -2.19 };
export function liveryStripeStyle(color = 0x0a3cff, accent = 0x00e5ff) {
  const darkPaint = luminance(color) < 0.05;
  return { accent: hex(accent), pin: darkPaint ? mixHex(accent, 0x000000, 0.25) : mixHex(color, 0x000000, 0.55) };
}

export function makeLiveryTexture(layout, { color = 0x0a3cff, accent = 0x00e5ff, number = 1, name = '', quality = 'high', stripes = true } = {}) {
  const W = quality === 'low' ? 1024 : 2048;
  const H = W / 2;
  const scale = W / 2048;
  const cv = canvas(W, H);
  const ctx = cv.getContext('2d');
  const M = makeMapper(layout, W, H);
  const base = hex(color);
  const acc = hex(accent);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);
  // swatches for small parts (mirrors, wing plates) — see SWATCH_UV
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H * 0.012);
  ctx.fillStyle = acc;
  ctx.fillRect(0, H * 0.988, W, H * 0.012);

  drawDetails(ctx, M, { gap: 'rgba(0,0,0,0.92)', dark: '#0a0b0d', scale });
  drawHoodLouvres(ctx, M, scale);
  // ---- twin racing stripes over the whole top
  const darkPaint = luminance(color) < 0.05;
  const { pin } = liveryStripeStyle(color, accent);
  // stripes drawn in v directly (arc ≈ lateral offset on the top surface)
  const vs = (g) => M.py(0.5 + g / layout.uvScale);
  // stripes run from the nose (where they fold into a chevron) to the ducktail edge (no fold down the tail face)
  const x0 = M.px(layout.uAtZ(STRIPE.zStart));
  for (const sg of stripes ? [1, -1] : []) {
    const a = vs(sg * STRIPE.inner);
    const b = vs(sg * STRIPE.outer);
    const pw = (STRIPE.pin / layout.uvScale) * H;
    ctx.fillStyle = acc;
    ctx.fillRect(x0, Math.min(a, b), W - x0, Math.abs(b - a));
    ctx.fillStyle = pin;
    ctx.fillRect(x0, Math.min(a, b) - pw, W - x0, pw);
    ctx.fillRect(x0, Math.max(a, b), W - x0, pw);
  }

  // ---- side graphics: accent swoosh low on the doors + number + name
  for (const left of [true, false]) {
    ctx.fillStyle = acc;
    pathFrom(ctx, sidePts(M, [[0.93, 0.305], [0.2, 0.3], [-0.18, 0.31], [-0.26, 0.36], [-0.12, 0.36], [0.25, 0.335], [0.93, 0.318]], left));
    ctx.fill();
    // number: draw into an offscreen block then map onto the door (rotated 180° on the left side, see UV layout)
    const [cx, cy] = M.side(0.36, 0.56, left);
    const [cx2, cy2] = M.side(0.36, 0.66, left);
    const hPx = Math.abs(cy2 - cy) * 2.25; // ≈ 0.22 m tall glyphs
    ctx.save();
    ctx.translate(cx, cy + (cy2 - cy) * 0.0);
    if (left) ctx.rotate(Math.PI);
    ctx.font = `italic 900 ${hPx.toFixed(0)}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const numStr = String(number).padStart(2, '0');
    ctx.lineWidth = hPx * 0.09;
    ctx.strokeStyle = darkPaint ? '#000' : mixHex(color, 0x000000, 0.7);
    ctx.strokeText(numStr, 0, 0);
    ctx.fillStyle = acc;
    ctx.fillText(numStr, 0, 0);
    ctx.restore();
    // name, small, below the side window towards the rear of the door
    if (name) {
      const [nx, ny] = M.side(-0.02, 0.73, left);
      const [, ny2] = M.side(-0.02, 0.78, left);
      const nh = Math.abs(ny2 - ny);
      ctx.save();
      ctx.translate(nx, ny);
      if (left) ctx.rotate(Math.PI);
      ctx.font = `italic 800 ${nh.toFixed(0)}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
      ctx.textAlign = left ? 'right' : 'left'; // text runs forward from the door's rear edge
      ctx.textBaseline = 'middle';
      ctx.fillStyle = luminance(color) > 0.5 ? '#111' : '#f4f6ff';
      ctx.globalAlpha = 0.9;
      ctx.fillText(String(name).toUpperCase(), 0, 0);
      ctx.restore();
    }
  }
  drawDetails(ctx, M, { gap: 'rgba(0,0,0,0.92)', dark: '#0a0b0d', scale, gapsOnly: true });

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16; // three clamps to the GPU max; the hood is seen at grazing angles from the hood cam
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

// UV coordinates of solid colour swatches inside every livery texture
export const SWATCH_UV = { paint: [0.5, 0.994], accent: [0.5, 0.006] };

// Shared surface mask: R = clearcoat, G = roughness, B = metalness (paint vs matte black details).
export const PAINT_ROUGH = 0.3;
export const PAINT_METAL = 0.62;
export function getMaskTexture(layout) {
  if (cache.mask) return cache.mask;
  // same resolution as the livery so panel gaps / vents stay crisp up close (hood cam)
  const W = 2048;
  const H = 1024;
  const cv = canvas(W, H);
  const ctx = cv.getContext('2d');
  const M = makeMapper(layout, W, H);
  const paint = `rgb(255,${Math.round(PAINT_ROUGH * 255)},${Math.round(PAINT_METAL * 255)})`;
  const matte = `rgb(10,${Math.round(0.72 * 255)},0)`;
  // satin-black details (vents, intakes, lower blades): a thin, slightly hazy coat rather than a mirror
  const satin = `rgb(105,${Math.round(0.42 * 255)},20)`;
  ctx.fillStyle = paint;
  ctx.fillRect(0, 0, W, H);
  drawDetails(ctx, M, { gap: matte, dark: satin, scale: 1 });
  drawHoodLouvres(ctx, M, 1, { mask: true });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 16;
  return (cache.mask = tex);
}

// ------------------------------------------------------------------------------------------------
// Tiled material textures
// ------------------------------------------------------------------------------------------------
export function getCarbonTexture() {
  if (cache.carbon) return cache.carbon;
  const N = 512;
  const cells = 16;
  const cs = N / cells;
  const cv = canvas(N, N);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#0c0c0e';
  ctx.fillRect(0, 0, N, N);
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const horiz = (i + j) % 4 < 2; // 2x2 twill
      const x = i * cs;
      const y = j * cs;
      const g = horiz ? ctx.createLinearGradient(x, y, x, y + cs) : ctx.createLinearGradient(x, y, x + cs, y);
      g.addColorStop(0, '#0b0b0d');
      g.addColorStop(0.5, horiz ? '#2c2d31' : '#1b1c1f');
      g.addColorStop(1, '#0b0b0d');
      ctx.fillStyle = g;
      ctx.fillRect(x + 0.5, y + 0.5, cs - 1, cs - 1);
      // fibre streaks
      ctx.strokeStyle = 'rgba(255,255,255,0.035)';
      ctx.lineWidth = 1;
      for (let k = 2; k < cs; k += 3) {
        ctx.beginPath();
        if (horiz) { ctx.moveTo(x, y + k); ctx.lineTo(x + cs, y + k); } else { ctx.moveTo(x + k, y); ctx.lineTo(x + k, y + cs); }
        ctx.stroke();
      }
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return (cache.carbon = tex);
}

export function getHoneycombTexture() {
  if (cache.honey) return cache.honey;
  const W = 256;
  const H = Math.round(256 * Math.sqrt(3) / 1.5 / 2) * 2; // tileable hex grid
  const cv = canvas(W, H);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#3a3c42';
  ctx.fillRect(0, 0, W, H);
  const r = W / 12;
  const hx = r * 1.5;
  const hy = r * Math.sqrt(3);
  for (let i = -1; i <= W / hx + 1; i++) {
    for (let j = -1; j <= H / hy + 1; j++) {
      const cx = i * hx;
      const cy = j * hy + (i % 2 ? hy / 2 : 0);
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const rr = r * 0.78;
        ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      ctx.closePath();
      const g = ctx.createRadialGradient(cx, cy - r * 0.3, 0, cx, cy, r);
      g.addColorStop(0, '#010101');
      g.addColorStop(0.7, '#050506');
      g.addColorStop(1, '#0c0c0e');
      ctx.fillStyle = g;
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return (cache.honey = tex);
}

// Tire: colour map with sidewall lettering + a tread-groove normal map. Lathe UV: u around, v across the profile.
export function getTireTextures(treadV0 = 0.36, treadV1 = 0.64) {
  if (cache.tire) return cache.tire;
  const W = 2048;
  const H = 128;
  const cv = canvas(W, H);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#121213';
  ctx.fillRect(0, 0, W, H);
  // tread band slightly lighter + scuffed
  ctx.fillStyle = '#18181a';
  ctx.fillRect(0, H * (1 - treadV1), W, H * (treadV1 - treadV0));
  // sidewall lettering on both sidewalls (v near 0.12 and 0.88)
  ctx.font = 'italic 900 22px "Arial Black", Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#4a4a4e';
  for (const v of [0.13, 0.87]) {
    for (let k = 0; k < 2; k++) {
      ctx.save();
      ctx.translate(k * W / 2 + 60, H * (1 - v));
      if (v < 0.5) ctx.scale(1, -1);
      ctx.fillText('APEX  P ZERO  CORSA', 0, 0);
      ctx.font = '700 14px Arial, sans-serif';
      ctx.fillText('305/30 ZR20   (104Y)   RACE COMPOUND', 420, 0);
      ctx.font = 'italic 900 22px "Arial Black", Arial, sans-serif';
      ctx.restore();
    }
  }
  const map = new THREE.CanvasTexture(cv);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.anisotropy = 8;

  // normal map from a height field (circumferential grooves + angled sipes)
  const NW = 1024;
  const NH = 128;
  const hgt = new Float32Array(NW * NH);
  for (let y = 0; y < NH; y++) {
    const v = 1 - y / NH;
    for (let x = 0; x < NW; x++) {
      let h = 1;
      if (v > treadV0 && v < treadV1) {
        const t = (v - treadV0) / (treadV1 - treadV0);
        for (const gc of [0.22, 0.45, 0.68]) if (Math.abs(t - gc) < 0.035) h = 0;
        const sip = ((x / NW) * 220 + t * 3.0) % 1;
        if (t > 0.08 && t < 0.92 && sip < 0.12 && !(t > 0.45 && t < 0.68)) h = Math.min(h, 0.3);
      }
      hgt[y * NW + x] = h;
    }
  }
  const data = new Uint8Array(NW * NH * 4);
  for (let y = 0; y < NH; y++) {
    for (let x = 0; x < NW; x++) {
      const hl = hgt[y * NW + ((x - 1 + NW) % NW)];
      const hr = hgt[y * NW + ((x + 1) % NW)];
      const hu = hgt[Math.max(0, y - 1) * NW + x];
      const hd = hgt[Math.min(NH - 1, y + 1) * NW + x];
      let nx = (hl - hr) * 1.5;
      let ny = (hd - hu) * 1.5;
      const nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const o = ((NH - 1 - y) * NW + x) * 4;
      data[o] = ((nx / l) * 0.5 + 0.5) * 255;
      data[o + 1] = ((ny / l) * 0.5 + 0.5) * 255;
      data[o + 2] = ((nz / l) * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
  }
  const normal = new THREE.DataTexture(data, NW, NH, THREE.RGBAFormat);
  normal.wrapS = THREE.RepeatWrapping;
  normal.generateMipmaps = true;
  normal.minFilter = THREE.LinearMipmapLinearFilter;
  normal.magFilter = THREE.LinearFilter;
  normal.needsUpdate = true;
  return (cache.tire = { map, normal });
}

// Cross-drilled / slotted brake disc face (planar UV over the disc).
export function getDiscTexture() {
  if (cache.disc) return cache.disc;
  const N = 512;
  const cv = canvas(N, N);
  const ctx = cv.getContext('2d');
  const c = N / 2;
  ctx.fillStyle = '#2a2b2e';
  ctx.fillRect(0, 0, N, N);
  // friction ring with fine concentric machining
  for (let r = c * 0.52; r < c; r += 1.5) {
    ctx.strokeStyle = `rgba(${150 + Math.random() * 40},${150 + Math.random() * 40},${155 + Math.random() * 40},0.25)`;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // heat tint band
  const g = ctx.createRadialGradient(c, c, c * 0.5, c, c, c);
  g.addColorStop(0, 'rgba(60,40,90,0.25)');
  g.addColorStop(0.5, 'rgba(120,80,40,0.12)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, N, N);
  // drilled holes in 3 staggered rings (spiral)
  ctx.fillStyle = '#050506';
  const nSpokes = 24;
  for (let i = 0; i < nSpokes; i++) {
    for (let k = 0; k < 3; k++) {
      const a = (i / nSpokes) * Math.PI * 2 + k * 0.07;
      const r = c * (0.62 + k * 0.12);
      ctx.beginPath();
      ctx.arc(c + Math.cos(a) * r, c + Math.sin(a) * r, N * 0.009, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // hat (inner) darker anodised
  ctx.fillStyle = '#141416';
  ctx.beginPath();
  ctx.arc(c, c, c * 0.5, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return (cache.disc = tex);
}

// Soft contact shadow under the car: rounded footprint + darker tire contact blobs.
export function getShadowTexture(wheelPts, sizeX, sizeZ) {
  if (cache.shadow) return cache.shadow;
  const W = 256;
  const H = 512;
  const cv = canvas(W, H);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const toPx = (x, z) => [(0.5 - x / sizeX) * W, (0.5 - z / sizeZ) * H];
  ctx.filter = 'blur(14px)';
  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  const rw = (1.86 / sizeX) * W;
  const rh = (4.3 / sizeZ) * H;
  ctx.beginPath();
  ctx.roundRect((W - rw) / 2, (H - rh) / 2, rw, rh, 40);
  ctx.fill();
  ctx.filter = 'blur(6px)';
  ctx.fillStyle = 'rgba(0,0,0,0.9)';
  for (const p of wheelPts) {
    const [x, y] = toPx(p.x, p.z);
    ctx.beginPath();
    ctx.ellipse(x, y, (0.17 / sizeX) * W, (0.3 / sizeZ) * H, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.filter = 'none';
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return (cache.shadow = tex);
}

// ------------------------------------------------------------------------------------------------
// Low-beam headlamp. One analytic intensity profile drives both the player's SpotLight cookie (SpotLight.map)
// and the additive road decal every car paints, so AI pools and the real lights look the same.
// ------------------------------------------------------------------------------------------------
const D2R = Math.PI / 180;
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// Lamp geometry shared with carModel (car-local, metres): the SpotLights sit here and the decal is computed from it.
export const HEADLAMP = { x: 0.8, y: 0.63, z: 1.92, angle: 0.8, penumbra: 0.62 };

function lowBeamRaw(thetaDeg, downDeg) {
  // cut-off line: 0.55° below the horizon on the left / centre, rising with the classic 15° kink on the
  // right (kerb) side to ~1° above it. Soft (≈1.8° wide) like a real projector edge, not a hard line.
  const cutoff = 0.6 - 1.7 * sstep(-1, 8, thetaDeg);
  const cut = sstep(cutoff - 0.9, cutoff + 0.9, downDeg);
  // below the cut-off the intensity falls ~δ^-3 so road illuminance (∝ I·sin³δ) stays even from ~4 m to ~15 m,
  // then fades out over 15–45 m; the steepest rays (right under the bumper) are clipped by the reflector
  const body = (1 / (1 + Math.pow(Math.max(downDeg, 0) / 2.2, 3.0))) * (1 - 0.7 * sstep(13, 28, downDeg));
  // a little stray light above the cut-off (lights signs / the car ahead softly instead of nothing)
  const glare = 0.05 * Math.exp(-Math.max(0, cutoff - downDeg) / 3);
  // horizontal: hot zone a touch right of centre + a broad, dimmer spread that lights the kerbs up close
  const a = Math.abs(thetaDeg);
  const h = 0.5 * Math.exp(-(((thetaDeg - 1.5) / 13) ** 2)) + 0.5 * Math.exp(-((a / 40) ** 2.5));
  return h * (cut * body + (1 - cut) * glare);
}
const RAW0 = lowBeamRaw(0, 0);
/**
 * Relative low-beam intensity in the lamp frame (+Z forward). tx = tan(horizontal angle), + = car's RIGHT;
 * ty = tan(vertical angle), + = up. 1.0 = straight ahead on the horizon (the SpotLight's `intensity` is
 * the candela in that direction); the hot zone just below the cut-off reaches ≈ 5.7.
 */
export function lowBeamProfile(tx, ty) {
  const theta = Math.atan(tx) / D2R;
  const down = -Math.atan(ty / Math.sqrt(1 + tx * tx)) / D2R;
  return lowBeamRaw(theta, down) / RAW0;
}

// Light cookie for SpotLight.map: projected through the spot's (square) shadow frustum, fov = 2·angle.
// Half-float so the hot zone can exceed the horizon reference (1.0) without losing the dim near field.
export function getHeadlightCookie(angle = HEADLAMP.angle) {
  const key = 'cookie' + angle;
  if (cache[key]) return cache[key];
  const W = 128;
  const H = 512;
  const T = Math.tan(angle);
  const data = new Uint16Array(W * H * 4);
  const toHalf = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < H; j++) {
    const ty = ((j + 0.5) / H * 2 - 1) * T; // row 0 = bottom of the frustum (looking down)
    for (let i = 0; i < W; i++) {
      const tx = ((i + 0.5) / W * 2 - 1) * T; // column 0 = car's left
      const m = lowBeamProfile(tx, ty);
      // projector lenses fringe slightly blue right at the cut-off
      const theta = Math.atan(tx) / D2R;
      const down = -Math.atan(ty / Math.sqrt(1 + tx * tx)) / D2R;
      const cutoff = 0.6 - 1.7 * sstep(-1, 8, theta);
      const fringe = Math.exp(-(((down - cutoff + 0.35) / 0.5) ** 2));
      const o = (j * W + i) * 4;
      data[o] = toHalf(m * (1 - 0.22 * fringe));
      data[o + 1] = toHalf(m * (1 - 0.06 * fringe));
      data[o + 2] = toHalf(m * (1 + 0.12 * fringe));
      data[o + 3] = toHalf(1);
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return (cache[key] = tex);
}

// Road illuminance of the two low beams (relative, max 1) at car-local ground point (x, z).
export function lowBeamGround(x, z, lamp = HEADLAMP) {
  const cOut = Math.cos(lamp.angle);
  const cIn = Math.cos(lamp.angle * (1 - lamp.penumbra));
  let e = 0;
  for (const s of [1, -1]) {
    const dx = x - s * lamp.x;
    const dz = z - lamp.z;
    if (dz <= 0.05) continue;
    const r = Math.hypot(dx, lamp.y, dz);
    const cone = sstep(cOut, cIn, dz / r);
    if (cone <= 0) continue;
    e += lowBeamProfile(-dx / dz, -lamp.y / dz) * cone * (lamp.y / r) / (r * r);
  }
  return e;
}

// Headlight pool decal on the road (additive), computed from the same low-beam profile as the real lights.
// Geometry: trapezoid z0..z1 ahead of the car, half-width w0..w1; texture u = 1 at x = −w (car's right), v along.
export const BEAM_DECAL = { z0: 2.0, z1: 38, w0: 2.4, w1: 24 };
export function getConeTexture() {
  if (cache.cone) return cache.cone;
  const W = 128;
  const H = 256;
  const { z0, z1, w0, w1 } = BEAM_DECAL;
  const vals = new Float32Array(W * H);
  let max = 0;
  for (let y = 0; y < H; y++) {
    const t = 1 - y / (H - 1); // canvas row 0 = far end (v = 1)
    const z = z0 + (z1 - z0) * t;
    const w = w0 + (w1 - w0) * t;
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const e = lowBeamGround(w * (1 - 2 * u), z);
      vals[y * W + x] = e;
      if (e > max) max = e;
    }
  }
  const cv = canvas(W, H);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const t = 1 - y / (H - 1);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      // fade to zero at the decal's own borders so the trapezoid never shows; the far beam is toned down a bit
      // more than E: seen from behind, wet asphalt only returns the dim diffuse part, so a long even pool reads
      // as a beige wash rather than headlight light
      const z = z0 + (z1 - z0) * t;
      const edge = (1 - sstep(0.82, 1, Math.abs(1 - 2 * u))) * (1 - sstep(0.85, 1, t)) * sstep(0, 0.04, t) * (1 - 0.55 * sstep(12, 34, z));
      const lin = (vals[y * W + x] / max) * edge;
      const srgb = lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
      const o = (y * W + x) * 4;
      img.data[o] = 255 * srgb;
      img.data[o + 1] = 250 * srgb;
      img.data[o + 2] = 238 * srgb;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return (cache.cone = tex);
}

// Nitro flame: white-hot core → blue → transparent (u across, v along the flame).
export function getFlameTexture() {
  if (cache.flame) return cache.flame;
  const W = 64;
  const H = 256;
  const cv = canvas(W, H);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1); // 0 = nozzle (bottom row in v after flip) … 1 = tip
    for (let x = 0; x < W; x++) {
      const u = Math.abs(x / (W - 1) - 0.5) * 2;
      const core = Math.exp(-((u / (0.35 * (1 - t) + 0.05)) ** 2));
      const fade = Math.pow(1 - t, 1.6);
      const o = ((H - 1 - y) * W + x) * 4;
      const hot = Math.exp(-t * 7);
      img.data[o] = 255 * Math.min(1, 0.35 + hot * 0.8) * core;
      img.data[o + 1] = 255 * Math.min(1, 0.55 + hot * 0.6) * core;
      img.data[o + 2] = 255 * core;
      img.data[o + 3] = 255 * core * fade;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return (cache.flame = tex);
}

// Rain beads: tileable normal map of small hemispherical droplets (for the clearcoat and the glass).
export function getDropletNormalTexture() {
  if (cache.drops) return cache.drops;
  const N = 512;
  const h = new Float32Array(N * N);
  let seed = 1337;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 520; i++) {
    const cx = rnd() * N;
    const cy = rnd() * N;
    const r = 2.2 + Math.pow(rnd(), 2.0) * 7.5;
    const sq = 0.75 + rnd() * 0.5; // slight elongation
    const x0 = Math.floor(cx - r - 1);
    const x1 = Math.ceil(cx + r + 1);
    const y0 = Math.floor(cy - r * sq - 1);
    const y1 = Math.ceil(cy + r * sq + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - cx) / r;
        const dy = (y - cy) / (r * sq);
        const d2 = dx * dx + dy * dy;
        if (d2 >= 1) continue;
        const v = Math.sqrt(1 - d2) * r * 0.5;
        const k = ((y + N) % N) * N + ((x + N) % N);
        if (v > h[k]) h[k] = v;
      }
    }
  }
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const hl = h[y * N + ((x - 1 + N) % N)];
      const hr = h[y * N + ((x + 1) % N)];
      const hu = h[((y - 1 + N) % N) * N + x];
      const hd = h[((y + 1) % N) * N + x];
      const nx = (hl - hr) * 0.9;
      const ny = (hu - hd) * 0.9;
      const l = Math.hypot(nx, ny, 1);
      const o = (y * N + x) * 4;
      data[o] = (nx / l * 0.5 + 0.5) * 255;
      data[o + 1] = (ny / l * 0.5 + 0.5) * 255;
      data[o + 2] = (1 / l * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return (cache.drops = tex);
}

// Time-averaged look of a spinning twin-spoke rim (radial bands), used as a speed-blur disc over the wheel face.
export function getRimBlurTexture() {
  if (cache.rimBlur) return cache.rimBlur;
  const N = 256;
  const cv = canvas(N, N);
  const ctx = cv.getContext('2d');
  const c = N / 2;
  const img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const r = Math.hypot(x + 0.5 - c, y + 0.5 - c) / c; // 0..1 → 0 … 0.245 m
      const rm = r * 0.245;
      let lum = 0;
      let a = 0;
      if (rm < 0.07) { lum = 0.1; a = 0.0; } // hub / centre lock stay crisp underneath
      else if (rm < 0.235) {
        // spokes cover ~35 % of the circumference near the hub, ~25 % near the rim
        const cover = 0.42 - 0.18 * ((rm - 0.07) / 0.165);
        lum = 0.22 + 0.7 * cover;
        a = 0.86 + 0.12 * cover;
      } else if (rm < 0.245) { lum = 0.85; a = 0.9; }
      const o = (y * N + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.round(255 * lum);
      img.data[o + 3] = Math.round(255 * a);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return (cache.rimBlur = tex);
}
