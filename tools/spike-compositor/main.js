// M0 spike host. Opens one hidden window (never shown, never focused) that runs a test
// mode, writes its JSON result and quits. Usage:
//   npx electron tools/spike-compositor --mode=bench --src=/path.mov --sink=nv12 [--decoder=ffmpeg]
// Modes: bench, stages, parity, vfr, throttle, rvfc. See RESULTS.md.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) args[m[1]] = m[2];
  else if (a.startsWith('--')) args[a.slice(2)] = '1';
}
const mode = args.mode || 'bench';
const out = args.out || `/tmp/fetch-spike/result-${mode}-${Date.now()}.json`;

// Background throttling is the thing under test in throttle mode, so it can be turned
// back on to show the contrast. Everything else runs the way the product would.
const throttle = args.throttle === '1';

// The spike must not steal focus or appear in the Dock while another agent records.
if (app.dock) app.dock.hide();

app.whenReady().then(() => {
  // rvfc mode needs a window the compositor considers visible, so it is shown inactive
  // at zero window opacity: nothing appears on screen or in a capture, nothing is focused.
  const visible = mode === 'rvfc' && args.visible === '1';
  const win = new BrowserWindow({
    show: false, width: 640, height: 400, x: 0, y: 0,
    focusable: false, skipTaskbar: true, frame: false, transparent: visible,
    hasShadow: false, paintWhenInitiallyHidden: args.pwih !== '0',
    webPreferences: {
      nodeIntegration: true, nodeIntegrationInWorker: true, contextIsolation: false, sandbox: false,
      backgroundThrottling: throttle, webSecurity: false,
    },
  });
  if (visible) {
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
    win.showInactive();
  }
  const timer = setTimeout(() => finish({ error: 'timeout' }), Number(args.timeout || 900) * 1000);
  function finish(result) {
    clearTimeout(timer);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ mode, args, ...result }, null, 2));
    console.log('RESULT ' + out);
    app.exit(result && result.error ? 1 : 0);
  }
  ipcMain.on('log', (_e, s) => console.log(s));
  ipcMain.on('done', (_e, r) => finish(r));
  win.webContents.on('render-process-gone', (_e, d) => finish({ error: 'renderer gone: ' + d.reason }));
  win.webContents.on('console-message', (_e, _l, msg) => { if (args.verbose) console.log('[r] ' + msg); });
  win.loadFile(path.join(__dirname, 'index.html'), { query: { args: JSON.stringify(args), visible: visible ? '1' : '0' } });
});
