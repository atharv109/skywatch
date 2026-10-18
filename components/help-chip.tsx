"use client";

import { CircleHelp } from "lucide-react";
import { useState } from "react";
import { DetailSheet } from "@/components/bottom-sheet";

export function HelpChip({ title, lines }: { title: string; lines: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="inline-flex size-12 items-center justify-center rounded-full bg-ink/85 text-paper ring-1 ring-white/20"
        aria-label="How this screen works"
        onClick={() => setOpen(true)}
      >
        <CircleHelp className="size-5" aria-hidden />
      </button>
      <DetailSheet open={open} title={title} onClose={() => setOpen(false)} z={60}>
        <h2 className="text-2xl font-bold">{title}</h2>
        <ul className="mt-4 flex flex-col gap-3">
          {lines.map((line) => (
            <li key={line} className="text-lg leading-snug">
              {line}
            </li>
          ))}
        </ul>
      </DetailSheet>
    </>
  );
}
