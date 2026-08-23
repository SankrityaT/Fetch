/* Fetch preferences. Loaded once at startup and exposed on window.prefs so any
   view (setup wizard, hero button, editor) can read the saved defaults without
   its own round trip to main. Persisted in <userData>/prefs.json by main.js.

   Wrapped in an IIFE: this loads before ui/app.js, which declares its own
   top-level `const ipcRenderer`, `fs`, `path`, etc. Anything declared here at
   the top level with `const`/`let` would collide with those (all scripts in
   the document share one global scope) and crash every script after it. */
;(function () {
  const ipc = require('electron').ipcRenderer

  const DEFAULT_PREFS = {
    saveDir: null,           // null means "use Desktop", resolved in main
    camera: true,
    mic: true,
    systemAudio: true,
    countdown: 3,            // 0, 3 or 5 seconds
    autoConvertMp4: false,
    openEditorAfter: false,
    keepOriginal: true,
    quickRecord: false,
  }

  window.prefs = Object.assign({}, DEFAULT_PREFS)

  // setup.js and app.js run in the next script tags and may read window.prefs
  // while building their own state, so this has to be settled before they
  // execute. sendSync blocks this one script until main answers, which is
  // fine: it happens once, before first paint.
  try {
    const saved = ipc.sendSync('prefs-get-sync')
    if (saved && typeof saved === 'object') Object.assign(window.prefs, saved)
  } catch {}

  // shallow merge into the in-memory copy and persist. Anything reading
  // window.prefs afterwards sees the change immediately.
  window.savePrefs = function savePrefs(patch) {
    Object.assign(window.prefs, patch)
    ipc.invoke('prefs-set', patch).catch(() => {})
    return window.prefs
  }
})()
