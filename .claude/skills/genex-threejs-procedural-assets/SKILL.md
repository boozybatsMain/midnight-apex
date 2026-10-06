---
name: genex-threejs-procedural-assets
description: Build editable, parameterized Three.js objects in code — modular kits, structural pieces, repeated or varied props, and any object code will honestly make read as the thing it is — or whenever the user asks for procedural/parametric work. A first-class lane alongside generated GLBs, held to the same bar; mix both freely.
---

# Genex Three.js Procedural Assets

Build a recognizable asset as local, editable Three.js code. This lane is a
first-class engine, not a fallback — and it is held to the same bar as a
generated GLB: the result must read as the thing it is when the player looks at
it, in the game's own style. A coloured box or a flat grey block is a blockout,
never a landed asset. Mixing procedural pieces with generated pieces in the
same scene is the normal way to build a detailed, lively world.

## Choose the route

- Start directly when the user says procedural, parametric, code-built,
  customizable, seeded, or asks for controlled variations.
- Also start directly for what is structural, repeated, distant, or
  parametric: terrain, modular environment kits, fences, pipes, rails, walls,
  paving, and anything placed many times with variation.
- For anything the player looks at up close, walks into, or interacts with — a
  named building, a signature prop, a vehicle — code is a choice, not a
  default: take it only when you will honestly reach the bar above, and confirm
  it in a capture at gameplay distance before the row reads `landed`. Otherwise
  `$genex-ai-model` owns it.
- An attached or available image does not activate this skill by itself.
- If “make this image 3D” could honestly mean either route, ask exactly one
  question: **“Do you want a generated textured GLB, or editable procedural
  Three.js code?”**
- Use `$genex-ai-model` when the user chooses a generated textured GLB.
- Do not use it for characters, creatures, rigging, skeletal animation, or
  character likeness. Keep those in their existing specialist lanes.

## Keep the reference safe

A user attachment, local file, or private URL is build input only. Inspect it
in place. Do not upload it, place it in `public/`, publish it, or commit a copy
without the user's permission.

When no reference exists and one would materially improve the requested
asset, use the existing `npx genex image` route. Record that image as its own
normal paid generation row in `DESIGN.md`, including its generation ID and
landed URL. Do not create another image pipeline or automatically re-roll a
reference.

State which geometry is visible and which geometry is inferred. A single view
does not prove its hidden sides. Ask for another view only when the requested
fidelity or gameplay behavior genuinely depends on it; otherwise make a
reasonable inference and name it.

## Record the work in `DESIGN.md`

Give the procedural result a separate row in the existing Assets table:

```markdown
| <asset> | procedural-code | building (blockout) | — |
```

Use this status flow:

```text
proposed → planned → building (blockout | detail | material | runtime)
→ landed (<local TypeScript path>) → wired
```

`landed` means a capture at gameplay distance showed it reads as the thing it
is — not that the file exists.

A Genex-generated reference keeps its separate image row and normal paid
generation status. Note that the procedural-code row is derived from that
image. A private user reference is not a paid generation row.

Keep only useful state: intended use, fidelity target, reference provenance,
visible versus inferred regions, any required moving parts or collision
shape, current stage, output path, and comparison evidence. Do not add a
second review ledger.

## Build the asset

1. Identify the silhouette, proportions, part relationships, material zones,
   and the few details that make the subject recognizable.
2. Define meaningful parameters before geometry: dimensions, part counts,
   thicknesses, palette or material choices, and variation ranges. Add an
   optional seed only when controlled variation is useful.
3. Build the smallest blockout that proves massing and scale. Use named child
   objects for semantic parts rather than one anonymous group of primitives.
4. Add only the detail and material behavior required by the user's target.
   Preserve real dimensions and keep randomness inside valid ranges.
5. Render one reference-matched view plus one off-axis or in-game-scale view.
   Fix meaningful silhouette, proportion, attachment, and material mismatches.
6. Stop when the requested acceptance level is reached, then integrate the
   factory and move its `DESIGN.md` row from `landed` to `wired`.

The output is a local TypeScript factory that returns a `THREE.Group`, for
example `createMarketStall(options): THREE.Group`. Give it stable defaults,
intentional parameters, and named parts that gameplay code can address.

Add pivots or sockets only for parts that must move or attach. Expose a
collider description only when gameplay needs collision, and let the game's
existing physics owner create the real collider. Add destruction groups only
for a destructible asset. A static decoration needs none of this ceremony.

## Measured craft (from shipping real code-built assets)

These were learned by rendering, measuring, and being wrong — every check can
pass and the object can still read wrong. The fixes:

- **Look at it from every side before calling it done.** Render front,
  three-quarter, side, rear, and below when the underside can be seen. The
  defects that survive a clean build are visual: an invisible part, a slatted
  surface that reads solid, a gap down a seam, a base that floats above y = 0.
- **Metalness 1.0 renders black in any scene without an environment map** — a
  fully metallic surface has no diffuse term. Use ~0.4–0.55 with a brighter
  base color; the metal read comes from roughness variation and the normal
  detail anyway. Judge the material on the side the key light does NOT reach:
  a surface lit only by fill shows you the fill's color, which is how bare
  aluminium once shipped reading as blue-painted steel.
- **A mirrored basis is not something to eyeball.** Swapping two orthogonal
  axes is always a reflection; flip a third to get back to a rotation. A
  mirrored part renders fine and is silently inside-out — define named
  right-handed bases as constants and reuse them.
- **Vertex colors multiply.** For wear that reveals a different substrate, put
  the hue in the color buffer and leave `material.color` white — multiplying a
  saturated red can never reach grey.
- **Where two sub-assemblies meet, terminate one inside the other's wall
  thickness** (clearance math at the widest point, including any bow) —
  butting them leaves a visible reveal from some angle.
- **No two opaque surfaces share a plane.** A road quad at the ground's exact
  y, a panel flush on a wall, a rug at floor height — coplanar opaque faces
  z-fight, and a still screenshot is the one tool guaranteed to miss it. Give
  every flat member a real offset from the surface beneath (1–2 mm indoors,
  ~1 cm at city scale); a true decal instead wins the depth test with
  `polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1` +
  `depthWrite: false`. Kit pieces butt end to end (faces meeting back-to-back
  are safe) — they never overlap at the same face. Flicker in the DISTANCE on
  clean geometry is the camera's depth range instead: derive near/far with the
  quality kit's `cameraNearFar` and spread `depthRendererOptions()` into the
  renderer (`$genex-threejs-adaptive-quality`). The
  `$genex-threejs-visual-validation` console scanner lists offending pairs by
  name.
- **Merging beats instancing for small repeats.** Merge everything static that
  shares a material into one buffer and instance only genuine crowds — eight
  moulded ribs cost a whole extra draw call as an `InstancedMesh` and nothing
  at all merged.
- **Normal-map strength is measured, never reasoned.** The response is steeply
  non-linear, so bisect toward the look (a moulded matte surface reads right
  around a ~9° average tilt; a faceted one around ~22°), and re-check whenever
  the noise frequency changes — a frequency-only edit once moved the required
  strength 60%.

## Procedural materials (shader-authored surfaces)

This lane also owns stylized, abstract, or fully-parametric materials authored
in shaders (instant, perfectly tiling, no files) — for a specific photoreal
surface you can describe in words, `npx genex texture` is usually the better
engine, and mixing the two on one asset is normal. One principle: color,
roughness, metalness, normal, and emission should all describe the SAME
surface and its causes — never unrelated noise per channel. The failure modes
worth checking before calling a material done:

- every PBR channel samples independent noise;
- roughness is a scalar afterthought;
- high-frequency normal detail survives below one pixel (shimmer — filter it
  out with distance);
- triplanar projection shows orientation or scale seams;
- post-processing is being used to hide unstable highlights.

## Respect existing owners

Consume the game's existing Three.js scene and runtime. Never replace or
silently configure its renderer, camera, lighting, shadows, post-processing,
physics, animation, adaptive-quality, or mobile systems. If the request grows
from one asset into a general mesh library, building grammar, or world
generator, say so in one plain line and keep building — that growth is often
exactly what a detailed world needs; just don't silently rebuild the game's
runtime systems around it.

Do not replace `$genex-ai-model`, the character or creature lanes, rigging,
animation, or any protected platform pipeline.

## Keep the loop proportional

The user's acceptance target controls the work. A rough background prop may
finish after blockout and material; a hero prop may earn more refinement.
Continue autonomously through unambiguous fixes and keep unrelated game work
moving.

Do not impose mandatory pass counts, numeric fidelity scores, review ledgers,
weapon-specific rules, automatic re-rolls, or user approval after every pass.
Ask only when a real product choice remains.
