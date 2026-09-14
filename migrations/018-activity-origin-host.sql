-- 018-activity-origin-host.sql — origin_host column on activity.
-- Phase 2 Item B (plan note 01KSC0E9F1WFWJMSP58KS34H2A), Item A "activity
-- origin_host" decision (Leo R1 OK under Q-P2-1 bundle). Cheap insurance for
-- sync-time disambiguation; Phase 1 item 5 design assumed this column existed
-- implicitly. PK extension deferred until first cross-host conflict surfaces —
-- append-only union behavior unchanged.
--
-- Rollback: /srv/qoopia/code/migrations/rollback/018-activity-origin-host.rollback.sql.

ALTER TABLE activity ADD COLUMN origin_host TEXT NOT NULL DEFAULT '';

INSERT INTO schema_versions (version, description)
  VALUES (18, '018-activity-origin-host.sql');
