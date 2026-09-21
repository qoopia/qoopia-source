# iPhone direct dashboard entry

## Behavior

The iPhone client starts at `/profile?app=ios`. One email confirmation opens the
account's saved HTTPS workspace automatically. The app then displays the existing
mobile dashboard without permanent browser toolbars. App settings remains in the
dashboard menu and login screen. Existing WebKit sessions survive the update.

A missing/unreachable saved address requires connecting the existing installation;
this flow does not provision a second empty workspace or copy memory to the phone.
The workspace must run the account-continuation server changes in this release.
Older self-hosted servers retain ordinary email sign-in until upgraded. Desktop and
Linux installer source coordinates must not be changed without building new packages.

## Trust boundary

Account cookies remain at the account origin. A workspace creates a random verifier
and retains it with its HttpOnly browser attempt. The account service binds the
challenge to the saved dashboard address. After an authenticated same-origin POST,
a random one-use code returns in the dashboard URL fragment. The dashboard removes
that fragment immediately and sends the code with its pending cookie. Redemption
requires both the code and server-held verifier. The workspace checks its existing
owner identity and session version before issuing the normal owner session.

An attacker-created authorization request alone cannot be polled into an owner's
session. Missing/wrong code, verifier, pending browser, owner, expiry or session
version is refused. Continuation cannot enroll a device. Native automatic workspace
navigation accepts only the trusted account origin; settings links only originate
from the active workspace. No native credential bridge was added.

## Data and rollout

`account_handoffs` is an additive table in the **account service's** login database.
Rows expire after ten minutes and are removed after redemption. Workspace schema
remains 46. Back up and integrity-check both service databases before rollout.
Deploy both account and workspace services before distributing iOS build 2.
Same-schema rollback restores the previous service images, retains existing writes,
and leaves the additive table unused; in-progress sign-ins must start again.
Do not restore old databases over new writes for an image-only rollback.

## Verification

- Unit/integration: account handoff, profile/email proof, wrong account, wrong
  browser, replay, expiry and owner session revocation; native URL policy tests.
- Browser: `NODE_ENV=test QOOPIA_SERVER_ROLE=canonical bun tests/helpers/app-entry-browser.ts`,
  then `python3 tests/helpers/app-entry-browser.py <evidence-directory>`.
  Uses localhost port 18973, real authentication handlers and synthetic owner data.
  No email leaves the fixture. The proxy forwards only each page context's scoped
  cookies because intercepted WebKit requests omit the Cookie header. This tests
  application flow, not network-level SameSite enforcement. Stop the fixture afterward.
- Native: `ios/scripts/check.sh`, Release device archive, signed export; inspect
  actual Simulator output. TestFlight delivery requires Apple processing success.
- Physical iPhone acceptance: install build 2, confirm email if needed, return to
  Qoopia and verify the existing workspace, agents, chat, settings and logout.
  Simulator and browser results do not replace owner acceptance on the phone.
