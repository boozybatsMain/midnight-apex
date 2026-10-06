---
name: genex-getting-started
description: Orient a new Genex user to the installed 3D browser-game workspace, including skills, agents, commands, authorization, and re-running setup. Use when the user asks what Genex is, how to get started, or what `genex init` installed.
---

# Getting started with Genex

`genex init` set up a workspace that helps your coding agent build 3D games in
the browser. Genex focuses on Three.js game skills, publishing, multiplayer
architecture, and team-ready workflows.

## What got installed

`genex init` installs the Genex skills **into this project's folder** for
every coding agent it detects — Claude Code (`.claude/`), Codex (`.codex/`),
and Cursor (`.cursor/`) — so the same skills are available whichever agent you
build with, and nothing is ever installed globally on the machine (only your
auth token lives outside the project, in `~/.genex/env`). After that, every
`genex` command keeps the genex-owned skills in sync with the installed CLI
automatically (re-running `init` does too); your own files are never touched.
If an older Genex version ever installed skills globally into `~/.claude`,
`~/.codex` or `~/.cursor`, any `genex` command now sweeps those legacy copies
out automatically — only `genex-*`-named files are removed, never yours.

- **skills/** - reusable Genex skills for 3D browser-game work (all agents).
- **agents/** - example subagent definitions (Claude Code).
- **commands/** - example slash commands (Claude Code).

Start with `$genex-game-director` for any game or graphics request. It checks
what your environment can do, writes the `DESIGN.md` design contract, and
routes the agent to focused skills for cameras, procedural geometry,
materials, atmosphere, water, weather, VFX, lighting, post-processing, and
visual validation.

## Generating real assets

Beyond procedural code, Genex can generate **real, AI-made assets** from a prompt.
Each command prints a permanent `assets.genex.technology` URL you load directly —
the asset lives in Genex storage (R2), not your repo, so there's nothing to commit:

```bash
npx genex model "weathered wooden barrel"      # a 3D mesh (GLB)
npx genex sfx "punchy laser zap" --duration 2  # a sound effect (mp3)
npx genex texture "mossy cobblestone" --terrain # a tiling surface texture
npx genex image "vintage travel poster"        # a picture (poster/sign/sprite/decal)
npx genex video "waterfall mist drifting" --loop      # a video clip (screen/backdrop)
```

(Run them inside your project — the `@genex-ai/cli-demo` dev dependency makes
`npx genex` resolve to the right CLI.)

Each has a focused skill with the exact loader code — `$genex-ai-model`,
`$genex-ai-sfx`, `$genex-ai-texture`, `$genex-ai-image`,
`$genex-ai-video`. The sky is not on that list: there is no sky command, so
every sky, horizon, and time of day is built in code — your call how, from a
background colour and fog to an atmospheric sky shader with a real sun. Two
more workflow skills draw UI art on the same commands,
for games whose style wants it: `$genex-ai-menu` (a cinematic menu — looping
video backdrop + DOM buttons) and `$genex-ai-hud` (a HUD sprite set with
masked fills). A restrained interface in clean CSS is a finished UI too —
`$genex-threejs-game-ui` builds that one.

## Identity & saves (every game)

Every Genex game ships with built-in player identity: sign-in, guests, per-player
saves, a shared world slot, and leaderboards — all through `@genex-ai/embed-sdk`.
Load `$genex-threejs-embed-auth` before writing boot code; it wires the one-call
setup (`initEmbed` + `waitForPlayer`) and is also where multiplayer gets its
connection auth. A game without it loses all progress on refresh.

## Loading screens (recommendation)

Generated assets take a moment to fetch at runtime. Show a simple loading
screen or progress hint while models/textures/sounds load, and remove it when
the game is ready — players should never stare at a black screen. This is a
recommendation, not a rule: even a one-line "Loading…" overlay over the dark
page background is enough.

## The folder's existing files are the user's

Whatever was in this folder before setup belongs to the user — reference
images, notes, sketches, an earlier attempt, files an agent won't recognize.
They may exist nowhere else, and deleting one has no undo. So: add files, edit
the ones you created, and never delete, empty, move, rename, or overwrite
anything you didn't. A non-empty folder is normal and is never something to
fix, and "start clean" is never a reason.

That rules out `rm -rf`, `git clean`, `git checkout -- .`, `git reset --hard`
over the user's work, and every scaffolder's offer to empty the directory
(`--force`, `--overwrite`, "Remove existing files") — answer a "directory is
not empty" prompt with Ignore/continue, or scaffold into a fresh subfolder and
copy across what's missing. If a step genuinely cannot continue without
removing something of theirs, stop and ask, naming the exact files, and wait
for a yes. This is law 19 of the build contract in the project's `AGENTS.md`.

## Remixing an existing game

If the project folder already contains a game (a remix or any existing
project), don't scaffold a new app over it: read the existing code first and
keep its renderer, structure, and conventions — extend, don't rebuild.
Running `genex init` in such a folder only wires identity/publishing and
refreshes the genex-owned skills; the game's own files are never touched.

## Hosting your game's source

By default `genex init` creates a **managed repo** for your source — you push to
it over HTTPS with a token the API mints per push, so it works from any device
with no SSH key, and `preview`/`publish` save the source there automatically.

To keep the source in **your own git repo** instead, pass it at init:

```bash
npx genex init my-game --repo https://git.example.com/you/my-game.git
```

Then `preview`/`publish` push the source to **your** repo using the git
credentials `git push` already uses on this machine (https or ssh). Point it at a
repo dedicated to this game — each publish overwrites its `main` with the current
source. Without push access, publish stops with a clear error and nothing ships.
The playable game is served by Genex either way.

## Publishing

Before your first `genex preview`, the play URL (`https://<slug>.genex.technology/`)
already serves a **standard placeholder world** — the owner's avatar in a small
playground, unrelated to your code. It is NOT in your repo; never treat it as a
starting point or try to modify it. Your first `preview` replaces it automatically.

`npx genex preview` updates the player's **draft** (their draft page) and
**never touches the public version** players are on; `npx genex promote` makes
the draft the public version (that exact build, no rebuild). `npx genex publish`
does build + make-live + lists the game in the public gallery — the FIRST
release only. After that, the player's "publish it" / "publish the update" /
"update it" / "yes" ALL mean `promote`, never `genex publish` again (that would
ship a fresh rebuild nobody has tried). Command names are yours, not the
player's: talk about "the draft" and "the public version", and ask directly —
"Want me to update the public version?" — one line, once per round of work,
keep building while you wait; more change requests instead of a yes mean "not
yet". `promote` ships the last previewed build, so if you edited anything since
the last `preview`, preview again before promoting. When publishing, pick 1–3 gallery
categories from what you actually built — `games`, `assets`, `physics`,
`terrain`, `lighting`, `vfx` — and pass them comma-separated:

```bash
npx genex publish --categories games,vfx
```

If unsure, use `games` (also the server's fallback for anything unrecognized).

Your own files were left untouched. `genex init` only adds missing files and
refreshes the genex-owned ones.

## Working on one game from more than one machine

A game's connection to its live page is folder-local (`.genex/project.json`), so
a new machine — or a folder that got deleted — has no link. **Never run `init`
to "recover" a game**: that creates a brand-new game at a new URL.

**Picking the game up somewhere new** — run `link` in an EMPTY folder and it
downloads the game too, binary assets and all:

```bash
mkdir my-game && cd my-game
npx @genex-ai/cli-demo@latest link <slug>   # slug = the name in the play URL
npm install
```

Don't know the slug? **`npx genex list`** prints every game on your account —
slug, status, and page link for each. In a folder that already has files, `link`
writes the link and downloads nothing, so it can never overwrite work.

**Catching a folder up** — `npx genex pull` replaces this folder with the
game's current draft. It refuses if the folder holds changes you never deployed,
because there is nothing to merge them against.

**If two machines have both moved on**, `preview` refuses rather than
overwriting the other one, and tells you both ways forward:

```
✗ my-game was updated from another device — nothing was deployed.
  npx genex pull — take the other device's work (refuses if you have unshipped changes)
  npx genex preview --force — keep yours and replace theirs
```

**Prefer taking their work and redoing yours on top.** You know what you just
changed, so you can re-apply it — which no merge tool could do for you, and which
loses nothing:

```bash
npx genex pull --force   # takes their version; keeps what was here under .genex/replaced-*
# redo your change on the new base, then:
npx genex preview
```

`pull --force` never deletes: what was in the folder is copied to
`.genex/replaced-<timestamp>/` first, so you can diff against it while re-applying.

Use `preview --force` instead only when the user says their side should win.
Either way **say which version you are keeping before you run it** — both commands
are irreversible for one side, and the user may know something you don't about what
is on the other machine.

Inside a Genex chat session `preview --force` is **refused** — you cannot discard
what somebody shipped from their own machine, because you cannot see it. Pull, redo
your change, preview. If the user wants their chat version to win, they can run the
forced deploy from their terminal themselves.

`link` never creates a project: it signs in if needed (the browser opens once)
and rewrites the local link (source pushes authorize over HTTPS, so there's no
key to set up — it works from any machine).
After it, `npx genex preview` / `npx genex publish` update the **same live
game** — plays, likes, and comments stay. It also fixes a folder whose
authorization went stale ("Not authorized" from `preview`/`publish`).

## Staying up to date

Genex commands print an update nudge when a newer package exists
(`⬆ Genex … available — run: …`). Follow `$genex-updates`: apply the printed
command at a safe moment (never mid-task), then tell the user what changed.
Skills need no action — they sync automatically on every `genex` command.

## Re-running setup

Safe to run any time — genex-owned skills are refreshed to the latest version,
and your own files are never touched:

```bash
npx @genex-ai/cli-demo@latest init
```

Use `--force` only if you intentionally want your own existing files overwritten
by the bundled templates too.

## Authorization

`genex init` opens the auth site, then saves your token to `~/.genex/env`
(reused across projects). If the browser doesn't open, copy the printed URL into
a browser manually to finish authorizing.
