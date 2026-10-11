-- Collection rules v2: exclusion tags, review-before-add admission and
-- confirmed-only matching. Defaults keep every existing rule's behaviour.
ALTER TABLE collections ADD COLUMN rule_exclude_tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(rule_exclude_tags));
ALTER TABLE collections ADD COLUMN rule_admission TEXT NOT NULL DEFAULT 'direct' CHECK(rule_admission IN('direct','review'));
ALTER TABLE collections ADD COLUMN rule_confirmed_only INTEGER NOT NULL DEFAULT 0 CHECK(rule_confirmed_only IN(0,1));
-- Review-mode matches wait here until a person accepts or ignores them.
-- An ignored candidate is never proposed again for the same collection.
CREATE TABLE collection_rule_candidates(
 collection_id TEXT NOT NULL REFERENCES collections(id),
 link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 matched_tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(matched_tags)),
 rule_revision INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','accepted','ignored')),
 created_at TEXT NOT NULL,
 decided_at TEXT,
 operation_key TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(collection_id,link_id)
);
CREATE INDEX collection_rule_candidates_status ON collection_rule_candidates(collection_id,status,link_id);
CREATE INDEX collection_rule_candidates_pending ON collection_rule_candidates(status,collection_id);
