// Race logic: continuous progress, sector checkpoints, laps, timing, positions, wrong-way.
//
// Each car tracks sRel = arc length past the start line (0..L). Wrapping across the line
// forward/backward adjusts `lapBase`, so progress = lapBase·L + sRel is continuous (it is what
// positions and the AI use). A lap only COUNTS when the car crosses the line forward having
// passed all 3 sector checkpoints (at L/4, L/2, 3L/4) in that lap — reversing over the line
// and back, or driving the circuit backwards, never scores.
const SECTORS = 3;
const FULL_MASK = 0b1110; // bits 1..3
const WRONG_WAY_COS = Math.cos((110 * Math.PI) / 180);

export class RaceManager {
  constructor(track, totalLaps = 3) {
    this.track = track;
    this.L = track.length;
    this.totalLaps = totalLaps;
    this.cars = [];
    this.order = []; // cars sorted by race position
    this.time = 0;
    this.running = false;
    this.finishCount = 0;
    this.events = { onLap: null, onFinish: null, onStartCross: null };
  }

  wrapRel(s) {
    const L = this.L;
    let r = (s - this.track.startS) % L;
    if (r < 0) r += L;
    return r;
  }

  addCar(car) {
    car.race = {
      sRel: 0, prevSRel: 0, lapBase: 0, progress: 0, cpMask: 0,
      lapsDone: 0, lapStart: 0, lapTime: 0, lastLap: null, bestLap: null, laps: [],
      finished: false, finishTime: null, finishOrder: 0, position: 1,
      wrongWayTimer: 0, wrongWay: false,
    };
    this.cars.push(car);
    this.order.push(car);
  }

  /** Reset per-car state; call after cars were placed on the grid (car.s must be valid). */
  reset() {
    this.time = 0;
    this.running = false;
    this.finishCount = 0;
    for (const car of this.cars) {
      const r = car.race;
      r.sRel = r.prevSRel = this.wrapRel(car.s);
      // Grid slots sit just behind the line: they start "on lap −1" so the first forward
      // crossing is the standing start, not a lap.
      r.lapBase = r.sRel > this.L * 0.5 ? -1 : 0;
      r.progress = r.lapBase * this.L + r.sRel;
      r.cpMask = 0;
      r.lapsDone = 0;
      r.lapStart = 0;
      r.lapTime = 0;
      r.lastLap = null;
      r.bestLap = null;
      r.laps.length = 0;
      r.finished = false;
      r.finishTime = null;
      r.finishOrder = 0;
      r.wrongWayTimer = 0;
      r.wrongWay = false;
    }
    this._sortPositions();
  }

  start() {
    this.time = 0;
    this.running = true;
    for (const car of this.cars) car.race.lapStart = 0;
  }

  /** Re-sync a car after a teleport (reset to track) so no false wraps/checkpoints fire. */
  resync(car) {
    const r = car.race;
    const sRel = this.wrapRel(car.s);
    const d = sRel - r.sRel;
    if (d < -this.L / 2) r.lapBase++;
    else if (d > this.L / 2) r.lapBase--;
    r.sRel = r.prevSRel = sRel;
    r.progress = r.lapBase * this.L + sRel;
    r.wrongWayTimer = 0;
    r.wrongWay = false;
  }

  get leaderLapsDone() {
    let m = 0;
    for (const c of this.cars) if (c.race.lapsDone > m) m = c.race.lapsDone;
    return m;
  }

  update(dt) {
    if (this.running) this.time += dt;
    const L = this.L;
    const quarter = L / (SECTORS + 1);
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      const r = car.race;
      const prev = r.sRel;
      const cur = this.wrapRel(car.s);
      const d = cur - prev;
      r.prevSRel = prev;
      r.sRel = cur;

      if (d < -L * 0.5) {
        // Forward across the start/finish line.
        r.lapBase++;
        if (this.running && !r.finished) {
          // Sub-frame timing: the line was crossed `cur` metres before the end of this frame's travel.
          const travel = cur + L - prev;
          const tCross = this.time - (travel > 1e-3 ? clamp01(cur / travel) * dt : 0);
          if (r.cpMask === FULL_MASK) this._completeLap(car, tCross);
          else if (this.events.onStartCross) this.events.onStartCross(car);
        }
        r.cpMask = 0;
      } else if (d > L * 0.5) {
        // Backward across the line: undo, and require a full lap again.
        r.lapBase--;
        r.cpMask = 0;
      } else if (d !== 0) {
        // Sector checkpoints (forward sets, backward clears).
        for (let k = 1; k <= SECTORS; k++) {
          const th = quarter * k;
          if (prev < th && cur >= th) r.cpMask |= 1 << k;
          else if (prev >= th && cur < th) r.cpMask &= ~(1 << k);
        }
      }
      r.progress = r.lapBase * L + cur;
      if (this.running && !r.finished) r.lapTime = this.time - r.lapStart;
      this._wrongWay(car, dt);
    }
    this._sortPositions();
  }

  _completeLap(car, tCross = this.time) {
    const r = car.race;
    const lapTime = tCross - r.lapStart;
    const prevBest = r.bestLap;
    r.lapsDone++;
    r.lastLap = lapTime;
    r.laps.push(lapTime);
    const isBest = prevBest == null || lapTime < prevBest;
    if (isBest) r.bestLap = lapTime;
    r.lapStart = tCross;
    r.lapTime = this.time - tCross;
    let finished = false;
    if (r.lapsDone >= this.totalLaps) {
      r.finished = true;
      r.finishTime = tCross;
      r.finishOrder = ++this.finishCount;
      finished = true;
    }
    if (this.events.onLap) this.events.onLap(car, lapTime, isBest && prevBest != null, finished);
    if (finished && this.events.onFinish) this.events.onFinish(car, r.finishOrder);
  }

  _wrongWay(car, dt) {
    const r = car.race;
    const ph = car.physics;
    const t = this.track.getTangentAt(car.s, car._tan);
    const cos = Math.sin(ph.heading) * t.x + Math.cos(ph.heading) * t.z;
    if (cos < WRONG_WAY_COS && (ph.speedKmh || 0) > 8) r.wrongWayTimer += dt;
    else r.wrongWayTimer = Math.max(0, r.wrongWayTimer - dt * 2);
    r.wrongWay = r.wrongWayTimer > 1;
  }

  // Insertion sort (stable, allocation-free; the order barely changes frame to frame).
  _sortPositions() {
    const a = this.order;
    for (let i = 1; i < a.length; i++) {
      const x = a[i];
      let j = i - 1;
      while (j >= 0 && ahead(x, a[j])) {
        a[j + 1] = a[j];
        j--;
      }
      a[j + 1] = x;
    }
    for (let i = 0; i < a.length; i++) a[i].race.position = i + 1;
  }

  /** Final classification: finishers by order, then the rest by estimated time (DNF). */
  buildResults() {
    const total = this.totalLaps * this.L;
    const out = [];
    for (const car of this.order) {
      const r = car.race;
      let time = r.finishTime;
      const dnf = !r.finished;
      if (dnf) {
        // Estimate from average pace so far: elapsed · total / covered (covered from the grid).
        const covered = Math.max(1, r.progress + (car.gridOffset || 0));
        time = this.time * (total + (car.gridOffset || 0)) / covered;
      }
      out.push({ car, time, bestLap: r.bestLap, dnf });
    }
    out.sort((x, y) => (x.dnf === y.dnf ? x.time - y.time : x.dnf ? 1 : -1));
    // Keep finishers strictly in finish order.
    return out;
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function ahead(x, y) {
  const a = x.race, b = y.race;
  if (a.finished !== b.finished) return a.finished;
  if (a.finished) return a.finishOrder < b.finishOrder;
  return a.progress > b.progress;
}
