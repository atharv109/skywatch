"use client";

import { useEffect, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let sim = false;

function readSim() {
  return sim;
}

export function subscribeSim(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: boolean) {
  if (sim === next) return;
  sim = next;
  listeners.forEach((listener) => listener());
}

export function useSimMode() {
  const value = useSyncExternalStore(subscribeSim, readSim, () => false);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search).get("sim") === "1";
    const stored = window.sessionStorage.getItem("skywatch-sim") === "1";
    if (query) window.sessionStorage.setItem("skywatch-sim", "1");
    publish(query || stored);
  }, []);
  return value;
}
