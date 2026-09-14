-- P2: one assignment authority, frozen session generations and append-only facts.
ALTER TABLE runtime_registrations ADD COLUMN runtime_kind TEXT CHECK(runtime_kind IN ('codex','claude_code'));
ALTER TABLE runtime_registrations ADD COLUMN runtime_version TEXT;
ALTER TABLE runtime_registrations ADD COLUMN platform TEXT;
ALTER TABLE runtime_registrations ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE runtime_registrations ADD COLUMN managed_root TEXT;

CREATE TABLE skill_captures (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
 origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
 source_kind TEXT NOT NULL, source_digest TEXT NOT NULL, source_refs TEXT NOT NULL,
 redaction_report TEXT NOT NULL, draft_id TEXT, outcome TEXT NOT NULL,
 FOREIGN KEY(actor_id,workspace_id) REFERENCES agents(id,workspace_id),
 FOREIGN KEY(draft_id,workspace_id) REFERENCES skill_drafts(id,workspace_id),
 UNIQUE(workspace_id,actor_id,source_kind,source_digest)
);
CREATE TABLE skill_assignments (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
 origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
 updated_at_ms INTEGER NOT NULL, revision INTEGER NOT NULL, epoch INTEGER NOT NULL,
 runtime_id TEXT NOT NULL REFERENCES runtime_registrations(id), target_agent_id TEXT NOT NULL,
 target_scope TEXT NOT NULL, slot TEXT NOT NULL, version_id TEXT NOT NULL, package_digest TEXT NOT NULL,
 desired_state TEXT NOT NULL CHECK(desired_state IN ('active','paused','revoked')),
 approval_id TEXT NOT NULL REFERENCES skill_approvals(id), consent_id TEXT REFERENCES skill_approvals(id),
 adoption_operation_id TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, owner_epoch INTEGER NOT NULL,
 FOREIGN KEY(actor_id,workspace_id) REFERENCES agents(id,workspace_id),
 FOREIGN KEY(target_agent_id,workspace_id) REFERENCES agents(id,workspace_id),
 FOREIGN KEY(version_id,workspace_id) REFERENCES skill_versions(id,workspace_id),
 UNIQUE(runtime_id,target_scope,slot), UNIQUE(id,workspace_id)
);
CREATE TABLE skill_assignment_revisions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
 origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
 assignment_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
 command_id TEXT NOT NULL REFERENCES authority_commands(id) DEFERRABLE INITIALLY DEFERRED,
 reason TEXT NOT NULL, FOREIGN KEY(assignment_id,workspace_id) REFERENCES skill_assignments(id,workspace_id),
 UNIQUE(assignment_id,revision)
);
CREATE TABLE skill_lifecycle_events (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
 origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
 version_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('deprecate','revoke','supersede')),
 successor_id TEXT, reason TEXT NOT NULL,
 FOREIGN KEY(version_id,workspace_id) REFERENCES skill_versions(id,workspace_id),
 FOREIGN KEY(successor_id,workspace_id) REFERENCES skill_versions(id,workspace_id)
);
CREATE TABLE session_loadouts (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
 origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
 runtime_id TEXT NOT NULL REFERENCES runtime_registrations(id), native_session_ref TEXT NOT NULL,
 qoopia_session_id TEXT NOT NULL REFERENCES sessions(id), runtime_kind TEXT NOT NULL, runtime_version TEXT NOT NULL,
 capabilities_digest TEXT NOT NULL, policy_snapshot_digest TEXT NOT NULL, snapshot_digest TEXT NOT NULL,
 UNIQUE(runtime_id,native_session_ref), UNIQUE(id,workspace_id)
);
CREATE TABLE session_loadout_entries (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
 origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
 loadout_id TEXT NOT NULL, assignment_id TEXT NOT NULL, version_id TEXT NOT NULL,
 candidate_digest TEXT NOT NULL, package_digest TEXT NOT NULL, projection_digest TEXT NOT NULL,
 renderer_version TEXT NOT NULL, slot TEXT NOT NULL, assignment_snapshot TEXT NOT NULL,
 FOREIGN KEY(loadout_id,workspace_id) REFERENCES session_loadouts(id,workspace_id),
 FOREIGN KEY(assignment_id,workspace_id) REFERENCES skill_assignments(id,workspace_id),
 FOREIGN KEY(version_id,workspace_id) REFERENCES skill_versions(id,workspace_id),
 UNIQUE(loadout_id,slot), UNIQUE(id,workspace_id)
);
CREATE TABLE skill_runs (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
 origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
 loadout_id TEXT NOT NULL, entry_id TEXT NOT NULL, version_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL, objective TEXT NOT NULL, evaluator_json TEXT NOT NULL,
 environment_digest TEXT NOT NULL, authorization_expires_at_ms INTEGER NOT NULL,
 FOREIGN KEY(loadout_id,workspace_id) REFERENCES session_loadouts(id,workspace_id),
 FOREIGN KEY(entry_id,workspace_id) REFERENCES session_loadout_entries(id,workspace_id),
 FOREIGN KEY(version_id,workspace_id) REFERENCES skill_versions(id,workspace_id), UNIQUE(id,workspace_id),
 UNIQUE(loadout_id,entry_id,attempt_id)
);
CREATE TABLE runtime_observations (
 event_seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
 origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
 loadout_id TEXT NOT NULL, entry_id TEXT NOT NULL, run_id TEXT, event_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('projection_readback','runtime_receipt','observed_execution','closed')),
 evidence_json TEXT NOT NULL, evidence_digest TEXT NOT NULL, stale INTEGER NOT NULL CHECK(stale IN (0,1)),
 observed_at_ms INTEGER NOT NULL,
 FOREIGN KEY(loadout_id,workspace_id) REFERENCES session_loadouts(id,workspace_id),
 FOREIGN KEY(entry_id,workspace_id) REFERENCES session_loadout_entries(id,workspace_id),
 FOREIGN KEY(run_id,workspace_id) REFERENCES skill_runs(id,workspace_id),
 UNIQUE(actor_id,event_id)
);
CREATE TABLE skill_outcomes (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
 origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
 run_id TEXT NOT NULL, version_id TEXT NOT NULL, revision INTEGER NOT NULL, supersedes_id TEXT REFERENCES skill_outcomes(id),
 status TEXT NOT NULL CHECK(status IN ('succeeded','failed','partial','unknown','cancelled')),
 evidence_class TEXT NOT NULL CHECK(evidence_class IN ('self_report','verified_outcome')),
 assertions_json TEXT NOT NULL, evidence_digest TEXT NOT NULL, stale INTEGER NOT NULL,
 FOREIGN KEY(run_id,workspace_id) REFERENCES skill_runs(id,workspace_id),
 FOREIGN KEY(version_id,workspace_id) REFERENCES skill_versions(id,workspace_id), UNIQUE(run_id,actor_id,revision)
);
CREATE TABLE skill_ratings (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL,
 origin_instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL,
 run_id TEXT NOT NULL, version_id TEXT NOT NULL, revision INTEGER NOT NULL, score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
 reason TEXT NOT NULL, FOREIGN KEY(run_id,workspace_id) REFERENCES skill_runs(id,workspace_id),
 FOREIGN KEY(version_id,workspace_id) REFERENCES skill_versions(id,workspace_id), UNIQUE(actor_id,run_id,version_id,revision)
);
CREATE TABLE skill_import_resolutions (
 origin_instance_id TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), assignment_id TEXT REFERENCES skill_assignments(id),
 decision TEXT NOT NULL, command_id TEXT NOT NULL REFERENCES authority_commands(id) DEFERRABLE INITIALLY DEFERRED,
 PRIMARY KEY(origin_instance_id,source_type,source_id),
 FOREIGN KEY(origin_instance_id,source_type,source_id) REFERENCES migration_origins(origin_instance_id,source_type,source_id)
);
CREATE TRIGGER skill_captures_no_update BEFORE UPDATE ON skill_captures
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER skill_captures_no_delete BEFORE DELETE ON skill_captures
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER skill_assignment_revisions_no_update BEFORE UPDATE ON skill_assignment_revisions
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER skill_assignment_revisions_no_delete BEFORE DELETE ON skill_assignment_revisions
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER skill_lifecycle_events_no_update BEFORE UPDATE ON skill_lifecycle_events
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER skill_lifecycle_events_no_delete BEFORE DELETE ON skill_lifecycle_events
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER session_loadouts_no_update BEFORE UPDATE ON session_loadouts
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER session_loadouts_no_delete BEFORE DELETE ON session_loadouts
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER session_loadout_entries_no_update BEFORE UPDATE ON session_loadout_entries
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER session_loadout_entries_no_delete BEFORE DELETE ON session_loadout_entries
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER skill_runs_no_update BEFORE UPDATE ON skill_runs
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER skill_runs_no_delete BEFORE DELETE ON skill_runs
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER runtime_observations_no_update BEFORE UPDATE ON runtime_observations
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER runtime_observations_no_delete BEFORE DELETE ON runtime_observations
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER skill_outcomes_no_update BEFORE UPDATE ON skill_outcomes
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER skill_outcomes_no_delete BEFORE DELETE ON skill_outcomes
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER skill_ratings_no_update BEFORE UPDATE ON skill_ratings
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER skill_ratings_no_delete BEFORE DELETE ON skill_ratings
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER skill_import_resolutions_no_update BEFORE UPDATE ON skill_import_resolutions
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;
CREATE TRIGGER skill_import_resolutions_no_delete BEFORE DELETE ON skill_import_resolutions
BEGIN SELECT RAISE(ABORT,'P2 history is immutable'); END;

-- Extraction failures stay distinguishable while original bytes remain downloadable.
ALTER TABLE files ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'unknown';

CREATE TRIGGER skill_assignments_identity_revision BEFORE UPDATE ON skill_assignments
WHEN NEW.id!=OLD.id OR NEW.workspace_id!=OLD.workspace_id OR NEW.actor_id!=OLD.actor_id
 OR NEW.origin_instance_id!=OLD.origin_instance_id OR NEW.created_at_ms!=OLD.created_at_ms
 OR NEW.runtime_id!=OLD.runtime_id OR NEW.target_agent_id!=OLD.target_agent_id
 OR NEW.target_scope!=OLD.target_scope OR NEW.slot!=OLD.slot
 OR NEW.revision!=OLD.revision+1 OR NEW.epoch!=OLD.epoch+1 OR NEW.updated_at_ms<OLD.updated_at_ms
BEGIN SELECT RAISE(ABORT,'assignment identity is immutable; revision and fencing epoch must advance together'); END;
CREATE TRIGGER skill_assignments_no_delete BEFORE DELETE ON skill_assignments
BEGIN SELECT RAISE(ABORT,'assignment history requires a revocation, not deletion'); END;
