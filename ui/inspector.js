// The Look inspector, generated from the schema (ui/look-schema.js via ui/look.js).
//
// Every control here is a field in the schema, so a field added there shows up here
// with its label, range, unit and reset, and an agent and a person reach exactly the
// same settings. What is shown is an engine question rather than a flag: Look.sections
// answers it for the renderer that draws the stage, which is the compositor, so the
// Look tab offers everything the export will honour. Only the handful nothing draws
// yet is left out, along with the two the person sets by dragging on the stage.
//
// Each field shows a gold dot when it differs from the look's preset, and a reset
// that puts back the preset's value. Sliders preview live while dragged; the edit's
// history (ui/editor.js) takes one step when the drag lands.
//
// The editor owns the look: this reads it through get() and changes it through
// set(patch), and redraws from get() after each change. extras[section] adds the
// editor's own controls that are not look fields (auto zoom) to a section. Required from ui/editor.js,
// so nothing here is a renderer global.

const Look = require('./look')
const S = require('./look-schema')
const Fmt = require('./fmt')
const Photos = require('./unsplash-picker')

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// How a field reads on screen. Every number goes through the one formatter (ui/fmt.js),
// so a dial here and the same value anywhere else in Fetch are written the same way:
// units joined, decimals from the dial's step with trailing zeros dropped, x with at
// least one decimal, a sign on dials that go both ways. display is the schema's word
// for a dial read in other units than it is stored in (the shutter, in degrees).
const disp = x => {
  const d = x.display || {}
  return { unit: d.unit || x.unit || '', scale: d.scale != null ? d.scale : x.scale, step: x.step,
    signed: x.min < 0 && x.max > 0 }
}
// what the slider's own numbers are multiplied by, so its steps land on shown values
const kOf = x => { const o = disp(x); return o.scale != null ? +o.scale : o.unit === '%' ? 100 : 1 }
const clean = n => +(+n).toFixed(6)
// 0.06 with unit % is 6%, 1.7 with x is 1.7x, 0.5 of a shutter is 180°
function shown(x, v) {
  if (v == null) return ''
  return Fmt.value(v, disp(x))
}
// and back, from what a person types into the number box
function parsed(x, s) {
  const o = disp(x)
  return Fmt.parse(s, { unit: o.unit, scale: o.scale })
}

const LABELS = { 'video-blur': 'Blur', 'none': 'None', 'auto': 'Auto', 'hide': 'Hide', 'keep': 'Keep', 'remove': 'Remove' }
// the schema's own name for an option first, so the Captions tab and this say one thing
const optLabel = (o, x) => (x && x.optionLabels && x.optionLabels[o]) || LABELS[o] || (/^\d/.test(o) ? o : o.charAt(0).toUpperCase() + o.slice(1))

// A mesh as CSS: the same control points the compositor reads, each a soft radial
// stop over the deepest one. Close enough for a swatch, and there is still only one
// table of points.
const meshCss = name => {
  const pts = S.MESHES[name] || S.MESHES.dusk
  const stops = pts.map(([x, y, r, c]) =>
    `radial-gradient(circle at ${Math.round(x * 100)}% ${Math.round(y * 100)}%,${c} 0%,${c}00 ${Math.round(r * 150)}%)`)
  return `${stops.join(',')},${pts[pts.length - 1][3]}`
}

// A small picture of a look: its background, and the take as a rounded card on it
function thumbStyle(look, file) {
  const L = Look.resolve(look), b = L.background
  const grad = g => `linear-gradient(135deg,${S.GRADIENTS[g][0]},${S.GRADIENTS[g][1]})`
  const bg = b.kind === 'solid' ? b.color
    : b.kind === 'gradient' ? grad(b.gradient)
    : b.kind === 'mesh' ? meshCss(b.mesh)
    : b.kind === 'image' && file ? `url("file://${encodeURI(file).replace(/"/g, '%22')}") center/cover`
    : b.kind === 'video-blur' ? 'radial-gradient(circle at 30% 30%,#6B5A48,#241F1B 70%)'
    : b.kind === 'none' ? 'var(--ink-2)' : grad('dusk')
  const framed = b.kind !== 'none'
  const pad = framed ? Math.round(L.frame.padding * 100 * 1.6) : 0
  const r = framed ? Math.max(2, Math.round(L.frame.radius / 5)) : 2
  const sh = framed ? `0 3px 8px rgba(0,0,0,${(0.6 * L.frame.shadow).toFixed(2)})` : 'none'
  const grey = L.treatment.saturation <= -0.9
  return { bg, card: `inset:${pad}%;border-radius:${r}px;box-shadow:${sh}${grey ? ';filter:grayscale(1)' : ''}` }
}

function create(root, o) {
  const open = new Set(o.open || ['frame', 'background'])
  const ico = o.ico || (() => '')
  let saving = false
  // The photo picker keeps its own search between draws (ui/unsplash-picker.js)
  const photos = Photos.create(root, {
    api: o.photos, ico, toast: o.toast,
    redraw: () => render(),
    onAssetsChanged: o.onAssetsChanged,
    onPick: (p, id) => set({ [p]: id, 'background.kind': 'image' }),
    onAddKey: o.onAddKey,
  })

  const presets = () => Look.list(o.userDir)
  const base = look => {
    const p = Look.findPreset(look.preset, o.userDir)
    return p ? Look.merge(Look.defaults(), p.look).look : Look.defaults()
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  function field(x, look, ref) {
    const v = Look.getPath(look, x.path), was = Look.getPath(ref, x.path)
    const mod = !same(v, was)
    const id = 'lk-' + x.path.replace('.', '-')
    const note = o.notes && o.notes[x.path] ? o.notes[x.path](look) : ''
    const head = (right = '') => `<div class="lk-top">
        <label class="lk-lbl" for="${id}" title="${esc(x.doc)}">${esc(x.label)}${mod ? '<i class="lk-dot" aria-label="changed"></i>' : ''}</label>
        ${mod ? `<button class="lk-reset" data-reset="${x.path}" data-tip="Back to ${esc(ref.preset === 'fetch-default' ? 'the default' : presetLabel(ref.preset))}" aria-label="Reset ${esc(x.label)}">${ico('arrow-counter-clockwise', 'icon-sm')}</button>` : ''}
        ${right}</div>`
    let body = ''
    if (x.type === 'number') {
      const k = kOf(x)
      body = head(`<input class="lk-num mono" id="${id}" data-num="${x.path}" value="${esc(shown(x, v))}" spellcheck="false" aria-label="${esc(x.label)}">`) +
        `<input type="range" class="slider" data-range="${x.path}" min="${clean(x.min * k)}" max="${clean(x.max * k)}" step="${clean((x.step || 0.01) * k)}" value="${clean((v == null ? x.default : v) * k)}" aria-label="${esc(x.label)}">`
    } else if (x.type === 'bool') {
      body = `<label class="lk-top lk-bool"><span class="lk-lbl" title="${esc(x.doc)}">${esc(x.label)}${mod ? '<i class="lk-dot" aria-label="changed"></i>' : ''}</span>
        ${mod ? `<button class="lk-reset" data-reset="${x.path}" aria-label="Reset ${esc(x.label)}">${ico('arrow-counter-clockwise', 'icon-sm')}</button>` : ''}
        <span class="switch"><input type="checkbox" id="${id}" data-bool="${x.path}" ${v ? 'checked' : ''}><span class="track"></span></span></label>` +
        (x.sub ? `<p class="micro dimmer lk-note">${esc(x.sub)}</p>` : '')
    } else if (x.type === 'enum' && (x.path === 'background.gradient' || x.path === 'background.mesh')) {
      const swatch = g => x.path === 'background.mesh' ? meshCss(g) : `linear-gradient(135deg,${S.GRADIENTS[g][0]},${S.GRADIENTS[g][1]})`
      body = head() + `<div class="lk-swatches" role="radiogroup" aria-label="${esc(x.label)}">${x.options.map(g =>
        `<button class="lk-grad" role="radio" aria-checked="${g === v}" data-enum="${x.path}" data-v="${g}" data-tip="${esc(optLabel(g, x))}"
          style="background:${swatch(g)}"></button>`).join('')}</div>`
    } else if (x.type === 'enum') {
      const chips = x.options.length > 4 || x.path === 'background.kind'
      body = head() + (chips
        ? `<div class="aspect-chips" role="radiogroup" aria-label="${esc(x.label)}">${x.options.map(op =>
            `<button class="chip" role="radio" aria-pressed="${op === v}" aria-checked="${op === v}" data-enum="${x.path}" data-v="${op}">${esc(optLabel(op, x))}</button>`).join('')}</div>`
        : `<div class="seg seg-sm lk-seg" role="radiogroup" aria-label="${esc(x.label)}">${x.options.map(op =>
            `<button role="radio" aria-selected="${op === v}" aria-checked="${op === v}" data-enum="${x.path}" data-v="${op}">${esc(optLabel(op, x))}</button>`).join('')}</div>`)
    } else if (x.type === 'color') {
      body = head(`<span class="lk-hex mono">${esc(v)}</span><label class="colour-well" data-tip="Any colour">
        <input type="color" data-color="${x.path}" value="${esc(v)}" aria-label="${esc(x.label)}"><span style="background:${esc(v)}"></span></label>`)
    } else if (x.type === 'asset') {
      // the photographs, each with who took it, and a live Unsplash search under them
      body = head() + photos.html(x.path, v, (o.assets && o.assets()) || [], !!o.onAddAsset)
    } else if (o.choices && o.choices[x.path] && typeof window !== 'undefined' && typeof window.Dropdown === 'function') {
      // a name from a known list (the caption font) is the same dropdown the Captions
      // tab shows, filled after the draw by mountChoices
      body = head() + `<div class="dd" id="${id}" data-choice="${x.path}"></div>`
    } else {
      body = head() + `<input class="input input-sm lk-text" id="${id}" data-text="${x.path}" value="${esc(v)}"${
        x.placeholder ? ` placeholder="${esc(x.placeholder)}"` : ''} spellcheck="false">`
    }
    return `<div class="lk-field" data-path="${x.path}" data-mod="${mod}">${body}${note ? `<p class="micro dimmer lk-note">${esc(note)}</p>` : ''}</div>`
  }

  const presetLabel = name => { const p = Look.findPreset(name, o.userDir); return p ? p.label : name }

  const count = n => n ? `<span class="lk-count mono" data-tip="${n} changed from the look">${n}</span>` : ''
  const head = (key, label, n, isOpen) => `<button class="lk-sec-head" aria-expanded="${isOpen}" data-sec-toggle="${esc(key)}">
    <span class="insp-sec">${esc(label)}</span>${count(n)}
    <span style="flex:1"></span>${ico('caret-down', 'icon-sm lk-caret')}</button>`

  // The dials of a section that are rarely the answer, behind one disclosure. A tilt or
  // an aberration is a real control and belongs here, just not second in Frame; the
  // count on the head is so a change never hides inside a closed group.
  function advanced(s, fields, look, ref) {
    if (!fields.length) return ''
    const key = s.id + ':advanced'
    const isOpen = open.has(key)
    const n = fields.filter(x => !same(Look.getPath(look, x.path), Look.getPath(ref, x.path))).length
    // nested in its section's fields, which editor.css draws as a quieter disclosure
    // (.lk-fields > .lk-sec): sentence case, secondary grey, no divider
    return `<div class="lk-sec" data-sec="${key}">${head(key, 'Advanced', n, isOpen)}
      <div class="lk-fields" ${isOpen ? '' : 'hidden'}>${fields.map(x => field(x, look, ref)).join('')}</div></div>`
  }

  function render() {
    const look = Look.resolve(o.get())
    const ref = base(look)
    const secs = Look.sections().filter(s => !o.sections || o.sections.includes(s.id))
    const order = o.sections || secs.map(s => s.id)
    secs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    const scroll = root.closest('.insp-body')
    const top = scroll ? scroll.scrollTop : 0
    const act = typeof document !== 'undefined' && document.activeElement
    const typing = act && root.contains(act) && act.matches('[data-ph-q]') ? act.selectionStart : null
    const files = o.assets ? o.assets() : []
    const fileOf = l => { const im = Look.resolve(l).background.image; const a = files.find(f => f.id === im); return a && a.file }
    const list = presets()
    const changed = !same(Look.diff(ref, look), {})
    root.innerHTML = `
      <div class="lk-presets" role="radiogroup" aria-label="Looks">
        ${list.map(p => {
          const pl = Look.merge(Look.defaults(), p.look).look
          const t = thumbStyle(pl, fileOf(pl))
          const on = p.name === look.preset
          return `<button class="lk-preset" role="radio" aria-checked="${on}" aria-pressed="${on}" data-preset="${esc(p.name)}" data-tip="${esc(p.doc || p.label)}">
            <span class="lk-thumb" style="background:${t.bg}"><i style="${t.card}"></i></span>
            <span class="lk-pname"><span>${esc(p.label)}</span>${on && changed ? '<i class="lk-dot" aria-label="changed"></i>' : ''}</span></button>`
        }).join('')}
      </div>
      <div class="lk-save">
        ${saving
          ? `<input class="input input-sm lk-save-name" id="lkSaveName" placeholder="Name this look" maxlength="48" spellcheck="false">
             <button class="btn btn-sm btn-primary" data-save-go>Save</button>
             <button class="btn btn-sm btn-ghost" data-save-cancel>Cancel</button>`
          : `<button class="btn btn-sm btn-ghost" data-save>${ico('plus', 'icon-sm')} Save look</button>
             ${changed ? `<button class="btn btn-sm btn-ghost" data-reset-all>${ico('arrow-counter-clockwise', 'icon-sm')} Reset to ${esc(presetLabel(look.preset))}</button>` : ''}`}
      </div>
      ${secs.map(s => {
        const fields = s.fields.filter(x => Look.visible(x, look))
        const n = fields.filter(x => !same(Look.getPath(look, x.path), Look.getPath(ref, x.path))).length
        const isOpen = open.has(s.id)
        return `<section class="lk-sec" data-sec="${s.id}">
          ${head(s.id, s.label, n, isOpen)}
          <div class="lk-fields" ${isOpen ? '' : 'hidden'}>${o.extras && o.extras[s.id] ? o.extras[s.id](look) : ''}${
            fields.filter(x => !x.advanced).map(x => field(x, look, ref)).join('')}${
            advanced(s, fields.filter(x => x.advanced), look, ref)}</div>
        </section>`
      }).join('')}`
    mountChoices(look)
    if (scroll) scroll.scrollTop = top
    if (typing != null) { const q = root.querySelector('[data-ph-q]'); if (q) { q.focus({ preventScroll: true }); q.setSelectionRange(typing, typing) } }
    if (saving) { const n = root.querySelector('#lkSaveName'); if (n) n.focus() }
  }
  function mountChoices(look) {
    root.querySelectorAll('[data-choice]').forEach(el => {
      const p = el.dataset.choice
      const items = o.choices[p]() || []
      const v = Look.getPath(look, p)
      const list = items.some(i => i.id === v) ? items : [{ id: v, label: v }].concat(items)
      window.Dropdown(el, list, v, id => set({ [p]: id }))
      el.dataset.choice = p
    })
  }

  const set = (patch, live) => { o.set(patch, { live: !!live }); if (!live) render() }

  root.addEventListener('click', e => {
    const t = e.target.closest('button')
    if (!t || !root.contains(t)) return
    const d = t.dataset
    if (d.preset) {
      // choosing the look you are on puts it back as it ships
      set({ preset: d.preset })
    } else if (d.secToggle) {
      open.has(d.secToggle) ? open.delete(d.secToggle) : open.add(d.secToggle); render()
    } else if (d.reset) {
      set({ [d.reset]: Look.getPath(base(Look.resolve(o.get())), d.reset) })
    } else if ('resetAll' in d) {
      set({ preset: Look.resolve(o.get()).preset })
    } else if (d.enum) {
      set({ [d.enum]: d.v })
    } else if (d.asset) {
      set({ [d.asset]: d.v })
    } else if (d.addAsset) {
      o.onAddAsset(id => set({ [d.addAsset]: id, 'background.kind': 'image' }))
    } else if ('save' in d) {
      saving = true; render()
    } else if ('saveCancel' in d) {
      saving = false; render()
    } else if ('saveGo' in d) {
      save()
    }
  })
  function save() {
    const n = root.querySelector('#lkSaveName')
    const name = n && n.value.trim()
    if (!name) { if (n) n.focus(); return }
    try {
      const entry = Look.save(o.userDir, name, Look.resolve(o.get()))
      saving = false
      set({ preset: entry.name })
      if (o.toast) o.toast(`Saved ${entry.label}`, 'ok')
    } catch (err) {
      if (o.toast) o.toast(err.message, 'bad')
    }
  }
  root.addEventListener('keydown', e => {
    if (e.target.id === 'lkSaveName') {
      if (e.key === 'Enter') { e.preventDefault(); save() }
      if (e.key === 'Escape') { e.preventDefault(); saving = false; render() }
      return
    }
    if (e.target.dataset.num && e.key === 'Enter') e.target.blur()
  })
  root.addEventListener('input', e => {
    const t = e.target, d = t.dataset
    if (d.range) {
      const x = S.BY_PATH.get(d.range), v = clean(+t.value / kOf(x))
      const num = root.querySelector(`[data-num="${d.range}"]`)
      if (num) num.value = shown(x, v)
      t.style.setProperty('--fill', ((t.value - t.min) / (t.max - t.min) * 100) + '%')
      set({ [d.range]: v }, true)
    } else if (d.color) {
      const sw = t.parentElement.querySelector('span'); if (sw) sw.style.background = t.value
      set({ [d.color]: t.value }, true)
    }
  })
  root.addEventListener('change', e => {
    const t = e.target, d = t.dataset
    if (d.range) set({ [d.range]: clean(+t.value / kOf(S.BY_PATH.get(d.range))) })
    else if (d.bool) set({ [d.bool]: t.checked })
    else if (d.color) set({ [d.color]: t.value })
    else if (d.text) set({ [d.text]: t.value })
    else if (d.num) {
      const v = parsed(S.BY_PATH.get(d.num), t.value)
      if (v == null) render(); else set({ [d.num]: v })
    }
  })

  render()
  // the sliders' gold fill, which components.css reads from --fill
  const fills = () => root.querySelectorAll('.slider').forEach(s => s.style.setProperty('--fill', ((s.value - s.min) / (s.max - s.min) * 100) + '%'))
  new MutationObserver(fills).observe(root, { childList: true })
  fills()
  return { render }
}

module.exports = { create, shown, parsed, thumbStyle, kOf }
