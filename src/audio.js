// ── Fully synthesized audio: ambience, klaxon, UI, footsteps ────────────────
// Audible radius before a train's sound graph is created, and how far it has
// to get before we tear it down again. Everything closer than AUD_RADIUS is
// heard; the panner's inverse-distance rolloff plus a proximity gain do the
// loudness fade so a train out past ~2/3 of the radius is just a murmur.
const AUD_RADIUS = 160;
const RELEASE_RADIUS = 260;
// Fraction of each train's signal summed UNPANNED into both ears, on top of the
// panned image. Real ears always pick up some bleed, so a hard-left source keeps
// a whisper on the right ear rather than dropping to absolute zero.
const EAR_BLEED = 0.28;

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.klaxonNodes = null;
    this.whooshGain = null;
    this.stepTimer = 0;
    this._trains = new Map();    // train id -> running sound graph (lazy)
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

  // ── Monorail trains ────────────────────────────────────────────────────────
  // Each train gets one 3-D-positioned graph, created lazily the first time it
  // drifts within AUD_RADIUS of the listener ("load the sound when it's close")
  // and torn down again once it clears RELEASE_RADIUS. Running texture = an
  // electric motor whine whose pitch tracks the train's speed, plus bandpassed
  // air rush (speed²) and a low drive rumble — reads as a rubber-wheel monorail
  // rather than a steel rail clack. On arrival while you're near, a one-shot
  // airy brake hiss fires.
  _trainGraph() {
    const ctx = this.ctx;
    const pan = ctx.createPanner();
    pan.panningModel = 'equalpower';
    pan.distanceModel = 'inverse';
    pan.refDistance = 16;
    pan.maxDistance = 500;
    pan.rolloffFactor = 1.4;
    pan.connect(this.master);

    // electric motor whine: fundamental + slight detune + 2nd harmonic
    // (wc is the fixed mix level for the whine into the env — NOT 0, or the
    //  motor is silent and only the air rush would be heard)
    const wg = ctx.createGain(); wg.gain.value = 0.55;
    const o1 = ctx.createOscillator(); o1.type = 'sine';
    const o2 = ctx.createOscillator(); o2.type = 'sine';
    const o3 = ctx.createOscillator(); o3.type = 'triangle';
    const o2g = ctx.createGain(); o2g.gain.value = 0.6;
    const o3g = ctx.createGain(); o3g.gain.value = 0.25;
    o1.connect(wg); o2.connect(o2g); o2g.connect(wg); o3.connect(o3g); o3g.connect(wg);
    o1.start(); o2.start(); o3.start();

    // aerodynamic rush / swish: noise through a bandpass, scaled by speed²
    const ng = ctx.createGain(); ng.gain.value = 0;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.7;
    src.connect(bp); bp.connect(ng); src.start();

    // low body/guideway drive rumble
    const rg = ctx.createGain(); rg.gain.value = 0;
    const rsrc = ctx.createBufferSource(); rsrc.buffer = this.noiseBuf; rsrc.loop = true;
    const rlp = ctx.createBiquadFilter(); rlp.type = 'lowpass'; rlp.frequency.value = 150;
    rsrc.connect(rlp); rlp.connect(rg); rsrc.start();

    const env = ctx.createGain(); env.gain.value = 0.0001;
    wg.connect(env); ng.connect(env); rg.connect(env);
    env.connect(pan);

    // ear bleed: a fixed mono copy into both channels so the far ear never hits
    // silence even when the panner pushes the source hard to one side
    const bleed = ctx.createGain(); bleed.gain.value = EAR_BLEED;
    env.connect(bleed); bleed.connect(this.master);

    return { pan, bleed, env, o1, o2, o3, ng, rg, src, rsrc, brakingNow: false };
  }

  _releaseTrain(id, node) {
    this._trains.delete(id);
    const t0 = this.ctx.currentTime;
    node.env.gain.setTargetAtTime(0.0001, t0, 0.06);
    setTimeout(() => {
      try {
        node.o1.stop(); node.o2.stop(); node.o3.stop();
        node.src.stop(); node.rsrc.stop();
        node.pan.disconnect(); node.bleed.disconnect();
      } catch (_) {}
    }, 300);
  }

  // One-shot airy brake hiss: short filtered noise burst into the train's panner,
  // so it arrives from where the train actually is. `loud` is the proximity factor.
  _brakeHiss(pan, loud) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1300 + Math.random() * 700; bp.Q.value = 1.4;
    const g = ctx.createGain();
    const dur = 1.0 + Math.random() * 0.3;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.16 * loud, t0 + 0.07);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp); bp.connect(g); g.connect(pan);
    src.start(t0, Math.random() * 2, dur + 0.25);
  }

  // Drive every train's sound. `list` = [{ id, x, y, z, speed, braking }],
  // `lx/ly/lz` = the listener's (player's) world position, `fwd`/`up` its
  // facing so the panning is anchored to where the player is looking (camera
  // mouse-look), not fixed to the world. Positioned with a full 3-D panner, so
  // approach/retreat and left-right placement come for free.
  updateTrains(list, lx, ly, lz, fwd, upv) {
    const ctx = this.ctx;
    if (!ctx) return;
    const L = ctx.listener;
    if (L.positionX) { L.positionX.value = lx; L.positionY.value = ly; L.positionZ.value = lz; }
    else L.setPosition(lx, ly, lz);
    // anchor the stereo field to the camera's look direction
    if (L.forwardX) {
      L.forwardX.value = fwd.x; L.forwardY.value = fwd.y; L.forwardZ.value = fwd.z;
      L.upX.value = upv.x; L.upY.value = upv.y; L.upZ.value = upv.z;
    } else L.setOrientation(fwd.x, fwd.y, fwd.z, upv.x, upv.y, upv.z);

    for (const t of list) {
      const dx = t.x - lx, dy = t.y - ly, dz = t.z - lz;
      const dist = Math.hypot(dx, dy, dz);

      // "load the sound when the train gets closer": no graph, no cost, until
      // it is within earshot.
      let node = this._trains.get(t.id);
      if (!node && dist < AUD_RADIUS) {
        node = this._trainGraph();
        this._trains.set(t.id, node);
      }
      if (!node) continue;
      if (dist > RELEASE_RADIUS) { this._releaseTrain(t.id, node); continue; }

      const pan = node.pan;
      if (pan.positionX) { pan.positionX.value = t.x; pan.positionY.value = t.y; pan.positionZ.value = t.z; }
      else pan.setPosition(t.x, t.y, t.z);

      const speed = Math.max(0, t.speed);
      // motor whine pitch up with speed (cruise ≈ 21 m/s → ~155 Hz + harmonic)
      const f = 38 + speed * 5.5;
      node.o1.frequency.value = f;
      node.o2.frequency.value = f * 1.006;
      node.o3.frequency.value = f * 1.5;
      // air rush is kept whisper-quiet so the motor stays the dominant voice;
      // low drive rumble stays subtle too. Both scale with speed².
      const sp2 = (speed / 21) * (speed / 21);
      node.ng.gain.setTargetAtTime(0.018 * sp2, ctx.currentTime, 0.05);
      node.rg.gain.setTargetAtTime(0.03 * sp2, ctx.currentTime, 0.05);

      // overall loudness: proximity × speed (a stopped idling train is faint)
      const prox = (AUD_RADIUS - dist) / (AUD_RADIUS * 0.55);
      const lvl = Math.max(0, Math.min(1, prox)) * (0.05 + 0.3 * Math.min(1, speed / 21));
      node.env.gain.setTargetAtTime(lvl, ctx.currentTime, 0.05);

      // airy brake hiss when the train settles to a stop near you
      if (t.braking || speed < 0.6) {
        if (!node.brakingNow) {
          node.brakingNow = true;
          this._brakeHiss(pan, Math.max(0, Math.min(1, prox)));
        }
      } else if (speed > 2) {
        node.brakingNow = false;
      }
    }
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
