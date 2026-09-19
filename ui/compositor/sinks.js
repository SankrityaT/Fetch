// Where an export's finished frames go: packed NV12 bytes into an ffmpeg that encodes.
// The frames never cross IPC: the render window writes them straight into its own
// ffmpeg child's stdin.
'use strict'
const { spawn } = require('child_process')

// The same encoder and rate factors as the classic export (processor FORMATS), so a
// file is the same size whichever renderer drew it. Measured on the Songscription tour
// at 1080p60: x264 veryfast at CRF 23 made 5 MB at SSIM 0.989 in 3.8 s; VideoToolbox
// needed 22 MB for 0.987 at 3 Mbit/s and ran slower, and WebCodecs' encoder (Chromium
// on VideoToolbox) has no constant-quality mode, so at a bitrate that keeps text sharp
// it wrote 71 MB. Screen content is flat and x264 spends almost nothing on it.
// sink 'vt' and 'webcodecs' stay for measuring.
const BPP = { balanced: 0.085, small: 0.05, high: 0.12 }
const QUALITY_ALIAS = { best: 'high', fast: 'small' }
const CRF = { high: 19, balanced: 23, small: 28 }

/**
 * The encoder's arguments. W4 x H is the packed frame (W rounded up to four); the
 * output is cropped back to W. quality: high, balanced or small, as the classic export.
 */
function encodeArgs(file, W, H, fps, { quality = 'balanced', W4 = W, codec = 'x264' } = {}) {
  const q = CRF[QUALITY_ALIAS[quality] || quality] ? (QUALITY_ALIAS[quality] || quality) : 'balanced'
  const venc = codec === 'vt'
    ? ['-c:v', 'h264_videotoolbox', '-b:v', String(Math.round(W * H * fps * BPP[q])), '-profile:v', 'high', '-allow_sw', '1']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(CRF[q]), '-pix_fmt', 'yuv420p']
  return ['-hide_banner', '-loglevel', 'error', '-y',
    // the bytes are BT.709 limited range already, and ffmpeg has to be told on the input:
    // tagged only on the output, ffmpeg 8 converted them as another matrix (dE 5)
    '-f', 'rawvideo', '-pix_fmt', 'nv12', '-s', `${W4}x${H}`, '-r', String(fps),
    '-colorspace', 'bt709', '-color_range', 'tv', '-i', 'tcp://127.0.0.1:0',
    ...(W4 !== W ? ['-vf', `crop=${W}:${H}:0:0`] : []),
    ...venc,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart', '-an', file]
}

// Frames go to the encoder over loopback TCP, not its stdin: from Electron's renderer a
// pipe took 144 frames a second of 1080p NV12, a socket 740 (the read side has the same
// limit, pipe-worker.js). ffmpeg connects to a port we listen on.
class Nv12PipeSink {
  constructor(ffmpeg, args, bytes, { onPid = null } = {}) {
    this.bytes = bytes
    this.pool = []
    this.err = ''
    this.sock = new Promise((resolve, reject) => {
      const srv = require('net').createServer(sock => { srv.close(); sock.on('error', () => {}); resolve(sock) })
      srv.listen(0, '127.0.0.1', () => {
        const a = args.slice(); a[a.indexOf('tcp://127.0.0.1:0')] = `tcp://127.0.0.1:${srv.address().port}`
        this.proc = spawn(ffmpeg, a, { stdio: ['ignore', 'ignore', 'pipe'] })
        if (onPid) onPid(this.proc.pid)
        this.proc.stderr.on('data', d => { this.err = (this.err + d).slice(-2000) })
        this.closed = new Promise(res => this.proc.on('close', c => {
          res(c)
          try { srv.close() } catch {}
          reject(new Error('the encoder stopped before it started: ' + this.err.trim().split('\n').slice(-2).join(' | ')))
        }))
      })
    })
  }
  buffer() { return this.pool.pop() || Buffer.allocUnsafeSlow(this.bytes) }
  // Resolves once the socket has room. The buffer goes back to the pool when it has been
  // sent, so a readback never overwrites bytes still queued.
  async write(buf) {
    const sock = await this.sock
    return new Promise(resolve => {
      const ok = sock.write(buf, () => this.pool.push(buf))
      if (ok) resolve(); else sock.once('drain', resolve)
    })
  }
  async end() {
    const sock = await this.sock
    sock.end()
    const c = await this.closed
    if (c !== 0) throw new Error('the encoder stopped (' + c + '): ' + this.err.trim().split('\n').slice(-2).join(' | '))
  }
  kill() { try { this.proc.kill('SIGKILL') } catch {} }
}

/**
 * Chromium's own H.264 encoder (WebCodecs, VideoToolbox underneath) on the canvas the
 * frame was presented to: no readback at all. Faster than VideoToolbox through ffmpeg
 * (M0), but bitrate only, so files run large (see encodeArgs); not the default. Annex B
 * chunks go into an ffmpeg that copies them into the container at a constant rate.
 */
class WebCodecsSink {
  constructor(ffmpeg, file, canvas, W, H, fps, { quality = 'balanced', onPid = null } = {}) {
    const q = QUALITY_ALIAS[quality] || quality
    this.canvas = canvas; this.fps = fps; this.W = W; this.H = H
    this.config = {
      // High profile, level 5.2: room for 4K60, which a Retina take at its own size needs
      codec: 'avc1.640034', width: W, height: H, framerate: fps,
      bitrate: Math.round(W * H * fps * (BPP[q] || BPP.balanced)), bitrateMode: 'variable',
      hardwareAcceleration: 'prefer-hardware', latencyMode: 'quality', avc: { format: 'annexb' },
    }
    // A raw stream carries no timestamps ffmpeg will trust: -framerate alone came out
    // at 149 fps. Generated from -r, one frame per slot.
    this.args = ['-hide_banner', '-loglevel', 'error', '-y', '-fflags', '+genpts', '-r', String(fps), '-f', 'h264', '-i', 'pipe:0',
      '-c', 'copy', '-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0',
      '-movflags', '+faststart', '-an', file]
    this.ffmpeg = ffmpeg; this.onPid = onPid
    this.error = null; this.waiter = null; this.writing = Promise.resolve()
  }
  static async supported(W, H, fps) {
    if (typeof VideoEncoder === 'undefined') return false
    try {
      const r = await VideoEncoder.isConfigSupported({ codec: 'avc1.640034', width: W, height: H, framerate: fps,
        bitrate: 8e6, hardwareAcceleration: 'prefer-hardware', avc: { format: 'annexb' } })
      return !!r.supported
    } catch { return false }
  }
  async open() {
    const { spawn } = require('child_process')
    this.proc = spawn(this.ffmpeg, this.args, { stdio: ['pipe', 'ignore', 'pipe'] })
    if (this.onPid) this.onPid(this.proc.pid)
    this.err = ''
    this.proc.stderr.on('data', d => { this.err = (this.err + d).slice(-2000) })
    this.proc.stdin.on('error', () => {})
    this.closed = new Promise(res => this.proc.on('close', c => res(c)))
    this.encoder = new VideoEncoder({
      output: (chunk) => {
        const buf = Buffer.allocUnsafe(chunk.byteLength)
        chunk.copyTo(buf)
        if (!this.proc.stdin.write(buf)) this.writing = new Promise(r => this.proc.stdin.once('drain', r))
      },
      error: (e) => { this.error = e; this.wake() },
    })
    this.encoder.addEventListener('dequeue', () => this.wake())
    this.encoder.configure(this.config)
    return this
  }
  wake() { if (this.waiter) { const w = this.waiter; this.waiter = null; w() } }
  // Encode the canvas as it stands (the caller has just presented frame n)
  async encode(n) {
    if (this.error) throw this.error
    const f = new VideoFrame(this.canvas, { timestamp: Math.round(n * 1e6 / this.fps), duration: Math.round(1e6 / this.fps) })
    this.encoder.encode(f, { keyFrame: n % (this.fps * 2) === 0 })
    f.close()
    while (this.encoder.encodeQueueSize > 4 && !this.error) await new Promise(r => { this.waiter = r })
    await this.writing
  }
  async end() {
    await this.encoder.flush()
    if (this.error) throw this.error
    await this.writing
    this.proc.stdin.end()
    const c = await this.closed
    if (c !== 0) throw new Error('the muxer stopped (' + c + '): ' + this.err.trim().split('\n').slice(-2).join(' | '))
  }
  kill() { try { this.encoder.close() } catch {} try { this.proc.kill('SIGKILL') } catch {} }
}

module.exports = { encodeArgs, Nv12PipeSink, WebCodecsSink }
