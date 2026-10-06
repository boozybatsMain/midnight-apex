// Barrier and car-vs-car collisions. Runs inside every physics sub-step (1/120 s), so even at
// 330 km/h a car moves < 0.8 m per step — far less than the 1.9 m combined circle radius,
// and the barrier is a half-space (a clamp), so nothing can tunnel.
import * as THREE from 'three';

const WALL_RESTITUTION = 0.3;
const WALL_FRICTION = 0.26; // Coulomb μ for the tangential impulse on impact
const WALL_SCRAPE_DECEL = 3.2; // m/s² extra drag while grinding along the barrier
const WALL_ALIGN_RATE = 1.6; // rad/s yaw toward the wall tangent while in contact
const WALL_IMPULSE_LEVER = 0.3; // apply the wall impulse partway to the corner (tames spins)
const CAR_RESTITUTION = 0.22;
const CAR_FRICTION = 0.25;
const CAR_LEVER = 0.7;

const _F = new THREE.Vector3();
const _Rc = new THREE.Vector3();
const _T = new THREE.Vector3();
const _R = new THREE.Vector3();
const _n = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _arm = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _vt = new THREE.Vector3();
const _J = new THREE.Vector3();
const _ca = new THREE.Vector3();
const _cb = new THREE.Vector3();
const _bestA = new THREE.Vector3();
const _bestB = new THREE.Vector3();
const _vpa = new THREE.Vector3();
const _vpb = new THREE.Vector3();
const _corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _cornerLat = new Float64Array(4);

// Point velocity of a rigid body moving in the XZ plane with yaw rate ω about +Y:
// v_p = v + ω × r = v + (ω r_z, 0, −ω r_x).
function pointVelocity(ph, arm, out) {
  const w = ph.yawRate || 0;
  return out.set(ph.velocity.x + w * arm.z, 0, ph.velocity.z - w * arm.x);
}

// Yaw inertia estimate for the effective-mass term (box: m(L²+W²)/12).
function inertia(ph) {
  if (ph.inertia) return ph.inertia;
  const L = (ph.halfLength || 2.25) * 2, W = (ph.halfWidth || 0.95) * 2;
  return (ph.mass || 1450) * (L * L + W * W) / 12;
}

/** Contact bookkeeping per car (consumed once per frame by effects/audio). */
export function createContactState() {
  return {
    wallImpact: 0, // max normal impact speed this frame (m/s)
    wallScrape: 0, // max tangential sliding speed while touching (m/s)
    wallPoint: new THREE.Vector3(),
    wallNormal: new THREE.Vector3(),
    wallTouching: false,
    carImpact: 0,
    carPoint: new THREE.Vector3(),
    carNormal: new THREE.Vector3(),
    carOther: -1,
  };
}

export function clearContacts(contact) {
  contact.wallImpact = 0;
  contact.wallScrape = 0;
  contact.wallTouching = false;
  contact.carImpact = 0;
  contact.carOther = -1;
}

/**
 * Barrier collision for one car. Also refreshes car.s / car.lateral from track.project
 * (cars keep their projection hint here, every sub-step).
 */
export function collideBarrier(track, car, dt) {
  const ph = car.physics;
  const pr = track.project(ph.position, car.s, car._proj); // `out` param avoids an allocation per call
  car.s = pr.s;
  car.lateral = pr.lateral;
  const W = track.wallOffset;
  const hl = ph.halfLength || 2.25;
  const hw = ph.halfWidth || 0.95;
  // Quick reject: the farthest corner is at most √(hl²+hw²) from the center.
  if (Math.abs(pr.lateral) + 2.45 < W) return;

  const h = ph.heading;
  _F.set(Math.sin(h), 0, Math.cos(h));
  _Rc.set(-Math.cos(h), 0, Math.sin(h));
  track.getTangentAt(pr.s, _T);
  track.getRightAt(pr.s, _R);
  const k = track.getCurvatureAt(pr.s) || 0;

  // Lateral of each corner relative to the curved centerline: straight-line offset minus the
  // curvature sag κ·d²/2 of the centerline over the corner's along-track distance d.
  let maxLat = -Infinity, minLat = Infinity;
  let ci = 0;
  for (let sz = -1; sz <= 1; sz += 2) {
    for (let sx = -1; sx <= 1; sx += 2) {
      const c = _corners[ci];
      c.set(_F.x * hl * sz + _Rc.x * hw * sx, 0, _F.z * hl * sz + _Rc.z * hw * sx);
      const d = c.x * _T.x + c.z * _T.z;
      const lat = pr.lateral + c.x * _R.x + c.z * _R.z - (k * d * d) / 2;
      _cornerLat[ci] = lat;
      if (lat > maxLat) maxLat = lat;
      if (lat < minLat) minLat = lat;
      ci++;
    }
  }

  let side = 0, pen = 0;
  if (maxLat > W) { side = 1; pen = maxLat - W; }
  else if (minLat < -W) { side = -1; pen = -W - minLat; }
  if (side === 0) return;

  // Inward normal (away from the wall) and contact point = mean of the penetrating corners.
  _n.copy(_R).multiplyScalar(-side);
  _cp.set(0, 0, 0);
  let cnt = 0;
  for (let i = 0; i < 4; i++) {
    const p = side > 0 ? _cornerLat[i] - W : -W - _cornerLat[i];
    if (p > 0) { _cp.add(_corners[i]); cnt++; }
  }
  _cp.multiplyScalar(1 / Math.max(1, cnt)); // car-relative arm

  // 1) Positional correction (wall is static → the car takes all of it).
  ph.position.addScaledVector(_n, pen + 0.002);

  // 2) Velocity response at the (moderated) contact arm.
  _arm.copy(_cp).multiplyScalar(WALL_IMPULSE_LEVER);
  pointVelocity(ph, _arm, _vp);
  const vn = _vp.dot(_n);
  const m = ph.mass || 1450;
  const I = inertia(ph);
  const contact = car.contact;
  _vt.copy(_vp).addScaledVector(_n, -vn);
  const vtLen = _vt.length();
  contact.wallTouching = true;
  if (vtLen > contact.wallScrape) contact.wallScrape = vtLen;
  contact.wallNormal.copy(_n);
  contact.wallPoint.copy(ph.position).add(_cp).addScaledVector(_n, -pen);
  contact.wallPoint.y = 0.42;

  // Heading offset to the wall tangent (the closer of ±T) — used for glancing-hit alignment.
  const fwdDotT = _F.x * _T.x + _F.z * _T.z;
  const tangHeading = fwdDotT >= 0 ? Math.atan2(_T.x, _T.z) : Math.atan2(-_T.x, -_T.z);
  let dh = tangHeading - h;
  while (dh > Math.PI) dh -= Math.PI * 2;
  while (dh < -Math.PI) dh += Math.PI * 2;
  const noseIntoWall = _F.x * _n.x + _F.z * _n.z < 0;

  if (vn < 0) {
    const impact = -vn;
    if (impact > contact.wallImpact) contact.wallImpact = impact;
    // Crumple: hard hits bounce less (arcade feel — you deflect along the wall, not across the road).
    const e = WALL_RESTITUTION - (WALL_RESTITUTION - 0.08) * smooth(4, 28, impact);
    // Effective mass along n including the yaw lever arm: 1/m + (r×n)²/I.
    const rxn = _arm.z * _n.x - _arm.x * _n.z;
    const mEff = 1 / (1 / m + (rxn * rxn) / I);
    const jn = (1 + e) * impact * mEff;
    _J.copy(_n).multiplyScalar(jn);
    if (vtLen > 1e-3) {
      // Coulomb friction proportional to the impact, capped so it cannot reverse sliding.
      const jt = Math.min(WALL_FRICTION * jn, vtLen * m * 0.5);
      _J.addScaledVector(_vt, -jt / vtLen);
    }
    const yawBefore = ph.yawRate || 0;
    _cb.copy(ph.position).add(_arm);
    ph.applyImpulse(_J, _cb);
    // Glancing hit: snap most of the way parallel to the wall and cancel the spin the impulse
    // induced, so the car deflects and scrapes along instead of pirouetting across the road.
    // Steep (near head-on) hits keep their physical yaw.
    const glance = 1 - smooth(0.45, 0.9, Math.abs(dh));
    if (glance > 0 && impact > 0.8) {
      const k = Math.min(0.85, impact / 25) * glance;
      ph.heading += dh * k;
      ph.yawRate = (ph.yawRate || 0) + (yawBefore * (1 - k) - (ph.yawRate || 0)) * glance;
    }
  }
  // Continuous scrape drag while grinding along the wall (scales with sliding speed).
  if (vtLen > 0.5) {
    const j = Math.min(WALL_SCRAPE_DECEL * m * dt, vtLen * m * 0.25);
    _J.copy(_vt).multiplyScalar(-j / vtLen);
    _cb.copy(ph.position);
    ph.applyImpulse(_J, _cb);
  }
  // Gentle continuous alignment while touching (only turning the nose away from the wall).
  if (noseIntoWall && Math.abs(dh) < 1.2) {
    const maxStep = WALL_ALIGN_RATE * dt * Math.min(1, 0.25 + Math.abs(ph.speed || 0) / 25);
    ph.heading += Math.max(-maxStep, Math.min(maxStep, dh));
  }
}

function smooth(a, b, x) {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

/**
 * Car-vs-car: each car is a chain of 3 circles (radius = halfWidth) along its long axis —
 * a cheap, robust capsule-ish approximation of the oriented box.
 */
export function collideCars(cars, dt) {
  const n = cars.length;
  for (let i = 0; i < n; i++) {
    const A = cars[i];
    if (A.ghost > 0 || !A.active) continue;
    const pa = A.physics;
    for (let j = i + 1; j < n; j++) {
      const B = cars[j];
      if (B.ghost > 0 || !B.active) continue;
      const pb = B.physics;
      const dx = pb.position.x - pa.position.x;
      const dz = pb.position.z - pa.position.z;
      const reach = (pa.halfLength || 2.25) + (pb.halfLength || 2.25);
      if (dx * dx + dz * dz > reach * reach) continue;
      collidePair(A, B, dt);
    }
  }
}

function collidePair(A, B) {
  const pa = A.physics, pb = B.physics;
  const ra = pa.halfWidth || 0.95, rb = pb.halfWidth || 0.95;
  const oa = Math.max(0, (pa.halfLength || 2.25) - ra);
  const ob = Math.max(0, (pb.halfLength || 2.25) - rb);
  const sa = Math.sin(pa.heading), ca = Math.cos(pa.heading);
  const sb = Math.sin(pb.heading), cb = Math.cos(pb.heading);

  // Deepest circle pair.
  let best = 0;
  for (let i = -1; i <= 1; i++) {
    _ca.set(pa.position.x + sa * oa * i, 0, pa.position.z + ca * oa * i);
    for (let j = -1; j <= 1; j++) {
      _cb.set(pb.position.x + sb * ob * j, 0, pb.position.z + cb * ob * j);
      const dx = _cb.x - _ca.x, dz = _cb.z - _ca.z;
      const d2 = dx * dx + dz * dz;
      const rr = ra + rb;
      if (d2 >= rr * rr) continue;
      const depth = rr - Math.sqrt(d2);
      if (depth > best) {
        best = depth;
        _bestA.copy(_ca);
        _bestB.copy(_cb);
      }
    }
  }
  if (best <= 0) return;

  _n.subVectors(_bestB, _bestA);
  let d = _n.length();
  if (d < 1e-4) {
    _n.set(pb.position.x - pa.position.x, 0, pb.position.z - pa.position.z);
    d = _n.length();
    if (d < 1e-4) _n.set(1, 0, 0);
  }
  _n.normalize(); // A → B
  const ma = pa.mass || 1450, mb = pb.mass || 1450;
  const wa = 1 / ma, wb = 1 / mb;

  // Positional correction split by inverse mass (small slop keeps resting contact quiet).
  const corr = Math.max(0, best - 0.005) / (wa + wb);
  pa.position.addScaledVector(_n, -corr * wa);
  pb.position.addScaledVector(_n, corr * wb);

  // Contact point between the two circle surfaces.
  _cp.copy(_bestA).addScaledVector(_n, ra - best * 0.5);

  _arm.subVectors(_cp, pa.position).multiplyScalar(CAR_LEVER);
  pointVelocity(pa, _arm, _vpa);
  _ca.subVectors(_cp, pb.position).multiplyScalar(CAR_LEVER); // arm B
  pointVelocity(pb, _ca, _vpb);
  _vp.subVectors(_vpb, _vpa); // relative velocity of B w.r.t. A
  const vn = _vp.dot(_n);

  const contactA = A.contact, contactB = B.contact;
  if (vn < 0) {
    const Ia = inertia(pa), Ib = inertia(pb);
    const rna = _arm.x * _n.z - _arm.z * _n.x;
    const rnb = _ca.x * _n.z - _ca.z * _n.x;
    const k = wa + wb + (rna * rna) / Ia + (rnb * rnb) / Ib;
    const jn = (-(1 + CAR_RESTITUTION) * vn) / k;
    _J.copy(_n).multiplyScalar(jn);
    _vt.copy(_vp).addScaledVector(_n, -vn);
    const vtLen = _vt.length();
    if (vtLen > 1e-3) {
      const jt = Math.min(CAR_FRICTION * jn, vtLen / k);
      _J.addScaledVector(_vt, -jt / vtLen); // friction opposes B's sliding relative to A (and vice versa)
    }
    // J acts on B; −J on A. Applied at the moderated arm points.
    _bestB.copy(pb.position).add(_ca);
    pb.applyImpulse(_J, _bestB);
    _J.negate();
    _bestA.copy(pa.position).add(_arm);
    pa.applyImpulse(_J, _bestA);

    const impact = -vn;
    if (impact > contactA.carImpact) {
      contactA.carImpact = impact;
      contactA.carPoint.copy(_cp).setY(0.5);
      contactA.carNormal.copy(_n).negate();
      contactA.carOther = B.index;
    }
    if (impact > contactB.carImpact) {
      contactB.carImpact = impact;
      contactB.carPoint.copy(_cp).setY(0.5);
      contactB.carNormal.copy(_n);
      contactB.carOther = A.index;
    }
  } else if (contactA.carOther < 0) {
    // Resting/rubbing contact: still record it for scrape sparks.
    contactA.carOther = B.index;
    contactB.carOther = A.index;
    contactA.carPoint.copy(_cp).setY(0.5);
    contactB.carPoint.copy(_cp).setY(0.5);
  }
}
