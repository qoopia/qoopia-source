# HTTP, OAuth, dashboard, and V3 compatibility

## Existing routes

The following surfaces remain available with their current methods, auth, rate limits, envelopes, and security controls:

- `/health`, `/mcp`, and `/mcp/`;
- `/.well-known/oauth-authorization-server*` and `/.well-known/oauth-protected-resource*`;
- `/oauth/authorize*`, `/oauth/token`, `/oauth/revoke`, `/oauth/register`;
- `/dashboard` and existing `/api/dashboard/*` routes;
- `/ingest/allowlist` and `/ingest/session`.

V4 dashboard routes live under `/api/dashboard/v4/*`. They reuse the service authorization result and existing dashboard session, origin, CSRF, CSP, SameSite, and workspace controls. UI code cannot infer or widen authorization.

## Additive health fields

Existing `version`, `release_sha`, `server_role`, `instance_id`, and `writes_enabled` fields remain. V4 may add:

- `schema_version` as an integer;
- `feature_flags` as booleans only, without raw environment/config values;
- `build_commit` as the immutable full SHA.

## V3 server/client matrix

| Scenario | Frozen result |
|---|---|
| V3 client against V4 flags off | baseline tool schemas/required fields/default result fields unchanged |
| V3 client against V4 flags on | baseline fields remain; additive fields are ignorable |
| V3 server binary against schema 32 | starts and reads/writes existing tables; ignores additive tables |
| disabled V4 option explicitly requested | stable `FEATURE_DISABLED`, never silent activation |
| unknown/newer export or schema | fail closed during plan; no apply |
| unknown role/profile/workspace | deny/fail closed |

OAuth scopes preserve the current risk mapping in `tool-contract.json`. Instance role remains a database and handler boundary: `legacy-readonly` opens SQLite read-only and rejects every write-risk tool, including compatibility calls.
