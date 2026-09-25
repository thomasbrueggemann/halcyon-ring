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
        attribute vec3 aCliff;
        varying vec3 vSplat;
        varying vec2 vTerrUv;
        varying vec3 vCliff;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSplat = aSplat;
        vTerrUv = uv;
        vCliff = aCliff;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D gMap, rMap, sMap, gNrm, rNrm, sNrm, dMap;
        uniform vec3 uSplatScale;
        varying vec3 vSplat;
        varying vec2 vTerrUv;
        varying vec3 vCliff;`)
      .replace('#include <map_fragment>', `
        vec3 w = vSplat / max(vSplat.x + vSplat.y + vSplat.z, 1e-4);
        // The terrain UV is the ground PLAN (arc, lat). On a 70° mountain face
        // one metre of lat is three metres of rock, so a plan-mapped texture
        // smears into vertical corduroy. aCliff.xy is the same point mapped as
        // (arc, altitude) instead; blend to it by how steep the face is, and the
        // stone keeps its grain all the way up. Half the tiling rate up there
        // too: a 7 m tile that reads fine underfoot repeats visibly across a
        // 50 m open face.
        vec2 uvBase = mix(vTerrUv, vCliff.xy * 0.5, vCliff.z);
        vec2 uvG = vTerrUv * uSplatScale.x;
        vec2 uvR = uvBase * uSplatScale.y;
        vec2 uvS = vTerrUv * uSplatScale.z;
        vec3 albedo = texture2D(gMap, uvG).rgb * w.x
                    + texture2D(rMap, uvR).rgb * w.y
                    + texture2D(sMap, uvS).rgb * w.z;
        // detail octave at a different, non-harmonic rate breaks up the macro
        // repeat that any single tiling ground texture shows across 5.9 km —
        // in cliff space as well, or the one thing breaking up the repeat is
        // itself smeared into stripes exactly where the repeat is worst
        float det = texture2D(dMap, uvBase * 0.31).r;
        float det2 = texture2D(dMap, uvBase * 0.043).r;
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
  mat.customProgramCacheKey = () => 'terrain-splat-v2';
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
  const TSEG = 1600, TNP = 80;   // 190 m across the tube ≈ 2.4 m per lat step
  // Kept after the build: grass.js reads the meadow weight (splat .x) so the
  // blade field thins onto scree and beaches exactly where the texture does.
  let splatGrid = null, heightGrid = null;
  {
    const H = new Float32Array((TSEG + 1) * TNP);
    heightGrid = H;
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
    const cliff = new Float32Array((TSEG + 1) * TNP * 3);
    splatGrid = new Float32Array(TSEG * TNP);
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
        // Lake shores. `outside` is measured off the RIVER's edges and knows
        // nothing about standing water, so without this the grass runs straight
        // into the lake with no strand at all. Height above the waterline is the
        // right key here: the bowl's own slope decides how wide the beach is, so
        // a shallow bay gets a broad one and a steep bank barely any.
        if (inLake(theta, lat, 2.5)) {
          sand = Math.max(sand, 1 - _sstep(0.0, 1.2 + jit * 0.5, h - lakeSurf(theta, lat, 3))); 
        }
        // Snowline. There is no fourth splat layer, so the caps borrow the
        // sand map — pale and fine-grained — and the vertex colour below
        // brightens it the rest of the way. Brightening the ROCK map instead
        // just turned the brown beige: vertex colour multiplies, so it can
        // lighten a hue but never desaturate one.
        const snow = _sstep(48, 66, h) * (1 - _sstep(1.5, 2.1, slope)) * _sstep(MTN_LAT0 - 6, MTN_LAT0 + 4, alat);
        sand = Math.max(sand, snow);
        let rock = _sstep(0.62 + jit * 0.06, 1.05, slope);           // scree on steep faces
        // The rim goes bare above the tree line. Keyed off ALTITUDE, not lat:
        // the mountain foot wanders ±8 m, and a fixed lat band would run across
        // the headlands and leave rock lying in the bays between them.
        // A spur is the same rim rock thrown across the valley, so it goes bare
        // on the same terms — except the lat gate has to be replaced by "am I
        // standing on a spur", or a buttress 40 m out in the fields stays a
        // grassy loaf while the rim behind it is bare stone.
        const onRim = Math.max(_sstep(MTN_LAT0 - 8, MTN_LAT0, alat),
                               _sstep(2.0, 9.0, spurH(theta, lat)));
        rock = Math.max(rock, _sstep(15 + jit * 2.0, 30, h) * onRim);
        // The bore floor is ordinary corridor ground — the notch is cut before
        // the vault goes over it — so it comes out as a sunlit lawn under a
        // mountain unless we say otherwise. It is a cut rock trench: floor it.
        if (inBore(theta, lat)) { rock = 1; sand = 0; }
        rock *= 1 - sand;
        const grass = Math.max(0, 1 - rock - sand);
        splat[k * 3] = grass; splat[k * 3 + 1] = rock; splat[k * 3 + 2] = sand;
        if (s < TSEG) splatGrid[s * TNP + i] = grass * (1 - _sstep(0.0, 0.25, snow));

        // elevation-mapped UV for the rock layer, plus how far to trust it
        cliff[k * 3] = theta * RF;
        cliff[k * 3 + 1] = h;
        cliff[k * 3 + 2] = _sstep(0.5, 1.6, slope);

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
        // Lift the snow caps the rest of the way (the splat above already put
        // the pale layer there). Only where the ground is genuinely high, so
        // the sheltered gullies stay bare and the caps break along the ridge.
        const r = ao * tint * (1 + snow * 0.75);
        colors[k * 3] = r;
        colors[k * 3 + 1] = r * (1 + snow * 0.04);
        colors[k * 3 + 2] = r * (0.99 + snow * 0.12);
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
    geo.setAttribute('aCliff', new THREE.BufferAttribute(cliff, 3));
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
  // Tunnels through the mountain spurs
  // ══════════════════════════════════════════════════════════════════════════
  // layout.js already cut the notch — the ground through a spur is at corridor
  // level with rock standing 10-40 m either side, and that is what you walk and
  // drive on. All that is missing is the lid. A vault dropped into the notch
  // turns a slot into a bore; a portal ring at each mouth stops it reading as a
  // hole someone forgot to finish.
  //
  // Deliberately dressing, not collision: nothing about getting through a spur
  // depends on this geometry existing, so a spur the sweep judged too shallow to
  // roof is simply a pass you drive over instead of a tunnel you drive into.
  if (ROAD_TUNNELS.length || RAIL_TUNNELS.length) {
    const rockMat = new THREE.MeshStandardMaterial({
      map: textures.rock, normalMap: textures.rockN, roughnessMap: textures.rockR,
      color: 0x8d8880, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide,
    });
    const portalMat = new THREE.MeshStandardMaterial({
      map: textures.concrete, normalMap: textures.concreteN,
      color: 0xa9a49a, roughness: 0.92, metalness: 0.02, side: THREE.DoubleSide,
    });
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xfff0cf, emissive: 0xffd9a0, emissiveIntensity: 2.4, roughness: 0.5,
    });
    // Superelliptic springing: sin^0.55 stands the first few metres of wall up
    // near-vertical and still rounds the crown, which is the difference between
    // a tunnel and a culvert. Entries are [lateral × W, vertical × HC] — except
    // the two skirt points, which drop a fixed 4.5 m BELOW the corridor floor so
    // the wall foot is buried. Without them you see daylight and grass under the
    // springing line from inside the bore, wherever the rock hadn't yet risen
    // to meet it.
    const SKIRT = 4.5;
    const arch = [[-1, -SKIRT, 1]];
    const AN = 16;
    for (let j = 0; j <= AN; j++) {
      const phi = (j / AN) * Math.PI;
      arch.push([-Math.cos(phi), Math.pow(Math.sin(phi), 0.55), 0]);
    }
    arch.push([1, -SKIRT, 1]);
    const M = arch.length - 1;                      // segments across the arch
    // [2] flags a skirt point: its height is metres, not a fraction of HC.
    const archH = (j, HC) => (arch[j][2] ? arch[j][1] : arch[j][1] * HC);
    const vaults = [], portals = [], lamps = [];
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    const buildBore = (run, latFn, floorFn, W, HC) => {
      const PAD = 3.0;                              // bury each end in the rock
      const s0 = run.s0 - PAD, s1 = run.s1 + PAD;
      const N = Math.max(6, Math.ceil((s1 - s0) / 2.2));
      const ring = [];
      for (let i = 0; i <= N; i++) {
        const theta = (s0 + (s1 - s0) * (i / N)) / RF;
        const lat = latFn(theta), base = floorFn(theta);
        const pts = [];
        for (let j = 0; j <= M; j++) {
          pts.push({ theta, lat: lat + arch[j][0] * W, h: base + archH(j, HC) });
        }
        ring.push(pts);
      }
      // vault shell
      const NV = (N + 1) * (M + 1);
      const pos = new Float32Array(NV * 3), uv = new Float32Array(NV * 2);
      for (let i = 0; i <= N; i++) {
        for (let j = 0; j <= M; j++) {
          const r = ring[i][j], k = i * (M + 1) + j;
          torusPosition(r.theta, r.lat, r.h, p);
          pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
          uv[k * 2] = (s0 + (s1 - s0) * (i / N)) / 6;
          uv[k * 2 + 1] = (j / M) * (Math.PI * W) / 6;
        }
      }
      const idx = [];
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < M; j++) {
          const a = i * (M + 1) + j, b = a + (M + 1);
          idx.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      vaults.push(g);

      // portal ring at each mouth — the arch stepped out 1.1 m all round
      for (const end of [0, N]) {
        const pts = ring[end];
        const pp = new Float32Array((M + 1) * 2 * 3);
        const pu = new Float32Array((M + 1) * 2 * 2);
        for (let j = 0; j <= M; j++) {
          const base = floorFn(pts[j].theta);
          torusPosition(pts[j].theta, pts[j].lat, pts[j].h, p);
          torusPosition(pts[j].theta, pts[j].lat + arch[j][0] * 1.3,
            base + archH(j, HC) + (arch[j][2] ? 0 : arch[j][1] * 1.3), q);
          pp[j * 6] = p.x; pp[j * 6 + 1] = p.y; pp[j * 6 + 2] = p.z;
          pp[j * 6 + 3] = q.x; pp[j * 6 + 4] = q.y; pp[j * 6 + 5] = q.z;
          pu[j * 4] = j * 0.6; pu[j * 4 + 1] = 0;
          pu[j * 4 + 2] = j * 0.6; pu[j * 4 + 3] = 1;
        }
        const pidx = [];
        for (let j = 0; j < M; j++) {
          const a = j * 2;
          pidx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
        const pg = new THREE.BufferGeometry();
        pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
        pg.setAttribute('uv', new THREE.BufferAttribute(pu, 2));
        pg.setIndex(pidx);
        pg.computeVertexNormals();
        portals.push(pg);
      }

      // crown lamps, so the bore is somewhere you can see rather than a black slot
      for (let s = s0 + 8; s < s1 - 4; s += 13) {
        const theta = s / RF;
        const lg = new THREE.BoxGeometry(1.6, 0.14, 0.5);
        placementMatrix(theta, latFn(theta), floorFn(theta) + HC * 0.93, 0, 1, m);
        lg.applyMatrix4(m);
        lamps.push(lg);
      }
    };

    for (const run of ROAD_TUNNELS) {
      buildBore(run, roadLat, (t) => roadH(t) - 0.15, 10.5, Math.min(9.0, run.crown * 0.55 + 4.5));
    }
    for (const run of RAIL_TUNNELS) {
      // The vault has to clear the deck, which rides ~7 m over the notch floor.
      buildBore(run, railLatStatic, (t) => terrainH(t, railLatStatic(t)) - 0.2, 7.4,
        Math.min(15.0, (railH(run.thetaMid) - terrainH(run.thetaMid, railLatStatic(run.thetaMid))) + 5.0));
    }
    if (vaults.length) {
      const mesh = new THREE.Mesh(mergeGeometries(vaults), rockMat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      world.add(mesh);
    }
    if (portals.length) world.add(new THREE.Mesh(mergeGeometries(portals), portalMat));
    if (lamps.length) world.add(new THREE.Mesh(mergeGeometries(lamps), lampMat));
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

  // ── Standing lakes ──
  // One fan per lake, meshed out to the REAL shoreline rather than to the
  // nominal rim: the bowl is carved into rolling ground, so where the water
  // actually stops varies by bearing. Bisecting for it per spoke is the same
  // trick waterEdges plays on the river, and it is what keeps the sheet from
  // laying a pane of water over the grass on the shallow side.
  if (LAKES.length) {
    const geos = [];
    // The rings are bunched toward the shore, not spread evenly. The shader
    // draws its foam over the last 0.32 m of depth, so with evenly spaced rings
    // the outermost band of triangles is 5 m wide and interpolates that foam
    // most of the way across the lake — a 40 m pool that renders milk-white.
    const A = 72, R = 10;
    const ringF = (r) => 1 - Math.pow(1 - r / (R - 1), 2.4);
    const p = new THREE.Vector3();
    for (const lk of LAKES) {
      const shore = new Float64Array(A);
      for (let a = 0; a < A; a++) {
        const ang = (a / A) * Math.PI * 2;
        const rim = lakeRim(lk, ang);
        const wet = (m) => {
          const q = lakePoint(lk, ang, m);
          return terrainH(q.theta, q.lat) < lk.surf - 0.01;
        };
        if (!wet(0)) { shore[a] = 0; continue; }
        let lo = 0, hi = rim;
        for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (wet(mid)) lo = mid; else hi = mid; }
        shore[a] = lo;
      }
      let any = 0;
      for (let a = 0; a < A; a++) any = Math.max(any, shore[a]);
      if (any < 0.05) continue;
      const NV = A * R;
      const positions = new Float32Array(NV * 3);
      const uvs = new Float32Array(NV * 2);
      const depths = new Float32Array(NV);
      const normals = new Float32Array(NV * 3);
      for (let a = 0; a < A; a++) {
        const ang = (a / A) * Math.PI * 2;
        for (let r = 0; r < R; r++) {
          const m = shore[a] * ringF(r);
          const q = lakePoint(lk, ang, m);
          const k = a * R + r;
          torusPosition(q.theta, q.lat, lk.surf, p);
          positions[k * 3] = p.x; positions[k * 3 + 1] = p.y; positions[k * 3 + 2] = p.z;
          uvs[k * 2] = q.theta * RF; uvs[k * 2 + 1] = q.lat;
          depths[k] = Math.max(0, lk.surf - terrainH(q.theta, q.lat));
          const c = Math.cos(q.theta), sn = Math.sin(q.theta);
          normals[k * 3] = -c; normals[k * 3 + 1] = 0; normals[k * 3 + 2] = -sn;
        }
      }
      // Ring r = 0 is the lake's centre point repeated A times; stitching it as
      // quads costs a few degenerate triangles and saves a special case.
      const indices = [];
      for (let a = 0; a < A; a++) {
        const a2 = (a + 1) % A;
        for (let r = 0; r < R - 1; r++) {
          const i0 = a * R + r, i1 = a * R + r + 1;
          const j0 = a2 * R + r, j1 = a2 * R + r + 1;
          indices.push(i0, i1, j1, i0, j1, j0);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      g.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));
      g.setIndex(indices);
      geos.push(g);
    }
    if (geos.length) {
      const lakes = new THREE.Mesh(mergeGeometries(geos), waterMat);
      lakes.renderOrder = 2;
      world.add(lakes);
    }
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

  // ══════════════════════════════════════════════════════════════════════════
  // The Cascade
  // ══════════════════════════════════════════════════════════════════════════
  // One continuous body of water from the hanging tarn on the crest, over the
  // lip, down the face, into the plunge basin and out along the run to the
  // river. It is drawn as a single ribbon down the gorge that layout.js carved,
  // so the sheet and the rock are the same shape by construction. Each vertex
  // carries how steep the water is there, and the shader uses that to scroll
  // faster and go white — the fall foams, the tarn does not.
  const cascadeMat = (function () {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, normalMap: textures.waterN1,
      roughness: 0.14, metalness: 0.02, envMapIntensity: 0.9,
      transparent: true, side: THREE.DoubleSide, depthWrite: false,
    });
    const uniforms = { uTime: { value: 0 }, wN1: { value: textures.waterN1 }, wN2: { value: textures.waterN2 } };
    mat.userData.uniforms = uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aFlow;
          varying float vFlow;
          varying vec2 vCUv;
          varying vec3 vCT, vCB, vCN;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vFlow = aFlow;
          vCUv = uv;
          vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
          vCN = normalize(vec3(-wp.x, 0.0, -wp.z));
          vCB = vec3(0.0, 1.0, 0.0);
          vCT = normalize(cross(vCB, vCN));`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uTime;
          uniform sampler2D wN1, wN2;
          varying float vFlow;
          varying vec2 vCUv;
          varying vec3 vCT, vCB, vCN;`)
        .replace('#include <map_fragment>', `
          // streaks stretched ALONG the flow, scrolling at the local speed
          float sp = 1.5 + vFlow * 22.0;
          float streak = texture2D(wN1, vec2(vCUv.x * 2.4, vCUv.y * 0.09 - uTime * sp * 0.02)).g;
          float froth  = texture2D(wN2, vec2(vCUv.x * 5.0, vCUv.y * 0.22 - uTime * sp * 0.05)).r;
          vec3 calm = vec3(0.30, 0.56, 0.60);
          vec3 white = vec3(0.93, 0.97, 1.00);
          // Deliberately short of saturating: a curtain that clamps to 1.0
          // everywhere is a flat white rectangle with no structure in it, and
          // the structure is the only thing telling you the water is moving.
          float f = clamp(vFlow * 0.62 + froth * vFlow * 0.85 + streak * 0.30, 0.0, 0.94);
          diffuseColor.rgb *= mix(calm, white, f);
          diffuseColor.a *= mix(0.72, 0.97, f);`)
        .replace('#include <normal_fragment_maps>', `
          vec2 q1 = vec2(vCUv.x * 0.6, vCUv.y * 0.10 - uTime * (0.05 + vFlow * 0.55));
          vec2 q2 = vec2(vCUv.x * 1.7, vCUv.y * 0.26 - uTime * (0.09 + vFlow * 1.10));
          vec3 n1 = texture2D(wN1, q1).xyz * 2.0 - 1.0;
          vec3 n2 = texture2D(wN2, q2).xyz * 2.0 - 1.0;
          vec3 nl = normalize(vec3(n1.xy * 0.42 + n2.xy * 0.34, 1.0));
          normal = normalize(nl.x * vCT + nl.y * vCB + nl.z * vCN);`);
    };
    mat.customProgramCacheKey = () => 'cascade-v1';
    return mat;
  })();
  // What the DRAWN terrain does at a point — the bilinear interpolation of the
  // height grid, not the true function. Over a 2.4 m lat step the gorge floor
  // can drop 14 m, so the mesh cuts a huge chord across the real curve and
  // stands metres proud of it. A water sheet placed 0.3 m above the TRUE floor
  // therefore surfaced through the rock in bands all the way down the fall.
  function meshTerrainH(theta, lat) {
    const fl = ((lat + FLOOR_LAT) / (2 * FLOOR_LAT)) * (TNP - 1);
    const i0 = Math.max(0, Math.min(TNP - 2, Math.floor(fl))), tl = fl - i0;
    const latOf = (i) => -FLOOR_LAT + (2 * FLOOR_LAT) * (i / (TNP - 1));
    const fs = (theta / (Math.PI * 2)) * TSEG;
    const s0 = Math.floor(fs), ts = fs - s0;
    const thOf = (s) => (s / TSEG) * Math.PI * 2;
    const at = (s, i) => terrainH(thOf(s), latOf(i));
    const a = at(s0, i0) * (1 - tl) + at(s0, i0 + 1) * tl;
    const b = at(s0 + 1, i0) * (1 - tl) + at(s0 + 1, i0 + 1) * tl;
    return a * (1 - ts) + b * ts;
  }

  let mist = null;
  {
    const C = CASCADE;
    const N = 420;
    const pos = [], uv = [], flow = [], idx = [];
    const v = new THREE.Vector3(), prev = new THREE.Vector3();
    let along = 0;
    // water is narrower than the gorge it runs in — the notch keeps dry rock
    // shoulders, which is what stops the fall reading as a filled trench
    const fillOf = { tarn: 0.80, fall: 0.72, basin: 0.85, run: 0.68 };
    for (let k = 0; k <= N; k++) {
      const lat = C.latHead + (C.latMouth - C.latHead) * (k / N);
      const mid = C.theta + C.arcAt(lat) / RF;
      const hw = C.halfAt(lat) * fillOf[C.seg(lat)];
      // ride above whichever is higher: the modelled water surface, or the
      // rock the renderer is actually going to draw here
      const h = Math.max(C.surfAt(lat), meshTerrainH(mid, lat) + 0.28);
      torusPosition(mid, lat, h, v);
      if (k > 0) along += prev.distanceTo(v);
      prev.copy(v);
      // local steepness → how fast and how white the water runs here
      const dLat = (C.latMouth - C.latHead) / N;
      const grade = Math.abs(C.surfAt(lat + dLat) - h) / Math.abs(dLat);
      const fl = Math.min(1, grade / 3.0);
      for (const sgn of [-1, 1]) {
        // The gorge is a V, so its edges sit above its bed: let the sheet climb
        // the walls a little rather than slicing into them.
        const eth = mid + (sgn * hw) / RF;
        torusPosition(eth, lat, Math.max(h, meshTerrainH(eth, lat) + 0.22), v);
        pos.push(v.x, v.y, v.z);
        uv.push(sgn * 0.5 + 0.5, along);
        flow.push(fl);
      }
    }
    for (let k = 0; k < N; k++) {
      const a = k * 2, b = (k + 1) * 2;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    const falls = new THREE.Mesh(g, cascadeMat);
    falls.renderOrder = 3;
    falls.frustumCulled = false;
    world.add(falls);

    // ── mist at the plunge basin ──
    // A billowing cloud where the fall lands. Points rather than billboards:
    // there are ~500 of them, they only need to be soft and bright, and this
    // costs one draw call.
    {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const g2 = c.getContext('2d');
      const rad = g2.createRadialGradient(16, 16, 0, 16, 16, 16);
      rad.addColorStop(0, 'rgba(255,255,255,0.9)');
      rad.addColorStop(0.45, 'rgba(235,246,250,0.35)');
      rad.addColorStop(1, 'rgba(220,240,250,0)');
      g2.fillStyle = rad; g2.fillRect(0, 0, 32, 32);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;

      const M = 1600;
      const base = new Float32Array(M * 4);       // (arc, lat, phase, rise) seeds
      const positions = new Float32Array(M * 3);
      const rngM = mulberry32(0x0ca5cade);
      const toeLat = CASCADE.latToe, poolH = CASCADE.poolSurf;
      for (let i = 0; i < M; i++) {
        // Clustered on the impact point and thinning outward — a uniform box of
        // motes reads as two symmetric cotton-wool wings, which is exactly what
        // a plunge pool does not look like.
        const r = Math.pow(rngM(), 1.7);
        const ang = rngM() * Math.PI * 2;
        base[i * 4] = Math.cos(ang) * r * 11;
        base[i * 4 + 1] = toeLat - 1.5 - Math.abs(Math.sin(ang)) * r * 9;
        base[i * 4 + 2] = rngM();
        base[i * 4 + 3] = 5 + rngM() * 16;                        // how high this one gets
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const pmat = new THREE.PointsMaterial({
        map: tex, color: 0xeaf4f8, size: 1.15, transparent: true, opacity: 0.2,
        depthWrite: false, sizeAttenuation: true, blending: THREE.NormalBlending,
      });
      const pts = new THREE.Points(geo, pmat);
      pts.frustumCulled = false;
      pts.renderOrder = 4;
      world.add(pts);

      const _mp = new THREE.Vector3();
      mist = {
        t: 0,
        update(dt) {
          this.t += dt;
          for (let i = 0; i < M; i++) {
            // each mote boils up its own distance, spreading and drifting
            // downstream as it goes, then recycles at the water line
            const ph = (base[i * 4 + 2] + this.t * 0.075) % 1;
            const spread = 0.5 + ph * 1.3;
            const rise = ph * base[i * 4 + 3];
            const lat = base[i * 4 + 1] - ph * 7;
            const arc = base[i * 4] * spread;
            torusPosition(CASCADE.theta + arc / RF, lat, poolH + rise, _mp);
            positions[i * 3] = _mp.x; positions[i * 3 + 1] = _mp.y; positions[i * 3 + 2] = _mp.z;
          }
          geo.attributes.position.needsUpdate = true;
        },
      };
      mist.update(0);
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

  // bilinear meadow weight at (theta, lat), 0 outside the floor
  function meadowAt(theta, lat) {
    const fs = ((((theta / (Math.PI * 2)) % 1) + 1) % 1) * TSEG;
    const fi = (lat + FLOOR_LAT) / (2 * FLOOR_LAT) * (TNP - 1);
    if (fi < 0 || fi > TNP - 1) return 0;
    const s0 = Math.floor(fs), i0 = Math.min(TNP - 2, Math.floor(fi));
    const ts = fs - s0, ti = fi - i0;
    const s1 = (s0 + 1) % TSEG;
    const a = splatGrid[s0 * TNP + i0], b = splatGrid[s1 * TNP + i0];
    const c = splatGrid[s0 * TNP + i0 + 1], d = splatGrid[s1 * TNP + i0 + 1];
    return (a + (b - a) * ts) * (1 - ti) + (c + (d - c) * ts) * ti;
  }

  // bilinear height of the terrain MESH (its own grid), not the analytic
  // terrainH — things that must sit on the drawn surface (grass) use this
  function gridH(theta, lat) {
    const fs = ((((theta / (Math.PI * 2)) % 1) + 1) % 1) * TSEG;
    const fi = Math.max(0, Math.min(TNP - 1.0001, (lat + FLOOR_LAT) / (2 * FLOOR_LAT) * (TNP - 1)));
    const s0 = Math.floor(fs), i0 = Math.floor(fi);
    const ts = fs - s0, ti = fi - i0;
    const s1 = s0 + 1;   // H has TSEG + 1 rows (the seam row duplicated)
    const a = heightGrid[s0 * TNP + i0], b = heightGrid[s1 * TNP + i0];
    const c = heightGrid[s0 * TNP + i0 + 1], d = heightGrid[s1 * TNP + i0 + 1];
    return (a + (b - a) * ts) * (1 - ti) + (c + (d - c) * ts) * ti;
  }

  return {
    group: world, sweepProfile, tubeArc, waterMat, cascadeMat, meadowAt, gridH,
    update(t, dt) {
      waterMat.userData.uniforms.uTime.value = t;
      cascadeMat.userData.uniforms.uTime.value = t;
      if (mist) mist.update(dt || 0);
    },
  };
}
