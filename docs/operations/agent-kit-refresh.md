# Instruction kit updates

Native linked Codex and Claude Code profiles refresh the managed kit at SessionStart using the installed Qoopia binary. No model or credential changes are needed. The installer preserves the steward role and surrounding user instructions, backs up managed changes, refuses edited files and never downgrades a newer kit. A refusal is returned in hook context without interrupting continuity capture.

`qoopia instructions refresh` previews registered profiles in the selected installation root; `--commit` applies. Invalid receipts and edited documents are reported as refused, never silently counted as current. Exit status is nonzero when any profile is refused. Containers must run the command as the profile owner. A newer server alone cannot update an older binary on another machine: deliver the signed package and update the hook executable through the existing installation before claiming fleet coverage.

MCP-only clients get the current protocol through `qoopia_protocol`; they do not expose local files for refresh. Read `qoopia_capabilities.protocol.revision` on the selected connection. Updating files does not prove an already-running model reread them. Confirm the revision from a fresh session or an explicit protocol read; do not restart unrelated agents or change their memory policies.

Release acceptance: upgrade a managed old revision with its original receipts, preserve a steward and user edits, refuse downgrade, verify automatic refresh at SessionStart, inspect actual deployed health and sample a real protocol read. Report installed versus loaded separately. Family agents intentionally outside Qoopia stay excluded.
