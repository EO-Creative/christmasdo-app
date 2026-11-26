import type { SearchIntent, VenueType } from "../shared/search-intent.ts";

export const VENUE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
export const VENUE_CACHE_MAX_BYTES = 256 * 1024;
export const VENUE_CACHE_MAX_ENTRIES = 512;

export interface VenueCacheSearch {
	latitude: number;
	longitude: number;
	radiusKm: number;
	groupSize: number;
	types: VenueType[];
	filters: Pick<SearchIntent, "activityCategories" | "cuisineCategories" | "socialGames">;
}

export interface CachedVenue {
	id: string;
	type: "node";
	lat: number;
	lon: number;
	distance: number;
	address: string;
	category: string;
	tags: {
		name: string;
		amenity: string | undefined;
		leisure: string | undefined;
		"addr:street": string | undefined;
		"addr:housenumber": string | undefined;
		"addr:city": string | undefined;
		"addr:postcode": string | undefined;
		website: string | undefined;
		phone: string | undefined;
		capacity: string | undefined;
		price: string | undefined;
		[key: string]: string | undefined;
	};
}

export type VenueCacheResults = Record<VenueType, CachedVenue[]>;

const venueTypes: VenueType[] = ["activities", "food", "drinks"];
const encoder = new TextEncoder();

function categorySet(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length > 32 || value.some((category) =>
		typeof category !== "string" || category.length > 128 || !/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(category),
	)) return undefined;
	return [...new Set(value as string[])].sort();
}

export async function venueCacheKey(search: VenueCacheSearch): Promise<string | undefined> {
	if (!search || !Number.isFinite(search.latitude) || search.latitude < -90 || search.latitude > 90 ||
		!Number.isFinite(search.longitude) || search.longitude < -180 || search.longitude > 180 ||
		![1, 2, 5, 10, 20].includes(search.radiusKm) || !Number.isSafeInteger(search.groupSize) ||
		search.groupSize < 1 || search.groupSize > 10000 || !Array.isArray(search.types) ||
		search.types.length < 1 || search.types.length > venueTypes.length ||
		search.types.some((type) => !venueTypes.includes(type)) || new Set(search.types).size !== search.types.length ||
		!search.filters || typeof search.filters.socialGames !== "boolean") return undefined;
	const activityCategories = categorySet(search.filters.activityCategories);
	const cuisineCategories = categorySet(search.filters.cuisineCategories);
	if (!activityCategories || !cuisineCategories) return undefined;
	const canonical = JSON.stringify([1, search.latitude, search.longitude, search.radiusKm, search.groupSize,
		[...search.types].sort(), activityCategories, cuisineCategories, search.filters.socialGames]);
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical));
	return `v1:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isVenue(value: unknown): value is CachedVenue {
	return isRecord(value) && typeof value.id === "string" && value.type === "node" &&
		typeof value.lat === "number" && Number.isFinite(value.lat) && value.lat >= -90 && value.lat <= 90 &&
		typeof value.lon === "number" && Number.isFinite(value.lon) && value.lon >= -180 && value.lon <= 180 &&
		typeof value.distance === "number" && Number.isFinite(value.distance) &&
		typeof value.address === "string" && typeof value.category === "string" && isRecord(value.tags) &&
		typeof value.tags.name === "string" && !!value.tags.name.trim() &&
		Object.values(value.tags).every((field) => field === undefined || typeof field === "string");
}

function isResults(value: unknown): value is VenueCacheResults {
	return isRecord(value) && Object.keys(value).length === venueTypes.length && venueTypes.every((type) =>
		Array.isArray(value[type]) && value[type].length <= 20 && value[type].every(isVenue),
	);
}

export async function getCachedVenueResults(
	db: D1Database | undefined,
	search: VenueCacheSearch,
	load: () => Promise<VenueCacheResults>,
): Promise<VenueCacheResults> {
	if (!db) return load();
	let key: string | undefined;
	try {
		key = await venueCacheKey(search);
	} catch {
		return load();
	}
	if (!key) return load();

	try {
		const row = await db.prepare("SELECT results_json, expires_at FROM venue_cache WHERE cache_key = ?")
			.bind(key).first<{ results_json: unknown; expires_at: unknown }>();
		const now = Date.now();
		if (row && typeof row.expires_at === "number" && row.expires_at <= now) {
			await db.prepare("DELETE FROM venue_cache WHERE cache_key = ? AND expires_at <= ?").bind(key, now).run();
		} else if (row && typeof row.expires_at === "number" && row.expires_at <= now + VENUE_CACHE_TTL_MS &&
			typeof row.results_json === "string" && encoder.encode(row.results_json).byteLength <= VENUE_CACHE_MAX_BYTES) {
			const parsed: unknown = JSON.parse(row.results_json);
			if (isResults(parsed)) return parsed;
		}
	} catch {
		// A cache failure must not prevent a live venue search.
	}

	const results = await load();
	try {
		if (!isResults(results)) return results;
		const json = JSON.stringify(results);
		if (encoder.encode(json).byteLength > VENUE_CACHE_MAX_BYTES) return results;
		const now = Date.now();
		await db.batch([
			db.prepare("DELETE FROM venue_cache WHERE expires_at <= ?").bind(now),
			db.prepare("INSERT INTO venue_cache (cache_key, results_json, expires_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET results_json = excluded.results_json, expires_at = excluded.expires_at")
				.bind(key, json, now + VENUE_CACHE_TTL_MS),
			db.prepare("DELETE FROM venue_cache WHERE cache_key IN (SELECT cache_key FROM venue_cache ORDER BY expires_at DESC, cache_key ASC LIMIT -1 OFFSET ?)")
				.bind(VENUE_CACHE_MAX_ENTRIES),
		]);
	} catch {
		// Cache writes are best effort; the live results remain usable.
	}
	return results;
}