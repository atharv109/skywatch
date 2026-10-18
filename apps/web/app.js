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
 * Mesh tab has three surfaces (NEIGHBORS broadcasts / DIRECTS 1:1 by peer hash /
 * SKYWATCH asks); photos ride packets as photoRef+label, downscale client-side,
 * and upload to /api/mesh/photo after each sync; the downlink bundle's satellite
 * overlay (plumes/alerts/aqi) persists in LS and renders on the Map offline too.
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
    photos: "skywatch.photos",    // pending photo uploads keyed by photoRef { data, label }
    sat: "skywatch.satellite",    // last downlink satellite overlay { plumes, alerts, aqi, fetchedAt }
    routes: "skywatch.routes",    // last downlink routes { routes: [{geometry,steps,dest…}], at }
  };

  function lsGet(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (_e) { return fallback; }
  }
  function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (_e) { /* storage unavailable — session only */ } }

  function loadAll() {
    state.cfg = lsGet(LS.cfg, { api: "", toolSecret: "", photonSecret: "", userId: "" });
    const q = new URLSearchParams(location.search);
    if (q.get("api")) state.cfg.api = q.get("api").replace(/\/+$/, "");
    state.profile = lsGet(LS.profile, {});
    state.queue = lsGet(LS.queue, []);
    state.thread = lsGet(LS.thread, []);
    state.flags = lsGet(LS.flags, {});
    state.loc = lsGet(LS.loc, null);
    state.routes = lsGet(LS.routes, null); // dark phones keep the last carried route
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
    routes: null,              // last route pack (/demo routes[] via the mesh — walked offline too)
    areaBrief: null,           // /demo/area-brief fallback { data, at } — Home's no-signup brief
    areaNote: null,            // "off" once /demo/area-brief proved absent on this server
    tab: "home",
    identity: null,            // per-session Ed25519 identity
    ob: null,                  // onboarding flow state
    meshView: "neighbors",     // 'neighbors' | 'directs' | 'skywatch' — Mesh sub-surface
    dmPeer: null,              // selected DIRECTS peer device hash
    dmSeenAt: 0,               // newest received-DM ts already seen (Directs badge)
    nbSeenAt: 0,               // newest neighbor broadcast ts already seen (Neighbors badge)
    composerPhoto: null,       // { ref, data, kb } attached before send; uploads after the sync
    polls: {},                 // timers
    healthTimer: null,
    loading: { brief: true, map: true, mesh: true, area: false },
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
  /* "Already signed up over SMS?" — continue the REAL signup: POST /demo/brief
   * {phone} (contract of apps/api/src/routes/demo.ts, Task 8h) and go straight
   * to Home with the brief from Skywatch's live record. 404 = do the quick
   * signup below. */
  function resumeDemoBrief() {
    const errEl = $("#obResumeErr", obEl);
    const btn = $("#obResume", obEl);
    const input = $("#obResumePhone", obEl);
    // normalize to E.164 before any POST — a bare "4258329409" (or "(425) 832-9409",
    // unicode dashes/spaces) must become "+14258329409", never sent raw
    const typed = String(input ? input.value : "");
    const hasPlus = /^\s*\+/.test(typed);
    const digits = typed.replace(/\D+/g, "");
    let raw = null;
    if (!hasPlus && (digits.length === 10 || (digits.length === 11 && digits[0] === "1"))) {
      raw = "+1" + digits.slice(digits.length - 10);
    } else if (hasPlus && /^\d{11,15}$/.test(digits)) {
      raw = "+" + digits;
    }
    if (!raw) {
      if (errEl) { errEl.style.display = "block"; errEl.textContent = "That doesn't look like a phone number — e.g. 4258329409 or +14258329409."; }
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
    if (errEl) { errEl.style.display = "none"; errEl.textContent = ""; }
    apiFetch("/demo/brief", { method: "POST", body: { phone: raw, platform: "sms" }, timeoutMs: 9000 })
      .catch(() => {
        if (btn) { btn.disabled = false; btn.textContent = "Continue"; }
        if (errEl) { errEl.style.display = "block"; errEl.textContent = "No signal here — try the resume once one of us gets signal, or do the quick signup below."; }
        return null;
      })
      .then((result) => {
        if (!result) return;
        if (btn) { btn.disabled = false; btn.textContent = "Continue"; }
        if (result.ok && result.json && result.json.userId) {
          const j = result.json;
          state.profile = Object.assign({}, state.profile, { phone: raw, platform: "sms", lang: j.lang || state.profile.lang, userId: j.userId, onboarded: true });
          persist.profile();
          if (j.userId) { state.cfg.userId = j.userId; if (j.briefToken) state.cfg.briefToken = j.briefToken; lsSet(LS.cfg, state.cfg); }
          if (j.brief) { state.brief = j.brief; state.briefNote = null; cacheData("brief", j.brief); }
          state.flags.pendingDemoSignup = null; persist.flags();
          obEl.hidden = true; state.ob = null;
          toast("Resuming your real signup — brief from Skywatch's live record.", "ok");
          renderHome();
        } else if (result.status === 404) {
          if (errEl) { errEl.style.display = "block"; errEl.textContent = "That phone isn't signed up yet — do the quick signup below."; }
        } else {
          if (errEl) { errEl.style.display = "block"; errEl.textContent = result.status === 403 || result.status === 404 ? "Demo brief reads are off on this server — continue with the quick signup below." : "The server answered " + (result.status || "offline") + " — quick signup below still works."; }
        }
      });
  }

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
  /* photo label enum — the ONLY values the photo store accepts; omitted when none chosen */
  const PHOTO_LABELS = ["road-broken", "fire", "safe-place", "flood", "other"];

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
  const net = { probeMs: null, probeOk: null }; // last /health latency (Profile → Connection)

  function startHealthRetry() {
    stopHealthRetry();
    healthTimer = setInterval(async () => {
      if (state.netOverride === "offline") return; // manual "force demo offline" stays dark
      if (window.SkyNav && window.SkyNav.active) return; // navigation is fully offline: no background network while it runs
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
    if (state.flags.pendingDemoSignup) { // onboarding that finished dark — sign up now
      const texts = state.flags.pendingDemoSignup || [];
      state.flags.pendingDemoSignup = null; persist.flags();
      void signUpDemo(texts);
    }
    if (state.flags.pendingSummary) {
      state.flags.pendingSummary = false; persist.flags();
      appendSummaryCard();
    }
  }

  async function probeHealth() {
    const t0 = performance.now();
    try {
      const r = await fetch(apiBase() + "/health", { signal: timeoutSig(3500) });
      net.probeMs = Math.round(performance.now() - t0);
      net.probeOk = r.ok;
      return r.ok;
    } catch (_e) {
      net.probeOk = false; // keep the last ms — display shows "no answer", not a fake number
      return false;
    }
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
    cam: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3.2L9 5.5h6L16.8 8H20v11H4z"/><rect x="9" y="11" width="6" height="5" rx="1.2"/><path d="M9.5 11.2 12 8.8l2.5 2.4"/></svg>',
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
      if (!btn) return;
      const tab = btn.dataset.tab;
      if (tab === state.tab) {
        // double-tap the ACTIVE tab = scroll the pane to top (iOS muscle memory)
        const now = performance.now();
        const last = bar._lastActiveTap || 0;
        bar._lastActiveTap = now;
        if (now - last < 320) {
          haptic(4);
          const pane = screens[tab];
          if (pane) pane.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
        }
        return;
      }
      switchTab(tab);
    });
  }

  function prefersReducedMotion() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (_e) { return false; }
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
    // demo round-trip: /demo/signup stored this device's userId — byPhone reads carry it
    const uid = state.cfg.userId ? "?user=" + encodeURIComponent(state.cfg.userId) : "";
    const phone = state.profile.phone;
    const result = await guarding(async () => {
      // signed share token first (ungated); byPhone needs TOOL_SECRET once it is set server-side
      if (state.cfg.briefToken) {
        const t = await apiFetch(`/b/${encodeURIComponent(state.cfg.briefToken)}/data`, { timeoutMs: 8000 });
        if (t && t.ok) return t;
      }
      const r = await apiFetch(`/tools/brief/byPhone/${state.profile.platform}/${phone}${uid}`, { timeoutMs: 8000 });
      if (r && r.status === 401 && phone) {
        // self-heal an older signup that never stored a token: re-resolve it by phone
        const d = await apiFetch("/demo/brief", { method: "POST", body: { phone, platform: state.profile.platform }, timeoutMs: 8000 });
        if (d && d.ok && d.json && d.json.briefToken) {
          state.cfg.briefToken = d.json.briefToken; lsSet(LS.cfg, state.cfg);
          return Object.assign({}, d, { json: d.json.brief });
        }
      }
      return r;
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
    const meshRoutes = Array.isArray(result.json.routes) && result.json.routes.length
      ? result.json.routes
      : (result.json.bundle && Array.isArray(result.json.bundle.routes) ? result.json.bundle.routes : null);
    if (meshRoutes) { state.routes = { routes: meshRoutes, at: Date.now() }; lsSet(LS.routes, state.routes); }
    renderMeshBadge();
    // a fresh mesh state re-renders the open Mesh surface in place (drafts kept; focus only if it was in the box)
    if (state.tab === "mesh") {
      const ta = $("#meshText", screens.mesh);
      const draft = ta ? ta.value : "";
      const wasFocused = ta && document.activeElement === ta;
      // the 2 s poll must not rebuild the screen unless something visible changed, and never mid-typing
      // (a rebuild drops the phone keyboard and resets scroll)
      const { generatedAt: _g, ...visible } = result.json;
      const sig = JSON.stringify(visible);
      const changed = sig !== state.meshSig;
      state.meshSig = sig;
      if (!changed && !state.meshDirty) return;
      if (draft) { state.meshDirty = true; return; }
      state.meshDirty = false;
      renderMesh();
      if (wasFocused) { const nf = $("#meshText", screens.mesh); if (nf) nf.focus({ preventScroll: true }); }
      const ta2 = $("#meshText", screens.mesh);
      if (ta2 && draft) { ta2.value = draft; $("#meshCount", screens.mesh).textContent = String(280 - draft.length); if (wasFocused) ta2.focus(); }
    }
  }

  /* ---- demo round-trip: single same-origin POST signup (browser-held secrets are
   * not on the phone) + the no-brief fallback POST /demo/area-brief. Both are
   * optional server gates: 403/404 flips to the honest manual-TOOL_SECRET path. ---- */

  async function signUpDemo(texts) {
    // server contract (apps/api/src/routes/demo.ts): texts 1..5 × ≤140 chars, non-empty
    texts = (texts || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 5);
    const phone = state.profile.phone;
    let result = null;
    try {
      result = await apiFetch("/demo/signup", {
        method: "POST",
        body: { phone, platform: state.profile.platform || "sms", texts },
        timeoutMs: 9000,
      });
    } catch (_e) {
      // no signal at signup time — the texts are already in the thread; send the
      // round-trip when connectivity returns (auto-detect drains it)
      state.flags.pendingDemoSignup = texts || []; persist.flags();
      return;
    }
    state.flags.pendingDemoSignup = null;
    if (result.ok && result.json) {
      const j = result.json;
      if (j.userId) { state.cfg.userId = j.userId; if (j.briefToken) state.cfg.briefToken = j.briefToken; lsSet(LS.cfg, state.cfg); } // later brief reads
      if (j.lang && !state.profile.lang) { state.profile.lang = j.lang; persist.profile(); }
      if (j.brief) { state.brief = j.brief; state.briefNote = null; cacheData("brief", j.brief); }
      state.flags.demoSignupOff = false; persist.flags();
      if (j.mapLink) threadPush("system", "Live area map: " + j.mapLink, "note");
      toast("Signed up — your brief is on Home.", "ok");
      persist.flags();
      renderHome();
    } else if (result.status === 403 || result.status === 404) {
      // server gate off (or endpoint not deployed) — keep the old manual path
      state.flags.demoSignupOff = true; persist.flags();
      toast("Demo signup is off on this server — byPhone path still works.", "warn");
      renderHome();
    }
  }

  async function fetchAreaBrief(force) {
    if (state.brief) return null;
    // throttle: force-refresh re-POSTs at most once a minute (cached copy always renders)
    if (state.areaBrief && (!force || Date.now() - state.areaBrief.at < 60000)) return state.areaBrief;
    state.loading.area = true;
    let result = null;
    const loc = myLoc();
    try {
      result = await apiFetch("/demo/area-brief", { method: "POST", body: { lat: loc.lat, lon: loc.lon }, timeoutMs: 8000 });
    } catch (_e) {
      state.loading.area = false; state.areaNote = "off"; return null; // absent/dark — honest empty state remains
    }
    state.loading.area = false;
    if (result.ok && result.json) {
      const data = result.json.brief || result.json;
      state.areaBrief = { data, at: Date.now() };
      cacheData("areaBrief", state.areaBrief);
      if (state.tab === "home") renderHome(); // land it without a tap
      return state.areaBrief;
    }
    state.areaNote = "off";
    return null;
  }

  function pollOnce() {
    if (state.mode !== "online") return;
    void safe(fetchBrief(true));
    void safe(fetchMapState());
    void safe(fetchMeshState());
  }
  function startPolling() {
    stopPolling();
    state.polls.tick = setInterval(() => { if (!document.hidden && !(window.SkyNav && window.SkyNav.active)) pollOnce(); }, 12000);
    // fast mesh-state poll (2 s, online/gateway): a DM delivers the moment ANY
    // connectivity exists — no user action, no waiting on the slow brief cycle
    state.polls.mesh = setInterval(() => {
      if (document.hidden || (window.SkyNav && window.SkyNav.active)) return; // nav mode: no background polling
      if (state.mode === "online" || state.mode === "gateway") void safe(fetchMeshState());
    }, 2000);
  }
  function stopPolling() { if (state.polls.tick) clearInterval(state.polls.tick); state.polls.tick = null; if (state.polls.mesh) clearInterval(state.polls.mesh); state.polls.mesh = null; }

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
    void signUpDemo(state.ob ? (state.ob.texts || []).slice() : []); // one same-origin POST — brief lands on Home
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
    // demo round-trip: no per-text webhook POSTs from the browser — the texts
    // are collected here and go out in ONE /demo/signup POST at finish.
    state.ob = state.ob || { texts: [] };
    state.ob.texts = state.ob.texts || []; // startOnboarding's ob object predates the texts field
    state.ob.texts.push(text);
    threadPush("user", text, state.mode === "online" ? "ob" : "queued");
    if (state.mode !== "online") {
      toast("Saved in the thread — signs up when one of us gets signal.", "mesh");
    }
    if (mirroredReply) threadPush("bot", mirroredReply, "mirror");
    return true;
  }

  function renderOb() {
    const ob = state.ob;
    if (!ob) return;
    obEl.scrollTop = 0; // each step lands at the top — the advance is visible
    const footer =
      ob.step === 0
        ? `<button class="btn btn-primary btn-block" id="obNext">Say hi and continue</button>`
        : ob.step === 2
          ? `<button class="btn btn-primary btn-block" id="obFinish">Turn on Skywatch</button>`
          : `<button class="btn btn-primary btn-block" id="obNext" disabled>Continue</button>`;

    if (ob.step === 0) {
      obEl.innerHTML = `
        <div class="onboard-brand"><img class="brand-mark" src="brand/logo.png" alt="" onerror="this.remove()"><span>Skywatch · SMS</span></div>
        <div class="ob-step">
          <div class="ob-sms">
            <div class="ob-msgr"><div class="ob-msg me">hi</div></div>
            <div class="ob-msgr"><div class="ob-msg bot">${esc(MIRRORED.welcome)}</div></div>
            <p class="ob-hint">Replies arrive over SMS; in this demo read them here (same state machine, same copy).</p>
          </div>
          <div class="card" id="obResumeCard" style="margin-top:14px">
            <b style="font-size:14px;font-family:var(--fd)">Already signed up over SMS?</b>
            <p class="mini dim2" style="margin:4px 0 9px">Enter the phone you texted from — Skywatch continues where your real signup left off.</p>
            <div style="display:flex;gap:8px">
              <input id="obResumePhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+1 425 555 0100" style="flex:1;min-height:46px;padding:0 13px;background:var(--surface2);border:1px solid var(--line2);border-radius:13px;color:var(--text);font:inherit">
              <button class="btn btn-primary" id="obResume" style="min-height:46px;padding:0 16px;font-weight:600">Continue</button>
            </div>
            <p class="mini" id="obResumeErr" style="margin-top:8px;color:var(--warn);display:none"></p>
          </div>
          <h2 style="margin-top:20px">Getting you set up</h2>
          <p class="sub">Or do the quick signup — same flow the real SMS bot runs. Say hi, share where to watch, pick your language.</p>
        </div>
        <div class="ob-foot">${footer}</div>`;
      $("#obNext", obEl).addEventListener("click", async () => {
        haptic(8);
        if ((ob.texts || []).includes("hi")) { // Back from step 1: never re-send the "hi"
          ob.step = 1; renderOb();
          return;
        }
        const ok = await obSend("hi", MIRRORED.welcome);
        if (ok) { ob.step = 1; renderOb(); }
      });
      $("#obResume", obEl).addEventListener("click", () => { haptic(8); resumeDemoBrief(); });
      $("#obResumePhone", obEl).addEventListener("keydown", (e) => {
        if (e.key === "Enter") { haptic(8); resumeDemoBrief(); }
      });
    } else if (ob.step === 1) {
      obEl.innerHTML = `
        <div class="onboard-brand"><img class="brand-mark" src="brand/logo.png" alt="" onerror="this.remove()"><span>Skywatch · SMS</span></div>
        <div class="ob-step">
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
        <div class="onboard-brand"><img class="brand-mark" src="brand/logo.png" alt="" onerror="this.remove()"><span>Skywatch · SMS</span></div>
        <div class="ob-step">
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
        </div>
        <div class="ob-foot">${footer}</div>`;
      $("#swText", obEl).addEventListener("click", (e) => e.target.setAttribute("aria-pressed", e.target.getAttribute("aria-pressed") !== "true"));
      $("#swVoice", obEl).addEventListener("click", (e) => e.target.setAttribute("aria-pressed", e.target.getAttribute("aria-pressed") !== "true"));
      $("#obFinish", obEl).addEventListener("click", () => { haptic(14); obDone(); });
    }

    // chrome added AFTER the step template: progress dots (3, active orange)
    // under the header brand + a Back chevron on steps 1 and 2
    const brand = $(".onboard-brand", obEl);
    if (brand) {
      const dots = document.createElement("div");
      dots.className = "ob-progress";
      dots.setAttribute("aria-label", "Step " + (ob.step + 1) + " of 3");
      dots.innerHTML = [0, 1, 2].map((n) => `<i${n === ob.step ? ' class="on"' : ""}></i>`).join("");
      brand.insertAdjacentElement("afterend", dots);
    }
    if (ob.step > 0) {
      const back = document.createElement("button");
      back.className = "ob-back";
      back.setAttribute("aria-label", "Back one step");
      back.textContent = "← Back";
      obEl.insertBefore(back, obEl.firstChild);
      back.addEventListener("click", () => {
        haptic(6);
        state.ob.step -= 1;
        renderOb();
      });
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
    // the server stores/serves every sender as sha256(deviceId)[:10]; keep it to recognise our own echoes
    identity.hash = await sha256HexPrefix(new TextEncoder().encode(identity.deviceId), 10);
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
      to: opts.to || "",   // "" = broadcast · <peer hash> = 1:1 DM · "SKYWATCH" = an Ask Skywatch question
      photoRef: opts.photoRef || null, // attached photo; bytes upload after the sync (LS pending)
      hazard: opts.hazard || null, // on-device vision hazard fact {kind,lat,lon,confidence,label} (vision.js)
      label: kindDef ? "" : String(opts.label || ""), // photo label enum only — captions stay display-only in text
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

  /**
   * Sign one queued packet exactly per src/mesh/sig.ts (msg = id|type|ts|lat|lon|deviceId;
   * sig + pubkey travel as raw base64). Used by syncGateway and handed to the native
   * BLE transport through the seam at the bottom of boot() — the same packet engine.
   */
  async function signedPacketFor(p, identity) {
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
    if (p.to) full.to = p.to; // DM routing (peer hash or SKYWATCH) — added after signing so the sig contract holds
    if (p.photoRef) { full.photoRef = p.photoRef; if (p.label) full.label = p.label; }
    if (p.hazard) full.hazard = p.hazard; // not in the signed string; the API ignores unknown fields, mesh peers/chat read it
    return full;
  }

  /** POST /mesh/sync — sign every queued packet exactly per src/mesh/sig.ts. */
  async function syncGateway(opts) {
    opts = opts || {};
    const identity = await ensureIdentity();
    const loc = myLoc();
    const packets = [];
    const q = state.queue.filter((p) => p.state === "queued" || p.state === "fail");
    for (const p of q) {
      // Packets that arrived pre-signed over the native BLE mesh (p.remote.signed)
      // are relayed untouched under the origin device's sig — never re-signed here.
      packets.push(p.remote ? p.remote.signed : await signedPacketFor(p, identity));
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
      syncGateway._retrying = false;
      const rejected = new Set(result.json.rejectedIds || []);
      state.queue.forEach((p) => {
        if (p.state !== "queued" && p.state !== "fail") return;
        if (rejected.has(p.id)) { p.state = "fail"; return; }
        p.state = "sent";
      });
      state.syncState = { at: Date.now(), received: result.json.received, inserted: result.json.inserted, deduped: result.json.deduped, rejected: result.json.rejected, legacy: identity.legacy, deviceId: identity.deviceId };
      state.bundle = result.json.bundle;
      if (result.json.bundle && result.json.bundle.satellite) {
        lsSet(LS.sat, result.json.bundle.satellite); // dark phones keep the last overlay after rebroadcast
      }
      if (result.json.bundle && Array.isArray(result.json.bundle.routes) && result.json.bundle.routes.length) {
        state.routes = { routes: result.json.bundle.routes, at: Date.now() }; // walked routes ride the bundle down
        lsSet(LS.routes, state.routes);
      }
      persist.queue();
      renderMeshBadge();
      void safe(fetchMeshState());
      void safe(flushPhotoUploads()); // batched after the sync — pending photos ride out
      return result.json;
    }
    // (a 413 here is the batch cap only — photo bytes never ride the batch;
    //  photoRef pointers + optional enum labels are the only photo fields on packets.)
    syncGateway._retrying = false;
    q.forEach((p) => { p.state = "fail"; });
    persist.queue();
    if (!opts.silent) toast("Gateway sync refused (" + (result.status || "network") + ")", "warn");
    return null;
  }

  /**
   * Ingest packets received peer-to-peer over the native BLE transport (already
   * signed by the origin device). Same packet engine, same dedup contract (by id)
   * the server enforces again at /mesh/sync. They keep riding the queue — when
   * this device has signal, syncGateway relays them to the API as-is.
   */
  function ingestRemotePackets(signedPackets) {
    if (!Array.isArray(signedPackets)) return 0;
    let added = 0;
    for (const sp of signedPackets) {
      if (!sp || !sp.id || !sp.deviceId) continue;
      if (state.queue.some((p) => p.id === sp.id)) continue; // dedup by id — no relay loops
      state.queue.push({
        id: sp.id,
        kind: sp.type || "msg",
        status: sp.type === "msg" ? "" : String(sp.status || ""),
        text: sp.type === "msg" ? String(sp.status || "") : "",
        to: sp.to || "",
        photoRef: sp.photoRef || null,
        label: sp.label || "",
        lat: +sp.lat || 0,
        lon: +sp.lon || 0,
        ts: +sp.ts || Date.now(),
        queuedAt: Date.now(),
        state: "queued",
        remote: { signed: sp }, // never re-signed here — hops is the only mutable field (sig excludes it)
      });
      added++;
    }
    if (added) {
      persist.queue();
      renderMeshBadge();
      if (state.mode === "online" || state.mode === "gateway") void safe(syncGateway({ silent: true }));
    }
    return added;
  }

  /** POST pending photo uploads (LS) to the real photo store; batched after each sync. */
  async function flushPhotoUploads() {
    const pending = lsGet(LS.photos, {});
    const refs = Object.keys(pending);
    if (!refs.length || state.mode === "offline") return;
    const id = state.identity ? state.identity.deviceId : null;
    if (!id) return;
    for (const ref of refs) {
      const ph = pending[ref];
      const body = { deviceId: id, photoRef: ref, data: b64Only(ph.data) }; // RAW base64, no dataURL prefix
      if (ph.label && PHOTO_LABELS.includes(ph.label)) body.label = ph.label; // enum only (road-broken|fire|safe-place|flood|other) — omitted otherwise / for stale pre-fix entries
      let r;
      try {
        r = await fetch(apiBase() + "/mesh/photo", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: timeoutSig(15000),
        });
      } catch (_e) { return; } // endpoint absent/network down — retry on the next sync
      if (r.ok) {
        delete pending[ref];
        lsSet(LS.photos, pending);
      } else if (r.status === 413) {
        delete pending[ref];
        lsSet(LS.photos, pending);
        state.queue.forEach((p) => { if (p.photoRef === ref) delete p.photoRef; });
        persist.queue();
        toast("photo too large — resending without it.", "warn");
      } else if (r.status === 400 || r.status === 403) {
        // permanent server refusal (validation 400, or the device isn't a
        // signature-pinned uploader 403 — flushing already runs after the sync,
        // so a 403 here won't self-heal on the next retry). Keep retrying it
        // forever was the silent fail: the report synced, the photo just never
        // landed and nobody heard about it. Drop it, strip the ref so the next
        // sync stops advertising a photo that has no bytes, and SAY IT.
        const reason = await r.json().then((j) => (j && j.error) || "").catch(() => "");
        delete pending[ref];
        lsSet(LS.photos, pending);
        state.queue.forEach((p) => { if (p.photoRef === ref) delete p.photoRef; });
        persist.queue();
        toast(
          r.status === 403
            ? "this device can't upload photos (unsigned/not pinned) — the report went without it."
            : "photo rejected" + (reason ? " (" + reason + ")" : "") + " — the report went without it.",
          "warn",
        );
      } else {
        return; // 5xx / anything odd — keep it pending, retry on the next sync
      }
      renderMeshBadge();
    }
  }

  /* hazard detail sheet (tap on a Home hazard card): severity, timing window,
   * all actions in order, official source — same close affordances as every sheet */
  function openHazSheet(hz, brief) {
    const sev = SEV.find((s) => s.n === hz.severity) || SEV[3];
    const acts = (brief.actions || []).map((a, i) =>
      `<div class="action-row"><span class="n">${i + 1}</span><span>${esc(a.text)}</span></div>`
    ).join("") || '<p class="mini dim">No step-by-step actions in this brief — the severity chip above carries the level.</p>';
    openSheet(`
      <h3>${esc(hz.title)}</h3>
      <div class="chips" style="margin:10px 0 0">
        <span class="chip ${sev.cls} sev">${sev.label}</span>
        <span class="chip chip-n">${esc(hz.timing || "active now")}</span>
        ${hz.type ? `<span class="chip chip-n chip-mono">${esc(hz.type)}</span>` : ""}
      </div>
      <div class="sec-label" style="margin:14px 0 6px;font-size:14px">What Skywatch says to do — in order</div>
      <div class="actions">${acts}</div>
      ${brief.officialSource ? `<a class="btn btn-ghost btn-block" style="margin-top:12px" href="${esc(brief.officialSource.url || "#")}" target="_blank" rel="noopener">${ICONS.info} ${esc(brief.officialSource.name || "Official source")}</a>` : ""}
    `);
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
            <img class="brand-logo" src="brand/logo.png" alt="Skywatch logo" onerror="this.remove()">
            <div style="color:var(--accent);margin-top:10px">${ICONS.shield}</div>
            <div style="font-family:var(--fd);font-size:20px;font-weight:700">Skywatch</div>
            <p class="dim2" style="font-size:13px;margin-top:6px">Sign up once — then hazards near you arrive by text, and a voice check-in reads them to you when they matter.</p>
            <button class="btn btn-primary btn-block" id="homeOnboard" style="margin-top:16px">Get set up — it's one text</button>
          </div>
        </div>`;
      $("#homeOnboard").addEventListener("click", startOnboarding);
      return;
    }

    const skeleton = !brief && state.loading.brief; // loading a real (personal) brief only — offline boots fall through to the area route
    const syncedAt = briefSrc && !briefSrc.live ? briefSrc.at : null;
    // no personal brief (not signed up yet / fetch failed): the area-brief route
    // fills Home — device position if shared, else the demo center
    const areaSrc = brief === null && !skeleton ? cached("areaBrief") : null;
    const area = areaSrc ? areaSrc.data : null;
    const briefView = brief || area; // one renderer, two sources
    const isArea = !brief && !!area;

    el.innerHTML = `
      <div class="stagger">
        ${syncedAt ? `<p class="mini dim" style="margin-bottom:8px">Cached from ${esc(fmtAgo(syncedAt))} — live sync waits for signal</p>` : ""}
        <div class="sec-label" style="margin-top:2px">Your safety brief<small>${esc(myLoc().label)}</small></div>
        ${state.flags.demoSignupOff ? `
          <div class="card" style="border-color:rgba(240,163,78,.35);margin-bottom:10px">
            <b style="font-size:14px;font-family:var(--fd)">Demo signup is off on this server</b>
            <p class="mini dim2" style="margin-top:4px">Enter the server's TOOL_SECRET and Home reads your brief via byPhone — the manual path still works.</p>
            <button class="btn btn-ghost btn-block" id="openSecret" style="margin-top:10px">Add the server's TOOL_SECRET</button>
          </div>` : ""}
        ${skeleton ? `
          <div class="skel" style="height:92px;margin-bottom:10px"></div>
          <div class="skel" style="height:150px;margin-bottom:10px"></div>
          <div class="skel" style="height:118px"></div>
        ` : brief === null ? (area ? `
          <div class="chips" style="margin:0 0 10px">
            <span class="chip chip-n">area brief — sign up for personalized alerts</span>
            <span class="chip chip-ok">${ICONS.shieldS} covers your area</span>
          </div>
          <div class="card">
            <div class="hz-line">
              <span style="font-family:var(--fd);font-weight:700;font-size:15px">${(area.hazards || []).length ? "Current hazards" : "All clear in your area"}</span>
              ${(area.hazards || []).length ? `<span class="chip chip-danger sev">${area.hazards.length} active</span>` : `<span class="chip chip-ok sev">clear</span>`}
            </div>
            <div class="hz-timing" id="homeHaz"></div>
          </div>
          <div id="hazards"></div>
          <div class="card" style="margin-top:10px">
            <b style="font-size:14px;font-family:var(--fd)">Want this by text?</b>
            <p class="mini dim2" style="margin-top:4px">One text signs you up — personalized hazards, updates and a voice check-in when it matters.</p>
            <button class="btn btn-primary btn-block" id="homeJoin" style="margin-top:10px">Sign up — one text</button>
          </div>
        ` : `
          <div class="empty">${ICONS.shield}<b>${state.loading.area && !state.areaNote ? "Assembling the area brief around you…" : "No brief yet"}</b><p>${esc(state.briefNote || (state.areaNote ? "No area brief on this server yet, and no personalized brief — finish signup to get yours." : "Skywatch is assembling your brief the moment your signup lands in its pipeline."))}</p></div>
        `) : `
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

    const secretBtn = $("#openSecret", el);
    if (secretBtn) secretBtn.addEventListener("click", () => openConfigModal(false));
    const joinBtn = $("#homeJoin", el);
    if (joinBtn) joinBtn.addEventListener("click", startOnboarding);

    if (state.mode === "offline") {
      const chip = document.createElement("div");
      chip.className = "card";
      chip.style.borderColor = "rgba(164,148,242,.35)";
      chip.innerHTML = `<div style="display:flex;gap:10px;align-items:center;color:var(--mesh)">${ICONS.wifi}<b style="color:var(--mesh)">You're offline — mesh mode</b></div><p class="mini dim2" style="margin-top:6px">Home and Map are reading the last sync. Anything new you report queues up and sends when one of us gets signal.</p>`;
      const label = el.querySelector(".sec-label");
      label && label.insertAdjacentElement("afterend", chip);
    }

    if (!skeleton && brief) renderBriefParts(el, brief);
    if (!skeleton && isArea) {
      renderBriefParts(el, area);
      if (!state.flags.demoSignupOff) void fetchAreaBrief(true); // silent refresh — cached copy renders instantly
    }
    if (brief === null && !skeleton && !area && !state.areaNote) void fetchAreaBrief(); // both-routes-absent gate before the empty state
    if (!skeleton) renderIncoming(el);
    render911(el, briefView);
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
        return `<div class="card card-hover" style="--i:${i};margin-top:10px" data-haz="${esc(hz.title)}">
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
      hazEl.querySelectorAll("[data-haz]").forEach((cardEl) => {
        cardEl.setAttribute("role", "button");
        cardEl.setAttribute("aria-haspopup", "dialog");
        cardEl.addEventListener("click", () => {
          const hz = (brief.hazards || []).find((x) => x.title === cardEl.dataset.haz);
          if (hz) openHazSheet(hz, brief);
        });
      });
    }

    // summary-card timing line (the #homeHaz div under "Current hazards · N active"):
    // the brief arrives worst-first, so the top hazard's window is THE decision line
    const homeHaz = $("#homeHaz", el);
    if (homeHaz) {
      const top = (brief.hazards || [])[0];
      homeHaz.textContent = top ? String(top.timing || "") : "";
      homeHaz.style.display = top && top.timing ? "" : "none"; // no ghost 5px gap on the all-clear card
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

  function render911(el, viewBrief) {
    const brief = viewBrief || state.brief || (cached("brief") || {}).data || null;
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

  function openSheet(html, onOpen, cls) {
    const scrim = $("#sheetScrim"), sheet = $("#sheet");
    scrim.hidden = false; sheet.hidden = false;
    scrim.className = "sheet-scrim" + (cls ? " scrim-soft" : "");
    sheet.className = "sheet" + (cls ? " " + cls : "");
    // depth cue: the page behind scales down subtly while a sheet is open
    const pane = $(".screens");
    if (pane) pane.classList.add("dimmed-by-sheet");
    scrim.onclick = closeSheet;
    sheet.onclick = (e) => { if (e.target.closest("[data-close]")) closeSheet(); };
    sheet.innerHTML = `<div class="sheet-grip"></div>` + html;
    wireSheetGrip(sheet); // drag-down / tap on the grabber dismisses (any sheet)
    if (onOpen) onOpen(sheet);
  }
  function closeSheet() {
    stopNavWatch();
    $("#sheet").hidden = true; $("#sheetScrim").hidden = true;
    const pane = $(".screens");
    if (pane) pane.classList.remove("dimmed-by-sheet");
    if (routeTo) { routeTo = null; if (screens.map.classList.contains("active")) drawMap(); }
  }

  /* sheet grabber: a real swipe (≥60px down) dismisses from any drag on the
   * grip; a plain tap on it also closes; ESC works per the key handler */
  function wireSheetGrip(sheet) {
    const grip = sheet.querySelector(".sheet-grip");
    if (!grip || grip._wired) return;
    grip._wired = true;
    let sy = null, dy = 0;
    grip.style.touchAction = "none";
    grip.addEventListener("pointerdown", (e) => {
      grip.setPointerCapture(e.pointerId);
      sy = e.clientY; dy = 0;
      sheet.style.transition = "none";
    });
    grip.addEventListener("pointermove", (e) => {
      if (sy == null) return;
      dy = Math.max(0, e.clientY - sy);
      sheet.style.transform = "translateY(" + dy + "px)";
      sheet.style.opacity = String(Math.max(0.55, 1 - dy / 260));
    });
    const end = () => {
      if (sy == null) return;
      sy = null;
      sheet.style.transform = ""; sheet.style.opacity = "";
      sheet.style.transition = "";
      if (dy >= 60) closeSheet(); // real swipe down — dismiss
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    grip.addEventListener("click", () => { if (dy === 0) closeSheet(); }); // plain tap on the grabber
  }

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
   * MAP — tile slippy map (offline pack) + brand pin/route rendering
   * =======================================================================*/
  /* Tiles come only from the committed local pack (apps/web/tiles, mirrored into
   * the SW precache) — no network tile fetches ever happen, demo-safe offline.
   * PACK below is the manifest of what's committed (z13 full Seattle bbox
   * 5x6, z14 downtown/eastside 7x8, z15 Capitol Hill/First Hill 3x3 — Esri
   * World Dark Gray raster). Pan/zoom clamp to the pack bounds, so no
   * black-void scrolling is possible; the empty-state backdrop is a subtle
   * dot grid. */

  const canvas = $("#mapCanvas");
  let ctx = null;
  const view = { cx: 0, cy: 0, zoom: 1, init: false };
  let pinCache = [];
  /* photo pipeline: tap targets + thumbnail <img> cache for the mesh photo markers */
  let photoPinCache = [];
  const photoImgCache = new Map(); // photoRef-url -> HTMLImage (drawn only once loaded)
  const photoImgFailed = new Set(); // tombstones for refs whose bytes never resolve (404) — no re-fetch loop

  /* tile pack manifest (must match apps/web/tiles on disk) */
  const PACK = {
    minZ: 13, maxZ: 15,
  };
  const TILE_SIZE = 256;
    const tileKeys = new Set([
    "13/1310/2858", "13/1311/2858", "13/1312/2858", "13/1313/2858", "13/1314/2858",
    "13/1310/2859", "13/1311/2859", "13/1312/2859", "13/1313/2859", "13/1314/2859",
    "13/1310/2860", "13/1311/2860", "13/1312/2860", "13/1313/2860", "13/1314/2860",
    "13/1310/2861", "13/1311/2861", "13/1312/2861", "13/1313/2861", "13/1314/2861",
    "13/1310/2862", "13/1311/2862", "13/1312/2862", "13/1313/2862", "13/1314/2862",
    "13/1310/2863", "13/1311/2863", "13/1312/2863", "13/1313/2863", "13/1314/2863",
    "14/2620/5716", "14/2621/5716", "14/2622/5716", "14/2623/5716", "14/2624/5716", "14/2625/5716", "14/2626/5716",
    "14/2620/5717", "14/2621/5717", "14/2622/5717", "14/2623/5717", "14/2624/5717", "14/2625/5717", "14/2626/5717",
    "14/2620/5718", "14/2621/5718", "14/2622/5718", "14/2623/5718", "14/2624/5718", "14/2625/5718", "14/2626/5718",
    "14/2620/5719", "14/2621/5719", "14/2622/5719", "14/2623/5719", "14/2624/5719", "14/2625/5719", "14/2626/5719",
    "14/2620/5720", "14/2621/5720", "14/2622/5720", "14/2623/5720", "14/2624/5720", "14/2625/5720", "14/2626/5720",
    "14/2620/5721", "14/2621/5721", "14/2622/5721", "14/2623/5721", "14/2624/5721", "14/2625/5721", "14/2626/5721",
    "14/2620/5722", "14/2621/5722", "14/2622/5722", "14/2623/5722", "14/2624/5722", "14/2625/5722", "14/2626/5722",
    "14/2620/5723", "14/2621/5723", "14/2622/5723", "14/2623/5723", "14/2624/5723", "14/2625/5723", "14/2626/5723",
    "15/5249/11442", "15/5250/11442", "15/5251/11442",
    "15/5249/11443", "15/5250/11443", "15/5251/11443",
    "15/5249/11444", "15/5250/11444", "15/5251/11444",
  ]);
  /* demo view cone — keeps pan/pinch inside the packed area */
  const BOUNDS = { lon0: -122.435, lon1: -122.205, lat0: 47.535, lat1: 47.695 };

  const tileImgs = new Map();  // "z/x/y" -> { img, state: "load" | "ok" | "missing" }
  const tilePending = new Set();

  function ensureTile(z, x, y) {
    const key = z + "/" + x + "/" + y;
    if (!tileKeys.has(key) || tileImgs.has(key) || tilePending.has(key)) return;
    tilePending.add(key);
    const rec = { img: new Image(), state: "load" };
    rec.img.decoding = "async";
    rec.img.onload = () => { rec.state = "ok"; tileImgs.set(key, rec); tilePending.delete(key); };
    rec.img.onerror = () => { rec.state = "missing"; tilePending.delete(key); };
    rec.img.src = "tiles/" + z + "/" + x + "/" + y + ".png";
  }

  /* Web-mercator helpers (tiles live on the true mercator grid) */
  function lonToX(lon, W) { return ((lon + 180) / 360) * W; }
  function latToY(lat, W) {
    const s = Math.sin((lat * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * W;
  }
  function yToLat(y, W) {
    const n = Math.PI - (2 * Math.PI * y) / W;
    return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
  }

  function dpr() { return window.devicePixelRatio || 1; }

  function sizeCanvas() {
    if (!ctx) ctx = canvas.getContext("2d");
    const r = canvas.getBoundingClientRect();
    const d = DPR();
    canvas.width = Math.round(r.width * d);
    canvas.height = Math.round(r.height * d);
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  /* world pixel size at the current zoom (zoom 1 = 9 km tall, as before) */
  function worldPxFor() {
    const hgt = canvas.clientHeight || 644;
    const kmPerPx = 9 / (hgt * view.zoom);
    const cos0 = Math.cos((view.cy * Math.PI) / 180) || 0.66;
    return (40075 * cos0) / kmPerPx;
  }

  /** screen projector: mercator-based, so pins and tiles align exactly */
  function proj() {
    const w = canvas.clientWidth, hgt = canvas.clientHeight;
    const W = worldPxFor();
    const ox = lonToX(view.cx, W) - w / 2;
    const oy = latToY(view.cy, W) - hgt / 2;
    return {
      x: (lon) => lonToX(lon, W) - ox,
      y: (lat) => latToY(lat, W) - oy,
      W, ox, oy,
      pxPerKm: hgt * view.zoom / 9,
    };
  }

  function panBy(dxPx, dyPx) {
    const W = worldPxFor();
    view.cx = clamp((lonToX(view.cx, W) - dxPx) / W * 360 - 180, BOUNDS.lon0, BOUNDS.lon1);
    view.cy = clamp(yToLat(latToY(view.cy, W) + dyPx, W), BOUNDS.lat0, BOUNDS.lat1);
  }

  function fitMapSoon() {
    sizeCanvas();
    fitAll();
    view.init = true;
    drawMap();
  }

  let routeTo = null; // the selected resource {lon,lat,…} while its sheet is open

  function drawMap() {
    if (!ctx) return;
    const r = canvas.getBoundingClientRect();
    const d = DPR();
    if (canvas.width !== Math.round(r.width * d)) sizeCanvas();
    const w = r.width, hgt = r.height;
    const W = worldPxFor();
    ctx.save();
    ctx.clearRect(0, 0, w, hgt);
    ctx.fillStyle = "#0A0A0B";
    ctx.fillRect(0, 0, w, hgt);
    const tilesDrawn = drawTileLayer(w, hgt, W);
    if (!tilesDrawn) gridBackdrop(w, hgt);
    const mapData = cached("mapState");
    const meshData = cached("mesh");
    if (!mapData) {
      drawMapEmpty(w, hgt);
      ctx.restore();
      renderMapChips();
      return;
    }
    const p = proj();
    const m = mapData.data;
    const t = performance.now();

    // satellite overlay (persisted from the last downlink bundle — dark phones keep it)
    const sat = lsGet(LS.sat, null);
    if (sat) {
      (sat.plumes || []).forEach((pl) => {
        plumRings(pl).forEach((ring) => {
          ctx.beginPath();
          ring.forEach((pair, idx) => {
            const X = p.x(pair[0]), Y = p.y(pair[1]);
            if (idx === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
          });
          ctx.closePath();
          ctx.fillStyle = "rgba(249,115,22,0.16)";
          ctx.fill();
          ctx.strokeStyle = "rgba(249,115,22,0.7)";
          ctx.lineWidth = 1.2;
          ctx.stroke();
        });
      });
      (sat.alerts || []).forEach((al) => {
        if (al == null || al.lat == null || al.lon == null) return;
        const X = p.x(al.lon), Y = p.y(al.lat);
        ctx.beginPath();
        ctx.arc(X, Y, 9.5, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(249,115,22,0.5)";
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(X, Y, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(249,115,22,0.95)";
        ctx.fill();
        ctx.fillStyle = "#241403";
        ctx.font = "700 8px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText("!", X, Y + 3);
      });
    }

    // hazards (polygons, filled by severity)
    (m.hazards || []).forEach((hz) => {
      const polys = geometryPolys(hz.geometry);
      const sevCol = hz.severity >= 4 ? [255, 107, 94] : [249, 115, 22];
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

    // roads: blocked/flooded verdicts — red segment dots
    (m.roads || []).forEach((rd) => {
      const blocked = (rd.status === "flooded" || rd.status === "blocked") && rd.confidence >= 0.5;
      const X = p.x(rd.lon), Y = p.y(rd.lat);
      ctx.beginPath();
      ctx.arc(X, Y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = blocked ? "rgba(255,80,70,0.95)" : "rgba(156,163,175,0.4)";
      ctx.fill();
      if (blocked) {
        ctx.beginPath();
        ctx.arc(X, Y, 8.5, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,80,70,0.35)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    });

    // user dots — small white, 70% opacity
    (m.userDots || []).forEach((ud) => {
      const X = p.x(ud.lon), Y = p.y(ud.lat);
      ctx.beginPath();
      ctx.arc(X, Y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fill();
    });

    // mesh layer
    if (meshData && meshData.data) {
      const ms = meshData.data;
      // photo tap targets are rebuilt per frame (drawPhotoMarker pushes them)
      photoPinCache = [];
      // coverage
      (ms.coverage || []).forEach((cv) => {
        const X = p.x(cv.lon), Y = p.y(cv.lat);
        ctx.beginPath();
        ctx.arc(X, Y, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(164,148,242,0.55)";
        ctx.fill();
      });
      // hazard reports with score bubbles + photo markers
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
        // photo pipeline: a photo-backed report gets a thumbnail marker (tap -> lightbox)
        if (hr.hasPhoto && hr.photoUrl) drawPhotoMarker(hr, X, Y);
      });
      // rescue beacons — orange pulsing dot + priority label
      (ms.beacons || []).forEach((bc, i) => {
        const X = p.x(bc.lon), Y = p.y(bc.lat);
        const pulse = 9 + 5 * Math.sin(t / 420 + i * 1.7);
        ctx.beginPath();
        ctx.arc(X, Y, pulse + 6, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(249,115,22,0.14)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(X, Y, 8, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(249,115,22,0.95)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 1.6;
        ctx.stroke();
        beaconChip(X + 14, Y - 24, "P" + (i + 1), "#F97316");
      });
    }

    // on-device vision hazard markers (vision.js; state.hazardMarkers)
    if (window.SkyVision) window.SkyVision.drawMarkers(ctx, p.x, p.y, view.zoom);
    // my location (under pins, over roads)
    const me = myLoc();
    const mx = p.x(me.lon), my2 = p.y(me.lat);
    ctx.beginPath();
    ctx.arc(mx, my2, 12, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(mx, my2, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fill();
    ctx.strokeStyle = "rgba(10,10,11,0.55)";
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // route line first, so the pin draws on top of it
    drawRouteLine(p, t);

    // resources (brand pins)
    pinCache = [];
    (m.resources || []).forEach((res) => {
      const X = p.x(res.lon), Y = p.y(res.lat);
      pinCache.push({ x: X, y: Y, res });
      drawPin(res, X, Y, t);
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

    ctx.restore();
    renderMapChips();
  }

  function drawTileLayer(w, hgt, W) {
    const ox = lonToX(view.cx, W) - w / 2;
    const oy = latToY(view.cy, W) - hgt / 2;
    let drawn = 0;
    // coarse→fine: a coarse context tile paints first, its z14 children cover it
    for (let z = PACK.minZ; z <= PACK.maxZ; z++) {
      const scale = W / (TILE_SIZE * (1 << z));
      const x0 = Math.floor(ox / (TILE_SIZE * scale)), x1 = Math.floor((ox + w) / (TILE_SIZE * scale));
      const y0 = Math.floor(oy / (TILE_SIZE * scale)), y1 = Math.floor((oy + hgt) / (TILE_SIZE * scale));
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = z + "/" + x + "/" + y;
          if (!tileKeys.has(key)) continue;
          ensureTile(z, x, y);
          const rec = tileImgs.get(key);
          if (rec && rec.state === "ok") {
            const dx = x * TILE_SIZE * scale - ox, dy = y * TILE_SIZE * scale - oy;
            const s = TILE_SIZE * scale;
            ctx.drawImage(rec.img, dx - 0.5, dy - 0.5, s + 1, s + 1);
            drawn++;
          }
        }
      }
    }
    return drawn > 0;
  }

  /* selected-pin route: a REAL carried route polyline when the mesh brought
   * one down for this pin, else the approximate glowing orange path (visual,
   * still useful without any data). */
  function drawRouteLine(p, t) {
    if (!routeTo) return;
    const me = myLoc();
    const carried = routeForResource(routeTo, me);
    if (carried) {
      const pts = routeLinePts(carried, me, p); // me + geometry, screen coords
      if (pts.length >= 2) {
        ctx.save();
        ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.shadowColor = "rgba(249,115,22,0.85)";
        ctx.shadowBlur = 14;
        ctx.strokeStyle = "rgba(249,115,22,0.22)";
        ctx.lineWidth = 9;
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();
        ctx.shadowBlur = 7;
        ctx.strokeStyle = "#F97316";
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();
        ctx.restore();
        return;
      }
    }
    const x1 = p.x(me.lon), y1 = p.y(me.lat);
    const x2 = p.x(routeTo.lon), y2 = p.y(routeTo.lat);
    const ddx = x2 - x1, ddy = y2 - y1;
    const len = Math.hypot(ddx, ddy) || 1;
    const cxp = (x1 + x2) / 2 - (ddy / len) * len * 0.22;
    const cyp = (y1 + y2) / 2 + (ddx / len) * len * 0.22;
    ctx.save();
    ctx.lineCap = "round";
    ctx.shadowColor = "rgba(249,115,22,0.85)";
    ctx.shadowBlur = 14;
    ctx.strokeStyle = "rgba(249,115,22,0.22)";
    ctx.lineWidth = 9;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(cxp, cyp, x2, y2); ctx.stroke();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(249,115,22,0.5)";
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(cxp, cyp, x2, y2); ctx.stroke();
    ctx.shadowBlur = 6;
    ctx.strokeStyle = "#FB923C";
    ctx.lineWidth = 2;
    ctx.setLineDash([13, 9]);
    ctx.lineDashOffset = -(t / 30) % 22;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(cxp, cyp, x2, y2); ctx.stroke();
    ctx.restore();
  }

  /* ---- carried routes (bundle.routes / mesh-state routes) ---- */

  /** {lat,lon} of a route's destination: dest{lat/lon|coords} or the geometry's last point. */
  function routeDest(r) {
    if (r && r.to && typeof r.to.lat === "number" && typeof r.to.lon === "number") return { lat: r.to.lat, lon: r.to.lon }; // wire shape (MeshRouteView)
    if (r && r.dest) {
      if (typeof r.dest.lat === "number" && typeof r.dest.lon === "number") return { lat: r.dest.lat, lon: r.dest.lon };
      if (Array.isArray(r.dest.coords) && r.dest.coords.length >= 2) return { lat: r.dest.coords[1], lon: r.dest.coords[0] };
    }
    const g = r && r.geometry;
    if (g && g.type === "LineString" && Array.isArray(g.coordinates) && g.coordinates.length) {
      const last = g.coordinates[g.coordinates.length - 1];
      return { lat: last[1], lon: last[0] };
    }
    return null;
  }

  /** the carried route that targets THIS pin: dest within 200 m, or — for the
   * verified-open shelter — the single bundled route (fixture fallback). */
  function routeForResource(res, me) {
    const rs = (state.routes && state.routes.routes) || [];
    let best = null, bestD = Infinity;
    for (const r of rs) {
      const d = routeDest(r);
      if (!d) continue;
      const dist = haversineKm(d, res);
      if (dist < bestD) { bestD = dist; best = r; }
    }
    // nav.js normalises the wire shape ({coords:[lat,lon], steps[].instruction, to}) into the
    // geometry/steps[].text/dest shape every consumer below reads (memoised per route object)
    const norm = (r) => (r && window.SkyNav && window.SkyNav.normalizeRoute ? window.SkyNav.normalizeRoute(r) : r);
    if (best && bestD * 1000 <= 200) return norm(best);
    if (res.kind === "shelter" && res.status === "open" && (res.confidence || 0) >= 0.5 && rs.length === 1) return norm(rs[0]);
    return null;
  }

  /** walkable screen points for a carried route: the user dot + the geometry. */
  function routeLinePts(route, me, p) {
    const g = route.geometry;
    if (!g || g.type !== "LineString" || !Array.isArray(g.coordinates)) return [];
    const pts = [[p.x(me.lon), p.y(me.lat)]];
    for (const c of g.coordinates) {
      if (Array.isArray(c) && c.length >= 2) pts.push([p.x(c[0]), p.y(c[1])]);
    }
    return pts;
  }

  /* ---- offline guidance maths (pure, on-device; no network) ---- */

  var navWatch = null; // geolocation watch id while a shelter sheet is open

  function bearingDeg(a, b) {
    const rad = Math.PI / 180;
    const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
    const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad)
      - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }
  function compassWord(deg) {
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
  }
  function fmtDistM(m) { return m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m"; }

  /** nearest point on a [lon,lat] polyline to pt: {m: distance, idx: segment index, at: {lat,lon}, alongM: metres from line start} */
  function snapToPolyline(pt, coords) {
    const pts = (coords || []).filter((c) => Array.isArray(c) && c.length >= 2);
    if (!pts.length) return null;
    const rad = Math.PI / 180, kx = Math.cos(pt.lat * rad) * 111320, ky = 110540;
    const px = (c) => (c[0] - pt.lon) * kx, py = (c) => (c[1] - pt.lat) * ky;
    let best = null, cum = 0;
    if (pts.length === 1) return { m: Math.hypot(px(pts[0]), py(pts[0])), idx: 0, at: { lat: pts[0][1], lon: pts[0][0] }, alongM: 0 };
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = px(pts[i]), ay = py(pts[i]), bx = px(pts[i + 1]), by = py(pts[i + 1]);
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy, segLen = Math.sqrt(len2);
      const tt = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const d = Math.hypot(ax + tt * dx, ay + tt * dy);
      if (!best || d < best.m) {
        best = { m: d, idx: i, at: { lat: pts[i][1] + tt * (pts[i + 1][1] - pts[i][1]), lon: pts[i][0] + tt * (pts[i + 1][0] - pts[i][0]) }, alongM: cum + tt * segLen };
      }
      cum += segLen;
    }
    best.totalM = cum;
    return best;
  }

  /** defensive collector: road_blocked / bridge_out markers from any layer that may exist. */
  var HAZARD_KIND_RE = /^(road_blocked|bridge_out)$/;
  function hazardMarkersAll() {
    const out = [];
    const add = (o, kind) => {
      if (o && typeof o.lat === "number" && typeof o.lon === "number") out.push({ lat: o.lat, lon: o.lon, kind, label: o.label || o.name || "", ts: typeof o.ts === "number" ? o.ts : null, confidence: typeof o.confidence === "number" ? o.confidence : null });
    };
    try {
      const hm = state.hazardMarkers;
      (Array.isArray(hm) ? hm : (hm && Array.isArray(hm.markers) ? hm.markers : [])).forEach((o) => {
        const k = o && (o.routeKind || o.kind || o.type); // routeKind: vision.js maps flood/blocked/landslide/... -> road_blocked, bridge -> bridge_out
        if (HAZARD_KIND_RE.test(String(k))) add(o, k);
      });
      const mesh = cached("mesh");
      const ms = mesh && mesh.data;
      (ms && ms.hazardReports || []).forEach((hr) => {
        const k = (hr && (hr.kind || (hr.photoVision && (hr.photoVision.kind || hr.photoVision.type)))) || "";
        if (HAZARD_KIND_RE.test(String(k))) add(hr, k);
      });
      const mp = cached("mapState");
      ((mp && mp.data && mp.data.roads) || []).forEach((rd) => {
        if (rd && rd.status === "blocked" && rd.confidence >= 0.5) add(rd, "road_blocked");
      });
    } catch (e) { /* layers are optional */ }
    return out;
  }

  /** markers within maxM (default 60 m) of the route polyline, nearest first. */
  function routeHazardsNear(route, markers, maxM) {
    const lim = maxM == null ? 60 : maxM;
    const coords = route && route.geometry && route.geometry.coordinates;
    if (!Array.isArray(coords)) return [];
    const hits = [];
    for (const mk of markers || []) {
      const s = snapToPolyline(mk, coords);
      if (s && s.m <= lim) hits.push({ kind: mk.kind, label: mk.label, offM: Math.round(s.m), alongM: Math.round(s.alongM) });
    }
    return hits.sort((a, b) => a.offM - b.offM);
  }

  /** live guidance card: route progress when a cached route exists, else straight-line bearing + GPS distance. */
  function navLiveHtml(me, res, route) {
    const direct = haversineKm(me, res) * 1000;
    let target = res, lead = "";
    const coords = route && route.geometry && route.geometry.coordinates;
    const s = coords ? snapToPolyline(me, coords) : null;
    if (s && s.m <= 150) {
      lead = `On the cached route · ${fmtDistM(Math.max(0, (s.totalM || 0) - s.alongM))} to go`;
    } else if (s) {
      target = s.at;
      lead = `${fmtDistM(s.m)} off the cached route — head ${compassWord(bearingDeg(me, s.at))} to rejoin it`;
    } else {
      lead = "No cached route for your start point — straight-line guide";
    }
    const brg = bearingDeg(me, target);
    const brgRes = bearingDeg(me, res);
    return `<div class="nav-compass" role="status" aria-live="polite">
        <svg class="nav-arrow" viewBox="0 0 24 24" width="40" height="40" aria-hidden="true" style="transform:rotate(${Math.round(brg)}deg)"><path d="M12 2l6 18-6-4-6 4z" fill="currentColor"/></svg>
        <div><b>${esc(fmtDistM(direct))}</b> straight to ${esc(res.name.split(" ")[0])} · ${esc(compassWord(brgRes))} ${Math.round(brgRes)}&deg;
        <p class="mini dim">${esc(lead)} · arrow is relative to north</p></div>
      </div>`;
  }

  function hazardWarnHtml(hits) {
    if (!hits || !hits.length) return "";
    const lines = hits.map((h) => `${h.kind === "bridge_out" ? "Bridge out" : "Road blocked"}${h.label ? " (" + esc(h.label) + ")" : ""} — ${h.offM} m from the route, about ${fmtDistM(h.alongM)} along it`).join("<br>");
    return `<div class="route-warn" role="alert"><span class="chip chip-danger">route flagged</span> <span class="mini">${lines}. Consider another shelter or go around on foot with care.</span></div>`;
  }

  /** steps list html for the sheet ("From you: 240 m — Yesler Way / …"). */
  function routeStepsHtml(route, res) {
    const km = route.distanceKm != null ? Number(route.distanceKm) : null;
    const min = route.durationMin != null ? Number(route.durationMin) : null;
    const head = (km != null || min != null)
      ? `<button class="chip chip-n route-toggle" id="stepsToggle" aria-expanded="false">${ICONS.sync} Route to ${esc(res.name.split(" ")[0])}${km != null ? " · " + esc(km.toFixed(2)) + " km" : ""}${min != null ? " · ~" + esc(String(Math.round(min))) + " min " + (route.profile === "driving" ? "drive" : "walk") : ""}</button>`
      : `<button class="chip chip-n route-toggle" id="stepsToggle" aria-expanded="false">${ICONS.sync} Route steps</button>`;
    const rows = (route.steps || []).map((s, i) => {
      const m = s && s.distanceM != null ? Number(s.distanceM) : null;
      const distLine = m != null ? (m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m") : "";
      return `<div class="step-row"><span class="n">${i + 1}</span><span class="t">${distLine ? "<b>" + esc(distLine) + "</b> — " : ""}${esc((s && s.text) || "")}</span></div>`;
    }).join("") || '<p class="mini dim">No turn-by-turn steps in this route pack.</p>';
    const when = fmtFetchedAt(route != null && route.fetchedAt != null ? route.fetchedAt : (route && state.routes && state.routes.at));
    const cachedBadge = `<span class="chip chip-n route-cached">route cached${when ? " at " + esc(when) : " on this phone"}</span>`;
    const live = (route && route.source === "fixture" ? `<span class="chip chip-warn">prepared route</span> ` : "") + cachedBadge + " carried by the mesh · works offline";
    const hits = routeHazardsNear(route, hazardMarkersAll());
    return `${hazardWarnHtml(hits)}${head}
      <div class="route-card" id="stepsList" hidden>
        ${hits.length ? '<p class="mini warn-step">Warning: a reported blocked road / bridge lies on this route — see the flag above.</p>' : ""}
        ${rows}
        <p class="mini dim" style="margin-top:8px">${live}</p>
      </div>`;
  }

  /* ---- brand pins: 44px white circle + dark kind glyph + status chip ---- */
  function drawPin(res, X, Y, t) {
    const sel = routeTo === res;
    const R = 22;
    if (sel) {
      ctx.beginPath();
      ctx.arc(X, Y, R + 7, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(249,115,22,0.2)";
      ctx.fill();
    }
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 9;
    ctx.shadowOffsetY = 3;
    ctx.beginPath();
    ctx.arc(X, Y, R, 0, Math.PI * 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
    ctx.restore();
    if (res.partner) {
      ctx.beginPath();
      ctx.arc(X, Y, R + 3, 0, Math.PI * 2);
      ctx.strokeStyle = "#F97316";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    drawKindGlyph(res.kind, X, Y, R);
    pinStatusChip(X, Y + R + 6, res);
  }

  /* small dark inline glyph shapes — house-people / pharmacy cross / flag */
  function drawKindGlyph(kind, X, Y, R) {
    ctx.save();
    ctx.strokeStyle = "#111114";
    ctx.fillStyle = "#111114";
    ctx.lineWidth = 1.9;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (kind === "pharmacy") {
      const a = 4.6;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(X, Y - a); ctx.lineTo(X, Y + a);
      ctx.moveTo(X - a, Y); ctx.lineTo(X + a, Y);
      ctx.stroke();
    } else if (kind === "community_center") {
      ctx.beginPath();
      ctx.moveTo(X - 2, Y - 7); ctx.lineTo(X - 2, Y + 7);
      ctx.moveTo(X - 2, Y - 7); ctx.lineTo(X + 6, Y - 4.6); ctx.lineTo(X - 2, Y - 2.2);
      ctx.stroke();
    } else {
      // shelter: house + two resident dots
      ctx.strokeRect(X - 5.4, Y - 1.4, 10.8, 7.6);
      ctx.beginPath();
      ctx.moveTo(X - 6.6, Y - 1.4); ctx.lineTo(X, Y - 7); ctx.lineTo(X + 6.6, Y - 1.4);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(X - 2.4, Y + 1.6, 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(X + 2.4, Y + 1.6, 1.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /* status chip under the pin: dark pill + dot + "open · 0.73" */
  function pinStatusChip(X, Y, res) {
    const conf = Math.round((res.confidence || 0) * 100) / 100;
    const label = (res.status || "unknown") + " · " + conf.toFixed(2);
    let dot;
    if (res.status === "open" && (res.confidence || 0) >= 0.5) dot = "#42CE93";
    else if (res.status === "closed") dot = "#FF6B5E";
    else if (res.status === "full") dot = "#F0A34E";
    else dot = "#9CA3AF";
    ctx.save();
    ctx.font = "600 10.5px ui-monospace, monospace";
    const tw = ctx.measureText(label).width;
    const bw = tw + 26, bh = 17;
    ctx.beginPath();
    roundedRect(X - bw / 2, Y, bw, bh, 8.5);
    ctx.fillStyle = "rgba(13,13,15,0.93)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(X - bw / 2 + 10, Y + bh / 2, 3, 0, Math.PI * 2);
    ctx.fillStyle = dot;
    ctx.fill();
    ctx.fillStyle = "#E5E7EB";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, X - bw / 2 + 16, Y + bh / 2 + 0.5);
    ctx.restore();
  }

  /* photo pipeline: the mesh photo marker — a 16px thumbnail rendered right from
   * the photo's bytes (the /mesh/photo GET is open + immutable-cache); until the
   * image finishes loading (or on error) a camera-glyph placeholder keeps the
   * marker + its tap target present. photoPinCache drives the tap lightbox. */
  function drawPhotoMarker(hr, X, Y) {
    photoPinCache.push({ x: X, y: Y, hr });
    const S = 16, HALF = S / 2, LIFT = 18; // floats above the score bubble like a beacon chip
    let img = photoImgCache.get(hr.photoUrl);
    if (!img && !photoImgFailed.has(hr.photoUrl)) {
      img = new Image();
      img.__ok = false;
      img.onload = () => {
        img.__ok = true;
        if (screens.map && screens.map.classList.contains("active")) drawMap(); // first frame after load — no recursion (the src is already cached)
      };
      // a 404/absent photo tombstones the ref — no per-frame re-fetch loop
      img.onerror = () => { photoImgFailed.add(hr.photoUrl); photoImgCache.delete(hr.photoUrl); };
      img.src = apiBase() + hr.photoUrl;
      photoImgCache.set(hr.photoUrl, img);
    }
    if (img && !img.__ok) img = null; // still loading (or failed) -> the placeholder renders
    ctx.save();
    ctx.beginPath();
    roundedRect(X - HALF - 1.5, Y - LIFT - HALF - 1.5, S + 3, S + 3, 4);
    ctx.fillStyle = "rgba(13,13,15,0.93)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    ctx.stroke();
    if (img.__ok) {
      ctx.drawImage(img, X - HALF, Y - LIFT - HALF, S, S);
    } else {
      // placeholder: camera dot + lens
      ctx.strokeStyle = "rgba(219,228,240,0.85)";
      ctx.fillStyle = "rgba(219,228,240,0.85)";
      ctx.lineWidth = 1.2;
      ctx.strokeRect(X - 4, Y - LIFT - 3.5, 8, 6.5);
      ctx.beginPath();
      ctx.arc(X, Y - LIFT - 0.25, 1.6, 0, Math.PI * 2);
      ctx.stroke();
    }
    // verified badge: a green dot when the AI vision verdict confirmed the claim
    if (hr.photoVision && hr.photoVision.verdict === "confirmed") {
      ctx.beginPath();
      ctx.arc(X + HALF, Y - LIFT - HALF, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(66,206,147,0.98)";
      ctx.fill();
      ctx.strokeStyle = "rgba(13,13,15,0.9)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  function hitPhotoPin(X, Y) {
    let best = null, bestD = 16;
    for (const pc of photoPinCache) {
      // the marker floats LIFT=18px above the report's anchor point
      const d = Math.hypot(pc.x - X, pc.y - 18 - Y);
      if (d < bestD) { best = pc; bestD = d; }
    }
    return best;
  }

  /** click-expanded lightbox: the full photo + its score/reason story (the same sheet machinery as the pin sheet). */
  function openPhotoSheet(hr) {
    const conf = hr.score == null ? "–" : String(hr.score);
    const v = hr.photoVision;
    const vChip = v
      ? `<span class="chip ${v.verdict === "confirmed" ? "chip-ok" : v.verdict === "rejected" ? "chip-warn" : "chip-n"}">AI ${esc(v.verdict)}${v.detail ? " · " + esc(v.detail) : ""}</span>`
      : "";

    openSheet(`
      <div style="text-align:center">
        <img class="lightbox-img" src="${esc(apiBase() + hr.photoUrl)}" alt="mesh report photo">
        <div class="chips" style="justify-content:center;margin-top:12px">
          ${hr.photoKind ? `<span class="chip chip-mono chip-mesh">${esc(hr.photoKind)}</span>` : ""}
          <span class="chip chip-n chip-mono">score ${esc(conf)}</span>
          ${vChip}
        </div>
        ${hr.reasons && hr.reasons.length
          ? `<div style="margin-top:10px;text-align:left">${hr.reasons.map((r) => `<div class="mini mono dim">· ${esc(r)}</div>`).join("")}</div>`
          : ""}
        <p class="mini dim" style="margin-top:10px">Photo relayed over the mesh — the AI photo-verdict rides its score reasons.</p>
      </div>`, null, "sheet-detail");
  }

  function beaconChip(X, Y, label, dot) {
    ctx.save();
    ctx.font = "700 10px ui-monospace, monospace";
    const bw = ctx.measureText(label).width + 18, bh = 16;
    ctx.beginPath();
    roundedRect(X, Y, bw, bh, 8);
    ctx.fillStyle = "rgba(13,13,15,0.93)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(X + 9, Y + bh / 2, 3, 0, Math.PI * 2);
    ctx.fillStyle = dot;
    ctx.fill();
    ctx.fillStyle = "#E5E7EB";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, X + 15, Y + bh / 2 + 0.5);
    ctx.restore();
  }

  function roundedRect(x, y, w, hgt, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + hgt, r);
    ctx.arcTo(x + w, y + hgt, x, y + hgt, r);
    ctx.arcTo(x, y + hgt, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fitAll() {
    const loc = myLoc();
    const b = collectFeatures();
    if (!b) { view.cx = loc.lon; view.cy = loc.lat; view.zoom = 1.4; return; }
    view.cx = (b.minLon + b.maxLon) / 2 || loc.lon;
    view.cy = (b.minLat + b.maxLat) / 2 || loc.lat;
    const cos0 = Math.cos((view.cy * Math.PI) / 180) || 0.66;
    const spanLatKm = Math.max(b.maxLat - b.minLat, 0.02) * 111 * 1.3;
    const spanLonKm = Math.max(b.maxLon - b.minLon, 0.02) * 111 * cos0 * 1.3;
    const zoom = 9 / Math.max(spanLatKm, spanLonKm);
    view.zoom = clamp(zoom, 0.35, 2.6); // cap keeps the render inside the packed tile scale
    view.cx = clamp(view.cx, BOUNDS.lon0, BOUNDS.lon1);
    view.cy = clamp(view.cy, BOUNDS.lat0, BOUNDS.lat1);
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

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

  /** Satellite plume polygons accept the hazard shape, raw rings, or a points array (honest render only). */
  function plumRings(pl) {
    if (pl && pl.geometry && pl.geometry.type === "Polygon") return geometryPolys(pl.geometry);
    if (pl && Array.isArray(pl.coordinates)) return geometryPolys({ type: "Polygon", coordinates: pl.coordinates });
    return [];
  }

  function geometryPolys(geom) {
    if (!geom) return [];
    if (geom.type === "Polygon") return (geom.coordinates || []).map((ring) => (ring || []).slice(0, 1));
    return [];
  }

  function gridBackdrop(w, hgt) {
    // subtle 24px dot grid — the intentional empty-state backdrop (never a torn edge)
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    const step = 24;
    for (let x = step; x < w; x += step) {
      for (let y = step; y < hgt; y += step) {
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawMapEmpty(w, hgt) {
    ctx.fillStyle = "rgba(245,245,245,0.6)";
    ctx.font = "600 14px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Map data hasn't synced yet", w / 2, hgt / 2 - 8);
    ctx.font = "400 12px system-ui";
    ctx.fillStyle = "rgba(156,163,175,1)";
    ctx.fillText(state.mode === "offline" ? "Get signal once — then Map keeps working offline." : "Connecting to the Skywatch API…", w / 2, hgt / 2 + 12);
  }

  function renderMapChips() {
    const chips = $("#mapChips");
    const mapData = cached("mapState");
    const mesh = cached("mesh");
    const sat = lsGet(LS.sat, null);
    const bits = [];
    if (mapData && !mapData.live) bits.push(`<span class="chip chip-mesh">cached · ${esc(fmtAgo(mapData.at))}</span>`);
    if (state.mode === "offline") bits.push(`<span class="chip chip-mesh">mesh sync needed</span>`);
    if (state.mode === "gateway") bits.push(`<span class="chip chip-ok">gateway · carrying the mesh</span>`);
    if (sat) bits.push(`<span class="chip chip-warn">Satellite data for your area · fetched ${esc(fmtFetchedAt(sat.fetchedAt))}</span>${sat.aqi != null ? `<span class="chip chip-n chip-mono">AQI ${esc(String(sat.aqi))}</span>` : ""}`);
    if (mesh && mesh.data && mesh.data.counts) bits.push(`<span class="chip chip-n chip-mono">${esc(String(mesh.data.counts.packets))} mesh packets</span>`);
    if (mapData && mapData.data && (mapData.data.hazards || []).length) bits.push(`<span class="chip chip-warn">${esc(String((mapData.data.hazards || []).length))} hazards</span>`);
    chips.innerHTML = bits.join("");
  }

  /* map gestures: pan + pinch (tiles and pins both redraw) */
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
      view.zoom = clamp(pinchStart.zoom * (d / pinchStart.dist), 0.35, 2.8);
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
    view.zoom = clamp(view.zoom * (e.deltaY < 0 ? 1.12 : 0.89), 0.35, 2.8);
    drawMap();
  }, { passive: false });

  canvas.addEventListener("click", (e) => {
    if (dragDist > 9) return; // a drag, not a tap
    if (!$("#sheet").hidden) closeSheet(); // a tap on the map closes an open pin sheet
    const r = canvas.getBoundingClientRect();
    const X = e.clientX - r.left, Y = e.clientY - r.top;
    // photo pipeline: a tap on a photo marker opens its lightbox (score + reasons + full image)
    const photo = hitPhotoPin(X, Y);
    if (photo) { haptic(6); openPhotoSheet(photo.hr); return; }
    const vzMark = window.SkyVision && window.SkyVision.hitMarker(X, Y);
    if (vzMark) { haptic(6); window.SkyVision.openMarkerSheet(vzMark); return; }
    openPinSheet(X, Y);
  });

  $("#mapZoomIn").addEventListener("click", () => { view.zoom = clamp(view.zoom * 1.35, 0.35, 2.8); drawMap(); });
  $("#mapZoomOut").addEventListener("click", () => { view.zoom = clamp(view.zoom / 1.35, 0.35, 2.8); drawMap(); });
  $("#mapRecenter").addEventListener("click", () => { fitAll(); drawMap(); });

  /* directions are fully offline: the carried route (or an on-device compass
   * fallback) in the pin sheet — the app never hands off to an external maps app */
  function stopNavWatch() {
    if (navWatch != null && navigator.geolocation) { try { navigator.geolocation.clearWatch(navWatch); } catch (e) { /* ignore */ } }
    navWatch = null;
  }

  function openPinSheet(X, Y) {
    let best = null, bestD = 34;
    for (const pc of pinCache) {
      const d = Math.hypot(pc.x - X, pc.y - Y);
      if (d < bestD) { best = pc; bestD = d; }
    }
    if (!best) return;
    const r = best.res;
    routeTo = r;
    reframeToPin(r); // pull the route + pin into the strip above the sheet card
    drawMap();
    const conf = Math.round((r.confidence || 0) * 100);
    const dist = haversineKm(myLoc(), r);
    const verified = r.status === "open" && conf >= 50;
    const carried = routeForResource(r);
    openSheet(`
      <div class="pin-head">
        <span class="pin-glyph${r.partner ? " partner" : ""}">${kindGlyphSvg(r.kind)}</span>
        <div style="flex:1;min-width:0">
          <h3>${esc(r.name)}</h3>
          <p class="pin-meta">${esc(dist.toFixed(2))} km from you</p>
        </div>
      </div>
      <div class="chips" style="margin:12px 0 0">
        <span class="chip ${verified ? "chip-ok" : r.status === "closed" ? "chip-danger" : r.status === "full" ? "chip-warn" : "chip-n"}">${esc(r.status.toUpperCase())}</span>
        <span class="chip chip-n">${verified ? "verified just now · " : ""}confidence ${conf}%</span>
        ${r.partner ? '<span class="chip chip-warn">partner</span>' : ""}
        <span class="chip chip-n chip-mono">${esc(r.kind)}</span>
      </div>
      ${r.hours ? `<p class="pin-hours">${esc(r.hours)}</p>` : `<p class="pin-hours dim">No posted hours — the status above is the freshest check-in.</p>`}
      ${verified ? "" : '<p class="route-unverified" role="note"><b>Shelter not verified — confirm before going.</b> The status above is the freshest check-in, not a promise it is open.</p>'}
      ${window.SkyNav ? `<button class="btn btn-primary btn-block nav-start" id="navStart" type="button">Start navigation${carried ? "" : " (straight-line guide)"}</button>` : ""}
      ${carried ? routeStepsHtml(carried, r) : ""}
      <div id="navLive" style="margin-top:14px">${navLiveHtml(myLoc(), r, carried)}</div>
      <p class="mini dim2" style="margin-top:10px;text-align:center">${carried ? "The orange line is the cached route — followable offline, no signal needed." : "No cached route for this start point — the orange line is a straight-line guide; the compass above updates with your GPS."}</p>
    `, (sheet) => {
      stopNavWatch();
      if (navigator.geolocation && navigator.geolocation.watchPosition) {
        try {
          navWatch = navigator.geolocation.watchPosition((pos) => {
            const box = $("#navLive", sheet);
            if (!box || sheet.hidden) { stopNavWatch(); return; }
            const me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
            box.innerHTML = navLiveHtml(me, r, carried);
          }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
        } catch (e) { /* GPS optional — the sheet keeps the last known fix */ }
      }
      const startBtn = $("#navStart", sheet);
      if (startBtn) startBtn.addEventListener("click", () => {
        haptic(8);
        closeSheet(); // stops the sheet's GPS watch; nav owns GPS from here
        window.SkyNav.start({ res: r, route: carried });
      });
      const toggle = $("#stepsToggle", sheet), list = $("#stepsList", sheet);
      if (toggle && list) toggle.addEventListener("click", () => {
        haptic(5);
        list.hidden = !list.hidden;
        toggle.setAttribute("aria-expanded", String(!list.hidden));
        if (!list.hidden) {
          list.classList.remove("route-open"); void list.offsetWidth; list.classList.add("route-open");
          list.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "nearest" });
        }
      });
    }, "sheet-detail");
  }

  function haversineKm(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /* frame me + the selected pin in the visible strip above the sheet card */
  function reframeToPin(pin) {
    const me = myLoc();
    const cos0 = Math.cos((me.lat * Math.PI) / 180) || 0.66;
    const spanLat = Math.max(Math.abs(pin.lat - me.lat), 0.008) * 1.9; // ~pad for pins + route bow
    const spanLon = Math.max(Math.abs(pin.lon - me.lon), 0.008) * cos0 * 2.0;
    view.zoom = clamp((9 * 0.52) / Math.max(spanLat, spanLon) * 111, 0.35, 2.8); // 0.52 ≈ the strip the card leaves
    view.cx = clamp((me.lon + pin.lon) / 2, BOUNDS.lon0, BOUNDS.lon1);
    const midLat = (me.lat + pin.lat) / 2;
    // the visible strip's centre sits ~27% of the canvas above centre — shift the
    // view centre south by that much so me + pin render inside it
    view.cy = clamp(midLat - (0.27 * (9 / view.zoom)) / 111, BOUNDS.lat0, BOUNDS.lat1);
  }

  /** inline SVG for the sheet's pin glyph (same three kinds as the map) */
  function kindGlyphSvg(kind) {
    const a = 'viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';
    if (kind === "pharmacy") return `<svg ${a}><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg>`;
    if (kind === "community_center") return `<svg ${a}><path d="M6 21V4"/><path d="M6 4h11l-2.6 3.4L17 11H6"/></svg>`;
    return `<svg ${a}><path d="M4 11.5 12 4.5l8 7"/><path d="M6.2 9.8V20h11.6V9.8"/><circle cx="10" cy="14.6" r="1.5"/><circle cx="14.6" cy="16.4" r="1.5"/></svg>`;
  }

  function drawMapLoop() {
    requestAnimationFrame(() => {
      if (screens.map.classList.contains("active") && !(window.SkyNav && window.SkyNav.active)) drawMap(); // nav mode draws its own canvas
      drawMapLoop();
    });
  }

  function DPR() { return Math.max(1, window.devicePixelRatio || 1); }
  /* =========================================================================
   * MESH tab rendering — three surfaces: NEIGHBORS / DIRECTS / SKYWATCH
   * =======================================================================*/

  // Core (trusted Skywatch) replies are flagged server-side as m.core; never inferred from the hashed sender.

  function fmtFetchedAt(v) {
    const d = v == null ? null : new Date(typeof v === "number" ? v : String(v));
    return d && !isNaN(d.getTime()) ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  }

  /** One dedup'd message feed from GET /mesh/state + the downlink bundle. */
  function meshFeed() {
    const seen = new Set();
    const out = [];
    const meHash = state.identity && state.identity.hash, meRaw = state.identity && state.identity.deviceId;
    const add = (from, to, text, ts, photoRef, label, hazard, core) => {
      from = String(from || "");
      // our own sender hash (and DMs addressed to it) map back to the device id the UI compares against
      if (meHash && from === meHash) from = meRaw;
      if (meHash && to === meHash) to = meRaw;
      if (!from || (text == null && !photoRef && !hazard)) return;
      const key = from + "|" + (to || "") + "|" + String(text) + "|" + String(ts);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ from, to: to || null, text: String(text || ""), ts: +ts || 0, photoRef: photoRef || null, label: String(label || ""), hazard: hazard || null, core: core === true });
    };
    const mesh = cached("mesh");
    ((mesh && mesh.data && mesh.data.messages) || []).forEach((m) => add(m.from, m.to, m.text, m.ts, m.photoRef, m.label, m.hazard, m.core));
    ((state.bundle && state.bundle.messages) || []).forEach((m) => add(m.from, m.to, m.text, m.ts, m.photoRef, m.label, m.hazard, m.core));
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  function pendingPhotos() { return lsGet(LS.photos, {}); }
  function b64Only(d) { d = String(d || ""); return d.indexOf(",") >= 0 ? d.slice(d.indexOf(",") + 1) : d; }
  function photoSrc(ref) {
    const pending = pendingPhotos();
    if (pending[ref] && pending[ref].data) return pending[ref].data; // still local — renders before/without the upload
    return apiBase() + "/mesh/photo/" + encodeURIComponent(ref); // 8e endpoint — 404s hide gracefully
  }
  function photoThumb(ref) {
    return `<img class="msg-thumb" src="${esc(photoSrc(ref))}" alt="photo" loading="lazy" onerror="this.remove()">`;
  }

  /** Client-side photo cap: ≤1024px, JPEG, and it keeps re-encoding down toward ≤150 KB. */
  async function makePhotoJPEG(file) {
    const img = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("unreadable image")); };
      im.src = url;
    });
    const MAX = 1024, QUOTA = 150 * 1024;
    let scale = Math.min(1, MAX / Math.max(img.naturalWidth || MAX, img.naturalHeight || MAX));
    let q = 0.85;
    let out = "";
    for (let tries = 0; tries < 7; tries++) {
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round((img.naturalWidth || MAX) * scale));
      cv.height = Math.max(1, Math.round((img.naturalHeight || MAX) * scale));
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      out = cv.toDataURL("image/jpeg", q);
      const bytes = Math.round((out.length - 23) * 3 / 4); // dataURL's b64 payload
      if (bytes <= QUOTA) break;
      scale *= 0.85;
      q = Math.max(0.6, q - 0.05);
    }
    return out;
  }

  async function attachPhoto(file) {
    const ta = $("#meshText", screens.mesh);
    const draft = ta ? ta.value : "";
    try {
      const data = await makePhotoJPEG(file);
      state.composerPhoto = {
        ref: "ph-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        data,
        kb: Math.round(((data.length - 23) * 3 / 4) / 1024),
      };
    } catch (_e) {
      toast("Couldn't read that image — try another.", "warn");
      return;
    }
    haptic(8);
    if (window.SkyVision) window.SkyVision.analyze(state.composerPhoto); // on-device damage check -> confirm sheet (vision.js)
    renderMesh(); // refresh the preview chip, keep the half-typed draft
    const ta2 = $("#meshText", screens.mesh);
    if (ta2) { ta2.value = draft; $("#meshCount", screens.mesh).textContent = String(280 - draft.length); ta2.dispatchEvent(new Event("input")); ta2.focus(); }
  }

  /* ---- Messages-style threads: bubbles, runs, stamps, status, hazard cards ---- */
  const bubbleSeen = new Set(); // keys already animated in — polls re-render, only NEW bubbles spring
  const ICON_HAZARD = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 10v4.4M12 17.2v.1"/></svg>';
  const ICON_ARROW_UP = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>';
  const ICON_CHEV_LEFT = '<svg viewBox="0 0 24 24" width="14" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4.5 7.5 12 15 19.5"/></svg>';

  function fmtStamp(ts) {
    const d = new Date(ts);
    if (isNaN(d)) return "";
    const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day0(new Date()) - day0(d)) / 86400000);
    if (diff <= 0) return "Today " + t;
    if (diff === 1) return "Yesterday " + t;
    if (diff < 7) return d.toLocaleDateString([], { weekday: "long" }) + " " + t;
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + t;
  }

  function hazardCardHtml(h) {
    const lat = Number(h.lat), lon = Number(h.lon);
    const ok = isFinite(lat) && isFinite(lon);
    const c = Number(h.confidence);
    const pct = isFinite(c) ? Math.round(c <= 1 ? c * 100 : c) : null;
    const title = h.label || String(h.kind || "Hazard").replace(/_/g, " ");
    return `<div class="hazard-card">
      <div class="hazard-ic">${ICON_HAZARD}</div>
      <div class="hazard-body">
        <b class="hazard-title">${esc(title)}</b>
        ${ok ? `<span class="hazard-loc">${esc(lat.toFixed(4))}, ${esc(lon.toFixed(4))}</span>` : ""}
        ${pct != null ? `<span class="chip chip-warn hazard-conf">${esc(String(pct))}% confidence</span>` : ""}
      </div>
      ${ok ? `<button class="hazard-go" data-hazard-lat="${esc(String(lat))}" data-hazard-lon="${esc(String(lon))}">Show on map</button>` : ""}
    </div>`;
  }

  /** o: { group: show sender labels, first, last: run position, status: text under the bubble } */
  function bubbleHtml(m, meId, withReply, o) {
    o = o || { first: true, last: true };
    const core = m.core === true;
    const mine = m.from === meId || m.mine === true;
    const photoOnly = !!m.photoRef && (!m.text || m.text === "photo");
    const key = [m.from, m.to || "", m.text].join("|"); // no ts: the server echo of a sent message must not re-animate it
    const fresh = !bubbleSeen.has(key);
    bubbleSeen.add(key);
    const cls = [
      core ? "core" : mine ? "me" : "",
      o.first ? "first" : "run",
      o.last && !photoOnly ? "tail" : "",
      photoOnly ? "photo" : "",
      m.queued ? "pending" : "",
      fresh ? "enter" : "",
    ].filter(Boolean).join(" ");
    const label = o.group && o.first && !mine
      ? `<div class="bubble-from">${core ? `${ICONS.shieldS} Skywatch` : esc(String(m.from))}</div>` : "";
    const thumb = m.photoRef ? photoThumb(m.photoRef) : "";
    const body = photoOnly || (m.hazard && !m.text) ? "" :`<span class="btxt">${esc(m.text)}</span>`;
    const bubble = (body || thumb) ? `<div class="bubble ${cls}">${body}${thumb}</div>` : "";
    const hazard = m.hazard ? `<div class="bubble-attach ${mine ? "me" : ""}">${hazardCardHtml(m.hazard)}</div>` : "";
    const reply = withReply && o.last && !mine && !core && !m.to ? `<button class="reply-btn msg-reply" data-reply="${esc(m.from)}">↩ reply</button>` : "";
    const status = o.status ? `<div class="msg-status">${esc(o.status)}</div>` : "";
    return label + bubble + hazard + status + reply;
  }

  /** a whole thread: centered time stamps, tight runs, status under the last outgoing bubble */
  function threadHtml(arr, meId, opts) {
    const group = !!opts.group;
    const isMine = (m) => m.from === meId || m.mine === true;
    const senderOf = (m) => (m.core === true ? "core" : isMine(m) ? "me" : String(m.from));
    let lastOut = -1;
    arr.forEach((m, i) => { if (isMine(m)) lastOut = i; });
    let out = "";
    arr.forEach((m, i) => {
      const prev = arr[i - 1], next = arr[i + 1];
      const gap = (a, b) => Math.abs((+b.ts || 0) - (+a.ts || 0)) > 15 * 60 * 1000;
      const stamp = !prev || gap(prev, m);
      if (stamp) out += `<div class="msg-stamp">${esc(fmtStamp(m.ts))}</div>`;
      const first = stamp || senderOf(prev) !== senderOf(m);
      const last = !next || gap(m, next) || senderOf(next) !== senderOf(m);
      let status = "";
      if (i === lastOut) {
        status = m.queued ? "Sending…"
          : (opts.view === "skywatch" && state.mode === "online") ? "Delivered"
            : state.mode === "online" && !m.relayed ? "Delivered" : "Relayed via mesh";
      }
      out += bubbleHtml(m, meId, opts.reply, { group, first, last, status });
    });
    return out;
  }

  function focusMapOn(lat, lon) {
    switchTab("map");
    view.cx = clamp(lon, BOUNDS.lon0, BOUNDS.lon1);
    view.cy = clamp(lat, BOUNDS.lat0, BOUNDS.lat1);
    view.zoom = clamp(Math.max(view.zoom, 1.8), 0.35, 2.6);
    drawMap();
  }

  function renderMesh() {
    const el = screens.mesh;
    const meId = state.identity ? state.identity.deviceId : null;
    const view = state.meshView || "neighbors";
    const gateway = state.mode === "gateway";
    const prevTop = el.scrollTop;
    const wasAtBottom = el.scrollHeight - el.clientHeight - prevTop < 48;
    const feed = meshFeed();
    const sat = lsGet(LS.sat, null);
    const satChip = sat
      ? `<span class="chip chip-warn">Satellite data for your area · fetched ${esc(fmtFetchedAt(sat.fetchedAt))}</span>${sat.aqi != null ? `<span class="chip chip-n chip-mono">AQI ${esc(String(sat.aqi))}</span>` : ""}`
      : "";

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

    /* NEIGHBORS — the broadcast thread + my unsent broadcasts */
    const broadcasts = feed.filter((m) => !m.to && !m.core).slice(-14);
    /* neighbors unread badge — same design as the Directs badge (2 s poll lands
     * them without user action; being ON the Neighbors surface means seen) */
    const nbUnseen = view === "neighbors" ? 0 : (meId ? feed.filter((m) => !m.to && !m.core && m.ts > (state.nbSeenAt || 0)).length : 0);
    state.queue.filter((p) => p.kind === "msg" && !p.to && (
      p.state === "queued" || p.state === "fail" ||
      // just-synced: bridge the gap until /mesh/state echoes it back, so the bubble never vanishes and reappears
      (p.state === "sent" && Date.now() - (p.queuedAt || 0) < 120000 && !feed.some((m) => m.from === meId && !m.to && m.text === (p.text || "photo")))
    )).forEach((p) => {
      broadcasts.push({ from: meId, to: null, text: p.text || "photo", ts: p.ts || p.queuedAt, photoRef: p.photoRef || null, hazard: p.hazard || null, mine: true, queued: p.state !== "sent" });
    });
    const neighborsHtml = `
      <div class="msg-title">Neighbors</div>
      <div class="chatwrap" id="meshChat">${threadHtml(broadcasts, meId, { group: true, reply: true, view: "neighbors" }) || `<div class="empty">${ICONS.meshOn}<b>No mesh chatter yet</b><p>When you're dark, this is how people nearby share what they see.</p></div>`}</div>`;

    /* DIRECTS — per-peer threads (1:1), one tap from any neighbor message */
    const threads = {};
    feed.forEach((m) => {
      if (m.core === true || m.to === "SKYWATCH") return;
      const peer = m.to && m.to === meId ? m.from : m.from === meId ? m.to : null;
      if (!peer || peer === meId) return;
      (threads[peer] = threads[peer] || []).push(m);
    });
    state.queue.filter((p) => p.kind === "msg" && p.to && p.to !== "SKYWATCH").forEach((p) => {
      // leave room for the server echo — skip packets /mesh/state already carries
      if (p.state === "sent" && meId && feed.some((m) => m.from === meId && m.to === p.to && m.text === (p.text || "photo"))) return;
      (threads[p.to] = threads[p.to] || []).push({ from: meId, to: p.to, text: p.text || "photo", ts: p.ts || p.queuedAt, photoRef: p.photoRef || null, mine: true, queued: p.state !== "sent" });
    });
    Object.values(threads).forEach((arr) => arr.sort((a, b) => a.ts - b.ts));
    const dmArr = (state.dmPeer && threads[state.dmPeer]) || [];
    /* DIRECTS badge: received DMs (to === my hash) not seen yet — mesh state poll
     * (every 2 s online/gateway) lands them without any user action */
    const dmUnseen = view === "directs" ? 0 : (meId ? feed.filter((m) => m.to === meId && !m.core && m.ts > (state.dmSeenAt || 0)).length : 0);
    const peerNew = (arr) => arr.some((m) => m.to === meId && !m.core && m.ts > (state.dmSeenAt || 0));
    const directsHtml = state.dmPeer
      ? `<div class="msg-head">
            <button class="msg-back" data-dm-back aria-label="All threads">${ICON_CHEV_LEFT}<span>Threads</span></button>
            <div class="msg-avatar" aria-hidden="true">${esc(String(state.dmPeer).replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?")}</div>
            <div class="msg-title msg-title-dm chip-mono">${esc(state.dmPeer)}</div>
          </div>
          <div class="chatwrap">${threadHtml(dmArr, meId, { group: false, reply: false, view: "directs" }) || '<div class="empty">' + ICONS.sms + '<b>New direct thread</b><p>You and ' + esc(state.dmPeer) + ' — what you send here rides the mesh, relayed by a node with signal.</p></div>'}</div>`
      : `<div class="chips" style="margin-bottom:10px"><span class="chip chip-mesh">relayed by a node with signal</span></div>
          ${Object.keys(threads).length
            ? Object.entries(threads).sort((a, b) => b[1][b[1].length - 1].ts - a[1][a[1].length - 1].ts).map(([peer, arr]) => {
              const last = arr[arr.length - 1];
              return `<button class="mode-row" data-peer="${esc(peer)}">
                <div class="mode-ic ic-off">${ICONS.sms}</div>
                <div style="flex:1;min-width:0"><b class="chip-mono">${esc(peer)}</b><span class="sub">${esc(last.text.slice(0, 44))}${last.text.length > 44 ? "…" : ""}</span></div>
                ${peerNew(arr) ? '<span class="chip chip-ok">new</span>' : ""}
                <span class="mono dim">${esc(fmtAgo(last.ts))}</span>
              </button>`;
            }).join("")
            : `<div class="empty">${ICONS.sms}<b>No direct threads yet</b><p>Reply to a neighbor's message in NEIGHBORS — or send the first one once they post.</p></div>`}`;

    /* SKYWATCH — the Ask Skywatch surface, shield-branded and separate */
    const skyThread = feed
      .filter((m) => m.core === true || m.to === "SKYWATCH")
      .map((m) => Object.assign({}, m, { mine: m.to === "SKYWATCH" }));
    state.queue.filter((p) => p.kind === "msg" && p.to === "SKYWATCH").forEach((p) => {
      if (p.state === "sent" && meId && feed.some((m) => m.from === meId && m.to === "SKYWATCH" && m.text === (p.text || "photo"))) return;
      skyThread.push({ from: meId, to: "SKYWATCH", text: p.text || "photo", ts: p.ts || p.queuedAt, photoRef: p.photoRef || null, mine: true, queued: p.state !== "sent" });
    });
    skyThread.sort((a, b) => a.ts - b.ts);
    const skyHtml = `
      <div class="gw-banner" style="border-color:rgba(66,206,147,.35);background:var(--ok-dim)">
        <h3>${ICONS.shieldS} Ask Skywatch</h3>
        <p>facts from your area brief — no live model.</p>
        <div class="chips" style="margin-top:10px">${ASKS.map((p) => `<button class="prompt-chip chip chip-n" data-prompt="${esc(p)}">${esc(p)}</button>`).join("")}</div>
      </div>
      <div class="chatwrap">${threadHtml(skyThread, meId, { group: false, reply: false, view: "skywatch" }) || '<div class="empty">' + ICONS.meshOn + '<b>No asks yet</b><p>Pick a suggested question, or type your own.</p></div>'}</div>`;

    const queueHtml = (() => {
      const recent = state.queue.slice(-14).reverse();
      if (!recent.length) return "";
      return `<div class="sec-label">Your packets<small>signed with this device's key — reload gives you a new identity</small></div>
        ${recent.map(pktRowHtml).join("")}`;
    })();

    const counts = (cached("mesh") && cached("mesh").data && cached("mesh").data.counts)
      ? `<div class="chips" style="margin-top:12px">
          <span class="chip chip-n chip-mono">${esc(String(cached("mesh").data.counts.packets))} packets</span>
          <span class="chip chip-n chip-mono">${esc(String(cached("mesh").data.counts.beacons))} beacons</span>
          <span class="chip chip-n chip-mono">${esc(String(cached("mesh").data.counts.devices))} devices</span>
          <span class="chip chip-n chip-mono">${esc(String(cached("mesh").data.counts.acked))} acked</span>
        </div>`
      : "";

    /* photo gallery strip — refs from my packets + the feed's photoRef packets */
    const photoRefs = (() => {
      const refs = new Set();
      state.queue.forEach((p) => { if (p.photoRef) refs.add(p.photoRef); });
      feed.forEach((m) => { if (m.photoRef) refs.add(m.photoRef); });
      return Array.from(refs);
    })();
    const galleryHtml = photoRefs.length
      ? `<div class="sec-label">Photos<small>downlinked through the gateway — pending ones render from this device</small></div>
        <div class="gallery">${photoRefs.map((r) => photoThumb(r)).join("")}</div>`
      : "";

    const bundleHtml = state.bundle ? renderBundle(state.bundle, state.syncState) : "";

    const meshTabs = `<div class="mesh-tabs" role="tablist" aria-label="Mesh surfaces">
      <button class="mesh-tab" data-mview="neighbors" role="tab" aria-pressed="${view === "neighbors"}">${ICONS.meshOn} Neighbors${nbUnseen ? `<span class="tab-badge">${nbUnseen}</span>` : ""}</button>
      <button class="mesh-tab" data-mview="directs" role="tab" aria-pressed="${view === "directs"}">${ICONS.sms} Directs${dmUnseen ? `<span class="tab-badge">${dmUnseen}</span>` : ""}</button>
      <button class="mesh-tab sky" data-mview="skywatch" role="tab" aria-pressed="${view === "skywatch"}">${ICONS.shieldS} Skywatch</button>
    </div>`;

    const composerHtml = (() => {
      const target =
        view === "directs"
          ? state.dmPeer
            ? `<div class="chips"><span class="chip chip-mono chip-mesh">DM to ${esc(state.dmPeer)}</span></div>`
            : ""
          : view === "skywatch"
            ? `<div class="chips"><span class="chip chip-ok">${ICONS.shieldS} SKYWATCH</span><span class="chip chip-n">asks route to the core</span></div>`
            : `<div class="chips">${KINDS.map((k) => `<button class="kind-chip chip chip-n" data-kind="${esc(k.id)}" aria-pressed="false">${esc(k.label)}</button>`).join("<span></span>")}</div>`;
      const photo = state.composerPhoto
        ? `<div class="photo-wait">
            <img class="msg-thumb photo-wait-img" src="${esc(state.composerPhoto.data)}" alt="attached photo"><span class="mini dim">${state.composerPhoto.kb} KB · sends with the next sync</span><button class="chip chip-n" id="photoClear" aria-label="Remove photo">✕</button>
            <div class="chips" style="flex-basis:100%">
              ${PHOTO_LABELS.map((l) => `<button class="prompt-chip chip chip-n photo-label-chip" data-photo-label="${esc(l)}" aria-pressed="${String(state.composerPhoto.label === l)}">${esc(l)}</button>`).join("")}
              <span class="mini dim">label · optional</span>
            </div>
          </div>`
        : "";
      const ph = view === "neighbors" ? "What's happening around you?" : view === "directs" ? (state.dmPeer ? "Direct message — relayed by a node with signal." : "Pick a neighbor's thread above, or reply from NEIGHBORS.") : "Ask Skywatch — facts from your area brief.";
      const direct = view === "directs"
        ? `<p class="mini dim2" style="margin:0 2px">Delivered through the mesh's next node with signal — even while your status bar says No Service.</p>`
        : "";
      return `<div class="composer msg-composer" style="margin-top:14px">
        ${target}
        ${direct}
        ${photo}
        <div class="composer-row${state.composerPhoto ? " has-text" : ""}">
          <button class="cmp-plus" id="photoBtn" aria-label="Attach a photo"><span class="cmp-dot">${ICONS.cam}</span></button>
          <input type="file" id="photoInput" accept="image/*" hidden>
          <div class="cmp-pill">
            <textarea id="meshText" rows="1" maxlength="280" placeholder="${esc(ph)}" aria-label="mesh message"></textarea>
            <button class="send-btn" id="meshSend" aria-label="Send"><span class="send-dot">${ICON_ARROW_UP}</span></button>
          </div>
        </div>
        <div class="composer-foot">
          <span class="counter" id="meshCount">280</span>
          <span class="chips">
            <button class="chip chip-n" id="locChip" aria-label="Reporting location — tap to change">${ICONS.pinS} ${esc(myLoc().acc ? "device" + locAcc() : "demo preset")}</button>
            <span class="chip chip-mesh">signs with WebCrypto</span>
          </span>
        </div>
      </div>`;
    })();

    el.innerHTML = `
      <div class="sec-label" style="margin-top:2px">Mesh<small>${state.identNote || "the community layer — what keeps working with no bars"}</small></div>
      <button class="locbar" id="locBar" aria-label="Reporting location — tap to change">${ICONS.pin}<span style="flex:1;min-width:0"><b>Reporting from:</b> ${esc(myLoc().label)}<span class="mono dim">${esc(locAcc())}</span></span><span class="mini dim">tap to change</span></button>
      ${gwHtml}
      <div class="chips" style="margin-bottom:10px">
        <span class="chip ${state.identity && !state.identity.legacy ? "chip-ok" : "chip-warn"} chip-mono">${state.identity ? esc(state.identity.deviceId) : "identity pending"}</span>
        <span class="chip chip-n">Ed25519 TOFU</span>
        ${satChip}
      </div>
      ${meshTabs}
      ${view === "neighbors" ? neighborsHtml : view === "directs" ? directsHtml : skyHtml}
      ${composerHtml}
      <div id="meshQueue" style="margin-top:16px">${queueHtml}</div>
      ${counts}
      <div id="meshBundle" style="margin-top:16px">${bundleHtml}</div>
      ${galleryHtml}`;

    wireComposer(el);
    el.scrollTop = wasAtBottom ? el.scrollHeight : prevTop;
    el.querySelectorAll(".mesh-tab").forEach((b) => b.addEventListener("click", () => {
      haptic(6);
      state.meshView = b.dataset.mview;
      renderMesh();
    }));
    el.querySelectorAll("[data-reply]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      haptic(6);
      withMeshDraft(() => {
        state.dmPeer = b.dataset.reply; // DM compose prefilled with the sender's hash
        state.meshView = "directs";
        renderMesh();
      });
    }));
    el.querySelectorAll("[data-peer]").forEach((b) => b.addEventListener("click", () => {
      haptic(6);
      withMeshDraft(() => { state.dmPeer = b.dataset.peer; renderMesh(); });
    }));
    el.querySelectorAll("[data-hazard-lat]").forEach((b) => b.addEventListener("click", () => {
      haptic(8);
      focusMapOn(Number(b.dataset.hazardLat), Number(b.dataset.hazardLon));
    }));
    const dmBack = el.querySelector("[data-dm-back]");
    if (dmBack) dmBack.addEventListener("click", () => {
      haptic(5);
      withMeshDraft(() => { state.dmPeer = null; renderMesh(); }); // "← Threads" keeps the half-typed draft
    });
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
    if (view === "directs" && meId) {
      // opening/being in Directs marks every DM addressed to me as seen
      const newest = feed.filter((m) => m.to === meId && !m.core).reduce((mx, m) => Math.max(mx, +m.ts || 0), 0);
      if (newest > (state.dmSeenAt || 0)) state.dmSeenAt = newest;
    }
    if (view === "neighbors" && meId) {
      // being ON the Neighbors surface marks every broadcast as seen (badge clears)
      const newest = feed.filter((m) => !m.to && !m.core).reduce((mx, m) => Math.max(mx, +m.ts || 0), 0);
      if (newest > (state.nbSeenAt || 0)) state.nbSeenAt = newest;
    }
    renderMeshSigChip();
  }

  function pktRowHtml(p) {
    const queuedStyle = (p.state === "queued" || p.state === "fail") ? "pkt-queued" : "";
    return `<div class="pkt ${queuedStyle}">
      <div class="pkt-icon" style="${p.kind === "msg" ? "background:var(--accent-dim);color:var(--accent)" : ""}">${p.kind === "msg" ? ICONS.sms : KINDS.find((k) => k.id === p.status) ? ICONS.alert : ICONS.pin}</div>
      <div class="pkt-label">
        ${p.kind === "msg" ? esc(p.text || "") : esc(p.status || "")}
        <span class="sub">${esc(p.kind.toUpperCase())}${p.to ? (p.to === "SKYWATCH" ? " · to SKYWATCH" : " · DM") : ""} · ${p.photoRef ? "photo · " : ""}${esc(fmtAgo(Date.now() - p.queuedAt))} · signed at send</span>
      </div>
      ${p.state === "sent"
        ? '<span class="chip chip-ok">sent</span>'
        : p.state === "fail"
          ? '<span class="chip chip-warn">held — sig state</span>'
          : '<span class="chip chip-mesh">queued · will send when one of us gets signal</span>'}
    </div>`;
  }

  /** switching DM surfaces never loses the half-typed composer draft */
  function withMeshDraft(run) {
    const ta = $("#meshText", screens.mesh);
    const draft = ta ? ta.value : "";
    run();
    const ta2 = $("#meshText", screens.mesh);
    if (ta2 && draft) { ta2.value = draft; $("#meshCount", screens.mesh).textContent = String(280 - draft.length); ta2.dispatchEvent(new Event("input")); }
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
    const view = state.meshView || "neighbors";
    // a poll that arrived while typing was held back — apply it once the box is empty and unfocused
    ta.addEventListener("blur", () => {
      setTimeout(() => { if (state.meshDirty && !ta.value && document.activeElement !== ta && state.tab === "mesh") { state.meshDirty = false; renderMesh(); } }, 150);
    });
    ta.addEventListener("input", () => {
      $("#meshCount", el).textContent = String(280 - ta.value.length);
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
      const row = ta.closest(".composer-row");
      if (row) row.classList.toggle("has-text", !!ta.value.trim() || !!state.composerPhoto);
    });

    let pick = null;
    const kindChips = el.querySelectorAll(".kind-chip");
    kindChips.forEach((chip) => {
      chip.addEventListener("click", () => {
        haptic(5);
        pick = pick === chip.dataset.kind ? null : chip.dataset.kind;
        el.querySelectorAll(".kind-chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.kind === pick)));
      });
    });

    el.querySelectorAll(".prompt-chip").forEach((pc) => {
      pc.addEventListener("click", () => {
        haptic(5);
        ta.value = pc.dataset.prompt || "";
        ta.dispatchEvent(new Event("input"));
        ta.focus();
      });
    });

    const photoBtn = $("#photoBtn", el);
    const photoInput = $("#photoInput", el);
    if (photoBtn && photoInput) {
      photoBtn.addEventListener("click", () => { haptic(5); photoInput.click(); });
      photoInput.addEventListener("change", () => {
        const f = photoInput.files && photoInput.files[0];
        if (f) void attachPhoto(f);
        photoInput.value = ""; // lets the same file be re-picked
      });
    }
    const photoClear = $("#photoClear", el);
    if (photoClear) photoClear.addEventListener("click", () => {
      const draft = ta.value;
      state.composerPhoto = null;
      renderMesh();
      const ta2 = $("#meshText", screens.mesh);
      if (ta2) { ta2.value = draft; $("#meshCount", screens.mesh).textContent = String(280 - draft.length); ta2.dispatchEvent(new Event("input")); }
    });

    el.querySelectorAll("[data-photo-label]").forEach((b) => {
      b.addEventListener("click", () => {
        haptic(5);
        if (!state.composerPhoto) return;
        state.composerPhoto.label = state.composerPhoto.label === b.dataset.photoLabel ? "" : b.dataset.photoLabel;
        el.querySelectorAll("[data-photo-label]").forEach((x) => x.setAttribute("aria-pressed", String((state.composerPhoto.label || "") === x.dataset.photoLabel)));
      });
    });

    $("#meshSend", el).addEventListener("click", () => {
      const text = ta.value.trim();
      if (!text && !state.composerPhoto) { toast("Type something, or attach a photo.", "warn"); return; }
      if (view === "directs" && !state.dmPeer) { toast("Pick a thread first — or reply to a neighbor's message.", "warn"); return; }

      let photoRef = null;
      let photoLabel = "";
      if (state.composerPhoto) {
        photoRef = state.composerPhoto.ref;
        photoLabel = state.composerPhoto.label || ""; // enum chosen from the photo-kind chips, or none
        const pending = pendingPhotos();
        pending[photoRef] = { data: state.composerPhoto.data, label: photoLabel };
        lsSet(LS.photos, pending);
        state.composerPhoto = null;
      }
      const photoOpts = { photoRef, label: photoLabel };

      if (view === "skywatch") {
        queuePacket(null, "", text || "photo", Object.assign({ to: "SKYWATCH" }, photoOpts));
        toast("Asked Skywatch — the answer rides the next sync back.", "mesh");
      } else if (view === "directs") {
        queuePacket(null, "", text || "photo", Object.assign({ to: state.dmPeer }, photoOpts));
        toast("Direct to " + state.dmPeer + " queued — relayed by a node with signal.", "mesh");
      } else if (pick) {
        const def = KINDS.find((k) => k.id === pick);
        queuePacket(pick, "", "");
        if (text || photoRef) { queuePacket(null, def.id, text, photoOpts); }
        toast(`Report queued — ${pick.toLowerCase()}.`, "mesh");
      } else {
        queuePacket(null, "", text || "photo", photoOpts);
        toast("Message queued to the mesh.", "mesh");
      }

      haptic(10);
      ta.value = "";
      $("#meshCount", el).textContent = "280";
      renderMeshBadge();
      state.meshDirty = false;
      renderMesh();
      // keep the keyboard up and the composer on screen, like Messages
      const nta = $("#meshText", el);
      if (nta) { nta.focus({ preventScroll: true }); nta.scrollIntoView({ block: "nearest" }); }
    });
  }

  function renderBundle(bundle, syncOut) {
    const acks = (bundle.acks || []).map((a) => `<div class="uplink-row"><span style="color:var(--ok)">${ICONS.check}</span><span>${esc(a.message)}</span></div>`).join("") || '<p class="mini dim">no acks in this bundle</p>';
    const msgs = (bundle.messages || []).map((m) => `<div class="uplink-row">${/skywatch/i.test(String(m.from || "")) ? '<span style="color:var(--ok)">' + ICONS.shieldS + "</span>" : ""}<span class="mono dim">${esc(m.from)}</span><span>${esc(m.text)}</span>${m.photoRef ? photoThumb(m.photoRef) : ""}</div>`).join("") || '<p class="mini dim">no messages for you in this bundle</p>';
    const roads = (bundle.blockedRoads || []).map((r) => `<div class="uplink-row"><span style="color:var(--danger)">${esc(r.status.toUpperCase())}</span><span>${esc(r.name)}</span><span class="mono dim">${Math.round((r.confidence || 0) * 100)}%</span></div>`).join("") || '<p class="mini dim">no fresh road verdicts</p>';
    const syncLine = syncOut
      ? `${esc(String(syncOut.received))} received · ${esc(String(syncOut.inserted))} stored · ${esc(String(syncOut.deduped))} deduped${syncOut.rejected ? " · " + esc(String(syncOut.rejected)) + " rejected" : ""}`
      : "";
    const sh = bundle.nearestVerifiedShelter;
    const photoNews = (bundle.photoReports || []).map((r) =>
      `<div class="uplink-row">${photoThumb(r.photoUrl.replace("/mesh/photo/", ""))}<span>${esc(r.status)}</span><span class="mono dim">score ${esc(String(r.score))}</span>${r.photoVision ? `<span class="chip ${r.photoVision.verdict === "confirmed" ? "chip-ok" : r.photoVision.verdict === "rejected" ? "chip-warn" : "chip-n"}">AI ${esc(r.photoVision.verdict)}</span>` : ""}</div>`
    ).join("") || "";
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
      ${photoNews ? `<div class="bundle-sec"><h4>Photo news — AI-checked</h4>${photoNews}</div>` : ""}
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
          <div class="kv"><span class="k">app build</span><span class="v" id="appBuild">…</span></div>
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
          <div class="kv"><span class="k">API</span><span class="v">${esc(apiBase() || location.origin)}</span></div>
          <div class="kv"><span class="k">health</span><span class="v" id="netHealth">${net.probeOk == null ? "probing…" : net.probeOk ? `<span style="color:var(--ok)">ok</span> ${esc(String(net.probeMs))} ms` : '<span style="color:var(--danger)">no answer</span>'}</span></div>
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

    // App build chip — shows the SW build the phone actually runs (fetched
    // through the service worker, so it's the shell that's live, on-device)
    fetch("sw.js").then((r) => r.text()).then((t) => {
      const m = String(t).match(/^const CACHE_VERSION = "([^"]+)"/m);
      const v = $("#appBuild", el);
      if (v) v.textContent = m ? m[1] : "?";
    }).catch(() => { const v = $("#appBuild", el); if (v) v.textContent = "?"; });

    // one fresh measurement for the Connection card while it's on screen
    void probeHealth().then(() => {
      const v = $("#netHealth", el);
      if (!v) return;
      v.innerHTML = net.probeOk
        ? '<span style="color:var(--ok)">ok</span> ' + esc(String(net.probeMs)) + " ms"
        : '<span style="color:var(--danger)">no answer</span>';
    });
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
      const errEl = $("#cfgErr", modal); // rendered but previously never written — bad saves were silent
      // a non-empty API base must be a real http(s) URL; a typo would otherwise
      // strand the demo on relative paths that 404 forever
      if (api && !/^https?:\/\/\S+$/.test(api)) {
        errEl.textContent = "API base must be a full URL (https://…) — or left empty for the harness proxy.";
        return;
      }
      errEl.textContent = "";
      state.cfg = {
        api,
        toolSecret: tool || state.cfg.toolSecret || "",
        photonSecret: photon || state.cfg.photonSecret || "",
        userId: state.cfg.userId || "",
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
    if (window.SkyVision) {
      window.SkyVision.attach({
        state, toast, haptic, openSheet, closeSheet, myLoc, esc, redraw: drawMap,
        stashPhoto(ref, data, label) { const pend = pendingPhotos(); pend[ref] = { data, label }; lsSet(LS.photos, pend); },
        queueHazard(pl) { queuePacket(null, "", pl.text, { photoRef: pl.photoRef, label: pl.label, hazard: pl.hazard }); },
        afterReport() {
          const ta = $("#meshText", screens.mesh), draft = ta ? ta.value : "";
          state.composerPhoto = null; // the photo rode the hazard packet
          renderMeshBadge(); renderMesh();
          const ta2 = $("#meshText", screens.mesh);
          if (ta2 && draft) { ta2.value = draft; ta2.dispatchEvent(new Event("input")); }
        },
      });
    }
    if (window.SkyNav) {
      window.SkyNav.init({
        myLoc, esc, haptic, toast, prefersReducedMotion, snapToPolyline, hazardMarkersAll, tileKeys,
        tileImg(z, x, y) { ensureTile(z, x, y); const rec = tileImgs.get(z + "/" + x + "/" + y); return rec && rec.state === "ok" ? rec.img : null; },
        afterEnd() { if (screens.map.classList.contains("active")) drawMap(); },
      });
    }
    window.__sky = { state, view, refit: () => { fitAll(); drawMap(); }, draw: drawMap, ensureIdentity, queuePacket, syncGateway, proj, routeForResource, routeLinePts, routeStepsHtml };

    /* Native BLE transport seam — runs ONLY in the Capacitor native build, where
     * apps/native/sync-web.mjs injects window.SKYWATCH_NATIVE and loads native-ble.js.
     * The browser build never sets the flag: the hotspot/gateway path above is untouched. */
    if (window.SKYWATCH_NATIVE && typeof window.skywatchBleTransport === "function") {
      void window.skywatchBleTransport({
        state, signedPacketFor, ingestRemotePackets, syncGateway, persist, ensureIdentity, toast,
      });
    }
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