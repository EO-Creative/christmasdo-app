export type VenueType = "activities" | "food" | "drinks";

export interface MapCoordinates {
	lat: number;
	lon: number;
}

export interface MapBounds {
	south: number;
	north: number;
	west: number;
	east: number;
}

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

export function normalizeLongitude(lon: number): number {
	return ((lon + 180) % 360 + 360) % 360 - 180;
}

function validCoordinates(coordinates: MapCoordinates): boolean {
	return Number.isFinite(coordinates.lat) && coordinates.lat >= -90 && coordinates.lat <= 90 && Number.isFinite(coordinates.lon);
}

export function isCoordinateInBounds(coordinates: MapCoordinates, bounds: MapBounds): boolean {
	if (!validCoordinates(coordinates) || ![bounds.south, bounds.north, bounds.west, bounds.east].every(Number.isFinite) ||
		coordinates.lat < bounds.south || coordinates.lat > bounds.north) return false;
	const width = bounds.east - bounds.west;
	if (Math.abs(width) >= 360) return true;
	const span = (width + 360) % 360;
	const offset = ((coordinates.lon - bounds.west) % 360 + 360) % 360;
	return offset <= span;
}

export function filterMapVenuesInBounds<TVenue extends MapVenue>(entries: MapVenueEntry<TVenue>[], bounds: MapBounds): MapVenueEntry<TVenue>[] {
	return entries.filter(({ venue }) => {
		const coordinates = getVenueCoordinates(venue);
		return coordinates !== undefined && isCoordinateInBounds(coordinates, bounds);
	});
}

export function distanceMeters(from: MapCoordinates, to: MapCoordinates): number | undefined {
	if (!validCoordinates(from) || !validCoordinates(to)) return undefined;
	const radians = Math.PI / 180;
	const latDelta = (to.lat - from.lat) * radians;
	const lonDelta = normalizeLongitude(normalizeLongitude(to.lon) - normalizeLongitude(from.lon)) * radians;
	const haversine = Math.sin(latDelta / 2) ** 2 +
		Math.cos(from.lat * radians) * Math.cos(to.lat * radians) * Math.sin(lonDelta / 2) ** 2;
	return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

export function getVenueCoordinates(venue: MapVenue): MapCoordinates | undefined {
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
		const key = `${Number(coordinates.lat.toFixed(5)).toFixed(5)}:${normalizeLongitude(Number(coordinates.lon.toFixed(5))).toFixed(5)}`;
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