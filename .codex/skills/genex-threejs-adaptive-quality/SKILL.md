---
name: genex-threejs-adaptive-quality
description: Make a Genex Three.js game phone-survivable with the vendored adaptive-quality kit — device-tier detection, tier-budgeted renderer settings, a runtime governor that steps quality down before phones run out of memory, per-tier asset rungs for generated skyboxes/textures, and a Quality picker in settings. Load for every game at boot wiring time, and whenever a game is heavy, crashes on phones, or gets flagged desktop-only.
---

# Genex Three.js Adaptive Quality

Phones enforce a hard GPU-memory ceiling desktops don't have: iOS silently
kills the page when a game allocates too much, and the kill arrives at BOOT —
exactly when textures, models, and the post stack all decode at once. This
skill wires the vendored quality kit so the game boots conservatively on
phones, steps quality UP when the device proves smooth, and never gets uglier
on desktop. **You can recover from ugly; you cannot recover from a killed
page.**

This is a completion gate like the post stack: every game wires the tier at
boot before it is called done. It costs three lines, not a testing burden —
you still verify on desktop only.

## Arriving here because a phone stutters? Rule out audio first

Not every mobile performance problem is a rendering problem, and one impostor
costs whole afternoons — shadows, bloom, draw calls, physics and memory all get
investigated before anyone looks at the sound. Read these three symptoms
together before you touch a single quality knob:

- it only happens **while moving** (or while some value is continuously changing),
- it is **identical at every quality setting**, including the lowest,
- **desktop is fine.**

That is the signature of an `<audio>` element being written to every frame — on
iPhone each `.volume`/`.playbackRate` write is a call into another process. The
one-second confirmation: **the music plays throughout and costs nothing**, because
music's volume and pitch never change, so nothing is ever written to it. Same
object, same code path, opposite cost. `$genex-ai-sfx` has the fix and the
WebAudio recipes; nothing in this skill will help.

Genuine graphics symptoms look different: a quality setting changes it, it is
worse when more is on screen, and it degrades over minutes (thermal) rather than
tracking one input.

## Install

```bash
npx genex controller quality
```

Installs `src/controllers/quality/{tier.ts, governor.ts, pick-asset.ts,
gltf-loader.ts, depth.ts, context-loss.ts}` — game-owned code, edit freely — plus the KTX2 basis
transcoder (`basis_transcoder.js` + `.wasm`) into `public/assets/` (loaded by
path at runtime; Vite would drop it anywhere else).

## Wire the tier at boot (before renderer construction)

```ts
import { detectTier, rendererAntialias } from "./controllers/quality/tier.ts";
import { QualityGovernor } from "./controllers/quality/governor.ts";
import { depthRendererOptions, cameraNearFar } from "./controllers/quality/depth.ts";
import { attachContextLossGuard } from "./controllers/quality/context-loss.ts";

const tier = detectTier(); // phone-low | phone | desktop-low | desktop; manual Quality setting wins
// Context MSAA is WASTED under an EffectComposer (it multisamples a buffer the
// composer never reads — the classic weak-MacBook lag recipe). Games with a
// post stack pass willRunPost=true and get their AA from the composer target.
// The same options object works on WebGPURenderer — the kit assumes no backend:
const renderer = new THREE.WebGLRenderer({
  antialias: rendererAntialias(tier, true),
  ...depthRendererOptions(), // reversed-Z: distant surfaces stop z-fighting, early-Z kept
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, tier.dprCap));
// Shadows: PCF, never PCFSoft. three r186 REMOVED PCFSoftShadowMap; it warns
// once and downgrades on the first shadow pass — and with the static-scene
// rule (shadowMap.autoUpdate = false) that pass comes after your materials
// compiled, so the driver rejects every shadow-receiving draw call and the
// world is an empty fog behind a working HUD (measured 2026-09-11 on a
// published village). Mechanism + console check: $genex-threejs-shadow-systems.
renderer.shadowMap.enabled = tier.shadowMapSize > 0;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;  // static scene: re-render shadows on demand (needsUpdate = true when casters move)
renderer.shadowMap.needsUpdate = true;  // primed: the maps exist before any receiver draws (2 rejected boot frames otherwise)
// Camera range comes from the WORLD, never from a docs example (0.1/1000):
const { near, far } = cameraNearFar({ closest: 1.5, farthest: 800 });
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, near, far);
// With post: AA comes from the composer's multisampled target instead —
const target = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { samples: tier.composerSamples });
const composer = new EffectComposer(renderer, target);
// GPU context loss (phones revoke contexts under memory pressure): pause,
// resume on restore — the guard owns the fiddly event rules for both backends.
attachContextLossGuard(renderer, { pause: () => (running = false), resume: () => (running = true) });
```

`detectTier()` also demotes WEAK desktops (Intel iGPU MacBooks, old integrated
AMD — desktop GPU strings are unmasked, unlike iOS) to `desktop-low`: DPR 1.5,
no MSAA, 1024 shadows, light post. The Quality picker still overrides.

## Depth precision (z-fighting)

Flickering surfaces have two causes; `depth.ts` owns the first and names the
second:

- **Camera range.** Depth precision at distance z is ~`z² / (near × 2²⁴)` —
  `near` is the expensive knob, and the pasted `0.1 / 1000` that silently grows
  to `0.1 / 100000` is how most games get horizon flicker. Derive the pair with
  `cameraNearFar({ closest, farthest })` (closest the camera truly gets; edge of
  the world), and re-range with `applyDepthRange(camera, …)` when the world
  grows. `...depthRendererOptions()` in the renderer constructor adds
  reversed-Z on top: near→1/far→0, so distant geometry lands in the float-dense
  end. Native on WebGPU; on WebGL three gates it on `EXT_clip_control` and
  falls back to the standard buffer with a console line, so spreading it is
  never worse. Three's materials and `packing.glsl` helpers are reversed-aware;
  only a post pass doing hand-rolled depth math (custom SSAO/DoF/soft
  particles) needs verifying — pass `{ depthReadingPost: true }` to opt out
  until you have. `logarithmicDepthBuffer` is NOT the default fix: it disables
  early-Z rejection (the optimization phone survival leans on) — planetary
  ranges only, recorded in DESIGN.md.
- **Two opaque surfaces sharing a plane** — road quad at the ground's exact y,
  decal flush on a wall. No renderer flag can fix that: give them a real gap
  (1–2 mm indoors, ~1 cm at city scale), or let the decal win with
  `polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1` (+
  `depthWrite: false` for flat stickers). `$genex-threejs-visual-validation`
  ships a console scanner that lists the exact offending pairs;
  `$genex-threejs-procedural-assets` carries the authoring rule.

The tier owns every budget decision: `dprCap` (1.5 on phones — the single
biggest framebuffer lever), `antialias` (off on phones; it is fixed at context
creation and can never change live), `shadowMapSize` (1024 phone / 2048
desktop), `postLevel` (`'light'` = tone mapping + cheap passes on phones;
`'full'` = the named stack on desktop), `particleScale`, `drawDistanceScale`,
`frameCap`, and `remoteAvatarCap` for multiplayer. The exact ladder and which
knobs may change at runtime vs load time vs never: [references/adaptive-quality.md](references/adaptive-quality.md).

## Wire the governor (runtime — phones throttle over minutes)

```ts
const governor = new QualityGovernor(tier, {
  setDprScale: (m) => renderer.setPixelRatio(Math.min(window.devicePixelRatio, tier.dprCap * m)),
  setPostEnabled: (on) => (composerEnabled = on),
  setShadowQuality: (level) => {
    sun.shadow.mapSize.setScalar(level === 'full' ? tier.shadowMapSize : tier.shadowMapSize / 2);
    sun.shadow.map?.dispose(); sun.shadow.map = null; // realloc at the new size
  },
  setDrawDistanceScale: (m) => (scene.fog!.far = baseFogFar * tier.drawDistanceScale * m),
  setFrameCap: (fps) => (frameCap = fps), // 0/undefined-safe: tier.frameCap restores it
}, renderer);

// In the render loop, with the same performance.now() delta the loop already
// computes. Wire ALL the callbacks — every omitted one is a governor rung
// that silently no-ops. The frame cap paces inside setAnimationLoop:
let frameCap = tier.frameCap, lastFrame = 0;
renderer.setAnimationLoop((t) => {
  if (frameCap < 60 && t - lastFrame < 1000 / frameCap - 1) return; // skip: stable 30 > stuttery 45
  const deltaMs = lastFrame ? t - lastFrame : 16;
  lastFrame = t;
  governor.frame(deltaMs);
  // ...update + render
});
```

Sustained slow frames step down (DPR ×0.8 → post off → shadows reduced →
DPR ×0.65 → draw distance → 30 fps cap); twenty smooth seconds step back up; a
knob whose recovery failed twice stays down for the session. It keeps governing forever — thermal throttling
arrives at minute eight, not second thirty. It also pauses judgment when the
tab is hidden and publishes memory counts the platform's crash telemetry
reads; pause your own loop and audio on `visibilitychange` too.

## Generated assets: load through the rungs

A generated texture original can be several thousand pixels square — a handful
of them decode into more memory than a phone has. Every generated image asset
ships with downscale rungs; phones must load through them:

```ts
import { detectTier } from "./controllers/quality/tier.ts";
import { loadTextureWithFallback } from "./controllers/quality/pick-asset.ts";

const texture = await loadTextureWithFallback(TEXTURE_URL, tier, (u) =>
  new THREE.TextureLoader().loadAsync(u),
);
```

Desktop loads the original, phones the small rung, and a missing rung falls
back to the original — never a broken boot. The `$genex-ai-texture` skill
shows the wiring in place.

The sky costs nothing here: it is built in code, so there
is no panorama to download, no rung ladder, and no boot-time decode. Games
carrying a generated equirect sky predate that and still load through the
`skybox-equirect` rungs the kit resolves for them.

## Generated models: load through the rungs

Provider-raw GLBs are NOT game assets: one prop is ~500k triangles + several
4K PBR textures (a pilot scene of them submitted 66M triangles/frame and
floored an M4 Max). Every model ships a game-ready ladder — `@2048` (the
desktop rung) and `@1024` (the phone rung), both meshopt-compressed and
simplified where safe, each with a `.ktx2` sibling whose textures stay
compressed ON the GPU (~6× less texture VRAM). A plain `GLTFLoader` can decode
none of them — wire the decoders once and load through the ladder:

```ts
import { createGltfLoader } from "./controllers/quality/gltf-loader.ts";
import { loadModelWithFallback } from "./controllers/quality/pick-asset.ts";

const gltfLoader = createGltfLoader(renderer); // meshopt always; KTX2 when the transcoder is present
const gltf = await loadModelWithFallback(
  MODEL_URL, tier, (u) => gltfLoader.loader.loadAsync(u), { ktx2: gltfLoader.ktx2 },
);
// Provider PBR sometimes ships mirror-metal (metalness~1 + near-zero roughness)
// that reflects the sky env and swims with camera motion. Tame ONLY that extreme
// — do NOT flatten every material to 0.6 (it dulls legitimately metallic props):
gltf.scene.traverse((o) => {
  const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
  if (!m?.isMeshStandardMaterial) return;
  if (m.metalness > 0.85 && m.roughness < 0.2) {
    m.metalness = 0.7;
    m.roughness = Math.max(m.roughness, 0.3);
  }
  m.envMapIntensity = Math.min(m.envMapIntensity, 0.8);
});
```

Fallback chain: `.ktx2` rung → the tier's universal rung (`@2048` desktop,
`@1024` phones) → original — each step warns; the original is archival/remix
source, fetched only as the fallback of last resort. Meshy characters take
the same ladder through
`loadMeshyCharacter(manifestUrl, { loader: gltfLoader.loader, modelUrlCandidates: (u) => [pickModel(u, tier, { ktx2: gltfLoader.ktx2 }), pickModel(u, tier), u] })`.
KTX2-capable games can also pass `ktx2Load` to `loadTextureWithFallback` so
textures use their `.ktx2` variants.

**A texture that arrived through a `.ktx2` rung is NOT drawable.** Its `.image`
is `{ width, height, mipmaps }`, never an `HTMLImageElement` — so
`ctx.drawImage(tex.image, …)` throws *"The provided value is not of type
'(CSSImageValue or HTMLCanvasElement or …)'"*. MEASURED 2026-09-07: a village
build wrote its own `capTextures()` pass to cap every texture's long edge and
cast `tex.image as CanvasImageSource` to silence the type error. All ten of its
generated buildings and both villager bodies then failed to load behind a
swallowed warning — a fully generated, fully wired world that rendered EMPTY,
and scored 1/9 with the assets sitting in R2. **Do not hand-roll a texture
downscaler: the rungs ARE the downscaler**, and `@1024` already did it before
the bytes left our side. If you must touch pixels, skip the compressed ones
first — `if ((tex as THREE.CompressedTexture).isCompressedTexture) return;`.

Every generated GLB ladders — `genex model` including its `segment` / `rig` /
`animate` outputs, and generated characters. If `pickModel` hands a generated
model URL back unchanged, this game's vendored kit predates that role: the
quality kit is copied into the game ONCE and is yours from then on, so it
never updates itself. Re-vendor it with `npx genex controller quality --force`
(that overwrites the kit files — keep your own edits, if any, before running
it), and the ladder starts resolving for those models.

## Quality picker in settings

The pause/settings screen (see `$genex-threejs-game-ui`) always carries a
Quality entry: **Auto / Low / Medium / High**, wired to
`setQualitySetting(...)` from `tier.ts` + a reload or re-tier. Persisted
per-device in localStorage on purpose — quality is a property of the phone,
not the player's account. Default Auto.

## Budgets that ride the tier (not separate rules)

- Shadows: `tier.shadowMapSize`, `shadow.autoUpdate = false` for static scenes,
  at most 2 cascades on phones, and `shadowMap.type = THREE.PCFShadowMap` —
  PCFSoft was removed in three r186 and, together with `autoUpdate = false`,
  blanks every shadow receiver (`$genex-threejs-shadow-systems` has the
  mechanism and the console check).
- Post: phone floor is a BUILT tone-mapping/output pass (`postLevel: 'light'`
  adds FXAA/vignette); SSAO, volumetrics, and DoF are desktop-tier only
  (`$genex-game-director`'s routing map owns the floor wording).
- Particles/scatter: multiply counts by `tier.particleScale`; render heavy
  transparency at half resolution and upsample.
- Animation: distant mixers update at 1/2–1/4 rate; multiplayer remotes above
  `tier.remoteAvatarCap` billboard instead of animating
  (`$genex-threejs-multiplayer`).
- Physics: phone tiers prefer hull/cuboid colliders for props — trimesh only
  where gameplay demands it (`$genex-threejs-physics-rapier`).
- Shaders: default `mediump` (iOS exception: float-texture sampling needs
  `highp sampler2D`); precompile with `renderer.compileAsync(scene, camera)`
  during the loader screen so first-frame jank doesn't read as a stall; skip
  max anisotropy on phones.
- Disposal: level swaps traverse the outgoing scene and dispose geometry,
  materials, AND textures (three never frees them for you); watch
  `renderer.info.memory` while testing — if textures/geometries climb across
  swaps, you leak toward the kill.

## WebGPU games

The scaffold ships WebGL and stays the default; if this project already uses
`WebGPURenderer`, keep it (never switch renderers mid-project) — the kit
assumes no backend. `...depthRendererOptions()` spreads into its constructor
identically (reversed-Z is native there, no extension gate), and
`createGltfLoader(renderer)` accepts it — construct the loader after `await
renderer.init()` so KTX2 probes the real backend. Context loss:
`attachContextLossGuard` handles both backends (WebGL DOM events; WebGPU's
one-shot `device.lost`, after which recovery is re-init — offer a reload via
`onWebGpuLost`). All tier knobs apply identically except `antialias` (WebGPU
MSAA is per-render-target and CAN change at runtime).

## Failure conditions

- Renderer constructed before `detectTier()` → context-creation knobs
  (antialias) are locked wrong for the session. Tier first, renderer second.
- Governor wired to context-creation flags → no-op at best. Runtime knobs
  only: DPR, post toggles, distances, frame cap.
- A generated texture loaded with a bare `TextureLoader.loadAsync(url)` on a
  game that targets phones → the full-size original decoded; route it through
  `loadTextureWithFallback`. (Same for the equirect sky of a game that predates
  the procedural sky lane — the `skybox-equirect` rungs still resolve.)
- Quality stepping on every spike → shader compiles read as slowness. The
  governor requires SUSTAINED slow windows; do not shorten them.
- Testing quality tiers by resizing the desktop window → tiers key off touch +
  OS, not viewport. Trust desktop verification plus the preflight report
  `genex preview` prints.
- Stepping quality down to chase a stutter the quality settings never change →
  that is the audio impostor above, and every rung you spend on it makes the
  game uglier without touching the cause.
