#!/bin/bash
# Notarizes the built app + dmg so anyone can open it without Gatekeeper warnings.
#
# Preferred, so no password ever lands in your shell history. Run this once:
#
#   xcrun notarytool store-credentials fetch-notary \
#     --apple-id <your-apple-id-email> --team-id J94T84BVCP --password <app-specific-password>
#
# then just:  ./notarize.sh
#
# One-shot alternative:  ./notarize.sh <apple-id-email> <app-specific-password>
#
# The app-specific password comes from appleid.apple.com, under
# Sign-In and Security > App-Specific Passwords. It is not your Apple ID password.
set -euo pipefail
cd "$(dirname "$0")"

TEAM="J94T84BVCP"
ID="Developer ID Application: Sankritya Thakur ($TEAM)"
APP="dist/Fetch.app"
DMG="dist/Fetch.dmg"
PROFILE="${FETCH_NOTARY_PROFILE:-fetch-notary}"

[ -d "$APP" ] || { echo "no $APP, run ./build.sh first"; exit 1; }

# credentials: stored profile if there is one, otherwise the two arguments
if xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  AUTH=(--keychain-profile "$PROFILE")
  echo "→ using stored credentials '$PROFILE'"
elif [ $# -ge 2 ]; then
  AUTH=(--apple-id "$1" --password "$2" --team-id "$TEAM")
  echo "→ using the Apple ID passed on the command line"
else
  echo "No notarisation credentials."
  echo
  echo "Either store them once (recommended):"
  echo "  xcrun notarytool store-credentials $PROFILE \\"
  echo "    --apple-id <your-apple-id-email> --team-id $TEAM --password <app-specific-password>"
  echo
  echo "or pass them in:  ./notarize.sh <apple-id-email> <app-specific-password>"
  exit 1
fi

echo "→ zipping app for submission"
ditto -c -k --keepParent "$APP" /tmp/Fetch-notarize.zip

echo "→ submitting the app (usually 1 to 5 minutes)"
xcrun notarytool submit /tmp/Fetch-notarize.zip "${AUTH[@]}" --wait

echo "→ stapling the app"
xcrun stapler staple "$APP"

echo "→ rebuilding the dmg around the stapled app"
STAGE=/tmp/qr-dmg; rm -rf $STAGE; mkdir -p $STAGE
cp -R "$APP" $STAGE/
ln -s /Applications $STAGE/Applications
hdiutil create -volname Fetch -srcfolder $STAGE -ov -format UDZO "$DMG" >/dev/null
codesign --force --timestamp -s "$ID" "$DMG"

echo "→ submitting the dmg"
xcrun notarytool submit "$DMG" "${AUTH[@]}" --wait
xcrun stapler staple "$DMG"

echo
echo "→ what Gatekeeper sees:"
spctl -a -vvv -t install "$APP" || true
xcrun stapler validate "$DMG"
echo "done → $DMG is ready to hand out"
