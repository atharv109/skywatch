"use client";

import { useEffect, useSyncExternalStore } from "react";

export type Fix = {
  lat: number;
  lon: number;
  accuracy: number;
  at: number;
};

type LocationState = {
  fix: Fix | null;
  status: "unknown" | "on" | "off" | "denied";
};

const KEY = "skywatch-location";
const listeners = new Set<() => void>();
const UNKNOWN: LocationState = { fix: null, status: "unknown" };
let state: LocationState = UNKNOWN;
let hydrated = false;

function emit() {
  listeners.forEach((listener) => listener());
}

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) {
      state = { fix: null, status: "off" };
      return;
    }
    const parsed = JSON.parse(raw) as Fix;
    if (typeof parsed.lat === "number" && typeof parsed.lon === "number") {
      state = { fix: parsed, status: "on" };
      return;
    }
    state = { fix: null, status: "off" };
  } catch {
    state = { fix: null, status: "off" };
  }
}

function write(next: LocationState) {
  state = next;
  if (next.fix) window.localStorage.setItem(KEY, JSON.stringify(next.fix));
  else window.localStorage.removeItem(KEY);
  emit();
}

export function subscribeLocation(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readLocation(): LocationState {
  return state;
}

export function useLocation() {
  const value = useSyncExternalStore(subscribeLocation, readLocation, () => UNKNOWN);
  useEffect(() => {
    const before = state;
    hydrate();
    if (state !== before) emit();
  }, []);
  return value;
}

export function requestLocation(): Promise<Fix | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      write({ fix: null, status: "off" });
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const fix: Fix = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy: position.coords.accuracy,
          at: Date.now(),
        };
        write({ status: "on", fix });
        resolve(fix);
      },
      () => {
        write({ fix: state.fix, status: "denied" });
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  });
}
