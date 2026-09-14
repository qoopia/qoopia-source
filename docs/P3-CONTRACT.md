# P3 contract — candidate work, NOT DONE

Authority: complete `../spec/QOOPIA-UNIFIED-TZ.md` (1013 lines), `../P2-ACCEPTANCE.md`, `../SUBSCRIPTION-POLICY.md`, and `../P2-OPUS-FINAL-REVIEW.json`, read before design. Base: accepted P2 `35e8890789cfb87302470125e4cad1d3318b5cc0`. No P2 evidence is rewritten. This is independent delivery within one Qoopia 5.0.0 release train, not a public release.

## Exact section 20 scope

Signed bundle/install; owner onboarding; backup/restore/update/doctor; unified packaging/notices; maintenance wiring. Four migration journeys (Qoopia-only, Skillonomia-only, both under one explicitly mapped owner, new user), with current35, legacy32, Skillonomia19 fixtures and rollback rehearsal. Mandatory gates: T-01, T-14–T-16, T-21, T-23–T-29. Exit requires clean-machine review without author infrastructure and both mandatory OS/runtime matrices: macOS arm64 (current and previous supported OS at qualification date), Ubuntu LTS x64/glibc, each with Claude Code and Codex. Cross-compilation is not platform execution.

## Verbatim gate contract (§19)

| Gate | Preconditions/action | Expected result/negative control | Evidence |
|---|---|---|---|
| <a id="t-01"></a> T-01 Полный clean-user loop | Чистая macOS arm64 и Ubuntu x64, без author config; download/start, два разных runtime, memory write/recall, реальная задача→capture→review→native use вторым→outcome→revision→rollback; повтор solo | Пользователь не пакует archive/JSON; фактический task artifact верен; один агент тоже полезен. Sample echo не заменяет реальную задачу | Установочный manifest, network/process trace, version digests, evaluator assertions, user-step count |
| <a id="t-14"></a> T-14 Backup/export/restore | Representative current Qoopia35 и Skillonomia19, old export32; consistent DB+blobs+keys, restore new OS user | IDs/lineage/grants/timestamps/hashes/signatures сохранены; absent blob/key fails/conditional; index rebuild equal | Row counts/per-origin coverage, FK/integrity/chain checks, manifest hashes, RPO/RTO |
| <a id="t-15"></a> T-15 Retention/GC | Expired trace, feedback links, task purge with skill source, unreferenced blob, active backup pin | Minimal evidence held, private original not copied wholesale; no referenced blob deleted; expiry worker реально wired | Before/after refs/counts, grace clock, maintenance execution proof |
| <a id="t-16"></a> T-16 Offline/tokens/defaults | Block network+all optional model services; actual minimal/full tools/list; config profile refresh | Local loop works; profile tokens within budget; advertised/current defaults match; no mandatory sidecar | Network deny log, serialized schema bytes/tokenizer, config manifest |
| <a id="t-21"></a> T-21 Release provenance | RC из clean SHA, signed manifest/assets; altered binary/embedded key, stale package version | Под trusted verifier tamper отказ; initial HTTPS trust assumption explicit; tag/build/schema match | SBOM/notices/signatures/verifier identity, immutable artifact registry |
| <a id="t-23"></a> T-23 Migration dry-run/apply | Qoopia-only/Skillonomia-only/both/new; collision same-ID/different-bytes; unknown source table/schema10 | Source unchanged by plan; ambiguous source STOP; mappings100%; no lost objects/privileges | Source snapshot hashes, row+field coverage, paused conflicts, migrator journal |
| <a id="t-24"></a> T-24 Cutover/rollback/key recovery | New source writes после dry-run, barrier/catch-up, crash, post-target-write failure, lost key | Один writer; новые записи не теряются; rollback scope exact; no fabricated signature continuity | Timeline/barrier seq, rollback/forward report, restored auth scopes |
| <a id="t-25"></a> T-25 Local auth/SSRF | Hostile Origin/Host/CSRF/redirect/rebinding, local first-claim race, private configured webhook/endpoint URL | Deny; no token in URL/log; legitimate local UI работает; same-UID limits stated | Negative endpoint corpus, auth/log scans, target connection trace |
| <a id="t-26"></a> T-26 Install/update/uninstall | No-admin account, port collision, Unicode/space paths, autostart decline, failed update, uninstall | Нет unintended system changes, prior state usable, data/user skills preserved | File/service/process diff before/after, signed update result |
| <a id="t-27"></a> T-27 Ops/alerts | Disk full/corrupt DB/backup wrong instance; health200 but function dead; fire→resolve→fire; transports fail | Actionable degraded/read-only; no false green backup; recurrence получает второе подтверждённое transport acceptance при исправном receiver; при failure pending alert visible | Two confirmed-acceptance assertions и negative failed-transport case, integrity failures, recovery runbook timing |
| <a id="t-28"></a> T-28 Supply chain/parser | Vulnerable vendored dependency negative control, tampered pin, actual shipped PDF/DOCX parse | Advisory/pin check реально fails on vulnerable control, safe fixture parser functions in exact artifact | Resolved SBOM+vendored inventory, advisory IDs/range, built artifact smoke |
| <a id="t-29"></a> T-29 Performance | Defined §11 corpus/hardware,5 clients/30min,100 activation repetitions | Budgets measured p95, no selective omission; memory/CPU/model cost separated | Raw bounded metrics, methodology and reproducible fixture generator |

## Requirements and reuse map (written before implementation)

| Gate | Existing implementation and tests to reuse | Missing P3 delivery boundary |
|---|---|---|
| T-01 | `auth/pairings.ts`, `skills/{capture,loop,adapter,runtime}.ts`, `tests/p2-*.test.ts`, `scripts/p2-qualify-native.ts` | Standalone install/start and local onboarding; actual fresh-account two-runtime/solo walkthrough remains qualification |
| T-14 | `services/backup.ts` verified VACUUM INTO; `db/v4-migrations.ts` logical hash; `migrations/source-adapters.ts`; `tests/export-import-v4.test.ts`, `p1-migration.test.ts` | Unified snapshot inventory verifies inline files/package bytes/archived originals/public keys; recovery manifest, auth invalidation on new-machine restore; IDs/history retained |
| T-15 | `services/retention.ts`, `db/v4-trace-retention.ts`, `tests/migrations-v4.test.ts`, `agent-wake-retention.test.ts` | Wire bounded expiry, verified daily backup, honest failures, preserve references/minimal capture evidence. Current immutable package BLOBs are inline SQLite, no second CAS daemon or pretend external-blob GC |
| T-16 | `api/authority.ts`, `mcp/server.ts`, `api/authority.ts::effectiveAuthority`, `tests/p1-mcp.test.ts`, `p1-api.test.ts`, `p2-loop.test.ts` | Bundle deterministic path without optional services; exact schema/token and network-deny qualification evidence |
| T-21 | `utils/product-version.ts`, `utils/release-baseline.ts`, `scripts/{release-stamp,build-release}.ts`, `tests/{product-version,release-baseline,release-artifacts}.test.ts` | Standalone artifact manifest, exact member hashes, pinned verifier, version coherence, source inventory, SBOM/notices; separate test signer classification |
| T-23 | `migrations/source-adapters.ts` immutable origin archive, 32/35/19 manifests; `tests/p1-migration.test.ts`, `p1-owner-upgrade.test.ts` | Owner-facing copy-only import plan/apply; changed-source plan invalidation; four journeys and rollback integration |
| T-24 | `db/migrate.ts`, `db/migration-033-*`, `services/backup.ts`; migration fault tests | Exclusive local operation lock, staged matching code+data generation, atomic current pointer, no automatic rollback after post-cutover writes; reissued auth, honest lost signing identity |
| T-25 | `auth/pairings.ts`, `dashboard-api.ts` cookie/CSRF, `http.ts` Origin safeguards; auth negative tests | OS-local owner login capability, no public owner-create; port/Host boundary; protected IPC qualification |
| T-26 | `skills/native.ts` managed ledger/removal; `tests/p2-native.test.ts` | Unprivileged explicit root install/update/uninstall, spaces/Unicode, port preflight, no implicit autostart, data kept and unowned files untouched |
| T-27 | `/health`, `/ready`, `services/backup.ts`, `scripts/wake_slo_alert_check.ts`, `tests/{health-metadata,wake_slo_alert_check,db-integrity}.test.ts` | Read-only doctor safe output, wrong-instance/corrupt-backup refusal, surfaced maintenance failure; functional health remains separate |
| T-28 | `scripts/check-vendored-pdfjs.ts`, `tests/files.test.ts`, existing pinned deps | Bundle exact parser assets and test actual parser execution; SBOM and notices include Bun and vendored PDF.js; publisher/legal clearance remains blocked |
| T-29 | `benchmarks/v4`, `scripts/recall-hybrid-bench.ts`, `p2` CSV evaluator | Fixed 100k notes/1M messages, 5 clients/30min, 100 activation repetitions, measured p95/RSS; no native/model invocations in builder scope |

## Required operational details (not waived by a fixture PASS)

Sections 10, 11, 15, 17 require bundled runtime/UI, one server/listener, no developer runtime/Docker/author credentials, loopback port before initial state, same-origin/Host/CSRF, owner bootstrap through 0600 local IPC with UID validation and a single-use >=128-bit login code (5 min, POST, never URL/log), explicit scoped agent pairing. Default OS paths: macOS Application Support/Logs, Linux XDG. Sensitive files 0600/directories 0700; no cwd dotenv/config loading. Autostart is separately opt-in. Uninstall retains data/backups/manual skills.

Update: pinned signatures + schema gate, verified backup, migration on copy, integrity verification, coherent code/data cutover; failure keeps old state usable. Downgrade below schema refused. Pre-new-write rollback selects matching old code/snapshot. Post-new-write rollback requires a separately reviewed preservation/data-loss plan and must refuse automatic discard. Source imports require explicit origins/workspace mappings, exact hashes/legacy signature/tlog, 100% mapping, unknown tables/columns/schema10 STOP, source unchanged and changed snapshot invalidates resume. No live source/cutover is authorized here.

Backup: consistent DB and all referenced immutable bytes, lineage/policy/grants/public trust, key-handling manifest; private key recovery only separately encrypted and explicit. No private signing key custody is currently provided by the P2 core (registered public keys only). Restore on another machine invalidates live access and requires owner recovery/re-pairing, never silently grants trust. Missing bytes/key recovery is fail/conditional. RPO <=24h, RTO <=15min on 5GiB new-machine fixture. Daily retention 7 daily +4 weekly, recall traces 7d, redacted application logs14d, immutable audit until explicit purge; orphan CAS grace7d if external CAS exists, never GC referenced/pinned bytes.

Release: exact SHA/version/migration range/OS/arch/checksums/SBOM/notices, controlled publisher and pinned trust root, macOS code signing/notarization. Linux first download relies on official HTTPS channel unless separately trusted verifier/key is used; replacing verifier+embedded key is NOT self-authentication. Test Ed25519 keys may exercise mechanics only. Production publisher custody/rotation/re-trust and legal clearance cannot be fabricated.

## Constraints and review notes

No credentials/global profiles/Keychain/native user skill roots/production data, browser/OAuth, remote hosts/containers/service installs, host packages, push/deploy/release, Git metadata mutations or nested model qualification. All AI uses existing Claude/GPT subscriptions; deterministic FTS/compiler/testing uses no model. No paid API or local-model fallback. Packaging-only fixture guard move must remove runtime dependency on `artifacts/p2`; historical files stay intact. Evaluate shared `nativeModelStatus` callers and cover explicit mismatch before GPT unknown; never promote strict Codex unknown.

VoiceOver/screen-reader: **NOT RUN — excluded by owner**, no automatic deferral or personal obligation. Preserve labels/keyboard behavior. Leo verifies candidate and commits locally after review; different-model Opus reviews afterward, neither is claimed run here. Third repeated correction of one defect class stops at root boundary.

## Owner decisions (one consolidated list)

1. Appoint real publisher, protected signing/notarization identity/custody, download channel and separately distributed Linux trust bootstrap/verifier; no credential access requested in this builder run.
2. Confirm proposed Apache-2.0 terms for unified changes with retained Qoopia MIT/Skillonomia Apache and full dependency/material privacy/legal review before publication.
3. Provide authorized clean macOS current/previous and Ubuntu LTS x64 qualification environments and later separate native subscription test scope for Leo. Existing GO mandates both OS targets; Windows remains unsupported.
4. Select private signing-key recovery custody/encryption policy before claiming portable signing continuity. Current implementation can preserve public trust and clearly report absent private recovery.
5. Any post-target-write rollback with data loss needs a concrete new owner decision; never implied by this GO. Future relay/index operator/funding decisions are outside P3.

6. Before enabling notifications outside disposable tests, the owner selects up to two receivers implementing the explicit ID/digest acceptance contract in `P3-EVIDENCE.md` and supplies the private installation-local channel policy. No destination, signing credential or automation is provisioned by this slice; missing channels keep alerts visibly pending.

Execution matrix and real command ledger will be recorded separately in `docs/P3-EVIDENCE.md` and `artifacts/p3/`; no mandatory gate becomes PASS from partial unit evidence.

## Current-contract addendum — accepted final-campaign equivalences (2026-09-06)

This addendum records the owner's accepted applicability decisions without rewriting the historical contract/evidence. Decision record: `P3-FINAL-CAMPAIGN-DECISIONS.md`; retained boundary evidence: `P3-T15-STORAGE-RETENTION.md`, `P3-T24-LOCAL-UPDATE-RESULT.md`, and `P3-REMAINING-CLOSURE-20260906.md`.

- **§17.3 / R-050 / T-15:** the 7-day orphan grace and migration/backup pin clauses apply to independently stored CAS objects. V1 stores file/package bytes inline in owning SQLite rows, so those CAS-only cells are **N/A with applicability rationale**, never PASS. Referenced-row preservation, tombstone/minimal evidence, expiry, immutable audit, and backup retention remain required.
- **§15.3(2,5,6) / R-057 / T-24:** external migration uses source write-stop/quiesce, one consistent final snapshot, complete import/reconciliation, then single-writer cutover; blind dual-write is not used. Where the source has no authoritative monotonic audit sequence, the accepted equivalent evidence is the write-stop acknowledgement plus immutable final-snapshot digest, target import/mapping digest, and canonical source/target reconciliation. Evidence must explicitly say `source_audit_sequence: unavailable`; timestamps, hashes, and local ordinals must not be relabelled as a source audit sequence. This equivalence is approved, not a fabricated numeric PASS.
- **§15.4 / R-040/R-046:** after target writes, forward-fix/freeze+export is the default. Any destructive rollback remains case-specific and requires a separate conflict/data-loss decision.
