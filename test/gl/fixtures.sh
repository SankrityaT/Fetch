#!/bin/bash
# Fixtures for the GL harness (test/gl/harness.js). Writes to /tmp/fetch-gl.
#   take.mov   a 1440x900 "screen take": variable rate (runs of frames dropped, the way
#              ScreenCaptureKit writes nothing while the screen is still), off the 60 fps
#              grid, the source frame index burned in, a tone for sound
#   offset.mov take.mov with its timestamps starting at 1.5 s
#   cam.mov    a 640x480 camera take at 30 fps
#   bars.mp4   SMPTE HD bars, BT.709, near-lossless
#   bg.jpg     an image background
set -e
OUT=/tmp/fetch-gl
mkdir -p "$OUT"
F="-hide_banner -loglevel error -y"
TAG709="-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv"
ffmpeg $F -f lavfi -i "testsrc2=s=1440x900:r=60:d=12" -f lavfi -i "sine=f=440:d=12:sample_rate=48000" \
  -filter_complex "[0:v]drawtext=text='%{n}':fontsize=120:fontcolor=white:box=1:boxcolor=black@0.7:x=60:y=60,\
select='lt(mod(n*7919\,97)\,60)+lt(n\,2)',setpts='PTS+(mod(N*37\,13)/13)*0.9/(60*TB)',format=yuv420p[v]" \
  -map "[v]" -map 1:a -fps_mode passthrough -enc_time_base:v 1/60000 -c:v libx264 -crf 10 -preset fast -g 120 \
  -video_track_timescale 60000 $TAG709 -c:a aac -b:a 128k "$OUT/take.mov"
# the same take with its timestamps starting at 1.5 s, as an imported or remuxed file can
ffmpeg $F -i "$OUT/take.mov" -c copy -output_ts_offset 1.5 "$OUT/offset.mov"
ffmpeg $F -f lavfi -i "testsrc=s=640x480:r=30:d=14" -c:v libx264 -crf 16 -preset fast -pix_fmt yuv420p $TAG709 "$OUT/cam.mov"
ffmpeg $F -f lavfi -i "smptehdbars=s=1920x1080:r=60:d=2" -pix_fmt yuv420p -c:v libx264 -crf 4 -preset fast $TAG709 "$OUT/bars.mp4"
# an image background, larger than the output and another shape, so cover is tested
ffmpeg $F -f lavfi -i "mandelbrot=s=2400x1500:end_pts=1" -frames:v 1 -q:v 3 "$OUT/bg.jpg"
echo "fixtures in $OUT"
