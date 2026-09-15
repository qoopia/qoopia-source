# Backup and restore rehearsal

`scripts/v4-backup.ts` opens its source read-only, checks integrity/FKs, and uses SQLite `VACUUM INTO` for a consistent snapshot. It never falls back to copying a live DB/WAL. The output is chmod `0600`, reopened read-only, integrity checked, logically hashed, and reported without row bodies.

On a scratch source:

```bash
bun scripts/v4-backup.ts --source "$CLONE_DB" --output "$WORK/backup.db" --verify --report "$EVIDENCE/backup.json"
bun scripts/v4-rollback-rehearsal.ts --source "$WORK/backup.db" --workdir "$WORK/restore" --report "$EVIDENCE/restore.json" \
  --current-release "$CANDIDATE_SHA" --rollback-release "$PREVIOUS_REVIEWED_SHA"
```

The rehearsal requires schema/count/logical-hash equality, zero FK violations, `integrity_check=ok`, and RTO at most 30 minutes. Production backup, restore, migration, deploy, and restart are P10 action-specific owner-GO operations; a rehearsal never grants that authority.

## P3 selected operations journal: non-destructive diagnosis (recovery correction round1)

The P3 delivery commands `backup`, `update`, `migrate-source` and existing-root `restore` capture the **selected local journal** before publication. A valid backup does not override corrupt local history: local receipts can be newer than that backup. Maintenance also refuses corrupt history in place. There is no automatic quarantine, deletion, reset or history pruning.

Run the following from this reviewed P3 worktree, with absolute paths to a disposable installation and an optional candidate backup. This is read-only diagnosis: backup verification creates and removes only its own temporary SQLite inspection copy. It prints metadata, counts and fixed error codes, never journal bodies or receipts. It does not run migration, delivery or maintenance. If a writer is active, obtain an explicitly authorized quiet window; this recipe does not stop a service.

```sh
bun - "$INSTALL_ROOT" "$BACKUP_CANDIDATE" <<'TS'
import fs from 'node:fs';
import {readCurrent,operationsDirectory} from './src/delivery/operations.ts';
import {opsFile,readRecoveryOps,OpsJournalError} from './src/delivery/ops-state.ts';
import {verifyBackup} from './src/delivery/snapshot.ts';
import {safePath,MAX_JSON_BYTES} from './src/utils/fs.ts';
const [root,backup]=process.argv.slice(2);
let current;
try { current=readCurrent(root); }
catch { console.log(JSON.stringify({pointer:'REFUSED',action:'Preserve current.json and all generations; diagnose missing/unsafe pointer or selected journal. Do not edit the pointer.'}));process.exit(1); }
const file=opsFile(operationsDirectory(root,current));
console.log(JSON.stringify({selected_journal:file,budget_bytes:MAX_JSON_BYTES}));
try {
  const s=fs.lstatSync(safePath(file));
  console.log(JSON.stringify({size:s.size,mode:(s.mode&0o777).toString(8),uid:s.uid,regular:s.isFile(),links:s.nlink}));
} catch(e) { console.log(JSON.stringify({metadata:'REFUSED',code:['ENOENT','EACCES','EIO','ENOTDIR'].includes(e.code)?e.code:'UNSAFE_OR_IO'})); }
try {
  const state=readRecoveryOps(operationsDirectory(root,current),current.instance);
  console.log(JSON.stringify({journal:'VALID',alerts:state.alerts.length,compact_receipts:state.receipts?.length??0,pending:state.alerts.filter(a=>a.state==='pending').length}));
} catch(e) { console.log(JSON.stringify({journal:'REFUSED',code:e instanceof OpsJournalError?e.code:'INSPECTION_FAILED',recovery:'BLOCKED; preserve history'}));process.exitCode=1; }
if(backup) {
  try { const m=verifyBackup(backup,current.instance);console.log(JSON.stringify({backup:'VERIFIED',format:m.format,local_journal_repair:false})); }
  catch(e) { console.log(JSON.stringify({backup:'REFUSED',code:e instanceof OpsJournalError?e.code:'BACKUP_INVALID',local_journal_repair:false}));process.exitCode=1; }
}
TS
```

The selected location is `INSTALL_ROOT/operations/operations-status.json` for a legacy pointer, or `INSTALL_ROOT/operations/<operations_generation>/operations-status.json` when `current.json` selects a journal generation. Do not diagnose an arbitrary old generation instead. A missing selected journal is a pointer refusal; a never-created legacy journal is empty under the existing compatibility rule.

| Stable journal code | Meaning and next diagnostic step |
| --- | --- |
| `OPS_JOURNAL_IO` | A filesystem operation failed, including EACCES/EIO. Inspect reported path metadata and permissions of each ancestor without changing them; distinguish access failure from storage failure using the OS error from a read-only metadata inspection. Do not classify this as malformed JSON or rename history. Any repair requires separately authorized action. |
| `OPS_JOURNAL_UNSUPPORTED_VERSION` | The parsed envelope declares a version this reader does not support. Preserve original bytes and use a compatible reader. Never classify as corruption, recover from an older backup, or edit the version to bypass refusal. |
| `OPS_JOURNAL_INVALID` | Malformed JSON, or supported-version schema, lifecycle, duplicate ID or receipt integrity validation failed; at a backup boundary, a declared/actual size disagreement is also invalid. Preserve bytes and compare against independently verified history on disposable copies. A syntactically valid document can still be invalid. |
| `OPS_JOURNAL_INSTANCE_MISMATCH` | An event belongs to another instance. Check that the selected root and backup are the intended installation. Do not rewrite the instance, event IDs or receipts. |
| `OPS_JOURNAL_TOO_LARGE` | The local file, backup member/descriptor or proposed serialized write exceeds the existing **16,777,216-byte** JSON budget. Writes/merges first try approved lossless compaction of resolved confirmed events; refusal means the result still exceeds the ceiling. Oversized input files are refused before parsing. Preserve both inputs; a scoped storage decision is required. No IDs may be deleted and recover-ops cannot bypass this limit. |
| `OPS_JOURNAL_UNSAFE` | Link, special file or unsafe path refused. Inspect path components and retain evidence; do not follow, replace or unlink them to make recovery pass. |
| `OPS_JOURNAL_CHANGED` | The file changed during the bounded read. Diagnose concurrent writes; retry once in an authorized quiet window. Stop on the third recurrence at the same boundary. |

**Owner clarification (Scope A):** the separately confirmed `recover-ops` path below may select journal history from a verified same-instance backup while preserving the damaged original. This implementation GO authorizes disposable tests only. A verified backup or ordinary `--commit` alone never authorizes excluding unreadable history. Unsupported-version, oversized, unsafe, missing, IO-failed and wrong-instance journals still refuse; no deletion/reset workaround is authorized. Newer pending intent and confirmations may be lost from selected operational knowledge. See `P3-RECOVERY-OWNER-CLARIFICATION.md`; all other gates remain unchanged.

Doctor and owner dashboard show at most the existing **20-event delivery batch size** as a preview, prioritizing active events, then pending delivery, then history. `pending`, `active` and `total_alerts` count the whole readable journal; `omitted_alerts` identifies truncated display. On refusal totals are `null`, never a false zero. Resolved confirmed events may become compact receipts at the byte ceiling. `compact_receipts` counts them as confirmed history, never pending/active; totals and omitted counts include receipts without expanding the preview. Reads allocate at most 16 MiB plus a one-byte growth probe before parsing; descriptor and actual size are checked before a backup-member read. Hash and validation use the same bounded bytes.

Scope B implementation is now explicitly owner-approved. Only resolved confirmed display/attempt detail may be compacted; every acceptance identity/digest is retained. Pending and active events stay in full. This finite resource boundary does not promise unlimited availability: receipts still grow with distinct acceptances. No confirmed ID expires by age, UUID order, backup rotation or deletion of a local backup. Product-created generations, preserved candidates, checkpoints, external backups and failed staging are not subject to a new cleanup policy or aggregate quota.

Serialized writes, backup members and restore unions share the 16 MiB ceiling. Before staging, known journal/copy byte sizes are checked against available filesystem blocks, rounded by allocation block; restore also includes preservation/checkpoint copies, a DB-sized SQLite write reserve and conservative JSON metadata allowances. Bundle inventory copies are preflighted as a group. Each exact durable write is checked again while the original still occupies disk. Available-space checks are not reservations, and SQLite migration/temp files, filesystem metadata, concurrent disk use and power loss are not qualified by them. IO/overflow/crash leaves originals intact and can leave staged files; nothing automatically deletes those files. Actual deterministic boundary RSS/time is recorded in the Scope B result; the 16 MiB member ceiling is not an RSS ceiling.


## Separately confirmed local journal recovery (Scope A)

`recover-ops` recovers only the pointer-selected **operations journal**. It leaves the database generation, data, auth, installed bundle and backup intact. It accepts a readable, private, regular damaged journal within 16 MiB whose validation fails `OPS_JOURNAL_INVALID`, and a fully verified `qoopia-backup/2` of the same instance with valid operations. Healthy history, unsupported versions, foreign-instance history, missing selected history, unsafe paths, size overflow and IO errors refuse. The live database instance must also match the pointer before a recovery/replay binding is issued. This is intentionally narrower than arbitrary filesystem repair.

**Warning: newer delivery knowledge and pending intent may be lost. Unreadable history is not merged. Restored pending notifications may already have been accepted and could replay.** Keeping the damaged bytes permits later examination; it does not prove preservation of their meaning.

Use a disposable installation for this authorized rehearsal. For real data, obtain a separate action-specific owner GO and an authorized quiet window first. These commands do not stop a server. The existing OS-owner CLI boundary uses the installation's private owner directory and exclusive SQLite installation lock; a running server/other owner operation refuses. Preview briefly acquires that lock (including its existing lock-file bookkeeping), verifies the backup in a private temporary SQLite copy, and prints metadata/counts, never journal bodies or channel secrets.

```sh
"$QOOPIA" recover-ops --root "$INSTALL_ROOT" --backup "$BACKUP_CANDIDATE" --allow-test-fixture
# Read the warning, instance, selected journal, backup path and hashes.
# Set RECOVERY_CONFIRMATION to the exact confirmation printed by that preview only after explicit approval.
"$QOOPIA" recover-ops --root "$INSTALL_ROOT" --backup "$BACKUP_CANDIDATE" --commit --confirm-recovery "$RECOVERY_CONFIRMATION" --allow-test-fixture
```

`--allow-test-fixture` is for the test-signed candidate only. Confirmation is a comparison digest, not a secret, login capability or authorization an agent may grant itself. It binds the canonical root, instance, exact pointer bytes, selected journal path/hash/file identity (including inode and modification/change times), and selected backup path/manifest bytes. Missing confirmation refuses; changing a bound input requires a new preview and new explicit confirmation. Commit revalidates under the same installation lock and again before pointer publication. Backup manifest member hashes are verified; legacy backups without operations are refused.

Before publication, `operations-recovery/generation-UUID/` receives `damaged-operations-status.bin` (exact bytes) and `manifest.json` (binding and warning), durably written with file/directory fsync and readback. The damaged original stays at its original path. The new journal is separately durably staged; only `current.json.operations_generation` changes atomically. No original or archive is deleted on failure or success. Disk-full/IO refusal can leave an incomplete staging directory alongside the intact original; preserve it and diagnose. A process crash selects the original journal or the complete recovered journal; inspect `current.json` before deciding whether to retry. This is process-kill evidence, not power-loss/filesystem qualification.

Every recovered journal carries `delivery_hold: RECOVERY_REPLAY_REQUIRES_OWNER`, even if the backup has zero pending alerts. Recovery performs no sends and reads no channel policy. The shared transport exits before DNS/HTTP or attempt updates while held. Maintenance may record new state, but all notifications remain held. Doctor, dashboard and maintenance reports show the hold; scheduled backups preserve it, and regular restore merges it conservatively from either journal. New writes use `format: qoopia-ops/3`. The new reader deliberately accepts `/1` without a hold and the pre-versioning `/1` with a hold, also accepting `/2`, normalizing to `/3` in memory without rewriting on read. Subsequent writes and backup serialization use `/3`; hold, IDs and receipts survive. Unknown declared versions refuse before strict body validation with `OPS_JOURNAL_UNSUPPORTED_VERSION`. Malformed JSON without a readable envelope remains `OPS_JOURNAL_INVALID`.

Only a separate replay decision enables later delivery:

```sh
"$QOOPIA" authorize-ops-replay --root "$INSTALL_ROOT" --allow-test-fixture
# Review current pending count and replay risk; separately authorize the printed state.
"$QOOPIA" authorize-ops-replay --root "$INSTALL_ROOT" --commit --confirm-replay "$REPLAY_CONFIRMATION" --allow-test-fixture
```

The replay confirmation has a separate operation binding and includes the entire current journal/pointer identity. Maintenance changes invalidate it. Authorization stages a new journal generation without the hold and retains `replay-authorization.json`; no send happens in this command. Subsequent scheduled or explicit delivery can send pending **and future** alerts using the separately configured owner channels. The command does not provision channels or promise remote deduplication; existing event IDs/digests are preserved. An older held backup restores the hold conservatively and requires a fresh decision. Real receivers remain outside this task.


## Journal reader and installed-bundle compatibility

The new bundle carries `OPS-JOURNAL-READER.json` with `{"format":"qoopia-ops-reader/3","reads":["qoopia-ops/1","qoopia-ops/2","qoopia-ops/3"],"writes":"qoopia-ops/3"}` as a member of its signed/hash-verified inventory. This declares support for both known `/1` variants, `/2`, `/3` compact receipts, holds and selected journal generations. The existing bundle manifest envelope is unchanged. Do not add this member to old bundles: that would change their signed inventory and does not change their executable.

`recover-ops` and `authorize-ops-replay` now verify this capability and dispatch to the installed executable before handling preview or commit. The Delivery engine also checks it under the installation lock before recovery/replay publication. Launcher-managed update, rollback, existing-root restore and new-machine restore require the target capability before publication. Absence or mismatch gives `OPS_BUNDLE_INCOMPATIBLE`; version text or a successful old parse is not capability evidence. These checks conservatively refuse targets without the declaration even when the particular history is legacy and unheld. Refusals preserve the pointer and selected journal; existing bundle staging/lock bookkeeping can remain.

| Combination using the new launcher/engine | Outcome |
| --- | --- |
| Compatible installed bundle + known `/1`, `/2` or `/3` | Reads preserve legacy semantics; supported writes use `/3`. Healthy history still cannot enter corrupt recovery. |
| Compatible installed bundle + unknown/future journal version | `OPS_JOURNAL_UNSUPPORTED_VERSION`; no recovery preview or replacement. |
| Old installed bundle without `/3` capability (including reader `/2`) + recovery/replay | `OPS_BUNDLE_INCOMPATIBLE` before dispatch or archive creation. Update to a compatible, trusted bundle requires readable supported history; a corrupt old installation has no automatic migration/recovery bridge here. |
| Update to compatible bundle with readable legacy history | Allowed through the new launcher and existing trust/migration checks; local hold remains. |
| Update/rollback/restore target without capability | Refused before pointer publication, including rollback retaining `operations_generation`. No downgrade/removal of a hold or version field. |

**No retrofit claim:** an old launcher or old installed binary executed directly does not gain these checks. Its strict `/1` parser may call a valid `/2` journal `OPS_JOURNAL_INVALID`, and old recovery code may then consider it damaged. Do not use old recovery on newer history. This implementation cannot constrain already-built binaries; it only refuses unsafe combinations in the new code. Old binary behavior is a compatibility limitation, not proof of corruption. The previous broad statement that old binaries simply refuse safely is superseded here.

Every new-machine restore now stages `RECOVERY_REPLAY_REQUIRES_OWNER`, including `/1` backups with no operations member and backups with zero pending events or no saved hold. An old backup cannot prove knowledge of all later acceptances. The hold survives future maintenance and existing-root restores; only the separate bound `authorize-ops-replay` decision removes it, without sending. The same hold warning covers unreadable or unavailable history.

Existing-root restore unions receipts/full events before creating a checkpoint or staging data. Matching compact acceptance dominates a saved pending/full copy, including its obsolete active flag. Digest or instance conflict refuses. Full-event lifecycle selection remains the accepted limitation: later `last_run.at` wins, local wins ties; a later saved full event can revive an already-cleared suppression. Receipts never become active. A recurrence creates a distinct ID. This is not a new lifecycle ordering protocol.

The `/2` launcher requires its exact `/2` capability and therefore cannot update to this `/3` bundle. Invoke the new trusted `/3` launcher for that upgrade. A new launcher backup on an old installation serializes a `/3` operations member but does not alter the local journal or pointer; older readers cannot consume that backup. Runtime start/maintenance use installed code, so directly running an old binary still has the accepted D1 limitations. No old binary or damaged-old-installation bridge is retrofitted here.

Attempt state must persist within capacity and staging space before DNS/HTTP. Subsequent acknowledgment persistence can still fail from disk exhaustion, concurrent lifecycle growth or process failure: the event remains retryable with the same ID; remote dedup relies on the explicit receiver contract. The finite journal may refuse more intent or delivery progress once receipts plus pending/active state fill it. No real receiver/TLS or release gate is qualified by disposable fixtures.
