// ── HALCYON RING — main loop ────────────────────────────────────────────────

// ── renderer / scene ──
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
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
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -95; sun.shadow.camera.right = 95;
sun.shadow.camera.top = 95; sun.shadow.camera.bottom = -95;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 900;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.035;
scene.add(sun, sun.target);

// With IBL carrying the ambient term, the fill lights drop right back —
// leaving them where they were washed out every shadow the sun cast.
const hemi = new THREE.HemisphereLight(0xbfd9ee, 0x51663d, 0.30);
scene.add(hemi);
scene.add(new THREE.AmbientLight(0xffffff, 0.10));

// ── build the world ──
const rng = mulberry32(WORLD_SEED);
const textures = makeTextures();
const colliders = new Colliders();
const sky = buildSky(scene);
const world = buildWorld(scene, textures, colliders);
const { stations } = buildCity(scene, textures, colliders, rng);
const transit = buildTransit(scene, colliders, rng);
buildVegetation(scene, textures, colliders, rng);
const props = buildProps(scene, textures, rng);

const player = new Player(camera, colliders);
transit.player = player;
const gravity = new GravitySystem(rng);
const ui = new UI();
const audio = new AudioEngine();
const puzzles = new PuzzleManager({ stations, ui, audio, gravity, player, rng });
const npcs = buildNPCs(scene, rng);   // appended after all existing rng consumers

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
      ui.message('VEGA: Gravity nominal — for now. Repair the ring systems before the next fault.', 6);
    }
  }
};

let startTime = null;
puzzles.onAllSolved = () => {
  gravity.stabilize();
  ui.setAlert(null);
  audio.klaxonStop();
  audio.bigChime();
  ui.message('VEGA: All five systems restored. Flywheel stabilized. The ring is safe.', 8);
  setTimeout(() => ui.showWin((performance.now() - startTime) / 1000), 2600);
};

// ── input / screens ──
const lockPointer = () => {
  try {
    const p = renderer.domElement.requestPointerLock();
    if (p && p.catch) p.catch(() => {});
  } catch (_) { /* headless / unsupported */ }
};
ui.init({ audio, lockPointer });
ui.showTitle(() => {
  audio.init();
  lockPointer();
  player.enabled = true;
  startTime = performance.now();
  ui.setObjectives(puzzles.solved);
  ui.setStability(0);
  ui.message('VEGA: Good cycle, engineer. Five systems are down — the status terminal at the plaza lists them.', 8);
  ui.message('Reach each station along the ring. The map (bottom right) marks them.', 8);
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
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.__game = { player, gravity, puzzles, stations, scene, camera, transit, npcs };

// ── frame loop ──
const clock = new THREE.Clock();
const _mainUp = new THREE.Vector3();
const _mainTan = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  gravity.update(dt);
  const gScale = gravity.gravityScale;

  player.suppressSpace = ui.modal === 'align';
  player.update(dt, gScale);
  transit.update(dt);
  props.update(dt, gScale, gravity.zeroG);
  npcs.update(dt, gScale, gravity.zeroG, player);
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

  // sun follows the player so local light always comes from "above"
  upAt(player.theta, _mainUp);
  tangentAt(player.theta, _mainTan);
  sun.position.copy(player.pos)
    .addScaledVector(_mainUp, 320)
    .addScaledVector(_mainTan, 150);
  sun.position.y += 110;
  sun.target.position.copy(player.pos);

  // ambient animation
  world.update(t);
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
  ui.update(dt);
  ui.drawMinimap(player, puzzles.solved);

  renderer.render(scene, camera);
}
animate();
