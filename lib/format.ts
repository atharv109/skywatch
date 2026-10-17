import type { Lang } from "@/lib/i18n";

export function distanceKm(a: [number, number], b: [number, number]): number {
  const earth = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatKm(km: number, lang: Lang): string {
  const rounded = (Math.round(km * 10) / 10).toFixed(1);
  if (lang === "es" || lang === "vi") return rounded.replace(".", ",");
  return rounded;
}

const justNow: Record<Lang, string> = {
  en: "updated just now",
  es: "actualizado ahora",
  zh: "刚刚更新",
  tl: "kaka-update lang",
  vi: "vừa cập nhật",
  ar: "تم التحديث الآن",
};

export function freshness(seconds: number, lang: Lang): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 5) return justNow[lang];
  if (s < 60) {
    const line: Record<Lang, string> = {
      en: `updated ${s} s ago`,
      es: `actualizado hace ${s} s`,
      zh: `${s} 秒前更新`,
      tl: `na-update ${s} s ang nakalipas`,
      vi: `cập nhật ${s} giây trước`,
      ar: `تم التحديث قبل ${s} ث`,
    };
    return line[lang];
  }
  const minutes = Math.max(1, Math.round(s / 60));
  if (minutes < 60) {
    const line: Record<Lang, string> = {
      en: `updated ${minutes} min ago`,
      es: `actualizado hace ${minutes} min`,
      zh: `${minutes} 分钟前更新`,
      tl: `na-update ${minutes} min ang nakalipas`,
      vi: `cập nhật ${minutes} phút trước`,
      ar: `تم التحديث قبل ${minutes} د`,
    };
    return line[lang];
  }
  const hours = Math.round(minutes / 60);
  const line: Record<Lang, string> = {
    en: `updated ${hours} h ago`,
    es: `actualizado hace ${hours} h`,
    zh: `${hours} 小时前更新`,
    tl: `na-update ${hours} oras ang nakalipas`,
    vi: `cập nhật ${hours} giờ trước`,
    ar: `تم التحديث قبل ${hours} س`,
  };
  return line[lang];
}

export function verifiedLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 5) return "Last verified just now";
  if (s < 60) return `Last verified ${s} s ago`;
  const minutes = Math.max(1, Math.round(s / 60));
  if (minutes < 60) return `Last verified ${minutes} min ago`;
  return `Last verified ${Math.round(minutes / 60)} h ago`;
}
