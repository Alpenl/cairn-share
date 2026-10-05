ALTER TABLE collections ADD COLUMN rule_enabled INTEGER NOT NULL DEFAULT 0 CHECK(rule_enabled IN(0,1));
ALTER TABLE collections ADD COLUMN rule_mode TEXT NOT NULL DEFAULT 'any' CHECK(rule_mode IN('any','all'));
ALTER TABLE collections ADD COLUMN rule_tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(rule_tags));
ALTER TABLE collections ADD COLUMN rule_after_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collections ADD COLUMN rule_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collection_items ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN('manual','rule','organize'));
ALTER TABLE collection_items ADD COLUMN rule_operation TEXT NOT NULL DEFAULT '';
ALTER TABLE collection_items ADD COLUMN matched_tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(matched_tags));
CREATE TABLE collection_rule_exclusions(collection_id TEXT NOT NULL REFERENCES collections(id),link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,operation_key TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(collection_id,link_id));
CREATE TABLE collection_rule_queue(link_id INTEGER PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,revision INTEGER NOT NULL DEFAULT 1);
CREATE INDEX collection_rules_active ON collections(rule_enabled,deleted,archived);
CREATE TRIGGER collection_rule_link_insert AFTER INSERT ON links BEGIN
 INSERT INTO collection_rule_queue(link_id) VALUES(NEW.id) ON CONFLICT(link_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER collection_rule_effective_insert AFTER INSERT ON effective_tag_memberships BEGIN
 INSERT INTO collection_rule_queue(link_id) VALUES(NEW.link_id) ON CONFLICT(link_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER collection_rule_effective_delete AFTER DELETE ON effective_tag_memberships WHEN EXISTS(SELECT 1 FROM links WHERE id=OLD.link_id) BEGIN
 INSERT INTO collection_rule_queue(link_id) VALUES(OLD.link_id) ON CONFLICT(link_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER collection_rule_custom_insert AFTER INSERT ON custom_tag_links BEGIN
 INSERT INTO collection_rule_queue(link_id) VALUES(NEW.link_id) ON CONFLICT(link_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER collection_rule_custom_delete AFTER DELETE ON custom_tag_links WHEN EXISTS(SELECT 1 FROM links WHERE id=OLD.link_id) BEGIN
 INSERT INTO collection_rule_queue(link_id) VALUES(OLD.link_id) ON CONFLICT(link_id) DO UPDATE SET revision=revision+1;
END;
