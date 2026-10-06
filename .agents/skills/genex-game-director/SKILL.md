---
name: genex-game-director
description: The Genex request router. Read the latest game, tool, component, or focused-change request; ask only genuinely unresolved build forks; keep DESIGN.md current; and load each owning lane BEFORE the first file of the subsystem it owns — only the lanes the work touches, never the whole pack, and never fewer than the work needs. Use first for new work, resumed work, or whenever ownership is unclear.
---

# Genex Game Director

The player chooses what to build and in what order. You route that request;
the owning Genex skills control how their lanes run.

Routing binds in BOTH directions: load only the lanes the requested work
touches — never the whole pack by default, and never unrelated work because an
old workflow listed it — and load a lane BEFORE the first file of the subsystem
it owns. A matching row in the routing map is not a suggestion: each lane
exists because writing that subsystem without it ships a known defect.
Loading one lane never commissions another.

**After any context compaction or session resume**, re-read the project's
`AGENTS.md`, `DESIGN.md` when present, and the skill for the work you are
executing. Then follow the player's latest clear request; do not reconstruct
the project from memory or replay completed discovery.

## 1. Check capabilities and boundaries once

Check your tools once — question tool, sub-agents, browser — and use what you
actually found: without a question tool, ask one short plain-language question
in chat; without a browser, ask the player for the smallest useful visual
observation. Sub-agents suit independent workstreams in a whole coordinated
build and are never required for focused work. Never claim a capability you
did not find, and never stall because one is missing.

Your platform may bundle its own image/video generation and site-building,
hosting, or deploy skills. **They are not Genex lanes.** All generated art,
audio, video, characters, and UI come from `genex` commands unless the player
explicitly asks for another tool by name. A local reference image is not a
reason to switch tools: `genex image --edit` and `--inpaint` accept local
paths. Building, previewing, promoting and publishing use `genex preview` /
`genex promote` / `genex publish`; do not load a competing hosting workflow.

## 2. Route the latest request

Use the request in front of you, not the oldest description of the project.

- **Explicit Blender authoring**, including a standalone prop, owns the
  `$genex-blender-scene` lane. Keep the requested scope: Python scripts, an
  exported GLB and a browser preview for an asset request. Do not invent
  gameplay, a character controller or a game concept to justify the hosted
  workspace. Blender in this sentence names the authoring tool; a kitchen
  blender requested as a prop follows the ordinary asset rows.

- **Clear focused request**—“work on the UI,” “fix movement,” “add one enemy,”
  “make this prop,” “publish this”—read the touched implementation and
  `DESIGN.md`, load only the owning skills, update `Now:`, and start. Do not
  re-pitch the game, ask whole-game-versus-one-part again, force a concept
  round, restart completed milestones, or add adjacent work.
- **Clear new game request with a named scope** starts from that scope. Record
  the requested destination and proceed; ask only a missing decision that
  materially changes architecture or player experience.
- **Broad full-game request** may need one scope choice: “Should I build the
  whole game as coordinated milestones, or start with one part?” Offer only
  request-relevant parts—such as movement, core gameplay, world, enemies, UI,
  multiplayer, or a named tool. If the player already chose a part or clearly
  asked for the complete game, skip the question.
- **Blank or genuinely unclear intake** asks one neutral question: are they
  making a game, building a tool/component, or changing existing work? Do not
  invent or propose game concepts for them.
- **Existing project** respects its renderer, physics, file conventions, and
  working systems unless the player asks to change them.
- **A tagged reference** (source under `.genex/refs/<slug>/`) owns the
  subsystem it was tagged for: read its `_map.md` and implementing files
  before choosing a lane — it outranks the default lane, including the
  vendored controllers, for that subsystem.

Ask one decision at a time. Never ask the player to choose an SDK, engine,
renderer, file layout, provider, or other implementation detail. Product
defaults fill missing implementation choices; they never override a clear
request.

The player's latest direction may replace `Now:` immediately. Preserve
unfinished requested work as open commitments unless the player cancels or
re-scopes it; focused work changes the current order, not historical truth.

## 3. Keep DESIGN.md as durable memory

For a new project or substantial multi-step request, create `DESIGN.md` from
[references/design-contract.md](references/design-contract.md). For existing
work, update only the sections touched by the latest request. A tiny focused
fix does not need unrelated sections filled in.

The file keeps three truths separate:

1. **Requested outcome**—the player's final target, changed only by the player.
2. **Current focus**—the exact `Now:` item and its observable done condition.
3. **Open commitments**—requested work not completed, cancelled, or re-scoped.

Also record the working mode: `whole coordinated build`, `step by step`, or
`focused change`. Step-by-step changes order, not destination. The build plan
is current, never “locked”; tell the player only that their request is recorded
in `DESIGN.md` and you will keep it current.

Preserve the exact markers used by existing machinery: `## Build plan &
status`, `Now:`, `HUD lane:`, `Menu video:`, HUD pipeline stage IDs and paths,
`Player character:`, generation IDs and permanent URLs, and asset wiring
state. The paid Assets flow remains:

`proposed → planned → generating (id) → landed (URL) → wired`

A landed asset is not complete until wired or visibly cancelled. Procedural
code-built assets use their own local flow:

`proposed → planned → building (blockout | detail | material | runtime) →
landed (<local TypeScript path>) → wired`

Never invent a provider generation ID for local code. Sections for gameplay,
content, UI, world, assets, multiplayer, character/animation, tools, or
modules are conditional on the request and existing project.

## 4. Routing map — load the owning lane before the first file

For every subsystem the current milestone touches, find its row below, load
that skill, and write the lane beside the work in `DESIGN.md` — a `Lane` cell
on the module's row in the Modules table, or a `Lane:` line under `Now:` in
focused or step-by-step work. `Lane: none — <why>` is the only way to write a
subsystem with no lane. Then write the code. Never reconstruct a lane's API or
vendored code from memory of another engine.

| Work needed | Load |
| --- | --- |
| **your first `npx genex model` or `npx genex character` this session** — the command, what comes back, how to scale and ground it, what the build may spend, and what to do when a lane is dead. One page, thirty seconds. The full lanes below are long; measured across 105 generation-lane invocations, 94% ran without the owning skill open, and placement is where that showed | `$genex-lane-card` |
| shot composition, chase/side/orbit rigs, camera handoffs, projection ownership, pointer look, mouse-aimed action, mouse-look, the screen-direction contract for hand-rolled steering/pan/look input signs, floating origins | `$genex-threejs-camera-direction` |
| on-foot player movement: walk/run/jump/crouch, third-person character, slopes, stairs, moving platforms, the player's body loader, directional locomotion, transitions, action motion | `$genex-threejs-character-controller` |
| **attacking, casting, aiming or reloading WHILE moving** — any action the legs must keep running under; a weapon carry stance over stock locomotion; a wind-up the character holds while walking | `$genex-threejs-character-controller` (`references/animations.md`, upper-body layering) |
| dash, dodge, roll, blink, backstep, a lunging attack — any burst that moves the character itself | `$genex-threejs-character-controller` (`references/tuning-and-presets.md`, dash recipe) |
| the game's own generated character—the player's body wherever a human body appears—or Meshy animation coverage beyond the stock pack: reference-informed A-pose concepts, exact action IDs, same-rig adapter | `$genex-ai-character` + `$genex-threejs-character-controller` (first time this session: `$genex-lane-card`) |
| a character/enemy needs motion the catalog lacks—a signature move, boss telegraph, death, full 8-way set, or the player's footage; free plan before spend | `$genex-ai-character` motion section + `references/motion-generation.md` |
| remote player bodies in multiplayer—never hand-built primitives: the game's generated character when it has one, otherwise the player's `p.avatarUrl` VRM | `$genex-threejs-multiplayer` + `$genex-threejs-character-controller` |
| enemies, NPCs, or creatures: rigged bipeds via `npx genex creature`; non-biped body plans (quadruped, flier, serpent, aquatic, multi-leg) via `npx genex model rig` + `model animate`; static plus procedural motion only for shapes with no body plan; collider, facing, hit reaction, death | `$genex-threejs-creatures` |
| cars, drones, vehicle physics, gearbox, character↔vehicle enter/exit | `$genex-threejs-vehicle-controllers` |
| playable on phones: joystick, virtual buttons, drag zones, genre touch recipes, rotate-device overlay | `$genex-threejs-touch-controls` |
| phone-survivable rendering: device tiers, DPR/shadow/post budgets, runtime governor, generated-asset rungs, Quality picker, dispose-on-swap | `$genex-threejs-adaptive-quality` |
| anything falls, collides, gets pushed, or needs colliders/events | `$genex-threejs-physics-rapier` |
| launch/docking timelines, authored transform phases, springs, convergence, deterministic prop/debris motion | `$genex-threejs-procedural-animation` |
| a level, arena, interior or map to walk through — the SPACE ITSELF: its ground plan, rooms, lanes, walls, paths and sites, from a description or a floor plan; a blockout. This row claims the space, never the things standing in it — the buildings, props, creatures and characters a player walks up to are separate rows below, and routing the space does not route them | `$genex-blender-scene` — probe the lane first (`npx genex blender scene`); when it is off, the same space is built as code via `$genex-threejs-procedural-assets` |
| rebuild a reference prop, hard-surface object, modular decoration, or structural environment piece (kits, fences, walls, paving) as editable parameterized Three.js code — held to the asset bar at the end of this section | `$genex-threejs-procedural-assets` |
| stylized/abstract shader-authored materials, the procedural/PBR material boundary | `$genex-threejs-procedural-assets` |
| particles, trails, plasma, shockwaves, pooled bursts, and event effects | `$genex-threejs-procedural-vfx` |
| stable large-world shadows, cascades, clipmaps, cached updates | `$genex-threejs-shadow-systems` |
| eye adaptation, tone mapping, output color, LUT grading, and proven static grain | `$genex-threejs-exposure-color-grading` |
| fixed-view screenshots, input direction, facing, temporal and budget evidence | `$genex-threejs-visual-validation` |
| **a model the player already has** — a `.glb` they exported, bought or made elsewhere: it is IMPORTED, never rebuilt. `npx genex model import <file.glb>` (free) for props and non-biped bodies (then `model rig`/`model animate`), `npx genex character import <file.glb>` for a humanoid that should walk (Uthana auto-rig, then `character animate --locomotion`) | `$genex-ai-model` · `$genex-ai-character` |
| the default for a concrete object the player looks at up close: a generated GLB for a prop, vehicle, building, or object — from text or a reference image (`--image`); split into named parts (`model segment`); rig + animate any mesh (`model rig` / `model animate`). A space routed to code above does NOT settle these: the ground plan can be code while an object examined up close is generated | `$genex-ai-model` (first time this session: `$genex-lane-card`) |
| generated surface or terrain texture with real-world UV scale | `$genex-ai-texture` |
| sky, skybox, horizon, time of day, weather mood, night or space backdrop | build it in code; $genex-threejs-exposure-color-grading owns gameplay lighting and time-of-day readability, with atmosphere techniques chosen for the scene |
| poster, sign, sprite, decal, reference sheet, or other 2D art | `$genex-ai-image` |
| in-world motion art or another requested video | `$genex-ai-video` |
| sound effect, one looping music bed, or a short spoken line | `$genex-ai-sfx`, `$genex-ai-music`, or `$genex-ai-voice` |
| requested UI/HUD/menu/interface work, a visible UI problem, or an interface you decided this game wants built with generated art | `$genex-threejs-game-ui` |
| selling anything for platform coin: a shop, an item catalog, boosts, cosmetics, "make it earn"; also any request for a loot box, gacha, wager, casino mechanic or donation prompt, which that skill refuses and replaces | `$genex-monetization` |
| the game calls a language model AT RUNTIME on the player's money: NPCs that answer in their own words, dialogue or quests written per save, a judge reading what the player typed — one-time calls, or a standing budget the player approves once. Check the lane with `npx genex llm models` before designing it in | `$genex-llm-in-games` |
| cinematic menu/title/pause/victory/defeat/lobby/credits video treatment | `$genex-ai-menu` |
| drawn HUD chrome the game's style wants—one element or a matched set of frames, masks, and icons | `$genex-ai-hud` |
| the game works but feels flat, floaty, or unresponsive: input response, camera, impacts, cooldowns, difficulty, fail/retry | `$genex-threejs-game-feel` |
| realtime multiplayer: movement sync, shared ball/NPC, host-run scores/enemies, shots/emotes, persistence | `$genex-threejs-multiplayer` |
| players talking to each other by TEXT — chat, room chat, "let them type to each other" (`room.chat` + `npx genex controller chat`) | `$genex-threejs-multiplayer` |
| players TALKING — voice chat, mic, "hear each other", proximity/positional voice (`room.voice` + `npx genex controller voice`; party-sized, max 6 per room — say that number out loud before building the feature) | `$genex-threejs-multiplayer` |
| player identity, sign-in, guests, saves/progress, per-player state, shared persistent world, leaderboards—mandatory for every game | `$genex-threejs-embed-auth` |
| the player EXPLICITLY asks to make an asset or publish something from their game as an asset for the free library | `$genex-asset-author` (`genex asset new`) — never offer this unprompted; no game duty routes here |

Request-shape rules, working modes and the protected-lane handoffs stay in the
[routing map](references/routing-map.md); read it when the request shape, not
the subsystem, is what is unclear.

For “make this image 3D,” ask **one** route question only when both results
honestly fit: a generated GLB built from the picture itself
(`npx genex model --image <path>`), or editable parameterized Three.js code.
If the request says procedural, parametric, code-built, reusable variations,
or names a GLB, start the corresponding route directly. An image alone never
auto-triggers the procedural lane. A floor plan, a room photo or a map sketch
is a SPACE, not an object: it goes to `$genex-blender-scene` with no route
question. Player bodies, rigged characters/creatures, and animation stay with
their protected owners.

If a procedural request has a private reference, use it locally and do not
upload, publish, or commit it without explicit permission. If no reference was
supplied and creating one is part of the requested work, use the existing
`npx genex image` lane unchanged and record that paid reference as its own
Assets row.

Every asset must read as the thing it is from the gameplay camera. Decide per object which engine meets that bar; procedural authoring is a first-class engine.

Plan one reusable implementation per distinct required gameplay or visual role before adding variants. Each Assets row records **role**, **reuse** (instances or compatible existing assets), and **done when** (the visible or playable requirement it satisfies), beside its route and price. Background populations default to reusable procedural bodies and motion, or compatible existing rigged assets. Catalog clips require a compatible skeleton and may cost credits; they are not free animation for arbitrary procedural meshes. Reserve custom paid character workflows for the player body and characters examined or interacted with closely; explicit user requests still take precedence.

Add a variant only when reuse leaves a demonstrated requirement unmet. Unspent allowance is not unfinished work. Procedural pieces must meet the same visual bar as generated ones; a placeholder capsule or box is not a finished person or prop. Keep the existing Assets table, and record `Generation: none — <why code or reuse reaches the bar>` when no paid generation is needed. Mixing engines is normal. In focused
work, stay inside the touched scope. Generate in batches you can finish, and
generate what the wallet can carry: every build has an asset allowance, and
`npx genex budget` prints it live with the price of each kind. Each Assets row
carries its kind's price from that output, and the table's total is checked
against the allowance before the first `--no-wait` is sent. A table that does
not fit is trimmed from the bottom — the nice-to-have props — never from the
top, which is what the request names; a trimmed row stays in the table as
`Generation: none — allowance`, so the reason is legible, and the player is
asked with the number before the trim — with no answer, the trim stands and
the summary says so — since only their explicit approval raises the allowance
(`npx genex budget --assets <credits> --user-approved`). The first batch is
the smallest set that makes the scene read — the player's body, whatever the
request names, and the first thing they walk up to — enqueued together with
`--no-wait` while you scaffold. Before a second batch starts, every id in the
first is collected with `npx genex wait --all`, loaded from a file in `src/`,
and seen in a capture. A batch begun while the previous one is still
uncollected is how a game ends up with an asset library and an empty world.
Both are enforced, not merely advised: unshipped generations are counted and
the generate commands refuse past a ceiling, which `npx genex preview` resets
to zero, and a paid command that would take the build past its allowance is
refused with the numbers, whatever the wallet holds. The ratchet has no total
— preview between batches and generate as much as the game needs; the
allowance is the total, and it is meant to be spent on the named things, not
left over. Preserve every id, URL and wiring state across a compaction.

## 5. Execute by working mode

### Focused change

Start directly. Read the touched files, preserve working systems, update the
relevant `DESIGN.md` section and `Now:`, execute the owning lane, and verify
the requested result. Skip unrelated discovery, module fan-out, UI/HUD
concepts, asset batches, and critic loops.

### Step by step

Set `Now:` to the chosen request-relevant part and build it. Preserve the
player's final requested outcome and every other unfinished promise under Open
commitments. When the step is previewed, ask what they want next only if their
latest message did not already say.

### Whole coordinated build

Turn the actual request into milestones and workstreams. The director may run
independent work in parallel and move through internal milestones without
asking the player to manage each one. Dependencies determine order; no fixed
module list does.

For every new game, preserve the platform foundations:

1. `$genex-threejs-embed-auth` owns identity and runs before boot code.
2. `$genex-threejs-adaptive-quality` owns device tiers, the runtime governor,
   and generated-asset rungs at boot.
3. `$genex-threejs-touch-controls` owns mobile input whenever its recipe fits.
4. `$genex-threejs-multiplayer` loads before networking code whenever 2+
   players share a world.

Record only content and world promises present in the request or essential to
its stated genre. Make them countable or otherwise observable before choosing
the paid asset batch. A requested large/open world records its intended scale,
terrain/ground, boundaries, and locations from the request; never silently
replace it with one small flat plane hidden by fog or impose fixed kilometer,
chunk, biome, or POI defaults. Generated-asset availability never decides how
much game the player receives. Ask one scope question only when a real
reduction is required.

There is **no startup game, UI, or HUD concept gate**. Schedule UI/HUD/menu at
the appropriate later milestone when the complete requested outcome includes
those surfaces. Enter that lane immediately when the player asks for it, and
skip it during unrelated focused work.

### When the UI/HUD/menu lane is invoked

**Generated UI art is opt-in.** A restrained interface built in clean CSS is a
finished, legitimate HUD—not a placeholder. Reach for the sprite lane
(`$genex-ai-hud`) when the game's own style genuinely wants drawn
chrome—ornate, painterly, comic, hand-made—or when the player asks for HUD art;
stylized games are where chrome earns its place. The art direction comes from
the game's brief in words. Generating ONE element you decided the game needs—a
frame, a mask, an icon, a wordmark, a menu backdrop, a menu video—is a normal,
first-class use of these tools, never a half-run pipeline.

Judgment governs *whether* art is generated; it never loosens *how well* it is
done. When you do run a stage, run its quality steps in full: `$genex-ai-hud`
and `$genex-ai-menu` keep their Stage-1/Stage-2 prompts, FAL calls, credits,
checkpoints, retries, extraction, masks, wiring, `npx genex ui audit`, nudges,
and preflights exactly as written, hard refusals included. Choosing to generate
one element rather than a whole set is a scope decision, not a bypass.

While a sprite or menu-video pipeline is actually in flight, `DESIGN.md` holds
its state so a context compaction can resume it: `HUD lane:`, `Menu video:`,
and the HUD pipeline stage IDs and paths. A game whose interface never runs a
generation lane records nothing there.

In both lanes, micro-text stays HTML text in the chosen font, and no generic
rectangular plate appears behind bars, digits, or icons; a genuinely shaped
plate comes from `npx genex ui plate`.

### Controls that move

For every game that moves, apply the screen-direction contract and record the
pointer bucket and input-direction convention:

- `$genex-threejs-camera-direction` owns pointer lock. First-person/FPS
  shooters and other mouse-aimed action keep it; cursor-core games and orbit
  showcases pass `pointerLockAim: false`; keyboard-only games lock the unused
  cursor during play.
- D/ArrowRight moves or turns screen-right, mouse-right turns the view right,
  and drag-pan axes share one convention. Copy the verified bases from the
  camera skill before writing hand-rolled signs.

## 6. Coordinate only when coordination helps

Whole coordinated mode may use sub-agents for independent, request-derived
workstreams. Focused work skips fan-out unless the requested task itself has
usefully independent pieces.

- One worker owns one disjoint file set. The main agent remains the integrator
  and only writer of shared boot, main-loop, and netcode files.
- Give each worker the `DESIGN.md` path, its exact row, owned files, relevant
  skill paths, and observable done condition. Workers do not spawn workers.
- A worker generates only Assets rows already marked `planned`; new wants
  enter as `proposed`. Whoever wires HUD output reads its mask/bbox files, not
  a prose summary.
- Do not create workers merely to write extra test suites or reports.

When the player asks for parallel work, repeated refinement passes, or a critic
reviewing your output, that request IS the instruction—wherever it reaches you,
including inside their answer to a question you asked. Adopt it as the working
mode immediately, starting with the work in front of you; never file it as a
later milestone or a final polish pass.

For a substantial, judgeable result in whole coordinated mode, a **fresh
critic may** inspect the actual game, rendered pixels, reference, or test
result—not the builder's summary. It returns the single largest meaningful
gap; the builder may address that gap and request another fresh look. This is
permission, not ceremony: no fixed round count, progress site, per-round
ledger, or user approval between internal rounds.

Stop when the requested acceptance is reached, improvement becomes immaterial,
the player redirects the work, or the available time/compute budget is spent.
A critic may identify a protected or paid-lane problem, but may not bypass,
rewrite, or automatically repeat that lane; follow-up still uses its existing
approval, checkpoint, retry, credit, and verification behavior.

## 7. The game's character (Meshy)—the player's body

**The game's own generated character is the player's body** wherever a human
body appears on screen. Third-person obviously; first-person too when remotes,
a look-down body, shadow, death/spectator camera, or menu portrait shows one.
“No human body ever appears” is the exemption—not “the camera is in the
head.” A genuinely non-person player (car, ship, RTS cursor, board) uses
`npx genex model` instead.

When this lane is relevant, put its row in the Assets table and enqueue it
when its milestone starts—or in parallel when whole coordinated mode makes
that useful. Its asset-specific concept review is its own beat—the one concept
step that survives, because the player is choosing a concrete thing they asked
for—and it never waits on another lane. `npx genex controller character`
installs the controller and fallback body; `loadPlayerCharacter` keeps the boot
path stable, and `npx genex controller character --character <id>` switches the
manifest when the generated body lands.

The profile VRM avatar is the fallback: a temporary body while generation
runs, or the stand-in when generation genuinely could not happen, recorded as
`Player character: VRM — <reason>`. A capsule or hand-built primitive is never
a shipped human body. In multiplayer, every remote wears the generated game
character when one exists.

**The default lane has no user stop.** When the user names a visual
reference, inspect references before writing the concept prompt. Generate
exactly three concepts, all neutral A-pose; never use a dynamic concept pose
or silently fall back to T-pose. Warn that held, slung, or overlapping props
and straps can fuse into the body or obscure limbs, and recommend separate
gameplay props. Show the actual images, pick the strongest candidate
yourself, say which and why in chat, record the pick in `DESIGN.md`, and
proceed — the player can switch by saying so, and their word always outranks
your pick. The announced pick carries the lane:

`npx genex character preview <concept-id> --candidate <1|2|3> --user-approved`

Meshy 7 Image-to-3D first produces an unremeshed high-detail model. Show its
front, back, left, and right views and report its measured face count.
Preserve that model in R2. A triangle remesh at the face budget you approve
(10000-100000; 10000 for crowds, 20000-30000 for a third-person player
body)—not the high-detail source—is rigged and animated. In the default lane,
the pick authorizes that remesh:

`npx genex character finalize <preview-id> --user-approved --approve-remesh <faces> [--animation <action-id>…]`

When the player explicitly requested a custom character, keep the existing
two stops: wait for their explicit candidate selection before Image-to-3D,
then wait for their explicit approval of the remesh before finalize. The `--direct-text` legacy path is
not a substitute.

Load `$genex-ai-character`, search actions with
`npx genex animations search "<intent>" --json`, and never invent IDs. Meshy
limb rotations play unchanged. Never freeze hand tracks or apply post-mixer
arm, hand, leg, or foot corrections. Only horizontal root or hip translation
may be normalized for Rapier. The character controller owns collision and
world translation. Before handoff, visibly check idle, walk, run, crouch-idle,
crouch-move, and jump, plus every control the HUD advertises.

## 8. Verify in proportion to the request

Focused work verifies the focused result and the owning skill's required
evidence; it does not trigger a whole-project audit. A milestone preview uses
one smoke pass after the preview, not a new test suite.

- Always capture the relevant running result and exercise the changed control
  or interaction in its labeled direction.
- Once a generated HUD is wired, capture gameplay after a changing value
  (such as damage) so masks/fills are visible.
- Once menu video is wired, watch one full rendered loop using
  `$genex-ai-menu`'s seam check.
- Multiplayer uses the existing two-distinct-identity netcode feel gate.
- Character/animation uses the owning lane's pose, clip, and controller checks.

Judge evidence against the requested result and current `DESIGN.md`, fix
meaningful gaps, and move on. An explicit preview or publish request runs the
existing protected flow directly; report open commitments honestly rather
than restarting design discovery.

## 9. Say it straight

“Loaded” means you read a file. “Built” means the thing runs. “Done” means the
requested acceptance and relevant owning-lane checks are true. Never report a
skill as applied because you read it, an asset as wired because it generated,
or the full requested outcome as complete while Open commitments remain.

For an allowance increase or any approval question, call `ask_user` with `timeoutPolicy: no-consent`. A recommended option is not permission. On timeout the trim stands: keep the existing allowance and continue independent work. Use `assume-default` only for reversible design choices, never spending or permissions.
