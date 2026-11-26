import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { getVenueCoordinates, groupMapVenues, type MapVenue, type MapVenueEntry, type VenueType } from "./map-utils";

const venueTypeLabels: Record<VenueType, string> = {
	activities: "Activities",
	food: "Food",
	drinks: "Drinks",
};

interface ResultsMapProps<TVenue extends MapVenue> {
	venues: MapVenueEntry<TVenue>[];
	center: { lat: number; lon: number };
	renderVenueCard: (venue: TVenue, type: VenueType) => ReactNode;
}

interface MapMarker {
	key: string;
	lat: number;
	lon: number;
	names: string[];
	categoryTypes: VenueType[];
}

export function ResultsMap<TVenue extends MapVenue>({ venues, center, renderVenueCard }: ResultsMapProps<TVenue>) {
	const mapElement = useRef<HTMLDivElement>(null);
	const mapRef = useRef<L.Map | null>(null);
	const markerLayerRef = useRef<L.LayerGroup | null>(null);
	const markerElementsRef = useRef(new Map<string, HTMLElement>());
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const [selection, setSelection] = useState<{ key: string } | null>(null);
	const groups = useMemo(() => groupMapVenues(venues), [venues]);
	const selectedGroup = groups.find((group) => group.key === selection?.key);
	const markerData = JSON.stringify(groups.map((group) => ({
		key: group.key,
		lat: group.lat,
		lon: group.lon,
		names: [...new Set(group.entries.map(({ venue }) => venue.tags.name || "Unnamed venue"))].sort(),
		categoryTypes: [...group.categoryTypes].sort(),
	})).sort((a, b) => a.key.localeCompare(b.key)));
	const coordinateData = JSON.stringify(venues.flatMap(({ venue }) => {
		const coordinates = getVenueCoordinates(venue);
		return coordinates ? [[coordinates.lat, coordinates.lon]] : [];
	}).sort((a, b) => a[0] - b[0] || a[1] - b[1])
		.filter((point, index, points) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1]));

	const closeFlyover = () => {
		if (selection) markerElementsRef.current.get(selection.key)?.focus();
		setSelection(null);
	};

	useEffect(() => {
		if (selection) closeButtonRef.current?.focus();
	}, [selection]);

	useEffect(() => {
		if (!mapElement.current) return;

		const map = L.map(mapElement.current, { scrollWheelZoom: false }).setView([center.lat, center.lon], 13);
		L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
			maxZoom: 19,
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
		}).addTo(map);
		const markerLayer = L.layerGroup().addTo(map);
		mapRef.current = map;
		markerLayerRef.current = markerLayer;
		map.on("click", () => setSelection(null));
		const frame = window.requestAnimationFrame(() => map.invalidateSize());

		return () => {
			window.cancelAnimationFrame(frame);
			map.remove();
			mapRef.current = null;
			markerLayerRef.current = null;
		};
	}, [center.lat, center.lon]);

	useEffect(() => {
		const map = mapRef.current;
		const markerLayer = markerLayerRef.current;
		if (!map || !markerLayer) return;

		markerLayer.clearLayers();
		markerElementsRef.current.clear();
		for (const group of JSON.parse(markerData) as MapMarker[]) {
			const title = `${group.names.join(", ")} · ${group.categoryTypes.map((type) => venueTypeLabels[type]).join(", ")}`;
			const tooltip = document.createElement("span");
			tooltip.textContent = title;
			const dots = group.categoryTypes
				.map((type) => `<span class="venue-marker-dot ${type}" aria-hidden="true"></span>`)
				.join("");
			const icon = L.divIcon({
				className: "venue-marker-icon",
				html: `<span class="venue-marker" aria-hidden="true">${dots}</span>`,
				iconSize: [38, 38],
				iconAnchor: [19, 19],
			});
			const marker = L.marker([group.lat, group.lon], { icon, keyboard: true, title, alt: title })
				.addTo(markerLayer)
				.bindTooltip(tooltip);
			const selectMarker = () => setSelection({ key: group.key });
			marker.on("click", selectMarker);
			const element = marker.getElement();
			if (element) {
				element.setAttribute("aria-label", title);
				element.addEventListener("keydown", (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						event.stopPropagation();
						selectMarker();
					}
				});
				markerElementsRef.current.set(group.key, element);
			}
		}
	}, [center.lat, center.lon, markerData]);

	useEffect(() => {
		const map = mapRef.current;
		if (!map) return;

		const bounds = L.latLngBounds([[center.lat, center.lon]]);
		for (const [lat, lon] of JSON.parse(coordinateData) as [number, number][]) bounds.extend([lat, lon]);
		if (bounds.getNorthEast().equals(bounds.getSouthWest())) map.setView([center.lat, center.lon], 13);
		else map.fitBounds(bounds.pad(0.18), { maxZoom: 14 });
	}, [center.lat, center.lon, coordinateData]);
	return (
		<div className="results-map-panel">
			<div className="map-legend" aria-label="Map marker categories">
				{(Object.keys(venueTypeLabels) as VenueType[]).map((type) => (
					<span className="map-legend-item" key={type}>
						<span className={`map-legend-dot ${type}`} aria-hidden="true" />
						{venueTypeLabels[type]}
					</span>
				))}
			</div>
			<p className="map-help">Select a marker to see venues at that location. Use Enter or Space on a marker, and Escape to close the details.</p>
			<div className="results-map-wrapper" onKeyDown={(event) => {
				if (event.key === "Escape" && selectedGroup) {
					event.stopPropagation();
					closeFlyover();
				}
			}}>
				<div className="results-map" ref={mapElement} role="region" aria-label="Interactive map of venue results" />
				{selectedGroup && (
					<section className="map-selected-venues" aria-labelledby="map-selected-heading">
						<div className="map-selected-header">
							<h3 id="map-selected-heading">Venues at this location</h3>
							<button type="button" className="map-close-button" ref={closeButtonRef} onClick={closeFlyover} aria-label="Close venue details" aria-describedby="map-selected-heading">×</button>
						</div>
						<div className="map-selected-content venue-list">
							{selectedGroup.entries.map(({ venue, type }) => (
								<div key={`${type}-${venue.id}`}>
									<p className="map-venue-category">{venueTypeLabels[type]}</p>
									{renderVenueCard(venue, type)}
								</div>
							))}
						</div>
					</section>
				)}
			</div>
			{!groups.length && <p className="category-empty">No venues with valid map coordinates. Use list view to review the results.</p>}
		</div>
	);
}