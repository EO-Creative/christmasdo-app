import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { filterMapVenuesInBounds, groupMapVenues, isCoordinateInBounds, normalizeLongitude, type MapBounds, type MapCoordinates, type MapVenue, type MapVenueEntry, type VenueType } from "./map-utils";

const venueTypeLabels: Record<VenueType, string> = {
	activities: "Activities",
	food: "Food",
	drinks: "Drinks",
};

export interface ResultsMapProps<TVenue extends MapVenue> {
	venues: MapVenueEntry<TVenue>[];
	center: MapCoordinates;
	renderVenueCard: (venue: TVenue, type: VenueType) => ReactNode;
	onViewportChange?: (center: MapCoordinates, bounds: MapBounds) => void;
}

interface MapMarker {
	key: string;
	lat: number;
	lon: number;
	names: string[];
	categoryTypes: VenueType[];
}

function getMapBounds(map: L.Map): MapBounds {
	const bounds = map.getBounds();
	return { south: bounds.getSouth(), north: bounds.getNorth(), west: bounds.getWest(), east: bounds.getEast() };
}

export function ResultsMap<TVenue extends MapVenue>({ venues, center, renderVenueCard, onViewportChange }: ResultsMapProps<TVenue>) {
	const mapElement = useRef<HTMLDivElement>(null);
	const mapRef = useRef<L.Map | null>(null);
	const markerLayerRef = useRef<L.LayerGroup | null>(null);
	const markersRef = useRef(new Map<string, { marker: L.Marker; lat: number; lon: number }>());
	const panelEntriesRef = useRef(new Map<string, HTMLElement>());
	const initialCenter = useRef(center);
	const viewportCallback = useRef(onViewportChange);
	const [bounds, setBounds] = useState<MapBounds | null>(null);
	const [selection, setSelection] = useState<{ key: string } | null>(null);
	const groups = useMemo(() => groupMapVenues(venues), [venues]);
	const visibleGroups = useMemo(() => bounds ? groupMapVenues(filterMapVenuesInBounds(venues, bounds)) : [], [venues, bounds]);
	const markerData = JSON.stringify(groups.map((group) => ({
		key: group.key,
		lat: group.lat,
		lon: group.lon,
		names: [...new Set(group.entries.map(({ venue }) => venue.tags.name || "Unnamed venue"))].sort(),
		categoryTypes: [...group.categoryTypes].sort(),
	})).sort((a, b) => a.key.localeCompare(b.key)));

	useEffect(() => {
		viewportCallback.current = onViewportChange;
	}, [onViewportChange]);

	useEffect(() => {
		if (!mapElement.current) return;

		const map = L.map(mapElement.current, { scrollWheelZoom: false, trackResize: false }).setView([initialCenter.current.lat, initialCenter.current.lon], 13);
		L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
			maxZoom: 19,
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
		}).addTo(map);
		const markerLayer = L.layerGroup().addTo(map);
		mapRef.current = map;
		markerLayerRef.current = markerLayer;
		const markers = markersRef.current;
		let timer: number | undefined;
		let resizing = false;
		const updateViewport = () => {
			const mapCenter = map.getCenter();
			const currentBounds = getMapBounds(map);
			for (const { marker, lat, lon } of markersRef.current.values()) {
				const nearestLon = lon + 360 * Math.round((mapCenter.lng - lon) / 360);
				if (marker.getLatLng().lng !== nearestLon) marker.setLatLng([lat, nearestLon]);
				const element = marker.getElement();
				if (element) element.tabIndex = isCoordinateInBounds({ lat, lon }, currentBounds) ? 0 : -1;
			}
			setBounds(currentBounds);
		};
		const moveStart = () => {
			if (!resizing) window.clearTimeout(timer);
		};
		const moveEnd = () => {
			updateViewport();
			if (resizing) return;
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				const mapCenter = map.getCenter();
				viewportCallback.current?.({ lat: mapCenter.lat, lon: normalizeLongitude(mapCenter.lng) }, getMapBounds(map));
			}, 400);
		};
		map.on("movestart", moveStart);
		map.on("move", updateViewport);
		map.on("moveend", moveEnd);
		const resize = () => {
			resizing = true;
			map.invalidateSize({ pan: false });
			updateViewport();
			resizing = false;
		};
		const observer = new ResizeObserver(resize);
		observer.observe(mapElement.current);
		const frame = window.requestAnimationFrame(resize);
		updateViewport();

		return () => {
			window.clearTimeout(timer);
			window.cancelAnimationFrame(frame);
			observer.disconnect();
			map.remove();
			mapRef.current = null;
			markerLayerRef.current = null;
			markers.clear();
		};
	}, []);

	useEffect(() => {
		const map = mapRef.current;
		const markerLayer = markerLayerRef.current;
		if (!map || !markerLayer) return;

		markerLayer.clearLayers();
		markersRef.current.clear();
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
			const lon = group.lon + 360 * Math.round((map.getCenter().lng - group.lon) / 360);
			const marker = L.marker([group.lat, lon], { icon, keyboard: true, autoPanOnFocus: false, title, alt: title })
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
				element.tabIndex = isCoordinateInBounds({ lat: group.lat, lon: group.lon }, getMapBounds(map)) ? 0 : -1;
			}
			markersRef.current.set(group.key, { marker, lat: group.lat, lon: group.lon });
		}
	}, [markerData]);

	useEffect(() => {
		if (!selection) return;
		const entry = panelEntriesRef.current.get(selection.key);
		if (entry) {
			entry.scrollIntoView({ block: "nearest", inline: "nearest" });
			entry.focus({ preventScroll: true });
		}
	}, [selection]);

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
			<p className="map-help">Move the map to update the visible venues. Select a marker with a click, Enter, or Space to find its cards.</p>
			<div className="results-map-wrapper">
				<div className="results-map" ref={mapElement} role="region" aria-label="Interactive map of venue results" />
				<section className="map-visible-venues" aria-labelledby="map-visible-heading">
					<div className="map-visible-header">
						<h3 id="map-visible-heading">Venues in this map area</h3>
						<p aria-live="polite">{bounds ? `${visibleGroups.reduce((count, group) => count + group.entries.length, 0)} results` : "Loading map…"}</p>
					</div>
					<div className="map-visible-content">
						{bounds && visibleGroups.length === 0 && <p className="category-empty">No venues in this map area. Move or zoom the map to explore.</p>}
						{visibleGroups.map((group) => (
							<div key={group.key} className={`map-location${selection?.key === group.key ? " selected" : ""}`} role="group" tabIndex={-1}
								aria-label={`Venues at ${[...new Set(group.entries.map(({ venue }) => venue.tags.name || "Unnamed venue"))].join(", ")}`}
								ref={(element) => { if (element) panelEntriesRef.current.set(group.key, element); else panelEntriesRef.current.delete(group.key); }}>
								{group.entries.map(({ venue, type }) => (
									<div key={`${type}-${venue.id}`}>
										<p className="map-venue-category">{venueTypeLabels[type]}</p>
										{renderVenueCard(venue, type)}
									</div>
								))}
							</div>
						))}
					</div>
				</section>
			</div>
		</div>
	);
}