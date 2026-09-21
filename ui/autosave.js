// Editor autosave. The editor holds a lot of unsaved intent (trim points, cuts,
// text layers, crop, caption style, backdrop) and none of it lived anywhere until
// export. A crash or an accidental quit threw all of it away.
//
// Deliberately implemented without touching editor.js: it observes the global `ed`
// and wraps openInEditor, so the editor stays a single concern.
;(() => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const DIR = path.join(os.homedir(), 'Library/Application Support/Fetch')
  const FILE = path.join(DIR, 'editor-state.json')
  const SAVE_EVERY = 1200
  let warned = false

  const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return null } }
  const write = obj => {
    try {
      fs.mkdirSync(DIR, { recursive: true })
      // write then rename, so a crash mid-write cannot leave a truncated file
      const tmp = FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
      fs.renameSync(tmp, FILE)
      warned = false
    } catch (e) {
      // Crash recovery that fails quietly is worse than none: the person believes
      // their work is safe. Say it once, not every 1.2 seconds.
      if (!warned) { warned = true; console.error('autosave failed:', e.message)
        if (typeof toast === 'function') toast('Autosave is not working, so a crash would lose edits', 'bad', 7000) }
    }
  }

  // only the fields worth restoring, so the snapshot stays small and comparable
  const snapshot = () => {
    if (typeof ed === 'undefined' || !ed.src) return null
    return {
      src: ed.src,
      in: +(ed.in || 0).toFixed(3),
      out: +(ed.out || 0).toFixed(3),
      cuts: (ed.cuts || []).map(c => [+c[0].toFixed(3), +c[1].toFixed(3)]),
      texts: ed.texts || [],
      crop: ed.crop || null,
      cropAR: ed.cropAR || 'free',
      capStyle: ed.capStyle || null,
      backdrop: ed.backdrop || null,
      backdropFile: ed.backdropFile || null,
      autoZoom: !!ed.autoZoom,
      look: ed.look || null,
    }
  }

  // an untouched clip is not worth restoring, so compare against a clean baseline
  const isPristine = s =>
    !s || (!s.cuts.length && !s.texts.length && !s.crop && !s.backdrop && !s.autoZoom &&
           s.in <= 0.001 && Math.abs(s.out - (ed.dur || 0)) < 0.05)

  // Read the previous session's state once, before anything can overwrite it.
  // Reopening a clip resets the editor to a pristine state, and the first autosave
  // tick would otherwise erase the crash recovery we are about to offer.
  const pending = read()
  let pendingResolved = false

  let last = ''
  setInterval(() => {
    const s = snapshot()
    if (!s) return
    // hold off while an unresolved restore offer exists for this same clip
    if (!pendingResolved && pending && pending.dirty && pending.src === s.src && isPristine(s)) return
    const json = JSON.stringify(s)
    if (json === last) return
    last = json
    write({ ...s, savedAt: Date.now(), dirty: !isPristine(s) })
  }, SAVE_EVERY)

  // the updater checks `dirty` before restarting, so clear it once work is exported
  window.clearEditorDirty = () => {
    const cur = read()
    if (cur) write({ ...cur, dirty: false })
  }

  function restoreBanner(saved) {
    const mount = document.querySelector('.ed-main') || document.querySelector('.ed')
    if (!mount) return
    const bar = document.createElement('div')
    bar.className = 'restore-bar'
    const when = new Date(saved.savedAt)
    const mins = Math.max(1, Math.round((Date.now() - saved.savedAt) / 60000))
    bar.innerHTML = `
      <img class="restore-dog" src="./assets/mascot/thinking.png" alt="">
      <span class="restore-text">You left this clip mid-edit
        <span class="dimmer">${mins < 60 ? mins + (mins === 1 ? ' minute ago' : ' minutes ago') : when.toLocaleString()}</span></span>
      <button class="btn btn-sm btn-ghost" data-do="discard">Start fresh</button>
      <button class="btn btn-sm" data-do="restore">Pick up where I left off</button>`
    mount.prepend(bar)

    const close = () => { pendingResolved = true; bar.remove() }
    bar.querySelector('[data-do="discard"]').onclick = () => {
      write({ ...saved, dirty: false })
      close()
    }
    bar.querySelector('[data-do="restore"]').onclick = () => {
      Object.assign(ed, {
        in: saved.in, out: saved.out, cuts: saved.cuts || [], texts: saved.texts || [],
        crop: saved.crop, cropAR: saved.cropAR || 'free',
        capStyle: saved.capStyle || ed.capStyle,
        autoZoom: !!saved.autoZoom,
      })
      // backdrop is a mirror of the look now (editor.js syncLookMirrors); an older
      // snapshot without a look still brings its backdrop back
      try {
        const Look = require('./ui/look')
        ed.look = saved.look ? Look.resolve(saved.look)
          : Look.merge(ed.look, { background: Look.backgroundFromId(saved.backdrop, saved.backdropFile) }).look
        syncLookMirrors()
      } catch {}
      try { paintTrim(); renderTexts(); renderLayerList(); paintCrop(); paintBackdrop(); paintCaption() } catch {}
      if (typeof toast === 'function') toast('Restored your edit', 'ok')
      close()
    }
  }

  // ── version history ─────────────────────────────────────────────────────
  // Every settled state of the open take's edit, kept across sessions in its own
  // sidecar (ui/history.js says what is kept and for how long). Wired here for the
  // reason the rest of this file is: it observes the editor from outside rather than
  // threading a hook through every control, and it sees the three ways an edit changes.
  //   the person's hand   the tick below, settled after a quiet spell
  //   an agent            fetchDoc.apply and fetchShot.apply, which only agents call
  //   an undo             fetchUndo.undo, from a chat card or revert_my_edit
  const History = require('./ui/history')
  let ipc = null
  try { ipc = require('electron').ipcRenderer } catch {}
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const live = () => (typeof ed !== 'undefined' && ed.shot ? window.fetchShot : window.fetchDoc)
  const ready = () => typeof ed !== 'undefined' && ed.src && ed.docReady && live()
  const hist = { src: null, log: null, peek: null, busy: 0, warned: false }
  const exists = f => { try { return fs.existsSync(f) } catch { return false } }
  // which file a reference was, so one rewritten in place is not restored as the old one
  const stat = f => { const st = fs.statSync(f); return { size: st.size, mtime: st.mtimeMs } }

  // The sidecar, read and written through whatever path the take has now, so a
  // rename mid-session carries on in the moved file.
  const io = {
    file: () => History.historyPath(hist.src),
    read: () => { try { return fs.readFileSync(io.file(), 'utf8') } catch { return '' } },
    // false when the line did not land, so the log writes the next one whole
    append: text => {
      // a late write for a take in the Trash would bring its folder back
      if (!hist.src || !exists(hist.src)) return false
      try { fs.mkdirSync(path.dirname(io.file()), { recursive: true }); fs.appendFileSync(io.file(), text); return true }
      catch (e) { histFailed(e); return false }
    },
    replace: text => {
      if (!hist.src || !exists(hist.src)) return
      try { const tmp = io.file() + '.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, io.file()) } catch (e) { histFailed(e) }
    },
  }
  function histFailed(e) {
    if (hist.warned) return
    hist.warned = true
    console.error('history not written:', e.message)
    if (typeof toast === 'function') toast('Version history is not being saved for this take', 'bad', 7000)
  }

  function histOpen(src) {
    if (hist.log && hist.src && hist.src !== src) { try { hist.log.flush() } catch {} }
    endPeek(false)
    hist.src = src; hist.log = null; hist.warned = false
    if (!ready() || ed.src !== src) return
    try {
      hist.log = History.createLog({ io, stat })
      hist.log.open(live().get())
      hist.log.tidy()                       // thinning runs on open, not while anyone works
    } catch (e) { hist.log = null; console.error('history unavailable:', e.message) }
    // the History button's count paints the moment a take opens, not at its first change
    if (hist.log) { try { window.fetchHistory.onchange() } catch {} }
  }

  // The person's hand. Held open by ui/history.js until quiet, so a drag is one version.
  setInterval(() => {
    if (!hist.log || hist.busy || !ready() || ed.src !== hist.src) return
    let d
    try { d = live().get() } catch { return }
    if (hist.peek) {
      // A hand edit on the old version on screen is a choice of it: restore it first,
      // then the edit lands on top as the person's own, and nothing is thrown away.
      if (History.same(d, hist.peek.shown)) return
      const { n, now } = hist.peek
      endPeek(false)
      hist.log.restore(n, now, { exists })
    }
    hist.log.person(d)
    if (hist.log.tick()) window.fetchHistory.onchange()
  }, SAVE_EVERY)

  // the person's open version is written before the window goes, not lost with it
  window.addEventListener('beforeunload', () => { try { if (hist.log && !hist.peek) hist.log.flush() } catch {} })

  const byOf = (opts, fallback) => (opts && Object.prototype.hasOwnProperty.call(opts, 'by') ? opts.by : fallback)

  // An agent's change, recorded against the state it actually started from. The
  // person's own pending edit is closed first as theirs. An agent never edits an old
  // version by accident: a peek ends before its change lands.
  function wrapApply(obj) {
    if (!obj || typeof obj.apply !== 'function' || obj.apply.__history) return
    const original = obj.apply
    const wrapped = async function (patch, opts) {
      if (hist.peek) endPeek(true)
      const src = typeof ed !== 'undefined' ? ed.src : null
      let before = null
      try { before = obj.get() } catch {}
      hist.busy++
      try {
        const after = await original.apply(this, arguments)
        if (hist.log && before && after && src === hist.src && ed.src === src) {
          hist.log.agent(before, after, byOf(opts, 'Agent'))
          window.fetchHistory.onchange()
        }
        return after
      } finally { hist.busy-- }
    }
    wrapped.__history = true
    obj.apply = wrapped
  }

  // An undo of an agent's change. A chat card passes its level and is the person's
  // click; revert_my_edit passes the path alone and is the agent. Either can say
  // outright with { by }.
  function wrapUndo(obj) {
    if (!obj || typeof obj.undo !== 'function' || obj.undo.__history) return
    const original = obj.undo
    const wrapped = async function (src, level, opts) {
      if (hist.peek) endPeek(true)
      const on = src || (typeof ed !== 'undefined' && ed.src)
      let before = null
      try { if (ready() && ed.src === on) before = live().get() } catch {}
      hist.busy++
      try {
        const ok = await original.apply(this, arguments)
        if (ok && hist.log && ed.src === hist.src && ed.src === on) {
          hist.log.undo(before, live().get(), byOf(opts, level ? null : 'Agent'))
          window.fetchHistory.onchange()
        }
        return ok
      } finally { hist.busy-- }
    }
    wrapped.__history = true
    obj.undo = wrapped
  }

  // The editor's own Undo agent button calls straight through, not via fetchUndo. It is
  // always the person, and the event it fires is the one place to see it as an undo.
  window.addEventListener('fetch:agent-edit', e => {
    const d = e.detail || {}
    if (!d.undo || hist.busy || !hist.log || d.src !== hist.src || !ready()) return
    try { hist.log.undo(null, live().get(), d.by == null ? null : d.by); window.fetchHistory.onchange() } catch {}
  })

  // A take renamed while open: move its history with it if nothing else did, and
  // keep writing to the new place.
  function wrapRename() {
    const original = window.editorFollowRename
    if (typeof original !== 'function' || original.__history) return
    const wrapped = function (moves) {
      const map = new Map(moves || [])
      const r = original.apply(this, arguments)
      if (hist.src && map.has(hist.src)) {
        const next = map.get(hist.src)
        const to = History.historyPath(next)
        // Where the file is now if nothing carried it: its old place, or, when the take's
        // folder moved first, the new folder under the old name
        const oldName = path.basename(History.historyPath(hist.src))
        const from = [History.historyPath(hist.src), path.join(path.dirname(to), oldName)].find(f => f !== to && exists(f))
        try { if (from && !exists(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to) } } catch {}
        hist.src = next
        // whatever the file now holds, the next line is written whole
        if (hist.log) hist.log.rebase()
      }
      return r
    }
    wrapped.__history = true
    window.editorFollowRename = wrapped
  }

  // ── looking at an old version ──────────────────────────────────────────
  // The old version is loaded onto the stage so it can be played and scrubbed, and the
  // real edit is held aside untouched. The editor must not save while this is up
  // (it asks window.fetchHistory.peeking()), or looking would be the same as restoring.
  // An agent's apply is awaiting something (the captions file): a look or a restore now
  // would land inside its change and be recorded under its name
  const BUSY = 'An agent is changing this edit right now. Try again in a moment.'
  function peek(n) {
    if (!hist.log || !ready()) return { ok: false, why: 'No take is open.' }
    if (hist.busy) return { ok: false, why: BUSY }
    if (!window.fetchHistory.editorHonoursPeek) {
      return { ok: false, why: 'The editor is not holding its autosave during a peek yet, so looking would overwrite the edit.' }
    }
    const v = hist.log.version(n)
    if (!v) return { ok: false, why: `${History.vid(n)} cannot be read back.` }
    if (!hist.peek) {
      const now = live().get()
      hist.log.person(now); hist.log.flush()
      hist.peek = { n, now }
    }
    const { doc, missing } = hist.log.forRestore(n, hist.peek.now, exists) || History.forRestore(v, hist.peek.now, exists)
    hist.peek.n = n
    hist.busy++
    try { live().load(doc) } finally { hist.busy-- }
    try { hist.peek.shown = live().get() } catch { hist.peek.shown = doc }
    peekBar(n, missing)
    return { ok: true, n, id: History.vid(n), missing }
  }

  // Back to the edit as it was before looking. `reload` is false where the caller is
  // about to load something else anyway.
  function endPeek(reload = true) {
    if (!hist.peek) return
    const p = hist.peek
    hist.peek = null
    const bar = document.querySelector('.restore-bar[data-history]')
    if (bar) bar.remove()
    if (reload && ready()) { hist.busy++; try { live().load(p.now) } finally { hist.busy-- } }
    window.fetchHistory.onchange()
  }

  async function restore(n, opts = {}) {
    if (!hist.log || !ready()) return null
    if (hist.busy) { if (typeof toast === 'function') toast(BUSY, 'bad'); return null }
    const src = ed.src
    const current = hist.peek ? hist.peek.now : live().get()
    endPeek(false)
    const r = hist.log.restore(n, current, { exists, by: byOf(opts, null) })
    if (!r) { if (typeof toast === 'function') toast(`${History.vid(n)} cannot be read back, so nothing changed`, 'bad'); return null }
    hist.busy++
    try {
      live().load(r.doc)
      // the editor's own autosave writes it too, and takes one undo step for it, so
      // Cmd+Z takes a restore back like any other change
      if (ipc) {
        await ipc.invoke(ed.shot ? 'write-shot' : 'write-doc', src, live().get()).catch(() => {})
        if (!ed.shot && !History.same(current.cues, r.doc.cues)) await ipc.invoke('write-cues', src, ed.cues).catch(() => {})
      }
    } finally { hist.busy-- }
    // whatever an agent does next is a change of its own, not part of the last burst
    try { if (window.fetchUndo) window.fetchUndo.mark() } catch {}
    if (r.row && ipc) {
      ipc.invoke('activity-record', { op: 'edit.restore', title: `Restored ${r.row.of}`, detail: `${src} · ${r.row.id}`, by: r.row.by }).catch(() => {})
    }
    if (typeof toast === 'function') toast(esc(r.line), r.missing.length ? 'bad' : 'ok', r.missing.length ? 7000 : 3800)
    window.fetchHistory.onchange()
    return r
  }

  function peekBar(n, missing) {
    const row = hist.log.rows().find(r => r.n === n)
    const mount = document.querySelector('.ed-main') || document.querySelector('.ed')
    if (!mount || !row) return
    let bar = document.querySelector('.restore-bar[data-history]')
    if (!bar) {
      bar = document.createElement('div')
      bar.className = 'restore-bar'
      bar.setAttribute('data-history', '')
      mount.prepend(bar)
    }
    const who = row.by || 'You'
    const when = new Date(row.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    const gone = missing.length ? ` ${History.missingLine(missing).trim()}` : ''
    bar.innerHTML = `
      <img class="restore-dog" src="./assets/mascot/thinking.png" alt="">
      <span class="restore-text">Looking at <span class="mono">${esc(row.id)}</span>, ${esc(who)}, ${esc(when)}
        <span class="dimmer">${esc(row.line)}.${esc(gone)} Nothing is saved until you restore it.</span></span>
      <button class="btn btn-sm btn-ghost" data-do="back">Back to now</button>
      <button class="btn btn-sm" data-do="restore">Restore ${esc(row.id)}</button>`
    bar.querySelector('[data-do="back"]').onclick = () => endPeek(true)
    bar.querySelector('[data-do="restore"]').onclick = () => restore(n)
  }

  // The surface the editor's history panel and the agent bridge read. Rows carry no
  // documents, so a thousand of them cost nothing to list.
  window.fetchHistory = {
    rows: () => (hist.log && ready() && ed.src === hist.src ? hist.log.rows() : []),
    version: n => (hist.log ? hist.log.version(+n) : null),
    describe: (a, b) => History.describe(a, b),
    peek: n => peek(+n),
    back: () => endPeek(true),
    peeking: () => !!hist.peek,
    // The edit as it stands while an old version is on the stage, or null when none is.
    // What anything that reads the edit (get_edit, the chat's context, a rename's write)
    // must read instead of the stage, or looking at the past hands the past on as now.
    current: () => (hist.peek && hist.peek.now ? JSON.parse(JSON.stringify(hist.peek.now)) : null),
    peekingAt: () => (hist.peek ? History.vid(hist.peek.n) : null),
    restore: (n, opts) => restore(+n, opts),
    flush: () => { if (hist.log && !hist.peek) hist.log.flush() },
    src: () => hist.src,
    // the editor sets this once its doc autosave returns early while peeking()
    editorHonoursPeek: false,
    // the panel sets this to repaint; replaced, not stacked
    onchange: () => {},
  }

  // wrap the editor's open so restoring needs no changes inside editor.js
  const install = () => {
    wrapApply(window.fetchDoc); wrapApply(window.fetchShot); wrapUndo(window.fetchUndo); wrapRename()
    if (typeof window.openInEditor !== 'function' || window.openInEditor.__autosave) return false
    const original = window.openInEditor
    const wrapped = async function (src) {
      const result = await original.apply(this, arguments)
      // the editor may have made these objects afresh on this open
      wrapApply(window.fetchDoc); wrapApply(window.fetchShot); wrapUndo(window.fetchUndo); wrapRename()
      try { histOpen(src) } catch {}
      try {
        const saved = pending
        if (saved && saved.dirty && saved.src === src && !pendingResolved) {
          // The saved edit document is loaded on open now, so usually the editor already
          // holds exactly this. Offering to restore what is on screen is noise.
          const same = (a, b) => { const { savedAt, dirty, ...x } = a || {}; return JSON.stringify(x) === JSON.stringify(b) }
          if (same(saved, snapshot())) pendingResolved = true
          else setTimeout(() => restoreBanner(saved), 400)   // after the editor paints
        }
      } catch {}
      return result
    }
    wrapped.__autosave = true
    window.openInEditor = wrapped
    return true
  }
  if (!install()) window.addEventListener('load', install)
})()
