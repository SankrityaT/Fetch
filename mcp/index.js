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
        'Only one recording can run at a time.',
      inputSchema: z.object({
        display: z.string().optional()
          .describe('Display id to record. Omit to record the main display.'),
        window: z.string().optional()
          .describe('Window id from list_windows. Records that window only, instead of a display.'),
        mic: z.boolean().optional().describe('Include the microphone.'),
        system_audio: z.boolean().optional().describe('Include audio playing on the Mac.'),
        camera: z.boolean().optional().describe('Show the floating camera bubble.'),
      }),
    },
    async args => {
      // The app counts down before capturing and the take resolves only when the
      // file exists, so this can legitimately sit for a while.
      const r = await drive('record.start', args, { timeoutMs: 15 * 60 * 1000 })
      return text(r)
    })

  server.registerTool(
    'record_stop',
    {
      description:
        'Stop the recording that is currently running. The file path is returned by ' +
        'the record_start call that started it.',
      inputSchema: z.object({}),
    },
    async () => text(await drive('record.stop')))

  server.registerTool(
    'record_status',
    {
      description: 'Whether Fetch is currently recording.',
      inputSchema: z.object({}),
    },
    async () => text(await drive('record.status')))

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
        'from this when calling apply_edit.',
      inputSchema: z.object({ path: z.string().describe('Absolute path to the recording.') }),
    },
    async args => text(await drive('edit.get', args, { timeoutMs: 60000 })))

  server.registerTool(
    'apply_edit',
    {
      description:
        'Change the edit of a recording. Send only what you are changing: anything you ' +
        'leave out is kept, so adding a zoom never touches the crop or the captions. ' +
        'Read get_edit first; its `options` lists the allowed values. ' +
        'All positions and sizes are 0 to 1 fractions of the frame; all times are ' +
        'seconds in the original recording.\n' +
        'LISTS (sending one replaces that whole list; omit id on new items):\n' +
        '- clips [{id,start,end}]: the kept pieces in order. Trimming or cutting is ' +
        'changing these.\n' +
        '- zooms [{id,start,end,scale,x,y}]: scale e.g. 1.8; x,y the point to zoom to.\n' +
        '- marks [{id,kind,start,end,x,y,w,h,n}]: kind is redact (destroys the region, ' +
        'for anything private), spotlight (darkens everything else) or step (a numbered ' +
        'badge; n is the number). x,y is the top-left corner.\n' +
        '- texts [{id,text,start,end,fx,fy,sizeFrac,color,box,font,align}]: overlays. ' +
        'fx,fy is the centre; sizeFrac is text height as a fraction of the frame, e.g. 0.06; ' +
        'start and end null for the whole clip.\n' +
        'SETTINGS (merged, so send only the fields you change):\n' +
        '- look {denoise, loudnorm, gain (dB, -10 to 10), fadeIn, fadeOut (seconds), ' +
        'burnCaps (burn captions into the video), zoomAmt (auto-zoom depth), bdInset, bdRadius}\n' +
        '- capStyle {font, scale, colour (#RRGGBB), position (top|middle|bottom), boxed}\n' +
        '- camera {on, x, y, size}: only if a camera was recorded; x,y the bubble centre, ' +
        'size 0.1 to 0.45.\n' +
        '- crop {x,y,w,h} or null to remove it; cropAR sets the crop shape.\n' +
        '- backdrop: a name from options.backdrops, or null. outAspect: output shape, e.g. ' +
        '0.5625 for vertical, or null.\n' +
        '- autoZoom: true to zoom automatically on where the pointer settled.\n' +
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
        'Render a recording with its current edit (trim, cuts, zooms, text, captions) to ' +
        'a new file, and return its path. Runs in the background queue, one export at a ' +
        'time, so it can take a while for a long recording.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
        format: z.enum(['mp4', 'webm', 'gif', 'mov']).optional().describe('Defaults to mp4.'),
        quality: z.enum(['fast', 'balanced', 'best']).optional().describe('Defaults to balanced.'),
        resolution: z.enum(['720', '1080']).optional().describe('Omit to keep the original size.'),
      }),
    },
    async args => text(await drive('edit.export', args, { timeoutMs: 20 * 60 * 1000 })))

  server.registerTool(
    'rename_recording',
    {
      description:
        'Rename a recording so it is easy to find later, for example after the product ' +
        'and the flow it shows: "Linear · Triage an issue". Its transcript, beats, camera ' +
        'take and edit move with it. Returns the new path, which replaces the old one in ' +
        'any later call.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the recording.'),
        name: z.string().describe('The new name, without an extension.'),
      }),
    },
    async args => text(await drive('recordings.rename', args)))

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
        'quick record, and automatic updates. Also lists the settings only a person can ' +
        'change.',
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
            .describe('Existing folder for new recordings, or null for the Desktop.'),
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
        }).passthrough(),
      }),
    },
    async args => text(await drive('settings.set', args)))

  server.registerTool(
    'delete_recording',
    {
      description:
        'Move a recording, and its transcript, camera take and edit, to the macOS Trash. ' +
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
      description: 'List recordings Fetch knows about, newest first, with their file paths.',
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
