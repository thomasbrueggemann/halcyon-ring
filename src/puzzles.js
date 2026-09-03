// ── Repair challenges scattered around the ring ─────────────────────────────
// 1 Coolant loop — balance four coupled pressure gauges with four valves
// 2 Power relay — recover three fuse cells, then route the relay grid
// 3 Spoke phase alignment — tune an oscillator until it locks to the spoke
// 4 Observatory uplink — a split access code, then a dish signal lock
// 5 Gyroscope calibration — fly a three-beacon course in zero-g, then true it
//
// Each puzzle is a small state machine here; the modal minigames live in ui.js.
// The manager also owns the OBJECTIVE TRACKER: which repair is being followed,
// and the world position the HUD compass and the waypoint marker should point
// at for its current step.

const PUZZLE_LIST = [
  { id: 'coolant', label: 'Coolant loop — balance the gauges', place: 'Engineering Bay (48°)' },
  { id: 'power',   label: 'Power relay — 3 fuse cells + routing', place: 'Agricultural Belt (~100°)' },
  { id: 'spoke',   label: 'Spoke phase lock',                   place: 'Gamma Terminal (180°)' },
  { id: 'code',    label: 'Observatory uplink',                 place: 'Observatory Quarter (272°)' },
  { id: 'gyro',    label: 'Gyroscope calibration course',       place: 'Spoke F, zero-g only (300°)' },
];

const HINTS = {
  coolant: 'Engineering Bay, 48°: the coolant loop is out of balance. Each valve feeds two gauges — turn them until all four needles sit in the green.',
  power:   'Agricultural Belt: three fuse cells are marked by light beacons. Bring them to the relay cabinet at 104°, then route the grid.',
  spoke:   'Gamma Terminal, 180°: the amber console. Tune the oscillator to the spoke’s own phase and hold the lock.',
  code:    'The observatory console needs a four-digit code. Maintenance split it: two digits on the water tower, two at the pump station across the river in Reservoir Flats.',
  gyro:    'Spoke F, 300°: the gyro has three reference beacons hung up the shaft. Wait for a failure, fly through all three in order, then true the panel at 17 m.',
};

class PuzzleManager {
  constructor({ stations, ui, audio, gravity, player, rng }) {
    this.s = stations;
    this.ui = ui;
    this.audio = audio;
    this.gravity = gravity;
    this.player = player;
    this.rng = rng;

    this.solved = { coolant: false, power: false, spoke: false, code: false, gyro: false };
    this.onAllSolved = () => {};
    this.onSolve = () => {};
    this.time = 0;
    this.current = null;
    this.tracked = null;            // puzzle id being followed (null = auto)

    // ── 1 coolant: coupled gauges ──
    // gauge i reads base_i + a_i·v_i + b_i·v_(i+1); a solution state is drawn
    // first and the green bands centred on what it produces, so the puzzle is
    // solvable by construction. Valves cycle 0→3→0.
    this.valve = [0, 0, 0, 0];
    this.valveSol = [0, 1, 2, 3].map(() => Math.floor(rng() * 4));
    this.gaugeA = [0, 1, 2, 3].map(() => 1 + Math.floor(rng() * 2));
    this.gaugeB = [0, 1, 2, 3].map(() => 1 + Math.floor(rng() * 2));
    this.gaugeBase = [0, 1, 2, 3].map(() => rng() * 2);
    // start away from the solution — and not one turn away either
    do { this.valve = [0, 1, 2, 3].map(() => Math.floor(rng() * 4)); }
    while (this.valve.filter((v, i) => v === this.valveSol[i]).length >= 3);
    this.gaugeTarget = [0, 1, 2, 3].map(i => this._gaugeRaw(i, this.valveSol));
    this.gaugeNeedle = [0, 0, 0, 0];      // smoothed display values
    this.valveAnim = [0, 0, 0, 0];
    this.coolantIntro = false;

    // ── 2 power ──
    this.carried = 0;
    this.inserted = 0;
    this.relayRouted = false;

    // ── 4 code ──
    this.plateSeen = [false, false];

    // ── 5 gyro course ──
    this.gyroStep = 0;              // beacons touched this failure
    this.gyroArmed = false;         // all three touched, panel live
    this.resets = 0;                // aborted attempts, for the shift report

    this._buildInteractables();
  }

  get solvedCount() { return Object.values(this.solved).filter(Boolean).length; }

  _solve(id, msg) {
    if (this.solved[id]) return;
    this.solved[id] = true;
    this.audio.chime();
    this.ui.message(`✔ ${msg}`, 5);
    this.ui.setObjectives(this.solved, this.trackedId());
    this.ui.setStability(this.solvedCount);
    this.onSolve(id);
    if (this.solvedCount === 5) this.onAllSolved();
    else this.ui.message(`VEGA: Stability rising — ${this.solvedCount}/5 systems restored.`, 5);
  }

  // ── coolant maths ──
  _gaugeRaw(i, v) { return this.gaugeBase[i] + this.gaugeA[i] * v[i] + this.gaugeB[i] * v[(i + 1) % 4]; }
  _gaugeInBand(i) { return Math.abs(this._gaugeRaw(i, this.valve) - this.gaugeTarget[i]) < 0.5; }
  get gaugeMax() { return 2 + 3 * 2 + 3 * 2; }   // base + a·3 + b·3, worst case

  // ── objective tracking ──
  trackedId() {
    if (this.tracked && !this.solved[this.tracked]) return this.tracked;
    const next = PUZZLE_LIST.find(p => !this.solved[p.id]);
    return next ? next.id : null;
  }
  cycleTracked() {
    const open = PUZZLE_LIST.filter(p => !this.solved[p.id]).map(p => p.id);
    if (!open.length) return;
    const cur = this.trackedId();
    const idx = open.indexOf(cur);
    this.tracked = open[(idx + 1) % open.length];
    this.ui.setObjectives(this.solved, this.tracked);
    this.audio.beep();
  }

  // Where the compass should point for the tracked repair's CURRENT step.
  waypoint() {
    const id = this.trackedId();
    const S = this.s;
    const p = this.player;
    const g = (t, l, h) => h + groundH(t, l, Infinity);
    if (!id) return null;
    switch (id) {
      case 'coolant': {
        const v = S.valveStation;
        return { theta: v.theta, lat: v.lat, h: g(v.theta, v.lat, 2.5), label: 'Coolant valves' };
      }
      case 'power': {
        const left = S.fuses.filter(f => !f.taken);
        if (left.length && this.inserted + this.carried < 3) {
          // nearest remaining fuse cell
          let best = null, bd = Infinity;
          for (const f of left) {
            const d = Math.abs(arcDelta(p.theta, f.theta));
            if (d < bd) { bd = d; best = f; }
          }
          return { theta: best.theta, lat: best.lat, h: g(best.theta, best.lat, 3), label: `Fuse cell (${this.inserted + this.carried}/3)` };
        }
        return { theta: S.relay.theta, lat: S.relay.lat, h: g(S.relay.theta, S.relay.lat, 2.5), label: this.carried ? 'Relay cabinet — insert fuses' : 'Relay cabinet — route the grid' };
      }
      case 'spoke': {
        const c = S.alignConsole;
        return { theta: c.theta, lat: c.lat, h: g(c.theta, c.lat, 2), label: 'Phase console' };
      }
      case 'code': {
        for (let i = 0; i < 2; i++) {
          if (!this.plateSeen[i]) {
            const pl = S.codePlates[i];
            return { theta: pl.theta, lat: pl.lat, h: pl.h + groundH(pl.theta, pl.lat, Infinity), label: i === 0 ? 'Water tower — code 1-2' : 'Pump station — code 3-4' };
          }
        }
        const c = S.codeConsole;
        return { theta: c.theta, lat: c.lat, h: g(c.theta, c.lat, 2), label: 'Observatory uplink' };
      }
      case 'gyro': {
        if (this.gravity.zeroG && !this.gyroArmed) {
          const n = S.gyroNodes[this.gyroStep];
          return { theta: n.theta, lat: n.lat, h: n.h, label: `Calibration beacon ${this.gyroStep + 1}/3` };
        }
        const gp = S.gyroPanel;
        return { theta: gp.theta, lat: gp.lat, h: gp.h + groundH(gp.theta, gp.lat, Infinity), label: this.gyroArmed ? 'Gyro panel — true it' : 'Gyro panel (wait for a failure)' };
      }
    }
    return null;
  }

  _buildInteractables() {
    const S = this.s;
    const list = [];
    // Every set-piece is placed with city.js's gm(), i.e. its h is measured from
    // the ground at that spot. Resolve each interactable to an ABSOLUTE h here,
    // or the proximity test compares the player's absolute height against a
    // relative one and nothing on a raised pad can ever be reached.
    const abs = (theta, lat, h) => h + groundH(theta, lat, Infinity);

    // 1 — valves
    for (const v of S.valves) {
      list.push({
        theta: v.theta, lat: v.lat, h: abs(v.theta, v.lat, v.h), radius: 2.4,
        prompt: () => this.solved.coolant ? null : `[E] Turn valve ${v.index + 1}  (position ${this.valve[v.index] + 1}/4)`,
        enabled: () => !this.solved.coolant,
        action: () => {
          if (!this.coolantIntro) {
            this.coolantIntro = true;
            this.ui.message('Each valve feeds the gauge above it AND the next one along. Get all four needles into the green.', 6);
          }
          this.valve[v.index] = (this.valve[v.index] + 1) % 4;
          this.valveAnim[v.index] += Math.PI * 0.5;
          this.audio.valveTurn();
          const ok = [0, 1, 2, 3].filter(i => this._gaugeInBand(i)).length;
          if (ok === 4) {
            this._solve('coolant', 'Coolant loop balanced and pressurized.');
          } else if (this.valve[v.index] === this.valveSol[v.index] && ok >= 2) {
            this.ui.message(`${ok}/4 gauges in the green.`, 2);
          }
        },
      });
    }

    // 2 — fuse pickups + relay
    for (const f of S.fuses) {
      list.push({
        theta: f.theta, lat: f.lat, h: abs(f.theta, f.lat, f.h), radius: 2.2,
        prompt: () => `[E] Take fuse cell`,
        enabled: () => !f.taken && !this.solved.power,
        action: () => {
          f.taken = true;
          f.mesh.visible = false;
          f.beacon.visible = false;
          this.carried++;
          this.audio.pickup();
          this.ui.message(`Fuse cell acquired (${this.carried + this.inserted}/3). Relay cabinet is at 104°, roadside.`, 4);
          this.ui.setObjectives(this.solved, this.trackedId());
        },
      });
    }
    list.push({
      theta: S.relay.theta, lat: S.relay.lat, h: abs(S.relay.theta, S.relay.lat, 1.2), radius: 2.6,
      prompt: () => this.solved.power ? null
        : this.inserted >= 3 ? '[E] Route the relay grid'
        : this.carried > 0 ? `[E] Insert ${this.carried} fuse cell${this.carried > 1 ? 's' : ''}`
        : `Relay cabinet — needs fuse cells (${this.inserted}/3)`,
      enabled: () => !this.solved.power,
      action: () => {
        if (this.inserted >= 3) {
          this.ui.showCircuitGame(ok => {
            if (ok) {
              S.relaySlots.forEach(s => s.material.emissive.setHex(0x4dff88));
              this._solve('power', 'District power rerouted.');
            }
          });
          return;
        }
        if (this.carried === 0) { this.audio.buzz(); return; }
        for (let i = this.inserted; i < this.inserted + this.carried && i < 3; i++) {
          const slot = S.relaySlots[i];
          slot.material.emissive.setHex(0x35c8e8);
          slot.material.color.setHex(0x9ff2ff);
        }
        this.inserted += this.carried;
        this.carried = 0;
        this.audio.beep();
        if (this.inserted >= 3) this.ui.message('All three cells seated. The relay needs its grid routed — [E] again.', 4);
        else this.ui.message(`Fuse seated (${this.inserted}/3).`, 3);
      },
    });

    // 3 — spoke phase console
    list.push({
      theta: S.alignConsole.theta, lat: S.alignConsole.lat, h: abs(S.alignConsole.theta, S.alignConsole.lat, 1.3), radius: 2.6,
      prompt: () => this.solved.spoke ? null : '[E] Run spoke phase lock',
      enabled: () => !this.solved.spoke,
      action: () => {
        this.ui.showWaveGame(ok => {
          if (ok) {
            S.alignConsole.screen.material.color.setHex(0x4dff88);
            this._solve('spoke', 'Spoke Gamma phase-locked.');
          }
        });
      },
    });

    // 4 — observatory: keypad, then dish lock
    list.push({
      theta: S.codeConsole.theta, lat: S.codeConsole.lat, h: abs(S.codeConsole.theta, S.codeConsole.lat, 1.3), radius: 2.6,
      prompt: () => this.solved.code ? null : '[E] Observatory uplink terminal',
      enabled: () => !this.solved.code,
      action: () => {
        this.ui.showKeypad(S.code, ok => {
          if (!ok) return;
          this.ui.message('Code accepted. Aim the dish — find the carrier and hold it.', 4);
          setTimeout(() => {
            this.ui.showDishGame(locked => {
              if (locked) {
                S.codeConsole.screen.material.color.setHex(0x4dff88);
                this._solve('code', 'Observatory uplink authenticated and locked.');
              }
            });
          }, 250);
        });
      },
    });

    // 5 — gyro panel (zero-g only, after the beacon course)
    list.push({
      theta: S.gyroPanel.theta, lat: S.gyroPanel.lat, h: abs(S.gyroPanel.theta, S.gyroPanel.lat, S.gyroPanel.h), radius: 3.4,
      prompt: () => this.solved.gyro ? null : this.gyroArmed ? '[E] True the gyroscope' : `Gyro panel — fly the beacons first (${this.gyroStep}/3)`,
      enabled: () => !this.solved.gyro && this.gravity.zeroG,
      action: () => {
        if (!this.gyroArmed) { this.audio.buzz(); return; }
        S.gyroPanel.screen.material.color.setHex(0x4dff88);
        if (S.gyroRing) S.gyroRing.visible = false;
        for (const n of S.gyroNodes) n.group.visible = false;
        this._solve('gyro', 'Attitude gyroscope calibrated.');
      },
    });

    // plaza info terminal — hints
    list.push({
      theta: S.plazaTerminal.theta, lat: S.plazaTerminal.lat, h: abs(S.plazaTerminal.theta, S.plazaTerminal.lat, 1.3), radius: 2.6,
      prompt: () => '[E] Station status terminal',
      enabled: () => true,
      action: () => {
        this.audio.beep();
        const id = this.trackedId();
        if (!id) this.ui.message('VEGA: All systems nominal. Thank you, engineer.', 5);
        else this.ui.message(`VEGA: ${HINTS[id]}`, 8);
      },
    });

    this.interactables = list;
  }

  tryInteract() {
    if (this.current) this.current.action();
  }

  // ── the gauge board ──
  _drawGauges() {
    const gb = this.s.gaugeBoard;
    if (!gb) return;
    const { ctx, canvas } = gb;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#0c1218';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#16212b';
    ctx.fillRect(0, 0, W, 40);
    ctx.fillStyle = '#9fb4c4';
    ctx.font = 'bold 24px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('PRIMARY COOLANT LOOP — MANIFOLD PRESSURE', 18, 28);
    ctx.textAlign = 'right';
    const okN = [0, 1, 2, 3].filter(i => this._gaugeInBand(i)).length;
    ctx.fillStyle = this.solved.coolant ? '#54e07a' : okN === 4 ? '#54e07a' : '#ffb020';
    ctx.fillText(this.solved.coolant ? 'NOMINAL' : `${okN}/4 IN BAND`, W - 18, 28);
    const max = this.gaugeMax;
    for (let i = 0; i < 4; i++) {
      const cx = W * (0.125 + 0.25 * i), cy = 175, R = 88;
      // dial face
      ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI, 2 * Math.PI); ctx.lineTo(cx + R, cy + 10); ctx.lineTo(cx - R, cy + 10); ctx.closePath();
      ctx.fillStyle = '#1b2731'; ctx.fill();
      ctx.strokeStyle = '#3a4a58'; ctx.lineWidth = 3; ctx.stroke();
      const ang = v => Math.PI + (v / max) * Math.PI;
      // green band
      const lo = Math.max(0, this.gaugeTarget[i] - 0.5), hi = Math.min(max, this.gaugeTarget[i] + 0.5);
      ctx.beginPath(); ctx.arc(cx, cy, R - 8, ang(lo), ang(hi));
      ctx.strokeStyle = this._gaugeInBand(i) ? '#54e07a' : 'rgba(84,224,122,0.55)'; ctx.lineWidth = 14; ctx.stroke();
      // red over-pressure zone at the top end
      ctx.beginPath(); ctx.arc(cx, cy, R - 8, ang(max * 0.86), ang(max));
      ctx.strokeStyle = 'rgba(232,80,80,0.5)'; ctx.lineWidth = 14; ctx.stroke();
      // ticks
      ctx.strokeStyle = '#7d94a8'; ctx.lineWidth = 2;
      for (let k = 0; k <= 10; k++) {
        const a = Math.PI + (k / 10) * Math.PI;
        const r0 = k % 5 === 0 ? R - 24 : R - 18;
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * (R - 14), cy + Math.sin(a) * (R - 14)); ctx.stroke();
      }
      // needle
      const na = ang(this.gaugeNeedle[i]);
      ctx.strokeStyle = this._gaugeInBand(i) ? '#8fffb0' : '#ffd166'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(na) * (R - 16), cy + Math.sin(na) * (R - 16)); ctx.stroke();
      ctx.fillStyle = '#cfdce8'; ctx.beginPath(); ctx.arc(cx, cy, 6, 0, 7); ctx.fill();
      // label
      ctx.fillStyle = '#9fb4c4'; ctx.font = 'bold 20px monospace'; ctx.textAlign = 'center';
      ctx.fillText(`GAUGE ${i + 1}`, cx, cy + 36);
      ctx.fillStyle = '#64798c'; ctx.font = '16px monospace';
      ctx.fillText(`V${i + 1} + V${(i + 1) % 4 + 1}`, cx, cy + 58);
    }
    gb.tex.needsUpdate = true;
  }

  update(dt) {
    this.time += dt;
    const S = this.s;

    // ── coolant: needles ease toward the live reading; lamps show the band ──
    let needleMoving = false;
    for (let i = 0; i < 4; i++) {
      const target = this.solved.coolant ? this.gaugeTarget[i] : this._gaugeRaw(i, this.valve);
      const d = target - this.gaugeNeedle[i];
      if (Math.abs(d) > 0.005) needleMoving = true;
      this.gaugeNeedle[i] += d * Math.min(1, 3.2 * dt);
    }
    if (needleMoving || !this._gaugeDrawn || (this.time % 1) < dt) { this._drawGauges(); this._gaugeDrawn = true; }
    S.valveLamps.forEach((lamp, i) => {
      if (this.solved.coolant || this._gaugeInBand(i)) lamp.material.emissive.setHex(0x2bff66);
      else lamp.material.emissive.setHex((Math.sin(this.time * 6 + i) > 0) ? 0xff5030 : 0x401008);
    });
    S.valves.forEach(v => {
      if (this.valveAnim[v.index] > 0.001) {
        const step = Math.min(this.valveAnim[v.index], dt * 4);
        v.wheel.rotateZ(step);
        this.valveAnim[v.index] -= step;
      }
    });

    // ── beacon + gyro pulse ──
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 2.4);
    for (const f of S.fuses) {
      if (!f.taken) f.beacon.material.opacity = 0.08 + 0.1 * pulse;
    }
    if (S.gyroRing && !this.solved.gyro) {
      S.gyroRing.material.opacity = 0.4 + 0.5 * pulse;
    }

    // ── gyro course ──
    if (!this.solved.gyro && S.gyroNodes) {
      const zero = this.gravity.zeroG;
      if (!zero && (this.gyroStep > 0 || this.gyroArmed)) {
        // gravity came back before the panel was trued: the course resets
        this.gyroStep = 0;
        this.gyroArmed = false;
        this.resets++;
        this.ui.message('VEGA: Spin returned before the gyro was trued — calibration reset. Next failure, fly it again.', 6);
      }
      const p = this.player;
      S.gyroNodes.forEach((n, i) => {
        const active = zero && i === this.gyroStep && !this.gyroArmed;
        const done = i < this.gyroStep || this.gyroArmed;
        const em = n.core.material;
        if (done) { em.emissive.setHex(0x4dff88); em.emissiveIntensity = 2.2; }
        else if (active) { em.emissive.setHex(0xffa040); em.emissiveIntensity = 2.5 + 2.5 * pulse; }
        else { em.emissive.setHex(0x8a4a2a); em.emissiveIntensity = 0.8; }
        for (const h of n.halos) {
          h.material.color.setHex(done ? 0x4dff88 : active ? 0xffc080 : 0x7a4a30);
          h.material.opacity = active ? 0.6 + 0.4 * pulse : done ? 0.5 : 0.3;
          h.rotation.z += dt * (active ? 2.2 : 0.4);
        }
        n.beam.material.opacity = active ? 0.09 + 0.08 * pulse : done ? 0.02 : 0.03;
        n.beam.material.color.setHex(done ? 0x4dff88 : 0xffa060);
        if (active) {
          const d = Math.hypot(arcDelta(p.theta, n.theta), n.lat - p.lat, n.h - (p.h + 0.9));
          if (d < 2.6) {
            this.gyroStep++;
            this.audio.beaconHit(this.gyroStep);
            if (this.gyroStep >= 3) {
              this.gyroArmed = true;
              this.ui.message('All three beacons logged. Now true the panel at 17 m — before the spin comes back!', 6);
            } else {
              this.ui.message(`Beacon ${this.gyroStep}/3 logged. Next one is lit.`, 3);
            }
          }
        }
      });
    }

    // ── code plates: mark as seen once the player has been close to them ──
    if (!this.solved.code && S.codePlates) {
      S.codePlates.forEach((pl, i) => {
        if (this.plateSeen[i]) return;
        const p = this.player;
        const d = Math.hypot(arcDelta(p.theta, pl.theta), pl.lat - p.lat);
        if (d < 22) {
          this.plateSeen[i] = true;
          this.audio.beep();
          this.ui.message(i === 0 ? 'Access code, digits 1-2 — noted. The other half is at the pump station across the river.' : 'Access code, digits 3-4 — noted. Back to the observatory console.', 5);
        }
      });
    }

    // nearest usable interactable
    const p = this.player;
    let best = null, bestD = Infinity;
    for (const it of this.interactables) {
      if (!it.enabled()) continue;
      const dArc = arcDelta(p.theta, it.theta);
      const dLat = it.lat - p.lat;
      const dH = it.h - (p.h + 1.2);
      const d = Math.hypot(dArc, dLat, dH);
      if (d < it.radius && d < bestD) { best = it; bestD = d; }
    }
    this.current = best;
    this.ui.setPrompt(best ? (typeof best.prompt === 'function' ? best.prompt() : best.prompt) : null);
  }
}
