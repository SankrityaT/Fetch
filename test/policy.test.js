const p = require('../ui/record-policy')
let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` + (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}

// a human is never gated, whatever the mode
is('human window on a protected app', p.decide({ by:'human', kind:'window', app:'1Password' }, { mode:'allowed' }).allow, true)

// protected apps refused for agents in every mode
for (const mode of ['ask','allowed','open']) {
  is(`agent + 1Password refused (${mode})`, p.decide({ by:'agent', kind:'window', app:'1Password 8' }, { mode }).allow, false)
}
is('refusal names the app', p.decide({ by:'agent', kind:'window', app:'Messages' }, { mode:'open' }).reason, 'Messages is on the never record list')

// open mode lets ordinary apps through
is('agent + Chrome in open mode', p.decide({ by:'agent', kind:'window', app:'Google Chrome' }, { mode:'open' }).allow, true)

// ask mode flags approval rather than refusing
is('ask mode needs approval', p.decide({ by:'agent', kind:'window', app:'Google Chrome' }, { mode:'ask' }).needsApproval, true)

// allowed mode is default-deny
is('allowed mode denies unlisted', p.decide({ by:'agent', kind:'window', app:'Google Chrome' }, { mode:'allowed', allowedApps:['Simulator'] }).allow, false)
is('allowed mode permits listed', p.decide({ by:'agent', kind:'window', app:'Simulator' }, { mode:'allowed', allowedApps:['Simulator'] }).allow, true)
is('allowed mode refuses whole displays', p.decide({ by:'agent', kind:'display' }, { mode:'allowed', allowedApps:['Simulator'] }).allow, false)

// a window we cannot attribute is refused, not waved through
is('unknown owner refused', p.decide({ by:'agent', kind:'window' }, { mode:'open' }).allow, false)

// display captures exclude protected windows instead of refusing
is('exclusion picks protected windows only',
  p.windowsToExclude([
    { id: 1, app: 'Google Chrome' }, { id: 2, app: 'Messages' },
    { id: 3, app: '1Password 8' },   { id: 4, app: 'iTerm2' },
  ], {}),
  [2, 3])

// matching is symmetric on substrings both ways
is('owner longer than entry', p.isProtected('1Password 8', ['1Password']), true)
is('entry longer than owner', p.isProtected('Mail', ['Mail']), true)
is('case insensitive', p.isProtected('messages', ['Messages']), true)
is('no false positive', p.isProtected('Google Chrome', p.DEFAULT_NEVER), false)

// an unknown mode must not silently become permissive
is('garbage mode falls back to ask', p.decide({ by:'agent', kind:'window', app:'Chrome' }, { mode:'nonsense' }).needsApproval, true)

// ---- settings an agent may change ----
const throws = (fn) => { try { fn(); return null } catch (e) { return e.message } }
is('agent cannot open recording access',
  /only be changed by a person/.test(throws(() => p.checkSettingsPatch({ recordAccess: 'always' }))), true)
is('agent cannot empty the never-record list',
  /only be changed by a person/.test(throws(() => p.checkSettingsPatch({ neverRecord: [] }))), true)
is('agent cannot allow apps',
  /only be changed by a person/.test(throws(() => p.checkSettingsPatch({ allowedRecordApps: ['1Password'] }))), true)
is('agent cannot change telemetry',
  /only be changed by a person/.test(throws(() => p.checkSettingsPatch({ telemetry: true }))), true)
is('a refused key sinks the whole patch, nothing half applied',
  /recordAccess/.test(throws(() => p.checkSettingsPatch({ camera: false, recordAccess: 'always' }))), true)
is('agent cannot make its own takes invisible or visible',
  /only be changed by a person/.test(throws(() => p.checkSettingsPatch({ agentTakesVisible: true }))), true)
is('unknown keys are refused', /not a setting/.test(throws(() => p.checkSettingsPatch({ theme: 'light' }))), true)
is('countdown only takes 0, 3 or 5', /countdown/.test(throws(() => p.checkSettingsPatch({ countdown: 4 }))), true)
is('booleans are not coerced from strings', /true or false/.test(throws(() => p.checkSettingsPatch({ mic: 'no' }))), true)
is('a missing folder is refused', /saveDir/.test(throws(() => p.checkSettingsPatch({ saveDir: '/nope' }, () => false))), true)
is('null folder means ~/Movies/Fetch', p.checkSettingsPatch({ saveDir: null }), { saveDir: null })
is('a good patch passes through', p.checkSettingsPatch({ camera: false, countdown: 0 }), { camera: false, countdown: 0 })

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
