"use client";

import { useMemo, useState } from "react";
import { useMesh } from "@/lib/mesh-store";

export function PhotoStrip() {
  const mesh = useMesh();
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const photos = useMemo(() => {
    const items = new Map<string, { src: string; label: string }>();
    Object.entries(mesh.photos).forEach(([ref, photo]) => {
      items.set(ref, { src: photo.data, label: photo.label });
    });
    mesh.messages.forEach((message) => {
      if (!message.photoRef || items.has(message.photoRef)) return;
      items.set(message.photoRef, {
        src: `/api/mesh/photo/${encodeURIComponent(message.photoRef)}`,
        label: message.label || message.kind || "Photo report",
      });
    });
    return [...items.entries()];
  }, [mesh.photos, mesh.messages]);
  const visible = photos.filter(([ref]) => !hidden[ref]);
  if (!visible.length) return null;
  return (
    <div className="pointer-events-auto absolute inset-x-0 z-20 px-3" style={{ bottom: "8.25rem" }}>
      <div className="flex gap-2 overflow-x-auto rounded-2xl bg-ink/80 p-2 ring-1 ring-white/10" aria-label="Photo reports">
        {visible.map(([ref, photo]) => (
          <a key={ref} href={photo.src} className="block shrink-0" aria-label={photo.label}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.src}
              alt={photo.label}
              className="size-16 rounded-lg object-cover"
              onError={() => setHidden((current) => ({ ...current, [ref]: true }))}
            />
          </a>
        ))}
      </div>
    </div>
  );
}
