// Three visual directions for one product, meant to be shown side by side.
//
// Fetch ships seven looks and every one of them is defensible, which is the problem:
// somebody opening the Look tab is asked to have an opinion about padding and grain
// before they have one about what the picture is for. A direction answers the other
// question first, and there are three of them because one is not a choice and seven is
// a scroll.
//
// The first is derived. It takes the product's own sampled colours and the face the
// product ships, so the frame reads as a piece of the thing itself. Doing that fixes
// three axes without ever saying so out loud, and the other two directions are what
// comes of turning each of them over:
//
//   ground   the product's own colour   a warm light on a deep sweep   bare print stock
//   tone     whichever one it is        the other one                  light, always
//   type     the product's own face     a face that is nobody's        a serif
//
// Two arbitrary alternatives beside a derived one is a menu, and somebody picks by the
// sound of the names. Two deliberate opposites is a choice, and the `why` on each says
// which job it is the right answer to.
//
// Pure: no filesystem, no Electron, no DOM. The colours arrive already sampled and the
// fonts already found (ui/project-fonts.js fontsIn); both of those are somebody else's
// job, and both of them are allowed to come back empty.

const tokens = require('./compositor/tokens')
const L = require('./look')

// The colour rule ui/look.js check() applies, run here instead of there. A patch built
// out of a half-sampled palette has to reach validate() already clean, because a colour
// validate has to repair comes back as a warning, and a direction that warns about
// itself is not a direction.
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i
function hex(v, fallback = null) {
  const m = typeof v === 'string' ? v.trim().match(HEX) : null
  if (!m) return fallback
  const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1]
  return '#' + h.toUpperCase()
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

// Which theme a ground belongs to. 0.45 is where ui/look.js toClassic already decides a
// background has gone light enough to turn white captions to ink, and a second threshold
// that disagreed with the first would put dark letters on a dark shell.
const toneOf = bg => (L.luma(bg) > 0.45 ? 'light' : 'dark')
const other = tone => (tone === 'dark' ? 'light' : 'dark')

// How far apart two colours really are, as a ratio rather than as a difference.
// A difference of luma is useless at the dark end, where a near-black and the shell it
// sits on are both within a hundredth of zero and read as identical while measuring as
// far apart. Measured on the two cases this guards: a sampled #111111 on the dark shell
// and a sampled white on the bone one come out at 1.23 and 1.29, while the house text
// each theme already carries sits at 7.56 and 4.44.
const contrast = (a, b) => {
  const x = L.luma(a), y = L.luma(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
// Between WCAG's floor for large text and its floor for body text. Both house defaults
// clear it; neither invisible case comes close.
const READABLE = 4

// Fetch's own ground, for the case where nothing was sampled. It is the dark theme's own
// ink and the schema's own background default, so the honest empty answer is the house
// answer rather than a fourth opinion invented here.
const HOUSE = tokens.THEMES.dark.ink
// The stock ui/looks/mono-print.json prints on, and a second one for the rare product
// whose own ground is already that colour.
const STOCK = '#F2EFE9'
const STOCK_ALT = '#E9E4DA'
// Direction two drops the product's voice on purpose, so it cannot use the product's
// face and it cannot use Fetch's either: SF Pro beside a Mac screenshot is the frame
// agreeing with the picture, and the point of this one is that it does not.
// Two lists rather than two constants, because a departure that lands on the product's
// own face is not a departure: a product setting its headings in New York collapsed
// three directions into two faces, and the set still measured as three because the rest
// of the look differed. Picked past the product's own family, in order.
const NEUTRALS = ['Helvetica Neue', 'Avenir Next', 'Helvetica']
const SERIFS = ['New York', 'Georgia']
const awayFrom = (list, ...taken) => {
  const no = taken.filter(Boolean).map(x => String(x).toLowerCase())
  return list.find(f => !no.includes(f.toLowerCase())) || list[list.length - 1]
}

/**
 * Three directions: [{ id, label, why, theme, look }].
 *
 * palette is { bg, ink, accent } as sampled, any of which may be missing or nonsense.
 * fonts is fontsIn()'s list and may be empty. product is a display name and may be ''.
 * Nothing here throws and nothing here is required: with none of it, the three
 * directions are still three directions, they are simply not about anybody in
 * particular, and the first one says so.
 *
 * theme is a complete token theme (tokens.assertComplete passes). look is a sparse look
 * patch of the shape ui/looks/*.json use, and validates with no warnings.
 */
function directionsFor(input) {
  const { palette, fonts, product } = (input && typeof input === 'object') ? input : {}
  const p = palette && typeof palette === 'object' ? palette : {}
  const bg = hex(p.bg)
  const ink = hex(p.ink)
  const accent = hex(p.accent)
  const list = Array.isArray(fonts) ? fonts : []
  const family = text(list[0] && list[0].family, 80) || null
  const name = text(product, 40)

  const ground = bg || HOUSE
  const tone = toneOf(ground)
  const own = tokens.THEMES[tone]
  const away = tokens.THEMES[other(tone)]
  const light = tokens.THEMES.light
  const dark = tokens.THEMES.dark
  // Captions in a direction sit in the band below the take, on the ground itself, so
  // which end of the pair they take is decided by the ground and not by the take.
  const onGround = tone === 'light' ? light.ink : dark.lit

  // What direction one actually borrowed, said plainly. Somebody choosing between three
  // pictures deserves to know the first one is derived, and deserves not to be told that
  // when nothing was there to derive it from.
  // The product's ink is what is written on the product's ground. It is not necessarily
  // legible on the shell Fetch draws round it, and the two are different surfaces: a
  // near-black sampled off a dark app went straight onto the dark shell and the device's
  // own lettering disappeared. Taken only when it can actually be read there.
  const textOn = own.shell
  const ownText = ink && contrast(ink, textOn) >= READABLE ? ink : own.text
  const neutral = awayFrom(NEUTRALS, family)
  const serif = awayFrom(SERIFS, family, neutral)
  // and the press stock cannot be the ground direction one is already on, or the two
  // differ by a texture and nothing else
  const stock = ground.toLowerCase() === STOCK.toLowerCase() ? STOCK_ALT : STOCK

  const took = [bg && 'colours', family && 'letters'].filter(Boolean)
  const why1 = took.length
    ? `Its own ${took.join(' and ')}, for a post to people who already know the product.`
    : 'Fetch\'s own warm dark, for a post to people who already know the product: nothing was sampled here, so nothing is borrowed.'

  return [
    {
      id: 'product',
      label: name ? `${name}'s own` : 'The product\'s own',
      why: why1,
      // The warm neutrals stay Fetch's. A product decides the colour that is not a
      // neutral, the colour of what is written, and the letters it is written in; it
      // does not get to decide what a hairline is made of, and a sampled near-black
      // standing in for `ink` is how a picture stops being warm.
      theme: { ...own, accent: accent || own.accent, text: ownText, font: family || own.font },
      look: {
        background: { kind: 'solid', color: ground },
        frame: { padding: 0.06, radius: 14, shadow: 0.5 },
        captions: { font: family || own.font, colour: onGround, highlight: 'word' },
      },
    },
    {
      id: 'stage',
      label: 'On a stage',
      why: 'The other tone under a warm light, in a face that is nobody\'s, for a launch shot where the product should look like an object rather than a screen.',
      theme: { ...away, font: neutral, radius: 18, pad: 0.09 },
      look: {
        background: { kind: 'mesh', mesh: 'studio' },
        frame: { padding: 0.09, radius: 18, shadow: 0.75 },
        // The shell turned over is where the tone inversion is visible. auto would read
        // it back off the ground, which is deep here whatever the product is, and the
        // whole departure would quietly disappear.
        device: { kind: 'window', theme: other(tone) },
        captions: { font: neutral, colour: dark.lit, highlight: 'word' },
        motion: { zoomDepth: 1.8 },
      },
    },
    {
      id: 'press',
      label: 'Press',
      why: 'No colour at all on print stock, for a doc, a changelog, or anything that will be read more than it is watched.',
      // accent goes to the ink. A greyscale direction still has to decide the one colour
      // that is not a neutral, and deciding that there is not one is the decision.
      theme: { ...light, accent: light.ink, font: serif, radius: 6, pad: 0.07 },
      look: {
        background: { kind: 'solid', color: stock, texture: 'print' },
        frame: { padding: 0.07, radius: 6, shadow: 0.25 },
        treatment: { saturation: -1, contrast: 0.1 },
        captions: { font: serif, colour: light.ink, highlight: 'none' },
      },
    },
  ]
}

module.exports = { directionsFor }
