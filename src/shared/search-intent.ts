export type VenueType = "activities" | "food" | "drinks";

export interface SearchIntentFilters {
	types: VenueType[];
	activityCategories: string[];
	cuisineCategories: string[];
	socialGames: boolean;
}

export interface SearchIntent extends SearchIntentFilters {
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
	{ category: "entertainment.miniature_golf", label: "mini-golf", terms: /\b(?:mini(?:ature)?[\s-]?golf|crazy[\s-]?golf)\b/i },
	{ category: "entertainment.amusement_arcade", label: "arcades", terms: /\b(?:arcades?|amusement\s+arcades?)\b/i },
	{ category: "entertainment.cinema", label: "cinemas", terms: /\b(?:cinema|movie\s+theat(?:er|re)s?)\b/i },
	{ category: "entertainment.culture.theatre", label: "theatres", terms: /\b(?:theat(?:er|re)s?|live\s+shows?)\b/i },
	{ category: "sport.fitness.gym", label: "gyms", terms: /\bgyms?\b/i },
	{ category: "sport.swimming_pool", label: "swimming pools", terms: /\b(?:swimming|swimming\s+pools?)\b/i },
	{ category: "sport.golf_course", label: "golf courses", terms: /\bgolf\b/i },
];

const socialGameAlternatives = [
	{ category: "entertainment.bowling_alley", label: "bowling alleys" },
	{ category: "entertainment.miniature_golf", label: "mini-golf" },
	{ category: "entertainment.amusement_arcade", label: "arcades" },
];

const socialGameReferences: Array<{ terms: RegExp; detail: string }> = [
	{ terms: /\bflight\s*club\b/i, detail: "Flight Club-style social darts" },
	{ terms: /\bputtshack\b/i, detail: "Puttshack-style social games" },
	{ terms: /\btopgolf\b/i, detail: "Topgolf-style social games" },
];

const directSocialGames = /\b(?:darts?|dartboards?|billiards?|snooker|pool\s+tables?|table\s+tennis|ping[ -]pong|shuffleboard)\b/i;
const clubbingTerms = /\b(?:clubbing|night\s*clubs?)\b/i;
const optionalPlanTerms = /\b(?:if\s+(?:they|we|you|anyone)\s+(?:want|would\s+like|choose|decide)|(?:can|will)\s+make\s+their\s+own\s+arrangements|optional(?:ly)?)\b/i;

export const allowedVenueTypes: readonly VenueType[] = Object.freeze([...venueTypes]);
export const allowedActivityCategories: readonly string[] = Object.freeze(activityCategories.map(({ category }) => category));
export const allowedCuisineCategories: readonly string[] = Object.freeze(cuisineCategories.map(({ category }) => category));

const socialGamesLimitation = "When Activities is selected, social-game alternatives and bars with explicit games data are included. Check the exact games and availability with venues.";
const optionalClubbingLimitation = "Clubbing was mentioned as an optional later plan, so Drinks was not suggested for it; select Drinks to include it.";
const indoorLimitation = "Indoor status is not consistently recorded, so an activity is not guaranteed to be indoors.";
const alcoholLimitation = "Beer and wine menus are not verified; Drinks results are pubs and bars, not confirmed drink options.";
const budgetLimitation = "Venue prices and budget fit are not available in the place data.";
const optionalDrinksLimitation = "Drinks were mentioned as an optional later plan, so Drinks was not suggested; select Drinks to include them.";
const allowedLimitations = [socialGamesLimitation, optionalClubbingLimitation, indoorLimitation, alcoholLimitation, budgetLimitation, optionalDrinksLimitation];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function allowedArray(value: unknown, allowed: readonly string[]): value is string[] {
	return Array.isArray(value) && value.length <= allowed.length &&
		Array.from(value).every((item) => typeof item === "string" && allowed.includes(item)) && new Set(value).size === value.length;
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validFilters(value: Record<string, unknown>): boolean {
	if (!allowedArray(value.types, allowedVenueTypes) ||
		!allowedArray(value.activityCategories, allowedActivityCategories) ||
		!allowedArray(value.cuisineCategories, allowedCuisineCategories) || typeof value.socialGames !== "boolean") return false;
	return (!(value.activityCategories.length || value.socialGames) || value.types.includes("activities")) &&
		(!value.cuisineCategories.length || value.types.includes("food"));
}

export function isSearchIntentFilters(value: unknown): value is SearchIntentFilters {
	return isRecord(value) && hasKeys(value, ["types", "activityCategories", "cuisineCategories", "socialGames"]) && validFilters(value);
}

export function isSearchIntent(value: unknown): value is SearchIntent {
	if (!isRecord(value) || !hasKeys(value, ["types", "activityCategories", "cuisineCategories", "socialGames", "details", "limitations"]) || !validFilters(value)) return false;
	const filters = value as unknown as SearchIntentFilters;
	const allowedDetails = [
		...(filters.socialGames ? ["social games", ...socialGameReferences.map(({ detail }) => detail)] : []),
		...activityCategories.filter(({ category }) => filters.activityCategories.includes(category)).map(({ label }) => label),
		...cuisineCategories.filter(({ category }) => filters.cuisineCategories.includes(category)).map(({ label }) => label),
	];
	return allowedArray(value.details, allowedDetails) && allowedArray(value.limitations, allowedLimitations);
}

export function searchIntentFromFilters(filters: SearchIntentFilters, rules: SearchIntent, optionalDrinks = false): SearchIntent {
	const references = rules.details.filter((detail) => socialGameReferences.some((reference) => reference.detail === detail));
	const details = [
		...(filters.socialGames ? (references.length ? references : ["social games"]) : []),
		...filters.activityCategories.map((category) => activityCategories.find((item) => item.category === category)!.label),
		...filters.cuisineCategories.map((category) => cuisineCategories.find((item) => item.category === category)!.label),
	];
	const limitations = [...rules.limitations];
	if (filters.socialGames && !limitations.includes(socialGamesLimitation)) limitations.unshift(socialGamesLimitation);
	if (optionalDrinks && !filters.types.includes("drinks") && !limitations.includes(optionalClubbingLimitation)) limitations.push(optionalDrinksLimitation);
	return { ...filters, details, limitations };
}

const sportSearchCategories = activityCategories
	.filter(({ category }) => ["sport.sports_centre", "sport.sports_hall", "sport.ice_rink", "entertainment.bowling_alley"].includes(category))
	.map(({ category, label }) => ({ category, label }));

function requestedMatch(text: string, terms: RegExp, ignoreOptionalPlans = false): boolean {
	for (const match of text.matchAll(new RegExp(terms.source, "gi"))) {
		const clauseStart = Math.max(
			text.lastIndexOf(",", match.index),
			text.lastIndexOf(";", match.index),
			text.lastIndexOf(".", match.index),
			text.lastIndexOf("!", match.index),
			text.lastIndexOf("?", match.index),
		) + 1;
		const prefix = text.slice(clauseStart, match.index);
		if (!/\b(?:no|not|without|avoid|avoiding|skip|exclude|excluding|don't want|do not want)\b/i.test(prefix) &&
			!(ignoreOptionalPlans && optionalPlanTerms.test(prefix))) {
			return true;
		}
	}
	return false;
}

function excludedMatch(text: string, terms: RegExp): boolean {
	for (const match of text.matchAll(new RegExp(terms.source, "gi"))) {
		const clauseStart = Math.max(
			text.lastIndexOf(",", match.index),
			text.lastIndexOf(";", match.index),
			text.lastIndexOf(".", match.index),
			text.lastIndexOf("!", match.index),
			text.lastIndexOf("?", match.index),
		) + 1;
		if (/\b(?:no|not|without|avoid|avoiding|skip|exclude|excluding|don't want|do not want)\b/i.test(text.slice(clauseStart, match.index))) return true;
	}
	return false;
}

function hasOptionalMention(text: string, terms: RegExp): boolean {
	for (const match of text.matchAll(new RegExp(terms.source, "gi"))) {
		const clauseStart = Math.max(
			text.lastIndexOf(",", match.index),
			text.lastIndexOf(";", match.index),
			text.lastIndexOf(".", match.index),
			text.lastIndexOf("!", match.index),
			text.lastIndexOf("?", match.index),
		) + 1;
		if (optionalPlanTerms.test(text.slice(clauseStart, match.index))) return true;
	}
	return false;
}

export function excludedActivityCategories(prompt: string): string[] {
	const text = prompt.trim();
	return activityCategories
		.filter(({ terms }) => excludedMatch(text, terms) && !requestedMatch(text, terms))
		.map(({ category }) => category);
}

export function parseSearchIntent(prompt: string): SearchIntent {
	const text = prompt.trim();
	const textWithoutMiniGolf = text.replace(/\b(?:mini(?:ature)?|crazy)[\s-]?golf\b/gi, " minigolf ");
	const cuisineMatches = cuisineCategories.filter(({ terms }) => requestedMatch(text, terms));
	const activityMatches = activityCategories
		.filter(({ category, terms }) => requestedMatch(category === "sport.golf_course" ? textWithoutMiniGolf : text, terms))
		.map(({ category, label }) => ({ category, label }));
	const socialGameReferenceMatches = socialGameReferences.filter(({ terms }) => requestedMatch(text, terms));
	const socialGames = socialGameReferenceMatches.length > 0 || requestedMatch(text, directSocialGames);
	if (socialGames) {
		for (const alternative of socialGameAlternatives) {
			const definition = activityCategories.find(({ category }) => category === alternative.category);
			if (definition && !excludedMatch(text, definition.terms) && !activityMatches.some(({ category }) => category === alternative.category)) activityMatches.push(alternative);
		}
	}
	const requestsSports = requestedMatch(text, /\bsports?\b/i);
	const requestsActivities = requestedMatch(text, /\b(?:activities|activity|things?\s+to\s+do|entertainment)\b/i);
	const requestsFood = requestedMatch(text, /\b(?:food|dinner|lunch|restaurants?|cuisine|eat)\b/i) || cuisineMatches.length > 0;
	const requestsClubbing = requestedMatch(text, clubbingTerms, true);
	const optionalClubbing = hasOptionalMention(text, clubbingTerms);
	const requestsDrinks = requestedMatch(text, /\b(?:drinks?|bars?|pubs?|beer|wine|alcohol|cocktails?)\b/i) || requestsClubbing;
	const types = new Set<VenueType>();
	if (requestsSports || requestsActivities || activityMatches.length > 0 || socialGames) types.add("activities");
	if (requestsFood) types.add("food");
	if (requestsDrinks) types.add("drinks");

	if (requestsSports && !activityMatches.some(({ category }) => sportSearchCategories.some((sport) => sport.category === category))) {
		activityMatches.push(...sportSearchCategories);
	}

	const indoorMentioned = requestedMatch(text, /\bindoors?\b/i);
	const alcoholMentioned = requestedMatch(text, /\b(?:beer|wine|alcohol|cocktails?)\b/i);
	const budgetMentioned = requestedMatch(text, /\b(?:budget|mid[ -]?range|moderate|cheap|affordable|expensive|price[ -]?range)\b/i);
	const limitations: string[] = [];
	if (socialGames) {
		limitations.push(socialGamesLimitation);
	}
	if (optionalClubbing && !requestsClubbing) limitations.push(optionalClubbingLimitation);
	if (indoorMentioned) limitations.push(indoorLimitation);
	if (alcoholMentioned) limitations.push(alcoholLimitation);
	if (budgetMentioned) limitations.push(budgetLimitation);

	const details = [
		...socialGameReferenceMatches.map(({ detail }) => detail),
		...(socialGames && socialGameReferenceMatches.length === 0 ? ["social games"] : []),
		...activityMatches.map(({ label }) => label),
		...cuisineMatches.map(({ label }) => label),
	].filter((label, index, values) => values.indexOf(label) === index);

	return {
		types: venueTypes.filter((type) => types.has(type)),
		activityCategories: [...new Set(activityMatches.map(({ category }) => category))],
		cuisineCategories: cuisineMatches.map(({ category }) => category),
		socialGames,
		details,
		limitations,
	};
}