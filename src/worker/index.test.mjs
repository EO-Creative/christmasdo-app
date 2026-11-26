import assert from "node:assert/strict";
import { test } from "node:test";
import app from "./index.ts";

const bindings = { GEOAPIFY_API_KEY: "test-api-key" };

async function withMockedFetch(mockFetch, action) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = mockFetch;
	try {
		return await action();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

test("location suggestions reject blank text and skip queries shorter than three characters", async () => {
	const blank = await app.request("/api/suggest?q=%20%20");
	assert.equal(blank.status, 400);

	const short = await app.request("/api/suggest?q=Yo");
	assert.equal(short.status, 200);
	assert.deepEqual(await short.json(), { results: [] });
});

test("location suggestions require a server-side Geoapify key", async () => {
	await withMockedFetch(async () => {
		assert.fail("The upstream service should not be called without a key");
	}, async () => {
		const response = await app.request("/api/suggest?q=York", {}, {});
		assert.equal(response.status, 503);
		assert.match((await response.json()).error, /GEOAPIFY_API_KEY/);
	});
});

test("autocomplete requests Geoapify and maps valid suggestions", async () => {
	await withMockedFetch(async (input) => {
		const url = new URL(String(input));
		assert.equal(url.hostname, "api.geoapify.com");
		assert.equal(url.pathname, "/v1/geocode/autocomplete");
		assert.equal(url.searchParams.get("apiKey"), "test-api-key");
		assert.equal(url.searchParams.get("text"), "York, UK");
		assert.equal(url.searchParams.get("format"), "json");
		assert.equal(url.searchParams.get("limit"), "5");
		return Response.json({ results: [
			{ place_id: "york", formatted: "York, UK", lat: 53.96, lon: -1.08 },
			{ place_id: "invalid", formatted: "Out of range", lat: 95, lon: 0 },
			{ place_id: "unlabeled", lat: 53.96, lon: -1.08 },
		] });
	}, async () => {
		const response = await app.request("/api/suggest?q=York%2C%20UK", {}, bindings);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			results: [{ id: "york", label: "York, UK", lat: 53.96, lon: -1.08 }],
		});
	});
});

test("manual geocoding uses Geoapify forward search and normalizes coordinates", async () => {
	await withMockedFetch(async (input) => {
		const url = new URL(String(input));
		assert.equal(url.hostname, "api.geoapify.com");
		assert.equal(url.pathname, "/v1/geocode/search");
		assert.equal(url.searchParams.get("text"), "York, UK");
		assert.equal(url.searchParams.get("limit"), "1");
		return Response.json({ results: [{ place_id: "york", formatted: "York, UK", lat: 53.96, lon: -1.08 }] });
	}, async () => {
		const response = await app.request("/api/geocode?q=York%2C%20UK", {}, bindings);
		assert.equal(response.status, 200);
		assert.equal((await response.json()).results[0].id, "york");
	});
});

test("geocoding rejects a blank location", async () => {
	const response = await app.request("/api/geocode?q=%20%20");
	assert.equal(response.status, 400);
	assert.match((await response.json()).error, /location/i);
});

test("geocoding reports upstream and malformed-response errors", async () => {
	await withMockedFetch(async () => {
		return new Response("upstream unavailable", { status: 503 });
	}, async () => {
		const response = await app.request("/api/geocode?q=York", {}, bindings);
		assert.equal(response.status, 502);
		assert.match((await response.json()).error, /temporarily unavailable/i);
	});

	await withMockedFetch(async () => Response.json({ unexpected: [] }), async () => {
		const response = await app.request("/api/geocode?q=York", {}, bindings);
		assert.equal(response.status, 502);
		assert.match((await response.json()).error, /invalid response/i);
	});
});

test("venue search rejects invalid coordinates and unsupported or missing types", async () => {
	const invalidRequests = [
		"/api/venues?lat=91&lon=0&types=food&groupSize=10",
		"/api/venues?lat=0&lon=0&types=food",
		"/api/venues?lat=0&lon=0&types=food&groupSize=0",
		"/api/venues?lat=0&lon=0&types=food&groupSize=10.5",
		"/api/venues?lat=0&lon=0&types=food&groupSize=100000000000000000000",
		"/api/venues?lat=0&lon=0",
		"/api/venues?lat=0&lon=0&types=shopping&groupSize=10",
	];
	for (const request of invalidRequests) {
		assert.equal((await app.request(request)).status, 400);
	}
});

test("venue search requires the Worker key", async () => {
	await withMockedFetch(async () => {
		assert.fail("The upstream service should not be called without a key");
	}, async () => {
		const response = await app.request("/api/venues?lat=0&lon=0&types=food&groupSize=10", {}, {});
		assert.equal(response.status, 503);
		assert.match((await response.json()).error, /GEOAPIFY_API_KEY/);
	});
});

test("venue search requests nearby Geoapify categories and normalizes venue details", async () => {
	await withMockedFetch(async (input) => {
		const url = new URL(String(input));
		assert.equal(url.hostname, "api.geoapify.com");
		assert.equal(url.pathname, "/v2/places");
		assert.equal(url.searchParams.get("apiKey"), "test-api-key");
		assert.equal(url.searchParams.get("filter"), "circle:-1.0803,53.9583,5000");
		assert.equal(url.searchParams.get("bias"), "proximity:-1.0803,53.9583");
		assert.equal(url.searchParams.get("limit"), "100");
		assert.equal(url.searchParams.get("groupSize"), null);
		const categories = url.searchParams.get("categories").split(",");
		assert.ok(categories.includes("catering.restaurant"));
		assert.ok(!categories.includes("catering.cafe"));
		assert.ok(!categories.includes("catering.food_court"));
		assert.ok(categories.includes("adult.nightclub"));
		assert.ok(categories.includes("entertainment.escape_game"));
		return Response.json({ features: [
			{ properties: {
				place_id: "sample-venue",
				name: "Sample Venue",
				categories: ["catering.restaurant"],
				lat: 53.95,
				lon: -1.08,
				distance: 360,
				address_line1: "1 High Street",
				address_line2: "York",
				website: "https://example.test",
				phone: "+44123456789",
				datasource: { raw: { capacity: "32" } },
			} },
			{ properties: { name: "Missing coordinates" } },
		] });
	}, async () => {
		const response = await app.request(
			"/api/venues?lat=53.9583&lon=-1.0803&types=food,drinks,activities&groupSize=20",
			{},
			bindings,
		);
		assert.equal(response.status, 200);
		const venue = (await response.json()).elements[0];
		assert.equal(venue.id, "sample-venue");
		assert.equal(venue.tags.name, "Sample Venue");
		assert.equal(venue.tags.capacity, "32");
		assert.equal(venue.tags.amenity, "restaurant");
		assert.equal(venue.distance, 360);
		assert.equal(venue.address, "1 High Street, York");
		assert.equal(venue.tags.website, "https://example.test");
		assert.equal(venue.tags.phone, "+44123456789");
	});
});

test("single-category venue searches only request relevant provider categories and allow empty results", async () => {
	await withMockedFetch(async (input) => {
		const url = new URL(String(input));
		assert.equal(url.searchParams.get("categories"), "catering.restaurant");
		return Response.json({ features: [] });
	}, async () => {
		const response = await app.request("/api/venues?lat=53.9&lon=-1.1&types=food&groupSize=10", {}, bindings);
		assert.equal(response.status, 200);
		assert.deepEqual((await response.json()).elements, []);
	});
});

test("venue search filters cafés, fast food, and known-too-small listings while retaining suitable mixed venues", async () => {
	await withMockedFetch(async () => Response.json({ features: [
		{ properties: { name: "Costa Coffee", categories: ["catering.restaurant"], lat: 53.96, lon: -1.08 } },
		{ properties: { name: "Starbucks", categories: ["catering.restaurant"], lat: 53.96, lon: -1.08 } },
		{ properties: { name: "McDonald's", categories: ["catering.restaurant"], lat: 53.96, lon: -1.08 } },
		{ properties: { name: "York Cafe", categories: ["catering.restaurant", "catering.cafe"], lat: 53.96, lon: -1.08 } },
		{ properties: { name: "Quick Burger", categories: ["catering.restaurant", "catering.fast_food"], lat: 53.96, lon: -1.08 } },
		{ properties: { name: "Small Restaurant", categories: ["catering.restaurant"], lat: 53.96, lon: -1.08, datasource: { raw: { capacity: "12" } } } },
		{ properties: { name: "Suitable Restaurant", categories: ["catering.restaurant"], lat: 53.96, lon: -1.08, distance: 500, datasource: { raw: { capacity: "24" } } } },
		{ properties: { name: "Exactly Enough Restaurant", categories: ["catering.restaurant"], lat: 53.96, lon: -1.08, distance: 600, datasource: { raw: { capacity: "20" } } } },
		{ properties: { name: "Restaurant, Pub and Cafe", categories: ["catering.pub", "catering.restaurant", "catering.cafe"], lat: 53.96, lon: -1.08, distance: 700 } },
		{ properties: { name: "Escape Game with Cafe", categories: ["entertainment.escape_game", "catering.cafe"], lat: 53.96, lon: -1.08, distance: 800 } },
	] }), async () => {
		const response = await app.request(
			"/api/venues?lat=53.95&lon=-1.08&types=activities,food,drinks&groupSize=20",
			{},
			bindings,
		);
		assert.equal(response.status, 200);
		const venues = (await response.json()).elements;
		assert.deepEqual(venues.map((venue) => venue.tags.name), [
			"Suitable Restaurant",
			"Exactly Enough Restaurant",
			"Restaurant, Pub and Cafe",
			"Escape Game with Cafe",
		]);
	});
});

test("venue search filters unsuitable candidates before sorting and limiting the shortlist", async () => {
	await withMockedFetch(async (input) => {
		assert.equal(new URL(String(input)).searchParams.get("limit"), "100");
		const features = [
			...Array.from({ length: 25 }, (_, index) => ({ properties: {
				name: `Cafe ${index}`,
				categories: ["catering.restaurant", "catering.cafe"],
				lat: 53.96,
				lon: -1.08,
			} })),
			...Array.from({ length: 25 }, (_, index) => ({ properties: {
				name: `Small ${index}`,
				categories: ["catering.restaurant"],
				lat: 53.96,
				lon: -1.08,
				distance: index + 1,
				datasource: { raw: { capacity: "8" } },
			} })),
			...Array.from({ length: 25 }, (_, index) => ({ properties: {
				name: `Suitable ${index}`,
				categories: ["catering.restaurant"],
				lat: 53.96,
				lon: -1.08,
				distance: 100 + index,
				datasource: { raw: { capacity: "20" } },
			} })),
		];
		return Response.json({ features });
	}, async () => {
		const response = await app.request("/api/venues?lat=53.95&lon=-1.08&types=food&groupSize=10", {}, bindings);
		assert.equal(response.status, 200);
		const venues = (await response.json()).elements;
		assert.equal(venues.length, 20);
		assert.deepEqual(venues.slice(0, 2).map((venue) => venue.tags.name), ["Suitable 0", "Suitable 1"]);
		assert.ok(venues.every((venue) => venue.tags.name.startsWith("Suitable ")));
	});
});

test("venue search calculates a distance when the provider omits it", async () => {
	await withMockedFetch(async () => Response.json({ features: [{ properties: {
		place_id: "nearby",
		name: "Nearby Venue",
		categories: ["catering.restaurant"],
		lat: 53.96,
		lon: -1.08,
	} }] }), async () => {
		const response = await app.request("/api/venues?lat=53.9583&lon=-1.0803&types=food&groupSize=10", {}, bindings);
		assert.equal(response.status, 200);
		const venue = (await response.json()).elements[0];
		assert.equal(venue.tags.name, "Nearby Venue");
		assert.ok(venue.distance > 0);
		assert.ok(venue.distance < 5000);
	});
});

test("venue search reports provider outages and malformed results instead of empty results", async () => {
	await withMockedFetch(async () => new Response("busy", { status: 429 }), async () => {
		const response = await app.request("/api/venues?lat=0&lon=0&types=food&groupSize=10", {}, bindings);
		assert.equal(response.status, 502);
		assert.match((await response.json()).error, /temporarily unavailable/i);
	});

	await withMockedFetch(async () => Response.json({ elements: [] }), async () => {
		const response = await app.request("/api/venues?lat=0&lon=0&types=food&groupSize=10", {}, bindings);
		assert.equal(response.status, 502);
		assert.match((await response.json()).error, /invalid response/i);
	});
});