export type CapacityStatus = "fits" | "too-small" | "unknown";

interface VenueWithCapacity {
	tags: {
		name?: string;
		capacity?: string;
	};
	distance?: number;
}

export function parseVenueCapacity(value?: string): number | undefined {
	if (!value || !/^\d+$/.test(value.trim())) return undefined;

	const capacity = Number(value.trim());
	return Number.isSafeInteger(capacity) && capacity > 0 ? capacity : undefined;
}

export function getCapacityStatus(capacityValue: string | undefined, groupSize: number): CapacityStatus {
	const capacity = parseVenueCapacity(capacityValue);
	if (capacity === undefined) return "unknown";
	return capacity >= groupSize ? "fits" : "too-small";
}

export function sortVenuesBySuitability<T extends VenueWithCapacity>(venues: T[], groupSize: number): T[] {
	const rank: Record<CapacityStatus, number> = { fits: 0, unknown: 1, "too-small": 2 };
	return [...venues].sort((first, second) => {
		const statusOrder = rank[getCapacityStatus(first.tags.capacity, groupSize)] -
			rank[getCapacityStatus(second.tags.capacity, groupSize)];
		if (statusOrder !== 0) return statusOrder;
		const firstDistance = Number.isFinite(first.distance) ? Number(first.distance) : Number.POSITIVE_INFINITY;
		const secondDistance = Number.isFinite(second.distance) ? Number(second.distance) : Number.POSITIVE_INFINITY;
		if (firstDistance < secondDistance) return -1;
		if (firstDistance > secondDistance) return 1;
		return (first.tags.name || "").localeCompare(second.tags.name || "");
	});
}