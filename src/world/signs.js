// MIDNIGHT APEX — neon signage: canvas-rendered neon tubes (invented names, katakana/kanji blade signs,
// arrows, icons) packed in one atlas, mounted on the street-frontage buildings as wall signs and
// perpendicular blade signs; rooftop billboards lit from below; big animated LED screens downtown;
// neon strip lines along shop fronts. Draw calls: neon (1) + sign boards (1) + billboards (1) + screens (1).
import * as THREE from 'three';
import { mulberry32, makeCanvas, canvasTexture } from './textures.js';

const NEON = {
  magenta: '#ff2bd6',
  pink: '#ff4f9a',
  cyan: '#22e8ff',
  blue: '#3f7bff',
  violet: '#a24dff',
  amber: '#ffb020',
  red: '#ff2a2a',
  green: '#39ff7a',
  white: '#f2f6ff',
};
const COLS = Object.values(NEON);

const H_SIGNS = [
  ['NEON NOODLE', 'magenta'], ['HOTEL ZENITH', 'cyan'], ['KARAOKE', 'pink'], ['CLUB VOLT', 'blue'],
  ['RAMEN 24H', 'amber'], ['CYBER CAFE', 'cyan'], ['MOTEL', 'red'], ['LIQUOR', 'green'],
  ['PHARMACY', 'green'], ['BAR', 'pink'], ['SUSHI', 'amber'], ['ARCADE', 'violet'],
  ['OPEN', 'red'], ['TATTOO', 'magenta'], ['DINER', 'cyan'], ['PIZZA', 'amber'],
  ['JAZZ', 'blue'], ['LOUNGE', 'violet'], ['PACHI-PARK', 'magenta'], ['GARAGE 9', 'amber'],
  ['NIGHT OWL', 'cyan'], ['DUMPLINGS', 'red'], ['VINYL', 'violet'], ['24H', 'green'],
];
const V_SIGNS = [
  ['ラーメン', 'red'], ['カラオケ', 'magenta'], ['ホテル', 'cyan'], ['居酒屋', 'amber'],
  ['寿司', 'pink'], ['薬局', 'green'], ['ネオン', 'violet'], ['酒場', 'amber'],
  ['ゲーム', 'blue'], ['焼肉', 'red'], ['喫茶', 'cyan'], ['BAR', 'magenta'],
  ['夜', 'pink'], ['麺', 'amber'], ['24H', 'green'], ['HOTEL', 'blue'],
];
const ADS = [
  { title: 'NIGHTSHIFT', sub: 'ENERGY DRINK', a: '#0b0030', b: '#ff2bd6', c: '#22e8ff' },
  { title: 'AURORA', sub: 'NEW  EV  COUPE', a: '#001820', b: '#00ffc8', c: '#ffffff' },
  { title: 'KAIJU', sub: 'IN CINEMAS FRIDAY', a: '#200400', b: '#ff5a00', c: '#ffd400' },
  { title: 'VOLTAGE', sub: 'RADIO 101.7 FM', a: '#100020', b: '#a24dff', c: '#ff4f9a' },
  { title: 'ZENITH', sub: 'SKY BAR  ·  58F', a: '#001030', b: '#3f7bff', c: '#ffffff' },
  { title: 'MIDNIGHT APEX', sub: 'STREET LEAGUE FINAL', a: '#05000c', b: '#ff2bd6', c: '#00e5ff' },
];

// ---------------------------------------------------------------------------------------------
// Atlas
// ---------------------------------------------------------------------------------------------

function neonText(g, text, x, y, size, color, { vertical = false, font = 'bold' } = {}) {
  g.save();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${font} ${size}px "Hiragino Sans", "Yu Gothic", "Arial Rounded MT Bold", "Helvetica Neue", Arial, sans-serif`;
  g.lineJoin = 'round';
  const draw = (fn) => {
    if (!vertical) fn(text, x, y);
    else {
      const chars = [...text];
      const step = size * 1.05;
      const y0 = y - ((chars.length - 1) * step) / 2;
      chars.forEach((ch, i) => fn(ch, x, y0 + i * step));
    }
  };
  // outer glow
  g.shadowColor = color;
  g.shadowBlur = size * 0.45;
  g.strokeStyle = color;
  g.lineWidth = size * 0.11;
  draw((t, a, b) => g.strokeText(t, a, b));
  g.shadowBlur = size * 0.18;
  draw((t, a, b) => g.strokeText(t, a, b));
  // hot tube core
  g.shadowBlur = 0;
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = size * 0.035;
  draw((t, a, b) => g.strokeText(t, a, b));
  g.restore();
}

function buildAtlas() {
  const W = 2048, H = 2048;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  const regions = { h: [], v: [], icon: [], strip: null };
  // horizontal signs: 4 × 6 cells of 512 × 160
  H_SIGNS.forEach(([text, col], i) => {
    const cx = (i % 4) * 512, cy = Math.floor(i / 4) * 160;
    const size = Math.min(92, 860 / Math.max(3, text.length));
    // frame tube on some signs
    if (i % 3 === 0) {
      g.save();
      g.shadowColor = NEON[col]; g.shadowBlur = 14; g.strokeStyle = NEON[col]; g.lineWidth = 5;
      g.strokeRect(cx + 22, cy + 22, 468, 116);
      g.restore();
    }
    neonText(g, text, cx + 256, cy + 82, size, NEON[col]);
    regions.h.push({ u0: cx / W, v0: 1 - (cy + 160) / H, u1: (cx + 512) / W, v1: 1 - cy / H, aspect: 512 / 160, col });
  });
  // vertical blade signs: 16 cells of 128 × 512 starting at y = 960
  V_SIGNS.forEach(([text, col], i) => {
    const cx = i * 128, cy = 960;
    const chars = [...text].length;
    const size = Math.min(84, 430 / chars);
    g.save();
    g.shadowColor = NEON[col]; g.shadowBlur = 10; g.strokeStyle = NEON[col]; g.lineWidth = 4;
    g.strokeRect(cx + 12, cy + 12, 104, 488);
    g.restore();
    neonText(g, text, cx + 64, cy + 256, size, NEON[col], { vertical: true });
    regions.v.push({ u0: cx / W, v0: 1 - (cy + 512) / H, u1: (cx + 128) / W, v1: 1 - cy / H, aspect: 128 / 512, col });
  });
  // icons / arrows: 256 × 256 cells at y = 1472
  const icons = ['arrow', 'cocktail', 'heart', 'star', 'circle24', 'arrowL', 'bolt', 'crown'];
  icons.forEach((kind, i) => {
    const cx = i * 256, cy = 1472;
    const col = NEON[['amber', 'cyan', 'pink', 'violet', 'green', 'magenta', 'blue', 'amber'][i]];
    g.save();
    g.translate(cx + 128, cy + 128);
    g.shadowColor = col; g.shadowBlur = 22; g.strokeStyle = col; g.lineWidth = 9; g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath();
    if (kind === 'arrow' || kind === 'arrowL') {
      const s = kind === 'arrow' ? 1 : -1;
      g.moveTo(-80 * s, -30); g.lineTo(20 * s, -30); g.lineTo(20 * s, -65); g.lineTo(90 * s, 0); g.lineTo(20 * s, 65); g.lineTo(20 * s, 30); g.lineTo(-80 * s, 30); g.closePath();
    } else if (kind === 'cocktail') {
      g.moveTo(-70, -70); g.lineTo(70, -70); g.lineTo(0, 10); g.closePath(); g.moveTo(0, 10); g.lineTo(0, 70); g.moveTo(-40, 72); g.lineTo(40, 72);
    } else if (kind === 'heart') {
      g.moveTo(0, 70); g.bezierCurveTo(-110, -10, -60, -90, 0, -35); g.bezierCurveTo(60, -90, 110, -10, 0, 70);
    } else if (kind === 'star') {
      for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2 - Math.PI / 2; const r = k % 2 ? 38 : 90; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.closePath();
    } else if (kind === 'circle24') {
      g.arc(0, 0, 90, 0, Math.PI * 2);
    } else if (kind === 'bolt') {
      g.moveTo(20, -95); g.lineTo(-45, 10); g.lineTo(5, 10); g.lineTo(-20, 95); g.lineTo(50, -15); g.lineTo(0, -15); g.closePath();
    } else if (kind === 'crown') {
      g.moveTo(-80, 50); g.lineTo(-80, -40); g.lineTo(-40, 0); g.lineTo(0, -60); g.lineTo(40, 0); g.lineTo(80, -40); g.lineTo(80, 50); g.closePath();
    }
    g.stroke();
    g.shadowBlur = 0; g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 3; g.stroke();
    if (kind === 'circle24') { g.restore(); neonText(g, '24H', cx + 128, cy + 130, 70, col); g.save(); g.translate(0, 0); }
    g.restore();
    regions.icon.push({ u0: cx / W, v0: 1 - (cy + 256) / H, u1: (cx + 256) / W, v1: 1 - cy / H, aspect: 1 });
  });
  // plain tube strip (for shop-front neon lines): a soft horizontal white line, y = 1760..1792
  {
    const y = 1776;
    const grd = g.createLinearGradient(0, y - 16, 0, y + 16);
    grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(0.42, 'rgba(255,255,255,0.35)'); grd.addColorStop(0.5, '#fff');
    grd.addColorStop(0.58, 'rgba(255,255,255,0.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, y - 16, W, 32);
    regions.strip = { u0: 0.02, v0: 1 - (y + 16) / H, u1: 0.98, v1: 1 - (y - 16) / H };
  }
  const tex = canvasTexture(c, { mips: true, aniso: 8 });
  return { tex, regions };
}

function buildAdAtlas() {
  // 3 × 2 posters of 512 × 256
  const W = 1536, H = 512;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  ADS.forEach((ad, i) => {
    const x = (i % 3) * 512, y = Math.floor(i / 3) * 256;
    const grd = g.createLinearGradient(x, y, x + 512, y + 256);
    grd.addColorStop(0, ad.a); grd.addColorStop(0.6, ad.a); grd.addColorStop(1, ad.b);
    g.fillStyle = grd;
    g.fillRect(x, y, 512, 256);
    // graphic: rings / stripes
    g.save();
    g.beginPath(); g.rect(x, y, 512, 256); g.clip();
    g.globalAlpha = 0.6;
    for (let k = 0; k < 7; k++) {
      g.strokeStyle = k % 2 ? ad.b : ad.c;
      g.lineWidth = 6;
      g.beginPath();
      g.arc(x + 400, y + 128, 30 + k * 28, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.fillStyle = ad.c;
    g.font = 'italic 900 64px "Arial Black", "Helvetica Neue", Arial, sans-serif';
    g.textBaseline = 'middle';
    g.shadowColor = ad.b; g.shadowBlur = 18;
    g.fillText(ad.title, x + 28, y + 110);
    g.shadowBlur = 0;
    g.font = 'bold 28px "Helvetica Neue", Arial, sans-serif';
    g.fillStyle = '#ffffff';
    g.fillText(ad.sub, x + 32, y + 172);
    g.restore();
  });
  return canvasTexture(c, { mips: true, aniso: 8 });
}

// ---------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------

function neonMaterial(tex, timeU) {
  return new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uMap: { value: tex }, uTime: timeU, uGain: { value: 5.0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
    vertexShader: /* glsl */ `
      attribute vec4 aSign; // tint.rgb, seed (≥ 10: steady, < 1: flickering)
      varying vec2 vUv;
      varying vec3 vTint;
      varying float vFlick;
      uniform float uTime;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vTint = aSign.rgb;
        float seed = aSign.a;
        float f = 1.0;
        if (seed < 1.0) {
          // broken tube: mostly on, with buzzing dropouts
          float t = uTime * (3.0 + seed * 5.0) + seed * 40.0;
          float n = fract(sin(floor(t) * 12.9898 + seed * 78.233) * 43758.5453);
          f = n < 0.25 ? 0.08 + 0.3 * fract(sin(t * 91.7) * 4375.5) : 1.0;
        } else if (seed < 2.0) {
          // slow breathing sign
          f = 0.65 + 0.35 * sin(uTime * 1.6 + seed * 9.0);
        }
        vFlick = f;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uGain;
      varying vec2 vUv;
      varying vec3 vTint;
      varying float vFlick;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        vec3 c = texture2D(uMap, vUv).rgb;
        // tint lets the white tube strip take any colour; coloured signs keep their own hue (tint = 1)
        vec3 col = c * vTint * vFlick * uGain;
        gl_FragColor = vec4(col, 1.0);
        #ifdef USE_FOG
          #ifdef FOG_EXP2
            float fogFactor = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);
          #else
            float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
          #endif
          gl_FragColor.rgb *= 1.0 - fogFactor * 0.85;
        #endif
      }`,
  });
}

function screenMaterial(tex, timeU) {
  return new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uMap: { value: tex }, uTime: timeU, uGain: { value: 2.6 } },
    fog: true,
    vertexShader: /* glsl */ `
      attribute vec4 aScr; // seed, pixel pitch scale, aspect, unused
      varying vec2 vUv;
      varying vec4 vScr;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vUv = uv; vScr = aScr;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uTime, uGain;
      varying vec2 vUv;
      varying vec4 vScr;
      #include <common>
      #include <fog_pars_fragment>
      vec3 ad(float idx, vec2 uv) {
        float i = mod(idx, 6.0);
        vec2 cell = vec2(mod(i, 3.0), 1.0 - floor(i / 3.0));
        return texture2D(uMap, (cell + clamp(uv, 0.002, 0.998)) / vec2(3.0, 2.0)).rgb;
      }
      void main() {
        float seed = vScr.x;
        float t = uTime + seed * 17.0;
        float slot = floor(t / 6.0);
        float ph = fract(t / 6.0);
        vec2 uv = vUv;
        // ken-burns drift + wipe transition between ads
        vec2 zuv = (uv - 0.5) * (1.0 - 0.06 * ph) + 0.5;
        vec3 a = ad(slot + seed * 3.0, zuv);
        vec3 b = ad(slot + 1.0 + seed * 3.0, uv);
        float wipe = smoothstep(0.9, 1.0, ph);
        float edge = step(uv.x, wipe);
        vec3 col = mix(a, b, edge);
        col += vec3(0.6, 0.9, 1.0) * (1.0 - smoothstep(0.0, 0.01, abs(uv.x - wipe))) * step(0.9, ph);
        // scanline + LED pixel grid
        vec2 px = uv * vec2(320.0 * vScr.z, 320.0);
        vec2 f = fract(px) - 0.5;
        float dotm = 1.0 - smoothstep(0.3, 0.5, max(abs(f.x), abs(f.y)));
        float lod = smoothstep(0.4, 1.0, max(fwidth(px.x), fwidth(px.y)));
        dotm = mix(dotm, 0.7, lod);
        col *= dotm * (0.92 + 0.08 * sin(uTime * 40.0 + uv.y * 300.0));
        gl_FragColor = vec4(col * uGain, 1.0);
        #include <fog_fragment>
      }`,
  });
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

class QuadAcc {
  constructor(extra = 4, name = 'aSign') { this.p = []; this.uv = []; this.e = []; this.n = []; this.i = []; this.v = 0; this.extra = extra; this.name = name; }
  /** Quad centered at c, horizontal axis ax (unit), up axis (unit), half sizes. */
  quad(c, ax, up, hw, hh, uvr, e, normal) {
    const b = this.v;
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const uvs = [[uvr.u0, uvr.v0], [uvr.u1, uvr.v0], [uvr.u1, uvr.v1], [uvr.u0, uvr.v1]];
    pts.forEach(([a, bb], k) => {
      this.p.push(c.x + ax.x * hw * a + up.x * hh * bb, c.y + ax.y * hw * a + up.y * hh * bb, c.z + ax.z * hw * a + up.z * hh * bb);
      this.uv.push(uvs[k][0], uvs[k][1]);
      this.e.push(...e);
      if (normal) this.n.push(normal.x, normal.y, normal.z);
    });
    this.i.push(b, b + 1, b + 2, b, b + 2, b + 3);
    this.v += 4;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute(this.name, new THREE.Float32BufferAttribute(this.e, this.extra));
    if (this.n.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

function boxGeo(parts, c, ax, up, nrm, w, h, d) {
  // oriented box: ax = width axis, up, nrm = depth axis
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Matrix4().makeBasis(ax, up, nrm).setPosition(c);
  g.applyMatrix4(m);
  parts.push(g);
}

// ---------------------------------------------------------------------------------------------
// createSigns
// ---------------------------------------------------------------------------------------------

export function createSigns({ track, city, shared, quality = 'high' } = {}) {
  const group = new THREE.Group();
  group.name = 'signs';
  if (!city) return { group, reflectHidden: [], adTexture: null, update() {} };
  const rnd = mulberry32(2025);
  const R = (a, b) => a + (b - a) * rnd();
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const { tex, regions } = buildAtlas();
  const timeU = shared.uniforms.uTime;
  const neon = new QuadAcc(4, 'aSign');
  const boardParts = [];
  const bbAcc = new QuadAcc(4, 'aScr');
  const screenAcc = new QuadAcc(4, 'aScr');
  const UPV = new THREE.Vector3(0, 1, 0);
  const white = [1, 1, 1];
  const hexToRgb = (h) => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; };
  const flick = () => (rnd() < 0.1 ? rnd() * 0.99 : rnd() < 0.1 ? 1 + rnd() * 0.99 : 10);

  let screens = 0, billboards = 0, crowns = 0;
  for (const f of city.frontage) {
    const n = new THREE.Vector3(f.nx, 0, f.nz); // facade normal (toward the road)
    const t = new THREE.Vector3().crossVectors(UPV, n).normalize(); // facade horizontal axis (viewer's right)
    const face = new THREE.Vector3(f.x, 0, f.z);
    const density = f.zone === 'alley' ? 1.0 : f.zone === 'downtown' ? 0.75 : f.zone === 'east' ? 0.6 : 0.35;
    const w = f.width;
    // shop-front neon strip just above the storefront band
    if (rnd() < 0.45 * density + 0.1) {
      const col = hexToRgb(pick(COLS));
      const c = face.clone().addScaledVector(n, 0.12); c.y = 5.15;
      neon.quad(c, t, UPV, w * 0.46, 0.1, regions.strip, [...col.map((v) => v * 0.55), flick()]);
    }
    // wall sign(s)
    const nWall = rnd() < density ? (w > 22 && rnd() < 0.5 ? 2 : 1) : 0;
    for (let k = 0; k < nWall; k++) {
      const r = pick(regions.h);
      const sw = Math.min(w * 0.8, R(4, 8.5)), sh = sw / r.aspect;
      const along = nWall === 1 ? R(-0.2, 0.2) * (w - sw) : (k === 0 ? -0.25 : 0.25) * w;
      const y = R(6.2, Math.min(14, f.height - sh - 1));
      if (y < 6) continue;
      const c = face.clone().addScaledVector(t, along).addScaledVector(n, 0.35); c.y = y;
      neon.quad(c, t, UPV, sw / 2, sh / 2, r, [...white, flick()]);
      boxGeo(boardParts, c.clone().addScaledVector(n, -0.18), t, UPV, n, sw + 0.3, sh + 0.25, 0.3);
    }
    // blade signs (perpendicular, double-sided)
    const nBlade = rnd() < density * (f.zone === 'alley' ? 1.0 : 0.55) ? (f.zone === 'alley' && w > 16 ? 2 : 1) : 0;
    for (let k = 0; k < nBlade; k++) {
      const r = pick(regions.v);
      const sh = R(3.6, 6.5), sw = sh * r.aspect * 1.25;
      const along = (nBlade === 1 ? R(-0.4, 0.4) : k === 0 ? -0.33 : 0.33) * w;
      const y = R(6.5, Math.min(16, Math.max(7, f.height - sh / 2 - 1)));
      const c = face.clone().addScaledVector(t, along).addScaledVector(n, 0.5 + sw / 2); c.y = y;
      // two faces, readable from both travel directions
      neon.quad(c.clone().addScaledVector(t, 0.08), n.clone().negate(), UPV, sw / 2, sh / 2, r, [...white, flick()]);
      neon.quad(c.clone().addScaledVector(t, -0.08), n, UPV, sw / 2, sh / 2, r, [...white, flick()]);
      boxGeo(boardParts, c, n, UPV, t.clone().negate(), sw + 0.2, sh + 0.2, 0.12);
      boxGeo(boardParts, c.clone().addScaledVector(n, -sw / 2 - 0.25), t, UPV, n, 0.12, 0.12, 0.6); // bracket
    }
    // icon
    if (rnd() < 0.18 * density) {
      const r = pick(regions.icon);
      const s = R(1.6, 2.8);
      const c = face.clone().addScaledVector(t, R(-0.4, 0.4) * w).addScaledVector(n, 0.3); c.y = R(6, 10);
      neon.quad(c, t, UPV, s / 2, s / 2, r, [...white, flick()]);
    }
    // giant rooftop neon on tall towers facing the circuit (reads from far away)
    if (f.height > 50 && w > 16 && crowns < 12 && rnd() < 0.3) {
      const r = pick(regions.h);
      const sw = Math.min(w * 0.92, R(18, 28)), sh = sw / r.aspect;
      const c = face.clone().addScaledVector(n, -1.5); c.y = f.height + 1.4 + sh / 2;
      neon.quad(c, t, UPV, sw / 2, sh / 2, r, [1.2, 1.2, 1.2, rnd() < 0.15 ? 1.5 : 10]);
      boxGeo(boardParts, c.clone().addScaledVector(n, -0.3), t, UPV, n, sw * 0.96, 0.3, 0.3);
      for (const k of [-0.4, 0, 0.4]) {
        const leg = c.clone().addScaledVector(t, k * sw).addScaledVector(n, -0.4); leg.y = f.height + (1.4 + sh) / 2;
        boxGeo(boardParts, leg, t, UPV, n, 0.25, 1.4 + sh, 0.25);
      }
      crowns++;
    }
    // big LED screens on tall downtown facades along the boulevard
    if (f.zone === 'downtown' && f.height > 45 && w > 18 && screens < 7 && rnd() < 0.5) {
      const vertical = rnd() < 0.4;
      const sw = vertical ? Math.min(w * 0.6, 11) : Math.min(w * 0.85, 24);
      const sh = vertical ? sw * 1.6 : sw / 2;
      const c = face.clone().addScaledVector(n, 0.45); c.y = Math.min(f.height - sh / 2 - 3, R(16, 30));
      screenAcc.quad(c, t, UPV, sw / 2, sh / 2, { u0: 0, v0: 0, u1: 1, v1: 1 }, [rnd() * 10, 1, sw / sh, 0]);
      boxGeo(boardParts, c.clone().addScaledVector(n, -0.25), t, UPV, n, sw + 0.8, sh + 0.8, 0.5);
      screens++;
    }
    // rooftop billboards on low buildings
    if (f.height < 34 && f.height > 10 && w > 14 && billboards < 26 && rnd() < 0.3) {
      const bw = Math.min(w * 0.85, R(10, 15)), bh = bw / 2;
      const c = face.clone().addScaledVector(n, -3); c.y = f.height + 2.5 + bh / 2;
      bbAcc.quad(c, t, UPV, bw / 2, bh / 2, { u0: 0, v0: 0, u1: 1, v1: 1 }, [rnd() * 10, 0, bw / bh, 1], n);
      boxGeo(boardParts, c.clone().addScaledVector(n, -0.2), t, UPV, n, bw + 0.5, bh + 0.5, 0.3);
      for (const s of [-0.35, 0.35]) {
        const leg = c.clone().addScaledVector(t, s * bw).addScaledVector(n, -0.6); leg.y = f.height + (2.5) / 2 + 0.6;
        boxGeo(boardParts, leg, t, UPV, n, 0.3, 2.5 + 1.2, 0.3);
      }
      // lamp bar under the billboard
      const lb = c.clone().addScaledVector(n, 0.9); lb.y = c.y - bh / 2 - 0.3;
      boxGeo(boardParts, lb, t, UPV, n, bw, 0.12, 0.25);
      billboards++;
    }
  }

  // neon
  const neonMesh = new THREE.Mesh(neon.build(), neonMaterial(tex, timeU));
  neonMesh.name = 'neonSigns';
  neonMesh.frustumCulled = false;
  neonMesh.renderOrder = 2;
  group.add(neonMesh);
  // sign boards / frames / brackets
  if (boardParts.length) {
    const merged = mergeBoxes(boardParts);
    const boards = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0x0b0c10, roughness: 0.5, metalness: 0.6 }));
    boards.name = 'signBoards';
    boards.castShadow = true;
    group.add(boards);
  }
  // billboards (printed posters lit from below) and LED screens share the ad atlas
  const adTex = buildAdAtlas();
  let bbMesh = null, scrMesh = null;
  if (bbAcc.v) {
    const m = screenMaterial(adTex, timeU);
    m.uniforms.uGain.value = 1.3;
    bbMesh = new THREE.Mesh(bbAcc.build(), m);
    bbMesh.name = 'billboards';
    group.add(bbMesh);
  }
  if (screenAcc.v) {
    scrMesh = new THREE.Mesh(screenAcc.build(), screenMaterial(adTex, timeU));
    scrMesh.name = 'ledScreens';
    group.add(scrMesh);
  }
  return {
    group,
    neon: neonMesh,
    adTexture: adTex,
    reflectHidden: [],
    update() {},
  };
}

function mergeBoxes(parts) {
  // lightweight merge (positions + normals + uv) without the addon import
  let nv = 0, ni = 0;
  for (const g of parts) { nv += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, ov * 3);
    nor.set(g.attributes.normal.array, ov * 3);
    const ia = g.index.array;
    for (let k = 0; k < ia.length; k++) idx[oi + k] = ia[k] + ov;
    ov += g.attributes.position.count;
    oi += ia.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
