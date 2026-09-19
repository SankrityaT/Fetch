// Web Worker with Node integration: runs one ffmpeg decode and reads its NV12 frames
// off the compositor's thread, posting whole frames (transferred, not copied). Freed
// buffers come back for reuse.
//
// Over loopback TCP, never stdout: Electron reads a large pipe in 8 KB chunks, about
// 70 fps at Retina size; a socket reads 64 KB at a time and ran 316 to 631 fps (M0).
'use strict'
const { spawn } = require('child_process')
let proc = null, stream = null, pending = 0, paused = false, maxPending = 6, killed = false
const pool = []
onmessage = (e) => {
  const m = e.data
  if (m.cmd === 'free') {
    pending--; pool.push(m.buf)
    if (paused && pending < maxPending && stream) { paused = false; stream.resume() }
    return
  }
  if (m.cmd === 'kill') { killed = true; if (proc) try { proc.kill('SIGKILL') } catch {} ; return }
  if (m.cmd !== 'start') return
  const size = m.frameBytes; maxPending = m.queue || 6
  let buf = new Uint8Array(size), fill = 0, err = ''
  const onData = (d) => {
    let off = 0
    while (off < d.length) {
      const take = Math.min(d.length - off, size - fill)
      buf.set(d.subarray(off, off + take), fill); fill += take; off += take
      if (fill === size) {
        postMessage({ frame: buf }, [buf.buffer]); pending++
        buf = pool.length ? new Uint8Array(pool.pop()) : new Uint8Array(size); fill = 0
      }
    }
    if (pending >= maxPending && !paused) { paused = true; stream.pause() }
  }
  const srv = require('net').createServer((sock) => {
    srv.close(); stream = sock
    sock.on('data', onData)
    sock.on('error', () => {})
    sock.on('end', () => postMessage({ end: true }))
  })
  srv.listen(0, '127.0.0.1', () => {
    const args = m.args.slice(); args[args.length - 1] = `tcp://127.0.0.1:${srv.address().port}`
    proc = spawn(m.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    postMessage({ pid: proc.pid })
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000) })
    proc.on('close', (code) => {
      // ffmpeg that never connected (a bad file, a bad graph) would leave us waiting
      if (!stream) { try { srv.close() } catch {} ; postMessage({ end: true }) }
      if (code && !killed) postMessage({ error: `ffmpeg exited ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}` })
    })
  })
}
