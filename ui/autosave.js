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
        <span class="dimmer">${mins < 60 ? mins + ' minutes ago' : when.toLocaleString()}</span></span>
      <button class="btn btn-sm" data-do="discard">Start fresh</button>
      <button class="btn btn-sm btn-primary" data-do="restore">Pick up where I left off</button>`
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
        backdrop: saved.backdrop, backdropFile: saved.backdropFile,
        autoZoom: !!saved.autoZoom,
      })
      try { paintTrim(); renderTexts(); renderLayerList(); paintCrop(); paintBackdrop(); paintCaption() } catch {}
      if (typeof toast === 'function') toast('Restored your edit', 'ok')
      close()
    }
  }

  // wrap the editor's open so restoring needs no changes inside editor.js
  const install = () => {
    if (typeof window.openInEditor !== 'function' || window.openInEditor.__autosave) return false
    const original = window.openInEditor
    const wrapped = async function (src) {
      const result = await original.apply(this, arguments)
      try {
        const saved = pending
        if (saved && saved.dirty && saved.src === src && !pendingResolved) {
          setTimeout(() => restoreBanner(saved), 400)   // after the editor paints
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
