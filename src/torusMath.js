// ── Torus-frame math ────────────────────────────────────────────────────────
// World axes: ring spins about +Y. A point on the ring is addressed by
//   theta : angle around the ring
//   lat   : offset along the tube axis (world Y), across the floor
//   h     : height above the floor (toward the spin axis)

const _tmM = new THREE.Matrix4();
const _tmQ = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const TM_Y_AXIS = new THREE.Vector3(0, 1, 0);

function torusPosition(theta, lat, h, target = new THREE.Vector3()) {
  const r = RF - h;
  return target.set(Math.cos(theta) * r, lat, Math.sin(theta) * r);
}

// Local "up" points from the floor toward the spin axis.
function upAt(theta, target = new THREE.Vector3()) {
  return target.set(-Math.cos(theta), 0, -Math.sin(theta));
}

// Tangent of increasing theta ("forward" around the ring).
function tangentAt(theta, target = new THREE.Vector3()) {
  return target.set(-Math.sin(theta), 0, Math.cos(theta));
}

// Orthonormal basis for an object standing at theta:
//   X = right = (0,-1,0), Y = up, Z = back. Verified right-handed.
function frameQuaternion(theta, target = new THREE.Quaternion()) {
  const c = Math.cos(theta), s = Math.sin(theta);
  _x.set(0, -1, 0);
  _y.set(-c, 0, -s);
  _z.set(s, 0, -c);
  _tmM.makeBasis(_x, _y, _z);
  return target.setFromRotationMatrix(_tmM);
}

// Compose a full placement matrix (position + surface alignment + local yaw
// about the up axis + uniform or per-axis scale) for instanced scenery.
function placementMatrix(theta, lat, h, yaw = 0, scale = 1, target = new THREE.Matrix4()) {
  frameQuaternion(theta, _tmQ);
  _qy.setFromAxisAngle(TM_Y_AXIS, yaw);
  _tmQ.multiply(_qy);
  torusPosition(theta, lat, h, _p);
  if (typeof scale === 'number') _s.setScalar(scale);
  else _s.copy(scale);
  return target.compose(_p, _tmQ, _s);
}

// Recover (theta, lat, h) from a world position.
function worldToTorus(pos, target = {}) {
  const rc = Math.hypot(pos.x, pos.z);
  target.theta = Math.atan2(pos.z, pos.x);
  target.lat = pos.y;
  target.h = RF - rc;
  return target;
}

// Shortest signed arc distance (meters along the floor) between two thetas.
function arcDelta(a, b) {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d * RF;
}
