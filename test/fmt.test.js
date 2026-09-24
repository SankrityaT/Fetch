// ui/fmt.js: the one formatter. Every rule it states has a line here, so a change to
// how something reads is a change someone meant.
//
//   node test/fmt.test.js

const assert = require('assert')
const vm = require('vm')
const fs = require('fs')
const path = require('path')
const F = require('../ui/fmt.js')

let passed = 0, failed = 0
const eq = (got, want, what) => {
  try { assert.strictEqual(got, want); passed++ }
  catch (e) { failed++; console.log(`FAIL ${what || ''}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`) }
}
const ok = (cond, what) => { if (cond) passed++; else { failed++; console.log('FAIL ' + what) } }

// --- units are joined, never spaced
eq(F.px(6), '6px', 'px joined')
eq(F.px(6.4), '6px', 'px rounds with no step')
eq(F.px(2.5, 0.5), '2.5px', 'half pixel step shows the half (I4)')
eq(F.px(3, 0.5), '3px', 'whole value on a half step drops .0')
eq(F.px(14, 1), '14px', 'whole step')
for (const s of [F.px(6), F.pct(0.5), F.secs(1.5), F.dur(830), F.deg(12), F.db(3), F.mult(1.7), F.bytes(12.3e6)])
  ok(!/\s/.test(s), `no space in ${JSON.stringify(s)}`)

// --- percent: stored 0..1, decimals from the step
eq(F.pct(0.5), '50%', '0..1 dial as percent (I1)')
eq(F.pct(0.06, { step: 0.01 }), '6%', 'padding')
eq(F.pct(0.6, { step: 0.05 }), '60%', 'shadow')
eq(F.pct(0.062, { step: 0.002 }), '6.2%', 'headline size keeps its step')
eq(F.pct(0.06, { step: 0.002 }), '6%', 'trailing zero dropped')
eq(F.pct(1), '100%', 'full')
eq(F.pct(0), '0%', 'zero')
eq(F.value(18, { unit: '%', scale: 1 }), '18%', 'already a percent (0..100 sliders)')
eq(F.pctOf(18, 0, 40), '45%', 'a dial with no unit as a percent of its range (J8)')
eq(F.pctOf(5, 5, 5), '', 'empty range')

// --- signed controls
eq(F.pct(-0.3, { signed: true }), '-30%', 'signed negative (I1)')
eq(F.pct(0.3, { signed: true }), '+30%', 'signed positive')
eq(F.pct(0, { signed: true }), '0%', 'signed zero has no sign')
eq(F.pct(-0.001, { signed: true }), '0%', 'no minus zero')
eq(F.pct(-0.001), '0%', 'no minus zero unsigned')
eq(F.value(-0.25, { unit: '%', step: 0.01, signed: true }), '-25%', 'offset')

// --- multiplier: x, never ×; at least one decimal, at most two
eq(F.mult(1), '1.0x', 'one decimal minimum (I2)')
eq(F.mult(1.7), '1.7x', 'one decimal')
eq(F.mult(1.04), '1.04x', 'two decimals')
eq(F.mult(1, 0.05), '1.0x', 'step .05 does not force 1.00x')
eq(F.mult(1.05, 0.05), '1.05x', 'step .05')
eq(F.mult(1.8, 0.1), '1.8x', 'zoom pill (S4)')
eq(F.mult(1.83, 0.1), '1.8x', 'step .1 rounds to one decimal')
eq(F.mult(2), '2.0x', 'DESIGN: Z1 2.0x')
eq(F.mult(1.004), '1.0x', 'rounds')
ok(!F.mult(1.5).includes('×'), 'never the times sign')

// --- seconds, degrees, dB
eq(F.secs(0), '0s', 'zero seconds (I2)')
eq(F.secs(0, 0.1), '0s', 'zero seconds with step')
eq(F.secs(1.5, 0.1), '1.5s', 'fade')
eq(F.secs(2, 0.1), '2s', 'whole seconds drop .0')
eq(F.secs(1.25), '1.3s', 'no step: one decimal')
eq(F.deg(0), '0°', 'zero degrees (I2)')
eq(F.deg(-2.5, 0.5), '-2.5°', 'tilt')
eq(F.deg(3, 0.5), '3°', 'tilt whole')
eq(F.value(0.5, { unit: 'deg', scale: 360, step: 0.05 }), '180°', 'shutter in degrees (I1)')
eq(F.db(0), '0dB', 'gain zero')
eq(F.db(10), '+10dB', 'gain signed')
eq(F.db(-6), '-6dB', 'gain negative')
eq(F.db(-3.5, 0.5), '-3.5dB', 'gain half step')

// --- a bare number
eq(F.value(0.5), '0.5', 'bare')
eq(F.value(0.25), '0.25', 'bare two decimals')
eq(F.value(0.123), '0.12', 'bare capped at two')
eq(F.value(3), '3', 'bare whole')

// --- nothing in, nothing out
for (const v of [null, undefined, '', NaN, Infinity, 'abc']) {
  eq(F.value(v, { unit: '%' }), '', 'empty for ' + String(v))
  eq(F.dur(v), '', 'empty dur for ' + String(v))
}

// --- parse is the inverse
eq(F.parse('6%', { unit: '%' }), 0.06, 'percent back')
eq(F.parse('6', { unit: '%' }), 0.06, 'bare typed into a percent box')
eq(F.parse('1.5x', { unit: 'x' }), 1.5, 'mult back')
eq(F.parse('-30%', { unit: '%' }), -0.3, 'signed back')
eq(F.parse('−30%', { unit: '%' }), -0.3, 'real minus back')
eq(F.parse('+10dB', { unit: 'dB' }), 10, 'dB back')
eq(F.parse('180°', { unit: 'deg', scale: 360 }), 0.5, 'shutter back')
eq(F.parse('abc', { unit: 'px' }), null, 'junk')
for (const [v, o] of [[0.06, { unit: '%', step: 0.01 }], [2.5, { unit: 'px', step: 0.5 }], [1.7, { unit: 'x', step: 0.1 }],
                      [-0.3, { unit: '%', signed: true }], [-6, { unit: 'dB' }], [1.5, { unit: 's', step: 0.1 }]])
  ok(Math.abs(F.parse(F.value(v, o), o) - v) < 1e-9, `round trip ${v} ${o.unit}`)

// --- clock positions
eq(F.clock(0), '0:00', 'zero')
eq(F.clock(8), '0:08', 'seconds')
eq(F.clock(8.9), '0:08', 'floored like the playhead')
eq(F.clock(75), '1:15', 'minutes')
eq(F.clock(754), '12:34', 'two digit minutes')
eq(F.clock(3723), '1:02:03', 'hours')
eq(F.clock(-3), '0:00', 'never negative')
eq(F.clock(null), '0:00', 'nothing is zero')
eq(`${F.clock(8)} out`, '0:08 out', 'the out chip (J7)')

// --- elapsed durations (H2)
eq(F.dur(0), '0ms', 'zero')
eq(F.dur(830), '830ms', 'ms joined')
eq(F.dur(999.4), '999ms', 'just under a second')
eq(F.dur(999.6), '1s', 'rounds up into seconds, not 1000ms')
eq(F.dur(4300), '4.3s', 'tenths under ten seconds')
eq(F.dur(4000), '4s', 'whole second drops .0')
eq(F.dur(9960), '10s', 'rounds up out of tenths')
eq(F.dur(12400), '12s', 'whole seconds')
eq(F.dur(59600), '1m', 'rounds up to a minute, not 60s')
eq(F.dur(64000), '1m 4s', 'Activity 64s job (H2)')
eq(F.dur(120000), '2m', 'whole minutes')
eq(F.dur(3723000), '1h 2m', 'hours drop seconds')
eq(F.dur(3600000), '1h', 'whole hour')
eq(F.dur(-5), '0ms', 'never negative')
eq(F.durSec(4.3), '4.3s', 'from seconds')

// --- sizes, bytes, counts
eq(F.size(1440, 900), '1440 x 900', 'size stays as it is (S4)')
eq(F.size(1440.4, 899.6), '1440 x 900', 'whole pixels')
eq(F.size(null, 900), '', 'missing side')
eq(F.bytes(840e3), '840KB', 'KB')
eq(F.bytes(12), '1KB', 'never 0KB')
eq(F.bytes(12.34e6), '12.3MB', 'MB one decimal')
eq(F.bytes(12e6), '12MB', 'MB drops .0')
eq(F.bytes(340e6), '340MB', 'large MB whole')
eq(F.bytes(1.25e9), '1.3GB', 'GB')
eq(F.count(0, 5000), '0 / 5000', 'character count (J11)')
eq(F.count(42), '42', 'plain count')

// --- copy
eq(F.ell('New folder...'), 'New folder…', 'real ellipsis (S7)')
eq(F.ell('Checking version...'), 'Checking version…', 'ellipsis')
eq(F.ell('.../a/b'), '…/a/b', 'leading')
eq(F.ell('Type something…'), 'Type something…', 'already right')
eq(F.ell(null), '', 'nothing')
eq(F.ELL, '…', 'the glyph')
eq(F.sentence('baked in, plays anywhere'), 'Baked in, plays anywhere', 'sub label (S5)')
eq(F.sentence('removes hiss and hum'), 'Removes hiss and hum', 'sub label')
eq(F.sentence('Show the camera bubble by default'), 'Show the camera bubble by default', 'already a sentence')
eq(F.sentence('iPhone frame'), 'iPhone frame', 'a name with an inner capital is left alone')
eq(F.sentence('macOS only'), 'macOS only', 'macOS')
eq(F.sentence('SF Pro as default'), 'SF Pro as default', 'inner case kept')
eq(F.sentence('"quoted" start'), '"Quoted" start', 'past an opening quote')
eq(F.sentence('écrit'), 'Écrit', 'non-ASCII letter')
eq(F.sentence('4k export'), '4k export', 'a digit first is left alone')
eq(F.sentence(''), '', 'empty')
eq(F.join('You', '1:13 PM'), 'You · 1:13 PM', 'meta separator (J12)')
eq(F.join(['8s', '', null, 'MP4', false, 'High']), '8s · MP4 · High', 'empties drop out')
eq(F.SEP, ' · ', 'separator')

// --- no em dash and no times sign anywhere in the module's output or source
const src = fs.readFileSync(path.join(__dirname, '../ui/fmt.js'), 'utf8')
ok(!src.includes(String.fromCharCode(0x2014)), 'no em dash in ui/fmt.js')
ok(!/×/.test(src), 'no times sign in ui/fmt.js')

// --- loads as a plain <script> in the renderer: window.Fmt, no module
{
  const win = {}
  vm.runInNewContext(src, { window: win })
  ok(win.Fmt && win.Fmt.mult(2) === '2.0x', 'loads as a script tag onto window.Fmt')
  const sb = { window: {}, module: { exports: {} } }
  vm.runInNewContext(src, sb)
  ok(sb.module.exports.pct(0.5) === '50%' && sb.window.Fmt === sb.module.exports, 'both at once when both exist')
  ok(typeof globalThis.Fmt === 'undefined', 'no global under node')
}

// --- pure: same in, same out, nothing held
ok(F.mult(1.7) === F.mult(1.7) && Object.isFrozen(F) === false, 'pure')

console.log(failed ? `fmt: ${failed} failed, ${passed} passed` : `fmt: ${passed} passed`)
process.exit(failed ? 1 : 0)
