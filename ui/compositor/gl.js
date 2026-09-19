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
    col *= 1.0 - uShadow.z * clamp(sh, 0.0, 1.0);
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
    col = mix(col, c, cover);
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

const mipsFor = (w, h) => Math.floor(Math.log2(Math.max(w, h))) + 1

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
      frame: FS_FRAME, final: FS_FINAL, present: FS_PRESENT, pack: FS_PACK })) this.prog[k] = this.program(fs)
    this.vao = gl.createVertexArray()
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
    this.scene = this.target(W, H)
    this.out = this.target(W, H)
    this.packed = this.target(Math.ceil(W / 4), (H * 3) >> 1)
    this.bgKey = null
  }

  program(fs) {
    const gl = this.gl
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s }
    const p = gl.createProgram()
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = { loc: gl.getUniformLocation(p, info.name), type: info.type } }
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
      switch (e.type) {
        case gl.FLOAT: gl.uniform1f(e.loc, a[0]); break
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
    gl.drawArrays(gl.TRIANGLES, 0, 3)
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
  setImage(key, img) {
    if (this.images.has(key)) return
    const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight
    const t = this.texture(w, h, 'rgba8', mipsFor(w, h))
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, t.tex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, img)
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
    const r = spec.rect, sh = spec.shadow
    const cam = spec.cam && src.cam && this.slots.cam && this.slots.cam.ready
    const u = {
      uRes: [W, H], uBgKind: kind,
      uRect: [r.x * k, r.y * k, r.w * k, r.h * k], uRadius: spec.radius * k,
      uShadow: sh ? [sh.dy * k, Math.max(0.5, sh.sigma * k), sh.alpha, 1] : [0, 1, 0, 0],
      uBorder: spec.border ? [...spec.border.color, 1] : [0, 0, 0, 0], uBorderPx: spec.border ? spec.border.px * k : 0,
      uContentSize: [c.w, c.h], uCropUV: cropUV,
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
    this.draw('frame', this.scene, u, { uBg: this.bg, uFill: this.fillA || this.dummy, uContent: c.rgba, uCamTex: cam ? this.slots.cam.rgba : this.dummy })
    this.draw('final', this.out, { uFade: fp.fade, uDither: spec.dither ? 1 : 0, uFrame: src.n || 0 }, { uScene: this.scene })
    return true
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
