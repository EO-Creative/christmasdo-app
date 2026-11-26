export type VenueType = "activities" | "food" | "drinks";

export interface SearchIntent {
	types: VenueType[];
	activityCategories: string[];
	cuisineCategories: string[];
	details: string[];
	limitations: string[];
}

const venueTypes: VenueType[] = ["activities", "food", "drinks"];

const cuisineCategories: Array<{ category: string; label: string; terms: RegExp }> = [
	{ category: "catering.restaurant.lebanese", label: "Lebanese restaurants", terms: /\blebanese\b/i },
	{ category: "catering.restaurant.italian", label: "Italian restaurants", terms: /\bitalian\b/i },
	{ category: "catering.restaurant.indian", label: "Indian restaurants", terms: /\bindian\b/i },
	{ category: "catering.restaurant.chinese", label: "Chinese restaurants", terms: /\bchinese\b/i },
	{ category: "catering.restaurant.mexican", label: "Mexican restaurants", terms: /\bmexican\b/i },
	{ category: "catering.restaurant.thai", label: "Thai restaurants", terms: /\bthai\b/i },
	{ category: "catering.restaurant.japanese", label: "Japanese restaurants", terms: /\bjapanese\b/i },
	{ category: "catering.restaurant.french", label: "French restaurants", terms: /\bfrench\b/i },
	{ category: "catering.restaurant.greek", label: "Greek restaurants", terms: /\bgreek\b/i },
	{ category: "catering.restaurant.turkish", label: "Turkish restaurants", terms: /\bturkish\b/i },
	{ category: "catering.restaurant.korean", label: "Korean restaurants", terms: /\bkorean\b/i },
	{ category: "catering.restaurant.spanish", label: "Spanish restaurants", terms: /\bspanish\b/i },
];

const activityCategories: Array<{ category: string; label: string; terms: RegExp }> = [
	{ category: "sport.sports_centre", label: "sports centres", terms: /\b(?:sports?\s+cent(?:er|re)s?|sports?\s+clubs?)\b/i },
	{ category: "sport.sports_hall", label: "sports halls", terms: /\bsports?\s+halls?\b/i },
	{ category: "sport.ice_rink", label: "ice rinks", terms: /\b(?:ice\s+rink|ice\s+skating)\b/i },
	{ category: "entertainment.bowling_alley", label: "bowling alleys", terms: /\bbowling\b/i },
	{ category: "entertainment.escape_game", label: "escape rooms", terms: /\b(?:escape\s+rooms?|escape\s+games?)\b/i },
	{ category: "entertainment.miniature_golf", label: "mini-golf", terms: /\b(?:mini\s+golf|crazy\s+golf)\b/i },
	{ category: "entertainment.amusement_arcade", label: "arcades", terms: /\b(?:arcades?|amusement\s+arcades?)\b/i },
	{ category: "entertainment.cinema", label: "cinemas", terms: /\b(?:cinema|movie\s+theat(?:er|re)s?)\b/i },
	{ category: "entertainment.culture.theatre", label: "theatres", terms: /\b(?:theat(?:er|re)s?|live\s+shows?)\b/i },
	{ category: "sport.fitness.gym", label: "gyms", terms: /\bgyms?\b/i },
	{ category: "sport.swimming_pool", label: "swimming pools", terms: /\b(?:swimming|swimming\s+pools?)\b/i },
	{ category: "sport.golf_course", label: "golf courses", terms: /\bgolf\b/i },
];

const sportSearchCategories = activityCategories
	.filter(({ category }) => ["sport.sports_centre", "sport.sports_hall", "sport.ice_rink", "entertainment.bowling_alley"].includes(category))
	.map(({ category, label }) => ({ category, label }));

function requestedMatch(text: string, terms: RegExp): boolean {
	for (const match of text.matchAll(new RegExp(terms.source, "gi"))) {
		const clauseStart = Math.max(
			text.lastIndexOf(",", match.index),
			text.lastIndexOf(";", match.index),
			text.lastIndexOf(".", match.index),
			text.lastIndexOf("!", match.index),
			text.lastIndexOf("?", match.index),
		) + 1;
		const prefix = text.slice(clauseStart, match.index);
		if (!/\b(?:no|not|without|avoid|avoiding|skip|exclude|excluding|don't want|do not want)\b/i.test(prefix)) {
			return true;
		}
	}
	return false;
}

export function parseSearchIntent(prompt: string): SearchIntent {
	const text = prompt.trim();
	const cuisineMatches = cuisineCategories.filter(({ terms }) => requestedMatch(text, terms));
	const activityMatches = activityCategories
		.filter(({ terms }) => requestedMatch(text, terms))
		.map(({ category, label }) => ({ category, label }));
	const requestsSports = requestedMatch(text, /\bsports?\b/i);
	const requestsActivities = requestedMatch(text, /\b(?:activities|activity|things?\s+to\s+do|entertainment)\b/i);
	const requestsFood = requestedMatch(text, /\b(?:food|dinner|lunch|restaurants?|cuisine|eat)\b/i) || cuisineMatches.length > 0;
	const requestsDrinks = requestedMatch(text, /\b(?:drinks?|bars?|pubs?|beer|wine|alcohol|cocktails?)\b/i);
	const types = new Set<VenueType>();
	if (requestsSports || requestsActivities || activityMatches.length > 0) types.add("activities");
	if (requestsFood) types.add("food");
	if (requestsDrinks) types.add("drinks");

	if (requestsSports && !activityMatches.some(({ category }) => sportSearchCategories.some((sport) => sport.category === category))) {
		activityMatches.push(...sportSearchCategories);
	}

	const indoorMentioned = requestedMatch(text, /\bindoors?\b/i);
	const alcoholMentioned = requestedMatch(text, /\b(?:beer|wine|alcohol|cocktails?)\b/i);
	const budgetMentioned = requestedMatch(text, /\b(?:budget|mid[ -]?range|moderate|cheap|affordable|expensive|price[ -]?range)\b/i);
	const limitations: string[] = [];
	if (indoorMentioned) limitations.push("Indoor status is not consistently recorded, so an activity is not guaranteed to be indoors.");
	if (alcoholMentioned) limitations.push("Beer and wine menus are not verified; Drinks results are pubs and bars, not confirmed drink options.");
	if (budgetMentioned) limitations.push("Venue prices and budget fit are not available in the place data.");

	const details = [
		...activityMatches.map(({ label }) => label),
		...cuisineMatches.map(({ label }) => label),
	].filter((label, index, values) => values.indexOf(label) === index);

	return {
		types: venueTypes.filter((type) => types.has(type)),
		activityCategories: [...new Set(activityMatches.map(({ category }) => category))],
		cuisineCategories: cuisineMatches.map(({ category }) => category),
		details,
		limitations,
	};
}