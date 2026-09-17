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

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
