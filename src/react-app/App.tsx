import { useEffect, useState } from "react";
import { getCapacityStatus, sortVenuesBySuitability } from "./venue-utils";
import "./App.css";

interface Venue {
	id: string;
	type: "node";
	lat?: number;
	lon?: number;
	center?: { lat: number; lon: number };
	distance?: number;
	category?: string;
	address?: string;
	tags: {
		name?: string;
		amenity?: string;
		leisure?: string;
		"addr:street"?: string;
		"addr:housenumber"?: string;
		"addr:city"?: string;
		"addr:postcode"?: string;
		website?: string;
		phone?: string;
		capacity?: string;
	};
}

interface GeocodingResult {
	id: string;
	label: string;
	lat: number;
	lon: number;
}

interface LocationSearchResponse {
	results?: GeocodingResult[];
}

interface VenueSearchResponse {
	elements?: Venue[];
}

interface ApiError {
	error?: string;
}

const venueTypeLabels = {
	activities: "Activities",
	food: "Food",
	drinks: "Drinks",
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	let data: T & ApiError;
	try {
		data = await response.json();
	} catch {
		throw new Error("The search service returned an unreadable response. Please try again.");
	}
	if (!response.ok) {
		throw new Error(data.error || "The search service is unavailable. Please try again.");
	}
	return data;
}

function safeWebsiteUrl(value: string): string | undefined {
	try {
		const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function App() {
	const [location, setLocation] = useState("");
	const [selectedLocation, setSelectedLocation] = useState<GeocodingResult>();
	const [suggestions, setSuggestions] = useState<GeocodingResult[]>([]);
	const [suggestionsOpen, setSuggestionsOpen] = useState(false);
	const [suggestionsLoading, setSuggestionsLoading] = useState(false);
	const [suggestionError, setSuggestionError] = useState("");
	const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
	const [groupSize, setGroupSize] = useState("10");
	const [searchedGroupSize, setSearchedGroupSize] = useState(10);
	const [types, setTypes] = useState({ activities: false, food: false, drinks: false });
	const [results, setResults] = useState<Venue[]>([]);
	const [loading, setLoading] = useState(false);
	const [hasSearched, setHasSearched] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		const query = location.trim();
		const controller = new AbortController();
		setSuggestions([]);
		setActiveSuggestionIndex(-1);
		setSuggestionError("");

		if (selectedLocation || query.length < 3) {
			setSuggestionsLoading(false);
			return () => controller.abort();
		}

		const timer = window.setTimeout(async () => {
			setSuggestionsLoading(true);
			try {
				const data = await requestJson<LocationSearchResponse>(
					`/api/suggest?q=${encodeURIComponent(query)}`,
					{ signal: controller.signal },
				);
				if (!controller.signal.aborted) {
					setSuggestions(Array.isArray(data.results) ? data.results : []);
					setSuggestionsOpen(true);
				}
			} catch {
				if (!controller.signal.aborted) {
					setSuggestionError("Suggestions are unavailable right now. You can still search using this location.");
					setSuggestionsOpen(true);
				}
			} finally {
				if (!controller.signal.aborted) setSuggestionsLoading(false);
			}
		}, 350);

		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [location, selectedLocation]);

	const handleTypeChange = (type: keyof typeof types) => {
		setTypes((prev) => ({ ...prev, [type]: !prev[type] }));
	};

	const selectLocation = (place: GeocodingResult) => {
		setLocation(place.label);
		setSelectedLocation(place);
		setSuggestions([]);
		setSuggestionsOpen(false);
		setActiveSuggestionIndex(-1);
		setSuggestionError("");
	};

	const handleLocationKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" && suggestions.length > 0) {
			event.preventDefault();
			setSuggestionsOpen(true);
			setActiveSuggestionIndex((current) => (current + 1) % suggestions.length);
		} else if (event.key === "ArrowUp" && suggestions.length > 0) {
			event.preventDefault();
			setSuggestionsOpen(true);
			setActiveSuggestionIndex((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
		} else if (event.key === "Enter" && suggestionsOpen && activeSuggestionIndex >= 0) {
			event.preventDefault();
			selectLocation(suggestions[activeSuggestionIndex]);
		} else if (event.key === "Escape") {
			setSuggestionsOpen(false);
			setActiveSuggestionIndex(-1);
		}
	};

	const searchVenues = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setError("");
		setResults([]);
		setHasSearched(true);
		setSuggestionsOpen(false);

		const requestedGroupSize = Number(groupSize);
		if (!Number.isSafeInteger(requestedGroupSize) || requestedGroupSize < 1) {
			setError("Enter a whole number of people, starting at 1.");
			return;
		}

		const selectedTypes = Object.entries(types)
			.filter(([, enabled]) => enabled)
			.map(([type]) => type as keyof typeof venueTypeLabels);
		if (selectedTypes.length === 0) {
			setError("Choose at least one venue type to search.");
			return;
		}

		setSearchedGroupSize(requestedGroupSize);
		setLoading(true);
		try {
			let place = selectedLocation;
			if (!place) {
				const geocodingResults = await requestJson<LocationSearchResponse>(
					`/api/geocode?q=${encodeURIComponent(location.trim())}`,
				);
				place = geocodingResults.results?.[0];
			}
			if (!place) throw new Error("We couldn't find that location. Try a nearby town or city.");

			const lat = Number(place.lat);
			const lon = Number(place.lon);
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
				throw new Error("The location search returned invalid coordinates. Please try another place.");
			}

			const params = new URLSearchParams({
				lat: String(lat),
				lon: String(lon),
				types: selectedTypes.join(","),
				groupSize: String(requestedGroupSize),
			});
			const venueData = await requestJson<VenueSearchResponse>(`/api/venues?${params}`);
			const venues = Array.isArray(venueData.elements)
				? venueData.elements.filter((venue) =>
						venue.tags?.name &&
						Number.isFinite(venue.lat ?? venue.center?.lat) &&
						Number.isFinite(venue.lon ?? venue.center?.lon),
					)
				: [];
			setResults(sortVenuesBySuitability(venues, requestedGroupSize));
		} catch (caughtError) {
			setError(caughtError instanceof Error ? caughtError.message : "Search failed. Please try again.");
		} finally {
			setLoading(false);
		}
	};

	const selectedLabels = Object.entries(types)
		.filter(([, enabled]) => enabled)
		.map(([type]) => venueTypeLabels[type as keyof typeof venueTypeLabels]);

	return (
		<div className="container">
			<header className="hero">
				<p className="eyebrow">A little planning, a lot of festive cheer</p>
				<h1>Find your night-out spot</h1>
				<p className="hero-copy">
					Discover places for your team’s Christmas celebration, all in one easy search.
				</p>
			</header>

			<main>
				<section className="search-panel" aria-labelledby="search-title">
					<div className="section-heading">
						<p className="step-label">Plan your evening</p>
						<h2 id="search-title">What does your group have in mind?</h2>
					</div>
					<form onSubmit={searchVenues} className="search-form">
						<div className="input-row">
							<div className="form-group location-field">
								<label htmlFor="location">Suggested location</label>
								<input
									id="location"
									type="text"
									value={location}
									onChange={(event) => {
										setLocation(event.target.value);
										setSelectedLocation(undefined);
										setSuggestionsOpen(true);
									}}
									onKeyDown={handleLocationKeyDown}
									onFocus={() => {
										if (location.trim().length >= 3 && suggestions.length > 0) setSuggestionsOpen(true);
									}}
									onBlur={() => setSuggestionsOpen(false)}
									role="combobox"
									aria-autocomplete="list"
									aria-expanded={suggestionsOpen && suggestions.length > 0}
									aria-controls="location-suggestions"
									aria-activedescendant={
										suggestionsOpen && activeSuggestionIndex >= 0
										? `location-suggestion-${activeSuggestionIndex}`
										: undefined
									}
									aria-describedby="location-suggestion-status"
									placeholder="e.g. Manchester, UK"
									autoComplete="off"
									required
								/>
								{suggestionsOpen && suggestions.length > 0 && (
									<ul className="suggestions-list" id="location-suggestions" role="listbox">
										{suggestions.map((suggestion, index) => (
											<li
												className={index === activeSuggestionIndex ? "suggestion-option active" : "suggestion-option"}
												id={`location-suggestion-${index}`}
												key={suggestion.id}
												role="option"
												aria-selected={index === activeSuggestionIndex}
												onMouseDown={(event) => event.preventDefault()}
												onMouseEnter={() => setActiveSuggestionIndex(index)}
												onClick={() => selectLocation(suggestion)}
											>
												{suggestion.label}
											</li>
										))}
									</ul>
								)}
								<p className="suggestion-message" id="location-suggestion-status" role="status" aria-live="polite">
									{suggestionsLoading && "Searching locations…"}
									{!suggestionsLoading && suggestionError}
									{!suggestionsLoading && !suggestionError && suggestionsOpen && location.trim().length >= 3 && suggestions.length === 0 && "No suggestions found; you can still search this location."}
								</p>
							</div>
							<div className="form-group group-size-field">
								<label htmlFor="groupSize">Group size</label>
								<div className="number-input-wrap">
									<input
										id="groupSize"
										type="number"
										value={groupSize}
										onChange={(event) => setGroupSize(event.target.value)}
										min="1"
										step="1"
										inputMode="numeric"
										required
									/>
									<span>people</span>
								</div>
							</div>
						</div>

						<fieldset className="form-group type-fieldset">
							<legend>Choose what to include</legend>
							<p className="field-hint">Select one, a few, or all three.</p>
							<div className="checkbox-group">
								{(Object.keys(venueTypeLabels) as Array<keyof typeof venueTypeLabels>).map((type) => (
									<label className="type-option" key={type}>
										<input
											type="checkbox"
											checked={types[type]}
											onChange={() => handleTypeChange(type)}
										/>
										<span className="checkbox-mark" aria-hidden="true" />
										<span>{venueTypeLabels[type]}</span>
									</label>
								))}
							</div>
						</fieldset>

						<button className="search-button" type="submit" disabled={loading}>
							{loading ? "Searching nearby places…" : "Find venues"}
							<span aria-hidden="true">→</span>
						</button>
						<p className="privacy-note">Geoapify’s free plan requires an API key; searches use daily credits.</p>
					</form>
				</section>

				{error && <p className="error" role="alert">{error}</p>}

				<section className="results" aria-label="Venue search results" aria-live="polite">
					{loading && <p className="loading-message">Looking for places around {location.trim()}…</p>}
					{!loading && hasSearched && !error && results.length === 0 && (
						<div className="empty-state">
							<h2 id="results-title">No named venues found nearby</h2>
							<p>Try a nearby town or city, or choose different venue types.</p>
						</div>
					)}
					{results.length > 0 && (
						<>
							<div className="results-heading">
								<div>
									<p className="step-label">Your shortlist</p>
									<h2 id="results-title">{results.length} potential {results.length === 1 ? "venue" : "venues"}</h2>
								</div>
								<p className="results-context">Near {location.trim()}</p>
							</div>
							<p className="results-disclaimer">
								Search includes {selectedLabels.join(" + ")}. Results can match any selected type, not every type.
								Known capacities below {searchedGroupSize} are omitted. Café and fast-food listings are filtered unless they also match a selected activity or drinks category.
								Capacity and listing details may be incomplete or out of date; confirm group bookings with the venue.
							</p>
							<div className="venue-list">
								{results.map((venue) => {
									const lat = venue.lat ?? venue.center?.lat;
									const lon = venue.lon ?? venue.center?.lon;
								const capacityStatus = getCapacityStatus(venue.tags.capacity, searchedGroupSize);
									const category = (venue.category || venue.tags.amenity || venue.tags.leisure || "venue")
										.replace(/_/g, " ")
										.replace(/^\w/, (letter) => letter.toUpperCase());
									const address = venue.address || [
										[venue.tags["addr:housenumber"], venue.tags["addr:street"]].filter(Boolean).join(" "),
										venue.tags["addr:city"],
										venue.tags["addr:postcode"],
									].filter(Boolean).join(", ");
									const distance = typeof venue.distance === "number" ? `${(venue.distance / 1000).toFixed(1)} km away` : "";
									const website = venue.tags.website ? safeWebsiteUrl(venue.tags.website) : undefined;
									const phoneLink = venue.tags.phone?.replace(/[^\d+]/g, "");
									const mapUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;

									return (
										<article className="venue-card" key={`${venue.type}-${venue.id}`}>
											<div className="venue-card-topline">
												<span className="category-pill">{category}</span>
												<span className={`capacity-status ${capacityStatus}`}>
													{capacityStatus === "fits" ? "Capacity listed" : capacityStatus === "too-small" ? "May be too small" : "Capacity unknown"}
												</span>
											</div>
											<h3>{venue.tags.name}</h3>
											{address && <p className="venue-address">{address}</p>}
											{distance && <p className="venue-distance">{distance}</p>}
											<p className={`capacity-detail ${capacityStatus}`}>
												{capacityStatus === "fits" && `Listed capacity: ${venue.tags.capacity} people`}
												{capacityStatus === "too-small" &&
													`Listed for ${venue.tags.capacity} people; your group is ${searchedGroupSize}`}
												{capacityStatus === "unknown" && "No numeric capacity listed for this venue."}
											</p>
											<div className="venue-links">
												<a href={mapUrl} target="_blank" rel="noreferrer">View map <span aria-hidden="true">↗</span></a>
												{website && <a href={website} target="_blank" rel="noreferrer">Website <span aria-hidden="true">↗</span></a>}
												{phoneLink && <a href={`tel:${phoneLink}`}>Call venue</a>}
											</div>
										</article>
									);
								})}
							</div>
						</>
					)}
					{!hasSearched && (
						<p className="results-prompt">Your matching venues will appear here, filtered for your group size and ordered by capacity suitability and distance.</p>
					)}
				</section>
			</main>

			<footer className="site-footer">
				<p>Place search by <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Geoapify</a>; map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>.</p>
				<p>Capacities and details may be missing or out of date. Always confirm group bookings directly.</p>
			</footer>
		</div>
	);
}

export default App;
