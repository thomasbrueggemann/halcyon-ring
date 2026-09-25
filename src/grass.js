// ── grass.js — a living meadow around the player ────────────────────────────
// ~120 k individual blades, drawn in ONE instanced call and placed entirely on
// the GPU. Every blade owns a fixed spot inside a 72 m tile of (arc, lat)
// space; the vertex shader picks whichever copy of that tile is nearest the
// camera, so blades are anchored to the world (no swimming, no popping) and
// simply wrap round as you walk. Density thins with distance and the blades
// widen to compensate, then fade into the splatted meadow texture by 34 m.
//
// Where a blade may grow — and the height of the ground it grows from — comes
// from an 80 m float texture re-baked around the player (in slices, a few
// thousand samples per frame) whenever they have moved a few metres: meadow
// weight from the terrain splat, minus road, lanes, water, paving and
// anything with a collider footprint.

function buildGrass(scene, world, colliders) {
  const TILE = 64;            // blade tile, metres (arc and lat)
  const DRAW_R = 30;          // blades fade out by here
  const TEX_M = 84;           // baked map span, metres
  const TEX_N = 150;          // baked map resolution (0.56 m / texel)
  const PER_M2 = 44;          // blade density at the player's feet
  const COUNT = Math.round(TILE * TILE * PER_M2);

  // ── lanes: bucketed centreline points for the mask ──
  const LCELL = 4, laneB = {};
  for (const lane of LANES) {
    const M = 96;
    for (let k = 0; k <= M; k++) {
      const q = laneSample(lane, k / M);
      const key = Math.floor((q.theta * RF) / LCELL);
      (laneB[key] = laneB[key] || []).push(q.theta * RF, q.lat);
    }
  }
  function laneDist(s, lat) {
    let best = 99;
    const k0 = Math.floor((s - 3) / LCELL), k1 = Math.floor((s + 3) / LCELL);
    for (let k = k0; k <= k1; k++) {
      const arr = laneB[k];
      if (!arr) continue;
      for (let j = 0; j < arr.length; j += 2) {
        const d = Math.hypot(s - arr[j], lat - arr[j + 1]);
        if (d < best) best = d;
      }
    }
    return best;
  }
  const _ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  function density(theta, lat, h) {
    if (Math.abs(lat) > FLOOR_LAT - 1) return 0;
    let d = world.meadowAt(theta, lat);
    if (d < 0.02) return 0;
    d *= _ss(0.0, 1.2, Math.abs(lat - roadLat(theta)) - (ROAD_HALF + ROAD_SHLDR + 0.2));
    if (d < 0.02) return 0;
    if (waterDepth(theta, lat) > 0.0 || inLake(theta, lat, 0.4) || inBore(theta, lat)) return 0;
    const s = theta * RF;
    d *= _ss(1.0, 2.2, laneDist(s, lat));
    if (d < 0.02) return 0;
    for (const p of PAVED_AREAS) {
      const da = arcDelta(p.theta, theta), dl = lat - p.lat;
      if (p.r !== undefined) { if (da * da + dl * dl < p.r * p.r) return 0; }
      else if (Math.abs(da) < p.arc && Math.abs(dl) < p.dlat) return 0;
    }
    if (colliders.resolve(s, lat, h + 0.3, 0.2)) return 0;
    return d;
  }

  // ── baked height/density map (double-buffered, rebuilt in slices) ──
  const texData = new Float32Array(TEX_N * TEX_N * 4);
  const tex = new THREE.DataTexture(texData, TEX_N, TEX_N, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  const back = new Float32Array(TEX_N * TEX_N * 4);
  const bake = { active: false, row: 0, s: 0, lat: 0 };
  const texCentre = new THREE.Vector2(0, 0);

  function bakeRows(rows) {
    const step = TEX_M / TEX_N;
    for (let r = 0; r < rows && bake.row < TEX_N; r++, bake.row++) {
      const lat = bake.lat + (bake.row + 0.5) * step - TEX_M / 2;
      for (let c = 0; c < TEX_N; c++) {
        const s = bake.s + (c + 0.5) * step - TEX_M / 2;
        const theta = s / RF;
        const h = world.gridH(theta, lat);
        const o = (bake.row * TEX_N + c) * 4;
        back[o] = h;
        back[o + 1] = density(theta, lat, h);
        back[o + 2] = 0; back[o + 3] = 1;
      }
    }
    if (bake.row >= TEX_N) {
      texData.set(back);
      tex.needsUpdate = true;
      texCentre.set(bake.s, bake.lat);
      bake.active = false;
    }
  }
  function startBake(s, lat) {
    // snap to the texel grid so a re-bake doesn't shimmer the heights
    const step = TEX_M / TEX_N;
    bake.s = Math.round(s / step) * step; bake.lat = Math.round(lat / step) * step;
    bake.row = 0; bake.active = true;
  }

  // ── blade geometry: 4 segments, tapered, in (x across, y up) ──
  const SEG = 4;
  const bladePos = [], bladeIdx = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    if (i < SEG) { bladePos.push(-0.5, t, 0, 0.5, t, 0); }
    else bladePos.push(0, 1, 0);
  }
  for (let i = 0; i < SEG - 1; i++) {
    const a = i * 2;
    bladeIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  bladeIdx.push((SEG - 1) * 2, (SEG - 1) * 2 + 1, SEG * 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(bladePos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(bladePos.length).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  geo.setIndex(bladeIdx);
  // instance data: offset in tile (arc, lat) + (height, yaw, lean, lod key)
  const rng = mulberry32(0x9a55);
  const off = new Float32Array(COUNT * 2), rnd = new Float32Array(COUNT * 4);
  for (let i = 0; i < COUNT; i++) {
    off[i * 2] = rng() * TILE; off[i * 2 + 1] = rng() * TILE;
    rnd[i * 4] = rng(); rnd[i * 4 + 1] = rng() * Math.PI * 2; rnd[i * 4 + 2] = rng(); rnd[i * 4 + 3] = rng();
  }
  geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 2));
  geo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnd, 4));
  geo.instanceCount = COUNT;

  const uniforms = {
    uGrassMap: { value: tex },
    uTexC: { value: texCentre },
    uCam: { value: new THREE.Vector2() },
    uPlayer: { value: new THREE.Vector3() },
    uGTime: { value: 0 },
    uCalm: { value: 1 },
  };

  const mat = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', /* glsl */`#include <common>
        attribute vec2 aOff;
        attribute vec4 aRnd;
        uniform sampler2D uGrassMap;
        uniform vec2 uTexC, uCam;
        uniform vec3 uPlayer;
        uniform float uGTime, uCalm;
        varying vec3 vGCol;
        varying float vGAo;
        const float RFg = ${RF.toFixed(1)};
        const float CIRC = ${CIRCUMFERENCE.toFixed(3)};
        const float TILE = ${TILE.toFixed(1)};
        const float TEXM = ${TEX_M.toFixed(1)};
        const float DRAWR = ${DRAW_R.toFixed(1)};
        float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float gNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(gHash(i), gHash(i + vec2(1, 0)), f.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), f.x), f.y);
        }`)
      .replace('#include <beginnormal_vertex>', /* glsl */`
        // world-anchored copy of this blade nearest the camera
        vec2 bp = aOff + floor((uCam - aOff) / TILE + 0.5) * TILE;
        vec2 dc = bp - uCam;
        float dist = length(dc);
        // look up ground height + density in the baked map
        vec2 dt = bp - uTexC;
        dt.x -= CIRC * floor(dt.x / CIRC + 0.5);
        vec2 tuv = dt / TEXM + 0.5;
        vec4 gm = texture2D(uGrassMap, tuv);
        float inMap = step(0.0, tuv.x) * step(tuv.x, 1.0) * step(0.0, tuv.y) * step(tuv.y, 1.0);
        float dens = gm.g * inMap;
        // distance LOD: full density to 9 m, thinning to ~22 % at the rim
        float lod = mix(1.0, 0.16, smoothstep(6.0, DRAWR, dist)) * (1.0 - smoothstep(DRAWR - 6.0, DRAWR, dist) * 0.9);
        float keep = step(aRnd.w, sqrt(dens) * lod) * step(dist, DRAWR);
        // clumping: meadow grass grows in tussocks, not a lawn
        float clump = gNoise(bp * 0.45) * 0.6 + gNoise(bp * 1.7) * 0.4;
        float hgt = (0.18 + 0.42 * aRnd.x * aRnd.x) * mix(0.55, 1.25, clump) * mix(0.55, 1.0, dens);
        float wid = 0.05 * mix(1.0, 2.6, smoothstep(6.0, DRAWR, dist)) * (0.75 + 0.5 * aRnd.z);
        // torus frame at the blade
        float th = bp.x / RFg;
        vec3 up = vec3(-cos(th), 0.0, -sin(th));
        vec3 tg = vec3(-sin(th), 0.0, cos(th));
        vec3 lt = vec3(0.0, 1.0, 0.0);
        vec3 root = vec3(cos(th), 0.0, sin(th)) * (RFg - (gm.r - 0.04)) + lt * bp.y;
        float yaw = aRnd.y;
        vec3 across = cos(yaw) * tg + sin(yaw) * lt;
        vec3 facing = -sin(yaw) * tg + cos(yaw) * lt;
        // wind: slow rolling gusts across the ring + per-blade flutter
        float t = uGTime;
        vec2 wdir = normalize(vec2(1.0, 0.35));
        float gust = gNoise(bp * 0.06 - wdir * t * 0.9) * 0.8 + gNoise(bp * 0.21 - wdir * t * 2.3) * 0.35;
        float flutter = sin(t * (2.0 + aRnd.z * 2.5) + aRnd.y * 7.0) * 0.08;
        vec3 wind3 = (wdir.x * tg + wdir.y * lt);
        float y = position.y;
        // trampling: blades lean away from the player
        vec2 pd = bp - uPlayer.xy;
        pd.x -= CIRC * floor(pd.x / CIRC + 0.5);
        float pl = length(pd);
        float push = (1.0 - smoothstep(0.25, 0.9, pl)) * step(uPlayer.z, 1.0);
        vec3 pushDir = normalize(pd.x * tg + pd.y * lt + 1e-4 * facing);
        float yb = y * y;
        vec3 bend = (facing * (0.08 + aRnd.z * 0.3) + wind3 * (gust * 0.9 + flutter) * uCalm) * yb * hgt * 0.9
                  + pushDir * push * yb * hgt * 1.3;
        vec3 figP = root + across * (position.x * wid * (1.0 - y * 0.85)) + up * (y * hgt) + bend;
        // pull the tip back toward the root so bending doesn't stretch the blade
        figP -= up * (length(bend) * 0.45 * y);
        figP = mix(root - up * 0.5, figP, keep);
        vec3 bn = normalize(cross(across, up + (bend / max(hgt, 0.05)) * 1.2));
        vec3 objectNormal = normalize(mix(bn, up, 0.55));
        // colour: dark in the thatch, lighter and yellower up the blade, drier
        // in patches; matched to the meadow texture so the fade is invisible
        float dry = smoothstep(0.55, 0.9, gNoise(bp * 0.09 + 17.0));
        vec3 base = mix(vec3(0.040, 0.080, 0.016), vec3(0.065, 0.100, 0.022), aRnd.z);
        vec3 tip = mix(vec3(0.150, 0.250, 0.055), vec3(0.30, 0.28, 0.10), dry * 0.8);
        tip = mix(tip, tip * vec3(1.15, 1.05, 0.8), aRnd.x * 0.5);
        vGCol = mix(base, tip, smoothstep(0.0, 1.0, y));
        vGAo = mix(0.45, 1.0, y);
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = figP;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGCol;
        varying float vGAo;`)
      .replace('#include <color_fragment>', 'diffuseColor.rgb = vGCol;')
      .replace('#include <aomap_fragment>', `
        reflectedLight.indirectDiffuse *= vGAo;
        reflectedLight.directDiffuse *= mix(0.65, 1.0, vGAo);`);
  };
  mat.customProgramCacheKey = () => 'grass-v1';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  scene.add(mesh);

  // ── per-frame ──
  function update(dt, t, player, gScale) {
    const s = ((player.theta * RF) % CIRCUMFERENCE + CIRCUMFERENCE) % CIRCUMFERENCE;
    uniforms.uCam.value.set(s, player.lat);
    uniforms.uPlayer.value.set(s, player.lat, player.h - world.gridH(player.theta, player.lat));
    uniforms.uGTime.value = t;
    // without spin there is no air movement to speak of — the meadow goes still
    uniforms.uCalm.value = 0.25 + 0.75 * Math.min(1, gScale);
    if (bake.active) { bakeRows(10); return; }
    let ds = s - texCentre.x; ds -= CIRCUMFERENCE * Math.round(ds / CIRCUMFERENCE);
    if (Math.abs(ds) > 4.5 || Math.abs(player.lat - texCentre.y) > 4.5) startBake(s, player.lat);
  }
  function prime(player) {
    const s = ((player.theta * RF) % CIRCUMFERENCE + CIRCUMFERENCE) % CIRCUMFERENCE;
    startBake(s, player.lat);
    bakeRows(TEX_N);
  }

  return { mesh, update, prime, uniforms, count: COUNT };
}
