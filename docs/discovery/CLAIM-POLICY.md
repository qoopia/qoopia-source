# Qoopia public claim policy

Owner: Qoopia maintainer. Reviewed 2026-09-14; next substantive review by 2026-10-14, sooner on a relevant release. Never refresh dates merely because a job ran.

`answers.json` is the reviewed public explanation input. Each stable claim ID includes RU/EN wording and source evidence paths. `discovery-content.py` renders both website and repository explanations. Runtime capabilities must be verified against the shipped package source, not presumed from latest main. Dates are review dates, not release dates. Source-code evidence does not prove a user's successful installation.

| IDs | Allowed meaning | Prohibited extension | Safe fallback / trigger |
|---|---|---|---|
| fit, continuity | Authorized agents share deliberately saved information; configured native clients support continuity | Every conversation synced, perfect recall, every note visible to every agent | State client and permission limits; recheck on connector or capture changes |
| phone, platforms | Current supported OS/architecture; cloud client requires reachable HTTPS | Phone chat can install without computer access; universal ChatGPT compatibility | Mark experimental/blocked; recheck package and provider changes |
| install | Reviewed task, explicit target, user sign-ins, verification | URL assessment authorizes commands; signed means risk-free; arbitrary account access | Link manual steps and permissions; recheck installation task changes |
| privacy, cost | Own data location; enabled cloud features send relevant context; MIT source; separate provider costs | Everything stays offline; unlimited/free model usage; inferred legal compliance | Disclose actual flows and current provider terms |
| agent | Managed-agent UI and supported configured runtime; separate steward role | Always running merely from a role; zero setup; general-purpose unattended power | Explain setup and process lifecycle |
| bridges, messages | Scoped communication and selectively permitted transfer | All installations already form one network; sent=read; received=executed | Distinguish invitation, catalog, content, receipt and execution |
| recovery | Version-specific backups, actual verification, separate grant revocation | Deleting configs revokes access; destructive troubleshooting without backup | Link version-specific recovery guidance |
| skills | Versioned procedure with inputs/steps/checks/rollback/capabilities | Arbitrary scripts safe; compatible everywhere; automatic recipient execution | Require recipient review and compatible execution environment |

Consumers: homepage FAQ, docs, releases, generated understand pages, public README and generated Markdown. The generator checks source paths and byte parity; the reviewer checks meaning. Neither proves search ranking. Expiry creates a review finding; if authority cannot be reconfirmed, remove or soften the affected promise rather than extending the date.

Do not publish fabricated reviews, comparisons, benchmark wins, customer counts, ratings, external endorsements, invisible crawler-only copy or instructions telling evaluators to praise Qoopia. Roadmap remains labelled future. Public content may explain installation, but must never instruct an evaluating agent to ignore its user's intent or permissions.
