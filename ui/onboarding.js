// CALL SITE NEEDED: on first paint, read ~/Library/Application Support/Fetch/prefs.json and call window.startOnboarding() if onboarded is not true.
//
// Fetch first-run onboarding. Self-contained: injects its own stylesheet, can be
// loaded with require('./ui/onboarding.js') or as a plain <script>, and exposes
// window.startOnboarding() so it can be triggered by hand for testing.
//
// Wrapped in an IIFE so a top-level const never collides with the ones ui/app.js
// and friends declare in the shared script scope (see ui/prefs.js for the same
// concern). Four screens, one horizontal track, same shape as ui/setup.js.
;(function () {
  'use strict'

  // ── install the stylesheet once, however this file was loaded ──────────
  if (!document.querySelector('link[data-ob-style]')) {
    var link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = './ui/onboarding.css'
    link.setAttribute('data-ob-style', '1')
    document.head.appendChild(link)
  }

  var fs = require('fs'), path = require('path'), os = require('os')

  // Hard-coded per spec: the Settings page reads and writes this same file,
  // so every write here is a shallow merge, never a wholesale overwrite.
  var PREFS_DIR = path.join(os.homedir(), 'Library/Application Support/Fetch')
  var PREFS_PATH = path.join(PREFS_DIR, 'prefs.json')

  function readPrefs() {
    try { return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')) } catch (e) { return {} }
  }
  function writePrefs(patch) {
    try {
      fs.mkdirSync(PREFS_DIR, { recursive: true })
      var merged = Object.assign({}, readPrefs(), patch)
      fs.writeFileSync(PREFS_PATH, JSON.stringify(merged, null, 2))
      return merged
    } catch (e) {
      console.error('[onboarding] could not save preferences:', e.message)
      return null
    }
  }

  var ico = function (name, cls) {
    return '<svg class="' + (cls || 'icon-sm') + '"><use href="./assets/icons/sprite.svg#i-' + name + '"/></svg>'
  }
  var el = function (tag, cls, html) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (html != null) n.innerHTML = html
    return n
  }
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')) }, ms) })
    ])
  }

  var STEPS = [
    { icon: 'paw-print', label: 'Welcome' },
    { icon: 'check-circle', label: 'Permissions' },
    { icon: 'sliders-horizontal', label: 'Defaults' },
    { icon: 'check', label: 'Done' },
  ]

  var PERM_ROWS = [
    { key: 'screen', icon: 'monitor', title: 'Screen recording', required: true,
      sub: 'Required, so Fetch can see your screen while it records.', action: 'Allow screen recording' },
    { key: 'mic', icon: 'microphone', title: 'Microphone', required: false,
      sub: 'Optional, so your voice comes through when you narrate.', action: 'Allow microphone' },
    { key: 'camera', icon: 'video-camera', title: 'Camera', required: false,
      sub: 'Optional. The camera bubble is its own little app, it asks the first time it appears.', action: 'Show me' },
  ]

  function pillLabel(state) {
    return state === 'granted' ? 'Granted' : state === 'denied' ? 'Denied' : 'Not asked'
  }

  // read-only: never opens a device, only asks the OS what it already knows
  function queryPermission(name) {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return Promise.resolve('unknown')
      return withTimeout(navigator.permissions.query({ name: name }), 1200)
        .then(function (status) {
          if (status.state === 'granted') return 'granted'
          if (status.state === 'denied') return 'denied'
          return 'unknown'
        })
        .catch(function () { return 'unknown' })
    } catch (e) { return Promise.resolve('unknown') }
  }
  function queryScreenStatus() {
    try {
      var systemPreferences = require('electron').systemPreferences
      if (!systemPreferences || !systemPreferences.getMediaAccessStatus) return Promise.resolve('unknown')
      var s = systemPreferences.getMediaAccessStatus('screen')
      if (s === 'granted') return Promise.resolve('granted')
      if (s === 'denied' || s === 'restricted') return Promise.resolve('denied')
      return Promise.resolve('unknown')
    } catch (e) { return Promise.resolve('unknown') }
  }

  function permRowHtml(r) {
    return (
      '<div class="opt ob-perm-row" data-perm="' + r.key + '">' +
        '<div class="opt-ico">' + ico(r.icon, 'icon-sm') + '</div>' +
        '<div class="opt-txt">' +
          '<span class="opt-title">' + r.title + (r.required ? '<span class="ob-req">Required</span>' : '') + '</span>' +
          '<span class="opt-sub">' + r.sub + '</span>' +
        '</div>' +
        '<div class="ob-perm-actions">' +
          '<span class="chip chip-static ob-pill" data-state="unknown" id="obPill-' + r.key + '">Not asked</span>' +
          '<button class="btn btn-sm" id="obBtn-' + r.key + '">' + r.action + '</button>' +
        '</div>' +
      '</div>'
    )
  }

  function switchRowHtml(id, iconName, title, sub, on) {
    return (
      '<div class="opt">' +
        '<div class="opt-ico">' + ico(iconName, 'icon-sm') + '</div>' +
        '<div class="opt-txt"><span class="opt-title">' + title + '</span><span class="opt-sub">' + sub + '</span></div>' +
        '<label class="switch"><input type="checkbox" id="' + id + '" ' + (on ? 'checked' : '') + '><span class="track"></span></label>' +
      '</div>'
    )
  }

  function renderWelcome() {
    return (
      '<section class="ob-pane ob-pane-center" aria-hidden="false">' +
        '<img class="biscuit biscuit-xl biscuit-bob" src="./assets/mascot/sit-happy.png" alt="">' +
        '<h1>Meet <em class="accent">Biscuit</em></h1>' +
        '<p class="ob-lede">Fetch records your screen, camera and mic, then hands you back a finished video.</p>' +
        '<button class="btn btn-primary btn-lg ob-cta" id="obGetStarted">Get started</button>' +
      '</section>'
    )
  }

  function renderPermissions() {
    return (
      '<section class="ob-pane" aria-hidden="true">' +
        '<div class="ob-head">' +
          '<img class="biscuit" src="./assets/mascot/focused.png" alt="">' +
          '<div><h3>Let’s get you set up</h3><p>Fetch asks for three things, all at once, so recording never stalls on a permission prompt later.</p></div>' +
        '</div>' +
        '<div class="card ob-perm-card">' + PERM_ROWS.map(permRowHtml).join('') + '</div>' +
        '<p class="micro dimmer ob-cam-note" id="obCamNote" hidden>The camera bubble is a small separate app, not this window. The first time it appears on screen, macOS asks for camera access on its own. Say yes there, there is nothing to set up here.</p>' +
        '<p class="micro dimmer ob-perm-note">Change any of these later in System Settings, Privacy and Security.</p>' +
        '<button class="btn btn-primary btn-lg ob-cta" id="obContinue1">Continue</button>' +
      '</section>'
    )
  }

  function renderDefaults(state) {
    return (
      '<section class="ob-pane" aria-hidden="true">' +
        '<div class="ob-head">' +
          '<img class="biscuit" src="./assets/mascot/curious.png" alt="">' +
          '<div><h3>Set your defaults</h3><p>Nothing here is permanent, change it anytime from Settings.</p></div>' +
        '</div>' +
        '<div class="card">' +
          switchRowHtml('obCam', 'video-camera', 'Camera bubble', 'Show the floating camera by default', state.camera) +
          switchRowHtml('obMic', 'microphone', 'Microphone', 'Record your voice by default', state.mic) +
          switchRowHtml('obSys', 'speaker-high', 'System audio', 'Capture computer sound by default', state.systemAudio) +
          '<div class="opt">' +
            '<div class="opt-ico">' + ico('clock', 'icon-sm') + '</div>' +
            '<div class="opt-txt"><span class="opt-title">Countdown</span><span class="opt-sub">Time before recording starts</span></div>' +
            '<div class="seg" id="obCountdown" role="tablist">' +
              '<button data-val="0" role="tab" aria-selected="' + (state.countdown === 0) + '">Off</button>' +
              '<button data-val="3" role="tab" aria-selected="' + (state.countdown === 3) + '">3s</button>' +
              '<button data-val="5" role="tab" aria-selected="' + (state.countdown === 5) + '">5s</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<button class="btn btn-primary btn-lg ob-cta" id="obContinue2">Continue</button>' +
      '</section>'
    )
  }

  function renderDone() {
    return (
      '<section class="ob-pane ob-pane-center" aria-hidden="true">' +
        '<img class="biscuit biscuit-xl" src="./assets/mascot/done.png" alt="">' +
        '<h1>All set. <em class="accent">Go get it.</em></h1>' +
        '<p class="ob-lede">Hit record whenever you are ready, Biscuit has the rest.</p>' +
        '<button class="btn btn-primary btn-lg ob-cta" id="obFinish">Start using Fetch</button>' +
      '</section>'
    )
  }

  function startOnboarding() {
    if (document.querySelector('.ob-scrim')) return   // already open

    var savedPrefs = readPrefs()
    var state = {
      step: 0,
      camera: typeof savedPrefs.camera === 'boolean' ? savedPrefs.camera : true,
      mic: typeof savedPrefs.mic === 'boolean' ? savedPrefs.mic : true,
      systemAudio: typeof savedPrefs.systemAudio === 'boolean' ? savedPrefs.systemAudio : true,
      countdown: typeof savedPrefs.countdown === 'number' ? savedPrefs.countdown : 3,
      perm: { screen: 'unknown', mic: 'unknown', camera: 'unknown' },
    }

    var scrim = el('div', 'scrim ob-scrim')
    scrim.setAttribute('role', 'dialog')
    scrim.setAttribute('aria-label', 'Welcome to Fetch')
    scrim.innerHTML =
      '<div class="modal ob-modal">' +
        '<div class="modal-head ob-chrome">' +
          '<button class="btn btn-ghost btn-icon btn-sm ob-back" id="obBack" hidden>' + ico('arrow-left', 'icon-sm') + '</button>' +
          '<div class="ob-steps-wrap">' +
            '<div class="ob-runner-slot" id="obRunnerSlot"><img class="ob-runner" id="obRunner" src="./assets/mascot/sit-happy.png" alt=""></div>' +
            '<div class="ob-steps" id="obSteps">' +
              STEPS.map(function (s, i) {
                return '<span class="ob-step" data-i="' + i + '">' +
                    '<span class="ob-step-ico">' + ico(s.icon, 'icon-sm') + '</span>' +
                    '<span class="ob-step-label">' + s.label + '</span>' +
                  '</span>' +
                  (i < STEPS.length - 1 ? '<span class="ob-steps-line" data-line="' + i + '"></span>' : '')
              }).join('') +
            '</div>' +
          '</div>' +
          '<button class="btn btn-ghost btn-sm ob-skip" id="obSkip">Skip for now</button>' +
        '</div>' +
        '<div class="ob-view">' +
          '<div class="ob-track" id="obTrack">' +
            renderWelcome() + renderPermissions() + renderDefaults(state) + renderDone() +
          '</div>' +
        '</div>' +
      '</div>'
    document.body.appendChild(scrim)

    var track = scrim.querySelector('#obTrack')
    var permPollTimer = null

    function setPerm(key, val) {
      state.perm[key] = val
      var pill = scrim.querySelector('#obPill-' + key)
      var row = scrim.querySelector('.ob-perm-row[data-perm="' + key + '"]')
      if (pill) { pill.textContent = pillLabel(val); pill.dataset.state = val }
      if (row) row.dataset.on = String(val === 'granted')
      if (key !== 'camera') {
        var btn = scrim.querySelector('#obBtn-' + key)
        var spec = PERM_ROWS.filter(function (r) { return r.key === key })[0]
        if (btn) {
          // the pill already says "Granted", a second button saying the same
          // thing next to it is noise, so the action just steps aside
          btn.hidden = val === 'granted'
          if (val !== 'granted') { btn.disabled = false; btn.textContent = spec.action }
        }
      }
    }
    // a flaky read should never regress a status this session already confirmed
    function updateIfKnown(key, val) {
      if (val === 'unknown' && state.perm[key] !== 'unknown') return
      setPerm(key, val)
    }
    function refreshPerms() {
      queryScreenStatus().then(function (v) { updateIfKnown('screen', v) })
      queryPermission('microphone').then(function (v) { updateIfKnown('mic', v) })
      queryPermission('camera').then(function (v) { updateIfKnown('camera', v) })
    }

    // Biscuit walks the step track instead of a bar: sitting on the active
    // step, running to the next one when it changes. running.png faces left,
    // so a forward hop mirrors it; a backward hop uses it as drawn.
    var lastStep = 0
    var runnerTimer = null
    function updateRunner(prevStep, animate) {
      var slot = scrim.querySelector('#obRunnerSlot')
      var img = scrim.querySelector('#obRunner')
      var icos = scrim.querySelectorAll('.ob-step-ico')
      var target = icos[state.step]
      if (!slot || !img || !target) return
      var x = target.offsetLeft + target.offsetWidth / 2 - slot.offsetWidth / 2
      var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

      clearTimeout(runnerTimer)
      if (!animate || reduced || prevStep === state.step) {
        slot.style.transition = 'none'
        slot.style.transform = 'translateX(' + x + 'px)'
        img.src = './assets/mascot/sit-happy.png'
        img.classList.remove('ob-settle', 'ob-flip')
        void slot.offsetWidth   // force reflow so a later animated move is not skipped
        slot.style.transition = ''
        return
      }

      // the flip lives on the img, not the slot, and has no transition of its
      // own: scaleX(1) -> scaleX(-1) interpolated smoothly would pass through
      // 0 and squash Biscuit into a sliver mid-run. Toggling it as a plain
      // class swap makes it instant, so only translateX ever animates.
      var forward = state.step > prevStep
      img.src = './assets/mascot/running.png'
      img.classList.toggle('ob-flip', forward)
      slot.style.transition = 'transform 420ms cubic-bezier(.2,.8,.2,1)'
      requestAnimationFrame(function () {
        slot.style.transform = 'translateX(' + x + 'px)'
      })
      runnerTimer = setTimeout(function () {
        img.src = './assets/mascot/sit-happy.png'
        img.classList.remove('ob-flip')
        img.classList.add('ob-settle')
        setTimeout(function () { img.classList.remove('ob-settle') }, 220)
      }, 420)
    }
    function onResize() { updateRunner(state.step, false) }
    window.addEventListener('resize', onResize)

    function paint(animateRunner) {
      var prevStep = lastStep
      track.style.transform = 'translateX(-' + (state.step * 25) + '%)'
      scrim.querySelectorAll('.ob-pane').forEach(function (p, i) { p.setAttribute('aria-hidden', String(i !== state.step)) })
      scrim.querySelectorAll('.ob-step').forEach(function (s, i) {
        s.dataset.state = i === state.step ? 'active' : i < state.step ? 'done' : ''
      })
      scrim.querySelectorAll('.ob-steps-line').forEach(function (l) {
        l.dataset.done = String(+l.dataset.line < state.step)
      })
      scrim.querySelector('#obBack').hidden = state.step === 0
      scrim.querySelector('#obSkip').hidden = state.step === 3
      updateRunner(prevStep, animateRunner)
      lastStep = state.step
      clearInterval(permPollTimer); permPollTimer = null
      if (state.step === 1) {
        refreshPerms()
        permPollTimer = setInterval(refreshPerms, 1500)
      }
    }

    function closeOverlay() {
      clearInterval(permPollTimer)
      clearTimeout(runnerTimer)
      window.removeEventListener('resize', onResize)
      scrim.classList.add('ob-exit')
      setTimeout(function () { scrim.remove() }, 220)
    }
    function goto(n) { state.step = Math.max(0, Math.min(3, n)); paint(true) }

    scrim.querySelector('#obGetStarted').onclick = function () { goto(1) }
    scrim.querySelector('#obContinue1').onclick = function () { goto(2) }
    scrim.querySelector('#obContinue2').onclick = function () { goto(3) }
    scrim.querySelector('#obBack').onclick = function () { goto(state.step - 1) }
    scrim.querySelector('#obSkip').onclick = function () {
      writePrefs({ onboarded: true })
      if (window.prefs) window.prefs.onboarded = true
      closeOverlay()
    }
    scrim.querySelector('#obFinish').onclick = function () {
      writePrefs({ camera: state.camera, mic: state.mic, systemAudio: state.systemAudio, countdown: state.countdown, onboarded: true })
      if (window.prefs) Object.assign(window.prefs, { camera: state.camera, mic: state.mic, systemAudio: state.systemAudio, countdown: state.countdown, onboarded: true })
      closeOverlay()
    }

    // permission triggers
    scrim.querySelector('#obBtn-screen').onclick = function (e) {
      var btn = e.currentTarget
      btn.disabled = true; btn.textContent = 'Requesting...'
      navigator.mediaDevices.getDisplayMedia({ video: true }).then(function (stream) {
        stream.getTracks().forEach(function (t) { t.stop() })
        setPerm('screen', 'granted')
      }).catch(function () {
        setPerm('screen', 'denied')
        btn.disabled = false; btn.textContent = 'Allow screen recording'
      })
    }
    scrim.querySelector('#obBtn-mic').onclick = function (e) {
      var btn = e.currentTarget
      btn.disabled = true; btn.textContent = 'Requesting...'
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        stream.getTracks().forEach(function (t) { t.stop() })
        setPerm('mic', 'granted')
      }).catch(function () {
        setPerm('mic', 'denied')
        btn.disabled = false; btn.textContent = 'Allow microphone'
      })
    }
    // camera never opens the device here, it only explains the bubble
    scrim.querySelector('#obBtn-camera').onclick = function () {
      var note = scrim.querySelector('#obCamNote')
      if (note) note.hidden = !note.hidden
    }

    // defaults
    function wireSwitch(id, prefKey) {
      var input = scrim.querySelector('#' + id)
      if (!input) return
      input.onchange = function () {
        state[prefKey] = input.checked
        var patch = {}; patch[prefKey] = input.checked
        writePrefs(patch)
        if (window.prefs) window.prefs[prefKey] = input.checked
      }
    }
    wireSwitch('obCam', 'camera')
    wireSwitch('obMic', 'mic')
    wireSwitch('obSys', 'systemAudio')
    scrim.querySelectorAll('#obCountdown [role="tab"]').forEach(function (b) {
      b.onclick = function () {
        state.countdown = +b.dataset.val
        scrim.querySelectorAll('#obCountdown [role="tab"]').forEach(function (x) { x.setAttribute('aria-selected', String(x === b)) })
        writePrefs({ countdown: state.countdown })
        if (window.prefs) window.prefs.countdown = state.countdown
      }
    })

    paint(false)
    // offsetLeft on the step icons reads 0 until the modal has actually been
    // laid out (fonts, first frame), which would park Biscuit at the far
    // left. Re-settle him once layout has caught up.
    setTimeout(function () { updateRunner(state.step, false) }, 60)
  }

  window.startOnboarding = startOnboarding
})()
