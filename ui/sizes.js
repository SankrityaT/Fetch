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
// Where the numbers came from, since a wrong table is worse than no table. Two sources,
// and the second one checks the first:
//
//   1. Apple's own two reference pages, read on 2026-09-21 rather than remembered:
//      developer.apple.com/help/app-store-connect/reference/app-information/
//      screenshot-specifications, and the same path ending app-preview-specifications.
//      Every still size, every preview size, the length window, the weight, the frame
//      rate cap, the two codecs and the containers are off those two pages, and each one
//      is noted at the line that holds it. An earlier round took its numbers from a
//      survey note instead, and one of them was wrong (see REFUSED).
//   2. This Mac's own device profiles, `/Library/Developer/CoreSimulator/Profiles/
//      DeviceTypes/*/Contents/Resources/profile.plist`, where mainScreenWidth and
//      mainScreenHeight are in pixels. Every still size in the table is the exact
//      framebuffer of a device somebody here can boot, which is what makes density 1.0
//      reachable at all: 1320 x 2868 is iPhone 17 Pro Max and 16 Pro Max, 1290 x 2796 is
//      16 Plus, 15 Pro Max, 15 Plus and 14 Pro Max, 1260 x 2736 is iPhone Air,
//      2064 x 2752 is iPad Pro 13-inch (M4 and M5), and 2048 x 2732 is the 13-inch Airs
//      and every 12.9-inch Pro. Apple files the 13-inch Airs in the 13 inch class and
//      their screens are 2048 x 2732, so they reach the class and not its top size.
//
//   A preview size is not a framebuffer and is not trying to be. 886 x 1920 is the
//   19.5:9 phone shape written small, so a capture is scaled down into it and the floor
//   under it is 886 x 1920 of real pixels rather than any one device's own. That is why
//   nearly every phone clears a preview and only two clear the top still.
//
//   The Mac preset is the one Fetch can fill without a simulator at all: a display take
//   on this Mac is 3024 x 1964, and 1920 x 1080 is inside that in both edges.
//
// Pure: no filesystem, no DOM, no Electron, no process. The caller hands in a capture's
// pixels and a name. test/sizes.test.js is the whole of the proof.

const r3 = n => Math.round(n * 1000) / 1000
const int = n => Math.max(1, Math.floor(n))
const px = s => `${s.w} x ${s.h}`

/**
 * Everything an app preview is judged by that is not its rectangle. One object, because
 * the rules are the same in every class and only the rectangle changes, and because a
 * second copy of 30 seconds somewhere else would go stale without anybody noticing.
 *
 * Every field is off the app preview specifications page, section by section:
 *
 *   seconds     "Minimum length 15 Seconds", "Maximum length 30 Seconds"
 *   bytes       "Maximum file size 500MB". Read as 500,000,000, which is the stricter
 *               of the two readings and therefore the safe one.
 *   fps.max     "Max frame rate 30 frames per second", for both codecs. A cap, not a
 *               requirement: 24 is legal, 60 is not, and Fetch records at 60.
 *   codecs      "You can provide app previews in H.264 and ProRes 422 (HQ only)".
 *   containers  "Supported extensions .mov, .m4v, .mp4" for H.264, ".mov" for ProRes.
 *   rate        "Target bit rate 10-12 Mbps" for H.264 and "VBR ~220 Mbps" for ProRes.
 *               Used to weigh a file before it is written. The H.264 figure is the top
 *               of Apple's own range, so the estimate errs heavy.
 *   h264        What the encoder is actually told, so the promise and the file are one
 *               number. 11 Mbps is the middle of the page's range, held constant with
 *               filler (sinks.js), because a screen take asked for 11 in the average
 *               wrote 5.7 and asked for a quality wrote 0.46: a flat UI needs almost
 *               nothing, and an average is a ceiling the encoder need not reach.
 *               Re-read on 2026-09-21 off the same page, "Target bit rate: 10-12 Mbps".
 *   profile     "Progressive, up to High Profile Level 4.0". level4() below is what
 *               makes that line arithmetic rather than a slogan.
 *   poster      "Default poster frame setting 5 Seconds".
 *   audio       "Stereo", "Sample Rate: 44.1kHz or 48kHz", "Codec: 256kbps AAC".
 */
const VIDEO = {
  seconds: { min: 15, max: 30 },
  bytes: 500 * 1000 * 1000,
  fps: { max: 30 },
  codecs: ['h264', 'prores422hq'],
  containers: { h264: ['mov', 'm4v', 'mp4'], prores422hq: ['mov'] },
  rate: { h264: 12e6, prores422hq: 220e6 },
  h264: { bps: 11e6, band: { min: 10e6, max: 12e6 }, profile: 'high', level: '4.0' },
  poster: 5,
  audio: { channels: 2, rates: [44100, 48000] },
}

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
    // Only the two Pros. The 13-inch Airs are in this class and their own screens are
    // 2048 x 2732, so naming them on a line that says "at least 2064 x 2752" sent people
    // to a device that cannot do it. Checked against this Mac's profiles.
    native: ['iPad Pro 13-inch (M4)', 'iPad Pro 13-inch (M5)'],
    what: 'App Store screenshot, 13 inch iPad, portrait',
  },

  // The previews. Apple accepts exactly one rectangle per orientation per class, so each
  // one is its own preset with its own pair of integers, and the pair for the other way
  // up is a named sibling rather than a rotation done somewhere downstream.
  'app-preview-6.9': {
    id: 'app-preview-6.9', kind: 'video', family: 'iphone', class: '6.9',
    w: 886, h: 1920, orient: 'portrait', sibling: 'app-preview-6.9-landscape',
    also: [],
    native: ['iPhone 17 Pro Max', 'iPhone 16 Pro Max'],
    ...VIDEO,
    what: 'App preview video, 6.9 inch iPhone, portrait',
  },
  'app-preview-6.9-landscape': {
    id: 'app-preview-6.9-landscape', kind: 'video', family: 'iphone', class: '6.9',
    w: 1920, h: 886, orient: 'landscape', sibling: 'app-preview-6.9',
    also: [],
    native: ['iPhone 17 Pro Max', 'iPhone 16 Pro Max'],
    ...VIDEO,
    what: 'App preview video, 6.9 inch iPhone, landscape',
  },
  'app-preview-13': {
    id: 'app-preview-13', kind: 'video', family: 'ipad', class: '13',
    // Not 2064 x 2752 shrunk by some factor: the 13 inch preview is 1200 x 1600, which
    // is 3:4 exactly, the same shape as the screen. A tablet take lands edge to edge.
    w: 1200, h: 1600, orient: 'portrait', sibling: 'app-preview-13-landscape',
    also: [],
    native: ['iPad Pro 13-inch (M4)', 'iPad Pro 13-inch (M5)', 'iPad Air 13-inch (M2)'],
    ...VIDEO,
    what: 'App preview video, 13 inch iPad, portrait',
  },
  'app-preview-13-landscape': {
    id: 'app-preview-13-landscape', kind: 'video', family: 'ipad', class: '13',
    w: 1600, h: 1200, orient: 'landscape', sibling: 'app-preview-13',
    also: [],
    native: ['iPad Pro 13-inch (M4)', 'iPad Pro 13-inch (M5)', 'iPad Air 13-inch (M2)'],
    ...VIDEO,
    what: 'App preview video, 13 inch iPad, landscape',
  },
  'app-preview-mac': {
    // The one preview Fetch can make out of the thing it was built to record. A Mac
    // preview is landscape only, which is the page's own note beside the length rule,
    // and no simulator is involved in any part of it.
    id: 'app-preview-mac', kind: 'video', family: 'mac', class: 'mac',
    w: 1920, h: 1080, orient: 'landscape', sibling: null,
    also: [],
    native: [],
    ...VIDEO,
    what: 'App preview video, Mac, landscape',
  },
}

/**
 * Sizes refused by name, with the reason, because a silent "no such preset" would send
 * somebody looking for a typo in a number that is real and simply should not be offered.
 *
 * 1080 x 1920 was in here as "accepted in the 6.9 class and refused anyway". Read off
 * Apple's page it is not accepted in that class at all: it is the preview size for the
 * 5.5 and 4 inch classes, and those classes are shown a scaled copy of the 6.9 preview
 * when nothing is uploaded for them. So the refusal stays and the reason is now true,
 * which matters: a refusal that argues from a wrong fact teaches somebody a wrong fact.
 */
const REFUSED = {
  '1080x1920': '1080 x 1920 is not a size the 6.9 inch class accepts. It is the preview ' +
    'size for the 5.5 and 4 inch classes, which are shown a scaled copy of the 6.9 preview ' +
    'when nothing is uploaded for them, so nobody needs to make one. It is also 9:16 where ' +
    'a phone screen is 19.5:9, so a phone take cannot fill it without a bar down each side ' +
    'or a crop through the app. Use app-preview-6.9, which is 886 x 1920, the phone\'s own shape.',
  'app-preview-watch': 'there is no app preview for a watch. Apple\'s preview table has ' +
    'iPhone, iPad, Mac, Apple TV and Apple Vision Pro in it and no watch at all, so a watch ' +
    'take cannot be made into one however it is drawn. Screenshots are the only motion-free ' +
    'store asset a watch app has.',
  // A Mac preview is 1920 x 1080 and so is the everyday export, and the two are not the
  // same request: one is judged by a length, a frame rate and a weight, the other by
  // nothing. Asked by its numbers, say which is which rather than picking one.
  '1920x1080': '1920 x 1080 is a resolution, not a store size. A Mac app preview is that ' +
    'rectangle and is also 15 to 30 seconds at 30 frames a second or under, so ask for ' +
    'app-preview-mac and be judged by all of it. For an ordinary 1080 tall export, leave ' +
    'the size off and set the resolution instead.',
  '3840x2160': '3840 x 2160 is the Apple Vision Pro preview and Fetch has no capture that ' +
    'reaches it honestly: a headset app is not on this Mac\'s screen, and a simulator window ' +
    'of one is a scaled window, not 3840 x 2160 of real pixels. Nothing here will pretend ' +
    'otherwise by enlarging a smaller take.',
}

// What a person or an agent is likely to type for each of these.
const ALIASES = {
  '6.9': 'app-store-6.9', 'iphone-6.9': 'app-store-6.9', '1320x2868': 'app-store-6.9',
  'app-store-iphone': 'app-store-6.9', 'screenshot-6.9': 'app-store-6.9',
  '13': 'app-store-13', 'ipad-13': 'app-store-13', '2064x2752': 'app-store-13',
  'app-store-ipad': 'app-store-13', 'screenshot-13': 'app-store-13',
  'preview-6.9': 'app-preview-6.9', '886x1920': 'app-preview-6.9',
  'app-preview': 'app-preview-6.9', 'app-preview-iphone': 'app-preview-6.9',
  '1920x886': 'app-preview-6.9-landscape', 'preview-6.9-landscape': 'app-preview-6.9-landscape',
  'app-preview-iphone-landscape': 'app-preview-6.9-landscape',
  '1200x1600': 'app-preview-13', 'preview-13': 'app-preview-13',
  'app-preview-ipad': 'app-preview-13',
  '1600x1200': 'app-preview-13-landscape', 'preview-13-landscape': 'app-preview-13-landscape',
  'app-preview-ipad-landscape': 'app-preview-13-landscape',
  'preview-mac': 'app-preview-mac', 'app-preview-macos': 'app-preview-mac',
  'mac-preview': 'app-preview-mac',
  'app-preview-1080': '1080x1920', 'app-preview-6.9-1080': '1080x1920',
  '1080p-preview': '1080x1920',
  'app-preview-watchos': 'app-preview-watch', 'preview-watch': 'app-preview-watch',
  'app-preview-vision': '3840x2160', 'app-preview-visionos': '3840x2160',
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
    // The first route is where the missing pixels are, and that is not the same place on
    // a Mac as on a simulator. Sending somebody to a Simulator menu item for a take of
    // their own screen is a wrong instruction, which is worse than a short one.
    const fix = [p.family === 'mac'
      ? `record the display rather than a window, or a window at least ${px(size)}: a window take is only as many pixels as the window`
      : 'set the Simulator window to Pixel Accurate so the capture is the device\'s own pixels, then shoot again']
    // Names are only offered for a still, where the preset size is some device's exact
    // framebuffer. Half the phones ever made clear a preview's 886 x 1920, so naming two
    // of them there would read as a requirement and be wrong.
    // Only where the device is the short one. A Pro Max has 1320 x 2868 of its own and a
    // preview is 886 x 1920, so sending somebody to a bigger device names the one they
    // are holding: the missing pixels are the window's scale, not the phone's.
    const dev = opts.device && +opts.device.w > 0 && +opts.device.h > 0
      ? { w: Math.min(+opts.device.w, +opts.device.h), h: Math.max(+opts.device.w, +opts.device.h) } : null
    const want = { w: Math.min(size.w, size.h), h: Math.max(size.w, size.h) }
    const roomy = dev && dev.w >= want.w && dev.h >= want.h
    if (p.family !== 'mac' && !roomy) {
      fix.push(`or use a device type whose own screen is at least ${px(size)}` +
        (p.kind === 'still' ? `: ${p.native.join(', ')}` : ''))
    }
    if (roomy) {
      fix.push(`this device's own screen is ${dev.w} x ${dev.h}, which is enough: it is the window that is drawn small, so a bigger Simulator window is the same fix as Pixel Accurate`)
    }
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
    // Shorter edge against shorter edge. A device profile is written portrait and a
    // landscape preset is the same device turned over, with the same pixels in it, so
    // comparing w to w would have called every phone short of a landscape preview.
    const able1 = Math.min(w, h) >= Math.min(size.w, size.h) && Math.max(w, h) >= Math.max(size.w, size.h)
    ;(able1 ? able : short).push(row)
  }
  return { ok: true, preset: p.id, size, able, short }
}

// ── The four ways a preview is rejected that are not its rectangle ──────────
//
// Length, frame rate, codec and weight. Every one of them is discovered at upload, one
// at a time, after the writing and the shooting and the styling are done, so every one
// of them is decided here before a frame is drawn.

const codecKey = s => key(s).replace(/[^a-z0-9]/g, '')

// What the world calls the two codecs the store takes. A person writes "H.264", an
// encoder is asked for libx264, and ffprobe says `prores` with a tag of `apch` for
// 422 HQ. All three are the same answer and none of them is a different codec.
const CODEC_NAMES = {
  h264: 'h264', avc: 'h264', avc1: 'h264', libx264: 'h264', x264: 'h264',
  prores: 'prores422hq', prores422hq: 'prores422hq', proreshq: 'prores422hq',
  prores422hqonly: 'prores422hq', proresks: 'prores422hq', apch: 'prores422hq',
}
const SAID = { h264: 'H.264', prores422hq: 'ProRes 422 HQ' }
const CONTAINER_NAMES = { mov: 'mov', quicktime: 'mov', m4v: 'm4v', mp4: 'mp4', mpeg4: 'mp4' }
const FAMILY_SAID = { iphone: 'an iPhone', ipad: 'an iPad', mac: 'a Mac' }
const FAMILY_PLAIN = { iphone: 'iPhone', ipad: 'iPad', mac: 'Mac' }
// "the 6.9 inch iPhone size", "the Mac size". A class that is a diagonal reads as inches
// and the Mac's does not, so it is not stitched together from the same words.
const classSaid = p => (p.family === 'mac' ? 'the Mac size' : `the ${p.class} inch ${FAMILY_PLAIN[p.family] || p.family} size`)

const codecOf = name => (name ? CODEC_NAMES[codecKey(name)] || codecKey(name) : null)
const containerOf = name => {
  const k = key(name).replace(/^\./, '')
  return k ? CONTAINER_NAMES[k] || k : null
}
const saidCodec = c => SAID[c] || c
const mb = n => Math.round(n / 1e6)

/** Which way up a rectangle is. Square is neither, and says so rather than guessing. */
const orientOf = box => (box.w > box.h ? 'landscape' : box.w < box.h ? 'portrait' : 'square')

const previewIds = () => Object.values(PRESETS).filter(p => p.kind === 'video').map(p => p.id)

/**
 * Apple's "Progressive, up to High Profile Level 4.0", as arithmetic rather than as a
 * slogan. Level 4.0 allows 8,192 macroblocks in a frame and 245,760 of them a second, a
 * macroblock being 16 by 16 pixels. 1920 x 1080 at 30 is 8,160 and 244,800: inside the
 * level on both counts by a whisker, which is why the frame rate cap is 30 and not a
 * round number somebody picked. Every preset in the table clears it at 30.
 */
function level4 (size, fps) {
  const blocks = Math.ceil(size.w / 16) * Math.ceil(size.h / 16)
  const rate = Math.ceil(blocks * (fps > 0 ? fps : 0))
  return { blocks, rate, ok: blocks <= 8192 && rate <= 245760 }
}

/**
 * What the file will weigh before it exists, from Apple's own stated rates. H.264 is flat
 * at its target, because a target bit rate is a thing an encoder is told. ProRes is a
 * function of pixels and frames, so the page's ~220 Mbps is scaled off the 1920 x 1080 at
 * 30 it was written against.
 *
 * This is the check that catches the trap in the page: ProRes 422 HQ at its own rate is
 * about 825 MB for thirty seconds of 1920 x 1080, and the limit is 500. A full length
 * ProRes preview cannot be delivered, and the page says both things without saying that.
 */
function weigh (codec, size, seconds, fps) {
  const base = VIDEO.rate[codec]
  if (!(base > 0) || !(seconds > 0)) return null
  const scale = codec === 'prores422hq'
    ? (size.w * size.h * (fps > 0 ? fps : VIDEO.fps.max)) / (1920 * 1080 * VIDEO.fps.max)
    : 1
  return Math.round((base * scale * seconds) / 8)
}

/** The longest this codec can run at this size and stay under the weight limit. */
function longestAt (codec, size, fps) {
  const one = weigh(codec, size, 1, fps)
  return one > 0 ? Math.floor((VIDEO.bytes / one) * 10) / 10 : null
}

/**
 * A take's frame rate to the preview's. The cap is 30 and Fetch records at 60, so this
 * runs on nearly every take there is.
 *
 * One frame in n is kept and none is ever invented. A dropped frame is the take's own
 * timing sampled less often; a frame made up between two is motion that did not happen,
 * and a preview of motion that did not happen is the one lie this file exists to stop.
 */
function fpsPlan (fps) {
  const f = +fps
  if (!Number.isFinite(f) || f <= 0) return { take: null, out: VIDEO.fps.max, every: null, unknown: true }
  if (f <= VIDEO.fps.max + 0.005) return { take: r3(f), out: r3(f), every: 1 }
  const every = Math.ceil(f / VIDEO.fps.max)
  return { take: r3(f), out: r3(f / every), every }
}

/**
 * The length window, and the only part of a preview a take can be too much of. Under 15
 * seconds there is nothing honest to do: a still held on screen is not a preview of an
 * app, and slowing the whole take to reach the floor is a claim about how fast the app
 * is. Over 30 there is a window to choose, and choosing it is the person's or the
 * agent's, not this function's.
 */
function lengthPlan (seconds, opts = {}) {
  const { min, max } = VIDEO.seconds
  const s = +seconds
  if (!Number.isFinite(s) || s <= 0) {
    return { ok: false,
      reason: `an app preview is ${min} to ${max} seconds and this take's length is not known here, so nothing can promise one.`,
      fix: ['hand in the take\'s duration in seconds'] }
  }
  if (s < min) {
    return { ok: false,
      reason: `this take runs ${r3(s)}s and an app preview is ${min} to ${max} seconds. ${r3(min - s)}s of it does not exist yet.`,
      fix: [`record ${r3(min - s)}s more of the app`,
        'or hold a step longer with the speed control, which changes the pace of what was recorded rather than inventing frames'] }
  }
  const asked = opts.length == null ? null : +opts.length
  if (asked != null && (!Number.isFinite(asked) || asked < min || asked > max)) {
    return { ok: false,
      reason: `a ${Number.isFinite(asked) ? r3(asked) : 'nameless'}s window is not a preview: it is ${min} to ${max} seconds.`,
      fix: [`ask for a window between ${min} and ${max} seconds`] }
  }
  if (s <= max) return { ok: true, out: r3(s), trim: null }

  const length = asked == null ? max : asked
  const last = r3(s - length)
  const from = opts.from == null ? null : +opts.from
  if (from == null) {
    return { ok: true, out: r3(length),
      trim: { required: true, from: null, length: r3(length), latestStart: last },
      needs: `this take is ${r3(s)}s, so a ${r3(length)}s window has to be picked out of it, anywhere from 0 to ${last}s in. Nothing here picks it: list_beats and fit_to_length are where that choice is made.` }
  }
  if (!Number.isFinite(from) || from < 0 || from + length > s + 0.001) {
    return { ok: false,
      reason: `a ${r3(length)}s window starting at ${Number.isFinite(from) ? r3(from) : 'nowhere'}s runs off the end of a ${r3(s)}s take.`,
      fix: [`start it between 0 and ${last}s`] }
  }
  return { ok: true, out: r3(length), trim: { required: false, from: r3(from), length: r3(length), latestStart: last } }
}

/**
 * Given a take, what preview it can be made into, and what it is refused for.
 *
 *   preview({w, h, seconds, fps}, 'app-preview-6.9', {crop, share, from, codec})
 *
 * Called with no target it answers the question people actually have, which is "what can
 * this be", by trying every preview in the table and handing back the largest one that
 * holds up.
 *
 * `ok` is whether this take can become this preview at all. `ready` is whether everything
 * needed to write it is already here: a take longer than thirty seconds is a preview and
 * is not ready, because somebody still has to say which thirty seconds.
 */
function preview (take = {}, target = null, opts = {}) {
  if (target == null) return bestPreview(take, opts)
  const t = resolve(target)
  if (!t.ok) return t
  const p = t.preset
  const size = { w: p.w, h: p.h }
  if (p.kind !== 'video') {
    return { ok: false, preset: p.id, size,
      reason: `${p.id} is ${p.what.toLowerCase()}, and a preview is a video. Take a shot and export that at a still size, or ask for one of ${previewIds().join(', ')}.` }
  }

  const crop = opts.crop || take.crop || null
  const src = sourceOf(take, crop)
  if (!src) {
    return { ok: false, preset: p.id, size,
      reason: 'a take needs a width and a height in pixels, and a crop has to fit inside it, before anything can be fitted to a size.' }
  }

  // The family is the take's own, not a guess off its shape, and it is a refusal rather
  // than a warning: an iPad preview showing a phone is a claim about the app that the
  // person will have to answer for, and no amount of drawn room around it makes it true.
  const family = key(opts.family || take.family || '')
  if (family && family !== p.family) {
    return { ok: false, preset: p.id, size, source: src,
      reason: `this take came off ${FAMILY_SAID[family] || family} and ${p.id} is ${classSaid(p)}. A preview in one family's size showing another family's app is a claim about the app that is not true.`,
      fix: [`shoot it on ${FAMILY_SAID[p.family] || p.family} and make the preview from that take`,
        ...(previewIds().filter(id => PRESETS[id].family === family).length
          ? [`or use ${previewIds().filter(id => PRESETS[id].family === family).join(' or ')}, which is where this take belongs`] : [])] }
  }

  const turned = orientOf(src)
  if (turned !== 'square' && turned !== p.orient) {
    return { ok: false, preset: p.id, size, source: src,
      reason: `this take is ${px(src)}, which is ${turned}, and ${p.id} is ${p.orient}. A ${turned} take in a ${p.orient} picture is a bar down each side of it, and Fetch does not ship a bar.`,
      fix: p.sibling
        ? [`use ${p.sibling}, the ${turned} size the same class accepts`]
        : [`the ${p.class} class has no ${turned} preview size, so shoot it ${p.orient}`] }
  }

  const f = fit(take, p.id, { crop, share: opts.share, device: opts.device })
  if (!f.ok) return f

  const needs = [], warnings = [], steps = []

  const len = lengthPlan(take.seconds, opts)
  if (!len.ok) return { ok: false, preset: p.id, size, source: src, reason: len.reason, fix: len.fix }
  if (len.needs) needs.push(len.needs)

  const fps = fpsPlan(take.fps)
  if (fps.unknown) needs.push('the take\'s frame rate, so the cap at 30 can be met by dropping frames rather than by hoping')

  const codec = codecOf(opts.codec || take.codec) || 'h264'
  if (!p.codecs.includes(codec)) {
    return { ok: false, preset: p.id, size, source: src,
      reason: `${saidCodec(codec)} is not a codec the store takes for a preview. It takes ${p.codecs.map(saidCodec).join(' or ')}.`,
      fix: [`write it as ${saidCodec(p.codecs[0])}, which is what Fetch exports anyway`] }
  }
  const container = containerOf(opts.container || take.container) || (codec === 'prores422hq' ? 'mov' : 'mp4')
  if (!p.containers[codec].includes(container)) {
    return { ok: false, preset: p.id, size, source: src,
      reason: `${saidCodec(codec)} has to be delivered in ${p.containers[codec].map(c => '.' + c).join(' or ')}, and this is .${container}.`,
      fix: [`write it as .${p.containers[codec][0]}`] }
  }

  const bytes = weigh(codec, size, len.out, fps.out)
  if (bytes != null && bytes > p.bytes) {
    const most = longestAt(codec, size, fps.out)
    return { ok: false, preset: p.id, size, source: src,
      reason: `${r3(len.out)}s of ${px(size)} as ${saidCodec(codec)} is about ${mb(bytes)} MB at its own stated rate and the limit is ${mb(p.bytes)} MB.`,
      fix: [...(codec === 'prores422hq' ? ['write it as H.264 at 10 to 12 Mbps, which is about ' + mb(weigh('h264', size, len.out, fps.out)) + ' MB for the same picture'] : []),
        ...(most ? [`or keep it to ${most}s, which is the longest ${saidCodec(codec)} fits in ${mb(p.bytes)} MB at this size`] : [])] }
  }

  const level = level4(size, fps.out)
  if (codec === 'h264' && !level.ok) {
    return { ok: false, preset: p.id, size, source: src,
      reason: `${px(size)} at ${fps.out} frames a second is ${level.rate} macroblocks a second and High Profile Level 4.0 allows 245,760.`,
      fix: [`write it at ${Math.floor(245760 / level.blocks)} frames a second or under`] }
  }

  // Steps, in the order the export has to do them, because a plan that is only numbers
  // gets relayed as prose and half of it gets dropped on the way.
  if (len.trim) {
    steps.push(len.trim.from == null
      ? `pick a ${r3(len.out)}s window out of the ${r3(+take.seconds)}s take, no later than ${len.trim.latestStart}s in`
      : `trim to ${r3(len.out)}s from ${len.trim.from}s`)
  }
  if (crop) steps.push(`crop the capture to ${px(src)}, which is the part that is the app`)
  const spare = f.leftover.w && f.leftover.h ? `${f.leftover.w} by ${f.leftover.h} pixels`
    : (f.leftover.w ? `${f.leftover.w} pixels across` : `${f.leftover.h} pixels down`)
  steps.push(f.edgeToEdge
    ? `draw it at ${px(f.box)}, which fills ${px(size)}`
    : `draw it at ${px(f.box)} inside ${px(size)} and fill the ${spare} that are not the take with the take blurred, never with black`)
  if (fps.every && fps.every > 1) steps.push(`write ${fps.out} frames a second, one frame in ${fps.every} of the take's ${fps.take}, none of them invented`)
  else steps.push(`write ${fps.unknown ? 'at most ' + VIDEO.fps.max : fps.out} frames a second`)
  steps.push(`encode ${saidCodec(codec)} into .${container}` +
    (codec === 'h264' ? `, progressive, High Profile Level ${VIDEO.h264.level}, a constant ${VIDEO.h264.bps / 1e6} Mbps inside the page's 10 to 12` : ', progressive, no external references'))

  // Room is a layout decision and not a fault, up to the point where the picture is more
  // backdrop than app, which is where somebody should be told what they are shipping.
  const room = Math.max(f.leftover.w / size.w, f.leftover.h / size.h)
  if (room > 0.12) {
    warnings.push(`${Math.round(room * 100)}% of this picture is drawn room rather than the take. That is a layout choice and the store does not mind, but it is what a stranger sees first.`)
  }
  if (fps.out < 24 && !fps.unknown) {
    warnings.push(`this lands at ${fps.out} frames a second, under the 24 a moving picture usually holds. The take is ${fps.take}, and 48 or 60 halves onto the cap cleanly where ${fps.take} does not.`)
  }
  // The page's audio line, as a step the export takes: one stereo track, AAC at 256
  // kbps, 44.1 or 48 kHz. Fetch writes 48 kHz and folds a take's two tracks (the device
  // and the microphone) into one when it lands, so this is the bit rate and the layout.
  steps.push('write the sound as one stereo AAC track at 256 kbps and 48 kHz')
  if (take.hasAudio === false) {
    // Nothing on the page says a file with no track is taken, so it gets a silent one of
    // the listed shape rather than a claim that none is fine.
    steps.push('this take has no sound, so the track is silence of that same shape')
    warnings.push('this take has no audio track, so the preview carries a silent one. A preview with nothing to hear is the weakest version of one, and a take is recorded with sound or it is not: there is no adding it afterwards except as a voiceover.')
  }
  const audio = take.audio || null
  if (audio && +audio.channels === 1) steps.push('write the sound as stereo: the store takes stereo, and one channel doubled is still the same sound')
  if (audio && +audio.rate > 0 && !VIDEO.audio.rates.includes(Math.round(+audio.rate))) {
    steps.push(`resample the sound to 48 kHz: it is ${Math.round(+audio.rate)} Hz and the store takes 44.1 or 48`)
  }

  return {
    ok: true, ready: needs.length === 0, preset: p.id, kind: 'video', what: p.what,
    family: p.family, class: p.class, orient: p.orient,
    size, source: src, box: f.box, density: f.density, share: f.share, maxShare: f.maxShare,
    leftover: f.leftover, edgeToEdge: f.edgeToEdge, bleed: f.bleed,
    seconds: { take: r3(+take.seconds), out: len.out, min: VIDEO.seconds.min, max: VIDEO.seconds.max },
    trim: len.trim, fps, codec, container,
    bytes: { estimate: bytes, limit: p.bytes },
    // The frame the store shows before anybody presses play. It is five seconds in by
    // default, so five seconds in is worth something being on screen.
    poster: VIDEO.poster,
    steps, needs, warnings,
  }
}

/** Every preview this take can be, largest first, and the reason for each one it cannot. */
function previews (take = {}, opts = {}) {
  const can = [], cannot = []
  for (const p of Object.values(PRESETS)) {
    if (p.kind !== 'video') continue
    const r = preview(take, p.id, opts)
    if (r.ok) can.push(r)
    else cannot.push({ preset: p.id, size: { w: p.w, h: p.h }, reason: r.reason, fix: r.fix || [] })
  }
  // Shape before size. With no family said, the biggest preview a phone take fits is
  // the iPad's, drawn at 736 x 1600 with 39% of the picture blurred room: a different
  // family's size ahead of the one whose shape is the take's. So a preview that is a
  // tenth or more less room goes first, and size only settles the ones alike in room.
  const room = r => Math.max(r.leftover.w / r.size.w, r.leftover.h / r.size.h)
  can.sort((a, b) => (b.ready - a.ready) ||
    (Math.abs(room(a) - room(b)) > 0.1 ? room(a) - room(b) : 0) ||
    (b.size.w * b.size.h - a.size.w * a.size.h))
  return { ok: can.length > 0, can, cannot }
}

function bestPreview (take, opts) {
  const all = previews(take, opts)
  if (all.ok) return all.can[0]
  const reasons = [...new Set(all.cannot.map(c => c.reason))]
  return {
    ok: false, cannot: all.cannot,
    reason: reasons.length === 1
      ? reasons[0]
      : 'this take is not any of the app previews the store accepts. ' +
        all.cannot.map(c => `${c.preset}: ${c.reason}`).join(' '),
    fix: [...new Set([].concat(...all.cannot.map(c => c.fix || [])))],
  }
}

/**
 * A file that already exists, against the rules it will be judged by. preview() plans one
 * and this checks one: the export path calls the first before it draws and the second on
 * what it wrote, because the store measures the file and not the plan.
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
  // The edit's own length, where the caller knows it. A legal 24 s file cut from a 28 s
  // edit passes every store rule and has lost the end of somebody's demo, so the store's
  // window is not the only length a file is held to. Within one frame at the cap.
  const expect = +(clip && clip.expect)
  if (Number.isFinite(secs) && expect > 0 && Math.abs(secs - expect) > 1 / p.fps.max + 0.005) {
    bad.push(`it runs ${r3(secs)}s and the edit it was made from is ${r3(expect)}s`)
  }
  // The picture's own rate against the band the page states. Nothing at upload refuses a
  // thin file, but a plan that says 10 to 12 Mbps and a file at 0.46 is a sentence that
  // is not true, so a file outside the band is not called the store file.
  const bps = +(clip && clip.bps)
  if (bps > 0 && codecOf(clip.codec || 'h264') === 'h264') {
    const { min, max } = VIDEO.h264.band
    if (bps < min * 0.98 || bps > max * 1.02) {
      bad.push(`its picture is ${r3(bps / 1e6)} Mbps and an H.264 preview targets ${min / 1e6} to ${max / 1e6}`)
    }
  }
  const bytes = +(clip && clip.bytes)
  if (Number.isFinite(bytes) && bytes > p.bytes) {
    bad.push(`it weighs ${mb(bytes)} MB and the limit is ${mb(p.bytes)} MB`)
  }
  const codec = clip && clip.codec ? codecOf(clip.codec) : null
  if (codec && !p.codecs.includes(codec)) {
    bad.push(`it is ${saidCodec(codec)} and an app preview has to be ${p.codecs.map(saidCodec).join(' or ')}`)
  }
  const container = clip && clip.container ? containerOf(clip.container) : null
  if (container && codec && p.containers[codec] && !p.containers[codec].includes(container)) {
    bad.push(`it is a .${container} and ${saidCodec(codec)} is delivered in ${p.containers[codec].map(c => '.' + c).join(' or ')}`)
  }
  const fps = +(clip && clip.fps)
  if (Number.isFinite(fps) && fps > p.fps.max + 0.005) {
    bad.push(`it runs at ${r3(fps)} frames a second and the cap is ${p.fps.max}`)
  }
  const size = clip && +clip.w > 0 && +clip.h > 0 ? { w: Math.round(+clip.w), h: Math.round(+clip.h) } : null
  if (size && !(size.w === p.w && size.h === p.h)) {
    bad.push(`it is ${px(size)} and ${p.id} is ${px({ w: p.w, h: p.h })} exactly`)
  }
  return bad.length
    ? { ok: false, preset: p.id, reason: bad.join(', ') + '.', problems: bad }
    : { ok: true, preset: p.id, seconds: p.seconds, bytes: p.bytes, fps: p.fps }
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

module.exports = { PRESETS, REFUSED, ALIASES, VIDEO, list, get, resolve, fit, fitSize, best,
  bleed, reach, checkClip, cost, preview, previews, orientOf, codecOf, containerOf, level4,
  weigh, longestAt, fpsPlan, lengthPlan }
