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
import { readFileSync } from 'node:fs'
import { call, setClient } from './bridge.js'

const text = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] })

function build() {
  const server = new McpServer({ name: 'fetch', version: '0.1.0' })

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
      description: 'Whether Fetch is currently recording.',
      inputSchema: z.object({}),
    },
    async () => text(await drive('record.status')))

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
        '- clips [{id,start,end}]: the kept pieces in order. Trimming or cutting is ' +
        'changing these.\n' +
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
        'stays put, everything else dims to about half with a light blur), or step (a round gold badge; n is the ' +
        'number, left out the steps count 1, 2, 3 in order). Lift and spotlight ease in and ' +
        'out on the zoom curve, and a zoom starting or ending within 1.2s of one, or up to ' +
        '3s inside it, carries it, so zoom and lift read as one move: to zoom on and lift ' +
        'one thing, send the same box to both. For redact, blur, lift and spotlight x,y is the top-left corner; for step x,y is ' +
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
        '- pointer [{t,x,y,click}]: the cursor drawn in the video, from pointer calls during an ' +
        'agent take. Unlike everything else, x,y are fractions of the whole recording (before ' +
        'the crop), so a crop does not move it. Read it with get_edit include_pointer. [] draws ' +
        'no cursor; null goes back to the track recorded with the take.\n' +
        'SETTINGS (merged, so send only the fields you change):\n' +
        '- look: how the video looks, by section, e.g. {preset: \'studio\'} or ' +
        '{frame: {aspect: \'16:9\', padding: 0.08}, background: {kind: \'gradient\', gradient: \'ink\'}, ' +
        'captions: {font, scale, colour, position, highlight}, motion: {fadeIn, fadeOut, zoomDepth}, ' +
        'cursor: {show, hideSystem}}. Every field, range and default: get_look_schema; whole looks: ' +
        'list_looks and apply_look. A field left out is kept, null resets it, {preset} starts from that look. ' +
        'Output keeps the take\'s shape unless frame.aspect is set, and a chosen shape is filled by the ' +
        'background, never black bars. Values out of range are clamped and listed under look_warnings, ' +
        'with any field this version does not draw yet.\n' +
        '- audio {denoise, loudnorm, gain (dB, -10 to 10), music (a bed under the voice, ducked ' +
        'while anyone speaks: warm, bright, calm, or null for none)}\n' +
        '- camera {on, x, y, size}: only if a camera was recorded; x,y the bubble centre, ' +
        'size 0.1 to 0.45.\n' +
        '- crop {x,y,w,h} or null to remove it; cropAR sets the crop shape.\n' +
        'Older fields still work and are moved into look: backdrop, outAspect, capStyle, hideMacCursor, ' +
        'and look.zoomAmt, bdInset, bdRadius, burnCaps, denoise, loudnorm, gain, fadeIn, fadeOut, music.\n' +
        '- autoZoom: true to zoom automatically on each click, or where the pointer settled ' +
        'if nothing was clicked. Explicit zooms win over it. It follows the pointer track ' +
        'when the take has one (clicks sent with the pointer tool), otherwise the real ' +
        'pointer, which never sees clicks a driver injects into a page (Playwright ' +
        'page.mouse, anything over CDP). pointer.autoZoomSpots in the result says how many it found; ' +
        'at 0, place zooms yourself.\n' +
        'Returns the full edit as it now stands.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
        doc: z.record(z.string(), z.any()).describe('Only the parts of the edit you are changing.'),
      }),
    },
    async args => text(await drive('edit.apply', args, { timeoutMs: 60000 })))

  server.registerTool(
    'export',
    {
      description:
        'Render a recording with its current edit (trim, cuts, zooms, text, captions) and ' +
        'return the path of the result. For a take in its own folder the result is the ' +
        'deliverable at the top of that folder, <Take>/<Take>.<format>, and exporting again ' +
        'overwrites it. An older recording on the Desktop gets a -edit copy beside it. Runs ' +
        'in the background queue, one export at a time, so it can take a while for a long ' +
        'recording. engine in the result says which renderer drew it: gl (the compositor, ' +
        'several times real time) or classic (ffmpeg, still used for edits with marks, text, ' +
        'captions or the drawn cursor; classic_because names them).',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
        format: z.enum(['mp4', 'webm', 'gif', 'mov']).optional().describe('Defaults to mp4.'),
        quality: z.enum(['fast', 'balanced', 'best']).optional()
          .describe('best is the largest, sharpest file; fast the smallest. Defaults to balanced.'),
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

  // Looks: the whole of how a video looks, as one spec (ui/look-schema.js)
  server.registerTool(
    'get_look_schema',
    {
      description:
        'Every setting of how a video looks (frame, background, captions, motion, cursor and more), ' +
        'one line each: its type or range, its default and what it does. Read it before building a look ' +
        'by hand with apply_look or apply_edit\'s look.',
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
        'from it, and look_warnings for values clamped and fields this version does not draw yet. Check ' +
        'the result with preview_frame.',
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
        path: z.string().optional().describe('A recording whose look to save.'),
        look: z.record(z.string(), z.any()).optional().describe('A look to save instead, by section.'),
      }),
    },
    async args => text(await drive('look.save', args)))

  server.registerTool(
    'remove_dead_air',
    {
      description:
        'Cut the silent gaps out of a recording and write a new file beside it. The ' +
        'original is not changed. Returns the new path, how many segments were kept and ' +
        'the percentage of time removed. Fails if the recording has no audio. For cuts ' +
        'you want to keep editing, use apply_edit with clips instead.',
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
      description: 'Read the duration, resolution, frame rate and audio tracks of a video file.',
      inputSchema: z.object({ path: z.string().describe('Absolute path to a video file.') }),
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
serveStdio(build)
