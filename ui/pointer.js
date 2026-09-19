// The agent's own cursor.
//
// An agent driving a browser through Playwright never moves the Mac's pointer, so a
// take it records shows either nothing happening or, worse, the person's own pointer
// wandering over the window while they work in front of it. Agent takes are recorded
// without the system cursor, and the agent says where its pointer is instead: each
// call to the pointer tool is stamped on the take's video clock, and the export draws
// Fetch's own cursor gliding between those points, pressing and rippling on clicks.
//
// A track is a list of { t, x, y, click } with t in seconds on the recording's clock
// and x, y as 0..1 fractions of the whole recorded frame (window or display), before
// any crop. Fractions of the recording rather than of the crop, because the track is
// a fact about the take and a crop drawn later must not move it.
//
// Pure: no Electron, no filesystem. main.js stamps, processor.js renders.

// The curve every travelling move in an export uses: zoompan's smoothstep in
// processor.js, and the spotlight riding a zoom (ui/overlays.js)
const Overlays = require('./overlays')
const ease = Overlays.MOVE
const clamp01 = n => Math.max(0, Math.min(1, n))
const r3 = n => Math.round(n * 1000) / 1000

// Wall-clock ms to ms on the video clock: frame zero is the recorder's firstFrame and
// paused spans are removed the way the recorder removes them (nativeCursorData in
// main.js does the same for the recorded cursor). null for a moment that is not in
// the video, unless snap is set, when it lands where the video resumes.
function videoClock(t0, gaps = [], pausedAt = 0) {
  const all = pausedAt ? [...gaps, [pausedAt, Infinity]] : gaps
  return (at, snap) => {
    if (at < t0) return snap ? 0 : null
    let t = at - t0
    for (const [a, b] of all) {
      if (at >= b) t -= b - a
      else if (at >= a) { if (!snap) return null; t -= at - a; break }
    }
    return Math.round(t)
  }
}

// A point in a browser page to a fraction of the browser window, which is what a
// window take records. The viewport sits below the tabs and toolbar, so the chrome
// is the difference between the outer and inner height; any side border (none on
// macOS) is split evenly. Page zoom must be 100% for CSS pixels to be window points.
function pageToWindow({ x, y, innerWidth, innerHeight, outerWidth, outerHeight }) {
  if (!(outerWidth > 0 && outerHeight > 0)) throw new Error('viewport needs outer_width and outer_height')
  const side = Math.max(0, (outerWidth - (innerWidth || outerWidth)) / 2)
  const top = Math.max(0, outerHeight - (innerHeight || outerHeight) - side)
  return { x: (side + x) / outerWidth, y: (top + y) / outerHeight }
}

// Where the page itself sits in the browser window, as fractions {x, y, w, h}: below
// the tabs and toolbar, with any side border split evenly (as pageToWindow places a
// point). null for a viewport that does not add up.
function viewportBox(v) {
  const ow = +v.outer_width, oh = +v.outer_height, iw = +v.inner_width || ow, ih = +v.inner_height || oh
  if (!(ow > 0 && oh > 0 && iw > 0 && ih > 0) || iw > ow + 1 || ih > oh + 1) return null
  const side = Math.max(0, (ow - iw) / 2), top = Math.max(0, oh - ih - side)
  const r = n => Math.round(n * 10000) / 10000
  return { x: r(side / ow), y: r(top / oh), w: r(Math.min(iw, ow) / ow), h: r(Math.min(ih, oh - top) / oh) }
}

// What the pointer tool was given, as a fraction of the recorded frame. Three forms:
// fractions (the default), page coordinates with the viewport's sizes, or screen
// points when window_relative is false, mapped against where the recorded window or
// display was at that moment (`bounds`, {x, y, width, height} in screen points).
// kind is what the take records: page coordinates only mean a place in the frame when
// the frame is the browser window.
function toFraction(a = {}, bounds = null, kind = null) {
  const x = +a.x, y = +a.y
  if (!isFinite(x) || !isFinite(y)) throw new Error('x and y are required numbers')
  let f
  if (a.viewport) {
    // a display take: the page's place on screen is not known from the viewport alone
    if (kind === 'display') throw new Error('viewport maps page pixels into a window take, and this take records the whole display. ' +
      'Send screen points with window_relative false instead: x = screenX + (outerWidth - innerWidth) / 2 + pageX, ' +
      'y = screenY + outerHeight - innerHeight + pageY')
    const v = a.viewport
    f = pageToWindow({ x, y, innerWidth: +v.inner_width, innerHeight: +v.inner_height,
      outerWidth: +v.outer_width, outerHeight: +v.outer_height })
  } else if (a.window_relative === false) {
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) throw new Error('the recorded window\'s position is not known yet; send fractions instead')
    f = { x: (x - bounds.x) / bounds.width, y: (y - bounds.y) / bounds.height }
  } else {
    // A value like 640 is a pixel, not a fraction. Saying so beats a cursor pinned to
    // the bottom-right corner for the whole video.
    if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) {
      throw new Error('x and y are fractions of the recorded window, 0 to 1. For page pixels send viewport; for screen points set window_relative false')
    }
    f = { x, y }
  }
  return { x: r3(clamp01(f.x)), y: r3(clamp01(f.y)) }
}

// Clean a track from any source (the sidecar, an agent's apply_edit): numbers only,
// in time order, clicks as booleans. An id is kept if it came with one.
function normalizeTrack(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter(p => p && isFinite(+p.t) && isFinite(+p.x) && isFinite(+p.y) && +p.t >= 0)
    .map(p => ({ ...(p.id ? { id: String(p.id) } : {}), t: r3(+p.t), x: r3(clamp01(+p.x)), y: r3(clamp01(+p.y)),
      ...(p.click ? { click: true } : {}) }))
    .sort((a, b) => a.t - b.t)
}

// The shape zoomMoments reads (processor.js): a "display" one unit across, so its
// clicks are already fractions of the frame and the crop is applied the usual way.
function asCursorData(track) {
  const pts = normalizeTrack(track)
  if (!pts.length) return null
  const ms = p => Math.round(p.t * 1000)
  return {
    kind: 'display', agent: true,
    display: { x: 0, y: 0, width: 1, height: 1 },
    points: pts.map(p => [ms(p), p.x, p.y]),
    clicks: pts.filter(p => p.click).map(p => [ms(p), p.x, p.y]),
  }
}

// ── motion ──────────────────────────────────────────────────────────────────
// Points arrive at the moment the agent acted, so the cursor has to be there by then:
// each glide ends on its point's time and starts as late as its length allows. A
// press is left to finish before the cursor moves on. Distances are in pixels of the
// frame the cursor is drawn into, so a glide's length follows how far it travels.
const MOVE = { min: 0.32, max: 0.8, perDiag: 0.9, afterClick: 0.26, jump: 0.06 }

function plan(points, { W = 1, H = 1 } = {}) {
  const diag = Math.hypot(W, H) || 1
  const moves = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    const dist = Math.hypot(b.x - a.x, b.y - a.y)
    if (dist < 0.5) continue
    // across a cut or the trim the cursor is simply there when the picture resumes
    if (b.jump) { moves.push({ from: b.t, to: b.t, x0: a.x, y0: a.y, x1: b.x, y1: b.y, cx: b.x, cy: b.y }); continue }
    const want = Math.min(MOVE.max, Math.max(MOVE.min, MOVE.min + MOVE.perDiag * dist / diag))
    const earliest = a.t + (a.click ? MOVE.afterClick : 0)
    let from = Math.max(earliest, b.t - want)
    // no room to glide: a quick move rather than a jump, keeping at least a short press
    if (b.t - from < MOVE.jump) {
      const press = a.click ? Math.min(MOVE.afterClick, (b.t - a.t) * 0.4) : 0
      from = Math.max(a.t + press, b.t - Math.min(want, 0.18))
    }
    // a slight arc, bowed up the way a wrist moves, reads as a hand rather than a tween
    const bow = Math.min(0.08 * dist, 0.02 * diag)
    const nx = -(b.y - a.y) / dist, ny = (b.x - a.x) / dist
    const s = ny > 0 ? -1 : 1
    moves.push({ from, to: b.t, x0: a.x, y0: a.y, x1: b.x, y1: b.y,
      cx: (a.x + b.x) / 2 + s * nx * bow, cy: (a.y + b.y) / 2 + s * ny * bow })
  }
  return { start: points.length ? points[0].t : 0, points, moves }
}

// Where the tip is at time t, or null before the cursor first appears
function positionAt(pl, t) {
  if (!pl.points.length || t < pl.start) return null
  for (const m of pl.moves) {
    if (t >= m.from && t < m.to) return bezier(m, ease((t - m.from) / (m.to - m.from)))
  }
  let last = pl.points[0]
  for (const p of pl.points) { if (p.t <= t) last = p; else break }
  return { x: last.x, y: last.y }
}

const bezier = (m, p) => ({
  x: (1 - p) * (1 - p) * m.x0 + 2 * (1 - p) * p * m.cx + p * p * m.x1,
  y: (1 - p) * (1 - p) * m.y0 + 2 * (1 - p) * p * m.cy + p * p * m.y1,
})

// ── drawing ─────────────────────────────────────────────────────────────────
// Fetch's own cursor, never the Mac's: a retriever gold arrow with a thin warm white
// edge, carrying a round Biscuit badge (assets/mascot/badge.png, idle.png cropped to
// the head) and, on the way to a click, a small "Biscuit" tag the way a collaborator's
// cursor is named in a shared document. A viewer reads it as the agent at a glance.
// The arrow, tip at 0,0, in macOS points (about 17 tall), is an ASS vector so it is
// crisp at any size and any zoom.
const ARROW = [[0, 0], [0, 15.2], [3.6, 11.8], [6.1, 17.4], [8.4, 16.4], [6, 10.9], [10.9, 10.9]]
const ARROW_H = 17.4
// The badge, in arrow heights from the tip: off the tail and clear of the tip, so it
// never covers what is being pointed at. agent-cursor.html (the live cursor) uses the
// same numbers.
const BADGE = { cx: 1.0, cy: 1.02, r: 0.38, file: 'assets/mascot/badge.png' }
// The tag marks the click, not the travel: it comes up just before the press, holds
// through it and fades once it is done. Shown for the whole glide it trailed the
// arrow across the frame and floated on after the click, pointing at nothing.
const TAG = { text: 'Biscuit', lead: 0.15, fadeIn: 0.1, hold: 0.15, fadeOut: 0.2 }
// ASS colours are &HBBGGRR&: --fur-1, --text-0, --ink-1, and --ink-0 for the arrow
const GOLD = '&H3CA9F0&', EDGE = '&HF8FAFB&', INK = '&H14171A&', ARROW_FILL = '&H08090A&'
// The arrow's size in the finished frame, whatever the recording's resolution: a
// macOS arrow a little larger than life, and the badge never too small to read
const LOOK = { arrow: 30, edge: 1.5, badgeMin: 18 }

// \p4 draws in eighths of a pixel, so the outline is placed to sub-pixel precision
function arrowPath(k) {
  const q = ([x, y]) => `${Math.round(x * k * 8)} ${Math.round(y * k * 8)}`
  return `m ${q(ARROW[0])} l ${ARROW.slice(1).map(q).join(' ')}`
}
// In positive coordinates only: libass anchors a drawing by its box from 0,0, so a
// circle drawn around the origin lands off centre and drifts as it scales.
function circlePath(r) {
  const R = Math.round(r * 8), c = Math.round(r * 8 * 0.5523)
  const v = (x, y) => `${R + x} ${R + y}`
  return `m ${v(0, -R)} b ${v(c, -R)} ${v(R, -c)} ${v(R, 0)} b ${v(R, c)} ${v(c, R)} ${v(0, R)} ` +
    `b ${v(-c, R)} ${v(-R, c)} ${v(-R, 0)} b ${v(-R, -c)} ${v(-c, -R)} ${v(0, -R)}`
}
// A pill w by h with fully round ends, from 0,0
function pillPath(w, h) {
  const r = h / 2, c = r * 0.5523
  const q = (x, y) => `${Math.round(x * 8)} ${Math.round(y * 8)}`
  return `m ${q(r, 0)} l ${q(w - r, 0)} b ${q(w - r + c, 0)} ${q(w, r - c)} ${q(w, r)} ` +
    `b ${q(w, r + c)} ${q(w - r + c, h)} ${q(w - r, h)} l ${q(r, h)} ` +
    `b ${q(r - c, h)} ${q(0, r + c)} ${q(0, r)} b ${q(0, r - c)} ${q(r - c, 0)} ${q(r, 0)}`
}

const assTime = s => {
  const cs = Math.max(0, Math.round(s * 100))
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, sec = (cs % 6000) / 100
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`
}
const px = n => Math.round(n * 10) / 10

/**
 * The cursor layer for one export, as an ASS script sized to the frame it is drawn
 * into (after the crop, before any zoom, so a zoom magnifies it with the content).
 *
 *   track   the pointer track, source clock, fractions of the recorded frame
 *   W, H    the frame in pixels
 *   clock   source seconds to output seconds (outClock), with .kept
 *   crop    the edit's crop, fractions, or null
 *   scale   the recorded display's backing scale, when known, so the arrow is the
 *           size a person would recognise; otherwise it is sized from the frame
 *   end     output duration, where the cursor's last line stops
 *   font    { family, measure } for the tag (processor.js assFonts), optional
 *
 * Returns null when there is nothing to draw. The badge is a picture, which ASS cannot
 * draw: pointerBadge says where it goes, and the export lays it over this.
 */
function pointerAss(track, opts = {}) {
  const L = cursorLayout(track, opts)
  if (!L) return null
  return drawCursor(L, opts)
}

/**
 * The badge for the same export, which the export lays over the cursor layer as a
 * picture: { d, start, stop, moves } with d its diameter in pixels and moves [t, x, y],
 * its top-left, at each frame (fps) where it lands somewhere new. Same options.
 */
function pointerBadge(track, opts = {}, fps = 30) {
  const L = cursorLayout(track, opts)
  if (!L) return null
  const d = 2 * Math.max(4, Math.round(BADGE.r * L.size), Math.round(LOOK.badgeMin * L.unit / 2))
  const ox = BADGE.cx * L.size - d / 2, oy = BADGE.cy * L.size - d / 2
  const moves = []
  let last = null
  for (let i = Math.ceil(L.pl.start * fps - 1e-6), n = Math.ceil(L.stop * fps); i <= n; i++) {
    const p = positionAt(L.pl, i / fps)
    if (!p) continue
    const x = Math.round(p.x + ox), y = Math.round(p.y + oy)
    if (last && last[1] === x && last[2] === y) continue
    moves.push(last = [r3(i / fps), x, y])
  }
  const spans = badgeSpans(L.pl)
  return { d, start: L.pl.start, stop: L.stop, moves, spans, alpha: badgeAlpha(spans), ...badgeExpr(L.pl, ox, oy) }
}

// The badge is Biscuit's signature on a click, nothing more: it comes up about 0.6 s
// before each click and is gone about 0.6 s after. Carried on every glide and for a
// moment after each landing, it sat on the card being narrated and badged, and the
// cursor looked busy while it only rested.
const BADGE_SHOW = { around: 0.6, fade: 0.2 }

// When the badge shows, [{ a, b }], merged where the gap is too short to fade through
function badgeSpans(pl) {
  const raw = []
  for (const p of pl.points) if (p.click) raw.push([p.t - BADGE_SHOW.around, p.t + BADGE_SHOW.around])
  raw.sort((x, y) => x[0] - y[0])
  const out = []
  for (const [a, b] of raw) {
    const last = out[out.length - 1]
    if (last && a <= last.b + 2 * BADGE_SHOW.fade) last.b = Math.max(last.b, b)
    // one that starts with the arrow is faded in by the arrow, never twice
    else out.push({ a: Math.max(pl.start, a), b, withArrow: a <= pl.start })
  }
  return out
}

// How opaque the badge is at t, 0 to 1
function badgeOpacity(spans, t) {
  for (const s of spans) {
    if (t < s.a || t > s.b) continue
    const up = s.withArrow ? 1 : (t - s.a) / BADGE_SHOW.fade
    return Math.max(0, Math.min(1, up, (s.b - t) / BADGE_SHOW.fade))
  }
  return 0
}

// The same as an ffmpeg expression of T, for geq on the badge picture
function badgeAlpha(spans) {
  const r2 = n => String(Math.round(n * 100) / 100), f = r2(BADGE_SHOW.fade)
  if (!spans.length) return '0'
  return spans.map(s => s.withArrow
    ? `between(T,${r2(s.a)},${r2(s.b)})*clip((${r2(s.b)}-T)/${f},0,1)`
    : `clip(min((T-${r2(s.a)})/${f},(${r2(s.b)}-T)/${f}),0,1)`).join('+')
}

// The badge's top-left as ffmpeg expressions of t, the overlay evaluating them on each
// frame. Commands sent frame by frame (sendcmd) raced the frames queued ahead of the
// overlay, so on a fast glide the badge led the arrow or waited at the target. Holds
// between glides are constants and each glide is its bezier on the same ease.
function badgeExpr(pl, ox, oy) {
  const r2 = n => String(Math.round(n * 100) / 100)
  const cuts = new Set(pl.points.map(p => p.t))
  for (const m of pl.moves) { cuts.add(m.from); cuts.add(m.to) }
  const ts = [...cuts].filter(t => t >= pl.start).sort((a, b) => a - b)
  // [until, fx, fy]: from the previous piece's end until this t, fx and fy say where
  const pieces = []
  for (let i = 0; i < ts.length; i++) {
    const a = ts[i], b = i + 1 < ts.length ? ts[i + 1] : Infinity
    const m = pl.moves.find(q => q.to > q.from && a >= q.from && a < q.to)
    let fx, fy
    if (m) {
      // p is the eased progress, kept in register 0; bezier as x0 + p(A + pB)
      const u = `(t-${r2(m.from)})/${r2(m.to - m.from)}`
      const p = `st(0,${u});st(0,ld(0)*ld(0)*(3-2*ld(0)))`
      const f = (v0, c, v1, o) => `${p};${r2(v0 + o)}+ld(0)*(${r2(2 * (c - v0))}+ld(0)*${r2(v0 - 2 * c + v1)})`
      fx = f(m.x0, m.cx, m.x1, ox); fy = f(m.y0, m.cy, m.y1, oy)
    } else {
      const q = positionAt(pl, a)
      fx = r2(q.x + ox); fy = r2(q.y + oy)
    }
    const prev = pieces[pieces.length - 1]
    if (prev && !m && prev.still && prev.fx === fx && prev.fy === fy) prev.until = b
    else pieces.push({ until: b, fx, fy, still: !m })
  }
  if (!pieces.length) return { x: '0', y: '0' }
  const nest = key => pieces.reduceRight((rest, k) =>
    k.until === Infinity ? k[key] : `if(lt(t,${r2(k.until)}),${k[key]},${rest})`, '')
  return { x: nest('fx'), y: nest('fy') }
}

// Everything both layers need: the points in frame pixels on the output clock, the
// plan of glides between them, the arrow's size and when the last line stops
function cursorLayout(track, { W, H, clock = t => t, crop = null, scale = null, end = 0, out = null, zooms = null } = {}) {
  const kept = clock.kept || (() => true)
  const c = crop && crop.w > 0 && crop.h > 0 ? crop : null
  // A point inside a cut or before the trim still says where the cursor was when the
  // picture resumes: it is carried to that moment (the last one wins) without its
  // click, so a trimmed opening does not lose the cursor until the agent's next call.
  const pts = []
  for (const p of normalizeTrack(track)) {
    const fx = c ? (p.x - c.x) / c.w : p.x, fy = c ? (p.y - c.y) / c.h : p.y
    const k = kept(p.t)
    const q = { t: clock(p.t), x: fx * W, y: fy * H, click: k && !!p.click, jump: !k }
    const prev = pts[pts.length - 1]
    if (prev && prev.jump && Math.abs(prev.t - q.t) < 0.005) { pts.pop(); q.jump = true }
    pts.push(q)
  }
  if (!pts.length) return null

  // A little larger than life, the way edited product films show it. out is output
  // pixels per pixel here before any zoom, so the arrow is sized for the finished
  // frame (about 30 px tall at 1080) rather than for the recording, which drew it a
  // dozen pixels tall on a Retina take. Clamped so a small window crop does not get
  // a giant arrow.
  const want = out > 0 ? LOOK.arrow / out : (scale > 0 ? 25 * scale : H * 0.03)
  const size = Math.max(H * 0.015, Math.min(H * 0.08, want))
  if (zooms && zooms.length) inView(pts, zooms, W, H, size)
  const pl = plan(pts, { W, H })
  const stop = Math.max(end || 0, pts[pts.length - 1].t + 1)
  return { W, H, pts, pl, size, k: size / ARROW_H, stop, unit: out > 0 ? 1 / out : size / LOOK.arrow }
}

// A cursor resting where a zoom has cut the frame away, or so near its edge the arrow
// is sliced by it, is drawn just inside instead: the narration still points there, and
// half an arrow on the frame's edge reads as a mistake. zooms are on the output clock
// in fractions of this frame, with x, y their focus (Overlays.zoomView). A click is
// where it happened and is never moved; a rest is judged at its tightest view.
function inView(pts, zooms, W, H, size) {
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    if (p.click || p.jump) continue
    const until = i + 1 < pts.length ? pts[i + 1].t : p.t + 1
    let v = null
    for (let k = 0; k <= 4; k++) {
      const q = Overlays.zoomView(zooms, p.t + (until - p.t) * k / 4)
      if (!v || q.s > v.s) v = q
    }
    if (!v || v.s <= 1.001) continue
    const x0 = v.x * W + size * 0.3, x1 = (v.x + v.w) * W - size * 0.8
    const y0 = v.y * H + size * 0.3, y1 = (v.y + v.h) * H - size * 1.2
    if (x1 > x0) p.x = Math.min(x1, Math.max(x0, p.x))
    if (y1 > y0) p.y = Math.min(y1, Math.max(y0, p.y))
  }
}

/**
 * Where a cursor resting on something points from: the nearest spot where the whole
 * arrow sits on clear ground (a gutter between cards, the blank side of a row), not on
 * words. An agent reports the centre of what it names, and a cursor parked there covered
 * the very words the narration was reading ("Up to 1 note at once"); moved just under
 * the label, its body still hung across the line below. px is a w x h grey frame of the
 * recording, p the rest in fractions; returns { x, y } fractions, or null when the arrow
 * is clear where it is or nothing clear is near.
 */
function restSpot(px, w, h, p) {
  const X = Math.round(p.x * w), Y = Math.round(p.y * h)
  if (!px || px.length < w * h || X < 4 || Y < 4 || X >= w - 4 || Y >= h - 4) return null
  const ink = (x, y) => {
    if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) return true
    const i = y * w + x, v = px[i]
    return Math.max(Math.abs(v - px[i + 1]), Math.abs(v - px[i + w])) >= 20
  }
  // the arrow's footprint below and right of its tip (about 30 px tall at 1080), with
  // room to breathe round it, as it is drawn on the recording before any zoom
  const A = Math.max(8, Math.round(h * 0.034)), Wd = Math.round(A * 0.66), air = Math.max(3, Math.round(A * 0.4))
  const clear = (x, y) => {
    for (let yy = y - air; yy <= y + A + air; yy++) for (let xx = x - air; xx <= x + Wd + air; xx++) if (ink(xx, yy)) return false
    return true
  }
  if (clear(X, Y)) return null
  const R = Math.round(h * 0.12), step = Math.max(2, Math.round(A / 7))
  let best = null
  for (let dy = -R; dy <= R; dy += step) {
    for (let dx = -R; dx <= R; dx += step) {
      const d = Math.hypot(dx, dy)
      if (d > R || (best && d >= best.d)) continue
      if (clear(X + dx, Y + dy)) best = { d, x: X + dx, y: Y + dy }
    }
  }
  return best ? { x: best.x / w, y: best.y / h } : null
}

// When the tag shows, [{ a, b, left }]: from just before each click until a moment
// after it. Clicks close together share one tag rather than blinking. left when the
// click is too near the right edge for the tag to fit.
function tagSpans(L, tagW) {
  const out = []
  for (const p of L.pts) {
    if (!p.click) continue
    const a = p.t - TAG.lead, b = p.t + TAG.hold + TAG.fadeOut
    const left = p.x + (BADGE.cx * L.size) + tagW > L.W - 4
    const last = out[out.length - 1]
    if (last && a <= last.b + 0.3 && last.left === left) last.b = b
    else out.push({ a: Math.max(L.pl.start, a), b, left })
  }
  return out
}

// How opaque the tag is at t, 0 to 1
function tagOpacity(spans, t) {
  for (const s of spans) {
    if (t < s.a || t > s.b) continue
    return Math.max(0, Math.min(1, (t - s.a) / TAG.fadeIn, (s.b - t) / TAG.fadeOut))
  }
  return 0
}

function drawCursor(L, { font = null } = {}) {
  const { W, H, pts, pl, size, k, stop } = L
  const bord = px(Math.max(0.8, LOOK.edge * L.unit))
  const arrow = arrowPath(k)

  const lines = []
  // The first appearance fades in over FADE_IN, whether it opens on a hold or on a
  // glide already under way: a line inside that span picks the fade up where the one
  // before it left off, so short glide pieces never pop to full strength.
  const FADE_IN = 0.16
  const fadeIn = (a, b) => {
    const into = a - pl.start
    if (into >= FADE_IN - 0.005) return ''
    const alphaAt = t => Math.round(255 * (1 - Math.min(1, Math.max(0, t - pl.start) / FADE_IN)))
    const e = Math.min(b, pl.start + FADE_IN), ms = Math.round((e - a) * 1000), all = Math.round((b - a) * 1000)
    return `\\fade(${alphaAt(a)},${alphaAt(e)},0,0,${ms},${all},${all})`
  }
  // The badge is laid over by the export, its soft shadow with it, so both can step
  // away together while the cursor rests (badgeSpans)
  const br = Math.max(BADGE.r * size, LOOK.badgeMin * L.unit / 2)
  // The tag: a gold pill tucked behind the badge, the name in rounded bold ink
  const tagH = br * 1.62, tagFs = tagH * 0.6
  const textW = font && font.measure ? font.measure(TAG.text, tagFs) : TAG.text.length * tagFs * 0.5
  const gap = tagH * 0.24, padR = tagH * 0.42
  const tagW = br + gap + textW + padR
  const spans = tagSpans(L, tagW)
  const tagFont = font && font.family ? `\\fn${font.family}\\b0` : '\\fnHelvetica\\b1'
  // the pill's end tucks well inside the badge, so no sliver shows round its edge
  const tuck = br * 0.5
  const tagPill = pillPath(tagW + tuck, tagH)
  // the tag's corner (its left end sits under the badge) and its text, from the tip
  const tagBox = left => ({ x: left ? BADGE.cx * size - tagW : BADGE.cx * size - tuck, y: BADGE.cy * size - tagH / 2 })
  const tagText = left => left ? { an: 6, x: BADGE.cx * size - br - gap, y: BADGE.cy * size }
    : { an: 4, x: BADGE.cx * size + br + gap, y: BADGE.cy * size }
  // P and Q are the tip at a and at b (Q null for a hold)
  const place = (P, Q, dx, dy) => Q
    ? `\\move(${px(P.x + dx)},${px(P.y + dy)},${px(Q.x + dx)},${px(Q.y + dy)})`
    : `\\pos(${px(P.x + dx)},${px(P.y + dy)})`
  const lerp = (P, Q, u) => Q ? { x: P.x + (Q.x - P.x) * u, y: P.y + (Q.y - P.y) * u } : P
  const tagLines = (a, b, P, Q) => {
    // cut where the tag's opacity changes slope, so each piece fades linearly
    const cuts = [a, b]
    for (const s of spans) for (const e of [s.a, s.a + TAG.fadeIn, s.b - TAG.fadeOut, s.b]) if (e > a && e < b) cuts.push(cs(e))
    cuts.sort((x, y) => x - y)
    for (let i = 1; i < cuts.length; i++) {
      const u = cuts[i - 1], v = cuts[i]
      if (!(v > u)) continue
      const mid = (u + v) / 2, s = spans.find(x => mid >= x.a && mid <= x.b)
      if (!s) continue
      const oa = tagOpacity(spans, u), ob = tagOpacity(spans, v)
      if (oa <= 0.004 && ob <= 0.004) continue
      const A = o => Math.round(255 * (1 - o)), ms = Math.round((v - u) * 1000)
      const alpha = `\\fade(${A(oa)},${A(ob)},${A(ob)},0,${ms},${ms},${ms})`
      const P1 = lerp(P, Q, (u - a) / (b - a)), Q1 = Q ? lerp(P, Q, (v - a) / (b - a)) : null
      const box = tagBox(s.left), tx = tagText(s.left)
      const tA = assTime(u), tB = assTime(v)
      lines.push(`Dialogue: 3,${tA},${tB},P,,0,0,0,,{\\an7${place(P1, Q1, box.x, box.y + 1.2 * k)}` +
        `\\bord0\\1c&H000000&\\1a&HA0&\\blur${px(2.4 * k)}${alpha}\\p4}${tagPill}`)
      lines.push(`Dialogue: 4,${tA},${tB},P,,0,0,0,,{\\an7${place(P1, Q1, box.x, box.y)}` +
        `\\bord${bord}\\1c${GOLD}\\3c${EDGE}\\blur${px(Math.max(0.4, 0.12 * k))}${alpha}\\p4}${tagPill}`)
      lines.push(`Dialogue: 5,${tA},${tB},P,,0,0,0,,{\\an${tx.an}${place(P1, Q1, tx.x, tx.y)}${tagFont}` +
        `\\fs${px(tagFs)}\\fsp${px(tagFs * 0.01)}\\bord0\\shad0\\1c${INK}${alpha}}${TAG.text}`)
    }
  }
  // shadows under, arrow over; the arrow's shadow is the same shape, blurred and dropped
  const cursorAt = (a, b, P, Q, extra = '') => {
    if (!(b > a)) return
    const fade = fadeIn(a, b)
    const tA = assTime(a), tB = assTime(b)
    lines.push(`Dialogue: 1,${tA},${tB},P,,0,0,0,,{\\an7${place(P, Q, 0, 1.3 * k)}\\bord${bord}` +
      `\\1c&H000000&\\3c&H000000&\\1a&H8C&\\3a&H8C&\\blur${px(2.2 * k)}${fade}${extra}\\p4}${arrow}`)
    // the macOS arrow: near-black, a crisp light edge, so it reads on light and dark UI
    lines.push(`Dialogue: 2,${tA},${tB},P,,0,0,0,,{\\an7${place(P, Q, 0, 0)}\\bord${bord}` +
      `\\1c${ARROW_FILL}\\3c${EDGE}\\blur${px(Math.max(0.3, 0.35 * L.unit))}${fade}${extra}\\p4}${arrow}`)
    if (spans.length) tagLines(a, b, P, Q)
  }

  // Walk the timeline: a hold at each point, a glide between them in short linear
  // pieces of the eased curve (\move is linear, so the curve is sampled every 40ms).
  // Boundaries are rounded to libass's centiseconds first, so pieces meet exactly.
  const cs = s => Math.round(s * 100) / 100
  const holdLine = (a, b, x, y) => {
    a = cs(a); b = cs(b)
    if (!(b > a)) return
    // presses that land inside this hold, relative to its start
    let press = ''
    for (const p of pts) {
      if (!p.click || p.t < a - 0.005 || p.t >= b) continue
      const r = Math.round((p.t - a) * 1000)
      // squeezed when the next glide leaves sooner, so it is back to full size by then
      const room = Math.max(40, Math.min(250, Math.round((b - p.t) * 1000)))
      const down = Math.round(room * 0.28)
      press += `\\t(${r},${r + down},\\fscx84\\fscy84)\\t(${r + down},${r + room},0.7,\\fscx100\\fscy100)`
    }
    cursorAt(a, b, { x, y }, null, press)
  }

  let t = pl.start, at = pts[0]
  for (const m of pl.moves) {
    holdLine(t, m.from, m.x0, m.y0)
    const n = Math.max(3, Math.min(24, Math.round((m.to - m.from) / 0.04)))
    let prevT = cs(m.from), prev = bezier(m, 0)
    for (let i = 1; i <= n; i++) {
      const ti = i === n ? cs(m.to) : cs(m.from + (m.to - m.from) * i / n)
      if (!(ti > prevT)) continue
      const q = bezier(m, ease((ti - m.from) / (m.to - m.from)))
      cursorAt(prevT, ti, prev, q)
      prevT = ti; prev = q
    }
    t = m.to
    at = { x: m.x1, y: m.y1 }
  }
  holdLine(t, stop, pl.moves.length ? at.x : pts[0].x, pl.moves.length ? at.y : pts[0].y)

  // A soft gold ring on each click, growing out from the tip and fading as it goes
  const R = Math.max(size * 1.1, 14)
  const ring = px(Math.max(1.5, size * 0.07))
  for (const p of pts) {
    if (!p.click) continue
    lines.push(`Dialogue: 0,${assTime(p.t)},${assTime(p.t + 0.56)},P,,0,0,0,,{\\an5\\pos(${px(p.x)},${px(p.y)})` +
      `\\bord${ring}\\blur${px(ring * 0.6)}\\1c&H3CA9F0&\\3c&H3CA9F0&\\1a&HE0&\\3a&H30&\\fscx30\\fscy30` +
      `\\t(0,560,0.45,\\fscx100\\fscy100\\1a&HFF&\\3a&HFF&)\\p4}${circlePath(R)}`)
  }

  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`,
    'ScaledBorderAndShadow: yes', 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, ' +
      'BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, ' +
      'BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: P,Helvetica,20,&H00141210,&H00141210,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...lines,
  ].join('\n') + '\n'
}

// ── the Mac's pointer, baked into the pixels ────────────────────────────────
// A take recorded with the system cursor has it in every frame, and an agent take
// from before they dropped it shows the person's pointer idling over the product.
// The recorded track (.cursor.json, screen points, ms on the video clock) says exactly
// where it was, so the export can lift it out. Each place it rested, and each stretch
// it travelled, becomes a box of the recorded frame for a span of time. The box is
// generous around the hot spot because the arrow, the hand and the I-beam all sit
// differently on it, and each carries a soft shadow. In points.
const BAKED = { left: 10, top: 12, right: 18, bottom: 25, still: 2.5, pad: 0.06, piece: 60, rest: 0.25 }

// The recorded frame in screen points at a moment: the window's bounds then, or the
// display. null while the window was off screen (another Space, minimised): the
// capture keeps its pixels but nothing composites the pointer into them.
function recordedBounds(data, ms) {
  if (data.kind === 'window') {
    const wins = Array.isArray(data.windowBounds) ? data.windowBounds : []
    if (!wins.length) return null
    let w = wins[0]
    for (const e of wins) { if (e[0] <= ms) w = e; else break }
    if (w[5] === 0 || !(w[3] > 0) || !(w[4] > 0)) return null
    return { x: w[1], y: w[2], w: w[3], h: w[4] }
  }
  const d = data.display
  return d && d.width > 0 && d.height > 0 ? { x: d.x, y: d.y, w: d.width, h: d.height } : null
}

/**
 * Where the recorded Mac pointer sat, as [{ a, b, x, y, w, h, rest }]: a, b seconds on
 * the recording's clock, x, y, w, h a box as fractions of the recorded frame (before
 * any crop), rest when it stayed put long enough to deserve a clean patch rather than
 * a fill. [] when the track says the pointer was never in the picture.
 */
function bakedCursorSpans(data) {
  if (!data || data.agent || data.inPicture === false || !Array.isArray(data.points)) return []
  const pts = data.points.filter(p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]))
    .sort((a, b) => a[0] - b[0])
  // Positions are kept relative to the recorded frame, which is what the pixels are:
  // a window nudged by two points under a still pointer has not moved it anywhere.
  // Only a resize changes what a point means.
  const same = (A, B) => A && B && A.w === B.w && A.h === B.h
  const raw = []
  const add = (a, b, B, x0, y0, x1, y1) => raw.push({ a, b, B,
    x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) })
  let cur = null, last = null, slides = 0
  const close = t => { if (cur) add(cur.t, t, cur.B, cur.x0, cur.y0, cur.x1, cur.y1); cur = null }
  for (const [t, sx, sy] of pts) {
    const B = recordedBounds(data, t)
    if (!B) { close(t); last = null; continue }
    const x = sx - B.x, y = sy - B.y
    if (cur && same(cur.B, B) && Math.abs(x - cur.ax) <= BAKED.still && Math.abs(y - cur.ay) <= BAKED.still) {
      cur.x0 = Math.min(cur.x0, x); cur.y0 = Math.min(cur.y0, y); cur.x1 = Math.max(cur.x1, x); cur.y1 = Math.max(cur.y1, y)
      last = { t, x, y, B, sx, sy }
      continue
    }
    close(t)
    // Between two samples it travelled a straight line over the picture, near enough at
    // 20Hz. A long line is cut into pieces so no single box covers half the screen, each
    // held for the whole step: the samples and the frames do not keep exact time with
    // each other. A window sliding under a still pointer (a Space switch) draws the
    // same line over a picture that is not changing, so its pieces are kept together
    // as one span the export can patch from a clean frame: filled edge to edge, a line
    // that long smeared across the UI it crossed.
    const slid = last && Math.abs(sx - last.sx) <= BAKED.still && Math.abs(sy - last.sy) <= BAKED.still
    if (last && same(last.B, B)) {
      const n = Math.max(1, Math.ceil(Math.hypot(x - last.x, y - last.y) / BAKED.piece))
      const gid = slid && n > 1 ? ++slides : 0
      for (let k = 0; k < n; k++) {
        const u = k / n, v = (k + 1) / n
        add(last.t, t, B,
          last.x + (x - last.x) * u, last.y + (y - last.y) * u, last.x + (x - last.x) * v, last.y + (y - last.y) * v)
        if (gid) raw[raw.length - 1].slide = gid
      }
    }
    cur = { t, ax: x, ay: y, x0: x, y0: y, x1: x, y1: y, B }
    last = { t, x, y, B, sx, sy }
  }
  // the last place it stood holds until the recording ends
  if (cur) close(Math.max(cur.t, last ? last.t : cur.t) + 1e9)

  // Short pieces in a row become one box while it stays small: a slow drag is one
  // span, not forty.
  const merged = []
  for (const s of raw) {
    const m = merged[merged.length - 1]
    const short = x => x.b - x.a < BAKED.rest
    if (m && !m.slide && !s.slide && short(m) && short(s) && same(m.B, s.B) && s.a <= m.b + 0.01 &&
        Math.max(m.x1, s.x1) - Math.min(m.x0, s.x0) <= BAKED.piece &&
        Math.max(m.y1, s.y1) - Math.min(m.y0, s.y0) <= BAKED.piece) {
      m.b = Math.max(m.b, s.b)
      m.x0 = Math.min(m.x0, s.x0); m.y0 = Math.min(m.y0, s.y0); m.x1 = Math.max(m.x1, s.x1); m.y1 = Math.max(m.y1, s.y1)
    } else merged.push({ ...s })
  }

  const out = []
  for (const s of merged) {
    const B = s.B
    const fx0 = clamp01((s.x0 - BAKED.left) / B.w), fy0 = clamp01((s.y0 - BAKED.top) / B.h)
    const fx1 = clamp01((s.x1 + BAKED.right) / B.w), fy1 = clamp01((s.y1 + BAKED.bottom) / B.h)
    if (!(fx1 > fx0) || !(fy1 > fy0)) continue          // wholly outside the recorded frame
    // the sampler runs a little behind the picture; a travelling box is kept tight in
    // time, because its fill is visible on a screen that has already settled
    const pad = s.b - s.a >= BAKED.rest * 1000 ? BAKED.pad : BAKED.pad / 2
    const a = Math.max(0, s.a / 1000 - pad), b = s.b / 1000 + pad
    const box = { a: r3(a), b: s.b >= 1e9 ? Infinity : r3(b),
      x: +fx0.toFixed(4), y: +fy0.toFixed(4), w: +(fx1 - fx0).toFixed(4), h: +(fy1 - fy0).toFixed(4),
      rest: s.b - s.a >= BAKED.rest * 1000 }
    // a slide's pieces become one span over their union, keeping the pieces for a fill
    const g = s.slide && out.find(o => o.slide === s.slide)
    if (!g) { out.push(s.slide ? { ...box, slide: s.slide, pieces: [{ x: box.x, y: box.y, w: box.w, h: box.h }] } : box); continue }
    const x1 = Math.max(g.x + g.w, box.x + box.w), y1 = Math.max(g.y + g.h, box.y + box.h)
    g.x = Math.min(g.x, box.x); g.y = Math.min(g.y, box.y)
    g.w = +(x1 - g.x).toFixed(4); g.h = +(y1 - g.y).toFixed(4)
    g.pieces.push({ x: box.x, y: box.y, w: box.w, h: box.h })
  }
  return out
}

// Whether a box of the recorded frame is clear of the baked pointer at time t, so a
// frame from then can patch a span where it was not
function clearOfCursor(spans, t, box) {
  return !spans.some(s => t >= s.a && t <= s.b &&
    s.x < box.x + box.w && box.x < s.x + s.w && s.y < box.y + box.h && box.y < s.y + s.h)
}

// ── clean plates ────────────────────────────────────────────────────────────
// Where the pointer rested, the spot is patched from a moment it was elsewhere. The
// pixel work is here, on rgb24 buffers of one region: the box plus a ring round it,
// reg = { w, h, bx, by, bw, bh } with the box's place inside the region. The ring is
// what decides whether two frames show the same screen, since the box has the pointer.
function eachRing(reg, fn) {
  for (let y = 0; y < reg.h; y++) {
    const inY = y >= reg.by && y < reg.by + reg.bh
    for (let x = 0; x < reg.w; x++) {
      if (inY && x >= reg.bx && x < reg.bx + reg.bw) continue
      fn((y * reg.w + x) * 3)
    }
  }
}

// Mean difference across the ring, 0 to 255
function ringDiff(a, b, reg) {
  let sum = 0, n = 0
  eachRing(reg, i => { sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n += 3 })
  return n ? sum / n : Infinity
}

// How a clean frame differs from a resting one just outside the box, carried across
// the box the way delogo carries edges: each pixel takes the four sides, weighted by
// nearness. A hover tints its row and not the one above, so the difference is not
// flat, but it is smooth. The residual is how much it jumps walking round the box:
// the same screen under a tint barely moves, a changed one (other text, a moved
// panel) jumps at every stroke.
function plateFit(here, there, reg) {
  const { w, h, bx, by, bw, bh } = reg
  const side = (n, at) => {
    const out = []
    for (let k = 0; k < n; k++) {
      const acc = [0, 0, 0]
      let m = 0
      for (let depth = 1; depth <= 3; depth++) {
        const q = at(k, depth)
        if (!q || q[0] < 0 || q[1] < 0 || q[0] >= w || q[1] >= h) continue
        const i = (q[1] * w + q[0]) * 3
        for (let c = 0; c < 3; c++) acc[c] += here[i + c] - there[i + c]
        m++
      }
      out.push(m ? acc.map(v => v / m) : null)
    }
    return out
  }
  const T = side(bw, (k, d) => [bx + k, by - d]), B = side(bw, (k, d) => [bx + k, by + bh - 1 + d])
  const L = side(bh, (k, d) => [bx - d, by + k]), R = side(bh, (k, d) => [bx + bw - 1 + d, by + k])
  // round the box: top left to right, down the right, bottom right to left, up the left
  const loop = [...T, ...R, ...B.slice().reverse(), ...L.slice().reverse()].filter(Boolean)
  if (loop.length < 8) return { residual: Infinity }
  let jump = 0, big = 0
  for (let k = 1; k < loop.length; k++) {
    for (let c = 0; c < 3; c++) { jump += Math.abs(loop[k][c] - loop[k - 1][c]); big = Math.max(big, Math.abs(loop[k][c])) }
  }
  const residual = big > 64 ? Infinity : jump / ((loop.length - 1) * 3)
  const corr = new Float32Array(bw * bh * 3)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const parts = [[L[y], x + 1], [R[y], bw - x], [T[x], y + 1], [B[x], bh - y]].filter(p => p[0])
      let sw = 0
      const v = [0, 0, 0]
      for (const [d, dist] of parts) { const wt = 1 / dist; sw += wt; for (let c = 0; c < 3; c++) v[c] += d[c] * wt }
      for (let c = 0; c < 3; c++) corr[(y * bw + x) * 3 + c] = sw ? v[c] / sw : 0
    }
  }
  return { residual, corr }
}

/**
 * The patch for the box, rgba of bw x bh: the clean frame, corrected, opaque only
 * where the pointer is in any of the resting frames and feathered over a pixel or
 * two, so text beside the pointer is never swapped for an older copy of itself.
 * also marks more of the box as pointer (see boxMoved).
 */
function platePixels(frames, there, corr, reg, { threshold = 24, grow = 0, also = null } = {}) {
  const { bw, bh } = reg
  const hit = also ? Uint8Array.from(also) : new Uint8Array(bw * bh)
  // i indexes the region, the correction is the box's own
  const clean = (i, c) => {
    const x = (i / 3) % reg.w - reg.bx, y = Math.floor(i / 3 / reg.w) - reg.by
    return Math.max(0, Math.min(255, Math.round(there[i + c] + corr[(y * bw + x) * 3 + c])))
  }
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = ((reg.by + y) * reg.w + reg.bx + x) * 3
      for (const f of frames) {
        if (Math.abs(f[i] - clean(i, 0)) > threshold || Math.abs(f[i + 1] - clean(i, 1)) > threshold ||
            Math.abs(f[i + 2] - clean(i, 2)) > threshold) { hit[y * bw + x] = 1; break }
      }
    }
  }
  // grown by the pointer's soft shadow, then a feather beyond that
  const D = grow || Math.max(2, Math.round(bw / 12)), F = 2
  const out = Buffer.alloc(bw * bh * 4)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let best = Infinity
      for (let dy = -(D + F); dy <= D + F && best > 0; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= bh) continue
        for (let dx = -(D + F); dx <= D + F; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= bw || !hit[yy * bw + xx]) continue
          const d = Math.hypot(dx, dy)
          if (d < best) best = d
        }
      }
      const a = best <= D ? 255 : best <= D + F ? Math.round(255 * (1 - (best - D) / (F + 1))) : 0
      const i = ((reg.by + y) * reg.w + reg.bx + x) * 3, o = (y * bw + x) * 4
      out[o] = clean(i, 0); out[o + 1] = clean(i, 1); out[o + 2] = clean(i, 2); out[o + 3] = a
    }
  }
  return out
}

// Marks, in hit (bw x bh), wherever a frame's box differs from the first frame's: the
// pointer changing shape (an arrow becoming a hand) inside one stretch of a rest
function boxMoved(hit, f, rep, reg, threshold = 24) {
  for (let y = 0; y < reg.bh; y++) {
    for (let x = 0; x < reg.bw; x++) {
      const i = ((reg.by + y) * reg.w + reg.bx + x) * 3
      if (Math.abs(f[i] - rep[i]) > threshold || Math.abs(f[i + 1] - rep[i + 1]) > threshold ||
          Math.abs(f[i + 2] - rep[i + 2]) > threshold) hit[y * reg.bw + x] = 1
    }
  }
  return hit
}

module.exports = {
  ease, videoClock, pageToWindow, viewportBox, toFraction, normalizeTrack, asCursorData,
  plan, positionAt, pointerAss, pointerBadge, badgeSpans, badgeOpacity, restSpot, inView, ARROW_H, BADGE, TAG, tagOpacity, LOOK,
  bakedCursorSpans, clearOfCursor, ringDiff, plateFit, platePixels, boxMoved, BAKED,
}
