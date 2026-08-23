#!/usr/bin/env python3
"""Key a flat background out of a video and write a WebM with a real alpha channel.

Colour keying alone punches holes wherever the subject contains the background
colour: Biscuit has near-black eyes and a black nose, so a black key removes them.
This fills interior holes properly (scipy binary_fill_holes) instead of guessing
with blurs, then erodes a pixel to drop the compression fringe.

  python3 tools/key_video.py in.mp4 out.webm --bg 000000 --tol 40 --width 480
"""
import argparse, subprocess, sys
import numpy as np
from scipy import ndimage

FFMPEG = "./vendor/ffmpeg"

ap = argparse.ArgumentParser()
ap.add_argument("src"); ap.add_argument("dst")
ap.add_argument("--bg", default="000000", help="background hex, no #")
ap.add_argument("--tol", type=int, default=40, help="0-255 distance treated as background")
ap.add_argument("--width", type=int, default=480)
ap.add_argument("--fps", type=int, default=20)
ap.add_argument("--erode", type=int, default=1, help="pixels to shave off the edge")
ap.add_argument("--crf", type=int, default=36)
a = ap.parse_args()

bg = np.array([int(a.bg[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.int16)

probe = subprocess.run([FFMPEG, "-hide_banner", "-i", a.src], capture_output=True, text=True).stderr
import re
m = re.search(r", (\d+)x(\d+)", probe)
sw, sh = int(m.group(1)), int(m.group(2))
w = a.width - (a.width % 2)
h = int(round(sh * w / sw));  h -= h % 2

read = subprocess.Popen(
    [FFMPEG, "-v", "error", "-i", a.src, "-vf", f"scale={w}:{h},fps={a.fps}",
     "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
write = subprocess.Popen(
    [FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba",
     "-s", f"{w}x{h}", "-r", str(a.fps), "-i", "-",
     "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
     "-auto-alt-ref", "0", "-lag-in-frames", "0",
     "-b:v", "0", "-crf", str(a.crf), "-row-mt", "1", "-an", a.dst],
    stdin=subprocess.PIPE)

frame_bytes = w * h * 3
n = 0
while True:
    buf = read.stdout.read(frame_bytes)
    if len(buf) < frame_bytes:
        break
    rgb = np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3).astype(np.int16)

    # background = every channel within tolerance of the key colour
    is_bg = (np.abs(rgb - bg).max(axis=2) <= a.tol)
    solid = ~is_bg
    solid = ndimage.binary_fill_holes(solid)          # eyes and nose come back
    if a.erode:
        solid = ndimage.binary_erosion(solid, iterations=a.erode)

    out = np.empty((h, w, 4), dtype=np.uint8)
    out[..., :3] = rgb.astype(np.uint8)
    out[..., 3] = np.where(solid, 255, 0).astype(np.uint8)
    write.stdin.write(out.tobytes())
    n += 1

write.stdin.close(); write.wait(); read.wait()
print(f"{a.dst}: {n} frames at {w}x{h}")
