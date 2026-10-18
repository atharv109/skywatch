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
import { FONT_FAMILY, isLang, LANGUAGE_NAMES, LANGS, liveChrome, type Lang } from "@/lib/i18n";
import { useLocation } from "@/lib/location";
import { joinCopy, meshCopy } from "@/lib/mesh-copy";
import { syncMesh, useMesh } from "@/lib/mesh-store";
import { writeLang } from "@/lib/prefs";
import { SEATTLE_OEM } from "@/lib/seattle";
import { useOnline } from "@/lib/use-live";
import { cn } from "cn";

/** Default ON locally — flip with NEXT_PUBLIC_DEMO_SIGNUP=0. */
const demoSignup = process.env.NEXT_PUBLIC_DEMO_SIGNUP !== "0";

const PHONE_KEY = "skywatch-household-phone";

/**
 * The user brief exactly as GET /tools/brief/byPhone/:platform/:phone returns it
 * (types/brief.ts UserBrief, minus the userId which the tool route never sends).
 */
type PhoneBrief = {
  lang?: string;
  actions: { id: string; text: string }[];
  hazards: { type: string; severity: number; title: string; timing: string }[];
  shelter: { name: string; distanceKm: number; status: string; confidence: number; hours: string; verifiedMinutesAgo: number } | null;
  blockedRoads: { cameraId?: string; name: string; status: string; confidence: number }[];
  officialSource: { name: string; url: string };
  emergency?: string;
};

function readPhone(): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("phone");
    if (fromUrl) window.localStorage.setItem(PHONE_KEY, fromUrl);
    return fromUrl || window.localStorage.getItem(PHONE_KEY) || "";
  } catch {
    return "";
  }
}

export function LiveAlert({ initialLang }: { initialLang: Lang }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const online = useOnline();
  const location = useLocation();
  const mesh = useMesh();
  const picked = useRef(false);
  const fromYou = location.status === "on" && location.fix;
  const [phone, setPhone] = useState("");
  const [phoneBrief, setPhoneBrief] = useState<PhoneBrief | null>(null);
  const [briefFailed, setBriefFailed] = useState(false);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    return () => {
      document.documentElement.lang = "en";
      document.documentElement.dir = "ltr";
    };
  }, [lang]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // The phone is a client-only read (URL first, then the stored value).
    queueMicrotask(() => setPhone(readPhone()));
    if (location.status === "unknown") return;
    let cancelled = false;
    void syncMesh(location.fix).then((next) => {
      if (cancelled || picked.current || !next?.ok || !isLang(next.lang)) return;
      setLang(next.lang);
      writeLang(next.lang);
    });
    return () => {
      cancelled = true;
    };
  }, [location.fix, location.status]);

  // The REAL served brief by phone; the mesh-sync brief stays the fallback.
  useEffect(() => {
    if (!phone) return; // no phone yet — the mesh-sync brief is the honest view
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/tools/brief/byPhone?platform=sms&phone=${encodeURIComponent(phone)}`, { cache: "no-store" });
        if (!response.ok) throw new Error("brief");
        const data = (await response.json()) as PhoneBrief;
        if (cancelled) return;
        setPhoneBrief(data);
        setBriefFailed(false);
        if (!picked.current && isLang(data.lang)) {
          setLang(data.lang);
          writeLang(data.lang);
        }
      } catch {
        if (!cancelled) {
          setPhoneBrief(null);
          setBriefFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phone]);

  const brief = mesh.brief;
  const hazardText = brief?.text ? brief.text.split(/Open shelter:/i)[0]?.trim() || brief.text : "";
  const distance =
    brief?.shelterKm != null ? `${brief.shelterKm} km ${fromYou ? joinCopy.fromYou[lang] : joinCopy.fromSample[lang]}` : null;
  const loading = !brief && !phoneBrief && mesh.gateway !== "down";

  function choose(next: string) {
    if (!isLang(next)) return;
    picked.current = true;
    setLang(next);
    writeLang(next);
  }

  async function loadBrief() {
    const fresh = readPhone();
    setPhone(fresh);
    if (fresh) {
      const response = await fetch(`/api/tools/brief/byPhone?platform=sms&phone=${encodeURIComponent(fresh)}`, { cache: "no-store" }).catch(() => null);
      if (response?.ok) {
        setPhoneBrief((await response.json()) as PhoneBrief);
        setBriefFailed(false);
      }
    }
  }

  async function demo() {
    const target = phone || readPhone();
    const response = await fetch("/api/webhooks/photon", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: target || undefined, text: "hi" }),
    });
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; enqueued?: boolean };
    if (data.ok) {
      setPhone(target);
      window.localStorage.setItem(PHONE_KEY, target);
      toast(data.enqueued ? joinCopy.ok[lang] : joinCopy.sent[lang], { duration: 2200 });
      void loadBrief();
    } else {
      toast(joinCopy.sent[lang], { duration: 2200 });
    }
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
          ) : null}

          {phoneBrief ? (
            <>
              {phoneBrief.hazards.length > 0 ? (
                <section className="mt-8 flex flex-col gap-3" aria-label={meshCopy.brief[lang]}>
                  {phoneBrief.hazards.map((hazard, index) => {
                    const danger = hazard.severity >= 2;
                    const Icon = danger ? CloudFog : TriangleAlert;
                    return (
                      <article
                        key={`${hazard.title}-${index}`}
                        className={cn(
                          "hazard-card rounded-xl bg-card px-4 py-4 border-s-4",
                          danger ? "border-danger pulse-once" : "border-warning",
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <Icon className={cn("size-6 shrink-0", danger ? "text-danger" : "text-warning")} aria-hidden />
                          <h2 className="text-2xl leading-tight font-bold">{hazard.title}</h2>
                        </div>
                        <p className="mt-2 text-base text-muted-foreground">{hazard.timing}</p>
                      </article>
                    );
                  })}
                </section>
              ) : null}
              {phoneBrief.actions.length > 0 ? (
                <section className="mt-8">
                  <h2 className="text-base text-muted-foreground">{liveChrome.whatToDo[lang]}</h2>
                  <ol className="mt-4 flex flex-col gap-5">
                    {phoneBrief.actions.slice(0, 5).map((action, index) => (
                      <li key={action.id} className="flex gap-4 text-xl leading-snug">
                        <span className="w-8 shrink-0 font-bold tabular-nums">{index + 1}</span>
                        <span>{action.text}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
            </>
          ) : !loading && hazardText ? (
            <article className="hazard-card mt-8 rounded-xl border-s-4 border-danger bg-card px-4 py-4">
              <div className="flex items-center gap-3">
                <CloudFog className="size-6 shrink-0 text-danger" aria-hidden />
                <h2 className="text-2xl leading-tight font-bold">{hazardText.split("—")[0]?.trim()}</h2>
              </div>
              <p className="mt-3 text-lg leading-snug">{hazardText}</p>
            </article>
          ) : null}

          <section className="mt-8 rounded-2xl bg-card p-4 ring-1 ring-white/10">
            <h2 className="text-xl font-bold">{joinCopy.title[lang]}</h2>
            <p className="mt-2 text-lg leading-snug">{joinCopy.body[lang]}</p>
            {demoSignup ? (
              <Button type="button" className="mt-4 h-12 min-h-12 text-base" onClick={() => void demo()}>
                {joinCopy.demo[lang]}
              </Button>
            ) : null}
          </section>

          {phoneBrief ? (
            <section className="mt-8">
              <h2 className="text-base text-muted-foreground">{liveChrome.shelterHeading[lang]}</h2>
              {phoneBrief.shelter && phoneBrief.shelter.status === "open" ? (
                <div className="mt-4 rounded-2xl bg-card p-4 ring-1 ring-safe/50">
                  <div className="flex items-start gap-3">
                    <House className="mt-1 size-6 shrink-0 text-safe" aria-hidden />
                    <p className="text-xl leading-snug font-bold">
                      {phoneBrief.shelter.name}
                      {` — ${phoneBrief.shelter.distanceKm} km ${fromYou ? joinCopy.fromYou[lang] : joinCopy.fromSample[lang]}`}
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
                        href={phoneBrief.officialSource.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {liveChrome.sourceLabel[lang]}: {phoneBrief.officialSource.name}
                        <ArrowUpRight className="size-4" aria-hidden />
                        <span className="sr-only">Opens in a new tab.</span>
                      </a>
                    </div>
                  </div>
                </div>
              )}
              {phoneBrief.blockedRoads.length > 0 ? (
                <div className="mt-8">
                  <h2 className="text-base text-muted-foreground">{liveChrome.roadsHeading[lang]}</h2>
                  <ul className="mt-3 flex flex-col">
                    {phoneBrief.blockedRoads.slice(0, 2).map((road, index) => (
                      <li key={road.cameraId || `${road.name}-${index}`} className="flex min-h-12 items-center gap-3 text-lg">
                        <TriangleAlert className="size-5 shrink-0 text-danger" aria-hidden />
                        <span className="font-semibold" dir="ltr">
                          {road.name}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : !loading ? (
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
              {phone && !phoneBrief && briefFailed ? (
                <p className="mt-2 text-base text-muted-foreground">{joinCopy.failed[lang]}</p>
              ) : null}
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