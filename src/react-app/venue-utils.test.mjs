import assert from "node:assert/strict";
import { test } from "node:test";
import { getCapacityStatus, parseVenueCapacity, sortVenuesBySuitability } from "./venue-utils.ts";

test("capacity status handles sufficient, insufficient, and unknown values", () => {
	assert.equal(getCapacityStatus("20", 20), "fits");
	assert.equal(getCapacityStatus("19", 20), "too-small");
	assert.equal(getCapacityStatus(undefined, 20), "unknown");
	assert.equal(getCapacityStatus("about 30", 20), "unknown");
});

test("capacity parser accepts positive integers only", () => {
	assert.equal(parseVenueCapacity(" 48 "), 48);
	assert.equal(parseVenueCapacity("0"), undefined);
	assert.equal(parseVenueCapacity("25; 50"), undefined);
	assert.equal(parseVenueCapacity("500000000000000000000"), undefined);
});

test("venue ordering puts known fits first and known-too-small last", () => {
	const venues = [
		{ tags: { name: "Unknown" } },
		{ tags: { name: "Too small", capacity: "8" } },
		{ tags: { name: "Large enough", capacity: "30" } },
		{ tags: { name: "Small enough", capacity: "20" } },
	];
	const ordered = sortVenuesBySuitability(venues, 20);
	assert.deepEqual(ordered.map((venue) => venue.tags.name), [
		"Large enough",
		"Small enough",
		"Unknown",
		"Too small",
	]);
	assert.deepEqual(venues.map((venue) => venue.tags.name), ["Unknown", "Too small", "Large enough", "Small enough"]);
});

test("venue ordering uses proximity within each capacity group", () => {
	const venues = [
		{ tags: { name: "Unknown far away" }, distance: 1800 },
		{ tags: { name: "Fits nearby", capacity: "12" }, distance: 500 },
		{ tags: { name: "Too small nearby", capacity: "6" }, distance: 100 },
		{ tags: { name: "Fits far away", capacity: "12" }, distance: 2400 },
	];
	const ordered = sortVenuesBySuitability(venues, 10);
	assert.deepEqual(ordered.map((venue) => venue.tags.name), [
		"Fits nearby",
		"Fits far away",
		"Unknown far away",
		"Too small nearby",
	]);
});