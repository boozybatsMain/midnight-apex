// MIDNIGHT APEX — procedural texture helpers for the world (noise fields, asphalt, concrete, canvas utils).
// Everything is generated at runtime; nothing here runs at import time.
import * as THREE from 'three';

// ---------------------------------------------------------------------------------------------
// Deterministic RNG + tileable noise
// ---------------------------------------------------------------------------------------------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash → [0,1). Same formula is mirrored in GLSL where needed. */
export function hash1(n) {
  let x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/** Tileable value-noise fBm on a size×size grid; basePeriod lattice cells across the tile. Returns [0,1]. */
export function tileableFbm(size, basePeriod, octaves, seed = 1, gain = 0.5, lacunarity = 2) {
  const out = new Float32Array(size * size);
  const rnd = mulberry32(seed);
  let amp = 1, total = 0, period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    const P = Math.max(1, Math.round(period));
    const lat = new Float32Array(P * P);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    const scale = P / size;
    for (let y = 0; y < size; y++) {
      const fy = y * scale, iy = Math.floor(fy), ty = fy - iy;
      const sy = ty * ty * (3 - 2 * ty);
      const y0 = iy % P, y1 = (iy + 1) % P;
      for (let x = 0; x < size; x++) {
        const fx = x * scale, ix = Math.floor(fx), tx = fx - ix;
        const sx = tx * tx * (3 - 2 * tx);
        const x0 = ix % P, x1 = (ix + 1) % P;
        const a = lat[y0 * P + x0], b = lat[y0 * P + x1], c = lat[y1 * P + x0], d = lat[y1 * P + x1];
        out[y * size + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
    }
    total += amp;
    amp *= gain;
    period *= lacunarity;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Normalize a float field to [0,1] (contrast stretch). */
export function normalizeField(f) {
  let lo = Infinity, hi = -Infinity;
  for (const v of f) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const k = 1 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) * k;
  return f;
}

function dataTex(data, size, { srgb = false, repeat = true, mips = true, aniso = 8, filter = true } = {}) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : filter ? THREE.LinearFilter : THREE.NearestFilter;
  t.magFilter = filter ? THREE.LinearFilter : THREE.NearestFilter;
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Asphalt micro detail: RG = tangent-space normal (xy), B = albedo variation, A = roughness variation.
// One tile = 4 m × 4 m (512 px → 7.8 mm / px).
// ---------------------------------------------------------------------------------------------
export function createAsphaltDetailTexture(size = 512, seed = 7) {
  const rnd = mulberry32(seed);
  const h = tileableFbm(size, 64, 4, seed, 0.55);
  const fine = tileableFbm(size, 192, 2, seed + 1, 0.5);
  const alb = new Float32Array(size * size).fill(0.5);
  const rough = tileableFbm(size, 16, 3, seed + 2, 0.5);
  for (let i = 0; i < h.length; i++) h[i] = h[i] * 0.6 + fine[i] * 0.4;
  // Aggregate stones: small rounded bumps with lighter/darker tint.
  const stones = Math.round(size * size * 0.018);
  for (let n = 0; n < stones; n++) {
    const cx = rnd() * size, cy = rnd() * size;
    const r = 1.2 + rnd() * rnd() * 4.5;
    const tint = (rnd() - 0.35) * 0.9;
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx, dy = y - cy, d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const k = 1 - d2 / r2;
        const idx = (((y % size) + size) % size) * size + (((x % size) + size) % size);
        h[idx] += Math.sqrt(k) * 0.35;
        alb[idx] += tint * k;
        rough[idx] -= 0.25 * k; // polished stone tops
      }
    }
  }
  const data = new Uint8Array(size * size * 4);
  const strength = 3.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const xl = y * size + ((x - 1 + size) % size), xr = y * size + ((x + 1) % size);
      const yu = ((y - 1 + size) % size) * size + x, yd = ((y + 1) % size) * size + x;
      let nx = -(h[xr] - h[xl]) * strength, ny = -(h[yd] - h[yu]) * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l;
      data[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(alb[i] * 255)));
      data[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(rough[i] * 255)));
    }
  }
  return dataTex(data, size, { aniso: 16 });
}

// ---------------------------------------------------------------------------------------------
// Macro field (one tile = 48 m): R = puddle field, G = stain / patch field, B = tar seams & cracks,
// A = paint wear / wetness variation.
// ---------------------------------------------------------------------------------------------
export function createMacroTexture(size = 1024, seed = 21) {
  const rnd = mulberry32(seed);
  const puddle = normalizeField(tileableFbm(size, 6, 5, seed, 0.55));
  const stain = normalizeField(tileableFbm(size, 4, 5, seed + 5, 0.6));
  const wear = normalizeField(tileableFbm(size, 24, 4, seed + 9, 0.6));
  const seams = new Float32Array(size * size);
  // Tar crack-seal lines: meandering random walks (1–2 px ≈ 5–9 cm wide).
  const walks = 26;
  for (let w = 0; w < walks; w++) {
    let x = rnd() * size, y = rnd() * size;
    let a = rnd() * Math.PI * 2;
    const steps = 60 + Math.floor(rnd() * 260);
    const width = 0.45 + rnd() * 0.7;
    for (let s = 0; s < steps; s++) {
      a += (rnd() - 0.5) * 0.35;
      x += Math.cos(a) * 1.2;
      y += Math.sin(a) * 1.2;
      if (rnd() < 0.006) a += (rnd() - 0.5) * 2.5; // branch-like kinks
      const r = width;
      for (let yy = Math.floor(y - r - 1); yy <= Math.ceil(y + r + 1); yy++) {
        for (let xx = Math.floor(x - r - 1); xx <= Math.ceil(x + r + 1); xx++) {
          const d = Math.hypot(xx - x, yy - y);
          const v = Math.max(0, Math.min(1, r + 0.5 - d));
          const idx = (((yy % size) + size) % size) * size + (((xx % size) + size) % size);
          if (v > seams[idx]) seams[idx] = v;
        }
      }
    }
  }
  // Rectangular repair patches (encoded in G as > 0.85 plateaus).
  for (let p = 0; p < 9; p++) {
    const w = 30 + rnd() * 70, hgt = 20 + rnd() * 60;
    const x0 = rnd() * size, y0 = rnd() * size;
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
      const idx = (((Math.floor(y0 + y)) % size) * size) + (Math.floor(x0 + x) % size);
      const edge = Math.min(x, y, w - x, hgt - y);
      stain[idx] = Math.max(stain[idx], edge < 1.5 ? 0.97 : 0.9);
    }
  }
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.round(puddle[i] * 255);
    data[i * 4 + 1] = Math.round(stain[i] * 255);
    data[i * 4 + 2] = Math.round(seams[i] * 255);
    data[i * 4 + 3] = Math.round(wear[i] * 255);
  }
  return dataTex(data, size, { aniso: 8 });
}

// ---------------------------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------------------------

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function canvasTexture(canvas, { srgb = true, repeat = false, mips = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/** Soft round sprite (radial falloff) — used for halos, glows, steam. */
export function createGlowTexture(size = 128, falloff = 2.2) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1;
    const r = Math.min(1, Math.hypot(dx, dy));
    const v = Math.pow(1 - r, falloff);
    const i = (y * size + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    img.data[i + 3] = Math.round(v * 255);
  }
  g.putImageData(img, 0, 0);
  return canvasTexture(c, { srgb: false });
}
