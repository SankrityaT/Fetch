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
import { call } from './bridge.js'

const text = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] })

function build() {
  const server = new McpServer({ name: 'fetch', version: '0.1.0' })

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
      const r = await call('record.start', args, { timeoutMs: 15 * 60 * 1000 })
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
    async () => text(await call('record.stop')))

  server.registerTool(
    'record_status',
    {
      description: 'Whether Fetch is currently recording.',
      inputSchema: z.object({}),
    },
    async () => text(await call('record.status')))

  server.registerTool(
    'list_recordings',
    {
      description: 'List recordings Fetch knows about, newest first, with their file paths.',
      inputSchema: z.object({}),
    },
    async () => text(await call('recordings.list')))

  server.registerTool(
    'probe',
    {
      description: 'Read the duration, resolution, frame rate and audio tracks of a video file.',
      inputSchema: z.object({ path: z.string().describe('Absolute path to a video file.') }),
    },
    async args => text(await call('probe', args)))

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
    async args => text(await call('transcribe', args, { timeoutMs: 10 * 60 * 1000 })))

  return server
}

// Dual-era on purpose. Claude Code opens stdio connections with the older handshake
// unless the user opts in, so refusing legacy would break the largest client.
serveStdio(build)
