export type VenueType = "activities" | "food" | "drinks";

export interface MapVenue {
	id: string;
	lat?: number;
	lon?: number;
	center?: { lat: number; lon: number };
	tags: { name?: string };
}

export interface MapVenueEntry<TVenue extends MapVenue = MapVenue> {
	venue: TVenue;
	type: VenueType;
}

export interface VenueMapGroup<TVenue extends MapVenue = MapVenue> {
	key: string;
	lat: number;
	lon: number;
	entries: MapVenueEntry<TVenue>[];
	categoryTypes: VenueType[];
}

export function getVenueCoordinates(venue: MapVenue): { lat: number; lon: number } | undefined {
	const lat = typeof venue.lat === "number" ? venue.lat : venue.center?.lat;
	const lon = typeof venue.lon === "number" ? venue.lon : venue.center?.lon;
	if (typeof lat !== "number" || typeof lon !== "number" ||
		!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
		return undefined;
	}
	return { lat, lon };
}

export function groupMapVenues<TVenue extends MapVenue>(entries: MapVenueEntry<TVenue>[]): VenueMapGroup<TVenue>[] {
	const groups = new Map<string, VenueMapGroup<TVenue>>();
	for (const entry of entries) {
		const coordinates = getVenueCoordinates(entry.venue);
		if (!coordinates) continue;
		const key = `${coordinates.lat.toFixed(5)}:${coordinates.lon.toFixed(5)}`;
		let group = groups.get(key);
		if (!group) {
			group = { key, ...coordinates, entries: [], categoryTypes: [] };
			groups.set(key, group);
		}
		if (!group.entries.some((candidate) => candidate.type === entry.type && candidate.venue.id === entry.venue.id)) {
			group.entries.push(entry);
			if (!group.categoryTypes.includes(entry.type)) group.categoryTypes.push(entry.type);
		}
	}
	return [...groups.values()];
}