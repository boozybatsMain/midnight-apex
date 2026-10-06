#!/usr/bin/env node
// Headless test/screenshot harness for MIDNIGHT APEX (uses the system Google Chrome via playwright-core).
//
// Usage:
//   node scripts/shot.mjs [--url URL] [--out shots/name] [--width 1280] [--height 720]
//                         [--wait 4000] [--steps '<json array>'] [--headed] [--uncapped]
//
// --dpr 2 emulates a HiDPI screen (devicePixelRatio). --uncapped disables vsync / the frame-rate limit so {"fps"} measures real GPU headroom (not capped at 60).
//
// --steps is a JSON array executed in order. Supported step objects:
//   {"wait": 1000}                      sleep ms (game keeps running)
//   {"down": "KeyW"} / {"up": "KeyW"}   hold / release a key (KeyboardEvent.code names, e.g. ArrowUp, Space, ShiftLeft)
//   {"press": "Enter"}                  tap a key
//   {"hold": "KeyW", "ms": 3000}        hold a key for ms then release
//   {"click": [x, y]}                   mouse click at viewport coords
//   {"shot": "label"}                   screenshot -> <out>-<label>.png
//   {"eval": "js expression"}           evaluate in page, prints JSON result
//   {"fps": 3000}                       measure requestAnimationFrame FPS over ms
// A final screenshot <out>-final.png is always taken. Console messages and page errors are printed.
import { chromium } from 'playwright-core';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
};
const flag = (name) => argv.includes('--' + name);

const url = opt('url', 'http://127.0.0.1:5391/');
const out = opt('out', 'shots/shot');
const width = parseInt(opt('width', '1280'), 10);
const height = parseInt(opt('height', '720'), 10);
const initialWait = parseInt(opt('wait', '4000'), 10);
const steps = JSON.parse(opt('steps', '[]'));

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !flag('headed'),
  args: [
    '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required',
    ...(flag('uncapped') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
  ],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: parseFloat(opt('dpr', '1')) || 1 });
const logs = [];
page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[PAGE ERROR] ${e.message}\n${e.stack || ''}`));
page.on('requestfailed', (r) => logs.push(`[REQUEST FAILED] ${r.url()} ${r.failure()?.errorText}`));

const t0 = Date.now();
try {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
} catch (e) {
  logs.push('[GOTO ERROR] ' + e.message);
}
await page.waitForTimeout(initialWait);

for (const s of steps) {
  try {
    if (s.wait != null) await page.waitForTimeout(s.wait);
    else if (s.down) await page.keyboard.down(s.down);
    else if (s.up) await page.keyboard.up(s.up);
    else if (s.press) await page.keyboard.press(s.press);
    else if (s.hold) { await page.keyboard.down(s.hold); await page.waitForTimeout(s.ms ?? 1000); await page.keyboard.up(s.hold); }
    else if (s.click) await page.mouse.click(s.click[0], s.click[1]);
    else if (s.shot) { await page.screenshot({ path: `${out}-${s.shot}.png` }); console.log(`saved ${out}-${s.shot}.png`); }
    else if (s.eval) {
      const r = await page.evaluate((code) => { try { return JSON.parse(JSON.stringify((0, eval)(code))); } catch (e) { return 'EVAL ERROR: ' + e.message; } }, s.eval);
      console.log('[eval]', s.eval, '=>', JSON.stringify(r));
    } else if (s.fps) {
      const fps = await page.evaluate((ms) => new Promise((res) => { let n = 0; const st = performance.now(); const f = () => { n++; if (performance.now() - st < ms) requestAnimationFrame(f); else res(n / ((performance.now() - st) / 1000)); }; requestAnimationFrame(f); }), s.fps);
      console.log(`[fps] ${fps.toFixed(1)} over ${s.fps}ms`);
    }
  } catch (e) {
    logs.push(`[STEP ERROR] ${JSON.stringify(s)}: ${e.message}`);
  }
}
await page.screenshot({ path: `${out}-final.png` });
console.log(`saved ${out}-final.png (elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log('--- browser logs (' + logs.length + ') ---');
for (const l of logs.slice(-150)) console.log(l);
await browser.close();
