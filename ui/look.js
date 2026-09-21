// Looks: validating, merging, diffing and describing the Look spec (ui/look-schema.js).
//
// A look is a nested object, section then field: { frame: { padding: 0.06 }, ... },
// plus `preset`, the name of the preset it was last rebased on. Stored whole in the
// edit document (doc.look), so a reader never has to know the defaults; shown to an
// agent as preset plus diff, which is short.
//
// Every entry point clamps rather than throws. An agent sending padding 0.5 gets 0.22
// and a warning naming the range, which is more useful than a refusal and never
// leaves the document half-applied.
//
// Pure apart from reading and writing preset files, which take their folder as an
// argument, so test/look.test.js runs all of it under plain node.

const S = require('./look-schema')

const clone = v => (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)

function getPath(o, p) {
  let cur = o
  for (const k of p.split('.')) { if (!isObj(cur)) return undefined; cur = cur[k] }
  return cur
}
function setPath(o, p, v) {
  const ks = p.split('.')
  let cur = o
  for (const k of ks.slice(0, -1)) { if (!isObj(cur[k])) cur[k] = {}; cur = cur[k] }
  cur[ks[ks.length - 1]] = v
}

function defaults() {
  const out = { preset: 'fetch-default' }
  for (const x of S.FIELDS) setPath(out, x.path, clone(x.default))
  return out
}

// Leaves of a patch as [path, value]. Accepts nested sections and flat 'a.b' keys, so
// { frame: { padding: 0.1 } } and { 'frame.padding': 0.1 } mean the same. A section
// sent as null is every field in it.
function leaves(patch) {
  const out = []
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'preset') continue
    if (k.includes('.')) { out.push([k, v]); continue }
    if (S.SECTIONS.some(s => s.id === k)) {
      if (v === null) { for (const x of S.FIELDS) if (x.section === k) out.push([x.path, null]); continue }
      if (isObj(v)) { for (const [kk, vv] of Object.entries(v)) out.push([`${k}.${kk}`, vv]); continue }
    }
    out.push([k, v])
  }
  return out
}

const round4 = n => Math.round(n * 10000) / 10000
const rangeText = x => `${x.min} to ${x.max}${x.unit && x.unit !== '%' ? ' ' + x.unit : ''}`

// A shape as a number (w/h) or 'W:H' to one of the named ones, or null.
function aspectOf(v) {
  if (v == null || v === '' || v === 'auto') return 'auto'
  let n = typeof v === 'number' ? v : NaN
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/)
    n = m ? +m[1] / +m[2] : +v
  }
  if (!(n > 0)) return null
  let best = null, gap = Infinity
  for (const a of S.ASPECTS) {
    if (a === 'auto') continue
    const [w, h] = a.split(':').map(Number)
    const d = Math.abs(w / h - n)
    if (d < gap) { gap = d; best = a }
  }
  return gap < 0.03 ? best : null
}
// '16:9' to 1.7778, 'auto' to null
function aspectNumber(a) {
  if (!a || a === 'auto') return null
  const [w, h] = String(a).split(':').map(Number)
  return w > 0 && h > 0 ? round4(w / h) : null
}

// One value against its field: { value } or { value, warning }.
function check(x, v) {
  const fallback = warning => ({ value: clone(x.default), warning })
  if (v === null || v === undefined) return { value: clone(x.default) }
  switch (x.type) {
    case 'number': {
      const n = typeof v === 'string' && v.trim().endsWith('%') ? parseFloat(v) / 100 : +v
      if (!Number.isFinite(n)) return fallback(`${x.path} must be a number (${rangeText(x)}); kept ${x.default}`)
      if (x.min != null && n < x.min) return { value: x.min, warning: `${x.path} ${n} is below its range (${rangeText(x)}), so ${x.min} was used` }
      if (x.max != null && n > x.max) return { value: x.max, warning: `${x.path} ${n} is above its range (${rangeText(x)}), so ${x.max} was used` }
      return { value: round4(n) }
    }
    case 'bool':
      if (typeof v === 'boolean') return { value: v }
      if (v === 'true' || v === 1 || v === 'on') return { value: true }
      if (v === 'false' || v === 0 || v === 'off') return { value: false }
      return fallback(`${x.path} must be true or false; kept ${x.default}`)
    case 'enum': {
      if (x.path === 'frame.aspect') {
        const a = aspectOf(v)
        return a ? { value: a } : fallback(`${x.path} must be one of ${x.options.join(', ')}; kept ${x.default}`)
      }
      const s = String(v).trim().toLowerCase()
      const hit = x.options.find(o => o.toLowerCase() === s)
      return hit ? { value: hit } : fallback(`${x.path} must be one of ${x.options.join(', ')}; kept ${x.default}`)
    }
    case 'color': {
      const m = String(v).trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
      if (!m) return fallback(`${x.path} must be a colour as #RRGGBB; kept ${x.default}`)
      const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1]
      return { value: '#' + h.toUpperCase() }
    }
    case 'string': {
      const s = String(v).trim().slice(0, 80)
      return s ? { value: s } : { value: clone(x.default) }
    }
    case 'asset':
      return { value: String(v).trim().slice(0, 400) || null }
  }
  return { value: clone(x.default) }
}

// Presets and saved looks. Built-in ones ship in ui/looks/*.json; a person's own are
// in userData/looks. Each file is { name, label, look }, the look a patch on defaults.
function readLooks(dir, mine) {
  const fs = require('fs'), path = require('path')
  let files = []
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort() } catch { return [] }
  const out = []
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      const name = String(j.name || f.replace(/\.json$/, ''))
      // `for` is the take a look suits, in the words somebody would ask in. It is what
      // stops a look being chosen by the sound of its name (ui/review.js reads it).
      out.push({ name, label: j.label || name, doc: j.doc || '', for: j.for || '', look: j.look || {}, mine: !!mine })
    } catch {}
  }
  return out
}
const builtinDir = () => require('path').join(__dirname, 'looks')
let builtinCache = null
function builtins() {
  if (!builtinCache) {
    const order = ['fetch-default', 'clean', 'studio', 'film', 'noir', 'paper', 'mono-print']
    builtinCache = readLooks(builtinDir(), false)
      .sort((a, b) => (order.indexOf(a.name) + 1 || 99) - (order.indexOf(b.name) + 1 || 99))
  }
  return builtinCache
}
// every look a person or agent can pick, the built-in ones first
function list(userDir) {
  const mine = userDir ? readLooks(userDir, true) : []
  const names = new Set(builtins().map(p => p.name))
  return [...builtins(), ...mine.filter(p => !names.has(p.name))]
}
function findPreset(name, userDir) {
  const key = String(name || '').trim().toLowerCase()
  return list(userDir).find(p => p.name.toLowerCase() === key || p.label.toLowerCase() === key) || null
}

// what choosing a preset leaves alone (fields, or whole sections)
const KEPT_BY_PRESET = ['frame.aspect', 'frame.chrome', 'captions', 'motion', 'cursor']

// The two frame.chrome settings that need the page's place in the window: remove crops
// the real chrome off, clean crops it off and draws Fetch's own in its place. Neither
// can happen on a take that never recorded where the page sits (ui/fetchdoc.js).
const CROPS_CHROME = new Set(['remove', 'clean'])

/**
 * A look checked against the schema: { look, warnings }. `base` is what fields left
 * out keep (defaults when absent). Unknown fields are dropped and named.
 */
function validate(input, { base = null, userDir = null } = {}) {
  const warnings = []
  let look = base ? clone(base) : defaults()
  // v1 bags (zoomAmt, bdInset...) are understood rather than refused
  if (isV1Look(input)) input = v1Patch(input)
  if (input && input.preset != null) {
    const p = findPreset(input.preset, userDir)
    if (p) {
      const was = look
      look = { ...merge(defaults(), p.look).look, preset: p.name }
      // A preset restyles; it does not undo choices about the video itself. The shape,
      // the chrome, captions, motion and the cursor stay as they were unless the preset
      // names them: picking Studio used to reset a 9:16 short to its take's shape.
      const named = new Set(leaves(p.look).map(([k]) => k))
      for (const x of S.FIELDS) {
        if (!KEPT_BY_PRESET.some(k => x.path === k || x.section === k) || named.has(x.path)) continue
        const v = getPath(was, x.path)
        if (v !== undefined) setPath(look, x.path, clone(v))
      }
    } else warnings.push(`no look named ${input.preset}; list_looks names them`)
  }
  // null puts a field back to the look's preset, as the inspector's reset does; the
  // schema default alone reset a Studio look's padding to Fetch's
  let ref = null
  const refOf = () => {
    if (!ref) {
      const p = look.preset && look.preset !== 'fetch-default' ? findPreset(look.preset, userDir) : null
      ref = p ? validate(p.look, { userDir }).look : defaults()
    }
    return ref
  }
  for (const [p, v] of leaves(input)) {
    const x = S.BY_PATH.get(p)
    if (!x) {
      const near = S.FIELDS.find(f => f.path.split('.')[1] === String(p).split('.').pop())
      warnings.push(`${p} is not a look field, so it was ignored${near ? ` (did you mean ${near.path}?)` : ''}`)
      continue
    }
    if (v === null && x.nullable) { setPath(look, p, null); continue }
    if (v === null) { setPath(look, p, clone(getPath(refOf(), p))); continue }
    const r = check(x, v)
    setPath(look, p, r.value)
    if (r.warning) warnings.push(r.warning)
  }
  // anything a hand-edited file left out
  for (const x of S.FIELDS) {
    const cur = getPath(look, x.path)
    if (cur === undefined) setPath(look, x.path, clone(x.default))
    else if (!(cur === null && x.nullable)) {
      const r = check(x, cur)
      if (r.warning) setPath(look, x.path, r.value)
    }
  }
  if (typeof look.preset !== 'string') look.preset = 'fetch-default'
  return { look, warnings }
}

// Deep merge of a patch onto a look: absent fields kept, null resets a field (or a
// section) to its default, { preset } rebases on that preset before the rest applies.
function merge(base, patch, opts = {}) {
  return validate(patch || {}, { ...opts, base: resolve(base) })
}

// The whole look, every field present and in range
function resolve(look) {
  if (look && isObj(look) && !isV1Look(look)) {
    const full = defaults()
    for (const [p, v] of leaves(look)) if (S.BY_PATH.has(p) && v !== undefined) setPath(full, p, v)
    if (typeof look.preset === 'string') full.preset = look.preset
    return validate({}, { base: full }).look
  }
  return validate(look || {}).look
}

// What b changes from a, as a patch (nested), or {} when they agree
function diff(a, b) {
  const A = resolve(a), B = resolve(b)
  const out = {}
  for (const x of S.FIELDS) {
    const va = getPath(A, x.path), vb = getPath(B, x.path)
    if (JSON.stringify(va) !== JSON.stringify(vb)) setPath(out, x.path, vb)
  }
  return out
}

// A look as an agent reads it: the preset it came from and what differs from it
function compact(look, userDir) {
  const L = resolve(look)
  const p = findPreset(L.preset, userDir)
  const base = p ? merge(defaults(), p.look).look : defaults()
  return { preset: p ? p.name : 'fetch-default', changes: diff(base, L) }
}

// ── which renderer draws it ─────────────────────────────────────────────
// The compositor draws every field in the schema and is the renderer for every format
// with a picture in it, so it is the default answer. A sound file, and a preview still
// taken off the classic path, go to the classic ffmpeg renderer (ui/compositor/plan.js),
// which leaves the classic: false fields out; a shot is the compositor's, and asks with
// engine: 'gl'. Asking the engine rather than reading a flag is what keeps this
// true when the engines move, and they moved this round: GIF and WebM came over.
const GL_FORMATS = new Set(['mp4', 'mov', 'webm', 'gif'])
// An export with no picture in it. A look has nothing to say about an m4a, and saying
// that grain.film is not drawn on a sound file is noise an agent has to read past.
const SOUND_FORMATS = new Set(['m4a', 'mp3', 'wav'])

// ctx: { engine } is what render-host.pickEngine already answered; { format, still } is
// the same question before an export exists.
function engineOf(ctx = {}) {
  if (ctx.engine) return String(ctx.engine) === 'classic' ? 'classic' : 'gl'
  if (ctx.still != null) return 'classic'
  if (ctx.format) return GL_FORMATS.has(String(ctx.format).toLowerCase()) ? 'gl' : 'classic'
  return 'gl'
}
// Does that engine draw this field? Nothing draws an undrawn one, on any engine.
const draws = (x, engine = 'gl') => !x.undrawn && (engine !== 'classic' || x.classic !== false)
// and this value of it: some options of a drawn field are the compositor's alone
const drawsValue = (x, v, engine = 'gl') =>
  draws(x, engine) && !(engine === 'classic' && x.classicOptions && x.classicOptions.includes(v))

// Is a field shown, given the rest of the look? when: { path: 'value' | '!value' | '>n' }
function visible(x, look) {
  if (!x.when) return true
  for (const [p, want] of Object.entries(x.when)) {
    const v = getPath(look, p)
    const w = String(want)
    if (w.startsWith('!')) { if (String(v) === w.slice(1)) return false }
    else if (w.startsWith('>')) { if (!(+v > +w.slice(1))) return false }
    else if (String(v) !== w) return false
  }
  return true
}

// The sections a person sees, in schema order: the fields the engine that will draw
// them draws, and only the options it draws. The editor's stage is the compositor, so
// that is the default, and the Look tab offers what the export will honour.
// `all` keeps the ones nothing draws yet, which the agent docs still name.
function sections({ engine = 'gl', hidden = false, advanced = true, all = false } = {}) {
  return S.SECTIONS.map(s => ({
    ...s,
    fields: S.FIELDS.filter(x => x.section === s.id && (all || draws(x, engine)) &&
      (hidden || !x.hidden) && (advanced || !x.advanced))
      .map(x => (engine === 'classic' && x.options && x.classicOptions)
        ? { ...x, options: x.options.filter(o => !x.classicOptions.includes(o)) } : x),
  })).filter(s => s.fields.length)
}

// Which engine a field needs, marked in as few characters as will carry it: the legend
// below says it once, and the whole schema is read on every look job.
const engineNote = x => x.undrawn ? ' [undrawn]'
  : x.classic === false ? ' [classic]'
  : x.classicOptions ? ` [classic: ${x.classicOptions.join(', ')}]` : ''

// The schema as an agent reads it: one line a field, grouped by section. Every field,
// including the two a person sets by dragging the captions on the stage.
function describe() {
  const lines = ['A field marked [classic] is drawn in every format with a picture in it and left out of a ' +
    'still frame and a sound file, which the classic renderer draws. [undrawn] is a field nothing draws yet.']
  for (const s of sections({ hidden: true, all: true })) {
    lines.push(`${s.id}: ${s.doc}`)
    for (const x of s.fields) {
      const kind = x.type === 'number' ? `${x.min} to ${x.max}${x.unit && x.unit !== '%' ? ' ' + x.unit : ''}`
        : x.type === 'enum' ? x.options.join('|') : x.type === 'color' ? '#RRGGBB' : x.type
      lines.push(`  ${x.path} (${kind}, default ${JSON.stringify(x.default)})${engineNote(x)}: ${x.doc}`)
    }
  }
  return lines.join('\n')
}

// Warnings about a look as a whole: fields nothing draws yet, fields the renderer that
// will actually run leaves out, and settings whose effect depends on the take.
// ctx: { engine | format | still, marks, viewport: bool, browser: bool, images: [ids] }
// With no engine and no format in ctx the compositor is the answer, because it draws
// the stage and every MP4 and MOV. Nothing here is said about a field the engine draws.
function warnings(look, ctx = {}) {
  const L = resolve(look), D = defaults()
  if (ctx.format && SOUND_FORMATS.has(String(ctx.format).toLowerCase())) return []
  const engine = engineOf(ctx)
  const out = []
  const dead = [], left = []
  for (const x of S.FIELDS) {
    if (!visible(x, L)) continue
    const v = getPath(L, x.path)
    const set = JSON.stringify(v) !== JSON.stringify(getPath(D, x.path))
    if (x.undrawn) { if (set) dead.push(x.path) }
    else if (engine === 'classic') {
      if (x.classic === false) { if (set) left.push(x.path) }
      else if (x.classicOptions && x.classicOptions.includes(v)) left.push(`${x.path} ${v}`)
    }
  }
  if (dead.length) {
    out.push(`${dead.join(', ')} ${dead.length === 1 ? 'is' : 'are'} saved but nothing draws ${dead.length === 1 ? 'it' : 'them'} yet; the export uses the rest of the look.`)
  }
  // A loupe and an arrow are the compositor's alone, and they are the marks that would
  // simply not appear rather than appear differently, so they are named beside the
  // look's own fields.
  const loupes = (ctx.marks || []).map(m => ({ k: (m && m.kind ? m.kind : m), id: m && m.id }))
    .filter(m => m.k === 'loupe' || m.k === 'arrow')
    .map(m => (m.id ? `${m.k} ${m.id}` : `a ${m.k}`))
  if (engine === 'classic' && (left.length || loupes.length)) {
    const what = ctx.format ? `${String(ctx.format).toUpperCase()} output` : ctx.still != null ? 'A still frame' : 'This export'
    const items = left.concat(loupes.length ? [`the ${loupes.join(', ')}`] : [])
    // The remedy is only a remedy when it names a format that was not already asked
    // for: an MP4 that fell back to the classic renderer is not fixed by asking for an
    // MP4 again, and the export result already says under classic_because what kept
    // the compositor off it.
    const already = GL_FORMATS.has(String(ctx.format || '').toLowerCase())
    out.push(`${what} is drawn by the classic renderer, which does not draw ${items.join(', ')}. ` +
      'The rest of the look is drawn. ' + (already
        ? 'classic_because in this result says what kept the compositor off it.'
        : 'Export MP4 or MOV to get all of it.'))
  }
  if (L.frame.aspect !== 'auto' && L.background.kind === 'none') {
    out.push(`frame.aspect ${L.frame.aspect} with background none: the space round the take is filled with the take itself, blurred and darkened, never black bars.`)
  }
  // A drawn frame and a turn both need ground to sit in. With no background the take is
  // the whole output: there is nowhere for a bezel or a shadow to go, and turning it
  // would open black wedges at the corners, which the output never draws.
  if (L.background.kind === 'none' && (L.device.kind !== 'none' || L.frame.chrome === 'clean' || L.frame.tilt !== 0)) {
    out.push('background none: a drawn device and frame.tilt both need ground round the take, so neither is drawn. Pick a background, or a shape, which fills itself.')
  }
  if (L.background.kind === 'image' && !L.background.image) out.push('background.kind is image but background.image is not set, so dusk is used.')
  // the renderer falls back to dusk for an id it cannot find, which read as the look working
  else if (L.background.kind === 'image' && Array.isArray(ctx.images) && !ctx.images.includes(L.background.image)) {
    out.push(`background.image ${L.background.image} is not one of the images list_looks names, so dusk is used.`)
  }
  // A capture records no viewport, so frame.chrome clean has nothing to stand a drawn bar
  // above and draws nothing at all. Silence is the worst of the three answers here: the
  // field reads as set and the picture never changes. It is said here rather than in the
  // picture rubric because the call that fixes it turns double-chrome on, and advice that
  // trips the next rule is not safe to follow.
  const stillNoChrome = !!ctx.still && L.frame.chrome === 'clean' && !ctx.viewport
  if (stillNoChrome) {
    out.push('frame.chrome clean: a capture does not record where the page sits in the browser window, so no browser frame is drawn on a still. device.kind browser draws a shell round the whole capture instead.')
  }
  if (!stillNoChrome && CROPS_CHROME.has(L.frame.chrome) && ctx.browser && ctx.viewport === false) {
    out.push(`frame.chrome ${L.frame.chrome}: this take does not record where the page sits in the browser window, so its tabs and toolbar stay. Crop them off with crop instead.` +
      (L.frame.chrome === 'clean' ? ' Fetch draws no browser frame here either: round a real one it would be two browsers.' : ''))
  }
  // A device take whose glass was never measured is the simulator's version of the same
  // silence: the crop cannot happen, so the Simulator's own toolbar and bezel stay in the
  // picture and a drawn phone over them comes out as a plain frame rather than a phone.
  if (!stillNoChrome && CROPS_CHROME.has(L.frame.chrome) && ctx.device && ctx.viewport === false) {
    out.push(`frame.chrome ${L.frame.chrome}: the device screen rectangle for this take was never measured, so the ` +
      'Simulator\'s toolbar and the outline round the screen stay. Record or capture the window again to measure it, ' +
      'or crop them off with crop. A phone drawn over it is a plain frame, not a phone, so the picture has one device in it.')
  }
  return out
}

// ── v1 documents ────────────────────────────────────────────────────────
// Before the Look spec a document kept ten flat values in `look` and the rest of the
// look at its top level. Read forever, never written.
const V1_KEYS = ['zoomAmt', 'bdInset', 'bdRadius', 'burnCaps', 'denoise', 'loudnorm', 'gain', 'fadeIn', 'fadeOut', 'music']
function isV1Look(look) {
  if (!isObj(look)) return false
  if (S.SECTIONS.some(s => isObj(look[s.id]))) return false
  return V1_KEYS.some(k => k in look)
}

// A v1 backdrop id to a background
function backgroundFromId(id, file) {
  const s = id == null ? '' : String(id)
  if (!s) return { kind: 'none' }
  if (s === 'blur') return { kind: 'video-blur' }
  if (s.startsWith('img:')) return { kind: 'image', image: s }
  const m = s.match(/^(?:color|solid):(#?[0-9a-f]{6})$/i)
  if (m) return { kind: 'solid', color: '#' + m[1].replace('#', '').toUpperCase() }
  if (S.GRADIENTS[s]) return { kind: 'gradient', gradient: s }
  return file ? { kind: 'image', image: s } : { kind: 'gradient', gradient: 'dusk' }
}
// and back, for the renderer and for anything that still reads backdrop ids
function backdropId(look) {
  const b = resolve(look).background
  if (b.kind === 'none') return null
  if (b.kind === 'video-blur') return 'blur'
  if (b.kind === 'image') return b.image || 'dusk'
  if (b.kind === 'solid') return 'color:' + b.color
  if (b.kind === 'gradient') return b.gradient
  // A mesh answers with its own palette's name: the compositor reads background.kind
  // from the look and draws the control points, and the classic renderer, which has no
  // mesh, draws the flat gradient of that name rather than something unrelated.
  if (b.kind === 'mesh') return b.mesh || 'dusk'
  return 'dusk'
}

// Only the v1 values present, as a patch: { look: { gain: 3 } } from an older agent
// must not reset the padding it never mentioned.
function v1Patch(L = {}) {
  const out = {}
  const map = { bdInset: 'frame.padding', bdRadius: 'frame.radius', zoomAmt: 'motion.zoomDepth', fadeIn: 'motion.fadeIn', fadeOut: 'motion.fadeOut' }
  for (const [k, p] of Object.entries(map)) if (L[k] != null) out[p] = L[k]
  if (L.burnCaps != null) out['captions.show'] = !!L.burnCaps
  return out
}

/**
 * The look and audio settings of a v1 document: { look, audio }. Everything v1 kept
 * outside `look` (backdrop, outAspect, capStyle, hideMacCursor) comes along. A take
 * made before chrome removal keeps its chrome, so an old export is not re-cropped.
 */
function fromV1(doc = {}) {
  const L = isObj(doc.look) ? doc.look : {}
  const look = defaults()
  const set = (p, v) => { if (v !== undefined && v !== null) setPath(look, p, v) }
  for (const [p, v] of Object.entries(v1Patch(L))) set(p, v)
  set('frame.aspect', aspectOf(doc.outAspect) || 'auto')
  set('frame.chrome', 'keep')
  const bg = backgroundFromId(doc.backdrop, doc.backdropFile)
  for (const [k, v] of Object.entries(bg)) set('background.' + k, v)
  const cs = isObj(doc.capStyle) ? doc.capStyle : {}
  for (const k of ['font', 'scale', 'colour', 'position', 'highlight', 'fx', 'fy']) set('captions.' + k, cs[k])
  if (doc.hideMacCursor === true) set('cursor.hideSystem', 'hide')
  if (doc.hideMacCursor === false) set('cursor.hideSystem', 'keep')
  const audio = {}
  for (const k of ['denoise', 'loudnorm', 'gain', 'music']) if (k in L) audio[k] = L[k]
  return { look: validate(look).look, audio }
}

// Relative luminance of #RRGGBB, 0 to 1
function luma(hex) {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i)
  if (!m) return 0
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// The part of applyEdit's options a look decides, for today's ffmpeg renderer
function toClassic(look) {
  const L = resolve(look)
  const c = { ...L.captions }
  // Framed captions sit in a band on the background, below the take. White there
  // vanished on a light ground (paper, mono print), so default white turns warm ink.
  if (L.background.kind === 'solid' && luma(L.background.color) > 0.45 && c.colour === '#FFFFFF' &&
      c.position === 'bottom' && c.fx == null) c.colour = '#1A1714'
  const hide = L.cursor.hideSystem
  return {
    backdrop: backdropId(L),
    backdropAspect: aspectNumber(L.frame.aspect),
    inset: L.frame.padding,
    radius: L.frame.radius,
    shadow: L.frame.shadow,
    captions: !!c.show,
    captionStyle: { font: c.font, scale: c.scale, colour: c.colour, position: c.position, highlight: c.highlight,
      ...(c.fx != null && c.fy != null ? { fx: c.fx, fy: c.fy } : {}) },
    fadeIn: L.motion.fadeIn,
    fadeOut: L.motion.fadeOut,
    autoZoomOpts: { zoom: L.motion.zoomDepth, curve: L.motion.zoomEase },
    hideMacCursor: hide === 'hide' ? true : hide === 'keep' ? false : null,
    cursor: !!L.cursor.show,
    chrome: L.frame.chrome,
  }
}

// Save a look under a name in dir; returns the entry list() would give it
function save(dir, name, look, label) {
  const fs = require('fs'), path = require('path')
  const clean = String(name || '').trim().replace(/[^\w .-]+/g, '').replace(/\s+/g, ' ').slice(0, 48)
  if (!clean) throw new Error('a look needs a name')
  const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'look'
  if (builtins().some(p => p.name === slug)) throw new Error(`${clean} is a built-in look; pick another name`)
  fs.mkdirSync(dir, { recursive: true })
  const L = resolve(look)
  const entry = { name: slug, label: label || clean, look: diff(defaults(), L) }
  fs.writeFileSync(path.join(dir, slug + '.json'), JSON.stringify(entry, null, 2))
  return { ...entry, mine: true }
}

// The crop shapes, one list rather than two that disagreed: the same set frame.aspect
// offers, with the crop track's own word for auto. The editor's chips and get_edit's
// options.cropAR both read it, so a person and an agent name the same shapes.
const CROP_ARS = ['free', ...S.ASPECTS.filter(a => a !== 'auto')]

module.exports = {
  defaults, validate, merge, resolve, diff, compact, visible, sections, describe, warnings,
  list, findPreset, save, fromV1, isV1Look, toClassic, backdropId, backgroundFromId,
  aspectOf, aspectNumber, getPath, setPath, V1_KEYS, v1Patch, luma, CROPS_CHROME,
  engineOf, draws, drawsValue, ASPECTS: S.ASPECTS, CROP_ARS,
}
