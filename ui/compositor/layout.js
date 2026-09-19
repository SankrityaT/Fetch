// Where the take sits in the output: the output's size, the framed take's rectangle,
// its corners and its shadow, in output pixels.
//
// This is the one geometry for every renderer. The classic ffmpeg export, the editor's
// stage and the compositor all read it, so a framed take lands on the same pixel in
// the preview and in the file. It began as backdropGeometry in ui/overlays.js, which
// now forwards here.
//
// Pure: no Electron, no filesystem, no DOM.

const even = n => 2 * Math.round(n / 2)

/**
 * Where a framed video sits on its backdrop: the canvas, the video's size and offset,
 * its corner radius and shadow blur, in pixels.
 *   inset     padding, a share of the frame (0.02 to 0.22)
 *   radius    corner radius in output pixels, default 3.5% of the short side
 *   outAspect w/h when a shape was chosen, else the take's own shape plus padding
 *   outWidth  the long edge for a chosen shape (1920, or 1280 at 720p)
 *   band      a share of the height kept below the video for captions
 */
function backdropGeometry(srcW, srcH, opts = {}) {
  const inset = Math.min(0.22, Math.max(0.02, opts.inset ?? 0.08))

  // "Auto" keeps the source shape and adds the same margin on every side. Forcing
  // a 16:9 canvas around a 16:10 recording gives fat side margins and thin top and
  // bottom ones, which reads as the video being anchored rather than centred.
  let outW, outH
  const target = opts.outAspect   // number (w/h) when the user picks a shape
  if (!target) {
    const pad = inset * Math.max(srcW, srcH)
    outW = even(srcW + pad * 2)
    outH = even(srcH + pad * 2)
    // keep the canvas sane for encoding
    const cap = opts.scale === 720 ? 1280 : 1920
    if (outW > cap) {
      const k = cap / outW
      outW = even(outW * k)
      outH = even(outH * k)
    }
  } else {
    // outWidth is the long edge: a portrait shape 1920 wide came out 3414 tall
    const long = opts.outWidth || 1920
    outW = even(target >= 1 ? long : long * target)
    outH = even(target >= 1 ? long / target : long)
  }

  // band: a share of the height kept below the video for captions, in place of the
  // bottom margin, so they sit on the backdrop rather than on the product
  const band = Math.max(0, Math.min(0.25, +opts.band || 0))
  const bottom = band ? Math.max(band, inset) : inset
  const boxW = even(outW * (1 - inset * 2))
  const boxH = even(outH * (1 - inset - bottom))
  const scale = Math.min(boxW / srcW, boxH / srcH)
  const vidW = even(srcW * scale)
  const vidH = even(srcH * scale)
  const radius = Math.max(6, Math.round(opts.radius ?? Math.min(vidW, vidH) * 0.035))
  const ox = Math.round((outW - vidW) / 2)
  // with a band the video hangs from the top margin; the band takes what is left
  const oy = band ? Math.round(outH * inset + (boxH - vidH) / 2) : Math.round((outH - vidH) / 2)
  const blur = Math.max(4, Math.round(vidH * 0.035))
  return { outW, outH, vidW, vidH, radius, ox, oy, blur }
}

/**
 * A take with no background. Its own shape: the cropped frame, at its own size or
 * scaled to 1080 or 720 tall. A chosen shape: the take fitted inside it edge to edge,
 * the room it leaves filled with the take blurred (never black bars), the long edge
 * 1920 (1280 at 720p). Same numbers as the classic export's unframed paths.
 */
function plainGeometry(srcW, srcH, opts = {}) {
  const ar = +opts.outAspect || 0
  if (!ar) {
    const tall = opts.scale === 1080 || opts.scale === 720 ? opts.scale : srcH
    // ffmpeg's scale=-2:H keeps the width even
    const w = tall === srcH ? srcW : even(srcW * tall / srcH)
    return { outW: w, outH: tall, vidW: w, vidH: tall, ox: 0, oy: 0, radius: 0, blur: 0 }
  }
  const long = opts.scale === 720 ? 1280 : 1920
  const outW = even(ar >= 1 ? long : long * ar)
  const outH = even(ar >= 1 ? long / ar : long)
  // force_original_aspect_ratio=decrease, then centred
  const k = Math.min(outW / srcW, outH / srcH)
  const vidW = Math.min(outW, even(srcW * k)), vidH = Math.min(outH, even(srcH * k))
  return { outW, outH, vidW, vidH, ox: Math.floor((outW - vidW) / 2), oy: Math.floor((outH - vidH) / 2), radius: 0, blur: 0 }
}

module.exports = { backdropGeometry, plainGeometry, even }
