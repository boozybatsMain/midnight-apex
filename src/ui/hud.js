// MIDNIGHT APEX — HUD & menus (owner: hud).
//
// A DOM/CSS overlay plus two small 2D canvases (tachometer, minimap), all inside one root div that has
// pointer-events: none (only the interactive overlays — title menu, pause, results — accept input).
//
// Performance rules followed here:
//   * update() never reads layout; canvas backing sizes come from a ResizeObserver.
//   * textContent is only written when the formatted string actually changes (setText cache).
//   * the tachometer composites two cached static layers + a few dynamic strokes and skips the redraw
//     entirely when the needle / nitro did not visibly move; the minimap is one path + a few dots.
//   * pop/pulse effects use the Web Animations API (compositor-friendly transforms, no forced reflow).
import './hud.css';
import { CONFIG, clamp, lerp, damp, wrapAngle } from '../config.js';

const FONT_ID = 'mx-hud-fonts';
const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,500;0,600;0,700;0,800;1,500;1,600;1,700;1,800;1,900&family=Russo+One&display=swap';
const NUM_FONT = '"Barlow Condensed", "DIN Condensed", "Arial Narrow", "Roboto Condensed", sans-serif';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const CYAN = '#00e5ff';
const RED = '#ff2d55';
const GREEN = '#3dff8f';

// Tachometer dial geometry (canvas angles: 0 = +x, clockwise, y down).
const TACH_A0 = 135 * DEG; // "0" sits bottom-left
const TACH_SWEEP = 270 * DEG; // to bottom-right; the 90° gap at the bottom holds the gear indicator
const NOS_A0 = 122 * DEG; // nitro arc hugs the left side of the dial, filling upward
const NOS_A1 = 232 * DEG;
const NOS_SEGS = 14;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------
function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/** Write textContent only when it changed (cached on the element). */
function setText(e, v) {
  if (e._v !== v) {
    e._v = v;
    e.textContent = v;
  }
}

/** Seconds → "m:ss.mmm" (floored so the clock never shows a future millisecond). */
export function fmtTime(t) {
  if (t == null || !Number.isFinite(t) || t < 0) return '-:--.---';
  const ms = Math.floor(t * 1000 + 1e-6);
  const m = Math.floor(ms / 60000);
  const s = Math.floor(ms / 1000) % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}.${String(ms % 1000).padStart(3, '0')}`;
}

function fmtDelta(d) {
  const sign = d < 0 ? '−' : '+';
  const a = Math.abs(d);
  return a >= 60 ? sign + fmtTime(a) : `${sign}${a.toFixed(3)}`;
}

export function ordinal(n) {
  const v = Math.abs(n) % 100;
  if (v >= 11 && v <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][v % 10] || 'th';
}

/** Accepts 0xRRGGBB numbers, CSS strings or THREE.Color. */
function cssColor(c, fallback = '#ffffff') {
  if (typeof c === 'number' && Number.isFinite(c)) return '#' + (c & 0xffffff).toString(16).padStart(6, '0');
  if (typeof c === 'string' && c) return c;
  if (c && typeof c.getHexString === 'function') return '#' + c.getHexString();
  return fallback;
}

const validTime = (t) => (typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null);
const gearLabel = (g) => (g == null ? 'N' : g < 0 ? 'R' : g === 0 ? 'N' : String(g | 0));

// Deterministic PRNG for decorative randomness (stable screenshots).
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

let fontPromise = null;
/** Inject the Google Fonts stylesheet once and resolve when the faces used by the canvases are ready. */
function loadFonts() {
  if (fontPromise) return fontPromise;
  fontPromise = new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve();
    const head = document.head || document.documentElement;
    const done = () => {
      const fs = document.fonts;
      if (!fs || !fs.load) return resolve();
      const faces = ['italic 700 20px "Barlow Condensed"', 'italic 800 20px "Barlow Condensed"', '700 20px "Barlow Condensed"', '20px "Russo One"'];
      Promise.all(faces.map((f) => fs.load(f).catch(() => null))).then(() => resolve(), () => resolve());
    };
    let link = document.getElementById(FONT_ID);
    if (!link) {
      for (const href of ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']) {
        const pc = document.createElement('link');
        pc.rel = 'preconnect';
        pc.href = href;
        if (href.includes('gstatic')) pc.crossOrigin = 'anonymous';
        head.appendChild(pc);
      }
      link = document.createElement('link');
      link.id = FONT_ID;
      link.rel = 'stylesheet';
      link.href = FONT_HREF;
      link.addEventListener('load', done);
      link.addEventListener('error', () => resolve());
      head.appendChild(link);
    } else done();
    setTimeout(resolve, 5000); // never block forever (offline)
  });
  return fontPromise;
}

const ICONS = {
  flag: '<path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/>',
  racers: '<circle cx="9" cy="8" r="3.2"/><path d="M2.8 20c.4-3.4 3-5.8 6.2-5.8s5.8 2.4 6.2 5.8"/><circle cx="17.2" cy="9" r="2.4"/><path d="M16.2 14.4c3-.4 5.2 1.6 5.6 4.6"/>',
  moon: '<path d="M20 14.6A8.2 8.2 0 0 1 9.4 4 8.2 8.2 0 1 0 20 14.6z"/>',
  rain: '<path d="M7 15a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 7.6 3.8 3.8 0 0 1 17.6 15z"/><path d="M8.5 18.2 7.6 21M12.5 18.2l-.9 2.8M16.5 18.2l-.9 2.8"/>',
  pad: '<path d="M6.2 7.5h11.6a4 4 0 0 1 3.9 4.9l-.9 4.3a2.4 2.4 0 0 1-4.1 1.1L15 15.8H9l-1.7 2a2.4 2.4 0 0 1-4.1-1.1l-.9-4.3a4 4 0 0 1 3.9-4.9z"/><path d="M7.6 10.6v3.2M6 12.2h3.2"/><circle cx="15.8" cy="11.4" r=".5"/><circle cx="17.8" cy="13.2" r=".5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  road: '<path d="M8 3 4 21M16 3l4 18M12 4v3M12 10.5v3M12 17v3"/>',
};
function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// ---------------------------------------------------------------------------------------------
// Tachometer
// ---------------------------------------------------------------------------------------------
class Tach {
  constructor(parent) {
    this.el = el('div', 'mx-tach', parent);
    this.cv = el('canvas', 'mx-tach-cv', this.el);
    this.ctx = this.cv.getContext('2d');
    this.base = document.createElement('canvas'); // static: backing, band track, red zone, nitro track
    this.top = document.createElement('canvas'); // static: LED separators, ticks, numerals
    const mid = el('div', 'mx-tach-mid', this.el);
    this.spd = el('div', 'mx-spd', mid, '0');
    el('div', 'mx-unit', mid, 'KM/H');
    const gear = el('div', 'mx-gear', this.el);
    this.gear = el('span', 'mx-gear-v', gear, 'N');
    this.px = 0;
    this.dpr = 1;
    this.maxRpm = 0;
    this.setMaxRpm(8000);
    this.needle = 0;
    this.nos = 0;
    this.shift = false;
    this.nosOn = false;
    this.last = { n: -1, nos: -1, s: false };
    this.dirty = true;
  }

  resize(cssPx, dpr) {
    const px = Math.max(64, Math.round(cssPx * dpr));
    if (px === this.px) return;
    this.px = px;
    this.dpr = dpr;
    for (const c of [this.cv, this.base, this.top]) c.width = c.height = px;
    this.dirty = true;
  }

  setMaxRpm(m) {
    m = m > 2000 ? m : 8000;
    if (Math.abs(m - this.maxRpm) < 50) return;
    this.maxRpm = m;
    this.scaleK = Math.max(9, Math.ceil(m / 1000 + 0.4)); // dial range in ×1000 rpm
    this.redFrac = (Math.round((m * 0.875) / 250) * 250) / (this.scaleK * 1000);
    this.dirty = true;
  }

  ang(f) {
    return TACH_A0 + f * TACH_SWEEP;
  }

  renderLayers() {
    this.dirty = false;
    this.last.n = -1;
    const S = this.px, c = S / 2, R = S * 0.4, d = this.dpr;
    const K = this.scaleK, red = this.redFrac;

    // ---- base layer ------------------------------------------------------------------------
    const g = this.base.getContext('2d');
    g.clearRect(0, 0, S, S);
    // Soft dark backing so the dial reads over bright neon; no hard disc edge.
    let gr = g.createRadialGradient(c, c, R * 0.15, c, c, R * 1.28);
    gr.addColorStop(0, 'rgba(2,5,12,0.80)');
    gr.addColorStop(0.55, 'rgba(2,5,12,0.66)');
    gr.addColorStop(0.8, 'rgba(2,5,12,0.38)');
    gr.addColorStop(1, 'rgba(2,5,12,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(c, c, R * 1.28, 0, TAU);
    g.fill();
    // Glass face: faint cool highlight in the upper half.
    gr = g.createRadialGradient(c, c - R * 0.45, R * 0.05, c, c - R * 0.1, R * 0.95);
    gr.addColorStop(0, 'rgba(70,140,200,0.16)');
    gr.addColorStop(1, 'rgba(70,140,200,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(c, c, R * 0.9, 0, TAU);
    g.fill();
    // Outer rim + inner hairline.
    g.lineCap = 'butt';
    g.strokeStyle = 'rgba(160,235,255,0.30)';
    g.lineWidth = Math.max(1, 1.3 * d);
    g.beginPath();
    g.arc(c, c, R * 1.018, this.ang(0) - 2 * DEG, this.ang(1) + 2 * DEG);
    g.stroke();
    g.strokeStyle = 'rgba(0,229,255,0.16)';
    g.beginPath();
    g.arc(c, c, R * 0.52, this.ang(0), this.ang(1));
    g.stroke();
    // Unlit LED band.
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = R * 0.075;
    g.beginPath();
    g.arc(c, c, R * 0.955, this.ang(0), this.ang(1));
    g.stroke();
    // Red-line stripe just inside the band.
    g.strokeStyle = 'rgba(255,45,85,0.95)';
    g.lineWidth = R * 0.03;
    g.beginPath();
    g.arc(c, c, R * 0.893, this.ang(red), this.ang(1));
    g.stroke();
    g.strokeStyle = 'rgba(255,45,85,0.16)';
    g.lineWidth = R * 0.22;
    g.beginPath();
    g.arc(c, c, R * 0.8, this.ang(red), this.ang(1));
    g.stroke();
    // Nitro track (unlit segments) + label.
    const nr = R * 1.135, nw = R * 0.058;
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = nw;
    this.nosPath(g, c, nr, NOS_SEGS);
    g.stroke();
    g.fillStyle = 'rgba(160,220,255,0.75)';
    g.font = `italic 800 ${Math.round(R * 0.085)}px ${NUM_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const la = NOS_A1 + 10 * DEG;
    g.fillText('N₂O', c + Math.cos(la) * nr, c + Math.sin(la) * nr);

    // ---- top layer -------------------------------------------------------------------------
    const t = this.top.getContext('2d');
    t.clearRect(0, 0, S, S);
    // LED separators across the band (every 200 rpm) — knocked out in the backing colour.
    const segs = K * 5;
    t.strokeStyle = 'rgba(3,7,16,0.92)';
    t.lineWidth = Math.max(1.2, R * 0.012);
    t.beginPath();
    for (let i = 1; i < segs; i++) {
      const a = this.ang(i / segs), ca = Math.cos(a), sa = Math.sin(a);
      t.moveTo(c + ca * R * 0.91, c + sa * R * 0.91);
      t.lineTo(c + ca * R * 1.0, c + sa * R * 1.0);
    }
    t.stroke();
    // Tick marks: major 1000, medium 500, minor 250.
    for (let i = 0; i <= K * 4; i++) {
      const f = i / (K * 4), a = this.ang(f), ca = Math.cos(a), sa = Math.sin(a);
      const major = i % 4 === 0, mid = i % 2 === 0;
      const r1 = R * 0.875, r0 = major ? R * 0.765 : mid ? R * 0.815 : R * 0.84;
      t.strokeStyle = f >= red - 1e-6 ? (major ? '#ff4d6d' : 'rgba(255,77,109,0.8)') : major ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.5)';
      t.lineWidth = major ? Math.max(2, R * 0.022) : Math.max(1, R * 0.01);
      t.beginPath();
      t.moveTo(c + ca * r0, c + sa * r0);
      t.lineTo(c + ca * r1, c + sa * r1);
      t.stroke();
    }
    // Numerals.
    t.font = `italic 700 ${Math.round(R * 0.165)}px ${NUM_FONT}`;
    t.textAlign = 'center';
    t.textBaseline = 'middle';
    for (let k = 0; k <= K; k++) {
      const f = k / K, a = this.ang(f);
      t.fillStyle = f >= red - 1e-6 ? '#ff4d6d' : 'rgba(255,255,255,0.92)';
      t.fillText(String(k), c + Math.cos(a) * R * 0.645, c + Math.sin(a) * R * 0.645 + R * 0.01);
    }

    // Lit-band colour ramp: deep blue → cyan → ice white → red at the red line (conic so it follows the arc).
    const ctx = this.ctx;
    if (ctx.createConicGradient) {
      const k = TACH_SWEEP / TAU;
      const cg = ctx.createConicGradient(TACH_A0, c, c);
      cg.addColorStop(0, '#0b4dff');
      cg.addColorStop(k * 0.3, '#008cff');
      cg.addColorStop(k * 0.62, CYAN);
      cg.addColorStop(k * Math.max(0.65, red - 0.05), '#c6fbff');
      cg.addColorStop(k * red, '#ff3a5e');
      cg.addColorStop(k, '#ff1040');
      cg.addColorStop(1, '#0b4dff');
      this.bandGrad = cg;
    } else this.bandGrad = CYAN;
    // Nitro fill ramp (vertical: deep blue at the bottom → cyan at the top).
    const ng = ctx.createLinearGradient(0, c + R * 1.1, 0, c - R * 0.9);
    ng.addColorStop(0, '#1446ff');
    ng.addColorStop(1, '#22d8ff');
    this.nosGrad = ng;
  }

  nosPath(g, c, r, upto) {
    const step = (NOS_A1 - NOS_A0) / NOS_SEGS, gap = 1.7 * DEG;
    g.beginPath();
    for (let i = 0; i < upto; i++) {
      const a0 = NOS_A0 + i * step + gap / 2, a1 = a0 + step - gap;
      g.moveTo(c + Math.cos(a0) * r, c + Math.sin(a0) * r);
      g.arc(c, c, r, a0, a1);
    }
  }

  draw(rpm, maxRpm, nitro, nitroActive, dt, time, launch) {
    if (!this.px) return;
    this.setMaxRpm(maxRpm);
    if (this.dirty) this.renderLayers();
    const full = this.scaleK * 1000;
    // Launch window (countdown): fades in/out, so keep redrawing while it is visible.
    const lw = launch && launch.active ? 1 : 0;
    this.launchA = damp(this.launchA || 0, lw, lw ? 8 : 3, dt);
    if (this.launchA < 0.01) this.launchA = 0;
    // Needle damping: fast enough to show limiter bounce, slow enough to hide frame jitter.
    this.needle = damp(this.needle, clamp(rpm || 0, 0, full), 20, dt);
    this.nos = damp(this.nos, clamp(nitro || 0, 0, 1), 12, dt);
    const shift = this.needle >= this.maxRpm * 0.94 && (time * 14) % 1 < 0.55;
    if (shift !== this.shift) {
      this.shift = shift;
      this.el.classList.toggle('mx-shift', shift);
    }
    if (!!nitroActive !== this.nosOn) {
      this.nosOn = !!nitroActive;
      this.el.classList.toggle('mx-nos', this.nosOn);
    }
    const L = this.last;
    if (Math.abs(this.needle - L.n) < 3 && Math.abs(this.nos - L.nos) < 0.002 && !this.nosOn && shift === L.s && !this.launchA) return;
    L.n = this.needle;
    L.nos = this.nos;
    L.s = shift;

    const ctx = this.ctx, S = this.px, c = S / 2, R = S * 0.4, d = this.dpr;
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(this.base, 0, 0);
    const f = this.needle / full, a = this.ang(f);
    ctx.lineCap = 'butt';
    if (f > 0.002) {
      ctx.strokeStyle = shift ? RED : this.bandGrad;
      ctx.globalAlpha = 0.2; // wide faint pass = bloom-ish glow without shadowBlur
      ctx.lineWidth = R * 0.17;
      ctx.beginPath();
      ctx.arc(c, c, R * 0.955, TACH_A0, a);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = R * 0.075;
      ctx.beginPath();
      ctx.arc(c, c, R * 0.955, TACH_A0, a);
      ctx.stroke();
    }
    if (this.launchA) this.drawLaunch(ctx, c, R, launch, this.needle / this.maxRpm, time);
    ctx.drawImage(this.top, 0, 0);
    this.drawNitro(ctx, c, R, d, time);
    this.drawNeedle(ctx, c, R, d, a);
  }

  /**
   * Launch-control window on the dial during the countdown: amber = good, green = perfect (fractions of
   * max rpm from the core). The green zone flares while the needle sits inside it.
   */
  drawLaunch(ctx, c, R, launch, r, time) {
    const k = this.maxRpm / (this.scaleK * 1000); // max-rpm fraction → dial fraction
    const good = (launch && launch.good) || [0.3, 0.92];
    const perfect = (launch && launch.perfect) || [0.45, 0.85];
    const inPerfect = r >= perfect[0] && r <= perfect[1];
    const inGood = !inPerfect && r >= good[0] && r <= good[1];
    const A = this.launchA;
    const arc = (lo, hi, rad, w, style, alpha) => {
      ctx.globalAlpha = alpha * A;
      ctx.strokeStyle = style;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.arc(c, c, rad, this.ang(lo * k), this.ang(hi * k));
      ctx.stroke();
    };
    ctx.save();
    ctx.lineCap = 'butt';
    // soft wedge glow inside the band + crisp stripe on the red-line track
    arc(good[0], good[1], R * 0.8, R * 0.22, '#ffb020', inGood ? 0.22 : 0.1);
    arc(perfect[0], perfect[1], R * 0.8, R * 0.22, GREEN, inPerfect ? 0.34 + 0.12 * Math.sin(time * 18) : 0.14);
    arc(good[0], good[1], R * 0.893, R * 0.045, '#ffb020', 0.9);
    arc(perfect[0], perfect[1], R * 0.893, R * 0.06, GREEN, 1);
    if (inPerfect) arc(perfect[0], perfect[1], R * 0.955, R * 0.1, GREEN, 0.35);
    // label in the dial's lower gap
    ctx.globalAlpha = A;
    ctx.fillStyle = inPerfect ? GREEN : inGood ? '#ffcf5a' : 'rgba(220,240,255,0.8)';
    ctx.font = `italic 800 ${Math.round(R * 0.1)}px ${NUM_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(inPerfect ? 'LAUNCH ✓' : 'LAUNCH', c, c - R * 0.36);
    ctx.restore();
  }

  drawNitro(ctx, c, R, d, time) {
    const lit = this.nos * NOS_SEGS;
    const full = Math.floor(lit), frac = lit - full;
    if (lit <= 0.01) return;
    const r = R * 1.135;
    ctx.save();
    ctx.lineWidth = R * 0.058;
    ctx.strokeStyle = this.nosOn ? '#bff8ff' : this.nosGrad;
    if (this.nosOn) {
      ctx.shadowColor = '#2f9bff';
      ctx.shadowBlur = 14 * d;
      ctx.globalAlpha = 0.78 + 0.22 * Math.sin(time * 26);
    }
    if (full > 0) {
      this.nosPath(ctx, c, r, full);
      ctx.stroke();
    }
    if (frac > 0.02 && full < NOS_SEGS) {
      // partially filled segment fades in
      const step = (NOS_A1 - NOS_A0) / NOS_SEGS, gap = 1.7 * DEG;
      const a0 = NOS_A0 + full * step + gap / 2;
      ctx.globalAlpha *= frac;
      ctx.beginPath();
      ctx.arc(c, c, r, a0, a0 + step - gap);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawNeedle(ctx, c, R, d, a) {
    const ca = Math.cos(a), sa = Math.sin(a), px = -sa, py = ca;
    const r0 = R * 0.5, r1 = R * 1.03, w0 = R * 0.03, w1 = R * 0.007;
    ctx.save();
    ctx.shadowColor = 'rgba(255,70,40,0.95)';
    ctx.shadowBlur = 12 * d;
    ctx.fillStyle = '#ff3b2a';
    ctx.beginPath();
    ctx.moveTo(c + ca * r0 + px * w0, c + sa * r0 + py * w0);
    ctx.lineTo(c + ca * r1 + px * w1, c + sa * r1 + py * w1);
    ctx.lineTo(c + ca * r1 - px * w1, c + sa * r1 - py * w1);
    ctx.lineTo(c + ca * r0 - px * w0, c + sa * r0 - py * w0);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,236,226,0.95)';
    ctx.lineWidth = Math.max(1, 1.1 * d);
    ctx.beginPath();
    ctx.moveTo(c + ca * (r0 + R * 0.1), c + sa * (r0 + R * 0.1));
    ctx.lineTo(c + ca * (r1 - R * 0.01), c + sa * (r1 - R * 0.01));
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------------------------
// Minimap (heading-up, player arrow fixed slightly below centre so more road ahead is visible)
// ---------------------------------------------------------------------------------------------
class Minimap {
  constructor(parent) {
    this.el = el('div', 'mx-map', parent);
    this.cv = el('canvas', 'mx-map-cv', this.el);
    this.ctx = this.cv.getContext('2d');
    this.px = 0;
    this.dpr = 1;
    this.pts = null;
    this.scr = null;
    this.n = 0;
    this.h = null;
    this.view = 230; // metres from the arrow to the map edge
  }

  resize(cssPx, dpr) {
    const px = Math.max(48, Math.round(cssPx * dpr));
    if (px === this.px) return;
    this.px = px;
    this.dpr = dpr;
    this.cv.width = this.cv.height = px;
  }

  setTrack(poly, opts = {}) {
    if (!Array.isArray(poly) || poly.length < 3) {
      this.pts = null;
      return;
    }
    let n = poly.length;
    const p0 = poly[0], pl = poly[n - 1];
    if (Math.hypot(p0[0] - pl[0], p0[1] - pl[1]) < 0.5) n--; // drop duplicated closing point
    const pts = new Float32Array(n * 2);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, len = 0;
    for (let i = 0; i < n; i++) {
      const x = +poly[i][0] || 0, z = +poly[i][1] || 0;
      pts[i * 2] = x;
      pts[i * 2 + 1] = z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      if (i) len += Math.hypot(x - pts[i * 2 - 2], z - pts[i * 2 - 1]);
    }
    len += Math.hypot(pts[0] - pts[n * 2 - 2], pts[1] - pts[n * 2 - 1]);
    this.pts = pts;
    this.n = n;
    this.scr = new Float32Array(n * 2);
    this.length = len;
    this.bounds = { minX, maxX, minZ, maxZ };
    // Start/finish: explicit point or polyline[0]; direction from the nearest vertex to the next.
    let si = 0;
    if (opts.start) {
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        const dd = (pts[i * 2] - opts.start[0]) ** 2 + (pts[i * 2 + 1] - opts.start[1]) ** 2;
        if (dd < best) (best = dd), (si = i);
      }
    }
    const j = (si + 1) % n;
    const sx = opts.start ? +opts.start[0] : pts[si * 2], sz = opts.start ? +opts.start[1] : pts[si * 2 + 1];
    const dx = pts[j * 2] - pts[si * 2], dz = pts[j * 2 + 1] - pts[si * 2 + 1], dl = Math.hypot(dx, dz) || 1;
    this.start = { x: sx, z: sz, dx: dx / dl, dz: dz / dl };
  }

  draw(cars, speedKmh, dt, time) {
    const S = this.px;
    if (!S) return;
    const g = this.ctx, d = this.dpr;
    let p = null;
    if (cars) for (const c of cars) if (c && c.isPlayer) { p = c; break; }
    if (!p && cars && cars.length) p = cars[0];
    const b = this.bounds;
    const px = p ? +p.x || 0 : b ? (b.minX + b.maxX) / 2 : 0;
    const pz = p ? +p.z || 0 : b ? (b.minZ + b.maxZ) / 2 : 0;
    const ph = p ? +p.heading || 0 : 0;
    // Smoothed map rotation (a drifting car's yaw jitter would otherwise shake the whole map).
    this.h = this.h == null ? ph : this.h + wrapAngle(ph - this.h) * (1 - Math.exp(-9 * dt));
    this.view = damp(this.view, lerp(170, 300, clamp((speedKmh || 0) / 260, 0, 1)), 1.5, dt);

    const half = S / 2, cx = half, cy = half + S * 0.13;
    const sc = (half * 0.95) / this.view;
    const ch = Math.cos(this.h), sh = Math.sin(this.h);
    // world (x,z) → map: right = (-cos h, sin h), forward = (sin h, cos h); screen up = forward.
    const toX = (x, z) => cx + (-(x - px) * ch + (z - pz) * sh) * sc;
    const toY = (x, z) => cy - ((x - px) * sh + (z - pz) * ch) * sc;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, S, S);
    g.save();
    const rr = S * 0.1;
    g.beginPath();
    if (g.roundRect) g.roundRect(0, 0, S, S, rr);
    else g.rect(0, 0, S, S);
    g.clip();

    // World-aligned grid (rotates/slides with the car → strong sense of motion, nearly free).
    const G = 60, ext = this.view * 1.9;
    g.strokeStyle = 'rgba(0,229,255,0.07)';
    g.lineWidth = Math.max(1, d);
    g.beginPath();
    const gx0 = Math.floor((px - ext) / G) * G, gz0 = Math.floor((pz - ext) / G) * G;
    for (let x = gx0; x <= px + ext; x += G) {
      g.moveTo(toX(x, pz - ext), toY(x, pz - ext));
      g.lineTo(toX(x, pz + ext), toY(x, pz + ext));
    }
    for (let z = gz0; z <= pz + ext; z += G) {
      g.moveTo(toX(px - ext, z), toY(px - ext, z));
      g.lineTo(toX(px + ext, z), toY(px + ext, z));
    }
    g.stroke();

    // Track: dark casing → wide faint glow → crisp neon core.
    if (this.pts) {
      const P = this.pts, Q = this.scr, n = this.n;
      for (let i = 0; i < n; i++) {
        const x = P[i * 2], z = P[i * 2 + 1];
        Q[i * 2] = toX(x, z);
        Q[i * 2 + 1] = toY(x, z);
      }
      g.beginPath();
      g.moveTo(Q[0], Q[1]);
      for (let i = 1; i < n; i++) g.lineTo(Q[i * 2], Q[i * 2 + 1]);
      g.closePath();
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(0,0,0,0.75)';
      g.lineWidth = 11 * d;
      g.stroke();
      g.strokeStyle = 'rgba(40,70,110,0.9)';
      g.lineWidth = 7 * d;
      g.stroke();
      g.strokeStyle = 'rgba(0,229,255,0.22)';
      g.lineWidth = 5 * d;
      g.stroke();
      g.strokeStyle = CYAN;
      g.lineWidth = 1.8 * d;
      g.stroke();
      // Start / finish line: chequered bar across the road.
      const st = this.start;
      if (st) {
        const sx = toX(st.x, st.z), sy = toY(st.x, st.z);
        const ex = toX(st.x + st.dx, st.z + st.dz) - sx, ey = toY(st.x + st.dx, st.z + st.dz) - sy;
        const el2 = Math.hypot(ex, ey) || 1, nx = -ey / el2, ny = ex / el2, L = 6.5 * d;
        g.lineCap = 'butt';
        g.strokeStyle = '#000';
        g.lineWidth = 4.2 * d;
        g.beginPath();
        g.moveTo(sx - nx * L, sy - ny * L);
        g.lineTo(sx + nx * L, sy + ny * L);
        g.stroke();
        g.strokeStyle = '#fff';
        g.lineWidth = 2.6 * d;
        g.setLineDash([2.2 * d, 2.2 * d]);
        g.stroke();
        g.setLineDash([]);
      }
    }

    // Opponents: livery-coloured dots, clamped to the edge when out of range.
    if (cars) {
      const lim = half - 7 * d;
      for (const c of cars) {
        if (!c || c === p) continue;
        let x = toX(+c.x || 0, +c.z || 0) - half, y = toY(+c.x || 0, +c.z || 0) - half;
        const m = Math.max(Math.abs(x), Math.abs(y));
        const out = m > lim;
        if (out) (x *= lim / m), (y *= lim / m);
        const col = cssColor(c.color, '#ff2d55');
        g.globalAlpha = out ? 0.55 : 1;
        g.fillStyle = col;
        g.globalAlpha *= 0.28;
        g.beginPath();
        g.arc(half + x, half + y, 7.5 * d, 0, TAU);
        g.fill();
        g.globalAlpha = out ? 0.6 : 1;
        g.beginPath();
        g.arc(half + x, half + y, (out ? 3.4 : 4.4) * d, 0, TAU);
        g.fill();
        g.lineWidth = 1.6 * d;
        g.strokeStyle = 'rgba(0,0,0,0.85)';
        g.stroke();
        g.lineWidth = 1 * d;
        g.strokeStyle = 'rgba(255,255,255,0.6)';
        g.beginPath();
        g.arc(half + x, half + y, (out ? 4.9 : 5.9) * d, 0, TAU);
        g.stroke();
        g.globalAlpha = 1;
      }
    }

    // Player arrow (always points up).
    if (p) {
      const A = 8.5 * d;
      g.save();
      g.translate(cx, cy);
      g.fillStyle = 'rgba(0,229,255,0.22)';
      g.beginPath();
      g.arc(0, 0, A * 1.9, 0, TAU);
      g.fill();
      g.shadowColor = CYAN;
      g.shadowBlur = 10 * d;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.moveTo(0, -A * 1.25);
      g.lineTo(A * 0.9, A * 0.95);
      g.lineTo(0, A * 0.45);
      g.lineTo(-A * 0.9, A * 0.95);
      g.closePath();
      g.fill();
      g.shadowBlur = 0;
      g.lineWidth = 1.2 * d;
      g.strokeStyle = 'rgba(0,40,60,0.9)';
      g.stroke();
      g.restore();
    }

    // North marker riding the map edge.
    const nx = sh, ny = -ch, rN = half * 0.84;
    g.font = `italic 800 ${Math.round(10.5 * d)}px ${NUM_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.beginPath();
    g.arc(half + nx * rN, half + ny * rN, 7.5 * d, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(200,245,255,0.85)';
    g.fillText('N', half + nx * rN, half + ny * rN + 0.5 * d);
    g.restore();
  }
}

/** Static north-up track preview for the title menu event card. */
function drawTrackPreview(cv, poly, dpr) {
  const W = cv.width, H = cv.height;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  if (!poly || poly.length < 3) return;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of poly) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const pad = 16 * dpr;
  const k = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxZ - minZ));
  const mx = (minX + maxX) / 2, mz = (minZ + maxZ) / 2;
  // North-up top view: world +X is screen-left, +Z is screen-up.
  const X = (x) => W / 2 - (x - mx) * k, Y = (z) => H / 2 - (z - mz) * k;
  g.beginPath();
  poly.forEach(([x, z], i) => (i ? g.lineTo(X(x), Y(z)) : g.moveTo(X(x), Y(z))));
  g.closePath();
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(0,0,0,0.7)';
  g.lineWidth = 9 * dpr;
  g.stroke();
  g.strokeStyle = 'rgba(0,229,255,0.25)';
  g.lineWidth = 7 * dpr;
  g.shadowColor = CYAN;
  g.shadowBlur = 14 * dpr;
  g.stroke();
  g.shadowBlur = 0;
  const lg = g.createLinearGradient(0, 0, W, H);
  lg.addColorStop(0, '#7ff4ff');
  lg.addColorStop(0.5, CYAN);
  lg.addColorStop(1, '#ff2bd6');
  g.strokeStyle = lg;
  g.lineWidth = 2.2 * dpr;
  g.stroke();
  // Start marker + direction chevron.
  const [x0, z0] = poly[0], [x1, z1] = poly[Math.min(3, poly.length - 1)];
  const sx = X(x0), sy = Y(z0), ang = Math.atan2(Y(z1) - sy, X(x1) - sx);
  g.save();
  g.translate(sx, sy);
  g.rotate(ang);
  g.fillStyle = '#fff';
  g.fillRect(-1.5 * dpr, -8 * dpr, 3 * dpr, 16 * dpr);
  g.fillStyle = RED;
  g.beginPath();
  g.moveTo(14 * dpr, 0);
  g.lineTo(6 * dpr, -5 * dpr);
  g.lineTo(6 * dpr, 5 * dpr);
  g.closePath();
  g.fill();
  g.restore();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.font = `italic 800 ${Math.round(11 * dpr)}px ${NUM_FONT}`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText('START', sx + 10 * dpr, sy + 14 * dpr);
}

// ---------------------------------------------------------------------------------------------
// Centre flash messages (max two stacked, rest queued; repeated identical calls extend the current one)
// ---------------------------------------------------------------------------------------------
class Messages {
  constructor(parent) {
    this.el = el('div', 'mx-msgs', parent);
    this.active = [];
    this.queue = [];
  }

  flash(text, duration, kind) {
    const k = kind === 'warn' || kind === 'good' ? kind : 'info';
    const cur = this.active.find((m) => m.text === text && !m.leaving);
    if (cur) {
      this.arm(cur, duration);
      return;
    }
    if (this.queue.some((m) => m.text === text)) return;
    const m = { text, duration, kind: k };
    if (this.active.filter((a) => !a.leaving).length < 2) this.show(m);
    else {
      this.queue.push(m);
      if (this.queue.length > 4) this.queue.shift();
      // make room sooner when things pile up
      const oldest = this.active.find((a) => !a.leaving);
      if (oldest) this.arm(oldest, Math.min(0.7, oldest.duration));
    }
  }

  show(m) {
    const node = el('div', `mx-msg mx-${m.kind}`);
    const t = /^(.*?)[\s:]+([+\-−]?\d+:\d{2}\.\d{1,3})$/.exec(m.text);
    el('div', 'mx-msg-main', node, t ? t[1] : m.text);
    if (t) el('div', 'mx-msg-sub', node, t[2]);
    this.el.appendChild(node);
    m.node = node;
    this.active.push(m);
    this.arm(m, m.duration);
  }

  arm(m, duration) {
    clearTimeout(m.timer);
    m.timer = setTimeout(() => this.hide(m), Math.max(0.3, duration) * 1000);
  }

  hide(m) {
    if (m.leaving) return;
    m.leaving = true;
    m.node.classList.add('mx-out');
    setTimeout(() => {
      m.node.remove();
      this.active = this.active.filter((a) => a !== m);
    }, 380);
    const next = this.queue.shift();
    if (next) this.pending = setTimeout(() => this.show(next), 120);
  }

  clear() {
    clearTimeout(this.pending);
    for (const m of this.active) {
      clearTimeout(m.timer);
      m.leaving = true;
      m.node.remove();
    }
    this.active = [];
    this.queue = [];
  }
}

// ---------------------------------------------------------------------------------------------
// Drift chain meter + score pop-ups
// ---------------------------------------------------------------------------------------------
class Drift {
  constructor(parent) {
    this.el = el('div', 'mx-drift', parent);
    this.live = el('div', 'mx-dlive', this.el);
    el('div', 'mx-dlive-lbl', this.live, 'DRIFT');
    const row = el('div', 'mx-dlive-row', this.live);
    this.score = el('div', 'mx-dlive-score', row, '0');
    this.mult = el('div', 'mx-dlive-mult', row, '×1');
    const bar = el('div', 'mx-dlive-bar', this.live);
    this.bar = el('i', '', bar);
    this.reset();
    this.shown = false;
    this.auto = true;
  }

  reset() {
    this.points = 0;
    this.chain = 0;
    this.grace = 0;
    this.m = 1;
  }

  setLive(on) {
    if (on !== this.shown) {
      this.shown = on;
      this.live.classList.toggle('mx-on', on);
    }
  }

  /** state.drift: number 0..1 (physics drift intensity → HUD scores it), or { active, score, multiplier }. */
  update(state, dt) {
    const d = state.drift;
    if (d && typeof d === 'object') {
      const sc = Math.round(+d.score || 0);
      if (d.active && sc > 0) {
        this.setLive(true);
        const m = Math.max(1, d.multiplier | 0 || 1);
        setText(this.score, sc.toLocaleString('en-US'));
        setText(this.mult, '×' + m);
        this.setBar(m / 5);
        this.points = sc;
      } else {
        if (this.shown && this.points > 0) this.pop(this.points);
        this.points = 0;
        this.setLive(false);
      }
      return;
    }
    if (!this.auto || typeof d !== 'number') return this.setLive(false);
    const spd = state.speedKmh || 0;
    const drifting = d > 0.22 && spd > 40;
    if (drifting) {
      this.chain += dt;
      this.grace = 0;
      this.m = 1 + Math.min(4, Math.floor(this.chain / 2.2));
      this.points += d * spd * 2.4 * this.m * dt;
    } else if (this.points > 0) {
      this.grace += dt;
      if (this.grace > 1.1 || spd < 25) {
        if (this.points >= 150) this.pop(this.points);
        this.reset();
      }
    }
    const show = this.points >= 40;
    this.setLive(show);
    if (show) {
      setText(this.score, Math.round(this.points).toLocaleString('en-US'));
      setText(this.mult, '×' + this.m);
      this.setBar(drifting ? 1 : 1 - this.grace / 1.1);
    }
  }

  setBar(k) {
    const kq = Math.round(clamp(k, 0, 1) * 50) / 50;
    if (this.bar._k !== kq) {
      this.bar._k = kq;
      this.bar.style.transform = `scaleX(${kq})`;
    }
  }

  pop(points, label = 'DRIFT') {
    const node = el('div', 'mx-dpop', this.el);
    el('div', 'mx-dpop-v', node, '+' + Math.round(points).toLocaleString('en-US'));
    el('div', 'mx-dpop-l', node, label);
    setTimeout(() => node.remove(), 1900);
  }
}

// ---------------------------------------------------------------------------------------------
// Countdown 3 · 2 · 1 · GO!
// ---------------------------------------------------------------------------------------------
class Countdown {
  constructor(parent) {
    this.el = el('div', 'mx-cd', parent);
    const inner = el('div', 'mx-cd-in', this.el);
    const lights = el('div', 'mx-cd-lights', inner);
    this.lights = [0, 1, 2].map(() => el('i', 'mx-cd-light', lights));
    this.stage = el('div', 'mx-cd-stage', inner);
    this.value = null;
    this.timer = 0;
  }

  show(v) {
    const isGo = typeof v === 'string' ? /^go/i.test(v.trim()) : !(v > 0);
    const key = isGo ? 'GO' : String(v);
    clearTimeout(this.timer);
    this.el.classList.remove('mx-out');
    this.el.classList.add('mx-on');
    if (key === this.value) return; // core may call this every frame
    this.value = key;
    const n = isGo ? 3 : clamp(4 - (Number(v) || 0), 0, 3);
    this.lights.forEach((l, i) => {
      l.className = 'mx-cd-light' + (isGo ? ' mx-g' : i < n ? ' mx-r' : '');
    });
    // previous digit zooms out while the new one punches in
    for (const node of Array.from(this.stage.children)) {
      if (node.classList.contains('mx-cd-num') && !node.classList.contains('mx-leave')) {
        node.classList.add('mx-leave');
        setTimeout(() => node.remove(), 420);
      } else if (!node.classList.contains('mx-leave')) node.remove();
    }
    if (isGo) {
      const lines = el('div', 'mx-cd-lines', this.stage);
      const r = rng(7);
      for (let i = 0; i < 14; i++) {
        const l = el('i', '', lines);
        l.style.cssText = `top:${(8 + r() * 84).toFixed(1)}%;width:${(10 + r() * 26).toFixed(1)}em;animation-delay:${(r() * 0.25).toFixed(2)}s;--dir:${i % 2 ? 1 : -1}`;
      }
    }
    el('i', 'mx-cd-ring' + (isGo ? ' mx-go' : ''), this.stage);
    el('div', 'mx-cd-num' + (isGo ? ' mx-go' : ''), this.stage, isGo ? 'GO!' : key);
  }

  hide() {
    if (!this.el.classList.contains('mx-on') || this.el.classList.contains('mx-out')) return;
    this.el.classList.add('mx-out');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.el.classList.remove('mx-on', 'mx-out');
      this.stage.textContent = '';
      this.value = null;
      this.lights.forEach((l) => (l.className = 'mx-cd-light'));
    }, 500);
  }
}

// ---------------------------------------------------------------------------------------------
// HUD factory
// ---------------------------------------------------------------------------------------------
const CONTROLS = [
  [['W', '↑'], 'Throttle'],
  [['S', '↓'], 'Brake · Reverse'],
  [['A', 'D'], 'Steer'],
  [['←', '→'], 'Steer'],
  [['SPACE'], 'Handbrake'],
  [['SHIFT', 'N'], 'Nitrous'],
  [['C'], 'Camera'],
  [['R'], 'Reset car'],
  [['ESC'], 'Pause'],
  [['M'], 'Mute'],
];

export function createHUD({ container = document.body, autoDrift = true, onSound = null } = {}) {
  if (typeof document === 'undefined') throw new Error('createHUD requires a DOM');
  const host = container || document.body;
  loadFonts().then(() => {
    tach.dirty = true;
    tach.last.n = -1;
    if (menu && trackPoly) menu.drawPreview();
  });

  let soundFn = typeof onSound === 'function' ? onSound : null;
  const sound = (kind) => {
    try {
      soundFn && soundFn(kind);
    } catch (e) {
      /* audio is optional */
    }
  };

  const root = el('div', 'mx-root', host);
  const race = el('div', 'mx-race', root);

  // ---- top-left: position / lap / timers --------------------------------------------------
  const tl = el('div', 'mx-tl', race);
  const posRow = el('div', 'mx-posrow', tl);
  const posBox = el('div', 'mx-pos', posRow);
  el('div', 'mx-lbl', posBox, 'POS');
  const posVal = el('div', 'mx-pos-val', posBox);
  const posN = el('span', 'mx-pos-n', posVal, '-');
  const posOrd = el('span', 'mx-pos-ord', posVal, '');
  const posOf = el('span', 'mx-pos-of', posVal, '');
  el('div', 'mx-sep', posRow);
  const lapBox = el('div', 'mx-lap', posRow);
  el('div', 'mx-lbl', lapBox, 'LAP');
  const lapVal = el('div', 'mx-lap-val', lapBox);
  const lapN = el('span', 'mx-lap-n', lapVal, '1');
  const lapOf = el('span', 'mx-lap-of', lapVal, '/3');
  const times = el('div', 'mx-times', tl);
  const trow = (label, cls) => {
    const k = el('span', 'mx-tk ' + (cls || ''), times, label);
    const v = el('span', 'mx-tv ' + (cls || ''), times, '-:--.---');
    const x = el('span', 'mx-tx ' + (cls || ''), times, '');
    return { k, v, x };
  };
  const tLap = trow('LAP', 'mx-cur');
  const tTot = trow('TOTAL', 'mx-tot');
  const tBest = trow('BEST', 'mx-best');
  const tLast = trow('LAST', 'mx-last');
  const tGap = trow('AHEAD', 'mx-gap');
  for (const r of [tLast, tGap]) for (const p of ['k', 'v', 'x']) r[p].classList.add('mx-hide');

  // ---- tach / minimap / drift ---------------------------------------------------------------
  const tach = new Tach(race);
  const map = new Minimap(race);
  const drift = new Drift(race);
  drift.auto = autoDrift !== false;
  const msgs = new Messages(root);
  const cd = new Countdown(root);

  // ---- canvas sizing (no layout reads in update) --------------------------------------------
  const dprNow = () => Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const sizes = new Map();
  const applySize = (target, w) => {
    sizes.set(target, w);
    const dpr = dprNow();
    if (target === tach.el) tach.resize(w, dpr);
    else if (target === map.el) map.resize(w, dpr);
    else if (menu && target === menu.preview) menu.resizePreview(w, target.clientHeight || w * 0.5, dpr);
  };
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => {
        for (const e of entries) applySize(e.target, e.contentRect.width);
      })
    : null;
  if (ro) {
    ro.observe(tach.el);
    ro.observe(map.el);
  } else {
    // very old browsers: one-time measure
    requestAnimationFrame(() => {
      applySize(tach.el, tach.el.clientWidth);
      applySize(map.el, map.el.clientWidth);
    });
  }
  const onResize = () => {
    for (const [t, w] of sizes) applySize(t, w); // picks up devicePixelRatio changes
  };
  window.addEventListener('resize', onResize);
  // GPU resets can wipe 2D canvases (Chrome fires contextrestored); rebuild cached layers and repaint.
  const onRestored = () => {
    tach.dirty = true;
    tach.last.n = -1;
    if (menu) menu.drawPreview();
  };
  for (const c of [tach.cv, tach.base, tach.top, map.cv]) c.addEventListener('contextrestored', onRestored);

  // ---- per-frame cache -----------------------------------------------------------------------
  const cache = { pos: 0, lap: -1, gear: '', last: null, best: null, gap: false, wrongT: 0 };
  let hudOn = false;
  let lastT = performance.now();

  const pop = (node, from, color) => {
    if (!node.animate) return;
    node.animate(
      [
        { transform: `${from} scale(1.45)`, color: color || '#fff', filter: 'brightness(1.8)' },
        { transform: `${from} scale(1)`, filter: 'none' },
      ],
      { duration: 650, easing: 'cubic-bezier(.17,.9,.25,1.2)' },
    );
  };

  function update(state) {
    const now = performance.now();
    const dt = clamp((now - lastT) / 1000, 0, 0.1);
    lastT = now;
    if (!hudOn || !state) return;
    const s = state;
    const time = now / 1000;

    // Position
    const pos = s.position | 0, tot = s.totalRacers | 0;
    if (pos !== cache.pos) {
      if (cache.pos > 0 && pos > 0) pop(posN, 'skewX(-10deg)', pos < cache.pos ? GREEN : RED);
      cache.pos = pos;
      setText(posN, pos > 0 ? String(pos) : '-');
      setText(posOrd, pos > 0 ? ordinal(pos).toUpperCase() : '');
      posRow.classList.toggle('mx-p1', pos === 1);
    }
    setText(posOf, tot > 0 ? '/' + tot : '');

    // Lap
    const totalLaps = s.totalLaps | 0 || CONFIG.race.laps;
    const lap = clamp(s.lap | 0 || 1, 1, Math.max(1, totalLaps));
    if (lap !== cache.lap) {
      if (cache.lap > 0) pop(lapN, '', CYAN);
      cache.lap = lap;
      setText(lapN, String(lap));
      lapVal.classList.toggle('mx-final', lap === totalLaps && totalLaps > 1);
    }
    setText(lapOf, '/' + totalLaps);

    // Timers
    setText(tLap.v, fmtTime(Math.max(0, +s.lapTime || 0)));
    setText(tTot.v, fmtTime(Math.max(0, +s.totalTime || 0)));
    const best = validTime(s.bestLap);
    setText(tBest.v, fmtTime(best));
    if (tBest.v._none !== (best == null)) tBest.v.classList.toggle('mx-none', (tBest.v._none = best == null));
    const last = validTime(s.lastLap);
    if (last !== cache.last) {
      if (last != null) {
        const ref = cache.best; // best lap *before* this lap was completed
        for (const p of ['k', 'v', 'x']) tLast[p].classList.remove('mx-hide');
        setText(tLast.v, fmtTime(last));
        if (ref != null && Math.abs(last - ref) > 1e-4) {
          setText(tLast.x, fmtDelta(last - ref));
          tLast.x.classList.toggle('mx-neg', last < ref);
          tLast.x.classList.toggle('mx-pos', last > ref);
        } else setText(tLast.x, '');
        if (tLast.v.animate) tLast.v.animate([{ color: CYAN, opacity: 0.2 }, { opacity: 1 }], { duration: 900 });
      } else for (const p of ['k', 'v', 'x']) tLast[p].classList.add('mx-hide');
      cache.last = last;
    }
    cache.best = best;
    // Optional: gap to the car ahead (seconds), when the game provides it.
    const gap = typeof s.gapAhead === 'number' && Number.isFinite(s.gapAhead) && s.gapAhead > 0 && pos > 1;
    if (gap !== cache.gap) {
      cache.gap = gap;
      for (const p of ['k', 'v', 'x']) tGap[p].classList.toggle('mx-hide', !gap);
    }
    if (gap) setText(tGap.v, '+' + s.gapAhead.toFixed(s.gapAhead < 10 ? 2 : 1));
    // Keep WRONG WAY up continuously while the game reports it (no blinking re-entry between flashes).
    if (s.wrongWay && now > cache.wrongT) {
      cache.wrongT = now + 250;
      msgs.flash('WRONG WAY', 0.7, 'warn');
    }

    // Speed + gear
    setText(tach.spd, String(Math.round(Math.abs(+s.speedKmh || 0))));
    const g = gearLabel(s.gear);
    if (g !== cache.gear) {
      if (cache.gear) pop(tach.gear, '', g === 'R' ? RED : CYAN);
      cache.gear = g;
      setText(tach.gear, g);
    }
    tach.draw(+s.rpm || 0, +s.maxRpm || 8000, +s.nitro || 0, !!s.nitroActive, dt, time, s.launch);
    map.draw(s.cars, +s.speedKmh || 0, dt, time);
    drift.update(s, dt);
  }

  // ---- overlays: shared plumbing -------------------------------------------------------------
  const overlays = new Set();
  let menu = null, pause = null, results = null;
  let trackPoly = null;

  function setOverlay(o, on) {
    if (!o) return;
    o.root.classList.toggle('mx-on', on);
    if (on) {
      o.shownAt = performance.now();
      overlays.add(o);
      primePads();
      if (!padRaf) padRaf = requestAnimationFrame(padLoop);
    } else overlays.delete(o);
  }
  const ready = (o) => o && overlays.has(o) && performance.now() - o.shownAt > 260;

  function makeBtn(parent, label, cls, key) {
    const b = el('button', 'mx-btn ' + (cls || ''), parent);
    b.type = 'button';
    b.tabIndex = -1; // keep keyboard focus with the game (Space = handbrake must never "click" a menu button)
    b.addEventListener('click', () => b.blur());
    el('span', 'mx-btn-t', b, label);
    if (key) el('span', 'mx-key', b, key);
    b.addEventListener('mouseenter', () => sound('hover'));
    return b;
  }

  // ---- title menu ----------------------------------------------------------------------------
  function buildMenu() {
    const o = { root: el('div', 'mx-ov mx-menu', root), cb: null };
    el('div', 'mx-menu-shade', o.root);
    const left = el('div', 'mx-menu-left', o.root);
    const kicker = el('div', 'mx-kicker mx-in', left);
    kicker.innerHTML = '<span>NIGHT SERIES</span><b>EVENT 01</b>';
    const logo = el('div', 'mx-logo mx-in', left);
    const lines = el('div', 'mx-logo-lines', logo);
    const r = rng(42);
    for (let i = 0; i < 9; i++) {
      const l = el('i', '', lines);
      l.style.cssText = `top:${(6 + i * 10.5 + r() * 4).toFixed(1)}%;width:${(14 + r() * 30).toFixed(1)}em;animation-delay:${(-r() * 4).toFixed(2)}s;animation-duration:${(2.2 + r() * 2.4).toFixed(2)}s;opacity:${(0.35 + r() * 0.5).toFixed(2)}`;
    }
    o.logoTop = el('div', 'mx-logo-top', logo);
    o.logoMain = el('div', 'mx-logo-main', logo);
    el('div', 'mx-logo-bar', logo);
    o.sub = el('div', 'mx-sub mx-in', left);
    o.chips = el('div', 'mx-chips mx-in', left);
    const actions = el('div', 'mx-actions mx-in', left);
    o.btn = makeBtn(actions, 'START RACE', 'mx-primary', 'ENTER');
    o.btn.addEventListener('click', () => triggerStart());
    el('div', 'mx-press', left, 'PRESS ENTER TO RACE');

    // Right column: event card with live track preview + conditions.
    const card = el('div', 'mx-card mx-event mx-in-r', o.root);
    const head = el('div', 'mx-card-head', card);
    head.innerHTML = '<span>EVENT</span><b>CIRCUIT RACE</b>';
    o.preview = el('div', 'mx-preview', card);
    o.previewCv = el('canvas', '', o.preview);
    o.previewCv.addEventListener('contextrestored', () => o.drawPreview());
    o.stats = el('div', 'mx-stats', card);
    o.cond = el('div', 'mx-cond', card);

    const ctl = el('div', 'mx-card mx-controls mx-in-r', o.root);
    el('div', 'mx-card-head', ctl).innerHTML = '<span>CONTROLS</span><b>KEYBOARD</b>';
    const grid = el('div', 'mx-ctl-grid', ctl);
    for (const [keys, label] of CONTROLS) {
      const k = el('div', 'mx-kbd', grid);
      keys.forEach((key, i) => {
        if (i) el('span', 'mx-or', k, '/');
        el('i', key.length > 2 ? 'mx-wide' : '', k, key);
      });
      el('div', 'mx-ctl-act', grid, label);
    }
    const pad = el('div', 'mx-pad', ctl);
    pad.innerHTML = `${icon('pad')}<span>GAMEPAD SUPPORTED</span><em>RT throttle · LT brake · L-stick steer</em>`;

    const foot = el('div', 'mx-foot', o.root);
    foot.innerHTML = '<span>MIDNIGHT APEX</span><i></i><span>DEMO BUILD</span><i></i><span>PROCEDURAL · REAL-TIME</span>';

    o.resizePreview = (w, h, dpr) => {
      o.prevDpr = dpr;
      o.previewCv.width = Math.max(32, Math.round(w * dpr));
      o.previewCv.height = Math.max(32, Math.round(h * dpr));
      o.drawPreview();
    };
    o.drawPreview = () => drawTrackPreview(o.previewCv, trackPoly, o.prevDpr || dprNow());
    if (ro) ro.observe(o.preview);
    return o;
  }

  let menuOpts = {};
  function fillMenu(opts) {
    menuOpts = opts;
    const { title, subtitle, laps, racers } = opts;
    const words = String(title || CONFIG.title || 'MIDNIGHT APEX').trim().split(/\s+/);
    const main = words.length > 1 ? words.pop() : words[0];
    menu.logoTop.textContent = words.length && main !== words[0] ? words.join(' ') : '';
    menu.logoMain.textContent = '';
    menu.logoMain.dataset.text = main;
    el('span', '', menu.logoMain, main);
    menu.sub.textContent = String(subtitle || CONFIG.subtitle || '').toUpperCase();
    const L = laps || CONFIG.race.laps;
    const N = racers || CONFIG.race.aiCount + 1;
    menu.chips.innerHTML = [
      ['flag', `<b>${L}</b> LAPS`],
      ['racers', `<b>${N}</b> RACERS`],
      ['moon', 'NIGHT'],
      ['rain', 'RAIN'],
    ]
      .map(([i, t]) => `<div class="mx-chip">${icon(i)}<span>${t}</span></div>`)
      .join('');
    const km = map.length ? (map.length / 1000).toFixed(2) : '—';
    menu.stats.innerHTML =
      `<div><span>LENGTH</span><b>${km}<small>KM</small></b></div>` +
      `<div><span>LAPS</span><b>${L}</b></div>` +
      `<div><span>RACERS</span><b>${N}</b></div>`;
    menu.cond.innerHTML = `${icon('clock')}<span>23:47</span><i></i>${icon('rain')}<span>HEAVY RAIN</span><i></i>${icon('road')}<span>WET ASPHALT</span>`;
  }

  function triggerStart() {
    if (!menu || !menu.cb || !ready(menu)) return;
    const cb = menu.cb;
    menu.cb = null;
    sound('select');
    setOverlay(menu, false);
    try {
      cb();
    } catch (e) {
      console.error('[hud] onStart failed', e);
    }
  }

  // ---- pause -----------------------------------------------------------------------------------
  function buildPause() {
    const o = { root: el('div', 'mx-ov mx-pause', root), cbs: null, sel: 0 };
    const box = el('div', 'mx-pause-box', o.root);
    el('div', 'mx-kicker', box).innerHTML = '<span>RACE</span><b>ON HOLD</b>';
    el('div', 'mx-pause-title', box, 'PAUSED');
    const btns = el('div', 'mx-pause-btns', box);
    o.btns = [makeBtn(btns, 'RESUME', 'mx-mbtn', 'ESC'), makeBtn(btns, 'RESTART RACE', 'mx-mbtn', 'R')];
    o.btns[1].lastChild.remove(); // R is "reset car" in-game; no hint on restart
    o.btns.forEach((b, i) => {
      b.addEventListener('mouseenter', () => selectPause(i));
      b.addEventListener('click', () => activatePause(i));
    });
    el('div', 'mx-pause-hint', box, '↑ ↓ SELECT  ·  ENTER CONFIRM');
    return o;
  }
  function selectPause(i) {
    if (!pause) return;
    const n = pause.btns.length;
    pause.sel = ((i % n) + n) % n;
    pause.btns.forEach((b, j) => b.classList.toggle('mx-sel', j === pause.sel));
  }
  function activatePause(i = pause?.sel) {
    if (!pause || !pause.cbs || !ready(pause)) return;
    const cbs = pause.cbs;
    pause.cbs = null;
    sound('select');
    setOverlay(pause, false);
    const fn = i === 1 ? cbs.onRestart : cbs.onResume;
    try {
      fn && fn();
    } catch (e) {
      console.error('[hud] pause action failed', e);
    }
  }

  // ---- results -----------------------------------------------------------------------------
  function buildResults() {
    const o = { root: el('div', 'mx-ov mx-results', root), cb: null };
    const wrap = el('div', 'mx-res-wrap', o.root);
    const head = el('div', 'mx-res-head', wrap);
    const ht = el('div', 'mx-res-titles', head);
    el('div', 'mx-kicker', ht).innerHTML = '<span>RACE</span><b>COMPLETE</b>';
    el('div', 'mx-res-title', ht, 'RESULTS');
    o.place = el('div', 'mx-res-place', head);
    o.table = el('div', 'mx-res-table', wrap);
    const foot = el('div', 'mx-res-foot', wrap);
    el('div', 'mx-press', foot, 'PRESS ENTER TO RACE AGAIN');
    o.btn = makeBtn(foot, 'RACE AGAIN', 'mx-primary', 'ENTER');
    o.btn.addEventListener('click', () => triggerRestart());
    return o;
  }

  function fillResults(list) {
    const rows = Array.isArray(list) ? list : [];
    const winner = rows.find((r) => !r.dnf && validTime(r.time));
    const fastest = rows.reduce((m, r) => (validTime(r.bestLap) && (m == null || r.bestLap < m) ? r.bestLap : m), null);
    const me = rows.findIndex((r) => r.isPlayer);
    const o = results;
    o.table.textContent = '';
    const hdr = el('div', 'mx-res-row mx-res-hdr', o.table);
    for (const t of ['POS', 'DRIVER', 'TIME', 'GAP', 'BEST LAP']) el('span', '', hdr, t);
    rows.forEach((r, i) => {
      const row = el('div', 'mx-res-row' + (r.isPlayer ? ' mx-me' : '') + (r.dnf ? ' mx-dnf' : ''), o.table);
      row.style.animationDelay = `${0.25 + i * 0.07}s`;
      el('span', `mx-res-pos mx-p${i + 1}`, row, String(i + 1));
      const nm = el('span', 'mx-res-name', row);
      el('i', 'mx-chipc', nm).style.setProperty('--c', cssColor(r.color));
      el('span', '', nm, String(r.name || `DRIVER ${i + 1}`).toUpperCase());
      if (r.isPlayer && !/^you$/i.test(String(r.name || '').trim())) el('em', 'mx-you', nm, 'YOU');
      el('span', 'mx-res-time', row, r.dnf ? 'DNF' : fmtTime(validTime(r.time)));
      const gap = !r.dnf && winner && r !== winner && validTime(r.time) ? fmtDelta(r.time - winner.time) : r === winner ? 'WINNER' : '—';
      el('span', 'mx-res-gap' + (r === winner ? ' mx-win' : ''), row, gap);
      const bl = el('span', 'mx-res-best', row, fmtTime(validTime(r.bestLap)));
      if (fastest != null && r.bestLap === fastest) bl.classList.add('mx-fast');
    });
    o.place.textContent = '';
    if (me >= 0) {
      const p = me + 1, r = rows[me];
      o.place.className = `mx-res-place mx-p${p}`;
      el('div', 'mx-res-plbl', o.place, r.dnf ? 'DID NOT FINISH' : p === 1 ? 'VICTORY' : 'YOU FINISHED');
      const big = el('div', 'mx-res-pbig', o.place);
      big.innerHTML = r.dnf ? 'DNF' : `${p}<sup>${ordinal(p).toUpperCase()}</sup>`;
      el('div', 'mx-res-psub', o.place, r.dnf ? '' : `TOTAL ${fmtTime(validTime(r.time))}  ·  BEST ${fmtTime(validTime(r.bestLap))}`);
    }
  }

  function triggerRestart() {
    if (!results || !results.cb || !ready(results)) return;
    const cb = results.cb;
    results.cb = null;
    sound('select');
    setOverlay(results, false);
    try {
      cb();
    } catch (e) {
      console.error('[hud] onRestart failed', e);
    }
  }

  // ---- input (keyboard + gamepad for overlays only; the game owns everything else) ----------
  function onKey(e) {
    if (e.repeat) return;
    const enter = e.code === 'Enter' || e.code === 'NumpadEnter' || e.key === 'Enter';
    if (menu && overlays.has(menu) && menu.cb) {
      if (enter) triggerStart();
      return;
    }
    if (results && overlays.has(results) && results.cb) {
      if (enter) triggerRestart();
      return;
    }
    if (pause && overlays.has(pause) && pause.cbs) {
      if (e.code === 'ArrowUp' || e.code === 'KeyW') selectPause(pause.sel - 1), sound('hover');
      else if (e.code === 'ArrowDown' || e.code === 'KeyS') selectPause(pause.sel + 1), sound('hover');
      else if (enter) activatePause();
    }
  }
  window.addEventListener('keydown', onKey);

  let padRaf = 0;
  const padPrev = new Map();
  const padRead = (p) => ({
    a: !!(p.buttons[0] && p.buttons[0].pressed),
    start: !!(p.buttons[9] && p.buttons[9].pressed),
    up: !!(p.buttons[12] && p.buttons[12].pressed) || (p.axes[1] || 0) < -0.6,
    down: !!(p.buttons[13] && p.buttons[13].pressed) || (p.axes[1] || 0) > 0.6,
  });
  function pads() {
    try {
      return (navigator.getGamepads && navigator.getGamepads()) || [];
    } catch (e) {
      return [];
    }
  }
  function primePads() {
    for (const p of pads()) if (p) padPrev.set(p.index, padRead(p));
  }
  function padLoop() {
    padRaf = 0;
    if (!overlays.size) return;
    for (const p of pads()) {
      if (!p) continue;
      const cur = padRead(p), prev = padPrev.get(p.index) || {};
      padPrev.set(p.index, cur);
      const hit = (k) => cur[k] && !prev[k];
      if (menu && overlays.has(menu) && menu.cb) {
        if (hit('a') || hit('start')) triggerStart();
      } else if (results && overlays.has(results) && results.cb) {
        if (hit('a') || hit('start')) triggerRestart();
      } else if (pause && overlays.has(pause) && pause.cbs) {
        if (hit('up')) selectPause(pause.sel - 1);
        if (hit('down')) selectPause(pause.sel + 1);
        if (hit('a')) activatePause();
      }
    }
    padRaf = requestAnimationFrame(padLoop);
  }

  // ---- public API --------------------------------------------------------------------------
  const hud = {
    root,
    showMenu({ onStart, title, subtitle, laps, racers } = {}) {
      if (!menu) menu = buildMenu();
      msgs.clear();
      cd.hide();
      fillMenu({ title, subtitle, laps, racers });
      menu.cb = typeof onStart === 'function' ? onStart : () => {};
      menu.root.classList.remove('mx-anim');
      void menu.root.offsetWidth; // restart the intro animation (menu open is not a per-frame path)
      menu.root.classList.add('mx-anim');
      setOverlay(menu, true);
      if (trackPoly) menu.drawPreview();
    },
    hideMenu() {
      if (!menu) return;
      menu.cb = null;
      setOverlay(menu, false);
    },
    showHUD(visible = true) {
      hudOn = !!visible;
      race.classList.toggle('mx-on', hudOn);
      if (hudOn) {
        lastT = performance.now();
        tach.last.n = -1;
      }
    },
    setTrack(polyline, opts) {
      trackPoly = Array.isArray(polyline) ? polyline.map((p) => [+p[0] || 0, +p[1] || 0]) : null;
      map.setTrack(trackPoly, opts);
      if (menu) {
        if (menu.cb) fillMenu(menuOpts);
        menu.drawPreview();
      }
    },
    update,
    showCountdown(value) {
      cd.show(value);
    },
    hideCountdown() {
      cd.hide();
    },
    flash(text, { duration = 2, kind = 'info' } = {}) {
      const t = String(text == null ? '' : text).trim();
      if (!t) return;
      // Drift score pop-ups get their own style/slot; if the game reports drift scores itself,
      // the HUD's built-in drift scoring switches off to avoid double pop-ups.
      const dm = /DRIFT/i.test(t) && /\+?(\d[\d,]*(?:\.\d+)?)/.exec(t);
      if (dm) {
        drift.auto = false;
        drift.setLive(false);
        drift.pop(parseFloat(dm[1].replace(/,/g, '')) || 0, t.replace(dm[0], '').replace(/\s+/g, ' ').trim() || 'DRIFT');
        return;
      }
      msgs.flash(t, +duration || 2, kind);
    },
    showPause(visible, { onResume, onRestart } = {}) {
      if (!visible) {
        if (pause) {
          pause.cbs = null;
          setOverlay(pause, false);
        }
        return;
      }
      if (!pause) pause = buildPause();
      pause.cbs = { onResume, onRestart };
      selectPause(0);
      setOverlay(pause, true);
      pause.shownAt += 40; // > 250 ms: the game ignores resume requests right after pausing
    },
    showResults(list, { onRestart } = {}) {
      if (!results) results = buildResults();
      msgs.clear(); // finish banners would otherwise show blurred behind the results backdrop
      fillResults(list);
      results.cb = typeof onRestart === 'function' ? onRestart : () => {};
      results.root.classList.remove('mx-anim');
      void results.root.offsetWidth;
      results.root.classList.add('mx-anim');
      setOverlay(results, true);
      results.shownAt += 500; // let the rows animate in before Enter is accepted
    },
    hideResults() {
      if (!results) return;
      results.cb = null;
      setOverlay(results, false);
    },
    // ---- optional extras (not in the contract; safe to ignore) ----
    /** Activate the primary action of the visible overlay (e.g. from a gamepad handled by the core). */
    confirm() {
      if (menu && overlays.has(menu)) triggerStart();
      else if (results && overlays.has(results)) triggerRestart();
      else if (pause && overlays.has(pause)) activatePause();
    },
    /** Hook UI sounds: fn(kind) with kind 'hover' | 'select'. */
    setSoundHandler(fn) {
      soundFn = typeof fn === 'function' ? fn : null;
    },
    /** Pop a drift score directly ("+1,250 DRIFT"). */
    driftPopup(points, label = 'DRIFT') {
      drift.pop(points, label);
    },
    clearMessages() {
      msgs.clear();
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      if (ro) ro.disconnect();
      if (padRaf) cancelAnimationFrame(padRaf);
      msgs.clear();
      root.remove();
    },
  };
  return hud;
}
