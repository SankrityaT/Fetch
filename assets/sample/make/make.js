// Makes the sample library from scene.html, so every pixel in it is Fetch's own.
//
//   npx electron assets/sample/make/make.js
//
// Draws each scene in a hidden offscreen window one frame at a time (draw(t), then a
// capture), pipes the frames to the bundled ffmpeg and writes, beside this folder:
//
//   pantry-recipe.mp4 and .pointer.json   a Mac window take, 10 s, with the agent's pointer
//   pantry-phone.mp4, .pointer.json and .fetchdoc.json   a simulator take, 8 s, with its glass
//   pantry-card.png                        a window screenshot, its corners cut out
//
// Nothing here records the screen, moves the pointer, reads a key or plays a sound: the
// window is never shown, audio is muted, and the takes' sound is a click written as
// numbers. Run it again and it draws the same frames.
const { app, BrowserWindow } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const OUT = path.join(__dirname, '..')
const REPO = path.join(__dirname, '..', '..', '..')
let FFMPEG = path.join(REPO, 'vendor', 'ffmpeg')
if (!fs.existsSync(FFMPEG)) FFMPEG = '/opt/homebrew/bin/ffmpeg'
const FPS = 30
const RATE = 48000

app.commandLine.appendSwitch('mute-audio')
app.commandLine.appendSwitch('force-device-scale-factor', '1')
if (app.dock) app.dock.hide()
// each piece closes its window before the next opens, and that must not end the run
app.on('window-all-closed', () => {})

function run(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args], { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { err += d })
    p.on('error', reject)
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(err || `ffmpeg exit ${code}`))))
    if (input) input(p.stdin)
  })
}

// A soft click on every press, and a room far below hearing between them, so the take
// has a track the way a real one does. Mono, 16 bit, at the recorder's own rate.
function clickTrack(dur, clicks) {
  const n = Math.round(dur * RATE)
  const pcm = new Int16Array(n)
  let seed = 7
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1 }
  for (let i = 0; i < n; i++) pcm[i] = Math.round(noise() * 6)
  for (const t of clicks) {
    const a = Math.round(t * RATE)
    for (let k = 0; k < RATE * 0.03 && a + k < n; k++) {
      const env = Math.exp(-k / (RATE * 0.004))
      const s = 0.22 * env * (Math.sin(2 * Math.PI * 2400 * k / RATE) * 0.6 + noise() * 0.4)
      pcm[a + k] = Math.max(-32768, Math.min(32767, pcm[a + k] + Math.round(s * 32767)))
    }
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + n * 2, 4); head.write('WAVE', 8)
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22)
  head.writeUInt32LE(RATE, 24); head.writeUInt32LE(RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34)
  head.write('data', 36); head.writeUInt32LE(n * 2, 40)
  return Buffer.concat([head, Buffer.from(pcm.buffer)])
}

async function open(scene, w, h, zoom) {
  const win = new BrowserWindow({ width: w, height: h, show: false, useContentSize: true, frame: false,
    webPreferences: { offscreen: true, zoomFactor: zoom, backgroundThrottling: false } })
  await win.loadFile(path.join(__dirname, 'scene.html'), { query: { scene } })
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
  return win
}
const js = (win, code) => win.webContents.executeJavaScript(code)
// two animation frames after drawing, so the capture is of this frame and not the last
const settle = win => js(win, 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')

async function frameAt(win, t, w, h) {
  await js(win, `SAMPLE.draw(${t})`)
  await settle(win)
  const img = await win.webContents.capturePage()
  const size = img.getSize()
  const out = size.width === w && size.height === h ? img : img.resize({ width: w, height: h, quality: 'best' })
  return out.toBitmap()
}

async function take({ scene, file, w, h, zoom }) {
  const win = await open(scene, w, h, zoom)
  const dur = await js(win, 'SAMPLE.dur')
  const track = await js(win, 'SAMPLE.pointerTrack()')
  const wav = path.join(require('os').tmpdir(), `fetch-sample-${scene}-${process.pid}.wav`)
  fs.writeFileSync(wav, clickTrack(dur, track.filter(p => p.click).map(p => p.t)))
  const frames = Math.round(dur * FPS)
  await run(['-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${w}x${h}`, '-r', String(FPS), '-i', '-',
    '-i', wav, '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-tune', 'animation', '-g', String(FPS), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart', path.join(OUT, file + '.mp4')], async stdin => {
    for (let i = 0; i < frames; i++) {
      const buf = await frameAt(win, i / FPS, w, h)
      if (!stdin.write(buf)) await new Promise(r => stdin.once('drain', r))
    }
    stdin.end()
  })
  fs.rmSync(wav, { force: true })
  fs.writeFileSync(path.join(OUT, file + '.pointer.json'),
    JSON.stringify({ v: 1, kind: 'window', scale: null, points: track }, null, 1) + '\n')
  let glass = null
  if (scene === 'phone') glass = await js(win, 'SAMPLE.glass()')
  win.destroy()
  return { dur, track, glass }
}

// A window screenshot arrives shaped like the window: its rounded corners are cut out
// of the picture, antialiased, and nothing is drawn under them.
async function still({ file, w, h, zoom, radius }) {
  const win = await open('shot', w, h, zoom)
  const px = await frameAt(win, 0, w, h)
  win.destroy()
  const r = radius
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = x < r ? r : x >= w - r ? w - r : null
      const cy = y < r ? r : y >= h - r ? h - r : null
      if (cx == null || cy == null) continue
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      const a = Math.max(0, Math.min(1, r - d + 0.5))
      px[(y * w + x) * 4 + 3] = Math.round(a * 255)
    }
  }
  await run(['-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${w}x${h}`, '-i', '-', '-frames:v', '1',
    '-pix_fmt', 'rgba', '-compression_level', '100', path.join(OUT, file + '.png')], stdin => stdin.end(px))
}

app.whenReady().then(async () => {
  try {
    // `make.js phone` makes the one piece; no argument makes all three
    const only = process.argv.slice(2).find(a => ['mac', 'phone', 'shot'].includes(a))
    const want = s => !only || only === s
    if (want('mac')) await take({ scene: 'mac', file: 'pantry-recipe', w: 1920, h: 1200, zoom: 1.5 })
    if (want('phone')) {
      const phone = await take({ scene: 'phone', file: 'pantry-phone', w: 828, h: 1736, zoom: 2 })
      // What a capture of a device writes onto its edit: where the glass sits, its corner,
      // and the screen in points. A made-up phone, so it names no maker and no family.
      fs.writeFileSync(path.join(OUT, 'pantry-phone.fetchdoc.json'), JSON.stringify({
        v: 2, viewport: phone.glass,
        device: { name: 'Sample phone', screen: { w: 390, h: 844, scale: 2 } },
      }, null, 1) + '\n')
    }
    if (want('shot')) await still({ file: 'pantry-card', w: 2560, h: 1600, zoom: 2, radius: 20 })
    console.log('made the sample library in', OUT)
    app.exit(0)
  } catch (e) {
    console.error(e)
    app.exit(1)
  }
})
