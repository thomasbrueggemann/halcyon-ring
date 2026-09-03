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
const _txTrn = new THREE.Vector3();   // train world pos for the audio spatializer
const _txEarF = new THREE.Vector3();  // listener forward/up (camera look) for the audio spatializer
const _txEarU = new THREE.Vector3();

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

function buildTransit(scene, colliders, rng, city, textures) {
  // a texture clone with its own tiling — the shared ones carry the repeat
  // their first user wanted
  const tiled = (tex, rx, ry) => { const t = tex.clone(); t.repeat.set(rx, ry); return t; };
  const group = new THREE.Group();
  scene.add(group);
  const RAIL_SEGS = 1200;

  // ── Route planning: threading the guideway through what actually got built ─
  // layout.js draws the guideway from the river outward, and city.js then puts
  // houses and towers wherever the corridors leave room — using this very
  // curve to decide what "room" means. That works in lat, but not in height:
  // the deck rides ~6.5 m up, a two-storey house with a gable reaches 8.3 and a
  // downtown block 19, so the route was quietly running through roofs.
  //
  // Nothing here MOVES a building. The route is re-planned against the city
  // that exists, in this order of preference:
  //   1. steer  — a smooth lat detour around it (layout.setRailDetours), which
  //               is what you want for a house: the line simply curves past it.
  //   2. tunnel — for a tower deep enough to take a bore, the line is instead
  //               pulled onto its centreline and driven straight through.
  //   3. hop    — a gentle rise in the deck to clear a roof, when neither fits.
  //   4. hide   — a block that survives all three was standing exactly where
  //               the guideway has to be; it is never built.
  // Every detour still passes through railLat's station freeze and its hard
  // river/floor clamp, so no amount of steering can push the line into the
  // water or off a platform.
  const ROUTE = (function planRoute() {
    const CORRIDOR = RAIL_HALF + 1.7;    // lateral half-width the deck needs clear
    const UNDER = 0.5;                   // deck underside, below railH
    const HEADROOM = 0.7;                // gap insisted on over a roof
    // Deliberately small. A guideway that swerves 15 m round every gable is
    // worse to look at than one that runs through them: these caps keep a
    // detour to a curve you'd take at line speed, and hand anything bigger to
    // a hop or a bore instead.
    const MAX_STEER = 7, MAX_RISE = 5.0;
    const BORE_HALF = 2.5, BORE_DOWN = 1.2, BORE_UP = 3.3;
    const STEER_SIGMA = 30;              // how gently a detour eases in (m of arc)
    const HOP_SIGMA = 34;
    const recs = new Map();              // collider entry → plan record

    const nearStation = (theta) => {
      for (const st of STATIONS) if (Math.abs(arcDelta(theta, st.theta)) < 62) return true;
      return false;
    };
    const push = () => {
      const det = [], rise = [];
      for (const r of recs.values()) {
        if (r.lat) det.push({ thetaDeg: r.thetaDeg, amt: r.lat, sigma: r.sigma, flat: r.flat });
        if (r.rise) rise.push({ thetaDeg: r.thetaDeg, amt: r.rise, sigma: r.sigma, flat: r.flat });
      }
      setRailDetours(det, rise);
    };
    // Worst conflict per obstacle over the whole ring, with the current route.
    const scan = () => {
      const found = new Map();
      for (let s = 0; s < CIRCUMFERENCE; s += 2.5) {
        const theta = s / RF;
        if (nearStation(theta)) continue;
        const lat = railLat(theta), deck = railH(theta);
        for (const e of colliders.bucketAt(s)) {
          if (e.top < deck - UNDER - HEADROOM) continue;      // the line clears it
          const hArc = e.kind === 'box' ? e.halfArc : e.radius;
          const hLat = e.kind === 'box' ? e.halfLat : e.radius;
          let ds = s - e.s;
          if (ds > CIRCUMFERENCE / 2) ds -= CIRCUMFERENCE;
          else if (ds < -CIRCUMFERENCE / 2) ds += CIRCUMFERENCE;
          if (Math.abs(ds) > hArc + 1.0) continue;
          const dLat = lat - e.lat;
          const need = (hLat + CORRIDOR) - Math.abs(dLat);
          if (need <= 0) continue;
          const prev = found.get(e);
          if (!prev || need > prev.need) {
            found.set(e, { e, need, side: dLat >= 0 ? 1 : -1, deck, hArc, hLat });
          }
        }
      }
      return found;
    };
    // A tower deep enough to keep a jamb either side of the bore and a lintel
    // over it is tunnelled on sight — that is the whole point of running a
    // monorail through a downtown block rather than around it.
    const boreAt = (theta, lat) => ({
      lat: lat === undefined ? railLat(theta) : lat, half: BORE_HALF,
      deckHalf: RAIL_HALF + 0.45,
      y0: railH(theta) - BORE_DOWN, y1: railH(theta) + BORE_UP,
    });
    // Ask the city whether the tower can actually take the hole — a block that
    // is too shallow for a jamb, or too short for a lintel, is better curved
    // around or hopped than deleted.
    // Tested against a bore on the tower's OWN centreline, because that is
    // where the line will be pulled to if this becomes a tunnel — testing it
    // where the route happens to lie right now would reject almost everything.
    const borable = (c) =>
      !!(c.e.tag && c.e.tag.kind === 'block' && city &&
         city.boreFits(c.e.tag, boreAt(c.e.theta, c.e.lat)));
    const record = (c) => {
      let r = recs.get(c.e);
      if (!r) {
        r = {
          e: c.e, mode: borable(c) ? 'tunnel' : 'steer', lat: 0, rise: 0,
          thetaDeg: c.e.theta / DEG, sigma: STEER_SIGMA, flat: c.hArc + 4,
        };
        recs.set(c.e, r);
      }
      return r;
    };

    let pass = 0;
    for (; pass < 7; pass++) {
      push();
      // tunnels are re-centred every pass — the bore has to be square through
      // the tower, and other detours nearby keep moving the line under it
      for (const r of recs.values()) {
        if (r.mode !== 'tunnel') continue;
        const want = r.lat + (r.e.lat - railLat(r.e.theta));
        r.lat = Math.max(-MAX_STEER, Math.min(MAX_STEER, want));
      }
      const found = scan();
      if (!found.size) break;
      let changed = false;
      for (const c of found.values()) {
        const r = record(c);
        if (r.mode === 'tunnel') continue;      // not avoided — re-centred above
        if (r.mode === 'steer') {
          const want = r.lat + c.side * (c.need + 0.8);
          if (Math.abs(want) <= MAX_STEER && pass < 4) { r.lat = want; changed = true; continue; }
          // out of room to steer (or the detours are chasing each other round
          // in circles) — lift the deck over it instead
          r.mode = 'hop';
          r.lat = 0;
          r.flat = c.hArc + 3;
          r.sigma = HOP_SIGMA;                  // a long, gentle climb
          changed = true;
        } else if (r.mode === 'hop') {
          const want = r.rise + (c.e.top + HEADROOM + UNDER) - c.deck + 0.2;
          if (want <= MAX_RISE) { r.rise = want; changed = true; continue; }
          r.mode = 'hide';                      // it was built on the line
          r.rise = 0;
          changed = true;
        }
      }
      if (!changed) break;
    }
    push();

    // ── final audit, and act on the decisions ──
    const bores = [], stats = { steer: 0, tunnel: 0, hop: 0, hidden: 0 };
    for (const r of recs.values()) {
      if (r.mode === 'steer' && r.lat) stats.steer++;
      else if (r.mode === 'hop' && r.rise) stats.hop++;
      else if (r.mode === 'hide') {
        if (city && city.clearSite(r.e.tag)) stats.hidden++;
      } else if (r.mode === 'tunnel') {
        const bore = city && city.pierceBlock(r.e.tag, boreAt(r.e.theta));
        if (bore) { bores.push(bore); stats.tunnel++; continue; }
        // The bore fitted when it was planned on the tower's centreline, but
        // the line never made it there — say so, then take the tower down.
        console.warn(`[transit] no bore @${r.thetaDeg.toFixed(1)}°: line sits ` +
          `${(railLat(r.e.theta) - r.e.lat).toFixed(1)} m off the tower's centre`);
        if (city && city.clearSite(r.e.tag)) stats.hidden++;
      }
    }
    // Anything still overlapping the corridor that is NOT a tunnel we drove
    // through on purpose, or a site we cleared, is a genuine miss.
    let leftN = 0, worst = 0;
    for (const c of scan().values()) {
      const r = recs.get(c.e);
      if (r && (r.mode === 'tunnel' || r.mode === 'hide')) continue;
      leftN++;
      if (c.need > worst) worst = c.need;
    }
    const msg = `[transit] route: ${stats.steer} detours, ${stats.tunnel} tunnels, ` +
                `${stats.hop} hops, ${stats.hidden} sites cleared, ${leftN} left ` +
                `(worst ${worst.toFixed(1)} m) after ${pass + 1} passes`;
    if (leftN) console.warn(msg); else console.log(msg);
    return { bores, stats, recs };
  })();

  // ── swept guideway geometry: a profile carried along the winding path ──
  // UVs are metres: u along the path, v around the profile, both over `tile`,
  // so a panel texture keeps its size whatever the profile or the winding.
  function sweepPath(profile, segs, tile = 4) {
    const nP = profile.length;
    const pos = [], uv = [], idx = [];
    const vOff = [0];
    for (let i = 1; i < nP; i++) vOff.push(vOff[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
    let arc = 0;
    for (let s = 0; s <= segs; s++) {
      const theta = (s / segs) * Math.PI * 2;
      _railFrame(theta);
      _railPos(theta, _txP);
      if (s > 0) arc += _txP.distanceTo(_txB);
      _txB.copy(_txP);
      for (let i = 0; i < nP; i++) {
        const u = profile[i][0], v = profile[i][1];
        _txA.copy(_txP).addScaledVector(_txRight, u).addScaledVector(_txUp2, v);
        pos.push(_txA.x, _txA.y, _txA.z);
        uv.push(arc / tile, vOff[i] / tile);
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
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  // deck: a shallow channel (top flat, outer lips drop 0.45 m)
  // Riveted steel panels, 1.5 m a side (four to a 6 m tile), rust creeping
  // out of the seams — the guideway is a box girder, not a grey extrusion.
  const deckMat = new THREE.MeshStandardMaterial({
    map: tiled(textures.metal, 1, 1), normalMap: tiled(textures.metalN, 1, 1),
    roughnessMap: tiled(textures.metalR, 1, 1),
    color: 0xd4d9de, roughness: 1, metalness: 0.4, side: THREE.DoubleSide,
  });
  deckMat.normalScale.set(0.8, 0.8);
  const deck = new THREE.Mesh(sweepPath([
    [-RAIL_HALF, -0.45], [-RAIL_HALF, 0], [RAIL_HALF, 0], [RAIL_HALF, -0.45],
  ], RAIL_SEGS, 6), deckMat);
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

  // ── tunnel dressing: a portal lip at each mouth and lamps down the bore ──
  // The bore itself is walled by the pierced building (city.pierceBlock), so
  // this is only what makes it read as a transit tunnel rather than a hole.
  if (ROUTE.bores.length) {
    const portalMat = new THREE.MeshStandardMaterial({ color: 0x4a525c, roughness: 0.8, metalness: 0.25 });
    const boreLampMat = new THREE.MeshStandardMaterial({
      color: 0xffe9b8, emissive: 0xffd98a, emissiveIntensity: 1.4, roughness: 0.5,
    });
    for (const b of ROUTE.bores) {
      const midY = (b.y0 + b.y1) / 2, hgt = b.y1 - b.y0;
      for (const sgn of [-1, 1]) {
        const th = b.theta + sgn * (b.arcHalf + 0.18) / RF;
        const lat = railLat(b.theta);
        // lintel + jambs, standing 0.35 m proud of the face
        const lintel = new THREE.Mesh(new THREE.BoxGeometry(b.half * 2 + 0.9, 0.45, 0.36), portalMat);
        lintel.applyMatrix4(placementMatrix(th, lat, b.y1 + 0.22, 0, 1));
        group.add(lintel);
        for (const dl of [-(b.half + 0.22), b.half + 0.22]) {
          const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.45, hgt + 0.45, 0.36), portalMat);
          jamb.applyMatrix4(placementMatrix(th, lat + dl, midY + 0.22, 0, 1));
          group.add(jamb);
        }
      }
      // lamps along the crown of the bore
      const n = Math.max(2, Math.round(b.arcHalf));
      for (let k = 0; k < n; k++) {
        const th = b.theta + (-b.arcHalf + 0.6 + (k + 0.5) * (2 * b.arcHalf - 1.2) / n) / RF;
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.35), boreLampMat);
        lamp.applyMatrix4(placementMatrix(th, railLat(b.theta), b.y1 - 0.14, 0, 1));
        group.add(lamp);
      }
    }
  }

  // ── support pylons every ~30 m, ground → deck bottom (variable height) ──
  // The column geometry is unit height and scaled per instance, so a texture
  // on it would smear 1 tile over 3 m on one pylon and 14 m on the next. The
  // vertex shader scales the v coordinate by the instance's y scale instead —
  // one panel course per 2.4 m of column, whatever its height.
  const pylonMat = new THREE.MeshStandardMaterial({
    map: tiled(textures.metal, 1, 1 / 2.4), normalMap: tiled(textures.metalN, 1, 1 / 2.4),
    roughnessMap: tiled(textures.metalR, 1, 1 / 2.4),
    color: 0xc2c8ce, roughness: 1, metalness: 0.45,
  });
  pylonMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', [
      '#include <uv_vertex>',
      '#ifdef USE_INSTANCING',
      '  float pylonH = length(instanceMatrix[1].xyz);',
      '  vMapUv.y *= pylonH; vNormalMapUv.y *= pylonH; vRoughnessMapUv.y *= pylonH;',
      '#endif',
    ].join('\n'));
  };
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
  // Paving on the deck, the same stone as a coursed masonry wall on the fill
  // below it. UVs are metres / 3 (deck) and metres / 2.4 (walls).
  const paveTex = [tiled(textures.plaza, 1, 1), tiled(textures.plazaN, 1, 1), tiled(textures.plazaR, 1, 1)];
  const paveMat = new THREE.MeshStandardMaterial({
    map: paveTex[0], normalMap: paveTex[1], roughnessMap: paveTex[2],
    color: 0xd9d6d0, roughness: 1, metalness: 0.05,
  });
  const wallMat = new THREE.MeshStandardMaterial({
    map: paveTex[0], normalMap: paveTex[1], roughnessMap: paveTex[2],
    color: 0xa39e96, roughness: 1, metalness: 0.05, side: THREE.DoubleSide,
  });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x394654, roughness: 0.6, metalness: 0.4 });
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0x2c6e8f, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
  const benchMat = new THREE.MeshStandardMaterial({ color: 0x7a5a38, roughness: 0.9 });
  const postPositions = [];
  const stationInfos = [];

  // ── platform + walk-up ramp as ONE embankment: a paved deck over a
  //    masonry-faced fill that runs down into the terrain on both sides and
  //    is capped at both ends. A floating slab beside a solid ramp read as two
  //    different structures; this is one. Groups: 0 = paving, 1 = walls. ──
  function buildEmbankment(samples, innerLat, outerLat) {
    const DT = 3, WT = 2.4;
    const pos = [], uv = [], idx = [], v = new THREE.Vector3();
    const push = (th, lat, h, u, w) => { torusPosition(th, lat, h, v); pos.push(v.x, v.y, v.z); uv.push(u, w); };
    const n = samples.length;
    // ring k (6 verts): 0 innerTop/deck 1 outerTop/deck 2 innerTop 3 innerBot 4 outerTop 5 outerBot
    for (let k = 0; k < n; k++) {
      const { s, h } = samples[k], th = s / RF;
      push(th, innerLat, h, s / DT, 0);
      push(th, outerLat, h, s / DT, (outerLat - innerLat) / DT);
      for (const lat of [innerLat, outerLat]) {
        const bot = Math.min(h, terrainH(th, lat)) - 0.3;
        push(th, lat, h, s / WT, h / WT);
        push(th, lat, bot, s / WT, bot / WT);
      }
    }
    const deckIdx = [], wallIdx = [];
    for (let k = 0; k < n - 1; k++) {
      const a = k * 6, b = a + 6;
      deckIdx.push(a + 0, b + 0, a + 1, a + 1, b + 0, b + 1);
      wallIdx.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);
      wallIdx.push(a + 4, b + 4, a + 5, a + 5, b + 4, b + 5);
    }
    // end caps across the strip
    for (const k of [0, n - 1]) {
      const { s, h } = samples[k], th = s / RF;
      const base = pos.length / 3;
      for (const lat of [innerLat, outerLat]) {
        const bot = Math.min(h, terrainH(th, lat)) - 0.3;
        push(th, lat, h, lat / WT, h / WT);
        push(th, lat, bot, lat / WT, bot / WT);
      }
      wallIdx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex([...deckIdx, ...wallIdx]);
    g.addGroup(0, deckIdx.length, 0);
    g.addGroup(deckIdx.length, wallIdx.length, 1);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, [paveMat, wallMat]);
    m.receiveShadow = true; m.castShadow = true;
    return m;
  }

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
    // one strip: level platform, then the ramp falling at its own grade
    {
      const samples = [];
      const NP = 8, NR = 12;
      for (let k = 0; k <= NP; k++) samples.push({ s: s0 + (s1 - s0) * k / NP, h: PLAT_H });
      for (let k = 1; k <= NR; k++) samples.push({ s: rampS0 + (rampS1 - rampS0) * k / NR, h: PLAT_H + (rampBotH - PLAT_H) * k / NR });
      group.add(buildEmbankment(samples, innerLat, outerLat));
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
  //
  // The car is NOT a solid box. You ride inside one, and a box has no inside:
  // its faces are front-facing, so from a seat you looked straight through the
  // walls and the ride read as standing on a bare deck. The body is built as a
  // shell of panels around a hollow saloon — sills, cant rails, window pillars,
  // door pockets, end walls with a windscreen — so the openings are real
  // openings and the cabin has a floor, a ceiling, seats and grab poles you can
  // see. Geometry is merged per material and shared by all 18 cars; only the
  // livery material differs.
  const CAR_W = 2.44;                  // outer width
  const WALL_T = 0.09;
  const CAR_X = CAR_W / 2 - WALL_T / 2;  // side-panel centreline
  const IN_X = CAR_W / 2 - WALL_T;     // inner face of a side wall
  const FLOOR_Y = 0.30;                // saloon floor (car-local)
  const SILL_Y = 1.04;                 // window sill
  const HEAD_Y = 2.20;                 // window head
  const CEIL_Y = 2.46;                 // ceiling underside
  const ROOF_Y = 2.62;                 // outer roof
  const HALF_L = CAR_LEN / 2;
  const DOOR_HALF = 0.62;              // door leaf half-width, mid-car
  const POST_W = 0.34;                 // window pillar width along the car
  const EYE_LOCAL = FLOOR_Y + EYE_HEIGHT;   // 1.92 — mid-window, as it should be

  // ── shared car geometry, built once ──
  const CAR_GEO = (function buildCarGeometry() {
    const shell = [], liner = [], accent = [], glass = [], lamp = [];
    const box = (w, h, d, x, y, z) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(x, y, z);
      return g;
    };
    const tube = (r, len, x, y, z, axis = 'y') => {
      const g = new THREE.CylinderGeometry(r, r, len, 8);
      if (axis === 'z') g.rotateX(Math.PI / 2);
      g.translate(x, y, z);
      return g;
    };

    // underframe + floor pan (the saloon floor itself is dark rubber, not white
    // — a white-on-white cabin under a full-strength sun blows out to a fog)
    accent.push(box(1.7, 0.34, CAR_LEN - 1.5, 0, 0.12, 0));
    shell.push(box(CAR_W, 0.14, CAR_LEN, 0, FLOOR_Y - 0.07, 0));
    accent.push(box(CAR_W - 2 * WALL_T, 0.03, CAR_LEN - 2 * WALL_T, 0, FLOOR_Y + 0.015, 0));

    // window bays: [corner post][window][post][door][post][window][corner post]
    const winLen = (CAR_LEN - 2 * POST_W - 2 * POST_W - 2 * DOOR_HALF) / 2;
    const winZ = DOOR_HALF + POST_W + winLen / 2;   // ± centre of each window
    for (const sx of [-1, 1]) {
      const x = sx * CAR_X;
      shell.push(box(WALL_T, SILL_Y - FLOOR_Y, CAR_LEN, x, (FLOOR_Y + SILL_Y) / 2, 0));   // sill band
      shell.push(box(WALL_T, ROOF_Y - HEAD_Y, CAR_LEN, x, (HEAD_Y + ROOF_Y) / 2, 0));     // cant rail
      // pillars: two corner, two flanking the door
      for (const pz of [-(HALF_L - POST_W / 2), HALF_L - POST_W / 2,
        -(DOOR_HALF + POST_W / 2), DOOR_HALF + POST_W / 2]) {
        shell.push(box(WALL_T, HEAD_Y - SILL_Y, POST_W, x, (SILL_Y + HEAD_Y) / 2, pz));
      }
      // interior lining over the sill band and the cant rail
      liner.push(box(0.02, SILL_Y - FLOOR_Y - 0.06, CAR_LEN - 2 * WALL_T, sx * (IN_X - 0.01), (FLOOR_Y + SILL_Y) / 2, 0));
      liner.push(box(0.02, CEIL_Y - HEAD_Y, CAR_LEN - 2 * WALL_T, sx * (IN_X - 0.01), (HEAD_Y + CEIL_Y) / 2, 0));
      // door leaves: a dark lower panel in the sill band + a seam up the middle
      accent.push(box(0.035, SILL_Y - FLOOR_Y - 0.04, DOOR_HALF * 2, sx * (CAR_W / 2 + 0.01), (FLOOR_Y + SILL_Y) / 2, 0));
      accent.push(box(0.04, HEAD_Y - FLOOR_Y, 0.05, sx * (CAR_W / 2 + 0.005), (FLOOR_Y + HEAD_Y) / 2, 0));
      // glazing: two saloon windows + the door light
      glass.push(box(0.05, HEAD_Y - SILL_Y, winLen, x, (SILL_Y + HEAD_Y) / 2, winZ));
      glass.push(box(0.05, HEAD_Y - SILL_Y, winLen, x, (SILL_Y + HEAD_Y) / 2, -winZ));
      glass.push(box(0.05, HEAD_Y - SILL_Y - 0.02, DOOR_HALF * 2 - 0.06, x, (SILL_Y + HEAD_Y) / 2, 0));
    }

    // end walls — a windscreen opening 1.72 wide, both ends (the sets run either
    // way round the ring, so every car is a cab car as far as the view goes)
    const JAMB = (CAR_W - 2 * WALL_T - 1.72) / 2;
    for (const sz of [-1, 1]) {
      const z = sz * (HALF_L - WALL_T / 2);
      shell.push(box(CAR_W, SILL_Y - FLOOR_Y + 0.14, WALL_T, 0, (FLOOR_Y + SILL_Y) / 2 - 0.07, z));
      shell.push(box(CAR_W, ROOF_Y - HEAD_Y, WALL_T, 0, (HEAD_Y + ROOF_Y) / 2, z));
      for (const sx of [-1, 1]) {
        shell.push(box(JAMB, HEAD_Y - SILL_Y, WALL_T, sx * (CAR_W / 2 - JAMB / 2), (SILL_Y + HEAD_Y) / 2, z));
      }
      glass.push(box(1.72, HEAD_Y - SILL_Y, 0.05, 0, (SILL_Y + HEAD_Y) / 2, z));
      // lining, so the end of the saloon is a wall and not a white void
      const zi = z - sz * (WALL_T / 2 + 0.01);
      liner.push(box(CAR_W - 2 * WALL_T, SILL_Y - FLOOR_Y, 0.02, 0, (FLOOR_Y + SILL_Y) / 2, zi));
      liner.push(box(CAR_W - 2 * WALL_T, CEIL_Y - HEAD_Y, 0.02, 0, (HEAD_Y + CEIL_Y) / 2, zi));
      for (const sx of [-1, 1]) {
        liner.push(box(JAMB, HEAD_Y - SILL_Y, 0.02, sx * (CAR_W / 2 - JAMB / 2), (SILL_Y + HEAD_Y) / 2, zi));
      }
      // marker light bar under the windscreen
      lamp.push(box(1.1, 0.12, 0.06, 0, SILL_Y - 0.22, sz * (HALF_L + 0.02)));
    }

    // roof: outer skin + a slim equipment fairing, and the ceiling below it
    shell.push(box(CAR_W, ROOF_Y - CEIL_Y, CAR_LEN, 0, (CEIL_Y + ROOF_Y) / 2, 0));
    shell.push(box(1.5, 0.12, CAR_LEN - 1.2, 0, ROOF_Y + 0.06, 0));
    liner.push(box(CAR_W - 2 * WALL_T, 0.03, CAR_LEN - 2 * WALL_T, 0, CEIL_Y - 0.015, 0));
    lamp.push(box(0.42, 0.05, CAR_LEN - 1.4, 0, CEIL_Y - 0.05, 0));   // ceiling light strip

    // saloon fittings: bench seats under the windows, poles, ceiling handrails
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const cz = sz * winZ;
        accent.push(box(0.52, 0.08, winLen - 0.1, sx * (IN_X - 0.26), 0.76, cz));         // seat pan
        accent.push(box(0.07, 0.44, winLen - 0.1, sx * (IN_X - 0.035), 1.02, cz));        // backrest
        accent.push(box(0.5, 0.36, 0.07, sx * (IN_X - 0.26), 0.54, cz - (winLen - 0.1) / 2 + 0.05));
        accent.push(box(0.5, 0.36, 0.07, sx * (IN_X - 0.26), 0.54, cz + (winLen - 0.1) / 2 - 0.05));
        accent.push(tube(0.035, CEIL_Y - FLOOR_Y, sx * 0.62, (FLOOR_Y + CEIL_Y) / 2, cz)); // grab pole
      }
      accent.push(tube(0.03, CAR_LEN - 1.0, sx * 0.62, CEIL_Y - 0.22, 0, 'z'));            // handrail
    }

    const merge = (arr) => mergeGeometries(arr);
    return {
      shell: merge(shell), liner: merge(liner), accent: merge(accent),
      glass: merge(glass), lamp: merge(lamp),
    };
  })();

  const carLinerMat = new THREE.MeshStandardMaterial({ color: 0xb6c0c8, roughness: 0.9 });
  const carAccentMat = new THREE.MeshStandardMaterial({ color: 0x39434e, roughness: 0.65, metalness: 0.35 });
  const carGlassMat = new THREE.MeshStandardMaterial({
    color: 0xbcd9e8, roughness: 0.08, metalness: 0.15,
    transparent: true, opacity: 0.14, side: THREE.DoubleSide,
  });
  const carLampMat = new THREE.MeshStandardMaterial({
    color: 0xfdf6e2, emissive: 0xfff2cc, emissiveIntensity: 0.85, roughness: 0.4,
  });
  const carShellMats = {};

  function makeCar(bodyColor) {
    if (!carShellMats[bodyColor]) {
      carShellMats[bodyColor] = new THREE.MeshStandardMaterial({
        color: bodyColor, roughness: 0.35, metalness: 0.3,
      });
    }
    const car = new THREE.Group();
    const shell = new THREE.Mesh(CAR_GEO.shell, carShellMats[bodyColor]);
    shell.castShadow = true; shell.receiveShadow = true;
    const liner = new THREE.Mesh(CAR_GEO.liner, carLinerMat);
    const accent = new THREE.Mesh(CAR_GEO.accent, carAccentMat);
    accent.castShadow = true;
    const glass = new THREE.Mesh(CAR_GEO.glass, carGlassMat);
    const lamp = new THREE.Mesh(CAR_GEO.lamp, carLampMat);
    car.add(shell, liner, accent, glass, lamp);
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

  // Standing position (feet) inside the saloon of the lead car — on the aisle
  // centreline, forward of the middle so the windscreen is ahead of you and the
  // door is behind. 0.18 is the car origin above the deck, FLOOR_Y the saloon
  // floor above that.
  const SEAT_FWD = HALF_L - 1.6;
  function seatPos(train, out) {
    _railFrame(train.theta);
    _railPos(train.theta, _txSeat);
    _txSeat.addScaledVector(_txRight, train.lane)
      .addScaledVector(_txUp2, 0.18 + FLOOR_Y + 0.02)
      .addScaledVector(_txFwd, train.dir * SEAT_FWD);
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

  // One light for the saloon you are actually standing in. Eighteen cars' worth
  // of interior lighting would cost more than the rest of the ring put together;
  // the emissive ceiling strip carries the other seventeen.
  const cabinLight = new THREE.PointLight(0xfff1d4, 0, 11, 2);
  group.add(cabinLight);

  const api = {
    group, trains, stationInfos, player: null, audio: null, prompt: null, route: ROUTE,
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
        // out through the doorway, not up through the roof — there is a cabin
        // above your head now
        player.vel.addScaledVector(_txRight, Math.sign(tr.lane) * 3.2);
        player.vel.addScaledVector(_txUp2, 1.4);
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

    // ── train audio: position + speed + brake state for each train's
    //    synthesized monorail sound (spatialized about the player's ears) ──
    const au = api.audio;
    if (au && au.ctx) {
      const p = api.player;
      const list = [];
      for (const tr of trains) {
        _railPos(tr.theta, _txTrn);
        list.push({
          id: tr.id, x: _txTrn.x, y: _txTrn.y, z: _txTrn.z, speed: tr.v,
          braking: tr.state === 'brake' || (tr.state === 'accel' && tr.v < 1.5),
        });
      }
      // anchor the listener's ears to the first-person camera (mouse look):
      // forward = where the camera looks, up = the camera's up vector
      const cam = p.camera;
      _txEarF.set(0, 0, -1).applyQuaternion(cam.quaternion);
      _txEarU.set(0, 1, 0).applyQuaternion(cam.quaternion);
      au.updateTrains(list, p.pos.x, p.pos.y, p.pos.z, _txEarF, _txEarU);
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
    cabinLight.intensity = 0;
    if (player && player.ride) {
      const tr = player.ride.train;
      seatPos(tr, _seatW);
      cabinLight.position.copy(_seatW).addScaledVector(_txUp2, 1.7);
      cabinLight.intensity = 9;
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
