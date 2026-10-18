"use client";

import { LocateFixed, MapPinOff } from "lucide-react";
import type { Fix } from "@/lib/location";
import { requestLocation, useLocation } from "@/lib/location";
import { cn } from "cn";

export function ReportLoc({ compact = false, onGranted }: { compact?: boolean; onGranted?: (fix: Fix) => void }) {
  const location = useLocation();
  const fix = location.status === "on" ? location.fix : null;
  const label = fix
    ? `Location on · ${Math.max(1, Math.round(fix.accuracy))} m`
    : location.status === "denied"
      ? "Location off"
      : "Use my location";
  return (
    <button
      type="button"
      onClick={() => {
        void requestLocation().then((next) => {
          if (next) onGranted?.(next);
        });
      }}
      className={cn(
        "inline-flex min-h-12 items-center gap-2 rounded-full bg-ink/85 px-3 text-sm font-semibold ring-1 ring-white/20",
        fix ? "text-safe" : "text-warning",
      )}
    >
      {fix ? <LocateFixed className="size-5 shrink-0" aria-hidden /> : <MapPinOff className="size-5 shrink-0" aria-hidden />}
      {compact ? <span className="sr-only">{label}</span> : label}
    </button>
  );
}
