-- Wake SLO probes — per-probe telemetry for AgentComm wake-push reliability.
-- Phase 1 plan note 01KSBK5KDR6532W95YV11M4VVS (item 1). Spec doc at
-- /srv/qoopia/eval/wake-slo-spec.md.
--
-- Host-local telemetry: explicitly EXCLUDED from any future shadow sync
-- (item 5). Stores metadata only — no message bodies.

CREATE TABLE IF NOT EXISTS wake_slo_probes (
  probe_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  direction        TEXT NOT NULL CHECK (direction IN ('C2L','L2C')),
  started_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  wake_attempted   INTEGER NOT NULL DEFAULT 0 CHECK (wake_attempted IN (0,1)),
  wake_ok          INTEGER NOT NULL DEFAULT 0 CHECK (wake_ok IN (0,1)),
  ack_latency_ms   INTEGER,
  reply_latency_ms INTEGER,
  status           TEXT NOT NULL CHECK (status IN ('ok','failed')),
  error_class      TEXT CHECK (error_class IN (
                     'wake_push_failed',
                     'ack_timeout',
                     'reply_timeout',
                     'error_envelope',
                     'protocol_mismatch',
                     'unexplained_hang'
                   )),
  session_id       TEXT
);

-- Primary read pattern: rolling window scans per direction for the SLO
-- query in /srv/qoopia/eval/wake-slo-spec.md "Acceptance test".
CREATE INDEX IF NOT EXISTS idx_wake_slo_probes_direction_started
  ON wake_slo_probes(direction, started_at DESC);

-- Forensic read pattern: enumerate unexplained_hang rows quickly to
-- attach session_id when alerting.
CREATE INDEX IF NOT EXISTS idx_wake_slo_probes_error_class
  ON wake_slo_probes(error_class)
  WHERE error_class IS NOT NULL;

INSERT INTO schema_versions (version, description)
  VALUES (16, 'wake_slo_probes — Phase 1 item 1');
