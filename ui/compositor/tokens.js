// The design tokens the compositor draws from.
//
// Every colour in the compositor used to be a literal sitting next to the thing it
// painted: EDGE_INK and EDGE_LIT in plan.js, the fourteen hexes of SHELL, GOLD, INK,
// WHITE and SHADE in text.js, the traffic lights and the scrim in gl.js. About
// thirty-five of them. They were not arbitrary — they were hand-copied out of
// ui/tokens.css, and the comment above EDGE_INK still names the CSS variable it came
// from — but a value copied by hand is a value that can drift, and nothing anywhere
// said what the full set was or that a look had to decide all of it.
//
// So the tokens stop being a convention and become a contract. A theme is an object
// that defines every name below; assertComplete refuses one that does not. That is the
// whole point: a look used to be a sparse bag of whatever fields somebody happened to
// set, and there was no artifact that said what a coherent visual direction consists
// of. Now there is, and it is this list.
//
// Two themes ship, and their values are byte-identical to the literals they replace, so
// naming them changes no pixel. Everything after that is a deliberate decision made
// once, in one place, rather than thirty-five decisions made wherever they were needed.
//
// No DOM, no require of anything in the app: this is read by the plan, by the text pass
// and by the GL renderer, in the main process and in the render window both.

// The contract. A theme defines all of these or it is not a theme.
//
// Grouped by what they answer rather than by type, because that is how somebody picks
// them: what colour is the world, what is written on it, what is it made of, how does
// it move.
const NAMES = Object.freeze([
  // the ground and the two ends of every hairline. Never #000 or #fff: every neutral
  // here is warmed toward the fur hue, which is what keeps a Fetch picture warm even
  // where nothing in it is coloured.
  'ink', 'lit', 'shade',
  // the one colour that is not a neutral
  'accent',
  // the surfaces a drawn device is built from: its body, the bar it wears, the foot
  // under a lid, a browser's toolbar, and the address field sunk into it
  'shell', 'surface', 'deep', 'tool', 'well',
  // what is drawn on those surfaces
  'line', 'text',
  // how much light runs along a shell's top edge. A number, not a colour, and part of
  // the contract because it is the only thing that says the shell is a solid object.
  'sheen',
  // type
  'font', 'weight', 'scale',
  // shape
  'radius', 'hair', 'pad',
  // motion, in seconds and in an easing name
  'fast', 'slow', 'ease',
])

// Values below are the literals they replace, unchanged:
//   ink/lit      plan.js EDGE_INK / EDGE_LIT, text.js INK / WHITE
//   shade        text.js SHADE
//   accent       text.js GOLD
//   shell..well  plan.js SHELL.dark / SHELL.light
const THEMES = Object.freeze({
  dark: Object.freeze({
    ink: '#1A1714', lit: '#FBFAF8', shade: '#0A0908', accent: '#F0A93C',
    shell: '#2A2420', surface: '#1F1B18', deep: '#1F1B18', tool: '#3A322C', well: '#1F1B18',
    // A dark shell takes the light end of the pair, because a hairline goes to the
    // warm end its surface is not (plan.js edgeFor says the same thing the other way).
    line: '#FBFAF8', text: '#BDB5AC', sheen: 0.07,
    font: 'SF Pro', weight: 600, scale: 1,
    radius: 14, hair: 1, pad: 0.06,
    fast: 0.18, slow: 0.45, ease: 'smooth',
  }),
  light: Object.freeze({
    ink: '#1A1714', lit: '#FBFAF8', shade: '#0A0908', accent: '#F0A93C',
    shell: '#E8E2DA', surface: '#F6F3EE', deep: '#D6CFC5', tool: '#FAF7F2', well: '#ECE6DE',
    line: '#1A1714', text: '#6E655C', sheen: 0.5,
    font: 'SF Pro', weight: 600, scale: 1,
    radius: 14, hair: 1, pad: 0.06,
    fast: 0.18, slow: 0.45, ease: 'smooth',
  }),
})

/**
 * One token, from a theme named or handed in whole.
 *
 * The fallback is not decoration. Every call site passes the literal it used to hold, so
 * a theme that is missing a name draws exactly what it drew before rather than drawing
 * nothing: a missing token must never be a black rectangle in somebody's export. The
 * gate against a theme going incomplete is assertComplete, at the edge, not a crash in
 * the middle of a frame.
 */
function tok(theme, name, fallback) {
  const t = typeof theme === 'string' ? THEMES[theme] : theme
  const v = t && t[name]
  return v === undefined || v === null ? fallback : v
}

/** A whole theme, by name. Unknown names get the dark one, which is Fetch's own. */
const themeOf = name => THEMES[name] || THEMES.dark

/**
 * Every name defined, or a throw that says which are missing.
 *
 * Called on the shipped themes by the tests and on any theme built at runtime before it
 * is drawn with. This is where an incomplete direction is caught: a theme that decides
 * eleven of the twenty-one things is not a direction, it is a preference, and the whole
 * reason for this file is that Fetch had a great many of those and no directions.
 */
function assertComplete(theme, label = 'theme') {
  const t = typeof theme === 'string' ? THEMES[theme] : theme
  if (!t || typeof t !== 'object') throw new Error(`${label} is not a theme`)
  const missing = NAMES.filter(n => t[n] === undefined || t[n] === null)
  if (missing.length) {
    throw new Error(`${label} is missing ${missing.length} of ${NAMES.length} tokens: ${missing.join(', ')}`)
  }
  return true
}

module.exports = { NAMES, THEMES, tok, themeOf, assertComplete }
