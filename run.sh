#!/bin/bash
cd "$(dirname "$0")"
open ./CamBubble.app          # circular webcam bubble: drag to move, scroll to resize, right-click to quit
exec npx electron .           # recorder controls: start / pause / stop
