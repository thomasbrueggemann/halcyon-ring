// ── postfx.js — HDR pipeline: MSAA scene target → bloom → grade → ACES ─────
// The scene renders into a half-float, 4× multisampled target in LINEAR light
// (three only tone-maps when drawing to the screen), so highlights — the sun
// on water, lamp globes, the glazing overhead — keep their energy instead of
// clipping at 1.0 before anything can use it.
//
// Bloom is the mip-chain kind (13-tap downsample with a Karis average on the
// first step to kill fireflies, tent-filtered additive upsample), which gives
// a wide, soft, energy-conserving glow rather than a halo. The composite then
// adds bloom, grades (split-tone, a touch of saturation, vignette), tone-maps
// with the renderer's ACES + exposure, converts to sRGB, and dithers so the
// long sky gradients don't band.

function createPostFX(renderer, scene, camera) {
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);

  const hdr = new THREE.WebGLRenderTarget(4, 4, {
    type: THREE.HalfFloatType, samples: 4,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
  });
  // the multisampled depth is resolved into this on every scene render — the
  // SSAO pass reads it back
  hdr.depthTexture = new THREE.DepthTexture(4, 4);
  hdr.depthTexture.type = THREE.UnsignedIntType;

  // ── SSAO (half resolution, depth-only) ──
  // Reconstruct view-space position from depth, derive the normal from its
  // neighbours, and test a 14-tap cosine-weighted hemisphere (rotated per
  // pixel) against the depth buffer. Range-checked so a figure in front of a
  // distant hill doesn't darken the hill, faded out past ~90 m where the depth
  // buffer and the effect both stop being meaningful, then bilaterally blurred.
  const aoRT = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const aoBlurRT = aoRT.clone();
  const KERNEL = [];
  {
    const r = mulberry32(0xa0a0);
    const N = 14;
    for (let i = 0; i < N; i++) {
      const u = r(), v = r();
      const phi = 2 * Math.PI * u, ct = Math.sqrt(1 - v), st = Math.sqrt(v);
      let sc = (i + 1) / N; sc = 0.15 + 0.85 * sc * sc;
      KERNEL.push(new THREE.Vector3(Math.cos(phi) * st * sc, Math.sin(phi) * st * sc, ct * sc));
    }
  }

  const LEVELS = 6;
  const mips = [];
  for (let i = 0; i < LEVELS; i++) {
    mips.push(new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType, depthBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    }));
  }

  const VERT = /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

  const downMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 }, uThreshold: { value: 1.0 }, uKnee: { value: 0.6 } },
    vertexShader: VERT,
    fragmentShader: /* glsl */`
      uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uFirst, uThreshold, uKnee;
      varying vec2 vUv;
      // a non-finite texel (NaN/Inf) would be smeared into a blinking light by
      // the blur — test the exponent bits (fast-math can drop isnan) and zero it
      vec3 tap(vec2 o) {
        vec3 c = texture2D(tSrc, vUv + o * uTexel).rgb;
        return any(equal(floatBitsToUint(c) & 0x7f800000u, uvec3(0x7f800000u))) ? vec3(0.0) : c;
      }
      float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
      vec3 karis(vec3 a, vec3 b, vec3 c, vec3 d) {
        float wa = 1.0 / (1.0 + lum(a)), wb = 1.0 / (1.0 + lum(b)), wc = 1.0 / (1.0 + lum(c)), wd = 1.0 / (1.0 + lum(d));
        return (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
      }
      void main() {
        vec3 a = tap(vec2(-2, 2)), b = tap(vec2(0, 2)), c = tap(vec2(2, 2));
        vec3 d = tap(vec2(-2, 0)), e = tap(vec2(0, 0)), f = tap(vec2(2, 0));
        vec3 g = tap(vec2(-2, -2)), h = tap(vec2(0, -2)), i = tap(vec2(2, -2));
        vec3 j = tap(vec2(-1, 1)), k = tap(vec2(1, 1)), l = tap(vec2(-1, -1)), m = tap(vec2(1, -1));
        vec3 col;
        if (uFirst > 0.5) {
          col = karis(j, k, l, m) * 0.5 + karis(a, b, d, e) * 0.125 + karis(b, c, e, f) * 0.125
              + karis(d, e, g, h) * 0.125 + karis(e, f, h, i) * 0.125;
          // soft-knee threshold: only genuinely bright light blooms
          float br = max(col.r, max(col.g, col.b));
          float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
          soft = soft * soft / (4.0 * uKnee + 1e-4);
          col *= max(soft, br - uThreshold) / max(br, 1e-4);
          col = min(col, vec3(40.0));
        } else {
          col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });

  const upMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.0 } },
    vertexShader: VERT,
    fragmentShader: /* glsl */`
      uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uRadius;
      varying vec2 vUv;
      void main() {
        vec2 o = uTexel * uRadius;
        vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
        c += (texture2D(tSrc, vUv + vec2(-o.x, 0.0)).rgb + texture2D(tSrc, vUv + vec2(o.x, 0.0)).rgb
            + texture2D(tSrc, vUv + vec2(0.0, -o.y)).rgb + texture2D(tSrc, vUv + vec2(0.0, o.y)).rgb) * 2.0;
        c += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb
           + texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb;
        gl_FragColor = vec4(c / 16.0, 1.0);
      }`,
    blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
  });

  const aoMat = new THREE.ShaderMaterial({
    defines: { KN: KERNEL.length },
    uniforms: {
      tDepth: { value: hdr.depthTexture }, uProj: { value: new THREE.Matrix4() }, uInvProj: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() }, uRadius: { value: 0.85 }, uKernel: { value: KERNEL },
    },
    vertexShader: VERT,
    fragmentShader: /* glsl */`
      uniform sampler2D tDepth; uniform mat4 uProj, uInvProj; uniform vec2 uTexel; uniform float uRadius;
      uniform vec3 uKernel[KN];
      varying vec2 vUv;
      vec3 viewPos(vec2 uv) {
        float d = texture2D(tDepth, uv).r;
        vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
        return p.xyz / p.w;
      }
      void main() {
        float d0 = texture2D(tDepth, vUv).r;
        if (d0 >= 0.99999) { gl_FragColor = vec4(1.0); return; }
        vec3 P = viewPos(vUv);
        float fade = 1.0 - smoothstep(55.0, 95.0, -P.z);
        if (fade <= 0.0) { gl_FragColor = vec4(1.0); return; }
        // normal from the smaller-difference neighbours (no halo at edges)
        vec3 pr = viewPos(vUv + vec2(uTexel.x, 0.0)), pl = viewPos(vUv - vec2(uTexel.x, 0.0));
        vec3 pu = viewPos(vUv + vec2(0.0, uTexel.y)), pd = viewPos(vUv - vec2(0.0, uTexel.y));
        vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
        vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
        vec3 N = normalize(cross(dx, dy));
        // per-pixel rotation (interleaved gradient noise)
        float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        float a = ign * 6.2831853;
        vec3 rnd = vec3(cos(a), sin(a), 0.0);
        vec3 T = normalize(rnd - N * dot(rnd, N));
        vec3 B = cross(N, T);
        mat3 tbn = mat3(T, B, N);
        float rad = uRadius * mix(1.0, 2.2, smoothstep(8.0, 60.0, -P.z));
        float occ = 0.0;
        for (int i = 0; i < KN; i++) {
          vec3 sp = P + tbn * uKernel[i] * rad;
          vec4 c = uProj * vec4(sp, 1.0);
          vec2 suv = c.xy / c.w * 0.5 + 0.5;
          if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
          float sz = viewPos(suv).z;
          float range = smoothstep(0.0, 1.0, rad / max(abs(P.z - sz), 1e-3));
          occ += step(sp.z + 0.03 + 0.002 * -P.z, sz) * range;
        }
        float ao = exp2(1.8 * log2(max(1.0 - occ / float(KN), 1e-4)));
        ao = mix(1.0, ao, fade);
        gl_FragColor = vec4(vec3(ao), 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  const aoBlurMat = new THREE.ShaderMaterial({
    uniforms: { tAO: { value: null }, tDepth: { value: hdr.depthTexture }, uDir: { value: new THREE.Vector2() }, uInvProj: aoMat.uniforms.uInvProj },
    vertexShader: VERT,
    fragmentShader: /* glsl */`
      uniform sampler2D tAO, tDepth; uniform vec2 uDir; uniform mat4 uInvProj;
      varying vec2 vUv;
      float vz(vec2 uv) {
        float d = texture2D(tDepth, uv).r;
        vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
        return p.z / p.w;
      }
      void main() {
        float z0 = vz(vUv);
        float sum = 0.0, wsum = 0.0;
        for (int i = -3; i <= 3; i++) {
          vec2 uv = vUv + uDir * float(i);
          float w = exp(-float(i * i) * 0.12) * exp(-abs(vz(uv) - z0) * 4.0 / max(0.5, -z0 * 0.05));
          sum += texture2D(tAO, uv).r * w; wsum += w;
        }
        gl_FragColor = vec4(vec3(sum / max(wsum, 1e-4)), 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });

  const compMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: hdr.texture }, tBloom: { value: mips[0].texture }, tAO: { value: aoRT.texture }, uAO: { value: 0.75 },
      uBloom: { value: 0.14 }, uVignette: { value: 0.32 }, uTime: { value: 0 },
      uSat: { value: 1.06 }, uTint: { value: 0 }, uDebugAO: { value: 0 }, uDebugNaN: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: /* glsl */`
      uniform sampler2D tScene, tBloom, tAO;
      uniform float uDebugNaN, uDebugAO, uAO, uBloom, uVignette, uTime, uSat, uTint;
      varying vec2 vUv;
      float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      void main() {
        vec3 c = texture2D(tScene, vUv).rgb;
        if (uDebugNaN > 0.5 && any(equal(floatBitsToUint(c) & 0x7f800000u, uvec3(0x7f800000u)))) { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }
        if (any(equal(floatBitsToUint(c) & 0x7f800000u, uvec3(0x7f800000u)))) {
          // patch a bad texel from its neighbours rather than leave a hole
          vec2 px = 1.0 / vec2(textureSize(tScene, 0));
          c = vec3(0.0); float n = 0.0;
          for (int k = 0; k < 4; k++) {
            vec2 o = vec2(k == 0 ? 1.0 : k == 1 ? -1.0 : 0.0, k == 2 ? 1.0 : k == 3 ? -1.0 : 0.0) * px;
            vec3 s = texture2D(tScene, vUv + o).rgb;
            if (!any(equal(floatBitsToUint(s) & 0x7f800000u, uvec3(0x7f800000u)))) { c += s; n += 1.0; }
          }
          c /= max(n, 1.0);
        }
        c *= mix(1.0, texture2D(tAO, vUv).r, uAO);
        if (uDebugAO > 0.5) c = vec3(texture2D(tAO, vUv).r * 0.8);
        vec3 b = texture2D(tBloom, vUv).rgb;
        c += b * (uBloom / 6.0);            // mips[0] holds the sum of 6 levels
        // grade in linear light: gentle saturation, cool shadows / warm highlights
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = max(vec3(0.0), mix(vec3(l), c, uSat));
        float hl = smoothstep(0.02, 1.2, l);
        c *= mix(vec3(0.975, 0.995, 1.035), vec3(1.035, 1.0, 0.965), hl);
        // alarm tint (gravity failure) — driven from main.js
        c = mix(c, c * vec3(1.25, 0.72, 0.68), uTint);
        // vignette: optical falloff, not a black frame
        vec2 d = (vUv - 0.5) * vec2(1.0, 0.8);
        c *= 1.0 - uVignette * smoothstep(0.08, 0.55, dot(d, d) * 1.6);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        gl_FragColor.rgb += (hash12(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0;
      }`,
    depthTest: false, depthWrite: false,
  });

  function pass(mat, target) {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  }

  const size = new THREE.Vector2();
  function setSize(w, h) {
    const pr = renderer.getPixelRatio();
    const W = Math.max(1, Math.floor(w * pr)), H = Math.max(1, Math.floor(h * pr));
    hdr.setSize(W, H);
    aoRT.setSize(Math.max(1, W >> 1), Math.max(1, H >> 1));
    aoBlurRT.setSize(Math.max(1, W >> 1), Math.max(1, H >> 1));
    let mw = W, mh = H;
    for (let i = 0; i < LEVELS; i++) {
      mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1);
      mips[i].setSize(mw, mh);
    }
    size.set(W, H);
  }
  renderer.getSize(size);
  setSize(size.x, size.y);

  const state = { enabled: true, ao: true };
  function render(t) {
    if (!state.enabled) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }
    renderer.setRenderTarget(hdr);
    renderer.render(scene, camera);

    const prevAuto = renderer.autoClear;
    renderer.autoClear = true;
    // ambient occlusion
    if (state.ao) {
      aoMat.uniforms.uProj.value.copy(camera.projectionMatrix);
      aoMat.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
      aoMat.uniforms.uTexel.value.set(1 / aoRT.width, 1 / aoRT.height);
      pass(aoMat, aoRT);
      aoBlurMat.uniforms.tAO.value = aoRT.texture;
      aoBlurMat.uniforms.uDir.value.set(1 / aoRT.width, 0);
      pass(aoBlurMat, aoBlurRT);
      aoBlurMat.uniforms.tAO.value = aoBlurRT.texture;
      aoBlurMat.uniforms.uDir.value.set(0, 1 / aoRT.height);
      pass(aoBlurMat, aoRT);
    }
    compMat.uniforms.uAO.value = state.ao ? 0.75 : 0;
    // downsample chain
    let src = hdr;
    for (let i = 0; i < LEVELS; i++) {
      downMat.uniforms.tSrc.value = src.texture;
      downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      downMat.uniforms.uFirst.value = i === 0 ? 1 : 0;
      pass(downMat, mips[i]);
      src = mips[i];
    }
    // additive upsample back up the chain
    renderer.autoClear = false;
    for (let i = LEVELS - 1; i > 0; i--) {
      upMat.uniforms.tSrc.value = mips[i].texture;
      upMat.uniforms.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
      pass(upMat, mips[i - 1]);
    }
    renderer.autoClear = true;
    compMat.uniforms.uTime.value = t;
    pass(compMat, null);
    renderer.autoClear = prevAuto;
  }

  return { render, setSize, state, uniforms: compMat.uniforms, target: hdr };
}
