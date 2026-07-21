// ── Ring monorail: a full-circumference elevated guideway + moving trains ───
// Nothing sells "city in a loop" like transit that visibly goes all the way
// around. Runs on the south side of the ring road at lat -10, deck at ~6 m.

const RAIL_LAT = -10;
const DECK_H = 6.1;
const TRAIN_SPEED = 16;        // m/s
const CAR_LEN = 6.8, CAR_GAP = 1.0;

function buildTransit(scene, colliders, rng) {
  const group = new THREE.Group();
  scene.add(group);

  // ── guideway: shallow channel swept around the whole ring ──
  const deckMat = new THREE.MeshStandardMaterial({
    color: 0x8d949e, roughness: 0.45, metalness: 0.55, side: THREE.DoubleSide,
  });
  const deck = new THREE.Mesh(
    sweepProfile([
      [RAIL_LAT - 1.45, DECK_H - 0.45],
      [RAIL_LAT - 1.45, DECK_H],
      [RAIL_LAT + 1.45, DECK_H],
      [RAIL_LAT + 1.45, DECK_H - 0.45],
    ], { uScale: 1 / 8, vScale: 1 / 4 }),
    deckMat
  );
  deck.castShadow = true;
  group.add(deck);

  // twin rails on the deck
  for (const off of [-0.7, 0.7]) {
    const rail = new THREE.Mesh(
      new THREE.TorusGeometry(RF - (DECK_H + 0.09), 0.07, 6, 384),
      new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.3, metalness: 0.9 })
    );
    rail.rotation.x = Math.PI / 2;
    rail.position.y = RAIL_LAT + off;
    group.add(rail);
  }

  // ── support columns every ~34 m (skipped where something already stands) ──
  const colGeo = new THREE.CylinderGeometry(0.34, 0.45, DECK_H - 0.4, 10);
  colGeo.translate(0, (DECK_H - 0.4) / 2, 0);
  const capGeo = new THREE.BoxGeometry(1.2, 0.35, 3.1);
  capGeo.translate(0, DECK_H - 0.55, 0);
  const pylonGeo = mergeGeometries([colGeo, capGeo]);
  const pylonMat = new THREE.MeshStandardMaterial({ color: 0x7a828c, roughness: 0.5, metalness: 0.5 });
  const pylonSpots = [];
  const stepDeg = (34 / RF) / DEG;
  for (let deg = 0; deg < 360; deg += stepDeg) {
    const theta = deg * DEG;
    if (colliders.resolve(theta * RF, RAIL_LAT, 1, 1.4)) continue;
    pylonSpots.push(theta);
  }
  const pylons = new THREE.InstancedMesh(pylonGeo, pylonMat, pylonSpots.length);
  const m = new THREE.Matrix4();
  pylonSpots.forEach((theta, i) => {
    placementMatrix(theta, RAIL_LAT, 0, 0, 1, m);
    pylons.setMatrixAt(i, m);
    colliders.addCylinder(theta, RAIL_LAT, 0.55, DECK_H);
  });
  pylons.castShadow = true;
  group.add(pylons);

  // ── trains: two 3-car sets running opposite directions ──
  function makeCar(bodyColor) {
    const car = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(2.0, 2.2, CAR_LEN),
      new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.35, metalness: 0.3 })
    );
    body.position.y = 1.25;
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(2.06, 0.75, CAR_LEN - 0.9),
      new THREE.MeshStandardMaterial({
        color: 0x18222c, roughness: 0.2, metalness: 0.4,
        emissive: 0x8fb4c8, emissiveIntensity: 0.35,
      })
    );
    band.position.y = 1.65;
    const skirt = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.35, CAR_LEN - 1.6),
      new THREE.MeshStandardMaterial({ color: 0x3a424c, roughness: 0.6 })
    );
    skirt.position.y = 0.05;
    car.add(body, band, skirt);
    car.traverse(o => { o.castShadow = true; });
    car.matrixAutoUpdate = false;
    group.add(car);
    return car;
  }

  const trains = [
    { theta: 20 * DEG, dir: 1, lane: RAIL_LAT + 0.7, cars: [0, 1, 2].map(() => makeCar(0xe8ecf0)) },
    { theta: 200 * DEG, dir: -1, lane: RAIL_LAT - 0.7, cars: [0, 1, 2].map(() => makeCar(0xe8973c)) },
  ];

  const carR = RF - (DECK_H + 0.2);
  function update(dt) {
    for (const tr of trains) {
      tr.theta += tr.dir * (TRAIN_SPEED / carR) * dt;
      tr.cars.forEach((car, i) => {
        const off = tr.dir * i * (CAR_LEN + CAR_GAP) / carR;
        placementMatrix(tr.theta - off, tr.lane, DECK_H + 0.2, tr.dir > 0 ? 0 : Math.PI, 1, car.matrix);
      });
    }
  }

  return { group, update };
}
