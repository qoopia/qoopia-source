-- Rollback for 018-activity-origin-host.sql.
-- Same table-rebuild dance as 017 because origin_host is dropped via column
-- removal; we keep all existing triggers + indices intact.

BEGIN TRANSACTION;

CREATE TABLE activity_rollback_018 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT REFERENCES agents(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  project_id TEXT REFERENCES notes(id),
  summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  visibility TEXT NOT NULL DEFAULT 'workspace'
    CHECK (visibility IN ('workspace', 'private'))
);

INSERT INTO activity_rollback_018
  (id, workspace_id, agent_id, action, entity_type, entity_id, project_id,
   summary, details, created_at, visibility)
SELECT id, workspace_id, agent_id, action, entity_type, entity_id, project_id,
       summary, details, created_at, visibility
  FROM activity;

DROP TABLE activity;
ALTER TABLE activity_rollback_018 RENAME TO activity;

CREATE INDEX idx_activity_workspace ON activity(workspace_id, created_at DESC);
CREATE INDEX idx_activity_entity ON activity(entity_type, entity_id);
CREATE INDEX idx_activity_project ON activity(project_id, created_at DESC) WHERE project_id IS NOT NULL;
CREATE INDEX idx_activity_visibility_owner ON activity(workspace_id, visibility, agent_id);

CREATE TRIGGER activity_ai AFTER INSERT ON activity BEGIN
  INSERT INTO activity_fts(rowid, summary) VALUES (new.rowid, new.summary);
END;
CREATE TRIGGER activity_ad AFTER DELETE ON activity BEGIN
  INSERT INTO activity_fts(activity_fts, rowid, summary) VALUES('delete', old.rowid, old.summary);
END;

DELETE FROM schema_versions WHERE version = 18;

COMMIT;
