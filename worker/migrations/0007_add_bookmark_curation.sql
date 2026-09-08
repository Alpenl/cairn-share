ALTER TABLE links ADD COLUMN classification TEXT CHECK (classification IS NULL OR json_valid(classification));
ALTER TABLE links ADD COLUMN curation TEXT CHECK (curation IS NULL OR json_valid(curation));
ALTER TABLE links ADD COLUMN why TEXT NOT NULL DEFAULT '';
ALTER TABLE links ADD COLUMN curation_status TEXT NOT NULL DEFAULT 'inbox'
  CHECK (curation_status IN ('inbox', 'kept', 'compiled', 'drop'));

CREATE INDEX links_curation_status_id_idx ON links(curation_status, id DESC);
