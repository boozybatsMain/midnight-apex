---
name: genex-threejs-visual-validation
description: Validate Genex Three.js game visuals in a real browser. Use for fixed-view captures, no-post baselines, diagnostic mosaics, seed sweeps, camera-distance checks, temporal stability, interaction smoke checks, render-target inventories, GPU budgets, and evidence before claiming a 3D scene is done.
---

# Genex Three.js Visual Validation

Evaluate the mechanism that creates the image. A beautiful hero screenshot can hide unstable fields, broken depth, seed failures, or post-processing dependence.

## Validation sequence

1. Freeze deterministic inputs.
2. Capture the no-post baseline.
3. Capture system-specific diagnostic views.
4. Test the intended camera-distance envelope.
5. Sweep representative seeds and parameter extremes.
6. Test motion and temporal stability.
7. Record image, geometry, memory, and timing budgets.
8. Keep a small regression set tied to visual invariants.

## Meshy character approval evidence

Before generating a Meshy character, discuss two or three visual directions.
When the user names a visual reference, inspect references before writing the
concept prompt. Recommend a neutral A-pose for characters that will be rigged.

Generate concept images first and show the actual images to the user. In the
default lane the agent picks the strongest candidate and announces it; when
the player explicitly requested a custom character, do not start Image-to-3D
until they explicitly select a candidate. Validation must show all three
actual concept images, confirm that every candidate uses a neutral A-pose,
and preserve the recorded choice — the agent's announced pick in the default
lane, the player's explicit candidate selection in the custom lane. A task
ID, filename, or agent summary is not visual evidence. Dynamic concept poses
and silent T-pose fallbacks fail this checkpoint. Warn when held, slung, or
overlapping props or straps can fuse into the character or hide a limb.

Meshy Image-to-3D first produces an unremeshed high-detail model. Show its
front, back, left, and right views and report its measured face count. Preserve
that model in R2. The triangle remesh at the approved face budget (10,000
by default; up to 100,000 for a hero)—not the high-detail
source—is rigged and animated. In the default lane the remesh proceeds
directly; for a player-requested custom character, wait for their explicit
approval first (question tool when you have one; a short numbered list in
chat otherwise).

The selected high-detail model remains in a neutral A-pose before animation.
Record evidence that the four views and face count were shown in chat before
`--approve-remesh 10000` was used — and, in the custom lane, that the player
approved. Historical Meshy characters remain valid;
do not demand a silent regeneration or upgrade.

Meshy limb rotations play unchanged. Never freeze hand tracks or apply
post-mixer arm, hand, leg, or foot corrections. Only horizontal root or hip
translation may be normalized for Rapier.

## Interaction smoke check (the game fast path)

For plain game tasks — nothing from the procedural/visual-system pack loaded —
this is the whole acceptance gate: a smoke check,
not a certification. Run it ONCE per milestone, against that milestone's
`genex preview` build. That build is on the preview URL, not the one players
are on, so checking it disturbs nobody. Catch obvious
breakage, fix what's clearly broken, and hand the feel/polish judgment to the
player — don't loop re-testing the same build, don't re-test after cosmetic
tweaks (sounds, colors, tuning values), and don't try to exercise every button
and edge case yourself. This browser check is the only testing a game draft
needs: never add unit tests or a test framework to a game unless the user asks.
The player deciding "does it feel right?" is faster and truer than you clicking
everything twice.

1. Load the page in a real browser; the canvas renders (no black screen, no
   console errors — and no console WARNING naming a removed three.js API or
   `GL_INVALID_OPERATION`: those arrive at warn level and each one is a mesh
   the driver refused to draw, `$genex-threejs-shadow-systems` has the case). For an unpublished draft, open the dev server in local
   test mode — `http://localhost:5173/?genex_local_test=1` (the embed-auth
   skill's "Self-testing a draft" section) — so you see the game, not the
   sign-in gate. Then hit-test the screen that is up (title now, pause later):
   for every visible button, `document.elementFromPoint(cx, cy)` at its centre
   must return the button or one of its descendants — a top hit whose
   effective (inherited) opacity is 0 is an invisible screen still laid out
   over this one (a `display` rule on `.screen` defeating `hidden`, or an
   `opacity: 0` screen keeping `pointer-events: auto`), and nobody can enter
   the game. `$genex-threejs-game-ui` has the one-paste check and the fix.
2. Press each documented control once (keys, pointer); assert a **visible
   response in its labeled direction** — this is the input-direction pass, and
   it is part of THIS check, not an extra testing loop. Hold `KeyD`/ArrowRight
   ~0.5s and screenshot-diff: the controlled thing moves or turns toward
   screen-RIGHT (for a pan camera the viewport slides right — the terrain
   streams LEFT); `KeyA`/ArrowLeft mirrors it. Keyboard synthesis needs no
   pointer lock, so this works headless. For drag rigs, drag right AND drag up:
   both axes must follow the one stated convention (grab-the-world or
   move-the-camera — never one each). A response in the WRONG direction is a
   fail, not a note: two shipped games passed "controls respond" while D
   steered screen-left. For an animated character, capture idle, walk, run,
   crouch-idle, crouch-move, and jump. Inspect shoulders, elbows, wrists, and hands as well
   as the feet: a fully bound non-T-pose can still be stylistically broken.
   Reject shrugging palms-up poses, permanently raised elbows, or a gait whose
   upper-body style contradicts the requested character. “No T-pose” is not
   an animation-quality check.
   For Meshy characters, crouch passes only when the capsule behavior and a
   visibly crouched pose both respond. If a control calls `playOneShot()`, a
   false result or missing-clip warning is an installation failure even when
   locomotion continues normally.
   During Meshy validation, record the action ID actually bound to every slot.
   A public preview is not evidence when the game is playing a different clip
   or a rig-basic fallback. Meshy limb rotations play unchanged. Never freeze
   hand tracks or apply post-mixer arm, hand, leg, or foot corrections. Only
   horizontal root or hip translation may be normalized for Rapier. If a
   native pose is bad or a required binding is missing, stop and regenerate.
3. Capture one screenshot of live gameplay — of the **game**, not a sign-in
   gate or loading screen. A capture of the SDK's "Sign in to play" overlay is
   NOT gameplay evidence. Evidence captured in local test mode must be labeled
   as such in the handoff ("local test mode — auth, saves, and multiplayer not
   exercised"); presenting it as full validation is an over-claim.
4. In that screenshot, check oriented models: the hero faces its travel
   direction, and NPCs driven by chase/aim code face their target. A model
   rotated 90° reads as broken — `$genex-ai-model` has the one-time facing
   fix. **In any two-character or enemy-encounter capture, the characters
   face their TARGET, not the camera** — Meshy/Mixamo/VRM rigs rest facing
   +Z (straight at a side camera), so an unset yaw ships duelists staring
   at the lens; and a rig "turned" with `scale.x = -1` is a defect even
   when it looks right from one angle (negative scale flips a SkinnedMesh's
   winding and normals — the character-controller skill has the rules).
5. Vehicles get one extra pass: drive forward once and confirm the NOSE
   leads (a 180° body is this bug's favorite disguise), and check the body
   stands ON the road with its wheels inside the silhouette — a body
   floating above detached wheels means the model was box-fit against the
   preset's wheelbase (the vehicle skill's "Custom generated bodies" rules
   fix it).
6. The cursor pass — every game, per the lock-or-tool rule: during play the OS
   cursor is either the gameplay tool (cursor-core — confirm the explicit
   `pointerLockAim: false` opt-out, cursor stays) or it is LOCKED away; a
   non-cursor-core game with the arrow parked over the action is a defect, even
   a keyboard-only racer. Aim games additionally: click the canvas and assert
   the pointer locks (cursor gone, mouse-RIGHT turns the view RIGHT and
   mouse-UP looks UP — name BOTH axes; yaw-only evidence has let inverted pitch
   ship); press Esc and assert the "click to aim/resume" cue appears. The cue
   should be the bundled `createAimCue` helper (or an equivalent
   `onAimChange`-driven overlay) — a MANDATORY-bucket game with no unlocked cue
   fails. Games with a menu additionally: on the main menu, click one item that
   does NOT start play (Settings/Options/Credits) — the cursor must remain
   visible; the lock may only ever engage from the Play/Resume click or a
   gameplay canvas click (the phase binding `setPaused(phase !== "playing")` is
   what guarantees this — check it rides `setPhase`, not the render loop).
   Headless caveat, measured on Chromium 151: `requestPointerLock` does NOT
   throw — it locks, with or without a user gesture, so the lock and the
   unlocked cue ARE yours to assert headless. What does not survive is the
   both-axes look check: synthesised mouse movement cancels to a net zero
   delta, so turning right then left proves nothing about direction. Assert the
   wiring and the cue in a screenshot, and say plainly that confirming which way
   the view turns needs one manual pass with a real mouse.
7. **Ask the scene the three things the screenshot cannot answer** (below). Run it
   once, in the same browser you already have open.

### The screenshot has four blind spots — query them

A capture of the whole arena is taken from one camera at one distance. Three real
defect classes are invisible in it and all shipped to players:

- **Texture scale on faces you aren't looking at.** A shipped game's wall tops
  were 1:102 — the steel texture read as wooden planks — while the wall *sides*,
  the faces at eye level, were a near-perfect 1.2:1. Nothing in the screenshot
  says which is which; the numbers do.
- **Post-grade grain that shimmers.** A still frame cannot show a temporal
  effect. Animated film grain — a noise term re-seeded by time every frame —
  ripples across the entire screen in motion and reads as a cheap noise sheet
  laid over the game; a screenshot looks fine. It shipped this way in a real game
  (64.5% of a static floor's pixels changed frame-to-frame from grain alone).
- **Coplanar surfaces.** Two boxes overlapping with faces at the same height
  z-fight. It may look stable in a still and flicker the moment the camera
  moves, so a screenshot is the one tool guaranteed to miss it.

Expose the scene in dev (`if (import.meta.env.DEV) (window as any).__scene = scene;`),
then paste this into the browser console once and read the verdict. It needs no
imports — pass it straight to your JS-eval tool.

```js
(() => {
  const S = window.__scene, MIN_M2 = 1.0;   // judge real faces, not GLB slivers
  const out = { stretched: [], zfight: [], skipped: [] };
  const xf = (e,x,y,z) => [e[0]*x+e[4]*y+e[8]*z+e[12], e[1]*x+e[5]*y+e[9]*z+e[13], e[2]*x+e[6]*y+e[10]*z+e[14]];
  const sub = (a,b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
  const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const len = a => Math.hypot(a[0],a[1],a[2]);
  const comb = (a,s,b,t) => [a[0]*s+b[0]*t, a[1]*s+b[1]*t, a[2]*s+b[2]*t];

  // metres-per-tile along U and V, from each triangle's UV Jacobian. Geometry
  // agnostic — a box, a plane and a GLB all measure the same way — and it reads
  // texture.repeat, so it sees what the GPU will actually draw.
  S.traverse(o => {
    if (!o.isMesh) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const g = o.geometry, uv = g.attributes && g.attributes.uv;
    if (!m || !m.map || !uv) return;
    const pos = g.attributes.position, idx = g.index, e = o.matrixWorld.elements;
    const rx = m.map.repeat.x, ry = m.map.repeat.y, faces = new Map();
    for (let t = 0; t < (idx ? idx.count : pos.count) / 3; t++) {
      const ix = [0,1,2].map(k => idx ? idx.getX(t*3+k) : t*3+k);
      const p = ix.map(i => xf(e, pos.getX(i), pos.getY(i), pos.getZ(i)));
      const e1 = sub(p[1],p[0]), e2 = sub(p[2],p[0]);
      const nc = cross(e1,e2), area = len(nc)/2;
      if (area < 1e-6) continue;
      const nn = nc.map(v => v/(area*2));
      const U = ix.map(i => uv.getX(i)*rx), V = ix.map(i => uv.getY(i)*ry);
      const du1 = U[1]-U[0], dv1 = V[1]-V[0], du2 = U[2]-U[0], dv2 = V[2]-V[0];
      const det = du1*dv2 - du2*dv1; if (Math.abs(det) < 1e-12) continue;
      const a = len(comb(e1, dv2/det, e2, -dv1/det));
      const b = len(comb(e2, du1/det, e1, -du2/det));
      const k = nn.map(v => v.toFixed(1)).join(",");
      const f = faces.get(k) || { area:0, u:0, v:0 };
      f.area += area; f.u += a*area; f.v += b*area; faces.set(k, f);
    }
    for (const [k,f] of faces) {
      if (f.area < MIN_M2) continue;
      const mu = f.u/f.area, mv = f.v/f.area, asp = Math.max(mu/mv, mv/mu);
      if (asp > 1.5) out.stretched.push({ mesh:o.name||o.type, face:k, aspect:+asp.toFixed(1),
                                          m2:+f.area.toFixed(1), mPerTile:`${mu.toFixed(2)}x${mv.toFixed(2)}` });
    }
  });
  out.stretched.sort((a,b) => b.m2 - a.m2);   // biggest surfaces first

  // z-fight: opaque depth-writing faces that LIE IN the same axis-aligned
  // world plane, facing the SAME way, with overlapping area. Butted solids —
  // faces meeting back-to-back, opposite normals — are safe and never flagged
  // (backface culling hides one of the two). Instanced meshes are expanded.
  const FIGHT_M2 = 0.04, PE = 1e-3;
  const mul = (A,B,o) => { const r = new Array(16);
    for (let c = 0; c < 4; c++) for (let w = 0; w < 4; w++)
      r[c*4+w] = A[w]*B[o+c*4] + A[4+w]*B[o+c*4+1] + A[8+w]*B[o+c*4+2] + A[12+w]*B[o+c*4+3];
    return r; };
  const byMesh = [];
  S.traverse(o => {
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!o.isMesh || !m || m.transparent || m.depthWrite === false) return;
    const g = o.geometry, pos = g.attributes.position, idx = g.index;
    const tris = (idx ? idx.count : pos.count) / 3, insts = o.isInstancedMesh ? o.count : 1;
    const name = o.name || o.type;
    if (tris * insts > 300000) { out.skipped.push(name); return; }
    const mats = [];
    if (o.isInstancedMesh) { const a = o.instanceMatrix.array, w = o.matrixWorld.elements;
      for (let i = 0; i < insts; i++) mats.push(mul(w, a, i*16)); }
    else mats.push(o.matrixWorld.elements);
    const planes = [];
    for (const e of mats) for (let t = 0; t < tris; t++) {
      const ix = [0,1,2].map(k => idx ? idx.getX(t*3+k) : t*3+k);
      const p = ix.map(i => xf(e, pos.getX(i), pos.getY(i), pos.getZ(i)));
      const nc = cross(sub(p[1],p[0]), sub(p[2],p[0])), l = len(nc);
      if (l < 1e-9) continue;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(nc[k]/l) < 0.999) continue;      // axis-aligned faces only
        for (const s of (m.side === 2 ? [1,-1] : [Math.sign(nc[k])])) {  // 2 = DoubleSide
          const u = (k+1)%3, v = (k+2)%3, c = p[0][k];
          let pl = planes.find(q => q.k === k && q.s === s && Math.abs(q.c - c) < PE);
          if (!pl) planes.push(pl = { k, s, c, area: 0, lo:[Infinity,Infinity], hi:[-Infinity,-Infinity] });
          pl.area += l/2;
          for (const q of p) { pl.lo[0] = Math.min(pl.lo[0], q[u]); pl.hi[0] = Math.max(pl.hi[0], q[u]);
                               pl.lo[1] = Math.min(pl.lo[1], q[v]); pl.hi[1] = Math.max(pl.hi[1], q[v]); }
        }
      }
    }
    let kept = planes.filter(pl => pl.area >= FIGHT_M2);
    if (kept.length > 500) kept = kept.sort((x,y) => y.area - x.area).slice(0, 500);
    // overlapping coplanar faces WITHIN one mesh (a floor added twice, merged dups):
    for (const pl of kept) {
      const bb = (pl.hi[0]-pl.lo[0]) * (pl.hi[1]-pl.lo[1]);
      if (pl.area > bb * 1.02 + 1e-6)
        out.zfight.push({ a: name, b: name + " (itself)", plane: "xyz"[pl.k] + "=" + pl.c.toFixed(3) });
    }
    byMesh.push({ name, planes: kept });
  });
  for (let i = 0; i < byMesh.length; i++) for (let j = i+1; j < byMesh.length; j++)
    for (const a of byMesh[i].planes) for (const b of byMesh[j].planes) {
      if (a.k !== b.k || a.s !== b.s || Math.abs(a.c - b.c) >= PE) continue;
      const du = Math.min(a.hi[0],b.hi[0]) - Math.max(a.lo[0],b.lo[0]);
      const dv = Math.min(a.hi[1],b.hi[1]) - Math.max(a.lo[1],b.lo[1]);
      if (du > 0 && dv > 0 && du*dv >= FIGHT_M2)
        out.zfight.push({ a: byMesh[i].name, b: byMesh[j].name,
          plane: "xyz"[a.k] + (a.s > 0 ? "+" : "-") + "=" + a.c.toFixed(3), overlapM2: +(du*dv).toFixed(2) });
    }
  return out;
})()
```

Read it as: **`stretched` should be empty.** Every entry is a face over a square
metre whose texels aren't square; `mPerTile` gives you the actual numbers, and
`m2` tells you whether it's a kerb or a wall. `MIN_M2` is there because a
generated GLB's authored UVs produce hundreds of tiny-triangle readings that
drown the real finding — raise it if a model still floods the list, and note in
the handoff that you did.

**`zfight` should be empty.** Every entry is two opaque, depth-writing surfaces
lying IN the same plane, facing the same way, with real shared area — exactly
the geometry that flickers the moment the camera moves. Flat-on-flat counts (a
road quad at the ground's exact y, a decal flush on a wall), instanced kit
pieces are expanded per instance, and an `(itself)` entry means one mesh
carries overlapping coplanar faces — usually the same floor added twice.
Butted solids whose faces meet back-to-back are safe and never flagged, so
keep butting kit pieces end to end. `skipped` names meshes too heavy to scan
(>300k effective triangles).

Both are wiring defects, so fix the wiring: `worldUV` (`$genex-ai-texture`)
for the first; for a `zfight` pair, give the surfaces a real gap (1–2 mm
indoors, ~1 cm at city scale), or let a decal win with `polygonOffset: true,
polygonOffsetFactor: -1, polygonOffsetUnits: -1` + `depthWrite: false`.
Near-coplanar shimmer in the DISTANCE with no pair listed here is the camera's
depth range, not geometry — `cameraNearFar` + `depthRendererOptions()` from
the quality kit's `depth.ts` own that (`$genex-threejs-adaptive-quality`).

Run against the shipped BomberDome build, this printed `aspect: 102, m2: 17,
mPerTile: "0.17x17.00"` for the wall tops, and the interpenetrating wall pairs
sharing their top plane at y=2.40. Both had been in front of the agent for an
hour of screenshots.

**Grain shimmer — inspect the mechanism, not the pixels.** A pixel diff is
confounded by the scene's own ambient motion; the deterministic check is to read
the post stack. Expose the composer in dev alongside the scene
(`if (import.meta.env.DEV) (window as any).__composer = composer`), then:

```js
(() => {
  const passes = (window.__composer && window.__composer.passes) || [];
  const suspect = [];
  for (const p of passes) {
    const fs = p.material && p.material.fragmentShader;
    if (!fs) continue;
    const names = Object.keys(p.material.uniforms || {});
    // a grain/noise term, by shader text OR a uGrain-style uniform
    const hasGrain = /grain|\bnoise\b|fract\s*\(\s*sin|\bhash\s*\(|\bign\s*\(/i.test(fs)
      || names.some(u => /grain|noise/i.test(u));
    // a time-ish uniform actually referenced in the fragment shader
    const timeU = names.find(u => /time|frame|seed|tick/i.test(u) && new RegExp('\\b' + u + '\\b').test(fs));
    if (hasGrain && timeU) suspect.push({ pass: p.constructor.name, timeUniform: timeU });
  }
  return suspect; // ideally empty
})()
```

A non-empty result means the grade has grain AND a per-frame time uniform — very
likely the grain is re-seeded every frame and shimmers. Confirm which the time
term drives; if it's the grain, make it **static** (drop the time term) or reseed
at ≤12 Hz, seeded on `gl_FragCoord.xy` and luminance-weighted —
`$genex-threejs-exposure-color-grading` has the recipe. This is the exact defect
an owner described as "some texture rippling over the whole screen."

Everything deeper (baselines, seed sweeps, mosaics, budgets) belongs to
visual-system work — the sequence above.

## Required evidence

- fixed camera and seed manifest;
- final and no-post captures;
- field/pass diagnostic mosaic;
- near, design, and far camera views;
- at least one stress seed;
- frame-time and render-target inventory;
- written invariants and known compromises.

## Failure conditions

- a MANDATORY-bucket aim game never requests pointer lock, or locks with no
  visible unlocked cue;
- a movement key or look axis whose on-screen direction contradicts its label
  (D turning the vehicle screen-left, mouse-up looking down with no invert
  option);
- drag-pan axes that mix conventions (one axis grab-the-world, the other
  move-the-camera);
- a non-cursor-core game that leaves the OS cursor visible during play;
- a menu or settings click locks the pointer (or the cursor vanishes) while a
  menu screen is still up;
- a title, boot, or pause button whose centre hit-test returns an element of a
  screen that is not visibly up (effective opacity 0) — an invisible overlay is
  swallowing the click;
- approval relies on a single frame;
- post-processing cannot be disabled per pass;
- random seeds are not reproducible;
- GPU time is inferred only from CPU frame time;
- temporal artifacts are judged from still images;
- comparison thresholds ignore intentional stochastic pixels without stabilizing them.

## Routing boundary

This skill evaluates an implementation; it does not supply the implementation
mechanism. Load the subject or image-effect skill first, then use this protocol
to decide whether the result is acceptable.

## Audio and dark phases in the same smoke check

A still cannot prove audible output. Use the [development-only final-mix check](references/genex-audio-output.md) after a real gesture and trigger an intended audible event. Require observed peak RMS **> 0.002**, at least ten running-context samples, and mute off; missing evidence is unknown. Record context state, sample count, RMS, mute and event. Loaded audio and graph edges alone are not audibility.

For games with a dark playable phase, observe the darkest intended phase through the game's real controls or time progression and capture it, then follow $genex-threejs-exposure-color-grading. No dark-phase observation means unknown, never an assumed pass. Add these observations to the existing milestone smoke check rather than starting a repeated inspection loop.
