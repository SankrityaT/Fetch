// Where an export's finished frames go: packed NV12 bytes into an ffmpeg that encodes.
// The frames never cross IPC: the render window writes them straight into its own
// ffmpeg child's stdin.
'use strict'
const { spawn } = require('child_process')

// Measured on the Songscription tour at 1080p60: x264 veryfast at CRF 23 made 5 MB at
// SSIM 0.989 in 3.8 s; VideoToolbox needed 22 MB for 0.987 at 3 Mbit/s and ran slower,
// and WebCodecs' encoder (Chromium on VideoToolbox) has no constant-quality mode, so at
// a bitrate that keeps text sharp it wrote 71 MB. Screen content is flat and x264
// spends almost nothing on it. sink 'vt' and 'webcodecs' stay for measuring.
const BPP = { balanced: 0.085, small: 0.05, high: 0.12 }
const QUALITY_ALIAS = { best: 'high', fast: 'small' }

// What the compositor hands this encoder is not what the classic renderer hands it: the
// ground has a tooth, and four of the seven looks put a roll of film in front of the
// whole frame. One to two and a half levels of luma, renewed thirty times a second, over
// two megapixels. A rate-distortion encoder's first move on fine noise over a flat field
// is to throw it away, so three taste passes scored a texture off PNGs that the file the
// customer plays did not carry: on a still passage the delivered ground was byte for
// byte the frame before it for up to seventeen frames at a stretch, and what was left of
// the tooth was one frozen picture of it rather than a surface that lives
// (`.context/survey/m5-fades.md`). Every number about it is measured on the decoded file
// now, which is the only end of this pipe that was ever worth measuring.
//
// What the encoder is told, at high and at balanced:
//
//   psy-rd          rate-distortion that prefers a frame carrying the same amount of
//                   texture to a frame that is merely closer in error. It is the whole
//                   of this, and it needs subme >= 6, which is what moves the preset off
//                   veryfast. fast runs no trellis, so the psy-trellis term is small.
//   aq-mode 3       quantiser down into flat and dark blocks, which is where a ground
//                   and a dark look's page are. Strength is the dial that matters and it
//                   is the one to leave alone: at 0.6 the ground goes back to standing
//                   still, and above 1.0 it is exponential, since a ground is most of the
//                   flat area in the frame. 1.4 is three times the file and 1.8 is ten.
//   no-dct-decimate stop x264 zeroing a block whose coefficients come to almost nothing.
//                   A block of tooth is almost nothing, by definition.
//   deblock -1,-1   the deblocker is a smoother and three levels of tooth is the first
//                   thing it smooths. Costs no bits at all.
//
// fast is a better preset than veryfast, so one step of rate factor pays for most of
// what those cost and the delivered picture is the one it was: against the drawn frames,
// mean absolute difference 1.22 levels where it was 1.25, p99 5 where it was 6, SSIM
// 0.9853 where it was 0.9854. What changes is where the bits go.
//
// The tuning was given to high alone, on the reading that a rate factor that cannot carry
// the tooth cannot be told into carrying it, and that reading was wrong, which left the
// quality the Export dialog opens on frozen. Measured per macroblock rather than per
// frame, which is the size the decision is actually made at: the thing that holds a ground
// still is x264's early skip probe, which quantises the block's own residual at the
// block's own QP and takes P_SKIP the moment every coefficient zeroes. A block of tooth
// zeroes. The rate factor moves that QP, which is why CRF 20 looked like the cure and CRF
// 23 like a wall, but the preset is what decides whether anything else ever gets a say:
// at veryfast, subme 2 means no rate-distortion mode decision at all and psy-rd is inert,
// so the probe is the whole of the decision and the reference is copied forward until the
// next keyframe. At balanced that was 99 percent of ground blocks held every frame and the
// median block standing still for the whole of a hundred frame group, which is one frozen
// picture, exactly as it reads.
//
// So balanced runs the same tuning at its own rate factor, CRF 23 untouched, and the rate
// factor was left alone on purpose: what a quality name promises is a size, and this is a
// change in where the bits go. On the Songscription tour, over a 200 frame still passage,
// on the four looks with a ground worth measuring, no delivered frame's ground is byte for
// byte the one before it any more (Paper was 107 of 199 pairs, Mono print 6, Noir 1, now 0
// on all four). Per macroblock, where the loss really lives: Noir's median ground block is
// held 28 frames where it was 101 and renews eight times as hard, at 8.1 MB where it was
// 6.0; the default look 61 frames where it was 101, four and a half times, 7.4 MB where it
// was 5.9. Fidelity against the drawn frames does not move (SSIM 0.9913 where it was
// 0.9893 on Paper, 0.9819 where it was 0.9810 on Noir), and the export runs at 3.4 to 4.1
// x real time on those four looks against a 1.0 gate.
//
// Paper and Mono print are the honest remainder. Their grounds carry a third to half of
// Noir's amplitude, so per block they barely move at CRF 23, and they pay the same fifth
// of a file as the looks that do. That is arithmetic rather than tuning, and one tuning
// per rate factor is worth more than a table of exceptions: even at high, Paper's median
// ground block sits for 81 frames.
//
// small keeps the encoder it had, measured rather than assumed. At CRF 28 the same tuning
// costs a fifth of the file and the ground does not move at all (renewal 0.0030 to 0.0032
// on Noir, 0.0029 to 0.0025 on the default look); fast-pskip=0 alone does move it and
// wants ninety percent more file. A file that small is a promise about size, and a still
// ground is what that promise buys. `.context/survey/ain-p10.md` has the whole sweep.
const X264_GRAIN = 'psy-rd=1.5,0.15:aq-mode=3:aq-strength=1.0:no-dct-decimate=1:deblock=-1,-1'
const CRF = { high: 20, balanced: 23, small: 28 }
const PRESET = { high: 'fast', balanced: 'fast', small: 'veryfast' }
const TUNE = { high: ['-x264-params', X264_GRAIN], balanced: ['-x264-params', X264_GRAIN] }

/**
 * The encoder's arguments. W4 x H is the packed frame (W rounded up to four); the
 * output is cropped back to W. quality: high, balanced or small, as the classic export.
 */
function encodeArgs(file, W, H, fps, { quality = 'balanced', W4 = W, codec = 'x264' } = {}) {
  const q = CRF[QUALITY_ALIAS[quality] || quality] ? (QUALITY_ALIAS[quality] || quality) : 'balanced'
  const venc = codec === 'vt'
    ? ['-c:v', 'h264_videotoolbox', '-b:v', String(Math.round(W * H * fps * BPP[q])), '-profile:v', 'high', '-allow_sw', '1']
    : ['-c:v', 'libx264', '-preset', PRESET[q], '-crf', String(CRF[q]), ...(TUNE[q] || []), '-pix_fmt', 'yuv420p']
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
