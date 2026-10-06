// MIDNIGHT APEX — planar reflection about the road plane (y = 0) for the wet street look.
// Same math as three's Reflector (mirrored virtual camera + oblique near plane), but rendered into a
// half-res HDR target that every wet material samples through a shared texture matrix.
import * as THREE from 'three';
import { LAYERS } from '../config.js';

// Objects on LAYERS.NO_REFLECTION (nitro flames, sparks, rain, spray, headlight decals…) are seen by the
// game cameras but never mirrored in the wet road.
const NO_REFLECTION_BIT = 1 << LAYERS.NO_REFLECTION;

export function createPlanarReflection(renderer, { scale = 0.5, maxWidth = 1280 } = {}) {
  const rt = new THREE.WebGLRenderTarget(16, 16, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    samples: 0,
  });
  rt.texture.generateMipmaps = true;
  rt.texture.minFilter = THREE.LinearMipmapLinearFilter;
  rt.texture.magFilter = THREE.LinearFilter;
  rt.texture.name = 'planarReflection';

  const virtualCamera = new THREE.PerspectiveCamera();
  const textureMatrix = new THREE.Matrix4();
  const normal = new THREE.Vector3(0, 1, 0);
  const planePos = new THREE.Vector3(0, 0, 0);
  const plane = new THREE.Plane();
  const clipPlane = new THREE.Vector4();
  const q = new THREE.Vector4();
  const camPos = new THREE.Vector3();
  const rot = new THREE.Matrix4();
  const lookAt = new THREE.Vector3();
  const view = new THREE.Vector3();
  const target = new THREE.Vector3();
  const size = new THREE.Vector2();

  function resize() {
    renderer.getDrawingBufferSize(size);
    let w = Math.max(64, Math.round(size.x * scale));
    let h = Math.max(64, Math.round(size.y * scale));
    if (w > maxWidth) { h = Math.round((h * maxWidth) / w); w = maxWidth; }
    if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
  }

  /**
   * Render the mirrored scene. `hidden` = objects to hide during the pass (the wet surfaces themselves).
   */
  function render(scene, camera, hidden = []) {
    resize();
    camPos.setFromMatrixPosition(camera.matrixWorld);
    rot.extractRotation(camera.matrixWorld);
    view.subVectors(planePos, camPos).reflect(normal).negate().add(planePos);
    lookAt.set(0, 0, -1).applyMatrix4(rot).add(camPos);
    target.subVectors(planePos, lookAt).reflect(normal).negate().add(planePos);
    virtualCamera.position.copy(view);
    virtualCamera.up.set(0, 1, 0).applyMatrix4(rot).reflect(normal);
    virtualCamera.lookAt(target);
    virtualCamera.near = camera.near;
    virtualCamera.far = camera.far;
    virtualCamera.updateMatrixWorld();
    virtualCamera.projectionMatrix.copy(camera.projectionMatrix);
    virtualCamera.layers.mask = (camera.layers.mask & ~NO_REFLECTION_BIT) | 1; // always keep layer 0

    textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    textureMatrix.multiply(virtualCamera.projectionMatrix);
    textureMatrix.multiply(virtualCamera.matrixWorldInverse);

    // Oblique near plane = mirror plane (clips anything below the road).
    plane.setFromNormalAndCoplanarPoint(normal, planePos);
    plane.applyMatrix4(virtualCamera.matrixWorldInverse);
    clipPlane.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = virtualCamera.projectionMatrix;
    q.x = (Math.sign(clipPlane.x) + pm.elements[8]) / pm.elements[0];
    q.y = (Math.sign(clipPlane.y) + pm.elements[9]) / pm.elements[5];
    q.z = -1.0;
    q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    clipPlane.multiplyScalar(2.0 / clipPlane.dot(q));
    pm.elements[2] = clipPlane.x;
    pm.elements[6] = clipPlane.y;
    pm.elements[10] = clipPlane.z + 1.0;
    pm.elements[14] = clipPlane.w;
    virtualCamera.projectionMatrixInverse.copy(pm).invert();

    const vis = hidden.map((o) => o.visible);
    hidden.forEach((o) => (o.visible = false));
    const prevTarget = renderer.getRenderTarget();
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(rt);
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, virtualCamera);
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.xr.enabled = prevXr;
    hidden.forEach((o, i) => (o.visible = vis[i]));
  }

  return { renderTarget: rt, texture: rt.texture, textureMatrix, virtualCamera, render, dispose: () => rt.dispose() };
}
