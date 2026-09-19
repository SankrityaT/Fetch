# The compositor's passes

One frame of an edit, in the order `gl.js` draws it. Every pass is a function of the
plan (`plan.prepare`), the frame's own plan (`plan.framePlan`) and the source pixels
for that frame; nothing reads the previous frame, so any frame can be drawn alone and
the editor's stage and the export draw the same pixels.

Geometry is in export pixels (`layout.js`, the one geometry every renderer uses) and
scaled to whatever the compositor draws at: the export's size, or the stage's. What is
drawn on the recording itself is in content pixels (the cropped take at its own size),
scaled to the texture it is drawn into.

| # | Pass | Target | Per frame | Notes |
|---|---|---|---|---|
| 1 | source | `content` (RGBA, mipmapped) | when the frame changed | NV12 from ffmpeg (export) or the `<video>` (stage). BT.709 limited, chroma centre-sited; BT.601 under 720 lines, as Chromium does. Mips so a Retina take minified into 1080 does not alias. |
| 2 | camera source | `cam` (RGBA, mipmapped) | when the camera frame changed | Its centre square at its own size, so both paths sample it on the GPU. |
| 3 | still background | `bg` | once per plan and size | Gradient corner to corner in sRGB (a solid is a flat gradient); an image covered, dimmed, blurred at a quarter size. |
| 4 | blur ground | `fillA` (tiny) | yes | The cropped frame shrunk to 1/64, Gaussian blurred (the classic 125 px at 1080 for blurAmount 0.5). Pressed in the frame pass. |
| 5 | clean | `contA` (the crop's size, mipmapped) | while anything is drawn on the take | The crop copied out; the Mac's pointer filled from its box's edges (delogo's weighting); redactions as cells, each the mean of what it covers (16 finished px or a third of the box's short side, whichever is larger). Clean patches of a resting pointer (`prepare.js`) laid over as pictures. |
| 6 | blur marks | `contA` | while one shows | The box and its margin shrunk from a mip level, blurred, and laid back through a feathered round-cornered mask at the mark's opacity. |
| 7 | focus | `contB` | while a lift or spotlight shows | Spotlight: a feathered window at full light in a dimmed, lightly blurred page. Lift: the element's own pixels scaled 3 to 6 percent about its centre (and moved in from a frame edge), cut with its own corner radius, over a wide key shadow and a tight contact shadow (analytic), the page behind blurred and dimmed by multiplication, less by the piece and more with distance. Up to four at once. |
| 8 | steps and cursor | the content target | while they show | Canvas2D pictures drawn once per size (`pic`): step badges popping in, riding a lifted card; the agent's arrow pressing on clicks, its gold ripple, the Biscuit tag and badge. Mipmapped after, so a zoom samples them like the take. |
| 9 | frame | `scene` (mipmapped) | yes | Background (or the blur ground: luma 30%, chroma 80%, cos^4 vignette, still grain), the analytic rounded-box shadow, the take (or the content target) inside an SDF rounded mask with a 1 px edge, zoomed (`Overlays.zoomView`, lifts re-framing the zooms they ride) with the window margin trimmed and covered, motion blur as samples across the shutter scaled with pixel travel (up to 32), a border, the camera bubble. Under an opening title card the take waits, then rises into place; under a closing one it settles back (`text.frameMove`). |
| 10 | card ground | `scene` | while a title card shows | An opening card's near-black scrim; a closing card's frame blurred about 130 px at 1080 and half desaturated under the scrim. |
| 11 | caption glass | `scene` | while a framed caption over the take shows | The frame blurred at a quarter size, through a feathered rounded patch under the words. |
| 12 | text | `scene` | while text shows | Captions (their shade, a pill under the spoken word, the words with the spoken one re-tinted), titles rising out of a blur (a crossfade to a blurred copy), lower thirds, labels. Laid out by `text.js` with `overlays.js`, rasterised with Canvas2D once per item and size. |
| 13 | final | `out` | yes | Fade to and from black over the whole frame, one-step triangular dither seeded by frame. |
| 14a | present | the canvas | stage, and the WebCodecs sink | Flipped. |
| 14b | pack | `packed` (RGBA8, ceil(W/4) x 1.5H) | export | Exact NV12 bytes, BT.709 limited, chroma as the 2x2 mean, read back through a ring of three pixel-pack buffers. |

What only the take's pixels can say (a lift's element on screen and its box and corner,
a step's card corner, the Mac's pointer and its clean patches, the cursor's rests off
the words, when the product put a toast where the captions sit) is worked out once in
the main process by `prepare.js`, cached, and shared by the editor's stage and the
export; frames are then drawn from the plan alone.

Sources and sinks (M0 decided, M2 measured):

- Decode: ffmpeg, VideoToolbox, over loopback TCP in a Web Worker (a pipe reads 8 KB at a
  time in Electron). Only the runs of frames the plan shows are decoded (`select` on the
  container's own timestamps with `-copyts`); sample and hold is `plan.frameMap`.
  `scale_vt` shrinks a take far larger than the deepest zoom needs before the download.
  A still (preview_frame) decodes its one frame and stops (`-frames:v 1`).
- Encode: x264 veryfast at the classic export's CRF, fed packed NV12 over loopback TCP (a
  pipe from the renderer took 144 fps, a socket 740). On the Songscription tour at 1080p60
  it wrote 5.9 MB where VideoToolbox and WebCodecs wrote 71 to 73 MB at the bitrate that
  keeps text sharp; those two stay as `sink: 'vt'` and `sink: 'webcodecs'` for measuring.
- Sound: ffmpeg in the main process at the same time (`processor.renderAudio`), then a
  stream-copy mux and the music bed.
