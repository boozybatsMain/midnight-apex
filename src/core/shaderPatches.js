// Renderer-wide shader tweaks applied once by the core before any material compiles.
import * as THREE from 'three';

// Smallest specular roughness the SPOT lights (= the player's headlights, the only spot lights in the
// scene) may produce. three treats a spot light as an infinitely small point, so on a mirror-like
// clear coat or gloss trim (roughness 0.03-0.08) its highlight is a near-singular spike: on the rear of
// a car a few metres ahead it reaches thousands of HDR units even with the lamps dimmed to 1 %, and
// bloom + anamorphic streaks turn it into a white-out. A real headlight lens is ~15 cm across (1-3°
// seen from a few metres), which is what this lobe widening approximates ("source radius" trick).
// Only the direct specular of spot lights changes; environment reflections and every other light keep
// their own roughness (the headlights' far off-specular lobe on the wet road is unaffected in practice).
export const SPOT_MIN_ROUGHNESS = 0.36;
export const SPOT_CLEARCOAT_MIN_ROUGHNESS = 0.24;

let patched = false;

export function applyShaderPatches() {
  if (patched) return;
  patched = true;
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  const spotStart = chunk.indexOf('#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )');
  const call = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  const at = spotStart >= 0 ? chunk.indexOf(call, spotStart) : -1;
  if (at < 0) {
    console.warn('[core] lights_fragment_begin layout changed; spot clear-coat widening skipped');
    return;
  }
  // Braces keep the temporary local scoped per unrolled loop iteration.
  const wrapped = `{
		#ifdef STANDARD
		float apexRough = material.roughness;
		material.roughness = max( apexRough, ${SPOT_MIN_ROUGHNESS.toFixed(3)} );
		#endif
		#ifdef USE_CLEARCOAT
		float apexCcRough = material.clearcoatRoughness;
		material.clearcoatRoughness = max( apexCcRough, ${SPOT_CLEARCOAT_MIN_ROUGHNESS.toFixed(3)} );
		#endif
		${call}
		#ifdef STANDARD
		material.roughness = apexRough;
		#endif
		#ifdef USE_CLEARCOAT
		material.clearcoatRoughness = apexCcRough;
		#endif
		}`;
  THREE.ShaderChunk.lights_fragment_begin = chunk.slice(0, at) + wrapped + chunk.slice(at + call.length);
}
