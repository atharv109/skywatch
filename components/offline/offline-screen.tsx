"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Shield } from "lucide-react";
import { toast } from "sonner";
import { HelpChip } from "@/components/help-chip";
import { MeshMap } from "@/components/offline/mesh-map";
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
import { freshness } from "@/lib/format";
import { FONT_FAMILY, isLang, keyEnding, LANGUAGE_NAMES, LANGS, offlineCopy } from "@/lib/i18n";
import { useLocation } from "@/lib/location";
import { chips, kindLabel, meshCopy } from "@/lib/mesh-copy";
import {
  REPORT_KINDS,
  rememberSatellite,
  sampleSatellite,
  sendMesh,
  syncMesh,
  useMesh,
  type ReportKind,
} from "@/lib/mesh-store";
import { downscalePhoto } from "@/lib/photo";
import { writeLang } from "@/lib/prefs";
import { useSimMode } from "@/lib/sim";
import { useClockAnchor, useDeviceKey, useNow, useOnline, usePreferredLang } from "@/lib/use-live";
import { cn } from "cn";

export function OfflineScreen() {
  const online = useOnline();
  const lang = usePreferredLang();
  const sim = useSimMode();
  const location = useLocation();
  const mesh = useMesh();
  const key = useDeviceKey();
  const anchor = useClockAnchor();
  const now = useNow(anchor !== 0);
  const [thread, setThread] = useState<"neighbors" | "direct">("neighbors");
  const [peer, setPeer] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<ReportKind>("OTHER");
  const [photo, setPhoto] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const started = useRef("");

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    return () => {
      document.documentElement.lang = "en";
      document.documentElement.dir = "ltr";
    };
  }, [lang]);

  useEffect(() => {
    if (!sim || mesh.satellite) return;
    rememberSatellite(sampleSatellite([37.81, -122.29]));
  }, [sim, mesh.satellite]);

  useEffect(() => {
    if (!mesh.deviceId || online === false || location.status === "unknown") return;
    const key = location.fix ? `${location.fix.lat.toFixed(3)},${location.fix.lon.toFixed(3)}` : "sample";
    if (started.current === key) return;
    started.current = key;
    void syncMesh(location.fix).then((next) => {
      if (isLang(next)) writeLang(next);
    });
  }, [mesh.deviceId, online, location.fix, location.status]);

  const hash = mesh.hash;
  const directs = useMemo(() => {
    const grouped = new Map<string, number>();
    mesh.messages.forEach((message) => {
      if (message.shield || !hash) return;
      if (message.to === hash && message.from !== hash) grouped.set(message.from, (grouped.get(message.from) || 0) + 1);
      if (message.from === hash && message.to) grouped.set(message.to, (grouped.get(message.to) || 0) + 1);
    });
    return [...grouped.keys()];
  }, [mesh.messages, hash]);

  const visible = mesh.messages.filter((message) => {
    if (thread === "neighbors") return message.to == null;
    if (!peer || !hash) return false;
    return (message.to === hash && message.from === peer) || (message.from === hash && message.to === peer);
  });

  const banner = mesh.syncing
    ? { text: offlineCopy.syncing[lang], tone: "warning" as const }
    : online === false
      ? { text: offlineCopy.offline[lang], tone: "warning" as const }
      : { text: offlineCopy.online[lang], tone: "safe" as const };

  const self = useMemo(
    () => (location.fix ? { lat: location.fix.lat, lon: location.fix.lon } : null),
    [location.fix],
  );
  const clock = mesh.satellite
    ? new Date(mesh.satellite.fetchedAt).toLocaleTimeString(lang === "zh" ? "zh-CN" : lang, { hour: "2-digit", minute: "2-digit" })
    : "";

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    try {
      setPhoto(await downscalePhoto(file));
    } catch {
      toast(lang === "en" ? "That photo could not be prepared." : meshCopy.photo[lang], { duration: 1800 });
    }
  }

  async function send() {
    const body = text.trim();
    if (!body && !photo) return;
    try {
      await sendMesh({
        text: body || kindLabel[lang][kind],
        to: thread === "direct" && peer ? peer : null,
        kind: photo ? kind : undefined,
        photo: photo ? { data: photo, label: kind } : undefined,
        fix: location.fix,
      });
      setText("");
      setPhoto(null);
    } catch {
      toast(lang === "en" ? "This phone could not hold that photo." : meshCopy.photo[lang], { duration: 1800 });
    }
  }

  async function sync() {
    if (online !== true) return;
    const next = await syncMesh(location.fix);
    if (isLang(next)) writeLang(next);
  }

  return (
    <div dir={lang === "ar" ? "rtl" : "ltr"} lang={lang} style={{ fontFamily: FONT_FAMILY[lang] }} className="flex h-full flex-col bg-ink text-paper">
      <p
        className={cn(
          "flex min-h-16 shrink-0 items-center justify-center px-5 text-center text-xl font-bold",
          banner.tone === "warning" ? "bg-warning text-ink" : "bg-safe text-ink",
        )}
        role="status"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        {banner.text}
      </p>

      <header className="flex shrink-0 items-center gap-2 px-3 py-2">
        <HelpChip
          title={meshCopy.neighbors[lang]}
          lines={[meshCopy.emptyNeighbors[lang], meshCopy.relayed[lang], meshCopy.satelliteLive[lang]]}
        />
        <ReportLoc />
        <DropdownMenu>
          <DropdownMenuTrigger className="ms-auto inline-flex min-h-12 items-center rounded-full px-3 text-base">
            {LANGUAGE_NAMES[lang]}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuRadioGroup
              value={lang}
              onValueChange={(value) => {
                if (isLang(value)) writeLang(value);
              }}
            >
              {LANGS.map((code) => (
                <DropdownMenuRadioItem key={code} value={code} className="min-h-12 text-base" style={{ fontFamily: FONT_FAMILY[code] }}>
                  {LANGUAGE_NAMES[code]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {mesh.satellite ? (
        <div className="shrink-0 px-3">
          <MeshMap satellite={mesh.satellite} self={self} />
          <p className="mt-2 text-sm font-semibold text-warning">
            {mesh.satellite.aqi != null ? `${meshCopy.air[lang]}: AQI ${mesh.satellite.aqi} · ${clock} (satellite)` : meshCopy.air[lang]}
          </p>
          <p className="text-sm text-muted-foreground">{mesh.satellite.live ? meshCopy.satelliteLive[lang] : meshCopy.satelliteSample[lang]}</p>
        </div>
      ) : null}

      <div className="mt-2 flex shrink-0 gap-2 px-3" role="tablist">
        {(["neighbors", "direct"] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={thread === item}
            className={cn("min-h-12 flex-1 rounded-full text-base font-semibold", thread === item ? "bg-paper text-ink" : "bg-white/5")}
            onClick={() => {
              setThread(item);
              setPeer(null);
            }}
          >
            {meshCopy[item][lang]}
          </button>
        ))}
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {mesh.brief?.text ? (
          <section className="mb-3 rounded-2xl bg-card px-3 py-3">
            <h2 className="text-sm text-muted-foreground">{meshCopy.brief[lang]}</h2>
            <p className="mt-1 text-lg leading-snug">{mesh.brief.text}</p>
          </section>
        ) : null}
        {thread === "direct" && !peer ? (
          directs.length ? (
            <ul className="flex flex-col">
              {directs.map((sender) => (
                <li key={sender}>
                  <button type="button" className="flex min-h-14 w-full items-center text-left text-lg font-semibold" onClick={() => setPeer(sender)}>
                    {sender}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pt-6 text-lg text-muted-foreground">{meshCopy.emptyDirect[lang]}</p>
          )
        ) : visible.length ? (
          <ul className="flex flex-col gap-3">
            {peer ? (
              <li>
                <button type="button" className="min-h-12 text-base text-paper underline" onClick={() => setPeer(null)}>
                  {meshCopy.back[lang]}
                </button>
              </li>
            ) : null}
            {visible.map((message) => (
              <li
                key={message.id}
                className={cn(
                  "max-w-[90%] rounded-2xl px-3 py-2",
                  message.shield
                    ? "w-full max-w-none bg-white/5 text-muted-foreground"
                    : message.from === hash
                      ? "self-end bg-paper text-ink"
                      : "bg-card",
                )}
              >
                {message.shield ? (
                  <p className="flex items-center gap-2 text-sm font-semibold text-paper">
                    <Shield className="size-4" aria-hidden />
                    {meshCopy.skywatch[lang]}
                  </p>
                ) : null}
                <p className={cn("text-lg leading-snug", message.shield && "text-base")}>{message.text}</p>
                {message.photoRef ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={mesh.photos[message.photoRef]?.data || `/api/mesh/photo/${encodeURIComponent(message.photoRef)}`}
                    alt={message.label || message.kind || "Photo report"}
                    className="mt-2 h-28 w-full rounded-lg object-cover"
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                ) : null}
                <p className="mt-1 text-sm text-muted-foreground">
                  {freshness(now > 0 ? Math.max(0, (now - message.ts) / 1000) : 0, lang)}
                  {message.kind ? ` · ${kindLabel[lang][message.kind]}` : ""}
                  {thread === "direct" ? ` · ${meshCopy.relayed[lang]}` : ""}
                  {message.local && !message.accepted ? ` · ${meshCopy.onPhone[lang]}` : ""}
                </p>
              </li>
            ))}
          </ul>
        ) : mesh.gateway === "idle" && online !== false ? (
          <div className="flex flex-col gap-3 pt-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : (
          <p className="pt-6 text-lg text-muted-foreground">{thread === "neighbors" ? meshCopy.emptyNeighbors[lang] : meshCopy.emptyDirect[lang]}</p>
        )}
        <p className="mt-6 text-sm text-muted-foreground">
          {offlineCopy.device[lang]}
          {key ? ` ${keyEnding(lang, key)}` : ""}
        </p>
      </div>

      <form
        className="shrink-0 border-t border-white/10 px-3 pt-3"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="flex gap-2 overflow-x-auto pb-2">
          {chips[lang].map((chip) => (
            <button key={chip} type="button" className="min-h-12 shrink-0 rounded-full bg-white/5 px-3 text-base" onClick={() => setText(chip)}>
              {chip}
            </button>
          ))}
        </div>
        <div className="flex gap-2 overflow-x-auto pb-2" role="group" aria-label={kind}>
          {REPORT_KINDS.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={kind === item}
              className={cn("min-h-12 shrink-0 rounded-full px-3 text-base font-semibold", kind === item ? "bg-paper text-ink" : "bg-white/5")}
              onClick={() => setKind(item)}
            >
              {kindLabel[lang][item]}
            </button>
          ))}
        </div>
        {photo ? (
          <div className="mb-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photo} alt={kindLabel[lang][kind]} className="h-20 w-20 rounded-lg object-cover" />
            <p className="mt-1 text-sm text-muted-foreground">{meshCopy.photoHold[lang]}</p>
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(event) => void onPhoto(event.target.files?.[0])}
          />
          <button type="button" className="inline-flex size-12 items-center justify-center rounded-full bg-white/10" aria-label={meshCopy.photo[lang]} onClick={() => inputRef.current?.click()}>
            <Camera className="size-5" aria-hidden />
          </button>
          <label className="min-w-0 flex-1">
            <span className="sr-only">{meshCopy.placeholder[lang]}</span>
            <textarea
              value={text}
              maxLength={280}
              rows={2}
              placeholder={meshCopy.placeholder[lang]}
              onChange={(event) => setText(event.target.value.slice(0, 280))}
              className="w-full resize-none rounded-2xl bg-white/5 px-3 py-3 text-lg outline-none"
            />
          </label>
          <Button type="submit" className="h-12 min-h-12 px-4 text-base">
            {meshCopy.send[lang]}
          </Button>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground tabular-nums">{text.length}/280</p>
          <Button type="button" className="h-12 min-h-12 px-4 text-base" disabled={online !== true || mesh.syncing} onClick={() => void sync()}>
            {mesh.syncing ? offlineCopy.syncing[lang] : offlineCopy.sync[lang]}
          </Button>
        </div>
        <div className="mt-2 flex justify-center">
          <Link className="link-quiet" href="/">
            {meshCopy.home[lang]}
          </Link>
        </div>
      </form>
    </div>
  );
}
