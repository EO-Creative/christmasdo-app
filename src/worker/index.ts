import { Hono } from "hono";
import { parseSearchIntent, type VenueType, type SearchIntent } from "../shared/search-intent.ts";

type WorkerBindings = { GEOAPIFY_API_KEY?: string; DB?: D1Database };
type SearchSnapshot = {
	location: { label: string; lat: number; lon: number };
	groupSize: number;
	radiusKm: number;
	types: VenueType[];
	prompt?: string;
	results: Record<VenueType, NormalizedVenue[]>;
};

const app = new Hono<{ Bindings: WorkerBindings }>();
const venueTypes: VenueType[] = ["activities", "food", "drinks"];
const categoriesByType: Record<VenueType, string[]> = {
	activities: [
		"entertainment.activity_park",
		"entertainment.amusement_arcade",
		"entertainment.bowling_alley",
		"entertainment.cinema",
		"entertainment.culture.theatre",
		"entertainment.escape_game",
		"entertainment.miniature_golf",
	],
	food: ["catering.restaurant"],
	drinks: ["catering.bar", "catering.biergarten", "catering.pub", "adult.nightclub"],
};
const filteredFoodCategories = ["catering.cafe", "catering.fast_food", "catering.food_court"];
const unsuitableVenueName = /\b(?:costa(?:\s+(?:coffee|express))?|starbucks|caff[eè]?\s*nero|nero|pret(?:\s+a)?\s+manger|greggs|tim\s+hortons|mcdonald[’']?s|burger\s+king|kfc|subway|taco\s+bell|pizza\s+hut|domino[’']?s|papa\s+john[’']s)\b/i;

function requestedCategories(type: VenueType, intent: SearchIntent): string[] {
	if (type === "activities" && intent.activityCategories.length > 0) return intent.activityCategories;
	if (type === "food" && intent.cuisineCategories.length > 0) return intent.cuisineCategories;
	return categoriesByType[type];
}

interface GeoapifyLocation {
	place_id?: unknown;
	name?: unknown;
	formatted?: unknown;
	lat?: unknown;
	lon?: unknown;
}

interface GeoapifyPlace extends GeoapifyLocation {
	categories?: unknown;
	distance?: unknown;
	address_line1?: unknown;
	address_line2?: unknown;
	street?: unknown;
	housenumber?: unknown;
	city?: unknown;
	postcode?: unknown;
	website?: unknown;
	phone?: unknown;
	contact?: { website?: unknown; phone?: unknown };
	datasource?: { raw?: Record<string, unknown> };
}

function geoapifyKey(bindings: WorkerBindings): string | undefined {
	return bindings.GEOAPIFY_API_KEY?.trim() || undefined;
}

function locationResult(value: unknown) {
	if (!value || typeof value !== "object") return undefined;
	const place = value as GeoapifyLocation;
	const lat = Number(place.lat);
	const lon = Number(place.lon);
	const label = [place.formatted, place.name].find((item) => typeof item === "string" && item.trim());
	if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180 || !label) {
		return undefined;
	}
	return {
		id: typeof place.place_id === "string" ? place.place_id : `${lat},${lon}`,
		label: String(label),
		lat,
		lon,
	};
}

function distanceBetween(latitude: number, longitude: number, targetLatitude: number, targetLongitude: number): number {
	const radians = Math.PI / 180;
	const latitudeDelta = (targetLatitude - latitude) * radians;
	const longitudeDelta = (targetLongitude - longitude) * radians;
	const haversine = Math.sin(latitudeDelta / 2) ** 2 +
		Math.cos(latitude * radians) * Math.cos(targetLatitude * radians) * Math.sin(longitudeDelta / 2) ** 2;
	return 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function venueResult(value: unknown, requestedCategories: string[], latitude: number, longitude: number) {
	if (!value || typeof value !== "object") return undefined;
	const place = value as GeoapifyPlace;
	const lat = Number(place.lat);
	const lon = Number(place.lon);
	const name = typeof place.name === "string" ? place.name.trim() : "";
	if (!name || !Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
		return undefined;
	}

	const categories = Array.isArray(place.categories)
		? place.categories.filter((category): category is string => typeof category === "string")
		: [];
	if (!categories.some((candidate) => requestedCategories.some((requested) =>
		candidate === requested || candidate.startsWith(`${requested}.`),
	))) return undefined;
	const category = categories.find((candidate) => requestedCategories.includes(candidate)) ??
		categories.find((candidate) => requestedCategories.some((requested) => candidate.startsWith(`${requested}.`))) ??
		categories[0] ?? "venue";
	const categoryName = category.split(".").at(-1) || "venue";
	const raw = place.datasource?.raw ?? {};
	const website = place.contact?.website ?? place.website ?? raw.website;
	const phone = place.contact?.phone ?? place.phone ?? raw.phone;
	const capacity = raw.capacity;

	return {
		id: typeof place.place_id === "string" ? place.place_id : `${lat},${lon}`,
		type: "node" as const,
		lat,
		lon,
		distance: typeof place.distance === "number" && Number.isFinite(place.distance)
			? place.distance
			: distanceBetween(latitude, longitude, lat, lon),
		address: [place.address_line1, place.address_line2].filter((part) => typeof part === "string" && part.trim()).join(", "),
		category: categoryName.replace(/_/g, " "),
		tags: {
			name,
			amenity: category.startsWith("catering.") || category.startsWith("adult.") ? categoryName : undefined,
			leisure: category.startsWith("entertainment.") ? categoryName : undefined,
			"addr:street": typeof place.street === "string" ? place.street : undefined,
			"addr:housenumber": typeof place.housenumber === "string" ? place.housenumber : undefined,
			"addr:city": typeof place.city === "string" ? place.city : undefined,
			"addr:postcode": typeof place.postcode === "string" ? place.postcode : undefined,
			website: typeof website === "string" ? website : undefined,
			phone: typeof phone === "string" ? phone : undefined,
			capacity: typeof capacity === "string" || typeof capacity === "number" ? String(capacity) : undefined,
		},
	};
}

function parseNumericCapacity(value: unknown): number | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const text = String(value).trim();
	if (!/^\d+$/.test(text)) return undefined;
	const capacity = Number(text);
	return Number.isSafeInteger(capacity) && capacity > 0 ? capacity : undefined;
}

function isUnsuitableVenue(value: unknown, requestedCategories: string[], groupSize: number, capacity?: string): boolean {
	const numericCapacity = parseNumericCapacity(capacity);
	if (numericCapacity !== undefined && numericCapacity < groupSize) return true;
	if (!value || typeof value !== "object") return true;

	const place = value as GeoapifyPlace;
	const categories = Array.isArray(place.categories)
		? place.categories.filter((category): category is string => typeof category === "string")
		: [];
	const hasSelectedAlternative = categories.some((category) =>
		requestedCategories.some((requested) => requested !== "catering.restaurant" &&
			(category === requested || category.startsWith(`${requested}.`))),
	);
	if (hasSelectedAlternative) return false;

	return categories.some((category) => filteredFoodCategories.some((filtered) =>
		category === filtered || category.startsWith(`${filtered}.`),
	)) || (typeof place.name === "string" && unsuitableVenueName.test(place.name));
}

type NormalizedVenue = NonNullable<ReturnType<typeof venueResult>>;

function sortVenueCandidates(first: NormalizedVenue, second: NormalizedVenue): number {
	const firstCapacity = parseNumericCapacity(first.tags.capacity);
	const secondCapacity = parseNumericCapacity(second.tags.capacity);
	if (firstCapacity !== undefined && secondCapacity === undefined) return -1;
	if (firstCapacity === undefined && secondCapacity !== undefined) return 1;
	if (first.distance < second.distance) return -1;
	if (first.distance > second.distance) return 1;
	return (first.tags.name || "").localeCompare(second.tags.name || "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidShareId(value: string): boolean {
	return /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value);
}

function isValidVenue(value: unknown): value is NormalizedVenue {
	if (!isRecord(value) || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 200) return false;
	if (!isRecord(value.tags) || typeof value.tags.name !== "string" || !value.tags.name.trim() || value.tags.name.length > 200) return false;
	if (value.type !== "node" || typeof value.lat !== "number" || typeof value.lon !== "number") return false;
	if (value.distance !== undefined && (typeof value.distance !== "number" || !Number.isFinite(value.distance) || value.distance < 0)) return false;
	if ([value.address, value.category].some((field) => field !== undefined && typeof field !== "string")) return false;
	if (Object.values(value.tags).some((field) => field !== undefined && typeof field !== "string")) return false;
	return Number.isFinite(value.lat) && value.lat >= -90 && value.lat <= 90 &&
		Number.isFinite(value.lon) && value.lon >= -180 && value.lon <= 180;
}

function validateSnapshot(value: unknown): SearchSnapshot | undefined {
	if (!isRecord(value) || !isRecord(value.location) || !isRecord(value.results)) return undefined;
	const { location } = value;
	if (value.prompt !== undefined && (typeof value.prompt !== "string" || value.prompt.length > 500)) return undefined;
	if (typeof location.label !== "string" || !location.label.trim() || location.label.length > 200) return undefined;
	if (typeof location.lat !== "number" || typeof location.lon !== "number") return undefined;
	const latitude = location.lat;
	const longitude = location.lon;
	if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return undefined;
	if (!Number.isSafeInteger(value.groupSize) || Number(value.groupSize) < 1 || Number(value.groupSize) > 10000) return undefined;
	if (typeof value.radiusKm !== "number" || ![1, 2, 5, 10, 20].includes(value.radiusKm)) return undefined;
	if (!Array.isArray(value.types) || value.types.length < 1 || value.types.length > venueTypes.length ||
		value.types.some((type) => typeof type !== "string" || !venueTypes.includes(type as VenueType)) ||
		new Set(value.types).size !== value.types.length) return undefined;

	const types = value.types as VenueType[];
	let venueCount = 0;
	const results = {} as Record<VenueType, NormalizedVenue[]>;
	for (const type of venueTypes) {
		const venues = value.results[type];
		if (!Array.isArray(venues) || venues.length > 20 || venues.some((venue) => !isValidVenue(venue))) return undefined;
		venueCount += venues.length;
		results[type] = venues as NormalizedVenue[];
	}
	if (venueCount > 60 || venueTypes.some((type) => !types.includes(type) && results[type].length > 0)) return undefined;

	return {
		location: { label: location.label.trim(), lat: latitude, lon: longitude },
		groupSize: Number(value.groupSize),
		radiusKm: value.radiusKm,
		types,
		...(typeof value.prompt === "string" && value.prompt.trim() ? { prompt: value.prompt.trim() } : {}),
		results,
	};
}

function snapshotHasVenue(snapshot: SearchSnapshot, venueId: string): boolean {
	return venueTypes.some((type) => snapshot.results[type].some((venue) => venue.id === venueId));
}

async function readSearch(db: D1Database, id: string): Promise<{ snapshot: SearchSnapshot; createdAt: number } | undefined> {
	const row = await db.prepare("SELECT search_json, created_at FROM searches WHERE id = ?")
		.bind(id)
		.first<{ search_json: string; created_at: number }>();
	if (!row) return undefined;
	try {
		const snapshot = validateSnapshot(JSON.parse(row.search_json));
		return snapshot ? { snapshot, createdAt: row.created_at } : undefined;
	} catch {
		return undefined;
	}
}

app.get("/api/suggest", async (c) => {
	const text = c.req.query("q")?.trim() ?? "";
	if (!text) return c.json({ error: "Enter a location to search." }, 400);
	if (text.length > 200) return c.json({ error: "Location text is too long." }, 400);
	if (text.length < 3) return c.json({ results: [] });

	const apiKey = geoapifyKey(c.env);
	if (!apiKey) {
		return c.json({ error: "Location search is not configured. Add GEOAPIFY_API_KEY to the Worker settings." }, 503);
	}

	try {
		const params = new URLSearchParams({ apiKey, text, format: "json", limit: "5" });
		const response = await fetch(`https://api.geoapify.com/v1/geocode/autocomplete?${params}`, {
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) return c.json({ error: "Location suggestions are temporarily unavailable." }, 502);
		const data: unknown = await response.json();
		if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
			return c.json({ error: "Location search returned an invalid response." }, 502);
		}
		const results = (data as { results: unknown[] }).results.map(locationResult).filter(Boolean);
		return c.json({ results });
	} catch {
		return c.json({ error: "Location suggestions are temporarily unavailable." }, 502);
	}
});

app.get("/api/geocode", async (c) => {
	const text = c.req.query("q")?.trim();
	if (!text) return c.json({ error: "Enter a location to search." }, 400);
	if (text.length > 200) return c.json({ error: "Location text is too long." }, 400);

	const apiKey = geoapifyKey(c.env);
	if (!apiKey) {
		return c.json({ error: "Location search is not configured. Add GEOAPIFY_API_KEY to the Worker settings." }, 503);
	}

	try {
		const params = new URLSearchParams({ apiKey, text, format: "json", limit: "1" });
		const response = await fetch(`https://api.geoapify.com/v1/geocode/search?${params}`, {
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) return c.json({ error: "Location search is temporarily unavailable. Please try again." }, 502);
		const data: unknown = await response.json();
		if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
			return c.json({ error: "Location search returned an invalid response." }, 502);
		}
		const results = (data as { results: unknown[] }).results.map(locationResult).filter(Boolean);
		return c.json({ results });
	} catch {
		return c.json({ error: "Location search is temporarily unavailable. Please try again." }, 502);
	}
});

app.get("/api/venues", async (c) => {
	const lat = c.req.query("lat");
	const lon = c.req.query("lon");
	const typeParam = c.req.query("types");
	const groupSizeParam = c.req.query("groupSize");
	const radiusParam = c.req.query("radiusKm");
	const prompt = c.req.query("prompt")?.trim() ?? "";
	if (prompt.length > 500) return c.json({ error: "Describe your preferences in 500 characters or fewer." }, 400);

	if (lat === undefined || lon === undefined) {
		return c.json({ error: "A location is required before searching for venues." }, 400);
	}
	if (lat.trim() === "" || lon.trim() === "") {
		return c.json({ error: "The selected location has invalid coordinates." }, 400);
	}
	const latitude = Number(lat);
	const longitude = Number(lon);
	if (
		!Number.isFinite(latitude) ||
		latitude < -90 ||
		latitude > 90 ||
		!Number.isFinite(longitude) ||
		longitude < -180 ||
		longitude > 180
	) {
		return c.json({ error: "The selected location has invalid coordinates." }, 400);
	}
	if (!typeParam) return c.json({ error: "Select at least one venue type." }, 400);

	const types = typeParam.split(",").map((type) => type.trim()).filter(Boolean);
	if (types.length === 0 || types.some((type) => !venueTypes.includes(type as VenueType))) {
		return c.json({ error: "One or more selected venue types are not supported." }, 400);
	}
	if (new Set(types).size !== types.length) return c.json({ error: "Each venue type can only be selected once." }, 400);
	const groupSize = Number(groupSizeParam);
	if (
		groupSizeParam === undefined ||
		groupSizeParam.trim() === "" ||
		!Number.isSafeInteger(groupSize) ||
		groupSize < 1 || groupSize > 10000
	) {
		return c.json({ error: "Enter a valid whole-number group size between 1 and 10,000." }, 400);
	}
	const radiusKm = Number(radiusParam);
	if (radiusParam === undefined || ![1, 2, 5, 10, 20].includes(radiusKm)) {
		return c.json({ error: "Choose a search radius of 1, 2, 5, 10, or 20 km." }, 400);
	}

	const apiKey = geoapifyKey(c.env);
	if (!apiKey) {
		return c.json({ error: "Venue search is not configured. Add GEOAPIFY_API_KEY to the Worker settings." }, 503);
	}

	const intent = parseSearchIntent(prompt);
	const selectedCategories = types.flatMap((type) => requestedCategories(type as VenueType, intent));
	try {
		const categoryResults = await Promise.all(types.map(async (type) => {
			const categories = requestedCategories(type as VenueType, intent);
			const params = new URLSearchParams({
				apiKey,
				categories: categories.join(","),
				filter: `circle:${longitude},${latitude},${radiusKm * 1000}`,
				bias: `proximity:${longitude},${latitude}`,
				limit: "100",
				lang: "en",
			});
			const response = await fetch(`https://api.geoapify.com/v2/places?${params}`, {
				signal: AbortSignal.timeout(10000),
			});
			if (!response.ok) throw new Error("Venue provider unavailable");
			const data: unknown = await response.json();
			if (!isRecord(data) || !Array.isArray(data.features)) throw new Error("Venue search returned an invalid response.");
			const elements = data.features
				.map((feature) => {
					const properties = isRecord(feature) ? feature.properties : undefined;
					const venue = venueResult(properties, categories, latitude, longitude);
					return venue && !isUnsuitableVenue(properties, selectedCategories, groupSize, venue.tags.capacity) ? venue : undefined;
				})
				.filter((venue): venue is NormalizedVenue => venue !== undefined)
				.sort(sortVenueCandidates)
				.slice(0, 20);
			return [type, elements] as const;
		}));
		const results = Object.fromEntries(categoryResults) as Record<VenueType, NormalizedVenue[]>;
		for (const type of venueTypes) results[type] ??= [];
		return c.json({ results });
	} catch (error) {
		if (error instanceof Error && error.message === "Venue search returned an invalid response.") {
			return c.json({ error: error.message }, 502);
		}
		return c.json({ error: "Venue search is temporarily unavailable. Please try again shortly." }, 502);
	}
});

app.post("/api/searches", async (c) => {
	if (!c.env.DB) return c.json({ error: "Shared searches are not configured. Set up the Cloudflare D1 database." }, 503);
	const contentLength = Number(c.req.header("content-length") || 0);
	if (contentLength > 1_000_000) return c.json({ error: "Search snapshot is too large." }, 413);
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Search snapshot must be valid JSON." }, 400);
	}
	const snapshot = validateSnapshot(body);
	if (!snapshot) return c.json({ error: "Search snapshot is invalid." }, 400);
	if (JSON.stringify(snapshot).length > 1_000_000) return c.json({ error: "Search snapshot is too large." }, 413);

	const id = crypto.randomUUID();
	try {
		await c.env.DB.prepare("INSERT INTO searches (id, created_at, search_json) VALUES (?, ?, ?)")
			.bind(id, Date.now(), JSON.stringify(snapshot))
			.run();
		return c.json({ id }, 201);
	} catch {
		return c.json({ error: "Could not save this search. Please try again." }, 503);
	}
});

app.get("/api/searches/:id", async (c) => {
	if (!c.env.DB) return c.json({ error: "Shared searches are not configured. Set up the Cloudflare D1 database." }, 503);
	const id = c.req.param("id");
	if (!isValidShareId(id)) return c.json({ error: "This share link is invalid." }, 400);
	const voterId = c.req.query("voterId");
	if (voterId !== undefined && !isValidShareId(voterId)) return c.json({ error: "The voting identity is invalid." }, 400);

	try {
		const search = await readSearch(c.env.DB, id);
		if (!search) return c.json({ error: "This shared search could not be found." }, 404);
		const shortlistRows = await c.env.DB.prepare(`
			SELECT s.venue_id, s.added_at, v.category, v.voter_id
			FROM shortlist AS s
			LEFT JOIN category_votes AS v ON v.search_id = s.search_id AND v.venue_id = s.venue_id
			WHERE s.search_id = ?
			ORDER BY s.added_at ASC
		`).bind(id).all<{
			venue_id: string;
			added_at: number;
			category: string | null;
			voter_id: string | null;
		}>();
		const shortlistByVenue = new Map<string, {
			venueId: string;
			addedAt: number;
			votes: Record<VenueType, number>;
			votedByMe: VenueType[];
		}>();
		for (const row of shortlistRows.results) {
			let entry = shortlistByVenue.get(row.venue_id);
			if (!entry) {
				entry = {
					venueId: row.venue_id,
					addedAt: row.added_at,
					votes: { activities: 0, food: 0, drinks: 0 },
					votedByMe: [],
				};
				shortlistByVenue.set(row.venue_id, entry);
			}
			if (row.category && venueTypes.includes(row.category as VenueType)) {
				const category = row.category as VenueType;
				entry.votes[category]++;
				if (row.voter_id === voterId && !entry.votedByMe.includes(category)) entry.votedByMe.push(category);
			}
		}
		const shortlist = [...shortlistByVenue.values()].sort((first, second) =>
			Object.values(second.votes).reduce((total, count) => total + count, 0) -
			Object.values(first.votes).reduce((total, count) => total + count, 0) || first.addedAt - second.addedAt,
		);
		c.header("Cache-Control", "no-store");
		return c.json({
			id,
			createdAt: search.createdAt,
			snapshot: search.snapshot,
			shortlist,
		});
	} catch {
		return c.json({ error: "Could not load this shared search. Please try again." }, 503);
	}
});

app.post("/api/searches/:id/shortlist", async (c) => {
	if (!c.env.DB) return c.json({ error: "Shared searches are not configured. Set up the Cloudflare D1 database." }, 503);
	const id = c.req.param("id");
	if (!isValidShareId(id)) return c.json({ error: "This share link is invalid." }, 400);
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Shortlist update must be valid JSON." }, 400);
	}
	if (!isRecord(body) || typeof body.venueId !== "string" || body.venueId.length < 1 || body.venueId.length > 200 ||
		(body.action !== "add" && body.action !== "remove")) return c.json({ error: "Shortlist update is invalid." }, 400);

	try {
		const search = await readSearch(c.env.DB, id);
		if (!search) return c.json({ error: "This shared search could not be found." }, 404);
		if (!snapshotHasVenue(search.snapshot, body.venueId)) return c.json({ error: "That venue is not part of this search." }, 404);
		if (body.action === "add") {
			await c.env.DB.prepare("INSERT OR IGNORE INTO shortlist (search_id, venue_id, added_at) VALUES (?, ?, ?)")
				.bind(id, body.venueId, Date.now()).run();
		} else {
			await c.env.DB.prepare("DELETE FROM shortlist WHERE search_id = ? AND venue_id = ?")
				.bind(id, body.venueId).run();
		}
		return c.json({ ok: true });
	} catch {
		return c.json({ error: "Could not update the shortlist. Please try again." }, 503);
	}
});

app.post("/api/searches/:id/votes", async (c) => {
	if (!c.env.DB) return c.json({ error: "Shared searches are not configured. Set up the Cloudflare D1 database." }, 503);
	const id = c.req.param("id");
	if (!isValidShareId(id)) return c.json({ error: "This share link is invalid." }, 400);
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Vote update must be valid JSON." }, 400);
	}
	if (!isRecord(body) || typeof body.venueId !== "string" || body.venueId.length < 1 || body.venueId.length > 200 ||
		typeof body.category !== "string" || !venueTypes.includes(body.category as VenueType) ||
		typeof body.voterId !== "string" || !isValidShareId(body.voterId) || typeof body.voted !== "boolean") {
		return c.json({ error: "Vote update is invalid." }, 400);
	}

	try {
		const search = await readSearch(c.env.DB, id);
		if (!search) return c.json({ error: "This shared search could not be found." }, 404);
		if (!snapshotHasVenue(search.snapshot, body.venueId)) return c.json({ error: "That venue is not part of this search." }, 404);
		const category = body.category as VenueType;
		if (!search.snapshot.results[category].some((venue) => venue.id === body.venueId)) {
			return c.json({ error: "That venue is not part of this category." }, 400);
		}
		const shortlistEntry = await c.env.DB.prepare("SELECT venue_id FROM shortlist WHERE search_id = ? AND venue_id = ?")
			.bind(id, body.venueId).first();
		if (!shortlistEntry) return c.json({ error: "Add the venue to the shortlist before voting." }, 409);
		if (body.voted) {
			await c.env.DB.prepare(`
				INSERT INTO category_votes (search_id, category, venue_id, voter_id, created_at)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(search_id, category, voter_id) DO UPDATE SET
					venue_id = excluded.venue_id,
					created_at = excluded.created_at
			`).bind(id, category, body.venueId, body.voterId, Date.now()).run();
		} else {
			await c.env.DB.prepare("DELETE FROM category_votes WHERE search_id = ? AND category = ? AND venue_id = ? AND voter_id = ?")
				.bind(id, category, body.venueId, body.voterId).run();
		}
		return c.json({ ok: true });
	} catch {
		return c.json({ error: "Could not record your vote. Please try again." }, 503);
	}
});

export default app;
