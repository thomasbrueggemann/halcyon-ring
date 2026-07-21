// ── Repair puzzles scattered around the ring ────────────────────────────────
// 1 Coolant valves (sequence)   2 Fuse hunt → power relay
// 3 Spoke phase alignment (timing minigame)   4 Observatory access code
// 5 Gyroscope calibration — only reachable while floating in zero-g
import * as THREE from 'three';
import { DEG } from './config.js';
import { arcDelta } from './torusMath.js';

export const PUZZLE_LIST = [
  { id: 'coolant', label: 'Coolant loop — valve sequence',   place: 'Engineering Bay (48°)' },
  { id: 'power',   label: 'Power relay — 3 fuse cells',      place: 'Agricultural Belt (~100°)' },
  { id: 'spoke',   label: 'Spoke phase alignment',           place: 'Gamma Terminal (180°)' },
  { id: 'code',    label: 'Observatory uplink code',         place: 'Observatory Quarter (272°)' },
  { id: 'gyro',    label: 'Gyroscope calibration',           place: 'Spoke F strut, 17 m up (300°)' },
];

const HINTS = {
  coolant: 'Engineering Bay, 48°: watch the indicator lamps blink, then turn the valves in that order.',
  power:   'Agricultural Belt: three glowing fuse cells are marked by light beacons. Bring them to the relay cabinet at 104°.',
  spoke:   'Gamma Terminal, 180°: use the amber console and match the phase marker.',
  code:    'The observatory console needs a code. Maintenance stenciled it somewhere in Reservoir Flats…',
  gyro:    'Spoke F, 300°: the gyro panel sits 17 m up the shaft. Only reachable while gravity is down — ride the failure.',
};

export class PuzzleManager {
  constructor({ stations, ui, audio, gravity, player, rng }) {
    this.s = stations;
    this.ui = ui;
    this.audio = audio;
    this.gravity = gravity;
    this.player = player;
    this.rng = rng;

    this.solved = { coolant: false, power: false, spoke: false, code: false, gyro: false };
    this.onAllSolved = () => {};
    this.time = 0;
    this.current = null;

    // valve puzzle state
    this.valveSeq = [0, 1, 2, 3].sort(() => rng() - 0.5);
    this.valveProgress = 0;
    this.valveAnim = [0, 0, 0, 0];

    // fuses
    this.carried = 0;
    this.inserted = 0;

    this._buildInteractables();
  }

  get solvedCount() { return Object.values(this.solved).filter(Boolean).length; }

  _solve(id, msg) {
    if (this.solved[id]) return;
    this.solved[id] = true;
    this.audio.chime();
    this.ui.message(`✔ ${msg}`, 5);
    this.ui.setObjectives(this.solved);
    this.ui.setStability(this.solvedCount);
    if (this.solvedCount === 5) this.onAllSolved();
    else this.ui.message(`VEGA: Stability rising — ${this.solvedCount}/5 systems restored.`, 5);
  }

  _buildInteractables() {
    const S = this.s;
    const list = [];

    // 1 — valves
    for (const v of S.valves) {
      list.push({
        theta: v.theta, lat: v.lat, h: v.h, radius: 2.4,
        prompt: () => this.solved.coolant ? null : `[E] Turn valve ${v.index + 1}`,
        enabled: () => !this.solved.coolant,
        action: () => {
          if (v.index === this.valveSeq[this.valveProgress]) {
            this.valveProgress++;
            this.valveAnim[v.index] += Math.PI * 1.5;
            this.audio.beep();
            if (this.valveProgress >= 4) {
              this._solve('coolant', 'Coolant loop pressurized.');
            } else {
              this.ui.message(`Valve accepted (${this.valveProgress}/4)`, 2);
            }
          } else {
            this.valveProgress = 0;
            this.audio.buzz();
            this.ui.message('Pressure fault — sequence reset. Watch the lamps.', 3);
          }
        },
      });
    }

    // 2 — fuse pickups + relay
    for (const f of S.fuses) {
      list.push({
        theta: f.theta, lat: f.lat, h: f.h, radius: 2.2,
        prompt: () => `[E] Take fuse cell`,
        enabled: () => !f.taken && !this.solved.power,
        action: () => {
          f.taken = true;
          f.mesh.visible = false;
          f.beacon.visible = false;
          this.carried++;
          this.audio.pickup();
          this.ui.message(`Fuse cell acquired (${this.carried + this.inserted}/3). Relay cabinet is at 104°, roadside.`, 4);
        },
      });
    }
    list.push({
      theta: S.relay.theta, lat: S.relay.lat, h: 1.2, radius: 2.6,
      prompt: () => this.solved.power ? null
        : this.carried > 0 ? `[E] Insert ${this.carried} fuse cell${this.carried > 1 ? 's' : ''}`
        : 'Relay cabinet — needs fuse cells',
      enabled: () => !this.solved.power,
      action: () => {
        if (this.carried === 0) { this.audio.buzz(); return; }
        for (let i = this.inserted; i < this.inserted + this.carried && i < 3; i++) {
          const slot = S.relaySlots[i];
          slot.material.emissive.setHex(0x35c8e8);
          slot.material.color.setHex(0x9ff2ff);
        }
        this.inserted += this.carried;
        this.carried = 0;
        this.audio.beep();
        if (this.inserted >= 3) this._solve('power', 'District power rerouted.');
        else this.ui.message(`Fuse seated (${this.inserted}/3).`, 3);
      },
    });

    // 3 — spoke alignment console
    list.push({
      theta: S.alignConsole.theta, lat: S.alignConsole.lat, h: 1.3, radius: 2.6,
      prompt: () => this.solved.spoke ? null : '[E] Run spoke phase alignment',
      enabled: () => !this.solved.spoke,
      action: () => {
        this.ui.showAlignGame(ok => {
          if (ok) {
            S.alignConsole.screen.material.color.setHex(0x4dff88);
            this._solve('spoke', 'Spoke Gamma phase-locked.');
          }
        });
      },
    });

    // 4 — observatory code console
    list.push({
      theta: S.codeConsole.theta, lat: S.codeConsole.lat, h: 1.3, radius: 2.6,
      prompt: () => this.solved.code ? null : '[E] Observatory uplink terminal',
      enabled: () => !this.solved.code,
      action: () => {
        this.ui.showKeypad(S.code, ok => {
          if (ok) {
            S.codeConsole.screen.material.color.setHex(0x4dff88);
            this._solve('code', 'Observatory uplink authenticated.');
          }
        });
      },
    });

    // 5 — gyro panel (zero-g only)
    list.push({
      theta: S.gyroPanel.theta, lat: S.gyroPanel.lat, h: S.gyroPanel.h, radius: 3.4,
      prompt: () => this.solved.gyro ? null : '[E] Calibrate gyroscope',
      enabled: () => !this.solved.gyro && this.gravity.zeroG,
      action: () => {
        S.gyroPanel.screen.material.color.setHex(0x4dff88);
        if (S.gyroRing) S.gyroRing.visible = false;
        this._solve('gyro', 'Attitude gyroscope calibrated.');
      },
    });

    // plaza info terminal — hints
    list.push({
      theta: S.plazaTerminal.theta, lat: S.plazaTerminal.lat, h: 1.3, radius: 2.6,
      prompt: () => '[E] Station status terminal',
      enabled: () => true,
      action: () => {
        this.audio.beep();
        const next = PUZZLE_LIST.find(p => !this.solved[p.id]);
        if (!next) this.ui.message('VEGA: All systems nominal. Thank you, engineer.', 5);
        else this.ui.message(`VEGA: ${HINTS[next.id]}`, 7);
      },
    });

    this.interactables = list;
  }

  tryInteract() {
    if (this.current) this.current.action();
  }

  update(dt) {
    this.time += dt;

    // valve indicator lamps: blink the sequence, hold green for progress
    if (!this.solved.coolant) {
      const period = 4 * 0.7 + 1.1;
      const t = this.time % period;
      const showing = t < 4 * 0.7 ? this.valveSeq[Math.floor(t / 0.7)] : -1;
      const phase = (t % 0.7) < 0.45;
      this.s.valveLamps.forEach((lamp, i) => {
        const seqPos = this.valveSeq.indexOf(i);
        if (seqPos < this.valveProgress) lamp.material.emissive.setHex(0x2bff66);
        else if (i === showing && phase) lamp.material.emissive.setHex(0xffb020);
        else lamp.material.emissive.setHex(0x000000);
      });
    } else {
      this.s.valveLamps.forEach(l => l.material.emissive.setHex(0x2bff66));
    }

    // valve wheel spin animation
    this.s.valves.forEach((v, i) => {
      if (this.valveAnim[v.index] > 0.001) {
        const step = Math.min(this.valveAnim[v.index], dt * 5);
        v.wheel.rotateZ(step);
        this.valveAnim[v.index] -= step;
      }
    });

    // beacon + gyro ring pulse
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 2.4);
    for (const f of this.s.fuses) {
      if (!f.taken) f.beacon.material.opacity = 0.08 + 0.1 * pulse;
    }
    if (this.s.gyroRing && !this.solved.gyro) {
      this.s.gyroRing.material.opacity = 0.4 + 0.5 * pulse;
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
