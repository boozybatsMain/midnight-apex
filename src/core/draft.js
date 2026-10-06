// Slipstream: a car tucked in behind another at speed punches a smaller hole in the air. Lowers the
// follower's aero drag (physics.dragScale), which is what makes passes happen on the straights — for the
// AI among themselves and for the player alike. Pure function of the cars' track positions (Node-safe).

const DRAFT_DRAG_CUT = 0.42; // max fraction of aero drag removed right behind another car

const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * cars: [{ physics, s, lateral }]; trackLength: m. Sets physics.dragScale (and .draft 0..1) on every car.
 * Wake: 4-45 m behind the leader (strongest within ~12 m), within ~1.7 m laterally, fading in from 90 to 150 km/h.
 */
export function applySlipstream(cars, trackLength) {
  const L = trackLength;
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i];
    const pa = a.physics;
    if (!pa) continue;
    let draft = 0;
    const kmh = pa.speedKmh || 0;
    if (kmh > 90) {
      for (let j = 0; j < cars.length; j++) {
        if (j === i) continue;
        const b = cars[j];
        let ds = b.s - a.s;
        ds -= Math.round(ds / L) * L;
        if (ds < 4 || ds > 45) continue;
        const dl = Math.abs(b.lateral - a.lateral);
        if (dl > 2.2) continue;
        const d = (1 - sstep(12, 45, ds)) * (1 - sstep(0.9, 2.2, dl));
        if (d > draft) draft = d;
      }
      draft *= sstep(90, 150, kmh);
    }
    pa.draft = draft;
    pa.dragScale = 1 - DRAFT_DRAG_CUT * draft;
  }
}
