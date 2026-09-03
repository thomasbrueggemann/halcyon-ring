// ── DOM HUD: prompts, objectives, compass, alerts, minimap, modals, screens ──

const STATION_ANGLES = {
  coolant: 48, power: 104, spoke: 180, code: 272, gyro: 300,
};

class UI {
  constructor() {
    this.$ = id => document.getElementById(id);
    this.modal = null;
    this.messages = [];
    this.winShown = false;
    this.audio = null;
    this.lockPointer = () => {};
    this.keypadState = null;
    this.circuit = null;
    this.wave = null;
    this.dish = null;
    this.held = new Set();
    this.resets = 0;               // failed codes and abandoned minigames

    document.addEventListener('keydown', e => {
      if (!this.modal) return;
      this.held.add(e.code);
      if (this.modal === 'keypad') {
        if (e.code === 'Escape') this._closeKeypad(false);
        else if (/^Digit(\d)$/.test(e.code)) this._kpDigit(e.code.slice(5));
        else if (/^Numpad(\d)$/.test(e.code)) this._kpDigit(e.code.slice(6));
        else if (e.code === 'Enter') this._kpEnter();
        else if (e.code === 'Backspace') this._kpClear();
      } else if (this.modal === 'circuit') {
        e.preventDefault();
        if (e.code === 'Escape') this._closeCircuit(false);
        else this._circuitKey(e.code);
      } else if (this.modal === 'wave') {
        if (e.code === 'Escape') this._closeWave(false);
      } else if (this.modal === 'dish') {
        if (e.code === 'Escape') this._closeDish(false);
      }
    });
    document.addEventListener('keyup', e => this.held.delete(e.code));
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
    this.$('circuit-cancel').addEventListener('click', () => this._closeCircuit(false));
    this.$('wave-cancel').addEventListener('click', () => this._closeWave(false));
    this.$('dish-cancel').addEventListener('click', () => this._closeDish(false));
    const cc = this.$('circuit-canvas');
    cc.addEventListener('click', e => {
      if (!this.circuit) return;
      const r = cc.getBoundingClientRect();
      const x = (e.clientX - r.left) * (cc.width / r.width), y = (e.clientY - r.top) * (cc.height / r.height);
      const N = this.circuit.n, T = cc.width / N;
      const c = Math.floor(x / T), rr = Math.floor(y / T);
      if (c >= 0 && c < N && rr >= 0 && rr < N) { this.circuit.cur = [rr, c]; this._circuitRotate(); }
    });

    this.setObjectives({}, null);
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

  showWin(stats) {
    this.winShown = true;
    document.exitPointerLock?.();
    const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const t = stats.seconds;
    const rank = t < 12 * 60 ? 'S' : t < 18 * 60 ? 'A' : t < 26 * 60 ? 'B' : 'C';
    const rankText = { S: 'flawless shift', A: 'chief engineer material', B: 'solid work', C: 'the ring is safe. Eventually.' }[rank];
    this.$('win-time').textContent = `Ring stabilized in ${mmss(t)}`;
    this.$('win-report').innerHTML = `
      <div class="rank">RANK <b>${rank}</b><span>${rankText}</span></div>
      <ul>
        <li><span>Distance on foot</span><b>${(stats.distance / 1000).toFixed(2)} km</b></li>
        <li><span>Gravity failures survived</span><b>${stats.failures}</b></li>
        <li><span>Time in free fall</span><b>${mmss(stats.zeroTime)}</b></li>
        <li><span>Train rides</span><b>${stats.rides}</b></li>
        <li><span>Repairs without a reset</span><b>${stats.cleanRepairs}/5</b></li>
      </ul>`;
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
    const before = this.messages.length;
    this.messages = this.messages.filter(m => m.until > now);
    if (this.messages.length !== before || this._msgDirty !== this.messages.length) {
      this.$('subtitle').innerHTML = this.messages.map(m => `<div>${m.text}</div>`).join('');
      this._msgDirty = this.messages.length;
    }
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

  setFaultTimer(gravity) {
    const el = this.$('fault-timer');
    const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
    if (gravity.stabilized) { el.textContent = 'FLYWHEEL STABLE'; el.className = 'ok'; return; }
    if (gravity.mode === 'stable') { el.textContent = `NEXT FAULT ${mmss(gravity.timer)}`; el.className = gravity.timer < 15 ? 'warn' : ''; }
    else if (gravity.mode === 'zerog') { el.textContent = `SPIN RETURNS ${mmss(gravity.timer)}`; el.className = gravity.timer < 8 ? 'warn' : 'zero'; }
    else if (gravity.mode === 'spindown') { el.textContent = 'SPINNING DOWN'; el.className = 'warn'; }
    else { el.textContent = 'SPINNING UP'; el.className = 'warn'; }
  }

  setStability(n) {
    this.$('stability').textContent = `RING STABILITY ${n}/5`;
  }

  setObjectives(solved, tracked) {
    this.$('objectives').innerHTML = PUZZLE_LIST.map(p => {
      const done = solved[p.id];
      const tr = !done && p.id === tracked;
      return `<li class="${done ? 'done' : ''}${tr ? ' tracked' : ''}">${done ? '✔' : tr ? '▶' : '○'} ${p.label}<span>${p.place}</span></li>`;
    }).join('') + `<li class="hint">TAB · switch tracked repair</li>`;
  }

  // ── compass strip: where the tracked objective is, relative to your facing ──
  drawCompass(bearing, dist, label, vertical) {
    const cv = this.$('compass');
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    if (label == null) return;
    ctx.fillStyle = 'rgba(6,12,20,0.55)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(105,210,255,0.25)'; ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    // ticks every 30° across a ±90° window
    ctx.strokeStyle = 'rgba(140,190,220,0.45)';
    for (let a = -90; a <= 90; a += 30) {
      const x = w / 2 + (a / 90) * (w / 2 - 12);
      ctx.beginPath(); ctx.moveTo(x, h - 6); ctx.lineTo(x, h - (a === 0 ? 14 : 10)); ctx.stroke();
    }
    // objective marker
    const deg = bearing * 180 / Math.PI;
    const clamped = Math.max(-100, Math.min(100, deg));
    const x = w / 2 + (clamped / 90) * (w / 2 - 12);
    const behind = Math.abs(deg) > 100;
    ctx.fillStyle = behind ? '#ffb020' : '#69d2ff';
    ctx.beginPath();
    if (behind) {
      const dir = deg > 0 ? 1 : -1;
      const ex = dir > 0 ? w - 10 : 10;
      ctx.moveTo(ex, h / 2 - 2); ctx.lineTo(ex - dir * 8, h / 2 - 8); ctx.lineTo(ex - dir * 8, h / 2 + 4); ctx.closePath();
    } else {
      ctx.moveTo(x, 6); ctx.lineTo(x + 6, 14); ctx.lineTo(x, 22); ctx.lineTo(x - 6, 14); ctx.closePath();
    }
    ctx.fill();
    ctx.fillStyle = '#dce8f2';
    ctx.font = '11px "Avenir Next", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, 8, 14);
    ctx.textAlign = 'right';
    const dtxt = dist >= 1000 ? `${(dist / 1000).toFixed(2)} km` : `${Math.round(dist)} m`;
    ctx.fillText(dtxt + (vertical > 6 ? ` ▲${Math.round(vertical)} m` : vertical < -6 ? ` ▼${Math.round(-vertical)} m` : ''), w - 8, 14);
  }

  // ── minimap ──
  drawMinimap(player, solved, tracked, trains) {
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
    // monorail stations (small cyan diamonds)
    if (typeof STATIONS !== 'undefined') {
      ctx.fillStyle = '#4fd0e0';
      for (const st of STATIONS) {
        const a = st.theta;
        const sx = cx + R * Math.sin(a), sy = cy - R * Math.cos(a);
        ctx.save(); ctx.translate(sx, sy); ctx.rotate(Math.PI / 4);
        ctx.fillRect(-3, -3, 6, 6);
        ctx.restore();
      }
    }
    // trains
    if (trains) {
      ctx.fillStyle = 'rgba(220,235,245,0.9)';
      for (const t of trains) {
        ctx.beginPath(); ctx.arc(cx + (R + 7) * Math.sin(t.theta), cy - (R + 7) * Math.cos(t.theta), 2, 0, 7); ctx.fill();
      }
    }
    for (const [id, deg] of Object.entries(STATION_ANGLES)) {
      const a = deg * DEG;
      const px = cx + R * Math.sin(a), py = cy - R * Math.cos(a);
      if (id === tracked && !solved[id]) {
        ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2;
        const pr = 7 + 2 * Math.sin(performance.now() / 200);
        ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = solved[id] ? '#54e07a' : '#ffb020';
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
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
      this.resets++;
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
    if (!ok) this.lockPointer();
    st?.cb(ok);
  }

  // ── relay routing: rotate pipe tiles until power crosses the grid ──
  // Tiles are 4-bit connection masks (N=1 E=2 S=4 W=8). The solution path is
  // laid first and then every tile is scrambled, so it is always solvable.
  showCircuitGame(cb) {
    const N = 5;
    const rnd = Math.random;
    // random simple path from (2,0) to (2,N-1)
    let path = null;
    const tryPath = () => {
      const seen = new Set();
      const out = [];
      const dfs = (r, c) => {
        out.push([r, c]); seen.add(r * N + c);
        if (r === 2 && c === N - 1) return true;
        const dirs = [[0, 1], [1, 0], [-1, 0], [0, -1]].sort(() => rnd() - 0.5);
        // bias toward the sink so paths wander but do not fill the board
        dirs.sort((a, b) => (rnd() < 0.55 ? (b[1] - a[1]) : 0));
        for (const [dr, dc] of dirs) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= N || nc >= N || seen.has(nr * N + nc)) continue;
          if (dfs(nr, nc)) return true;
        }
        out.pop(); seen.delete(r * N + c);
        return false;
      };
      return dfs(2, 0) ? out : null;
    };
    for (let k = 0; k < 40 && (!path || path.length < 7 || path.length > 14); k++) path = tryPath();
    const dirBit = (dr, dc) => dr === -1 ? 1 : dc === 1 ? 2 : dr === 1 ? 4 : 8;
    const opp = b => ((b << 2) | (b >> 2)) & 15;
    const tiles = Array.from({ length: N * N }, () => [5, 10, 3, 6, 12, 9][Math.floor(rnd() * 6)]);
    const onPath = new Set();
    for (let i = 0; i < path.length; i++) {
      const [r, c] = path[i];
      let m = 0;
      if (i === 0) m |= 8; else { const [pr, pc] = path[i - 1]; m |= dirBit(pr - r, pc - c); }
      if (i === path.length - 1) m |= 2; else { const [nr, nc] = path[i + 1]; m |= dirBit(nr - r, nc - c); }
      tiles[r * N + c] = m;
      onPath.add(r * N + c);
    }
    const rot = m => ((m << 1) | (m >> 3)) & 15;
    for (let i = 0; i < tiles.length; i++) {
      const k = Math.floor(rnd() * 4);
      for (let j = 0; j < k; j++) tiles[i] = rot(tiles[i]);
    }
    this.circuit = { n: N, tiles, cur: [2, 0], cb, lit: new Set(), solvedAt: 0, moves: 0, opp, rot };
    // never hand out an already-solved board
    this._circuitFlow();
    if (this.circuit.done) { for (let i = 0; i < 3; i++) tiles[i * N + 1] = rot(tiles[i * N + 1]); this._circuitFlow(); }
    this.modal = 'circuit';
    this.$('circuit').classList.remove('hidden');
    this.$('circuit-status').textContent = 'Rotate tiles (click, or arrows + SPACE) until power reaches the far bus.';
    document.exitPointerLock?.();
    this._drawCircuit();
  }

  _circuitFlow() {
    const c = this.circuit;
    const N = c.n;
    const lit = new Set();
    const q = [];
    if (c.tiles[2 * N] & 8) { q.push(2 * N); lit.add(2 * N); }
    while (q.length) {
      const i = q.shift();
      const r = Math.floor(i / N), col = i % N;
      const m = c.tiles[i];
      for (const [bit, dr, dc] of [[1, -1, 0], [2, 0, 1], [4, 1, 0], [8, 0, -1]]) {
        if (!(m & bit)) continue;
        const nr = r + dr, nc = col + dc;
        if (nr < 0 || nc < 0 || nr >= N || nc >= N) continue;
        const j = nr * N + nc;
        if (lit.has(j) || !(c.tiles[j] & c.opp(bit))) continue;
        lit.add(j); q.push(j);
      }
    }
    c.lit = lit;
    c.done = lit.has(2 * N + N - 1) && !!(c.tiles[2 * N + N - 1] & 2);
  }

  _circuitKey(code) {
    const c = this.circuit;
    if (!c || c.done) return;
    if (code === 'ArrowUp' || code === 'KeyW') c.cur[0] = Math.max(0, c.cur[0] - 1);
    else if (code === 'ArrowDown' || code === 'KeyS') c.cur[0] = Math.min(c.n - 1, c.cur[0] + 1);
    else if (code === 'ArrowLeft' || code === 'KeyA') c.cur[1] = Math.max(0, c.cur[1] - 1);
    else if (code === 'ArrowRight' || code === 'KeyD') c.cur[1] = Math.min(c.n - 1, c.cur[1] + 1);
    else if (code === 'Space' || code === 'KeyE' || code === 'Enter') { this._circuitRotate(); return; }
    this._drawCircuit();
  }

  _circuitRotate() {
    const c = this.circuit;
    if (!c || c.done) return;
    const i = c.cur[0] * c.n + c.cur[1];
    c.tiles[i] = c.rot(c.tiles[i]);
    c.moves++;
    this.audio?.click();
    this._circuitFlow();
    this._drawCircuit();
    if (c.done) {
      this.audio?.lock();
      this.$('circuit-status').textContent = `Bus energised in ${c.moves} moves. Relay closing…`;
      c.solvedAt = performance.now();
      setTimeout(() => this._closeCircuit(true), 900);
    } else {
      this.$('circuit-status').textContent = `${c.lit.size} tiles live · ${c.moves} moves`;
    }
  }

  _drawCircuit() {
    const c = this.circuit;
    if (!c) return;
    const cv = this.$('circuit-canvas');
    const ctx = cv.getContext('2d');
    const N = c.n, T = cv.width / N;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#0b141c';
    ctx.fillRect(0, 0, cv.width, cv.height);
    for (let r = 0; r < N; r++) for (let col = 0; col < N; col++) {
      const i = r * N + col, m = c.tiles[i];
      const x = col * T, y = r * T, cx = x + T / 2, cy = y + T / 2;
      const isCur = c.cur[0] === r && c.cur[1] === col;
      ctx.fillStyle = isCur ? 'rgba(105,210,255,0.14)' : (r + col) % 2 ? '#111d27' : '#0f1a23';
      ctx.fillRect(x + 1, y + 1, T - 2, T - 2);
      const lit = c.lit.has(i);
      ctx.strokeStyle = lit ? '#5ef0ff' : '#3b4a57';
      ctx.lineWidth = lit ? 11 : 9;
      ctx.lineCap = 'round';
      ctx.shadowBlur = lit ? 14 : 0; ctx.shadowColor = '#5ef0ff';
      const arm = (dx, dy) => { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + dx * T * 0.5, cy + dy * T * 0.5); ctx.stroke(); };
      if (m & 1) arm(0, -1); if (m & 2) arm(1, 0); if (m & 4) arm(0, 1); if (m & 8) arm(-1, 0);
      ctx.shadowBlur = 0;
      ctx.fillStyle = lit ? '#bffaff' : '#556877';
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 7); ctx.fill();
      if (isCur) { ctx.strokeStyle = '#69d2ff'; ctx.lineWidth = 2; ctx.strokeRect(x + 2.5, y + 2.5, T - 5, T - 5); }
    }
    // source and sink buses
    ctx.fillStyle = '#5ef0ff';
    ctx.fillRect(0, 2 * T + T * 0.3, 6, T * 0.4);
    ctx.fillStyle = c.done ? '#54e07a' : '#ffb020';
    ctx.fillRect(cv.width - 6, 2 * T + T * 0.3, 6, T * 0.4);
  }

  _closeCircuit(ok) {
    if (!ok) this.resets++;
    const c = this.circuit;
    this.modal = null;
    this.circuit = null;
    this.$('circuit').classList.add('hidden');
    this.lockPointer();
    c?.cb(ok);
  }

  // ── spoke phase lock: tune an oscillator until it overlays the spoke's own ──
  showWaveGame(cb) {
    this.modal = 'wave';
    this.wave = { cb, stage: 0, hold: 0, t: 0, coh: 0 };
    this._waveStage();
    this.$('wave').classList.remove('hidden');
    document.exitPointerLock?.();
  }

  _waveStage() {
    const w = this.wave;
    const r = Math.random;
    w.target = { f: 1.6 + r() * 1.9, p: r() * Math.PI * 2, a: 0.45 + r() * 0.4 };
    w.me = { f: 1.2 + r() * 2.6, p: r() * Math.PI * 2, a: w.stage >= 1 ? 0.3 + r() * 0.6 : w.target.a };
    w.hold = 0;
    const labels = ['STAGE 1 · frequency + phase', 'STAGE 2 · frequency, phase + amplitude', 'STAGE 3 · fine lock — tighter window'];
    this.$('wave-status').textContent = labels[w.stage];
  }

  _waveUpdate(dt) {
    const w = this.wave;
    if (!w) return;
    w.t += dt;
    const k = this.held;
    const spd = w.stage === 2 ? 0.55 : 1;
    if (k.has('KeyW') || k.has('ArrowUp')) w.me.f += 0.7 * spd * dt;
    if (k.has('KeyS') || k.has('ArrowDown')) w.me.f -= 0.7 * spd * dt;
    if (k.has('KeyD') || k.has('ArrowRight')) w.me.p += 1.6 * spd * dt;
    if (k.has('KeyA') || k.has('ArrowLeft')) w.me.p -= 1.6 * spd * dt;
    if (k.has('KeyR')) w.me.a += 0.45 * spd * dt;
    if (k.has('KeyF')) w.me.a -= 0.45 * spd * dt;
    w.me.f = Math.max(0.6, Math.min(4.2, w.me.f));
    w.me.a = Math.max(0.15, Math.min(0.95, w.me.a));
    // coherence: 1 − RMS mismatch across the window
    let err = 0;
    const S = 64;
    for (let i = 0; i < S; i++) {
      const x = i / S;
      const a = w.target.a * Math.sin(x * Math.PI * 2 * w.target.f + w.target.p);
      const b = w.me.a * Math.sin(x * Math.PI * 2 * w.me.f + w.me.p);
      err += (a - b) * (a - b);
    }
    const coh = Math.max(0, 1 - Math.sqrt(err / S) / 0.7);
    w.coh += (coh - w.coh) * Math.min(1, 12 * dt);
    const need = w.stage === 2 ? 0.975 : 0.955;
    if (w.coh > need) {
      w.hold += dt;
      if (w.hold > 1.2) {
        this.audio?.lock();
        w.stage++;
        if (w.stage >= 3) { this.$('wave-status').textContent = 'PHASE LOCKED'; setTimeout(() => this._closeWave(true), 700); this.wave.locked = true; return; }
        this._waveStage();
      }
    } else w.hold = Math.max(0, w.hold - dt * 2);
    this._drawWave();
  }

  _drawWave() {
    const w = this.wave;
    const cv = this.$('wave-canvas');
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, mid = H * 0.5, amp = H * 0.36;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#08131a'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(105,210,255,0.12)'; ctx.lineWidth = 1;
    for (let x = 0; x < W; x += W / 16) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += H / 6) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    const trace = (o, color, width, glow) => {
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.shadowBlur = glow; ctx.shadowColor = color;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 2) {
        const u = x / W;
        const y = mid - o.a * amp / 0.95 * Math.sin(u * Math.PI * 2 * o.f + o.p + w.t * 1.7);
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
    trace(w.target, w.locked ? '#54e07a' : 'rgba(84,224,122,0.8)', 3, 10);
    trace(w.me, '#ffd166', 2, 6);
    // coherence bar
    const bw = W - 40;
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(20, H - 16, bw, 8);
    ctx.fillStyle = w.coh > 0.95 ? '#54e07a' : '#ffb020';
    ctx.fillRect(20, H - 16, bw * w.coh, 8);
    ctx.fillStyle = '#9fdcff'; ctx.font = '11px monospace'; ctx.textAlign = 'left';
    ctx.fillText(`COHERENCE ${(w.coh * 100).toFixed(1)}%`, 20, H - 22);
    ctx.textAlign = 'right';
    ctx.fillText(`f ${w.me.f.toFixed(2)}  φ ${((w.me.p % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)).toFixed(2)}  A ${w.me.a.toFixed(2)}`, W - 20, H - 22);
    if (w.hold > 0) { ctx.fillStyle = '#54e07a'; ctx.fillRect(20, H - 6, bw * Math.min(1, w.hold / 1.2), 3); }
  }

  _closeWave(ok) {
    if (!ok) this.resets++;
    const w = this.wave;
    this.modal = null;
    this.wave = null;
    this.$('wave').classList.add('hidden');
    this.lockPointer();
    w?.cb(ok);
  }

  // ── dish lock: sweep azimuth/elevation for the carrier, hold it ──
  showDishGame(cb) {
    this.modal = 'dish';
    const r = Math.random;
    this.dish = { cb, az: 0, el: 0, tgt: [(r() - 0.5) * 120, (r() - 0.5) * 120], hold: 0, sig: 0, stage: 0, tick: 0, t: 0 };
    this.$('dish').classList.remove('hidden');
    this.$('dish-status').textContent = 'Sweep with WASD. The tick rate rises as you close on the carrier — hold it to lock.';
    document.exitPointerLock?.();
  }

  _dishUpdate(dt) {
    const d = this.dish;
    if (!d) return;
    d.t += dt;
    const k = this.held;
    const spd = 42;
    if (k.has('KeyD') || k.has('ArrowRight')) d.az += spd * dt;
    if (k.has('KeyA') || k.has('ArrowLeft')) d.az -= spd * dt;
    if (k.has('KeyW') || k.has('ArrowUp')) d.el += spd * dt;
    if (k.has('KeyS') || k.has('ArrowDown')) d.el -= spd * dt;
    d.az = Math.max(-90, Math.min(90, d.az)); d.el = Math.max(-90, Math.min(90, d.el));
    // stage 2: the carrier drifts slowly, so you have to track it
    if (d.stage === 1) { d.tgt[0] += Math.sin(d.t * 0.7) * 6 * dt; d.tgt[1] += Math.cos(d.t * 0.5) * 6 * dt; }
    const dist = Math.hypot(d.az - d.tgt[0], d.el - d.tgt[1]);
    const sig = Math.exp(-(dist * dist) / (2 * 22 * 22));
    d.sig += (sig - d.sig) * Math.min(1, 10 * dt);
    d.tick -= dt;
    if (d.tick <= 0) {
      this.audio?.geiger(d.sig);
      d.tick = 0.05 + (1 - d.sig) * (1 - d.sig) * 0.9;
    }
    if (d.sig > 0.955) {
      d.hold += dt;
      if (d.hold > 1.0) {
        this.audio?.lock();
        d.stage++;
        d.hold = 0;
        if (d.stage >= 2) { this.$('dish-status').textContent = 'CARRIER LOCKED'; d.locked = true; setTimeout(() => this._closeDish(true), 700); return; }
        d.tgt = [(Math.random() - 0.5) * 140, (Math.random() - 0.5) * 140];
        this.$('dish-status').textContent = 'Carrier drift — reacquire and track it.';
      }
    } else d.hold = Math.max(0, d.hold - dt * 2);
    this._drawDish();
  }

  _drawDish() {
    const d = this.dish;
    const cv = this.$('dish-canvas');
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2, R = W * 0.45;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#08131a'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(105,210,255,0.2)'; ctx.lineWidth = 1;
    for (let k = 1; k <= 3; k++) { ctx.beginPath(); ctx.arc(cx, cy, R * k / 3, 0, 7); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    // signal noise: a starfield that brightens and tightens with signal
    const n = 90;
    for (let i = 0; i < n; i++) {
      const a = (i * 2.399) + d.t * 0.2, rr = R * (0.15 + 0.85 * ((i * 0.618) % 1));
      const jitter = (1 - d.sig) * 14;
      const x = cx + Math.cos(a) * rr + (Math.random() - 0.5) * jitter, y = cy + Math.sin(a) * rr + (Math.random() - 0.5) * jitter;
      ctx.fillStyle = `rgba(105,210,255,${0.06 + d.sig * 0.25})`;
      ctx.fillRect(x, y, 1.5, 1.5);
    }
    // sweep line
    const sa = d.t * 1.4;
    ctx.strokeStyle = 'rgba(105,210,255,0.35)'; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(sa) * R, cy + Math.sin(sa) * R); ctx.stroke();
    // carrier bloom (only visible when close)
    if (d.sig > 0.35) {
      const tx = cx + (d.tgt[0] / 90) * R, ty = cy - (d.tgt[1] / 90) * R;
      const g = ctx.createRadialGradient(tx, ty, 0, tx, ty, 26);
      g.addColorStop(0, `rgba(84,224,122,${(d.sig - 0.35) * 1.2})`); g.addColorStop(1, 'rgba(84,224,122,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(tx, ty, 26, 0, 7); ctx.fill();
    }
    // aim reticle
    const ax = cx + (d.az / 90) * R, ay = cy - (d.el / 90) * R;
    ctx.strokeStyle = d.sig > 0.955 ? '#54e07a' : '#ffd166'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ax, ay, 10, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ax - 16, ay); ctx.lineTo(ax - 6, ay); ctx.moveTo(ax + 6, ay); ctx.lineTo(ax + 16, ay);
    ctx.moveTo(ax, ay - 16); ctx.lineTo(ax, ay - 6); ctx.moveTo(ax, ay + 6); ctx.lineTo(ax, ay + 16); ctx.stroke();
    // signal bar
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(16, H - 18, W - 32, 8);
    ctx.fillStyle = d.sig > 0.955 ? '#54e07a' : '#ffb020'; ctx.fillRect(16, H - 18, (W - 32) * d.sig, 8);
    if (d.hold > 0) { ctx.fillStyle = '#54e07a'; ctx.fillRect(16, H - 8, (W - 32) * Math.min(1, d.hold), 3); }
    ctx.fillStyle = '#9fdcff'; ctx.font = '11px monospace'; ctx.textAlign = 'left';
    ctx.fillText(`SIGNAL ${(d.sig * 100).toFixed(0)}%  ·  AZ ${d.az.toFixed(0)}°  EL ${d.el.toFixed(0)}°  ·  LOCK ${d.stage}/2`, 16, H - 24);
  }

  _closeDish(ok) {
    if (!ok) this.resets++;
    const d = this.dish;
    this.modal = null;
    this.dish = null;
    this.$('dish').classList.add('hidden');
    this.lockPointer();
    d?.cb(ok);
  }

  // ── per-frame ──
  update(dt) {
    this._renderMessages();
    if (this.wave && !this.wave.locked) this._waveUpdate(dt);
    if (this.dish && !this.dish.locked) this._dishUpdate(dt);
  }
}
