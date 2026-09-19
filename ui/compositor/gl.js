// The compositor: draws one frame of an edit from its plan (ui/compositor/plan.js) in
// WebGL2. The editor's stage and the export window run this same code; they differ
// only in where the take's pixels come from (a <video> element, or NV12 bytes from
// ffmpeg) and where the finished frame goes (a canvas, or packed NV12 read back for
// the encoder). Passes, in order, are listed in PASSES.md.
//
// Every framebuffer stores its image top row first (row 0 is the top), so read back
// bytes are already in file order and only the present pass flips. No pass reads the
// previous frame: motion blur is analytic, film grain and dither are seeded by frame
// index, the glow family comes off this frame's own bright pass, auto level is measured
// once per take on the CPU, so any frame can be drawn alone.
'use strict'
const Text = require('./text')
const Marks = require('./marks')
const Plan = require('./plan')

const VS = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`

// NV12 to RGB, limited range, chroma bilinear and centre-sited: what Chromium does with
// the same file, to 1 LSB (the M0 spike; left-siting was 119 off at edges). The matrix
// is Chromium's choice too: BT.709 for an HD take whatever its tags say, BT.601 for a
// file under 720 lines without full tags (a small camera, measured on the GL harness).
const FS_NV12 = `#version 300 es
precision highp float;
uniform sampler2D uY, uUV; uniform vec2 uSize; uniform int u601; out vec4 o;
void main(){
  vec2 p = gl_FragCoord.xy;
  float y = texelFetch(uY, ivec2(p), 0).r;
  vec2 c = texture(uUV, p / uSize).rg;
  vec3 yuv = (vec3(y, c) - vec3(16.0, 128.0, 128.0) / 255.0) * vec3(255.0 / 219.0, 255.0 / 224.0, 255.0 / 224.0);
  mat3 m = u601 == 1 ? mat3(1.0, 1.0, 1.0, 0.0, -0.344136, 1.772, 1.402, -0.714136, 0.0)
                     : mat3(1.0, 1.0, 1.0, 0.0, -0.187324, 1.8556, 1.5748, -0.468124, 0.0);
  o = vec4(clamp(m * yuv, 0.0, 1.0), 1.0);
}`

// The app's own light, laid on the ground a look chose. `tokens.css` lights the body
// with two very wide, very faint pools of `--fur-1` in opposite corners, for the reason
// it writes down there: a flat field is an absence of light rather than a room. The
// export is of the same product and drew none of it, so the colour and the geometry are
// the stylesheet's rather than invented ones. Its two ellipses are 70 by 55 and 60 by 50
// percent of the frame at the two corners, each fading to nothing at about three fifths
// of that, which is the reach here; the ramp is linear to nothing as a two-stop CSS
// gradient's is, and the top left goes on last because in CSS the first layer is the top
// one. A few levels deep over eight hundred pixels, and the ground's own tooth is wider
// than the step that takes, so it cannot band.
const GL_POOL = `
const vec3 POOL = vec3(240.0, 169.0, 60.0) / 255.0;
vec3 pooled(vec3 c, vec2 uv){
  float a = 0.040 * max(0.0, 1.0 - length(uv / vec2(0.434, 0.341)));
  float b = 0.026 * max(0.0, 1.0 - length((uv - 1.0) / vec2(0.360, 0.300)));
  return mix(mix(c, POOL, b), POOL, a);
}`

// A still background: a two-colour linear gradient corner to corner (a solid colour is
// a gradient from a colour to itself), or an image covering the frame, dimmed.
const FS_BG = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform int uKind; uniform vec3 uC0, uC1;
uniform sampler2D uImg; uniform vec4 uImgUV; uniform float uImgLod, uDim; out vec4 o;
${GL_POOL}
void main(){
  vec2 p = gl_FragCoord.xy;
  if (uKind == 1) {
    // ffmpeg's gradients source: c0 at the top left, c1 at the bottom right, mixed in sRGB
    float t = clamp(dot(p, uRes) / dot(uRes, uRes), 0.0, 1.0);
    // and the app's own pools over it: a photo brings its own light and a mesh is a
    // composition of its own, so this is the branch that has a flat field to answer for
    o = vec4(pooled(mix(uC0, uC1, t), p / uRes), 1.0);
  } else {
    vec2 uv = uImgUV.xy + (p / uRes) * uImgUV.zw;
    o = vec4(textureLod(uImg, uv, uImgLod).rgb * (1.0 - 0.7 * uDim), 1.0);
  }
}`

// A mesh gradient: a handful of control points, each a place, a reach and a colour,
// blended by normalised Gaussian weights. Mixed in sRGB like FS_BG's flat gradient, so
// a mesh and the gradient of the same name are relatives. Drawn once per plan into the
// background target, never per frame, and its banding is left to the final dither,
// which is what the dither is for.
const FS_MESH = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform int uN; uniform vec3 uP[8]; uniform vec3 uC[8]; out vec4 o;
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = 0; i < 8; i++) { if (i >= uN) break;
    vec2 d = uv - uP[i].xy;
    float w = exp(-dot(d, d) / (2.0 * uP[i].z * uP[i].z));
    acc += uC[i] * w; wsum += w;
  }
  o = vec4(acc / max(wsum, 1e-5), 1.0);
}`

// A background defocused through an aperture instead of a Gaussian: taps on four rings
// of a hexagon, so a highlight opens into the aperture's own shape rather than into a
// soft blob. The average is taken on a cube curve and undone after, or the bright part
// of a highlight would average away instead of becoming a disc.
//
// Eighty-one taps cannot fill a disc twenty-odd texels across on their own: at the wide
// end of the dial the outer ring's taps stand a quarter of the radius apart, and a photo
// with detail at that scale came back as eighty-one copies of itself rather than as one
// aperture. So the caller softens the source first by about that spacing (bokehBlur),
// which is what makes the taps meet. The aperture's edge is then soft by roughly a
// quarter of its radius, and that is the trade a gather this cheap makes.
//
// This runs on the background alone and at the size that background is already made at
// (a quarter of the frame for an image, a sixty-fourth for the take's own ground), so
// the taps cost nothing the bench can see. There is deliberately no whole-frame version:
// a second full-resolution blur is the one thing that would not hold 1080p60.
const FS_BOKEH = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uRes; uniform float uR; out vec4 o;
const float TAU = 6.2831853, SIXTH = 1.0471976, HALFSIXTH = 0.5235988;
void main(){
  vec2 uv = gl_FragCoord.xy / uRes, texel = 1.0 / uRes;
  vec3 acc = pow(texture(uSrc, uv).rgb, vec3(3.0)); float n = 1.0;
  for (int ring = 1; ring <= 4; ring++) {
    float rr = float(ring) / 4.0; int taps = ring * 8;
    for (int i = 0; i < 32; i++) { if (i >= taps) break;
      float a = TAU * (float(i) + 0.5 * float(ring)) / float(taps);
      // the hexagon's own edge at this angle, so the taps fill an aperture, not a circle
      float hex = 0.8660254 / cos(mod(a, SIXTH) - HALFSIXTH);
      acc += pow(texture(uSrc, uv + vec2(cos(a), sin(a)) * (rr * hex * uR) * texel).rgb, vec3(3.0)); n += 1.0;
    }
  }
  o = vec4(clamp(pow(acc / n, vec3(1.0 / 3.0)), 0.0, 1.0), 1.0);
}`
// How far the source has to be softened before an aperture of radius r texels, in
// sigma. The outer ring's taps stand a quarter of r apart, and a Gaussian of r/6 is
// half again as wide as that gap: less and the taps show through the aperture as a dot
// grid, more and its edge goes soft. Under half a texel there is nothing to fix.
const bokehBlur = r => r / 6

// The bright pass the whole glow family comes off, at a quarter of the frame. Bloom
// reads the tight levels of its mip chain and halation the wide ones, so two effects
// cost one blur rather than two, which is what keeps them affordable at 1080p60.
// uThresh is the take's own white point (plan.js, measured by levels.js): a page white
// is not a highlight, and a glow that reads it lays a warm collar over every glyph on
// it. A take that fills the range has nothing above its own white and does not glow.
//
// Each texel judges its own 4x4 box of the frame and the results are averaged, rather
// than the box being averaged and judged once. With the knee this close to white, a
// mean is almost never over it: averaging first left the whole glow family reading
// areas of flat white and nothing else, and at a preview's size nothing at all. The
// cost is that a highlight narrower than the box lands differently at the two sizes
// this compositor draws, because a stage half the export's width holds it as grey
// already. A highlight wide enough to survive being minified reads the same at both,
// which is every highlight anyone looks at.
const FS_BRIGHT = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uMax; uniform float uThresh; out vec4 o;
void main(){
  ivec2 b = ivec2(gl_FragCoord.xy) * 4, hi = ivec2(uMax);
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec3 c = texelFetch(uSrc, min(b + ivec2(i, j), hi), 0).rgb;
    float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // a soft knee, squared: the threshold is a slope, so a highlight drifting across it
    // does not switch the glow on and off between frames
    float w = max(0.0, y - uThresh) / max(1e-3, 1.0 - uThresh);
    acc += c * w * w;
  }
  o = vec4(acc / 16.0, 1.0);
}`

// The blurred take behind itself, first step: the cropped frame shrunk to a few dozen
// pixels, covering the output's shape, read from a mip level near that size.
const FS_SHRINK = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec4 uUV; uniform vec2 uRes; uniform float uLod; out vec4 o;
void main(){ vec2 uv = uUV.xy + (gl_FragCoord.xy / uRes) * uUV.zw; o = vec4(textureLod(uSrc, uv, uLod).rgb, 1.0); }`

// Separable Gaussian, sigma in texels of the target. Used on tiny targets (the blur
// fill) and on a quarter-size still (a blurred image background), so a plain loop.
const FS_GAUSS = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uDir; uniform float uSigma; out vec4 o;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy), size = textureSize(uSrc, 0);
  int r = int(ceil(uSigma * 3.0));
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = -96; i <= 96; i++) {
    if (i < -r || i > r) continue;
    float w = exp(-float(i * i) / (2.0 * uSigma * uSigma));
    ivec2 q = clamp(p + ivec2(uDir) * i, ivec2(0), size - 1);
    acc += texelFetch(uSrc, q, 0).rgb * w; wsum += w;
  }
  o = vec4(acc / wsum, 1.0);
}`

// The frame: background, the framed take's shadow, the take (cropped, zoomed, motion
// blurred, its window margin trimmed) inside a rounded mask, a border, the camera.
//
// It writes a mask as well as a picture. Alpha here is not opacity, it is how much of
// this pixel is the recording: 1 on the take and on the camera, 0 on the ground the
// look chose, on its border, and wherever Fetch drew something of its own on the take
// (the content pass carries that in its own alpha, uMarked). The treatment pass reads
// it and holds the grade to the recording, which is the whole point of drawing it.
//
// It also keeps the take's edge to a floor (plan.js, EDGE_FLOOR): the outermost pixels
// of the take stand off the ground just outside them by at least so much luma, met by
// whichever of the three is available. A blur ground holds near the take's own mean
// rather than being pressed to a deep field under a white page; the shadow is wide
// enough to be felt where there is ground to cast on; and where neither gives the
// floor, a warm hairline just inside the edge does.
const FS_FRAME = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform int uBgKind;                 // 0 none, 1 still, 2 blurred take
uniform uint uFrame;                 // the ground's tooth is seeded by it, like the film and the dither
uniform float uTooth;                // and scaled by it: the export's three levels, at the size being drawn
uniform sampler2D uBg, uFill;
uniform float uVig;                  // the treatment's vignette, which lands on the ground too
uniform vec2 uFillBand;              // how far a blur ground may stand off the take's own mean: least, most
uniform vec4 uRect; uniform float uRadius;
uniform vec2 uTake;                  // the take's opacity and its shadow's (a title card's reveal)
uniform vec4 uShadow;                // dy, sigma, alpha, on
uniform vec4 uBorder; uniform float uBorderPx;
uniform vec2 uEdge;                  // the edge floor in luma, and the hairline's width
uniform vec3 uEdgeCol;               // the warm end that ground leaves open (plan.js edgeEnd)
uniform sampler2D uContent; uniform vec2 uContentSize; uniform vec4 uCropUV, uInner;
uniform int uMarked;                 // the content target carries a mask in its alpha
uniform vec4 uV0, uV1; uniform int uTaps;
uniform int uCam; uniform sampler2D uCamTex; uniform vec4 uCamRect, uCamUV; uniform float uCamRound, uCamRing;
out vec4 o;
const vec3 K = vec3(0.2126, 0.7152, 0.0722);

vec4 erf4(vec4 x){ vec4 s = sign(x), a = abs(x); x = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a; x *= x; return s - s / (x * x); }
float gaussian(float x, float sigma){ return exp(-(x * x) / (2.0 * sigma * sigma)) / (2.5066283 * sigma); }
float boxShadowX(float x, float y, float sigma, float corner, vec2 halfSize){
  float delta = min(halfSize.y - corner - abs(y), 0.0);
  float curved = halfSize.x - corner + sqrt(max(0.0, corner * corner - delta * delta));
  vec2 integral = 0.5 + 0.5 * erf4(vec4((x + vec2(-curved, curved)) * (sqrt(0.5) / sigma), 0.0, 0.0)).xy;
  return integral.y - integral.x;
}
// A rounded box blurred by a Gaussian, in closed form along x and four samples along y
// (Evan Wallace's method): the shadow costs one pass and no blur targets.
float roundedBoxShadow(vec2 lower, vec2 upper, vec2 point, float sigma, float corner){
  vec2 center = (lower + upper) * 0.5, halfSize = (upper - lower) * 0.5; point -= center;
  float low = point.y - halfSize.y, high = point.y + halfSize.y;
  float start = clamp(-3.0 * sigma, low, high), end = clamp(3.0 * sigma, low, high);
  float step = (end - start) / 4.0, y = start + step * 0.5, value = 0.0;
  for (int i = 0; i < 4; i++) { value += boxShadowX(point.x, point.y - y, sigma, corner, halfSize) * gaussian(y, sigma) * step; y += step; }
  return value;
}
float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }
uint hash(uint x){ x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }

// The ground's tooth, in luma. A surface has one and a field of one number across
// 1920x1080 does not, which is the other half of what makes an export read as a CSS
// background rather than as a set. Three levels either side whatever the ground's own
// luma is, which is the noise the classic blur fill has always carried (ffmpeg
// noise=c0s=3) and about ten times the fifth of a level the film's own grain leaves on a
// ground at either end of the range, where Paper, Mono print and Noir live: its midtone
// weighting is right for a picture and backwards for the one surface a look picks the
// luma of. Seeded by the frame index like the film and the dither, so it breathes with
// them and any frame still draws alone. It is on the ground the eye sees and not on the
// ground the edge floor reads (groundAt), because the floor is a distance between two
// tones and three levels of tooth is not a tone.
//
// Three levels of the export's own pixels. On a stage drawn at half the file's size,
// four of those pixels are one, and averaging them halves the noise, so uTooth brings
// the amplitude down with the size the way the film's grain already comes down with its
// cell: the editor's ground is the file's ground at that size rather than twice as
// gritty as anything that will be exported.
float tooth(vec2 p){
  return (float(hash(uint(p.x) * 1973u + hash(uint(p.y) * 9277u + uFrame * 7919u)) & 255u) / 255.0 - 0.5) * 6.0 / 219.0 * uTooth;
}

// A cubic B-spline read of a tiny texture from four bilinear taps, so the blur fill
// scaled up thirty times has no bilinear diamonds.
vec3 bspline(sampler2D t, vec2 uv){
  vec2 size = vec2(textureSize(t, 0)), p = uv * size - 0.5, f = fract(p), i = floor(p);
  vec2 w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0, w1 = (4.0 - 6.0 * f * f + 3.0 * f * f * f) / 6.0;
  vec2 w3 = f * f * f / 6.0, w2 = 1.0 - w0 - w1 - w3;
  vec2 s0 = w0 + w1, s1 = w2 + w3, f0 = w1 / s0, f1 = w3 / s1;
  vec2 t0 = (i - 0.5 + f0) / size, t1 = (i + 1.5 + f1) / size;
  return (texture(t, vec2(t0.x, t0.y)).rgb * s0.x + texture(t, vec2(t1.x, t0.y)).rgb * s1.x) * s0.y
       + (texture(t, vec2(t0.x, t1.y)).rgb * s0.x + texture(t, vec2(t1.x, t1.y)).rgb * s1.x) * s1.y;
}

// The blurred take pressed into a deep colour field: luma to 30 percent, chroma to 80
// (the classic lutyuv), a cos^4 vignette on luma (ffmpeg's vignette at 0.4), the tooth.
// The pressed and vignetted luma is then held inside a band of the take's own mean at
// this point (uFillBand), because this one ground is the take itself and is meant to read
// as bleed. The press is right for a dark take and ruinous for a bright one: a 236 page
// pressed to 30 percent put a 51 fill against it with no shadow, no corner and no
// transition, which is a black bar.
//
// The tooth is the caller's, so the same ground can be drawn with it and read without
// it: the edge floor is a distance between two tones, and a ground probe that carries
// three levels of noise puts that noise into the hairline's opacity, which on a moving
// tooth is a line that crawls.
vec3 fillAt(vec2 p, float grit){
  vec3 c = bspline(uFill, p / uRes);
  vec3 k = vec3(0.2126, 0.7152, 0.0722);
  float y = dot(c, k), cb = (c.b - y) / 1.8556, cr = (c.r - y) / 1.5748;
  float ym = y;                      // the take's own colour here, before the press
  y *= 0.3; cb *= 0.8; cr *= 0.8;
  float dn = length(p - uRes * 0.5) / length(uRes * 0.5);
  float cv = cos(0.4 * dn); cv = cv * cv * cv * cv;
  float yc = (16.0 + 219.0 * y) * cv;
  y = (yc - 16.0) / 219.0;
  // The band, as a lift on the pressed luma and nothing else. On the luma, so the
  // classic chroma press stands: scaling the whole colour to hit a luma multiplied the
  // gutter's chroma by the same factor and left it more saturated than the take it came
  // from. After the fall-off and before the grain, because the band is a promise about
  // the finished frame: applied before the vignette, the fall-off spent another fifth of
  // the gutter and the default look's 64 levels of bleed measured 108 to 126, a grey mat
  // down both sides of a white page. The fall-off survives wherever it stays inside the
  // band, which is what it was always meant to do; the grain lands on the gutter either
  // way, since it goes on after. The take beside it is what the treatment's vignette
  // will leave of it, so both ends of the contract are read on the finished frame. And
  // it only ever lifts, and never under zero: a take too dark to stand a gutter under it
  // has nothing to be lifted from, and a target below zero paints the one thing the
  // output never draws.
  float vt = max(mix(1.0, cv, uVig), 1e-3);
  if (uFillBand.y > 0.0) y = clamp(y, max(0.0, ym * vt - uFillBand.y), max(y, ym * vt - uFillBand.x));
  y += grit;
  vec3 ground = vec3(y + 1.5748 * cr, y - 0.187324 * cb - 0.468124 * cr, y + 1.8556 * cb);
  // the treatment's vignette (uVig, FS_TREAT) multiplies this ground again, so its share
  // is taken back out here and the ground keeps this one fall-off whatever the dial says.
  // Without it the ground fell off twice as fast as the take and the take's edge became a
  // break in it. A corner bright enough to pass 1 once divided clips, which only costs it
  // the little the treatment is about to take off anyway.
  return clamp(ground / vt, 0.0, 1.0);
}

// the take's colour and, in alpha, how much of that sample is the recording rather
// than something Fetch drew on it: both taken through the same taps and the same mip
// level, so a badge minified by a zoom masks exactly as much as it covers
vec4 sampleView(vec2 local, vec4 v, float lod){
  vec2 q = uInner.xy + local * uInner.zw;          // the window's margin trimmed off
  vec2 f = v.xy + q * v.zw;                        // what the zoom shows
  // never past the crop's edge, at any mip level: a <video> holds the whole take, and
  // what the crop removed must not bleed in where the export's cropped decode has none
  vec2 h = 0.5 * exp2(lod) / uContentSize;
  return textureLod(uContent, clamp(uCropUV.xy + f * uCropUV.zw, uCropUV.xy + h, uCropUV.xy + uCropUV.zw - h), lod);
}

// How far a point is outside the framed take, in pixels: its own rounded corner, or
// its plain rectangle when a look asked for no corner at all.
float sdTake(vec2 q, vec2 lo, vec2 hi){
  return uRadius > 0.0 ? sdRound(q - (lo + hi) * 0.5, uRect.zw * 0.5, uRadius)
                       : max(max(lo.x - q.x, q.x - hi.x), max(lo.y - q.y, q.y - hi.y));
}
// The ground at any point: the background a look chose, or the take's own blur, with
// the shadow at that point over it. Read a few pixels outside the take by the edge
// floor, which is measured against the ground a viewer actually sees there.
vec3 groundAt(vec2 q, vec2 lo, vec2 hi){
  vec3 g = uBgKind == 1 ? texture(uBg, q / uRes).rgb : uBgKind == 2 ? fillAt(q, 0.0) : vec3(0.0);
  if (uShadow.w > 0.5) {
    float sh = roundedBoxShadow(lo + vec2(0.0, uShadow.x), hi + vec2(0.0, uShadow.x), q, uShadow.y, uRadius);
    g *= 1.0 - uShadow.z * uTake.y * clamp(sh, 0.0, 1.0);
  }
  return g;
}

void main(){
  vec2 p = gl_FragCoord.xy;
  vec3 col = vec3(0.0);
  float mask = 0.0;                  // the ground is a colour the look chose: no grade
  // the ground the look chose, with the app's own pools already in it (FS_BG) and its
  // tooth on it here, since that is the part that has to be new every frame
  if (uBgKind == 1) col = texelFetch(uBg, ivec2(p), 0).rgb + tooth(p);
  else if (uBgKind == 2) col = fillAt(p, tooth(p));
  vec2 lo = uRect.xy, hi = uRect.xy + uRect.zw;
  if (uShadow.w > 0.5) {
    float sh = roundedBoxShadow(lo + vec2(0.0, uShadow.x), hi + vec2(0.0, uShadow.x), p, uShadow.y, uRadius);
    col *= 1.0 - uShadow.z * uTake.y * clamp(sh, 0.0, 1.0);
  }
  float d = sdTake(p, lo, hi);
  float cover = clamp(0.5 - d, 0.0, 1.0);
  if (cover > 0.0) {
    vec2 local = (p - lo) / uRect.zw;
    // explicit level: the zoom says exactly how far the take is minified, and the
    // sample sits in non-uniform flow where implicit derivatives are undefined
    float lod = max(0.0, log2(uContentSize.x * uCropUV.z * uInner.z * min(uV0.z, uV1.z) / uRect.z));
    vec4 c = vec4(0.0);
    for (int i = 0; i < 32; i++) { if (i >= uTaps) break;
      float s = uTaps == 1 ? 0.0 : float(i) / float(uTaps - 1);
      c += sampleView(local, mix(uV0, uV1, s), lod); }
    c /= float(uTaps);
    // a take with nothing drawn on it is sampled straight from the source, whose alpha
    // is whatever the decoder left there, so it is only trusted while a mark exists
    float take = uMarked == 1 ? c.a : 1.0;
    if (uBorderPx > 0.0) {
      // the border is a colour the look chose too, so it leaves the grade alone
      float bm = clamp(d + uBorderPx + 0.5, 0.0, 1.0) * uBorder.a;
      c.rgb = mix(c.rgb, uBorder.rgb, bm); take *= 1.0 - bm;
    }
    // The edge floor, met by a hairline where the ground does not meet it alone. Only
    // the outermost pixel or so of the take is ever asked, so what this costs (a second
    // ground and a second shadow) is paid on a line and not on a frame.
    if (uEdge.x > 0.0 && d > -uEdge.y - 1.0) {
      // The ground the eye actually sees beside the take: two and a half pixels out
      // along the edge's own normal, shadow and all. Not the ground under this pixel,
      // because a shadow hangs low and at the top edge it has already moved away.
      vec2 e = vec2(1.0, 0.0);
      vec2 n = normalize(vec2(sdTake(p + e.xy, lo, hi) - sdTake(p - e.xy, lo, hi),
                              sdTake(p + e.yx, lo, hi) - sdTake(p - e.yx, lo, hi)) + 1e-5);
      float yg = dot(groundAt(p + n * (2.5 - d), lo, hi), K), yt = dot(c.rgb, K);
      float f = uEdge.x, dy = yt - yg;
      // The tone the line goes to is the plan's end and only ever that: picked once
      // from the background (plan.edgeEnd) so a gradient crossing mid grey cannot put a
      // seam down one side, and held there so the line stays on one side of the take.
      // Drifting it to the other end where the take's own edge sat on it read well on a
      // still frame and could not hold: the two ends are two hundred and thirty levels
      // apart, so the tone crossed the take's own luma, and one level of the take either
      // side of the crossing took the pixel from a floor above the take to a floor below
      // it, thirty levels of swing. That is a line that pops as a lift fades a page, and
      // the two decode paths differ by a level, so it is a solid rim in one and none in
      // the other. Where this end cannot carry the floor the line delivers what it has
      // and no more, which is the honest shortfall rather than a switch.
      vec3 col = uEdgeCol;
      float den = dot(col, K) - yt;
      // How far it has to move this pixel: clear of the further of the take and the
      // ground by the floor, because a line that lands on the take's own tone is not a
      // line. Measured off the ground alone it drew exactly the floor under the ground
      // and left the take inside it, which is the hole a lift opened: a Paper page at
      // 194 with its ground at 214 wore a line at 193.
      //
      // The floor is a distance, not a direction, so an edge already standing clear
      // hands the requirement back over a window rather than at a step, whichever way it
      // stands: two floors wide where the line would be going on past the ground (a
      // Paper page sixty levels above its own shadow was painted back down to exactly
      // the floor before that window existed), one floor wide where the take itself is
      // the far one of the pair and the line is only seeing itself out.
      float down = (f + max(dy, 0.0)) * (1.0 - smoothstep(f, dy > 0.0 ? 3.0 * f : 2.0 * f, abs(dy)));
      float up   = (f - min(dy, 0.0)) * (1.0 - smoothstep(f, dy < 0.0 ? 3.0 * f : 2.0 * f, abs(dy)));
      float move = mix(down, up, smoothstep(-0.5 * f, 0.5 * f, den));
      // The opacity is whatever lands on that, and never more: what arrives is the
      // smaller of what was asked for and what the tone can carry. Read as a signed
      // target rather than a distance, the denominator passing through zero swung the
      // full range across half a level of the take's own pixels, which is a solid rim in
      // one decode path and none in the other; as a distance it is 1 on both sides of
      // zero and continuous through it. What is left to fade out is the last few levels,
      // where the line has nothing to deliver and would only be a pixel of Fetch's own
      // colour taken out of the grade for no gain.
      float a = clamp(move / max(abs(den), 1e-3), 0.0, 1.0) * smoothstep(0.15 * f, 0.35 * f, abs(den));
      // only where there is ground to stand off: a take that reaches the output's own
      // edge has none there, and a line round that is a line round the video
      float room = min(min(p.x, uRes.x - p.x), min(p.y, uRes.y - p.y));
      a *= clamp(d + uEdge.y + 0.5, 0.0, 1.0) * clamp(room - uEdge.y - 1.5, 0.0, 1.0);
      c.rgb = mix(c.rgb, col, a);
      // and out of the grade's mask by its own share of the pixel, like the border and
      // like anything else Fetch chose the colour of. Carving four times as fast took
      // the take's outermost pixel and a quarter out of the grade altogether wherever
      // the line reached a quarter opacity, so a monochrome look wore a ring of the
      // product's own colour round a picture it had just finished draining.
      take *= 1.0 - a;
    }
    col = mix(col, c.rgb, cover * uTake.x);
    // The mask carries the antialias with it, so the treatment pass knows exactly how
    // much of a rim pixel is the recording. What it does with that is the part that
    // matters (FS_TREAT): grading the blend at this weight is not grading the
    // recording's share of it.
    mask = mix(mask, take, cover * uTake.x);
  }
  if (uCam == 1) {
    vec2 clo = uCamRect.xy, chi = uCamRect.xy + uCamRect.zw, cc = (clo + chi) * 0.5;
    float sh = roundedBoxShadow(clo + vec2(0.0, uCamRect.z * 0.03), chi + vec2(0.0, uCamRect.z * 0.03), p, uCamRect.z * 0.045, uCamRound);
    col *= 1.0 - 0.32 * clamp(sh, 0.0, 1.0);
    float cd = sdRound(p - cc, uCamRect.zw * 0.5, uCamRound);
    float ccov = clamp(0.5 - cd, 0.0, 1.0);
    if (ccov > 0.0) {
      vec2 uv = uCamUV.xy + ((p - clo) / uCamRect.zw) * uCamUV.zw;
      float lod = max(0.0, log2(float(textureSize(uCamTex, 0).x) * uCamUV.z / uCamRect.z));
      vec3 c = textureLod(uCamTex, uv, lod).rgb;
      // the bubble is a recording as much as the take is, so the grade holds it; its
      // ring is not, and auto level never reaches either (it is held to the take's rect,
      // and those two numbers were measured off the screen's pixels, not the camera's)
      float rm = uCamRing > 0.0 ? clamp(cd + uCamRing + 0.5, 0.0, 1.0) : 0.0;
      if (rm > 0.0) c = mix(c, vec3(0.984, 0.980, 0.973), rm);
      col = mix(col, c, ccov);
      mask = mix(mask, 1.0 - rm, ccov);
    }
  }
  o = vec4(col, mask);
}`

// Treatment: the lens, the film and the grade over the finished frame (PASSES.md 13),
// in that order, because that is the order light meets them. The lens softens the
// frame, parts its channels towards the corners and spills its highlights; the film
// adds halation to that spill; only then does the grade touch the picture, and the
// vignette last so it matches the ground behind the frame.
//
// Where the line is drawn, and why. A lens and a roll of film are in front of the whole
// frame, so blur, aberration, bloom, halation, the vignette (and grain and dither, in
// the final pass) land on everything: the take, the ground, the badges, the words. The
// grade is of the picture the camera took, so brightness, contrast, saturation, tint
// and auto level are held to the recording by the mask the frame pass wrote. The ground
// is already the colour the look asked for, and Fetch's own furniture is already the
// colour Fetch chose; a grade over them takes a warm near-black to pure black, a paper
// ground to pure white and every gold badge to grey. Haze goes with the lens: it is
// light scattered on the way in, not a dial on the finished picture, and held to the
// take it would lift the take grey against a clean ground and make its edge a break,
// which is the same fault the ground's divided-out vignette exists to avoid.
//
// Every part is a uniform that is zero while its field is off, and render() skips the
// whole pass when the look asks for none of it, so a look that does not use treatment
// pays nothing and draws exactly what it drew before this existed.
const FS_TREAT = `#version 300 es
precision highp float;
uniform sampler2D uScene, uSoft, uGlow;
uniform vec2 uRes;
uniform float uSoftOn, uMeanLod, uAb;
uniform vec3 uLevel;                 // the take's black point, its white point, how much
uniform vec4 uLevelBox; uniform float uLevelRad;   // and where the take is, which is all it touches
uniform vec3 uGrade;                 // brightness, contrast, saturation, as ffmpeg eq takes them
uniform vec4 uShoulder, uToe;        // and the two ends of that line rolled in (plan.js rollOff)
uniform vec4 uTint;                  // the colour, and how much of it
uniform vec2 uAtmos;                 // haze, vignette
uniform vec3 uGlowMix;               // bloom, halation, on
out vec4 o;
const vec3 K = vec3(0.2126, 0.7152, 0.0722);
float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }
// the warm collar film wears round a highlight: the red layer bleeds furthest, so the
// wide end of the glow is laid back red-orange rather than white
const vec3 HALO = vec3(1.0, 0.38, 0.20);
// the softened frame is graded, rather than the grade blurred: everything after this is
// per pixel and affine, so the two agree, and the frame is only blurred once
vec3 sceneAt(vec2 p){ return uSoftOn > 0.5 ? texture(uSoft, p / uRes).rgb : textureLod(uScene, p / uRes, 0.0).rgb; }
// The straight contrast line with its top rolled in. S is (knee, run, and the curve's
// two terms), worked out once per plan by rollOff(): under the knee the line is the
// line, over it a cubic arrives flat on 1.0, so the take's own white lands on white and
// what sits a pixel under it stays a pixel under it. A run of 0 is a line that never
// left the range, and this is then exactly the expression it always was.
vec3 rollIn(vec3 g, vec4 S){
  if (S.y <= 0.0) return g;
  vec3 s = clamp((g - S.x) / S.y, 0.0, 1.0);
  return mix(g, S.x + S.y * (s + S.z * s * s + S.w * s * s * s), step(vec3(S.x), g));
}
// and the same curve at the bottom, where a hairline on a dark page goes into black
vec3 rollOut(vec3 g, vec4 T){ return T.y <= 0.0 ? g : 1.0 - rollIn(1.0 - g, T); }
// The grade itself, as one function of a colour, because the take's antialiased edge
// needs it of two: contrast about mid grey with both ends rolled in, then brightness,
// then saturation, then the tint multiplied in with the luminance put back.
vec3 gradeAt(vec3 c){
  vec3 g = rollOut(rollIn((c - 0.5) * uGrade.y + 0.5 + uGrade.x, uShoulder), uToe);
  float y = dot(g, K);
  g = mix(vec3(y), g, uGrade.z);
  if (uTint.w > 0.0) {
    // the classic photo filter: the colour multiplied in and the luminance put back, so
    // a tint colours the picture without darkening it
    vec3 t = g * uTint.rgb;
    t *= max(y, 0.0) / max(dot(t, K), 1e-4);
    g = mix(g, t, uTint.w);
  }
  return g;
}
// How far a point is outside the take's own rect, corner and all: auto level's
// authority, and the edge the grade has to know about to hand a rim pixel's ground back
float takeDist(vec2 q){
  return uLevelRad > 0.0 ? sdRound(q - (uLevelBox.xy + uLevelBox.zw * 0.5), uLevelBox.zw * 0.5, uLevelRad)
    : max(max(uLevelBox.x - q.x, q.x - uLevelBox.x - uLevelBox.z), max(uLevelBox.y - q.y, q.y - uLevelBox.y - uLevelBox.w));
}
void main(){
  vec2 p = gl_FragCoord.xy;
  vec3 c;
  if (uAb > 0.0) {
    // Chromatic aberration: the channels part radially, growing with the square of the
    // distance from the centre, so the middle of the frame stays clean and the corners
    // wear a fringe. uAb is that parting at the corners, in this compositor's pixels,
    // and is usually under one of them.
    vec2 d = (p - uRes * 0.5) / (0.5 * uRes);
    vec2 off = (d / max(length(d), 1e-4)) * min(1.0, dot(d, d) * 0.5) * uAb;
    c = vec3(sceneAt(p + off).r, sceneAt(p).g, sceneAt(p - off).b);
  } else c = uSoftOn > 0.5 ? texture(uSoft, p / uRes).rgb : texelFetch(uScene, ivec2(p), 0).rgb;
  if (uGlowMix.z > 0.5) {
    // Bloom and halation off one bright pass and one mip chain (FS_BRIGHT): bloom is
    // the tight end of the chain, the spill close to a highlight, halation the wide
    // end, warm. Both sit before the grade because both happen to the light, in the
    // lens and in the emulsion, not to the finished picture.
    vec2 uv = p / uRes;
    vec3 g0 = textureLod(uGlow, uv, 0.0).rgb, g1 = textureLod(uGlow, uv, 1.0).rgb;
    vec3 g2 = textureLod(uGlow, uv, 2.0).rgb, g3 = textureLod(uGlow, uv, 3.0).rgb;
    vec3 g4 = textureLod(uGlow, uv, 4.0).rgb;
    c += (g0 + 0.8 * g1 + 0.55 * g2 + 0.3 * g3) * (uGlowMix.x * 0.38);
    vec3 wide = (g2 + g3 + g4) / 3.0;
    c += mix(vec3(dot(wide, K)), wide, 0.4) * HALO * uGlowMix.y;
  }
  // How much of this pixel is the recording (FS_FRAME writes it into the scene's alpha):
  // 1 on the take and the camera, 0 on the ground, the border, a step badge, the agent's
  // cursor, a caption. Taken at full resolution even while the lens reads a softened
  // copy, because it is geometry and not light: the grade stops exactly at the take.
  float take = texelFetch(uScene, ivec2(p), 0).a;
  // auto level: one stretch for the whole take, measured once (compositor/levels.js).
  // It is held to the take's own rect, corner and all. The numbers come from the take's
  // pixels, and a black point of a quarter laid over the background would take the warm
  // near-black a look asked for down to pure black and a paper ground up to pure white.
  // The take's edge is already a hard edge, so nothing is feathered but its own corner.
  // The rect stays its authority (it is what keeps the camera bubble out of numbers
  // measured off the screen); the mask only takes away, where Fetch drew over the take.
  float ld = takeDist(p);
  if (uLevel.z > 0.0) {
    float m = min(clamp(0.5 - ld, 0.0, 1.0) * uLevel.z, take);
    if (m > 0.0) c = mix(c, clamp((c - uLevel.x) / max(0.05, uLevel.y - uLevel.x), 0.0, 1.0), m);
  }
  // The grade, held to the recording by that same mask. Contrast about mid grey, then
  // brightness, which is ffmpeg eq's own order and its dials: the classic renderer's
  // only levels control (the spotlight's dim) is the same expression, so a look reads
  // the same in both renderers. What the straight line would have pushed past the ends
  // is rolled in rather than cut off, pinned to the take's own black and white points:
  // eq clips, and a clip on a white app page is the product's own hairlines deleted.
  if (take > 0.0) {
    vec3 g = gradeAt(c);
    // exactly the graded colour where the mask is whole, so a frame with nothing drawn
    // over the take comes back byte for byte what it was before this mask existed
    if (take >= 1.0) c = g;
    else if (abs(ld) < 2.0) {
      // The take's own antialiased edge, where the pixel is part recording and part
      // ground. Grading the blend at the mask's weight is not the same as grading the
      // recording's share of it: it leaves a quarter of the take's own colour ungraded
      // and takes a quarter of the ground's warmth off, which came out as a closed
      // coloured rim round a picture a black and white look had just drained. The grade
      // is affine, so the whole pixel graded plus the ground's share handed back
      // ungraded is exactly the recording's share graded and the ground left alone. The
      // ground's colour is the one a couple of pixels outside the edge, along the edge's
      // own normal, which is the same place the frame pass measured the edge floor at.
      vec2 e = vec2(1.0, 0.0);
      vec2 n = normalize(vec2(takeDist(p + e.xy) - takeDist(p - e.xy),
                              takeDist(p + e.yx) - takeDist(p - e.yx)) + 1e-5);
      vec3 gr = sceneAt(p + n * (2.5 - ld));
      c = g + (1.0 - take) * (gr - gradeAt(gr));
    }
    // and anywhere else the mask is partial it is Fetch's own furniture over the take
    // (a badge's antialiased outline, a glyph's), whose own colour is in this pixel and
    // nowhere else to be read from
    else c = mix(c, g, take);
  }
  if (uAtmos.x > 0.0) {
    // haze lifts the blacks toward the frame's own colour (its deepest mip level is the
    // frame's mean), half of it neutral so a near-black frame lifts grey and not a hue
    // its own noise chose
    vec3 mean = textureLod(uScene, vec2(0.5), uMeanLod).rgb;
    vec3 hue = clamp(mix(vec3(1.0), mean / max(dot(mean, K), 1e-3), 0.6), 0.0, 2.0);
    vec3 lift = clamp(uAtmos.x * 0.22 * hue, 0.0, 0.5);
    c = lift + c * (1.0 - lift);
  }
  // Bokeh is not here: it is the background's own defocus given an aperture's shape
  // (FS_BOKEH), drawn where that background is made, at a quarter of the frame for an
  // image and a sixty-fourth for the take's own ground.
  if (uAtmos.y > 0.0) {
    // the blur ground's own vignette, cos^4 of 0.4 times the normalised distance
    // (ffmpeg vignette=angle=0.4), in proportion to the dial: at 1 the frame falls off
    // exactly as the ground behind it does. It scales the whole colour where fillAt
    // scales luma alone, deliberately: over a finished frame a luma-only fall-off
    // leaves the corners darker but no less saturated, which reads as a colour cast.
    float dn = length(p - uRes * 0.5) / length(uRes * 0.5);
    float cv = cos(0.4 * dn); cv *= cv; cv *= cv;
    c *= mix(1.0, cv, uAtmos.y);
  }
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`

// Last: film grain, the fade to and from black over the whole frame, then a triangular
// dither of one 8-bit step seeded by frame, so a dark gradient does not band once
// encoded. Grain sits before the fade, or a frame fading to black would keep grain on
// black.
const FS_FINAL = `#version 300 es
precision highp float;
uniform sampler2D uScene; uniform float uFade; uniform int uDither; uniform uint uFrame;
uniform float uGrain, uCell; out vec4 o;
uint hash(uint x){ x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float rnd(uvec2 p, uint salt){ return float(hash(p.x + hash(p.y + hash(uFrame * 7u + salt)))) / 4294967295.0; }
void main(){
  vec2 p = gl_FragCoord.xy; uvec2 ip = uvec2(p);
  vec3 c = texelFetch(uScene, ivec2(p), 0).rgb;
  if (uGrain > 0.0) {
    // Film grain: its own salts, seeded by the frame index like the dither, so a frame
    // drawn alone and out of order is the same frame. Its cell is sized on the export's
    // grid (uCell is already in the pixels this compositor draws), so a look grains the
    // same at 720p and at 4K. Triangular, and heaviest in the midtones as film is, so a
    // black frame stays black and a white one stays clean.
    uvec2 g = uvec2(floor(p / uCell));
    float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c += (rnd(g, 5u) - rnd(g, 6u)) * uGrain * mix(0.35, 1.0, 4.0 * y * (1.0 - y));
  }
  c *= uFade;
  if (uDither == 1) c += (rnd(ip, 3u) - rnd(ip, 4u)) / 255.0;
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`

// To the canvas, flipped (the canvas's row 0 is the bottom)
const FS_PRESENT = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uRes; out vec4 o;
void main(){ ivec2 p = ivec2(gl_FragCoord.xy); o = texelFetch(uSrc, ivec2(p.x, int(uRes.y) - 1 - p.y), 0); }`

// NV12 packed into one RGBA8 target of ceil(W/4) x 1.5H: rows 0..H-1 hold four luma
// bytes a texel, rows H.. two interleaved UV pairs, so one readPixels returns the bytes
// in NV12 order. BT.709 limited range, chroma the 2x2 box mean (centre-sited).
const FS_PACK = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform int uH, uW; out vec4 o;
vec3 rgb(int x, int y){ return texelFetch(uSrc, ivec2(clamp(x, 0, uW - 1), y), 0).rgb; }
float Y(vec3 c){ return (16.0 + 219.0 * dot(c, vec3(0.2126, 0.7152, 0.0722))) / 255.0; }
vec2 UV(vec3 c){ float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return (128.0 + 224.0 * vec2((c.b - y) / 1.8556, (c.r - y) / 1.5748)) / 255.0; }
vec2 chroma(int cx, int r){ int x = cx * 2, y = r * 2;
  return UV((rgb(x, y) + rgb(x + 1, y) + rgb(x, y + 1) + rgb(x + 1, y + 1)) * 0.25); }
void main(){
  ivec2 q = ivec2(gl_FragCoord.xy);
  if (q.y < uH) { int x = q.x * 4;
    o = vec4(Y(rgb(x, q.y)), Y(rgb(x + 1, q.y)), Y(rgb(x + 2, q.y)), Y(rgb(x + 3, q.y)));
  } else { int r = q.y - uH; o = vec4(chroma(q.x * 2, r), chroma(q.x * 2 + 1, r)); }
}`

// ── content space (M3): what is drawn on the recording itself, before any zoom ──
// The cropped take is copied into a target of its own size (`cont`), marked there, and
// the frame pass samples that instead of the source, so a zoom carries every mark with
// the thing it marks. Positions arrive in target pixels (the plan's content pixels
// scaled by the decode), top row first like every other target.

// The recording, cleaned: the Mac's pointer filled from the edges of its box (as
// ffmpeg's delogo does, each side weighted by nearness), and redactions, cells whose
// colour is the mean of what they cover, so no letter survives at any zoom.
const FS_CLEAN = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec4 uCropUV; uniform vec2 uT, uSrcSize;
uniform int uNFill; uniform vec4 uFill[24];
uniform int uNRed; uniform vec4 uRed[8]; uniform float uCell[8];
out vec4 o;
vec3 at(vec2 p){ vec2 q = clamp(p, vec2(0.5), uT - 0.5); return textureLod(uSrc, uCropUV.xy + (q / uT) * uCropUV.zw, 0.0).rgb; }
void main(){
  vec2 p = gl_FragCoord.xy;
  vec3 c = at(p);
  for (int i = 0; i < 24; i++) { if (i >= uNFill) break;
    vec4 b = uFill[i];
    if (p.x < b.x || p.y < b.y || p.x > b.x + b.z || p.y > b.y + b.w) continue;
    float l = p.x - b.x + 1.0, r = b.x + b.z - p.x + 1.0, t = p.y - b.y + 1.0, d = b.y + b.w - p.y + 1.0;
    vec3 L = at(vec2(b.x - 0.5, p.y)), R = at(vec2(b.x + b.z + 0.5, p.y)), T = at(vec2(p.x, b.y - 0.5)), D = at(vec2(p.x, b.y + b.w + 0.5));
    c = (L / l + R / r + T / t + D / d) / (1.0 / l + 1.0 / r + 1.0 / t + 1.0 / d);
  }
  for (int i = 0; i < 8; i++) { if (i >= uNRed) break;
    vec4 b = uRed[i];
    if (p.x < b.x || p.y < b.y || p.x > b.x + b.z || p.y > b.y + b.w) continue;
    float s = uCell[i];
    vec2 o0 = b.xy + floor((p - b.xy) / s) * s, o1 = min(o0 + s, b.xy + b.zw);
    // four by four taps over the cell, each from the mip level a quarter cell across
    float lod = max(0.0, log2(max(1.0, (o1.x - o0.x) / 4.0) * uSrcSize.x * uCropUV.z / uT.x));
    vec3 m = vec3(0.0);
    for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
      vec2 q = mix(o0, o1, (vec2(float(x), float(y)) + 0.5) / 4.0);
      m += textureLod(uSrc, uCropUV.xy + (q / uT) * uCropUV.zw, lod).rgb;
    }
    c = m / 16.0;
  }
  // alpha is the recording's mask, as in FS_FRAME: a cleaned, redacted take is still
  // all recording, and only the steps and the cursor drawn later take anything out of it
  o = vec4(c, 1.0);
}`

// A copy of part of a texture into part of a target, straight or shrunk from a mip
// level: the clean patch over a resting pointer, the start of every blur here.
const FS_COPY = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec4 uUV; uniform vec4 uDst; uniform float uLod; out vec4 o;
void main(){ vec2 uv = uUV.xy + ((gl_FragCoord.xy - uDst.xy) / uDst.zw) * uUV.zw; o = vec4(textureLod(uSrc, uv, uLod).rgb, 1.0); }`

// The shape every quad here is drawn with: a rectangle in target pixels
const VS_QUAD = `#version 300 es
uniform vec4 uDst; uniform vec2 uTarget;
void main(){ vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  gl_Position = vec4((uDst.xy + c * uDst.zw) / uTarget * 2.0 - 1.0, 0.0, 1.0); }`

// A blur mark laid back through a round-cornered mask, easing in and out: the blurred
// patch (uSrc, the box and its margin) at the mark's opacity.
//
// It is a plate, with its own corner and its own hairline just inside it. A viewer has
// to read a blur as something someone put there on purpose; a patch that fades out over
// twenty pixels with no boundary anywhere reads as a render that went soft, which is
// the fault the mark was drawn to avoid. The hairline follows the plate's own tone, a
// warm light over a dark patch and warm ink over a light one, the same rule the take's
// own edge floor uses.
const FS_BLURMARK = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec4 uDst, uBox; uniform float uR, uF, uOp, uHair; out vec4 o;
const vec3 K = vec3(0.2126, 0.7152, 0.0722);
const vec3 INK = vec3(0.102, 0.090, 0.078), LIT = vec3(0.984, 0.980, 0.973);
float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }
void main(){
  vec2 p = gl_FragCoord.xy;
  vec3 c = texture(uSrc, (p - uDst.xy) / uDst.zw).rgb;
  float d = sdRound(p - (uBox.xy + uBox.zw * 0.5), uBox.zw * 0.5, uR);
  float s = clamp(0.5 - d / uF, 0.0, 1.0); s = s * s * (3.0 - 2.0 * s);
  if (uHair > 0.0) {
    // The end drifts with the plate's tone rather than choosing between the two at mid
    // grey. A per-pixel two-way gate is the seam the take's own edge rule refuses for
    // the same reason: the step is 67 levels wide, the two decode paths differ by one,
    // and a ring pixel either side of mid grey lands on opposite ends of it. Drifting,
    // that same level moves the ring by less than one.
    float ring = clamp(1.0 + d / uHair, 0.0, 1.0) * s;
    c = mix(c, mix(LIT, INK, smoothstep(0.2, 0.8, dot(c, K))), 0.3 * ring);
  }
  o = vec4(c, 1.0) * s * uOp;
}`

// Lift and spotlight (ui/compositor/focus.js). A spotlight keeps the page in place and
// steps the rest back through a feathered window. A lift raises the element itself: its
// real pixels, cut out with its own corners, scaled a few percent about its centre (and
// moved in from a frame edge), over a wide key shadow and a tight contact shadow, while
// the page behind steps back: blurred, and dimmed by multiplication so it keeps its
// colour, less right by the piece and more with distance, so it reads as depth.
const FS_FOCUS = `#version 300 es
precision highp float;
uniform sampler2D uSrc, uPage; uniform vec2 uT;
uniform int uN;
uniform vec4 uBox[4];     // the element's box at rest, x y w h
uniform vec4 uA[4];       // corner radius, level 0..1, kind (0 spotlight, 1 lift), scale when up
uniform vec4 uB[4];       // dim, dim at the piece (a share of dim), distance it reaches full dim, feather
uniform vec4 uKey[4];     // key shadow: dy, sigma, alpha, blur ramp
uniform vec4 uCon[4];     // contact shadow: dy, sigma, alpha, edge anti-aliasing
uniform vec2 uNudge[4];
out vec4 o;
vec4 erf4(vec4 x){ vec4 s = sign(x), a = abs(x); x = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a; x *= x; return s - s / (x * x); }
float gaussian(float x, float sigma){ return exp(-(x * x) / (2.0 * sigma * sigma)) / (2.5066283 * sigma); }
float boxShadowX(float x, float y, float sigma, float corner, vec2 halfSize){
  float delta = min(halfSize.y - corner - abs(y), 0.0);
  float curved = halfSize.x - corner + sqrt(max(0.0, corner * corner - delta * delta));
  vec2 integral = 0.5 + 0.5 * erf4(vec4((x + vec2(-curved, curved)) * (sqrt(0.5) / sigma), 0.0, 0.0)).xy;
  return integral.y - integral.x;
}
float roundedBoxShadow(vec2 lower, vec2 upper, vec2 point, float sigma, float corner){
  vec2 center = (lower + upper) * 0.5, halfSize = (upper - lower) * 0.5; point -= center;
  float low = point.y - halfSize.y, high = point.y + halfSize.y;
  float start = clamp(-3.0 * sigma, low, high), end = clamp(3.0 * sigma, low, high);
  float step = (end - start) / 4.0, y = start + step * 0.5, value = 0.0;
  for (int i = 0; i < 4; i++) { value += boxShadowX(point.x, point.y - y, sigma, corner, halfSize) * gaussian(y, sigma) * step; y += step; }
  return value;
}
float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }
vec3 at(vec2 p){ return textureLod(uSrc, p / uT, 0.0).rgb; }
void main(){
  vec2 p = gl_FragCoord.xy;
  vec3 orig = at(p), page = texture(uPage, p / uT).rgb;
  float blurMix = 0.0, shade = 1.0;
  vec3 piece = vec3(0.0); float cover = 0.0;
  for (int i = 0; i < 4; i++) { if (i >= uN) break;
    vec4 b = uBox[i]; float r = uA[i].x, L = uA[i].y;
    vec2 half0 = b.zw * 0.5, c0 = b.xy + half0;
    if (uA[i].z < 0.5) {
      float d = sdRound(p - c0, half0, r);
      float a = clamp(d / uB[i].w + 0.5, 0.0, 1.0); a = a * a * (3.0 - 2.0 * a);
      shade *= 1.0 - uB[i].x * L * a;
      blurMix = max(blurMix, L * a);
      continue;
    }
    float k = 1.0 + (uA[i].w - 1.0) * L;
    vec2 c = c0 + uNudge[i] * L, h = half0 * k;
    float rk = r * k;
    float d = sdRound(p - c, h, rk);
    // light falls off the piece: a little dim beside it, the whole of it far away
    float far = smoothstep(0.0, uB[i].z, max(d, 0.0));
    shade *= 1.0 - uB[i].x * L * mix(uB[i].y, 1.0, far);
    // the page right by the piece stays sharp for a moment, so it never shows a soft
    // copy of the element round its own edge; but where the piece was, before it moved
    // in from a frame edge, is the element again, and goes soft with the page
    float rest = 1.0 - smoothstep(-1.0, 1.0, sdRound(p - c0, half0, r));
    blurMix = max(blurMix, L * max(smoothstep(0.0, uKey[i].w, d), rest));
    float sk = roundedBoxShadow(c - h + vec2(0.0, uKey[i].x), c + h + vec2(0.0, uKey[i].x), p, uKey[i].y, rk);
    float sc = roundedBoxShadow(c - h + vec2(0.0, uCon[i].x), c + h + vec2(0.0, uCon[i].x), p, uCon[i].y, rk);
    shade *= (1.0 - uKey[i].z * L * clamp(sk, 0.0, 1.0)) * (1.0 - uCon[i].z * L * clamp(sc, 0.0, 1.0));
    // the element's own pixels, carried up
    vec2 q = c0 + (p - c) / k;
    float cv = clamp(0.5 - d / uCon[i].w, 0.0, 1.0);
    if (cv > 0.0 && L > 0.0) { piece = mix(piece, at(q), cv); cover = max(cover, cv); }
  }
  vec3 bg = mix(orig, page, blurMix) * shade;
  o = vec4(mix(bg, piece, cover), 1.0);
}`

// A picture over a target (text, badges, the cursor): premultiplied, at an opacity,
// crossfading to a blurred copy while it comes in or goes, and with one rectangle of it
// re-coloured (the word being spoken)
const FS_SPRITE = `#version 300 es
precision highp float;
uniform sampler2D uTex, uTex2; uniform vec4 uDst, uUV; uniform float uOp, uMix, uCarve;
uniform vec4 uTint; uniform vec3 uTintCol; out vec4 o;
void main(){
  vec2 p = gl_FragCoord.xy, uv = uUV.xy + ((p - uDst.xy) / uDst.zw) * uUV.zw;
  vec4 c = texture(uTex, uv);
  if (uMix > 0.0) c = mix(c, texture(uTex2, uv), uMix);
  if (uTint.z > 0.0 && p.x >= uTint.x && p.y >= uTint.y && p.x <= uTint.x + uTint.z && p.y <= uTint.y + uTint.w) c.rgb = uTintCol * c.a;
  o = c * uOp;
  // The carve pass (Compositor.quad), alpha only: what a piece of Fetch's own furniture
  // takes out of the recording's mask is the part of the pixel it actually covers, not
  // the alpha of the shadow it casts or the shade it sits in. Carved by the whole of
  // that alpha, a badge's drop shadow and a caption's blurred glyph cloud pulled the
  // recording under them part way out of the grade, so a look that takes the colour out
  // of a take left a soft coloured halo ninety pixels wide round every badge, the
  // agent's cursor and every caption over the picture. The picture's own coverage is
  // read back out of the sprite's opacity and put back after it, so a badge fading in
  // carves the share it covers and not the share it is drawn at.
  if (uCarve > 0.5) o = vec4(0.0, 0.0, 0.0, smoothstep(0.5, 0.95, c.a) * uOp);
}`

// A title card's ground over the finished frame: the frame itself blurred and half
// desaturated (a closing card) or nothing (an opening one, over the bare background),
// under a near-black scrim three quarters in the middle and deeper toward the edges
const FS_GROUND = `#version 300 es
precision highp float;
uniform sampler2D uBlur; uniform vec2 uRes; uniform int uBlurred; uniform float uOp; out vec4 o;
void main(){
  vec2 p = gl_FragCoord.xy, n = (p - uRes * 0.5) / (uRes * 0.5);
  float sa = 0.74 + 0.16 * min(1.0, dot(n, n) / 2.0);
  vec3 scrim = vec3(14.0, 13.0, 12.0) / 255.0;
  if (uBlurred == 1) {
    vec3 c = texture(uBlur, p / uRes).rgb;
    float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(y), c, 0.55);
    o = vec4(mix(c, scrim, sa), 1.0) * uOp;
  } else o = vec4(scrim, 1.0) * sa * uOp;
}`

// The plate under a caption: the frame's own light, blurred, through a feathered
// rounded patch at the words' own bounds, with a scrim mixed into it. The scrim is the
// far end of the words' colour, so a light caption gets a dark plate and an ink one a
// light plate: glass alone is the frame's own luma, and a white caption over a blurred
// white page is still a white caption. It is a plate, not a shadow, which is the whole
// difference between a shape someone put there and a smudge.
const FS_FROST = `#version 300 es
precision highp float;
uniform sampler2D uBlur; uniform vec2 uRes; uniform vec4 uBox; uniform float uR, uF, uOp;
uniform vec3 uScrim; uniform float uScrimA; out vec4 o;
float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }
void main(){
  vec2 p = gl_FragCoord.xy;
  float d = sdRound(p - (uBox.xy + uBox.zw * 0.5), uBox.zw * 0.5, uR);
  float s = clamp(0.5 - d / (2.4 * uF), 0.0, 1.0); s = s * s * (3.0 - 2.0 * s);
  o = vec4(mix(texture(uBlur, p / uRes).rgb, uScrim, uScrimA), 1.0) * s * uOp;
}`

const mipsFor = (w, h) => Math.floor(Math.log2(Math.max(w, h))) + 1
const canvas = (w, h) => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, w), Math.max(1, h))
  const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c
}

class Compositor {
  // W x H is what this compositor draws: the export's size, or the stage's pixels in the
  // editor. A plan is always in export pixels and is scaled to fit.
  constructor(W, H, opts = {}) {
    const canvas = opts.canvas || (typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(W, H))
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: !!opts.preserve, powerPreference: 'high-performance' })
    if (!gl) throw new Error('WebGL2 is not available')
    this.gl = gl
    this.prog = {}
    for (const [k, fs] of Object.entries({ nv12: FS_NV12, bg: FS_BG, mesh: FS_MESH, shrink: FS_SHRINK, gauss: FS_GAUSS,
      bokeh: FS_BOKEH, bright: FS_BRIGHT, frame: FS_FRAME, treat: FS_TREAT, final: FS_FINAL, present: FS_PRESENT, pack: FS_PACK,
      clean: FS_CLEAN, copy: FS_COPY, focus: FS_FOCUS, ground: FS_GROUND })) this.prog[k] = this.program(fs)
    for (const [k, fs] of Object.entries({ blurmark: FS_BLURMARK, sprite: FS_SPRITE, frost: FS_FROST })) this.prog[k] = { ...this.program(fs, VS_QUAD), quad: true }
    this.vao = gl.createVertexArray()
    // pictures drawn with Canvas2D (text, badges, the cursor), by what they show
    this.pics = new Map()
    this.scratch = new Map()
    this.imgEls = new Map()
    this.measure = Text.canvasMeasure()
    this.slots = {}
    this.bgKey = null
    this.images = new Map()
    this.imgLuma = new Map()
    this.dummy = this.texture(1, 1)
    this.resize(W, H)
  }

  resize(W, H) {
    W = Math.max(2, Math.round(W)); H = Math.max(2, Math.round(H))
    if (this.W === W && this.H === H) return
    this.W = W; this.H = H
    this.canvas.width = W; this.canvas.height = H
    for (const k of ['bg', 'scene', 'out', 'packed']) if (this[k]) this.free(this[k])
    this.bg = this.target(W, H)
    // mipmapped: a title card's ground and a caption's glass are blurred from it
    this.scene = this.target(W, H, mipsFor(W, H))
    this.out = this.target(W, H)
    this.packed = this.target(Math.ceil(W / 4), (H * 3) >> 1)
    this.bgKey = null
  }

  program(fs, vs = VS) {
    const gl = this.gl
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s }
    const p = gl.createProgram()
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
    // an array is set whole through its first element's location
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size } }
    return { p, u }
  }

  texture(w, h, fmt = 'rgba8', mips = 1) {
    const gl = this.gl; const t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texStorage2D(gl.TEXTURE_2D, mips, { rgba8: gl.RGBA8, r8: gl.R8, rg8: gl.RG8 }[fmt], w, h)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return { tex: t, w, h, fmt, mips }
  }
  target(w, h, mips = 1) {
    const gl = this.gl; const t = this.texture(w, h, 'rgba8', mips)
    t.fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0)
    return t
  }
  free(t) { if (!t) return; this.gl.deleteTexture(t.tex); if (t.fbo) this.gl.deleteFramebuffer(t.fbo) }

  draw(name, dst, uniforms = {}, textures = {}) {
    const gl = this.gl; const { p, u } = this.prog[name]
    gl.useProgram(p)
    let unit = 0
    for (const [k, t] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, (t || this.dummy).tex)
      if (u[k]) gl.uniform1i(u[k].loc, unit); unit++
    }
    for (const [k, v] of Object.entries(uniforms)) {
      const e = u[k]; if (!e) continue
      const a = Array.isArray(v) ? v : [v]
      if (!a.length) continue
      switch (e.type) {
        case gl.FLOAT: if (e.size > 1) gl.uniform1fv(e.loc, a); else gl.uniform1f(e.loc, a[0]); break
        case gl.FLOAT_VEC2: gl.uniform2fv(e.loc, a); break
        case gl.FLOAT_VEC3: gl.uniform3fv(e.loc, a); break
        case gl.FLOAT_VEC4: gl.uniform4fv(e.loc, a); break
        case gl.INT: gl.uniform1i(e.loc, a[0]); break
        case gl.UNSIGNED_INT: gl.uniform1ui(e.loc, a[0] >>> 0); break
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null)
    gl.viewport(0, 0, dst ? dst.w : this.W, dst ? dst.h : this.H)
    gl.bindVertexArray(this.vao)
    if (uniforms.uDst && this.prog[name].quad) {
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    } else gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  // A quad over rect (target pixels) of dst, blended premultiplied over what is there.
  // Alpha in these targets is not opacity, it is the recording's mask (FS_FRAME), so
  // the colour blends the usual way and the mask is left alone, unless this is a piece
  // of Fetch's own furniture, which carves itself out of it by its own coverage.
  quad(name, dst, rect, uniforms = {}, textures = {}, blend = true, carve = false) {
    const gl = this.gl
    const u = { ...uniforms, uDst: rect, uTarget: [dst.w, dst.h] }
    if (blend) { gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE) }
    this.draw(name, dst, { ...u, uCarve: 0 }, textures)
    if (blend && carve) {
      // The same picture again, alpha only. One source alpha cannot be both: the colour
      // has to blend by the whole of it, shadow and shade included, and the mask has to
      // be carved by the covered part alone.
      gl.colorMask(false, false, false, true)
      gl.blendFuncSeparate(gl.ZERO, gl.ZERO, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA)
      this.draw(name, dst, { ...u, uCarve: 1 }, textures)
      gl.colorMask(true, true, true, true)
    }
    if (blend) gl.disable(gl.BLEND)
  }

  // A source slot ('content', 'cam'): an RGBA target with mips, and NV12 planes
  slot(name, w, h) {
    let s = this.slots[name]
    if (s && s.w === w && s.h === h) return s
    if (s) { this.free(s.rgba); this.free(s.y); this.free(s.uv) }
    s = { w, h, rgba: this.target(w, h, mipsFor(w, h)), y: null, uv: null }
    this.slots[name] = s
    return s
  }

  // NV12 bytes from ffmpeg: both planes up, converted, then mips so a Retina take scaled
  // into 1080 does not alias. lines: the file's own height, which decides the matrix.
  uploadNV12(name, buf, w, h, lines = h) {
    const gl = this.gl; const s = this.slot(name, w, h)
    if (!s.y) { s.y = this.texture(w, h, 'r8'); s.uv = this.texture(w >> 1, h >> 1, 'rg8') }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.bindTexture(gl.TEXTURE_2D, s.y.tex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, buf, 0)
    gl.bindTexture(gl.TEXTURE_2D, s.uv.tex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w >> 1, h >> 1, gl.RG, gl.UNSIGNED_BYTE, buf, w * h)
    this.draw('nv12', s.rgba, { uSize: [w, h], u601: lines < 720 ? 1 : 0 }, { uY: s.y, uUV: s.uv })
    gl.bindTexture(gl.TEXTURE_2D, s.rgba.tex); gl.generateMipmap(gl.TEXTURE_2D)
    s.ready = true
  }

  // Anything Chromium decodes (a <video>, an image): Chromium converts, we upload and mip
  uploadImage(name, img, w, h) {
    const gl = this.gl; const s = this.slot(name, w, h)
    gl.bindTexture(gl.TEXTURE_2D, s.rgba.tex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, img)
    gl.generateMipmap(gl.TEXTURE_2D)
    s.ready = true
  }

  // Which warm end the take's hairline goes to, and which way. plan.js picks it from
  // the ground a look chose, once for the whole frame; a photo is the one ground it
  // cannot read, so its mean comes off the decoded picture here, dimmed as the
  // background draws it. The mean is of the picture itself, not of the target it was
  // covered into, so the stage and the export pick the same end at any size.
  edgeOf(spec) {
    if (!spec.edge || spec.bg.kind !== 'image') return spec.edge
    const y = this.imgLuma.get(spec.bg.file)
    if (y == null) return spec.edge
    return { ...spec.edge, ...Plan.edgeFor(y * (1 - 0.7 * (spec.bg.dim || 0)) > 0.5) }
  }

  // An image background, decoded once and kept
  // (premult for a picture drawn over the take as a sprite, a clean patch)
  setImage(key, img, premult = false) {
    if (this.images.has(key)) return
    const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight
    // its mean luma, for edgeOf(): eight by eight rather than one pixel, so a photo
    // with a bright corner and a dark body is not read as its corner
    try {
      const cv = canvas(8, 8), g2 = cv.getContext('2d', { willReadFrequently: true })
      g2.drawImage(img, 0, 0, 8, 8)
      const px = g2.getImageData(0, 0, 8, 8).data
      let s = 0
      for (let i = 0; i < px.length; i += 4) s += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255
      this.imgLuma.set(key, s / 64)
    } catch {}
    const t = this.texture(w, h, 'rgba8', mipsFor(w, h))
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, t.tex)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !!premult)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, img)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.generateMipmap(gl.TEXTURE_2D)
    this.images.set(key, t)
  }

  // The still background, drawn once per plan and size, not per frame
  stillBackground(spec) {
    const bg = spec.bg
    const key = JSON.stringify([bg, this.W, this.H])
    if (key === this.bgKey) return
    this.bgKey = key
    const { W, H } = this
    if (bg.kind === 'gradient') {
      this.draw('bg', this.bg, { uRes: [W, H], uKind: 1, uC0: bg.c0, uC1: bg.c1 }, { uImg: null })
      return
    }
    if (bg.kind === 'mesh') {
      this.draw('mesh', this.bg, { uRes: [W, H], uN: bg.p.length / 3, uP: bg.p, uC: bg.c })
      return
    }
    if (bg.kind !== 'image') return
    const img = this.images.get(bg.file)
    if (!img) { this.draw('bg', this.bg, { uRes: [W, H], uKind: 1, uC0: [0.1, 0.09, 0.08], uC1: [0.1, 0.09, 0.08] }, { uImg: null }); return }
    // cover, then centre crop
    const ia = img.w / img.h, oa = W / H
    const uv = ia > oa ? [(1 - oa / ia) / 2, 0, oa / ia, 1] : [0, (1 - ia / oa) / 2, 1, ia / oa]
    // bokeh defocuses a photo the image blur left sharp, so it is a floor on the amount
    const amount = Math.max(bg.blur || 0, bg.bokeh || 0)
    if (!(amount > 0)) {
      this.draw('bg', this.bg, { uRes: [W, H], uKind: 2, uImgUV: uv, uImgLod: Math.max(0, Math.log2(img.w * uv[2] / W)), uDim: bg.dim }, { uImg: img })
      return
    }
    // blurred at a quarter of the size: a blur this soft has no detail to lose there
    const qw = Math.max(2, W >> 2), qh = Math.max(2, H >> 2)
    const a = this.target(qw, qh), b = this.target(qw, qh)
    this.draw('bg', a, { uRes: [qw, qh], uKind: 2, uImgUV: uv, uImgLod: Math.max(0, Math.log2(img.w * uv[2] / qw)), uDim: bg.dim }, { uImg: img })
    const sigma = Math.min(30, amount * 0.045 * qh)
    let soft = a
    if (bg.bokeh > 0) {
      // the same spread, through an aperture: a disc of radius 2 sigma scatters about
      // as far as a Gaussian of that sigma, so turning bokeh on changes the shape of
      // the background's blur and not how far it reaches
      const r = 2 * sigma, pre = bokehBlur(r)
      // a photo still has detail at the spacing of the aperture's taps, so it is
      // softened to that spacing first or every highlight comes back as a lattice
      if (pre > 0.5) {
        this.draw('gauss', b, { uDir: [1, 0], uSigma: pre }, { uSrc: a })
        this.draw('gauss', a, { uDir: [0, 1], uSigma: pre }, { uSrc: b })
      }
      this.draw('bokeh', b, { uRes: [qw, qh], uR: r }, { uSrc: a })
      soft = b
    } else {
      this.draw('gauss', b, { uDir: [1, 0], uSigma: sigma }, { uSrc: a })
      this.draw('gauss', a, { uDir: [0, 1], uSigma: sigma }, { uSrc: b })
    }
    this.draw('bg', this.bg, { uRes: [W, H], uKind: 2, uImgUV: [0, 0, 1, 1], uImgLod: 0, uDim: 0 }, { uImg: soft })
    this.free(a); this.free(b)
  }

  // The blurred take behind itself, per frame: shrink the cropped frame, blur it
  blurFill(spec, cropUV) {
    const { fw, fh, sigma } = spec.bg
    if (!this.fillA || this.fillA.w !== fw || this.fillA.h !== fh) {
      this.free(this.fillA); this.free(this.fillB)
      this.fillA = this.target(fw, fh); this.fillB = this.target(fw, fh)
    }
    const c = this.slots.content
    // cover the output's shape from the cropped frame, centred
    const ca = (c.w * cropUV[2]) / (c.h * cropUV[3]), oa = spec.W / spec.H
    const sub = ca > oa ? [(1 - oa / ca) / 2, 0, oa / ca, 1] : [0, (1 - ca / oa) / 2, 1, ca / oa]
    const uv = [cropUV[0] + sub[0] * cropUV[2], cropUV[1] + sub[1] * cropUV[3], sub[2] * cropUV[2], sub[3] * cropUV[3]]
    const lod = Math.max(0, Math.log2(c.w * uv[2] / fw) + 0.5)
    const bokeh = spec.bg.bokeh || 0
    if (bokeh > 0) {
      // the ground through an aperture rather than a Gaussian, over sixty by thirty-odd
      // texels: the dial shapes the blur and widens it a little. The shrink is softened
      // to the aperture's tap spacing first, as the photo backdrop's cover is.
      const r = 2 * sigma * (0.7 + 0.6 * bokeh), pre = bokehBlur(r)
      this.draw('shrink', this.fillB, { uUV: uv, uRes: [fw, fh], uLod: lod }, { uSrc: c.rgba })
      if (pre > 0.5) {
        this.draw('gauss', this.fillA, { uDir: [1, 0], uSigma: pre }, { uSrc: this.fillB })
        this.draw('gauss', this.fillB, { uDir: [0, 1], uSigma: pre }, { uSrc: this.fillA })
      }
      this.draw('bokeh', this.fillA, { uRes: [fw, fh], uR: r }, { uSrc: this.fillB })
      return
    }
    this.draw('shrink', this.fillA, { uUV: uv, uRes: [fw, fh], uLod: lod }, { uSrc: c.rgba })
    this.draw('gauss', this.fillB, { uDir: [1, 0], uSigma: sigma }, { uSrc: this.fillA })
    this.draw('gauss', this.fillA, { uDir: [0, 1], uSigma: sigma }, { uSrc: this.fillB })
  }

  /**
   * Draw one frame. spec from plan.prepare, fp from plan.framePlan.
   *   src.cropUV  where the crop sits in the content texture: [0, 0, 1, 1] when the
   *               source already cropped (ffmpeg), the crop's fractions for a <video>
   *   src.cam     draw the camera this frame; src.camUV its cover rect in its texture
   *   n           frame index, seeds the dither
   */
  render(spec, fp, src = {}) {
    const { W, H } = this
    const k = W / spec.W
    const c = this.slots.content
    if (!c || !c.ready) return false
    const cropUV = src.cropUV || [0, 0, 1, 1]
    this.stillBackground(spec)
    const kind = spec.bg.kind === 'blur' ? 2 : spec.bg.kind === 'none' ? 0 : 1
    if (kind === 2) this.blurFill(spec, cropUV)
    // the recording with its marks drawn on it, when anything is (else the source itself)
    const marked = fp.marks ? this.contentPass(spec, fp.marks, cropUV) : null
    const sh = spec.shadow
    // under a title card the framed take rises into place, or settles back
    const mv = fp.move || { k: 1, dy: 0, alpha: 1, shadow: 1 }
    const r0 = spec.rect
    const r = { w: r0.w * mv.k, h: r0.h * mv.k }
    r.x = r0.x + (r0.w - r.w) / 2; r.y = r0.y + (r0.h - r.h) / 2 + mv.dy
    const cam = spec.cam && src.cam && this.slots.cam && this.slots.cam.ready
    const edge = this.edgeOf(spec)
    const u = {
      uRes: [W, H], uBgKind: kind,
      uRect: [r.x * k, r.y * k, r.w * k, r.h * k], uRadius: spec.radius * mv.k * k,
      uTake: [mv.alpha, mv.shadow],
      uShadow: sh ? [sh.dy * k, Math.max(0.5, sh.sigma * k), sh.alpha, 1] : [0, 1, 0, 0],
      uBorder: spec.border ? [...spec.border.color, 1] : [0, 0, 0, 0], uBorderPx: spec.border ? spec.border.px * k : 0,
      uEdge: edge ? [edge.floor, edge.px * k] : [0, 0],
      uEdgeCol: edge ? edge.col : [0, 0, 0],
      uFillBand: spec.bg.band || [0, 0],
      uContentSize: marked ? marked.size : [c.w, c.h], uCropUV: marked ? [0, 0, 1, 1] : cropUV,
      uMarked: marked ? 1 : 0,
      uInner: [spec.inner.x, spec.inner.y, spec.inner.w, spec.inner.h],
      uV0: fp.view0, uV1: fp.view1, uTaps: fp.taps,
      uCam: cam ? 1 : 0,
      uVig: spec.treat ? spec.treat.vignette : 0,
      uFrame: src.n || 0, uTooth: Math.min(1, k),
    }
    if (cam) {
      u.uCamRect = [spec.cam.x * k, spec.cam.y * k, spec.cam.d * k, spec.cam.d * k]
      u.uCamUV = src.camUV || [0, 0, 1, 1]
      u.uCamRound = spec.cam.round * k
      u.uCamRing = spec.cam.ring * k
    }
    this.draw('frame', this.scene, u, { uBg: this.bg, uFill: this.fillA || this.dummy, uContent: marked ? marked.tex : c.rgba, uCamTex: cam ? this.slots.cam.rgba : this.dummy })
    if (spec.text) this.textPass(spec, fp)
    // auto level touches the take alone, so the treatment pass is told where it is: the
    // same rect the frame pass drew it in, fading with it under a title card
    const finished = spec.treat ? this.treatPass(spec, u.uRect, u.uRadius, mv.alpha) : this.scene
    const gr = spec.grain
    // The grain's cell is the export's grid scaled to what is being drawn, and below a
    // pixel it is left there: clamping it up made the editor's stage three times
    // coarser than the file. Under a pixel its strength comes down with it, because a
    // cell smaller than a pixel is what the file's own grain becomes at this size.
    const cell = gr ? gr.cell * k : 1
    this.draw('final', this.out, { uFade: fp.fade, uDither: spec.dither ? 1 : 0, uFrame: src.n || 0,
      uGrain: gr ? gr.amp * Math.min(1, cell) : 0, uCell: Math.max(0.25, cell) }, { uScene: finished })
    return true
  }

  // The grade and the lens over the finished frame (PASSES.md 13), into a target of its
  // own: one shader for everything per pixel, and a blur first for what is wide. Called
  // only while spec.treat says something shows. Returns what the final pass should read.
  treatPass(spec, takeBox, takeRadius, takeAlpha) {
    const { W, H } = this, k = W / spec.W, T = spec.treat
    const dst = this.keep('treat', W, H)
    const glowOn = T.bloom > 0 || T.halation > 0
    // haze reads the frame's mean from the deepest level and the softening shrinks off
    // one; the glow reads the frame's own pixels, so it wants no chain of its own here
    if (T.blur > 0 || T.haze > 0) this.mip(this.scene)
    // The whole frame softened. The blur comes off mip levels at a reduced size
    // (blurred()), so its cost barely moves with how soft the look asks for; a full
    // resolution Gaussian this wide would not hold the bench at 1080p60.
    const soft = T.blur > 0 ? this.blurred('soft', this.scene, [0, 0, W, H], Math.max(0.3, T.blur * k)) : null
    const glow = glowOn ? this.glowPass(T) : null
    this.draw('treat', dst, {
      uRes: [W, H], uSoftOn: soft ? 1 : 0, uMeanLod: mipsFor(W, H) - 1,
      uLevel: T.level ? [T.level[0], T.level[1], takeAlpha] : [0, 1, 0],
      uLevelBox: takeBox, uLevelRad: takeRadius,
      uGrade: [T.bright, T.contrast, T.sat],
      uShoulder: T.shoulder, uToe: T.toe,
      uTint: [...T.tint, T.tintAmount],
      uAtmos: [T.haze, T.vignette],
      uGlowMix: [T.bloom, T.halation, glow ? 1 : 0],
      uAb: T.aberration * k,
    }, { uScene: this.scene, uSoft: soft || this.dummy, uGlow: glow || this.dummy })
    return dst
  }

  // The one bright pass the glow family comes off, and its mip chain: bloom reads the
  // tight levels of it, halation the wide ones. Two effects, one blur. A quarter of the
  // frame, which is where the blur ground and the caption glass work too, and the mip
  // levels make the spread wider for nothing, which is what a wide glow needs to cost.
  glowPass(T) {
    const gw = Math.max(4, this.W >> 2), gh = Math.max(4, this.H >> 2)
    const a = this.keep('glowA', gw, gh, mipsFor(gw, gh)), b = this.keep('glowB', gw, gh)
    // its own 4x4 box of the frame per texel, thresholded before it is averaged
    this.draw('bright', a, { uMax: [this.W - 1, this.H - 1], uThresh: T.glowThresh }, { uSrc: this.scene })
    // one small Gaussian before the chain, or every level carries the square edges the
    // level above it was minified into
    this.draw('gauss', b, { uDir: [1, 0], uSigma: 1.6 }, { uSrc: a })
    this.draw('gauss', a, { uDir: [0, 1], uSigma: 1.6 }, { uSrc: b })
    this.mip(a)
    return a
  }

  // A target kept between frames by name, remade when its size changes
  keep(name, w, h, mips = 1) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h))
    let t = this.scratch.get(name)
    if (t && t.w === w && t.h === h && t.mips === mips) return t
    if (t) this.free(t)
    t = this.target(w, h, mips)
    this.scratch.set(name, t)
    return t
  }
  mip(t) { const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.generateMipmap(gl.TEXTURE_2D) }

  // A blurred copy of part of a mipmapped texture: shrunk from the mip level that keeps
  // the blur a few texels wide, then a separable Gaussian. rect in the texture's pixels,
  // sigma in them too. Returns the target holding it (name is its scratch slot).
  blurred(name, tex, rect, sigma) {
    const f = Math.min(1, 2.5 / Math.max(0.5, sigma))
    const w = Math.max(2, Math.ceil(rect[2] * f)), h = Math.max(2, Math.ceil(rect[3] * f))
    const a = this.keep(name + 'A', w, h), b = this.keep(name + 'B', w, h)
    this.draw('copy', a, { uUV: [rect[0] / tex.w, rect[1] / tex.h, rect[2] / tex.w, rect[3] / tex.h], uDst: [0, 0, w, h], uLod: Math.max(0, Math.log2(1 / f)) }, { uSrc: tex })
    const s = Math.max(0.3, sigma * f)
    this.draw('gauss', b, { uDir: [1, 0], uSigma: s }, { uSrc: a })
    this.draw('gauss', a, { uDir: [0, 1], uSigma: s }, { uSrc: b })
    return a
  }

  // A picture made with Canvas2D, uploaded once and kept by what it shows. make()
  // returns { canvas, blurred, x, y, w, h }.
  pic(key, make) {
    let p = this.pics.get(key)
    if (p) { this.pics.delete(key); this.pics.set(key, p); return p }
    const m = make()
    if (!m) return null
    const up = cv => {
      if (!cv) return null
      const gl = this.gl, t = this.texture(cv.width, cv.height, 'rgba8', mipsFor(cv.width, cv.height))
      gl.bindTexture(gl.TEXTURE_2D, t.tex)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, cv)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.generateMipmap(gl.TEXTURE_2D)
      return t
    }
    p = { tex: up(m.canvas), tex2: up(m.blurred), x: m.x, y: m.y, w: m.w, h: m.h }
    this.pics.set(key, p)
    while (this.pics.size > 96) {
      const [old, v] = this.pics.entries().next().value
      this.pics.delete(old); this.free(v.tex); if (v.tex2) this.free(v.tex2)
    }
    return p
  }
  // A picture over dst at rect (target pixels), at an opacity, crossfading to its blurred
  // copy by mix, one rectangle re-coloured by tint { x, y, w, h, colour }. carve while
  // the picture is Fetch's own rather than the recording's: a badge, the agent's cursor,
  // a caption. It takes itself out of the grade's mask and keeps the colour it was drawn.
  sprite(dst, p, rect, op = 1, mix = 0, tint = null, carve = false) {
    if (!p || !(op > 0.002)) return
    const u = { uUV: [0, 0, 1, 1], uOp: op, uMix: p.tex2 ? mix : 0, uTint: [0, 0, 0, 0], uTintCol: [1, 1, 1] }
    if (tint) { u.uTint = [tint.x, tint.y, tint.w, tint.h]; u.uTintCol = Plan.rgb(tint.colour) }
    this.quad('sprite', dst, rect, u, { uTex: p.tex, uTex2: p.tex2 || p.tex }, true, carve)
  }

  /**
   * The recording's own space: the crop copied out at its size, the Mac's pointer lifted
   * out, redactions, blur marks, lifts and spotlights, steps and the agent's cursor, in
   * that order (PASSES.md). M is marks.at() for this moment, positions in content pixels.
   * Returns { tex, size } to sample in place of the source, or null when nothing shows.
   */
  contentPass(spec, M, cropUV) {
    const any = M.erase.length || M.redact.length || M.blur.length || M.focus.length || M.steps.length || M.pointer
    if (!any) return null
    const c = this.slots.content
    const tw = Math.max(2, Math.round(c.w * cropUV[2])), th = Math.max(2, Math.round(c.h * cropUV[3]))
    const sx = tw / spec.content.w, sy = th / spec.content.h
    const S = b => [b.x * sx, b.y * sy, b.w * sx, b.h * sy]
    const A = this.keep('contA', tw, th, mipsFor(tw, th))
    const fills = M.erase.filter(e => e.fill).slice(0, 24)
    this.draw('clean', A, {
      uCropUV: cropUV, uT: [tw, th], uSrcSize: [c.w, c.h],
      uNFill: fills.length, uFill: fills.flatMap(e => S(e.fill)),
      uNRed: M.redact.length, uRed: M.redact.flatMap(S), uCell: M.redact.map(r => Math.max(2, r.cell * sx)),
    }, { uSrc: c.rgba })
    // a clean patch of the spot where the pointer rested, laid over it
    for (const e of M.erase) {
      if (!e.plate) continue
      const img = this.images.get(e.plate.file)
      if (img) this.sprite(A, { tex: img }, S(e.plate))
    }
    this.mip(A)
    if (M.blur.length) {
      for (let i = 0; i < M.blur.length; i++) {
        const b = M.blur[i], s = b.sigma * sx, F = b.feather * sx
        const m = 3 * s + F
        const x0 = Math.max(0, Math.floor(b.x * sx - m)), y0 = Math.max(0, Math.floor(b.y * sy - m))
        const x1 = Math.min(tw, Math.ceil((b.x + b.w) * sx + m)), y1 = Math.min(th, Math.ceil((b.y + b.h) * sy + m))
        const R = [x0, y0, x1 - x0, y1 - y0]
        const blur = this.blurred('blur' + i, A, R, s)
        this.quad('blurmark', A, R, { uBox: S(b), uR: b.r * sx, uF: F, uOp: b.op, uHair: (b.hair || 0) * sx }, { uSrc: blur })
      }
      this.mip(A)
    }
    let cur = A
    if (M.focus.length) {
      // the page behind, blurred by the most any of them asks
      const sig = Math.max(...M.focus.map(f => f.shape.blur || 0)) * sx
      const page = this.blurred('page', A, [0, 0, tw, th], Math.max(0.5, sig))
      const B = this.keep('contB', tw, th, mipsFor(tw, th))
      const list = M.focus.slice(0, 4)
      const aa = Math.max(0.75, sx / Math.max(1e-3, spec.content.px || 1))
      this.draw('focus', B, {
        uT: [tw, th], uN: list.length,
        uBox: list.flatMap(f => S(f.shape)),
        uA: list.flatMap(f => [f.shape.r * sx, f.level, f.shape.kind === 'lift' ? 1 : 0, f.shape.lift || 1]),
        uB: list.flatMap(f => f.shape.kind === 'lift'
          ? [f.shape.dim, f.shape.near, f.shape.farPx * sx, 1]
          : [f.shape.dim, 1, 1, Math.max(0.5, f.shape.feather * sx)]),
        uKey: list.flatMap(f => f.shape.key ? [f.shape.key.dy * sy, Math.max(0.5, f.shape.key.sigma * sx), f.shape.key.alpha, Math.max(1, f.shape.blur * 1.5 * sx)] : [0, 1, 0, 1]),
        uCon: list.flatMap(f => f.shape.contact ? [f.shape.contact.dy * sy, Math.max(0.5, f.shape.contact.sigma * sx), f.shape.contact.alpha, aa] : [0, 1, 0, aa]),
        uNudge: list.flatMap(f => f.shape.nudge ? [f.shape.nudge.dx * sx, f.shape.nudge.dy * sy] : [0, 0]),
      }, { uSrc: A, uPage: page })
      cur = B
    }
    for (const s of M.steps) this.stepSprite(cur, s, sx)
    if (M.pointer) this.pointerSprites(cur, M.pointer, spec.marks.pointer, sx, sy)
    if (cur !== A || M.steps.length || M.pointer) this.mip(cur)
    return { tex: cur, size: [tw, th] }
  }

  // A numbered step: a gold disc in a thin white ring over a soft shadow, the number in
  // rounded bold ink (overlays.js stepEvents), drawn once per size and scaled as it pops.
  // Carved out of the recording's mask: the gold is Fetch's, and a look that desaturates
  // a take has no business turning its own numbered steps grey.
  stepSprite(dst, s, k) {
    const D = s.D * k, ring = s.ring * k
    const key = `step|${s.label}|${D.toFixed(2)}|${ring.toFixed(2)}`
    const p = this.pic(key, () => {
      const R = D / 2, m = Math.ceil(D * 0.45 + ring), size = Math.ceil(D + 2 * m)
      const cv = canvas(size, size), g = cv.getContext('2d'), c = size / 2
      g.save(); g.filter = `blur(${(D * 0.16).toFixed(2)}px)`; g.fillStyle = 'rgba(0,0,0,0.36)'
      g.beginPath(); g.arc(c, c + D * 0.07, R + ring, 0, Math.PI * 2); g.fill(); g.restore()
      g.fillStyle = '#FFFFFF'; g.beginPath(); g.arc(c, c, R + ring, 0, Math.PI * 2); g.fill()
      g.fillStyle = Text.GOLD; g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.fill()
      g.font = Text.fontFor('num', D * (s.label.length > 1 ? 0.46 : 0.56)); g.textAlign = 'center'
      g.fillStyle = Text.INK
      const mm = g.measureText(s.label)
      g.fillText(s.label, c, c + D * 0.01 + (mm.actualBoundingBoxAscent - mm.actualBoundingBoxDescent) / 2)
      return { canvas: cv, x: -c, y: -c, w: size, h: size }
    })
    const w = p.w * s.scale
    this.sprite(dst, p, [s.cx * k - w / 2, s.cy * k - w / 2, w, w], s.op, 0, null, true)
  }

  // The agent's cursor (pointer.js): a gold ripple on each click, the near-black arrow
  // with its light edge and soft shadow, pressing on a click, the Biscuit tag and badge.
  // Carved out of the mask like the steps: none of it was on the screen that was recorded.
  pointerSprites(dst, P, plan, sx, sy) {
    const k = sx, size = plan.size * k, u = plan.unit * k
    const bord = Math.max(0.8, 1.5 * plan.unit) * k
    const Pointer = require('../pointer')
    const ak = size / Pointer.ARROW_H
    for (const r of P.ripples) {
      if (!plan.rippleOn) break
      const R = plan.ripple * k, ringW = Math.max(1.5, plan.size * 0.07) * k
      const p = this.pic(`ripple|${R.toFixed(1)}|${ringW.toFixed(2)}`, () => {
        const m = Math.ceil(ringW * 2), n = Math.ceil(2 * R + 2 * m), cv = canvas(n, n), g = cv.getContext('2d')
        g.filter = `blur(${(ringW * 0.6).toFixed(2)}px)`
        g.fillStyle = 'rgba(240,169,60,0.12)'; g.beginPath(); g.arc(n / 2, n / 2, R, 0, Math.PI * 2); g.fill()
        g.strokeStyle = 'rgba(240,169,60,0.81)'; g.lineWidth = ringW; g.stroke()
        return { canvas: cv, x: -n / 2, y: -n / 2, w: n, h: n }
      })
      const sc = 0.3 + 0.7 * r.p, w = p.w * sc
      this.sprite(dst, p, [r.x * sx - w / 2, r.y * sy - w / 2, w, w], (1 - r.p) * P.op, 0, null, true)
    }
    const arrow = this.pic(`arrow|${size.toFixed(2)}|${bord.toFixed(2)}`, () => {
      const m = Math.ceil(4 * ak + bord * 2), wd = Math.ceil(11 * ak + 2 * m), ht = Math.ceil(Pointer.ARROW_H * ak + 2 * m)
      const cv = canvas(wd, ht), g = cv.getContext('2d')
      const path = () => { g.beginPath(); Pointer.ARROW.forEach(([x, y], i) => (i ? g.lineTo : g.moveTo).call(g, m + x * ak, m + y * ak)); g.closePath() }
      g.lineJoin = 'round'
      g.save(); g.filter = `blur(${(2.2 * ak).toFixed(2)}px)`; g.translate(0, 1.3 * ak); path()
      g.fillStyle = g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = bord * 2; g.stroke(); g.fill(); g.restore()
      path(); g.strokeStyle = '#FBFAF8'; g.lineWidth = bord * 2; g.stroke(); g.fillStyle = '#0A0908'; g.fill()
      return { canvas: cv, x: -m, y: -m, w: wd, h: ht }
    })
    const x = P.x * sx, y = P.y * sy
    const aw = arrow.w * P.press, ah = arrow.h * P.press
    this.sprite(dst, arrow, [x + arrow.x * P.press, y + arrow.y * P.press, aw, ah], P.op, 0, null, true)
    // the tag, tucked under the badge's edge
    if (P.tag && P.tag.op > 0.004) {
      const br = plan.br * k, tagH = plan.tagH * k, tagFs = plan.tagFs * k
      const gap = tagH * 0.24, padR = tagH * 0.42, tuck = br * 0.5
      const font = Text.fontFor('num', tagFs)
      const textW = this.measure(Pointer.TAG.text, tagFs, 'num')
      const tagW = br + gap + textW + padR
      const left = P.tag.left
      const p = this.pic(`tag|${left}|${tagH.toFixed(2)}|${font}`, () => {
        const m = Math.ceil(tagH * 0.5), wd = Math.ceil(tagW + tuck + 2 * m), ht = Math.ceil(tagH + 2 * m)
        const cv = canvas(wd, ht), g = cv.getContext('2d')
        const pill = dy => { g.beginPath(); g.roundRect(m, m + dy, tagW + tuck, tagH, tagH / 2) }
        g.save(); g.filter = `blur(${(2.4 * ak).toFixed(2)}px)`; g.fillStyle = 'rgba(0,0,0,0.37)'; pill(1.2 * ak); g.fill(); g.restore()
        pill(0); g.fillStyle = Text.GOLD; g.fill(); g.strokeStyle = '#FBFAF8'; g.lineWidth = bord; g.stroke()
        g.font = font; g.fillStyle = Text.INK; g.letterSpacing = `${tagFs * 0.01}px`
        g.textAlign = left ? 'right' : 'left'
        const mm = g.measureText('Bg'), mid = m + tagH / 2 + (mm.actualBoundingBoxAscent - mm.actualBoundingBoxDescent) / 2
        g.fillText(Pointer.TAG.text, left ? m + tagW - br - gap : m + tuck + br + gap, mid)
        return { canvas: cv, x: -m, y: -m, w: wd, h: ht }
      })
      const bx = left ? Pointer.BADGE.cx * size - tagW : Pointer.BADGE.cx * size - tuck
      const by = Pointer.BADGE.cy * size - tagH / 2
      this.sprite(dst, p, [x + bx + p.x, y + by + p.y, p.w, p.h], P.tag.op * P.op, 0, null, true)
    }
    if (P.badge > 0.004) {
      const d = plan.d * k, img = this.imgEls.get('badge')
      const p = img && this.pic(`badge|${d.toFixed(2)}`, () => {
        const m = Math.ceil(d * 0.35), n = Math.ceil(d + 2 * m), cv = canvas(n, n), g = cv.getContext('2d')
        g.save(); g.filter = `blur(${Math.max(1, d * 0.08).toFixed(2)}px)`; g.fillStyle = 'rgba(0,0,0,0.42)'
        g.beginPath(); g.arc(n / 2, n / 2 + d * 0.06, d / 2, 0, Math.PI * 2); g.fill(); g.restore()
        g.save(); g.beginPath(); g.arc(n / 2, n / 2, d / 2, 0, Math.PI * 2); g.clip()
        g.drawImage(img, n / 2 - d / 2, n / 2 - d / 2, d, d); g.restore()
        return { canvas: cv, x: -n / 2, y: -n / 2, w: n, h: n }
      })
      if (p) this.sprite(dst, p, [x + Pointer.BADGE.cx * size + p.x, y + Pointer.BADGE.cy * size + p.y, p.w, p.h], P.badge * P.op, 0, null, true)
    }
  }

  // Over the finished frame: a title card's ground, the glass under captions, then every
  // caption, title, lower third and label (text.js). The words and the card's scrim are
  // Fetch's own, so they carve themselves out of the grade's mask and keep the colour
  // they were drawn at: Fetch does not speak in grey. The caption glass does not carve.
  // It is the frame's own light through a feathered patch, so it belongs to whatever it
  // is lying on, and a grade that stopped at its edge would put an ungraded rectangle
  // over the take. A closing card's scrim carries a blurred copy of the frame under it
  // and carves by the whole of its opacity rather than the scrim's share of it, which
  // is a rounding in favour of the colour the card was drawn at: at three quarters scrim
  // and a blur already half desaturated there is little of the picture left to grade.
  textPass(spec, fp) {
    const T = Text.textAt(spec.text, fp.t, this.measure)
    if (!T.items.length && !T.frost.length && !T.ground) return
    const { W, H } = this, k = W / spec.W
    if (T.ground || T.frost.length) this.mip(this.scene)
    if (T.ground) {
      let blur = null
      if (T.ground.blurred) {
        // about 130 px wide at 1080, from a twenty-fourth of the frame
        const fh = Math.max(4, Math.round(H / 24))
        blur = this.blurred('ground', this.scene, [0, 0, W, H], fh * 0.12 * (H / fh))
      }
      const gl = this.gl
      gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA)
      this.draw('ground', this.scene, { uRes: [W, H], uBlurred: blur ? 1 : 0, uOp: T.ground.op }, { uBlur: blur || this.dummy })
      gl.disable(gl.BLEND)
      if (T.frost.length) this.mip(this.scene)
    }
    if (T.frost.length) {
      const blur = this.blurred('frost', this.scene, [0, 0, W, H], H * 0.009)
      for (const f of T.frost) {
        const m = f.feather * 2.6 * k
        this.quad('frost', this.scene, [f.x * k - m, f.y * k - m, f.w * k + 2 * m, f.h * k + 2 * m],
          { uRes: [W, H], uBox: [f.x * k, f.y * k, f.w * k, f.h * k], uR: f.r * k, uF: f.feather * k, uOp: f.op,
            uScrim: Plan.rgb(f.scrim || '#0A0908'), uScrimA: f.scrimA || 0 }, { uBlur: blur })
      }
    }
    for (const it of T.items) {
      // the raster carries its own place on the frame (rasterItem rounds the item's
      // bounds to whole pixels and keeps the offset), so the place is part of its key:
      // the same phrase at the same size sits in the band on one look and over the take
      // on another, and a cache that knew only the words handed the second one the
      // first one's position
      const p = this.pic(`${it.key}|${k.toFixed(4)}|${Math.round(it.bounds.x * k)},${Math.round(it.bounds.y * k)}`,
        () => Text.rasterItem(it, k, canvas))
      if (!p) continue
      const dx = (it.dx || 0) * k, dy = (it.dy || 0) * k
      const tint = it.tint ? { x: it.tint.x * k + dx, y: it.tint.y * k + dy, w: it.tint.w * k, h: it.tint.h * k, colour: it.tint.colour } : null
      this.sprite(this.scene, p, [p.x + dx, p.y + dy, p.w, p.h], it.op, it.blurMax ? Math.min(1, (it.blur || 0) / it.blurMax) : 0, tint, true)
    }
  }

  present() { this.draw('present', null, { uRes: [this.W, this.H] }, { uSrc: this.out }) }
  pack() { this.draw('pack', this.packed, { uH: this.H, uW: this.W }, { uSrc: this.out }) }

  // Synchronous RGBA read of the finished frame, for tests
  readRGBA(dst) {
    const gl = this.gl; dst = dst || new Uint8Array(this.W * this.H * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.out.fbo)
    gl.readPixels(0, 0, this.W, this.H, gl.RGBA, gl.UNSIGNED_BYTE, dst)
    return dst
  }

  destroy() {
    const e = this.gl.getExtension('WEBGL_lose_context')
    if (e) e.loseContext()
  }
}

// Asynchronous readback: readPixels into a PIXEL_PACK_BUFFER, fence, and map only once
// the fence has signalled, so the CPU never stalls on the GPU (a synchronous read runs
// at 73 to 111 fps; this ring at over 3000).
class Readback {
  constructor(comp, ring = 3) {
    const gl = comp.gl; this.comp = comp; this.gl = gl
    this.w = comp.packed.w; this.h = comp.packed.h
    this.bytes = this.w * this.h * 4
    this.slots = []
    for (let i = 0; i < ring; i++) {
      const b = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b)
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.bytes, gl.STREAM_READ)
      this.slots.push({ buf: b, fence: null, tag: null })
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    this.head = 0; this.inflight = []
  }
  get full() { return this.inflight.length >= this.slots.length }
  get pending() { return this.inflight.length }
  issue(tag) {
    const gl = this.gl; const s = this.slots[this.head]; this.head = (this.head + 1) % this.slots.length
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.comp.packed.fbo)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.buf)
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    s.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); s.tag = tag
    gl.flush()
    this.inflight.push(s)
  }
  async collect(dst, yieldFn) {
    const gl = this.gl; const s = this.inflight.shift()
    while (gl.clientWaitSync(s.fence, 0, 0) === gl.TIMEOUT_EXPIRED) await yieldFn()
    gl.deleteSync(s.fence); s.fence = null
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.buf)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, dst, 0, this.bytes)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    return s.tag
  }
  destroy() { for (const s of this.slots) this.gl.deleteBuffer(s.buf) }
}

module.exports = { Compositor, Readback }
