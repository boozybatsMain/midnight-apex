// AudioWorklet DSP for MIDNIGHT APEX engines (player engine + 4 opponent voices).
//
// The processor code lives inside a self-contained function that is stringified into a Blob-URL
// module at runtime (no external files; survives bundling/minification because it references no
// module-scope identifiers — only AudioWorkletGlobalScope globals).
//
// Player engine model (crossplane-V8 flavoured, 4-stroke):
//   cycle phase (rpm/120 Hz) -> 8 firing events per cycle (even crank spacing, firing order split
//   over two banks => uneven per-bank pulse spacing = the V8 burble) with per-cylinder amplitude bias,
//   per-firing amplitude/timing jitter, off-throttle dropouts. Each firing is a band-limited impulse
//   (fractional placement) into a critically damped 2-pole "pressure pulse" shaper whose width scales
//   with the firing interval (sharper on load). Each bank feeds its own exhaust waveguide (feedback
//   comb with damping = pipe resonances that DON'T move with rpm -> the harmonics sweep through
//   fixed formants = realistic howl). Plus intake waveguide + induction noise, combustion noise
//   AM-modulated by the pulses, waveshaper growl, morphing output EQ (on-throttle bright / overrun
//   muffled), overrun crackles/pops, rev-limiter fuel-cut stutter and shift ignition cut.

function workletScope() {
  /* global sampleRate, registerProcessor, AudioWorkletProcessor */
  const SR = sampleRate;
  const TAU = Math.PI * 2;
  const E = Math.E;

  function makeRng(seed) {
    let s = (seed | 0) || 0x2545f491;
    return function () {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
  }

  // Smooth saturator (rational tanh approximation, exact clamp beyond |x| > 3).
  function sat(x) {
    if (x > 3) return 1;
    if (x < -3) return -1;
    const x2 = x * x;
    return (x * (27 + x2)) / (27 + 9 * x2);
  }

  const onePoleCoef = (fc) => 1 - Math.exp((-TAU * Math.min(fc, SR * 0.49)) / SR);

  // RBJ biquad, transposed direct form II.
  class Biquad {
    constructor() {
      this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0;
    }
    // type: 0 LP, 1 HP, 2 BP(0 dB peak), 3 peaking, 4 low shelf, 5 high shelf
    set(type, f, q, gainDb) {
      f = Math.min(Math.max(f, 10), SR * 0.45);
      const w = (TAU * f) / SR;
      const cs = Math.cos(w);
      const sn = Math.sin(w);
      const alpha = sn / (2 * q);
      let b0, b1, b2, a0, a1, a2;
      if (type === 0) {
        b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
      } else if (type === 1) {
        b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
      } else if (type === 2) {
        b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
      } else if (type === 3) {
        const A = Math.pow(10, gainDb / 40);
        b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A;
      } else {
        const A = Math.pow(10, gainDb / 40);
        const sq = 2 * Math.sqrt(A) * alpha;
        if (type === 4) {
          b0 = A * (A + 1 - (A - 1) * cs + sq); b1 = 2 * A * (A - 1 - (A + 1) * cs); b2 = A * (A + 1 - (A - 1) * cs - sq);
          a0 = A + 1 + (A - 1) * cs + sq; a1 = -2 * (A - 1 + (A + 1) * cs); a2 = A + 1 + (A - 1) * cs - sq;
        } else {
          b0 = A * (A + 1 + (A - 1) * cs + sq); b1 = -2 * A * (A - 1 + (A + 1) * cs); b2 = A * (A + 1 + (A - 1) * cs - sq);
          a0 = A + 1 - (A - 1) * cs + sq; a1 = 2 * (A - 1 - (A + 1) * cs); a2 = A + 1 - (A - 1) * cs - sq;
        }
      }
      const ia = 1 / a0;
      this.b0 = b0 * ia; this.b1 = b1 * ia; this.b2 = b2 * ia; this.a1 = a1 * ia; this.a2 = a2 * ia;
    }
    process(x) {
      const y = this.b0 * x + this.z1;
      this.z1 = this.b1 * x - this.a1 * y + this.z2;
      this.z2 = this.b2 * x - this.a2 * y;
      return y;
    }
    reset() { this.z1 = 0; this.z2 = 0; }
  }

  // Power-of-two circular delay line with linear-interpolated fractional reads.
  class Delay {
    constructor(maxLen) {
      let size = 1;
      while (size < maxLen + 4) size <<= 1;
      this.buf = new Float32Array(size);
      this.mask = size - 1;
      this.w = 0;
    }
    read(d) {
      const rp = this.w - d;
      const i = Math.floor(rp);
      const f = rp - i;
      const a = this.buf[i & this.mask];
      const b = this.buf[(i + 1) & this.mask];
      return a + (b - a) * f;
    }
    write(x) {
      this.buf[this.w] = x;
      this.w = (this.w + 1) & this.mask;
    }
    clear() { this.buf.fill(0); }
  }

  // Acoustic pipe: feedback comb (round-trip delay D, end reflection r) with one-pole damping
  // in the loop (wall losses + radiation make high partials decay faster).
  class Pipe {
    constructor(maxSamples) {
      this.dl = new Delay(maxSamples);
      this.lp = 0;
    }
    process(x, D, r, damp) {
      const d = this.dl.read(D);
      this.lp += damp * (d - this.lp);
      const y = x + r * this.lp;
      this.dl.write(y);
      return y;
    }
    clear() { this.dl.clear(); this.lp = 0; }
  }

  // ---------------------------------------------------------------------------------------------
  // Player engine
  // ---------------------------------------------------------------------------------------------
  const N_CYL = 8;
  // Crossplane V8, firing order 1-5-4-2-6-3-7-8, cylinders 1-4 on bank 0, 5-8 on bank 1.
  const BANK_OF = [0, 1, 0, 0, 1, 0, 1, 1];

  class EngineProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        { name: 'rpm', defaultValue: 900, minValue: 0, maxValue: 20000, automationRate: 'a-rate' },
        { name: 'throttle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
        { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
        { name: 'nitro', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
        { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
        { name: 'maxRpm', defaultValue: 8000, minValue: 1000, maxValue: 20000, automationRate: 'k-rate' },
        { name: 'gain', defaultValue: 1, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
      ];
    }

    constructor(options) {
      super();
      const po = (options && options.processorOptions) || {};
      this.rng = makeRng(po.seed || 1337);
      const r = this.rng;
      // Fixed per-cylinder character: slight amplitude bias + timing offset (fraction of interval).
      this.cylAmp = new Float32Array(N_CYL);
      this.cylOff = new Float32Array(N_CYL);
      for (let k = 0; k < N_CYL; k++) {
        this.cylAmp[k] = 1 + (r() * 2 - 1) * 0.09;
        this.cylOff[k] = (r() * 2 - 1) * 0.035;
      }
      this.cylAmp[5] *= 0.9; // one slightly lazy cylinder => audible lope at idle

      // smoothed controls
      this.rpm = 900; this.thr = 0; this.load = 0; this.nitro = 0; this.cut = 0; this.gain = 1;
      this.maxRpm = 8000;
      this.idleL = 0;
      this.thrSlow = 0; // slower follower used for EQ/loudness (avoids pumping on throttle blips)

      // firing state
      this.phase = 0;
      this.k = 0;
      this.nextAt = this.cylOff[0] / N_CYL;
      this.carry0 = 0; this.carry1 = 0;

      // pulse shapers (2-pole critically damped per bank) + rasp (1-pole)
      this.p0a = 0; this.p0b = 0; this.p1a = 0; this.p1b = 0;
      this.r0 = 0; this.r1 = 0;
      this.ia = 0; this.ib = 0; // intake shaper
      this.aP = 0.05; this.aDec = 0.01; this.normP = 100; this.aR = onePoleCoef(4200); this.aI = 0.03; this.normI = E / 0.03;

      // pipes (max ~ 30 ms)
      const maxD = Math.ceil(SR * 0.03);
      this.pipe0 = new Pipe(maxD);
      this.pipe1 = new Pipe(maxD);
      this.intakePipe = new Pipe(Math.ceil(SR * 0.01));
      this.muffler = new Pipe(Math.ceil(SR * 0.01));

      // noise colouring
      this.bpComb = new Biquad();
      this.bpIntake = new Biquad();
      this.hpMech = new Biquad();
      this.hpMech.set(1, 3500, 0.7, 0);

      // output EQ chain
      this.eqShelf = new Biquad();
      this.eqBody = new Biquad();
      this.eqRasp = new Biquad();
      this.eqLP = new Biquad();
      this.eqLP2 = new Biquad();
      // 2nd-order high-pass at 30 Hz: removes DC + sub-audio cycle-rate content (pure headroom waste)
      this.hpSub = new Biquad();
      this.hpSub.set(1, 30, 0.707, 0);
      this.side = 0; this.sideA = onePoleCoef(900); this.sideHp = 0; this.sideX = 0;
      this.wander = 0; this.wanderT = 0; this.wanderTarget = 0;

      // derived per-block values
      this.D0 = 300; this.D1 = 350; this.Di = 110; this.Dm = 150;
      this.pipeDamp = onePoleCoef(2500);
      this.loud = 0;
      this.exGain = 1; this.inGain = 0; this.combGain = 0; this.raspGain = 0; this.drive = 1;
      this.jitAmp = 0.06; this.jitT = 0.01; this.dropProb = 0;

      // overrun / pops
      this.overrunFuel = 0;
      this.popEnv = 0; this.popClick = 0; this.popDecay = 0.999; this.popBank = 0;
      this.popQueue = []; // sample countdowns for scheduled pops (backfire bursts)
      this.popLP = 0;
      this.popHpX = 0; this.popHpY = 0; this.popLp2 = 0;
      this.popHpR = Math.exp((-TAU * 250) / SR);
      this.popLpA = onePoleCoef(4800);
      // rev limiter
      this.limT = 0; this.limOn = false; this.limGate = 1;
      // idle lope random walk
      this.lope = 0; this.lopeT = 0; this.lopeTarget = 0; this.tick = 0; this.tickDecay = 0.97;
      this.blockCounter = 0;

      this.port.onmessage = (e) => {
        const d = e.data || {};
        if (d.type === 'pops') {
          const n = Math.max(1, Math.min(8, d.n | 0));
          let t = 0;
          for (let i = 0; i < n; i++) {
            t += Math.floor(SR * (0.02 + this.rng() * (d.spread || 0.09)));
            this.popQueue.push({ t, s: (d.strength || 1) * (0.55 + this.rng() * 0.45) });
          }
        } else if (d.type === 'overrun') {
          this.overrunFuel = Math.max(this.overrunFuel, d.amount || 1);
        }
      };
    }

    triggerPop(strength) {
      this.popEnv = Math.min(1.6, this.popEnv + strength);
      this.popClick = Math.min(2.5, this.popClick + strength * 1.6);
      this.popBank = this.rng() < 0.5 ? 0 : 1;
      this.popDecay = Math.exp(-1 / (SR * (0.012 + this.rng() * 0.02)));
    }

    // Per-block (32 samples) derivation of filter coefficients/gains from smoothed controls.
    updateBlock() {
      const rpm = this.rpm;
      const rpmN = Math.min(1.1, Math.max(0, (rpm - 700) / (this.maxRpm - 700)));
      const fFire = (rpm / 60) * (N_CYL / 2);
      const thr = this.thr;
      const Lraw = Math.max(thr, this.load * 0.85);
      // Near idle the engine is still combusting (idle fueling) => keep some bark; true overrun
      // (high rpm, closed throttle) is what gets muffled.
      const L = Math.max(Lraw, this.idleLoad(rpmN));
      const ts = this.thrSlow;
      const nit = this.nitro;

      // Bi-exponential pressure pulse per firing: steep blowdown edge (rise) + decay whose duration
      // scales with the firing interval (crank angle). Load = steeper edge = more bark/rasp.
      const T = SR / Math.max(1, fFire); // firing interval in samples
      const tauD = Math.max(2, T * (0.15 + 0.13 * (1 - L)));
      const fcRise = Math.min(SR * 0.3, fFire * (2.4 + 7 * L) + 200 + 600 * L + 900 * nit);
      let tauR = SR / (TAU * fcRise);
      if (tauR > tauD * 0.45) tauR = tauD * 0.45;
      if (tauR < 0.6) tauR = 0.6;
      const pD = Math.exp(-1 / tauD);
      const pR = Math.exp(-1 / tauR);
      this.aDec = 1 - pD;
      this.aP = 1 - pR;
      const tp = (Math.log(tauD / tauR) * tauR * tauD) / (tauD - tauR);
      const hpk = (this.aP * this.aDec * (Math.exp(-tp / tauD) - Math.exp(-tp / tauR))) / (this.aP - this.aDec);
      this.normP = 1 / Math.max(1e-6, hpk);
      const fcI = Math.min(SR * 0.2, fFire * 1.6 + 60);
      this.aI = onePoleCoef(fcI);
      this.normI = E / this.aI;

      // Exhaust gas gets hotter with load -> faster sound speed -> pipe resonances rise slightly.
      const c = 470 + 70 * ts + 40 * rpmN;
      this.D0 = Math.max(8, (2 * 1.92 * SR) / c);
      this.D1 = Math.max(8, (2 * 2.31 * SR) / c);
      this.Dm = Math.max(8, (2 * 0.52 * SR) / c);
      this.Di = Math.max(8, (2 * 0.43 * SR) / 343);
      this.pipeDamp = onePoleCoef(1700 + 2400 * ts);

      // Per-firing randomness: off-throttle combustion is much less regular (burble).
      this.jitAmp = 0.07 + 0.2 * (1 - L) * (1 - rpmN * 0.5);
      this.jitT = 0.009 + 0.014 * (1 - L);
      this.dropProb = Lraw < 0.25 ? (0.25 - Lraw) * 0.55 * Math.min(1, rpmN * 2.5 + 0.2) : 0;

      // Loudness law + layer gains.
      const offLevel = 0.4 + 0.1 * rpmN;
      const lvl = offLevel + (1 - offLevel) * Math.pow(L, 0.7);
      this.loudTarget = (0.3 + 0.7 * Math.pow(rpmN, 0.9)) * lvl * (1 + 0.15 * nit);
      this.exGain = 1;
      this.inGain = 0.08 + 0.55 * L * L + 0.25 * nit;
      this.combGain = (0.05 + 0.45 * L) * (0.6 + 0.4 * rpmN);
      this.raspGain = 0.05 + 0.4 * L * L + 0.2 * nit;
      this.drive = 0.9 + 1.3 * L + 0.5 * nit + 0.35 * rpmN;
      this.mechGain = (0.07 + 0.05 * rpmN) * (1 - 0.4 * L);
      this.tickDecay = Math.exp(-1 / (SR * 0.0007));

      this.bpComb.set(2, 1500 + 1300 * L + 600 * rpmN, 0.9, 0);
      this.bpIntake.set(2, 620 + 700 * rpmN, 1.1, 0);

      // Output EQ morph: on-load bright & aggressive, overrun muffled & boomy.
      this.eqShelf.set(4, 150, 0.7, 3 + 2.5 * (1 - ts));
      this.eqBody.set(3, 260 + 60 * rpmN, 0.9, 2.5);
      this.eqRasp.set(3, 1750 + 500 * rpmN, 1.1, -5 + 9 * ts + 2 * nit);
      const lpf = 1100 + 900 * rpmN + (2600 + 3200 * rpmN) * Math.pow(ts, 0.9) + 1200 * nit;
      this.eqLP.set(0, lpf, 0.62, 0);
      this.eqLP2.set(0, Math.min(SR * 0.45, lpf * 1.7), 0.55, 0);
    }

    idleLoad(rpmN) {
      const x = 1 - (rpmN - 0.03) / 0.17;
      return 0.32 * (x < 0 ? 0 : x > 1 ? 1 : x);
    }

    fire(k) {
      const r = this.rng;
      const L = Math.max(this.thr, this.load * 0.85, this.idleLoad((this.rpm - 700) / (this.maxRpm - 700)));
      let a = this.cylAmp[k] * (1 + (r() * 2 - 1) * this.jitAmp);
      a *= 1 + this.lope * (1 - L);
      if (this.dropProb > 0 && r() < this.dropProb) a *= 0.15 + 0.45 * r();
      // ignition cut (shift) and limiter fuel cut
      a *= (1 - this.cut * 0.92) * this.limGate;
      // Overrun crackle: unburnt fuel igniting in the hot exhaust after lifting.
      if (this.overrunFuel > 0.02 && this.thr < 0.12) {
        const rpmN = (this.rpm - 700) / (this.maxRpm - 700);
        if (rpmN > 0.3) {
          const fFire = (this.rpm / 60) * (N_CYL / 2);
          const rate = 4.5 * this.overrunFuel * Math.min(1, (rpmN - 0.3) * 2.5); // pops per second
          if (r() < rate / fFire) this.triggerPop(0.25 + 0.75 * r() * this.overrunFuel);
        }
      }
      if (this.limOn && this.limGate < 0.5 && r() < 0.06) this.triggerPop(0.35 + 0.4 * r());
      // valvetrain/injector tick accompanying each event
      this.tick = Math.min(1.5, this.tick + 0.6 + 0.4 * r());
      return a;
    }

    process(inputs, outputs, params) {
      const out = outputs[0];
      if (!out || !out[0]) return true;
      const L = out[0];
      const R = out[1] || null;
      const n = L.length;
      const rpmArr = params.rpm;
      const rpmConst = rpmArr.length === 1;
      const thrT = params.throttle[0];
      const loadT = params.load[0];
      const nitT = params.nitro[0];
      const cutT = params.cut[0];
      const gainT = params.gain[0];
      this.maxRpm = params.maxRpm[0] || 8000;

      const kC = 1 - Math.exp(-1 / (SR * 0.006)); // control smoothing ~6 ms
      const kS = 1 - Math.exp(-1 / (SR * 0.09)); // slow throttle follower
      const kR = 1 - Math.exp(-1 / (SR * 0.004)); // rpm de-zipper
      const kL = 1 - Math.exp(-1 / (SR * 0.025)); // loudness
      const rng = this.rng;

      // Per-block state machines (128 samples).
      const dtB = n / SR;
      // overrun fuel: charged while on load at revs, burns off after lift
      const rpmNb = (this.rpm - 700) / (this.maxRpm - 700);
      if (this.thr > 0.45 && rpmNb > 0.35) this.overrunFuel = Math.min(1, this.overrunFuel + dtB * 1.5);
      else if (this.thr < 0.12) this.overrunFuel = Math.max(0, this.overrunFuel - dtB * 0.55);
      // rev limiter: fuel cut stutter ~ 14 Hz while bouncing on the limiter
      this.limOn = this.rpm >= this.maxRpm * 0.986 && this.thr > 0.5;
      if (this.limOn) {
        this.limT += dtB;
        const per = 0.072;
        const ph = (this.limT % per) / per;
        this.limGate = ph < 0.42 ? 0.06 : 1;
      } else {
        this.limT = 0;
        this.limGate = 1;
      }
      // idle lope: slow random walk of combustion strength
      this.lopeT -= dtB;
      if (this.lopeT <= 0) {
        this.lopeT = 0.12 + rng() * 0.25;
        this.lopeTarget = (rng() * 2 - 1) * 0.22;
      }
      this.lope += (this.lopeTarget - this.lope) * Math.min(1, dtB * 6);
      // micro rpm wander (real crank speed is never perfectly steady): +-0.3 %, 3-8 Hz
      this.wanderT -= dtB;
      if (this.wanderT <= 0) {
        this.wanderT = 0.06 + rng() * 0.2;
        this.wanderTarget = (rng() * 2 - 1) * 0.003;
      }
      this.wander += (this.wanderTarget - this.wander) * Math.min(1, dtB * 12);

      for (let i = 0; i < n; i++) {
        // --- control smoothing
        const rpmIn = rpmConst ? rpmArr[0] : rpmArr[i];
        const rpmTarget = rpmIn < 300 ? 300 : rpmIn > 14000 ? 14000 : rpmIn;
        this.rpm += (rpmTarget - this.rpm) * kR;
        this.thr += (thrT - this.thr) * kC;
        this.load += (loadT - this.load) * kC;
        this.nitro += (nitT - this.nitro) * kC;
        this.cut += (cutT - this.cut) * kC;
        this.gain += (gainT - this.gain) * kC;
        this.thrSlow += (Math.max(this.thr, this.load * 0.85, this.idleL) - this.thrSlow) * kS;
        if ((i & 31) === 0) {
          this.idleL = this.idleLoad((this.rpm - 700) / (this.maxRpm - 700));
          this.updateBlock();
        }
        this.loud += (this.loudTarget - this.loud) * kL;

        // --- firing events (fractional placement with 1-sample latency)
        const dphi = (this.rpm * (1 + this.wander)) / 120 / SR;
        this.phase += dphi;
        let ex0 = this.carry0;
        let ex1 = this.carry1;
        this.carry0 = 0;
        this.carry1 = 0;
        let guard = 0;
        while (this.phase >= this.nextAt && guard++ < 4) {
          const frac = Math.min(1, Math.max(0, (this.phase - this.nextAt) / dphi));
          const a = this.fire(this.k);
          if (BANK_OF[this.k] === 0) { ex0 += a * frac; this.carry0 += a * (1 - frac); }
          else { ex1 += a * frac; this.carry1 += a * (1 - frac); }
          this.k++;
          if (this.k >= N_CYL) {
            this.k = 0;
            this.phase -= 1;
          }
          const jit = (rng() * 2 - 1) * this.jitT;
          this.nextAt = (this.k + this.cylOff[this.k] + jit) / N_CYL;
        }

        // --- pressure pulses per bank (unit-peak alpha-function shape)
        const nP = this.normP;
        const aP = this.aP;
        const aD = this.aDec;
        this.p0a += aP * (ex0 * nP - this.p0a);
        this.p0b += aD * (this.p0a - this.p0b);
        this.p1a += aP * (ex1 * nP - this.p1a);
        this.p1b += aD * (this.p1a - this.p1b);
        // rasp: the sharp leading edge of the blowdown
        this.r0 += this.aR * (ex0 - this.r0);
        this.r1 += this.aR * (ex1 - this.r1);
        const pulse0 = this.p0b;
        const pulse1 = this.p1b;
        const env = pulse0 + pulse1;

        // --- combustion / flow noise, amplitude-modulated by the pulses
        const wn = rng() * 2 - 1;
        const envc = env > 0 ? env : 0;
        const comb = this.bpComb.process(wn) * envc * this.combGain;

        // --- overrun pops (noise burst + sharp click, injected into the exhaust so pipes ring)
        let pop = 0;
        if (this.popQueue.length) {
          for (let q = this.popQueue.length - 1; q >= 0; q--) {
            const p = this.popQueue[q];
            if (--p.t <= 0) { this.triggerPop(p.s); this.popQueue.splice(q, 1); }
          }
        }
        if (this.popEnv > 1e-4) {
          this.popLP += 0.35 * (wn - this.popLP);
          pop = this.popLP * this.popEnv * 1.8 + this.popClick;
          this.popEnv *= this.popDecay;
          this.popClick *= 0.82;
        }

        // --- exhaust: bank pulses -> header/pipe waveguides
        const rg = this.raspGain;
        const in0 = pulse0 + this.r0 * rg * 2.2 + comb * 0.5 + (this.popBank === 0 ? pop : pop * 0.3);
        const in1 = pulse1 + this.r1 * rg * 2.2 + comb * 0.5 + (this.popBank === 1 ? pop : pop * 0.3);
        const e0 = this.pipe0.process(in0, this.D0, -0.5, this.pipeDamp);
        const e1 = this.pipe1.process(in1, this.D1, -0.46, this.pipeDamp);
        let ex = (e0 + e1) * 0.5;
        // muffler/collector chamber: short positive-reflection resonance
        ex = this.muffler.process(ex, this.Dm, 0.32, 0.6) * 0.75;

        // --- intake: suction pulses through a short open pipe + induction roar noise
        const exI = ex0 + ex1;
        this.ia += this.aI * (exI * this.normI - this.ia);
        this.ib += this.aI * (this.ia - this.ib);
        const indNoise = this.bpIntake.process(wn) * (0.3 + 0.7 * envc);
        const intake = this.intakePipe.process(this.ib * 0.6 + indNoise * 0.5, this.Di, -0.55, 0.5) * this.inGain;

        // --- mechanical (valvetrain/chain) high-frequency texture
        this.tick *= this.tickDecay;
        const mech = this.hpMech.process(wn) * (this.tick + 0.08) * this.mechGain;

        // --- mix, growl (asymmetric soft saturation adds even harmonics), DC block
        let x = ex * this.exGain + intake + comb * 0.35 + mech;
        const dr = this.drive;
        x = (sat(x * dr * 0.55 + 0.18) - sat(0.18)) / (0.55 * Math.sqrt(dr));
        const y0 = this.hpSub.process(x);

        // --- output EQ
        let y = this.eqShelf.process(y0);
        y = this.eqBody.process(y);
        y = this.eqRasp.process(y);
        y = this.eqLP.process(y);
        y = this.eqLP2.process(y);

        // bright "crack" of overrun pops bypasses the (possibly muffled) output EQ
        if (pop !== 0 || this.popLp2 > 1e-6 || this.popLp2 < -1e-6) {
          const hp = pop - this.popHpX + this.popHpR * this.popHpY;
          this.popHpX = pop;
          this.popHpY = hp;
          this.popLp2 += this.popLpA * (hp - this.popLp2);
          y += this.popLp2 * 0.6;
        }

        // subtle stereo width from the bank difference (DC-blocked, low-passed)
        const dside = e0 - e1;
        this.sideHp = dside - this.sideX + 0.996 * this.sideHp;
        this.sideX = dside;
        this.side += this.sideA * (this.sideHp - this.side);
        const g = this.loud * this.gain * 0.3;
        const s = this.side * 0.05;
        L[i] = (y + s) * g;
        if (R) R[i] = (y - s) * g;
      }

      // NaN/instability guard: reset all state rather than emitting garbage forever.
      if (!(L[n - 1] === L[n - 1]) || Math.abs(L[n - 1]) > 50) this.resetState(L, R);
      return true;
    }

    resetState(L, R) {
      L.fill(0);
      if (R) R.fill(0);
      this.p0a = this.p0b = this.p1a = this.p1b = this.r0 = this.r1 = this.ia = this.ib = 0;
      this.carry0 = this.carry1 = 0;
      this.pipe0.clear(); this.pipe1.clear(); this.intakePipe.clear(); this.muffler.clear();
      for (const b of [this.bpComb, this.bpIntake, this.hpMech, this.eqShelf, this.eqBody, this.eqRasp, this.eqLP, this.eqLP2]) b.reset();
      this.hpSub.reset(); this.side = 0; this.sideHp = 0; this.sideX = 0; this.popEnv = 0; this.popClick = 0; this.popLP = 0; this.popHpX = 0; this.popHpY = 0; this.popLp2 = 0;
      if (!(this.rpm === this.rpm)) this.rpm = 900;
      if (!(this.thr === this.thr)) this.thr = 0;
      if (!(this.load === this.load)) this.load = 0;
      if (!(this.thrSlow === this.thrSlow)) this.thrSlow = 0;
      if (!(this.loud === this.loud)) this.loud = 0;
      if (!(this.phase === this.phase)) { this.phase = 0; this.k = 0; this.nextAt = 0; }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Opponent engines: 4 cheap voices (pulse train + pipe + air-absorption LP + equal-power pan).
  // Controlled by port messages: Float32Array [rpm, throttle, gain, pan, lpHz] x 4 (smoothed here).
  // ---------------------------------------------------------------------------------------------
  const MAX_VOICES = 4;
  const VOICE_CYL = [8, 6, 10, 8];
  const VOICE_PIPE = [1.7, 1.35, 1.55, 2.05];

  class Voice {
    constructor(i, seed) {
      this.rng = makeRng(seed + i * 7919);
      this.nCyl = VOICE_CYL[i % VOICE_CYL.length];
      this.pipeLen = VOICE_PIPE[i % VOICE_PIPE.length];
      this.amp = new Float32Array(this.nCyl);
      for (let k = 0; k < this.nCyl; k++) this.amp[k] = 1 + (this.rng() * 2 - 1) * 0.12;
      this.phase = this.rng();
      this.k = 0;
      this.nextAt = 0;
      this.carry = 0;
      this.pa = 0; this.pb = 0;
      this.pipe = new Pipe(Math.ceil(SR * 0.02));
      this.lp1 = 0; this.lp2 = 0;
      this.dc = 0; this.dcx = 0;
      this.rpm = 1500; this.thr = 0; this.gain = 0; this.pan = 0; this.lpHz = 4000;
      this.nz1 = 0; this.nz2 = 0; // pass-by tire/air noise state
      this.tRpm = 1500; this.tThr = 0; this.tGain = 0; this.tPan = 0; this.tLp = 4000;
    }
  }

  class OpponentsProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const po = (options && options.processorOptions) || {};
      this.voices = [];
      for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice(i, po.seed || 4242));
      this.port.onmessage = (e) => {
        const d = e.data;
        if (!d || !d.length) return;
        for (let i = 0; i < MAX_VOICES; i++) {
          const v = this.voices[i];
          const o = i * 5;
          if (o + 4 >= d.length) { v.tGain = 0; continue; }
          const ok = (x) => x === x && Math.abs(x) < 1e6;
          if (ok(d[o])) v.tRpm = Math.min(14000, Math.max(500, d[o]));
          if (ok(d[o + 1])) v.tThr = Math.min(1, Math.max(0, d[o + 1]));
          if (ok(d[o + 2])) v.tGain = Math.min(2, Math.max(0, d[o + 2]));
          if (ok(d[o + 3])) v.tPan = Math.min(1, Math.max(-1, d[o + 3]));
          if (ok(d[o + 4])) v.tLp = Math.min(16000, Math.max(200, d[o + 4]));
        }
      };
    }

    process(inputs, outputs) {
      const out = outputs[0];
      if (!out || !out[0]) return true;
      const L = out[0];
      const R = out[1] || null;
      // optional 2nd output: reverb send with gentler distance attenuation (sqrt of the dry gain),
      // so far-away cars are more reverberant (direct/reverb ratio = key distance cue)
      const wet = outputs[1] && outputs[1][0] ? outputs[1] : null;
      const WL = wet ? wet[0] : null;
      const WR = wet ? wet[1] || null : null;
      const n = L.length;
      L.fill(0);
      if (R) R.fill(0);
      if (WL) WL.fill(0);
      if (WR) WR.fill(0);
      const kC = 1 - Math.exp(-1 / (SR * 0.05));
      for (let vi = 0; vi < MAX_VOICES; vi++) {
        const v = this.voices[vi];
        if (v.gain < 1e-5 && v.tGain < 1e-5) { v.gain = 0; continue; }
        // per-block derived values (block = 128 samples; params are smoothed per sample below)
        const r = v.rng;
        const N = v.nCyl;
        const fFire = (v.rpm / 60) * (N / 2);
        const sharp = 2.0 + 3.0 * v.thr;
        const aP = 1 - Math.exp((-TAU * Math.min(SR * 0.2, fFire * sharp)) / SR);
        const norm = E / aP;
        const aLp = 1 - Math.exp((-TAU * Math.min(SR * 0.45, v.lpHz)) / SR);
        const D = (2 * v.pipeLen * SR) / (480 + 60 * v.thr);
        const drive = 1.2 + 1.8 * v.thr;
        const lvl = (0.35 + 0.65 * Math.min(1, v.rpm / 8000)) * (0.45 + 0.55 * v.thr);
        for (let i = 0; i < n; i++) {
          v.rpm += (v.tRpm - v.rpm) * kC;
          v.thr += (v.tThr - v.thr) * kC;
          v.gain += (v.tGain - v.gain) * kC;
          v.pan += (v.tPan - v.pan) * kC;
          v.lpHz += (v.tLp - v.lpHz) * kC;
          const dphi = v.rpm / 120 / SR;
          v.phase += dphi;
          let ex = v.carry;
          v.carry = 0;
          let guard = 0;
          while (v.phase >= v.nextAt && guard++ < 4) {
            const frac = Math.min(1, Math.max(0, (v.phase - v.nextAt) / dphi));
            const a = v.amp[v.k] * (1 + (r() * 2 - 1) * (0.08 + 0.15 * (1 - v.thr)));
            ex += a * frac;
            v.carry += a * (1 - frac);
            v.k++;
            if (v.k >= N) { v.k = 0; v.phase -= 1; }
            v.nextAt = (v.k + (r() * 2 - 1) * 0.015) / N;
          }
          v.pa += aP * (ex * norm - v.pa);
          v.pb += aP * (v.pa - v.pb);
          let x = v.pipe.process(v.pb, D, -0.5, 0.35);
          x = sat(x * drive * 0.5) / (0.5 * Math.sqrt(drive));
          // DC block
          const y = x - v.dcx + 0.9985 * v.dc;
          v.dcx = x;
          v.dc = y;
          // pass-by noise (tires on wet asphalt + air): only audible when the car is close
          const g3 = v.gain * v.gain * v.gain;
          const nz = (r() * 2 - 1) * g3 * 0.2;
          v.nz1 += 0.25 * (nz - v.nz1);
          v.nz2 += 0.1 * (v.nz1 - v.nz2);
          // air absorption / distance muffling (2 one-poles)
          v.lp1 += aLp * (y - v.lp1);
          v.lp2 += aLp * (v.lp1 - v.lp2);
          const dry = v.lp2 * lvl;
          const s = dry * v.gain * 0.3 + (v.nz1 - v.nz2 * 0.6);
          const p = (v.pan + 1) * 0.25 * Math.PI;
          const cp = Math.cos(p);
          const sp = Math.sin(p);
          if (R) {
            L[i] += s * cp;
            R[i] += s * sp;
          } else L[i] += s * 0.7;
          if (WL) {
            const w = dry * Math.sqrt(v.gain) * 0.12;
            WL[i] += w * (0.5 + 0.5 * cp);
            if (WR) WR[i] += w * (0.5 + 0.5 * sp);
          }
        }
        if (!(v.lp2 === v.lp2) || !(v.pb === v.pb)) {
          v.pa = v.pb = v.lp1 = v.lp2 = v.dc = v.dcx = v.carry = 0;
          v.pipe.clear();
          v.phase = 0; v.k = 0; v.nextAt = 0;
        }
      }
      return true;
    }
  }

  registerProcessor('apex-engine', EngineProcessor);
  registerProcessor('apex-opponents', OpponentsProcessor);
}

/** Source text of the worklet module (an IIFE of `workletScope`). */
export const ENGINE_WORKLET_SOURCE = `(${workletScope.toString()})();\n`;

const modulePromises = new WeakMap();

/**
 * Registers the engine processors on `ctx` (once per context). Resolves true on success, false if
 * AudioWorklet is unavailable (insecure context, old browser) or the module fails to load.
 */
export function loadEngineWorklet(ctx) {
  if (!ctx || !ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.resolve(false);
  let p = modulePromises.get(ctx);
  if (!p) {
    p = (async () => {
      let url = null;
      try {
        url = URL.createObjectURL(new Blob([ENGINE_WORKLET_SOURCE], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(url);
        return true;
      } catch (e) {
        console.warn('[audio] AudioWorklet unavailable, using native fallback engine:', e && e.message);
        return false;
      } finally {
        if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    })();
    modulePromises.set(ctx, p);
  }
  return p;
}
