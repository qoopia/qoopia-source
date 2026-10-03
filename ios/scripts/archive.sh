#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${QOOPIA_APPLE_TEAM_ID:?Set the verified Apple Developer team ID}"
: "${QOOPIA_IOS_BUILD_NUMBER:?Set a new numeric TestFlight build number}"
[[ "$QOOPIA_IOS_BUILD_NUMBER" =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid build number' >&2; exit 2; }
xcrun --sdk iphoneos --show-sdk-path >/dev/null
if [[ -n $(git status --porcelain --untracked-files=normal) ]]; then
  echo 'Archive only a clean, committed source checkout.' >&2; exit 2
fi
archive_path="build/Qoopia-${QOOPIA_IOS_BUILD_NUMBER}.xcarchive"
[[ ! -e "$archive_path" ]] || { echo 'Archive already exists; use a new build number.' >&2; exit 2; }
xcodebuild -project Qoopia.xcodeproj -scheme Qoopia -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$archive_path" DEVELOPMENT_TEAM="$QOOPIA_APPLE_TEAM_ID" \
  CURRENT_PROJECT_VERSION="$QOOPIA_IOS_BUILD_NUMBER" -allowProvisioningUpdates archive
git rev-parse HEAD > "${archive_path}.source-sha"
printf 'Archive ready for validation in Xcode Organizer: %s\n' "$archive_path"
