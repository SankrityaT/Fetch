// The sizes a store will accept, and what a capture can honestly be made into.
//
// This is the last gate of somebody's day and the least forgiving one. A still a single
// pixel off 1320 x 2868 is rejected at upload, after the writing, the shooting and the
// styling are all done, and the person has no idea which of those steps lied to them. So
// the numbers live in one table, read off this machine rather than remembered, and every
// answer this file gives is an integer or a refusal with a way out in it.
//
// Two rules carry the whole module.
//
//   1. Exact. A preset is a pair of integers, not an aspect and a scale. The picture is
//      composed at that size and the capture is inset inside it, so the capture ends up
//      smaller than the deliverable and the room around it is drawn.
//   2. Never upscaled. A soft store asset is worse than no store asset: it goes out, it
//      is accepted, and it is the thing a stranger judges the app by. So when the pixels
//      are not there, this refuses and names the two things that would put them there,
//      rather than blurring quietly and reporting success.
//
// Where the numbers came from, since a wrong table is worse than no table:
//
//   1320 x 2868 (6.9 inch iPhone) and 2064 x 2752 (13 inch iPad) are the required store
//   screenshot sizes in `.context/survey/sim-bar.md:136-138`, which also records that
//   1290 x 2796 and 1260 x 2736 are accepted in the 6.9 class, and 2048 x 2732 beside
//   2064 x 2752 in the 13 inch one. 886 x 1920 is the app
//   preview size in the same class, `sim-bar.md:149-153`, and 1080 x 1920 is refused
//   there by name because it is 9:16 and a phone screen is not.
//
//   Every one of those five numbers was then checked against the device profiles on this
//   Mac, `/Library/Developer/CoreSimulator/Profiles/DeviceTypes/*/Contents/Resources/
//   profile.plist`, where mainScreenWidth and mainScreenHeight are in pixels: 1320 x 2868
//   is iPhone 17 Pro Max and 16 Pro Max, 1290 x 2796 is 16 Plus, 15 Pro Max, 15 Plus and
//   14 Pro Max, 1260 x 2736 is iPhone Air, 2064 x 2752 is iPad Pro 13 inch (M4 and M5).
//   Every accepted size is the native framebuffer of a device somebody can boot, which is
//   what makes density 1.0 reachable at all.
//
// Pure: no filesystem, no DOM, no Electron, no process. The caller hands in a capture's
// pixels and a name. test/sizes.test.js is the whole of the proof.

const r3 = n => Math.round(n * 1000) / 1000
const int = n => Math.max(1, Math.floor(n))
const px = s => `${s.w} x ${s.h}`

/**
 * The table. `w` and `h` are the deliverable, exactly. `also` are the other sizes the
 * same class accepts, largest first, for the capture that cannot reach the top one.
 *
 * `native` is a hint, read off this Mac's device profiles, for the sentence a refusal
 * needs to be actionable. The live answer comes from the device list, through reach():
 * a device type is added to Xcode more often than this file is edited.
 */
const PRESETS = {
  'app-store-6.9': {
    id: 'app-store-6.9', kind: 'still', family: 'iphone', class: '6.9',
    w: 1320, h: 2868,
    also: [{ w: 1290, h: 2796 }, { w: 1260, h: 2736 }],
    native: ['iPhone 17 Pro Max', 'iPhone 16 Pro Max'],
    what: 'App Store screenshot, 6.9 inch iPhone, portrait',
  },
  'app-store-13': {
    id: 'app-store-13', kind: 'still', family: 'ipad', class: '13',
    w: 2064, h: 2752,
    // The other size the 13 inch class accepts. Left out, a capture off a 12.9 inch iPad
    // was refused at a 1.008x upscale with nothing to fall back to, and told to buy a
    // device, when the file already in the person's hand is one the store takes.
    also: [{ w: 2048, h: 2732 }],
    native: ['iPad Pro 13-inch (M4)', 'iPad Pro 13-inch (M5)', 'iPad Air 13-inch (M2)',
      'iPad Air 13-inch (M3)', 'iPad Air 13-inch (M4)'],
    what: 'App Store screenshot, 13 inch iPad, portrait',
  },
  'app-preview-6.9': {
    id: 'app-preview-6.9', kind: 'video', family: 'iphone', class: '6.9',
    w: 886, h: 1920,
    also: [],
    native: ['iPhone 17 Pro Max', 'iPhone 16 Pro Max'],
    // An app preview is rejected for its length and its weight as readily as for its
    // size, and it is the same person at the same end of the same day.
    seconds: { min: 15, max: 30 },
    bytes: 500 * 1000 * 1000,
    codecs: ['h264', 'prores422hq'],
    what: 'App preview video, 6.9 inch iPhone, portrait',
  },
}

/**
 * Sizes refused by name, with the reason, because a silent "no such preset" would send
 * somebody looking for a typo in a number that is real and simply should not be offered.
 *
 * 1080 x 1920 is accepted by the store in the 6.9 preview class and is still refused
 * here: it is 9:16, a phone screen is 19.5:9, and nothing fills the difference except a
 * bar or a crop through the app's own UI. Offering it would be shipping a bar under a
 * rule that says never ship one.
 */
const REFUSED = {
  '1080x1920': '1080 x 1920 is 9:16 and a phone screen is 19.5:9, so a phone take cannot ' +
    'fill it without a bar down each side or a crop through the app. Use app-preview-6.9, ' +
    'which is 886 x 1920, the phone\'s own shape.',
}

// What a person or an agent is likely to type for each of these.
const ALIASES = {
  '6.9': 'app-store-6.9', 'iphone-6.9': 'app-store-6.9', '1320x2868': 'app-store-6.9',
  'app-store-iphone': 'app-store-6.9', 'screenshot-6.9': 'app-store-6.9',
  '13': 'app-store-13', 'ipad-13': 'app-store-13', '2064x2752': 'app-store-13',
  'app-store-ipad': 'app-store-13', 'screenshot-13': 'app-store-13',
  'preview-6.9': 'app-preview-6.9', '886x1920': 'app-preview-6.9',
  'app-preview': 'app-preview-6.9', 'app-preview-iphone': 'app-preview-6.9',
  'app-preview-1080': '1080x1920', 'app-preview-6.9-1080': '1080x1920',
  '1080p-preview': '1080x1920',
}

const key = name => String(name == null ? '' : name).trim().toLowerCase().replace(/\s+/g, '')

const list = () => Object.values(PRESETS).map(p =>
  ({ id: p.id, kind: p.kind, w: p.w, h: p.h, what: p.what }))

const get = name => {
  const k = key(name)
  return PRESETS[k] || PRESETS[ALIASES[k]] || null
}

/** A name to a preset, or a sentence saying why not. Every entry point goes through it. */
function resolve (name) {
  const k = key(name)
  const refused = REFUSED[k] || REFUSED[ALIASES[k]]
  if (refused) return { ok: false, reason: refused, refused: k }
  const p = get(name)
  if (p) return { ok: true, preset: p }
  const names = Object.keys(PRESETS).join(', ')
  return { ok: false, reason: `there is no ${k || 'size'} preset. The ones that exist are ${names}.` }
}

/** The part of the capture that becomes the deliverable. A window take is the window; the
 * device screen inside it is the crop, and only the crop is the picture. */
function sourceOf (capture, crop) {
  const box = crop || capture
  const src = { w: Math.round(+(box && box.w)), h: Math.round(+(box && box.h)) }
  if (!(src.w > 0 && src.h > 0)) return null
  if (crop && capture && +capture.w > 0 && +capture.h > 0 &&
      (src.w > Math.round(+capture.w) || src.h > Math.round(+capture.h))) return null
  return src
}

const shareOf = s => {
  if (s == null) return { w: 1, h: 1 }
  const one = v => (Number.isFinite(+v) && +v > 0 && +v <= 1 ? +v : null)
  if (typeof s === 'object') return { w: one(s.w) || 1, h: one(s.h) || 1 }
  const u = one(s)
  return u ? { w: u, h: u } : { w: 1, h: 1 }
}

/**
 * Given a capture and a target, what comes out.
 *
 *   fit({w, h}, 'app-store-6.9', {crop, share})
 *
 * share is how much of the picture the layout wants to give the capture, 0 to 1, because
 * a store screenshot is a backdrop and a caption around an inset shot and the layout owns
 * that decision. The default is 1, edge to edge, which is the strictest case.
 *
 * The box is floored rather than rounded, and that is the whole honesty of this file: a
 * box half a pixel wider than the capture can fill is an upscale, and that half pixel is
 * this module's own rounding, not anything the store asked for. Floored, the integers can
 * be compared directly and density >= 1 is exact rather than a tolerance.
 */
function fit (capture, target, opts = {}) {
  const t = resolve(target)
  if (!t.ok) return t
  const p = t.preset
  const size = { w: p.w, h: p.h }
  const src = sourceOf(capture, opts.crop)
  if (!src) {
    return { ok: false, preset: p.id, size,
      reason: 'a capture needs a width and a height in pixels, and a crop has to fit inside it, before anything can be fitted to a size.' }
  }

  const share = shareOf(opts.share)
  const inner = { w: size.w * share.w, h: size.h * share.h }
  const k = Math.min(inner.w / src.w, inner.h / src.h)
  const box = { w: int(src.w * k), h: int(src.h * k) }
  box.x = Math.round((size.w - box.w) / 2)
  box.y = Math.round((size.h - box.h) / 2)

  // Capture pixels per drawn pixel, the same meaning the shot path already reports: 1 is
  // the capture at its own size, over 1 is capture thrown away, under 1 is invention.
  const density = Math.min(src.w / box.w, src.h / box.h)

  // The largest uniform share that stays honest. sf is the edge to edge fit; past 1 the
  // picture is asking for pixels that were never captured.
  const sf = Math.min(size.w / src.w, size.h / src.h)
  const maxShare = Math.min(1, 1 / sf)

  if (density < 1) {
    // What the capture would have had to be: the box itself, since a box drawn at one
    // capture pixel each is the only arrangement that is not an upscale.
    const need = { w: box.w, h: box.h }
    const alt = best(capture, p.id, opts)
    const fix = ['set the Simulator window to Pixel Accurate so the capture is the device\'s own pixels, then shoot again']
    // Names are only offered for a still, where the preset size is some device's exact
    // framebuffer. Half the phones ever made clear a preview's 886 x 1920, so naming two
    // of them there would read as a requirement and be wrong.
    fix.push(`or use a device type whose own screen is at least ${px(size)}` +
      (p.kind === 'still' ? `: ${p.native.join(', ')}` : ''))
    if (alt.ok && !(alt.size.w === size.w && alt.size.h === size.h)) {
      fix.push(`or export at ${px(alt.size)}, which this capture fills honestly and the same class accepts`)
    }
    // The third route, and the only one that needs nothing but a different layout: draw a
    // bigger backdrop and give the capture less of the picture.
    const asked = Math.min(share.w, share.h)
    if (maxShare < asked) {
      fix.push(`or give the capture ${Math.floor(maxShare * 100)}% of the picture instead of ${Math.floor(asked * 100)}%, and draw more around it`)
    }
    return {
      ok: false, preset: p.id, size, source: src,
      density: r3(density), upscale: r3(1 / density), maxShare: r3(maxShare),
      need, have: src,
      reason: `this capture is ${px(src)} and a ${px(size)} ${p.kind === 'still' ? 'still' : 'preview'} ` +
        `would draw it at ${px(need)}, a ${r3(1 / density)}x upscale. Fetch does not upscale into a store size.`,
      fix,
    }
  }

  const leftover = { w: size.w - box.w, h: size.h - box.h }
  return {
    ok: true, preset: p.id, kind: p.kind, size, source: src, box,
    density: r3(density), maxShare: r3(maxShare), share,
    // Room the picture has to fill with something drawn. It is never black: the layout
    // fills it with the take blurred. Reported so a caller can prove it filled it.
    leftover, edgeToEdge: leftover.w <= 1 && leftover.h <= 1,
    // A capture already at the deliverable's exact size, drawn at its exact size: no
    // resample at all, which is the only way a still is truly lossless.
    pristine: src.w === size.w && src.h === size.h && box.w === size.w && box.h === size.h,
    // The other honest way to fill the frame: trim the capture rather than stretch it.
    // Offered, never taken here, because a trim cuts through somebody's UI.
    bleed: bleed(src, size),
  }
}

/**
 * What it would cost to fill the target edge to edge by trimming instead of inseting: the
 * rectangle of the capture that survives. Null when the capture is too small to cover the
 * target without stretching, which is the case that has no honest answer at all.
 */
function bleed (src, size) {
  const k = Math.max(size.w / src.w, size.h / src.h)
  if (k > 1) return null
  const w = Math.min(src.w, Math.ceil(size.w / k))
  const h = Math.min(src.h, Math.ceil(size.h / k))
  return {
    crop: { x: Math.round((src.w - w) / 2), y: Math.round((src.h - h) / 2), w, h },
    lost: { w: r3(1 - w / src.w), h: r3(1 - h / src.h) },
  }
}

/**
 * The largest size the class accepts that this capture can fill honestly. This is what
 * turns a refusal into a route: a capture off a 1290 x 2796 device cannot be a 1320 x 2868
 * still and is exactly a 1290 x 2796 one, and nobody should have to know that.
 */
function best (capture, target, opts = {}) {
  const t = resolve(target)
  if (!t.ok) return t
  const p = t.preset
  const src = sourceOf(capture, opts.crop)
  if (!src) {
    return { ok: false, preset: p.id,
      reason: 'a capture needs a width and a height in pixels, and a crop has to fit inside it, before anything can be fitted to a size.' }
  }
  const sizes = [{ w: p.w, h: p.h }].concat(p.also)
  let nearest = null
  for (const size of sizes) {
    const probe = fitSize(capture, size, opts)
    if (probe.ok) return { ok: true, preset: p.id, size, fit: probe }
    if (!nearest || probe.density > nearest.density) nearest = { size, density: probe.density }
  }
  return {
    ok: false, preset: p.id, nearest: nearest.size, density: r3(nearest.density),
    reason: `this capture is ${px(src)} and the smallest size the ${p.class} class accepts is ` +
      `${px(sizes[sizes.length - 1])}. The closest it comes is ${px(nearest.size)} at a ` +
      `${r3(1 / nearest.density)}x upscale, which is not close enough to ship.`,
  }
}

// fit() against a bare pair of integers rather than a named preset, so best() can walk a
// class's accepted sizes without inventing a preset id for each of them.
function fitSize (capture, size, opts = {}) {
  const src = sourceOf(capture, opts.crop)
  if (!src) return { ok: false, density: 0 }
  const share = shareOf(opts.share)
  const k = Math.min((size.w * share.w) / src.w, (size.h * share.h) / src.h)
  const box = { w: int(src.w * k), h: int(src.h * k) }
  const density = Math.min(src.w / box.w, src.h / box.h)
  if (density < 1) return { ok: false, density, size, box }
  box.x = Math.round((size.w - box.w) / 2)
  box.y = Math.round((size.h - box.h) / 2)
  const leftover = { w: size.w - box.w, h: size.h - box.h }
  return { ok: true, size, source: src, box, density: r3(density), leftover,
    edgeToEdge: leftover.w <= 1 && leftover.h <= 1 }
}

/**
 * Which of these device types can reach the target at all, by their own screen. Devices
 * come from the simulator model, which reads the real profiles; this only compares. The
 * answer is the second half of every refusal above, in a form a caller can print.
 */
function reach (target, devices = []) {
  const t = resolve(target)
  if (!t.ok) return t
  const p = t.preset
  const size = { w: p.w, h: p.h }
  const able = [], short = []
  for (const d of devices) {
    const s = d && (d.screen || d)
    const w = Math.round(+(s && s.w)), h = Math.round(+(s && s.h))
    if (!(w > 0 && h > 0)) continue
    const row = { name: d.name || d.deviceType || '', w, h, udid: d.udid }
    ;(w >= size.w && h >= size.h ? able : short).push(row)
  }
  return { ok: true, preset: p.id, size, able, short }
}

/**
 * The two ways an app preview is rejected that have nothing to do with its size. Cheap to
 * check here, expensive to discover at upload.
 */
function checkClip (clip, target) {
  const t = resolve(target)
  if (!t.ok) return t
  const p = t.preset
  if (p.kind !== 'video') {
    return { ok: false, preset: p.id, reason: `${p.id} is a still, so it has no length to check.` }
  }
  const bad = []
  const secs = +(clip && clip.seconds)
  if (Number.isFinite(secs)) {
    if (secs < p.seconds.min) bad.push(`it runs ${r3(secs)}s and an app preview has to be at least ${p.seconds.min}s`)
    if (secs > p.seconds.max) bad.push(`it runs ${r3(secs)}s and an app preview has to be ${p.seconds.max}s or under`)
  }
  const bytes = +(clip && clip.bytes)
  if (Number.isFinite(bytes) && bytes > p.bytes) {
    bad.push(`it weighs ${Math.round(bytes / 1e6)} MB and the limit is ${Math.round(p.bytes / 1e6)} MB`)
  }
  const codec = clip && clip.codec ? key(clip.codec) : null
  if (codec && !p.codecs.includes(codec)) {
    bad.push(`it is ${codec} and an app preview has to be ${p.codecs.join(' or ')}`)
  }
  return bad.length
    ? { ok: false, preset: p.id, reason: bad.join(', ') + '.', problems: bad }
    : { ok: true, preset: p.id, seconds: p.seconds, bytes: p.bytes }
}

/**
 * What a look costs at this size, where the cost is worth saying out loud.
 *
 * Measured on this Mac: grain on a 1320 x 2868 export took 2.55 times the plain one in
 * one run, 2.42x against 0.95x treated, where the same look at 1080p costs 1.09x. A
 * store still is 3.79 megapixels against 1080p's 2.07, and grain is drawn per output
 * pixel with nothing to hide behind, so its cost climbs faster than the pixel count.
 *
 * A warning and not a refusal. It is the person's picture, the slow export still writes
 * the right file, and a tool that quietly took the grain out of somebody's look to save
 * itself a second would be worse than a slow one. The sentence exists so the wait is
 * expected rather than read as a hang.
 */
const GRAIN_AT_STORE = 2.55      // measured, one run, 1320 x 2868
const GRAIN_AT_1080 = 1.09

function cost(look, target) {
  const t = resolve(target)
  if (!t.ok) return t
  const p = t.preset
  const g = (look && look.grain) || {}
  const amount = +g.film || 0
  const warnings = []
  // Only where the deliverable is bigger than 1080p, which is every still preset here
  // and the preview too. Below that the measurement says it does not matter.
  if (amount > 0 && p.w * p.h > 1920 * 1080) {
    warnings.push(`grain is on, and at ${px({ w: p.w, h: p.h })} it measured ${GRAIN_AT_STORE}x the ` +
      `time of the same export without it, against ${GRAIN_AT_1080}x at 1080p: grain is drawn per ` +
      'output pixel and a store size has nearly twice as many. The file is right either way, so this ' +
      'is a wait to expect rather than a setting to change. grain.film 0 takes it off.')
  }
  return { ok: true, preset: p.id, warnings }
}

module.exports = { PRESETS, REFUSED, ALIASES, list, get, resolve, fit, fitSize, best, bleed, reach, checkClip, cost }
