// "Always allow": a yes that outlives the run, and the two things that must stay true
// about it. One, an agent can never grant itself one. Two, no yes of any length reaches
// an act Fetch refuses to everyone. Both are checked against the real policy rather than
// against a copy of its tables.
//
// Plus the shape of the question itself, which is where the freeze came from: a
// parentless message box on macOS is -[NSAlert runModal], and that blocks Electron's
// main thread until somebody clicks it. With the display asleep nobody ever does, and
// the app stops answering entirely, its own one minute deadline included.
const assert = require('assert'), fs = require('fs'), path = require('path')
const policy = require('../ui/record-policy')
const ROOT = path.join(__dirname, '..')
const src = fs.readFileSync(path.join(ROOT, 'ui/agent-bridge.js'), 'utf8')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}

// ── an agent can never grant itself a standing yes ───────────────────────
const patchRefused = patch => {
  try { policy.checkSettingsPatch(patch); return null } catch (e) { return e.message }
}
is('set_settings refuses alwaysAllow outright',
  /alwaysAllow can only be changed by a person/.test(patchRefused({ alwaysAllow: [{ key: 'sim|tap|X' }] }) || ''), true)
is('and refuses the whole patch when it is smuggled in beside a legal key',
  /alwaysAllow can only be changed by a person/.test(patchRefused({ camera: true, alwaysAllow: [] }) || ''), true)
is('alwaysAllow is named human only', policy.HUMAN_ONLY_PREFS ? policy.HUMAN_ONLY_PREFS.includes('alwaysAllow') : null, true)

// ── no yes reaches what Fetch refuses to everyone ────────────────────────
// simDecide is given consent for the verb, which is the strongest yes there is. The
// destroying verbs must still be refused, which is what makes the standing grant safe:
// it can only ever hold a key for a question that was actually asked.
for (const verb of ['erase', 'delete', 'create', 'clone', 'upgrade', 'uninstall']) {
  const v = policy.simDecide(verb, { udid: 'U1', device: 'A Phone', consent: [verb] }, {})
  is(`${verb} is refused even with consent for it`, v.allow, false)
  is(`  and never asks, so nothing can be remembered for it`, !!v.needsConsent, false)
}
// the framebuffer grab is refused for its own reason, not for consent
is('recordVideo stays refused', policy.simDecide('io recordVideo', { consent: ['recordvideo'] }, {}).allow, false)

// a verb that does ask is the only kind a grant can ever cover
const tap = policy.simDecide('tap', { udid: 'U1', device: 'A Phone' }, {})
is('tap asks rather than refusing', [tap.allow, !!tap.needsConsent], [false, true])

// ── the standing grant is honoured, written and revocable ────────────────
is('a grant is checked before the question, for a take', /if \(allowedAlways\(key\)\) return\b/.test(src), true)
is('and before the question for driving a device', /if \(allowedAlways\(key\)\) return true/.test(src), true)
is('an Always answer is written to prefs', /if \(answer === 'always'\) rememberAlways\(key/.test(src), true)
is('each grant carries the words the person read and the day', /\{ key, label: label \|\| key, at: new Date\(\)\.toISOString\(\) \}/.test(src), true)
is('grants live in prefs, not in memory, so a restart keeps them', /deps\.setPrefs\(\{ alwaysAllow: next \}\)/.test(src), true)

// ── the question must never block the main thread ────────────────────────
const from = src.indexOf('async function askPerson(')
const ask = src.slice(from, src.indexOf('\n}', from) + 2)
is('the dialog is given a window to hang off', /deps\.askHost \? deps\.askHost\(\) : null/.test(ask), true)
is('and only falls back to parentless when there is no window', /host \? dialog\.showMessageBox\(host, opts\) : dialog\.showMessageBox\(opts\)/.test(ask), true)
is('the deadline is still there', /ASK_WAIT_MS/.test(ask), true)
is('a yes after Esc still does not act', /deps\.held && deps\.held\(\)/.test(ask), true)
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
is('askHost shows the window without taking focus', /askHost: \(\) => \{[\s\S]{0,400}showInactive\(\)/.test(mainSrc), true)
is('and hands back a real window, never a hidden one it did not show', /if \(!control \|\| control\.isDestroyed\(\)\) return null/.test(mainSrc), true)

// ── and it can be taken back, which is what makes it a permission ────────
const setSrc = fs.readFileSync(path.join(ROOT, 'ui/settings.js'), 'utf8')
is('Settings lists the grants', /id="alwaysChips"/.test(setSrc), true)
is('under a heading that says what they are', /Always allowed/.test(setSrc), true)
is('each grant carries the day it was given', /grantDay\(g\.at\)/.test(setSrc), true)
is('each has a button that ends it', /data-revoke="/.test(setSrc), true)
is('revoking writes the shorter list back', /savePrefs\(\{ alwaysAllow: left \}\)/.test(setSrc), true)
is('and says the asking is back', /Fetch will ask again before/.test(setSrc), true)
is('an empty list says so rather than showing nothing', /Nothing is always allowed/.test(setSrc), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
