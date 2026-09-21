#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
xcrun swiftc Qoopia/Workspace.swift tests/main.swift -o "$temporary/workspace-tests"
"$temporary/workspace-tests"
plutil -lint Qoopia/Info.plist Qoopia/PrivacyInfo.xcprivacy Qoopia.xcodeproj/project.pbxproj
python3 - <<'PY'
import json, pathlib, re
root=pathlib.Path('Qoopia')
keys=lambda language:set(re.findall(r'^"(.*?)"\s*=',(root/f'{language}.lproj/Localizable.strings').read_text(),re.M))
assert keys('en')==keys('ru'),'iOS localization mismatch'
assert (root/'Assets.xcassets/AppIcon.appiconset/AppIcon.png').stat().st_size>1000
print('iOS assets and localization: passed')
PY
if xcrun --sdk iphonesimulator --show-sdk-path >/dev/null 2>&1; then
  xcodebuild -project Qoopia.xcodeproj -scheme Qoopia -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
else
  printf '%s\n' 'BLOCKED: Xcode and the iOS Simulator SDK are required for the application build.' >&2
  exit 2
fi
