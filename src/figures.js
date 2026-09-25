// ── figures.js — articulated, GPU-animated people and animals ──────────────
// Loaded right BEFORE npcs.js. Every figure is ONE merged mesh whose vertices
// carry a bone id and a material region (attribute aRig). The pose — walk
// cycle, idle weight-shift, chatting gestures, sitting, zero-g flailing — is
// computed per vertex in the shader from a handful of per-instance numbers
// (aAnim), so a whole population is still one draw call per species and the
// CPU only writes 4 floats per agent per frame.
//
// Conventions: figures face local −Z (the direction a yaw of atan2(dlat, darc)
// points in the torus frame), +Y is up, and the geometry is centred on the
// agent's mass centre (feet at −half) so tumbling rotates about the middle.
//
// Region colours live in per-instance attributes (skin / top / bottom / hair)
// and are resolved in the vertex shader; optional parts (skirt, long hair, bun)
// are collapsed to a point when an instance does not wear them.

// ── geometry helpers ────────────────────────────────────────────────────────
function _figTag(geo, fn) {
  // fn(x, y, z) → [bone, region]; tagged per vertex so one lathe can span bones
  const pos = geo.attributes.position;
  const rig = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const r = fn(pos.getX(i), pos.getY(i), pos.getZ(i));
    rig[i * 2] = r[0]; rig[i * 2 + 1] = r[1];
  }
  geo.setAttribute('aRig', new THREE.BufferAttribute(rig, 2));
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  return geo;
}
function _figPart(geo, bone, region) { return _figTag(geo, () => [bone, region]); }

// Tapered, capped limb from p0 to p1 (radius r0 → r1, optional mid bulge).
const _figUp = new THREE.Vector3(0, 1, 0);
function _figLimb(p0, p1, r0, r1, { bulge = 0, radial = 9, rows = 6, sx = 1, sz = 1, bulgeAt = 0.5 } = {}) {
  const a = new THREE.Vector3(...p0), b = new THREE.Vector3(...p1);
  const dir = b.clone().sub(a); const L = dir.length(); dir.normalize();
  const pts = [];
  const CAP = 3;
  for (let i = 0; i <= CAP; i++) {                     // start cap (pole → rim)
    const t = (i / CAP) * Math.PI / 2;
    pts.push(new THREE.Vector2(Math.max(1e-4, r0 * Math.sin(t)), -r0 * 0.6 * Math.cos(t)));
  }
  for (let i = 1; i < rows; i++) {
    const t = i / rows;
    const bl = bulge * Math.sin(Math.PI * Math.min(1, t / (2 * bulgeAt)) );
    pts.push(new THREE.Vector2(r0 + (r1 - r0) * t + bl, t * L));
  }
  for (let i = 0; i <= CAP; i++) {                     // end cap (rim → pole)
    const t = Math.PI / 2 - (i / CAP) * Math.PI / 2;
    pts.push(new THREE.Vector2(Math.max(1e-4, r1 * Math.sin(t)), L + r1 * 0.6 * Math.cos(t)));
  }
  const g = new THREE.LatheGeometry(pts, radial);
  g.scale(sx, 1, sz);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_figUp, dir));
  g.translate(a.x, a.y, a.z);
  return g;
}
function _figBlob(rx, ry, rz, x, y, z, ws = 12, hs = 9) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  g.scale(rx, ry, rz); g.translate(x, y, z);
  return g;
}
function _figMerge(parts, centreY) {
  const g = fixZeroNormals(mergeGeometries(parts));
  g.translate(0, -centreY, 0);
  g.computeBoundingSphere();
  return g;
}

// ── shared GLSL ─────────────────────────────────────────────────────────────
const FIG_GLSL_COMMON = /* glsl */`
  uniform float uFigTime;
  attribute vec2 aRig;
  attribute vec4 aAnim;
  mat3 figRx(float a) { float c = cos(a), s = sin(a); return mat3(1.0,0.0,0.0, 0.0,c,s, 0.0,-s,c); }
  mat3 figRy(float a) { float c = cos(a), s = sin(a); return mat3(c,0.0,-s, 0.0,1.0,0.0, s,0.0,c); }
  mat3 figRz(float a) { float c = cos(a), s = sin(a); return mat3(c,s,0.0, -s,c,0.0, 0.0,0.0,1.0); }
  void figRot(inout vec3 p, inout vec3 n, mat3 R, vec3 pivot) { p = R * (p - pivot) + pivot; n = R * n; }
  float figHash(float x) { return fract(sin(x * 91.3458) * 47453.5453); }
`;

// Build a MeshStandardMaterial + matching depth material that share the pose
// code. `poseGLSL` is a function body over (inout vec3 p, inout vec3 n) that
// may also write vFigCol / vFigRough (colour work only runs in the main pass).
function _figMaterials({ header, pose, colour, key, roughness = 0.8 }) {
  const shaders = [];
  const mat = new THREE.MeshStandardMaterial({ roughness, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uFigTime = { value: 0 };
    shaders.push(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        ${FIG_GLSL_COMMON}
        ${header}
        varying vec3 vFigCol;
        varying float vFigRough;
        void figPose(inout vec3 p, inout vec3 n) { ${pose} }
        void figColour() { ${colour} }`)
      .replace('#include <beginnormal_vertex>', `
        vec3 figP = position; vec3 objectNormal = normal;
        figPose(figP, objectNormal);
        figColour();
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = figP;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vFigCol;
        varying float vFigRough;`)
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= vFigCol;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vFigRough;');
  };
  mat.customProgramCacheKey = () => 'fig-' + key;

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (sh) => {
    sh.uniforms.uFigTime = { value: 0 };
    shaders.push(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        ${FIG_GLSL_COMMON}
        ${header}
        void figPose(inout vec3 p, inout vec3 n) { ${pose} }`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = position; vec3 figN = vec3(0.0, 1.0, 0.0);
        figPose(transformed, figN);`);
  };
  depth.customProgramCacheKey = () => 'figd-' + key;
  return {
    mat, depth,
    setTime(t) { for (const s of shaders) s.uniforms.uFigTime.value = t; },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HUMAN
// ═══════════════════════════════════════════════════════════════════════════
// Bones: 0 pelvis · 1 torso · 2 head · 3/4 L upper/fore arm · 5/6 R arm
//        7/8 L thigh/shin · 9/10 R thigh/shin        (L = +x)
// Regions: 0 skin · 1 top · 2 bottom · 3 hair cap · 4 shoes · 5 eyes
//          6 shin (skin under shorts/skirt) · 7 forearm (skin if short sleeves)
//          8 skirt · 9 long hair · 10 bun · 11 thigh (skin under a skirt)
//          12 belt/leather · 13 lips · 14 brows
const HUMAN_H = 1.74;                  // standing height at scale 1
const HUMAN_HALF = 0.87;               // feet → mass centre
function buildHumanGeometry() {
  const P = [];
  // torso + pelvis: one lathe, split into bones/regions by height
  {
    const prof = [
      [0.0, 0.815], [0.07, 0.83], [0.125, 0.86], [0.158, 0.90], [0.170, 0.95],
      [0.166, 1.00], [0.150, 1.06], [0.142, 1.10], [0.150, 1.17], [0.165, 1.25],
      [0.176, 1.32], [0.182, 1.38], [0.172, 1.425], [0.135, 1.462], [0.075, 1.485], [0.0, 1.492],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const g = new THREE.LatheGeometry(prof, 16);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i); let z = pos.getZ(i);
      // flatter front-to-back through the shoulders than at the hips; the
      // chest carries forward, the seat carries back
      const k = 0.74 + (0.60 - 0.74) * Math.min(1, Math.max(0, (y - 1.0) / 0.4));
      z *= k;
      if (y > 1.18 && y < 1.40 && z < 0) z *= 1.12;
      if (y > 0.84 && y < 1.0 && z > 0) z *= 1.1;
      pos.setZ(i, z);
    }
    P.push(_figTag(g, (x, y) => (y < 1.0 ? [0, 2] : [1, 1])));
  }
  // belt
  {
    const b = new THREE.CylinderGeometry(0.168, 0.170, 0.035, 16, 1, true);
    b.scale(1, 1, 0.74); b.translate(0, 1.0, 0);
    P.push(_figPart(b, 0, 12));
  }
  // collar
  {
    const c = new THREE.TorusGeometry(0.068, 0.014, 5, 14);
    c.rotateX(Math.PI / 2); c.scale(1, 1, 0.9); c.translate(0, 1.478, 0.005);
    P.push(_figPart(c, 1, 1));
  }
  // neck
  P.push(_figPart(_figLimb([0, 1.44, 0.008], [0, 1.585, 0.0], 0.052, 0.047, { radial: 8, rows: 2 }), 1, 0));
  // head: cranium, jaw, nose, ears, eyes, brows, lips
  P.push(_figPart(_figBlob(0.084, 0.106, 0.098, 0, 1.652, 0.004, 16, 12), 2, 0));
  P.push(_figPart(_figBlob(0.068, 0.062, 0.072, 0, 1.592, -0.026, 12, 8), 2, 0));
  {
    const nose = new THREE.ConeGeometry(0.017, 0.042, 6);
    nose.rotateX(-Math.PI / 2 - 0.35); nose.translate(0, 1.64, -0.101);
    P.push(_figPart(nose, 2, 0));
  }
  for (const s of [1, -1]) {
    P.push(_figPart(_figBlob(0.012, 0.026, 0.018, s * 0.083, 1.642, 0.004, 6, 5), 2, 0));
    P.push(_figPart(_figBlob(0.0125, 0.0105, 0.008, s * 0.032, 1.664, -0.086, 6, 5), 2, 5));
    const brow = new THREE.BoxGeometry(0.03, 0.0065, 0.012);
    brow.rotateZ(s * -0.12); brow.translate(s * 0.033, 1.684, -0.091);
    P.push(_figPart(brow, 2, 14));
  }
  P.push(_figPart(_figBlob(0.022, 0.007, 0.01, 0, 1.593, -0.093, 8, 4), 2, 13));
  // hair: cap (short), long fall at the back, bun
  {
    const cap = new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.56);
    cap.scale(0.093, 0.116, 0.108); cap.rotateX(0.26); cap.translate(0, 1.658, 0.01);
    P.push(_figPart(cap, 2, 3));
    P.push(_figPart(_figBlob(0.097, 0.15, 0.065, 0, 1.575, 0.05, 12, 9), 2, 9));
    P.push(_figPart(_figBlob(0.044, 0.042, 0.042, 0, 1.735, 0.07, 8, 6), 2, 10));
  }
  // skirt
  {
    const prof = [[0.160, 1.02], [0.185, 0.92], [0.225, 0.78], [0.265, 0.60], [0.262, 0.585]]
      .map(([r, y]) => new THREE.Vector2(r, y));
    const s = new THREE.LatheGeometry(prof, 16);
    s.scale(1, 1, 0.82);
    P.push(_figPart(s, 0, 8));
  }
  // arms and legs, both sides
  for (const s of [1, -1]) {
    const upper = s > 0 ? 3 : 5, fore = upper + 1, thigh = s > 0 ? 7 : 9, shin = thigh + 1;
    // deltoid + upper arm (sleeve)
    P.push(_figPart(_figBlob(0.058, 0.055, 0.056, s * 0.178, 1.405, 0.004, 10, 7), upper, 1));
    P.push(_figPart(_figLimb([s * 0.188, 1.40, 0.004], [s * 0.212, 1.125, 0.018], 0.047, 0.037, { bulge: 0.004 }), upper, 1));
    P.push(_figPart(_figLimb([s * 0.212, 1.125, 0.018], [s * 0.224, 0.875, -0.002], 0.037, 0.027, { bulge: 0.005, bulgeAt: 0.3 }), fore, 7));
    // hand: palm + thumb
    P.push(_figPart(_figBlob(0.022, 0.052, 0.04, s * 0.228, 0.83, -0.006, 8, 6), fore, 0));
    P.push(_figPart(_figBlob(0.011, 0.028, 0.012, s * 0.215, 0.845, -0.038, 5, 4), fore, 0));
    // thigh + knee + shin
    P.push(_figPart(_figLimb([s * 0.088, 0.95, 0.0], [s * 0.094, 0.50, 0.0], 0.088, 0.056, { bulge: 0.006, bulgeAt: 0.3, sz: 1.05 }), thigh, 11));
    P.push(_figPart(_figLimb([s * 0.094, 0.50, 0.0], [s * 0.094, 0.09, 0.018], 0.054, 0.036, { bulge: 0.014, bulgeAt: 0.3 }), shin, 6));
    // shoe
    const shoe = _figBlob(0.047, 0.042, 0.128, s * 0.094, 0.045, -0.045, 10, 6);
    const sp = shoe.attributes.position;
    for (let i = 0; i < sp.count; i++) if (sp.getY(i) < 0.012) sp.setY(i, 0.012);   // flat sole
    P.push(_figPart(shoe, shin, 4));
  }
  return _figMerge(P, HUMAN_HALF);
}

// GLSL for the human rig. Pivots are in rest space (feet at −HALF).
function _humanGLSL() {
  const H = HUMAN_HALF.toFixed(3);
  const header = /* glsl */`
    attribute vec4 aStyle;      // seed, hair (0 short 1 long 2 bun 3 bald), lower (0 trousers 1 shorts 2 skirt), flags
    attribute vec3 aSkin, aTop, aBottom, aHair;
    const float FH = ${H};
    vec3 fp(float x, float y, float z) { return vec3(x, y - FH, z); }
    float figFlag(float flags, float bit) { return mod(floor(flags / bit), 2.0); }
  `;
  const pose = /* glsl */`
    int bone = int(aRig.x + 0.5);
    int reg = int(aRig.y + 0.5);
    float seed = aStyle.x;
    float hair = aStyle.y, lower = aStyle.z, flags = aStyle.w;
    // optional parts that this person does not wear collapse to a point
    if ((reg == 8 && lower < 1.5) || (reg == 9 && abs(hair - 1.0) > 0.5) ||
        (reg == 10 && abs(hair - 2.0) > 0.5) || (reg == 3 && hair > 2.5) ||
        (reg == 12 && lower > 1.5)) { p = vec3(0.0); return; }
    // build: broader shoulders or wider hips
    float fem = figFlag(flags, 4.0);
    if (bone <= 1 || reg == 8) {
      float y = p.y + FH;
      float hip = smoothstep(1.1, 0.9, y), sh = smoothstep(1.15, 1.38, y);
      p.x *= 1.0 + fem * (0.07 * hip - 0.07 * sh) + (1.0 - fem) * 0.05 * sh;
      if (fem > 0.5 && y > 1.2 && y < 1.37 && p.z < 0.0) p.z *= 1.0 + 0.22 * smoothstep(1.2, 1.28, y) * smoothstep(1.37, 1.3, y) * smoothstep(0.02, 0.1, abs(p.x) + 0.03);
    }
    if (fem < 0.5 && (bone == 3 || bone == 5)) p.x *= 1.04;

    float t = uFigTime;
    float ph = aAnim.x, gait = aAnim.y, sit = aAnim.z, flail = aAnim.w;
    float chat = figFlag(flags, 2.0) * (1.0 - gait) * (1.0 - sit);
    float idle = (1.0 - gait) * (1.0 - flail);
    float side = (bone == 3 || bone == 4 || bone == 7 || bone == 8) ? 1.0 : -1.0;
    float lph = ph + (side > 0.0 ? 0.0 : 3.14159);

    // ── distal joints first (rest space), then proximal ──
    if (bone == 8 || bone == 10) {                       // knee
      float swing = max(0.0, cos(lph + 0.35)); swing *= swing;
      float knee = gait * (0.08 + 0.95 * swing) + sit * 1.22 + flail * (0.5 + 0.4 * sin(t * 3.1 + seed * 7.0 + side));
      figRot(p, n, figRx(-knee), fp(side * 0.094, 0.50, 0.0));
      // ankle: toe drops as the foot leaves the ground
      if (reg == 4) figRot(p, n, figRx(gait * 0.25 * max(0.0, sin(lph + 1.2)) - sit * 0.35), fp(side * 0.094, 0.09, 0.018));
    }
    if (bone == 4 || bone == 6) {                        // elbow
      float g1 = sin(t * (1.6 + figHash(seed) * 0.8) + seed * 11.0 + side * 1.7);
      float elbow = 0.12 + gait * (0.28 + 0.2 * max(0.0, -sin(lph)))
                  + chat * (0.25 + 0.75 * max(0.0, g1)) * (side > 0.0 ? 1.0 : 0.35)
                  + sit * 0.1 + flail * (0.4 + 0.5 * sin(t * 5.3 + seed + side));
      figRot(p, n, figRx(elbow), fp(side * 0.212, 1.125, 0.018));
    }
    if (bone == 2) {                                     // head: look around / nod
      float child = figFlag(flags, 8.0);
      if (child > 0.5) p = (p - fp(0.0, 1.53, 0.0)) * 1.28 + fp(0.0, 1.53, 0.0);
      float look = idle * (0.55 * sin(t * 0.21 + seed * 5.0) * smoothstep(0.2, 0.9, sin(t * 0.13 + seed * 3.0)));
      float nod = chat * 0.09 * sin(t * 2.3 + seed * 4.0) + gait * 0.04 - sit * 0.08 + flail * 0.3 * sin(t * 2.0 + seed);
      figRot(p, n, figRy(look) * figRx(-nod), fp(0.0, 1.53, 0.0));
    }
    if (bone >= 3 && bone <= 6) {                        // shoulder
      float swing = -gait * 0.38 * sin(lph);
      float g2 = sin(t * (1.1 + figHash(seed + 3.0) * 0.7) + seed * 17.0 + side * 2.3);
      swing += chat * (0.05 + 0.3 * max(0.0, g2)) * (side > 0.0 ? 1.0 : 0.3);
      swing -= sit * 0.75;
      float abd = 0.06 + gait * 0.03 + sit * 0.12 + flail * (1.5 + 0.5 * sin(t * 4.0 + seed * 3.0 + side * 2.0));
      swing += flail * 0.6 * sin(t * 3.3 + seed * 5.0 + side);
      figRot(p, n, figRz(side * abd) * figRx(swing), fp(side * 0.185, 1.40, 0.004));
    }
    if (bone >= 7) {                                     // hip
      float hip = gait * 0.42 * sin(lph) + sit * 2.1 + flail * (0.4 * sin(t * 2.7 + seed * 9.0 + side * 1.5));
      float abd = flail * (0.25 + 0.15 * sin(t * 2.0 + side)) + sit * 0.12;
      figRot(p, n, figRz(side * abd) * figRx(hip), fp(side * 0.088, 0.95, 0.0));
    }
    if (bone >= 1 && bone <= 6) {                        // waist: counter-twist + breathing
      float twist = gait * 0.10 * sin(ph);
      float lean = -gait * 0.07 + sit * 0.3 + chat * 0.03 * sin(t * 0.7 + seed);
      figRot(p, n, figRy(twist) * figRx(lean), fp(0.0, 1.02, 0.0));
      if (bone == 1) { float br = 1.0 + 0.012 * sin(t * 1.4 + seed * 2.0); p.x *= br; p.z *= br; }
    }
    // pelvis / root: hip roll, weight shift, bob, sit drop
    {
      float shift = idle * (1.0 - sit) * sin(t * 0.37 + seed * 6.0);
      float roll = gait * 0.05 * sin(ph) + shift * 0.045;
      float yaw = -gait * 0.07 * sin(ph);
      figRot(p, n, figRz(roll) * figRy(yaw), fp(0.0, 0.95, 0.0));
      p.x += shift * 0.03;
      p.y += gait * 0.028 * (abs(cos(ph)) - 0.6) - sit * 0.83;
    }
  `;
  const colour = /* glsl */`
    int reg = int(aRig.y + 0.5);
    float lower = aStyle.z, flags = aStyle.w;
    float shortSleeve = figFlag(flags, 1.0);
    vec3 shoe = mix(vec3(0.030, 0.024, 0.020), vec3(0.20, 0.12, 0.07), step(0.5, figHash(aStyle.x + 1.0)));
    shoe = mix(shoe, vec3(0.72), step(0.8, figHash(aStyle.x + 2.0)));
    vec3 c = aSkin; float r = 0.62;
    if (reg == 1) { c = aTop; r = 0.86; }
    else if (reg == 2) { c = aBottom; r = 0.9; }
    else if (reg == 3 || reg == 9 || reg == 10) { c = aHair; r = 0.62; }
    else if (reg == 4) { c = shoe; r = 0.45; }
    else if (reg == 5) { c = vec3(0.02, 0.018, 0.016); r = 0.2; }
    else if (reg == 6) { if (lower < 0.5) { c = aBottom; r = 0.9; } }
    else if (reg == 7) { if (shortSleeve < 0.5) { c = aTop; r = 0.86; } }
    else if (reg == 8) { c = aBottom; r = 0.88; }
    else if (reg == 11) { if (lower < 1.5) { c = aBottom; r = 0.9; } }
    else if (reg == 12) { c = shoe * 0.8; r = 0.5; }
    else if (reg == 13) { c = aSkin * vec3(0.78, 0.6, 0.58); r = 0.5; }
    else if (reg == 14) { c = aHair * 0.8; r = 0.7; }
    vFigCol = c; vFigRough = r;
  `;
  return { header, pose, colour };
}

function makeHumanMaterials() {
  return _figMaterials(Object.assign({ key: 'human-v1' }, _humanGLSL()));
}

// ═══════════════════════════════════════════════════════════════════════════
// QUADRUPEDS (dog, cat)
// ═══════════════════════════════════════════════════════════════════════════
// Bones: 0 body · 1 head · 2 tail · 3 FL · 4 FR · 5 BL · 6 BR (L = +x)
// Regions: 0 coat · 1 light (muzzle, chest, paws) · 2 dark (nose, eyes) · 3 inner ear
const QUAD_PIV = {
  dog: { legY: 0.40, legZF: -0.19, legZB: 0.20, legX: 0.075, neck: [0, 0.48, -0.25], tail: [0, 0.47, 0.29], half: 0.30 },
  cat: { legY: 0.25, legZF: -0.15, legZB: 0.16, legX: 0.055, neck: [0, 0.31, -0.19], tail: [0, 0.31, 0.22], half: 0.19 },
};
function buildQuadGeometry(kind) {
  const P = [];
  const k = QUAD_PIV[kind];
  const dog = kind === 'dog';
  // body: a lathe along the spine, deeper at the chest than at the loin
  {
    const L = dog ? 0.56 : 0.42, R = dog ? 0.125 : 0.085;
    const prof = [];
    const N = 10;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const r = R * (0.25 + 0.75 * Math.sin(Math.PI * (0.06 + 0.88 * t))) * (1 + (dog ? 0.18 : 0.08) * t);
      prof.push(new THREE.Vector2(i === 0 || i === N ? 1e-4 : r, t * L));
    }
    const g = new THREE.LatheGeometry(prof, 12);
    g.rotateX(-Math.PI / 2);                            // lathe +Y → −Z (head end)
    g.translate(0, dog ? 0.43 : 0.28, L / 2 - 0.02);
    const pos = g.attributes.position;
    const cy = dog ? 0.43 : 0.28;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i), z = pos.getZ(i);
      // deep chest, tucked belly
      if (y < cy) pos.setY(i, cy + (y - cy) * (z < 0 ? 1.15 : 0.8));
      pos.setX(i, pos.getX(i) * 0.9);
    }
    P.push(_figTag(g, (x, y, z) => [0, (y < cy - R * 0.55 && z < 0.0) ? 1 : 0]));
  }
  // neck + head
  const nk = k.neck;
  const hz = nk[2] - (dog ? 0.13 : 0.08), hy = nk[1] + (dog ? 0.14 : 0.09);
  P.push(_figPart(_figLimb(nk, [0, hy - 0.02, hz + 0.02], dog ? 0.07 : 0.05, dog ? 0.06 : 0.045), 1, 0));
  if (dog) {
    P.push(_figPart(_figBlob(0.075, 0.075, 0.085, 0, hy, hz), 1, 0));
    P.push(_figPart(_figBlob(0.042, 0.042, 0.075, 0, hy - 0.03, hz - 0.1, 10, 7), 1, 1));
    P.push(_figPart(_figBlob(0.022, 0.018, 0.016, 0, hy - 0.012, hz - 0.172, 6, 5), 1, 2));
    for (const s of [1, -1]) {
      P.push(_figPart(_figBlob(0.011, 0.011, 0.008, s * 0.036, hy + 0.025, hz - 0.068, 6, 5), 1, 2));
      const ear = _figBlob(0.016, 0.07, 0.042, 0, 0, 0, 7, 6);
      ear.rotateZ(s * 0.35); ear.translate(s * 0.07, hy - 0.01, hz + 0.01);
      P.push(_figPart(ear, 1, 0));
    }
  } else {
    P.push(_figPart(_figBlob(0.058, 0.052, 0.056, 0, hy, hz), 1, 0));
    P.push(_figPart(_figBlob(0.03, 0.024, 0.03, 0, hy - 0.02, hz - 0.045, 8, 6), 1, 1));
    P.push(_figPart(_figBlob(0.009, 0.007, 0.006, 0, hy - 0.006, hz - 0.074, 5, 4), 1, 2));
    for (const s of [1, -1]) {
      P.push(_figPart(_figBlob(0.012, 0.011, 0.007, s * 0.024, hy + 0.012, hz - 0.047, 6, 5), 1, 2));
      const ear = new THREE.ConeGeometry(0.022, 0.05, 4);
      ear.rotateZ(-s * 0.25); ear.translate(s * 0.034, hy + 0.058, hz + 0.005);
      P.push(_figPart(ear, 1, 3));
    }
  }
  // legs
  for (const [bone, sx, zz] of [[3, 1, k.legZF], [4, -1, k.legZF], [5, 1, k.legZB], [6, -1, k.legZB]]) {
    const top = [sx * k.legX, k.legY, zz], foot = [sx * k.legX, 0.03, zz - 0.01];
    const rt = dog ? (bone >= 5 ? 0.05 : 0.042) : (bone >= 5 ? 0.036 : 0.028);
    P.push(_figPart(_figLimb(top, foot, rt, rt * 0.55, { bulge: rt * 0.2, bulgeAt: 0.2, radial: 7, rows: 4 }), bone, 0));
    P.push(_figPart(_figBlob(rt * 0.8, rt * 0.5, rt * 1.1, foot[0], 0.022, foot[2] - rt * 0.4, 7, 5), bone, 1));
  }
  // tail
  {
    const tl = k.tail;
    const tip = dog ? [0, tl[1] + 0.12, tl[2] + 0.2] : [0, tl[1] + 0.2, tl[2] + 0.16];
    P.push(_figPart(_figLimb(tl, tip, dog ? 0.03 : 0.02, dog ? 0.012 : 0.016, { radial: 6, rows: 5 }), 2, 0));
  }
  return _figMerge(P, k.half);
}

function makeQuadMaterials(kind) {
  const k = QUAD_PIV[kind];
  const f = (v) => v.toFixed(3);
  const header = /* glsl */`
    attribute vec3 aCol;
    const float FH = ${f(k.half)};
    vec3 fp(float x, float y, float z) { return vec3(x, y - FH, z); }
  `;
  const pose = /* glsl */`
    int bone = int(aRig.x + 0.5);
    float t = uFigTime, ph = aAnim.x, gait = aAnim.y, sit = aAnim.z, flail = aAnim.w;
    float seed = aCol.r * 17.0 + aCol.g * 31.0;
    if (bone >= 3) {
      bool front = bone <= 4;
      float side = (bone == 3 || bone == 5) ? 1.0 : -1.0;
      // trot: diagonal pairs move together
      float lph = ph + ((bone == 3 || bone == 6) ? 0.0 : 3.14159);
      float swing = gait * 0.55 * sin(lph);
      swing += flail * 0.9 * sin(t * 6.0 + float(bone) * 1.7);
      if (!front) swing += sit * 1.25; else swing -= sit * 0.5;
      float zz = front ? ${f(k.legZF)} : ${f(k.legZB)};
      figRot(p, n, figRx(swing), fp(side * ${f(k.legX)}, ${f(k.legY)}, zz));
    }
    if (bone == 2) {                                   // tail: wag / swish
      float wag = ${kind === 'dog' ? '0.55 * sin(t * 9.0 + seed)' : '0.3 * sin(t * 1.3 + seed)'};
      figRot(p, n, figRy(wag) * figRx(${kind === 'dog' ? '0.2' : '-0.15'} * sin(t * 0.8 + seed)), fp(${k.tail.map(f).join(', ')}));
    }
    if (bone == 1) {                                   // head: sniff / look
      float look = (1.0 - gait) * 0.5 * sin(t * 0.3 + seed * 2.0);
      float nod = gait * 0.06 * sin(ph * 2.0) + sit * 0.2 - (1.0 - gait) * (1.0 - sit) * 0.15 * max(0.0, sin(t * 0.21 + seed));
      figRot(p, n, figRy(look) * figRx(nod), fp(${k.neck.map(f).join(', ')}));
    }
    // sitting: haunches down, chest up (pivot on the front feet)
    if (sit > 0.0) figRot(p, n, figRx(sit * 0.55), fp(0.0, 0.0, ${f(k.legZF)}));
    p.y += gait * 0.012 * cos(ph * 2.0);
  `;
  const colour = /* glsl */`
    int reg = int(aRig.y + 0.5);
    vec3 c = aCol; float r = 0.82;
    if (reg == 1) c = mix(aCol, vec3(0.78, 0.72, 0.62), 0.55);
    else if (reg == 2) { c = vec3(0.025, 0.02, 0.018); r = 0.25; }
    else if (reg == 3) c = mix(aCol, vec3(0.75, 0.45, 0.45), 0.5);
    vFigCol = c; vFigRough = r;
  `;
  return _figMaterials({ key: 'quad-' + kind, header, pose, colour });
}

// ═══════════════════════════════════════════════════════════════════════════
// DUCK
// ═══════════════════════════════════════════════════════════════════════════
// Bones: 0 body · 1 head. Regions: 0 body · 1 head · 2 beak · 3 eye · 4 wing panel · 5 tail
const DUCK_HALF = 0.10;
function buildDuckGeometry() {
  const P = [];
  {
    const prof = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const r = 0.12 * Math.pow(Math.sin(Math.PI * t), 0.8) * (1 + 0.25 * t);
      prof.push(new THREE.Vector2(i === 0 || i === 10 ? 1e-4 : r, t * 0.36));
    }
    const g = new THREE.LatheGeometry(prof, 12);
    g.rotateX(-Math.PI / 2); g.translate(0, 0.1, 0.17);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i), z = pos.getZ(i);
      pos.setY(i, 0.1 + (y - 0.1) * (y < 0.1 ? 0.7 : 0.85) + (z > 0.08 ? (z - 0.08) * 0.35 : 0));
    }
    P.push(_figTag(g, (x, y, z) => [0, (z > 0.12 && y > 0.11) ? 5 : (Math.abs(x) > 0.075 && y > 0.1 && z > -0.06 ? 4 : 0)]));
  }
  P.push(_figPart(_figLimb([0, 0.15, -0.1], [0, 0.23, -0.13], 0.04, 0.035, { radial: 7, rows: 2 }), 1, 1));
  P.push(_figPart(_figBlob(0.048, 0.046, 0.058, 0, 0.26, -0.14, 10, 8), 1, 1));
  {
    const beak = _figBlob(0.024, 0.011, 0.045, 0, 0.245, -0.2, 8, 5);
    P.push(_figPart(beak, 1, 2));
  }
  for (const s of [1, -1]) P.push(_figPart(_figBlob(0.008, 0.008, 0.006, s * 0.036, 0.27, -0.165, 5, 4), 1, 3));
  return _figMerge(P, DUCK_HALF);
}
function makeDuckMaterials() {
  const header = /* glsl */`
    attribute vec3 aCol; attribute vec3 aCol2;
    const float FH = ${DUCK_HALF.toFixed(3)};
    vec3 fp(float x, float y, float z) { return vec3(x, y - FH, z); }
  `;
  const pose = /* glsl */`
    int bone = int(aRig.x + 0.5);
    float t = uFigTime, ph = aAnim.x, flail = aAnim.w;
    if (bone == 1) {
      float dip = max(0.0, sin(t * 0.23 + ph * 3.0)); dip *= dip; dip *= dip; dip = dip * dip * dip;
      float look = 0.6 * sin(t * 0.4 + ph * 5.0);
      figRot(p, n, figRy(look) * figRx(-0.2 + dip * 1.6 + flail * 0.5 * sin(t * 7.0)), fp(0.0, 0.15, -0.1));
    }
  `;
  const colour = /* glsl */`
    int reg = int(aRig.y + 0.5);
    vec3 c = aCol; float r = 0.6;
    if (reg == 1) c = aCol2;
    else if (reg == 2) { c = vec3(0.85, 0.52, 0.08); r = 0.45; }
    else if (reg == 3) { c = vec3(0.02); r = 0.15; }
    else if (reg == 4) c = aCol * 0.72 + vec3(0.02, 0.03, 0.06);
    else if (reg == 5) c = mix(aCol, vec3(0.9), 0.3);
    vFigCol = c; vFigRough = r;
  `;
  return _figMaterials({ key: 'duck', header, pose, colour });
}

// ═══════════════════════════════════════════════════════════════════════════
// BIRD (heron / swift) — body + two flapping wings
// ═══════════════════════════════════════════════════════════════════════════
function buildBirdGeometry() {
  const P = [];
  P.push(_figPart(_figLimb([0, 0, 0.2], [0, 0, -0.18], 0.035, 0.05, { bulge: 0.02, radial: 7, rows: 4 }), 0, 0));
  P.push(_figPart(_figBlob(0.04, 0.038, 0.05, 0, 0.01, -0.22, 8, 6), 0, 0));
  {
    const beak = new THREE.ConeGeometry(0.012, 0.08, 5);
    beak.rotateX(-Math.PI / 2); beak.translate(0, 0.005, -0.3);
    P.push(_figPart(beak, 0, 2));
  }
  {
    const tail = new THREE.ConeGeometry(0.06, 0.14, 4);
    tail.rotateX(Math.PI / 2); tail.scale(1, 0.15, 1); tail.translate(0, 0, 0.26);
    P.push(_figPart(tail, 0, 1));
  }
  for (const s of [1, -1]) {
    // swept wing: flattened ellipsoid, leading edge forward, tip swept back
    const w = new THREE.SphereGeometry(1, 12, 6);
    w.scale(0.3, 0.012, 0.085);
    const pos = w.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      pos.setZ(i, pos.getZ(i) * (1 - 0.45 * Math.abs(x) / 0.3) + Math.abs(x) * 0.35);
    }
    w.translate(s * 0.3, 0.01, -0.02);
    P.push(_figPart(w, s > 0 ? 1 : 2, 1));
  }
  return _figMerge(P, 0);
}
function makeBirdMaterials() {
  const header = /* glsl */`
    attribute vec3 aCol;
    vec3 fp(float x, float y, float z) { return vec3(x, y, z); }
  `;
  const pose = /* glsl */`
    int bone = int(aRig.x + 0.5);
    float t = uFigTime, ph = aAnim.x, rate = aAnim.y;
    if (bone >= 1) {
      float side = bone == 1 ? 1.0 : -1.0;
      // flap with glides: the wing beat comes in bursts
      float burst = smoothstep(-0.2, 0.4, sin(t * 0.35 + ph));
      float flap = mix(0.12, 0.75 * sin(t * rate + ph), burst);
      figRot(p, n, figRz(side * flap), fp(side * 0.02, 0.01, 0.0));
    }
  `;
  const colour = /* glsl */`
    int reg = int(aRig.y + 0.5);
    vec3 c = aCol; float r = 0.7;
    if (reg == 1) c = aCol * 0.75;
    else if (reg == 2) { c = vec3(0.75, 0.6, 0.2); r = 0.4; }
    vFigCol = c; vFigRough = r;
  `;
  return _figMaterials({ key: 'bird', header, pose, colour });
}
