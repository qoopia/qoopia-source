CREATE TABLE workspaces(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE TABLE agents(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  type TEXT NOT NULL CHECK(type IN ('human','agent','service')),
  tool_profile TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','merged')),
  merged_into_agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
  passport_ref TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  UNIQUE(workspace_id,name)
);
CREATE TABLE workspace_memberships(
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','reviewer','member')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  PRIMARY KEY(agent_id,workspace_id)
);
CREATE TABLE api_keys(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL CHECK(length(key_hash)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  revoked_at_ms INTEGER
);
CREATE TABLE signing_keys(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  kid TEXT NOT NULL UNIQUE CHECK(kid NOT GLOB '*[^a-z0-9-]*' AND length(kid) BETWEEN 1 AND 64),
  public_key_ed25519 TEXT NOT NULL CHECK(length(public_key_ed25519)=43),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  revoked_at_ms INTEGER
, secret_ref TEXT);
CREATE TABLE skills(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL CHECK(slug NOT GLOB '*[^a-z0-9-]*' AND length(slug) BETWEEN 3 AND 64),
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  access_policy TEXT NOT NULL DEFAULT 'private' CHECK(access_policy IN ('private','invite','workspace','public')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  UNIQUE(workspace_id,slug)
);
CREATE TABLE skill_access_grants(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  grantee_workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  grantee_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  granted_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  CHECK((grantee_workspace_id IS NULL) <> (grantee_agent_id IS NULL))
);
CREATE TABLE skill_versions(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  semantic_version TEXT NOT NULL CHECK(length(semantic_version) BETWEEN 5 AND 32),
  author_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK(length(manifest_hash)=64),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  package_blob_ref TEXT NOT NULL,
  signature_jws TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','linted','reviewed','verified','published','deprecated','superseded','revoked')),
  supersedes_version_id TEXT REFERENCES skill_versions(id) ON DELETE RESTRICT,
  superseded_by_version_id TEXT REFERENCES skill_versions(id) ON DELETE RESTRICT,
  revocation_reason TEXT,
  deprecation_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0), source_hash TEXT,
  UNIQUE(skill_id,semantic_version)
);
CREATE TABLE lint_reports(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  gate TEXT NOT NULL CHECK(gate IN ('schema','secrets','pinning','urls','shell','injection','staleness','compat')),
  result TEXT NOT NULL CHECK(result IN ('pass','fail','warn')),
  details_json TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE TABLE reviews(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  reviewer_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  verdict TEXT NOT NULL CHECK(verdict IN ('approve','reject','conditional')),
  note TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE TABLE attestations(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  attester_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 40),
  payload_json TEXT,
  signature_jws TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE TABLE adoption_receipts(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  adoption_request_id TEXT NOT NULL UNIQUE REFERENCES adoption_requests(id) ON DELETE RESTRICT,
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  adopter_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE TABLE approvals(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  adoption_request_id TEXT REFERENCES adoption_requests(id) ON DELETE RESTRICT,
  approver_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL CHECK(scope IN ('publish','adopt_high_risk')),
  decision TEXT NOT NULL CHECK(decision IN ('approved','denied')),
  note TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  -- per-adoption approval MUST bind the exact adoption_request; publish approval binds the version only
  CHECK((scope='adopt_high_risk' AND adoption_request_id IS NOT NULL)
     OR (scope='publish' AND adoption_request_id IS NULL)),
  UNIQUE(adoption_request_id,scope)
);
CREATE TABLE ratings(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  rater_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  adoption_receipt_id TEXT NOT NULL REFERENCES adoption_receipts(id) ON DELETE RESTRICT,
  score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
  note TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  UNIQUE(skill_version_id,rater_agent_id)
);
CREATE TABLE transparency_log(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_kind TEXT NOT NULL CHECK(length(event_kind) BETWEEN 1 AND 60),
  subject_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  prev_hash TEXT NOT NULL CHECK(length(prev_hash)=64),
  this_hash TEXT NOT NULL CHECK(length(this_hash)=64),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE TABLE activity_log(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  actor_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  subject_id TEXT,
  details_json TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE TABLE webhooks(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK(url LIKE 'https://%' OR url LIKE 'http://localhost%' OR url LIKE 'http://127.0.0.1%'),
  secret_hash TEXT NOT NULL CHECK(length(secret_hash)=64),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','failing','dead')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>0)
, secret_ref TEXT);
CREATE TABLE idempotency_keys(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  actor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  surface TEXT NOT NULL,
  key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  UNIQUE(actor_agent_id,surface,key)
);
CREATE TABLE "adoption_requests"(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  adopter_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  requester_context_json TEXT,
  -- §5.2: `approval_pending` added; a request awaiting a §7.3 human approval
  -- is not claimable and cannot be adopted.
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','pushed','dead_letter','approval_pending')),
  -- §5.2 adds `approval_denied` (a decision) and `endpoint_missing` (no
  -- endpoint was selectable for this adopter).
  dead_letter_reason TEXT CHECK(dead_letter_reason IS NULL OR dead_letter_reason IN ('max_attempts','stale_lease','endpoint_dead','approval_denied','endpoint_missing')),
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  -- §5.2: the ONE endpoint selected for this request, snapshotted at creation
  webhook_id TEXT REFERENCES webhooks(id) ON DELETE SET NULL,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
, notification_kind TEXT NOT NULL DEFAULT 'adoption'
  CHECK(notification_kind IN ('adoption','revocation')));
CREATE TABLE transfer_grants(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('receive','assign','activate','revoke','report_outcome')),
  recipient_scope TEXT NOT NULL CHECK(recipient_scope IN ('local_agent','remote_fleet')),
  granted_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  granted_by_type TEXT NOT NULL CHECK(granted_by_type IN ('human','agent','service')),
  granted_by_role TEXT NOT NULL CHECK(granted_by_role IN ('owner','admin','reviewer','member')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  UNIQUE(agent_id,action,recipient_scope)
);
CREATE TABLE transfers(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  sender_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  sender_type TEXT NOT NULL CHECK(sender_type IN ('human','agent','service')),
  sender_role TEXT NOT NULL CHECK(sender_role IN ('owner','admin','reviewer','member')),
  recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('local_agent','remote_fleet')),
  recipient_ref TEXT NOT NULL CHECK(length(recipient_ref) BETWEEN 1 AND 120),
  grant_id TEXT NOT NULL REFERENCES transfer_grants(id) ON DELETE RESTRICT,
  grant_action TEXT NOT NULL CHECK(grant_action IN ('receive','assign','activate','revoke','report_outcome')),
  grantor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  grantor_type TEXT NOT NULL CHECK(grantor_type IN ('human','agent','service')),
  grantor_role TEXT NOT NULL CHECK(grantor_role IN ('owner','admin','reviewer','member')),
  arrival_marker TEXT NOT NULL CHECK(length(arrival_marker)=22),
  adoption_receipt_id TEXT NOT NULL UNIQUE REFERENCES adoption_receipts(id) ON DELETE RESTRICT,
  receipt_event_seq INTEGER NOT NULL CHECK(receipt_event_seq>=1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE TABLE assignments(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('local_agent','remote_fleet')),
  transfer_id TEXT NOT NULL UNIQUE REFERENCES transfers(id) ON DELETE RESTRICT,
  assigned_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  assigned_by_type TEXT NOT NULL CHECK(assigned_by_type IN ('human','agent','service')),
  assigned_by_role TEXT NOT NULL CHECK(assigned_by_role IN ('owner','admin','reviewer','member')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE TABLE assignment_events(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE RESTRICT,
  event TEXT NOT NULL CHECK(event IN ('assigned','queued','activating','active','drifted','failed','paused','revoked')),
  event_seq INTEGER NOT NULL CHECK(event_seq>=1),
  reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 200),
  actor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('human','agent','service')),
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin','reviewer','member')),
  grant_id TEXT REFERENCES transfer_grants(id) ON DELETE RESTRICT,
  grant_action TEXT CHECK(grant_action IS NULL OR grant_action IN ('receive','assign','activate','revoke','report_outcome')),
  activation_target TEXT CHECK(activation_target IS NULL OR activation_target IN ('claude_code_personal','claude_code_project','claude_code_plugin','codex')),
  native_relpath TEXT CHECK(native_relpath IS NULL OR (length(native_relpath) BETWEEN 1 AND 400 AND substr(native_relpath,1,1)<>'/' AND instr(native_relpath,'..')=0)),
  managed_copy TEXT CHECK(managed_copy IS NULL OR managed_copy IN ('written','removed','absent','retained')),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  idempotency_key TEXT NOT NULL,
  UNIQUE(assignment_id,event_seq),
  UNIQUE(assignment_id,idempotency_key)
);
CREATE TABLE runtime_observations(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  runtime TEXT NOT NULL CHECK(runtime IN ('claude_code','codex')),
  model TEXT CHECK(model IS NULL OR length(model) BETWEEN 1 AND 200),
  session_active INTEGER CHECK(session_active IS NULL OR session_active IN (0,1)),
  last_activity_ms INTEGER CHECK(last_activity_ms IS NULL OR last_activity_ms>0),
  selection_window TEXT NOT NULL CHECK(selection_window IN ('live_session','period','all_time')),
  window_detail TEXT NOT NULL CHECK(length(window_detail) BETWEEN 1 AND 500),
  proposal_inventory_complete INTEGER NOT NULL CHECK(proposal_inventory_complete IN (0,1)),
  records_read INTEGER NOT NULL CHECK(records_read>=0),
  reported_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  reported_by_type TEXT NOT NULL CHECK(reported_by_type IN ('human','agent','service')),
  reported_by_role TEXT NOT NULL CHECK(reported_by_role IN ('owner','admin','reviewer','member')),
  grant_id TEXT REFERENCES transfer_grants(id) ON DELETE RESTRICT,
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  idempotency_key TEXT NOT NULL
);
CREATE TABLE observed_records(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  observation_id TEXT NOT NULL REFERENCES runtime_observations(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  runtime TEXT NOT NULL CHECK(runtime IN ('claude_code','codex')),
  role TEXT NOT NULL CHECK(role IN ('proposal','call','output')),
  call_id TEXT CHECK(call_id IS NULL OR length(call_id) BETWEEN 1 AND 200),
  at_ms INTEGER CHECK(at_ms IS NULL OR at_ms>0),
  marker TEXT NOT NULL CHECK(marker GLOB 'SKLN1-[0-9A-HJKMNP-TV-Z]*' AND length(marker)=22),
  result TEXT NOT NULL CHECK(result IN ('success','failure','unknown')),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
, evidence TEXT
  CHECK(evidence IS NULL OR (length(evidence) BETWEEN 2 AND 4000)));
CREATE TABLE "receipt_events"(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  adoption_receipt_id TEXT NOT NULL REFERENCES adoption_receipts(id) ON DELETE RESTRICT,
  event TEXT NOT NULL CHECK(event IN ('delivered','attempted','adopted','failed','rolled_back','transferred','requested')),
  event_seq INTEGER NOT NULL CHECK(event_seq>=1),
  evidence_json TEXT,
  failure_report_json TEXT,
  rollback_report_json TEXT,
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  idempotency_key TEXT NOT NULL,
  environment_json TEXT,
  recipient_json TEXT,
  UNIQUE(adoption_receipt_id,idempotency_key),
  UNIQUE(adoption_receipt_id,event_seq),
  UNIQUE(adoption_receipt_id,event)
);
CREATE TABLE captures(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  captured_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('workflow','session','native_skill')),
  source_format TEXT NOT NULL CHECK(source_format IN ('workflow_text','agent_session','claude_code_skill','codex_skill')),
  source_ref TEXT CHECK(source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 200),
  redacted_source TEXT NOT NULL CHECK(length(redacted_source) BETWEEN 1 AND 200000),
  source_digest TEXT NOT NULL CHECK(length(source_digest)=71),
  category TEXT NOT NULL CHECK(category IN ('reusable_procedure','memory','rule','automation','connector','loadout','one_off','ambiguous')),
  skillable INTEGER NOT NULL CHECK(skillable IN (0,1)),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
  outcome TEXT NOT NULL CHECK(outcome IN ('drafted','refused')),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE TABLE draft_revisions(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  draft_id TEXT NOT NULL CHECK(length(draft_id)=26),
  revision INTEGER NOT NULL CHECK(revision>=1),
  parent_revision_id TEXT REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  author_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK(origin IN ('capture','edit','recompile')),
  compiler_version TEXT NOT NULL CHECK(length(compiler_version) BETWEEN 1 AND 32),
  content_json TEXT NOT NULL CHECK(length(content_json) BETWEEN 2 AND 200000),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71),
  semantic_json TEXT NOT NULL CHECK(length(semantic_json) BETWEEN 2 AND 100000),
  security_json TEXT NOT NULL CHECK(length(security_json) BETWEEN 2 AND 100000),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  UNIQUE(draft_id, revision)
);
CREATE TABLE draft_events(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  draft_id TEXT CHECK(draft_id IS NULL OR length(draft_id)=26),
  draft_revision_id TEXT REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE RESTRICT,
  event TEXT NOT NULL CHECK(event IN ('captured','classified','compiled','revised','refused')),
  actor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin','reviewer','member')),
  source TEXT NOT NULL CHECK(source IN ('registry','owner','agent')),
  correlation_ref TEXT CHECK(correlation_ref IS NULL OR length(correlation_ref) BETWEEN 1 AND 200),
  reason_code TEXT CHECK(reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 64),
  result TEXT NOT NULL CHECK(result IN ('drafted','refused','recorded')),
  content_digest TEXT CHECK(content_digest IS NULL OR length(content_digest)=71),
  provenance_json TEXT NOT NULL CHECK(length(provenance_json) BETWEEN 2 AND 20000),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE TABLE owner_session_revocations(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  session_id TEXT NOT NULL UNIQUE REFERENCES owner_sessions(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK(reason_code IN ('logout','superseded')),
  revoked_at_ms INTEGER NOT NULL CHECK(revoked_at_ms>0)
);
CREATE TABLE console_ticket_uses(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  ticket_id TEXT NOT NULL UNIQUE REFERENCES console_tickets(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES owner_sessions(id) ON DELETE RESTRICT,
  used_at_ms INTEGER NOT NULL CHECK(used_at_ms>0)
);
CREATE TABLE draft_decisions(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  draft_id TEXT NOT NULL UNIQUE CHECK(length(draft_id)=26),
  draft_revision_id TEXT NOT NULL REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
  actor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin')),
  source TEXT NOT NULL CHECK(source IN ('owner')),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
  reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71),
  provenance_json TEXT NOT NULL CHECK(length(provenance_json) BETWEEN 2 AND 20000),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  CHECK(decision='approved' OR reason IS NOT NULL)
);
CREATE TABLE revision_approvals(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  draft_id TEXT NOT NULL CHECK(length(draft_id)=26),
  draft_revision_id TEXT NOT NULL UNIQUE REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>=1),
  actor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin')),
  source TEXT NOT NULL CHECK(source IN ('owner')),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71),
  provenance_json TEXT NOT NULL CHECK(length(provenance_json) BETWEEN 2 AND 20000),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE TABLE skill_assignments(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL CHECK(length(draft_id)=26),
  created_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_by_role TEXT NOT NULL CHECK(created_by_role IN ('owner','admin')),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE TABLE skill_assignment_events(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  assignment_id TEXT NOT NULL REFERENCES skill_assignments(id) ON DELETE RESTRICT,
  event_seq INTEGER NOT NULL CHECK(event_seq>=1),
  event TEXT NOT NULL CHECK(event IN ('assigned','activated','paused','revoked','revision_selected')),
  desired_state TEXT NOT NULL CHECK(desired_state IN ('assigned','active','paused','revoked')),
  desired_revision_id TEXT NOT NULL REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  effective_from TEXT NOT NULL CHECK(effective_from IN ('next_session')),
  actor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin')),
  source TEXT NOT NULL CHECK(source IN ('owner')),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
  reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71),
  provenance_json TEXT NOT NULL CHECK(length(provenance_json) BETWEEN 2 AND 20000),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  UNIQUE(assignment_id,event_seq)
);
CREATE TABLE assignment_observations(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  assignment_id TEXT NOT NULL REFERENCES skill_assignments(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  observed_status TEXT NOT NULL CHECK(observed_status IN ('proposed','loaded','invoked','unknown')),
  draft_revision_id TEXT REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  session_ref TEXT CHECK(session_ref IS NULL OR length(session_ref) BETWEEN 1 AND 200),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
  source TEXT NOT NULL CHECK(source IN ('backend','adapter','runtime')),
  reported_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms>0),
  provenance_json TEXT NOT NULL CHECK(length(provenance_json) BETWEEN 2 AND 20000),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE TABLE idempotency_request_digests(
  idempotency_key_id TEXT PRIMARY KEY REFERENCES idempotency_keys(id) ON DELETE CASCADE,
  request_digest TEXT NOT NULL CHECK(length(request_digest)=71),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE TABLE agent_sessions(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  runtime_kind TEXT NOT NULL CHECK(runtime_kind IN ('codex','claude_code')),
  runtime_version TEXT NOT NULL CHECK(length(runtime_version) BETWEEN 1 AND 64),
  adapter_version TEXT NOT NULL CHECK(length(adapter_version) BETWEEN 1 AND 64),
  opened_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  opened_by_source TEXT NOT NULL CHECK(opened_by_source IN ('backend','adapter','runtime')),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE TABLE session_loadouts(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  session_id TEXT NOT NULL UNIQUE REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  runtime_kind TEXT NOT NULL CHECK(runtime_kind IN ('codex','claude_code')),
  runtime_version TEXT NOT NULL CHECK(length(runtime_version) BETWEEN 1 AND 64),
  adapter_version TEXT NOT NULL CHECK(length(adapter_version) BETWEEN 1 AND 64),
  entry_count INTEGER NOT NULL CHECK(entry_count>=0),
  loadout_digest TEXT NOT NULL CHECK(length(loadout_digest)=71),
  provenance_json TEXT NOT NULL CHECK(length(provenance_json) BETWEEN 2 AND 20000),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE TABLE session_loadout_entries(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  loadout_id TEXT NOT NULL REFERENCES session_loadouts(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK(position>=1),
  assignment_id TEXT NOT NULL REFERENCES skill_assignments(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL CHECK(length(draft_id)=26),
  draft_revision_id TEXT NOT NULL REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>=1),
  skill_name TEXT NOT NULL CHECK(length(skill_name) BETWEEN 1 AND 64),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  UNIQUE(loadout_id,assignment_id),
  UNIQUE(loadout_id,position),
  UNIQUE(loadout_id,skill_name)
);
CREATE TABLE runtime_receipts(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  loadout_id TEXT NOT NULL REFERENCES session_loadouts(id) ON DELETE RESTRICT,
  loadout_entry_id TEXT NOT NULL REFERENCES session_loadout_entries(id) ON DELETE RESTRICT,
  assignment_id TEXT NOT NULL REFERENCES skill_assignments(id) ON DELETE RESTRICT,
  draft_revision_id TEXT NOT NULL REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71),
  stage TEXT NOT NULL CHECK(stage IN ('loaded','invoked')),
  runtime_session_ref TEXT NOT NULL CHECK(length(runtime_session_ref) BETWEEN 1 AND 200),
  invocation_ref TEXT CHECK(invocation_ref IS NULL OR length(invocation_ref) BETWEEN 1 AND 200),
  reported_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK(source IN ('backend','adapter','runtime')),
  receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=71),
  payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 2 AND 20000),
  observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms>0),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  CHECK(stage<>'invoked' OR invocation_ref IS NOT NULL)
);
CREATE TABLE session_closures(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  session_id TEXT NOT NULL UNIQUE REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  closed_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK(source IN ('backend','adapter','runtime')),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
  entries_without_outcome INTEGER NOT NULL CHECK(entries_without_outcome>=0),
  closed_at_ms INTEGER NOT NULL CHECK(closed_at_ms>0),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE TABLE session_outcomes(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  loadout_id TEXT NOT NULL REFERENCES session_loadouts(id) ON DELETE RESTRICT,
  loadout_entry_id TEXT NOT NULL REFERENCES session_loadout_entries(id) ON DELETE RESTRICT,
  assignment_id TEXT NOT NULL REFERENCES skill_assignments(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL CHECK(length(draft_id)=26),
  draft_revision_id TEXT NOT NULL REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71),
  outcome TEXT NOT NULL CHECK(outcome IN ('worked','failed','rolled_back','nothing_reported')),
  evidence_class TEXT NOT NULL CHECK(evidence_class IN ('runtime_receipt','owner_confirmation','session_closed','rollback_confirmation')),
  outcome_ref TEXT NOT NULL CHECK(length(outcome_ref) BETWEEN 1 AND 200),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
  source TEXT NOT NULL CHECK(source IN ('backend','adapter','runtime','owner')),
  confirmation_source TEXT CHECK(confirmation_source IS NULL OR length(confirmation_source) BETWEEN 1 AND 200),
  runtime_session_ref TEXT CHECK(runtime_session_ref IS NULL OR length(runtime_session_ref) BETWEEN 1 AND 200),
  invocation_ref TEXT CHECK(invocation_ref IS NULL OR length(invocation_ref) BETWEEN 1 AND 200),
  invocation_receipt_id TEXT REFERENCES runtime_receipts(id) ON DELETE RESTRICT,
  rollback_to_revision_id TEXT REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  rollback_action_event_id TEXT REFERENCES skill_assignment_events(id) ON DELETE RESTRICT,
  reported_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  outcome_digest TEXT NOT NULL CHECK(length(outcome_digest)=71),
  payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 2 AND 20000),
  observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms>0),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  UNIQUE(loadout_entry_id,outcome_ref),
  CHECK(outcome<>'worked' OR (evidence_class='runtime_receipt' AND invocation_receipt_id IS NOT NULL) OR evidence_class='owner_confirmation'),
  CHECK(outcome<>'rolled_back' OR (rollback_to_revision_id IS NOT NULL AND rollback_action_event_id IS NOT NULL)),
  CHECK((outcome='nothing_reported')=(evidence_class='session_closed')),
  CHECK((source='owner')=(evidence_class='owner_confirmation')),
  CHECK(evidence_class<>'owner_confirmation' OR confirmation_source IS NOT NULL)
);
CREATE TABLE outcome_conflicts(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  loadout_entry_id TEXT NOT NULL REFERENCES session_loadout_entries(id) ON DELETE RESTRICT,
  outcome_ref TEXT NOT NULL CHECK(length(outcome_ref) BETWEEN 1 AND 200),
  existing_outcome_id TEXT NOT NULL REFERENCES session_outcomes(id) ON DELETE RESTRICT,
  existing_outcome TEXT NOT NULL CHECK(existing_outcome IN ('worked','failed','rolled_back','nothing_reported')),
  claimed_outcome TEXT NOT NULL CHECK(claimed_outcome IN ('worked','failed','rolled_back','nothing_reported')),
  claimed_payload_json TEXT NOT NULL CHECK(length(claimed_payload_json) BETWEEN 2 AND 20000),
  conflict_digest TEXT NOT NULL CHECK(length(conflict_digest)=71),
  reported_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK(source IN ('backend','adapter','runtime','owner')),
  observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms>0),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE TABLE revision_sources(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  draft_id TEXT NOT NULL CHECK(length(draft_id)=26),
  draft_revision_id TEXT NOT NULL UNIQUE REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  parent_revision_id TEXT NOT NULL REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK(origin IN ('failure','feedback')),
  source_outcome_id TEXT NOT NULL REFERENCES session_outcomes(id) ON DELETE RESTRICT,
  source_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  source_receipt_id TEXT REFERENCES runtime_receipts(id) ON DELETE RESTRICT,
  observation TEXT NOT NULL CHECK(length(observation) BETWEEN 1 AND 2000),
  improvement_goal TEXT NOT NULL CHECK(length(improvement_goal) BETWEEN 1 AND 2000),
  goal_kind TEXT NOT NULL CHECK(goal_kind IN ('failure_to_worked','declared_binary')),
  created_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE TABLE revision_comparisons(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL CHECK(length(draft_id)=26),
  revision_source_id TEXT NOT NULL REFERENCES revision_sources(id) ON DELETE RESTRICT,
  baseline_revision_id TEXT NOT NULL REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  candidate_revision_id TEXT NOT NULL REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  baseline_outcome_id TEXT NOT NULL REFERENCES session_outcomes(id) ON DELETE RESTRICT,
  candidate_outcome_id TEXT NOT NULL REFERENCES session_outcomes(id) ON DELETE RESTRICT,
  baseline_outcome TEXT NOT NULL CHECK(baseline_outcome IN ('worked','failed','rolled_back','nothing_reported')),
  candidate_outcome TEXT NOT NULL CHECK(candidate_outcome IN ('worked','failed','rolled_back','nothing_reported')),
  comparable INTEGER NOT NULL CHECK(comparable IN (0,1)),
  scenario_json TEXT NOT NULL CHECK(length(scenario_json) BETWEEN 2 AND 8000),
  improvement_goal TEXT NOT NULL CHECK(length(improvement_goal) BETWEEN 1 AND 2000),
  goal_kind TEXT NOT NULL CHECK(goal_kind IN ('failure_to_worked','declared_binary')),
  verdict TEXT NOT NULL CHECK(verdict IN ('improved','not_improved','not_comparable')),
  verdict_reason_code TEXT NOT NULL CHECK(length(verdict_reason_code) BETWEEN 1 AND 64),
  verdict_reason TEXT NOT NULL CHECK(length(verdict_reason) BETWEEN 1 AND 2000),
  created_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE TABLE console_tickets(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin','reviewer')),
  ticket_hash TEXT NOT NULL UNIQUE CHECK(length(ticket_hash)=71),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  expires_at_ms INTEGER NOT NULL,
  CHECK(expires_at_ms - created_at_ms BETWEEN 1 AND 300000)
);
CREATE TABLE owner_sessions(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin','reviewer')),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=71),
  csrf_token TEXT NOT NULL CHECK(length(csrf_token) BETWEEN 16 AND 128),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  absolute_expires_at_ms INTEGER NOT NULL,
  CHECK(absolute_expires_at_ms - created_at_ms BETWEEN 1 AND 3600000)
);
PRAGMA user_version=19;
