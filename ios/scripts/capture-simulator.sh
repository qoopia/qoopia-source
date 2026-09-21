#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/evidence
device=$(xcrun simctl list devices available --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(x["udid"] for rows in d["devices"].values() for x in rows if x["name"].startswith("iPhone")))')
trap 'xcrun simctl shutdown "$device" >/dev/null 2>&1 || true' EXIT
xcrun simctl boot "$device"
xcrun simctl bootstatus "$device" -b
xcrun simctl status_bar "$device" override --time '9:41' --batteryState charged --batteryLevel 100
xcrun simctl install "$device" build/Build/Products/Debug-iphonesimulator/Qoopia.app
# Launch once before capture: first-use system notifications can arrive after boot.
xcrun simctl launch "$device" ai.qoopia.ios --acceptance-workspaces
sleep 30
xcrun simctl terminate "$device" ai.qoopia.ios
for mode in light dark; do
  xcrun simctl ui "$device" appearance "$mode"
  xcrun simctl launch "$device" ai.qoopia.ios --acceptance-workspaces
  sleep 10
  xcrun simctl io "$device" screenshot "build/evidence/iphone-workspaces-${mode}.png"
  xcrun simctl terminate "$device" ai.qoopia.ios
done
xcrun simctl ui "$device" content_size accessibility-extra-large
xcrun simctl launch "$device" ai.qoopia.ios --acceptance-workspaces -AppleLanguages '(ru)'
sleep 3
xcrun simctl io "$device" screenshot build/evidence/iphone-workspaces-large-ru.png
xcrun simctl terminate "$device" ai.qoopia.ios
xcrun simctl ui "$device" content_size large
for mode in light dark; do
  xcrun simctl ui "$device" appearance "$mode"
  xcrun simctl launch "$device" ai.qoopia.ios --acceptance-unavailable
  sleep 3
  xcrun simctl io "$device" screenshot "build/evidence/iphone-unavailable-${mode}.png"
  xcrun simctl terminate "$device" ai.qoopia.ios
done
git rev-parse HEAD > build/evidence/source-sha.txt
xcodebuild -version > build/evidence/toolchain.txt
