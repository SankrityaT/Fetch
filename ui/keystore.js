// Where a third party's API key lives. Main-process module, used by ui/voice.js
// (ElevenLabs) and ui/unsplash.js (Unsplash).
//
// Both keys used to be generic passwords created by `/usr/bin/security`. Creating an
// item that way puts `/usr/bin/security` itself into the item's access control list, so
// every later read through that binary is allowed with no prompt. Anything running as
// the person can then do this:
//
//     security find-generic-password -a fetch -s fetch-unsplash -w
//
// and get the key back in plain text. The chat pane's engines keep their own shell, and
// a read-only shell is enough to run that line, so the key would land in a model's
// context, which is the one place this app promises it never goes.
//
// So the key is held by Electron's safeStorage instead. Its encryption key is a Keychain
// item bound to Fetch's own signed binary rather than to a general purpose tool, and the
// ciphertext sits in a file only the person can read (0600) under the app's own data
// folder. A shell that reads the file gets bytes it has no key for, and a shell that
// asks the Keychain for Fetch's encryption key is refused or prompts.
//
// A key already in the old Keychain item is migrated the first time it is read, and the
// old item is deleted, so nobody has to type theirs again and the readable copy goes.
//
// Where safeStorage is not there at all (plain node, a test, a build with encryption
// unavailable) this falls back to the old Keychain item rather than writing a key in
// clear: worse than safeStorage, still better than a plain file.

'use strict'
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const ACCOUNT = 'fetch'

// ---------- the old home, kept only to empty it ----------
const sec = args => new Promise((resolve, reject) => {
  execFile('/usr/bin/security', args, { timeout: 10000 }, (err, stdout) => {
    // stderr is not passed on: it is the tool's own words, and could quote the key
    if (err) return reject(new Error('keychain'))
    resolve(String(stdout).trim())
  })
})
const legacy = service => ({
  async get() {
    try { return (await sec(['find-generic-password', '-a', ACCOUNT, '-s', service, '-w'])) || null }
    catch { return null }
  },
  // Known wart of this path: `security -w <value>` puts the key in argv, briefly visible
  // to `ps` on this machine. It is why it is the fallback and not the home.
  async set(key) { await sec(['add-generic-password', '-a', ACCOUNT, '-s', service, '-w', key, '-U']) },
  async clear() { try { await sec(['delete-generic-password', '-a', ACCOUNT, '-s', service]) } catch {} },
})

// ---------- safeStorage ----------
function electron() {
  try {
    const e = require('electron')
    if (!e || !e.safeStorage || !e.app) return null
    if (typeof e.safeStorage.isEncryptionAvailable !== 'function' || !e.safeStorage.isEncryptionAvailable()) return null
    return e
  } catch { return null }
}

/**
 * store(service) -> { get, set, clear }, the same three the old keychain object had.
 *
 * `service` is the old Keychain service name, so it also names the file and says which
 * legacy item to migrate from.
 */
function store(service, opts = {}) {
  const old = opts.legacy || legacy(service)
  const e = opts.electron === undefined ? electron() : opts.electron
  if (!e) return old

  const dir = opts.dir || path.join(e.app.getPath('userData'), 'keys')
  const file = path.join(dir, service + '.bin')

  const write = buf => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = file + '.part'
    fs.writeFileSync(tmp, buf, { mode: 0o600 })
    fs.renameSync(tmp, file)
    try { fs.chmodSync(file, 0o600) } catch {}
  }

  return {
    async get() {
      try {
        if (fs.existsSync(file)) {
          const k = e.safeStorage.decryptString(fs.readFileSync(file))
          return String(k || '').trim() || null
        }
      } catch { /* unreadable ciphertext is the same as no key: ask for it again */ }
      // first run after the change: take what the old item holds, then empty it
      const was = await old.get()
      if (!was) return null
      try { write(e.safeStorage.encryptString(was)); await old.clear() } catch {}
      return was
    },
    async set(key) {
      const k = String(key || '').trim()
      if (!k) throw new Error('no key given')
      write(e.safeStorage.encryptString(k))
      // and nothing readable left behind from before
      await old.clear()
    },
    async clear() {
      try { fs.rmSync(file, { force: true }) } catch {}
      await old.clear()
    },
  }
}

module.exports = { store, ACCOUNT }
