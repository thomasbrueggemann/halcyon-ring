// ── Procedural textures ─────────────────────────────────────────────────────
// Everything here is generated at load time — no downloaded assets.
//
// The old version drew single random PIXELS onto a canvas, which reads as TV
// static up close and as flat mush at any distance, and it produced albedo
// only, so every surface in the game was lit like coloured paper. This version
// builds proper tileable multi-octave value-noise FIELDS, derives NORMAL and
// ROUGHNESS maps from them, and hands three.js a full material set. That is
// most of the difference between "flat shaded boxes" and something that reads
// as real ground, stone and asphalt.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Tileable fBm value noise ────────────────────────────────────────────────
// Each octave gets its own small wrapping lattice, so the result tiles exactly
// at `size` no matter how many octaves are stacked. Lattices are built once per
// octave and then sampled, rather than hashing per pixel — that is the whole
// difference between ~60 ms and ~2 s for a 512² field.
// `aspect` > 1 stretches features along X (wind-streaked ripples, strata) by
// using a coarser lattice across than down — done in the lattice rather than by
// resampling, so the result still tiles exactly.
function fbmField(size, cells, octaves, seed, { gain = 0.5, ridged = false, warp = 0, aspect = 1 } = {}) {
  const out = new Float32Array(size * size);
  let amp = 1, norm = 0, cx = Math.max(1, Math.round(cells / aspect)), cy = cells;
  for (let o = 0; o < octaves; o++) {
    const rnd = mulberry32((seed * 2654435761 + o * 40503) >>> 0);
    const lat = new Float32Array(cx * cy);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    const stepX = size / cx, stepY = size / cy;
    for (let y = 0; y < size; y++) {
      const fy = y / stepY, y0 = Math.floor(fy), ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const r0 = (((y0 % cy) + cy) % cy) * cx, r1 = ((((y0 + 1) % cy) + cy) % cy) * cx;
      const row = y * size;
      for (let x = 0; x < size; x++) {
        const fx = x / stepX, x0 = Math.floor(fx), tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const c0 = ((x0 % cx) + cx) % cx, c1 = (((x0 + 1) % cx) + cx) % cx;
        const a = lat[r0 + c0] * (1 - sx) + lat[r0 + c1] * sx;
        const b = lat[r1 + c0] * (1 - sx) + lat[r1 + c1] * sx;
        let v = a * (1 - sy) + b * sy;
        if (ridged) v = 1 - Math.abs(2 * v - 1);
        out[row + x] += v * amp;
      }
    }
    norm += amp; amp *= gain; cx *= 2; cy *= 2;
  }
  const inv = 1 / norm;
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  if (warp > 0) {
    // domain-warp by the field itself: turns bland blobs into flowing strata
    const src = out.slice();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = src[y * size + x] - 0.5;
        const sx2 = (x + Math.round(d * warp) + size * 4) % size;
        const sy2 = (y + Math.round(d * warp * 0.7) + size * 4) % size;
        out[y * size + x] = src[sy2 * size + sx2];
      }
    }
  }
  return out;
}

function fieldStats(f) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < f.length; i++) { if (f[i] < lo) lo = f[i]; if (f[i] > hi) hi = f[i]; }
  return { lo, hi };
}
// Stretch a field to the full 0..1 range — noise sums are always centre-heavy.
function normalizeField(f) {
  const { lo, hi } = fieldStats(f);
  const k = hi > lo ? 1 / (hi - lo) : 1;
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) * k;
  return f;
}

function _makeTexture(canvas, { repeat = [1, 1], srgb = true, aniso = 16 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  return tex;
}
function _canvas(size) {
  const c = document.createElement('canvas');
  c.width = size[0]; c.height = size[1];
  return c;
}

function canvasTexture(size, draw, opts = {}) {
  const c = _canvas(size);
  draw(c.getContext('2d'), c.width, c.height);
  return _makeTexture(c, opts);
}

// ── Height field → tangent-space normal map ─────────────────────────────────
// Sobel with wrap-around so the normal map tiles as cleanly as the height did.
function normalMapFromField(field, size, strength, repeat) {
  const c = _canvas([size, size]);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const at = (x, y) => field[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -gx * strength, ny = -gy * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return _makeTexture(c, { repeat, srgb: false });
}

// ── Field → greyscale map (roughness / AO / masks; always linear) ───────────
function grayMapFromField(field, size, lo, hi, repeat) {
  const c = _canvas([size, size]);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < field.length; i++) {
    const v = (lo + (hi - lo) * field[i]) * 255;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return _makeTexture(c, { repeat, srgb: false });
}

// ── Field(s) → coloured albedo through a ramp ───────────────────────────────
// ramp(v, detail, x, y) returns [r, g, b] in 0..255.
function albedoFromField(field, size, ramp, repeat, detail) {
  const c = _canvas([size, size]);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const col = ramp(field[i], detail ? detail[i] : 0, x, y);
      d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2]; d[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return _makeTexture(c, { repeat });
}

// Blend helper for ramps
function _mix(a, b, t) { return a + (b - a) * (t < 0 ? 0 : t > 1 ? 1 : t); }

// ── Legacy speckle fill, still handy for small props ────────────────────────
function noiseFill(ctx, w, h, rng, base, jitter, count) {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < count; i++) {
    const x = rng() * w, y = rng() * h;
    const s = 1 + rng() * 3;
    const j = (rng() - 0.5) * 2 * jitter;
    ctx.fillStyle = `rgba(${j > 0 ? 255 : 0},${j > 0 ? 255 : 0},${j > 0 ? 255 : 0},${Math.abs(j)})`;
    ctx.fillRect(x, y, s, s);
  }
}

function makeTextures() {
  const rng = mulberry32(1234);
  const T = {};
  const S = 512;

  // ════════════════════ GROUND LAYER 1 — grass/meadow ════════════════════
  {
    const macro = normalizeField(fbmField(S, 3, 4, 11, { gain: 0.55 }));   // clumps and patches
    const fine  = normalizeField(fbmField(S, 24, 4, 12, { gain: 0.5 }));   // blade-scale break-up
    const dry   = normalizeField(fbmField(S, 5, 3, 13, { gain: 0.5 }));    // sun-bleached areas
    const clov  = normalizeField(fbmField(S, 7, 3, 14, { gain: 0.5 }));    // darker clover drifts
    const bloom = normalizeField(fbmField(S, 4, 2, 15, { gain: 0.5 }));    // where the wildflowers are
    T.grass = albedoFromField(macro, S, (m, f, x, y) => {
      const t = m * 0.65 + f * 0.35;
      let r = _mix(40, 92, t), g = _mix(68, 128, t), b = _mix(24, 44, t);
      const c = clov[y * S + x];
      const k = c * c;                                   // clover: darker, bluer, glossier green
      r = _mix(r, 34, k * 0.5); g = _mix(g, 96, k * 0.5); b = _mix(b, 40, k * 0.5);
      return [r, g, b];
    }, [26, 26], fine);
    // second pass: fold the dryness field in, plus fine blade streaks and flowers
    {
      const ctx = T.grass.image.getContext('2d');
      const img = ctx.getImageData(0, 0, S, S);
      const d = img.data;
      for (let i = 0; i < S * S; i++) {
        const k = dry[i] * dry[i] * dry[i];              // cubed: sun-bleached patches stay rare
        d[i * 4]     = _mix(d[i * 4],     _mix(d[i * 4], 152, 0.55), k);
        d[i * 4 + 1] = _mix(d[i * 4 + 1], _mix(d[i * 4 + 1], 140, 0.55), k);
        d[i * 4 + 2] = _mix(d[i * 4 + 2], _mix(d[i * 4 + 2], 70, 0.55), k);
      }
      ctx.putImageData(img, 0, 0);
      ctx.globalAlpha = 0.5;
      for (let i = 0; i < 6000; i++) {
        const x = rng() * S, y = rng() * S, g = 88 + rng() * 76;
        ctx.strokeStyle = `rgba(${g * 0.5},${g},${g * 0.32},0.5)`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y);
        ctx.lineTo(x + (rng() - 0.5) * 5, y - 3 - rng() * 6); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // wildflowers: tiny heads clustered where the bloom field is high, so
      // they come in drifts rather than an even sprinkle
      const petals = ['#f6f1e2', '#f7e26b', '#e8a4c8', '#b9a0e6', '#ffffff'];
      for (let i = 0; i < 1800; i++) {
        const x = rng() * S, y = rng() * S;
        const bl = bloom[(y | 0) * S + (x | 0)];
        if (rng() > bl * bl * bl * 1.4) continue;
        ctx.fillStyle = petals[Math.floor(rng() * petals.length)];
        ctx.globalAlpha = 0.5 + rng() * 0.4;
        ctx.beginPath(); ctx.arc(x, y, 0.7 + rng() * 0.9, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
      T.grass.needsUpdate = true;
    }
    // grass normals are gentle — strong ones look like crumpled foil at distance
    const bump = new Float32Array(S * S);
    for (let i = 0; i < bump.length; i++) bump[i] = macro[i] * 0.55 + fine[i] * 0.45;
    T.grassN = normalMapFromField(bump, S, 0.9, [26, 26]);
    const rough = new Float32Array(S * S);
    for (let i = 0; i < rough.length; i++) rough[i] = macro[i] * (1 - clov[i] * clov[i] * 0.5);
    T.grassR = grayMapFromField(rough, S, 0.99, 0.78, [26, 26]);
  }

  // ════════════════════ GROUND LAYER 2 — rock/scree ════════════════════
  {
    const strata = normalizeField(fbmField(S, 4, 5, 21, { gain: 0.55, ridged: true, warp: 26 }));
    const grit   = normalizeField(fbmField(S, 40, 3, 22, { gain: 0.5 }));
    const moss   = normalizeField(fbmField(S, 6, 4, 23, { gain: 0.5 }));    // lichen + moss colonies
    const vein   = normalizeField(fbmField(S, 9, 3, 24, { gain: 0.5, ridged: true, warp: 40 }));
    T.rock = albedoFromField(strata, S, (v, g, x, y) => {
      const t = v * 0.75 + g * 0.25;
      // cool grey stone with warm iron staining in the crevices
      const warm = Math.pow(1 - v, 2.2);
      let r = _mix(58, 126, t) + warm * 22, gg = _mix(57, 120, t) + warm * 9, b = _mix(55, 112, t) - warm * 4;
      const i = y * S + x;
      const q = vein[i];                                 // pale quartz veins
      if (q > 0.86) { const k = (q - 0.86) / 0.14; r = _mix(r, 190, k); gg = _mix(gg, 186, k); b = _mix(b, 178, k); }
      // moss grows in the hollows (low strata) where the moss field says so
      const m = Math.pow(moss[i], 2.5) * (1 - v) * 1.6;
      if (m > 0) { const k = Math.min(1, m); r = _mix(r, 74, k); gg = _mix(gg, 108, k); b = _mix(b, 42, k); }
      // pale lichen rosettes on the exposed faces
      const l = Math.pow(1 - moss[i], 6) * v;
      if (l > 0.25) { const k = Math.min(1, (l - 0.25) * 2.5); r = _mix(r, 176, k); gg = _mix(gg, 184, k); b = _mix(b, 150, k); }
      return [r, gg, b];
    }, [16, 16], grit);
    const bump = new Float32Array(S * S);
    for (let i = 0; i < bump.length; i++) bump[i] = strata[i] * 0.8 + grit[i] * 0.2;
    T.rockN = normalMapFromField(bump, S, 5.5, [16, 16]);
    const rough = new Float32Array(S * S);
    for (let i = 0; i < rough.length; i++) rough[i] = strata[i] * 0.7 + Math.pow(moss[i], 2.5) * 0.3;
    T.rockR = grayMapFromField(rough, S, 0.94, 0.62, [16, 16]);
  }

  // ════════════════════ GROUND LAYER 3 — sand / river shingle ════════════
  {
    const dunes = normalizeField(fbmField(S, 6, 4, 31, { gain: 0.5 }));
    const grain = normalizeField(fbmField(S, 64, 3, 32, { gain: 0.5 }));
    T.sand = albedoFromField(dunes, S, (v, g) => {
      const t = v * 0.6 + g * 0.4;
      return [_mix(132, 186, t), _mix(114, 166, t), _mix(84, 126, t)];
    }, [14, 14], grain);
    {   // scattered pebbles and damp patches near the waterline
      const ctx = T.sand.image.getContext('2d');
      for (let i = 0; i < 260; i++) {
        ctx.fillStyle = rng() < 0.5 ? 'rgba(112,98,76,0.42)' : 'rgba(238,230,206,0.4)';
        ctx.beginPath(); ctx.arc(rng() * S, rng() * S, 1 + rng() * 2.6, 0, 7); ctx.fill();
      }
      T.sand.needsUpdate = true;
    }
    const bump = new Float32Array(S * S);
    for (let i = 0; i < bump.length; i++) bump[i] = dunes[i] * 0.35 + grain[i] * 0.65;
    T.sandN = normalMapFromField(bump, S, 1.6, [14, 14]);
    T.sandR = grayMapFromField(grain, S, 1.0, 0.86, [14, 14]);
  }

  // ════════════════════ Asphalt ════════════════════
  {
    const patch = normalizeField(fbmField(S, 4, 4, 41, { gain: 0.55 }));
    const agg   = normalizeField(fbmField(S, 90, 2, 42, { gain: 0.5 }));   // aggregate grain
    T.asphalt = albedoFromField(patch, S, (v, a) => {
      const t = v * 0.4 + a * 0.6;
      const base = _mix(44, 86, t);
      return [base, base * 1.01, base * 1.07];
    }, [2, 90], agg);
    {   // repair scars and tyre polish down the wheel tracks
      const ctx = T.asphalt.image.getContext('2d');
      ctx.strokeStyle = 'rgba(24,26,30,0.30)';
      for (let i = 0; i < 26; i++) {
        ctx.lineWidth = 1 + rng() * 4;
        ctx.beginPath();
        let x = rng() * S, y = rng() * S;
        ctx.moveTo(x, y);
        for (let k = 0; k < 5; k++) { x += (rng() - 0.5) * 90; y += (rng() - 0.3) * 90; ctx.lineTo(x, y); }
        ctx.stroke();
      }
      for (const cx of [S * 0.28, S * 0.72]) {
        const g = ctx.createLinearGradient(cx - S * 0.09, 0, cx + S * 0.09, 0);
        g.addColorStop(0, 'rgba(150,150,155,0)');
        g.addColorStop(0.5, 'rgba(150,150,155,0.10)');
        g.addColorStop(1, 'rgba(150,150,155,0)');
        ctx.fillStyle = g;
        ctx.fillRect(cx - S * 0.09, 0, S * 0.18, S);
      }
      T.asphalt.needsUpdate = true;
    }
    T.asphaltN = normalMapFromField(agg, S, 0.3, [2, 90]);
    T.asphaltR = grayMapFromField(patch, S, 0.94, 0.74, [2, 90]);
  }

  // ════════════════════ Gravel shoulder / footpath ════════════════════
  {
    const stones = normalizeField(fbmField(S, 34, 3, 51, { gain: 0.45 }));
    const dustF  = normalizeField(fbmField(S, 5, 3, 52, { gain: 0.5 }));
    T.dirt = albedoFromField(dustF, S, (v, s) => {
      const t = v * 0.45 + s * 0.55;
      return [_mix(94, 158, t), _mix(80, 136, t), _mix(62, 106, t)];
    }, [22, 22], stones);
    T.dirtN = normalMapFromField(stones, S, 2.6, [22, 22]);
    T.dirtR = grayMapFromField(stones, S, 1.0, 0.85, [22, 22]);
    T.gravel = T.dirt; T.gravelN = T.dirtN;
  }

  // ════════════════════ Concrete / paving — flagstones ════════════════════
  // Real pavers: a running bond of stones with varying widths and course
  // heights, each with its own tone, a bevelled edge, and a dark joint. The
  // albedo, normal and roughness are all derived from ONE height field so the
  // bevels catch light exactly where the joint lines are drawn.
  {
    const blot = normalizeField(fbmField(S, 6, 4, 61, { gain: 0.5 }));
    const pore = normalizeField(fbmField(S, 70, 2, 62, { gain: 0.5 }));
    const stain = normalizeField(fbmField(S, 3, 3, 63, { gain: 0.6 }));
    const height = new Float32Array(S * S).fill(0);
    const stoneId = new Int32Array(S * S).fill(-1);
    const tones = [];
    const prng = mulberry32(6161);
    const JOINT = 3, BEVEL = 5;
    // courses: heights 40..72 px, filling the 512 exactly (last course absorbs)
    let y = 0, course = 0, id = 0;
    const rowsY = [];
    while (y < S) { const h = 40 + Math.floor(prng() * 32); rowsY.push([y, Math.min(S, y + h)]); y += h; course++; }
    rowsY[rowsY.length - 1][1] = S;
    for (const [y0, y1] of rowsY) {
      let x = Math.floor(prng() * 40);
      const startX = x;
      const stones = [];
      while (x < S + startX) { const w = 48 + Math.floor(prng() * 70); stones.push([x, Math.min(S + startX, x + w)]); x += w; }
      for (const [x0, x1] of stones) {
        const tone = 0.86 + prng() * 0.2, hue = prng();
        tones.push([tone, hue]);
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const px = ((xx % S) + S) % S;
            const dEdge = Math.min(xx - x0, x1 - 1 - xx, yy - y0, y1 - 1 - yy);
            const i = yy * S + px;
            if (dEdge < JOINT) { height[i] = 0; continue; }
            const t = Math.min(1, (dEdge - JOINT) / BEVEL);
            height[i] = (0.55 + 0.45 * (t * t * (3 - 2 * t))) * (0.9 + 0.1 * tone);
            stoneId[i] = id;
          }
        }
        id++;
      }
    }
    T.plaza = albedoFromField(blot, S, (v, p, x, y) => {
      const i = y * S + x;
      const t = v * 0.55 + p * 0.45;
      const sid = stoneId[i];
      if (sid < 0) return [58 - p * 14, 55 - p * 12, 50 - p * 10];      // joint: dark, gritty
      const [tone, hue] = tones[sid];
      let g = _mix(118, 168, t) * tone;
      // sandstone → limestone → blue-grey: three quarry tones across the pavers
      let r = g * (hue < 0.33 ? 1.04 : hue < 0.66 ? 1.0 : 0.97);
      let bl = g * (hue < 0.33 ? 0.88 : hue < 0.66 ? 0.93 : 0.99);
      // bevel: the rounded edge reads lighter on top
      const h = height[i];
      const k = 0.82 + 0.28 * h;
      r *= k; g *= k; bl *= k;
      // weathering stains and damp, very low frequency
      const s = Math.pow(stain[i], 3) * 0.35;
      return [r * (1 - s), g * (1 - s * 0.9), bl * (1 - s * 0.7)];
    }, [7, 7], pore);
    {   // hairline cracks and a few chipped corners
      const ctx = T.plaza.image.getContext('2d');
      ctx.strokeStyle = 'rgba(40,36,32,0.55)';
      for (let i = 0; i < 18; i++) {
        ctx.lineWidth = 0.8 + rng() * 1.2;
        ctx.beginPath();
        let x = rng() * S, y = rng() * S;
        ctx.moveTo(x, y);
        for (let k = 0; k < 6; k++) { x += (rng() - 0.5) * 26; y += (rng() - 0.5) * 26; ctx.lineTo(x, y); }
        ctx.stroke();
      }
      T.plaza.needsUpdate = true;
    }
    T.concrete = T.plaza;
    const bump = new Float32Array(S * S);
    for (let i = 0; i < bump.length; i++) bump[i] = height[i] * 0.8 + pore[i] * 0.08 + blot[i] * 0.12;
    T.plazaN = normalMapFromField(bump, S, 2.4, [7, 7]);
    T.concreteN = T.plazaN;
    const rough = new Float32Array(S * S);
    for (let i = 0; i < rough.length; i++) rough[i] = stoneId[i] < 0 ? 1 : 0.35 + blot[i] * 0.45;
    T.plazaR = grayMapFromField(rough, S, 0.55, 1.0, [7, 7]);
    T.concreteR = T.plazaR;
  }

  // ════════════════════ Water ════════════════════
  // Two ripple normal maps at different scales, scrolled against each other in
  // world.js's water shader — that cross-beat is what makes a flat plane read
  // as a moving surface.
  {
    const makeRipple = (cells, seed, strength, size) => {
      // aspect 2.4: ripple crests run across the flow, as wind chop does
      const f = normalizeField(fbmField(size, cells, 4, seed, { gain: 0.55, warp: 12, aspect: 2.4 }));
      return normalMapFromField(f, size, strength, [1, 1]);
    };
    T.waterN1 = makeRipple(7, 71, 3.2, 256);
    T.waterN2 = makeRipple(17, 72, 2.0, 256);
    // legacy flat water albedo, still used as a fallback tint
    T.water = canvasTexture([128, 128], (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#2c5f70'); g.addColorStop(1, '#1d4553');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }, { repeat: [1, 1] });
    T.foam = canvasTexture([128, 128], (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < 300; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.06 + rng() * 0.2})`;
        ctx.beginPath(); ctx.ellipse(rng() * w, rng() * h, 2 + rng() * 9, 1 + rng() * 3, rng() * 3, 0, 7); ctx.fill();
      }
    });
  }

  // ════════════════════ Hull plating ════════════════════
  {
    const wear = normalizeField(fbmField(S, 8, 4, 81, { gain: 0.5 }));
    T.hull = albedoFromField(wear, S, (v) => {
      const g = _mix(150, 196, v);
      return [g, g * 1.01, g * 1.05];
    }, [180, 3]);
    {
      const ctx = T.hull.image.getContext('2d');
      ctx.strokeStyle = 'rgba(78,84,94,0.55)'; ctx.lineWidth = 4;
      for (let i = 0; i <= 4; i++) {
        ctx.beginPath(); ctx.moveTo(i * S / 4, 0); ctx.lineTo(i * S / 4, S); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i * S / 4); ctx.lineTo(S, i * S / 4); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(64,70,80,0.5)';
      for (let i = 0; i < 420; i++) {           // rivet lines along the seams
        const seam = Math.floor(rng() * 5) * S / 4;
        const along = rng() * S;
        const vert = rng() < 0.5;
        ctx.beginPath();
        ctx.arc(vert ? seam + (rng() < 0.5 ? -7 : 7) : along, vert ? along : seam + (rng() < 0.5 ? -7 : 7), 1.7, 0, 7);
        ctx.fill();
      }
      T.hull.needsUpdate = true;
    }
    T.hullN = normalMapFromField(wear, S, 1.0, [180, 3]);
    T.hullR = grayMapFromField(wear, S, 0.28, 0.62, [180, 3]);
  }

  // ════════════════════ Detail overlay ════════════════════
  // High-frequency grey noise multiplied over the terrain in the splat shader
  // to break the macro tiling that any repeated ground texture shows.
  {
    const f = normalizeField(fbmField(256, 12, 4, 91, { gain: 0.5 }));
    T.detail = grayMapFromField(f, 256, 0.72, 1.28, [1, 1]);
  }

  // huge soft blotches, laid over the floor at very low frequency
  T.mottle = canvasTexture([256, 256], (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      const warm = rng() < 0.4;
      const g = 90 + rng() * 60;
      ctx.fillStyle = warm
        ? `rgba(${g * 1.05},${g},${g * 0.35},${0.05 + rng() * 0.09})`
        : `rgba(${g * 0.4},${g * 0.8},${g * 0.3},${0.06 + rng() * 0.10})`;
      ctx.beginPath();
      ctx.ellipse(rng() * w, rng() * h, 25 + rng() * 70, 18 + rng() * 50, rng() * 3, 0, 7);
      ctx.fill();
    }
  });

  // ════════════════════ House walls ════════════════════
  // Three claddings — warm stucco, painted clapboard, brick — each built from
  // one HEIGHT FIELD that the albedo, the normal map and the roughness map all
  // read, so the windows are actually recessed, the sills throw a highlight
  // and the board laps step in the light. The window grid is deterministic so
  // the lit-window emissive maps line up with it.
  const WALL_W = 512, WALL_H = 256;
  const winGrid = () => {
    const cells = [];
    const rows = 2, cols = 4;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const door = r === rows - 1 && c === 1;
        const x = c * WALL_W / cols + WALL_W * 0.05, y = r * WALL_H / rows + WALL_H * 0.12;
        cells.push(door
          ? { door: true, x: c * WALL_W / cols + WALL_W * 0.06, y: WALL_H * 0.55, w: WALL_W * 0.13, h: WALL_H * 0.45 }
          : { door: false, x, y, w: WALL_W * 0.15, h: WALL_H * 0.28 });
      }
    }
    return cells;
  };
  const WIN_CELLS = winGrid();
  function wallSet({ base, trim, style, seed }) {
    const W = WALL_W, H = WALL_H;
    const relief = normalizeField(fbmField(256, 18, 3, seed, { gain: 0.5 }));
    const grime  = normalizeField(fbmField(256, 4, 3, seed + 7, { gain: 0.55 }));
    const height = new Float32Array(W * H);
    const kind = new Uint8Array(W * H);          // 0 wall 1 frame 2 glass 3 sill 4 door
    const rel = (x, y) => relief[((y & 255) * 256) + (x & 255)];
    // wall body
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let h = 0.5 + (rel(x, y) - 0.5) * 0.10;
        if (style === 'board') {
          // horizontal laps every 14 px: a step up then a slow fall
          const f = (y % 14) / 14;
          h += 0.10 - f * 0.14 + (f < 0.12 ? -0.08 : 0);
        } else if (style === 'brick') {
          const course = Math.floor(y / 9), fy = y % 9;
          const off = (course & 1) ? 12 : 0;
          const fx = (x + off) % 24;
          const mortar = fy < 2 || fx < 2;
          h = mortar ? 0.34 + rel(x, y) * 0.04 : 0.5 + (rel(x * 3, y * 3) - 0.5) * 0.12
            + 0.03 * Math.sin((fx / 24) * Math.PI) ;
        }
        height[y * W + x] = h;
      }
    }
    // windows / door carved in
    for (const c of WIN_CELLS) {
      const x0 = Math.round(c.x), y0 = Math.round(c.y), x1 = Math.round(c.x + c.w), y1 = Math.round(c.y + c.h);
      for (let y = y0 - 5; y < y1 + 8; y++) {
        for (let x = x0 - 5; x < x1 + 5; x++) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const i = y * W + x;
          const inFrame = x >= x0 - 5 && x < x1 + 5 && y >= y0 - 5 && y < y1 + 5;
          const inGlass = x >= x0 && x < x1 && y >= y0 && y < y1;
          if (c.door) {
            if (inGlass) { height[i] = 0.40; kind[i] = 4; }
            else if (inFrame) { height[i] = 0.62; kind[i] = 1; }
            continue;
          }
          if (y >= y1 + 5 && x >= x0 - 6 && x < x1 + 6) { height[i] = 0.68; kind[i] = 3; continue; }   // sill
          if (inGlass) {
            // recessed glazing with a mullion cross standing proud of it
            const mx = Math.abs(x - (x0 + x1) / 2) < 1.5, my = Math.abs(y - (y0 + y1) / 2) < 1.5;
            height[i] = mx || my ? 0.46 : 0.26;
            kind[i] = mx || my ? 1 : 2;
          } else if (inFrame) { height[i] = 0.60; kind[i] = 1; }
        }
      }
    }
    const [br, bg, bb] = base, [tr, tg, tb] = trim;
    const c = _canvas([W, H]);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(W, H);
    const d = img.data;
    const prng = mulberry32(seed);
    const brickTone = new Float32Array(64 * 64);
    for (let i = 0; i < brickTone.length; i++) brickTone[i] = prng();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, k = kind[i];
        const r0 = rel(x, y), g0 = grime[((y >> 1) & 255) * 256 + ((x >> 1) & 255)];
        let r, g, b;
        if (k === 2) {         // glass: sky gradient, slightly greenish
          const t = (y - 0) / H;
          r = _mix(176, 84, t); g = _mix(206, 112, t); b = _mix(224, 136, t);
        } else if (k === 1 || k === 3) {
          const l = k === 3 ? 1.12 : 0.98 + (r0 - 0.5) * 0.1;
          r = tr * l; g = tg * l; b = tb * l;
        } else if (k === 4) {
          r = 46 + r0 * 10; g = 40 + r0 * 8; b = 34 + r0 * 6;
          if (((y - 140) % 34) < 3) { r *= 0.7; g *= 0.7; b *= 0.7; }         // door panels
        } else if (style === 'brick') {
          const course = Math.floor(y / 9), off = (course & 1) ? 12 : 0;
          const bx = Math.floor((x + off) / 24), mortar = (y % 9) < 2 || ((x + off) % 24) < 2;
          if (mortar) { const l = 0.9 + r0 * 0.2; r = 168 * l; g = 160 * l; b = 148 * l; }
          else {
            const tn = brickTone[((course & 63) * 64) + (bx & 63)];
            const l = 0.8 + tn * 0.4, warm = tn < 0.25 ? 0.85 : tn > 0.85 ? 1.12 : 1;
            r = br * l * warm; g = bg * l; b = bb * l * (2 - warm);
            r *= 0.94 + r0 * 0.12; g *= 0.94 + r0 * 0.12; b *= 0.94 + r0 * 0.12;
          }
        } else {
          const l = 0.9 + r0 * 0.2 + (style === 'board' ? 0.08 - ((y % 14) / 14) * 0.16 : 0);
          r = br * l; g = bg * l; b = bb * l;
        }
        // grime: darker toward the bottom of the wall and in the low patches
        const dirt = (g0 * g0) * 0.35 * (0.4 + 0.6 * (y / H));
        r *= 1 - dirt; g *= 1 - dirt * 0.95; b *= 1 - dirt * 0.85;
        d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // drip streaks under every sill
    ctx.fillStyle = 'rgba(30,26,22,0.16)';
    for (const w of WIN_CELLS) {
      if (w.door) continue;
      for (let s = 0; s < 4; s++) {
        const x = w.x + 4 + prng() * (w.w - 8);
        ctx.fillRect(x, w.y + w.h + 8, 1.5, 10 + prng() * 30);
      }
    }
    const map = _makeTexture(c, { repeat: [1, 1] });
    // the normal map is built at the wall's own aspect ratio: a square Sobel
    // over a 2:1 image would double the slope in one axis
    const nc = _canvas([W, H]);
    const nctx = nc.getContext('2d');
    const nimg = nctx.createImageData(W, H);
    const nd = nimg.data;
    const at = (x, y) => height[(((y % H) + H) % H) * W + (((x % W) + W) % W)];
    const strength = 3.2;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
        const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
        let nx = -gx * strength, ny = -gy * strength, nz = 1;
        const inv = 1 / Math.hypot(nx, ny, nz);
        const i = (y * W + x) * 4;
        nd[i] = (nx * inv * 0.5 + 0.5) * 255; nd[i + 1] = (ny * inv * 0.5 + 0.5) * 255; nd[i + 2] = (nz * inv * 0.5 + 0.5) * 255; nd[i + 3] = 255;
      }
    }
    nctx.putImageData(nimg, 0, 0);
    const normal = _makeTexture(nc, { repeat: [1, 1], srgb: false });
    const rc = _canvas([W, H]);
    const rctx = rc.getContext('2d');
    const rimg = rctx.createImageData(W, H);
    const rd = rimg.data;
    for (let i = 0; i < W * H; i++) {
      const k = kind[i];
      const v = (k === 2 ? 0.12 : k === 1 || k === 3 ? 0.55 : k === 4 ? 0.7 : style === 'brick' ? 0.92 : 0.86) * 255;
      rd[i * 4] = rd[i * 4 + 1] = rd[i * 4 + 2] = v; rd[i * 4 + 3] = 255;
    }
    rctx.putImageData(rimg, 0, 0);
    const rough = _makeTexture(rc, { repeat: [1, 1], srgb: false });
    // lit windows, same grid
    const emissive = canvasTexture([W, H], (ectx, w, h) => {
      ectx.fillStyle = '#000'; ectx.fillRect(0, 0, w, h);
      for (const cell of WIN_CELLS) {
        if (cell.door || rng() > 0.42) continue;
        ectx.fillStyle = rng() < 0.8 ? '#ffd9a0' : '#d7e8f2';
        ectx.fillRect(cell.x, cell.y, cell.w, cell.h);
        // curtain: half the lit windows show a soft darker band
        if (rng() < 0.5) { ectx.fillStyle = 'rgba(0,0,0,0.35)'; ectx.fillRect(cell.x, cell.y, cell.w * 0.4, cell.h); }
      }
    });
    return { map, normal, rough, emissive };
  }
  {
    const A = wallSet({ base: [222, 208, 186], trim: [122, 104, 84], style: 'stucco', seed: 101 });
    const B = wallSet({ base: [190, 202, 210], trim: [62, 74, 86], style: 'board', seed: 102 });
    const C = wallSet({ base: [172, 92, 70], trim: [206, 196, 180], style: 'brick', seed: 103 });
    T.wallA = A.map; T.wallAN = A.normal; T.wallAR = A.rough; T.wallAE = A.emissive;
    T.wallB = B.map; T.wallBN = B.normal; T.wallBR = B.rough; T.wallBE = B.emissive;
    T.wallC = C.map; T.wallCN = C.normal; T.wallCR = C.rough; T.wallCE = C.emissive;
    T.wallN = A.normal;    // legacy shared relief
  }

  // mid-rise city blocks: window-grid facade + lit-window emissive pair
  function blockPair(floors, base, trim) {
    const litRects = [];
    const facade = normalizeField(fbmField(256, 6, 3, 121 + floors, { gain: 0.5 }));
    const map = canvasTexture([512, 512], (ctx, w, h) => {
      // concrete panel facade with a faint fbm wash instead of pixel static
      const img = ctx.createImageData(w, h);
      const d = img.data;
      const [br, bg, bb] = base;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = facade[((y >> 1) & 255) * 256 + ((x >> 1) & 255)];
        const l = 0.88 + v * 0.24, i = (y * w + x) * 4;
        d[i] = br * l; d[i + 1] = bg * l; d[i + 2] = bb * l; d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const cols = 7;
      const gY = h * 0.82;                 // storefront band below
      const floorH = gY / floors;
      const [tr, tg, tb] = trim;
      const trimCss = `rgb(${tr},${tg},${tb})`;
      for (let f = 0; f < floors; f++) {
        // spandrel band between floors reads as a real slab edge
        ctx.fillStyle = 'rgba(0,0,0,0.14)';
        ctx.fillRect(0, f * floorH, w, 4);
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(0, f * floorH + 4, w, 2);
        for (let c = 0; c < cols; c++) {
          const x = (c + 0.18) * (w / cols), y = f * floorH + floorH * 0.22;
          const ww = (w / cols) * 0.64, wh = floorH * 0.56;
          ctx.fillStyle = trimCss; ctx.fillRect(x - 3, y - 3, ww + 6, wh + 6);
          const sky = ctx.createLinearGradient(0, y, 0, y + wh);
          sky.addColorStop(0, '#9fb8cb'); sky.addColorStop(0.5, '#5f7a90'); sky.addColorStop(1, '#3a4c5e');
          ctx.fillStyle = sky; ctx.fillRect(x, y, ww, wh);
          // interior reflection: a soft diagonal sheen across the pane
          const sheen = ctx.createLinearGradient(x, y, x + ww, y + wh);
          sheen.addColorStop(0, 'rgba(255,255,255,0)'); sheen.addColorStop(0.45, 'rgba(255,255,255,0.14)'); sheen.addColorStop(0.55, 'rgba(255,255,255,0)');
          ctx.fillStyle = sheen; ctx.fillRect(x, y, ww, wh);
          ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(x, y, ww, 3);
          ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(x, y, 2, wh);
          if (rng() < 0.4) litRects.push([x, y, ww, wh, false]);
        }
      }
      ctx.fillStyle = trimCss; ctx.fillRect(0, gY, w, h - gY);
      ctx.fillStyle = '#1d2833';
      ctx.fillRect(w * 0.04, gY + 8, w * 0.92, h - gY - 20);
      // shopfront mullions
      ctx.fillStyle = trimCss;
      for (let k = 1; k < 6; k++) ctx.fillRect(w * 0.04 + k * (w * 0.92 / 6) - 2, gY + 8, 4, h - gY - 20);
      litRects.push([w * 0.04, gY + 8, w * 0.92, h - gY - 20, true]);
    });
    const emissive = canvasTexture([512, 512], (ctx, w, h) => {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
      for (const [x, y, ww, wh, store] of litRects) {
        ctx.fillStyle = store ? 'rgba(150,180,200,0.5)' : (rng() < 0.8 ? '#ffd9a0' : '#cfe4f0');
        ctx.fillRect(x, y, ww, wh);
      }
    });
    return { map, emissive };
  }
  T.blockA = blockPair(4, [185, 178, 166], [74, 85, 96]);
  T.blockB = blockPair(6, [159, 168, 178], [57, 66, 76]);
  T.blockC = blockPair(3, [196, 180, 158], [90, 74, 58]);

  // ════════════════════ Roofs ════════════════════
  // Pantiles: an S-profile across each tile plus the lap step down every
  // course, as one height field; the albedo reads it (light on the crown,
  // shadow under the lap) and so does the normal map, so the courses actually
  // catch the sun. Slates: staggered rectangles with a chipped edge and a
  // per-slate tone.
  {
    const R = 256, TW = 32, CH = 16;
    const grain = normalizeField(fbmField(R, 24, 3, 131, { gain: 0.5 }));
    const weath = normalizeField(fbmField(R, 3, 3, 132, { gain: 0.6 }));
    const height = new Float32Array(R * R);
    const tileTone = new Float32Array(R * R);
    const prng = mulberry32(777);
    const tones = new Float32Array(64 * 64);
    for (let i = 0; i < tones.length; i++) tones[i] = prng();
    for (let y = 0; y < R; y++) {
      const course = Math.floor(y / CH), fy = (y % CH) / CH;
      const off = (course & 1) ? TW / 2 : 0;
      for (let x = 0; x < R; x++) {
        const fx = (((x + off) % TW) + TW) % TW / TW;
        const tile = Math.floor((x + off) / TW);
        const s = 0.5 + 0.5 * Math.sin(fx * Math.PI * 2 - Math.PI / 2);   // the S: crown at fx=0.5
        // lap: each course sits on the one below, so height falls down the course
        const lap = 0.85 - fy * 0.5 + (fy < 0.1 ? -0.3 : 0);
        const i = y * R + x;
        height[i] = s * 0.55 + lap * 0.45 + (grain[i] - 0.5) * 0.06;
        tileTone[i] = tones[((course & 63) * 64) + (tile & 63)];
      }
    }
    const roofC = _canvas([R, R]);
    const rctx = roofC.getContext('2d');
    const img = rctx.createImageData(R, R);
    const d = img.data;
    for (let i = 0; i < R * R; i++) {
      const y = Math.floor(i / R);
      const fy = (y % CH) / CH;
      const tn = tileTone[i], h = height[i];
      let r = 160 + tn * 40, g = 84 + tn * 26, b = 60 + tn * 16;
      const l = 0.7 + h * 0.5 - (fy < 0.12 ? 0.25 : 0);     // shadow line under each lap
      r *= l; g *= l; b *= l;
      const w = Math.pow(weath[i], 2) * 0.5;                  // moss / weathering, greyer
      r = _mix(r, 96, w); g = _mix(g, 104, w); b = _mix(b, 78, w);
      d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
    }
    rctx.putImageData(img, 0, 0);
    T.roof = _makeTexture(roofC, { repeat: [2, 2] });
    T.roofN = normalMapFromField(height, R, 2.6, [2, 2]);
    T.roofR = grayMapFromField(weath, R, 0.7, 0.95, [2, 2]);

    // slate
    const SH = 14, SW = 22;
    const sh = new Float32Array(R * R);
    const stone = new Float32Array(R * R);
    for (let y = 0; y < R; y++) {
      const course = Math.floor(y / SH), fy = y % SH;
      const off = (course & 1) ? SW / 2 : 0;
      for (let x = 0; x < R; x++) {
        const fx = (((x + off) % SW) + SW) % SW;
        const slate = Math.floor((x + off) / SW);
        const tn = tones[((course * 7 + 3) & 63) * 64 + ((slate * 5 + 1) & 63)];
        const i = y * R + x;
        const edge = fx < 1.5 || fy < 1.5;
        sh[i] = edge ? 0.3 : 0.6 + tn * 0.12 - fy / SH * 0.2 + (grain[i] - 0.5) * 0.05;
        stone[i] = edge ? -1 : tn;
      }
    }
    const slateC = _canvas([R, R]);
    const sctx = slateC.getContext('2d');
    const simg = sctx.createImageData(R, R);
    const sd = simg.data;
    for (let i = 0; i < R * R; i++) {
      const tn = stone[i];
      let r, g, b;
      if (tn < 0) { r = 22; g = 24; b = 28; }
      else {
        const l = 0.75 + tn * 0.5 + (sh[i] - 0.6) * 0.6;
        // blue-grey slate with the odd purple or green stone
        const hueShift = tn > 0.9 ? [1.08, 0.94, 1.1] : tn < 0.1 ? [0.92, 1.04, 0.95] : [1, 1, 1];
        r = 74 * l * hueShift[0]; g = 80 * l * hueShift[1]; b = 90 * l * hueShift[2];
      }
      sd[i * 4] = r; sd[i * 4 + 1] = g; sd[i * 4 + 2] = b; sd[i * 4 + 3] = 255;
    }
    sctx.putImageData(simg, 0, 0);
    T.roofSlate = _makeTexture(slateC, { repeat: [2, 2] });
    T.roofSlateN = normalMapFromField(sh, R, 2.2, [2, 2]);
    T.roofSlateR = grayMapFromField(grain, R, 0.45, 0.7, [2, 2]);
  }

  // ════════════════════ Bark ════════════════════
  // Ridged noise stretched along the trunk gives real furrows; the normal map
  // from the same field is what makes a tree trunk stop looking like a tube.
  {
    const B = 256;
    const furrow = normalizeField(fbmField(B, 10, 4, 141, { gain: 0.55, ridged: true, aspect: 0.22 }));
    const flake  = normalizeField(fbmField(B, 30, 2, 142, { gain: 0.5, aspect: 0.5 }));
    T.bark = albedoFromField(furrow, B, (v, f) => {
      const t = v * 0.7 + f * 0.3;
      const deep = Math.pow(1 - v, 2);            // dark in the cracks
      return [_mix(38, 118, t) - deep * 8, _mix(28, 92, t) - deep * 8, _mix(20, 66, t) - deep * 6];
    }, [1, 2], flake);
    {   // moss on the north side: a green cast over one band of the trunk
      const ctx = T.bark.image.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, B, 0);
      g.addColorStop(0, 'rgba(70,110,40,0)'); g.addColorStop(0.25, 'rgba(70,110,40,0.35)');
      g.addColorStop(0.5, 'rgba(70,110,40,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, B, B);
      T.bark.needsUpdate = true;
    }
    const bump = new Float32Array(B * B);
    for (let i = 0; i < bump.length; i++) bump[i] = furrow[i] * 0.85 + flake[i] * 0.15;
    T.barkN = normalMapFromField(bump, B, 3.4, [1, 2]);
  }

  // ════════════════════ Painted steel / industrial panels ════════════════════
  // For the engineering set-pieces: a panelled, riveted, scuffed painted-steel
  // skin, a hazard-striped variant, and a floor grating. All three share one
  // relief so seams, rivets and scratches show in the normal map.
  {
    const M = 512;
    const scuff = normalizeField(fbmField(M, 6, 4, 151, { gain: 0.55 }));
    const micro = normalizeField(fbmField(M, 80, 2, 152, { gain: 0.5 }));
    const rustF = normalizeField(fbmField(M, 5, 4, 153, { gain: 0.6, warp: 30 }));
    const height = new Float32Array(M * M).fill(0.5);
    const seamMask = new Uint8Array(M * M);
    const PANEL = 128;
    for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      const i = y * M + x;
      const sx = x % PANEL, sy = y % PANEL;
      const dEdge = Math.min(sx, PANEL - 1 - sx, sy, PANEL - 1 - sy);
      if (dEdge < 2) { height[i] = 0.30; seamMask[i] = 1; }
      else if (dEdge < 5) height[i] = 0.42 + (dEdge - 2) * 0.03;
      else height[i] = 0.5 + (micro[i] - 0.5) * 0.02;
      // rivets: a row 8 px inside every seam, one every 32 px
      const inX = sx < 16 ? 8 : sx >= PANEL - 16 ? PANEL - 9 : -1;
      const inY = sy < 16 ? 8 : sy >= PANEL - 16 ? PANEL - 9 : -1;
      let rr = 99;
      if (inX >= 0) rr = Math.min(rr, Math.hypot(sx - inX, ((sy + 16) % 32) - 16));
      if (inY >= 0) rr = Math.min(rr, Math.hypot(((sx + 16) % 32) - 16, sy - inY));
      if (rr < 3.2) { height[i] = 0.5 + Math.sqrt(Math.max(0, 1 - (rr / 3.2) ** 2)) * 0.18; seamMask[i] = 2; }
    }
    // scratches: thin bright grooves
    const prng = mulberry32(9090);
    const scratches = [];
    for (let s = 0; s < 70; s++) scratches.push([prng() * M, prng() * M, prng() * Math.PI * 2, 20 + prng() * 120]);
    const scratchMask = new Float32Array(M * M);
    for (const [x0, y0, ang, len] of scratches) {
      const dx = Math.cos(ang), dy = Math.sin(ang);
      for (let t = 0; t < len; t += 0.5) {
        const x = Math.round(x0 + dx * t), y = Math.round(y0 + dy * t);
        const i = (((y % M) + M) % M) * M + (((x % M) + M) % M);
        scratchMask[i] = 1; height[i] -= 0.05;
      }
    }
    const paint = (r, g, b, stripes) => {
      const c = _canvas([M, M]);
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(M, M);
      const d = img.data;
      for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
        const i = y * M + x;
        let cr = r, cg = g, cb = b;
        if (stripes) {
          const band = Math.floor(((x + y) % 96) / 48);
          if (band === 0) { cr = 226; cg = 178; cb = 40; } else { cr = 38; cg = 38; cb = 40; }
        }
        const l = 0.86 + scuff[i] * 0.22 + (micro[i] - 0.5) * 0.08;
        cr *= l; cg *= l; cb *= l;
        if (seamMask[i] === 1) { cr *= 0.45; cg *= 0.45; cb *= 0.45; }
        if (seamMask[i] === 2) { const k = 0.92 + (height[i] - 0.5) * 1.4; cr = 150 * k; cg = 152 * k; cb = 156 * k; }
        // rust blooms out of the seams and the low corners
        const ru = Math.pow(rustF[i], 3.2) * (seamMask[i] === 1 ? 1.6 : 0.55 + 0.45 * (y / M));
        const k = Math.min(1, ru);
        cr = _mix(cr, 132, k); cg = _mix(cg, 66, k); cb = _mix(cb, 34, k);
        if (scratchMask[i]) { cr = _mix(cr, 190, 0.7); cg = _mix(cg, 192, 0.7); cb = _mix(cb, 196, 0.7); }
        d[i * 4] = cr; d[i * 4 + 1] = cg; d[i * 4 + 2] = cb; d[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return _makeTexture(c, { repeat: [1, 1] });
    };
    T.metal = paint(118, 130, 142, false);      // industrial blue-grey
    T.metalHazard = paint(0, 0, 0, true);
    T.metalN = normalMapFromField(height, M, 3.0, [1, 1]);
    const rough = new Float32Array(M * M);
    for (let i = 0; i < rough.length; i++) rough[i] = 0.35 + scuff[i] * 0.3 + Math.pow(rustF[i], 3.2) * 0.5 + (scratchMask[i] ? -0.2 : 0);
    T.metalR = grayMapFromField(rough, M, 0, 1, [1, 1]);

    // open steel grating (alpha) for walkways and the relay floor
    T.grate = canvasTexture([128, 128], (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#6a7078';
      for (let k = 0; k < w; k += 16) { ctx.fillRect(k, 0, 4, h); ctx.fillRect(0, k, 4, w); }
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      for (let k = 0; k < w; k += 16) { ctx.fillRect(k, 0, 1, h); ctx.fillRect(0, k, w, 1); }
    }, { repeat: [4, 4] });
  }

  T.crops = canvasTexture([256, 256], (ctx, w, h) => {
    noiseFill(ctx, w, h, rng, '#6b5a3a', 0.10, 2000);
    for (let x = 8; x < w; x += 24) {
      ctx.strokeStyle = 'rgba(70,110,40,0.9)'; ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.strokeStyle = 'rgba(110,160,60,0.7)'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  }, { repeat: [6, 40] });

  // Grass-blade tuft with alpha, for instanced cross-quads
  T.tuft = canvasTexture([128, 128], (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < 34; i++) {
      const x = w * 0.15 + rng() * w * 0.7;
      const g = 100 + rng() * 90;
      ctx.strokeStyle = `rgba(${g * 0.5},${g},${g * 0.3},0.95)`;
      ctx.lineWidth = 2 + rng() * 2;
      ctx.beginPath(); ctx.moveTo(x, h);
      ctx.quadraticCurveTo(x + (rng() - 0.5) * 26, h * 0.5, x + (rng() - 0.5) * 44, h * (0.02 + rng() * 0.35));
      ctx.stroke();
    }
  });

  // ════════════════════ Foliage cards ════════════════════
  // Canopies are spheres wrapped in an alpha-cut texture, so the texture is
  // what reads as "leaves". 512² of individual, overlapping leaf shapes —
  // each with a midrib, its own shade, and a fold across its width that the
  // normal map picks up — tiled seamlessly (every leaf near an edge is drawn
  // again on the far side). Colour stays near-neutral green: the per-tree
  // instance tint supplies the hue. Needles get the same treatment as twigs.
  function foliage(size, count, seed, drawOne, clusters = 0, clump = false) {
    const frng = mulberry32(seed);
    // Leaves grow on twigs, in clumps with sky between them. Placing them
    // around cluster centres (rather than uniformly) is what leaves the holes
    // a crown needs to stop reading as a clipped hedge.
    const cl = [];
    for (let i = 0; i < clusters; i++) cl.push([frng() * size, frng() * size, size * (0.035 + frng() * 0.05)]);
    const col = _canvas([size, size]), hgt = _canvas([size, size]);
    const cc = col.getContext('2d'), hc = hgt.getContext('2d');
    cc.clearRect(0, 0, size, size);
    hc.fillStyle = '#000'; hc.fillRect(0, 0, size, size);
    for (let i = 0; i < count; i++) {
      let x = frng() * size, y = frng() * size;
      if (cl.length && frng() < 0.9) {
        const c = cl[Math.floor(frng() * cl.length)];
        const a = frng() * Math.PI * 2, r = c[2] * Math.sqrt(frng());
        x = (c[0] + Math.cos(a) * r + size) % size; y = (c[1] + Math.sin(a) * r + size) % size;
      }
      let rot = frng() * Math.PI * 2;
      if (clump) {
        // one round clump of leaves on a card: dense core, ragged rim,
        // leaves pointing out from the twig they hang off
        const a = frng() * Math.PI * 2, r = size * 0.42 * Math.pow(frng(), 0.65);
        x = size / 2 + Math.cos(a) * r; y = size / 2 + Math.sin(a) * r;
        rot = a + (frng() - 0.5) * 1.6;
      }
      const layer = i / count;
      const params = drawOne.params(frng, layer);
      const R = params.reach;
      const wraps = clump ? [0] : [-size, 0, size];
      for (const ox of wraps) {
        for (const oy of wraps) {
          const px = x + ox, py = y + oy;
          if (px < -R || px > size + R || py < -R || py > size + R) continue;
          cc.setTransform(Math.cos(rot), Math.sin(rot), -Math.sin(rot), Math.cos(rot), px, py);
          hc.setTransform(Math.cos(rot), Math.sin(rot), -Math.sin(rot), Math.cos(rot), px, py);
          drawOne.draw(cc, hc, params, layer);
        }
      }
    }
    cc.setTransform(1, 0, 0, 1, 0, 0); hc.setTransform(1, 0, 0, 1, 0, 0);
    const hd = hc.getImageData(0, 0, size, size).data;
    const field = new Float32Array(size * size);
    for (let i = 0; i < field.length; i++) field[i] = hd[i * 4] / 255;
    return { map: _bledTexture(cc, size), normal: normalMapFromField(field, size, 2.2, [1, 1]) };
  }
  // Canvas stores premultiplied alpha, so every transparent texel uploads as
  // black — and filtering then drags a dark rim round every leaf. Rebuild the
  // map as a DataTexture whose transparent texels carry the colour of the
  // nearest leaf (a few dilation passes, then the mean for whatever is left).
  function _bledTexture(ctx, size) {
    const src = ctx.getImageData(0, 0, size, size).data;
    const out = new Uint8Array(src.length);
    out.set(src);
    let mr = 0, mg = 0, mb = 0, n = 0;
    for (let i = 0; i < src.length; i += 4) if (src[i + 3] > 200) { mr += src[i]; mg += src[i + 1]; mb += src[i + 2]; n++; }
    mr /= Math.max(1, n); mg /= Math.max(1, n); mb /= Math.max(1, n);
    let known = new Uint8Array(size * size);
    for (let i = 0; i < known.length; i++) known[i] = src[i * 4 + 3] > 8 ? 1 : 0;
    for (let pass = 0; pass < 6; pass++) {
      const next = known.slice();
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          if (known[i]) continue;
          let r = 0, g = 0, b = 0, c = 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const j = ((y + dy + size) % size) * size + ((x + dx + size) % size);
            if (known[j]) { r += out[j * 4]; g += out[j * 4 + 1]; b += out[j * 4 + 2]; c++; }
          }
          if (c) { out[i * 4] = r / c; out[i * 4 + 1] = g / c; out[i * 4 + 2] = b / c; next[i] = 1; }
        }
      }
      known = next;
    }
    for (let i = 0; i < known.length; i++) if (!known[i]) { out[i * 4] = mr; out[i * 4 + 1] = mg; out[i * 4 + 2] = mb; }
    // rows reversed: matches the flipY upload of the canvas-built normal map
    const flipped = new Uint8Array(out.length), row = size * 4;
    for (let y = 0; y < size; y++) flipped.set(out.subarray(y * row, (y + 1) * row), (size - 1 - y) * row);
    const tex = new THREE.DataTexture(flipped, size, size, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true; tex.anisotropy = 16;
    tex.needsUpdate = true;
    return tex;
  }
  const leafPath = (ctx, L, W) => {
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.bezierCurveTo(L * 0.25, -W, L * 0.7, -W * 0.9, L, 0);
    ctx.bezierCurveTo(L * 0.7, W * 0.9, L * 0.25, W, 0, 0);
    ctx.closePath();
  };
  {
    const leafDrawer = {
      params(r, layer) {
        const L = 13 + r() * 13, W = L * (0.26 + r() * 0.1);
        // deeper leaves darker; the outer shell catches light; a few turning
        const g = (0.42 + 0.58 * layer) * (0.8 + r() * 0.3);
        const yel = r() < 0.07 ? 0.5 + r() * 0.5 : 0;
        return { L, W, reach: L + 2, g, yel, rib: r() < 0.8 };
      },
      draw(cc, hc, p, layer) {
        const base = 210 * p.g;
        cc.fillStyle = `rgb(${Math.round(base * (0.5 + 0.35 * p.yel))},${Math.round(base)},${Math.round(base * (0.36 - 0.12 * p.yel))})`;
        leafPath(cc, p.L, p.W); cc.fill();
        // darker petiole end, lighter tip — leaves are never flat colour
        const gr = cc.createLinearGradient(0, 0, p.L, 0);
        gr.addColorStop(0, 'rgba(20,30,10,0.35)'); gr.addColorStop(0.5, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(255,255,220,0.12)');
        cc.fillStyle = gr; leafPath(cc, p.L, p.W); cc.fill();
        if (p.rib) {
          cc.strokeStyle = `rgba(230,240,190,${0.22 + 0.2 * layer})`; cc.lineWidth = 0.9;
          cc.beginPath(); cc.moveTo(1, 0); cc.lineTo(p.L * 0.92, 0); cc.stroke();
        }
        // height: raised midrib fold, rising with layer
        const hg = hc.createLinearGradient(0, -p.W, 0, p.W);
        const top = Math.round(60 + 190 * layer), edge = Math.round(20 + 150 * layer);
        hg.addColorStop(0, `rgb(${edge},${edge},${edge})`);
        hg.addColorStop(0.5, `rgb(${top},${top},${top})`);
        hg.addColorStop(1, `rgb(${edge},${edge},${edge})`);
        hc.fillStyle = hg; leafPath(hc, p.L, p.W); hc.fill();
      },
    };
    const F = foliage(512, 1250, 971, leafDrawer, 34);
    T.leaf = F.map; T.leafN = F.normal;
    const C = foliage(512, 900, 973, leafDrawer, 0, true);
    C.map.wrapS = C.map.wrapT = THREE.ClampToEdgeWrapping;
    C.normal.wrapS = C.normal.wrapT = THREE.ClampToEdgeWrapping;
    T.leafCard = C.map; T.leafCardN = C.normal;
  }
  {
    const F = foliage(512, 520, 972, {
      params(r, layer) {
        const L = 26 + r() * 22;
        return { L, reach: L + 8, g: (0.45 + 0.55 * layer) * (0.8 + r() * 0.3), n: 10 + Math.floor(r() * 8), bend: (r() - 0.5) * 0.3 };
      },
      draw(cc, hc, p, layer) {
        const base = 190 * p.g;
        const cs = `rgb(${Math.round(base * 0.45)},${Math.round(base)},${Math.round(base * 0.55)})`;
        const hv = Math.round(40 + 200 * layer);
        for (const [ctx, style] of [[cc, cs], [hc, `rgb(${hv},${hv},${hv})`]]) {
          ctx.strokeStyle = style; ctx.lineCap = 'round';
          ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(p.L * 0.5, p.bend * p.L, p.L, 0); ctx.stroke();
          ctx.lineWidth = 1.3;
          for (let k = 1; k <= p.n; k++) {
            const t = k / (p.n + 1), x = p.L * t, len = 7 * (1 - t * 0.5);
            for (const sgn of [-1, 1]) {
              ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + len * 0.55, sgn * len); ctx.stroke();
            }
          }
        }
      },
    }, 26);
    T.needle = F.map; T.needleN = F.normal;
  }

  return T;
}
