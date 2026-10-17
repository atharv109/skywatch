import { cookies } from "next/headers";
import { Suspense } from "react";
import { AlertScreen } from "@/components/alert/alert-screen";
import { isLang, type Lang } from "@/lib/i18n";
import type { ScenarioId } from "@/lib/types";

async function Brief({
  searchParams,
}: {
  searchParams: Promise<{ scenario?: string | string[] }>;
}) {
  const [query, jar] = await Promise.all([searchParams, cookies()]);
  const raw = Array.isArray(query.scenario) ? query.scenario[0] : query.scenario;
  const fromCookie = jar.get("skywatch-scenario")?.value;
  const picked = raw ?? fromCookie;
  const scenario: ScenarioId = picked === "smoke" ? "smoke" : "flood";
  const langValue = jar.get("skywatch-lang")?.value;
  const lang: Lang = isLang(langValue) ? langValue : "en";
  return <AlertScreen initialLang={lang} initialScenario={scenario} />;
}

export default function AlertPage({
  searchParams,
}: {
  searchParams: Promise<{ scenario?: string | string[] }>;
}) {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-ink" />}>
      <Brief searchParams={searchParams} />
    </Suspense>
  );
}
