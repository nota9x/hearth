CREATE UNIQUE INDEX reconciliation_one_running ON reconciliation_runs(status) WHERE status = 'running';
--> statement-breakpoint
CREATE TABLE maintenance_lock (id TEXT PRIMARY KEY NOT NULL, holder TEXT NOT NULL, expiresAt INTEGER NOT NULL);
