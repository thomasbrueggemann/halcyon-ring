// ── layout.js — one seeded source of ring geometry ──────────────────────────
// Loaded right AFTER torusMath.js. Pure math, no THREE dependency. Road, river,
// rail, lanes, terrain, and every placement/ground query derive from here so
// all systems agree with each other.
//
// ── THE VALLEY, IN CROSS-SECTION ───────────────────────────────────────────
// The three long ribbons never overlap, because they are not three independent
// curves — they are ONE curve (the river) plus two signed offsets:
//
//   hull ‖ hillside │ ROAD │ bank │≈≈ RIVER ≈≈│ bank │ far bank │ RAIL │ hill ‖ hull
//        ←────────────── −lat ──────── 0 ──────── +lat ──────────────→
//
//   riverLat(θ)  the valley thalweg — meanders ±13 m, widens into the
//                Reservoir Flats lake and three smaller pools
//   roadLat(θ) = riverLat − riverHalf − roadGap(θ)     (always the −lat bank)
//   railLat(θ) = riverLat + riverHalf + railGap(θ)     (always the +lat bank)
//
// Both gaps breathe independently (8→20 m), so the ribbons visibly converge and
// diverge, but the ORDER never changes and the road can never end up in the
// water. Crossings exist only where they are built: designed river bridges, and
// culverts where hillside tributaries pass under the road.
//
// INVARIANT: any function of theta that shapes the ring is 2π-periodic — built
// ONLY from integer-frequency harmonics A·sin(k·θ + φ) (k integer). No seam at
// θ = 0. Functions of `lat` may use any smooth form (lat is bounded, not
// periodic). groundH()/terrainH() are hot: no allocations, module-level temps.

// Own seeded rng, independent of main.js's `rng` so we never perturb the
// existing consumption order there. Inlined mulberry32 (textures.js defines the
// shared one, but it loads AFTER us, so we cannot reference it at parse time).
function _layMulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const _layRng = _layMulberry32((WORLD_SEED ^ 0x5eed) >>> 0);
// A second stream, used ONLY for the shape of the ring (the harmonic phases
// below). Keeping it separate means adding or removing a harmonic doesn't
// reshuffle the knolls and the lanes, which draw from _layRng.
const _shapeRng = _layMulberry32((WORLD_SEED ^ 0x9a17e5) >>> 0);
const _TAU = Math.PI * 2;
const _jit = (a, b) => a + _shapeRng() * (b - a);

// ── Seeded harmonic series ──────────────────────────────────────────────────
// Every long curve in the ring — the river, the bank gaps, the hills, the
// mountain crest — used to be a hard-coded sum of sines with hand-tuned phases,
// which meant every ring ever generated was the same ring. They are built from
// the seed now: the AMPLITUDES stay (they are what makes a river read as a
// river and not as a noise field), the phases are drawn per world, and the
// whole series is then normalised to a known peak.
//
// That last step is what makes randomising safe. Σ|A| for the river is 19.1 m
// but a tuned phase set only ever reached ±13; a random one could reach the
// full 19 and shove the guideway into its clamp for a whole district. Measuring
// the actual peak and scaling to it gives every seed the same envelope.
function _harm(terms) {
  return terms.map(([A, k]) => ({ A, k, p: _shapeRng() * _TAU }));
}
function _evalHarm(t, theta) {
  let s = 0;
  for (let i = 0; i < t.length; i++) s += t[i].A * Math.sin(t[i].k * theta + t[i].p);
  return s;
}
function _normHarm(t, peak) {
  let m = 0;
  for (let i = 0; i < 2048; i++) {
    const v = Math.abs(_evalHarm(t, (i / 2048) * _TAU));
    if (v > m) m = v;
  }
  if (m > 1e-6) { const f = peak / m; for (const x of t) x.A *= f; }
  return t;
}

function _smooth(a, b, x) {
  if (a === b) return x < a ? 0 : 1;
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
function _clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
function _clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
// gaussian bump of arc distance (meters) to a fixed center degree — periodic
// because arcDelta is the signed shortest arc.
function _gaussArc(theta, centerDeg, sigma) {
  const d = arcDelta(theta, centerDeg * DEG);
  return Math.exp(-(d * d) / (2 * sigma * sigma));
}
// The Cascade's course is measured off the un-carved landscape, so the carve
// stays inert until the table below it exists. See _cascadeCarve / CASCADE.
let _cascadeReady = false;

// Repulsion bump: FLAT over the obstacle's own footprint, then gaussian
// shoulders. A pure gaussian only guarantees clearance at the obstacle's exact
// theta — 30 m of arc later it has decayed to 40% and the ribbon has swung
// most of the way back, which is how the ring road ended up driving through the
// side of the observatory while the centre-line check reported everything fine.
function _bump(theta, centerDeg, sigma, flat) {
  const d = Math.abs(arcDelta(theta, centerDeg * DEG));
  if (d <= flat) return 1;
  const x = d - flat;
  return Math.exp(-(x * x) / (2 * sigma * sigma));
}

// ── Smooth obstacle repulsion (unchanged machinery) ─────────────────────────
// Build a list of {thetaDeg, sigma, amt} smooth repulsion bumps from a base
// (pre-repulsion) periodic function, one per obstacle {thetaDeg, lat, minSep,
// sigma}: at obstacle.thetaDeg the bump pushes the TOTAL (base + every other
// bump) to be `minSep` away from `obstacle.lat` (on whichever side it already
// favours), fading out over `sigma` so the result stays smooth (no kinks) and
// 2π-periodic. Obstacles that sit at nearly the same theta interfere with each
// other's bump, so this is solved with a few Gauss-Seidel passes (module-load
// time only — the runtime function is just base + Σ amt·gaussArc, allocation-
// free per call).
// Obstacles whose thetaDeg lands within `gapM` meters of arc of each other
// can't be satisfied by independent additive bumps at all — at the SHARED
// theta both bumps are simultaneously at full strength (gaussArc=1 for both),
// so pushing away from one lat necessarily re-violates the other and the
// naive iteration oscillates forever instead of settling. Cluster them and
// solve the union of forbidden lat-intervals directly.
function _clusterObstacles(obstacles, gapM = 10) {
  const sorted = obstacles.slice().sort((a, b) => a.thetaDeg - b.thetaDeg);
  const clusters = [];
  for (const o of sorted) {
    const last = clusters[clusters.length - 1];
    const prev = last && last[last.length - 1];
    // Two obstacles interfere as soon as their PLATEAUS overlap, not just when
    // their centres are close: at a shared theta both bumps are at full
    // strength, so the independent-bump iteration cannot satisfy either and
    // oscillates. Solve those as one interval problem instead.
    const reach = prev ? Math.max(gapM, (prev.flat || 0) + (o.flat || 0) + 30) : gapM;
    if (prev && Math.abs(arcDelta(prev.thetaDeg * DEG, o.thetaDeg * DEG)) < reach) last.push(o);
    else clusters.push([o]);
  }
  return clusters;
}
// `boundsFn(theta) -> [lo, hi]` is the legal lat window for the ribbon at that
// theta — for the road, "not in the water and not up the mountain". Without it
// the solver optimises a function the caller then clamps behind its back: it
// happily pushes the road toward the river to clear a building on the −lat
// side, the wet clamp undoes the push, and the carriageway ends up driving
// through the building anyway. With hand-tuned harmonics that never quite
// happened; with a fresh river every world it happens constantly. Knowing the
// window, the solver can pick the OTHER side of the obstacle instead.
function _buildRepulsion(baseFn, obstacles, passes = 40, boundsFn = null) {
  const clusters = _clusterObstacles(obstacles);
  const fixedTerms = [];   // multi-obstacle clusters, solved once, exactly
  const single = [];       // size-1 clusters, solved iteratively against each other
  for (const cluster of clusters) {
    if (cluster.length === 1) { single.push(cluster[0]); continue; }
    // Centre and plateau of the CLUSTER, not of its members: three coolant
    // tanks spread over 6° of arc need one bump 100 m wide, and averaging their
    // angles while keeping a single tank's 12 m plateau left the outer two
    // sitting on the shoulder — which is to say, in the road.
    const lo = Math.min(...cluster.map(o => o.thetaDeg));
    const hi = Math.max(...cluster.map(o => o.thetaDeg));
    const thetaDeg = (lo + hi) / 2;
    const theta = thetaDeg * DEG;
    const base = baseFn(theta);
    const margin = 0.5;
    let merged = cluster.map(o => [o.lat - o.minSep - margin, o.lat + o.minSep + margin]).sort((a, b) => a[0] - b[0]);
    const mg = [];
    for (const iv of merged) {
      if (mg.length && iv[0] <= mg[mg.length - 1][1]) mg[mg.length - 1][1] = Math.max(mg[mg.length - 1][1], iv[1]);
      else mg.push(iv.slice());
    }
    const inForbidden = (v) => mg.some(iv => v >= iv[0] && v <= iv[1]);
    const sigma = Math.max(...cluster.map(o => o.sigma));
    const flat = Math.abs(arcDelta(lo * DEG, hi * DEG)) / 2 + Math.max(...cluster.map(o => o.flat || 0));

    // The bump is a constant OFFSET but the base underneath it is not constant,
    // and a cluster plateau can now be 100 m wide — wide enough for the base to
    // wander 12 m across it. Solving at the centre alone therefore left the
    // outer members of the cluster back inside the forbidden band. Size the
    // offset off the worst point of the plateau instead, so the whole span
    // clears; over-clearing in the middle costs nothing.
    const samples = [];
    for (let s = -flat; s <= flat; s += Math.max(2, flat / 12)) samples.push(baseFn(theta + s / RF));
    if (!samples.length) samples.push(base);

    let amt = 0;
    if (inForbidden(base)) {
      const cands = [mg[0][0]];
      for (let i = 0; i < mg.length - 1; i++) cands.push(mg[i][1]);
      cands.push(mg[mg.length - 1][1]);
      const b = boundsFn ? boundsFn(theta) : null;
      // Score each candidate by the clearance it ACTUALLY delivers once the
      // caller's hard clamp has had its say — not by how far it asks the
      // ribbon to move. Sometimes both sides of a cluster leave the legal
      // window, and then the question is which one the clamp treats better:
      // pushed against the far limit you still end up 50 m clear, pushed
      // against the near one you end up in the fountain.
      let bestScore = -Infinity, bestAbs = Infinity;
      for (const c of cands) {
        const below = c <= (mg[0][0] + mg[mg.length - 1][1]) / 2;
        let a = below ? Infinity : -Infinity;
        for (const bs of samples) a = below ? Math.min(a, c - bs) : Math.max(a, c - bs);
        let score = Infinity;
        for (const bs of samples) {
          const v = b ? Math.min(Math.max(bs + a, b[0]), b[1]) : bs + a;
          for (const o of cluster) score = Math.min(score, Math.abs(v - o.lat) - o.minSep);
        }
        if (score > bestScore + 0.01 || (Math.abs(score - bestScore) <= 0.01 && Math.abs(a) < bestAbs)) {
          bestScore = score; bestAbs = Math.abs(a); amt = a;
        }
      }
    }
    fixedTerms.push({ thetaDeg, sigma, flat, amt });
  }

  const terms = single.map(o => ({ thetaDeg: o.thetaDeg, lat: o.lat, minSep: o.minSep, sigma: o.sigma, flat: o.flat || 0, amt: 0 }));
  const totalExcl = (theta, excludeIdx) => {
    let v = baseFn(theta);
    for (const t of fixedTerms) v += t.amt * _bump(theta, t.thetaDeg, t.sigma, t.flat);
    for (let j = 0; j < terms.length; j++) {
      if (j === excludeIdx) continue;
      const t = terms[j];
      if (t.amt) v += t.amt * _bump(theta, t.thetaDeg, t.sigma, t.flat);
    }
    return v;
  };
  // Damped Gauss-Seidel for the (well-separated) singletons — under-relaxation
  // (0.5) trades convergence speed for stability against neighbours that are
  // close enough to interact but not close enough to need full clustering.
  const RELAX = 0.5;
  // How much this bump has to add so the ribbon clears obstacle `t`, choosing
  // the side of it that actually lies inside the legal window.
  function wanted(t, i) {
    const theta = t.thetaDeg * DEG;
    const cur = totalExcl(theta, i);
    const diff = cur - t.lat;
    const natural = diff >= 0 ? 1 : -1;
    let sign = natural;
    if (boundsFn) {
      const b = boundsFn(theta);
      const near = t.lat + sign * t.minSep;
      if (near > b[1] || near < b[0]) {
        const far = t.lat - sign * t.minSep;
        if (far >= b[0] && far <= b[1]) sign = -sign;      // go around the other way
      }
    }
    // Worst case across the plateau, for the same reason the cluster solve
    // does it: the bump is flat, the ground under it is not.
    let worst = cur;
    const step = Math.max(2, (t.flat || 0) / 6);
    for (let s = -(t.flat || 0); s <= (t.flat || 0); s += step) {
      const v = totalExcl(theta + s / RF, i);
      if (sign > 0 ? v < worst : v > worst) worst = v;
    }
    if (sign === natural && Math.abs(worst - t.lat) >= t.minSep
        && (sign > 0 ? worst > t.lat : worst < t.lat)) return 0;    // already clear
    return (t.lat + sign * t.minSep) - worst;
  }
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < terms.length; i++) {
      const t = terms[i];
      t.amt = t.amt + RELAX * (wanted(t, i) - t.amt);
    }
  }
  for (let i = 0; i < terms.length; i++) terms[i].amt = wanted(terms[i], i);
  return fixedTerms.concat(terms.map(t => ({ thetaDeg: t.thetaDeg, sigma: t.sigma, flat: t.flat, amt: t.amt })));
}
// Repulsion terms are evaluated in the hottest function in the game (terrainH →
// riverLat runs millions of times at build and ~200×/frame after), and a naive
// loop over every term means an exp() per term per sample. Each bump is dead
// (< 3e-4) beyond 4σ, so index the terms by arc bucket and only touch the one
// or two that are actually live at this theta.
const _REP_BUCKETS = 256;
const _repBucketArc = CIRCUMFERENCE / _REP_BUCKETS;
function _indexRepulsion(terms) {
  const buckets = Array.from({ length: _REP_BUCKETS }, () => []);
  for (const t of terms) {
    if (!t.amt) continue;
    const s = t.thetaDeg * DEG * RF, reach = (t.flat || 0) + 4 * t.sigma;
    const b0 = ((Math.floor((s - reach) / _repBucketArc) % _REP_BUCKETS) + _REP_BUCKETS) % _REP_BUCKETS;
    const b1 = ((Math.floor((s + reach) / _repBucketArc) % _REP_BUCKETS) + _REP_BUCKETS) % _REP_BUCKETS;
    let b = b0;
    for (;;) { buckets[b].push(t); if (b === b1) break; b = (b + 1) % _REP_BUCKETS; }
  }
  return buckets;
}
function _applyRepulsion(theta, buckets) {
  let s = theta * RF;
  s = ((s % CIRCUMFERENCE) + CIRCUMFERENCE) % CIRCUMFERENCE;
  const bucket = buckets[Math.floor(s / _repBucketArc) % _REP_BUCKETS];
  let sum = 0;
  for (let i = 0; i < bucket.length; i++) {
    const t = bucket[i];
    sum += t.amt * _bump(theta, t.thetaDeg, t.sigma, t.flat);
  }
  return sum;
}

// ── Cross-valley base profile ───────────────────────────────────────────────
// Flat across the middle, then the ground curves up and BECOMES the tube wall:
// sideProfile(±FLOOR_LAT) is exactly the hull's own height there, so the
// terrain mesh and the glazed hull share an edge with no seam and no gap.
// This is only the BASE sweep — the mountain rim (below) rides on top of it.
const _SIDE_SHOULDER = 9.6;                    // height at the top of the valley wall
function sideProfile(lat) {
  const a = Math.min(lat < 0 ? -lat : lat, FLOOR_LAT);
  const lower = _SIDE_SHOULDER * _smooth(24, MTN_LAT0, a);               // the hillsides
  const upper = (FLOOR_EDGE_H - _SIDE_SHOULDER) * _smooth(MTN_LAT1 - 8, FLOOR_LAT, a);
  return lower + upper;                                       // final sweep into the glass
}

// ── The mountain rim ────────────────────────────────────────────────────────
// Beyond the settled valley the ground climbs into a rocky ridge that runs the
// whole ring on both sides — the thing that makes 190 m of tube read as a
// landscape rather than a wide trough. The crest wanders in height and breaks
// into spurs and gullies, then the far face drops back to meet the glazing at
// MTN_LAT1, so the terrain/hull seam at FLOOR_LAT is untouched.
//
// Everything here is 2π-periodic by construction (integer harmonics only), and
// the whole term is exactly zero inside |lat| < MTN_LAT0 — the valley cannot
// feel the mountains at all, so none of its tuned curves move.
// ── Where the waterfall comes off the +lat rim ──────────────────────────────
// Drawn per world, but not from anywhere: it has to stay clear of the station
// platforms (its outflow crosses the whole valley), clear of the spoke collars,
// and off the Reservoir lake, where the outflow would have nothing to run down.
const _degSep = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
const CASCADE_DEG = (function () {
  const clear = (d) => {
    for (const st of [13, 70, 183, 266, 334]) if (_degSep(d, st) < 20) return false;
    for (const sp of [0, 60, 120, 180, 240, 300]) if (_degSep(d, sp) < 12) return false;
    return true;
  };
  for (let tries = 0; tries < 600; tries++) {
    const d = _shapeRng() * 360;
    if (clear(d)) return d;
  }
  return 212;
})();

// ── Periodic ridged value-noise ─────────────────────────────────────────────
// Harmonics alone give a mountain ONE shape repeated round the ring; peaks need
// noise. This lattice wraps at `cells` in the arc direction, so it is exactly
// 2π-periodic (no seam at θ = 0) while still being aperiodic to the eye.
const _MTN_SEED = Math.imul(WORLD_SEED ^ 0x3c6ef35f, 2654435761) | 0;
function _mtnHash(ix, iy) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ _MTN_SEED;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function _vnoise(x, y, cells) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const xa = ((x0 % cells) + cells) % cells, xb = (xa + 1) % cells;
  const a = _mtnHash(xa, y0), b = _mtnHash(xb, y0);
  const c = _mtnHash(xa, y0 + 1), d = _mtnHash(xb, y0 + 1);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}
// Ridged fBm: folding each octave through 1-|2n-1| and squaring it turns
// rounded hills into sharp crests with steep-sided valleys between them, which
// is what makes a heightfield read as rock instead of as a sand dune. Four
// octaves — the finest lattice cell is ~7.7 m, twice the terrain grid step, so
// nothing aliases.
const _MTN_CELLS0 = 96;                                  // ≈ 61 m per base cell
function _mtnFbm(theta, lat, side) {
  const yOff = side > 0 ? 0 : 53.5;
  let sum = 0, norm = 0, amp = 1, cells = _MTN_CELLS0;
  const uBase = theta / (2 * Math.PI);
  for (let o = 0; o < 4; o++) {
    const n = _vnoise(uBase * cells, (lat / CIRCUMFERENCE) * cells + yOff, cells);
    const r = 1 - Math.abs(2 * n - 1);
    sum += amp * r * r;
    norm += amp;
    amp *= 0.52; cells *= 2;
  }
  return sum / norm;
}

// Where the ground starts to climb, per theta and per side. A FIXED foot makes
// the rim read as one long extruded wall no matter how you texture it; letting
// it advance and retreat by ±8 m turns the same wall into headlands and bays
// with the fields running up into them. Clamped clear of VALLEY_LAT so a
// wandering road can never end up inside the mountain.
// One series per side, so the two rims are never mirrors of each other.
const _FOOT_H = [0, 1].map(() => _normHarm(_harm([[4.6, 1], [3.4, 2], [2.2, 3], [1.4, 6]]), 8.5));
function _mtnFoot(theta, side) {
  const f = MTN_LAT0 + 5.0 + _evalHarm(_FOOT_H[side > 0 ? 0 : 1], theta);
  return f < MTN_LAT0 - 2 ? MTN_LAT0 - 2 : f;
}
// Crest height, per side.
const _AMP_H = [0, 1].map(() => _normHarm(_harm([[12, 1], [8.5, 2], [5.4, 3], [3.6, 5]]), 24));
function _mtnAmp(theta, side) {
  const a = 33 + _evalHarm(_AMP_H[side > 0 ? 0 : 1], theta);
  return a < 9 ? 9 : a;
}
// The two named high ranges. Kept OUT of _mtnAmp because that term is scaled by
// the fBm, and a col landing on the Cascade would have quietly halved the
// waterfall. These are mostly added straight, so the massifs are guaranteed.
const _RANGE2_DEG = (CASCADE_DEG + _jit(110, 250)) % 360;
function _mtnMassif(theta) {
  return 34.0 * _gaussArc(theta, CASCADE_DEG, 240)      // the massif the falls come off
       + 18.0 * _gaussArc(theta, _RANGE2_DEG, 190);     // a second high range
}
// Relief on the face. Folding a sine through |·| turns a smooth dune into a
// spine with a sharp crest and V-gullies between the spurs; the lat-modulated
// terms then break those spurs into buttresses and hanging shelves, so the face
// has depth from any angle instead of reading as vertical corduroy.
const _CRAG = [0, 1].map(() => ({
  ridge: [[11.0, 6], [6.0, 11], [3.2, 19], [1.6, 37]].map(([A, k]) => ({ A, k, p: _shapeRng() * _TAU })),
  gullyP: _shapeRng() * _TAU,
  butt: [[6.0, 3, 0.14], [3.2, 9, 0.23], [1.8, 17, 0.35]]
    .map(([A, k, f]) => ({ A, k, f, p: _shapeRng() * _TAU, q: _shapeRng() * _TAU })),
}));
function _mtnCrag(theta, lat, side) {
  const C = _CRAG[side > 0 ? 0 : 1];
  let ridge = 0;
  for (let i = 0; i < C.ridge.length; i++) {
    const t = C.ridge[i];
    ridge += t.A * (1 - Math.abs(Math.sin(t.k * theta + t.p)));
  }
  const gully = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(lat * 0.20 + C.gullyP));
  let butt = 0;
  for (let i = 0; i < C.butt.length; i++) {
    const t = C.butt[i];
    butt += t.A * Math.sin(t.k * theta + t.p) * Math.cos(t.f * lat + t.q);
  }
  return ridge * gully + butt;
}
function _mountainH(theta, lat) {
  const a = lat < 0 ? -lat : lat;
  if (a <= MTN_LAT0 - 2 || a >= MTN_LAT1) return 0;
  const side = lat < 0 ? -1 : 1;
  const foot = _mtnFoot(theta, side);
  if (a <= foot) return 0;
  // One normalized coordinate from the foot to the glazing shoreline: the crest
  // sits at u ≈ 0.55 and the far face always lands on MTN_LAT1, so however far
  // the foot wanders the rim still meets the hull exactly where it must.
  const u = (a - foot) / (MTN_LAT1 - foot);
  const w = _smooth(0, 0.55, u) * (1 - _smooth(0.70, 1, u));
  if (w <= 0) return 0;
  // The harmonics set how high this stretch of rim gets; the ridged fBm decides
  // where the peaks and the cols actually fall, and the crag term cuts the
  // gullies into the face.
  const f = _mtnFbm(theta, lat, side);
  const massif = _mtnAmp(theta, side) * (0.30 + 0.85 * f) + _mtnMassif(theta) * (0.60 + 0.40 * f);
  return w * (massif + _mtnCrag(theta, lat, side));
}

// ── River — the primary curve everything else hangs off ─────────────────────
// Low-k (1,2,3,5) gives the valley-wide S-sweep; k=8/10/12/14 is MID-frequency
// content whose period (≈75–115 m) is short enough to read as a visible bend
// inside any ~300 m street-level sightline.
const _RIVER_H = _normHarm(_harm([
  [6.2, 1], [4.4, 2], [2.6, 3], [1.2, 5],       // valley-wide S-sweep
  [1.6, 8], [1.3, 10], [1.0, 12], [0.8, 14],    // bends inside a street sightline
  [0.6, 19], [0.45, 26],                        // kinks you notice from the bank
]), 15);
function _riverHarm(theta) { return _evalHarm(_RIVER_H, theta); }

// Width is its own story, told at a different rate than the meander. Two
// harmonics gave the channel one slow breath per lap — the same 5.6 m of water
// everywhere except the four named pools. Carrying content up to k = 13 means
// the river pinches into a 2 m run between rocks and opens into a 9 m reach
// several times inside one district, which is what stops a walk along the bank
// reading as a walk along a canal.
const _HALF_H = _normHarm(_harm([
  [0.60, 2], [0.40, 3], [0.34, 5], [0.24, 8], [0.16, 13],
]), 1.0);
function _halfUnit(theta) { return _evalHarm(_HALF_H, theta); }
// Channel half-width: a modest stream most of the way round, opening into the
// Reservoir Flats lake (~240°), Solace Park's pond (~73°), the Orchards
// mill-pond (~160°) and the Dock Annex marina inlet (~305°).
// The lake is deliberately centred at 233° rather than mid-district: the spoke
// shaft at 240° has to stay dry, and a bulge sitting on top of it would force
// the whole reservoir out to one side of the valley to clear it.
// The widenings drift within their own districts from seed to seed, so the lake
// is always in Reservoir Flats and the mill-pond always in the Orchards, but
// which bend they sit on changes. Kept modest around the reservoir: the spoke
// shaft at 240° has to stay dry, and a bulge on top of it would force the whole
// lake out to one side of the valley to clear it.
const WIDENINGS = [
  { deg: _jit(226, 240), amp: _jit(9.5, 12.5), sigma: _jit(34, 46) },   // Reservoir Flats lake
  { deg: _jit(66, 82),   amp: _jit(3.8, 5.4),  sigma: _jit(26, 34) },   // Solace Park pond
  { deg: _jit(152, 170), amp: _jit(2.6, 3.8),  sigma: _jit(18, 26) },   // Orchards mill-pond
  { deg: _jit(296, 314), amp: _jit(2.2, 3.4),  sigma: _jit(16, 24) },   // Dock Annex marina inlet
];
// …and three unnamed broads, drawn anywhere the ring will take one. The four
// above are landmarks — they belong to their districts and have to stay put so
// the mill and the marina still sit on water. These are the opposite: pure
// seed, so every world has pools in places the last one didn't. Kept off the
// spoke collars and the station platforms, which have to stay dry.
for (let tries = 0, made = 0; tries < 400 && made < 3; tries++) {
  const deg = _shapeRng() * 360;
  let ok = _degSep(deg, 6) > 26;                                // the plaza
  for (const sp of [0, 60, 120, 180, 240, 300]) if (_degSep(deg, sp) < 18) ok = false;
  for (const st of [13, 70, 183, 266, 334]) if (_degSep(deg, st) < 18) ok = false;
  for (const g of WIDENINGS) if (_degSep(deg, g.deg) < 26) ok = false;
  if (!ok) continue;
  WIDENINGS.push({ deg, amp: _jit(3.0, 6.6), sigma: _jit(13, 24) });
  made++;
}
// Pinches: the other half of "not a canal". A widening alone gives a river that
// is sometimes fat and otherwise average; a narrowing gives it rapids. These
// subtract, and the clamp below keeps the channel from ever closing.
const _NARROWS = (function () {
  const out = [];
  for (let tries = 0, made = 0; tries < 500 && made < 5; tries++) {
    const deg = _shapeRng() * 360;
    let ok = true;
    for (const g of WIDENINGS) if (_degSep(deg, g.deg) < g.sigma / 8 + 16) ok = false;
    for (const n of out) if (_degSep(deg, n.deg) < 24) ok = false;
    if (!ok) continue;
    out.push({ deg, amp: _jit(1.8, 3.4), sigma: _jit(9, 17) });
    made++;
  }
  return out;
})();
function _riverHalfCore(theta) {
  let w = 5.6 + 3.4 * _halfUnit(theta);
  for (let i = 0; i < WIDENINGS.length; i++) {
    const g = WIDENINGS[i];
    w += g.amp * _gaussArc(theta, g.deg, g.sigma);
  }
  for (let i = 0; i < _NARROWS.length; i++) {
    const n = _NARROWS[i];
    w -= n.amp * _gaussArc(theta, n.deg, n.sigma);
  }
  return w < 1.8 ? 1.8 : w;
}

// ── Bank gaps: water's edge → road centerline, water's edge → guideway ──────
// Independent phases so the two banks breathe out of step with each other.
const _ROADGAP_H = _normHarm(_harm([[0.55, 1], [0.28, 3], [0.17, 7]]), 1.0);
const _RAILGAP_H = _normHarm(_harm([[0.50, 2], [0.30, 1], [0.20, 5]]), 1.0);
function _roadGapBase(theta) { return 13.5 + 6.0 * _evalHarm(_ROADGAP_H, theta); }
function _railGapBase(theta) { return 15.0 + 6.5 * _evalHarm(_RAILGAP_H, theta); }
const ROAD_GAP_MIN = 9.0;    // water's edge → road centerline
const RAIL_GAP_MIN = 11.0;   // water's edge → guideway centerline

// ── Monorail stations ───────────────────────────────────────────────────────
// Frozen off the PRE-avoidance river so there is no circular dependency
// (station lats feed FLAT_SPOTS, which feed the river's avoidance solve).
// The gap is forced ≥ 17 m at a station so the platform + walk-up ramp on the
// river side always clear the water.
const STATIONS = [
  { name: 'Meridian Plaza', thetaDeg: 13 },
  { name: 'Solace Park',    thetaDeg: 70 },
  { name: 'Gamma Terminal', thetaDeg: 183 },
  { name: 'Observatory',    thetaDeg: 266 },
  { name: 'Dock Annex',     thetaDeg: 334 },
].map(st => {
  const theta = st.thetaDeg * DEG;
  // _riverHalfCore, not riverHalf(): the memo behind the public accessor also
  // computes riverLat, whose avoidance solve is not built yet at this point.
  const lat = _riverHarm(theta) + _riverHalfCore(theta) + Math.max(17, _railGapBase(theta));
  return { name: st.name, thetaDeg: st.thetaDeg, theta, lat: Math.min(lat, VALLEY_LAT - 4) };
});

// ── Flat spots (puzzle set-pieces, spoke pads, plaza, station platforms) ────
// { theta, lat, r, feather }. terrainH is blended to the spot's own base height
// inside r, feathered out over `feather`. Keeps every interaction coordinate on
// level ground so puzzles.js proximity maths keep working.
const FLAT_SPOTS = [
  { thetaDeg: 48,    lat: -18,  r: 14, feather: 10 },  // coolant valve panel
  { thetaDeg: 47,    lat: -36,  r: 12, feather: 10 },  // coolant tanks
  { thetaDeg: 104,   lat: -9,   r: 8,  feather: 9 },   // power relay
  { thetaDeg: 96,    lat: 24.5, r: 6,  feather: 8 },   // fuse — crate stack
  { thetaDeg: 113.4, lat: -35.4,r: 6,  feather: 8 },   // fuse — greenhouse
  { thetaDeg: 124.8, lat: 36.5, r: 6,  feather: 8 },   // fuse — silo
  { thetaDeg: 95,    lat: -40,  r: 10, feather: 9 },   // greenhouse 0
  { thetaDeg: 104,   lat: 26,   r: 10, feather: 9 },   // greenhouse 1
  { thetaDeg: 113,   lat: -40,  r: 10, feather: 9 },   // greenhouse 2
  { thetaDeg: 122,   lat: 26,   r: 10, feather: 9 },   // greenhouse 3
  { thetaDeg: 122,   lat: 34,   r: 10, feather: 9 },   // barn
  { thetaDeg: 124.5, lat: 40,   r: 6,  feather: 8 },   // silo
  { thetaDeg: 183,   lat: 0,    r: 30, feather: 12 },  // Gamma market strip
  { thetaDeg: 250,   lat: -28,  r: 10, feather: 10 },  // water tower
  { thetaDeg: 272,   lat: -30,  r: 12, feather: 10 },  // observatory
  { thetaDeg: 272,   lat: -13,  r: 6,  feather: 8 },   // observatory code console
  { thetaDeg: 321,   lat: -30,  r: 12, feather: 10 },  // dock warehouse 0
  { thetaDeg: 329,   lat: 30,   r: 12, feather: 10 },  // dock warehouse 1
  { thetaDeg: 337,   lat: -30,  r: 12, feather: 10 },  // dock warehouse 2
  { thetaDeg: 345,   lat: 30,   r: 12, feather: 10 },  // dock warehouse 3
  { thetaDeg: 8.2,   lat: -34,  r: 12, feather: 10 },  // civic hall
  { thetaDeg: 6,     lat: 0,    r: 26, feather: 22 },  // Meridian Plaza deck
].map(f => ({ theta: f.thetaDeg * DEG, lat: f.lat, r: f.r, feather: f.feather }));
// Spoke collar pads — the shafts land at lat 0 every 60°.
for (let i = 0; i < SPOKE_THETAS.length; i++) {
  FLAT_SPOTS.push({ theta: SPOKE_THETAS[i], lat: 0, r: 16, feather: 12 });
}
// Station platform pads.
for (let i = 0; i < STATIONS.length; i++) {
  FLAT_SPOTS.push({ theta: STATIONS[i].theta, lat: STATIONS[i].lat, r: 17, feather: 11 });
}

// Bucket the spots by arc so terrainH doesn't loop the whole list per sample.
const _SPOT_BUCKETS = 128;
const _spotBucketArc = CIRCUMFERENCE / _SPOT_BUCKETS;
const _spotBuckets = Array.from({ length: _SPOT_BUCKETS }, () => []);
function _sBucketOf(s) { return ((Math.floor(s / _spotBucketArc) % _SPOT_BUCKETS) + _SPOT_BUCKETS) % _SPOT_BUCKETS; }
for (const f of FLAT_SPOTS) {
  const s = f.theta * RF, reach = f.r + f.feather;
  const b0 = _sBucketOf(s - reach), b1 = _sBucketOf(s + reach);
  let b = b0;
  for (;;) { _spotBuckets[b].push(f); if (b === b1) break; b = (b + 1) % _SPOT_BUCKETS; }
}
function _spotsNear(theta) {
  let s = theta * RF;
  s = ((s % CIRCUMFERENCE) + CIRCUMFERENCE) % CIRCUMFERENCE;
  return _spotBuckets[_sBucketOf(s)];
}

const PLAZA_THETA = 6 * DEG;   // spawn plaza disc center
const PLAZA_R = 44;            // spawn/plaza disc radius that must stay dry

// ── River avoidance ─────────────────────────────────────────────────────────
// Keep every FLAT_SPOTS entry AND the spawn/plaza disc DRY.
const RIVER_AVOID = FLAT_SPOTS.map(f => ({
  thetaDeg: f.theta / DEG, lat: f.lat,
  minSep: _riverHalfCore(f.theta) + 7.0,
  flat: f.r + f.feather * 0.5,          // hold the clearance across the whole pad
  sigma: Math.max(22, f.r + f.feather + 10),
})).concat([{
  thetaDeg: PLAZA_THETA / DEG, lat: 0,
  minSep: _riverHalfCore(PLAZA_THETA) + 7.0,
  flat: PLAZA_R,
  sigma: PLAZA_R + 14,
}]);
const _riverAvoidBuckets = _indexRepulsion(_buildRepulsion(_riverHarm, RIVER_AVOID));
function _riverLatCore(theta) {
  return _riverHarm(theta) + _applyRepulsion(theta, _riverAvoidBuckets);
}

// ── Per-theta memo ──────────────────────────────────────────────────────────
// terrainH asks for riverLat/riverHalf/roadLat several times at the SAME theta
// (and the terrain mesh sweeps all lats at one theta before moving on), so a
// single-slot cache turns most of those into a compare. roadLat is filled
// lazily because its avoidance solve runs at module load and would otherwise
// need itself.
const _L = { theta: NaN, riverHalf: 0, riverLat: 0, roadLat: NaN, spurRoad: NaN };
function _prime(theta) {
  if (theta !== _L.theta) {
    _L.riverHalf = _riverHalfCore(theta);
    _L.riverLat = _riverLatCore(theta);
    _L.roadLat = NaN;
    _L.spurRoad = NaN;
    _L.theta = theta;
  }
  return _L;
}
function riverHalf(theta) { return _prime(theta).riverHalf; }
function riverLat(theta) { return _prime(theta).riverLat; }

// ── Ring road — always the −lat bank ────────────────────────────────────────
// Avoidance keeps the road off the spoke shafts and clear of the named
// set-piece footprints; the hard clamp afterwards guarantees it can never be
// pushed into the water or off the habitable floor, whatever avoidance asks.
// `flat` is the obstacle's own half-extent ALONG the arc: the road is held its
// full minSep away across that whole span, and only then allowed to ease back.
// minSep is the lat half-extent + ROAD_HALF + ROAD_SHLDR + 1 m.
const ROAD_AVOID = [
  ...[0, 60, 120, 180, 240, 300].map(d => ({ thetaDeg: d, lat: 0, minSep: 13, flat: 14, sigma: 15 })),
  // The plaza deck. Missing until a seed swung the river to +20 m here, which
  // dragged the road (which is always riverLat − riverHalf − gap) straight up
  // to lat 0 and ran the carriageway through the fountain.
  { thetaDeg: 6,   lat: 0,   minSep: 29,   flat: 34, sigma: 30 },  // Meridian Plaza deck
  { thetaDeg: 48,  lat: -18, minSep: 8.0,  flat: 16, sigma: 16 },  // coolant valve panel
  { thetaDeg: 104, lat: -9,  minSep: 8.1,  flat: 10, sigma: 12 },  // power relay cabinet
  { thetaDeg: 250, lat: -28, minSep: 11.4, flat: 14, sigma: 18 },  // water tower
  { thetaDeg: 272, lat: -30, minSep: 15.6, flat: 18, sigma: 22 },  // observatory
  { thetaDeg: 8.2, lat: -34, minSep: 14.6, flat: 18, sigma: 26 },  // civic hall
  { thetaDeg: 321, lat: -30, minSep: 14.5, flat: 18, sigma: 18 },  // dock warehouse 0
  { thetaDeg: 337, lat: -30, minSep: 14.5, flat: 18, sigma: 18 },  // dock warehouse 2
  // The road's lat is no longer anywhere near where it used to be, so every
  // fixed −lat set-piece has to be declared here or the carriageway drives
  // straight through it. These are the ones a ring sweep found it hitting.
  { thetaDeg: 44,  lat: -36, minSep: 10.0, flat: 12, sigma: 18 },  // coolant tank 0
  { thetaDeg: 47,  lat: -36, minSep: 10.0, flat: 12, sigma: 18 },  // coolant tank 1
  { thetaDeg: 50,  lat: -36, minSep: 10.0, flat: 12, sigma: 18 },  // coolant tank 2
  { thetaDeg: 95,  lat: -40, minSep: 11.0, flat: 14, sigma: 20 },  // greenhouse 0
  { thetaDeg: 113, lat: -40, minSep: 11.0, flat: 14, sigma: 20 },  // greenhouse 2
  { thetaDeg: 113.4, lat: -35.4, minSep: 7.0, flat: 9, sigma: 14 }, // greenhouse fuse cell
];
function _roadBase(theta) {
  const L = _prime(theta);
  return L.riverLat - L.riverHalf - Math.max(ROAD_GAP_MIN, _roadGapBase(theta));
}
const ROAD_LAT_MIN = -VALLEY_LAT;              // stay out of the mountain rim
// The window the road is allowed to occupy, which is exactly what the clamp in
// _roadLatCore enforces afterwards. Handing it to the solver is what lets an
// obstacle on the −lat side be cleared by going further −lat when there is no
// room to go +lat.
function _roadBounds(theta) {
  const L = _prime(theta);
  return [ROAD_LAT_MIN, Math.min(12, L.riverLat - L.riverHalf - (ROAD_HALF + ROAD_SHLDR + 3.0))];
}
const _roadAvoidBuckets = _indexRepulsion(_buildRepulsion(_roadBase, ROAD_AVOID, 40, _roadBounds));
// `wet` is the hard guarantee: whatever the avoidance solve asks for, the road
// never gets closer to the water than its own shoulder plus 3 m of bank.
function _roadLatCore(theta, rLat, rHalf) {
  const raw = rLat - rHalf - Math.max(ROAD_GAP_MIN, _roadGapBase(theta)) + _applyRepulsion(theta, _roadAvoidBuckets);
  const wet = rLat - rHalf - (ROAD_HALF + ROAD_SHLDR + 3.0);
  return _clamp(Math.min(raw, wet), ROAD_LAT_MIN, 12);
}
function roadLat(theta) {
  const L = _prime(theta);
  if (L.roadLat !== L.roadLat) L.roadLat = _roadLatCore(theta, L.riverLat, L.riverHalf);
  return L.roadLat;
}
// Yaw (radians) to ADD so an object faces along the local road direction.
function roadYawAt(theta) {
  const ds = 0.5, dt = ds / RF;               // 0.5 m finite difference
  const d = (roadLat(theta + dt) - roadLat(theta - dt)) / (2 * ds);
  return Math.atan2(d, 1);
}
// Kept for compatibility with anything reading the historic road↔river gap.
function riverSep(theta) { return roadLat(theta) - riverLat(theta); }

// ── Monorail guideway — always the +lat bank ────────────────────────────────
const RAIL_AVOID = [
  ...[0, 60, 120, 180, 240, 300].map(d => ({ thetaDeg: d, lat: 0, minSep: 13, flat: 14, sigma: 15 })),
  // minSep = the obstacle's own lat half-extent + the guideway half-width + a
  // 2 m margin. The deck rides ~7 m up, so only a genuine lateral overlap
  // matters — being generous here just shoves the guideway into the hillside.
  { thetaDeg: 122,   lat: 34, minSep: 11.0, flat: 14, sigma: 20 },  // barn
  { thetaDeg: 124.5, lat: 40, minSep: 9.0,  flat: 10, sigma: 16 },  // silo
  { thetaDeg: 329,   lat: 30, minSep: 11.0, flat: 18, sigma: 24 },  // dock warehouse 1
  { thetaDeg: 345,   lat: 30, minSep: 11.0, flat: 18, sigma: 24 },  // dock warehouse 3
];
function _railBase(theta) {
  const L = _prime(theta);
  return L.riverLat + L.riverHalf + Math.max(RAIL_GAP_MIN, _railGapBase(theta));
}
function _railBounds(theta) {
  const L = _prime(theta);
  return [L.riverLat + L.riverHalf + 8.0, VALLEY_LAT];
}
const _railAvoidBuckets = _indexRepulsion(_buildRepulsion(_railBase, RAIL_AVOID, 40, _railBounds));
// ── Late detours: weaving around what actually got built ────────────────────
// RAIL_AVOID above is the static list — spokes and named set-pieces, known
// before anything exists. The houses and blocks are not: they are placed by
// city.js from the world seed AFTER this module has loaded, using railLat to
// decide where they may stand. So the guideway learns about them last, and
// transit.js hands them back here as detours before it sweeps any geometry.
//
// A detour is a plain Gaussian bump in lat, summed like the static repulsion —
// which means it goes through the SAME station freeze and the same hard clamp
// below. It can bend the route around a house; it cannot push the guideway into
// the river, off the floor, or off a platform, whatever it asks for.
let _railDetours = [];
let _railRises = [];
function _railDetour(theta) {
  let sum = 0;
  for (let i = 0; i < _railDetours.length; i++) {
    const d = _railDetours[i];
    sum += d.amt * _bump(theta, d.thetaDeg, d.sigma, d.flat);
  }
  return sum;
}
function railRise(theta) {
  let sum = 0;
  for (let i = 0; i < _railRises.length; i++) {
    const d = _railRises[i];
    sum += d.amt * _bump(theta, d.thetaDeg, d.sigma, d.flat);
  }
  if (sum === 0) return 0;
  // A hop over a roof must never survive as far as a platform: the car floor
  // there has to meet the platform deck at exactly 6.0 m.
  let fade = 1;
  for (let i = 0; i < STATIONS.length; i++) {
    const d = Math.abs(arcDelta(theta, STATIONS[i].theta));
    if (d < 60) fade = Math.min(fade, _smooth(0, 60, d));
  }
  return sum * fade;
}
// list entries: { thetaDeg, amt, sigma, flat } — amt in metres of lat (detour)
// or metres of extra deck height (rise).
function setRailDetours(detours, rises) {
  _railDetours = detours || [];
  _railRises = rises || [];
}

function _railCore(theta, detour) {
  let lat = _railBase(theta) + _applyRepulsion(theta, _railAvoidBuckets) + detour;
  for (let i = 0; i < STATIONS.length; i++) {
    const st = STATIONS[i];
    const d = Math.abs(arcDelta(theta, st.theta));
    if (d < 45) {
      const w = 1 - _smooth(0, 45, d);          // 1 at the platform, 0 by ±45 m
      lat = lat * (1 - w) + st.lat * w;         // frozen to STATIONS lat there
    }
  }
  const dry = riverLat(theta) + riverHalf(theta) + 8.0;
  return _clamp(Math.max(lat, dry), -12, VALLEY_LAT);
}
function railLat(theta) { return _railCore(theta, _railDetour(theta)); }
// The route WITHOUT the late detours transit.js hands back. The terrain has to
// be carved before transit.js exists and must not move afterwards, so anything
// that shapes ground around the guideway (the mountain-spur notches below) uses
// this fixed line. A detour is a few metres of lat; the notch is far wider.
function railLatStatic(theta) { return _railCore(theta, 0); }
// Guideway deck height: rides ~7 m above whatever ground is under it, easing to
// exactly 6.0 m at each station (station pads are flat spots, so the ground
// there is the pad's own base height).
function railH(theta) {
  const lat = railLat(theta);
  const ground = terrainH(theta, lat);
  let clear = 6.9 + 1.5 * (0.60 * Math.sin(2 * theta + 1.70) + 0.40 * Math.sin(4 * theta + 3.10));
  for (let i = 0; i < STATIONS.length; i++) {
    const d = Math.abs(arcDelta(theta, STATIONS[i].theta));
    if (d < 45) {
      const w = 1 - _smooth(0, 45, d);
      clear = clear * (1 - w) + 6.0 * w;
    }
  }
  return ground + clear + railRise(theta);
}

// ── Mountain spurs: the rim reaching into the valley ────────────────────────
// The rim is otherwise two parallel walls, and a valley bounded by two parallel
// walls is a corridor. A spur is a buttress of that rim thrown across the floor:
// a ridge that starts up in the crags, runs inward, and either dies as a
// headland part way across or carries all the way to the far rim.
//
// Nothing negotiates with a spur. The three ribbons are already fixed by the
// time one is drawn, so the spur yields to THEM: its height is multiplied by
// (1 − corridor), which cuts a notch through the ridge wherever the road, the
// guideway or the river passes. Where the spur is shallow that notch is a col
// you drive over; where it is deep it is a slot with 20 m of rock either side,
// and world.js roofs those into tunnels. So "goes around or tunnels through"
// falls out of one multiply instead of a routing solver — and it cannot fail,
// because a corridor that cannot be carved simply isn't possible here.
//
// Placement is the only thing with taste in it: spurs stay off the stations,
// the spoke collars, the plaza and the Cascade (whose gorge is already a hole
// in this rim), and off each other.
const SPUR_ROAD_W = ROAD_HALF + ROAD_SHLDR + 1.4;   // full-depth notch half-width
const SPUR_RAIL_W = 6.4;
// Notch wall run-out. Kept short on purpose: a long batter opens the slot into
// a trench you could land a shuttle in, and a roof over a trench that wide is
// not a tunnel. Short batter + the road bench pulled in below = rock rising
// close enough to the shoulder that the vault has something to spring off.
const SPUR_BATTER = 7.0;
const SPURS = (function () {
  const out = [];
  const clear = (deg, halfDeg) => {
    for (const st of STATIONS) if (_degSep(deg, st.thetaDeg) < 15 + halfDeg) return false;
    for (const sp of [0, 60, 120, 180, 240, 300]) if (_degSep(deg, sp) < 11 + halfDeg) return false;
    if (_degSep(deg, 6) < 16 + halfDeg) return false;               // Meridian Plaza
    if (_degSep(deg, CASCADE_DEG) < 16 + halfDeg) return false;
    for (const s of out) if (_degSep(deg, s.deg) < 26) return false;
    return true;
  };
  const want = 4 + Math.floor(_layRng() * 3);            // 4..6
  let guard = 0;
  while (out.length < want && guard++ < 900) {
    const halfArc = 22 + _layRng() * 24;                 // crest half-width, metres of arc
    const feather = 26 + _layRng() * 22;                 // shoulders beyond the crest
    const deg = _layRng() * 360;
    if (!clear(deg, (halfArc + feather) / RF / DEG)) continue;
    const side = _layRng() < 0.5 ? -1 : 1;
    // A third of them cross the whole valley. Any more and the ring reads as a
    // chain of separate rooms rather than one long landscape.
    const crosses = _layRng() < 0.34;
    // Signed lat the ridge dies at. A headland stops somewhere in the fields on
    // its own side or just past the middle; a crossing spur runs into the
    // opposite rim, so its tip is behind the far mountains' own foot.
    const tipLat = crosses
      ? -side * (VALLEY_LAT + 6)
      : side * (2 + _layRng() * 26);
    out.push({
      deg, theta: deg * DEG, s: deg * DEG * RF, side, crosses,
      tipLat, tipQ: tipLat * side,                        // tipQ: tip in "toward my rim" coords
      halfArc, feather,
      h: (crosses ? 30 : 24) + _layRng() * 16,
    });
  }
  return out;
})();

// Height the spurs WANT, before the corridors get their say.
function _spurRaw(theta, lat) {
  let add = 0;
  for (let i = 0; i < SPURS.length; i++) {
    const sp = SPURS[i];
    const d = arcDelta(sp.theta, theta);
    const ad = d < 0 ? -d : d;
    if (ad > sp.halfArc + sp.feather) continue;
    // q measures lat in the spur's own direction: it grows from the tip toward
    // the rim the spur grew out of, whichever side that is.
    const q = lat * sp.side;
    const run = q - sp.tipQ;
    if (run <= 0) continue;
    // Fade out INTO the crest rather than at some fixed lat: past the rim's own
    // foot the mountain is already this tall, and adding a spur on top of it
    // built a spike on the skyline.
    const wLat = _smooth(0, 17, run) * (1 - _smooth(MTN_LAT0 - 8, MTN_CREST - 4, q));
    if (wLat <= 0) continue;
    const wArc = ad <= sp.halfArc ? 1 : 1 - _smooth(sp.halfArc, sp.halfArc + sp.feather, ad);
    // Same ridged noise as the rim, so a spur is visibly the same rock.
    const rough = 0.55 + 0.80 * _mtnFbm(theta, lat, sp.side);
    const taper = 0.50 + 0.50 * _clamp01(run / 58);      // lower at the tip
    add += sp.h * wArc * wLat * taper * rough;
  }
  return add;
}
// How much the ground at (theta, lat) belongs to a corridor: 1 on the roadway,
// the guideway or the water, easing to 0 up the batter. This is what turns a
// ridge into a ridge with a slot through it.
function _corridorRelief(theta, lat) {
  let m = 1 - _smooth(SPUR_ROAD_W, SPUR_ROAD_W + SPUR_BATTER, Math.abs(lat - roadLat(theta)));
  if (m < 0.999) {
    const r = 1 - _smooth(SPUR_RAIL_W, SPUR_RAIL_W + SPUR_BATTER, Math.abs(lat - railLatStatic(theta)));
    if (r > m) m = r;
  }
  if (m < 0.999) {
    const L = _prime(theta);
    const w = 1 - _smooth(L.riverHalf + 3.0, L.riverHalf + 3.0 + SPUR_BATTER, Math.abs(lat - L.riverLat));
    if (w > m) m = w;
  }
  return m;
}
function spurH(theta, lat) {
  const raw = _spurRaw(theta, lat);
  if (raw <= 0.001) return 0;
  return raw * (1 - _corridorRelief(theta, lat));
}
// True where a spur stands high enough that nothing should be built or planted.
function onSpur(theta, lat) { return spurH(theta, lat) > 2.0; }
// Metres of rock standing over the carriageway here, memoised per theta because
// terrainH sweeps every lat at one theta and asks for this at each of them.
function spurOverRoad(theta) {
  const L = _prime(theta);
  if (L.spurRoad !== L.spurRoad) L.spurRoad = _spurRaw(theta, roadLat(theta));
  return L.spurRoad;
}

// ── Where a corridor is actually inside the rock ────────────────────────────
// Sweep each ribbon and keep the contiguous stretches where the spur it is
// passing through is deep enough to roof. world.js and transit.js build the
// portals and the vault from these; nothing about the ground depends on them,
// so a mis-tuned threshold costs dressing, never walkability.
function _boreRuns(latFn, minCrown) {
  const N = 4096, arc = CIRCUMFERENCE / N;
  const dep = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const theta = (i / N) * Math.PI * 2;
    dep[i] = _spurRaw(theta, latFn(theta));
  }
  // Start the sweep on a sample that is NOT inside rock, so a bore straddling
  // θ = 0 comes back as one tunnel instead of two halves at the seam.
  let start = 0;
  while (start < N && dep[start] > minCrown) start++;
  if (start === N) return [];
  const out = [];
  let run = null;
  for (let k = 0; k < N; k++) {
    const i = (start + k) % N;
    if (dep[i] > minCrown) {
      if (!run) run = { s0: (start + k) * arc, s1: (start + k + 1) * arc, crown: dep[i] };
      else { run.s1 = (start + k + 1) * arc; if (dep[i] > run.crown) run.crown = dep[i]; }
    } else if (run) {
      if (run.s1 - run.s0 >= 16) out.push(run);
      run = null;
    }
  }
  if (run && run.s1 - run.s0 >= 16) out.push(run);
  // s (and therefore theta) may run past one lap here. Everything downstream is
  // periodic, and keeping the run continuous is what lets a caller sweep it.
  return out.map(r => ({
    s0: r.s0, s1: r.s1, len: r.s1 - r.s0, crown: r.crown,
    theta0: r.s0 / RF, theta1: r.s1 / RF, thetaMid: (r.s0 + r.s1) / 2 / RF,
  }));
}

// Thresholds are the depth of rock over the corridor, so they differ: the
// carriageway sits on the ground and wants 8 m over it before a roof is worth
// building, while the guideway deck already rides ~7 m up and needs half again
// as much before there is a mountain left above it. The river gets no roof at
// all — an open gorge with the water running through it is the better sight.
const ROAD_TUNNELS = _boreRuns(roadLat, 8.0);
const RAIL_TUNNELS = _boreRuns(railLatStatic, 14.0);

// Under a roof? The ground inside a bore is still ordinary corridor ground —
// the notch is cut before the vault goes over it — so without this test the
// splat lays a lawn on the tunnel floor and vegetation plants a pine beside the
// carriageway, eighty metres inside a mountain. Half-widths match the vault.
const _BORES = [
  ...ROAD_TUNNELS.map((r) => ({ r, latFn: roadLat, w: 11.0 })),
  ...RAIL_TUNNELS.map((r) => ({ r, latFn: railLatStatic, w: 8.0 })),
];
function inBore(theta, lat) {
  for (let i = 0; i < _BORES.length; i++) {
    const b = _BORES[i];
    if (Math.abs(arcDelta(theta, b.r.thetaMid)) > b.r.len / 2 + 5) continue;
    if (Math.abs(lat - b.latFn(theta)) < b.w) return true;
  }
  return false;
}

// ── Hillside tributaries ────────────────────────────────────────────────────
// Small streams that come down off the −lat hillside, pass under the ring road
// through a culvert, and join the river. Nine of them, spaced round the ring
// away from the stations and the big set-pieces. Each is a straight run in
// (arc-length, lat) space; the carve is masked out inside the road corridor so
// the roadway itself stays intact and the stream reads as running under it.
const TRIBS = (function () {
  // Nine of them, spread round the ring but not evenly: each is jittered inside
  // its own 40° slot, so the spacing is different every world without any two
  // ever landing on top of each other.
  const degs = [26, 57, 91, 135, 166, 205, 232, 289, 314]
    .map(d => (d + (_layRng() - 0.5) * 22 + 360) % 360);
  return degs.map((deg) => {
    const theta = deg * DEG;
    const latLo = riverLat(theta) - riverHalf(theta) - 1.0;      // mouth, at the water
    const latHi = _clamp(roadLat(theta) - (16 + _layRng() * 16), -(MTN_LAT0 - 4), latLo - 12);
    const drift = (_layRng() - 0.5) * 34;                        // arc offset of the head
    return {
      theta, deg,
      sA: theta * RF + drift, latA: latHi,        // head, up the hillside
      sB: theta * RF, latB: latLo,                // mouth, at the river
      half: 1.5 + _layRng() * 0.9,
      depth: 0.95 + _layRng() * 0.5,
    };
  });
})();
// Squared distance from (s, lat) to a trib's centerline segment, plus the
// fraction along it (for tapering the channel toward the head).
function _tribDist(t, s, lat) {
  const dS = t.sB - t.sA, dL = t.latB - t.latA;
  const len2 = dS * dS + dL * dL;
  let f = ((s - t.sA) * dS + (lat - t.latA) * dL) / len2;
  f = f < 0 ? 0 : f > 1 ? 1 : f;
  const px = t.sA + dS * f - s, py = t.latA + dL * f - lat;
  return { d: Math.hypot(px, py), f };
}
// How strongly the road corridor protects the ground at (theta, lat) — 1 on the
// carriageway, 0 beyond the earthworks. Used to mask the tributary carve AND to
// bench the road across the cross-slope.
function _roadCorridor(theta, lat) {
  return 1 - _smooth(ROAD_HALF + ROAD_SHLDR + 1.0, ROAD_HALF + ROAD_SHLDR + 7.5, Math.abs(lat - roadLat(theta)));
}
function _tribCarve(theta, lat) {
  let s = theta * RF;
  let cut = 0;
  for (let i = 0; i < TRIBS.length; i++) {
    const t = TRIBS[i];
    let ds = s - t.sB;
    if (ds > CIRCUMFERENCE / 2) ds -= CIRCUMFERENCE;
    if (ds < -CIRCUMFERENCE / 2) ds += CIRCUMFERENCE;
    if (ds < -70 || ds > 70) continue;
    const q = _tribDist(t, t.sB + ds, lat);
    const half = t.half * (0.45 + 0.55 * q.f);              // narrows toward the head
    if (q.d > half + 5) continue;
    const depth = t.depth * (0.35 + 0.65 * q.f);
    cut = Math.min(cut, -depth * (1 - _smooth(half * 0.6, half + 5, q.d)));
  }
  return cut;
}
// Where a tributary actually holds water, found the same way as the river's
// shoreline: take the local surface just above the gully floor and scan outward
// for where the ground rises past it. A tributary tapers to nothing at its head
// and is cut through entirely by the road earthworks, and painting a fixed-width
// sheet down its whole length left flat panes of water lying on open grass.
// Returns { half, h, dry } at parameter f along the trib.
function tribEdges(t, f) {
  const s = t.sA + (t.sB - t.sA) * f;
  const lat = t.latA + (t.latB - t.latA) * f;
  const theta = s / RF;
  const floor = terrainH(theta, lat);
  const surf = floor + 0.14;
  const maxHalf = t.half * (0.45 + 0.55 * f) * (1 - _roadCorridor(theta, lat));
  if (maxHalf < 0.2) return { s, lat, half: 0, h: surf, dry: true };
  const scan = (dir) => {
    if (terrainH(theta, lat + dir * maxHalf) < surf) return maxHalf;
    let lo = 0, hi = maxHalf;
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2;
      if (terrainH(theta, lat + dir * mid) < surf) lo = mid; else hi = mid;
    }
    return lo;
  };
  const half = Math.min(scan(1), scan(-1));
  return { s, lat, half, h: surf, dry: half < 0.22 };
}
// Where each tributary passes under the road — world.js puts a culvert bridge
// here. Exported as CROSSINGS for continuity with the old road/river crossings.
const CROSSINGS = TRIBS.map(t => {
  // bisect along the trib for the point whose lat equals roadLat at that arc
  let lo = 0, hi = 1;
  const at = (f) => {
    const s = t.sA + (t.sB - t.sA) * f, lat = t.latA + (t.latB - t.latA) * f;
    return { s, lat, diff: lat - roadLat(s / RF) };
  };
  let a = at(0), b = at(1);
  if ((a.diff < 0) === (b.diff < 0)) return null;             // never crosses
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2, m = at(mid);
    if ((m.diff < 0) === (a.diff < 0)) { lo = mid; a = m; } else { hi = mid; }
  }
  const m = at((lo + hi) / 2);
  return { theta: m.s / RF, lat: m.lat, trib: t };
}).filter(Boolean);

// ── Designed river bridges ──────────────────────────────────────────────────
// The only places the two banks connect. Chosen away from the stations, the
// spokes and the widest water; world.js builds a walkable arched span at each.
const RIVER_BRIDGES = [18, 52, 88, 148, 196, 228, 282, 318]
  .map(deg => (deg + (_layRng() - 0.5) * 18) * DEG)
  .filter(theta => riverHalf(theta) < 12)
  .map(theta => {
    const rl = riverLat(theta), rh = riverHalf(theta);
    return {
      theta, lat: rl, half: rh,
      latLo: rl - rh - 6,                        // abutment on the road bank
      latHi: rl + rh + 6,                        // abutment on the far bank
      roadLat: roadLat(theta),                   // where the approach path joins
    };
  });

// ── Lake islands ────────────────────────────────────────────────────────────
// Two wooded islands in Reservoir Flats and one in the Orchards mill-pond. The
// terrain bump lifts them clear of WATER_H; the opaque ground then occludes the
// transparent water behind it, so no water is drawn over the island.
// They hang off WIDENINGS rather than off fixed angles, so wherever the lake
// and the mill-pond ended up this world, the islands are in them.
const ISLANDS = [
  { thetaDeg: WIDENINGS[0].deg - 5, dLat: -6.0, r: 11, h: 3.1 },
  { thetaDeg: WIDENINGS[0].deg + 4, dLat: 6.5,  r: 9,  h: 2.6 },
  { thetaDeg: WIDENINGS[2].deg,     dLat: 3.5,  r: 6,  h: 2.0 },
].map(i => {
  const theta = i.thetaDeg * DEG;
  return { theta, s: theta * RF, lat: riverLat(theta) + i.dLat, r: i.r, h: i.h };
});
function _islandBump(theta, lat) {
  let add = 0;
  let s = theta * RF;
  for (let i = 0; i < ISLANDS.length; i++) {
    const isl = ISLANDS[i];
    let ds = s - isl.s;
    if (ds > CIRCUMFERENCE / 2) ds -= CIRCUMFERENCE;
    if (ds < -CIRCUMFERENCE / 2) ds += CIRCUMFERENCE;
    if (ds < -isl.r - 4 || ds > isl.r + 4) continue;
    const d = Math.hypot(ds, lat - isl.lat);
    if (d > isl.r) continue;
    add += isl.h * Math.pow(1 - d / isl.r, 1.35);
  }
  return add;
}
function onIsland(theta, lat) { return _islandBump(theta, lat) > 0.35; }

// ── Knolls ──────────────────────────────────────────────────────────────────
// Rounded green hillocks standing out of the valley floor. The Don Davis
// painting is full of them, and they are what stops a 5.9 km valley reading as
// one long trough. Candidates are sampled and then REJECTED against the actual
// corridors around their whole footprint rather than trusted to a lat band —
// road and rail wander several metres across a 30 m-wide hill, and a knoll that
// dams the river or swallows the carriageway is worse than no knoll at all.
const KNOLLS = (function () {
  const out = [];
  const clearOf = (theta, lat) => {
    const rl = riverLat(theta), rh = riverHalf(theta);
    if (Math.abs(lat - rl) < rh + 7) return false;                       // out of the water
    if (Math.abs(lat - roadLat(theta)) < ROAD_HALF + ROAD_SHLDR + 9) return false;
    if (Math.abs(lat - railLat(theta)) < 9) return false;                // off the guideway
    if (Math.abs(lat) > VALLEY_LAT + 2) return false;                    // knolls are a valley feature
    const spots = _spotsNear(theta);
    for (let i = 0; i < spots.length; i++) {
      const f = spots[i];
      if (Math.hypot(arcDelta(theta, f.theta), lat - f.lat) < f.r + f.feather + 4) return false;
    }
    return true;
  };
  let guard = 0;
  while (out.length < 30 && guard++ < 8000) {
    const theta = _layRng() * Math.PI * 2;
    const r = 12 + _layRng() * 18;
    const h = 3.2 + _layRng() * 7.0;
    const side = _layRng() < 0.5 ? -1 : 1;
    const lat = side * (16 + _layRng() * 30);
    // reject on the footprint, not the centre
    let ok = true;
    for (let a = 0; a < 12 && ok; a++) {
      const ang = (a / 12) * Math.PI * 2;
      for (const f of [0.55, 1.0]) {
        const th = theta + Math.cos(ang) * r * f / RF;
        if (!clearOf(th, lat + Math.sin(ang) * r * f)) { ok = false; break; }
      }
    }
    if (!ok || !clearOf(theta, lat)) continue;
    // and not on top of another knoll
    for (const k of out) {
      if (Math.hypot(arcDelta(theta, k.theta), lat - k.lat) < r + k.r + 8) { ok = false; break; }
    }
    if (!ok) continue;
    out.push({ theta, s: theta * RF, lat, r, h });
  }
  return out;
})();
function _knollBump(theta, lat) {
  let add = 0;
  const s = theta * RF;
  for (let i = 0; i < KNOLLS.length; i++) {
    const k = KNOLLS[i];
    let ds = s - k.s;
    if (ds > CIRCUMFERENCE / 2) ds -= CIRCUMFERENCE;
    if (ds < -CIRCUMFERENCE / 2) ds += CIRCUMFERENCE;
    if (ds < -k.r || ds > k.r) continue;
    const d = Math.hypot(ds, lat - k.lat);
    if (d >= k.r) continue;
    const t = 1 - d / k.r;
    add += k.h * t * t * (3 - 2 * t);          // smooth dome, zero slope at the rim
  }
  return add;
}

// ── Standing lakes ──────────────────────────────────────────────────────────
// Water that is not the river. The four named pools are widenings of the
// channel, which means every drop of water in the ring used to be on one line —
// walk 40 m off the bank in any district and you were done with water for the
// rest of the lap. These are separate bodies out in the fields: a bowl carved
// below the waterline, filled to the same WATER_H datum as everything else, so
// wading, swimming, the depth tint and the shoreline shingle all work on them
// for free.
//
// The rim is a few harmonics of the bearing angle rather than a circle, because
// a circular lake reads as a crater — and it is an ELLIPSE before those
// harmonics, long along the arc and short across it. That is not a stylistic
// choice: the valley is only ~100 m of usable lat and the middle 50 of it is
// spoken for by the three corridors, so a round lake big enough to be a lake
// does not fit anywhere. A long one lying along the valley does.
//
// Filled AFTER _rawTerrain exists (they are rejected against the real
// landscape — a bowl on a rise is a dry pit), so the carve stays inert until
// `_lakesReady`, exactly like the Cascade's.
const LAKES = [];
let _lakesReady = false;
// Rim radius in the lake's own normalised frame (1 = the plain ellipse), as a
// function of bearing. world.js meshes the sheet off this, so it has to be the
// same call the carve uses or the water would not sit in its own bowl.
function lakeRim(lk, ang) {
  return 1 + 0.24 * Math.sin(2 * ang + lk.p1)
           + 0.14 * Math.sin(3 * ang + lk.p2)
           + 0.08 * Math.sin(5 * ang + lk.p3);
}
// Where (theta, lat) sits inside a lake, in the same normalised frame:
// { m } is the radius of the sample and { r } the rim on its bearing.
function lakePoint(lk, ang, m) {
  return {
    theta: lk.theta + Math.cos(ang) * lk.ra * m / RF,
    lat: lk.lat + Math.sin(ang) * lk.rl * m,
  };
}
// Normalised radius of (theta, lat) in the lake's frame: 0 at the middle, 1 at
// the rim, more than 1 outside it. Infinity once far enough out to skip.
// `lk.apron` is where the grading runs out; it is per-lake because it has to
// scale with the cut. A lake set into ground 5 m above the waterline needs
// three times the run-out of one in a hollow, or its bank is a quarry face.
function _lakeU(lk, theta, lat) {
  let ds = theta * RF - lk.s;
  if (ds > CIRCUMFERENCE / 2) ds -= CIRCUMFERENCE;
  if (ds < -CIRCUMFERENCE / 2) ds += CIRCUMFERENCE;
  const reach = lk.apron + 0.3;
  if (ds < -lk.ra * reach || ds > lk.ra * reach) return Infinity;
  const dl = lat - lk.lat;
  if (dl < -lk.rl * reach || dl > lk.rl * reach) return Infinity;
  const x = ds / lk.ra, y = dl / lk.rl;
  const d = Math.hypot(x, y);
  if (d < 1e-6) return 0;
  return d / lakeRim(lk, Math.atan2(y, x));
}
// The height a lake wants at normalised radius u, as an ABSOLUTE value rather
// than a depth to subtract. Two things fall out of writing it this way:
//
//   * At u = 1 the target IS the waterline, so the shoreline lands on the rim
//     by construction. Subtracting a bowl instead put it wherever the bowl
//     happened to out-dig the local ground — which, on land sitting 2 m proud
//     of the water, was a small pool at the bottom of a dry sand crater.
//   * The influence runs out to LAKE_APRON, past the rim, and the blend fades
//     over that band. That is the shelving bank: the ground is walked down from
//     wherever it naturally was to the water's edge over a few metres, instead
//     of being cut off at the rim and left as a wall.
// A paraboloid, not a smoothstep. A smoothstep bed only reaches full depth in
// the middle 18% of the radius and leaves the rest under half a metre of water,
// and half a metre is inside the shader's shoreline-foam band — the whole lake
// rendered as surf. 1 − u² holds real depth across most of the basin and still
// arrives at the waterline exactly on the rim.
function _lakeTarget(lk, u) {
  return lk.surf + 0.06 - lk.depth * (u < 1 ? 1 - u * u : 0);
}
// The surface height of whatever lake covers (theta, lat), or the river's own
// waterline if none does. Each lake has its OWN level: the fields sit 4-6 m
// above WATER_H, so a lake pinned to the river's datum is a 5 m pit with a
// bank too steep to walk down and bare scree all round it. A tarn standing at
// its own hollow's level needs a cut of centimetres.
// `pad` (metres) widens the test past the rim — the terrain shader wants the
// level of the lake it is STANDING BESIDE so it can shade the strand.
function lakeSurf(theta, lat, pad = 0) {
  let s = WATER_H;
  for (let i = 0; i < LAKES.length; i++) {
    const lk = LAKES[i];
    if (_lakeU(lk, theta, lat) <= 1 + pad / lk.rl && lk.surf > s) s = lk.surf;
  }
  return s;
}
function _lakeBlend(theta, lat, h) {
  if (!_lakesReady) return h;
  for (let i = 0; i < LAKES.length; i++) {
    const lk = LAKES[i];
    const u = _lakeU(lk, theta, lat);
    if (u >= lk.apron) continue;
    h += (_lakeTarget(lk, u) - h) * (1 - _smooth(1.0, lk.apron, u));
  }
  return h;
}
// Inside a lake's footprint (plus `pad`) — for the placers, which have no other
// way to know a field is now under water.
function inLake(theta, lat, pad = 0) {
  for (let i = 0; i < LAKES.length; i++) {
    const lk = LAKES[i];
    // pad is metres; the frame is normalised, so scale it by the short axis —
    // the conservative choice, since it over-pads along the arc.
    if (_lakeU(lk, theta, lat) <= 1 + pad / lk.rl) return true;
  }
  return false;
}

// ── Terrain ─────────────────────────────────────────────────────────────────
// Σ|A| = 5.42. Each octave is a product of an arc harmonic and a lat wave, so
// the rolling ground changes as you walk across the valley as well as along it.
const _HILL_T = [
  [1.55, 2, 0.030], [1.20, 3, 0.055], [0.90, 5, 0.070], [0.66, 7, 0.050],
  [0.48, 11, 0.160], [0.30, 17, 0.210], [0.20, 23, 0.310], [0.13, 31, 0.430],
].map(([A, k, f]) => ({ A, k, f, p: _shapeRng() * _TAU, q: _shapeRng() * _TAU }));
function _hills(theta, lat) {
  let s = 0;
  for (let i = 0; i < _HILL_T.length; i++) {
    const t = _HILL_T[i];
    s += t.A * Math.sin(t.k * theta + t.p) * Math.cos(t.f * lat + t.q);
  }
  return s;
}

const FLOODPLAIN = 1.65;   // general land level above the h = 0 datum

// Softly floor the floodplain at the waterline. `_hills` can dig 5 m below the
// datum, and with a fresh set of phases every world some stretch of bank
// eventually lands under WATER_H. That is not a pond: the drawn water sheet
// stops at the channel edge, so it is INVISIBLE water — ground you wade
// through, that slows you down, that nothing will grow on, with nothing to see.
// A smooth max keeps the ground continuous instead of stamping a flat pan at
// the waterline where it bites.
// Windowed so it is EXACTLY the identity more than 3 m above the waterline —
// an unwindowed smooth max carries a few millimetres of offset all the way out
// to the rim, and the rim is where the terrain has to meet the hull to the
// micron or you get a hairline of starfield along the glazing.
const BANK_FLOOR = WATER_H + 0.45;
function _softFloor(d) {
  if (d > 3.0) return d;
  const soft = 0.5 * (d + Math.sqrt(d * d + 0.55));
  const w = 1 - _smooth(0.8, 3.0, d);
  return d + (soft - d) * w;
}

// The landscape BEFORE the road bench and the flat spots: hillsides, rolling
// hills, the river channel, tributary gullies and the islands.
function _rawTerrain(theta, lat) {
  const a = lat < 0 ? -lat : lat;
  // Only the last few metres before the glazing settle onto the hull now — the
  // old 52 m fade would have flattened the whole mountain rim back down.
  const edgeFade = 1 - _smooth(FLOOR_LAT - 12, FLOOR_LAT, a);
  const L = _prime(theta);
  const rl = L.riverLat, rh = L.riverHalf;
  const u = Math.abs(lat - rl);

  let h = sideProfile(lat) + _mountainH(theta, lat) + spurH(theta, lat);
  let soil = FLOODPLAIN;
  soil += _hills(theta, lat) * _smooth(rh + 2, rh + 26, u);   // no bumps inside the channel
  soil -= 0.9 * (1 - _smooth(rh + 3, rh + 40, u));            // land tips gently toward the water
  soil += _tribCarve(theta, lat) * (1 - _roadCorridor(theta, lat));
  h += soil * edgeFade;
  h = BANK_FLOOR + _softFloor(h - BANK_FLOOR);

  // River channel. The bowl reaches WATER_H exactly at u = riverHalf and the
  // land only starts blending in beyond that, so the drawn shoreline and the
  // modelled shoreline are the same line — no water lapping over dry ground,
  // no dry gap inside the water's edge.
  if (u < rh + 4.2) {
    const w = 1 - _smooth(rh, rh + 4.2, u);
    const t = _clamp01(u / (rh > 0.001 ? rh : 0.001));
    const bed = WATER_H - RIVER_DEPTH * Math.pow(1 - t * t, 0.75);
    h = h * (1 - w) + bed * w;
  }
  // Lakes reach BELOW the soft floor on purpose — that floor exists to stop the
  // rolling hills accidentally dipping under the waterline, and a lake is the
  // one place we mean it.
  h = _lakeBlend(theta, lat, h);
  h += _islandBump(theta, lat) + _knollBump(theta, lat) * edgeFade;
  return _cascadeCarve(theta, lat, h);
}

// ── Filling the lakes ───────────────────────────────────────────────────────
// Rejection sampling against everything already committed: the three corridors,
// the set-piece pads, the knolls, the spurs, the Cascade's run-out, and each
// other. The last test is the one that matters — dig the bowl on paper and
// check it actually reaches below the waterline, because a lake on a rise is a
// dry hole in the middle of a field and nothing downstream would notice.
(function () {
  const clearOf = (theta, lat, reach) => {
    const rl = riverLat(theta), rh = riverHalf(theta);
    if (Math.abs(lat - rl) < rh + reach + 7) return false;
    if (Math.abs(lat - roadLat(theta)) < ROAD_HALF + ROAD_SHLDR + reach + 4) return false;
    if (Math.abs(lat - railLatStatic(theta)) < reach + 8) return false;
    if (Math.abs(lat) + reach > VALLEY_LAT - 3) return false;
    if (_spurRaw(theta, lat) > 0.5) return false;
    const spots = _spotsNear(theta);
    for (let i = 0; i < spots.length; i++) {
      const f = spots[i];
      if (Math.hypot(arcDelta(theta, f.theta), lat - f.lat) < f.r + f.feather + reach + 4) return false;
    }
    for (const k of KNOLLS) {
      if (Math.hypot(arcDelta(theta, k.theta), lat - k.lat) < k.r + reach + 5) return false;
    }
    for (const t of TRIBS) {
      const q = _tribDist(t, theta * RF, lat);
      if (q.d < reach + 6) return false;
    }
    return true;
  };
  const want = 4 + Math.floor(_layRng() * 4);          // 4..7
  let guard = 0;
  while (LAKES.length < want && guard++ < 24000) {
    const theta = _layRng() * Math.PI * 2;
    if (_degSep(theta / DEG, CASCADE_DEG) < 14) continue;
    const MARGIN = 1.95;                                // widest apron we allow
    // Don't sample lat blind, and don't pick the size blind either. Between the
    // outer corridor and the mountain foot there is one usable band per side, it
    // is narrow — 20-odd metres — and it moves as the road and the guideway
    // wander. Drawing a width first and rejecting whatever didn't fit threw away
    // 99% of candidates AND biased the survivors to the minimum size: every lake
    // came out the same 10 m puddle. So ask how wide the band IS here, then cut
    // the lake to fit it. Wide stretches get real lakes, tight ones get ponds.
    const side = _layRng() < 0.5 ? -1 : 1;
    const in0 = side < 0
      ? roadLat(theta) - (ROAD_HALF + ROAD_SHLDR + 5)
      : railLatStatic(theta) + 8;
    const out0 = side * (VALLEY_LAT - 4);
    const rlMax = Math.min(11, ((out0 - in0) * side) / (2 * MARGIN));
    if (rlMax < 5) continue;                           // no room on this side here
    const rl = 5 + _layRng() * (rlMax - 5);            // 5..11 m of water across
    const ra = rl * (2.0 + _layRng() * 3.0);           // 10..55 m along the valley
    const inner = in0 + side * rl * MARGIN;
    const outer = out0 - side * rl * MARGIN;
    const lat = inner + (outer - inner) * _layRng();
    const lk = {
      theta, s: theta * RF, lat, ra, rl,
      // Scaled to the short axis: 5 m of water in a 16 m-wide pool is a well,
      // not a lake, and it is the lat direction that runs out of room first.
      depth: _clamp(rl * 0.36, 2.4, 5.0),
      apron: 1.5, surf: WATER_H,                       // provisional; set below
      p1: _layRng() * _TAU, p2: _layRng() * _TAU, p3: _layRng() * _TAU,
    };
    // It will hold water wherever it goes — the target height inside the rim is
    // below the waterline by construction. What matters instead is the CUT: how
    // far the rim has to come down to reach the waterline, and how unevenly.
    // The valley floor rolls ±3 m over a lake's own footprint, so a cut is
    // unavoidable; a LOPSIDED one is what reads as a quarry, hence the spread
    // test as well as the depth test.
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * _TAU, rim = lakeRim(lk, ang);
      const g = _rawTerrain(theta + Math.cos(ang) * ra * rim / RF, lat + Math.sin(ang) * rl * rim);
      if (g < lo) lo = g;
      if (g > hi) hi = g;
      sum += g;
    }
    // The lake stands just under the LOWEST point of its own rim — any higher
    // and it pours out of that side. What is left to worry about is the
    // unevenness: the high shore has to be cut down by the full spread, and
    // there is only ~20 m of free lat to grade that away in. Past about 1 : 2
    // the bank crosses the terrain shader's scree threshold and the lake comes
    // out ringed in bare rock like a reservoir in a drought — so the spread is
    // a SITING constraint. Lakes go in level hollows, which is where they go.
    if (hi - lo > 3.6) continue;
    lk.surf = lo - 0.35;
    const drop = (hi - lo) + 0.35;
    lk.apron = 1 + _clamp(drop / (rl * 0.55), 0.45, MARGIN - 1);

    // Clearance last, because the footprint that has to be clear is the graded
    // one, not the water — and how far the grading reaches is what we just
    // worked out.
    let ok = true;
    for (let a = 0; a < 16 && ok; a++) {
      const ang = (a / 16) * _TAU;
      const x = Math.cos(ang), y = Math.sin(ang);
      for (const f of [0.6, lk.apron]) {
        const th = theta + x * ra * f / RF, la = lat + y * rl * f;
        if (!clearOf(th, la, 2)) { ok = false; break; }
      }
    }
    if (!ok || !clearOf(theta, lat, 2)) continue;
    for (const o of LAKES) {
      if (Math.abs(arcDelta(theta, o.theta)) < ra * lk.apron + o.ra * o.apron + 12 &&
          Math.abs(lat - o.lat) < rl * lk.apron + o.rl * o.apron + 12) { ok = false; break; }
    }
    if (!ok) continue;
    LAKES.push(lk);
  }
  _lakesReady = true;
  if (typeof console !== 'undefined') {
    console.log(`[layout] ${LAKES.length} lakes, ${SPURS.length} mountain spurs ` +
      `(${SPURS.filter(s => s.crosses).length} crossing), ` +
      `${ROAD_TUNNELS.length} road tunnels, ${RAIL_TUNNELS.length} rail tunnels`);
  }
})();

// ── The Cascade ─────────────────────────────────────────────────────────────
// A gorge cut into the inner face of the +lat mountain rim: a hanging gully at
// the crest, a sheer fall off the lip, a plunge basin at the toe, and an
// outflow stream that runs down across the fields (under the guideway) into the
// river. world.js hangs the water sheet, the pool and the mist off the numbers
// derived here, so the drawn falls and the walkable rock are the same shape.
//
// The whole course is described ONCE, as a floor height and a channel half-width
// per lat, sampled off the un-carved landscape. `_cascadeReady` keeps that
// sampling honest: until the table exists, the carve is a no-op, so building it
// from _rawTerrain is not circular.
function _cascadeCarve(theta, lat, h) {
  if (!_cascadeReady) return h;
  const C = CASCADE;
  if (lat < C.latMouth || lat > C.latHead) return h;
  let ds = theta * RF - C.s;
  if (ds > CIRCUMFERENCE / 2) ds -= CIRCUMFERENCE;
  if (ds < -CIRCUMFERENCE / 2) ds += CIRCUMFERENCE;
  ds -= C.arcAt(lat);                                   // the outflow meanders
  const half = C.halfAt(lat);
  const reach = half + C.FEATHER;
  if (ds < -reach || ds > reach) return h;
  // Ramp the blend from a third of the channel width, not from its edge: a
  // full-weight carve out to `half` gives the gorge two dead-vertical walls and
  // it reads as a trench cut with a knife. Starting the ramp early turns the
  // same numbers into a V-valley with a flat bed in the bottom of it.
  const w = 1 - _smooth(half * 0.34, reach, ds < 0 ? -ds : ds);
  const floor = C.floorAt(lat);
  return h + (floor - h) * w;
}

const CASCADE = (function () {
  const theta = CASCADE_DEG * DEG;
  const nat = (lat) => _rawTerrain(theta, lat);        // _cascadeReady is still false

  const latHead  = MTN_CREST + 5;                      // back of the hanging tarn
  const latLip   = MTN_CREST;                          // the water leaves the rock here
  const latToe   = MTN_LAT0 + 3;                       // where the fall lands
  const latSill  = MTN_LAT0 - 4;                       // downstream lip of the basin
  const latMouth = riverLat(theta) + riverHalf(theta) + 0.6;

  // A shelf cut into the crest holds a small tarn; the plunge basin is a bowl
  // set into the toe of the face. Both are sampled off the real mountain so the
  // gorge fits the rock instead of hovering in it.
  const hTarn = Math.min(nat(latLip), nat(latHead)) - 3.4;
  const poolSurf = Math.min(nat(latToe), nat(latSill)) - 1.3;
  const poolFloor = poolSurf - 3.4;
  const fallH = hTarn - poolSurf;

  const _lerp = (a, b, t) => a + (b - a) * t;
  const seg = (lat) => (lat >= latLip ? 'tarn' : lat >= latToe ? 'fall' : lat >= latSill ? 'basin' : 'run');

  function rawFloorAt(lat) {
    switch (seg(lat)) {
      case 'tarn': return hTarn;
      case 'fall': {
        // f^2.2 puts nearly all of the drop in the first few metres below the
        // lip: a sheer face with a talus fan under it, not a uniform chute.
        const f = _clamp01((lat - latToe) / (latLip - latToe));
        return poolSurf + fallH * Math.pow(f, 2.2);
      }
      case 'basin': {
        const f = _clamp01((lat - latSill) / (latToe - latSill));
        const bowl = Math.sin(f * Math.PI);            // 0 at both rims, 1 mid-basin
        return poolSurf - (poolSurf - poolFloor) * bowl;
      }
      default: {
        const u = _clamp01((latSill - lat) / (latSill - latMouth));
        return Math.min(_lerp(poolSurf, WATER_H, u * u * (3 - 2 * u)) - 0.55, nat(lat) - 1.3);
      }
    }
  }
  // Water surface. On the fall it clings to the rock; everywhere else it stands
  // in the channel, and it meets WATER_H exactly at the river so the outflow and
  // the river read as one body of water.
  function rawSurfAt(lat) {
    switch (seg(lat)) {
      case 'tarn': return hTarn + 1.15;
      case 'fall': return rawFloorAt(lat) + 0.30;
      case 'basin': return poolSurf;
      default: {
        const u = _clamp01((latSill - lat) / (latSill - latMouth));
        return _lerp(poolSurf, WATER_H, u * u * (3 - 2 * u));
      }
    }
  }
  function halfAt(lat) {
    switch (seg(lat)) {
      case 'tarn': return 17;
      case 'fall': {
        const f = _clamp01((lat - latToe) / (latLip - latToe));
        return _lerp(15, 8.5, f);                      // narrow at the lip, flaring below
      }
      case 'basin': {
        const f = _clamp01((lat - latSill) / (latToe - latSill));
        return _lerp(6.5, 17, Math.sin(f * Math.PI * 0.5));
      }
      default: return 3.0 + 1.6 * _clamp01((latSill - lat) / 40);
    }
  }
  // Arc offset of the channel centreline. The fall itself drops straight — a
  // meandering waterfall is a contradiction — but below the basin the outflow
  // has 45 m of open bank to cross, and running it dead down the fall line made
  // it read as a concrete spillway rather than a stream.
  function rawArcAt(lat) {
    if (lat >= latSill) return 0;
    const u = _clamp01((latSill - lat) / (latSill - latMouth));
    return _smooth(0, 0.16, u) * (13.5 * Math.sin(u * 4.1) + 6.0 * Math.sin(u * 9.3 + 1.7));
  }

  // Bake the course into tables. The outflow floor is defined against the
  // un-carved ground, so evaluating it lazily would re-enter _rawTerrain →
  // _cascadeCarve → floorAt and recurse forever. Sampling once here also makes
  // the runtime lookup a couple of array reads in the hottest function we have.
  const STEP = 0.25;
  const N = Math.ceil((latHead - latMouth) / STEP) + 1;
  const tFloor = new Float64Array(N), tSurf = new Float64Array(N), tHalf = new Float64Array(N);
  const tArc = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const lat = latMouth + i * STEP;
    tFloor[i] = rawFloorAt(lat); tSurf[i] = rawSurfAt(lat);
    tHalf[i] = halfAt(lat); tArc[i] = rawArcAt(lat);
  }
  const lookup = (tab) => (lat) => {
    const f = (lat - latMouth) / STEP;
    if (f <= 0) return tab[0];
    if (f >= N - 1) return tab[N - 1];
    const i = Math.floor(f), t = f - i;
    return tab[i] * (1 - t) + tab[i + 1] * t;
  };

  return {
    theta, thetaDeg: CASCADE_DEG, s: theta * RF, FEATHER: 22,
    latHead, latLip, latToe, latSill, latMouth,
    hTarn, poolSurf, poolFloor, fallH,
    floorAt: lookup(tFloor), surfAt: lookup(tSurf), halfAt: lookup(tHalf),
    arcAt: lookup(tArc), seg,
  };
})();
_cascadeReady = true;
if (typeof console !== 'undefined') {
  console.log(`[layout] cascade @${CASCADE_DEG}°: ${CASCADE.fallH.toFixed(1)} m fall, ` +
    `lip h=${CASCADE.hTarn.toFixed(1)} lat=${CASCADE.latLip}, pool h=${CASCADE.poolSurf.toFixed(1)}, ` +
    `mouth lat=${CASCADE.latMouth.toFixed(1)}`);
}

// ── Road elevation profile ──────────────────────────────────────────────────
// A road is not draped over the ground; it is cut and filled to a smooth
// grade. Sample the raw landscape along the carriageway, then low-pass it
// around the ring. The difference between raw and smoothed IS the cutting or
// embankment, and terrainH's bench blends those earthworks in over ~7 m each
// side. Without this the road inherits the hillside's cross-slope every time it
// wanders laterally, which produced 57% grades.
const _ROAD_SAMPLES = 4096;                       // 1.44 m spacing
const _roadSampleArc = CIRCUMFERENCE / _ROAD_SAMPLES;
const _roadElev = (function () {
  let cur = new Float64Array(_ROAD_SAMPLES);
  for (let i = 0; i < _ROAD_SAMPLES; i++) {
    const theta = (i / _ROAD_SAMPLES) * Math.PI * 2;
    cur[i] = _rawTerrain(theta, roadLat(theta));
  }
  // three circular box passes ≈ a gaussian; radius 24 samples ≈ 35 m window
  const R = 24;
  for (let pass = 0; pass < 3; pass++) {
    const out = new Float64Array(_ROAD_SAMPLES);
    let acc = 0;
    for (let k = -R; k <= R; k++) acc += cur[((k % _ROAD_SAMPLES) + _ROAD_SAMPLES) % _ROAD_SAMPLES];
    const inv = 1 / (2 * R + 1);
    for (let i = 0; i < _ROAD_SAMPLES; i++) {
      out[i] = acc * inv;
      acc -= cur[((i - R) % _ROAD_SAMPLES + _ROAD_SAMPLES) % _ROAD_SAMPLES];
      acc += cur[((i + R + 1) % _ROAD_SAMPLES + _ROAD_SAMPLES) % _ROAD_SAMPLES];
    }
    cur = out;
  }
  return cur;
})();
// Carriageway height at theta — THE reference the road ribbon and the bench
// both use, so the built road and the walkable ground agree exactly.
function roadH(theta) {
  let s = theta * RF;
  s = ((s % CIRCUMFERENCE) + CIRCUMFERENCE) % CIRCUMFERENCE;
  const f = s / _roadSampleArc;
  const i0 = Math.floor(f) % _ROAD_SAMPLES;
  const t = f - Math.floor(f);
  return _roadElev[i0] * (1 - t) + _roadElev[(i0 + 1) % _ROAD_SAMPLES] * t;
}

// Standing terrain height (m). The landscape, benched flat across the road
// corridor and levelled on every set-piece pad.
function terrainH(theta, lat) {
  let h = _rawTerrain(theta, lat);

  // set-piece pads — level to the pad's own base height
  const spots = _spotsNear(theta);
  for (let i = 0; i < spots.length; i++) {
    const f = spots[i];
    const dl = lat - f.lat;
    if (dl > f.r + f.feather || dl < -(f.r + f.feather)) continue;
    const d = Math.hypot(arcDelta(theta, f.theta), dl);
    if (d >= f.r + f.feather) continue;
    const w = 1 - _smooth(f.r, f.r + f.feather, d);
    h = h * (1 - w) + f.baseH * w;
  }

  // Road bench LAST: the carriageway always wins. Applying it before the pads
  // let a pad's circular falloff re-impose its own height across the roadway,
  // which put 50%+ grades into the road wherever one clipped it.
  const dRoad = Math.abs(lat - roadLat(theta));
  // A long batter, not a sheer face: cuttings can be 4-5 m deep where the
  // smoothed grade runs across a rising hillside. Inside a mountain spur the
  // batter is pulled in hard — out at its usual 15 m it drags the notch open
  // into a 30 m trench, and a 30 m trench with a roof over it is not a tunnel,
  // it is a roofed canyon. Short batter, near-vertical rock, a portal you can
  // see the far end of.
  const batter = ROAD_HALF + ROAD_SHLDR + 15 - 11.0 * _clamp01(spurOverRoad(theta) / 12);
  if (dRoad < batter) {
    const w = 1 - _smooth(ROAD_HALF + ROAD_SHLDR + 1.0, batter, dRoad);
    h = h * (1 - w) + roadH(theta) * w;
  }
  return h;
}

// Pad base heights, sampled once from the un-levelled landscape. A pad that
// sits close to the road adopts the road's own (smoothed) height instead, so
// you step off the carriageway onto the valve platform rather than onto a
// plateau or into a pit. Never below the waterline, so a pad can't become a pond.
for (const f of FLAT_SPOTS) {
  const raw = _rawTerrain(f.theta, f.lat);
  const w = 1 - _smooth(10, 30, Math.abs(f.lat - roadLat(f.theta)));
  f.baseH = Math.max(raw * (1 - w) + roadH(f.theta) * w, WATER_H + 0.9);
}

// Set-piece protection mask: 0 inside a pad, 1 outside. Used to pinch the drawn
// water so it can never visibly flood a valve/greenhouse/platform.
function _spotMask(theta, lat) {
  let m = 1;
  const spots = _spotsNear(theta);
  for (let i = 0; i < spots.length; i++) {
    const f = spots[i];
    m *= _smooth(f.r, f.r + f.feather, Math.hypot(arcDelta(theta, f.theta), lat - f.lat));
    if (m < 1e-4) return 0;
  }
  return m;
}
// Half-width for DRAWING the water (world.js) — kept for anything that just
// wants a cheap "how wide is the water here".
function riverDrawHalf(theta) {
  return riverHalf(theta) * _spotMask(theta, riverLat(theta));
}
// The EXACT drawn shoreline, found by bisecting outward from the thalweg for
// the last point genuinely below WATER_H. Cheap enough at build time and it
// means the water sheet can never spill a sliver over dry ground where a
// set-piece pad has lifted the terrain. Islands are ignored here on purpose:
// they are opaque terrain standing proud of the sheet, so they occlude it.
function waterEdges(theta) {
  const rl = riverLat(theta), rh = riverHalf(theta);
  const wet = (lat) => (terrainH(theta, lat) - _islandBump(theta, lat)) < WATER_H - 0.01;
  const scan = (dir) => {
    const far = rh + 4;
    if (wet(rl + dir * far)) return far;
    let lo = 0, hi = far;
    for (let k = 0; k < 22; k++) {
      const m = (lo + hi) / 2;
      if (wet(rl + dir * m)) lo = m; else hi = m;
    }
    return lo;
  };
  if (!wet(rl)) return { lo: rl, hi: rl, dry: true };
  const a = rl - scan(-1), b = rl + scan(1);
  return { lo: a, hi: b, center: (a + b) / 2, half: (b - a) / 2, dry: (b - a) < 0.4 };
}

// ── Height patches (elevated standable surfaces: platforms, ramps, bridges) ──
// addHeightPatch({ s0, s1, lat0, lat1, h0, h1, axis }) — rectangle in
// (s = theta·RF arc-length, lat). top interpolates h0→h1 along `axis` ('s'|'lat');
// constant when h0 === h1. Bucketed by s like colliders.js.
const _PATCH_BUCKETS = 256;
const _patchBucketArc = CIRCUMFERENCE / _PATCH_BUCKETS;
const _patchBuckets = Array.from({ length: _PATCH_BUCKETS }, () => []);
function _pBucketOf(s) { return ((Math.floor(s / _patchBucketArc) % _PATCH_BUCKETS) + _PATCH_BUCKETS) % _PATCH_BUCKETS; }
function addHeightPatch(rec) {
  rec._smin = Math.min(rec.s0, rec.s1);
  rec._smax = Math.max(rec.s0, rec.s1);
  rec._lmin = Math.min(rec.lat0, rec.lat1);
  rec._lmax = Math.max(rec.lat0, rec.lat1);
  if (rec.axis === undefined) rec.axis = (rec.h0 === rec.h1) ? 's' : 'lat';
  const b0 = _pBucketOf(rec._smin), b1 = _pBucketOf(rec._smax);
  let b = b0;
  for (;;) { _patchBuckets[b].push(rec); if (b === b1) break; b = (b + 1) % _PATCH_BUCKETS; }
  return rec;
}
// THE ground function. Standing height at (theta, lat), considering only patches
// whose interpolated top ≤ refH + 1.6 — so you WALK UNDER a high deck (low refH)
// but STAND ON it once you climbed its ramp (refH near the top).
function groundH(theta, lat, refH) {
  if (refH === undefined) refH = Infinity;
  let g = terrainH(theta, lat);
  let s = theta * RF;
  s = ((s % CIRCUMFERENCE) + CIRCUMFERENCE) % CIRCUMFERENCE;
  const b = _pBucketOf(s);
  const lim = refH + 1.6;
  for (let k = -1; k <= 1; k++) {
    const bucket = _patchBuckets[(b + k + _PATCH_BUCKETS) % _PATCH_BUCKETS];
    for (let j = 0; j < bucket.length; j++) {
      const rec = bucket[j];
      if (s < rec._smin || s > rec._smax || lat < rec._lmin || lat > rec._lmax) continue;
      let top;
      if (rec.h0 === rec.h1) top = rec.h0;
      else if (rec.axis === 's') top = rec.h0 + (rec.h1 - rec.h0) * _clamp01((s - rec.s0) / (rec.s1 - rec.s0));
      else top = rec.h0 + (rec.h1 - rec.h0) * _clamp01((lat - rec.lat0) / (rec.lat1 - rec.lat0));
      if (top <= lim && top > g) g = top;
    }
  }
  return g;
}

// Water depth at a point (0 on dry land). Used for wading/swimming and for
// tinting the water by depth.
function waterDepth(theta, lat) {
  // lakeSurf, not WATER_H: a lake stands at its own hollow's level, and wading
  // and swimming have to happen at the surface you can actually see.
  const d = lakeSurf(theta, lat) - terrainH(theta, lat);
  return d > 0 ? d : 0;
}
// Terrain gradient magnitude (rise per meter) — the walkable-slope test.
function terrainSlope(theta, lat) {
  const e = 1.2;
  const dS = (terrainH(theta + e / RF, lat) - terrainH(theta - e / RF, lat)) / (2 * e);
  const dL = (terrainH(theta, lat + e) - terrainH(theta, lat - e)) / (2 * e);
  return Math.hypot(dS, dL);
}

// ── Winding footpath lanes ──────────────────────────────────────────────────
// Each lane starts ON the road and meanders into the −lat housing belts, or
// runs along the +lat far bank. None of them cross the river — the designed
// RIVER_BRIDGES are the only crossings. laneSample(lane, t) → {theta, lat, yaw}.
function _cr(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
function _crD(p0, p1, p2, p3, t) {
  const t2 = t * t;
  return 0.5 * ((-p0 + p2) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * t + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * t2);
}
function laneSample(lane, t) {
  const p = lane.pts, n = p.length;
  if (n === 1) return { theta: p[0].theta, lat: p[0].lat, yaw: 0 };
  const ft = _clamp01(t) * (n - 1);
  let i = Math.floor(ft); if (i > n - 2) i = n - 2;
  const lt = ft - i;
  const p0 = p[i > 0 ? i - 1 : 0], p1 = p[i], p2 = p[i + 1], p3 = p[i < n - 2 ? i + 2 : n - 1];
  const th = _cr(p0.theta, p1.theta, p2.theta, p3.theta, lt);
  const la = _cr(p0.lat, p1.lat, p2.lat, p3.lat, lt);
  const dth = _crD(p0.theta, p1.theta, p2.theta, p3.theta, lt);
  const dla = _crD(p0.lat, p1.lat, p2.lat, p3.lat, lt);
  return { theta: th, lat: la, yaw: Math.atan2(dla, dth * RF) };
}

// A footpath has no business climbing the flank of a spur or wading a lake, and
// both arrived after the lanes were written. Walk the control point back toward
// the corridor the lane hangs off until it is on ground someone would use —
// which, at a spur, is exactly the notch the road or the guideway goes through.
function laneClear(theta, lat, bank) {
  const anchor = bank < 0 ? roadLat(theta) : railLatStatic(theta);
  let out = lat;
  for (let k = 0; k < 30; k++) {
    if (spurH(theta, out) < 2.0 && !inLake(theta, out, 2)) return out;
    const step = anchor - out;
    if (step > -0.05 && step < 0.05) break;
    out += step * 0.16 + (step > 0 ? 0.5 : -0.5);
  }
  return anchor + (bank < 0 ? -7 : 7);
}

const LANES = (function () {
  const lanes = [];
  const perKind = { houses: 4, farm: 3, park: 2, orchard: 2, market: 2, science: 2, industry: 2, plaza: 1, water: 2 };
  // Keep a lane on ONE bank: a lane rooted on the road (−lat) stays below the
  // river; a far-bank lane stays above it. Both keep 3 m off the water.
  const clampToBank = (theta, lat, bank) => {
    const rl = riverLat(theta), rh = riverHalf(theta);
    const l = bank < 0 ? Math.min(lat, rl - rh - 3.5) : Math.max(lat, rl + rh + 3.5);
    return laneClear(theta, l, bank);
  };
  for (const d of DISTRICTS) {
    const n = perKind[d.kind] ?? 2;
    let from = d.from, to = d.to; if (to <= from) to += 360;
    for (let li = 0; li < n; li++) {
      const rootDeg = from + (0.14 + 0.72 * _layRng()) * (to - from);
      const rootTheta = (((rootDeg % 360) + 360) % 360) * DEG;
      // two thirds of the lanes hang off the road; the rest thread the far bank
      const farBank = _layRng() < 0.34;
      const bank = farBank ? 1 : -1;
      const r0 = farBank ? railLat(rootTheta) - 4 : roadLat(rootTheta);
      const side = farBank ? (_layRng() < 0.5 ? 1 : -1) : (_layRng() < 0.66 ? -1 : 1);
      const reach = 16 + _layRng() * 22;
      const target = r0 + side * reach;
      const nseg = 5 + Math.floor(_layRng() * 4);      // 6..9 control points
      const pts = [{ theta: rootTheta, lat: clampToBank(rootTheta, r0, bank) }];
      let th = rootTheta;
      for (let k = 1; k <= nseg; k++) {
        const f = k / nseg;
        th += (2.5 + (_layRng() - 0.5) * 7) / RF;       // gentle +theta drift
        let la = r0 + (target - r0) * (f * f * (3 - 2 * f)) + Math.sin(f * Math.PI * 1.4) * (_layRng() - 0.5) * 11;
        la = _clamp(la, -(VALLEY_LAT + 2), VALLEY_LAT + 2);
        pts.push({ theta: th, lat: clampToBank(th, la, bank) });
      }
      if (_layRng() < 0.26) {                            // small cul-de-sac loop
        const end = pts[pts.length - 1];
        const cr = 3 + _layRng() * 2;
        for (let a = 1; a <= 4; a++) {
          const ang = a / 4 * Math.PI * 2;
          const th2 = end.theta + Math.cos(ang) * cr / RF;
          pts.push({ theta: th2, lat: clampToBank(th2, end.lat + Math.sin(ang) * cr, bank) });
        }
      }
      lanes.push({ pts, bank, bridge: [] });
    }
  }
  return lanes;
})();

// ── Build-time verification ─────────────────────────────────────────────────
// The whole point of the rewrite is that the three ribbons never overlap. Prove
// it numerically rather than trusting the algebra, and shout if it ever breaks.
const LAYOUT_CHECK = (function () {
  let worstRoad = Infinity, worstRoadDeg = 0;
  let worstRail = Infinity, worstRailDeg = 0;
  let worstRR = Infinity, worstRRDeg = 0;
  let maxLat = 0;
  for (let i = 0; i < 3600; i++) {
    const theta = (i / 3600) * Math.PI * 2;
    const rl = riverLat(theta), rh = riverHalf(theta);
    const ro = roadLat(theta), ra = railLat(theta);
    const roadClr = (rl - rh) - (ro + ROAD_HALF + ROAD_SHLDR);   // shoulder edge → water
    const railClr = (ra - 1.6) - (rl + rh);                      // water → guideway edge
    const rrClr = ra - ro;
    if (roadClr < worstRoad) { worstRoad = roadClr; worstRoadDeg = i / 10; }
    if (railClr < worstRail) { worstRail = railClr; worstRailDeg = i / 10; }
    if (rrClr < worstRR) { worstRR = rrClr; worstRRDeg = i / 10; }
    maxLat = Math.max(maxLat, Math.abs(ro), Math.abs(ra), Math.abs(rl) + rh);
  }
  // set-piece clearance: the hard "never in the water" clamp on roadLat can in
  // principle override an avoidance push, so check the result, don't assume it
  // Checked across each obstacle's FOOTPRINT, not at its centre-line. The
  // centre-line test passed happily while the road cut the corner off the
  // observatory 30 m further round the ring.
  const encroach = [];
  const sweep = (o, latFn, tag) => {
    const reach = (o.flat || 0) + 2;
    let worst = Infinity, worstDeg = 0;
    for (let s = -reach; s <= reach; s += 1.5) {
      const theta = o.thetaDeg * DEG + s / RF;
      const got = Math.abs(latFn(theta) - o.lat);
      if (got < worst) { worst = got; worstDeg = o.thetaDeg + (s / RF) / DEG; }
    }
    if (worst < o.minSep - 0.5) {
      encroach.push(`${tag}@${worstDeg.toFixed(1)}° ${worst.toFixed(1)}/${o.minSep}`);
    }
  };
  for (const o of ROAD_AVOID) sweep(o, roadLat, 'road');
  for (const o of RAIL_AVOID) sweep(o, railLat, 'rail');
  const r = {
    roadToWater: worstRoad, roadToWaterDeg: worstRoadDeg,
    waterToRail: worstRail, waterToRailDeg: worstRailDeg,
    roadToRail: worstRR, roadToRailDeg: worstRRDeg,
    maxLat, encroach,
  };
  if (typeof console !== 'undefined') {
    const ok = worstRoad > 0.5 && worstRail > 0.5 && worstRR > 18 && maxLat < FLOOR_LAT - 2;
    const msg = `[layout] road↔water ${worstRoad.toFixed(1)} m @${worstRoadDeg}°, ` +
                `water↔rail ${worstRail.toFixed(1)} m @${worstRailDeg}°, ` +
                `road↔rail ${worstRR.toFixed(1)} m @${worstRRDeg}°, max |lat| ${maxLat.toFixed(1)}`;
    if (ok) console.log(msg); else console.warn('[layout] SEPARATION VIOLATED — ' + msg);
    if (encroach.length) console.warn('[layout] set-piece clearance short: ' + encroach.join(', '));
  }
  return r;
})();

// Expose for playwright probes (harmless in the browser).
if (typeof window !== 'undefined') {
  window.__layout = {
    roadLat, roadYawAt, riverLat, riverHalf, riverDrawHalf, riverSep, railLat, railH,
    setRailDetours,
    STATIONS, terrainH, groundH, roadH, waterDepth, terrainSlope, sideProfile,
    FLAT_SPOTS, LANES, laneSample, addHeightPatch, CROSSINGS, TRIBS, RIVER_BRIDGES,
    ISLANDS, onIsland, KNOLLS, tribEdges, waterEdges, LAYOUT_CHECK,
    mountainH: _mountainH, CASCADE,
    SPURS, spurH, onSpur, ROAD_TUNNELS, RAIL_TUNNELS, inBore,
    LAKES, inLake, lakeU: _lakeU, lakeRim, lakePoint, lakeSurf, railLatStatic,
  };
}
