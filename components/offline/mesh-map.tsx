"use client";

import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import type { SatelliteOverlay } from "@/lib/mesh-store";

export function MeshMap({
  satellite,
  self,
}: {
  satellite: SatelliteOverlay;
  self: { lat: number; lon: number } | null;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let map: { remove: () => void } | null = null;
    let cancelled = false;
    void import("leaflet").then((imported) => {
      if (cancelled || !host.current) return;
      const L = typeof imported.map === "function" ? imported : imported.default;
      if (!L) return;
      const next = L.map(host.current, { zoomControl: false, attributionControl: false, minZoom: 11, maxZoom: 16 });
      map = next;
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 16,
        maxNativeZoom: 16,
      }).addTo(next);
      const points: [number, number][] = [];
      satellite.plumes.forEach((plume) => {
        L.polygon(plume.polygon, { color: "#ff5c4d", weight: 1, fillColor: "#ff5c4d", fillOpacity: 0.28 }).addTo(next);
        plume.polygon.forEach((point) => points.push(point));
      });
      satellite.alerts.forEach((alert) => {
        const color = alert.severity === "danger" ? "#ff5c4d" : alert.severity === "safe" ? "#3dcb86" : "#f0a202";
        L.circleMarker([alert.lat, alert.lon], { radius: 7, color, weight: 2, fillColor: color, fillOpacity: 0.9 })
          .bindTooltip(alert.title, { permanent: false })
          .addTo(next);
        points.push([alert.lat, alert.lon]);
      });
      if (self) {
        L.circleMarker([self.lat, self.lon], { radius: 6, color: "#f4f1ea", weight: 2, fillColor: "#3dcb86", fillOpacity: 1 }).addTo(next);
        points.push([self.lat, self.lon]);
      }
      if (points.length) next.fitBounds(L.latLngBounds(points), { padding: [16, 16], maxZoom: 13 });
      else next.setView([47.6, -122.33], 12);
    });
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [satellite, self]);

  return (
    <div className="h-32 w-full overflow-hidden rounded-xl">
      <div ref={host} className="relative z-0 h-full w-full" />
    </div>
  );
}
