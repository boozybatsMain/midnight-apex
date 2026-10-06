---
name: genex-asset-author
description: Author and publish ONE asset to the free Genex asset library via `genex asset new` — STRICTLY user-initiated. Use ONLY when the user explicitly asks to publish something from their game as an asset, or to create a standalone asset for the library. Never suggest, offer, or trigger this lane on your own — building a game never requires it.
---

# Genex Asset Author

Ship one procedural Three.js asset to the free, MIT-licensed Genex asset
library: a standalone project whose build is a uniform orbitable viewer, whose
only varying file is ONE self-contained TypeScript factory module, and whose
quality bar is 17 machine-checked gates.

## When this lane runs — and when it must not

Run it ONLY when the user explicitly asks — the two real shapes:

- **"Publish this <thing> from my game as an asset"** — extract an object out
  of the game they're building.
- **"I want to make an asset / assets"** — asset-first authoring.

NEVER offer this unprompted. Finishing a game, noticing a nice prop, or
wanting to showcase work is NOT a trigger; the user's request is. If they ask
what publishing an asset means, explain (free, MIT, copyable by anyone from the
dashboard, listed under the gallery's Assets tab) and let them decide.

## The one non-negotiable before publish: MIT with THEIR name

A published asset gets a **Copy code** button on its page — anyone can take the
file. Publishing = releasing it under MIT. Before scaffolding, ask the user for
their attribution name and pass it as `--holder "<name>"`. If it was skipped,
set it before publish in BOTH places: `asset.config.json` → `license.holder`,
and line 2 of the module (the MIT header). Never publish with the placeholder.

## Scaffold

```bash
npx genex asset new <kebab-slug> --title "<Display Name>" \
  --dims WxDxH --tri-band LOW-HIGH --holder "<user's name>"
cd <kebab-slug>
npm install
npx playwright-core install chromium   # once per machine
```

One asset = one project = one turntable page. Several assets → run the command
once per asset. `--dims` is width x depth x height in metres as a human states
it (gate G4 measures the built model against it ±5%); tune it and the config
honestly to the real object before gating, not to whatever the code produced.

The viewer is hash-locked: never edit `index.html`, `src/viewer/*`, `src/main.js`
or `tools/*` — gate G13 fails the build if you do. Your entire surface is
`src/asset/<name>.ts` and `asset.config.json`.

## The module contract

`export function create<Name>Model(options): THREE.Group` — one self-contained
file:

- Core `three` ONLY. No `three/examples/jsm`, no `ShaderMaterial`, no
  `CanvasTexture` (needs a DOM), no `fetch`, no external URL anywhere in the
  file (gate G11 scans for `http` — comments included).
- Real metres, Y-up, +Z forward, origin at base centre (y = 0).
- Seeded determinism: same seed + options → identical vertex data (G10).
- `userData.dispose()` returns the renderer to baseline (G12) — every
  geometry, material and texture you create is released.
- Textures are in-code `DataTexture`s; `MeshStandardMaterial` for surfaces.
- Keep the 4-line header (name / MIT + holder / units / requires) — it is what
  makes a copied file self-describing.

Extracting from a game: COPY the code out (the game keeps its own), then strip
every game dependency, re-origin to base centre, convert to real metres, seed
the randomness, and add the dispose contract. The result must run in a project
holding nothing but `three` — that is literally gate G8 (paste-and-run).

## Gate loop

```bash
npm run verify        # vite build + 17 gates + manifest stamp, in one command
```

Iterate until 17/17. Each failure names its gate and what it measured. The
gates are the design bar of the Assets tab — never loosen `asset.config.json`
ceilings to sneak a failing model through; fix the model.

Two measured traps: metalness 1.0 needs the viewer's environment map to read
correctly — it renders BLACK in a game with no envmap, so prefer 0.2-0.9 for
believable metals; and a mirrored basis can pass every numeric gate while
being silently inside-out — LOOK at the turntable from several angles before
calling it done.

## Ship

```bash
npx genex init                          # create the project (sign-in if needed)
npx genex preview --no-build            # staging turntable — show the user this link
npx genex publish --no-build --categories assets   # only after the user says ship it
```

`--no-build` matters: `npm run verify` already built AND stamped the manifest
into `dist/` — a plain preview/publish would rebuild and ship an unstamped
manifest, and the dashboard's Copy-code button reads that manifest. Publish
ONLY on the user's explicit go, with the licence holder set to their real name.
