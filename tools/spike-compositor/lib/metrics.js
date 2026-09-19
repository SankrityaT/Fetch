// Pure image metrics for the parity checks: CIEDE2000 on flat patches, per-channel LSB
// differences, timing summaries. No DOM, so node can test it directly.
'use strict';

function srgbToLab(r, g, b) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
  const Z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// CIEDE2000 (Sharma, Wu, Dalal 2005).
function dE2000(a, b) {
  const [L1, a1, b1] = a, [L2, a2, b2] = b;
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (x, y) => { if (x === 0 && y === 0) return 0; const v = Math.atan2(y, x) * deg; return v < 0 ? v + 360 : v; };
  const h1p = h(a1p, b1), h2p = h(a2p, b2);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) { if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360; hbp /= 2; }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
    + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.20 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh));
}

// Mean colour of a (2r+1)^2 patch and its luma standard deviation, RGBA buffer.
function patch(img, W, x, y, r) {
  let n = 0, s = [0, 0, 0], l2 = 0, l1 = 0;
  for (let j = y - r; j <= y + r; j++) for (let i = x - r; i <= x + r; i++) {
    const o = (j * W + i) * 4; s[0] += img[o]; s[1] += img[o + 1]; s[2] += img[o + 2];
    const l = 0.2126 * img[o] + 0.7152 * img[o + 1] + 0.0722 * img[o + 2]; l1 += l; l2 += l * l; n++;
  }
  return { rgb: s.map((v) => v / n), sd: Math.sqrt(Math.max(0, l2 / n - (l1 / n) ** 2)) };
}

// dE2000 between two frames on a grid of flat patches inside `rect` (flat in the reference,
// so chroma-siting differences at edges do not count as colour error).
function patchDeltaE(ref, test, W, rect, { cols = 32, rows = 18, r = 6, flat = 1.5 } = {}) {
  const [rx, ry, rw, rh] = rect; const out = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = Math.round(rx + (i + 0.5) * rw / cols), y = Math.round(ry + (j + 0.5) * rh / rows);
    const a = patch(ref, W, x, y, r); if (a.sd > flat) continue;
    const b = patch(test, W, x, y, r);
    out.push({ x, y, ref: a.rgb.map(Math.round), test: b.rgb.map(Math.round), dE: dE2000(srgbToLab(...a.rgb), srgbToLab(...b.rgb)) });
  }
  const d = out.map((p) => p.dE).sort((a, b) => a - b);
  return { patches: out.length, mean: d.reduce((a, b) => a + b, 0) / (d.length || 1), max: d[d.length - 1] || 0,
    p95: d[Math.floor(d.length * 0.95)] || 0, worst: out.sort((a, b) => b.dE - a.dE).slice(0, 3) };
}

// Per-channel absolute differences in 8-bit steps (LSB) inside rect.
function lsbDiff(a, b, W, rect) {
  const [rx, ry, rw, rh] = rect.map(Math.round); const hist = new Array(256).fill(0); let sum = 0, n = 0;
  for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) {
    const o = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) { const d = Math.abs(a[o + c] - b[o + c]); hist[d]++; sum += d; n++; }
  }
  const pct = (q) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= q * n) return i; } return 255; };
  let max = 0; for (let i = 255; i >= 0; i--) if (hist[i]) { max = i; break; }
  let over2 = 0; for (let i = 3; i < 256; i++) over2 += hist[i];
  return { mean: sum / n, p99: pct(0.99), p999: pct(0.999), max, over2LSBpct: 100 * over2 / n, samples: n };
}

function summary(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b); const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const r = (v) => Math.round(v * 1000) / 1000;
  return { mean: r(mean), p50: r(s[Math.floor(s.length * 0.5)]), p95: r(s[Math.floor(s.length * 0.95)]), max: r(s[s.length - 1]), n: s.length };
}

module.exports = { srgbToLab, dE2000, patch, patchDeltaE, lsbDiff, summary };
