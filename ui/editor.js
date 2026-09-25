/* Fetch editor. Stage, timeline and inspector, all driven by processor.js. */

// Every value this file shows (times, lengths, sizes, multipliers, percents) is written
// by the one formatter, ui/fmt.js, so the editor says "1.0x" and "0:08 out" the way
// Look, chat and Activity do. A classic script shares one global scope with the others,
// so this sets window.Fmt rather than declaring a name another file may also declare.
if (!window.Fmt) window.Fmt = require('./ui/fmt')

// Text alignment glyphs: three rules of text set left, centred and right. The sprite
// has no alignment icons, and three copies of the same "T" squeezed sideways told the
// buttons apart by their fill alone (J3). Drawn on Phosphor's 256 grid and stroke so
// they sit beside the sprite's icons.
function alignIco(side) {
  const rows = [[40, 216], side === 'left' ? [40, 168] : side === 'right' ? [88, 216] : [64, 192],
    [40, 216], side === 'left' ? [40, 168] : side === 'right' ? [88, 216] : [64, 192]]
  // filled bars rather than stroked lines: the icon classes set stroke:none, fill:currentColor
  return `<svg class="icon-sm" viewBox="0 0 256 256" aria-hidden="true">${rows.map(([a, b], i) =>
    `<rect x="${a - 8}" y="${56 + i * 40}" width="${b - a + 16}" height="16" rx="8"/>`).join('')}</svg>`
}

const ed = {
  src: null, meta: null, dur: 0,
  in: 0, out: 0, cur: 0,
  peaks: [], cues: [], texts: [], selText: null,
  capStyle: { font: 'SF Pro', scale: 1, colour: '#FFFFFF', position: 'bottom', boxed: true, highlight: 'word' },
  crop: null, cropAR: 'free',
  cuts: [], cutMode: false,
  beats: [],          // named spans from the transcript, see processor.buildBeats
  zooms: [],          // explicit zooms by id (Z1, Z2): {id, start, end, scale, x, y}
  marks: [],          // redactions, spotlights, steps by id (M1): {id, kind, start, end, x, y, w, h}
  audioTrack: null,   // {file, name, volume, offset, replace, peaks}
  cam: null,          // camera take: {file, x, y, size, ...} when one was recorded
  tab: 'trim',
  lasso: false,       // the lasso armed, so a drag on the stage points Biscuit at an area
  sel: null,          // the zoom or mark being edited by hand: {kind:'zoom'|'mark', id}
  shot: false,        // a take of one frame: same editor, same stage, no clock
  view: 'styled',     // 'original' steps the compositor aside and shows the raw capture
}

// ── a shot is a take of one frame ───────────────────────────────────────
// A capture is opened by the editor that is already here. The only thing it does not
// have is a clock, so the timeline goes, the transport stops being a transport, and
// the tabs that are about time step aside. Nothing else changes, and nothing else
// draws: the stage is the same compositor the export is.
//
// The clock it is lent is ui/shot.js's, not one of this file's own. Everything Fetch
// draws arrives and leaves (PASSES.md, Overlays.fadeLevel), so a mark asked for at the
// instant it starts is drawn half arrived. Shot.SPAN is the span every mark takes and
// Shot.HOLD is the one instant anyone draws, where nothing is arriving and nothing is
// leaving. render-host.renderShot draws the same instant of the same plan, so the
// stage is the PNG.
const ShotLib = require('./ui/shot')
// the rate render-host draws a shot at (SHOT_FPS), named here so the stage plans on
// the same grid without reaching into the main process for a constant
const SHOT_FPS = 30
const shotTime = () => ShotLib.HOLD
// what opens as a shot: the library's own idea of a still (ui/app.js isStill), so an
// item the library shows as a shot never opens as a take
const isShotFile = p => isStill(p)

// The document the editor is driving, and where it is kept. An edit for a take, a
// shot for a capture: the autosave, the undo history and the agent's way in all go
// through these, so there is one of each rather than two of everything.
const liveDoc = () => (ed.shot ? window.fetchShot : window.fetchDoc)
const docRead = () => (ed.shot ? 'read-shot' : 'read-doc')
const docWrite = () => (ed.shot ? 'write-shot' : 'write-doc')

// The element holding the source pixels, and the moment being drawn. A take answers
// with its <video> and the playhead, a shot with its <img> and the middle of its span.
// Every layer on the stage is laid out against the first and drawn at the second, so
// these two are the only place the difference lives.
const srcEl = () => (ed.shot ? $('edStill') : null) || $('edVideo')
const srcSize = el2 => (ed.shot
  ? { w: (el2 && el2.naturalWidth) || 0, h: (el2 && el2.naturalHeight) || 0 }
  : { w: (el2 && el2.videoWidth) || 0, h: (el2 && el2.videoHeight) || 0 })
const srcTime = () => (ed.shot ? shotTime() : ($('edVideo') || {}).currentTime || 0)

const EDITOR_HTML = `
<div class="ed">
  <div class="ed-main">
  <div class="ed-stage">
    <div class="ed-canvas" id="edCanvas">
      <div class="stage-frame" id="stageFrame" data-bd="none">
        <video id="edVideo" preload="auto"></video>
        <img id="edStill" alt="" hidden>
        <canvas class="stage-gl" id="stageGL" aria-hidden="true"></canvas>
        <div class="cap-overlay" id="capOverlay"><span></span></div>
        <video class="cam-bubble" id="camBubble" muted playsinline hidden></video>
      </div>
      <div id="cropBox" hidden><i class="h nw"></i><i class="h ne"></i><i class="h sw"></i><i class="h se"></i></div>
      <!-- inside the stage's own box, so it sits on the frame's top, right and bottom edges
           rather than 8px in from them with the picture showing round it (E4) -->
      <aside class="ver-panel" id="verPanel" aria-label="Version history" hidden>
        <header class="ver-head"><span class="ver-title">History</span><span class="ver-sub" id="verCount"></span>
          <button class="pc ver-x" data-ver-close aria-label="Close history">${ico('x', 'icon-sm')}</button></header>
        <ol class="ver-list" id="verList"></ol>
      </aside>
    </div>
    <div class="ed-transport">
      <button class="pc" id="edBack" data-tip="Back 5s">${ico('skip-back', 'icon-sm')}</button>
      <button class="pc main" id="edPlay">${ico('play-fill', 'icon')}</button>
      <button class="pc" id="edFwd" data-tip="Forward 5s">${ico('skip-forward', 'icon-sm')}</button>
      <span class="time mono" id="edTime">0:00 / 0:00</span>
      <!-- a shot has no clock, so the transport carries the one thing worth flipping -->
      <div class="seg seg-sm ed-view" id="edView" hidden>
        <button data-view="styled" aria-selected="true" data-tip="The shot as it will be written">
          ${ico('sparkle', 'icon-sm')} Styled</button>
        <button data-view="original" aria-selected="false" data-tip="The raw capture. Hold Space to peek.">
          ${ico('image', 'icon-sm')} Original</button>
      </div>
      <span class="ed-name" id="edName"></span>
      <span class="chip chip-static mono" id="edOutLen">0:00 out</span>
      <span class="chip chip-static mono" id="edSize" hidden>0 x 0</span>
      <button class="pc" id="edUndo" data-tip="Undo (⌘Z)" aria-label="Undo" disabled>${ico('arrow-counter-clockwise', 'icon-sm')}</button>
      <button class="pc" id="edRedo" data-tip="Redo (⇧⌘Z)" aria-label="Redo" disabled>${ico('arrow-clockwise', 'icon-sm')}</button>
      <button class="btn btn-sm btn-ghost ed-versions" id="edVersions" aria-pressed="false" aria-controls="verPanel"
        data-tip="Every version of this edit, and who made it (⌘Y)">${ico('clock', 'icon-sm')}<span class="ed-lbl">History</span><span class="ver-count mono"></span></button>
      <button class="btn btn-sm btn-ghost ed-undo-agent" id="edUndoAgent" hidden
        data-tip="Put the edit back how it was before Biscuit changed it">${ico('arrow-counter-clockwise', 'icon-sm')}<span class="ed-lbl">Undo Biscuit's change</span></button>
      <button class="pc ed-lasso" id="edLasso" aria-pressed="false" aria-label="Lasso an area for Biscuit"
        data-tip="Lasso an area for Biscuit">${ico('selection', 'icon-sm')}</button>
      <button class="btn btn-sm ed-ask" id="edAsk" aria-pressed="false" data-tip="Ask for an edit in plain words">
        <img class="ed-ask-dog" src="./assets/mascot/idle.png" alt=""><span class="ed-lbl">Ask Biscuit</span><kbd class="ed-kbd mono">⌘J</kbd></button>
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
    <div class="tl-beats" id="tlBeats" hidden></div>
    <div class="tl-zooms" id="tlZooms" hidden></div>
    <div class="tl-marks" id="tlMarks" hidden></div>
    <div class="tl-texts" id="tlTexts" hidden></div>
    <div class="tl-wrap" id="tlWrap">
      <div class="tl-lanes">
        <div class="tl-lane tl-lane-video" id="laneVideo">
          <span class="lane-tag">${ico('film-strip', 'icon-xs')} Video</span>
          <img id="strip" alt="">
        </div>
        <div class="tl-lane tl-lane-audio" id="laneAudio">
          <span class="lane-tag">${ico('waveform', 'icon-xs')} Recording audio</span>
          <canvas id="wave"></canvas>
        </div>
        <div class="tl-lane tl-lane-extra" id="laneExtra" hidden>
          <span class="lane-tag" id="extraTag">${ico('speaker-high', 'icon-xs')} Added audio</span>
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
    <div class="insp-tabs"><div class="seg seg-nav insp-seg" id="inspTabs" role="tablist" aria-label="Edit">
      <button data-tab="trim"     aria-selected="true"  data-tip="Trim">${ico('scissors', 'icon-sm')}</button>
      <button data-tab="crop"     aria-selected="false" data-tip="Crop">${ico('crop', 'icon-sm')}</button>
      <button data-tab="focus"    aria-selected="false" data-tip="Zooms and marks">${ico('magnifying-glass', 'icon-sm')}</button>
      <button data-tab="text"     aria-selected="false" data-tip="Text">${ico('text-t', 'icon-sm')}</button>
      <button data-tab="captions" aria-selected="false" data-tip="Captions">${ico('closed-captioning', 'icon-sm')}</button>
      <button data-tab="look"     aria-selected="false" data-tip="Look">${ico('sparkle', 'icon-sm')}</button>
      <button data-tab="camera"   aria-selected="false" data-tip="Camera" id="camTabBtn" hidden>${ico('video-camera', 'icon-sm')}</button>
      <button data-tab="audio"    aria-selected="false" data-tip="Audio">${ico('waveform', 'icon-sm')}</button>
      <button data-tab="voice"    aria-selected="false" data-tip="Voiceover">${ico('speaker-simple-high', 'icon-sm')}</button>
    </div></div>

    <div class="insp-body">
      <!-- TRIM -->
      <section class="insp-panel" data-panel="trim">
        <div><div class="insp-sec">Range</div>
          <div class="row"><span class="row-lbl">Start</span><span class="mono dim" id="trimIn">0:00</span>
            <div style="flex:1"></div><button class="btn btn-sm" id="setIn">Set to playhead</button></div>
          <div class="row"><span class="row-lbl">End</span><span class="mono dim" id="trimOut">0:00</span>
            <div style="flex:1"></div><button class="btn btn-sm" id="setOut">Set to playhead</button></div>
          <button class="btn btn-sm btn-ghost insp-after" id="trimReset">Reset to full clip</button>
        </div>
        <div><div class="insp-sec">Tool</div>
          <div class="seg" id="toolSwitch" style="width:100%">
            <button data-tool="select" aria-selected="true" style="flex:1">
              ${ico('cursor', 'icon-sm')} Select</button>
            <button data-tool="cut" aria-selected="false" style="flex:1">
              ${ico('scissors', 'icon-sm')} Cut</button>
          </div>
          <p class="micro dimmer insp-hint" id="cutHint">
            Turn it on, then drag across the timeline to remove a section.</p>
          <div class="cut-list" id="cutList"></div>
        </div>

        <div><div class="insp-sec">Clean up</div>
          <button class="btn btn-sm btn-block" id="doSilence">
            ${ico('magic-wand', 'icon-sm')} Remove dead air</button>
          <p class="micro dimmer insp-hint">Finds silent gaps and removes them for you.</p>
        </div>
      </section>

      <!-- CROP -->
      <section class="insp-panel" data-panel="crop" hidden>
        <div><div class="insp-sec">Aspect</div>
          <!-- filled by renderAspects, from the same list the look's Shape field uses -->
          <div class="chips aspect-chips" id="arChips"></div>
        </div>
        <div><div class="insp-sec">Frame</div>
          <button class="btn btn-sm btn-block" id="cropOn">${ico('crop', 'icon-sm')} Enable crop</button>
          <button class="btn btn-sm btn-ghost btn-block insp-after" id="cropReset">Reset</button>
        </div>
      </section>

      <!-- ZOOMS AND MARKS: the hand editing of what an agent can already place -->
      <section class="insp-panel" data-panel="focus" hidden>
        <div id="focusZooms"><div class="insp-sec">Zooms</div>
          <div class="obj-list" id="zoomList"></div>
          <button class="btn btn-sm btn-block" id="addZoom">
            ${ico('plus', 'icon-sm')} Zoom at the playhead</button>
        </div>

        <div><div class="insp-sec">Marks</div>
          <div class="chips mark-add" id="markAdd">
            <button class="chip" data-kind="redact" data-tip="Destroys the area, for anything private">Redact</button>
            <button class="chip" data-kind="blur" data-tip="Softens the area, never for secrets">Blur</button>
            <button class="chip" data-kind="lift" data-tip="Raises the element off the page">Lift</button>
            <button class="chip" data-kind="spotlight" data-tip="Dims everything but the area">Spotlight</button>
            <button class="chip" data-kind="step" data-tip="A numbered gold badge">Step</button>
            <button class="chip" data-kind="loupe" data-tip="A magnified inset of a small area">Loupe</button>
            <button class="chip" data-kind="arrow" data-tip="Points at the thing from outside it">Arrow</button>
          </div>
          <p class="micro dimmer insp-hint" id="markHint">Added at the playhead. Drag it on the stage onto the thing it is for.</p>
          <div class="obj-list" id="markList"></div>
        </div>

        <div id="objEdit" hidden>
          <div class="insp-sec"><span class="mono obj-sel-id" id="objId"></span><span id="objWhat"></span></div>
          <div id="objTiming">
          <div class="row"><span class="row-lbl">Start</span><span class="mono dim" id="objStart">0:00</span>
            <div style="flex:1"></div><button class="btn btn-sm" id="objSetIn">Set to playhead</button></div>
          <div class="row"><span class="row-lbl">End</span><span class="mono dim" id="objEnd">0:00</span>
            <div style="flex:1"></div><button class="btn btn-sm" id="objSetOut">Set to playhead</button></div>
          </div>
          <div class="row" id="objScaleRow" hidden><span class="row-lbl">Scale</span>
            <input type="range" class="slider" id="objScale" min="100" max="300" value="180">
            <span class="row-val mono" id="objScaleVal">1.8x</span></div>
          <div class="row" id="objStrengthRow" hidden><span class="row-lbl">Strength</span>
            <input type="range" class="slider" id="objStrength" min="4" max="60" value="18">
            <span class="row-val mono" id="objStrengthVal">25%</span></div>
          <div class="row" id="objNumRow" hidden><span class="row-lbl">Number</span>
            <input class="input input-sm obj-num" id="objNum" maxlength="3" placeholder="In order"></div>
          <p class="micro dimmer" id="objHint"></p>
          <button class="btn btn-sm btn-danger btn-block insp-after" id="objDel">
            ${ico('trash', 'icon-sm')} Remove</button>
        </div>
      </section>

      <!-- TEXT -->
      <section class="insp-panel" data-panel="text" hidden>
        <div><div class="insp-sec-row">
          <div class="insp-sec">Layers</div>
          <button class="btn btn-sm" id="addText">${ico('plus', 'icon-sm')} Add</button>
        </div>
        <div class="layer-list" id="layerList"></div></div>
        <div id="textProps" hidden>
          <div class="insp-sec">Selected</div>
          <textarea class="input" id="txtValue" rows="2" placeholder="Type something…"></textarea>
          <div class="row insp-after"><span class="row-lbl">Size</span>
            <input type="range" class="slider" id="txtSize" min="2" max="16" value="6">
            <span class="row-val mono" id="txtSizeVal">6%</span></div>
          <div class="row"><span class="row-lbl">Font</span>
            <div class="dd" id="txtFont"></div></div>
          <div class="row"><span class="row-lbl">Align</span>
            <div class="seg seg-sm" id="txtAlign">
              <button data-align="left" aria-selected="false" aria-label="Align left" data-tip="Left">${alignIco('left')}</button>
              <button data-align="center" aria-selected="true" aria-label="Align centre" data-tip="Centre">${alignIco('center')}</button>
              <button data-align="right" aria-selected="false" aria-label="Align right" data-tip="Right">${alignIco('right')}</button>
            </div></div>
          <div class="row"><span class="row-lbl">Colour</span>
            <div class="swatches" id="txtSwatches"></div>
            <label class="colour-well" data-tip="Any colour">
              <input type="color" id="txtColor" value="#FFFFFF"><span></span>
            </label></div>
          <label class="opt opt-tight"><span class="opt-txt"><span class="opt-title">Background pill</span></span>
            <span class="switch"><input type="checkbox" id="txtBox"><span class="track"></span></span></label>
          <div id="txtTiming">
          <!-- the two buttons share the row: beside a "Timing" label they ran past the
               panel's edge, and the line under them already says what they set -->
          <div class="row insp-pair" role="group" aria-label="Timing">
            <button class="btn btn-sm" id="txtFrom">From playhead</button>
            <button class="btn btn-sm" id="txtTo">To playhead</button></div>
          <p class="micro dimmer" id="txtRange">Shows for the whole clip</p>
          </div>
          <button class="btn btn-sm btn-danger btn-block insp-after" id="txtDel">
            ${ico('trash', 'icon-sm')} Remove</button>
        </div>
      </section>

      <!-- CAPTIONS -->
      <section class="insp-panel" data-panel="captions" hidden>
        <div class="insp-sec-row">
          <div class="insp-sec">Transcript</div>
          <button class="btn btn-sm" id="doTranscribe">${ico('sparkle', 'icon-sm')} Transcribe</button>
        </div>
        <div class="work" id="trProg" hidden>
          ${motion('thinking', 'thinking', 'work-dog')}
          <div class="work-body">
            <div class="work-label">Listening to your recording</div>
            <div class="bar indeterminate"><i></i></div>
          </div>
        </div>
        <label class="opt opt-tight"><span class="opt-txt">
          <span class="opt-title" data-schema-label="captions.show">Burn into video</span><span class="opt-sub" data-schema-sub="captions.show">Baked in, plays anywhere</span></span>
          <span class="switch"><input type="checkbox" id="burnCaps"><span class="track"></span></span></label>

        <div id="capStyle">
          <div class="insp-sec">Caption style</div>
          <div class="row"><span class="row-lbl">Font</span><div class="dd" id="capFont"></div></div>
          <div class="row"><span class="row-lbl">Size</span>
            <input type="range" class="slider" id="capSize" min="60" max="180" value="100">
            <span class="row-val mono" id="capSizeVal">1.0x</span></div>
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
          <div class="row"><span class="row-lbl">Spoken word</span>
            <div class="seg seg-sm" id="capHl" aria-label="Spoken word">
              <button data-hl="word" aria-selected="true">Gold</button>
              <button data-hl="pill" aria-selected="false">Pill</button>
              <button data-hl="none" aria-selected="false">Off</button>
            </div></div>
        </div>

        <div class="cue-list" id="cueList"></div>
      </section>

      <!-- LOOK: generated from the Look spec (ui/inspector.js) -->
      <section class="insp-panel" data-panel="look" hidden>
        <div class="lk" id="lookInspector"></div>
      </section>

      <!-- CAMERA -->
      <section class="insp-panel" data-panel="camera" hidden>
        <div class="insp-sec">Camera bubble</div>
        <p class="insp-lede">
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
        <label class="opt opt-tight"><span class="opt-txt">
          <span class="opt-title">Show camera</span><span class="opt-sub">Off leaves just the screen</span></span>
          <span class="switch"><input type="checkbox" id="camOn" checked><span class="track"></span></span></label>
      </section>

      <section class="insp-panel" data-panel="voice" hidden>
        <div class="vo-off" id="voOff">
          <div class="insp-sec">Voiceover</div>
          <p class="vo-lede">Speak your script in a studio voice over the same footage,
            using your own ElevenLabs account.</p>
          <form class="vo-connect" id="voConnectForm">
            <input class="input input-sm" type="password" id="voKey" placeholder="ElevenLabs API key"
              autocomplete="off" spellcheck="false">
            <button class="btn btn-sm btn-primary" type="submit" id="voConnectBtn" disabled>Connect</button>
          </form>
          <p class="vo-note">${ico('info', 'icon-sm')}<span>Two things in Fetch use the internet,
            and each says so where it is used: this one sends your script to ElevenLabs to be
            spoken, and the backdrop picker sends your search words to Unsplash. Your recording,
            your audio and your filenames are not sent anywhere.</span></p>
        </div>

        <div class="vo-on" id="voOn" hidden>
          <div class="insp-sec">Voice</div>
          <div class="vo-voices" id="voVoices"></div>

          <div class="insp-sec">Script</div>
          <textarea class="vo-script" id="voScript" rows="5"
            placeholder="What should be said over this take"></textarea>
          <div class="vo-script-foot">
            <button class="btn btn-sm btn-ghost" id="voFromCues">Use my transcript</button>
            <span class="vo-count" id="voCount"><span class="mono">0</span> characters</span>
          </div>

          <div class="insp-sec">Delivery</div>
          <div class="row"><span class="row-lbl">Stability</span>
            <input type="range" class="slider" id="voStability" min="0" max="100" value="50">
            <span class="row-val mono" id="voStabilityVal">50%</span></div>
          <div class="row"><span class="row-lbl">Similarity</span>
            <input type="range" class="slider" id="voSimilarity" min="0" max="100" value="75">
            <span class="row-val mono" id="voSimilarityVal">75%</span></div>
          <div class="row"><span class="row-lbl">Speed</span>
            <input type="range" class="slider" id="voSpeed" min="70" max="120" value="100">
            <span class="row-val mono" id="voSpeedVal">1.0x</span></div>

          <button class="btn btn-sm btn-block vo-go" id="voGenerate">
            ${ico('sparkle', 'icon-sm')} Generate voiceover</button>
          <div class="work" id="voProg" hidden>
            ${motion('thinking', 'thinking', 'work-dog')}
            <div class="work-body">
              <div class="work-label">Speaking your script</div>
              <div class="bar indeterminate"><i></i></div>
            </div>
          </div>
          <p class="vo-note"><span id="voUsage"></span></p>
        </div>
      </section>

      <section class="insp-panel" data-panel="audio" hidden>
        <div class="insp-sec">Sound</div>
        <label class="opt opt-tight"><span class="opt-txt">
          <span class="opt-title">Denoise</span><span class="opt-sub">Removes hiss and hum</span></span>
          <span class="switch"><input type="checkbox" id="denoise"><span class="track"></span></span></label>
        <label class="opt opt-tight"><span class="opt-txt">
          <span class="opt-title">Normalise loudness</span><span class="opt-sub">Even levels throughout</span></span>
          <span class="switch"><input type="checkbox" id="loudnorm" checked><span class="track"></span></span></label>
        <div class="row"><span class="row-lbl">Gain</span>
          <input type="range" class="slider" id="gain" min="-10" max="10" value="0">
          <span class="row-val mono" id="gainVal">0dB</span></div>
        <div class="row"><span class="row-lbl">Music</span>
          <div class="seg seg-sm" id="musicBed">
            <button data-bed="" aria-selected="true">None</button>
            <button data-bed="warm" aria-selected="false">Warm</button>
            <button data-bed="bright" aria-selected="false">Bright</button>
            <button data-bed="calm" aria-selected="false">Calm</button>
          </div></div>
        <div id="extraPanel" hidden>
          <div class="insp-sec">Added track</div>
          <div class="extra-file"><span class="mono" id="extraName">none</span></div>
          <div class="row"><span class="row-lbl">Level</span>
            <input type="range" class="slider" id="extraVol" min="0" max="150" value="60">
            <span class="row-val mono" id="extraVolVal">60%</span></div>
          <div class="row"><span class="row-lbl">Start at</span>
            <input type="range" class="slider" id="extraOff" min="0" max="200" value="0">
            <span class="row-val mono" id="extraOffVal">0s</span></div>
          <label class="opt opt-tight"><span class="opt-txt">
            <span class="opt-title">Replace original audio</span>
            <span class="opt-sub">Off mixes the two together</span></span>
            <span class="switch"><input type="checkbox" id="extraReplace"><span class="track"></span></span></label>
          <button class="btn btn-sm btn-block insp-after" id="transcribeExtra">
            ${ico('sparkle', 'icon-sm')} Transcribe this track instead</button>
        </div>

        <p class="micro dimmer">Fades in and out are in Look, under Motion: they take the picture and the sound together.</p>
      </section>
    </div>

    <div class="insp-foot">
      <div class="work" id="expBar" hidden>
        ${motion('exporting', 'running', 'work-dog')}
        <div class="work-body">
          <div class="work-label">Fetching your video</div>
          <div class="bar"><i></i></div>
        </div>
      </div>
      <button class="btn btn-primary btn-block" id="doExport">
        ${ico('export', 'icon-sm')} Export</button>
    </div>
  </aside>

</div>`

// ── open ────────────────────────────────────────────────────────────────
// The chat pane reads this to know which recording you are looking at, so a question
// like "transcribe this" has something to point at.
window.ed = ed

// ── agent edits: seen, and reversible ───────────────────────────────────
// An agent's change lights up where it landed for a moment, so the person watching
// sees what moved without diffing the timeline in their head, and every change can
// be put back. Snapshots are whole documents, which are small, and live in memory.
const EditAssist = require('./ui/edit-assist')
const agentUndo = EditAssist.createUndo()

let agentFlashTimer = null
function flashAgentChange(c) {
  if (!c || !EditAssist.anyChange(c)) return
  const hit = []
  const q = sel => document.querySelectorAll(sel).forEach(n => hit.push(n))
  const at = id => `[data-id="${CSS.escape(String(id))}"]`
  c.zooms.forEach(id => q('.tl-zoom' + at(id)))
  c.marks.forEach(id => q('.tl-mark' + at(id)))
  c.texts.forEach(id => { const i = ed.texts.findIndex(t => t.id === id); if (i >= 0) q(`.tl-text[data-i="${i}"]`) })
  c.cues.slice(0, 80).forEach(i => q(`#cueList .cue[data-i="${i}"]`))
  if (c.cues.length) q('#inspTabs [data-tab="captions"]')
  if (c.clips) q('#tlRegion')
  if (c.frame) q('#stageFrame')
  // restart the animation on a row that was already lit by the previous pass
  for (const n of hit) { n.classList.remove('agent-flash'); void n.offsetWidth; n.classList.add('agent-flash') }
  clearTimeout(agentFlashTimer)
  agentFlashTimer = setTimeout(() => document.querySelectorAll('.agent-flash').forEach(n => n.classList.remove('agent-flash')), 1200)
}

function paintAgentUndo() {
  const b = $('edUndoAgent'); if (!b) return
  const n = ed.src ? agentUndo.size(ed.src) : 0
  b.hidden = !n
  b.setAttribute('data-tip', n > 1
    ? `Put the edit back how it was before Biscuit's last change. ${n} changes can be undone.`
    : 'Put the edit back how it was before Biscuit changed it')
}

function paintAskState() {
  const b = $('edAsk'), pane = document.getElementById('chatPane')
  if (b) b.setAttribute('aria-pressed', String(!!(pane && !pane.hidden)))
}
window.addEventListener('fetch:chat-toggle', paintAskState)

function wireAssist() {
  if ($('edAsk')) $('edAsk').onclick = () => { if (window.toggleChat) window.toggleChat() }
  if ($('edUndoAgent')) $('edUndoAgent').onclick = () => undoAgentEdit()
  if ($('edUndo')) $('edUndo').onclick = () => historyStep(-1)
  if ($('edRedo')) $('edRedo').onclick = () => historyStep(1)
  wireVersions()
  paintAskState(); paintAgentUndo()
}

// Restores the document from before the agent's last burst of changes and saves it.
// A take that is not open is opened first, since the edit lives in the editor.
async function undoAgentEdit(src, level) {
  src = src || ed.src
  const top = () => agentUndo.peek(src)
  // a card names the change it made; if a later one is on top, that card is stale
  if (!src || !top() || (level && top().n !== level)) return false
  if (ed.src !== src || !ed.docReady) await openInEditor(src)
  if (ed.src !== src || !liveDoc() || !top() || (level && top().n !== level)) return false
  const entry = agentUndo.pop(src)
  agentUndo.mark()                     // whatever comes next is a change of its own
  const was = liveDoc().get()
  // The agent's change goes back; anything the person changed since stays, and the id
  // counter does not rewind, or "Z3" in the activity log would name two zooms.
  const { doc: back, kept } = EditAssist.revert(entry.before, entry.after, was)
  liveDoc().load(back)
  const now = liveDoc().get()
  // captions burn from the .srt, so the wording has to go back there as well
  if (!ed.shot && JSON.stringify(was.cues) !== JSON.stringify(now.cues)) {
    await ipcRenderer.invoke('write-cues', src, ed.cues).catch(() => {})
    renderCues(); paintCaption()
  }
  await ipcRenderer.invoke(docWrite(), src, now).catch(() => {})
  flashAgentChange(EditAssist.changedIds(was, now))
  paintAgentUndo()
  window.dispatchEvent(new CustomEvent('fetch:agent-edit', { detail: { src, undo: true, by: null } }))
  toast(escHtml(EditAssist.undoSummary(was, now)) + (kept.length ? ', and kept your own edits since' : ''), 'ok', 5200)
  return true
}
window.fetchUndo = {
  undo: undoAgentEdit,
  size: src => agentUndo.size(src || ed.src),
  // which level is on top, so a chat card only offers to undo its own change
  level: src => { const e = agentUndo.peek(src || ed.src); return e ? e.n : 0 },
  mark: () => agentUndo.mark(),        // a new chat turn starts a new undo level
}

async function openInEditor(src) {
  if (isShotFile(src)) return openShot(src)
  document.querySelector('#nav [data-view="editor"]').disabled = false
  show('editor')
  const mount = $('editorMount')
  mount.className = ''
  mount.innerHTML = EDITOR_HTML
  ed.shot = false; ed.view = 'styled'

  ed.src = src; ed.texts = []; ed.cues = []; ed.crop = null; ed.selText = null; ed.peaks = []
  ed.sel = null                                  // nothing on the two tracks is selected in a fresh take
  ed.doc = null; ed.look = LookLib.defaults(); syncLookMirrors()   // never the last clip's look
  window.dispatchEvent(new CustomEvent('fetch:editor-open', { detail: { src } }))   // the chat's "Working on" chip
  ed.docReady = false
  wireEditor()
  wireAssist()
  paintEdName()

  const v = $('edVideo')
  // a take named from a window title can hold # or %, which a bare file:// URL misreads
  v.src = 'file://' + encodeURI(src).replace(/#/g, '%23').replace(/\?/g, '%3F')
  armStageGL(v)
  ed.meta = await ipcRenderer.invoke('probe', src)

  // MediaRecorder webm has no duration header, so seek past the end to force one
  const ready = () => new Promise(res => {
    let settled = false
    // A listener of its own, not v.ontimeupdate: wireEditor() already installed the
    // real handler there, and clearing it here left the playhead frozen during playback.
    const onTime = () => { if (isFinite(v.duration) && v.duration > 0) { v.currentTime = 0; done() } }
    const done = () => { if (settled) return; settled = true; v.removeEventListener('timeupdate', onTime); res() }
    const onMeta = () => {
      if (isFinite(v.duration) && v.duration > 0) return done()
      v.currentTime = 1e7                       // webm has no duration until we seek past the end
      v.addEventListener('timeupdate', onTime)
    }
    v.addEventListener('loadedmetadata', onMeta)
    if (v.readyState >= 1) onMeta()             // it may have loaded before we attached
    setTimeout(done, 6000)                      // never hang the editor on a bad file
  })
  await ready()

  ed.dur = ed.meta.duration || v.duration || 0
  ed.in = 0; ed.out = ed.dur; ed.cur = 0
  // a silent take has no sound to show, so an empty "Recording audio" lane only misleads
  $('laneAudio').hidden = !ed.meta.hasAudio
  paintTrim(); drawWave(); layoutTimeline(); paintTime(); paintPlayhead(); paintBackdrop()
  loadBeats()

  loadCamTake(src)
  ed.cues = await ipcRenderer.invoke('read-cues', src)
  // If a clip has a transcript, the person wants the captions in the file. Leaving
  // this off by default meant exports silently came out with no captions at all.
  if ($('burnCaps')) $('burnCaps').checked = ed.cues.length > 0
  renderCues(); paintCaption(); dragCaption()

  // The saved edit. The editor used to open every clip blank and never read this,
  // so an edit lived only as long as the window: after a restart the first read of
  // the clip returned the blank state and wrote it over the saved one.
  let saved = null
  try { saved = await ipcRenderer.invoke('read-doc', src, ed.dur) } catch {}
  if (ed.src !== src) return                 // another clip was opened meanwhile
  if (saved && window.fetchDoc) {
    const srtCues = ed.cues
    window.fetchDoc.load(saved)
    // the .srt is what caption edits write to, so it wins when it has anything
    if (srtCues.length) { ed.cues = srtCues; renderCues(); paintCaption() }
  }
  ed.docReady = true
  startDocAutosave(src)
  ed.windowCorner = 0; ed.gutter = null
  // the window's own margin and corner, which the export trims and rounds to (the stage's
  // canvas draws the same), measured once
  ipcRenderer.invoke('frame-gutter', src, ed.dur, ed.crop).then(g => {
    if (ed.src !== src) return
    ed.gutter = g || null; ed.windowCorner = (g && +g.corner) || 0; paintBackdrop()
  }).catch(() => {})
  ipcRenderer.send('render-warm')
  // the chat's edit suggestions are picked from the saved edit, which only exists now
  window.dispatchEvent(new CustomEvent('fetch:editor-ready', { detail: { src } }))

  runJob({ op: 'waveform', src, opts: { buckets: 1200 } }, 'Waveform').then(r => {
    if (r && r.peaks) { ed.peaks = r.peaks; drawWave() }
  })
  runJob({ op: 'filmstrip', src, opts: { count: 28, height: 64 } }, 'Filmstrip').then(r => {
    const img = $('strip')
    if (r && r.file && img) img.src = 'file://' + encodeURI(r.file).replace(/#/g, '%23').replace(/\?/g, '%3F') + '?t=' + Date.now()
  })
}

// The same editor, opened on a capture. Everything that needs a clock is skipped
// rather than branched around: no probe, no waveform, no filmstrip, no transcript,
// no beats, no camera. What is left is the stage, the inspector and the lasso, which
// is all a shot has ever needed.
async function openShot(src) {
  document.querySelector('#nav [data-view="editor"]').disabled = false
  show('editor')
  const mount = $('editorMount')
  mount.className = ''
  mount.innerHTML = EDITOR_HTML
  ed.shot = true; ed.view = 'styled'

  ed.src = src; ed.texts = []; ed.cues = []; ed.crop = null; ed.selText = null; ed.peaks = []
  ed.sel = null; ed.cam = null; ed.audioTrack = null; ed.cuts = []; ed.beats = []
  ed.meta = null
  ed.doc = null; ed.look = LookLib.defaults(); syncLookMirrors()
  window.dispatchEvent(new CustomEvent('fetch:editor-open', { detail: { src } }))
  ed.docReady = false
  wireEditor()
  wireAssist()
  paintEdName()
  applyShotMode()

  // the one frame, in the middle of the span it is lent, where everything has landed
  ed.dur = ShotLib.SPAN; ed.in = 0; ed.out = ShotLib.SPAN; ed.cur = shotTime()

  const img = $('edStill')
  const url = 'file://' + encodeURI(src).replace(/#/g, '%23').replace(/\?/g, '%3F')
  const loaded = new Promise(done => {
    img.onload = done
    img.onerror = done                          // a capture that will not decode still opens, empty
  })
  img.hidden = false
  img.src = url
  armStageStill(img)
  await loaded
  if (ed.src !== src) return                    // another item was opened meanwhile
  ed.meta = { width: img.naturalWidth, height: img.naturalHeight, duration: ShotLib.SPAN, fps: 30, hasAudio: false }
  paintShotSize()

  // The shot as it was last left. A capture with no document yet is a blank shot of
  // the right size, which is what the editor opens on the first time.
  let saved = null
  try { saved = await ipcRenderer.invoke('read-shot', src, { w: img.naturalWidth, h: img.naturalHeight }) } catch {}
  if (ed.src !== src) return
  window.fetchShot.load(saved || ShotLib.emptyShot(src, { w: img.naturalWidth, h: img.naturalHeight }))
  ed.docReady = true
  startDocAutosave(src)
  ed.windowCorner = 0; ed.gutter = null
  // a capture of a window carries the same rounded corner a recording of one does, and
  // the same pass measures it
  ipcRenderer.invoke('frame-gutter', src, ed.dur, ed.crop).then(g => {
    if (ed.src !== src) return
    ed.gutter = g || null; ed.windowCorner = (g && +g.corner) || 0; paintBackdrop()
  }).catch(() => {})
  ipcRenderer.send('render-warm')
  paintBackdrop(); paintTime(); paintStageGL({ fresh: true, upload: true })
  window.dispatchEvent(new CustomEvent('fetch:editor-ready', { detail: { src } }))
}

// What the editor is when there is nothing to scrub. One function, so the difference
// between a take and a shot is readable in one place rather than spread over every
// control.
function applyShotMode() {
  const root = document.querySelector('.ed')
  if (root) root.dataset.mode = ed.shot ? 'shot' : 'take'
  if (!ed.shot) return
  // the transport keeps its shape: the play cluster becomes the Styled and Original
  // switch, the running time becomes the size of the file that comes out
  $('edView').hidden = false
  $('edSize').hidden = false
  $('edOutLen').hidden = true
  $('edView').onclick = e => {
    const b = e.target.closest('button[data-view]')
    if (b) setShotView(b.dataset.view)
  }
  // the tabs that are about time, sound, speech or a second camera have nothing to
  // say here. Text goes too: a shot document has no text layers to keep (ui/shot.js).
  for (const t of ['trim', 'text', 'captions', 'audio', 'voice', 'camera']) {
    const b = document.querySelector(`#inspTabs button[data-tab="${t}"]`)
    if (b) b.hidden = true
  }
  // a still opens on Look, because the style is the whole point of styling a capture
  const look = document.querySelector('#inspTabs button[data-tab="look"]')
  if (look) look.click()
  // a zoom is a move, and a move needs two moments. Framing a still is the Crop tab.
  const zooms = $('focusZooms'); if (zooms) zooms.hidden = true
  const timing = $('objTiming'); if (timing) timing.hidden = true
  const txtTiming = $('txtTiming'); if (txtTiming) txtTiming.hidden = true
  const hint = $('markHint')
  if (hint) hint.textContent = 'Drag it on the stage onto the thing it is for, or lasso the thing and ask.'
  const exp = $('doExport')
  if (exp) exp.innerHTML = `${ico('export', 'icon-sm')} Export PNG`
  setShotView('styled')
}

// Styled and Original, one click apart. Original is not a second render of anything:
// the compositor steps aside the way it already does on the Crop tab, and what is
// left on the stage is the file that was captured.
function setShotView(view) {
  ed.view = view === 'original' ? 'original' : 'styled'
  document.querySelectorAll('#edView button').forEach(b =>
    b.setAttribute('aria-selected', String(b.dataset.view === ed.view)))
  const frame = $('stageFrame')
  if (frame) frame.dataset.view = ed.view
  paintStageGL({ upload: true })
  paintOverlays(); paintAim()
}

// Hold Space to peek at the raw capture: there is no playback to give the key to, and
// checking the work against what was captured is what someone does most here.
const shotPeekable = () => {
  if (!ed.shot || !ed.src) return false
  const view = document.querySelector('.view[data-view="editor"]')
  return !!view && !view.hidden
}
// what the peek is holding, so releasing puts back the view that was there rather
// than assuming it was Styled
let shotPeek = null
const endShotPeek = () => {
  if (shotPeek == null) return
  const back = shotPeek; shotPeek = null
  setShotView(back)
}
document.addEventListener('keydown', e => {
  if (e.code !== 'Space' || e.repeat || shotPeek != null || !shotPeekable()) return
  const t = e.target
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
  e.preventDefault()
  shotPeek = ed.view
  setShotView('original')
})
document.addEventListener('keyup', e => { if (e.code === 'Space') endShotPeek() })
// a key held while the window goes away never lands its release here
window.addEventListener('blur', endShotPeek)

// What the export will write, which on a shot stands where the running time does.
// The plan's own size times the scale the renderer picks for it (compositor shotScale:
// the capture at its own size), so the chip is the file's pixels and
// not the stage's.
function paintShotSize() {
  const n = $('edSize')
  if (!n || !ed.shot) return
  const spec = stageGL && stageGL.spec
  let w = (ed.meta && ed.meta.width) || 0, h = (ed.meta && ed.meta.height) || 0
  if (spec) {
    let k = 1
    try { k = require('./ui/compositor').shotScale(spec, 'native') } catch {}
    w = spec.W * k; h = spec.H * k
  }
  n.textContent = `${Fmt.size(w, h)} PNG`
}

// One redraw when the capture has decoded, and one whenever the stage changes size.
// A shot has no frames to be called back on, so this is the whole clock it gets.
function armStageStill(img) {
  if (!img || img._stageGL) return
  img._stageGL = true
  img.addEventListener('load', () => { paintStageGL({ fresh: true, upload: true }); paintShotSize() })
}

// Every change to the open clip's edit, by hand or by an agent, is written to its
// document, so the edit survives a restart and both see the same thing. A cheap
// compare on an interval rather than a hook in every control: nothing can be missed.
let docSaveTimer = null
// Undo and redo for the whole edit. Each settled state of the document is a step, so
// every control (drags, sliders, captions, text, an agent's change) is covered without
// a hook in each one. A drag becomes one step: nothing is recorded while a button is
// held. Per clip, cleared when another clip opens.
const edHistory = { src: null, stack: [], i: -1, cap: 150 }
let pointerHeld = false
document.addEventListener('mousedown', () => { pointerHeld = true }, true)
document.addEventListener('mouseup', () => { pointerHeld = false }, true)

function historyPush(json) {
  const h = edHistory
  if (h.stack[h.i] === json) return
  h.stack = h.stack.slice(0, h.i + 1)
  h.stack.push(json)
  if (h.stack.length > h.cap) h.stack.shift()
  h.i = h.stack.length - 1
  paintUndo()
}

function historyStep(dir) {
  // Cmd+Z while an old version is on screen means leave it, never edit it
  if (versionPeeking()) { window.fetchHistory.back(); return }
  const h = edHistory
  if (!liveDoc() || h.src !== ed.src) return
  // settle anything still in flight first, so undo never skips the latest change
  try { historyPush(JSON.stringify(liveDoc().get())) } catch {}
  const j = h.i + dir
  if (j < 0 || j >= h.stack.length) return
  h.i = j
  const doc = JSON.parse(h.stack[j])
  liveDoc().load(doc)
  ipcRenderer.invoke(docWrite(), ed.src, doc).catch(() => {})
  if (!ed.shot) ipcRenderer.invoke('write-cues', ed.src, ed.cues).catch(() => {})
  docSaveLast = h.stack[j]
  paintUndo()
  // one pill for undo and redo: stepping back and forth replaces it, never stacks two
  const box = $('toasts')
  if (h.toastEl && h.toastEl.isConnected) h.toastEl.remove()
  toast(dir < 0 ? 'Undone' : 'Redone')
  h.toastEl = box && box.lastElementChild
}

function paintUndo() {
  const h = edHistory, u = $('edUndo'), r = $('edRedo')
  if (u) u.disabled = !(h.src === ed.src && h.i > 0)
  if (r) r.disabled = !(h.src === ed.src && h.i < h.stack.length - 1)
}

let docSaveLast = null
function startDocAutosave(src) {
  clearInterval(docSaveTimer)
  docSaveLast = null
  try { docSaveLast = JSON.stringify(liveDoc().get()) } catch {}
  edHistory.src = src; edHistory.stack = docSaveLast ? [docSaveLast] : []; edHistory.i = edHistory.stack.length - 1
  paintUndo()
  docSaveTimer = setInterval(() => {
    if (ed.src !== src || !liveDoc()) { clearInterval(docSaveTimer); return }
    let cur
    try { cur = JSON.stringify(liveDoc().get()) } catch { return }
    if (cur === docSaveLast) return
    if (versionPeeking()) return               // looking at an old version is not saving it
    if (pointerHeld) return                    // mid-drag: one step when it lands
    docSaveLast = cur
    historyPush(cur)
    ipcRenderer.invoke(docWrite(), src, JSON.parse(cur)).catch(() => {})
  }, 400)
}

// ── version history ─────────────────────────────────────────────────────
// Undo above dies with the window. The edit's past across sessions is kept by
// ui/history.js and fed by ui/autosave.js (window.fetchHistory); this is only the part
// a person sees: every version, who made it, what changed, a row to look at and a
// Restore on the one being looked at. A restore is a new version on top, so nothing
// ahead of it is lost, and the panel says so.
const versionPeeking = () => !!(window.fetchHistory && window.fetchHistory.peeking())
const vers = { open: false, shown: 100 }
const VER_PAGE = 100
const verDay = at => {
  const d = new Date(at), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
const verClock = at => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

// Who, in the activity log's words: an agent's name on its own vendor mark (the brake's
// artwork, ui/app.js), "You" for the person, and for an edit made where nobody watched,
// no name at all, since crediting anyone would be a guess.
function verWho(r) {
  if (r.how === 'outside') return `<span class="ver-unseen">Not seen being made</span>`
  if (!r.by) return `<span>You</span>`
  return `<span class="ver-mark">${agentMark(r.by)}</span><span>${escHtml(r.by)}</span>`
}

function versionRow(r, head, at) {
  const looking = at === r.id
  const also = r.also && r.also.length ? ` with ${escHtml(r.also.join(', '))}` : ''
  const folded = r.merged ? `<span class="ver-folded">and ${r.merged} more${also}</span>` : ''
  const gone = r.missing && r.missing.length
    ? `<span class="ver-missing">${ico('warning-circle', 'icon-sm')}Some files it used are gone</span>` : ''
  // the row names what kind of version it is in words, not only in the line
  const kind = r.how === 'restore' ? `<span class="ver-kind">${ico('arrow-counter-clockwise', 'icon-sm')}Restore</span>`
    : r.how === 'undo' ? `<span class="ver-kind">${ico('arrow-counter-clockwise', 'icon-sm')}Undo</span>` : ''
  return `<li class="ver-row" data-n="${r.n}" data-how="${escHtml(r.how)}" aria-current="${looking}">
    <button class="ver-look" data-look="${r.n}" aria-label="${head ? `${r.id}, the edit as it is now` : `Look at ${r.id}`}">
      <span class="ver-id mono">${r.id}</span>
      <span class="ver-body">
        <span class="ver-line">${escHtml(r.line)}</span>
        <span class="ver-meta">${kind}${verWho(r)}<span class="ver-sep" aria-hidden="true">${Fmt.SEP.trim()}</span><span class="mono">${verClock(r.at)}</span>${folded}</span>
        ${gone}
      </span>
      ${head ? '<span class="chip chip-static ver-now">Now</span>' : ''}
    </button>
    ${looking && !head ? `<div class="ver-act"><button class="btn btn-sm btn-primary" data-restore="${r.n}">${ico('arrow-counter-clockwise', 'icon-sm')}Restore ${r.id}</button>
      <button class="btn btn-sm btn-ghost" data-back>Back to now</button></div>` : ''}
  </li>`
}

function paintVersions() {
  const H = window.fetchHistory
  const rows = H ? H.rows() : []
  const btn = $('edVersions')
  if (btn) {
    btn.setAttribute('aria-pressed', String(vers.open))
    const c = btn.querySelector('.ver-count'); if (c) c.textContent = rows.length > 1 ? `V${rows[0].n}` : ''
  }
  const panel = $('verPanel'), list = $('verList')
  if (!panel || !list) return
  panel.hidden = !vers.open
  if (!vers.open) return
  if (!rows.length) {
    list.innerHTML = `<li class="ver-empty"><img class="biscuit" src="./assets/mascot/curious.png" alt="">
      <p>No versions yet. Every change to this edit, yours or an agent's, lands here.</p>
      <button class="btn btn-sm" data-ver-close>Close</button></li>`
    $('verCount').textContent = ''
    return
  }
  const at = H.peekingAt()
  let html = '', day = null
  rows.slice(0, vers.shown).forEach((r, i) => {
    const d = verDay(r.at)
    if (d !== day) { html += `<li class="ver-day caps">${d}</li>`; day = d }
    html += versionRow(r, i === 0, at)
  })
  if (rows.length > vers.shown) html += `<li class="ver-more"><button class="btn btn-sm btn-ghost" data-older>Show older</button></li>`
  list.innerHTML = html
  $('verCount').textContent = `${rows.length} version${rows.length === 1 ? '' : 's'}`
}

function toggleVersions(on = !vers.open) {
  if (!ed.src || !$('verPanel')) return false
  vers.open = on
  if (on) vers.shown = VER_PAGE
  if (!on && versionPeeking()) window.fetchHistory.back()
  paintVersions()
  if (on) { const first = $('verList').querySelector('.ver-look'); if (first) first.focus() }
  return true
}

function lookAtVersion(n) {
  const H = window.fetchHistory
  if (!H) return
  const top = H.rows()[0]
  // the top row is the edit as it is: looking at it is going back to now
  if (top && top.n === n) { if (H.peeking()) H.back(); paintVersions(); return }
  const r = H.peek(n)
  if (r && r.ok === false) toast(escHtml(r.why), 'bad')
  if (ed.sel) selectObj(null)
  paintVersions()
}

function wireVersions() {
  const btn = $('edVersions'), panel = $('verPanel')
  if (btn) btn.onclick = () => toggleVersions()
  if (panel) panel.addEventListener('click', async e => {
    const H = window.fetchHistory
    const restore = e.target.closest('[data-restore]')
    if (restore && H) { await H.restore(+restore.dataset.restore); return paintVersions() }
    if (e.target.closest('[data-back]') && H) { H.back(); return paintVersions() }
    if (e.target.closest('[data-older]')) { vers.shown += VER_PAGE; return paintVersions() }
    const look = e.target.closest('[data-look]')
    if (look) return lookAtVersion(+look.dataset.look)
    if (e.target.closest('[data-ver-close]')) toggleVersions(false)
  })
  // replaced, not stacked: the history repaints the one panel there is
  if (window.fetchHistory) window.fetchHistory.onchange = paintVersions
  paintVersions()
}
// the history is opened for a take after the editor has drawn it (ui/autosave.js)
window.addEventListener('fetch:editor-ready', () => setTimeout(paintVersions, 0))

// Esc in the panel steps back one level: off the version being looked at, then shut.
// The brake in ui/app.js takes Esc first whenever an agent is at work.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !vers.open || e.defaultPrevented) return
  if (versionPeeking()) { window.fetchHistory.back(); paintVersions() } else toggleVersions(false)
})

// The menu's Cmd+Y (main.js, through ui/app.js). A name of its own, since
// window.fetchHistory is the history itself and belongs to ui/autosave.js.
window.fetchVersionsPanel = { toggle: () => toggleVersions() }

document.addEventListener('keydown', e => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
  const view = document.querySelector('.view[data-view="editor"]')
  if (!view || view.hidden || !ed.src) return
  const t = e.target
  // text being typed keeps its own undo
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
  e.preventDefault()
  historyStep(e.shiftKey ? 1 : -1)
})

// ── wiring ──────────────────────────────────────────────────────────────
function wireEditor() {
  const v = $('edVideo')
  wireLasso()
  wireFocus()
  renderAspects()

  $('inspTabs').onclick = e => {
    const b = e.target.closest('button[data-tab]'); if (!b) return
    ed.tab = b.dataset.tab
    document.querySelectorAll('#inspTabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)))
    document.querySelectorAll('.insp-panel').forEach(p => { p.hidden = p.dataset.panel !== ed.tab })
    $('cropBox').hidden = !(ed.tab === 'crop' && ed.crop)
    // the crop handles own the gesture on their tab, and the compositor stage is off
    // there, so the lasso has nothing to pick against
    if (ed.tab === 'crop') setLasso(false)
    // the Crop tab shows the whole recording, every other tab the crop, as exported
    try { paintBackdrop(); paintCrop(); paintCaption() } catch {}
    paintOverlays()   // the zoom preview steps aside on the Crop tab
    paintAim()        // the handles belong to the tab that owns them
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
    paintPlayhead(); paintTime(); highlightCue(); paintCaption(); syncCam(); highlightBeat()
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
    paintAspects()
    if (ed.crop) applyAspect()
  }
  $('cropOn').onclick = () => { ed.crop = ed.crop ? null : { x: .1, y: .1, w: .8, h: .8 }; applyAspect(); paintCrop() }
  $('cropReset').onclick = () => { ed.crop = null; paintCrop() }
  dragCrop()

  // text
  $('addText').onclick = () => {
    // minted now, from the saved edit's counter, so the lane shows T3 from the start
    // and the id an agent later reads is the one the person already saw
    const id = ed.doc ? FD.mintId(ed.doc, 'texts') : undefined
    ed.texts.push({ id, text: 'New text', fx: .5, fy: .5, sizeFrac: .06, color: 'white', box: false, start: null, end: null })
    ed.selText = ed.texts.length - 1
    renderTexts(); renderLayerList()
  }
  $('txtValue').oninput = e => { cur().text = e.target.value; renderTexts(); renderLayerList() }
  bindRange('txtSize', v2 => { cur().sizeFrac = v2 / 100; renderTexts() }, v2 => Fmt.pct(v2 / 100))
  // colour: eight quick swatches plus a full picker
  const sw = $('txtSwatches')
  sw.innerHTML = SWATCHES.map(c => `<button class="sw" data-c="${c}" style="background:${c}"></button>`).join('')
  sw.onclick = e => {
    const b = e.target.closest('.sw'); if (!b) return
    cur().color = b.dataset.c; $('txtColor').value = b.dataset.c
    paintSwatches(); renderTexts()
  }
  $('txtColor').oninput = e => { cur().color = e.target.value; paintSwatches(); renderTexts() }

  dropdown('txtFont', FONTS.map(f => ({ ...f, font: fontCss(f.id) })), 'Helvetica', id => {
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
  dropdown('capFont', FONTS.map(f => ({ ...f, font: fontCss(f.id) })), ed.capStyle.font, id => { ed.capStyle.font = id; paintCaption() })
  bindRange('capSize', v => { ed.capStyle.scale = v / 100; paintCaption() }, v => Fmt.mult(v / 100, 0.1))
  bindRange('camSize', v => { if (ed.cam) { ed.cam.size = v / 100; paintCam() } }, v => Fmt.pct(v / 100))
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
  captionWords()
  $('capPos').onclick = e => {
    const b = e.target.closest('[data-pos]'); if (!b) return
    ed.capStyle.position = b.dataset.pos
    delete ed.capStyle.fx; delete ed.capStyle.fy      // preset wins over a drag
    paintCaption()
    $('capPos').querySelectorAll('button').forEach(x => x.setAttribute('aria-selected', String(x === b)))
  }
  // a bed under the voice, ducked while anyone speaks (processor.js musicBed)
  $('musicBed').onclick = e => {
    const b = e.target.closest('[data-bed]'); if (!b) return
    ed.music = b.dataset.bed || null
    paintMusic()
  }
  // how the word being spoken stands out; captions never sit on a slab
  $('capHl').onclick = e => {
    const b = e.target.closest('[data-hl]'); if (!b) return
    ed.capStyle.highlight = b.dataset.hl
    paintCapHl(); paintCaption()
  }

  // captions
  $('doTranscribe').onclick = async () => {
    $('trProg').hidden = false; $('trProg').classList.add('indeterminate')
    $('doTranscribe').disabled = true
    const r = await runJob({ op: 'transcribe', src: ed.src }, 'Transcribe')
    $('trProg').hidden = true; $('doTranscribe').disabled = false
    if (r) {
      ed.cues = r.cues || []; renderCues(); paintCaption(); dragCaption()
        ed.beats = r.beats || []; renderBeats(); highlightBeat()
        upgradeName()
      if ($('burnCaps') && ed.cues.length) $('burnCaps').checked = true
      toast(Fmt.join(`${r.words} words`, r.rtfx ? `${Fmt.mult(+r.rtfx, 1)} realtime` : ''), 'ok')
    }
    paintTranscribeBtn()
  }

  // audio
  bindRange('gain', v2 => {}, v2 => Fmt.db(v2))

  // look: the inspector, generated from the Look spec (ui/inspector.js)
  mountLook()
  // burned captions take a band below a framed video, so the frame follows the switch
  if ($('burnCaps')) $('burnCaps').addEventListener('change', () => { try { paintBackdrop() } catch {} })
  // tell the user plainly whether cursor data exists for this clip (the auto zoom switch)
  ed.hasCursor = null
  ipcRenderer.invoke('has-cursor', ed.src).then(has => { ed.hasCursor = !!has; if (lookUI) lookUI.render() })

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
  bindRange('extraVol', v => { if (ed.audioTrack) ed.audioTrack.volume = v / 100 }, v => Fmt.pct(v / 100))
  bindRange('extraOff', v => { if (ed.audioTrack) { ed.audioTrack.offset = v / 10; drawExtraWave() } },
            v => Fmt.secs(v / 10, 0.1))
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

  // ── voiceover ──────────────────────────────────────────────────────────
  // Re-narrate a take without re-recording it. Fetch already holds the transcript,
  // so the flow is: take what you said, fix the stumbles, speak it back cleanly over
  // the same footage. The result becomes the added audio track, which the exporter
  // already knows how to mix or replace with.
  let voVoices = []
  let voPicked = null

  function voSettings() {
    return {
      stability: +$('voStability').value / 100,
      similarity: +$('voSimilarity').value / 100,
      speed: +$('voSpeed').value / 100,
    }
  }

  function renderVoices() {
    const host = $('voVoices')
    if (!host) return
    if (!voVoices.length) { host.innerHTML = '<p class="vo-note"><span>No voices on this account yet.</span></p>'; return }
    host.innerHTML = voVoices.map(v =>
      '<button class="vo-voice" data-id="' + v.id + '" data-on="' + (v.id === voPicked) + '">' +
        '<span class="vo-voice-play" data-preview="' + (v.preview || '') + '">' + ico('play-fill', 'icon-sm') + '</span>' +
        '<span class="vo-voice-txt">' +
          '<span class="vo-voice-name">' + escHtml(v.name) + '</span>' +
          '<span class="vo-voice-tags">' +
            [v.accent, v.age, v.use].filter(Boolean).map(escHtml).join(' &middot; ') +
          '</span>' +
        '</span>' +
      '</button>').join('')
  }

  async function voRefresh() {
    const st = await ipcRenderer.invoke('voice-status').catch(() => ({ connected: false }))
    $('voOff').hidden = !!st.connected
    $('voOn').hidden = !st.connected
    if (!st.connected) return
    if (st.used != null && st.limit != null) {
      $('voUsage').textContent = `${st.used.toLocaleString()} of ${st.limit.toLocaleString()} characters used this month`
    }
    if (!voVoices.length) {
      voVoices = await ipcRenderer.invoke('voice-voices').catch(() => [])
      if (voVoices.length && !voPicked) voPicked = voVoices[0].id
      renderVoices()
    }
  }

  function wireVoice() {
    if (!$('voOn')) return

    // Electron refuses window.prompt outright, so the key is typed inline. It is a
    // password field and it is cleared the moment it is handed over: nothing keeps a
    // copy in the DOM once it is in the Keychain.
    const keyField = $('voKey')
    keyField.oninput = () => { $('voConnectBtn').disabled = !keyField.value.trim() }
    $('voConnectForm').onsubmit = async e => {
      e.preventDefault()
      const key = keyField.value.trim()
      if (!key) return
      const btn = $('voConnectBtn'); btn.disabled = true; btn.textContent = 'Checking'
      try {
        await ipcRenderer.invoke('voice-connect', key)
        keyField.value = ''
        toast('ElevenLabs connected', 'ok')
        voVoices = []; await voRefresh()
      } catch (err) {
        // Electron wraps a rejected handler as "Error invoking remote method 'x':
        // Error: <real message>". Only the last part is worth showing.
        const raw = String(err.message || err)
        toast(raw.split(/Error:\s*/).pop().trim() || raw, 'bad', 7000)
      }
      btn.textContent = 'Connect'
      btn.disabled = !keyField.value.trim()
    }

    // one <audio> reused, so previewing a second voice stops the first
    let preview = null
    $('voVoices').addEventListener('click', e => {
      const play = e.target.closest('[data-preview]')
      const row = e.target.closest('.vo-voice')
      if (play && play.dataset.preview) {
        e.stopPropagation()
        if (preview) preview.pause()
        preview = new Audio(play.dataset.preview)
        preview.play().catch(() => toast('Could not play that preview', 'bad'))
        return
      }
      if (row) { voPicked = row.dataset.id; renderVoices() }
    })

    const count = () => { const n = $('voScript').value.length; $('voCount').innerHTML = `<span class="mono">${Fmt.count(n)}</span> character${n === 1 ? '' : 's'}` }
    $('voScript').addEventListener('input', count)

    $('voFromCues').onclick = () => {
      if (!ed.cues.length) { toast('Transcribe this take first', 'bad'); return }
      $('voScript').value = ed.cues.map(c => String(c.text || '').trim()).filter(Boolean).join(' ')
      count()
    }

    // read at generate time rather than stored, so these only need to paint
    const noop = () => {}
    bindRange('voStability', noop, v => Fmt.pct(v / 100))
    bindRange('voSimilarity', noop, v => Fmt.pct(v / 100))
    bindRange('voSpeed', noop, v => Fmt.mult(v / 100, 0.01))

    $('voGenerate').onclick = async () => {
      const text = $('voScript').value.trim()
      if (!text) { toast('Write something to say first', 'bad'); return }
      if (!voPicked) { toast('Pick a voice first', 'bad'); return }
      $('voProg').hidden = false
      $('voGenerate').disabled = true
      const r = await ipcRenderer.invoke('voice-speak', {
        src: ed.src, text, voiceId: voPicked, settings: voSettings(),
      })
      $('voProg').hidden = true
      $('voGenerate').disabled = false
      if (!r || !r.ok) { toast((r && r.error) || 'Could not generate that', 'bad', 7000); return }

      // Lands as the added audio track, replacing the original by default: the point
      // of a voiceover is to stand in for the narration that was there.
      const name = (voVoices.find(v => v.id === voPicked) || {}).name || 'Voiceover'
      ed.audioTrack = { file: r.file, name: name + ' voiceover', volume: 1, offset: 0, replace: true }
      $('extraPanel').hidden = false
      $('extraName').textContent = ed.audioTrack.name
      $('extraReplace').checked = true
      $('laneExtra').hidden = false
      const w = await runJob({ op: 'waveform', src: r.file }, 'Waveform', { quiet: true })
      ed.audioTrack.peaks = (w && w.peaks) || []
      drawExtraWave()
      toast('Voiceover added, mixing over the take', 'ok')
    }
  }

  wireVoice(); voRefresh()

    // ── the edit document, as the agent sees it ────────────────────────────
  // ui/fetchdoc.js is the canonical shape; `ed` is the working copy the UI drives.
  // These two functions are the only place they are converted, so there is exactly
  // one definition of "what the current edit is" for an agent to read or change.
  const FD = require('./ui/fetchdoc')

  function docFromEd() {
    // a shot is its own document (ui/shot.js), so anything asking this one for an edit
    // while a capture is open is asking about the wrong thing and is told so
    if (ed.shot) return null
    const base = ed.doc || FD.emptyDoc(ed.src, ed.dur)
    const doc = FD.normalize(base, ed.src, ed.dur)

    // Clips are derived from trim and cuts, but ids must survive: a clip that has
    // not moved keeps the name an agent already used for it.
    const fresh = FD.clipsFromTrim(ed.in, ed.out, ed.cuts, ed.dur)
    const old = doc.clips || []
    doc.clips = fresh.map((c, i) => {
      // A clip that has not moved keeps everything it was carrying, not only its id:
      // its rate and its own sound are nobody's on this screen to change, and rebuilding
      // the list from the trim and the cuts used to drop both. An agent set a gain on one
      // passage, the person opened the editor, and saving took it off again.
      const was = old[i] && Math.abs(old[i].start - c.start) < 0.02 ? old[i] : null
      return { ...(was || {}), id: was ? was.id : FD.mintId(doc, 'clips'), start: c.start, end: c.end }
    })

    doc.texts = (ed.texts || []).map((t, i) => ({ ...t, id: t.id || (old.texts && old.texts[i]?.id) || FD.mintId(doc, 'texts') }))
    doc.cues = (ed.cues || []).map(c => ({ ...c }))
    doc.beats = (ed.beats || []).map((b, i) => ({ ...b, id: b.id || 'B' + (i + 1) }))
    doc.zooms = (ed.zooms || []).map(z => ({ ...z, id: z.id || FD.mintId(doc, 'zooms') }))
    doc.marks = (ed.marks || []).map(m => ({ ...m, id: m.id || FD.mintId(doc, 'marks') }))
    doc.crop = ed.crop; doc.cropAR = ed.cropAR
    doc.camera = ed.cam || null
    doc.audioTrack = ed.audioTrack || null
    doc.autoZoom = !!ed.autoZoom

    // The look from the inspector, with the captions from their own tab: its style
    // and the Burn switch. A caption dragged to a place keeps it (fx, fy).
    const cs = ed.capStyle || {}
    doc.look = LookLib.merge(ed.look || doc.look, { captions: {
      show: !!($('burnCaps') && $('burnCaps').checked),
      font: cs.font, scale: cs.scale, colour: cs.colour, position: cs.position, highlight: cs.highlight,
      fx: cs.fx != null ? cs.fx : null, fy: cs.fy != null ? cs.fy : null,
    } }).look
    const num = (id, d) => { const n = $(id); return n ? +n.value : d }
    doc.audio = FD.cleanAudio({
      denoise: !!($('denoise') && $('denoise').checked),
      loudnorm: !!($('loudnorm') && $('loudnorm').checked),
      gain: num('gain', 0),
      music: ed.music || null,
    })
    return FD.ensureIds(doc)
  }

  // Apply a document back onto the editor. Used when an agent changes something, so
  // the UI shows the change rather than quietly disagreeing with the file.
  function docToEd(doc) {
    ed.doc = doc
    // No clips means nothing has been trimmed yet, so the range is the whole take. Taking
    // trimFromClips' 0 to 0 at face value opened every fresh take trimmed to nothing.
    const t = FD.trimFromClips(doc.clips)
    const whole = !(doc.clips && doc.clips.length) || !(t.end > t.start)
    ed.in = whole ? 0 : t.start; ed.out = whole ? ed.dur : t.end; ed.cuts = whole ? [] : t.cuts
    // The playhead belongs inside the video. Opening a saved edit restored the trim and
    // left the playhead where it started, at zero, so a take trimmed to begin at 0:33
    // opened parked thirty three seconds before its own first frame and played footage
    // that is not in the export. Only moved when it is outside the range: an agent
    // changing something mid-session must not yank the playhead away from wherever the
    // person is looking.
    if (!ed.shot && (ed.cur < ed.in || ed.cur > ed.out)) seek(Math.max(ed.in, Math.min(ed.cur, ed.out)))
    ed.texts = (doc.texts || []).map(x => ({ ...x }))
    ed.cues = (doc.cues || []).map(x => ({ ...x }))
    ed.beats = (doc.beats || []).map(x => ({ ...x }))
    ed.zooms = (doc.zooms || []).map(x => ({ ...x }))
    ed.marks = (doc.marks || []).map(x => ({ ...x }))
    // The look, whole. Setting ed.backdrop and ed.outAspect from the document matters:
    // they used to be read and never applied, so an agent setting a backdrop changed a
    // file the editor then ignored. They are mirrors of the look now (syncLookMirrors).
    ed.look = LookLib.resolve(doc.look)
    syncLookMirrors()
    ed.audioTrack = doc.audioTrack || null
    // A camera can only be positioned if one was recorded. Accepting a camera object
    // for a take without one would draw a bubble with nothing in it.
    if (ed.cam && doc.camera) {
      const c = doc.camera
      ed.cam = { ...ed.cam,
        on: c.on !== false,
        x: c.x != null ? Math.max(0, Math.min(1, +c.x)) : ed.cam.x,
        y: c.y != null ? Math.max(0, Math.min(1, +c.y)) : ed.cam.y,
        size: c.size != null ? Math.max(0.1, Math.min(0.45, +c.size)) : ed.cam.size,
        // the bubble's track, as plan.js reads it: a list the editor carries whole
        keys: Array.isArray(c.keys) ? c.keys.map(q => ({ ...q })) : ed.cam.keys || null }
    }
    ed.crop = doc.crop; ed.cropAR = doc.cropAR || 'free'
    const C = ed.look.captions
    ed.capStyle = { ...ed.capStyle, font: C.font, scale: C.scale, colour: C.colour, position: C.position, highlight: C.highlight }
    if (C.fx != null && C.fy != null) { ed.capStyle.fx = C.fx; ed.capStyle.fy = C.fy } else { delete ed.capStyle.fx; delete ed.capStyle.fy }
    paintCapHl()
    ed.autoZoom = !!doc.autoZoom

    const A = FD.cleanAudio(doc.audio)
    const set = (id, v) => { const n = $(id); if (n && v != null) n.value = v }
    set('gain', A.gain)
    const chk = (id, v) => { const n = $(id); if (n) n.checked = !!v }
    chk('burnCaps', C.show); chk('denoise', A.denoise); chk('loudnorm', A.loudnorm)
    ed.music = A.music || null; paintMusic()
    if (lookUI) lookUI.render()

    paintTrim(); renderCuts(); renderTexts(); renderCues(); renderBeats(); renderZooms(); renderMarks()
    renderFocus()            // an agent's new zoom or mark shows up in the lists too
    try { paintBackdrop(); paintCam(); paintCrop() } catch {}
    paintCaption(); highlightBeat(); layoutTimeline()
  }

  // The surface an agent drives, reached through the bridge. Deliberately small: a
  // document in, a document out, and the editor repainted so the person watching
  // sees what changed.
  window.fetchDoc = {
    get: () => docFromEd(),
    // A partial update: anything the agent did not send is kept. Replacing the whole
    // document here is what let "add a zoom" wipe the crop, the caption font and the
    // backdrop, none of which the agent had been shown.
    apply: async patch => {
      // a capture is open: an edit document does not describe it, and quietly writing
      // one would put a clock on a PNG
      if (ed.shot) throw new Error('That is a shot, not a recording. Change it as a shot.')
      const src = ed.src, before = docFromEd()
      docToEd(FD.normalize(FD.mergeDoc(before, patch), ed.src, ed.dur))
      // Captions are burned from the .srt, so corrected wording has to reach it too,
      // or the editor shows the fix while the export burns the original mistake.
      if (patch && Array.isArray(patch.cues)) {
        await ipcRenderer.invoke('write-cues', ed.src, ed.cues)
        if (typeof renderCues === 'function') renderCues()
        if (typeof paintCaption === 'function') paintCaption()
      }
      // Only agents come through here, so this is the one place to keep the way back
      // and to show what moved.
      const after = window.fetchDoc.get()
      if (ed.src === src) {
        agentUndo.note(src, before, after)
        flashAgentChange(EditAssist.changedIds(before, after))
        paintAgentUndo()
        window.dispatchEvent(new CustomEvent('fetch:agent-edit', { detail: { src } }))
      }
      return after
    },
    // Only once the clip's saved edit is loaded. Reporting the clip as open any earlier
    // let an agent read the blank state and write it over the saved edit. A shot is
    // not an edit, so while one is open the answer is that none is.
    src: () => (!ed.shot && ed.docReady && ed.src) || null,
    load: doc => docToEd(doc),
  }
  // the autosave above holds still while a version is looked at, so looking is safe
  if (window.fetchHistory) window.fetchHistory.editorHonoursPeek = true

  // The shot as a document, and the same three questions asked of it: what is it, put
  // this on it, what is open. ui/shot.js is the canonical shape; `ed` is the working
  // copy the inspector, the marks and the crop drive, exactly as they do for an edit.
  function shotFromEd() {
    const size = { w: (ed.meta && ed.meta.width) || 0, h: (ed.meta && ed.meta.height) || 0 }
    const base = ed.doc && ed.doc.kind === 'shot' ? ed.doc : ShotLib.emptyShot(ed.src, size)
    return ShotLib.normalize({
      ...base,
      src: ed.src,
      look: ed.look,
      crop: ed.crop || null,
      cropAR: ed.cropAR,
      // the span every mark is lent belongs to the document, not to the editor
      marks: ShotLib.untimed(ed.marks || []),
    }, ed.src, size)
  }

  function shotToEd(shot) {
    const s = ShotLib.normalize(shot, ed.src, { w: shot && shot.w, h: shot && shot.h })
    ed.doc = s                                   // what mintObjId counts from, as an edit's does
    ed.look = LookLib.resolve(s.look); syncLookMirrors()
    ed.crop = s.crop ? { ...s.crop } : null
    ed.cropAR = s.cropAR || 'free'
    ed.marks = ShotLib.timed(s.marks)
    ed.zooms = []; ed.texts = []; ed.cues = []; ed.cuts = []
    if (ed.sel && !(ed.marks || []).some(m => m.id === ed.sel.id)) ed.sel = null
    renderFocus()
    try { paintBackdrop(); paintCrop() } catch {}
    paintOverlays(); paintStageGL({ fresh: true }); paintShotSize()
  }

  window.fetchShot = {
    get: () => shotFromEd(),
    // A partial change, merged by ui/shot.js: marks by id, the look field by field,
    // and everything the caller did not mention kept.
    apply: async patch => {
      const src = ed.src, before = shotFromEd()
      shotToEd(ShotLib.mergeShot(before, patch))
      const after = shotFromEd()
      if (ed.src === src) {
        agentUndo.note(src, before, after)
        flashAgentChange(EditAssist.changedIds(before, after))
        paintAgentUndo()
        window.dispatchEvent(new CustomEvent('fetch:agent-edit', { detail: { src } }))
      }
      return after
    },
    src: () => (ed.shot && ed.docReady && ed.src) || null,
    load: shot => shotToEd(shot),
  }

  // A shot has one format worth offering and no length, quality or resolution to pick,
  // so the button is the export: one click from the stage to the file.
  $('doExport').onclick = () => {
    // an export of the version being looked at would be a file of an edit nobody chose
    if (versionPeeking()) return toast('Restore this version or go back to now before exporting.')
    return ed.shot ? exportShot() : exportModal()
  }

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
// Seven, so they fit one row beside the colour well. No record red (BRAND: nothing else is
// ever that red) and one gold, not two that read as the same colour (J4).
const SWATCHES = ['#FFFFFF', '#0A0908', '#F0A93C', '#F87171', '#4ADE80', '#5B9DFF', '#F472B6']
// The CSS family that actually reaches a font by this name. "SF Pro", "SF Mono" and
// "New York" are not family names CSS can see, so written bare they fell through to
// Times, in the menu and on the stage (D1). The shared dropdown owns the table.
const fontCss = name => (window.Dropdown && typeof window.Dropdown.cssFamily === 'function')
  ? window.Dropdown.cssFamily(name || 'SF Pro')
  : (!name || name === 'SF Pro' ? '-apple-system,"SF Pro Display",system-ui,sans-serif' : `"${name}", sans-serif`)

// Motion clips are WebM with alpha. If one is missing or fails to decode, fall
// back to the matching still: a wait screen that renders nothing is worse than
// a wait screen that does not move.
function motion(name, still, cls = '') {
  return `<video class="motion ${cls}" src="./assets/mascot/motion/${name}.webm"
            poster="./assets/mascot/${still}.png" autoplay loop muted playsinline
            onerror="this.replaceWith(Object.assign(new Image(),{src:'./assets/mascot/${still}.png',className:'motion ${cls}'}))"></video>`
}

const cur = () => ed.texts[ed.selText] || {}
// The Captions tab and Look's Captions section edit the same fields, so they use the same
// words: both read them from the schema (J6). The markup carries today's words so the
// panel is never blank, and this keeps it from drifting when the schema changes.
function captionWords() {
  let by = null
  try { by = require('./ui/look-schema').BY_PATH } catch {}
  if (!by) return
  const get = path => by instanceof Map ? by.get(path) : by[path]
  document.querySelectorAll('[data-schema-label]').forEach(n => {
    const x = get(n.dataset.schemaLabel); if (x && x.label) n.textContent = x.label })
  document.querySelectorAll('[data-schema-sub]').forEach(n => {
    const x = get(n.dataset.schemaSub); if (x && x.sub) n.textContent = x.sub })
  const hl = get('captions.highlight'), seg = $('capHl')
  if (hl && seg) {
    if (hl.label) seg.setAttribute('aria-label', hl.label)
    if (hl.optionLabels) seg.querySelectorAll('button[data-hl]').forEach(b => {
      const w = hl.optionLabels[b.dataset.hl]; if (w) b.textContent = w })
  }
}

function bindRange(id, apply, fmt) {
  const s = $(id), out = $(id + 'Val')
  if (!s) return
  s.oninput = () => { apply(+s.value); if (out) out.textContent = fmt(+s.value) }
  if (out) out.textContent = fmt(+s.value)
}

// ── painting ────────────────────────────────────────────────────────────
const clamp01 = n => Math.max(0, Math.min(1, n))
const seek = t => {
  // a shot has one frame and it is always the one on the stage, so there is nowhere
  // to seek to and ed.cur must not be moved off it
  if (ed.shot) return
  const v = $('edVideo')
  v.currentTime = Math.max(0, Math.min(t, ed.dur))
  ed.cur = v.currentTime
  paintPlayhead(); paintTime()
  highlightCue(); paintCaption()      // the caption must follow the playhead, not just playback
  syncCam(); highlightBeat()
}

// Clicking a named span is the fastest way back to a moment you remember by what was
// said in it, which is the reason the labels exist at all.
document.addEventListener('click', e => {
  // the click at the end of a drag is not a seek: the pill was being moved, and
  // jumping the playhead to where it landed is not what the hand asked for
  const pill = e.target.closest('#tlMarks .tl-mark, #tlZooms .tl-zoom')
  if (pill && trackAte) { trackAte = false; return }
  const mk = e.target.closest('#tlMarks .tl-mark')
  if (mk && ed.src) {
    const m = ed.marks.find(x => x.id === mk.dataset.id)
    if (m) seek(m.start)
    return
  }
  const tx = e.target.closest('#tlTexts .tl-text')
  if (tx && ed.src) {
    const i = +tx.dataset.i, t = ed.texts[i]
    if (!t) return
    const tab = document.querySelector('#inspTabs button[data-tab="text"]')
    if (tab) tab.click()
    ed.selText = i; renderTexts(); renderLayerList()
    seek(t.start != null ? t.start : ed.in)
    return
  }
  const z = e.target.closest('#tlZooms .tl-zoom')
  if (z && ed.src) {
    const zoom = ed.zooms.find(x => x.id === z.dataset.id)
    if (zoom) seek(zoom.start)
    return
  }
  const hit = e.target.closest('#tlBeats .tl-beat')
  if (!hit || !ed.src) return
  const beat = ed.beats[+hit.dataset.i]
  if (beat) seek(beat.start)
})

function paintTime() {
  $('edTime').textContent = `${Fmt.clock(ed.cur)} / ${Fmt.clock(ed.dur)}`
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
          <span class="mono">${Fmt.clock(a)} to ${Fmt.clock(b)}</span>
          <span class="cut-len mono">-${Fmt.secs(b - a, 0.1)}</span></button>`).join('')
      : ''
    list.querySelectorAll('.cut-row').forEach(b => b.onclick = () => {
      ed.cuts.splice(+b.dataset.i, 1); renderCuts(); paintTrim()
    })
  }
  const removed = ed.cuts.reduce((t, [a, b]) => t + (b - a), 0)
  const span = Math.max(0, (ed.out - ed.in) - removed)
  const chip = $('edOutLen')
  if (chip) chip.textContent = `${Fmt.clock(span)} out`
}

function paintTrim() {
  const w = $('tlWrap').clientWidth, d = ed.dur || 1
  const a = ed.in / d * w, b = ed.out / d * w
  $('tlRegion').style.left = a + 'px'; $('tlRegion').style.width = (b - a) + 'px'
  $('hIn').style.left = a + 'px'; $('hOut').style.left = b + 'px'
  $('dimL').style.left = '0px'; $('dimL').style.width = a + 'px'
  $('dimR').style.left = b + 'px'; $('dimR').style.width = (w - b) + 'px'
  $('trimIn').textContent = Fmt.clock(ed.in); $('trimOut').textContent = Fmt.clock(ed.out)
  $('tlRange').textContent = `${Fmt.clock(ed.in)} to ${Fmt.clock(ed.out)}`
  renderCuts(); renderTextTrack()     // a text with no range spans the trim
}
// ── beats ────────────────────────────────────────────────────────────────────
// The named spans a recording is actually scrubbed by, taken from what was said
// in it. A raw take and a cut one render the same strip, so the timeline reads
// the same before and after editing.
//
// Widths come from the same t -> t/ed.dur * w mapping the lanes use, so a beat
// sits exactly above the frames it covers.
function renderBeats() {
  const host = $('tlBeats')
  if (!host) return
  if (!ed.beats.length) { host.hidden = true; host.innerHTML = ''; return }
  host.hidden = false
  host.innerHTML = ed.beats.map((b, i) => {
    const left = (b.start / ed.dur) * 100
    const width = ((b.end - b.start) / ed.dur) * 100
    return '<button class="tl-beat" data-i="' + i + '" style="left:' + left + '%;width:' + width + '%" ' +
      'title="' + escHtml(b.label) + '">' +
      '<span class="tl-beat-id mono">' + (b.id || 'B' + (i + 1)) + '</span>' +
      '<span class="tl-beat-label">' + escHtml(b.label) + '</span>' +
    '</button>'
  }).join('')
}

// Explicit zooms as a track of their own, so a zoom an agent added is visible and
// nameable rather than an effect you only discover after exporting.
function renderZooms() {
  paintOverlays()   // the stage previews the zooms too
  const host = $('tlZooms')
  if (!host) return
  if (!ed.zooms.length) { host.hidden = true; host.innerHTML = ''; return }
  host.hidden = false
  host.innerHTML = ed.zooms.map(z => {
    const left = (z.start / ed.dur) * 100
    const width = Math.max(0.6, ((z.end - z.start) / ed.dur) * 100)
    return '<button class="tl-zoom" data-id="' + escHtml(z.id) + '" data-sel="' + String(isSel('zoom', z.id)) + '" ' +
      'style="left:' + left + '%;width:' + width + '%" ' +
      'title="' + escHtml(z.id) + ' zooms ' + Fmt.mult(z.scale || 1.8) + '">' +
      '<i class="tl-grip l" data-grip="start"></i>' +
      '<span class="tl-zoom-id mono">' + escHtml(z.id) + '</span>' +
      '<span class="tl-zoom-x mono">' + Fmt.mult(z.scale || 1.8) + '</span>' +
      '<i class="tl-grip r" data-grip="end"></i>' +
    '</button>'
  }).join('')
  fitPills(host)
}

// A short span's pill cannot hold its id and its detail ("Z38 1.9x" on a 3 s zoom was
// cut mid-number). The detail steps aside, to the tooltip, and the id, the handle an
// agent and the person both name it by, always shows whole.
function fitPills(host) {
  if (!host.clientWidth) return   // not laid out yet; the next layout pass fits them
  for (const n of host.children) {
    n.classList.remove('tight')
    if (n.scrollWidth > n.clientWidth + 1) n.classList.add('tight')
  }
}

// A take still under a name Fetch gave it is named again once there is a transcript
// to read: by the person's agent when naming with it is on, else from the app in
// front and the first thing said. ui/take-namer.js decides, and never touches a name
// someone typed or one the agent already gave.
async function upgradeName() {
  if (!ed.beats.length) return
  try {
    const [r] = await ipcRenderer.invoke('name-takes', [ed.src], { upgrade: true })
    if (!r || !r.to) return
    toast('Named it "' + escHtml(r.name) + '"', 'ok')
  } catch (e) { console.error('rename after transcribe failed:', e.message) }
}

// A rename from anywhere (the Library, an agent, the transcript above) can move the
// clip open here, take folder and all. Follow it, or the autosave writes the edit
// back under a path that no longer exists and export looks for a camera take that
// has moved.
// The take's name over the stage: its folder for a take, the file's name otherwise
function paintEdName() {
  const n = $('edName')
  if (!n || !ed.src) return
  const dir = path.dirname(ed.src)
  n.textContent = path.basename(dir) === 'Original' ? path.basename(path.dirname(dir)) : path.parse(ed.src).name
  n.title = ed.src
}

window.editorFollowRename = moves => {
  const map = new Map(moves)
  for (const [from, to] of map) agentUndo.rename(from, to)     // an undo follows its take
  const next = map.get(ed.src)
  if (!next) return
  ed.src = next
  paintEdName()
  if (window.fetchDoc) window.fetchDoc.src = () => (ed.shot ? null : ed.src)
  if (ed.cam && map.has(ed.cam.file)) ed.cam.file = map.get(ed.cam.file)
  if (ed.audioTrack && map.has(ed.audioTrack.file)) ed.audioTrack.file = map.get(ed.audioTrack.file)
  const url = 'file://' + encodeURI(next).replace(/#/g, '%23').replace(/\?/g, '%3F')
  // a renamed shot is the same pixels under a new name, so the picture is repointed
  // rather than reloaded and nothing on the stage moves
  if (ed.shot) { const img = $('edStill'); if (img) img.src = url }
  else {
    const v = $('edVideo')
    if (v) { const t = v.currentTime; v.src = url; v.currentTime = t }
  }
  if (ed.docReady && liveDoc()) {
    // the edit as it stands: while an old version is on the stage, the real one is held aside
    const held = versionPeeking() && window.fetchHistory.current ? window.fetchHistory.current() : null
    ipcRenderer.invoke(docWrite(), next, held || liveDoc().get()).catch(() => {})
    startDocAutosave(next)
  }
}

// A take trashed while it is open (from the Library, or delete_recording over MCP)
// must not stay loaded: Export and every edit would aim at a file in the Trash, and
// the doc autosave would recreate its folder. Runs on every Library refresh, which
// both kinds of delete end with.
window.editorCloseIfGone = () => {
  if (!ed.src || fs.existsSync(ed.src)) return false
  clearInterval(docSaveTimer)
  const v = $('edVideo')
  if (v) { v.pause(); v.removeAttribute('src'); v.load() }
  const was = ed.shot
  ed.src = null; ed.docReady = false; ed.meta = null; ed.cam = null; ed.audioTrack = null
  ed.sel = null; ed.shot = false
  setLasso(false); clearBand()
  const mount = $('editorMount')
  mount.className = 'empty'
  mount.innerHTML = `<img class="biscuit biscuit-lg" src="./assets/mascot/sad.png" alt="">
    <p>That ${was ? 'shot' : 'take'} was moved to the Trash. Put it back from the Trash to edit it again.</p>
    <button class="btn btn-sm" id="edGoneLib">Open the Library</button>`
  $('edGoneLib').onclick = () => document.querySelector('#nav [data-view="library"]').click()
  window.dispatchEvent(new CustomEvent('fetch:editor-closed'))
  return true
}

// Marks as their own track. A redaction in particular must be visible before export:
// it is the one edit where missing it means something private ships.
const MARK_LABEL = { redact: 'Redact', blur: 'Blur', lift: 'Lift', spotlight: 'Spotlight', step: 'Step', loupe: 'Loupe', arrow: 'Arrow' }
function renderMarks() {
  const host = $('tlMarks')
  if (!host) return
  if (!ed.marks.length) { host.hidden = true; host.innerHTML = ''; return }
  host.hidden = false
  host.innerHTML = ed.marks.map(m => {
    const left = (m.start / ed.dur) * 100
    const width = Math.max(0.6, ((m.end - m.start) / ed.dur) * 100)
    const what = m.kind === 'step' ? 'Step ' + (m.n || '') : (MARK_LABEL[m.kind] || m.kind)
    return '<button class="tl-mark" data-kind="' + escHtml(m.kind) + '" data-id="' + escHtml(m.id) + '" ' +
      'data-sel="' + String(isSel('mark', m.id)) + '" ' +
      'style="left:' + left + '%;width:' + width + '%" title="' + escHtml(m.id + ' ' + what) + '">' +
      '<i class="tl-grip l" data-grip="start"></i>' +
      '<span class="tl-mark-id mono">' + escHtml(m.id) + '</span>' +
      '<span class="tl-mark-kind">' + escHtml(what) + '</span>' +
      '<i class="tl-grip r" data-grip="end"></i>' +
    '</button>'
  }).join('')
  fitPills(host)
}

// Text layers get a track like zooms and marks: T1 is how an agent names one, so it
// has to be on screen, with the span it shows for. No range means the whole clip.
function renderTextTrack() {
  const host = $('tlTexts')
  if (!host || !ed.dur) return
  if (!ed.texts.length) { host.hidden = true; host.innerHTML = ''; return }
  host.hidden = false
  host.innerHTML = ed.texts.map((t, i) => {
    const whole = !(t.start != null && t.end != null && t.end > t.start)
    const s = whole ? ed.in : t.start, e = whole ? ed.out : t.end
    const left = (s / ed.dur) * 100
    const width = Math.max(0.6, ((e - s) / ed.dur) * 100)
    const words = String(t.text || '').replace(/\s+/g, ' ').trim() || 'Empty'
    return '<button class="tl-text" data-i="' + i + '" data-sel="' + String(i === ed.selText) + '" ' +
      'style="left:' + left + '%;width:' + width + '%" title="' + escHtml((t.id ? t.id + ' ' : '') + words) + '">' +
      (t.id ? '<span class="tl-text-id mono">' + escHtml(t.id) + '</span>' : '') +
      '<span class="tl-text-words">' + escHtml(words) + '</span>' +
    '</button>'
  }).join('')
}

// Which beat the playhead is inside. Called from seek and from the playback loop,
// so the strip tracks without its own timer.
function highlightBeat() {
  const host = $('tlBeats')
  if (!host || !ed.beats.length) return
  let active = -1
  for (let i = 0; i < ed.beats.length; i++) {
    if (ed.cur >= ed.beats[i].start && ed.cur < ed.beats[i].end) { active = i; break }
  }
  host.querySelectorAll('.tl-beat').forEach((n, i) => {
    n.dataset.active = String(i === active)
  })
}

// Load beats for the open clip. Cheap: reads the persisted word timings rather
// than transcribing again, and falls back to pointer dwell for a silent take.
async function loadBeats() {
  try {
    ed.beats = await ipcRenderer.invoke('beats-for', ed.src, ed.dur) || []
  } catch { ed.beats = [] }
  renderBeats(); highlightBeat()
}

function layoutTimeline() {
  const w = $('tlWrap').clientWidth
  const ticks = $('tlTicks'); ticks.innerHTML = ''
  // A step by length, then widened until labels have room: beside an open chat at the
  // smallest window a second apart was 34px and the labels ran into each other.
  const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
  let step = ed.dur > 240 ? 60 : ed.dur > 60 ? 30 : ed.dur > 20 ? 10 : ed.dur > 8 ? 5 : 1
  const MIN_GAP = ed.dur >= 3600 ? 88 : 60     // an h:mm:ss label is wider
  while (ed.dur && step / ed.dur * w < MIN_GAP && STEPS.some(n => n > step)) step = STEPS.find(n => n > step)
  // The video lane's tag shares the ticks' row, so a tick whose label would run under it
  // is not drawn. 0:00 always was; at the minimum width, or with the chat open, the first
  // one or two go as well rather than sit on "Video" (E3). Measured, not assumed, so a
  // longer tag or a larger label keeps clear too.
  const tag = document.querySelector('#laneVideo .lane-tag')
  const clear = tag && tag.offsetWidth ? tag.offsetLeft + tag.offsetWidth + 6 : 0
  for (let t = step; t <= ed.dur; t += step) {
    const x = t / ed.dur * w
    const s = el('span', null, Fmt.clock(t)); s.style.left = x + 'px'
    ticks.appendChild(s)
    const half = s.offsetWidth / 2
    if (w - x < half + 2) s.style.transform = 'translateX(-100%)'   // keep the last label inside
    else if (x - half < clear) s.remove()
  }
  paintTrim(); paintPlayhead()
}
function relayoutEditor() {
  // a shot has no timeline to measure against, so its stage lays itself out
  if (ed.shot) { if (ed.src) { paintBackdrop(); paintStageGL(); paintOverlays() } return }
  // a hidden editor measures zero wide: laying out then collapsed the trim to a sliver
  if (ed.src && $('tlWrap') && $('tlWrap').clientWidth) { drawWave(); drawExtraWave(); layoutTimeline(); renderBeats(); renderZooms(); renderMarks(); paintBackdrop(); paintCaption(); paintCam() }
}
window.addEventListener('resize', relayoutEditor)
// The chat opening or closing on another view resizes the editor while it is hidden,
// so it lays out again when it is shown at its new size.
new ResizeObserver(relayoutEditor).observe(document.querySelector('.view[data-view="editor"]'))

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
  g.fillStyle = 'rgba(189,181,172,.6)'   // matches the warm audio lane
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
  g.fillStyle = 'rgba(201,127,30,.75)'       // deep gold, distinct from the recording's own audio
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
  const v = srcEl(), frame = $('stageFrame'), canvas = $('edCanvas')
  if (!v || !canvas) return { left: 0, top: 0, w: 0, h: 0 }
  const host = (ed.backdrop && frame) ? frame : v
  const r = host.getBoundingClientRect(), p = canvas.getBoundingClientRect()
  return { left: r.left - p.left, top: r.top - p.top, w: r.width, h: r.height }
}

function videoRect() {
  const v = srcEl(), r = v.getBoundingClientRect(), p = $('edCanvas').getBoundingClientRect()
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
// The shapes a person can crop to, from the one list the look's own Shape field is
// built from, so the chips here, the inspector's shapes and the list an agent is given
// cannot drift apart. The crop's "free" is the look's "auto": keep the take's shape.
// A person could pick 4:3 and never be told about 4:5; an agent was told the reverse.
function aspectList() {
  const L = (LookLib && LookLib.ASPECTS) || require('./ui/look-schema').ASPECTS || []
  return ['free', ...L.filter(a => a !== 'auto')]
}
function renderAspects() {
  const host = $('arChips')
  if (!host) return
  host.innerHTML = aspectList().map(a => '<button class="chip" data-ar="' + a + '">' +
    (a === 'free' ? 'Free' : a) + '</button>').join('')
  paintAspects()
}
function paintAspects() {
  const host = $('arChips')
  if (!host) return
  host.querySelectorAll('.chip').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.ar === (ed.cropAR || 'free'))))
}

function paintCrop() {
  paintAspects()     // an agent's crop change reaches the chips too
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
    // Styled as the export draws it (ui/overlays.js). Export sizes are ASS sizes, a
    // whole line tall, so a CSS em is that over 1.18.
    const style = ovLib().textStyle(ovRel(t), ovSpan())
    const n = el('div', 'txt-layer', escHtml(t.text || '') || '…')
    n.dataset.sel = String(i === ed.selText); n.dataset.box = String(!!t.box && style === 'label')
    n.dataset.style = style; n.dataset.i = String(i)
    n.setAttribute('data-tip', 'Double-click to edit')
    n.style.left = (vr.left + t.fx * vr.w) + 'px'
    n.style.top = (vr.top + t.fy * vr.h) + 'px'
    n.style.fontSize = Math.max(9, t.sizeFrac * vr.h / 1.18) + 'px'
    n.style.color = t.color === 'white' ? '#fff' : (t.color || '#fff')
    n.style.fontFamily = fontCss(t.font)
    n.style.textAlign = t.align || 'center'
    if (style !== 'label') {
      // a closing address shows under the product's name, as the export draws it
      const card = style === 'title' && t.id != null &&
        ovLib().titleCards((ed.texts || []).map(ovRel), ovSpan()).find(k => k.t.id === t.id)
      const { title, subtitle } = ovLib().titleParts(card ? card.t : t)
      const px = style === 'title' ? Math.min(0.12, Math.max(0.06, +t.sizeFrac || 0.1)) * vr.h
        : Math.min(0.07, Math.max(0.03, +t.sizeFrac || 0.044)) * vr.h
      const sub = style === 'title' ? Math.max(0.0315 * vr.h, px * 0.3) / px : 0.62
      n.innerHTML = `<span class="tt">${escHtml(title)}</span>` +
        (subtitle ? `<span class="ts" style="font-size:${sub.toFixed(3)}em">${escHtml(subtitle)}</span>` : '')
      n.style.fontSize = Math.max(9, px / 1.18) + 'px'
      n.style.fontFamily = ''
      if (style === 'lower-third') {
        n.style.left = (vr.left + (t.fx != null && t.fx !== 0.5 ? t.fx : 0.07) * vr.w) + 'px'
        n.style.top = (vr.top + (t.fy != null && t.fy !== 0.5 ? t.fy : 0.8) * vr.h) + 'px'
      }
    }
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
  renderTextTrack()
  // the stage's canvas draws the text itself, so a moved or retyped layer is redrawn there
  if (ed.shot || ($('edVideo') && $('edVideo').paused)) paintStageGL({ fresh: true })
}
function renderLayerList() {
  const list = $('layerList'); list.innerHTML = ''
  ed.texts.forEach((t, i) => {
    // the whole text, cut by the row's own ellipsis: a slice at 22 characters ended a long
    // headline mid-word with no mark that anything was missing, and went in unescaped
    const r = el('div', 'layer-row', `${ico('text-t', 'icon-sm')}<span class="lname">${escHtml(String(t.text || '').trim() || 'Empty')}</span>`)
    r.dataset.sel = String(i === ed.selText)
    r.onclick = () => { ed.selText = i; renderTexts(); renderLayerList() }
    list.appendChild(r)
  })
  const has = ed.selText != null && ed.texts[ed.selText]
  $('textProps').hidden = !has
  if (has) {
    const t = cur()
    $('txtValue').value = t.text || ''
    $('txtSize').value = Math.round((t.sizeFrac || .06) * 100); $('txtSizeVal').textContent = Fmt.pct(+$('txtSize').value / 100)
    $('txtColor').value = t.color || 'white'
    $('txtBox').checked = !!t.box
    paintTextRange()
  }
}
// ── the look ────────────────────────────────────────────────────────────
// ed.look is the whole Look spec (ui/look.js); the inspector is generated from it.
// ed.backdrop, ed.backdropFile and ed.outAspect are read-only mirrors of it for the
// stage painting below, refreshed by syncLookMirrors after every change. Captions
// keep their own tab (ed.capStyle and the Burn switch), merged into the look by
// docFromEd.
const LookLib = require('./ui/look')
const InspectorLib = require('./ui/inspector')
const LOOK_DIR = path.join(os.homedir(), 'Library/Application Support/Fetch/looks')
let lookUI = null
let lookBackdropList = []
const loadLookBackdrops = () => ipcRenderer.invoke('backdrops')
  .then(list => { lookBackdropList = list || []; if (lookUI) lookUI.render(); paintBackdrop() }).catch(() => {})

function syncLookMirrors() {
  const L = ed.look = LookLib.resolve(ed.look)
  ed.backdrop = LookLib.backdropId(L)
  const img = L.background.kind === 'image' && lookBackdropList.find(b => b.id === L.background.image)
  ed.backdropFile = img ? img.file : null
  ed.outAspect = LookLib.aspectNumber(L.frame.aspect)
}

// A change from the inspector. Browser chrome switched with the page's place known
// moves the crop with it, as the document does for an agent (FD.chromeCrop).
function setLook(patch) {
  const was = LookLib.resolve(ed.look)
  ed.look = LookLib.merge(was, patch).look
  if (was.frame.chrome !== ed.look.frame.chrome && ed.doc && ed.doc.viewport) {
    const d = require('./ui/fetchdoc').chromeCrop({ look: ed.look, viewport: ed.doc.viewport, crop: ed.crop }, was.frame.chrome)
    ed.crop = d.crop
    try { paintCrop() } catch {}
  }
  // Captions keep their own tab, and docFromEd writes that tab's copy over the look's
  // last. Now that the inspector shows the captions section too, a change made there
  // has to reach ed.capStyle or the autosave would put it back a moment later.
  // The inspector sends one field at a time by its path ({'captions.scale': 1.4}), so
  // a nested patch.captions is never what arrives from the Look tab and the mirror
  // never ran: the person dragged Caption size, ed.look changed, and docFromEd wrote
  // ed.capStyle back over it a moment later. Read the paths, and take a nested patch
  // too, since apply_look and the preset picker send one.
  const capKeys = Object.keys(patch || {}).filter(k => k === 'captions' || k.startsWith('captions.'))
  if (capKeys.length) {
    const C = ed.look.captions
    ed.capStyle = { ...ed.capStyle, font: C.font, scale: C.scale, colour: C.colour, position: C.position, highlight: C.highlight }
    if (C.fx != null && C.fy != null) { ed.capStyle.fx = C.fx; ed.capStyle.fy = C.fy } else { delete ed.capStyle.fx; delete ed.capStyle.fy }
    const burn = $('burnCaps')
    const showed = capKeys.includes('captions.show') || (patch.captions && typeof patch.captions === 'object' && 'show' in patch.captions)
    if (burn && showed) burn.checked = !!C.show
    try { paintCapHl() } catch {}
  }
  syncLookMirrors()
  paintBackdrop()
  try { paintCaption() } catch {}
}

function mountLook() {
  const root = $('lookInspector')
  if (!root) return
  lookUI = InspectorLib.create(root, {
    get: () => ed.look || LookLib.defaults(),
    set: patch => setLook(patch),
    // no allow-list of sections: it hid the whole of treatment, grain, device, captions,
    // typography and focus from the person while an agent could set every one of them,
    // and the renderer draws them. What a renderer cannot draw is the schema's own
    // question now (ui/look-schema.js), asked once, in one place.
    //
    // The one exception is captions on a shot. They are drawn from the words spoken in
    // a take and a capture has none, so Shot.toExportOpts always sends cues: []. Six
    // dials whose values are stored and never drawn are worse than no dials, which is
    // the same reason the Text tab is gone on a shot.
    sections: ed.shot ? LookLib.sections().map(s => s.id).filter(id => id !== 'captions') : null,
    open: ['frame', 'background', 'motion'],
    userDir: LOOK_DIR,
    ico, toast,
    assets: () => lookBackdropList.filter(b => b.image),
    onAddAsset: done => pickBackdropImage(done),
    // a photograph downloaded from the picker is a new backdrop on disk, so the list
    // the inspector draws from is read again rather than left a search behind
    onAssetsChanged: () => loadLookBackdrops(),
    // A name from a known list is a list, not a text box. The Look tab drew Font as a
    // free input while the Captions tab drew the same field as a dropdown, so the same
    // setting had two controls and one of them took any string (J6).
    choices: { 'captions.font': () => FONTS.map(f => ({ ...f, font: fontCss(f.id) })) },
    notes: {
      'frame.aspect': L => L.frame.aspect === 'auto' ? "Keeps your recording's shape."
        : L.background.kind === 'none' ? 'The space round your recording is filled with a soft blur of it, never black bars.'
        : 'Your recording is fitted inside this shape on the background.',
      'frame.chrome': () => ed.doc && ed.doc.viewport ? 'Fetch knows where the page sits in this browser take.'
        : 'Only for browser takes an agent recorded. Use Crop for others.',
    },
    extras: {
      // auto zoom is part of the edit, not the look, so it sits here by its depth
      motion: () => (ed.shot
        // The look is stored whole on a shot and pinned only as it is drawn
        // (ui/shot.js STILL_PINS), so a fade set on a recording survives a trip
        // through one. Saying so beats a section of dials that quietly do nothing.
        ? `<p class="micro dimmer lk-note">A shot is one frame, so the fades, the
            arrival, the loop and the motion blur are off in it. They are kept, and
            come back when this look is used on a recording.</p>`
        : `<label class="lk-top lk-bool"><span class="lk-lbl">Auto zoom on clicks</span>
          <span class="switch"><input type="checkbox" id="autoZoom" ${ed.autoZoom ? 'checked' : ''} ${ed.hasCursor === false ? 'disabled' : ''}><span class="track"></span></span></label>
        <p class="micro dimmer lk-note" id="zoomNote">${ed.hasCursor === false ? 'No cursor track: only recordings made by Fetch can auto zoom.'
          : 'Pushes in where the cursor clicks or settles.'}</p>`),
    },
  })
  root.addEventListener('change', e => { if (e.target.id === 'autoZoom') ed.autoZoom = e.target.checked })
  loadLookBackdrops()
}

// Upload runs in the renderer with a file input, no main process round trip.
// Files are copied into userData so they survive an app update. done(id) gets the
// backdrop's id (img:user/<file>) once it is in the list.
function pickBackdropImage(done) {
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
    await loadLookBackdrops()
    done('img:user/' + path.basename(dest))
    if (small) toast(`Added, but it is ${Fmt.size(dims.w, dims.h)}. Under ${Fmt.size(1920, 1080)} will look soft.`, 'bad', 6500)
    else if (offAspect) toast(`Added. At ${ratio}:1 it will be cropped to fit 16:9.`, '', 5500)
    else toast(`Added ${Fmt.size(dims.w, dims.h)} backdrop`, 'ok')
  }
  input.click()
}

// live preview of the framed look: no export needed to see it
const BD_CSS = {
  dusk:   'linear-gradient(135deg,#F0A93C,#7A3E12)',
  ember:  'linear-gradient(135deg,#FF6B4A,#7A1F3D)',
  mint:   'linear-gradient(135deg,#63E6BE,#0B7285)',
  violet: 'linear-gradient(135deg,#A78BFA,#3B1D6E)',
  slate:  'linear-gradient(135deg,#64748B,#0F172A)',
  ink:    'linear-gradient(135deg,#2A2320,#0A0908)',
  studio: 'linear-gradient(135deg,#8A6A3C,#1F1A16)',
  blur:   '#1A1714',     // the real fill is the canvas layer below
}
// The blur backdrop previews as the current frame, blurred by CSS, behind the video.
// Redrawn on load, seek and pause, not per frame: it is a background, and the export
// is what renders it exactly.
// A shape with no background is filled the same way (never black bars), so the
// stage shows the blurred take round it as the export does.
const blurFilled = () => ed.backdrop === 'blur' || (!ed.backdrop && !!ed.outAspect)
function paintBlurFill(frame, v) {
  let c = frame.querySelector('canvas.bd-fill')
  if (!blurFilled()) { if (c) c.remove(); return }
  if (!c) {
    c = document.createElement('canvas')
    c.className = 'bd-fill'
    frame.prepend(c)
    const draw = () => {
      // the take's own pixels, or the capture's: both answer srcSize
      const p = srcSize(v)
      if (!blurFilled() || !p.w) return
      // the cropped frame, as the export blurs it
      const s = stageView(), sw = p.w * s.w, sh = p.h * s.h
      c.width = 320; c.height = Math.round(320 * sh / sw)
      try { c.getContext('2d').drawImage(v, p.w * s.x, p.h * s.y, sw, sh, 0, 0, c.width, c.height) } catch {}
    }
    for (const ev of ['loadeddata', 'seeked', 'pause', 'load']) v.addEventListener(ev, draw)
    c._draw = draw
  }
  c._draw()
}
// Fit the video inside the stage, keeping its aspect. Done in JS because
// max-height:100% does not clamp a replaced element whose height is derived from
// its own intrinsic aspect: the video kept its width-driven height, overflowed the
// stage, and overflow:hidden cut off the bottom of the frame, captions included.
// The part of the recording the stage shows: the crop, as the export frames it, and
// the whole picture only on the Crop tab, where the handles need it. It showed the
// whole recording everywhere, so the browser's tab and address bars the crop removes
// were on the stage but never in the file.
function stageView() {
  const c = ed.crop
  return c && ed.tab !== 'crop' && c.w > 0 && c.h > 0 ? c : { x: 0, y: 0, w: 1, h: 1 }
}
function stageAR(v) {
  const s = stageView()
  const p = srcSize(v)
  const ar = (ed.videoW && ed.videoH) ? ed.videoW / ed.videoH
    : (p.w && p.h) ? p.w / p.h : 16 / 9
  return ar * s.w / s.h
}
function fitVideoInto(v, availW, availH) {
  if (!v || !availW || !availH) return
  const ar = stageAR(v)
  let w = availW, h = w / ar
  if (h > availH) { h = availH; w = h * ar }
  v.style.width = Math.round(w) + 'px'
  v.style.height = Math.round(h) + 'px'
}

function fitVideoToStage(v) {
  const stage = $('edCanvas')
  if (!stage || !v) return
  fitVideoInto(v, stage.clientWidth, stage.clientHeight)
}
function paintBackdrop() {
  const frame = $('stageFrame'), v = srcEl()
  if (!frame || !v) return
  if (!ed.backdrop) {
    paintBlurFill(frame, v)
    frame.dataset.bd = 'none'
    frame.style.background = ''
    frame.style.aspectRatio = ''
    frame.style.padding = '0'
    v.style.objectFit = ''
    v.style.borderRadius = ''
    v.style.boxShadow = ''
    // An output shape has to change the preview even with no backdrop, otherwise
    // the stage shows the source shape while the export letterboxes into another
    // one. Mirrors the scale+pad the exporter applies in this same case.
    if (ed.outAspect) {
      const stage = $('edCanvas')
      const availW = stage.clientWidth, availH = stage.clientHeight
      let boxW = availW, boxH = boxW / ed.outAspect
      if (boxH > availH) { boxH = availH; boxW = boxH * ed.outAspect }
      frame.style.width = Math.round(boxW) + 'px'
      frame.style.height = Math.round(boxH) + 'px'
      frame.style.background = '#1A1714'      // under the blurred fill while it draws
      fitVideoInto(v, boxW, boxH)
    } else {
      frame.style.height = ''; frame.style.width = ''
      fitVideoToStage(v)
    }
    renderTexts(); paintCam(); paintStageGL({ fresh: true })
    return
  }
  frame.dataset.bd = ed.backdrop
  paintBlurFill(frame, v)
  frame.style.background = ed.backdropFile
    ? `url("file://${encodeURI(ed.backdropFile).replace(/"/g, '%22')}") center/cover no-repeat`
    : String(ed.backdrop).startsWith('color:') ? ed.backdrop.slice(6)
    : (BD_CSS[ed.backdrop] || BD_CSS.dusk)
  const inset = ed.look ? ed.look.frame.padding : 0.06
  // Laid out with the export's own geometry (Overlays.backdropGeometry) on the frame
  // the export frames, the crop, then scaled to the stage. An approximation of it
  // put the window at about 70% of the stage where the file has it at 83%.
  // Explicit pixel sizes for both boxes, computed synchronously: requestAnimationFrame
  // does not fire while the window is not being composited.
  const stage = $('edCanvas')
  const view = stageView()
  const pix = srcSize(v)
  const vw = (ed.videoW || pix.w || 1920) * view.w, vh = (ed.videoH || pix.h || 1080) * view.h
  // Burned captions get a band of their own below the video, on the backdrop, as the
  // export draws them (Overlays.captionLayout)
  const cst = ed.capStyle || {}
  const capsOn = !!($('burnCaps') && $('burnCaps').checked && ed.cues.length &&
    (!cst.position || cst.position === 'bottom') && cst.fx == null)
  const r = ed.look ? ed.look.frame.radius : 14
  const g = ovLib().backdropGeometry(vw, vh, { inset, radius: r, band: capsOn ? ovLib().CAP_BAND : 0,
    outWidth: 1920, outAspect: ed.outAspect || null })
  const sc = Math.min(stage.clientWidth / g.outW, stage.clientHeight / g.outH)
  frame.style.aspectRatio = ''
  frame.style.padding = '0'
  frame.style.width = Math.round(g.outW * sc) + 'px'
  frame.style.height = Math.round(g.outH * sc) + 'px'
  fitVideoInto(v, g.vidW * sc, g.vidH * sc)
  // the frame centres the video's margin box, so this hangs it from the top margin
  const under = (g.outH - g.vidH - 2 * g.oy) * sc
  v.style.marginBottom = under > 0.5 ? Math.round(under) + 'px' : ''
  v.style.objectFit = 'contain'
  // no tighter than the window's own corner, as the export (processor backdropChain)
  const radius = Math.max(g.radius, ed.windowCorner ? Math.ceil(ed.windowCorner * g.vidW * 1.45) + 2 : 0)
  v.style.borderRadius = Math.max(2, Math.round(radius * sc)) + 'px'
  // frame.shadow, where 0.6 is the stage's own shadow
  v.style.boxShadow = `0 18px 44px -12px rgba(0,0,0,${Math.min(1, 1.25 * (ed.look ? ed.look.frame.shadow : 0.6)).toFixed(2)})`
  setTimeout(() => { try { renderTexts(); paintCaption() } catch {} }, 0)
  renderTexts()
  paintStageGL({ fresh: true })
}

function paintSwatches() {
  const c = (cur().color || '#FFFFFF').toLowerCase()
  document.querySelectorAll('.sw').forEach(b =>
    b.setAttribute('aria-selected', String(b.dataset.c.toLowerCase() === c)))
}

function paintTextRange() {
  const t = cur()
  $('txtRange').textContent = (t.start != null && t.end != null)
    ? `Shows ${Fmt.clock(t.start)} to ${Fmt.clock(t.end)}` : 'Shows for the whole clip'
  renderTextTrack()
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
    const n = el('div', 'cue', `<span class="t">${Fmt.clock(c.start)}</span><span class="x" contenteditable>${escHtml(c.text || '')}</span>`)
    n.dataset.i = i
    n.onclick = e => { if (e.target.classList.contains('x')) return; seek(c.start) }
    n.querySelector('.x').onblur = e => { c.text = e.target.textContent.trim(); ipcRenderer.invoke('write-cues', ed.src, ed.cues) }
    list.appendChild(n)
  })
}
// Preview of what burn-in will produce. Mirrors the caption style controls so
// what you see on the stage is what lands in the file.
function paintCaption() {
  paintOverlays()
  const box = $('capOverlay'); if (!box) return
  const span = box.firstElementChild
  if (span.dataset.editing === 'true') return // being edited in place, leave it alone
  // the phrase on screen, as the export breaks the transcript into phrases
  const ph = capPhrases().find(p => ed.cur >= p.show && ed.cur < p.hide)
  if (!ph) { box.dataset.on = 'false'; return }
  const st = ed.capStyle || {}
  const v = srcEl(), frame = $('stageFrame')
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
  // the same size and anchor the export computes, kept clear of the framed video's edge
  const pic = anchor === v ? null : ovPicture(v)
  const L = ovLib().captionLayout(vb.width, vb.height, st,
    pic ? { x: pic.left - vb.left, y: pic.top - vb.top, w: pic.w, h: pic.h } : null)
  // style first: the clamp below needs the caption's real measured size
  const hl = st.highlight === 'none' ? null : st.highlight === 'pill' ? 'pill' : 'word'
  const on = ph.words.findIndex(w => ed.cur >= w.start && ed.cur < w.end)
  let k = 0
  span.innerHTML = ph.lines.map(n => {
    const line = ph.words.slice(k, k + n).map((w, j) => `<span class="w"${hl && k + j === on
      ? (hl === 'pill' ? ' data-pill="true"' : ' data-on="true"') : ''}>${escHtml(w.text)}</span>`).join(' ')
    k += n
    return line
  }).join('<br>')
  span.style.fontFamily = fontCss(st.font)
  span.style.fontSize = Math.max(9, L.px / 1.18) + 'px'
  span.style.color = st.colour || '#FFFFFF'
  span.dataset.boxed = 'false'
  box.style.paddingBottom = L.an === 2 ? Math.max(0, vb.height - L.y) + 'px' : ''
  box.style.paddingTop = L.an === 8 ? L.y + 'px' : ''
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
  } else if (L.an === 5 && vb.height) {
    // centred in the band under a framed video, where the export draws it (captionLayout)
    box.dataset.pos = 'free'
    span.style.left = (L.x / vb.width * 100) + '%'
    span.style.top = (L.y / vb.height * 100) + '%'
    // positioned, it would shrink to its longest word; the band phrase is one line
    span.style.whiteSpace = 'nowrap'
  } else {
    span.style.left = ''; span.style.top = ''
  }
  if (!(L.an === 5 && st.fx == null)) span.style.whiteSpace = ''
}

// ── overlays on the stage ───────────────────────────────────────────────
// What ui/overlays.js burns into the export, previewed live: captions phrased and
// highlighted the same way, step badges, lifts, spotlights, blurs and title cards. CSS
// stands in for libass, so it is close rather than exact: the blur's edge is not
// feathered here. Explicit zooms are previewed (paintZoom); auto zoom is not.
// A function, not a const: renderTexts can run before this line has been reached
function ovLib() { return require('./ui/overlays') }
var ovCaps = { key: null, phrases: [] }

function capPhrases() {
  // in the band under a framed video a phrase has the whole width, one line, as exported
  const st = ed.capStyle || {}
  const band = !!(ed.backdrop && (!st.position || st.position === 'bottom') && st.fx == null)
  const key = ed.src + '#' + band + '#' + ed.cues.length + ':' + ed.cues.map(c => c.start + c.text).join('|')
  if (ovCaps && key === ovCaps.key) return ovCaps.phrases
  let words = null
  try { words = JSON.parse(fs.readFileSync(sidecarIn(ed.src, '.words.json'), 'utf8')) } catch {}
  // on the voice, as the export times them (Overlays.spokenWords)
  const o = band ? { wrapAt: ovLib().BAND_WRAP } : {}
  ovCaps = { key, phrases: ovLib().phraseTimes(ovLib().captionPhrases(ovLib().spokenWords(ed.cues, words), o)) }
  return ovCaps.phrases
}

// Texts are placed on the source clock; styles are judged on the output's, from the in point
function ovSpan() { return Math.max(0, (ed.out || ed.dur || 0) - (ed.in || 0)) }
function ovRel(t) { return { ...t, start: t.start != null ? t.start - (ed.in || 0) : null, end: t.end != null ? t.end - (ed.in || 0) : null } }

function paintMusic() {
  const seg = $('musicBed'); if (!seg) return
  for (const b of seg.querySelectorAll('[data-bed]')) b.setAttribute('aria-selected', String((b.dataset.bed || null) === (ed.music || null)))
}
function paintCapHl() {
  const hl = (ed.capStyle && ed.capStyle.highlight) || 'word'
  const seg = $('capHl')
  if (seg) seg.querySelectorAll('button').forEach(x => x.setAttribute('aria-selected', String(x.dataset.hl === hl)))
}

// The picture inside the video element, which letterboxes when framed, in page pixels
function ovPicture(v) {
  const r = v.getBoundingClientRect(), f = $('stageFrame').getBoundingClientRect()
  const ar = stageAR(v) || r.width / r.height
  let w = r.width, h = w / ar
  if (h > r.height) { h = r.height; w = h * ar }
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, w, h, fl: f.left, ft: f.top }
}

// Explicit zooms (Z1, Z2) previewed on the stage with the export's own curve
// (Overlays.zoomView). object-view-box crops inside the video element, so the rounded
// corners, the shadow and the backdrop stay put while the picture pushes in. The same
// view box shows only the crop (stageView), and zoom coordinates live in that cropped
// frame, so the window is kept at the picture's shape inside it. Off on the Crop tab,
// where the handles need the whole picture. timeupdate only fires about four times a
// second, so while playing a zoom is repainted on every video frame.
var zoomLoop = false
function paintZoom(t, pic) {
  const v = srcEl(), layer = document.querySelector('#stageFrame .ov-zoom')
  if (!v) return
  const z = ed.tab === 'crop' ? { s: 1 } : ovLib().zoomView(ed.zooms, t, (ed.look && ed.look.motion || {}).zoomEase)
  const view = stageView(), c = ed.crop && ed.tab !== 'crop' ? ed.crop : null
  // the cropped frame in the picture's own fractions: the whole picture unless the Crop tab shows all of it
  const fr = c ? { x: (c.x - view.x) / view.w, y: (c.y - view.y) / view.h, w: c.w / view.w, h: c.h / view.h } : { x: 0, y: 0, w: 1, h: 1 }
  let box = null
  if (z.s > 1.001) {
    const k = Math.min(1, Math.max(z.w * fr.w, z.h * fr.h))
    const mx = fr.x + (z.x + z.w / 2) * fr.w, my = fr.y + (z.y + z.h / 2) * fr.h
    box = { x: Math.max(0, Math.min(1 - k, mx - k / 2)), y: Math.max(0, Math.min(1 - k, my - k / 2)), k }
  }
  const pct = n => (n * 100).toFixed(3) + '%'
  // the box is in the picture's fractions; the view box wants the recording's
  const src = box ? { x: view.x + box.x * view.w, y: view.y + box.y * view.h, w: box.k * view.w, h: box.k * view.h } : view
  const whole = src.x <= 0 && src.y <= 0 && src.w >= 1 && src.h >= 1
  v.style.objectViewBox = whole ? '' : `inset(${pct(src.y)} ${pct(1 - src.x - src.w)} ${pct(1 - src.y - src.h)} ${pct(src.x)})`
  // Chromium paints a view box's picture out to the element's edges, so a letterboxed
  // video spilled a wider zoomed picture into its bars. Clipped to the picture itself.
  if (pic) {
    const r = v.getBoundingClientRect(), l = pic.left - r.left, tp = pic.top - r.top
    const bars = l > 0.5 || tp > 0.5
    v.style.clipPath = bars ? `inset(${tp.toFixed(1)}px ${l.toFixed(1)}px round ${getComputedStyle(v).borderTopLeftRadius})` : ''
  }
  if (layer) {
    layer.style.transform = box && pic ? `scale(${1 / box.k}) translate(${-box.x * pic.w}px, ${-box.y * pic.h}px)` : ''
  }
  // paused, an edit or a seek redraws the stage's canvas; playing, its own loop does
  if (v.paused) paintStageGL({ fresh: true })
  if ((ed.zooms || []).length && !v.paused && !zoomLoop && v.requestVideoFrameCallback) {
    zoomLoop = true
    v.requestVideoFrameCallback((_, meta) => {
      zoomLoop = false
      ed.cur = meta.mediaTime
      paintOverlays()
    })
  }
  return box
}

function paintOverlays() {
  const frame = $('stageFrame'), v = srcEl()
  if (!frame || !v || !v.getBoundingClientRect().width) return
  let host = frame.querySelector('.ov-stage')
  if (!host) {
    host = el('div', 'ov-stage', '<div class="ov-clip"></div><div class="ov-card"></div>')
    v.after(host)
  }
  const t = ed.cur || 0
  const pic = ovPicture(v)
  const clip = host.querySelector('.ov-clip')
  clip.style.left = (pic.left - pic.fl) + 'px'; clip.style.top = (pic.top - pic.ft) + 'px'
  clip.style.width = pic.w + 'px'; clip.style.height = pic.h + 'px'
  clip.style.borderRadius = getComputedStyle(v).borderRadius
  // marks live in the cropped frame, which is the whole picture unless the Crop tab
  // shows all of the recording; then they are mapped through the crop onto it
  const view = stageView(), c0 = ed.crop || view
  const c = { x: (c0.x - view.x) / view.w, y: (c0.y - view.y) / view.h, w: c0.w / view.w, h: c0.h / view.h }
  const cw = c.w * pic.w, ch = c.h * pic.h, cx = c.x * pic.w, cy = c.y * pic.h
  // marks are drawn before the zoom in the export, so they ride it here as well
  let layer = clip.querySelector('.ov-zoom')
  if (!layer) { layer = el('div', 'ov-zoom'); clip.appendChild(layer) }
  const zb = paintZoom(t, pic)
  const seen = new Set()
  let stepK = 0
  for (const m of ed.marks || []) {
    if (m && m.kind === 'step') stepK++
    if (!m || !m.id || !['step', 'spotlight', 'lift', 'blur'].includes(m.kind)) continue
    seen.add(m.id)
    const focus = m.kind === 'spotlight' || m.kind === 'lift'
    const cls = m.kind === 'step' ? 'ov-step' : focus ? 'ov-focus' : 'ov-blur'
    // A cutout sits outside the zoom layer: Chromium ignores a clip-path hole in a
    // backdrop blur, and a mask one inside a scaled ancestor, so the piece meant to be
    // crisp came out blurred. Its zoom is applied by hand below instead.
    const home = focus ? clip : layer
    let n = clip.querySelector(`[data-id="${m.id}"]`)
    if (!n || n.parentNode !== home || !n.classList.contains(cls) || n.dataset.kind !== m.kind) {
      if (n) n.remove()
      n = el('div', cls, focus ? '<div class="ov-focus-lift"></div><div class="ov-focus-dim"></div>' : '')
      n.dataset.id = m.id; n.dataset.kind = m.kind; home.appendChild(n)
    }
    // a lift or spotlight rides a nearby zoom in the export, so it does here too
    const on = focus ? ovLib().spotlightSpan(m, ed.zooms, (ed.look && ed.look.motion || {}).zoomEase) : { a: m.start, b: m.end }
    n.dataset.on = String(t >= on.a && t < on.b)
    if (focus) {
      // The export's own cutout (Overlays.focusShape) on the cropped frame, seen at the
      // largest zoom it rides as the export sizes it: the rest dimmed and lightly
      // blurred through a feathered rounded hole (a luminance mask, which a backdrop
      // blur honours), and for a lift a ring and shadow that rise with the piece.
      const zs = Math.max(1, ...(ed.zooms || []).filter(z => z && Math.min(z.end, on.b) - Math.max(z.start, on.a) > 0.3).map(z => +z.scale || 1))
      const s = ovLib().focusShape(m, cw, ch, { px: 1080 / ch, seen: zs, radius: m.radius })
      const k = zb ? zb.k : 1, ox = zb ? zb.x * pic.w : 0, oy = zb ? zb.y * pic.h : 0
      const W = cw / k, H = ch / k, x = s.x / k, y = s.y / k, w = s.w / k, h = s.h / k, r = s.r / k, f = v => v.toFixed(1)
      Object.assign(n.style, { left: f((cx - ox) / k) + 'px', top: f((cy - oy) / k) + 'px', width: f(W) + 'px', height: f(H) + 'px' })
      const dim = n.querySelector('.ov-focus-dim'), lift = n.querySelector('.ov-focus-lift')
      const soft = s.kind === 'lift' ? 0 : s.feather / k / 3
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${f(W)}' height='${f(H)}'>` +
        (soft > 0.3 ? `<filter id='f' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='${f(soft)}'/></filter>` : '') +
        `<rect width='100%' height='100%' fill='white'/><rect x='${f(x)}' y='${f(y)}' width='${f(w)}' height='${f(h)}' rx='${f(r)}' fill='black'` +
        (soft > 0.3 ? ` filter='url(%23f)'` : '') + `/></svg>`
      if (dim._svg !== svg) {
        dim._svg = svg
        Object.assign(dim.style, { maskImage: `url("data:image/svg+xml;utf8,${svg.replace(/</g, '%3C').replace(/>/g, '%3E')}")`,
          maskMode: 'luminance', maskSize: '100% 100%', maskRepeat: 'no-repeat' })
      }
      Object.assign(dim.style, { background: `rgba(10,9,8,${s.dim})`, backdropFilter: `blur(${f(Math.max(0.5, s.blur / k))}px)` })
      Object.assign(lift.style, { left: f(x) + 'px', top: f(y) + 'px', width: f(w) + 'px', height: f(h) + 'px', borderRadius: f(r) + 'px',
        boxShadow: s.kind === 'lift' ? `0 ${f(s.shadow.dy / k)}px ${f(s.shadow.soft / k)}px rgba(0,0,0,${s.shadow.alpha * 0.6})` : '',
        transform: n.dataset.on === 'true' ? `scale(${s.lift})` : '' })
      continue
    }
    if (m.kind === 'step') {
      const D = Math.max(12, 0.046 * ch)
      n.textContent = ovLib().stepLabel(m, stepK)
      Object.assign(n.style, { width: D + 'px', height: D + 'px', left: (cx + m.x * cw) + 'px', top: (cy + m.y * ch) + 'px',
        borderWidth: Math.max(1.5, D * 0.05) + 'px', fontSize: (D * (n.textContent.length > 1 ? 0.46 : 0.56) / 1.18) + 'px',
        boxShadow: `0 ${D * 0.07}px ${D * 0.16}px rgba(0,0,0,.36)` })
    } else {
      const x0 = cx + m.x * cw, y0 = cy + m.y * ch
      const w = (m.w || 0.2) * cw, h = (m.h || 0.1) * ch
      Object.assign(n.style, { left: x0 + 'px', top: y0 + 'px', width: w + 'px', height: h + 'px',
        borderRadius: Math.min(0.014 * ch, w / 2, h / 2) + 'px' })
    }
  }
  clip.querySelectorAll('[data-id]').forEach(n => { if (!seen.has(n.dataset.id)) n.remove() })

  // a title card: the frame blurred and dimmed behind the title, clearing as it ends
  const span = ovSpan(), rel = t - (ed.in || 0)
  let card = 0
  for (const k of ovLib().titleCards((ed.texts || []).map(ovRel), span)) {
    if (rel < k.a || rel >= k.b) continue
    const out = k.opens ? Math.min(1, (k.b - rel) / k.fade) : k.b < span - 0.05 ? Math.min(1, (k.b - rel) / 0.4) : 1
    card = Math.max(card, Math.min(out, k.opens ? 1 : Math.min(1, (rel - k.a) / k.fade)))
  }
  host.querySelector('.ov-card').style.opacity = card.toFixed(3)
  // text layers show when they are on screen and fade back when not
  document.querySelectorAll('.txt-layer[data-i]').forEach(n => {
    const x = ed.texts[+n.dataset.i]
    n.dataset.live = String(!x || x.start == null || x.end == null || (t >= x.start && t < x.end))
  })
}

// ── camera bubble ───────────────────────────────────────────────────────
// The bubble was recorded to its own file rather than burned into the screen
// capture, which is what lets it be moved and resized here.
function loadCamTake(src) {
  ed.cam = null
  const btn = $('camTabBtn')
  try {
    const j = JSON.parse(fs.readFileSync(sidecarIn(src, '.cam.json'), 'utf8'))
    // Find the camera take beside the recording, not at the absolute path written
    // into the sidecar when it was made. That stored path goes stale the moment the
    // recording is renamed: the files move together but the path inside the JSON does
    // not, so every renamed take silently lost its camera. The stored path is kept only
    // as a fallback for sidecars written before this.
    const beside = sidecarIn(src, '.cam.mov')
    const file = fs.existsSync(beside) ? beside : j.file
    if (!file || !fs.existsSync(file)) throw new Error('no take')
    j.file = file          // export reads ed.cam.file, so it must see the live path too
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
  // with the stage on the canvas this bubble is only the invisible handle: the one seen
  // is drawn there, so a drag, the size slider or a corner has to redraw it
  if (frame && frame.dataset.gl === 'on') queueMicrotask(() => paintStageGL({ fresh: true }))
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
    const v = (ed.backdrop && $('stageFrame')) ? $('stageFrame') : srcEl()
    if (!v) return
    const vb = v.getBoundingClientRect()
    // Move by the distance dragged, and only after a real drag. It used to put the
    // caption's centre wherever the pointer was, so any click with a wobble (every
    // half of a double-click) snapped the caption to the cursor.
    const x0 = e.clientX, y0 = e.clientY
    const sb = span.getBoundingClientRect()
    const fx0 = ed.capStyle.fx != null ? ed.capStyle.fx : (sb.left + sb.width / 2 - vb.left) / vb.width
    const fy0 = ed.capStyle.fy != null ? ed.capStyle.fy : (sb.top + sb.height / 2 - vb.top) / vb.height
    let dragging = false
    const move = ev => {
      if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return
      dragging = true
      ed.capStyle.fx = Math.max(0.02, Math.min(0.98, fx0 + (ev.clientX - x0) / vb.width))
      ed.capStyle.fy = Math.max(0.04, Math.min(0.96, fy0 + (ev.clientY - y0) / vb.height))
      paintCaption()
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  span.ondblclick = e => {
    e.preventDefault(); e.stopPropagation()
    const cue = ed.cues.find(c => ed.cur >= c.start && ed.cur <= c.end)
    if (!cue) return
    // The preview draws each word as its own element for the highlight. Editing that
    // markup lost the spaces ("choosesafavoriteyou"), so edit the cue as plain text.
    span.textContent = cue.text
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
    <div class="modal-head">${ico('export', 'icon-lg')}<span class="modal-title">Export</span></div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:16px">
      <div><div class="insp-sec">Format</div>
        <div class="aspect-chips" id="fmtChips">
          ${fmts.map((f, i) => `<button class="chip" data-fmt="${f.id}" aria-pressed="${i === 0}">${f.label}</button>`).join('')}
        </div></div>
      <div><div class="insp-sec">Quality</div>
        <div class="aspect-chips" id="qChips">
          ${[['high', 'High'], ['balanced', 'Balanced'], ['small', 'Small']].map((q, i) => `<button class="chip" data-q="${q[0]}" aria-pressed="${i === 1}">${q[1]}</button>`).join('')}
        </div></div>
      <div><div class="insp-sec">Resolution</div>
        <div class="aspect-chips" id="resChips">
          ${[['', 'Original'], ['1080', '1080p'], ['720', '720p']].map((r, i) => `<button class="chip" data-res="${r[0]}" aria-pressed="${i === 0}">${r[1]}</button>`).join('')}
        </div></div>
      <div><div class="insp-sec">Saves to</div>
        <div class="exp-dest">${ico('file-video', 'icon-sm')}<span class="mono" id="expDest"></span></div>
        <p class="micro dimmer" id="expReplace" hidden>Replaces the last export. The original recording is kept.</p></div>
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
  const summary = () => {
    scrim.querySelector('#expSummary').textContent =
      Fmt.join(Fmt.clock(outLen()), pick.fmt.toUpperCase(), pick.q[0].toUpperCase() + pick.q.slice(1), pick.res ? pick.res + 'p' : '')
    paintDest()
  }
  // Every export of a take rewrites <Take>/<Take>.mp4, so say so before the click,
  // not after: the take's folder and file, and whether one is already there.
  const paintDest = async () => {
    const fmt = pick.fmt
    let d
    try { d = await ipcRenderer.invoke('export-dest', ed.src, fmt) } catch { return }
    if (fmt !== pick.fmt || !scrim.isConnected) return
    const home = require('os').homedir()
    const shown = d.take ? path.join(path.basename(path.dirname(d.file)), path.basename(d.file))
      : d.file.startsWith(home + '/') ? '~' + d.file.slice(home.length) : d.file
    const n = scrim.querySelector('#expDest')
    n.textContent = shown; n.title = d.file
    scrim.querySelector('#expReplace').hidden = !d.exists
  }
  // what actually comes out: the trimmed range minus the cuts inside it
  const outLen = () => Math.max(0, (ed.out - ed.in) - (ed.cuts || []).reduce((n, [a, b]) =>
    n + Math.max(0, Math.min(b, ed.out) - Math.max(a, ed.in)), 0))
  group('[data-fmt]', 'fmt'); group('[data-q]', 'q'); group('[data-res]', 'res'); summary()
  // One close for every modal (K5): Cancel, Esc, or the scrim. No header cross here
  // and none on Convert, Move to Trash or New folder either.
  const close = modalCloser(scrim)
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
    // A beat of celebration between "encoding" and the Library, so finishing an
    // export feels like an arrival rather than a window vanishing.
    finish(line) {
      const dog = scrim.querySelector('.export-dog')
      if (dog) dog.replaceWith(Object.assign(new Image(), { src: './assets/mascot/celebrating.png', className: 'export-dog export-dog-done', alt: '' }))
      const t = scrim.querySelector('.export-title'); if (t) t.textContent = 'Fetched.'
      scrim.querySelector('#expPhase').textContent = line || 'Done'
      scrim.querySelector('#expPct').textContent = ''
      const f = scrim.querySelector('#expFill'); if (f) f.style.width = '100%'
      const c = scrim.querySelector('#expCancel'); if (c) c.remove()
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
      return new Promise(r => setTimeout(() => { scrim.remove(); r() }, reduce ? 500 : 1100))
    },
  }
}

// A shot's export: one click, one file. There is no length, no quality and no
// resolution to ask about, so nothing is asked. The work bar in the inspector stands
// in for the full screen overlay a video gets, because a still is drawn in the time it
// takes to read that overlay's first word.
//
// The options are the stage's own, prepared reading and backdrop file included, so the
// PNG is the frame that was on screen rather than a second opinion of it.
//
// The editor stays open afterwards, where a video export leaves for the Library: a
// shot is usually written again with one dial moved, and a take rarely is.
async function exportShot() {
  const btn = $('doExport'), bar = $('expBar')
  if (!btn || btn.disabled) return
  const opts = ShotLib.toExportOpts(window.fetchShot.get(), {
    prepared: stagePrep.data && stagePrep.data.src === ed.src ? stagePrep.data : null,
    imageFile: ed.backdropFile || null,
  })
  btn.disabled = true
  if (bar) { bar.hidden = false; const l = bar.querySelector('.work-label'); if (l) l.textContent = 'Fetching your shot' }
  const cid = 'sh' + Date.now(), jobId = Date.now()
  jobs.set(cid, j => {
    if (j.status === 'done') {
      jobs.delete(cid); btn.disabled = false; if (bar) bar.hidden = true
      if (typeof mood === 'function') mood('happy')
      toast(`Shot saved${j.result && j.result.mb ? Fmt.SEP + Fmt.bytes(j.result.mb * 1e6) : ''}`, 'ok')
      if (typeof window.clearEditorDirty === 'function') window.clearEditorDirty()
      refreshLibrary()
      if (j.result && j.result.file) ipcRenderer.send('reveal', j.result.file)
    }
    if (j.status === 'error') {
      jobs.delete(cid); btn.disabled = false; if (bar) bar.hidden = true
      toast(j.message, 'bad', 7000)
    }
    if (j.status === 'cancelled') { jobs.delete(cid); btn.disabled = false; if (bar) bar.hidden = true }
  })
  return ipcRenderer.invoke('edit-job', { op: 'shot', src: ed.src, opts, out: { format: 'png', scale: 'native' }, cid, jobId })
}

async function doExport(pick) {
  // The edit as one document, read through the same adapter the MCP export and
  // preview_frame use. Options built here by hand from the controls dropped every
  // mark (redactions included) and read the look half from sliders, half from state.
  const FD = require('./ui/fetchdoc')
  const doc = window.fetchDoc.get()
  if (!doc.clips.length) doc.clips = [{ id: 'C1', start: 0, end: ed.dur }]
  const opts = FD.toExportOpts(doc, {
    format: pick.fmt, quality: pick.q,
    scale: pick.res ? +pick.res : undefined,
  })
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
    // exports run one at a time now, so say so rather than looking hung
    if (j.status === 'queued') ov.progress(null, 'Waiting for other work to finish')
    if (j.status === 'running') ov.progress(null, 'Encoding')
    if (j.status === 'progress' && j.pct != null) ov.progress(j.pct, 'Encoding')
    if (j.status === 'done') {
      jobs.delete(cid); $('doExport').disabled = false
      ov.finish(Fmt.join('Done', Fmt.bytes(j.result.mb * 1e6)))
      // Settings can retire the source once an export succeeds. Trash, never unlink,
      // so an accidental setting is always recoverable.
      if (window.prefs && window.prefs.keepOriginal === false && ed.src !== j.result.file) {
        const mb = j.result.mb
        trash([ed.src, ...sidecars(ed.src)]).then(n =>
          toast(n ? 'Exported, original moved to Trash' : Fmt.join('Exported', Fmt.bytes(mb * 1e6)), 'ok'))
      } else {
        toast(Fmt.join('Exported', Fmt.bytes(j.result.mb * 1e6)), 'ok')
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

// ── the stage, drawn by the compositor ─────────────────────────────────────
// The picture on the stage is the export's own renderer (ui/compositor/): one canvas,
// fed each frame the <video> presents (requestVideoFrameCallback), drawn from the same
// plan the export draws from, so the background, the corners, the shadow, a zoom and
// the camera bubble are the file's pixels, not a CSS imitation of them. The <video>
// stays in place at zero opacity (rVFC still fires, M0): it is what the caption,
// text and mark layers and the handles are laid out against, and the camera bubble
// stays a drag handle the same way. Fades draw only while playing, so a paused stage
// at the first frame is not black. The Crop tab shows the whole recording, so the
// canvas steps aside there. Without WebGL2 the old CSS stage is left as it was.
var stageGL = null          // { comp, spec, key, clock, ready } once made; false if WebGL2 is missing
// What the take's pixels say about the edit (ui/compositor/prepare.js: lifts fitted to
// their element, steps on their card's corner, the Mac's pointer and its clean patches,
// the cursor's rests, caption timings), asked of the main process once the edit settles
// and shared with the export there. The stage draws without it until it comes.
var stagePrep = { key: null, timer: null, data: null, v: 0 }

function askPrepared(opts) {
  // the look is in the key by everything prepare.js reads of it, which is every dial
  // that decides whether the take's own black and white points are measured. Keyed on
  // auto level alone, switching to a look that glows or grades left the stage on the
  // last answer, so it planned its shoulder off a take taken for a full range while the
  // export, which prepares its own, drew the measured one.
  const T = opts.look && opts.look.treatment
  const look = T ? [!!T.autoLevel, +T.bloom || 0, +T.halation || 0, +T.contrast || 0, +T.brightness || 0] : null
  const key = JSON.stringify([ed.src, opts.marks, opts.pointer, opts.hideMacCursor, opts.captions, opts.cues, opts.captionStyle,
    opts.backdrop, opts.crop, opts.start, opts.end, opts.cuts, opts.zooms, opts.autoZoom, look])
  if (key === stagePrep.key) return
  stagePrep.key = key
  clearTimeout(stagePrep.timer)
  const src = ed.src
  // the first ask for a take goes at once; edits after it wait for the hand to stop
  stagePrep.timer = setTimeout(() => {
    ipcRenderer.invoke('render-prepare', src, opts).then(p => {
      if (!p || ed.src !== src || stagePrep.key !== key) return
      stagePrep.data = p; stagePrep.v++
      paintStageGL({ fresh: true })
    }).catch(e => console.warn('stage: the take could not be read for marks and captions:', e && e.message))
  }, stagePrep.data && stagePrep.data.src === src ? 350 : 0)
}

// ── the shot's plan ─────────────────────────────────────────
// The three things Plan.prepare takes for a shot, decided in one place. The export
// builds its own from render-host.shotPlan, and the only way the stage and the PNG can
// disagree is if these two drift, so test/shot-stage.test.js holds this block against
// that one and fails when they do.
function shotPlanParts(shot, ctx = {}) {
  return {
    opts: ShotLib.toExportOpts(shot),
    // the meta prepare would have read off a take, on the rate render-host draws at
    meta: { ...ShotLib.toMeta(shot), fps: SHOT_FPS },
    // the reading of the capture and the backdrop file travel in ctx here and in opts
    // on the way to the export, because that is the shape each side takes them in
    ctx: { gutter: ctx.gutter || null, imageFile: ctx.imageFile || null,
      prepared: ctx.prepared || null, fps: SHOT_FPS },
  }
}

// ── the stage ───────────────────────────────────────────────
function stageGLSpec(fresh) {
  if (stageGL.spec && !fresh) return stageGL.spec
  const v = srcEl()
  const s = srcSize(v)
  const FD = require('./ui/fetchdoc')
  const Plan = require('./ui/compositor/plan')
  const Timeline = require('./ui/timeline')
  // One door to the compositor: a shot hands over the same options bag an edit does
  // (ui/shot.js toExportOpts), so the stage below cannot tell them apart and neither
  // can the renderer. render-host.shotPlan builds the export's spec from this same bag.
  const shot = ed.shot ? window.fetchShot.get() : null
  // asked for with the same bag it is planned with, so the reading that comes back is
  // of the frame that is drawn
  const first = shot ? ShotLib.toExportOpts(shot) : FD.toExportOpts(window.fetchDoc.get())
  askPrepared(first)
  const prepared = stagePrep.data && stagePrep.data.src === ed.src ? stagePrep.data : null
  const parts = shot ? shotPlanParts(shot, { gutter: ed.gutter, imageFile: ed.backdropFile, prepared }) : null
  const opts = parts ? parts.opts : first
  // the cadence comes with it: it is what decides the output rate (Timeline.outFps), so
  // leaving it behind planned the stage on a different frame grid than the export's
  const meta = parts ? parts.meta : { width: s.w, height: s.h, duration: ed.dur,
    fps: (ed.meta && ed.meta.fps) || 30, cadence: (ed.meta && ed.meta.cadence) || 0 }
  const ctx = parts ? parts.ctx : { gutter: ed.gutter || null, imageFile: ed.backdropFile || null, prepared }
  const key = JSON.stringify([opts, meta, ctx.gutter, ctx.imageFile, prepared ? stagePrep.v : 0])
  if (key !== stageGL.key) {
    stageGL.key = key
    stageGL.spec = Plan.prepare(opts, meta, ctx)
    stageGL.clock = Timeline.outClock(opts.cuts, stageGL.spec.start, stageGL.spec.end, opts.rates)
    // what a sped piece does with the take's own sound, so play sounds like the export
    stageGL.speedAudio = opts.speedAudio
    // and the stretches a clip muted outright, source seconds, for the same reason: the
    // one per-clip sound setting the stage can honour without applying the take's own
    // gain, which it has never applied either
    stageGL.muted = (opts.clipAudio || []).filter(c => c && c[2] && c[2].mute).map(c => [c[0], c[1]])
  }
  return stageGL.spec
}

// Play the take at the speed the edit says. The stage maps source time to output time
// for the picture, but the <video> element is what runs the clock, so a 4x stretch
// played back at 1 and the export drew two different videos from one document. The
// rate is read at the moment being played, which is what makes a ramp a ramp, and the
// element is muted exactly where processor.rateMutes mutes the export's own track.
function syncStageRate(v) {
  if (!v || !stageGL.clock) return
  const r = stageGL.clock.rate(v.currentTime)
  const rate = Math.min(16, Math.max(0.0625, +r || 1))
  if (Math.abs(v.playbackRate - rate) > 0.005) v.playbackRate = rate
  const t = v.currentTime
  const clipMuted = (stageGL.muted || []).some(([a, b]) => t >= a && t <= b)
  const mute = clipMuted || (stageGL.speedAudio !== 'keep' && rate > 1 + 1e-9)
  if (v.muted !== mute) v.muted = mute
}

// Where the output sits on the stage: the frame when the look frames the take or picks
// a shape, else the video's own box
function stageGLBox(frame, v, spec) {
  if (spec.framed || spec.bg.kind === 'blur') return { x: 0, y: 0, w: frame.clientWidth, h: frame.clientHeight }
  return { x: v.offsetLeft, y: v.offsetTop, w: v.offsetWidth, h: v.offsetHeight }
}

function paintStageGL({ fresh = false, upload = false, t = null } = {}) {
  const frame = $('stageFrame'), v = srcEl(), cv = $('stageGL')
  if (!frame || !v || !cv || stageGL === false) return
  const size = srcSize(v)
  const off = () => { if (lassoBand) lassoBand.hidden = true; if (frame.dataset.gl === 'on') { frame.dataset.gl = 'off'; paintCam() } }
  // stepped aside (the Crop tab, Original on a shot, a lost context): the frame it
  // holds goes stale, so the next paint uploads the source's own pixels again
  if (ed.tab === 'crop' || (ed.shot && ed.view === 'original') || !size.w || cv._lost) {
    if (stageGL) stageGL.ready = false
    return off()
  }
  try {
    if (!stageGL || stageGL.canvas !== cv) {
      // a fresh stage per take: the last one's context goes, or they pile up to the limit
      if (stageGL && stageGL.comp) stageGL.comp.destroy()
      const { Compositor } = require('./ui/compositor/gl')
      stageGL = { canvas: cv, comp: new Compositor(2, 2, { canvas: cv }), spec: null, key: null, ready: false }
      // only this canvas's own loss: destroying the last take's context fires one too,
      // after the new stage is made. A lost canvas stays on the CSS stage; the next take
      // gets a fresh canvas and tries again.
      cv.addEventListener('webglcontextlost', () => { cv._lost = true; if (stageGL && stageGL.canvas === cv) { stageGL = null; off() } })
    }
    const spec = stageGLSpec(fresh)
    const comp = stageGL.comp
    if (spec.bg.kind === 'image' && spec.bg.file && !comp.images.has(spec.bg.file)) {
      require('./ui/compositor').loadImage(spec.bg.file).then(img => { comp.setImage(spec.bg.file, img); comp.bgKey = null; paintStageGL() }).catch(() => {})
    }
    // the clean patches under the Mac's pointer and Biscuit's badge, once each
    if (stageGL.assets !== spec) {
      stageGL.assets = spec
      require('./ui/compositor').loadAssets(comp, spec).then(n => { if (n && v.paused) paintStageGL() }).catch(() => {})
    }
    const box = stageGLBox(frame, v, spec)
    if (!(box.w > 4 && box.h > 4)) return
    Object.assign(cv.style, { left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' })
    // the stage's own pixels, never more than the file's
    const dpr = window.devicePixelRatio || 1
    const k = Math.min(1, (box.w * dpr) / spec.W)
    comp.resize(spec.W * k, spec.H * k)
    if (upload || !stageGL.ready) {
      if (!ed.shot && v.readyState < 2) return
      comp.uploadImage('content', v, size.w, size.h)
      stageGL.ready = true
    }
    const src = ed.shot ? shotTime() : (t != null ? t : v.currentTime)
    const tOut = stageGL.clock(src)
    const fp = require('./ui/compositor/plan').framePlan(spec, tOut)
    if (ed.shot || v.paused) fp.fade = 1
    const s = spec.src, c = spec.crop
    // the camera's own <video>, kept on the take's clock by syncCam
    let cam = false, camUV = [0, 0, 1, 1]
    const cb = $('camBubble')
    if (spec.cam && cb && ed.cam && ed.cam.on !== false && fp.camT != null && cb.readyState >= 2 && cb.videoWidth) {
      comp.uploadImage('cam', cb, cb.videoWidth, cb.videoHeight)
      const a = cb.videoWidth / cb.videoHeight
      camUV = a > 1 ? [(1 - 1 / a) / 2, 0, 1 / a, 1] : [0, (1 - a) / 2, 1, a]
      cam = true
    }
    const shared = { cropUV: [c.x / s.w, c.y / s.h, c.w / s.w, c.h / s.h], cam, camUV, n: Math.round(tOut * spec.fps) }
    // no far side yet (the second <video> is still seeking): the near side is drawn on
    // its own, which is one plain frame rather than a stashed side and a frozen stage
    const xv = fp.mix > 0 ? stageCross(spec, fp) : null
    if (!comp.render(spec, fp, { ...shared, ...(xv ? { side: 'a' } : {}) })) return
    if (xv) {
      comp.uploadImage('content', xv, xv.videoWidth, xv.videoHeight)
      comp.render(spec, fp, { ...shared, side: 'b' })
      // the slot holds the far side now, so the next paint uploads the near one again
      stageGL.ready = false
    }
    comp.present()
    if (frame.dataset.gl !== 'on') { frame.dataset.gl = 'on'; paintCam() }
    if (ed.shot) paintShotSize()      // the look decides the size, so it is read off the plan
    // the lasso's band rides the same geometry, so it follows a zoom, a title card
    // and a resize without being told about any of them, and so do the handles on
    // whatever is selected
    paintLasso()
    // on its own: a throw in here would land in the catch below and take the whole
    // compositor stage down to the CSS one for the rest of the session
    try { paintAim() } catch (err) { console.warn('stage handles:', err && err.message) }
  } catch (e) {
    // no WebGL2, or a shader this machine cannot build: the CSS stage stays
    console.warn('stage canvas off:', e && e.message)
    stageGL = false
    off()
  }
}

/**
 * The far side of a cut being dissolved, for the stage: a second <video> of the same
 * take, seeked to the moment the plan asks for. Returns it when it is holding that
 * frame, else null, having started the seek.
 *
 * A dissolve is the one thing in the plan that needs two source frames at once, and on
 * the stage the second one has to be seeked for. Parked on a frame, which is where a
 * cut is actually judged, the seek lands and the stage is the file. Playing, a seek
 * cannot land inside a frame's worth of time, so the stage draws the near side alone
 * for the fifth of a second the dissolve lasts and the cut looks hard; the file has the
 * dissolve. That is the same approximation the stage already makes at every cut, where
 * playback jumps the removed range on a timeupdate rather than on a frame.
 */
function stageCross(spec, fp) {
  const v = $('edVideo')
  if (!v || !(fp.mix > 0) || fp.s2 == null) return null
  // one element for the window, not one per take: a fresh stage is made per take and
  // would otherwise leave the last one's behind in the DOM
  let b = stageGL.vb || document.getElementById('edVideoB')
  if (!b) {
    b = document.createElement('video')
    b.id = 'edVideoB'
    b.muted = true; b.playsInline = true; b.preload = 'auto'
    b.style.cssText = 'position:absolute;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none'
    b.addEventListener('seeked', () => paintStageGL())
    v.parentNode.appendChild(b)
  }
  stageGL.vb = b
  if (b.src !== v.src) { b.src = v.src; stageGL.vbWant = null }
  if (b.readyState < 2) return null
  // inside half a frame of what the plan asks for is the frame the file will hold
  if (Math.abs(b.currentTime - fp.s2) > 0.5 / spec.fps) {
    if (stageGL.vbWant !== fp.s2) { stageGL.vbWant = fp.s2; try { b.currentTime = fp.s2 } catch {} }
    return null
  }
  return b
}

// One redraw per frame the <video> presents while it plays, and one after every seek
function armStageGL(v) {
  if (!v || v._stageGL) return
  v._stageGL = true
  const tick = (_now, meta) => {
    if (!v.isConnected) return
    syncStageRate(v)
    paintStageGL({ upload: true, t: meta && meta.mediaTime })
    if (!v.paused && v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick)
  }
  v.addEventListener('play', () => { syncStageRate(v); if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick) })
  // back to the take's own speed and sound the moment it stops, so scrubbing and the
  // volume control are not left holding a rate the playhead has moved off
  v.addEventListener('pause', () => { v.playbackRate = 1; v.muted = false })
  for (const ev of ['loadeddata', 'seeked', 'pause']) v.addEventListener(ev, () => paintStageGL({ upload: true }))
  const cb = $('camBubble')
  if (cb) cb.addEventListener('seeked', () => { if (v.paused) paintStageGL() })
}

// ── the lasso ───────────────────────────────────────────────────────────
// Drag a rectangle over the picture and it snaps to the element under it, then goes
// to the chat as a chip. It writes nothing to the edit: the lasso points, the agent
// makes the mark, and the button that is already there undoes it.
//
// Nothing is written to the document while the button is held either. A doc change
// per frame re-keys stageGLSpec and rebuilds the whole plan, so the band is one div
// laid over the stage and the geometry is read, never stored.
const Pick = require('./ui/stage-pick')
const Targets = require('./ui/targets')

const LASSO_NEAR = 0.5           // a box drawn at 12 s means nothing at 40 s
const LASSO_ELS = 8              // moments of elements kept in hand
const LASSO_WAIT = 2000          // a pass that hangs gives up its say, never the gesture

// The picture the band is drawn over, and the moment it is drawn at. A shot is one
// frame, so that moment is always the same one. This block is lifted whole into
// test/stage-pick.test.js, so it asks through its own two accessors rather than the
// editor's, which do not travel with it.
const lassoPic = () => (ed.shot ? $('edStill') : null) || $('edVideo')
const lassoAt = () => (ed.shot ? shotTime() : (lassoPic() || {}).currentTime || 0)

let lassoDrag = null             // { from, to, at, box, element, kind, label } while held
let lassoBand = null             // the rubber band, one div inside #stageFrame
let lassoShown = null            // the region the band is standing for, once it is made
let lassoAsk = null              // the debounce behind a settled video
let lassoOnce = false            // window-level wiring, which outlives one open take
let lassoBlurOnce = false        // the same, for the drag a lost mouseup would strand
const lassoEls = new Map()       // `${path}|${at}` -> the elements at that moment
const lassoWait = new Map()      // the same key -> the pass still out, so one moment is asked once

function setLasso(on) {
  ed.lasso = !!on
  const b = $('edLasso'), frame = $('stageFrame')
  if (b) b.setAttribute('aria-pressed', String(ed.lasso))
  if (frame) { if (ed.lasso) frame.dataset.lasso = 'on'; else delete frame.dataset.lasso }
  clearTimeout(lassoAsk)
  if (ed.lasso) askElements()
  else if (lassoDrag) { endLasso(); clearBand() }
  paintAim()          // the lasso owns the stage while it is armed, so the handles step aside
}

function wireLasso() {
  const frame = $('stageFrame'), v = lassoPic()
  if (!frame || !v) return
  if ($('edLasso')) $('edLasso').onclick = () => setLasso(!ed.lasso)
  // the bubble phase: the camera, the caption and the text layers stop their own
  // drags from getting this far, so they keep them for free
  frame.addEventListener('mousedown', lassoDown)
  // the elements for the moment on screen, once the video settles on one
  const settle = () => {
    if (!ed.lasso) return
    clearTimeout(lassoAsk)
    lassoAsk = setTimeout(() => askElements(), 300)
  }
  for (const ev of ['seeked', 'pause']) v.addEventListener(ev, settle)
  endLasso(); lassoBand = null; lassoShown = null
  setLasso(false)                // every take opens with the tool off
  if (!lassoBlurOnce) { lassoBlurOnce = true; window.addEventListener('blur', lassoCancel) }
  // the chat pane installs window.fetchLasso as it builds, so this waits for it
  if (lassoOnce || !window.fetchLasso) return
  lassoOnce = true
  // the band belongs to its chip: when the chip goes, so does it
  window.fetchLasso.onDrop(id => { if (lassoShown && lassoShown.id === id) clearBand() })
  // clicking the chip comes back to the moment the area was drawn at
  window.addEventListener('fetch:region-show', e => showRegion(e.detail))
}

// the crop is in the key: move the handles and the same moment holds different
// elements, measured in a different frame
const lassoKey = (path, at, crop) =>
  `${path}|${at.toFixed(1)}|${crop ? [crop.x, crop.y, crop.w, crop.h].map(n => n.toFixed(4)).join(',') : ''}`

// The Elements pass takes about a second, so it is asked for as soon as the tool is
// armed and again on mousedown when this moment is not in hand. A drag that starts
// before the answer lands is free form and begins snapping the moment it arrives:
// the pass calls the drag back itself, rather than waiting to be asked by the next
// mousemove, which for a quick drag never comes.
function askElements(at) {
  const path = ed.src, v = lassoPic()
  if (!ed.lasso || !path || !v) return Promise.resolve([])
  at = at != null ? at : lassoAt()
  const g = lassoGeom()
  const crop = g ? g.crop : null
  const key = lassoKey(path, at, crop)
  if (lassoEls.has(key)) return Promise.resolve(lassoEls.get(key))
  // one moment, one pass: arming and the mousedown behind it land on the same key,
  // and release waits on this promise rather than starting a second pass
  if (lassoWait.has(key)) return lassoWait.get(key)
  const out = (async () => {
    let r = null
    try { r = await ipcRenderer.invoke('lasso-elements', { path, at, crop }) } catch {}
    const els = (r && r.elements) || []
    lassoEls.set(key, els)
    if (lassoEls.size > LASSO_ELS) lassoEls.delete(lassoEls.keys().next().value)
    lassoWait.delete(key)
    return els
  })()
  lassoWait.set(key, out)
  // the pass calls the drag back itself, and a throw in that callback must not land as
  // a rejection on the promise its callers are already holding
  out.then(() => catchUpLasso(key)).catch(() => {})
  return out
}

// What is known about the moment being drawn on. Empty until the pass lands, which
// is the whole loading story: no spinner, no blocking, no modal.
function elementsNow(g) {
  const v = lassoPic()
  if (!v || !ed.src) return []
  return elsAt(lassoDrag ? lassoDrag.at : lassoAt(), g ? g.crop : null)
}

const elsAt = (at, crop) => (ed.src ? lassoEls.get(lassoKey(ed.src, at, crop)) : null) || []

// The rectangle the hand drew, kept as its two corners rather than as a box, so a
// second judgement starts from what was drawn and not from the element the first
// judgement already jumped to.
const drawnBox = d => (d ? Pick.clampBox(Pick.rectOf(d.from, d.to)) : null)

// One judgement of a drawn rectangle against what the pass knows: the box the band
// takes, the element under it, and the name the chip will carry. Pure and cheap, so
// it can run again the moment the pass lands and again on release.
function judgeLasso(drawn, els) {
  const snap = els.length ? Targets.snapBox(drawn, els) : null
  const got = snap && snap.box ? snap : { box: drawn, element: null, kind: 'free' }
  const element = got.element || null
  return { box: got.box, element, kind: got.kind || 'free',
    label: Targets.regionLabel(got.box, els, element) }
}

const lassoTag = d => (d.element ? bandTag(d.element, d.label) : 'Free')

// The pass lands about a second after it is asked for, by which time a quick drag is
// already still or already over. Judge the rectangle again against what just arrived:
// the band redrawing once under the pointer is the software catching up, and it beats
// a box that stays free form over an element the app can now name.
function catchUpLasso(key) {
  const d = lassoDrag
  if (!d || !ed.src || lassoKey(ed.src, d.at, d.crop) !== key) return
  const g = lassoGeom(), drawn = drawnBox(d)
  if (!g || !drawn) return
  Object.assign(d, judgeLasso(drawn, elsAt(d.at, d.crop)))
  placeBand(g, d.box, lassoTag(d))
}

// What the pass knows about the moment a drag was drawn at, waiting on it when it is
// still out. A drag quicker than the pass has no answer at mouseup, and the chip it
// mints carries its name for good, so this is the one place the lasso waits.
function lassoElements(d) {
  const key = lassoKey(ed.src || '', d.at, d.crop)
  if (lassoEls.has(key)) return Promise.resolve(lassoEls.get(key))
  const out = lassoWait.get(key)
  if (!out) return Promise.resolve([])
  const capped = new Promise(done => setTimeout(() => done(null), LASSO_WAIT))
  return Promise.race([out, capped]).then(els => els || elsAt(d.at, d.crop), () => [])
}

// The one moment the lasso waits on the pass: the button is up, the box is drawn and
// the name is a beat behind it. The band says so rather than standing still.
function bandReading(on) {
  if (lassoBand && lassoBand.isConnected) lassoBand.classList.toggle('is-reading', !!on)
}

// Where the take is on the stage at this moment: its rect (moved, if a title card has
// lifted it), the window margin trimmed inside it, and the zoom in force. Plan.viewAt
// rather than fp.view0, which with motion blur is half a shutter early.
function lassoGeom() {
  const frame = $('stageFrame'), v = lassoPic(), cv = $('stageGL')
  if (!frame || !v || !cv || !stageGL || !stageGL.spec || frame.dataset.gl !== 'on') return null
  const Plan = require('./ui/compositor/plan')
  const spec = stageGL.spec
  const tOut = stageGL.clock(lassoAt())
  const fp = Plan.framePlan(spec, tOut)
  return { spec, cv, W: spec.W, H: spec.H, inner: spec.inner, crop: lassoCropOf(spec),
    rect: Pick.movedRect(spec.rect, fp.move), view: Plan.viewAt(spec, tOut) }
}

// The crop the stage is drawing, in fractions of the recording. It travels with the
// box, because main reads the crop from the document on disk and the autosave is up
// to 400 ms behind the handles (:591): a box measured in one crop and read in another
// points at the wrong part of the picture.
function lassoCropOf(spec) {
  const c = spec && spec.crop, s = spec && spec.src
  if (!c || !s || !(s.w > 0 && s.h > 0 && c.w > 0 && c.h > 0)) return null
  const box = { x: c.x / s.w, y: c.y / s.h, w: c.w / s.w, h: c.h / s.h }
  return box.x === 0 && box.y === 0 && box.w >= 1 && box.h >= 1 ? null : box
}

function bandEl() {
  if (lassoBand && lassoBand.isConnected) return lassoBand
  const frame = $('stageFrame')
  if (!frame) return null
  lassoBand = document.createElement('div')
  lassoBand.className = 'lasso-box'
  lassoBand.innerHTML = '<span class="lasso-tag"></span>'
  frame.appendChild(lassoBand)
  return lassoBand
}

// A box of the cropped frame, as a rectangle inside #stageFrame. The canvas's own
// offset and CSS size carry the stage's scale, so no device pixel ratio comes into it.
// The lasso's band and the handles on a selected mark are both laid out from this.
function stageRect(g, box) {
  const a = Pick.fromFrac(box, g)
  const b = Pick.fromFrac({ x: box.x + box.w, y: box.y + box.h }, g)
  const kx = g.cv.offsetWidth / g.W, ky = g.cv.offsetHeight / g.H
  return { left: g.cv.offsetLeft + a.x * kx, top: g.cv.offsetTop + a.y * ky,
    w: Math.max(1, (b.x - a.x) * kx), h: Math.max(1, (b.y - a.y) * ky) }
}

function placeBand(g, box, tag) {
  const el = bandEl()
  if (!el) return
  const r = stageRect(g, box)
  const top = r.top
  Object.assign(el.style, {
    left: r.left + 'px', top: top + 'px', width: r.w + 'px', height: r.h + 'px',
  })
  // no room above for the label near the top of the frame, so it drops inside
  el.classList.toggle('tag-in', top < 26)
  if (tag != null) el.firstChild.innerHTML = tag
  el.hidden = false
}

function clearBand() {
  if (lassoBand) lassoBand.remove()
  lassoBand = null; lassoShown = null
}

// The band that is already made, kept true to the picture. It hides away from the
// moment it was drawn at, because a box at 12 s means nothing at 40.
function paintLasso() {
  if (!lassoBand || lassoDrag) return
  const v = lassoPic()
  if (!lassoShown || !v) return
  const g = Math.abs(lassoAt() - lassoShown.at) > LASSO_NEAR ? null : lassoGeom()
  if (!g) { lassoBand.hidden = true; return }
  placeBand(g, lassoShown.box)
}

const bandTag = (id, label) => '<span class="lasso-id mono">' + escHtml(id) + '</span>' +
  (label ? '<span class="lasso-what">' + escHtml(label) + '</span>' : '')

// Back to the moment a chip was drawn at, with its band on the picture again.
function showRegion(r) {
  if (!r || r.path !== ed.src) return
  seek(r.at)
  lassoShown = r
  const el = bandEl()
  if (el) { el.classList.add('is-set'); el.firstChild.innerHTML = bandTag(r.id, r.label) }
  paintLasso()
}

function lassoDown(e) {
  if (!ed.lasso || e.button !== 0 || ed.tab === 'crop') return
  // a caption being typed into owns its own clicks: its span lets them through so the
  // caret can land, and preventDefault here would stop the caret moving at all
  if (e.target.closest && e.target.closest('[data-editing="true"]')) return
  const g = lassoGeom()
  if (!g) return
  const f = Pick.toFrac(Pick.toOutput({ x: e.clientX, y: e.clientY }, g.cv.getBoundingClientRect(), g.spec), g)
  if (!f) return                   // the backdrop, not the take: nothing to point at
  e.preventDefault()
  clearBand()
  lassoDrag = { from: f, to: f, at: lassoAt(), crop: g.crop,
    box: null, element: null, kind: 'free', label: '' }
  askElements(lassoDrag.at)
  document.addEventListener('mousemove', lassoMove)
  document.addEventListener('mouseup', lassoUp)
  document.addEventListener('keydown', lassoEscape, true)
  lassoMove(e)
}

function lassoMove(e) {
  if (!lassoDrag) return
  // the mouseup was swallowed by something else, so the band was following a pointer
  // with no button held. The rectangle is drawn, so finish it rather than lose it.
  if (e.type === 'mousemove' && !e.buttons) { lassoUp(); return }
  const g = lassoGeom()
  if (!g) return
  const p = Pick.toOutput({ x: e.clientX, y: e.clientY }, g.cv.getBoundingClientRect(), g.spec)
  // a drag that runs off the take keeps going, held at the edge of the picture
  const to = Pick.toFrac({ x: Math.min(Math.max(p.x, g.rect.x), g.rect.x + g.rect.w),
    y: Math.min(Math.max(p.y, g.rect.y), g.rect.y + g.rect.h) }, g)
  if (to) lassoDrag.to = to
  const drawn = drawnBox(lassoDrag)
  if (!drawn) return
  // snapping is judged fresh on every move: the band either sits on an element or is
  // exactly what was drawn, and the jump between the two is instant
  Object.assign(lassoDrag, judgeLasso(drawn, elementsNow(g)))
  placeBand(g, lassoDrag.box, lassoTag(lassoDrag))
}

function lassoEscape(e) {
  if (e.key !== 'Escape' || !lassoDrag) return
  e.preventDefault(); e.stopPropagation()
  lassoCancel()
}

// Cmd+Tab or Mission Control mid-drag: the mouseup goes to whatever took the window,
// so the drag is dropped here rather than left live behind them.
function lassoCancel() {
  if (!lassoDrag) return
  endLasso(); clearBand()
}

function endLasso() {
  lassoDrag = null
  document.removeEventListener('mousemove', lassoMove)
  document.removeEventListener('mouseup', lassoUp)
  document.removeEventListener('keydown', lassoEscape, true)
}

async function lassoUp() {
  const d = lassoDrag
  endLasso()
  if (!d || !d.box) { clearBand(); return }
  const path = ed.src
  // Judged once more against the pass, which may have landed since the last mousemove
  // or be landing still. Without this a drag quicker than the pass mints an unsnapped
  // area called "Area" for a moment the app can read a heartbeat later. A flick is a
  // click and waits on nothing, so the stage keeps its ordinary clicks.
  const drawn = drawnBox(d)
  // Every exit from here on is after an await, so the band on screen may already belong
  // to a drag still under the person's finger. Taking it would leave them dragging
  // nothing until the next mousemove, so this drag only clears its own band.
  const dropBand = () => { if (!lassoDrag) clearBand() }
  if (drawn && !Pick.tooSmall(drawn)) {
    bandReading(!lassoEls.has(lassoKey(path || '', d.at, d.crop)))
    Object.assign(d, judgeLasso(drawn, await lassoElements(d)))
    bandReading(false)
    if (ed.src !== path) { dropBand(); return }
    const g = lassoDrag ? null : lassoGeom()   // a drag that started meanwhile owns the band now
    if (g) placeBand(g, d.box, lassoTag(d))
  }
  // under two percent either way a drag was a click, which is how the stage keeps its
  // ordinary clicks
  if (Pick.tooSmall(d.box)) { dropBand(); toast('That area is too small to work on. Drag a bigger one.', 'bad'); return }
  let region = null
  try {
    region = await ipcRenderer.invoke('lasso-region',
      // the crop the band was drawn inside travels with the box, so main never reads
      // a stale one off disk mid-autosave
      { path, at: d.at, box: d.box, element: d.element, kind: d.kind, label: d.label, crop: d.crop })
  } catch (err) {
    dropBand()
    toast(escHtml(String((err && err.message) || 'that area could not be read').replace(/^.*Error: /, '')), 'bad')
    return
  }
  if (!region || ed.src !== path) { dropBand(); return }
  lassoShown = region
  const el = lassoDrag ? null : bandEl()       // the same: a newer drag keeps its own band
  if (el) { el.classList.add('is-set'); el.firstChild.innerHTML = bandTag(region.id, region.label) }
  if (window.fetchLasso) window.fetchLasso.add(region)
}

// ── a zoom and a mark, edited by hand ───────────────────────────────────
// An agent could place a zoom or a mark and a person could not move one. For a
// redaction that was a hole: the one edit where a miss ships something private could
// only be undone whole or asked for again. So every object on the two tracks now has
// hands on it. A pill is dragged by its ends to retime and by its middle to move; a
// mark is dragged on the stage to place and resize; a zoom is re-aimed by drawing a
// box over what it should frame, through Targets.boxZoom, which is the same call an
// agent's box goes through (ui/trackedit.js, ui/fetchdoc.js).
//
// Nothing here writes the document itself. It changes ed.zooms and ed.marks, and the
// autosave (:591) notices, writes and takes one undo step when the button lands, the
// same way the trim handles and the look sliders already work.
const TrackEdit = require('./ui/trackedit')

const SNAP_PX = 6                // how near a pill's end has to land to go flush
let trackAte = false             // a drag just ended, so the click behind it is not a seek

const isSel = (kind, id) => !!(ed.sel && ed.sel.kind === kind && ed.sel.id === id)
const objList = kind => (kind === 'zoom' ? ed.zooms : ed.marks) || []
const objMin = kind => (kind === 'zoom' ? TrackEdit.MIN_SPAN : TrackEdit.MIN_MARK)
const objLabel = (kind, o) => kind === 'zoom' ? 'Zoom' : o.kind === 'step' ? 'Step ' + (o.n || '') : (MARK_LABEL[o.kind] || o.kind)

function selObj() {
  if (!ed.sel) return null
  return objList(ed.sel.kind).find(x => x && x.id === ed.sel.id) || null
}

// Selecting opens the tab the hands are on, the way clicking a text layer does.
function selectObj(kind, id) {
  ed.sel = kind && id ? { kind, id } : null
  const tab = document.querySelector('#inspTabs button[data-tab="focus"]')
  if (ed.sel && tab && ed.tab !== 'focus') tab.click()
  renderZooms(); renderMarks(); renderFocus()
}

// One repaint after a change: the tracks, the panel, the stage and its handles.
function afterEdit() {
  renderZooms(); renderMarks(); renderFocus()
}

// The times a drag should land flush on: the trim, the playhead, the beats, the cuts,
// and every other object on both tracks. A lift is meant to sit on its zoom.
function snapTimes(id) {
  const t = [ed.in, ed.out, ed.cur]
  for (const b of ed.beats || []) t.push(+b.start, +b.end)
  for (const [a, b] of ed.cuts || []) t.push(a, b)
  for (const x of [...(ed.zooms || []), ...(ed.marks || [])]) if (x && x.id !== id) t.push(+x.start, +x.end)
  return t
}

// Only one zoom frames the shot at once, so a zoom stops at its neighbours. Marks
// legitimately share time (a redaction over a step), so they have the take alone.
const objLimits = (kind, id) => kind === 'zoom'
  ? TrackEdit.spanLimits(ed.zooms, id, { lo: 0, hi: ed.dur })
  : { lo: 0, hi: ed.dur }

// Minted from the saved edit's counter, so the id the person sees is the one an agent
// reads back. Before there is a saved document, from the ids already on the track.
function mintObjId(kind, letter) {
  if (ed.doc) return require('./ui/fetchdoc').mintId(ed.doc, kind)
  let n = 1
  for (const x of objList(kind === 'zooms' ? 'zoom' : 'mark')) {
    const m = new RegExp('^' + letter + '(\\d+)$').exec(String((x && x.id) || ''))
    if (m) n = Math.max(n, +m[1] + 1)
  }
  return letter + n
}

function addZoom() {
  if (!ed.src || !ed.dur) return
  const gap = TrackEdit.freeGap(ed.zooms, ed.cur, { lo: 0, hi: ed.dur })
  if (!gap) {
    const here = (ed.zooms || []).find(z => ed.cur >= z.start && ed.cur < z.end)
    return toast(escHtml((here && here.id) || 'A zoom') + ' is already zooming here. Re-aim it, or move the playhead.', 'bad')
  }
  const span = TrackEdit.newSpan(ed.cur, TrackEdit.WANT.zoom, { ...gap, min: TrackEdit.MIN_SPAN })
  if (!span) return toast('There is no room for a zoom here.', 'bad')
  const z = { id: mintObjId('zooms', 'Z'), ...span, scale: 1.8, x: 0.5, y: 0.5 }
  ed.zooms = [...(ed.zooms || []), z].sort((a, b) => a.start - b.start)
  selectObj('zoom', z.id)
  toast(escHtml(z.id) + ' added. Drag a box on the stage to say what it frames.')
}

function addMark(kind) {
  if (!ed.src || !ed.dur) return
  // on a shot every mark is on for the whole span, because the frame that is drawn is
  // the middle of it and a mark that starts there would be drawn half arrived
  const span = ed.shot ? { start: 0, end: ed.dur }
    : TrackEdit.newSpan(ed.cur, TrackEdit.WANT.mark, { lo: 0, hi: ed.dur, min: TrackEdit.MIN_MARK })
  if (!span) return toast('There is no room for a mark here.', 'bad')
  // no box from the lasso on purpose: the lasso points Biscuit at an area and writes
  // nothing to the edit, so a mark made here is the person's own rectangle to place
  const m = { id: mintObjId('marks', 'M'), ...TrackEdit.blankMark(kind, span) }
  ed.marks = [...(ed.marks || []), m].sort((a, b) => a.start - b.start)
  selectObj('mark', m.id)
  toast(escHtml(m.id) + ' added. Drag it on the stage onto the thing.')
}

function removeSel() {
  const o = selObj()
  if (!o) return
  const kind = ed.sel.kind, what = objLabel(kind, o).toLowerCase().trim()
  if (kind === 'zoom') ed.zooms = TrackEdit.removeById(ed.zooms, o.id)
  else ed.marks = TrackEdit.removeById(ed.marks, o.id)
  ed.sel = null
  afterEdit()
  toast(escHtml(o.id) + ' ' + escHtml(what) + ' removed. Undo puts it back.')
}

// An end set to the playhead, held to the same rules a drag is.
function setObjEdge(grip) {
  const o = selObj()
  if (!o) return
  const from = grip === 'start' ? +o.start : +o.end
  Object.assign(o, TrackEdit.dragSpan(o, grip, ed.cur - from, { ...objLimits(ed.sel.kind, o.id), min: objMin(ed.sel.kind) }))
  afterEdit()
}

// ── the panel ───────────────────────────────────────────────────────────
function renderFocus() {
  const zl = $('zoomList'), ml = $('markList')
  if (!zl || !ml) return
  const row = (kind, o, detail) =>
    '<button class="obj-row" data-kind="' + kind + '" data-id="' + escHtml(o.id) + '" ' +
      'data-sel="' + String(isSel(kind, o.id)) + '" data-mark="' + escHtml(kind === 'mark' ? o.kind : '') + '">' +
      '<span class="obj-id mono">' + escHtml(o.id) + '</span>' +
      '<span class="obj-what">' + escHtml(detail) + '</span>' +
      '<span class="obj-when mono">' + Fmt.clock(o.start) + ' to ' + Fmt.clock(o.end) + '</span>' +
    '</button>'
  zl.innerHTML = (ed.zooms || []).length
    ? ed.zooms.map(z => row('zoom', z, Fmt.mult(+z.scale || 1.8))).join('')
    : '<p class="micro dimmer">No zooms yet.</p>'
  ml.innerHTML = (ed.marks || []).length
    ? ed.marks.map(m => row('mark', m, objLabel('mark', m))).join('')
    : '<p class="micro dimmer">No marks yet.</p>'
  renderObjEdit()
  paintAim()
}

function renderObjEdit() {
  const box = $('objEdit')
  if (!box) return
  const o = selObj()
  box.hidden = !o
  if (!o) return
  const kind = ed.sel.kind, zoom = kind === 'zoom'
  $('objId').textContent = o.id
  $('objWhat').textContent = objLabel(kind, o).trim()
  $('objStart').textContent = Fmt.clock(o.start)
  $('objEnd').textContent = Fmt.clock(o.end)
  const show = (id, on) => { const n = $(id); if (n) n.hidden = !on }
  show('objScaleRow', zoom); show('objStrengthRow', !zoom && o.kind === 'blur'); show('objNumRow', !zoom && o.kind === 'step')
  if (zoom) {
    const s = $('objScale'), v = $('objScaleVal')
    s.value = Math.round((+o.scale || 1.8) * 100)
    s.style.setProperty('--fill', ((s.value - s.min) / (s.max - s.min) * 100) + '%')
    v.textContent = Fmt.mult(+o.scale || 1.8, 0.01)
  } else if (o.kind === 'blur') {
    const s = $('objStrength'), v = $('objStrengthVal')
    s.value = Math.round(+o.strength || 18)
    s.style.setProperty('--fill', ((s.value - s.min) / (s.max - s.min) * 100) + '%')
    v.textContent = Fmt.pctOf(+s.value, +s.min, +s.max)
  } else if (o.kind === 'step') {
    $('objNum').value = o.n != null ? o.n : ''
  }
  $('objHint').textContent = zoom
    ? 'Drag a box over the stage to say what it frames. Fetch picks the scale that fits it.'
    : o.kind === 'step' ? 'Drag on the stage to put the badge where it points.'
    : 'Drag it on the stage to move it, a corner to resize it, or draw a new box over the stage.'
}

function wireFocus() {
  const on = (id, fn) => { const n = $(id); if (n) n.onclick = fn }
  on('addZoom', () => addZoom())
  const add = $('markAdd')
  if (add) add.onclick = e => { const b = e.target.closest('[data-kind]'); if (b) addMark(b.dataset.kind) }
  for (const host of ['zoomList', 'markList']) {
    const n = $(host)
    if (n) n.onclick = e => {
      const b = e.target.closest('.obj-row')
      if (!b) return
      selectObj(b.dataset.kind, b.dataset.id)
      const o = selObj()
      if (o) seek(+o.start)
    }
  }
  on('objSetIn', () => setObjEdge('start'))
  on('objSetOut', () => setObjEdge('end'))
  on('objDel', () => removeSel())
  const scale = $('objScale')
  if (scale) scale.oninput = () => {
    const o = selObj()
    if (!o || ed.sel.kind !== 'zoom') return
    o.scale = Math.round(+scale.value) / 100
    afterEdit()
  }
  const strength = $('objStrength')
  if (strength) strength.oninput = () => {
    const o = selObj()
    if (!o || o.kind !== 'blur') return
    o.strength = Math.round(+strength.value)
    afterEdit()
  }
  const num = $('objNum')
  if (num) num.oninput = () => {
    const o = selObj()
    if (!o || o.kind !== 'step') return
    const v = String(num.value).replace(/[^0-9A-Za-z]/g, '').slice(0, 3)
    if (v !== num.value) num.value = v
    o.n = v || null
    renderZooms(); renderMarks()
  }
  for (const id of ['tlZooms', 'tlMarks']) { const n = $(id); if (n) n.addEventListener('mousedown', trackDown) }
  const frame = $('stageFrame')
  if (frame) frame.addEventListener('mousedown', aimDown)
  renderFocus()
}

// ── dragging a pill ─────────────────────────────────────────────────────
function trackDown(e) {
  if (e.button !== 0 || !ed.src || !ed.dur) return
  const pill = e.target.closest('.tl-zoom, .tl-mark')
  if (!pill) return
  const kind = pill.classList.contains('tl-zoom') ? 'zoom' : 'mark'
  const host = pill.parentNode                 // the pill itself is replaced by the re-render
  const o = objList(kind).find(x => x && x.id === pill.dataset.id)
  if (!o || !host) return
  const grip = (e.target.dataset && e.target.dataset.grip) || 'body'
  selectObj(kind, o.id)
  const perPx = ed.dur / Math.max(1, host.clientWidth)
  const x0 = e.clientX, was = { start: +o.start, end: +o.end }
  const o2 = { lim: objLimits(kind, o.id), min: objMin(kind), snap: snapTimes(o.id), tol: SNAP_PX * perPx }
  let moved = false
  const move = ev => {
    // the mouseup was swallowed by something else: finish rather than follow a pointer
    // with no button held, the way the lasso does
    if (!ev.buttons) { up(); return }
    if (!moved && Math.abs(ev.clientX - x0) < 3) return
    moved = true
    Object.assign(o, TrackEdit.dragSpan(was, grip, (ev.clientX - x0) * perPx,
      { ...o2.lim, min: o2.min, snap: o2.snap, tol: o2.tol }))
    afterEdit()
  }
  const up = () => {
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    if (!moved) return
    trackAte = true                            // the click behind this drag is not a seek
    setTimeout(() => { trackAte = false }, 250)   // and nothing else, if no click comes
    if (kind === 'zoom') ed.zooms = [...ed.zooms].sort((a, b) => a.start - b.start)
    else ed.marks = [...ed.marks].sort((a, b) => a.start - b.start)
    afterEdit()
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  e.preventDefault()
}

// ── the handles on the stage ────────────────────────────────────────────
// The same four divisions the lasso picks through (lassoGeom, ui/stage-pick.js), so a
// box dragged here is in the frame's own fractions, which is what marks and zooms
// speak, at whatever zoom the stage happens to be showing.
const AIM_GRIPS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const AIM_HTML = '<span class="aim-tag mono"></span>' + AIM_GRIPS.map(g => `<i class="ah ${g}" data-grip="${g}"></i>`).join('')

// What the selected object covers, in fractions of the cropped frame: a mark's own
// box, a step's badge round its point, and for a zoom the window it frames.
function objBox(kind, o, g) {
  if (kind === 'zoom') {
    const s = Math.max(1, +o.scale || 1.8), k = 1 / s
    return { x: Math.max(0, Math.min(1 - k, (+o.x || 0.5) - k / 2)), y: Math.max(0, Math.min(1 - k, (+o.y || 0.5) - k / 2)), w: k, h: k }
  }
  if (o.kind === 'step') {
    const h = 0.05, w = g && g.W ? h * g.H / g.W : h
    return { x: Math.max(0, Math.min(1 - w, (+o.x || 0) - w / 2)), y: Math.max(0, Math.min(1 - h, (+o.y || 0) - h / 2)), w, h }
  }
  // a mark an agent aimed by element id can reach the editor before its box is
  // resolved: it gets a rectangle big enough to grab rather than a dot in the corner
  if (!['x', 'y', 'w', 'h'].every(k => Number.isFinite(+o[k]))) return { x: 0.32, y: 0.36, w: 0.36, h: 0.22 }
  return { x: +o.x, y: +o.y, w: Math.max(TrackEdit.MIN_BOX, +o.w), h: Math.max(TrackEdit.MIN_BOX, +o.h) }
}

let aimDraw = null               // the box being drawn, while it is being drawn

function paintAim() {
  const frame = $('stageFrame')
  if (!frame) return
  let n = frame.querySelector('.aim-box')
  const o = selObj()
  const g = o && ed.tab === 'focus' && !ed.lasso ? lassoGeom() : null
  if (!g) { if (n) n.remove(); return }
  if (!n) { n = el('div', 'aim-box', AIM_HTML); frame.appendChild(n) }
  const kind = ed.sel.kind
  const box = aimDraw || objBox(kind, o, g)
  n.dataset.kind = kind === 'zoom' ? 'zoom' : o.kind
  n.dataset.drawing = String(!!aimDraw)
  const r = stageRect(g, box)
  Object.assign(n.style, { left: r.left + 'px', top: r.top + 'px', width: r.w + 'px', height: r.h + 'px' })
  n.classList.toggle('tag-in', r.top < 26)
  n.firstChild.textContent = o.id
}

function aimDown(e) {
  if (e.button !== 0 || ed.lasso || ed.tab !== 'focus') return
  const o = selObj()
  if (!o) return
  if (e.target.closest && e.target.closest('[data-editing="true"]')) return
  const g = lassoGeom()
  if (!g) return
  // a drag that runs off the take keeps going, held at the edge of the picture
  const at = ev => {
    const p = Pick.toOutput({ x: ev.clientX, y: ev.clientY }, g.cv.getBoundingClientRect(), g.spec)
    return Pick.toFrac({ x: Math.min(Math.max(p.x, g.rect.x), g.rect.x + g.rect.w),
      y: Math.min(Math.max(p.y, g.rect.y), g.rect.y + g.rect.h) }, g)
  }
  const from = at(e)
  if (!from) return
  const kind = ed.sel.kind, box0 = objBox(kind, o, g)
  const handle = e.target.classList && e.target.classList.contains('ah') ? e.target.dataset.grip : null
  const inside = from.x >= box0.x && from.x <= box0.x + box0.w && from.y >= box0.y && from.y <= box0.y + box0.h
  // a zoom is re-aimed by saying what it should frame, never by nudging its window,
  // so its gesture is always a fresh box; a mark is its box, so it moves and resizes
  const grip = kind === 'zoom' ? null : handle || (o.kind === 'step' || inside ? 'move' : null)
  e.preventDefault()
  let raf = 0, last = null
  const apply = () => {
    raf = 0
    if (!last) return
    const to = at(last)
    if (!to) return
    if (!grip) {
      aimDraw = Pick.clampBox(Pick.rectOf(from, to))
      paintAim()
      return
    }
    const d = { x: to.x - from.x, y: to.y - from.y }
    if (o.kind === 'step') Object.assign(o, TrackEdit.movePoint({ x: +o.x, y: +o.y }, d))
    else Object.assign(o, TrackEdit.placeMark(o, TrackEdit.dragBox(box0, grip, d)))
    paintOverlays(); paintAim()
  }
  const move = ev => {
    if (!ev.buttons) { up(ev); return }
    last = ev
    if (!raf) raf = requestAnimationFrame(apply)
  }
  const up = ev => {
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    if (last) { last = ev; apply() }
    const drawn = aimDraw
    aimDraw = null
    if (!grip && drawn && !Pick.tooSmall(drawn)) {
      // through Targets.boxZoom, exactly as an agent's box goes: the person says what
      // to frame and Fetch picks the scale, so both hands write the same zoom
      if (kind === 'zoom') Object.assign(o, TrackEdit.aimZoom(o, drawn))
      else Object.assign(o, TrackEdit.placeMark(o, drawn))
    } else if (!grip && drawn) {
      toast('That area is too small to work on. Drag a bigger one.', 'bad')
    }
    afterEdit()
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}

// Escape lets a selection go; Delete removes what is selected, and Undo puts it back.
document.addEventListener('keydown', e => {
  if (!ed.src || !ed.sel) return
  const view = document.querySelector('.view[data-view="editor"]')
  if (!view || view.hidden) return
  const t = e.target
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
  if (e.key === 'Escape') { selectObj(null); return }
  if (e.key !== 'Delete' && e.key !== 'Backspace') return
  e.preventDefault()
  removeSel()
})
