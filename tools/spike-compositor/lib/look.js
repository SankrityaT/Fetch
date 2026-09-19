// Pure frame planning for the spike: layout of the framed take in the output and a
// repeating zoom program, so every frame is a function of (source size, n, F) alone.
'use strict';

// Fit the take inside the output with padding, keeping its shape (never black bars).
function layout(W, H, sw, sh, { pad = 0.07 } = {}) {
  const maxW = W * (1 - 2 * pad), maxH = H * (1 - 2 * pad);
  const s = Math.min(maxW / sw, maxH / sh);
  const w = Math.round(sw * s), h = Math.round(sh * s);
  return [Math.round((W - w) / 2), Math.round((H - h) / 2), w, h];
}

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));

// Zoom state (scale, centre u, centre v) at time t: every 6 s rest, glide in to 1.8x over
// 0.7 s on a moving target, hold, glide out. Centre is clamped so the view stays inside.
const TARGETS = [[0.30, 0.30], [0.72, 0.40], [0.45, 0.70], [0.20, 0.62], [0.80, 0.78]];
function zoomAt(t, { depth = 1.8, period = 6, inAt = 1.5, outAt = 4.2, glide = 0.7 } = {}) {
  const k = Math.floor(t / period), u = t - k * period;
  const [tx, ty] = TARGETS[((k % TARGETS.length) + TARGETS.length) % TARGETS.length];
  const a = u < outAt ? ease((u - inAt) / glide) : 1 - ease((u - outAt) / glide);
  const s = 1 + (depth - 1) * a;
  const half = 0.5 / s;
  const cx = Math.min(1 - half, Math.max(half, 0.5 + (tx - 0.5) * a));
  const cy = Math.min(1 - half, Math.max(half, 0.5 + (ty - 0.5) * a));
  return [s, cx, cy];
}

// Full per-frame look. `identity` fills the output 1:1 with no treatment (colour tests).
function frameLook(W, H, sw, sh, n, fps, { identity = false, taps = 10, rect = null } = {}) {
  if (identity) {
    return { rect: rect || [0, 0, W, H], radius: 0, shadow: [0, 1, 0], z0: [1, 0.5, 0.5], z1: [1, 0.5, 0.5], taps: 1, bloom: 0, grain: 0, frame: n };
  }
  const t = n / fps, sh2 = 0.25 / fps; // 180 degree shutter
  const z0 = zoomAt(t - sh2), z1 = zoomAt(t + sh2);
  const moving = Math.abs(z0[0] - z1[0]) + Math.abs(z0[1] - z1[1]) + Math.abs(z0[2] - z1[2]) > 1e-5;
  return {
    rect: rect || layout(W, H, sw, sh), radius: Math.round(H * 0.018),
    shadow: [H * 0.018, H * 0.03, 0.55], z0, z1, taps: moving ? taps : 1,
    bloom: 0.35, grain: 0.035, frame: n,
  };
}

module.exports = { layout, zoomAt, frameLook, ease };
