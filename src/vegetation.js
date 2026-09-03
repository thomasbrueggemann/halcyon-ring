// ── Vegetation: instanced trees, bushes, grass tufts ────────────────────────

const _vegM = new THREE.Matrix4();
const _c = new THREE.Color();

function inArc(fromDeg, toDeg, rng) {
  let a = fromDeg, b = toDeg;
  if (b < a) b += 360;
  return ((a + rng() * (b - a)) % 360) * DEG;
}

function buildVegetation(scene, textures, colliders, rng) {
  const veg = new THREE.Group();
  scene.add(veg);

  const barkMat = new THREE.MeshStandardMaterial({ map: textures.bark, normalMap: textures.barkN, roughness: 0.95 });
  const leafTex = textures.leaf.clone();
  leafTex.repeat.set(6, 6);
  const leafMat = new THREE.MeshStandardMaterial({
    map: leafTex, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.9,
  });
  // Conifers were flat-shaded cones, which read as plastic party hats. Giving
  // them the same alpha-cut needle texture as the broadleaf canopies breaks the
  // silhouette and lets light through the edges.
  const pineTex = textures.leaf.clone();
  pineTex.repeat.set(7, 4);
  const pineMat = new THREE.MeshStandardMaterial({
    map: pineTex, color: 0x8fbf86, alphaTest: 0.28, side: THREE.DoubleSide, roughness: 0.95,
  });

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
    { geo: mergeGeometries([
      sph(0, 4.5, 0, 2.5), sph(1.5, 3.8, 0.8, 1.8), sph(-1.4, 4.0, -0.7, 1.9),
      sph(0.5, 5.6, -1.1, 1.5), sph(-0.9, 5.3, 1.2, 1.4),
    ]) },
  ]);
  const poplarGeo = treeGeo([
    { geo: trunk(4.8, 0.18, 0.3) },
    { geo: mergeGeometries([sph(0, 6.1, 0, 1.35, 2.6), sph(0.35, 4.4, 0.3, 1.0, 1.9)]) },
  ]);
  // more tiers, each slightly offset — a real conifer is not a stack of
  // perfectly concentric cones
  const pineGeo = treeGeo([
    { geo: trunk(2.4, 0.22, 0.38) },
    { geo: mergeGeometries([
      cone(3.2, 2.45, 2.9), cone(4.5, 2.0, 2.6), cone(5.7, 1.55, 2.3),
      cone(6.8, 1.05, 2.0), cone(7.7, 0.6, 1.5),
    ]) },
  ]);

  // ── Low-detail variants, for the mass fill ──
  // The ring is 5.9 km around and 190 m wide. Covering that at woodland density
  // takes tens of thousands of trees and a 730-triangle oak does not survive
  // those numbers. These carry a quarter of the geometry; past ~40 m — which is
  // where nearly all of them are — the silhouette is what reads, not the facets.
  const loSph = (x, y, z, r, sy = 1) => {
    const g = new THREE.SphereGeometry(r, 6, 5);
    g.scale(1, sy, 1); g.translate(x, y, z);
    return g;
  };
  const loCone = (y, r, h) => {
    const g = new THREE.ConeGeometry(r, h, 6);
    g.translate(0, y, 0);
    return g;
  };
  const loTrunk = (h, r0, r1) => {
    const g = new THREE.CylinderGeometry(r0, r1, h, 5);
    g.translate(0, h / 2, 0);
    return g;
  };
  const oakLoGeo = treeGeo([
    { geo: loTrunk(3.4, 0.28, 0.45) },
    { geo: mergeGeometries([
      loSph(0, 4.7, 0, 2.7), loSph(1.4, 3.9, 0.7, 1.9), loSph(-1.2, 4.2, -0.8, 1.8),
    ]) },
  ]);
  const pineLoGeo = treeGeo([
    { geo: loTrunk(2.4, 0.22, 0.38) },
    { geo: mergeGeometries([
      loCone(3.3, 2.4, 3.0), loCone(4.7, 1.85, 2.6), loCone(5.9, 1.25, 2.2), loCone(6.9, 0.62, 1.7),
    ]) },
  ]);

  const oaks = [], poplars = [], pines = [], bushes = [], tufts = [], rocks = [], flowers = [], reeds = [];
  const oaksLo = [], pinesLo = [], scrub = [];

  // Bucketed lane centerline points, for cheap build-time proximity tests.
  const _laneCell = 4;
  const _laneBuckets = {};
  for (const lane of LANES) {
    const M = 64;
    for (let k = 0; k <= M; k++) {
      const q = laneSample(lane, k / M);
      const key = Math.floor((q.theta * RF) / _laneCell);
      (_laneBuckets[key] = _laneBuckets[key] || []).push({ s: q.theta * RF, lat: q.lat });
    }
  }
  function _nearLane(theta, lat, dist) {
    const s = theta * RF;
    const k0 = Math.floor((s - dist) / _laneCell), k1 = Math.floor((s + dist) / _laneCell);
    for (let k = k0; k <= k1; k++) {
      const arr = _laneBuckets[k];
      if (!arr) continue;
      for (const pt of arr) {
        if (Math.abs(lat - pt.lat) < dist && Math.abs(s - pt.s) < dist) return true;
      }
    }
    return false;
  }

  // Nothing grows on bare rock, in the water, on the carriageway, or on a slope
  // steeper than roots can hold. Checking the terrain itself (rather than a
  // fixed lat band) is what keeps the tree line following the hillsides.
  // The plaza and the spoke collars are paved; tufts and flower beds pushing up
  // through the slabs read as an error, not as charm.
  const PAVED = [{ theta: 6 * DEG, lat: 0, r: 25 }]
    .concat(SPOKE_THETAS.map(t => ({ theta: t, lat: 0, r: 15 })));
  function siteOK(theta, lat) {
    // The tree line: nothing takes root once the mountain rim goes to rock.
    // Below it the slope test does the rest, so the stands thin out naturally
    // up the lower slopes instead of stopping along a drawn line.
    if (Math.abs(lat) > MTN_LAT0 + 10) return false;
    for (const q of PAVED) {
      if (Math.hypot(arcDelta(theta, q.theta), lat - q.lat) < q.r) return false;
    }
    // keep the platform and its walk-up ramp visually clear, not just collision-free
    for (const st of STATIONS) {
      const d = arcDelta(st.theta, theta);          // +ve = ahead of the station
      if (d > -22 && d < 60 && lat > st.lat - 5 && lat < st.lat + 11) return false;
    }
    if (Math.abs(lat - roadLat(theta)) < ROAD_HALF + ROAD_SHLDR + 2.5) return false;
    // The guideway deck is only ~6.5 m up and a grown oak is taller than that,
    // so a tree planted under it grows straight through the track. Planting is
    // the last thing built, and by now the route is final — leave it the
    // maintenance corridor it would have in a real ring.
    if (Math.abs(lat - railLat(theta)) < 5.0) return false;
    if (waterDepth(theta, lat) > 0.02) return false;
    // A lake has a beach: waterDepth alone stops the planting exactly at the
    // waterline, which grows oaks with their roots in the shallows.
    if (inLake(theta, lat, 2.2)) return false;
    if (inBore(theta, lat)) return false;             // nothing grows under a mountain
    if (terrainSlope(theta, lat) > 1.1) return false;
    return true;
  }
  function tryPlace(list, theta, lat, scale, collideR) {
    if (!siteOK(theta, lat)) return false;
    if (_nearLane(theta, lat, 2)) return false;                                  // off the footpaths
    const s = theta * RF;
    if (colliders.resolve(s, lat, 0.4, collideR)) return false; // overlaps something
    list.push({ theta, lat, yaw: rng() * Math.PI * 2, scale });
    return true;
  }

  function treeWithCollider(list, theta, lat, scale, r) {
    if (tryPlace(list, theta, lat, scale, r)) { colliders.addCylinder(theta, lat, 0.4, 3); return true; }
    return false;
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
        // reeds crowd BOTH banks of the river through Reservoir Flats + the lake
        for (let deg = d.from + 1; deg < d.to - 1; deg += 0.35) {
          const theta = deg * DEG;
          const we = waterEdges(theta);
          if (we.dry) continue;
          for (const bank of [1, -1]) {
            if (rng() < 0.45) continue;
            reeds.push({
              theta, lat: (bank > 0 ? we.hi : we.lo) + bank * (0.2 + rng() * 1.3),
              yaw: rng() * Math.PI, scale: 0.8 + rng() * 0.5,
            });
          }
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

  // ── Conifer clusters on the rolling valley sides + ridgelines ──
  // Tall slim pines gathered in tight stands and running along the high-lat
  // knolls, the way they climb the terraced valley in the painting.
  {
    let added = 0;
    for (let c = 0; c < 150 && added < 1500; c++) {
      const theta = rng() * Math.PI * 2;
      const side = rng() < 0.5 ? -1 : 1;
      const cLat = side * (28 + rng() * 22);          // outer valley slopes
      const n = 6 + Math.floor(rng() * 12);
      const spread = 4 + rng() * 8;
      for (let i = 0; i < n && added < 1500; i++) {
        const th = theta + ((rng() - 0.5) * spread) / RF;
        const la = cLat + (rng() - 0.5) * spread;
        if (treeWithCollider(pines, th, la, 0.75 + rng() * 0.7, 1.8)) added++;
      }
    }
    // scattered lone pines threading the mid slopes
    for (let i = 0; i < 350; i++) {
      const side = rng() < 0.5 ? -1 : 1;
      treeWithCollider(pines, rng() * Math.PI * 2, side * (20 + rng() * 32), 0.7 + rng() * 0.6, 1.7);
    }
  }

  // ── Willowy trees + reeds hugging BOTH river banks around the whole ring ──
  // Dense near the lake (≈240°) and pond (≈73°).
  for (let deg = 0; deg < 360; deg += 0.6) {
    const theta = deg * DEG;
    const we = waterEdges(theta);
    if (we.dry) continue;
    const boost = 1 + 1.6 * Math.exp(-Math.pow(arcDelta(theta, 233 * DEG) / 60, 2))
                    + 1.2 * Math.exp(-Math.pow(arcDelta(theta, 73 * DEG) / 45, 2));
    for (const bank of [1, -1]) {
      const edge = bank > 0 ? we.hi : we.lo;
      if (rng() <= 0.16 * boost) {
        // droopy oaks read as willows on the banks
        treeWithCollider(oaks, theta, edge + bank * (2.5 + rng() * 5), 0.7 + rng() * 0.6, 2.0);
      }
      // reeds right at the waterline
      if (rng() > 0.5) continue;
      reeds.push({ theta, lat: edge + bank * (0.2 + rng() * 1.4), yaw: rng() * Math.PI, scale: 0.8 + rng() * 0.6 });
    }
  }

  // ── Tree lines flanking some lanes ──
  for (const lane of LANES) {
    if (rng() < 0.55) continue;
    const M = 20;
    for (let k = 1; k < M; k++) {
      const q = laneSample(lane, k / M);
      if (rng() < 0.5) continue;
      const side = rng() < 0.5 ? -1 : 1;
      const c = Math.cos(q.yaw), s = Math.sin(q.yaw), off = 3 + rng() * 2;
      const th = q.theta + (-s * off * side) / RF;
      const la = q.lat + c * off * side;
      const list = rng() < 0.5 ? poplars : oaks;
      treeWithCollider(list, th, la, 0.6 + rng() * 0.5, 1.8);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // The woodland fill — everything above plants set-pieces; this covers the ring
  // ══════════════════════════════════════════════════════════════════════════
  // Everything before this point plants by district, by lane or by landmark,
  // which leaves the ground BETWEEN those things bare. On a 190 m-wide floor you
  // are looking across half a kilometre of it at any moment, and bare reads as
  // unfinished lawn, not as countryside. This pass sweeps the whole ring on a
  // jittered grid and fills whatever the set-pieces did not claim.

  // A wrapped 2-D value-noise field on the (arc-metre, lat-metre) plane. The
  // wrap period is an exact divisor of the circumference, so the pattern closes
  // on itself at 0°/360° with no seam.
  function noiseField(cellWanted, seed) {
    const N = Math.max(4, Math.round(CIRCUMFERENCE / cellWanted));
    const cell = CIRCUMFERENCE / N;
    const hash = (i, j) => {
      let n = Math.imul(((i % N) + N) % N, 374761393) ^ Math.imul(j, 668265263) ^ seed;
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    };
    return (s, lat) => {
      const x = s / cell, y = lat / cell;
      const i = Math.floor(x), j = Math.floor(y);
      const fx = x - i, fy = y - j;
      const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
      return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - v)
           + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * v;
    };
  }
  // Three octaves: the big one decides which side of the valley is forest, the
  // middle one cuts glades into it, the small one ragged-edges the boundaries.
  // An even coin flip per cell would give uniform dust — what makes a valley
  // read as wooded is contrast between closed canopy and open meadow.
  const _nseed = () => (rng() * 4294967296) | 0;
  const nf1 = noiseField(240, _nseed()), nf2 = noiseField(96, _nseed()), nf3 = noiseField(37, _nseed());
  const woodMask = (s, lat) => 0.54 * nf1(s, lat) + 0.31 * nf2(s, lat) + 0.15 * nf3(s, lat);

  // How wooded each district wants to be. Smoothed over ±9° afterwards: a
  // district boundary is an administrative line, and a forest that stops dead
  // on one reads as a fence.
  const CANOPY_KIND = {
    park: 1.35, water: 1.25, orchard: 1.05, houses: 0.88, science: 0.85,
    market: 0.75, plaza: 0.68, industry: 0.72, farm: 0.46,
  };
  const canopyDeg = new Float32Array(360);
  {
    const raw = new Float32Array(360);
    for (let d = 0; d < 360; d++) raw[d] = CANOPY_KIND[districtAt(d).kind] || 0.7;
    const R = 9;
    for (let d = 0; d < 360; d++) {
      let acc = 0;
      for (let k = -R; k <= R; k++) acc += raw[(d + k + 360) % 360];
      canopyDeg[d] = acc / (2 * R + 1);
    }
  }
  // Across the tube: the valley floor is settled ground (road, river, homes,
  // fields) so woods only take hold once you are clear of it, thicken up the
  // sides, and stop at the tree line where the rim turns to rock.
  const latCanopy = (lat) => {
    const a = Math.abs(lat);
    return (0.50 + 0.50 * _smooth(6, 26, a)) * (1 - _smooth(MTN_LAT0 - 7, MTN_LAT0 + 11, a));
  };
  const canopyAt = (theta, lat) => {
    const w = canopyDeg[Math.floor((((theta / DEG) % 360) + 360) % 360)] * latCanopy(lat);
    if (w <= 0.01) return 0;
    const t = 0.78 - 0.62 * w;                       // wooded ground lowers the bar
    return _smooth(t, t + 0.24, woodMask(theta * RF, lat)) * Math.min(1, 0.45 + 0.9 * w);
  };

  const FILL_LAT = MTN_LAT0 + 11;
  {
    const STEP = 4.6;
    for (let s = 0; s < CIRCUMFERENCE; s += STEP) {
      for (let lat = -FILL_LAT; lat <= FILL_LAT; lat += STEP) {
        const th = (s + (rng() - 0.5) * STEP * 1.7) / RF;
        const la = lat + (rng() - 0.5) * STEP * 1.7;
        if (Math.abs(la) > FILL_LAT) continue;
        if (rng() > canopyAt(th, la)) continue;
        const r = rng();
        const list = r < 0.44 ? pinesLo : r < 0.88 ? oaksLo : poplars;
        treeWithCollider(list, th, la, 0.75 + rng() * 0.8, 1.9);
      }
    }
    // Understory, on a half-offset grid so it interleaves with the canopy
    // rather than stacking under it. Note the large constant term: the ground
    // BETWEEN the woods is gorse, bracken and long grass, not mown lawn, and
    // that open ground is most of the ring. Scrub goes down in ones and twos
    // because a single blob every 20 m reads as litter, while a clump reads as
    // a plant.
    for (let s = STEP / 2; s < CIRCUMFERENCE; s += STEP) {
      for (let lat = -FILL_LAT + STEP / 2; lat <= FILL_LAT; lat += STEP) {
        const th = (s + (rng() - 0.5) * STEP * 1.7) / RF;
        const la = lat + (rng() - 0.5) * STEP * 1.7;
        if (Math.abs(la) > FILL_LAT) continue;
        const p = canopyAt(th, la);
        if (rng() > 0.38 + 0.45 * p) continue;
        const n = 1 + Math.floor(rng() * 3);
        for (let i = 0; i < n; i++) {
          tryPlace(scrub, th + ((rng() - 0.5) * 3.4) / RF, la + (rng() - 0.5) * 3.4,
            0.42 + rng() * 0.72, 0.85);
        }
        // a stone or two in the open, where there is no canopy to hide the ground
        if (rng() < 0.16 * (1 - p)) {
          tryPlace(rocks, th + ((rng() - 0.5) * 3.4) / RF, la + (rng() - 0.5) * 3.4,
            0.4 + rng() * 0.9, 0.7);
        }
      }
    }
  }

  // ── The scrub belt under the crags ──
  // Above the tree line and below the bare rock there is a band of low,
  // wind-cut growth. siteOK deliberately refuses to plant a tree up there, so
  // without its own pass the hillside above the fields is a bald sheet of green
  // half a kilometre wide — which is exactly what you see from across the ring.
  {
    const beltOK = (theta, lat) => {
      if (waterDepth(theta, lat) > 0.02) return false;
      if (inLake(theta, lat, 1.5)) return false;
      if (inBore(theta, lat)) return false;
      if (terrainSlope(theta, lat) > 2.0) return false;   // sheer face: nothing roots
      return !colliders.resolve(theta * RF, lat, 0.4, 0.9);
    };
    for (let s = 0; s < CIRCUMFERENCE; s += 3.2) {
      for (const side of [-1, 1]) {
        if (rng() < 0.42) continue;
        const th = (s + (rng() - 0.5) * 3.2) / RF;
        const la = side * (MTN_LAT0 - 9 + rng() * 27);
        if (!beltOK(th, la)) continue;
        scrub.push({ theta: th, lat: la, yaw: rng() * Math.PI * 2, scale: 0.4 + rng() * 0.6 });
        // the last stragglers of the tree line: stunted conifers among the scrub
        if (rng() < 0.12 && Math.abs(la) < MTN_LAT0 + 8) {
          treeWithCollider(pinesLo, th + (1.5 + rng() * 2) / RF, la, 0.45 + rng() * 0.35, 1.4);
        }
      }
    }
  }

  // ── Farm windbreaks ──
  // The Agricultural Belt is the emptiest 42° of the ring by design — it is
  // fields — but a field system without hedgerows is just a lawn. Rows of
  // poplars running across the belt give it the grain of farmed land, and they
  // are what the eye reads at a kilometre. siteOK keeps them off the
  // carriageway, out of the river and clear of the guideway.
  {
    const d = DISTRICTS.find(x => x.kind === 'farm');
    let from = d.from, to = d.to; if (to <= from) to += 360;
    for (let deg = from + 3; deg < to - 3; deg += 4.0 + rng() * 3.4) {
      const theta = (((deg % 360) + 360) % 360) * DEG;
      for (let lat = -VALLEY_LAT + 4; lat < VALLEY_LAT - 4; lat += 2.4) {
        if (rng() < 0.2) continue;
        treeWithCollider(poplars, theta + ((rng() - 0.5) * 1.6) / RF,
          lat + (rng() - 0.5) * 1.2, 0.8 + rng() * 0.5, 1.4);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Landmarks — the things you don't expect to find twice
  // ══════════════════════════════════════════════════════════════════════════

  // ── Wooded knoll crowns ──
  // Every hillock gets its own character: some are dense conifer caps, some are
  // open broadleaf crowns with a boulder or two, a couple are bare and grassy.
  const boulders = [], logs = [], blossoms = [];
  KNOLLS.forEach((k, ki) => {
    const kind = ki % 5;
    if (kind === 4) {                                   // bare grassy knoll
      for (let i = 0; i < 14; i++) {
        const a = rng() * Math.PI * 2, rr = k.r * Math.sqrt(rng()) * 0.9;
        tryPlace(boulders, k.theta + Math.cos(a) * rr / RF, k.lat + Math.sin(a) * rr, 0.8 + rng() * 1.6, 1.2);
      }
      return;
    }
    const list = kind === 0 || kind === 1 ? pines : oaks;
    const n = 22 + Math.floor(rng() * 26);
    for (let i = 0; i < n; i++) {
      // biased toward the crown, so the hill reads as wooded on top and open below
      const a = rng() * Math.PI * 2, rr = k.r * Math.pow(rng(), 0.65) * 0.92;
      treeWithCollider(list, k.theta + Math.cos(a) * rr / RF, k.lat + Math.sin(a) * rr,
        0.8 + rng() * 0.8, 2.0);
    }
    for (let i = 0; i < 6; i++) {
      const a = rng() * Math.PI * 2, rr = k.r * (0.55 + rng() * 0.45);
      tryPlace(boulders, k.theta + Math.cos(a) * rr / RF, k.lat + Math.sin(a) * rr, 0.9 + rng() * 1.8, 1.3);
    }
  });

  // ── Boulder fields on the steep upper slopes ──
  // Where the ground tips past what soil holds, it is scree and glacial-erratic
  // sized blocks rather than grass — this is also where the terrain splat map
  // switches to rock, so the two agree.
  for (let c = 0; c < 60; c++) {
    const theta = rng() * Math.PI * 2;
    const side = rng() < 0.5 ? -1 : 1;
    const cLat = side * (40 + rng() * 14);
    const n = 4 + Math.floor(rng() * 9);
    for (let i = 0; i < n; i++) {
      const spread = 3 + rng() * 9;
      tryPlace(boulders,
        theta + ((rng() - 0.5) * spread) / RF, cLat + (rng() - 0.5) * spread,
        1.0 + rng() * 2.4, 1.4);
    }
  }

  // ── Mountain outcrops and scree ──
  // The rim is 30–80 m of bare rock, and a heightfield that size with nothing
  // standing on it has no scale: you cannot tell a 40 m face from a 4 m bank.
  // Blocks and scree fans do that job. They deliberately bypass siteOK's slope
  // test — steep ground is exactly where they belong — but still refuse to sit
  // in the water, on a path, or inside the Cascade gorge.
  {
    const gorge = (theta, lat) =>
      lat > 40 && Math.abs(arcDelta(CASCADE.theta, theta)) < 46;
    const rockSiteOK = (theta, lat) => {
      if (Math.abs(lat) < MTN_LAT0 - 8 || Math.abs(lat) > MTN_LAT1 - 3) return false;
      if (terrainH(theta, lat) < 14) return false;          // still down in the fields
      if (terrainSlope(theta, lat) > 2.3) return false;     // sheer face — nothing lodges
      if (gorge(theta, lat)) return false;
      return !colliders.resolve(theta * RF, lat, 0.4, 1.2);
    };
    for (let c = 0; c < 260; c++) {
      const theta = rng() * Math.PI * 2;
      const side = rng() < 0.5 ? -1 : 1;
      const cLat = side * (MTN_LAT0 - 2 + rng() * 26);
      if (!rockSiteOK(theta, cLat)) continue;
      // one erratic block, then a scree fan spilling downhill from it
      boulders.push({ theta, lat: cLat, yaw: rng() * Math.PI * 2, scale: 1.6 + rng() * 3.4 });
      const n = 6 + Math.floor(rng() * 12);
      for (let i = 0; i < n; i++) {
        const th = theta + ((rng() - 0.5) * 16) / RF;
        const la = cLat - side * rng() * 11;               // downhill = toward the valley
        if (rockSiteOK(th, la)) rocks.push({ theta: th, lat: la, yaw: rng() * Math.PI * 2, scale: 0.5 + rng() * 1.5 });
      }
    }

    // The same treatment for the spurs. rockSiteOK's lat band is the rim, and a
    // spur is rim rock standing out in the fields — without its own pass the
    // buttresses come out as bare geometry with nothing lying on them, which is
    // what makes them look like a heightfield rather than a mountain.
    const spurSiteOK = (theta, lat) => {
      if (!onSpur(theta, lat)) return false;
      if (spurH(theta, lat) < 4) return false;
      if (terrainSlope(theta, lat) > 2.3) return false;
      return !colliders.resolve(theta * RF, lat, 0.4, 1.2);
    };
    for (const sp of SPURS) {
      for (let c = 0; c < 90; c++) {
        const theta = sp.theta + ((rng() - 0.5) * 2.2 * (sp.halfArc + sp.feather)) / RF;
        const lat = sp.tipLat + (sp.side * (MTN_LAT0 - 4) - sp.tipLat) * rng();
        if (!spurSiteOK(theta, lat)) continue;
        if (rng() < 0.28) boulders.push({ theta, lat, yaw: rng() * Math.PI * 2, scale: 1.4 + rng() * 3.0 });
        else rocks.push({ theta, lat, yaw: rng() * Math.PI * 2, scale: 0.5 + rng() * 1.6 });
      }
    }
  }

  // ── The Solace Park redwoods ──
  // One grove of genuinely enormous conifers, so the park has a landmark rather
  // than more of the same 8 m trees.
  {
    const d = DISTRICTS.find(x => x.name === 'Solace Park');
    const cTheta = ((d.from + d.to) / 2 + 6) * DEG;
    for (let i = 0; i < 46; i++) {
      const a = rng() * Math.PI * 2, rr = 26 * Math.sqrt(rng());
      const th = cTheta + Math.cos(a) * rr / RF;
      const la = -18 + Math.sin(a) * rr;
      if (treeWithCollider(pines, th, la, 2.1 + rng() * 1.0, 2.6)) {
        colliders.addCylinder(th, la, 0.9, 12);
      }
    }
  }

  // ── Blossom copses ── a few stands tinted pink-white, which read as fruit
  // trees in flower and give the eye something warm among all the green.
  for (const [deg, lat] of [[204, 30], [148, -28], [96, 33]]) {
    const cTheta = deg * DEG;
    for (let i = 0; i < 26; i++) {
      const a = rng() * Math.PI * 2, rr = 15 * Math.sqrt(rng());
      tryPlace(blossoms, cTheta + Math.cos(a) * rr / RF, lat + Math.sin(a) * rr, 0.6 + rng() * 0.4, 1.6);
    }
  }

  // ── Fallen timber ── logs and stumps through the wooded belts
  for (let i = 0; i < 190; i++) {
    const theta = rng() * Math.PI * 2;
    const side = rng() < 0.5 ? -1 : 1;
    const lat = side * (24 + rng() * 24);
    if (!siteOK(theta, lat)) continue;
    if (colliders.resolve(theta * RF, lat, 0.4, 1.6)) continue;
    logs.push({ theta, lat, yaw: rng() * Math.PI * 2, scale: 0.7 + rng() * 0.9 });
  }

  // ── Ground cover ──
  // Tufts used to be 14 000 independent draws across the green districts, which
  // is one tuft per ~80 m²: from standing height that is bare grass with a
  // speck on it every few paces. Real ground cover grows in patches, so this
  // seeds clumps instead — a clump reads as a plant where a lone tuft reads as
  // a speck — and it sweeps the WHOLE ring, not just the districts someone
  // once flagged 'green'. A tuft is two crossed quads, so the extra thousands
  // cost almost nothing.
  {
    const CSTEP = 8.0;
    for (let s = 0; s < CIRCUMFERENCE; s += CSTEP) {
      for (let lat = -(MTN_LAT0 + 6); lat <= MTN_LAT0 + 6; lat += CSTEP) {
        if (rng() < 0.2) continue;
        const th = (s + (rng() - 0.5) * CSTEP) / RF;
        const la = lat + (rng() - 0.5) * CSTEP;
        if (!siteOK(th, la)) continue;
        if (_nearLane(th, la, 2)) continue;
        const n = 5 + Math.floor(rng() * 8);
        const spread = 1.6 + rng() * 2.2;
        for (let i = 0; i < n; i++) {
          tufts.push({
            theta: th + ((rng() - 0.5) * 2 * spread) / RF,
            lat: la + (rng() - 0.5) * 2 * spread,
            yaw: rng() * Math.PI, scale: 0.5 + rng() * 0.7,
          });
        }
      }
    }
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
      const ft = cTheta + ((rng() - 0.5) * 2.6) / RF;
      const fl = cLat + (rng() - 0.5) * 2.6;
      const fy = rng() * Math.PI;
      const fs = 0.3 + rng() * 0.3;
      if (!siteOK(ft, fl)) continue;                                    // off the road, out of the water
      flowers.push({ theta: ft, lat: fl, yaw: fy, scale: fs });
    }
  }

  // ── build instanced meshes ──
  // Split every scatter into arc sectors. A single ring-wide InstancedMesh has
  // a bounding sphere the size of the torus, so it never fails the frustum test
  // and the GPU walks all of its instances whichever way you are facing — twice,
  // counting the shadow pass. Per-sector meshes cull for real; the cost is a
  // few dozen extra draw calls, which is nothing next to the triangles saved.
  const VEG_SECTORS = 24;
  const SECTOR_DEG = 360 / VEG_SECTORS;
  function addInstanced(geo, mats, list, { shadow = true, tintFn = null } = {}) {
    if (!list.length) return;
    const sectors = Array.from({ length: VEG_SECTORS }, () => []);
    for (const pl of list) {
      const deg = (((pl.theta / DEG) % 360) + 360) % 360;
      sectors[Math.min(VEG_SECTORS - 1, Math.floor(deg / SECTOR_DEG))].push(pl);
    }
    for (const sector of sectors) {
      if (!sector.length) continue;
      const mesh = new THREE.InstancedMesh(geo, mats, sector.length);
      sector.forEach((pl, i) => {
        // sit on the terrain, sunk 0.15 m so trunks/tufts meet the ground cleanly
        placementMatrix(pl.theta, pl.lat, groundH(pl.theta, pl.lat, Infinity) - 0.15, pl.yaw, pl.scale, _vegM);
        mesh.setMatrixAt(i, _vegM);
        if (tintFn) mesh.setColorAt(i, tintFn(i));
      });
      if (tintFn) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = shadow;
      mesh.receiveShadow = false;
      veg.add(mesh);
    }
  }

  const leafTint = () => _c.setHSL(0.25 + rng() * 0.08, 0.34 + rng() * 0.22, 0.28 + rng() * 0.14).clone();
  addInstanced(oakGeo, [barkMat, leafMat], oaks, { tintFn: leafTint });
  addInstanced(poplarGeo, [barkMat, leafMat], poplars, { tintFn: leafTint });
  addInstanced(pineGeo, [barkMat, pineMat], pines);

  addInstanced(oakLoGeo, [barkMat, leafMat], oaksLo, { tintFn: leafTint });
  addInstanced(pineLoGeo, [barkMat, pineMat], pinesLo);

  const bushGeo = new THREE.SphereGeometry(0.8, 9, 7);
  bushGeo.scale(1, 0.75, 1);
  bushGeo.translate(0, 0.5, 0);
  addInstanced(bushGeo, leafMat, bushes, { tintFn: leafTint });

  // Understory scrub: cheaper than a bush, and tinted over a much wider range —
  // gorse, bracken and heather are not all the same green, and a hillside
  // covered in one green is a hillside painted rather than planted.
  const scrubGeo = new THREE.SphereGeometry(0.8, 7, 5);
  scrubGeo.scale(1, 0.72, 1);
  scrubGeo.translate(0, 0.34, 0);
  const scrubTint = () => _c.setHSL(0.19 + rng() * 0.14, 0.22 + rng() * 0.3, 0.22 + rng() * 0.16).clone();
  // per-axis jitter as well as size: uniformly scaled squashed spheres all read
  // as the same green disc, which is worse than no scrub at all
  addInstanced(scrubGeo, leafMat, scrub.map(b => ({
    ...b, scale: new THREE.Vector3(
      b.scale * (0.75 + rng() * 0.55), b.scale * (0.7 + rng() * 0.75), b.scale * (0.75 + rng() * 0.55)),
  })), { shadow: false, tintFn: scrubTint });

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

  // boulders: bigger, blockier and more angular than the scatter rocks, with a
  // separate low-frequency shape so a field of them doesn't read as one repeated
  // pebble
  const boulderGeo = new THREE.IcosahedronGeometry(1.0, 1);
  {
    const pos = boulderGeo.attributes.position;
    const brng = mulberry32(90210);
    for (let i = 0; i < pos.count; i++) {
      const f = 0.72 + brng() * 0.5;
      pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f * 0.8, pos.getZ(i) * f);
    }
    boulderGeo.computeVertexNormals();
    boulderGeo.translate(0, 0.35, 0);
  }
  const boulderMat = new THREE.MeshStandardMaterial({
    map: textures.rock, normalMap: textures.rockN, roughnessMap: textures.rockR,
    color: 0xffffff, roughness: 1, metalness: 0.02,
  });
  const boulderTint = () => _c.setHSL(0.09 + rng() * 0.04, 0.03 + rng() * 0.05, 0.42 + rng() * 0.22).clone();
  addInstanced(boulderGeo, boulderMat, boulders.map(b => ({
    ...b, scale: new THREE.Vector3(b.scale * (0.8 + rng() * 0.7), b.scale * (0.6 + rng() * 0.6), b.scale * (0.8 + rng() * 0.7)),
  })), { tintFn: boulderTint });

  // fallen timber: a lying trunk with a broken stump beside it
  {
    const trunkGeo = new THREE.CylinderGeometry(0.34, 0.44, 4.6, 8);
    trunkGeo.rotateZ(Math.PI / 2);
    trunkGeo.translate(0, 0.4, 0);
    const stumpGeo = new THREE.CylinderGeometry(0.42, 0.5, 0.85, 9);
    stumpGeo.translate(1.9, 0.42, 1.4);
    const logGeo = mergeGeometries([trunkGeo, stumpGeo]);
    const logMat = new THREE.MeshStandardMaterial({ map: textures.bark, normalMap: textures.barkN, color: 0xbba98e, roughness: 1 });
    addInstanced(logGeo, logMat, logs);
  }

  // blossom trees: same canopy geometry, warm-tinted
  const blossomTint = () => _c.setHSL(0.94 + rng() * 0.07, 0.35 + rng() * 0.3, 0.68 + rng() * 0.16).clone();
  addInstanced(oakGeo, [barkMat, leafMat.clone()], blossoms, { tintFn: blossomTint });

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
