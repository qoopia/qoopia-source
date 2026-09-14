-- P1: existing agents and entity_pages remain the identity authority.
CREATE TABLE authority_instance (id TEXT PRIMARY KEY CHECK(id='local'), instance_id TEXT NOT NULL UNIQUE);
INSERT INTO authority_instance VALUES ('local',lower(hex(randomblob(16))));
ALTER TABLE agents ADD COLUMN principal_kind TEXT NOT NULL DEFAULT 'agent'
  CHECK(principal_kind IN ('human','agent','reporter'));
ALTER TABLE agents ADD COLUMN authority_profile TEXT NOT NULL DEFAULT 'memory-worker'
  CHECK(authority_profile IN ('memory-reader','memory-worker','skill-author','skill-reviewer','runtime-reporter','owner'));
ALTER TABLE agents ADD COLUMN policy_epoch INTEGER NOT NULL DEFAULT 1 CHECK(policy_epoch > 0);
-- Eligibility for the old skill API only. Current tool profile/scope still gate every call.
ALTER TABLE agents ADD COLUMN legacy_skill_access INTEGER NOT NULL DEFAULT 0 CHECK(legacy_skill_access IN (0,1));
CREATE TRIGGER authority_epoch_on_policy_change AFTER UPDATE ON agents
WHEN NEW.policy_epoch=OLD.policy_epoch AND
 (NEW.active!=OLD.active OR NEW.type!=OLD.type OR NEW.tool_profile!=OLD.tool_profile
  OR NEW.authority_profile!=OLD.authority_profile OR NEW.principal_kind!=OLD.principal_kind OR NEW.api_key_hash!=OLD.api_key_hash
  OR NEW.legacy_skill_access!=OLD.legacy_skill_access)
BEGIN UPDATE agents SET policy_epoch=policy_epoch+1 WHERE id=NEW.id; END;
CREATE UNIQUE INDEX agents_workspace_identity ON agents(id,workspace_id);
CREATE UNIQUE INDEX entity_workspace_identity ON entity_pages(id,workspace_id);
ALTER TABLE entity_pages ADD COLUMN authority_private INTEGER NOT NULL DEFAULT 0 CHECK(authority_private IN (0,1));
ALTER TABLE entity_pages ADD COLUMN authority_owner_id TEXT REFERENCES agents(id);

CREATE TABLE workspace_owners (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
  actor_id TEXT NOT NULL, origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(actor_id,workspace_id) REFERENCES agents(id,workspace_id)
);
CREATE TRIGGER workspace_owner_human BEFORE INSERT ON workspace_owners
WHEN NOT EXISTS(SELECT 1 FROM agents WHERE id=NEW.actor_id AND workspace_id=NEW.workspace_id
 AND principal_kind='human' AND active=1)
BEGIN SELECT RAISE(ABORT,'owner association requires an active human principal'); END;

CREATE TABLE authority_commands (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
  origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
  operation TEXT NOT NULL, key_digest TEXT NOT NULL, request_digest TEXT NOT NULL,
  subject_id TEXT NOT NULL, response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  UNIQUE(workspace_id,actor_id,operation,key_digest),
  FOREIGN KEY(actor_id,workspace_id) REFERENCES agents(id,workspace_id)
);
CREATE TABLE authority_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
  origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
  command_id TEXT NOT NULL REFERENCES authority_commands(id) DEFERRABLE INITIALLY DEFERRED,
  kind TEXT NOT NULL, subject_id TEXT NOT NULL, details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  FOREIGN KEY(actor_id,workspace_id) REFERENCES agents(id,workspace_id)
);
CREATE TRIGGER authority_events_no_update BEFORE UPDATE ON authority_events
BEGIN SELECT RAISE(ABORT,'authority events are append-only'); END;
CREATE TRIGGER authority_events_no_delete BEFORE DELETE ON authority_events
BEGIN SELECT RAISE(ABORT,'authority events are append-only'); END;
CREATE TRIGGER authority_commands_no_update BEFORE UPDATE ON authority_commands
BEGIN SELECT RAISE(ABORT,'command receipts are immutable'); END;
CREATE TRIGGER authority_commands_no_delete BEFORE DELETE ON authority_commands
BEGIN SELECT RAISE(ABORT,'command receipts are immutable'); END;

CREATE TABLE agent_pairings (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
  origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, updated_at_ms INTEGER NOT NULL,
  code_digest TEXT NOT NULL UNIQUE, name TEXT NOT NULL, profile TEXT NOT NULL,
  principal_kind TEXT NOT NULL CHECK(principal_kind IN ('agent','reporter')),
  target_agent_id TEXT, runtime_id TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, policy_epoch INTEGER NOT NULL,
  redeemed_agent_id TEXT, revoked_at_ms INTEGER,
  FOREIGN KEY(actor_id,workspace_id) REFERENCES agents(id,workspace_id),
  FOREIGN KEY(target_agent_id,workspace_id) REFERENCES agents(id,workspace_id),
  FOREIGN KEY(redeemed_agent_id,workspace_id) REFERENCES agents(id,workspace_id)
);
CREATE TABLE runtime_registrations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
  origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, updated_at_ms INTEGER NOT NULL,
  target_agent_id TEXT NOT NULL, runtime_id TEXT NOT NULL, reporter_id TEXT,
  FOREIGN KEY(actor_id,workspace_id) REFERENCES agents(id,workspace_id),
  FOREIGN KEY(target_agent_id,workspace_id) REFERENCES agents(id,workspace_id),
  FOREIGN KEY(reporter_id,workspace_id) REFERENCES agents(id,workspace_id),
  UNIQUE(workspace_id,target_agent_id,runtime_id)
);

CREATE TABLE skill_drafts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
  origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL, skill_id TEXT NOT NULL UNIQUE,
  parent_skill_id TEXT, head_revision_id TEXT,
  FOREIGN KEY(actor_id,workspace_id) REFERENCES agents(id,workspace_id),
  FOREIGN KEY(skill_id,workspace_id) REFERENCES entity_pages(id,workspace_id),
  FOREIGN KEY(parent_skill_id,workspace_id) REFERENCES entity_pages(id,workspace_id),
  FOREIGN KEY(head_revision_id,workspace_id) REFERENCES skill_draft_revisions(id,workspace_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(id,workspace_id)
);
CREATE TABLE skill_draft_revisions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
  origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
  draft_id TEXT NOT NULL, revision_no INTEGER NOT NULL, parent_revision_id TEXT,
  source_refs TEXT NOT NULL CHECK(json_valid(source_refs)), source_digest TEXT,
  content_json TEXT NOT NULL CHECK(json_valid(content_json)), content_digest TEXT NOT NULL,
  compiler_version TEXT NOT NULL, missing_requirements TEXT NOT NULL CHECK(json_valid(missing_requirements)),
  original_revision_id TEXT, original_digest TEXT, original_compiler_version TEXT,
  legacy_runbook_json TEXT CHECK(legacy_runbook_json IS NULL OR json_valid(legacy_runbook_json)),
  FOREIGN KEY(actor_id,workspace_id) REFERENCES agents(id,workspace_id),
  FOREIGN KEY(draft_id,workspace_id) REFERENCES skill_drafts(id,workspace_id),
  FOREIGN KEY(parent_revision_id,workspace_id) REFERENCES skill_draft_revisions(id,workspace_id),
  UNIQUE(draft_id,revision_no), UNIQUE(id,workspace_id)
);
CREATE TRIGGER skill_revision_no_update BEFORE UPDATE ON skill_draft_revisions
BEGIN SELECT RAISE(ABORT,'skill revisions are immutable'); END;
CREATE TRIGGER skill_revision_no_delete BEFORE DELETE ON skill_draft_revisions
BEGIN SELECT RAISE(ABORT,'skill revisions are immutable'); END;
CREATE TRIGGER skill_head_consistency BEFORE UPDATE ON skill_drafts
WHEN NEW.skill_id!=OLD.skill_id OR NEW.workspace_id!=OLD.workspace_id OR NEW.actor_id!=OLD.actor_id
 OR NEW.origin_instance_id!=OLD.origin_instance_id OR NEW.created_at_ms!=OLD.created_at_ms
 OR NEW.revision<=OLD.revision OR NOT EXISTS(SELECT 1 FROM skill_draft_revisions
   WHERE id=NEW.head_revision_id AND draft_id=NEW.id AND workspace_id=NEW.workspace_id AND revision_no=NEW.revision)
BEGIN SELECT RAISE(ABORT,'skill head must advance to its own immutable revision'); END;
CREATE TRIGGER skill_identity_no_retype BEFORE UPDATE OF type ON entity_pages
WHEN OLD.type='skill' AND NEW.type!='skill'
BEGIN SELECT RAISE(ABORT,'skill identity cannot be retyped'); END;

CREATE TABLE skill_versions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
  origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
  skill_id TEXT NOT NULL, version_label TEXT NOT NULL, candidate_digest TEXT NOT NULL,
  content_digest TEXT NOT NULL, package_digest TEXT, original_format TEXT NOT NULL,
  manifest_schema TEXT NOT NULL, publisher_key_id TEXT, signature_ref TEXT,
  source_revision_id TEXT, lineage_refs TEXT NOT NULL CHECK(json_valid(lineage_refs)), license TEXT NOT NULL,
  descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)), members_json TEXT NOT NULL CHECK(json_valid(members_json)),
  package_bytes BLOB, status TEXT NOT NULL CHECK(status IN ('candidate','sealed','legacy_revision','legacy_immutable')),
  sealed_at_ms INTEGER,
  FOREIGN KEY(actor_id,workspace_id) REFERENCES agents(id,workspace_id),
  FOREIGN KEY(skill_id,workspace_id) REFERENCES entity_pages(id,workspace_id),
  FOREIGN KEY(source_revision_id,workspace_id) REFERENCES skill_draft_revisions(id,workspace_id),
  UNIQUE(skill_id,version_label), UNIQUE(id,workspace_id)
);
CREATE TRIGGER skill_version_frozen BEFORE UPDATE ON skill_versions
WHEN OLD.status!='candidate' OR NEW.status!='sealed'
 OR NEW.id!=OLD.id OR NEW.workspace_id!=OLD.workspace_id OR NEW.actor_id!=OLD.actor_id
 OR NEW.origin_instance_id!=OLD.origin_instance_id OR NEW.schema_version!=OLD.schema_version
 OR NEW.created_at_ms!=OLD.created_at_ms OR NEW.skill_id!=OLD.skill_id OR NEW.version_label!=OLD.version_label
 OR NEW.candidate_digest!=OLD.candidate_digest OR NEW.content_digest!=OLD.content_digest
 OR NEW.original_format!=OLD.original_format OR NEW.manifest_schema!=OLD.manifest_schema
 OR NEW.source_revision_id IS NOT OLD.source_revision_id OR NEW.lineage_refs!=OLD.lineage_refs
 OR NEW.license!=OLD.license OR NEW.descriptor_json!=OLD.descriptor_json OR NEW.members_json!=OLD.members_json
 OR NEW.package_digest IS NULL OR NEW.package_bytes IS NULL OR NEW.sealed_at_ms IS NULL
BEGIN SELECT RAISE(ABORT,'version payload is frozen; only candidate sealing is allowed'); END;
CREATE TRIGGER skill_version_no_delete BEFORE DELETE ON skill_versions
BEGIN SELECT RAISE(ABORT,'skill versions are immutable'); END;

CREATE TABLE skill_approvals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
  origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
  version_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('content_review','local_use','high_risk_adoption','publish_export')),
  candidate_digest TEXT NOT NULL, package_digest TEXT, actor_role TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approve','reject')), evidence_class TEXT NOT NULL,
  capability_scope TEXT NOT NULL, target_scope TEXT NOT NULL, target_agent_id TEXT, runtime_id TEXT,
  operation_id TEXT, expires_at_ms INTEGER NOT NULL, policy_version INTEGER NOT NULL,
  evidence_refs TEXT NOT NULL CHECK(json_valid(evidence_refs)),
  decision_revision INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(actor_id,workspace_id) REFERENCES agents(id,workspace_id),
  FOREIGN KEY(version_id,workspace_id) REFERENCES skill_versions(id,workspace_id),
  FOREIGN KEY(target_agent_id,workspace_id) REFERENCES agents(id,workspace_id)
);
CREATE UNIQUE INDEX skill_approval_revision ON skill_approvals(version_id,actor_id,kind,decision_revision);
CREATE TRIGGER skill_approval_no_update BEFORE UPDATE ON skill_approvals
BEGIN SELECT RAISE(ABORT,'approvals are immutable'); END;

CREATE TABLE publisher_keys (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
  origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
  kid TEXT NOT NULL, public_key TEXT NOT NULL, revoked_at_ms INTEGER,
  FOREIGN KEY(actor_id,workspace_id) REFERENCES agents(id,workspace_id), UNIQUE(workspace_id,kid)
);
CREATE TRIGGER skill_approval_no_delete BEFORE DELETE ON skill_approvals
BEGIN SELECT RAISE(ABORT,'approvals are immutable'); END;

CREATE TABLE migration_runs (
  id TEXT PRIMARY KEY, origin_instance_id TEXT NOT NULL UNIQUE, source_kind TEXT NOT NULL,
  source_digest TEXT NOT NULL, source_schema INTEGER NOT NULL, mapping_version INTEGER NOT NULL,
  build_sha TEXT NOT NULL, mapping_digest TEXT NOT NULL, stage TEXT NOT NULL, last_batch INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL, report_json TEXT NOT NULL
);
CREATE TABLE migration_origins (
  origin_instance_id TEXT NOT NULL REFERENCES migration_runs(origin_instance_id), source_type TEXT NOT NULL,
  source_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), local_type TEXT NOT NULL,
  local_id TEXT NOT NULL, original_row BLOB NOT NULL, row_digest TEXT NOT NULL, disposition TEXT NOT NULL,
  PRIMARY KEY(origin_instance_id,source_type,source_id)
);
CREATE TRIGGER migration_origin_no_update BEFORE UPDATE ON migration_origins
BEGIN SELECT RAISE(ABORT,'original migration rows are immutable'); END;
CREATE TRIGGER migration_origin_no_delete BEFORE DELETE ON migration_origins
BEGIN SELECT RAISE(ABORT,'original migration rows are immutable'); END;

-- Rebuild the existing outbox to add one explicit event kind; retain every row and constraint.
ALTER TABLE memory_event_outbox RENAME TO memory_event_outbox_before036;
DROP INDEX idx_memory_event_outbox_due;
DROP INDEX idx_memory_event_outbox_aggregate;
CREATE TABLE memory_event_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'candidate_proposed', 'candidate_reviewed', 'note_superseded',
    'feedback_recorded', 'export_created', 'import_planned', 'conflict_detected', 'authority_command'
  )),
  aggregate_kind TEXT NOT NULL CHECK (length(aggregate_kind) BETWEEN 1 AND 100),
  aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 512),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(payload) <= 16384),
  destination_id TEXT CHECK (destination_id IS NULL OR length(destination_id) <= 200),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'leased', 'delivered', 'failed', 'dead_letter'
  )),
  lease_owner TEXT CHECK (lease_owner IS NULL OR length(lease_owner) <= 200),
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 200),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered_at TEXT,
  UNIQUE (workspace_id, idempotency_key),
  CHECK ((state = 'delivered' AND delivered_at IS NOT NULL) OR
         (state <> 'delivered' AND delivered_at IS NULL))
);

INSERT INTO memory_event_outbox SELECT * FROM memory_event_outbox_before036;
DROP TABLE memory_event_outbox_before036;
CREATE INDEX IF NOT EXISTS idx_memory_event_outbox_due
  ON memory_event_outbox(state, next_attempt_at, created_at)
  WHERE state IN ('pending', 'failed', 'leased');
CREATE INDEX IF NOT EXISTS idx_memory_event_outbox_aggregate
  ON memory_event_outbox(workspace_id, aggregate_kind, aggregate_id, created_at);
