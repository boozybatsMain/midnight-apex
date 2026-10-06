---
name: genex-lane-card
description: The asset belt on one page — the command, what comes back, how to place it so it is not a speck or a wall, what the build may spend, and what to do when a lane is dead. Read this before your first `npx genex model` or `npx genex character`. The full lanes are `$genex-ai-model` and `$genex-ai-character`; this card is what you need to not get it wrong.
---

# Genex · Lane card

## Object → mesh

```bash
npx genex model "weathered oak barrel, iron bands, damp staves" --no-wait
npx genex wait --all      # prints every id this project enqueued, with its URL
```

A specific prompt beats a noun: "barrel" gives you a barrel-shaped guess, the
line above gives you the one in your scene. The URL is permanent — paste it into
the loader, never download it into the repo.

## Player body → character

```bash
npx genex character "stylized desert courier, layered dust-worn cloth"
npx genex character preview <concept-id> --candidate 1 --user-approved
npx genex character finalize <preview-id> --user-approved --approve-remesh 10000
npx genex controller character --character <id>   # the whole integration
```

Look at the three concepts, pick the strongest yourself, say which and why, and
keep going. Never foreground-`wait` on a character stage — they take minutes.

## Place it — a GLB arrives at any scale, with any origin

```ts
const o = gltf.scene;
const box = new THREE.Box3().setFromObject(o);
const size = new THREE.Vector3();
box.getSize(size);
o.scale.multiplyScalar(TARGET_HEIGHT_M / size.y);  // the metres you want
box.setFromObject(o);                              // re-measure, then ground it
o.position.y -= box.min.y;
scene.add(o);
```

Skip this and the mesh is a speck or a wall — it is the single most common way a
generated asset ships broken. Rigged bodies mismeasure here; those go through
the controller's own boot path, not this snippet.

## Generate in batches you can finish

The belt has a **shipping ratchet**: generations that have not been shown to the
player are counted, and the count resets to zero every time you `npx genex
preview`. Hit it and the command refuses with the number and the fix.

It is not a spend limit (that is the allowance, next section) and it has no
total — preview between batches and generate as much as the game needs. What
it stops is one thing: fanning out a whole cast or a shelf of props before the
player has seen any of it. If you are refused, you are not out of anything.
You have work that nobody has looked at.

```bash
npx genex model "..." --no-wait   # a batch you can finish
npx genex wait --all              # collect it
# wire it, then:
npx genex preview                 # free, seconds — and the count is zero again
```

## Generate what the wallet can carry

Every build also has an **asset allowance** — a slice of the account's credits,
sized from the live balance the first time a paid command runs and held still
after that. `npx genex budget` prints it live: balance, spendable, the
allowance, spent this build, remaining, and the price of every kind. Run it
before the first batch and after each preview.

The allowance is a ceiling, not a target. Unspent allowance is not unfinished work. Start with one reusable implementation per required role, and add variants only when reuse leaves a demonstrated requirement unmet. Plan the asset table against it: the named
things first, then what makes the scene read, on the cheapest lane that reaches
the bar. If the plan needs more than it holds, ask the player with the number
BEFORE trimming; only their word raises it (`npx genex budget --assets
<credits> --user-approved`). If no answer comes and the build must proceed,
generate the named things first, code-build the rest, and say so in the
summary. A refusal past the allowance means the build has reached its
allowance, not that the account is empty; failed generations are refunded and
do not count.

## The one rule

An asset is not done when the command exits. It is done when something in
`src/` loads it, you have run the game, and you have LOOKED at it. A generation
nobody wired is money spent on nothing — `npx genex wait --all` marks a row
`wired` only once its URL appears in your source.

## When a lane is dead

A lane whose provider wallet is empty fails every call and refunds every one.
`npx genex doctor` prints each lane live/mock/paused with its credit state. If a
lane is red: **build that thing in code and move on** — do not re-run it, and do
not stall the game waiting for it. Say in chat what you fell back to.

Use `timeoutPolicy: no-consent` for allowance questions. Background populations reuse procedural bodies/motion or compatible existing rigs; catalog animation needs a compatible skeleton and can be paid. Custom character workflows serve the player body and close interactions, subject to explicit user direction.
