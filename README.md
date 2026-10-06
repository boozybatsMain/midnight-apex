# MIDNIGHT APEX

A rain-soaked, neon-lit night street race in the spirit of Need for Speed Underground / Heat — one polished,
fully playable demo scene running in the browser.

You race a procedurally modelled mid-engine supercar against four AI rivals over 3 laps of a 2.9 km closed
downtown circuit. The scene has wet asphalt with live mirror reflections, rain, tyre spray, neon, bloom, speed blur, and a synthesized
V8. **Every asset is generated in code**: meshes, textures, the city, the car and all audio. The repo ships no model, image or
sound files.

Built with **three.js r186 + Vite**, plain ES modules (no TypeScript, no other runtime dependencies).

---

## Run it

```bash
npm install
npm run dev          # → http://127.0.0.1:5391/
```

Production build: `npm run build` (output in `dist/`), then `npm run preview` (→ http://127.0.0.1:4391/).

Use a recent desktop Chrome, Edge, Safari or Firefox with hardware acceleration enabled (WebGL 2 required).
Audio starts on your first key press or click (browser autoplay rules).

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Throttle | `W` / `↑` | RT (D-pad ↑) |
| Brake / reverse (hold at a standstill) | `S` / `↓` | LT (D-pad ↓) |
| Steer | `A` `D` / `←` `→` | Left stick / D-pad |
| Handbrake (drift) | `Space` | A / X |
| Nitrous | `Shift` / `N` | B / RB |
| Camera (chase far → chase near → hood → bumper) | `C` | Y |
| Reset car onto the track | `R` | Back |
| Pause | `Esc` / `P` | Start |
| Mute | `M` | — |
| Start / confirm | `Enter` | A |
| Perf overlay | `` ` `` | — |

Driving tips:
- **Drifting:** tap the handbrake (or hold throttle and brake together at speed) while turning in. Then hold
  throttle and steer *into* the slide to hold the angle, from about 26° up to about 41° at full lock. Centre the
  steering or lift off to straighten up. Drifting refills nitrous.
- **Launch control:** during the countdown the tachometer shows the launch window: an amber *good* band and a
  green *perfect* band (the label reads `LAUNCH ✓` while the needle is inside it). Hold the revs in the green band
  when the lights go green for a PERFECT LAUNCH boost. Bouncing off the limiter gives WHEELSPIN, and no revs a
  SLOW START.
- **Slipstream:** above 90 km/h, tucking in 4–45 m behind another car cuts your drag by up to 42 %. Use it to pass
  on the straights. The AI uses it too.

## URL parameters

| Param | Effect |
|---|---|
| `?quality=low` | Cheaper preset. Drops the planar road reflection (puddles use the environment map instead), smaller shadow map, half the particles and rain, lighter bloom, FXAA instead of SMAA, pixel ratio ≤ 1. Default is `high`. |
| `?laps=N` | Number of laps (default 3). |
| `?ai=N` | Number of AI opponents, 0–7 (default 4). |
| `?autostart=1` | Skip the title menu and go straight to the countdown. |
| `?autopilot=1` | The AI drives your car (attract mode / automated tests). |
| `?timescale=X` | Game speed multiplier (e.g. `3` for fast automated races). |
| `?mute=1` | Start muted. |
| `?nofx=1` | Bypass post-processing (debug). |
| `?debug=1` | Show the perf overlay (fps, draw calls, triangles, CPU ms per section). |
| `?drs=0` | Disable adaptive resolution. |

Example of a fast automated race: `http://127.0.0.1:5391/?autostart=1&autopilot=1&laps=1&timescale=3&mute=1`

## Architecture

```
index.html, src/main.js      bootstrap: WebGL check, loading veil, Game
src/config.js                shared constants (car dimensions, liveries, track width, URL params, math helpers)
src/core/                    game core: everything below is wired together here
  game.js                    renderer, scene, fixed-step loop, state machine (menu → intro → countdown → racing →
                             finished → results, with pause), shader warm-up, adaptive resolution, debug API
  car.js                     RaceCar = visual model + physics + AI + per-car bookkeeping / interpolation
  race.js                    laps, sector checkpoints (anti-cheat), timing, positions, wrong-way detection
  collisions.js              barrier (track-space, 4 corners) and car-vs-car (3-circle capsules) impulses
  camera.js                  chase cams (spring lag, drift swing, speed FOV + dolly zoom, shake), hood/bumper
                             cams rigidly body-mounted and fitted to the car by ray-casting, cinematic menu /
                             intro / finish shots
  draft.js                   slipstream (drag reduction in another car's wake)
  shaderPatches.js           renderer-wide shader tweak: wider direct-specular lobe for the headlight spot lights
  input.js                   keyboard + gamepad → smoothed controls and UI actions
  effects.js, audiomix.js    physics state → particles / audio every frame
src/world/                   the circuit and the city
  trackPath.js, track.js     centerline math (Node-safe) + road ribbon, markings, kerbs, barriers, start gantry
  wetShader.js, reflection.js  wet-asphalt road shader + half-res planar reflection shared by road, ground, water
                             (the mirror camera skips LAYERS.NO_REFLECTION: flames, particles, rain, beam decals)
  environment.js             sky, fog, moonlight shadows, env map, and assembly of city / lamps / signs / props
  city.js, lamps.js, signs.js, props.js, sky.js, textures.js
src/vehicle/
  carModel.js (+ carBody.js, carParts.js, carTextures.js)   lofted procedural supercar, LOD, liveries
  physics.js                 single-track vehicle dynamics (Pacejka tyres, drivetrain, assists, nitro)
  ai.js                      racing line, speed planning, traffic, recovery; also the player autopilot
src/fx/
  postfx.js                  bloom → anamorphic streaks → cinematic pass (speed blur, CA, grade, tone map) → SMAA
  particles.js               GPU smoke, spray / mist, sparks + nitro flames, skid marks
  rain.js                    camera-following instanced rain streaks + splash ripples
  sceneDepth.js              opaque-depth snapshot for soft particles (smoke / spray fade where they meet geometry)
src/audio/                   WebAudio synthesis: AudioWorklet V8, opponents, tyres, wind, rain, SFX, music
src/ui/hud.js, hud.css       DOM / canvas HUD: tachometer, minimap, timers, countdown, menus, results
dev/*.html                   per-module test benches (world, car, physics, fx, audio, hud, core)
scripts/shot.mjs             headless Chrome screenshot / playtest harness (Playwright)
CONTRACTS.md                 module interfaces and global conventions
```

Conventions (see `CONTRACTS.md`): Y-up, metres, heading 0 faces +Z. Steering +1 turns right, which makes the
heading decrease. Track lateral offsets are positive to the right of the centerline. Car local +X is the car's left.

## Tech highlights

- **Wet road.** The road is a `MeshStandardMaterial` patched in its shader. It samples a half-resolution HDR planar
  reflection that is distorted by procedural asphalt normals and smeared vertically, so neon, street lamps and tail
  lights streak toward the camera. The mirror follows Schlick Fresnel (F0 = 0.02): looking down near the car only
  bright lights reflect crisply, while dark, diffuse things such as your own car show as a faint, blurred smear. Every
  reflection tap goes through an HDR soft knee, so a hot source can streak but never bloom into a blob. Puddles
  collect in the gutters and wheel ruts and show rain ripples, with an animated shimmer in the distance.
  Streetlight pools are computed in the shader from lamp positions instead of using real lights. All markings
  (lane lines, kerbs, crosswalks, grid boxes) are painted in the same shader.
- **City.** About 1,500 procedural buildings are merged into a handful of draw calls. Their facades use six
  procedural texture layers with lit windows, storefronts and rooftop machinery. Up close, every window is
  analytic: crisp frames, mullions and transoms, a recessed reveal, and an interior-mapped room behind the glass.
  Further away the window coverage is box-filtered per pixel, so the skyline doesn't turn into a blocky mosaic.
  A top-down irradiance map baked from the real streetlight positions washes the lower floors facing the road
  with warm sodium or cool LED light. One canvas atlas holds the neon signs, which flicker and are drawn as one
  additive mesh. Manhole steam plumes are wispy, lit by the nearest streetlights and tinted by neon, and fade near
  the lens. The city also has an elevated highway, a waterfront and a far skyline ring.
- **Car.** The body is lofted from 175 superellipse cross-sections, with arch cut-outs and draped details. Paint
  is a clear-coated metallic with a per-car livery canvas and rain beads. Rims are instanced, with blur discs
  that fade in to stop strobing. Racing stripes are drawn analytically in the paint shader, so they stay crisp
  from the hood cam. Nitro flames are ray-marched inside a small hull per exhaust, with a blue-to-violet envelope,
  a white-hot core and shock diamonds. There is a low-detail version beyond 38 m. The player car has real spot-light
  headlights that project a low-beam light cookie: a soft cut-off just below the horizon with the classic kink up
  on the kerb side, and an even pool from about 4 to 15 m. The road decal every car paints comes from the same
  profile. An automatic headlight exposure keeps the brightest lit barrier point (weighted by its paint albedo)
  and any car in the beam within a luminance budget, so nothing a few metres ahead blows out to white.
- **Physics.** A single-track model with simplified Pacejka tyres, weight transfer, downforce, and a
  friction-ellipse limit that combines braking or traction with cornering. It has a 6-speed automatic with a rev
  limiter and launch control, ABS and traction control, counter-steer and drift-angle assists, and nitro. The
  physics runs at a fixed 120 Hz with interpolation.
- **AI.** Each driver follows a minimum-curvature racing line with a grip-aware speed plan (planned speed never
  exceeds the available grip), steering by pure pursuit. They handle traffic and overtakes, recover when stuck,
  and use nitro on straights. Rivals have racecraft. Each has a personality: attackers brake later and follow
  closer, while defenders cover the inside. Pace varies from lap to lap, and seeded corner mistakes (late braking,
  a missed apex, a scruffy exit) make the field race through itself. The grid is not in pace order. Rubber-banding
  keeps the pack in reach: a rival far ahead of you backs off in the corners, and one far behind gets a little
  extra power. The same driver doubles as the player's autopilot, without the racecraft.
- **Post-processing.** The HDR chain runs a Karis-weighted soft-knee bloom at half resolution, then anamorphic
  streaks, limited to small hot light sources so large lit surfaces don't smear. A single cinematic pass then does
  the radial speed blur, spectral chromatic aberration, nitro lens warp, ACES tone mapping, split-tone grade,
  vignette and grain, with the bloom composite folded in under a soft ceiling. SMAA runs last. The speed blur is
  two-level, with a half-res jittered pre-pass and coarse taps, about 64 effective samples. It has a protected
  focus region per camera (the car in chase views, the bonnet in the hood cam), so it never drags ghost copies of
  the car across the road. Smoke and spray are soft particles that fade where they meet geometry.
- **Audio.** Everything is synthesized, with no samples. An AudioWorklet crossplane-V8 engine models the firing
  order, exhaust resonators, intake, overrun crackle and limiter. Separately you get positional opponent engines
  with Doppler, a turbo whistle with blow-off valve, tyre squeal and wet hiss, wind, a rain bed, impacts and
  scrapes, a street-canyon convolution reverb, and procedural synthwave music.
- **Performance.** Most of the scene is instanced or merged geometry, and there are only 3 real-time lights:
  the moon and two headlights. The building shaders are compiled without the headlight spot lights, which can't
  reach the facades past the barriers anyway. Shaders are precompiled behind the loading veil. A typical race frame
  is 240–310 draw calls including the shadow and reflection passes. Adaptive resolution steps the pixel ratio down
  if frames run long. Measured at 1920×1080 on an Apple M2 Pro during an autopilot race with vsync off: about
  135–155 fps on `high` (roughly 7 ms per frame) and 190–205 fps on `low`. With vsync on, both hold a steady 60.

## Testing

`node scripts/shot.mjs --url '<url>' --out shots/name --steps '<json>'` drives headless Chrome. It supports key
holds and presses, `eval` of JavaScript in the page, screenshots, and `{"fps": ms}` measurements. Add `--uncapped`
to measure FPS with vsync off, and `--dpr 2` to emulate a HiDPI screen.

The page exposes `window.__game`, which provides:
- `state`, `startRace()`, `restart()`, `pause()` / `resume()`;
- `setAutopilot(bool)`, `setTimeScale(x)`, `setCamera(mode)`;
- `teleport(s, lateral, speed)` and `runScript(steps)` for game-time scripted input;
- `getTelemetry()`, which reports speed, laps, positions and every car, plus draw calls, triangles, CPU ms per
  section and subsystem errors.

`node dev/physics-test.mjs` and the other `dev/*.mjs` scripts test the physics and AI in Node.

The world bench takes free-camera parameters for close-up checks. `dev/world.html?camS=s,lat,h&lookS=s,lat,h`
sets the camera and target in track space (arc length, lateral offset, height). `?cam=x,y,z&look=x,y,z` sets them
in world space, and `?noinfo=1` hides the overlay. `dev/car.html?view=hood` and `?view=bumper` preview the cockpit
cams. `window.__game.beamTune` live-tunes the headlight exposure caps.
