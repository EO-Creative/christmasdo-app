import { useCallback, useEffect, useMemo, useState } from "react";
import { getCapacityStatus, sortVenuesBySuitability } from "./venue-utils";
import { ResultsMap } from "./ResultsMap";
import type { VenueType as MapVenueType } from "./map-utils";
import { parseSearchIntent, type VenueType } from "../shared/search-intent.ts";
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

interface SearchSnapshot {
	location: { label: string; lat: number; lon: number };
	groupSize: number;
	radiusKm: number;
	types: VenueType[];
	prompt?: string;
	results: Record<VenueType, Venue[]>;
}

interface VenueSearchResponse {
	results?: Partial<Record<VenueType, Venue[]>>;
}

interface ShortlistItem {
	venueId: string;
	addedAt: number;
	votes: Record<VenueType, number>;
	votedByMe: VenueType[];
}

interface SharedSearchResponse {
	id: string;
	createdAt: number;
	snapshot: SearchSnapshot;
	shortlist: ShortlistItem[];
}

interface ApiError {
	error?: string;
}

const venueTypeLabels = {
	activities: "Activities",
	food: "Food",
	drinks: "Drinks",
};
const venueTypes: VenueType[] = ["activities", "food", "drinks"];
const radiusOptions = [1, 2, 5, 10, 20];
const voterStorageKey = "christmasdo-voter-id";

function getVoterId(): string {
	try {
		const existing = window.localStorage.getItem(voterStorageKey);
		if (existing && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(existing)) return existing;
		const created = window.crypto.randomUUID();
		window.localStorage.setItem(voterStorageKey, created);
		return created;
	} catch {
		return window.crypto.randomUUID();
	}
}

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
	const [prompt, setPrompt] = useState("");
	const [searchedPrompt, setSearchedPrompt] = useState("");
	const [location, setLocation] = useState("");
	const [selectedLocation, setSelectedLocation] = useState<GeocodingResult>();
	const [suggestions, setSuggestions] = useState<GeocodingResult[]>([]);
	const [suggestionsOpen, setSuggestionsOpen] = useState(false);
	const [suggestionsLoading, setSuggestionsLoading] = useState(false);
	const [suggestionError, setSuggestionError] = useState("");
	const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
	const [groupSize, setGroupSize] = useState("10");
	const [searchedGroupSize, setSearchedGroupSize] = useState(10);
	const [searchedLocation, setSearchedLocation] = useState("");
	const [searchedCoordinates, setSearchedCoordinates] = useState<{ lat: number; lon: number }>();
	const [searchedRadiusKm, setSearchedRadiusKm] = useState(5);
	const [searchedTypes, setSearchedTypes] = useState<VenueType[]>([]);
	const [types, setTypes] = useState({ activities: false, food: false, drinks: false });
	const [radiusKm, setRadiusKm] = useState(5);
	const [results, setResults] = useState<Record<VenueType, Venue[]>>({ activities: [], food: [], drinks: [] });
	const [shareId, setShareId] = useState(() => new URLSearchParams(window.location.search).get("share") || "");
	const [voterId, setVoterId] = useState("");
	const [shortlist, setShortlist] = useState<ShortlistItem[]>([]);
	const [refreshingShare, setRefreshingShare] = useState(false);
	const [busyVenueId, setBusyVenueId] = useState("");
	const [copied, setCopied] = useState(false);
	const [loading, setLoading] = useState(false);
	const [hasSearched, setHasSearched] = useState(false);
	const [resultsView, setResultsView] = useState<"list" | "map">("list");
	const [error, setError] = useState("");
	const [shareError, setShareError] = useState("");
	const promptIntent = useMemo(() => parseSearchIntent(prompt), [prompt]);
	const searchedIntent = useMemo(() => parseSearchIntent(searchedPrompt), [searchedPrompt]);

	const applySharedSearch = useCallback((shared: SharedSearchResponse) => {
		const snapshot = shared.snapshot;
		setShareId(shared.id);
		setPrompt(snapshot.prompt ?? "");
		setSearchedPrompt(snapshot.prompt ?? "");
		setLocation(snapshot.location.label);
		setSelectedLocation({
			id: snapshot.location.label,
			label: snapshot.location.label,
			lat: snapshot.location.lat,
			lon: snapshot.location.lon,
		});
		setGroupSize(String(snapshot.groupSize));
		setSearchedGroupSize(snapshot.groupSize);
		setSearchedLocation(snapshot.location.label);
		setSearchedCoordinates({ lat: snapshot.location.lat, lon: snapshot.location.lon });
		setSearchedRadiusKm(snapshot.radiusKm);
		setSearchedTypes(snapshot.types);
		setRadiusKm(snapshot.radiusKm);
		setTypes({
			activities: snapshot.types.includes("activities"),
			food: snapshot.types.includes("food"),
			drinks: snapshot.types.includes("drinks"),
		});
		setResults(snapshot.results);
		setShortlist(shared.shortlist);
		setHasSearched(true);
	}, []);

	const loadSharedSearch = useCallback(async (id: string, browserVoterId: string, applySnapshot = true) => {
		const shared = await requestJson<SharedSearchResponse>(
			`/api/searches/${encodeURIComponent(id)}?voterId=${encodeURIComponent(browserVoterId)}`,
		);
		if (applySnapshot) applySharedSearch(shared);
		else setShortlist(shared.shortlist);
	}, [applySharedSearch]);

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

	useEffect(() => {
		const browserVoterId = getVoterId();
		setVoterId(browserVoterId);
		const sharedId = new URLSearchParams(window.location.search).get("share");
		if (!sharedId) return;

		setLoading(true);
		loadSharedSearch(sharedId, browserVoterId).catch((caughtError) => {
			setError(caughtError instanceof Error ? caughtError.message : "Could not open this shared search.");
		}).finally(() => setLoading(false));
	}, [loadSharedSearch]);

	useEffect(() => {
		if (!shareId || !voterId) return;
		let active = true;
		const refresh = async () => {
			try {
				const shared = await requestJson<SharedSearchResponse>(
					`/api/searches/${encodeURIComponent(shareId)}?voterId=${encodeURIComponent(voterId)}`,
				);
				if (active) setShortlist(shared.shortlist);
			} catch {
				if (active) setShareError("Could not refresh shared votes; try again shortly.");
			}
		};
		const timer = window.setInterval(refresh, 30000);
		return () => {
			active = false;
			window.clearInterval(timer);
		};
	}, [shareId, voterId]);

	const handleTypeChange = (type: keyof typeof types) => {
		setTypes((prev) => ({ ...prev, [type]: !prev[type] }));
	};

	const handlePromptChange = (value: string) => {
		setPrompt(value);
		const inferredTypes = parseSearchIntent(value).types;
		setTypes({
			activities: inferredTypes.includes("activities"),
			food: inferredTypes.includes("food"),
			drinks: inferredTypes.includes("drinks"),
		});
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
		setShareError("");
		setShareId("");
		setShortlist([]);
		setResults({ activities: [], food: [], drinks: [] });
		setHasSearched(true);
		setSuggestionsOpen(false);
		window.history.replaceState(null, "", window.location.pathname);
		const submittedPrompt = prompt.trim();

		const requestedGroupSize = Number(groupSize);
		if (!Number.isSafeInteger(requestedGroupSize) || requestedGroupSize < 1 || requestedGroupSize > 10000) {
			setError("Enter a whole number of people between 1 and 10,000.");
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
				radiusKm: String(radiusKm),
				prompt: submittedPrompt,
			});
			const venueData = await requestJson<VenueSearchResponse>(`/api/venues?${params}`);
			const groupedResults = Object.fromEntries(venueTypes.map((type) => {
				const venues = Array.isArray(venueData.results?.[type])
					? venueData.results[type]!.filter((venue) =>
							venue.tags?.name &&
							Number.isFinite(venue.lat ?? venue.center?.lat) &&
							Number.isFinite(venue.lon ?? venue.center?.lon),
						)
					: [];
			return [type, sortVenuesBySuitability(venues, requestedGroupSize)];
			})) as Record<VenueType, Venue[]>;
			setResults(groupedResults);
			setLocation(place.label);
			setSelectedLocation(place);
			setSearchedCoordinates({ lat, lon });
			const snapshot: SearchSnapshot = {
				location: { label: place.label, lat, lon },
				groupSize: requestedGroupSize,
				radiusKm,
				types: selectedTypes,
				prompt: submittedPrompt || undefined,
				results: groupedResults,
			};
			setSearchedPrompt(submittedPrompt);
			setSearchedLocation(snapshot.location.label);
			setSearchedRadiusKm(snapshot.radiusKm);
			setSearchedTypes(snapshot.types);
			try {
				const saved = await requestJson<{ id: string }>("/api/searches", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(snapshot),
				});
				setShareId(saved.id);
				setShortlist([]);
				const url = new URL(window.location.href);
				url.searchParams.set("share", saved.id);
				window.history.replaceState(null, "", url);
			} catch (caughtError) {
				setShareError(caughtError instanceof Error ? caughtError.message : "Search results could not be saved for sharing.");
			}
		} catch (caughtError) {
			setError(caughtError instanceof Error ? caughtError.message : "Search failed. Please try again.");
		} finally {
			setLoading(false);
		}
	};

	const selectedLabels = searchedTypes.map((type) => venueTypeLabels[type]);
	const allResults = venueTypes.flatMap((type) => results[type]);
	const mapVenues = useMemo(() => searchedTypes.flatMap((type) =>
		results[type].map((venue) => ({ venue, type: type as MapVenueType })),
	), [results, searchedTypes]);
	const shortlistedVenues = shortlist.map((item) => ({
		item,
		venue: allResults.find((candidate) => candidate.id === item.venueId),
	})).filter((entry): entry is { item: ShortlistItem; venue: Venue } => Boolean(entry.venue));
	const shortlistedVenuesByType = (type: VenueType) => shortlist.flatMap((item) => {
		const venue = results[type].find((candidate) => candidate.id === item.venueId);
		return venue ? [{ item, venue }] : [];
	}).sort((first, second) => second.item.votes[type] - first.item.votes[type] || first.item.addedAt - second.item.addedAt);
	const shareUrl = shareId ? new URL(`?share=${encodeURIComponent(shareId)}`, window.location.href).href : "";

	const refreshVotes = async () => {
		if (!shareId || !voterId) return;
		setRefreshingShare(true);
		setShareError("");
		try {
			await loadSharedSearch(shareId, voterId, false);
		} catch (caughtError) {
			setShareError(caughtError instanceof Error ? caughtError.message : "Could not refresh the shared shortlist.");
		} finally {
			setRefreshingShare(false);
		}
	};

	const updateShortlist = async (venueId: string, action: "add" | "remove") => {
		if (!shareId) return;
		setBusyVenueId(venueId);
		setShareError("");
		try {
			await requestJson(`/api/searches/${encodeURIComponent(shareId)}/shortlist`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ venueId, action }),
			});
			await loadSharedSearch(shareId, voterId, false);
		} catch (caughtError) {
			setShareError(caughtError instanceof Error ? caughtError.message : "Could not update the shared shortlist.");
		} finally {
			setBusyVenueId("");
		}
	};

	const toggleVote = async (venueId: string, category: VenueType, voted: boolean) => {
		if (!shareId || !voterId) return;
		setBusyVenueId(venueId);
		setShareError("");
		try {
			await requestJson(`/api/searches/${encodeURIComponent(shareId)}/votes`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ venueId, category, voterId, voted: !voted }),
			});
			await loadSharedSearch(shareId, voterId, false);
		} catch (caughtError) {
			setShareError(caughtError instanceof Error ? caughtError.message : "Could not record your vote.");
		} finally {
			setBusyVenueId("");
		}
	};

	const copyShareLink = async () => {
		try {
			await navigator.clipboard.writeText(shareUrl);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1800);
		} catch {
			setShareError("Could not copy the link. Select and copy the share URL instead.");
		}
	};

	const renderVenueCard = (venue: Venue, categoryType: VenueType, shortlistItem?: ShortlistItem) => {
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
		const isShortlisted = Boolean(shortlistItem);
		const votedByMe = shortlistItem?.votedByMe.includes(categoryType) ?? false;
		const alreadyVotedInCategory = shortlist.some((item) => item.votedByMe.includes(categoryType));

		return (
			<article className="venue-card" key={`${categoryType}-${venue.id}`}>
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
					{capacityStatus === "too-small" && `Listed for ${venue.tags.capacity} people; your group is ${searchedGroupSize}`}
					{capacityStatus === "unknown" && "No numeric capacity listed for this venue."}
				</p>
				<div className="venue-links">
					<a href={mapUrl} target="_blank" rel="noreferrer">View map <span aria-hidden="true">↗</span></a>
					{website && <a href={website} target="_blank" rel="noreferrer">Website <span aria-hidden="true">↗</span></a>}
					{phoneLink && <a href={`tel:${phoneLink}`}>Call venue</a>}
				</div>
				{shareId && (
					<div className="venue-actions">
						<button
							type="button"
							className="shortlist-button"
							disabled={busyVenueId === venue.id}
							onClick={() => updateShortlist(venue.id, isShortlisted ? "remove" : "add")}
						>
							{busyVenueId === venue.id ? "Saving…" : isShortlisted ? "Remove from shortlist" : "Add to shortlist"}
						</button>
						{shortlistItem && (
							<button
								type="button"
								className={votedByMe ? "vote-button voted" : "vote-button"}
								disabled={busyVenueId === venue.id}
								onClick={() => toggleVote(venue.id, categoryType, votedByMe)}
							>
								{votedByMe ? "Your vote · " : alreadyVotedInCategory ? "Change vote · " : "Vote · "}{shortlistItem.votes[categoryType]}
							</button>
						)}
					</div>
				)}
			</article>
		);
	};

	return (
		<div className="container">
			{shareId && (
				<section className="shortlist-section shared-shortlist" aria-labelledby="shortlist-heading">
					<div className="category-heading">
						<div>
							<p className="step-label">Group decision</p>
							<h2 id="shortlist-heading">Shortlist and votes</h2>
						</div>
						<span>{shortlistedVenues.length} selected</span>
					</div>
					{searchedLocation && <p className="results-context">{searchedLocation} · {searchedGroupSize} people · {searchedRadiusKm} km radius</p>}
					<div className="share-panel">
						<div>
							<h3>Share and decide together</h3>
							<p>Anyone with this link can add venues to the shortlist and vote. Each browser can choose one venue per category.</p>
						</div>
						<div className="share-link-row">
							<input aria-label="Shareable search link" readOnly value={shareUrl} onFocus={(event) => event.currentTarget.select()} />
							<button type="button" className="share-button" onClick={copyShareLink}>{copied ? "Copied" : "Copy link"}</button>
							<button type="button" className="refresh-button" onClick={refreshVotes} disabled={refreshingShare || !voterId}>
								{refreshingShare ? "Refreshing…" : "Refresh votes"}
							</button>
						</div>
						<p className="share-note">A normal refresh keeps this browser’s local voting ID. It is not identity-verified; clearing browser storage or switching browsers can create another vote identity.</p>
					</div>
					{error && <p className="error share-error" role="alert">{error}</p>}
					{shareError && <p className="error share-error" role="alert">{shareError}</p>}
					{!hasSearched ? (
						<p className="loading-message">Loading the shared shortlist…</p>
					) : searchedTypes.map((type) => {
						const entries = shortlistedVenuesByType(type);
						const voteCount = shortlist.reduce((total, item) => total + item.votes[type], 0);
						return (
							<section className="shortlist-category" key={type} aria-labelledby={`shortlist-${type}-heading`}>
								<div className="category-heading">
									<h3 id={`shortlist-${type}-heading`}>{venueTypeLabels[type]}</h3>
									<span>{voteCount} {voteCount === 1 ? "vote" : "votes"}</span>
								</div>
								{entries.length ? (
									<div className="venue-list">
										{entries.map(({ item, venue }) => renderVenueCard(venue, type, item))}
									</div>
								) : <p className="category-empty">No {venueTypeLabels[type].toLowerCase()} venues shortlisted yet.</p>}
							</section>
						);
					})}
				</section>
			)}

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
						<div className="form-group prompt-field">
							<label htmlFor="searchPrompt">Describe the night you’re planning</label>
							<textarea
								id="searchPrompt"
								value={prompt}
								onChange={(event) => handlePromptChange(event.target.value)}
								maxLength={500}
								aria-describedby="prompt-hint prompt-interpretation"
								placeholder="e.g. Indoor sports activities with options for beer and wine, a mid-range budget, and some Lebanese food"
							/>
							<p className="field-hint" id="prompt-hint">
								Tell us what you’d enjoy; choose the search location and group size below. Up to 500 characters.
							</p>
							<div className="search-interpretation" id="prompt-interpretation" aria-live="polite">
								{prompt.trim() ? (
									<>
										<p>
											<strong>Suggested categories:</strong>{" "}
											{promptIntent.types.length
												? promptIntent.types.map((type) => venueTypeLabels[type]).join(", ")
												: "none recognized yet; choose categories below for a broad search"}
											. You can edit these choices.
										</p>
								{promptIntent.details.length > 0 && <p>Specific filters (if their category is selected): {promptIntent.details.join(", ")}.</p>}
										{promptIntent.limitations.length > 0 && (
											<ul>
												{promptIntent.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
											</ul>
										)}
									</>
								) : <p>Supported activity and cuisine phrases can narrow results; you can also choose categories below.</p>}
							</div>
						</div>
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
										max="10000"
										step="1"
										inputMode="numeric"
										required
									/>
									<span>people</span>
								</div>
							</div>
							<div className="form-group radius-field">
								<label htmlFor="radiusKm">Search radius</label>
								<select id="radiusKm" value={radiusKm} onChange={(event) => setRadiusKm(Number(event.target.value))}>
									{radiusOptions.map((radius) => <option value={radius} key={radius}>{radius} km</option>)}
								</select>
							</div>
						</div>

						<fieldset className="form-group type-fieldset">
							<legend>Search separately for</legend>
							<p className="field-hint">Suggested by your request; adjust these lists as needed.</p>
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
						<p className="privacy-note">Your request is saved with the shareable search, so avoid personal or confidential details.</p>
						<p className="privacy-note">Geoapify’s free plan requires an API key; searches use daily credits.</p>
					</form>
				</section>

				{error && <p className="error" role="alert">{error}</p>}

				<section className="results" aria-label="Venue search results" aria-live="polite">
					{loading && <p className="loading-message">Looking for places around {location.trim()}…</p>}
					{!hasSearched && <p className="results-prompt">Venue suggestions appear here in separate lists for each category, ordered by capacity suitability and distance.</p>}
					{!loading && hasSearched && !error && allResults.length === 0 && (
						<div className="empty-state">
							<h2>No named venues found nearby</h2>
							<p>Try a larger search radius, a nearby town or city, or different venue types.</p>
						</div>
					)}
					{!loading && shareError && !shareId && <p className="error share-error" role="alert">{shareError}</p>}
					{hasSearched && !loading && (allResults.length > 0 || shareId !== "") && (
						<>
							<div className="results-heading">
								<div>
									<p className="step-label">Venue options</p>
									<h2 id="results-title">Results by category</h2>
								</div>
								<p className="results-context">Near {searchedLocation} · within {searchedRadiusKm} km</p>
							</div>
							<div className="results-view-toggle" role="group" aria-label="Results view">
								<button type="button" className={resultsView === "list" ? "active" : ""} aria-pressed={resultsView === "list"} onClick={() => setResultsView("list")}>List view</button>
								<button type="button" className={resultsView === "map" ? "active" : ""} aria-pressed={resultsView === "map"} onClick={() => setResultsView("map")}>Map view</button>
							</div>
							<p className="results-disclaimer">
								Showing separate lists for {selectedLabels.join(", ")}. Geoapify does not provide dependable customer ratings for these listings, so venues are ordered by listed capacity suitability and distance.
								Known capacities below {searchedGroupSize} are omitted. Details may be incomplete; confirm group bookings directly.
							</p>
							{searchedPrompt && <p className="results-request">Your request: {searchedPrompt}</p>}
							{searchedIntent.limitations.length > 0 && (
								<ul className="results-limitations" aria-label="Preferences not verified by place data">
									{searchedIntent.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
								</ul>
							)}
							{!shareId && shareError && <p className="share-warning" role="status">Results are shown, but sharing is currently unavailable.</p>}
							{resultsView === "map" && searchedCoordinates ? (
								<ResultsMap
									venues={mapVenues}
									center={searchedCoordinates}
									renderVenueCard={(venue, type) => renderVenueCard(
										venue,
										type,
										shortlist.find((item) => item.venueId === venue.id),
									)}
								/>
							) : searchedTypes.map((type) => (
								<section className="category-results" key={type} aria-labelledby={`${type}-heading`}>
									<div className="category-heading">
										<h3 id={`${type}-heading`}>{venueTypeLabels[type]}</h3>
										<span>{results[type].length} {results[type].length === 1 ? "venue" : "venues"}</span>
									</div>
									{results[type].length ? (
										<div className="venue-list">
											{results[type].map((venue) => renderVenueCard(
												venue,
												type,
												shortlist.find((item) => item.venueId === venue.id),
											))}
										</div>
									) : <p className="category-empty">No matches in this category within {searchedRadiusKm} km.</p>}
								</section>
							))}
						</>
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
