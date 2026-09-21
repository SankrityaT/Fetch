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
  is('seven presets, no more', S.list().length, 7)
  is('and five of them are the previews', S.list().filter(p => p.kind === 'video').map(p => p.id),
    ['app-preview-6.9', 'app-preview-6.9-landscape', 'app-preview-13', 'app-preview-13-landscape', 'app-preview-mac'])
}
{
  // Every preview rectangle, off Apple's app preview specifications page read on
  // 2026-09-21. The page gives exactly one accepted resolution per orientation per
  // class, so each of these is a pair of integers and not a shape and a scale.
  const pair = id => [S.get(id).w, S.get(id).h]
  is('the 6.9 inch preview is 886 x 1920 portrait', pair('app-preview-6.9'), [886, 1920])
  is('and 1920 x 886 the other way up', pair('app-preview-6.9-landscape'), [1920, 886])
  is('the 13 inch iPad preview is 1200 x 1600', pair('app-preview-13'), [1200, 1600])
  is('and 1600 x 1200 the other way up', pair('app-preview-13-landscape'), [1600, 1200])
  is('the Mac preview is 1920 x 1080', pair('app-preview-mac'), [1920, 1080])
  is('and the Mac has no portrait size at all, which is the page\'s own note', S.get('app-preview-mac').sibling, null)
  for (const id of ['app-preview-6.9', 'app-preview-13']) {
    const p = S.get(id), q = S.get(p.sibling)
    is(`${id} and its sibling are the same rectangle turned over`, [q.w, q.h], [p.h, p.w])
    is('and each points back at the other', q.sibling, p.id)
  }
  // The preview is not a shrunk screenshot. 1200 x 1600 is 3:4, exactly the tablet's own
  // shape, and 886 x 1920 is a quarter of a percent wider than 1320 x 2868.
  const pad = S.get('app-preview-13')
  is('the tablet preview is its screen\'s shape exactly', pad.w / pad.h, 2064 / 2752)
  ok('and the phone preview is not, by 0.26 percent', Math.abs((886 / 1920) / (1320 / 2868) - 1) > 0.002 &&
    Math.abs((886 / 1920) / (1320 / 2868) - 1) < 0.003)
}
{
  // The rules that are not the rectangle, each off the same page, in one place because a
  // second copy of 30 seconds would go stale without anybody noticing.
  const V = S.VIDEO
  is('a preview is 15 to 30 seconds', [V.seconds.min, V.seconds.max], [15, 30])
  is('500 MB, read as the stricter of the two readings', V.bytes, 500000000)
  is('30 frames a second is a cap, not a requirement', V.fps.max, 30)
  is('two codecs and no others', V.codecs, ['h264', 'prores422hq'])
  is('H.264 goes in three containers', V.containers.h264, ['mov', 'm4v', 'mp4'])
  is('and ProRes in one', V.containers.prores422hq, ['mov'])
  is('the poster frame is five seconds in unless somebody moves it', V.poster, 5)
  for (const p of S.list().filter(p => p.kind === 'video')) {
    is(`${p.id} is judged by the same length window`, S.get(p.id).seconds, V.seconds)
    is(`${p.id} is judged by the same weight`, S.get(p.id).bytes, V.bytes)
  }
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
  // The correction. An earlier round had it as "accepted in the 6.9 class and refused
  // anyway"; the page has it as the 5.5 and 4 inch classes' size, and those classes are
  // shown a scaled copy of the 6.9 preview when nothing is uploaded for them.
  ok('and the refusal says the 6.9 class does not accept it', /is not a size the 6\.9 inch class accepts/.test(r.reason))
  ok('it names the classes it really belongs to', /5\.5 and 4 inch/.test(r.reason))
  ok('and still says why it would be a bar', /9:16/.test(r.reason) && /19\.5:9/.test(r.reason))
  ok('and names the preset to use instead', /886 x 1920/.test(r.reason))
  is('asking for it by a preset-ish name is the same refusal', S.resolve('app-preview-1080').ok, false)
  is('and it is not in the table', S.get('1080x1920'), null)
}
{
  // Three more sizes that are real and are still not offered, each refused in its own
  // words. A silent "no such preset" sends somebody hunting for a typo in a true number.
  const w = S.resolve('app-preview-watch')
  is('a watch preview is refused', w.ok, false)
  ok('because the store has no such thing at all', /no app preview for a watch/.test(w.reason))
  is('by either spelling', S.resolve('preview-watch').ok, false)
  const v = S.resolve('3840x2160')
  is('the headset preview is refused', v.ok, false)
  ok('because nothing here captures 3840 x 2160 of one honestly', /not 3840 x 2160 of real pixels/.test(v.reason))
  const r = S.resolve('1920x1080')
  is('and the bare numbers of a Mac preview are refused too', r.ok, false)
  ok('because a resolution and a store size are different requests', /resolution, not a store size/.test(r.reason))
  ok('and it says which is which', /app-preview-mac/.test(r.reason) && /resolution instead/.test(r.reason))
  is('the preview itself resolves by name', S.resolve('app-preview-mac').preset.id, 'app-preview-mac')
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
{
  // What checkClip gained, since a file is measured and not asked politely.
  const fast = S.checkClip({ seconds: 20, fps: 60 }, 'app-preview-6.9')
  is('a 60 frame file is refused', fast.ok, false)
  ok('and the cap is named', /60 frames a second/.test(fast.reason) && /cap is 30/.test(fast.reason))
  is('30 is in', S.checkClip({ seconds: 20, fps: 30 }, 'app-preview-6.9').ok, true)
  is('and so is 29.97, which is the same frame rate written honestly', S.checkClip({ seconds: 20, fps: 29.97 }, 'app-preview-6.9').ok, true)
  const box = S.checkClip({ seconds: 20, codec: 'prores', container: 'mp4' }, 'app-preview-6.9')
  is('ProRes in an mp4 is refused', box.ok, false)
  ok('and the container it belongs in is named', /\.mov/.test(box.reason))
  is('ProRes in a mov is fine', S.checkClip({ seconds: 20, codec: 'ProRes 422 (HQ)', container: '.mov' }, 'app-preview-6.9').ok, true)
  const off = S.checkClip({ seconds: 20, w: 888, h: 1920 }, 'app-preview-6.9')
  is('a file two pixels wide of the size is refused', off.ok, false)
  ok('which is the whole reason this module exists', /888 x 1920/.test(off.reason) && /886 x 1920 exactly/.test(off.reason))
}

console.log('a name for a codec is not the codec')
{
  is('a person writes H.264', S.codecOf('H.264'), 'h264')
  is('an encoder is asked for libx264', S.codecOf('libx264'), 'h264')
  is('ffprobe says prores', S.codecOf('prores'), 'prores422hq')
  is('and tags it apch for 422 HQ', S.codecOf('apch'), 'prores422hq')
  is('Apple writes it out in full', S.codecOf('ProRes 422 (HQ)'), 'prores422hq')
  is('and something else is itself, so it can be refused by name', S.codecOf('vp9'), 'vp9')
  is('a container comes with or without its dot', S.containerOf('.MOV'), 'mov')
  is('and quicktime is a mov', S.containerOf('QuickTime'), 'mov')
}

console.log('the frame rate cap is arithmetic, not a slogan')
{
  // "Progressive, up to High Profile Level 4.0" and "Max frame rate 30" are two lines on
  // the same page, and they are the same line: Level 4.0 allows 245,760 macroblocks a
  // second, and 1920 x 1080 at 30 is 244,800 of them.
  for (const p of S.list().filter(p => p.kind === 'video')) {
    ok(`${p.id} clears High Profile Level 4.0 at 30`, S.level4(p, 30).ok)
  }
  const mac = S.level4({ w: 1920, h: 1080 }, 30)
  is('the Mac preview is 8,160 macroblocks a frame', mac.blocks, 8160)
  is('and 244,800 a second, 960 under the level', mac.rate, 244800)
  is('one frame a second more and it is outside it', S.level4({ w: 1920, h: 1080 }, 31).ok, false)
}
{
  // Fetch records at 60 (ui/app.js), so this runs on nearly every take there is.
  const f = S.fpsPlan(60)
  is('60 halves onto the cap exactly', [f.out, f.every], [30, 2])
  is('so does 50, to 25', [S.fpsPlan(50).out, S.fpsPlan(50).every], [25, 2])
  is('24 is under the cap and is left alone', [S.fpsPlan(24).out, S.fpsPlan(24).every], [24, 1])
  is('29.97 is not rounded up into a refusal', S.fpsPlan(29.97).every, 1)
  is('120 takes one frame in four', S.fpsPlan(120).every, 4)
  is('and an unknown rate says so rather than guessing', S.fpsPlan(null).unknown, true)
  is('capping at 30 while it waits to be told', S.fpsPlan(null).out, 30)
  // Nothing is ever between two of the take's own frames: every out rate is the take's
  // divided by a whole number.
  let bad = 0
  for (let n = 1; n <= 240; n++) {
    const p = S.fpsPlan(n)
    if (p.every && Math.abs(p.take / p.every - p.out) > 0.0005) bad++
    if (p.out > 30.005) bad++
  }
  is('and no frame rate in 240 needed a frame that was not recorded', bad, 0)
}

console.log('what a take can honestly become')
{
  // The take this whole round is about: a 6.9 inch device, shot at its own pixels.
  const take = { w: 1320, h: 2868, seconds: 22, fps: 60, family: 'iphone', hasAudio: true }
  const r = S.preview(take, 'app-preview-6.9')
  ok('it is a preview and everything needed to write it is here', r.ok && r.ready)
  is('exactly 886 x 1920', [r.size.w, r.size.h], [886, 1920])
  is('drawn at 883 x 1920, three pixels of picture around it', [r.box.w, r.box.h, r.leftover.w], [883, 1920, 3])
  is('at 30 frames a second, one in two of the take\'s 60', [r.fps.out, r.fps.every], [30, 2])
  is('22 seconds of it, whole', [r.seconds.out, r.trim], [22, null])
  is('as H.264 in an mp4', [r.codec, r.container], ['h264', 'mp4'])
  ok('about 33 MB against a 500 MB limit', r.bytes.estimate > 30e6 && r.bytes.estimate < 36e6)
  is('and the poster frame lands five seconds in', r.poster, 5)
  ok('the steps say what to do and in what order', r.steps.length >= 3 &&
    /fill the 3 pixels across/.test(r.steps[0]) && /one frame in 2/.test(r.steps[1]))
  ok('and none of them invents a frame', /none of them invented/.test(r.steps[1]))
}
{
  // A take of this Mac's own screen, which is the preview Fetch can make with no
  // simulator anywhere near it. 3024 x 1964 is this display, read off it.
  const mac = { w: 3024, h: 1964, seconds: 44, fps: 60, family: 'mac', hasAudio: true }
  const r = S.preview(mac, 'app-preview-mac')
  ok('a Mac take is an app preview', r.ok)
  ok('but not a finished one, because 44 seconds is not 30', !r.ready)
  is('a 30 second window has to be picked, and this does not pick it', r.trim.from, null)
  is('no later than 14 seconds in', r.trim.latestStart, 14)
  ok('and it says where that choice is made', /list_beats/.test(r.needs[0]) && /fit_to_length/.test(r.needs[0]))
  const w = S.preview(mac, 'app-preview-mac', { from: 8 })
  ok('told where, it is ready', w.ok && w.ready)
  is('trimmed 8 to 38 seconds', [w.trim.from, w.trim.length], [8, 30])
  is('the display is 1.54:1 and the preview is 16:9, so 258 pixels are drawn', w.leftover.w, 258)
  ok('or trimmed to fill it, losing 13 percent of the height', w.bleed.crop.h === 1701 && w.bleed.lost.h > 0.13)
  const late = S.preview(mac, 'app-preview-mac', { from: 20 })
  is('a window that runs off the end is refused', late.ok, false)
  ok('with the last start that would have worked', /between 0 and 14s/.test(late.fix[0]))
}
{
  const take = { w: 1320, h: 2868, fps: 60, family: 'iphone' }
  const short = S.preview({ ...take, seconds: 9 }, 'app-preview-6.9')
  is('nine seconds is not a preview', short.ok, false)
  ok('and it says how much is missing', /runs 9s/.test(short.reason) && /6s of it does not exist yet/.test(short.reason))
  ok('the first route is to record more', /record 6s more/.test(short.fix[0]))
  ok('and the second changes the pace rather than inventing frames', /inventing frames/.test(short.fix[1]))
  const blind = S.preview({ ...take }, 'app-preview-6.9')
  is('a take with no length is refused rather than assumed', blind.ok, false)
  ok('because the length is the gate', /15 to 30 seconds/.test(blind.reason))
  const odd = S.preview({ ...take, seconds: 60 }, 'app-preview-6.9', { length: 45 })
  is('and a 45 second window is not a preview either', odd.ok, false)
}
{
  const take = { w: 1320, h: 2868, seconds: 20, fps: 60 }
  const turned = S.preview({ ...take, w: 2868, h: 1320 }, 'app-preview-6.9')
  is('a landscape take in the portrait size is refused', turned.ok, false)
  ok('because it is a bar down each side', /bar down each side/.test(turned.reason))
  ok('and the other way up is named', /app-preview-6\.9-landscape/.test(turned.fix[0]))
  ok('which it then fits', S.preview({ ...take, w: 2868, h: 1320 }, 'app-preview-6.9-landscape').ok)
  const macUp = S.preview({ w: 1964, h: 3024, seconds: 20, fps: 60 }, 'app-preview-mac')
  is('a portrait Mac take has nowhere to go', macUp.ok, false)
  ok('and is told the class has no portrait size', /no portrait preview size/.test(macUp.fix[0]))
}
{
  const phone = { w: 1320, h: 2868, seconds: 20, fps: 60, family: 'iphone' }
  const wrong = S.preview(phone, 'app-preview-13')
  is('a phone take in the tablet size is refused', wrong.ok, false)
  ok('because it is a claim about the app', /not true/.test(wrong.reason))
  ok('and the sizes it does belong in are named', /app-preview-6\.9/.test(wrong.fix[1]))
  // Without a family the shape is all there is, and the shape does fit. Said plainly
  // rather than guessed at: a third of that picture would be drawn room.
  const loose = S.preview({ w: 1320, h: 2868, seconds: 20, fps: 60 }, 'app-preview-13')
  ok('with no family said, it fits and is warned about', loose.ok && loose.warnings.length > 0)
  ok('that most of the picture would not be the take', /drawn room/.test(loose.warnings[0]))
}
{
  const take = { w: 1320, h: 2868, seconds: 30, fps: 60, family: 'iphone' }
  const pro = S.preview(take, 'app-preview-6.9', { codec: 'prores' })
  // The trap on the page: ~220 Mbps and a 500 MB cap are both stated, and thirty seconds
  // of ProRes is neither.
  is('a full length ProRes preview cannot be delivered', pro.ok, false)
  ok('and the weight is named against the limit', /MB at its own stated rate/.test(pro.reason) && /limit is 500 MB/.test(pro.reason))
  ok('with H.264 offered at a twentieth of it', /write it as H\.264/.test(pro.fix[0]))
  ok('and the longest ProRes that would fit', /longest ProRes 422 HQ fits/.test(pro.fix[1]))
  const sec = S.longestAt('prores422hq', { w: 1920, h: 1080 }, 30)
  ok('which for a Mac preview is about 18 seconds', sec > 18 && sec < 18.5)
  ok('a short ProRes preview is fine', S.preview({ ...take, seconds: 16 }, 'app-preview-6.9', { codec: 'prores' }).ok)
  const bad = S.preview(take, 'app-preview-6.9', { codec: 'vp9' })
  is('a codec the store does not take is refused', bad.ok, false)
  ok('and the two it does take are named', /H\.264 or ProRes 422 HQ/.test(bad.reason))
  const box = S.preview(take, 'app-preview-6.9', { codec: 'prores', container: 'mp4' })
  is('and ProRes outside a mov is refused', box.ok, false)
}
{
  // Everything a take can be, in one answer, largest first.
  const all = S.previews({ w: 1320, h: 2868, seconds: 20, fps: 60, family: 'iphone' })
  is('a phone take is one preview', all.can.map(p => p.preset), ['app-preview-6.9'])
  is('and the other four say why not', all.cannot.length, 4)
  ok('every one of them with a reason', all.cannot.every(c => c.reason && c.reason.length > 20))
  const mac = S.previews({ w: 3024, h: 1964, seconds: 20, fps: 60 })
  is('a landscape take with no family said is three, biggest first',
    mac.can.map(p => p.preset), ['app-preview-mac', 'app-preview-13-landscape', 'app-preview-6.9-landscape'])
  const asked = S.preview({ w: 3024, h: 1964, seconds: 20, fps: 60 })
  is('and asked without a target, that is the one it hands back', asked.preset, 'app-preview-mac')
  // No family said, and the shape still decides: a phone take is not handed the iPad's
  // size with two fifths of it blurred room, nor a phone on its side the Mac's.
  is('a portrait phone take with no family is the phone preview',
    S.preview({ w: 1320, h: 2868, seconds: 20, fps: 60 }).preset, 'app-preview-6.9')
  is('and a phone on its side is the phone\'s landscape one',
    S.preview({ w: 2868, h: 1320, seconds: 20, fps: 60 }).preset, 'app-preview-6.9-landscape')
  is('an iPhone take asked into the iPad size is refused by name',
    S.preview({ w: 1320, h: 2868, seconds: 20, fps: 60, family: 'iPhone' }, 'app-preview-13').ok, false)
  const none = S.preview({ w: 640, h: 1136, seconds: 20, fps: 60 })
  is('a take too small for any of them is refused', none.ok, false)
  ok('and carries every reason it was', none.cannot.length === 5)
}
{
  // The silence the judge found, said where somebody can still do something about it.
  const quiet = S.preview({ w: 1320, h: 2868, seconds: 20, fps: 60, hasAudio: false, family: 'iphone' }, 'app-preview-6.9')
  ok('a silent take is still a preview', quiet.ok)
  ok('and is told it is the weakest one', /weakest/.test(quiet.warnings.join(' ')))
  ok('and is not told a file with no track is accepted', !/is accepted/.test(quiet.warnings.join(' ')))
  ok('it gets a silent track of the listed shape instead', /silence of that same shape/.test(quiet.steps.join(' ')))
  ok('every preview writes one stereo AAC track at 256 kbps and 48 kHz',
    /one stereo AAC track at 256 kbps and 48 kHz/.test(S.preview({ w: 1320, h: 2868, seconds: 20, fps: 60 }, 'app-preview-6.9').steps.join(' ')))
  const mono = S.preview({ w: 1320, h: 2868, seconds: 20, fps: 60, family: 'iphone', audio: { channels: 1, rate: 32000 } }, 'app-preview-6.9')
  ok('one channel is a step, not a refusal', /stereo/.test(mono.steps.join(' ')))
  ok('and so is an off sample rate', /resample the sound to 48 kHz/.test(mono.steps.join(' ')))
  is('44.1 needs no step', S.preview({ w: 1320, h: 2868, seconds: 20, fps: 60, audio: { channels: 2, rate: 44100 } }, 'app-preview-6.9')
    .steps.filter(s => /resample/.test(s)).length, 0)
}
{
  // Fuzz, the same rule as the stills: nothing a plan says can be bigger than what was
  // recorded, longer than 30 seconds, faster than 30 frames or heavier than 500 MB.
  let bad = 0, planned = 0
  for (const id of S.list().filter(p => p.kind === 'video').map(p => p.id)) {
    for (let w = 400; w <= 3200; w += 91) {
      for (let h = 400; h <= 3200; h += 143) {
        for (const seconds of [14.9, 15, 21.5, 30, 77]) {
          for (const fps of [24, 30, 59.94, 60]) {
            const r = S.preview({ w, h, seconds, fps }, id, { from: seconds > 30 ? 1 : undefined })
            if (!r.ok) continue
            planned++
            if (r.box.w > w || r.box.h > h) bad++
            if (r.density < 1) bad++
            if (r.seconds.out < 15 || r.seconds.out > 30) bad++
            if (r.fps.out > 30.005) bad++
            if (r.bytes.estimate > r.bytes.limit) bad++
            if (!S.level4(r.size, r.fps.out).ok) bad++
            if (r.box.w + r.box.x > r.size.w || r.box.h + r.box.y > r.size.h) bad++
          }
        }
      }
    }
  }
  ok('thousands of previews were planned', planned > 1000)
  is('and not one of them upscaled, ran long, ran fast or ran heavy', bad, 0)
}

console.log('a stock Simulator window refused for its scale is not sent to a bigger phone')
{
  // The judged ProMax at its default window: 706 x 1534 of glass in a 794 x 1718 capture.
  const r = S.preview({ w: 794, h: 1718, seconds: 28, fps: 60 }, 'app-preview-6.9',
    { crop: { w: 706, h: 1534 }, device: { w: 1320, h: 2868 } })
  is('it is refused as an upscale', r.ok, false)
  ok('and nothing tells them to use a device whose screen is bigger', !r.fix.some(f => /device type whose own screen/.test(f)))
  ok('it says the device has the pixels and the window is drawn small', r.fix.some(f => /1320 x 2868, which is enough/.test(f)))
  ok('the layout route is still there, as a share', r.fix.some(f => /give the capture \d+% of the picture/.test(f)))
  // Drawn at that share, it is its own pixels and goes through.
  ok('and at that share the same take is a preview', S.preview({ w: 794, h: 1718, seconds: 28, fps: 60 }, 'app-preview-6.9',
    { crop: { w: 706, h: 1534 }, share: r.maxShare }).ok)
  const small = S.preview({ w: 794, h: 1718, seconds: 28, fps: 60 }, 'app-preview-6.9',
    { crop: { w: 706, h: 1534 }, device: { w: 750, h: 1334 } })
  ok('a device that really is too small is still told so', small.fix.some(f => /device type whose own screen/.test(f)))
}

console.log('the device names in a refusal are devices that can do it')
{
  // Read off this Mac's profiles: the 13 inch Airs are in the 13 inch class and their
  // own screens are 2048 x 2732, so a line saying "at least 2064 x 2752: iPad Air" sent
  // somebody to a device that cannot do it.
  const AIR13 = { w: 2048, h: 2732 }
  const f = S.fit(AIR13, 'app-store-13')
  is('a 13 inch Air cannot make the top size', f.ok, false)
  ok('and no line in the refusal names an Air', !/Air/.test(f.fix.join(' ')))
  ok('while the size it can make is offered', /2048 x 2732/.test(f.fix.join(' ')))
  is('best lands it there', [S.best(AIR13, 'app-store-13').size.w, S.best(AIR13, 'app-store-13').size.h], [2048, 2732])
  is('and only the two Pros are named as reaching 2064 x 2752', S.get('app-store-13').native,
    ['iPad Pro 13-inch (M4)', 'iPad Pro 13-inch (M5)'])
}
{
  // A device profile is written portrait and a landscape preset is the same device
  // turned over, so reach compares shorter edge to shorter edge.
  const devices = [{ name: 'ProMax', screen: { w: 1320, h: 2868 } }, { name: 'SE', screen: { w: 750, h: 1334 } }]
  is('a phone reaches the landscape preview', S.reach('app-preview-6.9-landscape', devices).able.map(d => d.name), ['ProMax'])
  is('and the same phone reaches the portrait one', S.reach('app-preview-6.9', devices).able.map(d => d.name), ['ProMax'])
  is('a 750 x 1334 phone reaches neither', S.reach('app-preview-6.9-landscape', devices).short.map(d => d.name), ['SE'])
}
{
  // A Mac take is refused in the Mac's own words. Telling somebody to open a Simulator
  // menu item about a recording of their own screen is a wrong instruction.
  const f = S.fit({ w: 1280, h: 800 }, 'app-preview-mac')
  is('a small window cannot be a Mac preview', f.ok, false)
  ok('and nothing tells them to open Simulator', !/Simulator/.test(f.fix.join(' ')))
  ok('it points at the display instead', /record the display/.test(f.fix[0]))
}

console.log('a preview is the whole edit, at the rate it promises')
{
  // The judged file: 24.0 s out of a 28 s edit, at 0.46 Mbps. Every store rule passed it.
  const judged = { seconds: 24, expect: 28, bps: 464528, codec: 'h264', fps: 30, w: 886, h: 1920 }
  const c = S.checkClip(judged, 'app-preview-6.9')
  is('the judged file is not called the store file', c.ok, false)
  ok('because it is not all of the edit', /runs 24s and the edit it was made from is 28s/.test(c.reason))
  ok('and because its rate is not the one promised', /0\.465 Mbps/.test(c.reason) && /10 to 12/.test(c.reason))
  const fixed = S.checkClip({ ...judged, seconds: 28, bps: 11020980 }, 'app-preview-6.9')
  is('the fixed file, as written and measured, is', fixed.ok, true)
  is('one frame of slack at 30, and no more', S.checkClip({ seconds: 27.967, expect: 28 }, 'app-preview-6.9').ok, true)
  is('two frames short is short', S.checkClip({ seconds: 27.93, expect: 28 }, 'app-preview-6.9').ok, false)
  is('a file with no edit to compare against is judged by the window alone', S.checkClip({ seconds: 24 }, 'app-preview-6.9').ok, true)
  is('ProRes is not held to the H.264 band', S.checkClip({ seconds: 20, codec: 'prores', container: 'mov', bps: 200e6 }, 'app-preview-6.9').ok, true)
  is('13 Mbps is over the band', S.checkClip({ seconds: 20, bps: 13e6 }, 'app-preview-6.9').ok, false)
  // what the encoder is told sits inside the band the checker holds the file to, so the
  // promise, the setting and the measurement are one number
  const H = S.VIDEO.h264
  ok('the encode target is inside Apple\'s 10 to 12', H.bps >= H.band.min && H.bps <= H.band.max)
  is('and the level is the page\'s', H.level, '4.0')
  const plan = S.preview({ w: 1320, h: 2868, seconds: 20, fps: 60, family: 'iphone' }, 'app-preview-6.9')
  ok('the plan says the number the encoder is given', /a constant 11 Mbps inside the page's 10 to 12/.test(plan.steps.join(' ')))
}

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
