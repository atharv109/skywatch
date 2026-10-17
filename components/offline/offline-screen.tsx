"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CloudFog, Droplets, House, Radio, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { freshness } from "@/lib/format";
import { hopLabel, keyEnding, offlineCopy, FONT_FAMILY } from "@/lib/i18n";
import { useClockAnchor, useDeviceKey, useNow, useOnline, usePreferredLang } from "@/lib/use-live";
import { cn } from "cn";

const SEED = [
  { id: "m1", kind: "flood", hops: 2, ageMin: 4 },
  { id: "m2", kind: "shelter", hops: 1, ageMin: 9 },
  { id: "m3", kind: "road", hops: 3, ageMin: 11 },
  { id: "m4", kind: "beacon", hops: 1, ageMin: 1 },
  { id: "m5", kind: "water", hops: 2, ageMin: 16 },
] as const;

type Kind = (typeof SEED)[number]["kind"];

const ICONS: Record<Kind, typeof Droplets> = {
  flood: Droplets,
  shelter: House,
  road: TriangleAlert,
  beacon: Radio,
  water: CloudFog,
};

export function OfflineScreen() {
  const online = useOnline();
  const lang = usePreferredLang();
  const key = useDeviceKey();
  const anchor = useClockAnchor();
  const [syncing, setSyncing] = useState(false);
  const now = useNow(anchor !== 0);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    return () => {
      document.documentElement.lang = "en";
      document.documentElement.dir = "ltr";
    };
  }, [lang]);

  const copy = offlineCopy;
  const dir = lang === "ar" ? "rtl" : "ltr";

  const banner = useMemo(() => {
    if (syncing) return { text: copy.syncing[lang], tone: "warning" as const };
    if (online === false) return { text: copy.offline[lang], tone: "warning" as const };
    if (online === true) return { text: copy.online[lang], tone: "safe" as const };
    return { text: "…", tone: "neutral" as const };
  }, [syncing, online, lang, copy]);

  function sync() {
    if (online !== true || syncing) return;
    setSyncing(true);
    window.setTimeout(() => setSyncing(false), 1200);
  }

  return (
    <div dir={dir} lang={lang} style={{ fontFamily: FONT_FAMILY[lang] }} className="min-h-dvh bg-ink text-paper">
      <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-5 pt-0 pb-8">
        <p
          className={cn(
            "status-banner -mx-5 flex min-h-16 items-center justify-center gap-3 px-5 py-4 text-center text-xl font-bold",
            banner.tone === "warning" && "bg-warning text-ink",
            banner.tone === "safe" && "bg-safe text-ink",
            banner.tone === "neutral" && "bg-card text-paper",
          )}
          role="status"
          style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}
        >
          {banner.text}
        </p>

        <h1 className="mt-8 text-2xl font-bold">{copy.heard[lang]}</h1>
        <p className="mt-2 text-base text-muted-foreground">{copy.sample[lang]}</p>

        <ul className="mt-4 flex flex-col">
          {SEED.map((item) => {
            const Icon = ICONS[item.kind];
            const elapsed = anchor === 0 || now === 0 ? 0 : Math.max(0, (now - anchor) / 1000);
            const age = freshness(item.ageMin * 60 + elapsed, lang);
            return (
              <li key={item.id} className="flex min-h-16 items-center gap-4 border-b border-white/10 py-3">
                <Icon className="size-6 shrink-0 text-paper" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-bold">{copy.kinds[item.kind][lang]}</p>
                  <p className="text-base text-muted-foreground">{age}</p>
                  <p className="text-sm text-muted-foreground">{item.hops === 1 ? copy.near[lang] : copy.far[lang]}</p>
                </div>
                <p className="shrink-0 text-base font-semibold tabular-nums">{hopLabel(lang, item.hops)}</p>
              </li>
            );
          })}
        </ul>

        <div className="mt-8">
          <Button
            type="button"
            className="h-auto min-h-14 w-full px-4 py-3 text-lg whitespace-normal"
            disabled={online !== true || syncing}
            aria-disabled={online !== true || syncing}
            onClick={sync}
          >
            {syncing ? copy.syncing[lang] : copy.sync[lang]}
          </Button>
          {online !== true ? <p className="mt-3 text-center text-base text-muted-foreground">{copy.syncHelp[lang]}</p> : null}
        </div>

        <p className="mt-8 text-sm text-muted-foreground">
          {copy.device[lang]}
          {key ? ` ${keyEnding(lang, key)}` : ""}
        </p>

        <div className="mt-6 flex justify-center">
          <Link className="link-quiet" href="/">
            {copy.back[lang]}
          </Link>
        </div>
      </main>
    </div>
  );
}
