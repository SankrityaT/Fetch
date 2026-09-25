// Three directions for a product (ui/directions.js), and the four things that have to
// be true of all of them.
//
// One: the first is actually derived. A direction that says it came from the product
// and then draws Fetch's gold on Fetch's dark is worse than no direction at all.
//
// Two: the three disagree. If two of them land on the same ground in the same face,
// somebody is being asked to pick between a picture and itself.
//
// Three: every theme decides all twenty-one tokens, and every look validates with no
// warnings, because a direction is the artifact that is supposed to be complete.
//
// Four: none of it needs a palette. Nothing is sampled on a project Fetch has never
// seen, and three honest directions beat one apologetic one.
const T = require('../ui/compositor/tokens')
const L = require('../ui/look')
const { directionsFor } = require('../ui/directions')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
// assertComplete throws, and a throw here would take the suite down instead of naming
// the theme that is short. Its message already says which tokens are missing.
const incomplete = ds => ds.map(d => {
  try { T.assertComplete(d.theme, d.id); return null } catch (e) { return e.message }
}).filter(Boolean)
const grounds = ds => new Set(ds.map(d => JSON.stringify(L.resolve(d.look).background))).size
const faces = ds => new Set(ds.map(d => L.resolve(d.look).captions.font)).size

console.log('derived from a product')
{
  const ds = directionsFor({
    palette: { bg: '#0B1020', ink: '#E6E8EF', accent: '#5B8CFF' },
    fonts: [{ family: 'Onest', file: '/p/Resources/Onest-VF.ttf' }, { family: 'DM Sans', file: '/p/x.ttf' }],
    product: 'Harbour',
  })
  is('three directions', ds.length, 3)
  is('the first stands on the product\'s own ground', ds[0].look.background.color, '#0B1020')
  is('its accent is the product\'s accent', ds[0].theme.accent, '#5B8CFF')
  is('and it is set in the face the product ships', ds[0].look.captions.font, 'Onest')
  is('a dark sampled ground takes the dark theme\'s neutrals', ds[0].theme.shell, T.THEMES.dark.shell)
  is('the departure turns the tone over', ds[1].look.device.theme, 'light')
  is('three grounds, not one', grounds(ds), 3)
  is('three faces, not one', faces(ds), 3)
  is('every one says what it is for', ds.every(d => d.why.length > 30 && d.why.trim().endsWith('.')), true)
  is('every theme decides all twenty-one tokens', incomplete(ds), [])
  is('every look validates with nothing to warn about', ds.flatMap(d => L.validate(d.look).warnings), [])
}

console.log('a light product, and a half-sampled one')
{
  const light = directionsFor({ palette: { bg: '#FAFAF7' }, fonts: [], product: 'Ledger' })
  is('a light sampled ground takes the light theme\'s neutrals', light[0].theme.shell, T.THEMES.light.shell)
  is('and the departure goes dark against it', light[1].look.device.theme, 'dark')
  const junk = directionsFor({ palette: { bg: 'rgb(11,16,32)', accent: null }, fonts: [{}], product: 42 })
  is('a colour Fetch cannot read is dropped, not drawn', junk[0].look.background.color, T.THEMES.dark.ink)
  is('and it still validates clean', junk.flatMap(d => L.validate(d.look).warnings), [])
}

console.log('nothing sampled at all')
{
  const ds = directionsFor({})
  is('still three', ds.length, 3)
  is('still three grounds and three faces', [grounds(ds), faces(ds)], [3, 3])
  is('the first borrows nothing it was not given', ds[0].look.captions.font, 'SF Pro')
  is('and says as much rather than pretending', /nothing is borrowed/.test(ds[0].why), true)
  is('still complete themes and still clean looks', [incomplete(ds), ds.flatMap(d => L.validate(d.look).warnings)], [[], []])
}

console.log('what the product hands over has to be legible where it lands')
{
  // The product's ink is what is written on the product's ground. It is not necessarily
  // readable on the shell Fetch draws round it, and these two are different surfaces.
  // A near-black sampled off a dark app went straight onto the dark shell and the
  // device's own lettering disappeared; white off a light app did the same on bone.
  const ratio = (a, b) => { const x = L.luma(a), y = L.luma(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const dark = directionsFor({ palette: { ink: '#111111' } })[0]
  const lit = directionsFor({ palette: { bg: '#FFFFFF', ink: '#FFFFFF' } })[0]
  is('a near-black ink is refused on a dark shell', dark.theme.text !== '#111111', true)
  is('a white ink is refused on a bone shell', lit.theme.text !== '#FFFFFF', true)
  is('and both land readable instead', [ratio(dark.theme.text, dark.theme.shell) >= 4, ratio(lit.theme.text, lit.theme.shell) >= 4], [true, true])
  // an ink that IS readable there is still taken: the guard is a floor, not a veto
  const ok = directionsFor({ palette: { bg: '#101010', ink: '#E8E2DA' } })[0]
  is('a readable ink is still the product\'s own', ok.theme.text, '#E8E2DA')
}

console.log('a departure has to depart')
{
  // Two fixed faces collapsed the set whenever the product already used one of them.
  for (const family of ['New York', 'Helvetica Neue', 'Onest']) {
    const f = directionsFor({ fonts: [{ family }] }).map(d => d.theme.font)
    is(`three faces when the product sets ${family}`, new Set(f).size, 3)
    is('  and the first is still the product\'s own', f[0], family)
  }
  // and the press stock cannot be the ground direction one is already standing on
  const clash = directionsFor({ palette: { bg: '#F2EFE9' } })
  is('press moves off a stock the product already uses',
    clash[0].look.background.color !== clash[2].look.background.color, true)
}

console.log('nothing at all, including nothing')
{
  // the doc comment promised this and the parameter default only covered undefined
  is('null is three directions, not a throw', directionsFor(null).length, 3)
  is('so is nothing', directionsFor().length, 3)
  is('so is rubbish', directionsFor(7).length, 3)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
