# HALCYON RING

**[▶ Play here](https://thomasbrueggemann.github.io/halcyon-ring/)**

A first-person browser game built with three.js: you live aboard a 1.9 km-diameter
**Stanford torus** cruising through space. The habitat's flywheel is failing — every
few minutes the ring stops spinning, gravity dies, and everything (including you)
floats. Walk, run, and drift the full 5.9 km circumference of the ring city to repair
five broken systems and stabilize the spin.

Everything is procedural — no downloaded assets. Terrain, city, vegetation, textures,
sky, and all audio are generated in code. Every material is a full PBR set built
from one height field: meadow with clover drifts and wildflowers, rock with moss,
lichen and quartz veins, bevelled flagstone paving, stucco / clapboard / brick
house walls with genuinely recessed windows, pantile and slate roofs whose courses
catch the light, furrowed bark, and riveted, scuffed, rusting painted steel for the
engineering set-pieces. The lighting uses a painted equirectangular environment run
through PMREM for image-based specular. three.js r160 is vendored in `lib/`, so the game runs fully offline.

**Every session generates a different ring.** The river's meander, the road and
guideway that hang off it, the rolling hills, the mountain rim, where the waterfall
comes down, the knolls, the lanes, the buildings and the planting are all drawn from
one world seed. The seed is printed on the title screen and to the console; add
`?seed=12345` to the URL to replay an exact ring.

## Run it

Just open `index.html` in a browser — no server, no build step, no npm/node
required. `src/*.js` are loaded directly as classic scripts (not ES modules,
which browsers refuse to `import` from `file://`), in dependency order, and
attach their classes/functions to the shared global scope.

## Developing

Edit any file in `src/`, then reopen (or refresh) `index.html` — that's it.
If you add a new file, add a matching `<script src="src/....js">` tag in
`index.html`, positioned after anything it depends on and before anything
that depends on it.

## Controls

| Input | Action |
|---|---|
| Mouse | Look (click once to capture the pointer) |
| WASD | Move |
| Shift | Run |
| Space | Jump |
| E | Interact (valves, fuses, terminals, board/leave trains) |
| Tab | Switch which repair the compass is tracking |
| — | Platform boards show the live countdown to the next train in each direction |
| **Zero-g** | WASD = thrusters (toward where you look), Space = climb, C = descend |
| **In water** | wading slows you; past chest depth you swim, Space to rise |
| Esc | Pause / release pointer |
| G | Sandbox: trigger a gravity failure immediately |

## Finding your way

A **compass strip** under the status bar points at the tracked repair's *current
step* — the next fuse cell, the second half of a code, the next beacon — with
the distance and the height difference, and a diamond marker floats over the
spot in the world. Tab cycles which repair you are following; the objective
list (top left) and the minimap ring (bottom right, with the trains moving on
it) mark all five. The status bar also counts down to the **next gravity
fault**, and while you are weightless, to the spin coming back — worth watching
before you commit to something 40 m up.

## The five repairs

They deliberately drag you all the way around the ring, and each one is a
different kind of problem:

1. **Coolant loop** — Engineering Bay (48°). Four valves under a live pressure
   board. Each valve feeds two gauges (its own and the next one along), every
   valve has four positions, and the board shows where every needle sits
   against its green band — so it is a coupled-balance puzzle you can read
   your way through, not a memory test.
2. **Power relay** — Agricultural Belt. Three glowing fuse cells sit under light
   beacons; carry them to the relay cabinet at 104°. Seating them opens the
   relay grid: rotate the pipe tiles (click, or arrows + Space) until power
   crosses from the live bus to the far one. Every grid is scrambled from a
   real solution, so it always goes.
3. **Spoke phase lock** — Gamma Terminal (180°). An oscilloscope with the
   spoke's own waveform on it. Tune frequency (W/S), phase (A/D) and later
   amplitude (R/F) until your trace overlays it and hold the coherence above
   the threshold; three stages, the last with a tighter window.
4. **Observatory uplink** — the console at 272° wants a 4-digit code that
   maintenance split in two: digits 1–2 are stenciled on the water-tower tank
   in Reservoir Flats (250°), digits 3–4 on the pump station across the river.
   The code only opens the dish: sweep azimuth and elevation for the carrier by
   the tick rate and the signal bar, hold it to lock, then track it when it
   drifts.
5. **Gyroscope calibration** — Spoke F (300°). Three reference beacons hang up
   the shaft at 11, 25 and 39 m. Wait for a failure, fly through them in order
   while weightless, then true the panel at 17 m — all before the spin comes
   back, or the course resets.

Fix all five and the wheel stabilizes for good. The shift report at the end
grades the run (S/A/B/C by time) and tallies distance walked, failures
survived, time in free fall, train rides, and how many repairs went through
without a reset. The faults themselves get more frequent the longer the shift
runs, so the pressure climbs.

## How the world works

- The ring spins about the world Y axis at 1 rpm; spin gravity is
  `g = g₀·(ω/ω₀)²`, pointing radially outward. Player and props integrate in
  Cartesian space, then convert back to torus coordinates `(θ, lat, h)` for
  collision against the floor, the curved hull cross-section, and the city
  (`src/torusMath.js`, `src/player.js`, `src/colliders.js`).
- When the wheel spins down, the stars, sun, Earth, and Moon visibly stop
  wheeling past the glass ceiling — the sky group's rotation *is* the spin state
  (`src/sky.js`, `src/gravity.js`).
- The tube is 190 m across, and deliberately not all valley. Inside ±52 m is the
  settled floor — road, river, guideway, houses, farms. Beyond it the ground
  climbs into a **rocky mountain rim** that runs the whole ring on both sides:
  ridged fBm over seeded harmonics, crests 20–90 m, bare rock above the tree
  line, pale snow on the high crags, erratics and scree fans on the slopes for
  scale. The far face then comes back down to meet the glazing, and the
  terrain's outermost ring of vertices sits exactly on the hull, so there is no
  seam between land and glass (`_mountainH` in `src/layout.js`, `src/world.js`).
- **The Cascade.** A gorge is cut into the inner face of the +lat rim — a hanging
  tarn on the crest, a 25–60 m sheer fall off the lip, a plunge basin at the toe,
  and an outflow stream that meanders down across the fields, under the guideway,
  into the river. The falling sheet, the pool and the mist are all derived from
  the same course the rock is carved to, so the water and the ground are the same
  shape by construction. Its position is drawn per world, clear of the stations
  and the spokes.
- **The valley has one shape, and everything hangs off it.** The three long
  ribbons are not three independent curves — they are the river plus two signed
  offsets, so they can never overlap:

  ```
  hull ‖ hillside │ ROAD │ bank │≈≈ RIVER ≈≈│ bank │ far bank │ RAIL │ hill ‖ hull
       ←───────────────── −lat ──────── 0 ──────── +lat ─────────────────→
  ```

  `roadLat = riverLat − riverHalf − roadGap`, `railLat = riverLat + riverHalf +
  railGap`. Both gaps breathe independently (8→20 m) so the ribbons visibly
  converge and diverge, but the ordering never changes. Crossings exist only
  where they are built: eight arched river bridges, and culverts where nine
  hillside tributaries pass under the road. A build-time sweep verifies the
  separations and logs `[layout] road↔water … water↔rail … road↔rail …` to the
  console.
- The road is cut and filled to a *smoothed* grade rather than draped on the
  ground, so it stays well under 15% even where it wanders across a rising
  hillside; the difference between the raw landscape and that grade becomes the
  cuttings and embankments beside it. It is built from a real cross-section —
  cambered carriageway, kerbs, gravel shoulders, painted lane markings.
- Water is a depth-shaded animated surface: two ripple normal maps drifting
  against each other, colour graded from turquoise shallows to deep green, and
  a foam line exactly at the shoreline — which is exact because the channel bed
  is carved to meet the water plane at the drawn edge.
- Terrain is splat-mapped: meadow, rock and river shingle blended per-vertex by
  slope, altitude and distance to the real waterline, with baked concavity
  shading and a detail octave that kills the macro tiling any single ground
  texture shows across 5.9 km.
- Districts (residential, farms, park, orchard, engineering, docks, market,
  observatory) are laid out by angle; houses cluster densely at odd angles
  along the winding road and lanes, with courtyard clusters, hillside
  cottages, and mid-rise downtown cores that follow the road's curve — all
  instanced meshes with per-instance color variation (`src/city.js`,
  `src/vegetation.js`). Every building has procedurally lit windows.
- A full-circumference elevated monorail runs the far (+lat) bank on pylons:
  **six trains**, three each way, so a train calls at any given platform roughly
  every 50 seconds. Each platform carries a live **departure board** showing the
  wall-clock time and a counting-down ETA for the next train in each direction —
  solved from the trains' actual speed profile, not faked, so it is accurate to
  a couple of seconds and reads 0:00 exactly when a train is standing there.
  Walk up the ramp, board with E while the doors are open, watch the next stop
  and its ETA on the HUD, and step off at whichever station you like — or hop
  off mid-journey and inherit the train's velocity (`src/transit.js`).
- Movement respects the new relief: you step over kerbs and deck lips, slide
  back down slopes steeper than about 32°, wade (slowly) through shallow water
  and swim once it is over chest depth (`src/player.js`).
- The ring is inhabited: ~120 people stroll the lanes, chat, and idle at the
  plaza and market, with dogs, cats, ducks on the river, and birds overhead
  (`src/npcs.js`).
- **When the wheel stalls, everything unsecured lifts off the floor together.**
  People, dogs, cats, ducks, crates, barrels, planters — and the river, which
  peels off the surface as hundreds of wobbling globules trailing spray
  (`src/hydro.js`). They rise at a slow, steady drift rather than being launched,
  tumbling and colliding, filling the volume of the tube for the length of the
  failure; then the lift lets go slowly as spin returns and the whole population
  comes down, crumples, and picks itself up. You go up with them. The birds
  ignore the whole thing.
- All audio — ambience, klaxon, spin-down groan, footsteps, zero-g wind, chimes —
  is synthesized with WebAudio (`src/audio.js`).

Tuning constants (ring size, gravity, failure cadence, movement speeds) live in
`src/config.js`.
