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

/**
 * Where the device screen sits inside the Simulator window, as fractions {x, y, w, h}
 * of the recorded frame: exactly the object ui/pointer.js viewportBox() returns for a
 * browser page, so ui/fetchdoc.js chromeCrop() crops to it with no new plumbing.
 *
 * Measured on this Mac at Xcode 26: the window's own frame carries no macOS title bar
 * and Simulator draws no bezel inside it, so the screen is almost the whole window but
 * not quite (396 x 856 points of window for a 440 x 956 point screen). That residual is
 * why this fits the screen's aspect inside the window rather than assuming 1.0. Where a
 * title bar or a drawn bezel is inside the frame, the caller passes it as `chrome` in
 * window points and the fit happens in what is left; the leftover after that is split
 * evenly, the same rule viewportBox uses for a side border.
 */
function viewport(win, screen, o = {}) {
  const ow = num(win && win.w), oh = num(win && win.h)
  const pts = glassPoints(screen, o.orientation || orientOf(win, screen))
  if (!(ow > 0 && oh > 0) || !pts) return null
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
 * refusal piece 6 owns. Measured from the screen rectangle rather than the whole window,
 * because the chrome's pixels are not the device's; at Pixel Accurate, where the answer
 * matters, the two agree exactly.
 */
function density(win, screen, o = {}) {
  const v = o.viewport || viewport(win, screen, o)
  // The display the window is actually on, not the Mac's main one: a Simulator window
  // dragged onto a 1x screen beside a Retina main display reads 2 here and is 1, so a
  // store export that should have been refused would go out as an upscale. Null rather
  // than a guess where the caller could not resolve the display, and then there is no
  // density to report either: a number nobody measured is worse than no number.
  const scale = num(o.backingScale)
  const orientation = o.orientation || orientOf(win, screen)
  // A device on its side shows its long edge across, so the pixels the window is
  // measured against are the framebuffer's other axis.
  const sw = orientation === 'landscape' ? num(screen && screen.h) : num(screen && screen.w)
  if (!v || !(scale > 0) || !(sw > 0) || !(num(win && win.w) > 0)) return null
  return r2((v.w * win.w * scale) / sw)
}

/** The sentence the agent surface says when a store shot would be an upscale. */
function densityNote(sim) {
  const d = sim && sim.density
  if (!(d > 0) || d >= 1) return null
  return `this window is at ${d.toFixed(2)} of the device's own pixels; set Window, Pixel Accurate in the Simulator before a store shot`
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
  // No default: see density(). A caller that cannot say which display the window is on
  // gets no density rather than one measured against a scale factor nobody checked.
  // scaleOf answers per window, because two Simulator windows can be on two displays.
  const backingScale = num(inp.backingScale)
  const scaleOf = typeof inp.scaleOf === 'function'
    ? (w => { try { return num(inp.scaleOf(w)) } catch { return null } })
    : (() => backingScale)

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
      sim.orientation = orientOf(sim.window, sim.screen)
      sim.glass = glassPoints(sim.screen, sim.orientation)
      // Carried on the screen as well, because the screen is what travels onto the
      // document and out to the touch disc, and a disc sized off the portrait width on a
      // device lying on its side comes out several times too small.
      if (sim.orientation === 'landscape') sim.screen = { ...sim.screen, orientation: 'landscape' }
      sim.viewport = viewport(sim.window, sim.screen, { ...inp, orientation: sim.orientation })
      sim.density = density(sim.window, sim.screen,
        { ...inp, viewport: sim.viewport, backingScale: scaleOf(sim.window), orientation: sim.orientation })
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
  viewport, density, densityNote, pointToFrame, orientOf, glassPoints,
  simulators, resolve, claim, titleSegments,
}
