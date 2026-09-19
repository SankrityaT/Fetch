// Pure-logic checks for the spike: node tools/spike-compositor/test.js
'use strict';
const assert = require('assert');
const M = require('./lib/metrics');
const { layout, zoomAt, frameLook } = require('./lib/look');

// CIEDE2000 against Sharma, Wu and Dalal's published test pairs.
for (const [a, b, want] of [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
  [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0000],
  [[50, 2.5, 0], [73, 25, -18], 27.1492],
  [[2.0776, 0.0795, -1.1350], [0.9033, -0.0636, -0.5514], 0.9082],
]) assert(Math.abs(M.dE2000(a, b) - want) < 1e-3, `dE2000 ${a} ${b} = ${M.dE2000(a, b)}, want ${want}`);
assert.strictEqual(M.dE2000(M.srgbToLab(10, 200, 30), M.srgbToLab(10, 200, 30)), 0);
const white = M.srgbToLab(255, 255, 255);
assert(Math.abs(white[0] - 100) < 0.01 && Math.abs(white[1]) < 0.01 && Math.abs(white[2]) < 0.01, 'sRGB white is L 100');

// LSB diff: one channel off by 3 on one pixel of a 4x4 frame.
const a = new Uint8Array(64).fill(100), b = a.slice(); b[20] = 103;
const d = M.lsbDiff(a, b, 4, [0, 0, 4, 4]);
assert.strictEqual(d.max, 3); assert.strictEqual(d.samples, 48); assert(Math.abs(d.over2LSBpct - 100 / 48) < 1e-9);

// Layout keeps the take's shape inside the output (the background fills the rest).
for (const [sw, sh] of [[2884, 1780], [3024, 1964], [1080, 1920], [3840, 1080]]) {
  const [x, y, w, h] = layout(1920, 1080, sw, sh);
  assert(x >= 0 && y >= 0 && x + w <= 1920 && y + h <= 1080, 'inside the frame');
  assert(Math.abs(w / h - sw / sh) < 0.01, 'aspect kept');
}

// Zoom never shows outside the take, and rests at 1x between moves.
for (let t = -1; t < 40; t += 0.013) {
  const [s, cx, cy] = zoomAt(t);
  assert(s >= 1 && s <= 1.8 + 1e-9);
  assert(cx - 0.5 / s >= -1e-9 && cx + 0.5 / s <= 1 + 1e-9 && cy - 0.5 / s >= -1e-9 && cy + 0.5 / s <= 1 + 1e-9, `inside at ${t}`);
}
assert.deepStrictEqual(zoomAt(0.5), [1, 0.5, 0.5]);

// Motion blur only while the camera moves; still frames take one tap.
assert.strictEqual(frameLook(1920, 1080, 2884, 1780, 30, 60).taps, 1);
assert.strictEqual(frameLook(1920, 1080, 2884, 1780, Math.round(1.85 * 60), 60).taps, 10);
assert.strictEqual(frameLook(1920, 1080, 2884, 1780, 0, 60).taps, 1, 'frame 0 has no negative-time zoom');

console.log('spike-compositor: all pure checks passed');
