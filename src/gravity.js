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
