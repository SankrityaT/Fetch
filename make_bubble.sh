#!/bin/bash
# Rebuilds and signs the dev camera helper in place, for local testing with `open ./Fetch.app`.
# The bundle folder is named Fetch.app on purpose: the macOS camera consent dialog
# shows the folder name, and ignores CFBundleName and CFBundleDisplayName entirely.
#
# Why this exists: a plain `swiftc -O CamBubble.swift -o CamBubble.app/Contents/MacOS/CamBubble`
# followed by `codesign --force --sign - CamBubble.app` (ad-hoc) gives the binary a designated
# requirement pinned to its cdhash. Every rebuild produces a new cdhash, so macOS treats the
# rebuilt app as a different piece of code and the camera permission grant from the previous
# build no longer matches: it re-prompts on every launch after every rebuild. Signing with the
# Developer ID identity instead gives a designated requirement based on the team ID and bundle
# identifier, which does not change across rebuilds, so the TCC grant sticks.
set -euo pipefail
cd "$(dirname "$0")"

ID="Developer ID Application: Sankritya Thakur (J94T84BVCP)"
APP="Fetch.app"

echo "compiling CamBubble.swift..."
swiftc -O CamBubble.swift -o /tmp/fetch-bubble.bin

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp /tmp/fetch-bubble.bin "$APP/Contents/MacOS/Fetch"
rm -f /tmp/fetch-bubble.bin
rm -rf "$APP/Contents/_CodeSignature"
[ -f Fetch.icns ] && cp Fetch.icns "$APP/Contents/Resources/Fetch.icns"

# Written every time, so the bundle does not depend on a previous build existing.
# Without NSCameraUsageDescription macOS terminates the process on first camera use.
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Fetch</string>
  <key>CFBundleDisplayName</key><string>Fetch</string>
  <key>CFBundleExecutable</key><string>Fetch</string>
  <key>CFBundleIdentifier</key><string>com.sankritya.fetch.cambubble</string>
  <key>CFBundleIconFile</key><string>CamBubble</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSCameraUsageDescription</key><string>Fetch shows your webcam in a floating circle while you record.</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

cat > /tmp/fetch-bubble.entitlements <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.device.camera</key><true/>
  <key>com.apple.security.device.audio-input</key><true/>
</dict></plist>
EOF

echo "signing with Developer ID (hardened runtime)..."
codesign --force --timestamp --options runtime -i com.sankritya.fetch.cambubble \
  --entitlements /tmp/fetch-bubble.entitlements -s "$ID" "$APP"
rm -f /tmp/fetch-bubble.entitlements

echo "--- designated requirement ---"
codesign -d -r- "$APP"
echo "done: $APP"
