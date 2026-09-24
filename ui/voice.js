// Generated voiceover, through the person's own ElevenLabs account.
// Main-process module, required from main.js.
//
// This is one of exactly two things in Fetch that leave the machine (the other is the
// backdrop picker's Unsplash search, ui/unsplash.js), and it is treated as an exception
// rather than folded in quietly. Everything else here is deliberate about that: the key
// lives in the macOS Keychain and never in prefs.json, the script is the only thing ever
// sent, and nothing is uploaded unless someone presses Generate. The UI says so in those
// words, and names the other one beside it. A recorder whose whole argument is "nothing leaves
// your Mac" cannot afford an unlabelled network call.
//
// What it is for: re-narrating a take without re-recording it. Fetch already has the
// transcript with real timings, so the flow is to take what you said, let you fix the
// stumbles, and speak it back in a clean voice over the same footage.

const fs = require('fs')
const https = require('https')

const API = 'api.elevenlabs.io'
const SERVICE = 'fetch-elevenlabs'

// ---------- the key ----------
// Never prefs.json: a key in a JSON file under Application Support is readable by
// anything the person runs and ends up in backups and screen recordings.
//
// And no longer a plain Keychain generic password either. One made by /usr/bin/security
// carries that binary in its access control list, so any shell running as the person,
// the read-only one a chat engine keeps included, could print the key back with no
// prompt. ui/keystore.js holds it instead: encrypted by Electron's safeStorage, whose
// own Keychain item is bound to Fetch's binary, into a 0600 file. A key still in the old
// item is migrated on the first read and the old item deleted.
const keys = require('./keystore').store(SERVICE)

async function getKey() {
  try { return await keys.get() } catch { return null }
}

async function setKey(key) {
  await keys.set(key)
  return true
}

async function clearKey() {
  try { await keys.clear() } catch {}
  return true
}

// ---------- http ----------
function request({ path, method = 'GET', key, body, binary = false }) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null
    const req = https.request({
      hostname: API, path, method,
      headers: {
        'xi-api-key': key,
        accept: binary ? 'audio/mpeg' : 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
      timeout: 120000,
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        if (res.statusCode >= 400) {
          // Their errors arrive as JSON even when audio was asked for. Surfacing the
          // real message matters here: "quota exceeded" and "bad key" need different
          // reactions from the person reading it.
          let msg = `ElevenLabs returned ${res.statusCode}`
          try {
            const j = JSON.parse(buf.toString('utf8'))
            const d = j.detail
            msg = (d && (d.message || d.status)) || j.message || msg
          } catch {}
          return reject(new Error(msg))
        }
        resolve(binary ? buf : JSON.parse(buf.toString('utf8') || '{}'))
      })
    })
    req.on('timeout', () => { req.destroy(new Error('ElevenLabs did not answer in time')) })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// ---------- api ----------
async function status() {
  const key = await getKey()
  if (!key) return { connected: false }
  try {
    const u = await request({ path: '/v1/user/subscription', key })
    return {
      connected: true,
      tier: u.tier || null,
      used: u.character_count ?? null,
      limit: u.character_limit ?? null,
    }
  } catch (e) {
    // A stored key that no longer works should say so rather than silently failing
    // at the moment someone presses Generate.
    return { connected: false, error: e.message }
  }
}

async function connect(key) {
  // Verify before storing, so a typo is caught here rather than three screens later.
  const probe = await request({ path: '/v1/user/subscription', key: String(key || '').trim() })
  await setKey(key)
  return { ok: true, tier: probe.tier || null }
}

async function voices() {
  const key = await getKey()
  if (!key) throw new Error('not connected')
  const j = await request({ path: '/v1/voices', key })
  return (j.voices || []).map(v => ({
    id: v.voice_id,
    name: v.name,
    category: v.category || null,
    preview: v.preview_url || null,
    // labels are free-form on their side; these three are the ones worth showing
    accent: (v.labels && (v.labels.accent || v.labels.language)) || null,
    age: (v.labels && v.labels.age) || null,
    use: (v.labels && (v.labels.use_case || v.labels.description)) || null,
  }))
}

/**
 * Speak `text` and write an mp3 to `outPath`. Returns the path.
 * Only the script is sent. No audio, no video, no filenames.
 */
async function speak({ text, voiceId, outPath, settings = {} }) {
  const key = await getKey()
  if (!key) throw new Error('not connected')
  const script = String(text || '').trim()
  if (!script) throw new Error('nothing to say')
  if (!voiceId) throw new Error('pick a voice first')

  const buf = await request({
    path: `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    method: 'POST', key, binary: true,
    body: {
      text: script,
      model_id: settings.model || 'eleven_multilingual_v2',
      voice_settings: {
        stability: settings.stability ?? 0.5,
        similarity_boost: settings.similarity ?? 0.75,
        style: settings.style ?? 0,
        speed: settings.speed ?? 1.0,
        use_speaker_boost: true,
      },
    },
  })
  fs.writeFileSync(outPath, buf)
  return outPath
}

// Cues joined into something worth speaking. The transcript is what was said, with
// its timings; a voiceover wants the words as prose, and one sentence per cue reads
// as a list when spoken back.
function scriptFromCues(cues) {
  return (cues || [])
    .map(c => String(c.text || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

module.exports = { status, connect, clearKey, voices, speak, scriptFromCues, getKey }
