#!/usr/bin/env node
// Renders the music beds in assets/music from nothing but arithmetic, so they are ours
// to ship under the GPL with no licence to track. Soft pads under a quiet plucked
// arpeggio, the kind of bed a product film sits its voice on, mixed to about -20 LUFS
// and ducked further under speech at export (processor.js musicGraph).
//
//   node tools/make-beds.js [ffmpeg]
//
// Each bed is a whole number of its chord cycle long, so looping it under a long take
// lands on the same chord it left.
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const FFMPEG = process.argv[2] || process.env.FFMPEG || 'ffmpeg'
const SR = 44100
const OUT = path.join(__dirname, '..', 'assets', 'music')

const midi = n => 440 * Math.pow(2, (n - 69) / 12)
// C4 is 60
const BEDS = {
  warm: {
    label: 'Warm', bpm: 84, beatsPerChord: 8, cycles: 4,
    chords: [[48, 55, 62, 64, 71], [45, 52, 59, 60, 67], [41, 53, 57, 60, 64], [43, 50, 57, 59, 62]],
    pad: 0.16, pluck: 0.11, pulse: 0, bright: 0.55,
  },
  bright: {
    label: 'Bright', bpm: 104, beatsPerChord: 8, cycles: 5,
    chords: [[50, 57, 62, 66, 69], [47, 54, 59, 62, 66], [43, 55, 59, 62, 67], [45, 52, 57, 61, 64]],
    pad: 0.13, pluck: 0.13, pulse: 0.35, bright: 0.8,
  },
  calm: {
    label: 'Calm', bpm: 66, beatsPerChord: 8, cycles: 3,
    chords: [[45, 52, 59, 60, 64], [41, 48, 55, 57, 64], [48, 55, 59, 62, 64], [43, 50, 55, 59, 62]],
    pad: 0.18, pluck: 0.07, pulse: 0, bright: 0.4,
  },
}

// a soft saw: odd and even partials rolling off fast, so it is warm rather than buzzy
function padTone(f, t, bright) {
  let v = 0
  for (let k = 1; k <= 6; k++) v += Math.sin(2 * Math.PI * f * k * t + k) / Math.pow(k, 2.2 - bright * 0.6)
  return v
}

function render(bed) {
  const beat = 60 / bed.bpm, chordLen = beat * bed.beatsPerChord
  const cycle = chordLen * bed.chords.length, dur = cycle * bed.cycles
  const n = Math.round(dur * SR)
  const L = new Float32Array(n), R = new Float32Array(n)
  const xfade = Math.min(1.6, chordLen * 0.35)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const tc = t % cycle, ci = Math.floor(tc / chordLen), into = tc - ci * chordLen
    // this chord, and the one before it still ringing out across the change
    let pl = 0, pr = 0
    for (const [k, w] of [[ci, Math.min(1, into / xfade)], [(ci + bed.chords.length - 1) % bed.chords.length, Math.max(0, 1 - into / xfade)]]) {
      if (w <= 0) continue
      const g = w * w * (3 - 2 * w)
      bed.chords[k].forEach((m, j) => {
        const f = midi(m)
        // two voices a few cents apart, one per side, for width
        const a = padTone(f * 1.0012, t, bed.bright), b = padTone(f * 0.9988, t + 0.013, bed.bright)
        const lvl = j === 0 ? 0.9 : 0.55
        pl += g * lvl * a; pr += g * lvl * b
      })
      // a sub under the root
      const sub = Math.sin(2 * Math.PI * midi(bed.chords[k][0] - 12) * t) * 0.8 * g
      pl += sub; pr += sub
    }
    // a gentle pump on the beat, for the brighter bed's sense of pace
    const ph = (t % beat) / beat
    const pump = 1 - bed.pulse * Math.exp(-ph * 6) * (1 - Math.exp(-ph * 60))
    L[i] = pl * bed.pad * 0.2 * pump; R[i] = pr * bed.pad * 0.2 * pump
  }
  // the arpeggio: chord tones an octave up on the eighths, a soft sine pluck each
  const eighth = beat / 2, notes = Math.floor(dur / eighth)
  const pattern = [1, 2, 3, 4, 3, 2, 4, 1]
  for (let q = 0; q < notes; q++) {
    const t0 = q * eighth, ci = Math.floor((t0 % cycle) / chordLen)
    const chord = bed.chords[ci], m = chord[pattern[q % pattern.length]] + 12
    const f = midi(m), start = Math.round(t0 * SR), len = Math.round(1.4 * SR)
    const pan = 0.5 + 0.3 * Math.sin(q * 1.7)
    const accent = q % 4 === 0 ? 1 : 0.7
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / SR
      const e = (1 - Math.exp(-t * 120)) * Math.exp(-t * 3.2) * accent
      const v = (Math.sin(2 * Math.PI * f * t) + 0.18 * Math.sin(4 * Math.PI * f * t) * Math.exp(-t * 8)) * e * bed.pluck * 0.35
      L[start + i] += v * (1 - pan) * 2 * 0.7; R[start + i] += v * pan * 2 * 0.7
    }
  }
  const buf = Buffer.alloc(n * 8)
  for (let i = 0; i < n; i++) { buf.writeFloatLE(L[i], i * 8); buf.writeFloatLE(R[i], i * 8 + 4) }
  return { buf, dur }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  for (const [id, bed] of Object.entries(BEDS)) {
    const { buf, dur } = render(bed)
    const file = path.join(OUT, `${id}.m4a`)
    // a room round it (two short echoes), the top rolled off, levelled, and faded at the
    // ends only by a few milliseconds so a loop has no click
    const af = 'highpass=f=45,lowpass=f=5200,aecho=0.8:0.55:73|131:0.28|0.18,' +
      'loudnorm=I=-20:TP=-3:LRA=7,afade=t=in:d=0.02,afade=t=out:st=' + (dur - 0.02).toFixed(3) + ':d=0.02'
    await new Promise((res, rej) => {
      const p = spawn(FFMPEG, ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', '-',
        '-af', af, '-t', dur.toFixed(3), '-c:a', 'aac', '-b:a', '112k', '-metadata', `title=Fetch bed: ${bed.label}`, file])
      p.on('error', rej)
      p.on('close', c => (c ? rej(new Error(`ffmpeg ${c}`)) : res()))
      p.stdin.end(buf)
    })
    console.log(`${file}  ${dur.toFixed(1)} s`)
  }
}
main().catch(e => { console.error(e.message); process.exit(1) })
