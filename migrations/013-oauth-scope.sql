-- migrations/013-oauth-scope.sql
-- Security audit 2026-05-19 / HIGH #1:
-- persist OAuth granted scopes on the unified oauth_tokens table.
--
-- Qoopia stores authorization codes, access tokens, and refresh tokens in
-- the same table (`oauth_tokens`, token_type ∈ {code, access, refresh}),
-- so one nullable column is enough to cover the whole lifecycle.

ALTER TABLE oauth_tokens ADD COLUMN granted_scope TEXT;
