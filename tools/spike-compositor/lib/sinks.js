// Spike sinks. Nv12PipeSink feeds packed NV12 (or RGBA) bytes to an ffmpeg child that
// encodes; EncoderSink uses WebCodecs VideoEncoder on the canvas and mp4-muxer. Both end
// with an ffmpeg stream-copy mux that adds the audio produced by audioGraph.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const { FFMPEG } = require('./sources');

const TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg ' + c + ': ' + err.slice(-400)))));
  });
}

class Nv12PipeSink {
  constructor(file, W, H, fps, { format = 'nv12', codec = 'vt', bitrate = '16M' } = {}) {
    const venc = codec === 'vt'
      ? ['-c:v', 'h264_videotoolbox', '-b:v', bitrate, '-profile:v', 'high', '-allow_sw', '0']
      : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'];
    // RGBA input gets converted by swscale; say which matrix so it matches the pack pass.
    const conv = format === 'rgba' ? ['-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p'] : [];
    // The NV12 is already BT.709 limited, so say so on the input too. Tagging only the
    // output makes ffmpeg 8 treat the untagged input as another matrix and convert it
    // (pure red 63/102/240 came back as 59/105/230, dE 5).
    const inTags = format === 'nv12' ? ['-colorspace', 'bt709', '-color_range', 'tv'] : [];
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', format, '-s', `${W}x${H}`,
      '-r', String(fps), ...inTags, '-i', 'pipe:0', ...conv, ...venc, ...TAGS, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file];
    this.proc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.err = ''; this.proc.stderr.on('data', (d) => { this.err += d; });
    this.closed = new Promise((res) => this.proc.on('close', (c) => res(c)));
    this.bytes = format === 'rgba' ? W * H * 4 : W * H * 3 / 2;
    this.pool = []; this.file = file;
  }
  buffer() { return this.pool.pop() || Buffer.allocUnsafeSlow(this.bytes); }
  // Resolves when the pipe accepts the frame (or has room); the buffer is returned to the
  // pool once written, so readback never overwrites bytes ffmpeg has not read.
  write(buf) {
    return new Promise((resolve) => {
      const ok = this.proc.stdin.write(buf, () => this.pool.push(buf));
      if (ok) resolve(); else this.proc.stdin.once('drain', resolve);
    });
  }
  async end() {
    this.proc.stdin.end();
    const c = await this.closed;
    if (c !== 0) throw new Error('encoder exit ' + c + ': ' + this.err.slice(-400));
  }
}

class EncoderSink {
  constructor(file, canvas, W, H, fps, { bitrate = 16e6 } = {}) {
    const { Muxer, ArrayBufferTarget } = require('mp4-muxer');
    this.file = file; this.canvas = canvas; this.fps = fps;
    this.target = new ArrayBufferTarget();
    this.muxer = new Muxer({ target: this.target, video: { codec: 'avc', width: W, height: H, frameRate: fps }, fastStart: 'in-memory' });
    this.waiter = null; this.error = null;
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
      error: (e) => { this.error = e; },
    });
    this.config = { codec: 'avc1.640028', width: W, height: H, bitrate, framerate: fps,
      hardwareAcceleration: 'prefer-hardware', latencyMode: 'quality', avc: { format: 'avc' } };
    this.encoder.addEventListener('dequeue', () => { if (this.waiter) { const w = this.waiter; this.waiter = null; w(); } });
  }
  async open() {
    const s = await VideoEncoder.isConfigSupported(this.config);
    if (!s.supported) throw new Error('encoder config unsupported');
    this.encoder.configure(this.config);
    return this;
  }
  // Wraps the canvas as it stands now (the caller has just presented frame n).
  async encodeCanvas(n) {
    if (this.error) throw this.error;
    const f = new VideoFrame(this.canvas, { timestamp: Math.round(n * 1e6 / this.fps), duration: Math.round(1e6 / this.fps) });
    this.encoder.encode(f, { keyFrame: n % (this.fps * 2) === 0 });
    f.close();
    while (this.encoder.encodeQueueSize > 3) await new Promise((r) => { this.waiter = r; });
  }
  async end() {
    await this.encoder.flush();
    this.muxer.finalize();
    fs.writeFileSync(this.file, Buffer.from(this.target.buffer));
  }
}

// Audio stays in ffmpeg: a representative clean-up graph on the take's audio track.
function audioGraph(src, out, { start = 0, dur = null } = {}) {
  const a = [];
  if (start) a.push('-ss', String(start));
  a.push('-i', src);
  if (dur != null) a.push('-t', String(dur));
  a.push('-vn', '-af', 'highpass=f=70,afftdn=nf=-28,loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:d=0.25', '-c:a', 'aac', '-b:a', '192k', out);
  return run(a);
}

// Final mux: video stream copy plus the finished audio, colour tags restated.
function mux(video, audio, out) {
  const a = ['-i', video];
  if (audio) a.push('-i', audio);
  a.push('-map', '0:v:0');
  if (audio) a.push('-map', '1:a:0');
  a.push('-c', 'copy', '-movflags', '+faststart', out);
  return run(a);
}

module.exports = { Nv12PipeSink, EncoderSink, audioGraph, mux, run, TAGS };
