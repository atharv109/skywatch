"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOnline } from "@/lib/use-live";

type PhotonNumber = { display: string; e164: string };

function copyWithSelection(text: string) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export function JoinScreen() {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [number, setNumber] = useState<PhotonNumber | null>(null);
  const [attempt, setAttempt] = useState(0);
  const online = useOnline();

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    const fail = params.get("unavailable") === "1";

    async function load() {
      setPhase("loading");
      try {
        const res = await fetch(fail ? "/api/photon?fail=1" : "/api/photon", { cache: "no-store" });
        if (!res.ok) throw new Error("unavailable");
        const data = (await res.json()) as PhotonNumber;
        if (!data.display) throw new Error("unavailable");
        if (!cancelled) {
          setNumber(data);
          setPhase("ready");
        }
      } catch {
        if (!cancelled) setPhase("error");
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  function copy() {
    if (!number) return;
    const text = number.display;
    const legacy = copyWithSelection(text);
    if (legacy) {
      toast("Copied", { duration: 1400 });
      void navigator.clipboard.writeText(text).catch(() => undefined);
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => toast("Copied", { duration: 1400 }),
      () => toast("Could not copy. Write this number down.", { duration: 2400 }),
    );
  }

  return (
    <div className="lamp min-h-dvh">
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6">
        <div className="pt-[max(4.5rem,12vh)]">
          <h1 className="max-w-[18ch] text-[1.4rem] leading-snug font-normal text-paper sm:text-[1.6rem]">
            Get real-time hazards and open shelters in your language.
          </h1>
          {online === false ? (
            <p className="mt-4 flex items-center gap-2 text-base text-warning">
              <WifiOff className="size-5 shrink-0" aria-hidden />
              You are offline.
            </p>
          ) : null}
        </div>

        <div className="flex flex-1 flex-col items-center justify-center pb-[6vh] text-center">
          {phase === "loading" ? (
            <p className="text-xl text-muted-foreground" role="status">
              Loading number…
            </p>
          ) : null}

          {phase === "error" ? (
            <div className="flex flex-col items-center gap-6">
              <p className="max-w-[16ch] text-2xl leading-snug font-bold text-paper" role="alert">
                Number unavailable — try again
              </p>
              <Button
                type="button"
                className="h-12 min-h-12 px-6 text-base"
                onClick={() => setAttempt((n) => n + 1)}
              >
                Try again
              </Button>
            </div>
          ) : null}

          {phase === "ready" && number ? (
            <>
              <button
                type="button"
                onClick={() => void copy()}
                className="number-hit text-[clamp(2.7rem,11vw,4.25rem)] leading-none font-bold tracking-tight text-paper tabular-nums"
                aria-label={`Photon number ${number.display}. Copy.`}
              >
                {number.display}
              </button>
              <p className="mt-4 text-xl text-paper">Text hi to join.</p>
              <p className="mt-3 text-sm text-muted-foreground">Sample number for this demo.</p>
            </>
          ) : null}
        </div>

        <nav
          className="flex flex-col items-center pb-[max(1rem,env(safe-area-inset-bottom))]"
          aria-label="Other screens"
        >
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
