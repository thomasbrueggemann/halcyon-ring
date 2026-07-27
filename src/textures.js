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

function _makeTexture(canvas, { repeat = [1, 1], srgb = true, aniso = 8 } = {}) {
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
    T.grass = albedoFromField(macro, S, (m, f) => {
      const t = m * 0.65 + f * 0.35;
      return [_mix(42, 88, t), _mix(70, 124, t), _mix(26, 45, t)];
    }, [26, 26], fine);
    // second pass: fold the dryness field in, plus fine blade streaks
    {
      const ctx = T.grass.image.getContext('2d');
      const img = ctx.getImageData(0, 0, S, S);
      const d = img.data;
      for (let i = 0; i < S * S; i++) {
        const k = dry[i] * dry[i] * dry[i];              // cubed: sun-bleached patches stay rare
        d[i * 4]     = _mix(d[i * 4],     _mix(d[i * 4], 146, 0.5), k);
        d[i * 4 + 1] = _mix(d[i * 4 + 1], _mix(d[i * 4 + 1], 138, 0.5), k);
        d[i * 4 + 2] = _mix(d[i * 4 + 2], _mix(d[i * 4 + 2], 72, 0.5), k);
      }
      ctx.putImageData(img, 0, 0);
      ctx.globalAlpha = 0.5;
      for (let i = 0; i < 5200; i++) {
        const x = rng() * S, y = rng() * S, g = 88 + rng() * 76;
        ctx.strokeStyle = `rgba(${g * 0.5},${g},${g * 0.32},0.5)`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y);
        ctx.lineTo(x + (rng() - 0.5) * 5, y - 3 - rng() * 6); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      T.grass.needsUpdate = true;
    }
    // grass normals are gentle — strong ones look like crumpled foil at distance
    const bump = new Float32Array(S * S);
    for (let i = 0; i < bump.length; i++) bump[i] = macro[i] * 0.55 + fine[i] * 0.45;
    T.grassN = normalMapFromField(bump, S, 0.9, [26, 26]);
    T.grassR = grayMapFromField(macro, S, 0.98, 0.80, [26, 26]);
  }

  // ════════════════════ GROUND LAYER 2 — rock/scree ════════════════════
  {
    const strata = normalizeField(fbmField(S, 4, 5, 21, { gain: 0.55, ridged: true, warp: 26 }));
    const grit   = normalizeField(fbmField(S, 40, 3, 22, { gain: 0.5 }));
    T.rock = albedoFromField(strata, S, (v, g) => {
      const t = v * 0.75 + g * 0.25;
      // cool grey stone with warm iron staining in the crevices
      const warm = Math.pow(1 - v, 2.2);
      return [
        _mix(58, 122, t) + warm * 20,
        _mix(57, 117, t) + warm * 9,
        _mix(55, 110, t) - warm * 4,
      ];
    }, [16, 16], grit);
    const bump = new Float32Array(S * S);
    for (let i = 0; i < bump.length; i++) bump[i] = strata[i] * 0.8 + grit[i] * 0.2;
    T.rockN = normalMapFromField(bump, S, 5.5, [16, 16]);
    T.rockR = grayMapFromField(strata, S, 0.92, 0.62, [16, 16]);
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

  // ════════════════════ Concrete / paving ════════════════════
  {
    const blot = normalizeField(fbmField(S, 6, 4, 61, { gain: 0.5 }));
    const pore = normalizeField(fbmField(S, 70, 2, 62, { gain: 0.5 }));
    T.plaza = albedoFromField(blot, S, (v, p) => {
      const t = v * 0.6 + p * 0.4;
      const g = _mix(92, 142, t);
      return [g * 1.02, g, g * 0.95];
    }, [7, 7], pore);
    {   // slab joints
      const ctx = T.plaza.image.getContext('2d');
      ctx.strokeStyle = 'rgba(58,56,52,0.42)'; ctx.lineWidth = 2.5;
      for (let i = 0; i <= 4; i++) {
        ctx.beginPath(); ctx.moveTo(i * S / 4, 0); ctx.lineTo(i * S / 4, S); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i * S / 4); ctx.lineTo(S, i * S / 4); ctx.stroke();
      }
      T.plaza.needsUpdate = true;
    }
    T.concrete = T.plaza;
    const bump = new Float32Array(S * S);
    for (let i = 0; i < bump.length; i++) bump[i] = pore[i] * 0.7 + blot[i] * 0.3;
    T.plazaN = normalMapFromField(bump, S, 1.2, [7, 7]);
    T.concreteN = T.plazaN;
    T.plazaR = grayMapFromField(blot, S, 0.86, 0.6, [7, 7]);
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

  // ── House wall variants: plaster with framed windows + a door ──
  function wallDraw(base, trim) {
    return (ctx, w, h) => {
      noiseFill(ctx, w, h, rng, base, 0.05, 2500);
      const rows = 2, cols = 4;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (r === rows - 1 && c === 1) { // door
            ctx.fillStyle = trim;
            ctx.fillRect(c * w / cols + w * 0.06, h * 0.55, w * 0.13, h * 0.45);
            ctx.fillStyle = '#2a2622';
            ctx.fillRect(c * w / cols + w * 0.075, h * 0.57, w * 0.10, h * 0.43);
            continue;
          }
          const x = c * w / cols + w * 0.05, y = r * h / rows + h * 0.12;
          const ww = w * 0.15, wh = h * 0.28;
          ctx.fillStyle = trim; ctx.fillRect(x - 4, y - 4, ww + 8, wh + 8);
          const sky = ctx.createLinearGradient(x, y, x, y + wh);
          sky.addColorStop(0, '#b7d3e6'); sky.addColorStop(1, '#5a748a');
          ctx.fillStyle = sky; ctx.fillRect(x, y, ww, wh);
          ctx.strokeStyle = trim; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(x + ww / 2, y); ctx.lineTo(x + ww / 2, y + wh);
          ctx.moveTo(x, y + wh / 2); ctx.lineTo(x + ww, y + wh / 2); ctx.stroke();
          // sill + lintel shadow so the opening reads as recessed
          ctx.fillStyle = 'rgba(0,0,0,0.22)';
          ctx.fillRect(x, y, ww, 3);
          ctx.fillStyle = 'rgba(255,255,255,0.16)';
          ctx.fillRect(x - 4, y + wh + 4, ww + 8, 3);
        }
      }
    };
  }
  T.wallA = canvasTexture([512, 256], wallDraw('#d8cfc0', '#7d6a55'));
  T.wallB = canvasTexture([512, 256], wallDraw('#c2ccd4', '#4c5a66'));
  T.wallC = canvasTexture([512, 256], wallDraw('#d9c4a9', '#8a5a40'));
  {   // one shared plaster relief map for all three
    const f = normalizeField(fbmField(256, 20, 3, 101, { gain: 0.5 }));
    T.wallN = normalMapFromField(f, 256, 1.0, [1, 1]);
  }

  // matching lit-window emissive maps (same deterministic window grid)
  function wallEmissive() {
    return canvasTexture([512, 256], (ctx, w, h) => {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
      const rows = 2, cols = 4;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (r === rows - 1 && c === 1) continue;      // the door
          if (rng() > 0.42) continue;
          const x = c * w / cols + w * 0.05, y = r * h / rows + h * 0.12;
          ctx.fillStyle = rng() < 0.8 ? '#ffd9a0' : '#d7e8f2';
          ctx.fillRect(x, y, w * 0.15, h * 0.28);
        }
      }
    });
  }
  T.wallAE = wallEmissive();
  T.wallBE = wallEmissive();
  T.wallCE = wallEmissive();

  // mid-rise city blocks: window-grid facade + lit-window emissive pair
  function blockPair(floors, base, trim) {
    const litRects = [];
    const map = canvasTexture([512, 512], (ctx, w, h) => {
      noiseFill(ctx, w, h, rng, base, 0.05, 2600);
      const cols = 7;
      const gY = h * 0.82;                 // storefront band below
      const floorH = gY / floors;
      for (let f = 0; f < floors; f++) {
        // spandrel band between floors reads as a real slab edge
        ctx.fillStyle = 'rgba(0,0,0,0.10)';
        ctx.fillRect(0, f * floorH, w, 3);
        for (let c = 0; c < cols; c++) {
          const x = (c + 0.18) * (w / cols), y = f * floorH + floorH * 0.22;
          const ww = (w / cols) * 0.64, wh = floorH * 0.56;
          ctx.fillStyle = trim; ctx.fillRect(x - 3, y - 3, ww + 6, wh + 6);
          const sky = ctx.createLinearGradient(0, y, 0, y + wh);
          sky.addColorStop(0, '#8fa9bd'); sky.addColorStop(1, '#42566a');
          ctx.fillStyle = sky; ctx.fillRect(x, y, ww, wh);
          ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x, y, ww, 2.5);
          if (rng() < 0.4) litRects.push([x, y, ww, wh, false]);
        }
      }
      ctx.fillStyle = trim; ctx.fillRect(0, gY, w, h - gY);
      ctx.fillStyle = '#1d2833';
      ctx.fillRect(w * 0.04, gY + 8, w * 0.92, h - gY - 20);
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
  T.blockA = blockPair(4, '#b9b2a6', '#4a5560');
  T.blockB = blockPair(6, '#9fa8b2', '#39424c');
  T.blockC = blockPair(3, '#c4b49e', '#5a4a3a');

  T.roof = canvasTexture([256, 256], (ctx, w, h) => {
    noiseFill(ctx, w, h, rng, '#7c4c3c', 0.08, 2500);
    for (let y = 0; y < h; y += 16) {
      // pantile courses with a highlight ridge and a shadow gap
      ctx.fillStyle = 'rgba(255,196,150,0.14)';
      ctx.fillRect(0, y + 2, w, 4);
      ctx.strokeStyle = 'rgba(30,18,14,0.5)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      for (let x = (y / 16) % 2 ? 16 : 0; x < w; x += 32) {
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 16); ctx.stroke();
      }
    }
  }, { repeat: [2, 2] });

  T.roofSlate = canvasTexture([256, 256], (ctx, w, h) => {
    noiseFill(ctx, w, h, rng, '#4a5058', 0.08, 2500);
    for (let y = 0; y < h; y += 14) {
      ctx.fillStyle = 'rgba(180,196,214,0.10)'; ctx.fillRect(0, y + 2, w, 3);
      ctx.strokeStyle = 'rgba(15,18,22,0.5)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
  }, { repeat: [2, 2] });
  {
    const f = normalizeField(fbmField(256, 16, 3, 111, { gain: 0.5 }));
    T.roofN = normalMapFromField(f, 256, 1.6, [2, 2]);
  }

  T.bark = canvasTexture([128, 256], (ctx, w, h) => {
    noiseFill(ctx, w, h, rng, '#5c4632', 0.12, 2200);
    ctx.strokeStyle = 'rgba(25,16,8,0.45)';
    for (let i = 0; i < 40; i++) {
      const x = rng() * w;
      ctx.lineWidth = 1 + rng() * 2;
      ctx.beginPath(); ctx.moveTo(x, 0);
      ctx.bezierCurveTo(x + 8, h * 0.3, x - 8, h * 0.6, x + 4, h); ctx.stroke();
    }
  }, { repeat: [1, 1] });

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

  // Leafy canopy alpha texture (soft blob clusters)
  T.leaf = canvasTexture([128, 128], (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      const x = w / 2 + (rng() - 0.5) * w * 0.85;
      const y = h / 2 + (rng() - 0.5) * h * 0.85;
      const d = Math.hypot(x - w / 2, y - h / 2) / (w / 2);
      if (d > 0.95) continue;
      const g = 80 + rng() * 90;
      ctx.fillStyle = `rgba(${g * 0.42},${g},${g * 0.30},${0.75 - d * 0.4})`;
      ctx.beginPath(); ctx.arc(x, y, 4 + rng() * 9, 0, 7); ctx.fill();
    }
  });

  return T;
}
