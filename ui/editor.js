/* Fetch editor. Stage, timeline and inspector, all driven by processor.js. */

const ed = {
  src: null, meta: null, dur: 0,
  in: 0, out: 0, cur: 0,
  peaks: [], cues: [], texts: [], selText: null,
  capStyle: { font: 'Helvetica', scale: 1, colour: '#FFFFFF', position: 'bottom', boxed: true },
  crop: null, cropAR: 'free',
  cuts: [], cutMode: false,
  audioTrack: null,   // {file, name, volume, offset, replace, peaks}
  cam: null,          // camera take: {file, x, y, size, ...} when one was recorded
  tab: 'trim',
}

const EDITOR_HTML = `
<div class="ed">
  <div class="ed-main">
  <div class="ed-stage">
    <div class="ed-canvas" id="edCanvas">
      <div class="stage-frame" id="stageFrame" data-bd="none">
        <video id="edVideo" preload="auto"></video>
        <div class="cap-overlay" id="capOverlay"><span></span></div>
        <video class="cam-bubble" id="camBubble" muted playsinline hidden></video>
      </div>
      <div id="cropBox" hidden><i class="h nw"></i><i class="h ne"></i><i class="h sw"></i><i class="h se"></i></div>
    </div>
    <div class="ed-transport">
      <button class="pc" id="edBack" data-tip="Back 5s">${ico('skip-back', 'icon-sm')}</button>
      <button class="pc main" id="edPlay">${ico('play-fill', 'icon')}</button>
      <button class="pc" id="edFwd" data-tip="Forward 5s">${ico('skip-forward', 'icon-sm')}</button>
      <span class="time mono" id="edTime">0:00 / 0:00</span>
      <div style="flex:1"></div>
      <span class="chip chip-static" id="edOutLen">0.0s</span>
    </div>
  </div>

  <div class="ed-timeline">
    <div class="tl-bar">
      <span class="caps">Timeline</span>
      <span class="chip chip-static mono" id="tlRange">0:00</span>
      <div style="flex:1"></div>
      <button class="btn btn-sm" id="addAudio">${ico('plus', 'icon-sm')} Add audio</button>
      <button class="btn btn-sm btn-ghost" id="tlFit" data-tip="Reset zoom">${ico('arrows-out-simple', 'icon-sm')}</button>
    </div>
    <div class="tl-wrap" id="tlWrap">
      <div class="tl-lanes">
        <div class="tl-lane tl-lane-video" id="laneVideo">
          <span class="lane-tag">${ico('film-strip', 'icon-sm')} Video</span>
          <img id="strip" alt="">
        </div>
        <div class="tl-lane tl-lane-audio" id="laneAudio">
          <span class="lane-tag">${ico('waveform', 'icon-sm')} Recording audio</span>
          <canvas id="wave"></canvas>
        </div>
        <div class="tl-lane tl-lane-extra" id="laneExtra" hidden>
          <span class="lane-tag" id="extraTag">${ico('speaker-high', 'icon-sm')} Added audio</span>
          <canvas id="waveExtra"></canvas>
          <button class="lane-x" id="extraRemove" data-tip="Remove this track">${ico('x', 'icon-sm')}</button>
        </div>
      </div>
      <div class="tl-ticks" id="tlTicks"></div>
      <div class="tl-dim" id="dimL"></div>
      <div class="tl-dim" id="dimR"></div>
      <div class="tl-region" id="tlRegion"></div>
      <div class="tl-handle in" id="hIn"></div>
      <div class="tl-handle out" id="hOut"></div>
      <div id="playhead"></div>
    </div>
  </div>
  </div>

  <aside class="ed-inspector">
    <div class="insp-tabs" id="inspTabs">
      <button data-tab="trim"     aria-selected="true"  data-tip="Trim">${ico('scissors', 'icon-sm')}</button>
      <button data-tab="crop"     aria-selected="false" data-tip="Crop">${ico('crop', 'icon-sm')}</button>
      <button data-tab="text"     aria-selected="false" data-tip="Text">${ico('text-t', 'icon-sm')}</button>
      <button data-tab="captions" aria-selected="false" data-tip="Captions">${ico('closed-captioning', 'icon-sm')}</button>
      <button data-tab="look"     aria-selected="false" data-tip="Look">${ico('sparkle', 'icon-sm')}</button>
      <button data-tab="camera"   aria-selected="false" data-tip="Camera" id="camTabBtn" hidden>${ico('video-camera', 'icon-sm')}</button>
      <button data-tab="audio"    aria-selected="false" data-tip="Audio">${ico('waveform', 'icon-sm')}</button>
    </div>

    <div class="insp-body">
      <!-- TRIM -->
      <section class="insp-panel" data-panel="trim">
        <div><div class="insp-sec">Range</div>
          <div class="row"><span class="row-lbl">Start</span><span class="mono dim" id="trimIn">0:00</span>
            <div style="flex:1"></div><button class="btn btn-sm" id="setIn">Set to playhead</button></div>
          <div class="row"><span class="row-lbl">End</span><span class="mono dim" id="trimOut">0:00</span>
            <div style="flex:1"></div><button class="btn btn-sm" id="setOut">Set to playhead</button></div>
          <button class="btn btn-sm btn-ghost" id="trimReset" style="margin-top:8px">Reset to full clip</button>
        </div>
        <div><div class="insp-sec">Tool</div>
          <div class="seg" id="toolSwitch" style="width:100%">
            <button data-tool="select" aria-selected="true" style="flex:1">
              ${ico('cursor', 'icon-sm')} Select</button>
            <button data-tool="cut" aria-selected="false" style="flex:1">
              ${ico('scissors', 'icon-sm')} Cut</button>
          </div>
          <p class="micro dimmer" id="cutHint" style="margin-top:6px">
            Turn it on, then drag across the timeline to remove a section.</p>
          <div id="cutList" style="display:flex;flex-direction:column;gap:5px;margin-top:8px"></div>
        </div>

        <div><div class="insp-sec">Clean up</div>
          <button class="btn btn-sm" id="doSilence" style="width:100%">
            ${ico('magic-wand', 'icon-sm')} Remove dead air</button>
          <p class="micro dimmer" style="margin-top:6px">Finds silent gaps and removes them for you.</p>
        </div>
      </section>

      <!-- CROP -->
      <section class="insp-panel" data-panel="crop" hidden>
        <div><div class="insp-sec">Aspect</div>
          <div class="aspect-chips" id="arChips">
            <button class="chip" data-ar="free" aria-pressed="true">Free</button>
            <button class="chip" data-ar="16:9">16:9</button>
            <button class="chip" data-ar="9:16">9:16</button>
            <button class="chip" data-ar="1:1">1:1</button>
            <button class="chip" data-ar="4:3">4:3</button>
          </div>
        </div>
        <div><div class="insp-sec">Frame</div>
          <button class="btn btn-sm" id="cropOn" style="width:100%">${ico('crop', 'icon-sm')} Enable crop</button>
          <button class="btn btn-sm btn-ghost" id="cropReset" style="width:100%;margin-top:6px">Reset</button>
        </div>
      </section>

      <!-- TEXT -->
      <section class="insp-panel" data-panel="text" hidden>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="insp-sec" style="flex:1;margin:0">Layers</div>
          <button class="btn btn-sm" id="addText">${ico('plus', 'icon-sm')} Add</button>
        </div>
        <div id="layerList" style="display:flex;flex-direction:column;gap:6px"></div>
        <div id="textProps" hidden>
          <div class="insp-sec">Selected</div>
          <textarea class="input" id="txtValue" rows="2" placeholder="Type something…"></textarea>
          <div class="row" style="margin-top:8px"><span class="row-lbl">Size</span>
            <input type="range" class="slider" id="txtSize" min="2" max="16" value="6">
            <span class="row-val mono" id="txtSizeVal">6</span></div>
          <div class="row"><span class="row-lbl">Font</span>
            <div class="dd" id="txtFont"></div></div>
          <div class="row"><span class="row-lbl">Align</span>
            <div class="seg seg-sm" id="txtAlign">
              <button data-align="left" aria-selected="false">${ico('text-t', 'icon-sm')}</button>
              <button data-align="center" aria-selected="true">${ico('text-t', 'icon-sm')}</button>
              <button data-align="right" aria-selected="false">${ico('text-t', 'icon-sm')}</button>
            </div></div>
          <div class="row"><span class="row-lbl">Colour</span>
            <div class="swatches" id="txtSwatches"></div>
            <label class="colour-well" data-tip="Any colour">
              <input type="color" id="txtColor" value="#FFFFFF"><span></span>
            </label></div>
          <label class="opt" style="padding:8px 0"><span class="opt-txt"><span class="opt-title">Background pill</span></span>
            <span class="switch"><input type="checkbox" id="txtBox"><span class="track"></span></span></label>
          <div class="row"><span class="row-lbl">Timing</span>
            <button class="btn btn-sm" id="txtFrom">From playhead</button>
            <button class="btn btn-sm" id="txtTo">To playhead</button></div>
          <p class="micro dimmer" id="txtRange">Shows for the whole clip</p>
          <button class="btn btn-sm btn-danger" id="txtDel" style="width:100%;margin-top:8px">Delete layer</button>
        </div>
      </section>

      <!-- CAPTIONS -->
      <section class="insp-panel" data-panel="captions" hidden>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="insp-sec" style="flex:1;margin:0">Transcript</div>
          <button class="btn btn-sm" id="doTranscribe">${ico('sparkle', 'icon-sm')} Transcribe</button>
        </div>
        <div class="work" id="trProg" hidden>
          ${motion('thinking', 'thinking', 'work-dog')}
          <div style="flex:1">
            <div class="work-label">Listening to your recording</div>
            <div class="bar indeterminate"><i></i></div>
          </div>
        </div>
        <label class="opt" style="padding:8px 0"><span class="opt-txt">
          <span class="opt-title">Burn into video</span><span class="opt-sub">baked in, plays anywhere</span></span>
          <span class="switch"><input type="checkbox" id="burnCaps"><span class="track"></span></span></label>

        <div id="capStyle">
          <div class="insp-sec" style="margin-top:6px">Caption style</div>
          <div class="row"><span class="row-lbl">Font</span><div class="dd" id="capFont"></div></div>
          <div class="row"><span class="row-lbl">Size</span>
            <input type="range" class="slider" id="capSize" min="60" max="180" value="100">
            <span class="row-val mono" id="capSizeVal">1.0×</span></div>
          <div class="row"><span class="row-lbl">Colour</span>
            <div class="swatches" id="capSwatches"></div>
            <label class="colour-well" data-tip="Any colour">
              <input type="color" id="capColour" value="#FFFFFF"><span></span></label></div>
          <div class="row"><span class="row-lbl">Place</span>
            <div class="seg seg-sm" id="capPos">
              <button data-pos="bottom" aria-selected="true">Bottom</button>
              <button data-pos="middle" aria-selected="false">Middle</button>
              <button data-pos="top" aria-selected="false">Top</button>
            </div></div>
          <label class="opt" style="padding:7px 0"><span class="opt-txt">
            <span class="opt-title">Pill background</span>
            <span class="opt-sub">off gives an outline instead</span></span>
            <span class="switch"><input type="checkbox" id="capBoxed" checked><span class="track"></span></span></label>
        </div>

        <div class="cue-list" id="cueList"></div>
      </section>

      <!-- LOOK -->
      <section class="insp-panel" data-panel="look" hidden>
        <div class="insp-sec">Auto zoom</div>
        <label class="opt" style="padding:8px 0"><span class="opt-txt">
          <span class="opt-title">Follow my clicks</span>
          <span class="opt-sub">pushes in where you clicked</span></span>
          <span class="switch"><input type="checkbox" id="autoZoom"><span class="track"></span></span></label>
        <div class="row"><span class="row-lbl">Amount</span>
          <input type="range" class="slider" id="zoomAmt" min="120" max="240" value="170">
          <span class="row-val mono" id="zoomAmtVal">1.7×</span></div>
        <p class="micro dimmer" id="zoomNote">Needs a recording made by Fetch.</p>

        <div class="insp-sec" style="margin-top:10px">Backdrop</div>
        <div class="bd-grid" id="bdGrid"></div>
        <div><div class="insp-sec" style="margin-top:8px">Output shape</div>
          <div class="aspect-chips" id="outAspect">
            <button class="chip" data-ar="" aria-pressed="true">Auto</button>
            <button class="chip" data-ar="1.7778">16:9</button>
            <button class="chip" data-ar="1">1:1</button>
            <button class="chip" data-ar="0.5625">9:16</button>
            <button class="chip" data-ar="1.3333">4:3</button>
          </div>
          <p class="micro dimmer" style="margin-top:6px" id="aspectNote">
            Auto keeps your recording's shape with an even margin all round.</p>
        </div>
        <div class="row"><span class="row-lbl">Inset</span>
          <input type="range" class="slider" id="bdInset" min="2" max="20" value="8">
          <span class="row-val mono" id="bdInsetVal">8%</span></div>
        <div class="row"><span class="row-lbl">Corners</span>
          <input type="range" class="slider" id="bdRadius" min="0" max="60" value="26">
          <span class="row-val mono" id="bdRadiusVal">26</span></div>
      </section>

      <!-- AUDIO -->
      <section class="insp-panel" data-panel="camera" hidden>
        <div class="insp-sec">Camera bubble</div>
        <p class="dim" style="font-size:var(--t-12);margin:0 0 10px">
          Drag the bubble on the video to move it. It was recorded separately, so it stays sharp wherever you put it.</p>
        <div class="row"><span class="row-lbl">Size</span>
          <input type="range" class="slider" id="camSize" min="10" max="45" value="22">
          <span class="row-val mono" id="camSizeVal">22%</span></div>
        <div class="row"><span class="row-lbl">Corner</span>
          <div class="cam-corners" id="camCorner">
            <button data-c="tl" data-tip="Top left"><i></i></button>
            <button data-c="tr" data-tip="Top right"><i></i></button>
            <button data-c="bl" data-tip="Bottom left"><i></i></button>
            <button data-c="br" data-tip="Bottom right"><i></i></button>
          </div></div>
        <label class="opt"><span class="opt-text">
          <span class="opt-title">Show camera</span><span class="opt-sub">off leaves just the screen</span></span>
          <span class="switch"><input type="checkbox" id="camOn" checked><span class="track"></span></span></label>
      </section>

      <section class="insp-panel" data-panel="audio" hidden>
        <div class="insp-sec">Sound</div>
        <label class="opt" style="padding:8px 0"><span class="opt-txt">
          <span class="opt-title">Denoise</span><span class="opt-sub">removes hiss and hum</span></span>
          <span class="switch"><input type="checkbox" id="denoise"><span class="track"></span></span></label>
        <label class="opt" style="padding:8px 0"><span class="opt-txt">
          <span class="opt-title">Normalise loudness</span><span class="opt-sub">even levels throughout</span></span>
          <span class="switch"><input type="checkbox" id="loudnorm" checked><span class="track"></span></span></label>
        <div class="row"><span class="row-lbl">Gain</span>
          <input type="range" class="slider" id="gain" min="-10" max="10" value="0">
          <span class="row-val mono" id="gainVal">0dB</span></div>
        <div id="extraPanel" hidden>
          <div class="insp-sec" style="margin-top:10px">Added track</div>
          <div class="extra-file"><span class="mono" id="extraName">none</span></div>
          <div class="row"><span class="row-lbl">Level</span>
            <input type="range" class="slider" id="extraVol" min="0" max="150" value="60">
            <span class="row-val mono" id="extraVolVal">60%</span></div>
          <div class="row"><span class="row-lbl">Start at</span>
            <input type="range" class="slider" id="extraOff" min="0" max="200" value="0">
            <span class="row-val mono" id="extraOffVal">0.0s</span></div>
          <label class="opt" style="padding:7px 0"><span class="opt-txt">
            <span class="opt-title">Replace original audio</span>
            <span class="opt-sub">off mixes the two together</span></span>
            <span class="switch"><input type="checkbox" id="extraReplace"><span class="track"></span></span></label>
          <button class="btn btn-sm" id="transcribeExtra" style="width:100%;margin-top:6px">
            ${ico('sparkle', 'icon-sm')} Transcribe this track instead</button>
        </div>

        <div class="insp-sec" style="margin-top:8px">Fades</div>
        <div class="row"><span class="row-lbl">In</span>
          <input type="range" class="slider" id="fadeIn" min="0" max="30" value="0">
          <span class="row-val mono" id="fadeInVal">0.0s</span></div>
        <div class="row"><span class="row-lbl">Out</span>
          <input type="range" class="slider" id="fadeOut" min="0" max="30" value="0">
          <span class="row-val mono" id="fadeOutVal">0.0s</span></div>
      </section>
    </div>

    <div class="insp-foot">
      <div class="work" id="expBar" hidden>
        ${motion('exporting', 'running', 'work-dog')}
        <div style="flex:1">
          <div class="work-label">Fetching your video</div>
          <div class="bar"><i></i></div>
        </div>
      </div>
      <button class="btn btn-primary" id="doExport" style="width:100%">
        ${ico('export', 'icon-sm')} Export</button>
    </div>
  </aside>

</div>`

// ── open ────────────────────────────────────────────────────────────────
async function openInEditor(src) {
  document.querySelector('#nav [data-view="editor"]').disabled = false
  show('editor')
  const mount = $('editorMount')
  mount.className = ''
  mount.innerHTML = EDITOR_HTML

  ed.src = src; ed.texts = []; ed.cues = []; ed.crop = null; ed.selText = null; ed.peaks = []
  wireEditor()

  const v = $('edVideo')
  v.src = 'file://' + src
  ed.meta = await ipcRenderer.invoke('probe', src)

  // MediaRecorder webm has no duration header, so seek past the end to force one
  const ready = () => new Promise(res => {
    let settled = false
    const done = () => { if (settled) return; settled = true; v.ontimeupdate = null; res() }
    const onMeta = () => {
      if (isFinite(v.duration) && v.duration > 0) return done()
      v.currentTime = 1e7                       // webm has no duration until we seek past the end
      v.ontimeupdate = () => { if (isFinite(v.duration) && v.duration > 0) { v.currentTime = 0; done() } }
    }
    v.addEventListener('loadedmetadata', onMeta)
    if (v.readyState >= 1) onMeta()             // it may have loaded before we attached
    setTimeout(done, 6000)                      // never hang the editor on a bad file
  })
  await ready()

  ed.dur = ed.meta.duration || v.duration || 0
  ed.in = 0; ed.out = ed.dur; ed.cur = 0
  paintTrim(); drawWave(); layoutTimeline(); paintTime(); paintPlayhead(); paintBackdrop()

  loadCamTake(src)
  ed.cues = await ipcRenderer.invoke('read-cues', src)
  // If a clip has a transcript, the person wants the captions in the file. Leaving
  // this off by default meant exports silently came out with no captions at all.
  if ($('burnCaps')) $('burnCaps').checked = ed.cues.length > 0
  renderCues(); paintCaption(); dragCaption()

  runJob({ op: 'waveform', src, opts: { buckets: 1200 } }, 'Waveform').then(r => {
    if (r && r.peaks) { ed.peaks = r.peaks; drawWave() }
  })
  runJob({ op: 'filmstrip', src, opts: { count: 28, height: 64 } }, 'Filmstrip').then(r => {
    const img = $('strip')
    if (r && r.file && img) img.src = 'file://' + r.file + '?t=' + Date.now()
  })
}

// ── wiring ──────────────────────────────────────────────────────────────
function wireEditor() {
  const v = $('edVideo')

  $('inspTabs').onclick = e => {
    const b = e.target.closest('button[data-tab]'); if (!b) return
    ed.tab = b.dataset.tab
    document.querySelectorAll('#inspTabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)))
    document.querySelectorAll('.insp-panel').forEach(p => { p.hidden = p.dataset.panel !== ed.tab })
    $('cropBox').hidden = !(ed.tab === 'crop' && ed.crop)
  }

  // transport
  $('edPlay').onclick = () => v.paused ? v.play() : v.pause()
  $('edBack').onclick = () => seek(Math.max(ed.in, v.currentTime - 5))
  $('edFwd').onclick = () => seek(Math.min(ed.out, v.currentTime + 5))
  v.onplay = () => $('edPlay').innerHTML = ico('pause-fill', 'icon')
  v.onpause = () => $('edPlay').innerHTML = ico('play-fill', 'icon')
  v.ontimeupdate = () => {
    ed.cur = v.currentTime
    if (ed.cur > ed.out) { v.pause(); seek(ed.in) }
    const inCut = ed.cuts.find(([a, b]) => ed.cur >= a && ed.cur < b - 0.05)
    if (inCut) seek(inCut[1] + 0.02)          // playback jumps removed sections
    paintPlayhead(); paintTime(); highlightCue(); paintCaption(); syncCam()
  }

  // trim
  $('setIn').onclick = () => { ed.in = Math.min(ed.cur, ed.out - .2); paintTrim() }
  $('setOut').onclick = () => { ed.out = Math.max(ed.cur, ed.in + .2); paintTrim() }
  $('trimReset').onclick = () => { ed.in = 0; ed.out = ed.dur; paintTrim() }
  $('tlFit').onclick = () => { ed.in = 0; ed.out = ed.dur; paintTrim() }
  $('doSilence').onclick = async () => {
    toast('Looking for dead air…')
    const r = await runJob({ op: 'silence', src: ed.src }, 'Remove dead air')
    if (r) { toast(`Cut ${r.savedPct}%, ${r.cuts} segments kept`, 'ok'); refreshLibrary(); openInEditor(r.file) }
  }

  $('toolSwitch').onclick = e => {
    const b = e.target.closest('[data-tool]'); if (!b) return
    ed.cutMode = b.dataset.tool === 'cut'
    $('toolSwitch').querySelectorAll('button').forEach(x =>
      x.setAttribute('aria-selected', String(x === b)))
    $('tlWrap').dataset.cut = String(ed.cutMode)
    $('cutHint').textContent = ed.cutMode
      ? 'Drag across the timeline to mark a section for removal.'
      : 'Drag the timeline to scrub, or drag the gold handles to trim.'
  }
  // escape always returns to the normal cursor
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && ed.cutMode && $('toolSwitch')) {
      $('toolSwitch').querySelector('[data-tool="select"]').click()
    }
  })

  // timeline drag
  dragTimeline()

  // crop
  $('arChips').onclick = e => {
    const b = e.target.closest('[data-ar]'); if (!b) return
    ed.cropAR = b.dataset.ar
    document.querySelectorAll('#arChips .chip').forEach(x => x.setAttribute('aria-pressed', String(x === b)))
    if (ed.crop) applyAspect()
  }
  $('cropOn').onclick = () => { ed.crop = ed.crop ? null : { x: .1, y: .1, w: .8, h: .8 }; applyAspect(); paintCrop() }
  $('cropReset').onclick = () => { ed.crop = null; paintCrop() }
  dragCrop()

  // text
  $('addText').onclick = () => {
    ed.texts.push({ text: 'New text', fx: .5, fy: .5, sizeFrac: .06, color: 'white', box: false, start: null, end: null })
    ed.selText = ed.texts.length - 1
    renderTexts(); renderLayerList()
  }
  $('txtValue').oninput = e => { cur().text = e.target.value; renderTexts(); renderLayerList() }
  bindRange('txtSize', v2 => { cur().sizeFrac = v2 / 100; renderTexts() }, v2 => v2)
  // colour: eight quick swatches plus a full picker
  const sw = $('txtSwatches')
  sw.innerHTML = SWATCHES.map(c => `<button class="sw" data-c="${c}" style="background:${c}"></button>`).join('')
  sw.onclick = e => {
    const b = e.target.closest('.sw'); if (!b) return
    cur().color = b.dataset.c; $('txtColor').value = b.dataset.c
    paintSwatches(); renderTexts()
  }
  $('txtColor').oninput = e => { cur().color = e.target.value; paintSwatches(); renderTexts() }

  dropdown('txtFont', FONTS.map(f => ({ ...f, font: f.id })), 'Helvetica', id => {
    cur().font = id; renderTexts()
  })

  $('txtAlign').onclick = e => {
    const b = e.target.closest('[data-align]'); if (!b) return
    cur().align = b.dataset.align
    $('txtAlign').querySelectorAll('button').forEach(x => x.setAttribute('aria-selected', String(x === b)))
    renderTexts()
  }
  $('txtBox').onchange = e => { cur().box = e.target.checked; renderTexts() }
  $('txtFrom').onclick = () => { cur().start = ed.cur; if (cur().end == null) cur().end = ed.out; paintTextRange() }
  $('txtTo').onclick = () => { cur().end = ed.cur; if (cur().start == null) cur().start = ed.in; paintTextRange() }
  $('txtDel').onclick = () => { ed.texts.splice(ed.selText, 1); ed.selText = null; renderTexts(); renderLayerList() }

  // caption styling
  dropdown('capFont', FONTS.map(f => ({ ...f, font: f.id })), ed.capStyle.font, id => { ed.capStyle.font = id; paintCaption() })
  bindRange('capSize', v => { ed.capStyle.scale = v / 100; paintCaption() }, v => (v / 100).toFixed(1) + '×')
  bindRange('camSize', v => { if (ed.cam) { ed.cam.size = v / 100; paintCam() } }, v => v + '%')
  if ($('camCorner')) $('camCorner').onclick = e => {
    const b = e.target.closest('button[data-c]'); if (!b || !ed.cam) return
    const m = Math.max(0.06, ed.cam.size / 2 + 0.02)
    ed.cam.x = b.dataset.c[1] === 'l' ? m : 1 - m
    ed.cam.y = b.dataset.c[0] === 't' ? m : 1 - m
    paintCam()
  }
  if ($('camOn')) $('camOn').onchange = e => { if (ed.cam) { ed.cam.on = e.target.checked; paintCam() } }
  dragCam()
  const capSw = $('capSwatches')
  capSw.innerHTML = SWATCHES.map(c => `<button class="sw" data-c="${c}" style="background:${c}"
    aria-selected="${c === '#FFFFFF'}"></button>`).join('')
  capSw.onclick = e => {
    const b = e.target.closest('.sw'); if (!b) return
    ed.capStyle.colour = b.dataset.c; paintCaption(); $('capColour').value = b.dataset.c
    capSw.querySelectorAll('.sw').forEach(x => x.setAttribute('aria-selected', String(x === b)))
  }
  $('capColour').oninput = e => { ed.capStyle.colour = e.target.value; paintCaption() }
  $('capPos').onclick = e => {
    const b = e.target.closest('[data-pos]'); if (!b) return
    ed.capStyle.position = b.dataset.pos
    delete ed.capStyle.fx; delete ed.capStyle.fy      // preset wins over a drag
    paintCaption()
    $('capPos').querySelectorAll('button').forEach(x => x.setAttribute('aria-selected', String(x === b)))
  }
  $('capBoxed').onchange = e => { ed.capStyle.boxed = e.target.checked; paintCaption() }

  // captions
  $('doTranscribe').onclick = async () => {
    $('trProg').hidden = false; $('trProg').classList.add('indeterminate')
    $('doTranscribe').disabled = true
    const r = await runJob({ op: 'transcribe', src: ed.src }, 'Transcribe')
    $('trProg').hidden = true; $('doTranscribe').disabled = false
    if (r) {
      ed.cues = r.cues || []; renderCues(); paintCaption(); dragCaption()
      if ($('burnCaps') && ed.cues.length) $('burnCaps').checked = true
      toast(`${r.words} words${r.rtfx ? ` · ${r.rtfx}x realtime` : ''}`, 'ok')
    }
    paintTranscribeBtn()
  }

  // audio
  bindRange('gain', v2 => {}, v2 => `${v2 > 0 ? '+' : ''}${v2}dB`)
  bindRange('fadeIn', () => {}, v2 => (v2 / 10).toFixed(1) + 's')
  bindRange('fadeOut', () => {}, v2 => (v2 / 10).toFixed(1) + 's')

  // look panel
  const bd = $('bdGrid')
  const loadBackdrops = () => ipcRenderer.invoke('backdrops').then(list => {
    bd.innerHTML = `<button class="bd" data-bd="" aria-selected="${!ed.backdrop}"><span class="bd-swatch none">${ico('x', 'icon-sm')}</span>None</button>` +
      list.map(b => `<button class="bd" data-bd="${b.id}"
        ${b.file ? `data-file="${b.file}"` : ''} aria-selected="false">
        <span class="bd-swatch ${b.image ? '' : 'bd-' + b.id}"
          ${b.file ? `style="background:url('file://${encodeURI(b.file).replace(/'/g, '%27')}') center/cover"` : ''}></span>${b.label}</button>`).join('')
      + `<button class="bd bd-add" id="bdAdd">
           <span class="bd-swatch none">${ico('plus', 'icon-sm')}</span>Your image</button>`
    bd.onclick = e => {
      if (e.target.closest('#bdAdd')) return pickBackdrop()
      const b = e.target.closest('.bd'); if (!b) return
      ed.backdrop = b.dataset.bd || null
      ed.backdropFile = b.dataset.file || null
      bd.querySelectorAll('.bd').forEach(x => x.setAttribute('aria-selected', String(x === b)))
      paintBackdrop()
    }
  })
  loadBackdrops()

  // Upload runs in the renderer with a file input, no main process round trip.
  // Files are copied into userData so they survive an app update.
  function pickBackdrop() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp'
    input.onchange = async () => {
      const f = input.files && input.files[0]
      if (!f) return
      const srcPath = f.path
      const url = URL.createObjectURL(f)
      const dims = await new Promise(res => {
        const img = new Image()
        img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight })
        img.onerror = () => res(null)
        img.src = url
      })
      URL.revokeObjectURL(url)
      if (!dims) return toast('That image could not be read', 'bad')

      const dir = path.join(os.homedir(), 'Library/Application Support/Fetch/backdrops')
      try { fs.mkdirSync(dir, { recursive: true }) } catch {}
      let dest = path.join(dir, path.basename(srcPath))
      let n = 1
      while (fs.existsSync(dest)) {
        const e = path.extname(srcPath), b = path.basename(srcPath, e)
        dest = path.join(dir, `${b}-${++n}${e}`)
      }
      try { fs.copyFileSync(srcPath, dest) } catch { return toast('Could not save that image', 'bad') }

      // The compositor scales to cover and centre-crops, so anything under
      // 1920x1080 gets upscaled and will look soft. Say so rather than hide it.
      const small = dims.w < 1920 || dims.h < 1080
      const ratio = (dims.w / dims.h).toFixed(2)
      const offAspect = Math.abs(dims.w / dims.h - 16 / 9) > 0.25
      await loadBackdrops()
      const added = bd.querySelector(`[data-file="${CSS.escape(dest)}"]`)
      if (added) added.click()
      if (small) toast(`Added, but it is ${dims.w}x${dims.h}. Under 1920x1080 will look soft.`, 'bad', 6500)
      else if (offAspect) toast(`Added. At ${ratio}:1 it will be cropped to fit 16:9.`, '', 5500)
      else toast(`Added ${dims.w}x${dims.h} backdrop`, 'ok')
    }
    input.click()
  }
  $('outAspect').onclick = e => {
    const b = e.target.closest('[data-ar]'); if (!b) return
    ed.outAspect = b.dataset.ar ? +b.dataset.ar : null
    $('outAspect').querySelectorAll('.chip').forEach(x => x.setAttribute('aria-pressed', String(x === b)))
    $('aspectNote').textContent = ed.outAspect
      ? 'Your recording is fitted inside this shape, so margins differ by side.'
      : "Auto keeps your recording's shape with an even margin all round."
    paintBackdrop()
  }
  bindRange('bdInset', paintBackdrop, v => v + '%')
  bindRange('bdRadius', paintBackdrop, v => String(v))
  bindRange('zoomAmt', () => {}, v => (v / 100).toFixed(1) + '×')
  $('autoZoom').onchange = e => { ed.autoZoom = e.target.checked }
  // tell the user plainly whether cursor data exists for this clip
  ipcRenderer.invoke('has-cursor', ed.src).then(has => {
    $('zoomNote').textContent = has
      ? 'Cursor track found for this recording.'
      : 'No cursor track: only recordings made by Fetch can auto zoom.'
    $('autoZoom').disabled = !has
  })

  // ---- added audio track ----
  const pickAudio = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'audio/*,video/*'
    input.onchange = async () => {
      const f = input.files && input.files[0]
      if (!f) return
      ed.audioTrack = { file: f.path, name: f.name, volume: 0.6, offset: 0, replace: false }
      $('laneExtra').hidden = false
      $('extraPanel').hidden = false
      $('extraName').textContent = f.name
      toast(`Added ${f.name}`, 'ok')
      const r = await runJob({ op: 'waveform', src: f.path, opts: { buckets: 900 } }, 'Waveform')
      ed.audioTrack.peaks = (r && r.peaks) || []
      drawExtraWave()
    }
    input.click()
  }
  $('addAudio').onclick = pickAudio
  $('extraRemove').onclick = () => {
    ed.audioTrack = null
    $('laneExtra').hidden = true
    $('extraPanel').hidden = true
  }
  bindRange('extraVol', v => { if (ed.audioTrack) ed.audioTrack.volume = v / 100 }, v => v + '%')
  bindRange('extraOff', v => { if (ed.audioTrack) { ed.audioTrack.offset = v / 10; drawExtraWave() } },
            v => (v / 10).toFixed(1) + 's')
  $('extraReplace').onchange = e => { if (ed.audioTrack) ed.audioTrack.replace = e.target.checked }
  $('transcribeExtra').onclick = async () => {
    if (!ed.audioTrack) return
    toast('Transcribing the added track')
    const r = await runJob({ op: 'transcribe', src: ed.audioTrack.file }, 'Transcribe')
    if (r) {
      ed.cues = r.cues || []
      // the cues belong to this clip now, so persist them against the video
      await ipcRenderer.invoke('write-cues', ed.src, ed.cues)
      renderCues(); paintCaption(); dragCaption(); paintTranscribeBtn()
      toast(`${r.words} words from the added track`, 'ok')
    }
  }

  $('doExport').onclick = exportModal

  document.querySelectorAll('.ed .slider').forEach(s => {
    const paint = () => s.style.setProperty('--fill', ((s.value - s.min) / (s.max - s.min) * 100) + '%')
    s.addEventListener('input', paint); paint()
  })
}

// macOS renders <select> popups with its own blue highlight and system font,
// which is why these are built from scratch.
// The dropdown lives in ui/dropdown.js so the wizard and the editor share one
// implementation. This thin wrapper keeps the existing call sites unchanged.
function dropdown(mount, items, value, onPick) {
  if (typeof window.Dropdown === 'function') return window.Dropdown(mount, items, value, onPick)
  const el2 = typeof mount === 'string' ? $(mount) : mount
  if (el2) el2.textContent = (items.find(i => i.id === value) || items[0] || {}).label || ''
}

const FONTS = [
  { id: 'Helvetica',            label: 'Helvetica',  file: '/System/Library/Fonts/Helvetica.ttc' },
  { id: 'SF Pro',               label: 'SF Pro',     file: '/System/Library/Fonts/SFNS.ttf' },
  { id: 'SF Mono',              label: 'SF Mono',    file: '/System/Library/Fonts/SFNSMono.ttf' },
  { id: 'New York',             label: 'New York',   file: '/System/Library/Fonts/NewYork.ttf' },
  { id: 'Avenir Next',          label: 'Avenir Next',file: '/System/Library/Fonts/Avenir Next.ttc' },
  { id: 'Georgia',              label: 'Georgia',    file: '/Library/Fonts/Georgia.ttf' },
  { id: 'Impact',               label: 'Impact',     file: '/Library/Fonts/Impact.ttf' },
]
const SWATCHES = ['#FFFFFF', '#0A0908', '#F0A93C', '#FF4438', '#4ADE80', '#5B9DFF', '#F472B6', '#FBBF24']

// Motion clips are WebM with alpha. If one is missing or fails to decode, fall
// back to the matching still: a wait screen that renders nothing is worse than
// a wait screen that does not move.
function motion(name, still, cls = '') {
  return `<video class="motion ${cls}" src="./assets/mascot/motion/${name}.webm"
            poster="./assets/mascot/${still}.png" autoplay loop muted playsinline
            onerror="this.replaceWith(Object.assign(new Image(),{src:'./assets/mascot/${still}.png',className:'motion ${cls}'}))"></video>`
}

const cur = () => ed.texts[ed.selText] || {}
function bindRange(id, apply, fmt) {
  const s = $(id), out = $(id + 'Val')
  if (!s) return
  s.oninput = () => { apply(+s.value); if (out) out.textContent = fmt(+s.value) }
  if (out) out.textContent = fmt(+s.value)
}

// ── painting ────────────────────────────────────────────────────────────
const clamp01 = n => Math.max(0, Math.min(1, n))
const seek = t => {
  const v = $('edVideo')
  v.currentTime = Math.max(0, Math.min(t, ed.dur))
  ed.cur = v.currentTime
  paintPlayhead(); paintTime()
  highlightCue(); paintCaption()      // the caption must follow the playhead, not just playback
  syncCam()
}

function paintTime() {
  $('edTime').textContent = `${fmtTime(ed.cur)} / ${fmtTime(ed.dur)}`
}
function paintPlayhead() {
  const w = $('tlWrap').clientWidth
  const x = ed.dur ? (ed.cur / ed.dur) * w : 0
  $('playhead').style.left = Math.max(1, Math.min(w - 1, x)) + 'px'
}
function renderCuts() {
  const wrap = $('tlWrap'); if (!wrap) return
  wrap.querySelectorAll('.tl-cut').forEach(n => n.remove())
  const w = wrap.clientWidth, d = ed.dur || 1
  ed.cuts.forEach(([a, b], i) => {
    const n = el('div', 'tl-cut')
    n.style.left = (a / d * w) + 'px'
    n.style.width = Math.max(2, (b - a) / d * w) + 'px'
    n.innerHTML = `<button class="tl-cut-x" title="Restore this section">${ico('x', 'icon-sm')}</button>`
    n.querySelector('.tl-cut-x').onclick = e => { e.stopPropagation(); ed.cuts.splice(i, 1); renderCuts(); paintTrim() }
    wrap.appendChild(n)
  })

  const list = $('cutList')
  if (list) {
    list.innerHTML = ed.cuts.length
      ? ed.cuts.map(([a, b], i) => `<button class="cut-row" data-i="${i}">
          ${ico('scissors', 'icon-sm')}
          <span class="mono">${fmtTime(a)} to ${fmtTime(b)}</span>
          <span class="cut-len mono">-${(b - a).toFixed(1)}s</span></button>`).join('')
      : ''
    list.querySelectorAll('.cut-row').forEach(b => b.onclick = () => {
      ed.cuts.splice(+b.dataset.i, 1); renderCuts(); paintTrim()
    })
  }
  const removed = ed.cuts.reduce((t, [a, b]) => t + (b - a), 0)
  const span = Math.max(0, (ed.out - ed.in) - removed)
  const chip = $('edOutLen')
  if (chip) chip.textContent = `${span.toFixed(1)}s out`
}

function paintTrim() {
  const w = $('tlWrap').clientWidth, d = ed.dur || 1
  const a = ed.in / d * w, b = ed.out / d * w
  $('tlRegion').style.left = a + 'px'; $('tlRegion').style.width = (b - a) + 'px'
  $('hIn').style.left = a + 'px'; $('hOut').style.left = b + 'px'
  $('dimL').style.left = '0px'; $('dimL').style.width = a + 'px'
  $('dimR').style.left = b + 'px'; $('dimR').style.width = (w - b) + 'px'
  $('trimIn').textContent = fmtTime(ed.in); $('trimOut').textContent = fmtTime(ed.out)
  $('tlRange').textContent = `${fmtTime(ed.in)} to ${fmtTime(ed.out)}`
  renderCuts()
}
function layoutTimeline() {
  const w = $('tlWrap').clientWidth
  const ticks = $('tlTicks'); ticks.innerHTML = ''
  const step = ed.dur > 240 ? 60 : ed.dur > 60 ? 30 : ed.dur > 20 ? 10 : 5
  for (let t = 0; t <= ed.dur; t += step) {
    const s = el('span', null, fmtTime(t)); s.style.left = (t / ed.dur * w) + 'px'; ticks.appendChild(s)
  }
  paintTrim(); paintPlayhead()
}
window.addEventListener('resize', () => {
  if (ed.src && $('tlWrap')) { drawWave(); drawExtraWave(); layoutTimeline(); paintBackdrop(); paintCaption(); paintCam() }
})

function drawWave() {
  const c = $('wave'); if (!c) return
  const lane = $('laneAudio') || $('tlWrap'), dpr = devicePixelRatio || 2
  c.width = lane.clientWidth * dpr; c.height = lane.clientHeight * dpr
  const g = c.getContext('2d')
  g.clearRect(0, 0, c.width, c.height)
  const mid = c.height / 2
  if (!ed.peaks.length) {
    g.fillStyle = 'rgba(189,181,172,.18)'; g.fillRect(0, mid - 1, c.width, 2); return
  }
  const bw = c.width / ed.peaks.length
  g.fillStyle = 'rgba(91,157,255,.72)'   // matches the blue audio lane
  ed.peaks.forEach((p, i) => {
    const h = Math.max(2 * dpr, p * (c.height * .82))
    g.fillRect(i * bw, mid - h / 2, Math.max(1, bw * .78), h)
  })
}

function drawExtraWave() {
  const c = $('waveExtra'); if (!c || !ed.audioTrack) return
  const lane = $('laneExtra'), dpr = devicePixelRatio || 2
  c.width = lane.clientWidth * dpr; c.height = lane.clientHeight * dpr
  const g = c.getContext('2d')
  g.clearRect(0, 0, c.width, c.height)
  const peaks = ed.audioTrack.peaks || []
  if (!peaks.length) return
  // offset shifts the track along the same timeline the video uses
  const startFrac = ed.dur ? (ed.audioTrack.offset || 0) / ed.dur : 0
  const x0 = startFrac * c.width
  const bw = (c.width - x0) / peaks.length
  const mid = c.height / 2
  g.fillStyle = 'rgba(167,139,250,.75)'      // violet, distinct from the recording's own audio
  peaks.forEach((p, i) => {
    const h = Math.max(2 * dpr, p * (c.height * .8))
    g.fillRect(x0 + i * bw, mid - h / 2, Math.max(1, bw * .8), h)
  })
}

function dragTimeline() {
  const wrap = $('tlWrap')
  const at = e => clamp01((e.clientX - wrap.getBoundingClientRect().left) / wrap.clientWidth) * ed.dur
  let mode = null
  const down = e => {
    if (ed.cutMode && !e.target.closest('.tl-handle') && !e.target.closest('.tl-cut')) {
      const from = at(e)
      const ghost = el('div', 'tl-cut ghost')
      ghost.style.left = (from / (ed.dur || 1) * wrap.clientWidth) + 'px'
      ghost.style.width = '2px'
      wrap.appendChild(ghost)
      const move = ev => {
        const to = at(ev)
        const a = Math.min(from, to), b = Math.max(from, to)
        ghost.style.left = (a / (ed.dur || 1) * wrap.clientWidth) + 'px'
        ghost.style.width = Math.max(2, (b - a) / (ed.dur || 1) * wrap.clientWidth) + 'px'
      }
      const up = ev => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
        ghost.remove()
        const to = at(ev)
        const a = Math.min(from, to), b = Math.max(from, to)
        if (b - a > 0.15) { ed.cuts.push([a, b]); ed.cuts.sort((x, y) => x[0] - y[0]); paintTrim() }
      }
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
      return
    }
    if (e.target === $('hIn')) mode = 'in'
    else if (e.target === $('hOut')) mode = 'out'
    else { mode = 'seek'; seek(at(e)) }
    const move = ev => {
      const t = at(ev)
      if (mode === 'in') ed.in = Math.min(t, ed.out - .2)
      else if (mode === 'out') ed.out = Math.max(t, ed.in + .2)
      else seek(t)
      paintTrim()
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); mode = null }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  wrap.addEventListener('mousedown', down)

  // dragging the playhead itself, so it can be grabbed even sitting at zero
  const ph = $('playhead')
  if (ph) ph.addEventListener('mousedown', e => {
    e.stopPropagation()
    const move = ev => seek(at(ev))
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  })
}

// ── crop ────────────────────────────────────────────────────────────────
// With a backdrop the export draws overlays over the composited frame, so the
// preview has to offer the same area or dragging would not match the output.
function overlayRect() {
  const v = $('edVideo'), frame = $('stageFrame'), canvas = $('edCanvas')
  if (!v || !canvas) return { left: 0, top: 0, w: 0, h: 0 }
  const host = (ed.backdrop && frame) ? frame : v
  const r = host.getBoundingClientRect(), p = canvas.getBoundingClientRect()
  return { left: r.left - p.left, top: r.top - p.top, w: r.width, h: r.height }
}

function videoRect() {
  const v = $('edVideo'), r = v.getBoundingClientRect(), p = $('edCanvas').getBoundingClientRect()
  return { left: r.left - p.left, top: r.top - p.top, w: r.width, h: r.height }
}
function applyAspect() {
  if (!ed.crop || ed.cropAR === 'free') return
  const [a, b] = ed.cropAR.split(':').map(Number)
  const vr = videoRect(), target = a / b
  const pxW = ed.crop.w * vr.w, pxH = pxW / target
  ed.crop.h = clamp01(pxH / vr.h)
  if (ed.crop.y + ed.crop.h > 1) ed.crop.y = Math.max(0, 1 - ed.crop.h)
}
function paintCrop() {
  const box = $('cropBox')
  if (!ed.crop) { box.hidden = true; return }
  box.hidden = ed.tab !== 'crop'
  const vr = videoRect()
  box.style.left = (vr.left + ed.crop.x * vr.w) + 'px'
  box.style.top = (vr.top + ed.crop.y * vr.h) + 'px'
  box.style.width = (ed.crop.w * vr.w) + 'px'
  box.style.height = (ed.crop.h * vr.h) + 'px'
}
function dragCrop() {
  const box = $('cropBox')
  box.addEventListener('mousedown', e => {
    if (!ed.crop) return
    e.preventDefault()
    const vr = videoRect(), h = e.target.classList.contains('h') ? [...e.target.classList].find(c => ['nw','ne','sw','se'].includes(c)) : null
    const s = { ...ed.crop }, x0 = e.clientX, y0 = e.clientY
    const move = ev => {
      const dx = (ev.clientX - x0) / vr.w, dy = (ev.clientY - y0) / vr.h
      if (!h) { ed.crop.x = clamp01(s.x + dx); ed.crop.y = clamp01(s.y + dy) }
      else {
        if (h.includes('w')) { ed.crop.x = clamp01(s.x + dx); ed.crop.w = Math.max(.05, s.w - dx) }
        if (h.includes('e')) ed.crop.w = Math.max(.05, s.w + dx)
        if (h.includes('n')) { ed.crop.y = clamp01(s.y + dy); ed.crop.h = Math.max(.05, s.h - dy) }
        if (h.includes('s')) ed.crop.h = Math.max(.05, s.h + dy)
        applyAspect()
      }
      ed.crop.w = Math.min(ed.crop.w, 1 - ed.crop.x); ed.crop.h = Math.min(ed.crop.h, 1 - ed.crop.y)
      paintCrop()
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  })
}

// ── inline edit (captions & text layers) ─────────────────────────────────
// Double-click turns the node itself into its own editor, same element, same
// style, so nothing jumps. Enter commits, Escape cancels, blur commits.
function inlineEdit(node, prevText, onCommit, onDone) {
  const v = $('edVideo'), wasPlaying = v && !v.paused
  if (v) v.pause()
  const prevCursor = node.style.cursor
  node.style.cursor = 'text'
  node.contentEditable = 'true'
  node.dataset.editing = 'true'
  node.focus()
  const range = document.createRange(); range.selectNodeContents(node)
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range)
  const finish = commit => {
    node.contentEditable = 'false'
    node.dataset.editing = 'false'
    node.style.cursor = prevCursor
    node.removeEventListener('keydown', onKey)
    node.removeEventListener('blur', onBlur)
    if (commit) onCommit(node.textContent.trim())
    else node.textContent = prevText
    if (wasPlaying && v) v.play()
    if (onDone) onDone()
  }
  const onKey = e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true) }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false) }
  }
  const onBlur = () => finish(true)
  node.addEventListener('keydown', onKey)
  node.addEventListener('blur', onBlur)
}

// ── text layers ─────────────────────────────────────────────────────────
function renderTexts() {
  if (document.querySelector('.txt-layer[data-editing="true"]')) return // a layer is being edited in place, leave it
  document.querySelectorAll('.txt-layer').forEach(n => n.remove())
  const canvas = $('edCanvas'), vr = overlayRect()
  ed.texts.forEach((t, i) => {
    const n = el('div', 'txt-layer', (t.text || '').replace(/</g, '&lt;') || '…')
    n.dataset.sel = String(i === ed.selText); n.dataset.box = String(!!t.box)
    n.setAttribute('data-tip', 'Double-click to edit')
    n.style.left = (vr.left + t.fx * vr.w) + 'px'
    n.style.top = (vr.top + t.fy * vr.h) + 'px'
    n.style.fontSize = Math.max(9, t.sizeFrac * vr.h) + 'px'
    n.style.color = t.color === 'white' ? '#fff' : (t.color || '#fff')
    n.style.fontFamily = t.font || 'Helvetica'
    n.style.textAlign = t.align || 'center'
    n.onmousedown = e => {
      if (n.dataset.editing === 'true') return // let the caret land instead of starting a drag
      e.preventDefault(); ed.selText = i; renderTexts(); renderLayerList()
      const x0 = e.clientX, y0 = e.clientY, s = { fx: t.fx, fy: t.fy }
      const rect = overlayRect()
      const move = ev => { t.fx = clamp01(s.fx + (ev.clientX - x0) / rect.w); t.fy = clamp01(s.fy + (ev.clientY - y0) / rect.h); renderTexts() }
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    }
    n.ondblclick = e => {
      e.preventDefault(); e.stopPropagation()
      const prevText = t.text || ''
      inlineEdit(n, prevText, text => {
        t.text = text
        $('txtValue').value = text
        renderLayerList()
      }, renderTexts)
    }
    canvas.appendChild(n)
  })
}
function renderLayerList() {
  const list = $('layerList'); list.innerHTML = ''
  ed.texts.forEach((t, i) => {
    const r = el('div', 'layer-row', `${ico('text-t', 'icon-sm')}<span class="lname">${(t.text || 'Empty').slice(0, 22)}</span>`)
    r.dataset.sel = String(i === ed.selText)
    r.onclick = () => { ed.selText = i; renderTexts(); renderLayerList() }
    list.appendChild(r)
  })
  const has = ed.selText != null && ed.texts[ed.selText]
  $('textProps').hidden = !has
  if (has) {
    const t = cur()
    $('txtValue').value = t.text || ''
    $('txtSize').value = Math.round((t.sizeFrac || .06) * 100); $('txtSizeVal').textContent = Math.round((t.sizeFrac || .06) * 100)
    $('txtColor').value = t.color || 'white'
    $('txtBox').checked = !!t.box
    paintTextRange()
  }
}
// live preview of the framed look: no export needed to see it
const BD_CSS = {
  dusk:   'linear-gradient(135deg,#F0A93C,#7A3E12)',
  ember:  'linear-gradient(135deg,#FF6B4A,#7A1F3D)',
  mint:   'linear-gradient(135deg,#63E6BE,#0B7285)',
  violet: 'linear-gradient(135deg,#A78BFA,#3B1D6E)',
  slate:  'linear-gradient(135deg,#64748B,#0F172A)',
  ink:    'linear-gradient(135deg,#2A2320,#0A0908)',
}
// Fit the video inside the stage, keeping its aspect. Done in JS because
// max-height:100% does not clamp a replaced element whose height is derived from
// its own intrinsic aspect: the video kept its width-driven height, overflowed the
// stage, and overflow:hidden cut off the bottom of the frame, captions included.
function fitVideoToStage(v) {
  const stage = $('edCanvas')
  if (!stage || !v) return
  const ar = (ed.videoW && ed.videoH) ? ed.videoW / ed.videoH
    : (v.videoWidth && v.videoHeight) ? v.videoWidth / v.videoHeight : 16 / 9
  const availW = stage.clientWidth, availH = stage.clientHeight
  if (!availW || !availH) return
  let w = availW, h = w / ar
  if (h > availH) { h = availH; w = h * ar }
  v.style.width = Math.round(w) + 'px'
  v.style.height = Math.round(h) + 'px'
}
function paintBackdrop() {
  const frame = $('stageFrame'), v = $('edVideo')
  if (!frame || !v) return
  if (!ed.backdrop) {
    frame.dataset.bd = 'none'
    frame.style.background = ''
    frame.style.aspectRatio = ''
    frame.style.padding = '0'
    frame.style.height = ''; frame.style.width = ''
    v.style.objectFit = ''
    v.style.borderRadius = ''
    fitVideoToStage(v)
    renderTexts(); paintCam()
    return
  }
  frame.dataset.bd = ed.backdrop
  frame.style.background = ed.backdropFile
    ? `url("file://${encodeURI(ed.backdropFile).replace(/"/g, '%22')}") center/cover no-repeat`
    : (BD_CSS[ed.backdrop] || BD_CSS.dusk)
  const inset = ($('bdInset') ? +$('bdInset').value : 8) / 100
  // the stage is small, so the inset is expressed against the frame's own width
  // The frame fills the stage and the video shrinks inside it. Padding the frame
  // around a full size video made the whole thing overflow the stage.
  const srcAR = (ed.videoW && ed.videoH) ? ed.videoW / ed.videoH
    : (v.videoWidth && v.videoHeight) ? v.videoWidth / v.videoHeight : 16 / 9
  // Explicit pixel sizes for both boxes. Percentages against an aspect-ratio
  // derived height do not resolve reliably, which left the bottom margin short.
  // Computed synchronously: requestAnimationFrame does not fire while the window
  // is not being composited.
  const stage = $('edCanvas')
  const ar = ed.outAspect || srcAR
  let boxH = stage.clientHeight
  let boxW = boxH * ar
  if (boxW > stage.clientWidth) { boxW = stage.clientWidth; boxH = boxW / ar }
  const px = Math.round(Math.max(boxW, boxH) * inset)

  frame.style.aspectRatio = ''
  frame.style.padding = '0'
  frame.style.width = Math.round(boxW) + 'px'
  frame.style.height = Math.round(boxH) + 'px'
  v.style.width = Math.round(boxW - px * 2) + 'px'
  v.style.height = Math.round(boxH - px * 2) + 'px'
  v.style.objectFit = 'contain'
  setTimeout(() => { try { renderTexts(); paintCaption() } catch {} }, 0)
  const r = $('bdRadius') ? +$('bdRadius').value : 26
  v.style.borderRadius = Math.round(r * 0.5) + 'px'
  renderTexts()
}

function paintSwatches() {
  const c = (cur().color || '#FFFFFF').toLowerCase()
  document.querySelectorAll('.sw').forEach(b =>
    b.setAttribute('aria-selected', String(b.dataset.c.toLowerCase() === c)))
}

function paintTextRange() {
  const t = cur()
  $('txtRange').textContent = (t.start != null && t.end != null)
    ? `Shows ${fmtTime(t.start)} → ${fmtTime(t.end)}` : 'Shows for the whole clip'
}

// ── captions ────────────────────────────────────────────────────────────
// The button should say what has already happened, and offer the redo explicitly.
function paintTranscribeBtn() {
  const b = $('doTranscribe'); if (!b) return
  const done = ed.cues && ed.cues.length
  b.innerHTML = done
    ? `${ico('check', 'icon-sm')} Transcribed`
    : `${ico('sparkle', 'icon-sm')} Transcribe`
  b.classList.toggle('done', !!done)
  b.title = done ? 'Transcribe again' : 'Create a transcript on this device'
}

function renderCues() {
  const list = $('cueList'); if (!list) return
  list.innerHTML = ''
  if (!ed.cues.length) {
    list.innerHTML = `<p class="micro dimmer">No transcript yet. Transcribe runs on-device, nothing is uploaded.</p>`
    paintTranscribeBtn()
    return
  }
  paintTranscribeBtn()
  ed.cues.forEach((c, i) => {
    const n = el('div', 'cue', `<span class="t">${fmtTime(c.start)}</span><span class="x" contenteditable>${c.text}</span>`)
    n.dataset.i = i
    n.onclick = e => { if (e.target.classList.contains('x')) return; seek(c.start) }
    n.querySelector('.x').onblur = e => { c.text = e.target.textContent.trim(); ipcRenderer.invoke('write-cues', ed.src, ed.cues) }
    list.appendChild(n)
  })
}
// Preview of what burn-in will produce. Mirrors the caption style controls so
// what you see on the stage is what lands in the file.
function paintCaption() {
  const box = $('capOverlay'); if (!box) return
  const span = box.firstElementChild
  if (span.dataset.editing === 'true') return // being edited in place, leave it alone
  const cue = ed.cues.find(c => ed.cur >= c.start && ed.cur <= c.end)
  if (!cue) { box.dataset.on = 'false'; return }
  const st = ed.capStyle || {}
  const v = $('edVideo'), frame = $('stageFrame')
  const host = box.offsetParent || frame
  if (!v || !host) return
  // when framed, the caption can live anywhere on the composited canvas
  const anchor = (ed.backdrop && frame) ? frame : v
  const vb = anchor.getBoundingClientRect(), hb = host.getBoundingClientRect()
  box.dataset.on = 'true'
  box.dataset.pos = st.position || 'bottom'
  box.style.left = (vb.left - hb.left) + 'px'
  box.style.top = (vb.top - hb.top) + 'px'
  box.style.width = vb.width + 'px'
  box.style.height = vb.height + 'px'
  const vr = { h: vb.height }
  // style first: the clamp below needs the caption's real measured size
  span.textContent = cue.text
  span.style.fontFamily = st.font || 'Helvetica'
  span.style.fontSize = Math.max(9, (vr.h / 24) * (st.scale || 1)) + 'px'
  span.style.color = st.colour || '#FFFFFF'
  span.dataset.boxed = String(st.boxed !== false)
  // a dragged caption overrides the preset placement
  if (st.fx != null && st.fy != null) {
    box.dataset.pos = 'free'
    span.style.left = (st.fx * 100) + '%'
    span.style.top = (st.fy * 100) + '%'
    // it is centred on the drag point, so half of it has to fit on every side or
    // the frame's overflow:hidden crops it away
    const sb = span.getBoundingClientRect()
    if (sb.width && vb.width && vb.height) {
      const hw = (sb.width / 2) / vb.width, hh = (sb.height / 2) / vb.height
      const cx = Math.min(Math.max(hw, st.fx), Math.max(hw, 1 - hw))
      const cy = Math.min(Math.max(hh, st.fy), Math.max(hh, 1 - hh))
      if (cx !== st.fx) { st.fx = cx; span.style.left = (cx * 100) + '%' }
      if (cy !== st.fy) { st.fy = cy; span.style.top = (cy * 100) + '%' }
    }
  } else {
    span.style.left = ''; span.style.top = ''
  }
}

// ── camera bubble ───────────────────────────────────────────────────────
// The bubble was recorded to its own file rather than burned into the screen
// capture, which is what lets it be moved and resized here.
function loadCamTake(src) {
  ed.cam = null
  const btn = $('camTabBtn')
  try {
    const j = JSON.parse(fs.readFileSync(sidecarIn(src, '.cam.json'), 'utf8'))
    if (!j.file || !fs.existsSync(j.file)) throw new Error('no take')
    // start it where it actually sat on screen, so the default export matches
    // what the person saw while recording
    const sw = j.screenW || (j.display && j.display.w) || 1
    const sh = j.screenH || (j.display && j.display.h) || 1
    const size = (j.bubbleSize || 260) / sw
    ed.cam = {
      ...j, on: true,
      size: Math.max(0.10, Math.min(0.45, size)),
      x: j.bubbleX != null ? Math.max(0, Math.min(1, (j.bubbleX + (j.bubbleSize || 260) / 2) / sw)) : 0.84,
      y: j.bubbleY != null ? Math.max(0, Math.min(1, (j.bubbleY + (j.bubbleSize || 260) / 2) / sh)) : 0.80,
    }
  } catch {}
  if (btn) btn.hidden = !ed.cam
  const el2 = $('camBubble')
  if (el2) {
    el2.hidden = !ed.cam
    if (ed.cam) {
      el2.src = 'file://' + encodeURI(ed.cam.file).replace(/#/g, '%23')
      el2.load()
    } else el2.removeAttribute('src')
  }
  if (ed.cam) {
    const sz = $('camSize')
    if (sz) { sz.value = Math.round(ed.cam.size * 100); $('camSizeVal').textContent = Math.round(ed.cam.size * 100) + '%' }
  }
  paintCam()
}

// keep the preview bubble on the same frame as the screen video
function syncCam() {
  const c = $('camBubble'), v = $('edVideo')
  if (!c || !v || !ed.cam) return
  const skew = (ed.cam.camStartedAt && ed.cam.screenStartedAt)
    ? (ed.cam.screenStartedAt - ed.cam.camStartedAt) / 1000 : 0
  const want = v.currentTime + skew
  // the camera starts a moment after the screen take, so there is nothing to show yet
  const notYet = want < 0
  if (c.hidden !== notYet && ed.cam.on) c.hidden = notYet
  if (notYet) { if (!c.paused) c.pause(); return }
  if (Math.abs(c.currentTime - want) > 0.25) { try { c.currentTime = want } catch {} }
  if (v.paused && !c.paused) c.pause()
  if (!v.paused && c.paused) c.play().catch(() => {})
}

function paintCam() {
  const box = $('camBubble'), v = $('edVideo'), frame = $('stageFrame')
  if (!box) return
  if (!ed.cam || !ed.cam.on) { box.hidden = true; return }
  const host = box.offsetParent || frame
  if (!v || !host) return
  const vb = v.getBoundingClientRect(), hb = host.getBoundingClientRect()
  if (!vb.width) return
  const d = ed.cam.size * vb.width
  box.hidden = false
  box.style.width = d + 'px'
  box.style.height = d + 'px'
  box.style.left = (vb.left - hb.left + ed.cam.x * vb.width - d / 2) + 'px'
  box.style.top = (vb.top - hb.top + ed.cam.y * vb.height - d / 2) + 'px'
}

function dragCam() {
  const box = $('camBubble')
  if (!box) return
  box.onmousedown = e => {
    if (!ed.cam) return
    e.preventDefault(); e.stopPropagation()
    const v = $('edVideo'); const vb = v.getBoundingClientRect()
    const half = (ed.cam.size * vb.width) / 2
    const move = ev => {
      // keep the whole circle on the video, the export clamps the same way
      const hx = half / vb.width, hy = half / vb.height
      ed.cam.x = Math.max(hx, Math.min(1 - hx, (ev.clientX - vb.left) / vb.width))
      ed.cam.y = Math.max(hy, Math.min(1 - hy, (ev.clientY - vb.top) / vb.height))
      paintCam()
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
}

// Captions can be dragged to a custom spot. Once moved, the Place buttons stop
// applying until Reset puts it back on a preset.
function dragCaption() {
  const box = $('capOverlay'); if (!box) return
  const span = box.firstElementChild
  span.style.pointerEvents = 'auto'
  span.style.cursor = 'move'
  span.setAttribute('data-tip', 'Double-click to edit')
  span.onmousedown = e => {
    if (span.dataset.editing === 'true') return // let the caret land instead of starting a drag
    e.preventDefault(); e.stopPropagation()
    const v = (ed.backdrop && $('stageFrame')) ? $('stageFrame') : $('edVideo')
    if (!v) return
    const vb = v.getBoundingClientRect()
    const move = ev => {
      ed.capStyle.fx = Math.max(0.02, Math.min(0.98, (ev.clientX - vb.left) / vb.width))
      ed.capStyle.fy = Math.max(0.04, Math.min(0.96, (ev.clientY - vb.top) / vb.height))
      paintCaption()
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  span.ondblclick = e => {
    e.preventDefault(); e.stopPropagation()
    const cue = ed.cues.find(c => ed.cur >= c.start && ed.cur <= c.end)
    if (!cue) return
    inlineEdit(span, cue.text, text => {
      cue.text = text
      ipcRenderer.invoke('write-cues', ed.src, ed.cues)
      renderCues(); highlightCue()
    }, paintCaption)
  }
}

function highlightCue() {
  document.querySelectorAll('.cue').forEach(n => {
    const c = ed.cues[+n.dataset.i]
    n.dataset.active = String(c && ed.cur >= c.start && ed.cur <= c.end)
  })
}

// ── export ──────────────────────────────────────────────────────────────
async function exportModal() {
  const fmts = await ipcRenderer.invoke('formats')
  const scrim = el('div', 'scrim')
  scrim.innerHTML = `<div class="modal" style="width:min(560px,92vw)">
    <div class="modal-head">${ico('export', 'icon-lg')}<span class="modal-title">Export</span>
      <div style="flex:1"></div><button class="btn btn-ghost btn-icon btn-sm" data-close>${ico('x', 'icon-sm')}</button></div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:16px">
      <div><div class="insp-sec">Format</div>
        <div class="aspect-chips" id="fmtChips">
          ${fmts.map((f, i) => `<button class="chip" data-fmt="${f.id}" aria-pressed="${i === 0}">${f.label}</button>`).join('')}
        </div></div>
      <div><div class="insp-sec">Quality</div>
        <div class="aspect-chips" id="qChips">
          ${['high', 'balanced', 'small'].map((q, i) => `<button class="chip" data-q="${q}" aria-pressed="${i === 1}">${q}</button>`).join('')}
        </div></div>
      <div><div class="insp-sec">Resolution</div>
        <div class="aspect-chips" id="resChips">
          ${[['', 'Original'], ['1080', '1080p'], ['720', '720p']].map((r, i) => `<button class="chip" data-res="${r[0]}" aria-pressed="${i === 0}">${r[1]}</button>`).join('')}
        </div></div>
      <p class="micro dimmer" id="expSummary"></p>
    </div>
    <div class="modal-foot"><div style="flex:1"></div>
      <button class="btn btn-sm" data-close>Cancel</button>
      <button class="btn btn-primary btn-sm" id="expGo">${ico('export', 'icon-sm')} Export</button></div>
  </div>`
  document.body.appendChild(scrim)
  const pick = { fmt: fmts[0].id, q: 'balanced', res: '' }
  const group = (sel, key) => scrim.querySelectorAll(sel).forEach(b => b.onclick = () => {
    pick[key] = b.dataset[key === 'fmt' ? 'fmt' : key === 'q' ? 'q' : 'res']
    scrim.querySelectorAll(sel).forEach(x => x.setAttribute('aria-pressed', String(x === b)))
    summary()
  })
  const summary = () => scrim.querySelector('#expSummary').textContent =
    `${(ed.out - ed.in).toFixed(1)}s · ${pick.fmt.toUpperCase()} · ${pick.q}${pick.res ? ' · ' + pick.res + 'p' : ''}`
  group('[data-fmt]', 'fmt'); group('[data-q]', 'q'); group('[data-res]', 'res'); summary()
  const close = () => scrim.remove()
  scrim.querySelectorAll('[data-close]').forEach(b => b.onclick = close)
  scrim.onclick = e => { if (e.target === scrim) close() }
  scrim.querySelector('#expGo').onclick = () => { close(); doExport(pick) }
}

// A full screen working state. Exporting can take a while, and a thin bar in the
// sidebar does not tell you the app is busy, so this blurs the editor behind
// Biscuit doing the fetching.
function exportOverlay(label) {
  const scrim = el('div', 'scrim export-scrim')
  scrim.innerHTML = `
    <div class="export-card">
      ${motion('exporting', 'running', 'export-dog')}
      <div class="export-title">${label}</div>
      <div class="export-status">
        <span id="expPhase">Starting up</span>
        <span class="export-pct mono" id="expPct"></span>
      </div>
      <div class="bar export-bar"><i id="expFill"></i></div>
      <button class="btn btn-sm btn-ghost" id="expCancel">Cancel</button>
    </div>`
  document.body.appendChild(scrim)
  return {
    progress(pct, phase) {
      const f = scrim.querySelector('#expFill')
      const p = scrim.querySelector('#expPct')
      if (pct != null && isFinite(pct)) {
        const v = Math.max(0, Math.min(100, pct))
        if (f) f.style.width = Math.max(2, v) + '%'
        // never let it tick backwards: ffmpeg's time estimate can wobble
        const shown = Math.max(+(p.dataset.v || 0), Math.round(v))
        p.dataset.v = shown
        p.textContent = shown + '%'
      }
      if (phase) scrim.querySelector('#expPhase').textContent = phase
    },
    onCancel(fn) { scrim.querySelector('#expCancel').onclick = fn },
    close() { scrim.remove() },
  }
}

async function doExport(pick) {
  const opts = {
    start: ed.in, end: ed.out,
    format: pick.fmt, quality: pick.q,
    scale: pick.res ? +pick.res : undefined,
    crop: ed.crop, texts: ed.texts, cuts: ed.cuts,
    audioTrack: ed.audioTrack ? {
      file: ed.audioTrack.file, volume: ed.audioTrack.volume,
      offset: ed.audioTrack.offset, replace: ed.audioTrack.replace,
    } : null,
    autoZoom: !!ed.autoZoom,
    autoZoomOpts: { zoom: $('zoomAmt') ? +$('zoomAmt').value / 100 : 1.7 },
    backdrop: ed.backdrop || null,
    backdropAspect: ed.outAspect || null,
    inset: $('bdInset') ? +$('bdInset').value / 100 : 0.08,
    radius: $('bdRadius') ? +$('bdRadius').value : undefined,
    captions: $('burnCaps') && $('burnCaps').checked,
    captionStyle: ed.capStyle,
    camera: (ed.cam && ed.cam.on) ? { file: ed.cam.file, x: ed.cam.x, y: ed.cam.y, size: ed.cam.size,
      screenStartedAt: ed.cam.screenStartedAt, camStartedAt: ed.cam.camStartedAt, gaps: ed.cam.gaps } : null,
    denoise: $('denoise') && $('denoise').checked,
    loudnorm: $('loudnorm') ? $('loudnorm').checked : true,
    gain: $('gain') ? +$('gain').value : 0,
    fadeIn: $('fadeIn') ? +$('fadeIn').value / 10 : 0,
    fadeOut: $('fadeOut') ? +$('fadeOut').value / 10 : 0,
  }
  $('doExport').disabled = true
  const jobId = Date.now()
  const ov = exportOverlay(ed.backdrop || ed.autoZoom ? 'Building your video' : 'Fetching your video')
  ov.onCancel(async () => {
    await ipcRenderer.invoke('cancel-job', jobId)
    ov.close(); $('doExport').disabled = false
    toast('Export cancelled')
  })

  const cid = 'x' + Date.now()
  jobs.set(cid, j => {
    if (j.status === 'progress' && j.pct != null) ov.progress(j.pct, 'Encoding')
    if (j.status === 'done') {
      jobs.delete(cid); ov.close(); $('doExport').disabled = false
      // Settings can retire the source once an export succeeds. Trash, never unlink,
      // so an accidental setting is always recoverable.
      if (window.prefs && window.prefs.keepOriginal === false && ed.src !== j.result.file) {
        const n = trash([ed.src, ...sidecars(ed.src)])
        if (n) toast(`Exported, original moved to Trash`, 'ok')
        else toast(`Exported · ${j.result.mb} MB`, 'ok')
      } else {
        toast(`Exported · ${j.result.mb} MB`, 'ok')
      }
      // the edit is safely on disk now, so the autosave no longer counts as unsaved
      if (typeof window.clearEditorDirty === 'function') window.clearEditorDirty()
      refreshLibrary()
      ipcRenderer.send('reveal', j.result.file)
      show('library')            // land somewhere sensible instead of the spent editor
    }
    if (j.status === 'error') {
      jobs.delete(cid); ov.close(); $('doExport').disabled = false
      toast(j.message, 'bad', 7000)
    }
    if (j.status === 'cancelled') { jobs.delete(cid); ov.close(); $('doExport').disabled = false }
  })
  return ipcRenderer.invoke('edit-job', { op: 'export', src: ed.src, opts, cid, jobId })
}
