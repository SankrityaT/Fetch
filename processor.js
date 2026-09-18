// ffmpeg-based local processing engine. Every job runs the bundled static
// binary. No network, no uploads.
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

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
  return meta
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

// quality → x264 crf / vp9 crf (lower = better)
const CRF = { high: 19, balanced: 23, small: 28 }

// every container we can write, with the codecs that container actually accepts
const FORMATS = {
  mp4:  { ext: 'mp4',  label: 'MP4 (H.264)',        video: true,
          args: q => [...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(CRF[q] ?? 23), '-pix_fmt', 'yuv420p'], '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'] },
  mov:  { ext: 'mov',  label: 'MOV (QuickTime)',    video: true,
          args: q => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(CRF[q] ?? 23), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'] },
  webm: { ext: 'webm', label: 'WebM (VP9)',         video: true,
          args: q => ['-c:v', 'libvpx-vp9', '-crf', String((CRF[q] ?? 23) + 8), '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k'] },
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
  await run(FFMPEG, ['-y', '-fflags', '+genpts', '-i', srcArg, '-vn', '-ac', '1', '-ar', '16000',
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

const assTime = s => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.max(0, s % 60)
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`
}

// A caption dragged off its preset cannot be expressed with force_style, which only
// carries an Alignment and margins, so a dragged caption previewed in one place and
// burned in somewhere else. libass takes an absolute \pos in PlayRes space, so match
// PlayRes to the output pixels and the burn lands exactly where the editor showed it.
function cuesToAss(cues, W, H, o = {}) {
  const size = Math.max(10, Math.min(44, Math.round(20 * (o.scale ?? 1))))
  const px = Math.max(8, Math.round(size * H / 288))   // same visual size as the SRT path
  const boxed = o.boxed !== false
  const edge = assColour(o.outline || '#000000', boxed ? 0x90 : 0x40)
  const fill = assColour(o.colour || '#FFFFFF')
  const x = Math.round(Math.min(1, Math.max(0, +o.fx)) * W)
  const y = Math.round(Math.min(1, Math.max(0, +o.fy)) * H)
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`,
    'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, ' +
      'BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, ' +
      'BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Alignment 5 anchors on the middle centre, matching the preview's translate(-50%,-50%)
    `Style: Default,${o.font || SUB_FONT},${px},${fill},${fill},${edge},${edge},` +
      `${o.bold === false ? 0 : 1},0,0,0,100,100,0,0,${boxed ? 4 : 1},${boxed ? 3 : 2},0,5,40,40,28,1`,
    '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const body = cues.map(c => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,` +
    `{\\pos(${x},${y})}` + String(c.text || '').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N'))
  return head.concat(body).join('\n') + '\n'
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
const SIDE_EXT = ['.png', '.srt', '.txt', '.cursor.json', '.cam.json', '.cam.mov', '.words.json', '.fetchdoc.json', '.vo.mp3']

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
    for (let n = 2; fs.existsSync(dest) || loose.has(path.basename(dest).toLowerCase()); n++) dest = `${base} ${n}`
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
async function frameAt(srcArg, atSec, maxW = 1280, crop = null) {
  const { src, meta, done } = await ensureSeekable(srcArg)
  try {
    const at = Math.min(Math.max(0, +atSec || 0), Math.max(0, (meta.duration || 1) - 0.05))
    const dest = path.join(os.tmpdir(), `fetch-frame-${path.parse(srcArg).name}-${at.toFixed(2)}.jpg`)
    const c = crop && crop.w > 0 && crop.h > 0 ? crop : null
    const vf = (c ? `crop=w='2*floor(iw*${c.w}/2)':h='2*floor(ih*${c.h}/2)':x='iw*${c.x}':y='ih*${c.y}',` : '') +
      `scale='min(${maxW},iw)':-2`
    await run(FFMPEG, ['-y', '-ss', String(at), '-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '4', dest])
    if (!fs.existsSync(dest)) throw new Error('could not grab a frame at that time')
    return { file: dest, at: +at.toFixed(2), width: meta.width, height: meta.height }
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
function listRecordings(root = takesRoot()) {
  const out = new Map()
  const add = (full, extra) => { if (!out.has(full)) try { out.set(full, { ...describe(full), ...extra }) } catch {} }
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
  for (const full of readIndex()) {
    if (out.has(full) || !fs.existsSync(full)) continue
    try { out.set(full, { ...describe(full), imported: true }) } catch {}
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
function readCursor(srcArg) {
  const p = sidecarIn(srcArg, '.cursor.json')
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

// smoothstep, written the way ffmpeg's expression parser wants it
const ramp = (t, a, b) => `(${t}-${a})/(${b}-${a})`
const smooth = p => `(${p})*(${p})*(3-2*(${p}))`

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
  const ease = opts.ease ?? 0.45         // seconds to push in, and to pull back
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
  const groups = []
  for (const e of events) {
    const last = groups[groups.length - 1]
    if (last && e.t - last.until < gap && Math.hypot(e.x - last.x, e.y - last.y) < near) { last.until = e.t; continue }
    groups.push({ t: e.t, until: e.t, x: e.x, y: e.y })
  }
  const moments = groups.map(g => ({
    inStart: Math.max(0, g.t - ease),
    inEnd: g.t,
    outStart: g.until + hold,
    outEnd: g.until + hold + ease,
    x: g.x, y: g.y,
  }))
  // A click somewhere else before the last moment has let go: pull back in time for
  // it rather than jumping the pan mid-zoom.
  for (let i = 1; i < moments.length; i++) {
    const p = moments[i - 1], n = moments[i]
    if (p.outEnd <= n.inStart) continue
    p.outEnd = Math.max(p.inEnd + 0.1, n.inStart)
    p.outStart = Math.max(p.inEnd, p.outEnd - ease)
  }
  return moments
}

// nested if() chain: one branch per moment, 1.0 everywhere else
function zoomExpr(moments, disp, zMax, trimStart) {
  const T = 'in_time'
  let z = '1', fx = '0.5', fy = '0.5'
  for (let i = moments.length - 1; i >= 0; i--) {
    const m = moments[i]
    const a = (m.inStart - trimStart), b = (m.inEnd - trimStart)
    const c = (m.outStart - trimStart), d = (m.outEnd - trimStart)
    if (d <= 0) continue
    const upP = smooth(ramp(T, a.toFixed(3), b.toFixed(3)))
    const downP = smooth(ramp(T, d.toFixed(3), c.toFixed(3)))   // reversed: 0 at d, 1 at c
    const amount = `if(lt(${T},${b.toFixed(3)}),${upP},if(lt(${T},${c.toFixed(3)}),1,${downP}))`
    const inWindow = `between(${T},${a.toFixed(3)},${d.toFixed(3)})`
    // Per-moment scale lets an explicit zoom say how far it goes. Auto-zoom moments
    // carry none and fall back to the single global amount exactly as before.
    const zm = m.scale != null ? m.scale : zMax
    z = `if(${inWindow},1+${(zm - 1).toFixed(3)}*(${amount}),${z})`
    const cx = Math.min(1, Math.max(0, (m.x - disp.x) / disp.width)).toFixed(4)
    const cy = Math.min(1, Math.max(0, (m.y - disp.y) / disp.height)).toFixed(4)
    fx = `if(${inWindow},${cx},${fx})`
    fy = `if(${inWindow},${cy},${fy})`
  }
  return { z, fx, fy }
}

// returns a zoompan filter string, or null when there is nothing to zoom to
// Zooms asked for by name (Z1, Z2) rather than guessed from where the pointer
// settled. Same easing and the same expression builder as auto-zoom, so the two look
// identical on screen. Coordinates are 0..1 fractions of the frame, which is what an
// agent can reason about, rather than screen pixels it cannot see.
// The rate zoom output runs at: 60 for a 60fps source, otherwise 30. A variable-rate
// take reports its average (44 here), which is not a rate anything should play at.
const zoomFps = meta => ((meta.fps || 30) >= 45 ? 60 : 30)

function explicitZoomFilter(zooms, meta, clock, frame) {
  const list = (zooms || []).filter(z => z && z.end > z.start)
  if (!list.length) return null
  const ease = 0.45
  const moments = list.map(z => {
    const s0 = clock(z.start), s1 = clock(z.end)
    const e = Math.min(ease, Math.max(0, (s1 - s0) / 2))
    return {
      inStart: s0, inEnd: s0 + e,
      outStart: s1 - e, outEnd: s1,
      x: z.x != null ? z.x : 0.5, y: z.y != null ? z.y : 0.5,
      scale: Math.max(1.05, Math.min(4, z.scale || 1.8)),
    }
  }).sort((a, b) => a.inStart - b.inStart)
  const { z, fx, fy } = zoomExpr(moments, UNIT, 1.8, 0)   // already on the output clock
  return { filter: zoompan(z, fx, fy, meta, frame), moments: moments.length }
}

const UNIT = { x: 0, y: 0, width: 1, height: 1 }

// frame is the size zoompan outputs: the cropped frame, or the framed video's size
// when a backdrop will shrink it anyway, so zoom never scales pixels it then throws
// away. Using the source size stretched every cropped recording that had a zoom.
function zoompan(z, fx, fy, meta, frame) {
  const w = (frame && frame.w) || meta.width || 1920, h = (frame && frame.h) || meta.height || 1080
  // fx,fy is the point to centre on, held centred at every step of the ease and
  // clamped only where the frame edge forces it. It used to be a pan fraction, which
  // put a 2x zoom aimed at 0.85 centred on 0.675.
  const x = `max(0,min(iw-iw/zoom,iw*(${fx})-iw/zoom/2))`
  const y = `max(0,min(ih-ih/zoom,ih*(${fy})-ih/zoom/2))`
  return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${w}x${h}:fps=${zoomFps(meta)}`
}

// Source time to output time. The video filters run after cuts are concatenated, so
// the output clock is contiguous across the kept ranges: a moment 3s after a 2s cut
// sits 2s earlier in the output than in the source. Subtracting only the trim start,
// which is what the zoom code did, put every zoom after a cut late by the length of
// the cut. A time inside a cut does not exist in the output and snaps to where the
// next kept range begins.
function outClock(cuts, start, end) {
  const keep = (cuts && cuts.length) ? keepRanges(cuts, start, end) : [[start, end]]
  const clock = t => {
    let acc = 0
    for (const [a, b] of keep) {
      if (t < a) return acc
      if (t <= b) return acc + (t - a)
      acc += b - a
    }
    return acc
  }
  // Whether a source time survives into the output at all. A click inside a cut has
  // to be dropped, not snapped: snapped, it zooms on something no longer on screen.
  clock.kept = t => keep.some(([a, b]) => t >= a && t <= b)
  return clock
}

// ── marks ────────────────────────────────────────────────────────────────────
// Things drawn onto the frame for a stretch of time: a redaction, a spotlight or a
// numbered step. Rendered before any zoom, so they belong to the content rather than
// the screen: a redaction stays over the sensitive text wherever a zoom moves it.
//
// Coordinates are 0..1 fractions of the frame (x, y is the top-left corner, w, h the
// size), the same convention zooms use, because that is what an agent can reason about.
//
// A redaction destroys what is under it. It is not a blur that could be reversed: the
// region is scaled down to a few pixels and back up, so the original detail is not in
// the output at all.
const STEP_GOLD = [240, 169, 60]   // #F0A93C: steps are an intent, and red is reserved for recording

function markFilters(marks, clock, font, tag = 'mk') {
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
    } else if (m.kind === 'blur') {
      // Gaussian, for softening something distracting. Not for secrets: a blur can
      // be partly undone, which is what redact is for.
      const sigma = Math.max(4, Math.min(60, +m.strength || 18))
      out.push(`split[${L}a][${L}b];[${L}b]${crop},gblur=sigma=${sigma}:steps=3[${L}c];` +
        `[${L}a][${L}c]overlay=x='main_w*${X}':y='main_h*${Y}':${on}`)
    } else if (m.kind === 'spotlight') {
      // everything else steps back; the region keeps its original pixels
      out.push(`split[${L}a][${L}b];[${L}a]${crop}[${L}r];` +
        `[${L}b]drawbox=x=0:y=0:w=iw:h=ih:color=black@0.55:t=fill:${on}[${L}d];` +
        `[${L}d][${L}r]overlay=x='main_w*${X}':y='main_h*${Y}':${on}`)
    } else if (m.kind === 'step') {
      const n = String(m.n || i + 1).replace(/[^0-9A-Za-z]/g, '').slice(0, 3) || String(i + 1)
      // A gold circle (a pill past one character) with the numeral centred in it.
      // drawtext's own box is a tight square, and its boxborderw takes no expression,
      // so a padding in terms of h silently became 0. The badge is painted instead:
      // cut its patch out, colour an antialiased pill over it with geq, put it back.
      // Sizes are fractions of the frame height, so it reads the same at any size.
      const D = 0.096, Wd = (D + (n.length - 1) * 0.62 * 0.062).toFixed(4)
      const bx = `min(iw*${X},iw-ow)`, by = `min(ih*${Y},ih-oh)`
      const edge = `clip(H/2-hypot(max(0,abs(X+0.5-W/2)-(W-H)/2),Y+0.5-H/2)+0.5,0,1)`
      const [r, g, b] = STEP_GOLD
      out.push(`split[${L}a][${L}b];[${L}b]crop=w='ih*${Wd}':h='ih*${D}':x='${bx}':y='${by}',format=rgba,` +
        `geq=r='lerp(r(X,Y),${r},${edge})':g='lerp(g(X,Y),${g},${edge})':b='lerp(b(X,Y),${b},${edge})':a=255[${L}c];` +
        `[${L}a][${L}c]overlay=x='min(main_w*${X},main_w-overlay_w)':y='min(main_h*${Y},main_h-overlay_h)':${on},` +
        `drawtext=text='${n}':` + (font ? `fontfile='${filterPath(font)}':` : '') +
        `fontsize='h*0.062':fontcolor=0x231703:` +
        `x='min(w*${X},w-h*${Wd})+h*${Wd}/2-tw/2':y='min(h*${Y},h-h*${D})+h*${D}/2-th/2':${on}`)
    }
  })
  return out
}

// clock is outClock for this export (a number is read as a trim start, for older
// callers), crop the editor's crop. opts.cursor stands in for the sidecar.
function autoZoomFilter(srcArg, meta, opts = {}, clock = 0, frame, crop) {
  const data = opts.cursor || readCursor(srcArg)
  if (!data || !(data.display || data.windowBounds)) return null
  if (typeof clock === 'number') { const s = clock; clock = t => t - s; clock.kept = t => t >= s }
  const moments = zoomMoments(data, { ...opts, clock, crop })
  if (!moments.length) return null
  const { z, fx, fy } = zoomExpr(moments, UNIT, opts.zoom ?? 1.7, 0)
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
// the framed size.
function backdropGeometry(srcW, srcH, opts) {
  const inset = Math.min(0.22, Math.max(0.02, opts.inset ?? 0.08))

  // "Auto" keeps the source shape and adds the same margin on every side. Forcing
  // a 16:9 canvas around a 16:10 recording gives fat side margins and thin top and
  // bottom ones, which reads as the video being anchored rather than centred.
  let outW, outH
  const target = opts.outAspect   // number (w/h) when the user picks a shape
  if (!target) {
    const pad = inset * Math.max(srcW, srcH)
    outW = 2 * Math.round((srcW + pad * 2) / 2)
    outH = 2 * Math.round((srcH + pad * 2) / 2)
    // keep the canvas sane for encoding
    const cap = opts.scale === 720 ? 1280 : 1920
    if (outW > cap) {
      const k = cap / outW
      outW = 2 * Math.round((outW * k) / 2)
      outH = 2 * Math.round((outH * k) / 2)
    }
  } else {
    outW = 2 * Math.round((opts.outWidth || 1920) / 2)
    outH = 2 * Math.round((outW / target) / 2)
  }

  const boxW = 2 * Math.round((outW * (1 - inset * 2)) / 2)
  const boxH = 2 * Math.round((outH * (1 - inset * 2)) / 2)
  const scale = Math.min(boxW / srcW, boxH / srcH)
  const vidW = 2 * Math.round((srcW * scale) / 2)
  const vidH = 2 * Math.round((srcH * scale) / 2)
  const radius = Math.max(6, Math.round(opts.radius ?? Math.min(vidW, vidH) * 0.035))
  const ox = Math.round((outW - vidW) / 2)
  const oy = Math.round((outH - vidH) / 2)
  const blur = Math.max(4, Math.round(vidH * 0.035))
  return { outW, outH, vidW, vidH, radius, ox, oy, blur }
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
  const bd = BACKDROPS[opts.backdrop] || BACKDROPS.dusk
  const { outW, outH, vidW, vidH, radius, ox, oy, blur } = backdropGeometry(srcW, srcH, opts)

  const parts = []
  const inputs = []
  let vidSrc = vLabel
  if (!imageBd && bd.video) {
    // One decode, two uses: the sharp framed copy and the blurred fill behind it.
    // The fill is blurred at an eighth of the size and scaled back up: a blur this
    // wide leaves no detail to lose, and it is 64 times fewer pixels to blur.
    const sigma = Math.max(12, Math.round(outH * 0.03))
    const fw = 2 * Math.round(outW / 16), fh = 2 * Math.round(outH / 16)
    parts.push(`[${vLabel}]split[bdsharp][bdfill]`)
    parts.push(`[bdfill]scale=${fw}:${fh}:force_original_aspect_ratio=increase:flags=area,crop=${fw}:${fh},` +
               `gblur=sigma=${(sigma * fw / outW).toFixed(2)}:steps=2,eq=brightness=-0.07:saturation=1.15,` +
               `scale=${outW}:${outH}:flags=bicubic,setsar=1,format=yuv420p[bg]`)
    vidSrc = 'bdsharp'
  } else if (imageBd) {
    // fill the frame without distorting: cover, then centre-crop
    inputs.push(imageBd.file)
    parts.push(`[1:v]scale=${outW}:${outH}:force_original_aspect_ratio=increase,` +
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
  parts.push(`[${vidSrc}]scale=${vidW}:${vidH}:flags=lanczos,format=yuva420p[vsq]`)
  parts.push(`[vsq][vmask]alphamerge[vid]`)
  // Shadow needs a margin around it, otherwise boxblur is clipped by its own
  // canvas and leaves a hard edge along the bottom.
  const pad = blur * 2
  const shW = vidW + pad * 2, shH = vidH + pad * 2
  parts.push(`${still(shW, shH, 'rgba', 'black@0')},` +
             `geq=r=0:g=0:b=0:a='if(between(X,${pad},${pad + vidW})*between(Y,${pad},${pad + vidH}),` +
             `0.6*${roundedAlpha(vidW, vidH, radius).replace(/X/g, `(X-${pad})`).replace(/Y/g, `(Y-${pad})`)}/255*255,0)',` +
             `boxblur=${blur}:2[sh]`)
  parts.push(`[bg][sh]overlay=${ox - pad}:${oy - pad + Math.round(blur * 0.9)}[bgs]`)
  parts.push(`[bgs][vid]overlay=${ox}:${oy}:format=auto,format=yuv420p,setsar=1[vout]`)
  return { chain: parts.join(';'), outW, outH, inputs }
}

// Cuts are ranges the user removed. Invert them into keep ranges, clipped to the
// trim window, then trim and concat in the same pass as everything else.
function keepRanges(cuts, from, to) {
  const merged = (cuts || [])
    .map(c => [Math.max(from, +c[0]), Math.min(to, +c[1])])
    .filter(([a, b]) => b - a > 0.02)
    .sort((a, b) => a[0] - b[0])
    .reduce((acc, cur) => {
      const last = acc[acc.length - 1]
      if (last && cur[0] <= last[1]) { last[1] = Math.max(last[1], cur[1]); return acc }
      acc.push(cur); return acc
    }, [])
  const keep = []
  let t = from
  for (const [a, b] of merged) { if (a - t > 0.05) keep.push([t, a]); t = b }
  if (to - t > 0.05) keep.push([t, to])
  return keep
}

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

async function applyEdit(srcArg, opts, onProgress, jobId) {
  // Say so plainly: a missing file used to surface as whichever check failed first
  if (!srcArg || !fs.existsSync(srcArg)) throw new Error(`No recording at ${srcArg}. It may have been renamed or deleted.`)
  const { src, meta, done } = await ensureSeekable(srcArg, jobId)
  const tmpFiles = []
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
    if (c) vf.push(`crop=w='2*floor(iw*${c.w}/2)':h='2*floor(ih*${c.h}/2)':x='iw*${c.x}':y='ih*${c.y}'`)

    // Explicit zooms (Z1, Z2) apply whenever they exist, and win over auto-zoom: a
    // zoom someone asked for by name is a deliberate edit that supersedes the guess.
    // Auto-zoom only runs when switched on and nothing explicit was asked for. Both
    // read the clock of the trimmed output.
    // one clock for everything placed in time, so marks and zooms agree with each
    // other and with the cuts
    const clock = outClock(opts.cuts, start, end || dur)

    // marks first: a redaction must cover the content wherever a zoom then moves it
    for (const mf of markFilters(opts.marks, clock, FONT)) vf.push(mf)

    let zoomInfo = null
    const even = n => 2 * Math.floor(n / 2)
    const frame = c ? { w: even((meta.width || 1920) * c.w), h: even((meta.height || 1080) * c.h) } : null
    // With a backdrop the video ends up at the framed size, and its geometry follows
    // the cropped frame (it used to follow the source, which squashed any crop).
    const bdGeo = opts.backdrop && fmtEarly.video && !fmtEarly.gif
      ? backdropGeometry(frame ? frame.w : srcW, frame ? frame.h : srcH, {
          inset: opts.inset, radius: opts.radius, scale: opts.scale,
          outWidth: opts.scale === 720 ? 1280 : 1920,
          outAspect: opts.backdropAspect || null,   // null keeps the source shape
        })
      : null
    // so zoom outputs straight at that size rather than scaling up to the source
    // size only for the backdrop to scale it down again
    const zoomTo = bdGeo ? { w: bdGeo.vidW, h: bdGeo.vidH } : frame
    if (opts.zooms && opts.zooms.length) zoomInfo = explicitZoomFilter(opts.zooms, meta, clock, zoomTo)
    else if (opts.autoZoom) zoomInfo = autoZoomFilter(srcArg, meta, opts.autoZoomOpts || {}, clock, zoomTo, c)
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

    // A chosen output shape has to work with or without a backdrop. Without one,
    // fit the video inside the shape and pad the remainder.
    if (!opts.backdrop && opts.backdropAspect && fmtEarly.video && !fmtEarly.gif) {
      const ar = +opts.backdropAspect
      // cap the long edge, otherwise a portrait shape produces a 3414px tall frame
      const long = opts.scale === 720 ? 1280 : 1920
      const w = 2 * Math.round((ar >= 1 ? long : long * ar) / 2)
      const oh = 2 * Math.round((ar >= 1 ? long / ar : long) / 2)
      vf.push(`scale=${w}:${oh}:force_original_aspect_ratio=decrease`,
              `pad=${w}:${oh}:(ow-iw)/2:(oh-ih)/2:color=${opts.padColor || 'black'}`)
    }

    // With a backdrop the video is inset, leaving a margin. Overlays used to be
    // drawn into the video before that composite, so they could never reach the
    // margin. When framed, draw them in a second pass over the composited frame.
    const framed = !!(opts.backdrop && outFmt.video && !outFmt.gif)
    const overlayFilters = []
    const target = framed ? overlayFilters : vf

    // text layers → drawtext, text via textfile so quotes/newlines can't break the filter
    for (const [i, t] of (opts.texts || []).entries()) {
      if (!t || !String(t.text || '').trim()) continue
      const tf = path.join(os.tmpdir(), `qr-text-${Date.now()}-${i}.txt`)
      fs.writeFileSync(tf, String(t.text))
      tmpFiles.push(tf)
      const px = Math.max(10, Math.round((t.sizeFrac || 0.05) * (framed ? (opts.scale === 720 ? 720 : 1080) : outH)))
      const face = textFace(t.font, px)
      const parts = [
        `textfile='${filterPath(tf)}'`,
        'expansion=none',        // user text is literal: '%' must not strftime-expand
        face ? `fontfile='${filterPath(face)}'` : null,
        t.align && t.align !== 'center' ? `text_align=${t.align === 'left' ? 'L' : 'R'}` : null,
        `fontsize=${px}`,
        `fontcolor=${t.color || 'white'}`,
        t.align === 'left' ? `x=main_w*${(+t.fx || 0.5).toFixed(4)}`
          : t.align === 'right' ? `x=main_w*${(+t.fx || 0.5).toFixed(4)}-text_w`
          : `x=main_w*${(+t.fx || 0.5).toFixed(4)}-text_w/2`,
        `y=main_h*${(+t.fy || 0.5).toFixed(4)}-text_h/2`,
        // measure by the font's line, not the glyphs, so the box and the centre do not
        // shift with ascenders and descenders ("ace" and "Weekly" sit alike, as in CSS)
        'y_align=font',
      ].filter(Boolean)
      // the stage pads a boxed layer .2em .45em inside a 1.2em line (editor.css);
      // drawtext's line is 1em, so the top and bottom take the other .1em
      if (t.box) parts.push('box=1', 'boxcolor=black@0.45', `boxborderw=${Math.round(px * 0.3)}|${Math.round(px * 0.45)}`)
      // layer times are absolute in the source; the output clock restarts at the trim point
      if (t.start != null && t.end != null && t.end > t.start) {
        parts.push(`enable='between(t,${Math.max(0, t.start - start).toFixed(2)},${Math.max(0, t.end - start).toFixed(2)})'`)
      }
      target.push('drawtext=' + parts.join(':'))
    }

    // Captions on means "burn them if there are any". Every new edit starts with it
    // on, so throwing here made a take with nothing to transcribe (no mic, no system
    // audio) impossible to export until someone found the toggle.
    const srtSrc = opts.captions ? sidecarIn(srcArg, '.srt') : null
    if (srtSrc && fs.existsSync(srtSrc)) {
      const cs = opts.captionStyle || {}
      let srtUse = srtSrc
      let cues = null
      // cue times are absolute in the source; the trimmed output restarts its clock
      // at `start`, so shift and clip them or the captions run late by exactly `start`
      if (start > 0 || end) {
        cues = readCues(srcArg)
          .filter(c => c.end > start && (!end || c.start < end))
          .map(c => ({
            start: Math.max(0, c.start - start),
            end: Math.max(0.1, Math.min(c.end, end || c.end) - start),
            text: c.text,
          }))
        const tmp = path.join(os.tmpdir(), `qr-sub-${Date.now()}.srt`)
        fs.writeFileSync(tmp, cuesToSrt(cues))
        tmpFiles.push(tmp)
        srtUse = tmp
      }
      if (cs.fx != null && cs.fy != null) {
        const cv = captionCanvas(framed && bdGeo, croppedW, croppedH, outH, opts)
        const ap = path.join(os.tmpdir(), `qr-sub-${Date.now()}.ass`)
        fs.writeFileSync(ap, cuesToAss(cues || readCues(srcArg), cv.w, cv.h, cs))
        tmpFiles.push(ap)
        target.push(`subtitles='${filterPath(ap)}'`)
      } else {
        target.push(`subtitles='${filterPath(srtUse)}':force_style='${subStyle(outH, cs)}'`)
      }
    }

    const fadeIn = +opts.fadeIn > 0 ? +opts.fadeIn : 0
    const fadeOut = +opts.fadeOut > 0 ? +opts.fadeOut : 0
    const span = outDur || dur || 0
    if (fadeIn) vf.push(`fade=t=in:st=0:d=${fadeIn}`)
    if (fadeOut && span) vf.push(`fade=t=out:st=${Math.max(0, span - fadeOut).toFixed(2)}:d=${fadeOut}`)

    // An added audio track: people often record voice separately. It can sit
    // under the recording's own audio, or replace it entirely.
    const extra = opts.audioTrack && opts.audioTrack.file && fs.existsSync(opts.audioTrack.file)
      ? opts.audioTrack : null

    const af = []
    if (meta.hasAudio) {
      if (opts.denoise) af.push('afftdn=nr=12:nf=-25:tn=1', 'highpass=f=70')
      if (opts.loudnorm !== false) af.push('loudnorm=I=-16:TP=-1.5:LRA=11')
      if (opts.gain) af.push(`volume=${opts.gain}dB`)
      if (fadeIn) af.push(`afade=t=in:st=0:d=${fadeIn}`)
      if (fadeOut && span) af.push(`afade=t=out:st=${Math.max(0, span - fadeOut).toFixed(2)}:d=${fadeOut}`)
    }

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
    // build the added-audio chain once, both branches below reuse it
    let extraGraph = null, extraMap = null
    if (extra) {
      const idx = 1 + ((framed && opts.backdrop && String(opts.backdrop).startsWith('img:')) ? 1 : 0)
      const off = Math.max(0, +extra.offset || 0)
      const vol = extra.volume == null ? 1 : +extra.volume
      const bits = [`[${idx}:a]atrim=start=0,asetpts=PTS-STARTPTS`]
      if (off > 0) bits.push(`adelay=${Math.round(off * 1000)}|${Math.round(off * 1000)}`)
      bits.push(`volume=${vol.toFixed(2)}`)
      if (+extra.fadeIn > 0) bits.push(`afade=t=in:st=${off}:d=${(+extra.fadeIn).toFixed(2)}`)
      if (+extra.fadeOut > 0 && span) {
        bits.push(`afade=t=out:st=${Math.max(0, span - +extra.fadeOut).toFixed(2)}:d=${(+extra.fadeOut).toFixed(2)}`)
      }
      let chain = bits.join(',') + '[extraRaw]'

      if (cutGraph) {
        // apply the identical keep ranges to the added track, after its delay,
        // so a cut removes the same moment from both
        const keep = keepRanges(cuts, start, end || dur)
        const parts = []
        keep.forEach(([a, b], i) => {
          parts.push(`[extraSplit${i}]atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=PTS-STARTPTS[extraCut${i}]`)
        })
        chain += `;[extraRaw]asplit=${keep.length}` +
                 keep.map((_, i) => `[extraSplit${i}]`).join('') + ';' +
                 parts.join(';') + ';' +
                 keep.map((_, i) => `[extraCut${i}]`).join('') +
                 `concat=n=${keep.length}:v=0:a=1[extra]`
      } else {
        chain += ';[extraRaw]anull[extra]'
      }
      if (extra.replace || !meta.hasAudio) {
        extraGraph = chain
        extraMap = '[extra]'
      } else {
        // duration=first keeps the output the length of the video, not the music
        extraGraph = chain + `;[0:a]${af.length ? af.join(',') : 'anull'}[base];` +
                     `[base][extra]amix=inputs=2:duration=first:dropout_transition=0,` +
                     `alimiter=limit=0.95[amixed]`
        extraMap = '[amixed]'
      }
    }

    const camPrefix = () => camG ? camG.pre + ';' : ''

    // A take folder's export is its deliverable, rewritten each time; a loose file on
    // the Desktop keeps its -edit copy beside it.
    const deliverable = deliverablePath(srcArg, fmt.ext)
    const dest = exportDest(srcArg, fmt.ext)
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
      if (meta.hasAudio) chain.push(af.length ? `[cuta]${af.join(',')}[aout]` : `[cuta]anull[aout]`)
      if (extraGraph) chain.push(extraGraph)
      args.push('-filter_complex', camPrefix() + chain.join(';'), '-map', '[vout]')
      if (extraMap) args.push('-map', extraMap)
      else if (meta.hasAudio) args.push('-map', '[aout]')
    } else if (opts.backdrop && fmt.video && !fmt.gif) {
      // framed look: everything above feeds [vin], then the backdrop composites it
      const geo = backdropChain('vin', frame ? frame.w : srcW, frame ? frame.h : srcH, {
        backdrop: opts.backdrop, inset: opts.inset, radius: opts.radius, scale: opts.scale, fps: zoomFps(meta),
        outWidth: opts.scale === 720 ? 1280 : 1920,
        outAspect: opts.backdropAspect || null,   // null keeps the source shape
      })
      const srcLabel = cutGraph ? '[cutv]' : VSRC
      const pre = (cutGraph ? cutGraph + ';' : '') +
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
    args.push(...fmt.args(opts.quality))
    if (fmt.video && !fmt.gif && !meta.hasAudio) args.push('-an')
    args.push(out)

    await run(FFMPEG, args, timeWatcher(onProgress, cutDur || span), jobId)
    if (out !== dest) fs.renameSync(out, dest)
    return { file: dest, duration: +((cutDur || span) || await probeDuration(dest)).toFixed(1),
             cuts: cuts.length,
             format: fmt.ext, mb: +(fs.statSync(dest).size / 1e6).toFixed(1) }
  } finally {
    tmpFiles.forEach(f => { try { fs.unlinkSync(f) } catch {} })
    done()
  }
}

// ── the edit document ────────────────────────────────────────────────────────
// One file per recording holding everything about its edit. See ui/fetchdoc.js
// for why it exists and what the ids mean.
const fetchdoc = require('./ui/fetchdoc')

function readDoc(src, dur) {
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(sidecarIn(src, '.fetchdoc.json'), 'utf8')) } catch {}
  return fetchdoc.normalize(raw, src, dur)
}

function writeDoc(src, doc) {
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
  frameAt,
  backdropList, filmstrip,
  toMp4, convert, removeSilence, enhanceAudio, trim, transcribe, burnCaptions, toGif,
  thumbnail, waveform, applyEdit, listRecordings, importFile, forgetFile,
  probeMeta, readCues, writeCues, cancel, formatList, FFMPEG, flattenAudio,
  sidecarOut, sidecarIn, migrateSidecars,
  setTakesRoot, takeDir, deliverablePath, exportDest, renameTake,
  speechRegions, buildBeats, buildCues, beatsFromCursor, readCursor,
  zoomMoments, zoomExpr, autoZoomFilter, explicitZoomFilter, outClock, backdropGeometry,
  readDoc, writeDoc, beatsFor,
  fontList: () => Object.keys(FONT_FILES),
}
