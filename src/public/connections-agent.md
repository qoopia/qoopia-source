# Qoopia Connections — agent instructions

Use the installation holding the explicitly selected workspace. Do not replace a
selected server with a local database. Memory stays on that installation; account
registration and tunnel metadata are separate. The release qualifies the tested
Codex CLI, Claude Code, Claude Desktop and Claude Web combinations below.
ChatGPT Web/Desktop remain experimental; their complete setup verification is
not qualified. Record real client, version, plan and clean OS evidence separately.

1. Open the installed Qoopia wizard with `qoopia open`, or use the running
   installation's `qoopia connections` CLI. `--root /absolute/directory` selects an
   isolated installation; omitting it uses the platform's installed root.
2. Save a selection JSON with `surface`, `access_mode` and a stable `request_key`.
   Surfaces: `chatgpt_web`, `chatgpt_desktop`, `claude_web`, `claude_desktop`,
   `codex`, `claude_code`. Access: `read` or `read_write`. `read_write` permits
   adding new memory records; it does not expose `note_update` or `note_delete`.
   Do not switch to another connection when a tool is unavailable. Optional `transport` is
   `auto` (default), `local` (native HTTP clients on the installation machine),
   or `remote`. Run `connections plan --input /absolute/selection.json`, then
   `connections apply --input /absolute/selection.json --commit` when authorized.
   Preserve the request key after ambiguous results; check `status` before retrying.
3. For cloud clients, use `network-plan`, then `network-start --input
   /absolute/method.json --commit`, with `{"method":"email"}` or `google`.
   Hand the account sign-in to the human. Use `network-resume` afterwards. An
   unavailable registry or offline machine is not an empty memory database.
4. Supply the prepared MCP URL to the chosen client's supported OAuth setup.
   Never copy API keys, cookies, refresh tokens or provider credentials into chat,
   command arguments, logs or client configuration. New connections use PKCE and
   fixed per-connection OAuth audiences. MCP access does not authorize a paid
   background model or automatic transcript collection.
5. For Codex / Claude Code, or Claude Desktop on macOS, on an installed workspace, `client-plan` and
   `client-apply --commit` take `{"id":"CONNECTION_UUID"}` via `--input`. These add
   an independently named entry and preserve unrelated settings. Codex and Claude Code use a URL; Claude Desktop uses a private local stdio adapter. For a
   client on another computer, use `client-export`, save its `binding` to a
   `.qoopia-connection` file, and open it with Qoopia there. CLI import:
   `qoopia client-link --file /absolute/file.qoopia-connection` previews;
   `--commit --approve PLAN_DIGEST` applies exactly that reviewed binding.
6. Finish the client's own OAuth login. Codex supports `codex mcp login NAME`;
   Claude Code uses `/mcp` to authenticate. Respect plan, organization and OS
   restrictions. For Claude Desktop, use `client-auth-start --commit` with the same
   connection id, give its `open_url` to the human and use `client-auth-status`.
   The dashboard uses these same actions. After a file import, run the returned
   `authentication_argv`, or `qoopia client-auth --file BINDING_FILE --commit
   --open`. Keep that command running while the human approves.
   `client-auth-status --file BINDING_FILE` reads safe credential presence.
   A pending handoff lasts ten minutes; after restart, start a fresh handoff.
   Restart Claude Desktop after approval and verify in a real conversation.
   Saved OAuth credentials alone are not client qualification.
7. `connections verify --input /absolute/id.json` returns a one-use, ten-minute
   prompt. Run it inside the selected real client. `status` / `resume` preserve
   progress. `CLIENT_CALL_VERIFIED` is evidence of an authenticated call, not
   proof of current network reachability or a cryptographically attested vendor.
8. `connections disconnect --input /absolute/id.json --commit` revokes only that
   client. `client-remove --commit` removes only its unchanged, Qoopia-owned local
   config entry. `network-disable --commit` pauses external access;
   `network-enable --commit` reconnects. `network-devices` lists account devices;
   `network-revoke --input /absolute/device.json --commit` takes `device_id` and
   revokes the installation route without deleting local memory.

Stable top-level states: `ready`, `requires_user_action`,
`temporarily_unavailable`, `unsupported`, `error`. Read the `code` and
`next_action`. Configuration presence and historical client proof are separate
from transport health. For write interruptions, retry only with the same
idempotency key and identical payload; never blindly repeat a non-idempotent write.

Do not submit catalog applications or claim release acceptance from custom MCP
harnesses. Record exact OS, client version, plan, real OAuth/read/write results,
revoke/refresh/outage behavior and remaining limitations.

Native profile selection: client-link honors CODEX_HOME / CLAUDE_CONFIG_DIR in its environment. An explicit --config-directory ABSOLUTE_DIRECTORY selects another client profile. Owner API client-plan/client-apply/client-status/client-remove accept config_directory. A service can capture these variables when launched directly; if its desktop environment does not provide them, pass config_directory explicitly. The receipt remembers the exact selected file on subsequent resumes; a different explicit selection is refused. File-import plan_digest binds the target configuration path as well as the URL and permissions. No client directory is taken from an untrusted connection file.

SIGN_IN_REQUIRED during network registration means its ten-minute account confirmation or registration grant expired. Start network-start again and complete consent. Qoopia keeps the installation identity and reconciles an existing provider device; it does not create a replacement database.

The Claude Desktop adapter is a private OAuth client on macOS. Its stdio process forwards scoped MCP tools to the selected URL; it does not open a memory database. Remote memory still needs the server’s reachable external address. Tokens stay in the installation’s private client-configs directory, outside the native client configuration and exported setup file. Per-connection revocation stops access and cancels an active wizard sign-in; removing a native entry alone does not revoke its grant. The stable launcher follows current.json after an update. Actual Claude Desktop 1.52386.3 has passed local memory calls, natural token refresh, file import and reading after a full guest OS reboot. Signed candidate updates preserve its configuration. Those observations do not qualify every desktop version or full macOS sleep recovery; keep build-specific evidence separate.

For isolated Codex CLI acceptance with an existing ChatGPT subscription, a separate CODEX_HOME does not isolate account-level cloud connectors. Disable `features.apps`, `features.plugins` and `features.multi_agent` for the test invocation, then verify every recorded MCP call used the exact prepared server name. Never use a similarly named existing connector as a fallback.

Qualification checkpoint (12 September 2026): clean Linux Codex CLI 0.153.3 and Claude Code 2.1.224, clean Mac Claude Desktop 1.52386.3 and Claude Web have passed actual scoped memory calls. Existing subscriptions were ChatGPT Pro and Claude Max; other plans are not qualified by these tests. ChatGPT Web read/add passed only in the isolated prototype; its verification was client-blocked. ChatGPT Desktop manual read/create/repeat/get also passed in a confirmed ChatGPT conversation against that prototype, with exactly one new note in the test database. The same app can open Codex tasks: choose New chat → Chat and verify the conversation type; the sidebar name is insufficient. Neither ChatGPT surface is a fully qualified setup path for this release. Physical Mac sleep/wake passed on a signed V14 isolated local installation, preserving the process, note and settings captured immediately before sleep; this does not convert the refused VM sleep into a pass. Do not retry a client safety block through another path or record it as a successful verification.

Native session memory profiles: `memory-link --file ABSOLUTE_QOOPIA_MEMORY --config-directory ABSOLUTE_PROFILE` selects the local client profile explicitly; otherwise a new binding honors CODEX_HOME / CLAUDE_CONFIG_DIR. Hooks, MCP configuration and the allowed transcript root all use that selection. A later invocation without an override resumes the recorded profile. A different explicit selection is refused for an existing binding; use a separate Qoopia `--root` for a separate client binding. Do not copy hooks to another profile or edit native_root manually. Review/trust hooks in the selected client, then verify capture and restoration in real sessions. These capabilities require a package containing this change; V16 RC1 (425a3e1) does not support the profile option for memory-link.

Local primary agent: after connecting the intended native memory client, stop the local Qoopia service cleanly and use the installed binary's `steward` command. It lists only active agents in the selected local owner's workspace, without keys or notes. `steward --agent-id ID` previews the permission change; `steward --agent-id ID --commit --approve PLAN_DIGEST` applies that exact plan. If several owners exist, pass `--owner-id ID`. It refuses another workspace, revoked/human/read-only identities and replacement of an existing steward. Restart Qoopia and reconnect the client afterwards. Verify the selected agent in Connections and with actual memory calls. This assigns a workspace role to the connected agent; it does not create a background AI process or grant human-owner authority. The existing tool profile remains in force. This command requires the new candidate; V16 RC1 does not include it.


## Versioned instructions for every connected agent

The installed bundle includes `agent-guide/qoopia-protocol.md`, `SOUL.md`,
`MCP-CONNECTIONS.md`, `OPERATIONS.md` and a manifest pinned to the package source.
`qoopia agent-guide --section protocol|connections|operations|soul` reads the same
embedded kit without opening memory or starting a model.

Native Codex/Claude Code connection apply and memory-link install the shared
`qoopia-protocol.md` into the selected native profile. They add an owned block to
the active global AGENTS.md/AGENTS.override.md or CLAUDE.md, preserving unrelated
instructions. Edited Qoopia blocks or foreign documents are refused; inspect the
conflict instead of overwriting it. Rerun the authorized native connection apply
or memory-link with the current package to refresh an existing profile's kit.
An instruction install is NOT_VERIFIED until a real new native session reports
its loaded source. Project overrides, limits and client trust can affect loading.

Cloud ChatGPT/Claude and Claude Desktop do not automatically read native profile
files. Their selected MCP connection exposes the read-only `qoopia_protocol`
tool and initialization guidance. Read it before the verification challenge; use
its connections section for reconnecting. Where supported, pin the instruction
to read it in that client's own project instructions. Do not claim a local config
file was installed into a cloud account. A blocked client remains BLOCKED.

Managed My Qoopia agent receives the same protocol plus its SOUL and operations
runbook, with an explicit installation pointer. Generic native clients retain
their existing role; installing these documents never promotes them to steward.
