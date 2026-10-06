---
name: genex-ai-music
description: Generate a real instrumental background-music track (mp3) from a text prompt with `npx genex music`, then loop it quietly under the game in Three.js. Use for the one looping gameplay track every game with generated audio should have (reused on the menu at lower volume), plus optional boss or menu-specific tracks — always instrumental, always behind Music/SFX volume sliders in settings.
---

# Genex AI · Music

Turn a prompt into a real **mp3** instrumental track and loop it under the game.
One track transforms how finished a game feels — a silent game with polished art
still reads as a tech demo.

## When to use this vs. sfx

- **Use `npx genex music`** for the continuous bed: the gameplay loop, a boss
  theme, a menu theme. Tracks are instrumental by design (the API enforces it —
  vocals under gameplay read as karaoke).
- **Use `$genex-ai-sfx`** for event sounds — impacts, pickups, UI ticks. The
  0.5–30 s sfx lane cannot produce a music bed; don't try.

**The default plan is ONE track:** a ~90 s loopable gameplay track, reused on
the menu (same URL, lower volume). Propose extra tracks (boss/menu-specific) as
their own Assets-table rows only when the game's shape earns them.

## Run

```bash
npx genex music "<prompt>" --no-wait
npx genex music "dark orchestral hunt, low strings and taiko, steady menace, seamless loop, consistent energy, no intro, no outro" --duration 120 --no-wait
```

`--duration <sec>` (10–300) sets the length; the default **90 s** is the sweet
spot for a loop. Music takes a minute-plus — enqueue with `--no-wait` alongside
your other generations and pick it up with `npx genex wait <id>`. Prints:

```
https://assets.genex.technology/generations/<id>/audio-music
```

The mp3 lives in Genex storage (R2) and loads straight from that URL — you don't
download it and nothing is committed to your repo. The URL is permanent (local
dev, published game, and remixes alike).

## Prompt recipe for loopable game music

Genre + mood + instrumentation + tempo + loop wording:

- Name the game's emotional register and 2–3 instruments ("brooding synthwave,
  analog pads and arpeggio", "cozy acoustic folk, fingerpicked guitar and soft
  strings").
- Give it a tempo, and a key when the mood needs one ("96 BPM, in D minor"):
  the model reads musical terms as exactly as words, and a stated tempo holds
  every bar of a loop at the same pace. Keep the whole prompt short; more
  adjectives do not buy a better track.
- Always end with: **"seamless loop, consistent energy, no intro, no outro"** —
  the music API has no loop flag (the sfx lane does; music is prompt-shaped);
  consistent energy at both ends is what makes `setLoop(true)` inaudible. A
  track with a big intro pops every cycle.
- Don't ask for vocals — the lane forces instrumental regardless.

## Wire it in Three.js

Music is **non-positional** (`THREE.Audio`, not `PositionalAudio`), looped,
and QUIET — the default volume is **0.30**: it sits under the sfx, never over
them. Copy the shared [gesture gate](references/genex-audio-gesture.md) into your audio module first. It resumes the context from a gesture independently of decoding:

```ts
import * as THREE from "three";

const listener = new THREE.AudioListener();
camera.add(listener); // ONE listener serves music and every sfx

// the URL `npx genex music` printed (R2 sends CORS headers, cross-origin works):
const MUSIC_URL = "https://assets.genex.technology/generations/<id>/audio-music";
const music = new THREE.Audio(listener);
let audioEnabled = true; // bind to playing && !muted; pause existing music when false
let loaded = false;
const audioGate = installAudioGestureGate(listener.context, () => {
  if (loaded && !music.isPlaying) music.play();
}, () => audioEnabled);
new THREE.AudioLoader().loadAsync(MUSIC_URL).then((buffer) => {
  music.setBuffer(buffer);
  music.setLoop(true);
  music.setVolume(0.30);
  loaded = true;
  audioGate.refresh(); // a gesture may already have arrived while decoding
}).catch(error => console.warn("Music failed to load", error));
// On pause/mute: set audioEnabled, pause music if needed, then audioGate.refresh().
// Dispose audioGate when this scene is destroyed.

```

Decode the track (and every sfx clip) while the **menu** is up, not on PLAY:
`loadAsync` runs `decodeAudioData`, which does not need a running `AudioContext` —
only playing does. `$genex-ai-sfx` has the preload-everything recipe; run the
music through the same pass so the first second of gameplay waits on nothing.

**Menu reuse:** the same `music` object at lower volume (`setVolume(0.18)`)
during the menu phase, restored to the setting's value on PLAY — zero extra
generations. If the loop point is audible (the track came back with an
intro/outro despite the prompt), crossfade the tail into the head with a second
`THREE.Audio` on the same buffer rather than regenerating.

## Volume sliders are NOT optional

A game with generated audio and no volume control is a failure mode. The
settings screen gets **two sliders — Music and SFX** (music default 0.30, sfx
~0.7), persisted (localStorage or the save slot) and applied live:
`music.setVolume(v)` for the music bed, and one shared `sfxVolume` multiplier
every sound effect is scaled by (the `playSfx` / live-value recipes in
`$genex-ai-sfx` already read it — keep it a single exported value, never a
number copied into each call site). `$genex-threejs-game-ui` carries this as a
hard settings rule — wire the sliders in the same milestone as the track.

## Publish checklist

- Load it from the **URL** the command printed — absolute and permanent, so it
  resolves the same in local dev, the published game, and remixes. Nothing to
  commit.
- The track must be audible in the shipped game AND adjustable in settings —
  an unwired paid track is flagged at preview/publish (the wiring audit).

## Options

- `--duration <sec>` — track length 10–300; default 90 (the loop sweet spot).
  Longer costs more; a 90–120 s loop outlasts most sessions.
- `--no-wait` — enqueue and return immediately with the generation id; pick it
  up later with `npx genex wait <id>` (safe to re-run — it attaches to the SAME
  generation). The default for music: build while it renders.
- `--api-url <url>` — override the API base (local dev).

## Troubleshooting

- **"Not authorized"** — run `npx genex init` first (in the project — it resolves this project's own CLI) (it writes your `GENEX_TOKEN`).
- **"Out of credits" (`insufficient_credits`)** — the account has no credits left
  for this music generation. Tell the user the facts the CLI printed: their
  balance, this generation's cost, and when their credits refill. Then continue
  the build without a music bed (the game must work silent anyway) and mark the
  spot with `// TODO(genex): regenerate when credits refill` so the real track
  is one command away later. Do not stop the session over this.
- **"Email not verified" (`email_verification_required`)** — generation credits
  unlock after the account's email is verified. Give the user the verify link
  the CLI printed, wait for them to confirm, then re-run the command.
- **No sound** — call `listener.context.resume()` directly in the intended
  click/keydown, independently of decoding. Check that it reaches `running`,
  then verify a triggered event after final gain and positional attenuation.
- **The loop "pops" every cycle** — the track has an intro/outro (the prompt
  missed the loop wording). One regeneration with "seamless loop, consistent
  energy, no intro, no outro" is fair; after that, crossfade tail-into-head
  with a second `THREE.Audio` on the same buffer instead of re-rolling.
- **Music drowns the game** — 0.30 is the ceiling for a bed, not the floor;
  drop it further under dialogue-heavy or ambience-led scenes.
