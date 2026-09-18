# Fetch

**register: product**

A macOS screen recorder and editor that runs entirely on the machine, and the recording
primitive an agent can drive. Electron shell, native Swift helpers, ScreenCaptureKit
capture, ffmpeg export, on-device transcription. GPL-3.0, public.

## Users

Two, and the same person is often both.

**The person recording.** Ships software, records demos, walkthroughs and bug repros.
Has recorded the same flow four times because the fifth take is the one without an
"um". Wants captions without paying a subscription and without uploading anything.

**Their agent.** Claude Code, Codex, Cursor. Drives Fetch over MCP from a terminal in
another window. Cannot see the screen, so everything it needs must be discoverable
through tools and returned as ids and paths rather than pixels or payloads.

Designing for only the first produces a nice recorder nobody needs. Designing for only
the second produces a daemon nobody trusts. Every surface has to serve both, and where
they conflict, the human wins, because it is their screen.

## Product purpose

Let an agent record, cut and caption real software on a real Mac, and let the person
whose Mac it is see exactly what happened and undo it.

## Strategic principles

1. **Local is the product, not a feature.** No key, no token, no upload. Recordings are
   files on the Desktop. Say this plainly wherever an agent touches the machine.
2. **The competition cannot record a real machine.** Clueso drives a cloud browser, web
   apps only, and wants your staging login. Moonjar drives the iOS Simulator.
   HyperFrames renders its own HTML. Fetch records any real window: native apps,
   terminals, editors, browsers. Every surface should make that concrete rather than
   claimed.
3. **Fetch records, it does not drive.** Playwright drives browsers, Lore Pilot drives
   native apps, `simctl` drives the Simulator. Composition, not reimplementation.
4. **Policy is enforced in code, never in a tool description.** A rule written into an
   MCP description is prompt prose, and prompt prose is a suggestion. Access rules live
   in the bridge, before the work starts.
5. **Agent actions must be legible and reversible.** If a human cannot see what the
   agent did and get back to where they were, the autonomy is a liability.
6. **Return ids and paths, never payloads.** A window list with base64 icons is 600KB of
   an agent's context. The same list without them is 3.5KB.

## Brand

Biscuit, a golden retriever puppy, is the mascot and the consent surface: when an agent
drives the machine, you always see the dog. He speaks first person only in onboarding,
where he is introducing himself. Everywhere else, and in anything a model reads, the
voice is plain and he is not mentioned.

Warm, not cool. The whole category is violet (Loom, Screen Studio) or pure black
(Mosaic), and the agent-tool category is bright and airy (Moonjar). Fetch is retriever
gold on a warm near-black. If a surface could belong to Loom, it is wrong.

## Tone

Plain, short, a little warm. Never cutesy-baby, never corporate.

- Good: "Nothing recorded yet." / "Saved to Desktop." / "Never records 1Password."
- Bad: "Woof! Biscuit couldn't find any videos! :(" / "Operation completed successfully."

Errors say what happened and what to do, in one line, without blame.

Trust is built from **named exclusions, not adjectives**. "Private" means nothing.
"Never records 1Password, Messages, Mail or System Settings" means something.

**No em dashes.** Not in UI copy, not in docs, not in code comments.

## Anti-references

- **Loom / Screen Studio.** Cool violet, subscription, cloud. The colour alone is a fail.
- **Moonjar.** Light, airy, cream, photographic. Excellent work and the bar for craft,
  but copying its palette would make Fetch look like a Moonjar clone. Take the
  structural ideas (stable ids, read-only agent-controlled surfaces, audit log,
  provenance, carve-out copy), not the skin.
- **Generic dev-tool dark.** Blue-grey, monospace everywhere, dense tables. Fetch is
  warm and roomy.
- **Consumer AI slop.** Gradient text, glass cards, sparkle icons on everything.
