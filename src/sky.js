// ── Space environment: stars, Milky Way band, sun disc, Earth ───────────────
// Everything lives in one group that rotates about Y with the ring's spin,
// so through the ceiling windows the sky visibly wheels past — and freezes
// when the gravity drive fails.
import * as THREE from 'three';
import { mulberry32 } from './textures.js';

export function buildSky(scene) {
  const group = new THREE.Group();
  scene.add(group);

  // Star dome — custom shader with procedural stars + galaxy band
  const starMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {},
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vDir;
      float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = vec3(0.004, 0.005, 0.010);
        // Milky-way band tilted off the spin plane
        vec3 bandN = normalize(vec3(0.25, 1.0, 0.4));
        float band = pow(1.0 - abs(dot(d, bandN)), 6.0);
        col += vec3(0.045, 0.05, 0.07) * band * 1.6;
        // Star layers
        for (int i = 0; i < 3; i++) {
          float scale = 90.0 + float(i) * 140.0;
          vec3 cell = floor(d * scale);
          float h = hash(cell);
          if (h > 0.995 - float(i) * 0.002) {
            vec3 center = (cell + 0.5) / scale;
            float dist = length(d - normalize(center));
            float b = smoothstep(0.0035, 0.0, dist) * (0.35 + fract(h * 91.0) * 0.65);
            float tint = fract(h * 57.0);
            vec3 starCol = mix(vec3(0.8, 0.85, 1.0), vec3(1.0, 0.9, 0.75), tint);
            col += starCol * b;
          }
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const stars = new THREE.Mesh(new THREE.SphereGeometry(30000, 48, 32), starMat);
  stars.frustumCulled = false;
  group.add(stars);

  // Sun — bright disc + halo sprite
  const sunPos = new THREE.Vector3(9000, 14000, -12000);
  const sunCanvas = document.createElement('canvas');
  sunCanvas.width = sunCanvas.height = 256;
  {
    const ctx = sunCanvas.getContext('2d');
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0.0, 'rgba(255,255,245,1)');
    g.addColorStop(0.08, 'rgba(255,250,225,1)');
    g.addColorStop(0.22, 'rgba(255,235,180,0.55)');
    g.addColorStop(0.6, 'rgba(255,215,140,0.12)');
    g.addColorStop(1.0, 'rgba(255,200,120,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  }
  const sunTex = new THREE.CanvasTexture(sunCanvas);
  sunTex.colorSpace = THREE.SRGBColorSpace;
  const sun = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sunTex, transparent: true, depthWrite: false, fog: false,
  }));
  sun.position.copy(sunPos);
  sun.scale.setScalar(9000);
  group.add(sun);

  // Earth — canvas-painted blue marble with a fresnel atmosphere shell
  const earthCanvas = document.createElement('canvas');
  earthCanvas.width = 512; earthCanvas.height = 256;
  {
    const ctx = earthCanvas.getContext('2d');
    const rng = mulberry32(777);
    const oceanGrad = ctx.createLinearGradient(0, 0, 0, 256);
    oceanGrad.addColorStop(0, '#16334f');
    oceanGrad.addColorStop(0.5, '#1d4e73');
    oceanGrad.addColorStop(1, '#16334f');
    ctx.fillStyle = oceanGrad;
    ctx.fillRect(0, 0, 512, 256);
    // continents: random walk blobs
    for (let c = 0; c < 9; c++) {
      let x = rng() * 512, y = 40 + rng() * 176;
      ctx.fillStyle = `rgba(${90 + rng() * 40},${100 + rng() * 40},${55 + rng() * 25},0.95)`;
      for (let i = 0; i < 120; i++) {
        ctx.beginPath(); ctx.arc(x % 512, y, 4 + rng() * 14, 0, 7); ctx.fill();
        x += (rng() - 0.4) * 22; y += (rng() - 0.5) * 14;
        y = Math.max(25, Math.min(231, y));
      }
    }
    // polar caps + clouds
    ctx.fillStyle = 'rgba(235,242,248,0.9)';
    ctx.fillRect(0, 0, 512, 16); ctx.fillRect(0, 240, 512, 16);
    for (let i = 0; i < 250; i++) {
      const x = rng() * 512, y = rng() * 256;
      ctx.fillStyle = `rgba(255,255,255,${0.10 + rng() * 0.22})`;
      ctx.beginPath();
      ctx.ellipse(x, y, 8 + rng() * 26, 3 + rng() * 7, rng(), 0, 7);
      ctx.fill();
    }
  }
  const earthTex = new THREE.CanvasTexture(earthCanvas);
  earthTex.colorSpace = THREE.SRGBColorSpace;
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(2600, 48, 32),
    new THREE.MeshBasicMaterial({ map: earthTex, fog: false })
  );
  earth.position.set(-14000, -4000, 16000);
  earth.rotation.z = 0.4;
  group.add(earth);

  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(2720, 48, 32),
    new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vV;
        void main() {
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vN; varying vec3 vV;
        void main() {
          float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
          gl_FragColor = vec4(0.4, 0.65, 1.0, rim * 0.55);
        }`,
    })
  );
  atmo.position.copy(earth.position);
  group.add(atmo);

  // Moon
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(600, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x8f8d88, fog: false })
  );
  moon.position.set(-20000, 2000, 9000);
  group.add(moon);

  return {
    group,
    update(spinAngle) { group.rotation.y = spinAngle; },
  };
}
