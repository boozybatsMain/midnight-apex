// Shared, cross-module constants for MIDNIGHT APEX.
// Owned by the integrator. Modules may READ these; module-private tuning belongs inside the module.
// Units: meters, seconds, radians, kg. World is Y-up, flat ground at y = 0.

const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

export const URL_PARAMS = {
  autostart: params.get('autostart') === '1', // skip the title menu, go straight to countdown
  autopilot: params.get('autopilot') === '1', // player car driven by AIDriver (attract mode / automated tests)
  laps: params.has('laps') ? Math.max(1, parseInt(params.get('laps'), 10) || 3) : null,
  ai: params.has('ai') ? Math.max(0, Math.min(7, parseInt(params.get('ai'), 10) || 0)) : null,
  quality: params.get('quality') || null, // 'low' | 'high'
  nofx: params.get('nofx') === '1', // bypass post-processing (debug)
  mute: params.get('mute') === '1',
  debug: params.get('debug') === '1',
  timescale: params.has('timescale') ? parseFloat(params.get('timescale')) || 1 : 1,
};

export const CONFIG = {
  title: 'MIDNIGHT APEX',
  subtitle: 'Neon District Circuit',

  race: {
    laps: URL_PARAMS.laps ?? 3,
    aiCount: URL_PARAMS.ai ?? 4, // opponents (total racers = aiCount + 1)
    countdownSeconds: 3,
  },

  physics: {
    fixedDt: 1 / 120, // vehicle simulation step (game core sub-steps the frame)
    maxSubSteps: 8,
    gravity: 9.81,
  },

  // Shared car geometry so the visual model, physics, particles and collisions agree.
  car: {
    length: 4.55,
    width: 1.95,
    height: 1.22,
    wheelBase: 2.70, // distance between front and rear axle
    trackWidth: 1.66, // distance between left and right wheel centers
    wheelRadius: 0.35,
    wheelWidth: 0.28,
    // Local-space convention: origin on the ground (y=0), centered laterally, halfway between the axles.
    // +Z = forward, +Y = up, +X = the car's LEFT side, -X = RIGHT side.
    frontAxleZ: 1.35, // = wheelBase / 2
    rearAxleZ: -1.35,
    collisionHalfLength: 2.25,
    collisionHalfWidth: 0.95,
  },

  // Player + opponent liveries (body paint colors, hex).
  liveries: [
    { name: 'YOU', color: 0x0a3cff, accent: 0x00e5ff }, // player: deep electric blue
    { name: 'RAZOR', color: 0xd10f1f, accent: 0xffffff },
    { name: 'VENOM', color: 0x39d353, accent: 0x111111 },
    { name: 'GHOST', color: 0xe8e8ee, accent: 0xff2a6d },
    { name: 'NOVA', color: 0xff8a00, accent: 0x111111 },
    { name: 'SHADE', color: 0x14141a, accent: 0xb026ff },
    { name: 'BLAZE', color: 0xffd400, accent: 0x111111 },
    { name: 'FROST', color: 0x7fd3ff, accent: 0x0b1a40 },
  ],

  track: {
    roadWidth: 16, // drivable asphalt width (4 lanes)
    wallMargin: 1.2, // asphalt beyond the white edge line up to the barrier face
  },

  quality: URL_PARAMS.quality ?? 'high',
};

// Render layers shared across modules. Layer 0 is the default for everything.
// NO_REFLECTION: objects that the main cameras see but the wet-road planar reflection must skip
// (nitro/exhaust flames, sparks, spray/smoke particles, rain, headlight road decals).
// Usage: obj.layers.set(LAYERS.NO_REFLECTION). Core enables this layer on every game camera;
// the world's reflection camera masks it out.
export const LAYERS = { DEFAULT: 0, NO_REFLECTION: 3 };

// Small math helpers shared by modules (pure functions only).
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt)); // frame-rate independent smoothing
export const wrapAngle = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
// Forward/right vectors for a heading (rotation about +Y, object.rotation.y = heading).
// heading 0 faces +Z. forward = (sin h, 0, cos h). right = cross(forward, UP) = (-cos h, 0, sin h).
export const headingForward = (h, out) => out.set(Math.sin(h), 0, Math.cos(h));
export const headingRight = (h, out) => out.set(-Math.cos(h), 0, Math.sin(h));
export const headingFromDir = (dx, dz) => Math.atan2(dx, dz);
