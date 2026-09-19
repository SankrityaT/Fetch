// Lift and spotlight as the compositor draws them: each one's shape, how far in it is at
// a moment, and how a zoom it rides is framed around it. Pure: no DOM, no filesystem
// (test/focus.test.js).
//
// A lift raises the element itself. The box is the whole element, grown out to its own
// hairline when the take was prepared (Overlays.edgeFit), cut out with the element's own
// corner radius (Overlays.cornerRadius) and a few pixels of its page so its border comes
// up whole. The real pixels of each frame come up 3 to 6 percent over two shadows (a
// tight contact shadow that grounds it, a wide soft key shadow that floats it) while the
// page behind steps back: blurred and dimmed by multiplication, so it keeps its colour,
// less right at the piece and more with distance, so it reads as depth rather than as a
// grey wash with a hole in it. A spotlight keeps the page in place: a feathered window
// at full light in a dimmed, lightly blurred frame.
//
// Every size is in pixels of the finished frame through the zoom the mark is seen in
// (`out`, finished pixels per content pixel), so a lift looks the same whatever the
// recording's resolution and however far a zoom pushes in. Content pixels are pixels of
// the cropped recording.

const Overlays = require('../overlays')

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const smooth01 = v => { const p = clamp(v, 0, 1); return p * p * (3 - 2 * p) }

// Finished pixels at 1080. A big card rises 3 percent, a chip 6: the same few pixels of
// travel either way, which is what the eye reads as height.
const LIFT = {
  pad: 3,
  scaleBig: 1.03, scaleSmall: 1.06, bigAt: 380, smallAt: 70,
  // the page stepping back: how much light it loses, at the piece and far from it
  // On a light UI a page dimmed by a third went a flat grey: the blur and the shadow
  // carry the depth, the dim only steps the page back
  dim: 0.26, dimSmall: 0.3, near: 0.35, nearPx: 110, farPx: 700,
  blur: 5,
  // key: the light above casting down; contact: where the piece still nearly touches
  key: { dy: 22, sigma: 30, alpha: 0.5 },
  keySmall: { dy: 12, sigma: 18, alpha: 0.46 },
  contact: { dy: 3, sigma: 5, alpha: 0.32 },
  // air kept between the raised piece (its shadow and any step badge on it) and the edge
  // of what is on screen, a share of the view: at 4 percent a card grid filled the zoom
  // edge to edge with its badges cut by the top of the frame
  air: 0.08,
}
const SPOT = { padPill: 3, pad: 12, featherPill: 6, feather: 12, dim: Overlays.SPOT_DIM, blur: 2.5 }

/**
 * The shape of a lift or spotlight on the cropped recording (W x H content pixels).
 *   m      the mark, fractions of the cropped frame (prepared: fitted, radius measured)
 *   out    finished pixels per content pixel, through the zoom it is mostly seen in
 *   o      the look: { dim } a spotlight's dim, { lift } a lift's scale when set away
 *          from its default (1.04), which otherwise follows the element's size
 * Returns { kind, x, y, w, h, r, ... } in content pixels: the box with its pad, its
 * corners, and for a lift its scale, shadows and the page's dim and blur; for a
 * spotlight its feather, dim and blur.
 */
function shape(m, W, H, out = 1, o = {}) {
  const kind = m && m.kind === 'lift' ? 'lift' : 'spotlight'
  const u = 1 / Math.max(1e-3, out)
  const bx = clamp(+m.x || 0, 0, 1) * W, by = clamp(+m.y || 0, 0, 1) * H
  const bw = Math.max(2, Math.min(W - bx, (+m.w > 0 ? +m.w : 0.2) * W))
  const bh = Math.max(2, Math.min(H - by, (+m.h > 0 ? +m.h : 0.1) * H))
  // a short wide thing (a toast, a button, a search field) is a pill, hugged closer
  const pill = bh / u < 100 && bw > bh * 2.5
  const pad = (kind === 'lift' ? LIFT.pad : pill ? SPOT.padPill : SPOT.pad) * u
  const x = Math.max(0, bx - pad), y = Math.max(0, by - pad)
  const w = Math.min(W, bx + bw + pad) - x, h = Math.min(H, by + bh + pad) - y
  // the element's own corners where they were measured, concentric with the pad; else
  // a pill's round ends, or corners sized to the card
  const own = +m.radius > 0 ? +m.radius + pad : null
  // A lift that could not measure its corner keeps a modest one, never a pill's round
  // ends: a table row lifted as a capsule was not the row any more
  const r = Math.min(w / 2, h / 2, own != null ? own : pill && kind === 'spotlight' ? h / 2 : clamp(Math.min(bw, bh) * 0.06, 8 * u, 18 * u) + pad)
  if (kind === 'spotlight') {
    const dim = o.dim != null && Number.isFinite(+o.dim) ? clamp(+o.dim, 0, 0.9) : SPOT.dim
    return { kind, x, y, w, h, r, feather: (pill ? SPOT.featherPill : SPOT.feather) * u, dim, blur: SPOT.blur * u }
  }
  const big = Math.max(bw, bh) / u
  const small = clamp((LIFT.bigAt - big) / (LIFT.bigAt - LIFT.smallAt), 0, 1)
  const key = small > 0.5 ? LIFT.keySmall : LIFT.key
  return {
    kind, x, y, w, h, r,
    lift: o.lift != null && Math.abs(+o.lift - 1.04) > 1e-6 && Number.isFinite(+o.lift) ? clamp(+o.lift, 1, 1.15)
      : +(LIFT.scaleBig + (LIFT.scaleSmall - LIFT.scaleBig) * small).toFixed(4),
    dim: LIFT.dim + (LIFT.dimSmall - LIFT.dim) * small,
    near: LIFT.near, nearPx: LIFT.nearPx * u, farPx: LIFT.farPx * u,
    blur: LIFT.blur * u,
    key: { dy: key.dy * u, sigma: key.sigma * u, alpha: key.alpha },
    contact: { dy: LIFT.contact.dy * u, sigma: LIFT.contact.sigma * u, alpha: LIFT.contact.alpha },
    nudge: { dx: 0, dy: 0 },
  }
}

// How far the raised piece, its shadow and the step badges riding it (s.margin) reach
// past its box, content pixels, per side
function reach(s) {
  const g = s.lift ? (s.lift - 1) / 2 : 0
  const k = s.key || { dy: 0, sigma: 0 }
  const m = s.margin || 0
  return {
    l: Math.max(m, s.w * g + k.sigma * 1.2), r: Math.max(m, s.w * g + k.sigma * 1.2),
    t: Math.max(m, s.h * g + Math.max(0, k.sigma * 1.2 - k.dy)), b: Math.max(m, s.h * g + k.dy + k.sigma * 1.6),
  }
}

/**
 * The composition rule: a zoom a lift rides is framed so the raised piece, its shadow
 * and some air sit inside it. A zoom aimed on the element (so most of the element is in
 * its view) is pulled back as far as the raised piece needs and centred on it, held in
 * by the frame's edge as every zoom is. Zooms elsewhere are left alone.
 *   zooms   on the output clock, fractions of the cropped frame
 *   lifts   [{ tm, box: {x, y, w, h} fractions, shape }] (shape in content pixels)
 * Returns the zooms, re-framed where they needed it, each with `reframed` saying so.
 */
function reframe(zooms, lifts, W, H) {
  if (!lifts.length) return zooms
  const list = (zooms || []).map(z => {
    const scale = Math.max(1, +z.scale || 1)
    const vw = 1 / scale
    const view = { x: clamp((z.x != null ? z.x : 0.5) - vw / 2, 0, 1 - vw), y: clamp((z.y != null ? z.y : 0.5) - vw / 2, 0, 1 - vw), w: vw, h: vw }
    for (const L of lifts) {
      const { tm, box, shape: s } = L
      // rides it: most of the lift's time is inside the zoom's
      const both = Math.min(z.end, tm.b) - Math.max(z.start, tm.a)
      if (!(both > 0.4 * (tm.b - tm.a) || both > 1.2)) continue
      // aimed at it: most of the element is on screen through the zoom
      const ix = Math.min(box.x + box.w, view.x + view.w) - Math.max(box.x, view.x)
      const iy = Math.min(box.y + box.h, view.y + view.h) - Math.max(box.y, view.y)
      if (!(ix > 0 && iy > 0 && ix * iy >= 0.5 * box.w * box.h)) continue
      const e = reach(s)
      const gx0 = (s.x - e.l) / W, gx1 = (s.x + s.w + e.r) / W, gy0 = (s.y - e.t) / H, gy1 = (s.y + s.h + e.b) / H
      const need = Math.max((gx1 - gx0) / (1 - 2 * LIFT.air), (gy1 - gy0) / (1 - 2 * LIFT.air))
      const fit = 1 / need
      const cx = (gx0 + gx1) / 2, cy = (gy0 + gy1) / 2
      // already frames it with air: leave the person's or agent's zoom exactly as it is
      const a = LIFT.air * vw
      if (scale <= fit + 1e-6 && gx0 >= view.x + a - 1e-6 && gx1 <= view.x + vw - a + 1e-6 &&
        gy0 >= view.y + a - 1e-6 && gy1 <= view.y + vw - a + 1e-6) continue
      const s2 = Math.max(1, Math.min(scale, fit))
      const h2 = 1 / s2 / 2
      const nx = clamp(cx, h2, 1 - h2), ny = clamp(cy, h2, 1 - h2)
      return { ...z, scale: Math.round(s2 * 1000) / 1000, x: Math.round(nx * 10000) / 10000, y: Math.round(ny * 10000) / 10000, reframed: true }
    }
    return z
  })
  // A moment that hands over to the next one carries where the camera was when it did
  // (`from`), and auto zoom's moments arrive with that already worked out
  // (ui/compositor/prepare.js). Re-framing a moment moves the camera the one after it
  // pans from, and nothing downstream rebuilds it: left alone, the pan started from a
  // position that no longer existed and the window jumped on the handover frame.
  for (let i = 1; i < list.length; i++) {
    const p = list[i - 1], n = list[i]
    if (!p.reframed || !n.from) continue
    const px = p.x != null ? p.x : 0.5, py = p.y != null ? p.y : 0.5
    const d = Math.hypot((n.x != null ? n.x : 0.5) - px, (n.y != null ? n.y : 0.5) - py)
    list[i] = { ...n, from: { x: px, y: py, scale: p.scale, dip: Overlays.panDip(p.scale, n.scale, d) } }
  }
  return list
}

/**
 * Where the raised piece moves as it rises, content pixels, so it keeps air from the
 * edge of what is on screen: a card a hair from the frame's edge comes up and a little
 * in, toward the viewer, rather than flush against the edge. view is what is on screen
 * while the lift is fully up, fractions of the cropped frame (the whole frame with no
 * zoom). Never more than a sixth of the piece's own size.
 */
function nudge(s, view, W, H) {
  if (!s.lift) return { dx: 0, dy: 0 }
  const e = reach(s)
  const air = LIFT.air * Math.min(view.w * W, view.h * H)
  const vx0 = view.x * W + air, vx1 = (view.x + view.w) * W - air
  const vy0 = view.y * H + air, vy1 = (view.y + view.h) * H - air
  const x0 = s.x - e.l, x1 = s.x + s.w + e.r, y0 = s.y - e.t, y1 = s.y + s.h + e.b
  const fit = (lo, hi, a, b) => (hi - lo < b - a ? (lo + hi) / 2 - (a + b) / 2 : lo > a ? lo - a : hi < b ? hi - b : 0)
  const dx = fit(vx0, vx1, x0, x1), dy = fit(vy0, vy1, y0, y1)
  const cap = (v, n) => clamp(v, -n / 6, n / 6)
  return { dx: Math.round(cap(dx, s.w) * 10) / 10, dy: Math.round(cap(dy, s.h) * 10) / 10 }
}

// How far in a lift or spotlight is at t, 0 to 1, on the zoom's curve
const level = (tm, t) => Overlays.focusLevel(tm, t)

module.exports = { shape, reframe, nudge, reach, level, LIFT, SPOT, smooth01 }
