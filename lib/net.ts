"use client";

import { useSyncExternalStore } from "react";
import { pendingQueueCount, syncMesh } from "@/lib/mesh-store";

/**
 * The AUTO network-mode machine from the reference app.js: window online/offline
 * events + a 5 s /api/health liveness probe drive
 *   Online → Offline   (probe failure / offline event)
 *   Offline → Gateway  (2 of 2 probe OK — auto-sync the whole queue)
 *   Gateway → Online   (sync confirmed by the gateway)
 * and while Online and the queue is non-empty, one silent gateway sync per tick
 * drains queued mesh traffic. A manual pin (override) overrides all of it — the
 * "offline" pin stays dark, "online"/"gateway" force the mode now.
 */
export type NetMode = "online" | "offline" | "gateway";
export type NetOverride = null | NetMode;

export type NetState = {
  mode: NetMode;
  /** null = AUTO-detect; otherwise a manual pin from the offline screen. */
  override: NetOverride;
  /** Transient narration for the status chip (what just happened). */
  note: string;
  syncing: boolean;
};

const listeners = new Set<() => void>();
let net: NetState = { mode: "online", override: null, note: "", syncing: false };
let started = false;
let timer: number | null = null;
let streak = 0; // consecutive /health 200s while offline (flip needs 2 of 2)
let inflight = false; // a /mesh/sync POST mid-flight — don't race it into online

function emit() {
  listeners.forEach((listener) => listener());
}

function snapshot(): NetState {
  return net;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(patch: Partial<NetState>) {
  net = { ...net, ...patch, syncing: inflight };
  emit();
}

async function runSync(): Promise<number> {
  if (inflight) return 0;
  inflight = true;
  set({});
  try {
    const result = await syncMesh(null);
    return result?.ok ? 1 : -1;
  } catch {
    return -1;
  } finally {
    inflight = false;
    set({});
  }
}

export function setNetOverride(override: NetOverride) {
  streak = 0;
  if (override === null) {
    set({ override: null, note: "auto" });
    return;
  }
  if (override === "gateway") {
    set({ override: null, note: "pinned-gateway" });
    void enterGateway(false);
    return;
  }
  if (override === "offline") {
    set({ override: "offline", mode: "offline", note: "pinned-offline" });
    return;
  }
  set({ override: "online", mode: "online", note: "pinned-online" });
  void runSync();
}

async function enterGateway(auto: boolean) {
  streak = 0;
  set({ mode: "gateway", override: null, note: auto ? "signal-found" : "gateway-on-purpose" });
  const outcome = await runSync();
  if (outcome === 1) {
    set({ mode: "online", override: null, note: "back-online" });
  } else {
    set({ mode: "gateway", note: "held" });
  }
}

async function probeHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3500);
    const response = await fetch("/api/health", { cache: "no-store", signal: controller.signal });
    window.clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/** One liveness tick — the whole state machine. */
async function probeTick() {
  if (net.override === "offline") return; // manual "stays dark" pin
  const ok = await probeHealth();
  if (net.mode === "offline") {
    streak = ok ? streak + 1 : 0;
    if (streak >= 2 && net.override === null) void enterGateway(true);
    return;
  }
  if (net.mode === "gateway") {
    // The gateway sync itself decides the flip; a probe failure just holds it.
    return;
  }
  // online: degrade on a failed probe, and drain the queue one sync per tick.
  if (!ok) {
    set({ mode: "offline", override: null, note: "connection-lost" });
    return;
  }
  if (!inflight && pendingQueueCount() > 0) {
    set({ note: "drain" });
    const outcome = await runSync();
    set({
      mode: outcome === 1 ? "online" : "gateway",
      override: null,
      note: outcome === 1 ? "drained" : "drain-hold",
    });
  }
}

function onOnlineEvent() {
  if ((net.mode === "offline" || net.mode === "gateway") && net.override !== "offline") void enterGateway(true);
}

function onOfflineEvent() {
  if (net.mode !== "offline") {
    // A real outage hands control back to AUTO.
    set({ mode: "offline", override: null, note: "connection-lost" });
  }
}

export function startNet() {
  if (started) return;
  started = true;
  window.addEventListener("online", onOnlineEvent);
  window.addEventListener("offline", onOfflineEvent);
  void probeTick();
  timer = window.setInterval(() => void probeTick(), 5000);
}

export function stopNet() {
  if (!started) return;
  started = false;
  window.removeEventListener("online", onOnlineEvent);
  window.removeEventListener("offline", onOfflineEvent);
  if (timer != null) window.clearInterval(timer);
  timer = null;
}

export function useNetMode(): NetState {
  return useSyncExternalStore(subscribe, snapshot, () => net);
}