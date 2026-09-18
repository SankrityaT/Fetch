// Talks to the running Fetch app over its unix socket, and starts Fetch if it is not
// running yet.
//
// Launching through LaunchServices (`open -b`) rather than spawning the binary is the
// whole point: macOS attributes screen-recording permission to the responsible
// process, so Fetch has to be started as itself. Spawn it as a child of this process
// and the permission would belong to whichever agent CLI is hosting us.
//
// Nothing here may write to stdout. stdout is the MCP protocol stream and a single
// stray byte corrupts it. Diagnostics go to stderr.

import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const BUNDLE_ID = 'com.sankritya.fetch'
const SOCKET = path.join(os.homedir(), 'Library', 'Application Support', 'Fetch', 'agent.sock')

const log = (...a) => process.stderr.write('[fetch-mcp] ' + a.join(' ') + '\n')

let sock = null
let buf = ''
let nextId = 1
const pending = new Map()

function disconnect() {
  if (sock) { try { sock.destroy() } catch {} }
  sock = null
  buf = ''
  for (const [, p] of pending) p.reject(new Error('lost the connection to Fetch'))
  pending.clear()
}

function attach(s) {
  sock = s
  buf = ''
  s.setEncoding('utf8')
  s.on('data', chunk => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const p = pending.get(msg.id)
      if (!p) continue
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error || 'Fetch reported an error'))
    }
  })
  s.on('error', () => disconnect())
  s.on('close', () => disconnect())
}

const tryConnect = () => new Promise(resolve => {
  if (!fs.existsSync(SOCKET)) return resolve(null)
  const s = net.createConnection(SOCKET)
  const done = ok => { s.removeAllListeners('connect'); s.removeAllListeners('error'); resolve(ok ? s : null) }
  s.once('connect', () => done(true))
  s.once('error', () => { try { s.destroy() } catch {}; done(false) })
})

let launching = null

async function ensureConnected() {
  if (sock) return
  let s = await tryConnect()
  if (s) return attach(s)

  // Only one launch attempt at a time, however many tools fire at once.
  if (!launching) {
    launching = (async () => {
      log('Fetch is not running, launching it')
      // -g keeps it from stealing focus; the app still gets to be the responsible
      // process for TCC, which is the reason we go through LaunchServices at all.
      spawn('open', ['-g', '-b', BUNDLE_ID], { stdio: 'ignore', detached: true }).unref()
      const deadline = Date.now() + 25000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 300))
        const again = await tryConnect()
        if (again) return again
      }
      return null
    })().finally(() => { launching = null })
  }
  s = await launching
  if (!s) {
    throw new Error(
      'Could not reach Fetch. Make sure it is installed in /Applications and has been ' +
      'opened once so macOS screen recording permission is granted.')
  }
  attach(s)
}

export async function call(op, args = {}, { timeoutMs = 120000 } = {}) {
  await ensureConnected()
  const id = String(nextId++)
  return await new Promise((resolve, reject) => {
    pending.set(id, {
      resolve, reject,
      timer: setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Fetch did not answer "${op}" in time`))
      }, timeoutMs),
    })
    try { sock.write(JSON.stringify({ id, op, args }) + '\n') }
    catch (e) { pending.delete(id); reject(e) }
  })
}

export { SOCKET, BUNDLE_ID }
