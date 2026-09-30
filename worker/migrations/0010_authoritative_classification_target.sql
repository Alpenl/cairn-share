-- B01: authoritative server-side classification target, version competition and
-- partial invalidation.
--
-- A target is an immutable (spec_id, taxonomy_version, policy_version,
-- requested_model) tuple at a monotonically increasing generation. Consumers
-- declare capabilities and may only claim jobs bound to a target they support;
-- they can no longer redefine the server target with their own policy/model.
--
-- No historical backfill: existing jobs are bound to generation 0 ("legacy")
-- and the initial target is seeded explicitly so operators opt in to v2.

CREATE TABLE classification_targets (
  generation INTEGER PRIMARY KEY,
  spec_id TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  -- 'legacy' keeps the pre-v2 consumer contract; 'v2' requires the negotiated
  -- capabilities handshake. Rollback points a new generation back at an old
  -- spec without ever decrementing generation.
  protocol TEXT NOT NULL DEFAULT 'legacy',
  created_at TEXT NOT NULL,
  note TEXT
);

-- The active target is a pointer, not a mutated row, so readers never observe
-- a partially written spec.
CREATE TABLE classification_target_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO classification_targets(generation, spec_id, spec_hash, taxonomy_version, policy_version, requested_model, protocol, created_at, note)
VALUES (0, 'legacy', 'legacy', '', '', '', 'legacy', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'pre-v2 compatibility target');
INSERT INTO classification_target_state(id, generation, updated_at)
VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Bind every job to the generation it was claimed for and the immutable spec it
-- was compiled against. generation 0 == legacy/unbound.
ALTER TABLE classification_jobs ADD COLUMN target_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE classification_jobs ADD COLUMN spec_id TEXT NOT NULL DEFAULT '';
ALTER TABLE classification_jobs ADD COLUMN input_revision INTEGER NOT NULL DEFAULT 1;

-- Idempotent completion: the operation key is the caller-visible identity of a
-- commit. Same key + same payload returns the stored result verbatim; same key
-- with a different payload is a hard conflict. This is what lets a worker whose
-- completion response was lost re-query instead of paying for a second
-- inference.
CREATE TABLE classification_operations (
  operation_key TEXT PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX classification_operations_link_idx ON classification_operations(link_id);

-- Input changes bump input_revision as well as revision. revision keeps its old
-- meaning (queue/attempt epoch) so legacy consumers stay compatible; the target
-- guards compare input_revision so a completion computed from stale input can
-- never win.
CREATE TRIGGER classification_jobs_input_revision
AFTER UPDATE OF original_text, url ON links
WHEN OLD.original_text IS NOT NEW.original_text OR OLD.url IS NOT NEW.url
BEGIN
  UPDATE classification_jobs SET input_revision = input_revision + 1 WHERE link_id = NEW.id;
END;
