---
name: genex-blender-scene
description: Compose a level, arena, interior, building or map — a SPACE of rooms, lanes, walls and sites that must relate — in a live Blender with `npx genex blender`, then export one GLB the game walks through. Use for places to move through, floor plans, or explicit Blender authoring including standalone assets. Probe the lane first; code is the fallback only when Blender was not explicitly required.
---

# Genex Blender · Scene

Build the game's SPACE in a real Blender that answers over HTTP: write a Python
script, run it, read the numbers, look at the four-view sheet, repeat — then
export one GLB and load it like any model. The scene persists between steps, so a
level grows the way a level is actually built: shell, then zones, then dressing.

## When this lane owns the work

- An explicit request to author or edit **in Blender**, even one standalone
  asset. This overrides the default single-object route below. Keep Python
  source under `blender/`, export the requested GLB and show it in a simple
  browser preview; add gameplay only when requested. In hosted creation use
  the CLI through Bash and open contact sheets with Read: the Blender MCP
  server is not registered in the hosted harness.
  If Blender is unavailable, report that limitation and keep the authored
  scripts; the code fallback below is for requests that did not require Blender.

- A **space**: a level, arena, interior, building, map, dungeon, station — several
  rooms, lanes, walls or sites that must relate to each other, and a player who
  moves through them.
- A **floor plan or reference** to trace (a sketch, an ASCII plan, a photo of a room).
- A **blockout**: the playable shape first, dressing later.

Default routes when the player did not explicitly request Blender:

- One recognisable object (a barrel, a cart, a statue) → `$genex-ai-model`.
- One parameterized object placed many times with variation, or a stylized shader
  material → `$genex-threejs-procedural-assets`.
- The player's body, creatures, animation → `$genex-ai-character`,
  `$genex-threejs-creatures`. Terrain from a heightmap → code.

Mixing all three in one scene is normal: the Blender level is the architecture, a
generated GLB is the hero piece, code is the repeated dressing.

## Is the lane on? Probe by doing

```bash
npx genex blender scene
```

Read the answer literally — there are three:

1. **A scene JSON prints** → the lane is on. Continue.
2. `Warming up a Blender seat…` and then `The Blender seat is still warming up. Run
   the same command again in a minute.` → **not done yet**, even though the command
   exited cleanly. A GPU is booting for you (about 20 s on a warm pod, ~2 minutes
   on a cold one, up to ~20 minutes on a host that has never pulled the image).
   Between re-runs keep building everything that does not need Blender — the game
   code, the markers plan, the scripts themselves — and run the command again every
   couple of minutes; the wait never counts against you. Never read this line as
   success, and never read it as failure.
3. `The Blender lane is off on this stand`, `No Blender seat: fleet_full` or
   `No Blender seat: pod_unavailable` → build
   the same space **in code** with `$genex-threejs-procedural-assets`, say so in one
   plain line to the player, and keep going. Do not wait, do not ask.

The seat, once granted, is remembered in `.genex/blender-seat.json` — later
commands are silent about it.

## The loop

Scripts are the level's source. Keep them in the project, one per zone:

```
blender/01-shell.py      walls, floor, towers
blender/02-gatehouse.py
blender/03-courtyard.py
…
```

Run one:

```bash
npx genex blender exec --in blender/01-shell.py
```

Every run prints two things and writes one file:

- **The numbers** — `objects N  meshes N  tris N  materials N  radius N`. This is
  the gate. Before you run, know what the script should produce (twelve objects,
  about 4k tris, radius ≈ 40); after, compare. A render judge is unreliable for
  pass/fail; the numbers are not.
- **The sheet** — `assets/blender/contact-sheet.webp`, four fixed views (front,
  side, TOP, hero) from cameras derived from the scene bounds, so two steps compare
  pixel for pixel. **Open it with your file-reading tool after every step.** The
  TOP view is the floor-plan check; the hero view is the mood check. Nothing shows
  it to you unless you look.
- Script `print()` output comes back as stdout; a raised exception comes back with
  its traceback AND the sheet of the half-built scene, which is usually where the
  bug is visible.

The Python namespace **persists between runs** (`bpy`, `bmesh`, `mathutils`,
`math`, `random` are preloaded): define `mat()` and `box()` helpers once in the
first script and use them in every later one. If a run says the service restarted
and the scene was restored from a checkpoint, re-read the numbers — your last step
may be missing; re-run that one script.

Other verbs:

```bash
npx genex blender snap --mode wireframe   # topology; also normals | solid | lit
npx genex blender scene                   # the full graph as JSON, when a number surprises you
npx genex blender reset                   # empty scene (the namespace resets too)
```

Keep each step under about 90 seconds of Blender time: a script that loops
hundreds of boolean cuts is killed at the deadline and the scene comes back from
the last checkpoint. Split heavy work across scripts. A level is 8–15 steps, not 50.

## Craft rules that decide whether the export works

- **Metres.** Floor at `z = 0`, the map's centre at the origin. Blender is Z-up;
  the export converts to Y-up, so the floor is the XZ plane in Three.js and a
  Blender `(x, y, z)` lands at `(x, z, -y)`.
- **Name everything** `<zone>_<thing>` (`gate_portcullis`, `hall_table_1`). Names
  survive the export and are how the game finds parts.
- **Materials: few and flat.** Six to eight for a whole level, one per surface
  family (stone, dark stone, wood, roof, iron, glow). Set the Principled BSDF base
  colour **and** `material.diffuse_color` — the sheet's fallback renderer reads the
  second, and a scene that sets only the first exports with correct colours and
  renders entirely grey. No image textures: they do not fit the export ceiling, and
  an asset URL does not export.
- **Repetition by loop, never by an unapplied modifier.** Crenellations, columns,
  pews: a Python `for`. An Array modifier that is not applied is not in the GLB.
- **Tri budget.** Keep the whole level under ~150k triangles and use 12–16 segments
  on cylinders — phones load this file too. The export refuses above 6 MB; treat
  that as "no longer a game asset", not as a limit to work around.
- **Markers.** Empties export as named nodes: `bpy.data.objects.new("spawn", None)`
  placed and linked into the scene collection, likewise `key_1`, `door_crypt`,
  `patrol_1`. The level tells the game where things go; the game reads them with
  `scene.getObjectByName("spawn")`.
- **Lights stay in the game.** Blender lights do not export usefully; light the
  level in Three.js (a hemisphere + a sun, point lights at torches and hearths).
- **Collision is the game's.** Static level geometry gets Rapier trimesh colliders
  per mesh — `$genex-threejs-physics-rapier`. If a mesh is too dense to collide
  against, add a simplified `col_<zone>` box in Blender and keep the visual one out
  of physics.

A minimal first script, the shape every later one follows:

```python
import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)

def mat(name, rgb, rough=0.85):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1.0)
    b.inputs["Roughness"].default_value = rough
    m.diffuse_color = (*rgb, 1.0)   # BOTH, or the sheet renders grey
    return m

def box(name, loc, half, m):
    bpy.ops.mesh.primitive_cube_add(size=2.0, location=loc)
    o = bpy.context.active_object
    o.name, o.scale = name, half
    o.data.materials.append(m)
    return o

STONE = mat("Stone", (0.46, 0.44, 0.41))
box("yard_floor", (0, 0, -0.25), (35, 35, 0.25), mat("Ground", (0.30, 0.28, 0.24)))
for sx, sy in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
    bpy.ops.mesh.primitive_cylinder_add(radius=3, depth=14, vertices=16,
                                        location=(sx * 35, sy * 35, 7))
    t = bpy.context.active_object
    t.name = f"tower_{sx}_{sy}"
    t.data.materials.append(STONE)
print("shell:", len(bpy.context.scene.objects), "objects")
```

## Hero pieces from `genex model`

```bash
npx genex model "weathered stone knight effigy on a tomb, medieval"   # prints a URL
npx genex blender import https://assets.genex.technology/generations/<id>/model-glb
```

`import` prints the object names it added and renders a fresh sheet; place and
scale them in the next `exec` (`bpy.data.objects["…"].location = (…)`). Import
when the piece must be composed WITH the architecture (a gate in a wall, a statue
in a niche). When it is dressing, skip the import: drop a marker in Blender and
load the GLB in Three.js at that marker — it keeps the level file small.

## Export and load

```bash
npx genex blender export --out public/assets/level.glb
```

Load it like any GLB. The quality kit's rung ladder applies only to generated
`/generations/` URLs, so this file loads as-is — the tri and material budgets
above are what keep it phone-safe.

```ts
import { createGltfLoader } from "./controllers/quality/gltf-loader.ts";

const gltfLoader = createGltfLoader(renderer);
const level = await gltfLoader.loader.loadAsync("/assets/level.glb");
level.scene.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; }
});
scene.add(level.scene);
const spawn = level.scene.getObjectByName("spawn");
```

Then colliders (`$genex-threejs-physics-rapier`), the player
(`$genex-threejs-character-controller`), lights, and a real screenshot check
(`$genex-threejs-visual-validation`). Record the level in `DESIGN.md`'s Assets as
`local Blender build — scripts under blender/`, never a provider generation id.

## Money

A **hosted session's** seat bills a few credits per minute while it is held, idle
or not, and ends with the session — there is no close command for it. So build
the level in one sitting: shell → zones → hero pieces → export, then move on to
the game. Batch changes into fewer, larger scripts; every step renders one sheet.

At a **terminal with no Blender installed**, `npx genex blender seat` rents the
same pooled GPU on your own credits (the price and the idle timeout print on
open); it ends itself after 15 idle minutes, or run `npx genex blender release`
when you are done. Prefer `npx genex blender serve` against your own Blender
when one is available — the measurements favour it, and it costs nothing.

## Troubleshooting

- `payload_too_large` on export → fewer cylinder segments, delete faces the player
  never sees, or export two GLBs (`--out public/assets/level-a.glb`).
- The sheet is grey → `material.diffuse_color` was not set (see above).
- `refused the seat token (401)` → the rejected cached grant has been removed.
  In hosted creation, run `npx genex blender scene` to acquire a new seat and
  inspect the restored scene before deciding whether to rerun the failed script.
  At a terminal, run `npx genex blender seat` first. Recovery never automatically
  replays scene changes; a replaced pod restores the latest saved checkpoint.
- `seat_not_ready` → the pod is still booting; run again shortly.
- The numbers are right but the top view is wrong → coordinates: `y` in Blender is
  depth, and `scale` on a 2-unit cube is the half-size.
