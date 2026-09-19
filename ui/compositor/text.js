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
 *   prepared  { captions: { cues, words, busy } } from prepare.js
 *   zooms     explicit zooms on the output clock (captions stay down inside one)
 * Returns { phrases, cards, labels, st, box, frosted, reveal, close }.
 */
function planText(opts = {}, { clock, span, W, H, box = null, prepared = null, zooms = [] } = {}) {
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
  const texts = (opts.texts || []).filter(t => t && String(t.text || '').trim()).map(t => {
    const timed = t.start != null && t.end != null && t.end > t.start
    return { ...t, start: timed ? clock(t.start) : null, end: timed ? clock(t.end) : null }
  }).filter(t => t.start == null || t.end > t.start)
  const cards = O.titleCards(texts, span).map(k => ({ ...k, span }))
  if (phrases) phrases = O.clearOfTitles(phrases, cards)
  const labels = texts.filter(t => O.textStyle(t, span) !== 'title').map(t => ({ ...t, style: O.textStyle(t, span) }))
  // as an opening card clears the framed take scales up into place; a closing card
  // gathers over it settling back (processor.backdropChain)
  const opening = cards.find(k => k.opens)
  const closing = cards.find(k => !k.opens && k.b >= span - 0.05)
  return {
    phrases: phrases && phrases.length ? O.phraseTimes(phrases) : [],
    cards, labels, st, box, W, H, span,
    frosted: !!box,
    reveal: opening ? { at: opening.b - O.cardLanding(opening), dur: O.cardLanding(opening) } : null,
    close: closing ? { at: closing.a, dur: Math.min(1.2, closing.fade + 0.5) } : null,
  }
}

// ── one moment ──────────────────────────────────────────────────────────────
// The fades and glow strengths of the classic captions (ui/overlays.js captionEvents)
const CAP_IN = 0.15, CAP_OUT = 0.16, CAP_HANDOFF = 0.12
const GLOW = { frosted: { wide: 0.3, near: 0.42 }, plain: { wide: 0.52, near: 0.66 } }
const FROST_PAD = [0.45, 0.22], FROST_FEATHER = 0.3, FROST_JOIN = 0.3

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
  const { W, H, st, box } = tp
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
    const fo = p.cut ? CAP_HANDOFF : CAP_OUT
    // the frosted glass stays through a straight hand-on until the next phrase's is in
    const next = ph[i + 1], joined = next && next.show - p.hide < FROST_JOIN
    const frostEnd = joined ? next.show + CAP_IN + CAP_OUT : p.hide
    if (t < p.show || t >= Math.max(p.hide, frostEnd)) continue
    const L = layoutFor(p, W, H, st, box, measure, role)
    const B = blockOf(p, L, measure, role)
    const frosted = tp.frosted && !L.band
    // glass under the words, when the take is framed: the frame blurred through a
    // feathered rounded patch hugging the block
    if (frosted) {
      const fin = Math.min(1, (t - p.show) / CAP_IN)
      const fout = joined ? Math.min(1, (frostEnd - t) / CAP_OUT) : Math.min(1, (p.hide - t) / fo)
      const op = clamp(Math.min(fin, fout), 0, 1)
      if (op > 0.002) {
        out.frost.push({ op, x: L.x - B.lw / 2 - L.px * FROST_PAD[0], y: B.top - L.px * FROST_PAD[1],
          w: B.lw + L.px * FROST_PAD[0] * 2, h: B.h + L.px * FROST_PAD[1] * 2, r: L.px * 0.6, feather: L.px * FROST_FEATHER })
      }
    }
    if (t >= p.hide) continue
    const op = clamp(Math.min((t - p.show) / CAP_IN, (p.hide - t) / fo), 0, 1)
    // the shadow comes in slower and leaves sooner than the words
    const sop = clamp(Math.min((t - p.show) / (CAP_IN * 1.6), (p.hide - t) / (fo * 1.6)), 0, 1)
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
    // or the canvas edge cuts it into a visible box
    const margin = px * 2.7
    const bounds = { x: L.x - B.lw / 2 - margin, y: B.top - margin, w: B.lw + margin * 2, h: B.h + margin * 2 }
    const text = B.lines.map(l => l.map(w => w.text).join(' '))
    const key = `cap|${font}|${fill}|${inkText}|${g.wide}|${text.join('\n')}`
    const lines = B.lines.map((_, li) => ({ text: text[li], x: L.x, y: B.top + li * B.lineH + B.lineH / 2 }))
    // the shade: the glyphs' own dark cloud, wide then close, and a drop under them
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
        if (!inkText) { cloud(g.wide, 0.34, 0.75, 0.06); cloud(g.near, 0.1, 0.24, 0.04) }
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
    const sp = Math.round(Math.max(H * 0.0335, px * 0.34))
    const gap = Math.round((url ? 24 : 18) * u)
    const pillFs = Math.round(30 * u), pillH = Math.round(pillFs * 2)
    const subText = url ? `${subtitle}  →` : subtitle
    const pillW = url ? Math.round(measure(subText, pillFs, 'sub') + pillH * 0.95) : 0
    const subH = !subtitle ? 0 : url ? pillH : Math.round(sp * 1.2)
    const lineT = Math.round(px * 1.05)
    const blockH = lineT + (subtitle ? gap + subH : 0)
    const cx = W * (tt.fx != null ? +tt.fx : 0.5)
    const cy = H * (tt.fy != null && +tt.fy !== 0.5 ? +tt.fy : 0.47)
    const top = cy - blockH / 2, ty = top + lineT / 2, sy = top + lineT + gap + subH / 2
    const fill = tt.color && tt.color !== 'white' ? tt.color : WHITE
    const IN = 0.5, OUT = 0.36, stagger = 0.12, rise = 16 * u, blurIn = 8 * u
    const inAt = card.opens ? Math.max(0.2, card.text) : card.a + card.fade
    const outAt = card.opens ? card.b - land - 0.32 : (card.b < tp.span - 0.05 ? card.b - OUT : null)
    const phase = delay => {
      const at = inAt + delay
      const end = outAt != null ? Math.max(at + IN, outAt + delay * 0.5) : card.b
      if (t < at) return null
      if (t < at + IN) { const e = O.EASE_IN((t - at) / IN); return { op: Math.min(1, e * 1.2), dy: rise * (1 - e), blur: blurIn * (1 - e) } }
      if (outAt == null || t < end) return { op: 1, dy: 0, blur: 0 }
      if (t < end + OUT) { const e = O.EASE_OUT((t - end) / OUT); return { op: 1 - e, dy: -rise * 0.4 * e, blur: blurIn * 0.75 * e } }
      return null
    }
    const a = phase(0)
    if (a) {
      const font = fontFor('title', px), track = px * -0.02
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
      const font = fontFor('title', pillFs), m = 40 * u
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
      const font = fontFor('sub', sp), w = measure(subtitle, sp, 'sub') + sp, m = sp * 0.5 + 26 * u
      out.items.push({
        key: `sub|${font}|${fill}|${subtitle}`, bounds: { x: cx - w / 2 - m, y: sy - subH / 2 - m, w: w + 2 * m, h: subH + 2 * m },
        op: b.op * 0.7, dy: b.dy, blur: b.blur, blurMax: blurIn, z: 6,
        paint(ctx) {
          ctx.font = font; ctx.textAlign = 'center'; ctx.letterSpacing = `${sp * 0.01}px`; ctx.fillStyle = fill
          ctx.fillText(subtitle, cx, baseline(ctx, sy))
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
    const IN = Math.min(0.32, (b - a) / 3), OUT = Math.min(0.24, (b - a) / 4)
    const e = t < a + IN ? O.EASE_IN((t - a) / IN) : 1
    const op = t >= b - OUT ? 1 - O.EASE_OUT((t - (b - OUT)) / OUT) : e
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
      const dx = t < a + IN ? -px * 0.4 * (1 - e) : 0
      const fT = fontFor('title', px), fS = fontFor('sub', sp)
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
    const dy = t < a + IN ? px * 0.25 * (1 - e) : 0
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

module.exports = { planText, textAt, frameMove, rasterItem, canvasMeasure, fontFor, estimate, GOLD, INK }
