# HALCYON RING

**[▶ Play here](https://thomasbrueggemann.github.io/halcyon-ring/)**

A first-person browser game built with three.js: you live aboard a 1.9 km-diameter
**Stanford torus** cruising through space. The habitat's flywheel is failing — every
few minutes the ring stops spinning, gravity dies, and everything (including you)
floats. Walk, run, and drift the full 5.9 km circumference of the ring city to repair
five broken systems and stabilize the spin.

Everything is procedural — no downloaded assets. Terrain, city, vegetation, textures,
sky, and all audio are generated in code. three.js r160 is vendored in `lib/`, so the
game runs fully offline.

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
| E | Interact (valves, fuses, terminals) |
| **Zero-g** | WASD = thrusters (toward where you look), Space = climb, C = descend |
| Esc | Pause / release pointer |
| G | Sandbox: trigger a gravity failure immediately |

## The five repairs

Marked as amber dots on the ring minimap (bottom right); the plaza status terminal
gives hints. They deliberately drag you all the way around the ring:

1. **Coolant valves** — Engineering Bay (48°). Watch the indicator lamps blink a
   sequence, turn the four valves in that order.
2. **Power relay** — Agricultural Belt. Three glowing fuse cells sit under light
   beacons; carry them to the relay cabinet at 104°.
3. **Spoke phase alignment** — Gamma Terminal (180°). A timing minigame: hit the
   moving marker inside the green window three times.
4. **Observatory uplink** — the console at 272° wants a 4-digit code. Maintenance
   stenciled it on the water-tower tank back in Reservoir Flats (250°).
5. **Gyroscope calibration** — the panel sits 17 m up Spoke F (300°), reachable
   only while gravity is out. Wait for a failure, then float up to it.

Fix all five and the wheel stabilizes for good.

## How the world works

- The ring spins about the world Y axis at 1 rpm; spin gravity is
  `g = g₀·(ω/ω₀)²`, pointing radially outward. Player and props integrate in
  Cartesian space, then convert back to torus coordinates `(θ, lat, h)` for
  collision against the floor, the curved hull cross-section, and the city
  (`src/torusMath.js`, `src/player.js`, `src/colliders.js`).
- When the wheel spins down, the stars, sun, Earth, and Moon visibly stop
  wheeling past the glass ceiling — the sky group's rotation *is* the spin state
  (`src/sky.js`, `src/gravity.js`).
- The shell is a swept cross-section profile, 768 segments around: an opaque
  floor band plus a fully glazed hull — every wall and the ceiling is glass,
  framed by ribs and stringer rings (`src/world.js`).
- Districts (residential, farms, park, orchard, engineering, docks, market,
  observatory) are laid out by angle; houses, mid-rise city blocks, trees,
  grass, and streetlights are instanced meshes with per-instance color
  variation (`src/city.js`, `src/vegetation.js`). Downtown cores wrap the ring
  at Meridian Plaza, Gamma Terminal, and the Observatory Quarter; every
  building has procedurally lit windows (emissive maps).
- A full-circumference elevated monorail rings the city on the south side of
  the road, with two trains running opposite directions day and night
  (`src/transit.js`).
- All audio — ambience, klaxon, spin-down groan, footsteps, zero-g wind, chimes —
  is synthesized with WebAudio (`src/audio.js`).

Tuning constants (ring size, gravity, failure cadence, movement speeds) live in
`src/config.js`.
