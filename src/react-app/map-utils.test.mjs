import assert from "node:assert/strict";
import { test } from "node:test";
import { distanceMeters, filterMapVenuesInBounds, getVenueCoordinates, groupMapVenues, isCoordinateInBounds, normalizeLongitude } from "./map-utils.ts";

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

test("filters individual entries inclusively before grouping", () => {
	const entries = [
		{ venue: venue("shared", 10, 20), type: "food" },
		{ venue: venue("shared", 10, 20), type: "drinks" },
		{ venue: venue("just-outside", 10.000004, 20), type: "activities" },
		{ venue: venue("invalid", undefined, undefined), type: "food" },
	];
	const filtered = filterMapVenuesInBounds(entries, { south: 0, north: 10, west: 20, east: 30 });
	assert.deepEqual(filtered.map(({ type }) => type), ["food", "drinks"]);
	assert.deepEqual(groupMapVenues(filtered)[0].categoryTypes, ["food", "drinks"]);
});

test("handles wrapped, unwrapped, and world-spanning longitude bounds", () => {
	assert.equal(normalizeLongitude(540), -180);
	assert.equal(normalizeLongitude(-181), 179);
	const crossed = { south: -10, north: 10, west: 170, east: -170 };
	assert.equal(isCoordinateInBounds({ lat: 0, lon: 179 }, crossed), true);
	assert.equal(isCoordinateInBounds({ lat: 0, lon: -179 }, crossed), true);
	assert.equal(isCoordinateInBounds({ lat: 0, lon: 0 }, crossed), false);
	assert.equal(isCoordinateInBounds({ lat: 11, lon: 179 }, crossed), false);
	assert.equal(isCoordinateInBounds({ lat: 0, lon: -179 }, { ...crossed, east: 190 }), true);
	assert.equal(isCoordinateInBounds({ lat: 0, lon: 0 }, { ...crossed, east: 530 }), true);
	assert.equal(isCoordinateInBounds({ lat: 0, lon: 180 }, { ...crossed, west: -180, east: -180 }), true);
	assert.equal(isCoordinateInBounds({ lat: 0, lon: 1 }, { ...crossed, west: -180, east: -180 }), false);
	assert.equal(isCoordinateInBounds({ lat: 0, lon: Number.NaN }, crossed), false);
});

test("groups equivalent antimeridian coordinates together", () => {
	const groups = groupMapVenues([
		{ venue: venue("east", 0, 180), type: "food" },
		{ venue: venue("west", 0, -180), type: "drinks" },
	]);
	assert.equal(groups.length, 1);
	assert.deepEqual(groups[0].categoryTypes, ["food", "drinks"]);
});

test("calculates great-circle distance in metres, including across the antimeridian", () => {
	assert.equal(distanceMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 360 }), 0);
	assert.ok(Math.abs(distanceMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111195) < 2);
	assert.ok(Math.abs(distanceMeters({ lat: 0, lon: 179 }, { lat: 0, lon: -179 }) - 222390) < 3);
	assert.ok(Math.abs(distanceMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }) - 20015114) < 3);
	assert.equal(distanceMeters({ lat: 91, lon: 0 }, { lat: 0, lon: 0 }), undefined);
	assert.equal(distanceMeters({ lat: 0, lon: NaN }, { lat: 0, lon: 0 }), undefined);
});