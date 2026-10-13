export const meta = {
  name: 'midnight-apex-build',
  description: 'Build the NFS-inspired night racing demo: 7 parallel module builders, then one integrator that makes the full race playable',
  phases: [
    { title: 'Build', detail: 'world, car, dynamics+AI, fx, audio, hud, core — each owns its files' },
    { title: 'Integrate', detail: 'wire modules, fix mismatches, verify a full race end-to-end' },
  ],
}

const ROOT = '/Users/boozybats/Public/Repos/work/genex-stage1-game'

const PREAMBLE = (role, files) => `You are the **${role}** agent on a small team building **MIDNIGHT APEX**, a hyper-realistic, Need-for-Speed-inspired night street-racing game in the browser (three.js r186 + Vite, plain JS ES modules). The deliverable is ONE highly polished, fully playable demo scene: a rain-soaked neon downtown circuit at night, player vs 4 AI rivals, 3 laps.

Project root: ${ROOT}
FIRST read ${ROOT}/CONTRACTS.md completely (source of truth for APIs, coordinate conventions, file ownership, test harness) and ${ROOT}/src/config.js.

Other agents are writing the other modules AT THE SAME TIME. Rules:
- ONLY create/modify files you own: ${files}. Never edit anyone else's files, package.json, vite.config.js, src/config.js or CONTRACTS.md. Do not run \`npm install\` (no new dependencies; everything is procedural — no external assets/files/URLs except a Google Fonts stylesheet for the HUD).
- Keep exported names/signatures exactly as in CONTRACTS.md (you may add optional extras). Your file currently holds a crude STUB — replace it. Get a first working version of the FULL public API in place early (others may already import it), then iterate on quality.
- Code against other modules only through their contracts. If something is ambiguous, choose the most sensible interpretation and mention it in your report.
- Do NOT run \`vite build\` (concurrent builds clash). Validate with \`node --check <file>\` and by loading pages from the already-running dev server at http://127.0.0.1:5391/ (never port 5173). If the server is down: \`cd ${ROOT} && (npx vite --port 5391 --strictPort >/tmp/claude-501-vite-$RANDOM.log 2>&1 &)\`.
- Visual/behavioural verification: build a bench page \`dev/<module>.html\` that imports only three + your module (and read-only stubs/contracts of others if needed), then run the headless harness, e.g.
  \`cd ${ROOT} && node scripts/shot.mjs --url 'http://127.0.0.1:5391/dev/<module>.html' --out shots/<module>-v1 --wait 3000 --steps '[{"shot":"a"},{"eval":"..."}]'\`
  and LOOK at the PNGs with the Read tool. Iterate several times — compare honestly against modern AAA racing games (NFS Heat/Unbound, Forza Horizon at night) and fix what looks cheap. Check the printed browser console for errors/warnings and fix them. Pages may hot-reload mid-run when other agents save files — just rerun. FPS numbers are noisy while other agents run benches; judge perf mainly from renderer.info.render.calls / triangles and sound design choices.
- Quality bar: this is the showcase. Not a prototype: realistic proportions, materials, lighting, motion, feel. But it must hold 60 fps on an M2 Pro at 1080p together with all other modules.

When finished, reply with the structured report: files you own and wrote, what you built, any contract deviations/additions the integrator must know, known issues, perf notes.`

const REPORT = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string', description: 'what was built, key techniques' },
    contract_notes: { type: 'string', description: 'deviations, additions, interpretation choices the integrator must know' },
    known_issues: { type: 'array', items: { type: 'string' } },
    perf_notes: { type: 'string' },
    screenshots: { type: 'array', items: { type: 'string' }, description: 'paths of the best verification screenshots' },
  },
  required: ['files', 'summary', 'contract_notes', 'known_issues', 'perf_notes'],
}

const BUILDERS = [
  {
    key: 'world',
    files: 'src/world/track.js, src/world/environment.js, any other src/world/*.js, dev/world.html',
    prompt: `Your job: the TRACK and the night-city ENVIRONMENT (sections 1 and 2 of CONTRACTS.md). This is where most of the "hyper-realistic" impression comes from.

TRACK (src/world/track.js): export both createTrackPath() (pure math, Node-safe — no document/canvas/WebGL; verify with a tiny node script that imports it) and createTrack() (path + meshes).
- Design a believable downtown street circuit, 2.4–3.2 km, mostly city-grid streets: long start/finish boulevard (≥450 m), a sequence of ~90° block corners (R 30–45 m), a fast sweeper along a "waterfront/highway" section, a chicane, a hairpin (R ≥ 22 m). Hand-place control points, smooth (centripetal Catmull-Rom or arc+line construction), resample uniformly every ~1 m, precompute tangent/right/curvature tables. Validate min radius and that the loop never self-intersects or comes within ~60 m of itself except where intended (an overpass crossing is NOT allowed — the world is flat; keep it non-crossing).
- project(pos, hintS) must be fast and robust (local window search around hint, global fallback via a coarse spatial grid when the hint is far off).
- Road mesh: one continuous ribbon (u = lateral meters, v = arc meters), plus raised sidewalks (15 cm curb face) beyond the barrier line or concrete jersey barriers / steel guardrails with reflector posts at the wall line (cars collide at ±wallOffset, so the barrier face must be visually exactly there). Lane markings: dashed white lane lines, solid edge lines, red/white rumble curbs at corner apexes, a checkered start/finish line and a lit start/finish gantry with an LED banner "MIDNIGHT APEX". Grid slot boxes painted on the road. Markings should be in the road shader or decals so they also look wet.
- WET ROAD: implement the contract's recommended approach: soaked dark asphalt with procedural normal/roughness detail (aggregate noise, cracks, tar seams), puddles with mirror-like reflections, planar reflection render target (half res, quality 'high'), streaked/blurred vertically, fresnel-weighted; analytic streetlight light pools from lampSpacing (warm sodium + some cool LED). This must look stunning — the reflections of neon on the wet street are the signature image of the game.

ENVIRONMENT (src/world/environment.js):
- Night sky: deep blue-purple gradient with orange/purple light-pollution glow at the horizon, low clouds lit from below, no visible "box". FogExp2 to sell depth and rain haze. Moonlight DirectionalLight with a tight shadow frustum following the focus (PCFSoft, 2048 high / 1024 low) — cars and props cast shadows near the player.
- Buildings: dense downtown blocks filling the space between and around the streets (towers 20–180 m, varied footprints, setbacks, rooftop props, antenna with blinking red aircraft lights), procedural window atlas canvas textures (thousands of windows, varied warm/cool/office/residential lighting, some dark, blinds) as emissive maps; street-level storefronts with glowing signage. Use InstancedMesh / merged geometry; guarantee no building overlaps the road/sidewalk (distance test against the track samples, keep ≥ wallOffset + 6 m clearance). Distant skyline ring for the horizon.
- Neon & signage: many neon signs (canvas-rendered glowing text of invented names — e.g. "NEON NOODLE", "HOTEL ZENITH", "24H", "KARAOKE", Japanese-style katakana/kanji-like signs, arrows), big emissive billboards, LED screens; colours magenta/cyan/amber/violet. Emissive intensities high for bloom.
- Streetlights every track.lampSpacing m on both sides (instanced poles + emissive heads), traffic lights at junctions, a highway overpass/bridge structure spanning one straight (above the cars, purely visual), parked props (bus stop shelters, dumpsters, hydrants) sparingly, steam vents (simple animated sprites) optional.
- PMREM envMap: render a simplified night-city cube (or use the scene once) so car paint reflects neon and warm streetlights.
- update(dt, {time, camera, focus}): shadow follow, planar reflection render (hide reflection-irrelevant tiny stuff if helpful), blinking lights, flickering neon.

Bench dev/world.html: renderer set up like the game (ACES, sRGB, shadows, UnrealBloom + OutputPass is fine to add locally for preview), a camera that flies along the racing line at chase height (~3 m up, 8 m behind) at a URL-param position ?s=...&speed=... so you can screenshot many spots, plus a high aerial view (?aerial=1) to check layout. Print renderer.info.render.calls/triangles. Target ≤ 350 draw calls for the whole world at chase view.`,
  },
  {
    key: 'car',
    files: 'src/vehicle/carModel.js, any src/vehicle/car*.js, dev/car.html',
    prompt: `Your job: the procedural CAR MODEL (section 3 of CONTRACTS.md). The player stares at the back 3/4 of this car for the whole race — it must look like a real modern supercar, not a toy.

- Proportions from CONFIG.car (4.55 L × 1.95 W × 1.22 H, wheelbase 2.70, track 1.66, wheel radius 0.35). Low, wide, mid-engine or long-hood GT stance; wheels fill the arches with small gaps; slight rake.
- Body: build smooth lofted geometry — define profile curves (plan-view half-width w(z), side-view top/bottom y(z), cross-section superellipse/blend that varies along z) and generate a dense, smooth-normal BufferGeometry; carve or overlay flared wheel arches (dark arch liners + body flares), sharp character lines via secondary meshes, hood vents, side intakes, front splitter, side skirts, rear diffuser with fins, ducktail or swan-neck wing, side mirrors, door seams/shut lines (thin dark lines), quad exhaust tips (brushed metal, inner glow when nitro).
- Greenhouse: separate lofted canopy with dark tinted MeshPhysicalMaterial glass (high reflectivity via envMap, slight transmission look), blacked-out pillars, a simple interior silhouette (seats, steering wheel) visible through glass.
- Paint: MeshPhysicalMaterial, metalness ~0.6, roughness ~0.35, clearcoat 1, clearcoatRoughness ~0.03, a subtle procedural metallic-flake normal/roughness map; carbon-fibre accents (procedural weave texture) on splitter/diffuser/mirror caps; accent colour stripes/livery decal (number + name on doors via canvas decal) using the 'accent' option.
- Lights: LED headlight strips + projector lenses (emissive, HDR intensity) — player car gets two real SpotLights (angle ~0.5, penumbra 0.6, distance 80, intensity tuned for ACES, no shadows) aimed slightly down the road, plus an additive light-cone decal on the road for all cars. Full-width tail light bar + 3D tail lamp clusters (emissive red; brake → much brighter), reverse lights, small amber side markers.
- Wheels: LatheGeometry tires with rounded sidewalls & tread texture, multi-spoke (or Y-spoke) machined alloy rims (ExtrudeGeometry spokes, polished lip, center lock), cross-drilled brake discs + coloured calipers that do NOT rotate with the wheel but DO steer with front wheels. setState spins rims/tires about the axle and yaws front wheels (careful with sign: + steerAngle = steer right = front of wheel points toward −X).
- Under-car soft contact shadow (radial gradient plane, multiply/transparent) + underbody dark plane so it never looks floating.
- Body suspension: setState pitch/roll rotate the body group about a pivot near the wheel center height; wheels stay planted.
- Merge static parts per material to keep draw calls ≤ ~25 per car; share geometries/materials across cars where only colour differs (clone paint material per car).

Bench dev/car.html: dark wet-floor studio at night (RoomEnvironment PMREM or a few rect lights), UnrealBloom + OutputPass locally, turntable with URL params ?angle=deg&livery=n&lights=1&brake=1&steer=0.4, and a row of all 8 liveries option (?row=1). Screenshot from at least: rear 3/4 chase angle (how the player sees it), front 3/4, side profile, top. Iterate until the silhouette and materials are genuinely convincing.`,
  },
  {
    key: 'dynamics',
    files: 'src/vehicle/physics.js, src/vehicle/ai.js, dev/physics.html (and optional dev/*.mjs node test scripts)',
    prompt: `Your job: VEHICLE DYNAMICS and AI DRIVERS (sections 4 and 5 of CONTRACTS.md). The game must FEEL great: weighty, fast, grippy but driftable, like NFS Heat/Unbound.

PHYSICS (src/vehicle/physics.js, class VehiclePhysics):
- Single-track (bicycle) model in world space with body-frame velocities (vx forward, vy lateral), yaw rate, mass ~1450 kg, inertia ~2500 kg·m², CG split ~45/55, front/rear lateral tire forces from slip angles via a simplified Pacejka (B,C,D,E) with load transfer (longitudinal weight transfer from acceleration), combined slip (friction circle) so heavy throttle/handbrake reduces rear lateral grip → oversteer/drift.
- Low-speed handling: blend into a kinematic model below ~3 m/s so there is no jitter/creep at rest and turning while slow works. No NaNs ever (guard divisions by speed).
- Drivetrain: torque curve (peak ~650 N·m mid-range), 6-speed automatic with ratios + final drive giving ~305 km/h top speed near redline in 6th, upshift ~7600 rpm, downshift logic, 0.15 s shift cut, rev limiter bounce at 8000, idle 900, engine braking, aero drag + rolling resistance, downforce growing with v² (more grip at speed). Reverse via holding brake when nearly stopped. Nitro: +~45% drive force and higher drag-limited top speed (~335 km/h), drains in ~5 s, refills slowly over time and faster while drifting (drift ⇒ addNitro).
- Steering: speed-sensitive max wheel angle (~32° at 0 → ~6° at 250 km/h), steering rate limit, mild counter-steer/yaw-damping assist that helps catch slides (the game is arcade-sim: fun, forgiving, not twitchy). Handbrake locks rear (big rear grip loss) for drift initiation; holding throttle sustains a drift; releasing straightens up. A 90° corner at ~100 km/h with braking should be comfortably makeable.
- Outputs: every readable field in the contract, incl. skid per wheel (from slip ratio/angle), drift (0..1 from body slip angle while moving), visual pitch/roll from smoothed accelerations (a few degrees max), wheelSpinFront/Rear (rear spins faster under wheelspin), shiftCount/lastShiftUp.
- applyImpulse(impulse, point): linear + angular (r × J) about Y; robust to large impulses.

AI (src/vehicle/ai.js, class AIDriver):
- Compute a racing line once per track (cache in a WeakMap keyed by track): iterative minimum-curvature-ish smoothing of lateral offsets constrained to ±(wallOffset − 1.6), then a speed profile (forward/backward passes with accel/brake limits, v = sqrt(μ_eff·g/|κ|)). Drive with pure pursuit on the line (look-ahead grows with speed), PID-ish throttle/brake to hit the speed profile, scaled by skill (0.7–0.95). Overtake/avoid: if a car is ahead within ~25 m and slower, shift lateral target to the free side; keep ≥ 2.5 m lateral separation when side-by-side. Use nitro on long straights when speed profile allows. Rubber-band: if far behind player speed multiplier up to +6%, if far ahead −6%. Recovery: if stuck/slow/backwards for >2 s, reverse/steer out. Small per-driver imperfections from seed.
- Must work both for opponents and as the player autopilot; it must reliably finish laps without hitting walls.

Testing: write Node test scripts (e.g. dev/physics-test.mjs) that import VehiclePhysics + AIDriver + createTrackPath (from src/world/track.js — the world agent is replacing the stub with the real circuit; createTrackPath is Node-safe by contract; if it currently isn't, test with the stub oval and retest later) and run: 0–100 km/h time, 0–200, top speed (with/without nitro), braking 100→0 distance, max steady-state lateral g at 100 km/h, behaviour at rest (no creep), handbrake drift initiation + recovery, stability across dt, and a 5-car AI race of 3 laps reporting lap times, wall contacts (|lateral| > wallOffset − halfWidth), and ensuring no car gets stuck. Re-run against the real track once it lands (check periodically by re-running your test). Also build dev/physics.html: top-down/chase view on the track with a simple box car driven by keyboard (W/S/A/D/Space/Shift) and telemetry overlay — use it with the screenshot harness to sanity check.`,
  },
  {
    key: 'fx',
    files: 'src/fx/postfx.js, src/fx/particles.js, src/fx/rain.js, any other src/fx/*.js, dev/fx.html',
    prompt: `Your job: POST-PROCESSING, PARTICLES and RAIN (sections 6, 7, 8 of CONTRACTS.md). This is the cinematic layer that makes it look like a modern racing game.

POSTFX (src/fx/postfx.js): EffectComposer with HalfFloatType targets. RenderPass → UnrealBloomPass (tune for HDR emissives: threshold ~0.8–1.0 in linear HDR, strength ~0.7–0.9, radius ~0.6; half-res where possible) → one custom "cinematic" ShaderPass that does in a single pass: radial speed/zoom blur toward screen center (strength from set({speed}), stronger at edges, 8–12 taps, none in the center 30%), chromatic aberration at edges ramping with speed and nitro, barrel/lens distortion pulse with nitro, vignette, filmic grain (animated, subtle), color grade (slight teal shadows / warm highlights, contrast, saturation), impact flash/desaturate on set({impact}) → OutputPass → SMAAPass (quality high) or FXAA (low). Handle setSize/pixel ratio correctly. Optional: a cheap lens-dirt/anamorphic streak from bloom for bright lights (horizontal streaks are very NFS) — only if cheap.

PARTICLES (src/fx/particles.js): one or few draw calls per particle type using InstancedMesh camera-facing billboards or THREE.Points with a custom ShaderMaterial (size attenuation, per-particle age/alpha/size/rotation attributes), procedural soft sprite textures (canvas radial gradients / noise puffs). Fixed-size ring-buffer pools (high: ~3000 smoke/spray, 800 sparks; low: half). Types:
 - smoke: thick tire smoke that billows, grows, drifts with wind, lit greyish-white with slight colour pick-up from neon (tint uniform), normal blending, depth-write off.
 - spray: wet-road water spray/mist kicked up behind tires at speed — the most visible effect in rain at speed; light, fast, fine droplets + mist, additive-ish subtle.
 - sparks: additive bright orange/yellow streaks oriented by velocity, gravity, bounce on y=0, short life.
 - nitro flame: blue/white/purple additive flame cone from exhaust, flickering, short.
 - skid marks: per trackId continuous strips (quads joined between successive points), ring buffer (high 4000 segments), dark semi-transparent, polygonOffset to avoid z-fighting with the road at y≈0.01, fade older ones.
 update(dt, camera) advances simulation; keep CPU cost low (typed arrays, no per-frame allocations).

RAIN (src/fx/rain.js): camera-following box of rain streaks as one InstancedMesh or LineSegments with a vertex shader that wraps positions around the camera (no CPU per-drop), streak length/direction from rain fall + camera velocity (rain angles toward you at speed), subtle bright refraction look, plus small expanding splash rings / bounces on the road near the camera (instanced, shader-animated). setIntensity.

Bench dev/fx.html: a mini night scene (dark wet plane, a few emissive neon boxes and strings of light, a moving box "car" circling with emitters for each particle type, rain on), URL params ?speed=0..1&nitro=1&impact=1&type=smoke|spray|sparks|nitro|skids&rain=0..1 so you can screenshot each effect in isolation. Iterate visually until each effect is convincing, not cartoony. Report the per-frame cost (draw calls) of each part.`,
  },
  {
    key: 'audio',
    files: 'src/audio/audio.js, any other src/audio/*.js, dev/audio.html',
    prompt: `Your job: the complete procedural AUDIO system (section 9 of CONTRACTS.md). No audio files at all — everything synthesized with the WebAudio API (AudioWorklet via an inline Blob URL module is allowed and recommended for the engine).

Most important: the PLAYER ENGINE must sound like a real high-performance car (V8-ish / flat-6 howl), not a buzzing oscillator:
 - Firing-frequency based synthesis: f_fire = rpm/60 × cylinders/2. Generate a pulse train / sum of harmonics with per-cylinder slight irregularity (random phase/amp jitter per firing), feed through formant/resonant bandpass filters modelling exhaust and intake resonances, a waveshaper for growl, plus AM-modulated noise for combustion roughness. Two blended characters: on-throttle (bright, aggressive, loud) and off-throttle (muffled, burbly, with occasional crackles/pops). Rev limiter: rapid cut stutter. Smooth parameter changes (setTargetAtTime) — no zipper noise, no clicks on gear changes. Add a turbo whistle layer rising with rpm × throttle and a blow-off/flutter on upshift under load.
 - Opponents: 4 cheaper engine voices with stereo pan + distance attenuation + doppler-ish pitch hint, mixed low.
 - Tire screech (filtered noise + resonant squeal with wobble; on wet roads more hiss), wind/road roar rising with speed, rain-on-roof/rain ambience bed + distant city hum, nitrous whoosh loop, impact crunch (noise burst + low thump + metallic debris), barrier scrape (continuous gritty band-passed noise with rate limiting), backfire pops, countdown beeps, UI clicks, lap/finish stingers.
 - Optional music (setMusic): a subtle procedural dark synthwave loop (kick, snare, hats, bass arpeggio, pad) at ~118–124 BPM, scheduled with a look-ahead scheduler, low in the mix, off by default? — make it default ON at a tasteful level once racing starts (core will call setMusic(true)).
 - Master chain: compressor/limiter, master gain, mute toggle; CPU-light (target < 5% main thread; worklet for engine). Everything must be a no-op before init() and must never throw if AudioContext is unavailable.

You cannot listen, so verify analytically: in dev/audio.html build (a) an interactive bench (sliders rpm/throttle, buttons for every SFX, auto rpm sweep) and (b) an automated OfflineAudioContext/Analyser check you can run headlessly through scripts/shot.mjs eval steps (Chrome is launched with autoplay allowed): render a few seconds of the engine at several rpm/throttle points and each SFX; report RMS/peak (no clipping > -1 dBFS), absence of NaN/silence, spectral centroid rising with rpm, fundamental tracking f_fire. Think carefully about DSP correctness; prefer well-known, robust techniques.`,
  },
  {
    key: 'hud',
    files: 'src/ui/hud.js, src/ui/hud.css, any other src/ui/*, dev/hud.html',
    prompt: `Your job: the HUD and all MENUS/SCREENS (section 10 of CONTRACTS.md). Style: NFS Heat/Unbound-inspired — bold italic condensed display type, skewed/parallelogram panels, thin neon cyan (#00e5ff) accents with magenta/red highlights, subtle glass/blur backdrops, smooth CSS animations, crisp on high-DPI, scales with viewport (use clamp()/vmin), never covers the center of the screen during racing.

Elements:
- Tachometer (bottom-right): canvas-drawn analog arc 0–9 (×1000 rpm) with redline zone, tick marks, glowing needle with smoothing, shift light flash near redline, big digital speed (km/h, tabular numerals) and gear letter (R/N/1–6) in the center; nitro bar curved along the gauge or below it (glows/pulses when active, dim when empty). Redraw at most at display rate, cheaply.
- Top-left: POSITION big "2/5" with "nd" style ordinal superscript; LAP 2/3; current lap time, total time, best lap (mm:ss.mmm).
- Bottom-left: minimap canvas — track outline (thick dark line + thin neon line), start/finish tick, opponent dots (their livery colour), player arrow, rotate the map with the player heading (player always pointing up) or north-up — choose what reads best; clip to rounded square.
- Center messages (flash): "FINAL LAP", "NEW BEST LAP 0:58.231", "WRONG WAY", drift "+1,250 DRIFT" popups; kinds info/warn/good with distinct colours; queue them.
- Countdown: huge animated 3 · 2 · 1 · GO! (scale/blur-in, GO in neon green) centered.
- Title menu: full-screen overlay over the live 3D scene (transparent center, dark gradient edges): huge game logo "MIDNIGHT APEX" (stylised, glowing, maybe skewed with a speed-line motif) + subtitle "Neon District Circuit", race info (3 laps · 5 racers · Night · Rain), a START RACE button + "PRESS ENTER" blinking prompt, a controls panel (W/↑ throttle, S/↓ brake·reverse, A D/← → steer, Space handbrake, Shift/N nitrous, C camera, R reset, Esc pause, M mute; gamepad supported). Enter key or click triggers onStart exactly once.
- Pause overlay (Resume / Restart), Results screen (finishing order table with position, driver name with livery colour chip, total time, best lap, player row highlighted, "PRESS ENTER TO RACE AGAIN" + button).
- A small loading/"click to enable audio" hint is not needed — Enter/click from the menu is the user gesture.
Implementation: inject a Google Fonts <link> (e.g. "Russo One" + "Rajdhani" or "Orbitron") with good system fallbacks; all DOM created by hud.js inside a root div with pointer-events none except interactive menus. update() must not thrash layout: cache elements, only write textContent when it changes, draw canvases with requestAnimationFrame-aligned updates from update().

Bench dev/hud.html: dark animated background (or a static neon gradient) + simulated race state (rpm sweeping, speed, gear changes, positions changing, minimap with a demo polyline and moving dots); URL params ?screen=menu|race|countdown|pause|results to screenshot each. Iterate on the screenshots until it genuinely looks like a shipped AAA racing game HUD.`,
  },
  {
    key: 'core',
    files: 'index.html, src/main.js, src/style.css, src/core/*.js (e.g. game.js, camera.js, input.js, collisions.js, race.js)',
    prompt: `Your job: the GAME CORE (section 11 of CONTRACTS.md) — the glue, game loop, camera, input, race logic, collisions, and the moment-to-moment feel. Other modules currently exist as working STUBS (crude but contract-compliant) and will be replaced by real implementations while you work — code strictly against the contracts so swapping is seamless, and re-test periodically as they land.

Build:
- main.js bootstraps: renderer (WebGLRenderer, powerPreference high-performance, antialias false (SMAA in postfx), outputColorSpace sRGB, toneMapping ACESFilmic with exposure ~1.0 (tunable), shadows PCFSoft, pixelRatio min(devicePixelRatio, 1.5) high / 1 low), scene, PerspectiveCamera (near 0.1, far ~3000); createTrack → scene.add(track.group); createEnvironment; scene.environment = env.envMap; cars (player + CONFIG.race.aiCount AI) via createCarModel + VehiclePhysics + AIDriver, liveries from CONFIG.liveries, placed with track.getStartGrid(slot) (player starts mid-pack, e.g. slot 3 of 5, so there is racing to do); createParticles, createRain, createPostFX, createAudio, createHUD (hud.setTrack(track.getMinimapPolyline())).
- Loop: requestAnimationFrame / renderer.setAnimationLoop, dt clamped (≤ 0.1), timescale from URL_PARAMS, fixed-step physics accumulator (CONFIG.physics.fixedDt, max sub-steps) and render interpolation of car transforms; pause when tab hidden.
- State machine: 'menu' (attract mode: slow cinematic orbit/dolly around the player car on the grid, rain, HUD hidden, hud.showMenu) → on start: audio.init() (user gesture!), short 'intro' camera sweep from front of the car to chase position (~2.5 s) → 'countdown' 3-2-1-GO with beeps (cars held; revving allowed — throttle raises rpm, launch boost if rpm in sweet spot at GO is a nice touch) → 'racing' → 'finished' after the player completes CONFIG.race.laps (AI keep driving; when all finish or 25 s pass, show results; DNF times estimated from progress) → Enter restarts everything cleanly (reset cars to grid, clear particles if possible, timers). 'paused' via Esc/P.
- Race logic: per car progress = lapsCompleted·length + s (track.project with hintS each frame); crossing the start line forward with ≥ 3 sector checkpoints passed counts a lap (no cheating by reversing over the line); lap/total/best/last lap times; positions sorted by progress (finished cars by finish order); wrong-way detection (heading vs tangent > 110° while moving for > 1 s → hud.flash WRONG WAY); "FINAL LAP" flash; "NEW BEST LAP" flash; drift scoring popup (drift > 0.4 for > 1 s accumulates points; flash on end) + nitro reward is already given by physics.
- Collisions: barrier — for each car compute corners/half-width vs ±track.wallOffset: if penetrating, push position back inside along the right vector, remove/reflect the outward lateral velocity component with restitution ~0.3 and tangential friction proportional to impact (scraping slows you), small yaw kick aligning with the wall; emit sparks at contact point + audio.playScrape/playImpact + postfx impact + camera shake scaled by impact speed. Car–car: oriented boxes (halfLength, halfWidth) via SAT or circle-chain approximation (3 circles per car), positional correction + impulse exchange via applyImpulse at contact point, sparks, impact sound. Must never tunnel at 330 km/h (sub-step or sweep).
- Camera: chase cam (default) — spring-damped position behind/above the car (distance ~6.2 m, height ~2.0 m at rest, stretching slightly at speed), looks a bit ahead of the car, smoothed yaw lag that swings out in drifts, FOV 62°→85° with speed and +6° kick on nitro, subtle high-frequency shake at >250 km/h and on impacts, never clips below road. 'C' cycles chase-far / chase-near / hood / bumper. Reset with 'R' (places car on centerline at current s facing forward, brief ghost/invuln optional).
- Input (src/core/input.js): keyboard per contract (use e.code), smoothed digital steering (rise ~6/s, fall ~10/s, max steer reduced with speed), throttle/brake ramps, Gamepad API (RT throttle, LT brake, left stick steer with deadzone, A/X handbrake, B nitro, Y camera, Start pause), prevent page scroll on arrows/space.
- Effects wiring per frame: for each car (player full, AI reduced): spray at rear wheel contact points when speed > 30 km/h (intensity ∝ speed), smoke + skid marks when skid > 0.35 (both rear, fronts when braking hard), nitro flames at model.exhaustLocal (transform to world), brake lights/reverse/headlights/steer/wheel spin/pitch/roll into carModel.setState; rain.update(dt, camera, cameraVelocity); env.update(dt, {time, camera, focus: player position}); postfx.set({speed: kmh/320, nitro, impact, shake}); audio.setEngine/setOpponents(nearest 4 with pan from camera-relative x and distance)/setSkid/setNitro/setWind/playShift on shiftCount change/playBackfire on throttle lift at high rpm; hud.update(state) with all fields.
- window.__game debug API + URL params exactly as in the contract (autostart, autopilot, laps, ai, quality, nofx, mute, timescale, debug shows an fps/draw-call overlay).
- A minimal loading veil in index.html/style.css shown until the first frame renders (dark with a pulsing logo text) so there is no flash of white; handle resize; prevent context menu on canvas.
- Robustness: wrap every subsystem update in a way that a bug in one module (e.g. audio) logs once and does not kill the loop. No per-frame allocations in hot paths.

Verify end-to-end with the harness: menu screenshot; ?autostart=1 countdown screenshot; keyboard driving (hold KeyW, steer) screenshots; ?autostart=1&autopilot=1&laps=1&timescale=3 run until finished → results screen; check __game.getTelemetry(); no console errors. Re-run as other modules land.`,
  },
]

phase('Build')
log(`Launching ${BUILDERS.length} builders in parallel`)
const reports = await parallel(BUILDERS.map((b) => () =>
  agent(`${PREAMBLE(b.key, b.files)}\n\n---\n\n${b.prompt}`, {
    label: `build:${b.key}`,
    phase: 'Build',
    schema: REPORT,
    effort: 'high',
  }).then((r) => (r ? { key: b.key, ...r } : null))
))
const ok = reports.filter(Boolean)
const failed = BUILDERS.filter((b, i) => !reports[i]).map((b) => b.key)
if (failed.length) log(`Builders that returned nothing: ${failed.join(', ')}`)

phase('Integrate')
const reportText = ok.map((r) => `### ${r.key}\nFiles: ${r.files.join(', ')}\nSummary: ${r.summary}\nContract notes: ${r.contract_notes}\nKnown issues: ${(r.known_issues || []).join(' | ') || 'none'}\nPerf: ${r.perf_notes}\nScreenshots: ${(r.screenshots || []).join(', ')}`).join('\n\n')

const integration = await agent(`You are the INTEGRATOR / lead engineer for MIDNIGHT APEX, a hyper-realistic NFS-inspired night street-racing demo (three.js r186 + Vite, plain JS). Project root: ${ROOT}. Read CONTRACTS.md and src/config.js first. Seven builder agents just finished their modules in parallel (reports below${failed.length ? `; NOTE these builders failed and their module may still be a stub: ${failed.join(', ')} — implement those yourself to the contract's quality bar` : ''}). You now own EVERY file and must turn the parts into one polished, fully playable game.

Builder reports:
${reportText}

Do, in order:
1. Static pass: read src/main.js + src/core/* and check every call into each module against that module's ACTUAL exports and signatures (not just the contract) — fix mismatches on whichever side is wrong. Check sign conventions end-to-end (heading/forward/right, steer +1 = right ⇒ heading decreases, track lateral + = right, car local +X = left, wheel steer direction, pitch/roll signs) — a mirrored steering or wheels turning the wrong way is a critical bug.
2. \`cd ${ROOT} && npx vite build\` must succeed with no errors.
3. Runtime: dev server http://127.0.0.1:5391/ (start it if down: \`(npx vite --port 5391 --strictPort >/tmp/claude-501-vite-int.log 2>&1 &)\`; never use port 5173). Use scripts/shot.mjs (see CONTRACTS.md "Test harness") and LOOK at screenshots with Read:
   a. Menu screen loads with zero console errors/warnings of consequence (fix shader compile errors, missing uniforms, NaNs, 404s).
   b. Press Enter → intro → countdown → racing. Drive manually with key holds (W, A/D, Space, ShiftLeft) and verify the car accelerates, steers the RIGHT way (D turns right on screen), drifts with handbrake, nitro works, barrier collision pushes back with sparks, camera behaves (C cycles), R resets.
   c. Full race: ?autostart=1&autopilot=1&laps=1&timescale=3&mute=1 — the race must finish and show results; AI cars must complete laps and not get stuck on walls or each other (check __game.getTelemetry() periodically).
   d. Default 3-lap settings must also be correct (lap counter, positions, best lap).
   e. Performance: at 1920x1080 (--width 1920 --height 1080) quality high, measure {"fps":4000} during racing and renderer.info.render.calls / triangles (expose via telemetry or debug overlay). Target 60 fps; if well below, profile and cut cost (shadow map size/frustum, reflection RT resolution and what it renders, particle counts, bloom resolution, pixel ratio, draw-call merging) while preserving the look. Make quality 'low' clearly cheaper.
4. Visual sanity pass on 4–6 in-race screenshots (start grid, straight at speed with nitro, a corner, near opponents, rain/spray, results): fix glaring problems (black/blown-out frames, z-fighting, floating cars, missing reflections, buildings on the road, unreadable HUD).
5. Write ${ROOT}/README.md: what it is, how to run (npm install, npm run dev → http://127.0.0.1:5391), controls, URL params, architecture/module map, tech highlights.
Keep the existing division into modules; prefer surgical fixes over rewrites. Do not add dependencies.

Return the structured report — be honest about anything still broken or weak; list the top remaining polish opportunities ranked by visual/feel impact, each tagged with the file(s) involved.`, {
  label: 'integrate',
  phase: 'Integrate',
  effort: 'high',
  schema: {
    type: 'object',
    properties: {
      build_ok: { type: 'boolean' },
      full_race_ok: { type: 'boolean', description: 'autopilot race reaches results screen' },
      manual_driving_ok: { type: 'boolean' },
      fps_1080p_high: { type: 'number' },
      draw_calls: { type: 'number' },
      fixes_made: { type: 'array', items: { type: 'string' } },
      remaining_issues: { type: 'array', items: { type: 'string' } },
      polish_opportunities: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, files: { type: 'string' }, impact: { type: 'string' } }, required: ['item', 'files', 'impact'] } },
      screenshots: { type: 'array', items: { type: 'string' } },
    },
    required: ['build_ok', 'full_race_ok', 'manual_driving_ok', 'fixes_made', 'remaining_issues', 'polish_opportunities'],
  },
})

return { builders: ok, failed, integration }
