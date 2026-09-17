// What an agent is allowed to record. Pure, no Electron, no filesystem, so the rules
// can be unit tested without a running app.
//
// This module exists because the alternative was a sentence in an MCP tool description
// asking a model not to record your password manager. A rule that is not enforced by
// code is a suggestion, and it gets dropped under pressure exactly when it matters. So
// every path that starts a take goes through decide() first.
//
// Two enforcement points, because a display capture sees everything on screen:
//
//   window target  -> refuse outright if the window belongs to a protected app
//   display target -> allow, but hand the protected windows to the recorder so
//                     ScreenCaptureKit leaves them out of the frame
//
// Without the second one the promise would be a lie: an agent could record the whole
// display and pick up a Messages window that happened to be open.

// Seeded, not empty. An empty list teaches nothing and the first thing a person should
// feel on this screen is that the obvious dangers are already handled.
//
// Matching is by application name, which is the weak part of this design: an app that
// is not on the list is recorded silently, so a miss costs privacy rather than a
// feature. Keep this generous and prefer a false positive, which a person can simply
// remove, over a silent gap they will never notice.
const DEFAULT_NEVER = [
  '1Password', 'Bitwarden', 'Dashlane', 'LastPass', 'Proton Pass', 'Keychain Access',
  'Messages', 'WhatsApp', 'Signal', 'Telegram',
  'Mail', 'System Settings', 'System Preferences',
]

// 'ask'      every agent take needs a person to approve it
// 'allowed'  only apps on the allow list, everything else refused
// 'open'     anything except the never list
const MODES = ['ask', 'allowed', 'open']

const norm = s => String(s || '').trim().toLowerCase()

// Substring both ways, so "1Password" matches the window owner "1Password 8" and a
// person typing "1password 8" still matches the seeded "1Password".
function nameMatches(appName, entry) {
  const a = norm(appName), e = norm(entry)
  if (!a || !e) return false
  return a === e || a.includes(e) || e.includes(a)
}

const isProtected = (appName, neverRecord) =>
  (neverRecord || []).some(n => nameMatches(appName, n))

/**
 * Should this take be allowed to start?
 *
 * @param {object} req
 *   @param {'agent'|'human'} req.by      human takes are never gated, it is their Mac
 *   @param {'window'|'display'} req.kind
 *   @param {string} [req.app]            owning app, required when kind is 'window'
 * @param {object} policy  { mode, neverRecord[], allowedApps[] }
 * @returns {{allow: boolean, reason?: string, needsApproval?: boolean}}
 */
function decide(req = {}, policy = {}) {
  const mode = MODES.includes(policy.mode) ? policy.mode : 'ask'
  const never = policy.neverRecord || DEFAULT_NEVER
  const allowed = policy.allowedApps || []

  // A person pressing record is not something to police.
  if (req.by !== 'agent') return { allow: true }

  if (req.kind === 'window') {
    if (!req.app) return { allow: false, reason: 'cannot tell which app that window belongs to' }
    if (isProtected(req.app, never)) {
      return { allow: false, reason: `${req.app} is on the never record list` }
    }
    if (mode === 'allowed' && !allowed.some(a => nameMatches(req.app, a))) {
      return { allow: false, reason: `${req.app} is not on the allowed apps list` }
    }
  }

  if (req.kind === 'display' && mode === 'allowed') {
    // A display shows every app at once, so "allowed apps only" cannot be honoured by
    // excluding windows. Refusing is the only truthful answer.
    return { allow: false, reason: 'recording a whole display is off while access is set to allowed apps only' }
  }

  if (mode === 'ask') return { allow: true, needsApproval: true }
  return { allow: true }
}

/**
 * Window ids to keep out of a display capture. Passed to ScreenCaptureKit as
 * excludingWindows, so protected apps are absent from the frame rather than blurred
 * afterwards: nothing sensitive is ever written to disk.
 */
function windowsToExclude(windows, policy = {}) {
  const never = policy.neverRecord || DEFAULT_NEVER
  return (windows || [])
    .filter(w => isProtected(w.app, never))
    .map(w => w.id)
}

module.exports = { decide, windowsToExclude, isProtected, DEFAULT_NEVER, MODES }
