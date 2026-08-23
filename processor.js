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
    p.stderr.on('data', d => {
      err += d
      if (onLine) d.toString().split('\n').forEach(l => l && onLine(l))
    })
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
  let out = ''
  await run(FFMPEG, ['-hide_banner', '-i', src], l => { out += l + '\n' }).catch(() => {})
  const meta = { duration: 0, width: 0, height: 0, fps: 0, hasAudio: false, vcodec: null, acodec: null }
  const d = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(out)
  if (d) meta.duration = +d[1] * 3600 + +d[2] * 60 + +d[3]
  const v = /Stream #\d+:\d+.*?: Video: (\w+).*?, (\d+)x(\d+)/s.exec(out)
  if (v) { meta.vcodec = v[1]; meta.width = +v[2]; meta.height = +v[3] }
  const f = /(\d+(?:\.\d+)?) fps/.exec(out)
  if (f) meta.fps = +f[1]
  const a = /Stream #\d+:\d+.*?: Audio: (\w+)/.exec(out)
  if (a) { meta.hasAudio = true; meta.acodec = a[1] }
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
    let dest = srcArg.replace(/\.(webm|mkv)$/i, '.mp4')
    if (dest === srcArg) dest = outName(srcArg, 'converted', 'mp4')
    const args = ['-y', '-fflags', '+genpts', '-i', src, ...VIDEO_OUT]
    args.push(...(meta.hasAudio ? AUDIO_OUT : ['-an']), ...FAST_START, dest)
    await run(FFMPEG, args, timeWatcher(onProgress, meta.duration), jobId)
    return { file: dest, duration: +meta.duration.toFixed(1) }
  } finally { done() }
}

// ---- convert to any supported container -------------------------------
async function convert(srcArg, opts, onProgress, jobId) {
  const fmt = FORMATS[(opts && opts.format) || 'mp4']
  if (!fmt) throw new Error('unsupported format: ' + (opts && opts.format))
  const { src, meta, done } = await ensureSeekable(srcArg, jobId)
  try {
    if (!fmt.video && !meta.hasAudio) throw new Error('this file has no audio track to extract')
    let dest = outName(srcArg, fmt.video ? 'converted' : 'audio', fmt.ext)
    // converting a webm to mp4 keeps the plain name when nothing would collide
    const plain = srcArg.replace(/\.[^.]+$/, '.' + fmt.ext)
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

    const txtPath = sidecarOut(srcArg, '.txt'), srtPath = sidecarOut(srcArg, '.srt')
    fs.writeFileSync(txtPath, j.text || '')

    const cues = buildCues(words, await speechRegions(wav, j.durationSeconds || 0, jobId))
    fs.writeFileSync(srtPath, cuesToSrt(cues))

    return { file: txtPath, srt: srtPath, cues, words: words.length, text: j.text || '',
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

function buildCues(words, speech, { maxWords = 8, maxDur = 3.4, minPause = 0.45 } = {}) {
  const plain = () => groupWords(words).map(l => ({ start: l.start, end: l.end, text: l.words.join(' ') }))
  const clean = words.filter(w => (w.word || '').trim())
  if (!speech || speech.length < 2 || !clean.length) return plain()

  // the quiet spans between phrases
  const sil = []
  for (let i = 0; i + 1 < speech.length; i++) sil.push([speech[i][1], speech[i + 1][0]])
  // A break belongs between two words only when the speaker actually stopped between
  // them. Comparing against word start times, never the padded end times, keeps a
  // long-sounding word from being mistaken for a pause.
  const pauseBetween = (aStart, bStart) =>
    sil.find(([x, y]) => y - x >= minPause && x >= aStart - 0.05 && y <= bStart + 0.15)

  const groups = []
  let cur = null, prevStart = 0
  for (const w of clean) {
    const word = (w.word || '').trim()
    if (!cur) { cur = { start: w.startTime, end: w.endTime, words: [word] }; prevStart = w.startTime; continue }
    const gap = pauseBetween(prevStart, w.startTime)
    const full = cur.words.length >= maxWords || (w.endTime - cur.start) > maxDur
    if (gap || full) {
      if (gap) cur.end = Math.min(cur.end, gap[0])       // stop when the talking stopped
      groups.push(cur)
      cur = { start: w.startTime, end: w.endTime, words: [word] }
    } else {
      cur.end = w.endTime; cur.words.push(word)
    }
    prevStart = w.startTime
  }
  if (cur) groups.push(cur)

  // A phrase cut purely by length can leave a stray word stranded on its own line.
  // If no real pause separates it, fold it back into the line it belongs to.
  for (let i = groups.length - 2; i >= 0; i--) {
    const a = groups[i], b = groups[i + 1]
    const noPause = !pauseBetween(a.start, b.start) && b.start - a.end < 0.3
    // Only if folding it back does not make the line show words long before they are
    // said. Staying in sync matters more than avoiding a short line.
    if (noPause && b.words.length <= 2 && a.words.length + b.words.length <= maxWords + 2 &&
        b.start - a.start <= 2.0) {
      a.words.push(...b.words); a.end = b.end
      groups.splice(i + 1, 1)
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
// there is a backdrop, the video itself otherwise. Mirrors backdropChain's geometry.
function captionCanvas(framed, srcW, srcH, croppedW, croppedH, outH, opts) {
  if (framed) {
    const inset = Math.min(0.22, Math.max(0.02, opts.inset ?? 0.08))
    const target = opts.backdropAspect ? +opts.backdropAspect : null
    if (!target) {
      const pad = inset * Math.max(srcW, srcH)
      let w = 2 * Math.round((srcW + pad * 2) / 2)
      let h = 2 * Math.round((srcH + pad * 2) / 2)
      const cap = opts.scale === 720 ? 1280 : 1920
      if (w > cap) { const k = cap / w; w = 2 * Math.round((w * k) / 2); h = 2 * Math.round((h * k) / 2) }
      return { w, h }
    }
    const w = 2 * Math.round((opts.scale === 720 ? 1280 : 1920) / 2)
    return { w, h: 2 * Math.round((w / target) / 2) }
  }
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
const SIDE_EXT = ['.png', '.srt', '.txt', '.cursor.json', '.cam.json', '.cam.mov']

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

// ---- thumbnail grab -----------------------------------------------------
async function thumbnail(srcArg, atSec, onProgress, jobId) {
  const { src, meta, done } = await ensureSeekable(srcArg, jobId)
  try {
    const at = Math.min(Math.max(0, atSec || 0), Math.max(0, (meta.duration || 1) - 0.1))
    const dest = sidecarOut(srcArg, '.png')
    await run(FFMPEG, ['-y', '-ss', String(at), '-i', src, '-frames:v', '1', '-q:v', '2', dest], null, jobId)
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

// anything QuickRec recorded on the Desktop, plus whatever the user imported
function listRecordings() {
  const out = new Map()
  const dir = app_desktop()
  let files = []
  try { files = fs.readdirSync(dir) } catch {}
  for (const f of files) {
    if (!/^recording-/i.test(f) || !MEDIA_EXT.test(f)) continue
    if (/\.cam\.mov$/i.test(f)) continue          // a camera take, not a clip
    const full = path.join(dir, f)
    try { out.set(full, describe(full)) } catch {}
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
// Recording writes <clip>.cursor.json at 20Hz. Clicks are grouped into moments,
// and each moment becomes a smooth push in and back out, centred on the pointer.
// Only valid for full-screen captures: a window recording has a different origin.
function readCursor(srcArg) {
  const p = sidecarIn(srcArg, '.cursor.json')
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

// smoothstep, written the way ffmpeg's expression parser wants it
const ramp = (t, a, b) => `(${t}-${a})/(${b}-${a})`
const smooth = p => `(${p})*(${p})*(3-2*(${p}))`

function zoomMoments(data, opts = {}) {
  const hold = opts.hold ?? 1.6          // seconds held at full zoom
  const ease = opts.ease ?? 0.45         // seconds to push in, and to pull back
  const gap = opts.gap ?? 2.2            // clicks closer than this share one moment
  const clicks = (data.clicks || []).map(([ms, x, y]) => ({ t: ms / 1000, x, y }))

  // fall back to dwell points if nothing was clicked: places the pointer rested
  let events = clicks
  if (!events.length) {
    const pts = (data.points || []).map(([ms, x, y]) => ({ t: ms / 1000, x, y }))
    for (let i = 8; i < pts.length - 8; i += 8) {
      const a = pts[i - 8], b = pts[i], c = pts[i + 8]
      const moved = Math.hypot(b.x - a.x, b.y - a.y)
      const settled = Math.hypot(c.x - b.x, c.y - b.y)
      if (moved > 90 && settled < 18) events.push(b)
    }
  }
  if (!events.length) return []

  const moments = []
  for (const e of events) {
    const last = moments[moments.length - 1]
    if (last && e.t - last.t < gap) { last.t = e.t; continue }   // extend the current one
    moments.push({ t: e.t, x: e.x, y: e.y })
  }
  return moments.map(m => ({
    inStart: Math.max(0, m.t - ease),
    inEnd: m.t,
    outStart: m.t + hold,
    outEnd: m.t + hold + ease,
    x: m.x, y: m.y,
  }))
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
    z = `if(${inWindow},1+${(zMax - 1).toFixed(3)}*(${amount}),${z})`
    const cx = Math.min(1, Math.max(0, (m.x - disp.x) / disp.width)).toFixed(4)
    const cy = Math.min(1, Math.max(0, (m.y - disp.y) / disp.height)).toFixed(4)
    fx = `if(${inWindow},${cx},${fx})`
    fy = `if(${inWindow},${cy},${fy})`
  }
  return { z, fx, fy }
}

// returns a zoompan filter string, or null when there is nothing to zoom to
function autoZoomFilter(srcArg, meta, opts = {}, trimStart = 0) {
  const data = readCursor(srcArg)
  if (!data || !data.display) return null
  const moments = zoomMoments(data, opts)
  if (!moments.length) return null
  const zMax = opts.zoom ?? 1.7
  const { z, fx, fy } = zoomExpr(moments, data.display, zMax, trimStart)
  const w = meta.width || 1920, h = meta.height || 1080
  const fps = Math.round(meta.fps || 30)
  // zoompan positions the crop by its top-left corner
  const x = `(iw-iw/zoom)*(${fx})`
  const y = `(ih-ih/zoom)*(${fy})`
  return { filter: `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${w}x${h}:fps=${fps}`, moments: moments.length }
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

// builds a filter_complex that frames [vin] over a backdrop, producing [vout]
function backdropChain(vLabel, srcW, srcH, opts) {
  const imageBd = String(opts.backdrop || '').startsWith('img:')
    ? imageBackdrops().find(b => b.id === opts.backdrop) : null
  const bd = BACKDROPS[opts.backdrop] || BACKDROPS.dusk
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

  const parts = []
  const inputs = []
  if (imageBd) {
    // fill the frame without distorting: cover, then centre-crop
    inputs.push(imageBd.file)
    parts.push(`[1:v]scale=${outW}:${outH}:force_original_aspect_ratio=increase,` +
               `crop=${outW}:${outH},format=rgba[bg]`)
  } else {
    parts.push(`gradients=s=${outW}x${outH}:c0=${bd.c0}:c1=${bd.c1}:x0=0:y0=0:x1=${outW}:y1=${outH}:speed=0,` +
               `format=rgba[bg]`)
  }
  // the video, inset and rounded
  parts.push(`[${vLabel}]scale=${vidW}:${vidH}:flags=lanczos,format=rgba,` +
             `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${roundedAlpha(vidW, vidH, radius)}'[vid]`)
  // Shadow needs a margin around it, otherwise boxblur is clipped by its own
  // canvas and leaves a hard edge along the bottom.
  const pad = blur * 2
  const shW = vidW + pad * 2, shH = vidH + pad * 2
  parts.push(`color=c=black@0:s=${shW}x${shH},format=rgba,` +
             `geq=r=0:g=0:b=0:a='if(between(X,${pad},${pad + vidW})*between(Y,${pad},${pad + vidH}),` +
             `0.6*${roundedAlpha(vidW, vidH, radius).replace(/X/g, `(X-${pad})`).replace(/Y/g, `(Y-${pad})`)}/255*255,0)',` +
             `boxblur=${blur}:2[sh]`)
  parts.push(`[bg][sh]overlay=${ox - pad}:${oy - pad + Math.round(blur * 0.9)}[bgs]`)
  parts.push(`[bgs][vid]overlay=${ox}:${oy}:format=auto,format=yuv420p[vout]`)
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
  bits.push(`scale=${S}:${S}:force_original_aspect_ratio=increase`, `crop=${S}:${S}`, 'format=rgba')
  // circular cut with a white rim, matching the bubble on screen
  bits.push(`geq=r='if(gt(${H},${RI}),255,r(X,Y))':g='if(gt(${H},${RI}),255,g(X,Y))':` +
            `b='if(gt(${H},${RI}),255,b(X,Y))':a='255*lt(${H},${RO})'`)
  // after geq, so the held frames stay fully transparent instead of being filled in
  if (delay > 0.001) bits.push(`tpad=start_duration=${delay.toFixed(3)}:start_mode=add:color=#00000000`)
  return { pre: `${bits.join(',')}[cam];[0:v][cam]overlay=${x}:${y}:eof_action=pass:format=auto[csrc]` }
}

async function applyEdit(srcArg, opts, onProgress, jobId) {
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

    // auto zoom follows the pointer; it reads the clock of the trimmed output
    let zoomInfo = null
    if (opts.autoZoom) {
      zoomInfo = autoZoomFilter(srcArg, meta, opts.autoZoomOpts || {}, start)
      if (zoomInfo) vf.push(zoomInfo.filter)
    }

    if (opts.scale === 1080 || opts.scale === 720) vf.push(`scale=-2:${opts.scale}:flags=lanczos`)

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
      const face = (t.font && FONT_FILES[t.font]) || FONT
      const parts = [
        `textfile='${filterPath(tf)}'`,
        'expansion=none',        // user text is literal: '%' must not strftime-expand
        face ? `fontfile='${filterPath(face)}'` : null,
        t.align && t.align !== 'center' ? `text_align=${t.align === 'left' ? 'L' : 'R'}` : null,
        `fontsize=${Math.max(10, Math.round((t.sizeFrac || 0.05) * (framed ? (opts.scale === 720 ? 720 : 1080) : outH)))}`,
        `fontcolor=${t.color || 'white'}`,
        t.align === 'left' ? `x=main_w*${(+t.fx || 0.5).toFixed(4)}`
          : t.align === 'right' ? `x=main_w*${(+t.fx || 0.5).toFixed(4)}-text_w`
          : `x=main_w*${(+t.fx || 0.5).toFixed(4)}-text_w/2`,
        `y=main_h*${(+t.fy || 0.5).toFixed(4)}-text_h/2`,
      ].filter(Boolean)
      if (t.box) parts.push('box=1', 'boxcolor=black@0.45', 'boxborderw=14')
      // layer times are absolute in the source; the output clock restarts at the trim point
      if (t.start != null && t.end != null && t.end > t.start) {
        parts.push(`enable='between(t,${Math.max(0, t.start - start).toFixed(2)},${Math.max(0, t.end - start).toFixed(2)})'`)
      }
      target.push('drawtext=' + parts.join(':'))
    }

    if (opts.captions) {
      const srtSrc = sidecarIn(srcArg, '.srt')
      if (!fs.existsSync(srtSrc)) throw new Error('no captions yet, run Transcribe first')
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
        const cv = captionCanvas(framed, srcW, srcH, croppedW, croppedH, outH, opts)
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

    const dest = outName(srcArg, 'edit', fmt.ext)
    const args = ['-y']
    // with cuts the trim happens inside the graph, so do not also seek the input
    if (!cutGraph && start > 0) args.push('-ss', String(start))
    args.push('-i', src)
    if (extra) args.push('-i', extra.file)
    if (!cutGraph && outDur > 0) args.push('-t', String(outDur))

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
      const geo = backdropChain('vin', meta.width || 1920, meta.height || 1080, {
        backdrop: opts.backdrop, inset: opts.inset, radius: opts.radius,
        outWidth: opts.scale === 720 ? 1280 : 1920,
        outAspect: opts.backdropAspect || null,   // null keeps the source shape
      })
      const srcLabel = cutGraph ? '[cutv]' : VSRC
      const pre = (cutGraph ? cutGraph + ';' : '') +
        (vf.length ? `${srcLabel}${vf.join(',')}[vin];` : `${srcLabel}null[vin];`)
      for (const extra of geo.inputs || []) args.push('-i', extra)
      const post = overlayFilters.length ? `;[vout]${overlayFilters.join(',')}[vfinal]` : ''
      const audioPart = extraGraph ? ';' + extraGraph : ''
      args.push('-filter_complex', camPrefix() + pre + geo.chain + post + audioPart, '-map', post ? '[vfinal]' : '[vout]')
      if (extraMap) args.push('-map', extraMap)
      else if (meta.hasAudio) args.push('-map', cutGraph ? '[cuta]' : '0:a?')
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
    if (af.length && !fmt.gif && !extraGraph) args.push('-af', af.join(','))
    args.push(...fmt.args(opts.quality))
    if (fmt.video && !fmt.gif && !meta.hasAudio) args.push('-an')
    args.push(dest)

    await run(FFMPEG, args, timeWatcher(onProgress, cutDur || span), jobId)
    return { file: dest, duration: +((cutDur || span) || await probeDuration(dest)).toFixed(1),
             cuts: cuts.length,
             format: fmt.ext, mb: +(fs.statSync(dest).size / 1e6).toFixed(1) }
  } finally {
    tmpFiles.forEach(f => { try { fs.unlinkSync(f) } catch {} })
    done()
  }
}

module.exports = {
  autoZoomFilter, backdropList, backdropChain, filmstrip,
  toMp4, convert, removeSilence, enhanceAudio, trim, transcribe, burnCaptions, toGif,
  thumbnail, waveform, applyEdit, listRecordings, importFile, forgetFile,
  probeDuration, probeMeta, readCues, writeCues, cancel, formatList, FFMPEG,
  sidecarPath, sidecarOut, sidecarIn, migrateSidecars, SIDE_DIR, SIDE_EXT,
}
