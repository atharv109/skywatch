"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  Droplets,
  House,
  LocateFixed,
  Minus,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { DetailSheet, Tray } from "@/components/bottom-sheet";
import { HelpChip } from "@/components/help-chip";
import type { MapApi, MapPicture } from "@/components/ops/ops-map";
import { PhotoStrip } from "@/components/ops/photo-strip";
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
import { Input } from "@/components/ui/input";
import { freshness, verifiedLabel } from "@/lib/format";
import type { Fix } from "@/lib/location";
import { requestLocation, useLocation } from "@/lib/location";
import { syncMesh } from "@/lib/mesh-store";
import { writeCheckIns, writeScenario } from "@/lib/prefs";
import { useSimMode } from "@/lib/sim";
import { useSituation } from "@/lib/situation-store";
import { FIELD_REPORT, SCENARIOS } from "@/lib/scenarios";
import {
  confidenceLabel,
  hazardSentence,
  resourceListLine,
  resourceSentence,
  roadSentence,
  statusWord,
} from "@/lib/status";
import type { CheckIn, Confidence, Hazard, Resource, ResourceStatus, Road, ScenarioId } from "@/lib/types";
import { useCheckIns, useClientScenario, useLiveFeed, useMedia, useNow, useOnline } from "@/lib/use-live";
import { cn } from "cn";

const OpsMap = dynamic(() => import("@/components/ops/ops-map").then((mod) => mod.OpsMap), { ssr: false });

type Layers = { hazards: boolean; resources: boolean; roads: boolean; people: boolean };

const LAYER_LABEL: Record<keyof Layers, string> = {
  hazards: "Hazards",
  resources: "Shelters and aid",
  roads: "Roads",
  people: "Nearby phones",
};

function isCheckIn(value: unknown): value is CheckIn {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CheckIn>;
  const statusOk =
    item.status === "open" || item.status === "full" || item.status === "closed" || item.status === "unknown";
  const confidenceOk = item.confidence === "high" || item.confidence === "medium" || item.confidence === "low";
  return statusOk && confidenceOk && typeof item.note === "string" && typeof item.at === "number";
}

export function OpsScreen() {
  const sim = useSimMode();
  const scenario = useClientScenario();
  const location = useLocation();
  const situation = useSituation(!sim, location.fix);
  const [layers, setLayers] = useState<Layers>({ hazards: true, resources: true, roads: true, people: true });
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkInFor, setCheckInFor] = useState<string | null>(null);
  const [tileProblem, setTileProblem] = useState(false);
  const [focus, setFocus] = useState<Fix | null>(null);
  const synced = useRef("");
  const overrides = useCheckIns(isCheckIn);
  const api = useRef<MapApi | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const online = useOnline();
  const reducedMotion = useMedia("(prefers-reduced-motion: reduce)");
  const highContrast = useMedia("(prefers-contrast: more)");
  const now = useNow(sim ? scenario != null : situation.status === "ready");
  const activeScenario = scenario ?? "flood";
  const { link, snapshot, receivedAt, chipUntil } = useLiveFeed(activeScenario, sim && scenario != null);
  const live = snapshot && snapshot.scenario === activeScenario ? snapshot : null;
  const available = live ? live.shelterAvailable : activeScenario === "flood" ? 22 : null;
  const fieldReport = live ? live.fieldReport : false;
  const aqi = live ? live.aqi : activeScenario === "smoke" ? 164 : null;
  const showChip = sim && now < chipUntil;

  const picture: MapPicture = useMemo(() => {
    if (!sim) {
      const resources = situation.resources.map((resource) => {
        const override = overrides[resource.id];
        if (!override) return resource;
        return {
          ...resource,
          status: override.status,
          confidence: override.confidence,
          note: override.note || resource.note,
          available: override.status === "full" ? 0 : resource.available,
        };
      });
      return {
        scenario: "smoke",
        hazards: situation.hazards,
        resources,
        roads: situation.roads,
        people: situation.people,
      };
    }
    const base = SCENARIOS[activeScenario];
    const hazards = base.hazards.map((hazard) => {
      if (hazard.id === "smoke-air" && aqi != null) {
        return { ...hazard, summary: `${hazard.summary} The air index is ${aqi}.` };
      }
      return hazard;
    });
    if (activeScenario === "flood" && fieldReport) hazards.push(FIELD_REPORT);
    const resources = base.resources.map((resource) => {
      let next = resource;
      if (resource.id === "flood-green" && available != null) next = { ...next, available };
      const override = overrides[resource.id];
      if (!override) return next;
      return {
        ...next,
        status: override.status,
        confidence: override.confidence,
        note: override.note || next.note,
        available: override.status === "full" ? 0 : next.available,
      };
    });
    return { scenario: activeScenario, hazards, resources, roads: base.roads, people: base.people };
  }, [sim, situation, activeScenario, aqi, fieldReport, available, overrides]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    const hazard = picture.hazards.find((item) => item.id === selectedId);
    if (hazard) return { kind: "hazard" as const, hazard };
    const resource = picture.resources.find((item) => item.id === selectedId);
    if (resource) return { kind: "resource" as const, resource };
    const road = picture.roads.find((item) => item.id === selectedId);
    if (road) return { kind: "road" as const, road };
    return null;
  }, [picture, selectedId]);

  useEffect(() => {
    if (sim || location.status === "unknown") return;
    const key = location.fix ? `${location.fix.lat.toFixed(3)},${location.fix.lon.toFixed(3)}` : "sample";
    if (synced.current === key) return;
    synced.current = key;
    void syncMesh(location.fix);
  }, [sim, location.fix, location.status]);

  useEffect(() => {
    if (selected) titleRef.current?.focus();
  }, [selected]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (checkInFor) setCheckInFor(null);
      else if (selectedId) setSelectedId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [checkInFor, selectedId]);

  function chooseScenario(next: ScenarioId) {
    writeScenario(next);
    setSelectedId(null);
    setCheckInFor(null);
  }

  function toggleLayer(key: keyof Layers) {
    const turningOff = layers[key];
    setLayers((current) => ({ ...current, [key]: !current[key] }));
    if (!turningOff || !selectedId) return;
    const hazard = picture.hazards.some((item) => item.id === selectedId);
    const resource = picture.resources.some((item) => item.id === selectedId);
    const road = picture.roads.some((item) => item.id === selectedId);
    if ((key === "hazards" && hazard) || (key === "resources" && resource) || (key === "roads" && road)) {
      setSelectedId(null);
    }
  }

  function select(id: string | null) {
    setSelectedId(id);
    if (id) setExpanded(false);
  }

  function saveCheckIn(id: string, value: CheckIn) {
    writeCheckIns({ ...overrides, [id]: value });
    setCheckInFor(null);
    toast("Check-in saved", { duration: 1600 });
  }

  function locate() {
    void requestLocation().then((fix) => {
      if (fix) setFocus(fix);
      else toast("Location unavailable", { duration: 1800 });
    });
  }

  const offline = online === false;
  const liveReady = situation.status === "ready";
  const statusText = sim
    ? offline
      ? "Offline"
      : link === "live"
        ? "Live"
        : "Reconnecting…"
    : liveReady
      ? "Live"
      : situation.status === "error"
        ? "Reconnecting…"
        : "Loading";
  const statusTone = sim ? (offline || link !== "live" ? "warning" : "safe") : liveReady ? "safe" : "warning";
  const age = sim
    ? receivedAt && now > 0
      ? freshness(Math.max(0, (now - receivedAt) / 1000), "en")
      : "updated just now"
    : situation.source === "backend"
      ? "Live situation"
      : "Seattle · gateway brief";
  const placeTitle = sim ? SCENARIOS[activeScenario].title : situation.title || "Seattle";
  const userPoint = useMemo(
    () => (location.fix ? { lat: location.fix.lat, lon: location.fix.lon } : null),
    [location.fix],
  );
  const checkResource = picture.resources.find((item) => item.id === checkInFor) ?? null;

  const hazardRows = [...picture.hazards].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "danger" ? -1 : 1));
  const resourceRows = [...picture.resources].sort((a, b) => rankResource(a.status) - rankResource(b.status));
  const roadRows = [...picture.roads].sort((a, b) => rankRoad(a.status) - rankRoad(b.status));

  return (
    <div className="relative h-full overflow-hidden bg-ink text-paper">
      <h1 className="sr-only">Operator view</h1>
      {sim && !scenario ? (
        <div className="h-full w-full bg-ink" />
      ) : (
        <OpsMap
          key={sim ? "oakland" : "puget"}
          picture={picture}
          region={sim ? "oakland" : "puget"}
          fitPoints={sim ? [] : situation.fitPoints}
          user={userPoint}
          focus={focus}
          layers={layers}
          selectedId={selectedId}
          highContrast={highContrast}
          reducedMotion={reducedMotion}
          onSelect={select}
          onApi={(next) => {
            api.current = next;
          }}
          onTileProblem={() => setTileProblem(true)}
          onLocateError={() => toast("Location unavailable", { duration: 1800 })}
        />
      )}
      <PhotoStrip />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="pointer-events-auto flex items-center gap-2">
          <HelpChip
            title="How to read the map"
            lines={[
              "Red is danger or closed. Amber is a warning or unknown. Green is open.",
              "A faded marker is low confidence.",
              "Tap a marker for the name, status, and when it was last checked.",
            ]}
          />
          <ReportLoc onGranted={setFocus} />
        </div>
        <div className="pointer-events-auto flex h-12 max-w-full items-center gap-1 rounded-full bg-ink/85 px-1.5 ring-1 ring-white/15 backdrop-blur-md">
          <p className="flex items-center gap-2 px-2 text-sm font-semibold" role="status">
            <span className="relative flex size-2.5" aria-hidden>
              <span className={cn("absolute inline-flex size-full rounded-full opacity-60", statusTone === "safe" ? "bg-safe live-ping" : "bg-warning")} />
              <span className={cn("relative inline-flex size-2.5 rounded-full", statusTone === "safe" ? "bg-safe" : "bg-warning")} />
            </span>
            {statusText}
          </p>
          <span
            className="inline-flex min-h-7 min-w-7 items-center justify-center rounded-full bg-white/10 px-2 text-sm font-bold tabular-nums"
            aria-label={`${picture.hazards.length} active hazards`}
          >
            {picture.hazards.length}
          </span>
          {showChip ? <span className="rounded-full bg-paper px-2 py-1 text-xs font-bold text-ink">Updated</span> : null}
          {sim ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-sm font-semibold text-paper active:bg-white/10">
                Replay
                <ChevronDown className="size-4" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                <DropdownMenuRadioGroup value={activeScenario} onValueChange={(value) => chooseScenario(value as ScenarioId)}>
                  <DropdownMenuRadioItem value="flood" className="min-h-12 text-base">
                    Flood
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="smoke" className="min-h-12 text-base">
                    Smoke
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      <div
        className="absolute right-3 z-20 flex flex-col gap-3"
        style={{ top: expanded || selectedId ? "22%" : "46%", transform: "translateY(-50%)" }}
      >
        <MapButton label="Zoom in" onClick={() => api.current?.zoomIn()}>
          <Plus className="size-5" />
        </MapButton>
        <MapButton label="Zoom out" onClick={() => api.current?.zoomOut()}>
          <Minus className="size-5" />
        </MapButton>
        <MapButton label="Your location" onClick={locate}>
          <LocateFixed className="size-5" />
        </MapButton>
      </div>

      <Tray open={expanded} onOpenChange={setExpanded} label="Layers & details">
        <p className="text-sm text-muted-foreground">{sim ? `Sample data · ${age}` : age}</p>
        <h2 className="mt-1 text-xl font-bold">{placeTitle}</h2>
        {!sim && situation.status === "loading" ? (
          <div className="mt-4 flex flex-col gap-3" aria-hidden>
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : null}
        {!sim && situation.status === "error" ? (
          <p className="mt-3 text-base text-warning">The situation did not load. Markers stay empty until it does.</p>
        ) : null}
        <p className="mt-3 text-base leading-snug text-muted-foreground">
          Red is danger or closed. Amber is a warning or unknown. Green is open. Faded means low confidence.
        </p>
        {tileProblem ? (
          <p className="mt-3 text-base text-warning">Street map did not load. Markers are still placed.</p>
        ) : null}

        <div className="mt-5 flex flex-col" role="group" aria-label="Layers">
          {(Object.keys(LAYER_LABEL) as (keyof Layers)[]).map((key) => {
            const count =
              key === "hazards"
                ? picture.hazards.length
                : key === "resources"
                  ? picture.resources.length
                  : key === "roads"
                    ? picture.roads.length
                    : picture.people.length;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={layers[key]}
                className="flex min-h-12 items-center gap-3 rounded-xl px-1 text-left active:bg-white/10"
                onClick={() => toggleLayer(key)}
              >
                <span
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md border",
                    layers[key] ? "border-paper bg-paper text-ink" : "border-white/30",
                  )}
                  aria-hidden
                >
                  {layers[key] ? <Check className="size-4" /> : null}
                </span>
                <span className="text-lg">{LAYER_LABEL[key]}</span>
                <span className="ms-auto text-base text-muted-foreground tabular-nums">{count}</span>
              </button>
            );
          })}
        </div>

        {layers.hazards ? <Rows title="Hazards" items={hazardRows.map(hazardRow)} onOpen={select} /> : null}
        {layers.resources ? <Rows title="Shelters and aid" items={resourceRows.map(resourceRow)} onOpen={select} /> : null}
        {layers.roads ? <Rows title="Roads" items={roadRows.map(roadRow)} onOpen={select} /> : null}

        <div className="mt-6 flex flex-col items-start">
          <Link className="link-quiet px-0" href={sim ? `/alert?scenario=${activeScenario}&sim=1` : "/alert"}>
            Household brief
          </Link>
          <Link className="link-quiet px-0" href="/">
            Join
          </Link>
        </div>
      </Tray>

      <DetailSheet open={!!selected} title={selectedTitle(selected)} onClose={() => setSelectedId(null)}>
        {selected?.kind === "hazard" ? (
          <DetailBody
            titleRef={titleRef}
            title={selected.hazard.name}
            sentence={hazardSentence(selected.hazard)}
            tone={selected.hazard.severity}
            confidence={selected.hazard.confidence}
            verified={ageFor(selected.hazard.verifiedAgoSec, overrides[selected.hazard.id], now, scenario != null)}
            body={selected.hazard.summary}
            extra={selected.hazard.timing}
          />
        ) : null}
        {selected?.kind === "resource" ? (
          <>
            <DetailBody
              titleRef={titleRef}
              title={selected.resource.name}
              sentence={resourceSentence(selected.resource)}
              tone={selected.resource.status === "open" ? "safe" : selected.resource.status === "closed" ? "danger" : "warning"}
              confidence={selected.resource.confidence}
              verified={ageFor(selected.resource.verifiedAgoSec, overrides[selected.resource.id], now, scenario != null)}
              body={selected.resource.address}
              extra={resourceExtra(selected.resource)}
              note={selected.resource.note}
            />
            <Button
              type="button"
              variant="outline"
              className="mt-5 h-12 min-h-12 w-full text-base"
              onClick={() => setCheckInFor(selected.resource.id)}
            >
              Check in
            </Button>
          </>
        ) : null}
        {selected?.kind === "road" ? (
          <DetailBody
            titleRef={titleRef}
            title={selected.road.name}
            sentence={roadSentence(selected.road.status)}
            tone={selected.road.status === "slow" ? "warning" : "danger"}
            confidence={selected.road.confidence}
            verified={ageFor(selected.road.verifiedAgoSec, undefined, now, scenario != null)}
            body={selected.road.detail}
          />
        ) : null}
      </DetailSheet>

      <DetailSheet open={!!checkResource} title="Manual check-in" onClose={() => setCheckInFor(null)} z={50} scrim>
        {checkResource ? (
          <CheckInForm key={checkResource.id} resource={checkResource} onSave={(value) => saveCheckIn(checkResource.id, value)} />
        ) : null}
      </DetailSheet>
    </div>
  );
}

function MapButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex size-12 items-center justify-center rounded-full bg-ink/85 text-paper ring-1 ring-white/20 backdrop-blur-md active:bg-paper active:text-ink"
    >
      {children}
    </button>
  );
}

function Rows({
  title,
  items,
  onOpen,
}: {
  title: string;
  items: { id: string; name: string; line: string; tone: "danger" | "warning" | "safe"; low: boolean }[];
  onOpen: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <section className="mt-6">
      <h3 className="text-sm text-muted-foreground">{title}</h3>
      <div className="mt-1 flex flex-col">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onOpen(item.id)}
            className="flex min-h-14 items-center gap-3 rounded-xl py-2 text-left active:bg-white/10"
          >
            <ToneIcon tone={item.tone} />
            <span className="min-w-0">
              <span className="block text-lg leading-tight font-semibold">{item.name}</span>
              <span className="block text-base text-muted-foreground">{item.line}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function ToneIcon({ tone }: { tone: "danger" | "warning" | "safe" }) {
  const className = cn("size-5 shrink-0", tone === "danger" && "text-danger", tone === "warning" && "text-warning", tone === "safe" && "text-safe");
  if (tone === "safe") return <House className={className} aria-hidden />;
  if (tone === "warning") return <TriangleAlert className={className} aria-hidden />;
  return <Droplets className={className} aria-hidden />;
}

function DetailBody({
  titleRef,
  title,
  sentence,
  tone,
  confidence,
  verified,
  body,
  extra,
  note,
}: {
  titleRef: React.RefObject<HTMLHeadingElement | null>;
  title: string;
  sentence: string;
  tone: "danger" | "warning" | "safe";
  confidence: Confidence;
  verified: string;
  body: string;
  extra?: string;
  note?: string;
}) {
  const ConfidenceIcon = confidence === "high" ? CircleCheck : confidence === "medium" ? TriangleAlert : CircleDashed;
  return (
    <div>
      <h2 ref={titleRef} tabIndex={-1} className="text-2xl leading-tight font-bold outline-none">
        {title}
      </h2>
      <p className={cn("mt-3 flex items-center gap-2 text-lg font-semibold", tone === "danger" && "text-danger", tone === "warning" && "text-warning", tone === "safe" && "text-safe")}>
        <ToneIcon tone={tone} />
        {sentence}
      </p>
      <p className="mt-2 flex items-center gap-2 text-base text-muted-foreground">
        <ConfidenceIcon className={cn("size-5", confidence === "high" ? "text-paper" : "text-warning")} aria-hidden />
        {confidenceLabel(confidence)}
      </p>
      <p className="mt-2 text-base text-muted-foreground">{verified}</p>
      <p className="mt-4 text-lg leading-snug">{body}</p>
      {extra ? <p className="mt-2 text-lg">{extra}</p> : null}
      {note ? <p className="mt-2 text-base text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function CheckInForm({ resource, onSave }: { resource: Resource; onSave: (value: CheckIn) => void }) {
  const [status, setStatus] = useState<ResourceStatus>(resource.status);
  const [confidence, setConfidence] = useState<Confidence>(resource.confidence);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  function save() {
    setSaving(true);
    window.setTimeout(() => {
      onSave({ status, confidence, note: note.trim(), at: Date.now() });
    }, 120);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <h2 className="text-2xl font-bold">Manual check-in</h2>
      <p className="mt-2 text-base text-muted-foreground">{resource.name}</p>
      <fieldset className="mt-5">
        <legend className="text-base font-semibold">What is the status?</legend>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {(["open", "full", "closed", "unknown"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={status === option}
              onClick={() => setStatus(option)}
              className={cn(
                "min-h-12 rounded-xl px-3 text-base font-semibold active:opacity-80",
                status === option ? "bg-paper text-ink" : "bg-white/5 ring-1 ring-white/15",
              )}
            >
              {statusWord(option)}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="mt-5">
        <legend className="text-base font-semibold">How sure are you?</legend>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {(["high", "medium", "low"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={confidence === option}
              onClick={() => setConfidence(option)}
              className={cn(
                "min-h-12 rounded-xl px-2 text-base font-semibold active:opacity-80",
                confidence === option ? "bg-paper text-ink" : "bg-white/5 ring-1 ring-white/15",
              )}
            >
              {option === "high" ? "High" : option === "medium" ? "Medium" : "Low"}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="mt-5 block text-base font-semibold" htmlFor="checkin-note">
        Note
        <Input
          id="checkin-note"
          value={note}
          maxLength={140}
          placeholder="Short note, optional"
          onChange={(event) => setNote(event.target.value)}
          className="mt-2 h-12 text-base"
        />
      </label>
      <Button type="submit" className="mt-5 h-12 min-h-12 w-full text-base" disabled={saving}>
        {saving ? "Saving…" : "Save check-in"}
      </Button>
    </form>
  );
}

function hazardRow(hazard: Hazard) {
  return {
    id: hazard.id,
    name: hazard.name,
    line: hazard.confidence === "low" ? "Low confidence" : hazard.timing,
    tone: hazard.severity === "danger" ? ("danger" as const) : ("warning" as const),
    low: hazard.confidence === "low",
  };
}

function resourceRow(resource: Resource) {
  return {
    id: resource.id,
    name: resource.name,
    line: resource.confidence === "low" ? `${resourceListLine(resource)} · Low confidence` : resourceListLine(resource),
    tone: resource.status === "open" ? ("safe" as const) : resource.status === "closed" ? ("danger" as const) : ("warning" as const),
    low: resource.confidence === "low",
  };
}

function roadRow(road: Road) {
  return {
    id: road.id,
    name: road.name,
    line: road.confidence === "low" ? `${statusWord(road.status)} · Low confidence` : statusWord(road.status),
    tone: road.status === "slow" ? ("warning" as const) : ("danger" as const),
    low: road.confidence === "low",
  };
}

function rankResource(status: ResourceStatus) {
  if (status === "open") return 0;
  if (status === "unknown") return 1;
  if (status === "full") return 2;
  return 3;
}

function rankRoad(status: Road["status"]) {
  if (status === "closed" || status === "blocked") return 0;
  if (status === "slow") return 1;
  return 2;
}

function selectedTitle(selected: { kind: "hazard"; hazard: Hazard } | { kind: "resource"; resource: Resource } | { kind: "road"; road: Road } | null) {
  if (!selected) return "Details";
  if (selected.kind === "hazard") return selected.hazard.name;
  if (selected.kind === "resource") return selected.resource.name;
  return selected.road.name;
}

function ageFor(verifiedAgoSec: number, override: CheckIn | undefined, now: number, mounted: boolean) {
  if (!mounted || now === 0) return "Last verified recently";
  if (override) return verifiedLabel((now - override.at) / 1000);
  return verifiedLabel(verifiedAgoSec);
}

function resourceExtra(resource: Resource) {
  if (resource.kind === "shelter" && resource.status === "open" && resource.available != null) {
    const room = resource.capacity ? ` Room for ${resource.capacity}.` : "";
    return `${resource.available} spaces left.${room}`;
  }
  if (resource.status === "full") return "No spaces left.";
  return undefined;
}
