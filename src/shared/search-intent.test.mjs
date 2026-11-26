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

test("does not infer excluded categories or cuisines", () => {
	const intent = parseSearchIntent("No sports or Lebanese food, but drinks are welcome");

	assert.deepEqual(intent.types, ["drinks"]);
	assert.deepEqual(intent.activityCategories, []);
	assert.deepEqual(intent.cuisineCategories, []);
});

test("empty or unrecognized requests do not invent venue types", () => {
	assert.deepEqual(parseSearchIntent(""), {
		types: [],
		activityCategories: [],
		cuisineCategories: [],
		details: [],
		limitations: [],
	});
	assert.deepEqual(parseSearchIntent("somewhere lovely for the team"), {
		types: [],
		activityCategories: [],
		cuisineCategories: [],
		details: [],
		limitations: [],
	});
});

test("reports unsupported preferences even when no search category is recognized", () => {
	const intent = parseSearchIntent("A mid-range place indoors");
	assert.deepEqual(intent.types, []);
	assert.equal(intent.limitations.length, 2);
});