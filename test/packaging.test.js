// What the build puts in the bundle, held to what the code loads at runtime.
//
// This suite exists because render.html and agent-cursor.html were never copied into
// the app. Nothing caught it: the build named its files one at a time, and every test
// runs from the source tree where the files are simply there. In a packaged Fetch the
// compositor's window failed with ERR_FILE_NOT_FOUND, so every contact sheet, every
// preview frame and every export was broken, on a suite that was fully green.
//
// So the rule is not "render.html is copied". It is: anything the code loads by path
// must be in the bundle, whatever gets added next.
const fs = require('fs'), path = require('path')
const ROOT = path.join(__dirname, '..')
const build = fs.readFileSync(path.join(ROOT, 'build.sh'), 'utf8')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}

// every page loaded from main.js or anything under ui/
const sources = [path.join(ROOT, 'main.js'), ...fs.readdirSync(path.join(ROOT, 'ui'))
  .filter(f => f.endsWith('.js')).map(f => path.join(ROOT, 'ui', f))]
const wanted = new Set()
for (const f of sources) {
  const src = fs.readFileSync(f, 'utf8')
  for (const m of src.matchAll(/loadFile\(\s*(?:path\.join\([^)]*?['"]\.\.['"]\s*,\s*)?['"]([^'"]+\.html)['"]/g)) {
    wanted.add(path.basename(m[1]))
  }
}
is('the sweep found the pages the code loads', wanted.size > 0, true)

// the copy line, and what the glob really matches on disk
const copyLine = (build.split('\n').find(l => /^cp main\.js/.test(l)) || '')
is('the build has one line that copies the root files', !!copyLine, true)
const rootPages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'))
const copied = new Set(/\*\.html/.test(copyLine)
  ? rootPages
  : copyLine.split(/\s+/).filter(t => t.endsWith('.html')))

for (const page of [...wanted].sort()) {
  const atRoot = fs.existsSync(path.join(ROOT, page))
  // a page that lives under ui/ rides along with `cp -R ui`, and needs nothing here
  if (!atRoot) continue
  is(`${page} is copied into the bundle`, copied.has(page), true)
}

// and the two that were missing, by name, so a rewrite of the sweep cannot quietly
// stop covering the exact pages this was written for
for (const page of ['render.html', 'agent-cursor.html']) {
  is(`${page} is still copied`, copied.has(page), true)
  is(`  and is still a page the code loads`, wanted.has(page), true)
}

// the directories the app cannot run without
for (const dir of ['ui', 'assets']) {
  is(`${dir}/ is copied whole`, new RegExp(`cp -R ${dir} `).test(build), true)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
