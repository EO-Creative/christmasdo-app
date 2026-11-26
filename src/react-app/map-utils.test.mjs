import assert from "node:assert/strict";
import { test } from "node:test";
import { getVenueCoordinates, groupMapVenues } from "./map-utils.ts";

const venue = (id, lat, lon, center) => ({
	id,
	lat,
	lon,
	center,
	tags: { name: id },
});

test("groups co-located venues and retains category membership", () => {
	const entries = [
		{ venue: venue("shared", 53.96, -1.08), type: "food" },
		{ venue: venue("shared", 53.96, -1.08), type: "drinks" },
		{ venue: venue("nearby", 53.960001, -1.080001), type: "activities" },
		{ venue: venue("elsewhere", 53.97, -1.08), type: "food" },
	];
	const groups = groupMapVenues(entries);

	assert.equal(groups.length, 2);
	assert.deepEqual(groups[0].categoryTypes, ["food", "drinks", "activities"]);
	assert.deepEqual(groups[0].entries.map(({ venue: candidate, type }) => `${candidate.id}:${type}`), [
		"shared:food",
		"shared:drinks",
		"nearby:activities",
	]);
});

test("uses centre coordinates when direct coordinates are absent", () => {
	assert.deepEqual(getVenueCoordinates(venue("way", undefined, undefined, { lat: 53.96, lon: -1.08 })), {
		lat: 53.96,
		lon: -1.08,
	});
});

test("ignores missing, non-finite, and out-of-range coordinates", () => {
	const entries = [
		{ venue: venue("missing", undefined, undefined), type: "food" },
		{ venue: venue("nan", Number.NaN, 0), type: "food" },
		{ venue: venue("bad-lat", 91, 0), type: "food" },
		{ venue: venue("bad-lon", 0, 181), type: "drinks" },
	];

	assert.equal(groupMapVenues(entries).length, 0);
	assert.equal(getVenueCoordinates(venue("infinite", 0, Number.POSITIVE_INFINITY)), undefined);
});

test("empty input has no marker groups", () => {
	assert.deepEqual(groupMapVenues([]), []);
});