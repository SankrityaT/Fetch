// The hidden render window (render.html): runs compositor exports sent by the main
// process (ui/render-host.js) and reports progress, the pids of the ffmpeg children it
// starts (so a cancel can kill them) and the result. Frames never leave this process:
// decode, draw, readback and encode all happen here.
'use strict'
const { ipcRenderer } = require('electron')
const { renderVideo, renderStills } = require('./compositor')

const cancelled = new Set()
ipcRenderer.on('render:cancel', (_e, id) => cancelled.add(id))

// A font a project carries has to be in this window before anything is drawn with it:
// the compositor names faces by CSS family, and a family nothing registered falls back
// to system-ui without saying so, which is how a title card set in the product's own
// face came out in SF Pro. Registered once per family per window, since the window
// outlives a job.
const fontsIn = new Set()
async function useFonts(list) {
  for (const f of list || []) {
    if (!f || !f.family || !f.file || fontsIn.has(f.family)) continue
    fontsIn.add(f.family)
    try {
      const face = new FontFace(f.family, `url("file://${encodeURI(f.file)}")`)
      await face.load()
      document.fonts.add(face)
    } catch (err) {
      // a face that will not load is a picture in the wrong font, never a failed export
      console.warn('[render] font', f.family, 'did not load:', err && err.message)
      fontsIn.delete(f.family)
    }
  }
}

ipcRenderer.on('render:job', async (_e, job) => {
  const id = job.id
  if (job.fonts && job.fonts.length) await useFonts(job.fonts)
  const hooks = {
    progress: (n, total) => ipcRenderer.send('render:progress', { id, n, total }),
    pid: pid => ipcRenderer.send('render:pid', { id, pid }),
    cancelled: () => cancelled.has(id),
  }
  try {
    const stats = job.stills ? await renderStills(job, hooks) : await renderVideo(job, hooks)
    ipcRenderer.send('render:done', { id, stats })
  } catch (err) {
    ipcRenderer.send('render:done', { id, error: String((err && err.message) || err), cancelled: !!(err && err.cancelled) })
  } finally {
    cancelled.delete(id)
  }
})

// Whether this machine can run the compositor at all: WebGL2 with the formats it needs
ipcRenderer.on('render:probe', (_e, id) => {
  let ok = false, renderer = null, error = null
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
      ok = true
      const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext()
    }
  } catch (e) { error = e.message }
  ipcRenderer.send('render:probe', { id, ok, renderer, error })
})

ipcRenderer.send('render:ready')
