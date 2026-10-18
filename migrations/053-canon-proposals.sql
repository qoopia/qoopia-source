-- compatibility: schema-52 readers ignore the separate draft table; no active canons change.
-- recovery: restore the pre-migration backup before returning to schema-52 software.
-- data-after-upgrade: accepted canons retain dreaming provenance; drafts remain decision history.
-- Dreaming produces drafts. Only the workspace owner decides whether a draft becomes canon.
CREATE TABLE canon_proposals (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 proposed_by TEXT NOT NULL REFERENCES agents(id),
 request_key TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 reason TEXT NOT NULL,
 source_refs TEXT NOT NULL CHECK(json_valid(source_refs)),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
 canon_id TEXT REFERENCES canons(id),
 decided_by TEXT REFERENCES agents(id),
 created_at TEXT NOT NULL,
 decided_at TEXT,
 UNIQUE(workspace_id,proposed_by,request_key)
);
CREATE INDEX canon_proposals_pending ON canon_proposals(workspace_id,status,created_at);
