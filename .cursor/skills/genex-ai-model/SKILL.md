---
name: genex-ai-model
description: Generate a real 3D model (GLB mesh) from a text prompt or a reference image with `npx genex model`, then load it into the Three.js scene — and, when the game needs it, split it into named parts (`model segment`), or rig and animate any mesh (`model rig` / `model animate`, 7 body plans incl. quadrupeds, birds, snakes). Use for any concrete object as an actual mesh rather than a procedurally-coded shape.
---

# Genex AI · Model

Turn a text prompt into a real, game-ready **GLB** and drop it into the project.

## When to use this vs. procedural geometry

- **Use `npx genex model`** for a specific, recognizable object the player will
  look at — a barrel, a chair, a sword, a spaceship, an animal, a named
  building, the thing the request asked for. You get a real textured mesh, and
  this is the default route whenever code would not honestly make the object
  read as itself.
- **Use `$genex-threejs-procedural-assets`** for what is structural, repeated,
  distant, or parametric — modular kits, fences, walls, paving, terrain,
  anything placed many times with variation (editable, seeded, no GLB file) —
  and for a close-up object only when the code result meets the same bar and
  you have checked it in a capture. Mixing both in one scene is the normal way
  to build a detailed world.

**The output is a STATIC, unrigged mesh by default — no skeleton, no animation
clips.** A "wolf" or "guard" from this command can be posed and moved as one
object, but its limbs cannot animate out of the box. When the game needs more,
this same lane goes further: `npx genex model segment <id>` splits the mesh
into named parts (doors, magazines, turrets), and `npx genex model rig <id>` +
`npx genex model animate <rig-id> --preset walk` give any mesh a real skeleton
and motion — including body plans Meshy refuses (quadrupeds, birds, snakes,
fish, multi-legged things). See the sections below. For a biped-shaped enemy,
`npx genex creature` (real rig + the animation library) is still the default,
and `$genex-threejs-creatures` owns that split. The player's own character is
`$genex-ai-character`.

## Run

```bash
npx genex model "<prompt>"
```

Write a specific prompt — "weathered wooden barrel with rusted iron bands" beats
"barrel". The command blocks until the mesh is ready (up to ~a minute), then prints
its public URL:

```
https://assets.genex.technology/generations/<id>/model-glb
```

The GLB lives in Genex storage (R2) and loads straight from that URL. You **don't
download it** and **nothing is committed to your repo** — copy the URL the command
prints into your loader. The URL is permanent, so it works the same in local dev, your
published game, and remixes.

## From a reference image

```bash
npx genex model --image ./concept.png
npx genex model --image https://assets.genex.technology/generations/<id>/image-main
```

`--image` builds the model FROM a picture instead of a prompt — a user's
reference photo, a concept the image lane generated, a screenshot. A local file
(png/jpg/webp, ≤4 MB) is inlined automatically; a previous generation's asset
URL passes through. The prompt becomes optional (it's recorded for the ledger,
the provider works from the image alone). A clear, single-object image on a
plain background converts best.

## Bring your own mesh (`model import`)

A model the player already has — a Blender export, a bought asset, a file
from another tool — is **imported, never rebuilt**. Importing is free and
makes it a model of theirs, so every id-only lane works on it: `model rig`,
`model animate`, `model segment`, `blender import`, and "Use in game" on the
dashboard.

```bash
npx genex model import ./assets/hero-cart.glb
```

- `.glb` only (binary glTF 2.0), up to 64 MB. A `.gltf` + `.bin` pair or an
  FBX is exported as one `.glb` first — in Blender, File → Export → glTF 2.0
  with format "glTF Binary".
- The file is checked (magic, version, triangle geometry) before the row
  completes; a bad file is refused and nothing is charged.
- A humanoid that should walk goes through `$genex-ai-character`'s
  `character import` instead — same upload, plus a Uthana auto-rig.

## Split into parts (`model segment`)

```bash
npx genex model segment <model-generation-id> --granularity detailed
```

Takes a finished model generation's id and returns ONE new GLB whose meshes are
**named parts** — a rifle becomes body/magazine/scope, a car becomes
doors/wheels/chassis. What the parts are for is your call per game: detach a
magazine for a reload animation, swing a door on its own pivot, blow a turret
off a destructible tank, recolor one part.

```ts
const gltf = await loader.loadAsync(SEGMENTED_URL);
const magazine = gltf.scene.getObjectByName("magazine"); // names print on completion
```

`--granularity simple|balanced|detailed` sets how finely it splits (default
balanced). The provider owns the split and the part textures — ship its output
as-is; if a part comes back oddly textured, regenerate rather than patching
pixels. Part names print with the result when the provider reports them;
otherwise `traverse` the scene and read `child.name`.

## Rig and animate any mesh (`model rig` / `model animate`)

```bash
npx genex model rig <model-generation-id>            # body plan auto-detected (free check)
npx genex model rig <model-generation-id> --type quadruped
npx genex model animate <rig-generation-id> --preset walk
```

This is the route for **non-biped bodies that must move** — the lane Meshy
refuses. Seven body plans: `biped`, `quadruped`, `hexapod`, `octopod`, `avian`,
`serpentine`, `aquatic`. A free rig-check runs first: an unriggable mesh is
refused and auto-refunded before anything is charged.

`model animate` retargets ready-made clips onto the rig (billed per clip).
Presets by plan — biped: `idle walk run dive climb jump slash shoot hurt fall
turn`; quadruped/hexapod/octopod: `walk`; serpentine/aquatic: `march`; avian
has a rig but no preset clips (drive its bones in code). Play the result like
any animated GLB:

```ts
const gltf = await loader.loadAsync(ANIMATED_URL);
const mixer = new THREE.AnimationMixer(gltf.scene);
mixer.clipAction(gltf.animations[0]).play(); // and mixer.update(dt) per frame
```

Honest limits, so you plan around them and never oversell: **no finger bones**
on any plan; presets are generic locomotion/action clips, not bespoke motion;
and this rig is a plain Tripo skeleton — it does NOT join the character lane's
manifest/controller system. The player's own body and biped enemies with the
full animation library stay on `$genex-ai-character` / `npx genex creature`.

## Models that point somewhere must face forward

Any model with a "front" the game aims — the hero the player controls, an **NPC that
walks toward or looks at players**, a turret, a vehicle — should face **forward**: its
front toward `+Z` (glTF's "looking forward"), so yaw/`lookAt` code points it correctly.
A hero whose nose points sideways — or an enemy that chases you while staring off to the
side — reads as broken at a glance.

- **In the prompt:** ask for it — e.g. `"...game-ready, facing forward, front toward +Z"`.
  Treat this as a hint, not a guarantee: generated meshes regularly come back rotated
  anyway, so the check below is never optional.
- **On load (always check — hero AND NPC):** if the GLB isn't `+Z`-forward, rotate it
  once. Wrap the model in a parent `Object3D` and put the correction on the child, so
  game code rotates the parent cleanly:
  ```ts
  const rig = new THREE.Object3D();
  gltf.scene.rotation.y = Math.PI / 2; // one-time facing correction — tune per model
  rig.add(gltf.scene);
  scene.add(rig); // move/rotate/lookAt `rig`, not gltf.scene
  ```
  Clones inherit the fix only if you clone the corrected child (or the whole rig) —
  never the raw `gltf.scene`.
- **Verify it, don't assume it.** Orientation **is** visible in a still — in your
  self-check screenshot confirm the hero faces its travel direction AND that NPCs driven
  by chase/aim code face their target (an enemy rotated 90° from its victim is this
  pipeline's most common visible bug). On an unpublished draft, capture real gameplay in
  local test mode (`?genex_local_test=1` on the dev server — the embed-auth skill's
  "Self-testing a draft" section); if you still can't capture gameplay, say so plainly
  instead of skipping the check silently.

## Load it into the scene

Load through the quality kit's decoder-wired loader and the model rung ladder
(`$genex-threejs-adaptive-quality`; `npx genex controller quality` installs
it). The bare URL is the provider-raw original — ~500k triangles + several 4K
PBR textures, archival/remix source, NOT a game asset (31 raw props once
floored an M4 Max). Every model ships a game-ready ladder instead: desktop
tiers load the `@2048` rung, phones the `@1024` rung (both meshopt-compressed
and simplified), and KTX2-capable games get the GPU-compressed sibling. R2
sends the right CORS headers, so cross-origin loading just works:

```ts
import { createGltfLoader } from "./controllers/quality/gltf-loader.ts";
import { loadModelWithFallback } from "./controllers/quality/pick-asset.ts";
import { detectTier } from "./controllers/quality/tier.ts";

const tier = detectTier(); // reuse the boot tier if you already have it
const gltfLoader = createGltfLoader(renderer); // once at boot — meshopt + KTX2
// the URL `npx genex model` printed:
const MODEL_URL = "https://assets.genex.technology/generations/<id>/model-glb";
const gltf = await loadModelWithFallback(
  MODEL_URL, tier, (u) => gltfLoader.loader.loadAsync(u), { ktx2: gltfLoader.ktx2 },
);
const model = gltf.scene;
// Tame ONLY the provider's mirror-metal artifact (metalness≈1 + near-zero
// roughness mirrors the whole sky env and swims with every camera move). Do
// NOT flatten every material to 0.6 — that was dulling legitimately metallic
// props (gunmetal, chrome, gold, polished stone). Clamp the extreme case only;
// leave everything else as authored.
model.traverse((o) => {
  const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
  if (!m?.isMeshStandardMaterial) return;
  if (m.metalness > 0.85 && m.roughness < 0.2) {
    m.metalness = 0.7; // still reads metallic, no longer a full mirror
    m.roughness = Math.max(m.roughness, 0.3);
  }
  m.envMapIntensity = Math.min(m.envMapIntensity, 0.8);
});
// If a model that SHOULD read metallic still looks dull, this clamp is not the
// cause — check the model against the brief and lift per-material as needed.
model.scale.setScalar(1); // tune to taste
model.position.set(0, 0, 0);
scene.add(model);
```

A missing rung falls back to the original automatically (each fallback warns —
never silent). Without the quality kit a plain
`new GLTFLoader().loadAsync(MODEL_URL)` still works, but every device pays for
the full original — phones included.

Never swallow a failed load silently: if you wrap a generated-asset load in a
`catch`, `console.warn` the asset name in it — your own self-check reads the
console, and a bare `.catch(() => null)` hides a missing model from you too.

**Copies**: one or two, `model.clone()` (clones share geometry/textures on the
GPU). **Three or more of the same model → `InstancedMesh`** — clones still cost
one draw call per mesh per copy; instancing renders all copies in one draw
call per source mesh:

```ts
// placements: THREE.Matrix4[] — one world transform per copy
const group = new THREE.Group();
gltf.scene.updateMatrixWorld(true);
const tmp = new THREE.Matrix4();
gltf.scene.traverse((o) => {
  const src = o as THREE.Mesh;
  if (!src.isMesh) return;
  const im = new THREE.InstancedMesh(src.geometry, src.material, placements.length);
  placements.forEach((p, i) => im.setMatrixAt(i, tmp.multiplyMatrices(p, src.matrixWorld)));
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = im.receiveShadow = true;
  group.add(im);
});
scene.add(group);
```

**Distance LOD** (open worlds / long sightlines): the rung ladder already ships
a lighter mesh — use the phone rung as the far level. One extra fetch; worth it
past ~25 m draw ranges, skip it in small arenas:

```ts
const far = await gltfLoader.loader.loadAsync(`${MODEL_URL}@1024`);
const lod = new THREE.LOD();
lod.addLevel(gltf.scene, 0);   // near: the tier's rung
lod.addLevel(far.scene, 25);   // far: phone rung — three swaps by camera distance
scene.add(lod);
```

For animated GLBs, drive `gltf.animations` with a `THREE.AnimationMixer`
(animated/skinned meshes can't instance — clone those).

**If the game has physics, give the model a collider** — a GLB added only to the
scene is a ghost: players and objects pass straight through it.
`$genex-threejs-physics-rapier` has the decision table
(`collidersFromObject(model, "hull")` is the default for props).

## Publish checklist (so players see the model)

- Load it from the **URL** the command printed — it's absolute and permanent, so it
  resolves the same in local dev, the published game, and remixes. Nothing to commit.
- Don't copy the GLB into `public/assets/` — generated assets live in R2, not the repo.

## Options

- `--image <path|url>` — build from a reference image (local file ≤4 MB, or a
  generated-asset URL); the prompt becomes optional.
- **Quality knobs** (Tripo H3.1; each is priced in the quote, choose per
  asset and say it in one line): `--texture standard|detailed|none` (detailed
  is the default and +10 credits over standard; `none` is geometry only, for
  something you texture in code), `--geometry detailed` (+20 — a hero prop
  the camera sits on; never for a crate), `--quad` (+5, quad-dominant mesh
  for anything you will deform or edit further; face limit ≤150000),
  `--low-poly` (+10, smart low-poly topology — the game-ready choice for
  props that appear in numbers; it holds `--face-limit` to 1000-20000,
  500-10000 with `--quad` — omit the flag to take 20000 — and runs a
  post-process after the mesh, so allow up to 30 minutes), `--parts` (+20, separated named parts at
  generation — cheaper than `model segment` when you know up front you need
  doors, wheels, magazines), `--face-limit <n>` (1000-2000000, default
  150000; the raw cap — the game still loads the @2048/@1024 rungs),
  `--auto-size` (real-world metres by AI estimate).
- `--granularity simple|balanced|detailed` — (`model segment`) part granularity.
- `--type <plan>` — (`model rig`) body plan; omit to let the free rig-check pick.
- `--preset walk[,run,…]` — (`model animate`) clips to retarget; billed per clip.
- `--no-wait` — enqueue and return immediately (won't print the URL; pick it up
  with `npx genex wait <id>`).
- `--api-url <url>` — override the API base (local dev).

## Troubleshooting

- **"Not authorized"** — run `npx genex init` first (in the project — it resolves this project's own CLI) (it writes your `GENEX_TOKEN`).
- **"Out of credits" (`insufficient_credits`)** — the account has no credits left for
  this model generation. Tell the user the facts the CLI printed: their balance, this
  generation's cost, and when their credits refill. Then offer to continue the build
  with a procedurally-coded placeholder (a simple Three.js primitive-based stand-in
  mesh) and mark the spot with `// TODO(genex): regenerate when credits refill` so
  the real asset is one command away later. Do not stop the session over this.
- **Refused by the build's asset allowance** (the command prints the allowance,
  what this build has spent, and this generation's price) — the build, not the
  account, is at its limit: every build has an asset allowance sized from the
  wallet, and this generation would take it past that. The wallet is not empty
  and nothing was charged, so this is not the out-of-credits case above and the
  placeholder-and-refill route is wrong here. Tell the user the numbers the CLI
  printed (`npx genex budget` shows them again) and ask whether to raise the
  allowance — only their explicit approval does: `npx genex budget --assets
  <credits> --user-approved`. While you wait, or if no answer comes, code-build
  the piece (`$genex-threejs-procedural-assets`) to the same bar and record
  `Generation: none — allowance` on its row. Never re-run the command hoping for
  a different answer, and never report this as being out of credits.
- **"Email not verified" (`email_verification_required`)** — generation credits
  unlock after the account's email is verified. Give the user the verify link the
  CLI printed, wait for them to confirm, then re-run the command.
- **The mesh looks low-detail / wrong** — make the prompt more specific
  (materials, style, parts) and regenerate; each run is a fresh asset.
