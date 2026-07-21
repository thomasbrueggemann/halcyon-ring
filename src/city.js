// ── The ring city: buildings, districts, puzzle stations, street furniture ──

const _cityM = new THREE.Matrix4();

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

function instancedFrom(geo, mat, placements, { shadow = true } = {}) {
  const mesh = new THREE.InstancedMesh(geo, mat, placements.length);
  placements.forEach((pl, i) => {
    placementMatrix(pl.theta, pl.lat, pl.h ?? 0, pl.yaw ?? 0, pl.scale ?? 1, _cityM);
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

  // ════ Houses ════
  const archetypes = [
    { latD: 8, arcW: 10, wallH: 3.3, roofH: 2.3, wall: textures.wallA, wallE: textures.wallAE, roof: textures.roof },
    { latD: 9, arcW: 9,  wallH: 6.4, roofH: 1.9, wall: textures.wallB, wallE: textures.wallBE, roof: textures.roofSlate },
    { latD: 8, arcW: 12, wallH: 3.9, roofH: 2.7, wall: textures.wallC, wallE: textures.wallCE, roof: textures.roof },
  ];
  const housePlacements = archetypes.map(() => []);
  const tintPool = [0xffffff, 0xf2e8da, 0xe8eef2, 0xf5e9dc, 0xeae2f0].map(c => new THREE.Color(c));

  const hedgePlacements = [];
  const placeHouse = (theta, side, latBase) => {
    const a = Math.floor(rng() * archetypes.length);
    const arch = archetypes[a];
    const lat = side * latBase;
    const yaw = (side > 0 ? Math.PI : 0) + (rng() - 0.5) * 0.1;
    housePlacements[a].push({ theta, lat, yaw, tint: tintPool[Math.floor(rng() * tintPool.length)] });
    colliders.addBox(theta, lat, arch.arcW / 2 + 0.4, arch.latD / 2 + 0.4, arch.wallH + arch.roofH);
    // garden hedges flanking the front door
    if (rng() < 0.75) {
      const front = lat - side * (arch.latD / 2 + 1.1);
      for (const off of [-arch.arcW * 0.32, arch.arcW * 0.32]) {
        hedgePlacements.push({
          theta: theta + off / RF, lat: front, yaw: (rng() - 0.5) * 0.2,
          scale: 0.8 + rng() * 0.5,
        });
      }
    }
  };

  for (const d of DISTRICTS.filter(d => d.kind === 'houses')) {
    for (const theta of arcSteps(d.from, d.to, 17)) {
      for (const side of [-1, 1]) {
        if (rng() < 0.12) continue;
        placeHouse(theta, side, 20 + rng() * 14);
        // second row further from the road
        if (rng() < 0.55) placeHouse(theta + (8 + rng() * 5) / RF, side, 38 + rng() * 6);
      }
    }
  }
  archetypes.forEach((arch, i) => {
    const wallGeo = new THREE.BoxGeometry(arch.latD, arch.wallH, arch.arcW);
    wallGeo.translate(0, arch.wallH / 2, 0);
    const wallMat = new THREE.MeshStandardMaterial({
      map: arch.wall, roughness: 0.9,
      emissiveMap: arch.wallE, emissive: 0xffffff, emissiveIntensity: 0.55,
    });
    city.add(instancedFrom(wallGeo, wallMat, housePlacements[i]));
    const roofGeo = gableRoofGeometry(arch.latD, arch.arcW, arch.roofH, arch.wallH, true);
    const roofMat = new THREE.MeshStandardMaterial({ map: arch.roof, roughness: 0.85 });
    city.add(instancedFrom(roofGeo, roofMat, housePlacements[i]));
  });
  {
    const hedgeGeo = new THREE.BoxGeometry(0.75, 0.95, 2.3);
    hedgeGeo.translate(0, 0.47, 0);
    const hedgeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
    const hc = new THREE.Color();
    const hedges = instancedFrom(hedgeGeo, hedgeMat, hedgePlacements.map(p => ({
      ...p, tint: hc.setHSL(0.27 + rng() * 0.06, 0.5, 0.24 + rng() * 0.1).clone(),
    })));
    city.add(hedges);
  }

  // ════ Street lights ════
  const lightPlacements = [];
  let flip = 1;
  for (const theta of arcSteps(0, 360, 23)) {
    flip = -flip;
    lightPlacements.push({ theta, lat: flip * 7 });
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
    const plazaPatch = [];
    for (let i = 0; i <= 8; i++) plazaPatch.push([-40 + 80 * (i / 8), 0.055]);
    const plaza = new THREE.Mesh(
      sweepProfile(plazaPatch, {
        uScale: 1 / 6, vScale: 1 / 6,
        thetaFrom: PLAZA - 45 / RF, thetaTo: PLAZA + 45 / RF, segs: 20,
      }),
      new THREE.MeshStandardMaterial({ map: textures.plaza, roughness: 0.9, side: THREE.DoubleSide })
    );
    plaza.receiveShadow = true;
    city.add(plaza);

    // Fountain
    const basin = new THREE.Mesh(
      new THREE.TorusGeometry(4.2, 0.55, 10, 28),
      new THREE.MeshStandardMaterial({ color: 0x9a938a, roughness: 0.8 })
    );
    basin.geometry.rotateX(Math.PI / 2);
    basin.applyMatrix4(placementMatrix(PLAZA, 0, 0.5, 0, 1));
    basin.castShadow = true;
    city.add(basin);
    const pool = new THREE.Mesh(
      new THREE.CylinderGeometry(4.1, 4.1, 0.35, 24),
      new THREE.MeshStandardMaterial({ map: textures.water, roughness: 0.15, transparent: true, opacity: 0.9 })
    );
    pool.applyMatrix4(placementMatrix(PLAZA, 0, 0.45, 0, 1));
    city.add(pool);
    const jet = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 3.2, 12),
      new THREE.MeshStandardMaterial({ color: 0xcfe8ee, transparent: true, opacity: 0.55, roughness: 0.1 })
    );
    jet.applyMatrix4(placementMatrix(PLAZA, 0, 2.0, 0, 1));
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
    hall.applyMatrix4(placementMatrix(8.2 * DEG, -34, 4.5, 0, 1));
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
      planter.applyMatrix4(placementMatrix(pTheta, pLat, 0.05, 0, 1));
      planter.traverse(o => { o.castShadow = true; });
      city.add(planter);
    }
  }

  // ════ Engineering Bay — coolant valve puzzle ════
  {
    const thetaP = 48 * DEG;
    const wallMat = new THREE.MeshStandardMaterial({ map: textures.hull.clone(), roughness: 0.5, metalness: 0.4 });
    wallMat.map.repeat.set(3, 1.5);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.7, 4.2, 10), wallMat);
    panel.applyMatrix4(placementMatrix(thetaP, -18, 2.1, 0, 1));
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
      grp.applyMatrix4(placementMatrix(vTheta, -17.55, 1.45, -Math.PI / 2, 1));
      city.add(grp);
      stations.valves.push({ mesh: grp, wheel, theta: vTheta, lat: -17.2, h: 1.45, index: i });

      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0x000000, emissiveIntensity: 2.4 })
      );
      lamp.applyMatrix4(placementMatrix(vTheta, -17.6, 3.1, 0, 1));
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
      tank.applyMatrix4(placementMatrix(t, -36, 2.6, 0, 1));
      tank.castShadow = true;
      city.add(tank);
      colliders.addCylinder(t, -36, 3.2, 5.5);
    }
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x8a6f2f, roughness: 0.5, metalness: 0.8 });
    for (let i = 0; i < 2; i++) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 22, 10), pipeMat);
      pipe.rotation.z = Math.PI / 2;
      const g = new THREE.Group(); g.add(pipe);
      g.applyMatrix4(placementMatrix((45.5 + i) * DEG, -27, 0.5 + i * 0.8, 0, 1));
      city.add(g);
    }
  }

  // ════ Agricultural Belt — greenhouse, barn, silo, fuse hunt ════
  {
    // crop strips
    for (const d of [DISTRICTS.find(x => x.kind === 'farm')]) {
      const cropTints = [0xffffff, 0xd9ecb0, 0xe8d9a0, 0xc9e0c0, 0xf0e6c8];
      for (let band = 0; band < 4; band++) {
        const lat0 = [-44, -30, 18, 34][band];
        for (const theta of arcSteps(d.from + 2, d.to - 2, 80)) {
          if (rng() < 0.1) continue;
          const patch = [];
          for (let i = 0; i <= 3; i++) patch.push([lat0 + 12 * (i / 3), 0.04]);
          const strip = new THREE.Mesh(
            sweepProfile(patch, {
              uScale: 1 / 4, vScale: 1 / 4,
              thetaFrom: theta - 34 / RF, thetaTo: theta + 34 / RF, segs: 12,
            }),
            new THREE.MeshStandardMaterial({
              map: textures.crops, roughness: 1, side: THREE.DoubleSide,
              color: cropTints[Math.floor(rng() * cropTints.length)],
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
      const lat = i % 2 ? 26 : -24;
      const g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(7, 0.4, 14), frameMat);
      base.position.y = 0.2;
      const glassBox = new THREE.Mesh(new THREE.BoxGeometry(6.8, 3.0, 13.8), glassMat);
      glassBox.position.y = 1.9;
      const ridge = new THREE.Mesh(gableRoofGeometry(6.8, 13.8, 1.4, 0), glassMat);
      ridge.position.y = 3.4;
      g.add(base, glassBox, ridge);
      g.applyMatrix4(placementMatrix(t, lat, 0, 0, 1));
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
    barn.applyMatrix4(placementMatrix(122 * DEG, 34, 0, 0, 1));
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
    silo.applyMatrix4(placementMatrix(124.5 * DEG, 40, 0, 0, 1));
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
    relay.applyMatrix4(placementMatrix(104 * DEG, -9, 0, 0, 1));
    relay.traverse(o => { o.castShadow = true; });
    city.add(relay);
    colliders.addBox(104 * DEG, -9, 1.1, 0.8, 2.2);
    stations.relay = { theta: 104 * DEG, lat: -9 };

    // Fuse cells + locator beacons
    stations.fuses = [];
    const fuseSpots = [
      { theta: 96 * DEG, lat: 24.5, h: 1.15 },     // on the crate stack
      { theta: 113.4 * DEG, lat: -19.4, h: 0.35 }, // beside the third greenhouse
      { theta: 124.8 * DEG, lat: 36.5, h: 0.4 },   // at the silo
    ];
    for (const spot of fuseSpots) {
      const fuse = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.16, 0.55, 12),
        new THREE.MeshStandardMaterial({
          color: 0x9ff2ff, emissive: 0x35c8e8, emissiveIntensity: 2.2, roughness: 0.3,
        })
      );
      fuse.applyMatrix4(placementMatrix(spot.theta, spot.lat, spot.h, 0, 1));
      city.add(fuse);
      const beacon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.7, 0.7, 70, 10, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x51d8f0, transparent: true, opacity: 0.14,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false,
        })
      );
      beacon.applyMatrix4(placementMatrix(spot.theta, spot.lat, 35, 0, 1));
      city.add(beacon);
      stations.fuses.push({ ...spot, mesh: fuse, beacon, taken: false });
    }
    // crate stack under the first fuse
    const crateMat = new THREE.MeshStandardMaterial({ map: textures.dirt.clone(), color: 0xb59a6a, roughness: 0.9 });
    crateMat.map.repeat.set(1, 1);
    for (const [dx, dz, dy] of [[0, 0, 0.45], [0, 1.1, 0.45], [0, 0.5, 1.0 - 0.55 + 0.45]]) {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), crateMat);
      crate.applyMatrix4(placementMatrix(96 * DEG + dz / RF, 24.5 + dx, dy, rng(), 1));
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
      stall.applyMatrix4(placementMatrix(t, lat, 0, side > 0 ? Math.PI : 0, 1));
      stall.traverse(o => { o.castShadow = true; });
      city.add(stall);
      colliders.addBox(t, lat, 1.9, 1.4, 1.4);
    }
    // Spoke alignment console next to the Gamma spoke shaft
    stations.alignConsole = makeTerminal(city, 180 * DEG + 9 / RF, 8.5, 0.05, 0xffb454, colliders);
  }

  // ════ Reservoir Flats — water + coded water tower ════
  {
    const patch = [];
    for (let i = 0; i <= 6; i++) patch.push([16 + 32 * (i / 6), 0.03]);
    const water = new THREE.Mesh(
      sweepProfile(patch, {
        uScale: 1 / 10, vScale: 1 / 10,
        thetaFrom: 234 * DEG, thetaTo: 252 * DEG, segs: 60,
      }),
      new THREE.MeshStandardMaterial({
        map: textures.water, roughness: 0.12, metalness: 0.1,
        transparent: true, opacity: 0.92, side: THREE.DoubleSide,
      })
    );
    city.add(water);
    stations.waterMat = water.material;

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
    tower.applyMatrix4(placementMatrix(towerTheta, towerLat, 0, 0, 1));
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
    sign.applyMatrix4(placementMatrix(towerTheta, towerLat + 5.15, 21, -Math.PI / 2, 1));
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
    obs.applyMatrix4(placementMatrix(obsTheta, obsLat, 0, 0, 1));
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
      wh.applyMatrix4(placementMatrix(t, lat, 4, 0, 1));
      wh.castShadow = true; wh.receiveShadow = true;
      city.add(wh);
      colliders.addBox(t, lat, 10.4, 7.4, 8);
    }
    const contColors = [0xa63b32, 0x2f6ea0, 0xb08f2e, 0x3f7f4f, 0x777f88];
    for (let i = 0; i < 26; i++) {
      const t = (318 + rng() * 28) * DEG;
      const lat = (rng() < 0.5 ? -1 : 1) * (11 + rng() * 10);
      const stackH = rng() < 0.18 ? 3 : rng() < 0.5 ? 2 : 1;
      for (let sIdx = 0; sIdx < stackH; sIdx++) {
        const cont = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.5, 6),
          new THREE.MeshStandardMaterial({ color: contColors[Math.floor(rng() * contColors.length)], roughness: 0.6, metalness: 0.4 }));
        cont.applyMatrix4(placementMatrix(t, lat, 1.25 + sIdx * 2.5, (rng() - 0.5) * 0.15, 1));
        cont.castShadow = true;
        city.add(cont);
      }
      colliders.addBox(t, lat, 3.4, 1.6, 2.5 * stackH);
    }
  }

  // ════ Spoke plazas + gyroscope panel on Spoke F (300°) ════
  for (const st of SPOKE_THETAS) {
    const patch = [];
    for (let i = 0; i <= 4; i++) patch.push([-14 + 28 * (i / 4), 0.05]);
    const pad = new THREE.Mesh(
      sweepProfile(patch, {
        uScale: 1 / 6, vScale: 1 / 6,
        thetaFrom: st - 14 / RF, thetaTo: st + 14 / RF, segs: 8,
      }),
      new THREE.MeshStandardMaterial({ map: textures.plaza, roughness: 0.9, side: THREE.DoubleSide })
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
    grp.applyMatrix4(placementMatrix(gyroTheta, 6.9, 17, Math.PI, 1));
    city.add(grp);
    stations.gyroPanel = { theta: gyroTheta, lat: 6.9, h: 17, screen };

    // glow ring marker so it reads from the ground
    const ringMark = new THREE.Mesh(
      new THREE.TorusGeometry(1.4, 0.08, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0xff5555, transparent: true, opacity: 0.85 })
    );
    ringMark.applyMatrix4(placementMatrix(gyroTheta, 6.9, 17, Math.PI, 1));
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
    const blockTints = [0xffffff, 0xf0ece4, 0xe6ebf0, 0xf2e6d8].map(c => new THREE.Color(c));
    const PLAZA_C = 6 * DEG;

    const tryBlock = (theta, lat, ti, yaw) => {
      const t = blockTypes[ti];
      const halfDiag = Math.hypot(t.arcW, t.latD) / 2 + 0.7;
      if (colliders.resolve(theta * RF, lat, 1, halfDiag)) return false;
      blockPlacements[ti].push({
        theta, lat, yaw: yaw + (rng() - 0.5) * 0.04,
        tint: blockTints[Math.floor(rng() * blockTints.length)],
      });
      colliders.addBox(theta, lat, t.arcW / 2 + 0.3, t.latD / 2 + 0.3, t.h);
      return true;
    };

    for (const arc of URBAN_ARCS) {
      for (const theta of arcSteps(arc.from, arc.to, 18)) {
        for (const side of [-1, 1]) {
          if (rng() < 0.12) continue;
          const yaw = side > 0 ? Math.PI : 0;
          // keep the plaza square itself open
          const onPlaza = Math.abs(arcDelta(theta, PLAZA_C)) < 55;
          if (!onPlaza) tryBlock(theta, side * (15.2 + rng() * 1.8), Math.floor(rng() * 3), yaw);
          if (rng() < 0.75) tryBlock(theta + (5 + rng() * 6) / RF, side * (28.5 + rng() * 4), Math.floor(rng() * 3), yaw);
        }
      }
    }
    // corner stores sprinkled through the residential districts
    for (const d of DISTRICTS.filter(x => x.kind === 'houses')) {
      for (const theta of arcSteps(d.from, d.to, 85)) {
        if (rng() < 0.35) continue;
        const side = rng() < 0.5 ? -1 : 1;
        tryBlock(theta, side * 14.2, 2, side > 0 ? Math.PI : 0);
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
      city.add(instancedFrom(wallGeo, wallMat, blockPlacements[ti]));

      const slab = new THREE.BoxGeometry(t.latD + 0.5, 0.35, t.arcW + 0.5);
      slab.translate(0, t.h + 0.17, 0);
      const ac1 = new THREE.BoxGeometry(1.6, 0.9, 1.2);
      ac1.translate(-t.latD * 0.2, t.h + 0.8, t.arcW * 0.15);
      const ac2 = new THREE.BoxGeometry(1.1, 0.7, 1.0);
      ac2.translate(t.latD * 0.22, t.h + 0.7, -t.arcW * 0.2);
      const ant = new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6);
      ant.translate(t.latD * 0.3, t.h + 1.8, t.arcW * 0.3);
      const roofGeo = mergeGeometries([slab, ac1, ac2, ant]);
      city.add(instancedFrom(roofGeo, roofClutterMat, blockPlacements[ti]));
    });
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
      benchPlacements.push({
        theta,
        lat: (rng() < 0.5 ? -1 : 1) * (9.2 + rng() * 1.5),
        yaw: (rng() < 0.5 ? 0 : Math.PI) + (rng() - 0.5) * 0.2,
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

  return { group: city, stations };
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
  g.applyMatrix4(placementMatrix(theta, lat, h ?? 0, yaw, 1));
  g.traverse(o => { o.castShadow = true; });
  parent.add(g);
  if (colliders) colliders.addCylinder(theta, lat, 1.1, 2);
  return { theta, lat, screen, group: g };
}
