# Publishing a Fetch update

Fetch ships with `electron-updater`, pointed at GitHub Releases. `npm install electron-updater --save`
worked when this was built (no network block hit), so that is the mechanism actually running, not the
manifest fallback. The fallback code is still in `ui/updater.js` and takes over automatically if
`require('electron-updater')` ever fails to load, but it has not been exercised against a real release,
since there is no published release yet.

## How the pieces fit

- `ui/updater.js`, the main-process module. Owns the update state machine, the busy check, and the
  connection to either electron-updater or the manifest fallback.
- `main.js` requires it, wires three IPC handlers (`updater-check`, `updater-restart`,
  `updater-get-state`), and reports app state to it: recording state (`updater.setRecState`), active
  processing jobs (`updater.setJobsActive`), and the `autoUpdate` pref (`updater.setAutoUpdate`).
- `ui/settings.js` renders the Updates card and talks to `ui/updater.js` only through those three IPC
  calls plus a live `updater-state` push. The renderer never knows which mechanism is active.

## Cutting a release (electron-updater / GitHub path)

1. Bump `version` in `package.json`. electron-updater compares this against the latest GitHub release
   tag.
2. Build the app (however `build.sh` produces the `.app`), then package it as a `.dmg` (or whatever
   `electron-builder`-shaped artifact you use) plus the `latest-mac.yml` file electron-builder normally
   generates alongside it. `electron-updater` needs that yml file next to the DMG in the release assets
   to know what to fetch and its checksum. If `build.sh` is not running through `electron-builder`,
   generate `latest-mac.yml` by hand (version, path, sha512, size) or switch the packaging step to
   `electron-builder --publish never` so it produces that file for you without touching how build.sh
   signs and notarizes.
3. Create a GitHub Release on `SankrityaT/fetch` tagged `vX.Y.Z`, and upload the DMG and
   `latest-mac.yml` as release assets. Publish the release (not a draft, draft releases are invisible to
   the updater).
4. Existing installs pick it up next time they check: automatically every four hours if "Install updates
   automatically" is on, or immediately if the user clicks "Check now" in Settings.

The `build.publish` block already sits in `package.json`:

```json
"build": {
  "appId": "com.fetch.app",
  "publish": { "provider": "github", "owner": "SankrityaT", "repo": "fetch" }
}
```

`ui/updater.js` also calls `autoUpdater.setFeedURL(...)` with the same provider/owner/repo directly, so
the feed does not depend on `app-update.yml` being generated at build time. That call is what actually
matters if `build.sh` never touches electron-builder's publish step.

## If you ever need the manifest fallback instead

This only takes over if `electron-updater` fails to `require(...)` at runtime (for example, a packaged
build missing its native deps). To publish through it instead:

1. Host a `latest.json` at `https://raw.githubusercontent.com/SankrityaT/fetch/main/latest.json`
   (or push it to that path in the repo), shaped as:
   ```json
   { "version": "1.2.0", "url": "https://github.com/SankrityaT/fetch/releases/download/v1.2.0/Fetch.dmg", "notes": "Fixed the thing." }
   ```
2. Upload the DMG the `url` points at as a public release asset (or anywhere reachable over HTTPS).
3. That is the whole feed. The client does a plain `GET`, compares `version` against `app.getVersion()`
   with real numeric major.minor.patch comparison (not string comparison, so `0.10.0` correctly beats
   `0.9.0`), downloads the DMG to a temp path with progress if newer, and opens it with
   `shell.openPath` when the user clicks "Restart and update".

## What "busy" means, and why it blocks installs

Fetch never installs or restarts on its own while:

- recording or paused (`main.js` already tracks this in `recState` for the tray and border/hud; the
  same value is forwarded to `updater.setRecState`),
- a processing job is running (`main.js` now counts active `edit-job` calls in `jobsActive` and reports
  it with `updater.setJobsActive`, `processor.js` itself is untouched),
- the editor has unsaved work (`updater.js` reads `<userData>/editor-state.json` at busy-check time and
  treats a `dirty: true` field as busy; that file is written by the editor's autosave).

`ui/updater.js` exports a pure `isBusy(state)` for this, no electron dependency, so it is unit-testable
directly with node. If the user clicks "Restart and update" while busy, Fetch does not refuse outright:
it remembers the click, polls every 5 seconds, and installs the moment the app goes idle, without asking
again. It never restarts without that click having happened first.

## What was verified, and what could not be

Verified:
- the Settings "Updates" card renders (screenshot via the dev harness), toggle state and version both
  come through correctly.
- the "Install updates automatically" toggle persists to `prefs.json` in both directions.
- `isBusy()` against all four fabricated states (recording, job running, editor dirty, all clear).
- `semverCompare` against `1.0.0` vs `1.0.1`, `0.9.0` vs `0.10.0`, and `1.0.0` vs `1.0.0`.

Not verified, and cannot be without a real GitHub release: an actual check finding a real update,
a real download, `quitAndInstall`, or the manifest fallback's HTTP path end to end.
