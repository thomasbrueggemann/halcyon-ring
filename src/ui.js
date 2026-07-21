// ── DOM HUD: prompts, objectives, alerts, minimap, modals, screens ──────────
import { DEG } from './config.js';
import { PUZZLE_LIST } from './puzzles.js';

const STATION_ANGLES = {
  coolant: 48, power: 104, spoke: 180, code: 272, gyro: 300,
};

export class UI {
  constructor() {
    this.$ = id => document.getElementById(id);
    this.modal = null;
    this.messages = [];
    this.winShown = false;
    this.audio = null;
    this.lockPointer = () => {};
    this.align = null;
    this.keypadState = null;

    document.addEventListener('keydown', e => {
      if (this.modal === 'align' && e.code === 'Space') { e.preventDefault(); this._alignHit(); }
      if (this.modal === 'align' && e.code === 'Escape') this._closeAlign(false);
      if (this.modal === 'keypad') {
        if (e.code === 'Escape') this._closeKeypad(false);
        else if (/^Digit(\d)$/.test(e.code)) this._kpDigit(e.code.slice(5));
        else if (e.code === 'Enter') this._kpEnter();
        else if (e.code === 'Backspace') this._kpClear();
      }
    });
  }

  init({ audio, lockPointer }) {
    this.audio = audio;
    this.lockPointer = lockPointer;

    // keypad buttons
    document.querySelectorAll('#keypad .kp').forEach(btn => {
      btn.addEventListener('click', () => this._kpDigit(btn.dataset.d));
    });
    this.$('kp-clear').addEventListener('click', () => this._kpClear());
    this.$('kp-enter').addEventListener('click', () => this._kpEnter());
    this.$('kp-cancel').addEventListener('click', () => this._closeKeypad(false));
    this.$('btn-resume').addEventListener('click', () => { this.hidePause(); this.lockPointer(); });
    this.$('btn-continue').addEventListener('click', () => {
      this.$('win').classList.add('hidden');
      this.lockPointer();
    });

    this.setObjectives({});
    this.setStability(0);
  }

  // ── screens ──
  showTitle(onStart) {
    this.$('btn-start').addEventListener('click', () => {
      this.$('title').classList.add('hidden');
      this.$('hud').classList.remove('hidden');
      onStart();
    }, { once: true });
  }

  showPause() { this.$('pause').classList.remove('hidden'); }
  hidePause() { this.$('pause').classList.add('hidden'); }

  showWin(seconds) {
    this.winShown = true;
    document.exitPointerLock?.();
    const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
    this.$('win-time').textContent = `Ring stabilized in ${m}:${String(s).padStart(2, '0')}`;
    this.$('win').classList.remove('hidden');
  }

  // ── HUD ──
  setPrompt(text) {
    const el = this.$('prompt');
    if (text) { el.textContent = text; el.classList.remove('hidden'); }
    else el.classList.add('hidden');
  }

  message(text, dur = 4) {
    this.messages.push({ text, until: performance.now() / 1000 + dur });
    if (this.messages.length > 3) this.messages.shift();
    this._renderMessages();
  }

  _renderMessages() {
    const now = performance.now() / 1000;
    this.messages = this.messages.filter(m => m.until > now);
    this.$('subtitle').innerHTML = this.messages.map(m => `<div>${m.text}</div>`).join('');
  }

  setAlert(mode) {
    const el = this.$('alert');
    el.className = '';
    if (mode === 'failing') { el.textContent = '⚠ GRAVITY DRIVE FAILURE — SPIN-DOWN IN PROGRESS'; el.classList.add('alert-red'); }
    else if (mode === 'zero') { el.textContent = 'ZERO-G — MANEUVERING THRUSTERS ACTIVE (SPACE/C to climb & descend)'; el.classList.add('alert-blue'); }
    else if (mode === 'recovering') { el.textContent = 'SPIN-UP IN PROGRESS — BRACE FOR GRAVITY'; el.classList.add('alert-amber'); }
    else el.classList.add('hidden');
  }

  setGravity(scale) {
    this.$('gmeter-fill').style.width = `${Math.round(scale * 100)}%`;
    this.$('gmeter-fill').style.background = scale > 0.5 ? '#69d970' : scale > 0.15 ? '#e8b23c' : '#e85050';
    this.$('gmeter-label').textContent = `${(scale * 0.94).toFixed(2)} g`;
  }

  setStability(n) {
    this.$('stability').textContent = `RING STABILITY ${n}/5`;
  }

  setObjectives(solved) {
    this.$('objectives').innerHTML = PUZZLE_LIST.map(p => {
      const done = solved[p.id];
      return `<li class="${done ? 'done' : ''}">${done ? '✔' : '○'} ${p.label}<span>${p.place}</span></li>`;
    }).join('');
  }

  // ── minimap ──
  drawMinimap(player, solved) {
    const cv = this.$('minimap');
    const ctx = cv.getContext('2d');
    const w = cv.width, cx = w / 2, cy = w / 2, R = w * 0.4;
    ctx.clearRect(0, 0, w, w);
    ctx.strokeStyle = 'rgba(140,190,220,0.85)';
    ctx.lineWidth = 7;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(140,190,220,0.35)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      const a = i * 60 * DEG;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + R * Math.sin(a), cy - R * Math.cos(a));
      ctx.stroke();
    }
    for (const [id, deg] of Object.entries(STATION_ANGLES)) {
      const a = deg * DEG;
      ctx.fillStyle = solved[id] ? '#54e07a' : '#ffb020';
      ctx.beginPath();
      ctx.arc(cx + R * Math.sin(a), cy - R * Math.cos(a), 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // player
    const pa = player.theta;
    const px = cx + R * Math.sin(pa), py = cy - R * Math.cos(pa);
    ctx.fillStyle = '#69d2ff';
    ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#69d2ff';
    ctx.lineWidth = 2;
    const ha = pa - player.yaw + Math.PI;
    ctx.beginPath(); ctx.moveTo(px, py);
    ctx.lineTo(px + 10 * Math.sin(ha), py - 10 * Math.cos(ha)); ctx.stroke();
  }

  // ── keypad modal ──
  showKeypad(code, cb) {
    this.modal = 'keypad';
    this.keypadState = { code: code.join(''), entry: '', cb };
    this.$('keypad-display').textContent = '····';
    this.$('keypad').classList.remove('hidden');
    document.exitPointerLock?.();
  }

  _kpDigit(d) {
    const st = this.keypadState;
    if (!st || st.entry.length >= 4) return;
    st.entry += d;
    this.$('keypad-display').textContent = st.entry.padEnd(4, '·');
    this.audio?.beep();
  }

  _kpClear() {
    if (!this.keypadState) return;
    this.keypadState.entry = '';
    this.$('keypad-display').textContent = '····';
  }

  _kpEnter() {
    const st = this.keypadState;
    if (!st) return;
    if (st.entry === st.code) this._closeKeypad(true);
    else {
      this.audio?.buzz();
      this.$('keypad-display').classList.add('shake');
      setTimeout(() => this.$('keypad-display').classList.remove('shake'), 400);
      st.entry = '';
      this.$('keypad-display').textContent = '····';
    }
  }

  _closeKeypad(ok) {
    const st = this.keypadState;
    this.modal = null;
    this.keypadState = null;
    this.$('keypad').classList.add('hidden');
    this.lockPointer();
    st?.cb(ok);
  }

  // ── alignment minigame ──
  showAlignGame(cb) {
    this.modal = 'align';
    this.align = { t: 0, speed: 1.6, center: 0.3 + Math.random() * 0.4, hits: 0, cb, flash: 0 };
    this.$('align').classList.remove('hidden');
    this.$('align-status').textContent = 'Match the phase: press SPACE inside the green window · 0/3';
  }

  _alignPos() {
    return 0.5 + 0.5 * Math.sin(this.align.t * this.align.speed * Math.PI);
  }

  _alignHit() {
    const a = this.align;
    if (!a) return;
    const pos = this._alignPos();
    if (Math.abs(pos - a.center) < 0.09) {
      a.hits++;
      a.flash = 0.25;
      this.audio?.beep();
      if (a.hits >= 3) { this._closeAlign(true); return; }
      a.center = 0.15 + Math.random() * 0.7;
      a.speed += 0.55;
      this.$('align-status').textContent = `Locked · ${a.hits}/3`;
    } else {
      a.hits = 0;
      a.speed = 1.6;
      this.audio?.buzz();
      this.$('align-status').textContent = 'Phase slip! Reset · 0/3';
    }
  }

  _closeAlign(ok) {
    const a = this.align;
    this.modal = null;
    this.align = null;
    this.$('align').classList.add('hidden');
    a?.cb(ok);
  }

  // ── per-frame ──
  update(dt) {
    this._renderMessages();
    if (this.align) {
      this.align.t += dt;
      this.align.flash = Math.max(0, this.align.flash - dt);
      const cv = this.$('align-canvas');
      const ctx = cv.getContext('2d');
      const w = cv.width, h = cv.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(20,30,40,0.9)';
      ctx.fillRect(0, 0, w, h);
      const zx = this.align.center * w;
      ctx.fillStyle = this.align.flash > 0 ? 'rgba(90,255,140,0.9)' : 'rgba(60,190,100,0.55)';
      ctx.fillRect(zx - 0.09 * w, 4, 0.18 * w, h - 8);
      const px = this._alignPos() * w;
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(px - 3, 2, 6, h - 4);
    }
  }
}
