"use client";

import { useEffect, useRef, useState } from "react";
import type { LayerGroup, Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";
import { hazardCentroid, VIEWS } from "@/lib/scenarios";
import { PUGET_BOUNDS } from "@/lib/seattle";
import { resourceSentence, resourceTone, roadSentence, roadTone } from "@/lib/status";
import type { Hazard, Person, Resource, Road, ScenarioId } from "@/lib/types";

type Tone = "danger" | "warning" | "safe" | "neutral";

const TONE: Record<Tone, string> = {
  danger: "#ff5c4d",
  warning: "#f0a202",
  safe: "#3dcb86",
  neutral: "#9aa39c",
};

const DROP = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" fill="none" stroke="#0c1214" stroke-width="2.2" stroke-linejoin="round"/></svg>`;
const CLOUD = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 18h10a4 4 0 0 0 .4-8 6 6 0 0 0-11.5-1.5A3.5 3.5 0 0 0 7 18z" fill="none" stroke="#0c1214" stroke-width="2" stroke-linejoin="round"/></svg>`;
const HOUSE = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 11.5 12 5l8 6.5V20H4z" fill="none" stroke="#0c1214" stroke-width="2" stroke-linejoin="round"/><path d="M10 20v-6h4v6" fill="none" stroke="#0c1214" stroke-width="2"/></svg>`;
const PLUS = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 6v12M6 12h12" fill="none" stroke="#0c1214" stroke-width="2.4" stroke-linecap="round"/></svg>`;
const BOX = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M3 8l9-4 9 4-9 4zM3 8v8l9 4 9-4V8M12 12v8" fill="none" stroke="#0c1214" stroke-width="2" stroke-linejoin="round"/></svg>`;
const BAR = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12h14" fill="none" stroke="#0c1214" stroke-width="2.6" stroke-linecap="round"/></svg>`;

export type MapApi = {
  zoomIn: () => void;
  zoomOut: () => void;
  locate: () => void;
};

export type MapPicture = {
  scenario: ScenarioId;
  hazards: Hazard[];
  resources: Resource[];
  roads: Road[];
  people: Person[];
};

type LeafletNS = typeof import("leaflet");

async function loadLeaflet(): Promise<LeafletNS | null> {
  const imported = (await import("leaflet")) as LeafletNS & { default?: LeafletNS };
  if (typeof imported.map === "function") return imported;
  return imported.default ?? null;
}

export function OpsMap({
  picture,
  region,
  fitPoints,
  user,
  focus,
  layers,
  selectedId,
  highContrast,
  reducedMotion,
  onSelect,
  onApi,
  onTileProblem,
  onLocateError,
}: {
  picture: MapPicture;
  region: "puget" | "oakland";
  fitPoints: [number, number][];
  user: { lat: number; lon: number } | null;
  focus: { lat: number; lon: number; at: number } | null;
  layers: { hazards: boolean; resources: boolean; roads: boolean; people: boolean };
  selectedId: string | null;
  highContrast: boolean;
  reducedMotion: boolean;
  onSelect: (id: string | null) => void;
  onApi: (api: MapApi) => void;
  onTileProblem: () => void;
  onLocateError: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const groups = useRef<Record<string, LayerGroup> | null>(null);
  const panes = useRef<Record<string, HTMLElement> | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const you = useRef<{ remove: () => void } | null>(null);
  const lastScenario = useRef<ScenarioId | null>(null);
  const fitted = useRef(false);
  const lastFocus = useRef(0);
  const [ready, setReady] = useState(false);
  const data = useRef({ picture, region, fitPoints, user, focus, selectedId, highContrast, reducedMotion, onSelect, onTileProblem, onLocateError, onApi });

  useEffect(() => {
    data.current = { picture, region, fitPoints, user, focus, selectedId, highContrast, reducedMotion, onSelect, onTileProblem, onLocateError, onApi };
  }, [picture, region, fitPoints, user, focus, selectedId, highContrast, reducedMotion, onSelect, onTileProblem, onLocateError, onApi]);

  useEffect(() => {
    let cancelled = false;

    async function mount() {
      const L = await loadLeaflet();
      if (!L || cancelled || !host.current) return;

      const puget = data.current.region === "puget";
      const map = L.map(host.current, {
        zoomControl: false,
        attributionControl: true,
        minZoom: puget ? 10 : 13,
        maxZoom: 18,
        maxBounds: puget
          ? L.latLngBounds(PUGET_BOUNDS[0], PUGET_BOUNDS[1])
          : L.latLngBounds([37.74, -122.42], [37.9, -122.2]),
        maxBoundsViscosity: 0.85,
      });
      mapRef.current = map;
      if (puget) map.setView([47.61, -122.33], 11);

      const tiles = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
        {
          attribution:
            'Tiles &copy; Esri &mdash; Esri, TomTom, Garmin, FAO, NOAA, USGS, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          maxZoom: 18,
          maxNativeZoom: 16,
        },
      ).addTo(map);
      tiles.on("tileerror", () => data.current.onTileProblem());

      const createdPanes: Record<string, HTMLElement> = {};
      const createdGroups: Record<string, LayerGroup> = {};
      (["people", "hazards", "resources", "roads"] as const).forEach((name, index) => {
        const pane = map.createPane(name);
        pane.style.zIndex = String(400 + index * 10);
        createdPanes[name] = pane;
        createdGroups[name] = L.layerGroup().addTo(map);
      });
      panes.current = createdPanes;
      groups.current = createdGroups;

      map.on("click", () => data.current.onSelect(null));
      map.on("locationerror", () => data.current.onLocateError());
      let you: { remove: () => void } | null = null;
      map.on("locationfound", (event) => {
        you?.remove();
        you = L.circleMarker(event.latlng, {
          radius: 8,
          color: "#f4f1ea",
          weight: 2,
          fillColor: "#3dcb86",
          fillOpacity: 0.95,
        }).addTo(map);
      });

      data.current.onApi({
        zoomIn: () => mapRef.current?.zoomIn(),
        zoomOut: () => mapRef.current?.zoomOut(),
        locate: () => mapRef.current?.locate({ setView: true, maxZoom: 16 }),
      });

      if (!cancelled) setReady(true);
    }

    void mount();
    return () => {
      cancelled = true;
      setReady(false);
      mapRef.current?.remove();
      mapRef.current = null;
      groups.current = null;
      panes.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;

    async function redraw() {
      const L = await loadLeaflet();
      const map = mapRef.current;
      const layerGroups = groups.current;
      if (!L || !map || !layerGroups || cancelled) return;

      const snap = data.current;
      if (snap.region === "oakland" && lastScenario.current !== snap.picture.scenario) {
        seen.current = null;
        const view = VIEWS[snap.picture.scenario];
        if (lastScenario.current == null || snap.reducedMotion) map.setView(view.center, view.zoom);
        else map.flyTo(view.center, view.zoom, { duration: 0.45 });
        lastScenario.current = snap.picture.scenario;
      }

      layerGroups.people?.clearLayers();
      layerGroups.hazards?.clearLayers();
      layerGroups.resources?.clearLayers();
      layerGroups.roads?.clearLayers();

      const nextIds = new Set<string>();
      const place = (
        id: string,
        point: [number, number],
        label: string,
        svg: string,
        color: string,
        pane: "hazards" | "resources" | "roads",
        low: boolean,
        shape: "round" | "diamond",
      ) => {
        const fresh = seen.current != null && !seen.current.has(id);
        nextIds.add(id);
        const button = document.createElement("button");
        button.type = "button";
        button.className = [
          "marker-btn",
          low && !snap.highContrast ? "marker-low" : "",
          low ? "dashed" : "",
          snap.selectedId === id ? "is-selected" : "",
          fresh ? "marker-enter" : "",
        ]
          .filter(Boolean)
          .join(" ");
        button.setAttribute("aria-label", label);
        const face = document.createElement("span");
        face.className = `marker-face ${shape === "diamond" ? "diamond" : "rounded"}`;
        face.style.background = color;
        face.innerHTML = svg;
        button.appendChild(face);
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          data.current.onSelect(id);
        });
        const marker = L.marker(point, {
          pane,
          keyboard: false,
          icon: L.divIcon({
            html: button,
            className: "sky-divicon",
            iconSize: [44, 44],
            iconAnchor: [22, 22],
          }),
        });
        marker.on("click", (event) => {
          L.DomEvent.stopPropagation(event);
          data.current.onSelect(id);
        });
        marker.addTo(layerGroups[pane]!);
      };

      snap.picture.people.forEach((person) => {
        L.circleMarker(person.point, {
          pane: "people",
          radius: 4,
          color: "#d5ddd6",
          weight: 1,
          opacity: snap.highContrast ? 0.9 : 0.35,
          fillColor: "#d5ddd6",
          fillOpacity: snap.highContrast ? 0.7 : 0.22,
          interactive: false,
        }).addTo(layerGroups.people!);
      });

      snap.picture.hazards.forEach((hazard) => {
        const color = TONE[hazard.severity];
        const low = hazard.confidence === "low";
        const faded = low && !snap.highContrast;
        if (hazard.polygon) {
          L.polygon(hazard.polygon, {
            pane: "hazards",
            color,
            weight: 2,
            opacity: faded ? 0.45 : 0.95,
            fillColor: color,
            fillOpacity: faded ? 0.12 : 0.28,
            dashArray: low ? "6 6" : undefined,
          })
            .on("click", (event) => {
              L.DomEvent.stopPropagation(event);
              data.current.onSelect(hazard.id);
            })
            .addTo(layerGroups.hazards!);
        }
        if (hazard.point && hazard.radiusM) {
          L.circle(hazard.point, {
            pane: "hazards",
            radius: hazard.radiusM,
            color,
            weight: 2,
            opacity: faded ? 0.5 : 0.9,
            fillColor: color,
            fillOpacity: faded ? 0.1 : 0.22,
            dashArray: "6 6",
          })
            .on("click", (event) => {
              L.DomEvent.stopPropagation(event);
              data.current.onSelect(hazard.id);
            })
            .addTo(layerGroups.hazards!);
        }
        const icon = hazard.id.startsWith("smoke") ? CLOUD : hazard.id === "flood-debris" ? BAR : DROP;
        place(
          hazard.id,
          hazardCentroid(hazard),
          `${hazard.name}. ${hazard.severity === "danger" ? "Danger" : "Warning"}. ${hazard.confidence} confidence.`,
          icon,
          color,
          "hazards",
          low,
          "round",
        );
      });

      snap.picture.resources.forEach((resource) => {
        place(
          resource.id,
          resource.point,
          `${resource.name}. ${resourceSentence(resource)}. ${resource.confidence} confidence.`,
          resource.kind === "medical" ? PLUS : resource.kind === "supply" ? BOX : HOUSE,
          TONE[resourceTone(resource.status)],
          "resources",
          resource.confidence === "low",
          "round",
        );
      });

      snap.picture.roads.forEach((road) => {
        place(
          road.id,
          road.point,
          `${road.name}. ${roadSentence(road.status)}. ${road.confidence} confidence.`,
          BAR,
          TONE[roadTone(road.status)],
          "roads",
          road.confidence === "low",
          "diamond",
        );
      });

      you.current?.remove();
      you.current = null;
      if (snap.user) {
        you.current = L.circleMarker([snap.user.lat, snap.user.lon], {
          radius: 8,
          color: "#f4f1ea",
          weight: 2,
          fillColor: "#3dcb86",
          fillOpacity: 0.95,
          interactive: false,
        }).addTo(map);
      }

      seen.current = nextIds;
    }

    void redraw();
    return () => {
      cancelled = true;
    };
  }, [ready, picture, selectedId, highContrast, reducedMotion, user, region]);

  useEffect(() => {
    if (!ready || region !== "puget" || fitPoints.length < 2 || fitted.current) return;
    let cancelled = false;
    void loadLeaflet().then((L) => {
      const map = mapRef.current;
      if (!L || !map || cancelled) return;
      map.fitBounds(L.latLngBounds(fitPoints), { padding: [36, 36], maxZoom: 14 });
      fitted.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, [ready, region, fitPoints]);

  useEffect(() => {
    if (!ready || !focus || focus.at === lastFocus.current) return;
    lastFocus.current = focus.at;
    mapRef.current?.setView([focus.lat, focus.lon], Math.max(mapRef.current.getZoom(), 14), {
      animate: !reducedMotion,
    });
  }, [ready, focus, reducedMotion]);

  useEffect(() => {
    const current = panes.current;
    if (!current) return;
    (["hazards", "resources", "roads", "people"] as const).forEach((key) => {
      const pane = current[key];
      if (!pane) return;
      const on = layers[key];
      pane.style.transition = reducedMotion ? "none" : "opacity 160ms linear";
      pane.style.opacity = on ? "1" : "0";
      pane.style.pointerEvents = on ? "auto" : "none";
      if (on) pane.removeAttribute("inert");
      else pane.setAttribute("inert", "");
    });
  }, [layers, reducedMotion, ready]);

  return <div ref={host} className="relative z-0 h-full w-full" />;
}
