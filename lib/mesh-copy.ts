import type { Lang } from "@/lib/i18n";

type Line = Record<Lang, string>;

function t(value: Line): Line {
  return value;
}

export const meshCopy = {
  neighbors: t({ en: "Neighbors", es: "Vecinos", zh: "邻居", tl: "Kapitbahay", vi: "Hàng xóm", ar: "الجيران" }),
  direct: t({ en: "Direct", es: "Directo", zh: "私信", tl: "Direkta", vi: "Tin nhắn riêng", ar: "مباشر" }),
  relayed: t({
    en: "Relayed by a node with signal",
    es: "Reenviado por un nodo con señal",
    zh: "由有信号的节点转发",
    tl: "Ipinasa ng node na may signal",
    vi: "Chuyển bởi một nút còn sóng",
    ar: "مُرَّر عبر نقطة لديها إشارة",
  }),
  placeholder: t({
    en: "Message neighbors",
    es: "Mensaje a los vecinos",
    zh: "给邻居发消息",
    tl: "Mensahe sa kapitbahay",
    vi: "Nhắn cho hàng xóm",
    ar: "راسل الجيران",
  }),
  send: t({ en: "Send", es: "Enviar", zh: "发送", tl: "Ipadala", vi: "Gửi", ar: "إرسال" }),
  photo: t({ en: "Add a photo", es: "Añadir foto", zh: "添加照片", tl: "Magdagdag ng larawan", vi: "Thêm ảnh", ar: "أضف صورة" }),
  emptyNeighbors: t({
    en: "No neighbor messages on this phone yet.",
    es: "Todavía no hay mensajes de vecinos en este teléfono.",
    zh: "这部手机上还没有邻居的消息。",
    tl: "Wala pang mensahe ng kapitbahay sa teleponong ito.",
    vi: "Điện thoại này chưa có tin nhắn hàng xóm.",
    ar: "لا رسائل من الجيران على هذا الهاتف بعد.",
  }),
  emptyDirect: t({
    en: "No direct messages yet.",
    es: "Todavía no hay mensajes directos.",
    zh: "还没有私信。",
    tl: "Wala pang direktang mensahe.",
    vi: "Chưa có tin nhắn riêng.",
    ar: "لا رسائل مباشرة بعد.",
  }),
  onPhone: t({
    en: "On this phone only",
    es: "Solo en este teléfono",
    zh: "只在这部手机上",
    tl: "Sa teleponong ito lang",
    vi: "Chỉ trên điện thoại này",
    ar: "على هذا الهاتف فقط",
  }),
  satelliteLive: t({
    en: "Satellite data loaded — live at sync",
    es: "Datos de satélite cargados — en vivo al sincronizar",
    zh: "卫星数据已载入 — 同步时是实时的",
    tl: "Naka-load ang satellite data — live sa sync",
    vi: "Đã tải dữ liệu vệ tinh — trực tiếp khi đồng bộ",
    ar: "حُمّلت بيانات القمر — مباشرة عند المزامنة",
  }),
  satelliteSample: t({
    en: "Sample satellite layer for this demo.",
    es: "Capa de satélite de muestra para esta demo.",
    zh: "这是演示用的卫星图层。",
    tl: "Sample na satellite layer para sa demo.",
    vi: "Lớp vệ tinh mẫu cho bản demo.",
    ar: "طبقة قمر تجريبية لهذا العرض.",
  }),
  air: t({ en: "Air", es: "Aire", zh: "空气", tl: "Hangin", vi: "Không khí", ar: "الهواء" }),
  back: t({ en: "Back", es: "Volver", zh: "返回", tl: "Bumalik", vi: "Quay lại", ar: "رجوع" }),
  skywatch: t({ en: "Skywatch", es: "Skywatch", zh: "Skywatch", tl: "Skywatch", vi: "Skywatch", ar: "Skywatch" }),
  home: t({ en: "Home", es: "Inicio", zh: "首页", tl: "Home", vi: "Trang chủ", ar: "الرئيسية" }),
  brief: t({
    en: "Last brief from a node with signal",
    es: "Último aviso de un nodo con señal",
    zh: "来自有信号节点的最新简报",
    tl: "Huling abiso mula sa node na may signal",
    vi: "Bản tin cuối từ một nút còn sóng",
    ar: "آخر تنبيه من نقطة لديها إشارة",
  }),
  photoHold: t({
    en: "The photo stays on this phone until sync.",
    es: "La foto se queda en este teléfono hasta sincronizar.",
    zh: "照片会留在这部手机上，直到同步。",
    tl: "Mananatili ang larawan sa teleponong ito hanggang sa sync.",
    vi: "Ảnh ở trên điện thoại này cho đến khi đồng bộ.",
    ar: "تبقى الصورة على هذا الهاتف حتى المزامنة.",
  }),
  oem: t({
    en: "Seattle Emergency Management",
    es: "Gestión de emergencias de Seattle",
    zh: "西雅图应急管理",
    tl: "Seattle Emergency Management",
    vi: "Quản lý khẩn cấp Seattle",
    ar: "إدارة الطوارئ في سياتل",
  }),
};

export const chips: Record<Lang, string[]> = {
  en: ["I am safe", "Need water", "Road is blocked", "Anyone nearby?"],
  es: ["Estoy a salvo", "Necesito agua", "La calle está cerrada", "¿Hay alguien cerca?"],
  zh: ["我很安全", "需要水", "路不通", "附近有人吗？"],
  tl: ["Ligtas ako", "Kailangan ng tubig", "Sarado ang kalsada", "May tao ba malapit?"],
  vi: ["Tôi an toàn", "Cần nước", "Đường bị chặn", "Có ai gần đây?"],
  ar: ["أنا بخير", "أحتاج ماء", "الطريق مغلق", "هل هناك أحد قريب؟"],
};

export const kindLabel: Record<Lang, Record<string, string>> = {
  en: { "ROAD BROKEN": "Road broken", FIRE: "Fire", "SAFE PLACE": "Safe place", FLOOD: "Flood", OTHER: "Other" },
  es: { "ROAD BROKEN": "Calle rota", FIRE: "Fuego", "SAFE PLACE": "Lugar seguro", FLOOD: "Inundación", OTHER: "Otro" },
  zh: { "ROAD BROKEN": "道路损坏", FIRE: "火灾", "SAFE PLACE": "安全地点", FLOOD: "洪水", OTHER: "其他" },
  tl: { "ROAD BROKEN": "Sirang kalsada", FIRE: "Sunog", "SAFE PLACE": "Ligtas na lugar", FLOOD: "Baha", OTHER: "Iba pa" },
  vi: { "ROAD BROKEN": "Đường hỏng", FIRE: "Cháy", "SAFE PLACE": "Nơi an toàn", FLOOD: "Lũ", OTHER: "Khác" },
  ar: { "ROAD BROKEN": "طريق مكسور", FIRE: "حريق", "SAFE PLACE": "مكان آمن", FLOOD: "فيضان", OTHER: "أخرى" },
};

export const joinCopy = {
  title: t({ en: "Join by text", es: "Únete por mensaje", zh: "用短信加入", tl: "Sumali sa text", vi: "Tham gia bằng tin nhắn", ar: "انضم برسالة" }),
  body: t({
    en: "Text hi to Skywatch from your phone. This page does not ask you to type a number.",
    es: "Manda hi a Skywatch desde tu teléfono. Esta página no pide que escribas un número.",
    zh: "用你的手机给 Skywatch 发 hi。这个页面不会让你填写号码。",
    tl: "I-text ang hi sa Skywatch mula sa telepono mo. Hindi hihilingin ng pahinang ito na mag-type ka ng numero.",
    vi: "Nhắn hi cho Skywatch từ điện thoại của bạn. Trang này không yêu cầu bạn nhập số.",
    ar: "أرسل hi إلى Skywatch من هاتفك. هذه الصفحة لا تطلب منك كتابة رقم.",
  }),
  demo: t({
    en: "Watch the demo signup",
    es: "Ver el registro de demostración",
    zh: "查看演示注册",
    tl: "Panoorin ang demo signup",
    vi: "Xem đăng ký demo",
    ar: "شاهد تسجيل العرض",
  }),
  sent: t({
    en: "Demo signup reached this phone. The text gateway did not answer.",
    es: "El registro de demostración llegó a este teléfono. La pasarela de texto no respondió.",
    zh: "演示注册到了这部手机。短信网关没有回应。",
    tl: "Dumating ang demo signup sa teleponong ito. Hindi sumagot ang text gateway.",
    vi: "Đăng ký demo đã tới điện thoại này. Cổng tin nhắn không trả lời.",
    ar: "وصل تسجيل العرض إلى هذا الهاتف. بوابة الرسائل لم ترد.",
  }),
  ok: t({
    en: "Demo signup sent.",
    es: "Registro de demostración enviado.",
    zh: "演示注册已发送。",
    tl: "Naipadala ang demo signup.",
    vi: "Đã gửi đăng ký demo.",
    ar: "أُرسل تسجيل العرض.",
  }),
  fromYou: t({ en: "from you", es: "desde ti", zh: "离你", tl: "mula sa iyo", vi: "từ bạn", ar: "منك" }),
  fromSample: t({
    en: "from a sample home in Seattle, not your location",
    es: "desde una casa de muestra en Seattle, no tu ubicación",
    zh: "从西雅图的示例住所算起，不是你的位置",
    tl: "mula sa sample na bahay sa Seattle, hindi ang lokasyon mo",
    vi: "từ một nhà mẫu ở Seattle, không phải vị trí của bạn",
    ar: "من منزل تجريبي في سياتل، وليس موقعك",
  }),
  loading: t({ en: "Loading the brief…", es: "Cargando el aviso…", zh: "正在加载简报…", tl: "Kinakarga ang abiso…", vi: "Đang tải bản tin…", ar: "جارٍ تحميل التنبيه…" }),
  failed: t({
    en: "The brief did not load. The actions below are still here.",
    es: "El aviso no cargó. Las acciones de abajo siguen aquí.",
    zh: "简报没有加载。下面的做法还在。",
    tl: "Hindi na-load ang abiso. Nandito pa rin ang mga gagawin sa ibaba.",
    vi: "Bản tin chưa tải được. Các việc bên dưới vẫn còn.",
    ar: "لم يُحمَّل التنبيه. الإجراءات بالأسفل ما زالت هنا.",
  }),
};
