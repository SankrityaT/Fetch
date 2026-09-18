# Fetch 2.0: landing page brief

For whoever builds the site. Read this before designing anything. Everything claimed
below is shipped and verified unless it sits under **Do not claim**. If a claim is not
in this file, do not put it on the page.

`PRODUCT.md` is the product source of truth, `BRAND.md` the voice and mascot, `DESIGN.md`
the visual system, `fetch-tokens.css` the real CSS variables. This file is the subset a
landing page needs, plus the story.

---

## What changed: 1.x to 2.0

**Fetch 1.x** was a free, local Mac screen recorder and editor. Good, and in a category
that is already lost: Recordly is free, open source, cross platform, native capture,
22k stars and shipping daily. Leading with "another Mac screen recorder" loses on day
one. **Do not pitch Fetch as a screen recorder.**

**Fetch 2.0** is an **agent-native workspace for recording and shipping real software.**
An agent you already pay for (Claude Code, Codex) can record your actual screen, find
the moment you care about by what you said, zoom into it, and export the finished
video, from a CLI with the app closed or from a chat inside the app. You can see
everything it did, and undo it.

## The one line

> Your agent can record your real screen, and edit it by what you said.

Alternatives in the same spirit, pick one and never use all three:

- "Record real software. Let your agent cut it."
- "The screen recorder your agent can drive."
- "Say it once. Fetch finds it, zooms in, and ships the clip."

## Why nobody else can make this claim

This is the argument the page exists to make. Every competitor routed around the hard
part, and the hard part is exactly what Fetch does.

| | records | edits by | where |
|---|---|---|---|
| **Clueso** | a cloud browser, web apps only, needs your staging login | clicks | their cloud |
| **Moonjar** | the iOS Simulator | taps | your Mac |
| **HyperFrames** | HTML it renders itself, never a real app | code | their cloud |
| **Fetch** | **any real window: native apps, terminals, editors, browsers** | **what you said** | **your Mac** |

Two structural wins, both real:

1. **The real machine.** A cloud browser can only ever record a web app, and a
   simulator only a phone. Fetch records Xcode, Figma, a terminal, your own Electron
   build, anything on screen.
2. **The transcript is the spine.** Moonjar's caption track is empty in every one of its
   screenshots, because a simulator recording has no audio. Fetch transcribes on device,
   so the timeline is named from your words: `B2 And pick only the family label`, not
   `Tap`. An agent can be told "zoom into the bit where I pick the family label" and find
   it. That cannot be copied without an audio pipeline.

## Shipped in 2.0

Group these into three or four sections. Do not render them as a grid of identical
feature cards (see Anti-patterns).

**Agents drive it, on your plan**
- MCP server with 12 tools. `record_start`, `record_stop`, `record_status`,
  `list_windows`, `list_displays`, `list_recordings`, `probe`, `transcribe`,
  `list_beats`, `get_edit`, `apply_edit`, `export`.
- The whole pipeline runs headless from a CLI with the app closed: transcribe, find the
  beat, zoom into it, export. Verified end to end driven as Codex.
- Works with Claude Code, Codex, Cursor, Windsurf and Zed. A Connect screen detects
  which you have and wires them up, with the real vendor marks.
- No API key, no bill. It runs on the Claude or ChatGPT plan you already have.

**A chat inside the app**
- Docked beside your work (Cmd J). The front screen is Biscuit asking "What are we
  recording today?" with a composer, not a button.
- Every tool call shows as its own row as it happens, with how long it took. An agent
  recording your screen is never a spinner.
- It remembers the conversation, so "now caption it" knows what "it" is.
- `@` to point at a recording by name instead of describing it.
- A microphone that dictates your message, transcribed on your Mac.

**Edits you can name**
- Beats: the timeline is labelled with what you said, and splits at your real pauses.
- Every object has a short id: clips `C1`, zooms `Z1`, text `T1`, beats `B1`. The same id
  appears on screen, in the agent's tool call, and in the history.
- Zooms an agent places by name render in the export, eased in and out.
- Captions that break at your pauses, not mid-sentence.

**You can see all of it, and it stays yours**
- **Activity**: a log of everything done on this Mac and who did it. A row with the
  Claude or Codex mark was an agent. **A row with no mark was you.**
- **Recording access**: apps an agent may never record, pre-filled with password
  managers, Messages, Mail, Keychain and System Settings. Enforced in code before a take
  starts, and on a full-screen take those windows are left out of the frame so the
  pixels are never captured.
- You always see a take in progress: red border, floating controls, Biscuit.
  Shift Cmd R stops one an agent started, same as your own.
- Recordings are files on your Desktop. Nothing uploads.

**Optional, and labelled as the exception**
- Voiceover through your own ElevenLabs account: re-narrate a take from its transcript
  without re-recording. The only feature that uses the internet, and the app says so
  where you use it. The key lives in the macOS Keychain.

## The hero

One demo carries the page. It must show something no competitor can produce, which
means **not a web app and not a simulator.** A web-app demo is indistinguishable from
Clueso and throws away the whole argument.

The sequence, as a real screen recording (no mockups):

1. A terminal. Someone types into Claude Code: *"Record my Xcode window, then zoom into
   the part where I explain the fix."*
2. Fetch records a real native app. The red border and Biscuit are visible.
3. The Fetch timeline fills with beats named from the narration.
4. The agent calls `list_beats`, finds the right one, calls `apply_edit`, and `Z1`
   appears on the timeline directly under that beat.
5. The exported clip plays, zooming exactly there, captions underneath.

If that is too long for a hero, cut to steps 3 to 5: beats appearing from speech, then
`Z1` landing under the named beat, then the zoom playing. That fragment alone is the
thing nobody else has.

## Do not claim

These are **not** built. Putting them on the page would be false.

- **Fetch does not drive apps or browsers.** It records. Playwright drives browsers,
  a computer-use agent drives native apps, `simctl` drives the Simulator. Say
  "composes with", never "controls your apps".
- Arrows, numbered steps, a magnifying loupe, "lift one row", multi-device frames,
  styled backgrounds. These are Moonjar's screenshot features. Not in Fetch.
- Redaction or spotlight effects in the export. In progress, not shipped.
- Understanding your codebase or reading your source. Not built.
- Cross-platform. macOS only (13 or later for native capture).
- "AI-generated" anything. The agent is the person's own, not Fetch's.

Two things are built but not yet verified end to end. Fine to mention, not to headline:
voiceover past the connect screen, and full-screen exclusion of protected windows at
the pixel level.

## Voice

See `BRAND.md`. Plain, short, a little warm. **No em dashes, anywhere.**

- Trust is built from named exclusions, not adjectives. "Never records 1Password,
  Messages or Mail" beats "private by design".
- Say what it does, then what it will not do. The app's own settings copy does this and
  it is the best writing in the product.
- Biscuit speaks in first person only when introducing himself. Everywhere else he is
  described or not mentioned.

## Visual direction

Dark and warm: retriever gold on a warm near-black. **This is the differentiation, not a
default.** The whole agent-tool category is light and airy (Moonjar, Claude, Replit),
and the screen-recorder category is violet (Loom, Screen Studio). If the page could
belong to either, it is wrong.

- Depth from tone, not borders: a raised surface is lighter, things that float cast a
  wide soft shadow. See the Elevation section of `DESIGN.md`.
- One faint warm light pool in the corners of the page, never behind the content.
- Big radii, generous air.
- Real product screenshots and recordings only. The app is the illustration.
- Show the ids. `B2`, `Z1` in mono on a chip are the most specific, most ownable visual
  in the product.

## Anti-patterns

- Identical feature-card grids (icon, heading, two lines, repeated).
- Gradient text. Glassmorphism as decoration.
- Hero metrics ("10x faster").
- Violet, pure black, or a light cream page.
- Stock "AI" imagery: sparkles, orbs, neural nets.
- Any mockup of a feature under **Do not claim**.

## Assets

| path | use |
|---|---|
| `fetch-tokens.css` | the app's real CSS variables |
| `assets/fonts/` | Bricolage Grotesque, Geist, Geist Mono, Instrument Serif, self-hosted |
| `assets/mascot/` | Biscuit, 17 stills and 4 alpha motion clips |
| `assets/sprite.svg` | 78 Phosphor icons |
| `assets/fetch-icon-1024.png` | app icon |
| `../assets/agents/` | official Claude, Codex, Cursor, Windsurf, Zed marks, unmodified |

Vendor marks keep their own background: Claude and Zed are bare glyphs on a Fetch tile,
Codex, Cursor and Windsurf are the tile. Never recolour them.

## Open questions for the builder

- Which of the three one-liners. Pick one.
- Whether the hero is the full sequence or the three-step fragment. Depends on what
  plays well at the top of a page without sound.
