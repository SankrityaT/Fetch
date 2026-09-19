// Spike compositor: a realistic pass set in WebGL2. Every framebuffer stores the image
// top row first (row 0 = top), so readPixels bytes are already in file order and only
// the present-to-canvas pass flips. No pass reads the previous frame: grain and dither
// are seeded by frame index, motion blur is analytic, so any frame can render alone.
'use strict';

const VS = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

// NV12 to RGB. Matrix and range are uniforms so the parity test can try what Chromium
// assumes for untagged takes. Chroma is bilinear and centre-sited, which is what
// Chromium does (max 1 LSB against a <video> frame; left-siting gave 119).
const FS_NV12 = `#version 300 es
precision highp float;
uniform sampler2D uY, uUV; uniform vec2 uSize; uniform mat3 uM; uniform vec3 uOff; uniform vec3 uScale;
uniform vec2 uChromaShift; uniform int uChromaNearest;
out vec4 o;
void main(){
  vec2 p = gl_FragCoord.xy;
  float y = texelFetch(uY, ivec2(p), 0).r;
  vec2 c = uChromaNearest == 1 ? texelFetch(uUV, ivec2(p) / 2, 0).rg : texture(uUV, (p + uChromaShift) / uSize).rg;
  vec3 yuv = (vec3(y, c) - uOff) * uScale;
  o = vec4(clamp(uM * yuv, 0.0, 1.0), 1.0);
}`;

// Background: a warm two-light gradient, rendered once and cached.
const FS_BG = `#version 300 es
precision highp float;
uniform vec2 uRes; out vec4 o;
void main(){
  vec2 uv = gl_FragCoord.xy / uRes; uv.x *= uRes.x / uRes.y;
  vec3 base = vec3(0.075, 0.052, 0.040);
  vec3 gold = vec3(0.78, 0.47, 0.16), ember = vec3(0.45, 0.18, 0.10);
  float a = exp(-3.2 * dot(uv - vec2(0.15, 0.05), uv - vec2(0.15, 0.05)));
  float b = exp(-2.4 * dot(uv - vec2(1.65, 1.05), uv - vec2(1.65, 1.05)));
  o = vec4(base + gold * a * 0.55 + ember * b * 0.6, 1.0);
}`;

// Frame pass: background, analytic rounded-box shadow (Evan Wallace's closed form),
// SDF rounded mask with a 1 px AA edge, hairline border, zoomed content with analytic
// motion blur (taps spread across a 180 degree shutter).
const FS_FRAME = `#version 300 es
precision highp float;
uniform sampler2D uBg, uContent;
uniform vec4 uRect; uniform float uRadius; uniform vec3 uShadow; // offsetY, sigma, opacity
uniform vec3 uZ0, uZ1; uniform int uTaps; uniform vec2 uContentSize;
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
// Explicit LOD: the content sample sits inside non-uniform control flow, where implicit
// derivatives are undefined, and the zoom already tells us the exact minification.
vec3 sampleZoom(vec2 local, vec3 z){ vec2 uv = z.yz + (local - 0.5) / z.x;
  float lod = max(0.0, log2(uContentSize.x / (uRect.z * z.x)));
  return textureLod(uContent, uv, lod).rgb; }
void main(){
  vec2 p = gl_FragCoord.xy;
  vec3 col = texelFetch(uBg, ivec2(p), 0).rgb;
  vec2 lo = uRect.xy, hi = uRect.xy + uRect.zw;
  float sh = roundedBoxShadow(lo + vec2(0.0, uShadow.x), hi + vec2(0.0, uShadow.x), p, uShadow.y, uRadius);
  col *= 1.0 - uShadow.z * sh;
  float d = sdRound(p - (lo + hi) * 0.5, uRect.zw * 0.5, uRadius);
  float cover = clamp(0.5 - d, 0.0, 1.0);
  if (cover > 0.0) {
    vec2 local = (p - lo) / uRect.zw;
    vec3 c = vec3(0.0);
    for (int i = 0; i < 16; i++) { if (i >= uTaps) break;
      float s = (float(i) + 0.5) / float(uTaps); c += sampleZoom(local, mix(uZ0, uZ1, s)); }
    c /= float(uTaps);
    float edge = clamp(1.0 - abs(d + 0.75), 0.0, 1.0);
    c = mix(c, vec3(1.0), edge * 0.10);
    col = mix(col, c, cover);
  }
  o = vec4(col, 1.0);
}`;

// Bloom: soft-knee bright pass with a 13-tap downsample, then separable Gaussian.
const FS_BRIGHT = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uThresh; out vec4 o;
void main(){
  vec2 uv = gl_FragCoord.xy * 2.0 * uTexel;
  vec3 c = texture(uSrc, uv).rgb * 0.5;
  c += (texture(uSrc, uv + uTexel * vec2(-1,-1)).rgb + texture(uSrc, uv + uTexel * vec2(1,-1)).rgb
      + texture(uSrc, uv + uTexel * vec2(-1,1)).rgb + texture(uSrc, uv + uTexel * vec2(1,1)).rgb) * 0.125;
  float l = max(c.r, max(c.g, c.b)); float k = clamp((l - uThresh) / 0.25, 0.0, 1.0);
  o = vec4(c * k * k, 1.0);
}`;
const FS_DOWN = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uTexel; out vec4 o;
void main(){ vec2 uv = gl_FragCoord.xy * 2.0 * uTexel;
  o = vec4((texture(uSrc, uv + uTexel * vec2(-0.5,-0.5)).rgb + texture(uSrc, uv + uTexel * vec2(0.5,-0.5)).rgb
          + texture(uSrc, uv + uTexel * vec2(-0.5,0.5)).rgb + texture(uSrc, uv + uTexel * vec2(0.5,0.5)).rgb) * 0.25, 1.0); }`;
const FS_BLUR = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uDir; uniform vec2 uRes; out vec4 o;
void main(){ vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c = texture(uSrc, uv).rgb * 0.2270270;
  c += (texture(uSrc, uv + uDir * 1.3846153).rgb + texture(uSrc, uv - uDir * 1.3846153).rgb) * 0.3162162;
  c += (texture(uSrc, uv + uDir * 3.2307692).rgb + texture(uSrc, uv - uDir * 3.2307692).rgb) * 0.0702702;
  o = vec4(c, 1.0); }`;

// Final: bloom add, film grain (mid-tone weighted, seeded by frame), triangular dither.
const FS_FINAL = `#version 300 es
precision highp float;
uniform sampler2D uScene, uBloom; uniform vec2 uRes; uniform float uBloomK, uGrain; uniform uint uFrame; out vec4 o;
uint hash(uint x){ x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float rnd(uvec2 p, uint salt){ return float(hash(p.x + hash(p.y + hash(uFrame * 7u + salt)))) / 4294967295.0; }
void main(){
  vec2 p = gl_FragCoord.xy; uvec2 ip = uvec2(p);
  vec3 c = texelFetch(uScene, ivec2(p), 0).rgb + texture(uBloom, p / uRes).rgb * uBloomK;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float g = (rnd(ip, 1u) + rnd(ip, 2u) - 1.0) * uGrain * (0.35 + 2.6 * l * (1.0 - l));
  c += g;
  c += (rnd(ip, 3u) - rnd(ip, 4u)) / 255.0;
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// Copy with optional vertical flip, used to present to the canvas and to debug.
const FS_PRESENT = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uRes; out vec4 o;
void main(){ ivec2 p = ivec2(gl_FragCoord.xy); o = texelFetch(uSrc, ivec2(p.x, int(uRes.y) - 1 - p.y), 0); }`;

// NV12 pack into one RGBA8 target of W/4 x 1.5H. Rows 0..H-1 hold 4 luma bytes per
// texel, rows H.. hold two interleaved UV pairs per texel, so a single readPixels
// returns bytes in exact NV12 order. BT.709 limited range, chroma as the 2x2 box mean
// (centre-sited, the inverse of how Chromium and the source pass upsample it).
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
}`;

// Colour conventions the NV12 source can decode with.
const MATRIX = {
  bt709: [1, 1, 1, 0, -0.187324, 1.8556, 1.5748, -0.468124, 0],
  bt601: [1, 1, 1, 0, -0.344136, 1.772, 1.402, -0.714136, 0],
};
const RANGE = {
  tv: { off: [16 / 255, 128 / 255, 128 / 255], scale: [255 / 219, 255 / 224, 255 / 224] },
  pc: { off: [0, 128 / 255, 128 / 255], scale: [1, 1, 1] },
};

class Compositor {
  constructor(W, H, opts = {}) {
    this.W = W; this.H = H;
    const canvas = opts.canvas || document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('no webgl2');
    this.gl = gl;
    this.renderer = (() => { const e = gl.getExtension('WEBGL_debug_renderer_info');
      return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })();
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.prog = {};
    for (const [k, fs] of Object.entries({ nv12: FS_NV12, bg: FS_BG, frame: FS_FRAME, bright: FS_BRIGHT,
      down: FS_DOWN, blur: FS_BLUR, final: FS_FINAL, present: FS_PRESENT, pack: FS_PACK })) this.prog[k] = this.program(fs);
    this.vao = gl.createVertexArray();
    this.bg = this.target(W, H);
    this.scene = this.target(W, H);
    this.out = this.target(W, H);
    this.b2 = this.target(W >> 1, H >> 1);
    this.b4 = this.target(W >> 2, H >> 2);
    this.b4b = this.target(W >> 2, H >> 2);
    this.packed = this.target(W >> 2, (H * 3) >> 1);
    this.draw('bg', this.bg, { uRes: [W, H] });
    this.content = null;
    this.setColour('bt709', 'tv');
  }

  program(fs) {
    const gl = this.gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = { loc: gl.getUniformLocation(p, info.name), type: info.type }; }
    return { p, u };
  }

  texture(w, h, fmt = 'rgba8', mips = 1) {
    const gl = this.gl; const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const f = { rgba8: gl.RGBA8, r8: gl.R8, rg8: gl.RG8 }[fmt];
    gl.texStorage2D(gl.TEXTURE_2D, mips, f, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex: t, w, h, fmt, mips };
  }

  target(w, h, mips = 1) {
    const gl = this.gl; const t = this.texture(w, h, 'rgba8', mips);
    t.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    return t;
  }

  draw(name, dst, uniforms = {}, textures = {}) {
    const gl = this.gl; const { p, u } = this.prog[name];
    gl.useProgram(p);
    let unit = 0;
    for (const [k, t] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t.tex);
      if (u[k]) gl.uniform1i(u[k].loc, unit); unit++;
    }
    for (const [k, v] of Object.entries(uniforms)) {
      const e = u[k]; if (!e) continue;
      const a = Array.isArray(v) ? v : [v];
      switch (e.type) {
        case gl.FLOAT: gl.uniform1f(e.loc, a[0]); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(e.loc, a); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(e.loc, a); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(e.loc, a); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(e.loc, false, a); break;
        case gl.INT: gl.uniform1i(e.loc, a[0]); break;
        case gl.UNSIGNED_INT: gl.uniform1ui(e.loc, a[0]); break;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
    gl.viewport(0, 0, dst ? dst.w : this.W, dst ? dst.h : this.H);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  setColour(matrix, range) { this.colour = { m: MATRIX[matrix], ...RANGE[range] }; }

  ensureContent(w, h) {
    if (this.content && this.content.w === w && this.content.h === h) return;
    const mips = Math.floor(Math.log2(Math.max(w, h))) + 1;
    this.content = this.target(w, h, mips);
    this.contentRaw = this.texture(w, h, 'rgba8', mips);
    this.yTex = this.texture(w, h, 'r8');
    this.uvTex = this.texture(w >> 1, h >> 1, 'rg8');
  }

  // Source stage, NV12 bytes from ffmpeg: upload both planes, convert into the content
  // target, then build mips so a Retina take scaled into 1080 does not alias.
  uploadNV12(buf, w, h) {
    const gl = this.gl; this.ensureContent(w, h);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.yTex.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, buf, 0);
    gl.bindTexture(gl.TEXTURE_2D, this.uvTex.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w >> 1, h >> 1, gl.RG, gl.UNSIGNED_BYTE, buf, w * h);
    const c = this.colour;
    const ch = { left: [[0.5, 0], 0], center: [[0, 0], 0], nearest: [[0, 0], 1] }[this.chroma || 'center'];
    this.draw('nv12', this.content, { uSize: [w, h], uM: c.m, uOff: c.off, uScale: c.scale, uChromaShift: ch[0], uChromaNearest: ch[1] },
      { uY: this.yTex, uUV: this.uvTex });
    gl.bindTexture(gl.TEXTURE_2D, this.content.tex); gl.generateMipmap(gl.TEXTURE_2D);
    this.contentTex = this.content;
  }

  // Source stage, anything Chromium decodes (a <video> element or a WebCodecs VideoFrame):
  // Chromium does the YUV conversion, we only upload and build mips.
  uploadImage(img, w, h) {
    const gl = this.gl; this.ensureContent(w, h);
    gl.bindTexture(gl.TEXTURE_2D, this.contentRaw.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.contentTex = this.contentRaw;
  }

  // Everything after the source. look = { rect, radius, shadow, z0, z1, taps, bloom, grain, frame }.
  compose(look) {
    const { W, H } = this;
    this.draw('frame', this.scene, { uRect: look.rect, uRadius: look.radius, uShadow: look.shadow,
      uZ0: look.z0, uZ1: look.z1, uTaps: look.taps, uContentSize: [this.contentTex.w, this.contentTex.h] },
      { uBg: this.bg, uContent: this.contentTex });
    if (look.bloom > 0) {
      this.draw('bright', this.b2, { uTexel: [1 / W, 1 / H], uThresh: 0.72 }, { uSrc: this.scene });
      this.draw('down', this.b4, { uTexel: [2 / W, 2 / H] }, { uSrc: this.b2 });
      this.draw('blur', this.b4b, { uDir: [4 / W, 0], uRes: [W >> 2, H >> 2] }, { uSrc: this.b4 });
      this.draw('blur', this.b4, { uDir: [0, 4 / H], uRes: [W >> 2, H >> 2] }, { uSrc: this.b4b });
    }
    this.draw('final', this.out, { uRes: [W, H], uBloomK: look.bloom, uGrain: look.grain, uFrame: look.frame >>> 0 },
      { uScene: this.scene, uBloom: this.b4 });
  }

  present() { this.draw('present', null, { uRes: [this.W, this.H] }, { uSrc: this.out }); }
  pack() { this.draw('pack', this.packed, { uH: this.H, uW: this.W }, { uSrc: this.out }); }

  // Synchronous RGBA readback of the composed frame (parity tests only).
  readRGBA(dst) {
    const gl = this.gl; dst = dst || new Uint8Array(this.W * this.H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.out.fbo);
    gl.readPixels(0, 0, this.W, this.H, gl.RGBA, gl.UNSIGNED_BYTE, dst);
    return dst;
  }
}

// Asynchronous readback ring: readPixels into a PIXEL_PACK_BUFFER, fence, and only map
// once the fence has signalled, so the CPU never stalls on the GPU. `packed` reads the
// NV12 target (1.5 bytes per pixel); otherwise the RGBA frame (4 bytes per pixel).
class Readback {
  constructor(comp, { packed = true, ring = 3 } = {}) {
    const gl = comp.gl; this.comp = comp; this.gl = gl; this.packed = packed;
    this.w = packed ? comp.W >> 2 : comp.W; this.h = packed ? (comp.H * 3) >> 1 : comp.H;
    this.bytes = this.w * this.h * 4;
    this.slots = [];
    for (let i = 0; i < ring; i++) {
      const b = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.bytes, gl.STREAM_READ);
      this.slots.push({ buf: b, fence: null, tag: null });
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.head = 0; this.inflight = [];
  }
  get full() { return this.inflight.length >= this.slots.length; }
  issue(tag) {
    const gl = this.gl; const s = this.slots[this.head]; this.head = (this.head + 1) % this.slots.length;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.packed ? this.comp.packed.fbo : this.comp.out.fbo);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.buf);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    s.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); s.tag = tag;
    gl.flush();
    this.inflight.push(s);
  }
  // Resolves the oldest in-flight readback into dst. Returns ms spent waiting on the fence.
  async collect(dst, yieldFn) {
    const gl = this.gl; const s = this.inflight.shift();
    const t0 = performance.now();
    while (gl.clientWaitSync(s.fence, 0, 0) === gl.TIMEOUT_EXPIRED) await yieldFn();
    const t1 = performance.now();
    gl.deleteSync(s.fence); s.fence = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.buf);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, dst, 0, this.bytes);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return { wait: t1 - t0, copy: performance.now() - t1, tag: s.tag };
  }
}

module.exports = { Compositor, Readback, MATRIX, RANGE };
