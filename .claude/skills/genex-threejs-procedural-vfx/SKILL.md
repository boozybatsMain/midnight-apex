---
name: genex-threejs-procedural-vfx
description: Author procedural real-time VFX for Genex Three.js games, and decide WHERE effects belong — walk the game's moments one by one. Methodology for the cast envelope (travel/impact/fade), GPU-simulated particles, parameter-space filaments (lightning, beams, trails, tendrils), pooled dynamic lights, and impact grammar (shake, flash, shockwaves, aging residue). Use for particles, sparks, plasma, shockwaves, ability effects, event-timed visuals, and gameplay-readable spectacle.
---

# Genex Three.js Procedural VFX

Build effects from an event envelope, motion field, geometry representation, and
shading response. Avoid independent particle emitters that happen to share a
color. Everything below is **method, not library**: the same math works as GLSL
in a `ShaderMaterial` on WebGL and as TSL nodes on WebGPU — pick the game's
renderer, keep the method.

## The moment gate — run this BEFORE writing any effect code

The visual-direction gate walks **surfaces** and asks "texture or shader?" for
each. It cannot see effects, because effects don't live on surfaces — they live
on **moments**. So walk the moments the same way, and decide each one.

List every moment the game's own rules fire. Take them from the game's controls
and contract, not from imagination — a bomb detonates, a crate breaks, a pickup
is collected, a player dies, a round starts, a shot lands. Then judge each:

> **Does the world change here in a way the player should SEE, and does the
> existing feedback already say it?**

Three answers, all legitimate, one forbidden:

- **Effect earns it** — the moment has a cause the player made and a consequence
  they must read, and nothing else is carrying it. Build it.
- **Already covered** — a flash, a sound, hitstop, a decal, or an animation
  already lands the beat. Adding particles buys nothing but fill rate. **Say so
  in one line and move on.**
- **Deliberately bare** — the look wants restraint. Valid. **Say so in one line.**
- **Not deciding** — the only wrong answer. A game where bombs detonate and the
  world does not react is not a style choice, it's an unfinished list.

Then check the inverse, because the failure runs both ways: **an effect on a
moment the player didn't cause and can't read is noise.** Ambient particles
sell mood, not information — add them deliberately (one layer is usually
enough) and keep them subordinate to the readable moment effects, so
atmosphere never drowns out what the player must see.

**Shape is part of this gate.** For a moment made of energy — fire, a blast, a
shockwave — the question is never "what texture goes on this box?" It is "what
is this energy shaped like?" A shipped game reasoned "the flame is deliberately
untextured — it is pure emissive energy" and left a **cube** standing in for
fire. That sentence answers the surface gate correctly and the moment gate not at
all. If a primitive is standing in for an effect, it is a placeholder, whatever
the comment says.

## The law: dice on the CPU, dimensions in the shader

The one decision that separates an effect that looks authored from one that
looks stapled on. When an effect spawns, capture **only what randomness
decided** — unitless fractions along the cast, seeds, timestamps. Never a
metre, radian, or second. Every dimension is resolved each frame from one live
config object, and inside the shader wherever possible. Three consequences,
all load-bearing:

- **Effects tune live.** Change a height or spread value and a field that is
  already standing regrows to match — because nothing captured the old number.
  Tuning against a paused frame becomes possible, which is where shapes are
  actually worth judging.
- **Geometry becomes reusable.** A vertex that carries only `(t, side)` — how
  far along, which edge — serves a bolt of any length, shape, and width. The
  same strip is a lightning filament, a beam coil, a tendril, and a trail.
- **Nothing goes stale.** There is no CPU-side path or cached transform to
  desynchronize from what the shader draws.

Corollary: **geometry carries parameters, shaders compute shape.** The
procedural look in strong VFX comes almost entirely from evaluating position,
silhouette, and color per frame from parameters, not from ever-larger meshes.

## Anatomy of a moment: the envelope

Every event effect — a cast, an explosion, a landing — shares one envelope,
and building it once keeps every layer synchronized:

- **Phases**: travel → impact → fade. Each phase exposes a normalized 0..1
  progress; every layer reads `(phase, t)` instead of keeping its own scattered
  time constants. Retiming the whole effect is then one number per phase.
- **The front**: advance in metres/second scaled by delta time, eased off the
  standstill. Key the ease on **elapsed age, not progress** — an ease keyed on
  progress multiplies the very first step by zero and the front never leaves
  the caster.
- **The local frame**: origin, unit direction, `side = direction × up`. Every
  layer — geometry, particle velocities, decal orientation — places itself in
  this frame, which is what makes secondary motion read as caused by the event
  rather than coincident with it.
- **Reveal, don't scale.** Build the full shape and clip it at the front's
  progress (discard fragments past `t = progress`, with a bright leading tip).
  A shape that stretches as it extends crawls and swims; one that is revealed
  keeps its character while it grows.

## Particles: spawn on the CPU, simulate in the shader

A per-frame CPU particle loop is the naive default: it burns main-thread time
and caps counts in the hundreds. The method that scales to thousands is
instanced quads whose motion is **analytic** in the vertex stage:

- One instanced quad; per-instance attributes: start position, velocity, spawn
  time, lifetime, size, seed, spin, tint. The CPU writes these **once per
  spawn** into a ring buffer (the cursor wraps, so spamming an ability recycles
  the oldest slots instead of allocating) and uploads only the changed ranges.
- Position is a pure function of age — exact exponential drag, no integration:

  ```
  age = now - spawnTime           // dead if age < 0 or age > lifetime
  pos = start
      + velocity * (1 - exp(-drag * age)) / drag
      + 0.5 * gravity * age * age
  ```

  Frame-rate independence, pause, and slow-motion all come free. Add curl
  noise of the start position for turbulence; rotate the start offset around a
  drifting anchor for vortex swirl.
- **Kill without touching buffers**: a dead particle outputs a position outside
  the clip volume and the GPU discards the whole quad before rasterization.
- **Silhouettes are procedural** in the fragment stage, from centered UV:
  a feathered dot (`smoothstep` on radius) for anything that is light; an
  fbm-eroded puff for smoke; a velocity-stretched streak for sparks; an
  angular chip (radius wobbled by `sin(angle * k + seed)`) for debris; a thin
  ring for shockwaves. No sprite textures required.
- Color is a 3–4 stop gradient over normalized lifetime (birth → early → late
  → death); alpha is a fade-in × fade-out pair of smoothsteps.
- **Blending is a role decision**: additive for anything that IS light —
  sparks, glitter, glow. Normal blending for smoke and mist, so they genuinely
  occlude and give the effect depth. A scene made only of additive layers has
  no darkness in it.
- Emission rate: accumulate `rate * dt`, emit the whole part, carry the
  remainder — truncating emits zero at high frame rates and bursts at low
  ones. Cap the per-frame emit so a one-second hitch cannot dump a thousand
  particles into a single frame.
- Emit a travelling effect's particles from several points along its length,
  not one — a bolt sheds along its whole span, and a single origin makes every
  batch read as a starburst.

### Particles do not render round by default

`new THREE.PointsMaterial({ size, color })` draws every point as a **hard-edged
camera-facing square** — no falloff, no fade. Shipping the default is the
"square flying things" look, the single most common particle defect in real
builds. For a quick `Points`-based job, the fix is one canvas sprite:

```ts
/** A soft round dot drawn into a canvas — no network, no asset, works offline. */
function dotTexture(size = 64): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.Texture(c);
  t.needsUpdate = true;
  return t;
}
```

…set as `map` with `transparent: true`, `depthWrite: false`, additive blending.
For a mote with real art (embers with structure, snowflakes, leaves), generate
the sprite instead — `npx genex image --transparent "single soft round ember,
black background"`. `depthWrite: false` disables the depth **write**, not the
**test**: a mote fractionally below the floor vanishes, so spawn above the
surface, not on it.

## Filaments: everything long and bright is one strip

Lightning, beams, energy tendrils, leashes, trails — one parameterization
covers them all, and it is the purest case of the law above.

**Geometry**: a ladder of quads whose vertices carry only `(t, side)` — how far
along the filament, which edge of the strip — with one instance per filament
(an index attribute). The vertex stage turns that pair into a world position
every frame by stacking three terms:

1. **The axis** — a line from origin to target, optionally bowed by sag. The
   only term that knows where the cast points.
2. **The fan** — a constant per-filament offset in the plane perpendicular to
   the axis, opening from a near-spread at the hand to a far-spread at the
   target, rolled around the axis by a twist angle. This is what separates one
   filament from the next.
3. **The kinks** — octaves of **linearly interpolated** value noise, frequency
   expressed in kinks per metre (scale by the cast's span so a long bolt kinks
   as densely as a short one). Linear on purpose: smooth interpolation rounds
   the corners off, and the corners are the entire reason it reads as
   lightning rather than as a wobbly tube.

Then:

- **Face the camera without billboards**: tangent by finite difference along
  `t`; `binormal = normalize(cross(tangent, toCamera))`; offset the vertex by
  `binormal * side * halfWidth`. The strip keeps its apparent thickness from
  any angle without ever being a screen-space line.
- **Pin the ends**: fade the kink amplitude to zero near `t = 0` and `t = 1`.
  A bolt that lands anywhere other than where it was aimed reads as a bug.
- **Draw it twice**: a wide soft halo pass under a narrow hot core pass — same
  geometry, same path, different width and falloff. Glow drawn as real
  geometry stays attached to every kink; bloom alone detaches from the shape.
- **Two clocks**: a restrike clock snaps every filament onto a new shape N
  times a second (`seed = hash(filamentIndex, floor(time * restrike))`) while
  a crawl clock slides the kink phase continuously in between. Together they
  stop a held bolt from looking like a static ribbon. Flicker is **quantized**
  — `brightness = hash(floor(time * flickerSpeed))` — because lightning
  stutters between brightnesses; a sine "breathes", and reads as decoration.

**A beam is the same idea one dimension up**: a tube whose vertices carry
`(t, angle)`, drawn three times at three radii — a halo that is nothing but
rim, a sheath weighted toward its silhouette edges so it reads as hollow, and
a core weighted the **opposite** way, brightest where the view ray runs down
the barrel. Rim-weighted outside, axis-weighted inside, both faces adding:
that is a volume integral, cheaply, and the inversion is why the middle reads
as a solid rod of light instead of a lit pipe. Helical coils are the filament
strip bent around the same radius function; a train of shock discs is an
instanced ring whose phase is `fract(index / count + time * speed)` — a pure
function of the clock, no queue on the CPU. And keep the noise families apart:
a beam's noise is smooth and stretched hard along the flow; a bolt's is
piecewise-linear. A beam that kinks is a bolt.

## Lights are pooled at boot

Adding or removing a dynamic light mid-game changes the lighting program and
forces the renderer to **recompile every material** — the classic first-cast
hitch. Create the maximum count at boot (4–6 point lights is plenty), parked
at zero intensity; acquire on spawn, release on death, and damp intensity
toward its target so a released light fades instead of cutting. `acquire()`
returns null when the pool is exhausted — guard every use. Give impacts a
transient boost added onto the base intensity that decays on its own.

Same family of trap: run the renderer's async shader precompile during the
loading screen so the first cast never stutters on compile.

## Impact grammar

One impact is several small systems firing from the **same call site** — the
place the game already plays the explosion sound. That call site is the proof
the effect is event-driven rather than ambient decoration.

- **Shake is trauma, not offset.** Hits add trauma (clamped 0..1);
  displacement is `trauma²` (perceptually linear for a linear decay), taken
  from summed sines at incommensurate frequencies — smooth noise reads as
  weight, white noise reads as jitter. Overlapping hits stack naturally;
  small hits feel snappy, big ones heavy.
- **A shockwave** is the ring silhouette from the particle section, expanded
  over its lifetime, flat on the ground.
- **Residue that lives** is a pooled ground quad with a noise/distance-field
  fragment shader aged by one normalized uniform: scorch cools, cracks spread
  then dim, frost creeps outward. Trap, measured in this class of effect:
  never sample radial noise on `atan(y, x)` — every radius along a bearing
  gets the same value and the mark becomes dead-straight spokes, a firework
  instead of a burn. Sample the noise in the plane and domain-warp the lookup,
  and the filaments meander and fork.

## Rules

- Every layer must have a role in silhouette, motion, illumination, or residue.
- Use normalized lifetime curves instead of scattered time constants.
- Derive secondary motion from the same flow or event direction.
- Keep bloom as a response to HDR emission, not as the effect's only shape.
- Pool everything at load — abilities, particles, decals, lights. Nothing is
  allocated or built during a cast, and a cap retires the oldest cast rather
  than letting the scene grow without bound.
- Know your draw-call budget: an instanced filament bundle is 2 draw calls at
  any filament count; a particle system is 1. If an effect's cost scales with
  its visual density, restructure it so it doesn't.
- Expose spawn, simulation, overdraw, and luminance debug views.
- Include a non-bloom baseline that remains legible.
- Never ship a `PointsMaterial` without a `map` or `alphaMap` — see above.

## Routing boundary

Keep accumulated screen frost, persistent weather/surface state, and ground
material changes in the request's owning scene system. Impact residue splits
by whether it must change while standing: residue that ages or rescales live
(spreading cracks, creeping frost, a cooling scorch) is a procedural decal in
this skill; static art-directed residue (bullet holes, a painted scorch) is a
generated decal — `$genex-ai-image` owns that. The spark that throws either
kind of residue is this skill, and a hit usually wants both. Keep ship-space
plasma, generated wakes, sparks, and pooled debris in this skill.
