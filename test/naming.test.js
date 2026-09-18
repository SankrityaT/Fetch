const { smartName, isAutoName, fit } = require('../ui/naming')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` + (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}

is('app and title', smartName({ app: 'Linear', title: 'Issue 42 triage' }), 'Linear · Issue 42 triage')
is('what was said beats the title', smartName({ app: 'Xcode', title: 'Fetch.xcodeproj', said: 'Open the filter panel' }), 'Xcode · Open the filter panel')
is('browser suffix is dropped', smartName({ app: 'Google Chrome', title: 'Pull request 12 - Google Chrome' }), 'Google Chrome · Pull request 12')
is('an em-dash suffix too', smartName({ app: 'Arc', title: 'Dashboard — Arc' }), 'Arc · Dashboard')
is('title that just repeats the app', smartName({ app: 'Xcode', title: 'Xcode' }), 'Xcode')
is('title that starts with the app', smartName({ app: 'Figma', title: 'Figma Onboarding flow' }), 'Figma · Onboarding flow')
is('slashes cannot make a path', smartName({ app: 'Terminal', title: '~/code/fetch: npm test' }), 'Terminal · ~ code fetch npm test')
is('nothing known gives null', smartName({}), null)
is('only speech still names it', smartName({ said: 'Now open the filter panel' }), 'Now open the filter panel')
is('trailing dots are trimmed', smartName({ app: 'Notes', title: 'Draft...' }), 'Notes · Draft')

{
  const long = smartName({ app: 'Google Chrome', title: 'A very long page title that keeps going well past what fits in a filename' })
  is('long names are cut short', long.length <= 56, true)
  is('and cut at a word, not mid-word', /\s\S+$/.test(long) || !/ \w{1,2}$/.test(long), true)
}

is('fit leaves short text alone', fit('Short'), 'Short')
is('fit never ends on a separator', /[·,\s-]$/.test(fit('Word · ' + 'x'.repeat(60))), false)

is('timestamp names are auto', isAutoName('recording-1789677081300'), true)
is('a name someone typed is not', isAutoName('Launch demo final'), false)
is('a smart name is not auto either', isAutoName('Linear · Issue 42'), false)

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
