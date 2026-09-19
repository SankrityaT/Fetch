# M0 spike: WebGL2 compositor gate

**Verdict: the gate passes.** Every exit criterion was measured on this Mac (Apple M5 Pro,
ANGLE Metal, Electron 33.2, ffmpeg 8.1) and met, with margin. Seven findings change the
plan's details, listed under "What M2 must do differently". Numbers below come from the
JSON files the harness writes to `/tmp/fetch-spike/`; the machine was shared with other
agents while measuring, so throughput varies by roughly 10% run to run.

## Sources used

| Take | Size | Frame rate | Colour tag |
|---|---|---|---|
| Songscription Library 3 (`~/Movies/Fetch/Songscription Library 3/Original/…mov`) | 2884x1780, 46.9 s, 1234 frames | VFR, 26.3 avg, 197 gaps over 20 ms | none |
| Retina take (`~/Desktop/recording-1789696464142.mov`) | 3024x1964, 49.0 s, 2745 frames | VFR, 56.0 avg (17 ms cadence) | none |
| `vfr-counter.mp4` (synthetic, `fixtures.sh`) | 2880x1800, 12 s | 60 fps grid, 30% of frames dropped in irregular runs, source index burned in as 16 binary blocks plus a number | BT.709 |
| `vfr-jitter.mp4` (synthetic) | same frames | the same kept frames moved off the 60 fps grid, like ScreenCaptureKit timestamps | BT.709 |
| `bars709.mp4`, `barsraw.mp4`, `card.mp4` | 1920x1080 | SMPTE HD bars tagged and untagged, testsrc2 card | as named |

## Pass set rendered

Cached warm two-light gradient background, analytic rounded-box shadow (closed form, no
blur pass), SDF rounded mask with 1 px AA and a hairline edge, zoom to 1.8x on a moving
target every 6 s with analytic motion blur (10 taps across a 180 degree shutter, 1 tap when
still), bloom (bright pass, two downsamples, separable blur), film grain and triangular
dither seeded by frame index. Content is mip-mapped every frame and sampled with explicit
LOD, so a Retina take scaled into 1080 does not alias. Frames looked at: still, mid-glide
and 1.8x hold on both takes render correctly; the 1.8x hold on the Retina take is sharp.

## Exit criterion 1: 1080p60 at least real time, per stage

Whole takes, 1920x1080 at 60 fps out, audio graph (highpass, afftdn, loudnorm, fade, AAC)
running concurrently, final stream-copy mux included in the wall time.

Per-frame stage times are CPU-side mean / p95 in ms (Electron's `performance.now()` has
0.1 ms resolution, so sub-0.1 values are averages of mostly-zero samples). "sink" is time
blocked on the encoder, which is the bottleneck in every row.

| Take | Decoder | Sink | Frames | Uploads | src wait | upload | compose | readback issue | fence wait | copy | sink | loop fps | wall fps | **Real time** | audio / mux ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Songscription | ffmpeg | NV12 pipe, VideoToolbox | 2816 | 2816 | 0.11 / 0.10 | 0.24 / 0.30 | 0.02 / 0.10 | 0.01 / 0.10 | 0.04 / 0.00 | 0.06 / 0.10 | 4.89 / 7.80 | 183 | 180 | **3.00x** | 1122 / 256 |
| Songscription | ffmpeg | WebCodecs encoder | 2816 | 2816 | 0.09 / 0.10 | 0.20 / 0.30 | 0.01 / 0.10 | | | | 3.67 / 5.80 | 250 | 245 | **4.09x** | 1184 / 125 |
| Songscription | WebCodecs | NV12 pipe, VideoToolbox | 2816 | 1223 | 0.03 / 0.10 | 0.06 / 0.20 | 0.02 / 0.10 | 0.01 / 0.10 | 0.03 / 0.00 | 0.07 / 0.20 | 4.10 / 4.90 | 230 | 227 | **3.79x** | 1089 / 146 |
| Songscription | WebCodecs | WebCodecs encoder | 2816 | 1223 | 0.05 / 0.10 | 0.05 / 0.20 | 0.03 / 0.10 | | | | 3.52 / 7.00 | 271 | 264 | **4.41x** | 1282 / 139 |
| Retina | ffmpeg | NV12 pipe, VideoToolbox | 2938 | 2938 | 0.11 / 0.10 | 0.25 / 0.30 | 0.02 / 0.10 | 0.01 / 0.10 | 0.01 / 0.00 | 0.07 / 0.20 | 4.62 / 5.70 | 196 | 194 | **3.24x** | 1935 / 107 |
| Retina | ffmpeg | WebCodecs encoder | 2938 | 2938 | 0.61 / 4.50 | 0.30 / 0.40 | 0.02 / 0.10 | | | | 2.88 / 5.00 | 260 | 255 | **4.25x** | 2198 / 145 |
| Retina | WebCodecs | NV12 pipe, VideoToolbox | 2938 | 2735 | 0.06 / 0.10 | 0.14 / 0.20 | 0.03 / 0.10 | 0.01 / 0.10 | 0.01 / 0.00 | 0.08 / 0.20 | 6.16 / 9.20 | 153 | 152 | **2.53x** | 1890 / 168 |
| Retina | WebCodecs | WebCodecs encoder | 2938 | 2735 | 0.06 / 0.10 | 0.13 / 0.20 | 0.03 / 0.10 | | | | 3.47 / 6.20 | 267 | 259 | **4.32x** | 2184 / 178 |
| Songscription | ffmpeg | NV12 pipe, x264 CRF 18 ("best") | 2816 | 2816 | 0.10 | 0.18 | 0.02 | 0.01 | 0.01 | 0.07 | 6.64 / 8.20 | 141 | 140 | **2.34x** | 1232 / 69 |
| Songscription | ffmpeg | RGBA readback, swscale to YUV | 2816 | 2816 | 0.10 | 0.21 | 0.02 | 0.01 | 0.01 | 0.17 | 10.89 / 12.60 | 88 | 87 | 1.45x | 1085 / 99 |
| Retina | ffmpeg | RGBA readback, swscale to YUV | 2938 | 2938 | 0.09 | 0.27 | 0.02 | 0.01 | 0.03 | 0.20 | 11.22 / 14.30 | 84 | 84 | 1.40x | 1728 / 206 |

Outputs verified with ffprobe: 1920x1080, 60/1, H.264 plus AAC, 2816 frames for the
46.9 s Songscription take.

Each stage alone (`--mode=stages`, 600 frames, fps; GPU ms from `EXT_disjoint_timer_query_webgl2`):

| Stage | Songscription | Retina |
|---|---|---|
| Decode: ffmpeg NV12, **stdout pipe, compositor thread** | 76 fps (940 reads of 8 KB per frame) | 69 fps |
| Decode: ffmpeg NV12, stdout pipe, Web Worker | 80 fps | 70 fps |
| Decode: ffmpeg NV12, **loopback TCP, Web Worker** | **631 fps** (118 reads per frame) | **316 fps** |
| Decode: ffmpeg + `scale_vt` to 1.8x-zoom size | 370 fps (2710x1672) | 287 fps (2574x1672) |
| Decode: WebCodecs over mp4box.js (held frames) | 4147 fps | 920 fps |
| Upload NV12 + convert + mips | 1328 fps, GPU 0.81 ms | 1166 fps, GPU 1.00 ms |
| Upload VideoFrame + mips | 675 fps | 600 fps |
| Compose, still (1 tap) | 5263 fps, GPU 0.76 ms | 5357 fps, GPU 0.89 ms |
| Compose, mid-zoom with 10-tap motion blur | 3876 fps, GPU 0.51 ms | 3995 fps, GPU 0.96 ms |
| Pack NV12 | GPU 0.036 ms | GPU 0.048 ms |
| Readback NV12 packed, PBO ring of 3 | 3138 fps (3.1 MB, copy 0.057 ms) | 3247 fps |
| Readback RGBA, PBO ring of 3 | 3240 fps (8.3 MB, copy 0.19 ms) | 3254 fps |
| Readback NV12, synchronous readPixels | 111 fps | 73 fps |
| Encode: ffmpeg `h264_videotoolbox` from NV12 | 243 fps | 229 fps |
| Encode: ffmpeg `h264_videotoolbox` from RGBA (swscale) | 95 fps | 93 fps |
| Compose + present + WebCodecs VideoEncoder | 268 fps | 263 fps |

The GPU work for a full frame is about 1 to 2 ms; the pipeline is encoder-bound.

## Exit criterion 2: preview matches export

"Preview" is the editor path: a `<video>` (opacity 0) seeked and taken with
`requestVideoFrameCallback`, uploaded, run through the same compositor. "Export" is the
ffmpeg NV12 source, or the WebCodecs source, through the same compositor. Compared before
encode; dE is CIEDE2000 on flat 13x13 patches (sRGB, D65); LSB is per-channel 8-bit steps
over the whole content area.

| Fixture | Look | ffmpeg vs preview: dE max, LSB max | WebCodecs vs preview | Gate |
|---|---|---|---|---|
| Colour bars, BT.709 tagged | identity | **dE 0.000**, 0 LSB (509 patches) | dE 0, 0 LSB | dE < 1: pass |
| Colour bars, BT.709 tagged | full look | dE 0.000, 0 LSB | dE 0, 0 LSB | pass |
| Colour bars, bt470bg tagged | identity | dE 0.000, 0 LSB | dE 0, 0 LSB | pass |
| Test card (testsrc2) | identity | dE 0.000, **max 1 LSB**, 0% of samples over 2 | 0 LSB | < 2 LSB: pass |
| Test card | full look | dE 0.000, max 1 LSB | 0 LSB | pass |
| Songscription frame | identity and full look | dE 0.000, max 1 LSB | 0 LSB | pass |
| Retina frame | identity and full look | dE 0.000, max 1 LSB | 0 LSB | pass |

The on-screen canvas (present pass, flipped) equals the output frame exactly (0 LSB).

After encode, decoded the way a player would, against the pre-encode frame: colour bars
dE max 0.37 (VideoToolbox), 0.57 (x264), 0.58 (WebCodecs encoder), 0.36 read back by
Chromium; test card 0.47 / 0.37 / 0.58 / 0.43; Songscription 0.38 / 0.47 / 0.32 / 0.40;
Retina frame 0.72 / 1.11 / 1.11 / 1.03 (fine detail, codec loss). The NV12 pack pass on
its own, unpacked in JS, is dE max 0.43 (the rest is 4:2:0 at edges).

## Exit criterion 3: same source frame for 200 random times

200 random output frames (seeded), preview seeks in random order, both export decoders
sequential; the burned counter read from the composited output.

| Method | Grid fixture | Off-grid (jittered) fixture |
|---|---|---|
| WebCodecs, hold latest frame with pts <= n/F | 200/200 | 200/200 |
| ffmpeg `fps=60:round=up` | 200/200 | **200/200** |
| ffmpeg `fps=60:round=down` (the plan's choice) | 200/200 | **67/200** (133 show the next frame early) |
| ffmpeg `fps=60:round=near` | 200/200 | 124/200 |
| Preview, seek to n/F exactly | **132/200** (68 show the previous frame) | 198/200 |
| Preview, seek to (n + 0.5)/F | 200/200 | 124/200 |
| **Preview, seek to the middle of the source frame the hold rule picks** (from the container's sample table) | **200/200** | **200/200** |

rVFC fired for all 1200 preview seeks and its `mediaTime` agreed with the pixels every time.

## Exit criterion 4: hidden window not throttled

`show: false` window, 2 s windows per measure:

| Window | visibility | rAF/s | setTimeout(0)/s | setInterval(16)/s | MessageChannel/s | rVFC/s playing | GL compose+pack+readback fps |
|---|---|---|---|---|---|---|---|
| `paintWhenInitiallyHidden: true` (Electron default), throttling off | visible | 120 | 205 | 62.5 | 593k | 42 (source rate) | 3005 |
| same, `backgroundThrottling: true` | visible | 120 | 205 | 62.5 | 602k | 41 | 3168 |
| `paintWhenInitiallyHidden: false`, throttling off | **hidden** | **0** | 207 | 62.5 | 593k | **0** | 2914 |
| `paintWhenInitiallyHidden: false`, throttling on | hidden | 0 | **3** | **1** | 1.16M | 0 | 3140 |

Pass, with a rule: the render window keeps `paintWhenInitiallyHidden` true and
`backgroundThrottling` false, and the export loop yields with MessageChannel, never rAF,
rVFC or timers. GL and MessageChannel ran at full speed in every configuration.

## Exit criterion 5: rVFC on an opacity-0 video

| Window | opacity 0 video: rVFC/s playing, paused seeks answered | opacity 1 video |
|---|---|---|
| Shown (inactive, zero window opacity, not focusable) | 60.5/s, 20/20 | 60.5/s, 20/20 |
| Hidden, painted | 60.5/s, 20/20 | 60/s, 20/20 |
| Hidden, never painted | 0/s, 0/20 | 0/s, 0/20 |

Pass: CSS opacity 0 does not stop rVFC. A never-painted window does, for any opacity.

## Decisions

- **Decoder for M2: ffmpeg NV12**, read over loopback TCP in a Web Worker
  (`nodeIntegrationInWorker`), with `fps=F:round=up`, `-hwaccel videotoolbox`, and
  `scale_vt` for decode-size scaling. It takes every container and codec ffmpeg does and
  keeps the cut graph and crop in ffmpeg. 316 to 631 fps at Retina size, 1 LSB from the
  preview. **WebCodecs over mp4box.js is the M6 upgrade** for native .mov/.mp4 takes: it is
  bit-identical to the preview (same Chromium decoder), uploads only changed frames
  (1223 instead of 2816 on Songscription) and was faster end to end, but it needs its own
  seeking for cuts and cannot read WebM, MKV or ProRes.
- **Sink: packed NV12 through a PBO ring into ffmpeg stdin**, `h264_videotoolbox` by
  default (3.0 to 3.2x real time), x264 for "best" (2.3x), VP9 and GIF from the same raw
  input. The WebCodecs VideoEncoder was 1.3x faster but is H.264 only and adds mp4-muxer;
  not worth a second path now. Keep the readback asynchronous: a synchronous readPixels
  drops to 73 to 111 fps.
- **Pack layout: one RGBA8 target of W/4 x 1.5H** holding exact NV12 bytes (Y rows, then
  interleaved UV rows), BT.709 limited range, chroma as the 2x2 box mean. 3.1 MB per 1080p
  frame. RGBA readback plus swscale is capped at about 1.4x real time by swscale.

## What M2 must do differently from the plan

1. **`fps=F:round=up`, not `round=down`.** Sample-and-hold (frame n shows the latest source
   frame with pts <= n/F) is `round=up`; `round=down` shows off-grid frames a slot early
   (67/200). It also caused a 3 LSB preview mismatch on the real Songscription take until
   switched.
2. **Never read a large ffmpeg pipe on stdout in Electron.** Both the renderer and a Web
   Worker get 8 KB reads (940 per Retina frame) and top out near 70 to 80 fps. Loopback TCP
   gives 64 KB reads and 316 to 631 fps.
3. **Preview seeks to the middle of the chosen source frame**, looked up in the take's sample
   table (mp4box `cts` plus the edit list). Seeking to n/F shows the previous frame on
   grid-aligned sources (microsecond truncation), seeking to mid output frame shows the next
   frame on off-grid ones.
4. **Tag rawvideo input as BT.709 on the input side** (`-colorspace bt709 -color_range tv`
   before `-i`). With the tags only on the output, ffmpeg 8 treats the input as another
   matrix and converts it: pure red came back 232/0/1 instead of 255/1/1, dE 5.
5. **Chroma is centre-sited bilinear** in the NV12 shader, matching Chromium to 1 LSB;
   left-siting was up to 119 LSB off at edges. Chromium decoded the bt470bg-tagged bars
   with BT.709 coefficients (BT.601 would be dE 8.4 off), so the source pass uses 709 for
   untagged and 601-tagged takes alike, to match the preview.
6. **mp4box.js gotchas**: require `mp4box/dist/mp4box.all.cjs` by path (its `main` points at a
   missing file and `exports` hides the rest), arm extraction inside `onReady`, and apply
   the edit list (x264 B-frame files start at cts = 2 frames).
7. **Motion blur taps should scale with pixel travel.** Ten fixed taps show discrete ghost
   copies of text on a fast glide; compose has about 60x headroom, so 24 to 32 taps on fast
   frames costs nothing that matters.

## Not verified here

- The product's own cut graph, crop and `processor.js` audio graph (a representative audio
  graph ran instead); the real editor window (tested in spike windows with the same
  settings); exports longer than 50 s, thermals, and takes too large to hold in memory for
  mp4box (it reads the whole file).
- Colour on a physical display (only framebuffer values were compared).

## Reproduce

```
bash tools/spike-compositor/fixtures.sh          # bars, card, both VFR counters
(cd tools/spike-compositor && npm install)        # mp4box, mp4-muxer
node tools/spike-compositor/test.js               # pure metric and look checks
npx electron tools/spike-compositor --mode=bench --src=<take> --decoder=ffmpeg|webcodecs --sink=nv12|encoder|rgba [--codec=x264]
npx electron tools/spike-compositor --mode=stages --src=<take>
npx electron tools/spike-compositor --mode=parity [--fixtures=bars709,barsraw,card]
npx electron tools/spike-compositor --mode=vfr --fixture=vfr-counter|vfr-jitter
npx electron tools/spike-compositor --mode=throttle [--pwih=0] [--throttle=1]
npx electron tools/spike-compositor --mode=rvfc [--visible=1] [--pwih=0]
npx electron tools/spike-compositor --mode=packcheck
```

`vfr-jitter.mp4` is made from `vfr-counter.mp4` with
`setpts='PTS+(mod(N*37,13)/13)*0.9/(60*TB)'`, `-fps_mode passthrough -enc_time_base:v 1/60000`.
Every mode writes JSON to `/tmp/fetch-spike/` and exits; the window is never shown or focused
except `--visible=1`, which shows it inactive at zero opacity.
