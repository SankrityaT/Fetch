// @ at the front door.
//
// The Record screen's composer and the chat pane's are two inputs onto one
// conversation. The @ picker closed over the pane's input and read the pane's popover,
// so typing @ in the hero did nothing at all: no rows, no completion, nothing. The
// giveaway was that the hero already warmed the mention lists on focus, so somebody had
// meant it to work there and only the drawing was missing.
//
// A pick has to become a tag rather than text. A take is called "Yolkling · hatch 3",
// and the typed-through reader only resolves a mention with no spaces in it, so
// completing the name as plain text would silently fail on most of the Library.
const fs = require('fs'), path = require('path')
const ROOT = path.join(__dirname, '..')
const chat = fs.readFileSync(path.join(ROOT, 'ui/chat.js'), 'utf8')
const html = fs.readFileSync(path.join(ROOT, 'control.html'), 'utf8')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}

// ── the hero has somewhere to draw ──────────────────────────────────────
is('the hero form has a picker to draw into', /id="heroMention"/.test(html), true)
is('and a tray for what was picked', /id="heroCtx"/.test(html), true)
is('both inside the hero form, not the chat pane',
  html.indexOf('id="heroMention"') > html.indexOf('id="heroAsk"') &&
  html.indexOf('id="heroMention"') < html.indexOf('id="heroInput"'), true)

// ── the machinery takes the field, instead of closing over one ──────────
is('the query reads the field it is given', /function mentionQuery\(el\) \{\s*\n\s*const v = el\.value, caret = el\.selectionStart/.test(chat), true)
is('the picker draws into the popover it is given', /async function updateMention\(el, pop\)/.test(chat), true)
is('and a pick writes back into that field', /function takeMention\(i, el, pop\)/.test(chat), true)
is('nothing reads the pane composer by name inside them', /takeMention\(i, el, pop\)[\s\S]{0,700}input\.value/.test(chat), false)

// ── both composers are wired through the same helpers ───────────────────
is('there is one wiring helper', /function wireMentions\(el, pop\)/.test(chat), true)
is('the chat uses it', /wireMentions\(input, pane\.querySelector\('#chatMention'\)\)/.test(chat), true)
is('the hero uses it', /if \(heroPop\) wireMentions\(field, heroPop\)/.test(chat), true)
is('there is one key handler', /function mentionKey\(e, el, pop\)/.test(chat), true)
is('the chat defers to it before sending', /if \(mentionKey\(e, input, pane\.querySelector\('#chatMention'\)\)\) return/.test(chat), true)
is('and so does the hero, or Enter would send mid-pick', /if \(heroPop && mentionKey\(e, field, heroPop\)\) return/.test(chat), true)

// ── a pick is a tag, and shows where it was picked ──────────────────────
is('a pick becomes a tag on the conversation', /if \(!tags\.some\(t => t\.path === r\.path\)\) tags\.push\(tagFor\(r\)\)/.test(chat), true)
is('tags paint into every tray that exists', /for \(const host of \[pane\.querySelector\('#chatCtx'\), document\.getElementById\('heroCtx'\)\]\)/.test(chat), true)
is('and the hero tray can drop one again', /heroTray\.addEventListener\('click'/.test(chat), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
