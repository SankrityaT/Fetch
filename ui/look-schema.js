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
const GRADIENTS = {
  dusk: ['#F0A93C', '#7A3E12'],
  ember: ['#FF6B4A', '#7A1F3D'],
  mint: ['#63E6BE', '#0B7285'],
  violet: ['#A78BFA', '#3B1D6E'],
  slate: ['#64748B', '#0F172A'],
  ink: ['#2A2320', '#0A0908'],
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
  ink: [[0.12, 0.10, 0.30, '#3A312B'], [0.90, 0.10, 0.26, '#241F1B'], [0.08, 0.92, 0.28, '#100D0C'], [0.92, 0.90, 0.30, '#0A0908'], [0.50, 0.52, 0.34, '#161311']],
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
// undrawn, hidden.
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
    doc: 'Strength of the soft shadow under the framed take.', when: { 'background.kind': '!none' } }),
  f('frame.chrome', 'enum', 'remove', { options: ['keep', 'remove', 'clean'], label: 'Browser chrome',
    doc: 'A browser take\'s tabs and toolbar. remove crops them off where Fetch knows the page\'s place ' +
      '(an agent recorded it by reporting its pointer with viewport); keep leaves them; clean crops the same way and draws a frame of Fetch\'s own round the page.',
    classicOptions: ['clean'] }),
  f('frame.scale', 'number', 1, { min: 0.5, max: 1.2, step: 0.01, unit: 'x', label: 'Scale', doc: 'Size of the framed take.', undrawn: true, advanced: true }),
  f('frame.offsetX', 'number', 0, { min: -0.5, max: 0.5, step: 0.01, unit: '%', label: 'Offset X', doc: 'Moves the framed take across.', undrawn: true, advanced: true }),
  f('frame.offsetY', 'number', 0, { min: -0.5, max: 0.5, step: 0.01, unit: '%', label: 'Offset Y', doc: 'Moves the framed take down.', undrawn: true, advanced: true }),
  f('frame.tilt', 'number', 0, { min: -20, max: 20, step: 0.5, unit: 'deg', label: 'Tilt', doc: 'A 3D tilt of the framed take.', classic: false, advanced: true }),
  f('frame.border', 'number', 0, { min: 0, max: 12, step: 0.5, unit: 'px', label: 'Border', doc: 'A hairline border round the take, in pixels at 1080p.', classic: false }),
  f('frame.borderColor', 'color', '#FFFFFF', { label: 'Border colour', doc: 'Colour of the border.', classic: false, when: { 'frame.border': '>0' } }),

  // ── device ──
  f('device.kind', 'enum', 'none', { options: ['none', 'browser', 'window', 'laptop', 'phone'], label: 'Device',
    doc: 'A drawn frame round the take: generic shapes, never a real product. frame.chrome clean draws the browser one on its own.',
    classic: false }),
  f('device.title', 'string', '', { label: 'Address',
    doc: 'The address a browser frame shows, or a window frame\'s title. Fetch records no page address, so an empty one leaves the bar blank.',
    classic: false, when: { 'device.kind': '!none' } }),
  f('device.theme', 'enum', 'auto', { options: ['auto', 'light', 'dark'], label: 'Device tone',
    doc: 'The shell\'s own tone. auto steps in from the ground: graphite on a dark one, bone on a light one.',
    classic: false, when: { 'device.kind': '!none' } }),

  // ── background ──
  f('background.kind', 'enum', 'none', { options: ['none', 'solid', 'gradient', 'mesh', 'image', 'video-blur'], label: 'Background',
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
  f('background.imageBlur', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Image blur', doc: 'Softens the image.', classic: false, when: { 'background.kind': 'image' } }),
  f('background.imageDim', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Image dim', doc: 'Darkens the image.', classic: false, when: { 'background.kind': 'image' } }),
  f('background.blurAmount', 'number', 0.5, { min: 0, max: 1, step: 0.05, label: 'Blur amount',
    doc: 'How far the take is blurred behind itself.', classic: false, when: { 'background.kind': 'video-blur' } }),

  // ── treatment ──
  f('treatment.motionBlur', 'number', 0.5, { min: 0, max: 1, step: 0.05, label: 'Shutter',
    doc: 'How long the shutter stays open, in frames: 0.5 is the film standard 180 degrees, 1 is 360, 0 closes it and nothing blurs. How far a zoom smears is its own speed at that instant, not this, so a fast pass smears and a settle does not.', classic: false }),
  f('treatment.autoLevel', 'bool', false, { label: 'Auto level', doc: 'Evens the take\'s exposure.', classic: false }),
  f('treatment.brightness', 'number', 0, { min: -1, max: 1, step: 0.05, label: 'Brightness', doc: 'Lighter or darker.', classic: false }),
  f('treatment.contrast', 'number', 0, { min: -1, max: 1, step: 0.05, label: 'Contrast', doc: 'More or less contrast.', classic: false }),
  f('treatment.saturation', 'number', 0, { min: -1, max: 1, step: 0.05, label: 'Saturation', doc: '-1 is black and white.', classic: false }),
  f('treatment.tint', 'color', '#F0A93C', { label: 'Tint', doc: 'A colour laid over the frame.', classic: false }),
  f('treatment.tintAmount', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Tint amount', doc: 'How strong the tint is.', classic: false }),
  f('treatment.haze', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Haze', doc: 'Lifted blacks, like a soft lens.', classic: false }),
  f('treatment.blur', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Blur', doc: 'Softens the whole frame.', classic: false, advanced: true }),
  f('treatment.bokeh', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Bokeh', doc: 'The background defocused through an aperture, so highlights open into its shape. Needs an image or video-blur background.', classic: false }),
  f('treatment.bloom', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Bloom', doc: 'Bright areas glow.', classic: false }),
  f('treatment.halation', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Halation', doc: 'A warm film glow round highlights.', classic: false }),
  f('treatment.aberration', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Aberration', doc: 'Colour fringes at the edges.', classic: false, advanced: true }),
  f('treatment.vignette', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Vignette',
    doc: 'Darker corners. 1 takes about two thirds of the light off the frame\'s furthest corner, 0.3 about a fifth.', classic: false }),

  // ── grain ──
  f('grain.film', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Film grain', doc: 'Moving film grain.', classic: false }),
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
  f('cursor.smoothing', 'number', 0.5, { min: 0, max: 1, step: 0.05, label: 'Smoothing', doc: 'How much the cursor\'s path is smoothed.', undrawn: true }),
  f('cursor.ripple', 'bool', true, { label: 'Click ripple', doc: 'A gold ripple on each click.', classic: false }),

  // ── keys ──
  // Drawn from the take's own key track (marks.js planKeys), which the recorder does not
  // yet fill: reading the keyboard needs an event tap and its own permission, so it is
  // its own piece and its own decision. These three are the whole of what a look gets to
  // say about them. Whether a character is drawn at all is not a preference and is not
  // here: Fetch draws one only where the capture vouched for it.
  f('keys.show', 'bool', true, { label: 'Show keys',
    doc: 'Draw the keys as they were pressed, where the take has a key track. A chord is drawn as caps with the key that acted in gold; a run of typing is one pill, and reads as typing rather than as the letters wherever Fetch cannot tell the field was safe to show.',
    classic: false }),
  f('keys.place', 'enum', 'left', { options: ['left', 'centre', 'right'], label: 'Key place',
    doc: 'Which bottom corner the keys sit in. They stand on the ground under the take where the look leaves room for them, and inside its bottom corner where it does not, clear of any burned-in caption.',
    classic: false, when: { 'keys.show': true } }),
  f('keys.size', 'number', 1, { min: 0.7, max: 1.6, step: 0.05, unit: 'x', label: 'Key size',
    doc: 'How large the caps are drawn. 1 is about 60 px tall at 1080.', classic: false, when: { 'keys.show': true } }),

  // ── captions ──
  f('captions.show', 'bool', true, { label: 'Burn in captions', doc: 'Burn the transcript into the video when there is one.' }),
  f('captions.font', 'string', 'SF Pro', { label: 'Font', doc: 'An installed font name, e.g. SF Pro, Helvetica, New York.' }),
  f('captions.scale', 'number', 1, { min: 0.6, max: 1.8, step: 0.1, unit: 'x', label: 'Size', doc: 'Caption size.' }),
  f('captions.colour', 'color', '#FFFFFF', { label: 'Colour', doc: 'Caption colour, #RRGGBB.' }),
  f('captions.position', 'enum', 'bottom', { options: ['bottom', 'middle', 'top'], label: 'Place', doc: 'Where captions sit.' }),
  f('captions.highlight', 'enum', 'word', { options: ['word', 'pill', 'none'], label: 'Spoken word',
    doc: 'word turns the word being spoken gold, pill sits it on a gold pill, none leaves the line plain.' }),
  // Where a person dragged the captions to, as fractions of the frame; null is the place above.
  f('captions.fx', 'number', null, { min: 0, max: 1, nullable: true, hidden: true, label: 'Caption x', doc: 'Dragged caption centre, across.' }),
  f('captions.fy', 'number', null, { min: 0, max: 1, nullable: true, hidden: true, label: 'Caption y', doc: 'Dragged caption centre, down.' }),

  // ── typography ──
  f('typography.titleFont', 'string', 'house', { label: 'Title face', doc: 'Face for title cards and lower thirds; house is Fetch\'s own.', undrawn: true }),

  // ── focus ──
  f('focus.dim', 'number', 0.5, { min: 0, max: 0.9, step: 0.05, label: 'Spotlight dim', doc: 'How dark the frame goes round a spotlight.', classic: false }),
  f('focus.lift', 'number', 1.04, { min: 1, max: 1.15, step: 0.01, unit: 'x', label: 'Lift', doc: 'How far a lifted element rises.', classic: false }),
  f('focus.loupe', 'number', 2.2, { min: 1.4, max: 4, step: 0.1, unit: 'x', label: 'Loupe',
    doc: 'How far a loupe magnifies its area. The inset sits beside that area, or under it where there is no room beside.', classic: false }),
  f('focus.arrow', 'number', 1, { min: 0.6, max: 1.8, step: 0.05, unit: 'x', label: 'Arrow',
    doc: 'How large a pointing arrow is drawn. It stands outside the box it aims at and points at the nearest edge, so the thing it points at is never under it; a larger arrow needs more clear room beside that box and is shortened, or dropped, where there is none.', classic: false }),
]

const BY_PATH = new Map(FIELDS.map(x => [x.path, x]))

module.exports = { SECTIONS, FIELDS, BY_PATH, GRADIENTS, MESHES, ASPECTS }
