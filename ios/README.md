# Qoopia for iPhone

Native SwiftUI host for the existing Qoopia workspace, targeting iPhone on iOS 17+.
The entire dashboard runs in a persistent WKWebView. System navigation, workspace
switching, safe address sharing, file export, connectivity and recovery are native.
This is a hybrid client, not an independent on-device agent runtime.

## Account and data

- First launch opens `https://auth.qoopia.ai/profile?app=ios`: a compact email sign-in.
  Confirm the email in Mail/Safari and return to the app. The existing saved HTTPS
  workspace opens automatically; its linked owner is checked without a second email.
- Account continuation uses a one-use browser-delivered code and a server-held
  verifier. Both are required; the confirmed account can authorize only its saved
  workspace. The workspace still checks its owner identity and session version.
  Account cookies never move between origins. The code is removed from the URL
  before the workspace redeems it; no credential is stored in an address shortcut.
- Subsequent launches open the saved dashboard directly. Dashboard navigation fills
  the app; App settings in its menu provides workspace switching, reload and sign-out.
- An account without a reachable saved workspace is asked for its existing HTTPS
  dashboard address once. This does not create an empty second workspace.
- Alternatively enter the existing HTTPS dashboard address. No owner token or
  model credential is accepted in an address. No new workspace is provisioned.
- The user's computer/server must remain online and reachable. A private HTTPS
  hostname can require the user's VPN; this app neither exposes a server nor
  configures Tailscale. Localhost and managed MCP-only endpoints are rejected.
- Preferences hold only workspace origins. WebKit owns session cookies. No
  credentials are injected into JavaScript and there is no privileged JS bridge.
- Downloads are temporary files shared through the system sheet and deleted on
  dismissal. Sharing a workspace shares its plain dashboard URL, never a login URL.
- Clearing sessions affects this app on this device, not the account or memory.

## Build and acceptance

Open `Qoopia.xcodeproj` in a current supported Xcode. The project has no external
packages. Its icon is an opaque 1024px export of the unchanged approved Q SVG;
the logo has not been reconstructed. Native controls use system typography,
Dynamic Type, light/dark appearance and 44pt touch targets. Web content uses the
approved Graphite/Manrope design from its connected server.

```sh
bash ios/scripts/check.sh
bash ios/scripts/capture-simulator.sh
```

The first command runs the URL-policy tests, validates plists/locales/assets and
compiles a simulator build. Missing Xcode/SDK is a failed prerequisite (exit 2),
not a successful app build. CI also compiles Release for an unsigned device target.
The screenshot script runs isolated Debug-only workspace/unavailable states;
it does not log into accounts or create real notes. Those states are absent in
Release. Native captures are distinct from mobile WebKit website screenshots.

Real-device acceptance before beta completion: email confirmation across app/mail,
workspace selection, all dashboard sections, chat/approval/Stop and draft retention,
file upload/download/share, keyboard and safe areas, background/foreground, network
loss/recovery and sign-out. Perform synthetic operations in a dedicated workspace.

## TestFlight

1. Use the existing Apple Developer team. The locally observed macOS Developer ID
   certificate does **not** sign iOS. Configure Apple Distribution signing and a
   matching App Store provisioning profile for `ai.qoopia.ios`; confirm the identifier
   is available in the team before registration.
2. Create the iOS app record in App Store Connect for that bundle ID. Complete
   Apple agreements and required beta/contact/privacy information truthfully.
3. Build a clean committed checkout with `QOOPIA_APPLE_TEAM_ID` and a new
   `QOOPIA_IOS_BUILD_NUMBER`:
   `bash ios/scripts/archive.sh`.
4. Validate the archive in Xcode Organizer and upload for **TestFlight and App Store**,
   not “TestFlight Internal Only”. Wait for successful processing. Add the owner as
   an internal tester only if their account has the corresponding App Store Connect
   access; otherwise submit an external testing group for Beta App Review.
5. Record the exact source SHA, version/build, App Store Connect app/build IDs and
   accepted invitation. Only then add the real TestFlight invitation to `/mobile`.

After the owner's iPhone acceptance, prepare App Store metadata/screenshots and
submit the tested build. Apple reviews minimum functionality (including hybrid
apps), privacy, account-deletion requirements and any other applicable guidelines;
a successful TestFlight upload is not App Store approval. The owner has authorized
App Store work **after their beta test**, not immediate public submission.

No signing material, Apple password, session cookies, API private key or provisioning
profile is committed here. Public and account services must separately deploy the
new web interface for that interface to appear in this remote client.

References: [distribution](https://developer.apple.com/documentation/xcode/preparing-your-app-for-distribution),
[uploading builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds),
[TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/).
