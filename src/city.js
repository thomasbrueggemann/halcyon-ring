// ── The ring city: buildings, districts, puzzle stations, street furniture ──

const _cityM = new THREE.Matrix4();

// Ground-aware placement: raise h by the terrain/patch height at (theta, lat) so
// nothing floats or sinks on the rolling floor. Set-pieces sit on flat spots so
// groundH there is 0 and their coordinates are unchanged.
function gm(theta, lat, h, yaw = 0, scale = 1, target) {
  return placementMatrix(theta, lat, h + groundH(theta, lat, Infinity), yaw, scale, target);
}

// Iterate theta positions (radians) along an arc given in degrees.
function* arcSteps(fromDeg, toDeg, stepMeters) {
  let a = fromDeg, b = toDeg;
  if (b < a) b += 360;
  const stepDeg = (stepMeters / RF) / DEG;
  for (let d = a + stepDeg / 2; d < b; d += stepDeg) yield (d % 360) * DEG;
}

function gableRoofGeometry(latDepth, arcWidth, roofH, wallH, chimney = false) {
  // ridge runs along local Z (the arc direction); slight overhang
  const hx = latDepth / 2 + 0.35, hz = arcWidth / 2 + 0.35;
  const v = [];
  const quad = (a, b, c, d) => v.push(...a, ...b, ...c, ...a, ...c, ...d);
  const A = [-hx, 0, -hz], B = [-hx, 0, hz], C = [hx, 0, hz], D = [hx, 0, -hz];
  const R1 = [0, roofH, -hz], R2 = [0, roofH, hz];
  quad(A, B, R2, R1);            // -x slope
  quad(C, D, R1, R2);            // +x slope
  v.push(...A, ...R1, ...D);     // gable ends
  v.push(...B, ...C, ...R2);
  if (chimney) {
    const cx = hx * 0.42, cz = hz * 0.35, s = 0.3, top = roofH + 0.55;
    const c = [
      [cx - s, 0, cz - s], [cx + s, 0, cz - s], [cx + s, 0, cz + s], [cx - s, 0, cz + s],
      [cx - s, top, cz - s], [cx + s, top, cz - s], [cx + s, top, cz + s], [cx - s, top, cz + s],
    ];
    quad(c[0], c[1], c[5], c[4]); quad(c[1], c[2], c[6], c[5]);
    quad(c[2], c[3], c[7], c[6]); quad(c[3], c[0], c[4], c[7]);
    quad(c[4], c[5], c[6], c[7]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  const uv = [];
  for (let i = 0; i < v.length / 3; i++) uv.push(v[i * 3] * 0.12 + 0.5, v[i * 3 + 2] * 0.12 + 0.5);
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  geo.translate(0, wallH, 0);
  return geo;
}

// A round paved area draped over the ground. sweepProfile carries a fixed
// profile around the ring, so paving built that way sits at one absolute
// height — which buried the plaza under its own levelled pad once set-piece
// pads stopped being pinned to h = 0. Sampling groundH per vertex keeps paving
// on the ground wherever the pad settles. Discs rather than rectangles
// because a set-piece pad is only level inside its own radius: a square patch
// puts its corners out in the feathered slope, where the paving and the terrain
// interpenetrate and tear.
function drapedDisc(cTheta, cLat, radius, rings = 10, segs = 40, lift = 0.06) {
  const pos = [], uv = [], idx = [];
  const p = new THREE.Vector3();
  for (let r = 0; r <= rings; r++) {
    const rad = radius * (r / rings);
    for (let a = 0; a < segs; a++) {
      const ang = (a / segs) * Math.PI * 2;
      const ds = Math.cos(ang) * rad, dl = Math.sin(ang) * rad;
      const theta = cTheta + ds / RF, lat = cLat + dl;
      torusPosition(theta, lat, groundH(theta, lat, Infinity) + lift, p);
      pos.push(p.x, p.y, p.z);
      uv.push((ds + radius) / 6, (dl + radius) / 6);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let a = 0; a < segs; a++) {
      const a0 = r * segs + a, a1 = r * segs + (a + 1) % segs;
      const b0 = a0 + segs, b1 = a1 + segs;
      idx.push(a0, b0, a1, a1, b0, b1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function instancedFrom(geo, mat, placements, { shadow = true } = {}) {
  const mesh = new THREE.InstancedMesh(geo, mat, placements.length);
  placements.forEach((pl, i) => {
    gm(pl.theta, pl.lat, pl.h ?? 0, pl.yaw ?? 0, pl.scale ?? 1, _cityM);
    mesh.setMatrixAt(i, _cityM);
    if (pl.tint) mesh.setColorAt(i, pl.tint);
  });
  if (placements.some(p => p.tint)) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  return mesh;
}

function buildCity(scene, textures, colliders, rng) {
  const city = new THREE.Group();
  scene.add(city);
  const stations = {};
  // Filled in by the downtown-block section below and handed to the guideway
  // planner, which runs after the city exists and may need to bore through a
  // tower (or, failing that, never build one that is standing on the route).
  let pierceBlock = () => null;
  let boreFits = () => null;
  let hideBlock = () => false;

  // ════ Houses — dense, organic, Don-Davis-painting settlement ════
  // Nothing grid-like: homes cluster along the winding road and the LANES
  // footpath network, facing the way they front, at irregular setbacks, in
  // courtyard clusters ringing small plazas, plus lone hillside cottages.
  const archetypes = [
    { latD: 8, arcW: 10, wallH: 3.3, roofH: 2.3, wall: textures.wallA, wallE: textures.wallAE, roof: textures.roof },
    { latD: 9, arcW: 9,  wallH: 6.4, roofH: 1.9, wall: textures.wallB, wallE: textures.wallBE, roof: textures.roofSlate },
    { latD: 8, arcW: 12, wallH: 3.9, roofH: 2.7, wall: textures.wallC, wallE: textures.wallCE, roof: textures.roof },
    { latD: 6, arcW: 7,  wallH: 2.9, roofH: 2.0, wall: textures.wallA, wallE: textures.wallAE, roof: textures.roofSlate }, // cottage
  ];
  const housePlacements = archetypes.map(() => []);
  const tintPool = [0xffffff, 0xf2e8da, 0xe8eef2, 0xf5e9dc, 0xeae2f0, 0xf0ded0, 0xdfe6ea].map(c => new THREE.Color(c));
  const hedgePlacements = [];
  const plazaDiscs = [];   // small courtyard plaza patches (instanced)

  // A footprint centered at (theta, lat) with rotated half-extents (hArc, hLat)
  // intrudes on a station platform if its bulk reaches the −lat platform band
  // ([stationLat−7, stationLat+4]) within ±(16 + its own arc reach) of the
  // station theta. Platforms sit at stationLat−2.9, are 24 m long with a ramp
  // beyond — keep that whole area clear of building colliders AND geometry.
  const nearStationZone = (theta, lat, hArc, hLat) => {
    for (let i = 0; i < STATIONS.length; i++) {
      const st = STATIONS[i];
      // The platform sits +lat of the guideway and its walk-up ramp runs ~35 m
      // further ALONG the ring off the far end, so the reserve is a long thin
      // corridor, not a box around the station theta.
      const d = arcDelta(st.theta, theta);          // +ve = ahead of the station
      const inPlatform = Math.abs(d) < 18 + hArc && lat > st.lat - 5 - hLat && lat < st.lat + 10 + hLat;
      const inRamp = d > 8 - hArc && d < 56 + hArc && lat > st.lat - 1 - hLat && lat < st.lat + 8 + hLat;
      if (inPlatform || inRamp) return true;
    }
    return false;
  };
  // Axis-aligned (s, lat) half-extents of a yaw-rotated box footprint whose
  // local +Z spans `arcW` (arc dir) and local +X spans `latD` (lat dir).
  const rotAABB = (arcW, latD, yaw, pad) => {
    const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
    return {
      hArc: c * (arcW / 2) + s * (latD / 2) + pad,
      hLat: s * (arcW / 2) + c * (latD / 2) + pad,
    };
  };
  // Is (theta, lat) a legal home site? Off the road, out of the river, clear of
  // station platforms, and not overlapping an existing obstacle.
  // The road and the river are curves, not lat bands: over a 16 m-wide
  // building either can move several metres, so a clearance measured only at
  // the centre lets one corner of the footprint sit on the carriageway. Test
  // both ends of the arc extent as well.
  // `railClear` is the extra lat the guideway wants beyond the footprint. The
  // deck rides only ~6.5 m up — lower than a gabled roof — so a house under it
  // is a house the monorail runs through. Homes therefore keep off the line the
  // same way they keep off the road, and transit.js's planner is left with the
  // handful of real conflicts to steer, hop or tunnel through. Downtown towers
  // are the deliberate exception: they pass RAIL_KEEP = 0 and get bored.
  // The mountain spurs and the standing lakes arrived after this test did, and
  // neither is a curve you can express as a lat clearance: a spur is rock the
  // width of a district, a lake is a hole in the ground with water in it. Both
  // are sampled over the footprint's corners for the same reason the corridors
  // are — a 16 m building whose centre is dry can still have two feet in a lake.
  const onBadGround = (theta, lat, hArc, hLat) => {
    for (const ds of [-hArc, 0, hArc]) {
      for (const dl of [-hLat, 0, hLat]) {
        const th = theta + ds / RF;
        if (onSpur(th, lat + dl)) return true;
        if (inLake(th, lat + dl, 3)) return true;
      }
    }
    return false;
  };
  const clearOfCorridors = (theta, lat, hArc, hLat, railClear = 0) => {
    for (const ds of [-hArc, 0, hArc]) {
      const th = theta + ds / RF;
      if (Math.abs(lat - roadLat(th)) < ROAD_HALF + ROAD_SHLDR + 1.5 + hLat) return false;
      if (Math.abs(lat - riverLat(th)) < riverHalf(th) + 3 + hLat) return false;
      if (railClear && Math.abs(lat - railLat(th)) < railClear + hLat) return false;
    }
    return !onBadGround(theta, lat, hArc, hLat);
  };
  // half the deck + the margin the planner may still steer the line by
  const RAIL_KEEP = RAIL_HALF + 4.5;
  const houseSiteOK = (theta, lat, half, hArc, hLat) => {
    if (Math.abs(lat) + hLat > BUILD_LAT) return false;
    if (!clearOfCorridors(theta, lat, hArc, hLat, RAIL_KEEP)) return false;
    if (nearStationZone(theta, lat, hArc, hLat)) return false;
    return !colliders.resolve(theta * RF, lat, 1.2, half);
  };
  // Place one house at an explicit position + facing. Returns success.
  const placeHouse = (theta, lat, faceYaw, prefer = -1) => {
    const a = prefer >= 0 ? prefer : Math.floor(rng() * 3);   // 0..2 for streets
    const arch = archetypes[a];
    const scale = 0.88 + rng() * 0.26;
    const arcW = arch.arcW * scale, latD = arch.latD * scale;
    const half = Math.max(arcW, latD) / 2 + 0.5;              // circle for the overlap check
    const { hArc, hLat } = rotAABB(arcW, latD, faceYaw, 0.4); // rectangle for registration
    if (!houseSiteOK(theta, lat, half, hArc, hLat)) return false;
    housePlacements[a].push({
      theta, lat, yaw: faceYaw + (rng() - 0.5) * 0.14, scale,
      tint: tintPool[Math.floor(rng() * tintPool.length)],
    });
    colliders.addBox(theta, lat, hArc, hLat, arch.wallH + arch.roofH,
      { kind: 'house', a, i: housePlacements[a].length - 1 });
    // garden hedges flanking the street-facing wall
    if (rng() < 0.6) {
      const c = Math.cos(faceYaw), s = Math.sin(faceYaw);
      const fwd = arch.latD / 2 + 1.0;           // step out the front
      for (const off of [-arch.arcW * 0.34, arch.arcW * 0.34]) {
        const ht = theta + (-s * fwd + c * off) / RF;
        const hl = lat + (c * fwd + s * off);
        hedgePlacements.push({ theta: ht, lat: hl, yaw: faceYaw + (rng() - 0.5) * 0.2, scale: 0.8 + rng() * 0.5 });
      }
    }
    return true;
  };

  // ── Frontage along the winding ring road (residential belts) ──
  for (const d of DISTRICTS.filter(d => d.kind === 'houses')) {
    for (const theta of arcSteps(d.from, d.to, 9)) {
      const ry = roadYawAt(theta);
      for (const side of [-1, 1]) {
        if (rng() < 0.18) continue;
        const base = side > 0 ? Math.PI : 0;
        const set1 = 9 + rng() * 6;                       // irregular setback 9..15
        placeHouse(theta + (rng() - 0.5) * 4 / RF, side * set1, base + ry);
        if (rng() < 0.62) placeHouse(theta + (6 + rng() * 6) / RF, side * (22 + rng() * 8), base + ry);
        if (rng() < 0.35) placeHouse(theta + (rng() - 0.5) * 8 / RF, side * (34 + rng() * 8), base + ry);
      }
    }
  }

  // ── Homes lining the winding LANES network ──
  const laneHouseCfg = {
    houses: { step: 7.5, prob: 0.82, both: true },
    park:   { step: 15,  prob: 0.34, both: false },
    orchard:{ step: 15,  prob: 0.32, both: false },
    water:  { step: 16,  prob: 0.28, both: false },
    plaza:  { step: 12,  prob: 0.30, both: true },
    science:{ step: 13,  prob: 0.22, both: false },
    market: { step: 14,  prob: 0.20, both: false },
    farm:   { step: 18,  prob: 0.16, both: false },
  };
  for (const lane of LANES) {
    const rootDeg = ((laneSample(lane, 0.5).theta / DEG) % 360 + 360) % 360;
    const cfg = laneHouseCfg[districtAt(rootDeg).kind];
    if (!cfg) continue;
    // walk the lane by arc length, dropping houses to either side
    const N = 48;
    let acc = 999, prev = null;
    for (let k = 0; k <= N; k++) {
      const q = laneSample(lane, 0.05 + 0.9 * (k / N));
      if (prev) acc += Math.hypot(arcDelta(prev.theta, q.theta), q.lat - prev.lat);
      prev = q;
      if (acc < cfg.step) continue;
      acc = 0;
      const sides = cfg.both ? [-1, 1] : [rng() < 0.5 ? -1 : 1];
      for (const side of sides) {
        if (rng() > cfg.prob) continue;
        const off = 4.5 + rng() * 4.5;                    // setback 4.5..9 from lane
        const c = Math.cos(q.yaw), s = Math.sin(q.yaw);
        const theta = q.theta + (-s * off * side) / RF;
        const lat = q.lat + (c * off * side);
        const base = side > 0 ? Math.PI : 0;
        placeHouse(theta, lat, base + q.yaw);
      }
    }
  }

  // ── Courtyard clusters: 3–6 homes ringing a small plaza patch ──
  for (const d of DISTRICTS.filter(d => ['houses', 'plaza'].includes(d.kind))) {
    const nClusters = d.kind === 'houses' ? 3 : 1;
    for (let ci = 0; ci < nClusters; ci++) {
      let from = d.from, to = d.to; if (to <= from) to += 360;
      const cTheta = ((from + (0.2 + 0.6 * rng()) * (to - from)) % 360) * DEG;
      const side = rng() < 0.5 ? -1 : 1;
      const cLat = side * (26 + rng() * 12);
      if (Math.abs(cLat) > 44) continue;
      if (Math.abs(cLat - riverLat(cTheta)) < riverHalf(cTheta) + 6) continue;
      const cr = 7 + rng() * 3;
      const n = 3 + Math.floor(rng() * 4);
      let placed = 0;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + rng() * 0.3;
        const ht = cTheta + (Math.cos(ang) * cr) / RF;
        const hl = cLat + Math.sin(ang) * cr;
        // face inward toward the courtyard centre
        if (placeHouse(ht, hl, Math.atan2(-Math.cos(ang), -Math.sin(ang)))) placed++;
      }
      if (placed >= 2) plazaDiscs.push({ theta: cTheta, lat: cLat, scale: cr * 0.6 });
    }
  }

  // ── Lone hillside cottages on the outer knolls ──
  for (const d of DISTRICTS.filter(d => ['houses', 'park', 'orchard'].includes(d.kind))) {
    for (let i = 0; i < 6; i++) {
      let from = d.from, to = d.to; if (to <= from) to += 360;
      const theta = ((from + rng() * (to - from)) % 360) * DEG;
      const side = rng() < 0.5 ? -1 : 1;
      const lat = side * (32 + rng() * 12);
      placeHouse(theta, lat, rng() * Math.PI * 2, 3);   // cottage archetype
    }
  }

  // Build house wall + foundation-skirt + roof instanced meshes.
  const foundMat = new THREE.MeshStandardMaterial({ color: 0x5c554d, roughness: 0.95 });
  const houseMeshes = archetypes.map(() => []);
  archetypes.forEach((arch, i) => {
    if (!housePlacements[i].length) return;
    const wallGeo = new THREE.BoxGeometry(arch.latD, arch.wallH, arch.arcW);
    wallGeo.translate(0, arch.wallH / 2, 0);
    const wallMat = new THREE.MeshStandardMaterial({
      map: arch.wall, roughness: 0.9,
      emissiveMap: arch.wallE, emissive: 0xffffff, emissiveIntensity: 0.55,
    });
    houseMeshes[i].push(instancedFrom(wallGeo, wallMat, housePlacements[i]));
    // foundation skirt: fill the 1.8 m below the floor so slopes never show
    // floating corners.
    const foundGeo = new THREE.BoxGeometry(arch.latD + 0.3, 1.9, arch.arcW + 0.3);
    foundGeo.translate(0, -0.85, 0);
    houseMeshes[i].push(instancedFrom(foundGeo, foundMat, housePlacements[i], { shadow: false }));
    const roofGeo = gableRoofGeometry(arch.latD, arch.arcW, arch.roofH, arch.wallH, true);
    const roofMat = new THREE.MeshStandardMaterial({ map: arch.roof, roughness: 0.85 });
    houseMeshes[i].push(instancedFrom(roofGeo, roofMat, housePlacements[i]));
    for (const m of houseMeshes[i]) city.add(m);
  });
  // Last resort for the guideway planner: a home that ended up standing exactly
  // on the line, with no room to curve round it and no roof to hop, is simply
  // never built. Rare — houses keep RAIL_KEEP clear of the route by design.
  const hideHouse = (tag) => {
    const p = housePlacements[tag.a] && housePlacements[tag.a][tag.i];
    if (!p || p.hidden) return false;
    _cityM.makeScale(0, 0, 0);
    for (const m of houseMeshes[tag.a]) {
      m.setMatrixAt(tag.i, _cityM);
      m.instanceMatrix.needsUpdate = true;
    }
    p.hidden = true;
    return true;
  };
  {
    const hedgeGeo = new THREE.BoxGeometry(0.75, 0.95, 2.3);
    hedgeGeo.translate(0, 0.47, 0);
    const hedgeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
    const hc = new THREE.Color();
    const hedges = instancedFrom(hedgeGeo, hedgeMat, hedgePlacements.map(p => ({
      ...p, tint: hc.setHSL(0.27 + rng() * 0.06, 0.5, 0.24 + rng() * 0.1).clone(),
    })), { shadow: false });
    city.add(hedges);
  }
  // Courtyard plaza patches (flat discs of plaza texture).
  if (plazaDiscs.length) {
    const discGeo = new THREE.CircleGeometry(1, 20);
    discGeo.rotateX(-Math.PI / 2);
    const discMat = new THREE.MeshStandardMaterial({ map: textures.plaza, roughness: 0.9, side: THREE.DoubleSide });
    const disc = new THREE.InstancedMesh(discGeo, discMat, plazaDiscs.length);
    plazaDiscs.forEach((p, i) => { disc.setMatrixAt(i, gm(p.theta, p.lat, 0.05, 0, p.scale, _cityM)); });
    disc.receiveShadow = true;
    city.add(disc);
  }

  // ════ Street lights ════
  const lightPlacements = [];
  let flip = 1;
  for (const theta of arcSteps(0, 360, 18)) {
    flip = -flip;
    lightPlacements.push({ theta, lat: roadLat(theta) + flip * 6.5 });   // follow the winding road
  }
  // scatter a few short posts along major lanes for lit footpaths
  for (const lane of LANES) {
    if (rng() < 0.45) continue;
    for (const t of [0.35, 0.7]) {
      const q = laneSample(lane, t);
      const c = Math.cos(q.yaw), s = Math.sin(q.yaw), off = 2.2;
      lightPlacements.push({ theta: q.theta + (-s * off) / RF, lat: q.lat + c * off, lane: true });
    }
  }
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.13, 5, 8);
  poleGeo.translate(0, 2.5, 0);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x8a929c, roughness: 0.5, metalness: 0.6 });
  city.add(instancedFrom(poleGeo, poleMat, lightPlacements, { shadow: false }));
  const headGeo = new THREE.SphereGeometry(0.28, 10, 8);
  headGeo.translate(0, 5.1, 0);
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xfff6dd, emissive: 0xffe9b0, emissiveIntensity: 0.9, roughness: 0.4,
  });
  city.add(instancedFrom(headGeo, headMat, lightPlacements, { shadow: false }));

  // ════ Meridian Plaza (spawn) — centered at 6°, clear of the 0° spoke ════
  {
    const PLAZA = 6 * DEG;
    const plaza = new THREE.Mesh(
      drapedDisc(PLAZA, 0, 24, 12, 56),
      new THREE.MeshStandardMaterial({
        map: textures.plaza, normalMap: textures.plazaN, roughnessMap: textures.plazaR,
        roughness: 0.9, metalness: 0.02, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      })
    );
    plaza.receiveShadow = true;
    city.add(plaza);

    // Fountain
    const basin = new THREE.Mesh(
      new THREE.TorusGeometry(4.2, 0.55, 10, 28),
      new THREE.MeshStandardMaterial({ color: 0x9a938a, roughness: 0.8 })
    );
    basin.geometry.rotateX(Math.PI / 2);
    basin.applyMatrix4(gm(PLAZA, 0, 0.5, 0, 1));
    basin.castShadow = true;
    city.add(basin);
    const pool = new THREE.Mesh(
      new THREE.CylinderGeometry(4.1, 4.1, 0.35, 24),
      new THREE.MeshStandardMaterial({ map: textures.water, roughness: 0.15, transparent: true, opacity: 0.9 })
    );
    pool.applyMatrix4(gm(PLAZA, 0, 0.45, 0, 1));
    city.add(pool);
    const jet = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 3.2, 12),
      new THREE.MeshStandardMaterial({ color: 0xcfe8ee, transparent: true, opacity: 0.55, roughness: 0.1 })
    );
    jet.applyMatrix4(gm(PLAZA, 0, 2.0, 0, 1));
    city.add(jet);
    colliders.addCylinder(PLAZA, 0, 5.0, 2.5);
    stations.fountain = { theta: PLAZA, lat: 0 };

    // Civic hall
    const hall = new THREE.Mesh(
      new THREE.BoxGeometry(14, 9, 26),
      new THREE.MeshStandardMaterial({
        map: textures.wallB, roughness: 0.8,
        emissiveMap: textures.wallBE, emissive: 0xffffff, emissiveIntensity: 0.55,
      })
    );
    hall.applyMatrix4(gm(8.2 * DEG, -34, 4.5, 0, 1));
    hall.castShadow = true; hall.receiveShadow = true;
    city.add(hall);
    colliders.addBox(8.2 * DEG, -34, 13.5, 7.5, 9);

    // Plaza info terminal
    stations.plazaTerminal = makeTerminal(city, 5.2 * DEG, 10, 0.05, 0x69d2ff, colliders);

    // ring of planters around the fountain
    const potMat = new THREE.MeshStandardMaterial({ color: 0x8a7361, roughness: 0.9 });
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const pTheta = PLAZA + (Math.cos(ang) * 9) / RF;
      const pLat = Math.sin(ang) * 9;
      const planter = new THREE.Group();
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.65, 0.7, 12), potMat);
      pot.position.y = 0.35;
      const shrub = new THREE.Mesh(
        new THREE.SphereGeometry(0.75, 10, 8),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color().setHSL(0.28 + rng() * 0.05, 0.5, 0.3), roughness: 1,
        })
      );
      shrub.position.y = 1.05;
      shrub.scale.y = 0.85;
      planter.add(pot, shrub);
      planter.applyMatrix4(gm(pTheta, pLat, 0.05, 0, 1));
      planter.traverse(o => { o.castShadow = true; });
      city.add(planter);
    }

    // ── Foreground homage: a small recreation court (Don Davis painting) ──
    // Sits on the flat +lat side of the plaza, clear of the fountain (6°,0) and
    // the spawn point (4.3°,−13). Purely decorative.
    {
      const RC = 5 * DEG, RL = 18;   // court centre
      // plaza apron (flat textured slab)
      const apron = new THREE.Mesh(
        sweepProfile([[RL - 11, 0.05], [RL + 11, 0.05]], {
          uScale: 1 / 5, vScale: 1 / 5, thetaFrom: RC - 13 / RF, thetaTo: RC + 13 / RF, segs: 10,
        }),
        new THREE.MeshStandardMaterial({ map: textures.plaza, roughness: 0.9, side: THREE.DoubleSide })
      );
      apron.receiveShadow = true;
      city.add(apron);   // sweepProfile bakes world coords — no gm
      // lawn strip beside the apron
      const lawn = new THREE.Mesh(
        new THREE.PlaneGeometry(10, 9),
        new THREE.MeshStandardMaterial({ color: 0x6f9a52, roughness: 1, side: THREE.DoubleSide })
      );
      lawn.geometry.rotateX(-Math.PI / 2);
      lawn.applyMatrix4(gm(RC + 8 / RF, RL + 9, 0.04, 0, 1));
      lawn.receiveShadow = true;
      city.add(lawn);
      // sunken swimming pool
      const poolRim = new THREE.Mesh(
        new THREE.BoxGeometry(6.4, 0.5, 10.4),
        new THREE.MeshStandardMaterial({ color: 0xd8dce0, roughness: 0.8 })
      );
      poolRim.applyMatrix4(gm(RC, RL, 0.2, 0, 1));
      poolRim.castShadow = true; city.add(poolRim);
      const poolWater = new THREE.Mesh(
        new THREE.BoxGeometry(5.6, 0.1, 9.6),
        new THREE.MeshStandardMaterial({ map: textures.water, roughness: 0.12, transparent: true, opacity: 0.9 })
      );
      poolWater.applyMatrix4(gm(RC, RL, 0.28, 0, 1));
      city.add(poolWater);
      // low rim colliders (short — the player steps over, never trapped)
      colliders.addBox(RC, RL - 5.3, 3.4, 0.4, 0.45);
      colliders.addBox(RC, RL + 5.3, 3.4, 0.4, 0.45);
      // 3 pergolas: flat canopy on four thin posts
      const postMat = new THREE.MeshStandardMaterial({ color: 0xb6a184, roughness: 0.85 });
      const canopyMat = new THREE.MeshStandardMaterial({ color: 0x8a6f4c, roughness: 0.9 });
      for (let p = 0; p < 3; p++) {
        const pt = RC + ((p - 1) * 7) / RF, pl = RL - 9;
        const pergola = new THREE.Group();
        for (const [dx, dz] of [[-1.6, -1.6], [1.6, -1.6], [1.6, 1.6], [-1.6, 1.6]]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.4, 6), postMat);
          post.position.set(dx, 1.2, dz); pergola.add(post);
        }
        const canopy = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.14, 4.0), canopyMat);
        canopy.position.y = 2.45; pergola.add(canopy);
        pergola.applyMatrix4(gm(pt, pl, 0, 0, 1));
        pergola.traverse(o => { o.castShadow = true; });
        city.add(pergola);
      }
      // a few loungers by the pool
      const loungerMat = new THREE.MeshStandardMaterial({ color: 0xdfe4e8, roughness: 0.7 });
      for (let i = 0; i < 4; i++) {
        const lounger = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 1.9), loungerMat);
        const lt = RC + ((i - 1.5) * 2.2) / RF;
        lounger.applyMatrix4(gm(lt, RL + 4.6, 0.35, (i % 2) * 0.1, 1));
        lounger.castShadow = true; city.add(lounger);
      }
    }
  }

  // ════ Engineering Bay — coolant valve puzzle ════
  {
    const thetaP = 48 * DEG;
    const wallMat = new THREE.MeshStandardMaterial({ map: textures.hull.clone(), roughness: 0.5, metalness: 0.4 });
    wallMat.map.repeat.set(3, 1.5);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.7, 4.2, 10), wallMat);
    panel.applyMatrix4(gm(thetaP, -18, 2.1, 0, 1));
    panel.castShadow = true;
    city.add(panel);
    colliders.addBox(thetaP, -18, 5.2, 0.6, 4.2);

    stations.valves = [];
    stations.valveLamps = [];
    const valveMat = () => new THREE.MeshStandardMaterial({ color: 0xc4442e, roughness: 0.45, metalness: 0.5 });
    for (let i = 0; i < 4; i++) {
      const arcOff = (i - 1.5) * 2.3;
      const vTheta = thetaP + arcOff / RF;
      const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.11, 10, 20), valveMat());
      // stem + wheel face the road (+lat side of panel)
      const grp = new THREE.Group();
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.55, 8), valveMat());
      stem.rotation.x = Math.PI / 2;
      stem.position.z = 0.28;
      wheel.position.z = 0.55;
      grp.add(stem, wheel);
      grp.applyMatrix4(gm(vTheta, -17.55, 1.45, -Math.PI / 2, 1));
      city.add(grp);
      stations.valves.push({ mesh: grp, wheel, theta: vTheta, lat: -17.2, h: 1.45, index: i });

      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0x000000, emissiveIntensity: 2.4 })
      );
      lamp.applyMatrix4(gm(vTheta, -17.6, 3.1, 0, 1));
      city.add(lamp);
      stations.valveLamps.push(lamp);
    }
    stations.valveStation = { theta: thetaP, lat: -17 };

    // Coolant tanks + pipes for set dressing
    const tankMat = new THREE.MeshStandardMaterial({ color: 0xc7cdd4, roughness: 0.35, metalness: 0.7 });
    for (let i = 0; i < 3; i++) {
      const t = (44 + i * 3) * DEG;
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 9, 18), tankMat);
      tank.geometry.rotateX(Math.PI / 2);
      tank.applyMatrix4(gm(t, -36, 2.6, 0, 1));
      tank.castShadow = true;
      city.add(tank);
      colliders.addCylinder(t, -36, 3.2, 5.5);
    }
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x8a6f2f, roughness: 0.5, metalness: 0.8 });
    const trestleMat = new THREE.MeshStandardMaterial({ color: 0x6e737a, roughness: 0.6, metalness: 0.6 });
    for (let i = 0; i < 2; i++) {
      const t = (45.5 + i) * DEG;
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 22, 10), pipeMat);
      pipe.rotation.z = Math.PI / 2;                 // axis runs along lat
      const g = new THREE.Group(); g.add(pipe);
      // carried 5 m up so it spans the carriageway instead of crossing it
      g.applyMatrix4(placementMatrix(t, -27, roadH(t) + 5.0 + i * 0.85, 0, 1));
      city.add(g);
      for (const dl of [-10.5, 10.5]) {
        const base = groundH(t, -27 + dl, Infinity);
        const hgt = roadH(t) + 5.0 + i * 0.85 - base;
        if (hgt < 1) continue;
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, hgt, 8), trestleMat);
        leg.applyMatrix4(gm(t, -27 + dl, hgt / 2, 0, 1));
        leg.castShadow = true;
        city.add(leg);
        colliders.addCylinder(t, -27 + dl, 0.45, hgt);
      }
    }
  }

  // ════ Agricultural Belt — greenhouse, barn, silo, fuse hunt ════
  {
    // Crop strips. Two things changed with the valley rebuild: the ground rolls
    // (so a strip swept flat over ±34 m of arc floats at one end and buries
    // itself at the other), and the road/river no longer sit at fixed lats (so
    // fixed bands would be planted in the water). Drape each strip over
    // groundH, and hang the bands off the road and the guideway instead.
    for (const d of [DISTRICTS.find(x => x.kind === 'farm')]) {
      const cropTints = [0xffffff, 0xd9ecb0, 0xe8d9a0, 0xc9e0c0, 0xf0e6c8];
      for (const theta of arcSteps(d.from + 2, d.to - 2, 80)) {
        for (let band = 0; band < 4; band++) {
          if (rng() < 0.12) continue;
          const near = band < 2;
          const lat0 = near
            ? roadLat(theta) - (11 + band * 14)
            : railLat(theta) + (5 + (band - 2) * 14);
          const lat1 = lat0 + (near ? -12 : 12);
          const lo = Math.min(lat0, lat1), hi = Math.max(lat0, lat1);
          if (lo < -VALLEY_LAT || hi > VALLEY_LAT) continue;   // fields, not mountainside
          // never plant into the water or across the carriageway
          const rl = riverLat(theta), rh = riverHalf(theta);
          if (hi > rl - rh - 2 && lo < rl + rh + 2) continue;
          if (hi > roadLat(theta) - 7 && lo < roadLat(theta) + 7) continue;
          // nor up the side of a spur, nor into a lake
          if (onSpur(theta, lo) || onSpur(theta, hi) || onSpur(theta, (lo + hi) / 2)) continue;
          if (inLake(theta, lo, 2) || inLake(theta, hi, 2) || inLake(theta, (lo + hi) / 2, 2)) continue;
          const pts = [];
          const mid = (lo + hi) / 2;
          for (let k = 0; k <= 10; k++) {
            pts.push({ theta: theta + (-34 + 68 * (k / 10)) / RF, lat: mid });
          }
          const strip = new THREE.Mesh(
            buildRibbon(pts, {
              half: (hi - lo) / 2,
              hFn: (th, la) => groundH(th, la, Infinity) + 0.05,
              closed: false, uScale: 0.08, vScale: 3,
            }),
            new THREE.MeshStandardMaterial({
              map: textures.crops, roughness: 1, side: THREE.DoubleSide,
              color: cropTints[Math.floor(rng() * cropTints.length)],
              polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
            })
          );
          strip.receiveShadow = true;
          city.add(strip);
        }
      }
    }

    // greenhouses
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xbfe8e2, transparent: true, opacity: 0.35, roughness: 0.15, metalness: 0.1,
    });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xe8eef0, roughness: 0.6 });
    stations.greenhouse = null;
    for (let i = 0; i < 4; i++) {
      const t = (95 + i * 9) * DEG;
      const lat = i % 2 ? 26 : -40;
      const g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(7, 0.4, 14), frameMat);
      base.position.y = 0.2;
      const glassBox = new THREE.Mesh(new THREE.BoxGeometry(6.8, 3.0, 13.8), glassMat);
      glassBox.position.y = 1.9;
      const ridge = new THREE.Mesh(gableRoofGeometry(6.8, 13.8, 1.4, 0), glassMat);
      ridge.position.y = 3.4;
      g.add(base, glassBox, ridge);
      g.applyMatrix4(gm(t, lat, 0, 0, 1));
      city.add(g);
      colliders.addBox(t, lat, 7.2, 3.7, 4.6);
      if (i === 2) stations.greenhouse = { theta: t, lat };
    }

    // barn + silo
    const barn = new THREE.Group();
    const barnBody = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 16),
      new THREE.MeshStandardMaterial({ map: textures.wallC, roughness: 0.9 }));
    barnBody.position.y = 2.5;
    const barnRoof = new THREE.Mesh(gableRoofGeometry(10, 16, 3, 5),
      new THREE.MeshStandardMaterial({ map: textures.roof, roughness: 0.85 }));
    barn.add(barnBody, barnRoof);
    barn.applyMatrix4(gm(122 * DEG, 34, 0, 0, 1));
    barn.traverse(o => { o.castShadow = true; });
    city.add(barn);
    colliders.addBox(122 * DEG, 34, 8.4, 5.4, 8);

    const silo = new THREE.Group();
    const siloBody = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 9, 16),
      new THREE.MeshStandardMaterial({ color: 0xc9cfd6, roughness: 0.4, metalness: 0.6 }));
    siloBody.position.y = 4.5;
    const siloCap = new THREE.Mesh(new THREE.SphereGeometry(2.4, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x9aa2ab, roughness: 0.4, metalness: 0.6 }));
    siloCap.position.y = 9;
    silo.add(siloBody, siloCap);
    silo.applyMatrix4(gm(124.5 * DEG, 40, 0, 0, 1));
    silo.traverse(o => { o.castShadow = true; });
    city.add(silo);
    colliders.addCylinder(124.5 * DEG, 40, 2.9, 9);

    // Power relay cabinet (fuse destination)
    const relay = new THREE.Group();
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.2, 1.6),
      new THREE.MeshStandardMaterial({ color: 0x7a8492, roughness: 0.4, metalness: 0.5 }));
    cab.position.y = 1.1;
    relay.add(cab);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 1.5),
      new THREE.MeshStandardMaterial({ color: 0x223a44, emissive: 0x2aa8c8, emissiveIntensity: 1.6 }));
    stripe.position.set(-0.48, 2.0, 0);
    relay.add(stripe);
    stations.relaySlots = [];
    for (let i = 0; i < 3; i++) {
      const slot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.3),
        new THREE.MeshStandardMaterial({ color: 0x1a2026, emissive: 0x0a2228, emissiveIntensity: 2.5 }));
      slot.position.set(-0.5, 1.2, (i - 1) * 0.45);   // slots face the road
      relay.add(slot);
      stations.relaySlots.push(slot);
    }
    relay.applyMatrix4(gm(104 * DEG, -9, 0, 0, 1));
    relay.traverse(o => { o.castShadow = true; });
    city.add(relay);
    colliders.addBox(104 * DEG, -9, 1.1, 0.8, 2.2);
    stations.relay = { theta: 104 * DEG, lat: -9 };

    // Fuse cells + locator beacons
    stations.fuses = [];
    const fuseSpots = [
      { theta: 96 * DEG, lat: 24.5, h: 1.15 },     // on the crate stack
      { theta: 113.4 * DEG, lat: -35.4, h: 0.35 }, // beside the third greenhouse
      { theta: 124.8 * DEG, lat: 36.5, h: 0.4 },   // at the silo
    ];
    for (const spot of fuseSpots) {
      const fuse = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.16, 0.55, 12),
        new THREE.MeshStandardMaterial({
          color: 0x9ff2ff, emissive: 0x35c8e8, emissiveIntensity: 2.2, roughness: 0.3,
        })
      );
      fuse.applyMatrix4(gm(spot.theta, spot.lat, spot.h, 0, 1));
      city.add(fuse);
      const beacon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.7, 0.7, 70, 10, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x51d8f0, transparent: true, opacity: 0.14,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false,
        })
      );
      beacon.applyMatrix4(gm(spot.theta, spot.lat, 35, 0, 1));
      city.add(beacon);
      stations.fuses.push({ ...spot, mesh: fuse, beacon, taken: false });
    }
    // crate stack under the first fuse
    const crateMat = new THREE.MeshStandardMaterial({ map: textures.dirt.clone(), color: 0xb59a6a, roughness: 0.9 });
    crateMat.map.repeat.set(1, 1);
    for (const [dx, dz, dy] of [[0, 0, 0.45], [0, 1.1, 0.45], [0, 0.5, 1.0 - 0.55 + 0.45]]) {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), crateMat);
      crate.applyMatrix4(gm(96 * DEG + dz / RF, 24.5 + dx, dy, rng(), 1));
      crate.castShadow = true;
      city.add(crate);
    }
    colliders.addBox(96 * DEG, 24.5, 1.2, 1.0, 1.6);
  }

  // ════ Gamma Terminal market ════
  {
    const awningColors = [0xc0463c, 0x3c78c0, 0xc0a13c, 0x3cc06e, 0x8a4cc0];
    for (let i = 0; i < 14; i++) {
      const t = (172.5 + i * 1.35) * DEG;
      const side = i % 2 ? 1 : -1;
      const lat = side * (10.5 + (i % 4) * 2.3);
      const stall = new THREE.Group();
      const counter = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 3.2),
        new THREE.MeshStandardMaterial({ map: textures.wallC, roughness: 0.9 }));
      counter.position.y = 0.55;
      const awning = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.12, 3.6),
        new THREE.MeshStandardMaterial({ color: awningColors[i % 4], roughness: 0.8 }));
      awning.position.set(-0.4, 2.4, 0);
      awning.rotation.z = 0.18;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 8),
        new THREE.MeshStandardMaterial({ color: 0x6b6f75 }));
      post.position.set(-1.4, 1.2, 1.5);
      const post2 = post.clone(); post2.position.z = -1.5;
      stall.add(counter, awning, post, post2);
      // goods on the counter
      for (let gI = 0; gI < 3; gI++) {
        const goods = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.3 + rng() * 0.25, 0.6),
          new THREE.MeshStandardMaterial({ color: awningColors[Math.floor(rng() * 5)], roughness: 0.85 })
        );
        goods.position.set((rng() - 0.5) * 1.2, 1.3, (gI - 1) * 0.95);
        stall.add(goods);
      }
      stall.applyMatrix4(gm(t, lat, 0, side > 0 ? Math.PI : 0, 1));
      stall.traverse(o => { o.castShadow = true; });
      city.add(stall);
      colliders.addBox(t, lat, 1.9, 1.4, 1.4);
    }
    // Spoke alignment console next to the Gamma spoke shaft
    stations.alignConsole = makeTerminal(city, 180 * DEG + 9 / RF, 8.5, 0.05, 0xffb454, colliders);
  }

  // ════ Reservoir Flats — coded water tower ════
  // (The old rectangular reservoir mesh is gone; the river's lake bulge at
  //  ~240° is the reservoir now — see layout.js riverHalf / world.js.)
  {
    // Water tower with the access code painted on the tank
    const towerTheta = 250 * DEG, towerLat = -28;
    const legMat = new THREE.MeshStandardMaterial({ color: 0x8a9098, roughness: 0.5, metalness: 0.6 });
    const tower = new THREE.Group();
    for (const [lx, lz] of [[-3, -3], [-3, 3], [3, -3], [3, 3]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.38, 18, 10), legMat);
      leg.position.set(lx, 9, lz);
      tower.add(leg);
    }
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 6.5, 20),
      new THREE.MeshStandardMaterial({ color: 0xd7dde2, roughness: 0.35, metalness: 0.5 }));
    tank.position.y = 21;
    tower.add(tank);
    tower.applyMatrix4(gm(towerTheta, towerLat, 0, 0, 1));
    tower.traverse(o => { o.castShadow = true; });
    city.add(tower);
    colliders.addBox(towerTheta, towerLat, 4.2, 4.2, 2.2);

    // The code itself
    const code = Array.from({ length: 4 }, () => Math.floor(rng() * 10));
    stations.code = code;
    const signCanvas = document.createElement('canvas');
    signCanvas.width = 512; signCanvas.height = 256;
    const ctx = signCanvas.getContext('2d');
    ctx.fillStyle = '#182430'; ctx.fillRect(0, 0, 512, 256);
    ctx.strokeStyle = '#e8b23c'; ctx.lineWidth = 8; ctx.strokeRect(10, 10, 492, 236);
    ctx.fillStyle = '#9fb4c4'; ctx.font = 'bold 34px monospace'; ctx.textAlign = 'center';
    ctx.fillText('OBSERVATORY MAINT.', 256, 62);
    ctx.fillText('ACCESS CODE', 256, 102);
    ctx.fillStyle = '#ffd166'; ctx.font = 'bold 92px monospace';
    ctx.fillText(code.join(' '), 256, 200);
    const signTex = new THREE.CanvasTexture(signCanvas);
    signTex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(7, 3.5),
      new THREE.MeshBasicMaterial({ map: signTex })
    );
    // hang the sign on the road-facing side of the tank (normal toward +lat)
    sign.applyMatrix4(gm(towerTheta, towerLat + 5.15, 21, -Math.PI / 2, 1));
    city.add(sign);
  }

  // ════ Observatory Quarter ════
  {
    const obsTheta = 272 * DEG, obsLat = -30;
    const obs = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(7, 8, 5, 20),
      new THREE.MeshStandardMaterial({ map: textures.wallB, roughness: 0.8 }));
    base.position.y = 2.5;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(7, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xc9d2da, roughness: 0.3, metalness: 0.6 }));
    dome.position.y = 5;
    const slit = new THREE.Mesh(new THREE.BoxGeometry(1.6, 7.5, 0.8),
      new THREE.MeshStandardMaterial({ color: 0x20242a, roughness: 0.6 }));
    slit.position.set(0, 7.5, 0);
    slit.rotation.x = 0.5;
    obs.add(base, dome, slit);
    obs.applyMatrix4(gm(obsTheta, obsLat, 0, 0, 1));
    obs.traverse(o => { o.castShadow = true; });
    city.add(obs);
    colliders.addCylinder(obsTheta, obsLat, 8.5, 10);

    stations.codeConsole = makeTerminal(city, obsTheta, -13, 0.05, 0xff6b9d, colliders);
  }

  // ════ Dock Annex warehouses + containers ════
  {
    const wallMat = new THREE.MeshStandardMaterial({ map: textures.hull.clone(), roughness: 0.55, metalness: 0.4 });
    wallMat.map.repeat.set(4, 2);
    for (let i = 0; i < 4; i++) {
      const t = (321 + i * 8) * DEG;
      const side = i % 2 ? 1 : -1;
      const lat = side * 30;
      const wh = new THREE.Mesh(new THREE.BoxGeometry(14, 8, 20), wallMat);
      wh.applyMatrix4(gm(t, lat, 4, 0, 1));
      wh.castShadow = true; wh.receiveShadow = true;
      city.add(wh);
      colliders.addBox(t, lat, 10.4, 7.4, 8);
    }
    const contColors = [0xa63b32, 0x2f6ea0, 0xb08f2e, 0x3f7f4f, 0x777f88];
    for (let i = 0; i < 26; i++) {
      const t = (318 + rng() * 28) * DEG;
      const lat = (rng() < 0.5 ? -1 : 1) * (11 + rng() * 10);
      // containers are scattered at random lats — keep them off the carriageway
      // and out of the water rather than trusting the range not to overlap
      if (Math.abs(lat - roadLat(t)) < ROAD_HALF + ROAD_SHLDR + 2.5) continue;
      if (Math.abs(lat - riverLat(t)) < riverHalf(t) + 3) continue;
      if (onSpur(t, lat) || inLake(t, lat, 3)) continue;
      const stackH = rng() < 0.18 ? 3 : rng() < 0.5 ? 2 : 1;
      for (let sIdx = 0; sIdx < stackH; sIdx++) {
        const cont = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.5, 6),
          new THREE.MeshStandardMaterial({ color: contColors[Math.floor(rng() * contColors.length)], roughness: 0.6, metalness: 0.4 }));
        cont.applyMatrix4(gm(t, lat, 1.25 + sIdx * 2.5, (rng() - 0.5) * 0.15, 1));
        cont.castShadow = true;
        city.add(cont);
      }
      colliders.addBox(t, lat, 3.4, 1.6, 2.5 * stackH);
    }
  }

  // ════ Spoke plazas + gyroscope panel on Spoke F (300°) ════
  for (const st of SPOKE_THETAS) {
    const pad = new THREE.Mesh(
      drapedDisc(st, 0, 14, 6, 36),
      new THREE.MeshStandardMaterial({
        map: textures.plaza, normalMap: textures.plazaN,
        roughness: 0.9, metalness: 0.02, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      })
    );
    pad.receiveShadow = true;
    city.add(pad);
    colliders.addCylinder(st, 0, 7.2, 200);   // the shaft itself
  }
  {
    const gyroTheta = 300 * DEG;
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 1.6, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x30363e, roughness: 0.4, metalness: 0.6 })
    );
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 1.1),
      new THREE.MeshBasicMaterial({ color: 0xff4444 })
    );
    screen.position.z = 0.21;
    const grp = new THREE.Group();
    grp.add(panel, screen);
    // bolted to the shaft, 17 m up — reachable only when gravity is out
    grp.applyMatrix4(gm(gyroTheta, 6.9, 17, Math.PI, 1));
    city.add(grp);
    stations.gyroPanel = { theta: gyroTheta, lat: 6.9, h: 17, screen };

    // glow ring marker so it reads from the ground
    const ringMark = new THREE.Mesh(
      new THREE.TorusGeometry(1.4, 0.08, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0xff5555, transparent: true, opacity: 0.85 })
    );
    ringMark.applyMatrix4(gm(gyroTheta, 6.9, 17, Math.PI, 1));
    city.add(ringMark);
    stations.gyroRing = ringMark;
  }

  // ════ Downtown blocks: mid-rise cores that make the ring read as a city ════
  {
    const URBAN_ARCS = [
      { from: 352, to: 16 },       // Meridian downtown, around the plaza
      { from: 168.5, to: 191.5 },  // Gamma Terminal town
      { from: 261, to: 285 },      // Observatory quarter
      { from: 40, to: 47 },        // Engineering commercial strip
    ];
    const blockTypes = [
      { arcW: 14, latD: 10, h: 12.6, tex: textures.blockA },
      { arcW: 12, latD: 10, h: 19,   tex: textures.blockB },
      { arcW: 16, latD: 9,  h: 10,   tex: textures.blockC },
    ];
    const blockPlacements = blockTypes.map(() => []);
    const blockMeshes = blockTypes.map(() => null);
    const blockRoofMeshes = blockTypes.map(() => null);
    const blockTints = [0xffffff, 0xf0ece4, 0xe6ebf0, 0xf2e6d8].map(c => new THREE.Color(c));
    const PLAZA_C = 6 * DEG;

    const tryBlock = (theta, lat, ti, yaw) => {
      const t = blockTypes[ti];
      const halfDiag = Math.hypot(t.arcW, t.latD) / 2 + 0.7;   // circle for the overlap check only
      // proper axis-aligned extents of the yaw-rotated footprint (local +Z = arcW
      // along the arc, local +X = latD across lat).
      const rc = Math.abs(Math.cos(yaw)), rs = Math.abs(Math.sin(yaw));
      const hArc = rc * (t.arcW / 2) + rs * (t.latD / 2) + 0.3;
      const hLat = rs * (t.arcW / 2) + rc * (t.latD / 2) + 0.3;
      // Blocks are laid out relative to roadLat(theta), which wanders as far as
      // ∓49 m — so a 42 m offset would otherwise put a tower at |lat| ≈ 90, well
      // past FLOOR_LAT: outside the hull entirely, hanging in the starfield.
      // Slide the site back onto the buildable floor band instead of dropping
      // it, so downtown keeps its density on the narrow side of the road.
      if (Math.abs(lat) + hLat > BUILD_LAT) {
        const inward = Math.sign(lat) * (BUILD_LAT - hLat);
        if (Math.abs(inward) < hLat) return false;   // footprint can't fit at all
        lat = inward;
        // A slid site no longer sits at its designed offset from the road, so
        // the usual road/rail clearance is no longer implied — check it.
        if (Math.abs(lat - railLat(theta)) < RAIL_HALF + 2 + hLat) return false;
      }
      // Across the whole arc extent, not just at the centre — see
      // clearOfCorridors. A 16 m block reaches 8 m either way, and the road
      // wanders enough over that span to end up under one corner of it.
      if (!clearOfCorridors(theta, lat, hArc, hLat)) return false;
      if (nearStationZone(theta, lat, hArc, hLat)) return false;   // keep platforms clear
      if (colliders.resolve(theta * RF, lat, 1, halfDiag)) return false;
      blockPlacements[ti].push({
        theta, lat, yaw: yaw + (rng() - 0.5) * 0.04,
        tint: blockTints[Math.floor(rng() * blockTints.length)],
      });
      // Tagged so the guideway planner can find its way back to the placement
      // and bore a tunnel through this tower instead of clipping its corner.
      colliders.addBox(theta, lat, hArc, hLat, t.h, {
        kind: 'block', ti, i: blockPlacements[ti].length - 1,
      });
      return true;
    };

    // Blocks reflow along the winding road: lat is measured relative to
    // roadLat(theta) and yaw follows roadYawAt so street walls track the curve.
    for (const arc of URBAN_ARCS) {
      for (const theta of arcSteps(arc.from, arc.to, 14)) {
        const rl = roadLat(theta), ry = roadYawAt(theta);
        for (const side of [-1, 1]) {
          if (rng() < 0.12) continue;
          const yaw = (side > 0 ? Math.PI : 0) + ry;
          // keep the plaza square itself open
          const onPlaza = Math.abs(arcDelta(theta, PLAZA_C)) < 55;
          if (!onPlaza) tryBlock(theta, rl + side * (12.5 + rng() * 2.5), Math.floor(rng() * 3), yaw);
          if (rng() < 0.8) tryBlock(theta + (4 + rng() * 5) / RF, rl + side * (25 + rng() * 5), Math.floor(rng() * 3), yaw);
          if (rng() < 0.4) tryBlock(theta + (rng() - 0.5) * 8 / RF, rl + side * (37 + rng() * 5), Math.floor(rng() * 3), yaw);
        }
      }
    }
    // corner stores sprinkled through the residential districts
    for (const d of DISTRICTS.filter(x => x.kind === 'houses')) {
      for (const theta of arcSteps(d.from, d.to, 70)) {
        if (rng() < 0.3) continue;
        const side = rng() < 0.5 ? -1 : 1;
        tryBlock(theta, roadLat(theta) + side * 13.5, 2, (side > 0 ? Math.PI : 0) + roadYawAt(theta));
      }
    }

    const roofClutterMat = new THREE.MeshStandardMaterial({ color: 0x3c4046, roughness: 0.9, metalness: 0.2 });
    blockTypes.forEach((t, ti) => {
      if (!blockPlacements[ti].length) return;
      const wallGeo = new THREE.BoxGeometry(t.latD, t.h, t.arcW);
      wallGeo.translate(0, t.h / 2, 0);
      const wallMat = new THREE.MeshStandardMaterial({
        map: t.tex.map, roughness: 0.85,
        emissiveMap: t.tex.emissive, emissive: 0xffffff, emissiveIntensity: 0.7,
      });
      blockMeshes[ti] = instancedFrom(wallGeo, wallMat, blockPlacements[ti]);
      city.add(blockMeshes[ti]);

      const slab = new THREE.BoxGeometry(t.latD + 0.5, 0.35, t.arcW + 0.5);
      slab.translate(0, t.h + 0.17, 0);
      const ac1 = new THREE.BoxGeometry(1.6, 0.9, 1.2);
      ac1.translate(-t.latD * 0.2, t.h + 0.8, t.arcW * 0.15);
      const ac2 = new THREE.BoxGeometry(1.1, 0.7, 1.0);
      ac2.translate(t.latD * 0.22, t.h + 0.7, -t.arcW * 0.2);
      const ant = new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6);
      ant.translate(t.latD * 0.3, t.h + 1.8, t.arcW * 0.3);
      const roofGeo = mergeGeometries([slab, ac1, ac2, ant]);
      blockRoofMeshes[ti] = instancedFrom(roofGeo, roofClutterMat, blockPlacements[ti]);
      city.add(blockRoofMeshes[ti]);
    });

    // ── Boring a tunnel through a tower ──────────────────────────────────────
    // Called by the guideway planner (transit.js) when the monorail's route
    // cannot be bent around a downtown block. An InstancedMesh cannot have a
    // hole in it, so the one instance in the way is scaled to nothing and
    // rebuilt as four boxes: a jamb either side of the bore, a sill under it
    // and a lintel over it. Their outward faces ARE the tunnel walls — same
    // texture as the rest of the building, so the bore needs no lining.
    //
    // `bore` is given in world terms — { lat, half, y0, y1 }, the guideway's own
    // lat where it crosses and the height band it needs — and resolved here
    // into the block's local frame, which is rotated by its street-facing yaw.
    // Returns the opening, or null if the tower is too small to take the hole
    // and still keep a jamb either side and a lintel over it.
    const _uvFaces = (g, w, h, d, ow, oh, od) => {
      // BoxGeometry lays out 4 verts per face in the order px nx py ny pz nz.
      // Rescale each face's uv so the window grid keeps the density it had on
      // the whole box — the offset does not matter, the texture tiles.
      const f = [[d / od, h / oh], [d / od, h / oh], [w / ow, d / od],
        [w / ow, d / od], [w / ow, h / oh], [w / ow, h / oh]];
      const uv = g.attributes.uv;
      for (let face = 0; face < 6; face++) {
        for (let k = 0; k < 4; k++) {
          const i = face * 4 + k;
          uv.setXY(i, uv.getX(i) * f[face][0], uv.getY(i) * f[face][1]);
        }
      }
      return g;
    };
    // Dry run of the geometry test: does this tower have room for the hole and
    // still keep a jamb either side and a lintel over it? The planner asks
    // before it commits to a tunnel, so a tower that cannot take one falls back
    // to being curved around or hopped instead of being deleted.
    boreFits = function (tag, bore) {
      const t = blockTypes[tag.ti], p = blockPlacements[tag.ti] && blockPlacements[tag.ti][tag.i];
      if (!t || !p || p.pierced) return null;
      const L = t.latD / 2;
      // local +X runs along lat turned by the block's yaw; at the block's own
      // theta the arc component is zero, so this is the whole of the offset
      const want = (bore.lat - p.lat) * Math.cos(p.yaw);
      const maxOff = L - 0.8 - bore.half;                    // keep a jamb either side
      if (maxOff < 0) return null;                           // too shallow for a hole
      const cx = Math.max(-maxOff, Math.min(maxOff, want));
      // The bore may be nudged off the line to keep its jambs, but only as far
      // as the deck still fits inside it.
      if (Math.abs(cx - want) > bore.half - (bore.deckHalf || 1.9)) return null;
      if (bore.y1 > t.h - 0.8 || bore.y0 < 0.6) return null; // no lintel / no sill
      return { t, p, cx, x0: cx - bore.half, x1: cx + bore.half };
    };
    pierceBlock = function (tag, bore) {
      const fit = boreFits(tag, bore);
      if (!fit) return null;
      const { t, p, cx, x0, x1 } = fit;
      const L = t.latD / 2;
      const mk = (w, h, d, x, y, z) =>
        _uvFaces(new THREE.BoxGeometry(w, h, d), w, h, d, t.latD, t.h, t.arcW)
          .translate(x, y, z);
      const parts = [
        mk(x0 + L, t.h, t.arcW, (x0 - L) / 2, t.h / 2, 0),                       // jamb, −X side
        mk(L - x1, t.h, t.arcW, (x1 + L) / 2, t.h / 2, 0),                       // jamb, +X side
        mk(bore.half * 2, bore.y0, t.arcW, cx, bore.y0 / 2, 0),                  // sill
        mk(bore.half * 2, t.h - bore.y1, t.arcW, cx, (bore.y1 + t.h) / 2, 0),     // lintel
      ];
      const mat = blockMeshes[tag.ti].material.clone();
      if (p.tint) mat.color.copy(p.tint);
      const mesh = new THREE.Mesh(mergeGeometries(parts), mat);
      mesh.applyMatrix4(gm(p.theta, p.lat, 0, p.yaw, 1));
      mesh.castShadow = true; mesh.receiveShadow = true;
      city.add(mesh);
      // retire the solid instance
      _cityM.makeScale(0, 0, 0);
      blockMeshes[tag.ti].setMatrixAt(tag.i, _cityM);
      blockMeshes[tag.ti].instanceMatrix.needsUpdate = true;
      p.pierced = true;
      return {
        half: bore.half, y0: bore.y0, y1: bore.y1,
        arcHalf: t.arcW / 2, theta: p.theta, lat: p.lat, yaw: p.yaw,
      };
    };
    hideBlock = function (tag) {
      const p = blockPlacements[tag.ti][tag.i];
      if (!p || p.pierced) return false;
      _cityM.makeScale(0, 0, 0);
      for (const m of [blockMeshes[tag.ti], blockRoofMeshes[tag.ti]]) {
        if (!m) continue;
        m.setMatrixAt(tag.i, _cityM);
        m.instanceMatrix.needsUpdate = true;
      }
      p.pierced = true;
      return true;
    };
  }

  // ════ Benches: plazas + all along the ring road ════
  {
    const benchPlacements = [];
    for (const st of [...SPOKE_THETAS, 5 * DEG, 7 * DEG]) {
      for (let i = 0; i < 4; i++) {
        benchPlacements.push({
          theta: st + (rng() - 0.5) * (26 / RF),
          lat: (rng() < 0.5 ? -1 : 1) * (9 + rng() * 4),
          yaw: rng() * Math.PI * 2,
        });
      }
    }
    for (const theta of arcSteps(0, 360, 52)) {
      if (rng() < 0.35) continue;
      const side = rng() < 0.5 ? -1 : 1;
      benchPlacements.push({
        theta,
        lat: roadLat(theta) + side * (9.2 + rng() * 1.5),   // roadside
        // seat faces the road: +Z toward -lat side is -PI/2, add road tangent
        yaw: (side > 0 ? Math.PI / 2 : -Math.PI / 2) + roadYawAt(theta) + (rng() - 0.5) * 0.15,
      });
    }
    const seat = new THREE.BoxGeometry(0.5, 0.07, 1.75);
    seat.translate(0, 0.45, 0);
    const back = new THREE.BoxGeometry(0.06, 0.5, 1.75);
    back.rotateZ(-0.15);
    back.translate(-0.26, 0.72, 0);
    const legA = new THREE.BoxGeometry(0.45, 0.42, 0.08);
    legA.translate(0, 0.21, 0.72);
    const legB = legA.clone();
    legB.translate(0, 0, -1.44);
    const benchGeo = mergeGeometries([seat, back, legA, legB]);
    const benchMat = new THREE.MeshStandardMaterial({ color: 0xa58860, roughness: 0.9 });
    city.add(instancedFrom(benchGeo, benchMat, benchPlacements));
  }

  return {
    group: city, stations,
    pierceBlock: (tag, bore) => pierceBlock(tag, bore),
    boreFits: (tag, bore) => boreFits(tag, bore),
    // Clear a site the guideway cannot get past: towers and homes alike.
    clearSite: (tag) => {
      if (!tag) return false;
      if (tag.kind === 'block') return hideBlock(tag);
      if (tag.kind === 'house') return hideHouse(tag);
      return false;
    },
  };
}

// Small angled-screen terminal kiosk; screen faces the road side.
// yaw -PI/2 makes local +Z point toward +lat, +PI/2 toward -lat.
function makeTerminal(parent, theta, lat, h, screenColor, colliders = null) {
  const g = new THREE.Group();
  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.3, 1.1, 10),
    new THREE.MeshStandardMaterial({ color: 0x59626e, roughness: 0.4, metalness: 0.6 })
  );
  pedestal.position.y = 0.55;
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.65, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x39414c, roughness: 0.4, metalness: 0.5 })
  );
  head.position.y = 1.35;
  head.rotation.x = -0.5;
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.78, 0.52),
    new THREE.MeshBasicMaterial({ color: screenColor })
  );
  screen.position.set(0, 1.38, 0.075);
  screen.rotation.x = -0.5;
  g.add(pedestal, head, screen);
  const yaw = lat > 0 ? Math.PI / 2 : -Math.PI / 2;   // face the road at lat 0
  g.applyMatrix4(gm(theta, lat, h ?? 0, yaw, 1));
  g.traverse(o => { o.castShadow = true; });
  parent.add(g);
  if (colliders) colliders.addCylinder(theta, lat, 1.1, 2);
  return { theta, lat, screen, group: g };
}
