# Qoopia analytical layer

This store is operational/product metadata, separate from memory. It does not contain note bodies, prompts, search queries, email addresses, credentials, confirmation links or raw request URLs.

The account service now offers a protected `/owner` dashboard and optional email-news consent in `/profile`. Account identities, consent history and individual sign-in timestamps stay in the private account database; only counts are imported here. See [news and owner operations](../operations/news-and-owner.md). A separate atomic aggregate export is mounted read-only in the account container. No user is subscribed automatically, and no newsletter is sent by collection.

## Sources and coverage

| Source | Grain / collection | Interpretation |
|---|---|---|
| GitHub releases | Observed asset counter, five-minute bucket; metadata snapshot | Downloads of a file, including automation/retries. First observation is a baseline, never new acquisition. Counter decreases start a reset interval. |
| GitHub traffic | Provider UTC day for views/clones and uniques; rolling 14-day top paths/referrers | Repository traffic, not website visits or installations. Local authenticated bridge runs hourly; credentials stay on the Mac. Snapshots preserve expiring provider history. |
| Accounts / routes / relay | Consistent read-only SQL snapshot every five minutes | Account records, sessions, provisioning states, groups/members. Active route does not mean online installation. Baseline can include historic tests. |
| Corsair memory metadata | Read-only aggregates every five minutes | Counts of objects, enabled/recent agents, OAuth registrations and unexpired grants, declared client surfaces/states, search latency/error/empty counts, Skills/runtime object counts. **Only owner Corsair**, not the user fleet. |
| Account events | Timestamped server events, UUID deduplication | Request, mail provider accepted/failed, confirmation, redemption, website login/logout/save, bounded HTTP route/outcome/duration. Mail accepted is not delivered. No account/session linkage is retained in analytics. |
| Website events | Explicit opt-in; page, download click, language, viewport bucket, coarse referrer, DOM/load/LCP timing | Self-reported browser observations; not unique visitors, actual downloads, installations or trusted server outcomes. No cookies or persistent visitor ID. DNT/GPC overrides the stored opt-in. |
| Cloudflare zone analytics | Adapter prepared; needs Zone Analytics Read | Whole-zone requests/bytes/cache/threats/pageViews/provider uniques by UTC day. Current operator token lacks this permission. Never substitute zero. |
| Resend sent-message metadata | Adapter prepared; needs read-capable key | Qoopia sender only; count by created date/latest event in provider-retained window. Never fetch email bodies/attachments. Existing key cannot read history. Opens, if supplied by provider, are not proof of a human reading. |
| Operations | Host load/free space, selected containers running/health/restart/OOM | Infrastructure health only; counts are not product engagement. |

No new paid plan or external analytics vendor is required. Existing hosting/storage still has its ordinary cost. Optional provider imports are blocked explicitly until legitimate read access exists.

Independent users' local-only installations are **not reporting telemetry**. Download-to-install conversion, global active installs, retention and fleet-wide Claude/GPT usage are unavailable. They require a separately consented client reporting implementation and a new signed package. Do not infer them from email logins, route registrations, agent names or IPs. Current V16 candidate is unchanged by this server/website analytics release.

## Storage and correctness

`/srv/qoopia-analytics/analytics.sqlite`: observations, sanitized provider snapshots, events, source_runs, annotations and import cursors. `latest_observations` is a last-observed value with its own observation timestamp; always inspect source freshness. `cumulative_deltas` distinguishes baseline/reset from measured increases. Gauges and overlapping 24-hour/14-day windows must not be summed over collection runs. `event_daily` / report aggregates group trusted server and untrusted browser data separately. Historical QA traffic is retained and annotated, never silently subtracted.

Event spool: `/srv/qoopia-auth/data/analytics.sqlite`, independent of login.sqlite. Strict property allowlist, browser/server type separation, per-request byte limit, origin/rate checks, UUID deduplication, bounded daily acceptance (100,000 events, duplicate delivery does not consume capacity). `analytics_daily.dropped` is measured; any nonzero value means incomplete coverage. Analytics failure cannot interrupt sign-in. Source DB is imported by rowid cursor, with replay-safe recovery if the source DB is replaced. Event days use server UTC, not a user-supplied timestamp.

Raw allowed events and provider snapshots are retained from launch; there is no automatic deletion of history. Monitor disk space and adjust retention deliberately if volume grows. Daily SQLite online backups are integrity-checked; backup files are private. The import job is a systemd timer, independent of this Codex task. The GitHub authenticated bridge uses a user LaunchAgent and requires this Mac to be awake; provider freshness exposes outages. Public asset/operational collection runs on Corsair independently.

## Commands

From the canonical checkout, with proper access:

```
python3 scripts/analytics.py --db /private/analytics.sqlite --github --export /private/latest.json
python3 scripts/analytics-providers.py --gh /absolute/path/to/gh --out /private/providers.json
```

On Corsair, `systemctl status qoopia-analytics.timer` and `journalctl -u qoopia-analytics.service`. Read the generated JSON or query the private DB over SSH; there is no unauthenticated analytics dashboard or public database endpoint. Do not publish exports containing internal operational details.

After granting provider access: put a dedicated credential in a private file (0600), use `--resend-key-file` or `--cloudflare-config` in the metadata bridge, verify a real read, then review source status. Cloudflare config contains `zone` and `token_file`. Never put keys in command arguments, code, screenshots or analytical tables.

References: https://docs.github.com/en/rest/metrics/traffic ; https://developers.cloudflare.com/analytics/graphql-api/ ; https://resend.com/docs/api-reference/emails/list-emails

The installed Mac bridge is `scripts/analytics-sync.py` with a protected runtime directory under `~/Library/Application Support/Qoopia/Analytics`, a user LaunchAgent `ai.qoopia.analytics.providers`, and an hourly schedule. It uploads only sanitized provider metrics and downloads integrity-checked immutable daily analytics backups (including days missed while asleep). `sync-status.json` records success/error without secrets. Optional `provider-config.json` points to `cloudflare_config` / `resend_key_file`; credentials remain outside this repository. A stale or missing bridge marks that source as failed while core collection, export and backups continue.
