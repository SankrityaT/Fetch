// Web Worker with Node integration: reads an ffmpeg NV12 pipe off the compositor thread
// and posts whole frames (transferred, not copied). Freed buffers come back for reuse.
'use strict';
const { spawn } = require('child_process');
let proc = null, chunks = 0, pending = 0, paused = false, maxPending = 6;
const pool = [];
onmessage = (e) => {
  const m = e.data;
  if (m.cmd === 'free') {
    pending--; pool.push(m.buf);
    if (paused && pending < maxPending) { paused = false; stream.resume(); }
    return;
  }
  if (m.cmd === 'kill') { if (proc) proc.kill('SIGKILL'); return; }
  if (m.cmd !== 'start') return;
  const size = m.frameBytes; maxPending = m.queue || 6;
  let buf = new Uint8Array(size), fill = 0;
  const onData = (d) => {
    chunks++;
    let off = 0;
    while (off < d.length) {
      const take = Math.min(d.length - off, size - fill);
      buf.set(d.subarray(off, off + take), fill); fill += take; off += take;
      if (fill === size) {
        postMessage({ frame: buf, chunks }, [buf.buffer]); pending++;
        buf = pool.length ? new Uint8Array(pool.pop()) : new Uint8Array(size); fill = 0;
      }
    }
    if (pending >= maxPending && !paused) { paused = true; stream.pause(); }
  };
  const wire = (s) => { stream = s; s.on('data', onData); s.on('end', () => postMessage({ end: true, chunks })); };
  if (m.transport === 'tcp') {
    // Loopback TCP: the kernel autotunes the buffer, so reads arrive in 64 KB chunks
    // instead of the 8 KB a stdout pipe delivers in Electron.
    const srv = require('net').createServer((sock) => { srv.close(); wire(sock); });
    srv.listen(0, '127.0.0.1', () => {
      const args = m.args.slice(); args[args.length - 1] = `tcp://127.0.0.1:${srv.address().port}`;
      proc = spawn(m.ffmpeg, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    });
  } else {
    proc = spawn(m.ffmpeg, m.args, { stdio: ['ignore', 'pipe', 'ignore'] });
    wire(proc.stdout);
  }
};
let stream = null;
