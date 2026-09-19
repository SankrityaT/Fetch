const { smartName, isAutoName, fit, productFromDomain, productFromTitle, dominantFront, namePrompt, parseAgentName } = require('../ui/naming')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` + (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}

is('app and title', smartName({ app: 'Linear', title: 'Issue 42 triage' }), 'Linear · Issue 42 triage')
is('what was said beats the title', smartName({ app: 'Xcode', title: 'Fetch.xcodeproj', said: 'Open the filter panel' }), 'Xcode · Open the filter panel')
is('a browser tab is named after the page', smartName({ app: 'Google Chrome', title: 'Pull request 12 - Google Chrome' }), 'Pull request 12')
is('a browser tab keeps what was said', smartName({ app: 'Arc', title: 'Linear', said: 'Triage issue 42' }), 'Linear · Triage issue 42')
is('a browser with no title still names the browser', smartName({ app: 'Safari', title: '' }), 'Safari')
is('an em-dash suffix too', smartName({ app: 'Arc', title: 'Dashboard \u2014 Arc' }), 'Dashboard')
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

// ── the product behind a browser tab ──
is('a Vercel deploy is its own product', productFromDomain('songscription-library.vercel.app'), 'Songscription')
is('a whole URL works too', productFromDomain('https://songscription-library.vercel.app/songs?q=easy'), 'Songscription')
is('a branch preview drops the branch', productFromDomain('my-app-git-feature-x-team.vercel.app'), 'My App')
is('a preview hash and team are dropped', productFromDomain('my-app-abc123d-team.vercel.app'), 'My App')
is('a short first word keeps its generic second', productFromDomain('my-app.netlify.app'), 'My App')
is('a subdomain is not the product', productFromDomain('app.linear.app'), 'Linear')
is('a two-level suffix', productFromDomain('www.bbc.co.uk'), 'BBC')
is('brand capitals', productFromDomain('github.com'), 'GitHub')
is('a Google product', productFromDomain('docs.google.com'), 'Google Docs')
is('localhost is nobody', productFromDomain('localhost:3000'), null)
is('an IP is nobody', productFromDomain('192.168.0.1'), null)
is('rubbish is nobody', productFromDomain('not a domain'), null)
is('page | brand', productFromTitle('Library | Songscription'), { product: 'Songscription', page: 'Library' })
is('brand - page when the end is a path', productFromTitle('GitHub - pumpkinredbean/bside'), { product: 'GitHub', page: 'pumpkinredbean/bside' })
is('a title that is an address', productFromTitle('songscription-library.vercel.app'), { product: 'Songscription', page: '' })
is('one word says nothing about whose', productFromTitle('Dashboard'), { product: null, page: 'Dashboard' })
is('a playing tab keeps its product, not the speaker', productFromTitle('Some video - YouTube 🔊'), { product: 'YouTube', page: 'Some video' })
is('a muted or recording tab too', productFromTitle('🔴 Standup | Google Meet'), { product: 'Google Meet', page: 'Standup' })
is('status after the browser name', smartName({ app: 'Google Chrome', title: 'Some video - YouTube - Google Chrome 🔊' }), 'YouTube · Some video')
is('a written alert goes too', productFromTitle('Some video - YouTube - Audio playing'), { product: 'YouTube', page: 'Some video' })
is('a tagline is not the product', productFromTitle('Tend · Your spreadsheet workspace'), { product: 'Tend', page: 'Your spreadsheet workspace' })
is('nor is a phrase that goes on in lower case', productFromTitle('Linear – Plan and build products'), { product: 'Linear', page: 'Plan and build products' })
is('a take on a tagline tab is named for the brand', smartName({ app: 'Google Chrome', title: 'Tend · Your spreadsheet workspace - Google Chrome' }), 'Tend · Your spreadsheet workspace')
is('a title that is only a glyph says nothing', smartName({ app: 'Safari', title: '🔊' }), 'Safari')
is('the name prompt never carries the glyph', /🔊/.test(namePrompt({ app: 'Google Chrome', title: 'Some video - YouTube 🔊' })), false)
is('a browser take is named after the product', smartName({ app: 'Google Chrome', title: 'Library | Songscription - Google Chrome' }), 'Songscription · Library')
is("Playwright's Chrome is a browser too", smartName({ app: 'Google Chrome for Testing', title: 'Library | Songscription' }), 'Songscription · Library')
is('a browser take on a bare address', smartName({ app: 'Arc', title: 'songscription-library.vercel.app' }), 'Songscription')
is('a known domain wins over the title', smartName({ app: 'Safari', title: 'Home', domain: 'songscription-library.vercel.app' }), 'Songscription · Home')

// ── the app in front for most of the take ──
{
  const n = (k, s) => Array.from({ length: k }, () => s)
  const song = { app: 'Google Chrome', title: 'Library | Songscription' }
  const gh = { app: 'Google Chrome', title: 'Pull requests · GitHub' }
  const code = { app: 'Code', title: 'app.js' }
  const d = dominantFront([...n(20, song), ...n(8, gh), ...n(12, code)])
  is('most samples win', [d.app, d.product, d.title], ['Google Chrome', 'Songscription', 'Library | Songscription'])
  is('its share', d.share, 0.5)
  is('a browser counts per product, not as one app',
    dominantFront([...n(6, song), ...n(6, gh), ...n(8, code)]).app, 'Code')
  is('a tie goes to what was in front later', dominantFront([...n(3, code), ...n(3, song)]).product, 'Songscription')
  is('the commonest title within the winner', dominantFront([...n(2, { app: 'Xcode', title: 'A' }), ...n(5, { app: 'Xcode', title: 'B' })]).title, 'B')
  is('a window take counts only its own app', dominantFront([...n(9, song), ...n(2, code)], { app: 'Code' }).app, 'Code')
  is('no samples, no answer', dominantFront([]), null)
  is('samples without an app are ignored', dominantFront([null, {}, { title: 'x' }]), null)
}

// ── names from the agent ──
{
  const p = namePrompt({ app: 'Google Chrome', title: 'Songscription', product: 'Songscription', words: 'word '.repeat(200) })
  is('the prompt carries at most 80 words', p.split('"')[1].split(' ').length, 80)
  is('the prompt names the product to use', /use "Songscription"/.test(p), true)
  is('the prompt never carries a path', /\/Users|\.mov/.test(p), false)
}
is('a plain reply', parseAgentName('Songscription · Library Tour'), 'Songscription · Library Tour')
is('quotes, a label and a full stop go', parseAgentName('Name: "songscription · library tour."'), 'Songscription · Library Tour')
is('another separator becomes the middle dot', parseAgentName('Songscription - Search and Filters'), 'Songscription · Search and Filters')
is('a colon too', parseAgentName('Songscription: Search and Filters'), 'Songscription · Search and Filters')
is('only the first line', parseAgentName('Linear · Issue Triage\n\nThis name reflects...'), 'Linear · Issue Triage')
is('an apology is not a name', parseAgentName("I'm sorry, I can't see the recording."), null)
is('a paragraph is not a name', parseAgentName('This recording shows someone walking through the library of songs and filtering by key and level'), null)
is('nothing is not a name', parseAgentName(''), null)
is('brand capitals survive title case', parseAgentName('GitHub · pull request review'), 'GitHub · Pull Request Review')
is('a chatty opener is not a name', parseAgentName('Sure! Here is a name'), null)
is('an unread count is not part of the name', smartName({ app: 'Google Chrome', title: '(3) Inbox - Gmail' }), 'Gmail · Inbox')
is('an editor title separator becomes the middle dot', smartName({ app: 'Code', title: 'app.js — majuro' }), 'Code · app.js · majuro')

// ── automatic names, told apart from typed ones ──
is('a name Fetch gave from the app is auto', isAutoName('Songscription · Library', { auto: 'Songscription · Library', by: 'app' }), true)
is('as is one the agent gave', isAutoName('Songscription · Library Tour', { auto: 'Songscription · Library Tour', by: 'agent' }), true)
is('the same take renamed by hand is not', isAutoName('Launch demo', { auto: 'Songscription · Library', by: 'app' }), false)
is('a typed name matching nothing is not', isAutoName('Songscription · Library', null), false)
is('a note with no name proves nothing', isAutoName('Demo', { by: 'app' }), false)
is('a timestamp stays auto whatever the note', isAutoName('recording-1789677081300', { auto: 'X', by: 'app' }), true)

// Aside: a display take came out "Aside · Rinse interview prep and HR screen recap ⋅ Chats",
// the person's private chat title as a folder name
{
  const chat = { app: 'Aside', title: 'Rinse interview prep and HR screen recap ⋅ Chats' }
  is('Aside is a browser', smartName({ app: 'Aside', title: 'Library | Songscription' }), 'Songscription · Library')
  is('its own chats are Aside, never the chat title', smartName(chat), 'Aside · Chats')
  const d = dominantFront([chat, chat, { app: 'Aside', title: 'Library | Songscription' }])
  is('and win as Aside', smartName({ app: d.app, title: d.title, product: d.product }), 'Aside · Chats')
  is('the agent is not told the chat title', /Rinse/.test(namePrompt({ ...chat, product: 'Aside', words: 'here is the demo of it' })), false)
  is('a web tab in Aside keeps its page', smartName({ app: 'Aside', title: '(16) CSE 469F26 – Ed Discussion' }), 'Ed Discussion · CSE 469F26')
}

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
