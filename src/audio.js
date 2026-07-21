// ── Fully synthesized audio: ambience, klaxon, UI, footsteps ────────────────
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.klaxonNodes = null;
    this.whooshGain = null;
    this.stepTimer = 0;
  }

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(ctx.destination);

    // ambient station hum
    const hum1 = ctx.createOscillator(); hum1.type = 'sine'; hum1.frequency.value = 55;
    const hum2 = ctx.createOscillator(); hum2.type = 'sine'; hum2.frequency.value = 110.7;
    const humGain = ctx.createGain(); humGain.gain.value = 0.028;
    hum1.connect(humGain); hum2.connect(humGain);
    humGain.connect(this.master);
    hum1.start(); hum2.start();

    // filtered noise bed (air handlers)
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf; noise.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320;
    const nGain = ctx.createGain(); nGain.gain.value = 0.018;
    noise.connect(lp); lp.connect(nGain); nGain.connect(this.master);
    noise.start();
    this.noiseBuf = noiseBuf;

    // zero-g whoosh (bandpassed noise, gain driven per frame)
    const wn = ctx.createBufferSource();
    wn.buffer = noiseBuf; wn.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.6;
    this.whooshGain = ctx.createGain(); this.whooshGain.gain.value = 0;
    wn.connect(bp); bp.connect(this.whooshGain); this.whooshGain.connect(this.master);
    wn.start();
  }

  _env(node, t0, peak, attack, decay) {
    node.gain.setValueAtTime(0.0001, t0);
    node.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    node.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  tone(freq, dur = 0.1, type = 'sine', vol = 0.12, when = 0) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    osc.type = type; osc.frequency.value = freq;
    const g = this.ctx.createGain();
    this._env(g, t0, vol, 0.012, dur);
    osc.connect(g); g.connect(this.master);
    osc.start(t0); osc.stop(t0 + dur + 0.1);
  }

  beep() { this.tone(880, 0.07, 'square', 0.05); }
  buzz() { this.tone(130, 0.3, 'sawtooth', 0.12); this.tone(97, 0.3, 'sawtooth', 0.1); }
  pickup() { this.tone(760, 0.07, 'sine', 0.1); this.tone(1140, 0.12, 'sine', 0.1, 0.08); }
  chime() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.35, 'sine', 0.11, i * 0.11));
  }
  bigChime() {
    [392, 523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.6, 'sine', 0.11, i * 0.14));
  }
  hit() { this.tone(240, 0.06, 'square', 0.08); }

  gravityDownSweep() {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(340, t0);
    osc.frequency.exponentialRampToValueAtTime(40, t0 + 5.5);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.09, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 6);
    osc.connect(g); g.connect(this.master);
    osc.start(t0); osc.stop(t0 + 6.2);
  }

  gravityUpSweep() {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(40, t0);
    osc.frequency.exponentialRampToValueAtTime(300, t0 + 7);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.055, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 8);
    osc.connect(g); g.connect(this.master);
    osc.start(t0); osc.stop(t0 + 8.2);
  }

  klaxonStart() {
    if (!this.ctx || this.klaxonNodes) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    const lfo = this.ctx.createOscillator();
    lfo.type = 'square'; lfo.frequency.value = 1.1;
    const lfoGain = this.ctx.createGain(); lfoGain.gain.value = 110;
    osc.frequency.value = 540;
    lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
    const g = this.ctx.createGain(); g.gain.value = 0.035;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1600;
    osc.connect(lp); lp.connect(g); g.connect(this.master);
    osc.start(); lfo.start();
    this.klaxonNodes = { osc, lfo, g };
  }

  klaxonStop() {
    if (!this.klaxonNodes) return;
    const { osc, lfo, g } = this.klaxonNodes;
    g.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.4);
    setTimeout(() => { try { osc.stop(); lfo.stop(); } catch (_) {} }, 600);
    this.klaxonNodes = null;
  }

  footstep(vol = 0.05) {
    if (!this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 400 + Math.random() * 250;
    const g = this.ctx.createGain();
    const t0 = this.ctx.currentTime;
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
    src.connect(lp); lp.connect(g); g.connect(this.master);
    src.start(t0, Math.random() * 1.5, 0.1);
  }

  // per-frame: footsteps while walking + wind while flying
  update(dt, { grounded, groundSpeed, airSpeed, zeroG }) {
    if (!this.ctx) return;
    if (grounded && groundSpeed > 0.8) {
      this.stepTimer -= dt * groundSpeed;
      if (this.stepTimer <= 0) {
        this.footstep(0.03 + Math.min(0.04, groundSpeed * 0.004));
        this.stepTimer = 3.4;
      }
    }
    const target = zeroG ? Math.min(0.14, airSpeed * 0.009) : 0;
    const cur = this.whooshGain.gain.value;
    this.whooshGain.gain.value = cur + (target - cur) * Math.min(1, 3 * dt);
  }
}
