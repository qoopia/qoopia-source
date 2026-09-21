# Changelog

## 5.0.9 — 2026-09-21

- Theme-aware favicon: black in light browser chrome, white in dark chrome.
- Approved Graphite logo, typography and palette in sign-in and update emails, connection guides and compatibility asset URLs.
- Remove obsolete font payloads; retain readable email font fallbacks.
- iPhone installation page explains native TestFlight access and shows its actual availability.
- Includes the 5.0.8 email-to-dashboard handoff fixes for connected iPhone workspaces. Schema remains 46; existing data and connections are preserved.

## 5.0.8 — 2026-09-21

- Ship the approved Graphite dashboard: Overview on entry, compact single-column navigation and a persistent chat available across pages.
- Keep agent setup, subscription sign-in, real provider/model selection, approvals, Stop and Telegram inside the chat panel; retain drafts and conversations when navigating.
- Apply the exact approved Q mark, wordmark and Manrope to dashboard/account surfaces and the Mac app/tray. Responsive layouts retain mobile touch targets and English/Russian copy.
- Preserve the signed legacy-installation upgrade compatibility fix from 5.0.7. Schema remains 46.
- Native iPhone project is included in source; TestFlight distribution remains pending Apple signing and upload and is not part of this desktop release.

## 5.0.7

- Fix local desktop upgrades from 5.0.4 and earlier inline-dashboard packages.
  The new bundle verifier incorrectly required an extracted dashboard script in
  the old signed installation, stopping launch with “could not prepare this update”.
  Existing data, connections and the normal signature/inventory checks are preserved.
  No database schema change.

## 5.0.6

- Returning from «only on request» to automatic no longer costs a batch of messages. A client
  replays from its own cursor, so the batch that resumes a session carries turns from the manual
  period and turns from after it; the whole batch used to be dropped to be sure of excluding the
  first kind. Each message is now judged on its own: while an agent is manual the server records
  the ids it refuses — identifiers only, never text, role or any digest — and drops exactly those
  on replay. The message timestamp remains the second filter, for a client that was away for the
  whole period. Schema 46.

## 5.0.5

- The owner can confirm or decline a manual agent's prepared save straight from Telegram. The
  question is asked once, only the bound owner can answer it, and a decided or expired request
  never reaches the chat.
- Codex accepted for the first time against the real client, alongside Claude Code. Codex needs its
  project trusted and its hooks trusted once in `/hooks`; `scripts/memory-policy-canary.ts
  --hook-trust bypass` exercises the adapter without that trust and reports which was used.
- Corrected what the manual guarantee covers. A client keeps its own delivery cursor, so a turn
  held during manual can still leave an empty session row once auto returns — an id and a timestamp,
  no messages, no summary, no note. Its content is what never exists. Refusing the row was tried and
  reverted: it dropped the first batch after the switch, losing a real auto turn instead.

## Earlier public releases

# 5.0.3

- Consolidate authorization checks and preserve administrative write access consistently.
- Split dashboard sessions and recall configuration; remove unused code and reduce runtime dependency cycles.
- Parse runtime dependencies with TypeScript and reject new cycles.
- Authenticate packaged inventories and require matching source commits before generating release metadata.