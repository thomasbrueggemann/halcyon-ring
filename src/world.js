// ── The torus shell: terrain floor, curved hull, glass ceiling, ribs, spokes ─
// Ground geometry (road, river, lanes, hills) all derives from layout.js so the
// world agrees with the city, transit and NPC systems built on top of it.
//
// The ground is not a textured plane: it is a splat-mapped terrain that blends
// meadow, rock and river shingle by slope, altitude and distance to the water,
// with baked concavity shading and a detail octave to kill macro tiling. The
// river is a depth-shaded animated surface, not a translucent stripe. The road
// is built from a real cross-section — crown, kerbs, gravel shoulders — rather
// than a flat two-vertex ribbon.

const RING_SEGS = 768;

// Sweep a 2D cross-section profile (in the tube plane) around the ring.
// Profile points are given as [lat, h] pairs. Returns a BufferGeometry with UVs
// (u around ring, v along profile arc length). Kept for city.js / transit.js.
function sweepProfile(profile, { uScale = 1, vScale = 1, thetaFrom = 0, thetaTo = Math.PI * 2, segs = RING_SEGS } = {}) {
  const nP = profile.length;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const p = new THREE.Vector3();

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
      const iPrev = Math.max(0, i - 1), iNext = Math.min(nP - 1, i + 1);
      const dLat = profile[iNext][0] - profile[iPrev][0];
      const dH = profile[iNext][1] - profile[iPrev][1];
      const len = Math.hypot(dLat, dH) || 1;
      const nLat = -dH / len, nH = dLat / len;
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

// Points along the tube circle from angle a to b (measured from tube-bottom).
function tubeArc(a, b, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = a + (b - a) * (i / steps);
    const lat = RT * Math.sin(t);
    const h = CHORD_DROP - RT * Math.cos(t);
    pts.push([lat, h]);
  }
  return pts;
}

// ── Ribbon along an arbitrary (theta, lat) centerline, draped at hFn, width
// `half`. Both may be numbers or fns(theta, lat, i). Optionally a closed loop.
function _dthetaW(a, b) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
function buildRibbon(pts, { half, hFn, closed = false, uScale = 0.15, vScale = 1 }) {
  const n = pts.length;
  const halfAt = typeof half === 'function' ? half : () => half;
  const hAt = typeof hFn === 'function' ? hFn : () => hFn;
  const positions = [], uvs = [], indices = [];
  const p = new THREE.Vector3();
  let uAccum = 0;
  for (let i = 0; i < n; i++) {
    const cur = pts[i];
    const prev = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const tS = _dthetaW(prev.theta, next.theta) * RF;
    const tL = next.lat - prev.lat;
    const tlen = Math.hypot(tS, tL) || 1;
    const nS = -tL / tlen, nL = tS / tlen;                 // perpendicular in (s, lat)
    const hw = halfAt(cur.theta, cur.lat, i);
    if (i > 0) {
      const dpS = _dthetaW(pts[i - 1].theta, cur.theta) * RF;
      uAccum += Math.hypot(dpS, cur.lat - pts[i - 1].lat);
    }
    // Sample the height at each EDGE, not once at the centreline: a 3 m wide
    // ribbon laid flat across a sloping bank buries one edge and leaves the
    // other hanging in mid-air, which is what made the hillside streams look
    // like sheets of glass floating off the slope.
    const tA = cur.theta + (nS * hw) / RF, lA = cur.lat + nL * hw;
    const tB = cur.theta - (nS * hw) / RF, lB = cur.lat - nL * hw;
    torusPosition(tA, lA, hAt(tA, lA, i), p);
    positions.push(p.x, p.y, p.z);
    torusPosition(tB, lB, hAt(tB, lB, i), p);
    positions.push(p.x, p.y, p.z);
    const u = uAccum * uScale;
    uvs.push(u, 0, u, vScale);
  }
  const total = closed ? n : n - 1;
  for (let i = 0; i < total; i++) {
    const a = 2 * i, b = 2 * ((i + 1) % n);
    indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ── Ribbon with a real cross-section ────────────────────────────────────────
// profile: [[lateralOffset, heightAboveBase, v], ...] swept along the
// centerline. This is what turns a grey stripe into a road with a cambered
// carriageway, kerbs and shoulders that fall away into the verge.
function buildProfiledRibbon(pts, profile, baseHFn, { closed = false, uScale = 1 / 12 } = {}) {
  const n = pts.length, nP = profile.length;
  const positions = [], uvs = [], indices = [];
  const p = new THREE.Vector3();
  let uAccum = 0;
  for (let i = 0; i < n; i++) {
    const cur = pts[i];
    const prev = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const tS = _dthetaW(prev.theta, next.theta) * RF;
    const tL = next.lat - prev.lat;
    const tlen = Math.hypot(tS, tL) || 1;
    const nS = -tL / tlen, nL = tS / tlen;
    const baseH = baseHFn(cur.theta, cur.lat);
    if (i > 0) {
      const dpS = _dthetaW(pts[i - 1].theta, cur.theta) * RF;
      uAccum += Math.hypot(dpS, cur.lat - pts[i - 1].lat);
    }
    const u = uAccum * uScale;
    for (let k = 0; k < nP; k++) {
      const [off, dh, v] = profile[k];
      torusPosition(cur.theta + (nS * off) / RF, cur.lat + nL * off, baseH + dh, p);
      positions.push(p.x, p.y, p.z);
      // (across, along): the surface texture's S axis runs ACROSS the ribbon, so
      // features authored as lengthwise stripes — wheel-polish bands in the
      // asphalt — actually land in the wheel paths instead of banding across it
      uvs.push(v, u);
    }
  }
  const total = closed ? n : n - 1;
  for (let i = 0; i < total; i++) {
    const a = i * nP, b = ((i + 1) % n) * nP;
    for (let k = 0; k < nP - 1; k++) {
      // wound so the face normal points UP (toward the spin axis); the mirrored
      // order leaves the whole carriageway back-facing and therefore invisible
      indices.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// Sample a full-ring centerline: latFn(theta) → [{theta, lat}] (closed loop).
function _ringCenter(latFn, n) {
  const pts = [];
  for (let i = 0; i < n; i++) { const theta = (i / n) * Math.PI * 2; pts.push({ theta, lat: latFn(theta) }); }
  return pts;
}

function _sstep(a, b, x) {
  if (a === b) return x < a ? 0 : 1;
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

// ════════════════════════════════════════════════════════════════════════════
// Terrain material: three-layer splat with a detail octave
// ════════════════════════════════════════════════════════════════════════════
function makeTerrainMaterial(textures) {
  const mat = new THREE.MeshStandardMaterial({
    map: textures.grass,           // sets USE_MAP so `uv` and the chunks exist
    normalMap: textures.grassN,    // sets USE_NORMALMAP / TANGENTSPACE_NORMALMAP
    roughnessMap: textures.grassR,
    roughness: 1.0, metalness: 0,
    vertexColors: true,            // baked concavity shading
    side: THREE.DoubleSide,
  });
  // per-layer metres-per-tile (uv is in metres, so this is 1/tileSize)
  const scale = new THREE.Vector3(1 / 9, 1 / 7, 1 / 6);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.gMap = { value: textures.grass };
    shader.uniforms.rMap = { value: textures.rock };
    shader.uniforms.sMap = { value: textures.sand };
    shader.uniforms.gNrm = { value: textures.grassN };
    shader.uniforms.rNrm = { value: textures.rockN };
    shader.uniforms.sNrm = { value: textures.sandN };
    shader.uniforms.dMap = { value: textures.detail };
    shader.uniforms.uSplatScale = { value: scale };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aSplat;
        varying vec3 vSplat;
        varying vec2 vTerrUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSplat = aSplat;
        vTerrUv = uv;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D gMap, rMap, sMap, gNrm, rNrm, sNrm, dMap;
        uniform vec3 uSplatScale;
        varying vec3 vSplat;
        varying vec2 vTerrUv;`)
      .replace('#include <map_fragment>', `
        vec3 w = vSplat / max(vSplat.x + vSplat.y + vSplat.z, 1e-4);
        vec2 uvG = vTerrUv * uSplatScale.x;
        vec2 uvR = vTerrUv * uSplatScale.y;
        vec2 uvS = vTerrUv * uSplatScale.z;
        vec3 albedo = texture2D(gMap, uvG).rgb * w.x
                    + texture2D(rMap, uvR).rgb * w.y
                    + texture2D(sMap, uvS).rgb * w.z;
        // detail octave at a different, non-harmonic rate breaks up the macro
        // repeat that any single tiling ground texture shows across 5.9 km
        float det = texture2D(dMap, vTerrUv * 0.31).r;
        float det2 = texture2D(dMap, vTerrUv * 0.043).r;
        albedo *= mix(1.0, det * det2, 0.55);
        diffuseColor.rgb *= albedo;`)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness * mix(1.0, 0.72, w.z);`)
      .replace('#include <normal_fragment_maps>', `
        vec3 mapN = texture2D(gNrm, uvG).xyz * w.x
                  + texture2D(rNrm, uvR).xyz * w.y
                  + texture2D(sNrm, uvS).xyz * w.z;
        mapN = mapN * 2.0 - 1.0;
        mapN.xy *= normalScale;
        normal = normalize(tbn * mapN);`);
  };
  mat.customProgramCacheKey = () => 'terrain-splat-v1';
  return mat;
}

// ════════════════════════════════════════════════════════════════════════════
// Water material: depth-shaded, two-layer animated ripples, shoreline foam
// ════════════════════════════════════════════════════════════════════════════
function makeWaterMaterial(textures) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    normalMap: textures.waterN1,
    roughness: 0.15, metalness: 0.02, envMapIntensity: 0.7,
    transparent: true, side: THREE.DoubleSide, depthWrite: false,
  });
  const uniforms = {
    uTime: { value: 0 },
    wN1: { value: textures.waterN1 },
    wN2: { value: textures.waterN2 },
    uShallow: { value: new THREE.Color(0x5fb3ad) },
    uDeep: { value: new THREE.Color(0x123f52) },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aDepth;
        varying float vDepth;
        varying vec2 vWUv;
        varying vec3 vTanW, vBitW, vNrmW;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vDepth = aDepth;
        vWUv = uv;
        vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
        // the ring's local frame: up points at the spin axis, lat is world Y
        vNrmW = normalize(vec3(-wp.x, 0.0, -wp.z));
        vBitW = vec3(0.0, 1.0, 0.0);
        vTanW = normalize(cross(vBitW, vNrmW));`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform sampler2D wN1, wN2;
        uniform vec3 uShallow, uDeep;
        varying float vDepth;
        varying vec2 vWUv;
        varying vec3 vTanW, vBitW, vNrmW;`)
      .replace('#include <map_fragment>', `
        float d = clamp(vDepth / 2.6, 0.0, 1.0);
        vec3 wcol = mix(uShallow, uDeep, d * d * (3.0 - 2.0 * d));
        // shoreline: a bright wet band plus a thin line of foam
        float shore = 1.0 - smoothstep(0.0, 0.32, vDepth);
        float foam = smoothstep(0.62, 1.0, shore)
                   * (0.45 + 0.35 * sin(vWUv.x * 1.7 + uTime * 1.6 + vWUv.y * 0.9));
        diffuseColor.rgb *= mix(wcol, vec3(0.82, 0.90, 0.92), clamp(foam, 0.0, 0.8));
        diffuseColor.a *= mix(0.62, 0.95, d) + foam * 0.2;`)
      .replace('#include <normal_fragment_maps>', `
        // two ripple sheets at different scales drifting against each other —
        // the cross-beat is what stops a flat plane reading as a flat plane
        vec2 r1 = vWUv * 0.085 + vec2(uTime * 0.013, uTime * 0.006);
        vec2 r2 = vWUv * 0.031 - vec2(uTime * 0.008, -uTime * 0.011);
        vec3 n1 = texture2D(wN1, r1).xyz * 2.0 - 1.0;
        vec3 n2 = texture2D(wN2, r2).xyz * 2.0 - 1.0;
        vec3 nl = normalize(vec3(n1.xy * 0.34 + n2.xy * 0.22, 1.0));
        normal = normalize(nl.x * vTanW + nl.y * vBitW + nl.z * vNrmW);`);
  };
  mat.customProgramCacheKey = () => 'water-v1';
  return mat;
}

function buildWorld(scene, textures, colliders) {
  const world = new THREE.Group();
  scene.add(world);

  const floorEdge = Math.asin(FLOOR_LAT / RT);   // tube angle where terrain meets hull
  const glassHalf = 38 * DEG;
  const m = new THREE.Matrix4();

  // ══════════════════════════════════════════════════════════════════════════
  // Terrain
  // ══════════════════════════════════════════════════════════════════════════
  // One height grid, sampled once; slope, normals, splat weights and concavity
  // shading are all derived from it rather than re-querying terrainH (which
  // would otherwise cost ~450k extra evaluations at load).
  const TSEG = 1600, TNP = 56;
  {
    const H = new Float32Array((TSEG + 1) * TNP);
    const latOf = (i) => -FLOOR_LAT + (2 * FLOOR_LAT) * (i / (TNP - 1));
    const dLat = (2 * FLOOR_LAT) / (TNP - 1);
    const dArc = CIRCUMFERENCE / TSEG;
    for (let s = 0; s <= TSEG; s++) {
      const theta = (s / TSEG) * Math.PI * 2;
      for (let i = 0; i < TNP; i++) H[s * TNP + i] = terrainH(theta, latOf(i));
    }
    const hAt = (s, i) => H[((s % TSEG) + TSEG) % TSEG * TNP + Math.max(0, Math.min(TNP - 1, i))];

    const positions = new Float32Array((TSEG + 1) * TNP * 3);
    const uvs = new Float32Array((TSEG + 1) * TNP * 2);
    const colors = new Float32Array((TSEG + 1) * TNP * 3);
    const splat = new Float32Array((TSEG + 1) * TNP * 3);
    const p = new THREE.Vector3();

    for (let s = 0; s <= TSEG; s++) {
      const theta = (s / TSEG) * Math.PI * 2;
      // Key the shingle off the REAL shoreline, not the nominal channel: where a
      // set-piece pad has lifted the ground the channel still nominally passes
      // through, and beaching that would carpet the plaza in sand.
      const e = waterEdges(theta);
      for (let i = 0; i < TNP; i++) {
        const lat = latOf(i), h = H[s * TNP + i];
        const k = s * TNP + i;
        torusPosition(theta, lat, h, p);
        positions[k * 3] = p.x; positions[k * 3 + 1] = p.y; positions[k * 3 + 2] = p.z;
        uvs[k * 2] = theta * RF; uvs[k * 2 + 1] = lat;

        // slope from the grid
        const dS = (hAt(s + 1, i) - hAt(s - 1, i)) / (2 * dArc);
        const dL = (hAt(s, i + 1) - hAt(s, i - 1)) / (2 * dLat);
        const slope = Math.hypot(dS, dL);

        // ── splat weights ──
        const alat = Math.abs(lat);
        // a little deterministic jitter so the layer boundaries aren't clean arcs
        const jit = 0.5 * Math.sin(theta * 53.0 + lat * 0.83) + 0.5 * Math.sin(theta * 17.0 - lat * 0.31);
        const outside = e.dry ? 1e9 : Math.max(0, Math.max(e.lo - lat, lat - e.hi));
        let sand = 1 - _sstep(0.0, 4.2 + jit * 1.4, outside);         // bed + beach
        if (onIsland(theta, lat)) sand = Math.max(sand, 0.4);         // island shingle
        let rock = _sstep(0.62 + jit * 0.06, 1.05, slope);           // scree on steep faces
        rock = Math.max(rock, _sstep(57 + jit * 2.5, 62, alat));      // bare rock right up at the glass
        rock *= 1 - sand;
        const grass = Math.max(0, 1 - rock - sand);
        splat[k * 3] = grass; splat[k * 3 + 1] = rock; splat[k * 3 + 2] = sand;

        // ── baked concavity shading ──
        // Compare the point to a wider neighbourhood: sitting in a hollow means
        // less of the sky is visible, which is most of what AO buys you here.
        let avg = 0, cnt = 0;
        for (let ds = -3; ds <= 3; ds += 3) {
          for (let di = -3; di <= 3; di += 3) {
            if (!ds && !di) continue;
            avg += hAt(s + ds, i + di); cnt++;
          }
        }
        avg /= cnt;
        let ao = 1 - _sstep(0.0, 2.6, avg - h) * 0.42;
        ao *= 1 - _sstep(0.6, 3.0, slope) * 0.15;
        // damp everything slightly under the trees' preferred belt so the
        // valley sides don't read as uniformly lit cardboard
        const tint = 0.94 + 0.06 * Math.sin(theta * 7.0 + lat * 0.05);
        colors[k * 3] = ao * tint;
        colors[k * 3 + 1] = ao * tint;
        colors[k * 3 + 2] = ao * tint * 0.99;
      }
    }

    const indices = [];
    for (let s = 0; s < TSEG; s++) {
      for (let i = 0; i < TNP - 1; i++) {
        const a = s * TNP + i, b = a + TNP;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSplat', new THREE.BufferAttribute(splat, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const floor = new THREE.Mesh(geo, makeTerrainMaterial(textures));
    floor.receiveShadow = true;
    world.add(floor);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Hull, ribs, spokes, hub
  // ══════════════════════════════════════════════════════════════════════════
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xbcdcee, transparent: true, opacity: 0.13, roughness: 0.03,
    metalness: 0, transmission: 0, side: THREE.DoubleSide, depthWrite: false,
    envMapIntensity: 1.6,
  });
  const hullA = new THREE.Mesh(
    sweepProfile(tubeArc(floorEdge, Math.PI - glassHalf, 20), { uScale: 1 / 24, vScale: 1 / 24 }), glassMat);
  const hullB = new THREE.Mesh(
    sweepProfile(tubeArc(-(Math.PI - glassHalf), -floorEdge, 20), { uScale: 1 / 24, vScale: 1 / 24 }), glassMat);
  const glass = new THREE.Mesh(
    sweepProfile(tubeArc(Math.PI - glassHalf, Math.PI + glassHalf, 16), { uScale: 1 / 24, vScale: 1 / 24 }), glassMat);
  world.add(hullA, hullB, glass);

  const ribMat = new THREE.MeshStandardMaterial({ color: 0x7d838d, roughness: 0.42, metalness: 0.75 });
  const ribGeo = new THREE.TorusGeometry(RT - 0.6, 0.85, 6, 64);
  const ribCount = 128;
  const ribs = new THREE.InstancedMesh(ribGeo, ribMat, ribCount);
  {
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3(1, 1, 1);
    const euler = new THREE.Euler();
    for (let i = 0; i < ribCount; i++) {
      const theta = (i / ribCount) * Math.PI * 2;
      torusPosition(theta, 0, CHORD_DROP, p);
      euler.set(0, -theta, 0);
      q.setFromEuler(euler);
      m.compose(p, q, sc);
      ribs.setMatrixAt(i, m);
    }
  }
  world.add(ribs);

  // ── Longitudinal glazing stringers ──
  const stringerTs = [];
  for (let t = floorEdge + 0.10; t < Math.PI - 0.06; t += 0.24) stringerTs.push(t, -t);
  stringerTs.push(Math.PI);
  for (const t of stringerTs) {
    const lat = RT * Math.sin(t);
    const h = CHORD_DROP - RT * Math.cos(t);
    const heavy = Math.abs(Math.abs(t) - (Math.PI - glassHalf)) < 0.14 || t === Math.PI;
    const ringGeo = new THREE.TorusGeometry(RF - h, heavy ? 1.0 : 0.5, 6, 256);
    const stringer = new THREE.Mesh(ringGeo, ribMat);
    stringer.rotation.x = Math.PI / 2;
    stringer.position.y = lat;
    world.add(stringer);
  }

  // ── Spokes ──
  const spokeTex = textures.hull.clone();
  spokeTex.repeat.set(3, 26);
  const spokeMat = new THREE.MeshStandardMaterial({ map: spokeTex, color: 0xd7dde4, roughness: 0.42, metalness: 0.45 });
  const spokeGroup = new THREE.Group();
  const apexH = CHORD_DROP + RT;
  for (const theta of SPOKE_THETAS) {
    const base = groundH(theta, 0, Infinity);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 6.5, apexH + 40, 16), spokeMat);
    shaft.applyMatrix4(placementMatrix(theta, 0, base + (apexH + 40) / 2 - 2, 0, 1));
    shaft.castShadow = true;
    spokeGroup.add(shaft);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 10.5, 6, 16), spokeMat);
    collar.applyMatrix4(placementMatrix(theta, 0, base + 3, 0, 1));
    spokeGroup.add(collar);
    for (let k = 0; k < 4; k++) {
      const ang = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 34, 8), spokeMat);
      strut.position.set(Math.cos(ang) * 9, 14, Math.sin(ang) * 9);
      strut.lookAt(new THREE.Vector3(Math.cos(ang) * 2, 30, Math.sin(ang) * 2));
      strut.rotateX(Math.PI / 2);
      const g = new THREE.Group();
      g.add(strut);
      g.applyMatrix4(placementMatrix(theta, 0, base, 0, 1));
      spokeGroup.add(g);
    }
  }
  world.add(spokeGroup);

  // ── Central hub ──
  {
    const hub = new THREE.Group();
    const hubMat = new THREE.MeshStandardMaterial({ color: 0xaab0b8, roughness: 0.45, metalness: 0.6 });
    hub.add(new THREE.Mesh(new THREE.CylinderGeometry(60, 60, 220, 24), hubMat));
    const hubRing = new THREE.Mesh(new THREE.TorusGeometry(120, 14, 10, 48), hubMat);
    hubRing.rotation.x = Math.PI / 2;
    hub.add(hubRing);
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
  }

  const RIBBON_SEGS = 1600;
  const stoneMat = new THREE.MeshStandardMaterial({
    map: textures.concrete, normalMap: textures.concreteN,
    color: 0xb3aea4, roughness: 0.86, metalness: 0.04,
  });

  // ══════════════════════════════════════════════════════════════════════════
  // River bridges — the only crossings between the two banks
  // ══════════════════════════════════════════════════════════════════════════
  // Built BEFORE the road so their height patches are registered when the road
  // and the approach paths query groundH.
  const bridgeRailPosts = [];
  const bridgeDeckGeos = [];
  const bridgePierGeos = [];
  for (const b of RIVER_BRIDGES) {
    const halfS = 3.2;                              // 6.4 m wide deck
    const s0 = b.theta * RF - halfS, s1 = b.theta * RF + halfS;
    const hLo = terrainH(b.theta, b.latLo), hHi = terrainH(b.theta, b.latHi);
    const apex = Math.max(hLo, hHi) + 1.35;
    const mid = (b.latLo + b.latHi) / 2;
    addHeightPatch({ s0, s1, lat0: b.latLo, lat1: mid, h0: hLo + 0.12, h1: apex, axis: 'lat' });
    addHeightPatch({ s0, s1, lat0: mid, lat1: b.latHi, h0: apex, h1: hHi + 0.12, axis: 'lat' });
    const topAt = (lat) => (lat < mid
      ? hLo + 0.12 + (apex - hLo - 0.12) * (lat - b.latLo) / (mid - b.latLo)
      : apex + (hHi + 0.12 - apex) * (lat - mid) / (b.latHi - mid));

    // Deck slab, built as a swept ribbon rather than a row of boxes — stepped
    // boxes on an arched span read as a staircase from the bank.
    {
      const N = 30;
      const pts = [];
      for (let k = 0; k <= N; k++) pts.push({ theta: b.theta, lat: b.latLo + (b.latHi - b.latLo) * (k / N) });
      // sweep across the arc direction: centreline runs along lat, so build it
      // directly rather than through buildRibbon (which assumes +theta travel)
      const pos = [], idx = [], uv = [];
      const v3 = new THREE.Vector3();
      for (let k = 0; k <= N; k++) {
        const la = pts[k].lat, top = topAt(la);
        for (const [dsOff, dh] of [[-halfS, 0], [halfS, 0], [halfS, -0.5], [-halfS, -0.5]]) {
          torusPosition(b.theta + dsOff / RF, la, top + dh, v3);
          pos.push(v3.x, v3.y, v3.z);
          uv.push((dsOff + halfS) / 2, la / 2);
        }
      }
      for (let k = 0; k < N; k++) {
        const a = k * 4, c = (k + 1) * 4;
        idx.push(a, a + 1, c, a + 1, c + 1, c);                 // top
        idx.push(a + 3, c + 3, a + 2, a + 2, c + 3, c + 2);     // underside
        idx.push(a, c, a + 3, a + 3, c, c + 3);                 // side face
        idx.push(a + 1, a + 2, c + 1, a + 2, c + 2, c + 1);     // other side
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      bridgeDeckGeos.push(g);
    }
    // piers in the water
    for (const f of [0.33, 0.67]) {
      const la = b.latLo + (b.latHi - b.latLo) * f;
      const bedH = terrainH(b.theta, la);
      const hgt = topAt(la) - bedH - 0.4;
      if (hgt < 0.6) continue;
      const pier = new THREE.CylinderGeometry(0.85, 1.1, hgt, 10);
      pier.translate(0, hgt / 2, 0);
      const g = pier.clone();
      g.applyMatrix4(placementMatrix(b.theta, la, bedH, 0, 1));
      bridgePierGeos.push(g);
    }
    // parapets: posts, a continuous top rail, and a collider wall each side
    for (const eS of [s0, s1]) {
      const eTheta = eS / RF;
      for (let k = 0; k <= 11; k++) {
        const la = b.latLo + (b.latHi - b.latLo) * (k / 11);
        bridgeRailPosts.push({ theta: eTheta, lat: la, h: topAt(la) });
      }
      const RN = 24;
      for (let k = 0; k < RN; k++) {
        const la = b.latLo + (b.latHi - b.latLo) * (k / RN);
        const lb = b.latLo + (b.latHi - b.latLo) * ((k + 1) / RN);
        const seg = new THREE.BoxGeometry(lb - la + 0.03, 0.11, 0.16);
        seg.applyMatrix4(placementMatrix(eTheta, (la + lb) / 2, (topAt(la) + topAt(lb)) / 2 + 0.94, 0, 1));
        bridgeDeckGeos.push(seg);
      }
      colliders.addBox(eTheta, mid, 0.22, (b.latHi - b.latLo) / 2, 1.15);
    }
    b.apex = apex; b.s0 = s0; b.s1 = s1; b.topAt = topAt;
  }
  if (bridgeDeckGeos.length) {
    const deck = new THREE.Mesh(mergeGeometries(bridgeDeckGeos), stoneMat);
    deck.castShadow = true; deck.receiveShadow = true;
    world.add(deck);
  }
  if (bridgePierGeos.length) {
    const piers = new THREE.Mesh(mergeGeometries(bridgePierGeos), stoneMat);
    piers.castShadow = true;
    world.add(piers);
  }
  if (bridgeRailPosts.length) {
    const postGeo = new THREE.BoxGeometry(0.14, 0.95, 0.14);
    postGeo.translate(0, 0.48, 0);
    const posts = new THREE.InstancedMesh(postGeo, stoneMat, bridgeRailPosts.length);
    bridgeRailPosts.forEach((pp, i) => { placementMatrix(pp.theta, pp.lat, pp.h, 0, 1, m); posts.setMatrixAt(i, m); });
    posts.castShadow = true;
    world.add(posts);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // The ring road
  // ══════════════════════════════════════════════════════════════════════════
  // Cross-section: cambered carriageway between raised kerbs, gravel shoulders
  // falling away into the verge. roadH() is the same smoothed grade that
  // terrainH benches the ground to, so the built road and the walkable ground
  // are the same surface by construction.
  const roadCenter = _ringCenter(roadLat, RIBBON_SEGS);
  {
    const H = ROAD_HALF;
    const carriageway = buildProfiledRibbon(roadCenter, [
      [-H, 0.02, 0.0],
      [-H * 0.55, ROAD_CROWN * 0.72, 0.22],
      [0, ROAD_CROWN, 0.5],
      [H * 0.55, ROAD_CROWN * 0.72, 0.78],
      [H, 0.02, 1.0],
    ], (theta) => roadH(theta) + 0.05, { closed: true, uScale: 1 / 11 });
    const roadTex = textures.asphalt.clone();
    roadTex.repeat.set(1, 1);
    const roadNrm = textures.asphaltN.clone();
    roadNrm.repeat.set(1, 1);
    const roadRgh = textures.asphaltR.clone();
    roadRgh.repeat.set(1, 1);
    const road = new THREE.Mesh(carriageway, new THREE.MeshStandardMaterial({
      map: roadTex, normalMap: roadNrm, roughnessMap: roadRgh,
      roughness: 0.92, metalness: 0.0, color: 0xffffff,
    }));
    road.receiveShadow = true;
    world.add(road);

    // lane markings, drawn as their own thin strips just above the surface so
    // they follow the camber and stay crisp regardless of the asphalt tiling
    const markMat = new THREE.MeshStandardMaterial({
      color: 0xe8e3d2, roughness: 0.75, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const centreMat = new THREE.MeshStandardMaterial({
      color: 0xd8bd5c, roughness: 0.75, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    for (const [off, mat] of [[-H + 0.55, markMat], [H - 0.55, markMat]]) {
      const strip = buildProfiledRibbon(roadCenter, [
        [off - 0.07, 0.0, 0], [off + 0.07, 0.0, 1],
      ], (theta) => roadH(theta) + 0.075, { closed: true, uScale: 1 / 11 });
      const meshS = new THREE.Mesh(strip, mat);
      world.add(meshS);
    }
    // dashed centre line: skip every other segment
    {
      const DASH = 4.0, GAP = 5.0;
      let acc = 0;
      const geos = [];
      for (let i = 0; i < RIBBON_SEGS; i++) {
        const a = roadCenter[i], bnext = roadCenter[(i + 1) % RIBBON_SEGS];
        const seg = Math.hypot(_dthetaW(a.theta, bnext.theta) * RF, bnext.lat - a.lat);
        const phase = acc % (DASH + GAP);
        acc += seg;
        if (phase > DASH) continue;
        const g = buildProfiledRibbon([a, bnext], [
          [-0.09, 0.0, 0], [0.09, 0.0, 1],
        ], (theta) => roadH(theta) + ROAD_CROWN + 0.03, { closed: false, uScale: 1 });
        geos.push(g);
      }
      if (geos.length) world.add(new THREE.Mesh(mergeGeometries(geos), centreMat));
    }

    // kerbs + gravel shoulders
    const kerbMat = new THREE.MeshStandardMaterial({
      map: textures.concrete, normalMap: textures.concreteN,
      color: 0xc4bfb4, roughness: 0.88, metalness: 0.02, side: THREE.DoubleSide,
    });
    const shoulderMat = new THREE.MeshStandardMaterial({
      map: textures.dirt, normalMap: textures.dirtN,
      roughness: 1.0, metalness: 0, side: THREE.DoubleSide,
    });
    for (const sgn of [-1, 1]) {
      const kerb = buildProfiledRibbon(roadCenter, [
        [sgn * H, 0.02, 0.0],
        [sgn * H, CURB_H, 0.25],
        [sgn * (H + 0.34), CURB_H, 0.75],
        [sgn * (H + 0.34), CURB_H - 0.03, 1.0],
      ], (theta) => roadH(theta) + 0.05, { closed: true, uScale: 1 / 3 });
      world.add(new THREE.Mesh(kerb, kerbMat));

      const shoulder = buildProfiledRibbon(roadCenter, [
        [sgn * (H + 0.34), CURB_H - 0.03, 0.0],
        [sgn * (H + ROAD_SHLDR * 0.6), CURB_H - 0.10, 0.5],
        [sgn * (H + ROAD_SHLDR), -0.04, 1.0],
      ], (theta) => roadH(theta) + 0.05, { closed: true, uScale: 1 / 4 });
      const sm = new THREE.Mesh(shoulder, shoulderMat);
      sm.receiveShadow = true;
      world.add(sm);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Water: the river, the lake, and the hillside tributaries
  // ══════════════════════════════════════════════════════════════════════════
  const waterMat = makeWaterMaterial(textures);
  {
    const SEG = 1500, ACROSS = 9;
    const positions = new Float32Array((SEG + 1) * ACROSS * 3);
    const uvs = new Float32Array((SEG + 1) * ACROSS * 2);
    const depths = new Float32Array((SEG + 1) * ACROSS);
    const normals = new Float32Array((SEG + 1) * ACROSS * 3);
    const p = new THREE.Vector3();
    for (let s = 0; s <= SEG; s++) {
      const theta = (s / SEG) * Math.PI * 2;
      const e = waterEdges(theta);
      const c = Math.cos(theta), sn = Math.sin(theta);
      for (let i = 0; i < ACROSS; i++) {
        const f = i / (ACROSS - 1);
        const lat = e.dry ? e.lo : e.lo + (e.hi - e.lo) * f;
        const k = s * ACROSS + i;
        torusPosition(theta, lat, WATER_H, p);
        positions[k * 3] = p.x; positions[k * 3 + 1] = p.y; positions[k * 3 + 2] = p.z;
        uvs[k * 2] = theta * RF; uvs[k * 2 + 1] = lat;
        depths[k] = e.dry ? 0 : Math.max(0, WATER_H - terrainH(theta, lat));
        normals[k * 3] = -c; normals[k * 3 + 1] = 0; normals[k * 3 + 2] = -sn;
      }
    }
    const indices = [];
    for (let s = 0; s < SEG; s++) {
      for (let i = 0; i < ACROSS - 1; i++) {
        const a = s * ACROSS + i, b = a + ACROSS;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));
    geo.setIndex(indices);
    const river = new THREE.Mesh(geo, waterMat);
    river.renderOrder = 2;
    world.add(river);
  }

  // ── Tributary streams: thin water ribbons down the hillside, pinched to
  //    nothing where they pass under the road ──
  {
    const geos = [];
    for (const t of TRIBS) {
      const N = 56;
      const pts = [], halfs = [], hs = [];
      for (let k = 0; k <= N; k++) {
        const e = tribEdges(t, k / N);
        pts.push({ theta: e.s / RF, lat: e.lat });
        halfs.push(e.dry ? 0 : e.half);
        hs.push(e.h);
      }
      geos.push(buildRibbon(pts, {
        half: (theta, lat, i) => halfs[i],
        hFn: (theta, lat, i) => hs[i],
        closed: false, uScale: 0.35, vScale: 1,
      }));
    }
    if (geos.length) {
      const streamMat = new THREE.MeshStandardMaterial({
        color: 0x6fa8b0, roughness: 0.12, metalness: 0.05,
        transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: false,
      });
      const streams = new THREE.Mesh(mergeGeometries(geos), streamMat);
      streams.renderOrder = 2;
      world.add(streams);
    }
  }

  // ── Culvert headwalls where each tributary passes under the road ──
  {
    const geos = [];
    for (const cr of CROSSINGS) {
      for (const side of [-1, 1]) {
        const lat = cr.lat + side * (ROAD_HALF + ROAD_SHLDR + 0.7);
        const base = terrainH(cr.theta, lat) - 0.9;
        const wall = new THREE.BoxGeometry(1.0, 1.5, 3.6);
        wall.translate(0, 0.75, 0);
        const g = wall.clone();
        g.applyMatrix4(placementMatrix(cr.theta, lat, base, 0, 1));
        geos.push(g);
      }
    }
    if (geos.length) {
      const heads = new THREE.Mesh(mergeGeometries(geos), stoneMat);
      heads.castShadow = true; heads.receiveShadow = true;
      world.add(heads);
    }
  }

  // ── Road parapets over each culvert, so the crossing reads as a bridge ──
  {
    const posts = [];
    for (const cr of CROSSINGS) {
      for (const side of [-1, 1]) {
        const lat = cr.lat + side * (ROAD_HALF + ROAD_SHLDR + 0.25);
        for (let k = -3; k <= 3; k++) {
          const theta = cr.theta + k * 0.9 / RF;
          posts.push({ theta, lat, h: roadH(theta) + 0.05 });
        }
        colliders.addBox(cr.theta, lat, 3.0, 0.22, 0.85);
      }
    }
    if (posts.length) {
      const pg = new THREE.BoxGeometry(0.16, 0.8, 0.16);
      pg.translate(0, 0.4, 0);
      const mesh = new THREE.InstancedMesh(pg, stoneMat, posts.length);
      posts.forEach((pp, i) => { placementMatrix(pp.theta, pp.lat, pp.h, 0, 1, m); mesh.setMatrixAt(i, m); });
      mesh.castShadow = true;
      world.add(mesh);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Footpaths
  // ══════════════════════════════════════════════════════════════════════════
  {
    const laneTex = textures.dirt.clone(); laneTex.repeat.set(1, 1);
    const laneMat = new THREE.MeshStandardMaterial({
      map: laneTex, normalMap: textures.dirtN, roughness: 1, metalness: 0,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    const geos = [];
    for (const lane of LANES) {
      const N = 48;
      const pts = [];
      for (let k = 0; k <= N; k++) { const q = laneSample(lane, k / N); pts.push({ theta: q.theta, lat: q.lat }); }
      geos.push(buildRibbon(pts, {
        half: 1.35, hFn: (theta, lat) => groundH(theta, lat, Infinity) + 0.05,
        closed: false, uScale: 0.4, vScale: 1,
      }));
    }
    // approach paths from the road up onto each river bridge, and down the far
    // bank — otherwise the spans would be unreachable ornaments
    for (const b of RIVER_BRIDGES) {
      const nearPts = [];
      for (let k = 0; k <= 10; k++) {
        const f = k / 10;
        nearPts.push({ theta: b.theta - (1 - f) * 6 / RF, lat: b.roadLat + (b.latLo - b.roadLat) * f });
      }
      geos.push(buildRibbon(nearPts, {
        half: 1.5, hFn: (theta, lat) => groundH(theta, lat, Infinity) + 0.05, closed: false, uScale: 0.4, vScale: 1,
      }));
      const farPts = [];
      for (let k = 0; k <= 10; k++) {
        const f = k / 10;
        farPts.push({ theta: b.theta + f * 7 / RF, lat: b.latHi + f * 10 });
      }
      geos.push(buildRibbon(farPts, {
        half: 1.5, hFn: (theta, lat) => groundH(theta, lat, Infinity) + 0.05, closed: false, uScale: 0.4, vScale: 1,
      }));
    }
    const lanes = new THREE.Mesh(mergeGeometries(geos), laneMat);
    lanes.receiveShadow = true;
    world.add(lanes);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Wispy interior clouds
  // ══════════════════════════════════════════════════════════════════════════
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
      color: 0xffffff, transparent: true, opacity: 0.36, roughness: 1, depthWrite: false,
    });
    const rng = mulberry32(4242);
    const N = 90;
    const clouds = new THREE.InstancedMesh(cloudGeo, cloudMat, N);
    const cm = new THREE.Matrix4();
    for (let i = 0; i < N; i++) {
      placementMatrix(rng() * Math.PI * 2, (rng() - 0.5) * 64, 56 + rng() * 22, rng() * Math.PI * 2, 0.9 + rng() * 1.6, cm);
      clouds.setMatrixAt(i, cm);
    }
    clouds.castShadow = false;
    world.add(clouds);
  }

  return {
    group: world, sweepProfile, tubeArc, waterMat,
    update(t) { waterMat.userData.uniforms.uTime.value = t; },
  };
}
