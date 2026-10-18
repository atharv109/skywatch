"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { Fix } from "@/lib/location";
import type { Hazard, Person, Resource, Road } from "@/lib/types";

export type SituationView = {
  status: "idle" | "loading" | "ready" | "error";
  title: string;
  source: "backend" | "seattle" | "";
  hazards: Hazard[];
  resources: Resource[];
  roads: Road[];
  people: Person[];
  fitPoints: [number, number][];
  lang: string | null;
};

const EMPTY: SituationView = {
  status: "idle",
  title: "Seattle",
  source: "",
  hazards: [],
  resources: [],
  roads: [],
  people: [],
  fitPoints: [],
  lang: null,
};

let view: SituationView = EMPTY;
let key = "";
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function subscribeSituation(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readSituation() {
  return view;
}

function pointsOf(situation: SituationView): [number, number][] {
  const points: [number, number][] = [];
  situation.hazards.forEach((hazard) => {
    hazard.polygon?.forEach((point) => points.push(point));
    if (hazard.point) points.push(hazard.point);
  });
  situation.resources.forEach((resource) => points.push(resource.point));
  situation.roads.forEach((road) => points.push(road.point));
  return points;
}

export function loadSituation(fix: Fix | null) {
  const nextKey = fix ? `${fix.lat.toFixed(3)},${fix.lon.toFixed(3)}` : "seattle";
  if (key === nextKey && (view.status === "loading" || view.status === "ready")) return;
  key = nextKey;
  view = { ...view, status: "loading" };
  emit();
  const params = new URLSearchParams();
  if (fix) {
    params.set("lat", String(fix.lat));
    params.set("lon", String(fix.lon));
  }
  void fetch(`/api/situation?${params.toString()}`, { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error("situation");
      return (await response.json()) as Partial<SituationView> & { title?: string };
    })
    .then((data) => {
      if (key !== nextKey) return;
      const next: SituationView = {
        status: "ready",
        title: data.title || "Seattle",
        source: data.source === "backend" ? "backend" : "seattle",
        hazards: Array.isArray(data.hazards) ? data.hazards : [],
        resources: Array.isArray(data.resources) ? data.resources : [],
        roads: Array.isArray(data.roads) ? data.roads : [],
        people: Array.isArray(data.people) ? data.people : [],
        fitPoints: [],
        lang: typeof data.lang === "string" ? data.lang : null,
      };
      next.fitPoints = pointsOf(next);
      view = next;
      emit();
    })
    .catch(() => {
      if (key !== nextKey) return;
      view = { ...EMPTY, status: "error", title: "Seattle" };
      emit();
    });
}

export function useSituation(enabled: boolean, fix: Fix | null) {
  const snapshot = useSyncExternalStore(subscribeSituation, readSituation, () => EMPTY);
  useEffect(() => {
    if (enabled) loadSituation(fix);
  }, [enabled, fix]);
  return snapshot;
}
