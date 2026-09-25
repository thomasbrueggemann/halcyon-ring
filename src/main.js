// ── HALCYON RING — main loop ────────────────────────────────────────────────

// ── renderer / scene ──
// No default-framebuffer MSAA: the scene is drawn into postfx.js's 4× MSAA
// HDR target, and the only thing that reaches the canvas is a full-screen quad.
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
const MAX_PR = Math.min(window.devicePixelRatio, 1.75);
renderer.setPixelRatio(MAX_PR);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000104);
// You can see 1.9 km across the ring to the far side, so aerial perspective is
// doing real work here: without it the opposite hillside reads as a flat sticker.
scene.fog = new THREE.FogExp2(0xb6cfd8, 0.00082);

const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 60000);
scene.add(camera);
const postfx = createPostFX(renderer, scene, camera);

// ── image-based lighting ────────────────────────────────────────────────────
// A tiny painted equirect of what the interior actually surrounds you with —
// bright glazing overhead, green valley below, sun blob — run through PMREM.
// This is what gives water, glass and metal believable specular; without an
// environment they can only reflect a constant ambient and look like plastic.
{
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 128);
  sky.addColorStop(0.00, '#dff0fb');       // straight up through the glass
  sky.addColorStop(0.34, '#b9d6e8');
  sky.addColorStop(0.50, '#9fb6ad');       // the far hillsides at eye level
  sky.addColorStop(0.66, '#6f8a55');
  sky.addColorStop(1.00, '#43532f');       // ground
  g.fillStyle = sky;
  g.fillRect(0, 0, 256, 128);
  const sunGlow = g.createRadialGradient(70, 26, 0, 70, 26, 46);
  sunGlow.addColorStop(0, 'rgba(255,252,238,1)');
  sunGlow.addColorStop(0.25, 'rgba(255,242,208,0.55)');
  sunGlow.addColorStop(1, 'rgba(255,236,190,0)');
  g.fillStyle = sunGlow;
  g.fillRect(0, 0, 256, 128);
  const envTex = new THREE.CanvasTexture(c);
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  envTex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  scene.environment = pmrem.fromEquirectangular(envTex).texture;
  pmrem.dispose();
  envTex.dispose();
}

// ── lights ──
const sun = new THREE.DirectionalLight(0xfff2e0, 2.5);
sun.castShadow = true;
const SHADOW_N = renderer.capabilities.maxTextureSize >= 8192 ? 4096 : 2048;
const SHADOW_HALF = 110;
sun.shadow.mapSize.set(SHADOW_N, SHADOW_N);
sun.shadow.camera.left = -SHADOW_HALF; sun.shadow.camera.right = SHADOW_HALF;
sun.shadow.camera.top = SHADOW_HALF; sun.shadow.camera.bottom = -SHADOW_HALF;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 900;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.035;
scene.add(sun, sun.target);

// With IBL carrying the ambient term, the fill lights drop right back —
// leaving them where they were washed out every shadow the sun cast. The
// hemisphere term earns its keep again now the mountain rims exist: whichever
// way the sun offset leans, one of the two inner faces is always backlit, and
// without a sky fill that whole side of the valley goes to a black cutout.
const hemi = new THREE.HemisphereLight(0xbfd9ee, 0x51663d, 0.55);
scene.add(hemi);
scene.add(new THREE.AmbientLight(0xffffff, 0.10));

// ── build the world ──
const rng = mulberry32(WORLD_SEED);
const textures = makeTextures();
const colliders = new Colliders();
const sky = buildSky(scene);
const world = buildWorld(scene, textures, colliders);
const city = buildCity(scene, textures, colliders, rng);
const { stations } = city;
// The guideway is planned last of the three: it re-routes itself around the
// buildings the city just put up (and bores through the ones it cannot dodge),
// which is why it needs a handle on the city.
const transit = buildTransit(scene, colliders, rng, city, textures);
const vegetation = buildVegetation(scene, textures, colliders, rng);
const grass = buildGrass(scene, world, colliders);
const props = buildProps(scene, textures, rng);
const hydro = buildHydro(scene, rng);

const player = new Player(camera, colliders);
grass.prime(player);
transit.player = player;
const gravity = new GravitySystem(rng);
const ui = new UI();
const audio = new AudioEngine();
transit.audio = audio;
const puzzles = new PuzzleManager({ stations, ui, audio, gravity, player, rng });
const npcs = buildNPCs(scene, rng);   // appended after all existing rng consumers
// every flat-colour material in the finished world gets triplanar micro-detail
const surfaces = upgradeSurfaces(scene);

// zero-g drifting leaves/dust around the player
const driftGroup = new THREE.Group();
{
  const N = 500;
  const positions = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 55;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 55;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 55;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xcfe3b0, size: 0.09, transparent: true, opacity: 0,
    depthWrite: false, sizeAttenuation: true,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  driftGroup.add(pts);
  driftGroup.userData.mat = mat;
  scene.add(driftGroup);
}

// ── objective waypoint: a diamond that floats over the tracked repair's
//    current step, visible through terrain and fog, scaled with distance ──
const waypoint = (() => {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 160;
  const g = c.getContext('2d');
  g.shadowBlur = 18; g.shadowColor = 'rgba(105,210,255,0.9)';
  g.fillStyle = '#9fdcff';
  g.beginPath(); g.moveTo(64, 8); g.lineTo(112, 64); g.lineTo(64, 120); g.lineTo(16, 64); g.closePath(); g.fill();
  g.fillStyle = '#0b1b28';
  g.beginPath(); g.moveTo(64, 30); g.lineTo(90, 64); g.lineTo(64, 98); g.lineTo(38, 64); g.closePath(); g.fill();
  g.fillStyle = '#9fdcff';
  g.beginPath(); g.moveTo(64, 126); g.lineTo(76, 150); g.lineTo(52, 150); g.closePath(); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, opacity: 0.9 }));
  spr.renderOrder = 999;
  spr.visible = false;
  scene.add(spr);
  return spr;
})();
const _wpPos = new THREE.Vector3();
const _wpD = new THREE.Vector3();
const _wpUp = new THREE.Vector3();

// ── shift statistics ──
const stats = { zeroTime: 0, rides: 0 };
let wasRiding = false;

// ── gravity event hookup ──
let shake = 0;
gravity.onEvent = name => {
  if (name === 'failing') {
    ui.setAlert('failing');
    ui.message('VEGA: Warning — flywheel torque fault. Spin-down imminent. Find a handhold!', 6);
    audio.klaxonStart();
    audio.gravityDownSweep();
    shake = 1.2;
    player.driftKick(rng);
    props.kickAll();
  } else if (name === 'zero') {
    ui.setAlert('zero');
    audio.klaxonStop();
    ui.message('VEGA: Free-fall. WASD thrusters, SPACE up, C down.', 5);
  } else if (name === 'recovering') {
    ui.setAlert('recovering');
    audio.gravityUpSweep();
    ui.message('VEGA: Spin-up engaged. Mind the drop.', 4);
  } else if (name === 'restored') {
    ui.setAlert(null);
    if (!gravity.stabilized) {
      ui.message(gravity.failures >= 2
        ? `VEGA: Gravity nominal. Fault cadence is increasing — ${gravity.failures} failures so far. Keep moving.`
        : 'VEGA: Gravity nominal — for now. Repair the ring systems before the next fault.', 6);
    }
  }
};
player.onLand = v => {
  audio.thud(Math.min(3, (v - 3) * 0.5));
  shake = Math.max(shake, Math.min(0.8, (v - 3) * 0.08));
};

let startTime = null;
puzzles.onAllSolved = () => {
  gravity.stabilize();
  ui.setAlert(null);
  audio.klaxonStop();
  audio.bigChime();
  ui.message('VEGA: All five systems restored. Flywheel stabilized. The ring is safe.', 8);
  setTimeout(() => ui.showWin({
    seconds: (performance.now() - startTime) / 1000,
    distance: player.distance,
    failures: gravity.failures,
    zeroTime: stats.zeroTime,
    rides: stats.rides,
    cleanRepairs: Math.max(0, 5 - puzzles.resets - ui.resets),
  }), 2600);
};

// ── input / screens ──
const lockPointer = () => {
  try {
    const p = renderer.domElement.requestPointerLock();
    if (p && p.catch) p.catch(() => {});
  } catch (_) { /* headless / unsupported */ }
};
// Every shift is a different ring. Show which one, so a good draw can be kept.
{
  const sub = document.getElementById('title-sub');
  if (sub) sub.innerHTML += ` · <span style="opacity:.65">ring ${WORLD_SEED}</span>`;
}
ui.init({ audio, lockPointer });
ui.showTitle(() => {
  audio.init();
  lockPointer();
  player.enabled = true;
  startTime = performance.now();
  ui.setObjectives(puzzles.solved, puzzles.trackedId());
  ui.setStability(0);
  ui.message('VEGA: Good cycle, engineer. Five systems are down — the status terminal at the plaza lists them.', 8);
  ui.message('Follow the compass to the tracked repair. TAB switches which one you are following.', 8);
});

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  if (!locked && player.enabled && !ui.modal && !ui.winShown) ui.showPause();
  if (locked) ui.hidePause();
});

document.addEventListener('keydown', e => {
  if (e.code === 'KeyE' && player.enabled && !ui.modal) {
    if (!transit.tryInteract()) puzzles.tryInteract();
  }
  if (e.code === 'KeyG' && player.enabled) {           // sandbox: force a failure
    if (gravity.mode === 'stable' && !gravity.stabilized) gravity.triggerFailure();
  }
  if (e.code === 'Tab' && player.enabled) {
    e.preventDefault();
    if (!ui.modal) puzzles.cycleTracked();
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  postfx.setSize(window.innerWidth, window.innerHeight);
});

window.__game = { renderer, postfx, grass, vegetation, player, gravity, puzzles, stations, scene, camera, transit, npcs, hydro, props, world };

// ── adaptive resolution ──
// The HDR/MSAA/SSAO/bloom stack scales with pixel count, and a retina panel
// has 3-4× the pixels of the screens this was tuned on. Rather than pick one
// compromise, watch the frame time: step the render scale down while frames
// run long, and try stepping back up after a long stretch at full rate (with
// vsync on, "at full rate" is the only headroom signal there is). A step that
// immediately fails lowers the ceiling so it doesn't oscillate.
const adaptive = { pr: MAX_PR, ceil: MAX_PR, acc: 0, n: 0, good: 0, lastUp: -1 };
window.__game.adaptive = adaptive;
function adaptResolution(dt, t) {
  if (!player.enabled) return;
  adaptive.acc += dt; adaptive.n++;
  if (adaptive.acc < 1.5) return;
  const avg = adaptive.acc / adaptive.n;
  adaptive.acc = 0; adaptive.n = 0;
  let next = adaptive.pr;
  if (avg > 1 / 50) {
    next = Math.max(0.75, adaptive.pr - 0.125);
    if (adaptive.lastUp >= 0 && t - adaptive.lastUp < 4) adaptive.ceil = Math.max(0.75, adaptive.pr - 0.125);
    adaptive.good = 0;
  } else if (avg < 1 / 57) {
    if (++adaptive.good >= 4 && adaptive.pr < adaptive.ceil) { next = Math.min(adaptive.ceil, adaptive.pr + 0.125); adaptive.lastUp = t; adaptive.good = 0; }
  } else adaptive.good = 0;
  if (next !== adaptive.pr) {
    adaptive.pr = next;
    renderer.setPixelRatio(next);
    postfx.setSize(window.innerWidth, window.innerHeight);
  }
}

// ── frame loop ──
const clock = new THREE.Clock();
const _mainUp = new THREE.Vector3();
const _mainTan = new THREE.Vector3();
const _sunDir = new THREE.Vector3(), _sunR = new THREE.Vector3(), _sunU = new THREE.Vector3();
const SUN_STEP = 0.8 / RF;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  gravity.update(dt);
  const gScale = gravity.gravityScale;
  const lift = gravity.lift;

  player.inputLocked = !!ui.modal;
  player.suppressSpace = !!ui.modal;
  player.update(dt, gScale, lift);
  if (gravity.zeroG) stats.zeroTime += dt;
  if (!!player.ride !== wasRiding) { wasRiding = !!player.ride; if (wasRiding) stats.rides++; }
  if (player.gpInteractPressed && player.enabled && !ui.modal) {
    if (!transit.tryInteract()) puzzles.tryInteract();
  }
  player.gpInteractPressed = false;
  transit.update(dt);
  props.update(dt, gScale, gravity.zeroG, lift);
  npcs.update(dt, gScale, gravity.zeroG, player, lift, camera);
  hydro.update(dt, gScale, lift);
  grass.update(dt, t, player, gScale);
  vegetation.update(t);
  puzzles.update(dt);
  if (transit.prompt) ui.setPrompt(transit.prompt);   // transit hint overrides
  sky.update(gravity.spinAngle);

  // camera shake during spin-down
  if (shake > 0) {
    shake = Math.max(0, shake - dt * 0.5);
    camera.position.x += (Math.random() - 0.5) * 0.05 * shake;
    camera.position.y += (Math.random() - 0.5) * 0.05 * shake;
    camera.position.z += (Math.random() - 0.5) * 0.05 * shake;
  }

  // sun follows the player so local light always comes from "above". The
  // direction is quantised (every ~0.8 m of arc) and the shadow frustum's
  // centre is snapped to whole shadow-map texels in light space, so walking
  // doesn't make every shadow edge crawl.
  {
    const thQ = Math.round(player.theta / SUN_STEP) * SUN_STEP;
    upAt(thQ, _mainUp);
    tangentAt(thQ, _mainTan);
    _sunDir.copy(_mainUp).multiplyScalar(360).addScaledVector(_mainTan, 150);
    _sunDir.y += 45;         // only a slight lat lean, so neither rim is fully backlit
    const dist = _sunDir.length();
    _sunDir.divideScalar(dist);
    // light-space axes
    _sunR.set(0, 1, 0).cross(_sunDir).normalize();
    _sunU.copy(_sunDir).cross(_sunR);
    const texel = (2 * SHADOW_HALF) / SHADOW_N;
    const pr = Math.round(player.pos.dot(_sunR) / texel) * texel;
    const pu = Math.round(player.pos.dot(_sunU) / texel) * texel;
    const pd = player.pos.dot(_sunDir);
    sun.target.position.copy(_sunR).multiplyScalar(pr).addScaledVector(_sunU, pu).addScaledVector(_sunDir, pd);
    sun.position.copy(sun.target.position).addScaledVector(_sunDir, dist);
  }

  // ambient animation
  world.update(t, dt);
  driftGroup.position.copy(player.pos);
  driftGroup.rotation.y = t * 0.03;
  driftGroup.rotation.x = t * 0.017;
  const targetOpacity = gravity.zeroG ? 0.85 : Math.max(0, 0.85 - gScale * 3);
  const m = driftGroup.userData.mat;
  m.opacity += (targetOpacity - m.opacity) * Math.min(1, 2 * dt);

  audio.update(dt, {
    grounded: player.grounded,
    groundSpeed: player.speedAlongGround,
    airSpeed: player.vel.length(),
    zeroG: gravity.zeroG,
  });

  ui.setGravity(gScale);
  ui.setFaultTimer(gravity);
  ui.update(dt);
  ui.drawMinimap(player, puzzles.solved, puzzles.trackedId(), transit.trains);

  // ── objective compass + world marker ──
  const wp = puzzles.waypoint();
  if (wp && !ui.winShown) {
    torusPosition(wp.theta, wp.lat, wp.h, _wpPos);
    _wpD.copy(_wpPos).sub(player.pos);
    const dist = Math.hypot(arcDelta(player.theta, wp.theta), wp.lat - player.lat, wp.h - player.h);
    upAt(player.theta, _wpUp);
    const vertical = _wpD.dot(_wpUp);
    const bearing = Math.atan2(_wpD.dot(player.right), _wpD.dot(player.fwd));
    ui.drawCompass(bearing, dist, wp.label, vertical);
    waypoint.visible = dist > 4;
    waypoint.position.copy(_wpPos).addScaledVector(_wpUp, 2.2 + Math.sin(t * 2) * 0.3);
    const s = Math.min(28, Math.max(1.2, dist * 0.028));
    waypoint.scale.set(s * 0.8, s, 1);
    waypoint.material.opacity = dist < 12 ? 0.35 + 0.05 * dist : 0.9;
  } else {
    ui.drawCompass(0, 0, null, 0);
    waypoint.visible = false;
  }

  // red wash while the flywheel is spinning down
  const tintTarget = gravity.mode === 'spindown' ? 0.10 + 0.08 * Math.sin(t * 7) : 0;
  postfx.uniforms.uTint.value += (tintTarget - postfx.uniforms.uTint.value) * Math.min(1, dt * 4);
  postfx.render(t);
  adaptResolution(dt, t);
}
animate();
