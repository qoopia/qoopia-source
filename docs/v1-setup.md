# V1 first launch

The normal path is the signed application, then browser setup: Google/email → confirm the new email → Memory → select and authorize your own Claude or ChatGPT subscription → Check connection → connect your native client. On Mac, open the downloaded `.qoopia-memory` file with Qoopia. On Linux, run `./qoopia memory-link --file /absolute/path/to/connection.qoopia-memory`. Codex requires one native `/hooks` trust review. Existing unrelated hooks and MCP entries are preserved with backups.

The bundled semantic model runs locally; subscription authorization is separate from the Qoopia email identity. Browser-only MCP still works for memory tools but does not expose the complete transcript or native lifecycle. See [Memory in V1](MEMORY-V1.md).

An existing server can be selected once with `qoopia use-server --url https://YOUR-SERVER --commit`. This selects the data location; it does not synchronize two databases. Owner-approved server onboarding must already bind the hosted installation's owner.

## Advanced diagnostic dispatcher

The following describes the older read-only CLI dispatcher, not the ordinary application onboarding UI. General agent task dispatch is not a requirement of the current memory-focused V1.


`qoopia setup [--runtime codex|claude_code] [--root ABSOLUTE_DIRECTORY]` is a read-only, resumable dispatcher. It writes no setup state. Each invocation derives the next stage from the installed `current.json`, the current generation database's owner bindings and OAuth client connections, and, with `--runtime`, installation-local runtime selections and non-secret connect receipts.

It returns JSON in `qoopia-setup-status/1` format with `stage`, `detail`, and at most one `next_action`.

## Stages

- `INSTALL_REQUIRED`: run the emitted existing `qoopia install` command.
- `OWNER_BOOTSTRAP_REQUIRED`: run the emitted `qoopia start` command. The running server then gives the local-TTY `owner-login --owner-name NAME` action; setup cannot impersonate or bootstrap an owner.
- `OWNER_SELECTION_REQUIRED`: multiple owners exist, so a later connect must explicitly select an owner. Setup does not disclose identifiers.
- `CONNECTION_REQUIRED`: no OAuth client connection exists for the sole owner. Run `qoopia open` and choose Connections, or, while Qoopia runs, `qoopia connections plan --input ABSOLUTE_SELECTION_JSON` and then `apply --commit`. Each client gets its own revocable OAuth connection; no API key is written into client files.
- `CLIENT_CALL_REQUIRED`: a connection waits for its first authenticated call. `qoopia connections status` shows its MCP URL and the step to finish in that client.
- `CLIENT_CONNECTED`: a client connection is verified; there is no next action.

`--runtime codex|claude_code` selects the legacy native runtime path instead (an installation-local runtime package and a `connect` receipt that stores a scoped API key in the client config):

- `RUNTIME_PROVISION_REQUIRED`: run the emitted existing provision preview, review it, and explicitly apply its saved plan and digest.
- `CONNECT_REQUIRED`: run the emitted existing connect preview while the service is stopped. A sole owner needs no manual owner ID. Defaults are `~/.codex/config.toml` and `~/.claude.json`; connect still enforces private ownership and permissions.
- `LIVE_QUALIFICATION_REQUIRED`: a structurally valid receipt matches the selected runtime and exact current installation generation. Start Qoopia, complete the runtime's own subscription login if requested, and run a real task; this stored-state check is not live readiness.

Rerun `qoopia setup` after each approved action. Interrupted runs resume from durable product state and do not create duplicate principals or configuration because setup itself never mutates them.

## Safety boundary

Setup never performs login, browser opening, model invocation, service start, network access, provisioning, connect apply, or credential reads. It reads only bounded, regular, non-linked installation JSON and the owner count and OAuth client connection states in the current database. There is deliberately no `READY` stage: after `LIVE_QUALIFICATION_REQUIRED`, the user must start Qoopia, complete runtime subscription authentication if needed, submit a real task, confirm its result, then close/reopen and confirm later-session context. Those live/model/user-journey steps remain manual release acceptance.
