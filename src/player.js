// ── First-person controller in torus coordinates ────────────────────────────
// World position integrates in Cartesian space; gravity always points from
// the spin axis toward the floor. When the wheel stops, gravity goes with it.

const _pUp = new THREE.Vector3();
const _pTan = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _pQ = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _qPitch = new THREE.Quaternion();
const _tmp = new THREE.Vector3();
const P_Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

class Player {
  constructor(camera, colliders) {
    this.camera = camera;
    this.colliders = colliders;

    this.theta = 4.3 * Math.PI / 180;   // spawn on the plaza, west of the fountain
    this.lat = -13;
    this.h = 0;
    this.pos = torusPosition(this.theta, this.lat, this.h, new THREE.Vector3());
    this.vel = new THREE.Vector3();
    this.yaw = 0;                  // face along +theta, toward the fountain
    this.pitch = 0;
    this.grounded = true;
    this.bob = 0;
    this.speedAlongGround = 0;
    this.keys = new Set();
    this.enabled = false;
    this.fovTarget = 72;

    document.addEventListener('keydown', e => {
      if (e.code === 'Space') e.preventDefault();
      this.keys.add(e.code);
    });
    document.addEventListener('keyup', e => this.keys.delete(e.code));
    document.addEventListener('mousemove', e => {
      if (!this.enabled || document.pointerLockElement === null) return;
      this.yaw -= e.movementX * MOUSE_SENS;
      this.pitch -= e.movementY * MOUSE_SENS;
      this.pitch = Math.max(-1.52, Math.min(1.52, this.pitch));
    });
  }

  key(c) { return this.keys.has(c); }

  update(dt, gravityScale) {
    const zeroG = gravityScale < 0.06;
    upAt(this.theta, _pUp);
    tangentAt(this.theta, _pTan);

    // Facing vectors from yaw (about local up) — walk direction ignores pitch
    frameQuaternion(this.theta, _pQ);
    _qYaw.setFromAxisAngle(P_Y_AXIS, this.yaw);
    _pQ.multiply(_qYaw);
    _fwd.set(0, 0, -1).applyQuaternion(_pQ);
    _right.set(1, 0, 0).applyQuaternion(_pQ);

    const ix = (this.key('KeyD') ? 1 : 0) - (this.key('KeyA') ? 1 : 0);
    const iz = (this.key('KeyW') ? 1 : 0) - (this.key('KeyS') ? 1 : 0);

    if (this.enabled && zeroG) {
      // ── free flight on maneuvering thrusters ──
      this.grounded = false;
      _qPitch.setFromAxisAngle(X_AXIS, this.pitch);
      const lookQ = _pQ.clone().multiply(_qPitch);
      _wish.set(0, 0, 0);
      _tmp.set(0, 0, -1).applyQuaternion(lookQ);
      _wish.addScaledVector(_tmp, iz);
      _wish.addScaledVector(_right, ix);
      if (this.key('Space') && !this.suppressSpace) _wish.addScaledVector(_pUp, 1);
      if (this.key('KeyC') || this.key('ControlLeft')) _wish.addScaledVector(_pUp, -1);
      if (_wish.lengthSq() > 0) {
        _wish.normalize();
        this.vel.addScaledVector(_wish, THRUST_ACCEL * dt);
      }
      this.vel.multiplyScalar(Math.max(0, 1 - 0.12 * dt));  // faint air drag
      if (this.vel.length() > 26) this.vel.setLength(26);
    } else if (this.enabled) {
      // ── walking under spin gravity ──
      const running = this.key('ShiftLeft') || this.key('ShiftRight');
      const speed = (running ? RUN_SPEED : WALK_SPEED);
      _wish.set(0, 0, 0);
      _wish.addScaledVector(_fwd, iz).addScaledVector(_right, ix);
      // keep the wish vector in the tangent plane
      _wish.addScaledVector(_pUp, -_wish.dot(_pUp));
      if (_wish.lengthSq() > 0) _wish.normalize().multiplyScalar(speed);

      // split velocity into vertical + horizontal parts
      const vUp = this.vel.dot(_pUp);
      _tmp.copy(this.vel).addScaledVector(_pUp, -vUp);   // horizontal
      const accel = this.grounded ? 14 : 3;
      _tmp.lerp(_wish, Math.min(1, accel * dt));
      this.vel.copy(_tmp).addScaledVector(_pUp, vUp);
      this.speedAlongGround = _tmp.length();

      if (this.grounded && this.key('Space') && !this.suppressSpace && gravityScale > 0.25) {
        this.vel.addScaledVector(_pUp, JUMP_SPEED * Math.sqrt(gravityScale));
        this.grounded = false;
      }
    }

    // gravity (scaled by wheel spin)
    this.vel.addScaledVector(_pUp, -G_FULL * gravityScale * dt);

    // integrate
    this.pos.addScaledVector(this.vel, dt);
    const t = worldToTorus(this.pos);
    this.theta = t.theta; this.lat = t.lat; this.h = t.h;
    upAt(this.theta, _pUp);

    // ── floor ──
    this.grounded = false;
    if (this.h <= 0) {
      this.h = 0;
      const vUp = this.vel.dot(_pUp);
      if (vUp < 0) this.vel.addScaledVector(_pUp, -vUp * (zeroG ? 1.4 : 1)); // soft bounce in zero-g
      if (!zeroG) this.grounded = true;
    }

    // ── hull cross-section constraint (walls + glass ceiling) ──
    {
      const cx = CHORD_DROP - this.h;      // outward component in tube plane
      const cy = this.lat;
      const dist = Math.hypot(cx, cy);
      const maxR = RT - 1.4;
      if (dist > maxR) {
        const nx = cx / dist, ny = cy / dist;
        const pen = dist - maxR;
        this.h += nx * pen;
        this.lat -= ny * pen;
        // outward direction in world space
        _tmp.copy(_pUp).multiplyScalar(-nx);
        _tmp.y += ny;
        const vOut = this.vel.dot(_tmp);
        if (vOut > 0) this.vel.addScaledVector(_tmp, -vOut * 1.5);
      }
    }

    // ── buildings / trees ──
    const push = this.colliders.resolve(this.theta * RF, this.lat, this.h, 0.42);
    if (push) {
      this.theta += push.ds / RF;
      this.lat += push.dlat;
      tangentAt(this.theta, _pTan);
      const len = Math.hypot(push.ds, push.dlat);
      if (len > 1e-6) {
        _tmp.copy(_pTan).multiplyScalar(push.ds / len);
        _tmp.y += push.dlat / len;
        const vInto = this.vel.dot(_tmp);
        if (vInto < 0) this.vel.addScaledVector(_tmp, -vInto);
      }
    }

    torusPosition(this.theta, this.lat, this.h, this.pos);

    // ── camera ──
    frameQuaternion(this.theta, _pQ);
    _qYaw.setFromAxisAngle(P_Y_AXIS, this.yaw);
    _qPitch.setFromAxisAngle(X_AXIS, this.pitch);
    _pQ.multiply(_qYaw).multiply(_qPitch);
    this.camera.quaternion.copy(_pQ);

    let bobOff = 0;
    if (this.grounded && this.speedAlongGround > 0.5) {
      this.bob += dt * (4 + this.speedAlongGround * 1.1);
      bobOff = Math.sin(this.bob) * 0.045;
    }
    upAt(this.theta, _pUp);
    torusPosition(this.theta, this.lat, this.h + EYE_HEIGHT + bobOff, this.camera.position);

    // FOV easing (wider in zero-g)
    this.fovTarget = zeroG ? 82 : 72;
    this.camera.fov += (this.fovTarget - this.camera.fov) * Math.min(1, 4 * dt);
    this.camera.updateProjectionMatrix();
  }

  teleport(thetaDeg, lat = 0, h = 0, yaw = 0) {
    this.theta = thetaDeg * Math.PI / 180;
    this.lat = lat; this.h = h; this.yaw = yaw; this.pitch = 0;
    this.vel.set(0, 0, 0);
    torusPosition(this.theta, this.lat, this.h, this.pos);
  }

  // A shove used when the wheel spins down — inertia carries you forward.
  driftKick(rng) {
    tangentAt(this.theta, _pTan);
    upAt(this.theta, _pUp);
    this.vel.addScaledVector(_pTan, 2.5 + rng() * 2.5);
    this.vel.addScaledVector(_pUp, 1.2 + rng() * 1.5);
    this.vel.y += (rng() - 0.5) * 1.5;
  }
}
