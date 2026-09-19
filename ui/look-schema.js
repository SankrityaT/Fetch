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
// gpu: true marks a field the new compositor draws and today's ffmpeg renderer does
// not. It is stored and validated like any other (an agent can set it, and it survives
// round trips), but the inspector hides it and apply_look warns that it is not drawn
// yet, rather than letting a setting silently do nothing.
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
  { id: 'captions', label: 'Captions', doc: 'Burned-in captions and their style.' },
  { id: 'typography', label: 'Typography', doc: 'Faces for titles and labels.' },
  { id: 'focus', label: 'Focus', doc: 'How spotlights, lifts and steps are drawn.' },
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
}

const ASPECTS = ['auto', '16:9', '1:1', '9:16', '4:3', '4:5']

// f(path, type, default, extra): extra carries min, max, step, unit, options, label,
// doc, when (a condition on other fields), advanced, gpu, hidden.
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
    doc: 'A browser take\'s tabs and toolbar. remove crops them off where Fetch knows the page\'s place in the window ' +
      '(takes an agent recorded while reporting its pointer with viewport); keep leaves them; clean draws a plain synthetic frame (new renderer).',
    gpuOptions: ['clean'] }),
  f('frame.scale', 'number', 1, { min: 0.5, max: 1.2, step: 0.01, unit: 'x', label: 'Scale', doc: 'Size of the framed take.', gpu: true, advanced: true }),
  f('frame.offsetX', 'number', 0, { min: -0.5, max: 0.5, step: 0.01, unit: '%', label: 'Offset X', doc: 'Moves the framed take across.', gpu: true, advanced: true }),
  f('frame.offsetY', 'number', 0, { min: -0.5, max: 0.5, step: 0.01, unit: '%', label: 'Offset Y', doc: 'Moves the framed take down.', gpu: true, advanced: true }),
  f('frame.tilt', 'number', 0, { min: -20, max: 20, step: 0.5, unit: 'deg', label: 'Tilt', doc: 'A 3D tilt of the framed take.', gpu: true, advanced: true }),
  f('frame.border', 'number', 0, { min: 0, max: 12, step: 0.5, unit: 'px', label: 'Border', doc: 'A hairline border round the take, in pixels at 1080p.', gpu: true }),
  f('frame.borderColor', 'color', '#FFFFFF', { label: 'Border colour', doc: 'Colour of the border.', gpu: true, when: { 'frame.border': '>0' } }),

  // ── device ──
  f('device.kind', 'enum', 'none', { options: ['none', 'browser', 'window', 'laptop', 'phone'], label: 'Device',
    doc: 'A drawn frame around the take. Generic shapes, never a real product.', gpu: true, gpuOptions: ['browser', 'window', 'laptop', 'phone'] }),

  // ── background ──
  f('background.kind', 'enum', 'none', { options: ['none', 'solid', 'gradient', 'mesh', 'image', 'video-blur'], label: 'Background',
    doc: 'none shows the take edge to edge. solid, gradient, image and video-blur (the take itself, blurred and deepened) frame it with padding and a shadow.',
    gpuOptions: ['mesh'] }),
  f('background.gradient', 'enum', 'dusk', { options: Object.keys(GRADIENTS), label: 'Gradient',
    doc: 'Which gradient: dusk (gold), ember, mint, violet, slate, ink (warm near-black).', when: { 'background.kind': 'gradient' } }),
  f('background.color', 'color', '#1A1714', { label: 'Colour', doc: 'The solid colour, #RRGGBB.', when: { 'background.kind': 'solid' } }),
  f('background.image', 'asset', null, { label: 'Image',
    doc: 'An image backdrop id from list_looks backgrounds (img:...).', when: { 'background.kind': 'image' } }),
  f('background.imageBlur', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Image blur', doc: 'Softens the image.', gpu: true, when: { 'background.kind': 'image' } }),
  f('background.imageDim', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Image dim', doc: 'Darkens the image.', gpu: true, when: { 'background.kind': 'image' } }),
  f('background.blurAmount', 'number', 0.5, { min: 0, max: 1, step: 0.05, label: 'Blur amount',
    doc: 'How far the take is blurred behind itself.', gpu: true, when: { 'background.kind': 'video-blur' } }),

  // ── treatment ──
  f('treatment.motionBlur', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Motion blur', doc: 'Blur along a zoom\'s movement.', gpu: true }),
  f('treatment.autoLevel', 'bool', false, { label: 'Auto level', doc: 'Evens the take\'s exposure.', gpu: true }),
  f('treatment.brightness', 'number', 0, { min: -1, max: 1, step: 0.05, label: 'Brightness', doc: 'Lighter or darker.', gpu: true }),
  f('treatment.contrast', 'number', 0, { min: -1, max: 1, step: 0.05, label: 'Contrast', doc: 'More or less contrast.', gpu: true }),
  f('treatment.saturation', 'number', 0, { min: -1, max: 1, step: 0.05, label: 'Saturation', doc: '-1 is black and white.', gpu: true }),
  f('treatment.tint', 'color', '#F0A93C', { label: 'Tint', doc: 'A colour laid over the frame.', gpu: true }),
  f('treatment.tintAmount', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Tint amount', doc: 'How strong the tint is.', gpu: true }),
  f('treatment.haze', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Haze', doc: 'Lifted blacks, like a soft lens.', gpu: true }),
  f('treatment.blur', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Blur', doc: 'Softens the whole frame.', gpu: true, advanced: true }),
  f('treatment.bokeh', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Bokeh', doc: 'Lens blur on the background.', gpu: true }),
  f('treatment.bloom', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Bloom', doc: 'Bright areas glow.', gpu: true }),
  f('treatment.halation', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Halation', doc: 'A warm film glow round highlights.', gpu: true }),
  f('treatment.aberration', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Aberration', doc: 'Colour fringes at the edges.', gpu: true, advanced: true }),
  f('treatment.vignette', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Vignette', doc: 'Darker corners.', gpu: true }),

  // ── grain ──
  f('grain.film', 'number', 0, { min: 0, max: 1, step: 0.05, label: 'Film grain', doc: 'Moving film grain.', gpu: true }),
  f('grain.dither', 'bool', true, { label: 'Dither', doc: 'Breaks up banding in gradients.', gpu: true }),

  // ── motion ──
  f('motion.zoomDepth', 'number', 1.7, { min: 1.2, max: 2.4, step: 0.1, unit: 'x', label: 'Auto zoom depth',
    doc: 'How far auto zoom pushes in on each click.' }),
  f('motion.zoomEase', 'enum', 'smooth', { options: ['smooth', 'snappy', 'gentle'], label: 'Zoom easing', doc: 'The feel of a zoom\'s move.', gpu: true }),
  f('motion.fadeIn', 'number', 0, { min: 0, max: 3, step: 0.1, unit: 's', label: 'Fade in', doc: 'Fade from black, picture and sound, at the start.' }),
  f('motion.fadeOut', 'number', 0, { min: 0, max: 3, step: 0.1, unit: 's', label: 'Fade out', doc: 'Fade to black at the end.' }),
  f('motion.cutTransition', 'enum', 'none', { options: ['none', 'crossfade', 'zoom'], label: 'Cut transition', doc: 'How one clip meets the next.', gpu: true }),

  // ── camera ──
  f('camera.shape', 'enum', 'circle', { options: ['circle', 'rounded'], label: 'Bubble shape', doc: 'The camera bubble\'s shape.', gpu: true }),
  f('camera.ring', 'bool', true, { label: 'Ring', doc: 'A light ring round the bubble.', gpu: true }),

  // ── cursor ──
  f('cursor.show', 'bool', true, { label: 'Show cursor', doc: 'Draw the agent\'s cursor from the take\'s pointer track.' }),
  f('cursor.hideSystem', 'enum', 'auto', { options: ['auto', 'hide', 'keep'], label: 'Mac pointer',
    doc: 'The Mac\'s own pointer where the take has it in the pixels. auto lifts it out only when the drawn cursor replaces it.' }),
  f('cursor.size', 'number', 1, { min: 0.6, max: 2, step: 0.05, unit: 'x', label: 'Cursor size', doc: 'Size of the drawn cursor.', gpu: true }),
  f('cursor.smoothing', 'number', 0.5, { min: 0, max: 1, step: 0.05, label: 'Smoothing', doc: 'How much the cursor\'s path is smoothed.', gpu: true }),
  f('cursor.ripple', 'bool', true, { label: 'Click ripple', doc: 'A gold ripple on each click.', gpu: true }),

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
  f('typography.titleFont', 'string', 'house', { label: 'Title face', doc: 'Face for title cards and lower thirds; house is Fetch\'s own.', gpu: true }),

  // ── focus ──
  f('focus.dim', 'number', 0.5, { min: 0, max: 0.9, step: 0.05, label: 'Spotlight dim', doc: 'How dark the frame goes round a spotlight.', gpu: true }),
  f('focus.lift', 'number', 1.04, { min: 1, max: 1.15, step: 0.01, unit: 'x', label: 'Lift', doc: 'How far a lifted element rises.', gpu: true }),
]

const BY_PATH = new Map(FIELDS.map(x => [x.path, x]))

module.exports = { SECTIONS, FIELDS, BY_PATH, GRADIENTS, ASPECTS }
