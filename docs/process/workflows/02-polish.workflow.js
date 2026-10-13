export const meta = {
  name: 'midnight-apex-polish',
  description: 'Targeted polish pass: 4 parallel module polishers (world, car, fx, gameplay) then a final regression/verification agent',
  phases: [
    { title: 'Polish', detail: 'world, car, fx, gameplay polishers with disjoint file ownership' },
    { title: 'Verify', detail: 'build, full race, perf, screenshot regression pass' },
  ],
}

const ROOT = '/Users/boozybats/Public/Repos/work/genex-stage1-game'

const ISSUES = `Lead's playtest review (screenshots in ${ROOT}/shots/review/ — LOOK at the ones referenced with the Read tool):
1. SPEED-BLUR GHOSTING — at 180+ km/h the radial speed blur produces discrete magnified "ghost" copies of the player car below/around it (a-speed.png bottom centre, sheet2.png top-right). [fx]
2. WET-ROAD MIRROR TOO PERFECT — the player's own car is mirrored crisply on the road right behind/below it with readable mirrored livery text (sheet3.png bottom-left, a-speed.png). Real wet asphalt at that view angle reflects bright lights strongly but dark/diffuse objects only weakly and blurrily (Fresnel ~2-5% looking down near the camera). [world]
3. NITRO FLAME REFLECTIONS — during nitro, 4 huge bright blue blobs/streaks are reflected on the road under the car (a-nitro.png, sheet2.png bottom-right, sheet3.png bottom-left). Flames should not render into the planar reflection at all (LAYERS.NO_REFLECTION) and the flame itself should be less of a bloom bomb. [car, fx, world]
4. STEAM PLUMES = WHITE WALLS — manhole steam plumes render as huge opaque white columns/clouds; driving through one fills a third of the screen with white (a-nitro.png left third, b-cam3.png right). They should be wispy, translucent, lit/tinted by neon & streetlights, fade near the camera. [world]
5. HEADLIGHT BEAM ON ROAD — in bumper/hood view the headlight pool on the road is a hard-edged bright "bat-wing" shape (b-cam3.png). Needs a soft, realistic low-beam pattern (soft falloff, soft cutoff, slight asymmetry), consistent with the real SpotLights (consider SpotLight.map light cookie + wider penumbra) and not over-bright. [car]
6. HOOD CAM PAINT — in hood view the hood shows big blocky flat-colour rectangles in the paint reflection and a pixelated livery stripe (b-cam2.png). From hood cam it must look premium: smooth reflections, crisp livery (anisotropic filtering, higher-res decal), sensible camera placement. [car (+ core camera placement)]
7. HEADLIGHT GLARE ON CARS AHEAD — the player's headlights blow the rear of a car a few metres ahead (esp. the white GHOST livery) out to pure white with bloom + anamorphic streak (z2.png, b-t16.png). A lit car ahead should look lit, not nuked. [core headlight cap logic, car materials]
8. BUILDINGS UP CLOSE — street-level facades read flat and procedural: blocky/pixelated far window mosaics (z1.png background), blurry storefront textures, no depth in windows, facades not lit by the streetlights. Add window frames/mullions + cheap interior-parallax or depth illusion, better mip/far-field treatment, a warm/cool street-light wash on lower floors facing the road. [world]
9. GAMEPLAY — no launch-window indicator (perfect launch is an invisible mechanic); AI-only racing is a procession (no AI-vs-AI position changes). [core, hud, dynamics]
Already good (do NOT regress): overall look, wet road light streaks, HUD/menus/results, track layout, 60 fps at 1080p, full race flow.`

const PREAMBLE = (role, files) => `You are the **${role} polisher** for MIDNIGHT APEX, a hyper-realistic NFS-inspired night street racer (three.js r186 + Vite, plain JS, everything procedural). Project root: ${ROOT}. The game is built, integrated and fully playable; this is a targeted POLISH pass by four agents in parallel.

Read first: ${ROOT}/CONTRACTS.md (esp. the new "Render layers" section at the end) and ${ROOT}/README.md, then the source of the files you own.

${ISSUES}

Rules:
- ONLY modify files you own: ${files}. Others are being edited concurrently. Never edit src/config.js, CONTRACTS.md, package.json. Public APIs used by other modules must stay backward-compatible (you may add optional members).
- New shared convention: \`import { LAYERS } from '../config.js'\` — \`LAYERS.NO_REFLECTION = 3\`. Objects that must not appear in the wet-road reflection: \`obj.layers.set(LAYERS.NO_REFLECTION)\`. Core enables that layer on game cameras; world masks it out of the reflection camera.
- Dev server: http://127.0.0.1:5391/ (if down: \`cd ${ROOT} && (npx vite --port 5391 --strictPort >/tmp/claude-501-vite-$RANDOM.log 2>&1 &)\`; never port 5173). Do not run \`vite build\` (concurrent agents). Use \`node --check\` + the screenshot harness (\`node scripts/shot.mjs\`, see CONTRACTS.md "Test harness"; e.g. \`--url 'http://127.0.0.1:5391/?autostart=1&autopilot=1&mute=1' --width 1600 --height 900 --wait 9000 --steps '[{"wait":6000},{"shot":"x"},{"press":"KeyC"},...]'\`; window.__game.getTelemetry() has drawCalls/fps). Put your screenshots under shots/polish-${role}-*. LOOK at before/after screenshots with Read and iterate until the issue is genuinely fixed. Pages may hot-reload when others save — rerun.
- Keep 60 fps at 1080p: don't add draw calls/passes casually; report cost changes.
- Fix the ROOT cause, verify visually, don't regress what's good.

Reply with the structured report.`

const REPORT = {
  type: 'object',
  properties: {
    issues_addressed: { type: 'array', items: { type: 'object', properties: { issue: { type: 'string' }, fix: { type: 'string' }, verified: { type: 'boolean' } }, required: ['issue', 'fix', 'verified'] } },
    other_improvements: { type: 'array', items: { type: 'string' } },
    files_changed: { type: 'array', items: { type: 'string' } },
    cross_module_notes: { type: 'string', description: 'anything another module/integrator must do or know' },
    perf_impact: { type: 'string' },
    remaining: { type: 'array', items: { type: 'string' } },
    best_screenshots: { type: 'array', items: { type: 'string' } },
  },
  required: ['issues_addressed', 'files_changed', 'cross_module_notes', 'perf_impact', 'remaining'],
}

const POLISHERS = [
  {
    key: 'world',
    files: 'src/world/*.js, dev/world.html',
    prompt: `Your issues: #2 (wet-road mirror realism), #3 (world side: reflection camera must exclude LAYERS.NO_REFLECTION — in src/world/reflection.js the virtual camera currently copies camera.layers.mask; mask that layer out; also cap the bright-source reflection boost so very hot sources like flames/headlights can't produce giant blobs), #4 (steam plumes), #8 (buildings up close).
For #2: apply a proper Fresnel (Schlick, F0 ≈ 0.02–0.04 for water/wet asphalt, puddles higher sharpness) to the planar reflection term, so near-field looking-down reflections are weak and grazing ones strong; make reflections of non-emissive/dark content noticeably blurrier and lower-contrast (e.g. luminance-dependent: bright HDR sources keep their streak, mid/dark tones get attenuated & softened), so the player's car mirror image becomes a subtle dark soft smear with its tail-light streaks — not a readable mirror. Keep the signature neon streaks and puddle mirrors further away. Also soften puddle mask edges (#integrator note: puddles reflecting uniform glows read as flat coloured patches).
For #8 keep draw calls flat (shader work in the existing city material; facade detail via procedural shader/texture, not geometry per window).
Check views: chase cam on the boulevard at speed, the waterfront, the overpass, low bumper cam near facades, high intro/menu shots.`,
  },
  {
    key: 'car',
    files: 'src/vehicle/carModel.js, src/vehicle/carBody.js, src/vehicle/carParts.js, src/vehicle/carTextures.js, any src/vehicle/car*.js, dev/car.html',
    prompt: `Your issues: #3 (car side: put nitro/exhaust flame meshes and the road beam decal on LAYERS.NO_REFLECTION; make the flame a believable blue shock-diamond cone that doesn't flood bloom), #5 (realistic soft headlight low-beam pattern: improve the additive road decal AND the player's SpotLights — e.g. SpotLight.map cookie texture with a soft cutoff line, penumbra ~0.7–0.9, sensible intensity/decay — check in chase-far, chase-near, hood and bumper cams in game: \`press KeyC\` cycles cams), #6 (hood-cam paint: find why the hood shows blocky flat-colour rectangles — env map resolution/mip, flake normal map, clearcoat normal, low-res livery canvas, missing anisotropy (renderer.capabilities.getMaxAnisotropy()) — and fix so the hood looks like glossy premium paint with crisp livery), #7 (car side: make sure paint/glass/chrome don't produce extreme HDR highlights from the player's headlights — e.g. clamp or tone the specular response; coordinate with core, which caps the headlight intensity — note what you changed).
If the hood camera should sit somewhere else, expose an optional \`cockpit\` / \`hoodCamLocal\` hint on the CarModel and describe it in cross_module_notes (core's camera.js already calibrates hood/bumper placement by ray-casting the body; core polisher owns that file).`,
  },
  {
    key: 'fx',
    files: 'src/fx/postfx.js, src/fx/particles.js, src/fx/rain.js, any src/fx/*.js, dev/fx.html',
    prompt: `Your issues: #1 (speed-blur ghosting: per-pixel jittered tap offsets (interleaved gradient noise, varying per frame), more/cheaper taps, smooth weighting, and protect the player-car region — default soft elliptical mask around the chase-cam car position (bottom-centre, ~u 0.5, v 0.3–0.4 from bottom) with an optional \`set({ focus: [u, v], focusRadius })\` override core can drive; blur should mostly affect the periphery like NFS), soft particles (integrator's top fx item: give the RenderPass target a DepthTexture and fade smoke/spray/mist where they intersect geometry so puffs stop slicing through car bodies — expose what's needed; keep cost low), #3 fx side (nitro flame particles and sparks on LAYERS.NO_REFLECTION; tone flame HDR so bloom stays tasteful), rain/spray on LAYERS.NO_REFLECTION if they currently render into the reflection, and make sure the player's own spray never forms a big opaque white cloud in front of the camera (check a-nitro.png — determine whether that cloud is fx spray/smoke or the world's steam plume; if it's fx, fix it; if it's steam, note it for world).
Also review the anamorphic streak strength on non-emissive glare (it currently turns headlight-lit paint into wide white streaks) — it should be reserved for genuinely hot emissive sources.`,
  },
  {
    key: 'gameplay',
    files: 'src/main.js, src/core/*.js, src/ui/*, src/vehicle/physics.js, src/vehicle/ai.js, src/audio/*.js',
    prompt: `Your issues: #7 core side (headlight cap: a car 3–15 m ahead inside the beam — especially white livery — must look lit but never blown out; e.g. stronger per-target cap for cars, distance-based intensity, check with the GHOST car ahead using ?ai=4 at the start/T1), enable LAYERS.NO_REFLECTION on every game camera (all modes + cinematic cams) — required for the new layer convention, #6 core side (hood camera placement/fov: after the car polisher's changes, make hood cam look like a real hood cam: low, hood visible at bottom ~15–20% of frame, steady), #9 gameplay:
 - Launch control made visible: during the countdown show a launch-window band on the tachometer (HUD) and on GO show "PERFECT LAUNCH" / "GOOD LAUNCH" flashes (core decides from rpm at GO); the existing launch boost logic lives in core.
 - AI racecraft (ai.js): per-lap pace variation, occasional small mistakes (late braking, running a bit wide), driver personalities (aggressive vs defensive lines), so AI cars swap positions among themselves during a 3-lap race — while still finishing cleanly without wall hits or pile-ups. Re-run the dynamics Node tests (dev/*.mjs) + a full in-game autopilot race (?autostart=1&autopilot=1&laps=3&timescale=3&mute=1) to confirm.
 - Feel sanity check with scripted keyboard driving: steering response, drift entry/exit, brake to slow for 90° corners — adjust only if clearly off. Default difficulty: a decent keyboard player should be able to win in 1–3 attempts.
 - Audio mix sanity (can't listen — reason about levels): music should sit under the engine; rain ambience subtle; make sure nothing is clipping (master limiter) — only change if clearly unbalanced.
If after the car polisher changes the hood cam calibration breaks, fix it on your side.`,
  },
]

phase('Polish')
const results = await parallel(POLISHERS.map((p) => () =>
  agent(`${PREAMBLE(p.key, p.files)}\n\n---\n\n${p.prompt}`, { label: `polish:${p.key}`, phase: 'Polish', schema: REPORT, effort: 'high' })
    .then((r) => (r ? { key: p.key, ...r } : null))
))
const done = results.filter(Boolean)
const missing = POLISHERS.filter((p, i) => !results[i]).map((p) => p.key)
if (missing.length) log(`Polishers that returned nothing: ${missing.join(', ')}`)

phase('Verify')
const summary = done.map((r) => `### ${r.key}\nAddressed: ${r.issues_addressed.map((i) => `${i.issue} → ${i.fix} (verified: ${i.verified})`).join(' | ')}\nOther: ${(r.other_improvements || []).join(' | ')}\nFiles: ${r.files_changed.join(', ')}\nCross-module notes: ${r.cross_module_notes}\nPerf: ${r.perf_impact}\nRemaining: ${r.remaining.join(' | ')}\nScreens: ${(r.best_screenshots || []).join(', ')}`).join('\n\n')

const verify = await agent(`You are the final VERIFIER / release engineer for MIDNIGHT APEX (three.js r186 + Vite, plain JS) at ${ROOT}. You own every file now. Four polishers just worked in parallel on disjoint files to fix these review issues:

${ISSUES}

Their reports:
${summary}
${missing.length ? `\nThese polishers returned nothing (their issues may be unaddressed): ${missing.join(', ')}` : ''}

Do:
1. Resolve every cross-module note above (e.g. a camera that doesn't enable LAYERS.NO_REFLECTION, a new optional API one side added that the other side should call). grep for consistency.
2. \`cd ${ROOT} && npx vite build\` — must pass cleanly.
3. Runtime regression pass on the dev server http://127.0.0.1:5391/ (restart if down: \`(npx vite --port 5391 --strictPort >/tmp/claude-501-vite-ver.log 2>&1 &)\`; never port 5173) using scripts/shot.mjs at 1600x900 and LOOK at screenshots: menu; countdown (launch band visible); GO (launch flash); chase cam at 200+ km/h with nitro (no ghosting, no flame-reflection blobs, no white steam walls); all 4 camera modes (hood cam looks right, beam pattern soft); behind the white GHOST car with headlights (no blow-out); a drift (smoke soft, no slicing); a street-level facade close-up; results screen. Zero console errors.
4. Full race: ?autostart=1&autopilot=1&laps=3&timescale=3&mute=1 must finish with all cars, plausible lap times, and AI position changes; also a 1-lap run with quality=low.
5. Performance: 1920x1080 quality high: {"fps":4000} during racing must be ~60 with vsync; also measure --uncapped headroom and draw calls; compare with the pre-polish baseline (≈160 fps uncapped in motion, 260–340 draw calls). If polish cost too much, optimise without losing the look.
6. Fix any regression you find (surgical). Update README.md (features/controls if changed, e.g. launch control) and the "Integration notes" in CONTRACTS.md.

Return the structured report — honest, with the best final screenshots for a showcase (menu, racing at speed, nitro, corner/drift, rain/neon wet street, results).`, {
  label: 'verify',
  phase: 'Verify',
  effort: 'high',
  schema: {
    type: 'object',
    properties: {
      build_ok: { type: 'boolean' },
      full_race_ok: { type: 'boolean' },
      fps_1080p_vsync: { type: 'number' },
      fps_1080p_uncapped: { type: 'number' },
      draw_calls: { type: 'string' },
      issue_status: { type: 'array', items: { type: 'object', properties: { issue: { type: 'string' }, status: { type: 'string', enum: ['fixed', 'improved', 'not_fixed'] }, note: { type: 'string' } }, required: ['issue', 'status', 'note'] } },
      regressions_fixed: { type: 'array', items: { type: 'string' } },
      remaining_issues: { type: 'array', items: { type: 'string' } },
      showcase_screenshots: { type: 'array', items: { type: 'string' } },
    },
    required: ['build_ok', 'full_race_ok', 'issue_status', 'regressions_fixed', 'remaining_issues', 'showcase_screenshots'],
  },
})

return { polish: done, missing, verify }
