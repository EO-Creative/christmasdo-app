import assert from "node:assert/strict";
import { test } from "node:test";
import app from "./index.ts";
import { parseSearchIntent } from "../shared/search-intent.ts";

const bindings = { GEOAPIFY_API_KEY: "test-api-key" };

class MemoryD1 {
	searches = new Map();
	shortlist = new Map();
	votes = new Map();
	aiUsage = new Map();

	prepare(query) {
		return {
			bind: (...values) => ({
				first: async () => this.first(query, values),
				all: async () => ({ results: this.all(query, values) }),
				run: async () => this.run(query, values),
			}),
		};
	}

	first(query, values) {
		if (query.includes("INSERT INTO ai_daily_usage")) {
			const count = this.aiUsage.get(values[0]) ?? 0;
			if (count >= 100) return null;
			this.aiUsage.set(values[0], count + 1);
			return { requests: count + 1 };
		}
		if (query.includes("SELECT search_json, created_at FROM searches")) {
			const search = this.searches.get(values[0]);
			return search && { search_json: search.json, created_at: search.createdAt };
		}
		if (query.includes("SELECT venue_id FROM shortlist")) {
			return this.shortlist.has(`${values[0]}:${values[1]}`) ? { venue_id: values[1] } : null;
		}
		return null;
	}

	all(query, values) {
		if (!query.includes("FROM shortlist AS s") || !query.includes("category_votes")) return [];
		const searchId = values[0];
		return [...this.shortlist.entries()]
			.filter(([key]) => key.startsWith(`${searchId}:`))
			.flatMap(([key, addedAt]) => {
				const venueId = key.slice(searchId.length + 1);
				const venueVotes = [...this.votes.values()].filter((vote) => vote.searchId === searchId && vote.venueId === venueId);
				return venueVotes.length
					? venueVotes.map((vote) => ({ venue_id: venueId, added_at: addedAt, category: vote.category, voter_id: vote.voterId }))
					: [{ venue_id: venueId, added_at: addedAt, category: null, voter_id: null }];
			})
			.sort((first, second) => first.added_at - second.added_at);
	}

	run(query, values) {
		if (query.includes("INSERT INTO searches")) {
			this.searches.set(values[0], { createdAt: values[1], json: values[2] });
		} else if (query.includes("UPDATE searches SET search_json = json_insert")) {
			const [path, raw, id, , , , venueId] = values;
			const search = this.searches.get(id);
			const snapshot = JSON.parse(search.json);
			const venues = snapshot.results[path.split(".").at(-1)];
			if (venues.length < 200 && search.json.length + raw.length < 1000000 && !venues.some((venue) => venue.id === venueId)) {
				venues.push(JSON.parse(raw));
				search.json = JSON.stringify(snapshot);
			}
		} else if (query.includes("INSERT OR IGNORE INTO shortlist")) {
			this.shortlist.set(`${values[0]}:${values[1]}`, values[2]);
		} else if (query.includes("DELETE FROM shortlist")) {
			const key = `${values[0]}:${values[1]}`;
			this.shortlist.delete(key);
			for (const [voteKey, vote] of this.votes) {
				if (vote.searchId === values[0] && vote.venueId === values[1]) this.votes.delete(voteKey);
			}
		} else if (query.includes("INSERT INTO category_votes")) {
			const [searchId, category, venueId, voterId, createdAt] = values;
			this.votes.set(`${searchId}:${category}:${voterId}`, { searchId, category, venueId, voterId, createdAt });
		} else if (query.includes("DELETE FROM category_votes")) {
			const [searchId, category, venueId, voterId] = values;
			const key = `${searchId}:${category}:${voterId}`;
			if (this.votes.get(key)?.venueId === venueId) this.votes.delete(key);
		}
		return { success: true };
	}
}

const testSnapshot = {
	location: { label: "York, UK", lat: 53.96, lon: -1.08 },
	groupSize: 10,
	radiusKm: 5,
	types: ["food"],
	results: {
		activities: [],
		food: [{
			id: "restaurant-1",
			type: "node",
			lat: 53.96,
			lon: -1.08,
			category: "restaurant",
			distance: 100,
			tags: { name: "Test Restaurant" },
		}],
		drinks: [],
	},
};

const activityVenue = {
	...testSnapshot.results.food[0],
	id: "activity-1",
	category: "bowling alley",
	tags: { name: "Bowling" },
};

const multiCategorySnapshot = {
	...testSnapshot,
	types: ["activities", "food", "drinks"],
	results: {
		activities: [activityVenue],
		food: [
			testSnapshot.results.food[0],
			{ ...testSnapshot.results.food[0], id: "restaurant-2", tags: { name: "Second Restaurant" } },
			activityVenue,
		],
		drinks: [{ ...testSnapshot.results.food[0], id: "pub-1", category: "pub", tags: { name: "Pub" } }],
	},
};

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
		assert.equal(url.searchParams.get("type"), "city");
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
		assert.equal(url.searchParams.get("limit"), "5");
		assert.equal(url.searchParams.get("type"), "city");
		return Response.json({ results: [{ place_id: "york", city: "York", formatted: "York, UK", lat: 53.96, lon: -1.08 }] });
	}, async () => {
		const response = await app.request("/api/geocode?q=York%2C%20UK", {}, bindings);
		assert.equal(response.status, 200);
		assert.equal((await response.json()).results[0].id, "york");
	});
});

test("geocoding prefers an exact city match but falls back for a specific address", async () => {
	const queries = [];
	await withMockedFetch(async (input) => {
		const url = new URL(String(input));
		queries.push(url.searchParams.get("type"));
		const text = url.searchParams.get("text");
		if (text === "Liverpool") return Response.json({ results: [{ place_id: "wrong", city: "Liverpool", formatted: "yes, Liverpool, UK", lat: 53.39, lon: -2.92 }, { place_id: "city", city: "Liverpool", formatted: "Liverpool, UK", lat: 53.407, lon: -2.99 }] });
		if (url.searchParams.get("type") === "city") return Response.json({ results: [{ city: "Liverpool", formatted: "Liverpool, UK", lat: 53.407, lon: -2.99 }] });
		return Response.json({ results: [{ place_id: "address", formatted: "1 Road, Liverpool", lat: 53.41, lon: -2.99 }] });
	}, async () => {
		assert.equal((await (await app.request("/api/geocode?q=Liverpool", {}, bindings)).json()).results[0].id, "city");
		assert.equal((await (await app.request("/api/geocode?q=1%20Road%2C%20Liverpool", {}, bindings)).json()).results[0].id, "address");
	});
	assert.deepEqual(queries, ["city", "city", null]);
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
		"/api/venues?lat=91&lon=0&types=food&groupSize=10&radiusKm=5",
		"/api/venues?lat=0&lon=0&types=food",
		"/api/venues?lat=0&lon=0&types=food&groupSize=0&radiusKm=5",
		"/api/venues?lat=0&lon=0&types=food&groupSize=10001&radiusKm=5",
		"/api/venues?lat=0&lon=0&types=food&groupSize=10.5&radiusKm=5",
		"/api/venues?lat=0&lon=0&types=food&groupSize=100000000000000000000&radiusKm=5",
		"/api/venues?lat=0&lon=0",
		"/api/venues?lat=0&lon=0&types=shopping&groupSize=10&radiusKm=5",
		"/api/venues?lat=0&lon=0&types=food&groupSize=10&radiusKm=3",
		"/api/venues?lat=0&lon=0&types=food,food&groupSize=10&radiusKm=5",
		`/api/venues?lat=0&lon=0&types=food&groupSize=10&radiusKm=5&prompt=${"x".repeat(501)}`,
	];
	for (const request of invalidRequests) {
		assert.equal((await app.request(request)).status, 400);
	}
});

test("venue search requires the Worker key", async () => {
	await withMockedFetch(async () => {
		assert.fail("The upstream service should not be called without a key");
	}, async () => {
		const response = await app.request("/api/venues?lat=0&lon=0&types=food&groupSize=10&radiusKm=5", {}, {});
		assert.equal(response.status, 503);
		assert.match((await response.json()).error, /GEOAPIFY_API_KEY/);
	});
});

test("venue search requests a separate radius-bounded query for each selected type", async () => {
	const queriedCategories = [];
	await withMockedFetch(async (input) => {
		const url = new URL(String(input));
		assert.equal(url.hostname, "api.geoapify.com");
		assert.equal(url.pathname, "/v2/places");
		assert.equal(url.searchParams.get("apiKey"), "test-api-key");
		assert.equal(url.searchParams.get("filter"), "circle:-1.0803,53.9583,2000");
		assert.equal(url.searchParams.get("bias"), "proximity:-1.0803,53.9583");
		assert.equal(url.searchParams.get("limit"), "100");
		assert.equal(url.searchParams.get("groupSize"), null);
		const categories = url.searchParams.get("categories").split(",");
		queriedCategories.push(categories);
		if (!categories.includes("catering.restaurant")) return Response.json({ features: [] });
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
			"/api/venues?lat=53.9583&lon=-1.0803&types=food,drinks,activities&groupSize=20&radiusKm=2",
			{},
			bindings,
		);
		assert.equal(response.status, 200);
		const responseData = await response.json();
		assert.deepEqual(Object.keys(responseData.results).sort(), ["activities", "drinks", "food"]);
		const venue = responseData.results.food[0];
		assert.equal(queriedCategories.length, 3);
		assert.deepEqual(queriedCategories.sort((first, second) => first.length - second.length), [
			["catering.restaurant"],
			["catering.bar", "catering.biergarten", "catering.pub", "adult.nightclub"],
			[
				"entertainment.activity_park",
				"entertainment.amusement_arcade",
				"entertainment.bowling_alley",
				"entertainment.cinema",
				"entertainment.culture.theatre",
				"entertainment.escape_game",
				"entertainment.miniature_golf",
			],
		].sort((first, second) => first.length - second.length));
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

test("venue results remain in their independently selected category lists", async () => {
	await withMockedFetch(async (input) => {
		const categories = new URL(String(input)).searchParams.get("categories").split(",");
		if (categories.includes("catering.restaurant")) {
			return Response.json({ features: [{ properties: {
				place_id: "food-place",
				name: "Dinner House",
				categories: ["catering.restaurant"],
				lat: 53.96,
				lon: -1.08,
			} }] });
		}
		if (categories.includes("catering.pub")) {
			return Response.json({ features: [{ properties: {
				place_id: "drinks-place",
				name: "York Pub",
				categories: ["catering.pub"],
				lat: 53.96,
				lon: -1.08,
			} }] });
		}
		return Response.json({ features: [{ properties: {
			place_id: "activity-place",
			name: "Escape Venue",
			categories: ["entertainment.escape_game"],
			lat: 53.96,
			lon: -1.08,
		} }] });
	}, async () => {
		const response = await app.request(
			"/api/venues?lat=53.95&lon=-1.08&types=food,drinks,activities&groupSize=10&radiusKm=5",
			{},
			bindings,
		);
		assert.equal(response.status, 200);
		const { results } = await response.json();
		assert.deepEqual(results.food.map((venue) => venue.tags.name), ["Dinner House"]);
		assert.deepEqual(results.drinks.map((venue) => venue.tags.name), ["York Pub"]);
		assert.deepEqual(results.activities.map((venue) => venue.tags.name), ["Escape Venue"]);
	});
});

test("venue search interprets sports and cuisine preferences as supported Geoapify categories", async () => {
	const queriedCategories = [];
	await withMockedFetch(async (input) => {
		const url = new URL(String(input));
		const categories = url.searchParams.get("categories").split(",");
		queriedCategories.push(categories);
		const place = categories.includes("sport.sports_centre")
			? { place_id: "sports-centre", name: "Sports Centre", categories: ["sport.sports_centre"] }
			: categories.includes("catering.restaurant.lebanese")
				? { place_id: "lebanese", name: "Lebanese Kitchen", categories: ["catering.restaurant.lebanese"] }
				: { place_id: "pub", name: "Local Pub", categories: ["catering.pub"] };
		return Response.json({ features: [{ properties: { ...place, lat: 53.96, lon: -1.08 } }] });
	}, async () => {
		const params = new URLSearchParams({
			lat: "53.96",
			lon: "-1.08",
			types: "activities,food,drinks",
			groupSize: "10",
			radiusKm: "5",
			prompt: "Indoor sports activities with options for beer and wine at a midrange budget and some Lebanese food",
		});
		const response = await app.request(`/api/venues?${params}`, {}, bindings);
		assert.equal(response.status, 200);
		const { results } = await response.json();
		assert.deepEqual(results.activities.map((venue) => venue.tags.name), ["Sports Centre"]);
		assert.deepEqual(results.food.map((venue) => venue.tags.name), ["Lebanese Kitchen"]);
		assert.deepEqual(results.drinks.map((venue) => venue.tags.name), ["Local Pub"]);
	});
	assert.deepEqual(queriedCategories, [
		["sport.sports_centre", "sport.sports_hall", "sport.ice_rink", "entertainment.bowling_alley"],
		["catering.restaurant.lebanese"],
		["catering.bar", "catering.biergarten", "catering.pub", "adult.nightclub"],
	]);
});

test("Flight Club-style searches keep Italian food separate and add only evidence-backed game bars to activities", async () => {
	const queriedCategories = [];
	await withMockedFetch(async (input) => {
		const categories = new URL(String(input)).searchParams.get("categories").split(",");
		queriedCategories.push(categories);
		if (categories.includes("catering.restaurant.italian")) {
			return Response.json({ features: [{ properties: {
				place_id: "italian",
				name: "Italian Kitchen",
				categories: ["catering.restaurant.italian"],
				lat: 53.96,
				lon: -1.08,
			} }] });
		}
		if (categories.includes("entertainment.bowling_alley")) {
			return Response.json({ features: [
				{ properties: {
					place_id: "bowling",
					name: "Bowling Social",
					categories: ["entertainment.bowling_alley"],
					lat: 53.96,
					lon: -1.08,
				} },
				{ properties: {
					place_id: "darts-pub",
					name: "Darts Pub",
					categories: ["entertainment.amusement_arcade", "catering.pub"],
					lat: 53.961,
					lon: -1.08,
					distance: 200,
					datasource: { raw: { sport: "darts", capacity: "12" } },
				} },
			] });
		}
		return Response.json({ features: [
			{ properties: {
				place_id: "darts-pub",
				name: "Darts Pub",
				categories: ["catering.pub"],
				lat: 53.961,
				lon: -1.08,
				distance: 200,
				datasource: { raw: { sport: "darts", capacity: "12" } },
			} },
			{ properties: {
				place_id: "flight-club",
				name: "Flight Club",
				categories: ["catering.bar"],
				lat: 53.9605,
				lon: -1.08,
				distance: 100,
				datasource: { raw: { capacity: "12" } },
			} },
			{ properties: {
				place_id: "ordinary-pub",
				name: "Ordinary Pub",
				categories: ["catering.pub"],
				lat: 53.962,
				lon: -1.08,
			} },
			{ properties: {
				place_id: "small-darts-pub",
				name: "Small Darts Pub",
				categories: ["catering.pub"],
				lat: 53.963,
				lon: -1.08,
				datasource: { raw: { game: "darts", capacity: "8" } },
			} },
		] });
	}, async () => {
		const params = new URLSearchParams({
			lat: "53.96",
			lon: "-1.08",
			types: "activities,food",
			groupSize: "10",
			radiusKm: "5",
			prompt: "We liked flight club last time, so something simliar to that. The team has suggested Italian as an easy option, and then they can make their own arrangements if they want to go clubbing afterwards",
		});
		const response = await app.request(`/api/venues?${params}`, {}, bindings);
		assert.equal(response.status, 200);
		const { results } = await response.json();
		assert.deepEqual(results.activities.map((venue) => venue.tags.name), ["Flight Club", "Darts Pub", "Bowling Social"]);
		assert.equal(results.activities.filter((venue) => venue.id === "darts-pub").length, 1);
		assert.deepEqual(results.food.map((venue) => venue.tags.name), ["Italian Kitchen"]);
		assert.deepEqual(results.drinks, []);
	});
	assert.deepEqual(queriedCategories, [
		["entertainment.bowling_alley", "entertainment.miniature_golf", "entertainment.amusement_arcade"],
		["catering.restaurant.italian"],
		["catering.bar", "catering.biergarten", "catering.pub", "adult.nightclub"],
	]);
});

test("social-game searches reuse the selected Drinks results for evidence-backed game bars", async () => {
	const queriedCategories = [];
	await withMockedFetch(async (input) => {
		const categories = new URL(String(input)).searchParams.get("categories").split(",");
		queriedCategories.push(categories);
		const isActivities = categories.includes("entertainment.bowling_alley");
		return Response.json({ features: [{ properties: {
			place_id: isActivities ? "bowling" : "darts-pub",
			name: isActivities ? "Bowling Social" : "Darts Pub",
			categories: isActivities ? ["entertainment.bowling_alley"] : ["catering.pub"],
			lat: 53.96,
			lon: -1.08,
			...(isActivities ? {} : { datasource: { raw: { sport: "darts" } } }),
		} }] });
	}, async () => {
		const params = new URLSearchParams({
			lat: "53.96",
			lon: "-1.08",
			types: "activities,drinks",
			groupSize: "10",
			radiusKm: "5",
			prompt: "Flight Club and drinks",
		});
		const response = await app.request(`/api/venues?${params}`, {}, bindings);
		assert.equal(response.status, 200);
		const { results } = await response.json();
		assert.deepEqual(results.activities.map((venue) => venue.tags.name), ["Bowling Social", "Darts Pub"]);
		assert.deepEqual(results.drinks.map((venue) => venue.tags.name), ["Darts Pub"]);
	});
	assert.equal(queriedCategories.length, 2);
});

test("single-category venue searches only request relevant provider categories and allow empty results", async () => {
	await withMockedFetch(async (input) => {
		const url = new URL(String(input));
		assert.equal(url.searchParams.get("categories"), "catering.restaurant");
		return Response.json({ features: [] });
	}, async () => {
		const response = await app.request("/api/venues?lat=53.9&lon=-1.1&types=food&groupSize=10&radiusKm=5", {}, bindings);
		assert.equal(response.status, 200);
		assert.deepEqual((await response.json()).results, { activities: [], food: [], drinks: [] });
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
			"/api/venues?lat=53.95&lon=-1.08&types=activities,food,drinks&groupSize=20&radiusKm=5",
			{},
			bindings,
		);
		assert.equal(response.status, 200);
		const results = (await response.json()).results;
		assert.deepEqual(results.food.map((venue) => venue.tags.name), [
			"Suitable Restaurant",
			"Exactly Enough Restaurant",
			"Restaurant, Pub and Cafe",
		]);
		assert.deepEqual(results.drinks.map((venue) => venue.tags.name), ["Restaurant, Pub and Cafe"]);
		assert.deepEqual(results.activities.map((venue) => venue.tags.name), ["Escape Game with Cafe"]);
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
		const response = await app.request("/api/venues?lat=53.95&lon=-1.08&types=food&groupSize=10&radiusKm=5", {}, bindings);
		assert.equal(response.status, 200);
		const venues = (await response.json()).results.food;
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
		const response = await app.request("/api/venues?lat=53.9583&lon=-1.0803&types=food&groupSize=10&radiusKm=5", {}, bindings);
		assert.equal(response.status, 200);
		const venue = (await response.json()).results.food[0];
		assert.equal(venue.tags.name, "Nearby Venue");
		assert.ok(venue.distance > 0);
		assert.ok(venue.distance < 5000);
	});
});

test("interpretation endpoint enforces the daily AI cap and falls back without D1", async () => {
	const database = new MemoryD1();
	let calls = 0;
	const AI = { run: async (_model, input) => {
		calls++;
		return { model: "clef-flash", answers: Object.fromEntries(Object.keys(input.questions).map((id) => [id, { type: "noul", noul: id === "type.food" ? 0.9 : 0 }])) };
	} };
	const request = (env) => app.request("/api/interpret", { method: "POST", body: JSON.stringify({ prompt: "An Italian dinner" }) }, env);
	assert.equal((await (await request({ AI })).json()).source, "rules");
	for (let index = 0; index < 100; index++) assert.equal((await (await request({ AI, DB: database })).json()).source, "ai");
	assert.equal((await (await request({ AI, DB: database })).json()).source, "rules");
	assert.equal(calls, 100);
	assert.equal((await app.request("/api/interpret", { method: "POST", body: JSON.stringify({ prompt: "x".repeat(501) }) }, { AI, DB: database })).status, 400);
});

test("venue search validates saved filters and persists them in shared snapshots", async () => {
	const intent = parseSearchIntent("Italian food");
	await withMockedFetch(async (input) => {
		assert.equal(new URL(String(input)).searchParams.get("categories"), "catering.restaurant.italian");
		return Response.json({ features: [] });
	}, async () => {
		const params = new URLSearchParams({ lat: "53.96", lon: "-1.08", types: "food", groupSize: "10", radiusKm: "5", intent: JSON.stringify(intent) });
		assert.equal((await app.request(`/api/venues?${params}`, {}, bindings)).status, 200);
		params.set("intent", JSON.stringify({ ...intent, cuisineCategories: ["not.allowed"] }));
		assert.equal((await app.request(`/api/venues?${params}`, {}, bindings)).status, 400);
	});
	const database = new MemoryD1();
	const create = await app.request("/api/searches", { method: "POST", body: JSON.stringify({ ...testSnapshot, intent }) }, { DB: database });
	const { id } = await create.json();
	const shared = await (await app.request(`/api/searches/${id}`, {}, { DB: database })).json();
	assert.deepEqual(shared.snapshot.intent, intent);
	assert.equal((await app.request("/api/searches", { method: "POST", body: JSON.stringify({ ...testSnapshot, intent: { ...intent, cuisineCategories: ["not.allowed"] } }) }, { DB: database })).status, 400);
});

test("venue search retains mapped price and capacity without inventing either", async () => {
	await withMockedFetch(async () => Response.json({ features: [
		{ properties: { place_id: "priced", name: "Priced", categories: ["catering.restaurant"], lat: 53.96, lon: -1.08, datasource: { raw: { "price:range": "££", capacity: "50" } } } },
		{ properties: { place_id: "unknown", name: "Unknown", categories: ["catering.restaurant"], lat: 53.96, lon: -1.08 } },
	] }), async () => {
		const response = await app.request("/api/venues?lat=53.96&lon=-1.08&types=food&groupSize=10&radiusKm=5", {}, bindings);
		const venues = (await response.json()).results.food;
		assert.equal(venues[0].tags.price, "££");
		assert.equal(venues[0].tags.capacity, "50");
		assert.equal(venues[1].tags.price, undefined);
		assert.equal(venues[1].tags.capacity, undefined);
	});
});

test("map-discovered venues can be saved and voted on without losing existing results", async () => {
	const database = new MemoryD1();
	const create = await app.request("/api/searches", { method: "POST", body: JSON.stringify(multiCategorySnapshot) }, { DB: database });
	const { id } = await create.json();
	const venue = { ...activityVenue, id: "new-map-venue", tags: { name: "Map discovery" } };
	const post = (body) => app.request(`/api/searches/${id}/shortlist`, { method: "POST", body: JSON.stringify(body) }, { DB: database });
	assert.equal((await post({ action: "add", venueId: venue.id, entries: [{ type: "activities", venue }, { type: "food", venue }] })).status, 200);
	assert.equal((await post({ action: "add", venueId: venue.id, entries: [{ type: "activities", venue }] })).status, 200);
	const saved = await (await app.request(`/api/searches/${id}`, {}, { DB: database })).json();
	assert.equal(saved.snapshot.results.activities.filter((item) => item.id === venue.id).length, 1);
	assert.ok(saved.snapshot.results.food.some((item) => item.id === venue.id));
	assert.ok(saved.snapshot.results.food.some((item) => item.id === "restaurant-1"));
	const vote = await app.request(`/api/searches/${id}/votes`, { method: "POST", body: JSON.stringify({ venueId: venue.id, category: "food", voterId: "123e4567-e89b-42d3-a456-426614174000", voted: true }) }, { DB: database });
	assert.equal(vote.status, 200);
	assert.equal((await post({ action: "add", venueId: "bad", entries: [{ type: "food", venue }] })).status, 400);
});

test("venue search reports provider outages and malformed results instead of empty results", async () => {
	await withMockedFetch(async () => new Response("busy", { status: 429 }), async () => {
		const response = await app.request("/api/venues?lat=0&lon=0&types=food&groupSize=10&radiusKm=5", {}, bindings);
		assert.equal(response.status, 502);
		assert.match((await response.json()).error, /temporarily unavailable/i);
	});

	await withMockedFetch(async () => Response.json({ elements: [] }), async () => {
		const response = await app.request("/api/venues?lat=0&lon=0&types=food&groupSize=10&radiusKm=5", {}, bindings);
		assert.equal(response.status, 502);
		assert.match((await response.json()).error, /invalid response/i);
	});
});

test("shared-search creation validates snapshots and requires D1", async () => {
	const noDatabase = await app.request("/api/searches", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(testSnapshot),
	}, {});
	assert.equal(noDatabase.status, 503);

	const database = new MemoryD1();
	for (const snapshot of [
		{ ...testSnapshot, radiusKm: 3 },
		{ ...testSnapshot, groupSize: 0 },
		{ ...testSnapshot, location: { ...testSnapshot.location, lat: 100 } },
		{ ...testSnapshot, location: { ...testSnapshot.location, lat: null } },
		{ ...testSnapshot, types: [] },
		{ ...testSnapshot, prompt: "x".repeat(501) },
		{ ...testSnapshot, prompt: 123 },
		{ ...testSnapshot, results: { ...testSnapshot.results, food: [{ id: "invalid", tags: { name: "" } }] } },
		{ ...testSnapshot, results: { ...testSnapshot.results, food: [{ ...testSnapshot.results.food[0], tags: { name: "Venue", website: {} } }] } },
	]) {
		const response = await app.request("/api/searches", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(snapshot),
		}, { DB: database });
		assert.equal(response.status, 400);
	}
});

test("shared snapshots preserve prompts and continue accepting older prompt-free snapshots", async () => {
	const database = new MemoryD1();
	for (const [snapshot, expectedPrompt] of [
		[{ ...testSnapshot, prompt: "Lebanese food and sports" }, "Lebanese food and sports"],
		[testSnapshot, undefined],
	]) {
		const create = await app.request("/api/searches", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(snapshot),
		}, { DB: database });
		assert.equal(create.status, 201);
		const { id } = await create.json();
		const shared = await app.request(`/api/searches/${id}`, {}, { DB: database });
		const { snapshot: savedSnapshot } = await shared.json();
		assert.equal(savedSnapshot.prompt, expectedPrompt);
		if (expectedPrompt === undefined) assert.equal(Object.hasOwn(savedSnapshot, "prompt"), false);
	}
});

test("shared shortlist allows one replaceable vote per category and browser", async () => {
	const database = new MemoryD1();
	const create = await app.request("/api/searches", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(multiCategorySnapshot),
	}, { DB: database });
	assert.equal(create.status, 201);
	const { id } = await create.json();
	assert.match(id, /^[\da-f-]{36}$/i);

	const voterId = "123e4567-e89b-42d3-a456-426614174000";
	const addShortlisted = async (venueId) => app.request(`/api/searches/${id}/shortlist`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ venueId, action: "add" }),
	}, { DB: database });
	for (const venueId of ["activity-1", "restaurant-1", "restaurant-2", "pub-1"]) {
		assert.equal((await addShortlisted(venueId)).status, 200);
	}
	assert.equal((await app.request(`/api/searches/${id}/shortlist`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ venueId: "not-in-search", action: "add" }),
	}, { DB: database })).status, 404);

	const vote = (venueId, category, voted = true) => app.request(`/api/searches/${id}/votes`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ venueId, category, voterId, voted }),
	}, { DB: database });
	assert.equal((await vote("activity-1", "activities")).status, 200);
	assert.equal((await vote("activity-1", "food")).status, 200);
	const multiCategoryVote = await app.request(`/api/searches/${id}?voterId=${voterId}`, {}, { DB: database });
	const multiCategoryEntry = (await multiCategoryVote.json()).shortlist.find(({ venueId }) => venueId === "activity-1");
	assert.deepEqual(multiCategoryEntry.votes, { activities: 1, food: 1, drinks: 0 });
	assert.deepEqual(multiCategoryEntry.votedByMe.toSorted(), ["activities", "food"]);
	assert.equal((await vote("restaurant-1", "food")).status, 200);
	assert.equal((await vote("restaurant-1", "food")).status, 200);
	assert.equal((await vote("pub-1", "drinks")).status, 200);
	assert.equal((await vote("restaurant-2", "food")).status, 200);
	assert.equal((await vote("restaurant-1", "drinks")).status, 400);
	assert.equal((await vote("not-in-search", "food")).status, 404);

	const shared = await app.request(`/api/searches/${id}?voterId=${voterId}`, {}, { DB: database });
	assert.equal(shared.status, 200);
	const sharedData = await shared.json();
	assert.equal(sharedData.snapshot.location.label, "York, UK");
	assert.deepEqual(sharedData.shortlist.map(({ venueId, votes, votedByMe }) => ({ venueId, votes, votedByMe }))
		.sort((first, second) => first.venueId.localeCompare(second.venueId)), [
		{ venueId: "activity-1", votes: { activities: 1, food: 0, drinks: 0 }, votedByMe: ["activities"] },
		{ venueId: "pub-1", votes: { activities: 0, food: 0, drinks: 1 }, votedByMe: ["drinks"] },
		{ venueId: "restaurant-1", votes: { activities: 0, food: 0, drinks: 0 }, votedByMe: [] },
		{ venueId: "restaurant-2", votes: { activities: 0, food: 1, drinks: 0 }, votedByMe: ["food"] },
	]);

	const secondVoter = await app.request(`/api/searches/${id}?voterId=123e4567-e89b-42d3-a456-426614174001`, {}, { DB: database });
	const secondVoterData = await secondVoter.json();
	assert.equal(secondVoterData.shortlist.find(({ venueId }) => venueId === "restaurant-2").votes.food, 1);
	assert.deepEqual(secondVoterData.shortlist.find(({ venueId }) => venueId === "restaurant-2").votedByMe, []);

	assert.equal((await vote("restaurant-2", "food", false)).status, 200);
	assert.equal((await vote("activity-1", "activities", false)).status, 200);

	const removeFromShortlist = await app.request(`/api/searches/${id}/shortlist`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ venueId: "pub-1", action: "remove" }),
	}, { DB: database });
	assert.equal(removeFromShortlist.status, 200);
	const emptyShortlist = await app.request(`/api/searches/${id}?voterId=${voterId}`, {}, { DB: database });
	const remaining = (await emptyShortlist.json()).shortlist;
	assert.equal(remaining.find(({ venueId }) => venueId === "pub-1"), undefined);
	assert.equal(remaining.find(({ venueId }) => venueId === "restaurant-2").votes.food, 0);
	assert.equal(remaining.find(({ venueId }) => venueId === "activity-1").votes.activities, 0);
});

test("shared-search routes report missing records and validate ids and votes", async () => {
	const database = new MemoryD1();
	assert.equal((await app.request("/api/searches/not-a-uuid", {}, { DB: database })).status, 400);
	assert.equal((await app.request("/api/searches/123e4567-e89b-42d3-a456-426614174000", {}, { DB: database })).status, 404);

	const invalidVote = await app.request("/api/searches/123e4567-e89b-42d3-a456-426614174000/votes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ venueId: "restaurant-1", voterId: "not-a-uuid", voted: true }),
	}, { DB: database });
	assert.equal(invalidVote.status, 400);
});