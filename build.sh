#!/bin/bash
# Packages Fetch.app (Electron recorder plus the embedded native camera bubble) and a signed DMG.
set -euo pipefail
cd "$(dirname "$0")"

ID="Developer ID Application: Sankritya Thakur (J94T84BVCP)"
APP="dist/Fetch.app"
DMG="dist/Fetch.dmg"

rm -rf dist && mkdir -p dist

# ---------- 1. native camera bubble ----------
swiftc -O CamBubble.swift -o /tmp/CamBubble.bin
rm -rf /tmp/FetchBubble
mkdir -p /tmp/FetchBubble/Fetch.app/Contents/{MacOS,Resources}
cp /tmp/CamBubble.bin /tmp/FetchBubble/Fetch.app/Contents/MacOS/Fetch
cp Fetch.icns /tmp/FetchBubble/Fetch.app/Contents/Resources/CamBubble.icns   # same art, one file
cat > /tmp/FetchBubble/Fetch.app/Contents/Info.plist <<'EOF'
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
EOF

# ---------- 2. Electron app bundle ----------
cp -R node_modules/electron/dist/Electron.app "$APP"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/Fetch"
rm -rf "$APP/Contents/Resources/default_app.asar"
mkdir -p "$APP/Contents/Resources/app"
cp main.js control.html cam.html hud.html border.html processor.js package.json "$APP/Contents/Resources/app/"
cp -R ui "$APP/Contents/Resources/app/ui"
cp -R assets "$APP/Contents/Resources/app/assets"
mkdir -p "$APP/Contents/Resources/app/vendor"
cp vendor/ffmpeg "$APP/Contents/Resources/app/vendor/ffmpeg"
cp Fetch.icns "$APP/Contents/Resources/Fetch.icns"
cp -R /tmp/FetchBubble/Fetch.app "$APP/Contents/Resources/Fetch.app"
swiftc -O WindowList.swift -o "$APP/Contents/Resources/WindowList"
swiftc -O Recorder.swift  -o "$APP/Contents/Resources/Recorder"
cp -R Transcribe.app "$APP/Contents/Resources/Transcribe.app"

P="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable Fetch" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Fetch" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Fetch" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.sankritya.fetch" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile Fetch" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion 1.0" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 1.0" "$P"
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
sign "$APP/Contents/Resources/Recorder"
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
