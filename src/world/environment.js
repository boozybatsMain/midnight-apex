// MIDNIGHT APEX — night-city environment around the circuit.
//
// Sets up global lighting (sky dome, FogExp2 haze, moonlight with a tight shadow frustum that follows the
// player, hemisphere fill, a PMREM night-city environment for reflections) and builds the city:
// buildings + skyline (city.js), streetlights (lamps.js), neon signs & billboards (signs.js),
// street furniture, traffic lights, overpass, waterfront (props.js). Each frame update() moves the
// shadow camera, renders the half-res planar reflection for the wet road and animates lights.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSky, SKY_COLORS } from './sky.js';
import { createPlanarReflection } from './reflection.js';
import { createCity } from './city.js';
import { createLamps } from './lamps.js';
import { createGroundMaterial, createWetShared } from './wetShader.js';
import { createSigns } from './signs.js';
import { createProps } from './props.js';
import { mulberry32 } from './textures.js';

const FOG_COLOR = new THREE.Color(0.012, 0.011, 0.026);
const FOG_DENSITY = 0.0019;
const MOON_DIR = new THREE.Vector3(-0.42, 0.78, -0.46).normalize(); // direction TO the moon

// ---------------------------------------------------------------------------------------------
// PMREM night-city environment (rendered once)
// ---------------------------------------------------------------------------------------------

function createNightEnvMap(renderer) {
  const scene = new THREE.Scene();
  const rand = mulberry32(808);
  const disposables = [];
  const add = (geo, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    scene.add(m);
    disposables.push(geo, mat);
    return m;
  };
  // sky + horizon glow
  add(new THREE.SphereGeometry(200, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uZ: { value: SKY_COLORS.mid }, uH: { value: SKY_COLORS.horizon }, uG: { value: SKY_COLORS.glow } },
    vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 uZ, uH, uG; varying vec3 vD;
      void main(){ vec3 d = normalize(vD); float h = d.y;
        vec3 c = uZ * 1.5 + uH * 2.2 * exp(-max(h,0.0) * 6.0) + uG * 1.6 * exp(-max(h,0.0) * 14.0);
        c = mix(c, vec3(0.012, 0.01, 0.016), smoothstep(0.0, -0.15, h));
        gl_FragColor = vec4(c, 1.0); }`,
  }));
  // building ring with lit windows
  const wc = document.createElement('canvas');
  wc.width = 128; wc.height = 256;
  const g = wc.getContext('2d');
  g.fillStyle = '#050608'; g.fillRect(0, 0, 128, 256);
  for (let y = 4; y < 256; y += 9) for (let x = 3; x < 128; x += 7) {
    const r = rand();
    if (r < 0.42) { g.fillStyle = r < 0.25 ? '#ffc98a' : r < 0.36 ? '#e8f0ff' : '#9fc0ff'; g.fillRect(x, y, 4, 5); }
  }
  const wtex = new THREE.CanvasTexture(wc);
  wtex.colorSpace = THREE.SRGBColorSpace;
  disposables.push(wtex);
  const bmat = new THREE.MeshBasicMaterial({ map: wtex, color: new THREE.Color(1.4, 1.4, 1.4) });
  disposables.push(bmat);
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rand() * 0.1;
    const r = 70 + rand() * 40;
    const h = 25 + rand() * 70;
    const geo = new THREE.BoxGeometry(18 + rand() * 16, h, 18);
    disposables.push(geo);
    const m = new THREE.Mesh(geo, bmat);
    m.position.set(Math.cos(a) * r, h / 2 - 2, Math.sin(a) * r);
    m.lookAt(0, h / 2 - 2, 0);
    scene.add(m);
  }
  // neon strips + signage blocks (bright, saturated: these are what car paint should mirror)
  const neon = [[6, 0.4, 4.5], [0.3, 4, 6], [6, 3, 0.4], [4.5, 0.6, 7], [0.4, 6, 1.2]];
  for (let i = 0; i < 22; i++) {
    const c = neon[i % neon.length];
    const a = rand() * Math.PI * 2;
    const r = 30 + rand() * 35;
    const m = add(new THREE.BoxGeometry(6 + rand() * 10, 0.6 + rand() * 1.5, 0.3), new THREE.MeshBasicMaterial({ color: new THREE.Color(...c) }), Math.cos(a) * r, 4 + rand() * 14, Math.sin(a) * r);
    m.lookAt(0, m.position.y, 0);
  }
  // streetlights: two rows of warm/cool spots at 9 m along the street axis
  const lampM = new THREE.MeshBasicMaterial({ color: new THREE.Color(30, 16, 6) });
  const ledM = new THREE.MeshBasicMaterial({ color: new THREE.Color(20, 24, 30) });
  disposables.push(lampM, ledM);
  const sg = new THREE.SphereGeometry(0.7, 8, 6);
  disposables.push(sg);
  for (let i = -6; i <= 6; i++) for (const side of [-1, 1]) {
    const m = new THREE.Mesh(sg, i % 3 === 0 ? ledM : lampM);
    m.position.set(side * 9, 9, i * 16);
    scene.add(m);
  }
  // wet ground: dark with a faint reflection of the glow
  add(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.012, 0.011, 0.016) }), 0, -1.2, 0);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.0, 0.5, 400);
  pmrem.dispose();
  disposables.forEach((d) => d.dispose && d.dispose());
  return rt.texture;
}

// ---------------------------------------------------------------------------------------------
// Ground (land polygon with the bay cut out), water, quay
// ---------------------------------------------------------------------------------------------

function createGround(track, shared) {
  const shoreZ = track.features.shoreZ;
  const E = 5000;
  const shape = new THREE.Shape();
  // Shape lives in (x, −z) so that rotateX(−π/2) maps it to the XZ plane facing up.
  shape.moveTo(-E, E);
  shape.lineTo(E, E);
  shape.lineTo(E, -shoreZ(E));
  for (let x = E; x >= -E; x -= x > 1500 || x < -1500 ? 250 : 8) shape.lineTo(x, -shoreZ(x));
  shape.lineTo(-E, -shoreZ(-E));
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, createGroundMaterial(shared));
  mesh.position.y = -0.02;
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  mesh.frustumCulled = false;
  return mesh;
}

function createWaterMaterial(shared) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x010306, roughness: 0.14, metalness: 0 });
  mat.customProgramCacheKey = () => 'mapex-water-v1';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared.uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
uniform float uRain;
uniform sampler2D uReflTex;
uniform mat4 uReflMatrix;
uniform float uReflOn;
uniform sampler2D uMacroTex;
uniform sampler2D uDetailTex;
varying vec3 vWPos;
vec3 waterReflection(vec3 wpos, vec2 distort) {
  vec4 c = uReflMatrix * vec4(wpos, 1.0);
  vec2 uv = c.xy / max(c.w, 1e-4) + distort;
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  for (int i = 0; i < 7; i++) {
    float t = float(i) / 6.0 - 0.25;
    float w = exp(-t * t * 3.0);
    vec3 c = textureLod(uReflTex, clamp(uv + vec2(0.0, t * 0.09), 0.001, 0.999), 1.0 + abs(t) * 2.0).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722)), e = max(l - 4.0, 0.0);
    acc += c * ((l - e + e / (1.0 + e * 0.125)) / max(l, 1e-4)) * w; // HDR soft knee (as the road)
    ws += w;
  }
  return acc / ws;
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
vec2 wp = vWPos.xz;
// long, low swells (stretched along x) + slow chop; amplitude fades with distance to avoid glitter
vec2 w1 = texture2D(uMacroTex, wp * vec2(0.004, 0.012) + vec2(uTime * 0.004, uTime * 0.006)).rg - 0.5;
vec2 w2 = texture2D(uMacroTex, wp * vec2(0.011, 0.03) - vec2(uTime * 0.007, -uTime * 0.004)).rg - 0.5;
vec2 w3 = texture2D(uMacroTex, wp * 0.05 + vec2(uTime * 0.01, 0.0)).ag - 0.5;
float wfar = 1.0 - smoothstep(0.05, 0.6, length(fwidth(wp)));
vec2 wn = w1 * 0.9 + w2 * 0.6 + w3 * 0.35 * wfar;
vec3 nW = normalize(vec3(wn.x * 0.22, 1.0, wn.y * 0.22));
normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);`)
      .replace('#include <aomap_fragment>', `
if (uReflOn > 0.5) {
  vec3 nV0 = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  // distortion shrinks for steep views (seen from above the waves barely displace the mirror image)
  float graze = 1.0 - saturate(dot(normal, geometryViewDir));
  vec2 distort = (normal.xy - nV0.xy) * vec2(0.012, 0.035) * (0.3 + 0.7 * graze);
  vec3 refl = waterReflection(vWPos, distort);
  vec3 envF = EnvironmentBRDF(normal, geometryViewDir, material.specularColor, material.specularF90, material.roughness);
  // planar reflection only (the PMREM's stylised neon boxes would read as flat patches on the water)
  reflectedLight.indirectSpecular = reflectedLight.indirectSpecular * 0.04 + refl * envF * 1.4;
}
#include <aomap_fragment>`);
  };
  return mat;
}

function createWater(track, shared) {
  const geo = new THREE.PlaneGeometry(10000, 6000, 1, 1).rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, createWaterMaterial(shared));
  const zMin = Math.min(...[-1000, 0, 1000].map((x) => track.features.shoreZ(x)));
  mesh.position.set(0, -1.3, zMin - 20 + 3000);
  mesh.name = 'water';
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------------------------
// createEnvironment
// ---------------------------------------------------------------------------------------------

export function createEnvironment({ scene, renderer, track, quality } = {}) {
  const q = quality || 'high';
  const group = new THREE.Group();
  group.name = 'environment';
  if (!scene) scene = new THREE.Scene();

  // r186 removed PCFSoftShadowMap (it silently falls back to PCF on the first shadow render). Switch up
  // front so programs compiled by our early reflection pass match the final shadow sampler type.
  if (renderer && renderer.shadowMap.type === THREE.PCFSoftShadowMap) renderer.shadowMap.type = THREE.PCFShadowMap;

  scene.background = FOG_COLOR.clone();
  scene.fog = new THREE.FogExp2(FOG_COLOR.clone(), FOG_DENSITY);

  // Shared wet-surface uniforms (the road created them; reuse so one reflection feeds everything).
  const shared = track?.wet || createWetShared({ quality: q });

  // --- lights ---
  const hemi = new THREE.HemisphereLight(new THREE.Color(0.35, 0.38, 0.6), new THREE.Color(0.12, 0.07, 0.06), 0.14);
  group.add(hemi);
  const moonLight = new THREE.DirectionalLight(new THREE.Color(0.62, 0.7, 1.0), 0.55);
  moonLight.name = 'moonLight';
  moonLight.castShadow = true;
  const sm = q === 'low' ? 1024 : 2048;
  moonLight.shadow.mapSize.set(sm, sm);
  const SH = 48; // half extent of the shadow frustum (m)
  Object.assign(moonLight.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 420 });
  moonLight.shadow.camera.updateProjectionMatrix();
  moonLight.shadow.bias = -0.0004;
  moonLight.shadow.normalBias = 0.03;
  moonLight.position.copy(MOON_DIR).multiplyScalar(200);
  group.add(moonLight, moonLight.target);

  // --- sky ---
  const sky = createSky({ moonDir: MOON_DIR });
  group.add(sky.mesh);

  // --- envmap ---
  let envMap = null;
  if (renderer) {
    try { envMap = createNightEnvMap(renderer); } catch (e) { console.warn('[environment] envmap failed', e); }
  }

  // --- ground / water ---
  const reflectHidden = [];
  let ground = null, water = null;
  if (track) {
    ground = createGround(track, shared);
    water = createWater(track, shared);
    group.add(ground, water);
    reflectHidden.push(ground, water, ...(track.reflectionHidden || []));
  }

  // --- city, lamps, signs, props ---
  let city = null, lamps = null, signs = null, props = null;
  if (track) {
    city = createCity({ track, quality: q });
    group.add(city.group);
    props = createProps({ track, city, shared, quality: q });
    lamps = createLamps({ track, shared, quality: q, extraLights: props.extraLights });
    city.setStreetLights?.(lamps.posts); // streetlight wash on the lower facades
    group.add(lamps.group);
    group.add(props.group);
    signs = createSigns({ track, city, shared, quality: q });
    group.add(signs.group);
    reflectHidden.push(...(lamps.smallStuff || []), ...(props.reflectHidden || []), ...(signs.reflectHidden || []));
    // bus-shelter ad panels use the billboard ad atlas
    if (props.adPanels?.length && signs.adTexture) {
      const ads = new THREE.Mesh(mergeGeometries(props.adPanels), new THREE.MeshBasicMaterial({ map: signs.adTexture, color: new THREE.Color(1.8, 1.8, 1.8) }));
      ads.name = 'shelterAds';
      props.group.add(ads);
    }
  }

  // --- planar reflection ---
  const reflection = renderer && q !== 'low' ? createPlanarReflection(renderer, { scale: 0.5, maxWidth: 1024 }) : null;
  if (reflection) {
    shared.uniforms.uReflTex.value = reflection.texture;
    shared.uniforms.uReflOn.value = 1;
  }

  scene.add(group);

  const snap = new THREE.Vector3();
  // Moon-aligned basis for texel snapping (constant: the moon never moves) — built once, no per-frame garbage.
  const lightSpace = new THREE.Matrix4().lookAt(MOON_DIR, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
  const lightSpaceInv = lightSpace.clone().invert();
  let clock = 0;
  const env = {
    group,
    envMap,
    moonLight,
    hemiLight: hemi,
    sky,
    city,
    lamps,
    signs,
    props,
    reflection,
    fog: scene.fog,
    /** Per-frame: shadow follow, planar reflection, animated lights. Call before the main render. */
    update(dt = 0, { time, camera, focus } = {}) {
      clock = time != null ? time : clock + dt;
      shared.uniforms.uTime.value = clock;
      if (city) city.update(clock);
      if (signs) signs.update(clock, dt, camera);
      if (props) props.update(clock, dt, camera);
      sky.update(clock, camera);
      // Shadow frustum follows the focus, snapped to shadow-map texels to avoid shimmering.
      const f = focus || (camera ? camera.position : null);
      if (f) {
        const texel = (SH * 2) / moonLight.shadow.mapSize.x;
        snap.set(f.x, 0, f.z).applyMatrix4(lightSpaceInv);
        snap.x = Math.round(snap.x / texel) * texel;
        snap.y = Math.round(snap.y / texel) * texel;
        snap.applyMatrix4(lightSpace);
        moonLight.target.position.copy(snap);
        moonLight.position.copy(snap).addScaledVector(MOON_DIR, 200);
        moonLight.target.updateMatrixWorld();
        moonLight.updateMatrixWorld();
      }
      // (skip until the main pass has created the shadow map, otherwise the first reflection frame
      // binds a placeholder to the shadow sampler)
      if (reflection && camera && (moonLight.shadow.map || !renderer.shadowMap.enabled)) {
        camera.updateMatrixWorld();
        city?.setLite?.(true);
        reflection.render(scene, camera, reflectHidden);
        city?.setLite?.(false);
        shared.uniforms.uReflMatrix.value.copy(reflection.textureMatrix);
      }
    },
    setRain(v) {
      shared.uniforms.uRain.value = v;
    },
    dispose() {
      reflection?.dispose();
      envMap?.dispose();
    },
  };
  return env;
}
