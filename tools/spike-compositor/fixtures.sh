#!/bin/bash
# Synthetic fixtures for the M0 gate. Writes to /tmp/fetch-spike.
set -e
OUT=/tmp/fetch-spike
mkdir -p "$OUT"
F="-hide_banner -loglevel error -y"
TAG709="-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv"

# Colour bars (SMPTE HD), 2 s, near-lossless, tagged BT.709 like a real export, and
# untagged like a ScreenCaptureKit take (ffprobe reports "unknown" on those).
ffmpeg $F -f lavfi -i "smptehdbars=s=1920x1080:r=60:d=2" -pix_fmt yuv420p \
  -c:v libx264 -crf 4 -preset fast $TAG709 "$OUT/bars709.mp4"
ffmpeg $F -f lavfi -i "smptehdbars=s=1920x1080:r=60:d=2" -pix_fmt yuv420p \
  -c:v libx264 -crf 4 -preset fast "$OUT/barsraw.mp4"

# Test card: testsrc2 has ramps, fine text and saturated edges.
ffmpeg $F -f lavfi -i "testsrc2=s=1920x1080:r=60:d=2" -pix_fmt yuv420p \
  -c:v libx264 -crf 4 -preset fast $TAG709 "$OUT/card.mp4"

# VFR frame-counter fixture: 2880x1800 at 60 fps, the source frame index burned in as
# 16 binary blocks along the top plus a readable number, then ~30% of frames dropped in
# irregular runs while keeping their timestamps (ScreenCaptureKit style gaps).
ffmpeg $F -f lavfi -i "testsrc2=s=2880x1800:r=60:d=12" \
  -f lavfi -i "color=c=black:s=2880x160:r=60:d=12" \
  -filter_complex "[1:v]format=gray,geq=lum='if(lt(Y,20)+gt(Y,140),128,if(mod(floor(N/pow(2,floor(X/180))),2),235,16))'[bar];\
[0:v][bar]overlay=0:0,drawtext=text='%{n}':fontsize=160:fontcolor=white:box=1:boxcolor=black@0.7:x=80:y=240,\
select='lt(mod(n*7919\,97)\,68)+lt(n\,2)',format=yuv420p[v]" \
  -map "[v]" -fps_mode passthrough -c:v libx264 -crf 12 -preset fast -g 120 \
  -video_track_timescale 60000 $TAG709 "$OUT/vfr-counter.mp4"
# The same kept frames moved off the 60 fps grid (ScreenCaptureKit timestamps are not on
# any grid). Order is kept, so the i-th timestamp still belongs to the i-th counter.
ffmpeg $F -i "$OUT/vfr-counter.mp4" -vf "setpts='PTS+(mod(N*37\,13)/13)*0.9/(60*TB)'" \
  -fps_mode passthrough -enc_time_base:v 1/60000 -c:v libx264 -crf 12 -preset fast -g 120 \
  -video_track_timescale 60000 $TAG709 "$OUT/vfr-jitter.mp4"
echo "fixtures in $OUT"; ls -la "$OUT"
