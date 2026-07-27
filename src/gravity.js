// ── Spin & gravity-failure scheduler ────────────────────────────────────────
// gravityScale = (spin / FULL_SPIN)² — tied to the visible star rotation.

class GravitySystem {
  constructor(rng) {
    this.rng = rng;
    this.spin = FULL_SPIN;
    this.spinAngle = 0;
    this.mode = 'stable';          // stable | spindown | zerog | spinup
    this.timer = FIRST_FAILURE_AT; // until next event in current mode
    this.stabilized = false;
    this.onEvent = () => {};       // (name) => {}  name: failing|zero|recovering|restored
  }

  get gravityScale() {
    const f = this.spin / FULL_SPIN;
    return f * f;
  }

  get zeroG() { return this.gravityScale < 0.06; }

  // How strongly loose things are being carried UP off the floor, 0..1.
  //
  // Physically, a habitat that stops spinning does not throw anything anywhere:
  // people just keep the tangential velocity they already had and coast. That
  // is invisible — everyone drifts along with the scenery and nothing looks
  // wrong. What actually happens in the moment is that the floor stops pushing
  // back, and the residual air currents, the shove of standing up, and every
  // small vertical impulse that gravity used to cancel are suddenly unopposed.
  // So the readable version — and the one this drives — is: as spin falls away,
  // everything unsecured rises off the ground together, slowly.
  //
  // Ramped off gravityScale rather than off the mode, so it fades in over the
  // whole spin-down and back out over the spin-up with no steps. It is also
  // asymmetric: it comes on quickly and lets go SLOWLY, so a ring full of
  // floating people settles back down over several seconds instead of the
  // whole population being dropped the instant the flywheel catches.
  get lift() { return this.liftSmoothed; }

  _updateLift(dt) {
    let t = (LIFT_ONSET_G - this.gravityScale) / LIFT_ONSET_G;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const k = t > this.liftSmoothed ? LIFT_ATTACK : LIFT_RELEASE;
    this.liftSmoothed += (t - this.liftSmoothed) * Math.min(1, k * dt);
  }

  triggerFailure() {
    if (this.mode === 'stable' && !this.stabilized) {
      this.mode = 'spindown';
      this.timer = SPIN_DOWN_TIME;
      this.onEvent('failing');
    }
  }

  stabilize() {
    this.stabilized = true;
    if (this.mode === 'spindown' || this.mode === 'zerog') {
      this.mode = 'spinup';
      this.timer = SPIN_UP_TIME * (1 - this.spin / FULL_SPIN);
      this.onEvent('recovering');
    }
  }

  update(dt) {
    this.timer -= dt;
    switch (this.mode) {
      case 'stable':
        this.spin = FULL_SPIN;
        if (!this.stabilized && this.timer <= 0) this.triggerFailure();
        break;
      case 'spindown': {
        this.spin = Math.max(0, this.spin - (FULL_SPIN / SPIN_DOWN_TIME) * dt);
        if (this.timer <= 0 || this.spin === 0) {
          this.spin = 0;
          this.mode = 'zerog';
          this.timer = FAILURE_DURATION;
          this.onEvent('zero');
        }
        break;
      }
      case 'zerog':
        this.spin = 0;
        if (this.timer <= 0) {
          this.mode = 'spinup';
          this.timer = SPIN_UP_TIME;
          this.onEvent('recovering');
        }
        break;
      case 'spinup': {
        this.spin = Math.min(FULL_SPIN, this.spin + (FULL_SPIN / SPIN_UP_TIME) * dt);
        if (this.spin >= FULL_SPIN) {
          this.spin = FULL_SPIN;
          this.mode = 'stable';
          this.timer = FAILURE_INTERVAL_MIN + this.rng() * (FAILURE_INTERVAL_MAX - FAILURE_INTERVAL_MIN);
          this.onEvent('restored');
        }
        break;
      }
    }
    this.spinAngle += this.spin * dt;
  }
}
