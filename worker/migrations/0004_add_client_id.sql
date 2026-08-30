ALTER TABLE links ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX links_client_id_idx ON links (client_id);
