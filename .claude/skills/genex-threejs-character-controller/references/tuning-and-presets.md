# Presets and tuning

Every option has a tuned default — start from a preset and override only what
feels wrong. Spread the preset's `options` into the constructor:

```ts
import { characterPresets } from "./controllers/character/presets.ts";

const character = new CharacterController(world, camera, {
  ...characterPresets["platformer-snappy"].options,
  maxRunVel: 8, // your overrides win
  userData: { controller: { excludeVehicleRay: true } },
});
```

## Preset table

| Preset | Provenance | Assumed density | Feel |
| --- | --- | --- | --- |
| `default` | ported library defaults, verbatim | 1 | balanced third-person: walk 2 m/s, run 5 m/s, decisive jump, moderate grip |
| `heavy-body-reference` | ported demo tuning, verbatim | **200** | heavy body with proportionally stiff springs — the reference for the scaling rule below |
| `platformer-snappy` | Genex-authored | 1 | quick starts/stops, strong jump + heavy fall, extra air control, hold-to-run |
| `souls-heavy` | Genex-authored | 1 | weighty, committed movement; low deliberate jump; pronounced run lean |
| `moon-bounce` | Genex-authored | 1 | long floaty jumps — **requires world gravity `(0, -1.62, 0)`**; the preset does not set world gravity for you |
| `ice-slide` | Genex-authored | 1 | near-zero grip, wide sliding turns |

Every preset states the collider `density` it was tuned for
(`assumedDensity`, mirrored into `options.density`). That matters because of:

## The density/spring scaling rule

The float spring and auto-balance springs apply raw impulses, so they scale
roughly **linearly with body mass** (mass = density × capsule volume). Change
`density` (or the capsule size) and the springs must scale in the same
proportion or the character sinks/oscillates/faceplants. The two shipped
anchor points:

| Option | density 1 (`default`) | density 200 (`heavy-body-reference`) |
| --- | --- | --- |
| `springK` | 80 | 6400 |
| `dampingC` | 6 | 860 |
| `autoBalanceSpringK` | 0.5 | 50 |
| `autoBalanceDampingC` | 0.03 | 3 |
| `autoBalanceSpringOnY` | 0.08 | 8 |
| `autoBalanceDampingOnY` | 0.006 | 0.76 |

Recipe for "make the character feel heavier": raise `density`, multiply those
six constants by the density ratio as a starting estimate (the reference
values are hand-tuned near that line, not exactly on it), then fine-tune —
pogo bounce means `dampingC` too low, sticky landings too high, slow-motion
tip-overs mean the `autoBalance*` pair is too soft.

## "User says X → tune Y" map

| The user says | Change |
| --- | --- |
| "it's slippery / skates around" | raise `slideGripFactor` (default 0.5; `ice-slide` uses 0.05) |
| "falling feels floaty" | raise `fallingGravityScale` (default 3) |
| "jump too weak / too strong" | `jumpVel` (default 5 m/s); `jumpDuration` (default 0.1 s) stretches the takeoff window |
| "it walks up cliffs / slopes that should slide" | lower `slopeMaxAngle` — **default is `Math.PI / 2.5` = 72°, so a 50° ramp is walkable out of the box**; `Math.PI / 4` makes 45°+ slide |
| "should climb steeper slopes" | raise `slopeMaxAngle` |
| "feels heavier / like a tank" | `souls-heavy` preset, or raise `density` + apply the spring scaling rule above |
| "sluggish to start / stop" | raise `accDeltaTime` / `decDeltaTime` (responsiveness in (0, 1]; default 0.2 — higher is snappier) |
| "drifts sideways through turns" | raise `rejectVelFactor` toward 1 (default 1; `ice-slide` lowers it to 0.2) |
| "too slow / too fast" | `maxWalkVel` (default 2) / `maxRunVel` (default 5) |
| "run should be hold, not toggle" | `enableToggleRun: false` (default true = Shift toggles) |
| "sneaks too fast / too slow" | `crouchSpeedRatio` (default 0.45 × `maxWalkVel`) |
| "can't fit under the obstacle when crouched" | lower `crouchCapsuleScale` (default 0.6 — the crouched capsule's cylinder half-height as a fraction of standing; the head drops by `2*(1-scale)*capsuleHalfHeight`) |
| "crouch should be hold, not toggle" | `crouchMode: "hold"` (default `"toggle"` — C flips it) |
| "no control in the air" | raise `airDragFactor` (default 0.1) |
| "falls too fast at terminal velocity" | `fallingMaxVel` (default 20 m/s) |
| "leans too much when running" | lower `moveImpulsePointOffset` (default 0.5; 0 = no lean). That same offset is why a dash must never use an impulse — see the dash recipe below |
| "wobbles / tips over" | raise `autoBalanceSpringK` + `autoBalanceDampingC` |
| "turns to face direction too slowly" | raise `autoBalanceSpringOnY` |
| "grounded flag flickers on stairs / ledges" | raise `rayHitForgiveness` (default 0.28) |
| "bounces on landing (pogo)" | raise `dampingC`; "sticks to the ground on landing" → lower it |
| "hovers too high / feet in the floor" | `floatHeight` (default 0.2) — and re-check the model's foot offset (wiring reference) |
| "should always face the camera (strafe/shooter)" | `lockForward: true`, or `setLockForward(true)` at runtime |
| "jump should push off slopes" | `slopeJumpFactor` (default 0 = straight up, 1 = off the slope normal) |
| "moon / low gravity" | `moon-bounce` preset **plus** `PhysicsWorld.create({ gravity: [0, -1.62, 0] })` |
| "camera feels laggy / rubber-bandy" | `FollowCamera` `smoothTime` (0.05 snappy → 0.25 cinematic) |
| "camera clips through walls" | add the static level meshes to `FollowCamera` `colliderMeshes` |

## Sizing a different character

`capsuleHalfHeight` (default 0.3) and `capsuleRadius` (default 0.3) define the
collider: total capsule height = `2 * (capsuleHalfHeight + capsuleRadius)` =
1.2 by default, floating `floatHeight` above the ground. For a bigger
character scale both, remember the ground-query defaults derive from them
(`rayLength = capsuleRadius + 1`, `rayRadius = capsuleRadius / 2`,
`rayOriginOffset = -capsuleHalfHeight`), and re-tune the springs — a bigger
capsule is a heavier body at the same density.

## Do-not-touch list

- `friction: -0.5` on the capsule is intentional (negative averages against
  the ground and keeps the capsule from grabbing walls); traction comes from
  the controller's own grip model, not collider friction.
- Ground detection: `"shapeCast"` (default) is forgiving on stairs and ledge
  edges; `"rayCast"` is cheaper and stricter. Switch at runtime with
  `setGroundDetection(...)` — don't hand-roll a third scheme.
- Platform behavior (`followPlatform`, `applyCounterMass`,
  `applyCounterJumpImp`, `applyCounterMoveImp`) defaults to physically-honest
  and already handles moving/rotating platforms; only touch these for
  deliberate arcade effects.

## Dash, dodge, roll — burst movement

**Never use `applyImpulse` / `applyImpulseAtPoint` on the character body.**

The controller applies its normal movement impulse ABOVE the centre of mass, at
`moveImpulsePointOffset` (default 0.5), because that offset is what produces the
run lean. An impulse applied off-centre is a force AND a torque. When the
character is standing still the torque is small; when they are already moving it
adds to the existing lean and the character pitches over backwards.

Measured on a real dash: **60.3° of backward lean while moving, 0° from a
standing start.** That "only breaks when I'm running" signature is the tell, and
it sends you hunting the animation instead of the impulse.

Use `setActionMotion`, which drives `setLinvel` — velocity, no torque — while
Rapier keeps gravity, slopes and collisions:

```ts
// ONE number is yours: how far a dash should carry the character, in metres.
// Everything else derives from it and from the controller's OWN run speed, so
// a dash stays in proportion when you retune movement and you are never
// copying somebody else's game feel. (A dash that reads as a burst is roughly
// 2-3x run speed; below ~2x it reads as a sprint, above ~4x as a teleport.)
const DASH_DISTANCE = 5;                       // metres — YOUR game lives here
const RUN_SPEED = preset.options.maxRunVel ?? 5;
const DASH_SPEED = RUN_SPEED * 2.8;
const DASH_TIME = DASH_DISTANCE / DASH_SPEED;
const EXIT_SPEED = RUN_SPEED;                  // see endDash

function startDash(): void {
  dashLeft = DASH_TIME;
  // Freeze the direction at the moment of the press: a dash that keeps
  // steering is a strafe, not a dash.
  dashDir.copy(worldMoveDir.lengthSq() > 0 ? worldMoveDir : bodyForward).normalize();
  anims.playUpperBody("Dodge_Right");   // a dodge is full-body; see below
}

function driveDash(dt: number): void {
  // RE-PROJECT EVERY STEP. setActionMotion takes a BODY-LOCAL velocity, and the
  // body rotates during the dash — a direction captured once in local space
  // curves the dash into an arc.
  local.copy(dashDir).applyQuaternion(bodyQuat.clone().invert());
  controller.setActionMotion({ x: local.x * DASH_SPEED, z: local.z * DASH_SPEED });
  dashLeft -= dt;
  if (dashLeft <= 0) endDash();
}

function endDash(): void {
  controller.setActionMotion(null);
  // Clamp the exit velocity to normal run speed. Handing the full burst speed
  // straight back to the controller makes it brake hard, and the brake is an
  // impulse at the same offset — which re-creates the lean you just avoided.
  // Measured: 19.8° of hand-off lean before the clamp, 4.6° after.
  const v = body.linvel();
  const planar = Math.hypot(v.x, v.z);
  if (planar > EXIT_SPEED) {
    const k = EXIT_SPEED / planar;
    body.setLinvel({ x: v.x * k, y: v.y, z: v.z * k }, true);
  }
}
```

Two more things that are not optional:

- **Suppress steering input for the duration.** Feed the controller no movement
  while `dashLeft > 0`, or its own movement impulse fights the action motion —
  and that impulse is the torque you are avoiding.
- **A dodge is full-body; an attack is not.** A dodge SHOULD stop the legs doing
  their own thing, so `playOneShot` (or `playUpperBody`, which falls back to it
  on a rig it cannot split) is right. A swing that happens *while* running wants
  the upper-body layer instead — see `references/animations.md`.
