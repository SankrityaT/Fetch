#!/bin/bash
# Packages Fetch.app (Electron recorder plus the embedded native camera bubble) and a signed DMG.
set -euo pipefail
cd "$(dirname "$0")"

# `./build.sh helpers` builds only the Swift helpers, beside the source, where a checkout
# run with `npx electron .` finds them. No bundle, no signing, no DMG, nothing in dist
# touched. Shot is built there only once git ignores it, so a binary is never left
# waiting to be committed.
if [ "${1:-}" = "helpers" ]; then
  swiftc -O WindowList.swift -o WindowList
  swiftc -O Elements.swift -o Elements
  swiftc -O Recorder.swift -o Recorder
  if git check-ignore -q Shot 2>/dev/null; then swiftc -O Shot.swift -o Shot
  else
    T=$(mktemp -d); swiftc -O Shot.swift -o "$T/Shot"; rm -rf "$T"
    echo "Shot compiles; not written beside the source, since git does not ignore it"
  fi
  echo "built: WindowList Elements Recorder$(git check-ignore -q Shot 2>/dev/null && echo " Shot")"
  exit 0
fi

ID="Developer ID Application: Sankritya Thakur (J94T84BVCP)"
# One source of truth. A hardcoded "1.0" is not valid semver, parsed as 0.0.0, and
# made every release look newer than the app itself: a permanent update loop.
VERSION=$(node -p "require('./package.json').version")
APP="dist/Fetch.app"
DMG="dist/Fetch.dmg"

rm -rf dist && mkdir -p dist

# ---------- 1. native camera bubble ----------
swiftc -O CamBubble.swift -o /tmp/CamBubble.bin
rm -rf /tmp/FetchBubble
mkdir -p /tmp/FetchBubble/Fetch.app/Contents/{MacOS,Resources}
cp /tmp/CamBubble.bin /tmp/FetchBubble/Fetch.app/Contents/MacOS/Fetch
cp Fetch.icns /tmp/FetchBubble/Fetch.app/Contents/Resources/CamBubble.icns   # same art, one file
cat > /tmp/FetchBubble/Fetch.app/Contents/Info.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Fetch</string>
  <key>CFBundleDisplayName</key><string>Fetch</string>
  <key>CFBundleExecutable</key><string>Fetch</string>
  <key>CFBundleIdentifier</key><string>com.sankritya.fetch.cambubble</string>
  <key>CFBundleIconFile</key><string>CamBubble</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSCameraUsageDescription</key><string>Fetch shows your webcam in a floating circle while you record.</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
EOF

# ---------- 2. Electron app bundle ----------
cp -R node_modules/electron/dist/Electron.app "$APP"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/Fetch"
rm -rf "$APP/Contents/Resources/default_app.asar"
mkdir -p "$APP/Contents/Resources/app"
cp main.js control.html cam.html hud.html border.html processor.js fontinstance.js package.json "$APP/Contents/Resources/app/"
cp -R ui "$APP/Contents/Resources/app/ui"
cp -R assets "$APP/Contents/Resources/app/assets"

# The MCP shim ships inside the bundle so connecting an agent needs no npm install
# and the server can never drift out of step with the app driving it. Pure JS, no
# native binaries, so it needs no signing of its own.
mkdir -p "$APP/Contents/Resources/app/mcp"
cp mcp/index.js mcp/bridge.js mcp/package.json "$APP/Contents/Resources/app/mcp/"
cp -R mcp/node_modules "$APP/Contents/Resources/app/mcp/node_modules"
mkdir -p "$APP/Contents/Resources/app/vendor"
cp vendor/ffmpeg "$APP/Contents/Resources/app/vendor/ffmpeg"
# The packaged app has no environment, so the metrics endpoint has to be written in.
if [ -n "${FETCH_METRICS_URL:-}" ]; then
  printf '{"url":"%s"}\n' "$FETCH_METRICS_URL" > "$APP/Contents/Resources/app/metrics.json"
  echo "metrics endpoint baked in: $FETCH_METRICS_URL"
fi
cp Fetch.icns "$APP/Contents/Resources/Fetch.icns"
cp -R /tmp/FetchBubble/Fetch.app "$APP/Contents/Resources/Fetch.app"
swiftc -O WindowList.swift -o "$APP/Contents/Resources/WindowList"
swiftc -O Elements.swift -o "$APP/Contents/Resources/Elements"
swiftc -O Recorder.swift  -o "$APP/Contents/Resources/Recorder"
# A still is a take of one frame, so its helper ships beside the recorder's.
swiftc -O Shot.swift      -o "$APP/Contents/Resources/Shot"
cp -R Transcribe.app "$APP/Contents/Resources/Transcribe.app"

P="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable Fetch" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Fetch" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Fetch" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.sankritya.fetch" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile Fetch" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$P"
/usr/libexec/PlistBuddy -c "Set :NSCameraUsageDescription Fetch shows your webcam in a floating circle." "$P" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :NSCameraUsageDescription string 'Fetch shows your webcam in a floating circle.'" "$P"
/usr/libexec/PlistBuddy -c "Set :NSMicrophoneUsageDescription Fetch records your microphone while you record the screen." "$P" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string 'Fetch records your microphone while you record the screen.'" "$P"

# helper bundles need unique ids under our identifier
for h in "" " (GPU)" " (Plugin)" " (Renderer)"; do
  HP="$APP/Contents/Frameworks/Electron Helper$h.app"
  [ -d "$HP" ] || continue
  NEW=$(echo "helper$h" | tr -d ' ()' | tr 'A-Z' 'a-z')
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.sankritya.fetch.$NEW" "$HP/Contents/Info.plist"
done

# ---------- 3. sign (hardened runtime, inside-out) ----------
cat > /tmp/fetch.entitlements <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.device.camera</key><true/>
  <key>com.apple.security.device.audio-input</key><true/>
</dict></plist>
EOF

sign() { codesign --force --timestamp --options runtime --entitlements /tmp/fetch.entitlements -s "$ID" "$1"; }

# strictly inside-out: dylibs → crashpad → frameworks → helpers → bubble → transcribe → ffmpeg → app
find "$APP/Contents/Frameworks" \( -name "*.dylib" -o -name "*.node" \) -print0 | while IFS= read -r -d '' f; do sign "$f"; done
# Helper executables tucked inside a framework's Resources are separate Mach-O
# binaries. Signing the framework does not cover them, and notarisation rejects the
# whole archive over one of them: Squirrel ships ShipIt in there, which is what
# failed the first submission. Sign anything executable in there, not just ShipIt.
find "$APP/Contents/Frameworks" -path "*/Resources/*" -type f -perm -111 -print0 |
  while IFS= read -r -d '' f; do
    file "$f" | grep -q "Mach-O" && sign "$f"
  done
find "$APP/Contents/Frameworks" -name "chrome_crashpad_handler" -print0 | while IFS= read -r -d '' f; do sign "$f"; done
for f in "$APP/Contents/Frameworks/"*.framework; do sign "$f/Versions/A"; done
for h in "$APP/Contents/Frameworks/"*.app; do sign "$h/Contents/MacOS/"*; sign "$h"; done
sign "$APP/Contents/Resources/WindowList"
sign "$APP/Contents/Resources/Elements"
sign "$APP/Contents/Resources/Recorder"
sign "$APP/Contents/Resources/Shot"
sign "$APP/Contents/Resources/Fetch.app/Contents/MacOS/Fetch"
sign "$APP/Contents/Resources/Fetch.app"
sign "$APP/Contents/Resources/Transcribe.app/Contents/MacOS/Transcribe"
sign "$APP/Contents/Resources/app/vendor/ffmpeg"
sign "$APP/Contents/Resources/Transcribe.app"
sign "$APP"

codesign --verify --deep --strict --verbose=1 "$APP"

# ---------- 4. dmg ----------
STAGE=/tmp/fetch-dmg; rm -rf $STAGE; mkdir -p $STAGE
cp -R "$APP" $STAGE/
ln -s /Applications $STAGE/Applications
hdiutil create -volname Fetch -srcfolder $STAGE -ov -format UDZO "$DMG" >/dev/null
codesign --force --timestamp -s "$ID" "$DMG"

echo "built: $DMG"
