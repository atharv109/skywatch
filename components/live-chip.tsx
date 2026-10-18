"use client";

import { useEffect, useState } from "react";

/** The tiny footer chip that names the live backend this app is served by. */
export function LiveChip() {
  const [state, setState] = useState<{ ok: boolean; host: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      void fetch("/api/health", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error("health"))))
        .then((data: { ok: boolean; origin: string }) => {
          if (cancelled) return;
          setState({ ok: true, host: safeHost(data.origin) });
        })
        .catch(() => {
          if (!cancelled) setState({ ok: false, host: "" });
        });
    };
    read();
    const id = window.setInterval(read, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (!state) return null;
  return (
    <p
      className={cnChip(state.ok)}
      role="status"
      style={{
        position: "fixed",
        left: "0.5rem",
        bottom: "max(0.35rem, env(safe-area-inset-bottom))",
        zIndex: 40,
      }}
    >
      {state.ok ? `LIVE · ${state.host}` : "API unreachable"}
    </p>
  );
}

function safeHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function cnChip(ok: boolean): string {
  return (
    "rounded-full bg-ink/70 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-paper/70 ring-1 ring-white/10 backdrop-blur-sm " +
    (ok ? "" : "text-warning")
  );
}