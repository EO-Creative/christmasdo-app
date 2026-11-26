CREATE TABLE venue_cache (
	cache_key TEXT PRIMARY KEY NOT NULL,
	results_json TEXT NOT NULL CHECK (length(CAST(results_json AS BLOB)) <= 262144),
	expires_at INTEGER NOT NULL
);

CREATE INDEX venue_cache_by_expiry ON venue_cache(expires_at, cache_key);