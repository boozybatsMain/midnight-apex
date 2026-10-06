# MIDNIGHT APEX — Module Contracts

A hyper-realistic, NFS-inspired night street-racing demo: one polished, fully playable scene.
**Setting:** a rain-soaked neon downtown at night (think NFS Underground / Heat). Wet asphalt mirroring
neon signs and streetlights, rain, tire spray, bloom, motion/speed blur, a roaring procedurally-synthesized
engine, 4 AI rivals, 3 laps around a closed city circuit, NFS-style HUD with tachometer, nitrous, minimap.

Stack: **three.js r186 (WebGLRenderer) + Vite**, plain ES modules (JavaScript, no TypeScript), **no external
asset files** — every mesh, texture, and sound is generated procedurally in code (canvas textures,
BufferGeometry, WebAudio synthesis). Import three as `import * as THREE from 'three'` and addons from
`'three/addons/...'` (e.g. `three/addons/postprocessing/EffectComposer.js`).

## Global conventions (everyone must follow)

- Units: meters, seconds, radians, kg. **Y-up**. The world is **flat**: the road surface is at y = 0.
- **Heading**: rotation about +Y; `object.rotation.y = heading`. Heading 0 faces **+Z**.
  `forward = (sin h, 0, cos h)`, `right = cross(forward, UP) = (-cos h, 0, sin h)`.
  Helpers live in `src/config.js` (`headingForward`, `headingRight`, `headingFromDir`, `clamp`, `lerp`, `damp`, `wrapAngle`).
- **Car local space**: origin on the ground, centered laterally and halfway between the axles.
  **+Z forward, +Y up, +X = car's LEFT**, −X = car's right. Shared dimensions in `CONFIG.car`.
- **Steering input**: `steer ∈ [-1, 1]`, **+1 = turn right**. Turning right while moving forward makes heading **decrease**.
- Track lateral offset: **positive = right of the centerline** (along `track.getRightAt(s)` = cross(tangent, UP)).
- Track curvature sign: **positive = the road bends to the right**.
- Colour: renderer uses `outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`. Post-processing
  ends with `OutputPass` (which applies tone mapping + sRGB). Canvas-generated colour textures must set
  `texture.colorSpace = THREE.SRGBColorSpace`; data textures (normal/roughness) must not.
- Emissive surfaces should be HDR-bright (emissiveIntensity 2–20) so `UnrealBloomPass` makes them glow.
- Performance target: **60 fps at 1080p on an Apple M2-class laptop** with quality `'high'`.
  Avoid many real-time lights (forward renderer). Prefer emissive meshes, InstancedMesh, merged geometry,
  baked/fake light pools in shaders, shared materials. Only the player car has real SpotLights.
- `quality` is `'high'` or `'low'` (low = fewer particles, no planar reflection, smaller shadow maps, lower pixel ratio).
- Every module must be **importable without side effects** (no work at import time besides constants) and must
  not throw if optional params are missing. Each `create*`/constructor returns its object synchronously.
- `dispose()` methods are nice-to-have, not required.
- Code style: modern JS, small focused functions, brief comments explaining non-obvious math/visual tricks.

## File ownership (one owner per file — never edit files you don't own)

| Owner (agent)  | Files |
|----------------|-------|
| world          | `src/world/track.js`, `src/world/environment.js`, any `src/world/*.js`, `dev/world.html` |
| car            | `src/vehicle/carModel.js`, any `src/vehicle/car*.js`, `dev/car.html` |
| dynamics       | `src/vehicle/physics.js`, `src/vehicle/ai.js`, `dev/physics.html` |
| fx             | `src/fx/postfx.js`, `src/fx/particles.js`, `src/fx/rain.js`, any `src/fx/*.js`, `dev/fx.html` |
| audio          | `src/audio/audio.js`, any `src/audio/*.js`, `dev/audio.html` |
| hud            | `src/ui/hud.js`, `src/ui/hud.css`, any `src/ui/*`, `dev/hud.html` |
| core           | `index.html`, `src/main.js`, `src/style.css`, `src/core/*.js` |
| integrator     | `src/config.js`, `CONTRACTS.md`, `README.md`, and (later phases) anything |

Each module starts as a stub that already satisfies its contract. Replace it with the real implementation, keeping
the exported names and signatures **exactly** as below. You may ADD optional params/fields/methods; never remove or rename.

---

## 1. Track — `src/world/track.js` (owner: world)

```js
export function createTrackPath() => TrackPath   // pure math, NO meshes/DOM — must work in Node (used by AI tests)
export function createTrack({ renderer, quality } = {}) => Track   // TrackPath + meshes
```
`TrackPath` has every query member below (`length, halfWidth, wallOffset, startS, lampSpacing, getPointAt,
getTangentAt, getRightAt, getCurvatureAt, project, getStartGrid, getMinimapPolyline`); `Track` adds `group` and `update`.
A **closed** city circuit, centerline is a smooth closed curve on y = 0, total length **2.4–3.2 km**.
Layout must include: a long start/finish straight (≥ 450 m, lets cars reach 280+ km/h), a fast sweeper, a sequence of
~90° city-block corners (radius 30–45 m), a chicane, and one hairpin (radius ≥ 22 m). Minimum radius anywhere ≥ 22 m.
`Track` fields/methods (all `s` are arc-length meters, wrapped modulo `length`; all returned vectors are new unless `out` passed):

| member | meaning |
|---|---|
| `group: THREE.Group` | road surface, lane markings, curbs/sidewalks, barriers, start/finish gantry. Added to scene by core. |
| `length: number` | centerline length (m) |
| `halfWidth: number` | drivable half width = `CONFIG.track.roadWidth / 2` |
| `wallOffset: number` | lateral distance from centerline to the barrier face (= halfWidth + CONFIG.track.wallMargin). Cars must stay within ±wallOffset. |
| `startS: number` | arc length of the start/finish line |
| `getPointAt(s, out?) → Vector3` | centerline point (y = 0) |
| `getTangentAt(s, out?) → Vector3` | unit horizontal tangent (direction of travel) |
| `getRightAt(s, out?) → Vector3` | unit = cross(tangent, UP) |
| `getCurvatureAt(s) → number` | signed curvature 1/m, + = bends right |
| `project(pos, hintS?) → { s, lateral, distance }` | closest centerline point to `pos` (x,z). `lateral` signed (+ right). If `hintS` given, search locally around it (fast path used every frame per car); must still be robust. Must be fast (< 0.02 ms) — use precomputed samples (e.g. every 1 m) + local search. |
| `getStartGrid(slot) → { position: Vector3, heading }` | staggered 2-wide grid behind the start line; slot 0 = pole. Slots 0..7 valid. Cars face the direction of travel. |
| `getMinimapPolyline(n = 256) → Array<[x, z]>` | evenly spaced centerline points for the HUD minimap |
| `lampSpacing: number` | spacing of streetlights along the track (environment & road shader agree on it) |
| `update(dt, { time, camera }) ` | optional per-frame animation (may be a no-op) |

## 2. Environment — `src/world/environment.js` (owner: world)

```js
export function createEnvironment({ scene, renderer, track, quality } = {}) => Environment
```
Builds the night city around the track and **sets up global scene lighting**: `scene.background`, `scene.fog`
(FogExp2, dark blue-purple), moonlight `DirectionalLight` with shadows, hemisphere/ambient fill, PMREM environment map.
Contents: dense downtown buildings with procedurally-lit window textures (InstancedMesh / merged), neon signs and
billboards (emissive, bloom), streetlights every `track.lampSpacing` m with fake light pools on the road, traffic
lights, overpass/bridge over a straight, skyline far away, wet road look (see road notes below).

| member | meaning |
|---|---|
| `group: THREE.Group` | everything environmental (already added to `scene` by createEnvironment) |
| `envMap: THREE.Texture \| null` | PMREM night-city environment for reflections. Core sets `scene.environment = envMap`. |
| `moonLight: THREE.DirectionalLight` | the shadow caster (already in scene) |
| `update(dt, { time, camera, focus })` | per-frame. `focus` = player position Vector3: move the shadow camera to follow it. May do offscreen renders (e.g. planar wet-road reflection) — it is called **before** the main render each frame. |

**Wet road** (the signature look): road material must read as soaked asphalt — dark, glossy, puddles with sharp
reflections, neon/streetlight reflections streaking toward the camera. Recommended approach on `'high'`: a half-res
planar reflection (mirror camera about y = 0 rendered to a render target in `update()`), sampled in the road shader
(via `onBeforeCompile` on a MeshStandardMaterial / MeshPhysicalMaterial) with screen-space UVs, distorted by a
procedural normal map and modulated by a puddle mask + vertical streak blur. `'low'`: rely on envMap + low roughness.
Streetlight pools: since lamps are evenly spaced along `s`, compute light pools analytically in the road shader from
the road's UVs (u = lateral, v = arc length) instead of using real lights.

## 3. Car model — `src/vehicle/carModel.js` (owner: car)

```js
export function createCarModel({ color, accent, name, isPlayer = false, quality, envMap } = {}) => CarModel
```
A **sleek, believable modern sports/super car** (Porsche/Lambo/Nissan GT-R class silhouette — original design, no
brands), built procedurally: lofted smooth body (cross-sections swept along length, not boxes), separate greenhouse
with tinted glass, wheel arches, splitter, side skirts, rear diffuser, spoiler/wing, mirrors, LED headlight
strips + projector lenses, full-width LED tail light bar, quad exhausts, detailed multi-spoke rims with brake discs
and calipers, tire sidewalls, under-car contact shadow. Paint = `MeshPhysicalMaterial` with clearcoat (metallic
flake look), uses `envMap` if given (otherwise scene.environment).

| member | meaning |
|---|---|
| `root: THREE.Group` | add to scene; core sets `root.position` (x, 0, z) and `root.rotation.y = heading` |
| `dimensions: { length, width, height }` | ≈ CONFIG.car |
| `wheelLocal: { fl, fr, rl, rr }: Vector3` | wheel contact-patch positions in car local space (y = 0). fl = front-left (+X side). |
| `exhaustLocal: Vector3[]` | exhaust tip positions in local space (for flames/smoke) |
| `tailLightLocal: Vector3[]` | tail light positions (local) |
| `setState({ steerAngle, wheelSpinFront, wheelSpinRear, pitch, roll, brake, reversing, nitro, headlights })` | called every frame. `steerAngle` rad (front wheels yaw; + = steer right, so wheels rotate toward −X... i.e. **negative** rotation.y); `wheelSpin*` = accumulated wheel rotation (rad) about the axle; `pitch` (+ = nose dips) / `roll` (+ = body leans to the car's right) rad for the visual body suspension (wheels stay planted); `brake` 0..1 brightens brake lights; `reversing` white reverse lights; `nitro` 0..1 exhaust glow / blue flame cone; `headlights` bool. All optional. |
| `update(dt)` | optional animation |

Player car (`isPlayer: true`) gets two real `SpotLight` headlights (no shadow) aimed down the road. All cars also get
an additive "light cone on the road" decal in front so AI headlights are visible without real lights.

## 4. Vehicle dynamics — `src/vehicle/physics.js` (owner: dynamics)

```js
export class VehiclePhysics {
  constructor(spec = {})                   // optional overrides of internal tuning (mass, power, grip, ...)
  reset(position, heading)                 // place at rest
  step(dt, controls)                       // advance one fixed step (dt = CONFIG.physics.fixedDt)
  addNitro(amount)                         // amount 0..1 of a full tank
  applyImpulse(impulse, point)             // world-space Vector3 impulse (N·s) at world point (affects linear + yaw)
}
```
`controls = { throttle: 0..1, brake: 0..1, steer: -1..1 (+1 right), handbrake: bool, nitro: bool }`.
Brake while stopped/slow engages reverse (NFS-style).

Readable state (public fields, updated by `step`):
`position: Vector3` (y = 0), `heading`, `velocity: Vector3` (world, m/s), `yawRate` (rad/s, + = heading increasing),
`speed` (signed forward speed m/s), `speedKmh` (abs km/h), `rpm`, `maxRpm`, `idleRpm`, `gear` (−1 reverse, 1..6),
`throttle`, `brake` (applied 0..1, after smoothing), `steerAngle` (front-wheel angle rad, + = right),
`slipAngle` (rad, body slip), `drift` (0..1 drift intensity), `skid: { fl, fr, rl, rr }` (0..1 tire slip/screech),
`wheelSpinFront`, `wheelSpinRear` (accumulated rad), `nitro` (0..1 tank), `nitroActive` (bool),
`shiftCount` (increments on every gear change), `lastShiftUp` (bool), `pitch`, `roll` (visual, rad, smoothed weight transfer),
`halfLength`, `halfWidth`, `mass`.

Handling target: **NFS-style arcade-sim**. 0–100 km/h ≈ 3.4 s, top speed ≈ 305 km/h (≈ 335 with nitro), 6-speed
automatic with realistic rpm drops on upshift, rev limiter bounce, speed-sensitive steering, strong grip that lets you
take 90° corners at ~90–110 km/h, controllable power-oversteer and **handbrake/brake-tap drifts** that are fun and
recoverable (counter-steer assist), drifting refills nitro. Nitro: ≈ 5 s full tank, strong push + higher top speed.
Integrate with a single-track (bicycle) model with Pacejka-ish tire curves; must be numerically stable at dt = 1/120
for all speeds incl. 0 and reverse; no jitter at rest.

## 5. AI drivers — `src/vehicle/ai.js` (owner: dynamics)

```js
export class AIDriver {
  constructor({ track, physics, skill = 0.8, aggression = 0.5, laneBias = 0, seed = 1 })
  update(dt, ctx) => controls      // same controls shape as above
}
```
`ctx = { raceActive: bool, selfProgress: number, playerProgress: number, cars: [{ physics, s, lateral, progress }] }`
(progress = laps*length + s, monotonic). Computes (and caches per track) a smoothed **racing line** (outside-inside-
outside), plans speed from curvature look-ahead (`v = sqrt(μ g / |κ|)` with braking distance), steers with pure-pursuit
on the racing line, overtakes/avoids nearby cars by shifting lateral target, uses nitro on straights, mild
rubber-banding vs player (`playerProgress`), small skill-based imperfections. When `raceActive` is false, hold brake.
Must keep cars inside `±(track.wallOffset − 1.2)`. Also used as **autopilot** for the player car (`?autopilot=1`), so it
must complete laps reliably on its own (target lap ≈ 55–75 s).

## 6. Post-processing — `src/fx/postfx.js` (owner: fx)

```js
export function createPostFX({ renderer, scene, camera, quality } = {}) => PostFX
```
EffectComposer (HalfFloat): RenderPass → UnrealBloomPass (threshold tuned for HDR emissives) → custom cinematic
shader pass (radial **speed blur** from screen center scaled by speed, chromatic aberration ramps with speed/nitro,
lens distortion at nitro, vignette, film grain, subtle teal/orange grade, impact flash) → OutputPass → SMAA/FXAA.

| member | meaning |
|---|---|
| `render(dt)` | render the frame (core calls this instead of renderer.render) |
| `setSize(w, h)` | on resize (core also sets renderer size/pixel ratio) |
| `setCamera(camera)` | switch camera |
| `set({ speed, nitro, impact, shake })` | per-frame scalars 0..1: speed = speedKmh/320, nitro = nitroActive intensity, impact = collision flash |
| `composer` | the EffectComposer |

## 7. Particles — `src/fx/particles.js` (owner: fx)

```js
export function createParticles({ scene, quality } = {}) => Particles
```
Pooled, GPU-friendly (InstancedMesh or Points with custom shader, soft round sprite textures, depth-fade if possible).

| member | meaning |
|---|---|
| `emitSmoke(position, velocity, intensity)` | tire smoke puffs (grows, rises, fades; lit-looking grey-white) |
| `emitSpray(position, velocity, intensity)` | wet-road water spray / mist kicked up behind wheels (very important for the wet look) |
| `emitSparks(position, normal, intensity)` | hot orange sparks (barrier scrape / car hits), additive, streaked by velocity |
| `emitNitroFlame(position, direction, intensity)` | short blue-white exhaust flame burst |
| `addSkidMark(trackId, position, right, intensity)` | continuous tire marks on the road: `trackId` is a unique string per car+wheel (e.g. `"0-rl"`); `intensity` 0 ends the current strip. Ring buffer of quads at y ≈ 0.01. |
| `update(dt, camera)` | simulate + render-prep |

## 8. Rain — `src/fx/rain.js` (owner: fx)

```js
export function createRain({ scene, quality } = {}) => Rain
```
Camera-following volumetric rain streaks (one draw call), stretched by camera velocity (rain angles toward the
camera at speed), plus ground splash ripples near the camera. `update(dt, camera, velocity: Vector3)`, `setIntensity(0..1)`.

## 9. Audio — `src/audio/audio.js` (owner: audio)

```js
export function createAudio() => Audio
```
All sounds synthesized with WebAudio (no files). `init()` must be called from a user gesture (keydown/click);
every other method must be a safe no-op before init or if WebAudio is unavailable.

| member | meaning |
|---|---|
| `init()` | create AudioContext + graph (idempotent) |
| `setEngine({ rpm, maxRpm, throttle, load, gear, speedKmh })` | player engine: rich V8/flat-6 style tone — firing-frequency harmonics, waveshaper growl, intake noise, exhaust resonance, distinct on/off-throttle character, rev limiter crackle |
| `setOpponents([{ rpm, throttle, distance, pan }])` | up to 4 quieter positional opponent engines (pan −1..1) |
| `setSkid(0..1)` | tire screech (wet → more hiss/squeal mix) |
| `setNitro(active)` | nitrous whoosh/rumble loop |
| `setWind(speedKmh)` | wind + road/tire roar + rain-on-car ambience |
| `playShift(up)` | gear change clunk + (on upshift under load) turbo blow-off/flutter |
| `playBackfire()` | exhaust pop/crackle on lift-off |
| `playImpact(intensity)` | collision crunch (0..1) |
| `playScrape(intensity)` | metal-on-barrier scrape (continuous calls ok) |
| `playBeep(final)` | countdown beep (final = higher GO tone) |
| `playUI(kind)` | `'hover' \| 'select' \| 'lap' \| 'finish'` |
| `setAmbience(on)` | rain + distant city ambience bed |
| `setMusic(on)` | optional procedural dark synthwave/drum loop (tempo ~120 BPM), low in the mix |
| `setMasterVolume(v)`, `toggleMute() → bool`, `update(dt)` | |

## 10. HUD & menus — `src/ui/hud.js` + `src/ui/hud.css` (owner: hud)

```js
export function createHUD({ container = document.body } = {}) => HUD
```
DOM/CSS + canvas overlay, NFS-inspired: italic condensed display font (load "Orbitron"/"Rajdhani"/"Russo One" via a
Google Fonts `<link>` injected by hud.js, with system fallback), skewed panels, neon accent (#00e5ff) + warning red.
Bottom-right analog **tachometer** (canvas, redline, needle, shift light) with big digital speed (km/h) and gear;
**nitro** bar; top-left **position** (1st/5) with lap counter and lap/total timers + best lap; bottom-left
**minimap** (canvas, track outline, car dots, player arrow); center messages ("FINAL LAP", "NEW BEST LAP", "WRONG WAY",
drift score popups); countdown "3 · 2 · 1 · GO!"; title menu; pause; results table; controls help.

| member | meaning |
|---|---|
| `showMenu({ onStart, title, subtitle })` | full-screen title menu over the live 3D scene (attract-mode camera behind). Big title, "PRESS ENTER TO RACE" + START button, controls list. Calls `onStart()` once. |
| `hideMenu()` | |
| `showHUD(visible)` | toggle the race HUD |
| `setTrack(polyline: Array<[x,z]>)` | minimap geometry (call once) |
| `update(state)` | every frame; throttle DOM writes internally. `state = { speedKmh, rpm, maxRpm, gear, nitro, nitroActive, lap, totalLaps, position, totalRacers, lapTime, totalTime, bestLap, lastLap, cars: [{ x, z, heading, isPlayer, color }], drift }` |
| `showCountdown(value)` | value 3,2,1 or 'GO' (animated) ; `hideCountdown()` |
| `flash(text, { duration = 2, kind = 'info' })` | kind: `'info' \| 'warn' \| 'good'` |
| `showPause(visible, { onResume, onRestart })` | |
| `showResults(results, { onRestart })` | results = `[{ name, time, bestLap, isPlayer, color, dnf }]` sorted by finish |
| `hideResults()` | |

## 11. Core — `src/main.js`, `src/core/*.js` (owner: core)

Creates the renderer (antialias false when SMAA is used, `powerPreference: 'high-performance'`, pixel ratio ≤ 1.5 high /
1 low, shadows PCFSoft), scene, cameras; wires every module; game loop with **fixed-step physics** (accumulator,
`CONFIG.physics.fixedDt`); state machine `menu → intro (camera fly-by) → countdown → racing → finished (results)`
with `pause`; lap/checkpoint logic (progress = lap·length + s, sector checkpoints to prevent cheating), positions,
lap & best-lap times, wrong-way detection; **chase camera** (spring-damped, look-ahead, speed-based FOV 62→85°, drift
swing, high-speed + collision camera shake; `C` cycles chase-far / chase-near / hood / bumper), barrier collisions
(using `track.project` vs `track.wallOffset`: push back, reflect lateral velocity with restitution + friction, sparks,
scrape sound, impact flash), car-vs-car collisions (oriented-box/capsule approximation, impulse via `applyImpulse`),
particle emission from physics state (smoke/spray/skids at `wheelLocal`, nitro flames at `exhaustLocal`), audio wiring.

Input: keyboard **W/↑ throttle, S/↓ brake/reverse, A/D/←/→ steer, Space handbrake, Shift/N nitro, C camera,
R reset to track, Esc/P pause, M mute, Enter start/confirm**, plus Gamepad API (RT/LT/left stick/A/B/X). Keyboard
steering is smoothed (ramp in/out, faster self-centering, reduced at high speed).

Debug/test API (needed by automated playtests): `window.__game = { state, startRace(), setAutopilot(bool),
getTelemetry() → { state, speedKmh, rpm, gear, lap, position, s, lateral, fps, cars }, setTimeScale(x) }`
and URL params from `URL_PARAMS` in `src/config.js` (`?autostart=1&autopilot=1&laps=1&quality=low&ai=4&nofx=1&mute=1&timescale=2`).

## Test harness

Dev server: `http://127.0.0.1:5391/` (already running; if not, `npx vite --port 5391 --strictPort` in background).
Do NOT use port 5173 (another project). Headless screenshots + console logs (system Chrome, real GPU):

```bash
node scripts/shot.mjs --url 'http://127.0.0.1:5391/dev/car.html' --out shots/car --wait 3000 \
  --steps '[{"shot":"a"},{"hold":"KeyW","ms":3000},{"eval":"window.__game?.getTelemetry()"},{"fps":2000}]'
```
Then view the PNG with the Read tool. Put screenshots in `shots/` with a module-specific prefix. Each module owner
should build a dev bench page `dev/<module>.html` (a minimal three.js scene importing only their module + three) to
iterate visually in isolation.

---

## Integration notes (post-integration state)

- Shadows use `PCFShadowMap` (three r186 removed `PCFSoftShadowMap`; PCF now filters softly).
- `postfx`: `OutputPass` is merged into the cinematic pass (tone mapping + sRGB applied there), and the bloom's
  final full-res additive blend is folded into it too (`bloomPass.skipBlend`).
- Core caps the player's headlight illuminance on whatever the beam hits (`Game._beamExposure`) so barriers and
  cars ahead don't bloom out to white. Barriers: five rays (0, ±11°, ±26°) are marched to the barrier face, and
  the brightest point's illuminance (spot cone × low-beam cookie × incidence / d²) times the paint albedo (painted
  corner blocks 0.65, bare concrete 0.28) is held at `BEAM.wallLum`. Cars: each lamp's illuminance on the nearest
  point of every car in the beam, at 4 heights, is held at `carLux / paintLuminance`. The cap dims fast and
  recovers slowly. Live tuning: `window.__game.beamTune`. Core also gives instanced shadow casters their own depth
  material and makes additive DoubleSide materials `forceSinglePass` (avoids per-frame program re-resolution in three).
- `track.setStartLights(n, go)` is driven by the countdown (5 reds fill up, all green at GO).
- AI rubber-banding: behind the player +6 % power / +3 % grip / +3.6 % planned speed; ahead of the player
  −10 % power / −3 % grip / −6.5 % planned speed (fades in over a 30–250 m gap).
- Test harness: `scripts/shot.mjs` also accepts `--uncapped` (vsync off for real FPS) and `--dpr N`.

## Render layers (added in the polish phase)

`LAYERS` in `src/config.js`: `LAYERS.NO_REFLECTION = 3`. Objects that must be visible to the main camera but NOT
appear in the wet-road planar reflection call `obj.layers.set(LAYERS.NO_REFLECTION)` (fx: sparks, nitro flame
particles, rain, spray/smoke if desired; car: nitro/exhaust flame meshes, road beam decal). Core enables
`camera.layers.enable(LAYERS.NO_REFLECTION)` on all game cameras; the world's reflection virtual camera uses
`camera.layers.mask & ~(1 << LAYERS.NO_REFLECTION)`. Shadow cameras only see layer 0 (so these objects cast no shadows).

## Polish-phase integration notes

- **Headlights (car ↔ core).** `spotLights[i].intensity` is the candela straight ahead on the horizon (default
  1800). The spots project a half-float low-beam light cookie (`SpotLight.map`, `getHeadlightCookie`) whose hot zone
  is ≈ 5.7× that, just below the cut-off. `carTextures.lowBeamProfile(tx, ty)` (tx + = car's right,
  ty + = up, 1.0 = horizon reference) is also exposed as `model.headlightProfile`. Core's exposure cap and the road
  decal (`model.beamDecal`, additive, on NO_REFLECTION) both use it. The spots aim level and stay on layer 0:
  never mask lights out of a camera, because that changes the spot count between passes and doubles program variants.
- **Spot-light shading.** `src/core/shaderPatches.js` patches `THREE.ShaderChunk.lights_fragment_begin` once, before
  anything compiles. For SPOT lights only, direct specular uses roughness ≥ 0.36 and clear-coat roughness ≥ 0.24
  (a lamp lens has a size). The car materials add a punctual-light min roughness and a soft clip on direct specular
  through their own `onBeforeCompile`, which wraps the patched chunk. City building shaders are compiled
  **without** spot lights (`city.js stripSpotLights`, `material.userData.noSpots`): three substitutes light counts
  textually, so the chunks are inlined with the spot counts forced to 0. This saves the cookie fetches and varyings
  on the largest geometry (≈ 0.2 ms at 1080p) with no visible change.
- **Speed-blur focus (core → fx).** Core calls `postfx.set({ focus, focusRadius })` when the camera mode changes:
  the default for chase-far / chase-near, `{ focus: [0.5, -0.06], focusRadius: [1.6, 0.34] }` for the hood (bonnet
  stays sharp), and `{ focusRadius: 0 }` for the bumper. Other postfx extras: `postfx.radialPrePass`,
  `postfx.sceneDepth`, `postfx.params.bloomKnee / bloomRange`.
- **Particles.** `emitNitroFlame(pos, dir, intensity, velocity?)`. Core passes the car velocity so a fresh flame slot
  dead-reckons from its first frame. Exactly 4 slots live per car on nitro at any speed (the old stale-slot trail
  is fixed). `particles.stats().flames`, `particles.uniforms.smokeNear / mistNear` (near-camera fade). Smoke and
  spray are soft particles via `src/fx/sceneDepth.js` (`SOFT_PARTICLE_GLSL`, `softParticleUniforms`,
  `bindSoftParticles`). The opaque depth is copied once per frame, only while smoke or spray is drawn.
- **Layers.** Everything on `LAYERS.NO_REFLECTION` today: car flames and the beam decal, every fx mesh (smoke, spray,
  hot sparks/flames, skids, rain streaks, splashes). Steam plumes are hidden from the mirror through the world's
  `reflectHidden` list. Any custom camera that should see these must `layers.enable(LAYERS.NO_REFLECTION)`. The dev
  benches (car, fx) do. The world reflection camera uses `(camera.layers.mask & ~(1 << 3)) | 1`.
- **Wet road (world).** Schlick Fresnel (F0 0.02) on a macro normal, luminance-dependent blur (dark or diffuse
  content gets a wide glossy lookup, hot sources keep the crisp streak), and an HDR soft knee on every reflection
  tap (linear below luminance 4). Where the planar reflection is on, the PMREM IBL specular is dropped from the
  road and ground (a 15 % hint on rough asphalt). `quality: 'low'` keeps the IBL path.
- **City (world).** Optional additions: `createStreetLightMap(posts)`; `city.setStreetLights(posts)` (called by
  `environment.js` with `lamps.posts`); `city.setLite(on)` around the reflection render. The building material has
  `uStreetLight, uSLBounds, uSLOn, uSLGain, uLite`. Facade u now runs along cross(up, n) (to the viewer's right).
- **Gameplay (core / hud / dynamics).** `hudState.launch = { active, perfect: [lo, hi], good: [lo, hi] }` (fractions of
  max rpm, from `LAUNCH` in game.js) drives the tach launch band; `Tach.draw` takes an optional 7th parameter.
  Slipstream: `src/core/draft.js` sets `VehiclePhysics.dragScale` (default 1) and `physics.draft` (0..1).
  AI: `AIDriver.isAutopilot = true` disables racecraft (set for the player's autopilot); `ai.stats`, `ai.mistake`.
  `AI_SKILL` / `AI_AGGR` in game.js set the rivals' pace and personality (the grid is not in pace order). Lap and
  finish times are interpolated within the frame (race.js).
- **Cockpit cams.** Hood and bumper cams are rigidly body-mounted (same pitch/roll as the model). The hood look-down
  is calibrated by ray-casting the hood silhouette (the hood fills ≈ 15–20 % of the frame), hood FOV 66→78°.
