// ── surfacedetail.js — no more plastic ──────────────────────────────────────
// Dozens of set-pieces (planters, benches, pipes, kerbs, trims, the fountain,
// canopies, tanks…) are plain-colour MeshStandardMaterials. Up close a flat
// colour with a uniform roughness is what reads as "toy". After the world is
// built this walks the scene once and upgrades every such material with a
// world-space TRIPLANAR detail layer — so it needs no UVs and never stretches:
//
//   · albedo: two octaves of tileable fbm (0.4 m and 3 m) — mottling, grime
//   · roughness: the same fields push roughness up and down (smudges, wear)
//   · bump: the fine octave perturbs the normal via screen-space derivatives
//   · metals get less colour variation and more roughness variation (scuffs)
//
// Materials that already carry a map but no normal map get the bump only.
// Anything transparent, emissive-dominated, or already customised through
// onBeforeCompile (figures, foliage, grass, terrain, water) is left alone.

function upgradeSurfaces(scene) {
  // tileable fbm, straight from the texture generator's field code
  const N = 256;
  const f1 = normalizeField(fbmField(N, 8, 5, 4401, { gain: 0.55 }));
  const f2 = normalizeField(fbmField(N, 32, 3, 4402, { gain: 0.5 }));
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = f1[i] * 255; data[i * 4 + 1] = f2[i] * 255;
    data[i * 4 + 2] = 0; data[i * 4 + 3] = 255;
  }
  const noise = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
  noise.magFilter = THREE.LinearFilter; noise.minFilter = THREE.LinearMipmapLinearFilter;
  noise.generateMipmaps = true; noise.anisotropy = 8;
  noise.needsUpdate = true;

  const seen = new WeakSet();
  const defaultOBC = THREE.Material.prototype.onBeforeCompile;
  let upgraded = 0;

  function patch(m, bumpOnly) {
    const metal = m.metalness > 0.4;
    const colVar = bumpOnly ? 0.0 : (metal ? 0.12 : 0.26);
    const roughVar = metal ? 0.35 : 0.22;
    const bump = metal ? 0.35 : 0.6;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uSdNoise = { value: noise };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          varying vec3 vSdPos;
          varying vec3 vSdN;`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          {
            vec4 sdw = vec4(transformed, 1.0);
            mat3 sdm = mat3(modelMatrix);
            #ifdef USE_INSTANCING
              sdw = instanceMatrix * sdw;
              sdm = sdm * mat3(instanceMatrix);
            #endif
            vSdPos = (modelMatrix * sdw).xyz;
            vSdN = normalize(sdm * objectNormal);
          }`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uSdNoise;
          varying vec3 vSdPos;
          varying vec3 vSdN;
          vec2 sdTri(vec3 p, vec3 w, float s) {
            return texture2D(uSdNoise, p.yz * s).rg * w.x
                 + texture2D(uSdNoise, p.zx * s).rg * w.y
                 + texture2D(uSdNoise, p.xy * s).rg * w.z;
          }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec3 sdW = abs(normalize(vSdN)); sdW *= sdW; sdW *= sdW; sdW += 1e-5;
          sdW /= (sdW.x + sdW.y + sdW.z);
          vec2 sdA = sdTri(vSdPos, sdW, 0.33);      // 3 m blotches
          vec2 sdB = sdTri(vSdPos, sdW, 2.4);       // 0.4 m grain
          float sdGrime = sdA.r * 0.65 + sdB.r * 0.35;
          diffuseColor.rgb *= 1.0 + ${colVar.toFixed(3)} * (sdGrime - 0.5) * 2.0;`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = clamp(roughnessFactor + ${roughVar.toFixed(3)} * (sdA.r * 0.5 + sdB.g * 0.5 - 0.5) * 2.0, 0.04, 1.0);`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          {
            // bump from the fine octave (Mikkelsen's surface-gradient form)
            float sdH = sdB.g * 0.6 + sdTri(vSdPos, sdW, 9.0).r * 0.4;
            vec3 sdP = -vViewPosition;
            vec3 sdDx = normalize(dFdx(sdP)), sdDy = normalize(dFdy(sdP));
            float sdHx = dFdx(sdH) * ${(1.6 * bump).toFixed(3)}, sdHy = dFdy(sdH) * ${(1.6 * bump).toFixed(3)};
            vec3 sdR1 = cross(sdDy, normal), sdR2 = cross(normal, sdDx);
            float sdDet = dot(sdDx, sdR1);
            vec3 sdGrad = sign(sdDet) * (sdHx * sdR1 + sdHy * sdR2);
            normal = normalize(abs(sdDet) * normal - sdGrad);
          }`);
    };
    m.customProgramCacheKey = () => 'surf-detail-' + (bumpOnly ? 'b' : 'c') + (metal ? 'm' : 'd');
    m.needsUpdate = true;
    upgraded++;
  }

  const seenGeo = new WeakSet();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    if (o.geometry && !seenGeo.has(o.geometry)) { seenGeo.add(o.geometry); fixZeroNormals(o.geometry); }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      if (!m.isMeshStandardMaterial) continue;
      if (m.onBeforeCompile !== defaultOBC) continue;       // already custom
      if (m.transparent || m.opacity < 1 || m.alphaTest > 0) continue;
      if (m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.3 && !m.emissiveMap) continue;
      if (m.normalMap) continue;                             // already detailed
      patch(m, !!m.map);
    }
  });
  return { upgraded };
}
