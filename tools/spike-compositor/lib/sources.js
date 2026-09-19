// Spike sources. Each hands the compositor the source frame for output frame n (time
// n/F) with sample-and-hold across capture gaps, and says whether it changed so an
// unchanged frame is not uploaded again.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';

// ffmpeg NV12 pipe. The fps filter does the constant-rate resample in ffmpeg, so every
// pipe frame is one output frame. round=up is sample-and-hold (frame n shows the latest
// source frame with pts <= n/F); round=down shows off-grid frames one slot early
// (67/200 on the jittered counter fixture against 200/200). `scale` optionally resizes
// on the GPU with scale_vt before the download (decode-size scaling).
class FfmpegSource {
  constructor(file, { fps = 60, start = 0, dur = null, w, h, scale = null, hw = true, queue = 4, worker = true, transport = 'tcp', round = 'up' } = {}) {
    this.w = scale ? scale[0] : w; this.h = scale ? scale[1] : h;
    this.frameBytes = this.w * this.h * 3 / 2;
    const vf = [`fps=${fps}:round=${round}`];
    const a = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (hw) a.push('-hwaccel', 'videotoolbox');
    if (hw && scale) a.push('-hwaccel_output_format', 'videotoolbox_vld');
    if (start) a.push('-ss', String(start));
    a.push('-i', file);
    if (dur != null) a.push('-t', String(dur));
    if (scale) vf.push(hw ? `scale_vt=w=${this.w}:h=${this.h},hwdownload,format=nv12` : `scale=${this.w}:${this.h}:flags=bicubic,format=nv12`);
    else vf.push('format=nv12');
    a.push('-an', '-vf', vf.join(','), '-f', 'rawvideo', '-pix_fmt', 'nv12', 'pipe:1');
    this.args = a;
    this.frames = []; this.cur = null; this.fill = 0; this.ended = false; this.waiter = null;
    this.pool = []; this.queue = queue; this.n = -1; this.chunks = 0;
    if (worker) {
      // Reading the pipe on the compositor thread delivers 8 KB chunks in Electron's
      // renderer loop (about 60 fps at Retina size); a worker keeps up.
      this.worker = new Worker(require('path').join(__dirname, 'pipe-worker.js'));
      this.worker.onmessage = (e) => {
        if (e.data.end) { this.ended = true; this.chunks = e.data.chunks; }
        else { this.frames.push(e.data.frame); this.chunks = e.data.chunks; }
        this.wake();
      };
      this.worker.postMessage({ cmd: 'start', ffmpeg: FFMPEG, args: a, frameBytes: this.frameBytes, queue, transport });
      return;
    }
    this.proc = spawn(FFMPEG, a, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.err = '';
    this.proc.stderr.on('data', (d) => { this.err += d; });
    this.buf = this.alloc();
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stdout.on('end', () => { this.ended = true; this.wake(); });
  }
  alloc() { return this.pool.pop() || new Uint8Array(this.frameBytes); }
  onData(d) {
    this.chunks++;
    let off = 0;
    while (off < d.length) {
      const take = Math.min(d.length - off, this.frameBytes - this.fill);
      this.buf.set(d.subarray(off, off + take), this.fill);
      this.fill += take; off += take;
      if (this.fill === this.frameBytes) {
        this.frames.push(this.buf); this.buf = this.alloc(); this.fill = 0;
      }
    }
    if (this.frames.length >= this.queue) this.proc.stdout.pause();
    this.wake();
  }
  wake() { if (this.waiter) { const w = this.waiter; this.waiter = null; w(); } }
  // Frames arrive in output order, so frameAt must be called with n = 0, 1, 2...
  async frameAt(n) {
    while (this.n < n) {
      while (!this.frames.length && !this.ended) await new Promise((r) => { this.waiter = r; });
      if (!this.frames.length) return this.cur ? { data: this.cur, changed: false, w: this.w, h: this.h, eof: true } : null;
      if (this.cur) this.release(this.cur);
      this.cur = this.frames.shift(); this.n++;
      if (!this.worker && this.frames.length < this.queue) this.proc.stdout.resume();
    }
    return { data: this.cur, changed: true, w: this.w, h: this.h };
  }
  release(buf) {
    if (this.worker) this.worker.postMessage({ cmd: 'free', buf: buf.buffer }, [buf.buffer]);
    else this.pool.push(buf);
  }
  close() {
    if (this.worker) { this.worker.postMessage({ cmd: 'kill' }); setTimeout(() => this.worker.terminate(), 200); return; }
    try { this.proc.kill('SIGKILL'); } catch {}
  }
}

// WebCodecs over mp4box.js. Decodes in presentation order and holds the latest frame
// whose timestamp is <= the output time: the same sample-and-hold as fps round=down.
class WebCodecsSource {
  constructor(file, { fps = 60, hw = 'prefer-hardware', ahead = 6 } = {}) {
    this.file = file; this.fps = fps; this.hw = hw; this.ahead = ahead;
  }
  async open() {
    const MP4Box = require(require('path').join(__dirname, '..', 'node_modules', 'mp4box', 'dist', 'mp4box.all.cjs'));
    const buf = fs.readFileSync(this.file);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    ab.fileStart = 0;
    const mp4 = MP4Box.createFile();
    // Extraction has to be armed inside onReady: armed later, mp4box never emits the
    // samples of a buffer it has already parsed.
    this.samples = [];
    let track = null, err = null;
    mp4.onError = (e) => { err = e; };
    mp4.onReady = (info) => {
      track = info.videoTracks[0];
      mp4.onSamples = (_id, _u, s) => { for (const x of s) this.samples.push(x); };
      mp4.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples });
      mp4.start();
    };
    mp4.appendBuffer(ab); mp4.flush();
    if (err || !track) throw new Error('demux failed: ' + err);
    if (this.samples.length < track.nb_samples) throw new Error(`demux got ${this.samples.length}/${track.nb_samples} samples`);
    this.track = track;
    const trak = mp4.getTrackById(track.id);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    // mp4box reports raw composition times; players apply the edit list (x264 B-frame
    // takes start at cts = 2 frames), so shift by its media_time to match them.
    const elst = trak.edts && trak.edts.elst && trak.edts.elst.entries.find((e) => e.media_time >= 0);
    this.shiftUs = elst ? Math.round(1e6 * elst.media_time / track.timescale) : 0;
    const box = entry.avcC || entry.hvcC;
    const ds = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
    box.write(ds);
    const description = new Uint8Array(ds.buffer, 8);
    this.config = { codec: track.codec, codedWidth: track.video.width, codedHeight: track.video.height,
      description, hardwareAcceleration: this.hw, optimizeForLatency: false };
    const support = await VideoDecoder.isConfigSupported(this.config);
    if (!support.supported) throw new Error('decoder config unsupported: ' + track.codec);
    this.frames = []; this.cur = null; this.si = 0; this.done = false; this.flushing = false; this.waiter = null;
    this.decoder = new VideoDecoder({
      output: (f) => { this.frames.push(f); this.wake(); },
      error: (e) => { this.error = e; this.wake(); },
    });
    this.decoder.configure(this.config);
    this.decoder.addEventListener('dequeue', () => this.wake());
    this.w = track.video.width; this.h = track.video.height;
    return this;
  }
  wake() { if (this.waiter) { const w = this.waiter; this.waiter = null; w(); } }
  feed() {
    while (this.si < this.samples.length && this.decoder.decodeQueueSize < 4 && this.frames.length < this.ahead) {
      const s = this.samples[this.si++];
      this.decoder.decode(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round(1e6 * s.cts / s.timescale) - this.shiftUs, duration: Math.round(1e6 * s.duration / s.timescale), data: s.data }));
    }
    if (this.si >= this.samples.length && !this.flushing) {
      this.flushing = true; this.decoder.flush().then(() => { this.done = true; this.wake(); });
    }
  }
  async frameAt(n) {
    const tUs = Math.round(1e6 * n / this.fps) + 1; // +1 us absorbs rounding of exact frame times
    let changed = false;
    for (;;) {
      if (this.error) throw this.error;
      while (this.frames.length && this.frames[0].timestamp <= tUs) {
        if (this.cur) this.cur.close();
        this.cur = this.frames.shift(); changed = true;
      }
      if (this.frames.length || this.done) break;
      this.feed();
      if (this.frames.length) continue;
      await new Promise((r) => { this.waiter = r; });
    }
    this.feed();
    if (!this.cur) return null;
    const eof = this.done && !this.frames.length && this.si >= this.samples.length && tUs > this.cur.timestamp + (this.cur.duration || 0) + 1e6;
    return { frame: this.cur, changed, w: this.cur.displayWidth, h: this.cur.displayHeight, eof };
  }
  close() { try { this.decoder.close(); } catch {} for (const f of this.frames) f.close(); if (this.cur) this.cur.close(); }
}

// The editor preview: a <video> element, seeked, with the frame taken once Chromium has
// presented it (requestVideoFrameCallback), which also reports the frame's media time.
class VideoElementSource {
  constructor(file, { opacity0 = true } = {}) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.style.cssText = `position:fixed;left:0;top:0;width:320px;height:200px;${opacity0 ? 'opacity:0;' : ''}pointer-events:none`;
    v.src = 'file://' + file;
    document.body.appendChild(v);
    this.v = v;
  }
  async open() {
    await new Promise((res, rej) => { this.v.onloadeddata = res; this.v.onerror = () => rej(this.v.error); });
    this.w = this.v.videoWidth; this.h = this.v.videoHeight; return this;
  }
  // Seek to t and wait for the presented frame. rVFC is raced against a timeout so a
  // throttled window reports failure instead of hanging.
  async seek(t, { useRvfc = true, timeout = 2000 } = {}) {
    const v = this.v;
    const got = new Promise((res) => {
      let done = false;
      const fin = (how, meta) => { if (!done) { done = true; res({ how, meta }); } };
      if (useRvfc) v.requestVideoFrameCallback((_now, meta) => fin('rvfc', meta));
      else v.addEventListener('seeked', () => fin('seeked'), { once: true });
      setTimeout(() => fin('timeout'), timeout);
    });
    v.currentTime = t;
    return got;
  }
  close() { this.v.remove(); }
}

module.exports = { FfmpegSource, WebCodecsSource, VideoElementSource, FFMPEG };
