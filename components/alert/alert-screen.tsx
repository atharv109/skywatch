"use client";

import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  CircleDashed,
  CloudFog,
  Droplets,
  House,
  Phone,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { LiveAlert } from "@/components/alert/live-alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { distanceKm, formatKm, freshness } from "@/lib/format";
import { FONT_FAMILY, LANGUAGE_NAMES, LANGS, getBrief, type Lang } from "@/lib/i18n";
import { writeLang } from "@/lib/prefs";
import { GREEN_SHELTER, HOUSEHOLD } from "@/lib/scenarios";
import { useSimMode } from "@/lib/sim";
import type { ScenarioId } from "@/lib/types";
import { useClockAnchor, useNow, useOnline } from "@/lib/use-live";
import { cn } from "cn";

export function AlertScreen({
  initialLang,
  initialScenario,
}: {
  initialLang: Lang;
  initialScenario: ScenarioId;
}) {
  const sim = useSimMode();
  const [lang, setLang] = useState<Lang>(initialLang);
  const online = useOnline();
  const anchor = useClockAnchor();
  const now = useNow(anchor !== 0);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    return () => {
      document.documentElement.lang = "en";
      document.documentElement.dir = "ltr";
    };
  }, [lang]);

  const km = formatKm(distanceKm(HOUSEHOLD, GREEN_SHELTER.point), lang);
  const dir = lang === "ar" ? "rtl" : "ltr";
  const age = anchor === 0 || now === 0 ? freshness(0, lang) : freshness(Math.max(0, (now - anchor) / 1000), lang);

  function choose(next: Lang) {
    setLang(next);
    writeLang(next);
  }

  if (!sim) return <LiveAlert initialLang={initialLang} />;

  // Sim mode only (?sim=1): the static sample brief, and every distance below is
  // computed from the fixture coordinates, never shown live.
  const brief = getBrief(initialScenario, lang, km);

  return (
    <div dir={dir} lang={lang} style={{ fontFamily: FONT_FAMILY[lang] }} className="flex h-full flex-col bg-ink text-paper">
      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-lg px-5 pt-6 pb-8">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="sr-only">{brief.whatToDo}</h1>
            <p className="text-sm text-muted-foreground">Skywatch</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {brief.sample} · {age}
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex min-h-12 items-center rounded-full px-3 text-base text-paper active:bg-white/10">
              {LANGUAGE_NAMES[lang]}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuRadioGroup
                value={lang}
                onValueChange={(value) => choose(value as Lang)}
              >
                {LANGS.map((code) => (
                  <DropdownMenuRadioItem
                    key={code}
                    value={code}
                    className="min-h-12 text-base"
                    style={{ fontFamily: FONT_FAMILY[code] }}
                  >
                    {LANGUAGE_NAMES[code]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {online === false ? (
          <p className="status-banner mt-5 flex items-start gap-3 rounded-xl bg-warning px-4 py-3 text-base font-semibold text-ink">
            <WifiOff className="mt-0.5 size-5 shrink-0" aria-hidden />
            {brief.offlineBanner}
          </p>
        ) : null}

        <section className="mt-8 flex flex-col gap-3" aria-label={brief.sample}>
          {brief.hazards.map((hazard) => {
            const danger = hazard.severity === "danger";
            const Icon = danger ? (initialScenario === "smoke" ? CloudFog : Droplets) : TriangleAlert;
            return (
              <article
                key={hazard.title}
                className={cn(
                  "hazard-card rounded-xl bg-card px-4 py-4",
                  danger ? "border-s-4 border-danger pulse-once" : "border-s-4 border-warning",
                )}
              >
                <div className="flex items-center gap-3">
                  <Icon
                    className={cn("size-6 shrink-0", danger ? "text-danger" : "text-warning")}
                    aria-hidden
                  />
                  <h2 className="text-2xl leading-tight font-bold">{hazard.title}</h2>
                </div>
                <p className="mt-3 text-lg leading-snug">{hazard.summary}</p>
                <p className="mt-2 text-base text-muted-foreground">{hazard.timing}</p>
              </article>
            );
          })}
        </section>

        <section className="mt-10">
          <h2 className="text-base text-muted-foreground">{brief.whatToDo}</h2>
          <ol className="mt-4 flex flex-col gap-5">
            {brief.actions.map((action, index) => (
              <li key={action} className="flex gap-4 text-xl leading-snug">
                <span className="w-8 shrink-0 font-bold tabular-nums">{index + 1}</span>
                <span>{action}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-10">
          <h2 className="text-base text-muted-foreground">{brief.shelterHeading}</h2>
          {brief.shelter.open ? (
            <div className="shelter-card mt-4 rounded-2xl bg-card p-4 ring-1 ring-safe/50">
              <div className="flex items-start gap-3">
                <House className="mt-1 size-6 shrink-0 text-safe" aria-hidden />
                <div>
                  <p className="text-xl leading-snug font-bold">{brief.shelter.line}</p>
                  <p className="mt-2 text-lg text-muted-foreground">{brief.shelter.address}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="shelter-card mt-4 rounded-2xl bg-card p-4 ring-1 ring-white/15">
              <div className="flex items-start gap-3">
                <CircleDashed className="mt-1 size-6 shrink-0 text-warning" aria-hidden />
                <div>
                  <p className="text-xl leading-snug">{brief.shelter.line}</p>
                  <a
                    className="mt-4 inline-flex min-h-12 items-center gap-2 text-base text-paper underline underline-offset-4"
                    href={brief.shelter.href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {brief.shelter.sourceLabel}: {brief.shelter.sourceName}
                    <ArrowUpRight className="size-4" aria-hidden />
                    <span className="sr-only">Opens in a new tab.</span>
                  </a>
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="mt-10">
          <h2 className="text-base text-muted-foreground">{brief.roadsHeading}</h2>
          <ul className="mt-3 flex flex-col">
            {brief.roads.map((road) => (
              <li key={road.name} className="flex min-h-12 items-center gap-3 text-lg">
                <TriangleAlert
                  className={cn("size-5 shrink-0", road.status === "slow" ? "text-warning" : "text-danger")}
                  aria-hidden
                />
                <span className="font-semibold" dir="ltr">
                  {road.name}
                </span>
                <span className={road.status === "slow" ? "text-warning" : "text-danger"}>{road.statusLabel}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      </div>

      <a
        href="tel:911"
        className="call-bar flex min-h-16 shrink-0 items-center justify-center gap-3 bg-[#c6281c] px-5 py-3 text-center text-lg font-bold text-white"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <Phone className="size-6 shrink-0" aria-hidden />
        {brief.call911}
      </a>
    </div>
  );
}
