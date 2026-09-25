// ── npcs.js — living population of the ring (people, animals) + zero-g tumble ──
// Loaded right AFTER props.js. Builds a handful of InstancedMeshes (≤6 total)
// and drives ~155 agents each frame with allocation-free matrix writes.
//
// Behaviour under spin gravity: people stroll the road + winding LANES, idle,
// chat in facing pairs, sit by the river; dogs trot beside their humans, cats
// perch/dart near houses, ducks float the river/lake, herons + swifts fly slow
// sinusoidal arcs high overhead and IGNORE gravity failures entirely.
//
// When the flywheel stalls (gravityScale falls below 0.5) every GROUND agent is
// kicked into a wild 3-D tumble — same physics as props.js (soft-bounce off
// groundH + the hull cross-section) — and becomes a soft obstacle that deflects
// the flying player. When spin returns they fall, crumple, and stand back up.

// Module-level temporaries — never allocate in the hot path.
const _nUp   = new THREE.Vector3();
const _nTan  = new THREE.Vector3();
const _nP    = new THREE.Vector3();
const _nQ    = new THREE.Quaternion();
const _nQy   = new THREE.Quaternion();
const _nQz   = new THREE.Quaternion();
const _nDq   = new THREE.Quaternion();
const _nScl  = new THREE.Vector3();
const _nMat  = new THREE.Matrix4();
const _nCol  = new THREE.Color();
const _nT    = {};
const _nCam  = new THREE.Vector3();
const _NAX_X = new THREE.Vector3(1, 0, 0);
const _NAX_Y = new THREE.Vector3(0, 1, 0);
const _NAX_Z = new THREE.Vector3(0, 0, 1);

const NPC_BODY_HALF = HUMAN_HALF; // human feet → mass centre (figures.js)
const NPC_DUCK_H    = WATER_H;  // river water surface height (config.js)
const NPC_KICK_G    = 0.5;      // gravityScale falling-edge that triggers tumble

// collision resolution against the static registry (player.colliders) —
// grounded agents push out of buildings/props exactly like the player does;
// sustained contact steers the agent away instead of grinding on the wall.
const NPC_COL_R_HUMAN  = 0.38;  // human push-out radius (buffer above the 0.3 acceptance check)
const NPC_COL_R_QUAD   = 0.34;  // dog/cat push-out radius
const NPC_COL_R_DUCK   = 0.32;  // duck push-out radius
const NPC_COL_R_TARGET = 0.55;  // radius used to vet an idle/dart/zoom target spot
const NPC_STEER_HITS   = 14;    // consecutive staggered hits before a walker turns back
const NPC_REROUTE_HITS = 14;    // additional staggered hits before a full reroute

function buildNPCs(scene, rng) {
  const group = new THREE.Group();
  scene.add(group);

  // A private rng for per-frame retargeting so we never perturb the shared
  // world-gen rng after build. Seeded deterministically.
  const nrng = mulberry32((WORLD_SEED ^ 0x0b1efab1) >>> 0);

  // ── palettes ──────────────────────────────────────────────────────────────
  // Tops run the range of what people actually wear — lots of navy, grey,
  // white and denim, a few saturated pieces — so a crowd reads as a crowd and
  // not as a box of crayons.
  const TOPS = [
    0xe9e6df, 0xf4f1ea, 0x2b3448, 0x1f2a3d, 0x6b7078, 0x3d4148, 0x8a8f96,
    0x9c3b35, 0x2f5d7c, 0x4c6b4a, 0xc9a24a, 0x7d4a6b, 0xd98f6e, 0x5e7fa6,
    0x1c1c1e, 0xa8b6c4, 0xb7472a, 0x3f7f78, 0xe3c9a0, 0x6d4c3d,
  ];
  const BOTTOMS = [
    0x2c3a52, 0x34465f, 0x46597a, 0x1e1f24, 0x2a2b30, 0x5a5146, 0x8a7a5e,
    0xb3a58a, 0x4a4f57, 0x3a3228, 0x6b2f34, 0x7a8a9a,
  ];
  const SKIN = [0xf3d2bb, 0xeac0a0, 0xdca883, 0xc98f67, 0xb07650, 0x8d5a3b, 0x6b4129, 0x4f2f1e, 0xf6dcc8, 0xd9a47c];
  const HAIR = [0x1a1512, 0x2a1d15, 0x3b2a1e, 0x4e3524, 0x6b4a2e, 0x8a6a45, 0xb89466, 0xd2b483, 0x8e3a1e, 0x9a958f, 0xcfcac2, 0x121010];
  const DOGCOL = [0x6b4a30, 0x3a2a20, 0xd8c39a, 0x9a6a3a, 0x2a2a2a, 0xe8ddc8, 0xb88a4e];
  const CATCOL = [0x6b6b6b, 0xc9772f, 0x222222, 0xd8d0c0, 0x4a4a4a, 0x9a8a6a];
  const DUCKCOL = [0x6b5433, 0x8a6b3a, 0xe8e2d5, 0x4a3d28, 0x7a6a55];
  const DUCKHEAD = [0x1f4d2b, 0x5a4630, 0x6b5433, 0x1a3d2a, 0xe8e2d5];
  const BIRDCOL = [0x8a97a2, 0x6b7580, 0x2a2f34, 0xa8b2ba];

  const pick = (arr) => arr[(nrng() * arr.length) | 0];

  // ── figures (figures.js): articulated meshes posed on the GPU ──────────────
  const humanGeo = buildHumanGeometry();
  const dogGeo = buildQuadGeometry('dog'), catGeo = buildQuadGeometry('cat');
  const duckGeo = buildDuckGeometry(), birdGeo = buildBirdGeometry();
  const humanRig = makeHumanMaterials();
  const dogRig = makeQuadMaterials('dog'), catRig = makeQuadMaterials('cat');
  const duckRig = makeDuckMaterials(), birdRig = makeBirdMaterials();
  const rigs = [humanRig, dogRig, catRig, duckRig, birdRig];

  // ── weighted spawn hotspots (theta in radians) ──────────────────────────────
  const HOTSPOTS = [
    { theta: 6 * DEG,   w: 6 },   // Meridian Plaza
    { theta: 183 * DEG, w: 6 },   // Gamma market
    { theta: 24 * DEG,  w: 2 },   // East residential
    { theta: 148 * DEG, w: 2 },   // North residential
    { theta: 300 * DEG, w: 2 },   // West residential
  ];
  for (const st of STATIONS) HOTSPOTS.push({ theta: st.theta, w: 2 });
  const HOT_TOTAL = HOTSPOTS.reduce((a, b) => a + b.w, 0);
  function hotTheta() {
    let r = nrng() * HOT_TOTAL;
    for (const hs of HOTSPOTS) { if ((r -= hs.w) <= 0) return hs.theta + (nrng() - 0.5) * 0.08; }
    return HOTSPOTS[0].theta;
  }

  // cache each lane's approximate arc length for constant-speed traversal.
  const laneLens = LANES.map(lane => {
    let len = 0; let px = null;
    for (let k = 0; k <= 12; k++) {
      const s = laneSample(lane, k / 12);
      if (px) len += Math.hypot(arcDelta(px.theta, s.theta), s.lat - px.lat);
      px = s;
    }
    return Math.max(6, len);
  });

  // ── agents ──────────────────────────────────────────────────────────────────
  const agents = [];
  const humans = [], quads = [], ducks = [], birds = [];

  function newHuman() {
    const child = nrng() < 0.1;                                    // ~10% children
    const scale = child ? (0.56 + nrng() * 0.14) : (0.9 + nrng() * 0.17);
    // style: hair (0 short 1 long 2 bun 3 bald), lower (0 trousers 1 shorts
    // 2 skirt), flags (1 short sleeves, 2 chatter, 4 feminine build)
    const fem = nrng() < 0.5;
    const hair = fem ? (nrng() < 0.55 ? 1 : nrng() < 0.6 ? 2 : 0) : (nrng() < 0.12 ? 3 : nrng() < 0.08 ? 1 : 0);
    const lower = fem ? (nrng() < 0.4 ? 2 : nrng() < 0.2 ? 1 : 0) : (nrng() < 0.18 ? 1 : 0);
    const flags = (nrng() < 0.45 ? 1 : 0) + (fem ? 4 : 0) + (child ? 8 : 0);
    const a = {
      kind: 'human', scale, half: NPC_BODY_HALF * scale,
      theta: 0, lat: 0, yaw: 0, gh: 0,
      color: pick(TOPS), bottom: pick(BOTTOMS), skin: pick(SKIN),
      hairCol: (hair !== 3 && nrng() < 0.18 && !child) ? pick(HAIR.slice(9)) : pick(HAIR.slice(0, 9)),
      style: [nrng() * 100, hair, lower, flags],
      mode: 'idle', speed: 0.8 + nrng() * 0.9,
      lane: null, laneT: 0, laneDir: 1, laneLen: 1, side: (nrng() < 0.5 ? -1 : 1) * (0.3 + nrng() * 1.4),
      roadDir: nrng() < 0.5 ? 1 : -1,
      anchorTheta: 0, anchorLat: 0, baseYaw: 0,
      state: 'walk', sit: false,
      phase: nrng() * 6.28, swayF: 0.6 + nrng() * 0.6,
      // collision
      colHits: 0, anchorValidated: false,
      // tumble
      airborne: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      rot: new THREE.Vector3(), quat: new THREE.Quaternion(), recover: 0, splay: nrng() * 6.28,
    };
    agents.push(a); humans.push(a); return a;
  }

  // place a human as a lane walker
  function asLaneWalk(a) {
    const li = (nrng() * LANES.length) | 0;
    a.mode = 'lane'; a.state = 'walk'; a.lane = LANES[li]; a.laneLen = laneLens[li];
    a.laneT = nrng(); a.laneDir = nrng() < 0.5 ? 1 : -1;
    sampleLane(a);
  }
  // place a human as a road walker near a hotspot
  function asRoadWalk(a) {
    a.mode = 'road'; a.state = 'walk';
    a.theta = hotTheta(); a.roadDir = nrng() < 0.5 ? 1 : -1;
    a.lat = roadLat(a.theta) + a.side * (ROAD_HALF + 1.3);
  }
  function asIdle(a, theta, lat) {
    a.mode = 'anchor'; a.state = 'idle';
    a.anchorTheta = theta; a.anchorLat = lat; a.theta = theta; a.lat = lat;
    a.baseYaw = nrng() * 6.28;
  }

  // ~112 humans
  for (let i = 0; i < 112; i++) {
    const a = newHuman();
    const r = nrng();
    if (r < 0.52)       asLaneWalk(a);
    else if (r < 0.76)  asRoadWalk(a);
    else if (r < 0.85)  { const th = hotTheta(); asIdle(a, th, roadLat(th) + a.side * (ROAD_HALF + 1.8)); }
    else if (r < 0.86)  asRoadWalk(a);
    else {
      // sit by the river beach
      const th = nrng() * Math.PI * 2;
      const we = waterEdges(th);
      const lat = (we.dry ? riverLat(th) : we.lo) - (1.0 + nrng() * 1.5);
      asIdle(a, th, lat); a.sit = true; a.state = 'sit';
      a.baseYaw = Math.PI / 2;    // face the water (+lat of the spot)
    }
  }

  // chat pairs near hotspots (3 pairs)
  for (let p = 0; p < 3; p++) {
    const th = hotTheta(); const baseLat = roadLat(th) + (nrng() < 0.5 ? -1 : 1) * (ROAD_HALF + 1.4 + nrng() * 2.5);
    const a = newHuman(), b = newHuman();
    const off = 0.55;
    asIdle(a, th - off / RF, baseLat - 0.25); asIdle(b, th + off / RF, baseLat + 0.25);
    a.state = b.state = 'chat';
    a.style[3] |= 2; b.style[3] |= 2;
    const darc = arcDelta(a.theta, b.theta), dl = b.lat - a.lat;
    a.baseYaw = Math.atan2(dl, darc); b.baseYaw = Math.atan2(-dl, -darc);
  }

  // ── animals ──────────────────────────────────────────────────────────────
  function newQuad(sub) {
    const isCat = sub === 'cat';
    const scale = isCat ? (0.9 + nrng() * 0.2) : (0.8 + nrng() * 0.4);
    const a = {
      kind: sub, scale, half: QUAD_PIV[sub].half * scale,
      theta: 0, lat: 0, yaw: 0, gh: 0,
      color: isCat ? pick(CATCOL) : pick(DOGCOL),
      sitK: 0, pth: 0, plat: 0,
      state: 'trot', phase: nrng() * 6.28, speed: isCat ? 0.6 : 1.3,
      host: null, orbit: nrng() * 6.28, zoom: 0, zoomT: 2 + nrng() * 6,
      anchorTheta: 0, anchorLat: 0, dart: 0,
      colHits: 0,
      airborne: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      rot: new THREE.Vector3(), quat: new THREE.Quaternion(), recover: 0, splay: nrng() * 6.28,
    };
    agents.push(a); quads.push(a); return a;
  }
  const dogs = [], cats = [];
  // dogs — one per some human lane/road walker
  const walkerHumans = humans.filter(h => h.mode === 'lane' || h.mode === 'road');
  for (let i = 0; i < 14; i++) {
    const d = newQuad('dog'); dogs.push(d);
    d.host = walkerHumans[(nrng() * walkerHumans.length) | 0] || humans[0];
    d.theta = d.host.theta; d.lat = d.host.lat + 0.9;
  }
  // cats — perch near random lane endpoints
  for (let i = 0; i < 12; i++) {
    const c = newQuad('cat'); cats.push(c);
    const li = (nrng() * LANES.length) | 0; const s = laneSample(LANES[li], 0.15 + nrng() * 0.7);
    c.state = 'perch'; c.anchorTheta = s.theta; c.anchorLat = s.lat + (nrng() - 0.5) * 2;
    c.theta = c.anchorTheta; c.lat = c.anchorLat; c.yaw = nrng() * 6.28;
  }

  // ducks — float the river, clustered on the lake at θ≈240°
  function newDuck(theta) {
    const a = {
      kind: 'duck', scale: 0.9 + nrng() * 0.3, half: DUCK_HALF,
      theta, lat: waterEdges(theta).center ?? riverLat(theta),
      yaw: nrng() * 6.28, gh: NPC_DUCK_H, color: pick(DUCKCOL), head: pick(DUCKHEAD),
      state: 'float', phase: nrng() * 6.28, driftDir: nrng() < 0.5 ? 1 : -1, speed: 0.15 + nrng() * 0.15,
      colHits: 0,
      airborne: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      rot: new THREE.Vector3(), quat: new THREE.Quaternion(), recover: 0, splay: nrng() * 6.28,
    };
    agents.push(a); ducks.push(a); return a;
  }
  for (let i = 0; i < 16; i++) newDuck(240 * DEG + (nrng() - 0.5) * 0.16);   // lake cluster
  for (let i = 0; i < 8; i++)  newDuck(nrng() * Math.PI * 2);                // scattered

  // birds — herons (few, slow) + a loose swift flock. They fly and ignore g.
  function newBird(sub, theta, latC, hBase) {
    const a = {
      kind: 'bird', sub, scale: sub === 'heron' ? 1.5 : 0.7,
      theta, birdSpeed: (sub === 'heron' ? 0.05 : 0.11) * (nrng() < 0.5 ? 1 : -1),
      latC, latAmp: 8 + nrng() * 14, latF: 0.05 + nrng() * 0.05, latPh: nrng() * 6.28,
      hBase, hAmp: 3 + nrng() * 5, hF: 0.07 + nrng() * 0.06, hPh: nrng() * 6.28,
      color: sub === 'heron' ? BIRDCOL[0] : pick(BIRDCOL), wingPh: nrng() * 6.28, wingF: sub === 'heron' ? 3.2 : 13,
      airborne: false,
    };
    agents.push(a); birds.push(a); return a;
  }
  newBird('heron', 60 * DEG, -10, 18);
  newBird('heron', 250 * DEG, -25, 22);
  const swiftBaseTh = 190 * DEG, swiftLat = 4, swiftH = 26;
  for (let i = 0; i < 6; i++) newBird('swift', swiftBaseTh + (nrng() - 0.5) * 0.3, swiftLat + (nrng() - 0.5) * 10, swiftH + (nrng() - 0.5) * 8);

  // ── instanced meshes ─────────────────────────────────────────────────────
  // Each species is one InstancedMesh. Per-instance attributes carry the
  // colours (linear), style and the 4-float animation state the shader poses
  // from. Agents write their matrix + anim into their own staging arrays;
  // at the end of the frame only the ones near enough and inside the view are
  // packed into the front of the GPU buffers (mesh.count), so a figure 3 km
  // round the ring costs nothing — in the main pass or the shadow pass.
  function makeInst(geo, rig, list, statics, cullR) {
    const n = Math.max(1, list.length);
    const g = geo.clone();
    const st = [];
    for (const [key, size, fn] of statics) {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(n * size), size);
      attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(key, attr);
      st.push({ attr, size, src: list.map(a => fn(a)) });
    }
    const anim = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    anim.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aAnim', anim);
    const im = new THREE.InstancedMesh(g, rig.mat, n);
    im.customDepthMaterial = rig.depth;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
    im.count = 0;
    list.forEach((a, i) => { a.mtx = new Float32Array(16); a.animv = new Float32Array(4); a.slotIdx = i; });
    im.userData = { list, st, anim, slots: new Array(n).fill(null), cullR2: cullR * cullR };
    group.add(im);
    return im;
  }
  const lin = (hex) => { _nCol.setHex(hex); return [_nCol.r, _nCol.g, _nCol.b]; };
  const humanMesh = makeInst(humanGeo, humanRig, humans, [
    ['aSkin', 3, a => lin(a.skin)], ['aTop', 3, a => lin(a.color)], ['aBottom', 3, a => lin(a.bottom)],
    ['aHair', 3, a => lin(a.hairCol)], ['aStyle', 4, a => a.style],
  ], 260);
  const dogMesh = makeInst(dogGeo, dogRig, dogs, [['aCol', 3, a => lin(a.color)]], 140);
  const catMesh = makeInst(catGeo, catRig, cats, [['aCol', 3, a => lin(a.color)]], 110);
  const duckMesh = makeInst(duckGeo, duckRig, ducks, [['aCol', 3, a => lin(a.color)], ['aCol2', 3, a => lin(a.head)]], 140);
  const birdMesh = makeInst(birdGeo, birdRig, birds, [['aCol', 3, a => lin(a.color)]], 600);
  const meshes = [humanMesh, dogMesh, catMesh, duckMesh, birdMesh];
  function setAnim(a, phase, gait, sit, flail) {
    const v = a.animv;
    v[0] = phase; v[1] = gait; v[2] = sit; v[3] = flail;
  }

  // pack the visible agents of one mesh into its GPU buffers
  const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4(), _sph = new THREE.Sphere();
  function compact(mesh, camPos, useFrustum) {
    const u = mesh.userData;
    const mArr = mesh.instanceMatrix.array, aArr = u.anim.array;
    let k = 0, staticsDirty = false;
    for (const a of u.list) {
      const m = a.mtx;
      const dx = m[12] - camPos.x, dy = m[13] - camPos.y, dz = m[14] - camPos.z;
      if (dx * dx + dy * dy + dz * dz > u.cullR2) continue;
      _sph.center.set(m[12], m[13], m[14]); _sph.radius = 3;
      if (useFrustum && !_frustum.intersectsSphere(_sph)) continue;
      mArr.set(m, k * 16);
      aArr.set(a.animv, k * 4);
      if (u.slots[k] !== a) {
        u.slots[k] = a;
        for (const s of u.st) s.attr.array.set(s.src[a.slotIdx], k * s.size);
        staticsDirty = true;
      }
      k++;
    }
    mesh.count = k;
    mesh.instanceMatrix.needsUpdate = true;
    u.anim.needsUpdate = true;
    if (staticsDirty) for (const s of u.st) s.attr.needsUpdate = true;
  }

  // ── behaviour helpers ─────────────────────────────────────────────────────
  function sampleLane(a) {
    const s = laneSample(a.lane, a.laneT);
    a.theta = s.theta; a.lat = s.lat + a.side;
    a.yaw = s.yaw + (a.laneDir < 0 ? Math.PI : 0);
  }

  // ── collision against the static registry (player.colliders) ───────────────
  function collide(theta, lat, h, radius, player) {
    if (!player || !player.colliders) return null;
    return player.colliders.resolve(theta * RF, lat, h, radius);
  }
  function clampN(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Fold a push-out into a human walker's persistent state (side offset +
  // lane-t / theta) so it survives next frame's full theta/lat recompute —
  // a raw write to a.theta/a.lat here would just get overwritten.
  function applyHumanPush(a, push) {
    if (a.mode === 'lane') {
      a.side = clampN(a.side + push.dlat, -5, 5);
      a.laneT = clampN(a.laneT + push.ds / a.laneLen, 0, 1);
      sampleLane(a);
    } else {
      a.theta += push.ds / RF;
      a.side = clampN(a.side + push.dlat / 3.5, -5, 5);
      a.lat = roadLat(a.theta) + a.side * (ROAD_HALF + 1.3);
    }
  }

  function rerouteHuman(a, player) {
    for (let tries = 0; tries < 4; tries++) {
      if (nrng() < 0.6) asLaneWalk(a); else asRoadWalk(a);
      if (!collide(a.theta, a.lat, groundH(a.theta, a.lat, Infinity) + 0.15, NPC_COL_R_TARGET, player)) break;
    }
  }

  // Push a walking human out of anything it's touching; sustained contact
  // (grinding along a wall) makes it turn back, then fully reroute. A very
  // deep single-frame penetration (spawned/landed inside a big footprint,
  // or wedged where several obstacles overlap) reroutes immediately instead
  // of crawling out — the gentle per-frame nudge can't out-pace it anyway.
  function stepHumanCollision(a, player, doCol) {
    if (!doCol) return;
    const push = collide(a.theta, a.lat, a.gh + 0.15, NPC_COL_R_HUMAN, player);
    if (!push) { a.colHits = 0; return; }
    if (Math.hypot(push.ds, push.dlat) > 1.5) {
      rerouteHuman(a, player);
      a.colHits = 0;
      return;
    }
    applyHumanPush(a, push);
    a.colHits++;
    if (a.colHits === NPC_STEER_HITS) {
      if (a.mode === 'lane') a.laneDir = -a.laneDir; else a.roadDir = -a.roadDir;
    } else if (a.colHits >= NPC_STEER_HITS + NPC_REROUTE_HITS) {
      rerouteHuman(a, player);
      a.colHits = 0;
    }
  }

  // One-time correction for a stationary idle/chat/sit spot that turned out
  // to land inside an obstacle (fountain, planter, stall…).
  function validateAnchorSpot(a, player) {
    if (!player || !player.colliders) return;
    // apply the exact resolved displacement each pass (mirrors player.js) —
    // a normalized fixed-step nudge can fail to converge against box corners.
    for (let tries = 0; tries < 8; tries++) {
      const push = collide(a.anchorTheta, a.anchorLat, groundH(a.anchorTheta, a.anchorLat, Infinity) + 0.15, NPC_COL_R_TARGET, player);
      if (!push) return;
      a.anchorTheta += push.ds / RF;
      a.anchorLat += push.dlat;
    }
  }

  // Dogs/cats/ducks keep theta/lat as their sole authoritative position, so a
  // push-out can just be written directly; sustained contact retargets them.
  function stepQuadCollision(a, player, doCol) {
    if (!doCol) return;
    const push = collide(a.theta, a.lat, a.gh + 0.15, NPC_COL_R_QUAD, player);
    if (!push) { a.colHits = 0; return; }
    a.theta += push.ds / RF; a.lat += push.dlat;
    a.colHits++;
    if (Math.hypot(push.ds, push.dlat) > 1.5 || a.colHits >= NPC_STEER_HITS) {
      if (a.kind === 'dog') { a.zoom = 0; a.orbit = nrng() * 6.28; }
      else { a.dart = -3; }   // forces a fresh (collision-checked) dart target next tick
      a.colHits = 0;
    }
  }

  function stepDuckCollision(a, player, doCol) {
    if (!doCol) return;
    const push = collide(a.theta, a.lat, NPC_DUCK_H + 0.15, NPC_COL_R_DUCK, player);
    if (!push) { a.colHits = 0; return; }
    a.theta += push.ds / RF; a.lat += push.dlat;
    a.colHits++;
    if (a.colHits >= NPC_STEER_HITS) { a.driftDir = -a.driftDir; a.colHits = 0; }
  }

  // Grounded upright matrix (with lean + squash + bob). Writes _nMat.
  function groundedMatrix(a, theta, lat, centerH, yaw, lean, sy) {
    frameQuaternion(theta, _nQ);
    _nQy.setFromAxisAngle(_NAX_Y, yaw); _nQ.multiply(_nQy);
    if (lean) { _nQz.setFromAxisAngle(_NAX_Z, lean); _nQ.multiply(_nQz); }
    _nScl.set(a.scale, a.scale * sy, a.scale);
    torusPosition(theta, lat, centerH, _nP);
    _nMat.compose(_nP, _nQ, _nScl);
  }

  function writeMatrix(a) {
    _nMat.toArray(a.mtx);
  }

  // sidestep the player when very close (planar test in (arc, lat)).
  function avoidPlayer(a, player) {
    if (!player) return;
    const darc = arcDelta(player.theta, a.theta), dl = a.lat - player.lat;
    if (darc * darc + dl * dl < 0.81) {                     // within 0.9 m
      a.lat += (dl >= 0 ? 1 : -1) * 1.6 * 0.016;            // gentle push per frame
    }
  }

  // ── kick everyone airborne on the falling edge ─────────────────────────────
  function kick() {
    for (const a of agents) {
      if (a.kind === 'bird') continue;
      let centerH;
      if (a.kind === 'duck') centerH = NPC_DUCK_H + a.half;
      else centerH = (typeof a.gh === 'number' ? a.gh : groundH(a.theta, a.lat, Infinity)) + a.half;
      torusPosition(a.theta, a.lat, centerH, a.pos);
      frameQuaternion(a.theta, a.quat);
      _nQy.setFromAxisAngle(_NAX_Y, a.yaw || 0); a.quat.multiply(_nQy);
      upAt(a.theta, _nUp); tangentAt(a.theta, _nTan);
      // A small shove, not a launch. The RISE comes from the sustained lift in
      // updateTumble — this only decides which way each body is facing and
       // spinning when it leaves the ground, so nobody goes up in formation.
      a.vel.set((nrng() - 0.5) * 1.1, (nrng() - 0.5) * 1.1, (nrng() - 0.5) * 1.1);
      a.vel.addScaledVector(_nUp, 0.2 + nrng() * 0.5);
      a.vel.addScaledVector(_nTan, (nrng() - 0.5) * 1.6);   // tangential inertia shove
      a.rot.set((nrng() - 0.5) * 4.5, (nrng() - 0.5) * 4.5, (nrng() - 0.5) * 4.5);
      a.airborne = true; a.recover = 0;
    }
  }

  // ── tumble integration (mirrors props.js) ──────────────────────────────────
  let _rising = false;   // true only while spin is returning (gScale increasing)
  let _lift = 0;         // 0..1, from GravitySystem.lift
  function updateTumble(a, dt, gScale, player) {
    worldToTorus(a.pos, _nT);
    upAt(_nT.theta, _nUp);
    a.vel.addScaledVector(_nUp, -G_FULL * gScale * dt);
    // ── the lift ──
    // Eased toward a terminal drift rather than applied as a force, so a long
    // free-fall does not end with the whole population pinned to the glazing:
    // they rise at a steady walking-pace crawl, tumbling, for as long as the
    // spin is gone, then sink back as it returns.
    if (_lift > 0) {
      const vUp = a.vel.dot(_nUp);
      a.vel.addScaledVector(_nUp, (LIFT_RISE * _lift - vUp) * Math.min(1, LIFT_EASE * _lift * dt));
    }
    if (gScale < 0.06) a.vel.multiplyScalar(Math.max(0, 1 - 0.05 * dt));
    a.pos.addScaledVector(a.vel, dt);

    worldToTorus(a.pos, _nT);
    upAt(_nT.theta, _nUp);
    // floor (terrain-aware) soft bounce
    const gp = groundH(_nT.theta, _nT.lat, _nT.h);
    if (_nT.h < gp + a.half) {
      const pen = gp + a.half - _nT.h;
      a.pos.addScaledVector(_nUp, pen);
      const vUp = a.vel.dot(_nUp);
      if (vUp < 0) {
        a.vel.addScaledVector(_nUp, -vUp * 1.3);      // restitution 0.3
        a.vel.multiplyScalar(0.9);
        // Settled, gravity back, lift finished, and the ring is recovering
        // rather than stalling → land. `_rising` alone is only true WHILE the
        // spin is climbing; bodies drifting tens of metres up are still falling
        // long after spin-up completes, so on its own it could never be met
        // again and the whole population bounced forever. Dropping it entirely
        // is worse — half the crowd re-lands in the same frame it was kicked,
        // because spin-down passes through these same values on the way down.
        if (Math.abs(vUp) < 0.9 && gScale > 0.45 && _lift < 0.2 && (_rising || gScale >= 0.995)) {
          land(a, _nT.theta, gp, player);
          return;
        }
      }
    }
    // hull cross-section
    {
      const cx = CHORD_DROP - _nT.h, cy = _nT.lat;
      const dist = Math.hypot(cx, cy), maxR = RT - 1.5;
      if (dist > maxR) {
        const nx = cx / dist, ny = cy / dist, pen = dist - maxR;
        a.pos.addScaledVector(_nUp, nx * pen);
        a.pos.y -= ny * pen;
        a.vel.multiplyScalar(0.5);
      }
    }
    // player deflection — tumbling citizen is a soft obstacle
    if (player) {
      const dx = player.pos.x - a.pos.x, dy = player.pos.y - a.pos.y, dz = player.pos.z - a.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz, R = 0.45 + 0.42;
      if (d2 < R * R && d2 > 1e-6) {
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, nz = dz / d;
        const imp = 2.0;
        player.vel.x += nx * imp; player.vel.y += ny * imp; player.vel.z += nz * imp;
        a.vel.x -= nx * imp; a.vel.y -= ny * imp; a.vel.z -= nz * imp;
        a.pos.x -= nx * (R - d); a.pos.y -= ny * (R - d); a.pos.z -= nz * (R - d);
      }
    }
    // rotate + limb-splay wobble
    _nDq.setFromAxisAngle(_NAX_X, a.rot.x * dt); a.quat.multiply(_nDq);
    _nDq.setFromAxisAngle(_NAX_Y, a.rot.y * dt); a.quat.multiply(_nDq);
    _nDq.setFromAxisAngle(_NAX_Z, a.rot.z * dt); a.quat.multiply(_nDq);
    if (gScale > 0.3) a.rot.multiplyScalar(Math.max(0, 1 - 1.2 * dt));
    a.splay += dt * 9;
    _nScl.setScalar(a.scale);
    _nMat.compose(a.pos, a.quat, _nScl);
    setAnim(a, a.splay, 0, 0, 1);
    writeMatrix(a);
  }

  function land(a, theta, gh, player) {
    a.airborne = false; a.recover = 0.6;
    worldToTorus(a.pos, _nT);
    a.theta = _nT.theta; a.lat = _nT.lat; a.gh = gh;
    a.vel.set(0, 0, 0); a.rot.set(0, 0, 0);
    // don't stand back up inside a building — push clear of anything at the landing spot
    if (player && player.colliders) {
      const r = a.kind === 'human' ? NPC_COL_R_HUMAN : (a.kind === 'duck' ? NPC_COL_R_DUCK : NPC_COL_R_QUAD);
      for (let tries = 0; tries < 4; tries++) {
        const push = collide(a.theta, a.lat, gh + 0.15, r, player);
        if (!push) break;
        a.theta += push.ds / RF; a.lat += push.dlat;
      }
    }
    if (a.kind === 'human') {
      // resume walking along the road from wherever we landed
      if (a.mode === 'lane' || a.mode === 'road') { a.mode = 'road'; a.roadDir = nrng() < 0.5 ? 1 : -1; }
      else { a.anchorTheta = a.theta; a.anchorLat = a.lat; }
    } else if (a.kind === 'duck') {
      a.theta = _nT.theta; a.lat = riverLat(a.theta); a.gh = NPC_DUCK_H;
    } else if (a.kind === 'cat') {
      a.anchorTheta = a.theta; a.anchorLat = a.lat;
    }
  }

  // ── grounded behaviours ────────────────────────────────────────────────────
  function updateHuman(a, dt, tSec, player, doCol) {
    if (a.recover > 0) {
      a.recover -= dt;
      const k = Math.max(0, a.recover / 0.6);        // 1→0: picked up off the floor
      a.gh = groundH(a.theta, a.lat, a.gh);
      groundedMatrix(a, a.theta, a.lat, a.gh + a.half, a.yaw || a.baseYaw, 0, 1);
      setAnim(a, a.phase, 0, a.sit ? 1 : k * k * (3 - 2 * k), 0);
      writeMatrix(a); return;
    }
    if (a.state === 'walk') {
      if (a.mode === 'lane') {
        a.laneT += a.laneDir * a.speed * dt / a.laneLen;
        if (a.laneT >= 1) { a.laneT = 1; a.laneDir = -1; }
        else if (a.laneT <= 0) { a.laneT = 0; a.laneDir = 1; }
        sampleLane(a);
      } else {
        a.theta += a.roadDir * a.speed * dt / RF;
        a.lat = roadLat(a.theta) + a.side * (ROAD_HALF + 1.3);
        a.yaw = roadYawAt(a.theta) + (a.roadDir < 0 ? Math.PI : 0);
      }
      a.gh = groundH(a.theta, a.lat, a.gh);
      stepHumanCollision(a, player, doCol);
      avoidPlayer(a, player);
      // cadence from speed: one full stride (two steps) is ~1.45 m of an
      // adult's leg, shorter for a child, so feet don't skate
      a.phase += dt * a.speed * 4.3 / a.scale;
      groundedMatrix(a, a.theta, a.lat, a.gh + a.half, a.yaw, 0, 1);
      setAnim(a, a.phase, Math.min(1, 0.55 + a.speed * 0.32), 0, 0);
      writeMatrix(a);
    } else {
      // idle / chat / sit — stationary with tiny sway
      if (!a.anchorValidated && player && player.colliders) {
        validateAnchorSpot(a, player);
        a.anchorValidated = true;
      }
      const sway = Math.sin(tSec * a.swayF + a.phase) * (a.state === 'sit' ? 0.03 : 0.06);
      a.gh = groundH(a.anchorTheta, a.anchorLat, a.gh);
      groundedMatrix(a, a.anchorTheta, a.anchorLat, a.gh + a.half, a.baseYaw + sway, 0, 1);
      setAnim(a, a.phase, 0, a.sit ? 1 : 0, 0);
      a.theta = a.anchorTheta; a.lat = a.anchorLat; a.yaw = a.baseYaw;
      writeMatrix(a);
    }
  }

  function updateQuad(a, dt, tSec, player, doCol) {
    if (a.recover > 0) {
      a.recover -= dt;
      a.gh = groundH(a.theta, a.lat, a.gh);
      groundedMatrix(a, a.theta, a.lat, a.gh + a.half, a.yaw, 0, 1);
      setAnim(a, a.phase, 0, Math.max(0, a.recover / 0.6), 0);
      a.pth = a.theta; a.plat = a.lat;
      writeMatrix(a); return;
    }
    if (a.kind === 'dog') {
      // trot beside its human, with occasional zoomies
      const h = a.host;
      a.zoomT -= dt;
      if (a.zoomT <= 0) {
        a.zoom = 1.2 + nrng() * 1.0; a.zoomT = 5 + nrng() * 8;
        // pick a starting orbit phase that isn't already inside an obstacle
        for (let tries = 0; tries < 4; tries++) {
          const cand = nrng() * 6.28;
          const cth = h.theta + Math.cos(cand) * 2.2 / RF, cla = h.lat + Math.sin(cand) * 2.2;
          if (!collide(cth, cla, groundH(cth, cla, Infinity) + 0.15, NPC_COL_R_TARGET, player)) { a.orbit = cand; break; }
        }
      }
      let tTheta, tLat;
      if (a.zoom > 0) {
        a.zoom -= dt; a.orbit += dt * 6;
        tTheta = h.theta + Math.cos(a.orbit) * 2.2 / RF;
        tLat = h.lat + Math.sin(a.orbit) * 2.2;
      } else {
        a.orbit += dt * 2;
        tTheta = h.theta - Math.cos(h.yaw) * 1.0 / RF + 0.4 / RF * Math.sin(a.orbit);
        tLat = h.lat + 0.9 + 0.2 * Math.sin(a.orbit);
      }
      const dth = arcDelta(a.theta, tTheta), dl = tLat - a.lat;
      const dist = Math.hypot(dth, dl);
      if (dist > 0.05) { a.theta += (dth / dist) * Math.min(dist, (a.zoom > 0 ? 4 : 2) * dt) / RF; a.lat += (dl / dist) * Math.min(dist, (a.zoom > 0 ? 4 : 2) * dt); a.yaw = Math.atan2(dl, dth); }
    } else {
      // cat — perch, occasional dart along a short offset
      a.dart -= dt;
      if (a.dart <= -3) {
        a.dart = 1.2;
        let dth, dlat;
        for (let tries = 0; tries < 4; tries++) {
          dth = a.anchorTheta + (nrng() - 0.5) * 8 / RF;
          dlat = a.anchorLat + (nrng() - 0.5) * 5;
          if (!collide(dth, dlat, groundH(dth, dlat, Infinity) + 0.15, NPC_COL_R_TARGET, player)) break;
        }
        a.dartTh = dth; a.dartLat = dlat;
      }
      if (a.dart > 0) {
        const dth = arcDelta(a.theta, a.dartTh), dl = a.dartLat - a.lat, dist = Math.hypot(dth, dl);
        if (dist > 0.03) { a.theta += (dth / dist) * Math.min(dist, 2.2 * dt) / RF; a.lat += (dl / dist) * Math.min(dist, 2.2 * dt); a.yaw = Math.atan2(dl, dth); }
      }
    }
    a.gh = groundH(a.theta, a.lat, a.gh);
    stepQuadCollision(a, player, doCol);
    // gait from how far it actually moved this frame
    const moved = Math.hypot(arcDelta(a.pth, a.theta), a.lat - a.plat);
    a.pth = a.theta; a.plat = a.lat;
    const v = dt > 0 ? Math.min(6, moved / dt) : 0;
    a.phase += v * dt * (a.kind === 'cat' ? 11 : 7.5);
    a.gaitK = (a.gaitK || 0) + (Math.min(1, v * 0.8) - (a.gaitK || 0)) * Math.min(1, dt * 8);
    const wantSit = (a.kind === 'cat' && a.dart <= 0) || (a.kind === 'dog' && a.gaitK < 0.08) ? 1 : 0;
    a.sitK += (wantSit - a.sitK) * Math.min(1, dt * 3);
    const bob = (a.kind === 'dog' && a.zoom > 0) ? Math.abs(Math.sin(a.phase)) * 0.04 : 0;
    groundedMatrix(a, a.theta, a.lat, a.gh + a.half + bob, a.yaw, 0, 1);
    setAnim(a, a.phase, a.gaitK * (1 - a.sitK), a.sitK, 0);
    writeMatrix(a);
  }

  function updateDuck(a, dt, tSec, player, doCol) {
    if (a.recover > 0) { a.recover -= dt; }
    a.theta += a.driftDir * a.speed * dt / RF;
    a.lat += Math.sin(tSec * 0.6 + a.phase) * 0.15 * dt;    // gentle paddle drift
    stepDuckCollision(a, player, doCol);
    // keep within the river band
    const rl = riverLat(a.theta), rh = riverHalf(a.theta);
    if (a.lat > rl + rh - 0.6) a.lat = rl + rh - 0.6;
    if (a.lat < rl - rh + 0.6) a.lat = rl - rh + 0.6;
    a.yaw = a.driftDir > 0 ? 0 : Math.PI;
    a.phase += dt * 3;
    const bob = Math.sin(a.phase) * 0.03;
    groundedMatrix(a, a.theta, a.lat, NPC_DUCK_H + a.half + bob, a.yaw + Math.sin(tSec * 0.4 + a.phase) * 0.2, 0, 1);
    setAnim(a, a.driftDir * 1.7 + a.speed * 9, 0, 0, 0);
    writeMatrix(a);
  }

  function updateBird(a, dt, tSec) {
    a.theta += a.birdSpeed * dt;
    const lat = a.latC + Math.sin(tSec * a.latF + a.latPh) * a.latAmp;
    const h = a.hBase + Math.sin(tSec * a.hF + a.hPh) * a.hAmp;
    // face along travel; the wings flap in the shader (figures.js)
    const yaw = a.birdSpeed > 0 ? 0 : Math.PI;
    frameQuaternion(a.theta, _nQ);
    _nQy.setFromAxisAngle(_NAX_Y, yaw); _nQ.multiply(_nQy);
    _nScl.setScalar(a.scale);
    setAnim(a, a.wingPh, a.wingF, 0, 0);
    torusPosition(a.theta, lat, h, _nP);
    _nMat.compose(_nP, _nQ, _nScl);
    _nMat.toArray(a.mtx);
  }

  // ── per-frame driver ───────────────────────────────────────────────────────
  let prevG = 1;
  let _frameParity = 0;
  function update(dt, gScale, zeroG, player, lift = 0, camera = null) {
    if (prevG >= NPC_KICK_G && gScale < NPC_KICK_G) kick();
    _rising = gScale > prevG + 1e-6;
    _lift = lift;
    prevG = gScale;
    const tSec = performance.now() * 0.001;
    _frameParity ^= 1;   // stagger collision resolve: half the agents per frame

    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.kind === 'bird') { updateBird(a, dt, tSec); continue; }
      if (a.airborne) { updateTumble(a, dt, gScale, player); continue; }
      const doCol = (i & 1) === _frameParity;
      if (a.kind === 'human') updateHuman(a, dt, tSec, player, doCol);
      else if (a.kind === 'duck') updateDuck(a, dt, tSec, player, doCol);
      else updateQuad(a, dt, tSec, player, doCol);
    }

    if (camera) {
      _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_pv);
      camera.getWorldPosition(_nCam);
    } else if (player) _nCam.copy(player.pos);
    for (const m of meshes) compact(m, _nCam, !!camera);
    for (const r of rigs) r.setTime(tSec % 3600);
  }

  return {
    update, agents,
    counts: { humans: humans.length, dogs: quads.filter(q => q.kind === 'dog').length,
      cats: quads.filter(q => q.kind === 'cat').length, ducks: ducks.length, birds: birds.length },
    meshes,
  };
}
