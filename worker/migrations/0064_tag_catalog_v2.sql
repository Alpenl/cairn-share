-- Tag merges. The catalog change (source deprecated, synonym relation and
-- aliases on the target) happens in the managed catalog snapshot; this table
-- records the merge so it can be undone, and the queue moves existing
-- memberships one bookmark at a time through the ordinary tag operation path.
CREATE TABLE tag_merges(
 merge_key TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN('system','custom')),
 dimension TEXT NOT NULL,
 from_id TEXT NOT NULL,
 into_id TEXT NOT NULL,
 catalog_revision INTEGER NOT NULL DEFAULT 0,
 added_aliases TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(added_aliases)),
 rule_rewrites TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(rule_rewrites)),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','undone')),
 created_at TEXT NOT NULL,
 undone_at TEXT
);
CREATE INDEX tag_merges_from ON tag_merges(kind,dimension,from_id,status);
CREATE TABLE tag_merge_queue(
 merge_key TEXT NOT NULL REFERENCES tag_merges(merge_key),
 link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
 phase TEXT NOT NULL DEFAULT 'apply' CHECK(phase IN('apply','undo')),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','done','skipped')),
 operation_key TEXT NOT NULL DEFAULT '',
 attempts INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(merge_key,link_id,phase)
);
CREATE INDEX tag_merge_queue_pending ON tag_merge_queue(state,merge_key,link_id);
