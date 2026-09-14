-- Pin each issued connection to its original OAuth identity, independently of transport changes.
-- The migration runner backfills from issued token / consent audiences in the same transaction.
ALTER TABLE client_connections ADD COLUMN origin TEXT NOT NULL DEFAULT '';
