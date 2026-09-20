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
  'Fetch records this Mac\'s screen and edits what it recorded. The work happens in the Fetch app on ' +
    'the person\'s own machine; these tools are its hands.',
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
  'Aim at a box, never at a coordinate: call find_on_screen at that moment in the person\'s own words ' +
    'and send the id it hands back. A zoom or a mark placed from numbers read off a picture lands on ' +
    'the wrong thing, and the result will say so after the fact.',
  '',
  'Decide rather than ask: a default they can see and undo beats a question, and an agent that asks ' +
    'about everything is worse than one that gets on with it. The exception is narrow and it is what ask ' +
    'is for, a request with two readings that would touch different parts of the take where the wrong one ' +
    'costs an edit and an undo. A change that is wide or awkward to take back, show with propose before ' +
    'it lands rather than after.',
  '',
  'Every result carries the state it changed: the plan that is left, how far the edit still is from ' +
    'what was asked for, a frame of it, and what is wrong with it. Read that rather than calling again ' +
    'to find out.',
  '',
  'Takes, edits and settings move between turns, under the person\'s own hands as well as yours. Read ' +
    'the current state in this turn instead of trusting what an earlier one said.',
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
        'display it is on and the crop that shows just that window.',
      inputSchema: z.object({
        display: z.string().optional()
          .describe('Display id to record the whole of. Only when the person asked for the whole screen.'),
        window: z.string().optional()
          .describe('Window id from list_windows. Records that window only. Omit to record the front app\'s window.'),
        full_screen: z.boolean().optional()
          .describe('Record the whole main display instead of a window. Only when the person asked for it.'),
        allow_covered: z.boolean().optional()
          .describe('Record a window even when other windows cover it. Its covered part will not update.'),
        mic: z.boolean().optional().describe('Include the microphone. Default off.'),
        system_audio: z.boolean().optional().describe('Include audio playing on the Mac. Default off.'),
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
        'working with every tool, and list_recordings shows the new one.',
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
        'Clicks reported here are also what auto-zoom zooms on.\n' +
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
        'List the windows currently open on screen, with the id record_start takes. ' +
        'Use this to record one application window rather than a whole display, for ' +
        'example a browser a test driver just opened, or the iOS Simulator.',
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
      description: 'List the displays attached, with the id record_start takes.',
      inputSchema: z.object({}),
    },
    async () => text(await drive('displays.list')))

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
        'for correcting words the transcriber misheard (send the corrected list as cues).',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
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
        'Returns the full edit as it now stands. The result\'s preview is a frame of the edit at that moment; look at it. ' +
        'It also carries plan (what is left of the plan direct wrote) and distance (the length and shape ' +
        'against the brief), so you can see how far the edit still is from what was asked without calling ' +
        'anything else.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
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
        'you send is merged, and a step whose words you leave alone keeps its id and its state.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
        brief: z.object({
          seconds: z.number().min(1).max(3600).nullable().optional().describe('How long the finished video should be. Hit within 5 percent counts as hitting it.'),
          aspect: z.string().nullable().optional().describe('The shape it goes out in, e.g. "16:9", "9:16", "1:1".'),
          where: z.string().nullable().optional()
            .describe('Where it is going, in the person\'s own words: "landing page", "docs", "Product Hunt", "email", ' +
              '"X", "YouTube". review reads this and holds the edit to what that destination needs, e.g. captions ' +
              'burned in wherever it will autoplay muted.'),
          audience: z.string().nullable().optional().describe('Who watches it, if the person said.'),
          must_keep: z.array(z.string()).optional().describe('Moments or phrases that have to survive the cut.'),
          must_hide: z.array(z.string()).optional().describe('Anything on screen that must not ship: an email address, a key, a customer name.'),
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
        'or tell the person why you did not.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
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

  server.registerTool(
    'revert_my_edit',
    {
      description:
        'Take back your own last burst of changes to an edit, when you have made it worse. The same code ' +
        'path as the editor\'s own button for undoing an agent\'s change, so it merges by id and anything ' +
        'the person moved by hand since stays where they put it. It reaches only your own changes: their history ' +
        'is theirs. Most mistakes need less than this, since apply_edit merges by id (re-send a wrong zoom ' +
        'with its id to fix it, or remove: ["Z3"] to delete one), so reach for this when a whole pass was wrong.',
      inputSchema: z.object({ path: z.string().describe('Absolute path to the recording.') }),
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
        'so read its blocking list and fix what it names before you say this is done.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
        format: z.enum(['mp4', 'webm', 'gif', 'mov', 'm4a', 'mp3', 'wav']).optional()
          .describe('Defaults to mp4. m4a, mp3 and wav write the edited sound on its own, with no picture.'),
        quality: z.enum(['high', 'balanced', 'small', 'best', 'fast']).optional()
          .describe('high is the largest, sharpest file; small the smallest. Defaults to balanced. These are the ' +
            'three words the person sees in the Export dialog, so you can repeat each other; best and fast are ' +
            'the older names for high and small and still work.'),
        resolution: z.enum(['720', '1080']).optional().describe('Omit to keep the original size.'),
      }),
    },
    async args => text(await drive('edit.export', args, { timeoutMs: 20 * 60 * 1000 })))

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
        'quarter across and halfway down is x 0.25, y 0.5.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
        at: z.number().min(0).describe('Seconds into the recording.'),
        cropped: z.boolean().optional().describe('Show the frame after the edit\'s crop, which is the frame ' +
          'zoom, mark and text positions are measured against. Default false: the whole recording.'),
      }),
    },
    async args => {
      // The image itself, not only its path: an agent inside Fetch's chat has no file
      // tool to open a path with, and seeing the frame is the whole point of the call.
      const r = await drive('frame', args, { timeoutMs: 60000 })
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
        'the frame after the edit\'s crop, the frame apply_edit places things in.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
        at: z.number().min(0).describe('Seconds into the recording, a moment the thing is fully on screen.'),
        query: z.string().optional().describe('What the person called it, in their words. Omit to list everything.'),
        cropped: z.boolean().optional().describe('Default true: measured after the edit\'s crop, as apply_edit takes ' +
          'positions. False: the whole recording.'),
        limit: z.number().int().min(1).max(60).optional().describe('How many elements to return and number. Default 8 with a query, 40 without.'),
      }),
    },
    async args => {
      const r = await drive('find', args, { timeoutMs: 60000 })
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
        'dim or cover it. If it is not, fix the edit and preview again before reporting back.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
        at: z.union([z.number().min(0), z.array(z.number().min(0)).min(1).max(6)])
          .describe('Seconds into the original recording: one time, or a list (up to 6), e.g. [35.9, 36.7].'),
        look: z.record(z.string(), z.any()).optional()
          .describe('A look to try on these frames without saving it, in apply_look\'s shape, e.g. {preset: \'film\'}.'),
      }),
    },
    async args => {
      const n = Array.isArray(args.at) ? args.at.length : 1
      const r = await drive('edit.preview', args, { timeoutMs: 60000 * n })
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
        'is what apply_edit and preview_frame take. Use preview_frame when you need one moment large.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
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
        'leaves out. Check the result with preview_frame.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
        preset: z.string().optional().describe('A look from list_looks to start from, e.g. studio.'),
        look: z.record(z.string(), z.any()).optional().describe('Fields to change, by section.'),
        reset: z.array(z.string()).optional().describe('Field paths to put back to the preset, e.g. [\'frame.shadow\'].'),
      }),
    },
    async args => text(await drive('look.apply', args, { timeoutMs: 60000 })))

  server.registerTool(
    'save_look',
    {
      description:
        'Save a look under a name so it can be applied to other recordings (apply_look preset) and ' +
        'shows in the editor\'s looks. Saves the look of the recording at path, or the look given.',
      inputSchema: z.object({
        name: z.string().describe('What to call it, e.g. "Launch video".'),
        path: z.string().optional().describe('Absolute path to a recording whose look to save.'),
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
        'versions (working files such as a dead-air cut).',
      inputSchema: z.object({}),
    },
    async () => text(await drive('recordings.list')))

  server.registerTool(
    'probe',
    {
      description:
        'Read the duration, resolution, frame rate and audio tracks of a video file. With loudness, it ' +
        'also measures each clip of the edit in LUFS against the -14 target and hands back, for each one, ' +
        'the gain in decibels that would bring it to the rest and whether it is quiet enough to be worth ' +
        'lifting. That is the answer to "this bit is too quiet": write the gain it names onto that clip ' +
        '(apply_edit clips, audio.gain) rather than lifting the whole take and the keyboard with it.',
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
if (isTheProgram()) serveStdio(build)
