import { isLang, type Lang } from "@/lib/i18n";
import type { ScenarioId } from "@/lib/types";

const scenarioListeners = new Set<() => void>();

export function subscribeScenario(onStoreChange: () => void) {
  scenarioListeners.add(onStoreChange);
  return () => scenarioListeners.delete(onStoreChange);
}

export function readScenario(): ScenarioId | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem("skywatch-scenario");
  return value === "smoke" || value === "flood" ? value : null;
}

export function writeScenario(scenario: ScenarioId) {
  window.localStorage.setItem("skywatch-scenario", scenario);
  document.cookie = `skywatch-scenario=${scenario}; path=/; max-age=31536000; samesite=lax`;
  scenarioListeners.forEach((listener) => listener());
}

const langListeners = new Set<() => void>();

export function subscribeLang(onStoreChange: () => void) {
  langListeners.add(onStoreChange);
  return () => langListeners.delete(onStoreChange);
}

export function readLang(): Lang {
  if (typeof window === "undefined") return "en";
  const value = window.localStorage.getItem("skywatch-lang");
  return isLang(value) ? value : "en";
}

export function writeLang(lang: Lang) {
  window.localStorage.setItem("skywatch-lang", lang);
  document.cookie = `skywatch-lang=${lang}; path=/; max-age=31536000; samesite=lax`;
  langListeners.forEach((listener) => listener());
}

const CHECKINS = "skywatch-checkins";
const checkInListeners = new Set<() => void>();
let checkInCache: Record<string, unknown> | null = null;

export function subscribeCheckIns(onStoreChange: () => void) {
  checkInListeners.add(onStoreChange);
  return () => checkInListeners.delete(onStoreChange);
}

export function readCheckIns(): Record<string, unknown> {
  if (checkInCache) return checkInCache;
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(CHECKINS);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    checkInCache = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    checkInCache = {};
  }
  return checkInCache;
}

export function writeCheckIns(value: Record<string, unknown>) {
  checkInCache = value;
  window.sessionStorage.setItem(CHECKINS, JSON.stringify(value));
  checkInListeners.forEach((listener) => listener());
}
