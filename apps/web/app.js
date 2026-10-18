/**
 * Skywatch app-demo (APP-EXPERIENCE) — a phone-app simulation of the product,
 * vanilla JS, no build. Talks to the REAL backend only:
 *   GET  /health
 *   GET  /map/state                 — hazards, resources, roads, userDots, ?mesh
 *   GET  /mesh/state                — beacons, hazard reports, coverage, messages, counts
 *   POST /mesh/sync                 — {deviceId, lat, lon, packets[]} → outcome + DownlinkBundle
 *   POST /webhooks/photon/message   — the simulated SMS thread, signed per src/deliver/photon.ts
 *   GET  /tools/brief/byPhone/:platform/:phone — the app's own brief (TOOL_SECRET; src/routes/tools.ts)
 *
 * Mirrored constants (signup.ts / post_call_summary.ts / downlink.ts) are labeled
 * MIRROR in place — the real Photon send path is not wired yet, so signup replies
 * render here from the same state machine with an honest note.
 *
 * Network mode (the core concept): online → offline (user-triggered or auto on
 * fetch failure) → gateway (queued packets POST /mesh/sync, downlink bundle is
 * rebroadcast) → back online. AUTO-detect is the default state machine: window
 * online/offline events + a ~5 s /health liveness loop while dark drive the
 * transitions (OFFLINE + signal → auto-Gateway sync → /health OK → ONLINE);
 * a manual Profile pick sets netOverride and overrides the detector while set.
 * The same liveness tick drains queued mesh traffic while ONLINE (online + a
 * non-empty queue = you are the gateway), so nothing sits queued above a 5G bar.
 * Queued packets sign via WebCrypto Ed25519 exactly
 * per src/mesh/sig.ts: msg = `id|type|ts|lat|lon|deviceId`, base64 raw key+sig,
 * TOFU pinning; deviceId = 10-hex sha256 prefix of the RAW pubkey (per-session
 * identity — reload = new neighbor).
 */
(function () {
  "use strict";

  /* =========================================================================
   * tiny dom + utils
   * =======================================================================*/

  const $ = (sel, el) => (el || document).querySelector(sel);
  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const haptic = (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (_e) { /* no haptics */ } };

  const phoneEl = $("#phone");
  const screens = { home: $("#screen-home"), map: $("#screen-map"), mesh: $("#screen-mesh"), profile: $("#screen-profile") };

  function fmtClock(d) {
    d = d || new Date();
    let hh = d.getHours() % 12 || 12;
    const mm = String(d.getMinutes()).padStart(2, "0");
    return hh + ":" + mm;
  }
  function fmtRel(msAgo) {
    if (!msAgo || msAgo < 0 || !isFinite(msAgo)) return "just now";
    const m = Math.round(msAgo / 60000);
    if (m < 1) return "under a minute ago";
    if (m === 1) return "1 min ago";
    if (m < 60) return m + " min ago";
    const h = Math.floor(m / 60);
    if (h === 1) return "1 hr ago";
    if (h < 24) return h + " hr ago";
    return Math.round(h / 24) + " days ago";
  }
  function fmtAgo(ts) { return fmtRel(Date.now() - ts); }

  /** sha256 hex of bytes (used for the deviceId hash prefix). */
  async function sha256HexPrefix(uint8, chars) {
    const digest = await crypto.subtle.digest("SHA-256", uint8);
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, chars || 10);
  }

  function rawB64ToBytes(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }
  function bytesToRawB64(bytes) { return btoa(Array.from(bytes, (c) => String.fromCharCode(c)).join("")); }

  /* =========================================================================
   * persistent state
   * =======================================================================*/

  const LS = {
    cfg: "skywatch.cfg",          // { api, toolSecret, photonSecret }
    profile: "skywatch.profile",  // { phone, platform, lang, address, zip, onboarded, consent }
    cache: "skywatch.cache",      // { brief:{data,at}, mapState:{…}, mesh:{…} }
    queue: "skywatch.queue",      // queued uplink packets (content only — signed at send)
    thread: "skywatch.thread",    // simulated SMS thread [{from, text, at, kind}]
    flags: "skywatch.flags",      // { configSeen, callShown, walkSeen, pendingSummary }
    loc: "skywatch.loc",          // { lat, lon, label }
  };

  function lsGet(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (_e) { return fallback; }
  }
  function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (_e) { /* storage unavailable — session only */ } }

  function loadAll() {
    state.cfg = lsGet(LS.cfg, { api: "", toolSecret: "", photonSecret: "" });
    const q = new URLSearchParams(location.search);
    if (q.get("api")) state.cfg.api = q.get("api").replace(/\/+$/, "");
    state.profile = lsGet(LS.profile, {});
    state.queue = lsGet(LS.queue, []);
    state.thread = lsGet(LS.thread, []);
    state.flags = lsGet(LS.flags, {});
    state.loc = lsGet(LS.loc, null);
  }
  const persist = {
    profile() { lsSet(LS.profile, state.profile); },
    queue() { lsSet(LS.queue, state.queue); },
    thread() { lsSet(LS.thread, state.thread); },
    flags() { lsSet(LS.flags, state.flags); },
    cache() { lsSet(LS.cache, state.cache); },
    loc() { lsSet(LS.loc, state.loc); },
  };

  /* runtime state */
  const state = {
    mode: "online",            // 'online' | 'offline' | 'gateway'
    autoOff: false,            // true = we degraded automatically (auto restore applies)
    netOverride: null,         // null = AUTO-detect; 'online'|'offline'|'gateway' = manual pin
    cfg: null, profile: null, queue: [], thread: [], flags: {}, loc: null,
    cache: lsGet(LS.cache, {}),   // { brief, mapState, mesh } → {data, at}
    brief: null, mapState: null, meshState: null,
    syncState: null,           // last POST /mesh/sync outcome + at
    bundle: null,              // last downlink bundle
    tab: "home",
    identity: null,            // per-session Ed25519 identity
    ob: null,                  // onboarding flow state
    polls: {},                 // timers
    healthTimer: null,
    loading: { brief: true, map: true, mesh: true },
    lastErrors: {}, fails: {},
  };

  /* MIRROR: templates live in src/deliver/signup.ts — the real Photon send path is
   * not wired, so the simulated thread renders these verbatim, noted honestly in-app. */
  const MIRRORED = {
    welcome: "Hi! Skywatch sends emergency smoke + flood alerts near you, with text updates and optional voice check-in calls. What's your home address or WA ZIP code? Reply STOP at any time to opt out.",
    askLang: "Got it — you're signed up. Which language should alerts use? Reply with one of: English / Español / 中文 / Tiếng Việt / Tagalog / العربية.",
    langOk: (name) => `Skywatch alerts will be sent in ${name}. You're all set — we'll message you only when something urgent is inside your area.`,
    active: "You're on Skywatch for your area. We'll message you here only when there's an urgent hazard nearby; reply STOP to opt out anytime.",
    stopNote: "You replied STOP. Consent is off and this number is removed — and by design, no reply follows.",
  };
  const LANGS = [
    { code: "en", name: "English", phrase: "english" },
    { code: "es", name: "Español", phrase: "espanol por favor" },
    { code: "zh", name: "中文 (Mandarin)", phrase: "中文" },
    { code: "tl", name: "Tagalog / Filipino", phrase: "tagalog" },
    { code: "vi", name: "Tiếng Việt", phrase: "tieng viet" },
    { code: "ar", name: "العربية (Arabic)", phrase: "عربي" },
  ];
  const LANG_NAMES = { en: "English", es: "Español", zh: "中文", tl: "Tagalog", vi: "Tiếng Việt", ar: "العربية" };
  /* Ask Skywatch quick prompts — answers are deterministic, built from brief facts only */
  const ASKS = ["is the shelter still open?", "where do I go?", "what's the air like?"];

  /* =========================================================================
   * mode switching (THE core concept)
   * =======================================================================*/

  const bannerEl = $("#banner");

  function showBanner(text, tone, sticky) {
    bannerEl.hidden = false;
    bannerEl.className = "banner banner-t-" + tone;
    $("#bannerText").textContent = text;
    if (!sticky) {
      clearTimeout(showBanner._t);
      showBanner._t = setTimeout(() => { bannerEl.hidden = true; }, 4200);
    }
  }

  /** ONLINE fetch failed → degrade for real. */
  function degrade(reason) {
    if (state.mode !== "online") return;
    state.netOverride = null; // a real outage hands control back to AUTO
    setMode("offline", { auto: true, quiet: false, reason });
  }

  function isAutoNet() { return state.netOverride === null; }

  function setMode(mode, opts) {
    opts = opts || {};
    const prev = state.mode;
    if (prev === mode && !opts.force) { renderProfile(); return; }
    state.mode = mode;
    stopHealthRetry();
    haptic(12);

    if (mode === "offline") {
      state.autoOff = !!opts.auto;
      showBanner(opts.auto ? "Connection lost — entering mesh mode." : "You're offline — mesh mode.", "off", true);
      // a follow-up text is queued for whenever the signal comes back
      state.flags.pendingSummary = !!(state.brief && (state.brief.hazards || []).length > 0);
      persist.flags();
      toast("New reports queue locally and send when one of us gets signal.", "mesh");
    } else if (mode === "gateway") {
      showBanner(opts.source === "auto" ? "Signal found — syncing the mesh…" : "You have signal — carrying the mesh's messages up.", "gw", true);
      if (opts.source === "auto") flashStatusChip("Gateway", "mesh");
    } else if (mode === "online") {
      bannerEl.hidden = false;
      showBanner(opts.fromGateway ? "Back online — everyone's news is out." : opts.quiet ? "Signal restored." : "Back online — syncing your brief.", "ok");
      restoreOnline(opts);
    }
    phoneEl.dataset.mode = mode;
    renderAll();
    if (mode === "gateway") void safe(syncGateway()).then(renderMesh);
    startHealthRetry(); // runs in every mode — liveness/offline flip + ONLINE queue drain
  }

  /* AUTO detection — one state machine drives the status bar: window
   * online/offline events + the /health liveness loop (below) while dark.
   * OFFLINE + 2 consecutive /health 200s (or an `online` event) → auto-Gateway
   * (sync the whole queue); GATEWAY, manual or auto, + /health OK → back ONLINE.
   * A manual Profile pick (state.netOverride) overrides all of it while set. */
  let liveStreak = 0;     // consecutive /health 200s while OFFLINE (flip needs 2 of 2)
  let gwInFlight = false; // a /mesh/sync POST is mid-flight — don't race it into ONLINE
  let healthTimer = null;

  function startHealthRetry() {
    stopHealthRetry();
    healthTimer = setInterval(async () => {
      if (state.netOverride === "offline") return; // manual "force demo offline" stays dark
      const res = await probeHealth();
      if (state.mode === "offline") {
        liveStreak = res ? liveStreak + 1 : 0;
        if (liveStreak >= 2 && isAutoNet()) autoToGateway();
      } else if (state.mode === "gateway") {
        if (res && !gwInFlight) autoToOnline();
      } else if (res && !gwInFlight) {
        // ONLINE drain: queued mesh traffic means you're carrying the mesh —
        // one silent gateway sync per tick until the queue empties.
        const pending = state.queue.filter((p) => p.state === "queued" || p.state === "fail");
        if (!pending.length) return;
        const out = await safe(() => syncGateway({ silent: true }));
        if (out) {
          flashStatusChip("synced — " + (out.received != null ? out.received : pending.length) + " sent", "ok");
          if (state.tab === "mesh") {
            const draft = $("#meshText") ? $("#meshText").value : ""; // keep a half-typed draft
            renderMesh();
            const ta = $("#meshText");
            if (ta && draft) { ta.value = draft; $("#meshCount").textContent = String(280 - draft.length); }
          }
        }
      }
    }, 5000);
  }
  function stopHealthRetry() { if (healthTimer) { clearInterval(healthTimer); healthTimer = null; } }

  function autoToGateway() {
    liveStreak = 0;
    state.netOverride = null;
    setMode("gateway", { force: true, source: "auto" });
  }
  function autoToOnline() {
    state.netOverride = null;
    setMode("online", { fromGateway: true });
  }

  async function restoreOnline(opts) {
    state.autoOff = false;
    stopHealthRetry();
    await resyncAll(true);
    // queued packets: this phone has signal again — send them with the gateway batch.
    if (state.queue.length > 0) {
      try { await syncGateway({ silent: true }); toast("Your queued reports went out with the sync.", "ok"); }
      catch (_e) { toast("Queue still pending — try the gateway in Mesh.", "warn"); }
    }
    if (state.flags.pendingSummary) {
      state.flags.pendingSummary = false; persist.flags();
      appendSummaryCard();
    }
  }

  async function probeHealth() {
    try {
      const r = await fetch(apiBase() + "/health", { signal: timeoutSig(3500) });
      return r.ok;
    } catch (_e) { return false; }
  }

  /* small transient chip inside the status bar — e.g. "Gateway" flashes there
   * while an auto-detected gateway run carries the mesh up */
  function flashStatusChip(label, tone) {
    const host = $(".sb-right");
    let c = $("#sbFlash");
    if (!c) {
      c = document.createElement("span");
      c.id = "sbFlash";
      host.insertBefore(c, $(".sb-batt", host));
    }
    c.className = "chip chip-" + (tone || "n") + " sb-flash";
    c.textContent = label;
    c.hidden = false;
    clearTimeout(flashStatusChip._t);
    flashStatusChip._t = setTimeout(() => { c.hidden = true; }, 3600);
  }

  /* harness-level signal events: connectivity arriving lifts AUTO-OFFLINE to
   * Gateway; the adapter dying under a live ONLINE mode degrades it */
  window.addEventListener("online", () => {
    if (state.mode === "offline" && isAutoNet()) autoToGateway();
  });
  window.addEventListener("offline", () => degrade("offline event"));

  /* =========================================================================
   * config + first run
   * =======================================================================*/

  function apiBase() {
    const b = (state.cfg && state.cfg.api) || "";
    return b.replace(/\/+$/, "");
  }

  const ICONS = {
    home: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/></svg>',
    map: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3 3 5.4v15.3L9 18.3l6 2.4 6-2.4V3l-6 2.4L9 3z"/><path d="M9 3v15.3M15 5.4v15.3"/></svg>',
    mesh: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="5" cy="6" r="2.4"/><circle cx="19" cy="6" r="2.4"/><circle cx="12" cy="13" r="2.4"/><circle cx="5.6" cy="19.4" r="2.4"/><circle cx="18.4" cy="19.4" r="2.4"/><path d="M6.9 7.7 10.6 11.4M17.1 7.7 13.4 11.4M11 15 7 17.6M13 15l4 2.6"/></svg>',
    profile: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-3.4 3.6-5.4 7-5.4s6.2 2 7 5.4"/></svg>',
    shield: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7.5 3.2v4.9c0 4.3-3.2 8.1-7.5 9.4-4.3-1.3-7.5-5.1-7.5-9.4V6.2L12 3z"/></svg>',
    shieldCheck: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7.5 3.2v4.9c0 4.3-3.2 8.1-7.5 9.4-4.3-1.3-7.5-5.1-7.5-9.4V6.2L12 3z"/><path d="M9 11.6l2.1 2.1L15.4 9"/></svg>',
    alert: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 22 20H2L12 3.5z"/><path d="M12 9.5v4.5"/><path d="M12 17h.01"/></svg>',
    pin: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6.5-5.4-6.5-10a6.5 6.5 0 0 1 13 0C18.5 15.6 12 21 12 21z"/><circle cx="12" cy="10.6" r="2.3"/></svg>',
    phone: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3h3l1.5 4.2-2 1.5a12 12 0 0 0 6.3 6.3l1.5-2L21 14.5v3A2.5 2.5 0 0 1 18.5 20 15.5 15.5 0 0 1 4 5.5 2.5 2.5 0 0 1 6.5 3z"/></svg>',
    endcall: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 14.5c5-3.6 12-3.6 17 0l-2.6 2.6a2 2 0 0 1-2.4.4 11 11 0 0 0-7 0 2 2 0 0 1-2.4-.4L3.5 14.5z"/></svg>',
    call: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3h3l1.5 4.2-2 1.5a12 12 0 0 0 6.3 6.3l1.5-2L21 14.5v3A2.5 2.5 0 0 1 18.5 20 15.5 15.5 0 0 1 4 5.5 2.5 2.5 0 0 1 6.5 3z"/></svg>',
    sms: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.2a8.4 8.4 0 0 1-8.7 8.3 9 9 0 0 1-3.7-.7L3 20l1.4-4.4a8 8 0 0 1-1-3.9A8.4 8.4 0 0 1 12.3 3 8.4 8.4 0 0 1 21 11.2z"/></svg>',
    link: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a5 5 0 0 0 7.1 0l2.2-2.2a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7.1 0l-2.2 2.2a5 5 0 0 0 7 7l1-1"/></svg>',
    wifi: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 9.5a14 14 0 0 1 19 0"/><path d="M5.5 13a10 10 0 0 1 13 0"/><path d="M8.5 16.4a6 6 0 0 1 7 0"/><path d="M12 20h.01"/></svg>',
    meshOn: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="2.2"/><circle cx="4.5" cy="7" r="1.7"/><circle cx="19.5" cy="7" r="1.7"/><circle cx="7" cy="18.5" r="1.7"/><circle cx="17" cy="18.5" r="1.7"/><path d="M11 10.5 6 8.2M13 10.5l5-2.3M10.5 13.8 8 17M13.5 13.8 15.7 17"/></svg>',
    stop: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 2v20"/><path d="M12 8l6-4v16l-6-4M12 12 3 8v8l9-4"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 4.5 4.5L19.5 6.5"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11.8 21 3.5l-8.3 17.5-2.2-7.1-7-2.1z"/></svg>',
    queue: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="13" height="13" rx="3"/><path d="M9 20h8a3 3 0 0 0 3-3V9"/></svg>',
    sync: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 5.5v5h-5"/><path d="M4 18.5v-5h5"/><path d="M5.5 9a8 8 0 0 1 13-2.5l1.5 1.5M4.5 16l1.5 1.5a8 8 0 0 0 13-2.5"/></svg>',
    user: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-3.4 3.6-5.4 7-5.4s6.2 2 7 5.4"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 10.5V17M12 7.5h.01"/></svg>',
  };

  const TABS = [
    { id: "home", label: "Home", icon: ICONS.home },
    { id: "map", label: "Map", icon: ICONS.map },
    { id: "mesh", label: "Mesh", icon: ICONS.mesh },
    { id: "profile", label: "Profile", icon: ICONS.profile },
  ];

  function buildTabbar() {
    const bar = $("#tabbar");
    bar.innerHTML = TABS.map((t) =>
      `<button class="tab${t.id === "home" ? " active" : ""}" data-tab="${t.id}" role="tab" aria-selected="${t.id === "home"}" aria-label="${t.label}">${t.icon}<span>${t.label}</span></button>`
    ).join("");
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest(".tab");
      if (btn) switchTab(btn.dataset.tab);
    });
  }

  function switchTab(tab) {
    if (!screens[tab]) return;
    haptic(6);
    state.tab = tab;
    Object.entries(screens).forEach(([id, el]) => {
      const on = id === tab;
      el.classList.toggle("active", on);
    });
    Array.from($("#tabbar").children).forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
      b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    });
    if (tab === "map") { fitMapSoon(); }
    if (tab === "mesh") { renderMesh(); }
    if (tab === "profile") { renderProfile(); }
  }

  /* =========================================================================
   * the api helper — every fetch has an error path
   * =======================================================================*/

  function timeoutSig(ms) {
    try { return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined; }
    catch (_e) { return undefined; }
  }

  const apiFetch = async (path, opts) => {
    opts = opts || {};
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    const secret = (opts.toolSecret !== undefined ? opts.toolSecret : state.cfg.toolSecret) || "";
    if (secret) headers["X-Skywatch-Tool-Secret"] = secret;
    let r;
    try {
      r = await fetch(apiBase() + path, {
        method: opts.method || "GET",
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: timeoutSig(opts.timeoutMs || 9000),
      });
    } catch (err) {
      throw { network: true, message: String(err && err.message || err) };
    }
    if (r.status === 502) { // proxy speaks for a dead upstream
      throw { network: true, status: r.status };
    }
    let json = null;
    try { json = await r.json(); } catch (_e) { json = null; }
    return { ok: r.ok, status: r.status, json };
  };

  /** Wrap a fetch op; any failure while ONLINE degrades to mesh mode (real transition). */
  async function guarding(op, tag) {
    try { return await op(); }
    catch (err) {
      if (err && err.network) { degrade(tag || err.message); return null; }
      throw err;
    }
  }
  /**
   * App-layer 5xx with a JSON body (like the known listUserDots null-loc 503) is a
   * data failure, not a tower outage — retry silently, degrade after 3 in a row.
   * Network-level failures degrade immediately (apiFetch throws network:true).
   */
  async function guarding(op, tag) {
    try { return await op(); }
    catch (err) {
      if (err && err.network) { degrade(tag || err.message); return null; }
      throw err;
    }
  }
  function failTick(tag) {
    const n = (state.fails[tag] || 0) + 1;
    state.fails[tag] = n;
    if (n >= 3) { state.fails[tag] = 0; degrade(tag); }
  }
  function failReset(tag) { state.fails[tag] = 0; }
  async function safe(op) { try { return await op(); } catch (_e) { return null; } }

  /* =========================================================================
   * data sync (online polls)
   * =======================================================================*/

  function cacheData(key, data) {
    state.cache[key] = { data, at: Date.now() };
    persist.cache();
  }
  function cached(key) {
    // prefer live data when in any connected mode
    if (state.mode !== "offline" && state[key]) return { data: state[key], at: Date.now(), live: true };
    const c = state.cache[key];
    return c || null;
  }

  async function resyncAll(quiet) {
    await Promise.allSettled([fetchBrief(quiet), fetchMapState(), fetchMeshState()]);
    renderAll();
  }

  async function fetchBrief(quiet) {
    if (!isSignedUp()) return;
    state.loading.brief = true;
    const phone = state.profile.phone;
    const result = await guarding(async () => {
      return apiFetch(`/tools/brief/byPhone/${state.profile.platform}/${phone}`, { timeoutMs: 8000 });
    }, "brief");
    state.loading.brief = false;
    if (!result) return;
    if (result.status === 404) {
      // unknown user / no location yet — honest note; onboarding fixes it.
      state.brief = null; state.briefNote = "No brief yet — finish signup and Skywatch will text you here too.";
      lastErrors("brief", 404); failReset("brief");
    } else if (result.status === 401) {
      state.brief = null; state.briefNote = "This device needs the TOOL_SECRET to read its brief (Profile → connection details)."; failReset("brief");
    } else if (!result.ok) {
      failTick("brief");
      lastErrors("brief", result.status);
    } else {
      failReset("brief");
      state.brief = result.json; state.briefNote = null;
      cacheData("brief", result.json);
      if (!quiet) toast("Brief updated.", "ok");
    }
  }

  function lastErrors(k, v) { state.lastErrors[k] = v; }

  async function fetchMapState() {
    state.loading.map = true;
    const result = await guarding(async () => apiFetch("/map/state"), "map");
    state.loading.map = false;
    if (!result) return;
    if (!result.ok) { if (result.status >= 500) failTick("map"); return; }
    failReset("map");
    state.mapState = result.json;
    cacheData("mapState", result.json);
  }

  async function fetchMeshState() {
    state.loading.mesh = true;
    const result = await guarding(async () => apiFetch("/mesh/state"), "mesh");
    state.loading.mesh = false;
    if (!result) return;
    if (!result.ok) { if (result.status >= 500) failTick("mesh"); return; }
    failReset("mesh");
    state.meshState = result.json;
    cacheData("mesh", result.json);
    renderMeshBadge();
  }

  function pollOnce() {
    if (state.mode !== "online") return;
    void safe(fetchBrief(true));
    void safe(fetchMapState());
    void safe(fetchMeshState());
  }
  function startPolling() {
    stopPolling();
    state.polls.tick = setInterval(() => { if (!document.hidden) pollOnce(); }, 12000);
  }
  function stopPolling() { if (state.polls.tick) clearInterval(state.polls.tick); state.polls.tick = null; }

  function isSignedUp() { return !!(state.profile && state.profile.phone); }
  function isOnboarded() { return !!(state.profile && state.profile.onboarded); }

  /* location: default + browser fix */
  const DEFAULT_LOC = { lat: 47.6040, lon: -122.3321, label: "Seattle waterfront (demo default)" };
  function myLoc() {
    return state.loc || DEFAULT_LOC;
  }
  function askGeolocate() {
    if (!navigator.geolocation) { toast("No location available here — using the demo preset.", "warn"); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.loc = {
          lat: +pos.coords.latitude.toFixed(5),
          lon: +pos.coords.longitude.toFixed(5),
          label: "Your device location",
          acc: Math.max(1, Math.round(pos.coords.accuracy || 0)),
        };
        persist.loc();
        fitMapSoon();
        renderProfile();
        if (state.tab === "mesh") renderMesh(); // locbar + composer chip live here too
        toast("Reporting from your device location (±" + state.loc.acc + " m).", "ok");
      },
      () => toast("No location shared — still reporting from the demo preset.", "warn"),
      { timeout: 6000 },
    );
  }

  /* =========================================================================
   * SMS thread (simulated Photon text; signed webhook POST is real)
   * =======================================================================*/

  function threadPush(from, text, kind) {
    state.thread.push({ from, text, at: Date.now(), kind: kind || null });
    state.thread = state.thread.slice(-60);
    persist.thread();
  }
  function appendSummaryCard() {
    const brief = state.brief || (state.cache.brief || {}).data;
    if (!brief) return;
    const worst = (brief.hazards || [])[0];
    const parts = [];
    parts.push(worst ? `Skywatch follow-up: ${worst.title} — ${worst.timing}.` : "Skywatch follow-up.");
    const shelter = brief.shelter;
    parts.push(shelter && shelter.status === "open" ? `${shelter.name} is verified open` : "check the official source for shelter status");
    parts.push(brief.emergency || "Call 911 if you are in danger.");
    const text = parts.join(" ").slice(0, 300);
    threadPush("bot", text, "summary");
    toast("New text — call follow-up.", "ok");
    renderHome();
  }
  function maskPhone(p) {
    const s = String(p || "");
    return s.length > 9 ? s.slice(0, 7) + "***" + s.slice(-3) : s;
  }

  /** Sign + POST one inbound text through the real webhook (src/deliver/photon.ts v0 scheme). */
  async function sendTextWebhook(text) {
    const secret = (state.cfg.photonSecret || "").trim();
    const phone = state.profile.phone;
    const payload = {
      event: "messages",
      space: { id: "any;-;" + phone, platform: "SMS", type: "dm", phone: "+15551239999" },
      message: {
        id: "spc-msg-app-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
        platform: "SMS", direction: "inbound", timestamp: new Date().toISOString(),
        sender: { id: phone, platform: "SMS" },
        content: { type: "text", text },
      },
    };
    const raw = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { "Content-Type": "application/json", "X-Spectrum-Timestamp": ts };
    if (secret) {
      // MIRROR of verifyPhotonSignature's signed string: "v0:<ts>:<rawBody>"
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${raw}`));
      headers["X-Spectrum-Signature"] = "v0=" + Array.from(new Uint8Array(sigBuf), (b) => b.toString(16).padStart(2, "0")).join("");
    } else {
      headers["X-Spectrum-Signature"] = "v0=missing";
    }
    try {
      const r = await fetch(apiBase() + "/webhooks/photon/message", { method: "POST", headers, body: raw, signal: timeoutSig(8000) });
      return { ok: r.ok, status: r.status, json: await r.json().catch(() => null) };
    } catch (_e) {
      return { ok: false, status: 0, network: true };
    }
  }

  /* =========================================================================
   * onboarding — mirrors the signup state machine (src/deliver/signup.ts)
   * =======================================================================*/

  const obEl = $("#onboard");

  function newSignupPhone() {
    return "+1555" + String(2000000 + Math.floor(Math.random() * 7999999));
  }

  function startOnboarding() {
    if (!state.profile.phone) { state.profile.phone = newSignupPhone(); state.profile.platform = "sms"; persist.profile(); }
    state.ob = { step: 0, obQueue: [], addressSent: false, langSent: false, langPick: null };
    obEl.hidden = false;
    renderOb();
  }

  function obDone() {
    obEl.hidden = true;
    state.profile.onboarded = true;
    persist.profile();
    threadPush("system", "Signed up — Skywatch now texts this number.", "note");
    toast("You're signed up. Texts land in Home.", "ok");
    renderHome();
    // on actual phones the floating chip can't show — walkthrough fires here
    if (window.innerWidth <= 520 && !state.flags.walkSeen) openWalkthrough();
    resyncAll(true).then(() => {
      setTimeout(() => {
        const brief = state.brief;
        if (!state.flags.callShown && brief && brief.hazards && brief.hazards.length > 0) {
          state.flags.callShown = true; persist.flags();
          startCall();
        }
      }, 6000);
    });
  }

  async function obSend(text, mirroredReply, next) {
    // real webhook first (if online)
    if (state.mode === "online") {
      const res = await sendTextWebhook(text);
      if (res.network || res.status >= 500) {
        threadPush("user", text, "ob");
        toast("Signal dropped mid-signup — report queued.", "mesh");
        degrade("onboarding");
        return false;
      }
      threadPush("user", text, res.ok ? "ob" : "ob-err");
      if (!res.ok) { toast("Webhook refused the message (" + res.status + ")", "warn"); }
      else if (mirroredReply) threadPush("bot", mirroredReply, "mirror");
    } else {
      threadPush("user", text, "queued");
      toast("Saved in the thread — will send when one of us gets signal.", "mesh");
    }
    return true;
  }

  function renderOb() {
    const ob = state.ob;
    if (!ob) return;
    const footer =
      ob.step === 0
        ? `<button class="btn btn-primary btn-block" id="obNext">Continue</button>`
        : ob.step === 2
          ? `<button class="btn btn-ok btn-block" id="obFinish">Turn on Skywatch</button>`
          : `<button class="btn btn-primary btn-block" id="obNext" disabled>Continue</button>`;

    if (ob.step === 0) {
      obEl.innerHTML = `
        <div class="onboard-brand">${ICONS.shield}<span>Skywatch · SMS</span></div>
        <div class="ob-sms">
          <div class="ob-msgr"><div class="ob-msg me">hi</div></div>
          <div class="ob-msgr"><div class="ob-msg bot">${esc(MIRRORED.welcome)}</div></div>
          <p class="ob-hint">Replies arrive over SMS; in this demo read them here (same state machine, same copy).</p>
        </div>
        <h2>Getting you set up</h2>
        <p class="sub">This demo signs you up through the real webhook your phone would hit. Say hi, share where to watch, pick your language.</p>
        <div class="ob-foot">${footer}</div>`;
      $("#obNext", obEl).addEventListener("click", async () => {
        haptic(8);
        const ok = await obSend("hi", MIRRORED.welcome);
        if (ok) { ob.step = 1; renderOb(); }
      });
    } else if (ob.step === 1) {
      obEl.innerHTML = `
        <div class="onboard-brand">${ICONS.shield}<span>Skywatch · SMS</span></div>
        <h2>Where should we watch?</h2>
        <p class="sub">Your home address or a 5-digit WA ZIP code — same question the bot texts you.</p>
        <label class="fld" for="obAddr">Home address or WA ZIP</label>
        <input id="obAddr" type="text" inputmode="text" autocomplete="street-address" placeholder="101 Yesler Way, Seattle, WA 98104">
        <button class="btn btn-block" id="obAddrSend" style="margin-top:12px">${ICONS.send} Send as text</button>
        <div id="obLangZone" style="display:none">
          <h2 style="font-size:18px">Your language for alerts</h2>
          <div class="lang-rows">
            ${LANGS.map((l) => `<button class="lang-row" data-lang="${l.code}" data-phrase="${esc(l.phrase)}" aria-pressed="false"><span>${esc(l.name)}</span><small>${l.code.toUpperCase()}</small></button>`).join("")}
          </div>
        </div>
        <div class="ob-foot">${footer}</div>`;
      $("#obAddrSend", obEl).addEventListener("click", async () => {
        const addr = $("#obAddr", obEl).value.trim();
        if (addr.length < 4) { toast("Type a full address or a WA ZIP — the bot geocodes it for real.", "warn"); return; }
        haptic(8);
        state.profile.address = addr;
        const ok = await obSend(addr, addr.match(/(?:^|\D)(\d{5})(?=\D|$)/) ? MIRRORED.askLang : MIRRORED.askLang);
        $("#obAddrSend", obEl).disabled = true;
        $("#obLangZone", obEl).style.display = "block";
        $("#obLangZone", obEl).scrollIntoView({ behavior: "smooth", block: "start" });
        const langZone = $("#obLangZone", obEl);
        langZone.querySelectorAll(".lang-row").forEach((row) => {
          row.addEventListener("click", async () => {
            haptic(6);
            langZone.querySelectorAll(".lang-row").forEach((r) => r.setAttribute("aria-pressed", "false"));
            row.setAttribute("aria-pressed", "true");
            const lang = row.dataset.lang;
            state.profile.lang = lang; persist.profile();
            const phrase = LANGS.find((l) => l.code === lang).phrase;
            await obSend(phrase, MIRRORED.langOk(LANG_NAMES[lang]));
            const nextBtn = $("#obNext", obEl);
            nextBtn.disabled = false;
            nextBtn.addEventListener("click", () => { haptic(8); ob.step = 2; renderOb(); }, { once: true });
            toast(`Alerts in ${LANG_NAMES[lang]}.`, "ok");
          });
        });
      });
    } else {
      obEl.innerHTML = `
        <div class="onboard-brand">${ICONS.shield}<span>Skywatch · SMS</span></div>
        <h2>Consent, on the record</h2>
        <p class="sub">Consent for texts and voice was granted with your first message — Skywatch records it that way, so it can call you during something bigger.</p>
        <div class="consent-card">
          <div class="consent-row">
            <div style="flex:1"><b style="font-size:14px">Emergency text alerts</b><p>Sent only for an urgent hazard inside your area.</p></div>
            <button class="switch" id="swText" aria-pressed="true" aria-label="Emergency text alerts"></button>
          </div>
          <div class="consent-row">
            <div style="flex:1"><b style="font-size:14px">Voice check-in calls</b><p>A brief voice call when hazards are active near you.</p></div>
            <button class="switch" id="swVoice" aria-pressed="true" aria-label="Voice check-in calls"></button>
          </div>
        </div>
        <div class="ob-foot">${footer}</div>`;
      $("#swText", obEl).addEventListener("click", (e) => e.target.setAttribute("aria-pressed", e.target.getAttribute("aria-pressed") !== "true"));
      $("#swVoice", obEl).addEventListener("click", (e) => e.target.setAttribute("aria-pressed", e.target.getAttribute("aria-pressed") !== "true"));
      $("#obFinish", obEl).addEventListener("click", () => { haptic(14); obDone(); });
    }
  }

  /* =========================================================================
   * queue + crypto (mesh uplink) — exact contract of apps/api/src/mesh/sync.ts + sig.ts
   * =======================================================================*/
  const KINDS = [
    { id: "Trapped", type: "beacon", label: "Trapped", icon: ICONS.alert, tone: "danger" },
    { id: "Injured", type: "beacon", label: "Injured", icon: ICONS.alert, tone: "danger" },
    { id: "Need Rescue", type: "beacon", label: "Need rescue", icon: ICONS.alert, tone: "danger" },
    { id: "FLOODED ROAD", type: "hazard", label: "Flooded road", icon: ICONS.pin, tone: "warn" },
    { id: "SMOKE", type: "hazard", label: "Smoke", icon: ICONS.pin, tone: "warn" },
  ];
  ICONS.shieldS = ICONS.shield.replace('width="20" height="20"', 'width="12" height="12"');
  ICONS.pinS = ICONS.pin.replace('width="18" height="18"', 'width="11" height="11"');

  /** Where reports/syncs/asks are anchored: the device position once shared, else the demo preset. */
  function locAcc() { return myLoc().acc ? " ±" + myLoc().acc + " m" : ""; }

  async function ensureIdentity() {
    if (state.identity) return state.identity;
    let identity = null;
    try {
      const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
      const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      const deviceId = await sha256HexPrefix(rawPub, 10);
      identity = { ok: true, priv: pair.privateKey, pubB64: bytesToRawB64(rawPub), deviceId, legacy: false };
    } catch (_e) {
      // No WebCrypto Ed25519 (non-secure context) — the legacy:true path, per mesh/types.ts
      const seed = crypto.getRandomValues(new Uint8Array(16));
      const deviceId = await sha256HexPrefix(seed, 10);
      identity = { ok: false, deviceId, legacy: true };
    }
    state.identity = identity;
    return identity;
  }

  /**
   * Add a packet to the queue. Content only — the sig + deviceId are stamped at
   * send time so every queued packet travels under the session's own identity.
   */
  function queuePacket(kind, status, text, opts) {
    opts = opts || {};
    const kindDef = KINDS.find((k) => k.id === kind) || null;
    const pkt = {
      id: "mp-app-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      kind: kindDef ? kindDef.type : "msg",
      status: kindDef ? (kindDef.type === "beacon" ? kind : status) : "",
      text: kindDef ? "" : String(text || ""),
      to: opts.to || "",   // "SKYWATCH" = an Ask Skywatch question; reply comes back in a sync bundle
      lat: +myLoc().lat.toFixed(5),
      lon: +myLoc().lon.toFixed(5),
      ts: Date.now(),
      queuedAt: Date.now(),
      state: "queued",
    };
    state.queue.push(pkt);
    persist.queue();
    renderMeshBadge();
    return pkt;
  }

  function renderMeshBadge() {
    const bar = $("#tabbar");
    const tab = bar.querySelector('[data-tab="mesh"]');
    if (!tab) return;
    let n = state.queue.filter((p) => p.state === "queued").length;
    const existing = tab.querySelector(".tab-badge");
    if (n > 0) {
      if (existing) existing.textContent = String(n);
      else {
        const b = document.createElement("span");
        b.className = "tab-badge";
        b.textContent = String(n);
        tab.appendChild(b);
      }
    } else if (existing) existing.remove();
  }

  /** POST /mesh/sync — sign every queued packet exactly per src/mesh/sig.ts. */
  async function syncGateway(opts) {
    opts = opts || {};
    const identity = await ensureIdentity();
    const loc = myLoc();
    const packets = [];
    const q = state.queue.filter((p) => p.state === "queued" || p.state === "fail");
    for (const p of q) {
      const full = {
        id: p.id,
        type: p.kind,
        status: p.kind === "msg" ? p.text : p.status,
        lat: p.lat,
        lon: p.lon,
        ts: p.ts,
        hops: 0,
        ttl: 7,
        deviceId: identity.deviceId,
      };
      if (identity.legacy) {
        full.legacy = true;
      } else {
        full.pubkey = identity.pubB64;
        const msg = [full.id, full.type, full.ts, full.lat, full.lon, full.deviceId].map(String).join("|");
        const sig = await crypto.subtle.sign("Ed25519", identity.priv, new TextEncoder().encode(msg));
        full.sig = bytesToRawB64(new Uint8Array(sig));
      }
      if (p.to) full.to = p.to; // Ask Skywatch — addressed to the core for a task-8d back-reply
      packets.push(full);
    }
    if (packets.length === 0) {
      if (!opts.silent) toast("The mesh queue is clear.", "mesh");
      return null;
    }
    let result;
    gwInFlight = true;
    try {
      const r = await fetch(apiBase() + "/mesh/sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: identity.deviceId, lat: loc.lat, lon: loc.lon, packets }),
        signal: timeoutSig(15000),
      });
      result = { ok: r.ok, status: r.status, json: await r.json().catch(() => null) };
    } catch (err) {
      q.forEach((p) => { p.state = "fail"; });
      if (!opts.silent) toast("Gateway sync failed — packets held with a sig state.", "warn");
      throw err;
    } finally {
      gwInFlight = false;
    }
    if (result.ok && result.json) {
      const rejected = new Set(result.json.rejectedIds || []);
      state.queue.forEach((p) => {
        if (p.state !== "queued" && p.state !== "fail") return;
        if (rejected.has(p.id)) { p.state = "fail"; return; }
        p.state = "sent";
      });
      state.syncState = { at: Date.now(), received: result.json.received, inserted: result.json.inserted, deduped: result.json.deduped, rejected: result.json.rejected, legacy: identity.legacy, deviceId: identity.deviceId };
      state.bundle = result.json.bundle;
      persist.queue();
      renderMeshBadge();
      void safe(fetchMeshState());
      return result.json;
    }
    q.forEach((p) => { p.state = "fail"; });
    persist.queue();
    if (!opts.silent) toast("Gateway sync refused (" + (result.status || "network") + ")", "warn");
    return null;
  }

  /* =========================================================================
   * HOME rendering
   * =======================================================================*/

  const SEV = [
    { n: 4, label: "SEVERE", cls: "chip-danger" },
    { n: 3, label: "HIGH", cls: "chip-warn" },
    { n: 2, label: "ELEVATED", cls: "chip-warn" },
    { n: 1, label: "WATCH", cls: "chip-n" },
  ];

  function renderHome() {
    const el = screens.home;
    const briefSrc = cached("brief");
    const brief = briefSrc ? briefSrc.data : null;
    const offline = state.mode === "offline";
    const hasHazards = brief && brief.hazards && brief.hazards.length > 0;

    if (!isOnboarded()) {
      el.innerHTML = `
        <div class="stagger">
          <div class="card" style="text-align:center;padding:26px 18px">
            <div style="color:var(--accent);margin-bottom:10px">${ICONS.shield}</div>
            <div style="font-family:var(--fd);font-size:20px;font-weight:700">Skywatch</div>
            <p class="dim2" style="font-size:13px;margin-top:6px">Sign up once — then hazards near you arrive by text, and a voice check-in reads them to you when they matter.</p>
            <button class="btn btn-primary btn-block" id="homeOnboard" style="margin-top:16px">Get set up — it's one text</button>
          </div>
        </div>`;
      $("#homeOnboard").addEventListener("click", startOnboarding);
      return;
    }

    const skeleton = !brief && (state.loading.brief || !state.cache.brief);
    const syncedAt = briefSrc && !briefSrc.live ? briefSrc.at : null;

    el.innerHTML = `
      <div class="stagger">
        ${syncedAt ? `<p class="mini dim" style="margin-bottom:8px">Cached from ${esc(fmtAgo(syncedAt))} — live sync waits for signal</p>` : ""}
        <div class="sec-label" style="margin-top:2px">Your safety brief<small>${esc(myLoc().label)}</small></div>
        ${skeleton ? `
          <div class="skel" style="height:92px;margin-bottom:10px"></div>
          <div class="skel" style="height:150px;margin-bottom:10px"></div>
          <div class="skel" style="height:118px"></div>
        ` : brief === null ? `
          <div class="empty">${ICONS.shield}<b>No brief yet</b><p>${esc(state.briefNote || "Skywatch is assembling your brief the moment your signup lands in its pipeline.")}</p></div>
        ` : `
          <div class="card">
            <div class="hz-line">
              <span style="font-family:var(--fd);font-weight:700;font-size:15px">${hasHazards ? "Current hazards" : "All clear in your area"}</span>
              ${hasHazards ? `<span class="chip chip-danger sev">${brief.hazards.length} active</span>` : `<span class="chip chip-ok sev">clear</span>`}
            </div>
            <div class="hz-timing" id="homeHaz"></div>
          </div>
          <div id="hazards"></div>
        `}
        <div id="incomingTexts" style="margin-top:16px"></div>
        <div id="homeActions"></div>
        <div id="homeShelter"></div>
        <div id="homeSource"></div>
      </div>`;

    if (state.mode === "offline") {
      const chip = document.createElement("div");
      chip.className = "card";
      chip.style.borderColor = "rgba(164,148,242,.35)";
      chip.innerHTML = `<div style="display:flex;gap:10px;align-items:center;color:var(--mesh)">${ICONS.wifi}<b style="color:var(--mesh)">You're offline — mesh mode</b></div><p class="mini dim2" style="margin-top:6px">Home and Map are reading the last sync. Anything new you report queues up and sends when one of us gets signal.</p>`;
      const label = el.querySelector(".sec-label");
      label && label.insertAdjacentElement("afterend", chip);
    }

    if (!skeleton && brief) renderBriefParts(el, brief);
    if (!skeleton) renderIncoming(el);
    render911(el);
  }

  const ICONS_QUEUE = '<svg viewBox="0 0 24 24" width="12" height="12" style="vertical-align:-2px" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h10M4 17h6"/></svg>';

  function txtCardHtml(m, i) {
    const isBot = m.from === "bot" || m.from === "system";
    const head = m.kind === "summary"
      ? `<span class="sky">Skywatch</span><span>· call follow-up text</span>`
      : m.kind === "mirror"
        ? `<span class="sky">Skywatch</span><span>· reply as it would arrive by SMS</span>`
        : m.kind === "queued"
          ? `<span>you</span><span class="chip chip-mesh">queued · will send when one of us gets signal</span>`
          : m.kind === "ob-err"
            ? `<span>you</span><span class="chip chip-warn">send failed</span>`
            : isBot
              ? `<span class="sky">Skywatch</span><span>· SMS thread (read here in this demo)</span>`
              : `<span>you</span>`;
    return `<div class="txtcard" style="--i:${i}">
      <div class="txtcard-head">${head}</div>
      <div class="txtcard-body${m.from === "user" ? " user" : ""}">${esc(m.text)}</div>
    </div>`;
  }

  function renderBriefParts(el, brief) {
    // hazards, worst-first (the brief arrives ordered)
    const hazEl = $("#hazards", el);
    if (hazEl) {
      hazEl.innerHTML = (brief.hazards || []).map((hz, i) => {
        const sev = SEV.find((s) => s.n === hz.severity) || SEV[3];
        const icon =
          hz.type === "flood"
            ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 5.5c1.5-1.5 4-1.5 5.5 0s4 1.5 5.5 0 4-1.5 5.5 0M3 11c1.5-1.5 4-1.5 5.5 0s4 1.5 5.5 0 4-1.5 5.5 0M3 16.5c1.5-1.5 4-1.5 5.5 0s4 1.5 5.5 0 4-1.5 5.5 0"/></svg>'
            : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 9.5a5 5 0 1 0-9.8 1.4A3.5 3.5 0 0 0 8 17.5h8a4 4 0 0 0 1-8z"/></svg>';
        const tone = hz.severity >= 3 ? "danger" : "warn";
        return `<div class="card card-hover" style="--i:${i};margin-top:10px">
          <div style="display:flex;gap:11px;align-items:center">
            <div style="width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:var(--${tone}-dim);color:var(--${tone})">${icon}</div>
            <div style="flex:1;min-width:0">
              <b style="font-size:14px;font-family:var(--fd)">${esc(hz.title)}</b>
              <div class="hz-timing">${esc(hz.timing)}</div>
            </div>
            <span class="chip ${sev.cls} sev">${sev.label}</span>
          </div>
        </div>`;
      }).join("");
    }

    // actions
    const actionsZone = $("#homeActions", el);
    if (actionsZone) {
      actionsZone.innerHTML = brief.actions && brief.actions.length
        ? `<div class="sec-label">What Skywatch says to do<small>read to you on the check-in call, in order</small></div>
          <div class="card"><div class="actions">${brief.actions
            .map((a, i) => `<div class="action-row"><span class="n">${i + 1}</span><span>${esc(a.text)}</span></div>`)
            .join("")}</div></div>`
        : "";
    }

    // shelter — VERIFIED or the honest empty state
    const sh = brief.shelter;
    const shelterZone = $("#homeShelter", el);
    if (shelterZone) {
      shelterZone.innerHTML = sh
        ? `<div class="sec-label">Verified shelter<small>freshness fades — confidence is the age of the last check-in</small></div>
          <div class="card card-hover">
            <div style="display:flex;gap:11px;align-items:flex-start">
              <div style="width:38px;height:38px;border-radius:12px;background:var(--ok-dim);color:var(--ok);display:flex;align-items:center;justify-content:center">${ICONS.shieldCheck}</div>
              <div style="flex:1;min-width:0">
                <b style="font-size:14.5px;font-family:var(--fd)">${esc(sh.name)}</b>
                <div class="mini dim2" style="margin-top:3px">${esc(sh.hours)}</div>
                <div class="shelter-dist" style="margin-top:3px">${esc(sh.distanceKm)} km away · verified ${esc(sh.verifiedMinutesAgo)} min ago</div>
                <div class="confbar"><i style="width:${Math.round((sh.confidence || 0) * 100)}%"></i></div>
                <div class="mini dim" style="margin-top:6px;display:flex;justify-content:space-between">
                  <span>confidence ${Math.round((sh.confidence || 0) * 100)}%</span>
                  <span class="chip chip-ok">${sh.status === "open" ? "VERIFIED OPEN" : esc(sh.status.toUpperCase())}</span>
                </div>
              </div>
            </div>
          </div>`
        : `<div class="sec-label">Shelters<small>the honest state — no unverified claims</small></div>
          <div class="empty">${ICONS.shield}<b>No verified-open shelter near you</b><p>Skywatch only claims a shelter it has verified. Check the official source below for the latest.</p></div>`;
    }

    // official source
    const srcZone = $("#homeSource", el);
    if (srcZone) {
      srcZone.innerHTML = brief.officialSource
        ? `<div class="card" style="margin-top:14px;display:flex;gap:11px;align-items:center">
            <div style="width:34px;height:34px;border-radius:11px;background:var(--accent-dim);color:var(--accent);display:flex;align-items:center;justify-content:center">${ICONS.info}</div>
            <div style="flex:1;min-width:0"><b style="font-size:13.5px">${esc(brief.officialSource.name)}</b><a class="mini" style="display:block;margin-top:2px" href="${esc(brief.officialSource.url || "#")}" target="_blank" rel="noopener">${esc(brief.officialSource.url || "")}</a></div>
          </div>`
        : "";
    }
  }

  function renderIncoming(el) {
    const zone = $("#incomingTexts", el);
    if (!zone) return;
    const list = state.thread.filter((m) => m.from === "bot" || (m.from === "user" && m.kind === "summary")).slice(-2);
    if (!list.length) { zone.innerHTML = `<div class="sec-label">Texts from Skywatch</div><div class="empty">${ICONS.sms}<b>No texts yet</b><p>In production these go to your phone. In this demo they arrive right here, in-thread.</p></div>`; return; }
    zone.innerHTML = `<div class="sec-label">Texts from Skywatch<small>over SMS in production — read here in this demo</small></div>` + list.map(txtCardHtml).join("") + `<button class="btn btn-ghost btn-block" style="margin-top:8px" id="openThread">View the full thread (${state.thread.length})</button>`;
    $("#openThread", zone).addEventListener("click", openThreadSheet);
  }

  function render911(el) {
    const brief = state.brief || (cached("brief") || {}).data || null;
    const hasHazards = brief && brief.hazards && brief.hazards.length > 0;
    let target = el.querySelector("#home911");
    if (!target) {
      target = document.createElement("div");
      target.className = "call911";
      target.id = "home911";
      el.appendChild(target);
    }
    if (!hasHazards) {
      target.style.display = "none";
      return;
    }
    target.style.display = "block";
    target.innerHTML = `<a href="tel:911" aria-label="Tap to call 911"><span style="display:inline-flex">${ICONS.phone}</span>911 — Emergency<span style="font-weight:400;font-size:11px;opacity:.8">always here while hazards are active</span></a>`;
  }

  /* =========================================================================
   * the thread sheet (full text thread)
   * =======================================================================*/

  function openSheet(html, onOpen) {
    const scrim = $("#sheetScrim"), sheet = $("#sheet");
    scrim.hidden = false; sheet.hidden = false;
    sheet.innerHTML = `<div class="sheet-grip"></div>` + html;
    scrim.onclick = closeSheet;
    sheet.onclick = (e) => { if (e.target.closest("[data-close]")) closeSheet(); };
    if (onOpen) onOpen(sheet);
  }
  function closeSheet() { $("#sheet").hidden = true; $("#sheetScrim").hidden = true; }

  function openThreadSheet() {
    const rows = state.thread.slice().reverse().map((m) => {
      const me = m.from === "user";
      return `<div class="thread-row">
        <div class="thread-bubble ${me ? "me" : "bot"}">${esc(m.text)}</div>
        <span class="thread-time">${esc(new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}${m.kind === "mirror" ? " · would arrive over SMS (honest copy)" : ""}</span>
      </div>`;
    }).join("");
    openSheet(`<h3 style="margin-bottom:12px">Your number: ${esc(maskPhone(state.profile.phone))}</h3>${rows || '<p class="dim mini">no messages yet</p>'}`);
  }

  /* =========================================================================
   * MAP — vector-only canvas projection
   * =======================================================================*/

  const canvas = $("#mapCanvas");
  let ctx = null;
  const view = { cx: 0, cy: 0, zoom: 1, init: false };
  let pinCache = [];

  function dpr() { return window.devicePixelRatio || 1; }

  function sizeCanvas() {
    if (!ctx) ctx = canvas.getContext("2d");
    const r = canvas.getBoundingClientRect();
    const d = DPR();
    canvas.width = Math.round(r.width * d);
    canvas.height = Math.round(r.height * d);
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  // Linear projection: zoom 1 = ~9 km tall; pxy = px-per-km; lon scaled by cos(lat0).
  function proj() {
    const w = canvas.clientWidth, hgt = canvas.clientHeight;
    const kmPerDeg = 111;
    const cos0 = Math.cos((myLoc().lat * Math.PI) / 180) || 0.66;
    const spanKm = 9 / view.zoom;
    const pxPerKm = hgt / spanKm;
    return {
      x: (lon) => w / 2 + (lon - view.cx) * kmPerDeg * pxPerKm * cos0,
      y: (lat) => hgt / 2 - (lat - view.cy) * kmPerDeg * pxPerKm,
      pxPerKm,
    };
  }

  function panBy(dxPx, dyPx) {
    const kmPerDeg = 111;
    const cos0 = Math.cos((view.cy * Math.PI) / 180) || 0.66;
    const pxPerKm = (canvas.clientHeight || 700) * view.zoom / 9;
    view.cx -= (dxPx / pxPerKm) / kmPerDeg / cos0;
    view.cy += (dyPx / pxPerKm) / kmPerDeg;
  }

  function fitMapSoon() {
    sizeCanvas();
    fitAll();
    view.init = true;
    drawMap();
  }

  function collectFeatures() {
    const mapSrc = cached("mapState");
    const meshSrc = cached("mesh");
    const loc = myLoc();
    if (!mapSrc || !mapSrc.data) return null;
    // Fit to the actionable layer (shelters + mesh beacons + the user): anonymized
    // user dots and road cameras still DRAW but never drive the initial zoom.
    const lons = [loc.lon], lats = [loc.lat];
    const m = mapSrc.data;
    (m.resources || []).forEach((r) => { lats.push(r.lat); lons.push(r.lon); });
    if (meshSrc && meshSrc.data) {
      const ms = meshSrc.data;
      (ms.beacons || []).forEach((b) => { lats.push(b.lat); lons.push(b.lon); });
      (ms.hazardReports || []).forEach((b) => { lats.push(b.lat); lons.push(b.lon); });
    }
    return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) };
  }

  function fitAll() {
    const loc = myLoc();
    const b = collectFeatures();
    if (!b) { view.cx = loc.lon; view.cy = loc.lat; view.zoom = 1.4; return; }
    view.cx = (b.minLon + b.maxLon) / 2 || loc.lon;
    view.cy = (b.minLat + b.maxLat) / 2 || loc.lat;
    const cos0 = Math.cos((view.cy * Math.PI) / 180) || 0.66;
    const spanLatKm = Math.max(b.maxLat - b.minLat, 0.09) * 111 * 1.3;
    const spanLonKm = Math.max(b.maxLon - b.minLon, 0.09) * 111 * cos0 * 1.3;
    const zoom = 9 / Math.max(spanLatKm, spanLonKm);
    view.zoom = clamp(zoom, 0.25, 8);
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function drawMap() {
    if (!ctx) return;
    const r = canvas.getBoundingClientRect();
    const d = DPR();
    if (canvas.width !== Math.round(r.width * d)) sizeCanvas();
    const w = r.width, hgt = r.height;
    ctx.save();
    ctx.clearRect(0, 0, w, hgt);
    ctx.fillStyle = "#090b0f";
    ctx.fillRect(0, 0, w, hgt);
    gridBackdrop(w, hgt);
    const mapData = cached("mapState");
    const meshData = cached("mesh");
    if (!mapData) {
      drawMapEmpty(w, hgt);
      ctx.restore();
      return;
    }
    const p = proj();
    const m = mapData.data;
    const t = performance.now();

    // hazards (polygons, filled by severity)
    (m.hazards || []).forEach((hz) => {
      const polys = geometryPolys(hz.geometry);
      const sevCol = hz.severity >= 4 ? [255, 107, 94] : hz.severity >= 3 ? [255, 132, 78] : hz.severity >= 2 ? [240, 163, 78] : [240, 163, 78];
      const alpha = 0.07 + 0.055 * hz.severity;
      ctx.fillStyle = `rgba(${sevCol[0]},${sevCol[1]},${sevCol[2]},${alpha})`;
      ctx.strokeStyle = `rgba(${sevCol[0]},${sevCol[1]},${sevCol[2]},0.55)`;
      ctx.lineWidth = 1.2;
      polys.forEach((ring) => {
        ctx.beginPath();
        ring.forEach((pair, idx) => {
          const X = p.x(pair[0]), Y = p.y(pair[1]);
          if (idx === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      });
    });

    // roads: points (cameras) — red while flooded/blocked with >=0.5, slate otherwise
    (m.roads || []).forEach((rd) => {
      const blocked = (rd.status === "flooded" || rd.status === "blocked") && rd.confidence >= 0.5;
      const X = p.x(rd.lon), Y = p.y(rd.lat);
      ctx.beginPath();
      ctx.arc(X, Y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = blocked ? "rgba(255,107,94,0.95)" : "rgba(125,134,153,0.55)";
      ctx.fill();
      if (blocked) {
        ctx.beginPath();
        ctx.arc(X, Y, 9.5, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,107,94,0.35)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    });

    // user dots (small, dim)
    (m.userDots || []).forEach((ud) => {
      const X = p.x(ud.lon), Y = p.y(ud.lat);
      ctx.beginPath();
      ctx.arc(X, Y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(164,208,255,0.5)";
      ctx.fill();
    });

    // mesh layer
    if (meshData && meshData.data) {
      const ms = meshData.data;
      // coverage
      (ms.coverage || []).forEach((cv) => {
        const X = p.x(cv.lon), Y = p.y(cv.lat);
        ctx.beginPath();
        ctx.arc(X, Y, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(164,148,242,0.55)";
        ctx.fill();
      });
      // hazard reports with score bubbles
      (ms.hazardReports || []).forEach((hr) => {
        const X = p.x(hr.lon), Y = p.y(hr.lat);
        const score = hr.score == null ? 0 : hr.score;
        const rad = 6 + score * 6;
        ctx.beginPath();
        ctx.arc(X, Y, rad, 0, Math.PI * 2);
        ctx.fillStyle = hr.verify === "ok" ? "rgba(164,148,242,0.28)" : "rgba(164,148,242,0.14)";
        ctx.fill();
        ctx.strokeStyle = "rgba(164,148,242,0.65)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
        if (view.zoom > 0.9) {
          ctx.fillStyle = "#cdc4f7";
          ctx.font = "600 8px ui-monospace, monospace";
          ctx.textAlign = "center";
          ctx.fillText((score * 100).toFixed(0), X, Y + 3);
        }
      });
      // rescue beacons: pulsing markers, ranked
      (ms.beacons || []).forEach((bc, i) => {
        const X = p.x(bc.lon), Y = p.y(bc.lat);
        const pulse = 8 + 4 * Math.sin(t / 420 + i * 1.7);
        const col = bc.kind === "Trapped" ? "255,107,94" : bc.kind === "Injured" ? "240,163,78" : "240,163,78";
        ctx.beginPath();
        ctx.arc(X, Y, pulse + 4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${col},0.12)`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(X, Y, 7, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${col},0.92)`;
        ctx.fill();
        ctx.fillStyle = "#1b0405";
        ctx.font = "700 9px var(--fd), system-ui";
        ctx.textAlign = "center";
        ctx.fillText(String(i + 1), X, Y + 3);
      });
    }

    // resources (pins)
    pinCache = [];
    (m.resources || []).forEach((res) => {
      const X = p.x(res.lon), Y = p.y(res.lat);
      pinCache.push({ x: X, y: Y, res });
      drawPin(res, X, Y);
    });

    // queued local pins (offline)
    if (state.mode !== "online") {
      state.queue.filter((q) => q.state === "queued" || q.state === "fail").forEach((qp) => {
        const X = p.x(qp.lon), Y = p.y(qp.lat);
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.arc(X, Y, 8, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(164,148,242,0.8)";
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(X, Y, 3, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(164,148,242,0.9)";
        ctx.fill();
      });
    }

    // me
    const me = myLoc();
    const mx = p.x(me.lon), my2 = p.y(me.lat);
    ctx.beginPath();
    ctx.arc(mx, my2, 10, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(111,165,245,0.16)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(mx, my2, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(111,165,245,0.95)";
    ctx.fill();
    ctx.strokeStyle = "rgba(238,241,246,0.9)";
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.restore();
    renderMapChips();
  }

  function geometryPolys(geom) {
    if (!geom) return [];
    if (geom.type === "Polygon") return (geom.coordinates || []).map((ring) => (ring || []).slice(0, 1));
    return [];
  }

  function drawPin(res, X, Y) {
    const col = res.status === "open" ? "66,206,147" : res.status === "full" ? "240,163,78" : "125,134,153";
    const X0 = X, Y0 = Y;
    ctx.beginPath();
    ctx.moveTo(X0, Y0 - 13);
    ctx.arc(X0, Y0 - 13, 7.5, Math.PI * 0.62, Math.PI * 2.38);
    ctx.lineTo(X0, Y0);
    ctx.closePath();
    ctx.fillStyle = `rgba(${col},0.95)`;
    ctx.fill();
    ctx.strokeStyle = "rgba(9,11,15,0.9)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    if (res.partner) {
      ctx.beginPath();
      ctx.arc(X0, Y0 - 13, 11, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(66,206,147,0.4)";
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    if (res.status === "open") {
      ctx.beginPath();
      ctx.arc(X0, Y0 - 15, 2, 0, Math.PI * 2);
      ctx.fillStyle = "#06251a";
      ctx.fill();
    }
  }

  function gridBackdrop(w, hgt) {
    ctx.strokeStyle = "rgba(255,255,255,0.035)";
    ctx.lineWidth = 1;
    const step = 34;
    ctx.beginPath();
    for (let x = step; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, hgt); }
    for (let y = step; y < hgt; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }

  function drawMapEmpty(w, hgt) {
    ctx.fillStyle = "rgba(238,241,246,0.6)";
    ctx.font = "600 14px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Map data hasn't synced yet", w / 2, hgt / 2 - 8);
    ctx.font = "400 12px system-ui";
    ctx.fillStyle = "rgba(125,134,153,1)";
    ctx.fillText(state.mode === "offline" ? "Get signal once — then Map keeps working offline." : "Connecting to the Skywatch API…", w / 2, hgt / 2 + 12);
  }

  function renderMapChips() {
    const chips = $("#mapChips");
    const mapData = cached("mapState");
    const mesh = cached("mesh");
    const bits = [];
    if (mapData && !mapData.live) bits.push(`<span class="chip chip-mesh">cached · ${esc(fmtAgo(mapData.at))}</span>`);
    if (state.mode === "offline") bits.push(`<span class="chip chip-mesh">mesh sync needed</span>`);
    if (state.mode === "gateway") bits.push(`<span class="chip chip-ok">gateway · carrying the mesh</span>`);
    if (mesh && mesh.data && mesh.data.counts) bits.push(`<span class="chip chip-n chip-mono">${mesh.data.counts.packets} mesh packets</span>`);
    if (mapData && mapData.data && (mapData.data.hazards || []).length) bits.push(`<span class="chip chip-warn">${(mapData.data.hazards || []).length} hazards</span>`);
    chips.innerHTML = bits.join("");
  }

  /* map gestures: pan + pinch */
  let pointers = new Map();
  let lastPan = null;
  let pinchStart = null;
  let dragDist = 0;

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pointers.size === 1) {
      lastPan = { x: e.offsetX, y: e.offsetY };
      dragDist = 0;
      canvas.classList.add("grabbing");
    } else if (pointers.size === 2) {
      const pts = [...pointers.values()];
      pinchStart = { dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), zoom: view.zoom };
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pointers.size === 2 && pinchStart) {
      const pts = [...pointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      view.zoom = clamp(pinchStart.zoom * (d / pinchStart.dist), 0.05, 24);
      drawMap();
      return;
    }
    if (lastPan && pointers.size === 1) {
      const dX = e.offsetX - lastPan.x;
      const dY = e.offsetY - lastPan.y;
      dragDist += Math.abs(dX) + Math.abs(dY);
      panBy(dX, dY);
      lastPan = { x: e.offsetX, y: e.offsetY };
      drawMap();
    }
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size === 0) { canvas.classList.remove("grabbing"); lastPan = null; }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    view.zoom = clamp(view.zoom * (e.deltaY < 0 ? 1.12 : 0.89), 0.05, 24);
    drawMap();
  }, { passive: false });

  canvas.addEventListener("click", (e) => {
    if (dragDist > 9) return; // a drag, not a tap
    const r = canvas.getBoundingClientRect();
    openPinSheet(e.clientX - r.left, e.clientY - r.top);
  });

  $("#mapZoomIn").addEventListener("click", () => { view.zoom = clamp(view.zoom * 1.35, 0.05, 24); drawMap(); });
  $("#mapZoomOut").addEventListener("click", () => { view.zoom = clamp(view.zoom / 1.35, 0.05, 24); drawMap(); });
  $("#mapRecenter").addEventListener("click", () => { fitAll(); drawMap(); });

  function openPinSheet(X, Y) {
    let best = null, bestD = 30;
    for (const pc of pinCache) {
      const d = Math.hypot(pc.x - X, pc.y - Y);
      if (d < bestD) { best = pc; bestD = d; }
    }
    if (!best) return;
    const r = best.res;
    const conf = Math.round((r.confidence || 0) * 100);
    const col = r.status === "open" ? "var(--ok)" : r.status === "full" ? "var(--warn)" : "var(--text3)";
    openSheet(`
      <h3>${esc(r.name)}</h3>
      <div class="chips" style="margin:10px 0 12px">
        <span class="chip" style="color:${col};border-color:${col}">${esc(r.status.toUpperCase())}</span>
        ${r.partner ? '<span class="chip chip-ok">Partner resource</span>' : ""}
        <span class="chip chip-n chip-mono">${esc(r.kind)}</span>
        <span class="chip chip-n chip-mono">confidence ${conf}%</span>
      </div>
      <div class="confbar"><i style="width:${conf}%"></i></div>
      <p class="mini dim" style="margin-top:10px">A pin only says what someone verified — confidence fades until a fresh check-in refreshes it. ${state.mode === "offline" ? "Offline: this pin is the last thing your map synced." : ""}</p>
      <a class="btn btn-ghost btn-block" style="margin-top:12px" href="#" data-close>Close</a>
    `);
  }

  function drawMapLoop() {
    requestAnimationFrame(() => {
      if (screens.map.classList.contains("active")) drawMap();
      drawMapLoop();
    });
  }

  function DPR() { return Math.max(1, window.devicePixelRatio || 1); }

  /* =========================================================================
   * MESH tab rendering
   * =======================================================================*/

  function renderMesh() {
    const el = screens.mesh;
    const meId = state.identity ? state.identity.deviceId : null;
    const mesh = cached("mesh");
    const myPackets = state.queue;
    const msgs = mesh && mesh.data ? mesh.data.messages || [] : [];
    const gateway = state.mode === "gateway";

    const gwHtml =
      state.mode === "offline"
        ? `<div class="gw-banner" style="border-color:rgba(164,148,242,.35);background:var(--mesh-dim)">
            <h3 style="color:var(--mesh)">No service — but someone can carry this</h3>
            <p>The whole neighborhood's queue rides one phone out. Yours can be that phone.</p>
            <button class="btn btn-primary btn-block" id="gwGo" style="margin-top:12px">${ICONS.link} I have signal — become the link</button>
          </div>`
        : gateway
          ? `<div class="gw-banner">
              <h3>You're the gateway right now</h3>
              <p>1 bar: enough to sync the mesh up and rebroadcast what comes back down.</p>
              <button class="btn btn-block" id="gwRetry" style="margin-top:12px">${ICONS.sync} Sync the mesh again</button>
            </div>`
          : "";

    const chatHtml = (() => {
      const mine = myPackets.filter((p) => p.kind === "msg" && p.state !== "sent").reverse().slice(0, 8);
      const rows = msgs.slice(-14).map((msg) => {
        const isMe = meId && msg.from === meId;
        const isCore = !!((msg.to && meId && msg.to === meId) || /skywatch/i.test(String(msg.from || "")));
        const chip = isCore ? `<span class="chip chip-ok core-chip">${ICONS.shieldS} Skywatch</span>` : "";
        return `<div class="bubble ${isCore ? "core" : isMe ? "me" : ""}">${chip}${esc(msg.text)}<div class="bubble-meta"><span>${esc(isCore ? "skywatch" : String(msg.from || ""))}</span><span>${esc(fmtAgo(msg.ts))}</span></div></div>`;
      });
      const queued = mine.map((p) => `<div class="bubble me">${esc(p.text)}<div class="bubble-meta"><span>you</span><span class="chip chip-mesh">queued · will send when one of us gets signal</span></div></div>`);
      const all = rows.concat(queued).slice(-18).join("");
      return all || `<div class="empty">${ICONS.meshOn}<b>No mesh chatter yet</b><p>When you're dark, this is how people nearby share what they see.</p></div>`;
    })();

    const queueHtml = (() => {
      const recent = myPackets.slice(-14).reverse();
      if (!recent.length) return "";
      return `<div class="sec-label">Your packets<small>signed with this device's key — reload gives you a new identity</small></div>
        ${recent.map(pktRowHtml).join("")}`;
    })();

    const counts = mesh && mesh.data && mesh.data.counts
      ? `<div class="chips" style="margin-top:12px">
          <span class="chip chip-n chip-mono">${mesh.data.counts.packets} packets</span>
          <span class="chip chip-n chip-mono">${mesh.data.counts.beacons} beacons</span>
          <span class="chip chip-n chip-mono">${mesh.data.counts.devices} devices</span>
          <span class="chip chip-n chip-mono">${mesh.data.counts.acked} acked</span>
        </div>`
      : "";

    const bundleHtml = state.bundle
      ? renderBundle(state.bundle, state.syncState)
      : "";

    el.innerHTML = `
      <div class="sec-label" style="margin-top:2px">Mesh<small>${state.identNote || "the community layer — what keeps working with no bars"}</small></div>
      <button class="locbar" id="locBar" aria-label="Reporting location — tap to change">${ICONS.pin}<span style="flex:1;min-width:0"><b>Reporting from:</b> ${esc(myLoc().label)}<span class="mono dim">${esc(locAcc())}</span></span><span class="mini dim">tap to change</span></button>
      ${gwHtml}
      <div class="chips" style="margin-bottom:10px">
        <span class="chip ${state.identity && !state.identity.legacy ? "chip-ok" : "chip-warn"} chip-mono">${state.identity ? esc(state.identity.deviceId) : "identity pending"}</span>
        <span class="chip chip-n">Ed25519 TOFU</span>
      </div>
      <div class="chatwrap" id="meshChat">${chatHtml}</div>
      <div class="composer card" style="margin-top:14px">
        <div class="chips">
          ${KINDS.map((k, i) => `<button class="kind-chip chip chip-n" data-kind="${esc(k.id)}" aria-pressed="false">${esc(k.label)}</button>`).join("<span></span>")}
          <button class="kind-chip chip chip-n ask-chip" aria-pressed="false">${ICONS.shieldS} Ask Skywatch</button>
        </div>
        <div class="ask-prompts" id="askPrompts" hidden>
          <span class="mini dim2">Suggested:</span>
          ${ASKS.map((p) => `<button class="prompt-chip chip chip-n" data-prompt="${esc(p)}">${esc(p)}</button>`).join("")}
          <span class="mini dim">answers from your brief — no live model</span>
        </div>
        <textarea id="meshText" maxlength="280" placeholder="What's happening around you?" aria-label="mesh message"></textarea>
        <div class="composer-foot">
          <span class="counter" id="meshCount">280</span>
          <span class="chips">
            <button class="chip chip-n" id="locChip" aria-label="Reporting location — tap to change">${ICONS.pinS} ${esc(myLoc().acc ? "device" + locAcc() : "demo preset")}</button>
            <span class="chip chip-mesh">signs with WebCrypto</span>
          </span>
          <button class="btn btn-primary" id="meshSend" style="min-height:42px">${ICONS.send} Send</button>
        </div>
      </div>
      <div id="meshQueue" style="margin-top:16px">${queueHtml}</div>
      ${counts}
      <div id="meshBundle" style="margin-top:16px">${bundleHtml}</div>`;

    wireComposer(el);
    const locBar = $("#locBar", el);
    if (locBar) locBar.addEventListener("click", () => { haptic(6); askGeolocate(); });
    const locChip = $("#locChip", el);
    if (locChip) locChip.addEventListener("click", () => { haptic(6); askGeolocate(); });
    const gwGo = $("#gwGo", el);
    if (gwGo) gwGo.addEventListener("click", async () => {
      haptic(10);
      state.netOverride = "gateway"; // manual — becomes the link on purpose
      setMode("gateway", { force: true });
    });
    const gwRetry = $("#gwRetry", el);
    if (gwRetry) gwRetry.addEventListener("click", async () => { try { await syncGateway(); renderMesh(); } catch (_e) { renderMesh(); } });
    const gwRestore = $("#gwRestore", el);
    if (gwRestore) gwRestore.addEventListener("click", () => { state.netOverride = null; setMode("online", { quiet: true }); });
    renderMeshSigChip();
  }

  function pktRowHtml(p) {
    const queuedStyle = (p.state === "queued" || p.state === "fail") ? "pkt-queued" : "";
    return `<div class="pkt ${queuedStyle}">
      <div class="pkt-icon" style="${p.kind === "msg" ? "background:var(--accent-dim);color:var(--accent)" : ""}">${p.kind === "msg" ? ICONS.sms : KINDS.find((k) => k.id === p.status) ? ICONS.alert : ICONS.pin}</div>
      <div class="pkt-label">
        ${p.kind === "msg" ? esc(p.text || "") : esc(p.status || "")}
        <span class="sub">${esc(p.kind.toUpperCase())} · ${esc(fmtAgo(Date.now() - p.queuedAt))} · signed at send</span>
      </div>
      ${p.state === "sent"
        ? '<span class="chip chip-ok">sent</span>'
        : p.state === "fail"
          ? '<span class="chip chip-warn">held — sig state</span>'
          : '<span class="chip chip-mesh">queued · will send when one of us gets signal</span>'}
    </div>`;
  }

  function renderMeshSigChip() {
    if (state.identity) return;
    ensureIdentity().then(() => {
      state.identNote =
        state.identity.legacy
          ? "identity stored unsigned this session (no WebCrypto Ed25519) — reload for an Ed25519 key"
          : "signed with a fresh keypair this session — reload = a new neighbor";
      const chipEl = screens.mesh.querySelector(".chip-mono");
      if (chipEl) chipEl.textContent = state.identity.deviceId;
    });
  }

  function wireComposer(el) {
    const ta = $("#meshText", el);
    ta.addEventListener("input", () => { $("#meshCount", el).textContent = String(280 - ta.value.length); });
    let pick = null;
    let askOn = false;
    const askZone = $("#askPrompts", el);
    const askChip = el.querySelector(".ask-chip");
    const setAsk = (on) => {
      askOn = on;
      if (on) pick = null;
      el.querySelectorAll(".kind-chip").forEach((c) => c.setAttribute("aria-pressed", String(c.classList.contains("ask-chip") ? askOn : c.dataset.kind === pick)));
      if (askZone) askZone.hidden = !on;
      if (on) ta.focus();
    };
    el.querySelectorAll(".kind-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        haptic(5);
        if (chip.classList.contains("ask-chip")) { setAsk(!askOn); return; }
        pick = pick === chip.dataset.kind ? null : chip.dataset.kind;
        if (pick && askOn) askOn = false; // one mode at a time
        setAsk(false);
        el.querySelectorAll(".kind-chip").forEach((c) => c.setAttribute("aria-pressed", String(c.classList.contains("ask-chip") ? askOn : c.dataset.kind === pick)));
      });
    });
    if (askZone) askZone.querySelectorAll(".prompt-chip").forEach((pc) => {
      pc.addEventListener("click", () => {
        haptic(5);
        ta.value = pc.dataset.prompt || "";
        $("#meshCount", el).textContent = String(280 - ta.value.length);
        setAsk(true);
      });
    });
    $("#meshSend", el).addEventListener("click", () => {
      const text = ta.value.trim();
      if (askOn) {
        if (!text) { toast("Type the question for Skywatch.", "warn"); return; }
        queuePacket(null, "", text, { to: "SKYWATCH" });
        toast("Asked Skywatch — the answer rides the next sync back.", "mesh");
      } else if (pick) {
        const def = KINDS.find((k) => k.id === pick);
        queuePacket(pick, "", "");
        if (text) { queuePacket(null, def.id, text); }
        toast(`Report queued — ${pick.toLowerCase()}.`, "mesh");
      } else if (text) {
        queuePacket(null, "", text);
        toast("Message queued to the mesh.", "mesh");
      } else {
        toast("Type something, or pick what you're reporting.", "warn");
        return;
      }
      haptic(10);
      ta.value = "";
      $("#meshCount", el).textContent = "280";
      renderMeshBadge();
      renderMesh();
    });
  }

  function renderBundle(bundle, syncOut) {
    const acks = (bundle.acks || []).map((a) => `<div class="uplink-row"><span style="color:var(--ok)">${ICONS.check}</span><span>${esc(a.message)}</span></div>`).join("") || '<p class="mini dim">no acks in this bundle</p>';
    const msgs = (bundle.messages || []).map((m) => `<div class="uplink-row">${/skywatch/i.test(String(m.from || "")) ? '<span style="color:var(--ok)">' + ICONS.shieldS + "</span>" : ""}<span class="mono dim">${esc(m.from)}</span><span>${esc(m.text)}</span></div>`).join("") || '<p class="mini dim">no messages for you in this bundle</p>';
    const roads = (bundle.blockedRoads || []).map((r) => `<div class="uplink-row"><span style="color:var(--danger)">${esc(r.status.toUpperCase())}</span><span>${esc(r.name)}</span><span class="mono dim">${Math.round((r.confidence || 0) * 100)}%</span></div>`).join("") || '<p class="mini dim">no fresh road verdicts</p>';
    const syncLine = syncOut
      ? `${esc(String(syncOut.received))} received · ${esc(String(syncOut.inserted))} stored · ${esc(String(syncOut.deduped))} deduped${syncOut.rejected ? " · " + esc(String(syncOut.rejected)) + " rejected" : ""}`
      : "";
    const sh = bundle.nearestVerifiedShelter;
    return `<div class="bundle">
      <div style="display:flex;align-items:center;gap:9px">
        <div style="width:34px;height:34px;border-radius:11px;background:var(--ok-dim);color:var(--ok);display:flex;align-items:center;justify-content:center">${ICONS.sync}</div>
        <div style="flex:1"><b style="font-family:var(--fd);font-size:14.5px">Downlink bundle</b><div class="mini dim">${syncLine}</div></div>
      </div>
      <div class="reb-list">
        <h4 class="dim mini" style="margin-top:10px;text-transform:uppercase;font-size:10.5px;letter-spacing:.05em">Rebroadcast to the mesh</h4>
        <div class="uplink-row"><span class="arrow">→</span><span>${esc(bundle.brief ? bundle.brief.text.slice(0, 120) : "")}</span></div>
        <div class="uplink-row sent"><span class="arrow">→</span><span>shelter, roads and acks rebroadcast to ${esc(rebCount())} nearby nodes</span></div>
      </div>
      <div class="bundle-sec"><h4>Brief out</h4><p>${esc((bundle.brief && bundle.brief.text) || "")}</p></div>
      ${sh ? `<div class="bundle-sec"><h4>Verified shelter</h4><p>${esc(sh.name)} — ${esc(sh.distanceKm)} km · ${esc(sh.hours)} · confidence ${Math.round((sh.confidence || 0) * 100)}%</p></div>` : ""}
      ${roads ? `<div class="bundle-sec"><h4>Roads</h4>${roads}</div>` : ""}
      <div class="bundle-sec"><h4>Acks</h4>${acks}</div>
      <div class="bundle-sec"><h4>Messages</h4>${msgs}</div>
      ${state.mode === "gateway" ? `<button class="btn btn-ok btn-block" id="gwRestore" style="margin-top:14px">${ICONS.check} Signal restored — back online</button>` : ""}
    </div>`;
  }
  function rebCount() {
    const mesh = cached("mesh");
    const counts = mesh && mesh.data && mesh.data.counts;
    return counts ? counts.devices : "neighbor";
  }

  /* =========================================================================
   * Profile
   * =======================================================================*/

  function renderProfile() {
    const el = screens.profile;
    const id = state.identity;
    const mode = state.mode;
    const roleLine = mode === "offline" ? "You're relaying neighbors' messages" : mode === "gateway" ? "You're the neighborhood's link today" : "Full service — briefs, texts and calls";

    const modes = [
      { id: "auto", label: "Auto", ic: "auto", sig: "?", sub: "Detect signal for me — /health liveness flips OFFLINE→Gateway→ONLINE by itself." },
      { id: "online", label: "Online", ic: "ok", sig: "5G", sub: "Everything works through the API." },
      { id: "offline", label: "No Service", ic: "off", sig: "—", sub: "Go dark on purpose — stays dark, auto-detect paused while pinned." },
      { id: "gateway", label: "Gateway", ic: "gw", sig: "1 bar", sub: "I have signal — become the link and sync." },
    ];

    el.innerHTML = `
      <div class="stagger">
        <div class="sec-label" style="margin-top:2px">Profile</div>
        <div class="card" style="display:flex;gap:12px;align-items:center">
          <div style="width:48px;height:48px;border-radius:16px;background:var(--accent-dim);color:var(--accent);display:flex;align-items:center;justify-content:center">${ICONS.user}</div>
          <div style="flex:1;min-width:0">
            <b style="font-family:var(--fd);font-size:15.5px">${isOnboarded() ? "Skywatch member" : "New to Skywatch"}</b>
            <div class="mini dim">${esc(roleLine)}</div>
          </div>
          <span class="chip ${mode === "offline" ? "chip-mesh" : mode === "gateway" ? "chip-n" : "chip-ok"}">${mode === "offline" ? "MESH MODE" : mode === "gateway" ? "GATEWAY" : "5G"} · ${isAutoNet() ? "auto" : "manual"}</span>
        </div>

        <div class="sec-label">Network mode<small>auto-detect is on by default — a manual pick pins the chip until you return to Auto</small></div>
        <div class="mode-rows">
          ${modes.map((m) => `
            <button class="mode-row" data-mode="${m.id}" aria-pressed="${m.id === "auto" ? isAutoNet() : !isAutoNet() && mode === m.id}">
              <div class="mode-ic ic-${m.ic}">${m.id === "online" ? ICONS.wifi : m.id === "offline" ? ICONS.stop : m.id === "auto" ? ICONS.sync : ICONS.link}</div>
              <div style="flex:1;min-width:0"><b>${m.label}</b><span class="sub">${esc(m.sub)}</span></div>
              <span class="radio"></span>
            </button>`).join("")}
        </div>
        ${mode === "offline" ? `<p class="mini dim" style="margin-top:8px">While you're dark, Home and Map run on the last sync — and ${esc(String(state.queue.filter((q) => q.state === "queued").length))} packet(s) wait in the queue.</p>` : ""}
        ${!isAutoNet() ? `<p class="mini dim" style="margin-top:8px">Manual override set — auto-detect is paused (the status chip carries a "manual" tag). Pick Auto to hand detection back.</p>` : ""}

        <div class="sec-label">Identity<small>a fresh keypair is minted every reload — a deliberate privacy call</small></div>
        <div class="card">
          <div class="kv"><span class="k">device id</span><span class="v">${id ? esc(id.deviceId) : '<span class="dim">minting…</span>'}</span></div>
          <div class="kv"><span class="k">key</span><span class="v">${id ? (id.legacy ? "unsigned (legacy)" : "Ed25519 · WebCrypto") : "…"}</span></div>
          <div class="kv"><span class="k">platform</span><span class="v">${esc((state.profile.platform || "sms").toUpperCase())}</span></div>
          <div class="kv"><span class="k">number</span><span class="v">${esc(maskPhone(state.profile.phone) || "—")}</span></div>
          <div class="kv"><span class="k">language</span><span class="v">${esc(LANG_NAMES[state.profile.lang] || "English")}</span></div>
          <div class="kv"><span class="k">reporting from</span><span class="v">${esc(myLoc().label)}${esc(locAcc())}</span></div>
          <button class="btn btn-ghost btn-block" id="locBtn" style="margin-top:10px;min-height:42px">Use my real location</button>
        </div>

        <div class="sec-label">Consent<small>you can pull the plug any time — Global Constraint 4, both channels</small></div>
        <div class="card">
          <div class="kv"><span class="k">text alerts</span><span class="v" style="color:var(--ok)">${isOnboarded() ? "on" : "—"} </span></div>
          <div class="kv"><span class="k">voice check-ins</span><span class="v" style="color:var(--ok)">${isOnboarded() ? "on" : "—"}</span></div>
          <button class="btn btn-danger btn-block" id="stopBtn" style="margin-top:12px">${ICONS.stop}<span id="stopLabel">STOP — end everything</span></button>
          <p class="mini dim" style="margin-top:8px">Sends the same signed webhook the real STOP text would. No reply — that's the contract.</p>
        </div>

        <div class="sec-label">Try it</div>
        <button class="btn btn-block" id="simCallBtn" ${mode !== "online" ? "disabled" : ""}>${ICONS.call} Simulate an incoming call${mode !== "online" ? " (online only)" : ""}</button>

        <div class="sec-label">Connection</div>
        <div class="card">
          <div class="kv"><span class="k">API</span><span class="v">${esc(apiBase() || "same-origin via the harness proxy")}</span></div>
          <div class="kv"><span class="k">TOOL_SECRET</span><span class="v">${state.cfg.toolSecret ? "set" : "not set"}</span></div>
          <div class="kv"><span class="k">webhook secret</span><span class="v">${state.cfg.photonSecret ? "set" : "not set"}</span></div>
          <button class="btn btn-ghost btn-block" id="cfgBtn" style="margin-top:10px;min-height:42px">Edit connection details</button>
        </div>
        <p class="mini dim" style="margin-top:14px;text-align:center">Skywatch demo · talks only to the real API</p>
      </div>`;

    el.querySelectorAll(".mode-row").forEach((row) => {
      row.addEventListener("click", () => {
        haptic(9);
        const target = row.dataset.mode;
        if (target === "auto") {
          if (isAutoNet()) return;
          state.netOverride = null;
          renderProfile();
          toast("Auto mode — the app watches the signal for you.", "ok");
          void probeHealth().then((ok) => {
            if (ok) {
              stopHealthRetry();
              if (state.mode !== "online") setMode("online", { quiet: true });
            } else if (state.mode !== "offline") {
              setMode("offline", { force: true });
            } else {
              startHealthRetry();
            }
          });
          return;
        }
        if (!isAutoNet() && target === state.mode) return;
        state.netOverride = target;
        if (target === state.mode) { renderProfile(); return; } // pin what's already showing
        if (target === "gateway") {
          setMode("gateway", { force: true });
          switchTab("mesh");
        } else {
          setMode(target, target === "offline" ? {} : { quiet: true });
        }
      });
    });
    const stop = $("#stopBtn", el);
    if (stop) stop.addEventListener("click", doStop);
    $("#simCallBtn", el).addEventListener("click", () => startCall());
    $("#cfgBtn", el).addEventListener("click", openConfigModal);
    $("#locBtn", el).addEventListener("click", askGeolocate);
  }

  async function doStop() {
    const label = document.getElementById("stopLabel");
    if (label) label.textContent = "Sending STOP…";
    threadPush("user", "STOP", "ob");
    if (state.mode === "online") await sendTextWebhook("STOP");
    threadPush("system", MIRRORED.stopNote, "mirror");
    state.profile = {};
    state.brief = null;
    state.queue = [];
    persist.profile(); persist.queue();
    toast("You're unsubscribed. No reply follows.", "warn");
    renderProfile();
    renderHome();
  }

  /* =========================================================================
   * config modal + first run + walkthrough
   * =======================================================================*/

  function openConfigModal(isFirst) {
    const wrap = $("#modalWrap"), modal = $("#modal");
    wrap.hidden = false;
    modal.innerHTML = `
      <h3>${isFirst ? "Connect this demo to the real API" : "Connection details"}</h3>
      ${isFirst ? '<p class="mini dim2" style="margin-top:6px">One signup, one real brief. Nothing here is mocked.</p>' : ""}
      <div class="fld"><label for="cfgApi">API base</label>
        <input id="cfgApi" placeholder="(empty = same-origin via the harness proxy)" value="${esc(state.cfg.api || "")}">
        <p class="help">Leave empty unless the lead gives a URL. ?api= override also works.</p>
      </div>
      <div class="fld"><label for="cfgTool">TOOL_SECRET (for /tools/brief)</label>
        <input id="cfgTool" type="password" placeholder="${state.cfg.toolSecret ? "•••• saved — leave empty to keep" : "from the API's .env"}" value="">
        <p class="help">In apps/api/.env as TOOL_SECRET.</p>
      </div>
      <div class="fld"><label for="cfgPhoton">PHOTON_WEBHOOK_SIGNING_SECRET (for the SMS webhook)</label>
        <input id="cfgPhoton" type="password" placeholder="${state.cfg.photonSecret ? "•••• saved — leave empty to keep" : "from the API's .env"}" value="">
        <p class="help">Same value the running API uses to verify webhook signatures — copy it from the lead's .env (PHOTON_WEBHOOK_SIGNING_SECRET). The page never stores it anywhere but this browser.</p>
      </div>
      <p class="err" id="cfgErr"></p>
      <div style="display:flex;gap:10px;margin-top:16px">
        <button class="btn btn-ghost" style="flex:1" data-close-modal>Cancel</button>
        <button class="btn btn-primary" style="flex:2" id="cfgSave">Save</button>
      </div>`;
    wrap.querySelectorAll("[data-close-modal]").forEach((b) => b.addEventListener("click", () => {
      wrap.hidden = true;
      if (isFirst && !state.flags.configSeen) { state.flags.configSeen = true; persist.flags(); }
    }));
    $("#cfgSave", modal).addEventListener("click", () => {
      const api = $("#cfgApi", modal).value.trim().replace(/\/+$/, "");
      const tool = $("#cfgTool", modal).value.trim();
      const photon = $("#cfgPhoton", modal).value.trim();
      state.cfg = {
        api,
        toolSecret: tool || state.cfg.toolSecret || "",
        photonSecret: photon || state.cfg.photonSecret || "",
      };
      lsSet(LS.cfg, state.cfg);
      wrap.hidden = true;
      state.flags.configSeen = true; persist.flags();
      toast("Saved. Talking to " + (apiBase() || "the harness proxy") + ".", "ok");
      resyncAll(true);
      renderProfile();
    });
  }

  function maybeFirstRun() {
    if (!state.flags.configSeen) openConfigModal(true);
    else if (!state.flags.walkSeen) {
      // actual-iphone mode has no floating chip — the walkthrough opens right
      // after onboarding finishes (obDone); at boot only chip mode applies
      if (window.innerWidth > 520) showWalkChip();
    }
  }

  function showWalkChip() {
    const chip = $("#walkChip");
    chip.hidden = false;
    chip.onclick = openWalkthrough;
    setTimeout(() => { chip.hidden = true; }, 26000);
  }

  function openWalkthrough() {
    state.flags.walkSeen = true; persist.flags();
    const wrap = $("#modalWrap"), modal = $("#modal");
    wrap.hidden = false;
    modal.innerHTML = `
      <h3>Three things to try</h3>
      <div class="walk-lines">
        <div><b>1</b><span><b style="color:var(--text)">Go dark on purpose.</b> Profile → "No Service" pins manual OFFLINE — the chip's "manual" tag keeps auto-detect off, no matter what /health says.</span></div>
        <div><b>2</b><span><b style="color:var(--text)">Auto-detect is the product.</b> In AUTO the app watches the browser's online/offline events and pings /health every 5 s: signal found flips OFFLINE→Gateway by itself, syncs the whole queue, and lands "Back online — everyone's news is out". Watch the status-bar chip on each hop.</span></div>
        <div><b>3</b><span><b style="color:var(--text)">Become the link manually, too.</b> Mesh → "I have signal" runs the gateway sync — or just kill the API while online and watch the app degrade, then re-detect, all by itself. The queue sends once per sync; the server dedups by id.</span></div>
      </div>
      <button class="btn btn-primary btn-block" data-close-walk>Got it</button>`;
    wrap.querySelectorAll("[data-close-walk]").forEach((b) => b.addEventListener("click", () => { wrap.hidden = true; }));
  }

  /* =========================================================================
   * VOICE CALL — the brief, read in sequence
   * =======================================================================*/

  const callLayer = $("#callLayer");
  let callTimers = [];

  function clearCallTimers() { callTimers.forEach((t) => clearTimeout(t)); callTimers = []; }

  function startCall() {
    const brief = (state.brief || (state.cache.brief || {}).data);
    callLayer.hidden = false;
    callLayer.className = "call-layer ringing";
    haptic([30, 90, 30]);
    callLayer.innerHTML = `
      <div class="call-state">incoming call · Skywatch Emergency</div>
      <div class="call-avatar">${ICONS.shield}</div>
      <div class="call-name">Skywatch Emergency</div>
      <div class="call-sub">A check-in about hazards near ${esc(myLoc().label.split(" (")[0])}</div>
      <div class="call-spacer"></div>
      <div class="call-actions">
        <button class="call-btn dec" id="callDecline" aria-label="Decline">${ICONS.endcall.replace('width="30" height="30"', '')}</button>
        <button class="call-btn acc" id="callAccept" aria-label="Accept">${ICONS.call}</button>
      </div>
      <p class="call-note">Accept and the brief reads itself the way the agent would.</p>`;
    $("#callAccept").addEventListener("click", () => { haptic(12); answerCall(brief); }, { once: true });
    $("#callDecline").addEventListener("click", () => endCall(), { once: true });
  }

  function answerCall(brief) {
    callLayer.className = "call-layer";
    const lines = callLines(brief);
    callLayer.innerHTML = `
      <div class="call-state">Skywatch Emergency · connected</div>
      <div class="call-avatar" style="width:84px;height:84px;margin:26px 0 12px">${ICONS.shield}</div>
      <div class="call-steps">${lines.map((_, i) => `<i data-step="${i}"></i>`).join("")}</div>
      <div class="call-caption" id="callCaption"><div class="cc-label">captions</div><div id="ccText"></div></div>
      <button class="call-btn end" id="callEnd" aria-label="End call">${ICONS.phone}</button>
      <p class="call-note">This is the ElevenLabs agent's script — built from the same brief. In production you'd hear it.</p>`;
    let idx = 0;
    const step = lines.length + 1;
    const advance = () => {
      if (idx >= lines.length) return;
      const cap = $("#ccText", callLayer);
      cap.style.animation = "none";
      void cap.offsetWidth;
      cap.style.animation = "capIn .5s var(--ease)";
      cap.textContent = lines[idx];
      callLayer.querySelectorAll("[data-step]").forEach((s) => s.classList.toggle("on", +s.dataset.step <= idx));
      haptic(6);
      callTimers.push(setTimeout(advance, 4200));
      idx += 1;
    };
    $("#callEnd").addEventListener("click", () => endCall(), { once: true });
    if (!lines.length) {
      $("#ccText", callLayer).textContent = "There's nothing new in your brief — you're in good shape. If anything urgent comes up, Skywatch will message you first.";
    } else {
      advance();
    }
    void step;
  }

  function callLines(brief) {
    if (!brief) return [];
    const lines = [];
    const hz = (brief.hazards || [])[0];
    if (hz) lines.push(`${hz.title} — ${hz.timing}.`);
    (brief.actions || []).slice(0, 3).forEach((a) => lines.push(a.text));
    const sh = brief.shelter;
    lines.push(sh && sh.status === "open"
      ? `${sh.name} is verified open, about ${sh.distanceKm} kilometers away, last checked ${sh.verifiedMinutesAgo} minutes ago.`
      : "There's no verified-open shelter near you right now — check the official source Skywatch is watching.");
    lines.push(brief.emergency || "Call 911 if you are in danger.");
    return lines;
  }

  function endCall() {
    clearCallTimers();
    callLayer.hidden = true;
    callLayer.innerHTML = "";
  }

  /* =========================================================================
   * toasts
   * =======================================================================*/

  function toast(text, tone) {
    const zone = $("#toasts");
    const t = document.createElement("div");
    t.className = "toast " + (tone || "");
    t.textContent = text;
    zone.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 400); }, 3400);
    while (zone.children.length > 3) zone.firstChild.remove();
  }

  /* =========================================================================
   * boot
   * =======================================================================*/

  function renderAll() {
    $("#sbTime").textContent = fmtClock();
    renderStatusRight();
    renderHome();
    if (state.tab === "mesh") renderMesh();
    if (state.tab === "profile") renderProfile();
    renderMeshBadge();
    if (screens.map.classList.contains("active")) drawMap();
  }

  function renderStatusRight() {
    const mode = state.mode;
    const label = !isAutoNet()
      ? (mode === "online" ? "5G·M" : mode === "offline" ? "OFF·M" : "GW·M")
      : (mode === "online" ? "AUTO-5G" : mode === "offline" ? "OFFLINE" : "GATEWAY");
    const el = $("#sbMode");
    if (el.textContent !== label) {
      el.textContent = label;
      el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!callLayer.hidden) { endCall(); return; }
    if (!$("#sheet").hidden) closeSheet();
    if (!$("#modalWrap").hidden) $("#modalWrap").hidden = true;
  });

  let bootRan = false;
  function boot() {
    if (bootRan) return;
    bootRan = true;
    loadAll();
    buildTabbar();
    setInterval(() => { $("#sbTime").textContent = fmtClock(); }, 30000);
    $("#sbTime").textContent = fmtClock();

    // status signal bars
    $("#sbSignal").innerHTML = "<i></i><i></i><i></i><i></i>";

    sizeCanvas();
    fitMapSoon();
    ensureIdentity().then(renderOnLoadIdentity);
    renderAll();

    if (!isSignedUp() || !isOnboarded()) startOnboarding();
    else { void safe(resyncAll(true)); }

    startPolling();
    startHealthRetry(); // queued packets from a past session drain even without a mode transition
    // debug hook (harmless; also lets the lead inspect live state from the console)
    window.__sky = { state, view, refit: () => { fitAll(); drawMap(); }, draw: drawMap, ensureIdentity, queuePacket, syncGateway };
  }

  function renderOnLoadIdentity() {
    if (state.tab === "profile") renderProfile();
    if (state.tab === "mesh") renderMesh();
  }

  // health probe on load decides whether the online shell even has an API behind it
  window.addEventListener("DOMContentLoaded", () => {
    boot();
    probeHealth().then((ok) => {
      if (!ok && state.mode === "online") {
        // no API reachable at boot: offline-first shell, honest about it
        state.autoOff = false;
        setMode("offline", { quiet: true });
        toast("No API reachable — offline-first shell.", "mesh");
      } else if (ok) {
        void safe(resyncAll(true));
      }
    });
    maybeFirstRun();
  });
  drawMapLoop();
})();