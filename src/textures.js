// ── Procedural canvas textures ──────────────────────────────────────────────
import * as THREE from 'three';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(size, draw, { repeat = [1, 1], srgb = true, aniso = 4 } = {}) {
  const c = document.createElement('canvas');
  c.width = size[0]; c.height = size[1];
  draw(c.getContext('2d'), c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  return tex;
}

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

export function makeTextures() {
  const rng = mulberry32(1234);
  const T = {};

  T.grass = canvasTexture([512, 512], (ctx, w, h) => {
    noiseFill(ctx, w, h, rng, '#4e6b2f', 0.10, 9000);
    // mid-scale patchiness
    for (let i = 0; i < 60; i++) {
      const g = 70 + rng() * 90;
      ctx.fillStyle = `rgba(${g * 0.55},${g},${g * 0.3},${0.08 + rng() * 0.12})`;
      ctx.beginPath();
      ctx.ellipse(rng() * w, rng() * h, 30 + rng() * 90, 20 + rng() * 60, rng() * 3, 0, 7);
      ctx.fill();
    }
    for (let i = 0; i < 2600; i++) {
      const x = rng() * w, y = rng() * h;
      const g = 90 + rng() * 70;
      ctx.strokeStyle = `rgba(${g * 0.55},${g},${g * 0.32},0.35)`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y);
      ctx.lineTo(x + (rng() - 0.5) * 5, y - 3 - rng() * 5); ctx.stroke();
    }
  }, { repeat: [40, 40] });

  // huge soft blotches, laid over the floor at very low frequency to break
  // up grass tiling across the ring
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

  T.dirt = canvasTexture([256, 256], (ctx, w, h) => {
    noiseFill(ctx, w, h, rng, '#7a6448', 0.13, 5000);
  }, { repeat: [30, 30] });

  T.asphalt = canvasTexture([256, 256], (ctx, w, h) => {
    noiseFill(ctx, w, h, rng, '#3c3f44', 0.10, 6000);
  }, { repeat: [3, 200] });

  T.plaza = canvasTexture([512, 512], (ctx, w, h) => {
    noiseFill(ctx, w, h, rng, '#9a938a', 0.06, 4000);
    ctx.strokeStyle = 'rgba(40,38,35,0.45)'; ctx.lineWidth = 3;
    const step = w / 8;
    for (let i = 0; i <= 8; i++) {
      ctx.beginPath(); ctx.moveTo(i * step, 0); ctx.lineTo(i * step, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * step); ctx.lineTo(w, i * step); ctx.stroke();
    }
  }, { repeat: [8, 8] });

  T.hull = canvasTexture([512, 512], (ctx, w, h) => {
    noiseFill(ctx, w, h, rng, '#b8bcc2', 0.05, 3000);
    ctx.strokeStyle = 'rgba(70,76,86,0.55)'; ctx.lineWidth = 4;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath(); ctx.moveTo(i * w / 4, 0); ctx.lineTo(i * w / 4, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * h / 4); ctx.lineTo(w, i * h / 4); ctx.stroke();
    }
    for (let i = 0; i < 260; i++) {
      const x = rng() * w, y = rng() * h;
      ctx.fillStyle = 'rgba(60,64,72,0.5)';
      ctx.beginPath(); ctx.arc(x, y, 1.6, 0, 7); ctx.fill();
    }
  }, { repeat: [220, 3] });

  // House wall variants: plaster with framed windows + a door
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
        }
      }
    };
  }
  T.wallA = canvasTexture([512, 256], wallDraw('#d8cfc0', '#7d6a55'));
  T.wallB = canvasTexture([512, 256], wallDraw('#c2ccd4', '#4c5a66'));
  T.wallC = canvasTexture([512, 256], wallDraw('#d9c4a9', '#8a5a40'));

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
        for (let c = 0; c < cols; c++) {
          const x = (c + 0.18) * (w / cols), y = f * floorH + floorH * 0.22;
          const ww = (w / cols) * 0.64, wh = floorH * 0.56;
          ctx.fillStyle = trim; ctx.fillRect(x - 3, y - 3, ww + 6, wh + 6);
          const sky = ctx.createLinearGradient(0, y, 0, y + wh);
          sky.addColorStop(0, '#8fa9bd'); sky.addColorStop(1, '#42566a');
          ctx.fillStyle = sky; ctx.fillRect(x, y, ww, wh);
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
    noiseFill(ctx, w, h, rng, '#6d4438', 0.08, 2500);
    ctx.strokeStyle = 'rgba(30,18,14,0.5)'; ctx.lineWidth = 2;
    for (let y = 0; y < h; y += 16) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      for (let x = (y / 16) % 2 ? 16 : 0; x < w; x += 32) {
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 16); ctx.stroke();
      }
    }
  }, { repeat: [2, 2] });

  T.roofSlate = canvasTexture([256, 256], (ctx, w, h) => {
    noiseFill(ctx, w, h, rng, '#4a5058', 0.08, 2500);
    ctx.strokeStyle = 'rgba(15,18,22,0.5)'; ctx.lineWidth = 2;
    for (let y = 0; y < h; y += 14) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }, { repeat: [2, 2] });

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

  T.water = canvasTexture([256, 256], (ctx, w, h) => {
    noiseFill(ctx, w, h, rng, '#2e5f6e', 0.05, 2000);
    for (let i = 0; i < 60; i++) {
      ctx.strokeStyle = 'rgba(210,235,240,0.12)'; ctx.lineWidth = 1.5;
      const y = rng() * h;
      ctx.beginPath(); ctx.moveTo(0, y);
      ctx.bezierCurveTo(w * 0.3, y + 6, w * 0.6, y - 6, w, y); ctx.stroke();
    }
  }, { repeat: [12, 12] });

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
