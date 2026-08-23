#!/bin/bash
# Builds the clips the test suites run against (synthetic + a real recording).
set -e
cd "$(dirname "$0")/.."
F=./vendor/ffmpeg
mkdir -p /tmp/qrt
# 12s clip: tone 0-2, 4-6, 8-10 with silence between → known ground truth for removeSilence
$F -hide_banner -v error -y -f lavfi -i "testsrc2=s=640x360:r=30:d=12" \
  -f lavfi -i "aevalsrc='0.4*sin(440*2*PI*t)*lt(mod(t,4),2)':d=12:s=44100" \
  -c:v libvpx-vp9 -b:v 500k -deadline realtime -cpu-used 8 -c:a libopus /tmp/qrt/silence.webm
# assorted input containers
SRC=$(ls -t ~/Desktop/recording-*.webm 2>/dev/null | head -1)
[ -n "$SRC" ] && cp "$SRC" /tmp/qrt/test.webm
$F -hide_banner -v error -y -fflags +genpts -i /tmp/qrt/test.webm -c copy /tmp/qrt/fixed.mkv
for spec in "mov:libx264:aac" "mkv:libx264:aac" "avi:mpeg4:mp3" "m4v:libx264:aac"; do
  ext=${spec%%:*}; rest=${spec#*:}; v=${rest%%:*}; a=${rest##*:}
  $F -hide_banner -v error -y -i /tmp/qrt/fixed.mkv -t 4 -c:v $v -c:a $a "/tmp/qrt/in.$ext"
done
echo "x" > /tmp/qrt/notes.txt
echo "fixtures ready in /tmp/qrt"
