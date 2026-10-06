---
name: genex-ai-video
description: Generate a real video clip (H.264 mp4) from a text prompt with `npx genex video`, then play it in Three.js on any surface via VideoTexture. Use for in-game TVs/screens/monitors, animated billboards, cutscene clips, ambient backdrops, portals, and video decals ("news broadcast on a TV", "swirling portal", "animated arcade attract screen") rather than a static image or shader effect. Pass `--loop` for a seamless loop.
---

# Genex AI · Video

Turn a prompt into a real mp4 clip and play it anywhere in the game — an in-game
TV/screen/monitor, an animated billboard, a cutscene, an ambient backdrop, a portal,
or a video decal.

## When to use this vs. a static image or shader

- **Use `npx genex video`** for moving footage you can describe — "static-y CRT
  news broadcast", "swirling ink in water", "rain running down glass". You get a real
  mp4.
- **Use `$genex-ai-image`** for a single still picture, or
  `$genex-threejs-procedural-vfx` for parametric real-time effects (particles,
  trails, shockwaves) authored in code.

## Run

```bash
npx genex video "<prompt>"
npx genex video "drifting autumn leaves, seamless loop" --loop   # seamless loop for screens/backdrops
```

Video takes a **minute or two** end to end (queue + generation). If you're building
other things meanwhile, add `--no-wait` to enqueue and come back for it. Blocks until
ready, then prints its public URL:

```
https://assets.genex.technology/generations/<id>/video-mp4
```

The clip lives in Genex storage (R2) and loads straight from that URL — you don't
download it and nothing is committed to your repo. The URL is permanent (local dev,
published game, and remixes alike).

> **Cost & length:** the default is a **5-second, 768p** clip (MiniMax H3's top
> native mode) — the right default for anything the player looks at directly.
> Only pass `--duration` when the content genuinely needs to be longer (5–15s;
> a cutscene), `--resolution 2k`/`4k` only for hero shots (they upscale the
> same native base, run on an older and pricier model, and cost roughly 3–4×),
> and `--resolution 480p` only when
> the clip is genuinely incidental (a small in-world screen seen from a
> distance). Every clip carries a **native stereo audio track** (score, foley,
> even dialogue) — in-game `<video>` elements autoplay muted, so unmute it only
> when the sound is the point (a cutscene) and route it through the SFX volume
> slider. mp4 has **no alpha channel**, so a video is always a full rectangle
> (there are no transparent video decals).

## Play it in Three.js

Video needs an `HTMLVideoElement`, and browsers block autoplay — the first
`video.play()` must run inside a user gesture (any click or keypress). Wrap it in a
`VideoTexture` and put it on any surface:

```ts
import * as THREE from "three";

// the URL `npx genex video` printed (R2 sends CORS headers, so cross-origin works):
const VIDEO_URL = "https://assets.genex.technology/generations/<id>/video-mp4";
const video = document.createElement("video");
video.src = VIDEO_URL;
video.crossOrigin = "anonymous";   // REQUIRED to upload cross-origin video to WebGL (else a tainted-source error)
video.muted = true;                // muted is what lets it play under autoplay policy
video.loop = true;
video.playsInline = true;          // iOS: no fullscreen takeover

const texture = new THREE.VideoTexture(video);   // auto-updates every frame — no per-frame code
texture.colorSpace = THREE.SRGBColorSpace;

// an in-game TV / animated billboard — MeshBasicMaterial so it glows regardless of scene lighting:
const screen = new THREE.Mesh(
  new THREE.PlaneGeometry(3.2, 1.8),             // 16:9
  new THREE.MeshBasicMaterial({ map: texture }),
);
scene.add(screen);

// start playback on a user gesture (never swallow the rejection):
window.addEventListener("keydown", () => {
  video.play().catch((e) => console.warn("video play", e));
}, { once: true });
```

One `VideoTexture` can feed **many** surfaces — a bank of monitors, N sprays. Cost is
per distinct `<video>` element (media decode + one GPU upload per frame), **not** per
surface, so sharing one element for every screen is nearly free (all play in sync).
Pause the element (`video.pause()`) when no video surface is visible; on phones,
prefer the clip's source still as a poster and start the video only where it plays
smoothly.

## Video decals

A video decal is the same `DecalGeometry` projection as an image decal — read the
**Decals & stickers** section of `$genex-ai-image` for the full recipe and gotchas —
with one change: swap the `TextureLoader` map for the `VideoTexture` above, and call
`video.play().catch(...)` inside the spray handler (the keypress is the user gesture).
All decals can share the one `VideoTexture`. Because mp4 has no alpha, a video decal
is a full rectangle (fine for a screen-shaped mark; use `$genex-ai-image --transparent`
for a shaped sticker). **Layering gotcha:** an opaque video decal draws in the opaque
pass — *before* any `transparent: true` image decal — so image decals always land on
top regardless of spray order or `renderOrder`. If you mix both and need strict
newest-on-top, set `transparent: true` on the video decal material too.

## Multiplayer

The asset URL is public, permanent, and CORS-open, so it is safe to broadcast the
string to every player. A placed-at-runtime surface (a video decal included) is static
shared world state — put it on `room.shared`, **not** `objects` (no movement to smooth)
and **not** `send` (late joiners would see a bare wall; `shared` keys replay on connect).

Use a **fixed ring of slots** and overwrite the oldest — **never a fresh key per
placement**. The relay caps game-writable `shared` keys at **256 per room, keys are
permanent and undeletable, and new keys past the cap are silently dropped forever**:

```ts
let next = 0;
const RING = 32;                                   // decal:0 .. decal:31
function placeShared(url: string, hit: { point: THREE.Vector3; normal: THREE.Vector3 }) {
  room.shared.set(`decal:${next % RING}`, { url, p: hit.point.toArray(), n: hit.normal.toArray() });
  next++;
}
room.on("shared", (key, value) => {                // every player (incl. late joiners) rebuilds it
  if (key.startsWith("decal:") && value) spawnVideoDecalFromShared(value);
});
```

See `$genex-threejs-multiplayer` for the `shared` channel rules and the room API.

## Publish checklist

- Load it from the **URL** the command printed — absolute and permanent, so it resolves
  the same in local dev, the published game, and remixes. Nothing to commit.
- Don't copy the mp4 into `public/assets/` — generated assets live in R2, not the repo.

## Options

- `--loop` — a seamless loop (for screens, ambient backdrops, video decals).
- `--duration <sec>` — clip length 5–15; default 5. Only raise it when the content
  genuinely needs more — clips bill per second.
- `--resolution 480p|768p|1080p-native|2k|4k` — output resolution (default **768p**, the top
  native mode). `1080p-native` is a true 1920×1080 render at **twice** 768p's
  price — worth it for a clip the player really looks at (a cutscene, a menu
  backdrop), wasted on anything small or incidental; it is refused with
  `--frame`, whose seamless loop runs on a model that has no such tier.
  `2k`/`4k` upscale the same base for hero shots at ~2–3× the
  cost; `480p` is the cost opt-down for genuinely incidental clips. `--loop`
  clips ignore it (model default).
- `--frame <url|file>` — one generated image (or a local file ≤4 MB) as BOTH
  first and last frame — the seamless-loop mode (motion must return to its
  start; the seam is mathematically exact).
- `--start-frame <url|file>` — continue from this frame, no end anchor — the
  clip-chaining primitive (see below). Local files inline like `--frame`.
- `--first-frame <url|file>` / `--last-frame <url|file>` — two-frame motion
  between two stills (a genuine state change — a door opens, day turns to
  night). `--first-frame` alone means `--start-frame`.

**Frame anchors are compositional guidance, not pixel-pinning.** The model
repaints every anchor — the clip's first frame lands near the supplied image
(same scene, same composition) but not ON it, and regenerating doesn't change
that; it is how the mode works. Plan for it: chains stay coherent when each
clip starts from the previous clip's REAL frame (below), and a supplied
`--last-frame` steers where motion ends rather than guaranteeing the exact
pixels.
- `--ref <url|file>` — repeatable, up to 9 subject/style reference images.
  Cite each in the prompt by its order: "Image 1 is the hero — she walks into
  frame…". This is how the SAME character or art style holds across many clips
  (a cutscene series, an episodic story). Cannot combine with `--frame`/`--loop`.
- `--no-wait` — enqueue and return immediately, without the URL. Fire-and-forget
  only: re-running the command creates (and bills) a NEW video.
- `--api-url <url>` — override the API base (local dev).

Menu backdrops belong to `$genex-ai-menu`; a cohesive art-directed HUD sprite
set belongs to `$genex-ai-hud` — both build on `npx genex image`/`video`.

## Interactive video games

Clips are cheap and fast enough to be a game's PRIMARY content, not just set
dressing — an interactive movie (Detroit-style branching story), a generated-
evidence detective game, a video-book. The pattern that makes it hold together:

- **Branching scenes**: generate one clip per story node at build time, ship
  the mp4 URLs in a scene-graph JSON, play them full-screen with DOM choice
  buttons; preload the clips reachable from the current node while it plays.
- **Visual continuity — chain from REAL frames**: extract the previous clip's
  actual last frame and seed the next clip with it:

  ```bash
  ffmpeg -sseof -0.2 -i prev.mp4 -update 1 -q:v 1 last.png
  npx genex video "she turns and walks toward the far door" --start-frame last.png
  ```

  Never chain from the image you WISHED the clip ended on — anchors are
  repainted (above), so the wish and the clip disagree and every join jumps.
  Chaining from the real frame keeps drift from accumulating; the residual
  repaint at each cut is small, and a ~200 ms crossfade between the two
  `<video>` elements hides it entirely. Write chained prompts as CHANGE ONLY
  ("she turns…", "the light flickers out") — the start frame already says
  everything else.
- **Cast consistency**: give every scene the same `--ref` images of your
  protagonist and key locations — the single biggest quality lever for any
  multi-clip story.
- Keep hard facts (dialogue you must control, exact text) in subtitles and
  `npx genex voice` lines layered on top; the clip's own audio is atmosphere.

## Troubleshooting

- **"Not authorized"** — run `npx genex init` first (in the project — it resolves this project's own CLI; it writes your `GENEX_TOKEN`).
- **"Prompt rejected"** — the provider's content-safety filter blocked the prompt.
  This is non-retryable; retrying the same wording fails again. Rewrite the prompt.
  The measured false-positive class is anatomy being pierced or entered
  (cables/wires/needles into a body — biomech and cyberpunk vocabulary trips
  it). Describe the object or machine instead of the anatomy: "a statue-like
  figure threaded into the wall" passes where "cables entering her spine"
  fails. Word it that way on the FIRST try — each rejection still ends a
  billed-then-refunded round trip.
- **Nothing plays / black surface** — the first `video.play()` must run inside a user
  gesture (click/keydown); confirm it's called and its promise rejection is logged.
- **Tainted-source / security error** — set `video.crossOrigin = "anonymous"` before
  `video.src`.
- **Colors look washed/dark** — ensure `texture.colorSpace = THREE.SRGBColorSpace`.
