"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { HelpChip } from "@/components/help-chip";
import { buttonVariants } from "@/components/ui/button";
import { useOnline } from "@/lib/use-live";
import { cn } from "cn";

type PhotonState = { configured: boolean; display?: string; join?: string };

/**
 * The join screen reads the real Photon state from /api/photon (env-sourced
 * server-side). No number is ever faked: configured → "Text hi to <display>";
 * unconfigured → the honest "connects in the demo session" state.
 */
export function JoinScreen() {
  const online = useOnline();
  const [photon, setPhoton] = useState<PhotonState | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/photon", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("photon"))))
      .then((data: PhotonState) => {
        if (!cancelled) setPhoton(data);
      })
      .catch(() => {
        if (!cancelled) setPhoton({ configured: false, join: "Photon number connects in the demo session." });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const join = photon?.configured ? `Text hi to ${photon.display}.` : "Photon number connects in the demo session.";
  const helpLines = photon?.configured
    ? [`Text hi to ${photon.display} from your own phone.`, "Open the brief to see the hazard, a shelter, and what to do."]
    : ["This screen does not show a number.", "The Photon text line is wired during the demo session.", "Open the brief to see the hazard, a shelter, and what to do."];

  return (
    <div className="lamp flex h-full flex-col">
      <main className="mx-auto flex h-full w-full max-w-md flex-col px-6">
        <div className="flex items-start justify-between gap-3 pt-[max(2.5rem,8vh)]">
          <h1 className="max-w-[18ch] text-[1.35rem] leading-snug font-normal text-paper">
            Get real-time hazards and open shelters in your language.
          </h1>
          <HelpChip title="Join by text" lines={helpLines} />
        </div>
        {online === false ? (
          <p className="mt-4 flex items-center gap-2 text-base text-warning">
            <WifiOff className="size-5 shrink-0" aria-hidden />
            You are offline.
          </p>
        ) : null}

        <div className="flex flex-1 flex-col items-center justify-center pb-[4vh] text-center">
          <p className="text-[clamp(2.4rem,10vw,3.4rem)] leading-none font-bold tracking-tight text-paper">{join}</p>
          <p className="mt-4 max-w-[22ch] text-lg leading-snug text-muted-foreground">
            The text itself happens on your phone. Open the brief here to follow along.
          </p>
          <Link href="/alert" className={cn(buttonVariants(), "mt-8 h-12 min-h-12 px-6 text-base font-semibold")}>
            Open the brief
          </Link>
        </div>

        <nav className="flex flex-col items-center pb-[max(1rem,env(safe-area-inset-bottom))]" aria-label="Other screens">
          <Link className="link-quiet" href="/ops">
            Operator view
          </Link>
          <Link className="link-quiet" href="/offline">
            Offline mode
          </Link>
        </nav>
      </main>
    </div>
  );
}