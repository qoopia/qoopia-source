# Qoopia news and the private owner dashboard

The account service provides `/owner` for the single account ID configured in `QOOPIA_OWNER_ACCOUNT_ID`. It reuses the existing confirmed profile session: anonymous requests return 401, other accounts return 403, and responses use `Cache-Control: no-store`. There is no public analytics API, bearer key in a URL, or CSV export of all addresses. `/profile` shows the owner link only to that account.

The dashboard separates current account counts, subscriptions and valid profile sessions from periodically collected download and event counters. A valid session does not mean someone is online. GitHub downloads count files, repetitions and automation; two release-verification downloads are annotated in the analytical store. These are not unique people or finished installations. Sign-in events include historical QA; provider acceptance is not inbox delivery or reading.

## Data and consent

- `connection_accounts` retains confirmed account identities. New `account_activity` records contain new registration dates and successful sign-in timestamps/counts. Existing registration dates remain unknown. Sign-in counters begin when this feature is deployed, not retroactively.
- `news_preferences` is opt-in, per verified email, with language and a consent revision. There is no backfill of subscriptions. A Google-linked account changing email must consent again for the new email.
- The signup checkbox starts unchecked. Its choice is tied to the initiating browser's pending login and is applied only after successful confirmation/redemption. Existing users can subscribe or unsubscribe in `/profile`.
- `news_consents` retains the email, time, source (`signup`, `profile`, `email`), language, action and exact consent text/version. These are private account records; analytics exports contain aggregate counts only.
- The existing pending-login schema is unchanged. New optional signup metadata lives in a separate temporary table. Rolling back the service does not require restoring an older database over fresh sign-ins or consents.
- `/news/unsubscribe` uses a signed, revision-bound link. GET does not change preferences, so link scanners do not unsubscribe people. Explicit form POST and RFC 8058 one-click POST unsubscribe without a login. An old link cannot override renewed consent. Sign-in emails are independent.
- No email-open pixels, external font requests, or memory/session-content telemetry are added. Account-level access is confined to the owner. Consent records should be retained only as needed to honour choices and demonstrate consent; deletion requests require an operator review, including appropriate suppression records.

## Collection and configuration

`scripts/analytics.py --owner-export /srv/qoopia-analytics/owner/latest.json` publishes a separate aggregate JSON snapshot atomically. Create its private parent directory for the collector user first. The account container mounts only this directory read-only at `/owner-analytics`, not the analytical SQLite database. The dashboard checks both snapshot age and required source status/timestamps; unavailable values are not zeros.

Account-service configuration:

```
QOOPIA_OWNER_ACCOUNT_ID=<existing confirmed owner account UUID>
QOOPIA_OWNER_ANALYTICS_FILE=/owner-analytics/latest.json
QOOPIA_PUBLIC_RELEASE_TAG=<current published installer tag>
QOOPIA_NEWS_FROM=Qoopia <news@mail.qoopia.ai>
QOOPIA_NEWS_POSTAL_ADDRESS=<owner-approved public physical postal address>
```

Keep these in the private operator environment. Resolve the owner UUID from an explicitly verified owner account; never select the first account or allow visitors to claim ownership. No privileged account ID or address belongs in the public source. Preserve all existing sign-in and Cloudflare settings.

## Preparing and sending a newsletter

The sender is included in the account-service image at `/app/newsletter.js`. There is no scheduled or automatic campaign sender. Creating a draft, opening the owner panel, or checking a subscriber count sends nothing.

Put reviewed UTF-8 `subject.txt` and `body.txt` under the private mounted `/operator/news/` directory. Body input is plain text, escaped in HTML, with a plain-text alternative and the canonical CID brand image. Prepare, then inspect the draft:

```
docker exec qoopia-auth bun /app/newsletter.js prepare /operator/news/subject.txt /operator/news/body.txt ru
docker exec qoopia-auth bun /app/newsletter.js preview <campaign-id>
```

Only after the operator authorizes that exact content and recipient language:

```
docker exec qoopia-auth bun /app/newsletter.js send <campaign-id> --confirm <same-campaign-id>
```

Sending is refused until the public physical postal address, verified sender address, and provider key are configured. Each send checks current consent and verified email, sends to one recipient, and includes the unsubscribe URL in the body and `List-Unsubscribe` / `List-Unsubscribe-Post` headers. Do not use an account list as a mailing list without explicit consent.

`news_campaigns` stores immutable draft content; `news_deliveries` stores one attempt per campaign/account. A durable claim prevents concurrent or restarted commands from sending the same attempt twice. Provider requests also carry a stable idempotency key. Timeouts, ambiguous provider responses and interrupted attempts require manual reconciliation; they are not automatically retried after the provider's 24-hour idempotency window. Never clear an uncertain record to force a resend.

The command permits at most 20 newsletter attempts per UTC day across campaigns, at a bounded rate, and stops at the first provider failure. The cap reserves capacity for sign-in mail; it does not replace checking the actual provider quota. No paid plan is enabled. `accepted` means provider acceptance only; `failed`, `uncertain`, and interrupted `sending` remain explicit. The owner dashboard displays these outcomes. Delivery, bounce and complaint webhooks are not implemented in this change; they must not be reported as known delivery states.

## Qualification and rollout

Run `bun test tests/newsletter.test.ts tests/profile.test.ts tests/identity-login.test.ts tests/identity-ux.test.ts tests/identity-proxy.test.ts tests/analytics-collector.test.ts`, typecheck, lint, the full suite and the isolated storage-full step. The optional local browser fixture is `BUN=/path/to/bun python3 tests/helpers/news-browser.py /private/evidence-directory`; it creates only synthetic accounts and never sends mail.

Build the account image from the exact checked commit. Before replacing it, stop the old writer and make SQLite online backups of login and event stores, checking integrity and restoration. Preserve the prior container for rollback. Keep the same data/operator mounts, environment and network policy, adding only the read-only owner snapshot mount and explicit owner configuration. Verify anonymous denial, default unchecked opt-in, health, source freshness and unchanged memory/installer release. Never modify consent or fabricate a production session for a test. This server change does not replace or resign installers.

References: [ICO consent guidance](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-electronic-mail/how-do-we-comply-with-the-pecr-electronic-mail-marketing-rules/), [FTC email requirements](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business), [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [Resend unsubscribe headers](https://resend.com/docs/dashboard/emails/add-unsubscribe-to-transactional-emails). Jurisdiction and message purpose matter; explicit optional consent is the product baseline, not a claim that one checkbox settles every legal obligation.
