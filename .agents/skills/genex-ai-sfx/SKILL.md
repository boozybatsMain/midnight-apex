---
name: genex-ai-sfx
description: Generate a real sound effect (mp3) from a text prompt with `npx genex sfx`, then wire it in Three.js — one-shots, rapid repeats, and a looping sound whose pitch and volume track a live value (engine, wheels, wind). Use for any specific sound triggered by a game event, and whenever audio must react continuously to gameplay without stuttering phones.
---

# Genex AI · SFX

Turn a prompt into a real **mp3** sound effect and wire it to a game event.

## Run

```bash
npx genex sfx "<prompt>"
npx genex sfx "punchy laser zap, short and dry" --duration 2
```

`--duration <sec>` (0.5–30) sets a target length; omit it to let the model pick.
Describe ONE sound, concretely, in the vendor's own vocabulary where it fits:
"impact" for a hit, "whoosh" for movement through air, "ambience" for a room
or weather bed, "drone" for a continuous suspense texture. A sequence is
written in order: "footsteps on gravel, then a metal door opens".
For an ambient bed the game will play on repeat (rain, a crowd, a machine
hum), pass `--loop`: the clip is generated to close on itself, so
`setLoop(true)` has no pop at the wrap. Never on a one-shot.
Blocks until ready, then prints its public URL:

```
https://assets.genex.technology/generations/<id>/audio-sfx
```

The mp3 lives in Genex storage (R2) and loads straight from that URL — you don't download
it and nothing is committed to your repo. The URL is permanent (local dev, published game,
and remixes alike).

## Play it in Three.js

Audio needs **one `AudioListener` on the camera**. Then load the clip and play it
on an event. Browsers block autoplay — start audio after a user gesture (click/keydown).

**Positional** (3D, attenuates with distance — attach to an object):

```ts
import * as THREE from "three";

const listener = new THREE.AudioListener();
camera.add(listener);
// Copy the shared gesture gate below; register BEFORE any asynchronous decode.
let audioEnabled = true; // Bind to the game's playing and unmuted state.
const audioGate = installAudioGestureGate(listener.context, () => {}, () => audioEnabled);
// audioEnabled is the game's current playing && !muted state.

// the URL `npx genex sfx` printed (R2 sends CORS headers, so cross-origin works):
const SFX_URL = "https://assets.genex.technology/generations/<id>/audio-sfx";
const buffer = await new THREE.AudioLoader().loadAsync(SFX_URL);

const sound = new THREE.PositionalAudio(listener);
sound.setBuffer(buffer);
sound.setRefDistance(5);
laserMesh.add(sound); // follows the object

// on fire:
if (audioGate.canPlay() && !sound.isPlaying) sound.play();
```

**Global** (UI/non-spatial — same volume everywhere): use `new THREE.Audio(listener)`
instead of `PositionalAudio` and don't attach it to a mesh.

Reuse one loaded `buffer` across many plays — the three recipes below are how.

## Never drive game sound through an `<audio>` element

`new Audio(url)`, `document.createElement("audio")`, an `<audio>` tag — same object,
all wrong here. On iPhone it is a **handle on the OS media pipeline in another
process**: writing `.volume`/`.playbackRate` is a **cross-process call** (a sound
driven from a live value writes 60–120 of those a second and stutters the whole
game), and `play()` is **async and slow**, so one-shots land after the event.

It disguises itself as a graphics problem: only while moving, identical at every
quality setting, desktop fine. The one-second tell — **the music plays throughout
and costs nothing**, same object and same code path, because its volume and pitch
never change. *A sound playing is free; a sound written to every frame is not.*

`THREE.Audio`/`PositionalAudio` are WebAudio and have none of this — use them for
everything, including UI clicks.

## Decode everything before the player needs it

A clip that hasn't finished decoding stalls on its first play — exactly the first
second of gameplay. **Decoding needs no running `AudioContext`, only playing does**,
so decode while the menu is up:

```ts
import * as THREE from "three";

const listener = new THREE.AudioListener();
camera.add(listener); // ONE listener serves every sound and the music

const CLIPS = {
  jump: "https://assets.genex.technology/generations/<id>/audio-sfx",
  wheels: "https://assets.genex.technology/generations/<id>/audio-sfx",
} as const;
type ClipName = keyof typeof CLIPS;

const buffers = new Map<ClipName, AudioBuffer>();

/** Call this while the menu/loading screen is up — no user gesture needed. */
export async function preloadAudio(): Promise<void> {
  const loader = new THREE.AudioLoader();
  await Promise.all(
    Object.entries(CLIPS).map(async ([name, url]) => {
      buffers.set(name as ClipName, await loader.loadAsync(url));
    }),
  );
}
```

## Rapid repeats: pool the voices

Footsteps, hits and gunfire re-trigger faster than a clip ends, one `THREE.Audio`
plays once at a time, and a fresh one per shot allocates during combat. Keep a
small pool per clip and reuse whatever is idle:

```ts
const pool = new Map<ClipName, THREE.Audio[]>();

export function playSfx(name: ClipName, volume = 0.7): void {
  const buffer = buffers.get(name);
  if (!buffer) return; // still decoding — silence beats a stall
  const voices = pool.get(name) ?? [];
  let voice = voices.find((v) => !v.isPlaying);
  if (!voice) {
    voice = new THREE.Audio(listener);
    voice.setBuffer(buffer);
    voices.push(voice);
    pool.set(name, voices);
  }
  voice.setVolume(volume * sfxVolume); // sfxVolume = the settings slider
  voice.play();
}
```

Positional one-shots: same pool built from `THREE.PositionalAudio`, `mesh.add(voice)`.

## A sound that tracks a live value

Engine, wheels, wind, rotor wash, a charging weapon — start the loop **once**, then
write to it every frame. Both calls below are AudioParam writes on the audio thread:
no allocation, no cross-process call.

```ts
const wheels = new THREE.Audio(listener);
wheels.setBuffer(buffers.get("wheels")!);
wheels.setLoop(true);
wheels.setVolume(0);
wheels.play(); // ONCE, from the first user gesture — never per frame

// in the render loop:
const speed01 = THREE.MathUtils.clamp(speed / topSpeed, 0, 1);
wheels.setVolume(speed01 * 0.6 * sfxVolume);
wheels.setPlaybackRate(0.8 + speed01 * 0.7); // pitch rises with speed
```

If the driving value can jump (a gear change, a hit, a respawn), a step is an
audible click — glide instead:
`wheels.gain.gain.setTargetAtTime(target, listener.context.currentTime, 0.05)`.
To silence a loop, ride the volume to 0 and leave it running — never `stop()`/`play()`.

## Publish checklist

- Load it from the **URL** the command printed — absolute and permanent, so it resolves
  the same in local dev, the published game, and remixes. Nothing to commit.

## Options

- `--duration <sec>` — target length 0.5–30 (shown in Run above); omit to let
  the model pick.
- `--no-wait` — enqueue and return immediately (the file won't be downloaded;
  re-run without `--no-wait` to fetch it).
- `--api-url <url>` — override the API base (local dev).

## Troubleshooting

- **"Not authorized"** — run `npx genex init` first (in the project — it resolves this project's own CLI) (it writes your `GENEX_TOKEN`).
- **"Out of credits" (`insufficient_credits`)** — the account has no credits left for
  this sound generation. Tell the user the facts the CLI printed: their balance, this
  generation's cost, and when their credits refill. Then offer to continue the build
  with a procedurally-coded placeholder (a small WebAudio-synthesized stub sound)
  and mark the spot with `// TODO(genex): regenerate when credits refill` so the
  real asset is one command away later. Do not stop the session over this.
- **"Email not verified" (`email_verification_required`)** — generation credits
  unlock after the account's email is verified. Give the user the verify link the
  CLI printed, wait for them to confirm, then re-run the command.
- **No sound** — call `listener.context.resume()` directly in the intended
  click/keydown, independently of decoding. Check that it reaches `running`,
  then verify a triggered event after final gain and positional attenuation.
- **Too quiet/loud** — `sound.setVolume(0..1)`; for positional, tune
  `setRefDistance` / `setRolloffFactor`.
- **Stutters on a phone while moving, at every quality setting** — audio, not
  graphics: see the `<audio>` section above (`$genex-threejs-adaptive-quality` has
  the same triage from the performance side).
- **A sound is late the first time, then fine** — it was still decoding. Preload
  during the menu.

## Gesture unlock and audible evidence

Copy the `$genex-ai-music` shared gesture gate (`references/genex-audio-gesture.md`) once into your audio module and share it with every lane. Define `audioEnabled` from playing/unmuted state before installing it. Register before decoding; `THREE.Audio.play()` does not resume a suspended context. Keep mute/pause ownership in the game. Do not queue stale one-shots for later unlock.

For **no sound**, first check a real gesture called `listener.context.resume()` and that it reached running. Then check decoded data, source start, gains and positional attenuation. Measure a deliberately triggered audible event using $genex-threejs-visual-validation; a running context or loaded file alone is insufficient.
