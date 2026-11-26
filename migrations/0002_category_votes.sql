CREATE TABLE category_votes (
	search_id TEXT NOT NULL,
	category TEXT NOT NULL CHECK (category IN ('activities', 'food', 'drinks')),
	venue_id TEXT NOT NULL,
	voter_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (search_id, category, voter_id),
	FOREIGN KEY (search_id, venue_id) REFERENCES shortlist(search_id, venue_id) ON DELETE CASCADE
);

CREATE INDEX category_votes_by_search_category_venue ON category_votes(search_id, category, venue_id);

WITH expanded_votes AS (
	SELECT old_votes.search_id, category.value AS category, old_votes.venue_id, old_votes.voter_id,
		old_votes.created_at,
		ROW_NUMBER() OVER (
			PARTITION BY old_votes.search_id, category.value, old_votes.voter_id
			ORDER BY old_votes.created_at DESC, old_votes.venue_id ASC
		) AS choice_rank
	FROM votes AS old_votes
	JOIN searches AS search ON search.id = old_votes.search_id
	JOIN json_each('["activities", "food", "drinks"]') AS category
	JOIN json_each(json_extract(search.search_json, '$.results.' || category.value)) AS venue
		ON json_extract(venue.value, '$.id') = old_votes.venue_id
)
INSERT INTO category_votes (search_id, category, venue_id, voter_id, created_at)
SELECT search_id, category, venue_id, voter_id, created_at
FROM expanded_votes
WHERE choice_rank = 1;