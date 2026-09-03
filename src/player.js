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

// Movement limits that only matter now the ground has real relief.
const SLOPE_WALK = 0.62;   // rise/run you can still walk up unaided (~32°)
const SLOPE_MAX  = 1.35;   // beyond this you slide back down at full rate
const SWIM_DEPTH = 1.35;   // water deeper than this and your feet leave the bed

class Player {
  constructor(camera, colliders) {
    this.camera = camera;
    this.colliders = colliders;

    this.theta = 4.6 * Math.PI / 180;   // spawn on the plaza, west of the fountain
    this.lat = -9;
    this.h = groundH(this.theta, this.lat, Infinity);
    this.pos = torusPosition(this.theta, this.lat, this.h, new THREE.Vector3());
    this.vel = new THREE.Vector3();
    this.yaw = 0.42;               // face along +theta, angled toward the fountain
    this.pitch = 0;
    this.grounded = true;
    this.bob = 0;
    this.speedAlongGround = 0;
    this.keys = new Set();
    this.enabled = false;
    this.fovTarget = 72;
    this.ride = null;              // set by transit when boarding a train
    this.wadeDepth = 0;            // >0 while standing in the river
    this.swimming = false;
    this.inputLocked = false;      // a modal minigame owns the keyboard
    this.landing = 0;              // camera dip after a hard landing (m)
    this.lastImpact = 0;           // vertical speed absorbed on the last landing
    this.onLand = () => {};
    this.fwd = new THREE.Vector3();   // yaw-only facing, for the HUD compass
    this.right = new THREE.Vector3();
    this.distance = 0;             // metres covered on foot

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

    // ── gamepad (e.g. a USB N64 pad) ──
    // Polled per-frame in update() rather than event-driven: the Gamepad API
    // only exposes a snapshot, there's no per-axis change event.
    this.gp = { ix: 0, iz: 0, jump: false, run: false };
    this.gpInteractPressed = false;   // one-shot: consumed by main.js each frame
    this._gpInteractHeld = false;
    window.addEventListener('gamepadconnected', e => {
      console.log('Gamepad connected:', e.gamepad.id);
    });
  }

  key(c) { return this.keys.has(c); }

  // Reads the first connected pad every frame. Deadzone kills stick drift.
  // The stick is look (no second stick needed), and the run button doubles
  // as "walk forward" — held down, you move forward at run speed, no analog
  // walk speed to worry about.
  _pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && (pads[0] || pads[1] || pads[2] || pads[3]);
    this.gp.ix = 0; this.gp.iz = 0; this.gp.jump = false; this.gp.run = false;
    this.gp.climb = false; this.gp.lower = false;
    if (!gp || !gp.connected) return;
    const dz = 0.2;
    const ax = v => (Math.abs(v) < dz ? 0 : v);
    const lx = ax(gp.axes[0] || 0), ly = ax(gp.axes[1] || 0);
    if (this.enabled) {
      this.yaw -= lx * GAMEPAD_LOOK_SENS;
      this.pitch -= ly * GAMEPAD_LOOK_SENS;
      this.pitch = Math.max(-1.52, Math.min(1.52, this.pitch));
    }
    this.gp.jump = !!(gp.buttons[0] && gp.buttons[0].pressed);
    this.gp.run = !!((gp.buttons[1] && gp.buttons[1].pressed) || (gp.buttons[2] && gp.buttons[2].pressed));
    if (this.gp.run) this.gp.iz = 1;   // "run" button held → walk forward
    this.gp.climb = !!(gp.buttons[12] && gp.buttons[12].pressed);   // zero-g up
    this.gp.lower = !!(gp.buttons[13] && gp.buttons[13].pressed);   // zero-g down
    const l = !!(gp.buttons[4] && gp.buttons[4].pressed);   // L shoulder
    const r = !!(gp.buttons[7] && gp.buttons[7].pressed);   // R shoulder (this pad reports it at 7, not the standard 5)
    if (l !== r) this.gp.ix = r ? 1 : -1;   // sidestep

    // button 11 (right stick click) → interact, same as the E key (edge-triggered)
    const interactHeld = !!(gp.buttons[11] && gp.buttons[11].pressed);
    if (interactHeld && !this._gpInteractHeld) this.gpInteractPressed = true;
    this._gpInteractHeld = interactHeld;
  }

  update(dt, gravityScale, lift = 0) {
    const zeroG = gravityScale < 0.06;
    // Past halfway, the lift is stronger than your grip on the floor: you come
    // off it whether you meant to or not. Below that you can still walk, you
    // just weigh less. `lift` comes from GravitySystem and drives everything
    // loose in the ring, so you go up with the crowd rather than watching it.
    const lifted = lift > 0.5;
    this._pollGamepad();

    // ── riding a train: glued to a seat, free mouse-look, WASD/gravity ignored ──
    if (this.ride) {
      this.ride.getSeat(this.pos);              // seat feet → this.pos (world)
      const rt = worldToTorus(this.pos);
      this.theta = rt.theta; this.lat = rt.lat; this.h = rt.h;
      this.grounded = true; this.speedAlongGround = 0;
      this.vel.set(0, 0, 0);
      frameQuaternion(this.theta, _pQ);
      _qYaw.setFromAxisAngle(P_Y_AXIS, this.yaw);
      _qPitch.setFromAxisAngle(X_AXIS, this.pitch);
      _pQ.multiply(_qYaw).multiply(_qPitch);
      this.camera.quaternion.copy(_pQ);
      torusPosition(this.theta, this.lat, this.h + EYE_HEIGHT, this.camera.position);
      this.fovTarget = 72;
      this.camera.fov += (this.fovTarget - this.camera.fov) * Math.min(1, 4 * dt);
      this.camera.updateProjectionMatrix();
      return;
    }

    upAt(this.theta, _pUp);
    tangentAt(this.theta, _pTan);

    // Facing vectors from yaw (about local up) — walk direction ignores pitch
    frameQuaternion(this.theta, _pQ);
    _qYaw.setFromAxisAngle(P_Y_AXIS, this.yaw);
    _pQ.multiply(_qYaw);
    _fwd.set(0, 0, -1).applyQuaternion(_pQ);
    _right.set(1, 0, 0).applyQuaternion(_pQ);

    this.fwd.copy(_fwd); this.right.copy(_right);
    let ix = (this.key('KeyD') ? 1 : 0) - (this.key('KeyA') ? 1 : 0);
    let iz = (this.key('KeyW') ? 1 : 0) - (this.key('KeyS') ? 1 : 0);
    if (ix === 0) ix = this.gp.ix;
    if (iz === 0) iz = this.gp.iz;
    if (this.inputLocked) { ix = 0; iz = 0; }

    if (this.enabled && zeroG) {
      // ── free flight on maneuvering thrusters ──
      this.grounded = false;
      _qPitch.setFromAxisAngle(X_AXIS, this.pitch);
      const lookQ = _pQ.clone().multiply(_qPitch);
      _wish.set(0, 0, 0);
      _tmp.set(0, 0, -1).applyQuaternion(lookQ);
      _wish.addScaledVector(_tmp, iz);
      _wish.addScaledVector(_right, ix);
      if ((this.key('Space') || this.gp.jump || this.gp.climb) && !this.suppressSpace && !this.inputLocked) _wish.addScaledVector(_pUp, 1);
      if ((this.key('KeyC') || this.key('ControlLeft') || this.gp.lower) && !this.inputLocked) _wish.addScaledVector(_pUp, -1);
      if (_wish.lengthSq() > 0) {
        _wish.normalize();
        this.vel.addScaledVector(_wish, THRUST_ACCEL * dt);
      }
      this.vel.multiplyScalar(Math.max(0, 1 - 0.12 * dt));  // faint air drag
      if (this.vel.length() > 26) this.vel.setLength(26);
    } else if (this.enabled) {
      // ── walking under spin gravity ──
      const running = this.key('ShiftLeft') || this.key('ShiftRight') || this.gp.run;
      // Wading costs you speed; once it is over chest height you are swimming.
      const wade = this.wadeDepth;
      const drag = wade > 0 ? 1 - 0.62 * Math.min(1, wade / 1.3) : 1;
      const speed = (running ? RUN_SPEED : WALK_SPEED) * drag;
      _wish.set(0, 0, 0);
      _wish.addScaledVector(_fwd, iz).addScaledVector(_right, ix);
      // keep the wish vector in the tangent plane
      _wish.addScaledVector(_pUp, -_wish.dot(_pUp));
      if (_wish.lengthSq() > 0) _wish.normalize().multiplyScalar(speed);

      // split velocity into vertical + horizontal parts
      const vUp = this.vel.dot(_pUp);
      _tmp.copy(this.vel).addScaledVector(_pUp, -vUp);   // horizontal
      const accel = this.grounded ? 14 : (this.swimming ? 6 : 3);
      _tmp.lerp(_wish, Math.min(1, accel * dt));
      this.vel.copy(_tmp).addScaledVector(_pUp, vUp);
      this.speedAlongGround = _tmp.length();

      if (this.grounded && (this.key('Space') || this.gp.jump) && !this.suppressSpace && !this.inputLocked && gravityScale > 0.25) {
        this.vel.addScaledVector(_pUp, JUMP_SPEED * Math.sqrt(gravityScale));
        this.grounded = false;
      }
    }

    // gravity (scaled by wheel spin)
    this.vel.addScaledVector(_pUp, -G_FULL * gravityScale * dt);
    if (lift > 0 && !this.grounded) {
      const vUp = this.vel.dot(_pUp);
      this.vel.addScaledVector(_pUp, (LIFT_RISE * lift - vUp) * Math.min(1, LIFT_EASE * lift * dt));
    }

    // integrate
    this.pos.addScaledVector(this.vel, dt);
    const t = worldToTorus(this.pos);
    this.theta = t.theta; this.lat = t.lat; this.h = t.h;
    upAt(this.theta, _pUp);

    // ── floor (terrain-aware) ──
    const g = groundH(this.theta, this.lat, this.h);
    const wasGrounded = this.grounded;
    this.grounded = false;
    if (this.h <= g) {
      // A kerb, a doorstep or the lip of a bridge deck is walked over rather
      // than stopped dead against: the ground query absorbs the rise, and
      // anything tall enough to be a real wall carries a collider instead.
      this.h = g;
      const vUp = this.vel.dot(_pUp);
      if (vUp < 0) this.vel.addScaledVector(_pUp, -vUp * (zeroG ? 1.4 : 1)); // soft bounce in zero-g
      if (!zeroG && !lifted) this.grounded = true;
      // a hard landing dips the camera and thumps — the drop after a spin-up
      // is the moment this is for
      if (!wasGrounded && vUp < -3.5) {
        this.lastImpact = -vUp;
        this.landing = Math.min(0.45, (-vUp - 3.5) * 0.045);
        this.onLand(-vUp);
      }
    } else if (!zeroG && !lifted && wasGrounded && this.h - g < 0.45) {
      // snap-down: stay in contact when walking downhill so crests don't launch you
      const vUp = this.vel.dot(_pUp);
      if (vUp <= 0.5) {
        this.h = g;
        if (vUp < 0) this.vel.addScaledVector(_pUp, -vUp);
        this.grounded = true;
      }
    }

    // ── slopes: the hillsides sweeping up to the glass are climbable near the
    //    valley floor and not near the top. Past the limit you slide back down
    //    instead of strolling up a 60° bank. ──
    // Only on bare ground: standing on a bridge deck or a station platform, the
    // terrain underneath may be a steep bank, but the deck is flat.
    const onTerrain = Math.abs(this.h - terrainH(this.theta, this.lat)) < 0.3;
    if (this.grounded && !zeroG && onTerrain) {
      const slope = terrainSlope(this.theta, this.lat);
      if (slope > SLOPE_WALK) {
        const t = Math.min(1, (slope - SLOPE_WALK) / (SLOPE_MAX - SLOPE_WALK));
        // downhill direction in (arc, lat) from the terrain gradient
        const e = 1.0;
        const dS = (groundH(this.theta + e / RF, this.lat, this.h) - groundH(this.theta - e / RF, this.lat, this.h)) / (2 * e);
        const dL = (groundH(this.theta, this.lat + e, this.h) - groundH(this.theta, this.lat - e, this.h)) / (2 * e);
        const len = Math.hypot(dS, dL);
        if (len > 1e-4) {
          tangentAt(this.theta, _pTan);
          _tmp.copy(_pTan).multiplyScalar(-dS / len);
          _tmp.y += -dL / len;
          this.vel.addScaledVector(_tmp, G_FULL * gravityScale * t * 0.55 * dt);
        }
      }
    }

    // ── water: wade, then swim ──
    // waterDepth() is the modelled surface minus the modelled bed, so this
    // agrees exactly with the water you can see.
    this.wadeDepth = 0;
    this.swimming = false;
    if (!zeroG && this.h < WATER_H) {          // ...and not up on a bridge deck
      const depth = waterDepth(this.theta, this.lat);
      if (depth > 0.05) {
        this.wadeDepth = depth;
        if (depth > SWIM_DEPTH) {
          // float with your head out: hold the body just under the surface
          this.swimming = true;
          this.grounded = false;
          const target = WATER_H - 0.95;
          const vUp = this.vel.dot(_pUp);
          this.h += (target - this.h) * Math.min(1, 5 * dt);
          this.vel.addScaledVector(_pUp, -vUp * Math.min(1, 6 * dt));
          this.vel.multiplyScalar(Math.max(0, 1 - 2.2 * dt));   // drag
          if ((this.key('Space') || this.gp.jump) && !this.suppressSpace) this.vel.addScaledVector(_pUp, 3.5 * dt);
        }
      }
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
      this.distance += this.speedAlongGround * dt;
    }
    if (this.landing > 0.001) { bobOff -= this.landing; this.landing *= Math.max(0, 1 - 7 * dt); }
    upAt(this.theta, _pUp);
    torusPosition(this.theta, this.lat, this.h + EYE_HEIGHT + bobOff, this.camera.position);

    // FOV easing (wider in zero-g, a touch wider at a run)
    const sprinting = this.grounded && this.speedAlongGround > WALK_SPEED + 1.5;
    this.fovTarget = zeroG ? 82 : sprinting ? 77 : 72;
    this.camera.fov += (this.fovTarget - this.camera.fov) * Math.min(1, 4 * dt);
    this.camera.updateProjectionMatrix();
  }

  teleport(thetaDeg, lat = 0, h = 0, yaw = 0) {
    this.theta = thetaDeg * Math.PI / 180;
    this.lat = lat; this.h = h; this.yaw = yaw; this.pitch = 0;
    const g = groundH(this.theta, this.lat, this.h);   // never below the ground
    if (this.h < g) this.h = g;
    this.vel.set(0, 0, 0);
    torusPosition(this.theta, this.lat, this.h, this.pos);
  }

  // A shove used when the wheel spins down — inertia carries you forward. The
  // upward part is small now: the sustained lift does the rising, and stacking
  // a launch on top of it fired you at the ceiling before you could look around.
  driftKick(rng) {
    tangentAt(this.theta, _pTan);
    upAt(this.theta, _pUp);
    this.vel.addScaledVector(_pTan, 1.6 + rng() * 1.8);
    this.vel.addScaledVector(_pUp, 0.3 + rng() * 0.5);
    this.vel.y += (rng() - 0.5) * 1.2;
  }
}
