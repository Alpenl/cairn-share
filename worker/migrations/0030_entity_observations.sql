-- Keep source occurrences, bounded controlled options and typed judgments after
-- the short-lived inference cache expires. Legacy rows remain explicitly empty.
ALTER TABLE entity_states ADD COLUMN observations TEXT NOT NULL DEFAULT '[]'
 CHECK(json_valid(observations) AND json_type(observations)='array');
