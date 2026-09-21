#!/usr/bin/env node
// Fetch as an MCP server: lets any agent record the screen, transcribe it, and get a
// file back. Works from whichever client the person already pays for.
//
// The work happens in the Fetch app, not here. This process only translates MCP into
// the app's socket protocol. See bridge.js for why that separation is load-bearing.
//
// Tool descriptions are deliberately plain. They are what the model reads to decide
// which tool to call, and personality there costs accuracy.

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { call, setClient } from './bridge.js'
import { createRequire } from 'node:module'

// The two tables an agent reads about that must not be restated here in prose. A second
// copy of a number goes stale silently, and this one is read before a tool is chosen:
// the house status bar is the preset Fetch really sets, said in the wrapper's own words,
// and the size list is whatever ui/sizes.js holds today. Both modules are pure and spawn
// nothing at import, so a Mac with no Xcode pays nothing for them.
const require = createRequire(import.meta.url)
const simctl = require('../ui/simctl')
const Sizes = require('../ui/sizes')
// What a take listens to, said in the file that decides it. Three descriptions here and
// in ui/agent-bridge.js promised a simulator take an audio track while the default was
// off, and an agent found out from transcribe that the file was silent. A description
// that reads the constant cannot promise what the default does not wire.
const RecOpts = require('../ui/recorder-opts')
const HOUSE_BAR_SAID = simctl.describeBar(simctl.HOUSE_BAR)
const SIZE_LIST = Sizes.list().map(p => `${p.id} (${p.w}x${p.h}, ${p.kind})`).join(', ')

const text = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] })

// What every client is handed before it calls anything. MCP has one field for this and
// it was empty, so the loop this product is built around reached the agent inside the
// app and nobody else: every outside client started from nothing and worked it out, or
// did not. Costing one argument to the constructor, that was the cheapest thing in the
// product left undone.
//
// The shape of a job, not a manual. What a tool takes and what it gives back belongs in
// that tool's own description, so a tool can change without a word of this going stale.
// The job lines are EditAssist's LOOP word for word (ui/edit-assist.js), the same
// doctrine the in-app agent gets: one copy, said twice, would be one copy quietly going
// wrong. test/tools.test.js fails if the two ever differ, and fails if a tool named
// anywhere below is not one this server registers.
const INSTRUCTIONS = [
  'Fetch records this Mac\'s screen, captures stills of it, and edits what it took. The work happens in ' +
    'the Fetch app on the person\'s own machine; these tools are its hands.',
  '',
  'A screenshot is a take of one frame: take_shot captures one, and every tool that styles, aims at, marks ' +
    'or exports a recording takes a shot too.',
  '',
  'How a job goes, every time:',
  '- See the whole take with contact_sheet before you change it.',
  '- Write the brief and the plan with direct before the first change.',
  '- Make one step at a time and close it: apply_edit takes step, for example "P3".',
  '- Call review before you reply.',
  '- Fix what review names, or say in your reply why you did not.',
  '- Report the plan and what changed, not prose.',
  '- Write down with remember anything the person tells you that will still be true next week: what ' +
    'their product is called, who a demo is for, what must never be on screen.',
  '',
  'Read a product\'s rules with guidelines before you plan, capture or style for it. A rule you draft ' +
    'counts only once the person says yes to it.',
  '',
  'Aim at a box, never at a coordinate: call find_on_screen at that moment in the person\'s own words ' +
    'and send the id it hands back. A zoom or a mark placed from numbers read off a picture lands on ' +
    'the wrong thing.',
  '',
  'Decide rather than ask: a default they can see and undo beats a question. ask is for a request with two ' +
    'readings that would touch different parts of the take. Show a change that is wide or awkward to take ' +
    'back with propose before it lands.',
  '',
  'Every result carries the state it changed: the plan that is left, how far the edit is from the brief, ' +
    'a frame of it, and what is wrong with it. Read that rather than calling again to find out.',
  '',
  'Takes, edits and settings move between turns, under the person\'s own hands as well as yours. Read ' +
    'the current state in this turn instead of trusting what an earlier one said.',
  '',
  'Esc is the person stopping you: every call is refused until they let you continue. Stop and ask them.',
  '',
  'Reply in short plain sentences, and never with an em dash.',
].join('\n')

export function build() {
  const server = new McpServer({ name: 'fetch', version: '0.1.0' }, { instructions: INSTRUCTIONS })

  // Every call goes through here so Fetch can attribute it. The client names itself
  // during initialize and that is the only reliable source: Claude Code, Codex and
  // the rest are all Node programs, so the process tree just says "node" for every
  // one of them. Read at call time rather than from an initialize hook, because the
  // hook does not fire under serveStdio, and doing it here is idempotent anyway.
  const drive = (op, args, opts) => {
    try { setClient(server.server.getClientVersion()?.name) } catch {}
    return call(op, args, opts)
  }

  // A long call its client can take back. The app is handed a key for the work it
  // starts (args.job), and a cancel from the client, or this side giving up on the
  // answer, sends job.cancel with that key so the work stops where it runs. The call
  // itself still answers: the app says in words that the work was stopped.
  let jobSeq = 0
  const stoppable = async (work, extra) => {
    const job = `${process.pid}-${Date.now().toString(36)}-${++jobSeq}`
    const signal = extra && extra.signal
    let sent = false
    const stop = () => { if (sent) return; sent = true; drive('job.cancel', { job }).catch(() => {}) }
    if (signal) {
      if (signal.aborted) throw new Error('cancelled before it started')
      signal.addEventListener('abort', stop, { once: true })
    }
    try {
      return await work(job)
    } catch (e) {
      if (/did not answer/.test(String(e && e.message))) stop()
      throw e
    } finally {
      if (signal) signal.removeEventListener('abort', stop)
    }
  }

  server.registerTool(
    'record_start',
    {
      description:
        'Start recording the Mac screen. Returns once recording has actually begun. ' +
        'Recording continues until record_stop is called, which returns the file path. ' +
        'Only one recording can run at a time. Depending on the person\'s Recording ' +
        'access setting, Fetch may first ask them to approve the take, so this can wait ' +
        'on a person; if they decline, it fails with that reason. The take is recorded ' +
        'without the Mac\'s own pointer; report yours with the pointer tool as you act, and ' +
        'the video draws a cursor there. With neither window nor display, Fetch records the window of ' +
        'the app in front (never Fetch itself), and the result names it; pass full_screen or display ' +
        'only when the person asked for the whole screen. If the window is mostly covered by other windows, ' +
        'nothing is recorded and this returns status "occluded" with what covers it, the ' +
        'display it is on and the crop that shows just that window. ' +
        'With simulator, the device is resolved to its window and recorded there. ' +
        RecOpts.SIM_AUDIO_SAID + ' ' +
        'The status bar is set to 9:41 for the take and put back on record_stop. Where the device screen ' +
        'sits inside that window is measured off one picture of it before the take starts, and that ' +
        'rectangle goes onto the edit, so the look crops the Mac window off and the drawn phone is the ' +
        'only phone in the picture. Measured and not worked out: a window has a toolbar and a bezel in ' +
        'it, so where nothing could be measured there is no rectangle, the result says so, and the ' +
        'picture keeps the whole window rather than a crop aimed at a guess.',
      inputSchema: z.object({
        display: z.string().optional()
          .describe('Display id to record the whole of. Only when the person asked for the whole screen.'),
        window: z.string().optional()
          .describe('Window id from list_windows. Records that window only. Omit to record the front app\'s window.'),
        simulator: z.string().optional()
          .describe('A simulator by UDID or by name, instead of window. Fetch records the window it sits in, ' +
            'where it sits. The simulator tool boots one and opens its window.'),
        status_bar: z.boolean().optional()
          .describe('With simulator, default true: 9:41, full bars, charged, put back on record_stop.'),
        full_screen: z.boolean().optional()
          .describe('Record the whole main display instead of a window. Only when the person asked for it.'),
        allow_covered: z.boolean().optional()
          .describe('Record a window even when other windows cover it. Its covered part will not update.'),
        mic: z.boolean().optional().describe('Include the microphone. Default off.'),
        system_audio: z.boolean().optional().describe(RecOpts.SYS_AUDIO_ARG_SAID),
        camera: z.boolean().optional().describe('Record the camera bubble. Default off; only when the person asked for their face.'),
        name: z.string().optional()
          .describe('Name for the take, e.g. "Linear · Issue Triage". Used as given and never replaced. ' +
            'Omit it and Fetch names the take from the app in front and, when it has speech, from what was said.'),
      }),
    },
    async args => {
      // Waits on the person's approval (in Ask mode) and the countdown, so this can
      // legitimately sit for a while. Resolves when capture has begun.
      const r = await drive('record.start', args, { timeoutMs: 15 * 60 * 1000 })
      return text(r)
    })

  server.registerTool(
    'record_stop',
    {
      description:
        'Stop the recording that is currently running. Returns the saved file path ' +
        'and size once the file is written. Each take gets its own folder, ' +
        '~/Movies/Fetch/<Take>/ by default, and the path returned is the raw take in its ' +
        'Original/ subfolder; pass that path to the editing tools. If the recorded window ' +
        'closed before this was called, the take up to that moment is already saved: this ' +
        'returns its path with stopped_early set. If a recorded window showed nothing new for ' +
        'several seconds (usually because another window covered it), note says so. A take given ' +
        'no name may be renamed shortly after, from what was said; the path returned here keeps ' +
        'working with every tool, and list_recordings shows the new one. ' +
        'audio on the result is read off the written file rather than off what was asked for, so a take ' +
        'that came out silent says so here instead of leaving transcribe to break the news, and one whose ' +
        'sound stopped part way says for how long the end is silence (audio.sync.silent_end_ms). Where the ' +
        'take had system audio, audio.scope says whose sound it is, off the recorder\'s own report: app (only ' +
        'the window\'s app), device (only the simulator\'s own sound) or mac (everything this Mac played, ' +
        'music, a notification or a call included), and audio.heard says it in words, with the reason for mac. ' +
        'Tell the person when it is mac. A device take ' +
        'also puts back everything Fetch changed on the device and writes the device screen rectangle onto ' +
        'the edit, and a brief directed before the take existed becomes the job on it.',
      inputSchema: z.object({}),
    },
    async () => text(await drive('record.stop', {}, { timeoutMs: 3 * 60 * 1000 })))

  server.registerTool(
    'record_status',
    {
      description:
        'Whether Fetch is recording, whether that take is paused, and the path of a take that ended ' +
        'on its own because the recorded window closed.',
      inputSchema: z.object({}),
    },
    async () => text(await drive('record.status')))

  server.registerTool(
    'record_pause',
    {
      description:
        'Hold the take that is running, or let a held one go again. One take, one file: what ' +
        'happens while it is paused is not in the video, and the camera and the cursor lose the same ' +
        'stretch the screen does. Use it when the flow you are recording has to wait on something ' +
        'nobody wants to watch, a login screen or a long build, rather than stopping and starting ' +
        'again, which leaves two takes behind. The result says which way it went.',
      inputSchema: z.object({}),
    },
    async () => text(await drive('record.pause')))

  // An agent take is recorded without the Mac's pointer, which belongs to the person at
  // the desk. This is how the agent's own pointer gets into the video instead, and onto
  // the person's screen while it records. It is drawn, never the person's mouse.
  server.registerTool(
    'pointer',
    {
      description:
        'During a take started with record_start, say where your pointer is, so the video shows ' +
        'a cursor gliding to it (and pressing, with a ripple, when click is true). The take is ' +
        'recorded without the Mac\'s own pointer, so without these calls the video has no cursor. ' +
        'The cursor is Fetch\'s own (a gold arrow with a round badge), drawn in the export and ' +
        'shown live over the recorded window so the person watching sees where you are acting. ' +
        'Nothing moves or clicks the person\'s mouse: this only reports a position. Never move ' +
        'the real pointer yourself; drive the app with your usual tool and report here. ' +
        'Call it right before each action you take in the recorded window: before a click with ' +
        'click true, before typing into a field, before hovering. Each call is stamped when it ' +
        'arrives; the cursor arrives there at that moment and glides from the previous point. ' +
        'Clicks reported here are also what auto-zoom zooms on. On a take of a simulator the mark is a ' +
        'finger rather than an arrow, and it is gone from the glass between taps: the take decides that, ' +
        'so there is nothing here to set. The simulator tool\'s tap reports itself here already.\n' +
        'Coordinates, one of:\n' +
        '- x, y as fractions 0 to 1 of the recorded window (or display), from its top left.\n' +
        '- x, y as page pixels (CSS, page zoom 100%) with viewport, for a browser window: read ' +
        '{inner_width: innerWidth, inner_height: innerHeight, outer_width: outerWidth, ' +
        'outer_height: outerHeight} from the page once (Playwright: page.evaluate). The browser ' +
        'chrome (tabs, toolbar) sits above the page, so Fetch places the point at ' +
        'x = ((outerWidth - innerWidth) / 2 + pageX) / outerWidth and ' +
        'y = (outerHeight - innerHeight + pageY) / outerHeight of the window. For an element, ' +
        'use the centre of its boundingBox(). Window takes only: for a display take send ' +
        'screen points (add window.screenX and screenY) with window_relative false.\n' +
        '- x, y as macOS screen points with window_relative false, for native app drivers.',
      inputSchema: z.object({
        x: z.number().describe('Across: a fraction 0 to 1 by default, page pixels with viewport, screen points with window_relative false.'),
        y: z.number().describe('Down, in the same units as x.'),
        click: z.boolean().optional().describe('A click happens here now: the cursor presses and ripples. Default false.'),
        window_relative: z.boolean().optional()
          .describe('Default true: x, y are fractions of the recorded window or display. False: macOS screen points.'),
        viewport: z.object({
          inner_width: z.number(), inner_height: z.number(),
          outer_width: z.number(), outer_height: z.number(),
        }).optional().describe('The browser\'s innerWidth, innerHeight, outerWidth, outerHeight; x, y are then page pixels.'),
      }),
    },
    async args => text(await drive('record.pointer', args)))

  // Discovery, so a target can actually be chosen. The usual shape is: something
  // else (Playwright, simctl, a shell command) opens the window, then list_windows
  // finds it and record_start captures that window rather than the whole screen.
  server.registerTool(
    'list_windows',
    {
      description:
        'List the windows currently open on screen, with the id record_start and take_shot take. ' +
        'Use this to record or capture one application window rather than a whole display, for ' +
        'example a browser a test driver just opened. A simulator window carries device: which ' +
        'device is inside it and its own screen, so there is nothing to match on the app name for. ' +
        'Where the glass sits inside that window and density come with it once something has taken a ' +
        'picture of the window to measure them, and this call takes none. The simulator tool lists the ' +
        'devices themselves, including the ones with no window up yet, and its ready measures one.',
      inputSchema: z.object({
        app: z.string().optional()
          .describe('Only return windows whose application or title contains this, case insensitive.'),
      }),
    },
    async (args = {}) => {
      const all = await drive('windows.list')
      const q = (args.app || '').toLowerCase()
      const hits = q
        ? all.filter(w => (w.app || '').toLowerCase().includes(q) || (w.title || '').toLowerCase().includes(q))
        : all
      return text(hits)
    })

  server.registerTool(
    'list_displays',
    {
      description: 'List the displays attached, with the id record_start and take_shot take.',
      inputSchema: z.object({}),
    },
    async () => text(await drive('displays.list')))

  // The iOS Simulator, as a thing Fetch knows rather than a window with a name that
  // happens to match. One tool with an action: six tools for six command line verbs
  // would be six descriptions in every context window for one capability.
  server.registerTool(
    'simulator',
    {
      description:
        'The iOS simulators on this Mac, and the few things Fetch does to one. Recording a simulator ' +
        'is record_start with simulator, and a screenshot of one is take_shot with simulator: the ' +
        'window is captured where it sits and nothing is ever brought to the front. A take of it ' +
        'carries sound by default, where a capture of the device framebuffer has no audio track at all. ' +
        'That sound is the device\'s own where the person has given Fetch System Audio Recording, and ' +
        'otherwise everything this Mac plays while it records, the device among it; record_stop says which.\n' +
        'list: every device, its state, its own screen in pixels and points, and its window if one is ' +
        'on screen. Where a picture of that window has been taken it also carries the screen rectangle ' +
        'inside it and density, the captured pixels per pixel the device really has: under 1 the window ' +
        'is scaled down and an exact store size is refused, which the note beside it says how to fix. ' +
        'Both are measurements, so a device nothing has captured yet has neither, and list takes no ' +
        'picture of its own.\n' +
        `ready: boot a device, open its window in the background, install an app, launch it, set ` +
        `the status bar (${HOUSE_BAR_SAID}), switch the appearance, and take one picture of the window ` +
        'to measure where the screen sits inside it. The result names every one of those in words and ' +
        'comes back with the elements on the glass and the ids a tap takes, so the next call is the ' +
        'tap. record_stop puts back the status bar and the appearance, as does the next launch of ' +
        'Fetch if it died mid take.\n' +
        'go: open a deep link on the device. It lands on the same screen every time, where a run of ' +
        'taps does not, so prefer it for getting somewhere.\n' +
        'tap: send one touch, report it onto the take in the same call so the video draws a finger ' +
        'where it landed, then read the screen it left behind and hand back the new ids. Aim it with ' +
        'an element id, never a coordinate read off a picture: ready and the tap before this one both ' +
        'hand the ids back, and find_on_screen mints them on any shot of the device.\n' +
        'restore: put the status bar and the appearance back by hand, on the device a recording is of ' +
        'when none is named. It is automatic on record_stop.\n' +
        'Each argument takes one kind of identifier, checked before the person is asked anything: a value ' +
        'in the wrong one is moved where that is certain (a bundle id sent as app is launched as bundle, ' +
        'and the result says so under moved) and refused by name where it is not.\n' +
        'Booting, installing, launching, opening a link and tapping each need the person\'s word, and ' +
        'Fetch asks them for it: do not claim it yourself. Creating, cloning, erasing and deleting a ' +
        'device are refused to everyone, and so is capturing the device framebuffer, which has no ' +
        'audio track. The command line Fetch drives has no touch of its own, so a tap needs a tool the ' +
        'person installed and says so plainly when there is none. That is not a dead end: record them ' +
        'tapping and the finger is still drawn where they touched.',
      inputSchema: z.object({
        action: z.enum(['list', 'ready', 'go', 'tap', 'restore'])
          .describe('What to do. list is free; the rest need a device.'),
        device: z.string().optional()
          .describe('The device: its UDID, or the name the person gave it, from list. Never the word booted, ' +
            'never a window id and never a bundle id. tap and restore take the device the recording in hand is ' +
            'of when this is left out.'),
        app: z.string().optional()
          .describe('ready: Absolute path to a built .app bundle on this Mac, for example /Users/me/Build/Products/' +
            'Debug-iphonesimulator/My.app. It is installed and then launched. Not a bundle id: that is bundle.'),
        bundle: z.string().optional()
          .describe('ready: the bundle id of an app already on the device, for example com.me.app. It is launched. ' +
            'Not a path: that is app.'),
        appearance: z.enum(['light', 'dark']).optional()
          .describe('ready: light or dark, put back on restore. Two calls give a light set and a dark set.'),
        status_bar: z.boolean().optional()
          .describe('ready: default true. The person\'s own values are read and written down first, and go back.'),
        url: z.string().optional()
          .describe('go: the deep link to open on the device, with its scheme, for example myapp://onboarding. ' +
            'Not a bundle id.'),
        element: z.string().optional()
          .describe('tap: an element id (E12), off the screen the last ready or tap handed back, or from ' +
            'find_on_screen. This is how a tap is aimed. An id, never the words on the button.'),
        path: z.string().optional()
          .describe('tap: Absolute path to the shot or recording find_on_screen was called on, where that id was ' +
            'minted. Leave it out for an id off the last ready or tap on this device.'),
        x: z.number().optional()
          .describe('tap: across, in the device\'s own points, for when nothing on screen can be named. ' +
            'Reported back as hand aimed, the same way a hand aimed zoom is.'),
        y: z.number().optional().describe('tap: down, in the device\'s own points.'),
      }),
    },
    // A boot waits on the device and an install waits on the bundle, and both can wait
    // on the person saying yes, so this gets a person's patience rather than a machine's.
    async args => text(await drive('sim.do', args, { timeoutMs: 10 * 60 * 1000 })))

  // A screenshot. Its own tool because capturing one frame is a different act from
  // recording, and the only one: everything that happens to it afterwards is a tool
  // that already existed, handed a shot's path instead of a recording's.
  server.registerTool(
    'take_shot',
    {
      description:
        'Capture one frame of this Mac as a screenshot and open it, ready to be styled. A screenshot is ' +
        'a take of one frame, so everything after this is the tools you already have: apply_look for the ' +
        'background, the device frame, the tilt and the grade, apply_edit for the headline and the ' +
        'words on the picture as well as for lifts, loupes, arrows, numbered steps, redactions and ' +
        'blurs, find_on_screen to name what is on it, preview_frame to ' +
        'look at it, review to check it, and export to write the finished PNG. ' +
        'The result carries a picture of what was captured, so there is nothing to call to see it. ' +
        'With simulator, the device is resolved to its window, the status bar is set to 9:41 for the one ' +
        'frame and put straight back, and the capture is measured to find where the device screen sits ' +
        'inside the window. That rectangle goes onto the shot, so the picture is the glass and not a Mac ' +
        'window with a phone drawn round a phone, and it is what the next tap is aimed through. Measured ' +
        'off this very picture, so where an app painted black to its own edge leaves nothing to measure ' +
        'the result says so and the whole window is kept rather than a guess cropped to. ' +
        'With neither window nor display, Fetch captures the window of the app in front (never Fetch ' +
        'itself, never the terminal you run in), and the result names it. The person\'s own pointer is ' +
        'left out unless you ask for it, the window\'s own drop shadow is never in the file (Fetch draws ' +
        'its own), and anything on their never-record list is never in the frame. Depending on their ' +
        'Recording access setting Fetch may ask them to approve it first, so this can wait on a person; ' +
        'if they decline it fails with that reason. The raw capture is kept in the shot\'s Original/ ' +
        'folder and never changed, so a shot can be styled again from it for ever.',
      inputSchema: z.object({
        window: z.string().optional()
          .describe('Window id from list_windows. Captures that window alone, on transparency, with its own corners.'),
        simulator: z.string().optional()
          .describe('A simulator by UDID or by name, instead of window. Its window is captured where it sits.'),
        status_bar: z.boolean().optional()
          .describe('With simulator, default true: 9:41, full bars, charged, and the person\'s own values back at once.'),
        display: z.string().optional()
          .describe('Display id from list_displays. Captures that whole screen. Only when the person asked for the whole screen.'),
        region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional()
          .describe('A rectangle in macOS screen points, top left origin, captured whatever is under it. ' +
            'Judged as a display, since no list of apps can be honoured by excluding windows from a rectangle.'),
        cursor: z.boolean().optional()
          .describe('Keep the person\'s own mouse pointer in the picture. Default off: a still of a page should not carry it.'),
        name: z.string().optional()
          .describe('Name for the shot, e.g. "Tempo row". Used as given and never replaced. Omit it and Fetch ' +
            'names the shot from the app or the site it captured.'),
      }),
    },
    // Can wait on the person approving the capture, which is a native dialog on Fetch's
    // own window, so it gets a person's patience rather than a machine's.
    async args => {
      const r = await drive('shot.take', args, { timeoutMs: 5 * 60 * 1000 })
      const out = text(r)
      // The only tool that makes the artefact and used to hand back no picture of it,
      // so an agent that cannot see the screen spent a second call looking at its own work.
      const shot = r && r.preview && r.preview.image
      if (shot) try { out.content.push({ type: 'image', mimeType: 'image/jpeg', data: readFileSync(shot).toString('base64') }) } catch {}
      return out
    })

  // ── editing ──────────────────────────────────────────────────────────
  // Everything the editor window can do, drivable without opening it. The edit is
  // one document, so an agent here and a person in the window change the same thing.
  server.registerTool(
    'get_edit',
    {
      description:
        'Read the current edit of a recording: its clips, zooms, text layers and beats, ' +
        'each with a short stable id (C1, Z1, T1, B1) and times in seconds. Use the ids ' +
        'from this when calling apply_edit. Captions are summarised as a count unless ' +
        'include_cues is set, which returns every caption with its id (S1...), times and text, ' +
        'for correcting words the transcriber misheard (send the corrected list as cues). ' +
        'Given a shot\'s path it reads the shot instead: its capture size, its marks, its crop and its ' +
        'look, and a line saying what one frame does not have.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording, or to a shot.'),
        include_cues: z.boolean().optional().describe('Include the caption text. Default false.'),
        include_pointer: z.boolean().optional().describe('Include the pointer track (pointer.track), to adjust it. Default false.'),
      }),
    },
    async args => text(await drive('edit.get', args, { timeoutMs: 60000 })))

  server.registerTool(
    'apply_edit',
    {
      description:
        'Change the edit of a recording. Send only what you are changing: anything you ' +
        'leave out is kept, so adding a zoom never touches the crop or the captions. ' +
        'Read get_edit first; its `options` lists the allowed values. ' +
        'All positions and sizes are 0 to 1 fractions of the frame AFTER the crop (use ' +
        'get_frame with cropped: true to see it); all times are seconds in the original ' +
        'recording.\n' +
        'AIMING: before placing any zoom or mark, call find_on_screen at that moment with the ' +
        'person\'s words and send element: its E id (e.g. element: \'E12\'), or its box; never ' +
        'work out x, y and scale yourself or place one from coordinates guessed off a ' +
        'picture (the result warns when a zoom is aimed by a centre point). Add only what was asked for: a zoom request is a zoom, not a ' +
        'zoom plus a spotlight. A new lift or spotlight takes the place of any it overlaps (the ' +
        'result lists them under replaced; the result warns if two still overlap). A lift needs room: one whose box is at or near ' +
        'the frame edge, or on a pane whose content is cut off (find_on_screen marks these no_lift), is refused, ' +
        'naming the card or grid inside it to lift instead: when the person asked for a lift, lift that one; a spotlight ' +
        'is for when nothing inside can be raised, and say so. A new lift or ' +
        'spotlight is held to the part of its span where its box shows the element, so one timed ' +
        'to the narration does not lift a card before it opens (the result lists it under retimed). ' +
        'The result\'s check.preview_frame_at lists when to look (just after each new zoom or mark lands, ' +
        'and in its middle): call preview_frame once with at set to all of them, and fix the edit if any ' +
        'frame is not on the thing the person meant, before saying it is done. Re-aiming a zoom lists under ' +
        'alongside the lifts and spotlights still playing with it; remove one the person did not ask for, and name each.\n' +
        'LISTS (sending clips, zooms, texts or cues replaces that whole list; keep the id on every item you send ' +
        'back, and omit id only on new items). marks are merged by id instead: a mark sent with ' +
        'an id changes that mark, one without an id is added, and every mark you leave out stays. ' +
        'To delete anything, name it: remove: [\'M12\', \'Z3\'] (any list). The result lists every ' +
        'id the edit took out under removed and replaced; tell the person.\n' +
        '- clips [{id,start,end,rate,audio}]: the kept pieces in order. Trimming or cutting is ' +
        'changing these. rate is how fast a piece plays: 2 is twice speed, 0.5 is half, and a pair ' +
        '[1, 4] ramps from the first to the second across it. Left out it is 1, and 0.1 to 20 is the range: ' +
        'anything outside it is held to the nearest end and said under warnings, and there is no rate that ' +
        'freezes a frame. A piece running faster ' +
        'than 1 is silent unless audio.speedAudio is keep, and the finished length in the result is ' +
        'measured at the rates set. ' +
        'audio {gain (dB, -10 to 10), denoise, mute} is that clip\'s own sound, and anything it leaves ' +
        'out is the take\'s own audio setting: lift one quiet passage without lifting the rest, pull a ' +
        'loud keyboard down on its own, or mute a stretch outright. probe with loudness measures every ' +
        'clip and names the gain to write. A clip running faster than 1 is silent whatever its gain says, ' +
        'unless audio.speedAudio is keep.\n' +
        '- zooms [{id,start,end,element} or {id,start,end,box} or {id,start,end,scale,x,y}]: ' +
        'element is an E id from your last find_on_screen on this recording; box {x,y,w,h} is the thing ' +
        'to frame (from find_on_screen): Fetch centres on it with room around it and picks the ' +
        'scale (1.2x to 2.6x). Sent with a box, the zoom\'s old x, y and scale are ignored. ' +
        'Otherwise scale e.g. 1.8 and x,y the point to centre on. ' +
        'Left out, scale is 1.8 and x,y the frame centre, so "zoom in on the first two ' +
        'seconds" is just {start:0,end:2}: add it, do not ask for numbers the person did not give.\n' +
        '- marks [{id,kind,start,end,x,y,w,h,n,strength}]: kind is redact (destroys the ' +
        'region, for anything private), blur (a Gaussian blur, strength 4 to 60, default ' +
        '18; softens but can be partly undone, so never for secrets; soft rounded edge), ' +
        'lift (the element raised off the page: cut out with its own rounded corners, a ' +
        'few percent larger over a soft shadow, the rest of the frame dimmed about a third ' +
        'and lightly blurred; the premium way to say "look at this card", best with the ' +
        'element\'s exact box), spotlight (the same cutout without the rise: the element ' +
        'stays put, everything else dims to about half with a light blur), loupe (a magnified inset of a ' +
        'small area, drawn beside it, for a detail too small to read and too small to zoom to without ' +
        'losing the context it sits in; needs the area\'s box), step (a round gold badge; n is the ' +
        'number, left out the steps count 1, 2, 3 in order), or arrow (a gold arrow that stands outside ' +
        'the box and points at the middle of its nearest edge, so what it points at is never under it: ' +
        'the light way to say "this one" where a zoom or a lift would be too heavy. Takes from: left, ' +
        'top, right or bottom, the side it comes in from, and picks the side with room where you do not ' +
        'say. It appears, points and goes, so give it 2 to 6 seconds). Lift and spotlight ease in and ' +
        'out on the zoom curve, and a zoom starting or ending within 1.2s of one, or up to ' +
        '3s inside it, carries it, so zoom and lift read as one move: to zoom on and lift ' +
        'one thing, send the same box to both. For redact, blur, lift, spotlight and arrow x,y is the top-left corner; for step x,y is ' +
        'the point it numbers, e.g. the corner of a card, and the badge is centred there so ' +
        'it never covers the card\'s label.\n' +
        '  Any mark also takes element (an E id from your last find_on_screen) or box {x,y,w,h} ' +
        'in place of x,y,w,h, the element\'s box as find_on_screen returned it; a step goes on ' +
        'that box\'s top left corner.\n' +
        '- texts [{id,text,start,end,fx,fy,sizeFrac,color,box,font,align,style,subtitle}]: ' +
        'overlays. fx,fy is the centre; sizeFrac is text height as a fraction of the frame, ' +
        'e.g. 0.06; start and end null for the whole clip. style is title (a title card: the ' +
        'frame blurred and dimmed behind a large title and a smaller subtitle, animated in; ' +
        'at the start the video rises into place as it clears; use for the opening and ' +
        'closing seconds, e.g. the product name, then the URL), lower-third (a name and a ' +
        'line under it, bottom left, with a gold rule) or label (a short line over the ' +
        'video; box true puts it on a dark pill: on a text, box is true or false, not a place). Without style, a centred text in the first or ' +
        'last second, up to 8s long, is a title and anything else a label. subtitle is the ' +
        'smaller line; without it, "Title · subtitle" or a line break splits the text. ' +
        'Titles and lower thirds use the house face; font applies to labels.\n' +
        '  The type a finished picture carries, which a still takes and a clip can too, and which is laid ' +
        'out against the picture rather than against the clock: style headline (the big line, standing ' +
        'beside the picture where its shape leaves a column and above it where it does not, with subtitle ' +
        'as the quieter line under it), caption (a line under the image, held to a readable measure), ' +
        'label (a short line on a plate pinned to a point: at {x,y}, the picture\'s own fractions, the same ' +
        'coordinates a mark takes) and callout (the same plate with a leader and a ring drawn onto the point ' +
        'it names). The type never lies over the product: the picture is refitted into the room left for it, ' +
        'and a headline too long for its column wraps and then steps down a size rather than running past it. ' +
        'look.typography.headline puts it above, below, left or right in place of letting Fetch choose.\n' +
        '- cues [{id,start,end,text}]: the captions. Read them with get_edit include_cues, ' +
        'correct the text, and send the whole list back.\n' +
        '- beats [{id,start,end,label}]: the named spans of the take, from what was said in it ' +
        '(list_beats). Send them to re-label or re-time what the timeline shows the person; leave ' +
        'them alone to keep the ones the transcript made.\n' +
        '- pointer [{t,x,y,click}]: the cursor drawn in the video, from pointer calls during an ' +
        'agent take. Unlike everything else, x,y are fractions of the whole recording (before ' +
        'the crop), so a crop does not move it. Read it with get_edit include_pointer. [] draws ' +
        'no cursor; null goes back to the track recorded with the take.\n' +
        'SETTINGS (merged, so send only the fields you change):\n' +
        '- look: how the video looks, by section, e.g. {preset: \'studio\'} or ' +
        '{frame: {aspect: \'16:9\', padding: 0.08}, background: {kind: \'gradient\', gradient: \'ink\'}, ' +
        'captions: {font, scale, colour, position, highlight}, motion: {fadeIn, fadeOut, zoomDepth, zoomEase, reveal, cutTransition, loop}, ' +
        'cursor: {show, hideSystem}, keys: {show, place, size}}. motion.loop is for a clip that autoplays and ' +
        'repeats on a page: a player counting frames on past the end seeds the grain, the tooth and the ' +
        'dither on each frame\'s place in the loop, so a second pass draws the frames the file holds, ' +
        'and can_loop says whether the edit wraps at all and what is stopping it. keys draws the keystrokes ' +
        'recorded with the take, and a take without a key track draws none. Every field, range and default: get_look_schema; whole looks: ' +
        'list_looks and apply_look. A field left out is kept, null resets it, {preset} starts from that look. ' +
        'Output keeps the take\'s shape unless frame.aspect is set, and a chosen shape is filled by the ' +
        'background, never black bars. Values out of range are clamped and listed under look_warnings, ' +
        'with anything the renderer that will draw your export leaves out.\n' +
        '- audio {denoise, loudnorm, gain (dB, -10 to 10), music (a bed under the voice, ducked ' +
        'while anyone speaks: warm, bright, calm, or null for none), speedAudio (what a sped-up clip ' +
        'does with the take\'s own sound: mute, the default, or keep)}\n' +
        '- audioTrack {file, name, volume 0 to 1, offset (seconds), replace}: one sound file laid over ' +
        'the whole take, for narration or a track the person has on disk. replace true mutes the take\'s ' +
        'own sound under it; null takes the track off. The voiceover tool writes one and sets this for you. ' +
        'offset and the track itself are on the recording\'s clock, not the finished video\'s, so the track ' +
        'is cut where the edit cuts and sped where a clip is sped: do not lay a line under a stretch running ' +
        'faster than about 1.5, it comes out gabbling.\n' +
        '- camera {on, x, y, size, keys}: only if a camera was recorded; x,y the bubble centre, ' +
        'size 0.1 to 0.45. keys moves the bubble over the take, so the face is large while somebody is ' +
        'introducing a thing and small once the thing itself is the point. Each key is ' +
        '{start, end, x, y, size, shape} for a stretch of the take, or {t, x, y, size, shape} for one ' +
        'moment on: fields left out keep what the bubble already had, so {start: 12, end: 20.4, size: 0.1} ' +
        'is the whole of "keep the camera small while the lift is up" and the bubble goes back to where it ' +
        'was at 20.4. shape is circle or rounded. Times are the recording\'s, like a zoom\'s; moving ' +
        'between keys takes the look\'s own zoom easing.\n' +
        '- crop {x,y,w,h} or null to remove it; cropAR sets the crop shape.\n' +
        'Older fields still work and are moved into look: backdrop, outAspect, capStyle, hideMacCursor, ' +
        'and look.zoomAmt, bdInset, bdRadius, burnCaps, denoise, loudnorm, gain, fadeIn, fadeOut, music.\n' +
        '- autoZoom: true to zoom automatically on each click, or where the pointer settled ' +
        'if nothing was clicked. Explicit zooms win over it. It follows the pointer track ' +
        'when the take has one (clicks sent with the pointer tool), otherwise the real ' +
        'pointer, which never sees clicks a driver injects into a page (Playwright ' +
        'page.mouse, anything over CDP). pointer.autoZoomSpots in the result says how many it found; ' +
        'at 0, place zooms yourself.\n' +
        'ON A SHOT (take_shot\'s path): the same call, on the half of the above that is about a picture. ' +
        'marks (every kind, merged by id, aimed by element exactly as here), texts, crop, cropAR, viewport ' +
        'and look. A mark or a text on a shot takes no start and no end, and one sent with them is dropped ' +
        'rather than kept and ignored: a headline has nothing to do with a clock. ' +
        'A hero, a docs picture and a store listing are a capture with a line of type on it, so that is one ' +
        'call: texts: [{text: \'Find any take in one search\', style: \'headline\', subtitle: \'Every window ' +
        'you recorded, searchable\'}], and the words stand beside or above the picture and never over it. ' +
        'clips, zooms, cues, beats, pointer, camera, audio, audioTrack and ' +
        'autoZoom are refused by name: one frame has no clock. group {gap, align, members: [{src, device}]} ' +
        'puts up to three captures in one picture, laid out at their real relative sizes, on one ground, ' +
        'in one light: two is a window beside a handset, not two pictures side by side.\n' +
        'Returns the full edit as it now stands. The result\'s preview is a frame of the edit at that moment; look at it. ' +
        'It also carries plan (what is left of the plan direct wrote) and distance (the length and shape ' +
        'against the brief), so you can see how far the edit still is from what was asked without calling ' +
        'anything else.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording, or to a shot.'),
        doc: z.record(z.string(), z.any()).describe('Only the parts of the edit you are changing.'),
        step: z.string().optional()
          .describe('The step of the plan this call finishes, e.g. "P3". Closes it; the result says what is left. ' +
            'Ids come from direct, which is where the plan is written.'),
      }),
    },
    async args => {
      // a still of the edit is drawn inside this call, so it takes longer than the rest
      const r = await drive('edit.apply', args, { timeoutMs: 90000 })
      const out = text(r)
      const shot = r && r.preview && r.preview.image
      if (shot) try { out.content.push({ type: 'image', mimeType: 'image/jpeg', data: readFileSync(shot).toString('base64') }) } catch {}
      return out
    })

  // ── the job ────────────────────────────────────────────────────────
  // A recording tool with 26 field tools still could not answer "make this a 60 second
  // demo for my landing page", because nothing in it knew what a job was. These four
  // are the job: state a target, keep a plan, hit a length, check the result.
  server.registerTool(
    'direct',
    {
      description:
        'Write down what this edit is for and the steps you will take, before the first change, and ' +
        'read back how far the work still is from both. Kept in a file beside the recording, so it ' +
        'survives the undo of the edit it produced and a turn that stops halfway: call it with nothing ' +
        'but a path to pick up a job already under way. Every apply_edit and export then carries plan ' +
        'and distance, and apply_edit step: "P3" closes a step. Call it again to refine the brief; what ' +
        'you send is merged, and a step whose words you leave alone keeps its id and its state. ' +
        'A shot is a job like any other and takes the same call; its distance is measured on its shape ' +
        'alone, since one frame has no length, and brief.what is then the field that says what the ' +
        'picture is for. review reads it, so a picture with no brief is a picture nothing can judge. ' +
        'A brief naming a device gets the whole device job back already laid out, with the call every ' +
        'step is: the tool\'s own name and the arguments the brief has answered.',
      inputSchema: z.object({
        path: z.string().optional().describe('Absolute path to the recording, or to a shot. Leave it out to ' +
          'direct a job before the take exists, which is how a job that films a device starts: record_stop ' +
          'puts the brief onto the take it turns out to be about.'),
        brief: z.object({
          what: z.string().nullable().optional()
            .describe('What the thing is, in the person\'s own words: "a help centre hero of the library", ' +
              '"the three steps of importing". On a still this is most of what a brief is, since one frame ' +
              'has no length for the rest of it to measure.'),
          seconds: z.number().min(1).max(3600).nullable().optional().describe('How long the finished video should be. Hit within 5 percent counts as hitting it.'),
          aspect: z.string().nullable().optional().describe('The shape it goes out in, e.g. "16:9", "9:16", "1:1".'),
          where: z.string().nullable().optional()
            .describe('Where it is going, in the person\'s own words: "landing page", "docs", "Product Hunt", "email", ' +
              '"X", "YouTube". review reads this and holds the edit to what that destination needs, e.g. captions ' +
              'burned in wherever it will autoplay muted.'),
          audience: z.string().nullable().optional().describe('Who watches it, if the person said.'),
          must_keep: z.array(z.string()).optional().describe('Moments or phrases that have to survive the cut.'),
          must_hide: z.array(z.string()).optional().describe('Anything on screen that must not ship: an email address, a key, a customer name.'),
          device: z.string().nullable().optional().describe('The device this job films, by name or UDID. Naming it ' +
            'makes this a device job: the plan comes back already laid out and every step carries the call it is.'),
          app: z.string().nullable().optional().describe('The app this job films: its bundle id if it is already on the ' +
            'device ("com.example.ios"), or the absolute path to a built .app to install first. The plan sends each ' +
            'to the argument simulator ready takes it in: a bundle id as bundle, a path as app. A display name is ' +
            'neither, and the result says so.'),
          size: z.string().nullable().optional().describe('The size the deliverable goes out at, e.g. "app-preview-6.9". ' +
            'It is written into the export step so the call is right the first time, and a size with a length ' +
            'window fills in seconds where the brief did not say.'),
        }).optional().describe('What was asked for. Merged with what is there; null on a field clears it.'),
        plan: z.array(z.string()).optional()
          .describe('The steps, in order, one short line each, up to twelve, e.g. ["cut to the three moments that matter", ' +
            '"zoom on the editor", "burn in captions"]. They are numbered P1, P2... Sending the list again re-plans.'),
        done: z.union([z.string(), z.array(z.string())]).optional().describe('Step ids finished, e.g. "P2" or ["P1","P2"].'),
        open: z.union([z.string(), z.array(z.string())]).optional().describe('Step ids to reopen, when review sends one back.'),
        drop: z.union([z.string(), z.array(z.string())]).optional().describe('Step ids you decided against. Closed, but not claimed as done.'),
        note: z.string().optional().describe('One line worth remembering about this job, for the next turn.'),
      }),
    },
    async args => text(await drive('edit.direct', args, { timeoutMs: 60000 })))

  server.registerTool(
    'review',
    {
      description:
        'Check an edit against what was asked for, before you say it is done. Returns a verdict, what ' +
        'is wrong with it ranked, and for each one the exact call that fixes it, plus the times to look ' +
        'at with contact_sheet. Measures the output length and the shape against the brief (direct), dead ' +
        'air still in the edit, captions and whether they are burned in, how much the camera moves, marks ' +
        'the edit never draws, two highlights on one place, and the ground against the take\'s own ' +
        'exposure. export runs it too, so its blocking items come back with the file. Fix what it names, ' +
        'or tell the person why you did not. ' +
        'On a shot it is a rubric about a picture, measured off the same plan the compositor draws it from: ' +
        'whether anything says what to look at, whether what the brief called private is under a redaction or ' +
        'only softened, a drawn device frame over a capture that already carries its own chrome, a shell cut ' +
        'the wrong way for what is in it or shipping a blank address, a lift raising a fragment or the whole ' +
        'page, a mark the picture does not draw, room round the frame, the ground against the capture\'s own ' +
        'exposure, and how many of the capture\'s pixels the box it was given can carry. The rules about a ' +
        'clock come back under not_judged, named, since a screenshot cannot be the wrong length.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording, or to a shot.'),
        declined: z.array(z.string()).optional()
          .describe('Rule names you have judged and written off, e.g. ["dead-air"], with the reason kept in ' +
            'direct\'s note. They are still measured and still reported, and they stop holding the verdict ' +
            'back: a call you made on purpose is not an open finding.'),
      }),
    },
    async args => text(await drive('edit.review', args, { timeoutMs: 60000 })))

  server.registerTool(
    'fit_to_length',
    {
      description:
        'Choose which parts of a recording survive so the finished video is about seconds long, by ' +
        'cutting filler words, then the long pauses, then whole beats worth the least. Asked for more ' +
        'than the take holds it cuts nothing and slows the moments it is already dwelling on instead, a ' +
        'zoom holding or a card up with nobody talking over it, never past half speed and never over ' +
        'speech; stretch.reach is the longest that edit can honestly be, and past it this refuses and ' +
        'says to record more. Writes clips on ' +
        'the edit, so nothing new is written beside the recording and every zoom, mark, caption and look ' +
        'is kept. Returns the length before and after, what was dropped, what is still over, and anything ' +
        'that lost its footage. It will not butcher a take to win an argument with a number: when the ' +
        'next cut would take it further under the target than it is over, it stops and names what that ' +
        'cut would have cost, for you to put to the person. Needs a transcript: call transcribe first.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
        seconds: z.number().min(1).max(3600).optional()
          .describe('How long the finished video should be. Leave it out to take the fillers and the dead air ' +
            'out and stop there. A take shorter than this is stretched by slowing the moments it is already ' +
            'dwelling on, as far as stretch.reach and no further.'),
        keep: z.array(z.string()).optional()
          .describe('What must survive: beat ids ("B4") or phrases matched against what was said. A term that ' +
            'matched nothing comes back under keep.unmatched rather than being dropped quietly.'),
        fillers: z.array(z.string()).optional()
          .describe('Extra filler words to cut, e.g. ["like"]. The ums, uhs and you knows go by default; ' +
            'like, so, right and actually do not, because they carry meaning often enough.'),
        step: z.string().optional().describe('A step of the plan this finishes, e.g. "P2". Same as apply_edit\'s.'),
        apply: z.boolean().optional().describe('Default true. False works out the cuts and returns them without changing the edit.'),
      }),
    },
    async args => text(await drive('edit.fit', args, { timeoutMs: 120000 })))

  // Every settled state of an edit, kept across sessions with who made it (ui/history.js).
  // One tool with three actions, because list, look and restore are one capability and
  // three descriptions would be three chances to drift.
  server.registerTool(
    'versions',
    {
      description:
        'The version history of a recording\'s edit, or a shot\'s: every settled state of it across sessions, ' +
        'who made each one (an agent by name, or the person) and what changed, by the ids the timeline draws. ' +
        'list names them newest first; the first is the edit as it stands. look shows one without changing ' +
        'anything: what restoring it would change, its edit, and a frame of it drawn by the export\'s own ' +
        'renderer. restore brings one back as a new version on top, so nothing ahead of it is lost and ' +
        'restoring the version before it takes it back; the result names that call. A restore keeps the ' +
        'recording\'s own facts from now, and a file the old version used that is gone stays as it is now, ' +
        'said under missing. revert_my_edit is still the call for taking back your own last change; this ' +
        'is for going back further, or to what the person had before.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording, or to a shot.'),
        action: z.enum(['list', 'look', 'restore']).optional().describe('Default list.'),
        version: z.string().optional().describe('look and restore: a version id from list, e.g. "V12".'),
        limit: z.number().int().min(1).max(200).optional().describe('list: how many, newest first. Default 20.'),
        at: z.number().optional().describe('look: the moment to draw, in output seconds. Default: where the versions differ.'),
        step: z.string().optional().describe('restore: a step of the plan this finishes, e.g. "P3".'),
      }),
    },
    async args => {
      const r = await drive('edit.versions', args, { timeoutMs: 90000 })
      const out = text(r)
      const pic = r && r.preview && r.preview.image
      if (pic) try { out.content.push({ type: 'image', mimeType: 'image/jpeg', data: readFileSync(pic).toString('base64') }) } catch {}
      return out
    })

  server.registerTool(
    'revert_my_edit',
    {
      description:
        'Take back your own last burst of changes to an edit, when you have made it worse. The same code ' +
        'path as the editor\'s own button for undoing an agent\'s change, so it merges by id and anything ' +
        'the person moved by hand since stays where they put it. It reaches only your own changes: their history ' +
        'is theirs. Most mistakes need less than this, since apply_edit merges by id (re-send a wrong zoom ' +
        'with its id to fix it, or remove: ["Z3"] to delete one), so reach for this when a whole pass was wrong. ' +
        'One stack, keyed by the file, so it takes back a change to a shot the same way.',
      inputSchema: z.object({ path: z.string().describe('Absolute path to the recording, or to a shot.') }),
    },
    async args => text(await drive('edit.revert', args, { timeoutMs: 90000 })))

  // Two tools that wait on a person rather than on a machine. They are worth their
  // latency only where a wrong guess costs an edit and an undo, and the undo is the
  // person's work: the bar is damage, not doubt, and both descriptions say so, because
  // an agent that asks about everything is worse than one that decides.
  server.registerTool(
    'ask',
    {
      description:
        'Put a fork to the person as buttons in the Fetch chat, instead of guessing. Only for a request ' +
        'with two or more readings that would touch different parts of the take, where the wrong one costs ' +
        'an edit and an undo: "the whole sidebar, or just the Practice button". Two to four choices, each ' +
        'one a thing you would then go and do. Never for styling, timing, wording, easing or a preset, and ' +
        'never for anything you can find out with find_on_screen, get_edit or list_recordings: fill those ' +
        'in yourself, since a default they can see and undo beats a question. It comes back whether or not ' +
        'they answered, within 90 seconds by default, and the result\'s do_next says what to do either ' +
        'way. Follow it, and do not ask about the same thing twice in one job.',
      inputSchema: z.object({
        question: z.string().describe('The question, in the person\'s own words, one short line.'),
        note: z.string().optional().describe('One more line of context, only if the question needs it.'),
        choices: z.array(z.object({
          id: z.string().optional().describe('Short handle for this choice, e.g. "practice_button". Made from the label if you leave it out.'),
          label: z.string().describe('What the button says, e.g. "Just the Practice button".'),
          hint: z.string().optional().describe('One short line under the label, e.g. "Leaves the rest alone".'),
        })).min(2).max(4).describe('Two to four choices, each one a thing you would then go and do.'),
        timeout_seconds: z.number().min(10).max(600).optional().describe('How long to wait. 90 by default.'),
      }),
    },
    // The card carries its own deadline and the app runs a backstop behind it, so this
    // waits past the longest one either can be set to rather than racing them.
    async args => text(await drive('chat.ask', args, { timeoutMs: 610000 })))

  server.registerTool(
    'propose',
    {
      description:
        'Show an edit in the Fetch chat before it lands, with Apply and Discard, instead of applying it. ' +
        'Takes what apply_edit takes, plus a title and the lines of what it would do, and shows one frame ' +
        'of the edit as it would be. Nothing is written until they press Apply: on Discard the edit is ' +
        'untouched, no undo level is spent and no file is made. Use it when the change is wide or awkward ' +
        'to take back: cutting more than half the take, changing or deleting something they made by hand, ' +
        'touching a redaction or a blur, or replacing the look. On Apply the result is apply_edit\'s own ' +
        'result, plan and distance and all, and the edit is already applied, so do not send it again. On ' +
        'every other branch the result says nothing was written and its do_next says what to do. Never ' +
        'apply a proposal they did not accept.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
        doc: z.record(z.string(), z.any()).describe('The change itself, exactly as apply_edit takes it.'),
        title: z.string().describe('What it would do, one short line, e.g. "Blur the Practice button".'),
        what: z.string().optional().describe('One more line: why, or what it leaves alone.'),
        changes: z.array(z.object({
          id: z.string().optional().describe('The id this would add or change, e.g. "M4".'),
          line: z.string().describe('One line, e.g. "Blur at 0:12 to 0:14".'),
        })).max(12).optional().describe('What it would do, by id, up to twelve lines.'),
        step: z.string().optional().describe('The step of the plan an Apply finishes, e.g. "P3". Same as apply_edit\'s.'),
        timeout_seconds: z.number().min(10).max(900).optional().describe('How long to wait. 240 by default.'),
      }),
    },
    // The longest the card can be set to, the app's backstop two seconds behind it, and
    // then the apply itself, which is apply_edit's own 90 seconds. Budgeted short, a
    // click at the last minute lands the edit while the agent is told the call failed,
    // and the agent sends the same document again.
    async args => text(await drive('chat.propose', args, { timeoutMs: 900000 + 2000 + 90000 })))

  // What a person says about their own software outlives the chat it was said in. The
  // job file (direct) holds this edit's brief; this holds everything that is still true
  // next week, which is the half that used to be asked for again every Monday.
  server.registerTool(
    'remember',
    {
      description:
        'Write down something durable the person told you about themselves or their product, so the ' +
        'next conversation still knows it. What it is called and how the name is said, who a demo is ' +
        'for, what must never be on screen, how they always want their videos. Not what to do to this ' +
        'edit, which is direct, and not a secret: a key, a token or a password is refused and the ' +
        'sentence handed back with the value taken out, for you to send again. The result carries the ' +
        'memory as the next conversation will see it, so you read what your own call did rather than ' +
        'the word saved. Call it once, as soon as the person says the thing, not in a batch at the end ' +
        'of a turn.',
      inputSchema: z.object({
        fact: z.string().optional()
          .describe('The sentence, in the person\'s own words. Left out only when forgetting.'),
        path: z.string().optional()
          .describe('Absolute path to the recording, when the fact is about that one take. It also names ' +
            'the product, so a fact about the product needs no `about`.'),
        scope: z.enum(['global', 'product', 'take']).optional()
          .describe('Which drawer: global is the person across every product, product is one product ' +
            'across every take, take is this recording alone and dies with it. Worked out from the ' +
            'sentence when you leave it out.'),
        about: z.string().optional().describe('The product, when no path says it.'),
        key: z.string().optional()
          .describe('A short topic handle, e.g. "product-name". A later fact with the same key replaces ' +
            'this one exactly, which is the reliable way to correct something.'),
        pin: z.boolean().optional().describe('Never dropped when the drawer fills. For the two or three that matter most.'),
        forget: z.string().optional()
          .describe('An id from the memory block (e.g. "F3"), or a key. Drops it instead of writing.'),
      }),
    },
    async args => text(await drive('memory.remember', args)))

  // The rules a product's work is held to, read before anything is planned, captured or
  // styled. Built on the memory above: a rule is a product fact with a section.
  server.registerTool(
    'guidelines',
    {
      description:
        'A product\'s rules, read before you plan, capture or style anything for it: name (what it is called ' +
        'and how it is said), audience (who a demo is for), never (what must never be on screen), look (how ' +
        'its screenshots look) and words (the words it avoids, and what it says instead). read gives the rules ' +
        'in force by section, the drafts waiting, and each gap as the question to ask the person. write adds ' +
        'rules: with from person, the person\'s own words, which Fetch puts to the person in a question before they ' +
        'are in force (kept as drafts if they do not confirm); with from screen, help or code, a ' +
        'draft you read off the product itself, with evidence saying where. A draft is in no briefing and ' +
        'checks nothing until the person says yes: show gives the drafts word for word with a seal, show that ' +
        'text to the person, and adopt only the ids they said yes to, with that seal and any rewording they ' +
        'made in edits. Fetch asks the person to confirm an adopt too, so your word alone never puts a rule in force. reject drops a draft; a rule in force goes with remember forget. check holds text (a ' +
        'caption, a title) and labels (find_on_screen\'s element texts) to the rules in force. Rules belong ' +
        'to one product: name it, or pass the path of one of its takes. The rules in force also open the ' +
        'memory block that direct, apply_edit, apply_look, take_shot and record_start hand back, and ' +
        'find_on_screen and review say when a picture or an edit breaks one.',
      inputSchema: z.object({
        action: z.enum(['read', 'write', 'show', 'adopt', 'reject', 'check']).optional()
          .describe('Default read, or write when rules are sent.'),
        product: z.string().optional().describe('The product, when no path names it.'),
        path: z.string().optional().describe('Absolute path to one of the product\'s takes or shots, which names it.'),
        rules: z.array(z.object({
          rule: z.string().describe('The rule, one sentence. In the person\'s own words when from is person.'),
          section: z.enum(['name', 'audience', 'never', 'look', 'words']).optional()
            .describe('Worked out from the sentence when left out; a sentence that fits none is refused.'),
          from: z.enum(['person', 'screen', 'help', 'code']).optional()
            .describe('person puts it in force once the person confirms it in Fetch. Anything else, or nothing, makes it a draft.'),
          evidence: z.string().optional().describe('Where a draft was read: a screen, a help page URL.'),
        })).max(20).optional().describe('write: the rules to add.'),
        ids: z.array(z.string()).optional().describe('show, adopt, reject: which drafts, e.g. ["F4"]. show with none shows every draft.'),
        seal: z.string().optional().describe('adopt: the seal show handed back for exactly these drafts.'),
        edits: z.record(z.string(), z.string()).optional()
          .describe('adopt: the person\'s rewording of a draft on the way in, by id, e.g. {"F4": "..."}.'),
        text: z.string().optional().describe('check: words to hold to the rules, a caption or a title.'),
        labels: z.array(z.string()).optional().describe('check: texts read off a picture, e.g. find_on_screen element texts.'),
      }),
    },
    async args => text(await drive('memory.guidelines', args)))

  server.registerTool(
    'can_loop',
    {
      description:
        'Whether this edit can play round again with no visible jump, and what is stopping it. For a clip ' +
        'that autoplays on a landing page, where the seam is the whole of the job. Answered from the plan ' +
        'before anything is drawn, so it is cheap and can be asked before the export. Returns loops true ' +
        'or false and a fault for each thing that does not end the clip the way it starts it, each with ' +
        'what it is and the fix: a fade, the take rising into place, a zoom still moving at the last ' +
        'frame, a caption mid-phrase, a mark or a cursor somewhere else at the end. It also returns ' +
        'source, the take\'s own time at the two ends: whether the recording itself comes back to where it ' +
        'began is the one half no plan can answer, so look at those two moments with get_frame and say so. ' +
        'Set the look\'s motion.loop once it passes. The file it exports is the same either way: what the ' +
        'switch buys is that a player counting frames on past the end, which the editor\'s stage does ' +
        'when it plays the clip round again, seeds the grain, the ground\'s tooth and the dither on each ' +
        'frame\'s place in the loop and so draws the frames the file holds rather than fresh noise.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
        look: z.record(z.string(), z.any()).optional()
          .describe('A look to try without saving it, e.g. {motion: {fadeIn: 0, fadeOut: 0, reveal: "none"}}, ' +
            'so you can ask whether a change would fix the wrap before making it.'),
      }),
    },
    async args => text(await drive('edit.loop', args, { timeoutMs: 120000 })))

  server.registerTool(
    'export',
    {
      description:
        'Render a recording with its current edit (trim, cuts, speed, zooms, marks, text, captions) and ' +
        'return the path of the result. For a take in its own folder the result is the ' +
        'deliverable at the top of that folder, <Take>/<Take>.<format>, and exporting again ' +
        'overwrites it. An older recording on the Desktop gets a -edit copy beside it. Runs ' +
        'in the background queue, one export at a time, so it can take a while for a long ' +
        'recording. MP4, MOV, WebM and GIF are all drawn by the compositor, several times real time, off ' +
        'the same frames: they differ at the encoder and nowhere else, so a GIF now carries the frame, ' +
        'the ground, the shadow, the grade and the easing it used to throw away. A GIF is drawn at a rate ' +
        'its own hundredth-of-a-second clock can hold, so every frame is held the same time, and without ' +
        'the ground\'s tooth or the film\'s grain, which 256 colours cannot carry and which cost five ' +
        'times the file. The audio-only formats and a take the compositor cannot read go to the classic ' +
        'ffmpeg renderer, which leaves some look fields out, and look_warnings then names what it left ' +
        'out and what to export to get it. ' +
        'engine in the result says which one drew it. With the look\'s motion.loop set, the result also ' +
        'carries loop, the same check can_loop runs, on the file you just made. The result also carries review, the same ' +
        'check the review tool runs, on the file you just made: the export happens either way, ' +
        'so read its blocking list and fix what it names before you say this is done. ' +
        'ON A SHOT (take_shot\'s path): the same call writes the finished picture beside its Original, as ' +
        'PNG, or JPEG where the person asks for one. PNG is the default as a measurement rather than a ' +
        'preference: a screenshot draws flat fields, one pixel hairlines and small text, and JPEG rings ' +
        'along exactly those edges. Nothing is asked about length, quality or resolution, because a still ' +
        'has none: it is drawn at the size it was captured, the multiple of the plan that puts one output ' +
        'pixel under each captured one, held between the plan\'s own size and 3x. The result says the ' +
        'multiple and says density, capture pixels per output pixel: 1 is the capture at its own size and ' +
        'over 1 is that much of it thrown away, which is what tells a deliverable from a preview. ' +
        'size names an exact store size instead, and the result says whether the file really is that pair ' +
        'of numbers. A capture the size would have to enlarge is refused before anything is drawn, because ' +
        'a soft store asset is worse than none, and the refusal names the device to shoot on instead. ' +
        'A video format on a shot is refused by name.\n' +
        'AN APP PREVIEW: size on a recording writes the store\'s own video. The rectangle, the length, the ' +
        'frame rate, the codec and the weight are all decided before a frame is drawn and named in one list ' +
        'where any of them does not hold. Frames are dropped and never invented: the rate is the take\'s own ' +
        'divided by a whole number, so a 60 frame take halves onto the cap exactly. The sound is one stereo AAC ' +
        'track at 256 kbps and 48 kHz, silence of that shape where the take has none. Whether the capture is ' +
        'enlarged is judged at the share of the picture the look draws it at, so a refusal names the ' +
        'frame.padding that puts it at its own pixels. The picture is H.264 High Profile Level 4.0 at a ' +
        `constant ${Sizes.VIDEO.h264.bps / 1e6} Mbps, inside the page's ${Sizes.VIDEO.h264.band.min / 1e6} to ` +
        `${Sizes.VIDEO.h264.band.max / 1e6}, and the take is drawn at the box the plan judged. The picture is the length: ` +
        'the sound is padded to it, never the other way round. The result carries store, read off the written ' +
        'file: its seconds against the edit\'s, its Mbps, and the poster frame the viewer sees before pressing ' +
        'play. A file short of the edit is not kept, and one outside the rate band is not called the store file. ' +
        'seconds at the top is the written file\'s own length.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording, or to a shot.'),
        format: z.enum(['mp4', 'webm', 'gif', 'mov', 'm4a', 'mp3', 'wav', 'png', 'jpg']).optional()
          .describe('Defaults to mp4 for a recording and png for a shot. m4a, mp3 and wav write the edited ' +
            'sound on its own, with no picture. png and jpg are a shot only.'),
        quality: z.enum(['high', 'balanced', 'small', 'best', 'fast']).optional()
          .describe('high is the largest, sharpest file; small the smallest. Defaults to balanced. These are the ' +
            'three words the person sees in the Export dialog, so you can repeat each other; best and fast are ' +
            'the older names for high and small and still work.'),
        resolution: z.enum(['720', '1080']).optional().describe('Omit to keep the original size.'),
        size: z.string().optional()
          .describe(`A store size by name: ${SIZE_LIST}. On a shot, a still size. On a recording, an app ` +
            'preview, which is also 15 to 30 seconds long, 30 frames a second or under, H.264, and 500 MB ' +
            'or under: everything that does not hold is named before anything is drawn, and the file is ' +
            'measured again after it is written, because the store measures the file. A take longer than ' +
            '30 seconds is cut to length with fit_to_length first, on its own spine, rather than from a ' +
            'number picked here. Exact integers, never an aspect, because a file one pixel out is ' +
            'rejected. A capture that cannot fill it is refused with the ways to fix it, rather than ' +
            'enlarged. This is a size, not a look: apply_look takes the preset that styles a picture.'),
        family: z.enum(['iphone', 'ipad', 'mac']).optional()
          .describe('What this take came off, where an app preview size is asked for and the recording does not ' +
            'say. A preview in one family\'s size showing another family\'s app is refused by name.'),
        step: z.string().optional()
          .describe('A step of the plan this finishes, e.g. "P6". Left out, the plan\'s own export step closes when ' +
            'the file written is the deliverable.'),
      }),
    },
    // An export runs for minutes. When the client cancels this call, or it runs out of
    // time, the export is stopped in the app too, rather than left to finish for nobody.
    async (args, extra) => text(await stoppable(job => drive('edit.export', { ...args, job }, { timeoutMs: 20 * 60 * 1000 }), extra)))

  server.registerTool(
    'rename_recording',
    {
      description:
        'Rename a recording so it is easy to find later, for example after the product ' +
        'and the flow it shows: "Linear · Triage an issue". For a take in its own folder the ' +
        'folder, the raw take, its working versions and the deliverable are all renamed ' +
        'together; its transcript, beats, camera take and edit move with it. If the name is ' +
        'taken it becomes "Name 2". Returns the new path and name, which replace the old ' +
        'ones in any later call. Without a name, Fetch names it the way it names new takes ' +
        '(the app it showed and what was said), only if its name is still an automatic one ' +
        'such as recording-<timestamp>; a name a person typed is left alone.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
        name: z.string().optional().describe('The new name, without an extension. Omit to have Fetch name it.'),
      }),
    },
    async args => text(await drive('recordings.rename', args)))

  server.registerTool(
    'get_frame',
    {
      description:
        'Show one frame of a recording, as an image and a saved JPEG path, to look at what is on ' +
        'screen at a moment. To place a zoom, redaction, spotlight or step, use find_on_screen ' +
        'instead, which returns the boxes to send. Positions ' +
        'in apply_edit are fractions of the frame from the top left, 0 to 1, so a point a ' +
        'quarter across and halfway down is x 0.25, y 0.5. ' +
        'On a shot it hands back the capture itself, unstyled and with nothing extracted, because a ' +
        'capture is already one frame; preview_frame is what draws it styled.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording, or to a shot.'),
        at: z.number().min(0).optional()
          .describe('Seconds into the recording. Default 0. Leave it out on a shot, which has one moment.'),
        cropped: z.boolean().optional().describe('Show the frame after the edit\'s crop, which is the frame ' +
          'zoom, mark and text positions are measured against. Default false: the whole recording.'),
      }),
    },
    async args => {
      // The image itself, not only its path: an agent inside Fetch's chat has no file
      // tool to open a path with, and seeing the frame is the whole point of the call.
      // A moment a still does not have is not a moment a client should have to invent.
      const r = await drive('frame', { ...args, at: args.at ?? 0 }, { timeoutMs: 60000 })
      const out = text(r)
      try { out.content.push({ type: 'image', mimeType: 'image/jpeg', data: readFileSync(r.image).toString('base64') }) } catch {}
      return out
    })

  // Aiming by what is there rather than by eye. A model looking at one frame guessed
  // coordinates and zoomed on the wrong button; this hands it numbered boxes.
  server.registerTool(
    'find_on_screen',
    {
      description:
        'Find the things on a frame that an edit can point at, before placing any zoom, ' +
        'lift, spotlight, blur, redaction or step. Reads the frame on this Mac (text, and the chip, ' +
        'button or card around it, and the panels and card grids they sit in) and returns ' +
        'elements E1, E2... each with its text, kind (chip, card, panel, grid, icon, text, ' +
        'shape), box {x,y,w,h}, background colour and tone, confidence, and `in`: the element ' +
        'it sits in. Plus the frame with those elements outlined and numbered. For something ' +
        'bigger than one card (a details panel, a stats grid, a sidebar), use the panel or grid ' +
        'element, or step out through `in`; never draw a box by eye. With query ' +
        '(the person\'s own words: "the black chip", "the yellow Pick for me button", ' +
        '"Tonight") the best matches come first, scored on the words on the element, its ' +
        'colour and its kind. Look at the picture to check the first one is what the person meant; ' +
        'if not, pick another by its number or search again with other words. Name the ' +
        'chosen one in apply_edit as element: \'E12\' (zooms[].element, marks[].element; ids ' +
        'from the latest search on that recording), or send its box as it is: boxes are fractions of ' +
        'the frame after the edit\'s crop, the frame apply_edit places things in. ' +
        'A shot goes through the same pass on its one frame, so pointing at part of a screenshot is this ' +
        'call and the E id it hands back, exactly as on a recording.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording, or to a shot.'),
        at: z.number().min(0).optional()
          .describe('Seconds into the recording, a moment the thing is fully on screen. Default 0. ' +
            'Leave it out on a shot, which has one moment.'),
        query: z.string().optional().describe('What the person called it, in their words. Omit to list everything.'),
        cropped: z.boolean().optional().describe('Default true: measured after the edit\'s crop, as apply_edit takes ' +
          'positions. False: the whole recording.'),
        limit: z.number().int().min(1).max(60).optional().describe('How many elements to return and number. Default 8 with a query, 40 without.'),
      }),
    },
    async args => {
      const r = await drive('find', { ...args, at: args.at ?? 0 }, { timeoutMs: 60000 })
      const out = text(r)
      try { out.content.push({ type: 'image', mimeType: 'image/jpeg', data: readFileSync(r.image).toString('base64') }) } catch {}
      return out
    })

  server.registerTool(
    'preview_frame',
    {
      description:
        'Show frames of the edited video exactly as export will draw them (crop, zoom, marks, ' +
        'captions, text, backdrop), as images, a couple of seconds each. Call it after every ' +
        'apply_edit that places a zoom or a mark, with at set to the times the result lists under ' +
        'check.preview_frame_at (just after it lands and in its middle, both in one call), and look at ' +
        'every frame: the thing the person asked for should be the subject, and nothing else should ' +
        'dim or cover it. If it is not, fix the edit and preview again before reporting back. ' +
        'On a shot it draws the one frame there is, from the same plan and the same renderer export uses, ' +
        'so what you look at here is the PNG made narrow rather than a second opinion of it.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording, or to a shot.'),
        at: z.union([z.number().min(0), z.array(z.number().min(0)).min(1).max(6)]).optional()
          .describe('Seconds into the original recording: one time, or a list (up to 6), e.g. [35.9, 36.7]. ' +
            'Default 0. Leave it out on a shot, which has one moment.'),
        look: z.record(z.string(), z.any()).optional()
          .describe('A look to try on these frames without saving it, in apply_look\'s shape, e.g. {preset: \'film\'}.'),
      }),
    },
    async args => {
      const n = Array.isArray(args.at) ? args.at.length : 1
      const r = await drive('edit.preview', { ...args, at: args.at ?? 0 }, { timeoutMs: 60000 * n })
      const out = text(r)
      // in the order of frames[] in the text, which says when each is; a second text
      // block would stop the chat reading the result as JSON
      for (const f of r.frames || [r]) {
        try { out.content.push({ type: 'image', mimeType: 'image/jpeg', data: readFileSync(f.image).toString('base64') }) } catch {}
      }
      return out
    })

  // One frame is a still, and the best work in this product is motion: an ease that
  // lands and settles, a dissolve, the travel blur under a zoom. None of that is
  // visible in a still and all of it is obvious in a row of them.
  server.registerTool(
    'contact_sheet',
    {
      description:
        'One image of the whole edit: up to 24 frames of the finished output, evenly spaced, drawn ' +
        'exactly as export will draw them, each with its output time in its corner. Call it before ' +
        'the first change to see what the take contains, and after placing a zoom, a dissolve or a ' +
        'speed change to judge the motion, which a single frame cannot show. from, to and the times ' +
        'on the sheet are seconds of the edited output, which is shorter than the recording wherever ' +
        'it is cut; frames[].source_at is the second of the recording each cell came from, and that ' +
        'is what apply_edit and preview_frame take. Use preview_frame when you need one moment large. ' +
        'A shot is one moment, so on one this answers with that picture rather than refusing: the whole ' +
        'of a screenshot is its frame.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording, or to a shot.'),
        from: z.number().min(0).optional().describe('Start of the range, in seconds of the edited output. Default the start.'),
        to: z.number().min(0).optional().describe('End of the range, in seconds of the edited output. Default the end.'),
        count: z.number().int().min(1).max(24).optional().describe('How many frames, 1 to 24. Default 12.'),
      }),
    },
    async args => {
      const r = await drive('edit.sheet', args, { timeoutMs: 180000 })
      const out = text(r)
      try { out.content.push({ type: 'image', mimeType: 'image/jpeg', data: readFileSync(r.image).toString('base64') }) } catch {}
      return out
    })

  // Looks: the whole of how a video looks, as one spec (ui/look-schema.js)
  server.registerTool(
    'get_look_schema',
    {
      description:
        'Every setting of how a video looks (frame, background, captions, motion, cursor and more), ' +
        'one line each: its type or range, its default and what it does. Read it before building a look ' +
        'by hand with apply_look or apply_edit\'s look. A font name is one of get_edit\'s options.fonts: ' +
        'Fetch ships a handful of faces and anything else falls back to the house one without saying so.',
      inputSchema: z.object({}),
    },
    async args => text(await drive('look.schema', args)))

  server.registerTool(
    'list_looks',
    {
      description:
        'The looks that can be applied whole with apply_look (built-in presets and ones the person or ' +
        'an agent saved), and the gradient and image backgrounds a look can use.',
      inputSchema: z.object({}),
    },
    async args => text(await drive('look.list', args)))

  server.registerTool(
    'apply_look',
    {
      description:
        'Change how a recording looks: start from a named look (preset), change fields (look, by ' +
        'section, e.g. {background: {kind: \'solid\', color: \'#1A1714\'}, frame: {radius: 18}}), put ' +
        'fields back (reset, e.g. [\'frame.padding\']), or all three. Fields left out are kept. The person ' +
        'sees it in the editor and one Undo takes it back. Returns the look as its preset and what differs ' +
        'from it, and look_warnings for values clamped and anything the renderer that will draw your export ' +
        'leaves out. Check the result with preview_frame. ' +
        'A shot holds the same look a recording holds, so this is the call that puts a capture on a warm ' +
        'dune ground in a browser frame, and a look saved off either one applies to the other unchanged. ' +
        'What a single frame cannot mean (the fades, the arrival, the loop, the motion blur) is kept on ' +
        'the look as sent and simply not drawn, and the result names those fields under not_drawn.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording, or to a shot.'),
        preset: z.string().optional().describe('A look from list_looks to start from, e.g. studio.'),
        look: z.record(z.string(), z.any()).optional().describe('Fields to change, by section.'),
        reset: z.array(z.string()).optional().describe('Field paths to put back to the preset, e.g. [\'frame.shadow\'].'),
        step: z.string().optional()
          .describe('The step of the plan this call finishes, e.g. "P1". Closes it; the result says what is left. ' +
            'Same as apply_edit\'s, since applying a look is a step of a job like any other.'),
      }),
    },
    async args => text(await drive('look.apply', args, { timeoutMs: 60000 })))

  server.registerTool(
    'save_look',
    {
      description:
        'Save a look under a name so it can be applied to other recordings (apply_look preset) and ' +
        'shows in the editor\'s looks. Saves the look of the recording at path, or the look given. ' +
        'A shot stores the whole look, fades and all, so one saved off a screenshot is a look a recording ' +
        'can wear.',
      inputSchema: z.object({
        name: z.string().describe('What to call it, e.g. "Launch video".'),
        path: z.string().optional().describe('Absolute path to a recording or a shot whose look to save.'),
        look: z.record(z.string(), z.any()).optional().describe('A look to save instead, by section.'),
      }),
    },
    async args => text(await drive('look.save', args)))

  server.registerTool(
    'remove_dead_air',
    {
      description:
        'Cut the silent gaps out of a recording and write a NEW file beside it. The original is ' +
        'not changed, and the new file starts with an empty edit, so every zoom, mark, caption and ' +
        'look on the take you were editing is lost. Returns the new path, how many segments were ' +
        'kept and the percentage of time removed. Fails if the recording has no audio. To tighten a ' +
        'take you are editing, or to hit a length, use fit_to_length, which writes clips on the edit ' +
        'instead and keeps everything else.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
        min_silence: z.number().min(0.2).max(5).optional()
          .describe('Only gaps at least this long, in seconds, are removed. Default 0.7.'),
        padding: z.number().min(0).max(1).optional()
          .describe('Seconds of silence kept either side of each cut. Default 0.15.'),
      }),
    },
    async args => text(await drive('edit.silence', args, { timeoutMs: 20 * 60 * 1000 })))

  server.registerTool(
    'enhance_audio',
    {
      description:
        'Denoise and level the voice in a recording and write a new file beside it. The ' +
        'original is not changed. Returns the new path. Fails if the recording has no ' +
        'audio. To clean audio as part of an edited export instead, set look.denoise and ' +
        'look.loudnorm with apply_edit.',
      inputSchema: z.object({ path: z.string().describe('Absolute path to the recording.') }),
    },
    async args => text(await drive('edit.enhance', args, { timeoutMs: 20 * 60 * 1000 })))

  // The one part of Fetch that uses the network, and it is the person's own ElevenLabs
  // account: their key lives in the macOS Keychain, it is never an argument here, and
  // only the script leaves the Mac. No audio, no video, no filenames.
  server.registerTool(
    'list_voices',
    {
      description:
        'The voices on the person\'s own ElevenLabs account, with the id voiceover takes, plus what is ' +
        'left of their character allowance. Fails when no account is connected, which only the person can ' +
        'do, in the editor\'s Voiceover tab.',
      inputSchema: z.object({}),
    },
    async () => text(await drive('voice.list', {}, { timeoutMs: 60000 })))

  server.registerTool(
    'voiceover',
    {
      description:
        'Speak a script in a studio voice and lay it over the recording, for a take worth keeping whose ' +
        'narration is not. Writes an mp3 beside the recording and sets it as the edit\'s audio track, so ' +
        'the person sees it land and one Undo takes it back. With no script the take\'s own captions are ' +
        'spoken back, which is what "redo this walkthrough with a clean narration" means: transcribe ' +
        'first, fix the words with apply_edit cues, then call this. Sends the script over the network to ' +
        'ElevenLabs, on the person\'s own account and nothing else: not the video, not the audio, not the ' +
        'filename. Check the length it returns against the edit, and cut or fit the video to match it.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
        script: z.string().optional().describe('What to say. Left out, the take\'s own captions are the script.'),
        voice: z.string().optional().describe('A voice id or name from list_voices. Left out, the first voice on the account.'),
        stability: z.number().min(0).max(1).optional().describe('0 to 1, default 0.5. Lower is more expressive and less even.'),
        similarity: z.number().min(0).max(1).optional().describe('0 to 1, default 0.75. How closely it holds to the original voice.'),
        speed: z.number().min(0.7).max(1.2).optional().describe('0.7 to 1.2, default 1. How fast it speaks.'),
        offset: z.number().min(0).optional().describe('Seconds into the recording the narration starts. Default 0.'),
        replace: z.boolean().optional().describe('Default true: the take\'s own sound is muted under it. False keeps both.'),
        apply: z.boolean().optional().describe('Default true. False writes the mp3 and leaves the edit alone.'),
        step: z.string().optional().describe('A step of the plan this finishes, e.g. "P4".'),
      }),
    },
    async args => text(await drive('voice.speak', args, { timeoutMs: 10 * 60 * 1000 })))

  server.registerTool(
    'get_settings',
    {
      description:
        'Read Fetch\'s recording settings: save folder, camera, microphone, system audio, ' +
        'countdown, whether the editor opens after a take, whether originals are kept, ' +
        'quick record, automatic updates, and whether takes are named with the person\'s agent ' +
        '(agentNames). Also lists the settings only a person can change.',
      inputSchema: z.object({}),
    },
    async () => text(await drive('settings.get')))

  server.registerTool(
    'set_settings',
    {
      description:
        'Change one or more of Fetch\'s settings. Only the keys sent change. Recording ' +
        'access, the never-record list, allowed apps and telemetry cannot be changed here; ' +
        'a request that includes any of them is refused as a whole.',
      inputSchema: z.object({
        settings: z.object({
          saveDir: z.string().nullable().optional()
            .describe('Existing folder that new take folders go in, or null for ~/Movies/Fetch.'),
          camera: z.boolean().optional(),
          mic: z.boolean().optional(),
          systemAudio: z.boolean().optional(),
          countdown: z.union([z.literal(0), z.literal(3), z.literal(5)]).optional()
            .describe('Seconds before recording starts.'),
          openEditorAfter: z.boolean().optional(),
          keepOriginal: z.boolean().optional(),
          quickRecord: z.boolean().optional(),
          autoConvertMp4: z.boolean().optional(),
          autoUpdate: z.boolean().optional(),
          agentNames: z.boolean().optional()
            .describe('Name new takes with the person\'s own agent CLI from the app in front and the first words said. ' +
              'Unset, it is on while Claude Code or Codex is connected. Names someone typed are never changed.'),
        }).passthrough(),
      }),
    },
    async args => text(await drive('settings.set', args)))

  server.registerTool(
    'delete_recording',
    {
      description:
        'Move a recording, and its transcript, camera take and edit, to the macOS Trash. ' +
        'Given the raw take or the deliverable of a take folder, the whole folder goes; ' +
        'given a working version (such as a dead-air cut), only that file does. ' +
        'Recoverable from the Trash with Put Back; nothing is permanently deleted.',
      inputSchema: z.object({ path: z.string().describe('Absolute path to the recording.') }),
    },
    async args => text(await drive('recordings.trash', args)))

  server.registerTool(
    'list_beats',
    {
      description:
        'Named spans across a recording, taken from what was said in it: each has an id, ' +
        'start, end and a label that is the words spoken at that point. Useful for finding ' +
        'the moment to zoom into or cut, by what was said rather than by timecode.',
      inputSchema: z.object({ path: z.string().describe('Absolute path to the recording.') }),
    },
    async args => text(await drive('edit.beats', args)))

  server.registerTool(
    'list_recordings',
    {
      description:
        'List the takes in the Fetch Library, newest first, one entry per take (the same ' +
        'count the Library shows). path is the raw take, the one to edit. A take folder ' +
        'also has take (the folder), deliverable (the file export wrote, if any), copy ' +
        '(an unedited MP4 made on stopping when Convert to MP4 is on; not an export) and ' +
        'versions (working files such as a dead-air cut). Shots are listed here too, with kind "shot": ' +
        'the kind is read off what was captured and never off what was exported, so styling a shot never ' +
        'makes it a take. While the sample is open, this lists the sample and nothing else, each entry ' +
        'marked sample, as the Library does.',
      inputSchema: z.object({}),
    },
    async () => text(await drive('recordings.list')))

  // Trying Fetch with nothing recorded. The sample is Fetch's own: two takes and a shot
  // of a product made up for it, laid out as real takes in a folder of their own.
  server.registerTool(
    'sample',
    {
      description:
        'The sample library: two takes and a screenshot of a made up product, so a person can try every tool ' +
        'without recording anything. open lays it out as real takes in a folder of its own and shows it in ' +
        'the Library in place of theirs; close deletes it and puts their library back. Their own takes, ' +
        'folders and settings are never touched either way, and close says whether they changed while it ' +
        'was open. The result lists each piece with its path and one job to try on it. Every other tool ' +
        'works on these paths as on any take, an export lands inside the sample, and what you remember ' +
        'about the made up product is kept in the sample and goes with it. Open it when the person wants ' +
        'to see what Fetch does and has nothing recorded, or asks for it. status says whether it is open.',
      inputSchema: z.object({
        action: z.enum(['status', 'open', 'close']).optional().describe('Default status.'),
      }),
    },
    async args => text(await drive('sample.do', args, { timeoutMs: 60000 })))

  server.registerTool(
    'probe',
    {
      description:
        'Read the duration, resolution, frame rate and audio tracks of a video file. With loudness, it ' +
        'also measures each clip of the edit in LUFS against the -14 target and hands back, for each one, ' +
        'the gain in decibels that would bring it to the rest and whether it is quiet enough to be worth ' +
        'lifting. That is the answer to "this bit is too quiet": write the gain it names onto that clip ' +
        '(apply_edit clips, audio.gain) rather than lifting the whole take and the keyboard with it. ' +
        'On a shot it reads the capture\'s size out of its own header, and says no duration, no frame ' +
        'rate and no audio rather than zeroes.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to a video file.'),
        loudness: z.boolean().optional()
          .describe('Measure each clip\'s loudness as well. One decode per clip, so ask for it when a passage ' +
            'sounds wrong, not on every probe.'),
      }),
    },
    async args => text(await drive('probe', args)))

  server.registerTool(
    'transcribe',
    {
      description:
        'Transcribe a recording on-device and write a .srt beside it. Returns the ' +
        'subtitle path and word count. Pass include_text only if the transcript itself ' +
        'is needed, since a long one is large.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to a video or audio file.'),
        include_text: z.boolean().optional()
          .describe('Return the full transcript text as well as the file path.'),
      }),
    },
    async args => text(await drive('transcribe', args, { timeoutMs: 10 * 60 * 1000 })))

  return server
}

// Dual-era on purpose. Claude Code opens stdio connections with the older handshake
// unless the user opts in, so refusing legacy would break the largest client.
//
// Only when this file is the program. Imported instead (test/tools.test.js, which walks
// the tool list against the app's ops), build hands back the server and nothing reads
// stdin. Anything unexpected about argv means this was run, not imported, and it starts.
function isTheProgram() {
  // node always names the program in argv[1]; without one this was imported.
  if (!process.argv[1]) return false
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return true }
}
if (isTheProgram()) {
  serveStdio(build)
  // The client is the only reason this process exists. When its end of stdin goes (it
  // exited, or Fetch's Stop killed the CLI outright with no chance to shut its servers
  // down), this goes too: left running, its socket to Fetch kept the agent counted as
  // connected, the brake stayed armed, and every forced Stop left one more behind.
  const gone = () => process.exit(0)
  process.stdin.once('end', gone)
  process.stdin.once('close', gone)
}
