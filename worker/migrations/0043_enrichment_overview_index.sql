-- D2: keep the URL classifier equivalent to the existing X link predicate.
-- VIRTUAL avoids another row write on insert or URL edit; the index stores its
-- result alongside the enrichment status used by the overview aggregate.
ALTER TABLE links ADD COLUMN is_x INTEGER GENERATED ALWAYS AS (CASE WHEN (
  lower(url) LIKE 'https://x.com/%'
  OR lower(url) LIKE 'http://x.com/%'
  OR lower(url) LIKE 'https://www.x.com/%'
  OR lower(url) LIKE 'http://www.x.com/%'
  OR lower(url) LIKE 'https://twitter.com/%'
  OR lower(url) LIKE 'http://twitter.com/%'
  OR lower(url) LIKE 'https://www.twitter.com/%'
  OR lower(url) LIKE 'http://www.twitter.com/%'
) THEN 1 ELSE 0 END) VIRTUAL;

CREATE INDEX links_is_x_status_idx ON links(is_x, enrichment_status);
