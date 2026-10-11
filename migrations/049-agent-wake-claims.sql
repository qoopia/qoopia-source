-- One wake delivery per recipient at a time across every writer process on this database.
-- The in-process guard only covered one server; a second writer could push the same
-- undelivered backlog into two turns at once. A row is a lease: the holder's token,
-- its expiry (a crashed holder is taken over once it lapses) and a rerun flag a
-- writer that lost the race sets, so the holder re-drives the recipient on release.
-- compatibility: schema-48 builds ignore the table and serialize per process only;
--   run one writer until every writer is on this schema.
-- recovery: restore the pre-migration backup, or run rollback/049 (drops the table;
--   a claim is a seconds-long lease and carries no data).
-- data-after-upgrade: no existing row changes; the table starts empty and holds only live leases.
CREATE TABLE IF NOT EXISTS agent_wake_claims (
  target_agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  holder TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  rerun INTEGER NOT NULL DEFAULT 0 CHECK (rerun IN (0, 1))
) WITHOUT ROWID;
