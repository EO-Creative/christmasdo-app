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

export function ResultsMap<TVenue extends MapVenue>({ venues, center, renderVenueCard }: ResultsMapProps<TVenue>) {
	const mapElement = useRef<HTMLDivElement>(null);
	const mapRef = useRef<L.Map | null>(null);
	const markerLayerRef = useRef<L.LayerGroup | null>(null);
	const [selectedGroupKey, setSelectedGroupKey] = useState("");
	const groups = useMemo(() => groupMapVenues(venues), [venues]);
	const selectedGroup = groups.find((group) => group.key === selectedGroupKey);

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
		window.requestAnimationFrame(() => map.invalidateSize());

		return () => {
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
		for (const group of groups) {
			const names = [...new Set(group.entries.map(({ venue }) => venue.tags.name || "Unnamed venue"))];
			const title = `${names.join(", ")} · ${group.categoryTypes.map((type) => venueTypeLabels[type]).join(", ")}`;
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
			L.marker([group.lat, group.lon], { icon, keyboard: true, title, alt: title })
				.addTo(markerLayer)
				.bindTooltip(tooltip)
				.on("click", () => setSelectedGroupKey(group.key));
		}

		const bounds = L.latLngBounds([[center.lat, center.lon]]);
		for (const { venue } of venues) {
			const coordinates = getVenueCoordinates(venue);
			if (coordinates) bounds.extend([coordinates.lat, coordinates.lon]);
		}
		if (bounds.getNorthEast().equals(bounds.getSouthWest())) map.setView([center.lat, center.lon], 13);
		else map.fitBounds(bounds.pad(0.18), { maxZoom: 14 });
	}, [center, groups, venues]);
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
			<p className="map-help">Select a marker to see venues at that location. Map tiles are provided by OpenStreetMap.</p>
			<div className="results-map" ref={mapElement} role="region" aria-label="Interactive map of venue results" />
			{!groups.length && <p className="category-empty">No venues with valid map coordinates. Use list view to review the results.</p>}
			{selectedGroup && (
				<section className="map-selected-venues" aria-live="polite" aria-label="Venues at selected map marker">
					<h3>{selectedGroup.entries[0].venue.tags.name || "Venues at this location"}</h3>
					<div className="venue-list">
						{selectedGroup.entries.map(({ venue, type }) => renderVenueCard(venue, type))}
					</div>
				</section>
			)}
		</div>
	);
}