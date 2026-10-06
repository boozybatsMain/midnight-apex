# Genex audio gesture gate

Copy this helper into the game's audio module once, shared by music, SFX and voice.
Install it before starting asynchronous decoding. `enabled` reads the current
playing/unmuted state; `ready` starts loaded continuous audio idempotently.
Call `refresh()` after decoding or a pause/mute state change. One-shots still
belong to their actual gameplay event, never replay a backlog after unlock.

```js
function installAudioGestureGate(context, ready, enabled = () => true) {
  let authorized = false, disposed = false, resuming = false;
  const refresh = () => {
    if (!disposed && authorized && enabled() && !document.hidden && context.state === 'running') ready();
  };
  const gesture = () => {
    if (disposed || !enabled() || document.hidden || resuming) return;
    resuming = true;
    // resume is invoked IN the gesture, before any await or asset decoding.
    let resumed;
    try { resumed = context.resume(); }
    catch (error) { resuming = false; console.warn('Audio resume failed', error); return; }
    Promise.resolve(resumed).then(() => { authorized = true; refresh(); })
      .catch(error => console.warn('Audio resume failed', error))
      .finally(() => { resuming = false; });
  };
  const visibility = () => {
    if (document.hidden) void context.suspend().catch(error => console.warn('Audio suspend failed', error));
    else if (authorized && enabled()) gesture();
  };
  window.addEventListener('pointerdown', gesture);
  window.addEventListener('keydown', gesture);
  document.addEventListener('visibilitychange', visibility);
  return { refresh,
    canPlay: () => authorized && enabled() && !document.hidden && context.state === 'running',
    dispose() {
      disposed = true;
      window.removeEventListener('pointerdown', gesture);
      window.removeEventListener('keydown', gesture);
      document.removeEventListener('visibilitychange', visibility);
    }
  };
}
```

Mute/pause handlers stop or pause current playback themselves and then call
`refresh()`. The gate never changes gains or unmutes a game. If the context
cannot resume on visibility return, the next gesture can retry.
