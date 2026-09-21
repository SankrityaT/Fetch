// A simulator as a thing Fetch can hold (ui/simulator.js): the simctl reads, the join
// to the window list, and the device screen's rectangle inside that window.
//
// Every fixture below is shaped like what this Mac actually printed, and the numbers in
// the viewport and density cases are the ones measured in .context/survey/sim-m0.md:
// an iPhone 16 Pro Max whose window was 396 x 856 points at backing scale 2, against a
// native 1320 x 2868.
const S = require('../ui/simulator')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const ok = (name, cond) => is(name, !!cond, true)
const near = (name, got, want, tol = 0.001) => ok(`${name} (${got})`, Math.abs(got - want) <= tol)

const DEVICES = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { udid: 'A1EDEC56-560D-4E95-A19C-87F2FC438103', isAvailable: true, state: 'Booted',
        name: 'Round-Shots-16PM', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max' },
      { udid: '2321BA9C-16CE-4E5A-B466-1CFBA0E25142', isAvailable: true, state: 'Shutdown',
        name: 'FairSplit-Loop', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max' },
      { udid: '9F72E171-D1DD-4A7E-8C78-2CB1F540AE95', isAvailable: false, state: 'Shutdown',
        name: 'Gone-Runtime', availabilityError: 'runtime profile not found',
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4' },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-26-5': [
      { udid: '1ECD0DFB-6473-435A-8816-CBD2EBB4A290', isAvailable: true, state: 'Shutdown',
        name: 'Apple Watch Series 11 (46mm)',
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-11-46mm' },
    ],
  },
})

const RUNTIMES = JSON.stringify({
  runtimes: [
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', version: '26.5', name: 'iOS 26.5',
      platform: 'iOS', isAvailable: true,
      supportedDeviceTypes: [
        { name: 'iPhone 16 Pro Max', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max',
          productFamily: 'iPhone', bundlePath: '/L/iPhone 16 Pro Max.simdevicetype' },
        { name: 'iPad Pro 13-inch (M4)', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4',
          productFamily: 'iPad', bundlePath: '/L/iPad Pro 13-inch (M4).simdevicetype' },
      ] },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-26-5', version: '26.5', name: 'watchOS 26.5',
      platform: 'watchOS', isAvailable: true,
      supportedDeviceTypes: [
        { name: 'Apple Watch Series 11 (46mm)', productFamily: 'Apple Watch',
          identifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-11-46mm',
          bundlePath: '/L/Apple Watch Series 11 (46mm).simdevicetype' },
      ] },
  ],
})

const PROFILE_16PM = JSON.stringify({
  mainScreenWidth: 1320, mainScreenHeight: 2868, mainScreenScale: 3,
  modelIdentifier: 'iPhone17,2', framebufferMask: 'EB31C0E2-52E0-430E-B4DA-4242D2881AFF',
})
const SCREEN = { w: 1320, h: 2868, scale: 3, points: { w: 440, h: 956 } }

console.log('what simctl says')
{
  const d = S.parseDevices(DEVICES)
  is('a runtime with no devices is an empty array, not an absence', d.filter(x => /iOS-26-4/.test(x.runtimeId)).length, 0)
  is('every available device came through', d.length, 3)
  is('unavailable devices are left out', d.filter(x => x.name === 'Gone-Runtime').length, 0)
  const all = S.parseDevices(DEVICES, { unavailable: true })
  is('and are kept when asked for, with the reason', all.find(x => x.name === 'Gone-Runtime').availabilityError, 'runtime profile not found')
  is('state stays the display string simctl printed', d[0].state, 'Booted')
  is('the runtime key is carried down onto the device', d[0].runtimeId, 'com.apple.CoreSimulator.SimRuntime.iOS-26-5')
  is('nothing at all parses to nothing', S.parseDevices(''), [])
  is('an empty object parses to nothing', S.parseDevices('{}'), [])
}
{
  let threw = ''
  try { S.parseDevices('Usage: simctl list [devices]') } catch (e) { threw = e.message }
  ok('usage text on stdout is refused, not parsed', /stderr/.test(threw))
}
{
  const r = S.parseRuntimes(RUNTIMES)
  is('runtimes are keyed by identifier', r['com.apple.CoreSimulator.SimRuntime.iOS-26-5'].name, 'iOS 26.5')
  const t = S.deviceTypesFromRuntimes(r)
  is('a runtime carries the family a device record does not', t['com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4'].family, 'iPad')
  is('and the bundle the profile lives in', S.profilePath(t['com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max']),
    '/L/iPhone 16 Pro Max.simdevicetype/Contents/Resources/profile.plist')
  is('no bundle, no path', S.profilePath({}), null)
  const both = S.parseDeviceTypes(JSON.stringify({ devicetypes: [{ identifier: 'x', name: 'X', productFamily: 'iPhone' }] }), t)
  is('list devicetypes folds into the same map', both.x.family, 'iPhone')
}

console.log('the screen, which only the profile knows')
{
  const p = S.parseProfile(PROFILE_16PM)
  is('pixels as printed', [p.w, p.h, p.scale], [1320, 2868, 3])
  is('points are pixels over the scale, which is what a tap is expressed in', [p.points.w, p.points.h], [440, 956])
  is('a profile with no screen in it is null, not a zero', S.parseProfile('{"modelIdentifier":"x"}'), null)
  is('and so is nothing', S.parseProfile(''), null)
}
{
  // two devices of one model share a profile, and reading it twice is one read wasted
  const seen = []
  const load = path => { seen.push(path); return PROFILE_16PM }
  const types = S.deviceTypesFromRuntimes(S.parseRuntimes(RUNTIMES))
  const ids = S.parseDevices(DEVICES).map(d => d.deviceTypeId)
  const got = S.readProfiles(ids, types, load)
  is('read once per device type, not once per device', seen.length, 2)
  is('the phone came back', got['com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max'].points.w, 440)
  S.readProfiles(ids, types, load, got)
  is('and a second pass over the same map reads nothing again', seen.length, 2)
}

// ── the glass, read off a capture ────────────────────────────────────────
//
// Every frame below is drawn to a geometry measured off a real booted device on this
// Mac (.context/survey/st-t0.md): a floating toolbar, a band of clear pixels, then the
// device, and inside the device a grey bezel, a black ring and the app. The pixel
// numbers are the ones the real captures gave, so a change that moves an edge by one
// pixel shows up here as the device it would have missed.
const DEVICE = {
  // iPhone 16 Pro Max, window 397 x 859 points, capture 794 x 1718
  proMax: { cap: { w: 794, h: 1718 }, toolbar: 104, body: { x0: 10, x1: 782, y0: 127, y1: 1715 },
    glass: { x: 44, y: 154, w: 706, h: 1534 }, screen: { w: 1320, h: 2868, scale: 3 }, win: { w: 397, h: 859 } },
  // iPhone SE 3rd generation, window 399 x 852: a home button below the glass, so the
  // window's own shape is nothing like the screen's
  se: { cap: { w: 798, h: 1704 }, toolbar: 104, body: { x0: 11, x1: 785, y0: 126, y1: 1701 },
    glass: { x: 66, y: 321, w: 666, h: 1185 }, screen: { w: 750, h: 1334, scale: 2 }, win: { w: 399, h: 852 } },
  // iPhone 17 Pro, window 390 x 840
  pro17: { cap: { w: 780, h: 1680 }, toolbar: 104, body: { x0: 10, x1: 768, y0: 125, y1: 1678 },
    glass: { x: 47, y: 155, w: 687, h: 1494 }, screen: { w: 1206, h: 2622, scale: 3 }, win: { w: 390, h: 840 } },
}

// A capture of a Simulator window, drawn from one of those. `app` decides what the glass
// holds: an app is lit by default, and `black` is the one thing that can hide the ring.
function frameOf(d, o = {}) {
  const { w, h } = d.cap
  const data = new Uint8Array(w * h * 4)
  const put = (x, y, v) => { const p = (y * w + x) * 4; data[p] = data[p + 1] = data[p + 2] = v; data[p + 3] = 255 }
  const grey = o.grey == null ? 44 : o.grey
  for (let y = 0; y < (o.toolbar === false ? 0 : d.toolbar); y++) for (let x = 40; x < w - 40; x++) put(x, y, 30)
  for (let y = d.body.y0; y <= d.body.y1; y++) {
    for (let x = d.body.x0; x <= d.body.x1; x++) {
      const out = Math.min(x - d.body.x0, d.body.x1 - x, y - d.body.y0, d.body.y1 - y)
      let inGlass = x >= d.glass.x && x < d.glass.x + d.glass.w && y >= d.glass.y && y < d.glass.y + d.glass.h
      // The glass's own rounded corners: `corner` is how many pixels of ring the row t
      // from the top or the bottom still has inside the rectangle, the real capture's.
      if (inGlass && o.corner) {
        const t = Math.min(y - d.glass.y, d.glass.y + d.glass.h - 1 - y)
        const e = Math.min(x - d.glass.x, d.glass.x + d.glass.w - 1 - x)
        if (t < o.corner.length && e < o.corner[t]) inGlass = false
      }
      if (inGlass) {
        const dark = o.app === 'black' || (o.app === 'left' && x < d.glass.x + 40) ||
          // a dark status bar in one corner, touching the ring: 60 by 30 of black app
          (o.app === 'corner' && x < d.glass.x + 60 && y < d.glass.y + 30)
        put(x, y, dark ? 0 : 120 + ((x * 7 + y * 13) % 90))
      } else put(x, y, out < (o.grey === 0 ? 0 : 8) ? grey : 0)
    }
  }
  // A home button, which is lit and below the glass: the one thing under a device that
  // an edge walk coming up from the bottom finds before it finds the screen.
  if (o.homeButton) {
    const cx = (d.body.x0 + d.body.x1) >> 1, cy = d.glass.y + d.glass.h + 78
    for (let y = cy - 40; y <= cy + 40; y++) for (let x = cx - 40; x <= cx + 40; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= 40 * 40 && y <= d.body.y1) put(x, y, 90)
    }
  }
  return { width: w, height: h, data }
}

console.log('the glass, measured off the pixels')
for (const key of Object.keys(DEVICE)) {
  const d = DEVICE[key]
  const m = S.measureGlass(frameOf(d, { homeButton: key === 'se' }))
  is(`${key}: the rectangle is the one measured on the real device`, m.ok && m.value.px, d.glass)
  ok(`${key}: and nearly every scan line agreed`, m.value.agree > 0.6)
  is(`${key}: which way up it is comes off the glass, not the window`, S.glassOrient(m, d.screen), 'portrait')
  const v = S.viewport(d.win, d.screen, { glass: m })
  is(`${key}: the viewport is the measurement, in fractions of the frame`, v, {
    x: Math.round(d.glass.x / d.cap.w * 1e4) / 1e4, y: Math.round(d.glass.y / d.cap.h * 1e4) / 1e4,
    w: Math.round(d.glass.w / d.cap.w * 1e4) / 1e4, h: Math.round(d.glass.h / d.cap.h * 1e4) / 1e4,
  })
  is(`${key}: and the density is the glass over the device's own pixels`, S.density(d.win, d.screen, { glass: m }),
    Math.round(d.glass.w / d.screen.w * 100) / 100)
}
{
  // The fit, on the same three windows, against what the pixels say. This is the whole
  // reason the measurement exists: on two of the three the window's shape hides the
  // error, and on the third it is a number over 1, which is a store gate letting an
  // upscale through rather than refusing it.
  is('fitted, a phone with a notch reads 0.60 where the glass says 0.53',
    S.density(DEVICE.proMax.win, DEVICE.proMax.screen, { backingScale: 2 }), 0.6)
  is('fitted, an iPhone 17 Pro reads 0.64 where the glass says 0.57',
    S.density(DEVICE.pro17.win, DEVICE.pro17.screen, { backingScale: 2 }), 0.64)
  is('and a home button window is refused outright, because its shape gives it away',
    S.viewport(DEVICE.se.win, DEVICE.se.screen), null)
  const notch = S.viewport(DEVICE.proMax.win, DEVICE.proMax.screen)
  ok('a notched window passes the shape check while the fit is 12 percent out',
    Math.abs((DEVICE.proMax.win.w / DEVICE.proMax.win.h) / (440 / 956) - 1) < 0.005 && notch.w > 0.99)
}
{
  const d = DEVICE.proMax
  is('an app painted black to its own edge hides the ring, and nothing is reported',
    S.measureGlass(frameOf(d, { app: 'black' })).ok, false)
  ok('and says what that looks like',
    /ring was found|did not agree/.test(S.measureGlass(frameOf(d, { app: 'black' })).reason))
  const half = S.measureGlass(frameOf(d, { app: 'left' }))
  ok('an app black down one side measures a narrower rectangle', half.ok && half.value.px.w < d.glass.w)
  is('which is the wrong shape for the screen, so no viewport comes off it',
    S.viewport(d.win, d.screen, { glass: half }), null)
  // Simulator can be told to draw no device around the screen. Then the window is the
  // glass, there is no ring, and this refuses rather than guessing that it is.
  const bare = { ...d, body: { x0: d.glass.x, x1: d.glass.x + d.glass.w - 1, y0: d.glass.y, y1: d.glass.y + d.glass.h - 1 } }
  is('a device with its bezels hidden has no ring to find', S.measureGlass(frameOf(bare)).ok, false)
  is('nothing is not a frame', S.measureGlass(null).ok, false)
  is('and neither is a frame with no pixels behind it', S.measureGlass({ width: 10, height: 10, data: new Uint8Array(8) }).ok, false)
}
{
  // The device on its side. No simctl verb turns a simulator and Fetch presses no key,
  // so this one is the real portrait geometry transposed rather than a capture: what it
  // pins is that the glass decides the orientation, where the window only guesses.
  const d = DEVICE.proMax
  const land = { cap: { w: d.cap.h, h: 920 }, toolbar: 104,
    body: { x0: 127, x1: 1715, y0: 136, y1: 908 },
    glass: { x: 154, y: 170, w: d.glass.h, h: d.glass.w } }
  const win = { w: 859, h: 460 }
  const m = S.measureGlass(frameOf(land))
  is('the glass is the wide rectangle', m.ok && m.value.px.w > m.value.px.h, true)
  is('so the device is on its side, and nothing had to read the window', S.glassOrient(m, SCREEN), 'landscape')
  const v = S.viewport(win, SCREEN, { glass: m })
  ok('and the viewport that comes off it is that rectangle', v.w > v.h)
  is('the same glass turned is the same density', S.density(win, SCREEN, { glass: m }),
    Math.round((m.value.px.w / SCREEN.h) * 100) / 100)
}

console.log('the glass is round, and how round is read off the pixels')
// The ring's inner edge on each row down from the top left corner of the glass, off a
// real 794 x 1718 capture of Yolk-ProMax (iPhone 16 Pro Max, iOS 26.5): row 0 still has
// 97 pixels of ring inside the rectangle, row 96 has 1, row 97 none. The same curve in
// all four corners measured 111.4, 111.4, 110.3 and 111.4 pixels off that capture.
const PROFILE = [97, 89, 82, 77, 73, 69, 66, 63, 60, 58, 56, 53, 51, 49, 48, 46, 44, 43, 41, 40, 38, 37,
  36, 35, 34, 32, 31, 30, 29, 28, 27, 26, 26, 25, 24, 23, 22, 21, 21, 20, 19, 18, 18, 17, 16, 16, 15, 15, 14,
  14, 13, 12, 12, 11, 11, 11, 10, 10, 9, 9, 8, 8, 8, 7, 7, 7, 6, 6, 6, 5, 5, 5, 5, 4, 4, 4, 4, 3, 3, 3, 3, 3,
  2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1]
{
  const d = DEVICE.proMax
  const m = S.measureGlass(frameOf(d, { corner: PROFILE }))
  is('rounding the corners does not move the rectangle', m.ok && m.value.px, d.glass)
  is('the corner is the smallest circle that hides every pixel of that ring',
    m.value.corner, { px: 111.4, share: 0.1578, corners: [111.39, 111.39, 111.39, 111.39] })
  // Every row of the profile is under the circle: the mask hides all of the bezel.
  const R = m.value.corner.px
  ok('no row of ring is left outside the circle', PROFILE.every((dd, t) => {
    const tp = t + 0.5
    return tp >= R || R - Math.sqrt(R * R - (R - tp) ** 2) >= dd - 1e-9
  }))
  // The guess it replaces: Fetch's phone drew its screen at 0.03 of the width, a fifth
  // of the glass's own, which is the crescent the judge saw.
  ok('and it is five times what the drawn phone used to round its screen by', m.value.corner.share > 5 * 0.03)
  const v = S.viewport(d.win, d.screen, { glass: m })
  is('the viewport carries it beside the rectangle', v, { x: 0.0554, y: 0.0896, w: 0.8892, h: 0.8929, corner: 0.1578 })
  is('and a corner handed back as a fraction survives a second read', S.glassViewport(v, d.screen), v)

  // A dark app in one corner runs into the ring and makes that corner look rounder. It
  // cannot make one look squarer, so the smallest of the four is the glass's.
  const dark = S.measureGlass(frameOf(d, { corner: PROFILE, app: 'corner' }))
  is('an app dark into one corner does not round the others', dark.value.corner,
    { px: 111.4, share: 0.1578, corners: [149, 111.39, 111.39, 111.39] })

  // Square glass, and the fixtures before this round: no corner, and the viewport keeps
  // exactly the four numbers everything downstream already reads.
  is('a square screen has no corner to report', S.measureGlass(frameOf(DEVICE.se, { homeButton: true })).value.corner, undefined)
  is('and its viewport is the plain rectangle', Object.keys(S.viewport(DEVICE.se.win, DEVICE.se.screen,
    { glass: S.measureGlass(frameOf(DEVICE.se, { homeButton: true })) })), ['x', 'y', 'w', 'h'])
  is('a corner that is not a share of anything is dropped', Object.keys(S.glassViewport({ ...v, corner: 0.7 }, d.screen)), ['x', 'y', 'w', 'h'])

  // A take measured before the corner was: the document has the rectangle and nothing
  // else, and the only pixels left are the recording's. A recording has no alpha, so
  // what was clear round the device is black, and the toolbar is no band of its own.
  const video = f => { for (let p = 3; p < f.data.length; p += 4) f.data[p] = 255; return f }
  const old = { x: 0.0554, y: 0.0896, w: 0.8892, h: 0.8929 }
  const got = S.measureCorner(video(frameOf(d, { corner: PROFILE })), old)
  is('an old take\'s corner is read off a frame of the take, round the rectangle it already has',
    got.ok && { px: got.value.px, share: got.value.share }, { px: 111.4, share: 0.1578 })
  is('and the rectangle is found again to the frame\'s own pixels', got.value.rect, old)
  is('it is the same number a new capture writes', got.value.share, v.corner)
  is('a square screen answers with no corner', S.measureCorner(video(frameOf(DEVICE.se, { homeButton: true })),
    S.viewport(DEVICE.se.win, DEVICE.se.screen, { glass: S.measureGlass(frameOf(DEVICE.se, { homeButton: true })) })).value.share, 0)
  is('a frame of an app black to its edge reads no corner rather than a wrong one',
    S.measureCorner(video(frameOf(d, { corner: PROFILE, app: 'black' })), old).ok, false)
  is('a rectangle the ring is not round reads nothing',
    S.measureCorner(video(frameOf(d, { corner: PROFILE })), { ...old, x: 0.08 }).ok, false)
  is('and no rectangle is no corner', S.measureCorner(video(frameOf(d)), null).ok, false)
}

console.log('a corner is measured right, and never stored wrong')
// The four corners of a real frame of a real take (recording-1789991341899, Yolk-ProMax,
// iPhone 16 Pro Max, 794 x 1718, the frame at 20 s), each turned so the corner is top left,
// from 14 pixels outside the glass's corner to 186 inside it. Each row is runs of dark
// (the encoder's 12 and under) and lit, starting with dark. The capture wrote 0.1578 for
// this take and the old reading said 0.0535 off every frame of it, because in a recording
// what was clear round the window is black, and the bezel's grey edge curving into the
// rectangle's corner then sits after a run of dark exactly as the glass does.
const REAL_CORNERS = {
  tl: [
    '61 41 98', '58 37 105', '56 34 110', '54 31 115', '52 30 118', '51 27 122', '49 26 125',
    '47 25 128', '46 23 131', '44 23 133', '42 22 136', '41 21 138', '39 21 140', '38 20 142',
    '37 19 56 88', '35 20 48 97', '34 19 43 104', '33 18 40 109', '32 18 37 113', '31 17 35 117',
    '30 17 33 120', '28 17 32 123', '27 17 30 126', '26 17 29 128', '25 16 29 130', '24 16 27 133',
    '23 16 26 135', '22 16 26 136', '22 15 25 138', '21 15 24 140', '20 14 25 141', '19 14 24 143',
    '18 14 23 145', '17 14 23 146', '17 13 23 147', '16 14 21 149', '15 14 21 150', '14 14 21 151',
    '14 13 21 152', '13 13 21 153', '12 13 20 155', '11 14 19 156', '11 13 19 157', '10 13 19 158',
    '10 12 19 159', '9 13 18 160', '8 13 19 160', '8 12 19 161', '7 13 18 162', '7 12 18 163',
    '6 12 18 164', '5 13 17 165', '5 12 18 165', '4 13 17 166', '4 12 17 167', '3 12 17 168',
    '3 12 17 94 2 72', '2 12 17 91 8 24 4 11 3 28', '2 12 16 91 3 4 4 21 5 9 5 28',
    '2 11 17 91 2 7 2 21 1 2 2 8 2 2 2 28', '1 12 16 91 2 9 2 6 2 11 2 2 2 7 2 3 2 28',
    '1 11 17 91 2 9 2 6 3 9 2 3 2 7 1 4 2 28', '0 12 16 92 2 9 3 5 2 10 1 4 2 12 2 28',
    '0 11 17 92 2 9 3 16 2 4 2 12 2 28', '0 11 16 93 2 9 3 15 2 5 2 12 2 28',
    '0 11 16 93 3 7 4 15 2 5 2 12 2 28', '0 10 16 95 3 5 1 2 2 14 2 6 2 12 2 28',
    '0 10 16 96 4 2 1 3 2 14 1 7 2 12 2 28', '0 9 16 98 5 4 2 13 2 7 2 12 2 28',
    '0 9 16 107 2 12 2 8 2 12 2 28', '0 9 15 107 2 6 2 5 15 9 2 28',
    '0 8 16 107 2 6 3 4 15 9 2 28', '0 8 15 97 3 7 3 6 2 15 3 11 2 28',
    '0 8 15 98 2 7 2 24 2 12 2 28', '0 7 15 100 3 3 3 25 2 12 2 28', '0 7 15 101 7 26 2 12 2 28',
    '0 7 15 178', '0 6 15 179', '0 6 15 179', '0 6 15 179', '0 6 14 180', '0 5 15 180',
    '0 5 15 180', '0 5 14 181', '0 4 15 181', '0 4 15 181', '0 4 15 181', '0 4 14 182',
    '0 4 14 182', '0 3 15 182', '0 3 15 182', '0 3 14 183', '0 3 14 183', '0 3 14 183',
    '0 2 15 183', '0 2 15 183', '0 2 14 184', '0 2 14 184', '0 2 14 184', '0 2 14 184',
    '0 2 14 184', '0 1 15 184', '0 1 15 184', '0 1 14 185', '0 1 14 185', '0 1 14 185',
    '0 1 14 185', '0 1 14 185', '0 1 14 185', '0 1 14 185', '0 1 14 185', '15 185', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
  ],
  tr: [
    '61 41 98', '58 38 104', '56 34 110', '54 31 115', '52 30 118', '51 27 122', '49 26 125',
    '47 25 128', '46 23 131', '44 23 133', '42 22 136', '41 21 138', '40 20 140', '38 20 142',
    '37 19 56 88', '35 19 49 97', '34 19 43 104', '33 18 40 109', '32 18 37 113', '31 17 35 117',
    '30 17 33 120', '28 17 32 123', '27 17 30 126', '26 17 29 128', '25 16 29 130', '24 16 28 132',
    '23 16 27 134', '22 16 26 136', '22 15 25 138', '21 14 25 140', '20 14 24 142', '19 14 24 143',
    '18 14 23 145', '17 14 23 146', '17 14 22 147', '16 14 21 149', '15 14 21 150', '14 14 21 151',
    '14 13 21 152', '13 13 21 153', '12 13 20 155', '11 14 19 156', '11 13 19 157', '10 13 19 158',
    '10 12 19 159', '9 13 18 160', '8 13 19 160', '8 12 19 161', '7 13 18 162', '7 12 18 163',
    '6 12 18 164', '5 13 17 165', '5 12 17 166', '4 13 17 166', '4 12 17 167',
    '3 12 17 121 7 26 2 12', '3 12 17 117 15 21 4 11', '2 12 17 116 19 19 4 11',
    '2 12 16 115 9 6 8 17 4 11', '2 11 17 114 6 13 6 16 4 11', '1 12 16 113 6 17 5 15 4 6 3 2',
    '1 11 17 113 4 21 3 15 4 5 5 1', '0 12 16 115 2 23 2 15 4 5 5 1', '0 12 15 125 9 24 4 5 5 1',
    '0 11 16 123 13 22 4 5 5 1', '0 11 15 123 16 20 4 5 5 1', '0 10 16 121 6 7 6 19 4 5 5 1',
    '0 10 15 123 3 11 3 20 4 5 5 1', '0 9 16 124 1 13 1 21 4 5 5 1', '0 9 16 160 4 5 5 1',
    '0 9 15 131 3 27 4 5 5 1', '0 8 16 129 7 25 4 5 5 1', '0 8 15 130 7 25 4 5 5 1',
    '0 8 15 131 5 26 4 5 5 1', '0 7 15 133 3 27 4 5 5 1', '0 7 15 134 1 28 4 6 3 2', '0 7 15 178',
    '0 6 15 179', '0 6 15 179', '0 6 15 179', '0 5 15 180', '0 5 15 180', '0 5 15 180',
    '0 5 14 181', '0 4 15 181', '0 4 15 181', '0 4 15 181', '0 4 14 182', '0 4 14 182',
    '0 3 15 182', '0 3 15 182', '0 3 14 183', '0 3 14 183', '0 3 14 183', '0 2 15 183',
    '0 2 15 183', '0 2 14 184', '0 2 14 184', '0 2 14 184', '0 2 14 184', '0 2 14 184',
    '0 1 15 184', '0 1 15 184', '0 1 14 185', '0 1 14 185', '0 1 14 185', '0 1 14 185',
    '0 1 14 185', '0 1 14 185', '0 1 14 185', '0 1 14 185', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186',
  ],
  bl: [
    '61 41 98', '58 38 104', '56 34 110', '54 31 115', '52 29 119', '51 27 122', '49 26 125',
    '47 25 128', '46 23 131', '44 23 133', '42 22 136', '41 21 138', '39 21 140', '38 20 142',
    '37 19 54 90', '36 19 48 97', '34 19 43 104', '33 18 40 109', '32 18 37 113', '31 17 35 117',
    '30 17 33 120', '28 17 32 123', '27 17 30 126', '26 17 29 128', '25 16 29 130', '24 16 28 132',
    '23 16 26 135', '22 16 26 136', '22 15 25 138', '21 15 24 140', '20 14 24 142', '19 14 24 143',
    '18 14 23 145', '17 14 23 146', '17 13 23 147', '16 14 21 149', '15 14 21 150', '14 14 21 151',
    '14 13 21 152', '13 13 21 153', '12 13 20 155', '11 14 19 156', '11 13 19 157', '10 13 19 158',
    '9 13 19 159', '9 13 18 160', '8 13 19 160', '8 12 19 161', '7 13 18 162', '7 12 18 163',
    '6 12 18 164', '5 13 17 165', '5 12 17 166', '4 13 17 166', '4 12 17 167', '3 12 17 168',
    '3 12 17 168', '2 12 17 169', '2 12 16 170', '2 11 17 170', '1 12 16 171', '1 11 17 171',
    '0 12 16 172', '0 11 17 172', '0 11 16 173', '0 11 15 174', '0 10 16 174', '0 10 16 174',
    '0 9 16 175', '0 9 16 175', '0 9 15 176', '0 8 16 176', '0 8 15 177', '0 8 15 177',
    '0 7 15 178', '0 7 15 178', '0 7 15 178', '0 6 15 179', '0 6 15 179', '0 6 15 179',
    '0 5 15 180', '0 5 15 180', '0 5 15 180', '0 5 14 181', '0 4 15 181', '0 4 15 181',
    '0 4 15 181', '0 4 14 182', '0 4 14 182', '0 3 15 182', '0 3 15 182', '0 3 14 183',
    '0 3 14 183', '0 3 14 183', '0 2 15 183', '0 2 15 183', '0 2 14 184', '0 2 14 184',
    '0 2 14 184', '0 2 14 184', '0 2 14 184', '0 1 15 184', '0 1 15 184', '0 1 14 185',
    '0 1 14 185', '0 1 14 185', '0 1 14 185', '0 1 14 185', '0 1 14 77 108', '0 1 14 70 115',
    '0 1 14 66 119', '15 63 122', '14 61 125', '14 60 126', '14 58 128', '14 56 130', '14 55 131',
    '14 54 132', '14 52 134', '14 52 134', '14 51 135', '14 50 136', '14 49 137', '14 48 138',
    '14 47 139', '14 47 139', '14 46 140', '14 45 141', '14 45 141', '14 44 142', '14 43 143',
    '14 43 143', '14 43 143', '14 42 144', '14 42 144', '14 42 144', '14 41 145', '14 41 145',
    '14 41 145', '14 40 146', '14 40 146', '14 40 146', '14 40 146', '14 40 146', '14 40 146',
    '14 39 147', '14 39 147', '14 39 147', '14 39 147', '14 39 147', '14 39 147', '14 39 147',
    '14 39 147', '14 40 146', '14 40 146', '14 40 146', '14 40 146', '14 40 146', '14 40 146',
    '14 41 145', '14 41 145', '14 41 145', '14 42 144', '14 42 144', '14 42 144', '14 43 143',
    '14 43 143', '14 44 142', '14 44 142', '14 45 141', '14 46 140', '14 46 140', '14 47 139',
    '14 48 138', '14 48 138', '14 49 137', '14 50 136', '14 51 135', '14 52 134', '14 53 133',
    '14 54 132', '14 56 130', '14 57 129', '14 58 128', '14 60 126', '14 62 124', '14 65 121',
    '14 68 118', '14 74 112', '14 87 99', '14 186', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186',
  ],
  br: [
    '61 41 98', '58 37 105', '56 34 110', '54 31 115', '52 30 118', '51 27 122', '49 26 125',
    '47 25 128', '45 24 131', '44 23 133', '42 22 136', '41 21 138', '39 21 140', '38 20 142',
    '37 19 54 90', '36 19 48 97', '34 19 43 104', '33 18 40 109', '32 18 36 114', '31 17 35 117',
    '30 17 33 120', '28 17 32 123', '27 17 30 126', '26 17 29 128', '25 16 29 130', '24 16 28 132',
    '23 16 26 135', '22 16 26 136', '22 15 25 138', '21 14 25 140', '20 14 24 142', '19 14 24 143',
    '18 14 23 145', '17 14 23 146', '16 15 21 148', '16 14 21 149', '15 14 21 150', '14 14 21 151',
    '14 13 21 152', '13 13 20 154', '12 13 20 155', '11 14 19 156', '11 13 19 157', '10 13 19 158',
    '10 12 19 159', '9 13 18 160', '8 13 19 160', '8 12 19 161', '7 13 18 162', '7 12 18 163',
    '6 12 18 164', '5 13 17 165', '5 12 18 165', '4 13 17 166', '4 12 17 167', '3 12 17 168',
    '3 12 17 168', '3 11 17 169', '2 12 16 170', '2 11 17 170', '1 12 16 171', '1 11 17 171',
    '0 12 16 172', '0 11 17 172', '0 11 16 173', '0 11 15 174', '0 10 16 174', '0 10 16 174',
    '0 9 16 175', '0 9 16 175', '0 9 15 176', '0 8 16 176', '0 8 15 177', '0 8 15 177',
    '0 7 15 178', '0 7 15 178', '0 7 15 178', '0 6 15 179', '0 6 15 179', '0 6 15 179',
    '0 6 14 180', '0 5 15 180', '0 5 15 180', '0 5 14 181', '0 4 15 181', '0 4 15 181',
    '0 4 14 182', '0 4 14 182', '0 4 14 182', '0 3 15 182', '0 3 15 182', '0 3 14 183',
    '0 3 14 183', '0 3 14 183', '0 2 15 183', '0 2 15 183', '0 2 14 184', '0 2 14 184',
    '0 2 14 184', '0 2 14 184', '0 2 14 184', '0 1 15 184', '0 1 14 185', '0 1 14 185',
    '0 1 14 185', '0 1 14 185', '0 1 14 185', '0 1 14 185', '0 1 14 77 108', '0 1 14 70 115',
    '0 1 13 66 120', '0 1 13 63 123', '14 61 125', '14 59 127', '14 58 128', '14 56 130',
    '14 55 131', '14 54 132', '14 53 133', '14 51 135', '14 51 135', '14 50 136', '14 49 137',
    '14 48 138', '14 47 139', '14 46 140', '14 46 140', '14 45 141', '14 45 141', '14 44 142',
    '14 43 143', '14 43 143', '14 43 143', '14 42 144', '14 42 144', '14 41 145', '14 41 145',
    '14 41 145', '14 40 146', '14 40 146', '14 40 146', '14 40 146', '14 40 146', '14 40 146',
    '14 39 147', '14 39 147', '14 39 147', '14 39 147', '14 39 147', '14 39 147', '14 39 147',
    '14 39 147', '14 39 147', '14 40 146', '14 40 146', '14 40 146', '14 40 146', '14 40 146',
    '14 40 146', '14 41 145', '14 41 145', '14 41 145', '14 42 144', '14 42 144', '14 42 144',
    '14 43 143', '14 43 143', '14 44 142', '14 44 142', '14 45 141', '14 46 140', '14 46 140',
    '14 47 139', '14 48 138', '14 48 138', '14 49 137', '14 50 136', '14 51 135', '14 52 134',
    '14 53 133', '14 54 132', '14 56 130', '14 57 129', '14 58 128', '14 60 126', '14 62 124',
    '14 65 121', '14 68 118', '14 74 112', '14 87 99', '14 186', '14 186', '14 186', '14 186',
    '14 186', '14 186', '14 186', '14 186', '14 186', '14 186',
  ],
}
// A recording of that glass: black round it as a recording is, the app lit, and each
// corner the real one.
function realFrame(corners = REAL_CORNERS) {
  const w = 794, h = 1718, g = { x: 44, y: 154, w: 706, h: 1534 }, M = 14
  const data = new Uint8Array(w * h * 4)
  for (let p = 3; p < data.length; p += 4) data[p] = 255
  const put = (x, y, v) => { const p = (y * w + x) * 4; data[p] = data[p + 1] = data[p + 2] = v }
  for (let y = g.y; y < g.y + g.h; y++) for (let x = g.x; x < g.x + g.w; x++) put(x, y, 200)
  for (const [k, top, left] of [['tl', 1, 1], ['tr', 1, 0], ['bl', 0, 1], ['br', 0, 0]]) {
    corners[k].forEach((line, i) => {
      const v = i - M, y = top ? g.y + v : g.y + g.h - 1 - v
      let u = -M, lit = false
      for (const n of line.split(' ').map(Number)) {
        for (let j = 0; j < n; j++, u++) put(left ? g.x + u : g.x + g.w - 1 - u, y, lit ? 200 : 0)
        lit = !lit
      }
    })
  }
  return { width: w, height: h, data }
}
{
  const PRO_MAX = { w: 1320, h: 2868, scale: 3 }
  const vp = { x: 0.0554, y: 0.0896, w: 0.8892, h: 0.8929 }
  const got = S.measureCorner(realFrame(), vp, { screen: PRO_MAX })
  ok('a real frame of an old take reads its corner', got.ok)
  is('each corner is the glass, not the bezel: 110 to 112 pixels, where the old reading said 37.7',
    got.value.corners, [112.46, 111.39, 112.46, 110.32])
  is('and the circle hides the ring in all four of them', got.value.px, 112.47)
  is('which is 0.1594 of the short side, where the old reading said 0.0535', got.value.share, 0.1594)
  near('within 1 percent of the 0.1578 the capture wrote for the same take', got.value.share, 0.1578, 0.1578 * 0.011)
  // The device's own corner, as a check. 62 points is the iPhone 16 Pro Max's; the circle
  // that hides a continuous corner is wider than the curve's own radius.
  is('a ProMax\'s screen corner is 62 points', S.screenCorner(PRO_MAX), 62)
  const pts = got.value.share * 440
  ok(`the reading is ${pts.toFixed(1)} points, inside the band round 62`, pts / 62 > 0.85 && pts / 62 < 1.4)
  ok('where the old reading, 23.5 points, is nowhere near it', 0.0535 * 440 / 62 < 0.85)
  is('an iPhone 17 Pro\'s is 62 as well', S.screenCorner({ w: 1206, h: 2622, scale: 3 }), 62)
  is('an SE\'s is square', S.screenCorner({ w: 750, h: 1334, scale: 2 }), 0)
  is('and a screen this does not know has none, rather than a guess', S.screenCorner({ w: 2064, h: 2752, scale: 2 }), null)
  is('the same device on its side is the same screen', S.screenCorner({ w: 2868, h: 1320, scale: 3 }), 62)

  // Refused, not returned: a reading that has not passed its own check is never an answer,
  // so nothing that writes the answer onto a document can write a guess.
  const wrongDevice = S.measureCorner(realFrame(), vp, { screen: { w: 1125, h: 2436, scale: 3 } })
  is('held to a screen whose corner it is not (an iPhone 11 Pro, 39 points), it refuses', wrongDevice.ok, false)
  ok('and says how far out it is', /39 points/.test(wrongDevice.reason))
  is('held to a square screen, it refuses', S.measureCorner(realFrame(), vp, { screen: { w: 750, h: 1334, scale: 2 } }).ok, false)
  is('handed no screen, it still reads, on its own check', S.measureCorner(realFrame(), vp).value.share, 0.1594)

  // The squarest corner must have another agreeing with it: three corners pushed round by
  // an app, agreeing with each other, are the app.
  const pushed = k => REAL_CORNERS[k].map((line, i) => (i >= 14 && i < 14 + 30 ? '74 126' : line))
  const three = S.measureCorner(realFrame({ tl: REAL_CORNERS.tl, tr: pushed('tr'), bl: pushed('bl'), br: pushed('br') }), vp)
  is('one true corner and three an app made rounder alike is refused', three.ok, false)
  ok('and says the squarest had no other agreeing with it', /squarest corner/.test(three.reason))
  const two = S.measureCorner(realFrame({ tl: REAL_CORNERS.tl, tr: REAL_CORNERS.tr, bl: pushed('bl'), br: pushed('br') }), vp)
  is('two true corners are enough, and the pushed two are left out', two.ok && two.value.corners, [112.46, 111.39, 149, 149])

  // Nothing outside the glass may show inside the circle. A crack of ring running down
  // into the glass from the corner's tail, joined to the ring and so outside the glass,
  // is past the row where the corner closes, and the circle leaves it showing.
  const cracked = realFrame()
  for (let y = 154 + 69; y <= 154 + 100; y++) { const p = (y * 794 + 44 + 5) * 4; cracked.data[p] = cracked.data[p + 1] = cracked.data[p + 2] = 0 }
  const crack = S.measureCorner(cracked, vp)
  ok('ring showing inside the circle is refused', !crack.ok && /still shows/.test(crack.reason))
  // And a corner rounder than a quarter of the short side is not a corner: a dark bar
  // across the top of the glass in all four corners alike.
  const barred = k => REAL_CORNERS[k].map((line, i) => (i >= 14 + 30 && i < 14 + 34 ? '164 36' : line))
  const bar = S.measureCorner(realFrame({ tl: barred('tl'), tr: barred('tr'), bl: barred('bl'), br: barred('br') }), vp)
  ok('a corner past a quarter of the short side is refused', !bar.ok && /quarter/.test(bar.reason))

  // A stored corner is recognised as suspect.
  is('0.0535 stored on a ProMax is suspect without reading a frame', /23\.5 points/.test(S.cornerSuspect({ ...vp, corner: 0.0535 }, PRO_MAX)), true)
  is('the 0.1578 the capture wrote is not', S.cornerSuspect({ ...vp, corner: 0.1578 }, PRO_MAX), null)
  is('nor is the 0.1594 this reads', S.cornerSuspect({ ...vp, corner: 0.1594 }, PRO_MAX), null)
  is('a document with no corner has nothing to suspect', S.cornerSuspect(vp, PRO_MAX), null)
  ok('a stored corner that is no share of anything is suspect', S.cornerSuspect({ ...vp, corner: 0.7 }, PRO_MAX))
  ok('a round corner stored on a square screen is suspect', S.cornerSuspect({ ...vp, corner: 0.1 }, { w: 750, h: 1334, scale: 2 }))
  is('on a screen this does not know, the number alone says nothing', S.cornerSuspect({ ...vp, corner: 0.0535 }, { w: 2064, h: 2752, scale: 2 }), null)
  // There the frame says it: the reading carries whether the stored corner is the one
  // the frame shows.
  is('read against a frame, a stored 0.0535 is not the corner the frame shows',
    S.measureCorner(realFrame(), { ...vp, corner: 0.0535 }).value.stored, { share: 0.0535, agrees: false })
  is('and a stored 0.1578 is', S.measureCorner(realFrame(), { ...vp, corner: 0.1578 }).value.stored, { share: 0.1578, agrees: true })

  // A new capture: a corner that fails its check is left off the measurement, and the
  // rectangle, which is fine, is kept.
  const d = DEVICE.proMax
  const cap = frameOf(d, { corner: PROFILE })
  // an app dark into three corners alike, touching the ring: 60 by 30 of black in each
  for (const [top, left] of [[1, 0], [0, 1], [0, 0]]) {
    for (let v = 0; v < 30; v++) for (let u = 0; u < 60; u++) {
      const x = left ? d.glass.x + u : d.glass.x + d.glass.w - 1 - u
      const y = top ? d.glass.y + v : d.glass.y + d.glass.h - 1 - v
      const p = (y * d.cap.w + x) * 4
      cap.data[p] = cap.data[p + 1] = cap.data[p + 2] = 0
    }
  }
  const sq = S.measureGlass(cap)
  ok('a capture whose corners do not agree keeps its rectangle', sq.ok && sq.value.px.w === d.glass.w)
  is('and has no corner', sq.value.corner, undefined)
  ok('and says why', /squarest corner/.test(sq.value.cornerRefused))
  is('so the viewport written onto the document carries no corner', 'corner' in S.viewport(d.win, d.screen, { glass: sq }), false)
}

console.log('where the glass is inside the window, worked out rather than seen')
{
  // Kept because a caller that genuinely knows its chrome can still ask, and because the
  // shape check below is the half of the error that is visible without pixels. Nothing
  // aims with any of it: see simulators().
  const v = S.viewport({ w: 396, h: 856 }, SCREEN)
  is('the screen fills the window it was fitted to', [v.y, v.h], [0, 1])
  is('and is centred in what is left across', [v.x, v.w], [0.0026, 0.9949])
  near('which is 2 points of window, not zero', v.x * 396 * 2, 396 - 856 * (440 / 956), 0.1)
  is('a window at pixel accurate is the screen exactly', S.viewport({ w: 660, h: 1434 }, SCREEN), { x: 0, y: 0, w: 1, h: 1 })
  is('a window nothing like the screen\'s shape is refused, not letterboxed', S.viewport({ w: 600, h: 856 }, SCREEN), null)
}
{
  // an Xcode that puts a title bar inside the frame, or a drawn device bezel: the fit
  // happens in what is left over
  const v = S.viewport({ w: 400, h: 880 }, SCREEN, { chrome: { top: 28 } })
  is('the top inset is off the top', v.y, 0.0318)
  near('and the screen is the rest of the height', v.h * 880, 852, 0.5)
  is('chrome wider than the window has no screen in it', S.viewport({ w: 120, h: 260 }, SCREEN, { chrome: { left: 70, right: 70 } }), null)
  is('a window of no size is null, not an infinity', S.viewport({ w: 0, h: 856 }, SCREEN), null)
  is('a screen nobody read is null too', S.viewport({ w: 396, h: 856 }, null), null)
  is('a screen with no scale is read as points', S.viewport({ w: 440, h: 956 }, { w: 440, h: 956 }), { x: 0, y: 0, w: 1, h: 1 })
}

console.log('density, which decides whether a store shot is an upscale')
{
  is('measured, the glass over the device\'s own pixels and no display scale at all',
    S.density(DEVICE.proMax.win, DEVICE.proMax.screen, { glass: { px: { w: 706, h: 1534 } } }), 0.53)
  is('the fitted window is well under its own pixels', S.density({ w: 396, h: 856 }, SCREEN, { backingScale: 2 }), 0.6)
  is('pixel accurate is exactly 1', S.density({ w: 660, h: 1434 }, SCREEN, { backingScale: 2 }), 1)
  is('a 1x display halves it', S.density({ w: 660, h: 1434 }, SCREEN, { backingScale: 1 }), 0.5)
  is('and a window larger than the device is over 1', S.density({ w: 880, h: 1912 }, SCREEN, { backingScale: 2 }), 1.33)
  ok('the note names the number and the fix', /0\.60 of the device's own pixels/.test(S.densityNote({ density: 0.6 })))
  ok('and says where to set it', /Pixel Accurate/.test(S.densityNote({ density: 0.6 })))
  is('nothing to say when the window is honest', S.densityNote({ density: 1 }), null)
}

console.log('the whole model')
const WINDOWS = [
  { id: 41, app: 'Simulator', title: 'Round-Shots-16PM', width: 396, height: 856 },
  { id: 7, app: 'Safari', title: 'Round-Shots-16PM', width: 1200, height: 800 },
]
// What the caller hands back: a capture of that window, measured. Nothing here spawns
// or captures, which is the whole reason it is injected.
const MEASURED = S.measureGlass(frameOf(DEVICE.proMax))
const model = (o = {}) => S.simulators({
  devices: DEVICES, runtimes: RUNTIMES, windows: WINDOWS,
  glassOf: w => (String(w.id) === '41' ? MEASURED : null),
  profiles: { 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max': S.parseProfile(PROFILE_16PM) },
  ...o,
})
{
  const sims = model()
  const one = sims[0]
  is('the device with a window on screen sorts first', one.name, 'Round-Shots-16PM')
  is('it knows it is a phone', one.family, 'iPhone')
  is('it knows which phone', one.deviceType, 'iPhone 16 Pro Max')
  is('and which iOS', one.runtime, 'iOS 26.5')
  is('the window title is the device name, which is the whole join', one.window.id, 41)
  is('the window carries its size in points', [one.window.w, one.window.h], [396, 856])
  is('the screen rectangle came out with it, off the pixels', one.viewport, { x: 0.0554, y: 0.0896, w: 0.8892, h: 0.8929 })
  is('so did the density', one.density, 0.53)
  is('a window belonging to another app is never a device window', sims.filter(s => s.window && s.window.id === 7).length, 0)
  const shut = sims.find(s => s.name === 'FairSplit-Loop')
  is('a shut device of the same model has no window', shut.window, null)
  is('and therefore no viewport to crop to', shut.viewport, null)
  is('booted is a boolean beside the display string', [shut.state, shut.booted], ['Shutdown', false])
  const watch = sims.find(s => s.family === 'Apple Watch')
  is('a watch is a watch, not a phone', watch.deviceType, 'Apple Watch Series 11 (46mm)')
  is('a device type with no profile read has no screen', watch.screen, null)
}
{
  // Nothing measured. The arithmetic would have answered 0.60 and a rectangle that is
  // the whole window, which aims a tap at the top of the screen about 80 points above
  // what it was asked for and leaves the Mac's own toolbar inside the crop. So there is
  // no rectangle, and the record says what would measure one.
  const one = model({ glassOf: null })[0]
  is('no capture, no rectangle', one.viewport, null)
  is('and no density either', one.density, null)
  ok('the record says what a rectangle would take', /capture of the window is what measures it/.test(one.note || ''))
  const wrong = model({ glassOf: () => S.measureGlass(frameOf(DEVICE.proMax, { app: 'left' })) })[0]
  is('a measurement of the wrong shape is thrown away rather than used', wrong.viewport, null)
  ok('and says so', /not the shape of its screen/.test(wrong.note || ''))
}
{
  // the person renamed nothing and Simulator shows the runtime after the name
  const sims = S.simulators({
    devices: DEVICES, runtimes: RUNTIMES, backingScale: 2,
    windows: [{ id: 9, app: 'Simulator', title: 'FairSplit-Loop ' + String.fromCharCode(0x2014) + ' iPhone 16 Pro Max', width: 396, height: 856 }],
    profiles: { 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max': S.parseProfile(PROFILE_16PM) },
  })
  is('the name in front of the separator wins the window', sims[0].name, 'FairSplit-Loop')
  is('and the model name after it does not steal it', sims.filter(s => s.window).length, 1)
}
{
  const dup = JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
    { udid: 'AAAA', isAvailable: true, state: 'Booted', name: 'Demo', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max' },
    { udid: 'BBBB', isAvailable: true, state: 'Booted', name: 'Demo', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max' },
  ] } })
  const sims = S.simulators({ devices: dup, runtimes: RUNTIMES, windows: [{ id: 3, app: 'Simulator', title: 'Demo', width: 396, height: 856 }] })
  is('two devices of one name: the window goes to neither', sims.filter(s => s.window).length, 0)
  ok('and both say why', sims.every(s => /rename one/.test(s.note || '')))
}
{
  const parsed = S.simulators({ devices: S.parseDevices(DEVICES), runtimes: S.parseRuntimes(RUNTIMES) })
  is('reads already parsed are taken as they are', parsed.length, 3)
  is('and a model with no window list still knows the devices', parsed.every(s => s.window === null), true)
}

console.log('naming one of them')
{
  const sims = model()
  is('by UDID', S.resolve(sims, 'a1edec56-560D-4E95-A19C-87F2FC438103').value.name, 'Round-Shots-16PM')
  is('by the name the person gave it', S.resolve(sims, 'FairSplit-Loop').value.udid, '2321BA9C-16CE-4E5A-B466-1CFBA0E25142')
  is('by a piece of it', S.resolve(sims, 'fairsplit').value.name, 'FairSplit-Loop')
  const booted = S.resolve(sims, 'booted')
  is('the literal booted is refused', booted.ok, false)
  ok('because it picks an unspecified device when two are up', /unspecified/.test(booted.reason))
  ok('a name nobody has says so', /no simulator here/.test(S.resolve(sims, 'Pixel').reason))
  ok('and nothing at all asks for something', /UDID/.test(S.resolve(sims, '').reason))
  const many = S.resolve(sims, 'o')
  is('an ambiguous piece of a name resolves to nobody', many.ok, false)
  ok('and lists what it could have meant', /Round-Shots-16PM/.test(many.reason))
}

console.log('a point on the glass')
{
  const one = model()[0]
  const mid = S.pointToFrame(one, 220, 478)
  near('the middle of the screen is the middle of the frame, across', mid.x, 0.5)
  near('and low of the middle down it, because the toolbar is above the glass', mid.y, 0.536)
  const tl = S.pointToFrame(one, 0, 0)
  is('the top left of the glass is well inside the frame, not at its corner', [tl.x, tl.y], [0.0554, 0.0896])
  near('and the bottom right lands on the glass, not on the window', S.pointToFrame(one, 440, 956).x, 0.9446)
  is('no viewport, no point', S.pointToFrame({ screen: SCREEN }, 10, 10), null)
  is('a point that is not a number is null, not a NaN', S.pointToFrame(one, 'x', 10), null)
}

console.log('a device on its side')
{
  // simctl reports no orientation of any kind, and the window's own shape is the only
  // evidence there is. Without reading it, viewport() fitted the portrait screen into a
  // landscape window and returned a strip a fifth of the window wide: the deliverable
  // was cropped to that strip, every tap but the exact centre landed somewhere nobody
  // pointed, and a store export was refused for a density that was not real.
  const land = { w: 856, h: 396 }
  is('the window says which way up it is', S.orientOf(land, SCREEN), 'landscape')
  is('and a portrait window still reads portrait', S.orientOf({ w: 396, h: 856 }, SCREEN), 'portrait')
  const v = S.viewport(land, SCREEN)
  ok('the glass is the window, not a strip down the middle of it', v.w === 1 && v.h > 0.99)
  is('the same device turned keeps the same density',
    S.density(land, SCREEN, { backingScale: 2 }), S.density({ w: 396, h: 856 }, SCREEN, { backingScale: 2 }))
  is('the points a tap is aimed in swap with it', S.glassPoints(SCREEN, 'landscape'), { w: 956, h: 440 })
  const sim = { screen: SCREEN, viewport: v, orientation: 'landscape', glass: S.glassPoints(SCREEN, 'landscape') }
  near('and a tap at 900 points across lands across the frame', S.pointToFrame(sim, 900, 220).x, 0.941)
}

console.log('the density is the display the window is on')
{
  // Not the Mac's main display. With the Simulator window on a 1x external screen
  // beside a Retina main one, the primary reads 2 where the window is really 1, so a
  // store export that should be refused ships an upscale, and the other way round a
  // good shot is refused. Nobody guesses here.
  const win = { w: 396, h: 856 }
  is('no scale factor, no density', S.density(win, SCREEN, {}), null)
  is('a 1x display halves it', S.density(win, SCREEN, { backingScale: 1 }),
    S.density(win, SCREEN, { backingScale: 2 }) / 2)
}


console.log('a measured glass is held to its own rounding, not a fixed number')
{
  // The ProMax's own glass, 706 x 1534 in a 794 x 1718 capture, box-resized to the window
  // sizes a person actually has: 0.95 of the default, and the default on a 1x display.
  // Each edge is found to the pixel, so the aspect is out by up to a pixel a side, and a
  // fixed 0.15 percent turned a third of those correct rectangles down.
  const glassAt = (w) => {
    const k = w / 794
    const px = { x: Math.round(44 * k), y: Math.round(154 * k), w: Math.round(706 * k) + 1, h: Math.round(1534 * k) }
    const cap = { w, h: Math.round(1718 * k) }
    return { px, capture: cap, rect: { x: px.x / cap.w, y: px.y / cap.h, w: px.w / cap.w, h: px.h / cap.h } }
  }
  let refused = 0
  for (let w = 318; w <= 786; w += 8) if (!S.glassViewport(glassAt(w), SCREEN)) refused++
  is('a pixel of rounding is never refused, at any window size from 318 to 786', refused, 0)
  ok('754 px, 0.95 of the default window, is taken', S.glassViewport(glassAt(754), SCREEN))
  ok('405 px, the default window on a 1x display, is taken', S.glassViewport(glassAt(405), SCREEN))
  // A dark strip down one edge moves that edge in by six pixels, which is a rectangle
  // of the wrong shape, and still refused.
  const dark = { px: { x: 50, y: 154, w: 700, h: 1534 }, capture: { w: 794, h: 1718 },
    rect: { x: 50 / 794, y: 154 / 1718, w: 700 / 794, h: 1534 / 1718 } }
  is('six pixels of dark app at the edge is still refused', S.glassViewport(dark, SCREEN), null)
  is('and has no density either, rather than one off the wrong rectangle',
    S.density({ w: 397, h: 859 }, SCREEN, { glass: dark }), null)
  const splash = { px: { x: 300, y: 700, w: 200, h: 300 }, capture: { w: 794, h: 1718 },
    rect: { x: 300 / 794, y: 700 / 1718, w: 200 / 794, h: 300 / 1718 } }
  is('a dark splash measured as a small box has no density', S.density({ w: 397, h: 859 }, SCREEN, { glass: splash }), null)
  const sims = S.simulators({ devices: DEVICES, runtimes: {}, profiles: { 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max': SCREEN },
    windows: [{ id: 7, app: 'Simulator', title: 'Round-Shots-16PM', width: 397, height: 859 }], glassOf: () => splash })
  const hit = sims.find(x => x.name === 'Round-Shots-16PM')
  is('a device whose measurement was turned down reports no viewport', hit.viewport, null)
  is('and no density to put on the document', hit.density, null)
}

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
