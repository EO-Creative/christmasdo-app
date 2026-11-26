import {
	allowedActivityCategories,
	allowedCuisineCategories,
	allowedVenueTypes,
	excludedActivityCategories,
	isSearchIntentFilters,
	parseSearchIntent,
	searchIntentFromFilters,
	type SearchIntent,
	type VenueType,
} from "../shared/search-intent.ts";

const model = "@cf/cloudflare/clef-flash";
// Thresholds were chosen from live scores for varied sample descriptions; scores vary slightly between runs.
const typeThreshold = 0.7;
const ruleFloor = 0.2;
const sportsThreshold = 0.5;
const activityThreshold = 0.8;
const cuisineThreshold = 0.8;
const socialGamesThreshold = 0.75;
const optionalThreshold = 0.75;
const activityNames: Record<string, string> = {
	"sport.sports_centre": "a sports centre or leisure centre",
	"sport.sports_hall": "an indoor sports hall, for example for five-a-side football or badminton",
	"sport.ice_rink": "ice skating",
	"entertainment.bowling_alley": "ten-pin bowling",
	"entertainment.escape_game": "an escape room",
	"entertainment.miniature_golf": "mini golf or crazy golf",
	"entertainment.amusement_arcade": "an amusement arcade or video games arcade",
	"entertainment.cinema": "going to the cinema or watching a film",
	"entertainment.culture.theatre": "the theatre, a pantomime or a live show",
	"sport.fitness.gym": "a gym or fitness class",
	"sport.swimming_pool": "swimming",
	"sport.golf_course": "a round of golf on a golf course",
};
const cuisineNames: Record<string, string> = {
	"catering.restaurant.lebanese": "Lebanese food, such as mezze or shawarma",
	"catering.restaurant.italian": "Italian food, such as pizza or pasta",
	"catering.restaurant.indian": "Indian food, such as a curry",
	"catering.restaurant.chinese": "Chinese food, such as dim sum",
	"catering.restaurant.mexican": "Mexican food, such as tacos or burritos",
	"catering.restaurant.thai": "Thai food, such as pad thai",
	"catering.restaurant.japanese": "Japanese food, such as sushi or ramen",
	"catering.restaurant.french": "French food, such as a bistro or brasserie",
	"catering.restaurant.greek": "Greek food, such as souvlaki or gyros",
	"catering.restaurant.turkish": "Turkish food, such as kebabs",
	"catering.restaurant.korean": "Korean food, such as Korean barbecue",
	"catering.restaurant.spanish": "Spanish food, such as tapas or paella",
};
const socialAlternatives = ["entertainment.bowling_alley", "entertainment.miniature_golf", "entertainment.amusement_arcade"];
const sportAlternatives = ["sport.sports_centre", "sport.sports_hall", "sport.ice_rink", "entertainment.bowling_alley"];
const question = (instructions: string) => ({ type: "noul" as const, instructions });
const questions = {
	"type.activities": question("Does the group want to do an activity or entertainment together, such as a game, sport, show or experience?"),
	"type.food": question("Does the group want to eat together, for example a meal, a restaurant or any kind of food?"),
	"type.drinks": question("Does the group want to go for drinks together, for example at a pub, a bar or a club?"),
	"optional.drinks": question("Are drinks or clubbing mentioned only as something people may arrange for themselves afterwards, not as part of the organised plan?"),
	socialGames: question("Does the description mention darts, shuffleboard, pool, snooker, table tennis, axe throwing, or a social games bar such as Flight Club, Puttshack or Topgolf?"),
	sports: question("Does the group want to play sport in general, without naming one particular sport?"),
	...Object.fromEntries(allowedActivityCategories.map((category) => [
		`activity.${category}`,
		question(`Is ${activityNames[category]} wanted as part of the plan?`),
	])),
	...Object.fromEntries(allowedCuisineCategories.map((category) => [
		`cuisine.${category}`,
		question(`Is ${cuisineNames[category]}, wanted as part of the plan?`),
	])),
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface InferenceAi {
	run(modelName: typeof model, input: {
		model: "clef-flash";
		state: { description: string };
		questions: typeof questions;
	}): Promise<unknown>;
}

export async function inferSearchIntent(prompt: string, ai?: InferenceAi | null): Promise<{ intent: SearchIntent; source: "ai" | "rules" }> {
	const rules = parseSearchIntent(prompt);
	if (!ai || Object.keys(questions).length > 64 || allowedActivityCategories.some((category) => !activityNames[category]) ||
		allowedCuisineCategories.some((category) => !cuisineNames[category])) return { intent: rules, source: "rules" };
	try {
		const result = await ai.run(model, {
			model: "clef-flash",
			state: { description: prompt },
			questions,
		});
		if (!isRecord(result) || !isRecord(result.answers)) return { intent: rules, source: "rules" };
		const answers = result.answers;
		const probabilities: Record<string, number> = {};
		for (const id of Object.keys(questions)) {
			const answer = answers[id];
			if (!isRecord(answer) || answer.type !== "noul" || typeof answer.noul !== "number" ||
				!Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) return { intent: rules, source: "rules" };
			probabilities[id] = answer.noul;
		}
		const excluded = excludedActivityCategories(prompt);
		const inferredActivities = allowedActivityCategories.filter((category) =>
			probabilities[`activity.${category}`] >= activityThreshold && !excluded.includes(category));
		// A named, directly searchable activity takes precedence over the broader social-games approximation.
		const socialGames = rules.socialGames || (probabilities.socialGames >= socialGamesThreshold && inferredActivities.length === 0);
		const sports = probabilities.sports >= sportsThreshold && !inferredActivities.some((category) => sportAlternatives.includes(category));
		const activityCategories = allowedActivityCategories.filter((category) =>
			rules.activityCategories.includes(category) || inferredActivities.includes(category) || (!excluded.includes(category) &&
				((socialGames && socialAlternatives.includes(category)) || (sports && sportAlternatives.includes(category)))));
		const cuisineCategories = allowedCuisineCategories.filter((category) =>
			rules.cuisineCategories.includes(category) || probabilities[`cuisine.${category}`] >= cuisineThreshold);
		// Keep a phrase-rule match unless the model clearly disagrees, e.g. "nobody drinks".
		const wanted = (type: string) => probabilities[`type.${type}`] >= typeThreshold ||
			(rules.types.includes(type as VenueType) && probabilities[`type.${type}`] >= ruleFloor);
		const optionalDrinks = probabilities["optional.drinks"] >= optionalThreshold && probabilities["type.drinks"] < optionalThreshold;
		const types = allowedVenueTypes.filter((type) => (wanted(type) && !(type === "drinks" && optionalDrinks)) ||
			(type === "activities" && (activityCategories.length > 0 || socialGames)) ||
			(type === "food" && cuisineCategories.length > 0));
		const filters = { types, activityCategories, cuisineCategories, socialGames };
		if (!isSearchIntentFilters(filters)) return { intent: rules, source: "rules" };
		return { intent: searchIntentFromFilters(filters, rules, optionalDrinks), source: "ai" };
	} catch {
		return { intent: rules, source: "rules" };
	}
}