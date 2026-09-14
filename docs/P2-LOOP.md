# P2: local skill loop

## Current local review target (2026-09-05)

Local freeze only; no new native qualification is authorized by this document update. Current safe summaries and fingerprints: `artifacts/p2/local-review-target-snddb5mk/`; see `P2-EVIDENCE.md` for historical/current separation.

Leo's latest mechanical `leo-subscription-gates-dq23ow0k` has **7/7 exit 0**, **997 tests pass / 0 fail / 5367 assertions / 97 files**. Codex's fresh `leo-p2-codex-seatbelt-e85p16yn/qoopia-p2-qualification-VuGvE9` completed initial/update/rollback with correct artifacts and valid JSON/JSONL (13 events each), exact frozen version/update/rollback and three strict **unknown** outcomes. Claude's final `leo-p2-sandbox-f2h4h6z9/qoopia-p2-qualification-goBEAP/audited-outcomes.json` matches read-only SQLite: three **succeeded**, revision 2, stale=false. Its older redacted trace envelopes are still malformed; audit/DB facts must not be described as fresh trace replay.

Owner amendment in authoritative `../spec/QOOPIA-UNIFIED-TZ.md` §20: manual VoiceOver/screen-reader happy path is **NOT RUN — excluded by owner**, not PASS, not a remaining P2 gate and not automatically moved to P3/P4. Existing labels, keyboard navigation, focus and basic UI/state checks remain. Independent UI transcript: `artifacts/p2/leo-ui-readiness-rerun-01/transcript.json`.

The approved Codex test route is the existing `artifacts/p2/codex-seatbelt-bookkeeping-1x2vyims/run-leo.py` opt-in `--outer-seatbelt-only-with-bookkeeping`: one verified outer Seatbelt per native child, explicit approval never, selected subscription store, gpt-6-astra/high. Only selected-store literal installation_id and subpath tmp/arg0 writes are excepted; auth/config/skills and parent writes remain denied. The ordinary launcher defaults are unchanged. Outer enforcement is not a per-run write audit and cannot establish zero outside-root writes. Missing parents, auth refresh requiring wider permission or failed enforcement remain blockers; no implicit widening.

This Codex qualification prompt additionally requests direct writes inside the assigned task directory, no shell heredoc/external temporary files, recovery only through an allowed direct-write method, and JSON existence/parse verification before completion. The exact clarification is bound into immutable objective/request hashing. No expected answers are supplied, and evaluator checks/frozen skill bytes are unchanged.

Codex model attestation remains unknown; configured-profile functional progress never upgrades strict outcomes. User-skill provenance, isolated auth-source preflight, actual OS write audit and independent phase review caveats remain. No final verdict or P2 DONE. The command reference below documents existing capabilities, not a new instruction to run paid tasks.

This is an isolated implementation, schema 37 on P1 schema 36. Deployment, production migration and installer work are outside this change. Use the existing dashboard login → Skills. Capture a repeatable procedure (or the labelled synthetic CSV sample), edit its inputs/steps/verification/refusal/rollback, compile, inspect before/after plus the final native bytes/member map/license/renderer, accept, select an enrolled configured runtime and assign. Runs show their exact version and append-only outcomes. Revision creates another candidate; choosing a previously assigned version with Rollback creates another assignment revision. There is no manifest editor or unpack step.

The native adapter is a local operator process. The same authority registry serves REST, MCP and CLI. Human owner mutations are excluded from model tools. Reporter tools do not grant memory writes or owner rights. `skill_feedback` is participant self-report; `skill_outcome` evaluates authenticated artifact reports. Neither is independent reputation. Scores are revisioned per actor/run/version, with one latest eligible vote and zero independent reputation weight.

## Boundaries and stored facts

- `skill_assignments` is desired state; immutable `skill_assignment_revisions` preserve decisions. Assignment changes take effect at the next native session. Each `session_loadout_entries` row pins candidate, package, member-map projection and renderer digests plus its exact grant snapshot. A session has its own frozen native skills directory; each attempt gets a new disposable HOME and temp directories; explicit subscription-store auth may select a native login context as described below. Reopen returns its original generation, not the latest assignment.
- A current owner epoch, active target/reporter, expiry, exact review, current assignment pause/revoke and version revoke gate every managed projection/launch, including replay. The old snapshot remains history. Explicit owner assignment grants only that version's frozen native bytes to the target; it grants no general private draft/source access.
- SQLite remains the canonical package/blob store. Candidate bytes, version reference, command, audit and outbox commit in one existing transaction. There is no additional CAS service or alternate package writer. The session's outbox row is claimed with an attempt fencing token, 30-second lease, 8-attempt/15-minute ceiling and bounded backoff. The local adapter holds the canonical transaction across the synchronous filesystem transaction and rechecks permission/lease before swap. There is no scheduled autonomous installation daemon in P2.
- The native ledger records installation/runtime, skill/version, operation/epoch and the complete per-file SHA-256/size map. Local SQLite OS locks coordinate writers. Stage → durable intent → old rename → new rename → readback → durable ledger → owned backup cleanup recover whole old/new directories. Removal keeps a fencing tombstone. Same-name unowned files require adoption preview; drift and links refuse destructive replacement. Edited files and neighbours survive cleanup.
- Only exact versions Codex `0.153.3` and Claude Code `2.1.224` are in the adapter matrix, for darwin-arm64/linux-x64. Unknown versions/unsupported OS refuse before projection. Linux runtime qualification is NOT RUN. Network/shared filesystems are unsupported. SIGKILL on this local macOS filesystem was tested; hardware power-loss durability is NOT RUN.
- Native `SKILL.md` frontmatter is compiled by `qoopia-native-markdown/1` before review. Local acceptance uses one human review and an ephemeral one-package Ed25519 attestation (private key never saved). This is labelled local acceptance, not an original author's signature or independent review. P1 package vectors/legacy signatures remain unchanged.
- Ordinary native permission mode and sandbox remain at defaults. The explicit Codex outer-Seatbelt exception is described above; the Claude qualification opt-in below preapproves only its generated task directory; no global approval, bypass, fallback model or global config copy is used. Managed launch checks are online; direct native launches and instructions already in context cannot be revoked reliably. Capability fields explicitly state no enforced direct-launch authorization/revocation, no safe cancellation, no hot reload and no offline grant. High-risk activation refuses even after consent when this enforcement is unavailable.
- `projection_readback`, `runtime_receipt`, `observed_execution`, `closed`, and evaluated outcome are separate facts. Final text or a marker is not native execution. Native parser recognition is deliberately conservative: unrecognized/wrapped command traces remain unobserved. A started run with no report stays unknown and is never automatically rerun after a crash. Late outcomes supersede a prior fact without rewriting it, and carry the current revoke overlay as `stale`.
- The CSV evaluator is bound before launch. Expected category counts/totals, invalid-input refusal and absent invalid summary are checked against actual artifact bytes, independently of exit 0. Managed-neighbour hashing does not prove the entire OS had no writes. Without external native-sandbox/OS write audit the outcome remains unknown. The optional finalizer checks a Leo-supplied trace hash and records the reviewed audit assertion; it does not itself collect or interpret an OS trace.

## Operator commands (disposable/local roots only)

Existing onboarding enrolls the target and its reporter. Configure the exact runtime using `qoopia runtime configure --input request.json` through the shared authority schema. Owner binds an explicit existing directory with `qoopia runtime bind --runtime-id ID --root ABSOLUTE_DIRECTORY`. The API key must belong to the current owner. Reporter uses:

```sh
bun src/cli.ts runtime start --runtime-id ID --native-session NATIVE_REF --session-id QOOPIA_SESSION_ID
bun src/cli.ts runtime sync --loadout-id LOADOUT_ID
bun src/cli.ts runtime run --loadout-id LOADOUT_ID --entry-id ENTRY_ID --csv SYNTHETIC_CSV --auth-mode subscription --model gpt-6-astra --effort high
# For a Claude Code loadout use --model claude-opus-5 instead.
bun src/cli.ts runtime cleanup --loadout-id LOADOUT_ID
```

`run` is an explicit paid native invocation; the builder did not run it. Native permission refusal is evidence, not a reason to add bypass flags. Cleanup refuses unclosed attempts; reconcile actual termination before reporting closure. A closed or revoked session's projection is not reused as a new session.

Owner-only adoption is local, with no remote arbitrary-path endpoint:

```sh
bun src/cli.ts runtime adopt-preview --runtime-id ID --target RELATIVE_NATIVE_SKILL_DIRECTORY
bun src/cli.ts runtime adopt --runtime-id ID --target RELATIVE_NATIVE_SKILL_DIRECTORY --preview-digest SHA256 --skill-id ID --version-id ID --idempotency-key KEY
```

Review the complete file map before the second command. It takes ownership of unchanged bytes only. A subsequent reviewed assignment is separate. Use `skill import-review --input request.json` for archived P1 import scope/history and `skill import-resolve` for the explicit original-agent-to-selected-runtime decision. `agent` scope cannot widen to project/fleet; historical approval never silently becomes executable authority. Imported native drafts and legacy skill identities can receive a new canonical draft/candidate without rewriting original versions.

## Explicit native authentication and model evidence

Every local `runtime run` requires `--auth-mode`, exact `--model` and `--effort`. The qualifier accepts distinct `--codex-model/--codex-effort` and `--claude-model/--claude-effort`; no shared model or implicit billing/model fallback. Auth mode, selected backend/directory, model and effort are bound in the immutable evaluator and environment digest before spawn. Real tokens are never options, arguments or stored evaluator fields.

| Explicit mode | Selected authentication | Failure behavior |
|---|---|---|
| `subscription` | Existing operator-provided `CODEX_ACCESS_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`, CLI environment only | Missing selected env refuses; API keys do not substitute |
| `subscription-store` | Explicit backend below; official CLI itself reads the selected existing login context | Metadata/isolation/version/status failure refuses; no discovery, login, copy, symlink or fallback |
| `api-key` | `CODEX_API_KEY` (legacy `OPENAI_API_KEY` only here) / `ANTHROPIC_API_KEY` | Explicit API billing; never a subscription qualification substitute |

Store selectors for local `runtime run` are `--login-backend` and optionally `--login-store`. Qualification prefixes them with `--codex-` or `--claude-`. No ambient HOME/CODEX_HOME/CLAUDE_CONFIG_DIR is selected automatically. Paths must name existing canonical, operator-owned directories without symlink aliases. The adapter checks metadata, never reads or lists credential/profile contents.

- **Codex `file` or `keyring`** requires `--codex-login-store ABSOLUTE_EXISTING_CODEX_HOME`. This selects the native backend, not `auto`; keyring identity is still scoped by that selected CODEX_HOME. `exec --ignore-user-config` preserves auth there. Fresh HOME/XDG, project Git boundary, `--ignore-rules`, `project_doc_max_bytes=0`, disabled hooks/plugins/apps/multi-agent/memory/bundled skills and **`skills.include_instructions=true`** retain frozen project discovery. Pinned 0.153.3 still discovers legacy `$CODEX_HOME/skills` even when user config is ignored. In strict mode, if that entry exists (including a dangling symlink), this route refuses without scanning/modifying it. There is no proven wildcard exclusion. A typical populated Codex profile therefore remains blocked; do not rename/delete skills, copy credentials or create a new login to make qualification pass.
- **Additional Codex status constraint:** `login status` does not offer `exec`'s `--ignore-user-config`; its configuration loader can import profile settings. Before this command, an existing selected `config.toml` causes explicit refusal without reading it. This does not mean `exec` loses auth with ignore-user-config; it means the prerequisite isolated auth-source check is unavailable for that context. An already existing operator-selected store without these customization entries can use the route. Native auth status must be exactly the ChatGPT result; it is not proof of quota, plan tier or actual model.
- **Claude `config-dir`** requires `--claude-login-store ABSOLUTE_EXISTING_CLAUDE_CONFIG_DIR`. The selected context must correspond to an already authenticated namespace. `--setting-sources project` excludes user settings/skills/commands/agents/plugins; frozen `.claude/skills` stays discoverable. Global auth/account metadata can still be read by the official CLI in the selected config directory. Strict empty MCP config, disabled hooks/memory/connectors/bundled skills/doctor/background installs, disabled CLAUDE.md discovery and limited built-in tools exclude the remaining customization surfaces. No `--safe-mode`, `--disable-slash-commands`, `--bare`, manual skill injection or permission bypass.
- **Claude macOS `default-keychain`** has no `--claude-login-store`. It explicitly selects the official default OS keychain namespace by leaving `CLAUDE_CONFIG_DIR` unset, with HOME/XDG still disposable. This supports ordinary default login without copying credentials or reusing real HOME. Setting CONFIG_DIR even to the ordinary directory instead selects a hashed keychain namespace; do not guess those are equivalent. No undocumented secure-storage override is used. Locked/missing/incompatible keychain or auth metadata fails closed. Other OSes refuse this backend; use an already authenticated explicit `config-dir` where supported.

Before a strict store-mode model spawn, the official CLI version must match the pinned matrix, then its native **status** command must identify subscription auth. The application captures that output only in memory and returns a boolean/small safe status, never raw status, email, org or key fragments. Claude requires logged-in `claude.ai`, first-party provider, known subscription type and no API key source; a managed API key is rejected even when labelled `claude.ai`. Unknown metadata is not PASS. Status commands do not invoke a model or start login. All status/version probes have time/buffer limits. The version probe uses disposable config, not the selected login directory.

Fresh task/session HOME and the frozen Git/project boundary remain for all modes. Parent/session customizations refuse, every project slot must be frozen in this exact loadout, and consent/current grant/revocation checks remain. Native permission mode/sandbox stay at defaults; the task-write opt-in below adds only a per-attempt path rule. The CLI environment is an allowlist: ambient API/OAuth/proxy/helper/plugin settings never enter store mode. Launch env is non-enumerable; output uses the existing P1 redactor (plus exact supplied-token scrub in env modes). Application output filtering is not proof against a hostile runtime/OS process inspection, and raw native status/debug logs must not be captured externally.

**Vendor side effects:** reuse is not a zero-write contract. Official CLIs may refresh/write OAuth state in the selected file/keychain and update caches, logs or auth/account metadata. `--ephemeral` / `--no-session-persistence` do not prohibit all such writes. Codex forced-login enforcement can log out a mismatched store; the prerequisite status rejects an already mismatched store, but concurrent store changes or mandatory policy may still trigger vendor enforcement. Do not switch the selected login concurrently, and stop if that side effect is unacceptable. The application never calls login/logout/refresh helpers or changes global configuration. Leo must distinguish credential/cache writes by the official CLI from task writes in the outside-write audit; do not blanket-approve the selected profile. The builder has not accessed actual stores or invoked native auth status/model tasks.

The env route remains separately supported. Claude requires an already supplied compatible subscription OAuth token. Codex `CODEX_ACCESS_TOKEN` is a vendor personal access token/agent-identity credential, not a generic cached ChatGPT OAuth token; it must be compatible with the account's entitlements. This work never obtains or creates one. The new store route does not depend on that env mechanism.

Actual model evidence is separate from request flags. Claude requires complete, matching-session assistant response `message.model` metadata plus a successful result; any other observed/usage model is a mismatch. Init metadata, model self-report, subagent or partial streams cannot pass. **Codex 0.153.3 `exec --json` has no actual-model field**, so its evidence stays `unknown` even if artifacts are correct. The offline outside-write finalizer reuses this immutable model check and cannot turn unknown/mismatch into success. A vendor-supported transport/version exposing actual response model metadata would need separate implementation/qualification; defaults or requested flags are not a substitute.

Mandatory managed policy still outranks CLI settings. Known Claude system managed-settings/MCP files and Codex system config/requirements/managed-config/skills cause a refusal without reading or modifying them. MDM and remote organization policy cannot be proven absent by disposable HOME; Leo must use an authorized environment/account with no unrelated mandatory hooks/MCP/config. If policy injects them or conflicts with subscription/model/tool restrictions, qualification is blocked; do not disable that policy. Account quota, availability of the exact requested models and default-permission CSV writes are also live gates. Effort `high` is explicitly requested and bound, not claimed as independently observed reasoning effort.

Official sources and pinned implementation details: [store-route trace](../artifacts/p2/native-login-store-01/TRACE.md) and [prior env-route trace](../artifacts/p2/native-subscription-01/TRACE.md).

## Operator command reference (no new qualification during freeze)

UI independently passed in `artifacts/p2/leo-ui-readiness-rerun-01/transcript.json`. Latest full mechanical gates: `artifacts/p2/leo-subscription-gates-dq23ow0k`, 997/0 and all seven gates exit 0. Existing mechanical rerun command (new evidence directory, no native model calls):

```sh
python3 artifacts/p2/native-subscription-01/run-checks.py --full
```

Run from this worktree. Every qualifier invocation creates a new disposable fixture/projection beneath `/private/tmp`; it does not bind the login directory as a managed task root. **Exit 2 is deliberate, NOT ACCEPTED**, even for successful prepare/auth-only commands. Inspect `results.json` status/reason and `auth_preflight`; do not interpret exit 2 alone as an unexpected failure. Do not use `--execute-real-native` during preflight. The builder has NOT RUN real status or task commands.

Claude macOS default subscription namespace, prepare-only (no native CLI call):

```sh
bun scripts/p2-qualify-native.ts --root /private/tmp --runtime claude_code --auth-mode subscription-store --claude-login-backend default-keychain --claude-model claude-opus-5 --claude-effort high
```

**Leo only**, native status preflight, no model task/new login. These are read-only status operations at the command level, not a guarantee of no vendor cache/refresh writes. No raw auth output is persisted. The Codex placeholder must be replaced with Leo's explicitly selected already-existing canonical path; no directory scan or secret extraction is needed:

```sh
bun scripts/p2-qualify-native.ts --root /private/tmp --runtime claude_code --auth-mode subscription-store --claude-login-backend default-keychain --claude-model claude-opus-5 --claude-effort high --preflight-native-auth
bun scripts/p2-qualify-native.ts --root /private/tmp --runtime codex --auth-mode subscription-store --codex-login-backend file --codex-login-store /EXPLICIT/EXISTING/CODEX_HOME --codex-model gpt-6-astra --codex-effort high --preflight-native-auth
```

For an existing nondefault Claude namespace, replace `--claude-login-backend default-keychain` with `--claude-login-backend config-dir --claude-login-store /EXPLICIT/EXISTING/CLAUDE_CONFIG_DIR`. For Codex already using native keyring, select `--codex-login-backend keyring`; no automatic file/keyring selection. Do not copy tokens to construct a qualifying directory, rename unrelated profile entries, set real HOME, export secrets or turn on debug/shell tracing. Check organizational/MDM policy independently, without disabling it. Use pinned official binaries on PATH.

**Leo only, paid qualification after inspecting preflight/blockers and side effects:**

```sh
bun scripts/p2-qualify-native.ts --root /private/tmp --runtime claude_code --auth-mode subscription-store --claude-login-backend default-keychain --claude-model claude-opus-5 --claude-effort high --execute-real-native
bun scripts/p2-qualify-native.ts --root /private/tmp --runtime codex --auth-mode subscription-store --codex-login-backend file --codex-login-store /EXPLICIT/EXISTING/CODEX_HOME --codex-model gpt-6-astra --codex-effort high --execute-real-native
```

These exact models are distinct. Claude uses `second.csv`; Codex uses `first.csv`. **Codex auth preparation is implemented independently of model attestation:** exec's missing actual-model event does not stop preparation/status, but a strict paid attempt cannot pass final model acceptance and the strict wrapper stops after that first unverified task. The separately opted-in configured-profile functional mode below can progress without attesting the model. A model flag or auth status will never turn `actual_model=unknown` into verified. No app-server/proxy or fallback route is introduced.

For an already supplied env credential, the prior explicit `--auth-mode subscription` still works without login-store/backend options. API billing is separately `api-key`; it must never be used to turn subscription qualification green.

Each runtime gets its own canonical fixture DB, current consent/assignment, frozen projection and CSV. The wrapper attempts initial/revision/rollback (maximum three tasks per selected runtime), stopping after a failed/unobserved/model-unverified run in strict mode; the explicit functional exception below changes only its Codex unknown-model progression gate. No retries or fallback. Permission refusal remains a blocker. Completed attempts still need outside-write evidence; `results.json` is never a blanket PASS.

Collect native-sandbox or OS write trace evidence for each run. An audit JSON array for `scripts/p2-finalize-outcomes.ts` requires `run_id`, `runtime`, `outside_writes` (`none`/`detected`/`unknown`), `method` (`native_sandbox_trace`/`os_write_trace`), `trace_file` and SHA-256 `trace_digest`. A reviewed assertion is required; a missing trace is not evidence of no writes. Use only the generated disposable qualification root:

```sh
bun scripts/p2-finalize-outcomes.ts --root /private/tmp/qoopia-p2-qualification-EXACT --audit AUDIT_JSON
```

Current native/audit results are in the current review-target section above. Builder native execution remains NOT RUN. Manual screen-reader status is NOT RUN — excluded by owner. Independent phase review is pending; no P2 DONE claim.

## Claude qualification: explicit task writes

Owner-authorized `--allow-claude-task-writes` applies only to Claude in qualification. The shared `runCsvTask` generates a new `task-UUID` and binds its exact canonical directory in `evaluator.native.task_write_directory` and the environment digest before spawn. Authorization requires the current exact reviewed `file_write_managed` capability; replay cannot change the scope or opt-in. Parent/sibling paths, symlink aliases and path metacharacters refuse. No operator-supplied wildcard or arbitrary task path is accepted by the qualifier.

The launch adds in-memory `--settings` permissions with `defaultMode: "default"` and one `Edit(//ABSOLUTE/SESSION/task-UUID/**)` allow rule. **Edit path rules cover Write too; Write(path) is not the supported rule.** No unrestricted tool allow, Bash approval, acceptEdits, extra directory, global settings file or sandbox change. Existing vendor protected-path/policy checks still apply; this is not an OS-wide proof of no writes. See [official permission syntax](https://code.claude.com/docs/en/permissions#read-and-edit).

Claude env and store launch paths now both set `disableBundledSkills: true` and `DISABLE_DOCTOR_COMMAND=1`; frozen project skill discovery remains enabled. This uses the existing [selective bundled-skill control](https://code.claude.com/docs/en/skills#bundled-skills), not safe-mode or manual skill injection. The prompt `--` separator is retained.

Exact **Leo-only** rerun, using the already supplied subscription OAuth env without placing its value in argv/history/logs (builder NOT RUN):

```sh
bun scripts/p2-qualify-native.ts --root /private/tmp --runtime claude_code --auth-mode subscription --claude-model claude-opus-5 --claude-effort high --allow-claude-task-writes --execute-real-native
```

Without the new flag, no task path is preapproved. Prepare-only records the opt-in without assigning a task directory; each actual attempt binds its own scope. Existing store selectors can use the same qualification flag; their auth blockers remain. Default local `runtime run` CLI behavior is unchanged.

Final Claude qualification evidence is `/private/tmp/leo-p2-sandbox-f2h4h6z9/qoopia-p2-qualification-goBEAP/audited-outcomes.json`; read-only SQLite corroborates three succeeded revision-2 outcomes. Current frozen fixture states the exact counts/totals/numeric-overall and refusal JSON shapes. Historical denied/mismatched attempts are not used as the final qualification result. The three older redacted envelopes remain malformed; do not repair them or infer a new trace replay from the audited outcome.


## Codex configured-profile functional qualification (explicit owner scope change)

Strict mode remains the default. `--codex-configured-profile-functional` is accepted only with `--runtime codex --auth-mode subscription-store --codex-login-backend file` and an explicitly selected existing `--codex-login-store`. No keyring/Claude/API/env-mode exception or ambient profile discovery. A selected `.env` entry (including a dangling link) refuses without content reads: pinned native arg0 loads it before CLI ignore flags. The launcher also denies reads of that entry; do not modify/remove a real profile file to make this check pass. User skills in that CODEX_HOME are now permitted in this mode; they are neither frozen by Qoopia nor claimed isolated/attested. The adapter only inspects selected directory metadata and never reads/lists/copies credential or user-skill content. The official CLI itself can read the chosen existing login context and discover its skills. Do not select a different store implicitly or use credentials on argv.

The existing `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, project Git boundary and disabled plugins/apps/hooks/multi-agent/memory/bundled skills remain; `skills.include_instructions=true` preserves native frozen project discovery. Parent/system/managed-policy checks remain; no required policy is bypassed. No permission/sandbox bypass or default permission change. Only this mode routes supported `log_dir`/`sqlite_home` settings to the generated native HOME and disables shell snapshots. HOME/TMPDIR/XDG remain disposable and no ambient API keys/OAuth/proxy environment is inherited. Config/schema and caller basis: [local pinned-source trace](../artifacts/p2/codex-configured-functional-jn_fvdvh/README.md).

`login status` cannot ignore config.toml. The functional mode therefore does not call it (an explicit auth-preflight combination refuses). Instead the version probe remains isolated and the official `exec --ignore-user-config` enforces `forced_login_method="chatgpt"` with the explicit file backend. `auth_preflight` is labelled NOT RUN, not subscription-source-confirmed. There is no API fallback; absent/incompatible login, entitlement or refresh failure stops execution. The requested model remains exactly gpt-6-astra/high. This route does not prove the account's plan tier or upgrade missing model metadata into evidence.

Before progression, the native event must show a successful full read of the exact frozen project SKILL.md bytes, bound to the existing version/loadout/run; the adapter checks frozen projection preservation after execution. A different user skill with the same name, partial/truncated output, an unfamiliar command representation or a changed projection is not verified. Current grants/revocation/stale outcome, exit status and exact summary/refusal assertions must pass. Initial/update/rollback may then proceed with model_status=unknown only under the explicit immutable opt-in. A public `model rerouted:` error event is negative evidence and stops both modes. No reroute is not model attestation. `configured_profile_functional` is bound in the evaluator/environment; replay cannot change it.

Results label `qualification_mode=configured_profile_functional`; a completed three-run sequence is `FUNCTIONAL_SEQUENCE_COMPLETED_MODEL_UNATTESTED_WRITE_AUDIT_REQUIRED`. This is functional progress only. Strict `verified_outcome` stays unknown while actual model is unknown, including after a supplied outside-write audit; model mismatch remains failure. Filesystem boundary evidence, current authorization and independent final acceptance remain separate gates. No native model tasks were run by the builder.

### Historical read-only-store launcher (superseded for current functional qualification)

This older implementation remains as the default launcher dependency. The current owner-approved functional route and its two bookkeeping exceptions are described above. Historical command reference, not a new qualification instruction:

```sh
python3 artifacts/p2/codex-configured-functional-jn_fvdvh/run-leo.py --codex-login-store /Users/askhatsoltanov/.codex --execute-real-native
```

Omit `--execute-real-native` for preparation only (zero native CLI/auth/model calls). Every invocation makes a fresh `/private/tmp/leo-p2-codex-configured-*`, runs synthetic inside/outside write controls, then invokes the qualifier under `/usr/bin/sandbox-exec`. It refuses failed controls or a missing sandbox executable; no unsandboxed retry. The profile denies all filesystem writes outside that disposable outer root, except `/dev/null` data writes. The selected CODEX_HOME receives no write exception. It stores controls/profile/command/qualification logs only in the new root and never overwrites prior Leo evidence. Do not call the functional qualifier unsandboxed or widen this profile to turn a failure green. Exit2 remains NOT ACCEPTED. Native logs are private diagnostic material; do not publish raw logs or token/account details.

The wrapped qualifier arguments are:

```text
bun scripts/p2-qualify-native.ts --root NEW_DISPOSABLE_OUTER_ROOT --runtime codex --auth-mode subscription-store --codex-login-backend file --codex-login-store /Users/askhatsoltanov/.codex --codex-model gpt-6-astra --codex-effort high --codex-configured-profile-functional --execute-real-native
```

**Remaining vendor writes:** startup helper aliases/locks/cleanup/chmod under `CODEX_HOME/tmp/arg0` and `models_cache.json` are still anchored to CODEX_HOME in pinned 0.153.3; no supported independent cache path was found. Official auth can refresh/write the store, and forced-login mismatch enforcement can attempt logout. Neither `--ephemeral` nor disposable HOME forbids those vendor effects. The outer sandbox denies these profile writes; auth refresh failure may block a run; model-cache store failure is logged and helper-path setup may warn/degrade (not all denied writes are fatal). Missing helper availability or permission failures must remain blockers. No refresh/login helper, token copy, symlink or blanket profile write approval is introduced. Logs/SQLite/XDG are disposable, but this is not a promise of zero attempted vendor writes. Keyring is intentionally outside this opt-in.

Launcher write controls are not a per-run OS audit or a claim of task-only writes inside the outer root. `outside_root_writes` remains unknown until Leo independently reviews suitable scope-complete native/OS evidence. Existing `p2-finalize-outcomes.ts --root NEW_QUALIFICATION_ROOT --audit REVIEWED_AUDIT_JSON` consumes that evidence; it does not collect/interpret a trace or waive model attestation. Full functional initial/update/rollback, read-only-store compatibility, any needed actual-model evidence and independent acceptance are NOT RUN by the builder. P2 DONE is not claimed.
