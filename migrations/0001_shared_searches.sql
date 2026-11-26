CREATE TABLE searches (
	id TEXT PRIMARY KEY NOT NULL,
	created_at INTEGER NOT NULL,
	search_json TEXT NOT NULL
);

CREATE TABLE shortlist (
	search_id TEXT NOT NULL,
	venue_id TEXT NOT NULL,
	added_at INTEGER NOT NULL,
	PRIMARY KEY (search_id, venue_id),
	FOREIGN KEY (search_id) REFERENCES searches(id) ON DELETE CASCADE
);

CREATE TABLE votes (
	search_id TEXT NOT NULL,
	venue_id TEXT NOT NULL,
	voter_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (search_id, venue_id, voter_id),
	FOREIGN KEY (search_id, venue_id) REFERENCES shortlist(search_id, venue_id) ON DELETE CASCADE
);

CREATE INDEX votes_by_search_and_venue ON votes(search_id, venue_id);