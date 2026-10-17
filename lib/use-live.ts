"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Lang } from "@/lib/i18n";
import { isLang } from "@/lib/i18n";
import { readScenario, subscribeCheckIns, subscribeScenario, readCheckIns } from "@/lib/prefs";
import type { CheckIn, ScenarioId, Snapshot } from "@/lib/types";

function emptySubscribe() {
  return () => {};
}

export function useMounted() {
  return useSyncExternalStore(emptySubscribe, () => true, () => false);
}

export function useOnline() {
  return useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener("online", onStoreChange);
      window.addEventListener("offline", onStoreChange);
      return () => {
        window.removeEventListener("online", onStoreChange);
        window.removeEventListener("offline", onStoreChange);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

export function useClientScenario(): ScenarioId | null {
  return useSyncExternalStore(subscribeScenario, () => readScenario() ?? "flood", () => null);
}

const EMPTY_CHECKINS: Record<string, CheckIn> = {};

export function useCheckIns(isCheckIn: (value: unknown) => value is CheckIn) {
  const raw = useSyncExternalStore(subscribeCheckIns, readCheckIns, () => EMPTY_CHECKINS);
  return useMemo(() => {
    const next: Record<string, CheckIn> = {};
    Object.entries(raw).forEach(([id, value]) => {
      if (isCheckIn(value)) next[id] = value;
    });
    return next;
  }, [raw, isCheckIn]);
}

export function usePreferredLang(): Lang {
  return useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener("storage", onStoreChange);
      return () => window.removeEventListener("storage", onStoreChange);
    },
    () => {
      const value = window.localStorage.getItem("skywatch-lang");
      return isLang(value) ? value : "en";
    },
    () => "en",
  );
}

let deviceKey: string | null = null;

function readDeviceKey() {
  if (deviceKey) return deviceKey;
  const existing = window.localStorage.getItem("skywatch-device-key");
  if (existing) {
    deviceKey = existing;
    return existing;
  }
  deviceKey = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .toUpperCase()
    .padStart(4, "0");
  window.localStorage.setItem("skywatch-device-key", deviceKey);
  return deviceKey;
}

export function useDeviceKey() {
  return useSyncExternalStore(emptySubscribe, readDeviceKey, () => null);
}

let clockAnchor = 0;

function readAnchor() {
  if (!clockAnchor) clockAnchor = Date.now();
  return clockAnchor;
}

export function useClockAnchor() {
  return useSyncExternalStore(emptySubscribe, readAnchor, () => 0);
}

export function useNow(active: boolean) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const start = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(start);
      window.clearInterval(id);
    };
  }, [active]);
  return now;
}

export function useMedia(query: string) {
  return useSyncExternalStore(
    (onStoreChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onStoreChange);
      return () => media.removeEventListener("change", onStoreChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useLiveFeed(scenario: ScenarioId, enabled: boolean) {
  const [link, setLink] = useState<"live" | "reconnecting">("live");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [chipUntil, setChipUntil] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | null = null;
    let poll: number | null = null;
    let stopped = false;
    let first = true;
    let last = "";

    const apply = (data: Snapshot) => {
      if (data.scenario !== scenario) return;
      const key = `${data.shelterAvailable}|${data.fieldReport}|${data.aqi}`;
      setSnapshot(data);
      setReceivedAt(Date.now());
      if (first) {
        first = false;
        last = key;
        return;
      }
      if (key !== last) {
        last = key;
        setChipUntil(Date.now() + 2500);
      }
    };

    const stopPoll = () => {
      if (poll != null) window.clearInterval(poll);
      poll = null;
    };

    const startPoll = () => {
      if (poll != null) return;
      const run = async () => {
        try {
          const res = await fetch(`/api/situation?scenario=${scenario}`, { cache: "no-store" });
          if (!res.ok) return;
          apply((await res.json()) as Snapshot);
        } catch {
          /* The map stays up while the stream reconnects. */
        }
      };
      void run();
      poll = window.setInterval(run, 8000);
    };

    source = new EventSource(`/api/live?scenario=${scenario}`);
    source.onopen = () => {
      if (stopped) return;
      setLink("live");
      stopPoll();
    };
    source.onmessage = (event) => {
      try {
        apply(JSON.parse(event.data) as Snapshot);
      } catch {
        /* Ignore a bad frame. */
      }
    };
    source.onerror = () => {
      if (stopped) return;
      setLink("reconnecting");
      startPoll();
    };

    return () => {
      stopped = true;
      stopPoll();
      source?.close();
    };
  }, [scenario, enabled]);

  return { link, snapshot, receivedAt, chipUntil };
}
