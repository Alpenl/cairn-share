-- Link deletion is atomic in D1; R2 cleanup is a retryable outbox.
-- Receipts retain only numeric IDs/times, never deleted content or source URLs.
CREATE TABLE privacy_deletions (
  link_id INTEGER PRIMARY KEY,
  deleted_at TEXT NOT NULL,
  next_cleanup_at TEXT NOT NULL
);
CREATE INDEX privacy_deletions_due_idx ON privacy_deletions(next_cleanup_at, link_id);
CREATE TABLE privacy_maintenance_state (key TEXT PRIMARY KEY, cursor TEXT NOT NULL);

-- Repair legacy orphan accounting. Global (NULL link_id) aggregate budgets stay.
DELETE FROM budget_ledger WHERE link_id IS NOT NULL AND NOT EXISTS
  (SELECT 1 FROM links WHERE links.id=budget_ledger.link_id);
CREATE TRIGGER budget_link_insert BEFORE INSERT ON budget_ledger
WHEN NEW.link_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM links WHERE id=NEW.link_id)
BEGIN SELECT RAISE(ABORT, 'budget_link_missing'); END;
CREATE TRIGGER budget_link_update BEFORE UPDATE OF link_id ON budget_ledger
WHEN NEW.link_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM links WHERE id=NEW.link_id)
BEGIN SELECT RAISE(ABORT, 'budget_link_missing'); END;
CREATE TRIGGER links_privacy_delete AFTER DELETE ON links
BEGIN
  DELETE FROM budget_ledger WHERE link_id=OLD.id;
  INSERT INTO privacy_deletions(link_id,deleted_at,next_cleanup_at)
    VALUES(OLD.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(link_id) DO UPDATE SET deleted_at=excluded.deleted_at,next_cleanup_at=excluded.next_cleanup_at;
  UPDATE cache_metadata SET value=value+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE key='links_generation';
END;
