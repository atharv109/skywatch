/**
 * The per-language safety-floor templates (backend-build-plan.md Task 5): a fixed
 * skeleton per language (pre-translated constants, eyeballed simple by design) that
 * interpolates ONLY brief fields. Nothing outside {name}/{km}/{roads} and the
 * brief's own title/timing/action text is ever inserted, so these texts can never
 * name a place, road or number that is not in the brief. Used directly when
 * Gemini is unset / REPLAY=1, and as the forced fallback after the validator
 * rejects the model output.
 *
 * MIRROR NOTE (Task 7 fix wave 3/4): src/deliver/post_call_summary.ts keeps its
 * own post-call summary skeletons and mirrors the per-language EMERGENCY lines
 * below verbatim; the per-ACTION strings, however, are imported from this table
 * (TEMPLATES is exported) so the alert path and the post-call summary path can
 * never drift apart on an action sentence. If an emergency line changes here,
 * mirror it there — both files comment the other.
 */
import type { HazardType, Lang, UserBrief } from "../types/brief.ts";

export interface Template {
  hazard: Record<HazardType, string>;
  actions: Record<string, string>;
  shelter: string;
  roads: string;
  emergency: string;
}

export const TEMPLATES: Record<Lang, Template> = {
  en: {
    // en renders the brief's own hazard title + timing as the lead (see fallbackRender).
    hazard: { smoke: "", flood: "", aqi: "", alert: "" },
    actions: {},
    shelter: "Open shelter: {name}, about {km} km away.",
    roads: "Flooded or blocked roads: {roads}.",
    // en uses the brief's own emergency line verbatim.
    emergency: "",
  },
  es: {
    hazard: {
      smoke: "El humo de incendios está afectando su zona.",
      flood: "Hay inundaciones en su zona.",
      aqi: "El aire tiene muy mala calidad en su zona.",
      alert: "Hay un aviso oficial del clima en efecto en su zona.",
    },
    actions: {
      "close-windows": "Cierre puertas y ventanas para que no entre el humo.",
      "run-air-filter": "Encienda un filtro de aire si tiene uno.",
      "mask-if-outside": "Si sale afuera, use una mascarilla N95 o mejor.",
      "check-on-neighbors": "Llame a sus vecinos para saber si están bien.",
      "reduce-outdoor-activity": "Reduzca las actividades al aire libre.",
      "monitor-news": "Esté atento a las noticias y avisos oficiales.",
      "check-on-people": "Comuníquese con las personas que atiende.",
      "follow-official-orders": "Siga de inmediato las instrucciones de las autoridades.",
      "shelter-in-place": "Quédese adentro hasta que las autoridades digan que es seguro.",
      "avoid-floodwater": "No camine ni maneje por agua de inundación.",
      "move-upstairs": "Si sube el agua, vaya de inmediato a un lugar alto.",
      "get-ready-to-move": "Tenga una maleta lista por si las autoridades piden evacuar.",
    },
    shelter: "Refugio abierto: {name}, a unos {km} km de usted.",
    roads: "Vías inundadas o bloqueadas: {roads}.",
    emergency: "Llame al 911 si está en peligro.",
  },
  zh: {
    hazard: {
      smoke: "野火烟雾正在影响您所在的地区。",
      flood: "您所在的地区正在发生洪水。",
      aqi: "您所在地区的空气质量很差。",
      alert: "官方天气警报已在您所在的地区生效。",
    },
    actions: {
      "close-windows": "请关好门窗，防止烟雾进入。",
      "run-air-filter": "如有空气净化器，请打开。",
      "mask-if-outside": "如需外出，请佩戴N95或更好的口罩。",
      "check-on-neighbors": "请打电话询问邻居是否安全。",
      "reduce-outdoor-activity": "请减少户外活动。",
      "monitor-news": "请留意当地新闻和官方警报。",
      "check-on-people": "请确认您照顾的人是否安全。",
      "follow-official-orders": "请立即听从当地官员的指示。",
      "shelter-in-place": "请留在室内，等官员宣布安全后再外出。",
      "avoid-floodwater": "切勿步行或驾车穿过洪水。",
      "move-upstairs": "如水上涨，请立即到高处。",
      "get-ready-to-move": "请收拾好行李，随时准备撤离。",
    },
    shelter: "开放的避难所：{name}，距离约 {km} 公里。",
    roads: "被淹或封闭的道路：{roads}。",
    emergency: "如有危险，请拨打911。",
  },
  tl: {
    hazard: {
      smoke: "Apektado ang iyong lugar ng usok mula sa sunog.",
      flood: "May baha sa iyong lugar.",
      aqi: "Hindi malusog ang hangin sa iyong lugar.",
      alert: "May opisyal na babala sa panahon sa iyong lugar.",
    },
    actions: {
      "close-windows": "Isara ang mga bintana at pinto para hindi pumasok ang usok.",
      "run-air-filter": "I-on ang air filter kung mayroon ka.",
      "mask-if-outside": "Kung lalabas ka, magsuot ng N95 mask o mas mahusay pa.",
      "check-on-neighbors": "Tawagan ang mga kapitbahay para itanong kung okay sila.",
      "reduce-outdoor-activity": "Bawasan ang aktibidad sa labas.",
      "monitor-news": "Sundan ang balita at mga opisyal na babala.",
      "check-on-people": "Kamustahin ang mga taong inaalagaan mo.",
      "follow-official-orders": "Sundin agad ang utos ng lokal na opisyal.",
      "shelter-in-place": "Manatili sa loob hangga't hindi sinasabi ng mga opisyal na ligtas na.",
      "avoid-floodwater": "Huwag lumusong o magmaneho sa baha.",
      "move-upstairs": "Kung tumataas ang tubig, pumunta agad sa mataas na lugar.",
      "get-ready-to-move": "Maghanda ng bag para sa paglikas kung hihingin ng mga opisyal.",
    },
    shelter: "Bukas na tuluyan: {name}, mga {km} km ang layo.",
    roads: "Bumabaha o sarado na mga daan: {roads}.",
    emergency: "Tumawag sa 911 kung nasa panganib ka.",
  },
  vi: {
    hazard: {
      smoke: "Khói cháy rừng đang ảnh hưởng đến khu vực của bạn.",
      flood: "Khu vực của bạn đang có lũ lụt.",
      aqi: "Không khí ô nhiễm đang ảnh hưởng đến khu vực của bạn.",
      alert: "Cảnh báo thời tiết chính thức đang có hiệu lực tại khu vực của bạn.",
    },
    actions: {
      "close-windows": "Hãy đóng cửa sổ và cửa ra vào để khói không vào nhà.",
      "run-air-filter": "Nếu có máy lọc không khí, hãy bật lên.",
      "mask-if-outside": "Nếu ra ngoài, hãy đeo khẩu trang N95 hoặc tốt hơn.",
      "check-on-neighbors": "Gọi điện hỏi thăm hàng xóm xem họ có an toàn không.",
      "reduce-outdoor-activity": "Hạn chế các hoạt động ngoài trời.",
      "monitor-news": "Theo dõi tin tức địa phương và các cảnh báo chính thức.",
      "check-on-people": "Hỏi thăm những người bạn đang chăm sóc.",
      "follow-official-orders": "Ngay lập tức làm theo hướng dẫn của chính quyền địa phương.",
      "shelter-in-place": "Ở trong nhà cho đến khi chính quyền báo là an toàn.",
      "avoid-floodwater": "Không đi bộ hay lái xe qua vùng nước lũ.",
      "move-upstairs": "Nếu nước dâng, hãy chuyển ngay đến nơi cao.",
      "get-ready-to-move": "Chuẩn bị sẵn đồ để sơ tán khi chính quyền yêu cầu.",
    },
    shelter: "Nơi trú ẩn đang mở: {name}, cách khoảng {km} km.",
    roads: "Đường bị ngập hoặc bị chặn: {roads}.",
    emergency: "Gọi 911 nếu bạn gặp nguy hiểm.",
  },
  ar: {
    hazard: {
      smoke: "دخان حرائق الغابات يؤثر على منطقتك.",
      flood: "توجد فيضانات في منطقتك.",
      aqi: "جودة الهواء سيئة جدا في منطقتك.",
      alert: "تنبيه رسمي من الأرصاد ساري في منطقتك.",
    },
    actions: {
      "close-windows": "أغلق النوافذ والأبواب حتى لا يدخل الدخان.",
      "run-air-filter": "شغل جهاز تنقية الهواء إذا كان متوفرا.",
      "mask-if-outside": "إذا خرجت، ضع كمامة N95 أو أفضل.",
      "check-on-neighbors": "اتصل بجيرانك للتأكد من سلامتهم.",
      "reduce-outdoor-activity": "قلل الأنشطة في الخارج.",
      "monitor-news": "تابع الأخبار المحلية والتنبيهات الرسمية.",
      "check-on-people": "تأكد من سلامة الأشخاص الذين تعتني بهم.",
      "follow-official-orders": "اتبع تعليمات الجهات المحلية فورا.",
      "shelter-in-place": "ابق في الداخل حتى تعلن الجهات أن الوضع آمن.",
      "avoid-floodwater": "لا تمش أو قد السيارة في مياه الفيضان.",
      "move-upstairs": "إذا ارتفع الماء، انتقل فورا إلى مكان مرتفع.",
      "get-ready-to-move": "جهز حقيبة للإخلاء إذا طلبت الجهات ذلك.",
    },
    shelter: "مأوى مفتوح: {name}، على بُعد {km} كم تقريبا.",
    roads: "طرق مغمورة أو مغلقة: {roads}.",
    emergency: "اتصل بالرقم 911 إذا كنت في خطر.",
  },
};

function interpolate(skeleton: string, name: string, km: number): string {
  return skeleton.replace("{name}", name).replace("{km}", String(km));
}

/**
 * The fixed skeleton, worst hazard first. Drop order when > MAX chars is fixed:
 * roads sentence, 2nd action, shelter sentence, 1st action, lead; the emergency
 * line is never dropped, so the result is always within the 300-char bound
 * (enforced in tests against the worst-case brief).
 */
export function fallbackRender(brief: UserBrief): { text: string; voiceScript: string } {
  const t = TEMPLATES[brief.lang];
  const isEn = brief.lang === "en";
  const worst = brief.hazards[0];
  const emergency = isEn && brief.emergency.trim().length > 0 ? brief.emergency : t.emergency;
  const lead = !worst
    ? null
    : isEn
      ? `${worst.title} — ${worst.timing}.`
      : t.hazard[worst.type] || null;
  const actions = brief.actions
    .slice(0, 2)
    .map((a) => (isEn ? a.text : t.actions[a.id] ?? ""))
    .filter((s) => s.length > 0);
  const shelter = brief.shelter ? interpolate(t.shelter, brief.shelter.name, brief.shelter.distanceKm) : null;
  const roads =
    brief.blockedRoads.length > 0
      ? t.roads.replace("{roads}", brief.blockedRoads.map((r) => r.name).join(", "))
      : null;

  // Ordered parts in DISPLAY order, each tagged with how dispensable it is
  // (higher = dropped first when the text exceeds the 300-char bound).
  const parts: Array<{ text: string; drop: number }> = [
    { text: lead ?? "", drop: 4 },
    { text: actions[0] ?? "", drop: 3 },
    { text: actions[1] ?? "", drop: 1 },
    { text: shelter ?? "", drop: 2 },
    { text: roads ?? "", drop: 0 },
  ].filter((p) => p.text.length > 0);
  const kept = [...parts];
  const join = () => [...kept.map((p) => p.text), emergency].join(" ");
  while (join().length > 300 && kept.length > 0) {
    let worstIdx = 0;
    for (let i = 1; i < kept.length; i++) {
      if (kept[i]!.drop > kept[worstIdx]!.drop) worstIdx = i;
    }
    kept.splice(worstIdx, 1);
  }
  const text = join();
  return { text, voiceScript: text };
}