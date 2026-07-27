// ── Loose physical props that float when gravity fails ──────────────────────

const _propsUp = new THREE.Vector3();
const _propsQ = new THREE.Quaternion();

function buildProps(scene, textures, rng) {
  const group = new THREE.Group();
  scene.add(group);
  const props = [];

  const crateMat = new THREE.MeshStandardMaterial({ color: 0xb08c58, map: textures.dirt, roughness: 0.9 });
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x4a6f8a, roughness: 0.4, metalness: 0.5 });
  const potMat = new THREE.MeshStandardMaterial({ color: 0xa25f42, roughness: 0.8 });

  const spawnAreas = [
    { fromDeg: 42, toDeg: 56, count: 16, types: ['crate', 'barrel'] },     // engineering
    { fromDeg: 318, toDeg: 348, count: 18, types: ['crate', 'barrel'] },   // dock
    { fromDeg: 14, toDeg: 38, count: 10, types: ['pot'] },                 // east residential
    { fromDeg: 132, toDeg: 166, count: 10, types: ['pot'] },               // north residential
    { fromDeg: 286, toDeg: 314, count: 8, types: ['pot'] },                // west residential
    { fromDeg: 172, toDeg: 190, count: 12, types: ['crate', 'pot'] },      // market
  ];

  for (const area of spawnAreas) {
    for (let i = 0; i < area.count; i++) {
      const type = area.types[Math.floor(rng() * area.types.length)];
      let mesh, half;
      if (type === 'crate') {
        const s = 0.55 + rng() * 0.5;
        mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crateMat);
        half = s / 2;
      } else if (type === 'barrel') {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.9, 12), barrelMat);
        half = 0.45;
      } else {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.22, 0.5, 10), potMat);
        half = 0.25;
      }
      mesh.castShadow = true;
      const theta = (area.fromDeg + rng() * (area.toDeg - area.fromDeg)) * DEG;
      const side = rng() < 0.5 ? -1 : 1;
      // hug the real road, but never off the floor band — roadLat wanders to
      // ∓49 m, so an unclamped offset lands outside the hull.
      const lat = Math.max(-BUILD_LAT, Math.min(BUILD_LAT, roadLat(theta) + side * (8.5 + rng() * 14)));
      const p = {
        mesh, half,
        pos: torusPosition(theta, lat, groundH(theta, lat, Infinity) + half, new THREE.Vector3()),
        vel: new THREE.Vector3(),
        rot: new THREE.Vector3(),
      };
      frameQuaternion(theta, mesh.quaternion);
      mesh.position.copy(p.pos);
      group.add(mesh);
      props.push(p);
    }
  }

  function kickAll() {
    for (const p of props) {
      // just enough to set each one tumbling — the rise itself comes from the
      // sustained lift in update(), same as the citizens
      p.vel.set((rng() - 0.5) * 1.1, (rng() - 0.5) * 1.1, (rng() - 0.5) * 1.1);
      const t = worldToTorus(p.pos);
      upAt(t.theta, _propsUp);
      p.vel.addScaledVector(_propsUp, 0.2 + rng() * 0.5);
      p.rot.set((rng() - 0.5) * 1.6, (rng() - 0.5) * 1.6, (rng() - 0.5) * 1.6);
    }
  }

  function update(dt, gravityScale, zeroG, lift = 0) {
    for (const p of props) {
      const t = worldToTorus(p.pos);
      upAt(t.theta, _propsUp);
      p.vel.addScaledVector(_propsUp, -G_FULL * gravityScale * dt);
      if (lift > 0) {
        const vUp = p.vel.dot(_propsUp);
        p.vel.addScaledVector(_propsUp, (LIFT_RISE * lift - vUp) * Math.min(1, LIFT_EASE * lift * dt));
      }
      if (zeroG) p.vel.multiplyScalar(Math.max(0, 1 - 0.05 * dt));
      p.pos.addScaledVector(p.vel, dt);

      const t2 = worldToTorus(p.pos);
      upAt(t2.theta, _propsUp);
      // floor (terrain-aware)
      const gp = groundH(t2.theta, t2.lat, t2.h);
      if (t2.h < gp + p.half) {
        const pen = gp + p.half - t2.h;
        p.pos.addScaledVector(_propsUp, pen);
        const vUp = p.vel.dot(_propsUp);
        if (vUp < 0) {
          p.vel.addScaledVector(_propsUp, -vUp * 1.3);       // restitution 0.3
          p.vel.multiplyScalar(0.92);                    // ground friction
          // don't glue a crate to the floor while the lift is trying to peel it off
          if (Math.abs(vUp) < 0.4 && !zeroG && lift < 0.15) { p.vel.set(0, 0, 0); p.rot.set(0, 0, 0); }
        }
      }
      // hull
      {
        const cx = CHORD_DROP - t2.h, cy = t2.lat;
        const dist = Math.hypot(cx, cy);
        const maxR = RT - 1.5;
        if (dist > maxR) {
          const nx = cx / dist, ny = cy / dist, pen = dist - maxR;
          p.pos.addScaledVector(_propsUp, nx * pen);
          p.pos.y -= ny * pen;
          p.vel.multiplyScalar(0.5);
        }
      }
      p.mesh.position.copy(p.pos);
      if (p.rot.lengthSq() > 0.001) {
        p.mesh.rotateX(p.rot.x * dt);
        p.mesh.rotateY(p.rot.y * dt);
        p.mesh.rotateZ(p.rot.z * dt);
        if (!zeroG) p.rot.multiplyScalar(Math.max(0, 1 - 1.5 * dt));
      }
    }
  }

  return { props, update, kickAll };
}
