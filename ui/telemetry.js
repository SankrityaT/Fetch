// Anonymous install counting. Main-process module, required from main.js.
//
// What it sends: a random id generated on this machine, the app version, and the
// macOS version. That is the whole payload. It never sees a filename, a recording,
// a transcript, or anything a person typed, and there is no account to attach it to.
// The id is random bytes, not derived from the hardware, so it identifies an install
// and nothing else.
//
// It is off the hot path entirely: the first ping waits until the app has settled,
// every failure is swallowed, and nothing here can block the UI or a recording.

const fs = require('fs')
const path = require('path')
const os = require('os')
const https = require('https')
const http = require('http')
const crypto = require('crypto')

let app
try { ({ app } = require('electron')) } catch {}

// Where to report to. In development this comes from the environment; in a packaged
// app the environment is empty, so build.sh writes the value into metrics.json beside
// this file. Reading only the env var meant a release could never report anything,
// however carefully the build was run.
// With neither set the module does nothing at all, which is the right default for a fork.
function configuredEndpoint() {
  if (process.env.FETCH_METRICS_URL) return process.env.FETCH_METRICS_URL
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'metrics.json'), 'utf8'))
    if (j && typeof j.url === 'string') return j.url
  } catch {}
  return ''
}
const ENDPOINT = configuredEndpoint()
const FIRST_PING_MS = 30 * 1000          // let launch finish before touching the network
const EVERY_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 5000

let timer = null
let getPrefs = () => ({})

function idPath() {
  const dir = app ? app.getPath('userData') : path.join(os.homedir(), '.fetch')
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return path.join(dir, 'install.json')
}

// One random id per install, created once and reused. Deleting it just makes this
// install look new, which is a fine thing for a person to be able to do.
function installId() {
  const p = idPath()
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (j && typeof j.id === 'string' && j.id.length >= 16) return j.id
  } catch {}
  const id = crypto.randomBytes(16).toString('hex')
  try { fs.writeFileSync(p, JSON.stringify({ id, since: new Date().toISOString().slice(0, 10) })) } catch {}
  return id
}

function send(event) {
  if (!ENDPOINT) return
  let body
  try {
    body = JSON.stringify({
      id: installId(),
      event,
      v: app ? app.getVersion() : '0',
      os: os.release(),
      arch: process.arch,
    })
  } catch { return }

  post(ENDPOINT, body, 1)
}

// Hosts routinely redirect between the apex and www, and a POST that ignores the
// response would swallow that 308 and never reach the endpoint again. One hop is
// enough to survive it; more than one and something is wrong anyway.
function post(endpoint, body, hopsLeft) {
  try {
    const u = new URL(endpoint)
    // Pick the transport from the URL rather than always reaching for https: an
    // http endpoint used to attempt a TLS handshake against a plain server and fail
    // silently, which is indistinguishable from working.
    const transport = u.protocol === 'http:' ? http : https
    const req = transport.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      timeout: TIMEOUT_MS,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      const loc = res.headers && res.headers.location
      if (hopsLeft > 0 && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume()
        return post(new URL(loc, endpoint).toString(), body, hopsLeft - 1)
      }
      res.resume()                   // drain and forget, the body is of no interest
    })
    req.on('error', () => {})        // offline, blocked, endpoint down: all fine
    req.on('timeout', () => req.destroy())
    req.write(body)
    req.end()
  } catch {}
}

function tick() {
  const p = getPrefs() || {}
  if (p.telemetry === false) return   // opted out, stay quiet
  send('active')
}

function start(readPrefs) {
  if (typeof readPrefs === 'function') getPrefs = readPrefs
  if (!ENDPOINT || timer) return
  setTimeout(() => { tick(); timer = setInterval(tick, EVERY_MS) }, FIRST_PING_MS)
}

function stop() { clearInterval(timer); timer = null }

module.exports = { start, stop, installId, enabled: () => !!ENDPOINT }
