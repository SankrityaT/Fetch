# The compositor's passes

One frame of an edit, in the order `gl.js` draws it. Every pass is a function of the
plan (`plan.prepare`), the frame's own plan (`plan.framePlan`) and the source pixels
for that frame; nothing reads the previous frame, so any frame can be drawn alone and
the editor's stage and the export draw the same pixels.

Geometry is in export pixels (`layout.js`, the one geometry every renderer uses) and
scaled to whatever the compositor draws at: the export's size, or the stage's.

| # | Pass | Target | Per frame | Notes |
|---|---|---|---|---|
| 1 | source | `content` (RGBA, mipmapped) | when the frame changed | NV12 from ffmpeg (export) or the `<video>` (stage). BT.709 limited, chroma centre-sited; BT.601 under 720 lines, as Chromium does. Mips so a Retina take minified into 1080 does not alias. |
| 2 | camera source | `cam` (RGBA, mipmapped) | when the camera frame changed | Its centre square at its own size, so both paths sample it on the GPU. |
| 3 | still background | `bg` | once per plan and size | Gradient corner to corner in sRGB (a solid is a flat gradient); an image covered, dimmed, blurred at a quarter size. |
| 4 | blur ground | `fillA` (tiny) | yes | The cropped frame shrunk to 1/64, Gaussian blurred (the classic 125 px at 1080 for blurAmount 0.5). Pressed in the frame pass. |
| 5 | frame | `scene` | yes | Background (or the blur ground: luma 30%, chroma 80%, cos^4 vignette, still grain), the analytic rounded-box shadow, the take inside an SDF rounded mask with a 1 px edge, zoomed (`Overlays.zoomView`) with the window margin trimmed and covered, motion blur as samples across the shutter scaled with pixel travel (up to 32), a border, the camera bubble with its shadow and ring. |
| 6 | final | `out` | yes | Fade to and from black over the whole frame, one-step triangular dither seeded by frame. |
| 7a | present | the canvas | stage, and the WebCodecs sink | Flipped. |
| 7b | pack | `packed` (RGBA8, ceil(W/4) x 1.5H) | export | Exact NV12 bytes, BT.709 limited, chroma as the 2x2 mean, read back through a ring of three pixel-pack buffers. |

Sources and sinks (M0 decided, M2 measured):

- Decode: ffmpeg, VideoToolbox, over loopback TCP in a Web Worker (a pipe reads 8 KB at a
  time in Electron). Only the runs of frames the plan shows are decoded (`select` on the
  container's own timestamps with `-copyts`); sample and hold is `plan.frameMap`.
  `scale_vt` shrinks a take far larger than the deepest zoom needs before the download.
- Encode: x264 veryfast at the classic export's CRF, fed packed NV12 over loopback TCP (a
  pipe from the renderer took 144 fps, a socket 740). On the Songscription tour at 1080p60
  it wrote 5.9 MB where VideoToolbox and WebCodecs wrote 71 to 73 MB at the bitrate that
  keeps text sharp; those two stay as `sink: 'vt'` and `sink: 'webcodecs'` for measuring.
- Sound: ffmpeg in the main process at the same time (`processor.renderAudio`), then a
  stream-copy mux and the music bed.
