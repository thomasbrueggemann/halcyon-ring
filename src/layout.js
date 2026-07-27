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
    if (last && Math.abs(arcDelta(last[last.length - 1].thetaDeg * DEG, o.thetaDeg * DEG)) < gapM) last.push(o);
    else clusters.push([o]);
  }
  return clusters;
}
function _buildRepulsion(baseFn, obstacles, passes = 40) {
  const clusters = _clusterObstacles(obstacles);
  const fixedTerms = [];   // multi-obstacle clusters, solved once, exactly
  const single = [];       // size-1 clusters, solved iteratively against each other
  for (const cluster of clusters) {
    if (cluster.length === 1) { single.push(cluster[0]); continue; }
    const thetaDeg = cluster.reduce((s, o) => s + o.thetaDeg, 0) / cluster.length;
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
    let best = base, bestD = 0;
    if (inForbidden(base)) {
      bestD = Infinity;
      const cands = [mg[0][0]];
      for (let i = 0; i < mg.length - 1; i++) cands.push(mg[i][1]);
      cands.push(mg[mg.length - 1][1]);
      for (const c of cands) { const d = Math.abs(c - base); if (d < bestD) { bestD = d; best = c; } }
    }
    const sigma = Math.max(...cluster.map(o => o.sigma));
    fixedTerms.push({ thetaDeg, sigma, amt: best - base });
  }

  const terms = single.map(o => ({ thetaDeg: o.thetaDeg, lat: o.lat, minSep: o.minSep, sigma: o.sigma, amt: 0 }));
  const totalExcl = (theta, excludeIdx) => {
    let v = baseFn(theta);
    for (const t of fixedTerms) v += t.amt * _gaussArc(theta, t.thetaDeg, t.sigma);
    for (let j = 0; j < terms.length; j++) {
      if (j === excludeIdx) continue;
      const t = terms[j];
      if (t.amt) v += t.amt * _gaussArc(theta, t.thetaDeg, t.sigma);
    }
    return v;
  };
  // Damped Gauss-Seidel for the (well-separated) singletons — under-relaxation
  // (0.5) trades convergence speed for stability against neighbours that are
  // close enough to interact but not close enough to need full clustering.
  const RELAX = 0.5;
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < terms.length; i++) {
      const t = terms[i];
      const theta = t.thetaDeg * DEG;
      const diff = totalExcl(theta, i) - t.lat;
      const sign = diff >= 0 ? 1 : -1;
      const target = sign * Math.max(0, t.minSep - Math.abs(diff));
      t.amt = t.amt + RELAX * (target - t.amt);
    }
  }
  for (let i = 0; i < terms.length; i++) {
    const t = terms[i];
    const theta = t.thetaDeg * DEG;
    const diff = totalExcl(theta, i) - t.lat;
    const sign = diff >= 0 ? 1 : -1;
    t.amt = sign * Math.max(0, t.minSep - Math.abs(diff));
  }
  return fixedTerms.concat(terms.map(t => ({ thetaDeg: t.thetaDeg, sigma: t.sigma, amt: t.amt })));
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
    const s = t.thetaDeg * DEG * RF, reach = 4 * t.sigma;
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
    sum += t.amt * _gaussArc(theta, t.thetaDeg, t.sigma);
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
const CASCADE_DEG = 212;         // where the waterfall comes off the +lat rim

// ── Periodic ridged value-noise ─────────────────────────────────────────────
// Harmonics alone give a mountain ONE shape repeated round the ring; peaks need
// noise. This lattice wraps at `cells` in the arc direction, so it is exactly
// 2π-periodic (no seam at θ = 0) while still being aperiodic to the eye.
function _mtnHash(ix, iy) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263);
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
function _mtnFoot(theta, side) {
  const p = side > 0 ? 0 : 1.9;
  const f = MTN_LAT0 + 5.0
    + 4.6 * Math.sin(theta + 0.31 + p)
    + 3.4 * Math.sin(2 * theta + 2.74 + p)
    + 2.2 * Math.sin(3 * theta + 5.52 + p)
    + 1.4 * Math.sin(6 * theta + 1.13 + p);
  return f < MTN_LAT0 - 2 ? MTN_LAT0 - 2 : f;
}
// Crest height, per side (different phases so the two rims are not mirrors).
function _mtnAmp(theta, side) {
  const p = side > 0 ? 0 : 2.13;
  const a = 33
    + 12.0 * Math.sin(theta + 0.72 + p)
    +  8.5 * Math.sin(2 * theta + 2.31 + p)
    +  5.4 * Math.sin(3 * theta + 5.14 + p)
    +  3.6 * Math.sin(5 * theta + 1.20 + p);
  return a < 9 ? 9 : a;
}
// The two named high ranges. Kept OUT of _mtnAmp because that term is scaled by
// the fBm, and a col landing on the Cascade would have quietly halved the
// waterfall. These are mostly added straight, so the massifs are guaranteed.
function _mtnMassif(theta) {
  return 34.0 * _gaussArc(theta, CASCADE_DEG, 240)    // the massif the falls come off
       + 18.0 * _gaussArc(theta, 118, 190);           // the range above the farms
}
// Relief on the face. Folding a sine through |·| turns a smooth dune into a
// spine with a sharp crest and V-gullies between the spurs; the lat-modulated
// terms then break those spurs into buttresses and hanging shelves, so the face
// has depth from any angle instead of reading as vertical corduroy.
function _mtnCrag(theta, lat, side) {
  const p = side > 0 ? 0 : 1.37;
  const r1 = 1 - Math.abs(Math.sin(6 * theta + p));
  const r2 = 1 - Math.abs(Math.sin(11 * theta + 2.2 + p));
  const r3 = 1 - Math.abs(Math.sin(19 * theta + 4.4 + p));
  const r4 = 1 - Math.abs(Math.sin(37 * theta + 0.9 + p));
  const gully = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(lat * 0.20 + p));
  return (r1 * 11.0 + r2 * 6.0 + r3 * 3.2 + r4 * 1.6) * gully
       + 6.0 * Math.sin(3 * theta + 1.10 + p) * Math.cos(lat * 0.14 + 0.60)
       + 3.2 * Math.sin(9 * theta + 3.70 + p) * Math.sin(lat * 0.23 + 2.10)
       + 1.8 * Math.sin(17 * theta + 5.20 + p) * Math.cos(lat * 0.35 + 1.30);
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
function _riverHarm(theta) {
  return 6.2 * Math.sin(theta + 3.503)
       + 4.4 * Math.sin(2 * theta + 3.935)
       + 2.6 * Math.sin(3 * theta + 4.240)
       + 1.2 * Math.sin(5 * theta + 1.940)
       + 1.6 * Math.sin(8 * theta + 6.110)
       + 1.3 * Math.sin(10 * theta + 3.686)
       + 1.0 * Math.sin(12 * theta + 4.449)
       + 0.8 * Math.sin(14 * theta + 2.678);   // Σ|A| = 19.1, measured peaks ≈ ±13
}
function _halfUnit(theta) { return 0.60 * Math.sin(2 * theta + 0.40) + 0.40 * Math.sin(3 * theta + 2.60); }
// Channel half-width: a modest stream most of the way round, opening into the
// Reservoir Flats lake (~240°), Solace Park's pond (~73°), the Orchards
// mill-pond (~160°) and the Dock Annex marina inlet (~305°).
// The lake is deliberately centred at 233° rather than mid-district: the spoke
// shaft at 240° has to stay dry, and a bulge sitting on top of it would force
// the whole reservoir out to one side of the valley to clear it.
function _riverHalfCore(theta) {
  return 5.6 + 2.2 * _halfUnit(theta)
       + 11.0 * _gaussArc(theta, 233, 40)
       + 4.5  * _gaussArc(theta, 73, 30)
       + 3.2  * _gaussArc(theta, 160, 22)
       + 2.8  * _gaussArc(theta, 305, 20);
}

// ── Bank gaps: water's edge → road centerline, water's edge → guideway ──────
// Independent phases so the two banks breathe out of step with each other.
function _roadGapBase(theta) {
  return 13.5 + 6.0 * (0.55 * Math.sin(theta + 1.10)
                     + 0.28 * Math.sin(3 * theta + 4.72)
                     + 0.17 * Math.sin(7 * theta + 2.21));
}
function _railGapBase(theta) {
  return 15.0 + 6.5 * (0.50 * Math.sin(2 * theta + 5.24)
                     + 0.30 * Math.sin(theta + 0.41)
                     + 0.20 * Math.sin(5 * theta + 3.11));
}
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
  sigma: Math.max(22, f.r + f.feather + 10),
})).concat([{
  thetaDeg: PLAZA_THETA / DEG, lat: 0,
  minSep: _riverHalfCore(PLAZA_THETA) + 7.0,
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
const _L = { theta: NaN, riverHalf: 0, riverLat: 0, roadLat: NaN };
function _prime(theta) {
  if (theta !== _L.theta) {
    _L.riverHalf = _riverHalfCore(theta);
    _L.riverLat = _riverLatCore(theta);
    _L.roadLat = NaN;
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
const ROAD_AVOID = [
  ...[0, 60, 120, 180, 240, 300].map(d => ({ thetaDeg: d, lat: 0, minSep: 13, sigma: 15 })),
  { thetaDeg: 48,  lat: -18, minSep: 8.0,  sigma: 16 },  // coolant valve panel
  { thetaDeg: 104, lat: -9,  minSep: 8.1,  sigma: 12 },  // power relay cabinet
  { thetaDeg: 250, lat: -28, minSep: 11.4, sigma: 18 },  // water tower
  { thetaDeg: 272, lat: -30, minSep: 15.6, sigma: 22 },  // observatory
  { thetaDeg: 8.2, lat: -34, minSep: 14.6, sigma: 26 },  // civic hall
  { thetaDeg: 321, lat: -30, minSep: 14.5, sigma: 18 },  // dock warehouse 0
  { thetaDeg: 337, lat: -30, minSep: 14.5, sigma: 18 },  // dock warehouse 2
  // The road's lat is no longer anywhere near where it used to be, so every
  // fixed −lat set-piece has to be declared here or the carriageway drives
  // straight through it. These are the ones a ring sweep found it hitting.
  // minSep = the obstacle's own lat half-extent + ROAD_HALF + ROAD_SHLDR + 1 m
  { thetaDeg: 44,  lat: -36, minSep: 10.0, sigma: 18 },  // coolant tank 0
  { thetaDeg: 47,  lat: -36, minSep: 10.0, sigma: 18 },  // coolant tank 1
  { thetaDeg: 50,  lat: -36, minSep: 10.0, sigma: 18 },  // coolant tank 2
  { thetaDeg: 95,  lat: -40, minSep: 11.0, sigma: 20 },  // greenhouse 0
  { thetaDeg: 113, lat: -40, minSep: 11.0, sigma: 20 },  // greenhouse 2
  { thetaDeg: 113.4, lat: -35.4, minSep: 7.0, sigma: 14 }, // greenhouse fuse cell
];
function _roadBase(theta) {
  const L = _prime(theta);
  return L.riverLat - L.riverHalf - Math.max(ROAD_GAP_MIN, _roadGapBase(theta));
}
const _roadAvoidBuckets = _indexRepulsion(_buildRepulsion(_roadBase, ROAD_AVOID));
const ROAD_LAT_MIN = -VALLEY_LAT;              // stay out of the mountain rim
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
  ...[0, 60, 120, 180, 240, 300].map(d => ({ thetaDeg: d, lat: 0, minSep: 13, sigma: 15 })),
  // minSep = the obstacle's own lat half-extent + the guideway half-width + a
  // 2 m margin. The deck rides ~7 m up, so only a genuine lateral overlap
  // matters — being generous here just shoves the guideway into the hillside.
  { thetaDeg: 122,   lat: 34, minSep: 11.0, sigma: 20 },  // barn
  { thetaDeg: 124.5, lat: 40, minSep: 9.0,  sigma: 16 },  // silo
  { thetaDeg: 329,   lat: 30, minSep: 11.0, sigma: 24 },  // dock warehouse 1
  { thetaDeg: 345,   lat: 30, minSep: 11.0, sigma: 24 },  // dock warehouse 3
];
function _railBase(theta) {
  const L = _prime(theta);
  return L.riverLat + L.riverHalf + Math.max(RAIL_GAP_MIN, _railGapBase(theta));
}
const _railAvoidBuckets = _indexRepulsion(_buildRepulsion(_railBase, RAIL_AVOID));
function railLat(theta) {
  let lat = _railBase(theta) + _applyRepulsion(theta, _railAvoidBuckets);
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
  return ground + clear;
}

// ── Hillside tributaries ────────────────────────────────────────────────────
// Small streams that come down off the −lat hillside, pass under the ring road
// through a culvert, and join the river. Nine of them, spaced round the ring
// away from the stations and the big set-pieces. Each is a straight run in
// (arc-length, lat) space; the carve is masked out inside the road corridor so
// the roadway itself stays intact and the stream reads as running under it.
const TRIBS = (function () {
  const degs = [26, 57, 91, 135, 166, 205, 232, 289, 314];
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
  .map(deg => deg * DEG)
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
const ISLANDS = [
  { thetaDeg: 230, dLat: -6.0, r: 11, h: 3.1 },
  { thetaDeg: 238, dLat: 6.5,  r: 9,  h: 2.6 },
  { thetaDeg: 160, dLat: 3.5,  r: 6,  h: 2.0 },
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

// ── Terrain ─────────────────────────────────────────────────────────────────
function _hills(theta, lat) {
  return 1.55 * Math.sin(2 * theta + 4.10) * Math.cos(0.030 * lat + 0.70)
       + 1.20 * Math.sin(3 * theta + 0.60) * Math.sin(0.055 * lat + 0.40)
       + 0.90 * Math.sin(5 * theta + 2.30) * Math.cos(0.070 * lat + 1.10)
       + 0.66 * Math.cos(7 * theta + 0.90) * Math.sin(0.050 * lat)
       + 0.48 * Math.sin(11 * theta + 3.30) * Math.sin(0.160 * lat + 2.20)
       + 0.30 * Math.sin(17 * theta + 1.15) * Math.cos(0.210 * lat + 0.30)
       + 0.20 * Math.sin(23 * theta + 5.05) * Math.cos(0.310 * lat + 1.80)
       + 0.13 * Math.sin(31 * theta + 2.40) * Math.sin(0.430 * lat + 0.95);  // Σ|A| = 5.42
}

const FLOODPLAIN = 1.65;   // general land level above the h = 0 datum

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

  let h = sideProfile(lat) + _mountainH(theta, lat);
  let soil = FLOODPLAIN;
  soil += _hills(theta, lat) * _smooth(rh + 2, rh + 26, u);   // no bumps inside the channel
  soil -= 0.9 * (1 - _smooth(rh + 3, rh + 40, u));            // land tips gently toward the water
  soil += _tribCarve(theta, lat) * (1 - _roadCorridor(theta, lat));
  h += soil * edgeFade;

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
  h += _islandBump(theta, lat) + _knollBump(theta, lat) * edgeFade;
  return _cascadeCarve(theta, lat, h);
}

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
  if (dRoad < ROAD_HALF + ROAD_SHLDR + 15) {
    // a long batter, not a sheer face: cuttings can be 4-5 m deep where the
    // smoothed grade runs across a rising hillside
    const w = 1 - _smooth(ROAD_HALF + ROAD_SHLDR + 1.0, ROAD_HALF + ROAD_SHLDR + 15, dRoad);
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
  const d = WATER_H - terrainH(theta, lat);
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

const LANES = (function () {
  const lanes = [];
  const perKind = { houses: 4, farm: 3, park: 2, orchard: 2, market: 2, science: 2, industry: 2, plaza: 1, water: 2 };
  // Keep a lane on ONE bank: a lane rooted on the road (−lat) stays below the
  // river; a far-bank lane stays above it. Both keep 3 m off the water.
  const clampToBank = (theta, lat, bank) => {
    const rl = riverLat(theta), rh = riverHalf(theta);
    if (bank < 0) return Math.min(lat, rl - rh - 3.5);
    return Math.max(lat, rl + rh + 3.5);
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
  const encroach = [];
  for (const o of ROAD_AVOID) {
    const theta = o.thetaDeg * DEG;
    const got = Math.abs(roadLat(theta) - o.lat);
    if (got < o.minSep - 0.5) encroach.push(`road@${o.thetaDeg}° ${got.toFixed(1)}/${o.minSep}`);
  }
  for (const o of RAIL_AVOID) {
    const theta = o.thetaDeg * DEG;
    const got = Math.abs(railLat(theta) - o.lat);
    if (got < o.minSep - 0.5) encroach.push(`rail@${o.thetaDeg}° ${got.toFixed(1)}/${o.minSep}`);
  }
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
    STATIONS, terrainH, groundH, roadH, waterDepth, terrainSlope, sideProfile,
    FLAT_SPOTS, LANES, laneSample, addHeightPatch, CROSSINGS, TRIBS, RIVER_BRIDGES,
    ISLANDS, onIsland, KNOLLS, tribEdges, waterEdges, LAYOUT_CHECK,
    mountainH: _mountainH, CASCADE,
  };
}
