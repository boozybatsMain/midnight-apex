// MIDNIGHT APEX — game core: bootstraps every module, runs the fixed-step loop and the
// race state machine (menu → intro → countdown → racing → finished, with pause).
import * as THREE from 'three';
import { CONFIG, URL_PARAMS, LAYERS, clamp, damp, lerp } from '../config.js';
import { createTrack } from '../world/track.js';
import { createEnvironment } from '../world/environment.js';
import { createCarModel } from '../vehicle/carModel.js';
import { VehiclePhysics } from '../vehicle/physics.js';
import { AIDriver } from '../vehicle/ai.js';
import { createParticles } from '../fx/particles.js';
import { createRain } from '../fx/rain.js';
import { createPostFX } from '../fx/postfx.js';
import { createAudio } from '../audio/audio.js';
import { createHUD } from '../ui/hud.js';

import { Input } from './input.js';
import { CameraRig } from './camera.js';
import { RaceManager } from './race.js';
import { RaceCar } from './car.js';
import { collideBarrier, collideCars, clearContacts } from './collisions.js';
import { EffectsDirector } from './effects.js';
import { applySlipstream } from './draft.js';
import { AudioDirector } from './audiomix.js';
import { DebugOverlay } from './debug.js';
import { applyShaderPatches } from './shaderPatches.js';
// Namespace import: the headlight cookie profile is optional (the core falls back if it's renamed).
import * as carTextures from '../vehicle/carTextures.js';
import {
  createGuard, ordinal, formatTime, hexColor, smoothstep, approach,
  NOOP_AUDIO, NOOP_PARTICLES, NOOP_RAIN, NOOP_HUD,
} from './util.js';

const FIXED_DT = CONFIG.physics.fixedDt;
const AI_EVERY = 2; // AI controllers run every 2nd physics step (60 Hz sim time)
const INTRO_TIME = 2.6;
const RESTART_INTRO_TIME = 1.8;
const RESULTS_TIMEOUT = 25;
// Controls while cars are held on the grid (`hold` stops the physics engaging reverse).
const HELD = Object.freeze({ throttle: 0, brake: 0, steer: 0, handbrake: true, nitro: false, hold: true });
// Launch control: free-revving rpm (fraction of max) at GO. Shown on the HUD tach during the countdown.
const LAUNCH = { perfect: [0.45, 0.85], good: [0.3, 0.92], perfectBoost: 3.8, goodBoost: 1.6 };
// Rivals (car 1..n). The grid is NOT in pace order — the pole sitter is a mid-pace defender, the quickest
// (NOVA) starts behind the player — so the field has to race through itself. aggression = personality:
// high = late-braking attacker, low = defender that covers the inside line.
const AI_SKILL = [0.88, 0.92, 0.86, 0.95, 0.84, 0.9, 0.8];
const AI_AGGR = [0.45, 0.7, 0.35, 0.6, 0.5, 0.55, 0.65];

// Headlight exposure caps (see Game._beamExposure). carLux is the illuminance budget for a paint of
// luminance 1 (white ≈ 0.8 → ~1.6 lx total; dark liveries are capped at 1 / minLum of it). wallLum is the
// budget (lx × albedo) for the brightest barrier point in the beam: π·1.5 → diffuse luminance ≈ 1.5, i.e. the
// white painted corner blocks (albedo ≈ 0.65) get ≈ 7 lx and bare concrete (≈ 0.28) ≈ 17 lx. wallFloor is the
// lowest scale the barrier cap alone may set, wallRange how far ahead barriers count.
// hitY: heights (m) sampled on the other car's body (the low-beam cut-off crosses its rear); cookieFallback is
// the assumed peak of an unknown light cookie.
const BEAM = {
  wallLum: 4.7, paintAlbedo: 0.65, concAlbedo: 0.28, wallFloor: 0.004, wallRange: 26, wallRays: [0, -0.19, 0.19, -0.45, 0.45], wallH: [0.06, 0.18, 0.3, 0.42, 0.54, 0.66, 0.78], carLux: 1.3, minLum: 0.16, floor: 0.003, maxDist: 40,
  halfW: 0.95, halfL: 2.2, hitY: [0.3, 0.5, 0.7, 0.95], cookieFallback: 6,
};

// Speed-blur protected region per camera (postfx.set focus API). Chase cams use the postfx default (car at the
// bottom centre); the hood cam protects the bonnet across the bottom of the frame; the bumper cam protects nothing.
const BLUR_FOCUS = [
  { focus: null, focusRadius: null },
  { focus: [0.5, -0.06], focusRadius: [1.6, 0.34] },
  { focus: null, focusRadius: 0 },
];

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export class Game {
  constructor({ container = document.body, veil = null } = {}) {
    this.container = container;
    this.veil = veil;
    this.quality = CONFIG.quality === 'low' ? 'low' : 'high';
    this.timeScale = URL_PARAMS.timescale > 0 ? URL_PARAMS.timescale : 1;
    this.autopilot = URL_PARAMS.autopilot;
    this.totalLaps = CONFIG.race.laps;
    this.mode = 'loading';
    this.prevMode = 'racing';
    this.modeT = 0;
    this.time = 0;
    this.acc = 0;
    this.stepCount = 0;
    this.alpha = 1;
    this.fps = 60;
    this.guard = createGuard();
    this.audioReady = false;
    this.resultsShown = false;
    this.finishedT = 0;
    this.countdownShown = 0;
    this.hideCountdownAt = -1;
    this.lastRestart = -10;
    this.lastPauseToggle = -1e9;
    this.frameDt = 1 / 60;
    this.resetCooldown = 0;
    this.impactFlash = 0;
    this.impactCd = 0;
    this.lastImpact = 0;
    this.nitroFx = 0;
    this.wrongWayFlashT = 0;
    this.flashQueue = [];
    // Drift chain state; the object is handed to the HUD as state.drift = { active, score, multiplier }.
    this.drift = { time: 0, grace: 0, score: 0, total: 0, active: false, multiplier: 1 };
    this.firstFrame = true;
    this.drs = { enabled: new URLSearchParams(location.search).get('drs') !== '0', acc: 0, frames: 0, cooldown: 4 };
  }

  // ---------------------------------------------------------------- setup
  async init() {
    this._status('Starting engine');
    await nextFrame();
    applyShaderPatches(); // before any material compiles
    this._createRenderer();
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 3000);
    this.camera.position.set(0, 3, -10);
    // Game cameras also see the NO_REFLECTION layer (flames, sparks, rain, beam decals...) that the
    // wet-road reflection camera masks out. Every view (chase, cockpit, cinematic) uses this camera.
    this.camera.layers.enable(LAYERS.NO_REFLECTION);
    this.scene.add(this.camera); // so camera-attached children (if any) render

    this._status('Paving the streets');
    await nextFrame();
    this.track = createTrack({ renderer: this.renderer, quality: this.quality });
    if (this.track.group) this.scene.add(this.track.group);

    this._status('Lighting the city');
    await nextFrame();
    this.env = this._make('environment', () => createEnvironment({ scene: this.scene, renderer: this.renderer, track: this.track, quality: this.quality }), null);
    if (this.env && this.env.envMap) this.scene.environment = this.env.envMap;
    if (!this.scene.background) this.scene.background = new THREE.Color(0x05060c);

    this._status('Prepping the grid');
    await nextFrame();
    this._createCars();

    this._status('Charging the night');
    await nextFrame();
    this.particles = this._make('particles', () => createParticles({ scene: this.scene, quality: this.quality }), NOOP_PARTICLES);
    this.rain = this._make('rain', () => createRain({ scene: this.scene, quality: this.quality }), NOOP_RAIN);
    this.postfx = URL_PARAMS.nofx ? null : this._make('postfx', () => createPostFX({ renderer: this.renderer, scene: this.scene, camera: this.camera, quality: this.quality }), null);
    this.audio = this._make('audio', () => createAudio(), NOOP_AUDIO);
    this.hud = this._make('hud', () => createHUD({ container: document.body }), NOOP_HUD);
    this.guard('hud.setTrack', () => this.hud.setTrack(this.track.getMinimapPolyline(256)));
    if (typeof this.hud.setSoundHandler === 'function') {
      this.guard('hud.sound', () => this.hud.setSoundHandler((kind) => { if (this.audioReady) this.guard('audio.ui', () => this.audio.playUI(kind)); }));
    }
    this.guard('hud.showHUD', () => this.hud.showHUD(false));

    this.input = new Input(window);
    this.input.onGesture = () => this._unlockAudio();
    this.cameraRig = new CameraRig(this.camera, { track: this.track });
    this.guard('camera.calibrate', () => this.cameraRig.calibrate(this.player.model));
    this.effects = new EffectsDirector(this.particles, { quality: this.quality });
    this.audioDirector = new AudioDirector(this.audio);
    this.debug = new DebugOverlay(document.body);
    if (URL_PARAMS.debug) this.debug.toggle(true);

    this.race = new RaceManager(this.track, this.totalLaps);
    for (const car of this.cars) this.race.addCar(car);
    this.race.events.onLap = (car, t, best, fin) => this._onLap(car, t, best, fin);
    this.race.events.onFinish = (car, order) => this._onFinish(car, order);
    this._placeOnGrid();

    this._bindEvents();
    this._buildHudState();
    this._exposeDebugApi();

    this._singlePassTransparents();

    // Compile shaders up-front behind the loading veil to avoid first-lap hitches.
    this._status('Compiling shaders');
    this._syncVisuals(1);
    this.cameraRig.setScript('orbit');
    this.cameraRig.update(0.016, this.player);
    try {
      await Promise.race([
        this.renderer.compileAsync(this.scene, this.camera),
        new Promise((r) => setTimeout(r, 6000)),
      ]);
    } catch (e) {
      console.warn('[core] shader precompile skipped:', e);
    }
    // One plain warm-up render: allocates shadow maps / render lists before any offscreen pass
    // (e.g. the planar road reflection) samples them on the first real frame.
    this.guard('warmup', () => this.renderer.render(this.scene, this.camera));

    if (URL_PARAMS.autostart) this._enterCountdown();
    else this._enterMenu();

    this.last = performance.now();
    this.renderer.setAnimationLoop((t) => this._frame(t));
  }

  /**
   * three renders a transparent DoubleSide material twice (back faces, then front) and flags
   * material.needsUpdate on both draws — every frame, in every pass — which re-resolves the shader
   * program and churns ~8 MB/s of garbage. Additive / depth-write-free effects don't need that
   * ordering, so render them in a single pass.
   */
  _singlePassTransparents() {
    // Same story in the shadow pass: three shares ONE default depth material between instanced and
    // plain meshes, so every instanced↔plain switch flips its `instancing` flag and re-resolves the
    // program (~16×/frame here). Instanced casters get their own shared depth material instead.
    const instDepth = new THREE.MeshDepthMaterial();
    this.scene.traverse((o) => {
      if (o.isInstancedMesh && o.castShadow && o.customDepthMaterial === undefined) {
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        if (m && !(m.alphaTest > 0) && !m.alphaMap && !m.displacementMap && !m.alphaToCoverage) o.customDepthMaterial = instDepth;
      }
    });
    this.scene.traverse((o) => {
      const list = Array.isArray(o.material) ? o.material : o.material ? [o.material] : null;
      if (!list) return;
      for (const m of list) {
        if (m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass && (m.blending === THREE.AdditiveBlending || m.depthWrite === false)) {
          m.forceSinglePass = true;
        }
      }
    });
  }

  _status(text) {
    const el = this.veil && this.veil.querySelector('.veil-status');
    if (el) el.textContent = text;
  }

  _make(name, factory, fallback) {
    try {
      return factory();
    } catch (e) {
      console.error(`[core] failed to create ${name}; continuing without it.`, e);
      return fallback;
    }
  }

  _createRenderer() {
    const r = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 1.5 : 1);
    this.pixelRatio = this.maxPixelRatio;
    r.setPixelRatio(this.pixelRatio);
    r.setSize(innerWidth, innerHeight);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    // r186 removed PCFSoftShadowMap; PCFShadowMap now does soft (Vogel-disk) filtering.
    r.shadowMap.type = THREE.PCFShadowMap;
    r.info.autoReset = false; // count draw calls across all passes of a frame
    r.domElement.classList.add('game-canvas');
    r.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
    this.container.appendChild(r.domElement);
    this.renderer = r;
  }

  _createCars() {
    const aiCount = CONFIG.race.aiCount;
    const total = aiCount + 1;
    this.playerSlot = Math.min(aiCount, Math.floor(total * 0.6));
    this.cars = [];
    let slot = 0;
    for (let i = 0; i < total; i++) {
      const isPlayer = i === 0;
      const livery = CONFIG.liveries[i % CONFIG.liveries.length];
      const model = this._make(`carModel ${livery.name}`, () => createCarModel({
        color: livery.color, accent: livery.accent, name: livery.name, isPlayer,
        quality: this.quality, envMap: this.env ? this.env.envMap : null,
      }), null) || fallbackModel(livery.color);
      const physics = new VehiclePhysics({});
      let ai = null;
      if (!isPlayer) {
        const k = (i - 1) % AI_SKILL.length;
        ai = new AIDriver({
          track: this.track, physics, skill: AI_SKILL[k], aggression: AI_AGGR[k],
          laneBias: ((i % 2) * 2 - 1) * 0.15, seed: 17 + i * 31,
        });
      }
      const car = new RaceCar({ index: i, livery, isPlayer, model, physics, ai });
      if (isPlayer) car.gridSlot = this.playerSlot;
      else {
        if (slot === this.playerSlot) slot++;
        car.gridSlot = slot++;
      }
      car.aiCtx = { raceActive: false, selfProgress: 0, playerProgress: 0, cars: null };
      this.scene.add(model.root);
      this.cars.push(car);
    }
    this.player = this.cars[0];
    this.player.autoAI = new AIDriver({ track: this.track, physics: this.player.physics, skill: 0.97, aggression: 0.4, laneBias: 0, seed: 7 });
    this.player.autoAI.isAutopilot = true;
    // Shared context the AI sees (contract: [{ physics, s, lateral, progress }]).
    this.aiCars = this.cars.map((c) => ({ physics: c.physics, s: 0, lateral: 0, progress: 0, index: c.index, isPlayer: c.isPlayer }));
    for (const c of this.cars) c.aiCtx.cars = this.aiCars;
    this.player.autoAI.ctx = { raceActive: true, selfProgress: 0, playerProgress: 0, cars: this.aiCars };
  }

  _placeOnGrid() {
    const tr = this.track;
    for (const car of this.cars) {
      const g = tr.getStartGrid(car.gridSlot);
      car.place(g.position, g.heading);
      const pr = tr.project(car.physics.position);
      car.s = pr.s;
      car.lateral = pr.lateral;
      car.ghost = 0;
      car.stuckTimer = 0;
      car.model.root.visible = true;
      const rel = this.race ? this.race.wrapRel(car.s) : 0;
      car.gridOffset = rel > tr.length * 0.5 ? tr.length - rel : 0;
      clearContacts(car.contact);
      for (const k in car.controls) car.controls[k] = typeof car.controls[k] === 'boolean' ? false : 0;
    }
    if (this.race) this.race.reset();
    this._refreshAiCars();
    // Let every AI driver see "race not active" once so its timers/recovery state reset.
    const idle = this._idleCtx || (this._idleCtx = { raceActive: false, selfProgress: 0, playerProgress: 0, cars: this.aiCars });
    for (const car of this.cars) {
      const ai = car.ai || car.autoAI;
      if (ai) this.guard('ai.reset', aiUpdate, ai, 1 / 60, idle);
      if (car.ai && car.autoAI) this.guard('ai.reset', aiUpdate, car.autoAI, 1 / 60, idle);
    }
  }

  _bindEvents() {
    addEventListener('resize', () => this._resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // (the audio module suspends its own context while hidden)
        if (this.mode === 'racing' || this.mode === 'countdown' || this.mode === 'intro' || (this.mode === 'finished' && !this.resultsShown)) this._pause();
      } else {
        this.last = performance.now();
      }
    });
  }

  _resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.postfx) {
      this.guard('postfx.resize', () => {
        if (this.postfx.composer && this.postfx.composer.setPixelRatio) this.postfx.composer.setPixelRatio(this.pixelRatio);
        this.postfx.setSize(w, h);
      });
    }
  }

  _unlockAudio() {
    if (this.audioReady) return;
    this.audioReady = true;
    this.guard('audio.init', () => {
      this.audio.init();
      if (URL_PARAMS.mute) {
        if (typeof this.audio.setMuted === 'function') this.audio.setMuted(true);
        else if (this.audio.toggleMute() === false) this.audio.toggleMute();
      }
      this.audio.setAmbience(true);
      this.audio.setMusic(true);
    });
  }

  // ---------------------------------------------------------------- state machine
  _setMode(m) {
    this.mode = m;
    this.modeT = 0;
  }

  _enterMenu() {
    this._setMode('menu');
    this.cameraRig.setScript('orbit');
    this.guard('hud.showHUD', () => this.hud.showHUD(false));
    this.guard('hud.showMenu', () => this.hud.showMenu({
      title: CONFIG.title,
      subtitle: CONFIG.subtitle,
      laps: this.totalLaps,
      racers: this.cars.length,
      onStart: () => this._startFromMenu(),
    }));
  }

  _startFromMenu() {
    if (this.mode !== 'menu') return;
    this._unlockAudio();
    this.guard('audio.ui', () => this.audio.playUI('select'));
    this.guard('hud.hideMenu', () => this.hud.hideMenu());
    this._enterIntro(INTRO_TIME);
  }

  _enterIntro(duration) {
    this._setMode('intro');
    this.guard('hud.showHUD', () => this.hud.showHUD(false));
    this.cameraRig.setScript('intro', { duration, onEnd: () => { if (this.mode === 'intro') this._enterCountdown(); } });
    this._queueFlash(`${CONFIG.subtitle.toUpperCase()}  ·  ${this.totalLaps} LAP${this.totalLaps > 1 ? 'S' : ''}`, { duration: 2.2, kind: 'info' }, 0.25);
  }

  _enterCountdown() {
    this._setMode('countdown');
    this.cameraRig.setScript('chase');
    this.cameraRig.snap(this.player);
    this.countdownShown = 0;
    this.guard('hud.showHUD', () => this.hud.showHUD(true));
    this._countdownTick();
  }

  _countdownTick() {
    const n = CONFIG.race.countdownSeconds;
    const step = Math.floor(this.modeT) + 1; // 1.. n, then GO
    if (step <= n && step > this.countdownShown) {
      this.countdownShown = step;
      const value = n - step + 1;
      this.guard('hud.countdown', () => this.hud.showCountdown(value));
      this.guard('audio.beep', () => this.audio.playBeep(false));
    }
    if (this.modeT >= n) this._go();
  }

  _go() {
    this._setMode('racing');
    this.race.start();
    this.guard('hud.countdown', () => this.hud.showCountdown('GO'));
    this.guard('audio.beep', () => this.audio.playBeep(true));
    this.hideCountdownAt = 1.0;
    // Launch control: free-rev rpm in the sweet spot at GO gives a boost.
    for (const car of this.cars) {
      const ph = car.physics;
      const r = car.rev.rpm / (ph.maxRpm || 8000);
      let boost = 0;
      if (car.isPlayer && !this.autopilot) {
        // From idle a held throttle sweeps through the window in ~¼ s, so with a keyboard this is a
        // timing skill: hit the gas just before GO (or feather it). Bouncing off the limiter = wheelspin.
        if (r >= LAUNCH.perfect[0] && r <= LAUNCH.perfect[1]) {
          boost = LAUNCH.perfectBoost;
          this._queueFlash('PERFECT LAUNCH', { duration: 1.6, kind: 'good' }, 0.35);
        } else if (r >= LAUNCH.good[0] && r <= LAUNCH.good[1]) {
          boost = LAUNCH.goodBoost;
          this._queueFlash('GOOD LAUNCH', { duration: 1.2, kind: 'info' }, 0.35);
        } else if (r > LAUNCH.good[1]) {
          this._queueFlash('WHEELSPIN', { duration: 1.0, kind: 'warn' }, 0.35);
        } else if (car.rev.throttle < 0.05 && r < LAUNCH.good[0]) {
          this._queueFlash('SLOW START', { duration: 1.0, kind: 'warn' }, 0.35);
        }
        this.lastLaunch = { rpm: r, boost };
      } else {
        boost = 1.2 + Math.random() * 2.2;
      }
      if (boost > 0) {
        const f = this._v1.set(Math.sin(ph.heading), 0, Math.cos(ph.heading)).multiplyScalar(boost * (ph.mass || 1450));
        this.guard('launch', () => ph.applyImpulse(f, ph.position));
      }
      car.launchBlend = 0;
    }
  }

  _onLap(car, lapTime, newBest, finished) {
    if (!car.isPlayer || finished) return;
    const r = car.race;
    this.guard('audio.ui', () => this.audio.playUI('lap'));
    if (r.lapsDone === this.totalLaps - 1) this._queueFlash('FINAL LAP', { duration: 2.4, kind: 'warn' }, 0);
    else this._queueFlash(`LAP ${r.lapsDone + 1} / ${this.totalLaps}`, { duration: 1.8, kind: 'info' }, 0);
    if (newBest) this._queueFlash(`NEW BEST LAP  ${formatTime(lapTime)}`, { duration: 2.2, kind: 'good' }, 2.3);
  }

  _onFinish(car, order) {
    if (!car.isPlayer) return;
    this._setMode('finished');
    this.finishedT = 0;
    this.resultsShown = false;
    this.guard('audio.ui', () => this.audio.playUI('finish'));
    const pos = order;
    this.flashQueue.length = 0;
    this._queueFlash(pos === 1 ? 'YOU WIN!' : `FINISHED ${ordinal(pos)}`, { duration: 3.5, kind: pos <= 3 ? 'good' : 'info' }, 0);
    this.cameraRig.setScript('finish', { blend: 1.6 });
  }

  _showResults() {
    if (this.resultsShown) return;
    this.resultsShown = true;
    this.resultsShownAt = performance.now();
    const res = this.race.buildResults().map((r) => ({
      name: r.car.name, time: r.time, bestLap: r.bestLap, isPlayer: r.car.isPlayer,
      color: hexColor(r.car.color), dnf: r.dnf,
    }));
    this.guard('hud.showHUD', () => this.hud.showHUD(false));
    this.guard('hud.showResults', () => this.hud.showResults(res, { onRestart: () => this.restart() }));
  }

  _pause() {
    if (this.mode === 'paused' || this.mode === 'menu' || this.mode === 'loading') return;
    if (performance.now() - this.lastPauseToggle < 250) return; // HUD may also react to Esc
    this.lastPauseToggle = performance.now();
    this.prevMode = this.mode;
    this._setModeKeepT('paused');
    if (typeof this.audio.setPaused === 'function') this.guard('audio.pause', () => this.audio.setPaused(true));
    this.guard('hud.showPause', () => this.hud.showPause(true, { onResume: () => this._resume(), onRestart: () => this.restart() }));
  }

  _resume() {
    if (this.mode !== 'paused') return;
    if (performance.now() - this.lastPauseToggle < 250) return;
    this.lastPauseToggle = performance.now();
    this.mode = this.prevMode;
    this.modeT = this._savedModeT;
    if (typeof this.audio.setPaused === 'function') this.guard('audio.pause', () => this.audio.setPaused(false));
    this.guard('hud.showPause', () => this.hud.showPause(false));
    this.last = performance.now();
  }

  _setModeKeepT(m) {
    this._savedModeT = this.modeT;
    this.mode = m;
  }

  restart() {
    const now = performance.now() / 1000;
    if (now - this.lastRestart < 0.6) return;
    this.lastRestart = now;
    this.guard('hud.hideResults', () => this.hud.hideResults());
    this.guard('hud.showPause', () => this.hud.showPause(false));
    if (typeof this.audio.setPaused === 'function') this.guard('audio.pause', () => this.audio.setPaused(false));
    this.guard('hud.hideCountdown', () => this.hud.hideCountdown());
    for (const car of this.cars) this.effects.endSkids(car);
    this.guard('particles.clear', () => this.effects.clear(this.cars));
    this._placeOnGrid();
    this.input.resetControls();
    this.resultsShown = false;
    this.flashQueue.length = 0;
    this.drift.time = this.drift.grace = this.drift.score = this.drift.total = 0;
    this.drift.active = false;
    this.impactFlash = 0;
    this.acc = 0;
    this.hideCountdownAt = -1;
    this._unlockAudio();
    this._enterIntro(RESTART_INTRO_TIME);
  }

  startRace() {
    if (this.mode === 'menu') this._startFromMenu();
    else if (this.mode !== 'loading') this.restart();
  }

  // ---------------------------------------------------------------- per-frame
  // The whole frame is guarded: three's animation loop stops re-arming rAF if the callback throws.
  _frame(nowMs) {
    try {
      this._frameInner(nowMs);
    } catch (e) {
      this.guard('frame', rethrow, e);
    }
  }

  _frameInner(nowMs) {
    const realDt = Math.min(Math.max((nowMs - this.last) / 1000, 0), 0.1);
    this.last = nowMs;
    if (realDt > 0) this.fps = lerp(this.fps, 1 / realDt, 0.05);
    const paused = this.mode === 'paused';
    const dt = paused ? 0 : realDt * this.timeScale;
    this.time += dt;
    this.modeT += dt;
    this.frameDt = dt;
    this.renderer.info.reset();
    const prof = this.prof; // ~6 performance.now() calls per frame: always on (telemetry + overlay)
    let t0 = prof ? performance.now() : 0;

    const player = this.player;
    this.input.update(realDt, player.physics.speedKmh || 0);
    if (this._script) this._scriptTick();
    this._handleActions();
    this._updateMode(dt);
    if (dt > 0) this.guard('simulate', this._simulateBound, dt);
    this._syncVisuals(this.alpha);
    this.guard('race', this._raceUpdate, dt);
    if (prof) t0 = mark(prof, 'sim', t0);
    this.guard('camera', this._cameraUpdate, dt);
    this.guard('effects', this._effectsUpdate, dt);
    this.guard('particles', this._particlesUpdate, dt);
    this.guard('rain', this._rainUpdate, realDt);
    this.guard('beams', this._cullBeamDecalsBound);
    if (prof) t0 = mark(prof, 'fx', t0);
    this.guard('world', this._worldUpdate, dt);
    if (prof) t0 = mark(prof, 'world', t0);
    this.guard('audio', this._audioUpdate, realDt);
    this.guard('hud', this._hudUpdate, dt);
    if (prof) t0 = mark(prof, 'ui', t0);
    this.guard('render', this._render, realDt);
    if (prof) t0 = mark(prof, 'render', t0);
    if (this._script && this._script.pendingShot) this._scriptCapture();
    this._postFrame(realDt);
  }

  _simulateBound = (dt) => this._simulate(dt);
  _cullBeamDecalsBound = () => this._cullBeamDecals();
  prof = { sim: 0, fx: 0, world: 0, ui: 0, render: 0 };

  _handleActions() {
    const inp = this.input;
    if (inp.consume('debug')) this.debug.toggle();
    if (inp.consume('mute')) {
      this._unlockAudio();
      const muted = this.guard('audio.mute', () => this.audio.toggleMute());
      this.guard('hud.flash', () => this.hud.flash(muted ? 'SOUND OFF' : 'SOUND ON', { duration: 1, kind: 'info' }));
    }
    if (inp.consume('camera') && this.mode !== 'menu') {
      this.cameraRig.cycle();
      this._applyCameraMode();
    }
    const pause = inp.consume('pause');
    const confirm = inp.consume('confirm');
    const reset = inp.consume('reset');
    switch (this.mode) {
      case 'menu':
        if (confirm) this._startFromMenu();
        break;
      case 'paused':
        // Enter/A is handled by the HUD's pause menu (resume / restart selection).
        if (pause) this._resume();
        break;
      case 'finished':
        if (confirm) {
          if (!this.resultsShown) this._showResults();
          else if (performance.now() - this.resultsShownAt > 1000) this.restart();
        } else if (pause && !this.resultsShown) this._pause();
        break;
      case 'racing':
      case 'countdown':
      case 'intro':
        if (pause) this._pause();
        if (reset && this.mode === 'racing') this._resetCarToTrack(this.player, true);
        break;
    }
  }

  _updateMode(dt) {
    this._startLights();
    switch (this.mode) {
      case 'countdown':
        this._countdownTick();
        break;
      case 'racing':
        if (this.hideCountdownAt >= 0 && this.modeT >= this.hideCountdownAt) {
          this.hideCountdownAt = -1;
          this.guard('hud.hideCountdown', () => this.hud.hideCountdown());
        }
        break;
      case 'finished': {
        this.finishedT += dt;
        if (this.hideCountdownAt >= 0) {
          this.hideCountdownAt = -1;
          this.guard('hud.hideCountdown', () => this.hud.hideCountdown());
        }
        let allDone = true;
        for (let i = 0; i < this.cars.length; i++) if (!this.cars[i].race.finished) allDone = false;
        // Let the finish cinematic breathe for a few seconds even if everybody is already home.
        if (!this.resultsShown && (this.finishedT > RESULTS_TIMEOUT || (allDone && this.finishedT > 6))) this._showResults();
        break;
      }
    }
    // Delayed HUD flashes.
    const q = this.flashQueue;
    for (let i = q.length - 1; i >= 0; i--) {
      q[i].delay -= dt;
      if (q[i].delay <= 0) {
        const f = q[i];
        q.splice(i, 1);
        this.guard('hud.flash', () => this.hud.flash(f.text, f.opts));
      }
    }
  }

  /** Gantry start lights: five reds fill up over the countdown, all green at GO, dark after. */
  _startLights() {
    const tr = this.track;
    if (!tr.setStartLights || this.mode === 'paused') return;
    let n = 0, go = false;
    if (this.mode === 'countdown') n = Math.min(5, Math.floor((this.modeT / CONFIG.race.countdownSeconds) * 5) + 1);
    else if (this.mode === 'racing' && this.modeT < 4) { n = 5; go = true; }
    const key = n * 2 + (go ? 1 : 0);
    if (key === this._lightsKey) return;
    this._lightsKey = key;
    this.guard('track.startLights', () => tr.setStartLights(n, go));
  }

  /** After a camera-mode change: re-seat the chase rig (beam decals are handled per frame). */
  _applyCameraMode() {
    const rig = this.cameraRig;
    if (rig.script === 'chase') rig.snap(this.player);
  }

  /**
   * Each car model paints an additive "headlight beam" decal on the road ahead of it. Seen from
   * inside that footprint (cockpit cams, cinematic shots in front of a car, a rival right behind
   * the chase cam) it covers half the screen and blooms into a white haze, so it is hidden while
   * the camera is above it (the real spot lights / bloom carry the look from there).
   */
  _cullBeamDecals() {
    const cam = this.camera.position;
    const rig = this.cameraRig;
    const cockpit = rig.script === 'chase' && (rig.mode === 'hood' || rig.mode === 'bumper');
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      if (car.beamDecal === undefined) {
        const root = car.model.root;
        car.beamDecal = car.model.beamDecal || root.children.find((o) => o.isMesh && o.material && o.material.blending === THREE.AdditiveBlending) || null;
      }
      const d = car.beamDecal;
      if (!d) continue;
      const h = car.renderHeading;
      const sn = Math.sin(h), cs = Math.cos(h);
      const dx = cam.x - car.renderPos.x, dz = cam.z - car.renderPos.z;
      const lz = dx * sn + dz * cs; // camera along the car's forward axis
      const lx = dx * cs - dz * sn; // ... and across it (car-left positive)
      let hide = cockpit && car.isPlayer;
      if (!hide && cam.y < 7) hide = lz > 1.6 && lz < 32 && Math.abs(lx) < 2 + 0.3 * lz;
      d.visible = !hide;
      // Player spot lights aimed straight into a low camera (menu hero shots, intro sweep) turn
      // the mirror-wet road into a white-out glare: dim them while the lens sits inside the beam.
      const spots = car.isPlayer && car.model.spotLights;
      if (spots && spots.length) {
        if (car.spotBase === undefined) car.spotBase = spots.map((l) => l.intensity);
        const inBeam = cockpit ? 0 : smoothstep(1.4, 3.4, lz) * (1 - smoothstep(0.5, 0.95, Math.abs(lx) / Math.max(lz, 0.1)));
        const occ = this._beamExposure(car, spots);
        // Fast to dim (a car cuts in), slow to recover (no pumping as rivals weave through the beam).
        car.beamOcc = car.beamOcc === undefined ? occ : damp(car.beamOcc, occ, occ < car.beamOcc ? 14 : 3, this.frameDt || 1 / 60);
        // From the hood the two beam pools sit right under the lens and read as two hard white ovals.
        const view = cockpit && rig.mode === 'hood' ? 0.6 : 1;
        const k = (1 - 0.985 * inBeam) * car.beamOcc * view;
        for (let j = 0; j < spots.length; j++) spots[j].intensity = car.spotBase[j] * k;
      }
    }
  }

  /**
   * Headlight "auto exposure" (0..1 scale on the player's spot lights). Inverse-square lamps blow a
   * nearby barrier or a car ahead out to white, and bloom + anamorphic streaks turn that into a
   * full-screen glare. Like a camera exposing for the brightest lit object, cap the illuminance on:
   *  - the brightest barrier point in the beam (cone × low-beam cookie × incidence / d² × paint albedo);
   *  - every car in the beams at a budget inversely proportional to its paint brightness. Car paint is
   *    glossy clear-coat facing straight back at the lamps (and the camera), so it gets a far lower
   *    budget than diffuse concrete: a white livery 5 m ahead reads as lit, not nuked.
   * Each lamp's contribution uses its real cone falloff and 1/d² to the closest point of the car body.
   */
  _beamExposure(car, spots) {
    const B = BEAM;
    // Lamp positions / aim frames in car-local space (cached once; the spots hang off the body pivot).
    if (!car.spotLocal) car.spotLocal = spotLocalFrames(car.model.root, spots);
    const wallE = this._beamWallIlluminance(car, spots); // lx × albedo
    let occ = wallE > B.wallLum ? Math.max(B.wallFloor, B.wallLum / wallE) : 1;
    const n = Math.min(spots.length, car.spotLocal.length);
    const h = car.renderHeading, sn = Math.sin(h), cs = Math.cos(h);
    const P = car.renderPos;
    const profile = typeof carTextures.lowBeamProfile === 'function' ? carTextures.lowBeamProfile : null;
    for (let i = 0; i < this.cars.length; i++) {
      const o = this.cars[i];
      if (o === car || !o.model.root.visible) continue;
      const ox = o.renderPos.x, oz = o.renderPos.z;
      const ddx = ox - P.x, ddz = oz - P.z;
      if (ddx * ddx + ddz * ddz > B.maxDist * B.maxDist) continue;
      const oh = o.renderHeading, osn = Math.sin(oh), ocs = Math.cos(oh);
      let e = 0;
      for (let j = 0; j < n; j++) {
        const f = car.spotLocal[j], sp = spots[j];
        const lx0 = P.x + f.px * cs + f.pz * sn, lz0 = P.z - f.px * sn + f.pz * cs; // lamp (world)
        // Closest point of the other car's footprint (oriented box) to the lamp.
        const rx = lx0 - ox, rz = lz0 - oz;
        const bx = clamp(rx * ocs - rz * osn, -B.halfW, B.halfW); // across the other car
        const bz = clamp(rx * osn + rz * ocs, -B.halfL, B.halfL); // along it
        const wx = ox + bx * ocs + bz * osn - lx0, wz = oz - bx * osn + bz * ocs - lz0;
        // → player-car-local (inverse of the heading rotation), then into the lamp's aim frame.
        const qx = wx * cs - wz * sn, qz = wx * sn + wz * cs;
        const cOut = Math.cos(sp.angle), cIn = Math.cos(sp.angle * (1 - sp.penumbra));
        const cookie = sp.map ? profile : null;
        let best = 0;
        for (let k = 0; k < B.hitY.length; k++) {
          const qy = B.hitY[k] - f.py;
          const d2 = Math.max(qx * qx + qy * qy + qz * qz, 0.36);
          const d = Math.sqrt(d2);
          const fwd = qx * f.dx + qy * f.dy + qz * f.dz;
          const cone = smoothstep(cOut, cIn, fwd / d);
          if (cone <= 0) continue;
          // Light cookie (low-beam pattern: hot zone just under the cut-off, ~5 % stray light above it).
          let m = sp.map ? B.cookieFallback : 1;
          if (cookie && fwd > 0.05) m = cookie((qx * f.rx + qz * f.rz) / fwd, (qx * f.ux + qy * f.uy + qz * f.uz) / fwd);
          const v = (car.spotBase[j] * cone * m) / d2;
          if (v > best) best = v;
        }
        e += best;
      }
      if (e <= 0) continue;
      if (o.paintLum === undefined) o.paintLum = paintLuminance(o.color);
      const budget = B.carLux / Math.max(o.paintLum, B.minLum);
      if (budget < e * occ) occ = budget / e;
    }
    return Math.max(B.floor, Math.min(1, occ));
  }

  /**
   * Illuminance × albedo (lx, lamps at their base intensity) on the brightest barrier point inside the beam, 0 if
   * clear within B.wallRange. Five rays (straight, ±11°, ±26°: the low beam is wide) are marched through track.project to the barrier
   * face; at each hit the low-beam cookie, the spot cone, 1/d² and the angle of incidence on the barrier face
   * are evaluated over the barrier's height (the cookie's hot strip sits just under the lamp height).
   * The old cap assumed an isotropic 900 cd lamp; the cookie puts ~5.7 × 1800 cd into that strip.
   * Albedo: the barrier shader paints red / white blocks within 30 m of every corner with radius ≤ 75 m and leaves
   * the rest bare concrete (track.js), so the white paint gets a tighter budget than the grey walls.
   */
  _beamWallIlluminance(car, spots) {
    const B = BEAM;
    const tr = this.track;
    const h = car.renderHeading;
    const sn = Math.sin(h), cs = Math.cos(h);
    const ox = car.renderPos.x + sn * 2.0, oz = car.renderPos.z + cs * 2.0;
    const W = tr.wallOffset - 0.05;
    const p = this._v3;
    const pr = this._beamProj || (this._beamProj = { s: 0, lateral: 0, distance: 0 });
    const nrm = this._beamNrm || (this._beamNrm = new THREE.Vector3());
    const frames = car.spotLocal;
    const n = Math.min(spots.length, frames.length);
    const profile = typeof carTextures.lowBeamProfile === 'function' ? carTextures.lowBeamProfile : null;
    const P = car.renderPos;
    let maxE = 0;
    for (let r = 0; r < B.wallRays.length; r++) {
      const a = h + B.wallRays[r];
      const dx = Math.sin(a), dz = Math.cos(a);
      let prevT = 0, prevL = 0, hit = -1;
      for (let t = 1; t <= B.wallRange; t += t < 6 ? 1 : 2) {
        p.set(ox + dx * t, 0, oz + dz * t);
        tr.project(p, car.s, pr);
        const lat = Math.abs(pr.lateral);
        if (lat > W) {
          // refine to the barrier face between the last two samples
          hit = t > 1 && lat > prevL ? prevT + (t - prevT) * clamp((W - prevL) / (lat - prevL), 0, 1) : t;
          break;
        }
        prevT = t;
        prevL = lat;
      }
      if (hit < 0) continue;
      const hx = ox + dx * hit, hz = oz + dz * hit;
      tr.getRightAt(pr.s, nrm); // barrier face normal (horizontal; sign irrelevant)
      let e = 0;
      for (let j = 0; j < n; j++) {
        const f = frames[j], sp = spots[j];
        const lx0 = P.x + f.px * cs + f.pz * sn, lz0 = P.z - f.px * sn + f.pz * cs; // lamp (world)
        const wx = hx - lx0, wz = hz - lz0;
        const qx = wx * cs - wz * sn, qz = wx * sn + wz * cs; // → car-local
        const inc = Math.abs(wx * nrm.x + wz * nrm.z);
        const cOut = Math.cos(sp.angle), cIn = Math.cos(sp.angle * (1 - sp.penumbra));
        const cookie = sp.map ? profile : null;
        let best = 0;
        for (let k = 0; k < B.wallH.length; k++) {
          const qy = B.wallH[k] - f.py;
          const d2 = Math.max(qx * qx + qy * qy + qz * qz, 0.25);
          const d = Math.sqrt(d2);
          const fwd = qx * f.dx + qy * f.dy + qz * f.dz;
          const cone = smoothstep(cOut, cIn, fwd / d);
          if (cone <= 0) continue;
          let m = sp.map ? B.cookieFallback : 1;
          if (cookie && fwd > 0.05) m = cookie((qx * f.rx + qz * f.rz) / fwd, (qx * f.ux + qy * f.uy + qz * f.uz) / fwd);
          const v = (car.spotBase[j] * cone * m * (inc / d)) / d2;
          if (v > best) best = v;
        }
        e += best;
      }
      e *= this._barrierPainted(pr.s) ? B.paintAlbedo : B.concAlbedo;
      if (e > maxE) maxE = e;
    }
    return maxE;
  }

  /** True where the barrier has red / white painted blocks (mirrors buildBarrierGeometry in track.js). */
  _barrierPainted(s) {
    const tr = this.track;
    if (!this._paintZones) {
      this._paintZones = (tr.corners || []).filter((k) => k.radius <= 75).map((k) => [k.s0 - 30, k.s1 + 30]);
    }
    const L = tr.length;
    for (let i = 0; i < this._paintZones.length; i++) {
      const z = this._paintZones[i];
      if ((s >= z[0] && s <= z[1]) || (s + L >= z[0] && s + L <= z[1]) || (s - L >= z[0] && s - L <= z[1])) return true;
    }
    return false;
  }

  _queueFlash(text, opts, delay = 0) {
    this.flashQueue.push({ text, opts, delay });
  }

  // Fixed-step physics with accumulator; AI, controls, collisions inside each sub-step.
  _simulate(dt) {
    const maxSteps = Math.ceil(CONFIG.physics.maxSubSteps * Math.max(1, this.timeScale));
    this.acc += dt;
    let steps = 0;
    const live = this.mode === 'racing' || this.mode === 'finished';
    for (const car of this.cars) clearContacts(car.contact);
    while (this.acc >= FIXED_DT && steps < maxSteps) {
      for (let i = 0; i < this.cars.length; i++) this.cars[i].savePrev();
      if (live && this.stepCount % AI_EVERY === 0) {
        this._updateControls(FIXED_DT * AI_EVERY);
        this.guard('slipstream', applySlipstream, this.cars, this.track.length);
      }
      for (let i = 0; i < this.cars.length; i++) {
        const car = this.cars[i];
        const c = live ? car.controls : HELD;
        this.guard('physics.step', stepCar, car, c);
        if (car.ghost > 0) car.ghost -= FIXED_DT;
      }
      this.guard('collide.cars', collideCars, this.cars, FIXED_DT);
      for (let i = 0; i < this.cars.length; i++) this.guard('collide.barrier', collideBarrier, this.track, this.cars[i], FIXED_DT);
      this.acc -= FIXED_DT;
      this.stepCount++;
      steps++;
    }
    if (steps >= maxSteps) this.acc = Math.min(this.acc, FIXED_DT); // drop time instead of spiralling
    this.alpha = clamp(this.acc / FIXED_DT, 0, 1);
    this._preRaceRevs(dt);
    if (live) this._stuckRecovery(dt);
  }

  _refreshAiCars() {
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      const a = this.aiCars[i];
      a.s = c.s;
      a.lateral = c.lateral;
      a.progress = c.race ? c.race.progress : 0;
    }
  }

  _updateControls(aiDt) {
    this._refreshAiCars();
    const playerProgress = this.player.race.progress;
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      if (car.isPlayer) {
        const auto = this.autopilot || this.mode === 'finished';
        if (auto) {
          const ctx = car.autoAI.ctx;
          ctx.raceActive = true;
          ctx.selfProgress = car.race.progress;
          ctx.playerProgress = car.race.progress;
          const c = this.guard('ai.player', aiUpdate, car.autoAI, aiDt, ctx);
          if (c) copyControls(car.controls, c);
        } else if (this._script && this._script.controls) {
          copyControls(car.controls, this._script.controls); // scripted playtest input
        } else {
          copyControls(car.controls, this.input.controls);
        }
      } else {
        const ctx = car.aiCtx;
        ctx.raceActive = true;
        ctx.selfProgress = car.race.progress;
        ctx.playerProgress = playerProgress;
        const c = this.guard('ai', aiUpdate, car.ai, aiDt, ctx);
        if (c) copyControls(car.controls, c);
      }
    }
  }

  // Before GO the physics holds the cars; we simulate free-revving for sound/HUD
  // (throttle raises rpm; AI blip their throttles) and blend to physics rpm after launch.
  _preRaceRevs(dt) {
    const pre = this.mode === 'menu' || this.mode === 'intro' || this.mode === 'countdown';
    const cdLeft = this.mode === 'countdown' ? CONFIG.race.countdownSeconds - this.modeT : 99;
    for (const car of this.cars) {
      const ph = car.physics;
      const idle = ph.idleRpm || 900;
      const max = ph.maxRpm || 8000;
      const rev = car.rev;
      if (pre) {
        let thr = 0;
        if (car.isPlayer && !this.autopilot) {
          const sc = this._script && this._script.controls;
          thr = this.mode === 'countdown' ? (sc ? sc.throttle || 0 : this.input.raw.throttle) : 0;
        } else if (this.mode === 'countdown') {
          if (cdLeft < 0.9) thr = car.isPlayer ? 0.6 : 0.55 + 0.1 * Math.sin(car.index * 3.1);
          else {
            rev.blipTimer -= dt;
            if (rev.blipTimer <= 0) {
              rev.blipTimer = 0.7 + Math.random() * 1.3;
              rev.blipHold = 0.12 + Math.random() * 0.25;
              rev.blipAmount = 0.45 + Math.random() * 0.5;
            }
            if (rev.blipHold > 0) { rev.blipHold -= dt; thr = rev.blipAmount; }
          }
        }
        rev.throttle = approach(rev.throttle, thr, 10, dt);
        const target = idle + rev.throttle * (max - idle) * 1.02;
        rev.rpm = approach(rev.rpm, target, target > rev.rpm ? 9000 * (0.3 + rev.throttle) : 5500, dt);
        if (rev.rpm > max * 0.985) rev.rpm = max * 0.93; // limiter bounce
        car.displayRpm = rev.rpm;
      } else {
        car.launchBlend = Math.min(1, car.launchBlend + dt / 0.6);
        car.displayRpm = lerp(rev.rpm, ph.rpm || idle, smoothstep(0, 1, car.launchBlend));
        rev.throttle = ph.throttle || 0;
      }
    }
  }

  _stuckRecovery(dt) {
    for (const car of this.cars) {
      if (car.isPlayer && !this.autopilot && this.mode !== 'finished') continue;
      const ph = car.physics;
      const slow = (ph.speedKmh || 0) < 7;
      if (slow || car.race.wrongWay) car.stuckTimer += dt;
      else car.stuckTimer = Math.max(0, car.stuckTimer - dt * 2);
      // Last resort only — the AI has its own reverse-out recovery that gets the first ~5 s.
      if (car.stuckTimer > 7) this._resetCarToTrack(car, false);
    }
  }

  /** Put a car back on the road at its current s, facing forward, briefly ghosted. */
  _resetCarToTrack(car, byPlayer) {
    if (byPlayer) {
      if (this.resetCooldown > 0) return;
      this.resetCooldown = 1.0;
    }
    const tr = this.track;
    // Centerline by default; if a rival occupies that spot, drop into the free lane beside it.
    let lat = 0;
    for (const o of this.cars) {
      if (o === car) continue;
      let ds = Math.abs(o.s - car.s);
      if (ds > tr.length / 2) ds = tr.length - ds;
      if (ds < 9 && Math.abs(o.lateral - lat) < 3) lat = o.lateral > 0 ? -4.5 : 4.5;
    }
    const p = tr.getPointAt(car.s, this._v1);
    const r = tr.getRightAt(car.s, this._v2);
    p.addScaledVector(r, lat);
    const t = tr.getTangentAt(car.s, this._v3);
    this.effects.endSkids(car);
    car.place(p, Math.atan2(t.x, t.z));
    car.lateral = lat;
    car.ghost = 2.0;
    car.blinkTimer = 2.0;
    car.stuckTimer = 0;
    this.race.resync(car);
    if (car.isPlayer) {
      this.cameraRig.snap(car);
      this.input.resetControls();
    }
  }

  _syncVisuals(alpha) {
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      car.interpolate(alpha);
      car.syncModel();
      if (car.blinkTimer > 0) {
        car.blinkTimer -= this.frameDt;
        car.model.root.visible = car.blinkTimer <= 0 || Math.floor(car.blinkTimer * 12) % 2 === 0;
      }
      this.guard('carModel.setState', setCarState, car, this.mode, this.frameDt);
    }
  }

  // Bound once (no per-frame closures).
  _raceUpdate = (dt) => {
    if (dt <= 0) return;
    this.race.update(dt);
    this.resetCooldown -= dt;
    const p = this.player;
    if (this.mode !== 'racing') return;
    // Wrong way warning.
    this.wrongWayFlashT -= dt;
    if (p.race.wrongWay && this.wrongWayFlashT <= 0) {
      this.wrongWayFlashT = 1.6;
      this.guard('hud.flash', () => this.hud.flash('WRONG WAY', { duration: 1.3, kind: 'warn' }));
    }
    // Drift scoring: drift > 0.4 sustained > 1 s accumulates; flash on exit.
    const d = this.drift;
    const ph = p.physics;
    const drifting = (ph.drift || 0) > 0.4 && (ph.speedKmh || 0) > 35 && !p.race.wrongWay;
    if (drifting) {
      d.grace = 0;
      d.time += dt;
      if (d.time > 1) {
        d.active = true;
        d.score += (ph.drift || 0) * (ph.speedKmh || 0) * dt * 2.2 * d.multiplier;
      }
    } else if (d.time > 0) {
      d.grace += dt;
      if (d.grace > 0.35 || p.contact.wallImpact > 3) {
        // Ending the chain: the HUD pops the banked score when `active` drops.
        if (d.active) d.total += Math.round(d.score);
        d.time = d.grace = d.score = 0;
        d.active = false;
      }
    }
    d.multiplier = 1 + Math.min(4, Math.floor(Math.max(0, d.time - 1) / 2));
  };

  _cameraUpdate = (dt) => {
    this.cameraRig.update(dt, this.player);
  };

  _effectsUpdate = (dt) => {
    if (dt <= 0) return;
    const live = this.mode === 'racing' || this.mode === 'finished';
    this.effects.update(dt, this.cars, this.camera.position, live);
    // Player impact feedback: post-fx flash + camera shake scaled by impact speed.
    // A car pressed into a barrier reports a small "impact" every sub-step: only a fresh hit (after a
    // short quiet period, or a clearly harder one) flashes / shakes, otherwise scraping strobes the frame.
    const c = this.player.contact;
    const hit = Math.max(c.wallImpact, c.carImpact);
    this.impactCd -= dt;
    if (hit > 2.5 && (this.impactCd <= 0 || hit > this.lastImpact * 1.6)) {
      this.impactFlash = Math.max(this.impactFlash, clamp(hit / 22, 0.12, 0.85));
      this.cameraRig.addTrauma(clamp(hit / 22, 0.1, 0.8));
      this.lastImpact = hit;
    }
    if (hit > 1) this.impactCd = 0.45;
    else if (this.impactCd <= 0) this.lastImpact = 0;
    if (c.wallTouching && c.wallScrape > 5) this.cameraRig.addTrauma(dt * 0.6);
    this.impactFlash = Math.max(0, this.impactFlash - dt * 3.5);
  };

  _particlesUpdate = (dt) => {
    this.particles.update(dt, this.camera);
  };

  _rainUpdate = (dt) => {
    // Rain drops inside the player's headlight beams catch the light. The beam origin sits at the
    // headlights (pushed ahead in the bumper/hood views so drops right at the lens don't white out).
    if (this.rain.setHeadlights) {
      const p = this.player;
      const h = p.renderHeading;
      const mode = this.cameraRig.script === 'chase' ? this.cameraRig.mode : 'chase';
      const ahead = mode === 'bumper' ? 5.5 : mode === 'hood' ? 4.0 : 2.1;
      this._headDir.set(Math.sin(h), 0, Math.cos(h));
      this._headPos.copy(p.renderPos).addScaledVector(this._headDir, ahead);
      this._headPos.y = 0.65;
      // Looking INTO the beams (cinematic shots in front of the car) the lit drops right at the
      // lens would white out the frame → only light the rain when the camera is behind the lamps.
      const c = this.camera.position;
      const front = (c.x - this._headPos.x) * this._headDir.x + (c.z - this._headPos.z) * this._headDir.z > -1.5;
      this.rain.setHeadlights(this._headPos, this._headDir, !front);
    }
    this.rain.update(dt, this.camera, this.cameraRig.velocity);
  };

  _worldUpdate = (dt) => {
    const ctx = this._worldCtx || (this._worldCtx = { time: 0, camera: this.camera, focus: this.player.renderPos });
    ctx.time = this.time;
    if (this.track.update) this.track.update(dt, ctx);
    if (this.env && this.env.update) this.env.update(dt, ctx);
  };

  _audioUpdate = (dt) => {
    if (!this.audioReady) return;
    const live = this.mode === 'racing' || this.mode === 'finished' || (this.mode === 'paused' && (this.prevMode === 'racing' || this.prevMode === 'finished'));
    this.audioDirector.update(dt, { player: this.player, cars: this.cars, camera: this.camera, mode: this.mode, raceLive: live });
  };

  _buildHudState() {
    this.hudState = {
      speedKmh: 0, rpm: 0, maxRpm: 8000, gear: 1, nitro: 1, nitroActive: false,
      lap: 1, totalLaps: this.totalLaps, position: 1, totalRacers: this.cars.length,
      lapTime: 0, totalTime: 0, bestLap: null, lastLap: null,
      cars: this.cars.map((c) => ({ x: 0, z: 0, heading: 0, isPlayer: c.isPlayer, color: hexColor(c.color), name: c.name, position: 1 })),
      drift: this.drift, driftTotal: 0, wrongWay: false, mode: 'menu',
      throttle: 0, brake: 0, steer: 0, gapAhead: null,
      launch: { active: false, perfect: LAUNCH.perfect, good: LAUNCH.good },
    };
  }

  _hudUpdate = () => {
    const s = this.hudState;
    const p = this.player;
    const ph = p.physics;
    const r = p.race;
    const pre = this.mode === 'menu' || this.mode === 'intro' || this.mode === 'countdown';
    s.speedKmh = ph.speedKmh || 0;
    s.rpm = p.displayRpm;
    s.maxRpm = ph.maxRpm || 8000;
    s.gear = pre ? 0 : ph.gear;
    s.nitro = ph.nitro ?? 0;
    s.nitroActive = !!ph.nitroActive;
    s.lap = Math.min(r.lapsDone + 1, this.totalLaps);
    s.totalLaps = this.totalLaps;
    s.position = r.position;
    s.totalRacers = this.cars.length;
    s.lapTime = r.finished ? r.lastLap : r.lapTime;
    s.totalTime = r.finished ? r.finishTime : this.race.time;
    s.bestLap = r.bestLap;
    s.lastLap = r.lastLap;
    s.drift = this.drift;
    s.driftTotal = this.drift.total;
    s.wrongWay = r.wrongWay && this.mode === 'racing';
    s.mode = this.mode;
    s.throttle = ph.throttle || 0;
    s.brake = ph.brake || 0;
    s.steer = p.controls.steer;
    s.launch.active = this.mode === 'countdown' && !this.autopilot;
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      const o = s.cars[i];
      o.x = c.renderPos.x;
      o.z = c.renderPos.z;
      o.heading = c.renderHeading;
      o.position = c.race.position;
    }
    this.hud.update(s);
  };

  _render = (realDt) => {
    const p = this.player.physics;
    const kmh = p.speedKmh || 0;
    this.nitroFx = damp(this.nitroFx, p.nitroActive ? 1 : 0, p.nitroActive ? 6 : 2.5, realDt);
    const cinematic = this.mode === 'menu' || this.mode === 'intro';
    if (this.postfx) {
      const fx = this._fx || (this._fx = { speed: 0, nitro: 0, impact: 0, shake: 0 });
      fx.speed = cinematic ? 0 : clamp(kmh / 320, 0, 1);
      fx.nitro = this.nitroFx;
      fx.impact = this.impactFlash;
      fx.shake = clamp(this.cameraRig.trauma * this.cameraRig.trauma + smoothstep(240, 330, kmh) * 0.25, 0, 1);
      const rig = this.cameraRig;
      const view = rig.script === 'chase' ? rig.mode : '';
      const fk = view === 'hood' ? 1 : view === 'bumper' ? 2 : 0;
      if (fk !== this._blurFocus) {
        this._blurFocus = fk;
        this.postfx.set(BLUR_FOCUS[fk]);
      }
      this.postfx.set(fx);
      this.postfx.render(realDt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  };

  _postFrame(realDt) {
    if (this.firstFrame) {
      this.firstFrame = false;
      if (this.veil) {
        this.veil.classList.add('veil-out');
        setTimeout(() => this.veil && this.veil.remove(), 900);
      }
    }
    const p = this.player;
    this.debug.update(realDt, {
      renderer: this.renderer, pixelRatio: this.pixelRatio, width: innerWidth, height: innerHeight,
      camMode: this.cameraRig.script === 'chase' ? this.cameraRig.mode : this.cameraRig.script,
      state: this.mode, speed: p.physics.speedKmh || 0, s: p.s, lateral: p.lateral, prof: this.prof,
    });
    this._dynamicResolution(realDt);
  }

  // Adaptive resolution: if the frame rate sags below ~52 fps for 2 s, drop the pixel ratio
  // one notch (never below 1.0 on high / 0.75 on low). Off with ?drs=0.
  _dynamicResolution(realDt) {
    const d = this.drs;
    if (!d.enabled || this.mode === 'paused' || this.mode === 'loading') return;
    d.cooldown -= realDt;
    if (d.cooldown > 0) return;
    d.acc += realDt;
    d.frames++;
    if (d.acc < 2) return;
    const avg = d.acc / d.frames;
    d.acc = 0;
    d.frames = 0;
    const floor = this.quality === 'high' ? 1.0 : 0.75;
    if (avg > 1 / 52 && this.pixelRatio > floor + 1e-3) {
      this.pixelRatio = Math.max(floor, this.pixelRatio - 0.125);
      this._resize();
      d.cooldown = 3;
    }
  }

  // ---------------------------------------------------------------- debug/test API
  _exposeDebugApi() {
    const game = this;
    window.__game = {
      get state() { return game.mode; },
      startRace: () => game.startRace(),
      setAutopilot: (v) => { game.autopilot = !!v; },
      setTimeScale: (x) => { game.timeScale = Math.max(0.05, Number(x) || 1); },
      getTelemetry: () => game.getTelemetry(),
      // Extras for testing/integration.
      restart: () => game.restart(),
      pause: () => game._pause(),
      resume: () => game._resume(),
      showResults: () => game._showResults(),
      setCamera: (mode) => { game.cameraRig.setMode(mode); game._applyCameraMode(); },
      /** Place the player at arc length s / lateral offset, facing the race direction (optional speed m/s). */
      teleport: (s, lateral = 0, speed = 0) => {
        const p = game.player, tr = game.track;
        s = ((s % tr.length) + tr.length) % tr.length;
        const pos = tr.getPointAt(s).addScaledVector(tr.getRightAt(s), lateral);
        const t = tr.getTangentAt(s);
        const h = Math.atan2(t.x, t.z);
        game.effects.endSkids(p);
        p.place(pos, h);
        p.s = s;
        p.lateral = lateral;
        game.race.resync(p);
        if (speed) {
          p.physics.velocity.set(Math.sin(h), 0, Math.cos(h)).multiplyScalar(speed);
          if (p.physics.syncGear) p.physics.syncGear();
        }
        game.cameraRig.snap(p);
        return s;
      },
      // Scripted playtest on GAME time (robust when the machine is slow): steps are
      // { t, controls?: {throttle,brake,steer,handbrake,nitro} | null, action?: 'camera'|'reset'|..., eval?: 'js', shot?: 'name' }.
      // Shots are captured from the canvas right after rendering (3D only, no DOM HUD) → __game.scriptShots.
      runScript: (steps) => game._runScript(steps),
      get scriptDone() { return !game._script || game._script.i >= game._script.steps.length; },
      get scriptShots() { return game._scriptShots || {}; },
      get game() { return game; },
      get renderer() { return game.renderer; },
      get scene() { return game.scene; },
      get camera() { return game.camera; },
      beamTune: BEAM, // live-tunable headlight exposure caps
    };
  }

  _runScript(steps) {
    this._script = { steps: [...steps].sort((a, b) => a.t - b.t), i: 0, t0: this.time, controls: null, pendingShot: null };
    this._scriptShots = {};
    return this._script.steps.length;
  }

  _scriptTick() {
    const sc = this._script;
    const t = this.time - sc.t0;
    while (sc.i < sc.steps.length && sc.steps[sc.i].t <= t && !sc.pendingShot) {
      const st = sc.steps[sc.i++];
      if ('controls' in st) sc.controls = st.controls ? { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false, ...st.controls } : null;
      if (st.action) this.input.actions[st.action] = true;
      if (st.eval) this.guard('script.eval', () => (0, eval)(st.eval));
      if (st.shot) sc.pendingShot = st.shot;
    }
  }

  _scriptCapture() {
    const sc = this._script;
    try {
      this._scriptShots[sc.pendingShot] = this.renderer.domElement.toDataURL('image/jpeg', 0.85);
    } catch (e) {
      console.warn('[core] script shot failed', e);
    }
    sc.pendingShot = null;
  }

  getTelemetry() {
    const p = this.player;
    const ph = p.physics;
    const info = this.renderer.info.render;
    return {
      state: this.mode,
      speedKmh: +(ph.speedKmh || 0).toFixed(1),
      rpm: Math.round(p.displayRpm),
      gear: ph.gear,
      lap: Math.min(p.race.lapsDone + 1, this.totalLaps),
      lapsDone: p.race.lapsDone,
      position: p.race.position,
      s: +p.s.toFixed(1),
      lateral: +p.lateral.toFixed(2),
      progress: +p.race.progress.toFixed(1),
      fps: +this.fps.toFixed(1),
      raceTime: +this.race.time.toFixed(2),
      bestLap: p.race.bestLap,
      nitro: +(ph.nitro ?? 0).toFixed(2),
      drift: +(ph.drift || 0).toFixed(2),
      camera: this.cameraRig.script === 'chase' ? this.cameraRig.mode : this.cameraRig.script,
      autopilot: this.autopilot,
      drawCalls: info.calls,
      triangles: info.triangles,
      pixelRatio: this.pixelRatio,
      cpuMs: Object.fromEntries(Object.entries(this.prof).map(([k, v]) => [k, +v.toFixed(2)])),
      errors: Object.fromEntries(this.guard.failures),
      cars: this.cars.map((c) => ({
        name: c.name,
        isPlayer: c.isPlayer,
        position: c.race.position,
        lap: Math.min(c.race.lapsDone + 1, this.totalLaps),
        lapsDone: c.race.lapsDone,
        s: +c.s.toFixed(1),
        lateral: +c.lateral.toFixed(2),
        progress: +c.race.progress.toFixed(1),
        speedKmh: +(c.physics.speedKmh || 0).toFixed(1),
        finished: c.race.finished,
        finishTime: c.race.finishTime,
        bestLap: c.race.bestLap,
      })),
    };
  }

  _headPos = new THREE.Vector3();
  _headDir = new THREE.Vector3();
  _v1 = new THREE.Vector3();
  _v2 = new THREE.Vector3();
  _v3 = new THREE.Vector3();
}

// ---------------------------------------------------------------- helpers (module scope, no closures)
function rethrow(e) {
  throw e;
}

// Exponentially smoothed CPU time per frame section (ms), for the debug overlay.
function mark(prof, key, t0) {
  const t = performance.now();
  prof[key] += (t - t0 - prof[key]) * 0.1;
  return t;
}

function stepCar(car, controls) {
  car.physics.step(FIXED_DT, controls);
}

function aiUpdate(ai, dt, ctx) {
  return ai.update(dt, ctx);
}

function copyControls(dst, src) {
  dst.throttle = src.throttle || 0;
  dst.brake = src.brake || 0;
  dst.steer = src.steer || 0;
  dst.handbrake = !!src.handbrake;
  dst.nitro = !!src.nitro;
}

function setCarState(car, mode, dt) {
  const ph = car.physics;
  const st = car.state;
  const pre = mode === 'menu' || mode === 'intro' || mode === 'countdown';
  st.steerAngle = ph.steerAngle || 0;
  st.wheelSpinFront = ph.wheelSpinFront || 0;
  st.wheelSpinRear = ph.wheelSpinRear || 0;
  st.pitch = ph.pitch || 0;
  st.roll = ph.roll || 0;
  const reversing = ph.gear === -1 && (ph.speed || 0) < 0.5;
  st.reversing = reversing;
  // Brake lights: braking while rolling forward, or held on the grid.
  st.brake = pre ? 0.85 : reversing ? 0 : clamp(ph.brake || 0, 0, 1);
  car.nitroVis = damp(car.nitroVis, ph.nitroActive ? 1 : 0, 10, dt);
  st.nitro = car.nitroVis;
  st.headlights = true;
  car.model.setState(st);
  if (car.model.update) car.model.update(dt);
}

/** Linear luminance of an sRGB hex paint colour (0..1). */
function paintLuminance(hex) {
  const c = new THREE.Color(hex); // three converts sRGB hex → linear working space
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** Spot light positions + aim directions in the car root's local frame (body at rest). */
function spotLocalFrames(root, spots) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const p = new THREE.Vector3(), t = new THREE.Vector3();
  return spots.map((L) => {
    L.getWorldPosition(p).applyMatrix4(inv);
    (L.target ? L.target.getWorldPosition(t) : t.set(0, 0, 1e3)).applyMatrix4(inv);
    t.sub(p).normalize();
    // Lamp frame for the light cookie: right = aim × up (= the car's right, −X, for a level aim), up' = right × aim.
    const r = new THREE.Vector3(-t.z, 0, t.x).normalize();
    const u = new THREE.Vector3().crossVectors(r, t);
    return { px: p.x, py: p.y, pz: p.z, dx: t.x, dy: t.y, dz: t.z, rx: r.x, rz: r.z, ux: u.x, uy: u.y, uz: u.z };
  });
}

function fallbackModel(color) {
  const c = CONFIG.car;
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(c.width, c.height * 0.6, c.length), new THREE.MeshStandardMaterial({ color }));
  body.position.y = c.height * 0.45;
  root.add(body);
  return {
    root, dimensions: { length: c.length, width: c.width, height: c.height },
    wheelLocal: {
      fl: new THREE.Vector3(c.trackWidth / 2, 0, c.frontAxleZ), fr: new THREE.Vector3(-c.trackWidth / 2, 0, c.frontAxleZ),
      rl: new THREE.Vector3(c.trackWidth / 2, 0, c.rearAxleZ), rr: new THREE.Vector3(-c.trackWidth / 2, 0, c.rearAxleZ),
    },
    exhaustLocal: [], tailLightLocal: [], setState() {}, update() {},
  };
}
