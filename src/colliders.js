// ── Static collision registry in torus-floor coordinates ────────────────────
// Obstacles live in the (s, lat) plane where s = theta * RF is arc length.
// Boxes are axis-aligned in that plane; cylinders are radial.

const BUCKETS = 256;
const bucketArc = CIRCUMFERENCE / BUCKETS;

class Colliders {
  constructor() {
    this.buckets = Array.from({ length: BUCKETS }, () => []);
  }

  _bucketOf(s) {
    return ((Math.floor(s / bucketArc) % BUCKETS) + BUCKETS) % BUCKETS;
  }

  _register(entry, s, extent) {
    const b0 = this._bucketOf(s - extent - 2);
    const b1 = this._bucketOf(s + extent + 2);
    let b = b0;
    for (;;) {
      this.buckets[b].push(entry);
      if (b === b1) break;
      b = (b + 1) % BUCKETS;
    }
  }

  // Axis-aligned box: center theta/lat, halfArc along ring, halfLat across,
  // height above the ground at the obstacle's base. `base` = groundH at its
  // center, so `top` = base + height and the box blocks only up to its top.
  addBox(theta, lat, halfArc, halfLat, height) {
    const s = ((theta * RF) % CIRCUMFERENCE + CIRCUMFERENCE) % CIRCUMFERENCE;
    const base = (typeof groundH === 'function') ? groundH(theta, lat, Infinity) : 0;
    this._register({ kind: 'box', s, lat, halfArc, halfLat, height, base, top: base + height }, s, halfArc);
  }

  addCylinder(theta, lat, radius, height) {
    const s = ((theta * RF) % CIRCUMFERENCE + CIRCUMFERENCE) % CIRCUMFERENCE;
    const base = (typeof groundH === 'function') ? groundH(theta, lat, Infinity) : 0;
    this._register({ kind: 'cyl', s, lat, radius, height, base, top: base + height }, s, radius);
  }

  // Push a circle of `radius` at (s, lat, h) out of all nearby obstacles.
  // Returns {ds, dlat} displacement, or null when free.
  //
  // Resolution is iterated: a single pass sums every obstacle's independent
  // minimum-translation vector, which over-shoots badly in a corner (both walls
  // push you the full penetration depth at once) and can leave you inside a
  // third obstacle you were pushed into. Re-testing from the corrected position
  // a few times converges instead.
  resolve(s, lat, h, radius) {
    let curS = ((s % CIRCUMFERENCE) + CIRCUMFERENCE) % CIRCUMFERENCE;
    let curL = lat;
    let totS = 0, totL = 0, any = false;
    for (let iter = 0; iter < 3; iter++) {
      const b = this._bucketOf(curS);
      let ds = 0, dlat = 0, hit = false;
      for (let k = -1; k <= 1; k++) {
        const bucket = this.buckets[(b + k + BUCKETS) % BUCKETS];
        for (const e of bucket) {
          if (h > e.top) continue;   // above the obstacle: walk over it (roofs, decks)
          let dS = curS - e.s;
          if (dS > CIRCUMFERENCE / 2) dS -= CIRCUMFERENCE;
          if (dS < -CIRCUMFERENCE / 2) dS += CIRCUMFERENCE;
          const dL = curL - e.lat;
          if (e.kind === 'box') {
            const px = e.halfArc + radius - Math.abs(dS);
            const py = e.halfLat + radius - Math.abs(dL);
            if (px > 0 && py > 0) {
              hit = true;
              if (px < py) ds += (dS >= 0 ? px : -px);
              else dlat += (dL >= 0 ? py : -py);
            }
          } else {
            const dist = Math.hypot(dS, dL);
            const pen = e.radius + radius - dist;
            if (pen > 0) {
              hit = true;
              if (dist > 1e-5) { ds += (dS / dist) * pen; dlat += (dL / dist) * pen; }
              else ds += pen;
            }
          }
        }
      }
      if (!hit) break;
      any = true;
      curS += ds; curL += dlat;
      totS += ds; totL += dlat;
      if (Math.abs(ds) + Math.abs(dlat) < 1e-4) break;
    }
    return any ? { ds: totS, dlat: totL } : null;
  }
}
