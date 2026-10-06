// MIDNIGHT APEX — night sky dome: deep blue-violet zenith, orange/magenta light-pollution glow at the
// horizon, low rain clouds lit from below by the city, a moon hidden behind the overcast.
// Single draw call, follows the camera so it can never be "reached".
import * as THREE from 'three';
import { tileableFbm, normalizeField } from './textures.js';

function createCloudTexture(size = 512) {
  const a = normalizeField(tileableFbm(size, 4, 6, 77, 0.55));
  const b = normalizeField(tileableFbm(size, 8, 5, 91, 0.5));
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.round(a[i] * 255);
    data[i * 4 + 1] = Math.round(b[i] * 255);
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export const SKY_COLORS = {
  zenith: new THREE.Color(0.0018, 0.0022, 0.0075),
  mid: new THREE.Color(0.006, 0.006, 0.02),
  horizon: new THREE.Color(0.022, 0.012, 0.03),
  glow: new THREE.Color(0.05, 0.018, 0.01),
};

export function createSky({ radius = 2800, moonDir = new THREE.Vector3(-0.4, 0.6, -0.7) } = {}) {
  const uniforms = {
    uTime: { value: 0 },
    uClouds: { value: createCloudTexture() },
    uMoonDir: { value: moonDir.clone().normalize() },
    uZenith: { value: SKY_COLORS.zenith },
    uMid: { value: SKY_COLORS.mid },
    uHorizon: { value: SKY_COLORS.horizon },
    uGlow: { value: SKY_COLORS.glow },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = vec4(p.xy, p.w * 0.99999, p.w); // pin to the far plane (also safe with oblique clipping)
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform sampler2D uClouds;
      uniform vec3 uMoonDir, uZenith, uMid, uHorizon, uGlow;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        float hp = max(h, 0.0);
        float az = atan(d.z, d.x);
        // base gradient + light pollution (stronger toward the downtown / harbour directions)
        vec3 col = mix(uMid, uZenith, smoothstep(0.02, 0.55, hp));
        float band = exp(-hp * 7.0);
        float glowAz = 0.65 + 0.35 * sin(az * 2.0 + 0.8) + 0.2 * sin(az * 5.0 + 2.0);
        col += uHorizon * band * 1.4;
        col += uGlow * exp(-hp * 16.0) * glowAz;
        // low overcast: two scrolling fBm layers projected on a cloud plane
        vec2 cp = d.xz / (hp + 0.09);
        vec2 drift = vec2(uTime * 0.004, uTime * 0.0013);
        float c1 = texture2D(uClouds, cp * 0.11 + drift).r;
        float c2 = texture2D(uClouds, cp * 0.29 - drift * 1.7).g;
        float dens = smoothstep(0.38, 0.85, c1 * 0.75 + c2 * 0.45);
        float horizonFade = smoothstep(0.0, 0.06, hp);
        // underside lit by the city: warm near the horizon, violet higher up
        vec3 lit = mix(vec3(0.045, 0.018, 0.03), vec3(0.012, 0.01, 0.03), smoothstep(0.05, 0.6, hp));
        lit *= 0.6 + 0.8 * c2;
        col = mix(col, lit + col * 0.3, dens * horizonFade * 0.92);
        // moon behind the clouds
        float md = max(dot(d, normalize(uMoonDir)), 0.0);
        float moon = pow(md, 900.0) * 2.5 + pow(md, 40.0) * 0.06;
        col += vec3(0.6, 0.68, 0.85) * moon * (1.0 - dens * 0.85);
        // below the horizon: dark haze
        col = mix(col, uHorizon * 0.5 + uGlow * 0.25, smoothstep(0.0, -0.08, h));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return {
    mesh,
    uniforms,
    update(time, camera) {
      uniforms.uTime.value = time;
      if (camera) mesh.position.copy(camera.getWorldPosition(_v));
    },
  };
}
const _v = new THREE.Vector3();
