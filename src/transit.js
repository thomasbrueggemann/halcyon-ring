// ── Ring monorail: a WINDING full-circumference guideway + rideable trains ───
// The guideway follows layout.js's (railLat(theta), railH(theta)) — it weaves
// across the valley (crossing over the river in places) and undulates in height,
// flattening to lat = STATIONS[i].lat, h = 6.0 at each of the 5 stations. Two
// 3-car trains run opposite directions, decelerate + dwell at platforms, and the
// player can board (E), ride the winding curve, and hop off (moving or stopped).

const RAIL_HALF = 1.45;          // deck half-width (m, lateral)
const RAIL_GAUGE = 0.7;          // twin-lane offset from centerline
const TRAIN_SPEED = 21;          // m/s cruise
const TRAIN_ACCEL = 5.5;         // m/s² accelerate off a stop
const TRAIN_BRAKE = 4.0;         // m/s² braking
const BRAKE_DIST = 90;           // start braking this far out (m)
const DWELL_TIME = 7;            // seconds stopped at a platform
const TRAINS_PER_DIR = 3;        // 6 sets total → a train through each platform ≈ every 50 s
const CAR_LEN = 6.8, CAR_GAP = 1.0;
const PLAT_RISE = 6.0 - 0.25;    // platform deck height above the pad (car floor ≈ platform)
const PLAT_HALFLEN = 12;         // 24 m long
const PLAT_WIDTH = 2.6;
const RAMP_RUN = 18;             // lat-length of the walk-up ramp (m)

// module temps — no per-frame allocation
const _txP = new THREE.Vector3();
const _txA = new THREE.Vector3();
const _txB = new THREE.Vector3();
const _txFwd = new THREE.Vector3();
const _txUp = new THREE.Vector3();
const _txRight = new THREE.Vector3();
const _txUp2 = new THREE.Vector3();
const _txMat = new THREE.Matrix4();
const _txSeat = new THREE.Vector3();
const _txTmp = new THREE.Vector3();

// ── guideway path: full 3-D position + an orthonormal tangent frame ──
function _railPos(theta, out) {
  return torusPosition(theta, railLat(theta), railH(theta), out);
}
// Fills _txFwd (+theta travel dir), _txRight (lateral, +lat side), _txUp2 (up).
function _railFrame(theta) {
  const eps = 0.0008;                                  // ≈ 0.75 m of arc
  _railPos(theta + eps, _txB);
  _railPos(theta - eps, _txA);
  _txFwd.subVectors(_txB, _txA).normalize();           // along +theta
  upAt(theta, _txUp);                                  // torus up (toward axis)
  _txRight.crossVectors(_txUp, _txFwd).normalize();    // right = up × fwd
  _txUp2.crossVectors(_txFwd, _txRight).normalize();   // re-orthonormalized up
}

function buildTransit(scene, colliders, rng) {
  const group = new THREE.Group();
  scene.add(group);
  const RAIL_SEGS = 1200;

  // ── swept guideway geometry: a profile carried along the winding path ──
  function sweepPath(profile, segs) {
    const nP = profile.length;
    const pos = [], idx = [];
    for (let s = 0; s <= segs; s++) {
      const theta = (s / segs) * Math.PI * 2;
      _railFrame(theta);
      _railPos(theta, _txP);
      for (let i = 0; i < nP; i++) {
        const u = profile[i][0], v = profile[i][1];
        _txA.copy(_txP).addScaledVector(_txRight, u).addScaledVector(_txUp2, v);
        pos.push(_txA.x, _txA.y, _txA.z);
      }
    }
    for (let s = 0; s < segs; s++) {
      for (let i = 0; i < nP - 1; i++) {
        const a = s * nP + i, b = a + nP;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  // deck: a shallow channel (top flat, outer lips drop 0.45 m)
  const deckMat = new THREE.MeshStandardMaterial({
    color: 0x8d949e, roughness: 0.45, metalness: 0.55, side: THREE.DoubleSide,
  });
  const deck = new THREE.Mesh(sweepPath([
    [-RAIL_HALF, -0.45], [-RAIL_HALF, 0], [RAIL_HALF, 0], [RAIL_HALF, -0.45],
  ], RAIL_SEGS), deckMat);
  deck.castShadow = true; deck.receiveShadow = true;
  group.add(deck);

  // twin rails: thin closed box tubes at ±RAIL_GAUGE, sitting on the deck top
  const railMat = new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.3, metalness: 0.9 });
  const railGeos = [];
  for (const off of [-RAIL_GAUGE, RAIL_GAUGE]) {
    railGeos.push(sweepPath([
      [off - 0.06, 0.02], [off - 0.06, 0.17], [off + 0.06, 0.17], [off + 0.06, 0.02], [off - 0.06, 0.02],
    ], RAIL_SEGS));
  }
  const rails = new THREE.Mesh(mergeGeometries(railGeos), railMat);
  rails.castShadow = true;
  group.add(rails);

  // ── support pylons every ~30 m, ground → deck bottom (variable height) ──
  const pylonMat = new THREE.MeshStandardMaterial({ color: 0x7a828c, roughness: 0.5, metalness: 0.5 });
  const colGeo = new THREE.CylinderGeometry(0.32, 0.44, 1, 9);
  colGeo.translate(0, 0.5, 0);                         // base at y=0, unit height
  const capGeo = new THREE.BoxGeometry(1.3, 0.35, 3.0);
  const pylonList = [];
  const stepDeg = (30 / RF) / DEG;
  for (let deg = 0; deg < 360; deg += stepDeg) {
    const theta = deg * DEG;
    const lat = railLat(theta);
    if (colliders.resolve(theta * RF, lat, 1.0, 1.4)) continue;   // something already here
    const base = groundH(theta, lat, 0);               // terrain (ignore platform patches)
    const topH = railH(theta) - 0.45;                  // deck underside
    const hgt = topH - base;
    if (hgt < 1.2) continue;
    pylonList.push({ theta, lat, base, hgt, topH });
  }
  const pylons = new THREE.InstancedMesh(colGeo, pylonMat, pylonList.length);
  const caps = new THREE.InstancedMesh(capGeo, pylonMat, pylonList.length);
  const _sv = new THREE.Vector3();
  pylonList.forEach((p, i) => {
    placementMatrix(p.theta, p.lat, p.base, 0, _sv.set(1, p.hgt, 1), _txMat);
    pylons.setMatrixAt(i, _txMat);
    placementMatrix(p.theta, p.lat, p.topH - 0.1, 0, 1, _txMat);
    caps.setMatrixAt(i, _txMat);
    colliders.addCylinder(p.theta, p.lat, 0.5, p.topH - p.base);
  });
  pylons.castShadow = true; caps.castShadow = true;
  group.add(pylons, caps);

  // ── stations: platform + walk-up ramp (height patches), railings, sign,
  //    canopy, bench, light — on the OUTER (−lat) side of the guideway ──
  const platMat = new THREE.MeshStandardMaterial({ color: 0x9aa2ac, roughness: 0.8, metalness: 0.2 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x394654, roughness: 0.6, metalness: 0.4 });
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0x2c6e8f, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
  const benchMat = new THREE.MeshStandardMaterial({ color: 0x7a5a38, roughness: 0.9 });
  const postPositions = [];
  const stationInfos = [];

  // flat platform slab (curves negligibly over 24 m — a single box is fine)
  const slabGeo = new THREE.BoxGeometry(PLAT_WIDTH, 0.25, PLAT_HALFLEN * 2);
  slabGeo.translate(0, -0.125, 0);

  function buildStation(st) {
    // The platform and its walk-up ramp sit on the +lat side of the guideway —
    // AWAY from the river. The guideway now runs the far bank at a guaranteed
    // gap from the water, so a ramp running the other way (18 m of it) would
    // walk straight into the reservoir.
    const innerLat = st.lat + 1.6;                     // edge next to the track
    const outerLat = st.lat + 1.6 + PLAT_WIDTH;        // far edge
    const centerLat = (innerLat + outerLat) / 2;
    const s0 = st.theta * RF - PLAT_HALFLEN, s1 = st.theta * RF + PLAT_HALFLEN;
    // Station pads are flat spots, but they no longer level to h = 0 — the deck
    // has to ride whatever height the pad settled at.
    const padH = terrainH(st.theta, st.lat);
    const PLAT_H = padH + PLAT_RISE;
    st.platH = PLAT_H;

    // platform standable surface
    addHeightPatch({ s0, s1, lat0: innerLat, lat1: outerLat, h0: PLAT_H, h1: PLAT_H });
    const slab = new THREE.Mesh(slabGeo, platMat);
    slab.applyMatrix4(placementMatrix(st.theta, centerLat, PLAT_H, 0, 1));
    slab.receiveShadow = true; slab.castShadow = true;
    group.add(slab);

    // ── walk-up ramp ──
    // It runs ALONG the ring off the far end of the platform, not out across the
    // valley. Across lat the ground climbs the hillside, so an 18 m cross-slope
    // ramp descended barely 2 m, landed part-way up the bank and left its slab
    // hanging over (or buried in) the terrain. Along the arc the ground is
    // near-level, so a constant 1:6 grade actually reaches it — and the run
    // stops at the first point where it does.
    const GRADE = 1 / 6;
    let rampLen = RAMP_RUN, rampBotH = PLAT_H - RAMP_RUN * GRADE;
    for (let d = 1; d <= 44; d += 0.5) {
      const th = st.theta + (PLAT_HALFLEN + d) / RF;
      const gnd = terrainH(th, centerLat);
      const h = PLAT_H - d * GRADE;
      rampLen = d; rampBotH = h;
      if (h <= gnd + 0.06) { rampBotH = gnd; break; }
    }
    const rampS0 = s1, rampS1 = s1 + rampLen;
    addHeightPatch({
      s0: rampS0, s1: rampS1,
      lat0: innerLat, lat1: outerLat, h0: PLAT_H, h1: rampBotH, axis: 's',
    });
    // ramp deck: a strip of quads so it follows its own grade cleanly, with a
    // skirt down each side hiding the gap over the falling ground
    {
      const N = 12, pos = [], idx = [], uv = [];
      const v = new THREE.Vector3();
      for (let k = 0; k <= N; k++) {
        const f = k / N;
        const th = (rampS0 + (rampS1 - rampS0) * f) / RF;
        const h = PLAT_H + (rampBotH - PLAT_H) * f;
        for (const lat of [innerLat, outerLat]) {
          torusPosition(th, lat, h, v);
          pos.push(v.x, v.y, v.z);
          uv.push(f * rampLen / 3, (lat - innerLat) / 3);
          torusPosition(th, lat, Math.min(h, terrainH(th, lat)) - 0.25, v);
          pos.push(v.x, v.y, v.z);
          uv.push(f * rampLen / 3, (lat - innerLat) / 3);
        }
      }
      // per station: 0=innerTop 1=innerBot 2=outerTop 3=outerBot
      for (let k = 0; k < N; k++) {
        const a = k * 4, b = (k + 1) * 4;
        idx.push(a + 0, b + 0, a + 2, a + 2, b + 0, b + 2);   // walking surface
        idx.push(a + 0, a + 1, b + 0, a + 1, b + 1, b + 0);   // inner skirt
        idx.push(a + 2, b + 2, a + 3, a + 3, b + 2, b + 3);   // outer skirt
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const ramp = new THREE.Mesh(g, platMat);
      ramp.receiveShadow = true; ramp.castShadow = true;
      group.add(ramp);
    }

    // ── railings: outer platform edge + the far end + both ramp sides
    //    (colliders + instanced posts). NO rail on the inner (track) edge —
    //    you board there, and none across the ramp mouth. ──
    colliders.addBox(st.theta, outerLat + 0.05, PLAT_HALFLEN, 0.12, 1.15);
    colliders.addBox((s0) / RF, centerLat, 0.12, PLAT_WIDTH / 2, 1.15);
    // posts along the outer edge
    for (let k = 0; k <= 8; k++) {
      const s = s0 + (s1 - s0) * (k / 8);
      postPositions.push({ theta: s / RF, lat: outerLat, h: PLAT_H, top: 1.0 });
    }
    // ramp side posts + rails down both edges
    for (let k = 0; k <= 8; k++) {
      const f = k / 8;
      const s = rampS0 + (rampS1 - rampS0) * f;
      const h = PLAT_H + (rampBotH - PLAT_H) * f;
      for (const lat of [innerLat, outerLat]) {
        postPositions.push({ theta: s / RF, lat, h, top: 1.0 });
      }
    }
    for (const lat of [innerLat - 0.05, outerLat + 0.05]) {
      colliders.addBox((rampS0 + rampS1) / 2 / RF, lat, rampLen / 2, 0.12, 1.15);
    }
    st.rampS0 = rampS0; st.rampS1 = rampS1;

    // ── canopy over part of the platform ──
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(PLAT_WIDTH + 0.4, 0.14, 11), canopyMat);
    canopy.applyMatrix4(placementMatrix(st.theta, centerLat - 0.1, PLAT_H + 2.55, 0, 1));
    canopy.castShadow = true;
    group.add(canopy);
    for (const ds of [-4.6, 4.6]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.55, 8), trimMat);
      pillar.applyMatrix4(placementMatrix(st.theta + ds / RF, outerLat - 0.3, PLAT_H + 1.27, 0, 1));
      group.add(pillar);
    }

    // ── bench ──
    const bench = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 2.4), benchMat);
    bench.applyMatrix4(placementMatrix(st.theta + 3.5 / RF, outerLat - 0.6, PLAT_H + 0.45, 0, 1));
    group.add(bench);
    const backrest = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 2.4), benchMat);
    backrest.applyMatrix4(placementMatrix(st.theta + 3.5 / RF, outerLat - 0.35, PLAT_H + 0.7, 0, 1));
    group.add(backrest);

    // ── platform light ──
    const lampPost = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.8, 6), trimMat);
    lampPost.applyMatrix4(placementMatrix(st.theta - 4 / RF, outerLat - 0.4, PLAT_H + 1.4, 0, 1));
    group.add(lampPost);
    const lampHead = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xfff4d0, emissive: 0xffe9a8, emissiveIntensity: 1.2 }));
    lampHead.applyMatrix4(placementMatrix(st.theta - 4 / RF, outerLat - 0.4, PLAT_H + 2.75, 0, 1));
    group.add(lampHead);
    const light = new THREE.PointLight(0xffe9b0, 8, 22, 2);
    torusPosition(st.theta - 4 / RF, outerLat - 0.4, PLAT_H + 2.7, light.position);
    group.add(light);

    // ── name sign (CanvasTexture) facing the platform (+lat/track side) ──
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 128;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#132430'; ctx.fillRect(0, 0, 512, 128);
    ctx.strokeStyle = '#4fd0e0'; ctx.lineWidth = 6; ctx.strokeRect(8, 8, 496, 112);
    ctx.fillStyle = '#eaf6ff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 46px sans-serif';
    ctx.fillText(st.name.toUpperCase(), 256, 64);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    // Single-sided on purpose. It faces the track, for people arriving; from
    // the platform you'd only ever see it mirrored, and it sat right in front
    // of the departure board. The board carries the station name anyway.
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 1.05),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide }));
    sign.applyMatrix4(placementMatrix(st.theta + PLAT_HALFLEN * 0.6 / RF, innerLat - 0.05, PLAT_H + 2.05, Math.PI / 2, 1));
    group.add(sign);
    // sign support posts (spread along theta under the sign)
    for (const dt of [-2.0, 2.0]) {
      const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.05, 6), trimMat);
      sp.applyMatrix4(placementMatrix(st.theta + (PLAT_HALFLEN * 0.6 + dt) / RF, innerLat - 0.05, PLAT_H + 1.02, 0, 1));
      group.add(sp);
    }

    // ── live departure board ──
    // One canvas, two meshes back to back at either end of the platform facing
    // inward, so it is readable wherever you are standing and from the ramp on
    // the way up. Redrawn (only when you are near enough to read it) in update().
    const bcv = document.createElement('canvas');
    bcv.width = 640; bcv.height = 280;
    const btex = new THREE.CanvasTexture(bcv);
    btex.colorSpace = THREE.SRGBColorSpace;
    const bmat = new THREE.MeshBasicMaterial({ map: btex, toneMapped: false });
    const bgeo = new THREE.PlaneGeometry(3.4, 1.49);
    // yaw 0 faces −theta, yaw π faces +theta — each board looks back along the
    // platform toward the middle of it
    for (const [ds, yaw] of [[-PLAT_HALFLEN * 0.92, Math.PI], [PLAT_HALFLEN * 0.92, 0]]) {
      const b = new THREE.Mesh(bgeo, bmat);
      b.applyMatrix4(placementMatrix(st.theta + ds / RF, centerLat, PLAT_H + 2.35, yaw, 1));
      group.add(b);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.6, 6), trimMat);
      post.applyMatrix4(placementMatrix(st.theta + ds / RF, centerLat, PLAT_H + 0.8, 0, 1));
      group.add(post);
    }

    stationInfos.push({
      name: st.name, theta: st.theta, thetaDeg: st.thetaDeg,
      platLat: centerLat, platH: PLAT_H, s0, s1,
      board: { cv: bcv, ctx: bcv.getContext('2d'), tex: btex, drawn: -1 },
    });
  }
  for (const st of STATIONS) buildStation(st);

  // instanced railing posts across every station
  if (postPositions.length) {
    const pg = new THREE.BoxGeometry(0.08, 1.0, 0.08);
    pg.translate(0, 0.5, 0);
    const posts = new THREE.InstancedMesh(pg, new THREE.MeshStandardMaterial({ color: 0xb0b8c2, roughness: 0.4, metalness: 0.7 }), postPositions.length);
    postPositions.forEach((pp, i) => { placementMatrix(pp.theta, pp.lat, pp.h, 0, 1, _txMat); posts.setMatrixAt(i, _txMat); });
    posts.castShadow = true;
    group.add(posts);
    // a top rail ribbon per outer edge would be nice but posts read clearly enough
  }

  // ── trains: two 3-car sets, opposite directions, distinct liveries ──
  function makeCar(bodyColor) {
    const car = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(2.0, 2.2, CAR_LEN),
      new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.35, metalness: 0.3 })
    );
    body.position.y = 1.35;
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(2.06, 0.75, CAR_LEN - 0.9),
      new THREE.MeshStandardMaterial({
        color: 0x18222c, roughness: 0.2, metalness: 0.4, emissive: 0x8fb4c8, emissiveIntensity: 0.35,
      })
    );
    band.position.y = 1.75;
    const skirt = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.35, CAR_LEN - 1.6),
      new THREE.MeshStandardMaterial({ color: 0x3a424c, roughness: 0.6 })
    );
    skirt.position.y = 0.18;
    car.add(body, band, skirt);
    car.traverse(o => { o.castShadow = true; });
    car.matrixAutoUpdate = false;
    group.add(car);
    return car;
  }

  const carR = RF - 6.0;
  // Three sets each way, evenly spaced. With five platforms on the loop that
  // puts a train through any given one roughly every 50 seconds, which is what
  // makes the countdown board worth reading — at the old two-set headway you
  // waited nearly two minutes and simply walked instead.
  const trains = [];
  for (let d = 0; d < 2; d++) {
    const dir = d === 0 ? 1 : -1;
    for (let i = 0; i < TRAINS_PER_DIR; i++) {
      trains.push({
        id: trains.length,
        theta: ((d * 60) + i * (360 / TRAINS_PER_DIR)) * DEG,
        dir, lane: dir > 0 ? -RAIL_GAUGE : RAIL_GAUGE,
        v: TRAIN_SPEED, state: 'cruise', dwellT: 0, target: null,
        cars: [0, 1, 2].map(() => makeCar(dir > 0 ? 0xe8ecf0 : 0xe8973c)),
      });
    }
  }

  // place a car's manual matrix along the winding curve at (theta, laneOffset)
  function placeCar(theta, lane, out) {
    _railFrame(theta);
    _railPos(theta, _txP);
    _txP.addScaledVector(_txRight, lane).addScaledVector(_txUp2, 0.18);
    _txMat.makeBasis(_txRight, _txUp2, _txFwd);
    _txMat.setPosition(_txP);
    out.copy(_txMat);
  }

  // seat (feet) world position inside the lead car, on the platform-facing side
  function seatPos(train, out) {
    _railFrame(train.theta);
    _railPos(train.theta, _txSeat);
    _txSeat.addScaledVector(_txRight, train.lane).addScaledVector(_txUp2, 0.30);
    out.copy(_txSeat);
    return out;
  }

  // forward-arc (m) from a train to a station in the train's travel direction
  function fwdArc(train, theta) {
    let d = train.dir * arcDelta(train.theta, theta);
    if (d < -CIRCUMFERENCE / 2 + 1) d += CIRCUMFERENCE;
    return d;
  }
  // ── Timetable ─────────────────────────────────────────────────────────────
  // The countdown on the platform boards is not a decoration with a random
  // number in it: it is solved from the same speed profile the trains actually
  // fly, so when it reaches 0:00 a train is standing at the platform.
  //
  // Time to cover `d` metres starting at v0 and stopping at the far end, with
  // the cruise/accelerate/brake limits above. Matches the state machine's
  // braking law (v = sqrt(2·B·d)) exactly, so the two do not drift apart.
  function legTime(d, v0) {
    if (d <= 0.01) return 0;
    const V = TRAIN_SPEED, A = TRAIN_ACCEL, B = TRAIN_BRAKE;
    const da = Math.max(0, (V * V - v0 * v0) / (2 * A));   // reach cruise
    const db = (V * V) / (2 * B);                          // brake from cruise
    if (da + db <= d) return (V - v0) / A + (d - da - db) / V + V / B;
    // too short to reach cruise: accelerate to a peak, then brake
    const vp = Math.sqrt((2 * A * B * d + B * v0 * v0) / (A + B));
    return Math.max(0, (vp - v0) / A) + vp / B;
  }
  // Seconds until `tr` is standing at station `si`, counting every stop it
  // makes on the way (and the rest of the dwell it is serving right now).
  function etaTo(tr, si) {
    let t = 0, v0 = tr.v;
    if (tr.state === 'dwell') { t = Math.max(0, DWELL_TIME - tr.dwellT); v0 = 0; }
    const ahead = [];
    for (const s of stationInfos) {
      let d = fwdArc(tr, s.theta);
      if (d < 1) d += CIRCUMFERENCE;      // at it or just past it → next lap
      ahead.push({ s, d });
    }
    ahead.sort((a, b) => a.d - b.d);
    let prev = 0;
    for (const x of ahead) {
      t += legTime(x.d - prev, v0);
      v0 = 0;
      if (x.s === si) return t;
      t += DWELL_TIME;
      prev = x.d;
    }
    return t;
  }
  // Is a train standing at this platform right now?
  function dwellingAt(si) {
    for (const tr of trains) {
      if (tr.state === 'dwell' && Math.abs(arcDelta(tr.theta, si.theta)) < 3) return tr;
    }
    return null;
  }
  // The station a train calls at next (used for "via …" and the on-board sign).
  function nextStation(train) {
    let best = null, bestD = Infinity;
    for (const si of stationInfos) {
      let d = fwdArc(train, si.theta);
      if (d < -2) d += CIRCUMFERENCE;                  // wrapped just behind → ahead
      if (d >= -2 && d < bestD) { bestD = d; best = si; }
    }
    return { st: best, dist: bestD };
  }
  function stationAfter(si, dir) {
    let best = null, bestD = Infinity;
    for (const o of stationInfos) {
      if (o === si) continue;
      let d = dir * arcDelta(si.theta, o.theta);
      if (d < 0) d += CIRCUMFERENCE;
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }
  // Soonest arrival in each direction, for the board.
  function arrivalsAt(si) {
    const out = [];
    for (const dir of [1, -1]) {
      let best = null, bestT = Infinity;
      for (const tr of trains) {
        if (tr.dir !== dir) continue;
        const t = etaTo(tr, si);
        if (t < bestT) { bestT = t; best = tr; }
      }
      if (best) out.push({ dir, eta: bestT, train: best, via: stationAfter(si, dir) });
    }
    return out;
  }
  function mmss(s) {
    s = Math.max(0, Math.round(s));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // ── drawing the board ─────────────────────────────────────────────────────
  function drawBoard(si) {
    const b = si.board;
    const c = b.ctx, W = 640, H = 280;
    c.fillStyle = '#0b1620'; c.fillRect(0, 0, W, H);
    c.strokeStyle = '#2b4a5c'; c.lineWidth = 5; c.strokeRect(4, 4, W - 8, H - 8);

    // header: station name + the actual wall clock
    c.fillStyle = '#0f2634'; c.fillRect(10, 10, W - 20, 54);
    c.fillStyle = '#7fe4f2'; c.textBaseline = 'middle'; c.textAlign = 'left';
    c.font = 'bold 32px sans-serif';
    c.fillText(si.name.toUpperCase(), 26, 38);
    c.textAlign = 'right';
    c.fillStyle = '#d9f2fa'; c.font = '28px monospace';
    c.fillText(new Date().toLocaleTimeString('en-GB'), W - 26, 38);

    const here = dwellingAt(si);
    const rows = arrivalsAt(si);
    rows.sort((a, b2) => a.eta - b2.eta);

    let y = 96;
    for (const r of rows) {
      const atPlatform = here && here.dir === r.dir;
      c.textAlign = 'left';
      c.font = 'bold 34px sans-serif';
      c.fillStyle = r.dir > 0 ? '#8fd8ff' : '#ffc07a';
      c.fillText(r.dir > 0 ? '▶' : '◀', 26, y);
      c.fillStyle = '#e8f4fa'; c.font = '27px sans-serif';
      c.fillText(`via ${r.via ? r.via.name : '—'}`, 66, y);
      c.textAlign = 'right';
      if (atPlatform) {
        c.fillStyle = '#8dff9a'; c.font = 'bold 30px monospace';
        c.fillText(`BOARDING ${mmss(Math.max(0, DWELL_TIME - here.dwellT))}`, W - 26, y);
      } else {
        c.fillStyle = r.eta < 25 ? '#ffd166' : '#d9f2fa';
        c.font = 'bold 34px monospace';
        c.fillText(mmss(r.eta), W - 26, y);
      }
      y += 52;
    }

    c.strokeStyle = '#1e3646'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(20, H - 54); c.lineTo(W - 20, H - 54); c.stroke();
    c.textAlign = 'center'; c.fillStyle = '#7fa6bb'; c.font = '23px sans-serif';
    c.fillText(here ? '[E] board — doors closing' : 'HALCYON RING TRANSIT · [E] to board', W / 2, H - 28);
    b.tex.needsUpdate = true;
  }

  const _seatW = new THREE.Vector3();
  let prompt = null;

  const api = {
    group, trains, stationInfos, player: null, prompt: null,
    seatPos, PLAT_RISE, etaTo, arrivalsAt, nextStation, stationAfter, legTime, DWELL_TIME,
  };

  // 9 m, not 5.5: the platform is 24 m long and the train stops at the middle of
  // it, so a tighter radius meant standing on your own platform watching the
  // doors open with no way to get on.
  function boardableTrain() {
    if (!api.player) return null;
    for (const tr of trains) {
      if (tr.state !== 'dwell') continue;
      seatPos(tr, _seatW);
      if (_seatW.distanceTo(api.player.pos) < 9) return tr;
    }
    return null;
  }
  // The platform the player is standing on, if any.
  function playerAtStation() {
    const p = api.player;
    if (!p || p.ride) return null;
    for (const si of stationInfos) {
      if (Math.abs(arcDelta(si.theta, p.theta)) > PLAT_HALFLEN + 8) continue;
      if (Math.abs(p.lat - si.platLat) > 6) continue;
      if (p.h < si.platH - 2.5) continue;              // down on the ground, not up top
      return si;
    }
    return null;
  }

  function tryInteract() {
    const player = api.player;
    if (!player) return false;
    if (player.ride) {
      const tr = player.ride.train;
      if (tr.state === 'dwell') {
        // alight onto the platform beside the door
        player.ride = null;
        const si = stationInfos.reduce((a, b) =>
          Math.abs(arcDelta(tr.theta, b.theta)) < Math.abs(arcDelta(tr.theta, a.theta)) ? b : a);
        // step out onto the platform facing the train you just left (−lat)
        player.teleport(tr.theta / DEG, si.platLat, si.platH, -Math.PI / 2);
      } else {
        // hop off a MOVING train — inherit its velocity and leap clear
        _railFrame(tr.theta);
        seatPos(tr, _seatW);
        player.pos.copy(_seatW);
        const t = worldToTorus(player.pos);
        player.theta = t.theta; player.lat = t.lat; player.h = t.h;
        player.vel.copy(_txFwd).multiplyScalar(tr.v * tr.dir);
        player.vel.addScaledVector(_txUp2, 1.8);       // a little upward leap
        player.grounded = false;
        player.ride = null;
      }
      return true;
    }
    const tr = boardableTrain();
    if (tr) {
      player.ride = { train: tr, getSeat: (out) => seatPos(tr, out) };
      return true;
    }
    return false;
  }
  api.tryInteract = tryInteract;

  // debug: snap a train to a station and hold it dwelling (playwright helper)
  api.debugStopAt = function (trainIdx, stationIdx) {
    const tr = trains[trainIdx], si = stationInfos[stationIdx];
    tr.theta = si.theta; tr.v = 0; tr.state = 'dwell'; tr.dwellT = 0; tr.target = si;
    tr.cars.forEach((car, i) => {
      const th = tr.theta - tr.dir * i * (CAR_LEN + CAR_GAP) / carR;
      placeCar(th, tr.lane, car.matrix);
    });
  };

  let boardClock = 0;
  function update(dt) {
    for (const tr of trains) {
      // ── state machine: cruise → brake → dwell → accel ──
      if (tr.state === 'cruise') {
        const { st, dist } = nextStation(tr);
        tr.v = Math.min(TRAIN_SPEED, tr.v + TRAIN_ACCEL * dt);
        if (st && dist <= BRAKE_DIST) { tr.state = 'brake'; tr.target = st; }
      } else if (tr.state === 'brake') {
        const d = fwdArc(tr, tr.target.theta);
        if (d <= 0.4 || d > BRAKE_DIST + 30) {
          tr.theta = tr.target.theta; tr.v = 0; tr.state = 'dwell'; tr.dwellT = 0;
        } else {
          const vLim = Math.sqrt(2 * TRAIN_BRAKE * d);
          tr.v = Math.min(tr.v, vLim);
        }
      } else if (tr.state === 'dwell') {
        tr.v = 0;
        tr.dwellT += dt;
        if (tr.dwellT >= DWELL_TIME) { tr.state = 'accel'; }
      } else if (tr.state === 'accel') {
        tr.v = Math.min(TRAIN_SPEED, tr.v + TRAIN_ACCEL * dt);
        if (tr.v >= TRAIN_SPEED - 0.01) tr.state = 'cruise';
        // don't re-target the station we're leaving; leave-through is fine
      }

      if (tr.state !== 'dwell') tr.theta += tr.dir * (tr.v / carR) * dt;

      tr.cars.forEach((car, i) => {
        const th = tr.theta - tr.dir * i * (CAR_LEN + CAR_GAP) / carR;
        placeCar(th, tr.lane, car.matrix);
      });
    }

    // ── departure boards ──
    // Only the board(s) you could actually read get redrawn, and only a few
    // times a second: five canvas repaints per frame for signs 2 km away is a
    // lot of nothing.
    boardClock += dt;
    if (boardClock >= 0.25) {
      boardClock = 0;
      const p = api.player;
      for (const si of stationInfos) {
        const near = p && Math.abs(arcDelta(si.theta, p.theta)) < 130 && Math.abs(p.lat - si.platLat) < 90;
        if (near) drawBoard(si);
      }
    }

    // ── boarding / riding prompt ──
    const player = api.player;
    if (player && player.ride) {
      const tr = player.ride.train;
      const here = stationInfos.find(si => tr.state === 'dwell' && Math.abs(arcDelta(tr.theta, si.theta)) < 3);
      if (here) {
        prompt = `${here.name} — [E] step off`;
      } else {
        const { st } = nextStation(tr);
        prompt = st ? `Next stop ${st.name} · ${mmss(etaTo(tr, st))} — [E] hop off` : '[E] Hop off (moving!)';
      }
    } else if (boardableTrain()) {
      prompt = '[E] Board train';
    } else {
      const si = playerAtStation();
      if (si) {
        const rows = arrivalsAt(si).sort((a, b) => a.eta - b.eta);
        prompt = rows.length ? `${si.name} — next train ${mmss(rows[0].eta)} (via ${rows[0].via.name})` : null;
      } else {
        prompt = null;
      }
    }
    api.prompt = prompt;
  }
  api.update = update;

  // ── build-time clearance assert: railH must clear groundH by ≥ 2.2 m along
  //    the whole ring, except within a station arc (platforms sit at the rail) ──
  {
    let minClr = Infinity, minDeg = 0;
    for (let deg = 0; deg < 360; deg += 1) {
      const theta = deg * DEG;
      let nearStation = false;
      for (const si of stationInfos) if (Math.abs(arcDelta(theta, si.theta)) < 16) { nearStation = true; break; }
      if (nearStation) continue;
      const clr = railH(theta) - groundH(theta, railLat(theta), 0);
      if (clr < minClr) { minClr = clr; minDeg = deg; }
    }
    console.log(`[transit] min guideway clearance ${minClr.toFixed(2)} m at ${minDeg}° (need ≥ 2.2)`);
    if (minClr < 2.2) console.warn(`[transit] LOW CLEARANCE ${minClr.toFixed(2)} m at ${minDeg}°`);
  }

  return api;
}
