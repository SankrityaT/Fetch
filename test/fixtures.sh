#!/bin/bash
# Builds the clips the test suites run against (synthetic + a real recording).
set -e
cd "$(dirname "$0")/.."
F=./vendor/ffmpeg
mkdir -p /tmp/fetch-test
# 12s clip: tone 0-2, 4-6, 8-10 with silence between → known ground truth for removeSilence
$F -hide_banner -v error -y -f lavfi -i "testsrc2=s=640x360:r=30:d=12" \
  -f lavfi -i "aevalsrc='0.4*sin(440*2*PI*t)*lt(mod(t,4),2)':d=12:s=44100" \
  -c:v libvpx-vp9 -b:v 500k -deadline realtime -cpu-used 8 -c:a libopus /tmp/fetch-test/silence.webm
# assorted input containers
SRC=$(ls -t ~/Desktop/recording-*.webm 2>/dev/null | head -1)
if [ -n "$SRC" ]; then
  cp "$SRC" /tmp/fetch-test/test.webm
else
  # No real take to borrow: synthesise one shaped like MediaRecorder's output. Written
  # to a pipe, so the webm has no duration and no cues, which is the case that matters.
  say -o /tmp/fetch-test/said.aiff "Open the filter panel, pick a status, and save it."
  $F -hide_banner -v error -y -f lavfi -i "testsrc2=s=1280x720:r=30" -i /tmp/fetch-test/said.aiff \
    -shortest -c:v libvpx-vp9 -b:v 800k -deadline realtime -cpu-used 8 -c:a libopus -f webm - \
    > /tmp/fetch-test/test.webm
fi
$F -hide_banner -v error -y -fflags +genpts -i /tmp/fetch-test/test.webm -c copy /tmp/fetch-test/fixed.mkv
for spec in "mov:libx264:aac" "mkv:libx264:aac" "avi:mpeg4:mp3" "m4v:libx264:aac"; do
  ext=${spec%%:*}; rest=${spec#*:}; v=${rest%%:*}; a=${rest##*:}
  $F -hide_banner -v error -y -i /tmp/fetch-test/fixed.mkv -t 4 -c:v $v -c:a $a "/tmp/fetch-test/in.$ext"
done
echo "x" > /tmp/fetch-test/notes.txt
echo "fixtures ready in /tmp/fetch-test"
