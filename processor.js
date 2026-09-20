// ffmpeg-based local processing engine. Every job runs the bundled static
// binary. No network, no uploads.
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const Timeline = require('./ui/timeline')
// the same packet-time reader the compositor's decode uses, so one thing knows how to
// ask a container when its frames were shown
const { framePts } = require('./ui/compositor/sources')

let FFMPEG = path.join(__dirname, 'vendor', 'ffmpeg')
if (!fs.existsSync(FFMPEG)) FFMPEG = '/opt/homebrew/bin/ffmpeg' // dev fallback

// The static build has fontconfig compiled in but no config file, so it warns
// and guesses. Naming the file outright makes text render identically everywhere.
const FONT = ['/System/Library/Fonts/Helvetica.ttc',
              '/System/Library/Fonts/SFNS.ttf',
              '/Library/Fonts/Arial.ttf'].find(f => fs.existsSync(f)) || ''
const SUB_FONT = 'Helvetica'

// fonts offered in the editor, resolved to files ffmpeg can load
const FONT_FILES = Object.fromEntries(Object.entries({
  'Helvetica':   '/System/Library/Fonts/Helvetica.ttc',
  'SF Pro':      '/System/Library/Fonts/SFNS.ttf',
  'SF Mono':     '/System/Library/Fonts/SFNSMono.ttf',
  'New York':    '/System/Library/Fonts/NewYork.ttf',
  'Avenir Next': '/System/Library/Fonts/Avenir Next.ttc',
  'Georgia':     '/Library/Fonts/Georgia.ttf',
  'Impact':      '/Library/Fonts/Impact.ttf',
}).filter(([, f]) => fs.existsSync(f)))

// New York is a variable font whose default is its largest display cut, where
// hyphens, dashes and crossbars are hairlines that vanish at video sizes. drawtext
// cannot set an optical size, so hand it a static copy cut for the size drawn, as
// CoreText does in the editor. Steps of 4px keep the cache small.
// Text layers are drawn bold on the editor's stage, so the export finds the bold cut
// too: a face of a .ttc, a "<Name> Bold.ttf" beside it, or wght 700 of a variable font.
// A font with none of those (Impact) stays as it is.
const OPTICAL = new Set(['New York'])
function textFace(name, px) {
  const file = (name && FONT_FILES[name]) || FONT
  if (!file) return FONT
  try {
    const fi = require('./fontinstance')
    if (/\.ttc$/i.test(file)) return fi.collectionFace(file, 'Bold')
    const sibling = file.replace(/\.ttf$/i, ' Bold.ttf')
    if (sibling !== file && fs.existsSync(sibling)) return sibling
    return fi.staticInstance(file, OPTICAL.has(name) ? { wght: 700, opsz: Math.max(12, Math.round(px / 4) * 4) } : { wght: 700 })
  } catch (e) { console.error('font instance failed:', e.message); return file }
}

let _desktop
function app_desktop() {
  if (!_desktop) {
    try { _desktop = require('electron').app.getPath('desktop') } catch { _desktop = path.join(os.homedir(), 'Desktop') }
  }
  return _desktop
}

// ---- process plumbing --------------------------------------------------
// Every child is registered under its job id so a job can be cancelled.
const running = new Map()

function register(jobId, child) {
  if (jobId == null) return
  if (!running.has(jobId)) running.set(jobId, new Set())
  running.get(jobId).add(child)
}
function unregister(jobId, child) {
  const s = running.get(jobId)
  if (s) { s.delete(child); if (!s.size) running.delete(jobId) }
}
function cancel(jobId) {
  const s = running.get(jobId)
  if (!s) return false
  for (const c of s) { try { c.kill('SIGKILL') } catch {} }
  running.delete(jobId)
  return true
}
// Ids of the jobs with a process running now, so a take is not renamed from under one
const runningJobs = () => [...running.keys()]

const NOISE = /Fontconfig error|deprecated pixel format|Past duration|^\s*$/

function run(bin, args, onLine, jobId) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args)
    register(jobId, p)
    let err = ''
    let killed = false
    p.on('close', code => {
      unregister(jobId, p)
      if (killed || code === null) return reject(Object.assign(new Error('cancelled'), { cancelled: true }))
      if (code === 0) return resolve()
      const tail = err.split('\n').filter(l => l.trim() && !NOISE.test(l)).slice(-3).join(' | ')
      reject(new Error(tail || `${path.basename(bin)} exited ${code}`))
    })
    p.on('error', e => { unregister(jobId, p); reject(e) })
    // Buffer partial lines: a pipe chunk can end mid-line, and handing onLine half a
    // "silence_end: 4.21" line loses the event.
    let partial = ''
    p.stderr.on('data', d => {
      err += d
      if (!onLine) return
      const ls = (partial + d).split(/\r?\n|\r/)
      partial = ls.pop()
      ls.forEach(l => l && onLine(l))
    })
    p.stderr.on('end', () => { if (onLine && partial) onLine(partial); partial = '' })
    p.stdout.on('data', d => { if (onLine) d.toString().split('\n').forEach(l => l.startsWith('PROGRESS') && onLine(l)) })
    p.once('exit', (code, sig) => { if (sig === 'SIGKILL') killed = true })
  })
}

// progress helper: ffmpeg prints `time=HH:MM:SS.ss` on every stats line
const timeWatcher = (onProgress, total) => l => {
  if (!onProgress) return
  const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(l)
  if (!m) return
  const secs = +m[1] * 3600 + +m[2] * 60 + +m[3]
  onProgress(secs, total, total ? Math.min(99, Math.round(secs / total * 100)) : null)
}

// ---- probing -----------------------------------------------------------
// `ffmpeg -i` alone exits non-zero but prints the header instantly. The old
// code decoded the entire file with `-f null -` just to read the duration.
async function probeMeta(src) {
  // Read stderr whole. run() hands its callback chunk pieces split on newlines, and a
  // chunk boundary inside "Stream #0:1: Audio: aac" turned into a fake line break, so
  // under load a file with audio was sometimes probed as having none.
  const out = await new Promise(resolve => {
    let buf = ''
    const p = spawn(FFMPEG, ['-hide_banner', '-i', src])
    p.stderr.on('data', d => { buf += d })
    p.on('close', () => resolve(buf))
    p.on('error', () => resolve(buf))
  })
  const meta = { duration: 0, width: 0, height: 0, fps: 0, hasAudio: false, vcodec: null, acodec: null, audioTracks: 0 }
  const d = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(out)
  if (d) meta.duration = +d[1] * 3600 + +d[2] * 60 + +d[3]
  const v = /Stream #\d+:\d+.*?: Video: (\w+).*?, (\d+)x(\d+)/s.exec(out)
  if (v) { meta.vcodec = v[1]; meta.width = +v[2]; meta.height = +v[3] }
  const f = /(\d+(?:\.\d+)?) fps/.exec(out)
  if (f) meta.fps = +f[1]
  const a = /Stream #\d+:\d+.*?: Audio: (\w+)/.exec(out)
  if (a) { meta.hasAudio = true; meta.acodec = a[1] }
  // a native take can carry system audio and the mic as two separate tracks
  meta.audioTracks = (out.match(/Stream #\d+:\d+.*?: Audio: /g) || []).length
  meta.cadence = await probeCadence(src)
  return meta
}

// The cadence of a take, cached on the file as it stands: the rate its own frames
// arrive at while the screen is moving (Timeline.takeFps), which is what decides the
// export's rate. The header's `fps` cannot: it is the average over a take that stops
// writing frames whenever the screen stands still. Reading every packet's time costs
// 0.14 s for seven minutes of take and nothing at all the second time.
const cadences = new Map()
async function probeCadence(src) {
  let key = src
  try { const st = fs.statSync(src); key = `${src}|${st.mtimeMs}|${st.size}` } catch { return 0 }
  if (cadences.has(key)) return cadences.get(key)
  let fps = 0
  try { fps = Timeline.takeFps(await framePts(FFMPEG, src)) } catch { fps = 0 }
  if (cadences.size > 64) cadences.clear()
  cadences.set(key, fps)
  return fps
}

async function probeDuration(src) {
  const m = await probeMeta(src)
  return m.duration
}

// MediaRecorder webms carry no duration and no seek index, so ffmpeg can't
// seek or report length. Remux once (stream copy, ~instant) into Matroska,
// which takes VP9/Opus as-is and writes a real header.
// Returns { src, meta, done() }. Always call done() to clean the temp file.
async function ensureSeekable(srcArg, jobId) {
  let meta = await probeMeta(srcArg)
  if (!/\.(webm|mkv)$/i.test(srcArg) || meta.duration > 0) return { src: srcArg, meta, done() {} }

  const fixed = path.join(os.tmpdir(), `qr-fix-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mkv`)
  await run(FFMPEG, ['-y', '-fflags', '+genpts', '-i', srcArg, '-c', 'copy', fixed], null, jobId)
  meta = await probeMeta(fixed)
  return { src: fixed, meta, done() { try { fs.unlinkSync(fixed) } catch {} } }
}

const outName = (src, tag, ext) => {
  const d = path.parse(src)
  return path.join(path.dirname(src), `${d.name}-${tag}.${ext}`)
}

// h264/aac in mp4 is the only combination every player agrees on
const VIDEO_OUT = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']
const AUDIO_OUT = ['-c:a', 'aac', '-b:a', '192k']
const FAST_START = ['-movflags', '+faststart']

// quality → x264 crf / vp9 crf (lower = better). The editor names the three high,
// balanced and small; MCP names them best, balanced and fast. Both reach the same
// table: best and fast used to fall through to the default, so best was balanced.
const CRF = { high: 19, balanced: 23, small: 28 }
const QUALITY_ALIAS = { best: 'high', fast: 'small' }
const crfFor = q => CRF[QUALITY_ALIAS[q] || q] ?? 23

// every container we can write, with the codecs that container actually accepts.
// Video goes out with stereo 48 kHz sound whatever was recorded: a mono 96 kHz take
// plays in one ear on some players and is an odd file to hand anyone.
const WEB_AUDIO = ['-ar', '48000', '-ac', '2']
const FORMATS = {
  mp4:  { ext: 'mp4',  label: 'MP4 (H.264)',        video: true,
          args: q => [...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crfFor(q)), '-pix_fmt', 'yuv420p'], '-c:a', 'aac', '-b:a', '192k', ...WEB_AUDIO, '-movflags', '+faststart'] },
  mov:  { ext: 'mov',  label: 'MOV (QuickTime)',    video: true,
          args: q => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crfFor(q)), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', ...WEB_AUDIO, '-movflags', '+faststart'] },
  webm: { ext: 'webm', label: 'WebM (VP9)',         video: true,
          args: q => ['-c:v', 'libvpx-vp9', '-crf', String(crfFor(q) + 8), '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k', ...WEB_AUDIO] },
  m4a:  { ext: 'm4a',  label: 'M4A (audio only)',   video: false,
          args: () => ['-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'] },
  mp3:  { ext: 'mp3',  label: 'MP3 (audio only)',   video: false,
          args: () => ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'] },
  wav:  { ext: 'wav',  label: 'WAV (audio only)',   video: false,
          args: () => ['-vn', '-c:a', 'pcm_s16le'] },
  gif:  { ext: 'gif',  label: 'GIF (animated)',     video: true, gif: true,
          args: () => ['-loop', '0', '-an'] },
}
const formatList = () => Object.entries(FORMATS).map(([k, v]) => ({ id: k, label: v.label, video: v.video }))

// containers we can read
const VIDEO_EXT = /\.(webm|mp4|mov|mkv|m4v|avi|mpg|mpeg|wmv|flv|ogv|ts|3gp|mts|m2ts)$/i
const AUDIO_EXT = /\.(mp3|m4a|wav|aac|aiff|flac|ogg|opus|caf)$/i
const MEDIA_EXT = new RegExp(VIDEO_EXT.source.slice(0, -1) + '|' + AUDIO_EXT.source.slice(2), 'i')

// ---- MP4 conversion ----------------------------------------------------
async function toMp4(srcArg, onProgress, jobId) {
  const { src, meta, done } = await ensureSeekable(srcArg, jobId)
  try {
    // a take folder gets its deliverable, not a -converted copy beside the raw take,
    // unless an export is already there: an unedited copy must never replace it
    const deliverable = deliverablePath(srcArg, 'mp4')
    let dest = deliverable && !fs.existsSync(deliverable) ? deliverable
      : srcArg.replace(/\.(webm|mkv)$/i, '.mp4')
    if (dest === srcArg) dest = outName(srcArg, 'converted', 'mp4')
    // A native take is already H.264, so re-encoding it only loses quality: the
    // first version of this halved the bitrate of a perfectly good file. Copy the
    // video stream whenever the codec already matches the container's default.
    const canCopy = meta.vcodec === 'h264' || meta.vcodec === 'hevc'
    const video = canCopy ? ['-c:v', 'copy'] : VIDEO_OUT
    const args = ['-y', '-fflags', '+genpts', '-i', src, ...video]
    args.push(...(meta.hasAudio ? AUDIO_OUT : ['-an']), ...FAST_START, dest)
    await run(FFMPEG, args, timeWatcher(onProgress, meta.duration), jobId)
    if (dest === deliverable) noteCopy(dest)
    return { file: dest, duration: +meta.duration.toFixed(1) }
  } finally { done() }
}

// A native take carries system audio and the microphone as separate tracks, since
// that is how ScreenCaptureKit delivers them. Almost everything downstream maps only
// the first audio stream, so a two-track file silently loses whichever one is not
// first. Fold them into one track. Video is copied, so this costs no quality.
async function flattenAudio(srcArg, jobId) {
  const meta = await probeMeta(srcArg)
  if (!meta || (meta.audioTracks || 0) < 2) return srcArg
  const dest = srcArg.replace(/\.[^.]+$/, '') + '.mixed.mov'
  await run(FFMPEG, ['-y', '-i', srcArg,
    '-filter_complex', '[0:a:0][0:a:1]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[a]',
    '-map', '0:v:0', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', dest], null, jobId)
  if (!fs.existsSync(dest)) return srcArg
  try { fs.unlinkSync(srcArg) } catch {}
  return dest
}

// ---- convert to any supported container -------------------------------
async function convert(srcArg, opts, onProgress, jobId) {
  const fmt = FORMATS[(opts && opts.format) || 'mp4']
  if (!fmt) throw new Error('unsupported format: ' + (opts && opts.format))
  const { src, meta, done } = await ensureSeekable(srcArg, jobId)
  try {
    if (!fmt.video && !meta.hasAudio) throw new Error('this file has no audio track to extract')
    let dest = outName(srcArg, fmt.video ? 'converted' : 'audio', fmt.ext)
    // Converting keeps the plain name when nothing would collide: the deliverable for a
    // take folder, so a GIF lands on top; never over an export that is already there.
    const plain = deliverablePath(srcArg, fmt.ext) || srcArg.replace(/\.[^.]+$/, '.' + fmt.ext)
    if (plain !== srcArg && !fs.existsSync(plain)) dest = plain

    const args = ['-y', '-fflags', '+genpts', '-i', src]
    if (opts && (opts.scale === 720 || opts.scale === 1080) && fmt.video) {
      args.push('-vf', `scale=-2:${opts.scale}:flags=lanczos`)
    }
    args.push(...fmt.args(opts && opts.quality))
    if (fmt.video && !meta.hasAudio) args.push('-an')
    args.push(dest)
    await run(FFMPEG, args, timeWatcher(onProgress, meta.duration), jobId)
    return { file: dest, duration: +meta.duration.toFixed(1), format: fmt.ext,
             mb: +(fs.statSync(dest).size / 1e6).toFixed(1) }
  } finally { done() }
}

// ---- dead-air removal --------------------------------------------------
// detect silences, keep everything else, cut video+audio in sync
async function removeSilence(srcArg, opts, onProgress, jobId) {
  const { src, meta, done } = await ensureSeekable(srcArg, jobId)
  try {
    if (!meta.hasAudio) throw new Error('this recording has no audio track')
    const minSil = opts.minSilence ?? 0.7     // gaps shorter than this stay
    const pad = opts.pad ?? 0.15              // breathing room around cuts
    const thresh = opts.thresh ?? '-35dB'
    const dur = meta.duration

    const events = []
    await run(FFMPEG, ['-i', src, '-af', `silencedetect=noise=${thresh}:d=${minSil}`, '-f', 'null', '-'],
      l => {
        let m = /silence_start: ([\d.-]+)/.exec(l)
        if (m) events.push({ start: Math.max(0, +m[1]) })
        m = /silence_end: ([\d.]+)/.exec(l)
        if (m && events.length && events[events.length - 1].end === undefined) events[events.length - 1].end = +m[1]
        if (onProgress) timeWatcher(p => onProgress(p, dur, Math.round(p / dur * 40)), dur)(l)
      }, jobId)

    // a silence still open at EOF runs to the end
    if (events.length && events[events.length - 1].end === undefined) events[events.length - 1].end = dur

    const cuts = events.map(e => [Math.max(0, e.start + pad), Math.min(dur, e.end - pad)])
      .filter(([s, e]) => e - s > 0.05)
    if (!cuts.length) throw new Error('no dead air found, nothing to cut')

    const keep = []
    let t = 0
    for (const [s, e] of cuts) { if (s - t > 0.05) keep.push([t, s]); t = e }
    if (dur - t > 0.05) keep.push([t, dur])
    if (!keep.length) throw new Error('the whole recording is silence')

    const keptDur = keep.reduce((a, [s, e]) => a + e - s, 0)
    const saved = dur ? Math.round((1 - keptDur / dur) * 100) : 0

    // one trim/concat chain for video+audio keeps them frame-synced
    const n = keep.length
    let fc = ''
    keep.forEach(([s, e], i) => {
      fc += `[0:v]trim=${s.toFixed(3)}:${e.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`
      fc += `[0:a]atrim=${s.toFixed(3)}:${e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`
    })
    fc += Array.from({ length: n }, (_, i) => `[v${i}]`).join('') + `concat=n=${n}:v=1:a=0[vout];`
    fc += Array.from({ length: n }, (_, i) => `[a${i}]`).join('') + `concat=n=${n}:v=0:a=1[aout]`

    const dest = outName(srcArg, 'cut', 'mp4')
    await run(FFMPEG, ['-y', '-i', src, '-filter_complex', fc, '-map', '[vout]', '-map', '[aout]',
      ...VIDEO_OUT, ...AUDIO_OUT, ...FAST_START, dest],
      timeWatcher((s, tot) => onProgress && onProgress(s, keptDur, 40 + Math.round(s / keptDur * 59)), keptDur), jobId)

    return { file: dest, cuts: n, savedPct: saved, duration: +keptDur.toFixed(1) }
  } finally { done() }
}

// ---- audio effects -----------------------------------------------------
async function enhanceAudio(srcArg, opts, onProgress, jobId) {
  const { src, meta, done } = await ensureSeekable(srcArg, jobId)
  try {
    if (!meta.hasAudio) throw new Error('this recording has no audio track')
    const filters = []
    if (opts.denoise) filters.push('afftdn=nr=12:nf=-25:tn=1', 'highpass=f=70')
    if (opts.loudnorm !== false) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11')
    if (opts.gain) filters.push(`volume=${opts.gain}dB`)
    if (!filters.length) throw new Error('no effects selected')

    const dest = outName(srcArg, 'audio', 'mp4')
    // only stream-copy the video when it is already mp4-compatible
    const vArgs = meta.vcodec === 'h264' ? ['-c:v', 'copy'] : VIDEO_OUT
    await run(FFMPEG, ['-y', '-i', src, ...vArgs, '-af', filters.join(','), ...AUDIO_OUT, ...FAST_START, dest],
      timeWatcher(onProgress, meta.duration), jobId)
    return { file: dest, chain: filters.join(','), duration: +meta.duration.toFixed(1) }
  } finally { done() }
}

// ---- trim --------------------------------------------------------------
async function trim(srcArg, start, end, onProgress, jobId) {
  const { src, meta, done } = await ensureSeekable(srcArg, jobId)
  try {
    const s = Math.max(0, start || 0)
    const e = end && end > s ? Math.min(end, meta.duration || end) : meta.duration
    if (e - s < 0.2) throw new Error('trim range too short')
    const dest = outName(srcArg, 'trim', 'mp4')
    const args = ['-y', '-ss', String(s), '-i', src, '-t', String(e - s), ...VIDEO_OUT]
    args.push(...(meta.hasAudio ? AUDIO_OUT : ['-an']), ...FAST_START, dest)
    await run(FFMPEG, args, timeWatcher(onProgress, e - s), jobId)
    return { file: dest, duration: +(e - s).toFixed(1) }
  } finally { done() }
}

// ---- transcription (Parakeet TDT on ANE, via bundled Transcribe.app) ----
// FluidAudio downloads the model on first use and caches it under
// ~/Library/Application Support/FluidAudio. No TCC prompts involved.
function srtTime(t) {
  const ms = Math.round((t % 1) * 1000)
  const s = Math.floor(t) % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

// group words into readable caption lines
function groupWords(words, { maxWords = 9, maxDur = 3.5, gap = 0.8 } = {}) {
  const lines = []
  let cur = null
  for (const w of words) {
    const word = (w.word || '').trim()
    if (!word) continue
    if (!cur) { cur = { start: w.startTime, end: w.endTime, words: [word] }; continue }
    if (cur.words.length >= maxWords || w.startTime - cur.end > gap || cur.end - cur.start > maxDur) {
      lines.push(cur); cur = { start: w.startTime, end: w.endTime, words: [word] }
    } else { cur.end = w.endTime; cur.words.push(word) }
  }
  if (cur) lines.push(cur)
  return lines
}

const cuesToSrt = cues => cues.map((c, i) =>
  `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n')

function findTranscriber() {
  const cands = [
    path.join(process.resourcesPath || '.', 'Transcribe.app', 'Contents', 'MacOS', 'Transcribe'),
    path.join(__dirname, 'Transcribe.app', 'Contents', 'MacOS', 'Transcribe'),
    path.join(__dirname, '..', '..', '..', 'Transcribe.app', 'Contents', 'MacOS', 'Transcribe'),
  ]
  for (const c of cands) if (fs.existsSync(c)) return c
  throw new Error('Transcribe.app is missing from this build')
}

async function transcribe(srcArg, opts, onProgress, jobId) {
  const bin = findTranscriber()
  // Checked up front: otherwise ffmpeg's own "Output file does not contain any
  // stream" is what reaches the person or the agent
  if (!srcArg || !fs.existsSync(srcArg)) throw new Error(`No recording at ${srcArg}. It may have been renamed or deleted.`)
  if (!(await probeMeta(srcArg)).hasAudio) throw new Error('This take has no audio, so there is nothing to transcribe.')
  const locale = (opts && opts.locale) || 'en'
  const wav = path.join(os.tmpdir(), `qr-${Date.now()}.wav`)
  const jsonPath = path.join(os.tmpdir(), `qr-tr-${Date.now()}.json`)
  // `head` transcribes only the opening seconds, for a quick path that needs a take's
  // first words (naming it) rather than all of them
  const head = opts && opts.quick && +opts.head > 0 ? ['-t', String(+opts.head)] : []
  await run(FFMPEG, ['-y', '-fflags', '+genpts', '-i', srcArg, ...head, '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le', wav], null, jobId)
  try {
    // first run downloads the model, so progress arrives as stderr chatter
    await new Promise((resolve, reject) => {
      const p = spawn(bin, ['transcribe', wav, '--output-json', jsonPath, '--language', locale])
      register(jobId, p)
      let err = ''
      p.stderr.on('data', d => {
        err += d
        if (!onProgress) return
        d.toString().split('\n').forEach(l => {
          const pct = /(\d+(?:\.\d+)?)\s*%/.exec(l)
          if (pct && /ownload|etch|odel/.test(l)) onProgress(parseFloat(pct[1]), true)
        })
      })
      p.on('error', e => { unregister(jobId, p); reject(e) })
      p.on('close', code => {
        unregister(jobId, p)
        code === 0 ? resolve()
          : reject(new Error(err.split('\n').filter(Boolean).slice(-2).join(' | ') || `transcriber exited ${code}`))
      })
    })

    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    const words = j.wordTimings || []
    if (!words.length && !(j.text || '').trim()) throw new Error('no speech detected in this recording')

    // Dictation wants the words and nothing else. Building cues, beats and three
    // sidecars for a six second clip that is about to be deleted is pure waste, and
    // it would litter tmpdir with .fetch folders.
    if (opts && opts.quick) {
      return { text: j.text || '', words: words.length, quick: true }
    }

    const txtPath = sidecarOut(srcArg, '.txt'), srtPath = sidecarOut(srcArg, '.srt')
    fs.writeFileSync(txtPath, j.text || '')

    const dur = j.durationSeconds || 0
    const speech = await speechRegions(wav, dur, jobId)
    // The recogniser puts a word heard after a pause a third of a second early, so the
    // captions and their highlight ran ahead of the voice: onto the audio first
    const on = Overlays.snapToSpeech(words.map(w => +w.startTime || 0), speech).times
    words.forEach((w, i) => {
      const d = on[i] - (+w.startTime || 0)
      w.startTime = on[i]
      if (isFinite(+w.endTime)) w.endTime = Math.max(on[i], +w.endTime + d)
    })
    const cues = buildCues(words, speech)
    fs.writeFileSync(srtPath, cuesToSrt(cues))

    // Keep the word timings. They were computed and then thrown away, which cost
    // nothing at the time and made beats, searching inside a recording, and any
    // future "cut the bit where I fumbled" impossible without transcribing again.
    // Start times only: the end times are padded and unreliable, and storing them
    // would invite someone to trust them.
    const wordsPath = sidecarOut(srcArg, '.words.json')
    try {
      fs.writeFileSync(wordsPath, JSON.stringify({
        dur, speech,
        words: words.filter(w => String(w.word || '').trim())
                    .map(w => ({ w: String(w.word).trim(), t: Math.round(w.startTime * 1000) / 1000 })),
      }))
    } catch (e) { console.error('word timings not saved:', e.message) }

    const beats = buildBeats(words, speech, dur)

    return { file: txtPath, srt: srtPath, cues, beats, wordsFile: wordsPath,
             words: words.length, text: j.text || '',
             rtfx: j.rtfx ? Math.round(j.rtfx) : null }
  } finally {
    try { fs.unlinkSync(wav) } catch {}
    try { fs.unlinkSync(jsonPath) } catch {}
  }
}

// Word end times from the recogniser are padded and unreliable, so phrasing is taken
// from the audio itself: a caption breaks wherever the speaker actually paused. Without
// this, several separate phrases merge into one block that appears all at once, showing
// words seconds before they are spoken.
function mergeRegions(speech, joinUnder = 0.28) {
  const out = []
  for (const [a, b] of speech) {
    const last = out[out.length - 1]
    if (last && a - last[1] < joinUnder) last[1] = b
    else out.push([a, b])
  }
  return out
}

function regionIndex(regions, t) {
  for (let i = 0; i < regions.length; i++) {
    if (t >= regions[i][0] - 0.25 && t <= regions[i][1] + 0.25) return i
  }
  let best = 0, d = Infinity
  regions.forEach((r, i) => {
    const dd = Math.min(Math.abs(r[0] - t), Math.abs(r[1] - t))
    if (dd < d) { d = dd; best = i }
  })
  return best
}

// Where the speaker actually stopped: word index -> the pause before it. Each pause
// makes at most one break, before the first word heard after it. Shared by captions
// and beats so the two can never disagree about where a sentence ends.
//
// The two clocks disagree. silencedetect works on amplitude and marks a silence as
// ending once the waveform crosses the threshold; the recogniser reports a word at the
// onset it heard, measured here about 0.38s before that. So "after the pause" means
// starting no earlier than half a second before its detected end. Asking instead
// whether a pause began between each pair of words let one pause qualify on both
// sides of a soft last word ("how hard it IS"), which then stood alone as a caption
// and a beat, or led the next sentence ("OFF. That is the").
function pauseBreaks(clean, speech, minPause) {
  const EARLY = 0.5
  const out = new Map()
  for (let i = 0; i + 1 < (speech || []).length; i++) {
    const x = speech[i][1], y = speech[i + 1][0]
    if (y - x < minPause) continue
    const k = clean.findIndex(w => w.startTime >= y - EARLY)
    if (k > 0 && !out.has(k)) out.set(k, [x, y])
  }
  return out
}

function buildCues(words, speech, { maxWords = 8, maxDur = 3.4, minPause = 0.45 } = {}) {
  const plain = () => groupWords(words).map(l => ({ start: l.start, end: l.end, text: l.words.join(' ') }))
  const clean = words.filter(w => (w.word || '').trim())
  if (!speech || speech.length < 2 || !clean.length) return plain()

  const breaks = pauseBreaks(clean, speech, minPause)

  const groups = []
  let cur = null, prevStart = 0
  clean.forEach((w, i) => {
    const word = (w.word || '').trim()
    if (!cur) { cur = { first: i, start: w.startTime, end: w.endTime, words: [word], starts: [w.startTime] }; prevStart = w.startTime; return }
    const gap = breaks.get(i)
    const full = cur.words.length >= maxWords || (w.endTime - cur.start) > maxDur
    if (gap || full) {
      // stop when the talking stopped, but never before the last word has been said
      if (gap) cur.end = Math.min(cur.end, Math.max(gap[0], prevStart + 0.35))
      groups.push(cur)
      cur = { first: i, start: w.startTime, end: w.endTime, words: [word], starts: [w.startTime] }
    } else {
      cur.end = w.endTime; cur.words.push(word); cur.starts.push(w.startTime)
    }
    prevStart = w.startTime
  })
  if (cur) groups.push(cur)

  // A phrase cut purely by length can leave a stray word stranded on its own line.
  // If no real pause separates it, fold it back into the line it belongs to.
  for (let i = groups.length - 2; i >= 0; i--) {
    const a = groups[i], b = groups[i + 1]
    const noPause = !breaks.has(b.first) && b.start - a.end < 0.3
    // Only if folding it back does not make the line show words long before they are
    // said. Staying in sync matters more than avoiding a short line.
    if (noPause && b.words.length <= 2 && a.words.length + b.words.length <= maxWords + 2 &&
        b.start - a.start <= 2.0) {
      a.words.push(...b.words); a.starts.push(...b.starts); a.end = b.end
      groups.splice(i + 1, 1)
    } else if (noPause && b.words.length === 1 && a.words.length >= 4) {
      // Folding would show the word too early. Carry one across instead, so the
      // stray is never alone: "exactly where you" / "left off." rather than a line
      // that is just "off."
      b.words.unshift(a.words.pop())
      b.start = a.starts.pop()
      b.starts.unshift(b.start)
      a.end = Math.min(a.end, b.start)
    }
  }

  const cues = groups.map(g => ({ start: g.start, end: Math.max(g.end, g.start + 0.4), text: g.words.join(' ') }))
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1]
    const ceiling = next ? next.start - 0.02 : Infinity
    if (cues[i].end > ceiling) cues[i].end = ceiling
    const need = Math.max(1.0, Math.min(5, cues[i].text.length / 16))
    if (cues[i].end - cues[i].start < need) {
      cues[i].end = Math.max(cues[i].end, Math.min(cues[i].start + need, ceiling))
    }
  }
  return cues.filter(c => c.end > c.start + 0.05)
}

// ── beats ────────────────────────────────────────────────────────────────────
// Named spans across a recording, the thing you actually scrub by.
//
// Everyone else derives these from clicks and taps, because a simulator recording
// has no audio to work with. Fetch transcribes on device, so a beat can be named
// from what was said in it: "Now open the filter" rather than "Tap".
//
// The break rule is the one that made captions correct (see buildCues): a boundary
// belongs between two words only where the speaker actually stopped, measured
// against word START times, never the padded end times the recogniser reports. The
// threshold is longer here than for captions, because a caption break is a breath
// and a beat break is a change of subject.
//
// Beats tile: each one runs to the start of the next, and the last runs to the end
// of the recording. A timeline with holes in it is harder to read than one with
// slightly generous spans, and every point in the take belongs somewhere.
function beatLabel(words, maxWords) {
  const text = words.slice(0, maxWords).map(w => String(w.word || '').trim()).filter(Boolean).join(' ')
  if (!text) return 'Untitled'
  const trimmed = text.replace(/[.,;:!?]+$/, '').trim()
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

function buildBeats(words, speech, dur, { minPause = 0.9, maxWords = 6, maxDur = 25 } = {}) {
  const clean = (words || []).filter(w => String(w.word || '').trim() && w.startTime != null)
  if (!clean.length) return []

  const breaks = pauseBreaks(clean, speech, minPause)

  const groups = []
  let cur = null
  clean.forEach((w, i) => {
    if (!cur) { cur = { start: w.startTime, words: [w] }; return }
    // maxDur is a safety net for a monologue with no real pauses in it, not the
    // normal path: without it one beat could span the whole recording.
    if (breaks.has(i) || w.startTime - cur.start > maxDur) {
      groups.push(cur)
      cur = { start: w.startTime, words: [w] }
    } else cur.words.push(w)
  })
  if (cur) groups.push(cur)

  const total = dur || (clean[clean.length - 1].startTime + 2)
  return groups.map((g, i) => ({
    start: Math.max(0, Math.round(g.start * 1000) / 1000),
    end: Math.round((i + 1 < groups.length ? groups[i + 1].start : total) * 1000) / 1000,
    label: beatLabel(g.words, maxWords),
  })).filter(b => b.end > b.start)
}

// No speech at all is a normal recording, not a failure: a silent UI walkthrough
// still deserves a timeline. Fall back to where the pointer settled, which is the
// same signal auto-zoom already uses.
function beatsFromCursor(data, dur) {
  if (!data || !Array.isArray(data.points) || data.points.length < 4) return []
  const pts = data.points
  const marks = []
  let last = pts[0]
  for (let i = 8; i < pts.length; i += 8) {
    const p = pts[i]
    const moved = Math.hypot(p[1] - last[1], p[2] - last[2])
    if (moved > 90) {
      const t = p[0] / 1000
      if (!marks.length || t - marks[marks.length - 1] > 2.5) marks.push(t)
      last = p
    }
  }
  if (!marks.length) return []
  if (marks[0] > 0.5) marks.unshift(0)
  const total = dur || (pts[pts.length - 1][0] / 1000)
  return marks.map((t, i) => ({
    start: Math.round(t * 1000) / 1000,
    end: Math.round((i + 1 < marks.length ? marks[i + 1] : total) * 1000) / 1000,
    label: i === 0 ? 'Start' : `Moment ${i + 1}`,
  })).filter(b => b.end > b.start)
}

// The recogniser's word timings drift, and a cue's end often runs well past the last
// word actually spoken, so a caption sits on screen over silence and reads as being
// "at the wrong time". Snap each cue onto the speech it belongs to, then give it back
// enough time to be read.
async function speechRegions(wav, dur, jobId) {
  const lines = []
  try {
    await run(FFMPEG, ['-hide_banner', '-i', wav, '-af', 'silencedetect=noise=-35dB:d=0.30',
                       '-f', 'null', '-'], l => lines.push(l), jobId)
  } catch { return [] }
  const text = lines.join('\n')
  const starts = [...text.matchAll(/silence_start: ([\d.]+)/g)].map(m => +m[1])
  const ends = [...text.matchAll(/silence_end: ([\d.]+)/g)].map(m => +m[1])
  const sil = []
  let i = 0, j = 0
  if (ends.length && (!starts.length || ends[0] < starts[0])) { sil.push([0, ends[0]]); j = 1 }
  while (i < starts.length) { sil.push([starts[i], j < ends.length ? ends[j] : dur]); i++; j++ }
  const speech = []
  let cur = 0
  for (const [a, b] of sil) { if (a > cur) speech.push([cur, a]); cur = Math.max(cur, b) }
  if (cur < dur) speech.push([cur, dur])
  return speech.filter(([a, b]) => b - a > 0.08)
}

function snapCues(cues, speech) {
  if (!speech.length) return cues
  const out = cues.map(c => {
    let best = null
    for (const [a, b] of speech) {
      const ov = Math.min(c.end, b) - Math.max(c.start, a)
      if (ov > 0 && (!best || ov > best[0])) best = [ov, a, b]
    }
    if (best) {
      const [, a, b] = best
      return { ...c, start: Math.max(c.start, a), end: Math.min(c.end, b) }
    }
    // nothing is being said under it at all: move it to the nearest speech
    const near = speech.reduce((p, r) => Math.abs(r[0] - c.start) < Math.abs(p[0] - c.start) ? r : p)
    return { ...c, start: near[0], end: Math.min(near[1], near[0] + (c.end - c.start)) }
  })
  // a caption clipped to a short burst of speech can end up too brief to read, so
  // give it room to breathe, as long as it does not run into the next one
  for (let i = 0; i < out.length; i++) {
    const need = Math.max(1.0, Math.min(6, out[i].text.length / 16))
    const ceiling = i + 1 < out.length ? out[i + 1].start - 0.05 : Infinity
    if (out[i].end - out[i].start < need) {
      out[i].end = Math.max(out[i].end, Math.min(out[i].start + need, ceiling))
    }
  }
  return out.filter(c => c.end > c.start + 0.05)
}

// read an existing .srt back into cue objects so the editor can show/edit them
function readCues(srcArg) {
  const srt = sidecarIn(srcArg, '.srt')
  if (!fs.existsSync(srt)) return []
  const t = n => { const [hms, ms] = n.split(','); const [h, m, s] = hms.split(':').map(Number); return h * 3600 + m * 60 + s + (+ms) / 1000 }
  return fs.readFileSync(srt, 'utf8').split(/\r?\n\r?\n/).map(b => {
    const lines = b.split(/\r?\n/).filter(Boolean)
    if (lines.length < 2) return null
    const m = /(\d\d:\d\d:\d\d,\d+)\s*-->\s*(\d\d:\d\d:\d\d,\d+)/.exec(lines[1])
    if (!m) return null
    return { start: t(m[1]), end: t(m[2]), text: lines.slice(2).join(' ') }
  }).filter(Boolean)
}

function writeCues(srcArg, cues) {
  const srt = sidecarOut(srcArg, '.srt')
  fs.writeFileSync(srt, cuesToSrt(cues))
  return { srt, count: cues.length }
}

// ---- subtitle style ----------------------------------------------------
// ASS wants &HAABBGGRR, which is alpha plus BGR, not RGB
function assColour(hex, alpha = 0) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '#FFFFFF'))
  const [r, g, b] = m ? m[1].match(/../g).map(v => parseInt(v, 16)) : [255, 255, 255]
  const two = n => n.toString(16).padStart(2, '0').toUpperCase()
  return `&H${two(alpha)}${two(b)}${two(g)}${two(r)}`
}

const ALIGN_CODE = { bottom: 2, middle: 5, top: 8 }

function subStyle(outH, o = {}) {
  // libass sizes text against the script's PlayRes (about 288 lines by default),
  // not against video pixels. Passing a pixel height here made captions enormous,
  // and long lines ran off the frame entirely, which reads as "captions missing".
  const size = Math.max(10, Math.min(44, Math.round(20 * (o.scale ?? 1))))
  const bits = [
    `Fontname=${o.font || SUB_FONT}`,
    `Fontsize=${size}`,
    `Bold=${o.bold === false ? 0 : 1}`,
    `PrimaryColour=${assColour(o.colour || '#FFFFFF')}`,
    `OutlineColour=${assColour(o.outline || '#000000', o.boxed === false ? 0x40 : 0x90)}`,
    `BorderStyle=${o.boxed === false ? 1 : 4}`,
    `Outline=${o.boxed === false ? 2 : 3}`,
    'Shadow=0',
    `Alignment=${ALIGN_CODE[o.position] || 2}`,
    `MarginV=${Math.round(o.marginV ?? 28)}`,
    'MarginL=40', 'MarginR=40',        // keep long lines inside the frame
  ]
  return bits.join(',')
}

// The coordinate space a dragged caption was placed in: the composited frame when
// there is a backdrop (framed is its backdropGeometry, the same numbers the
// composite uses), the video itself otherwise.
function captionCanvas(framed, croppedW, croppedH, outH, opts) {
  if (framed) return { w: framed.outW, h: framed.outH }
  if (opts.backdropAspect) {
    const ar = +opts.backdropAspect
    const long = opts.scale === 720 ? 1280 : 1920
    return { w: 2 * Math.round((ar >= 1 ? long : long * ar) / 2),
             h: 2 * Math.round((ar >= 1 ? long / ar : long) / 2) }
  }
  return { w: Math.max(2, 2 * Math.round(croppedW * (outH / croppedH) / 2)), h: outH }
}

// ffmpeg filter args are parsed by ffmpeg, not a shell: escape \ : ' for the parser
const filterPath = p => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")

// ---- burn captions into video ------------------------------------------
async function burnCaptions(srcArg, opts = {}, onProgress, jobId) {
  const srt = sidecarIn(srcArg, '.srt')
  if (!fs.existsSync(srt)) throw new Error('transcribe this recording first, no captions found')
  const { src, meta, done } = await ensureSeekable(srcArg, jobId)
  try {
    const dest = outName(srcArg, 'captions', 'mp4')
    await run(FFMPEG, ['-y', '-i', src,
      '-vf', `subtitles='${filterPath(srt)}':force_style='${subStyle(meta.height || 1080, opts)}'`,
      ...VIDEO_OUT, ...(meta.hasAudio ? AUDIO_OUT : ['-an']), ...FAST_START, dest],
      timeWatcher(onProgress, meta.duration), jobId)
    return { file: dest, duration: +meta.duration.toFixed(1) }
  } finally { done() }
}

// ---- GIF export ---------------------------------------------------------
async function toGif(srcArg, opts, onProgress, jobId) {
  const { src, meta, done } = await ensureSeekable(srcArg, jobId)
  try {
    const start = Math.max(0, opts?.start ?? 0)
    const len = Math.min(opts?.duration ?? 10, 30, Math.max(0.5, (meta.duration || 10) - start))
    const fps = opts?.fps ?? 12
    const width = opts?.width ?? 640
    const dest = outName(srcArg, 'gif', 'gif')
    const vf = `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];` +
      `[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`
    await run(FFMPEG, ['-y', '-ss', String(start), '-t', String(len), '-i', src, '-vf', vf, '-loop', '0', dest],
      timeWatcher(onProgress, len), jobId)
    const mb = +(fs.statSync(dest).size / 1e6).toFixed(1)
    return { file: dest, duration: +len.toFixed(1), mb }
  } finally { done() }
}

// ---- support files -----------------------------------------------------
// Thumbnails, transcripts, cursor tracks and camera takes are machinery, not
// things anyone asked for. They live in a hidden folder beside the media so the
// save folder only ever holds what the person actually made: recordings and
// exports. Finder hides dot-directories, so the Desktop stays clean.
const SIDE_DIR = '.fetch'
const SIDE_EXT = ['.png', '.srt', '.txt', '.cursor.json', '.pointer.json', '.cam.json', '.cam.mov', '.words.json', '.fetchdoc.json', '.vo.mp3', '.name.json']

const sideStem = p => path.basename(p).replace(/\.[^.]+$/, '')
function sidecarPath(mediaPath, ext) {
  return path.join(path.dirname(mediaPath), SIDE_DIR, sideStem(mediaPath) + ext)
}
// writes: make sure the folder is there first
function sidecarOut(mediaPath, ext) {
  const f = sidecarPath(mediaPath, ext)
  try { fs.mkdirSync(path.dirname(f), { recursive: true }) } catch {}
  return f
}
// reads: fall back to the old location so clips made before this still work
function sidecarIn(mediaPath, ext) {
  const hidden = sidecarPath(mediaPath, ext)
  if (fs.existsSync(hidden)) return hidden
  const legacy = mediaPath.replace(/\.[^.]+$/, ext)
  return fs.existsSync(legacy) ? legacy : hidden
}
// one-time tidy of folders that were already littered
function migrateSidecars(dir) {
  let files = []
  try { files = fs.readdirSync(dir) } catch { return 0 }
  const media = new Set(files.filter(f => MEDIA_EXT.test(f) && !/\.cam\.mov$/i.test(f))
    .map(f => f.replace(/\.[^.]+$/, '')))
  let moved = 0
  for (const f of files) {
    const ext = SIDE_EXT.find(e => f.toLowerCase().endsWith(e))
    if (!ext) continue
    const stem = f.slice(0, f.length - ext.length)
    // Move it if it belongs to a clip that is still here, or if the app clearly
    // wrote it. Never sweep up something the person put there themselves: a
    // stray screenshot or notes.txt keeps the extension but not the name.
    if (!media.has(stem) && !/^recording-/i.test(f)) continue
    const from = path.join(dir, f)
    const to = path.join(dir, SIDE_DIR, f)
    try {
      fs.mkdirSync(path.join(dir, SIDE_DIR), { recursive: true })
      if (!fs.existsSync(to)) { fs.renameSync(from, to); moved++ }
    } catch {}
  }
  return moved
}

// ---- takes: one folder per recording ------------------------------------
// Each take gets a folder under the save root, with the finished video on top and
// everything else one level down, so a take reads as one thing in Finder:
//
//   <root>/<Take>/<Take>.mp4           the deliverable, rewritten by every export
//   <root>/<Take>/Original/<Take>.mov  the raw take, plus working versions (-cut, ...)
//
// Takes from before this sit loose on the Desktop and keep their -edit naming.
const ORIGINAL = 'Original'
const TAGGED = /-(edit|cut|audio|trim|captions|converted|gif)$/
const DEFAULT_ROOT = path.join(os.homedir(), 'Movies', 'Fetch')
let takesRoot = () => DEFAULT_ROOT
// main owns the save folder preference, so it tells us where the root is
function setTakesRoot(fn) { if (typeof fn === 'function') takesRoot = fn }

const isDir = p => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const listDir = d => { try { return fs.readdirSync(d) } catch { return [] } }
// The media in a folder, leaving out support files and half-written exports. A GIF
// counts here, since it can be a take's deliverable, though nothing reads one back.
const mediaIn = d => listDir(d).filter(f => (MEDIA_EXT.test(f) || /\.gif$/i.test(f)) && !f.startsWith('.') &&
  !/\.(cam\.mov|vo\.mp3|mixed\.mov)$/i.test(f))

// Every folder take folders live in: the save folder, and ~/Movies/Fetch as well once
// someone picks another, so earlier takes stay in the Library
function takeRoots() {
  let root = null
  try { root = takesRoot() } catch {}
  return [...new Set([root, DEFAULT_ROOT].filter(Boolean).map(r => path.resolve(r)))]
}
// The take folder a file belongs to, or null for a loose file. A folder called
// Original anywhere else on disk is not a take: Fetch leaves a .fetch folder beside
// any file it thumbnails, so an imported Client/Original/interview.mov also needs its
// name to match the folder's, or an export would rename the person's own folder.
function takeDir(file) {
  const dir = path.dirname(file)
  let t = null
  if (path.basename(dir) === ORIGINAL) t = path.dirname(dir)
  else if (path.parse(file).name === path.basename(dir) && isDir(path.join(dir, ORIGINAL))) t = dir
  if (!t) return null
  if (takeRoots().includes(path.dirname(t))) return t
  const named = path.parse(file).name.replace(TAGGED, '') === path.basename(t)
  return named && isDir(path.join(t, ORIGINAL, SIDE_DIR)) ? t : null
}
// Where an export of this file goes: its take's deliverable, or null for a loose file
function deliverablePath(file, ext) {
  const t = takeDir(file)
  return t ? path.join(t, `${path.basename(t)}.${ext}`) : null
}
// autoConvertMp4 puts an unedited MP4 of the take where the deliverable goes, and that
// is not something the person exported, so the Library must not count it as one. A
// note in the take's .fetch remembers exactly which file it wrote (size and mtime,
// which a rename keeps); once an export rewrites the deliverable it no longer matches.
const COPY_NOTE = 'copy.json'
const fileSig = f => { const st = fs.statSync(f); return { size: st.size, mtime: Math.round(st.mtimeMs) } }
function noteCopy(deliverable) {
  try {
    const dir = path.join(path.dirname(deliverable), SIDE_DIR)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, COPY_NOTE), JSON.stringify({ ext: path.extname(deliverable).slice(1), ...fileSig(deliverable) }))
  } catch {}
}
function isCopy(deliverable) {
  try {
    const n = JSON.parse(fs.readFileSync(path.join(path.dirname(deliverable), SIDE_DIR, COPY_NOTE), 'utf8'))
    const s = fileSig(deliverable)
    return n.ext === path.extname(deliverable).slice(1) && n.size === s.size && n.mtime === s.mtime
  } catch { return false }
}
// Where an edit's export lands: the deliverable, or a loose file's -edit copy. The
// export modal names this before anyone clicks, so it has to be the same answer.
function exportDest(file, ext) {
  return deliverablePath(file, ext) || outName(file, 'edit', ext)
}
// never overwrite, suffix instead: "Demo.mp4" -> "Demo 2.mp4", folder "Demo" -> "Demo 2"
function uniquePath(target, isFolder = false) {
  if (!fs.existsSync(target)) return target
  const dir = path.dirname(target)
  const ext = isFolder ? '' : path.extname(target), base = path.basename(target, ext)
  let n = 2, candidate
  do { candidate = path.join(dir, `${base} ${n}${ext}`); n++ } while (fs.existsSync(candidate))
  return candidate
}

// One file and its sidecars to a new stem, in the same folder. Appends [from, to]
// for everything moved.
function renameWithSidecars(from, stem, moves) {
  let to = path.join(path.dirname(from), stem + path.extname(from))
  if (to === from) return from
  // a change of case only is the same file on a case-insensitive disk, not a clash
  if (to.toLowerCase() !== from.toLowerCase()) to = uniquePath(to)
  fs.renameSync(from, to)
  moves.push([from, to])
  for (const ext of SIDE_EXT) {
    const side = sidecarIn(from, ext)
    if (side === from || !fs.existsSync(side)) continue
    const dest = sidecarPath(to, ext)
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(side, dest); moves.push([side, dest]) } catch {}
  }
  return to
}

// The camera sidecar and the edit document hold absolute paths (the camera take,
// music). Point them at where the files are now, or an export after a rename quietly
// loses the face.
function repointSidecars(moves, fromDir, toDir) {
  const pairs = [...moves]
  if (fromDir && fromDir !== toDir) pairs.push([fromDir + path.sep, toDir + path.sep])
  pairs.sort((a, b) => b[0].length - a[0].length)
  const esc = s => JSON.stringify(s).slice(1, -1)
  for (const [, to] of moves) {
    if (!/\.(cam|fetchdoc)\.json$/i.test(to)) continue
    try {
      let txt = fs.readFileSync(to, 'utf8')
      const before = txt
      for (const [a, b] of pairs) txt = txt.split(esc(a)).join(esc(b))
      if (txt !== before) fs.writeFileSync(to, txt)
    } catch {}
  }
}

// The import index holds paths, so it follows a rename. A loose file that no longer
// starts with recording- is not found by the Desktop scan, so it joins the index.
function syncIndex(moves, add) {
  const map = new Map(moves)
  const idx = readIndex()
  const next = idx.map(f => map.get(f) || f)
  if (add && !next.includes(add)) next.unshift(add)
  if (JSON.stringify(next) !== JSON.stringify(idx)) writeIndex(next)
}

// Rename a take, the single way the Library, the editor and agents all do it. A take
// folder moves as a whole: the folder, the raw take and its working versions in
// Original/, the deliverable on top and every sidecar, so nothing is left behind under
// the old name. A loose file is renamed in place with its sidecars. Returns the new
// path of `file` and every [from, to] move, so callers can repoint what they hold.
function renameTake(file, name) {
  const stem = String(name || '').trim()
  if (!stem || /[/:]/.test(stem) || stem.startsWith('.')) throw new Error('that name cannot be used for a file')
  if (!fs.existsSync(file)) throw new Error('no such recording')
  const moves = []
  const t = takeDir(file)
  if (!t) {
    const to = renameWithSidecars(file, stem, moves)
    syncIndex(moves, /^recording-/i.test(path.basename(to)) ? null : to)
    repointSidecars(moves)
    return { path: to, moves }
  }

  let dest = path.join(path.dirname(t), stem)
  if (dest !== t && dest.toLowerCase() !== t.toLowerCase()) {
    // A loose take from before take folders (Desktop, imported) can already hold the
    // name, and two Library cards both reading "Demo" cannot be told apart, so a
    // loose take's name counts as taken too, not only a folder's.
    const loose = new Set(readIndex().filter(f => !takeDir(f) && fs.existsSync(f)).map(f => path.parse(f).name.toLowerCase()))
    const base = dest
    // "Demo 2" named "Demo" again, with another Demo about, stays "Demo 2", not "Demo 3"
    const self = d => d.toLowerCase() === t.toLowerCase()
    for (let n = 2; !self(dest) && (fs.existsSync(dest) || loose.has(path.basename(dest).toLowerCase())); n++) dest = `${base} ${n}`
  }
  const oldName = path.basename(t), newName = path.basename(dest)
  // Files are named after their take, but the raw one can still carry its timestamp,
  // so match on either stem. Working versions keep their suffix: "Demo-cut.mp4".
  const own = path.parse(file).name.replace(TAGGED, '')
  const stems = [...new Set([oldName, own])].sort((a, b) => b.length - a.length)
  const renameIn = dir => {
    for (const f of mediaIn(dir)) {
      const s = path.parse(f).name
      const hit = stems.find(p => s === p || s.startsWith(p + '-'))
      if (hit != null) renameWithSidecars(path.join(dir, f), newName + s.slice(hit.length), moves)
    }
  }
  renameIn(path.join(t, ORIGINAL))
  renameIn(t)
  if (dest !== t) {
    fs.renameSync(t, dest)
    const inTake = p => p.startsWith(t + path.sep) ? dest + p.slice(t.length) : p
    for (const m of moves) m[1] = inTake(m[1])
  }
  repointSidecars(moves, t, dest)
  syncIndex(moves, null)
  const hit = moves.find(m => m[0] === file)
  const out = hit ? hit[1] : (file.startsWith(t + path.sep) ? dest + file.slice(t.length) : file)
  return { path: out, moves, folder: dest }
}

// The name Fetch itself last gave a take, and how ('app' from the window in front,
// 'agent' from the person's agent). A later automatic rename only goes ahead while the
// take still has exactly this name (naming.isAutoName), so one a person typed is never
// replaced. Travels with the take as a sidecar. `more` can carry what was in front
// (front: app, title, product), so a later naming from the Library still knows what
// it showed, and `tried` once that naming found nothing better, so it is not offered
// again.
function readNameNote(file) {
  try { return JSON.parse(fs.readFileSync(sidecarIn(file, '.name.json'), 'utf8')) } catch { return null }
}
function writeNameNote(file, auto, by, more) {
  const note = { auto, by, at: Date.now(), ...(more || {}) }
  try { fs.writeFileSync(sidecarOut(file, '.name.json'), JSON.stringify(note)) } catch {}
}
// The name a take shows: its folder for a take folder, the file's stem otherwise
function takeName(file) {
  const t = takeDir(file)
  return t ? path.basename(t) : path.parse(file).name
}

// ---- thumbnail grab -----------------------------------------------------
// Mean brightness (0 to 255) of one frame, from a 32x18 grey copy; null if unreadable
function frameLuma(src, at) {
  return new Promise(res => {
    const p = spawn(FFMPEG, ['-v', 'error', '-ss', String(at), '-i', src, '-frames:v', '1',
      '-vf', 'scale=32:18,format=gray', '-f', 'rawvideo', '-'])
    const bufs = []
    p.stdout.on('data', b => bufs.push(b))
    p.on('error', () => res(null))
    p.on('close', () => {
      const b = Buffer.concat(bufs)
      if (!b.length) return res(null)
      let s = 0
      for (const v of b) s += v
      res(s / b.length)
    })
  })
}
async function thumbnail(srcArg, atSec, onProgress, jobId) {
  const { src, meta, done } = await ensureSeekable(srcArg, jobId)
  try {
    const last = Math.max(0, (meta.duration || 1) - 0.1)
    let at = Math.min(Math.max(0, atSec || 0), last)
    // A take can open on black (a window still drawing, a display waking), and an
    // all-black poster reads as a broken card. Look further in until something shows.
    if (meta.width && meta.duration > 2) {
      for (const t of [at, meta.duration * 0.25, meta.duration * 0.5]) {
        const l = await frameLuma(src, Math.min(t, last))
        if (l == null || l > 10) { at = Math.min(t, last); break }
      }
    }
    const dest = sidecarOut(srcArg, '.png')
    await run(FFMPEG, ['-y', '-ss', String(at), '-i', src, '-frames:v', '1', '-q:v', '2', dest], null, jobId)
    if (!fs.existsSync(dest)) throw new Error('could not grab a frame at that time')
    return { file: dest, at: +at.toFixed(2), width: meta.width, height: meta.height }
  } finally { done() }
}

// ---- a frame for an agent to look at ------------------------------------
// Separate from thumbnail(), which writes the library poster. A model that can read
// images uses this to place a zoom, a redaction or a step by what is on screen, so
// it goes to a temp dir and is capped at 1280 wide: enough to read UI text, and far
// fewer image tokens than a Retina frame.
// `out` names the file instead. The default name is keyed on the path and the time
// alone, so two passes at one moment write the same file: a caller that wants a
// picture of its own says so before ffmpeg runs rather than renaming afterwards.
async function frameAt(srcArg, atSec, maxW = 1280, crop = null, out = null) {
  const { src, meta, done } = await ensureSeekable(srcArg)
  try {
    const at = Math.min(Math.max(0, +atSec || 0), Math.max(0, (meta.duration || 1) - 0.05))
    const dest = out || path.join(os.tmpdir(), `fetch-frame-${path.parse(srcArg).name}-${at.toFixed(2)}.jpg`)
    const c = crop && crop.w > 0 && crop.h > 0 ? crop : null
    const vf = (c ? `crop=w='2*floor(iw*${c.w}/2)':h='2*floor(ih*${c.h}/2)':x='iw*${c.x}':y='ih*${c.y}',` : '') +
      `scale='min(${maxW},iw)':-2`
    await run(FFMPEG, ['-y', '-ss', String(at), '-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '4', dest])
    if (!fs.existsSync(dest)) throw new Error('could not grab a frame at that time')
    return { file: dest, at: +at.toFixed(2), width: meta.width, height: meta.height }
  } finally { done() }
}

// ---- what is on a frame, for an edit to point at ------------------------
// Elements.swift reads the frame on device (Vision text, plus the chip, button or card
// drawn around each line); ui/targets.js makes those into E1, E2... and ranks them
// against what the person said. The picture comes back with the chosen ones outlined
// and numbered, so a model picks a number instead of guessing a coordinate. Boxes are
// fractions of the frame after the crop when one is passed, as apply_edit measures.
function elementsBin() {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'Elements') : null
  return packaged && fs.existsSync(packaged) ? packaged : path.join(__dirname, 'Elements')
}
function runOut(bin, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    require('child_process').execFile(bin, args, { maxBuffer: 32 * 1024 * 1024, timeout }, (err, out, errOut) => {
      if (err) return reject(new Error(String(errOut || err.message).trim().split('\n').pop()))
      resolve(out)
    })
  })
}
async function findOnScreen(srcArg, atSec, opts = {}) {
  const Targets = require('./ui/targets')
  // wider than an agent's frame: small UI text reads more surely at this size
  const f = await frameAt(srcArg, atSec, 1600, opts.crop || null)
  const raw = JSON.parse(await runOut(elementsBin(), [f.file]))
  const all = Targets.elementsFrom(raw)
  const query = String(opts.query || '').trim()
  const limit = Math.max(1, Math.min(60, +opts.limit || (query ? 8 : 40)))
  const list = query
    ? Targets.pick(all, query, limit)
    // no query: the things with edges first (chips, buttons, cards), then text
    : all.filter(e => e.kind !== 'text').concat(all.filter(e => e.kind === 'text')).slice(0, limit)
      .sort((a, b) => +a.id.slice(1) - +b.id.slice(1))
  // a name of its own, so the chat's card for an earlier search keeps its picture
  const image = f.file.replace(/\.jpg$/, '') + `-marks-${Date.now().toString(36)}.jpg`
  await runOut(elementsBin(), ['--draw', f.file, image, JSON.stringify(list.map(e => ({ label: e.id, box: e.box })))])
  // every element too, for what depends on the rest of the frame (Targets.liftBlock)
  return { image, frame: f.file, at: f.at, width: raw.width, height: raw.height, found: all.length, elements: list, all }
}

// Tiny grey thumbnails of one box across a span, ten a second, for telling when the
// element in it is actually on screen (Targets.presentSpan). Box in fractions of the
// frame after the crop, times in source seconds. One ffmpeg pass, a few hundred ms.
async function boxSamples(srcArg, box, start, end, crop = null, fps = 10) {
  const { src, meta, done } = await ensureSeekable(srcArg)
  try {
    const c = crop && crop.w > 0 && crop.h > 0 ? crop : { x: 0, y: 0, w: 1, h: 1 }
    const b = box
    const a = Math.max(0, +start || 0), z = Math.min(+end || 0, meta.duration || Infinity)
    if (!(z > a)) return []
    const W = 32, H = 24
    const vf = `fps=${fps},crop=w='max(2,iw*${c.w * b.w})':h='max(2,ih*${c.h * b.h})':x='iw*${c.x + c.w * b.x}':y='ih*${c.y + c.h * b.y}',` +
      `scale=${W}:${H}:flags=area,format=gray`
    const buf = await new Promise((resolve, reject) => {
      const p = spawn(FFMPEG, ['-v', 'error', '-ss', String(a), '-t', String(z - a), '-i', src, '-vf', vf, '-f', 'rawvideo', '-'])
      const chunks = []
      p.stdout.on('data', d => chunks.push(d))
      p.on('error', reject)
      p.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('could not read the box across the span')))
    })
    const n = Math.floor(buf.length / (W * H)), out = []
    for (let i = 0; i < n; i++) out.push({ t: +(a + i / fps).toFixed(2), v: buf.subarray(i * W * H, (i + 1) * W * H) })
    return out
  } finally { done() }
}

// ---- filmstrip for the timeline's video lane ---------------------------
// One tiled PNG of evenly spaced frames, cached next to the clip so the timeline
// does not re-render it on every open.
async function filmstrip(srcArg, opts = {}, onProgress, jobId) {
  const { src, meta, done } = await ensureSeekable(srcArg, jobId)
  try {
    const count = Math.max(6, Math.min(opts.count || 24, 60))
    const h = opts.height || 64
    const dest = path.join(os.tmpdir(), `qr-strip-${path.basename(srcArg)}-${count}x${h}.jpg`)
    if (fs.existsSync(dest)) return { file: dest, count, height: h }
    const dur = meta.duration || 1
    // one frame every dur/count seconds, tiled into a single row
    const fps = count / dur
    await run(FFMPEG, ['-y', '-i', src,
      '-vf', `fps=${fps.toFixed(6)},scale=-2:${h},tile=${count}x1`,
      '-frames:v', '1', '-q:v', '4', dest], null, jobId)
    if (!fs.existsSync(dest)) throw new Error('could not build the filmstrip')
    return { file: dest, count, height: h }
  } finally { done() }
}

// ---- audio waveform peaks (for the editor timeline) ---------------------
async function waveform(srcArg, opts, onProgress, jobId) {
  const { src, meta, done } = await ensureSeekable(srcArg, jobId)
  try {
    if (!meta.hasAudio) return { peaks: [], duration: meta.duration }
    const buckets = Math.max(80, Math.min(opts?.buckets ?? 900, 4000))
    const rate = 4000
    const chunks = []
    await new Promise((resolve, reject) => {
      const p = spawn(FFMPEG, ['-v', 'quiet', '-i', src, '-vn', '-ac', '1', '-ar', String(rate),
        '-f', 's16le', '-'])
      register(jobId, p)
      let ended = false, closed = false
      const finish = () => { if (ended && closed) { unregister(jobId, p); resolve() } }
      p.stdout.on('data', d => chunks.push(d))
      p.stdout.on('end', () => { ended = true; finish() })
      p.on('error', e => { unregister(jobId, p); reject(e) })
      p.on('close', () => { closed = true; finish() })
    })
    const buf = Buffer.concat(chunks)
    const total = Math.floor(buf.length / 2)
    if (!total) return { peaks: [], duration: meta.duration }
    const per = Math.max(1, Math.floor(total / buckets))
    const peaks = []
    for (let i = 0; i < total; i += per) {
      let peak = 0
      for (let j = i; j < Math.min(i + per, total); j++) {
        const v = Math.abs(buf.readInt16LE(j * 2))
        if (v > peak) peak = v
      }
      peaks.push(+(peak / 32768).toFixed(3))
    }
    return { peaks, duration: meta.duration || total / rate }
  } finally { done() }
}

// ---- recordings list ---------------------------------------------------
function libraryIndexPath() {
  let dir
  try { dir = require('electron').app.getPath('userData') } catch { dir = os.tmpdir() }
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return path.join(dir, 'library.json')
}

function readIndex() {
  try { return JSON.parse(fs.readFileSync(libraryIndexPath(), 'utf8')) } catch { return [] }
}
function writeIndex(list) {
  try { fs.writeFileSync(libraryIndexPath(), JSON.stringify(list, null, 2)) } catch {}
}

function describe(full) {
  const st = fs.statSync(full)
  const base = full.replace(/\.[^.]+$/, '')
  const ext = path.extname(full).slice(1).toLowerCase()
  return {
    name: path.basename(full), path: full,
    mb: +(st.size / 1e6).toFixed(1),
    mtime: st.mtimeMs,
    ext,
    kind: AUDIO_EXT.test(full) ? 'audio' : 'video',
    poster: fs.existsSync(sidecarIn(full, '.png')) ? sidecarIn(full, '.png') : null,
    srt: fs.existsSync(sidecarIn(full, '.srt')) ? sidecarIn(full, '.srt') : null,
  }
}

// Every take folder under the root, the loose takes Fetch left on the Desktop before
// take folders, plus whatever the user imported. A take folder's files carry `take`
// (its folder), and the files on top of it carry `deliverable` (plus `copy` for the
// unedited MP4 autoConvertMp4 left there, which is not an export).
//
// One entry per file on disk, not per spelling of its path: the index can hold the
// same file through a symlink or in another case, and that used to draw a take-folder
// card and an "imported" card for one recording.
function listRecordings(root = takesRoot(), index = readIndex()) {
  const out = new Map(), seen = new Set()
  const add = (full, extra) => {
    if (out.has(full)) return
    try {
      const st = fs.statSync(full)
      const id = `${st.dev}:${st.ino}`
      if (seen.has(id)) return
      seen.add(id)
      out.set(full, { ...describe(full), ...extra })
    } catch {}
  }
  for (const dir of new Set([app_desktop(), root])) {
    for (const f of listDir(dir)) {
      if (!/^recording-/i.test(f) || !MEDIA_EXT.test(f)) continue
      if (/\.cam\.mov$/i.test(f)) continue          // a camera take, not a clip
      add(path.join(dir, f))
    }
  }
  for (const r of new Set([root, ...takeRoots()])) for (const d of listDir(r)) {
    const t = path.join(r, d)
    if (d.startsWith('.') || !isDir(path.join(t, ORIGINAL))) continue
    for (const f of mediaIn(path.join(t, ORIGINAL))) add(path.join(t, ORIGINAL, f), { take: t })
    for (const f of mediaIn(t)) {
      const full = path.join(t, f)
      add(full, { take: t, deliverable: true, ...(isCopy(full) ? { copy: true } : {}) })
    }
  }
  for (const full of index) {
    if (!fs.existsSync(full)) continue
    // A loose take Fetch recorded and someone renamed joins the index too, and it is
    // not an import: its recording left a cursor track (an agent take, its own pointer
    // track) or a camera take beside it.
    const own = ['.cursor.json', '.pointer.json', '.cam.json'].some(ext => fs.existsSync(sidecarIn(full, ext)))
    add(full, own ? {} : { imported: true })
    // its -edit and -converted exports sit beside it, named after it
    const stem = path.parse(full).name, dir = path.dirname(full)
    for (const f of mediaIn(dir)) {
      const s2 = path.parse(f).name
      if (s2 !== stem && s2.startsWith(stem + '-') && TAGGED.test(s2) && s2.replace(TAGGED, '') === stem) add(path.join(dir, f))
    }
  }
  return [...out.values()].sort((a, b) => b.mtime - a.mtime)
}

// bring an outside file into the library (any container ffmpeg can read)
async function importFile(src) {
  if (!fs.existsSync(src)) throw new Error('file not found')
  if (!MEDIA_EXT.test(src)) throw new Error('unsupported file type: ' + path.extname(src))
  const meta = await probeMeta(src)
  if (!meta.duration && !meta.width && !meta.hasAudio) throw new Error('this file is not readable media')
  const idx = readIndex()
  if (!idx.includes(src)) { idx.unshift(src); writeIndex(idx) }
  return { ...describe(src), imported: true, meta }
}

function forgetFile(src) {
  writeIndex(readIndex().filter(f => f !== src))
  return true
}

// ---- auto zoom from recorded cursor data -------------------------------
// Recording writes <clip>.cursor.json: the pointer at 20Hz and every click, in ms on
// the video clock, in screen points. Clicks are grouped into moments, and each
// moment becomes a smooth push in and back out, centred on where it happened.
// A native take also says what was recorded (kind, the display's bounds, and for a
// window its bounds over time), which is what maps a screen point into the picture.
// Older files have only the primary display, so they only map for display takes.
// An agent take's own cursor: every call to the pointer tool, on the video clock
// (ui/pointer.js). The edit document's pointer list wins when it has one; [] there
// means no cursor at all.
function readPointer(srcArg) {
  try { return JSON.parse(fs.readFileSync(sidecarIn(srcArg, '.pointer.json'), 'utf8')) } catch { return null }
}
function pointerTrack(srcArg, opts = {}) {
  const side = readPointer(srcArg)
  const points = Array.isArray(opts.pointer) ? opts.pointer : side && side.points
  if (!Array.isArray(points) || !points.length) return null
  return { points, scale: side && side.scale }
}

// How much of each side of the frame is the window's own margin (Overlays.gutterInsets),
// judged on three frames of the kept range and taking the middle answer per side, so a
// toast along one edge in one frame does not decide it.
async function frameGutter(src, from, to, crop) {
  const cropF = crop ? `crop=w='2*floor(iw*${crop.w}/2)':h='2*floor(ih*${crop.h}/2)':x='iw*${crop.x}':y='ih*${crop.y}',` : ''
  const found = []
  for (const k of [0.2, 0.5, 0.8]) {
    const at = from + (to - from) * k
    const px = await new Promise(res => {
      const p = spawn(FFMPEG, ['-v', 'error', '-ss', at.toFixed(3), '-i', src, '-frames:v', '1', '-an',
        '-vf', `${cropF}scale=1440:-2:flags=area,format=gray`, '-f', 'rawvideo', '-'])
      const bufs = []
      p.stdout.on('data', b => bufs.push(b))
      p.on('error', () => res(null))
      p.on('close', () => res(Buffer.concat(bufs)))
    })
    if (px && px.length && px.length % 1440 === 0) {
      found.push({ ...Overlays.gutterInsets(px, 1440, px.length / 1440), corner: Overlays.windowCorner(px, 1440, px.length / 1440) })
    }
  }
  if (!found.length) return null
  const mid = side => found.map(f => f[side]).sort((a, b) => a - b)[Math.floor(found.length / 2)]
  // corner: the window's own rounded corner, a fraction of the frame's width (backdropChain)
  return { l: mid('l'), t: mid('t'), r: mid('r'), b: mid('b'), corner: mid('corner') }
}

// The agent's resting points moved off the words they sit on to the nearest clear
// ground (pointerLib.restSpot), each judged on a grey frame a moment into the rest. Clicks,
// and rests too short to read, stay exactly where they were.
async function pointerRests(src, points, from, to) {
  const out = points.map(p => ({ ...p }))
  let n = 0
  for (let i = 0; i < out.length && n < 40; i++) {
    const p = out[i], next = out[i + 1]
    if (p.click || !(p.t >= from && p.t <= to) || (next && next.t - p.t < 0.6)) continue
    // a rest before a click on the same spot is the approach to that click
    if (next && next.click && Math.hypot(next.x - p.x, next.y - p.y) < 0.01) continue
    n++
    const px = await new Promise(res => {
      const k = spawn(FFMPEG, ['-v', 'error', '-ss', (p.t + 0.25).toFixed(3), '-i', src, '-frames:v', '1', '-an',
        '-vf', 'scale=1440:-2:flags=area,format=gray', '-f', 'rawvideo', '-'])
      const bufs = []
      k.stdout.on('data', b => bufs.push(b))
      k.on('error', () => res(null))
      k.on('close', () => res(Buffer.concat(bufs)))
    })
    if (!px || !px.length || px.length % 1440) continue
    const spot = pointerLib.restSpot(px, 1440, px.length / 1440, p)
    if (spot) Object.assign(p, spot)
  }
  return out
}

function readCursor(srcArg) {
  const p = sidecarIn(srcArg, '.cursor.json')
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

// ── the Mac's pointer, lifted out ───────────────────────────────────────────
// Where the recorded pointer is in the pixels (a person's take, or an agent take
// from before they dropped it), and the edit wants it gone: hideMacCursor true, or
// an agent's cursor is being drawn over a take that also has the Mac's, which would
// otherwise show two. hideMacCursor false keeps it whatever.
function macCursorSpans(srcArg, opts = {}) {
  if (opts.hideMacCursor === false) return []
  if (opts.hideMacCursor !== true && !pointerTrack(srcArg, opts)) return []
  return pointerLib.bakedCursorSpans(readCursor(srcArg))
}

// A region of one frame as rgb24, or null if unreadable
function grabRegion(src, at, r) {
  return new Promise(res => {
    const p = spawn(FFMPEG, ['-v', 'error', '-ss', at.toFixed(3), '-i', src, '-frames:v', '1', '-an',
      '-vf', `crop=${r.w}:${r.h}:${r.x}:${r.y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    const bufs = []
    p.stdout.on('data', b => bufs.push(b))
    p.on('error', () => res(null))
    p.on('close', () => { const b = Buffer.concat(bufs); res(b.length === r.w * r.h * 3 ? b : null) })
  })
}

// The frames of a rest, grouped by what the screen around the pointer showed: a hover
// that lights the row up halfway through is a second group needing its own patch.
// Each group keeps its first frame and where in the box any later one differed from it.
function restGroups(src, a, b, r, reg, jobId) {
  return new Promise(res => {
    const size = r.w * r.h * 3
    const p = spawn(FFMPEG, ['-hide_banner', '-copyts', '-ss', a.toFixed(3), '-i', src, '-an',
      '-vf', `trim=end=${b.toFixed(3)},crop=${r.w}:${r.h}:${r.x}:${r.y},showinfo`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    register(jobId, p)
    const times = [], groups = []
    let pending = Buffer.alloc(0), n = 0, err = ''
    p.stderr.on('data', d => { err += d; if (err.length > 1e6) err = err.slice(-1e5) })
    p.stdout.on('data', d => {
      pending = Buffer.concat([pending, d])
      while (pending.length >= size) {
        const f = Buffer.from(pending.subarray(0, size)); pending = pending.subarray(size)
        const g = groups[groups.length - 1]
        if (!g || pointerLib.ringDiff(f, g.rep, reg) > 2.5) groups.push({ from: n, rep: f, moved: new Uint8Array(reg.bw * reg.bh) })
        else pointerLib.boxMoved(g.moved, f, g.rep, reg)
        n++
        if (groups.length > 8) { try { p.kill('SIGKILL') } catch {} }
      }
    })
    p.on('error', () => { unregister(jobId, p); res(null) })
    p.on('close', () => {
      unregister(jobId, p)
      for (const m of err.matchAll(/pts_time:([\d.]+)/g)) times.push(+m[1])
      if (!groups.length || groups.length > 8) return res(null)
      res(groups.map((g, i) => ({ ...g, t: i ? (times[g.from] != null ? times[g.from] : null) : a })))
    })
  })
}

// Clean patches for each place the pointer rested: the same spot at a nearby moment
// when it was elsewhere, matched to the pixels around the spot and used only if they
// agree, so a screen that changed meanwhile is never pasted back in. Returns, per span
// index, a list of { a, b, png, x, y } in the source's pixels and clock; a rest (or a
// stretch of one) with no clean moment is filled instead.
async function cursorPlates(src, spans, meta, jobId) {
  const W = meta.width, H = meta.height, dur = meta.duration || 0
  const plates = {}
  if (!W || !H || !dur) return plates
  const even = n => 2 * Math.round(n / 2)
  const ring = even(Math.max(8, H * 0.01))
  const rests = spans.map((s, i) => ({ s, i })).filter(({ s }) => s.rest)
    .sort((p, q) => (Math.min(q.s.b, dur) - q.s.a) - (Math.min(p.s.b, dur) - p.s.a)).slice(0, 16)
    // a window sliding in under the pointer: the picture is still, so one clean frame
    // patches the whole line it was drawn along
    .concat(spans.map((s, i) => ({ s, i })).filter(({ s }) => s.slide).slice(0, 8))
  for (const { s, i } of rests) {
    const bx = { x: Math.max(0, even(s.x * W)), y: Math.max(0, even(s.y * H)) }
    bx.w = Math.min(W - bx.x, even(s.w * W) + 2); bx.h = Math.min(H - bx.y, even(s.h * H) + 2)
    if (bx.w < 4 || bx.h < 4) continue
    const r = { x: Math.max(0, bx.x - ring), y: Math.max(0, bx.y - ring) }
    r.w = Math.min(W, bx.x + bx.w + ring) - r.x; r.h = Math.min(H, bx.y + bx.h + ring) - r.y
    const reg = { w: r.w, h: r.h, bx: bx.x - r.x, by: bx.y - r.y, bw: bx.w, bh: bx.h }
    const area = { x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H }
    const b = Math.min(s.b, dur)
    const groups = await restGroups(src, s.a, b, r, reg, jobId)
    if (!groups) continue
    // moments either side when the spot was clear, nearest first, up to five seconds out
    const tries = []
    for (let k = 0; k < 10; k++) {
      for (const t of [s.a - 0.1 - k * 0.5, b + 0.1 + k * 0.5]) {
        if (t >= 0 && t < dur - 0.05 && pointerLib.clearOfCursor(spans, t, area)) tries.push(t)
      }
    }
    const clean = []
    for (const t of tries.slice(0, 6)) { const f = await grabRegion(src, t, r); if (f) clean.push(f) }
    const list = []
    for (let g = 0; g < groups.length; g++) {
      const G = groups[g]
      let best = null
      for (const c of clean) {
        const fit = pointerLib.plateFit(G.rep, c, reg)
        if (fit.residual <= 3 && (!best || fit.residual < best.fit.residual)) best = { c, fit }
      }
      const ga = G.t != null ? G.t : null, gb = g + 1 < groups.length ? groups[g + 1].t : b
      if (!best || ga == null || gb == null || !(gb > ga)) continue
      const png = path.join(os.tmpdir(), `qr-plate-${Date.now()}-${i}-${g}.png`)
      try {
        await new Promise((res, rej) => {
          const p = spawn(FFMPEG, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${bx.w}x${bx.h}`, '-i', '-', png])
          p.on('error', rej)
          p.on('close', code => code === 0 ? res() : rej(new Error('plate not written')))
          p.stdin.end(pointerLib.platePixels([G.rep], best.c, best.fit.corr, reg, { also: G.moved }))
        })
        list.push({ a: g ? ga : s.a, b: g + 1 < groups.length ? gb : s.b, png, x: bx.x, y: bx.y, w: bx.w, h: bx.h })
      } catch {}
    }
    if (list.length) plates[i] = list
  }
  return plates
}

// Filters that take the pointer out, in the frame after the crop: where a rest has a
// clean patch it is laid over, everything else is filled from the box's edges by
// delogo (brief, and while the pointer is moving the eye does not catch the fill).
function cursorEraseFilters(spans, plates, clock, meta, crop, content, span) {
  const W = meta.width, H = meta.height
  if (!W || !H) return []
  // crop rounds its origin down to the chroma grid
  const ox = crop ? Math.floor(W * crop.x) & ~1 : 0, oy = crop ? Math.floor(H * crop.y) & ~1 : 0
  const end = meta.duration || Infinity
  const on = (a, b) => {
    const A = clock(a), B = Math.min(clock(Math.min(b, end)), span || Infinity)
    return B - A > 0.02 ? `enable='between(t,${A.toFixed(3)},${B.toFixed(3)})'` : null
  }
  const out = []
  spans.forEach((s, i) => {
    // what the patches leave uncovered is filled
    let open = [[s.a, s.b]]
    ;(plates[i] || []).forEach((p, k) => {
      const en = on(p.a, p.b)
      if (en) {
        const L = `ce${i}x${k}`
        out.push(`null[${L}a];movie='${filterPath(p.png)}',format=yuva420p[${L}p];` +
          `[${L}a][${L}p]overlay=x=${p.x - ox}:y=${p.y - oy}:format=auto:${en}`)
      }
      open = open.flatMap(([a, b]) => [[a, Math.min(b, p.a)], [Math.max(a, p.b), b]]).filter(([a, b]) => b > a)
    })
    // delogo wants its box a pixel inside the frame; a slide left unpatched is filled
    // piece by piece, never as one long band
    for (const q of s.pieces || [s]) {
      const x0 = Math.max(1, Math.round(q.x * W) - ox), y0 = Math.max(1, Math.round(q.y * H) - oy)
      const x1 = Math.min(content.w - 1, Math.round((q.x + q.w) * W) - ox), y1 = Math.min(content.h - 1, Math.round((q.y + q.h) * H) - oy)
      if (x1 - x0 < 3 || y1 - y0 < 3) continue
      for (const [a, b] of open) {
        const en = on(a, b)
        if (en) out.push(`delogo=x=${x0}:y=${y0}:w=${x1 - x0}:h=${y1 - y0}:${en}`)
      }
    }
  })
  return out
}

// The zoom's ease, written the way ffmpeg's expression parser wants it. What the curve
// is and why is in ui/overlays.js; this is the same S(g(p)) spelled a second time, in
// the one dialect that cannot call a function, so the editor's stage and the export
// make the same move. Both forms are written with as few occurrences of p as they have
// (g is factored, S is Horner), because every occurrence is another copy of the ramp.
const ramp = (t, a, b) => `(${t}-${a})/(${b}-${a})`
const smooth = p => `(${p})*(${p})*(3-2*(${p}))`
const easeBias = kind => (Overlays.EASES[kind] || Overlays.EASES[Overlays.ZOOM_EASE_DEFAULT]).bias
const easeExpr = (p, kind) => {
  const c = easeBias(kind).toFixed(3)
  const u = `((${p})*(1+${c}*(1-(${p}))))`
  return `${u}*${u}*${u}*(10+${u}*(6*${u}-15))`
}

// Where a recorded screen point sits in the picture, as 0..1 of the frame the zoom
// receives (after any crop), or null when it is not in the picture at all: on
// another display, outside the recorded window, or cropped away.
function cursorMapper(data, crop) {
  const wins = data.kind === 'window' && Array.isArray(data.windowBounds) && data.windowBounds.length
    ? data.windowBounds : null
  const d = data.display
  const c = crop && crop.w > 0 && crop.h > 0 ? crop : null
  return (ms, x, y) => {
    let b
    if (wins) {
      // the window's bounds at that moment: the last change at or before it
      let w = wins[0]
      for (const e of wins) { if (e[0] <= ms) w = e; else break }
      // a sixth value of 0 means the window was off screen (another Space, minimised),
      // so whatever the pointer did then was not over it
      if (w[5] === 0) return null
      b = { x: w[1], y: w[2], w: w[3], h: w[4] }
    } else if (data.kind === 'window') {
      return null                    // a window take with no bounds cannot be placed
    } else if (d) {
      b = { x: d.x, y: d.y, w: d.width, h: d.height }
    }
    if (!b || !(b.w > 0) || !(b.h > 0)) return null
    let fx = (x - b.x) / b.w, fy = (y - b.y) / b.h
    if (c) { fx = (fx - c.x) / c.w; fy = (fy - c.y) / c.h }
    if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return null
    return { x: fx, y: fy }
  }
}

// Moments on the output clock, with x, y as 0..1 of the frame the zoom receives.
// opts.clock maps source seconds to output seconds (see outClock), opts.crop is the
// editor's crop.
function zoomMoments(data, opts = {}) {
  if (!data) return []
  const hold = opts.hold ?? 1.6          // seconds held at full zoom
  const curve = opts.curve || Overlays.ZOOM_EASE_DEFAULT   // motion.zoomEase
  const depth = opts.zoom ?? 1.7         // motion.zoomDepth: the deepest a moment goes
  const gap = opts.gap ?? 2.2            // clicks closer than this share one moment...
  const near = opts.near ?? 0.25         // ...when they are also this close on screen
  const clock = opts.clock || (t => t)
  const kept = (opts.clock && opts.clock.kept) || (() => true)
  const at = cursorMapper(data, opts.crop)
  const place = ([ms, x, y]) => {
    const t = ms / 1000
    if (!kept(t)) return null            // trimmed away or inside a cut
    const p = at(ms, x, y)
    return p && { t: clock(t), x: p.x, y: p.y }
  }

  let events = (data.clicks || []).map(place).filter(Boolean)
  // fall back to dwell points if nothing was clicked: places the pointer rested
  if (!events.length) {
    const pts = data.points || []
    for (let i = 8; i < pts.length - 8; i += 8) {
      const [, ax, ay] = pts[i - 8], [, bx, by] = pts[i], [, cx, cy] = pts[i + 8]
      const moved = Math.hypot(bx - ax, by - ay)
      const settled = Math.hypot(cx - bx, cy - by)
      if (moved > 90 && settled < 18) events.push(place(pts[i]))
    }
    events = events.filter(Boolean)
  }
  if (!events.length) return []
  events.sort((a, b) => a.t - b.t)

  // A run of clicks in one place is one moment that holds until the last of them. It
  // used to slide the whole moment to the last click, so the zoom arrived late.
  // A run of clicks also says how wide the thing under them is, and that is what the
  // moment frames: a run across a toolbar spans a third of the picture and pulls back,
  // a run on one field spans nothing and takes the dial's full depth
  // (Overlays.fitScale, the 70 percent fit ui/targets.js frames a named box with).
  const groups = []
  for (const e of events) {
    const last = groups[groups.length - 1]
    if (last && e.t - last.until < gap && Math.hypot(e.x - last.x, e.y - last.y) < near) {
      last.until = e.t
      last.x0 = Math.min(last.x0, e.x); last.x1 = Math.max(last.x1, e.x)
      last.y0 = Math.min(last.y0, e.y); last.y1 = Math.max(last.y1, e.y)
      last.x = (last.x0 + last.x1) / 2; last.y = (last.y0 + last.y1) / 2
      continue
    }
    groups.push({ t: e.t, until: e.t, x: e.x, y: e.y, x0: e.x, x1: e.x, y0: e.y, y1: e.y })
  }
  // A deeper moment takes longer to push in and to pull back: one ramp length for every
  // zoom was the whole of why a deep one snapped (Overlays.easeSpan).
  const moments = groups.map(g => {
    const scale = Overlays.fitScale(Math.max(g.x1 - g.x0, g.y1 - g.y0), depth)
    const ease = Overlays.easeSpan(1, scale, curve)
    return { inStart: Math.max(0, g.t - ease), inEnd: g.t,
      outStart: g.until + hold, outEnd: g.until + hold + ease, x: g.x, y: g.y, scale }
  })
  // A click somewhere else before the last moment has let go, or so soon after that
  // the frame would sit at 1x for under `settle`: stay in and pan across to it. Pulling
  // all the way out and pushing straight back in reads as a bounce, not an edit. The
  // pan ends on the click, as the cursor's glide does, and waits for the last click of
  // the run it leaves unless that would make it a snap.
  const settle = opts.settle ?? Overlays.ZOOM_SETTLE
  for (let i = 1; i < moments.length; i++) {
    const p = moments[i - 1], n = moments[i]
    if (p.outEnd + settle <= n.inStart) continue
    const d = Math.hypot(n.x - p.x, n.y - p.y)
    const pan = opts.pan ?? Overlays.panSpan(d * Math.min(p.scale, n.scale), curve)
    n.inStart = Math.max(p.inEnd, Math.min(groups[i - 1].until, n.inEnd - 0.3), n.inEnd - pan)
    p.outStart = p.outEnd = n.inStart
    n.from = { x: p.x, y: p.y, scale: p.scale, dip: Overlays.panDip(p.scale, n.scale, d) }
  }
  return moments
}

// nested if() chain: one branch per moment, 1.0 everywhere else
// The scale is carried in the log, z = exp(ln(scale) * E), for the reason
// Overlays.sampleMoment gives: what the eye reads is ds/s, and interpolating the scale
// itself spent most of a deep zoom's apparent speed in its first third.
function zoomExpr(moments, disp, zMax, trimStart, curve) {
  const T = 'in_time'
  let z = '1', fx = '0.5', fy = '0.5'
  for (let i = moments.length - 1; i >= 0; i--) {
    const m = moments[i]
    const a = (m.inStart - trimStart), b = (m.inEnd - trimStart)
    const c = (m.outStart - trimStart), d = (m.outEnd - trimStart)
    if (d <= 0) continue
    const upP = easeExpr(ramp(T, a.toFixed(3), b.toFixed(3)), curve)
    const downP = easeExpr(ramp(T, d.toFixed(3), c.toFixed(3)), curve)   // reversed: 0 at d, 1 at c
    // a moment handing over to the next one (zoomMoments' pan) never pulls back
    const out = d - c > 0.001 ? `if(lt(${T},${c.toFixed(3)}),1,${downP})` : '1'
    const inWindow = `between(${T},${a.toFixed(3)},${d.toFixed(3)})`
    // Per-moment scale lets an explicit zoom say how far it goes. Auto-zoom moments
    // carry none and fall back to the single global amount exactly as before.
    const zm = m.scale != null ? m.scale : zMax
    const lz = Math.log(zm).toFixed(5)
    // The focus as a fraction of the travel a window of that scale has, which is what
    // the compositor eases too (Overlays.focusFrac): 0 against the frame's near edge,
    // 1 against the far one, 0.5 centred. zoompan's x is then iw*(1-1/zoom)*n and the
    // frame edge cannot be crossed, so nothing has to be clamped at any instant, and
    // the one frame the old clamp let go on does not change speed.
    const nx = Overlays.focusFrac(Math.min(1, Math.max(0, (m.x - disp.x) / disp.width)), zm)
    const ny = Overlays.focusFrac(Math.min(1, Math.max(0, (m.y - disp.y) / disp.height)), zm)
    const amount = `if(lt(${T},${b.toFixed(3)}),${upP},${out})`
    // out of the centre with the ease and back into it: at 1x the frame is all there is
    const settle = n => `0.5+${(n - 0.5).toFixed(5)}*(${amount})`
    const f = m.from
    if (f) {
      // arriving from another moment: already zoomed, so the in-ease is a pan on the
      // same curve, the focus and any change of scale moving together
      const fz = f.scale != null ? f.scale : zm
      const lf = Math.log(fz).toFixed(5)
      const px = Overlays.focusFrac(Math.min(1, Math.max(0, (f.x - disp.x) / disp.width)), fz)
      const py = Overlays.focusFrac(Math.min(1, Math.max(0, (f.y - disp.y) / disp.height)), fz)
      const lerp = (from, to) => `if(lt(${T},${b.toFixed(3)}),${from.toFixed(5)}+${(to - from).toFixed(5)}*${upP},${settle(to)})`
      // a far pan eases back while it travels (Overlays.panDip), octaves off the scale
      // on a parabola of the same progress
      const dip = f.dip > 0.001 ? `-${(4 * f.dip).toFixed(5)}*${upP}*(1-${upP})` : ''
      const pan = `exp(${lf}+${(Math.log(zm) - Math.log(fz)).toFixed(5)}*${upP}${dip})`
      z = `if(${inWindow},if(lt(${T},${b.toFixed(3)}),${pan},exp(${lz}*(${out}))),${z})`
      fx = `if(${inWindow},${lerp(px, nx)},${fx})`
      fy = `if(${inWindow},${lerp(py, ny)},${fy})`
      continue
    }
    z = `if(${inWindow},exp(${lz}*(${amount})),${z})`
    fx = `if(${inWindow},${settle(nx)},${fx})`
    fy = `if(${inWindow},${settle(ny)},${fy})`
  }
  return { z, fx, fy }
}

// returns a zoompan filter string, or null when there is nothing to zoom to
// Zooms asked for by name (Z1, Z2) rather than guessed from where the pointer
// settled. Same easing and the same expression builder as auto-zoom, so the two look
// identical on screen. Coordinates are 0..1 fractions of the frame, which is what an
// agent can reason about, rather than screen pixels it cannot see.
// The rate zoom output runs at: 60 or 30, off the take's cadence rather than off the
// average it reports, which on a take that stands still for half its length is 26 for
// a screen that never ran at anything but 60.
// the export's frame rate lives with the rest of the edit's time (ui/timeline.js)
const zoomFps = Timeline.outFps

function explicitZoomFilter(zooms, meta, clock, frame, curve) {
  const list = (zooms || []).filter(z => z && z.end > z.start)
  if (!list.length) return null
  // the plan the editor previews: same ease, and zooms close together pan across
  const moments = Overlays.zoomPlan(list.map(z => ({ ...z, start: clock(z.start), end: clock(z.end) })), curve)
  const { z, fx, fy } = zoomExpr(moments, UNIT, 1.8, 0, curve)   // already on the output clock
  return { filter: zoompan(z, fx, fy, meta, frame), moments: moments.length }
}

const UNIT = { x: 0, y: 0, width: 1, height: 1 }

// frame is the size zoompan outputs: the cropped frame, or the framed video's size
// when a backdrop will shrink it anyway, so zoom never scales pixels it then throws
// away. Using the source size stretched every cropped recording that had a zoom.
function zoompan(z, nx, ny, meta, frame) {
  const w = (frame && frame.w) || meta.width || 1920, h = (frame && frame.h) || meta.height || 1080
  // nx,ny is how far along its own travel the window sits, 0 to 1 (Overlays.focusFrac),
  // so the frame's edge is where the expression ends rather than where a clamp cuts it.
  // A pan fraction of the raw focus is the bug this used to have, and it put a 2x zoom
  // aimed at 0.85 centred on 0.675; the fraction is of the travel, not of the frame.
  const x = `iw*(1-1/zoom)*(${nx})`
  const y = `ih*(1-1/zoom)*(${ny})`
  return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${w}x${h}:fps=${zoomFps(meta)}`
}

// Source time to output time. The video filters run after cuts are concatenated, so
// the output clock is contiguous across the kept ranges: a moment 3s after a 2s cut
// sits 2s earlier in the output than in the source. Subtracting only the trim start,
// which is what the zoom code did, put every zoom after a cut late by the length of
// the cut. A time inside a cut does not exist in the output and snaps to where the
// next kept range begins.
// Source time to output time, and whether a moment survives the cuts: ui/timeline.js
const outClock = Timeline.outClock

// ── marks ────────────────────────────────────────────────────────────────────
// Things drawn onto the frame for a stretch of time: a redaction, a blur, a spotlight
// or a numbered step. Rendered before any zoom, so they belong to the content rather
// than the screen: a redaction stays over the sensitive text wherever a zoom moves it.
//
// Coordinates are 0..1 fractions of the frame (x, y is the top-left corner, w, h the
// size), the same convention zooms use, because that is what an agent can reason about.
// A step's x, y is the point it numbers, the corner of a card say, and the badge is
// centred there.
//
// Redactions and blurs change pixels, so they are filters here. Spotlights and steps
// only draw over the picture, so they are ASS events (ui/overlays.js), which gives them
// soft edges, round shapes and eased motion that drawbox and drawtext cannot.
//
// A redaction destroys what is under it. It is not a blur that could be reversed: the
// region is scaled down to a few pixels and back up, so the original detail is not in
// the output at all.
function markFilters(marks, clock, font, tag = 'mk', size = null, span = 0) {
  const out = []
  const f = n => Math.max(0, Math.min(1, +n || 0)).toFixed(4)
  ;(marks || []).forEach((m, i) => {
    if (!m || !(m.end > m.start)) return
    const a = clock(m.start).toFixed(3), b = clock(m.end).toFixed(3)
    if (!(+b > +a)) return                  // wholly inside a cut
    const on = `enable='between(t,${a},${b})'`
    const X = f(m.x), Y = f(m.y), W = f(m.w || 0.2), H = f(m.h || 0.1)
    const crop = `crop=w='max(2,iw*${W})':h='max(2,ih*${H})':x='iw*${X}':y='ih*${Y}'`
    const L = `${tag}${i}`

    if (m.kind === 'redact') {
      // down to roughly 12px across and back, nearest-neighbour both ways
      out.push(`split[${L}a][${L}b];[${L}b]${crop},` +
        `scale='max(1,iw/24)':'max(1,ih/24)':flags=neighbor,` +
        `scale='iw*24':'ih*24':flags=neighbor[${L}c];` +
        `[${L}a][${L}c]overlay=x='main_w*${X}':y='main_h*${Y}':${on}`)
    } else if (m.kind === 'blur' && size) {
      // Gaussian, for softening something distracting. Not for secrets: a blur can
      // be partly undone, which is what redact is for. The patch is cut a feather
      // wider than the region and laid back through a round-cornered mask whose edge
      // fades over that feather, so there is no box, and it eases in and out.
      const sigma = Math.max(4, Math.min(60, +m.strength || 18))
      const even = n => 2 * Math.round(n / 2)
      const rx = +X * size.w, ry = +Y * size.h, rw = Math.max(4, +W * size.w), rh = Math.max(4, +H * size.h)
      const F = Math.max(6, Math.round(size.h * 0.012))
      const x0 = Math.max(0, even(rx - F)), y0 = Math.max(0, even(ry - F))
      const cw = Math.max(4, Math.min(size.w - x0, even(rw + 2 * F + (rx - F - x0)))), ch = Math.max(4, Math.min(size.h - y0, even(rh + 2 * F + (ry - F - y0))))
      const r = Math.min(size.h * 0.014, rw / 2, rh / 2)
      const mx = (rx - x0 + rw / 2).toFixed(1), my = (ry - y0 + rh / 2).toFixed(1)
      const qx = `(abs(X-${mx})-${(rw / 2 - r).toFixed(1)})`, qy = `(abs(Y-${my})-${(rh / 2 - r).toFixed(1)})`
      // signed distance to the rounded rectangle, then a smoothstep across the feather
      const d = `(hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0)-${r.toFixed(1)})`
      const s = `clip(0.5-${d}/${F},0,1)`
      const T = Math.min(0.35, (+b - +a) / 3)
      // a mark a few frames long just appears: fade's d=0 would mean 25 frames
      const fades = T < 0.04 ? [] : [+a > 0.05 ? `fade=t=in:st=${a}:d=${T.toFixed(3)}:alpha=1` : null,
        +b < span - 0.05 ? `fade=t=out:st=${(+b - T).toFixed(3)}:d=${T.toFixed(3)}:alpha=1` : null].filter(Boolean)
      out.push(`split[${L}a][${L}b];` +
        `${still(cw, ch, 'gray')},geq=lum='255*${s}*${s}*(3-2*${s})'[${L}m];` +
        `[${L}b]crop=${cw}:${ch}:${x0}:${y0},gblur=sigma=${sigma}:steps=3,format=yuva420p[${L}p];` +
        `[${L}p][${L}m]alphamerge${fades.length ? ',' + fades.join(',') : ''}[${L}c];` +
        `[${L}a][${L}c]overlay=x=${x0}:y=${y0}:format=auto:${on}`)
    }
  })
  return out
}

// ── lift and spotlight ───────────────────────────────────────────────────────
// The frame stepped back around one thing (Overlays.focusShape). Each mark is two or
// three layers over the picture, all made from masks computed once, never per frame:
//   the frame blurred and dimmed at a third of the size, with a lift's shadow in its
//   shade and a spotlight's cutout in its alpha, faded in and out on the zoom's curve
//   (eq on the mask, the one thing evaluated per frame, a 256 entry table);
//   for a lift, the piece itself cut out with its own corners and scaled up a few
//   percent about its centre (zoompan on just that crop), on the same curve.
// The take is cut in three around the mark and put back together (concat), the layers
// made only for the middle, so the rest of the take costs nothing. Not a trimmed
// layer over the whole take: overlay holds every frame before the layer's first one,
// gigabytes at this size for a mark half a minute in.
function focusFilters(marks, zooms, size, opts = {}) {
  const out = []
  const W = size.w, H = size.h, fps = opts.fps || 30, span = opts.span || Infinity
  const even = n => Math.max(2, 2 * Math.round(n / 2))
  const f3 = n => (+n).toFixed(3)
  let i = 0
  for (const m of marks || []) {
    if (!m || !Overlays.FOCUS_KINDS.includes(m.kind)) continue
    const tm = Overlays.focusTiming(m, zooms, opts.curve)
    if (!tm) continue
    const a = Math.max(0, tm.a), b = Math.min(span, tm.b)
    if (!(b > a + 0.2)) continue
    const seen = Math.max(1, ...(zooms || []).filter(z => z && Math.min(z.end, b) - Math.max(z.start, a) > 0.3).map(z => +z.scale || 1))
    const s = Overlays.focusShape(m, W, H, { px: opts.px, seen, radius: m.radius })
    // A third of the size is plenty for a blur and for masks this soft, seen at 1x.
    // Through a zoom the stepped back page is magnified with everything else, so it is
    // made at the zoom's share of the size: at a third, a 2x zoom turned its text to mush.
    const k = Math.min(1, 540 * seen / H), qw = even(W * k), qh = even(H * k), kx = qw / W, ky = qh / H
    const L = `fo${i++}`
    const A = f3(a), B = f3(b), D = f3(b - a), n = Math.ceil((b - a) * fps) + 2
    const head = a > 0.001, tail = b < span - 0.001
    // 0 to 1 at `v` seconds into the middle piece, smoothstep, as Overlays.focusLevel
    // (the ease timed from the mark's own edges, which a take's start or end may clip)
    const lvl = v => `(st(0,clip(min((${v}+${f3(a - tm.a)})/${f3(tm.Tin)},(${f3(tm.b - a)}-${v})/${f3(tm.Tout)}),0,1));ld(0)*ld(0)*(3-2*ld(0)))`
    const e = Overlays.focusExprs(s, kx)
    const sig = Math.max(0.6, s.blur * ky).toFixed(2)
    const lift = s.kind === 'lift'
    const parts = 1 + head + tail
    let g = `split=${parts}${head ? `[${L}h]` : ''}[${L}s]${tail ? `[${L}t]` : ''};` +
      (head ? `[${L}h]trim=end=${A}[${L}0];` : '') +
      (tail ? `[${L}t]trim=start=${B},setpts=PTS-STARTPTS[${L}2];` : '') +
      `[${L}s]trim=start=${A}:end=${B},setpts=PTS-STARTPTS,split=${lift ? 3 : 2}[${L}a][${L}b]${lift ? `[${L}c]` : ''};` +
      `[${L}b]scale=${qw}:${qh}:flags=area,gblur=sigma=${sig}:steps=2,format=gbrp[${L}q];` +
      `${still(qw, qh, 'gbrp')},geq=r='255*${e.shade}':g='255*${e.shade}':b='255*${e.shade}'[${L}k];` +
      `[${L}q][${L}k]blend=all_mode=multiply,format=yuva420p[${L}v];` +
      `${still(qw, qh, 'gray', lift ? 'white' : 'black')}${lift ? '' : `,geq=lum='255*${e.a}'`},` +
      `loop=loop=${n}:size=1,settb=AVTB,setpts=N/(${fps}*TB),trim=duration=${D},` +
      `eq=contrast='${lvl('t')}':brightness='-(1-${lvl('t')})/2':eval=frame[${L}m];` +
      `[${L}v][${L}m]alphamerge,scale=${W}:${H}:flags=bicubic[${L}w];` +
      `[${L}a][${L}w]overlay=0:0:format=auto:eof_action=pass`
    if (lift) {
      // the piece's crop: the lifted size and a pixel of air, on even pixels so the
      // piece at rest sits exactly on itself
      const gx = s.w * (s.lift - 1) / 2 + 2, gy = s.h * (s.lift - 1) / 2 + 2
      const X0 = Math.max(0, 2 * Math.floor((s.x - gx) / 2)), Y0 = Math.max(0, 2 * Math.floor((s.y - gy) / 2))
      const QW = Math.min(W - X0, even(s.w + 2 * gx)), QH = Math.min(H - Y0, even(s.h + 2 * gy))
      // scaled about the piece's own centre, wherever the frame edge put the crop
      const px = (s.x + s.w / 2 - X0).toFixed(2), py = (s.y + s.h / 2 - Y0).toFixed(2)
      const pe = Overlays.focusExprs(s, 1, X0, Y0)
      g += `[${L}x];[${L}c]crop=${QW}:${QH}:${X0}:${Y0},format=yuva420p[${L}p];` +
        `${still(QW, QH, 'gray')},geq=lum='255*${pe.piece}'[${L}n];` +
        `[${L}p][${L}n]alphamerge,` +
        `zoompan=z='1+${(s.lift - 1).toFixed(4)}*${lvl('it')}':x='${px}*(1-1/zoom)':y='${py}*(1-1/zoom)':d=1:s=${QW}x${QH}:fps=${fps},` +
        `setpts=PTS-STARTPTS[${L}r];` +
        `[${L}x][${L}r]overlay=${X0}:${Y0}:format=auto:eof_action=pass`
    }
    g += `[${L}1];` + (head ? `[${L}0]` : '') + `[${L}1]` + (tail ? `[${L}2]` : '') + `concat=n=${parts}:v=1:a=0`
    out.push(g)
  }
  return out
}

// ── overlays ─────────────────────────────────────────────────────────────────
// The faces ui/overlays.js writes its ASS in, each cut once and renamed to a family
// of its own in a folder libass is pointed at (see fontinstance.renamed). SF Pro for
// captions and titles, SF Pro Rounded for step numerals; a caption or label font the
// person picked is used in its bold cut.
const Overlays = require('./ui/overlays')
const SF_FILE = '/System/Library/Fonts/SFNS.ttf', SF_ROUNDED = '/System/Library/Fonts/SFNSRounded.ttf'

function assFonts(opts = {}) {
  const fi = require('./fontinstance')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-overlay-'))
  const cut = (file, want) => { try { return fs.existsSync(file) ? fi.staticInstance(file, want) : null } catch { return null } }
  const fallback = textFace(null, 48)
  const capName = opts.captionStyle && opts.captionStyle.font
  const O = Overlays.FONT
  const faces = {
    [O.caption]: (capName && capName !== 'SF Pro' && FONT_FILES[capName] ? textFace(capName, 48) : cut(SF_FILE, { wght: 700, opsz: 32 })) || fallback,
    [O.title]: cut(SF_FILE, { wght: 600, opsz: 80 }) || fallback,     // SF Pro Display Semibold
    [O.sub]: cut(SF_FILE, { wght: 500, opsz: 32 }) || fallback,
    [O.num]: cut(SF_ROUNDED, { wght: 700 }) || cut(SF_FILE, { wght: 700 }) || fallback,
  }
  const labels = {}
  for (const t of opts.texts || []) {
    if (!t || !t.font || !FONT_FILES[t.font] || t.font === 'SF Pro' || labels[t.font]) continue
    labels[t.font] = 'Fetch Label ' + t.font.replace(/[^A-Za-z0-9 ]/g, '')
    faces[labels[t.font]] = textFace(t.font, Math.round(1080 * (+t.sizeFrac || 0.05)))
  }
  const metrics = {}
  for (const [family, file] of Object.entries(faces)) {
    if (!file) continue
    try {
      const named = fi.renamed(file, family)
      fs.symlinkSync(named, path.join(dir, family.replace(/\W+/g, '') + '.ttf'))
      metrics[family] = fi.measurer(named)
    } catch (e) { console.error('overlay font failed:', family, e.message) }
  }
  const ROLE = { caption: O.caption, title: O.title, sub: O.sub }
  const measure = (text, px, role) => {
    const m = metrics[ROLE[role] || role] || metrics[O.caption]
    return m ? m(text, px) / m.line : String(text).length * px * 0.47
  }
  return { dir, measure, family: name => labels[name] || null }
}

// Times (output clock) when the captions have no business at the bottom of the frame:
// the product put something where they go, a toast or a bottom sheet
// (Overlays.captionClutter), or the product's own content is simply there and the top
// of the frame is clear (Overlays.captionLive). The first is a change over time, the
// second one frame's own answer, and the union is what moves a phrase to the top.
// A 96x54 grey copy at 4fps of the cropped picture is plenty to see either.
// zooms are the edit's explicit zooms, so a frame is judged through the window that
// is actually on screen; under auto zoom the window is not known here, so no dodging.
// zoomsOut, when the caller has it, is that window as the frame pass will really draw
// it: the same zooms re-framed round any lift riding them, already on the output clock
// (prepare.js, from plan.prepare). A lift widens and moves the zoom it rides, so judged
// through the raw zoom the two zones sit over a different part of the picture than the
// export shows, and a phrase gets carried up onto the content the dodge is avoiding.
function captionClutterTimes(src, { start, end, crop, zooms, zoomsOut, autoZoom, clock }) {
  if (autoZoom && !(zooms && zooms.length)) return Promise.resolve([])
  const w = 96, h = 54, fps = 4
  const vf = [crop ? `crop=w='2*floor(iw*${crop.w}/2)':h='2*floor(ih*${crop.h}/2)':x='iw*${crop.x}':y='ih*${crop.y}'` : null,
    `fps=${fps}`, `scale=${w}:${h}:flags=area`, 'format=gray'].filter(Boolean).join(',')
  // the same plan the export zooms by, pans included; a frame mid-move is not judged
  const on = zoomsOut || (zooms || []).filter(z => z && z.end > z.start)
    .map(z => ({ ...z, start: clock(z.start), end: clock(z.end) }))
  const moves = Overlays.zoomPlan(on).map(m => {
    const vw = 1 / m.scale, clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
    return { ...m, win: { x: clamp(m.x - vw / 2, 0, 1 - vw), y: clamp(m.y - vw / 2, 0, 1 - vw), w: vw, h: vw } }
  })
  const view = t => {
    for (const m of moves) {
      if (t < m.inStart || t > m.outEnd) continue
      return t < m.inEnd || t > m.outStart ? null : m.win
    }
    return { x: 0, y: 0, w: 1, h: 1 }
  }
  return new Promise(res => {
    const p = spawn(FFMPEG, ['-v', 'error', '-ss', String(start), '-i', src, '-t', String(Math.max(0.1, end - start)),
      '-an', '-vf', vf, '-f', 'rawvideo', '-'])
    const bufs = []
    p.stdout.on('data', b => bufs.push(b))
    p.on('error', () => res([]))
    p.on('close', () => {
      const all = Buffer.concat(bufs), n = Math.floor(all.length / (w * h)), frames = []
      for (let k = 0; k < n; k++) {
        const t = start + k / fps
        if (clock.kept && !clock.kept(t)) continue
        frames.push({ t: clock(t), px: all.subarray(k * w * h, (k + 1) * w * h) })
      }
      try {
        const hit = new Set(Overlays.captionClutter(frames, w, h, view))
        for (const t of Overlays.captionLive(frames, w, h, view)) hit.add(t)
        res([...hit].sort((a, b) => a - b))
      } catch { res([]) }
    })
  })
}

// Step badges nudged clear of what is around their point (Overlays.stepSpot), lifts and
// spotlights pulled in to what they light (Overlays.spotFit) with its corner radius
// measured (Overlays.cornerRadius, in pixels of the recording), each judged on a grey
// copy of the cropped picture a moment after it lands. The rest come back as they were.
async function stepSpots(src, marks, crop, content) {
  const k = Math.min(1, 960 / content.w), w = 2 * Math.round(content.w * k / 2), h = 2 * Math.round(content.h * k / 2)
  const vf = [crop ? `crop=w='2*floor(iw*${crop.w}/2)':h='2*floor(ih*${crop.h}/2)':x='iw*${crop.x}':y='ih*${crop.y}'` : null,
    `scale=${w}:${h}:flags=area`, 'format=gray'].filter(Boolean).join(',')
  const grab = at => new Promise(res => {
    const p = spawn(FFMPEG, ['-v', 'error', '-ss', at.toFixed(3), '-i', src, '-frames:v', '1', '-an', '-vf', vf, '-f', 'rawvideo', '-'])
    const bufs = []
    p.stdout.on('data', b => bufs.push(b))
    p.on('error', () => res(null))
    p.on('close', () => { const b = Buffer.concat(bufs); res(b.length === w * h ? b : null) })
  })
  // The box itself at full size, for its corner radius: at the working size above a
  // 16 px corner is five pixels and cannot be measured.
  const grabBox = (at, m) => new Promise(res => {
    const M = 8, X = Math.max(0, Math.floor(m.x * content.w) - M), Y = Math.max(0, Math.floor(m.y * content.h) - M)
    const bw = Math.min(content.w - X, Math.ceil(m.w * content.w) + 2 * M), bh = Math.min(content.h - Y, Math.ceil(m.h * content.h) + 2 * M)
    if (!(bw > 16 && bh > 16) || bw * bh > 4e6) return res(null)
    const cv = [crop ? `crop=w='2*floor(iw*${crop.w}/2)':h='2*floor(ih*${crop.h}/2)':x='iw*${crop.x}':y='ih*${crop.y}'` : null,
      `crop=${bw}:${bh}:${X}:${Y}`, 'format=gray'].filter(Boolean).join(',')
    const p = spawn(FFMPEG, ['-v', 'error', '-ss', at.toFixed(3), '-i', src, '-frames:v', '1', '-an', '-vf', cv, '-f', 'rawvideo', '-'])
    const bufs = []
    p.stdout.on('data', b => bufs.push(b))
    p.on('error', () => res(null))
    p.on('close', () => {
      const b = Buffer.concat(bufs)
      res(b.length === bw * bh ? { px: b, w: bw, h: bh, X, Y, box: { x: (m.x * content.w - X) / bw, y: (m.y * content.h - Y) / bh, w: m.w * content.w / bw, h: m.h * content.h / bh } } : null)
    })
  })
  const out = []
  let n = 0
  for (const m of marks) {
    if (!(m.end > m.start) || ++n > 16) { out.push(m); continue }
    if (Overlays.FOCUS_KINDS.includes(m.kind)) {
      // the window pulled in to what it lights, judged once the target is up, then
      // the thing's own corners measured so the cutout matches them
      const at = m.start + Math.min(1.0, (m.end - m.start) / 2)
      const px = await grab(at)
      let fit = px ? { ...m, ...Overlays.spotFit(px, w, h, m) } : m
      let near = await grabBox(at, fit)
      // a lift raises exactly its box, so the box first takes in the element's own
      // hairline on every side (Overlays.edgeFit), or the raised piece is sliced
      const edge = near && m.kind === 'lift' ? Overlays.edgeFit(near.px, near.w, near.h, near.box) : null
      if (edge) {
        fit = { ...fit, x: (near.X + edge.x * near.w) / content.w, y: (near.Y + edge.y * near.h) / content.h,
          w: edge.w * near.w / content.w, h: edge.h * near.h / content.h }
        near = { ...near, box: edge }
      }
      const r = near ? Overlays.cornerRadius(near.px, near.w, near.h, near.box) : null
      // a square corner reads as 0, and still wants a pixel of anti-aliasing
      out.push(r != null ? { ...fit, radius: Math.max(1, r) } : fit)
      continue
    }
    if (m.kind !== 'step') { out.push(m); continue }
    const px = await grab(m.start + Math.min(0.4, (m.end - m.start) / 2))
    // on the card corner it names when one reads there, else nudged clear of its
    // neighbours; content.h is the height the badges are drawn at
    const corner = px && Overlays.stepCorner(px, w, h, m, content.h)
    out.push(corner ? { ...m, ...corner, corner: true } : px ? { ...m, ...Overlays.stepSpot(px, w, h, m, content.h) } : m)
  }
  // badges on one grid of cards share rows and columns
  const corners = out.filter(m => m.corner)
  if (corners.length > 1) {
    const grid = Overlays.stepGrid(corners, content.w, content.h)
    return out.map(m => (m.corner ? grid[corners.indexOf(m)] : m))
  }
  return out
}

// How long the framed video takes to land as an opening card clears, ending as the card does
const cardLanding = Overlays.cardLanding

// A title card's ground: the finished frame itself, blurred and dimmed, over the
// card's window. It covers the opening from the first frame and clears as the title
// leaves; a closing card gathers in over the end. The ASS title is drawn above it.
function cardFilter(card, W, H, tag, span) {
  const fw = 2 * Math.round(W / 24), fh = 2 * Math.round(H / 24)
  const a = card.a.toFixed(3), b = card.b.toFixed(3), f = card.fade
  // An opening ground clears over exactly the time the framed video scales in
  // (cardLanding), so the handover is one move: no beat of bare backdrop between them
  const land = cardLanding(card)
  const fades = card.opens
    ? [`fade=t=out:st=${Math.max(0, card.b - land).toFixed(3)}:d=${land.toFixed(3)}:alpha=1`]
    : [`fade=t=in:st=${a}:d=${f.toFixed(3)}:alpha=1`,
       card.b < span - 0.05 ? `fade=t=out:st=${(card.b - 0.4).toFixed(3)}:d=0.4:alpha=1` : null].filter(Boolean)
  // A near-black scrim, three quarters in the middle where the title sits and deeper
  // toward the edges, drawn once at a sixteenth of the size. At under half, a light
  // UI came through as a foggy mid-grey with its dark rows still showing as bars.
  const sw = 2 * Math.round(W / 16), sh = 2 * Math.round(H / 16)
  const r2 = `(pow((X-${sw / 2})/${sw / 2},2)+pow((Y-${sh / 2})/${sh / 2},2))/2`
  const scrim = `color=c=0x0E0D0C:s=${sw}x${sh}:r=1:d=1,format=rgba,` +
    `geq=r=14:g=13:b=12:a='255*(0.74+0.16*min(1,${r2}))',scale=${W}:${H}:flags=bicubic`
  // Under an opening card there is only the blurred backdrop, so the scrim alone is the
  // ground: the product then scales in under a clearing tint of the same backdrop it
  // settles on, rather than up through a fog of its own blurred copy.
  if (card.opens) {
    return `null[${tag}m];` + scrim.replace(':r=1:d=1,', `:r=${card.fps || 30}:d=${b},`) +
      `,format=yuva420p,${fades.join(',')}[${tag}v];[${tag}m][${tag}v]overlay=eof_action=pass:format=auto`
  }
  // blurred about 130 px wide at 1080, from a twenty-fourth of the size, and half
  // desaturated, so no shape of the frame survives, only its colour
  return `split[${tag}m][${tag}c];[${tag}c]trim=start=${a}:end=${b},` +
    `scale=${fw}:${fh}:flags=area,gblur=sigma=${(fh * 0.12).toFixed(2)}:steps=3,scale=${W}:${H}:flags=bicubic,` +
    `eq=saturation=0.55[${tag}g];${scrim}[${tag}s];` +
    `[${tag}g][${tag}s]overlay=format=auto,format=yuva420p,${fades.join(',')}[${tag}v];` +
    `[${tag}m][${tag}v]overlay=eof_action=pass:format=auto`
}

// clock is outClock for this export (a number is read as a trim start, for older
// callers), crop the editor's crop. opts.cursor stands in for the sidecar.
function autoZoomFilter(srcArg, meta, opts = {}, clock = 0, frame, crop) {
  // An agent's pointer track is what happened in the take; the Mac's own pointer,
  // if one was recorded, belonged to whoever was sitting there
  const ptr = !opts.cursor && pointerTrack(srcArg, opts)
  const data = opts.cursor || (ptr ? pointerLib.asCursorData(ptr.points) : readCursor(srcArg))
  if (!data || !(data.display || data.windowBounds)) return null
  if (typeof clock === 'number') { const s = clock; clock = t => t - s; clock.kept = t => t >= s }
  const moments = zoomMoments(data, { ...opts, clock, crop })
  if (!moments.length) return null
  const { z, fx, fy } = zoomExpr(moments, UNIT, opts.zoom ?? 1.7, 0, opts.curve)
  return { filter: zoompan(z, fx, fy, meta, frame), moments: moments.length }
}

// ---- background: the framed look --------------------------------------
// Video is inset with rounded corners and a soft shadow over a generated
// backdrop, the way Loom and Screen Studio present a recording.
const BACKDROPS = {
  dusk:    { label: 'Dusk',    c0: '0xF0A93C', c1: '0x7A3E12' },
  ember:   { label: 'Ember',   c0: '0xFF6B4A', c1: '0x7A1F3D' },
  mint:    { label: 'Mint',    c0: '0x63E6BE', c1: '0x0B7285' },
  violet:  { label: 'Violet',  c0: '0xA78BFA', c1: '0x3B1D6E' },
  slate:   { label: 'Slate',   c0: '0x64748B', c1: '0x0F172A' },
  ink:     { label: 'Ink',     c0: '0x2A2320', c1: '0x0A0908' },
  // The Studio preset's own sweep. It is a mesh in the look, and a mesh answers with
  // its palette's name (look.backdropId), so this renderer needs the flat pair of that
  // name or it falls through to dusk and draws the gold the preset was moved off.
  // Keep it the same pair as GRADIENTS.studio in ui/look-schema.js.
  studio:  { label: 'Studio',  c0: '0x8A6A3C', c1: '0x1F1A16' },
  // The recording itself, filling the frame and Gaussian blurred, behind the framed
  // copy. Always matches the content, so it suits any product's colours.
  blur:    { label: 'Blur',    video: true },
}
// Drop any image into assets/backdrops and it shows up as a backdrop. This is
// how generated artwork gets in without touching code.
function backdropDir() {
  const packaged = path.join(process.resourcesPath || '.', 'app', 'assets', 'backdrops')
  const dev = path.join(__dirname, 'assets', 'backdrops')
  return fs.existsSync(packaged) ? packaged : dev
}
// Anything the user uploads goes here rather than into the app bundle, so it
// survives an update and is never wiped by a reinstall.
function userBackdropDir() {
  let base
  try { base = require('electron').app.getPath('userData') }
  catch { base = path.join(os.homedir(), 'Library/Application Support/Fetch') }
  return path.join(base, 'backdrops')
}
function imageBackdrops() {
  const out = []
  for (const [dir, mine] of [[backdropDir(), false], [userBackdropDir(), true]]) {
    let files = []
    try { files = fs.readdirSync(dir) } catch { continue }
    for (const f of files.sort()) {
      if (!/\.(jpg|jpeg|png|webp)$/i.test(f)) continue
      out.push({
        id: 'img:' + (mine ? 'user/' : '') + f,
        label: f.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        file: path.join(dir, f),
        image: true, mine,
      })
    }
  }
  return out
}
const backdropList = () => [
  ...Object.entries(BACKDROPS).map(([id, v]) => ({ id, label: v.label })),
  ...imageBackdrops().map(({ id, label, image, file, mine }) => ({ id, label, image, file, mine })),
]

// rounded-corner alpha, expressed for geq
function roundedAlpha(w, h, r) {
  const corner = (cx, cy) => `gt(hypot(${cx}-X,${cy}-Y),${r})`
  const tl = `lt(X,${r})*lt(Y,${r})*${corner(r, r)}`
  const tr = `gt(X,${w - r})*lt(Y,${r})*${corner(w - r, r)}`
  const bl = `lt(X,${r})*gt(Y,${h - r})*${corner(r, h - r)}`
  const br = `gt(X,${w - r})*gt(Y,${h - r})*${corner(w - r, h - r)}`
  return `if(gt((${tl})+(${tr})+(${bl})+(${br}),0),0,255)`
}

// Where the framed video sits: the canvas, and the video's size and place on it.
// srcW, srcH is the frame being framed, so after a crop it is the cropped size.
// applyEdit reads this before building the graph, so a zoom can output straight at
// the framed size. The editor lays out its stage from the same function, so the
// preview frames a take the way the export does.
function backdropGeometry(srcW, srcH, opts) {
  return Overlays.backdropGeometry(srcW, srcH, opts)
}

// A picture drawn once: a mask, a ring or a shadow. One frame is enough, because
// overlay and alphamerge repeat the last frame of a secondary input for as long as
// the main one runs. Drawing these with geq on every frame was most of the time a
// framed export took.
const still = (w, h, fmt, c = 'black') => `color=c=${c}:s=${w}x${h}:r=1:d=1,format=${fmt}`

// builds a filter_complex that frames [vin] over a backdrop, producing [vout]
function backdropChain(vLabel, srcW, srcH, opts) {
  const imageBd = String(opts.backdrop || '').startsWith('img:')
    ? imageBackdrops().find(b => b.id === opts.backdrop) : null
  // a solid colour is a gradient from the colour to itself (color:#RRGGBB, look background solid)
  const solid = /^color:#?([0-9a-f]{6})$/i.exec(String(opts.backdrop || ''))
  const bd = solid ? { c0: '0x' + solid[1], c1: '0x' + solid[1] } : BACKDROPS[opts.backdrop] || BACKDROPS.dusk
  const { outW, outH, vidW, vidH, radius: asked, ox, oy, blur } = backdropGeometry(srcW, srcH, opts)
  // never inside the window's own black corner (frameGutter measures it), or it shows
  const corner = opts.gutter && opts.gutter.corner ? Math.ceil(opts.gutter.corner * vidW * 1.45) + 2 : 0
  const radius = Math.max(asked, corner)

  const parts = []
  const inputs = []
  let vidSrc = vLabel
  if (!imageBd && bd.video) {
    // One decode, two uses: the sharp framed copy and the blurred fill behind it.
    // The fill is blurred at an eighth of the size and scaled back up: a blur this
    // wide leaves no detail to lose, and it is 64 times fewer pixels to blur.
    // It has to read as a colour field, never as the product's shapes: a light UI
    // blurred at 80 px still showed its rows as grey-green smears. So the frame goes down
    // to a few dozen pixels, is blurred about 120 px wide at 1080, desaturated by half
    // and pressed to under a third of full luma, then a still grain so the dark
    // gradient does not band.
    // The fill comes from the whole, un-zoomed frame when the caller has it (opts.fill):
    // blurred from the zoomed picture, whatever filled the zoom (a green button, a teal
    // panel) bled into the ground as a smear and the ground changed colour at every zoom.
    // It is pressed to about a quarter of full luma, colour kept, and a soft vignette
    // takes the corners down further, so it reads as a deep tint of the product rather
    // than a flat mid-grey, and the title card's scrim clears onto it without a jump.
    const fw = 2 * Math.max(8, Math.round(outW / 64)), fh = 2 * Math.max(5, Math.round(outH / 64))
    const sigma = Math.max(2, 125 * (outH / 1080) * fh / outH)
    let fill = opts.fill
    if (!fill) { parts.push(`[${vLabel}]split[bdsharp][bdfill]`); fill = 'bdfill'; vidSrc = 'bdsharp' }
    parts.push(`[${fill}]scale=${fw}:${fh}:force_original_aspect_ratio=increase:flags=area,crop=${fw}:${fh},` +
               `gblur=sigma=${sigma.toFixed(2)}:steps=3,format=yuv444p,` +
               `lutyuv=y='16+(val-16)*0.3':u='128+(val-128)*0.8':v='128+(val-128)*0.8',` +
               `vignette=angle=0.4:mode=forward,` +
               `scale=${outW}:${outH}:flags=bicubic,noise=c0s=3:c0f=u,setsar=1,format=yuv420p[bg]`)
  } else if (imageBd) {
    // fill the frame without distorting: cover, then centre-crop
    inputs.push(imageBd.file)
    // after the take and any added audio track (applyEdit passes its index)
    parts.push(`[${opts.imageInput || 1}:v]scale=${outW}:${outH}:force_original_aspect_ratio=increase,` +
               `crop=${outW}:${outH},format=rgba[bg]`)
  } else {
    // A still gradient, so draw it once and repeat that frame at the output rate. The
    // generator ran every frame, at its default 25fps, so a 60fps take came out at 25.
    const fps = opts.fps || 30
    parts.push(`gradients=s=${outW}x${outH}:c0=${bd.c0}:c1=${bd.c1}:x0=0:y0=0:x1=${outW}:y1=${outH}:speed=0:r=${fps},` +
               `trim=end_frame=1,loop=loop=-1:size=1,format=yuv420p[bg]`)
  }
  // the video, inset and rounded: a static corner mask merged in as alpha
  parts.push(`${still(vidW, vidH, 'gray')},geq=lum='${roundedAlpha(vidW, vidH, radius)}'[vmask]`)
  // The window's own margin (frameGutter) trimmed off, so the frame has one corner and
  // one edge; covered to the same shape rather than stretched, so nothing distorts
  const g = opts.gutter
  const trim = g && (g.l || g.t || g.r || g.b)
    ? `crop=w='2*floor(iw*${(1 - g.l - g.r).toFixed(4)}/2)':h='2*floor(ih*${(1 - g.t - g.b).toFixed(4)}/2)':x='iw*${g.l.toFixed(4)}':y='ih*${g.t.toFixed(4)}',` +
      `scale=${vidW}:${vidH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${vidW}:${vidH},`
    : `scale=${vidW}:${vidH}:flags=lanczos,`
  parts.push(`[${vidSrc}]${trim}format=yuva420p[vsq]`)
  parts.push(`[vsq][vmask]alphamerge[vid]`)
  // Shadow needs a margin around it, otherwise boxblur is clipped by its own
  // canvas and leaves a hard edge along the bottom.
  const pad = blur * 2
  const shW = vidW + pad * 2, shH = vidH + pad * 2
  // look frame.shadow, 0 to 1; 0.6 is the shadow every framed export had before
  const shadowAlpha = Math.max(0, Math.min(1, opts.shadow != null && Number.isFinite(+opts.shadow) ? +opts.shadow : 0.6))
  parts.push(`${still(shW, shH, 'rgba', 'black@0')},` +
             `geq=r=0:g=0:b=0:a='if(between(X,${pad},${pad + vidW})*between(Y,${pad},${pad + vidH}),` +
             `${shadowAlpha.toFixed(3)}*${roundedAlpha(vidW, vidH, radius).replace(/X/g, `(X-${pad})`).replace(/Y/g, `(Y-${pad})`)}/255*255,0)',` +
             `boxblur=${blur}:2[sh]`)
  // An opening title card clears onto the product scaling up into place from a little
  // smaller, eased out, shadow and all, rather than the frame just being there. It
  // holds small under the card, so the blurred ground the card shows is the same shape.
  // A closing card is the same move backwards: the frame settles back to 92 percent on
  // the zoom's smoothstep while the card's scrim gathers over it.
  const rv = opts.reveal, cl = opts.close
  const shY = oy - pad + Math.round(blur * 0.9)
  if (rv || cl) {
    // Opening: the frame is not there at all under the card, then scales up from 96
    // percent and 8 px low on the entering curve (a cubic ease-out) while the card's
    // ground clears over the same span, its shadow growing in with it. It is opaque
    // well before the ground has gone, so it never reads as a ghost through the scrim.
    const e = rv ? `(1-pow(1-clip((t-${rv.at.toFixed(3)})/${rv.dur.toFixed(3)},0,1),3))` : '1'
    const kIn = rv ? `(0.96+0.04*${e})` : '1'
    const rise = rv ? `+${(8 * outH / 1080).toFixed(1)}*(1-${e})` : ''
    const q = cl ? `clip((t-${cl.at.toFixed(3)})/${cl.dur.toFixed(3)},0,1)` : null
    const kOut = cl ? `(1-0.08*${q}*${q}*(3-2*${q}))` : '1'
    const k = `(${kIn}*${kOut})`
    const land = rv ? `,fade=t=in:st=${rv.at.toFixed(3)}:d=${(rv.dur * 0.45).toFixed(3)}:alpha=1` : ''
    const glow = rv ? `,fade=t=in:st=${rv.at.toFixed(3)}:d=${rv.dur.toFixed(3)}:alpha=1` : ''
    const on = rv ? `:enable='gte(t,${rv.at.toFixed(3)})'` : ''
    const grow = (label, w, h, fx) => `[${label}]scale=w='2*trunc(${w}*${k}/2)':h='2*trunc(${h}*${k}/2)':eval=frame:flags=bicubic${fx}[${label}k]`
    parts.push(grow('sh', shW, shH, glow), grow('vid', vidW, vidH, land))
    parts.push(`[bg][shk]overlay=x='${ox - pad}+(${shW}-w)/2':y='${shY}+(${shH}-h)/2${rise}'${on}[bgs]`)
    parts.push(`[bgs][vidk]overlay=x='${ox}+(${vidW}-w)/2':y='${oy}+(${vidH}-h)/2${rise}':format=auto${on},format=yuv420p,setsar=1[vout]`)
    return { chain: parts.join(';'), outW, outH, inputs, fill: opts.fill && !imageBd && bd.video ? opts.fill : null }
  }
  parts.push(`[bg][sh]overlay=${ox - pad}:${shY}[bgs]`)
  parts.push(`[bgs][vid]overlay=${ox}:${oy}:format=auto,format=yuv420p,setsar=1[vout]`)
  return { chain: parts.join(';'), outW, outH, inputs, fill: opts.fill && !imageBd && bd.video ? opts.fill : null }
}

// Cuts are ranges the user removed, inverted into keep ranges clipped to the trim
// window (ui/timeline.js), then trimmed and concatenated in the same pass as everything else.
const keepRanges = Timeline.keepRanges

// ---- combined editor export --------------------------------------------
// one ffmpeg pass: trim → crop → scale → text layers → captions → fades → audio
// text positions/sizes are fractions of the (cropped) frame so they survive scaling
// ---- camera take -------------------------------------------------------
// The bubble is recorded to its own file and composited here, which is what lets
// the editor move and resize it. Loaded with movie= rather than as another -i so
// the existing input indices (added audio, backdrop images) keep their meaning.
function camChain(cam, srcW, srcH, baseSeek) {
  const S = 2 * Math.round(Math.max(48, (cam.size || 0.22) * srcW) / 2)
  const cx = Math.round((cam.x != null ? cam.x : 0.82) * srcW - S / 2)
  const cy = Math.round((cam.y != null ? cam.y : 0.78) * srcH - S / 2)
  const x = Math.max(0, Math.min(srcW - S, cx))
  const y = Math.max(0, Math.min(srcH - S, cy))
  const ring = Math.max(2, Math.round(S * 0.016))
  const RO = (S / 2).toFixed(1), RI = (S / 2 - ring).toFixed(1)
  const H = `hypot(X-${(S / 2).toFixed(1)},Y-${(S / 2).toFixed(1)})`

  // the camera kept rolling through pauses, but the screen take did not, so drop
  // the same spans or everything after the first pause drifts
  const camStart = cam.camStartedAt, scrStart = cam.screenStartedAt
  const skew = (camStart && scrStart) ? (scrStart - camStart) / 1000 : 0
  const gaps = (cam.gaps || [])
    .filter(g => Array.isArray(g) && g.length === 2 && camStart)
    .map(([a, b]) => [(a - camStart) / 1000, (b - camStart) / 1000])
    .filter(([a, b]) => b > a)

  const bits = [`movie='${filterPath(cam.file)}'`]
  if (gaps.length) {
    const keep = []
    let cur = 0
    for (const [a, b] of gaps) { if (a > cur) keep.push([cur, a]); cur = Math.max(cur, b) }
    keep.push([cur, 1e6])
    bits.push(`select='${keep.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join('+')}'`)
    bits.push('setpts=N/FRAME_RATE/TB')
  }
  // the camera session takes a moment to start, so it usually begins after the screen
  // take. Seeking cannot express that: those first frames do not exist, so hold the
  // bubble back with transparent padding instead of running it early.
  const raw = (baseSeek || 0) + skew
  const seek = Math.max(0, raw)
  const delay = Math.max(0, -raw)
  if (seek > 0.001) bits.push(`trim=start=${seek.toFixed(3)}`, 'setpts=PTS-STARTPTS')
  bits.push(`scale=${S}:${S}:force_original_aspect_ratio=increase`, `crop=${S}:${S}`, 'format=yuv420p')
  // circular cut with a white rim, matching the bubble on screen: a ring laid over
  // it and a circle merged in as alpha, both drawn once rather than every frame
  const rim = `${still(S, S, 'rgba', 'white')},geq=r=255:g=255:b=255:a='255*gt(${H},${RI})'[camring]`
  const disc = `${still(S, S, 'gray')},geq=lum='255*lt(${H},${RO})'[cammask]`
  // after the mask, so the held frames stay fully transparent instead of being filled in
  const hold = delay > 0.001 ? `,tpad=start_duration=${delay.toFixed(3)}:start_mode=add:color=#00000000` : ''
  return { pre: `${bits.join(',')}[camsq];${rim};${disc};` +
    `[camsq][camring]overlay=0:0,format=yuva420p[camr];[camr][cammask]alphamerge${hold}[cam];` +
    `[0:v][cam]overlay=${x}:${y}:eof_action=pass:format=auto[csrc]` }
}

// ---- sound -------------------------------------------------------------
// The audio half of an export, apart from the picture, so the new renderer can reuse
// it unchanged: { af: filters for the take's own track, extraGraph and extraMap for an
// added track (mixed under it, or in place of it) }. keep is the kept ranges when
// there are cuts, applied to the added track after its delay so a cut removes the
// same moment from both. extraInput is the added track's ffmpeg input index.
// base is the take's own sound as the graph has it: [0:a], or [cuta] once cuts took
// it through the cut graph (mixing [0:a] there left [cuta] unconnected and failed
// every export with both a cut and an added track).
function audioGraph({ hasAudio, denoise, loudnorm, gain, fadeIn = 0, fadeOut = 0, span = 0, extra = null, extraInput = 1, keep = null, base = '[0:a]' } = {}) {
  const af = []
  if (hasAudio) {
    if (denoise) af.push('afftdn=nr=12:nf=-25:tn=1', 'highpass=f=70')
    // -14 LUFS, where web players and every platform normalise to, so a finished
    // video is not the quiet one in a feed
    if (loudnorm !== false) af.push('loudnorm=I=-14:TP=-1:LRA=11')
    if (gain) af.push(`volume=${gain}dB`)
    if (fadeIn) af.push(`afade=t=in:st=0:d=${fadeIn}`)
    if (fadeOut && span) af.push(`afade=t=out:st=${Math.max(0, span - fadeOut).toFixed(2)}:d=${fadeOut}`)
  }
  if (!extra) return { af, extraGraph: null, extraMap: null }
  const off = Math.max(0, +extra.offset || 0)
  const vol = extra.volume == null ? 1 : +extra.volume
  const bits = [`[${extraInput}:a]atrim=start=0,asetpts=PTS-STARTPTS`]
  if (off > 0) bits.push(`adelay=${Math.round(off * 1000)}|${Math.round(off * 1000)}`)
  bits.push(`volume=${vol.toFixed(2)}`)
  if (+extra.fadeIn > 0) bits.push(`afade=t=in:st=${off}:d=${(+extra.fadeIn).toFixed(2)}`)
  if (+extra.fadeOut > 0 && span) {
    bits.push(`afade=t=out:st=${Math.max(0, span - +extra.fadeOut).toFixed(2)}:d=${(+extra.fadeOut).toFixed(2)}`)
  }
  let chain = bits.join(',') + '[extraRaw]'
  if (keep && keep.length) {
    const parts = keep.map(([a, b], i) => `[extraSplit${i}]atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=PTS-STARTPTS[extraCut${i}]`)
    chain += `;[extraRaw]asplit=${keep.length}` + keep.map((_, i) => `[extraSplit${i}]`).join('') + ';' +
      parts.join(';') + ';' + keep.map((_, i) => `[extraCut${i}]`).join('') + `concat=n=${keep.length}:v=0:a=1[extra]`
  } else {
    chain += ';[extraRaw]anull[extra]'
  }
  // replaced, a take's sound that went through the cuts still has to go somewhere
  if (extra.replace || !hasAudio) return { af, extraGraph: chain + (hasAudio && base !== '[0:a]' ? `;${base}anullsink` : ''), extraMap: '[extra]' }
  // duration=first keeps the output the length of the video, not the music
  return { af, extraMap: '[amixed]', extraGraph: chain + `;${base}${af.length ? af.join(',') : 'anull'}[base];` +
    `[base][extra]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[amixed]` }
}

// The sound of an export on its own, for the compositor (ui/render-host.js), which draws
// the picture elsewhere and muxes the two: the same kept ranges and the same audioGraph
// as applyEdit, AAC at 48 kHz stereo, span seconds long. Resolves to out, or null when
// there is no sound at all.
async function renderAudio(srcArg, opts, keep, span, meta, out, jobId) {
  const extra = opts.audioTrack && opts.audioTrack.file && fs.existsSync(opts.audioTrack.file) ? opts.audioTrack : null
  if (!meta.hasAudio && !extra) return null
  const hasCuts = (opts.cuts || []).some(c => Array.isArray(c) && c.length === 2)
  const parts = []
  if (meta.hasAudio) {
    keep.forEach(([a, b], i) => parts.push(`[0:a]atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=PTS-STARTPTS[ca${i}]`))
    parts.push(keep.map((_, i) => `[ca${i}]`).join('') + `concat=n=${keep.length}:v=0:a=1[cuta]`)
  }
  const fadeIn = +opts.fadeIn > 0 ? +opts.fadeIn : 0
  const fadeOut = +opts.fadeOut > 0 ? +opts.fadeOut : 0
  // an added track follows the cuts only when there are cuts, as in applyEdit
  const { af, extraGraph, extraMap } = audioGraph({
    hasAudio: meta.hasAudio, denoise: opts.denoise, loudnorm: opts.loudnorm, gain: opts.gain,
    fadeIn, fadeOut, span, extra, extraInput: 1, keep: hasCuts ? keep : null,
    base: meta.hasAudio ? '[cuta]' : '[0:a]',
  })
  let map = '[aout]'
  if (extraGraph) { parts.push(extraGraph); map = extraMap }
  else parts.push(`[cuta]${af.length ? af.join(',') : 'anull'}[aout]`)
  await run(FFMPEG, ['-y', '-i', srcArg, ...(extra ? ['-i', extra.file] : []), '-filter_complex', parts.join(';'),
    '-map', map, '-t', span.toFixed(3), '-vn', ...AUDIO_OUT, ...WEB_AUDIO, out], null, jobId)
  return out
}

async function applyEdit(srcArg, opts, onProgress, jobId) {
  // Say so plainly: a missing file used to surface as whichever check failed first
  if (!srcArg || !fs.existsSync(srcArg)) throw new Error(`No recording at ${srcArg}. It may have been renamed or deleted.`)
  const { src, meta: probed, done } = await ensureSeekable(srcArg, jobId)
  // A still (previewFrame) is one picture of the edit at opts.still, source seconds:
  // the same graph, no sound, stopped at that frame.
  const still = opts.still != null && Number.isFinite(+opts.still) ? +opts.still : null
  const meta = still != null ? { ...probed, hasAudio: false } : probed
  const tmpFiles = []
  let overlayDir = null
  try {
    const dur = meta.duration
    const start = Math.max(0, opts.start || 0)
    const end = opts.end && opts.end > start ? Math.min(opts.end, dur || opts.end) : (dur || 0)
    const outDur = end ? end - start : 0
    if (end && outDur < 0.2) throw new Error('trim range is too short')

    // output geometry: crop fractions × source dims, then scale to target height
    const srcH = meta.height || opts.videoH || 1080
    const srcW = meta.width || opts.videoW || 1920
    const c = opts.crop
    const croppedH = c ? Math.round(c.h * srcH) : srcH
    const croppedW = c ? Math.round(c.w * srcW) : srcW
    const outH = opts.scale === 1080 || opts.scale === 720 ? opts.scale : croppedH

    const fmtEarly = FORMATS[opts.format || 'mp4'] || FORMATS.mp4   // full fmt is resolved further down
    const outFmt = fmtEarly

    const vf = []
    // round crop to even pixels: libx264 rejects odd dimensions
    const cropFilter = c ? `crop=w='2*floor(iw*${c.w}/2)':h='2*floor(ih*${c.h}/2)':x='iw*${c.x}':y='ih*${c.y}'` : null
    if (cropFilter) vf.push(cropFilter)

    // Explicit zooms (Z1, Z2) apply whenever they exist, and win over auto-zoom: a
    // zoom someone asked for by name is a deliberate edit that supersedes the guess.
    // Auto-zoom only runs when switched on and nothing explicit was asked for. Both
    // read the clock of the trimmed output.
    // one clock for everything placed in time, so marks and zooms agree with each
    // other and with the cuts
    const clock = outClock(opts.cuts, start, end || dur)

    const even = n => 2 * Math.floor(n / 2)
    const frame = c ? { w: even((meta.width || 1920) * c.w), h: even((meta.height || 1080) * c.h) } : null
    // With a backdrop the video ends up at the framed size, and its geometry follows
    // the cropped frame (it used to follow the source, which squashed any crop).
    // Captions under a framed video get a band of their own below it, on the backdrop,
    // so a caption never sits on the product's text (Overlays.captionLayout)
    const cst0 = opts.captionStyle || {}
    const capBand = !!(opts.captions && opts.backdrop && fmtEarly.video && !fmtEarly.gif &&
      (!cst0.position || cst0.position === 'bottom') && cst0.fx == null &&
      ((Array.isArray(opts.cues) && opts.cues.length) || readCues(srcArg).length))
    const band = capBand ? Overlays.CAP_BAND : 0
    const bdGeo = opts.backdrop && fmtEarly.video && !fmtEarly.gif
      ? backdropGeometry(frame ? frame.w : srcW, frame ? frame.h : srcH, {
          inset: opts.inset, radius: opts.radius, scale: opts.scale, band,
          outWidth: opts.scale === 720 ? 1280 : 1920,
          outAspect: opts.backdropAspect || null,   // null keeps the source shape
        })
      : null
    // marks first: a redaction must cover the content wherever a zoom then moves it
    const content = c ? { w: 2 * Math.floor(srcW * c.w / 2), h: 2 * Math.floor(srcH * c.h / 2) } : { w: srcW, h: srcH }
    const outSpan = clock(end || dur)
    // the Mac's pointer out before anything is drawn over where it was
    const macSpans = macCursorSpans(srcArg, opts)
      .filter(s => clock(Math.min(s.b, dur || s.b)) - clock(s.a) > 0.02)
    if (macSpans.length) {
      const plates = await cursorPlates(src, macSpans, meta, jobId)
      for (const p of Object.values(plates)) tmpFiles.push(p.png)
      for (const f of cursorEraseFilters(macSpans, plates, clock, meta, c, content, outSpan)) vf.push(f)
    }
    // Every overlay animates on the clock, and libass and fade only draw on frames that
    // exist. A native take writes none while the screen is still, so a spotlight easing
    // in or a caption's highlight moving over a still screen froze, then jumped when the
    // next frame came. Constant rate before anything is drawn.
    if (fmtEarly.video && ((opts.marks || []).length || opts.captions || (opts.texts || []).length)) {
      vf.push(`fps=${zoomFps(meta)}`)
    }
    for (const mf of markFilters(opts.marks, clock, FONT, 'mk', content, outSpan)) vf.push(mf)
    // Lifts, spotlights and steps, drawn in the recording's own space so a zoom carries them
    const overlayFonts = assFonts(opts)
    overlayDir = overlayFonts.dir
    const drawn = await stepSpots(src, (opts.marks || []).filter(m => m && (m.kind === 'step' || Overlays.FOCUS_KINDS.includes(m.kind))), c, content)
    const onClock = drawn.map(m => ({ ...m, start: clock(m.start), end: clock(m.end) }))
    const zoomsOut = (opts.zooms || []).map(z => ({ start: clock(z.start), end: clock(z.end), scale: z.scale }))
    // output pixels per recorded pixel before any zoom, so an edge or a feather is
    // sized for the finished frame
    const pxOut = (bdGeo ? bdGeo.vidH : (opts.scale === 1080 || opts.scale === 720 ? opts.scale : content.h)) / content.h
    // the same ease the zooms themselves ride, so a lift or a spotlight on a zoom
    // takes that zoom's own ramp and not the default one (Overlays.spotlightSpan)
    const zoomCurve = (opts.autoZoomOpts || {}).curve
    for (const ff of focusFilters(onClock, zoomsOut, content, { px: pxOut, fps: zoomFps(meta), span: outSpan, curve: zoomCurve })) vf.push(ff)
    const contentAss = Overlays.contentScript({ W: content.w, H: content.h, marks: onClock, zooms: zoomsOut, px: pxOut, kind: zoomCurve })
    if (contentAss) {
      const ap = path.join(overlayFonts.dir, 'content.ass')
      fs.writeFileSync(ap, contentAss)
      vf.push(`ass='${filterPath(ap)}':fontsdir='${filterPath(overlayFonts.dir)}'`)
    }

    // The agent's cursor, over the marks and under any zoom, so a zoom magnifies it with
    // the content. On a constant rate first: a native take writes no frames while the
    // screen is still, which is exactly when the cursor glides to its next target.
    const ptr = pointerTrack(srcArg, opts)
    if (ptr) {
      const W = c ? 2 * Math.floor(srcW * c.w / 2) : srcW, H = c ? 2 * Math.floor(srcH * c.h / 2) : srcH
      // out: finished-frame pixels per pixel here, so the arrow is sized for the export
      const out = (bdGeo ? bdGeo.vidH : (opts.scale === 1080 || opts.scale === 720 ? opts.scale : H)) / H
      // rests moved off the words they name and kept inside whatever a zoom shows
      ptr.points = await pointerRests(src, ptr.points, start, end || dur)
      const zoomed = (opts.zooms || []).filter(z => z && z.end > z.start).map(z => ({ ...z, start: clock(z.start), end: clock(z.end) }))
      const geo = { W, H, clock, crop: c, scale: ptr.scale, end: clock(end || dur), out, zooms: zoomed }
      // the tag's name in the rounded bold the step badges use
      const font = { family: Overlays.FONT.num, measure: (s, px) => overlayFonts.measure(s, px, Overlays.FONT.num) }
      const ass = pointerLib.pointerAss(ptr.points, { ...geo, font })
      if (ass) {
        const fps = zoomFps(meta)
        const ap = path.join(overlayFonts.dir, 'pointer.ass')
        fs.writeFileSync(ap, ass)
        vf.push(`fps=${fps}`, `subtitles='${filterPath(ap)}':fontsdir='${filterPath(overlayFonts.dir)}'`)
        // Biscuit's badge rides the arrow. A picture, so an overlay whose place is an
        // expression of t (pointerBadge), evaluated on each frame, fading in with the arrow.
        const badge = pointerLib.pointerBadge(ptr.points, geo, fps)
        const png = [path.join(process.resourcesPath || '.', 'app', pointerLib.BADGE.file), path.join(__dirname, pointerLib.BADGE.file)]
          .find(f => fs.existsSync(f))
        if (badge && badge.moves.length && png) {
          const st = badge.start.toFixed(3)
          // Its soft shadow is made once with it, on a margin, so the two fade together:
          // the badge shows only while the cursor travels or clicks (pointerLib.badgeSpans),
          // its opacity a geq of T on a picture a few dozen pixels across.
          const d = badge.d, m = Math.round(d * 0.35), dy = Math.max(1, Math.round(d * 0.06))
          // a bounded loop: an endless one keeps the graph from ever finishing
          vf.push(`null[pba];` +
            `movie='${filterPath(png)}',scale=${d}:${d}:flags=lanczos,format=rgba,` +
            `pad=w=iw+${2 * m}:h=ih+${2 * m}:x=${m}:y=${m}:color=black@0,split[pbs][pbf];` +
            `[pbs]geq=r=0:g=0:b=0:a='0.42*alpha(X,Y-${dy})',gblur=sigma=${Math.max(1, d * 0.08).toFixed(2)}[pbh];` +
            `[pbh][pbf]overlay=format=auto,format=rgba,` +
            `loop=loop=${Math.ceil(badge.stop * fps) + fps}:size=1,setpts=N/(${fps}*TB),` +
            `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${badge.alpha})',` +
            `fade=t=in:st=${st}:d=0.16:alpha=1,format=yuva420p[pbb];` +
            `[pba][pbb]overlay=x='${badge.x}-${m}':y='${badge.y}-${m}':eval=frame:format=auto:enable='gte(t,${st})'`)
        }
      }
    }

    let zoomInfo = null
    // so zoom outputs straight at that size rather than scaling up to the source
    // size only for the backdrop to scale it down again
    const zoomTo = bdGeo ? { w: bdGeo.vidW, h: bdGeo.vidH } : frame
    if (opts.zooms && opts.zooms.length) zoomInfo = explicitZoomFilter(opts.zooms, meta, clock, zoomTo, (opts.autoZoomOpts || {}).curve)
    else if (opts.autoZoom) zoomInfo = autoZoomFilter(srcArg, meta, { ...(opts.autoZoomOpts || {}), pointer: opts.pointer }, clock, zoomTo, c)
    if (zoomInfo) {
      // ScreenCaptureKit writes a frame only when the screen changes, so a native take
      // is variable frame rate, with gaps of seconds on a still screen. zoompan emits
      // each input frame at the next constant slot, so every gap was squeezed out and
      // the picture ran ahead of the audio, the captions and the marks (seven seconds
      // by the half-minute on a real take). Constant rate first, then zoom.
      vf.push(`fps=${zoomFps(meta)}`)
      vf.push(zoomInfo.filter)
    }

    // framed, the backdrop sets the final size itself
    if ((opts.scale === 1080 || opts.scale === 720) && !bdGeo) vf.push(`scale=-2:${opts.scale}:flags=lanczos`)

    // A chosen output shape has to work with or without a backdrop. Without one, the
    // video is fitted inside the shape edge to edge, and the room it leaves is never
    // black: it is the take itself, blurred at a fraction of the size and pressed dark
    // and a little grey (the same ground as the blur backdrop), so a window take made
    // 16:9 reads as one picture rather than a letterbox.
    if (!opts.backdrop && opts.backdropAspect && fmtEarly.video && !fmtEarly.gif) {
      const ar = +opts.backdropAspect
      // cap the long edge, otherwise a portrait shape produces a 3414px tall frame
      const long = opts.scale === 720 ? 1280 : 1920
      const w = 2 * Math.round((ar >= 1 ? long : long * ar) / 2)
      const oh = 2 * Math.round((ar >= 1 ? long / ar : long) / 2)
      const fw = 2 * Math.max(8, Math.round(w / 64)), fh = 2 * Math.max(5, Math.round(oh / 64))
      const sigma = Math.max(2, 125 * (oh / 1080) * fh / oh)
      vf.push(`split[nbfg][nbbg];` +
        `[nbbg]scale=${fw}:${fh}:force_original_aspect_ratio=increase:flags=area,crop=${fw}:${fh},` +
        `gblur=sigma=${sigma.toFixed(2)}:steps=3,format=yuv444p,` +
        `lutyuv=y='16+(val-16)*0.3':u='128+(val-128)*0.8':v='128+(val-128)*0.8',vignette=angle=0.4:mode=forward,` +
        `scale=${w}:${oh}:flags=bicubic,noise=c0s=3:c0f=u,setsar=1,format=yuv420p[nbbk];` +
        `[nbfg]scale=${w}:${oh}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[nbfr];` +
        `[nbbk][nbfr]overlay=x=(W-w)/2:y=(H-h)/2:format=auto,format=yuv420p`)
    }

    // With a backdrop the video is inset, leaving a margin. Overlays used to be
    // drawn into the video before that composite, so they could never reach the
    // margin. When framed, draw them in a second pass over the composited frame.
    const framed = !!(opts.backdrop && outFmt.video && !outFmt.gif)
    const overlayFilters = []
    const target = framed ? overlayFilters : vf

    // Captions, title cards and labels, on the finished frame, from one ASS script
    // (ui/overlays.js). Every time goes through the clock, so a caption after a cut
    // still lands on its word and a title after a trim is not late by the trim.
    const cv = captionCanvas(framed && bdGeo, croppedW, croppedH, outH, opts)
    let phrases = null
    // Captions on means "burn them if there are any". Every new edit starts with it
    // on, so throwing here made a take with nothing to transcribe (no mic, no system
    // audio) impossible to export until someone found the toggle.
    if (opts.captions) {
      const cues = Array.isArray(opts.cues) && opts.cues.length ? opts.cues : readCues(srcArg)
      let wordsDoc = null
      try { wordsDoc = JSON.parse(fs.readFileSync(sidecarIn(srcArg, '.words.json'), 'utf8')) } catch {}
      // on the voice, not the recogniser's early guess (Overlays.snapToSpeech)
      const toks = Overlays.spokenWords(cues, wordsDoc)
        .filter(w => clock.kept(w.start))
        .map(w => ({ ...w, start: clock(w.start), end: clock(Math.max(w.start, w.end)) }))
      // in the band below a framed video a phrase has the width for one line
      if (toks.length) phrases = Overlays.captionPhrases(toks, capBand ? { wrapAt: Overlays.BAND_WRAP } : {})
      // a caption never lands on the product's own toast: those phrases go to the top
      const cst = opts.captionStyle || {}
      if (phrases && fmtEarly.video && !capBand && (!cst.position || cst.position === 'bottom') && cst.fx == null) {
        // a still needs only the seconds around its own caption judged
        const busyEnd = still != null ? Math.min(end || dur, still + 4) : end || dur
        const busy = await captionClutterTimes(src, { start, end: busyEnd, crop: c, zooms: opts.zooms, autoZoom: opts.autoZoom, clock })
        const framed = (opts.zooms || []).filter(z => z && z.end > z.start).map(z => ({ a: clock(z.start), b: clock(z.end) }))
        if (busy.length) phrases = Overlays.placeCaptions(phrases, busy, framed)
      }
    }
    const texts = (opts.texts || []).filter(t => t && String(t.text || '').trim()).map(t => {
      const timed = t.start != null && t.end != null && t.end > t.start
      return { ...t, start: timed ? clock(t.start) : null, end: timed ? clock(t.end) : null, family: overlayFonts.family(t.font) }
    }).filter(t => t.start == null || t.end > t.start)
    const cards = fmtEarly.video ? Overlays.titleCards(texts, outSpan) : []
    if (phrases) phrases = Overlays.clearOfTitles(phrases, cards)
    cards.forEach((card, i) => target.push(cardFilter({ ...card, fps: zoomFps(meta) }, cv.w, cv.h, `tc${i}`, outSpan)))
    // as an opening card clears, the framed video scales up into place
    const opening = cards.find(k => k.opens)
    const reveal = opening ? { at: opening.b - cardLanding(opening), dur: cardLanding(opening) } : null
    // and as a closing card gathers, it settles back
    const closing = cards.find(k => !k.opens && k.b >= outSpan - 0.05)
    const close = closing ? { at: closing.a, dur: Math.min(1.2, closing.fade + 0.5) } : null
    const capBox = framed && bdGeo ? { x: bdGeo.ox, y: bdGeo.oy, w: bdGeo.vidW, h: bdGeo.vidH } : null
    // Framed, captions sit on frosted glass: the frame blurred through a feathered mask
    // drawn by libass, so the UI under a caption goes soft instead of reading through
    // it. Only framed, where the composite's size is known exactly: alphamerge needs
    // the mask and the blurred band to match to the pixel.
    const frost = capBox && fmtEarly.video
      ? Overlays.captionFrost({ W: cv.w, H: cv.h, phrases, capStyle: opts.captionStyle || {}, measure: overlayFonts.measure, box: capBox })
      : null
    // one band for the captions at the bottom, and one for any moved to the top
    if (frost) frost.bands.forEach((fb, i) => {
      const mp = path.join(overlayFonts.dir, `frost${i}.ass`)
      fs.writeFileSync(mp, fb.script)
      const band = `crop=${cv.w}:${fb.h}:0:${fb.y}`
      target.push(`split[cfm${i}][cfc${i}];[cfc${i}]${band},gblur=sigma=${(cv.h * 0.009).toFixed(2)}[cfb${i}];` +
        `color=c=black:s=${cv.w}x${fb.h}:r=${zoomFps(meta)}:d=${(outSpan + 1).toFixed(3)},` +
        `ass='${filterPath(mp)}',format=gray[cfk${i}];` +
        `[cfb${i}][cfk${i}]alphamerge[cfa${i}];[cfm${i}][cfa${i}]overlay=0:${fb.y}:eof_action=pass:format=auto`)
    })
    const frameAss = Overlays.frameScript({ W: cv.w, H: cv.h, phrases, capStyle: opts.captionStyle || {},
      texts, span: outSpan, measure: overlayFonts.measure, box: capBox, frosted: !!frost })
    if (frameAss) {
      const ap = path.join(overlayFonts.dir, 'frame.ass')
      fs.writeFileSync(ap, frameAss)
      target.push(`ass='${filterPath(ap)}':fontsdir='${filterPath(overlayFonts.dir)}'`)
    }

    const fadeIn = +opts.fadeIn > 0 ? +opts.fadeIn : 0
    const fadeOut = +opts.fadeOut > 0 ? +opts.fadeOut : 0
    const span = outDur || dur || 0
    // Framed, the fade takes the whole finished frame, backdrop, captions and title
    // card included, as it does unframed; on the video alone the backdrop stayed lit.
    if (fadeIn) target.push(`fade=t=in:st=0:d=${fadeIn}`)
    if (fadeOut && span) target.push(`fade=t=out:st=${Math.max(0, span - fadeOut).toFixed(2)}:d=${fadeOut}`)

    // An added audio track: people often record voice separately. It can sit
    // under the recording's own audio, or replace it entirely.
    const extra = opts.audioTrack && opts.audioTrack.file && fs.existsSync(opts.audioTrack.file)
      ? opts.audioTrack : null


    // camera overlay feeds the rest of the graph in place of the raw video
    const camTake = opts.camera && opts.camera.file && fs.existsSync(opts.camera.file)
      ? opts.camera : null
    const hasCuts = (opts.cuts || []).filter(c => Array.isArray(c) && c.length === 2).length > 0
    const camG = camTake ? camChain(camTake, srcW, srcH, (!hasCuts && start > 0) ? start : 0) : null
    const VSRC = camG ? '[csrc]' : '[0:v]'

    // cut list: removed ranges become a trim and concat graph feeding the vf chain
    const cuts = (opts.cuts || []).filter(c => Array.isArray(c) && c.length === 2)
    let cutGraph = null, cutDur = 0
    if (cuts.length) {
      const keep = keepRanges(cuts, start, end || dur)
      if (!keep.length) throw new Error('those cuts remove the whole clip')
      cutDur = keep.reduce((a, [x, y]) => a + (y - x), 0)
      const parts = []
      keep.forEach(([a, b], i) => {
        parts.push(`${VSRC}trim=${a.toFixed(3)}:${b.toFixed(3)},setpts=PTS-STARTPTS[cv${i}]`)
        if (meta.hasAudio) parts.push(`[0:a]atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=PTS-STARTPTS[ca${i}]`)
      })
      parts.push(keep.map((_, i) => `[cv${i}]`).join('') + `concat=n=${keep.length}:v=1:a=0[cutv]`)
      if (meta.hasAudio) parts.push(keep.map((_, i) => `[ca${i}]`).join('') + `concat=n=${keep.length}:v=0:a=1[cuta]`)
      cutGraph = parts.join(';')
    }

    const fmt = FORMATS[opts.format || 'mp4'] || FORMATS.mp4
    // The added track is always input 1: it is added right after the take, before any
    // backdrop image. It used to be read as input 2 whenever an image backdrop was on,
    // which swapped the two and failed the export.
    const { af, extraGraph, extraMap } = audioGraph({
      hasAudio: meta.hasAudio, denoise: opts.denoise, loudnorm: opts.loudnorm, gain: opts.gain,
      fadeIn, fadeOut, span, extra, extraInput: 1,
      keep: cutGraph ? keepRanges(cuts, start, end || dur) : null,
      base: cutGraph && meta.hasAudio ? '[cuta]' : '[0:a]',
    })

    const camPrefix = () => camG ? camG.pre + ';' : ''

    // A take folder's export is its deliverable, rewritten each time; a loose file on
    // the Desktop keeps its -edit copy beside it. A preview (previewFrame) names its
    // own scratch file and never touches either.
    const deliverable = opts.dest ? null : deliverablePath(srcArg, fmt.ext)
    const dest = opts.dest || exportDest(srcArg, fmt.ext)
    // The deliverable is encoded beside itself and swapped in once finished: ffmpeg
    // cannot read and write one file, and a cancelled or failed re-export must not
    // destroy the last good one.
    const out = deliverable
      ? path.join(path.dirname(dest), `.${path.parse(dest).name}.partial.${fmt.ext}`) : dest
    if (out !== dest) tmpFiles.push(out)
    const args = ['-y']
    // with cuts the trim happens inside the graph, so do not also seek the input
    if (!cutGraph && start > 0) args.push('-ss', String(start))
    args.push('-i', src)
    if (extra) args.push('-i', extra.file)
    // Bound the output on every path. The backdrop is a generated colour source with no
    // end, and its overlays carry no shortest, so once the video runs out nothing stops
    // it except this. The cut path had no bound at all, which is why an export with both
    // a cut and a backdrop ran forever. It went unnoticed because the same combination
    // used to crash first on an -af error, which masked the hang behind it.
    const bound = cutGraph ? cutDur : outDur
    if (bound > 0) args.push('-t', bound.toFixed(3))

    if (fmt.gif) {
      // one-pass palette chain, appended after any crop/scale/text the user set
      vf.push(`fps=${opts.gifFps || 12}`)
      if (opts.scale !== 1080 && opts.scale !== 720) vf.push(`scale=${opts.gifWidth || 640}:-1:flags=lanczos`)
      vf.push('split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3')
    }
    if (cutGraph && !(opts.backdrop && fmt.video && !fmt.gif)) {
      const chain = [cutGraph]
      chain.push(vf.length ? `[cutv]${vf.join(',')}[vout]` : `[cutv]null[vout]`)
      if (meta.hasAudio && !extraGraph) chain.push(af.length ? `[cuta]${af.join(',')}[aout]` : `[cuta]anull[aout]`)
      if (extraGraph) chain.push(extraGraph)
      args.push('-filter_complex', camPrefix() + chain.join(';'), '-map', '[vout]')
      if (extraMap) args.push('-map', extraMap)
      else if (meta.hasAudio) args.push('-map', '[aout]')
    } else if (opts.backdrop && fmt.video && !fmt.gif) {
      // framed look: everything above feeds [vin], then the backdrop composites it
      const geo = backdropChain('vin', frame ? frame.w : srcW, frame ? frame.h : srcH, {
        backdrop: opts.backdrop, inset: opts.inset, radius: opts.radius, shadow: opts.shadow, scale: opts.scale, fps: zoomFps(meta), band,
        imageInput: extra ? 2 : 1,
        outWidth: opts.scale === 720 ? 1280 : 1920,
        outAspect: opts.backdropAspect || null,   // null keeps the source shape
        reveal, close,
        gutter: await frameGutter(src, start, end || dur, c),
        // the blurred ground from the whole frame, before any zoom, on a constant rate
        // so the composite keeps the zoom's frames (a native take is variable rate)
        fill: BACKDROPS[opts.backdrop] && BACKDROPS[opts.backdrop].video ? 'bdraw' : null,
      })
      const srcLabel0 = cutGraph ? '[cutv]' : VSRC
      const srcLabel = geo.fill ? '[vsrc0]' : srcLabel0
      const pre = (cutGraph ? cutGraph + ';' : '') +
        (geo.fill ? `${srcLabel0}split[vsrc0][bdraw0];[bdraw0]${cropFilter ? cropFilter + ',' : ''}fps=${zoomFps(meta)}[bdraw];` : '') +
        (vf.length ? `${srcLabel}${vf.join(',')}[vin];` : `${srcLabel}null[vin];`)
      for (const extra of geo.inputs || []) args.push('-i', extra)
      const post = overlayFilters.length ? `;[vout]${overlayFilters.join(',')}[vfinal]` : ''
      // Cut audio is a graph output, so its filters have to live in the graph too:
      // ffmpeg refuses an -af on a stream fed from a complex filtergraph.
      const cutAudio = cutGraph && meta.hasAudio && !extraGraph
        ? ';' + (af.length ? `[cuta]${af.join(',')}[aout]` : `[cuta]anull[aout]`) : ''
      const audioPart = (extraGraph ? ';' + extraGraph : '') + cutAudio
      args.push('-filter_complex', camPrefix() + pre + geo.chain + post + audioPart, '-map', post ? '[vfinal]' : '[vout]')
      if (extraMap) args.push('-map', extraMap)
      else if (meta.hasAudio) args.push('-map', cutGraph ? '[aout]' : '0:a?')
    } else if (extraGraph) {
      const chain = [vf.length ? `${VSRC}${vf.join(',')}[vout]` : `${VSRC}null[vout]`, extraGraph]
      args.push('-filter_complex', camPrefix() + chain.join(';'), '-map', '[vout]', '-map', extraMap)
    } else if (camG) {
      // a simple -vf graph cannot take the second stream the overlay needs
      const chain = vf.length ? `${VSRC}${vf.join(',')}[vout]` : `${VSRC}null[vout]`
      args.push('-filter_complex', camPrefix() + chain, '-map', '[vout]')
      if (meta.hasAudio) args.push('-map', '0:a?')
    } else {
      if (fmt.video && vf.length) args.push('-vf', vf.join(','))
    }
    // Only when the audio is a plain input stream. On any cut path it is a graph output
    // that already carries these filters, and applying them a second time as -af is
    // not merely redundant: ffmpeg rejects it, which made every export containing a
    // cut fail, since loudness normalisation is on by default.
    const audioFromGraph = cutGraph && meta.hasAudio
    if (af.length && !fmt.gif && !extraGraph && !audioFromGraph) args.push('-af', af.join(','))
    if (still != null) {
      // seeking on the output runs the whole graph up to the frame, so eases, fades
      // and overlays stand exactly where the export has them
      const at = Math.max(0, clock(still))
      args.push('-ss', at.toFixed(3), '-frames:v', '1', '-an', '-q:v', '3', '-update', '1')
    } else {
      args.push(...fmt.args(opts.quality))
      if (fmt.video && !fmt.gif && !meta.hasAudio) args.push('-an')
    }
    args.push(out)

    await run(FFMPEG, args, timeWatcher(onProgress, cutDur || span), jobId)
    if (opts.music && still == null && fmt.video && !fmt.gif) {
      const bed = await musicBed(out, opts.music, fmt, cutDur || span, meta.hasAudio, jobId)
      if (bed) fs.renameSync(bed, out)
    }
    if (out !== dest) fs.renameSync(out, dest)
    return { file: dest, duration: +((cutDur || span) || await probeDuration(dest)).toFixed(1),
             cuts: cuts.length,
             format: fmt.ext, mb: +(fs.statSync(dest).size / 1e6).toFixed(1) }
  } finally {
    tmpFiles.forEach(f => { try { fs.unlinkSync(f) } catch {} })
    if (overlayDir) fs.rmSync(overlayDir, { recursive: true, force: true })
    done()
  }
}

// ---- a music bed under the voice ---------------------------------------
// Three beds ship in assets/music (made by tools/make-beds.js, so there is no licence
// to track). A bed sits well under the voice: about 16 dB below it where nobody speaks,
// and pressed a further 6 dB or so while someone does (sidechaincompress keyed on the
// voice), so the words never fight it. It fades in over the first second and out over
// the last two, looping for a take longer than itself.
const MUSIC_BEDS = { warm: 'Warm', bright: 'Bright', calm: 'Calm' }
const musicList = () => Object.entries(MUSIC_BEDS).map(([id, label]) => ({ id, label }))
function musicFile(id) {
  if (!MUSIC_BEDS[id]) return null
  return [path.join(process.resourcesPath || '.', 'app', 'assets', 'music', `${id}.m4a`),
    path.join(__dirname, 'assets', 'music', `${id}.m4a`)].find(f => fs.existsSync(f)) || null
}
// music is a bed id, or { bed, level } with level in dB against the bed's own (-10 default)
async function musicBed(file, music, fmt, dur, hasVoice, jobId) {
  const id = typeof music === 'string' ? music : music && music.bed
  const bedFile = musicFile(id)
  if (!bedFile || !(dur > 0.5)) return null
  const level = Math.max(-30, Math.min(0, music && music.level != null ? +music.level : -10))
  const fadeOut = Math.min(2, dur / 4)
  const bed = `[1:a]atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,` +
    `volume=${level}dB,afade=t=in:d=1,afade=t=out:st=${(dur - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`
  const graph = hasVoice
    ? `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit[v][key];${bed}[m];` +
      `[m][key]sidechaincompress=threshold=0.015:ratio=4:attack=80:release=600:makeup=1[md];` +
      `[v][md]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`
    : `${bed}[a]`
  const acodec = fmt.ext === 'webm' ? ['-c:a', 'libopus', '-b:a', '128k'] : ['-c:a', 'aac', '-b:a', '192k']
  const tmp = path.join(path.dirname(file), `.${path.parse(file).name}.music.${fmt.ext}`)
  await run(FFMPEG, ['-y', '-i', file, '-stream_loop', '-1', '-i', bedFile, '-filter_complex', graph,
    '-map', '0:v?', '-map', '[a]', '-c:v', 'copy', ...acodec, '-ar', '48000', '-ac', '2',
    '-t', dur.toFixed(3), ...(fmt.ext === 'mp4' || fmt.ext === 'mov' ? ['-movflags', '+faststart'] : []), tmp], null, jobId)
  return tmp
}

// ---- one frame of the edit, as export would draw it --------------------
// For checking an edit before reporting it: the zoom where it lands, the marks, the
// captions and the backdrop, at one moment. The export's own graph (applyEdit, still
// mode), started a little before the moment rather than at the top, so it costs a
// couple of seconds wherever the moment is. It starts early enough for every ease that
// is under way at `at` (a zoom, a pan from the zoom before it, a spotlight) to be drawn
// from its own beginning, so nothing is caught half-way through a move that is not.
async function previewFrame(srcArg, doc, atSec) {
  const meta = await probeMeta(srcArg)
  // a WebM straight from a recorder reports no duration; the document knows it
  const dur = meta.duration || (doc && +doc.dur) || 0
  const d = fetchdoc.normalize(doc, srcArg, dur)
  if (!d.clips.length) d.clips = [{ id: 'C1', start: 0, end: dur }]
  const opts = fetchdoc.toExportOpts(d)
  const first = opts.start || 0, last = opts.end || dur
  const at = Math.min(Math.max(first, +atSec || 0), Math.max(first, last - 0.05))
  const zooms = (opts.zooms || []).filter(z => z && z.end > z.start)
  // back to where the oldest move still showing began, and a zoom that pans into it
  let a = at - 2
  for (let moved = true; moved;) {
    moved = false
    for (const z of zooms) {
      if (z.end >= a - 1 && z.start < a && z.start <= at + 0.05) { a = Math.max(first, z.start - 1.5); moved = true }
    }
    if (a <= first) break
  }
  // A text's style is judged on the whole edit's clock (a centred line in the first
  // second is a title), so it is settled here, where that clock is known.
  const whole = outClock(opts.cuts, first, last), span = whole(last)
  const on = t => t && t.start != null && t.end != null && t.start <= at && t.end >= at
  const texts = (opts.texts || []).filter(t => t && (t.start == null || t.start <= at + 0.05)).map(t => {
    const timed = t.start != null && t.end != null
    return { ...t, style: Overlays.textStyle({ ...t, start: timed ? whole(t.start) : null, end: timed ? whole(t.end) : null }, span) }
  })
  // A title on screen is drawn from its start, as is a mark that came in lately; one on
  // for the whole take (a blur over an email address) is simply on from the first frame.
  for (const t of texts) if (on(t) && t.style === 'title') a = Math.min(a, t.start - 1.5)
  for (const m of opts.marks || []) if (on(m) && m.start >= at - 6) a = Math.min(a, m.start - 1)
  a = Math.max(first, a)
  // steps number themselves in order, so each keeps the number it has in the whole edit
  let k = 0
  const marks = (opts.marks || []).map(m => (m && m.kind === 'step' && ++k && (m.n == null || m.n === '') ? { ...m, n: k } : m))
    .filter(m => m && m.end > a && m.start <= at + 0.05)
  const dest = path.join(os.tmpdir(), `fetch-preview-${path.parse(srcArg).name}-${at.toFixed(2)}.jpg`)
  await applyEdit(srcArg, {
    ...opts, start: a, marks, dest, still: at, format: 'mp4',
    zooms: zooms.filter(z => z.start <= at + 2),
    texts,
    fadeIn: a > first ? 0 : opts.fadeIn,
    audioTrack: null,
  })
  if (!fs.existsSync(dest)) throw new Error('could not draw that moment')
  // the export's own size is 1920 wide; a model reads UI text as well at 1280, for
  // about half the image tokens
  const small = dest.replace(/\.jpg$/, `-${Date.now().toString(36)}.jpg`)
  await run(FFMPEG, ['-y', '-i', dest, '-vf', "scale='min(1280,iw)':-2:flags=lanczos", '-q:v', '3', small])
  try { fs.unlinkSync(dest) } catch {}
  return { file: small, at: +at.toFixed(2) }
}

// ── the edit document ────────────────────────────────────────────────────────
// One file per recording holding everything about its edit. See ui/fetchdoc.js
// for why it exists and what the ids mean.
const fetchdoc = require('./ui/fetchdoc')
const pointerLib = require('./ui/pointer')

function readDoc(src, dur) {
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(sidecarIn(src, '.fetchdoc.json'), 'utf8')) } catch {}
  // where the page sat in the browser, from the agent's pointer reports during the take
  if (!(raw && raw.viewport)) {
    let vp = null
    try { vp = (readPointer(src) || {}).viewport || null } catch {}
    if (vp) raw = { ...(raw || { v: 2 }), viewport: vp }
  }
  return fetchdoc.normalize(raw, src, dur)
}

function writeDoc(src, doc) {
  // sidecarOut makes its folder, so a late write for a trashed take would resurrect it
  if (!src || !fs.existsSync(src)) throw new Error('no such recording: ' + src)
  const out = fetchdoc.normalize(doc, src, doc && doc.dur)
  fs.writeFileSync(sidecarOut(src, '.fetchdoc.json'), JSON.stringify(out, null, 2))
  return out
}

// Beats for a recording, preferring speech and falling back to the pointer. Reads
// the persisted word timings rather than transcribing again.
function beatsFor(src, dur) {
  try {
    const w = JSON.parse(fs.readFileSync(sidecarIn(src, '.words.json'), 'utf8'))
    const words = (w.words || []).map(x => ({ word: x.w, startTime: x.t, endTime: x.t }))
    const beats = buildBeats(words, w.speech || [], dur || w.dur)
    if (beats.length) return beats
  } catch {}
  try { return beatsFromCursor(readCursor(src), dur) } catch {}
  return []
}

module.exports = {
  frameAt, findOnScreen, boxSamples, previewFrame, frameGutter, audioGraph,
  backdropList, musicList, filmstrip,
  toMp4, convert, removeSilence, enhanceAudio, trim, transcribe, burnCaptions, toGif,
  thumbnail, waveform, applyEdit, listRecordings, importFile, forgetFile,
  probeMeta, readCues, writeCues, cancel, runningJobs, formatList, FFMPEG, flattenAudio,
  sidecarOut, sidecarIn, migrateSidecars,
  setTakesRoot, takeDir, deliverablePath, exportDest, renameTake, readNameNote, writeNameNote, takeName,
  speechRegions, buildBeats, buildCues, beatsFromCursor, readCursor, readPointer, pointerTrack, macCursorSpans, cursorPlates, cursorEraseFilters,
  zoomMoments, zoomExpr, autoZoomFilter, explicitZoomFilter, focusFilters, outClock, backdropGeometry,
  readDoc, writeDoc, beatsFor,
  // for the compositor's export (ui/render-host.js)
  renderAudio, musicBed, register, unregister, run, FORMATS, imageBackdrops,
  // what the compositor works out once per take (ui/compositor/prepare.js)
  stepSpots, pointerRests, captionClutterTimes, ensureSeekable, FONT_FILES,
  fontList: () => Object.keys(FONT_FILES),
}
