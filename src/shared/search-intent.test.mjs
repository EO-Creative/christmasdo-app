import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSearchIntent } from "./search-intent.ts";

test("parses the conversational example into supported category searches and caveats", () => {
	const intent = parseSearchIntent("Indoor sports activities with options for beer and wine at a midrange buget and some Lebanese food");

	assert.deepEqual(intent.types, ["activities", "food", "drinks"]);
	assert.deepEqual(intent.activityCategories, [
		"sport.sports_centre",
		"sport.sports_hall",
		"sport.ice_rink",
		"entertainment.bowling_alley",
	]);
	assert.deepEqual(intent.cuisineCategories, ["catering.restaurant.lebanese"]);
	assert.deepEqual(intent.details, ["sports centres", "sports halls", "ice rinks", "bowling alleys", "Lebanese restaurants"]);
	assert.equal(intent.limitations.length, 3);
	assert.match(intent.limitations[0], /not guaranteed to be indoors/i);
	assert.match(intent.limitations[1], /menus are not verified/i);
	assert.match(intent.limitations[2], /prices and budget fit are not available/i);
});

test("recognizes specific activity types and cuisines", () => {
	const intent = parseSearchIntent("Bowling, an escape room, and some Thai food");

	assert.deepEqual(intent.types, ["activities", "food"]);
	assert.deepEqual(intent.activityCategories, ["entertainment.bowling_alley", "entertainment.escape_game"]);
	assert.deepEqual(intent.cuisineCategories, ["catering.restaurant.thai"]);
});

test("recognizes Flight Club as social darts without treating optional clubbing as a drinks request", () => {
	const intent = parseSearchIntent("We liked flight club last time, so something simliar to that. The team has suggested Italian as an easy option, and then they can make their own arrangements if they want to go clubbing afterwards");

	assert.deepEqual(intent.types, ["activities", "food"]);
	assert.deepEqual(intent.activityCategories, [
		"entertainment.bowling_alley",
		"entertainment.miniature_golf",
		"entertainment.amusement_arcade",
	]);
	assert.deepEqual(intent.cuisineCategories, ["catering.restaurant.italian"]);
	assert.equal(intent.socialGames, true);
	assert.match(intent.details.join(" "), /social darts/i);
	assert.ok(intent.limitations.some((limitation) => /exact games and availability/i.test(limitation)));
	assert.ok(intent.limitations.some((limitation) => /clubbing.*optional later plan.*not suggested/i.test(limitation)));
});

test("recognizes comparable social-game references and direct darts requests", () => {
	for (const prompt of ["Something like Puttshack", "A darts bar", "A pool table and Italian food"]) {
		const intent = parseSearchIntent(prompt);
		assert.ok(intent.types.includes("activities"), prompt);
		assert.equal(intent.socialGames, true, prompt);
		assert.ok(intent.activityCategories.length > 0, prompt);
	}
});

test("does not infer excluded categories or cuisines", () => {
	const intent = parseSearchIntent("No sports or Lebanese food, but drinks are welcome");

	assert.deepEqual(intent.types, ["drinks"]);
	assert.deepEqual(intent.activityCategories, []);
	assert.deepEqual(intent.cuisineCategories, []);
});

test("respects explicit exclusions of social games and comparable activities", () => {
	const excluded = parseSearchIntent("No Flight Club or darts, but Italian food");
	assert.deepEqual(excluded.types, ["food"]);
	assert.equal(excluded.socialGames, false);
	const alternatives = parseSearchIntent("No bowling, but something like Flight Club");
	assert.equal(alternatives.socialGames, true);
	assert.ok(!alternatives.activityCategories.includes("entertainment.bowling_alley"));
	assert.ok(alternatives.activityCategories.includes("entertainment.miniature_golf"));
});

test("includes clubbing when it is a requested part of the night", () => {
	const intent = parseSearchIntent("We want dinner and clubbing");
	assert.deepEqual(intent.types, ["food", "drinks"]);
	assert.ok(!intent.limitations.some((limitation) => /optional later plan/i.test(limitation)));
});

test("empty or unrecognized requests do not invent venue types", () => {
	assert.deepEqual(parseSearchIntent(""), {
		types: [],
		activityCategories: [],
		cuisineCategories: [],
		socialGames: false,
		details: [],
		limitations: [],
	});
	assert.deepEqual(parseSearchIntent("somewhere lovely for the team"), {
		types: [],
		activityCategories: [],
		cuisineCategories: [],
		socialGames: false,
		details: [],
		limitations: [],
	});
});

test("reports unsupported preferences even when no search category is recognized", () => {
	const intent = parseSearchIntent("A mid-range place indoors");
	assert.deepEqual(intent.types, []);
	assert.equal(intent.limitations.length, 2);
});