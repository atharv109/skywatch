"use client";

import { useRef, useState } from "react";
import { cn } from "cn";

export function Tray({
  open,
  onOpenChange,
  label,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  children: React.ReactNode;
}) {
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(false);
  const startY = useRef(0);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = true;
    setDragging(true);
    startY.current = event.clientY;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* The gesture still finishes if this input cannot capture. */
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    const next = event.clientY - startY.current;
    setDrag(open ? Math.max(-24, next) : Math.min(24, next));
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    const delta = event.clientY - startY.current;
    dragRef.current = false;
    setDragging(false);
    setDrag(0);
    if (Math.abs(delta) < 10) onOpenChange(!open);
    else if (delta < -24) onOpenChange(true);
    else if (delta > 24) onOpenChange(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpenChange(!open);
    }
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-start">
      <section
        className="sheet-shadow pointer-events-auto w-full rounded-t-2xl border border-b-0 border-white/10 bg-ink/95 backdrop-blur-md md:ms-3 md:max-w-md"
        style={{
          height: "min(72dvh, 640px)",
          transform: `translate3d(0, calc(${open ? "0px" : "100% - 4.75rem"} + ${drag}px), 0)`,
          transition: dragging ? "none" : "transform 180ms ease-out",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
        aria-label={label}
        data-expanded={open}
      >
        <div
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={onKeyDown}
          className="flex min-h-[4.75rem] cursor-grab touch-none flex-col items-center justify-center gap-2 px-4 active:bg-white/5"
        >
          <span className="h-1 w-10 rounded-full bg-paper/50" />
          <span className="text-base text-paper">{label}</span>
        </div>
        <div className={cn("h-[calc(100%-4.75rem)] overflow-y-auto px-4 pb-6", !open && "hidden")}>
          {children}
        </div>
      </section>
    </div>
  );
}

export function DetailSheet({
  open,
  title,
  onClose,
  children,
  z = 40,
  scrim = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  z?: number;
  scrim?: boolean;
}) {
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(false);
  const startY = useRef(0);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!open) return;
    dragRef.current = true;
    setDragging(true);
    startY.current = event.clientY;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* The gesture still finishes if this input cannot capture. */
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    setDrag(Math.max(0, event.clientY - startY.current));
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    const delta = event.clientY - startY.current;
    dragRef.current = false;
    setDragging(false);
    setDrag(0);
    if (delta > 48 || Math.abs(delta) < 10) onClose();
  }

  return (
    <>
      {scrim && open ? (
        <button
          type="button"
          aria-label="Close"
          className="fixed inset-0 bg-black/50"
          style={{ zIndex: z - 1 }}
          onClick={onClose}
        />
      ) : null}
      <section
        role="dialog"
        aria-modal={scrim}
        aria-hidden={!open}
        inert={!open}
        aria-label={title}
        className={cn(
          "sheet-shadow fixed inset-x-0 bottom-0 rounded-t-2xl border border-b-0 border-white/10 bg-ink",
          !open && "pointer-events-none",
        )}
        style={{
          zIndex: z,
          transform: open ? `translate3d(0, ${drag}px, 0)` : "translate3d(0, 110%, 0)",
          transition: dragging ? "none" : "transform 180ms ease-out",
          maxHeight: "min(68dvh, 560px)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        <div className="mx-auto w-full md:max-w-md">
          <div
            role="button"
            tabIndex={open ? 0 : -1}
            aria-label="Close"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className="flex min-h-12 touch-none flex-col items-center justify-center active:bg-white/5"
          >
            <span className="h-1 w-10 rounded-full bg-paper/50" />
          </div>
          <div className="max-h-[calc(min(68dvh,560px)-3rem)] overflow-y-auto px-5 pb-6">{children}</div>
        </div>
      </section>
    </>
  );
}
