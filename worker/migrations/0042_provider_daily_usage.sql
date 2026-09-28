-- Aggregate counts contain no bookmark identity and survive privacy deletion.
-- A permit always consumes its daily quota, including unknown or later
-- operator-confirmed unbilled attempts. This also avoids day-wide COUNTs on
-- the admission hot path.
CREATE TABLE enrichment_provider_daily_usage (
  day TEXT PRIMARY KEY,
  total INTEGER NOT NULL CHECK (total >= 0),
  canary INTEGER NOT NULL CHECK (canary >= 0),
  fetch_first INTEGER NOT NULL CHECK (fetch_first >= 0),
  fetch_fallback INTEGER NOT NULL CHECK (fetch_fallback >= 0),
  reading INTEGER NOT NULL CHECK (reading >= 0)
);
INSERT INTO enrichment_provider_daily_usage
  (day,total,canary,fetch_first,fetch_fallback,reading)
SELECT substr(created_at,1,10),COUNT(*),
  SUM(CASE WHEN stage='canary' THEN 1 ELSE 0 END),
  SUM(CASE WHEN stage='fetch' AND attempt_number=1 THEN 1 ELSE 0 END),
  SUM(CASE WHEN stage='fetch' AND attempt_number=2 THEN 1 ELSE 0 END),
  SUM(CASE WHEN stage='reading' THEN 1 ELSE 0 END)
FROM enrichment_provider_attempts GROUP BY substr(created_at,1,10);
CREATE TRIGGER enrichment_provider_daily_usage_increment AFTER INSERT ON enrichment_provider_attempts
BEGIN
  INSERT INTO enrichment_provider_daily_usage
    (day,total,canary,fetch_first,fetch_fallback,reading)
  VALUES (substr(NEW.created_at,1,10),1,
    CASE WHEN NEW.stage='canary' THEN 1 ELSE 0 END,
    CASE WHEN NEW.stage='fetch' AND NEW.attempt_number=1 THEN 1 ELSE 0 END,
    CASE WHEN NEW.stage='fetch' AND NEW.attempt_number=2 THEN 1 ELSE 0 END,
    CASE WHEN NEW.stage='reading' THEN 1 ELSE 0 END)
  ON CONFLICT(day) DO UPDATE SET
    total=total+1,
    canary=canary+excluded.canary,
    fetch_first=fetch_first+excluded.fetch_first,
    fetch_fallback=fetch_fallback+excluded.fetch_fallback,
    reading=reading+excluded.reading;
END;
