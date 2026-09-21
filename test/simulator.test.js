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

console.log('where the glass is inside the window')
{
  // the measured case: no macOS title bar and no drawn bezel inside the frame, so the
  // screen is nearly the whole window and the residual is real
  const v = S.viewport({ w: 396, h: 856 }, SCREEN)
  is('the screen fills the window it was fitted to', [v.y, v.h], [0, 1])
  is('and is centred in what is left across', [v.x, v.w], [0.0026, 0.9949])
  near('which is 2 points of window, not zero', v.x * 396 * 2, 396 - 856 * (440 / 956), 0.1)
  is('a window at pixel accurate is the screen exactly', S.viewport({ w: 660, h: 1434 }, SCREEN), { x: 0, y: 0, w: 1, h: 1 })
  is('a window wider than the device letterboxes across, never down', S.viewport({ w: 600, h: 856 }, SCREEN),
    { x: 0.1717, y: 0, w: 0.6566, h: 1 })
}
{
  // an Xcode that puts a title bar inside the frame, or a drawn device bezel: the fit
  // happens in what is left over
  const v = S.viewport({ w: 400, h: 880 }, SCREEN, { chrome: { top: 28 } })
  is('the top inset is off the top', v.y, 0.0318)
  near('and the screen is the rest of the height', v.h * 880, 852, 0.5)
  is('chrome wider than the window has no screen in it', S.viewport({ w: 100, h: 200 }, SCREEN, { chrome: { left: 60, right: 60 } }), null)
  is('a window of no size is null, not an infinity', S.viewport({ w: 0, h: 856 }, SCREEN), null)
  is('a screen nobody read is null too', S.viewport({ w: 396, h: 856 }, null), null)
  is('a screen with no scale is read as points', S.viewport({ w: 440, h: 956 }, { w: 440, h: 956 }), { x: 0, y: 0, w: 1, h: 1 })
}

console.log('density, which decides whether a store shot is an upscale')
{
  is('the measured window is well under its own pixels', S.density({ w: 396, h: 856 }, SCREEN, { backingScale: 2 }), 0.6)
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
const model = () => S.simulators({
  devices: DEVICES, runtimes: RUNTIMES, windows: WINDOWS, backingScale: 2,
  profiles: { 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max': S.parseProfile(PROFILE_16PM) },
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
  is('the screen rectangle came out with it', one.viewport, { x: 0.0026, y: 0, w: 0.9949, h: 1 })
  is('so did the density', one.density, 0.6)
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
  near('and down', mid.y, 0.5)
  const tl = S.pointToFrame(one, 0, 0)
  is('the top left of the glass is inside the frame, not at its corner', [tl.x, tl.y], [0.0026, 0])
  near('and the bottom right lands on the far edge', S.pointToFrame(one, 440, 956).x, 0.9975)
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

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
