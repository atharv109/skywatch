export const LANGS = ["en", "es", "zh", "tl", "vi", "ar"] as const;

export type Lang = (typeof LANGS)[number];

export function isLang(value: string | undefined | null): value is Lang {
  return !!value && (LANGS as readonly string[]).includes(value);
}

export const LANGUAGE_NAMES: Record<Lang, string> = {
  en: "English",
  es: "Español",
  zh: "中文",
  tl: "Tagalog",
  vi: "Tiếng Việt",
  ar: "العربية",
};

export const FONT_FAMILY: Record<Lang, string> = {
  en: "var(--font-sans), sans-serif",
  es: "var(--font-sans), sans-serif",
  tl: "var(--font-sans), sans-serif",
  vi: "var(--font-vi), var(--font-sans), sans-serif",
  zh: "var(--font-sc), var(--font-sans), sans-serif",
  ar: "var(--font-ar), var(--font-sans), sans-serif",
};

function latin(text: string) {
  return `\u2066${text}\u2069`;
}

type Copy = Record<Lang, string>;

function t(value: Copy): Copy {
  return value;
}

export const OFFICIAL_SOURCE = "https://www.acgov.org/emergencysite/";

const ui = {
  sample: t({
    en: "Sample data",
    es: "Datos de muestra",
    zh: "示例数据",
    tl: "Halimbawang datos",
    vi: "Dữ liệu mẫu",
    ar: "بيانات تجريبية",
  }),
  whatToDo: t({
    en: "What to do",
    es: "Qué hacer",
    zh: "请这样做",
    tl: "Gawin ito",
    vi: "Việc cần làm",
    ar: "ما الذي تفعله",
  }),
  shelterHeading: t({
    en: "Shelter",
    es: "Refugio",
    zh: "避难所",
    tl: "Silungan",
    vi: "Nơi trú ẩn",
    ar: "الملجأ",
  }),
  roadsHeading: t({
    en: "Roads",
    es: "Calles",
    zh: "道路",
    tl: "Mga kalsada",
    vi: "Đường",
    ar: "الطرق",
  }),
  call911: t({
    en: "Call 911 if you are in danger.",
    es: "Llama al 911 si estás en peligro.",
    zh: "如果有危险，请拨打 911。",
    tl: "Tumawag sa 911 kung nasa panganib ka.",
    vi: "Gọi 911 nếu bạn đang gặp nguy hiểm.",
    ar: "اتصل بالرقم 911 إذا كنت في خطر.",
  }),
  offlineBanner: t({
    en: "Offline — showing the last brief saved on this phone.",
    es: "Sin conexión — este es el último aviso guardado en el teléfono.",
    zh: "离线 — 这是手机上保存的最新简报。",
    tl: "Walang signal — ito ang huling abiso na naka-save sa telepono.",
    vi: "Mất mạng — đây là bản tin cuối đã lưu trên điện thoại.",
    ar: "بدون اتصال — هذا آخر تنبيه محفوظ على الهاتف.",
  }),
  lowConfidence: t({
    en: "Low confidence",
    es: "Confianza baja",
    zh: "尚未确认",
    tl: "Hindi pa kumpirmado",
    vi: "Chưa được xác minh",
    ar: "غير مؤكّد",
  }),
  noShelter: t({
    en: "No verified-open shelter nearby right now.",
    es: "Ahora no hay un refugio verificado y abierto cerca.",
    zh: "附近目前没有已核实开放的避难所。",
    tl: "Walang napatunayang bukas na silungan sa malapit ngayon.",
    vi: "Hiện không có nơi trú ẩn nào gần đây đã được xác minh là đang mở.",
    ar: "لا يوجد ملجأ مفتوح ومُتحقَّق منه بالقرب منك الآن.",
  }),
  sourceLabel: t({
    en: "Official updates",
    es: "Información oficial",
    zh: "官方信息",
    tl: "Opisyal na update",
    vi: "Thông tin chính thức",
    ar: "التحديث الرسمي",
  }),
  sourceName: t({
    en: "Alameda County Emergency",
    es: "Emergencias del Condado de Alameda",
    zh: "阿拉米达县应急信息",
    tl: "Emergency ng Alameda County",
    vi: "Khẩn cấp Quận Alameda",
    ar: "طوارئ مقاطعة ألاميدا",
  }),
  closed: t({
    en: "Closed",
    es: "Cerrado",
    zh: "封闭",
    tl: "Sarado",
    vi: "Đóng",
    ar: "مغلق",
  }),
  slow: t({
    en: "Slow",
    es: "Lento",
    zh: "缓行",
    tl: "Mabagal",
    vi: "Chậm",
    ar: "بطيء",
  }),
  blocked: t({
    en: "Blocked",
    es: "Bloqueado",
    zh: "阻断",
    tl: "Barado",
    vi: "Tắc",
    ar: "مسدود",
  }),
};

const floodHazards = [
  {
    severity: "danger" as const,
    lowConfidence: false,
    title: t({
      en: "Flood warning",
      es: "Aviso de inundación",
      zh: "洪水警报",
      tl: "Babala sa baha",
      vi: "Cảnh báo lũ",
      ar: "تحذير من فيضان",
    }),
    summary: t({
      en: "Mandela Parkway creek is over its banks.",
      es: "El arroyo de Mandela Parkway se salió de su cauce.",
      zh: "Mandela Parkway 的溪流已经漫出河岸。",
      tl: "Umalos ang sapa sa Mandela Parkway.",
      vi: "Suối dọc Mandela Parkway đã tràn bờ.",
      ar: `فاض جدول ${latin("Mandela Parkway")} عن ضفتيه.`,
    }),
    timing: t({
      en: "Until 6:00 PM",
      es: "Hasta las 6:00 p. m.",
      zh: "持续到下午 6:00",
      tl: "Hanggang 6:00 PM",
      vi: "Đến 6:00 chiều",
      ar: "حتى الساعة 6:00 مساءً",
    }),
  },
  {
    severity: "warning" as const,
    lowConfidence: false,
    title: t({
      en: "Standing water",
      es: "Agua estancada",
      zh: "积水",
      tl: "Nakatigil na tubig",
      vi: "Nước đọng",
      ar: "مياه راكدة",
    }),
    summary: t({
      en: "Ponds on side streets near 3rd Street.",
      es: "Hay charcos en las calles laterales cerca de 3rd Street.",
      zh: "3rd Street 附近的小路有积水。",
      tl: "May nakatambak na tubig sa mga gilid ng kalye malapit sa 3rd Street.",
      vi: "Nước đọng trên các đường nhỏ gần 3rd Street.",
      ar: "مياه متجمّعة في الشوارع الجانبية قرب الشارع الثالث.",
    }),
    timing: t({
      en: "Until the water drains",
      es: "Hasta que baje el agua",
      zh: "直到水退去",
      tl: "Hanggang humupa ang tubig",
      vi: "Cho đến khi nước rút",
      ar: "حتى ينحسر الماء",
    }),
  },
];

const smokeHazards = [
  {
    severity: "danger" as const,
    lowConfidence: false,
    title: t({
      en: "Unhealthy smoke",
      es: "Humo dañino",
      zh: "有害烟雾",
      tl: "Mapanganib na usok",
      vi: "Khói độc hại",
      ar: "دخان ضار",
    }),
    summary: t({
      en: "Wildfire smoke is over West Oakland.",
      es: "El humo del incendio cubre West Oakland.",
      zh: "野火烟雾正笼罩 West Oakland。",
      tl: "May usok mula sa sunog sa kagubatan sa West Oakland.",
      vi: "Khói cháy rừng đang bao phủ West Oakland.",
      ar: `دخان حريق الغابات يغطي ${latin("West Oakland")}.`,
    }),
    timing: t({
      en: "Through tonight",
      es: "Hasta esta noche",
      zh: "持续到今晚",
      tl: "Hanggang ngayong gabi",
      vi: "Suốt đêm nay",
      ar: "حتى نهاية الليلة",
    }),
  },
  {
    severity: "warning" as const,
    lowConfidence: true,
    title: t({
      en: "Ash in the air",
      es: "Ceniza en el aire",
      zh: "空气中有灰",
      tl: "May abo sa hangin",
      vi: "Tro trong không khí",
      ar: "رماد في الهواء",
    }),
    summary: t({
      en: "Reports near the port. Not verified yet.",
      es: "Hay reportes cerca del puerto. Aún no se confirman.",
      zh: "港口附近有人报告。尚未核实。",
      tl: "May mga ulat malapit sa pantalan. Hindi pa kumpirmado.",
      vi: "Có báo cáo gần cảng. Chưa được xác minh.",
      ar: "بلاغات قرب الميناء. لم يتم التحقق بعد.",
    }),
    timing: ui.lowConfidence,
  },
];

const floodActions: Copy[] = [
  t({
    en: "If water is rising around you, go up to the second floor or a roof you can get down from.",
    es: "Si el agua sube a tu alrededor, sube al segundo piso o a un techo del que puedas bajar.",
    zh: "如果周围水位在上涨，请上到二楼，或上到能下来的屋顶。",
    tl: "Kung tumataas ang tubig sa paligid mo, umakyat sa ikalawang palapag o sa bubong na kayang lusutan pababa.",
    vi: "Nếu nước đang dâng quanh bạn, hãy lên tầng hai hoặc lên mái nhà mà bạn có thể xuống được.",
    ar: "إذا كان الماء يرتفع حولك، اصعد إلى الطابق الثاني أو إلى سطح يمكنك النزول منه.",
  }),
  t({
    en: "Do not walk or drive through floodwater.",
    es: "No camines ni manejes por el agua de la inundación.",
    zh: "不要步行或开车穿过洪水。",
    tl: "Huwag maglakad o magmaneho sa baha.",
    vi: "Đừng đi bộ hoặc lái xe qua nước lũ.",
    ar: "لا تمشِ ولا تقد عبر مياه الفيضان.",
  }),
  t({
    en: "Stay off Mandela Parkway and the I-880 ramp.",
    es: "Aléjate de Mandela Parkway y de la rampa de la I-880.",
    zh: "不要走 Mandela Parkway 和 I-880 匝道。",
    tl: "Iwasan ang Mandela Parkway at ang ramp ng I-880.",
    vi: "Tránh Mandela Parkway và lối lên I-880.",
    ar: `ابتعد عن ${latin("Mandela Parkway")} وعن مخرج ${latin("I-880")}.`,
  }),
  t({
    en: "Charge your phone and keep it with you.",
    es: "Carga tu teléfono y llévalo contigo.",
    zh: "把手机充满电，并带在身边。",
    tl: "I-charge ang telepono at dalhin ito.",
    vi: "Sạc điện thoại và mang theo.",
    ar: "اشحن هاتفك وأبقِه معك.",
  }),
  t({
    en: "Tell your household where you will meet before you move.",
    es: "Antes de moverte, dile a tu familia dónde se van a encontrar.",
    zh: "动身前，先告诉家人会合地点。",
    tl: "Sabihin sa sambahayan kung saan kayo magkikita bago ka lumipat.",
    vi: "Nói cho người nhà biết nơi gặp nhau trước khi rời đi.",
    ar: "أخبر أسرتك بمكان اللقاء قبل أن تتحرك.",
  }),
];

const smokeActions: Copy[] = [
  t({
    en: "Stay inside. Close windows and doors.",
    es: "Quédate adentro. Cierra ventanas y puertas.",
    zh: "留在室内。关上窗和门。",
    tl: "Manatili sa loob. Isara ang mga bintana at pinto.",
    vi: "Ở trong nhà. Đóng cửa sổ và cửa ra vào.",
    ar: "ابقَ في الداخل. أغلق النوافذ والأبواب.",
  }),
  t({
    en: "If you must go out, wear a mask that seals to your face.",
    es: "Si tienes que salir, usa una mascarilla que selle contra la cara.",
    zh: "如果必须外出，请戴上能贴合面部的口罩。",
    tl: "Kung kailangan lumabas, magsuot ng mask na dikit sa mukha.",
    vi: "Nếu phải ra ngoài, hãy đeo khẩu trang khít với mặt.",
    ar: "إذا اضطررت للخروج، ضع كمامة تُحكم على وجهك.",
  }),
  t({
    en: "Do not run a generator or a grill indoors.",
    es: "No enciendas un generador ni una parrilla adentro.",
    zh: "不要在室内使用发电机或烧烤炉。",
    tl: "Huwag magpatakbo ng generator o mag-ihaw sa loob ng bahay.",
    vi: "Đừng chạy máy phát điện hoặc nướng trong nhà.",
    ar: "لا تشغّل مولّدًا أو شواية داخل البيت.",
  }),
  t({
    en: "Check on neighbors who are older or who have asthma.",
    es: "Revisa a los vecinos mayores o con asma.",
    zh: "看看年长或有哮喘的邻居是否平安。",
    tl: "Tingnan ang mga kapitbahay na matatanda o may hika.",
    vi: "Hỏi thăm hàng xóm lớn tuổi hoặc người bị hen.",
    ar: "اطمئن على الجيران كبار السن أو المصابين بالربو.",
  }),
  t({
    en: "If someone cannot breathe, call 911.",
    es: "Si alguien no puede respirar, llama al 911.",
    zh: "如果有人无法呼吸，请拨打 911。",
    tl: "Kung may hindi makahinga, tumawag sa 911.",
    vi: "Nếu ai đó không thở được, gọi 911.",
    ar: "إذا لم يستطع أحد التنفس، اتصل بالرقم 911.",
  }),
];

const floodRoads = [
  { name: "Mandela Pkwy at 7th", status: "closed" as const },
  { name: "I-880 ramp at 7th", status: "closed" as const },
];

const smokeRoads = [
  { name: "7th St at Wood", status: "slow" as const },
  { name: "Maritime St", status: "closed" as const },
];

function shelterLine(lang: Lang, distance: string, name: string): string {
  if (lang === "en") return `Open shelter ${distance} km away — ${name}`;
  if (lang === "es") return `Refugio abierto a ${distance} km — ${name}`;
  if (lang === "zh") return `${distance} 公里外有开放的避难所 — ${name}`;
  if (lang === "tl") return `May bukas na silungan, ${distance} km ang layo — ${name}`;
  if (lang === "vi") return `Có nơi trú ẩn đang mở, cách ${distance} km — ${name}`;
  return `ملجأ مفتوح على بعد ${distance} كم — ${latin(name)}`;
}

export type BriefHazard = {
  severity: "danger" | "warning";
  lowConfidence: boolean;
  title: string;
  summary: string;
  timing: string;
};

export type Brief = {
  sample: string;
  whatToDo: string;
  shelterHeading: string;
  roadsHeading: string;
  call911: string;
  offlineBanner: string;
  lowConfidence: string;
  hazards: BriefHazard[];
  actions: string[];
  shelter:
    | { open: true; line: string; address: string }
    | { open: false; line: string; sourceLabel: string; sourceName: string; href: string };
  roads: { name: string; status: "closed" | "slow" | "blocked"; statusLabel: string }[];
};

export function getBrief(scenario: "flood" | "smoke", lang: Lang, distance: string): Brief {
  const hazards = scenario === "flood" ? floodHazards : smokeHazards;
  const actions = (scenario === "flood" ? floodActions : smokeActions).map((item) => item[lang]);
  const roads = (scenario === "flood" ? floodRoads : smokeRoads).map((road) => ({
    name: road.name,
    status: road.status,
    statusLabel: ui[road.status][lang],
  }));

  if (actions.length > 5 || roads.length > 2) {
    throw new Error("Brief is over the limit");
  }

  const shelter =
    scenario === "flood"
      ? {
          open: true as const,
          line: shelterLine(lang, distance, "Green Community Center"),
          address: "1247 Peralta St",
        }
      : {
          open: false as const,
          line: ui.noShelter[lang],
          sourceLabel: ui.sourceLabel[lang],
          sourceName: ui.sourceName[lang],
          href: OFFICIAL_SOURCE,
        };

  return {
    sample: ui.sample[lang],
    whatToDo: ui.whatToDo[lang],
    shelterHeading: ui.shelterHeading[lang],
    roadsHeading: ui.roadsHeading[lang],
    call911: ui.call911[lang],
    offlineBanner: ui.offlineBanner[lang],
    lowConfidence: ui.lowConfidence[lang],
    hazards: hazards.map((hazard) => ({
      severity: hazard.severity,
      lowConfidence: hazard.lowConfidence,
      title: hazard.title[lang],
      summary: hazard.summary[lang],
      timing: hazard.timing[lang],
    })),
    actions,
    shelter,
    roads,
  };
}

export const offlineCopy = {
  offline: t({
    en: "Offline — using local mesh",
    es: "Sin conexión — usando los teléfonos cercanos",
    zh: "离线 — 正在使用附近的手机",
    tl: "Walang signal — gamit ang mga teleponong malapit",
    vi: "Mất mạng — đang dùng điện thoại gần đây",
    ar: "بدون اتصال — نستخدم الهواتف القريبة",
  }),
  syncing: t({
    en: "Syncing…",
    es: "Sincronizando…",
    zh: "正在同步…",
    tl: "Nagsi-sync…",
    vi: "Đang đồng bộ…",
    ar: "جارٍ المزامنة…",
  }),
  online: t({
    en: "Phone is online",
    es: "El teléfono tiene señal",
    zh: "手机已联网",
    tl: "May signal ang telepono",
    vi: "Điện thoại đã có mạng",
    ar: "الهاتف متصل",
  }),
  sync: t({
    en: "Sync when online",
    es: "Sincronizar cuando haya señal",
    zh: "有网络时同步",
    tl: "I-sync kapag may signal",
    vi: "Đồng bộ khi có mạng",
    ar: "زامن عند عودة الاتصال",
  }),
  syncHelp: t({
    en: "This turns on when the phone has a signal.",
    es: "Se activa cuando el teléfono tenga señal.",
    zh: "手机有信号时可以点。",
    tl: "Magbubukas ito kapag may signal ang telepono.",
    vi: "Nút này bật khi điện thoại có sóng.",
    ar: "يعمل هذا الزر عندما تتوفر إشارة.",
  }),
  device: t({
    en: "Your device is registered locally.",
    es: "Tu teléfono está registrado en este aparato.",
    zh: "这部手机已在本地登记。",
    tl: "Nakarehistro nang lokal ang telepono mo.",
    vi: "Điện thoại này đã được đăng ký trên máy.",
    ar: "هاتفك مسجّل على هذا الجهاز.",
  }),
  heard: t({
    en: "Heard nearby",
    es: "Escuchado cerca",
    zh: "附近收到的",
    tl: "Narinig sa malapit",
    vi: "Nghe được gần đây",
    ar: "ما وصل من الجوار",
  }),
  empty: t({
    en: "No local messages yet.",
    es: "Todavía no hay mensajes locales.",
    zh: "还没有本地消息。",
    tl: "Wala pang lokal na mensahe.",
    vi: "Chưa có tin nhắn trên máy.",
    ar: "لا توجد رسائل محلية بعد.",
  }),
  back: t({
    en: "Back to the number",
    es: "Volver al número",
    zh: "返回号码",
    tl: "Bumalik sa numero",
    vi: "Về trang số điện thoại",
    ar: "العودة إلى الرقم",
  }),
  sample: t({
    en: "Sample messages on this phone.",
    es: "Mensajes de muestra en este teléfono.",
    zh: "这部手机上的示例消息。",
    tl: "Mga halimbawang mensahe sa teleponong ito.",
    vi: "Tin nhắn mẫu trên điện thoại này.",
    ar: "رسائل تجريبية على هذا الهاتف.",
  }),
  kinds: {
    flood: t({
      en: "Flood hazard",
      es: "Peligro de inundación",
      zh: "洪水危险",
      tl: "Panganib ng baha",
      vi: "Nguy hiểm lũ",
      ar: "خطر فيضان",
    }),
    shelter: t({
      en: "Shelter beacon",
      es: "Señal de refugio",
      zh: "避难所信号",
      tl: "Senyas ng silungan",
      vi: "Tín hiệu nơi trú ẩn",
      ar: "إشارة ملجأ",
    }),
    road: t({
      en: "Road closure",
      es: "Calle cerrada",
      zh: "道路封闭",
      tl: "Saradong kalsada",
      vi: "Đường đóng",
      ar: "طريق مغلق",
    }),
    beacon: t({
      en: "Nearby phone",
      es: "Teléfono cercano",
      zh: "附近的手机",
      tl: "Malapit na telepono",
      vi: "Điện thoại gần đây",
      ar: "هاتف قريب",
    }),
    water: t({
      en: "Standing water",
      es: "Agua estancada",
      zh: "积水",
      tl: "Nakatigil na tubig",
      vi: "Nước đọng",
      ar: "مياه راكدة",
    }),
  },
  near: t({
    en: "From a nearby phone",
    es: "Desde un teléfono cercano",
    zh: "来自附近的手机",
    tl: "Mula sa malapit na telepono",
    vi: "Từ điện thoại gần đây",
    ar: "من هاتف قريب",
  }),
  far: t({
    en: "Passed along the mesh",
    es: "Pasado entre teléfonos",
    zh: "经其他手机传来",
    tl: "Ipinasa ng ibang telepono",
    vi: "Được chuyển qua điện thoại khác",
    ar: "مُرِّر عبر هواتف أخرى",
  }),
};

export function hopLabel(lang: Lang, hops: number): string {
  if (lang === "en") return hops === 1 ? "1 hop" : `${hops} hops`;
  if (lang === "es") return hops === 1 ? "1 salto" : `${hops} saltos`;
  if (lang === "zh") return `${hops} 跳`;
  if (lang === "tl") return hops === 1 ? "1 hop" : `${hops} hops`;
  if (lang === "vi") return `${hops} chặng`;
  return hops === 1 ? "قفزة واحدة" : `${hops} قفزات`;
}

export function keyEnding(lang: Lang, key: string): string {
  if (lang === "en") return `Key ending in ${key}`;
  if (lang === "es") return `La clave termina en ${key}`;
  if (lang === "zh") return `密钥末尾是 ${key}`;
  if (lang === "tl") return `Nagtatapos sa ${key} ang susi`;
  if (lang === "vi") return `Khóa kết thúc bằng ${key}`;
  return `ينتهي المفتاح بـ ${key}`;
}
