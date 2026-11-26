import { Hono } from "hono";

type WorkerBindings = { GEOAPIFY_API_KEY?: string };
type VenueType = "activities" | "food" | "drinks";

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
		category !== "catering.restaurant" && requestedCategories.includes(category),
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
	const groupSize = Number(groupSizeParam);
	if (
		groupSizeParam === undefined ||
		groupSizeParam.trim() === "" ||
		!Number.isSafeInteger(groupSize) ||
		groupSize < 1
	) {
		return c.json({ error: "Enter a valid whole-number group size, starting at 1." }, 400);
	}

	const apiKey = geoapifyKey(c.env);
	if (!apiKey) {
		return c.json({ error: "Venue search is not configured. Add GEOAPIFY_API_KEY to the Worker settings." }, 503);
	}

	const categories = [...new Set(types.flatMap((type) => categoriesByType[type as VenueType]))];
	try {
		const params = new URLSearchParams({
			apiKey,
			categories: categories.join(","),
			filter: `circle:${longitude},${latitude},5000`,
			bias: `proximity:${longitude},${latitude}`,
			limit: "100",
			lang: "en",
		});
		const response = await fetch(`https://api.geoapify.com/v2/places?${params}`, {
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) {
			return c.json({ error: "Venue search is temporarily unavailable. Please try again shortly." }, 502);
		}
		const data: unknown = await response.json();
		if (!data || typeof data !== "object" || !Array.isArray((data as { features?: unknown }).features)) {
			return c.json({ error: "Venue search returned an invalid response." }, 502);
		}
		const elements = (data as { features: unknown[] }).features
			.map((feature) => {
				const properties = feature && typeof feature === "object"
					? (feature as { properties?: unknown }).properties
					: undefined;
				const venue = venueResult(properties, categories, latitude, longitude);
				return venue && !isUnsuitableVenue(properties, categories, groupSize, venue.tags.capacity) ? venue : undefined;
			})
			.filter((venue): venue is NormalizedVenue => venue !== undefined)
			.sort(sortVenueCandidates)
			.slice(0, 20);
		return c.json({ elements });
	} catch {
		return c.json({ error: "Venue search is temporarily unavailable. Please try again shortly." }, 502);
	}
});

export default app;
