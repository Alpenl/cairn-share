-- All read models are ordinary exportable SQLite tables. Candidates are
-- deduplicated UTF-8 byte bigrams; exact per-field LIKE remains the final test.
-- Single-byte queries retain the complete scan. No source truncation.
-- Explicit missing-row predicates avoid inheriting an outer UPSERT/REPLACE
-- conflict policy inside source-fact triggers.
CREATE TABLE effective_entity_memberships(link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  term TEXT NOT NULL,PRIMARY KEY(link_id,term)) WITHOUT ROWID;
CREATE VIEW canonical_effective_entity_memberships AS
SELECT l.id AS link_id,j.value AS term FROM links l,json_each((WITH
 events AS (SELECT term,action,ROW_NUMBER() OVER(ORDER BY revision,id) AS sequence
   FROM curation_overrides WHERE link_id=l.id AND field IN('entity','entities')),
 barrier AS (SELECT MAX(sequence) AS sequence FROM events WHERE action='set_empty' OR(action='reset' AND term='')),
 active AS (SELECT * FROM events WHERE term<>'' AND sequence>COALESCE((SELECT sequence FROM barrier),0)),
 automatic AS (SELECT j.value AS term FROM entity_states e JOIN evidence_snapshots s ON s.id=e.evidence_snapshot_id,
   json_each(e.entities) j WHERE e.link_id=l.id AND e.state='completed_nonempty' AND e.content_revision=l.content_revision
   AND s.link_id=e.link_id AND s.content_revision=e.content_revision AND s.content_hash=e.content_hash),
 candidates AS (SELECT term FROM automatic UNION SELECT term FROM active WHERE action='accept')
 SELECT json_group_array(term) FROM candidates c WHERE
   (SELECT action FROM active WHERE term=c.term ORDER BY sequence DESC LIMIT 1)='accept' OR (
     (SELECT action FROM active WHERE term=c.term ORDER BY sequence DESC LIMIT 1) IS NOT 'reject'
     AND EXISTS(SELECT 1 FROM automatic a WHERE a.term=c.term)
     AND((SELECT action FROM events WHERE sequence=(SELECT sequence FROM barrier)) IS NOT 'set_empty'
       OR EXISTS(SELECT 1 FROM active a WHERE a.term=c.term AND a.action='reset'))))) j;
INSERT INTO effective_entity_memberships SELECT link_id,term FROM canonical_effective_entity_memberships;
CREATE TABLE bookmark_search_documents(link_id INTEGER PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,document TEXT NOT NULL);
CREATE TABLE bookmark_search_grams(gram TEXT NOT NULL,link_id INTEGER NOT NULL REFERENCES bookmark_search_documents(link_id) ON DELETE CASCADE,
  PRIMARY KEY(gram,link_id)) WITHOUT ROWID;
CREATE INDEX bookmark_search_grams_link_idx ON bookmark_search_grams(link_id);
CREATE TABLE bookmark_search_gram_counts(gram TEXT PRIMARY KEY,link_count INTEGER NOT NULL CHECK(link_count>0)) WITHOUT ROWID;
CREATE VIEW canonical_bookmark_search_documents AS SELECT l.id AS link_id,COALESCE(l.url,'') || char(10) || COALESCE(l.note,'') || char(10) || COALESCE(l.ai_title,'') || char(10) || COALESCE(l.summary,'') || char(10) || COALESCE(l.translated_text,'') || char(10) || COALESCE(l.original_text,'') || char(10) || COALESCE(l.why,'') || char(10) || COALESCE(json_extract(l.classification,'$.why_suggestion'),'') || char(10) || COALESCE(CASE WHEN NOT EXISTS(SELECT 1 FROM entity_states WHERE link_id=l.id) AND NOT EXISTS(SELECT 1 FROM curation_overrides WHERE link_id=l.id AND field IN('entity','entities')) THEN json_extract(l.classification,'$.entities') ELSE(SELECT group_concat(term,' ') FROM effective_entity_memberships WHERE link_id=l.id) END,'') AS document FROM links l;
CREATE TRIGGER search_documents_insert AFTER INSERT ON bookmark_search_documents BEGIN
INSERT INTO bookmark_search_grams(gram,link_id)
 WITH RECURSIVE text(value) AS MATERIALIZED(SELECT CAST(lower(NEW.document) AS BLOB)),
 positions(i) AS(SELECT 1 FROM text WHERE length(value)>=2 UNION ALL
   SELECT i+1 FROM positions,text WHERE i+1<length(value))
 SELECT DISTINCT hex(substr(value,i,2)),NEW.link_id FROM text,positions;
 INSERT INTO bookmark_search_gram_counts(gram,link_count) SELECT gram,1 FROM bookmark_search_grams WHERE link_id=NEW.link_id
 ON CONFLICT(gram) DO UPDATE SET link_count=link_count+1;
END;
CREATE TRIGGER search_documents_update AFTER UPDATE OF document ON bookmark_search_documents WHEN NEW.document IS NOT OLD.document BEGIN
 DELETE FROM bookmark_search_gram_counts WHERE link_count=1 AND gram IN(SELECT gram FROM bookmark_search_grams WHERE link_id=OLD.link_id);
 UPDATE bookmark_search_gram_counts SET link_count=link_count-1 WHERE gram IN(SELECT gram FROM bookmark_search_grams WHERE link_id=OLD.link_id);
 DELETE FROM bookmark_search_grams WHERE link_id=OLD.link_id;
INSERT INTO bookmark_search_grams(gram,link_id)
 WITH RECURSIVE text(value) AS MATERIALIZED(SELECT CAST(lower(NEW.document) AS BLOB)),
 positions(i) AS(SELECT 1 FROM text WHERE length(value)>=2 UNION ALL
   SELECT i+1 FROM positions,text WHERE i+1<length(value))
 SELECT DISTINCT hex(substr(value,i,2)),NEW.link_id FROM text,positions;
 INSERT INTO bookmark_search_gram_counts(gram,link_count) SELECT gram,1 FROM bookmark_search_grams WHERE link_id=NEW.link_id
 ON CONFLICT(gram) DO UPDATE SET link_count=link_count+1;
END;
CREATE TRIGGER search_documents_delete BEFORE DELETE ON bookmark_search_documents BEGIN
 DELETE FROM bookmark_search_gram_counts WHERE link_count=1 AND gram IN(SELECT gram FROM bookmark_search_grams WHERE link_id=OLD.link_id);
 UPDATE bookmark_search_gram_counts SET link_count=link_count-1 WHERE gram IN(SELECT gram FROM bookmark_search_grams WHERE link_id=OLD.link_id);
END;
INSERT INTO bookmark_search_documents SELECT link_id,document FROM canonical_bookmark_search_documents;
CREATE TRIGGER search_links_insert AFTER INSERT ON links BEGIN
DELETE FROM effective_entity_memberships WHERE link_id IN(NEW.id);
 INSERT INTO effective_entity_memberships SELECT link_id,term FROM canonical_effective_entity_memberships WHERE link_id IN(NEW.id);
 UPDATE bookmark_search_documents SET document=(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id)
   WHERE link_id IN(NEW.id) AND document IS NOT(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id);
 INSERT INTO bookmark_search_documents SELECT link_id,document FROM canonical_bookmark_search_documents WHERE link_id IN(NEW.id) AND NOT EXISTS(SELECT 1 FROM bookmark_search_documents d WHERE d.link_id=canonical_bookmark_search_documents.link_id);
END;
CREATE TRIGGER search_links_update AFTER UPDATE OF url,note,ai_title,summary,translated_text,original_text,why,classification,content_revision ON links BEGIN
DELETE FROM effective_entity_memberships WHERE link_id IN(OLD.id,NEW.id);
 INSERT INTO effective_entity_memberships SELECT link_id,term FROM canonical_effective_entity_memberships WHERE link_id IN(OLD.id,NEW.id);
 UPDATE bookmark_search_documents SET document=(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id)
   WHERE link_id IN(OLD.id,NEW.id) AND document IS NOT(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id);
 INSERT INTO bookmark_search_documents SELECT link_id,document FROM canonical_bookmark_search_documents WHERE link_id IN(OLD.id,NEW.id) AND NOT EXISTS(SELECT 1 FROM bookmark_search_documents d WHERE d.link_id=canonical_bookmark_search_documents.link_id);
END;
CREATE TRIGGER search_entity_states_insert AFTER INSERT ON entity_states BEGIN
DELETE FROM effective_entity_memberships WHERE link_id IN(NEW.link_id);
 INSERT INTO effective_entity_memberships SELECT link_id,term FROM canonical_effective_entity_memberships WHERE link_id IN(NEW.link_id);
 UPDATE bookmark_search_documents SET document=(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id)
   WHERE link_id IN(NEW.link_id) AND document IS NOT(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id);
 INSERT INTO bookmark_search_documents SELECT link_id,document FROM canonical_bookmark_search_documents WHERE link_id IN(NEW.link_id) AND NOT EXISTS(SELECT 1 FROM bookmark_search_documents d WHERE d.link_id=canonical_bookmark_search_documents.link_id);
END;
CREATE TRIGGER search_entity_states_update AFTER UPDATE ON entity_states BEGIN
DELETE FROM effective_entity_memberships WHERE link_id IN(OLD.link_id,NEW.link_id);
 INSERT INTO effective_entity_memberships SELECT link_id,term FROM canonical_effective_entity_memberships WHERE link_id IN(OLD.link_id,NEW.link_id);
 UPDATE bookmark_search_documents SET document=(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id)
   WHERE link_id IN(OLD.link_id,NEW.link_id) AND document IS NOT(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id);
 INSERT INTO bookmark_search_documents SELECT link_id,document FROM canonical_bookmark_search_documents WHERE link_id IN(OLD.link_id,NEW.link_id) AND NOT EXISTS(SELECT 1 FROM bookmark_search_documents d WHERE d.link_id=canonical_bookmark_search_documents.link_id);
END;
CREATE TRIGGER search_entity_states_delete AFTER DELETE ON entity_states BEGIN
DELETE FROM effective_entity_memberships WHERE link_id IN(OLD.link_id);
 INSERT INTO effective_entity_memberships SELECT link_id,term FROM canonical_effective_entity_memberships WHERE link_id IN(OLD.link_id);
 UPDATE bookmark_search_documents SET document=(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id)
   WHERE link_id IN(OLD.link_id) AND document IS NOT(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id);
 INSERT INTO bookmark_search_documents SELECT link_id,document FROM canonical_bookmark_search_documents WHERE link_id IN(OLD.link_id) AND NOT EXISTS(SELECT 1 FROM bookmark_search_documents d WHERE d.link_id=canonical_bookmark_search_documents.link_id);
END;
CREATE TRIGGER search_evidence_snapshots_insert AFTER INSERT ON evidence_snapshots BEGIN
DELETE FROM effective_entity_memberships WHERE link_id IN(NEW.link_id);
 INSERT INTO effective_entity_memberships SELECT link_id,term FROM canonical_effective_entity_memberships WHERE link_id IN(NEW.link_id);
 UPDATE bookmark_search_documents SET document=(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id)
   WHERE link_id IN(NEW.link_id) AND document IS NOT(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id);
 INSERT INTO bookmark_search_documents SELECT link_id,document FROM canonical_bookmark_search_documents WHERE link_id IN(NEW.link_id) AND NOT EXISTS(SELECT 1 FROM bookmark_search_documents d WHERE d.link_id=canonical_bookmark_search_documents.link_id);
END;
CREATE TRIGGER search_evidence_snapshots_update AFTER UPDATE ON evidence_snapshots BEGIN
DELETE FROM effective_entity_memberships WHERE link_id IN(OLD.link_id,NEW.link_id);
 INSERT INTO effective_entity_memberships SELECT link_id,term FROM canonical_effective_entity_memberships WHERE link_id IN(OLD.link_id,NEW.link_id);
 UPDATE bookmark_search_documents SET document=(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id)
   WHERE link_id IN(OLD.link_id,NEW.link_id) AND document IS NOT(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id);
 INSERT INTO bookmark_search_documents SELECT link_id,document FROM canonical_bookmark_search_documents WHERE link_id IN(OLD.link_id,NEW.link_id) AND NOT EXISTS(SELECT 1 FROM bookmark_search_documents d WHERE d.link_id=canonical_bookmark_search_documents.link_id);
END;
CREATE TRIGGER search_evidence_snapshots_delete AFTER DELETE ON evidence_snapshots BEGIN
DELETE FROM effective_entity_memberships WHERE link_id IN(OLD.link_id);
 INSERT INTO effective_entity_memberships SELECT link_id,term FROM canonical_effective_entity_memberships WHERE link_id IN(OLD.link_id);
 UPDATE bookmark_search_documents SET document=(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id)
   WHERE link_id IN(OLD.link_id) AND document IS NOT(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id);
 INSERT INTO bookmark_search_documents SELECT link_id,document FROM canonical_bookmark_search_documents WHERE link_id IN(OLD.link_id) AND NOT EXISTS(SELECT 1 FROM bookmark_search_documents d WHERE d.link_id=canonical_bookmark_search_documents.link_id);
END;
CREATE TRIGGER search_curation_overrides_insert AFTER INSERT ON curation_overrides WHEN NEW.field IN('entity','entities') BEGIN
DELETE FROM effective_entity_memberships WHERE link_id IN(NEW.link_id);
 INSERT INTO effective_entity_memberships SELECT link_id,term FROM canonical_effective_entity_memberships WHERE link_id IN(NEW.link_id);
 UPDATE bookmark_search_documents SET document=(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id)
   WHERE link_id IN(NEW.link_id) AND document IS NOT(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id);
 INSERT INTO bookmark_search_documents SELECT link_id,document FROM canonical_bookmark_search_documents WHERE link_id IN(NEW.link_id) AND NOT EXISTS(SELECT 1 FROM bookmark_search_documents d WHERE d.link_id=canonical_bookmark_search_documents.link_id);
END;
CREATE TRIGGER search_curation_overrides_update AFTER UPDATE ON curation_overrides WHEN NEW.field IN('entity','entities') OR OLD.field IN('entity','entities') BEGIN
DELETE FROM effective_entity_memberships WHERE link_id IN(OLD.link_id,NEW.link_id);
 INSERT INTO effective_entity_memberships SELECT link_id,term FROM canonical_effective_entity_memberships WHERE link_id IN(OLD.link_id,NEW.link_id);
 UPDATE bookmark_search_documents SET document=(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id)
   WHERE link_id IN(OLD.link_id,NEW.link_id) AND document IS NOT(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id);
 INSERT INTO bookmark_search_documents SELECT link_id,document FROM canonical_bookmark_search_documents WHERE link_id IN(OLD.link_id,NEW.link_id) AND NOT EXISTS(SELECT 1 FROM bookmark_search_documents d WHERE d.link_id=canonical_bookmark_search_documents.link_id);
END;
CREATE TRIGGER search_curation_overrides_delete AFTER DELETE ON curation_overrides WHEN OLD.field IN('entity','entities') BEGIN
DELETE FROM effective_entity_memberships WHERE link_id IN(OLD.link_id);
 INSERT INTO effective_entity_memberships SELECT link_id,term FROM canonical_effective_entity_memberships WHERE link_id IN(OLD.link_id);
 UPDATE bookmark_search_documents SET document=(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id)
   WHERE link_id IN(OLD.link_id) AND document IS NOT(SELECT document FROM canonical_bookmark_search_documents c WHERE c.link_id=bookmark_search_documents.link_id);
 INSERT INTO bookmark_search_documents SELECT link_id,document FROM canonical_bookmark_search_documents WHERE link_id IN(OLD.link_id) AND NOT EXISTS(SELECT 1 FROM bookmark_search_documents d WHERE d.link_id=canonical_bookmark_search_documents.link_id);
END;
