// A simulator, as a thing Fetch can hold.
//
// simctl knows about devices and knows nothing about windows; ScreenCaptureKit knows
// about windows and knows nothing about devices. Neither of them knows where the phone
// screen sits inside the window that is being recorded, and that rectangle is the whole
// point: without it a simulator capture is a picture of a Mac window, and with it the
// capture crops to the glass, a tap in device points becomes a fraction of the frame,
// and the drawn shell in ui/compositor/plan.js is the only shell in the picture.
//
// So this file does three joins and one piece of arithmetic:
//
//   1. `list devices -j` against `list runtimes -j` or `list devicetypes -j`, for the
//      product family, because a device record does not say whether it is a phone.
//   2. The device type against its own profile.plist, which is the only place on this
//      Mac that the native framebuffer size exists. Read once per device type.
//   3. The device against the window list, by the device name in the window title.
//   4. The device screen's rectangle inside the window, as fractions, plus the density
//      that rectangle achieves against the device's own pixels.
//
// The fourth one is read off a capture of the window, not worked out from the other
// three. Fitting the screen's aspect inside the window is out by 12 percent on a phone
// with a notch and 19 percent on one with a home button, because Simulator's chrome is a
// 52 point toolbar and an 11 point clear gap at any window scale plus a bezel drawn at
// the scale, so the glass is a different fraction of every window and moves again when
// the person resizes it. measureGlass reads the rectangle off the pixels instead and
// lands on the device's own aspect to better than 0.05 percent. Where nothing has been
// measured there is no rectangle: see simulators().
//
// Pure. No spawning, no filesystem, no Electron: the caller hands in stdout and the
// window list, which is what makes every number below testable under node. The one
// filesystem shape that leaks in is profilePath(), and even that is a string.
//
// Nothing here is cached across calls. `list devices -j` is under a fifth of a second
// on this Mac and the person creates and deletes devices between turns, so a stale
// model is a worse bargain than a re-read.

// simctl prints usage to stdout when it fails, so a parse failure means the caller
// handed us a failure and read the wrong stream.
function asJson(src, what) {
  if (src && typeof src === 'object') return src
  if (typeof src !== 'string' || !src.trim()) return null
  try { return JSON.parse(src) } catch (e) {
    throw new Error(`simctl ${what} did not return JSON. On failure simctl writes usage to stdout and the reason to stderr; read stderr and the exit code instead.`)
  }
}

const r4 = n => Math.round(n * 10000) / 10000
const r2 = n => Math.round(n * 100) / 100
const num = v => (Number.isFinite(+v) ? +v : null)

// Family from the identifier, for the case where neither runtimes nor devicetypes were
// handed in. Better than calling an iPad a phone and framing it like one.
function familyFromId(id = '') {
  if (/Apple-Watch/i.test(id)) return 'Apple Watch'
  if (/Apple-TV/i.test(id)) return 'Apple TV'
  if (/iPad/i.test(id)) return 'iPad'
  if (/iPhone/i.test(id)) return 'iPhone'
  return null
}

/**
 * `list devices -j`, flattened. The top level is keyed by runtime identifier, runtimes
 * with no devices are present with an empty array, and an entry can carry an
 * availabilityError instead of being absent. isAvailable is the field to filter on.
 */
function parseDevices(src, o = {}) {
  const j = asJson(src, 'list devices -j')
  const byRuntime = (j && j.devices) || {}
  const out = []
  for (const runtimeId of Object.keys(byRuntime)) {
    const list = byRuntime[runtimeId]
    if (!Array.isArray(list)) continue
    for (const d of list) {
      if (!d || !d.udid) continue
      if (!o.unavailable && d.isAvailable === false) continue
      out.push({
        udid: String(d.udid),
        name: String(d.name || ''),
        // a display string, never an enum: Booting and Shutting Down both happen
        state: String(d.state || 'Unknown'),
        deviceTypeId: d.deviceTypeIdentifier || null,
        runtimeId,
        ...(d.availabilityError ? { availabilityError: String(d.availabilityError) } : {}),
      })
    }
  }
  return out
}

/** `list runtimes -j` to `{identifier: {name, version, platform, types}}`. */
function parseRuntimes(src) {
  const j = asJson(src, 'list runtimes -j')
  const out = {}
  for (const r of (j && j.runtimes) || []) {
    if (!r || !r.identifier) continue
    out[r.identifier] = {
      name: r.name || r.identifier,
      version: r.version || null,
      platform: r.platform || null,
      isAvailable: r.isAvailable !== false,
      types: Array.isArray(r.supportedDeviceTypes) ? r.supportedDeviceTypes : [],
    }
  }
  return out
}

/**
 * Device types by identifier. `list devicetypes -j` is the direct source; a runtime's
 * supportedDeviceTypes carries the same four fields and is free with the runtimes call,
 * so either will do and both together is fine.
 */
function parseDeviceTypes(src, into = {}) {
  const j = asJson(src, 'list devicetypes -j')
  const list = Array.isArray(j) ? j
    : (j && (j.devicetypes || j.supportedDeviceTypes)) || []
  for (const t of list) {
    if (!t || !t.identifier) continue
    into[t.identifier] = {
      name: t.name || t.identifier,
      family: t.productFamily || familyFromId(t.identifier),
      bundlePath: t.bundlePath || null,
      modelIdentifier: t.modelIdentifier || null,
    }
  }
  return into
}

/** Every device type a runtime list mentions, folded into the same map. */
function deviceTypesFromRuntimes(runtimes, into = {}) {
  for (const id of Object.keys(runtimes || {})) parseDeviceTypes((runtimes[id] || {}).types || [], into)
  return into
}

/**
 * Where a device type's profile.plist lives. It is a binary plist, so the caller reads
 * it through `plutil -convert json -o - <path>` and hands the text to parseProfile:
 * this file stays pure and no plist parser enters the repo.
 */
function profilePath(type) {
  const bundle = typeof type === 'string' ? type : (type && type.bundlePath)
  if (!bundle) return null
  return `${bundle}/Contents/Resources/profile.plist`
}

/**
 * The only place the native framebuffer exists. Pixels, and the scale that turns them
 * into the points a tap is expressed in.
 */
function parseProfile(src) {
  const j = asJson(src, 'profile.plist')
  if (!j) return null
  const w = num(j.mainScreenWidth), h = num(j.mainScreenHeight)
  const scale = num(j.mainScreenScale) || 1
  if (!(w > 0 && h > 0 && scale > 0)) return null
  return { w, h, scale, points: { w: r2(w / scale), h: r2(h / scale) } }
}

/**
 * Profiles for a set of device type identifiers, read at most once per type. Two booted
 * iPhone 16s share a profile; reading it per device would read it twice for one answer.
 * `load` is injected: a function from path to the plist as JSON text, or null.
 */
function readProfiles(typeIds, types, load, into = {}) {
  for (const id of typeIds) {
    if (!id || id in into) continue
    const path = profilePath(types && types[id])
    // A profile that will not parse is a device whose screen is not known, which is a
    // value this model already has a place for. It is not an exception out of a join.
    let got = null
    try { got = path ? parseProfile(load(path)) : null } catch { got = null }
    into[id] = got || null
  }
  return into
}

// Simulator has put the runtime, and sometimes the app, after the device name, with
// a different dash in different versions. Named by code point, because the long dashes
// are the one thing this repo never writes out.
const SEP = new RegExp('\\s[' + [0x2010, 0x2013, 0x2014, 0x2022].map(c => String.fromCharCode(c)).join('') + '-]\\s|\\s\\(')

function titleSegments(title) {
  return String(title || '').split(SEP).map(s => s.replace(/\)\s*$/, '').trim()).filter(Boolean)
}

// How well a window title claims a device name. Exact beats prefix beats a segment, so
// "iPhone 16" does not steal the window belonging to "iPhone 16 Pro".
function claim(title, name) {
  if (!name) return 0
  const t = String(title || '').trim()
  if (t === name) return 3
  const segs = titleSegments(t)
  if (segs[0] === name) return 2
  if (segs.includes(name)) return 1
  return 0
}

const inset = c => ({
  top: num(c && c.top) || 0, right: num(c && c.right) || 0,
  bottom: num(c && c.bottom) || 0, left: num(c && c.left) || 0,
})

// ── the glass, read off the pixels ───────────────────────────────────────

// A pixel is clear where nothing of the window is there at all: Simulator's toolbar
// floats over a transparent gap, and that gap is what separates the toolbar from the
// device in a capture.
const CLEAR_A = 8
// The bezel's inner ring reads 0 on all three channels. 12 leaves room for the encoder
// without taking in anything an app would call a dark grey.
const DARK = 12
// How many dark pixels in a row make a ring. The art's outer edge is one or two dark
// pixels under the highlight, and the inner ring measured 13 to 15 points on every
// device here, so 3 tells them apart at any capture scale.
const RING = 3
// How far a fitted rectangle's shape may sit from the screen's before it is refused.
const FIT_TOL = 0.015
// A measured rectangle is held to a tenth of that: the three captures here agreed with
// the device's own aspect to better than 0.05 percent, so anything past this is the
// measurement having found something other than the glass.
const GLASS_TOL = 0.0015
// Plus what whole pixels cannot help. An edge is found to the pixel, so each side can be
// one out, and on a 360 pixel wide glass that alone is half a percent: a fixed 0.15
// percent turned a correct rectangle down on a third of window sizes and on most 1x
// displays, which refused every tap on them. Two pixels a side is the rounding with room.
const glassTol = px => GLASS_TOL + (px && px.w > 0 && px.h > 0 ? 2 / px.w + 2 / px.h : 0)

// RGBA bytes, the shape an ImageData or a raw frame already has.
function frameOf(frame) {
  const w = num(frame && (frame.width != null ? frame.width : frame.w))
  const h = num(frame && (frame.height != null ? frame.height : frame.h))
  const data = frame && frame.data
  if (!(w > 0 && h > 0) || !data || data.length < w * h * 4) return null
  return { w, h, data }
}

// clear, dark or lit, which is all this measurement reads. Colour never comes into it:
// the app can be any colour it likes and the ring is still the ring.
function classify(f) {
  const cls = new Uint8Array(f.w * f.h)
  for (let i = 0, p = 0; i < cls.length; i++, p += 4) {
    if (f.data[p + 3] <= CLEAR_A) continue
    const m = Math.max(f.data[p], f.data[p + 1], f.data[p + 2])
    cls[i] = m <= DARK ? 1 : 2
  }
  return cls
}

// Walk in from one end of a scan line: past the clear, past the bezel's grey, and stop
// at the first lit pixel that follows a run of dark. That run is the ring the glass sits
// inside, which is why this cannot be fooled by the grey band outside it.
function ringEdge(at, lo, hi, forward) {
  let run = 0
  for (let i = forward ? lo : hi; forward ? i <= hi : i >= lo; forward ? i++ : i--) {
    const c = at(i)
    if (c === 1) { run++; continue }
    if (c === 2 && run >= RING) return i
    run = 0
  }
  return null
}

// The value most scan lines agreed on, with how many of them did. A mode rather than an
// extreme in either direction: a dark app pushes a candidate inward and a home button
// below the glass pushes one outward, and only the mode survives both.
function agreed(vals) {
  const count = new Map()
  for (const v of vals) count.set(v, (count.get(v) || 0) + 1)
  let best = null, n = 0
  for (const [v, c] of count) if (c > n || (c === n && v < best)) { best = v; n = c }
  return vals.length ? { at: best, agree: r4(n / vals.length) } : { at: null, agree: 0 }
}

/**
 * Where the device screen actually is inside a captured Simulator window, in the capture's
 * own pixels.
 *
 * The rectangle cannot be derived. Simulator's chrome is a 52 point toolbar and an 11
 * point gap whatever the window scale, plus a bezel drawn at the window scale, so the
 * glass is a different fraction of the window on every device and moves again whenever
 * the person resizes it. It can be read, though, because a capture of that window has
 * the whole structure in it: a toolbar band, a band of fully clear pixels, then the
 * device, and inside the device a grey bezel, a black ring and the app.
 *
 * So: take the tallest run of rows that hold any window at all as the device, and from
 * each side of it find the first lit pixel after a run of dark. Measured against three
 * booted devices this lands on the device's own aspect to better than 0.05 percent.
 *
 * Returns {ok, value:{capture, px, rect, agree}} or {ok:false, reason}. Pixels, not
 * fractions, because density wants them and a fraction has already lost them.
 */
function measureGlass(frame) {
  const f = frameOf(frame)
  if (!f) return { ok: false, reason: 'that is not a frame: measuring the glass wants a capture of the Simulator window as RGBA bytes with its own width and height.' }
  const cls = classify(f)
  const row = y => x => cls[y * f.w + x]
  const col = x => y => cls[y * f.w + x]

  // Bands of rows that hold any window at all. The toolbar is one and the device is
  // another, and the clear gap between them is what makes them two.
  const bands = []
  for (let y = 0; y < f.h; y++) {
    let any = false
    for (let x = 0; x < f.w && !any; x++) if (cls[y * f.w + x]) any = true
    if (any) { if (bands.length && bands[bands.length - 1].y1 === y - 1) bands[bands.length - 1].y1 = y; else bands.push({ y0: y, y1: y }) }
  }
  if (!bands.length) return { ok: false, reason: 'the capture is empty: every pixel of it is transparent.' }
  const body = bands.reduce((a, b) => (b.y1 - b.y0 > a.y1 - a.y0 ? b : a))
  let x0 = f.w, x1 = -1
  for (let y = body.y0; y <= body.y1; y++) {
    for (let x = 0; x < x0; x++) if (cls[y * f.w + x]) { x0 = x; break }
    for (let x = f.w - 1; x > x1; x--) if (cls[y * f.w + x]) { x1 = x; break }
  }
  if (x1 < x0) return { ok: false, reason: 'no device was found in the capture: the window has no opaque body in it.' }

  // The middle half of each axis. The corners are rounded and the bezel's buttons stick
  // out of the sides, and neither has anything to say about where the glass is.
  const lefts = [], rights = [], tops = [], bottoms = []
  for (let y = body.y0 + ((body.y1 - body.y0) >> 2); y < body.y1 - ((body.y1 - body.y0) >> 2); y++) {
    const at = row(y)
    const l = ringEdge(at, x0, x1, true), r = ringEdge(at, x0, x1, false)
    if (l != null && r != null && r > l) { lefts.push(l); rights.push(r) }
  }
  for (let x = x0 + ((x1 - x0) >> 2); x < x1 - ((x1 - x0) >> 2); x++) {
    const at = col(x)
    const t = ringEdge(at, body.y0, body.y1, true), b = ringEdge(at, body.y0, body.y1, false)
    if (t != null && b != null && b > t) { tops.push(t); bottoms.push(b) }
  }
  const L = agreed(lefts), R = agreed(rights), T = agreed(tops), B = agreed(bottoms)
  if (L.at == null || R.at == null || T.at == null || B.at == null) {
    return { ok: false, reason: 'no ring was found around a screen in this capture. A window with its bezels hidden has none to find, and a frame captured while the device was still booting is all one colour.' }
  }
  const agree = Math.min(L.agree, R.agree, T.agree, B.agree)
  // A quarter of the scan lines is a long way short of a majority and still means the
  // edge was seen on hundreds of rows. Below it the app is painting over the ring and
  // the number that would come back is the app's own dark edge, not the glass.
  if (agree < 0.25) {
    return { ok: false, reason: `the edges of the screen did not agree across the capture (${Math.round(agree * 100)} percent), which is what an app painted black to its own edge looks like. Shoot again on a screen with something on it.` }
  }
  const px = { x: L.at, y: T.at, w: R.at - L.at + 1, h: B.at - T.at + 1 }
  if (!(px.w > f.w / 4 && px.h > f.h / 8)) {
    return { ok: false, reason: 'what was measured is too small to be a device screen, so nothing is reported rather than a rectangle nothing is on.' }
  }
  const corner = cornerOf(row, x0, x1, px)
  return { ok: true, value: {
    capture: { w: f.w, h: f.h }, px, agree,
    rect: { x: r4(px.x / f.w), y: r4(px.y / f.h), w: r4(px.w / f.w), h: r4(px.h / f.h) },
    ...(corner ? { corner } : {}),
  } }
}

// How far into the glass a corner may reach before it is not a corner: a quarter of the
// short side. The ProMax's measured 0.158, so this is room, not a guess at a device.
const CORNER_MAX = 0.25

/**
 * How round the glass is, read off the same ring the rectangle was.
 *
 * The screen is a rounded rectangle and the rectangle measured above is its bounding
 * box, so each corner of that box holds a crescent of the Simulator's own bezel. A crop
 * to the box keeps the crescents, and inside Fetch's phone they read as a second bezel
 * peeking out (.context/survey/st-taste.md, section 5). No radius per device type: the
 * art changes with Xcode, and the ring is right here in the pixels.
 *
 * Walking down from each corner, the ring's inner edge sits d pixels in from the glass's
 * side on the row t pixels from its top. The circle that hides that bezel pixel passes
 * through (d, t + 0.5) from the corner, which is R = d + t' + sqrt(2 d t'). The largest
 * over a corner's rows is the smallest circle that hides every one of them: Apple's
 * corner is a continuous curve with a long tail, and a circle fitted to its middle
 * leaves one pixel of ring along that tail. A corner whose rows never come back to the
 * side is an app dark to its own edge, not glass, and is left out; of the rest the
 * smallest is taken, since an app can only push a corner inward, never out.
 *
 * Returns { px, share } with share the radius over the glass's short side, which is the
 * same number whatever size the glass is drawn at and whichever way up, or null.
 */
function cornerOf(row, x0, x1, px) {
  const reach = Math.floor(Math.min(px.w, px.h) * CORNER_MAX)
  const each = []
  for (const top of [true, false]) {
    for (const left of [true, false]) {
      let R = 0, closed = false
      for (let t = 0; t < reach; t++) {
        const e = ringEdge(row(top ? px.y + t : px.y + px.h - 1 - t), x0, x1, left)
        if (e == null) break
        const d = left ? e - px.x : px.x + px.w - 1 - e
        if (d <= 0) { closed = true; break }
        const tp = t + 0.5
        R = Math.max(R, d + tp + Math.sqrt(2 * d * tp))
      }
      if (closed) each.push(R)
    }
  }
  if (!each.length) return null
  const R = Math.min(...each)
  // A square screen (an iPhone SE's) closes on its first row: no corner to hide.
  if (!(R >= 1)) return null
  // Rounded up, never down: a radius a hundredth short leaves the last ring pixel out.
  const up = Math.ceil(R * 100) / 100
  return { px: up, share: Math.ceil(up / Math.min(px.w, px.h) * 1e4) / 1e4 }
}

// How far outside the stored rectangle the ring is looked for. The ring measured 13 to 15
// points on every device here, so six pixels starts inside it at any capture scale, and
// it keeps the walk off the window's edge, which in a recording is black and not clear.
const NEAR = 6

/**
 * The glass's corner, for a take whose document has the rectangle and not the corner:
 * everything captured before the corner was measured. The frame is one frame of the take
 * itself (RGBA, as measureGlass takes it) and the viewport is the rectangle the document
 * already carries, as fractions of that frame.
 *
 * measureGlass cannot simply be run again on it. A recording has no alpha, so the clear
 * gap under the toolbar is black and the device is no longer a band of its own; and the
 * rectangle is already known. So the edges are found again only near where the document
 * says they are, which corrects the fractions' rounding to the frame's own pixels, and
 * then the corner is read off the same ring by the same rule as a new capture's.
 *
 * Returns {ok, value:{px, share, rect}} or {ok:false, reason}. share is the number a
 * viewport's `corner` is. A square screen answers ok with no corner at all.
 */
function measureCorner(frame, viewport) {
  const f = frameOf(frame)
  if (!f) return { ok: false, reason: 'that is not a frame: the corner is read off a frame of the take as RGBA bytes with its own width and height.' }
  const v = viewport && viewport.value ? viewport.value : viewport
  const r = v && (v.rect || v)
  if (!r || !(num(r.w) > 0 && num(r.h) > 0) || num(r.x) == null || num(r.y) == null) {
    return { ok: false, reason: 'there is no rectangle to read a corner round: the take has no measured glass.' }
  }
  const gx = r.x * f.w, gy = r.y * f.h, gw = r.w * f.w, gh = r.h * f.h
  const x0 = Math.max(0, Math.floor(gx) - NEAR), x1 = Math.min(f.w - 1, Math.ceil(gx + gw) + NEAR)
  const y0 = Math.max(0, Math.floor(gy) - NEAR), y1 = Math.min(f.h - 1, Math.ceil(gy + gh) + NEAR)
  if (!(x1 - x0 > 2 * NEAR && y1 - y0 > 2 * NEAR)) return { ok: false, reason: 'the rectangle is too small to be a device screen in this frame.' }
  const cls = classify(f)
  const row = y => x => cls[y * f.w + x]
  const col = x => y => cls[y * f.w + x]
  const lefts = [], rights = [], tops = [], bottoms = []
  const my = (y1 - y0) >> 2, mx = (x1 - x0) >> 2
  for (let y = y0 + my; y < y1 - my; y++) {
    const l = ringEdge(row(y), x0, x1, true), rr = ringEdge(row(y), x0, x1, false)
    if (l != null && rr != null && rr > l) { lefts.push(l); rights.push(rr) }
  }
  for (let x = x0 + mx; x < x1 - mx; x++) {
    const t = ringEdge(col(x), y0, y1, true), b = ringEdge(col(x), y0, y1, false)
    if (t != null && b != null && b > t) { tops.push(t); bottoms.push(b) }
  }
  const L = agreed(lefts), R = agreed(rights), T = agreed(tops), B = agreed(bottoms)
  if (L.at == null || R.at == null || T.at == null || B.at == null) {
    return { ok: false, reason: 'no ring was found round the glass in this frame, which is what a frame from before the device finished booting looks like.' }
  }
  if (Math.min(L.agree, R.agree, T.agree, B.agree) < 0.25) {
    return { ok: false, reason: 'the edges of the screen did not agree across this frame, which is what an app dark to its own edge looks like. Read a frame with something on the screen.' }
  }
  const px = { x: L.at, y: T.at, w: R.at - L.at + 1, h: B.at - T.at + 1 }
  // Found again, not found somewhere else: two pixels a side is the rounding with room,
  // the same allowance glassTol makes, and anything past it is not the stored glass.
  if (Math.abs(px.x - gx) > 2 || Math.abs(px.y - gy) > 2 || Math.abs(px.x + px.w - gx - gw) > 2 || Math.abs(px.y + px.h - gy - gh) > 2) {
    return { ok: false, reason: 'the ring in this frame is not where the document says the glass is, so no corner is read off it.' }
  }
  const corner = cornerOf(row, x0, x1, px)
  return { ok: true, value: { px: corner ? corner.px : 0, share: corner ? corner.share : 0,
    rect: { x: r4(px.x / f.w), y: r4(px.y / f.h), w: r4(px.w / f.w), h: r4(px.h / f.h) } } }
}

// A measured glass, handed in as measureGlass returned it or as plain fractions, as the
// fractions of the frame everything downstream reads. Checked against the device's own
// aspect first: a rectangle of the wrong shape is a measurement that found something
// other than the screen, and a tap aimed through it lands as wrongly as the fit does.
function glassViewport(glass, screen, o = {}) {
  const m = glass && glass.value ? glass.value : glass
  const rect = m && (m.rect || (num(m.w) > 0 && num(m.x) != null ? m : null))
  if (!rect || !(num(rect.w) > 0 && num(rect.h) > 0)) return null
  const pts = glassPoints(screen, o.orientation || glassOrient(m, screen) || 'portrait')
  // Only a measurement that kept its pixels can be checked for shape. Fractions on their
  // own have the capture's aspect folded into them and cannot be told apart from a
  // rectangle of the wrong size.
  if (pts && m.px) {
    if (Math.abs((m.px.w / m.px.h) / (pts.w / pts.h) - 1) > glassTol(m.px)) return null
  }
  // The corner rides on the rectangle it was measured with, so the crop that takes the
  // glass also knows how round it is (ui/compositor/plan.js, glassCorner). Only when
  // there is one: a square glass keeps the plain four numbers everything else expects.
  const c = num(m.corner && typeof m.corner === 'object' ? m.corner.share : m.corner)
  return { x: r4(rect.x), y: r4(rect.y), w: r4(rect.w), h: r4(rect.h),
    ...(c > 0 && c < 0.5 ? { corner: r4(c) } : {}) }
}

/**
 * Which way up the device is, off the measured glass rather than off the window.
 *
 * The window is only evidence: an iPhone SE's window is a portrait window whose shape is
 * nothing like its screen's, because the home button is in it. The glass is the screen,
 * so its shape says which way up the device is outright, and says nothing where the two
 * orientations are too close to tell apart.
 */
function glassOrient(glass, screen) {
  const m = glass && glass.value ? glass.value : glass
  const pts = pointsOf(screen)
  if (!m || !m.px || !pts) return null
  const a = m.px.w / m.px.h
  const p = Math.abs(a / (pts.w / pts.h) - 1), l = Math.abs(a / (pts.h / pts.w) - 1)
  if (Math.min(p, l) > glassTol(m.px)) return null
  return p <= l ? 'portrait' : 'landscape'
}

/**
 * Where the device screen sits inside the Simulator window, as fractions {x, y, w, h}
 * of the recorded frame: exactly the object ui/pointer.js viewportBox() returns for a
 * browser page, so ui/fetchdoc.js chromeCrop() crops to it with no new plumbing.
 *
 * Hand in a measured glass (`o.glass`, from measureGlass on a capture of this window)
 * and that is what comes back. That is the only number anything aims with, because the
 * arithmetic below cannot be trusted and this file no longer pretends otherwise.
 *
 * What the arithmetic is, and why it is an estimate. It fits the screen's aspect inside
 * the window and assumes the leftover is nothing. On a stock Xcode 26 Simulator the
 * leftover is a 52 point floating toolbar, an 11 point clear gap and a drawn bezel, and
 * three devices measured on this Mac put the glass at 0.80 to 0.89 of the window, not at
 * 1.0. The window's own shape does not give the error away either: on an iPhone 16 Pro
 * Max the window's aspect is within 0.42 percent of the screen's while the fit is out by
 * 12 percent, so the aspect guard below catches an iPhone SE and misses a phone with a
 * notch. Where a caller genuinely knows the chrome it passes `chrome` in window points
 * and the fit happens in what is left; the leftover after that is split evenly, the same
 * rule viewportBox uses for a side border.
 */
function viewport(win, screen, o = {}) {
  const ow = num(win && win.w), oh = num(win && win.h)
  const pts = glassPoints(screen, o.orientation || orientOf(win, screen))
  if (!(ow > 0 && oh > 0) || !pts) return null
  if (o.glass) return glassViewport(o.glass, screen, o)
  // A fit whose shape is nothing like the screen's is wrong by an amount anyone can see,
  // and returning it puts a tap on the Mac's part of the window. It is not a sound guard
  // (see above), it is the half of the error that is detectable without pixels.
  const fitted = Math.abs((ow / oh) / (pts.w / pts.h) - 1)
  if (fitted > FIT_TOL) return null
  const c = inset(o.chrome)
  const bw = ow - c.left - c.right, bh = oh - c.top - c.bottom
  if (!(bw > 0 && bh > 0)) return null
  const k = Math.min(bw / pts.w, bh / pts.h)
  const w = pts.w * k, h = pts.h * k
  return {
    x: r4((c.left + (bw - w) / 2) / ow), y: r4((c.top + (bh - h) / 2) / oh),
    w: r4(w / ow), h: r4(h / oh),
  }
}

function pointsOf(screen) {
  const w = num(screen && screen.w), h = num(screen && screen.h)
  const scale = num(screen && screen.scale) || 1
  if (!(w > 0 && h > 0 && scale > 0)) return null
  return { w: w / scale, h: h / scale }
}

/**
 * Which way up the device is being shown.
 *
 * simctl reports no orientation at all, and the window is the only evidence there is: a
 * device on its side makes a window whose shape is the screen's inverted. Without this
 * the fit below put a portrait screen inside a landscape window and returned a strip a
 * fifth of the window wide, which then cropped four fifths of the app out of the
 * deliverable and put every tap but the exact centre somewhere nobody pointed.
 *
 * Ties go to portrait, which is how a device boots and what a square window means.
 */
function orientOf(win, screen) {
  const pts = pointsOf(screen)
  const ow = num(win && win.w), oh = num(win && win.h)
  if (!pts || !(ow > 0 && oh > 0)) return 'portrait'
  const a = ow / oh
  return Math.abs(a - pts.w / pts.h) <= Math.abs(a - pts.h / pts.w) ? 'portrait' : 'landscape'
}

// The screen in the points it is being shown in, which is the framebuffer turned where
// the device is. Everything downstream aims in these: the fit, a tap, the touch disc.
function glassPoints(screen, orientation) {
  const p = screen && screen.points ? screen.points : pointsOf(screen)
  if (!p) return null
  return orientation === 'landscape' ? { w: p.h, h: p.w } : p
}

/**
 * Captured pixels of the device screen per pixel the device actually has. Under 1 the
 * window is scaled down and a store sized export would be an upscale, which is the
 * refusal piece 6 owns.
 *
 * A measured glass answers this outright, and better than anything else can: the
 * rectangle is already in the capture's own pixels and the framebuffer is in the
 * device's, so the ratio is the two numbers and the display's backing scale never enters
 * it. Measured here at 0.53, 0.57 and 0.89 on three devices where the arithmetic said
 * 0.60, 0.64 and 1.06. The last pair is the one that matters: the fit said an iPhone SE
 * window was a sixth over the device's own pixels when it was a ninth under, and a store
 * size gate reading that number lets an upscale through.
 */
function density(win, screen, o = {}) {
  const m = o.glass && o.glass.value ? o.glass.value : o.glass
  const orient = o.orientation || (m ? glassOrient(m, screen) : null) || orientOf(win, screen)
  if (m && m.px && m.px.w > 0) {
    // Only off a rectangle that passed for the screen. A dark app painted to its edge
    // measures as something smaller, and its width over the framebuffer's is a density
    // nobody's window has: 0.15 off a dark splash.
    const pts = glassPoints(screen, orient)
    if (pts && Math.abs((m.px.w / m.px.h) / (pts.w / pts.h) - 1) > glassTol(m.px)) return null
    const px = orient === 'landscape' ? num(screen && screen.h) : num(screen && screen.w)
    return px > 0 ? r2(m.px.w / px) : null
  }
  const v = o.viewport || viewport(win, screen, o)
  // The display the window is actually on, not the Mac's main one: a Simulator window
  // dragged onto a 1x screen beside a Retina main display reads 2 here and is 1, so a
  // store export that should have been refused would go out as an upscale. Null rather
  // than a guess where the caller could not resolve the display, and then there is no
  // density to report either: a number nobody measured is worse than no number.
  const scale = num(o.backingScale)
  // A device on its side shows its long edge across, so the pixels the window is
  // measured against are the framebuffer's other axis.
  const sw = orient === 'landscape' ? num(screen && screen.h) : num(screen && screen.w)
  if (!v || !(scale > 0) || !(sw > 0) || !(num(win && win.w) > 0)) return null
  return r2((v.w * win.w * scale) / sw)
}

/** The sentence the agent surface says when a store shot would be an upscale. */
function densityNote(sim) {
  const d = sim && sim.density
  if (!(d > 0) || d >= 1) return null
  return `this window is at ${d.toFixed(2)} of the device's own pixels, measured off the screen inside it; set Window, Pixel Accurate in the Simulator before a store shot`
}

/** And the sentence for a window nothing has measured yet. */
function glassNote(sim) {
  if (!sim || !sim.window || !sim.screen || sim.viewport) return null
  return `nothing has measured where ${sim.name}'s screen sits inside its window yet, so there is no rectangle to aim a tap through or crop to. A capture of the window is what measures it.`
}

// Simulator windows only. Every other window on the Mac belongs to somebody else.
const isSimWindow = w => w && String(w.app || '') === 'Simulator'

/**
 * The model. Hand in the three simctl reads, the window list, and the backing scale of
 * the display the windows are on; get back one record per device, best claim on a window
 * first so two devices of the same model cannot both take the same window.
 */
function simulators(inp = {}) {
  const devices = Array.isArray(inp.devices) ? inp.devices : parseDevices(inp.devices, inp)
  // either the raw read or the parsed map, so a caller that already parsed once is not
  // made to hand the text back
  const raw = typeof inp.runtimes === 'string' || (inp.runtimes && inp.runtimes.runtimes)
  const runtimes = raw ? parseRuntimes(inp.runtimes) : (inp.runtimes || {})
  const types = { ...deviceTypesFromRuntimes(runtimes), ...parseDeviceTypes(inp.deviceTypes) }
  const profiles = inp.profiles || {}
  const windows = (inp.windows || []).filter(isSimWindow)
  // A capture of this window, already measured. Injected, so this file still spawns
  // nothing and captures nothing: the caller takes the frame and hands back what
  // measureGlass made of it, or nothing. This replaced a backing scale: a measured glass
  // is in the capture's own pixels, so which display the window sits on stops mattering.
  const glassOf = typeof inp.glassOf === 'function'
    ? (w => { try { const g = inp.glassOf(w); return g && g.ok === false ? null : (g || null) } catch { return null } })
    : (() => null)

  const out = devices.map(d => {
    const type = types[d.deviceTypeId] || null
    const rt = runtimes[d.runtimeId] || null
    const screen = profiles[d.deviceTypeId] || null
    return {
      udid: d.udid,
      name: d.name,
      family: (type && type.family) || familyFromId(d.deviceTypeId) || null,
      deviceType: (type && type.name) || d.deviceTypeId || null,
      deviceTypeId: d.deviceTypeId,
      runtime: (rt && rt.name) || d.runtimeId,
      runtimeId: d.runtimeId,
      state: d.state,
      booted: d.state === 'Booted',
      screen: screen ? { w: screen.w, h: screen.h, scale: screen.scale, points: screen.points } : null,
      window: null,
      viewport: null,
      density: null,
      // Which way up it is being shown, which only a window can say. Portrait until one
      // is found, because that is how a device boots.
      orientation: 'portrait',
      glass: screen ? screen.points : null,
      ...(d.availabilityError ? { availabilityError: d.availabilityError } : {}),
    }
  })

  // Best claim wins the window. A tie is two devices with the same name, where guessing
  // would put the take on the wrong phone, so neither takes it and both say why.
  for (const w of windows) {
    const scored = out.filter(s => !s.window).map(s => ({ s, n: claim(w.title, s.name) })).filter(x => x.n > 0)
    if (!scored.length) continue
    scored.sort((a, b) => b.n - a.n || b.s.name.length - a.s.name.length)
    const top = scored.filter(x => x.n === scored[0].n && x.s.name === scored[0].s.name)
    if (top.length > 1) {
      for (const x of top) x.s.note = `two devices are named ${x.s.name}, so neither can be told from its window title; rename one to film it`
      continue
    }
    const sim = scored[0].s
    // x and y come through so the caller can ask which display this window is on: the
    // density below is measured against that display's scale factor and no other.
    sim.window = { id: w.id, w: num(w.width) || num(w.w) || 0, h: num(w.height) || num(w.h) || 0,
      ...(num(w.x) != null ? { x: num(w.x) } : {}), ...(num(w.y) != null ? { y: num(w.y) } : {}),
      title: String(w.title || '') }
    if (sim.screen) {
      // Measured first, and the measurement decides which way up the device is: the
      // glass is the screen, where the window is a shape with a toolbar and a home
      // button in it.
      const m = glassOf(sim.window)
      sim.orientation = (m && glassOrient(m, sim.screen)) || orientOf(sim.window, sim.screen)
      sim.glass = glassPoints(sim.screen, sim.orientation)
      // Carried on the screen as well, because the screen is what travels onto the
      // document and out to the touch disc, and a disc sized off the portrait width on a
      // device lying on its side comes out several times too small.
      if (sim.orientation === 'landscape') sim.screen = { ...sim.screen, orientation: 'landscape' }
      // Nothing is aimed with the arithmetic. Fitting the screen's aspect inside the
      // window puts the glass 12 percent too wide on a phone with a notch and 19 percent
      // too wide on one with a home button, which sends a tap near the top of the screen
      // about 80 points above what it was aimed at and leaves a crop with the Mac's own
      // toolbar still in it. Where there is no capture to measure there is no rectangle,
      // and the tools downstream already say so in words rather than missing quietly.
      sim.viewport = m ? viewport(sim.window, sim.screen, { glass: m, orientation: sim.orientation }) : null
      sim.density = sim.viewport ? density(sim.window, sim.screen, { glass: m, orientation: sim.orientation }) : null
      if (m && !sim.viewport) sim.note = `a capture of ${sim.name}'s window was measured and what came back was not the shape of its screen, so Fetch reports no rectangle rather than a wrong one`
      else if (!m) sim.note = sim.note || glassNote(sim)
    }
  }

  // On screen first, then booted, then by the person's own name for it, because the
  // device they can see is the one they are about to point at.
  out.sort((a, b) => (!!b.window - !!a.window) || (b.booted - a.booted) || a.name.localeCompare(b.name))
  return out
}

/**
 * One device from a UDID or a name. Returns {ok, value} or {ok:false, reason} so the
 * caller has a sentence to print rather than a null to guess about.
 */
function resolve(list, q) {
  const want = String(q == null ? '' : q).trim()
  if (!want) return { ok: false, reason: 'name a simulator by its UDID or by the name you gave it.' }
  if (want.toLowerCase() === 'booted') {
    return { ok: false, reason: 'the literal "booted" picks an unspecified device when two are up. Pass a UDID, or a device name to resolve to one.' }
  }
  const sims = list || []
  const byUdid = sims.filter(s => s.udid.toLowerCase() === want.toLowerCase())
  if (byUdid.length) return { ok: true, value: byUdid[0] }
  const exact = sims.filter(s => s.name === want)
  if (exact.length === 1) return { ok: true, value: exact[0] }
  const loose = exact.length ? exact : sims.filter(s => s.name.toLowerCase() === want.toLowerCase())
  if (loose.length === 1) return { ok: true, value: loose[0] }
  if (loose.length > 1) {
    return { ok: false, reason: `${loose.length} simulators are named ${want}. Pass the UDID: ${loose.map(s => s.udid).join(', ')}.` }
  }
  const part = sims.filter(s => s.name.toLowerCase().includes(want.toLowerCase()))
  if (part.length === 1) return { ok: true, value: part[0] }
  if (part.length > 1) {
    return { ok: false, reason: `${want} matches ${part.map(s => s.name).join(', ')}. Say which one.` }
  }
  return { ok: false, reason: `no simulator here is called ${want}.` }
}

/** A device point on the glass to a fraction of the recorded frame. */
function pointToFrame(sim, x, y) {
  const v = sim && sim.viewport
  const pts = (sim && sim.glass) || glassPoints(sim && sim.screen, sim && sim.orientation)
  if (!v || !pts) return null
  if (!Number.isFinite(+x) || !Number.isFinite(+y)) return null
  return { x: r4(v.x + (+x / pts.w) * v.w), y: r4(v.y + (+y / pts.h) * v.h) }
}

module.exports = {
  parseDevices, parseRuntimes, parseDeviceTypes, deviceTypesFromRuntimes,
  parseProfile, profilePath, readProfiles,
  measureGlass, measureCorner, glassOrient, glassViewport, viewport, density, densityNote, glassNote,
  pointToFrame, orientOf, glassPoints,
  simulators, resolve, claim, titleSegments,
}
