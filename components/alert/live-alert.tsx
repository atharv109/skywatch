"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CircleDashed, CloudFog, House, Phone, TriangleAlert, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { HelpChip } from "@/components/help-chip";
import { ReportLoc } from "@/components/report-loc";
import { Skeleton } from "@/components/skeleton";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FONT_FAMILY, LANGUAGE_NAMES, LANGS, liveChrome, type Lang, isLang } from "@/lib/i18n";
import { useLocation } from "@/lib/location";
import { joinCopy, meshCopy } from "@/lib/mesh-copy";
import { syncMesh, useMesh } from "@/lib/mesh-store";
import { writeLang } from "@/lib/prefs";
import { SEATTLE_OEM } from "@/lib/seattle";
import { useOnline } from "@/lib/use-live";

const demoSignup = process.env.NEXT_PUBLIC_DEMO_SIGNUP === "1";

export function LiveAlert({ initialLang }: { initialLang: Lang }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const online = useOnline();
  const location = useLocation();
  const mesh = useMesh();
  const picked = useRef(false);
  const fromYou = location.status === "on" && location.fix;

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    return () => {
      document.documentElement.lang = "en";
      document.documentElement.dir = "ltr";
    };
  }, [lang]);

  useEffect(() => {
    if (location.status === "unknown") return;
    let cancelled = false;
    void syncMesh(location.fix).then((next) => {
      if (cancelled || picked.current || !isLang(next)) return;
      setLang(next);
      writeLang(next);
    });
    return () => {
      cancelled = true;
    };
  }, [location.fix, location.status]);

  const brief = mesh.brief;
  const hazardText = brief?.text ? brief.text.split(/Open shelter:/i)[0]?.trim() || brief.text : "";
  const distance =
    brief?.shelterKm != null ? `${brief.shelterKm} km ${fromYou ? joinCopy.fromYou[lang] : joinCopy.fromSample[lang]}` : null;
  const loading = !brief && mesh.gateway !== "down";

  function choose(next: string) {
    if (!isLang(next)) return;
    picked.current = true;
    setLang(next);
    writeLang(next);
  }

  async function demo() {
    const response = await fetch("/api/webhooks/photon", { method: "POST" });
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean };
    toast(data.ok ? joinCopy.ok[lang] : joinCopy.sent[lang], { duration: 2200 });
  }

  return (
    <div dir={lang === "ar" ? "rtl" : "ltr"} lang={lang} style={{ fontFamily: FONT_FAMILY[lang] }} className="flex h-full flex-col bg-ink text-paper">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-lg px-5 pt-6 pb-8">
          <header className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-muted-foreground">Skywatch</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <HelpChip
                  title={joinCopy.title[lang]}
                  lines={[joinCopy.body[lang], joinCopy.fromSample[lang], liveChrome.call911[lang]]}
                />
                <ReportLoc />
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex min-h-12 items-center rounded-full px-3 text-base">
                {LANGUAGE_NAMES[lang]}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuRadioGroup value={lang} onValueChange={choose}>
                  {LANGS.map((code) => (
                    <DropdownMenuRadioItem key={code} value={code} className="min-h-12 text-base" style={{ fontFamily: FONT_FAMILY[code] }}>
                      {LANGUAGE_NAMES[code]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>

          {online === false ? (
            <p className="mt-5 flex items-start gap-3 rounded-xl bg-warning px-4 py-3 text-base font-semibold text-ink">
              <WifiOff className="mt-0.5 size-5 shrink-0" aria-hidden />
              {liveChrome.offline[lang]}
            </p>
          ) : null}

          {loading ? (
            <div className="mt-8 flex flex-col gap-3">
              <Skeleton className="h-28" />
              <Skeleton className="h-24" />
              <p className="sr-only">{joinCopy.loading[lang]}</p>
            </div>
          ) : (
            <article className="hazard-card mt-8 rounded-xl border-s-4 border-danger bg-card px-4 py-4">
              <div className="flex items-center gap-3">
                <CloudFog className="size-6 shrink-0 text-danger" aria-hidden />
                <h2 className="text-2xl leading-tight font-bold">{hazardText ? hazardText.split("—")[0]?.trim() : joinCopy.failed[lang]}</h2>
              </div>
              {hazardText ? <p className="mt-3 text-lg leading-snug">{hazardText}</p> : null}
            </article>
          )}

          <section className="mt-8 rounded-2xl bg-card p-4 ring-1 ring-white/10">
            <h2 className="text-xl font-bold">{joinCopy.title[lang]}</h2>
            <p className="mt-2 text-lg leading-snug">{joinCopy.body[lang]}</p>
            {demoSignup ? (
              <Button type="button" className="mt-4 h-12 min-h-12 text-base" onClick={() => void demo()}>
                {joinCopy.demo[lang]}
              </Button>
            ) : null}
          </section>

          {loading ? null : (
            <section className="mt-8">
              <h2 className="text-base text-muted-foreground">{liveChrome.shelterHeading[lang]}</h2>
              {brief?.shelterName && brief.shelterOpen ? (
                <div className="mt-4 rounded-2xl bg-card p-4 ring-1 ring-safe/50">
                  <div className="flex items-start gap-3">
                    <House className="mt-1 size-6 shrink-0 text-safe" aria-hidden />
                    <p className="text-xl leading-snug font-bold">
                      {brief.shelterName}
                      {distance ? ` — ${distance}` : ""}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="mt-4 rounded-2xl bg-card p-4 ring-1 ring-white/15">
                  <div className="flex items-start gap-3">
                    <CircleDashed className="mt-1 size-6 shrink-0 text-warning" aria-hidden />
                    <div>
                      <p className="text-xl leading-snug">{liveChrome.noShelter[lang]}</p>
                      <a
                        className="mt-4 inline-flex min-h-12 items-center gap-2 text-base underline underline-offset-4"
                        href={SEATTLE_OEM}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {liveChrome.sourceLabel[lang]}: {meshCopy.oem[lang]}
                        <ArrowUpRight className="size-4" aria-hidden />
                      </a>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {brief && brief.roads.length > 0 ? (
            <section className="mt-8">
              <h2 className="text-base text-muted-foreground">{liveChrome.roadsHeading[lang]}</h2>
              <ul className="mt-3 flex flex-col">
                {brief.roads.slice(0, 2).map((road) => (
                  <li key={road.name} className="flex min-h-12 items-center gap-3 text-lg">
                    <TriangleAlert className="size-5 shrink-0 text-danger" aria-hidden />
                    <span className="font-semibold" dir="ltr">
                      {road.name}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
      <a
        href="tel:911"
        className="flex min-h-16 shrink-0 items-center justify-center gap-3 bg-[#c6281c] px-5 py-3 text-center text-lg font-bold text-white"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <Phone className="size-6 shrink-0" aria-hidden />
        {liveChrome.call911[lang]}
      </a>
    </div>
  );
}
