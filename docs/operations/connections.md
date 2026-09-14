# Connections contract and release support

Release support is limited to the tested Codex CLI, Claude Code, Claude Desktop
and Claude Web combinations below. ChatGPT Web/Desktop are experimental: their
complete setup verification is not qualified. The existing installation and
its selected remote workspace remain authoritative.

Owner API: `GET /api/dashboard/connection-setup` lists persisted progress;
`POST` takes `action` and the same fields as `qoopia connections` below. It
requires an active owner cookie, an allowed Origin and `X-Qoopia-CSRF: 1`.
It is never routed through the external MCP edge.

The installed CLI uses the existing kernel UID-authenticated owner socket,
consumes a local login capability privately and keeps its cookie in memory:

```
qoopia connections plan --root /absolute/test-installation --input /absolute/selection.json
qoopia connections apply --root /absolute/test-installation --input /absolute/selection.json --commit
qoopia connections status --root /absolute/test-installation
qoopia connections verify --root /absolute/test-installation --input /absolute/connection-id.json
qoopia connections resume --root /absolute/test-installation --input /absolute/connection-id.json
qoopia connections disconnect --root /absolute/test-installation --input /absolute/connection-id.json --commit
```

Selection JSON: `surface` (chatgpt_web, chatgpt_desktop, claude_web,
claude_desktop, codex, claude_code), `access_mode` (read or read_write),
`request_key` (stable caller idempotency identifier). An ID input contains only
`id`. Reusing the request key with another selection is IDEMPOTENCY_MISMATCH.
Apply creates a separate agent; it does not activate a vendor client or a model.
A selected server workspace returns SERVER_WORKSPACE and is never replaced.

Each connection has a stable `/mcp/c/<UUID>` resource and
`/oauth/c/<UUID>` issuer. Discovery follows RFC 9728 and RFC 8414 path rules.
Registration binds to that connection's agent and workspace, and consent checks
that binding again. PKCE is S256. Tokens are opaque, stored hashed locally, and
bound to the resource through code exchange and refresh. Older unbound tokens
remain usable on the legacy `/mcp` route for compatibility. Their next refresh
binds them to the canonical resource. New connections cannot consent through
the legacy resource. Disconnect deactivates the connection's principal and
revokes all its tokens. Other connections and the workspace are preserved.

Only `connection_verify` called through the authenticated connection can record
verification. Setup returns a ten-minute one-use challenge. This proves an
actual authenticated MCP call; the selected surface name is not a vendor
attestation. Qualification through real vendor clients is tracked separately.
A verified timestamp is historical evidence, not a current network-health claim.
New connection note_create calls require an idempotency key and reuse the
existing note idempotency ledger. The edge never retries writes.

The external edge uses a private local listener and allows only MCP and OAuth
protocol routes. Dashboard cookies and asserted user/proxy identity headers never
cross it. Only dedicated, short-lived consent cookies are allowed on
`/oauth/consent` routes. The edge preserves the consent page's CSP and frame guards.
It has a body limit and absolute upstream timeout; outages return an error.

Account-linked installations support remote human consent at `/oauth/consent`:
email/Google proof is bound to the initiating browser, then the owner explicitly
approves the prepared client. The consent never creates a dashboard session or
lends human-owner authority to a client. A short-lived account proof can be reused
for another client on the same installation, but every client still gets its own
consent. Account changes, owner-session revocation, cross-workspace/client changes,
expired sessions and foreign browser origins refuse approval. Restarting during
sign-in requires reopening the consent request; saved connection progress remains.
Without an account binding, legacy local owner consent remains available.

Schema41 pins the original origin of each connection. Turning on managed transport
does not change existing MCP URLs, issuers, discovery endpoints or OAuth audiences.
The migration uses already-issued token/consent audiences as evidence and refuses
conflicting historical origins transactionally. No memory tables are moved.

## Verification at this checkpoint

The private acceptance ledger binds every result to its source build and surface.
On runtime build 98dad33, clean Linux Claude Code 2.1.224 and Claude Web using a
clean Mac passed real OAuth, connection_verify, create, idempotent repeat and get.
Clean Linux Codex CLI 0.153.3 and clean Mac Claude Desktop 1.52386.3 completed that
sequence on 4eb899a and passed real reads after updating to 98dad33. Mac Desktop
also passed natural token expiry/refresh and normal .qoopia-connection file import.
Its installed 040997f file handler follows the updated runtime; the handler and
client-link sources are unchanged. This is not a fresh 98dad33 app-install claim.

Two separate real Qoopia accounts completed email enrollment in clean graphical
macOS and Linux. Cross-account MCP and device isolation passed in both directions.
Both signed 98dad33 artifacts and their updates were verified; Apple notarization
passed. Linux full sleep/wake, network interruption/address change within one
virtual network, full reboot and subsequent native reads passed. Mac network
interruption, full reboot and subsequent native reading passed. Mac system sleep
was refused by the VM. A separate physical Mac sleep/wake passed on signed V14:
the original process and note survived, with settings unchanged from the snapshot
immediately before sleep. This local fixture is not clean-OS or native-client
sleep evidence. Earlier interrupted-write,
rollback and reinstall reports retain their recorded build identities.

A new OAuth client-ID protocol pilot accessed the existing memory after its own
consent, without copying the database or transferring the previous client's grant.
Both grants were revoked after the test. This does not establish official catalog
availability or substitute for real vendor-client qualification.

ChatGPT Web read/add succeeded in the isolated 040997f prototype, but the client
blocked verification. ChatGPT Desktop manual read/create/repeat/get also passed
in a confirmed ChatGPT conversation against that prototype; read-only database
inspection found exactly one new note. These two surfaces remain experimental
and are excluded from the release’s complete setup qualification. No client
safety block is retried through another path, and no verified flag is set by an
operator. The tests used existing ChatGPT Pro and Claude Max subscriptions and do
not qualify other plans or client versions. The acceptance specification permits
explicitly marked unsupported combinations; release claims must match this scope.

## Managed installation transport (implementation checkpoint)

`qoopia connections network-plan` describes exposure and transit handling.
`network-start --input /absolute/method.json --commit` starts account confirmation
(`{"method":"email"}` or `{"method":"google"}`). `network-resume` continues after
confirmation, including after an installation restart. `network-status` is
read-only; `network-enable` and `network-disable` require `--commit`.
`network-devices` lists that account's independent installations;
`network-revoke --input /absolute/device.json --commit` takes `{"device_id":"UUID"}`.
The same actions are accepted by the owner API and used by the EN/RU wizard.

Registration uses the existing email-confirmed account login and PKCE proof.
A ten-minute enrollment grant is bound to a new installation public key. Signed,
audience-bound requests have one-minute lifetimes and replay-protected nonces.
The registry stores account identity, installation/workspace identifiers, device
public keys, labels, route state and revocation tombstones. It stores no memory
or device private keys. Individual tunnel secrets and signing keys stay in the
installation's private `config/transport.json` (0600); its directory is 0700.
Interrupted provisioning reconciles the same tunnel and DNS record. A retry with
another key, workspace or tunnel secret is refused. Provider failure after revoke
leaves durable revocation in effect while cleanup is retried.

The existing installed service supervises bundled cloudflared 2026.9.1. Packages
are pinned to official archive checksums and carry provenance and transitive
license text. The materials record each platform's embedded Go version, actual
module graph and replacement modules; module archives match the embedded h1
checksums. SBOM.json includes Cloudflared. Final package preparation preserves
its executable mode and tests `--version` before sealing the manifest.
No global provider credentials are included. The edge uses a unique private Unix
socket, so a crashed parent cannot accidentally expose a later listener that
reuses a TCP port. Each request checks a short-lived device lease; an expired or
revoked lease refuses before calling the local memory server. Cloudflared output
is not persisted. The supervisor retries transport connection, never MCP writes.
A healthy connector alone is not `NETWORK_ONLINE`: the public MCP address must
return its expected OAuth challenge. DNS publication is checked before handing
a new address to the installation, avoiding premature negative DNS caching.

Operator configuration on the separate account service uses
`QOOPIA_CF_ACCOUNT`, `QOOPIA_CF_ZONE`, and a protected `QOOPIA_CF_TOKEN_FILE`.
The token requires tunnel and DNS management for the operator's account/zone.
This configuration belongs only on the account server, never on end-user machines
or in source, bundles, output reports or logs. The implemented registry defaults
to 100 installations in the pilot and five per account. Its configurable ceiling
is 900 global reservations and 20 active devices per account. Revoked devices
with unfinished provider cleanup continue to occupy global capacity. A revoke
during provisioning ends access immediately and waits for that provider operation
before deletion; cleanup failures remain queued. The broker runs as one process
per registry database: in-flight provider coordination is process-local, so
multi-worker deployment is not qualified by this implementation. The public DNS names use
one label under `qoopia.ai`, compatible with the existing zone certificate.

The transport is available on all Cloudflare plans; the current documentation
lists 1,000 tunnels per provider account and 25 active replicas per tunnel.
The pilot adds no new paid subscription in this task. Operating costs still
include the existing domain, account-service hosting and confirmation email
usage; enterprise capacity/support or changed provider terms require a separate
cost decision. Increasing the registry limit does not increase the provider quota.

Sources checked 2026-09-12:
- https://developers.cloudflare.com/tunnel/
- https://developers.cloudflare.com/cloudflare-one/account-limits/
- https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/create/
- https://github.com/cloudflare/cloudflared/releases/tag/2026.9.1

Qualification: a real operator-owned test tunnel passed provisioning, private
socket forwarding, public authentication, admin-route rejection, pause,
reconnect and device revoke. It used a synthetic account proof, not a real user
email sign-in. The temporary managed tunnels were removed after testing. The
separate original `connections-test.qoopia.ai` prototype remains available for
vendor-client qualification. The macOS compiled fixture also passed the
installed UID-owner API and CLI flow; this was an isolated installation on the
current Mac, not a clean OS or a publisher-signed release.

Current remaining release gates are listed in the verification section above.
Historical protocol fixtures are retained separately from real-account evidence.

## Native client configuration

`client-plan`, `client-apply --commit`, `client-status`, `client-remove --commit`
and `client-export` take `{"id":"CONNECTION_UUID"}`. Installed local Codex and
Claude Code connections, and the macOS Claude Desktop adapter, prefer loopback; an explicit `transport: remote` uses
the installation's external address. Web clients require HTTPS. Existing
request keys retain their original connection and origin.

The installer adds one URL-only entry to the standard native user configuration,
with a private backup and an ownership receipt. It preserves unrelated settings,
refuses modified/linked paths, and removes only its own unchanged entry. It does
not write OAuth tokens, model credentials or transcript hooks. Native OAuth login
and an actual MCP verification call remain required. CODEX_HOME and
CLAUDE_CONFIG_DIR are captured at service startup, or an explicit config_directory
selects the profile. The receipt resumes that exact path; a different explicit
selection is refused. Repeating removal of an already removed entry succeeds,
while a newly recreated external entry is preserved.

A server workspace exports a nonsecret `.qoopia-connection` file. On macOS Qoopia
previews its address and binds approval to the exact selection digest. CLI import
uses `client-link --file ABSOLUTE_FILE`, then `--commit --approve PLAN_DIGEST`.
The imported connection does not change the user's selected Qoopia workspace.

Offline EN/RU instructions and agent instructions ship at the bundle root as
`connections-guide-en.html`, `connections-guide-ru.html`, `connections-agent.md`.
The local wizard links to both manuals. Updated Claude documentation (2026-09-12)
allows one custom remote connector on Free; organization-owner controls still
apply to Team and Enterprise. Real-account qualification remains separate.


## Claude Desktop on macOS

The native adapter uses stdio to forward MCP tools to the selected connection URL.
It never opens the memory database. A stable private launcher follows current.json
across installation updates; a server-only selection uses the app executable.
The native configuration stores the launcher command, without OAuth tokens.
Per-connection credentials live separately in a private 0600 file, with an OS-backed
lock to serialize refresh across adapter processes. Linux can export a setup file
for a Mac; local Claude Desktop on Linux is not advertised as supported.

After client-apply, client-auth-start prepares a ten-minute OAuth browser handoff.
The owner API returns a safe open_url; client-auth-status resumes the pending
handoff or reports credential presence. The CLI requires --commit to start it.
For imported files, client-link returns binding_file and authentication_argv;
client-auth --file BINDING --commit --open performs the same consent flow in a
foreground command. Restarting an interrupted authorization generates fresh
state and PKCE while retaining its DCR registration. Saved OAuth is still not a
verified client call. Restart Claude Desktop and run the one-use verification
prompt from a real conversation. Per-client revocation cancels a pending wizard
handoff and denies both existing access and refresh.

The installed synthetic browser test uses local owner recovery because its owner
has no real account binding. An unlinked owner sees the account sign-in screen
after page reload and can use local recovery again. This test is not evidence for
the email/Google account path. Later real-account Desktop and file-open checks are recorded in the verification
section above; they do not relabel this earlier synthetic fixture.
