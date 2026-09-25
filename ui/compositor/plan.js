// The compositor's plan: everything a frame of an edit needs, as plain numbers.
//
// prepare() reads an edit (the options bag toExportOpts makes, the same one the classic
// export takes) once per render and fixes the output's size, the framed take's place,
// the background, the zooms on the output clock, the camera bubble and the fades.
// framePlan() then answers for one output time: which moment of the take, what the
// zoom shows (and where it was half a shutter either side, for motion blur), how far a
// fade has gone, which camera moment. The editor's canvas and the export both draw from
// these two functions, so the stage and the file cannot disagree about a frame.
//
// No frame depends on the one before it: any frame can be drawn alone, in any order.
//
// Pure: no Electron, no filesystem, no DOM (test/plan.test.js).

const Timeline = require('../timeline')
const Layout = require('./layout')
const Overlays = require('../overlays')
const Marks = require('./marks')
const Text = require('./text')
const { GRADIENTS, MESHES } = require('../look-schema')
const { tok } = require('./tokens')

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const num = (v, d) => (v != null && Number.isFinite(+v) ? +v : d)

// The shoulder on the contrast line, and the same curve mirrored for its toe.
//
// w is what the top of the range becomes under the straight line
// (c - 0.5) * contrast + 0.5 + brightness, wp what the take's own white point becomes
// under it, and gain the line's own slope. At 1 or under nothing goes over the edge and
// the line is left exactly as it was. Over 1, the line runs straight up to a knee and a
// cubic takes it from there onto 1.0 at w, so nothing the line carries past the range's
// end is cut off. Returns [knee, run, and the curve's two terms] for gl.js's rollIn().
//
// Two numbers place the knee, and the take's own white is the first of them: the run
// starts there where there is room above it, so the overshoot is spent entirely on what
// the take has nothing in and the picture keeps the line whole. A white app page leaves
// no room at all (this take's white measures 253 of 255), and there the run reaches down
// into the picture instead, far enough that the curve still arrives carrying 1 / gain of
// the line's slope. That is the slope the picture had before the grade touched it, so a
// hairline at the top of the take is never flatter than it was ungraded, whatever the
// dial says. Never past the bottom of the range: a gain that would put the knee under 0
// makes the whole line curve, and the arrival goes with it.
//
// It arrives carrying that slope rather than flat, and that is the fix. Arriving flat
// put the one place the curve has no slope left exactly on the take's white, which on a
// white app page is the page: every row separator and card hairline a level under it was
// compressed into it, 2.5 times on Noir. Above the take's white the curve still runs, so
// a cursor or a white toast in the top 0.4 percent levels.js leaves out is rolled in
// rather than clipped.
function rollOff(w, wp, gain) {
  if (!(w > 1.0001)) return [0, 0, 0, 0]
  const d = w - 1
  const a = Math.min(w, Math.max(w - wp, gain > 1.0001 ? d * gain / (gain - 1) : w))
  const k = w - a, r = (1 - k) / a - 1
  // f(0) = 0, f'(0) = 1 so it meets the straight line; f(1) = 1 + r so w lands on 1.0;
  // f'(1) = 1 + r, the shoulder's own average slope, so it arrives on the end carrying
  // slope. Monotone for every dial: the curve's least slope is 1 + 4r/3, and r, which is
  // 1/gain - 1 where the slope sets the run and (1 - w)/w where the range does, does not
  // reach -3/4 anywhere the dials go (contrast 1 with brightness 1 leaves it at -0.6).
  return [k, a, 2 * r, -r]
}

// ── the take's edge ─────────────────────────────────────────────────────
// The edge is a contract, not whatever the ground a look chose happens to leave. The
// take's outermost pixels stand off the ground just outside them by at least EDGE_FLOOR
// levels of luma, everywhere round the perimeter, and the frame pass meets that with
// whatever is available: a hairline where the ground is the take's own tone, a shadow
// where there is room to cast one, and a blur ground that holds near the take's own
// mean. Four of the seven presets failed it for four different reasons before this
// (.context/survey/fix-edge.md).
const EDGE_FLOOR = 24 / 255
// And the other end of it, for the one ground that is the take itself. A gutter filled
// by the take's own blur is bleed, so it never stands further off the take than this.
// Pressed to 30 percent luma under a 236 page it measured 183 levels, which is a black
// bar by any other name, and PRODUCT says the output never draws one.
const EDGE_BLEED = 64 / 255
// How far the top of the vignette dial reaches, in cos^4 fall-offs (see the treatment's
// own note below). At 1 the frame's furthest corner keeps a third of its light and the
// take's own corners about seven tenths, which is a lens and not a tunnel.
const VIG_REACH = 2.4
// The two numbers the ground's tooth and the film's grain are held together by, both in
// levels of the finished frame. TOOTH_SIGMA is what the frame pass's own tooth measures
// (three levels either side, uniform, so 6 * 255 / 219 wide); GRAIN_ENDS is how much of
// the film's midtone weighting survives at the ends of the range (gl.js, the final
// pass). Kept here because the tooth is scaled against the grain and the two have to be
// read off the same arithmetic.
const TOOTH_SIGMA = 6 / 219 / Math.sqrt(12)
const GRAIN_ENDS = 0.6

// A ground that is a material and not a colour. Paper was a flat #EDE6DA under a trace
// of film grain, and grain is new every frame, so it read as a noisy video of a colour
// rather than as a sheet, and the encoder threw most of it away. A texture here is the
// sheet's own fibre and its soft mottling, drawn once into the cached background
// (gl.js, FS_BG) and never again: static, so it costs the encoder one keyframe and then
// nothing, and the ground holds still behind a take the way paper does.
//   paper  warm fibre, some dark and a few bright, over mottling a few hundred pixels
//          across: an uncoated sheet
//   print  the same, finer and quieter: a smooth print stock under Mono print
// Which one comes from background.texture, a field of the look like any other, so the
// sheet travels with the look rather than with the name of the preset it came from:
// saving Paper under a new name used to leave a flat colour with nothing on it, because
// the new slug was in no table. Only on a solid ground: a gradient, a mesh and a photo
// are compositions of their own.
const TEXTURES = ['paper', 'print']
function groundTexture(look = {}) {
  const B = look.background || {}
  if (B.kind && B.kind !== 'solid') return null
  return TEXTURES.includes(B.texture) ? B.texture : null
}
// Warm ink over a light ground, a warm light over a dark one. The pair used to be
// BRAND's --ink-1 and --text-0 copied in by hand, which is a copy that can drift from
// what it was copied from; it is an import now, and the fallback is the literal it
// replaces so a theme missing a name still draws what it always drew.
// Never #000 or #fff: every neutral here is warmed toward the fur hue.
const EDGE_INK = tok('dark', 'ink', '#1A1714'), EDGE_LIT = tok('dark', 'lit', '#FBFAF8')
const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

/**
 * Which warm end the hairline goes to: { col }. Which way that is falls out of the tone
 * itself in the frame pass, which reads the take's own edge against it.
 *
 * Decided once from the ground a look chose, not per pixel, and that is the point. A
 * ground can cross mid grey along one edge (every gradient does), and a line that
 * changed ends where it crossed would put a seam down one side of the frame and would
 * land the two decode paths on opposite sides of it. One end for the whole frame is
 * continuous in whatever is under it, so the line fades to nothing rather than
 * switching off.
 *
 * A blurred copy of the take is the take's own dark side by construction (the band in
 * blurFill only ever holds it under the take's own mean), so the take is the light one
 * of the pair and the line goes with it: an ink line there would close the very gap it
 * is drawn to open. A photo can be anything, so the compositor reads the decoded
 * picture's own mean and picks with edgeFor(); until it has, the ink end stands.
 *
 * One end, and it does not travel. The take's own edge is under a lift for part of a
 * perimeter and not for the rest, so it can land on the very tone the plan chose, and
 * letting the line drift to the other end there was tried and taken out: the two ends
 * are the range apart, so the drift carried the line's tone across the take's own luma,
 * and one level of the take either side of that crossing took the finished pixel from a
 * floor above the take to a floor below it. A hairline that swings thirty levels on a
 * level of the picture pops while a lift fades a page and lands the two decode paths on
 * opposite sides of the crossing, which is the rim the whole contract exists to stop.
 * Where this end cannot carry the floor against the take, the frame pass delivers what
 * the tone has and no more.
 */
const edgeFor = light => ({ light, col: rgb(light ? EDGE_INK : EDGE_LIT) })
function edgeEnd(bg) {
  const light = bg.kind === 'gradient' ? (lum(bg.c0) + lum(bg.c1)) / 2 > 0.5
    : bg.kind === 'mesh' ? bg.c.reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i % 3], 0) / (bg.c.length / 3) > 0.5
    : bg.kind === 'blur' ? false
    : true
  return edgeFor(light)
}

// '#F0A93C' or '0xF0A93C' to [r, g, b] in 0..1
function rgb(hex) {
  const m = /^(?:#|0x)?([0-9a-f]{6})$/i.exec(String(hex || ''))
  if (!m) return [0.1, 0.09, 0.08]
  return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255)
}

// ── the drawn device ────────────────────────────────────────────────────
//
// A frame round the take: a browser, a plain window, a laptop or a phone, drawn from
// rectangles, radii and two tones. Everything here is generic by construction and by
// intent. No outline is traced from a product, nothing carries a wordmark, a window's
// buttons are three dots in the shell's own tone rather than three coloured ones (a
// browser's are coloured, because the person asked for a browser that reads as one at
// a glance, and red, amber and green close, shrink and grow on every desktop), a
// laptop is a slab and a shallow foot with no keyboard, wedge or hinge detail, and a
// phone has a speaker slit and nothing else: no notch, no island, no home bar. If a
// shape would make anyone think of one company's product it is the wrong shape.
//
// The device takes the place the layout gave the take and hands back what is left, so
// the frame's margins, its shadow and the whole composition stay where they were and
// only the take gets smaller. Sizes are shares of the screen's own width, so a device
// is the same device at 720p and at 4K.
// bar: the top bezel, side and foot the others, r and sr the shell's and the screen's
// corners, base and over a laptop's foot: its height and how far it stands out either
// side. All of them shares of the screen's own width.
const DEVICES = {
  browser: { bar: 0.070, side: 0.008, foot: 0.008, r: 0.018, sr: 0.005 },
  window: { bar: 0.046, side: 0.008, foot: 0.008, r: 0.018, sr: 0.005 },
  laptop: { bar: 0.020, side: 0.020, foot: 0.052, r: 0.022, sr: 0.006, base: 0.030, over: 0.055 },
  // A phone's bezels, even. They were bar 0.050 and foot 0.050 against side 0.030, a
  // brow and a chin nearly twice the sides, which is the face of a phone from well
  // over a decade ago and read as one: the shell looked like a slab with the glass
  // sunk in it. Every phone made since has edges within a hair of each other, with a
  // little more under the screen than over it, which is what these are.
  //
  // sr stays where it was on purpose, and it is not the drawn corner: it is the radius
  // the glass is masked at when nobody measured the real one, and guessing a large
  // corner there would cut the app's own pixels off a take Fetch knows nothing about.
  // Where a corner has been measured, gr takes over a few lines down and the shell is
  // cut concentric with it, which is how the drawn phone gets a modern corner honestly.
  //
  // None of this is traced from anybody's product and none of it is trade dress: a
  // rounded rectangle with thin even edges is what the whole industry makes. The rule
  // this file keeps is unchanged, and the slit stays the only detail on it.
  phone: { bar: 0.028, side: 0.026, foot: 0.032, frame: 0.017, r: 0.070, sr: 0.030 },
}
// The shell, and the hairline that answers for both of its edges. The two are the
// range apart on purpose: an edge drawn as a pair of tones that far apart stands clear
// of whatever it meets, because nothing can be within the floor of both of them. That
// is how a device keeps the take's edge contract without measuring anything per pixel,
// which is what keeps the two decode paths on the same side of it.
// face is the bar a window wears, a shade off the shell; deep is the laptop's foot, a
// shade down, because a foot is under the lid rather than in front of it. A browser has
// three surfaces of its own: the tab strip is the shell, the open tab and the toolbar
// it joins are `tool`, a step towards the viewer because they sit in front of the
// strip, and the address field is `well`, a step back into the toolbar.
// The tones are the token contract's now, but the keys are not renamed to match it:
// gl.js spreads this map into the device spec and that spec is part of the picture's
// cache key, so `face` reading the `surface` token has to stay `face` here or the
// editor stage and the export quietly stop agreeing about a frame.
const SHELL = {
  dark: { shell: tok('dark', 'shell', '#2A2420'), line: tok('dark', 'line', EDGE_LIT), face: tok('dark', 'surface', '#1F1B18'),
    deep: tok('dark', 'deep', '#1F1B18'), text: tok('dark', 'text', '#BDB5AC'), sheen: tok('dark', 'sheen', 0.07),
    tool: tok('dark', 'tool', '#3A322C'), well: tok('dark', 'well', '#1F1B18') },
  light: { shell: tok('light', 'shell', '#E8E2DA'), line: tok('light', 'line', EDGE_INK), face: tok('light', 'surface', '#F6F3EE'),
    deep: tok('light', 'deep', '#D6CFC5'), text: tok('light', 'text', '#6E655C'), sheen: tok('light', 'sheen', 0.5),
    tool: tok('light', 'tool', '#FAF7F2'), well: tok('light', 'well', '#ECE6DE') },
}

// ── the chrome the capture already has ──────────────────────────────────
//
// A shell drawn round a capture that already carries one is two title bars, and on a
// browser shell a blank address field sitting over a real one. Two facts settle it and
// nothing else has to.
//
// What the capture was of. Only a shot knows that and only a shot says it (`captured`,
// what take_shot captured): a window capture brings its own title bar with it, a display
// capture its menu bar, a region capture neither. A recording carries no `captured` at
// all, so no take this compositor has ever drawn can reach the other branch, and told
// nothing Fetch draws what it always drew.
//
// And whether anything has been taken off the top. frame.chrome remove and clean both
// crop to the page where the page's place is known, and a crop somebody drew by hand
// does the same work, so a capture with its top gone has no chrome left to collide with.
//
// And where the content's own rectangle inside the capture is known, that settles it
// outright. A crop that lands inside that rectangle has the content and nothing round
// it, wherever the edges it removed happened to be, so the shell drawn round it is the
// only shell.
//
// A take of a device's own window is the case those three got wrong between them, and
// the judge saw it as two bezels, two notches and a Mac toolbar in a picture whose whole
// promise was one phone (.context/survey/sim-taste.md). It carries `screen`, the
// device's own framebuffer, which is the one thing that says the capture is a machine
// inside a window: a floating toolbar, a transparent gap, a drawn bezel, and then the
// glass (.context/survey/st-t0.md). A recording says no `captured` at all, so the first
// fact was silent on it and the phone came out with its slit on. Nothing in the
// capture's shape gives it away either: on two of the three devices measured, the whole
// window is within a percent of the screen's own aspect, so a rule that compared the two
// would pass exactly where it is needed.
//
// So for those, the crop against the measured rectangle is the whole of it, in both
// directions. Inside it, the picture is the glass and Fetch's phone is the only phone.
// Not inside it, or no rectangle measured at all, and the device's own body is still in
// the picture: a missing measurement is not permission to guess, since the guess costs a
// second bezel where the truth costs a plain frame.
//
// Same question ui/review.js asks before it names double-chrome, and the same answer, so
// the picture and the judge of the picture cannot disagree about what is in it.
const CHROME_OF = { window: true, display: true, region: false }
const VIEW_EPS = 0.002   // the tolerance ui/fetchdoc.js chromeCrop matches a crop on
const WHOLE = { x: 0, y: 0, w: 1, h: 1 }
function insideView(crop, v) {
  if (!v || !(v.w > 0) || !(v.h > 0)) return false
  return crop.x >= v.x - VIEW_EPS && crop.y >= v.y - VIEW_EPS &&
    crop.x + crop.w <= v.x + v.w + VIEW_EPS && crop.y + crop.h <= v.y + v.h + VIEW_EPS
}
// How round the drawn screen has to be for the capture's own glass, as a share of the
// screen's short side, or 0. The glass is a rounded rectangle and a crop to its box keeps
// a crescent of Simulator bezel in each corner, which inside Fetch's phone is a second
// bezel peeking out (.context/survey/st-taste.md, section 5). The corner is measured off
// the pixels with the rectangle (ui/simulator.js cornerOf). Only where the crop is the
// glass: a crop inside it has app in its corners, and one round it kept the bezel whole.
function glassCorner(cap = {}) {
  const v = cap.viewport, c = cap.crop
  const k = v && Number.isFinite(+v.corner) && +v.corner > 0 && +v.corner < 0.5 ? +v.corner : 0
  if (!k || !cap.screen || !c) return 0
  return ['x', 'y', 'w', 'h'].every(n => Math.abs(+c[n] - +v[n]) <= VIEW_EPS) ? k : 0
}
// The crop in the whole pixels ffmpeg's crop takes: an even size, and an even offset for
// 4:2:0 chroma. Rounded down, as it always was, except against a device's glass.
//
// Down is the wrong way at the glass's top and left edges. The judged take's glass
// starts at 0.0554 x 794 = 43.99 and 0.0896 x 1718 = 153.9; floored and then made even
// that is 42 and 152, two pixels of the Simulator's black ring along the top and the left
// of every phone, and none on the right or the bottom, since flooring the size takes
// those edges inward. So where the crop lies inside the measured glass, both of its
// edges are held inside the glass's own whole pixels: the start rounded up to even and
// the end rounded down, which on that take is 44 and 154 and the same right and bottom
// edges as before. The slack is one step of the viewport's own rounding (ui/simulator.js
// r4), so a glass stored a hair past a pixel does not give up two pixels of app for it.
// A crop that keeps the bezel, and every take that is not of a device, is untouched.
const evenUp = n => n + (n & 1)
function cropPx(c, W, H, cap = {}) {
  if (!c) return { x: 0, y: 0, w: W & ~1, h: H & ~1 }
  const w = 2 * Math.floor(W * c.w / 2), h = 2 * Math.floor(H * c.h / 2)
  const x = Math.min(W - w, Math.floor(W * c.x) & ~1), y = Math.min(H - h, Math.floor(H * c.y) & ~1)
  const v = cap.viewport
  if (!cap.screen || !insideView(c, v)) return { x, y, w, h }
  const ex = W * 1e-4, ey = H * 1e-4
  const gx0 = evenUp(Math.max(0, Math.ceil(W * v.x - ex))), gy0 = evenUp(Math.max(0, Math.ceil(H * v.y - ey)))
  const gx1 = Math.min(W, Math.floor(W * (v.x + v.w) + ex)), gy1 = Math.min(H, Math.floor(H * (v.y + v.h) + ey))
  // the crop's own ends, not the floored ones: flooring the size already took a pixel
  // or two off the right and the bottom, and taking them again would narrow the app
  const cx1 = Math.floor(W * (c.x + c.w) + ex), cy1 = Math.floor(H * (c.y + c.h) + ey)
  const sx = Math.max(x, gx0), sy = Math.max(y, gy0)
  const sw = 2 * Math.floor((Math.min(cx1, gx1) - sx) / 2), sh = 2 * Math.floor((Math.min(cy1, gy1) - sy) / 2)
  // a glass too small to hold the crop is not a glass anybody measured
  return sw >= 2 && sh >= 2 ? { x: sx, y: sy, w: sw, h: sh } : { x, y, w, h }
}

// The viewport with its glass's corner on it: the one the capture wrote, else the one
// prepare.js measured off the take (`prepared.glass.corner`, a share of the glass's short
// side, the same number ui/simulator.js cornerOf writes), else as it came.
// A stored corner a frame of the take disagreed with (`prepared.glass.replaces`, on a
// screen whose own radius is not known) gives way to the reading.
function viewWithCorner(v, P) {
  if (!v) return v
  const k = P && P.glass ? +P.glass.corner : 0
  if (P && P.glass && P.glass.replaces != null) {
    const { corner, ...rest } = v
    return k > 0 && k < 0.5 ? { ...rest, corner: k } : rest
  }
  if (+v.corner > 0 && +v.corner < 0.5) return v
  return k > 0 && k < 0.5 ? { ...v, corner: k } : v
}

function ownChrome(cap = {}) {
  const crop = cap.crop && cap.crop.w > 0 && cap.crop.h > 0 ? cap.crop : null
  if (cap.screen) return !insideView(crop || WHOLE, cap.viewport)
  if (crop && (crop.y > 0.01 || insideView(crop, cap.viewport))) return false
  return !!(cap.captured && CHROME_OF[cap.captured.kind])
}

// What the bar says, and in which of its two voices.
//
// A browser's field holds an address and a window's bar holds a title, and the two are
// not interchangeable: a window title dropped into an address pill claims to be a URL,
// which is exactly the kind of small invention an export must never make. So the text is
// read rather than declared. Anything shaped like a host goes in the field; anything else
// is centred on the bar the way a window's title is; nothing at all leaves the field off
// altogether, because an empty one reads as a mockup somebody abandoned.
//
// Where it comes from for a window capture: from the window. take_shot already knows the
// title it captured, so an unset device.title takes it rather than leaving the bar blank.
// That is the frame somebody keeps after cropping the capture's own bar away, and the
// title then moves from the capture into the frame Fetch draws.
// A bare host and a filename are the same shape, and filenames are the commonest window
// titles there are: README.md, notes.txt, index.html all match a run of dotted labels
// ending in two or more letters. Drawn in the pill, the frame would have invented an
// address out of a document, which is the one thing this whole rule exists to stop. A
// scheme or a path says address outright; everything else has to be a host that does not
// end in the name of a file format. Single letter endings never matched to begin with.
const ADDRESS = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[:/?#]\S*)?$/i
const HAS_PATH = /^[a-z][a-z0-9+.-]*:\/\/|[/?#]/i
const A_FILE = /\.(?:md|txt|html?|jsx?|tsx?|json|ya?ml|css|scss|less|png|jpe?g|gif|svg|webp|pdf|zip|csv|xml|py|rb|go|rs|swift|java|kt|php|cpp|hpp|toml|lock|log|sh|bash|zsh|sql|env|ini|conf|cfg|plist|xcodeproj|docx?|xlsx?|pptx?|mp4|mov|wav|mp3|webm)$/i
const isAddress = t => !!t && ADDRESS.test(t) && (HAS_PATH.test(t) || !A_FILE.test(t))
// A browser has two places for words, and they now say two things: the tab carries the
// page's name and the field carries the address. The address comes from device.url, or
// from what the capture knew (captured.url), or from a title that is itself shaped like
// a host, which is how every look written before the field existed says it. Never made
// up: with none of the three the field is drawn empty, as a real browser draws it on a
// page it has not been told the address of, and the tab keeps the title. The tab's own
// words are the title where there is one that is not the address, and the host where
// the address is all there is, which is what a browser shows for a page with no title.
const hostOf = u => String(u).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '')
function barText(said, captured, url) {
  const t = String(said == null || said === '' ? (captured && captured.title) || '' : said).trim().slice(0, 80)
  const u0 = String(url || (captured && captured.url) || '').trim().slice(0, 200)
  const u = isAddress(u0) ? u0 : isAddress(t) ? t : ''
  const tab = t && t !== u ? t : u ? hostOf(u) : ''
  return { title: t, address: !!u, url: u, tab }
}

// A shell's top bezel, its foot and whether it keeps the one detail that names it, all
// as shares of the screen's own width. What a drawn frame is shaped like, in one place.
//
// An even bezel where the capture has chrome of its own: the shell is then a frame round
// a window that already has a title bar, rather than a second window round the first.
// A browser keeps its whole bar, tab strip and toolbar, whether or not there is an
// address to put in its field. It used to fall back to a window's bar where there was
// none, and the person looking at it saw a window: a browser is told from a window by
// its tabs and its toolbar, and a frame asked to be a browser has to be one.
//
// The same answer for a phone, which is what a simulator asks for. A capture of a
// device's own window is already a phone shaped picture with a phone's outline drawn in
// it, and Fetch's phone round that is a phone inside a phone. So a phone that is asked
// for over a capture that kept its own device is a plain frame: bezel, foot and sides
// all one thickness, and no speaker slit, since the slit is the one stroke that says
// phone and saying it twice in a picture is the doubling. A phone's two bezels are a
// pair, so the foot comes down with the bar; browser, window and laptop already have a
// foot the thickness of their sides and are left exactly as they were.
function bezel(kind, address, own) {
  const d = DEVICES[kind]
  // A plain frame over a capture that already shows a phone has its own thickness, and
  // it is thinner than any of the phone's own edges. It used to borrow d.side, which
  // worked only while a phone wore a brow half again as thick as its sides: once the
  // bezels were evened up, the frame and the phone became the same picture, and the
  // thing this branch exists to prevent (a phone drawn round a phone) came back by
  // arithmetic rather than by anybody choosing it.
  if (kind === 'phone') return own ? { bar: d.frame, foot: d.frame, side: d.frame, slit: false } : { bar: d.bar, foot: d.foot, slit: true }
  if (kind !== 'browser' && kind !== 'window') return { bar: d.bar, foot: d.foot, slit: false }
  const bar = own ? d.side : d.bar
  return { bar, foot: d.foot, slit: false }
}

/**
 * Where a drawn device sits, in output pixels, or null when the look asks for none.
 *   D       the look's device section
 *   chrome  the look's frame.chrome: clean draws Fetch's own frame in place of the one
 *           it cropped off, which is the whole of that setting's third option (the crop
 *           itself is the document's, ui/fetchdoc.js chromeCrop). It only draws where
 *           that crop could happen: with no viewport the take still carries its own
 *           tabs and toolbar, and a drawn browser round them is two browsers.
 *           Look.warnings says so in the same case. Which frame is what the capture was
 *           of: a phone where the crop took a device's own window off a device's own
 *           screen, since a bar with a title in it over a handset's glass is the same
 *           doubling the other way round, and a browser everywhere else.
 *   g       the layout's geometry, gut the take's corner floor, end the ground's own end
 *   bg      the ground, for the shell's own tone
 *   cap     { viewport, captured, crop, screen }: what the capture was of, what is left
 *           of it, and the device's own framebuffer where it was a capture of a machine
 */
function devicePlan(D = {}, chrome, g, corner, end, bg = {}, cap = {}) {
  const kind = DEVICES[D.kind] ? D.kind
    : chrome === 'clean' && cap.viewport ? (cap.screen ? 'phone' : 'browser') : null
  if (!kind) return null
  const d = DEVICES[kind]
  const a = g.vidW / g.vidH
  const base = d.base || 0
  const own = ownChrome(cap)
  const text = barText(D.title, cap.captured, D.url)
  const bez = bezel(kind, text.address, own)
  const glass = own ? 0 : glassCorner(cap)
  // An exact place for the take, from a store plan: the screen is that box and the shell
  // grows round it, rather than the box being shrunk to make room for a shell.
  // A shell that would run off the picture is not drawn round the box: at a 0.95 share
  // the phone was cut by all four edges. Then the layout below fits it inside the box,
  // and a smaller take is only ever a smaller upscale than the one judged.
  const at = cap.at
  if (at) {
    const s = shellAt(kind, at.w, at.w / at.h, at.x + at.w / 2, at.y + at.h / 2, corner, bez, glass)
    const dx = at.x - s.screen.x, dy = at.y - s.screen.y
    const move = r => (r ? { ...r, x: r.x + dx, y: r.y + dy } : r)
    const extent = move(s.extent)
    const fits = extent.x >= 0 && extent.y >= 0 && extent.x + extent.w <= g.outW && extent.y + extent.h <= g.outH
    if (fits) {
      return { ...s, box: move(s.box), foot: move(s.foot), extent,
        slit: s.slit ? { ...s.slit, y: s.slit.y + dy } : null,
        screen: { ...s.screen, x: at.x, y: at.y, w: at.w, h: at.h },
        ...shellTone(D, end, bg), ...text, own }
    }
  }
  // the largest screen of the take's own shape that leaves room for the shell round it
  // the sides come off the bezel where it names them (a plain frame does), else off the
  // device's own table: naming bar and foot without side is what let a frame keep a
  // phone's sides while its top and bottom went thin
  const sideOf = bez.side != null ? bez.side : d.side
  const sw = Math.min(g.vidW / (1 + 2 * sideOf), g.vidH / (1 / a + bez.bar + bez.foot + base))
  return { ...shellAt(kind, sw, a, g.ox + g.vidW / 2, g.oy + g.vidH / 2, corner, bez, glass),
    ...shellTone(D, end, bg), ...text, own }
}

/**
 * The shell round a screen sw wide of the capture's own aspect, centred on (cx, cy).
 * Every measurement a drawn device has is here and nowhere else, so one capture filling
 * the layout and one capture standing beside another in a group are the same shape
 * solved from a different width rather than two shapes that have to be kept in step.
 */
function shellAt(kind, sw, a, cx, cy, corner, bez = bezel(kind, false, false), glass = 0) {
  const d = DEVICES[kind]
  const base = d.base || 0
  const sh = sw / a
  const bar = bez.bar
  // as above: a bezel that names its sides owns all four edges, not only two
  const side = bez.side != null ? bez.side : d.side
  // The glass's own corner, where the capture is a device's glass: the mask is that
  // round or the Simulator's bezel shows in the corners. Then the shell is cut concentric
  // with it, so the bezel is as thick round the corner as along the side. Zero on every
  // other take, which leaves both radii exactly as they were.
  const gr = glass > 0 ? glass * Math.min(sw, sh) : 0
  const sr = Math.max(corner, sw * d.sr, gr)
  const boxW = sw * (1 + 2 * side), boxH = sh + sw * (bar + bez.foot)
  const box = { x: Math.round(cx - boxW / 2), y: Math.round(cy - (boxH + sw * base) / 2), w: Math.round(boxW), h: Math.round(boxH),
    r: gr ? Math.max(sw * d.r, sr + sw * side) : sw * d.r }
  const screen = {
    x: Math.round(box.x + sw * side), y: Math.round(box.y + sw * bar),
    w: 2 * Math.round(sw / 2), h: 2 * Math.round(sh / 2),
    // never tighter than the window's own rounded corner, or its black corner shows
    r: sr,
  }
  const foot = base ? {
    x: box.x - sw * d.over, y: box.y + box.h, w: box.w + 2 * sw * d.over, h: sw * base,
    r: sw * base * 0.35, taper: sw * base * 0.5,
  } : null
  // a phone's speaker, the one detail on it: a slit in the top bezel, centred
  const slit = bez.slit ? { w: sw * 0.10, h: Math.max(2, sw * 0.006), y: box.y + sw * bar * 0.42 } : null
  const pad = Math.ceil(sw * 0.02)
  const x0 = Math.min(box.x, foot ? foot.x : box.x) - pad, y0 = box.y - pad
  const x1 = Math.max(box.x + box.w, foot ? foot.x + foot.w : 0) + pad, y1 = (foot ? foot.y + foot.h : box.y + box.h) + pad
  return { kind, box, screen, foot, slit, bar: sw * bar, unit: sw,
    extent: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }
}

// Graphite on a dark ground, bone on a light one. A photo is the one ground the plan
// cannot read: edgeEnd calls every image light, because the hairline's ink end is the
// safe one until the picture is decoded, and for a shell that would be a pale slab on
// a near-black photo, which is four of the five we ship. So a photo starts on graphite
// and gl.js re-picks it from the decoded mean (deviceOf), the way it does the hairline.
// A group asks this once for the whole set: two shells in one picture lit two ways is
// the fault the whole group exists to avoid.
function shellTone(D = {}, end, bg = {}) {
  const auto = D.theme !== 'light' && D.theme !== 'dark'
  const light = !auto ? D.theme === 'light' : bg.kind !== 'image' && !!end.light
  return { light, auto, ...SHELL[light ? 'light' : 'dark'] }
}

// The room that shell needs, and where its centre sits inside it, with no placement at
// all: what a group has to know about a member before it knows where the member goes.
function shellExtent(kind, sw, a, bez) {
  const d = DEVICES[kind]
  if (!d) return { w: sw, h: sw / a, cdx: sw / 2, cdy: sw / (2 * a) }
  const base = d.base || 0, over = d.over || 0, pad = sw * 0.02
  const b = bez || bezel(kind, false, false)
  const boxW = sw * (1 + 2 * d.side), boxH = sw / a + sw * (b.bar + b.foot)
  const w = (base ? boxW + 2 * sw * over : boxW) + 2 * pad
  return { w, h: boxH + sw * base + 2 * pad, cdx: w / 2, cdy: pad + (boxH + sw * base) / 2 }
}

// ── more than one capture in one picture ────────────────────────────────
//
// A handset beside a window, a handset beside a laptop: two or three captures arranged
// as one group. What makes a group a photograph rather than two pictures pasted
// together is that everything but the pixels is shared, and shared by being one number
// rather than two numbers set the same way. One ground. One light: every member casts
// from spec.shadow, so the drop and the softness are the same absolute distance for a
// handset and for a laptop, which is what one softbox over a desk actually does. One
// grade, because the treatment pass runs once over the finished frame. One plane where
// a tilt turns, since two vanishing points is two cameras. One scale.
//
// Real relative sizes is the rule and not a dial, and it is the part that is easy to get
// wrong. A point is not the same size on a desk as in a hand: a desktop point is about a
// hundred and tenth of an inch and a handset's about a hundred and sixtieth, so a 1440
// point window is 332 mm across and a 393 point handset screen is 62. Laid out in points
// alone the handset comes out five times too large and the group reads as a toy beside a
// building. So a member is measured in millimetres, and the layout is in millimetres
// until the last step.
const MM_DESK = 25.4 / 110, MM_HAND = 25.4 / 160

// A capture's real screen width. Believed in this order, because a capture that knows
// its own density is better evidence than any default: the width someone gave, the
// pixel density someone gave, and finally the backing scale with the frame the look
// asked for standing in for where the thing was (a handset frame means it was in a
// hand). Never zero: a member with nothing known is read as a 2x desktop capture.
function realMM(m) {
  if (+m.mm > 0) return +m.mm
  if (+m.ppi > 0) return Math.max(1, (+m.w || 1) / +m.ppi * 25.4)
  const scale = +m.scale > 0 ? +m.scale : 2
  return Math.max(1, ((+m.w || 1) / scale) * (m.kind === 'phone' ? MM_HAND : MM_DESK))
}

/**
 * Where each member of a group sits, at one pixel per millimetre, before the group is
 * fitted to the frame. gap is a share of the widest member's own shell, so it means the
 * same thing whatever is in the group, and it is allowed to go negative: an overlap is
 * what stops two objects on one surface reading as two photographs.
 *
 * align 'stand' gives every member one bottom line, which is the arrangement that reads
 * as one surface; 'centre' lines their middles up, which is right when the group is a
 * row of screens rather than a desk.
 */
const GROUP_MAX = 3
function groupLayout(list, gap, align) {
  const cells = list.map(m => ({ ...shellExtent(m.kind, m.mm, m.a, m.bez), sw: m.mm }))
  const unit = Math.max(...cells.map(c => c.w))
  // clamped so a gap can never fold the group onto one point
  const sp = clamp(num(gap, 0.06), -0.45, 0.6) * unit
  const H = Math.max(...cells.map(c => c.h))
  let x = 0
  // a quarter of every member stays clear of the next whatever the gap asks for: past
  // that an overlap is not an arrangement, it is one capture hidden behind another
  for (const c of cells) { c.x = x; x += Math.max(0.25 * c.w, c.w + sp); c.y = align === 'centre' ? (H - c.h) / 2 : H - c.h }
  const W = Math.max(...cells.map(c => c.x + c.w))
  return { w: W, h: H, cells }
}

/**
 * The group as the caller states it, in this module's own words, or null where there is
 * nothing to arrange. A group of one is a take, and goes down the path a take goes down.
 *   opts.group  { gap, align, members } or just the members
 * A member is { src, w, h, scale, ppi, mm, device, title, captured, crop, viewport,
 * screen }: its file, its captured pixels, what is known about how big the thing really
 * is, what it was a capture of, and the frame it wears. The frame is the member's own,
 * because a handset and a browser window in one picture is the case this exists for;
 * where a member does not name one it wears the look's. So is the chrome question: each
 * member answers it about its own capture, viewport and all, through the one rule, which
 * is the only way a handset with no title bar can stand beside a window that has one and
 * both be drawn right. No member carries `screen` today, since a simulator in a group is
 * not built; it is read here so that the day one does, it answers as a take of one does.
 */
function groupSpec(raw, D = {}, radius = 0) {
  const members = (Array.isArray(raw) ? raw : (raw && raw.members) || []).filter(Boolean).slice(0, GROUP_MAX)
  if (members.length < 2) return null
  const cfg = Array.isArray(raw) ? {} : raw || {}
  const list = members.map(m => {
    const w = Math.max(1, +m.w || 1), h = Math.max(1, +m.h || 1)
    const c = m.crop && m.crop.w > 0 && m.crop.h > 0 ? m.crop : null
    const asked = m.device === undefined || m.device === null ? D.kind : m.device
    const kind = DEVICES[asked] ? asked : null
    const own = ownChrome({ captured: m.captured, crop: c, viewport: m.viewport, screen: m.screen })
    const text = barText(m.title == null ? D.title : m.title, m.captured, m.url == null ? D.url : m.url)
    const q = { src: m.src || null, w, h, scale: m.scale, ppi: m.ppi, mm: m.mm, kind,
      ...text, own, bez: kind ? bezel(kind, text.address, own) : null,
      marks: Array.isArray(m.marks) ? m.marks : [],
      crop: cropPx(c, w, h, { viewport: m.viewport, screen: m.screen }),
      radius }
    // the shape the frame is drawn to is the crop's, not the capture's: a member cropped
    // square must not be hung in a shell cut for the whole window
    q.a = q.crop.w / q.crop.h
    // measured off the crop, since that is the part of the thing that is in the picture
    q.mm = realMM({ ...q, w: q.crop.w })
    return q
  })
  return { list, gap: cfg.gap, align: cfg.align === 'centre' ? 'centre' : 'stand', theme: cfg.theme || D.theme }
}

/**
 * The group placed in the room the composition gave it: one scale in millimetres for
 * every member, so the relative sizes survive the fit, and the set centred in that room.
 * Returns the members with their shells and their screens, and the box the whole group
 * stands in, which is what a tilt turns and what the grade is held to.
 */
function placeGroup(G, gl, g, corner, end, bg) {
  const S = Math.min(g.vidW / gl.w, g.vidH / gl.h)
  const ox = g.ox + (g.vidW - gl.w * S) / 2, oy = g.oy + (g.vidH - gl.h * S) / 2
  // one tone for the whole set: two shells in one picture lit two ways is two pictures
  const tone = shellTone(G, end, bg)
  const members = G.list.map((m, i) => {
    const c = gl.cells[i]
    const cx = Math.round(ox + (c.x + c.cdx) * S), cy = Math.round(oy + (c.y + c.cdy) * S)
    const sw = m.mm * S
    const shell = m.kind
      ? { ...shellAt(m.kind, sw, m.a, cx, cy, corner, m.bez), ...tone, title: m.title, address: m.address, url: m.url, tab: m.tab, own: m.own }
      : null
    const w = 2 * Math.round(sw / 2), h = 2 * Math.round(sw / m.a / 2)
    const rect = shell ? shell.screen : { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h }
    return { src: m.src, device: shell, rect, radius: shell ? shell.screen.r : Math.max(0, m.radius),
      srcSize: { w: m.w, h: m.h }, crop: m.crop, mm: m.mm, rawMarks: m.marks }
  })
  const ext = members.map(q => (q.device ? q.device.extent : q.rect))
  const x0 = Math.min(...ext.map(e => e.x)), y0 = Math.min(...ext.map(e => e.y))
  const x1 = Math.max(...ext.map(e => e.x + e.w)), y1 = Math.max(...ext.map(e => e.y + e.h))
  return { members, scale: S, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }
}

// ── the tilt ────────────────────────────────────────────────────────────
//
// frame.tilt turns the framed take in perspective: a real rotation about the vertical
// axis through its own centre, projected from a camera 2.2 frames away, not a skew.
// The frame pass reads it backwards, per pixel: every pixel of the output is asked
// which point of the flat plane it shows, and everything after that (the take's rounded
// mask, its border, its shadow, the camera bubble lying on it) is worked out on the
// plane exactly as it was before the tilt existed. So the mask follows the perspective
// because it is the same mask, and the shadow follows it because it is cast on the
// plane rather than painted under the picture.
//
// The plane is shrunk by as much as the projection's near edge grows, so a tilted take
// occupies exactly the room the flat one did and the near corner cannot reach past the
// frame. Positive turns the take's right edge toward the viewer.
const TILT_DIST = 2.2
function tiltPlan(deg, box, g) {
  const t = clamp(num(deg, 0), -20, 20)
  if (!(Math.abs(t) > 0.01)) return null
  const rad = t * Math.PI / 180
  const D = TILT_DIST * Math.max(g.outW, g.outH)
  const sin = Math.sin(rad), m = D * Math.cos(rad)
  // the near edge grows by D / (D - halfW |sin|); the whole plane gives that back
  const fit = (D - (box.w / 2) * Math.abs(sin)) / D
  return { sin, m, D, fit, cx: box.x + box.w / 2, cy: box.y + box.h / 2 }
}

// ── the camera bubble's track ───────────────────────────────────────────
//
// The bubble used to sit in one corner at one size for a whole take. It is keyframed
// now: where it is, how big it is and what shape it is, over time. The reason is the
// shot and not the feature. A face should be large while somebody is introducing a
// thing and small once the thing itself is the point, and a bubble that cannot move is
// one of those two wrong for most of the take.
//
// A key is a state the bubble starts moving to at its own time, the way a zoom starts
// pushing in at its own start rather than arriving there. Fields a key leaves out keep
// the value the bubble already had, which is what makes this one call rather than six:
// "keep the camera small while the lift is up" says a size and says nothing about the
// corner the bubble never leaves.
//
// An entry with start and end is that same thing said once: the state at start, and
// whatever the bubble had before it at end. That is the shape an agent reaches for,
// because what it wants is almost never a keyframe, it is a stretch of the take where
// the face is not the point.
//
// Times are the document's, source seconds, like a zoom's; clock() puts them on the
// output. The track is a function of time alone, so any frame still draws alone.
const CAM_SHAPES = { circle: 0.5, rounded: 0.22 }
const CAM_MIN = 0.05, CAM_MAX = 0.6

// The keys of a camera as states in fractions of the take: { t, x, y, size, rf }, the
// first one at 0 being where the editor put the bubble.
function camKeys(list, base, clock) {
  const partial = e => {
    const s = {}
    if (Number.isFinite(+e.x)) s.x = clamp(+e.x, 0, 1)
    if (Number.isFinite(+e.y)) s.y = clamp(+e.y, 0, 1)
    if (Number.isFinite(+e.size)) s.size = clamp(+e.size, CAM_MIN, CAM_MAX)
    if (CAM_SHAPES[e.shape] != null) s.rf = CAM_SHAPES[e.shape]
    return s
  }
  const raw = []
  for (const e of Array.isArray(list) ? list : []) {
    if (!e) continue
    const s = partial(e)
    if (!Object.keys(s).length) continue
    // a span if it has both ends and they are the right way round, else one moment
    const span = Number.isFinite(+e.start) && Number.isFinite(+e.end) && +e.end > +e.start
    const a = [span ? e.start : null, e.t, e.at, e.start].find(v => v != null && Number.isFinite(+v))
    if (a == null) continue
    raw.push({ a: +a, b: span ? +e.end : null, s })
  }
  raw.sort((p, q) => p.a - q.a)
  // What a span puts back is what the bubble had before that span, read as the list is
  // walked in order. A span whose whole stretch the edit cut lands both of its ends on
  // one output instant, and the sort is stable, so the state put back is the one that
  // survives: a bubble does not shrink for a moment that is not in the video.
  const edges = []
  let cur = { ...base }
  for (const r of raw) {
    edges.push({ t: clock(r.a), s: r.s })
    if (r.b != null) {
      const back = {}
      for (const f of Object.keys(r.s)) back[f] = cur[f]
      edges.push({ t: clock(r.b), s: back })
    }
    cur = { ...cur, ...r.s }
  }
  edges.sort((p, q) => p.t - q.t)
  const keys = [{ ...base, t: 0 }]
  let st = { ...base }
  for (const e of edges) {
    st = { ...st, ...e.s }
    const t = Math.max(0, e.t)
    // two keys on one instant are one key, the last of them
    if (t <= keys[keys.length - 1].t) keys[keys.length - 1] = { ...st, t: keys[keys.length - 1].t }
    else keys.push({ ...st, t })
  }
  return keys
}

// The same track in the pixels of the output, each key a centre, a diameter and a
// corner, plus how long the move into it takes.
//
// The lengths are the zooms' own measures, because a bubble easing differently from the
// frame it sits in reads as two takes cut together: octaves of size through easeSpan,
// bubble widths travelled through panSpan, and the longer of the two. Never longer than
// the gap to the key after it, so a move always lands before the next one leaves.
function camPlan(keys, rect, ease) {
  const out = keys.map(st => {
    // the size is a share of the take's width, and never more of it than the take's
    // short side: a bubble wider than the take it lies on has nowhere to be put
    const d = 2 * Math.round(Math.min(Math.max(24, st.size * rect.w), Math.min(rect.w, rect.h)) / 2)
    return {
      t: st.t, d, rf: st.rf,
      // never outside the take, at every key and so at every instant between two of
      // them: the centre and its room are both affine in the ease, and no ease here
      // overshoots, so a move between two bubbles that fit is made of bubbles that fit
      cx: clamp(rect.x + st.x * rect.w, rect.x + d / 2, rect.x + rect.w - d / 2),
      cy: clamp(rect.y + st.y * rect.h, rect.y + d / 2, rect.y + rect.h - d / 2),
      T: 0,
    }
  })
  for (let i = 1; i < out.length; i++) {
    const a = keys[i - 1], b = keys[i]
    const grow = Overlays.easeSpan(1, Math.max(a.size, b.size) / Math.max(1e-4, Math.min(a.size, b.size)), ease)
    const px = Math.hypot((b.x - a.x) * rect.w, (b.y - a.y) * rect.h)
    const wide = px > 0 ? Overlays.panSpan(px / Math.max(1, (a.size + b.size) / 2 * rect.w), ease) : 0
    const gap = i + 1 < out.length ? out[i + 1].t - out[i].t : Infinity
    out[i].T = Math.max(1 / 240, Math.min(Math.max(grow, wide), gap))
  }
  return out
}

/**
 * Where the bubble is at output time t: { x, y, d, round, ring }, x and y its top left
 * in output pixels. At a key and before the first one it is that key exactly, so a take
 * with no keys draws the bubble it always drew, byte for byte.
 */
function camAt(cam, t) {
  const ks = cam.track
  let i = 0
  while (i + 1 < ks.length && ks[i + 1].t <= t) i++
  const b = ks[i]
  const e = i === 0 || !(b.T > 0) ? 1 : Overlays.easeAt((t - b.t) / b.T, cam.ease)
  const a = i === 0 ? b : ks[i - 1]
  const m = (p, q) => (e >= 1 ? q : p + (q - p) * e)
  const d = m(a.d, b.d)
  // The shape is the corner as a share of the diameter, so circle to rounded is a
  // morph the frame pass already knows how to draw rather than a switch on a frame.
  return { x: m(a.cx, b.cx) - d / 2, y: m(a.cy, b.cy) - d / 2, d, round: d * m(a.rf, b.rf),
    ring: cam.ringOn ? Math.max(2, Math.round(d * 0.016)) : 0 }
}

// ── which renderer ──────────────────────────────────────────────────────
// The compositor draws everything an edit places (M3): the framed look, zooms, fades,
// cuts, the camera, marks, lifts and spotlights, steps, the agent's cursor, the Mac's
// pointer lifted out, captions, titles, labels and auto zoom (its moments worked out by
// prepare.js). Every format that carries a picture is drawn here now and differs only at
// the sink: H.264 for MP4 and MOV, VP9 for WebM, a palette pass for GIF (sinks.js). A
// GIF used to be the old product, missing the treatment, the lift, the device frames and
// the easing, which is the one deliverable a landing page autoplays. What is left for the
// classic renderer is a file with no picture in it (m4a, mp3, wav) and a still frame.
const GL_FORMATS = new Set(['mp4', 'mov', 'webm', 'gif'])
function unsupported(opts = {}, ctx = {}) {
  const why = []
  const fmt = opts.format || 'mp4'
  if (!GL_FORMATS.has(fmt)) why.push(`${fmt} output`)
  if (opts.still != null) why.push('a still frame')
  return why
}

/**
 * The engine for an export: { engine: 'gl' | 'classic', why }. mode is auto (the
 * compositor when it draws everything the edit uses), gl (forced: what it cannot draw
 * yet is left out, and why says what) or classic.
 */
function engineFor(opts, ctx = {}, mode = 'auto') {
  const why = unsupported(opts, ctx)
  if (mode === 'classic') return { engine: 'classic', why: ['classic requested'] }
  if (mode === 'gl') return { engine: why.includes(`${opts.format || 'mp4'} output`) ? 'classic' : 'gl', why }
  return { engine: why.length ? 'classic' : 'gl', why }
}

// The marks to draw: each lift, spotlight and step as prepare.js fitted it to the take
// (held to its element, its box grown to the element's edge, its corner measured, a
// step on its card's corner) when that was worked out for this very mark, else as the
// edit has it. A mark edited since is drawn as it now is until it is read again.
const markKey = m => [m.kind, m.start, m.end, m.x, m.y, m.w, m.h, m.n].join('|')
function markList(marks, fitted) {
  const byKey = new Map((fitted || []).filter(m => m && m.k0).map(m => [m.k0, m]))
  return (marks || []).filter(Boolean).map(m => byKey.get(markKey(m)) || m)
}

// ── room for the type ───────────────────────────────────────────────────
//
// The same clamp backdropGeometry applies to the padding, because the type's room is
// taken out of the very box that fitted the take, and a second opinion about the margin
// would put the block and the picture in two different frames.
const INSET = opts => Math.min(0.22, Math.max(0.02, opts.inset ?? 0.08))
/**
 * The take refitted into what the type left it. room is { top, bottom, left, right } in
 * output pixels, off text.stillRoom.
 *
 * The room comes out of the slack first: a wide window in a 1:1 frame already leaves
 * half the height empty, and a headline that made such a picture smaller to stand in
 * room nobody was using would be a worse composition for no reason. Only where the slack
 * runs out does the picture give ground, and it gives it by scale, so its shape, its
 * corner and its shadow stay the picture's own.
 */
function typeRoom(g, room, inset, band) {
  if (!room || !(room.top || room.bottom || room.left || room.right)) return g
  const bottom = band ? Math.max(band, inset) : inset
  const bx = g.outW * inset + room.left, by = g.outH * inset + room.top
  const bw = Math.max(2, g.outW * (1 - 2 * inset) - room.left - room.right)
  const bh = Math.max(2, g.outH * (1 - inset - bottom) - room.top - room.bottom)
  const k = Math.min(bw / g.vidW, bh / g.vidH, 1)
  const vidW = Layout.even(g.vidW * k), vidH = Layout.even(g.vidH * k)
  return { ...g, vidW, vidH,
    ox: Math.round(bx + (bw - vidW) / 2), oy: Math.round(by + (bh - vidH) / 2),
    radius: Math.max(6, Math.round(g.radius * k)), blur: Math.max(4, Math.round(g.blur * k)) }
}

// A store plan's box, checked before anything is drawn at it: whole pixels inside the
// store's exact pair, and the take's own shape to within the plan's flooring. A box of
// another shape would stretch the app, which is worse than drawing it where the look
// would have, so that is null and the layout decides as it always has.
function storeBox(opts, cw, ch) {
  const s = opts.size, b = opts.box
  if (!s || !b) return null
  const W = Math.round(+s.w), H = Math.round(+s.h)
  const x = Math.round(+b.x), y = Math.round(+b.y), w = Math.round(+b.w), h = Math.round(+b.h)
  if (![W, H, x, y, w, h].every(Number.isFinite) || !(W > 0 && H > 0 && w > 0 && h > 0)) return null
  if (x < 0 || y < 0 || x + w > W || y + h > H) return null
  if (!(cw > 0 && ch > 0) || Math.abs(w / h - cw / ch) * h > 1.5) return null
  return { x, y, w, h, size: { w: W, h: H } }
}

// ── the plan ────────────────────────────────────────────────────────────
/**
 * The fixed part of a render.
 *   opts  toExportOpts' bag (start, end, cuts, crop, zooms, backdrop, backdropAspect,
 *         inset, radius, shadow, scale, camera, fadeIn, fadeOut, look), and on a shot
 *         `captured`, what take_shot captured: a window, a display or a region, and the
 *         window's own title. A drawn frame is the only thing that reads it.
 *   meta  { width, height, duration, fps } of the take
 *   ctx   { gutter } the window's own margin (processor.frameGutter), { imageFile }
 *         the image backdrop's file, { fps } to override the output rate, { prepared }
 *         what the take's pixels say (prepare.js): fitted marks, the Mac's pointer,
 *         the agent's cursor, caption timings
 */
function prepare(opts = {}, meta = {}, ctx = {}) {
  const srcW = meta.width || 1920, srcH = meta.height || 1080
  const dur = meta.duration || 0
  const fps = ctx.fps || Timeline.outFps(meta)
  const start = Math.max(0, +opts.start || 0)
  const end = opts.end && opts.end > start ? Math.min(opts.end, dur || opts.end) : dur
  const clock = Timeline.outClock(opts.cuts, start, end, opts.rates)
  const keep = clock.keep
  const span = Timeline.outLength(keep)
  const frames = Math.max(1, Math.round(span * fps))

  // The crop as the classic export's ffmpeg crop takes it: even size, and an offset
  // rounded down to even for 4:2:0 chroma, except where that would reach past a device's
  // glass (cropPx). Even with no crop, so NV12 always fits.
  const c = opts.crop && opts.crop.w > 0 && opts.crop.h > 0 ? opts.crop : null
  const P = ctx.prepared || null
  // The glass's corner, off the document where the capture wrote it, and off the take's
  // own pixels where it did not (prepare.js, `glass`, from ui/simulator.js
  // measureCorner): a take measured before the corner was has a viewport with no corner
  // on it, and its store file kept a crescent of Simulator bezel in every corner.
  const view = viewWithCorner(opts.viewport, P)
  const px0 = cropPx(c, srcW, srcH, { viewport: view, screen: opts.screen })
  const cw = px0.w, ch = px0.h, cx = px0.x, cy = px0.y
  // what a store plan judged the box against, which is the crop before the glass held it:
  // a pixel or two of ring is not a reason to turn the judged box down
  const cwJudged = c ? 2 * Math.floor(srcW * c.w / 2) : cw, chJudged = c ? 2 * Math.floor(srcH * c.h / 2) : ch

  const look = opts.look || {}
  const L = sec => look[sec] || {}
  const framed = !!opts.backdrop
  const aspect = +opts.backdropAspect || null
  // Burned captions under a framed take get a band of their own below it, as the classic
  // export and the editor's layers lay them out; without it the stage's canvas drew the
  // take where the caption sits. ctx.cues overrides the count (0: none drawn here).
  const cst = opts.captionStyle || {}
  const cues = ctx.cues != null ? ctx.cues
    : (opts.cues || []).length || (P && P.captions && (P.captions.cues || []).length) || 0
  const band = framed && opts.captions && cues > 0 && (!cst.position || cst.position === 'bottom') && cst.fx == null
    ? Overlays.CAP_BAND : 0
  // More than one capture in one picture, laid out in millimetres and handed to the
  // composition as if it were the take: the padding, the shape, the shadow and the
  // caption band then need to know nothing about it. A group needs a ground to stand on,
  // so an unframed edit has none and draws its one take as it always did.
  const G = framed ? groupSpec(opts.group, L('device'), num(opts.radius, 0)) : null
  const gl = G ? groupLayout(G.list, G.gap, G.align) : null
  // the group at its own pixels: every member at the density of the sharpest of them, so
  // the size the layout is given is the size at which nothing in the set is enlarged
  const gpx = gl ? Math.max(...G.list.map(m => m.crop.w / m.mm)) : 1
  const boxW = gl ? Math.max(2, Math.round(gl.w * gpx)) : cw
  const boxH = gl ? Math.max(2, Math.round(gl.h * gpx)) : ch
  let g = framed
    ? Layout.backdropGeometry(boxW, boxH, { inset: opts.inset, radius: opts.radius, scale: opts.scale, band,
      outWidth: opts.scale === 720 ? 1280 : 1920, outAspect: aspect })
    : Layout.plainGeometry(cw, ch, { outAspect: aspect, scale: opts.scale })

  // Room for the picture's own type: a headline, its subhead and a caption under the
  // image (text.js, stillRoom). A screenshot without a line of type on it is a window on
  // a gradient, and a hero is the thing with the headline; what makes this a layout
  // question rather than another pass is that the type does not go over the picture. It
  // stands beside it or over the ground, and the take is refitted into what is left.
  //
  // Only where the look puts something behind the take. A take that fills the output has
  // no ground for type to stand on, so a headline there would have to lie on the product,
  // which is the one thing this is for not doing. Same call the reveal makes.
  //
  // On the clock, once, and the same list planText reads. Asked of the take's own
  // seconds here and of the output's there, the two sides disagreed about what a
  // full-span title was and a card over a trimmed edit vanished out of both.
  const typo = L('typography')
  const ctexts = Text.clockTexts(opts.texts, clock)
  let still = null
  if (framed) {
    const g0 = g
    const roomOf = width => Text.stillRoom(ctexts, { W: g0.outW, H: g0.outH, span,
      slack: { x: g0.outW * (1 - 2 * INSET(opts)) - g0.vidW }, width,
      place: typo.headline, size: typo.headlineSize })
    // The column over the picture is the picture's own width, and the picture's width is
    // what the type left it: each is the other's answer. Measured once against the box
    // the take started in, the take refitted, then measured again against the width it
    // actually came out at, which is as far as this is worth taking. The refit is always
    // from the original geometry, so the picture never gives ground twice for one block.
    still = roomOf(g0.vidW)
    if (still) {
      const once = typeRoom(g0, still.room, INSET(opts), band)
      const again = once.vidW < g0.vidW ? roomOf(once.vidW) : null
      still = again || still
      g = again ? typeRoom(g0, again.room, INSET(opts), band) : once
    }
  }

  // The take where a store plan put it. ui/sizes.js preview() judges the upscale at
  // plan.box and says "draw it at 689 x 1497"; the layout's own padding put it
  // somewhere near, and a drawn phone then shrank it again, so the file was not the
  // picture that was judged. With the box handed over, the output is the store's exact
  // pair and the take is that box, and a shell grows round it. Not under a headline:
  // the type has taken room the plan never knew about, and a smaller take is only ever
  // a smaller upscale.
  const at = framed && !gl && !still ? storeBox(opts, cwJudged, chJudged) : null
  if (at) {
    g = { ...g, outW: at.size.w, outH: at.size.h, vidW: at.w, vidH: at.h, ox: at.x, oy: at.y,
      radius: Math.max(6, Math.round(num(opts.radius, Math.min(at.w, at.h) * 0.035))),
      blur: Math.max(4, Math.round(at.h * 0.035)) }
  }

  // never tighter than the window's own rounded corner, or its black corner shows
  const gut = framed && ctx.gutter ? ctx.gutter : null
  const corner = gut && gut.corner ? Math.ceil(gut.corner * g.vidW * 1.45) + 2 : 0
  // and never squarer than the device's glass, where the crop is that glass. A plain
  // export too: it is the default export of every device take, and square it kept the
  // Simulator's grey highlight and ring in all four corners. With nothing behind it the
  // corner is the black the ring already was there, and the highlight is gone.
  const glass = glassCorner({ viewport: view, crop: opts.crop, screen: opts.screen })
  const radius = framed ? Math.max(g.radius, corner, glass * Math.min(g.vidW, g.vidH)) : glass * Math.min(g.vidW, g.vidH)

  // The window's own margin trimmed off inside the frame, covered to the frame's shape,
  // as the classic export does after its zoom: fractions of what the zoom shows.
  let inner = { x: 0, y: 0, w: 1, h: 1 }
  if (gut && (gut.l || gut.t || gut.r || gut.b)) {
    const gw = 1 - gut.l - gut.r, gh = 1 - gut.t - gut.b
    inner = gw > gh
      ? { x: gut.l + (gw - gh) / 2, y: gut.t, w: gh, h: gh }
      : { x: gut.l, y: gut.t + (gh - gw) / 2, w: gw, h: gw }
    // the frame is the crop's shape, so equal fractions keep it; correct for the rest
    const want = (g.vidW / g.vidH) / (cw / ch)
    if (want > 1) inner.h /= want; else inner.w *= want
  }

  // The classic shadow is the frame's shape blurred by boxblur radius r, power 2: a
  // Gaussian of that variance, hanging 0.9 r low. Widened, because DESIGN's Elevation
  // says wide rather than tight: on a near-black ground the classic width measured nine
  // levels deep and gone inside 25 px, which reads as a hairline of dark rather than as
  // elevation. A wide shadow is also the one the edge floor can measure, since the
  // ground a pixel out and the ground three pixels out are then the same ground; a
  // tight one is a cliff and the floor lands on whichever pixel it happened to read.
  //
  // Capped against the margin the frame actually leaves, though, with the drop taken
  // out of it first. A pool that runs off the canvas is not elevation either: at two
  // and a quarter times flat, the last row under the take was still a tenth of the way
  // to black on four of the seven presets, so the look's own ground colour was nowhere
  // visible and the shadow read as a vignette with a straight edge. The drop stays the
  // classic one, so the light still comes from where it always did.
  const r = g.blur
  const flat = Math.sqrt((4 * r * r + 4 * r) / 6)
  const dy = Math.round(r * 0.9)
  const margin = Math.min(g.ox, g.oy, g.outW - g.ox - g.vidW, g.outH - g.oy - g.vidH)
  const shadow = framed ? {
    alpha: clamp(num(opts.shadow, 0.6), 0, 1),
    sigma: Math.max(flat, Math.min(2.25 * flat, (margin - dy) / 1.7)),
    dy,
  } : null
  const borderPx = framed ? num(L('frame').border, 0) * g.outH / 1080 : 0

  // What fills the output round the take
  let bg = { kind: 'none' }
  const id = String(opts.backdrop || '')
  const blurFill = () => {
    // The take, blurred to a colour field, as the classic export makes it: shrunk to a
    // few dozen pixels, blurred about 125 px wide at 1080, luma pressed to 30 percent,
    // chroma to 80, a soft vignette. blurAmount 0.5 is exactly that.
    const fw = 2 * Math.max(8, Math.round(g.outW / 64)), fh = 2 * Math.max(5, Math.round(g.outH / 64))
    const amount = clamp(num(L('background').blurAmount, 0.5), 0, 1)
    // band: this ground is the take itself, so it is held inside a band of the take's
    // own mean at that point rather than wherever the press leaves it. The press is
    // right for a dark take and ruinous for a bright one: under a white page it made a
    // 20 px gutter a bar.
    // Half again the floor at the near end, not the floor itself: a ground sitting
    // exactly on it leaves nothing for grain and dither, and this one is wide enough
    // to want a step rather than a line.
    return { kind: 'blur', fw, fh, sigma: Math.max(2, 125 * fh / 1080) * (0.25 + 1.5 * amount),
      band: [1.5 * EDGE_FLOOR, EDGE_BLEED] }
  }
  // Bokeh is the background's own defocus given an aperture's shape, so it rides on the
  // background rather than on the finished frame: an image backdrop or the take's own
  // blurred ground. A gradient, a mesh or no background has nothing to defocus.
  const bokehDial = clamp(num(L('treatment').bokeh, 0), 0, 1)
  if (!framed) bg = aspect ? blurFill() : { kind: 'none' }
  else if (id === 'blur') bg = blurFill()
  else if (id.startsWith('img:') && ctx.imageFile) {
    const B = L('background')
    bg = { kind: 'image', file: ctx.imageFile, blur: clamp(num(B.imageBlur, 0), 0, 1), dim: clamp(num(B.imageDim, 0), 0, 1) }
  } else if (L('background').kind === 'mesh') {
    // A mesh gradient: its control points as plain numbers, drawn once per plan like
    // the still gradient is. Colours stay in sRGB, as the flat gradient's do.
    const pts = (MESHES[L('background').mesh] || MESHES.dusk).slice(0, 8)   // FS_MESH carries eight
    bg = { kind: 'mesh', p: pts.flatMap(q => [q[0], q[1], q[2]]), c: pts.flatMap(q => rgb(q[3])) }
  } else if (/^color:#?[0-9a-f]{6}$/i.test(id)) {
    const col = rgb(id.slice(6).replace('#', ''))
    bg = { kind: 'gradient', c0: col, c1: col }
    const tex = groundTexture(look)
    if (tex) bg.texture = tex
  } else {
    const pair = GRADIENTS[id] || GRADIENTS.dusk
    bg = { kind: 'gradient', c0: rgb(pair[0]), c1: rgb(pair[1]) }
  }
  if (bokehDial > 0 && (bg.kind === 'image' || bg.kind === 'blur')) bg.bokeh = bokehDial

  // The drawn frame round the take, and the take's own rect inside it. A device takes
  // the place the layout gave the take and hands the take back what is left, so the
  // composition, the margins and the shadow stay exactly where they were.
  const end0 = edgeEnd(bg)
  // the screen's corner is the device's own, floored at the window's (`corner`) so the
  // take's black corner never shows; frame.radius belongs to a take with no device
  const device = framed && !gl
    ? devicePlan(L('device'), L('frame').chrome, g, corner, end0, bg,
      { viewport: view, captured: opts.captured, crop: opts.crop, screen: opts.screen,
        ...(at ? { at: { x: at.x, y: at.y, w: at.w, h: at.h } } : {}) })
    : null
  // A group has no one device and no one screen: each member carries its own, and what
  // stands in for the take everywhere else (the grade's reach, the caption band, a title
  // card, the keys) is the box the whole set stands in.
  const group = gl ? placeGroup(G, gl, g, corner, end0, bg) : null
  const rect = group ? group.box : device ? device.screen : { x: g.ox, y: g.oy, w: g.vidW, h: g.vidH }
  const rad = group ? 0 : device ? device.screen.r : radius
  // A tilt turns the whole framed take, the device and the camera bubble on it in one
  // plane; the frame pass reads it backwards, per pixel (gl.js, FS_FRAME).
  // A take with nothing behind it is the whole output, and turning it would open black
  // wedges at the corners, which is the one thing the output never draws. Same rule as
  // the take's own arrival: it can only turn in something.
  const tilt = bg.kind === 'none' ? null : tiltPlan(num(L('frame').tilt, 0), device ? device.box : rect, g)
  // The whole group on one plane: two vanishing points is two cameras, and two cameras
  // is the thing a group exists to stop looking like.

  // Zooms on the output clock, as the classic export places them; with auto zoom and
  // none of its own, the moments prepare.js found (already on the output clock)
  let zooms = (opts.zooms || []).filter(z => z && +z.end > +z.start)
    .map(z => ({ start: clock(z.start), end: clock(z.end), scale: z.scale, x: z.x, y: z.y }))
    .filter(z => z.end > z.start)
  if (!zooms.length && opts.autoZoom && P && Array.isArray(P.autoZooms)) zooms = P.autoZooms.filter(z => z && z.end > z.start)

  // The camera bubble, over the framed take in its own fractions, as the editor places
  // it: never zoomed with the content, never outside the take. Keyframed, so where it
  // is, how big it is and what shape it is are all functions of time (camKeys, camAt).
  let cam = null
  const k = opts.camera
  if (k && k.file && k.on !== false) {
    const C = L('camera')
    // its fractions are of the take, so under a device frame it sits on the screen and
    // not on the bezel
    const base = { x: clamp(num(k.x, 0.82), 0, 1), y: clamp(num(k.y, 0.78), 0, 1),
      size: clamp(num(k.size, 0.22), CAM_MIN, CAM_MAX), rf: CAM_SHAPES[C.shape] != null ? CAM_SHAPES[C.shape] : 0.5 }
    const track = camPlan(camKeys(k.keys, base, clock), rect, L('motion').zoomEase)
    const k0 = track[0]
    cam = {
      file: k.file, track, ease: L('motion').zoomEase, ringOn: C.ring !== false,
      // Where the bubble opens, which is the whole of it on a take with no keys.
      x: k0.cx - k0.d / 2, y: k0.cy - k0.d / 2, round: k0.d * k0.rf,
      ring: C.ring === false ? 0 : Math.max(2, Math.round(k0.d * 0.016)),
      // What the camera take is decoded at (compositor/index.js, camSquare): the
      // biggest the bubble ever gets, so a key that grows it is drawn from the camera's
      // own pixels rather than upscaled from the size the take opened on.
      d: Math.max(...track.map(q => q.d)),
      camStartedAt: k.camStartedAt, screenStartedAt: k.screenStartedAt, gaps: k.gaps || [],
    }
  }

  // What is drawn on the recording itself, placed once: sizes for the finished frame
  // from px, the finished pixels per content pixel before any zoom
  const px = rect.h / (ch * inner.h)
  const drawn = markList(opts.marks, P && P.marks)
  const F = L('focus'), Cu = L('cursor')
  const pm = Marks.planMarks(drawn, { W: cw, H: ch, px, clock, span, zooms, ease: L('motion').zoomEase,
    look: { dim: F.dim, lift: F.lift, loupe: F.loupe, arrow: F.arrow } })
  const erase = P && P.erase ? Marks.planErase(P.erase.spans, P.erase.plates,
    { src: { w: srcW, h: srcH }, crop: { x: cx, y: cy }, content: { w: cw, h: ch }, clock, end, span }) : []
  // an empty track is the look's cursor switched off, whatever the take has
  const raw = Array.isArray(opts.pointer) ? opts.pointer : null
  const points = raw && !raw.length ? null : P && P.pointer ? P.pointer.points : raw
  const pointer = points ? Marks.planPointer(points, { W: cw, H: ch, clock, crop: c, scale: P && P.pointer ? P.pointer.scale : null,
    span, px, zooms: pm.zooms, size: Cu.size, ripple: Cu.ripple, style: Cu.style,
    // The device the take was of, so a 44 point touch target is measured through its own
    // screen rather than guessed against the frame. Written onto the document by a
    // capture of a simulator (ui/agent-bridge.js simOnDoc); absent on every other take,
    // where the disc falls back to the click ripple's own size.
    device: opts.screen ? { screen: opts.screen, viewport: opts.viewport } : null }) : null
  const marks = { ...pm, erase, pointer }
  // Each member of a group carries its own marks, and they go through this planner, on
  // that member's own pixels, at that member's own drawn size. A lift is fitted to the
  // capture it was drawn on and a step badge is sized against the screen it lands on, so
  // nothing in the mark planner learns that there is more than one capture. No zoom and
  // no pointer: a group is a still of several things, and neither travels.
  // A member's mark with no span runs the whole clip. A group is a still of several
  // things, so a mark on one of them has no when to give, and planned on the output
  // clock with neither a start nor an end it would plan to an empty track and draw
  // nothing at all. Same rule as the shot document's own timed().
  const wholeClip = list => (list || []).filter(Boolean)
    .map(m => (m.start == null && m.end == null ? { ...m, start, end } : m))
  const gmarks = group ? group.members.map((m, i) => ({
    // The take's own marks belong to the first member: a shot's src, its crop and its
    // marks are the capture it started as, and a second capture standing beside it does
    // not move them. Dropped here they would be planned, stored and never drawn.
    ...Marks.planMarks(i === 0 ? [...drawn, ...wholeClip(markList(m.rawMarks, null))] : wholeClip(markList(m.rawMarks, null)),
      { W: m.crop.w, H: m.crop.h, px: m.rect.h / m.crop.h,
        clock, span, zooms: [], ease: L('motion').zoomEase,
        look: { dim: F.dim, lift: F.lift, loupe: F.loupe, arrow: F.arrow } }),
    erase: [], pointer: null })) : null
  // What the edit hides, on the source clock, for the one transition that shows the
  // material a cut removed (cutPoints). The marks themselves are on the output clock by
  // now, and the removed material has no time there at all.
  const hidden = [
    ...(opts.marks || []).filter(m => m && (m.kind === 'redact' || m.kind === 'blur') && +m.end > +m.start).map(m => [+m.start, +m.end]),
    ...((P && P.erase && P.erase.spans) || []).map(q => [+q.a, +q.b]),
  ]
  // Treatment: the grade and the lens over the finished frame, as plain numbers in
  // export pixels. Null while the look asks for none of it, so the pass is skipped and
  // a default look draws what it drew before treatment existed.
  const T = L('treatment')
  const lv = T.autoLevel && P && P.levels && P.levels.hi > P.levels.lo ? [P.levels.lo, P.levels.hi] : null
  const bright = clamp(num(T.brightness, 0), -1, 1)
  const contrast = clamp(num(T.contrast, 0), -1, 1)
  const sat = clamp(num(T.saturation, 0), -1, 1)
  const tintAmount = clamp(num(T.tintAmount, 0), 0, 1)
  const haze = clamp(num(T.haze, 0), 0, 1)
  // The dial is how many fall-offs, not the fall-off itself. One of them is the blur
  // ground's own cos^4 at ffmpeg's angle 0.4 (gl.js fillAt), which was the right shape
  // to hold the ground and the frame to one fall-off and the wrong size for a dial: at
  // the top of the range it took 28 percent off the frame's furthest corner and 15 off
  // the take's, so a look whose identity is a vignette had nothing left to ask for and
  // Noir's 0.35 measured 6. VIG_REACH is what the top of the dial is worth in those
  // fall-offs. It scales the mix and nothing else, so the share the blur ground divides
  // back out stays exactly the share the treatment puts on, and the ground and the take
  // still fall off together and once.
  const vignette = clamp(num(T.vignette, 0), 0, 1) * VIG_REACH
  const soft = clamp(num(T.blur, 0), 0, 1)
  const bloom = clamp(num(T.bloom, 0), 0, 1)
  const halation = clamp(num(T.halation, 0), 0, 1)
  const aberration = clamp(num(T.aberration, 0), 0, 1)
  const glow = Math.max(bloom, halation)
  // The take's own white point, in the pixels the glow's bright pass reads, which are
  // the frame before the grade: the same place levels.js measured, and prepare.js now
  // measures it for a look that glows as well as for one that auto levels. A take
  // nobody could measure, or one that already fills the range, ends where the range
  // ends, and then nothing in it is above its own white.
  const white = P && P.levels && P.levels.hi > P.levels.lo ? P.levels.hi : 1
  const black = P && P.levels && P.levels.hi > P.levels.lo ? P.levels.lo : 0
  // The take's own two ends where the grade sees them, which is after auto level: a
  // measured take has already been stretched onto 0 and 1 by the time the grade runs,
  // so its ends are the range's; an unmeasured one is taken to fill the range, which is
  // the same two numbers. Everywhere else they are what levels.js measured, and the
  // shoulder and the toe are pinned to them: they say where the picture actually ends,
  // so the curve knows what it may bend and what it must leave alone. prepare.js
  // measures them for anything that grades, not only for auto level and the glow.
  const gWhite = lv ? 1 : white, gBlack = lv ? 0 : black
  const line = v => (v - 0.5) * (1 + contrast) + 0.5 + bright
  const treat = lv || bright || contrast || sat || tintAmount || haze || vignette || soft || glow || aberration ? {
    level: lv,
    // the dials ffmpeg eq takes: 1 is neutral for contrast and saturation, brightness adds
    bright, contrast: 1 + contrast, sat: 1 + sat,
    // and the two ends of that line rolled in rather than cut off, each pinned to the
    // take's own end. Without these a contrast over about 0.06 takes a white app page
    // and everything near it to 255 together, which is every row separator, card edge
    // and hairline in the product gone; with them but pinned to the range instead of to
    // the take, the same hairlines survived the clip and died in the shoulder. The toe
    // is the same argument at the bottom, where a hairline on a dark page goes black.
    shoulder: rollOff(line(1), line(gWhite), 1 + contrast),
    toe: rollOff(1 - line(0), 1 - line(gBlack), 1 + contrast),
    tint: rgb(T.tint || '#F0A93C'), tintAmount, haze, vignette,
    // the whole frame softened: sigma in export pixels, about 26 of them at 1080 at full
    blur: soft * 0.024 * g.outH,
    bloom, halation,
    // What the glow is allowed to read: what is at the take's own white point, a shade
    // under it. The threshold used to come off the dial alone (0.9 down to 0.45), which
    // put a page white at 254 deep inside the bright pass, so halation's warm wide end
    // came back over every grey glyph on the page as a pink collar. It is one to four
    // 8-bit levels under the measured white instead, one at a light touch and four at
    // the top of the dial, and the strength is still the dial's alone. prepare.js
    // measures that white for a look that glows and not only for one that auto levels,
    // which is what this was missing: unmeasured it fell back to 1, so a dark-mode take,
    // whose highlights top out well under white, had no bloom and no halation at any
    // setting. Bloom and halation share the bright pass, so the louder of the two sets it.
    glowThresh: clamp(white - (1 + 3 * glow) / 255, 0.05, 0.995),
    // Aberration: how far the channels part at the corners, in export pixels. 3 px at
    // 1080 at the top of the dial, so the settings anyone will actually use are a
    // fraction of a pixel and read as a fringe on an edge, not as three pictures.
    aberration: aberration * 3 * g.outH / 1080,
  } : null
  const film = clamp(num(L('grain').film, 0), 0, 1)

  // The caption band is the room the layout left under the take, and a device sits in
  // the take's own place rather than beside it, so the band is measured from the take
  // and not from the screen inside the device. Laid out from the screen, a 50 px caption
  // landed on a laptop's foot. Everything else a text reads (a lower third rides the
  // product) still goes by the screen.
  const capBox = framed ? (device || group ? { x: g.ox, y: g.oy, w: g.vidW, h: g.vidH } : { ...rect }) : null
  const text = Text.planText(opts, { clock, span, W: g.outW, H: g.outH, box: framed ? { ...rect } : null,
    capBox, prepared: P, zooms: pm.zooms, still, light: !!end0.light })

  return {
    W: g.outW, H: g.outH, fps, frames, span, keep, start, end,
    // For a group these three describe the group: the box it stands in, at the pixels it
    // would take to draw every member at its own density. They are what says how big a
    // still of it is worth writing (compositor/index.js shotScale reads crop.w / rect.w),
    // and each member's real source, crop and content are in spec.group.
    src: gl ? { w: boxW, h: boxH } : { w: srcW, h: srcH },
    crop: gl ? { x: 0, y: 0, w: boxW, h: boxH } : { x: cx, y: cy, w: cw, h: ch },
    content: gl ? { w: boxW, h: boxH, px: rect.h / boxH } : { w: cw, h: ch, px },
    framed, rect, radius: rad, shadow, inner, device, tilt,
    /**
     * More than one capture in one picture, each with its own shell, its own pixels and
     * its own marks, sharing one ground, one light, one grade and one plane. Null for
     * the ordinary one-capture edit, which is every export: a group of one is a take.
     * Each member is { file, rect, radius, device, src, crop, content, inner, marks, mm },
     * which is the same set of names the take itself answers to, so the frame pass draws
     * a member with the code that draws a take rather than with code of its own.
     */
    group: group ? group.members.map((m, i) => ({
      file: m.src, rect: m.rect, radius: m.radius, device: m.device, mm: +m.mm.toFixed(2),
      src: m.srcSize, crop: m.crop, content: { w: m.crop.w, h: m.crop.h, px: m.rect.h / m.crop.h },
      inner: { x: 0, y: 0, w: 1, h: 1 }, marks: gmarks[i],
    })) : null,
    // The edge floor, and the hairline that meets it where nothing else does: about a
    // pixel and a quarter at 1080, scaled with the output so it stays a hairline at 4K.
    // No ground, no contract: a take in its own shape is the whole output, and a line
    // round that is a line round the video.
    // A device frame answers for the take's edge itself: the bezel is a tone Fetch
    // chose, held off the ground by the same floor, and it carries a hairline on both
    // sides of itself (devicePlan). A second line just inside the screen would be a
    // line drawn on a line.
    edge: bg.kind === 'none' || device ? null : { floor: EDGE_FLOOR, px: Math.max(1, g.outH * 1.25 / 1080), ...end0 },
    border: borderPx > 0 ? { px: borderPx, color: rgb(L('frame').borderColor || '#FFFFFF') } : null,
    bg, zooms: pm.zooms, ease: L('motion').zoomEase, cam, marks,
    cut: cutPoints(keep, L('motion').cutTransition, fps, hidden),
    // The take can only arrive in something. Where the look puts nothing behind it the
    // take is the whole output, so there is nowhere to rise from and dimming the picture
    // instead would be a fade from black, which is motion.fadeIn and the person's call.
    reveal: L('motion').reveal === 'none' || bg.kind === 'none' ? null : { in: REVEAL_IN, out: REVEAL_OUT },
    text: text.phrases.length || text.cards.length || text.labels.length || text.still ? text : null,
    // The keys as they were pressed, over the finished frame rather than on the take, so
    // a zoom neither carries nor scales them (marks.js planKeys). Laid out against the
    // same box the captions are, so the two never land on each other.
    keys: Marks.planKeys(opts.keys, { W: g.outW, H: g.outH, box: framed ? { ...rect } : { x: 0, y: 0, w: g.outW, h: g.outH },
      capBox, caption: opts.captions ? (opts.captionStyle || {}) : null, clock, span,
      place: L('keys').place, size: L('keys').size, show: L('keys').show !== false }),
    // the schema's own default: 0.5 is a 180 degree shutter, the film standard
    motionBlur: clamp(num(T.motionBlur, 0.5), 0, 1),
    treat,
    // Film grain: its strength, and a cell sized on the output so a look grains the
    // same at 720p and at 4K. 0.055 at full is a little over three times the still
    // grain the classic blur ground carries (noise=c0s=3), which is what a moving
    // grain needs to read at all without eating the text under it.
    grain: film > 0 ? { amp: film * 0.055, cell: Math.max(1, g.outH * 1.4 / 1080) } : null,
    // and the ground's own tooth under it. A roll of film is in front of the whole
    // frame, so where a look has grain the film is what the frame's texture is, and the
    // ground's tooth cannot stand above what that grain leaves on the picture: a wall
    // three times grainier than the plate hanging on it is a mat, not a surface, and it
    // is exactly backwards on the two looks whose identity is the grain. Measured at the
    // end of the range, because the picture in a screen recording is an app page and
    // that is where the film's own midtone weighting leaves least. Where a look asks for
    // no film there is nothing in front of anything: the tooth is all the ground has and
    // it keeps its three levels, and a recording of a screen is not given grain nobody
    // asked for. Never under a third either, which is what keeps it clear of the dither.
    // A ground with a texture of its own has its surface already, and it holds still: a
    // moving tooth over a sheet of paper is the boiling this texture exists to end. A
    // photograph drawn sharp is the same case (Linen Bone's weave carried three levels of
    // tooth that were new every frame, which read as noise on cloth and which the
    // encoder then threw away); a blurred one is a soft field again and keeps it.
    tooth: bg.texture || (bg.kind === 'image' && !(bg.blur > 0) && !(bg.bokeh > 0)) ? 0 : film > 0 ? clamp(film * 0.055 * GRAIN_ENDS / Math.sqrt(6) / TOOTH_SIGMA, 0.3, 1) : 1,
    // How many output frames one draw of that texture lasts. Both are seeded by the
    // frame index, which is what lets any frame draw alone, and at 60 fps that meant a
    // completely new field of grain sixty times a second: the same look boiling twice
    // as fast at 60 as at 30, and noise no frame can predict from the one before it,
    // which is the first thing an encoder spends nothing on. At CRF 23 a fifth of what
    // was drawn arrived in the file. So the roll is exposed at the take's own rate up
    // to 30 a second and no faster, and a frame's seed is still its own index and
    // nothing else. 30 rather than a projector's 24 because it divides both output
    // rates: at 60 every draw lasts exactly two frames, at 30 it lasts one, and the
    // grain of a 30 fps export is what it always was.
    grainHold: Math.max(1, Math.round(fps / 30)),
    // A clip meant to autoplay and repeat: the loop's length in output frames, which is
    // the index gl.js seeds the grain, the tooth and the dither by (loopIndex). A caller
    // that counts frames on past the end, which a stage playing the clip round again
    // does, then draws the frames the file holds rather than a second cycle of fresh
    // noise. 0 where the look does not ask for a loop, and the index passes straight
    // through.
    loop: L('motion').loop ? frames : 0,
    fadeIn: Math.max(0, num(opts.fadeIn, 0)), fadeOut: Math.max(0, num(opts.fadeOut, 0)),
    dither: L('grain').dither !== false,
  }
}

// ── arriving, leaving, and meeting at a cut ─────────────────────────────
//
// Everything here is a function of output time. A transition is not a filter over two
// rendered frames and never reads the frame before: a dissolve is two source times and
// a weight, all three solved from t, which is what lets the export render out of order
// and the stage scrub straight to a frame in the middle of one.
//
// The curve is the same quintic the zoom rides (Overlays.easeS), with no warp, because
// a cut is symmetric in a way a zoom is not: unwarped, the weight is exactly 0.5 at the
// instant the timeline names, so the dissolve crosses over on the cut and the dip is at
// its darkest there. Called with p in [0, 1] only; outside it the polynomial is not a
// curve, and cutAt is what keeps p inside.
const S = Overlays.easeS, dS = Overlays.easeSVel

// The take arriving and leaving: a third of a second up into its frame, a little less
// back out. 10 px at 1080 and three and a half percent, which is the distance a card
// already travels (Text.frameMove) rather than a second opinion about it.
const REVEAL_IN = 0.36, REVEAL_OUT = 0.32, REVEAL_K = 0.035, REVEAL_PX = 10
// A cut transition, in seconds: half the window either side of the boundary for the
// dissolve and the dip, and the whole of the push, which lives after the cut alone.
const CUT_HALF = 0.1, PUSH_AFTER = 0.35, PUSH_AMOUNT = 0.06

/**
 * Where the cuts land on the output clock and how long each transition may be there.
 *   t  the boundary, the output time the piece after the cut starts at
 *   d  half the window (crossfade, dip) or the whole of it (zoom), whole frames
 *   a  the take time the outgoing piece ends at, b the one the incoming piece starts at
 *
 * A dissolve is made of the frames the cut removed: the outgoing side runs on past its
 * end into the gap and the incoming side starts inside it, so no output time is added
 * and nothing the viewer already saw is shown twice. That caps it at the gap, and at
 * half of either piece, so a cut with nothing behind it simply stays hard. Under two
 * frames it is dropped: a transition the eye reads as a glitch is worse than the cut.
 *
 * And at whatever the edit starts hiding inside that gap (`hidden`, source seconds: a
 * redaction, a blur, the Mac's pointer lifted out). Each side reads its marks from its
 * own side of the cut (framePlan), which covers everything already hidden where the cut
 * falls; what no instant of the output clock can speak for is a mark that begins inside
 * the removed material, and the window stops short of those.
 */
// ra and rb are the rates the two sides run at. Every length here is output seconds
// and every span of material is source seconds, so the two are only ever compared
// through the rate: a dissolve on a 4x section eats four source seconds of the gap
// for each output second it lasts, and given the same gap it may last a quarter as
// long. Without that division a fast section would reach for material the cut did not
// remove and show the viewer a moment twice.
function cutRoom(hidden, a, b, ra, rb) {
  let room = Infinity
  for (const [h0, h1] of hidden || []) {
    // the outgoing side plays on from a, so nothing may begin hiding inside its reach
    if (h0 >= a && h0 <= b) room = Math.min(room, (h0 - a) / ra)
    // and the incoming side starts before b, so nothing may stop hiding inside its reach
    if (h1 >= a && h1 <= b) room = Math.min(room, (b - h1) / rb)
  }
  return room
}
function cutPoints(keep, kind, fps, hidden) {
  if (!kind || kind === 'none' || !keep || keep.length < 2) return null
  const points = []
  let acc = 0
  for (let i = 0; i + 1 < keep.length; i++) {
    acc += Timeline.outSpan(keep[i])
    const gap = keep[i + 1][0] - keep[i][1]
    // Two ranges meeting with nothing between them are one piece of the take that a
    // speed change split (Timeline.applyRates), not a cut. Nothing was removed there,
    // so there is nothing to transition across and a dip would be a flicker in the
    // middle of a continuous shot.
    if (!(gap > 1e-6)) continue
    const ra = Timeline.rateEnds(keep[i])[1], rb = Timeline.rateEnds(keep[i + 1])[0]
    const lenA = Timeline.outSpan(keep[i]), lenB = Timeline.outSpan(keep[i + 1])
    const want = kind === 'zoom' ? Math.min(PUSH_AFTER, lenB)
      : Math.min(CUT_HALF, lenA / 2, lenB / 2, kind === 'crossfade'
        ? Math.min(gap / Math.max(ra, rb), cutRoom(hidden, keep[i][1], keep[i + 1][0], ra, rb)) : Infinity)
    const f = Math.floor(want * fps + 1e-6)
    if (f < 2) continue
    points.push({ t: acc, d: f / fps, a: keep[i][1], b: keep[i + 1][0], ra, rb })
  }
  return points.length ? { kind, points } : null
}

// The cut t is inside, with its progress through the window: 0 to 1 across the whole
// window, so p is 0.5 exactly on the boundary for the two symmetric kinds.
function cutAt(spec, t, kind) {
  const c = spec.cut
  if (!c || (kind && c.kind !== kind)) return null
  for (const b of c.points) {
    if (c.kind === 'zoom') { if (t >= b.t && t < b.t + b.d) return { b, p: (t - b.t) / b.d } }
    else if (t > b.t - b.d && t < b.t + b.d) return { b, p: (t - b.t + b.d) / (2 * b.d) }
  }
  return null
}

/**
 * The take's time at output time t, and the other side of a dissolve: { s, s2, mix }.
 * Both sides move forward at the take's own rate, so a dissolve is two clips playing,
 * not two frozen frames. Away from a dissolve s2 is null and mix 0.
 */
function srcPair(spec, t) {
  const c = cutAt(spec, t, 'crossfade')
  if (!c) return { s: srcAt(spec.keep, t), s2: null, mix: 0 }
  const dt = t - c.b.t
  // before the boundary the outgoing side is what srcAt already says; after it, that
  // same piece carried on into the gap. Each side carries on at its own piece's rate,
  // or a dissolve out of a 4x montage plays that half of itself at 1x and the cut is
  // the one place in the edit that visibly stalls.
  return { s: c.b.a + dt * (c.b.ra || 1), s2: c.b.b + dt * (c.b.rb || 1), mix: S(c.p) }
}

// The cut's push, as a magnification and its rate: the piece after a cut lands a little
// tight and settles back out. Never under 1, so the window never asks for more picture
// than the frame has, which is the one way a transition could put black at an edge.
function pushAt(spec, t) {
  const c = cutAt(spec, t, 'zoom')
  if (!c) return [1, 0]
  return [1 + PUSH_AMOUNT * (1 - S(c.p)), -PUSH_AMOUNT * dS(c.p) / c.b.d]
}

// How wide the shutter may open at t. A push lands the piece after a cut tight, so the
// view jumps on the boundary, and an exposure straddling it would smear the cut itself:
// thirty-two taps of a six percent zoom on the first frame of the new piece. A shutter
// cannot see both sides of an edit, so it is held to the side its own frame is on. The
// other transitions leave the view continuous and this never touches them.
// Held to just inside the frame's own side of it, not up to it: cutAt reads the
// boundary itself as already pushed, so an exposure ending exactly there put the whole
// six percent jump on the last frame before the cut. Only the frames whose own time
// lands on or after the boundary are pushed, and a boundary is rarely on a frame.
const CUT_EPS = 1e-6
function shutterHalf(spec, t, half) {
  if (!spec.cut || spec.cut.kind !== 'zoom') return half
  for (const b of spec.cut.points) if (Math.abs(t - b.t) < half) return Math.max(0, Math.abs(t - b.t) - CUT_EPS)
  return half
}

/**
 * How the take sits at output time t: { k, dy, alpha, shadow }, as the frame pass takes
 * it. A title card's landing where there is one (Text.frameMove), the look's own open
 * and close where there is not, and a cut's dip over the top. The card wins because it
 * is the reason the take is moving at all; the two are never added.
 */
function takeMove(spec, t) {
  const mv = Text.frameMove(spec.text, t, spec.H)
  const rv = spec.reveal, tp = spec.text
  if (rv && !(tp && tp.reveal) && t < rv.in) {
    const e = S(clamp(t / rv.in, 0, 1))
    mv.k *= 1 - REVEAL_K * (1 - e)
    mv.dy += REVEAL_PX * spec.H / 1080 * (1 - e)
    // opaque well before it lands: what arrives is a take settling, not a take fading in
    mv.alpha *= S(clamp(t / (rv.in * 0.6), 0, 1))
    mv.shadow *= e
  }
  if (rv && !(tp && tp.close) && t > spec.span - rv.out) {
    const e = S(clamp((t - (spec.span - rv.out)) / rv.out, 0, 1))
    mv.k *= 1 - REVEAL_K * e
    mv.dy += REVEAL_PX * spec.H / 1080 * e
    mv.alpha *= 1 - S(clamp((t - (spec.span - rv.out * 0.6)) / (rv.out * 0.6), 0, 1))
    mv.shadow *= 1 - e
  }
  const dip = cutAt(spec, t, 'dip')
  if (dip) {
    // down through the look's own ground and back, darkest on the boundary itself, so
    // the frame the cut jumps on is the one frame the take is not on screen
    const level = 1 - S(1 - Math.abs(2 * dip.p - 1))
    mv.alpha *= level; mv.shadow *= level
  }
  return mv
}

// The take's time output time t shows. Ranges are half open here: the frame at the
// instant a cut closes shows the moment after the cut, not the last moment before it
// (Timeline.srcTime keeps range ends inclusive for its round trip). A range carrying a
// rate walks its own closed form, so a 4x piece advances four source seconds an output
// second and every frame still solves from t alone.
function srcAt(keep, t) {
  let acc = 0
  for (let i = 0; i < keep.length; i++) {
    const seg = keep[i], len = Timeline.outSpan(seg)
    if (t < acc + len - 1e-9 || i === keep.length - 1) {
      return Math.min(seg[1], Timeline.srcIn(seg, Math.max(0, t - acc)))
    }
    acc += len
  }
  return t
}

// How fast the take itself is running at output time t, source seconds per output
// second. The cut window and the dissolve both measure in output seconds and both
// read source material, so both have to ask.
const rateAt = (keep, t) => Timeline.rateAt(keep, t)

// What a zoom shows at output time t, as fractions of the cropped frame, with the cut's
// push over it. The push tightens the window about its own centre, so what it asks for
// is always inside what the zoom already showed and no clamp is needed.
function viewAt(spec, t) {
  const z = Overlays.zoomView(spec.zooms, t, spec.ease)
  const [m] = pushAt(spec, t)
  if (m === 1) return [z.x, z.y, z.w, z.h]
  const w = z.w / m, h = z.h / m
  return [z.x + (z.w - w) / 2, z.y + (z.h - h) / 2, w, h]
}

// How fast a pixel of content is travelling on the output at time t, in output pixels
// per second. The analytic derivative of the same window, not a difference between two
// frames: the rule is that a frame draws from its own time alone, and this is what the
// shutter reads. Same four corners travel() walks, to first order in the rates.
function travelRate(spec, t) {
  const v = Overlays.zoomWindow(spec.zooms, t, spec.ease)
  const [m, dm] = pushAt(spec, t)
  // only the rates and the window's size are read below, so the push is chained into
  // those alone: where its centre sits does not change how fast anything is moving
  let { w: vw, h: vh, dx: vdx, dy: vdy, dw: vdw, dh: vdh } = v
  if (m !== 1) {
    // the same tightening viewAt applies, differentiated: a push settling out moves the
    // picture, so the shutter has to see it as travel like any other
    const w2 = vw / m, h2 = vh / m
    const dw2 = (vdw * m - vw * dm) / (m * m), dh2 = (vdh * m - vh * dm) / (m * m)
    vdx += (vdw - dw2) / 2; vdy += (vdh - dh2) / 2
    vw = w2; vh = h2; vdw = dw2; vdh = dh2
  }
  if (!(vw > 0)) return 0
  const { w, h } = spec.rect
  let most = 0
  for (const u of [0, 1]) for (const c of [0, 1]) {
    const dx = (vdx + u * vdw) / vw * w, dy = (vdy + c * vdh) / vh * h
    most = Math.max(most, Math.hypot(dx, dy))
  }
  return most
}

// How far a pixel of content travels on the output between two views
function travel(spec, a, b) {
  const { w, h } = spec.rect
  let most = 0
  for (const u of [0, 1]) for (const v of [0, 1]) {
    // the content under this corner of the frame in view a, and where view b puts it
    const px = a[0] + u * a[2], py = a[1] + v * a[3]
    const dx = ((px - b[0]) / b[2] - u) * w, dy = ((py - b[1]) / b[3] - v) * h
    most = Math.max(most, Math.hypot(dx, dy))
  }
  return most
}

/**
 * One output frame, at output time t (seconds): { t, s, s2, mix, view0, view1, taps,
 * speed, fade, camT }. s is the take's own time the frame shows; through a dissolve s2
 * is the other side's and mix is how much of it there is, 0 on one side of the cut and
 * 1 on the other. view0 and view1 bound the zoom's travel across the shutter; taps is
 * how many samples blur it, scaled with how far a pixel moves so a fast glide never
 * shows separate ghost copies of text.
 */
function framePlan(spec, t) {
  const { s, s2, mix } = srcPair(spec, t)
  let view0 = viewAt(spec, t), view1 = view0, taps = 1
  // What smears is the zoom's own speed at this instant, which is the derivative of the
  // ease. The dial is the shutter alone: motionBlur 1 is 360 degrees, 0.5 the film
  // standard 180. So a fast pass smears, a settle does not, and neither asks for a dial
  // to be turned up. Nothing at rest blurs, because the ease leaves and arrives with
  // zero velocity, so every held frame stays byte for byte what it was. A cut's push
  // moves the picture with no zoom in the edit at all, so it opens the shutter too.
  //
  // Speed does not need a second dial here, and that is worth saying because it looks
  // like it should. What the shutter must see is velocity per OUTPUT second, and every
  // zoom was placed on the output clock before this ran (prepare, clock(z.start)), so a
  // zoom inside a 4x piece is already a quarter as long in output seconds and its ease
  // already runs four times as fast. Read the rate here as well and the blur would be
  // scaled twice. The rate is on the frame plan (fp.rate) for anything that measures in
  // source seconds, and the one thing that genuinely does is the dissolve (srcPair).
  const moving = spec.zooms.length > 0 || (spec.cut && spec.cut.kind === 'zoom')
  const speed = moving ? travelRate(spec, t) : 0
  if (spec.motionBlur > 0 && moving) {
    const half = shutterHalf(spec, t, spec.motionBlur / spec.fps / 2)
    const a = viewAt(spec, t - half), b = viewAt(spec, t + half)
    // the chord is exact for the two ends of the exposure, the rate is right through a
    // turn in the middle of it; the longer of the two is what the samples have to cover
    const px = Math.max(travel(spec, a, b), speed * 2 * half)
    if (px > 0.75) { view0 = a; view1 = b; taps = Math.max(2, Math.min(32, Math.ceil(px / 1.5))) }
  }
  const fi = spec.fadeIn > 0 ? clamp(t / spec.fadeIn, 0, 1) : 1
  const fo = spec.fadeOut > 0 ? clamp((spec.span - t) / spec.fadeOut, 0, 1) : 1
  const camT = spec.cam ? Timeline.camTime(spec.cam, s) : null
  // Where the bubble is this frame. On the output clock, like the zooms: the bubble is
  // a thing placed in the video, not a moment of the camera take.
  const bubble = spec.cam ? camAt(spec.cam, t) : null
  // Each side of a dissolve reads the marks at its own side of the cut. Both sides are
  // playing inside the material the cut removed, and a mark is placed on the output
  // clock, where that material has no time at all: a redaction keyed to output time has
  // already ended on the boundary while the outgoing side runs on past it, so the frames
  // of the dissolve showed the secret. The outgoing side takes the last instant before
  // the cut and the incoming one the first instant after it, which is where their own
  // source times went when the clock closed the gap. cutPoints keeps the window clear of
  // anything the edit starts hiding inside the gap, which is the part no instant of the
  // output clock can speak for.
  const xd = mix > 0 ? cutAt(spec, t, 'crossfade') : null
  const marks = spec.marks ? Marks.at(spec.marks, xd ? Math.min(t, xd.b.t - CUT_EPS) : t) : null
  const marks2 = spec.marks && xd ? Marks.at(spec.marks, Math.max(t, xd.b.t)) : null
  // A member's marks read at this instant exactly as the take's do, through the same
  // function: a group is still one frame of one plan and still draws alone.
  const group = spec.group ? spec.group.map(m => Marks.at(m.marks, t)) : null
  return { t, s, s2, mix, view0, view1, taps, speed, rate: rateAt(spec.keep, t), fade: fi * fo, camT, bubble,
    marks, ...(marks2 ? { marks2 } : {}), ...(group ? { group } : {}), move: takeMove(spec, t) }
}

// ── which source frames ─────────────────────────────────────────────────
// The last frame at or before u in a sorted list of presentation times, or 0
function holdIndex(pts, u) {
  if (!pts.length || u < pts[0]) return 0
  let lo = 0, hi = pts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (pts[mid] <= u + 1e-6) lo = mid; else hi = mid - 1
  }
  return lo
}

/**
 * The frames of a stream an export reads, sample and hold: output frame n shows the
 * latest frame whose time is at or before the moment it maps to (the spike's rule, 200
 * of 200 on a jittered variable-rate counter). A native take writes a frame only when
 * the screen changes, so this is what keeps a still screen still and the picture on
 * the sound's clock across cuts.
 *   pts     the stream's presentation times, sorted, seconds
 *   timeOf  output time to the stream's time, or null where it shows nothing
 * Returns { pick: index per output frame (-1 none), runs: [[i0, i1]] index ranges to
 * decode, in order }. Frames between two needed ones closer than `gap` are decoded and
 * skipped rather than starting a new range, and there are never more than maxRuns
 * ranges: each is a term of ffmpeg's select expression, whose parser gives up between
 * 100 and 150 (an edit with dead air removed can have that many cuts).
 */
function frameMap(pts, frames, timeOf, gap = 12, maxRuns = 64) {
  const pick = new Int32Array(frames).fill(-1)
  for (let n = 0; n < frames; n++) {
    const u = timeOf(n)
    if (u != null) pick[n] = holdIndex(pts, u)
  }
  const used = [...new Set(pick)].filter(i => i >= 0).sort((a, b) => a - b)
  const runs = []
  for (const i of used) {
    const last = runs[runs.length - 1]
    if (last && i - last[1] <= gap) last[1] = i
    else runs.push([i, i])
  }
  // too many: join the two runs with the fewest frames between them, and again
  while (runs.length > maxRuns) {
    let best = 1
    for (let k = 2; k < runs.length; k++) if (runs[k][0] - runs[k - 1][1] < runs[best][0] - runs[best - 1][1]) best = k
    runs[best - 1][1] = runs[best][1]
    runs.splice(best, 1)
  }
  return { pick, runs }
}

// The take's frames for a plan
function screenFrames(spec, pts) {
  return frameMap(pts, spec.frames, n => srcPair(spec, n / spec.fps).s)
}
// And the other side of every dissolve: nothing at all except through a transition, so
// the second decode is a few runs of a few frames each and stops after the last of them
function crossFrames(spec, pts) {
  return frameMap(pts, spec.frames, n => srcPair(spec, n / spec.fps).s2)
}
// The camera's frames: its own clock, which starts late and runs through pauses
function cameraFrames(spec, pts) {
  return frameMap(pts, spec.frames, n => Timeline.camTime(spec.cam, srcAt(spec.keep, n / spec.fps)))
}

module.exports = { prepare, cropPx, framePlan, camAt, srcAt, rateAt, srcPair, viewAt, travel, engineFor, unsupported, holdIndex, frameMap, screenFrames, crossFrames, cameraFrames, cutPoints, takeMove, rgb, markKey, edgeFor, SHELL, realMM, groupLayout, GROUP_MAX, MM_DESK, MM_HAND, barText, groundTexture }
