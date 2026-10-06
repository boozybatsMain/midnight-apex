// MIDNIGHT APEX — scene depth snapshot for soft particles (owner: fx).
//
// Transparent effects (smoke, spray mist, steam...) want to fade where they intersect opaque geometry, which
// needs the depth of the opaque scene *while* the transparents are drawn. Sampling the depth attachment that is
// bound for the draw is a WebGL feedback loop, so instead the first soft-particle draw of the main scene pass
// blits the depth buffer (opaques are all drawn by then) into a separate DepthTexture and samples that.
//
// Flow (one blit per frame, only when a soft-particle mesh is actually drawn):
//   postfx  → depth.begin(renderer, mainTarget, camera)  right before its RenderPass, depth.end() after it
//   meshes  → mesh.onBeforeRender = (renderer, scene, camera) => depth.capture(renderer, camera)
//             (returns false when not in the armed main pass — e.g. the wet-road reflection, ?nofx=1, dev
//             benches without postfx — and the shader then skips the fade via uSceneDepthOn = 0)
//
// Shader side: spread `softParticleUniforms()` into the material uniforms, include SOFT_PARTICLE_GLSL in the
// fragment shader and multiply alpha by `softParticleFade(viewDepth, range)`; call `bindSoftParticles()` from
// the mesh's onBeforeRender. Cost: one depth blit (~0.1 ms at 1080p·1.5) + one texture fetch per fragment.
import * as THREE from 'three';

const registry = new WeakMap(); // renderer → SceneDepth

export const SOFT_PARTICLE_GLSL = /* glsl */ `
uniform sampler2D tSceneDepth;
uniform float uSceneDepthOn;
uniform vec2 uSceneInvSize;
uniform vec2 uSceneNearFar;
// 0 where the fragment touches opaque geometry, 1 when it is \`range\` metres (view depth) or more in front of it
float softParticleFade(float viewDepth, float range) {
  if (uSceneDepthOn < 0.5) return 1.0;
  float d = texture2D(tSceneDepth, gl_FragCoord.xy * uSceneInvSize).x;
  float n = uSceneNearFar.x, f = uSceneNearFar.y;
#ifdef USE_REVERSED_DEPTH_BUFFER
  float sceneDepth = -(n * f) / ((n - f) * d - n);
#else
  float sceneDepth = -(n * f) / ((f - n) * d - f);
#endif
  return clamp((sceneDepth - viewDepth) / max(range, 1e-3), 0.0, 1.0);
}
`;

/** Fresh uniform set for one material (values are filled per draw by bindSoftParticles). */
export function softParticleUniforms() {
  return {
    tSceneDepth: { value: null },
    uSceneDepthOn: { value: 0 },
    uSceneInvSize: { value: new THREE.Vector2(1, 1) },
    uSceneNearFar: { value: new THREE.Vector2(0.1, 1000) },
  };
}

/** Call from mesh.onBeforeRender: captures the depth if needed and points the material's uniforms at it. */
export function bindSoftParticles(renderer, camera, material) {
  const u = material.uniforms;
  const sd = registry.get(renderer);
  const ok = !!(sd && sd.capture(renderer, camera));
  u.uSceneDepthOn.value = ok ? 1 : 0;
  if (ok) {
    u.tSceneDepth.value = sd.texture;
    u.uSceneInvSize.value.copy(sd.invSize);
    u.uSceneNearFar.value.set(camera.near, camera.far);
  }
  material.uniformsNeedUpdate = true;
  return ok;
}

export function getSceneDepth(renderer) {
  return (renderer && registry.get(renderer)) || null;
}

/** Created (once per renderer) by postfx. */
export function createSceneDepth(renderer) {
  if (registry.has(renderer)) return registry.get(renderer);
  const gl = renderer.getContext();
  const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  // R8 colour attachment only to keep the framebuffer conventional; the depth texture is what we sample.
  const copy = new THREE.WebGLRenderTarget(16, 16, {
    format: THREE.RedFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthTexture: new THREE.DepthTexture(16, 16, THREE.UnsignedIntType),
  });
  copy.texture.name = 'SceneDepth.color';
  copy.depthTexture.name = 'SceneDepth';

  let target = null;
  let armed = false;
  let captured = false;
  let failed = !isGL2;

  const sd = {
    texture: copy.depthTexture,
    invSize: new THREE.Vector2(1 / 16, 1 / 16),
    enabled: true,
    /** frame counter of successful captures (debug) */
    captures: 0,
    get captured() {
      return captured;
    },
    /** Arm the capture for the next scene render into `rt` (call outside of renderer.render). */
    begin(r, rt) {
      armed = false;
      captured = false;
      if (failed || !sd.enabled || !rt || rt.isWebGLRenderTarget !== true) return;
      if (r.capabilities && r.capabilities.logarithmicDepthBuffer) return;
      if (copy.width !== rt.width || copy.height !== rt.height) copy.setSize(rt.width, rt.height);
      r.initRenderTarget(copy); // allocate now — never mid-render (it rebinds framebuffers)
      target = rt;
      sd.invSize.set(1 / rt.width, 1 / rt.height);
      armed = true;
    },
    end() {
      armed = false;
    },
    /** Blit the bound depth buffer once per armed pass. Returns true when the snapshot is valid. */
    capture(r, camera) {
      if (!armed) return false;
      if (captured) return true;
      if (r.getRenderTarget() !== target || r.getScissorTest()) return false;
      const props = r.properties;
      const tp = props.get(target);
      const src = target.samples > 0 ? tp.__webglMultisampledFramebuffer : tp.__webglFramebuffer;
      const dst = props.get(copy).__webglFramebuffer;
      if (!src || !dst || Array.isArray(src) || Array.isArray(dst)) return false;
      const state = r.state;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src); // == what FRAMEBUFFER already bound for reading
      state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
      state.buffers.depth.setMask(true); // blits honour the depth write mask on some drivers
      gl.blitFramebuffer(0, 0, target.width, target.height, 0, 0, copy.width, copy.height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, src); // restore (keeps three's binding cache consistent)
      captured = true;
      sd.captures++;
      return true;
    },
    /** Permanently disable (e.g. after a GL error was detected). */
    disable() {
      failed = true;
      armed = false;
    },
    dispose() {
      copy.dispose();
      copy.depthTexture.dispose();
      registry.delete(renderer);
    },
  };
  registry.set(renderer, sd);
  return sd;
}
