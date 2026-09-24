// Captions, title cards, lower thirds and labels as the compositor draws them: laid out
// with ui/overlays.js (the same phrasing, placement and styles the classic export's ASS
// uses), rasterised with Canvas2D into cached textures, and moved, faded and blurred on
// the GPU. Text is shaped by Chromium in both the editor and the render window, with
// the same fonts, so the stage and the file set every word alike.
//
// planText() fixes everything for an edit once; textAt() says what shows at one moment
// as a list of items: where each sits, how far in it is, and a paint function the
// rasteriser calls only when it has not drawn that item at that size before. Sizes are
// export pixels (the plan's), scaled to whatever the compositor draws at.
//
// planText and textAt are pure given a measure function (test/text.test.js);
// rasterItem and canvasMeasure need a canvas.

const O = require('../overlays')

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const GOLD = '#F0A93C', INK = '#1A1714', WHITE = '#FBFAF8', SHADE = '#0A0908'

// ── fonts ───────────────────────────────────────────────────────────────────
// The house faces are the system's own: SF Pro (Chromium's system-ui), its Display cut
// chosen by size, and SF Pro Rounded for step numerals. A face a person picked is used
// by its family name, bold, as the classic export cuts its bold instance.
// A title card and its subtitle used to be hard wired to SF Pro: a text layer carried
// a font, the card ignored it, and a card over a product's own screen came out in the
// system face whatever anybody picked. Both now take the layer's font, and fall back
// to SF Pro where it has none, which is what ROLE already said.
const SYSTEM = { 'SF Pro': 'system-ui, -apple-system', 'New York': 'ui-serif, "New York", Georgia', 'SF Mono': 'ui-monospace, "SF Mono", Menlo' }
const family = name => SYSTEM[name] || (name ? `"${String(name).replace(/"/g, '')}", system-ui` : SYSTEM['SF Pro'])
const ROLE = {
  caption: { weight: 700, family: null },
  title: { weight: 600, family: 'SF Pro' },
  sub: { weight: 500, family: 'SF Pro' },
  num: { weight: 700, family: 'SF Pro Rounded' },
}
function fontFor(role, px, name) {
  const r = ROLE[role] || ROLE.caption
  const fam = role === 'num' ? 'ui-rounded, "SF Pro Rounded", system-ui' : family(name || r.family || 'SF Pro')
  return `${r.weight} ${Math.max(1, px).toFixed(2)}px ${fam}`
}

// A width estimate when no canvas is at hand (tests): SF Pro Bold's running average
const estimate = (text, px) => String(text).length * px * 0.56

// ── the plan ────────────────────────────────────────────────────────────────
/**
 * Everything text-shaped in an edit, on the output clock.
 *   opts      toExportOpts' bag (captions, captionStyle, cues, texts)
 *   clock     source seconds to output seconds (Timeline.outClock, with .kept)
 *   span      output length
 *   W, H      the output frame
 *   box       the framed take's rect on it, or null
 *   capBox    what the captions are laid out against, which is the take's own place on
 *             the frame: with a device drawn, box is the screen inside it (plan.js)
 *   prepared  { captions: { cues, words, busy } } from prepare.js
 *   zooms     explicit zooms on the output clock (captions stay down inside one)
 *   still     what stillRoom settled before the take was placed, or null
 *   light     whether the ground is a light one, which is what still type reads off
 * Returns { phrases, cards, labels, still, st, box, capBox, frosted, reveal, close }.
 */
function planText(opts = {}, { clock, span, W, H, box = null, capBox = null, prepared = null, zooms = [],
  still = null, light = false } = {}) {
  const st = opts.captionStyle || {}
  const band = !!(box && (!st.position || st.position === 'bottom') && st.fx == null)
  let phrases = null
  // the take's word timings come with prepare.js; until they do (the editor's first
  // paint) the cues are shared out by word length, as alignWords does without them
  const cap = (prepared && prepared.captions) ||
    (Array.isArray(opts.cues) && opts.cues.length ? { cues: opts.cues, words: null, busy: [] } : null)
  if (opts.captions && cap) {
    const cues = Array.isArray(opts.cues) && opts.cues.length ? opts.cues : cap.cues || []
    const kept = clock.kept || (() => true)
    const toks = O.spokenWords(cues, cap.words).filter(w => kept(w.start))
      .map(w => ({ ...w, start: clock(w.start), end: clock(Math.max(w.start, w.end)) }))
    if (toks.length) phrases = O.captionPhrases(toks, band ? { wrapAt: O.BAND_WRAP } : {})
    if (phrases && cap.busy && cap.busy.length && !band && (!st.position || st.position === 'bottom') && st.fx == null) {
      phrases = O.placeCaptions(phrases, cap.busy, (zooms || []).map(z => ({ a: z.start, b: z.end })))
    }
  }
  const texts = clockTexts(opts.texts, clock)
    // The picture's own furniture is laid out against the take's rect, not against the
    // clock, so it is taken out here rather than sorted again in every pass below. Only
    // what the still block actually took: with no ground there is no still block, and
    // taking a full-span title out here as well deleted a title card from a recording
    // with not a word said about it. The styles a still invented have nowhere to stand
    // without a ground and go either way; 'title' was a title card before any of this
    // and is one again wherever nothing holds it.
    .filter(t => (still ? !stillStyle(t, span) : !stillOnly(t)))
  const cards = O.titleCards(texts, span).map(k => ({ ...k, span }))
  if (phrases) phrases = O.clearOfTitles(phrases, cards)
  const labels = texts.filter(t => O.textStyle(t, span) !== 'title').map(t => ({ ...t, style: O.textStyle(t, span) }))
  // as an opening card clears the framed take scales up into place; a closing card
  // gathers over it settling back (processor.backdropChain)
  const opening = cards.find(k => k.opens)
  const closing = cards.find(k => !k.opens && k.b >= span - 0.05)
  return {
    phrases: phrases && phrases.length ? O.phraseTimes(phrases) : [],
    cards, labels, st, box, capBox: capBox || box, W, H, span,
    // The picture's own type, now that the picture has a place. The room it takes was
    // settled before that (stillRoom), which is what the take was fitted into, and that
    // room was measured against the box the layout gave the picture. A drawn device
    // takes that box and hands back the screen inside it, so the headline is placed
    // against the box too and not against the screen: placed against the screen its
    // descenders sat on the shell's bezel and at a small size the whole line was inside
    // the title bar, and a caption ran across a laptop's foot. Same argument and same
    // answer as capBox, one line above. A pin still reads the screen, because `at` names
    // a thing on the page.
    still: placeStill(still, { W, H, box, outer: capBox || box, light, span }),
    // Every caption over the product gets the plate, framed or not. Unframed is the
    // case that needs it most: with no band to sit in, the caption fell back to the
    // shade's own blurred cloud of glyphs, a smudge with no boundary, on the default
    // look, at every caption. This is a divergence from the classic renderer and it is
    // meant: that path frosts only a framed caption, because libass cannot blur what is
    // under it and the alphamerge wants a band whose size is known exactly
    // (processor.js). The compositor knows the frame it is drawing and does not.
    frosted: true,
    reveal: opening ? { at: opening.b - O.cardLanding(opening), dur: O.cardLanding(opening) } : null,
    close: closing ? { at: closing.a, dur: Math.min(1.2, closing.fade + 0.5) } : null,
  }
}

// ── one moment ──────────────────────────────────────────────────────────────
// A caption was the one object in a film that appeared and disappeared rather than
// arriving and leaving (`.context/survey/motion-taste.md`). Measured as an alpha rather
// than as a count of ink over a threshold, its leave was never the two frames that
// reading said: it took 200 ms and no frame of it moved more than a tenth. What it did
// not have was a curve. Both ramps were straight lines with a corner at each end, the
// only object in the film that left in one, and the leave was the longer of the two.
//
// So the leave keeps its 160 ms and rides the S (O.fadeLevel), and the arrival goes to
// --dur-2, which makes it the longer of the pair, the way round DESIGN.md has it. A
// phrase handing straight on to the next one leaves quicker, because the incoming
// phrase's own arrival is already covering the last of it.
const CAP_IN = 0.2, CAP_OUT = 0.16, CAP_HANDOFF = 0.12
// The plate outlasts the words it holds by 60 ms, so the caption reads as the words
// going out and then the glass closing rather than as one object switching off. That is
// well inside FROST_JOIN, so a plate never reaches the next plate.
const CAP_TRAIL = 0.06
const GLOW = { frosted: { wide: 0.3, near: 0.42 }, plain: { wide: 0.52, near: 0.66 } }
const FROST_PAD = [0.45, 0.22], FROST_FEATHER = 0.3, FROST_JOIN = 0.3
// how much of the plate is scrim rather than the frame's own blurred light
const PLATE_SCRIM = 0.45

function layoutFor(p, W, H, st, box, measure, role) {
  const L = O.captionLayout(W, H, p.at === 'top' && st.fx == null ? { ...st, position: 'top' } : st, box)
  const lw = blockOf(p, L, measure, role).lw
  return lw > W * 0.9 ? { ...L, px: Math.max(12, Math.floor(L.px * (W * 0.9) / lw)) } : L
}
function blockOf(p, L, measure, role = 'caption') {
  const lineH = Math.round(L.px * 1.18)
  const lines = []
  let k = 0
  for (const n of p.lines) { lines.push(p.words.slice(k, k + n)); k += n }
  const widths = lines.map(l => measure(l.map(w => w.text).join(' '), L.px, role))
  const n = lines.length
  const top = L.an === 2 ? L.y - n * lineH : L.an === 8 ? L.y : L.y - (n * lineH) / 2
  return { lines, widths, lw: Math.max(...widths), top, h: n * lineH, lineH }
}

function captionItems(tp, t, measure, out) {
  const { W, H, st } = tp, box = tp.capBox || tp.box
  const fill = st.colour || '#FFFFFF'
  const hex = String(fill).replace('#', '')
  const inkText = /^[0-9a-f]{6}$/i.test(hex) &&
    (0.2126 * parseInt(hex.slice(0, 2), 16) + 0.7152 * parseInt(hex.slice(2, 4), 16) + 0.0722 * parseInt(hex.slice(4, 6), 16)) / 255 < 0.25
  const hl = st.highlight === 'none' ? null : st.highlight === 'pill' ? 'pill' : 'word'
  // a face the person picked is measured as itself
  const role = st.font && st.font !== 'SF Pro' ? st.font : 'caption'
  const ph = tp.phrases
  for (let i = 0; i < ph.length; i++) {
    const p = ph[i]
    // Both fades cut to the phrase's own life, as the classic path cuts them
    // (O.capFades): phraseTimes floors a phrase at the length of one arrival, and a
    // caption that spends all of itself arriving never reaches full.
    const fade = O.fitFades(p.hide - p.show, CAP_IN, p.cut ? CAP_HANDOFF : CAP_OUT)
    // the frosted glass stays through a straight hand-on until the next phrase's is in
    const next = ph[i + 1], joined = next && next.show - p.hide < FROST_JOIN
    const frostEnd = joined ? next.show + CAP_IN + CAP_OUT : p.hide + CAP_TRAIL
    const ffade = O.fitFades(frostEnd - p.show, CAP_IN, CAP_OUT)
    if (t < p.show || t >= Math.max(p.hide, frostEnd)) continue
    const L = layoutFor(p, W, H, st, box, measure, role)
    const B = blockOf(p, L, measure, role)
    const frosted = tp.frosted && !L.band
    // glass under the words, when the take is framed: the frame blurred through a
    // feathered rounded patch hugging the block
    if (frosted) {
      const op = O.fadeLevel(t, p.show, frostEnd, ffade.in, ffade.out)
      if (op > 0.002) {
        // and a scrim with it: the glass is the frame's own light, and a white caption
        // on a blurred white page is still a white caption. The scrim is the far end of
        // the words' own colour, so ink captions get a light plate and light ones a dark
        // plate, and the words keep their edges without the shade having to shout.
        out.frost.push({ op, x: L.x - B.lw / 2 - L.px * FROST_PAD[0], y: B.top - L.px * FROST_PAD[1],
          w: B.lw + L.px * FROST_PAD[0] * 2, h: B.h + L.px * FROST_PAD[1] * 2, r: L.px * 0.6, feather: L.px * FROST_FEATHER,
          scrim: inkText ? WHITE : SHADE, scrimA: PLATE_SCRIM })
      }
    }
    if (t >= p.hide) continue
    const op = O.fadeLevel(t, p.show, p.hide, fade.in, fade.out)
    // the shadow comes in slower and leaves sooner than the words
    const sf = O.fitFades(p.hide - p.show, CAP_IN * 1.6, (p.cut ? CAP_HANDOFF : CAP_OUT) * 1.6)
    const sop = O.fadeLevel(t, p.show, p.hide, sf.in, sf.out)
    const g = L.band || frosted ? GLOW.frosted : GLOW.plain
    const px = L.px, font = fontFor('caption', px, st.font && st.font !== 'SF Pro' ? st.font : null)
    const track = px * -0.005
    // where each word sits, for the spoken word's tint or pill
    const words = []
    B.lines.forEach((line, li) => {
      const lx = L.x - B.widths[li] / 2, ly = B.top + li * B.lineH
      let before = ''
      for (const w of line) {
        const x0 = lx + measure(before, px, role)
        words.push({ w, x: x0, y: ly, w2: measure(w.text, px, role) })
        before += w.text + ' '
      }
    })
    // room for the widest blur the shade draws (three sigma of 0.75 em, and its stroke),
    // or the canvas edge cuts it into a visible box. A plated caption draws no cloud, so
    // it needs room for the drop alone, and at 0.45 em its whole raster fits inside the
    // plate's own bounds and feather: the shade cannot reach past its plate by
    // construction rather than by measurement.
    const margin = frosted ? px * 0.45 : px * 2.7
    const bounds = { x: L.x - B.lw / 2 - margin, y: B.top - margin, w: B.lw + margin * 2, h: B.h + margin * 2 }
    const text = B.lines.map(l => l.map(w => w.text).join(' '))
    const key = `cap|${font}|${fill}|${inkText}|${frosted ? 'plate' : g.wide}|${text.join('\n')}`
    const lines = B.lines.map((_, li) => ({ text: text[li], x: L.x, y: B.top + li * B.lineH + B.lineH / 2 }))
    // The shade: the glyphs' own dark cloud, wide then close, and a drop under them.
    // Where the words have a plate the cloud is not drawn at all. Its job is to separate
    // the words from whatever is under them, and the plate of pass 11 does that with a
    // corner and a two pixel feather; the cloud does it with an airbrush that reaches
    // about 1.2 em past the glyphs, which is 65 px at 1080. On the default look, where
    // the caption sits straight on the product, that cloud took the filter strip of the
    // app being demonstrated down 49 levels, and it went wherever the words went: the
    // dodge moved the phrase off the list rows and the smudge came with it, so one live
    // row was traded for another. The plate does not travel past its own bounds, and the
    // drop under the glyphs is all the separation the words need on top of it.
    out.items.push({
      key: key + '|shade', bounds, op: sop, z: 0,
      paint(ctx) {
        ctx.font = font; ctx.textAlign = 'center'; ctx.letterSpacing = `${track}px`
        const cloud = (a, bord, blur, dy) => {
          ctx.save(); ctx.filter = `blur(${(px * blur).toFixed(2)}px)`
          ctx.fillStyle = ctx.strokeStyle = rgba(SHADE, a); ctx.lineWidth = px * bord * 2; ctx.lineJoin = 'round'
          for (const l of lines) { const y = baseline(ctx, l.y); ctx.strokeText(l.text, l.x, y + px * dy); ctx.fillText(l.text, l.x, y + px * dy) }
          ctx.restore()
        }
        if (!inkText && !frosted) { cloud(g.wide, 0.34, 0.75, 0.06); cloud(g.near, 0.1, 0.24, 0.04) }
        ctx.save(); ctx.filter = `blur(${(px * 0.07).toFixed(2)}px)`; ctx.fillStyle = rgba('#000000', inkText ? 0.15 : 0.62)
        for (const l of lines) ctx.fillText(l.text, l.x, baseline(ctx, l.y) + px * 0.05)
        ctx.restore()
      },
    })
    // the spoken word
    const active = hl ? words.findIndex(q => t >= q.w.start && t < q.w.end) : -1
    const A = active >= 0 ? words[active] : null
    if (A && hl === 'pill') {
      const padX = px * 0.16, padY = px * 0.02, h = B.lineH - padY * 2
      out.items.push({
        key: `pill|${(A.w2 + padX * 2).toFixed(1)}|${h.toFixed(1)}`,
        bounds: { x: A.x - padX, y: A.y + padY, w: A.w2 + padX * 2, h }, op: op * (1 - 0x10 / 255), z: 1,
        paint(ctx, b) { ctx.fillStyle = GOLD; roundRect(ctx, b.x, b.y, b.w, b.h, b.h / 2); ctx.fill() },
      })
    }
    out.items.push({
      key: key + '|words', bounds, op, z: 2,
      // the glyphs in the caption's colour; the spoken word is re-tinted on the GPU, so
      // one raster serves every word of the phrase
      tint: A ? { x: A.x - px * 0.05, y: A.y, w: A.w2 + px * 0.1, h: B.lineH, colour: hl === 'pill' ? INK : GOLD } : null,
      paint(ctx) {
        ctx.font = font; ctx.textAlign = 'center'; ctx.letterSpacing = `${track}px`; ctx.fillStyle = fill
        for (const l of lines) ctx.fillText(l.text, l.x, baseline(ctx, l.y))
      },
    })
  }
}

// The vertical centre of a line at y, as libass centres \an5 text: on the font's box
function baseline(ctx, y) {
  const m = ctx.measureText('Hg')
  const a = m.fontBoundingBoxAscent != null ? m.fontBoundingBoxAscent : m.actualBoundingBoxAscent
  const d = m.fontBoundingBoxDescent != null ? m.fontBoundingBoxDescent : m.actualBoundingBoxDescent
  return y - (a + d) / 2 + a
}
function rgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')) || [0, 'FFFFFF']
  const n = parseInt(m[1], 16)
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${clamp(a, 0, 1)})`
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
}

// A title card set like a product film's (overlays.js titleEvents): a large semibold
// name over a soft shadow of itself, a quieter line or a gold address pill under it,
// each rising a few pixels out of a blur, the second a beat after the first.
function cardItems(tp, t, measure, out) {
  const { W, H } = tp
  for (const card of tp.cards) {
    if (t < card.a || t >= card.b) continue
    // the ground: an opening card's scrim clears as the take lands; a closing one is
    // the frame itself blurred under the scrim, gathering in
    const land = O.cardLanding(card)
    const gop = card.opens ? clamp((card.b - t) / land, 0, 1)
      : clamp(Math.min((t - card.a) / Math.max(0.01, card.fade), card.b < tp.span - 0.05 ? (card.b - t) / 0.4 : 1), 0, 1)
    if (gop > 0) out.ground = { op: Math.max(out.ground ? out.ground.op : 0, gop), blurred: !card.opens }
    const tt = card.t
    const { title, subtitle } = O.titleParts(tt)
    const url = !!subtitle && (!!tt.url || /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(subtitle))
    let px = Math.round(H * Math.max(0.06, Math.min(0.12, +tt.sizeFrac || 0.1)))
    const tw = measure(title, px, 'title') * 0.98
    if (tw > W * 0.84) px = Math.floor(px * (W * 0.84) / tw)
    const u = H / 1080
    let sp = Math.round(Math.max(H * 0.0335, px * 0.34))
    const gap = Math.round((url ? 24 : 18) * u)
    const pillFs = Math.round(30 * u), pillH = Math.round(pillFs * 2)
    const subText = url ? `${subtitle}  →` : subtitle
    const pillW = url ? Math.round(measure(subText, pillFs, 'sub') + pillH * 0.95) : 0
    // The title is shrunk to the frame a few lines up and the subtitle never was, so a
    // subtitle longer than the frame is wide was drawn at full size straight off both
    // edges, cut mid word. It wraps to the same column the title is held to, up to two
    // lines, and is shrunk after that, which is the order that keeps it readable: a
    // line that only just overflows wraps rather than going small, and one that cannot
    // fit in two lines goes small rather than running off.
    let subLines = subtitle && !url ? wrapTo(subtitle, budget(W * 0.84, sp)) : []
    if (subLines.length > 2) {
      const flat = subLines.join(' ')
      let mid = Math.ceil(flat.length / 2), cut = flat.lastIndexOf(' ', mid)
      if (cut < 0) cut = flat.indexOf(' ', mid)
      subLines = cut > 0 ? [flat.slice(0, cut), flat.slice(cut + 1)] : [flat]
    }
    if (subLines.length) {
      const widest = Math.max(...subLines.map(l => measure(l, sp, 'sub')))
      if (widest > W * 0.84) sp = Math.floor(sp * (W * 0.84) / widest)
    }
    const subLead = Math.round(sp * 1.24)
    const subH = !subtitle ? 0 : url ? pillH
      : Math.round(sp * 1.2 + Math.max(0, subLines.length - 1) * subLead)
    const lineT = Math.round(px * 1.05)
    const blockH = lineT + (subtitle ? gap + subH : 0)
    const cx = W * (tt.fx != null ? +tt.fx : 0.5)
    const cy = H * (tt.fy != null && +tt.fy !== 0.5 ? +tt.fy : 0.47)
    const top = cy - blockH / 2, ty = top + lineT / 2, sy = top + lineT + gap + subH / 2
    const fill = tt.color && tt.color !== 'white' ? tt.color : WHITE
    const IN = 0.5, OUT = O.leaveOf(IN), stagger = 0.12, rise = 16 * u, blurIn = 8 * u
    const inAt = card.opens ? Math.max(0.2, card.text) : card.a + card.fade
    const outAt = card.opens ? card.b - land - 0.32 : (card.b < tp.span - 0.05 ? card.b - OUT : null)
    const phase = delay => {
      const at = inAt + delay
      const end = outAt != null ? Math.max(at + IN, outAt + delay * 0.5) : card.b
      if (t < at) return null
      if (t < at + IN) { const e = O.EASE_IN((t - at) / IN); return { op: Math.min(1, e * 1.2), dy: rise * (1 - e), blur: blurIn * (1 - e) } }
      if (outAt == null || t < end) return { op: 1, dy: 0, blur: 0 }
      // the line rises away and softens on --ease-out; its alpha takes the S
      if (t < end + OUT) { const p = (t - end) / OUT, e = O.EASE_OUT(p); return { op: O.MOVE(1 - p), dy: -rise * 0.4 * e, blur: blurIn * 0.75 * e } }
      return null
    }
    const a = phase(0)
    if (a) {
      const font = fontFor('title', px, tt.font), track = px * -0.02
      const w = measure(title, px, 'title') + px, m = px * 0.6
      out.items.push({
        key: `title|${font}|${fill}|${title}`, bounds: { x: cx - w / 2 - m, y: ty - lineT / 2 - m, w: w + 2 * m, h: lineT + 2 * m },
        op: a.op, dy: a.dy, blur: a.blur, blurMax: blurIn, z: 4,
        paint(ctx) {
          ctx.font = font; ctx.textAlign = 'center'; ctx.letterSpacing = `${track}px`
          ctx.save(); ctx.filter = `blur(${(px * 0.2).toFixed(2)}px)`; ctx.fillStyle = rgba(SHADE, 0.34)
          ctx.fillText(title, cx, baseline(ctx, ty + px * 0.03)); ctx.restore()
          ctx.fillStyle = fill; ctx.fillText(title, cx, baseline(ctx, ty))
        },
      })
    }
    const b = subtitle && phase(stagger)
    if (b && url) {
      const font = fontFor('title', pillFs, tt.font), m = 40 * u
      out.items.push({
        key: `url|${font}|${subText}|${pillW}|${pillH}`, bounds: { x: cx - pillW / 2 - m, y: sy - pillH / 2 - m, w: pillW + 2 * m, h: pillH + 2 * m + 6 * u },
        op: b.op, dy: b.dy, blur: b.blur, blurMax: blurIn, z: 6,
        paint(ctx) {
          ctx.save(); ctx.filter = `blur(${(10 * u).toFixed(2)}px)`; ctx.fillStyle = rgba('#000000', 0.3)
          roundRect(ctx, cx - pillW / 2, sy - pillH / 2 + 4 * u, pillW, pillH, pillH / 2); ctx.fill(); ctx.restore()
          ctx.fillStyle = GOLD; roundRect(ctx, cx - pillW / 2, sy - pillH / 2, pillW, pillH, pillH / 2); ctx.fill()
          ctx.font = font; ctx.textAlign = 'center'; ctx.letterSpacing = `${pillFs * -0.005}px`; ctx.fillStyle = INK
          ctx.fillText(subText, cx, baseline(ctx, sy))
        },
      })
    } else if (b) {
      const lines = subLines.length ? subLines : [subtitle]
      const font = fontFor('sub', sp, tt.font), m = sp * 0.5 + 26 * u
      const w = Math.max(...lines.map(l => measure(l, sp, 'sub'))) + sp
      out.items.push({
        key: `sub|${font}|${fill}|${lines.join('\u0000')}`, bounds: { x: cx - w / 2 - m, y: sy - subH / 2 - m, w: w + 2 * m, h: subH + 2 * m },
        op: b.op * 0.7, dy: b.dy, blur: b.blur, blurMax: blurIn, z: 6,
        paint(ctx) {
          ctx.font = font; ctx.textAlign = 'center'; ctx.letterSpacing = `${sp * 0.01}px`; ctx.fillStyle = fill
          // the block of lines is centred on sy, whatever it holds
          const top = sy - subLead * (lines.length - 1) / 2
          lines.forEach((line, i) => ctx.fillText(line, cx, baseline(ctx, top + i * subLead)))
        },
      })
    }
  }
}

// A lower third names what is on screen from the bottom left with a gold rule; a label
// is a short line over the video, on a soft dark bloom or in a dark pill
// (overlays.js labelEvents)
function labelItems(tp, t, measure, out) {
  const { W, H } = tp
  for (const tt of tp.labels) {
    const a = tt.start != null ? Math.max(0, +tt.start) : 0
    const b = tt.end != null && tt.end > tt.start ? Math.min(+tt.end, tp.span || Infinity) : (tp.span || a + 3600)
    if (!(b > a + 0.1) || t < a || t >= b) continue
    const IN = Math.min(0.32, (b - a) / 3), OUT = O.leaveOf(IN, (b - a) / 4)
    const e = t < a + IN ? O.EASE_IN((t - a) / IN) : 1
    // it slides in on --ease-in and goes on out the same way it came, on --ease-out,
    // with the alpha on the S (O.fadeLevel) so the leave is not spent standing still
    const leaving = t >= b - OUT ? O.EASE_OUT((t - (b - OUT)) / OUT) : 0
    const op = t >= b - OUT ? O.MOVE((b - t) / OUT) : e
    const fill = tt.color && tt.color !== 'white' ? tt.color : '#FFFFFF'
    if (tt.style === 'lower-third') {
      const { title, subtitle } = O.titleParts(tt)
      const px = Math.round(H * Math.max(0.03, Math.min(0.07, +tt.sizeFrac || 0.044)))
      const sp = Math.round(px * 0.62)
      // it names what is in the picture, so by default it hangs inside the framed take's
      // own corner rather than straddling its edge; a placed one stays where it was put
      const B = tp.box || { x: 0, y: 0, w: W, h: H }
      const x = tt.fx != null && tt.fx !== 0.5 ? W * +tt.fx : B.x + B.w * (tp.box ? 0.05 : 0.07)
      const y = tt.fy != null && tt.fy !== 0.5 ? H * +tt.fy : B.y + B.h * 0.8
      const barH = px * 1.05 + (subtitle ? sp * 1.3 : 0)
      const dx = t < a + IN ? -px * 0.4 * (1 - e) : -px * 0.15 * leaving
      const fT = fontFor('title', px, tt.font), fS = fontFor('sub', sp, tt.font)
      const w = Math.max(measure(title, px, 'title'), subtitle ? measure(subtitle, sp, 'sub') : 0) + px * 2
      const m = px * 1.8
      out.items.push({
        key: `lt|${fT}|${fill}|${title}|${subtitle}`, bounds: { x: x - px * 0.45 - m, y: y - px * 0.16 - m, w: w + 2 * m, h: barH + px * 0.4 + 2 * m },
        op, dx, z: 10,
        paint(ctx) {
          ctx.fillStyle = GOLD; roundRect(ctx, x - px * 0.45, y - px * 0.1, Math.max(3, px * 0.09), barH, px * 0.045); ctx.fill()
          ctx.textAlign = 'left'
          const put = (text, font, size, yTop, alpha, tr) => {
            ctx.font = font; ctx.letterSpacing = `${tr}px`
            const mm = ctx.measureText('Hg'), asc = mm.fontBoundingBoxAscent || size * 0.95
            ctx.save(); ctx.filter = `blur(${(px * 0.45).toFixed(2)}px)`
            ctx.strokeStyle = ctx.fillStyle = rgba(SHADE, 0.45 * alpha); ctx.lineWidth = px * 0.6; ctx.lineJoin = 'round'
            ctx.strokeText(text, x, yTop + asc); ctx.restore()
            ctx.fillStyle = rgba(fill, alpha); ctx.fillText(text, x, yTop + asc)
            return yTop + (mm.fontBoundingBoxAscent + mm.fontBoundingBoxDescent || size * 1.2)
          }
          const y2 = put(title, fT, px, y - px * 0.16, 1, px * -0.015)
          if (subtitle) put(subtitle, fS, sp, y2, 0.8, 0)
        },
      })
      continue
    }
    const px = Math.max(12, Math.round(H * Math.max(0.02, Math.min(0.16, +tt.sizeFrac || 0.05))))
    const align = tt.align === 'left' ? 'left' : tt.align === 'right' ? 'right' : 'center'
    const rows = String(tt.text).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    const name = tt.font && tt.font !== 'SF Pro' ? tt.font : null
    const w = Math.max(...rows.map(r => measure(r, px, name || 'caption')))
    const m = W * 0.03 + (tt.box ? px * 0.55 : 0)
    const lo = align === 'left' ? m : align === 'right' ? m + w : m + w / 2
    const hi = align === 'left' ? W - m - w : align === 'right' ? W - m : W - m - w / 2
    const x = Math.min(Math.max(lo, W * (tt.fx != null ? +tt.fx : 0.5)), Math.max(lo, hi))
    const half = px * (0.5 + rows.length / 2)
    const y = Math.min(Math.max(half, H * (tt.fy != null ? +tt.fy : 0.5)), H - half)
    const dy = t < a + IN ? px * 0.25 * (1 - e) : -px * 0.1 * leaving
    const font = fontFor('caption', px, name)
    const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2
    const padX = px * 0.55, mm = px * 1.7
    out.items.push({
      key: `label|${font}|${fill}|${align}|${!!tt.box}|${rows.join('\n')}`,
      bounds: { x: left - padX - mm, y: y - half - mm, w: w + 2 * padX + 2 * mm, h: half * 2 + 2 * mm },
      op, dy, z: 8,
      paint(ctx) {
        ctx.font = font; ctx.textAlign = align; ctx.letterSpacing = `${px * -0.01}px`
        const lh = px * 1.2, y0 = y - (rows.length - 1) * lh / 2
        if (tt.box) {
          ctx.fillStyle = rgba('#0F1114', 0.74); roundRect(ctx, left - padX, y - half, w + padX * 2, half * 2, half); ctx.fill()
        } else {
          ctx.save(); ctx.filter = `blur(${(px * 0.4).toFixed(2)}px)`
          ctx.fillStyle = rgba('#000000', 0.33); ctx.strokeStyle = rgba('#000000', 0.2); ctx.lineWidth = px * 0.6; ctx.lineJoin = 'round'
          rows.forEach((r, i) => { const by = baseline(ctx, y0 + i * lh); ctx.strokeText(r, x, by); ctx.fillText(r, x, by) })
          ctx.restore()
        }
        ctx.fillStyle = fill
        rows.forEach((r, i) => ctx.fillText(r, x, baseline(ctx, y0 + i * lh)))
      },
    })
  }
}

// ── a still's type ──────────────────────────────────────────────────────────
//
// Everything above is keyed to a clock. A title card opens and hands over, a lower third
// runs for a beat, a caption follows the voice. None of it reaches a still, which has one
// frame, and a hero without a headline is a picture of a window. What a finished picture
// wants instead is furniture that holds still: a headline, a quieter line under it, a
// caption under the image, a label pinned to a point in the picture, and a callout that
// points at one.
//
// These are styles, not a flag about stills, so nothing a recording draws changes and a
// clip can carry a headline too. Such a headline holds the room it was given for the
// whole plan, because the take's place is the plan's and not the frame's: text that
// arrives and leaves fades in the room it always had rather than shoving the picture
// about mid-clip.
//
// The room is settled before the take is placed (stillRoom, which plan.js calls ahead of
// the layout) and the picture is refitted into what is left. Type laid over a screenshot
// covers the thing the screenshot is of, so the type stands beside the picture or over
// the ground and the picture gets out of its way. There is deliberately no place that
// puts a headline on the product.

const STILL = {
  head: 0.062,            // the headline, a share of the output's height: 67 px at 1080
  headMin: 0.026, headMax: 0.12,
  sub: 0.42,              // the quieter line, a share of the headline: 28 px under 67
  subFloor: 0.024,        // and never under this share of the height
  cap: 0.023,             // a caption under the image
  pin: 0.026,             // a label pinned in the picture, and a callout
  lineH: 1.12,            // display type sets tight
  subLineH: 1.36,         // and a line meant to be read sets open
  lines: 3, subLines: 4,  // the lines a block may take before it steps down a size
  colBeside: 0.26,        // the least a text column gets standing beside the picture
  colOver: 0.80,          // and standing above or below it
  measure: 66,            // characters on a line meant to be read, DESIGN.md's 65 to 75
  roomMax: 0.44,          // no block takes more of the frame than this
}
const PLACES = new Set(['above', 'below', 'left', 'right'])

// The edit's texts on the output clock, once. Both sides of the still question have to
// ask it of the same numbers: stillRoom read the take's own seconds while planText read
// the clock's, so a title card over a trimmed edit (source 20 to 30 of a 60 second take,
// exported as 0 to 10) was full-span to one and mid-clip to the other, reserved no room
// and then stripped as a headline, and the card disappeared from the picture.
function clockTexts(texts, clock) {
  return (texts || []).filter(t => t && String(t.text || '').trim()).map(t => {
    const timed = t.start != null && t.end != null && t.end > t.start
    return { ...t, start: timed ? clock(t.start) : null, end: timed ? clock(t.end) : null }
  }).filter(t => t.start == null || t.end > t.start)
}

// The styles a still invented, which need a ground to stand on and are drawn nowhere
// else. 'title' is deliberately not one of them: it is a title card and always was.
function stillOnly(t) {
  const s = String((t && t.style) || '')
  return s === 'headline' || s === 'caption' || ((s === 'label' || s === 'callout') && !!(t && t.at))
}

// What a text layer is on a picture that holds still, or null for the timed set above.
//
// 'label' is the one name shared with that set, and the point decides: a label given a
// place in the picture is pinned to it, a label without one is the label over the video
// it always was. A callout with nothing to aim at is the same, a label.
//
// A title card is a handover: its scrim covers the picture and clears as the take lands.
// One that runs the whole plan never clears, so it is not a card, it is a headline that
// was called a title. A still makes that obvious, since a still's text has no times at
// all, but it was always true.
function stillStyle(t, span = 0) {
  if (!t) return null
  const s = String(t.style || '')
  if (s === 'headline' || s === 'caption') return s
  if (s === 'label' || s === 'callout') return t.at ? s : null
  if (s !== 'title') return null
  const timed = t.start != null && t.end != null && t.end > t.start
  return !timed || (+t.start <= 0.05 && +t.end >= span - 0.05) ? 'headline' : null
}

// A wrap by characters rather than by measured width, the way a caption's own wrap goes
// (overlays.captionPhrases). The room a headline takes is settled once for the plan,
// before anything is drawn and with no canvas at hand, and a wrap that depended on the
// shaper would settle the room in one place and the lines in another.
const budget = (colW, px) => Math.max(6, Math.floor(colW / (px * 0.56)))
function wrapTo(text, chars) {
  const out = []
  for (const para of String(text).split(/\r?\n/)) {
    const words = para.trim().split(/\s+/).filter(Boolean)
    if (!words.length) continue
    let line = ''
    for (const w of words) {
      const next = line ? `${line} ${w}` : w
      if (line && next.length > chars) { out.push(line); line = w } else line = next
    }
    if (line) out.push(line)
  }
  return out.length ? out : ['']
}

// A headline too long for its column wraps, and where the wrap runs past the lines the
// shape allows it steps down a size until it fits. Nothing is hidden and nothing is
// clipped until the floor, where the last line it can carry ends in an ellipsis: a
// headline nobody can read is a worse answer than one that admits it is long.
// A greedy wrap spends the column and leaves whatever is left on the last line, and a
// single word alone under a headline reads as a mistake rather than as a rag. So once
// the line count is settled the column is tightened to the narrowest that still takes
// that many lines, which evens them out and moves nothing else.
function balance(text, chars) {
  const lines = wrapTo(text, chars)
  if (lines.length < 2) return lines
  for (let c = Math.ceil(String(text).length / lines.length); c < chars; c++) {
    const t = wrapTo(text, c)
    if (t.length === lines.length) return t
  }
  return lines
}

function fitLines(text, px, colW, maxLines, minPx) {
  let p = Math.max(minPx, px), lines = wrapTo(text, budget(colW, p))
  while (lines.length > maxLines && p > minPx) {
    p = Math.max(minPx, p * 0.94)
    lines = wrapTo(text, budget(colW, p))
  }
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines)
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[\s.,;:]+$/, '') + '…'
    return { px: Math.round(p), lines }
  }
  return { px: Math.round(p), lines: balance(text, budget(colW, p)) }
}

// The runs of a headline block: the big line, then the quieter ones. The first headline
// is the headline and its own subhead follows it (a `subtitle`, a second line, or the
// half of a sentence after a separator, all of which titleParts already splits); any
// further headline-shaped text is another quiet paragraph in the same block. One rule,
// rather than a count of how many headlines a picture is allowed.
function headRuns(heads, colW, H, px) {
  const t0 = heads[0]
  const big = fitLines(O.titleParts(t0).title, px, colW, STILL.lines, H * STILL.headMin)
  const subPx = Math.round(Math.max(H * STILL.subFloor, big.px * STILL.sub))
  // A headline is a shape and may run the picture's whole width; a line meant to be read
  // is held to a measure, because a 98 character line under it is a paragraph nobody
  // tracks back along (DESIGN.md, Type).
  const subCol = Math.min(colW, subPx * 0.56 * STILL.measure)
  const runs = big.lines.map(text => ({ text, px: big.px, role: 'title',
    lineH: Math.round(big.px * STILL.lineH), alpha: 1, lead: 0 }))
  const quiet = []
  const sub0 = O.titleParts(t0).subtitle
  if (sub0) quiet.push(sub0)
  for (const t of heads.slice(1)) quiet.push(String(t.text).trim())
  for (const q of quiet) {
    const f = fitLines(q, subPx, subCol, STILL.subLines, H * STILL.subFloor)
    f.lines.forEach((text, i) => runs.push({ text, px: f.px, role: 'sub',
      lineH: Math.round(f.px * STILL.subLineH), alpha: 0.74, lead: i ? 0 : Math.round(big.px * 0.34) }))
  }
  return runs
}
const runsHeight = runs => runs.reduce((h, r) => h + r.lead + r.lineH, 0)

/**
 * The type a still carries, settled from the output frame alone, and the room it needs.
 * plan.js asks for this before it places the take, so the picture can be refitted into
 * what is left.
 *   texts   the edit's text layers
 *   W, H    the output frame
 *   slack   the room the take's own shape already leaves inside its box, in pixels:
 *           what decides beside from above when nobody said
 *   place   typography.headline, and size typography.headlineSize
 * Returns null where nothing here is still furniture, else
 * { place, runs, col, gutter, caps, pins, room: { top, bottom, left, right } }.
 */
function stillRoom(texts, { W, H, span = 0, slack = { x: 0, y: 0 }, width = 0, place = 'auto', size = 0 } = {}) {
  const list = (texts || []).filter(t => t && String(t.text || '').trim() && stillStyle(t, span))
  if (!list.length) return null
  const heads = list.filter(t => stillStyle(t, span) === 'headline')
  const capped = list.filter(t => stillStyle(t, span) === 'caption')
  const pins = list.filter(t => { const s = stillStyle(t, span); return s === 'label' || s === 'callout' })
  // Where the type goes when nobody said: beside the picture where the picture's own
  // shape already leaves a column, above it where it does not. That is the split a help
  // centre makes without thinking about it, a handset with the words beside it and a
  // wide window with the words over it, and it falls out of one measurement.
  const want = String((heads[0] && heads[0].place) || place || 'auto')
  const p = PLACES.has(want) ? want : slack.x >= W * 0.30 ? 'left' : 'above'
  const beside = p === 'left' || p === 'right'
  const s0 = clamp(+size || STILL.head, STILL.headMin, STILL.headMax)
  const t0 = heads[0] || {}
  // The gutter between the type and the picture is the look's own measure, off the size
  // a headline is set at, and not off how long this particular headline turned out.
  const px0 = Math.round(H * clamp(+t0.sizeFrac || +t0.size || s0, STILL.headMin, STILL.headMax))
  const gutter = heads.length ? Math.round(px0 * (beside ? 1.1 : 0.78)) : 0
  // The column. Beside, it takes the width the picture's own shape was never going to
  // use, so a handset with a headline beside it is one composition rather than a column,
  // a picture and a hole on the far side. Above, it is the picture's own width: type
  // four times wider than the thing it names is not a caption for it.
  // Above or below, that width is the picture's own and not the frame less the slack,
  // which is the picture plus both of its margins: a 2560x1600 capture at inset 0.08 got
  // a 1536 px column over a 1248 px picture, a quarter wider than the thing it names.
  const pic = width > 0 ? width : W - slack.x
  const col = Math.round(beside
    ? clamp(slack.x - gutter, W * STILL.colBeside, W * STILL.roomMax - gutter)
    : clamp(pic, W * 0.5, W * STILL.colOver))
  // A block that would take more of the frame than it is allowed steps down a size, the
  // same answer a line too long for its column gets. A headline the frame cannot hold is
  // still a headline; a headline cut off at the edge of its room is a mistake on show.
  const cap = H * (beside ? 0.86 : STILL.roomMax)
  let runs = [], px1 = px0
  if (heads.length) {
    runs = headRuns(heads, col, H, px1)
    while (runsHeight(runs) + gutter > cap && px1 > H * STILL.headMin) {
      px1 = Math.max(H * STILL.headMin, px1 * 0.94)
      runs = headRuns(heads, col, H, Math.round(px1))
    }
  }
  // A caption belongs under the image whatever the headline is doing, so it is its own
  // room at the foot of the frame.
  const caps = capped.map(t => {
    const px = Math.round(H * clamp(+t.sizeFrac || +t.size || STILL.cap, 0.012, 0.05))
    return { t, ...fitLines(String(t.text).trim(), px, Math.min(W * STILL.colOver, px * 0.56 * STILL.measure), 2, H * 0.012) }
  })
  const capH = caps.reduce((h, c) => h + c.lines.length * Math.round(c.px * STILL.subLineH), 0)
  const capGap = caps.length ? Math.round(caps[0].px * 1.5) : 0
  const room = { top: 0, bottom: 0, left: 0, right: 0 }
  const blockH = runs.length ? runsHeight(runs) + gutter : 0
  if (p === 'above') room.top = blockH
  else if (p === 'below') room.bottom = blockH
  else if (runs.length) room[p] = col + gutter
  room.bottom += Math.min(capH + capGap, H * 0.2)
  return { place: p, runs, head: heads[0] || null, col, gutter, caps, capGap, pins, room }
}

/**
 * The still's type placed on the frame, once the take has a rect: absolute positions for
 * the headline block, the caption under the image and each pinned label or callout.
 * `light` is whether the ground is a light one, which is what the type reads off.
 */
function placeStill(sr, { W, H, box, outer = null, light = false, span = 0 }) {
  if (!sr) return null
  const B = box || { x: 0, y: 0, w: W, h: H }
  // What the type stands clear of. The room was taken out of the box the layout gave the
  // picture, and a drawn device takes that whole box and hands back the screen inside
  // it, so measuring off the screen puts the type on the shell it was reserved room
  // beside. A pin keeps B: `at` is the take's own fractions and names a thing on the
  // page, not a place on the canvas.
  const O_ = outer || B
  const beside = sr.place === 'left' || sr.place === 'right'
  const blockH = sr.runs.length ? runsHeight(sr.runs) : 0
  const align = beside ? 'left' : 'centre'
  // The measurement that set the column ran before the take was refitted into what the
  // type left, so a column a few pixels wider than the picture it names is possible. A
  // line wider than its column is already stepped down where it is drawn, so holding the
  // column to the picture costs a hair of size and never a wrap nobody planned.
  const col = beside ? sr.col : Math.round(Math.min(sr.col, O_.w))
  const x = Math.round(beside
    ? (sr.place === 'left' ? O_.x - sr.gutter - sr.col : O_.x + O_.w + sr.gutter)
    : O_.x + O_.w / 2 - col / 2)
  // The block hugs the picture: above, its last line sits a gutter off the top edge, and
  // the air it did not need goes to the margin. That gap is the one the eye measures.
  const top = Math.round(beside ? O_.y + O_.h / 2 - blockH / 2
    : sr.place === 'above' ? O_.y - sr.gutter - blockH
    : O_.y + O_.h + sr.gutter)
  const capTop = Math.round(O_.y + O_.h + (sr.place === 'below' ? sr.gutter + blockH : 0) + sr.capGap)
  return { ...sr, W, H, col, box: B, outer: O_, light, span, align, x, top, capTop }
}

// Type on the ground takes the end the ground leaves open, ink over a light one and bone
// over a dark one, which is the same choice the edge hairline makes (plan.edgeEnd). The
// drop under it is for the light end only: dark type on a light ground already has every
// bit of separation it needs, and a halo under it would be decoration.
const stillInk = light => (light ? INK : WHITE)

function stillItems(tp, t, measure, out) {
  const S = tp.still
  if (!S) return
  const fill = stillInk(S.light)
  const drop = S.light ? 0 : 0.3
  // A still's furniture has no times, so it is simply up. Given times it arrives and
  // leaves the way a label does, in the room it was always holding.
  const fade = tt => {
    const a = tt.start != null ? Math.max(0, +tt.start) : null
    if (a == null || tt.end == null || !(+tt.end > a)) return 1
    const b = Math.min(+tt.end, S.span || Infinity)
    if (t < a || t >= b) return 0
    const IN = Math.min(0.32, (b - a) / 3), OUT = O.leaveOf(IN, (b - a) / 4)
    return t >= b - OUT ? O.MOVE((b - t) / OUT) : O.EASE_IN(Math.min(1, (t - a) / IN))
  }
  // ── the headline block
  const headOp = S.runs.length ? fade(S.head || {}) : 0
  if (headOp > 0.002) {
    const op = headOp
    let y = S.top
    for (let i = 0; i < S.runs.length; i++) {
      const r = S.runs[i]
      y += r.lead
      const top = y
      const font = fontFor(r.role, r.px)
      const track = r.role === 'title' ? r.px * -0.022 : r.px * 0.004
      // measured for real only now, and only to keep a line inside its column: the wrap
      // and the size are the plan's, so what the shaper can add here is a shrink
      const wide = measure(r.text, r.px, r.role)
      const k = wide > S.col ? S.col / wide : 1
      const px = k < 1 ? Math.max(8, r.px * k) : r.px
      const x = S.align === 'left' ? S.x : S.x + S.col / 2
      const m = r.px * 1.2
      out.items.push({
        key: `still|${font}|${fill}|${r.alpha}|${S.align}|${px.toFixed(1)}|${r.text}`,
        bounds: { x: S.x - m, y: top - m, w: S.col + 2 * m, h: r.lineH + 2 * m },
        op: op * r.alpha, z: 12,
        paint(ctx) {
          ctx.font = k < 1 ? fontFor(r.role, px) : font
          ctx.textAlign = S.align === 'left' ? 'left' : 'center'
          ctx.letterSpacing = `${track}px`
          const cy = top + r.lineH / 2
          if (drop) {
            ctx.save(); ctx.filter = `blur(${(px * 0.18).toFixed(2)}px)`; ctx.fillStyle = rgba(SHADE, drop)
            ctx.fillText(r.text, x, baseline(ctx, cy + px * 0.03)); ctx.restore()
          }
          ctx.fillStyle = fill
          ctx.fillText(r.text, x, baseline(ctx, cy))
        },
      })
      y += r.lineH
    }
  }
  // ── the caption under the image
  let cy = S.capTop
  for (const c of S.caps) {
    const op = fade(c.t)
    const lineH = Math.round(c.px * STILL.subLineH)
    const O_ = S.outer || S.box
    const font = fontFor('sub', c.px), cxm = O_.x + O_.w / 2
    const top = cy
    if (op > 0.002) {
      out.items.push({
        key: `stillcap|${font}|${fill}|${c.lines.join('\n')}`,
        bounds: { x: O_.x - c.px, y: top - c.px, w: O_.w + 2 * c.px, h: c.lines.length * lineH + 2 * c.px },
        op: op * 0.66, z: 12,
        paint(ctx) {
          ctx.font = font; ctx.textAlign = 'center'; ctx.letterSpacing = `${c.px * 0.006}px`; ctx.fillStyle = fill
          c.lines.forEach((l, i) => ctx.fillText(l, cxm, baseline(ctx, top + i * lineH + lineH / 2)))
        },
      })
    }
    cy += c.lines.length * lineH
  }
  // ── what is pinned in the picture
  for (const tt of S.pins) pinItem(tp, tt, t, measure, out, fade(tt))
}

// A label pinned to a point in the picture, and a callout that points at one.
//
// The point is the take's own fractions, the coordinates a mark is placed in, because it
// names a thing on the page and not a place on the canvas: a label pinned at the output's
// own 0.7 slides off its button the moment the shape changes.
//
// The words sit on a plate rather than in a cloud of shade. A still is read close, and
// the airbrush a caption over a video can afford takes a hairline off an app page at
// 100 percent (see the shade above). The plate carries its own edge and reaches nowhere
// past it.
// The leader is long enough to read as one: at a gap of about half the words' own size
// the plate sits against the dot and the line between them is a dash.
const PIN_PAD = [0.62, 0.34], PIN_LEAD = 1.9, PIN_DOT = 0.3
function pinItem(tp, tt, t, measure, out, op) {
  if (!(op > 0.002) || !tt.at) return
  const S = tp.still, B = S.box, { W, H } = S
  const callout = String(tt.style || '') === 'callout'
  let px = Math.round(H * clamp(+tt.sizeFrac || +tt.size || STILL.pin, 0.012, 0.06))
  // Fitted rather than cut: a plate given more words than two lines hold steps down a
  // size and then ends in an ellipsis, the same answer a headline gets. Sliced at two, a
  // label lost its last words silently and the picture read as a finished sentence that
  // was not one.
  const fit = fitLines(String(tt.text).trim(), px, W * 0.26, 2, H * 0.012)
  const lines = fit.lines
  px = fit.px
  const wide = Math.max(...lines.map(l => measure(l, px, 'sub')))
  const lineH = Math.round(px * 1.3)
  const padX = px * PIN_PAD[0], padY = px * PIN_PAD[1]
  const boxW = wide + padX * 2, boxH = lines.length * lineH + padY * 2
  const ax = B.x + clamp(+tt.at.x, 0, 1) * B.w, ay = B.y + clamp(+tt.at.y, 0, 1) * B.h
  const lead = px * PIN_LEAD, dot = px * PIN_DOT
  let bx = ax - boxW / 2, by = ay - boxH / 2
  if (callout) {
    // The words stand off the picture where the ground has room for them, and inside it
    // where it has not. Either way they are clear of the thing they name: a callout that
    // covers what it points at is a sticker.
    const left = +tt.at.x <= 0.5
    const margin = left ? B.x : W - B.x - B.w
    const outside = margin >= boxW + lead * 2
    bx = outside ? (left ? B.x - lead - boxW : B.x + B.w + lead)
      : (left ? ax + lead + dot : ax - lead - dot - boxW)
    by = ay - boxH / 2
  }
  bx = clamp(bx, px * 0.5, W - boxW - px * 0.5)
  by = clamp(by, px * 0.5, H - boxH - px * 0.5)
  // where the leader meets the plate: the nearer of its two vertical edges
  const jx = ax < bx ? bx : ax > bx + boxW ? bx + boxW : ax
  const jy = clamp(ay, by + boxH * 0.2, by + boxH * 0.8)
  const m = px * 1.4
  const x0 = Math.min(bx, ax) - m, y0 = Math.min(by, ay) - m
  out.items.push({
    key: `pin|${callout}|${px}|${bx.toFixed(1)},${by.toFixed(1)}|${ax.toFixed(1)},${ay.toFixed(1)}|${lines.join('\n')}`,
    bounds: { x: x0, y: y0, w: Math.max(bx + boxW, ax) + m - x0, h: Math.max(by + boxH, ay) + m - y0 },
    op, z: 13,
    paint(ctx) {
      if (callout) {
        // the leader and the ring: the arrow's own furniture, a white keyline with gold
        // over the inner half of it, so it reads on a light page and on a dark one
        ctx.lineCap = 'round'
        for (const [col, w] of [['#FBFAF8', px * 0.2], [GOLD, px * 0.09]]) {
          ctx.strokeStyle = col; ctx.lineWidth = w
          ctx.beginPath(); ctx.moveTo(jx, jy); ctx.lineTo(ax, ay); ctx.stroke()
        }
        ctx.fillStyle = '#FBFAF8'; ctx.beginPath(); ctx.arc(ax, ay, dot + px * 0.07, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = GOLD; ctx.beginPath(); ctx.arc(ax, ay, dot, 0, Math.PI * 2); ctx.fill()
      }
      ctx.save(); ctx.filter = `blur(${(px * 0.34).toFixed(2)}px)`; ctx.fillStyle = rgba('#000000', 0.34)
      roundRect(ctx, bx, by + px * 0.1, boxW, boxH, px * 0.5); ctx.fill(); ctx.restore()
      ctx.fillStyle = rgba(INK, 0.94); roundRect(ctx, bx, by, boxW, boxH, px * 0.5); ctx.fill()
      ctx.font = fontFor('sub', px); ctx.textAlign = 'left'; ctx.letterSpacing = `${px * 0.004}px`
      ctx.fillStyle = tt.color && tt.color !== 'white' ? tt.color : WHITE
      lines.forEach((l, i) => ctx.fillText(l, bx + padX, baseline(ctx, by + padY + i * lineH + lineH / 2)))
    },
  })
}

/**
 * What text shows at output time t: { items, frost, ground }. items are drawn in z
 * order, each { key, bounds, op, dx, dy, blur, blurMax, tint, paint }; frost is glass
 * patches under captions; ground the title card's scrim, { op, blurred }.
 */
function textAt(tp, t, measure = estimate) {
  const out = { items: [], frost: [], ground: null }
  if (!tp) return out
  cardItems(tp, t, measure, out)
  if (tp.phrases.length) captionItems(tp, t, measure, out)
  labelItems(tp, t, measure, out)
  stillItems(tp, t, measure, out)
  out.items.sort((a, b) => a.z - b.z)
  return out
}

/**
 * The framed take's own move under a title card, at output time t: it rises into place
 * from 96 percent as an opening card clears and settles back to 92 as a closing one
 * gathers (processor.backdropChain). { k, dy, alpha, shadow }, k a scale about the
 * take's centre, dy output pixels, alpha the take's opacity and shadow its shadow's.
 */
function frameMove(tp, t, H) {
  const out = { k: 1, dy: 0, alpha: 1, shadow: 1 }
  if (!tp) return out
  const rv = tp.reveal, cl = tp.close
  if (rv) {
    if (t < rv.at) return { k: 0.96, dy: 8 * H / 1080, alpha: 0, shadow: 0 }
    const p = clamp((t - rv.at) / rv.dur, 0, 1), e = 1 - Math.pow(1 - p, 3)
    out.k = 0.96 + 0.04 * e; out.dy = 8 * H / 1080 * (1 - e)
    out.alpha = clamp((t - rv.at) / (rv.dur * 0.45), 0, 1); out.shadow = p
  }
  if (cl) {
    const q = clamp((t - cl.at) / cl.dur, 0, 1)
    out.k *= 1 - 0.08 * q * q * (3 - 2 * q)
  }
  return out
}

// ── rasterising ─────────────────────────────────────────────────────────────
/**
 * An item drawn at k target pixels per export pixel: { canvas, blurred, x, y, w, h },
 * its box in target pixels snapped out to whole ones, and a copy through a blur when the
 * item comes in out of one. canvas(w, h) makes a canvas. The compositor keeps what this
 * returns as textures, keyed by the item, so each is drawn once per size.
 */
function rasterItem(item, k, canvas) {
  const b = item.bounds
  const x = Math.floor(b.x * k), y = Math.floor(b.y * k)
  const w = Math.max(1, Math.ceil((b.x + b.w) * k) - x), h = Math.max(1, Math.ceil((b.y + b.h) * k) - y)
  const sharp = canvas(w, h), ctx = sharp.getContext('2d')
  ctx.translate(-x, -y); ctx.scale(k, k)
  item.paint(ctx, b)
  let blurred = null
  if (item.blurMax) {
    blurred = canvas(w, h)
    const g = blurred.getContext('2d')
    g.filter = `blur(${(item.blurMax * k).toFixed(2)}px)`
    g.drawImage(sharp, 0, 0)
  }
  return { canvas: sharp, blurred, x, y, w, h }
}

// A measure function on a real canvas, cached per string and size
function canvasMeasure() {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas')
  const ctx = c.getContext('2d')
  const memo = new Map()
  return (text, px, role) => {
    const k = `${role}|${px}|${text}`
    let v = memo.get(k)
    if (v != null) return v
    const r = ROLE[role] ? role : 'caption'
    ctx.font = fontFor(r, px, ROLE[role] ? null : role)
    ctx.letterSpacing = r === 'title' ? `${px * -0.02}px` : r === 'caption' ? `${px * -0.005}px` : '0px'
    v = ctx.measureText(String(text)).width
    if (memo.size > 4000) memo.clear()
    memo.set(k, v)
    return v
  }
}

module.exports = { planText, textAt, frameMove, rasterItem, canvasMeasure, fontFor, estimate,
  stillRoom, placeStill, stillStyle, stillOnly, clockTexts, wrapTo, STILL, GOLD, INK }
