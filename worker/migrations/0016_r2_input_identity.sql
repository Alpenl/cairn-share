-- R2-01/R2-02/R2-06/R2-07/R2-12: fix the identity of what was actually
-- inferred, make refresh an explicit persisted intent, and make every write
-- entry point idempotent on its full logical payload.
--
-- The job binds the evidence snapshot it was leased against, so a completion can
-- never re-stamp an old inference with a newer content revision. A run records
-- the payload hash of its logical request so a replayed operation key with a
-- different payload is a conflict rather than a silent success.

ALTER TABLE classification_jobs ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE classification_jobs ADD COLUMN evidence_snapshot_id INTEGER;
ALTER TABLE classification_jobs ADD COLUMN evidence_hash TEXT NOT NULL DEFAULT '';

-- An explicit, one-shot refresh intent. It is consumed by the processor, which
-- bypasses both the stored-source and legacy-saved reuse paths for that run.
ALTER TABLE links ADD COLUMN refresh_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN refresh_requested_at TEXT;

-- The logical payload identity of a stored run and of a decision. Two requests
-- with the same operation key may only replay when these match.
ALTER TABLE classification_runs ADD COLUMN payload_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE classification_decisions ADD COLUMN payload_hash TEXT NOT NULL DEFAULT '';

-- Entity results carry their own source identity so stale is judged against the
-- entity input, not against an unrelated classification decision.
ALTER TABLE entity_states ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';

-- Every human override records the logical payload it represents, so an
-- operation key reused with a different link, field, term or action is a
-- conflict rather than a replay.
ALTER TABLE curation_overrides ADD COLUMN payload_hash TEXT NOT NULL DEFAULT '';
