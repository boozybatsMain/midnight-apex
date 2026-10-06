# Genex final-mix audio check

Use in development only. Pass the game's real final master gain (Three.js:
`listener.getInput()`), after per-source gain and positional attenuation.
Every intended source must feed that master. This observes the real mix; it
does not fix a silent source or unlock the browser. First enter gameplay with
a real gesture and leave mute off. `trigger` fires an actual audible game
event. Do not use a synthetic test tone as evidence for the game's audio.

```js
async function measureFinalMix(context, master, { muted, event, trigger }) {
  if (!event || typeof trigger !== 'function') return { result: 'unknown', reason: 'No intended audible event' };
  const analyser = context.createAnalyser();
  const silentSink = context.createGain();
  analyser.fftSize = 2048;
  silentSink.gain.value = 0;
  master.connect(analyser);
  analyser.connect(silentSink);
  silentSink.connect(context.destination); // pull the tap without doubling the audible output
  const samples = new Float32Array(analyser.fftSize);
  let count = 0, peakRms = 0;
  try {
    trigger();
    for (let i = 0; i < 40; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (context.state !== 'running') continue;
      analyser.getFloatTimeDomainData(samples);
      let power = 0;
      for (const value of samples) power += value * value;
      peakRms = Math.max(peakRms, Math.sqrt(power / samples.length));
      count++;
    }
    return { result: muted || count < 10 ? 'unknown' : peakRms > 0.002 ? 'pass' : 'fail',
      contextState: context.state, samples: count, peakRms, muted, event, threshold: 0.002 };
  } finally { master.disconnect(analyser); analyser.disconnect(); silentSink.disconnect(); }
}
```

Run this during the existing milestone smoke check, with the intended event
and representative listening position recorded. Muted, insufficiently sampled
or untriggered checks are not passes. Quiet output with a running context
requires checking source starts, final gains and distance/rolloff. Do not turn
up a diagnostic-only signal to pass; verify the real event by listening too.
