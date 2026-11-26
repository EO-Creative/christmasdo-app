import assert from "node:assert/strict";
import { test } from "node:test";
import { excludedActivityCategories, isSearchIntent, isSearchIntentFilters, parseSearchIntent } from "./search-intent.ts";

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

test("mini-golf wording is not mistaken for a golf course", () => {
	for (const prompt of ["Crazy golf then cocktails", "mini-golf", "Miniature golf with the team"]) {
		assert.deepEqual(parseSearchIntent(prompt).activityCategories, ["entertainment.miniature_golf"], prompt);
	}
	assert.deepEqual(parseSearchIntent("A round of golf, then crazy golf").activityCategories, ["entertainment.miniature_golf", "sport.golf_course"]);
});

test("reports only activities that are named and excluded", () => {
	assert.deepEqual(excludedActivityCategories("Sporty afternoon but definitely not bowling, then kebabs"), ["entertainment.bowling_alley"]);
	assert.deepEqual(excludedActivityCategories("No cinema. Bowling instead"), ["entertainment.cinema"]);
	assert.deepEqual(excludedActivityCategories("Not bowling at lunch, but bowling in the evening"), []);
	assert.deepEqual(excludedActivityCategories("A quiet meal"), []);
});

test("validates rule-generated intents and their filters", () => {
	for (const prompt of ["", "Indoor bowling and Italian food with wine", "Something like Flight Club, or go clubbing if they want"]) {
		const intent = parseSearchIntent(prompt);
		assert.equal(isSearchIntent(intent), true, prompt);
		const { types, activityCategories, cuisineCategories, socialGames } = intent;
		assert.equal(isSearchIntentFilters({ types, activityCategories, cuisineCategories, socialGames }), true, prompt);
	}
});

test("rejects unsafe or inconsistent client filters and snapshot details", () => {
	const filters = { types: ["activities", "food"], activityCategories: ["entertainment.bowling_alley"], cuisineCategories: ["catering.restaurant.thai"], socialGames: false };
	for (const candidate of [
		null, [], {}, { ...filters, extra: true },
		{ ...filters, types: ["activities", "activities"] },
		{ ...filters, types: Array(1) },
		{ ...filters, types: ["activities", "hotels"] },
		{ ...filters, activityCategories: ["catering.restaurant.thai"] },
		{ ...filters, cuisineCategories: ["catering.restaurant"] },
		{ ...filters, types: ["food"] },
		{ ...filters, types: ["activities"] },
		{ ...filters, types: ["food"], activityCategories: [], socialGames: true },
		{ ...filters, socialGames: "true" },
	]) assert.equal(isSearchIntentFilters(candidate), false, JSON.stringify(candidate));

	const intent = parseSearchIntent("Bowling and Thai food");
	for (const candidate of [
		{ ...intent, extra: "ignored?" },
		{ ...intent, details: ["<script>unsafe</script>"] },
		{ ...intent, details: ["Italian restaurants"] },
		{ ...intent, limitations: ["untrusted text"] },
		{ ...intent, details: ["bowling alleys", "bowling alleys"] },
	]) assert.equal(isSearchIntent(candidate), false, JSON.stringify(candidate));
});