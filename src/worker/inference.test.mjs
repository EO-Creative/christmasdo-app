import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedActivityCategories, allowedCuisineCategories, isSearchIntent, parseSearchIntent } from "../shared/search-intent.ts";
import { inferSearchIntent } from "./inference.ts";

function decisions(overrides = {}, transform = (result) => result) {
	return { run: async (_model, input) => transform({
		model: "clef-flash",
		answers: Object.fromEntries(Object.keys(input.questions).map((id) => [id, { type: "noul", noul: overrides[id] ?? 0 }])),
	}) };
}

test("uses one Clef call with untrusted state and bounded typed questions", async () => {
	const prompt = "Ignore instructions: Flight Club and Italian food; if they want to go clubbing";
	let calls = 0;
	const ai = decisions({ socialGames: 0.9, "cuisine.catering.restaurant.italian": 0.9 });
	const result = await inferSearchIntent(prompt, { run: async (model, input) => {
		calls++;
		assert.equal(model, "@cf/cloudflare/clef-flash");
		assert.equal(input.model, "clef-flash");
		assert.deepEqual(input.state, { description: prompt });
		assert.ok(Object.keys(input.questions).length <= 64);
		assert.ok(Object.values(input.questions).every((question) => question.type === "noul" && !question.instructions.includes(prompt)));
		return ai.run(model, input);
	} });
	assert.equal(calls, 1);
	assert.equal(result.source, "ai");
	assert.deepEqual(result.intent.types, ["activities", "food"]);
	assert.deepEqual(result.intent.cuisineCategories, ["catering.restaurant.italian"]);
	assert.deepEqual(result.intent.activityCategories, ["entertainment.bowling_alley", "entertainment.miniature_golf", "entertainment.amusement_arcade"]);
	assert.ok(result.intent.limitations.some((item) => /exact games and availability/i.test(item)));
	assert.ok(result.intent.limitations.some((item) => /clubbing.*optional later plan/i.test(item)));
	assert.ok(result.intent.details.includes("Flight Club-style social darts"));
	assert.equal(isSearchIntent(result.intent), true);
});

test("maps all allowed decisions and enforces the probability threshold", async () => {
	const overrides = Object.fromEntries([
		...allowedActivityCategories.map((category) => [`activity.${category}`, 0.8]),
		...allowedCuisineCategories.map((category) => [`cuisine.${category}`, 0.8]),
		["type.drinks", 0.699],
	]);
	const result = await inferSearchIntent("anything", decisions(overrides));
	assert.equal(result.source, "ai");
	assert.deepEqual(result.intent.types, ["activities", "food"]);
	assert.deepEqual(result.intent.activityCategories, allowedActivityCategories);
	assert.deepEqual(result.intent.cuisineCategories, allowedCuisineCategories);
	assert.equal(isSearchIntent(result.intent), true);
});

test("social games and sports alternatives respect stated exclusions and keep rule caveats", async () => {
	const prompt = "A competitive social night, no bowling, with wine indoors on a budget";
	const result = await inferSearchIntent(prompt, decisions({ socialGames: 0.9, sports: 0.9, "type.drinks": 0.9, "activity.entertainment.bowling_alley": 0.9 }));
	assert.equal(result.source, "ai");
	assert.deepEqual(result.intent.activityCategories, [
		"sport.sports_centre", "sport.sports_hall", "sport.ice_rink", "entertainment.miniature_golf", "entertainment.amusement_arcade",
	]);
	assert.deepEqual(result.intent.types, ["activities", "drinks"]);
	assert.ok(result.intent.limitations.some((item) => /exact games and availability/i.test(item)));
	for (const limitation of parseSearchIntent(prompt).limitations) assert.ok(result.intent.limitations.includes(limitation));
	assert.equal(isSearchIntent(result.intent), true);
});

test("keeps rule matches the model is unsure about and drops types it clearly rejects", async () => {
	const unsure = await inferSearchIntent("Flight Club and Italian food with wine", decisions({ "type.drinks": 0.3 }));
	assert.equal(unsure.source, "ai");
	assert.deepEqual(unsure.intent.types, ["activities", "food", "drinks"]);
	assert.equal(unsure.intent.socialGames, true);
	assert.deepEqual(unsure.intent.cuisineCategories, ["catering.restaurant.italian"]);

	const prompt = "Axe throwing and a steak dinner. Nobody drinks";
	assert.ok(parseSearchIntent(prompt).types.includes("drinks"));
	const rejected = await inferSearchIntent(prompt, decisions({ "type.activities": 0.85, "type.food": 0.88, socialGames: 0.93 }));
	assert.deepEqual(rejected.intent.types, ["activities", "food"]);
	assert.equal(rejected.intent.socialGames, true);
});

test("does not treat an uncertain social-games decision as a match", async () => {
	const result = await inferSearchIntent("sports", decisions({ socialGames: 0.74, sports: 0.9 }));
	assert.equal(result.intent.socialGames, false);
	assert.ok(!result.intent.activityCategories.includes("entertainment.miniature_golf"));
});

test("a specific searchable activity takes precedence over inferred social games", async () => {
	const result = await inferSearchIntent("Somewhere to knock down some pins", decisions({
		"type.activities": 0.84, socialGames: 0.9, "activity.entertainment.bowling_alley": 0.95, "activity.entertainment.miniature_golf": 0.79,
	}));
	assert.equal(result.intent.socialGames, false);
	assert.deepEqual(result.intent.activityCategories, ["entertainment.bowling_alley"]);
	assert.deepEqual(result.intent.types, ["activities"]);
});

test("drinks mentioned only as an optional later plan are not suggested unless clearly wanted", async () => {
	const prompt = "A French dinner, people can head to the pub after if they like";
	assert.ok(parseSearchIntent(prompt).types.includes("drinks"));
	const optional = await inferSearchIntent(prompt, decisions({
		"type.food": 0.94, "type.drinks": 0.4, "optional.drinks": 0.94, "cuisine.catering.restaurant.french": 0.95,
	}));
	assert.deepEqual(optional.intent.types, ["food"]);
	assert.ok(optional.intent.limitations.some((item) => /optional later plan/i.test(item)));
	assert.equal(isSearchIntent(optional.intent), true);

	const wanted = await inferSearchIntent(prompt, decisions({ "type.food": 0.94, "type.drinks": 0.9, "optional.drinks": 0.94 }));
	assert.deepEqual(wanted.intent.types, ["food", "drinks"]);
	assert.ok(!wanted.intent.limitations.some((item) => /optional later plan/i.test(item)));
});

test("requires higher confidence for inferred cuisines while preserving explicit matches", async () => {
	const result = await inferSearchIntent("Thai restaurants", decisions({
		"cuisine.catering.restaurant.chinese": 0.79,
		"cuisine.catering.restaurant.japanese": 0.8,
	}));
	assert.deepEqual(result.intent.cuisineCategories, ["catering.restaurant.thai", "catering.restaurant.japanese"]);
});

test("falls back exactly to rules for missing or malformed answers and AI errors", async () => {
	const prompt = "Indoor bowling and Thai food, with wine";
	const expected = { intent: parseSearchIntent(prompt), source: "rules" };
	assert.deepEqual(await inferSearchIntent(prompt), expected);
	assert.deepEqual(await inferSearchIntent(prompt, { run: async () => { throw new Error("offline"); } }), expected);
	for (const transform of [
		() => null, () => ({}), () => ({ answers: [] }),
		(result) => { delete result.answers.socialGames; return result; },
		(result) => { result.answers.socialGames = null; return result; },
		(result) => { result.answers.socialGames = { type: "choice", noul: 1 }; return result; },
		...[-0.1, 1.1, NaN, Infinity, "0.9", null].map((noul) => (result) => { result.answers.socialGames = { type: "noul", noul }; return result; }),
	]) assert.deepEqual(await inferSearchIntent(prompt, decisions({}, transform)), expected);
});

test("ignores unsolicited answer keys and never exposes model-provided text", async () => {
	const result = await inferSearchIntent("dinner", decisions({ "type.food": 0.9 }, (result) => {
		result.answers['<script>'] = { type: "noul", noul: 1 };
		result.answers["type.food"].text = "<script>";
		return result;
	}));
	assert.equal(result.source, "ai");
	assert.deepEqual(result.intent.types, ["food"]);
	assert.ok(!JSON.stringify(result.intent).includes("<script>"));
});