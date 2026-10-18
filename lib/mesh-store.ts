"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { Fix } from "@/lib/location";
import { SEATTLE_HOME } from "@/lib/seattle";

export const REPORT_KINDS = ["ROAD BROKEN", "FIRE", "SAFE PLACE", "FLOOD", "OTHER"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export type MeshMessage = {
  id: string;
  type: "msg" | "report";
  from: string;
  to: string | null;
  text: string;
  ts: number;
  hops: number;
  lat?: number;
  lon?: number;
  accuracy?: number;
  kind?: ReportKind;
  photoRef?: string;
  label?: string;
  shield: boolean;
  local: boolean;
  accepted: boolean;
};

export type Plume = { id: string; polygon: [number, number][] };
export type SatAlert = {
  id: string;
  lat: number;
  lon: number;
  severity: "danger" | "warning" | "safe";
  title: string;
};

export type SatelliteOverlay = {
  plumes: Plume[];
  alerts: SatAlert[];
  aqi: number | null;
  fetchedAt: number;
  live: boolean;
};

type PhotoRecord = { data: string; label: string; uploaded: boolean };

export type GatewayBrief = {
  text: string;
  shelterName: string | null;
  shelterKm: number | null;
  shelterOpen: boolean;
  roads: { name: string; status: string }[];
};

type MeshState = {
  deviceId: string;
  hash: string;
  messages: MeshMessage[];
  photos: Record<string, PhotoRecord>;
  pending: string[];
  satellite: SatelliteOverlay | null;
  brief: GatewayBrief | null;
  syncing: boolean;
  syncedAt: number | null;
  gateway: "idle" | "ok" | "down";
};

const MSG_KEY = "skywatch-mesh-messages";
const PHOTO_KEY = "skywatch-photos";
const PENDING_KEY = "skywatch-pending-upload";
const SAT_KEY = "skywatch-satellite";
const ID_KEY = "skywatch-device-id";

const listeners = new Set<() => void>();
let state: MeshState | null = null;
let booted = false;

function emit() {
  listeners.forEach((listener) => listener());
}

const BLANK: MeshState = {
  deviceId: "",
  hash: "",
  messages: [],
  photos: {},
  pending: [],
  satellite: null,
  brief: null,
  syncing: false,
  syncedAt: null,
  gateway: "idle",
};

function empty(): MeshState {
  return BLANK;
}

async function sha10(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 10);
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function persist() {
  if (!state) return;
  window.localStorage.setItem(MSG_KEY, JSON.stringify(state.messages));
  window.localStorage.setItem(PHOTO_KEY, JSON.stringify(state.photos));
  window.localStorage.setItem(PENDING_KEY, JSON.stringify(state.pending));
  if (state.satellite?.live) window.localStorage.setItem(SAT_KEY, JSON.stringify(state.satellite));
}

export function isShield(from: string) {
  return from.toUpperCase().includes("SKYWATCH-CORE");
}

function kindFromPhoto(value: unknown): ReportKind | undefined {
  if (typeof value !== "string") return;
  const key = value.trim().toUpperCase();
  if (key === "FIRE") return "FIRE";
  if (key === "FLOOD") return "FLOOD";
  if (key === "ROAD" || key === "ROAD BROKEN") return "ROAD BROKEN";
  if (key === "SAFE" || key === "SAFE PLACE") return "SAFE PLACE";
  if (key === "OTHER") return "OTHER";
  return;
}

function asMessage(value: unknown, local: boolean): MeshMessage | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<MeshMessage> & { photoKind?: string };
  if (typeof item.id !== "string" || typeof item.text !== "string") return null;
  const from = typeof item.from === "string" ? item.from : "neighbor";
  const kind = REPORT_KINDS.find((entry) => entry === item.kind || entry === item.label) || kindFromPhoto(item.photoKind);
  return {
    id: item.id,
    type: item.type === "report" || kind ? "report" : "msg",
    from,
    to: typeof item.to === "string" ? item.to : null,
    text: item.text.slice(0, 280),
    ts: typeof item.ts === "number" ? item.ts : Date.now(),
    hops: typeof item.hops === "number" ? item.hops : 0,
    lat: typeof item.lat === "number" ? item.lat : undefined,
    lon: typeof item.lon === "number" ? item.lon : undefined,
    accuracy: typeof item.accuracy === "number" ? item.accuracy : undefined,
    kind,
    photoRef: typeof item.photoRef === "string" ? item.photoRef : undefined,
    label: typeof item.label === "string" ? item.label : kind,
    shield: isShield(from),
    local,
    accepted: !local,
  };
}

function ensure(): MeshState {
  if (state) return state;
  const deviceId = window.localStorage.getItem(ID_KEY) || crypto.randomUUID();
  window.localStorage.setItem(ID_KEY, deviceId);
  state = {
    ...empty(),
    deviceId,
    messages: readJson<MeshMessage[]>(MSG_KEY, []),
    photos: readJson<Record<string, PhotoRecord>>(PHOTO_KEY, {}),
    pending: readJson<string[]>(PENDING_KEY, []),
    satellite: (() => {
      const stored = readJson<SatelliteOverlay | null>(SAT_KEY, null);
      if (stored?.live) return stored;
      window.localStorage.removeItem(SAT_KEY);
      return null;
    })(),
  };
  void sha10(deviceId).then((hash) => {
    if (!state) return;
    state = { ...state, hash };
    emit();
  });
  return state;
}

export function subscribeMesh(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readMesh() {
  return state ?? BLANK;
}

export function useMesh() {
  const value = useSyncExternalStore(subscribeMesh, readMesh, empty);
  useEffect(() => {
    if (booted) return;
    booted = true;
    ensure();
    emit();
  }, []);
  return value;
}

export function myHash() {
  return ensure().hash;
}

function upsert(message: MeshMessage) {
  const current = ensure();
  const index = current.messages.findIndex((item) => item.id === message.id);
  const messages = current.messages.slice();
  if (index >= 0) messages[index] = { ...messages[index], ...message, local: messages[index].local && message.local };
  else messages.push(message);
  messages.sort((a, b) => a.ts - b.ts);
  state = { ...current, messages };
  persist();
  emit();
}

export async function sendMesh(input: {
  text: string;
  to?: string | null;
  kind?: ReportKind;
  photo?: { data: string; label: string };
  fix: Fix | null;
}) {
  const current = ensure();
  const hash = current.hash || (await sha10(current.deviceId));
  const photoRef = input.photo ? crypto.randomUUID() : undefined;
  const message: MeshMessage = {
    id: `mp-${crypto.randomUUID().slice(0, 12)}`,
    type: input.photo || input.kind ? "report" : "msg",
    from: hash,
    to: input.to ?? null,
    text: input.text.trim().slice(0, 280),
    ts: Date.now(),
    hops: 0,
    lat: input.fix?.lat,
    lon: input.fix?.lon,
    accuracy: input.fix?.accuracy,
    kind: input.kind,
    photoRef,
    label: input.photo?.label || input.kind,
    shield: false,
    local: true,
    accepted: false,
  };
  if (photoRef && input.photo) {
    const photos = { ...current.photos, [photoRef]: { data: input.photo.data, label: input.photo.label, uploaded: false } };
    const pending = current.pending.concat(photoRef);
    state = { ...ensure(), hash, photos, pending };
  } else {
    state = { ...ensure(), hash };
  }
  upsert(message);
  return message;
}

function readSatellite(value: unknown, live: boolean): SatelliteOverlay | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SatelliteOverlay>;
  const plumes = Array.isArray(raw.plumes)
    ? raw.plumes.flatMap((plume) => {
        if (!plume || typeof plume !== "object") return [];
        const polygon = (plume as Plume).polygon;
        if (!Array.isArray(polygon) || polygon.length < 3) return [];
        return [{ id: String((plume as Plume).id || crypto.randomUUID()), polygon }];
      })
    : [];
  const alerts = Array.isArray(raw.alerts)
    ? raw.alerts.flatMap((alert) => {
        if (!alert || typeof alert !== "object") return [];
        const item = alert as SatAlert;
        if (typeof item.lat !== "number" || typeof item.lon !== "number") return [];
        const severity: SatAlert["severity"] =
          item.severity === "danger" || item.severity === "safe" || item.severity === "warning" ? item.severity : "warning";
        return [{ id: String(item.id || crypto.randomUUID()), lat: item.lat, lon: item.lon, severity, title: String(item.title || "Satellite alert") }];
      })
    : [];
  if (!plumes.length && !alerts.length && typeof raw.aqi !== "number") return null;
  return {
    plumes,
    alerts,
    aqi: typeof raw.aqi === "number" ? raw.aqi : null,
    fetchedAt: typeof raw.fetchedAt === "number" ? raw.fetchedAt : Date.now(),
    live,
  };
}

export function rememberSatellite(overlay: SatelliteOverlay) {
  state = { ...ensure(), satellite: overlay };
  persist();
  emit();
}

export async function syncMesh(fix: Fix | null) {
  const current = ensure();
  if (current.syncing) return null;
  const hash = current.hash || (await sha10(current.deviceId));
  state = { ...ensure(), hash, syncing: true };
  emit();
  const outgoing = state.messages.filter((message) => message.local);
  try {
    const response = await fetch("/api/mesh/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: state.deviceId,
        lat: fix?.lat ?? SEATTLE_HOME[0],
        lon: fix?.lon ?? SEATTLE_HOME[1],
        accuracy: fix?.accuracy,
        packets: outgoing.map((message) => ({
          id: message.id,
          type: message.type,
          from: message.from,
          to: message.to,
          text: message.text,
          ts: message.ts,
          hops: message.hops,
          lat: message.lat,
          lon: message.lon,
          accuracy: message.accuracy,
          kind: message.kind,
          photoRef: message.photoRef,
          label: message.label,
        })),
      }),
    });
    const data = (await response.json()) as {
      rejectedIds?: string[];
      bundle?: {
        messages?: unknown[];
        lang?: string;
        byPhone?: { lang?: string };
        brief?: { lang?: string; text?: string };
        nearestVerifiedShelter?: { name?: string; distanceKm?: number; status?: string };
        blockedRoads?: unknown[];
      };
      satellite?: unknown;
      lang?: string;
    };
    if (!response.ok) throw new Error("sync");
    const rejected = new Set(data.rejectedIds || []);
    const messages = ensure().messages.map((message) =>
      message.local ? { ...message, accepted: !rejected.has(message.id) } : message,
    );
    (data.bundle?.messages || []).forEach((item) => {
      const message = asMessage(item, false);
      if (!message) return;
      const index = messages.findIndex((entry) => entry.id === message.id);
      if (index >= 0) messages[index] = { ...messages[index], ...message, local: false, accepted: true };
      else messages.push(message);
    });
    messages.sort((a, b) => a.ts - b.ts);
    const satellite = readSatellite(data.satellite, true);
    const lang = data.lang || data.bundle?.lang || data.bundle?.byPhone?.lang || data.bundle?.brief?.lang || null;
    const shelter = data.bundle?.nearestVerifiedShelter;
    const brief: GatewayBrief | null = data.bundle
      ? {
          text: data.bundle.brief?.text || "",
          shelterName: shelter?.name || null,
          shelterKm: typeof shelter?.distanceKm === "number" ? shelter.distanceKm : null,
          shelterOpen: shelter?.status === "open",
          roads: Array.isArray(data.bundle.blockedRoads) ? data.bundle.blockedRoads.flatMap((road) => {
            if (!road || typeof road !== "object") return [];
            const item = road as { name?: string; status?: string };
            return typeof item.name === "string" ? [{ name: item.name, status: item.status || "closed" }] : [];
          }).slice(0, 2) : [],
        }
      : ensure().brief;
    state = {
      ...ensure(),
      messages,
      satellite: satellite || ensure().satellite,
      brief,
      syncing: false,
      syncedAt: Date.now(),
      gateway: "ok",
    };
    persist();
    emit();
    await flushPhotos();
    return typeof lang === "string" ? lang : null;
  } catch {
    state = { ...ensure(), syncing: false, gateway: "down" };
    emit();
    return null;
  }
}

async function flushPhotos() {
  const current = ensure();
  for (const photoRef of current.pending) {
    const photo = current.photos[photoRef];
    if (!photo || photo.uploaded) continue;
    try {
      const response = await fetch("/api/mesh/photo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: current.deviceId,
          photoRef,
          data: photo.data,
          label: photo.label,
        }),
      });
      if (!response.ok) continue;
      const photos = { ...ensure().photos, [photoRef]: { ...photo, uploaded: true } };
      const pending = ensure().pending.filter((item) => item !== photoRef);
      state = { ...ensure(), photos, pending };
      persist();
      emit();
    } catch {
      /* Keep the bytes queued until a gateway accepts them. */
    }
  }
}

export function sampleSatellite(center: [number, number]): SatelliteOverlay {
  const [lat, lon] = center;
  return {
    plumes: [
      {
        id: "sample-plume",
        polygon: [
          [lat + 0.04, lon - 0.05],
          [lat + 0.05, lon + 0.04],
          [lat - 0.02, lon + 0.06],
          [lat - 0.05, lon - 0.02],
        ],
      },
    ],
    alerts: [{ id: "sample-alert", lat: lat + 0.01, lon: lon + 0.01, severity: "warning", title: "Smoke" }],
    aqi: 164,
    fetchedAt: Date.now(),
    live: false,
  };
}
