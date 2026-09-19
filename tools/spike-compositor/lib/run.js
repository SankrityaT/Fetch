// Spike runner, inside the hidden window. Each mode measures one exit criterion and
// sends its numbers back to main.js.
'use strict';
const { ipcRenderer } = require('electron');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Compositor, Readback } = require('./gl');
const { FfmpegSource, WebCodecsSource, VideoElementSource, FFMPEG } = require('./sources');
const { Nv12PipeSink, EncoderSink, audioGraph, mux } = require('./sinks');
const { layout, frameLook } = require('./look');
const M = require('./metrics');

const args = JSON.parse(new URLSearchParams(location.search).get('args') || '{}');
const W = Number(args.w || 1920), H = Number(args.h || 1080), F = Number(args.fps || 60);
const TMP = '/tmp/fetch-spike';
const log = (s) => ipcRenderer.send('log', s);

// Yield to the event loop without the 4 ms nested setTimeout clamp.
const mc = new MessageChannel(); const q = [];
mc.port1.onmessage = () => { const r = q.shift(); if (r) r(); };
const yieldNow = () => new Promise((r) => { q.push(r); mc.port2.postMessage(0); });

function probe(file) {
  const j = JSON.parse(execFileSync(FFMPEG.replace('ffmpeg', 'ffprobe'), ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,color_space:format=duration', '-of', 'json', file]));
  const s = j.streams[0];
  return { w: s.width, h: s.height, dur: Number(j.format.duration), avg: s.avg_frame_rate, cs: s.color_space || 'unknown' };
}
const r3 = (v) => Math.round(v * 1000) / 1000;

async function openSource(kind, file, info, extra = {}) {
  if (kind === 'webcodecs') return new WebCodecsSource(file, { fps: F }).open();
  if (kind === 'ffmpeg-scale') {
    // Decode at the size the frame occupies at the deepest zoom, capped at native.
    const rect = layout(W, H, info.w, info.h); const k = Math.min(1, (rect[2] * 1.8) / info.w);
    const sw = Math.round(info.w * k / 2) * 2, sh = Math.round(info.h * k / 2) * 2;
    return new FfmpegSource(file, { fps: F, w: info.w, h: info.h, scale: [sw, sh], ...extra });
  }
  return new FfmpegSource(file, { fps: F, w: info.w, h: info.h, ...extra });
}
function upload(comp, s) {
  if (s.frame) comp.uploadImage(s.frame, s.w, s.h); else comp.uploadNV12(s.data, s.w, s.h);
}
function gpuSync(comp) { const gl = comp.gl; const px = new Uint8Array(4); gl.bindFramebuffer(gl.FRAMEBUFFER, comp.out.fbo); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }

// ---- bench: one full export, source x sink, with per-stage timings -------------------
async function bench() {
  const file = args.src; const info = probe(file);
  const dur = args.dur ? Number(args.dur) : info.dur;
  const N = Math.floor(dur * F);
  const decoder = args.decoder || 'ffmpeg', sinkKind = args.sink || 'nv12';
  const tag = `${path.basename(file).replace(/\W+/g, '_')}-${decoder}-${sinkKind}`;
  const vOut = `${TMP}/${tag}.video.mp4`, aOut = `${TMP}/${tag}.m4a`, final = `${TMP}/${tag}.mp4`;
  const comp = new Compositor(W, H);
  const T0 = performance.now();
  const audio = audioGraph(file, aOut, { dur }).then(() => performance.now() - T0, (e) => { log('audio: ' + e.message); return null; });
  const src = await openSource(decoder, file, info);
  const packed = sinkKind === 'nv12';
  let sink, rb;
  if (sinkKind === 'encoder') sink = await new EncoderSink(vOut, comp.canvas, W, H, F).open();
  else { sink = new Nv12PipeSink(vOut, W, H, F, { format: packed ? 'nv12' : 'rgba', codec: args.codec || 'vt' }); rb = new Readback(comp, { packed, ring: Number(args.ring || 3) }); }
  const st = { src: [], upload: [], compose: [], issue: [], fence: [], copy: [], sink: [], frame: [] };
  let uploads = 0;
  const drain = async () => {
    const buf = sink.buffer();
    const r = await rb.collect(buf, yieldNow); st.fence.push(r.wait); st.copy.push(r.copy);
    const t = performance.now(); await sink.write(buf); st.sink.push(performance.now() - t);
  };
  const Tloop = performance.now();
  for (let n = 0; n < N; n++) {
    const t0 = performance.now();
    const s = await src.frameAt(n);
    if (!s) { log('source ended at ' + n); break; }
    const t1 = performance.now();
    if (s.changed) { upload(comp, s); uploads++; }
    const t2 = performance.now();
    comp.compose(frameLook(W, H, s.w, s.h, n, F));
    const t3 = performance.now();
    if (sinkKind === 'encoder') {
      comp.present();
      await sink.encodeCanvas(n);
      st.sink.push(performance.now() - t3);
    } else {
      if (packed) comp.pack();
      rb.issue(n); st.issue.push(performance.now() - t3);
      if (rb.full) await drain();
    }
    st.src.push(t1 - t0); st.upload.push(t2 - t1); st.compose.push(t3 - t2); st.frame.push(performance.now() - t0);
    if (n % 600 === 0) log(`${tag} ${n}/${N}`);
  }
  if (rb) while (rb.inflight.length) await drain();
  await sink.end();
  const loopMs = performance.now() - Tloop;
  const audioMs = await audio;
  const tm = performance.now();
  await mux(vOut, audioMs != null ? aOut : null, final);
  const muxMs = performance.now() - tm;
  const wall = performance.now() - T0;
  src.close();
  const outInfo = probe(final);
  const stages = {}; for (const [k, v] of Object.entries(st)) stages[k] = M.summary(v);
  return {
    tag, file, source: info, decoder, sink: sinkKind, frames: N, uploads, out: final, outInfo, gpu: comp.renderer,
    loopFps: r3(N / (loopMs / 1000)), wallFps: r3(N / (wall / 1000)), realtime: r3((N / F) / (wall / 1000)),
    ms: { loop: Math.round(loopMs), audio: audioMs && Math.round(audioMs), mux: Math.round(muxMs), wall: Math.round(wall) }, stages,
  };
}

// ---- stages: each stage alone, to find the bottleneck ----------------------------------
async function stages() {
  const file = args.src; const info = probe(file); const res = { file, source: info };
  const NF = Number(args.frames || 600);
  // Decode only.
  const variants = { 'ffmpeg-pipe-mainthread': { worker: false }, 'ffmpeg-pipe-worker': { transport: 'pipe' } };
  for (const kind of ['ffmpeg-pipe-mainthread', 'ffmpeg-pipe-worker', 'ffmpeg', 'ffmpeg-scale', 'webcodecs']) {
    const src = variants[kind] ? await openSource('ffmpeg', file, info, variants[kind]) : await openSource(kind, file, info);
    const t = performance.now(); let n = 0;
    for (; n < NF; n++) { const s = await src.frameAt(n); if (!s) break; }
    res['decode_' + kind] = { fps: r3(n / ((performance.now() - t) / 1000)), frames: n, size: [src.w, src.h] };
    if (src.chunks) res['decode_' + kind].pipeChunksPerFrame = r3(src.chunks / n);
    src.close(); log('decode ' + kind + ' ' + JSON.stringify(res['decode_' + kind]));
  }
  const comp = new Compositor(W, H);
  // Upload only (both source kinds), GPU included via a 1 px sync at the end.
  {
    const src = await openSource('ffmpeg', file, info); const s = await src.frameAt(0);
    const data = s.data.slice(); src.close();
    gpuSync(comp); let t = performance.now();
    for (let i = 0; i < 300; i++) comp.uploadNV12(data, info.w, info.h);
    gpuSync(comp); res.upload_nv12_native = { fps: r3(300 / ((performance.now() - t) / 1000)) };
    const wc = await new WebCodecsSource(file, { fps: F }).open(); const f = await wc.frameAt(30);
    gpuSync(comp); t = performance.now();
    for (let i = 0; i < 300; i++) comp.uploadImage(f.frame, f.w, f.h);
    gpuSync(comp); res.upload_videoframe = { fps: r3(300 / ((performance.now() - t) / 1000)) };
    wc.close();
    comp.uploadNV12(data, info.w, info.h);
  }
  // Compose only: static frame, still (1 tap) and mid-zoom with motion blur (10 taps).
  for (const [name, n] of [['compose_still', 30], ['compose_zoom_blur', Math.round(1.85 * F)]]) {
    const look = frameLook(W, H, info.w, info.h, n, F);
    gpuSync(comp); const t = performance.now();
    for (let i = 0; i < 300; i++) comp.compose({ ...look, frame: i });
    gpuSync(comp); res[name] = { fps: r3(300 / ((performance.now() - t) / 1000)), taps: look.taps };
  }
  // Readback only, both layouts, through the PBO ring.
  for (const packed of [true, false]) {
    const rb = new Readback(comp, { packed, ring: 3 }); const dst = new Uint8Array(rb.bytes);
    let fence = 0, copy = 0; const t = performance.now();
    for (let i = 0; i < 300; i++) {
      if (packed) comp.pack();
      rb.issue(i); if (rb.full) { const r = await rb.collect(dst, yieldNow); fence += r.wait; copy += r.copy; }
    }
    while (rb.inflight.length) await rb.collect(dst, yieldNow);
    res[packed ? 'readback_nv12_packed' : 'readback_rgba'] = { fps: r3(300 / ((performance.now() - t) / 1000)),
      bytes: rb.bytes, copyMsPerFrame: r3(copy / 300), fenceMsPerFrame: r3(fence / 300) };
  }
  // Sync readPixels without a PBO, for contrast.
  { const dst = new Uint8Array(W * H * 1.5); const gl = comp.gl; const t = performance.now();
    for (let i = 0; i < 120; i++) { comp.pack(); gl.bindFramebuffer(gl.FRAMEBUFFER, comp.packed.fbo); gl.readPixels(0, 0, W >> 2, H * 1.5, gl.RGBA, gl.UNSIGNED_BYTE, dst); }
    res.readback_nv12_sync = { fps: r3(120 / ((performance.now() - t) / 1000)) }; }
  // Encode only: ffmpeg VideoToolbox from memory, and WebCodecs VideoEncoder from the canvas.
  for (const fmt of ['nv12', 'rgba']) {
    const sink = new Nv12PipeSink(`${TMP}/enc-only-${fmt}.mp4`, W, H, F, { format: fmt });
    const bufs = [0, 1, 2, 3].map(() => { const b = Buffer.allocUnsafeSlow(sink.bytes); b.fill(90 + Math.random() * 40); return b; });
    const t = performance.now();
    for (let i = 0; i < NF; i++) await sink.write(bufs[i % 4]);
    await sink.end();
    res['encode_vt_' + fmt] = { fps: r3(NF / ((performance.now() - t) / 1000)) };
  }
  {
    const sink = await new EncoderSink(`${TMP}/enc-only-webcodecs.mp4`, comp.canvas, W, H, F).open();
    const look = frameLook(W, H, info.w, info.h, 30, F); const t = performance.now();
    for (let i = 0; i < NF; i++) { comp.compose({ ...look, frame: i }); comp.present(); await sink.encodeCanvas(i); }
    await sink.end();
    res.compose_present_encode_webcodecs = { fps: r3(NF / ((performance.now() - t) / 1000)) };
  }
  // GPU-side time per stage from EXT_disjoint_timer_query_webgl2, where available.
  if (comp.timer) {
    const gl = comp.gl, ext = comp.timer;
    const gpuMs = async (fn) => {
      const out = [];
      for (let i = 0; i < 40; i++) {
        const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); fn(i); gl.endQuery(ext.TIME_ELAPSED_EXT);
        gpuSync(comp);
        while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) await yieldNow();
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) out.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q);
      }
      return M.summary(out.slice(5));
    };
    const src = await openSource('ffmpeg', file, info); const s = await src.frameAt(0); const data = s.data.slice(); src.close();
    const still = frameLook(W, H, info.w, info.h, 30, F), blur = frameLook(W, H, info.w, info.h, Math.round(1.85 * F), F);
    res.gpuMs = {
      uploadNV12_convert_mips: await gpuMs(() => comp.uploadNV12(data, info.w, info.h)),
      compose_still: await gpuMs((i) => comp.compose({ ...still, frame: i })),
      compose_zoom_blur10: await gpuMs((i) => comp.compose({ ...blur, frame: i })),
      pack_nv12: await gpuMs(() => comp.pack()),
    };
  }
  res.gpu = comp.renderer; res.timerQuery = !!comp.timer;
  return res;
}

// ---- parity: preview (<video>) vs export (ffmpeg NV12, WebCodecs) on bars and a card --
async function renderVia(kind, file, info, n, lookOpts, colour) {
  const comp = new Compositor(W, H); comp.chroma = args.chroma || 'center';
  if (colour) comp.setColour(...colour);
  let src, s, meta = null;
  if (kind === 'preview') {
    src = await new VideoElementSource(file).open();
    const r = await src.seek(n / F + (args.eps ? Number(args.eps) : 0)); meta = r.how;
    comp.uploadImage(src.v, src.w, src.h);
  } else {
    src = kind === 'webcodecs' ? await new WebCodecsSource(file, { fps: F }).open() : await openSource('ffmpeg', file, info);
    for (let i = 0; i <= n; i++) s = await src.frameAt(i);
    upload(comp, s);
  }
  comp.compose(frameLook(W, H, info.w, info.h, n, F, lookOpts));
  const img = comp.readRGBA();
  src.close(); comp.gl.getExtension('WEBGL_lose_context').loseContext();
  return { img, meta };
}
function savePng(img, name) {
  // Raw RGBA to PNG through ffmpeg, so frames can be looked at.
  const raw = `${TMP}/${name}.rgba`; fs.writeFileSync(raw, img);
  spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', raw, `${TMP}/${name}.png`]);
  fs.unlinkSync(raw);
}
async function decodeFile(file, n) {
  // A finished export decoded the way a player would (BT.709 limited), as RGBA.
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf',
    `select=eq(n\\,${n}),scale=in_color_matrix=bt709:in_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=rgba`,
    '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 64e6 });
  return new Uint8Array(r.stdout);
}
async function parity() {
  const res = {};
  const fx = (args.fixtures || 'bars709,barsraw,card').split(',');
  const n = 60;
  for (const name of fx) {
    const file = `${TMP}/${name}.mp4`; const info = probe(file); const r = { colourSpaceTag: info.cs };
    for (const [lk, lookOpts] of [['identity', { identity: true }], ['fullLook', {}]]) {
      const rect = lookOpts.identity ? [0, 0, W, H] : layout(W, H, info.w, info.h);
      const inner = [rect[0] + 8, rect[1] + 8, rect[2] - 16, rect[3] - 16];
      const pv = await renderVia('preview', file, info, n, lookOpts);
      const ff = await renderVia('ffmpeg', file, info, n, lookOpts);
      const wc = await renderVia('webcodecs', file, info, n, lookOpts);
      const out = { previewSeek: pv.meta };
      out.ffmpeg709_vs_preview = { dE: M.patchDeltaE(pv.img, ff.img, W, inner), lsb: M.lsbDiff(pv.img, ff.img, W, inner) };
      out.webcodecs_vs_preview = { dE: M.patchDeltaE(pv.img, wc.img, W, inner), lsb: M.lsbDiff(pv.img, wc.img, W, inner) };
      if (lk === 'identity' && name === 'barsraw') {
        const f6 = await renderVia('ffmpeg', file, info, n, lookOpts, ['bt601', 'tv']);
        out.ffmpeg601_vs_preview = { dE: M.patchDeltaE(pv.img, f6.img, W, inner), lsb: M.lsbDiff(pv.img, f6.img, W, inner) };
      }
      if (lk === 'fullLook') {
        savePng(pv.img, `parity-${name}-preview`); savePng(ff.img, `parity-${name}-ffmpeg`);
        out.wholeFrame_ffmpeg_vs_preview = M.lsbDiff(pv.img, ff.img, W, [0, 0, W, H]);
      }
      if (lk === 'identity' && name === 'bars709') out.samplePatches = out.ffmpeg709_vs_preview.dE.worst;
      r[lk] = out;
    }
    // Through the sinks: encode 90 frames of the full look from the ffmpeg path, decode
    // frame 60 of the file as a player would, compare with the pre-encode frame.
    if (name !== 'barsraw') {
      const comp = new Compositor(W, H); const src = await openSource('ffmpeg', file, info);
      const nv = new Nv12PipeSink(`${TMP}/parity-${name}-nv12.mp4`, W, H, F, { format: 'nv12' });
      const x264 = new Nv12PipeSink(`${TMP}/parity-${name}-x264.mp4`, W, H, F, { format: 'nv12', codec: 'x264' });
      const enc = await new EncoderSink(`${TMP}/parity-${name}-webcodecs.mp4`, comp.canvas, W, H, F).open();
      const rb = new Readback(comp, { packed: true, ring: 1 }); let pre = null;
      for (let i = 0; i < 90; i++) {
        const s = await src.frameAt(i); if (s.changed) upload(comp, s);
        comp.compose(frameLook(W, H, info.w, info.h, i, F));
        if (i === 60) pre = comp.readRGBA();
        comp.pack(); rb.issue(i); const b = nv.buffer(); await rb.collect(b, yieldNow);
        await nv.write(b); await x264.write(Buffer.from(b));
        comp.present(); await enc.encodeCanvas(i);
      }
      await nv.end(); await x264.end(); await enc.end(); src.close();
      const rect = layout(W, H, info.w, info.h); const inner = [rect[0] + 8, rect[1] + 8, rect[2] - 16, rect[3] - 16];
      r.sinks = {};
      for (const k of ['nv12', 'x264', 'webcodecs']) {
        const img = await decodeFile(`${TMP}/parity-${name}-${k}.mp4`, 60);
        if (img.length !== W * H * 4) { r.sinks[k] = { error: 'decode size ' + img.length }; continue; }
        r.sinks[k] = { dE: M.patchDeltaE(pre, img, W, inner), lsb: M.lsbDiff(pre, img, W, inner) };
      }
      // And the exported file read back by Chromium, i.e. what the person sees in a player.
      const pvOut = await renderVia('preview', `${TMP}/parity-${name}-nv12.mp4`, probe(`${TMP}/parity-${name}-nv12.mp4`), 60, { identity: true });
      r.sinks.nv12_viaChromium = { dE: M.patchDeltaE(pre, pvOut.img, W, inner) };
    }
    res[name] = r;
    log('parity ' + name + ' done');
  }
  return res;
}

// ---- vfr: burned counter, 200 random output times, preview vs both export decoders ---
function readCounter(img, rect, srcW) {
  // 16 blocks of 180 source px along the top 160 px strip; sample each block's centre.
  const k = rect[2] / srcW; let v = 0;
  for (let b = 0; b < 16; b++) {
    const x = Math.round(rect[0] + (180 * b + 90) * k), y = Math.round(rect[1] + 80 * k);
    const o = (y * W + x) * 4; if (img[o + 1] > 128) v |= 1 << b;
  }
  return v;
}
async function vfr() {
  // Fixture: vfr-counter (frames on the 60 fps grid, 30% dropped) or vfr-jitter (the same
  // frames moved off the grid, like ScreenCaptureKit timestamps). Kept frames stay in
  // order, so the i-th timestamp belongs to the i-th kept counter of the grid fixture.
  const name = args.fixture || 'vfr-counter';
  const file = `${TMP}/${name}.mp4`; const info = probe(file);
  const ptsOf = (f) => execFileSync(FFMPEG.replace('ffmpeg', 'ffprobe'), ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', f])
    .toString().trim().split('\n').map((l) => parseFloat(l)).sort((a, b) => a - b);
  const pts = ptsOf(file), counters = ptsOf(`${TMP}/vfr-counter.mp4`).map((p) => Math.round(p * 60));
  // Sample and hold: output frame n shows the latest source frame with pts <= n/F.
  const heldIndex = (t) => { let e = -1; for (let i = 0; i < pts.length; i++) if (pts[i] <= t + 1e-6) e = i; return e; };
  const expected = (n) => { const i = heldIndex(n / F); return i < 0 ? -1 : counters[i]; };
  let seed = Number(args.seed || 7);
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const maxN = Math.floor((info.dur - 0.2) * F);
  const ns = []; for (let i = 0; i < 200; i++) ns.push(Math.floor(rnd() * maxN));
  const rect = layout(W, H, info.w, info.h, { pad: 0 });
  const lookOpts = { identity: true, rect };
  const comp = new Compositor(W, H);
  const read = () => readCounter(comp.readRGBA(), rect, info.w);
  const res = { fixture: file, frames: ns.length, keptSourceFrames: pts.length, times: ns, expected: ns.map(expected), got: {}, how: {} };
  // Preview: random-order seeks, the way a person scrubs. Three ways to pick the seek time:
  // the output time itself, half an output frame later, and the middle of the source
  // frame the hold rule picks (from the container's own sample table).
  const seekTimes = {
    preview_exact: (n) => n / F,
    preview_midOutputFrame: (n) => (n + 0.5) / F,
    preview_midSourceFrame: (n) => { const i = Math.max(0, heldIndex(n / F)); return i + 1 < pts.length ? (pts[i] + pts[i + 1]) / 2 : pts[i] + 0.004; },
  };
  for (const [label, at] of Object.entries(seekTimes)) {
    const v = await new VideoElementSource(file).open(); const got = []; const how = {};
    for (const n of ns) {
      const r = await v.seek(at(n)); how[r.how] = (how[r.how] || 0) + 1;
      comp.uploadImage(v.v, v.w, v.h); comp.compose(frameLook(W, H, info.w, info.h, n, F, lookOpts));
      got.push(read());
    }
    v.close(); res.got[label] = got; res.how[label] = how;
  }
  // Export decoders: sequential, reading the requested output frames.
  const want = new Set(ns); const last = Math.max(...ns);
  const decoders = { export_webcodecs: () => new WebCodecsSource(file, { fps: F }).open() };
  for (const round of ['down', 'up', 'near']) decoders['export_ffmpeg_round_' + round] = () => openSource('ffmpeg', file, info, { round });
  for (const [label, open] of Object.entries(decoders)) {
    const src = await open(); const map = new Map();
    for (let n = 0; n <= last; n++) {
      const s = await src.frameAt(n);
      if (want.has(n)) { upload(comp, s); comp.compose(frameLook(W, H, info.w, info.h, n, F, lookOpts)); map.set(n, read()); }
    }
    src.close(); res.got[label] = ns.map((n) => map.get(n));
  }
  res.matchExpected = {};
  for (const [k, g] of Object.entries(res.got)) res.matchExpected[k] = g.reduce((m, v, i) => m + (v === res.expected[i] ? 1 : 0), 0) + '/' + ns.length;
  res.offByFrames = {};
  for (const [k, g] of Object.entries(res.got)) {
    const h = {}; g.forEach((v, i) => { if (v !== res.expected[i]) { const d = counters.indexOf(v) - counters.indexOf(res.expected[i]); h[d] = (h[d] || 0) + 1; } });
    res.offByFrames[k] = h;
  }
  return res;
}

// ---- throttle: timers, rAF, video clock and GL throughput in this window --------------
async function measureFor(ms, start) {
  let count = 0, stop = false; start(() => count++, () => stop);
  await new Promise((r) => setTimeout(r, ms)); stop = true; return r3(count / (ms / 1000));
}
async function throttle() {
  const res = { visibilityState: document.visibilityState, hidden: document.hidden };
  res.rafPerSec = await measureFor(2000, (tick, stop) => { const f = () => { if (stop()) return; tick(); requestAnimationFrame(f); }; requestAnimationFrame(f); });
  res.setTimeout0PerSec = await measureFor(2000, (tick, stop) => { const f = () => { if (stop()) return; tick(); setTimeout(f, 0); }; setTimeout(f, 0); });
  res.setInterval16PerSec = await measureFor(2000, (tick, stop) => { const id = setInterval(() => { if (stop()) clearInterval(id); else tick(); }, 16); });
  res.messageChannelPerSec = await measureFor(1000, (tick, stop) => { (async () => { while (!stop()) { tick(); await yieldNow(); } })(); });
  const v = await new VideoElementSource(`${TMP}/vfr-counter.mp4`, { opacity0: false }).open();
  await v.v.play().catch((e) => { res.playError = String(e); });
  const t0 = v.v.currentTime, w0 = performance.now();
  res.rvfcPerSecPlaying = await measureFor(2000, (tick, stop) => { const f = () => { if (stop()) return; tick(); v.v.requestVideoFrameCallback(f); }; v.v.requestVideoFrameCallback(f); });
  res.videoClockRate = r3((v.v.currentTime - t0) / ((performance.now() - w0) / 1000)); v.v.pause(); v.close();
  // GL work driven by MessageChannel, not rAF: the export loop's real scheduling.
  const comp = new Compositor(W, H); const rb = new Readback(comp, { packed: true }); const dst = new Uint8Array(rb.bytes);
  const look = frameLook(W, H, 2880, 1800, 30, F); comp.ensureContent(64, 64); comp.contentTex = comp.content;
  const t = performance.now(); let n = 0;
  while (performance.now() - t < 2000) { comp.compose({ ...look, frame: n }); comp.pack(); rb.issue(n); if (rb.full) await rb.collect(dst, yieldNow); n++; }
  res.glComposePackReadbackFps = r3(n / ((performance.now() - t) / 1000));
  return res;
}

// ---- rvfc: does requestVideoFrameCallback fire on an opacity 0 video? ----------------
async function rvfc() {
  const res = { visibilityState: document.visibilityState, windowShown: new URLSearchParams(location.search).get('visible') === '1' };
  for (const op0 of [true, false]) {
    const v = await new VideoElementSource(`${TMP}/bars709.mp4`, { opacity0: op0 }).open();
    const k = op0 ? 'opacity0' : 'opacity1';
    v.v.loop = true; await v.v.play().catch((e) => { res[k + '_playError'] = String(e); });
    const playing = await measureFor(2000, (tick, stop) => { const f = () => { if (stop()) return; tick(); v.v.requestVideoFrameCallback(f); }; v.v.requestVideoFrameCallback(f); });
    v.v.pause();
    let ok = 0; const hows = {};
    for (let i = 0; i < 20; i++) { const r = await v.seek(0.1 + i * 0.07, { timeout: 1000 }); hows[r.how] = (hows[r.how] || 0) + 1; if (r.how === 'rvfc') ok++; }
    res[k] = { rvfcPerSecPlaying: playing, pausedSeeksWithRvfc: ok + '/20', hows };
    v.close();
  }
  return res;
}

// ---- packcheck: is the NV12 pack pass itself exact? Unpack in JS and compare. ---------
function unpackNV12(nv, W, H) {
  const out = new Uint8Array(W * H * 4); const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const Y = (nv[y * W + x] - 16) / 219, o = W * H + (y >> 1) * W + (x >> 1) * 2;
    const U = (nv[o] - 128) / 224, V = (nv[o + 1] - 128) / 224, i = (y * W + x) * 4;
    out[i] = c(255 * (Y + 1.5748 * V)); out[i + 1] = c(255 * (Y - 0.187324 * U - 0.468124 * V)); out[i + 2] = c(255 * (Y + 1.8556 * U)); out[i + 3] = 255;
  }
  return out;
}
async function packcheck() {
  const res = {};
  for (const name of ['bars709', 'card']) {
    const file = `${TMP}/${name}.mp4`; const info = probe(file);
    const comp = new Compositor(W, H); const src = await openSource('ffmpeg', file, info);
    let s; for (let i = 0; i <= 60; i++) s = await src.frameAt(i); upload(comp, s); src.close();
    for (const [lk, lo] of [['identity', { identity: true }], ['fullLook', {}]]) {
      comp.compose(frameLook(W, H, info.w, info.h, 60, F, lo));
      const pre = comp.readRGBA(); comp.pack();
      const gl = comp.gl; const nv = new Uint8Array(W * H * 1.5);
      gl.bindFramebuffer(gl.FRAMEBUFFER, comp.packed.fbo); gl.readPixels(0, 0, W >> 2, H * 1.5, gl.RGBA, gl.UNSIGNED_BYTE, nv);
      const back = unpackNV12(nv, W, H);
      // The on-screen canvas: present, read the default framebuffer, flip, compare.
      comp.present(); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const cv = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      let canvasMax = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W * 4; x++) canvasMax = Math.max(canvasMax, Math.abs(cv[(H - 1 - y) * W * 4 + x] - pre[y * W * 4 + x]));
      const rect = lo.identity ? [8, 8, W - 16, H - 16] : layout(W, H, info.w, info.h).map((v, i) => v + (i < 2 ? 8 : -16));
      res[name + '_' + lk] = { canvasVsOutMaxLSB: canvasMax, dE: M.patchDeltaE(pre, back, W, rect), lsb: M.lsbDiff(pre, back, W, rect), y0: [...nv.slice(0, 8)], uv0: [...nv.slice(W * H, W * H + 8)], rgb0: [...pre.slice(0, 8)] };
    }
  }
  return res;
}

(async () => {
  const mode = args.mode || 'bench';
  try {
    const fn = { bench, stages, parity, vfr, throttle, rvfc, packcheck }[mode];
    const r = await fn();
    ipcRenderer.send('done', r);
  } catch (e) {
    ipcRenderer.send('done', { error: String(e && e.stack || e) });
  }
})();
