-- Preserve 0051's documents/postings/frequencies and exact LIKE contract.
-- Each field owns its internal byte bigrams plus adjacent LF boundaries.
-- Overlapping LF ownership creates exactly the original document gram union,
-- including empty fields, NUL bytes and multi-byte UTF-8, without new grams.
-- Long body blocks are compared on refresh but tokenized only when changed.
DROP TRIGGER search_documents_insert;
DROP TRIGGER search_documents_update;
DROP TRIGGER search_documents_delete;
CREATE TABLE bookmark_search_fields(
  link_id INTEGER NOT NULL REFERENCES bookmark_search_documents(link_id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK(field IN('url','note','ai_title','summary','translated_text','original_text','why','why_suggestion','entities')),
  value TEXT NOT NULL,PRIMARY KEY(link_id,field)) WITHOUT ROWID;
CREATE TABLE bookmark_search_field_grams(
  link_id INTEGER NOT NULL,field TEXT NOT NULL,gram TEXT NOT NULL,
  PRIMARY KEY(link_id,field,gram),
  FOREIGN KEY(link_id,field) REFERENCES bookmark_search_fields(link_id,field) ON DELETE CASCADE ON UPDATE CASCADE) WITHOUT ROWID;
CREATE INDEX bookmark_search_field_grams_reference_idx ON bookmark_search_field_grams(link_id,gram);
CREATE VIEW canonical_bookmark_search_fields AS
SELECT l.id AS link_id,f.value AS field,CASE f.value
  WHEN 'url' THEN COALESCE(l.url,'') || char(10)
  WHEN 'note' THEN char(10) || COALESCE(l.note,'') || char(10)
  WHEN 'ai_title' THEN char(10) || COALESCE(l.ai_title,'') || char(10)
  WHEN 'summary' THEN char(10) || COALESCE(l.summary,'') || char(10)
  WHEN 'translated_text' THEN char(10) || COALESCE(l.translated_text,'') || char(10)
  WHEN 'original_text' THEN char(10) || COALESCE(l.original_text,'') || char(10)
  WHEN 'why' THEN char(10) || COALESCE(l.why,'') || char(10)
  WHEN 'why_suggestion' THEN char(10) || COALESCE(json_extract(l.classification,'$.why_suggestion'),'') || char(10)
  WHEN 'entities' THEN char(10) || COALESCE(CASE WHEN NOT EXISTS(SELECT 1 FROM entity_states WHERE link_id=l.id) AND NOT EXISTS(SELECT 1 FROM curation_overrides WHERE link_id=l.id AND field IN('entity','entities')) THEN json_extract(l.classification,'$.entities') ELSE(SELECT group_concat(term,' ') FROM effective_entity_memberships WHERE link_id=l.id) END,'')
END AS value FROM links l CROSS JOIN json_each('["url","note","ai_title","summary","translated_text","original_text","why","why_suggestion","entities"]') f;

-- Frequency updates follow global membership changes, never field overlap.
CREATE TRIGGER search_grams_frequency_insert AFTER INSERT ON bookmark_search_grams BEGIN
  INSERT INTO bookmark_search_gram_counts(gram,link_count) VALUES(NEW.gram,1)
    ON CONFLICT(gram) DO UPDATE SET link_count=link_count+1;
END;
CREATE TRIGGER search_grams_frequency_delete BEFORE DELETE ON bookmark_search_grams BEGIN
  DELETE FROM bookmark_search_gram_counts WHERE gram=OLD.gram AND link_count=1;
  UPDATE bookmark_search_gram_counts SET link_count=link_count-1 WHERE gram=OLD.gram;
END;
CREATE TRIGGER search_field_grams_insert AFTER INSERT ON bookmark_search_field_grams BEGIN
  INSERT INTO bookmark_search_grams(gram,link_id) SELECT NEW.gram,NEW.link_id
    WHERE NOT EXISTS(SELECT 1 FROM bookmark_search_grams WHERE gram=NEW.gram AND link_id=NEW.link_id);
END;
CREATE TRIGGER search_field_grams_delete AFTER DELETE ON bookmark_search_field_grams BEGIN
  DELETE FROM bookmark_search_grams WHERE gram=OLD.gram AND link_id=OLD.link_id
    AND NOT EXISTS(SELECT 1 FROM bookmark_search_field_grams WHERE link_id=OLD.link_id AND gram=OLD.gram);
END;
CREATE TRIGGER search_field_grams_update AFTER UPDATE OF link_id,field,gram ON bookmark_search_field_grams BEGIN
  INSERT INTO bookmark_search_grams(gram,link_id) SELECT NEW.gram,NEW.link_id
    WHERE NOT EXISTS(SELECT 1 FROM bookmark_search_grams WHERE gram=NEW.gram AND link_id=NEW.link_id);
  DELETE FROM bookmark_search_grams WHERE gram=OLD.gram AND link_id=OLD.link_id
    AND NOT EXISTS(SELECT 1 FROM bookmark_search_field_grams WHERE link_id=OLD.link_id AND gram=OLD.gram);
END;
CREATE TRIGGER search_fields_insert AFTER INSERT ON bookmark_search_fields BEGIN
  INSERT INTO bookmark_search_field_grams(link_id,field,gram)
    SELECT NEW.link_id,NEW.field,gram FROM (
WITH RECURSIVE text(value) AS MATERIALIZED(SELECT CAST(lower(NEW.value) AS BLOB)),
      positions(i) AS(SELECT 1 FROM text WHERE length(value)>=2 UNION ALL
        SELECT i+1 FROM positions,text WHERE i+1<length(value))
    SELECT DISTINCT hex(substr(value,i,2)) AS gram FROM text,positions
    );
END;
CREATE TRIGGER search_fields_update AFTER UPDATE OF value ON bookmark_search_fields WHEN NEW.value IS NOT OLD.value BEGIN
  -- Change the field reference set by difference. Shared and unchanged grams
  -- keep their global row and frequency throughout the whole transaction.
  INSERT INTO bookmark_search_field_grams(link_id,field,gram)
    SELECT NEW.link_id,NEW.field,n.gram FROM (
WITH RECURSIVE text(value) AS MATERIALIZED(SELECT CAST(lower(NEW.value) AS BLOB)),
      positions(i) AS(SELECT 1 FROM text WHERE length(value)>=2 UNION ALL
        SELECT i+1 FROM positions,text WHERE i+1<length(value))
    SELECT DISTINCT hex(substr(value,i,2)) AS gram FROM text,positions
    ) n WHERE NOT EXISTS(SELECT 1 FROM bookmark_search_field_grams old
      WHERE old.link_id=NEW.link_id AND old.field=NEW.field AND old.gram=n.gram);
  DELETE FROM bookmark_search_field_grams WHERE link_id=NEW.link_id AND field=NEW.field AND gram NOT IN(
WITH RECURSIVE text(value) AS MATERIALIZED(SELECT CAST(lower(NEW.value) AS BLOB)),
      positions(i) AS(SELECT 1 FROM text WHERE length(value)>=2 UNION ALL
        SELECT i+1 FROM positions,text WHERE i+1<length(value))
    SELECT DISTINCT hex(substr(value,i,2)) AS gram FROM text,positions
  );
END;
CREATE TRIGGER search_documents_insert AFTER INSERT ON bookmark_search_documents BEGIN
  UPDATE bookmark_search_fields SET value=(SELECT c.value FROM canonical_bookmark_search_fields c
    WHERE c.link_id=NEW.link_id AND c.field=bookmark_search_fields.field)
    WHERE link_id=NEW.link_id AND value IS NOT(SELECT c.value FROM canonical_bookmark_search_fields c
      WHERE c.link_id=NEW.link_id AND c.field=bookmark_search_fields.field);
  INSERT INTO bookmark_search_fields(link_id,field,value)
    SELECT c.link_id,c.field,c.value FROM canonical_bookmark_search_fields c WHERE c.link_id=NEW.link_id
      AND NOT EXISTS(SELECT 1 FROM bookmark_search_fields f WHERE f.link_id=c.link_id AND f.field=c.field);
END;
CREATE TRIGGER search_documents_update AFTER UPDATE OF document ON bookmark_search_documents WHEN NEW.document IS NOT OLD.document BEGIN
  UPDATE bookmark_search_fields SET value=(SELECT c.value FROM canonical_bookmark_search_fields c
    WHERE c.link_id=NEW.link_id AND c.field=bookmark_search_fields.field)
    WHERE link_id=NEW.link_id AND value IS NOT(SELECT c.value FROM canonical_bookmark_search_fields c
      WHERE c.link_id=NEW.link_id AND c.field=bookmark_search_fields.field);
  INSERT INTO bookmark_search_fields(link_id,field,value)
    SELECT c.link_id,c.field,c.value FROM canonical_bookmark_search_fields c WHERE c.link_id=NEW.link_id
      AND NOT EXISTS(SELECT 1 FROM bookmark_search_fields f WHERE f.link_id=c.link_id AND f.field=c.field);
END;
INSERT INTO bookmark_search_fields(link_id,field,value) SELECT link_id,field,value FROM canonical_bookmark_search_fields;
