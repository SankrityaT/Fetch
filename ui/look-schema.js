// The Look spec: every setting that decides how a take looks, as one flat table.
//
// Before this, a look was about thirty values spread over the edit document's top
// level (backdrop, outAspect, capStyle), a `look` bag of slider positions and ffmpeg
// filter strings, and an agent could reach only what someone had remembered to write
// into a tool description. Now a field exists once, here, with its type, range,
// default, label and a line of documentation, and everything else is generated from
// it: validation (ui/look.js), the editor's inspector (ui/inspector.js) and the MCP
// docs an agent reads (get_look_schema).
//
// Paths are section.name. Spatial values are fractions of the output frame unless a
// unit says otherwise, so a look means the same at 720p and at 4K.
//
// Whether a field is drawn is a question about the engine, not a flag about a release.
// The compositor draws every field here and is the renderer for MP4 and MOV, which is
// nearly every export. classic: false means the classic ffmpeg renderer, which draws
// GIF, WebM and stills, leaves that field out; it is said only where that renderer is
// the one running (Look.warnings, Look.describe, Look.sections all take the engine).
// classicOptions is the same answer for some options of a field the classic renderer
// otherwise draws. undrawn: true is the unconditional one: nothing draws it yet, on any
// engine, so it is named whatever runs and no inspector offers it.
//
// Pure: no Electron, no filesystem, no DOM.

// The token contract. Exactly one stop below comes from it, the shade both of Fetch's
// own palettes end on; every other hex in those two tables is a colour with no token
// that holds it, and inventing tokens to cover them would be naming numbers rather than
// decisions. It is pure too: no Electron, no filesystem, no DOM.
const { tok } = require('./compositor/tokens')

const SECTIONS = [
  { id: 'frame', label: 'Frame', doc: 'How the take sits in the output: shape, padding, corners, shadow, browser chrome.' },
  { id: 'device', label: 'Device', doc: 'A frame drawn around the take: a browser, a window, a laptop or a phone.' },
  { id: 'background', label: 'Background', doc: 'What fills the output around the take.' },
  { id: 'treatment', label: 'Treatment', doc: 'Colour and lens effects over the finished frame.' },
  { id: 'grain', label: 'Grain', doc: 'Film grain and dither.' },
  { id: 'motion', label: 'Motion', doc: 'Zoom depth and easing, fades and cut transitions.' },
  { id: 'camera', label: 'Camera', doc: 'The style of the camera bubble, when a camera was recorded.' },
  { id: 'cursor', label: 'Cursor', doc: 'The drawn cursor and the Mac\'s own pointer.' },
  { id: 'keys', label: 'Keys', doc: 'The keys drawn on screen as they were pressed, where a take has a key track.' },
  { id: 'captions', label: 'Captions', doc: 'Burned-in captions and their style.' },
  { id: 'typography', label: 'Typography', doc: 'Faces for titles and labels.' },
  { id: 'focus', label: 'Focus', doc: 'How spotlights, lifts, loupes, steps and arrows are drawn.' },
]

// The gradient backgrounds the renderer ships, and the colours they run between. The
// editor previews them with the same two colours.
//
// ink and studio are Fetch's own ramp rather than artistic content, so where the token
// contract already holds one of their neutrals it is read from there instead of copied a
// second time. That is one value: the deep warm black the ink pair and the ink mesh both
// settle on is the shade token. Everything else in those two was mixed for the ramp,
// studio's warm neutrals included, and a token invented to carry a single stop would name
// nothing anyone else could ask for, so they stay literals. The other five palettes are
// pictures and are left alone entirely.
const GRADIENTS = {
  dusk: ['#F0A93C', '#7A3E12'],
  ember: ['#FF6B4A', '#7A1F3D'],
  mint: ['#63E6BE', '#0B7285'],
  violet: ['#A78BFA', '#3B1D6E'],
  slate: ['#64748B', '#0F172A'],
  ink: ['#2A2320', tok('dark', 'shade', '#0A0908')],
  // A sweep rather than a colour: one warm light in the corner and a deep warm neutral
  // everywhere else. dusk is the gold itself, which is right when somebody asks for
  // gold and wrong under a recording, where the accent has to stay the accent.
  studio: ['#8A6A3C', '#1F1A16'],
}

// Mesh gradients: the same seven names, loosened into control points. Each point is a
// place in the frame (fractions), a reach, and a colour; the compositor blends them by
// normalised Gaussian weights in sRGB, so a mesh and the flat gradient of the same name
// are relatives rather than strangers. The middle point is always the deep, quiet one:
// the take sits on top of it, and a busy centre fights the recording.
// The classic ffmpeg renderer cannot draw a mesh and falls back to the flat pair.
const MESHES = {
  dusk: [[0.10, 0.12, 0.30, '#F6C15F'], [0.92, 0.06, 0.26, '#C97F1E'], [0.06, 0.90, 0.28, '#8A4A16'], [0.88, 0.94, 0.30, '#4E2409'], [0.50, 0.54, 0.34, '#7A3E12']],
  ember: [[0.08, 0.10, 0.30, '#FF8A62'], [0.94, 0.18, 0.26, '#E0452F'], [0.12, 0.92, 0.28, '#7A1F3D'], [0.90, 0.88, 0.30, '#4A0F26'], [0.50, 0.52, 0.34, '#93304A']],
  mint: [[0.10, 0.08, 0.30, '#7FF0CE'], [0.90, 0.12, 0.26, '#2FB8A6'], [0.08, 0.88, 0.28, '#0B7285'], [0.92, 0.92, 0.30, '#053F50'], [0.50, 0.54, 0.34, '#0F6B7C']],
  violet: [[0.12, 0.10, 0.30, '#B9A2FF'], [0.88, 0.08, 0.26, '#7C5CE0'], [0.06, 0.92, 0.28, '#3B1D6E'], [0.94, 0.90, 0.30, '#200F45'], [0.50, 0.52, 0.34, '#3F2178']],
  slate: [[0.10, 0.10, 0.30, '#8494AC'], [0.92, 0.14, 0.26, '#4E5C73'], [0.08, 0.90, 0.28, '#1B2540'], [0.90, 0.94, 0.30, '#0B1120'], [0.50, 0.52, 0.34, '#26314A']],
  ink: [[0.12, 0.10, 0.30, '#3A312B'], [0.90, 0.10, 0.26, '#241F1B'], [0.08, 0.92, 0.28, '#100D0C'], [0.92, 0.90, 0.30, tok('dark', 'shade', '#0A0908')], [0.50, 0.52, 0.34, '#161311']],
  // The one mesh that is a light rather than a palette: a compact warm key in the top
  // left corner, its own surround, and three deep warm neutrals carrying the rest. The
  // light is the only place gold reaches, and it lands on the margin above and left of
  // the take, which is where a studio sweep is brightest.
  studio: [[0.18, 0.12, 0.20, '#C6924A'], [0.02, 0.00, 0.36, '#745C3C'], [0.92, 0.10, 0.30, '#40362C'],
    [0.06, 0.92, 0.30, '#2E2721'], [0.94, 0.94, 0.32, '#201B17'], [0.50, 0.55, 0.34, '#332B24']],
}

const ASPECTS = ['auto', '16:9', '1:1', '9:16', '4:3', '4:5']

// f(path, type, default, extra): extra carries min, max, step, unit, options, label,
// doc, when (a condition on other fields), advanced, classic, classicOptions,
// undrawn, hidden. Four more are for the person only and change nothing an agent sends:
// display { unit, scale } is how a dial reads when that is not its stored unit (the
// shutter is stored in frames and read in degrees), placeholder is the hint in an empty
// text field, optionLabels names an enum's options on screen, and sub is a switch's
// second line. Every 0..1 dial with no natural unit is a percent, so it reads "50%"
// beside "6%" rather than a bare "0.5"; -1..1 dials read "-30%" to "+30%".
const f = (path, type, def, extra = {}) => ({ path, type, default: def, section: path.split('.')[0], ...extra })

const FIELDS = [
  // ── frame ──
  f('frame.aspect', 'enum', 'auto', { options: ASPECTS, label: 'Shape',
    doc: 'Output shape. auto keeps the take\'s own shape. Any other shape is filled by the background, never black bars.' }),
  f('frame.padding', 'number', 0.06, { min: 0.02, max: 0.22, step: 0.01, unit: '%', label: 'Padding',
    doc: 'Space between the take and the edge of the output, as a share of the frame.', when: { 'background.kind': '!none' } }),
  f('frame.radius', 'number', 14, { min: 0, max: 60, step: 1, unit: 'px', label: 'Corners',
    doc: 'Corner radius of the framed take, in pixels on a 1080p output.', when: { 'background.kind': '!none' } }),
  f('frame.shadow', 'number', 0.6, { min: 0, max: 1, step: 0.05, unit: '%', label: 'Shadow',
    doc: 'Strength of the soft shadow under the framed take.',
    when: { 'background.kind': '!none' } }),
  f('frame.chrome', 'enum', 'remove', { options: ['keep', 'remove', 'clean'], label: 'Capture chrome',
    doc: 'A browser take\'s tabs and toolbar, or the Simulator\'s toolbar and the outline its window draws round the ' +
      'device screen. remove crops to the content where its place was measured (an agent reported a viewport, or a ' +
      'simulator take\'s screen rectangle was read off a frame); keep leaves it; clean crops the same way and draws ' +
      'Fetch\'s own in its place, the phone over a device screen and the browser over a page.',
    classicOptions: ['clean'] }),
  // A look-wide answer to the question device.theme asks about one shell. It is saved and
  // checked here before anything reads it, so the ticket that teaches the compositor to
  // honour dark and light finds every stored look already carrying the field. auto is the
  // only value anything acts on today, and auto is what every look already means.
  f('frame.theme', 'enum', 'auto', { options: ['auto', 'dark', 'light'], label: 'Theme',
    doc: 'Which token theme the look is drawn from, not the shell alone. auto reads it off the ground, the way it always has.',
    undrawn: true }),
  f('frame.scale', 'number', 1, { min: 0.5, max: 1.2, step: 0.01, unit: 'x', label: 'Scale', doc: 'Size of the framed take.', undrawn: true, advanced: true }),
  f('frame.offsetX', 'number', 0, { min: -0.5, max: 0.5, step: 0.01, unit: '%', label: 'Offset X', doc: 'Moves the framed take across.', undrawn: true, advanced: true }),
  f('frame.offsetY', 'number', 0, { min: -0.5, max: 0.5, step: 0.01, unit: '%', label: 'Offset Y', doc: 'Moves the framed take down.', undrawn: true, advanced: true }),
  f('frame.tilt', 'number', 0, { min: -20, max: 20, step: 0.5, unit: 'deg', label: 'Tilt', doc: 'A 3D tilt of the framed take.', classic: false, advanced: true }),
  f('frame.border', 'number', 0, { min: 0, max: 12, step: 0.5, unit: 'px', label: 'Border', doc: 'A hairline border round the take, in pixels at 1080p.', classic: false }),
  f('frame.borderColor', 'color', '#FFFFFF', { label: 'Border colour', doc: 'Colour of the border.', classic: false, when: { 'frame.border': '>0' } }),

  // ── device ──
  f('device.kind', 'enum', 'none', { options: ['none', 'browser', 'window', 'laptop', 'phone'], label: 'Kind',
    doc: 'A drawn frame round the take: generic shapes, never a real product. frame.chrome clean draws one on its own. ' +
      'A shot of several captures draws one frame each, the capture\'s own or this. Round a capture that already has chrome in it ' +
      'the frame wears a plain bezel, so the picture has one title bar and not two. A phone over a simulator take is that ' +
      'bezel with no slit until frame.chrome remove crops it to the device screen, and for good where that rectangle was ' +
      'never measured.',
    classic: false }),
  f('device.title', 'string', '', { label: 'Title', placeholder: 'Library',
    doc: 'What the bar says: a window\'s centred title, or a browser tab\'s name. Empty takes the captured window\'s own title. ' +
      'A title shaped like a host stands in as the address too, but only where device.url is empty, which is how older looks say it. ' +
      'Fetch never invents a host: with nothing given the address pill is drawn empty.',
    classic: false, when: { 'device.kind': '!none' } }),
  f('device.url', 'string', '', { label: 'Address', placeholder: 'example.com/library',
    doc: 'The address in a browser frame\'s pill. Comes from the capture, the person or an agent. ' +
      'Anything not shaped like an address is dropped rather than drawn, and nothing is made up.',
    classic: false, when: { 'device.kind': 'browser' } }),
  f('device.theme', 'enum', 'auto', { options: ['auto', 'light', 'dark'], label: 'Device tone',
    doc: 'The shell\'s own tone. auto steps in from the ground: graphite on a dark one, bone on a light one. ' +
      'One tone for every frame in a shot.',
    classic: false, when: { 'device.kind': '!none' } }),

  // ── background ──
  f('background.kind', 'enum', 'none', { options: ['none', 'solid', 'gradient', 'mesh', 'image', 'video-blur'], label: 'Kind',
    doc: 'none shows the take edge to edge. solid, gradient, mesh (a gradient loosened into control points), image and video-blur ' +
      '(the take itself, blurred and deepened) frame it with padding and a shadow.' }),
  f('background.gradient', 'enum', 'dusk', { options: Object.keys(GRADIENTS), label: 'Gradient',
    doc: 'Which gradient: dusk (gold), ember, mint, violet, slate, ink (warm near-black), studio (a warm light on a deep neutral).', when: { 'background.kind': 'gradient' } }),
  f('background.color', 'color', '#1A1714', { label: 'Colour', doc: 'The solid colour, #RRGGBB.', when: { 'background.kind': 'solid' } }),
  f('background.mesh', 'enum', 'dusk', { options: Object.keys(MESHES), label: 'Mesh',
    doc: 'Which mesh: the same seven palettes as the gradients, drawn from control points instead of corner to corner.',
    when: { 'background.kind': 'mesh' } }),
  f('background.image', 'asset', null, { label: 'Image',
    doc: 'An image backdrop id from list_looks backgrounds (img:...).', when: { 'background.kind': 'image' } }),
  f('background.imageBlur', 'number', 0, { min: 0, max: 1, step: 0.05, unit: '%', label: 'Image blur', doc: 'Softens the image.', classic: false, when: { 'background.kind': 'image' } }),
  f('background.imageDim', 'number', 0, { min: 0, max: 1, step: 0.05, unit: '%', label: 'Image dim', doc: 'Darkens the image.', classic: false, when: { 'background.kind': 'image' } }),
  f('background.blurAmount', 'number', 0.5, { min: 0, max: 1, step: 0.05, unit: '%', label: 'Blur amount',
    doc: 'How far the take is blurred behind itself.', classic: false, when: { 'background.kind': 'video-blur' } }),
  f('background.texture', 'enum', 'none', { options: ['none', 'paper', 'print'],
    optionLabels: { none: 'Flat', paper: 'Paper', print: 'Print stock' }, label: 'Texture',
    doc: 'A still material on a solid ground, drawn once into the cached background and never redrawn, so it reads as a sheet ' +
      'rather than as video noise and the encoder keeps it: paper is warm fibre with soft mottling, print is the same finer ' +
      'and quieter. It belongs to the look, so a look saved under a new name keeps its sheet. Only on a solid ground.',
    classic: false, when: { 'background.kind': 'solid' } }),

  // ── treatment ──
  f('treatment.motionBlur', 'number', 0.5, { min: 0, max: 1, step: 0.05, label: 'Shutter', display: { unit: 'deg', scale: 360 },
    doc: 'How long the shutter stays open, in frames: 0.5 is the film standard 180 degrees, 1 is 360, 0 closes it and nothing blurs. How far a zoom smears is its own speed at that instant, not this, so a fast pass smears and a settle does not.', classic: false }),
  f('treatment.autoLevel', 'bool', false, { label: 'Auto level', doc: 'Evens the take\'s exposure.', classic: false }),
  f('treatment.brightness', 'number', 0, { min: -1, max: 1, step: 0.05, unit: '%', label: 'Brightness', doc: 'Lighter or darker.', classic: false }),
  f('treatment.contrast', 'number', 0, { min: -1, max: 1, step: 0.05, unit: '%', label: 'Contrast', doc: 'More or less contrast.', classic: false }),
  f('treatment.saturation', 'number', 0, { min: -1, max: 1, step: 0.05, unit: '%', label: 'Saturation', doc: '-1 is black and white.', classic: false }),
  f('treatment.tint', 'color', '#F0A93C', { label: 'Tint', doc: 'A colour laid over the frame.', classic: false }),
  f('treatment.tintAmount', 'number', 0, { min: 0, max: 1, step: 0.05, unit: '%', label: 'Tint amount', doc: 'How strong the tint is.', classic: false }),
  f('treatment.haze', 'number', 0, { min: 0, max: 1, step: 0.05, unit: '%', label: 'Haze', doc: 'Lifted blacks, like a soft lens.', classic: false }),
  f('treatment.blur', 'number', 0, { min: 0, max: 1, step: 0.05, unit: '%', label: 'Blur', doc: 'Softens the whole frame.', classic: false, advanced: true }),
  f('treatment.bokeh', 'number', 0, { min: 0, max: 1, step: 0.05, unit: '%', label: 'Bokeh', doc: 'The background defocused through an aperture, so highlights open into its shape. Needs an image or video-blur background.', classic: false }),
  f('treatment.bloom', 'number', 0, { min: 0, max: 1, step: 0.05, unit: '%', label: 'Bloom', doc: 'Bright areas glow.', classic: false }),
  f('treatment.halation', 'number', 0, { min: 0, max: 1, step: 0.05, unit: '%', label: 'Halation', doc: 'A warm film glow round highlights.', classic: false }),
  f('treatment.aberration', 'number', 0, { min: 0, max: 1, step: 0.05, unit: '%', label: 'Aberration', doc: 'Colour fringes at the edges.', classic: false, advanced: true }),
  f('treatment.vignette', 'number', 0, { min: 0, max: 1, step: 0.05, unit: '%', label: 'Vignette',
    doc: 'Darker corners. 1 takes about two thirds of the light off the frame\'s furthest corner, 0.3 about a fifth.', classic: false }),

  // ── grain ──
  f('grain.film', 'number', 0, { min: 0, max: 1, step: 0.05, unit: '%', label: 'Film grain', doc: 'Moving film grain.', classic: false }),
  f('grain.dither', 'bool', true, { label: 'Dither', doc: 'Breaks up banding in gradients.', classic: false }),

  // ── motion ──
  f('motion.zoomDepth', 'number', 1.7, { min: 1.2, max: 2.4, step: 0.1, unit: 'x', label: 'Auto zoom depth',
    doc: 'The deepest auto zoom pushes in. Where the clicks say how wide the thing under them is, the zoom frames that instead, so it spans about 70 percent of the view; 1.7 is the depth at which something two fifths of the picture across sits at that fit.' }),
  f('motion.zoomEase', 'enum', 'smooth', { options: ['smooth', 'snappy', 'gentle', 'settle'], label: 'Zoom easing',
    doc: 'How a zoom moves. All four leave rest and arrive at rest with no jolt and no overshoot; they differ in how long the move takes and how early it is over. smooth: seven tenths of the way in half the time, then a long arrival. snappy: eight tenths, and a shorter move. gentle: even and half again as long. settle: nearly there at once, then a slow last tenth.' }),
  f('motion.fadeIn', 'number', 0, { min: 0, max: 3, step: 0.1, unit: 's', label: 'Fade in', doc: 'Fade from black, picture and sound, at the start.' }),
  f('motion.fadeOut', 'number', 0, { min: 0, max: 3, step: 0.1, unit: 's', label: 'Fade out', doc: 'Fade to black at the end.' }),
  // A clip meant to autoplay on a page and repeat forever. It changes one thing about
  // the drawing, the index the grain, the ground's tooth and the dither are seeded by,
  // which becomes the frame's place inside the loop so a preview playing the clip round
  // again draws the frames the file holds. Everything else it does is say so: Fetch
  // names what is stopping a clean loop rather than rewriting the edit to force one,
  // because that answer is the useful one (gl.js, loopCheck).
  f('motion.loop', 'bool', false, { label: 'Seamless loop',
    doc: 'The clip autoplays and repeats with no visible jump at the join. Fetch names what stops the last frame handing over ' +
      'to the first rather than forcing it: a fade at either end, reveal opening and closing the take once a cycle, a zoom, ' +
      'bubble, mark or caption still running at the last frame, or a recording that does not come back to where it began. A ' +
      'player counting frames on past the end seeds grain and dither on the frame\'s place inside the loop, so a second pass ' +
      'draws the frames the file holds.', classic: false }),
  f('motion.reveal', 'enum', 'rise', { options: ['none', 'rise'], label: 'Open and close',
    doc: 'How the take arrives and leaves. rise brings it up into its frame over a third of a second and settles it back out. Only where something is behind it.' }),
  f('motion.cutTransition', 'enum', 'none', { options: ['none', 'crossfade', 'dip', 'zoom'], label: 'Cut transition',
    doc: 'Where a cut joins two pieces. none is a hard cut, and right for dead air: the two sides are the same shot a moment apart, so a dissolve is invisible there and a dip only announces the edit. crossfade dissolves, out of the frames the cut removed; dip takes the take through the ground and back; zoom lands the next piece tight and settles it out. A fifth of a second each; a GIF cuts hard.' }),

  // ── camera ──
  // The shape the bubble opens in. Where it is, how big it is and what shape it is are
  // keyframed on the edit's own camera (camera.keys), because they are the shot and not
  // the look: the same look over a take where the face leads and one where it does not
  // wants the bubble in two different places.
  f('camera.shape', 'enum', 'circle', { options: ['circle', 'rounded'], label: 'Bubble shape',
    doc: 'The camera bubble\'s shape, where no camera key says otherwise.', classic: false }),
  f('camera.ring', 'bool', true, { label: 'Ring', doc: 'A light ring round the bubble; it grows and shrinks with the bubble.', classic: false }),

  // ── cursor ──
  f('cursor.show', 'bool', true, { label: 'Show cursor', doc: 'Draw the agent\'s cursor from the take\'s pointer track.' }),
  f('cursor.hideSystem', 'enum', 'auto', { options: ['auto', 'hide', 'keep'], label: 'Mac pointer',
    doc: 'The Mac\'s own pointer where the take has it in the pixels. auto lifts it out only when the drawn cursor replaces it.' }),
  f('cursor.size', 'number', 1, { min: 0.6, max: 2, step: 0.05, unit: 'x', label: 'Cursor size', doc: 'Size of the drawn cursor.', classic: false }),
  f('cursor.smoothing', 'number', 0.5, { min: 0, max: 1, step: 0.05, unit: '%', label: 'Smoothing', doc: 'How much the cursor\'s path is smoothed.', undrawn: true }),
  f('cursor.ripple', 'bool', true, { label: 'Click ripple', doc: 'A gold ripple on each click.', classic: false }),
  f('cursor.style', 'enum', 'arrow', { options: ['arrow', 'touch'], label: 'Cursor style',
    doc: 'What the take\'s pointer track draws. arrow is the agent\'s cursor. touch is a finger: a disc that ' +
      'appears where a tap landed and is gone between taps, and defaults on a take whose target was a simulator. ' +
      'The classic export path draws the arrow only.', classic: false }),

  // ── keys ──
  // Drawn from the take's own key track (marks.js planKeys), which the recorder does not
  // yet fill: reading the keyboard needs an event tap and its own permission, so it is
  // its own piece and its own decision. These three are the whole of what a look gets to
  // say about them. Whether a character is drawn at all is not a preference and is not
  // here: Fetch draws one only where the capture vouched for it.
  f('keys.show', 'bool', true, { label: 'Show keys',
    doc: 'Draw the keys as they were pressed, where the take has a key track. A chord is drawn as caps with the key that acted in gold; a run of typing is one pill, and reads as typing rather than as the letters wherever Fetch cannot tell the field was safe to show.',
    classic: false }),
  f('keys.place', 'enum', 'left', { options: ['left', 'centre', 'right'], label: 'Place',
    doc: 'Which bottom corner the keys sit in. They stand on the ground under the take where the look leaves room for them, and inside its bottom corner where it does not, clear of any burned-in caption.',
    classic: false, when: { 'keys.show': true } }),
  f('keys.size', 'number', 1, { min: 0.7, max: 1.6, step: 0.05, unit: 'x', label: 'Size',
    doc: 'How large the caps are drawn. 1 is about 60 px tall at 1080.', classic: false, when: { 'keys.show': true } }),

  // ── captions ──
  f('captions.show', 'bool', true, { label: 'Burn into video', sub: 'Baked in, plays anywhere', doc: 'Burn the transcript into the video when there is one.' }),
  f('captions.font', 'string', 'SF Pro', { label: 'Font', doc: 'An installed font name, e.g. SF Pro, Helvetica, New York.' }),
  f('captions.scale', 'number', 1, { min: 0.6, max: 1.8, step: 0.1, unit: 'x', label: 'Size', doc: 'Caption size.' }),
  f('captions.colour', 'color', '#FFFFFF', { label: 'Colour', doc: 'Caption colour, #RRGGBB.' }),
  f('captions.position', 'enum', 'bottom', { options: ['bottom', 'middle', 'top'], label: 'Place', doc: 'Where captions sit.' }),
  f('captions.highlight', 'enum', 'word', { options: ['word', 'pill', 'none'], optionLabels: { word: 'Gold', pill: 'Pill', none: 'Off' }, label: 'Spoken word',
    doc: 'word turns the word being spoken gold, pill sits it on a gold pill, none leaves the line plain.' }),
  // Where a person dragged the captions to, as fractions of the frame; null is the place above.
  f('captions.fx', 'number', null, { min: 0, max: 1, nullable: true, hidden: true, label: 'Caption x', doc: 'Dragged caption centre, across.' }),
  f('captions.fy', 'number', null, { min: 0, max: 1, nullable: true, hidden: true, label: 'Caption y', doc: 'Dragged caption centre, down.' }),

  // ── typography ──
  f('typography.titleFont', 'string', 'house', { label: 'Title face', doc: 'Face for title cards and lower thirds; house is Fetch\'s own.', undrawn: true }),
  // The two fields a picture's own type needs. A headline is not a title card: a card is
  // a handover, it covers the picture and clears, and a still has no handover to spend.
  // A headline stands beside the picture or over the ground and the picture is refitted
  // into what is left, which is why where it stands is a look and not a layer's own
  // placement. The words themselves are a text layer, style headline.
  f('typography.headline', 'enum', 'auto', { options: ['auto', 'above', 'below', 'left', 'right'], label: 'Headline place',
    doc: 'Where a text layer of style headline stands. auto puts it beside the picture where the picture\'s own shape leaves ' +
      'a column and above it where it does not. Never over the picture. Needs a background to stand on.',
    classic: false }),
  f('typography.headlineSize', 'number', 0.062, { min: 0.026, max: 0.12, step: 0.002, unit: '%', label: 'Headline size',
    doc: 'A share of the frame\'s height: 0.062 is 67 px at 1080. Too long for its column, a headline wraps, then steps down.',
    classic: false }),

  // ── focus ──
  f('focus.dim', 'number', 0.5, { min: 0, max: 0.9, step: 0.05, unit: '%', label: 'Spotlight dim', doc: 'How dark the frame goes round a spotlight.', classic: false }),
  f('focus.lift', 'number', 1.04, { min: 1, max: 1.15, step: 0.01, unit: 'x', label: 'Lift', doc: 'How far a lifted element rises.', classic: false }),
  f('focus.loupe', 'number', 2.2, { min: 1.4, max: 4, step: 0.1, unit: 'x', label: 'Loupe',
    doc: 'How far a loupe magnifies its area. The inset sits beside that area, or under it where there is no room beside.', classic: false }),
  f('focus.arrow', 'number', 1, { min: 0.6, max: 1.8, step: 0.05, unit: 'x', label: 'Arrow size',
    doc: 'How large a pointing arrow is drawn. It stands outside the box it aims at and points at the nearest edge, so the thing it points at is never under it; a larger arrow needs more clear room beside that box and is shortened, or dropped, where there is none.', classic: false }),
]

const BY_PATH = new Map(FIELDS.map(x => [x.path, x]))

module.exports = { SECTIONS, FIELDS, BY_PATH, GRADIENTS, MESHES, ASPECTS }
