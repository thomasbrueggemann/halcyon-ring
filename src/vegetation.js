// ── Vegetation: instanced trees, bushes, grass tufts ────────────────────────
import * as THREE from 'three';
import { mergeGeometries } from '../lib/BufferGeometryUtils.js';
import { RF, DEG, DISTRICTS } from './config.js';
import { placementMatrix } from './torusMath.js';

const _m = new THREE.Matrix4();
const _c = new THREE.Color();

function inArc(fromDeg, toDeg, rng) {
  let a = fromDeg, b = toDeg;
  if (b < a) b += 360;
  return ((a + rng() * (b - a)) % 360) * DEG;
}

export function buildVegetation(scene, textures, colliders, rng) {
  const veg = new THREE.Group();
  scene.add(veg);

  const barkMat = new THREE.MeshStandardMaterial({ map: textures.bark, roughness: 1 });
  const leafTex = textures.leaf.clone();
  leafTex.repeat.set(3, 3);
  const leafMat = new THREE.MeshStandardMaterial({
    map: leafTex, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 1,
  });
  const pineMat = new THREE.MeshStandardMaterial({ color: 0x2f5c38, roughness: 1 });

  // ── tree geometries (trunk + canopy merged, two material groups) ──
  function treeGeo(parts) {
    const merged = mergeGeometries(parts.map(p => p.geo), true);
    return merged;
  }
  const sph = (x, y, z, r, sy = 1) => {
    const g = new THREE.SphereGeometry(r, 10, 8);
    g.scale(1, sy, 1); g.translate(x, y, z);
    return g;
  };
  const cone = (y, r, h) => {
    const g = new THREE.ConeGeometry(r, h, 10);
    g.translate(0, y, 0);
    return g;
  };
  const trunk = (h, r0, r1) => {
    const g = new THREE.CylinderGeometry(r0, r1, h, 8);
    g.translate(0, h / 2, 0);
    return g;
  };

  const oakGeo = treeGeo([
    { geo: trunk(3.4, 0.28, 0.45) },
    { geo: mergeGeometries([sph(0, 4.4, 0, 2.6), sph(1.4, 3.7, 0.7, 1.8), sph(-1.3, 3.9, -0.6, 1.9)]) },
  ]);
  const poplarGeo = treeGeo([
    { geo: trunk(4.8, 0.18, 0.3) },
    { geo: sph(0, 6.1, 0, 1.35, 2.6) },
  ]);
  const pineGeo = treeGeo([
    { geo: trunk(2.4, 0.22, 0.38) },
    { geo: mergeGeometries([cone(3.4, 2.3, 2.8), cone(5.1, 1.7, 2.4), cone(6.6, 1.05, 2.0)]) },
  ]);

  const oaks = [], poplars = [], pines = [], bushes = [], tufts = [], rocks = [], flowers = [], reeds = [];

  function tryPlace(list, theta, lat, scale, collideR) {
    if (Math.abs(lat) > 48) return false;
    if (Math.abs(lat) < 8) return false;                        // keep off the road
    const s = theta * RF;
    if (colliders.resolve(s, lat, 0.4, collideR)) return false; // overlaps something
    list.push({ theta, lat, yaw: rng() * Math.PI * 2, scale });
    return true;
  }

  function treeWithCollider(list, theta, lat, scale, r) {
    if (tryPlace(list, theta, lat, scale, r)) colliders.addCylinder(theta, lat, 0.4, 3);
  }

  for (const d of DISTRICTS) {
    switch (d.kind) {
      case 'park': {
        for (let i = 0; i < 340; i++) {
          const roll = rng();
          const list = roll < 0.5 ? oaks : roll < 0.75 ? pines : poplars;
          treeWithCollider(list, inArc(d.from, d.to, rng), (rng() - 0.5) * 92, 0.8 + rng() * 0.7, 2.2);
        }
        for (let i = 0; i < 320; i++) {
          tryPlace(bushes, inArc(d.from, d.to, rng), (rng() - 0.5) * 92, 0.6 + rng() * 0.9, 1.0);
        }
        for (let i = 0; i < 120; i++) {
          tryPlace(rocks, inArc(d.from, d.to, rng), (rng() - 0.5) * 92, 0.5 + rng() * 1.1, 0.8);
        }
        break;
      }
      case 'orchard': {
        for (let row = 0; row < 4; row++) {
          const latRow = [16, 25, 34, 43][row];
          for (const sgn of [-1, 1]) {
            let a = d.from + 1.5, b = d.to - 1.5;
            for (let deg = a; deg < b; deg += (10.5 / RF) / DEG) {
              if (rng() < 0.06) continue;
              const theta = (deg % 360) * DEG;
              const lat = sgn * latRow + (rng() - 0.5) * 2;
              if (tryPlace(oaks, theta, lat, 0.55 + rng() * 0.3, 1.8)) {
                colliders.addCylinder(theta, lat, 0.35, 2.5);
              }
            }
          }
        }
        for (let i = 0; i < 150; i++) {
          tryPlace(bushes, inArc(d.from, d.to, rng), (rng() - 0.5) * 92, 0.5 + rng() * 0.6, 0.9);
        }
        break;
      }
      case 'houses': {
        for (let i = 0; i < 120; i++) {
          const list = rng() < 0.6 ? oaks : poplars;
          treeWithCollider(list, inArc(d.from, d.to, rng), (rng() - 0.5) * 96, 0.7 + rng() * 0.5, 2.0);
        }
        for (let i = 0; i < 170; i++) {
          tryPlace(bushes, inArc(d.from, d.to, rng), (rng() - 0.5) * 96, 0.5 + rng() * 0.7, 0.9);
        }
        break;
      }
      case 'plaza':
      case 'market':
      case 'science': {
        for (let i = 0; i < 40; i++) {
          treeWithCollider(poplars, inArc(d.from, d.to, rng), (rng() < 0.5 ? -1 : 1) * (10 + rng() * 30), 0.8 + rng() * 0.4, 1.8);
        }
        for (let i = 0; i < 60; i++) {
          tryPlace(bushes, inArc(d.from, d.to, rng), (rng() < 0.5 ? -1 : 1) * (9 + rng() * 34), 0.5 + rng() * 0.6, 0.9);
        }
        break;
      }
      case 'water': {
        for (let i = 0; i < 85; i++) {
          const list = rng() < 0.5 ? pines : oaks;
          treeWithCollider(list, inArc(d.from, d.to, rng), -(10 + rng() * 36), 0.7 + rng() * 0.6, 2.0);
        }
        for (let i = 0; i < 60; i++) {
          tryPlace(rocks, inArc(d.from, d.to, rng), -(9 + rng() * 38), 0.4 + rng() * 0.9, 0.7);
        }
        // reeds crowd the shoreline
        for (let deg = d.from + 3; deg < d.to - 5; deg += 0.22) {
          if (rng() < 0.3) continue;
          reeds.push({
            theta: deg * DEG, lat: 14.6 + rng() * 2.2,
            yaw: rng() * Math.PI, scale: 0.8 + rng() * 0.5,
          });
        }
        break;
      }
      case 'farm': {
        for (let i = 0; i < 60; i++) {
          tryPlace(poplars, inArc(d.from, d.to, rng), (rng() < 0.5 ? -1 : 1) * (8.5 + rng() * 3), 0.9 + rng() * 0.4, 1.6);
        }
        for (let i = 0; i < 50; i++) {
          tryPlace(bushes, inArc(d.from, d.to, rng), (rng() < 0.5 ? -1 : 1) * (46 - rng() * 3), 0.5 + rng() * 0.6, 0.9);
        }
        break;
      }
      case 'industry': {
        for (let i = 0; i < 40; i++) {
          tryPlace(bushes, inArc(d.from, d.to, rng), (rng() < 0.5 ? -1 : 1) * (8.5 + rng() * 6), 0.5 + rng() * 0.5, 0.9);
        }
        for (let i = 0; i < 30; i++) {
          tryPlace(rocks, inArc(d.from, d.to, rng), (rng() < 0.5 ? -1 : 1) * (12 + rng() * 30), 0.4 + rng() * 0.8, 0.7);
        }
        break;
      }
    }
  }

  // grass tufts sprinkled through green districts
  const green = DISTRICTS.filter(d => ['park', 'orchard', 'houses', 'plaza', 'water', 'farm'].includes(d.kind));
  for (let i = 0; i < 14000; i++) {
    const d = green[Math.floor(rng() * green.length)];
    const theta = inArc(d.from, d.to, rng);
    const lat = (rng() - 0.5) * 94;
    if (Math.abs(lat) < 7.5 || Math.abs(lat) > 47) continue;
    tufts.push({ theta, lat, yaw: rng() * Math.PI, scale: 0.5 + rng() * 0.7 });
  }

  // flower beds: clustered warm-colored tufts near civic areas and yards
  const beds = DISTRICTS.filter(d => ['plaza', 'houses', 'park', 'market', 'science'].includes(d.kind));
  for (let c = 0; c < 170; c++) {
    const d = beds[Math.floor(rng() * beds.length)];
    const cTheta = inArc(d.from, d.to, rng);
    const cLat = (rng() < 0.5 ? -1 : 1) * (8.5 + rng() * 30);
    if (Math.abs(cLat) > 46) continue;
    const n = 7 + Math.floor(rng() * 9);
    for (let i = 0; i < n; i++) {
      flowers.push({
        theta: cTheta + ((rng() - 0.5) * 2.6) / RF,
        lat: cLat + (rng() - 0.5) * 2.6,
        yaw: rng() * Math.PI,
        scale: 0.3 + rng() * 0.3,
      });
    }
  }

  // ── build instanced meshes ──
  function addInstanced(geo, mats, list, { shadow = true, tintFn = null } = {}) {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geo, mats, list.length);
    list.forEach((pl, i) => {
      placementMatrix(pl.theta, pl.lat, 0, pl.yaw, pl.scale, _m);
      mesh.setMatrixAt(i, _m);
      if (tintFn) mesh.setColorAt(i, tintFn(i));
    });
    if (tintFn) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = shadow;
    mesh.receiveShadow = false;
    veg.add(mesh);
  }

  const leafTint = () => _c.setHSL(0.26 + rng() * 0.08, 0.45 + rng() * 0.25, 0.32 + rng() * 0.14).clone();
  addInstanced(oakGeo, [barkMat, leafMat], oaks, { tintFn: leafTint });
  addInstanced(poplarGeo, [barkMat, leafMat], poplars, { tintFn: leafTint });
  addInstanced(pineGeo, [barkMat, pineMat], pines);

  const bushGeo = new THREE.SphereGeometry(0.8, 9, 7);
  bushGeo.scale(1, 0.75, 1);
  bushGeo.translate(0, 0.5, 0);
  addInstanced(bushGeo, leafMat, bushes, { tintFn: leafTint });

  const tuftPlane = new THREE.PlaneGeometry(1.1, 0.7);
  tuftPlane.translate(0, 0.35, 0);
  const tuftPlane2 = tuftPlane.clone();
  tuftPlane2.rotateY(Math.PI / 2);
  const tuftGeo = mergeGeometries([tuftPlane, tuftPlane2]);
  const tuftMat = new THREE.MeshStandardMaterial({
    map: textures.tuft, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1,
  });
  addInstanced(tuftGeo, tuftMat, tufts, { shadow: false, tintFn: leafTint });

  // rocks: low-poly, squashed at random
  const rockGeo = new THREE.IcosahedronGeometry(0.7, 0);
  rockGeo.translate(0, 0.28, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.05 });
  const rockTint = () => _c.setHSL(0.08 + rng() * 0.04, 0.04 + rng() * 0.06, 0.32 + rng() * 0.2).clone();
  addInstanced(rockGeo, rockMat, rocks.map(r => ({
    ...r, scale: new THREE.Vector3(r.scale * (0.7 + rng() * 0.8), r.scale * (0.4 + rng() * 0.5), r.scale * (0.7 + rng() * 0.8)),
  })), { tintFn: rockTint });

  // flowers: small warm-tinted tufts in beds
  const flowerTint = () => _c.setHSL(rng() < 0.5 ? 0.93 + rng() * 0.09 : 0.11 + rng() * 0.05, 0.7, 0.6 + rng() * 0.15).clone();
  addInstanced(tuftGeo, tuftMat.clone(), flowers, { shadow: false, tintFn: flowerTint });

  // reeds: tall thin tufts along the reservoir shoreline
  const reedTint = () => _c.setHSL(0.24 + rng() * 0.04, 0.4, 0.24 + rng() * 0.08).clone();
  addInstanced(tuftGeo, tuftMat.clone(), reeds.map(r => ({
    ...r, scale: new THREE.Vector3(r.scale * 0.55, r.scale * 2.3, r.scale * 0.55),
  })), { shadow: false, tintFn: reedTint });

  return { group: veg };
}
