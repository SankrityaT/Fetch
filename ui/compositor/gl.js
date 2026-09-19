// The compositor: draws one frame of an edit from its plan (ui/compositor/plan.js) in
// WebGL2. The editor's stage and the export window run this same code; they differ
// only in where the take's pixels come from (a <video> element, or NV12 bytes from
// ffmpeg) and where the finished frame goes (a canvas, or packed NV12 read back for
// the encoder). Passes, in order, are listed in PASSES.md.
//
// Every framebuffer stores its image top row first (row 0 is the top), so read back
// bytes are already in file order and only the present pass flips. No pass reads the
// previous frame: motion blur is analytic, dither is seeded by frame index, so any
// frame can be drawn alone.
'use strict'
const Text = require('./text')
const Marks = require('./marks')

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

// A still background: a two-colour linear gradient corner to corner (a solid colour is
// a gradient from a colour to itself), or an image covering the frame, dimmed.
const FS_BG = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform int uKind; uniform vec3 uC0, uC1;
uniform sampler2D uImg; uniform vec4 uImgUV; uniform float uImgLod, uDim; out vec4 o;
void main(){
  vec2 p = gl_FragCoord.xy;
  if (uKind == 1) {
    // ffmpeg's gradients source: c0 at the top left, c1 at the bottom right, mixed in sRGB
    float t = clamp(dot(p, uRes) / dot(uRes, uRes), 0.0, 1.0);
    o = vec4(mix(uC0, uC1, t), 1.0);
  } else {
    vec2 uv = uImgUV.xy + (p / uRes) * uImgUV.zw;
    o = vec4(textureLod(uImg, uv, uImgLod).rgb * (1.0 - 0.7 * uDim), 1.0);
  }
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
const FS_FRAME = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform int uBgKind;                 // 0 none, 1 still, 2 blurred take
uniform sampler2D uBg, uFill;
uniform vec4 uRect; uniform float uRadius;
uniform vec2 uTake;                  // the take's opacity and its shadow's (a title card's reveal)
uniform vec4 uShadow;                // dy, sigma, alpha, on
uniform vec4 uBorder; uniform float uBorderPx;
uniform sampler2D uContent; uniform vec2 uContentSize; uniform vec4 uCropUV, uInner;
uniform vec4 uV0, uV1; uniform int uTaps;
uniform int uCam; uniform sampler2D uCamTex; uniform vec4 uCamRect, uCamUV; uniform float uCamRound, uCamRing;
out vec4 o;

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
// (the classic lutyuv), a cos^4 vignette on luma (ffmpeg's vignette at 0.4), a still grain.
vec3 fillAt(vec2 p){
  vec3 c = bspline(uFill, p / uRes);
  vec3 k = vec3(0.2126, 0.7152, 0.0722);
  float y = dot(c, k), cb = (c.b - y) / 1.8556, cr = (c.r - y) / 1.5748;
  y *= 0.3; cb *= 0.8; cr *= 0.8;
  float dn = length(p - uRes * 0.5) / length(uRes * 0.5);
  float cv = cos(0.4 * dn); cv = cv * cv * cv * cv;
  float yc = (16.0 + 219.0 * y) * cv;
  y = (yc - 16.0) / 219.0;
  y += (float(hash(uint(p.x) * 1973u + uint(p.y) * 9277u) & 255u) / 255.0 - 0.5) * 6.0 / 219.0;
  return clamp(vec3(y + 1.5748 * cr, y - 0.187324 * cb - 0.468124 * cr, y + 1.8556 * cb), 0.0, 1.0);
}

vec3 sampleView(vec2 local, vec4 v, float lod){
  vec2 q = uInner.xy + local * uInner.zw;          // the window's margin trimmed off
  vec2 f = v.xy + q * v.zw;                        // what the zoom shows
  // never past the crop's edge, at any mip level: a <video> holds the whole take, and
  // what the crop removed must not bleed in where the export's cropped decode has none
  vec2 h = 0.5 * exp2(lod) / uContentSize;
  return textureLod(uContent, clamp(uCropUV.xy + f * uCropUV.zw, uCropUV.xy + h, uCropUV.xy + uCropUV.zw - h), lod).rgb;
}

void main(){
  vec2 p = gl_FragCoord.xy;
  vec3 col = vec3(0.0);
  if (uBgKind == 1) col = texelFetch(uBg, ivec2(p), 0).rgb;
  else if (uBgKind == 2) col = fillAt(p);
  vec2 lo = uRect.xy, hi = uRect.xy + uRect.zw;
  if (uShadow.w > 0.5) {
    float sh = roundedBoxShadow(lo + vec2(0.0, uShadow.x), hi + vec2(0.0, uShadow.x), p, uShadow.y, uRadius);
    col *= 1.0 - uShadow.z * uTake.y * clamp(sh, 0.0, 1.0);
  }
  float d = uRadius > 0.0 ? sdRound(p - (lo + hi) * 0.5, uRect.zw * 0.5, uRadius)
                          : max(max(lo.x - p.x, p.x - hi.x), max(lo.y - p.y, p.y - hi.y));
  float cover = clamp(0.5 - d, 0.0, 1.0);
  if (cover > 0.0) {
    vec2 local = (p - lo) / uRect.zw;
    // explicit level: the zoom says exactly how far the take is minified, and the
    // sample sits in non-uniform flow where implicit derivatives are undefined
    float lod = max(0.0, log2(uContentSize.x * uCropUV.z * uInner.z * min(uV0.z, uV1.z) / uRect.z));
    vec3 c = vec3(0.0);
    for (int i = 0; i < 32; i++) { if (i >= uTaps) break;
      float s = uTaps == 1 ? 0.0 : float(i) / float(uTaps - 1);
      c += sampleView(local, mix(uV0, uV1, s), lod); }
    c /= float(uTaps);
    if (uBorderPx > 0.0) c = mix(c, uBorder.rgb, clamp(d + uBorderPx + 0.5, 0.0, 1.0) * uBorder.a);
    col = mix(col, c, cover * uTake.x);
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
      if (uCamRing > 0.0) c = mix(c, vec3(0.984, 0.980, 0.973), clamp(cd + uCamRing + 0.5, 0.0, 1.0));
      col = mix(col, c, ccov);
    }
  }
  o = vec4(col, 1.0);
}`

// Last: the fade to and from black over the whole frame, then a triangular dither of
// one 8-bit step seeded by frame, so a dark gradient does not band once encoded.
const FS_FINAL = `#version 300 es
precision highp float;
uniform sampler2D uScene; uniform float uFade; uniform int uDither; uniform uint uFrame; out vec4 o;
uint hash(uint x){ x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float rnd(uvec2 p, uint salt){ return float(hash(p.x + hash(p.y + hash(uFrame * 7u + salt)))) / 4294967295.0; }
void main(){
  vec2 p = gl_FragCoord.xy; uvec2 ip = uvec2(p);
  vec3 c = texelFetch(uScene, ivec2(p), 0).rgb * uFade;
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

// A blur mark laid back through a round-cornered mask feathered over its edge, easing in
// and out: the blurred patch (uSrc, the box and its margin) at the mark's opacity
const FS_BLURMARK = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec4 uDst, uBox; uniform float uR, uF, uOp; out vec4 o;
float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }
void main(){
  vec2 p = gl_FragCoord.xy;
  vec3 c = texture(uSrc, (p - uDst.xy) / uDst.zw).rgb;
  float d = sdRound(p - (uBox.xy + uBox.zw * 0.5), uBox.zw * 0.5, uR);
  float s = clamp(0.5 - d / uF, 0.0, 1.0); s = s * s * (3.0 - 2.0 * s);
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
uniform sampler2D uTex, uTex2; uniform vec4 uDst, uUV; uniform float uOp, uMix;
uniform vec4 uTint; uniform vec3 uTintCol; out vec4 o;
void main(){
  vec2 p = gl_FragCoord.xy, uv = uUV.xy + ((p - uDst.xy) / uDst.zw) * uUV.zw;
  vec4 c = texture(uTex, uv);
  if (uMix > 0.0) c = mix(c, texture(uTex2, uv), uMix);
  if (uTint.z > 0.0 && p.x >= uTint.x && p.y >= uTint.y && p.x <= uTint.x + uTint.z && p.y <= uTint.y + uTint.w) c.rgb = uTintCol * c.a;
  o = c * uOp;
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

// Frosted glass under a caption: the blurred frame through a feathered rounded patch
const FS_FROST = `#version 300 es
precision highp float;
uniform sampler2D uBlur; uniform vec2 uRes; uniform vec4 uBox; uniform float uR, uF, uOp; out vec4 o;
float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }
void main(){
  vec2 p = gl_FragCoord.xy;
  float d = sdRound(p - (uBox.xy + uBox.zw * 0.5), uBox.zw * 0.5, uR);
  float s = clamp(0.5 - d / (2.4 * uF), 0.0, 1.0); s = s * s * (3.0 - 2.0 * s);
  o = vec4(texture(uBlur, p / uRes).rgb, 1.0) * s * uOp;
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
    for (const [k, fs] of Object.entries({ nv12: FS_NV12, bg: FS_BG, shrink: FS_SHRINK, gauss: FS_GAUSS,
      frame: FS_FRAME, final: FS_FINAL, present: FS_PRESENT, pack: FS_PACK,
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

  // A quad over rect (target pixels) of dst, blended premultiplied over what is there
  quad(name, dst, rect, uniforms = {}, textures = {}, blend = true) {
    const gl = this.gl
    if (blend) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) }
    this.draw(name, dst, { ...uniforms, uDst: rect, uTarget: [dst.w, dst.h] }, textures)
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

  // An image background, decoded once and kept
  // (premult for a picture drawn over the take as a sprite, a clean patch)
  setImage(key, img, premult = false) {
    if (this.images.has(key)) return
    const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight
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
    if (bg.kind !== 'image') return
    const img = this.images.get(bg.file)
    if (!img) { this.draw('bg', this.bg, { uRes: [W, H], uKind: 1, uC0: [0.1, 0.09, 0.08], uC1: [0.1, 0.09, 0.08] }, { uImg: null }); return }
    // cover, then centre crop
    const ia = img.w / img.h, oa = W / H
    const uv = ia > oa ? [(1 - oa / ia) / 2, 0, oa / ia, 1] : [0, (1 - ia / oa) / 2, 1, ia / oa]
    if (!(bg.blur > 0)) {
      this.draw('bg', this.bg, { uRes: [W, H], uKind: 2, uImgUV: uv, uImgLod: Math.max(0, Math.log2(img.w * uv[2] / W)), uDim: bg.dim }, { uImg: img })
      return
    }
    // blurred at a quarter of the size: a blur this soft has no detail to lose there
    const qw = Math.max(2, W >> 2), qh = Math.max(2, H >> 2)
    const a = this.target(qw, qh), b = this.target(qw, qh)
    this.draw('bg', a, { uRes: [qw, qh], uKind: 2, uImgUV: uv, uImgLod: Math.max(0, Math.log2(img.w * uv[2] / qw)), uDim: bg.dim }, { uImg: img })
    const sigma = Math.min(30, bg.blur * 0.045 * qh)
    this.draw('gauss', b, { uDir: [1, 0], uSigma: sigma }, { uSrc: a })
    this.draw('gauss', a, { uDir: [0, 1], uSigma: sigma }, { uSrc: b })
    this.draw('bg', this.bg, { uRes: [W, H], uKind: 2, uImgUV: [0, 0, 1, 1], uImgLod: 0, uDim: 0 }, { uImg: a })
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
    const u = {
      uRes: [W, H], uBgKind: kind,
      uRect: [r.x * k, r.y * k, r.w * k, r.h * k], uRadius: spec.radius * mv.k * k,
      uTake: [mv.alpha, mv.shadow],
      uShadow: sh ? [sh.dy * k, Math.max(0.5, sh.sigma * k), sh.alpha, 1] : [0, 1, 0, 0],
      uBorder: spec.border ? [...spec.border.color, 1] : [0, 0, 0, 0], uBorderPx: spec.border ? spec.border.px * k : 0,
      uContentSize: marked ? marked.size : [c.w, c.h], uCropUV: marked ? [0, 0, 1, 1] : cropUV,
      uInner: [spec.inner.x, spec.inner.y, spec.inner.w, spec.inner.h],
      uV0: fp.view0, uV1: fp.view1, uTaps: fp.taps,
      uCam: cam ? 1 : 0,
    }
    if (cam) {
      u.uCamRect = [spec.cam.x * k, spec.cam.y * k, spec.cam.d * k, spec.cam.d * k]
      u.uCamUV = src.camUV || [0, 0, 1, 1]
      u.uCamRound = spec.cam.round * k
      u.uCamRing = spec.cam.ring * k
    }
    this.draw('frame', this.scene, u, { uBg: this.bg, uFill: this.fillA || this.dummy, uContent: marked ? marked.tex : c.rgba, uCamTex: cam ? this.slots.cam.rgba : this.dummy })
    if (spec.text) this.textPass(spec, fp)
    this.draw('final', this.out, { uFade: fp.fade, uDither: spec.dither ? 1 : 0, uFrame: src.n || 0 }, { uScene: this.scene })
    return true
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
  // copy by mix, one rectangle re-coloured by tint { x, y, w, h, colour }
  sprite(dst, p, rect, op = 1, mix = 0, tint = null) {
    if (!p || !(op > 0.002)) return
    const u = { uUV: [0, 0, 1, 1], uOp: op, uMix: p.tex2 ? mix : 0, uTint: [0, 0, 0, 0], uTintCol: [1, 1, 1] }
    if (tint) { u.uTint = [tint.x, tint.y, tint.w, tint.h]; u.uTintCol = require('./plan').rgb(tint.colour) }
    this.quad('sprite', dst, rect, u, { uTex: p.tex, uTex2: p.tex2 || p.tex })
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
        this.quad('blurmark', A, R, { uBox: S(b), uR: b.r * sx, uF: F, uOp: b.op }, { uSrc: blur })
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
  // rounded bold ink (overlays.js stepEvents), drawn once per size and scaled as it pops
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
    this.sprite(dst, p, [s.cx * k - w / 2, s.cy * k - w / 2, w, w], s.op)
  }

  // The agent's cursor (pointer.js): a gold ripple on each click, the near-black arrow
  // with its light edge and soft shadow, pressing on a click, the Biscuit tag and badge
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
      this.sprite(dst, p, [r.x * sx - w / 2, r.y * sy - w / 2, w, w], (1 - r.p) * P.op)
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
    this.sprite(dst, arrow, [x + arrow.x * P.press, y + arrow.y * P.press, aw, ah], P.op)
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
      this.sprite(dst, p, [x + bx + p.x, y + by + p.y, p.w, p.h], P.tag.op * P.op)
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
      if (p) this.sprite(dst, p, [x + Pointer.BADGE.cx * size + p.x, y + Pointer.BADGE.cy * size + p.y, p.w, p.h], P.badge * P.op)
    }
  }

  // Over the finished frame: a title card's ground, the glass under captions, then every
  // caption, title, lower third and label (text.js)
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
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      this.draw('ground', this.scene, { uRes: [W, H], uBlurred: blur ? 1 : 0, uOp: T.ground.op }, { uBlur: blur || this.dummy })
      gl.disable(gl.BLEND)
      if (T.frost.length) this.mip(this.scene)
    }
    if (T.frost.length) {
      const blur = this.blurred('frost', this.scene, [0, 0, W, H], H * 0.009)
      for (const f of T.frost) {
        const m = f.feather * 2.6 * k
        this.quad('frost', this.scene, [f.x * k - m, f.y * k - m, f.w * k + 2 * m, f.h * k + 2 * m],
          { uRes: [W, H], uBox: [f.x * k, f.y * k, f.w * k, f.h * k], uR: f.r * k, uF: f.feather * k, uOp: f.op }, { uBlur: blur })
      }
    }
    for (const it of T.items) {
      const p = this.pic(it.key + '|' + k.toFixed(4), () => Text.rasterItem(it, k, canvas))
      if (!p) continue
      const dx = (it.dx || 0) * k, dy = (it.dy || 0) * k
      const tint = it.tint ? { x: it.tint.x * k + dx, y: it.tint.y * k + dy, w: it.tint.w * k, h: it.tint.h * k, colour: it.tint.colour } : null
      this.sprite(this.scene, p, [p.x + dx, p.y + dy, p.w, p.h], it.op, it.blurMax ? Math.min(1, (it.blur || 0) / it.blurMax) : 0, tint)
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
