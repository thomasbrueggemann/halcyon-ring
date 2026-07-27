// ── hydro.js — water in free fall ───────────────────────────────────────────
// Loaded right AFTER world.js (it needs CASCADE and the layout water queries).
//
// When the flywheel stalls, the river does not politely stay in its bed. Sheets
// of it peel off the surface and go up with everything else: globules the size
// of your head wobbling toward the glazing, dragging a haze of spray behind
// them. This is the single most legible sign that gravity is gone — people and
// crates tumbling could be an accident, but water hanging in the air cannot.
//
// Everything is two draw calls: one InstancedMesh of globules and one Points
// cloud of spray. Inactive globules are written at scale 0 rather than being
// removed, so there is no per-frame allocation and no instance-count churn.

const HYD_COUNT = 760;          // globules
const HYD_SPRAY = 1400;         // spray motes
const HYD_WAKE  = 0.35;         // lift at which the water starts to let go
const HYD_STAGGER = 6.0;        // seconds over which the whole river peels off

const _hyP = new THREE.Vector3();
const _hyUp = new THREE.Vector3();
const _hyQ = new THREE.Quaternion();
const _hyS = new THREE.Vector3();
const _hyM = new THREE.Matrix4();
const _hyT = {};
const _HY_Y = new THREE.Vector3(0, 1, 0);

function buildHydro(scene, rng) {
  const group = new THREE.Group();
  scene.add(group);
  // Private stream for the per-frame jitter, so respawning globules mid-game
  // never perturbs the shared world-gen sequence.
  const hrng = mulberry32((WORLD_SEED ^ 0x0d40b1e7) >>> 0);

  // ── where the water is ────────────────────────────────────────────────────
  // Rejection-sample the ring by channel width so the lake at Reservoir Flats
  // throws up far more water than a 6 m stretch of stream — which is what you
  // would expect to see, and it puts the spectacle where the open sightlines
  // are instead of hiding it behind the orchards.
  let widest = 1;
  for (let i = 0; i < 360; i++) {
    const e = waterEdges((i / 360) * Math.PI * 2);
    if (!e.dry) widest = Math.max(widest, e.hi - e.lo);
  }
  function sampleRiver() {
    for (let tries = 0; tries < 40; tries++) {
      const theta = rng() * Math.PI * 2;
      const e = waterEdges(theta);
      if (e.dry) continue;
      const w = e.hi - e.lo;
      if (rng() > w / widest) continue;
      return { theta, lat: e.lo + rng() * w, surf: WATER_H };
    }
    return { theta: 240 * DEG, lat: riverLat(240 * DEG), surf: WATER_H };
  }
  // The plunge basin and the falls themselves are already airborne water; when
  // spin goes they simply stop coming down, which is the best shot in the game.
  function sampleCascade() {
    const C = CASCADE;
    const lat = C.latToe + (C.latLip - C.latToe) * Math.pow(rng(), 0.7);
    return {
      theta: C.theta + (rng() - 0.5) * C.halfAt(lat) / RF,
      lat,
      surf: C.surfAt(lat),
    };
  }

  const drops = [];
  for (let i = 0; i < HYD_COUNT; i++) {
    const src = (i % 5 === 0) ? sampleCascade() : sampleRiver();
    drops.push({
      theta: src.theta, lat: src.lat, surf: src.surf,
      r: 0.10 + rng() * 0.42,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      wob: rng() * 6.28, wobF: 1.4 + rng() * 2.2,
      swirl: (rng() - 0.5) * 0.55,
      delay: rng() * HYD_STAGGER,
      live: false, t: 0,
    });
  }

  const dropGeo = new THREE.IcosahedronGeometry(1, 1);
  const dropMat = new THREE.MeshStandardMaterial({
    color: 0x83cfd6, roughness: 0.06, metalness: 0.0,
    transparent: true, opacity: 0.78, envMapIntensity: 1.5,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const dropMesh = new THREE.InstancedMesh(dropGeo, dropMat, HYD_COUNT);
  dropMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  dropMesh.frustumCulled = false;
  dropMesh.renderOrder = 5;
  group.add(dropMesh);
  // start hidden
  _hyM.makeScale(0, 0, 0);
  for (let i = 0; i < HYD_COUNT; i++) dropMesh.setMatrixAt(i, _hyM);

  // ── spray: a fine haze that trails the globules ──
  const sprayPos = new Float32Array(HYD_SPRAY * 3);
  const sprayGeo = new THREE.BufferGeometry();
  sprayGeo.setAttribute('position', new THREE.BufferAttribute(sprayPos, 3));
  const sprayMat = new THREE.PointsMaterial({
    color: 0xbfe8ee, size: 0.13, transparent: true, opacity: 0,
    depthWrite: false, sizeAttenuation: true,
  });
  const spray = new THREE.Points(sprayGeo, sprayMat);
  spray.frustumCulled = false;
  spray.renderOrder = 5;
  group.add(spray);
  const sprayOf = new Float32Array(HYD_SPRAY * 3);
  for (let i = 0; i < HYD_SPRAY; i++) {
    sprayOf[i * 3] = (rng() - 0.5) * 2.6;
    sprayOf[i * 3 + 1] = (rng() - 0.5) * 2.6;
    sprayOf[i * 3 + 2] = (rng() - 0.5) * 2.6;
  }

  function reset(d) {
    d.live = false; d.t = 0;
    d.vel.set(0, 0, 0);
  }

  let anyLive = false;
  function update(dt, gScale, lift) {
    if (lift <= 0 && !anyLive) return;
    anyLive = false;

    for (let i = 0; i < HYD_COUNT; i++) {
      const d = drops[i];

      if (!d.live) {
        // peel off the surface once the lift has been on long enough for this
        // one's turn — a river that leaves all at once reads as a cut, not as
        // water losing its grip
        if (lift > HYD_WAKE) {
          d.t += dt;
          if (d.t < d.delay) { anyLive = true; continue; }
          torusPosition(d.theta, d.lat, d.surf + d.r, d.pos);
          upAt(d.theta, _hyUp);
          d.vel.copy(_hyUp).multiplyScalar(0.3 + hrng() * 0.5);
          d.live = true;
        } else {
          d.t = 0;
          continue;
        }
      }
      anyLive = true;

      worldToTorus(d.pos, _hyT);
      upAt(_hyT.theta, _hyUp);
      d.vel.addScaledVector(_hyUp, -G_FULL * gScale * dt);
      if (lift > 0) {
        const vUp = d.vel.dot(_hyUp);
        // water is lighter than a person, so it goes up a little faster
        d.vel.addScaledVector(_hyUp, (LIFT_RISE * 1.35 * lift - vUp) * Math.min(1, LIFT_EASE * 1.6 * lift * dt));
      }
      // lazy swirl, so a mass of them churns instead of rising in lockstep
      d.wob += dt * d.wobF;
      tangentAt(_hyT.theta, _hyP);
      d.vel.addScaledVector(_hyP, Math.sin(d.wob) * d.swirl * dt * 2.2);
      d.vel.y += Math.cos(d.wob * 0.7) * d.swirl * dt * 2.2;
      d.vel.multiplyScalar(Math.max(0, 1 - 0.25 * dt));
      d.pos.addScaledVector(d.vel, dt);

      // Back in the water (or through the glazing) → gone, and available to be
      // thrown up again by the next failure.
      worldToTorus(d.pos, _hyT);
      const hullR = Math.hypot(CHORD_DROP - _hyT.h, _hyT.lat);
      if ((_hyT.h <= d.surf && d.vel.dot(_hyUp) < 0) || hullR > RT - 2.0) {
        reset(d);
        _hyM.makeScale(0, 0, 0);
        dropMesh.setMatrixAt(i, _hyM);
        continue;
      }

      // Stretched along the local up axis, which is the way they are travelling
      // for all but the first moment: a rising blob is a teardrop, not a marble.
      const st = 1 + Math.min(0.9, d.vel.length() * 0.10);
      frameQuaternion(_hyT.theta, _hyQ);
      _hyS.set(d.r / st, d.r * st, d.r / st);
      _hyM.compose(d.pos, _hyQ, _hyS);
      dropMesh.setMatrixAt(i, _hyM);
    }
    dropMesh.instanceMatrix.needsUpdate = true;

    // spray rides the first HYD_SPRAY live globules, offset randomly
    let s = 0;
    for (let i = 0; i < HYD_COUNT && s < HYD_SPRAY; i++) {
      const d = drops[i];
      if (!d.live) continue;
      const n = 2;
      for (let k = 0; k < n && s < HYD_SPRAY; k++, s++) {
        sprayPos[s * 3] = d.pos.x + sprayOf[s * 3];
        sprayPos[s * 3 + 1] = d.pos.y + sprayOf[s * 3 + 1];
        sprayPos[s * 3 + 2] = d.pos.z + sprayOf[s * 3 + 2];
      }
    }
    for (; s < HYD_SPRAY; s++) { sprayPos[s * 3] = 0; sprayPos[s * 3 + 1] = 1e6; sprayPos[s * 3 + 2] = 0; }
    sprayGeo.attributes.position.needsUpdate = true;
    sprayMat.opacity += (lift * 0.5 - sprayMat.opacity) * Math.min(1, 2 * dt);
  }

  return { update, drops, group };
}
