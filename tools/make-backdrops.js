// The two drawn backdrops Fetch ships, generated rather than photographed.
//
//   node tools/make-backdrops.js [outDir]
//
// These two are materials: a woven linen and a blueprint grid, surfaces rather than
// pictures, and they are drawn because a photograph of a flat surface is a worse flat
// surface. Everything else in assets/backdrops is now a real photograph with a named
// photographer (assets/backdrops/credits.json). The three gradient skies this file used
// to draw, warm-dune, cold-harbour and deep-space, were the ones the person looked at
// and said we used to have better images: they were flat gradients because they were
// arithmetic. Their recipes are gone so a re-run cannot put them back.
//
// What is generated here carries no licence and needs no attribution: nothing is taken
// from anyone. Re-running writes the same bytes (the noise is seeded), so a backdrop can
// be changed by changing the recipe rather than by finding another picture.
//
// The one rule they all obey is the rule in assets/backdrops/PROMPTS.md: the middle of
// the frame stays quiet. The recording sits on top of it with an inset, and anything
// busy in the centre fights the thing being shown. Interest goes to the edges.
//
// 2560x1440, written as raw RGB and encoded to JPEG by the bundled ffmpeg.
'use strict'
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const W = 2560, H = 1440
const hex = s => [0, 2, 4].map(i => parseInt(s.slice(1 + i, 3 + i), 16) / 255)
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const sat = v => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = t => { const s = sat(t); return s * s * (3 - 2 * s) }

// one hash, used for every grain and every scatter, so the whole set is reproducible
function hash2(x, y, salt) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt | 0, 2246822519)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
// smooth value noise: the same hash read on a grid and interpolated
function noise(x, y, cell, salt) {
  const gx = x / cell, gy = y / cell
  const ix = Math.floor(gx), iy = Math.floor(gy)
  const fx = smooth(gx - ix), fy = smooth(gy - iy)
  const a = hash2(ix, iy, salt), b = hash2(ix + 1, iy, salt)
  const c = hash2(ix, iy + 1, salt), d = hash2(ix + 1, iy + 1, salt)
  const top = a + (b - a) * fx, bot = c + (d - c) * fx
  return top + (bot - top) * fy
}
// four octaves of it, each half the cell and half the weight, with the coordinates
// warped by the octave above: two octaves alone read as the grid they were built on
function fbm(x, y, cell, salt) {
  const wx = x + (noise(x, y, cell, salt + 101) - 0.5) * cell * 0.9
  const wy = y + (noise(x, y, cell, salt + 103) - 0.5) * cell * 0.9
  let v = 0, amp = 0.5, c = cell, total = 0
  for (let o = 0; o < 4; o++) { v += amp * noise(wx, wy, c, salt + o * 7); total += amp; amp *= 0.5; c *= 0.5 }
  return v / total
}
// how far in from the nearest edge, 0 at the edge and 1 well inside: what keeps the
// middle quiet without a vignette dark enough to read as a frame
const inset = (u, v) => smooth(Math.min(u, 1 - u, v, 1 - v) / 0.34)
// a round pool of light: v is scaled by the frame's shape so it stays round in pixels
const glow = (u, v, cx, cy, r) => Math.exp(-(((u - cx) ** 2 + ((v - cy) * (H / W)) ** 2)) / (2 * r * r))

// Each backdrop is a function of the pixel and its place in the frame, plus an optional
// pass over the finished buffer for anything that is easier to splat than to solve.
const BACKDROPS = {
  // Woven bone linen, lit flat. Plain in the material sense: a surface, not a colour.
  'linen-bone'(x, y, u, v) {
    const warp = 0.5 + 0.5 * Math.sin((x / 3.1) * Math.PI)
    const weft = 0.5 + 0.5 * Math.sin((y / 3.1) * Math.PI)
    const fibre = (warp * (0.5 + 0.5 * noise(x, y, 13, 41)) + weft * (0.5 + 0.5 * noise(y, x, 11, 43))) * 0.5
    const slub = noise(x, y, 170, 47) * 0.5 + noise(x, y, 41, 53) * 0.5
    let c = mix(hex('#E6DFD2'), hex('#F5F1E8'), 0.35 + 0.5 * slub)
    const shade = 1 - 0.055 * (1 - inset(u, v)) - 0.035 * (1 - fibre)
    return [c[0] * shade, c[1] * shade, c[2] * shade]
  },
  // A drafting sheet: fine white line work on deep navy, the dimensions and the ticks
  // gathered in the left and right margins where the recording is not.
  'blueprint-grid'(x, y, u, v) {
    const ground = mix(hex('#0E2136'), hex('#081525'), sat(v * 0.7 + u * 0.3))
    const line = hex('#BFD8E8')
    // distance to the nearest line of a grid, in pixels, so every rule is anti-aliased
    const rule = (p, step) => { const d = Math.abs(((p % step) + step) % step - step / 2); return step / 2 - d }
    let ink = 0
    ink = Math.max(ink, 0.16 * smooth((1.1 - rule(x, 64)) / 1.1))
    ink = Math.max(ink, 0.16 * smooth((1.1 - rule(y, 64)) / 1.1))
    ink = Math.max(ink, 0.34 * smooth((1.4 - rule(x, 320)) / 1.4))
    ink = Math.max(ink, 0.34 * smooth((1.4 - rule(y, 320)) / 1.4))
    // the margins: measurement ticks, and one arc swinging in from each side
    const margin = Math.max(smooth((0.17 - u) / 0.17), smooth((u - 0.83) / 0.17))
    if (margin > 0) {
      const tick = smooth((2.0 - rule(y, 32)) / 2.0) * smooth((Math.min(u, 1 - u) * W % 96 < 34 ? 1 : 0))
      ink = Math.max(ink, 0.5 * margin * tick)
      for (const cx of [-0.18, 1.18]) {
        const r = Math.hypot((u - cx) * 1.0, (v - 0.5) * (H / W))
        for (const rr of [0.34, 0.46]) ink = Math.max(ink, 0.42 * margin * smooth((0.0012 - Math.abs(r - rr)) / 0.0012))
      }
    }
    // the middle stays quiet: the grid fades as it crosses the recording's place
    ink *= 0.28 + 0.72 * (1 - inset(u, v))
    return mix(ground, line, ink)
  },
}

function render(name) {
  const fn = BACKDROPS[name]
  const buf = Buffer.allocUnsafe(W * H * 3)
  let i = 0
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H
    for (let x = 0; x < W; x++) {
      const c = fn(x, y, (x + 0.5) / W, v)
      buf[i++] = Math.round(sat(c[0]) * 255)
      buf[i++] = Math.round(sat(c[1]) * 255)
      buf[i++] = Math.round(sat(c[2]) * 255)
    }
  }
  return buf
}

const out = process.argv[2] || path.join(__dirname, '..', 'assets', 'backdrops')
const ffmpeg = path.join(__dirname, '..', 'vendor', 'ffmpeg')
fs.mkdirSync(out, { recursive: true })
for (const name of Object.keys(BACKDROPS)) {
  const dest = path.join(out, name + '.jpg')
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    '-s', `${W}x${H}`, '-i', 'pipe:0', '-q:v', '4', dest], { input: render(name) })
  if (r.status !== 0) { console.error(name, String(r.stderr)); process.exit(1) }
  console.log(`${name.padEnd(16)} ${(fs.statSync(dest).size / 1024).toFixed(0)} KB`)
}
