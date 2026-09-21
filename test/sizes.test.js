// The store's exact sizes and the honest fitting of a capture to one (ui/sizes.js).
const S = require('../ui/sizes')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const ok = (name, cond) => is(name, !!cond, true)

// The device profiles this table was checked against, in pixels, read from
// /Library/Developer/CoreSimulator/Profiles/DeviceTypes on this Mac.
const P16PM = { w: 1320, h: 2868 }   // iPhone 16 Pro Max, iPhone 17 Pro Max
const P15PM = { w: 1290, h: 2796 }   // iPhone 15 Pro Max, 16 Plus, 15 Plus, 14 Pro Max
const PAIR = { w: 1260, h: 2736 }    // iPhone Air
const P13PM = { w: 1284, h: 2778 }   // iPhone 12/13 Pro Max, iPhone 14 Plus
const P16 = { w: 1179, h: 2556 }     // iPhone 16, iPhone 15, iPhone 14 Pro
const IPAD13 = { w: 2064, h: 2752 }  // iPad Pro 13-inch (M4), (M5)
// What a window take of a simulator at its default geometry actually measured:
// 396 x 856 points at backing scale 2, against a native 1320 x 2868. sim-m0.md section 3.
const WINDOW = { w: 792, h: 1712 }

console.log('the table')
{
  const a = S.get('app-store-6.9')
  is('the 6.9 inch iPhone screenshot is exactly 1320 x 2868', [a.w, a.h], [1320, 2868])
  const b = S.get('app-store-13')
  is('the 13 inch iPad screenshot is exactly 2064 x 2752', [b.w, b.h], [2064, 2752])
  const c = S.get('app-preview-6.9')
  is('the 6.9 inch app preview is exactly 886 x 1920', [c.w, c.h], [886, 1920])
  is('and the 6.9 class also accepts two smaller stills', a.also, [{ w: 1290, h: 2796 }, { w: 1260, h: 2736 }])
  is('three presets, no more', S.list().length, 3)
  is('the preview is the only video', S.list().filter(p => p.kind === 'video').map(p => p.id), ['app-preview-6.9'])
}
{
  // yuv420p has no odd dimension, so an odd preset would be unencodable as well as wrong
  const odd = []
  for (const p of Object.values(S.PRESETS)) {
    for (const s of [{ w: p.w, h: p.h }].concat(p.also)) {
      if (s.w % 2 || s.h % 2) odd.push(`${p.id} ${s.w}x${s.h}`)
    }
  }
  is('every size in the table is even on both edges', odd, [])
}
{
  // Each accepted size is the native framebuffer of a device somebody can boot. Without
  // that, density 1.0 is unreachable and the whole table is aspirational.
  const native = S.fit(P16PM, 'app-store-6.9')
  ok('a 6.9 device capture reaches its own preset at density 1', native.ok && native.density === 1)
  const pad = S.fit(IPAD13, 'app-store-13')
  ok('and a 13 inch iPad capture reaches its own preset at density 1', pad.ok && pad.density === 1)
  const alt = S.fitSize(P15PM, { w: 1290, h: 2796 })
  ok('and so does the second accepted 6.9 size', alt.ok && alt.density === 1)
  const air = S.fitSize(PAIR, { w: 1260, h: 2736 })
  ok('and the third', air.ok && air.density === 1)
}

console.log('names, and the one name refused')
{
  is('a preset resolves by its id', S.resolve('app-store-6.9').preset.id, 'app-store-6.9')
  is('by its size', S.resolve('1320x2868').preset.id, 'app-store-6.9')
  is('by its class', S.resolve('6.9').preset.id, 'app-store-6.9')
  is('and past whitespace and case', S.resolve('  App-Store-6.9 ').preset.id, 'app-store-6.9')
}
{
  const r = S.resolve('1080x1920')
  is('1080 x 1920 is refused', r.ok, false)
  ok('and the refusal says why, in the shape of the phone', /9:16/.test(r.reason) && /19\.5:9/.test(r.reason))
  ok('and names the preset to use instead', /886 x 1920/.test(r.reason))
  is('asking for it by a preset-ish name is the same refusal', S.resolve('app-preview-1080').ok, false)
  is('and it is not in the table', S.get('1080x1920'), null)
}
{
  const r = S.resolve('app-store-6.5')
  is('an unknown preset is refused', r.ok, false)
  ok('and the refusal lists the ones that exist', /app-store-6\.9/.test(r.reason) && /app-preview-6\.9/.test(r.reason))
  is('fit refuses it the same way', S.fit(P16PM, 'app-store-6.5').ok, false)
}

console.log('a capture at the size the store wants')
{
  const f = S.fit(P16PM, 'app-store-6.9')
  is('the size that comes out is the preset, exactly', [f.size.w, f.size.h], [1320, 2868])
  is('the capture is drawn edge to edge', [f.box.x, f.box.y, f.box.w, f.box.h], [0, 0, 1320, 2868])
  is('nothing is left to fill', [f.leftover.w, f.leftover.h], [0, 0])
  ok('so there is no bar to draw', f.edgeToEdge)
  is('one capture pixel per output pixel', f.density, 1)
  ok('and nothing is resampled at all', f.pristine)
}
{
  // The store screenshot the surveys describe: a backdrop, a caption, the shot inset.
  const f = S.fit(P16PM, 'app-store-6.9', { share: 0.8 })
  is('the deliverable is still exactly the preset', [f.size.w, f.size.h], [1320, 2868])
  is('the shot is drawn at four fifths and centred', [f.box.x, f.box.y, f.box.w, f.box.h], [132, 287, 1056, 2294])
  is('a quarter more capture than output, which is headroom not loss', f.density, 1.25)
  ok('and the room around it is the layout\'s to fill', f.leftover.w === 264 && f.leftover.h === 574)
  ok('it is no longer a straight copy', !f.pristine)
}

console.log('a capture that cannot make it')
{
  // The common case, not the corner: a simulator window at its default geometry.
  const f = S.fit(WINDOW, 'app-store-6.9')
  is('a default simulator window is refused', f.ok, false)
  is('and the refusal names the upscale it would have been', f.upscale, 1.667)
  is('and how much of the picture it could honestly fill', f.maxShare, 0.6)
  is('and what it would have needed', [f.need.w, f.need.h], [1320, 2853])
  ok('which is the sentence, in pixels', /this capture is 792 x 1712/.test(f.reason) &&
    /would draw it at 1320 x 2853/.test(f.reason))
  ok('the first fix is the one that costs nothing', /Pixel Accurate/.test(f.fix[0]))
  ok('the second names device types that are big enough', /iPhone 17 Pro Max/.test(f.fix[1]))
  ok('and the last offers a smaller share of the picture', /60% of the picture/.test(f.fix[f.fix.length - 1]))
  ok('no size is reported as achieved', f.box === undefined)
}
{
  // A real device, one class down. This is the refusal that has a way out in it.
  const f = S.fit(P15PM, 'app-store-6.9')
  is('a 1290 x 2796 device cannot be a 1320 x 2868 still', f.ok, false)
  ok('and it is told the size in the same class that it can be', /1290 x 2796/.test(f.fix.join(' ')))
  const b = S.best(P15PM, 'app-store-6.9')
  ok('best finds it', b.ok)
  is('at exactly that size', [b.size.w, b.size.h], [1290, 2796])
  is('and at density 1', b.fit.density, 1)
}
{
  const b = S.best(P16PM, 'app-store-6.9')
  is('best takes the largest accepted size a capture can fill', [b.size.w, b.size.h], [1320, 2868])
}
{
  // 1284 x 2778 clears the smallest size the class accepts in both edges, so it is a
  // store still after all, with ten rows of drawn picture above and below it.
  const b = S.best(P13PM, 'app-store-6.9')
  ok('a capture between two accepted sizes lands on the lower one', b.ok)
  is('at 1260 x 2736', [b.size.w, b.size.h], [1260, 2736])
  is('filling the width and leaving a band to draw', [b.fit.box.w, b.fit.box.h], [1260, 2726])
  ok('and still never upscaled', b.fit.density >= 1)
}
{
  // 1179 x 2556 is under every size this class accepts.
  const b = S.best(P16, 'app-store-6.9')
  is('a capture under the whole class is refused', b.ok, false)
  is('and the nearest is named', [b.nearest.w, b.nearest.h], [1260, 2736])
  ok('with the upscale it would have taken', /1\.0[0-9]*x upscale/.test(b.reason))
  ok('and the smallest size the class accepts is named too', /1260 x 2736/.test(b.reason))
}
{
  const f = S.fit({ w: 0, h: 0 }, 'app-store-6.9')
  is('a capture with no pixels is refused rather than divided by', f.ok, false)
  is('a crop bigger than its capture is refused too', S.fit(P16PM, 'app-store-6.9', { crop: { w: 1400, h: 2868 } }).ok, false)
  is('and best refuses it the same way', S.best({ w: 0, h: 0 }, 'app-store-6.9').ok, false)
}

console.log('the window is not the screen')
{
  // Piece 1 hands over the device screen inside the simulator window. Only that rectangle
  // is the deliverable: the rest of the window is the Mac's, and Simulator's own bezel.
  const window = { w: 1400, h: 3000 }
  const screen = { x: 40, y: 66, w: 1320, h: 2868 }
  const f = S.fit(window, 'app-store-6.9', { crop: screen })
  ok('the crop is what is fitted, not the window', f.ok && f.density === 1)
  is('and it lands edge to edge', [f.box.w, f.box.h], [1320, 2868])
  is('the source reported is the crop', [f.source.w, f.source.h], [1320, 2868])
}

console.log('the app preview is not the screenshot\'s shape')
{
  // 886 / 1920 is 0.46146 and 1320 / 2868 is 0.46025, so even a native capture leaves a
  // sliver. It is three pixels, it is never black, and the export has to draw it.
  const f = S.fit(P16PM, 'app-preview-6.9')
  is('the preview comes out exactly 886 x 1920', [f.size.w, f.size.h], [886, 1920])
  is('the take fills the height and falls three pixels short across', [f.box.w, f.box.h], [883, 1920])
  is('so three pixels of the picture are drawn, not left black', [f.leftover.w, f.leftover.h], [3, 0])
  ok('and it is not edge to edge, which the golden has to know', !f.edgeToEdge)
  ok('filling it by trimming instead would cost seven rows of the capture', f.bleed.crop.h === 2861 && f.bleed.crop.w === 1320)
  ok('which is under half a percent of the height', f.bleed.lost.h < 0.005)
}
{
  // 792 is under 886, so the default window is short of the preview as well as the still.
  // Pixel Accurate is not a screenshot nicety, it gates the video too.
  const f = S.fit(WINDOW, 'app-preview-6.9')
  is('a default window take cannot make a preview either', f.ok, false)
  is('though it is only a tenth short, not two thirds', f.upscale, 1.119)
  ok('and no device type is named, because nearly every phone clears this one',
    !/iPhone/.test(f.fix.join(' ')) && /at least 886 x 1920/.test(f.fix[1]))
}

console.log('a phone in a picture shaped for a tablet')
{
  const f = S.fit(P16PM, 'app-store-13')
  ok('a portrait phone in the iPad deliverable still fits honestly', f.ok)
  is('it fills the height and leaves most of the width', [f.box.w, f.box.h], [1266, 2752])
  is('centred, with the room split', [f.box.x, f.box.y], [399, 0])
  ok('the room is over a third of the picture and every pixel of it is drawn', f.leftover.w === 798 && !f.edgeToEdge)
  is('there is no way to fill that by trimming without inventing pixels', f.bleed, null)
}

console.log('the rule the whole file exists for')
{
  // Fuzz: whatever is asked, a box is never bigger than the capture that feeds it.
  let bad = 0, fitted = 0
  for (const id of Object.keys(S.PRESETS)) {
    for (let w = 200; w <= 3000; w += 37) {
      for (let h = 200; h <= 3400; h += 101) {
        for (const share of [1, 0.9, 0.62, 0.25]) {
          const f = S.fit({ w, h }, id, { share })
          if (!f.ok) continue
          fitted++
          if (f.box.w > w || f.box.h > h) bad++
          if (f.density < 1) bad++
          if (f.box.w + f.box.x > f.size.w || f.box.h + f.box.y > f.size.h) bad++
          if (!Number.isInteger(f.box.w) || !Number.isInteger(f.box.h) ||
              !Number.isInteger(f.box.x) || !Number.isInteger(f.box.y)) bad++
        }
      }
    }
  }
  ok('thousands of fits were checked', fitted > 1000)
  is('and not one of them upscaled, escaped the picture, or came out fractional', bad, 0)
}
{
  // The floor is the honesty: rounding up by half a pixel is still inventing a pixel.
  const f = S.fit({ w: 1319, h: 2866 }, 'app-store-6.9')
  is('a capture one pixel short cannot be the preset', f.ok, false)
  const g = S.fit({ w: 1321, h: 2870 }, 'app-store-6.9')
  ok('a capture one pixel over can, by being shrunk', g.ok && g.box.w <= 1321 && g.box.h <= 2870)
  ok('and it fills the deliverable', g.box.w === 1320 || g.box.h === 2868)
}

console.log('which devices could do it')
{
  const devices = [
    { udid: 'A', name: 'Round-Shots-16PM', screen: { w: 1320, h: 2868, scale: 3 } },
    { udid: 'B', name: 'Yolk-ProMax', screen: { w: 1290, h: 2796, scale: 3 } },
    { udid: 'C', name: 'FairSplit-Loop', screen: { w: 1179, h: 2556, scale: 3 } },
    { udid: 'D', name: 'a watch with no screen reported' },
  ]
  const r = S.reach('app-store-6.9', devices)
  is('only the devices whose own screen is big enough', r.able.map(d => d.name), ['Round-Shots-16PM'])
  is('the rest are named as short', r.short.map(d => d.name), ['Yolk-ProMax', 'FairSplit-Loop'])
  is('and a device with no screen is not guessed at', r.able.concat(r.short).length, 3)
  is('the preview needs much less', S.reach('app-preview-6.9', devices).able.length, 3)
}

console.log('a preview is rejected for its length too')
{
  is('fifteen seconds is the floor and it is in', S.checkClip({ seconds: 15 }, 'app-preview-6.9').ok, true)
  is('thirty is the ceiling and it is in', S.checkClip({ seconds: 30 }, 'app-preview-6.9').ok, true)
  const short = S.checkClip({ seconds: 12.4 }, 'app-preview-6.9')
  is('twelve is not', short.ok, false)
  ok('and it says so in seconds', /12\.4s/.test(short.reason) && /at least 15s/.test(short.reason))
  const fat = S.checkClip({ seconds: 20, bytes: 620 * 1e6 }, 'app-preview-6.9')
  is('and a 620 MB file is refused for its weight', fat.ok, false)
  ok('by name', /620 MB/.test(fat.reason) && /500 MB/.test(fat.reason))
  is('a codec nobody accepts is refused', S.checkClip({ seconds: 20, codec: 'vp9' }, 'app-preview-6.9').ok, false)
  is('h264 is fine', S.checkClip({ seconds: 20, codec: 'H264' }, 'app-preview-6.9').ok, true)
  is('and a still has no length to ask about', S.checkClip({ seconds: 20 }, 'app-store-6.9').ok, false)
}

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
