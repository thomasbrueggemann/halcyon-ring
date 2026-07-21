// ── HALCYON RING — global configuration ─────────────────────────────────────
// Torus geometry (meters). The ring spins about the world Y axis.
// "Floor" is the outermost habitable band of the tube; spin gravity points
// radially outward from the spin axis (i.e. from the axis toward the floor).

const RT   = 70;                    // tube (minor) radius
const HALF_W = 55;                  // half-width of the flat floor chord
const CHORD_DROP = Math.sqrt(RT * RT - HALF_W * HALF_W); // tube center → floor
const RF   = 940;                   // cylindrical radius of the floor
const RMAJ = RF - CHORD_DROP;       // cylindrical radius of tube center
const CIRCUMFERENCE = 2 * Math.PI * RF;   // ≈ 5.9 km of walkable ring

// Spin / gravity
const FULL_SPIN = 2 * Math.PI / 60;  // 1 rpm — classic Stanford torus
const G_FULL = 9.2;                  // m/s² at the floor when at full spin

// Player
const EYE_HEIGHT   = 1.62;
const WALK_SPEED   = 5.2;
const RUN_SPEED    = 9.5;
const JUMP_SPEED   = 4.6;
const THRUST_ACCEL = 7.5;            // zero-g maneuvering thrusters
const MOUSE_SENS   = 0.0022;

// Gravity-failure event cadence (seconds)
const FIRST_FAILURE_AT = 75;
const FAILURE_DURATION = 42;
const FAILURE_INTERVAL_MIN = 105;
const FAILURE_INTERVAL_MAX = 165;
const SPIN_DOWN_TIME = 7;
const SPIN_UP_TIME   = 10;

// Deterministic world seed
const WORLD_SEED = 20930417;

const DEG = Math.PI / 180;

// Spokes connect the ring to the hub every 60°
const SPOKE_THETAS = [0, 60, 120, 180, 240, 300].map(d => d * DEG);

// ── District map (angles in degrees around the ring) ────────────────────────
const DISTRICTS = [
  { name: 'Meridian Plaza',     from: 350, to:  12, kind: 'plaza'   },
  { name: 'East Residential',   from:  12, to:  40, kind: 'houses'  },
  { name: 'Engineering Bay',    from:  40, to:  58, kind: 'industry'},
  { name: 'Solace Park',        from:  58, to:  88, kind: 'park'    },
  { name: 'Agricultural Belt',  from:  88, to: 130, kind: 'farm'    },
  { name: 'North Residential',  from: 130, to: 168, kind: 'houses'  },
  { name: 'Gamma Terminal',     from: 168, to: 192, kind: 'market'  },
  { name: 'The Orchards',       from: 192, to: 230, kind: 'orchard' },
  { name: 'Reservoir Flats',    from: 230, to: 260, kind: 'water'   },
  { name: 'Observatory Quarter',from: 260, to: 286, kind: 'science' },
  { name: 'West Residential',   from: 286, to: 316, kind: 'houses'  },
  { name: 'Dock Annex',         from: 316, to: 350, kind: 'industry'},
];

function districtAt(thetaDeg) {
  const t = ((thetaDeg % 360) + 360) % 360;
  for (const d of DISTRICTS) {
    if (d.from > d.to) { if (t >= d.from || t < d.to) return d; }
    else if (t >= d.from && t < d.to) return d;
  }
  return DISTRICTS[0];
}
