// ── The torus shell: floor band, curved hull, glass ceiling, ribs, spokes ───

const RING_SEGS = 768;

// Sweep a 2D cross-section profile (in the tube plane) around the ring.
// Profile points are given as [lat, h] pairs (h above the floor, may be
// negative-free). Returns a BufferGeometry with UVs (u around ring, v along
// profile arc length).
function sweepProfile(profile, { uScale = 1, vScale = 1, thetaFrom = 0, thetaTo = Math.PI * 2, segs = RING_SEGS } = {}) {
  const nP = profile.length;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const p = new THREE.Vector3();

  // arc-length along profile for v coordinate
  const arc = [0];
  for (let i = 1; i < nP; i++) {
    const d = Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]);
    arc.push(arc[i - 1] + d);
  }

  for (let s = 0; s <= segs; s++) {
    const theta = thetaFrom + (thetaTo - thetaFrom) * (s / segs);
    const c = Math.cos(theta), sn = Math.sin(theta);
    for (let i = 0; i < nP; i++) {
      const [lat, h] = profile[i];
      torusPosition(theta, lat, h, p);
      positions.push(p.x, p.y, p.z);
      // Profile normal: perpendicular to profile tangent, pointing inward
      const iPrev = Math.max(0, i - 1), iNext = Math.min(nP - 1, i + 1);
      const dLat = profile[iNext][0] - profile[iPrev][0];
      const dH = profile[iNext][1] - profile[iPrev][1];
      const len = Math.hypot(dLat, dH) || 1;
      // 2D tangent (dLat, dH) → normal (-dH, dLat) in (lat, h) plane.
      const nLat = -dH / len, nH = dLat / len;
      // h direction in world = up = (-c, 0, -sn); lat direction = (0,1,0)
      normals.push(-c * nH, nLat, -sn * nH);
      uvs.push(theta * RF * uScale, arc[i] * vScale);
    }
  }
  for (let s = 0; s < segs; s++) {
    for (let i = 0; i < nP - 1; i++) {
      const a = s * nP + i, b = a + nP;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

// Points along the tube circle from angle a to b (angles measured from the
// tube-bottom, i.e. pointing at the floor). Returns [lat, h] pairs.
function tubeArc(a, b, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = a + (b - a) * (i / steps);
    const lat = RT * Math.sin(t);
    // tube center sits CHORD_DROP above... floor is at distance CHORD_DROP
    // below tube center; a point at tube angle t has height:
    const h = CHORD_DROP - RT * Math.cos(t);
    pts.push([lat, h]);
  }
  return pts;
}

function buildWorld(scene, textures) {
  const world = new THREE.Group();
  scene.add(world);

  const floorEdge = Math.asin(HALF_W / RT);      // tube angle where floor meets hull
  const glassHalf = 38 * DEG;                    // window band: top ±38°

  // ── Floor ──
  const floorProfile = [];
  for (let i = 0; i <= 10; i++) floorProfile.push([-HALF_W + (2 * HALF_W) * (i / 10), 0]);
  const floor = new THREE.Mesh(
    sweepProfile(floorProfile, { uScale: 1 / 8, vScale: 1 / 8 }),
    new THREE.MeshStandardMaterial({ map: textures.grass, roughness: 1.0, metalness: 0, side: THREE.DoubleSide })
  );
  floor.receiveShadow = true;
  world.add(floor);

  // ── Fully glazed hull: every wall from floor edge to floor edge is glass ──
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x9fd4ee, transparent: true, opacity: 0.16, roughness: 0.08,
    metalness: 0.1, side: THREE.DoubleSide, depthWrite: false,
  });
  const hullA = new THREE.Mesh(
    sweepProfile(tubeArc(floorEdge, Math.PI - glassHalf, 20), { uScale: 1 / 24, vScale: 1 / 24 }),
    glassMat
  );
  const hullB = new THREE.Mesh(
    // reversed arc direction so computed normals face the interior
    sweepProfile(tubeArc(-(Math.PI - glassHalf), -floorEdge, 20), { uScale: 1 / 24, vScale: 1 / 24 }),
    glassMat
  );
  const glass = new THREE.Mesh(
    sweepProfile(tubeArc(Math.PI - glassHalf, Math.PI + glassHalf, 16), { uScale: 1 / 24, vScale: 1 / 24 }),
    glassMat
  );
  world.add(hullA, hullB, glass);

  // ── Structural ribs: thin torus hoops every ~46 m ──
  const ribMat = new THREE.MeshStandardMaterial({ color: 0x7d838d, roughness: 0.5, metalness: 0.6 });
  const ribGeo = new THREE.TorusGeometry(RT - 0.6, 0.85, 6, 64);
  const ribCount = 128;
  const ribs = new THREE.InstancedMesh(ribGeo, ribMat, ribCount);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  const euler = new THREE.Euler();
  for (let i = 0; i < ribCount; i++) {
    const theta = (i / ribCount) * Math.PI * 2;
    // rib circle lies in the tube cross-section plane at this theta:
    // plane spanned by (radial, Y). Torus geometry lies in XY plane by
    // default; orient its plane to contain world-Y and the radial dir.
    torusPosition(theta, 0, CHORD_DROP, p);   // tube center
    euler.set(0, -theta, 0);                  // torus plane spans radial + Y
    q.setFromEuler(euler);
    m.compose(p, q, s);
    ribs.setMatrixAt(i, m);
  }
  world.add(ribs);

  // ── Longitudinal glazing stringers: frame rings across the whole arc ──
  const stringerMat = ribMat;
  const stringerTs = [];
  for (let t = floorEdge + 0.18; t < Math.PI - 0.06; t += 0.27) stringerTs.push(t, -t);
  stringerTs.push(Math.PI);   // ridge beam at the apex
  for (const t of stringerTs) {
    const lat = RT * Math.sin(t);
    const h = CHORD_DROP - RT * Math.cos(t);
    const heavy = Math.abs(Math.abs(t) - (Math.PI - glassHalf)) < 0.14 || t === Math.PI;
    const ringGeo = new THREE.TorusGeometry(RF - h, heavy ? 1.0 : 0.5, 6, 256);
    const stringer = new THREE.Mesh(ringGeo, stringerMat);
    stringer.rotation.x = Math.PI / 2;
    stringer.position.y = lat;
    world.add(stringer);
  }

  // ── Spokes: shafts descending from the ceiling apex to floor level ──
  const spokeTex = textures.hull.clone();
  spokeTex.repeat.set(3, 26);
  const spokeMat = new THREE.MeshStandardMaterial({
    map: spokeTex, color: 0xd7dde4, roughness: 0.45, metalness: 0.35,
  });
  const spokeGroup = new THREE.Group();
  const apexH = CHORD_DROP + RT;                 // ceiling apex height above floor
  for (const theta of SPOKE_THETAS) {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 6.5, apexH + 40, 16), spokeMat);
    // A cylinder's axis is its local Y; placementMatrix aligns local Y to
    // torus-up, so it stands from floor toward the hub.
    shaft.applyMatrix4(placementMatrix(theta, 0, (apexH + 40) / 2 - 2, 0, 1));
    shaft.castShadow = true;
    spokeGroup.add(shaft);

    // strut collar at the base
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 10.5, 6, 16), spokeMat);
    collar.applyMatrix4(placementMatrix(theta, 0, 3, 0, 1));
    spokeGroup.add(collar);

    // diagonal guy-struts
    for (let k = 0; k < 4; k++) {
      const ang = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 34, 8), spokeMat);
      strut.position.set(Math.cos(ang) * 9, 14, Math.sin(ang) * 9);
      strut.lookAt(new THREE.Vector3(Math.cos(ang) * 2, 30, Math.sin(ang) * 2));
      strut.rotateX(Math.PI / 2);
      const g = new THREE.Group();
      g.add(strut);
      g.applyMatrix4(placementMatrix(theta, 0, 0, 0, 1));
      spokeGroup.add(g);
    }
  }
  world.add(spokeGroup);

  // ── Central hub (visible through the ceiling glass) ──
  const hub = new THREE.Group();
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xaab0b8, roughness: 0.5, metalness: 0.5 });
  const hubCore = new THREE.Mesh(new THREE.CylinderGeometry(60, 60, 220, 24), hubMat);
  hub.add(hubCore);
  const hubRing = new THREE.Mesh(new THREE.TorusGeometry(120, 14, 10, 48), hubMat);
  hubRing.rotation.x = Math.PI / 2;
  hub.add(hubRing);
  // spoke tubes from hub outward to the ring
  for (const theta of SPOKE_THETAS) {
    const len = RMAJ - RT - 30;
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, len, 12), hubMat);
    tube.rotation.z = Math.PI / 2;
    const g = new THREE.Group();
    g.add(tube);
    tube.position.x = len / 2 + 90;
    g.rotation.y = -theta;
    hub.add(g);
  }
  world.add(hub);

  // ── Ring road: a slightly raised asphalt band around the whole ring ──
  const roadProfile = [];
  const ROAD_HALF = 4.5, ROAD_LAT = 0;
  for (let i = 0; i <= 4; i++) roadProfile.push([ROAD_LAT - ROAD_HALF + (2 * ROAD_HALF) * (i / 4), 0.06]);
  const road = new THREE.Mesh(
    sweepProfile(roadProfile, { uScale: 1 / 3, vScale: 1 / 3 }),
    new THREE.MeshStandardMaterial({ map: textures.asphalt, roughness: 0.95, metalness: 0, side: THREE.DoubleSide })
  );
  road.receiveShadow = true;
  world.add(road);

  // Low-frequency color mottle floating just above the grass — breaks the
  // texture tiling when looking down the length of the ring.
  {
    const mottleProfile = [];
    for (let i = 0; i <= 6; i++) mottleProfile.push([-HALF_W + (2 * HALF_W) * (i / 6), 0.02]);
    const mottle = new THREE.Mesh(
      sweepProfile(mottleProfile, { uScale: 1 / 210, vScale: 1 / 105 }),
      new THREE.MeshStandardMaterial({
        map: textures.mottle, transparent: true, depthWrite: false,
        roughness: 1, side: THREE.DoubleSide,
      })
    );
    mottle.receiveShadow = true;
    world.add(mottle);
  }

  // Wispy interior clouds hugging the "sky" of the ring
  {
    const puff = (x, y, z, r, sy) => {
      const g = new THREE.SphereGeometry(r, 10, 7);
      g.scale(1, sy, 1); g.translate(x, y, z);
      return g;
    };
    const cloudGeo = mergeGeometries([
      puff(0, 0, 0, 6, 0.42), puff(4.6, 0.5, 1.2, 4.2, 0.4), puff(-4.4, 0.3, -1, 4.6, 0.38),
      puff(1.5, 0.9, -2.2, 3.4, 0.42),
    ]);
    const cloudMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, transparent: true, opacity: 0.4, roughness: 1,
      depthWrite: false,
    });
    const rng = mulberry32(4242);
    const N = 90;
    const clouds = new THREE.InstancedMesh(cloudGeo, cloudMat, N);
    const cm = new THREE.Matrix4();
    for (let i = 0; i < N; i++) {
      placementMatrix(
        rng() * Math.PI * 2,
        (rng() - 0.5) * 64,
        56 + rng() * 22,
        rng() * Math.PI * 2,
        0.9 + rng() * 1.6,
        cm
      );
      clouds.setMatrixAt(i, cm);
    }
    clouds.castShadow = false;
    world.add(clouds);
  }

  // Side walking paths
  for (const latC of [-14, 14]) {
    const pp = [];
    for (let i = 0; i <= 2; i++) pp.push([latC - 1.5 + 3 * (i / 2), 0.05]);
    const path = new THREE.Mesh(
      sweepProfile(pp, { uScale: 1 / 2, vScale: 1 / 2 }),
      new THREE.MeshStandardMaterial({ map: textures.dirt, roughness: 1, side: THREE.DoubleSide })
    );
    path.receiveShadow = true;
    world.add(path);
  }

  return { group: world, sweepProfile, tubeArc };
}

