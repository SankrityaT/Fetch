const p = require('../processor')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const r3 = n => Math.round(n * 1000) / 1000
const at = ms => ms.map(m => ({ t: r3(m.inEnd), x: r3(m.x), y: r3(m.y) }))

const display = { x: 0, y: 0, width: 1440, height: 900 }

{
  // two clicks in one place share a moment that holds until the second
  const m = p.zoomMoments({ kind: 'display', display, clicks: [[2000, 720, 450], [2500, 730, 455], [8000, 144, 90]] })
  is('clicks make moments', at(m), [{ t: 2, x: 0.5, y: 0.5 }, { t: 8, x: 0.1, y: 0.1 }])
  is('a run of clicks holds until the last one', r3(m[0].outStart), 4.1)
  is('the zoom arrives before the click', r3(m[0].inStart), 1.55)
}

{
  // a click somewhere else soon after is its own moment, and the first lets go in time
  const m = p.zoomMoments({ kind: 'display', display, clicks: [[2000, 144, 90], [3000, 1296, 810]] })
  is('a far click is a new moment', m.length, 2)
  is('moments never overlap', m[0].outEnd <= m[1].inStart, true)
}

{
  // no clicks: where the pointer moved and then rested
  const points = []
  for (let i = 0; i < 40; i++) points.push([i * 50, i < 16 ? i * 40 : 600, 300])
  const m = p.zoomMoments({ kind: 'display', display, points })
  is('dwell is the fallback', m.length > 0, true)
  is('dwell centres where it rested', at(m).map(x => [x.x, x.y]), [[r3(600 / 1440), r3(300 / 900)]])
}

{
  // a display take on the second screen maps against that screen, not the primary
  const d2 = { x: 1440, y: 0, width: 1920, height: 1080 }
  const m = p.zoomMoments({ kind: 'display', display: d2, clicks: [[1000, 2400, 540], [9000, 100, 100]] })
  is('recorded display, not the primary', at(m), [{ t: 1, x: 0.5, y: 0.5 }])
}

{
  // a window take maps against where the window was at that moment
  const data = {
    kind: 'window', display,
    windowBounds: [[0, 100, 100, 800, 600], [5000, 500, 100, 800, 600]],
    clicks: [[1000, 500, 400], [6000, 900, 400], [9000, 200, 400]],
  }
  is('window bounds at the time of each click', at(p.zoomMoments(data)),
    [{ t: 1, x: 0.5, y: 0.5 }, { t: 6, x: 0.5, y: 0.5 }])
  is('a window take without bounds is not guessed at', p.zoomMoments({ kind: 'window', display, clicks: [[1000, 500, 400]] }), [])
  // on another Space from 4s to 8s: a click there is over some other window
  const away = {
    kind: 'window', display,
    windowBounds: [[0, 100, 100, 800, 600], [4000, 100, 100, 800, 600, 0], [8000, 100, 100, 800, 600]],
    clicks: [[1000, 500, 400], [5000, 500, 400], [9000, 500, 400]],
  }
  is('clicks while the window is off screen are dropped', at(p.zoomMoments(away)).map(m => m.t), [1, 9])
}

{
  // legacy files have no kind: the primary display, as before
  is('old cursor files still map', at(p.zoomMoments({ display, clicks: [[1000, 720, 450]] })), [{ t: 1, x: 0.5, y: 0.5 }])
}

{
  // crop: the right half of the screen, so the frame's middle is at 0.75 of the screen
  const crop = { x: 0.5, y: 0, w: 0.5, h: 1 }
  const m = p.zoomMoments({ kind: 'display', display, clicks: [[1000, 1080, 450], [9000, 360, 450]] }, { crop })
  is('crop remaps into the cropped frame', at(m), [{ t: 1, x: 0.5, y: 0.5 }])
}

{
  // a 2s cut at 3..5: a click at 6s lands at 4s in the output, one inside the cut is gone
  const clock = p.outClock([[3, 5]], 0, 20)
  const m = p.zoomMoments({ kind: 'display', display, clicks: [[4000, 720, 450], [6000, 720, 450]] }, { clock })
  is('cuts move clicks onto the output clock', at(m), [{ t: 4, x: 0.5, y: 0.5 }])
  const trimmed = p.zoomMoments({ kind: 'display', display, clicks: [[1000, 720, 450], [3000, 720, 450]] },
    { clock: p.outClock([], 2, 20) })
  is('a trim drops what came before it', at(trimmed), [{ t: 1, x: 0.5, y: 0.5 }])
}

{
  const meta = { width: 2880, height: 1800, fps: 60 }
  const cursor = { kind: 'display', display, clicks: [[2000, 1296, 90]] }
  const f = p.autoZoomFilter(null, meta, { cursor, zoom: 2 }, p.outClock([], 0, 30), { w: 1540, h: 962 })
  is('auto-zoom finds the moment', f.moments, 1)
  // centred on the point and clamped at the edge, the formula explicit zooms use
  is('auto-zoom centres, not pans by fraction', /x='max\(0,min\(iw-iw\/zoom,iw\*\(/.test(f.filter), true)
  is('auto-zoom outputs at the size it is given', /:s=1540x962:fps=60$/.test(f.filter), true)
  is('the moment is placed at its point', /0\.9000/.test(f.filter) && /0\.1000/.test(f.filter), true)
  is('a trim start still works as a number', p.autoZoomFilter(null, meta, { cursor }, 1).moments, 1)
  is('nothing to zoom to is null', p.autoZoomFilter(null, meta, { cursor: { kind: 'display', display, clicks: [] } }, 0), null)
}

{
  // the framed video keeps the cropped frame's shape
  const g = p.backdropGeometry(2880, 1598, { inset: 0.06, outAspect: 16 / 9, outWidth: 1920 })
  is('framed size follows the cropped shape', Math.abs(g.vidW / g.vidH - 2880 / 1598) < 0.01, true)
  is('framed video fits the canvas', g.vidW <= g.outW && g.vidH <= g.outH, true)
}

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
