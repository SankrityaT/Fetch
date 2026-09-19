// Where an export's pixels come from: an ffmpeg decode of exactly the frames the plan
// needs, in order, as NV12. (The editor's pixels come from its <video>; see
// ui/editor.js. M6 adds WebCodecs for native takes.)
//
// Sample and hold is done here, not by ffmpeg's fps filter: the take's frame times are
// read from the container first (framePts, about 0.1 s for a thousand frames), the plan
// picks the frame each output frame shows (plan.frameMap), and ffmpeg decodes only the
// runs of frames that are shown. A frame that did not change is not uploaded again.
'use strict'
const { spawn } = require('child_process')
const path = require('path')

/**
 * Presentation times of a file's first video stream, sorted, in seconds. ffmpeg's
 * framecrc of a stream copy lists every packet with its pts in the stream's time base
 * (edit lists already applied), without decoding anything.
 */
function framePts(ffmpeg, file) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-'])
    let out = '', err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('error', reject)
    p.on('close', code => {
      const tb = /#tb 0: (\d+)\/(\d+)/.exec(out)
      if (code !== 0 || !tb) return reject(new Error('could not read frame times: ' + err.trim().slice(-200)))
      const k = +tb[1] / +tb[2]
      const pts = []
      for (const line of out.split('\n')) {
        if (!line || line[0] === '#') continue
        const f = line.split(',')
        const v = +f[2]
        if (Number.isFinite(v)) pts.push(v * k)
      }
      pts.sort((a, b) => a - b)
      // the coded size rides along: the camera is decoded at its own size
      const dim = /#dimensions 0: (\d+)x(\d+)/.exec(out)
      if (dim) pts.size = [+dim[1], +dim[2]]
      resolve(pts)
    })
  })
}

/**
 * The ffmpeg arguments for a decode of `runs` (index ranges into pts) from `file`,
 * cropped and optionally scaled on the GPU first (decode sizing), NV12 out. The last
 * argument is the address the worker swaps in.
 *   crop   { x, y, w, h } in the frames as decoded (after any scale), even numbers
 *   scale  [w, h] to scale the whole frame to with scale_vt before the crop, or null
 *   cover  a square side to cover and centre crop to (the camera bubble), instead of crop;
 *          with a crop as well, the crop is taken first and cover only scales
 */
function decodeArgs(file, pts, runs, { crop = null, scale = null, cover = null, hw = true } = {}) {
  const eps = 0.0004
  const lo = runs.length ? pts[runs[0][0]] : 0
  const sel = runs.map(([a, b]) => `between(t,${(pts[a] - eps).toFixed(6)},${(pts[b] + eps).toFixed(6)})`).join('+')
  const a = ['-hide_banner', '-loglevel', 'error', '-nostdin']
  if (hw) a.push('-hwaccel', 'videotoolbox')
  if (hw && scale) a.push('-hwaccel_output_format', 'videotoolbox_vld')
  // Original timestamps, so select's t is the pts framePts read. An accurate seek to
  // just before the first shown frame skips decoding a long trimmed head.
  // -start_at_zero: framePts (and the edit's clock) count from the file's start, so a
  // file that starts at 1.5 s (an import, a remux) must too, or every pick is off by it.
  a.push('-copyts', '-start_at_zero')
  if (lo > 1) a.push('-ss', (lo - eps * 2).toFixed(6))
  a.push('-i', file, '-map', '0:v:0', '-an', '-sn', '-dn')
  const vf = [`select='${sel}'`]
  if (scale) vf.push(hw ? `scale_vt=w=${scale[0]}:h=${scale[1]},hwdownload,format=nv12` : `scale=${scale[0]}:${scale[1]}:flags=area`)
  if (crop) vf.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}:exact=1`)
  if (cover) vf.push(`scale=${cover}:${cover}:force_original_aspect_ratio=increase:flags=area`, `crop=${cover}:${cover}`)
  vf.push('format=nv12')
  a.push('-vf', vf.join(','), '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'nv12', 'tcp://127.0.0.1:0')
  return a
}

class FfmpegSource {
  /**
   * map    plan.frameMap's { pick, runs }
   * w, h   the frames' size as they arrive (after crop or cover)
   */
  constructor(ffmpeg, args, map, w, h, { queue = 4, onPid = null } = {}) {
    this.w = w; this.h = h
    this.frameBytes = w * h * 3 / 2
    this.pick = map.pick
    // the index of each frame the pipe will deliver, in order
    this.order = []
    for (const [a, b] of map.runs) for (let i = a; i <= b; i++) this.order.push(i)
    this.frames = []; this.cur = null; this.curIdx = -1; this.k = 0
    this.ended = false; this.waiter = null; this.error = null
    this.worker = new Worker(path.join(__dirname, 'pipe-worker.js'))
    this.worker.onmessage = (e) => {
      const d = e.data
      if (d.pid && onPid) onPid(d.pid)
      else if (d.error) this.error = new Error(d.error)
      else if (d.end) this.ended = true
      else if (d.frame) this.frames.push(d.frame)
      this.wake()
    }
    this.worker.onerror = (e) => { this.error = new Error('decode worker: ' + (e.message || e)); this.wake() }
    if (!this.order.length) { this.ended = true; return }
    this.worker.postMessage({ cmd: 'start', ffmpeg, args, frameBytes: this.frameBytes, queue })
  }
  wake() { if (this.waiter) { const w = this.waiter; this.waiter = null; w() } }

  // The frame output frame n shows: { data, changed } or null when it shows none.
  // Called with n = 0, 1, 2...: the pipe only runs forward.
  async frameAt(n) {
    const want = this.pick[n]
    if (want < 0) return null
    while (this.curIdx < want) {
      if (this.k >= this.order.length) break
      while (!this.frames.length && !this.ended && !this.error) await new Promise(r => { this.waiter = r })
      if (this.error) throw this.error
      // a pipe that ended early holds its last frame rather than failing the export
      if (!this.frames.length) { this.k = this.order.length; break }
      if (this.cur) this.release(this.cur)
      this.cur = this.frames.shift(); this.curIdx = this.order[this.k++]
      this.changed = true
    }
    if (!this.cur) return null
    const changed = !!this.changed; this.changed = false
    // everything shown has arrived: stop the decode now rather than at the file's end
    if (this.k >= this.order.length && !this.stopped) { this.stopped = true; this.worker.postMessage({ cmd: 'kill' }) }
    return { data: this.cur, changed, w: this.w, h: this.h }
  }
  release(buf) { this.worker.postMessage({ cmd: 'free', buf: buf.buffer }, [buf.buffer]) }
  close() {
    try { this.worker.postMessage({ cmd: 'kill' }) } catch {}
    const w = this.worker
    setTimeout(() => { try { w.terminate() } catch {} }, 300)
  }
}

module.exports = { framePts, decodeArgs, FfmpegSource }
