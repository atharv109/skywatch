/**
 * Skywatch offline turn-by-turn navigation.
 *
 * Classic script (loaded before app.js). Two halves:
 *   1. PURE logic (no DOM): route normalisation, maneuver->icon mapping, distance /
 *      ETA formatting, the progress engine (snap, step auto-advance, off-route,
 *      arrival, hazard-ahead, announcements) and the drive simulator. Exported as
 *      window.SkyNav (and globalThis.SkyNav under vitest, apps/web/test/nav.test.ts).
 *   2. The full-screen navigation UI (canvas map from the cached tile pack, maneuver
 *      banner, ETA bar, voice, wake lock, simulate drive). Needs host.init() from app.js.
 *
 * OFFLINE CONTRACT: nothing here ever calls fetch / XHR / an external maps app.
 * Tiles come from the same-origin cached pack (host.tileImg), the route comes from the
 * bundle already on the phone, GPS and speechSynthesis are on-device. If you add a
 * network call to this file you broke the product.
 */
(function () {
  "use strict";

  var EARTH_M = 40075016.686;
  var RAD = Math.PI / 180;

  /* ====================================================================
   * PURE LOGIC
   * ==================================================================*/

  function haversineM(a, b) {
    var dLat = (b.lat - a.lat) * RAD, dLon = (b.lon - a.lon) * RAD;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * 6371000 * Math.asin(Math.sqrt(s));
  }
  function bearing(a, b) {
    var y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
    var x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }
  function compassWord(deg) { return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((deg % 360) + 360) % 360 / 45) % 8]; }
  var COMPASS_LONG = { N: "north", NE: "northeast", E: "east", SE: "southeast", S: "south", SW: "southwest", W: "west", NW: "northwest" };
  function compassLong(deg) { return COMPASS_LONG[compassWord(deg)]; }

  /** shortest-path angle lerp (degrees) */
  function lerpAngle(a, b, t) {
    var d = ((b - a + 540) % 360) - 180;
    return (a + d * t + 360) % 360;
  }

  /* ---- maneuver parsing / icons ---- */

  // longest first so "sharp right" wins over "right"
  var MODIFIERS = ["sharp right", "sharp left", "slight right", "slight left", "uturn", "straight", "right", "left"];

  /** "turn left on 4th Ave" / "depart" / "end of road right" -> {type, modifier} (name = the step's road, stripped first). */
  function parseInstruction(instr, name) {
    var s = String(instr || "").trim().toLowerCase();
    if (name) {
      var suf = " on " + String(name).toLowerCase();
      if (s.slice(-suf.length) === suf) s = s.slice(0, s.length - suf.length);
    } else {
      var at = s.indexOf(" on ");
      if (at > 0) s = s.slice(0, at);
    }
    var modifier = "";
    for (var i = 0; i < MODIFIERS.length; i++) {
      var m = MODIFIERS[i];
      if (s === m) { s = ""; modifier = m; break; }
      if (s.slice(-(m.length + 1)) === " " + m) { s = s.slice(0, s.length - m.length - 1); modifier = m; break; }
    }
    return { type: s || "continue", modifier: modifier };
  }

  /** OSRM maneuver type + modifier -> icon key */
  function maneuverIcon(type, modifier) {
    var t = String(type || "").toLowerCase(), m = String(modifier || "").toLowerCase();
    if (t === "arrive") return "arrive";
    if (t === "roundabout" || t === "rotary" || t === "roundabout turn" || t === "exit roundabout" || t === "exit rotary") return "roundabout";
    if (m === "uturn") return "uturn";
    if (m === "sharp left") return "sharp-left";
    if (m === "sharp right") return "sharp-right";
    if (t === "fork" || t === "on ramp" || t === "off ramp" || t === "ramp") {
      if (m.indexOf("left") >= 0) return "slight-left";
      if (m.indexOf("right") >= 0) return "slight-right";
      return "straight";
    }
    if (m === "slight left") return "slight-left";
    if (m === "slight right") return "slight-right";
    if (m === "left") return "left";
    if (m === "right") return "right";
    return "straight"; // depart, continue, new name, merge, straight, notification…
  }

  var ICON_PATHS = {
    straight: '<path d="M12 21V5"/><path d="M6.5 10.5 12 5l5.5 5.5"/>',
    left: '<path d="M16 21v-6a4 4 0 0 0-4-4H5.5"/><path d="M9.5 7 5.5 11l4 4"/>',
    right: '<path d="M8 21v-6a4 4 0 0 1 4-4h6.5"/><path d="M14.5 7l4 4-4 4"/>',
    "slight-left": '<path d="M15 21v-5l-6-6"/><path d="M9 15.5V10h5.5"/>',
    "slight-right": '<path d="M9 21v-5l6-6"/><path d="M15 15.5V10H9.5"/>',
    "sharp-left": '<path d="M16 21V9l-8 6"/><path d="M8 9.5V15h5.5"/>',
    "sharp-right": '<path d="M8 21V9l8 6"/><path d="M16 9.5V15h-5.5"/>',
    uturn: '<path d="M8 21V10a4 4 0 0 1 8 0v5"/><path d="M12.5 12.5 16 16l3.5-3.5"/>',
    roundabout: '<circle cx="12" cy="14" r="4"/><path d="M12 22v-4"/><path d="M12 10V3.5"/><path d="M8.8 6.5 12 3.5l3.2 3"/>',
    arrive: '<path d="M12 21s-6.5-5.4-6.5-10.2a6.5 6.5 0 0 1 13 0C18.5 15.6 12 21 12 21z"/><circle cx="12" cy="10.8" r="2.3"/>'
  };
  function iconSvg(key, size, cls) {
    var p = ICON_PATHS[key] || ICON_PATHS.straight;
    return '<svg class="' + (cls || "") + '" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + "</svg>";
  }

  /** human instruction for a step ("Turn left onto Columbia Street"). */
  function instructionText(step, destName) {
    var t = step.type, m = step.modifier, road = step.name ? " onto " + step.name : "";
    var roadOn = step.name ? " on " + step.name : "";
    var dir = m === "uturn" ? "make a U-turn" : m === "straight" || !m ? "continue straight" : "turn " + m;
    if (t === "depart") return "Head " + (step.headWord || "out") + (step.name ? " on " + step.name : "");
    if (t === "arrive") {
      var side = m === "left" ? ", on the left" : m === "right" ? ", on the right" : "";
      return "Arrive at " + (destName || "your destination") + side;
    }
    if (t === "roundabout" || t === "rotary" || t === "roundabout turn" || t === "exit roundabout" || t === "exit rotary") return "At the roundabout, take the exit" + road;
    if (t === "merge") return "Merge" + road;
    if (t === "on ramp") return "Take the ramp" + road;
    if (t === "off ramp") return "Take the exit" + road;
    if (t === "fork") return "Keep " + (m.indexOf("left") >= 0 ? "left" : m.indexOf("right") >= 0 ? "right" : "straight") + " at the fork" + road;
    if (t === "end of road") return "At the end of the road, " + (m === "uturn" ? "make a U-turn" : "turn " + (m || "ahead")) + road;
    if (t === "new name") return "Continue" + road;
    if (t === "continue") return (m && m !== "straight" ? "Continue " + m : "Continue straight") + roadOn;
    if (t === "synthetic") return step.text || "Continue";
    // turn / default
    return dir.charAt(0).toUpperCase() + dir.slice(1) + (m === "straight" || !m ? roadOn : road);
  }

  /* ---- route normalisation (wire MeshRouteView OR the client's geometry shape) ---- */

  var normCache = typeof WeakMap === "function" ? new WeakMap() : null;

  function polyLength(coords) {
    var cum = [0];
    if (!coords.length) return cum;
    var kx = Math.cos(coords[0][1] * RAD) * 111320, ky = 110540;
    for (var i = 1; i < coords.length; i++) {
      cum.push(cum[i - 1] + Math.hypot((coords[i][0] - coords[i - 1][0]) * kx, (coords[i][1] - coords[i - 1][1]) * ky));
    }
    return cum;
  }

  /**
   * -> { coords:[[lon,lat]], geometry, dest, destName, profile, distanceKm, durationMin, source, fetchedAt,
   *      verified:(bool|null), toStatus, toConfidence, steps:[{type,modifier,name,distanceM,text,icon,b}], cum, totalM, straight:false }
   * Step.b = metres along the route where the step's maneuver happens. Returns null if unusable.
   */
  function normalizeRoute(r) {
    if (!r || typeof r !== "object") return null;
    if (r.__nav) return r;
    if (normCache && normCache.has(r)) return normCache.get(r);
    var coords = [];
    if (Array.isArray(r.coords)) coords = r.coords.filter(function (c) { return Array.isArray(c) && c.length >= 2; }).map(function (c) { return [c[1], c[0]]; }); // wire: [lat,lon]
    else if (r.geometry && Array.isArray(r.geometry.coordinates)) coords = r.geometry.coordinates.filter(function (c) { return Array.isArray(c) && c.length >= 2; }).map(function (c) { return [c[0], c[1]]; }); // GeoJSON [lon,lat]
    if (coords.length < 2) return null;
    var cum = polyLength(coords), total = cum[cum.length - 1];
    var to = r.to || r.dest || null;
    var dest = to && typeof to.lat === "number" && typeof to.lon === "number" ? { lat: to.lat, lon: to.lon } : { lat: coords[coords.length - 1][1], lon: coords[coords.length - 1][0] };
    var destName = (to && to.name) || r.destName || "";
    var raw = Array.isArray(r.steps) ? r.steps : [];
    var steps = raw.map(function (s) {
      s = s || {};
      var name = typeof s.name === "string" ? s.name : "";
      var p;
      if (s.maneuver && (s.maneuver.type || s.maneuver.modifier)) p = { type: String(s.maneuver.type || "continue").toLowerCase(), modifier: String(s.maneuver.modifier || "").toLowerCase() };
      else p = parseInstruction(s.instruction != null ? s.instruction : s.text, name);
      return { type: p.type, modifier: p.modifier, name: name, distanceM: Math.max(0, Number(s.distanceM) || 0), text: "", icon: "", b: 0 };
    });
    // boundaries: scale OSRM step lengths onto the (sampled) polyline when they cover it; else leave + add a synthetic "continue"
    var sumD = steps.reduce(function (a, s) { return a + s.distanceM; }, 0);
    var k = sumD > 0 && sumD >= total * 0.88 ? total / sumD : 1;
    var acc = 0;
    steps.forEach(function (s) { s.b = acc; s.distanceM = s.distanceM * k; acc += s.distanceM; });
    var last = steps[steps.length - 1];
    if (!last || last.type !== "arrive") {
      if (steps.length && acc < total - 25) steps.push({ type: "synthetic", modifier: "", name: "", distanceM: total - acc, text: "Continue to " + (destName || "your destination"), icon: "straight", b: acc });
      steps.push({ type: "arrive", modifier: "", name: "", distanceM: 0, text: "", icon: "arrive", b: total });
    } else {
      last.b = total;
    }
    if (steps[0].type !== "depart" && steps[0].type !== "synthetic") steps.unshift({ type: "depart", modifier: "", name: "", distanceM: 0, text: "", icon: "straight", b: 0 });
    // fix zero-length bookkeeping after unshift: step distances = gap to next boundary
    for (var i = 0; i < steps.length; i++) steps[i].distanceM = (i + 1 < steps.length ? steps[i + 1].b : total) - steps[i].b;
    var headWord = compassLong(bearing({ lat: coords[0][1], lon: coords[0][0] }, { lat: coords[1][1], lon: coords[1][0] }));
    steps.forEach(function (s) {
      s.headWord = headWord;
      s.icon = s.type === "synthetic" ? "straight" : maneuverIcon(s.type, s.modifier);
      s.text = instructionText(s, destName);
    });
    var verified = null;
    if (to && typeof to.verified === "boolean") verified = to.verified;
    var out = {
      __nav: true,
      coords: coords,
      geometry: { type: "LineString", coordinates: coords },
      dest: dest,
      destName: destName,
      profile: r.profile === "driving" ? "driving" : "foot",
      distanceKm: r.distanceKm != null ? Number(r.distanceKm) : total / 1000,
      durationMin: r.durationMin != null ? Number(r.durationMin) : null,
      source: r.source || "",
      fetchedAt: r.fetchedAt != null ? r.fetchedAt : null,
      verified: verified,
      toStatus: to && to.status ? to.status : null,
      toConfidence: to && typeof to.confidence === "number" ? to.confidence : null,
      steps: steps,
      cum: cum,
      totalM: total,
      straight: false
    };
    if (normCache) normCache.set(r, out);
    return out;
  }

  /** a no-road-route fallback: depart -> arrive over the straight line, flagged straight. */
  function straightRoute(from, dest, destName) {
    var total = haversineM(from, dest);
    var head = compassLong(bearing(from, dest));
    return {
      __nav: true,
      coords: [[from.lon, from.lat], [dest.lon, dest.lat]],
      geometry: { type: "LineString", coordinates: [[from.lon, from.lat], [dest.lon, dest.lat]] },
      dest: { lat: dest.lat, lon: dest.lon }, destName: destName || "", profile: "foot",
      distanceKm: total / 1000, durationMin: null, source: "straight", fetchedAt: null,
      verified: null, toStatus: null, toConfidence: null, cum: [0, total], totalM: total, straight: true,
      steps: [
        { type: "depart", modifier: "", name: "", distanceM: total, text: "Head " + head + " toward " + (destName || "your destination"), icon: "straight", b: 0, headWord: head },
        { type: "arrive", modifier: "", name: "", distanceM: 0, text: "Arrive at " + (destName || "your destination"), icon: "arrive", b: total }
      ]
    };
  }

  /* ---- formatting ---- */

  /** imperial for en-US (and the other three imperial regions); bare "en" too (US-centred app). */
  function defaultUnits(locale) {
    var l = String(locale || "").replace("_", "-");
    var m = /^[a-z]{2,3}(?:-[A-Za-z]{4})?-([A-Za-z]{2})\b/.exec(l);
    var region = m ? m[1].toUpperCase() : "";
    if (region === "US" || region === "LR" || region === "MM") return "imperial";
    if (!region && /^en$/i.test(l)) return "imperial";
    return "metric";
  }

  /** "300 ft" / "0.4 mi" / "300 m" / "1.2 km"; long=true -> spoken words ("300 feet"). */
  function fmtNavDist(m, units, long) {
    m = Math.max(0, Number(m) || 0);
    if (units === "metric") {
      if (m < 950) {
        var r = m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50;
        if (m < 5) r = 0;
        return r + (long ? " meters" : " m");
      }
      var km = m / 1000;
      return (km < 10 ? km.toFixed(1) : String(Math.round(km))) + (long ? " kilometers" : " km");
    }
    var ft = m * 3.28084;
    if (ft < 950) {
      var f = ft < 100 ? Math.max(10, Math.round(ft / 10) * 10) : ft < 500 ? Math.round(ft / 50) * 50 : Math.round(ft / 100) * 100;
      if (ft < 5) f = 0;
      return f + (long ? " feet" : " ft");
    }
    var mi = m / 1609.344;
    return (mi < 10 ? mi.toFixed(1) : String(Math.round(mi))) + (long ? " miles" : " mi");
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Number(sec) || 0);
    var min = Math.round(sec / 60);
    if (min < 1) return "1 min";
    if (min < 60) return min + " min";
    var h = Math.floor(min / 60), mm = min % 60;
    return h + " h" + (mm ? " " + mm + " min" : "");
  }

  /** remaining time + arrival timestamp. Uses the route's own average pace (duration/length) when carried, else walk 1.4 m/s / drive 11 m/s. */
  function etaMath(remainingM, route, nowMs) {
    remainingM = Math.max(0, remainingM);
    var sec;
    if (route && route.durationMin > 0 && route.totalM > 0 && !route.straight) sec = route.durationMin * 60 * (remainingM / route.totalM);
    else sec = remainingM / (route && route.profile === "driving" ? 11 : 1.4);
    return { sec: sec, arriveAt: (nowMs == null ? Date.now() : nowMs) + sec * 1000 };
  }

  function relTime(ts, now) {
    var d = Math.max(0, ((now == null ? Date.now() : now) - ts) / 60000);
    if (d < 1) return "just now";
    if (d < 60) return Math.round(d) + "m ago";
    if (d < 1440) return Math.round(d / 60) + "h ago";
    return Math.round(d / 1440) + "d ago";
  }

  /* ---- progress engine ---- */

  var OFF_ROUTE_M = 50, OFF_ROUTE_FIXES = 3, ARRIVE_M = 30, HAZARD_AHEAD_M = 150, STEP_ADV_M = 8;
  var ANNOUNCE_AT = { foot: [150, 30], driving: [800, 250, 50] };

  function pointAtAlong(route, along) {
    var c = route.coords, cum = route.cum;
    along = Math.max(0, Math.min(route.totalM, along));
    var i = 0;
    while (i < cum.length - 2 && cum[i + 1] < along) i++;
    var seg = cum[i + 1] - cum[i], t = seg > 0 ? (along - cum[i]) / seg : 0;
    var a = { lat: c[i][1], lon: c[i][0] }, b = { lat: c[i + 1][1], lon: c[i + 1][0] };
    return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, bearing: bearing(a, b), seg: i };
  }

  /** nearest hazard marker on the upcoming route within aheadM (markers: {lat,lon,kind,label,ts,confidence}) */
  function hazardAhead(route, markers, progress, snap, aheadM) {
    var lim = aheadM == null ? HAZARD_AHEAD_M : aheadM, best = null;
    (markers || []).forEach(function (mk) {
      var s = snap(mk, route.coords);
      if (!s || s.m > 60) return;
      var ahead = s.alongM - progress;
      if (ahead < -15 || ahead > lim) return;
      if (!best || ahead < best.aheadM) best = { kind: mk.kind, label: mk.label || "", ts: mk.ts || null, confidence: mk.confidence == null ? null : mk.confidence, aheadM: Math.max(0, Math.round(ahead)), offM: Math.round(s.m), key: mk.kind + "@" + Math.round(s.alongM) };
    });
    return best;
  }

  /**
   * Progress engine. deps.snap = snapToPolyline (app.js) so the geometry maths is the one the sheet uses.
   * update(fix{lat,lon,acc?}, markers?, units?) -> view; pure state machine, no clocks, no DOM.
   */
  function createEngine(route, deps) {
    var snap = deps.snap;
    var st = { progress: 0, seg: 0, offCount: 0, off: false, everOn: false, arrived: false, started: false, spoken: {}, hz: {}, fixes: 0 };
    var thresholds = (ANNOUNCE_AT[route.profile] || ANNOUNCE_AT.foot).slice().sort(function (a, b) { return b - a; });

    function snapWindowed(pt) {
      var c = route.coords, lo = Math.max(0, st.seg - 3), hi = Math.min(c.length - 1, st.seg + 40);
      if (hi - lo < 1) { lo = 0; hi = c.length - 1; }
      var s = snap(pt, c.slice(lo, hi + 1));
      if (!s) return null;
      return { m: s.m, at: s.at, alongM: route.cum[lo] + s.alongM, seg: lo + s.idx };
    }

    function update(fix, markers, units) {
      st.fixes++;
      var pos = { lat: fix.lat, lon: fix.lon };
      var announce = [];
      var direct = haversineM(pos, route.dest);

      if (route.straight) {
        var rem = direct;
        var arrivedS = rem < ARRIVE_M;
        if (arrivedS && !st.arrived) { st.arrived = true; announce.push("You have arrived at " + (route.destName || "your destination") + "."); }
        if (!st.started) { st.started = true; announce.push("Starting. No road route is cached, so this is a straight-line guide. Head " + compassLong(bearing(pos, route.dest)) + "."); }
        st.progress = Math.max(0, route.totalM - rem);
        return { straight: true, along: st.progress, progress: st.progress, offM: 0, remainingM: rem, curIdx: 0, nextIdx: 1, distToNext: rem, offRoute: false, joining: false, rejoin: null, arrived: st.arrived, hazard: null, announce: announce, guideBearing: bearing(pos, route.dest) };
      }

      var thr = Math.max(OFF_ROUTE_M, Math.min(100, fix.acc || 0));
      var s = snapWindowed(pos);
      if (!s || s.m > thr) { // maybe we're on a different stretch: look at the whole line
        var g = snap(pos, route.coords);
        if (g && (!s || g.m < s.m - 20)) s = { m: g.m, at: g.at, alongM: g.alongM, seg: g.idx };
      }
      var offM = s ? s.m : direct;
      var wasOff = st.off;
      var joining = false;
      if (offM <= OFF_ROUTE_M) { st.everOn = true; st.offCount = 0; st.off = false; }
      else if (!st.everOn) { joining = true; } // never reached the route yet: "join the route", not an alarm
      else { st.offCount++; if (st.offCount >= OFF_ROUTE_FIXES) st.off = true; }
      if (st.off && offM <= OFF_ROUTE_M * 0.8) { st.off = false; st.offCount = 0; }
      if (s && !st.off && !joining) { st.progress = Math.max(st.progress, s.alongM); st.seg = s.seg; }
      else if (s && st.off) { st.seg = s.seg; }

      var progress = st.progress;
      var remainingM = Math.max(0, route.totalM - progress);
      var cur = 0;
      for (var i = 0; i < route.steps.length; i++) { if (route.steps[i].b <= progress + STEP_ADV_M) cur = i; }
      var nextIdx = Math.min(route.steps.length - 1, cur + 1);
      var distToNext = Math.max(0, route.steps[nextIdx].b - progress);

      var arrived = st.arrived || (!st.off && !joining && (remainingM < ARRIVE_M || (direct < ARRIVE_M && progress > route.totalM * 0.5)));
      var rejoin = null;
      if ((st.off || joining) && s) rejoin = { bearing: bearing(pos, s.at), distM: s.m, at: s.at };

      var hazard = (!st.off && !joining && !arrived) ? hazardAhead(route, markers, progress, snap, HAZARD_AHEAD_M) : null;

      // ---- announcements (each fires once) ----
      var u = units || "imperial";
      if (!st.started) {
        st.started = true;
        if (joining) announce.push("Walk " + fmtNavDist(offM, u, true) + " " + compassLong(rejoin ? rejoin.bearing : 0) + " to join the route.");
        else announce.push("Starting navigation. " + route.steps[0].text + ".");
      }
      if (arrived && !st.arrived) { st.arrived = true; announce.push("You have arrived at " + (route.destName || "your destination") + "."); }
      if (!arrived) {
        if (st.off && !wasOff) announce.push("You are off route. There is no signal to re-route. Head " + compassLong(rejoin ? rejoin.bearing : 0) + " to rejoin the route.");
        if (wasOff && !st.off) announce.push("Back on route.");
        if (!st.off && !joining && st.everOn) {
          // announce the smallest threshold we are inside, once; mark the bigger ones spoken without speaking them
          var fired = null;
          for (var t = 0; t < thresholds.length; t++) {
            if (distToNext <= thresholds[t]) {
              var key = nextIdx + ":" + thresholds[t];
              if (!st.spoken[key]) { st.spoken[key] = true; fired = thresholds[t]; }
            }
          }
          if (fired != null) {
            var step = route.steps[nextIdx], txt = step.text;
            var smallest = thresholds[thresholds.length - 1];
            announce.push(fired <= smallest ? txt + "." : "In " + fmtNavDist(distToNext, u, true) + ", " + txt.charAt(0).toLowerCase() + txt.slice(1) + ".");
          }
        }
        if (hazard && !st.hz[hazard.key]) {
          st.hz[hazard.key] = true;
          announce.push((hazard.kind === "bridge_out" ? "Bridge out" : "Road blocked") + " reported " + (hazard.aheadM < 25 ? "just ahead" : "ahead in " + fmtNavDist(hazard.aheadM, u, true)) + ".");
        }
      }

      return { straight: false, along: s ? s.alongM : progress, progress: progress, offM: offM, remainingM: remainingM, curIdx: cur, nextIdx: nextIdx, distToNext: distToNext, offRoute: st.off, joining: joining, rejoin: rejoin, arrived: arrived, hazard: hazard, announce: announce, guideBearing: rejoin ? rejoin.bearing : null, segBearing: pointAtAlong(route, progress).bearing };
    }

    return { update: update, _state: st };
  }

  /* ---- drive simulator (pure stepping; the UI feeds the result to engine.update like a GPS fix) ---- */

  /** base pace of the route in m/s (carried duration/length, else profile default) */
  function routePace(route) {
    if (route.durationMin > 0 && route.totalM > 0 && !route.straight) return route.totalM / (route.durationMin * 60);
    return route.profile === "driving" ? 11 : 1.4;
  }
  /** advance dtSec at mps -> new along (clamped to the end) */
  function simStep(route, along, dtSec, mps) {
    return Math.min(route.totalM, Math.max(0, along) + Math.max(0, dtSec) * Math.max(0, mps));
  }
  /** the fake fix at `along`, optionally displaced offsetM to the right of travel (wrong-turn demo) */
  function simFix(route, along, offsetM) {
    var p = pointAtAlong(route, along), lat = p.lat, lon = p.lon;
    if (offsetM) {
      var b = (p.bearing + 90) * RAD;
      lat += (Math.cos(b) * offsetM) / 110540;
      lon += (Math.sin(b) * offsetM) / (111320 * Math.cos(p.lat * RAD));
    }
    return { lat: lat, lon: lon, acc: 5, heading: p.bearing, along: along };
  }

  var api = {
    haversineM: haversineM, bearing: bearing, compassWord: compassWord, compassLong: compassLong, lerpAngle: lerpAngle,
    parseInstruction: parseInstruction, maneuverIcon: maneuverIcon, iconSvg: iconSvg, instructionText: instructionText,
    normalizeRoute: normalizeRoute, straightRoute: straightRoute,
    defaultUnits: defaultUnits, fmtNavDist: fmtNavDist, fmtDuration: fmtDuration, etaMath: etaMath, relTime: relTime,
    createEngine: createEngine, hazardAhead: hazardAhead, pointAtAlong: pointAtAlong, routePace: routePace, simStep: simStep, simFix: simFix,
    OFF_ROUTE_M: OFF_ROUTE_M, OFF_ROUTE_FIXES: OFF_ROUTE_FIXES, ARRIVE_M: ARRIVE_M, HAZARD_AHEAD_M: HAZARD_AHEAD_M,
    active: false
  };

  /* ====================================================================
   * UI (browser only)
   * ==================================================================*/
  var root = typeof window !== "undefined" ? window : globalThis;
  root.SkyNav = api;
  if (typeof document === "undefined") return;

  var host = null, S = null, layer = null, els = {};
  var UNVERIFIED = "Shelter not verified — confirm before going";

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function reduced() { return !!(host && host.prefersReducedMotion && host.prefersReducedMotion()); }
  function esc(s) { return host.esc(s); }

  api.init = function (h) { host = h; };

  function buildLayer() {
    if (layer) return;
    layer = document.createElement("div");
    layer.className = "nav-layer";
    layer.id = "navLayer";
    layer.hidden = true;
    layer.setAttribute("role", "application");
    layer.setAttribute("aria-label", "Turn-by-turn navigation");
    layer.innerHTML =
      '<canvas id="navCanvas" aria-hidden="true"></canvas>' +
      '<div class="nav-top">' +
        '<div class="nav-banner" id="navBanner" role="status" aria-live="polite">' +
          '<div class="nb-icon" id="nbIcon"></div>' +
          '<div class="nb-main"><div class="nb-dist" id="nbDist"></div><div class="nb-text" id="nbText"></div></div>' +
          '<button class="nb-menu" id="nbMenu" type="button" aria-label="Navigation options" aria-haspopup="true" aria-expanded="false"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>' +
        '</div>' +
        '<div class="nb-then" id="nbThen" hidden></div>' +
        '<div class="nb-alert" id="nbAlert" role="alert" hidden></div>' +
        '<div class="nb-chips" id="nbChips"></div>' +
        '<div class="nav-menu" id="navMenu" hidden role="menu"></div>' +
      '</div>' +
      '<div class="nav-nogps" id="navNoGps" hidden></div>' +
      '<div class="nav-bottom">' +
        '<div class="eta-bar" id="etaBar">' +
          '<button class="eta-handle" id="etaHandle" type="button" aria-expanded="false" aria-controls="etaSteps" aria-label="Show all steps"><span class="eta-grip"></span></button>' +
          '<div class="eta-row">' +
            '<div class="eta-cell"><b id="etaTime">--</b><span>min</span></div>' +
            '<div class="eta-cell"><b id="etaDist">--</b><span>left</span></div>' +
            '<div class="eta-cell"><b id="etaClock">--:--</b><span>arrive</span></div>' +
            '<button class="eta-end" id="etaEnd" type="button">End</button>' +
          '</div>' +
          '<div class="eta-sub"><span class="eta-mode" id="etaMode"></span><span class="eta-sim" id="etaSim" hidden>Simulated</span></div>' +
          '<div class="eta-steps" id="etaSteps" hidden></div>' +
        '</div>' +
      '</div>' +
      '<div class="nav-arrived" id="navArrived" hidden></div>';
    var phone = document.getElementById("phone") || document.body;
    phone.appendChild(layer);
    ["navCanvas", "nbIcon", "nbDist", "nbText", "nbThen", "nbAlert", "nbChips", "navMenu", "navNoGps", "etaBar", "etaHandle", "etaTime", "etaDist", "etaClock", "etaMode", "etaSim", "etaSteps", "etaEnd", "navArrived", "nbMenu", "navBanner"].forEach(function (id) { els[id] = layer.querySelector("#" + id); });

    els.etaEnd.addEventListener("click", function () { api.end(); });
    els.etaHandle.addEventListener("click", toggleSteps);
    els.nbMenu.addEventListener("click", function () { toggleMenu(); });
    els.navMenu.addEventListener("click", onMenuClick);
    els.navNoGps.addEventListener("click", function (e) { if (e.target.closest("[data-act='sim']")) startSim(); });
    els.navArrived.addEventListener("click", function (e) { if (e.target.closest("[data-act='done']")) api.end(); });
    document.addEventListener("keydown", function (e) { if (S && S.open && e.key === "Escape") { if (!els.navMenu.hidden) toggleMenu(false); else api.end(); } });
    document.addEventListener("visibilitychange", function () { if (S && S.open && !document.hidden) { acquireWake(); } });
  }

  function toggleSteps() {
    S.expanded = !S.expanded;
    els.etaSteps.hidden = !S.expanded;
    els.etaHandle.setAttribute("aria-expanded", String(S.expanded));
    els.etaBar.classList.toggle("open", S.expanded);
    if (S.expanded) renderSteps();
  }

  function toggleMenu(force) {
    var show = force == null ? els.navMenu.hidden : force;
    if (show) renderMenu();
    els.navMenu.hidden = !show;
    els.nbMenu.setAttribute("aria-expanded", String(show));
  }
  function renderMenu() {
    var simOn = !!S.sim;
    els.navMenu.innerHTML =
      '<button type="button" role="menuitem" data-act="' + (simOn ? "stopsim" : "sim") + '">' + (simOn ? "Stop simulation" : "Simulate drive") + "</button>" +
      (simOn ? '<button type="button" role="menuitem" data-act="wrong">Simulate a wrong turn</button><button type="button" role="menuitem" data-act="speed">Simulation speed: ' + S.sim.mult + "×</button>" : "") +
      '<button type="button" role="menuitem" data-act="mute">' + (S.muted ? "Voice guidance: off" : "Voice guidance: on") + "</button>" +
      '<button type="button" role="menuitem" data-act="units">Units: ' + (S.units === "imperial" ? "miles / feet" : "km / meters") + "</button>" +
      '<p class="nav-menu-note">Fully offline: cached route, cached map tiles, on-device GPS and voice. No maps app or network is used.</p>';
  }
  function onMenuClick(e) {
    var b = e.target.closest("button[data-act]");
    if (!b) return;
    var a = b.getAttribute("data-act");
    if (a === "sim") { toggleMenu(false); startSim(); }
    else if (a === "stopsim") { stopSim(); renderMenu(); }
    else if (a === "wrong") { if (S.sim) { S.sim.wrongTicks = 14; } toggleMenu(false); }
    else if (a === "speed") { var opts = [3, 8, 20]; S.sim.mult = opts[(opts.indexOf(S.sim.mult) + 1) % opts.length]; renderMenu(); }
    else if (a === "mute") { S.muted = !S.muted; lsSet("skywatch.nav.muted", S.muted ? "1" : "0"); if (S.muted && root.speechSynthesis) try { root.speechSynthesis.cancel(); } catch (x) { /* ignore */ } renderMenu(); }
    else if (a === "units") { S.units = S.units === "imperial" ? "metric" : "imperial"; lsSet("skywatch.nav.units", S.units); renderMenu(); refreshUi(); }
  }

  /* ---- speech (on-device; silently no-ops when unsupported) ---- */
  function speak(text) {
    if (!text || S.muted || !root.speechSynthesis || typeof root.SpeechSynthesisUtterance !== "function") return;
    try {
      root.speechSynthesis.cancel();
      var u = new root.SpeechSynthesisUtterance(text);
      u.lang = (navigator.language || "en-US");
      root.speechSynthesis.speak(u);
    } catch (e) { /* no voice installed */ }
  }

  /* ---- wake lock ---- */
  function acquireWake() {
    try {
      if (navigator.wakeLock && navigator.wakeLock.request && (!S.wake || S.wake.released)) {
        navigator.wakeLock.request("screen").then(function (l) { S.wake = l; }, function () { /* denied / unsupported */ });
      }
    } catch (e) { /* optional */ }
  }
  function releaseWake() { try { if (S && S.wake && S.wake.release) S.wake.release(); } catch (e) { /* ignore */ } if (S) S.wake = null; }

  /* ---- compass ---- */
  function onOrient(ev) {
    var h = null;
    if (typeof ev.webkitCompassHeading === "number") h = ev.webkitCompassHeading;
    else if (ev.absolute && typeof ev.alpha === "number") h = (360 - ev.alpha) % 360;
    if (h != null && isFinite(h) && S) S.compass = h;
  }
  function startCompass() {
    try {
      var DOE = root.DeviceOrientationEvent;
      var go = function () {
        root.addEventListener("deviceorientationabsolute", onOrient, true);
        root.addEventListener("deviceorientation", onOrient, true);
      };
      if (DOE && typeof DOE.requestPermission === "function") DOE.requestPermission().then(function (r) { if (r === "granted") go(); }, function () { /* denied: course fallback */ });
      else go();
    } catch (e) { /* no compass: course from movement */ }
  }
  function stopCompass() {
    root.removeEventListener("deviceorientationabsolute", onOrient, true);
    root.removeEventListener("deviceorientation", onOrient, true);
  }

  /* ---- GPS ---- */
  function startGps() {
    if (!navigator.geolocation || !navigator.geolocation.watchPosition) { S.gpsErr = "unsupported"; showNoGps(); return; }
    try {
      S.watch = navigator.geolocation.watchPosition(function (pos) {
        if (!S || S.sim) return;
        var c = pos.coords;
        onFix({ lat: c.latitude, lon: c.longitude, acc: c.accuracy || 0, heading: typeof c.heading === "number" && isFinite(c.heading) ? c.heading : null, speed: typeof c.speed === "number" && isFinite(c.speed) ? c.speed : null }, false);
      }, function (err) {
        if (!S) return;
        S.gpsErr = err && err.code === 1 ? "denied" : "unavailable";
        if (!S.fix) showNoGps();
      }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    } catch (e) { S.gpsErr = "unsupported"; showNoGps(); }
    clearTimeout(S.gpsTimer);
    S.gpsTimer = setTimeout(function () { if (S && S.open && !S.fix) showNoGps(); }, 7000);
  }
  function stopGps() {
    if (S && S.watch != null && navigator.geolocation) { try { navigator.geolocation.clearWatch(S.watch); } catch (e) { /* ignore */ } }
    if (S) { S.watch = null; clearTimeout(S.gpsTimer); }
  }
  function showNoGps() {
    if (!S || S.fix) return;
    var why = S.gpsErr === "denied" ? "Location permission is off." : S.gpsErr === "unsupported" ? "This device has no GPS." : "No GPS fix yet (indoors?).";
    els.navNoGps.hidden = false;
    els.navNoGps.innerHTML = '<p>' + esc(why) + ' You can still see the route.</p><button type="button" class="btn btn-primary" data-act="sim">Simulate drive</button>';
  }

  /* ---- simulation ---- */
  function startSim() {
    if (!S || S.sim || S.arrived) return;
    S.sim = { along: 0, mult: 3, wrongTicks: 0, offset: 0, timer: null };
    S.engine = api.createEngine(S.route, { snap: host.snapToPolyline }); // fresh progress state
    S.fix = null; S.course = null;
    els.navNoGps.hidden = true;
    els.etaSim.hidden = false;
    renderChips();
    var tick = function () {
      var sim = S && S.sim;
      if (!sim) return;
      var base = routePaceMps();
      sim.along = simStep(S.route, sim.along, 1, base * sim.mult);
      if (sim.wrongTicks > 0) { sim.offset = Math.min(130, sim.offset + 26); sim.wrongTicks--; }
      else if (sim.offset > 0) sim.offset = Math.max(0, sim.offset - 26);
      var f = simFix(S.route, sim.along, sim.offset);
      f.speed = base * sim.mult;
      onFix(f, true);
      if (S.arrived) stopSim(true);
    };
    S.sim.timer = setInterval(tick, 1000);
    tick();
  }
  function routePaceMps() { return routePace(S.route); }
  function stopSim(keepChip) {
    if (!S || !S.sim) return;
    clearInterval(S.sim.timer);
    S.sim = null;
    if (!keepChip) els.etaSim.hidden = true;
    renderChips();
  }

  /* ---- fix handling ---- */
  function onFix(f, simulated) {
    if (!S || !S.open) return;
    var prev = S.fix;
    S.fix = f;
    els.navNoGps.hidden = true;
    if (prev && !simulated) {
      var moved = api.haversineM(prev, f);
      if (moved > 4) S.course = api.bearing(prev, f);
    }
    if (f.heading != null && (simulated || (f.speed || 0) > 1)) S.course = f.heading;
    if (simulated) S.compass = null;
    S.target = { lat: f.lat, lon: f.lon };
    if (!S.disp) S.disp = { lat: f.lat, lon: f.lon };
    var markers = host.hazardMarkersAll();
    S.markers = markers;
    var v = S.engine.update(f, markers, S.units);
    S.view = v;
    if (v.arrived) S.arrived = true;
    v.announce.forEach(function (t) { speak(t); });
    refreshUi();
    if (S.arrived) showArrived();
  }

  /* ---- UI refresh (per fix, not per frame) ---- */
  function guideArrow(angleDeg, big) {
    return '<svg class="nb-guide" viewBox="0 0 24 24" width="' + (big ? 56 : 40) + '" height="' + (big ? 56 : 40) + '" aria-hidden="true" style="transform:rotate(' + Math.round(angleDeg) + 'deg)"><path d="M12 2.5l7 17-7-4.2-7 4.2z" fill="currentColor"/></svg>';
  }

  function refreshUi() {
    if (!S || !els.nbText) return;
    var r = S.route, v = S.view, u = S.units;
    var fmt = function (m) { return api.fmtNavDist(m, u); };
    var banner = els.navBanner;
    banner.className = "nav-banner";
    var alertHtml = "", thenHtml = "";
    S.guideMode = null;

    if (!v) {
      // waiting for the first fix
      var first = r.steps[Math.min(1, r.steps.length - 1)];
      els.nbIcon.innerHTML = api.iconSvg(first.icon, 48);
      els.nbDist.textContent = fmt(first.b);
      els.nbText.textContent = S.sim ? "Starting simulation…" : "Waiting for GPS…";
      thenHtml = r.straight ? "" : "Route preview: " + esc(first.text);
    } else if (r.straight) {
      var rel = (v.guideBearing - (S.camHeading || 0));
      els.nbIcon.innerHTML = v.arrived ? api.iconSvg("arrive", 48) : guideArrow(rel, true);
      S.guideMode = { bearingKey: "straight" };
      els.nbDist.textContent = fmt(v.remainingM);
      els.nbText.textContent = "Head " + api.compassLong(v.guideBearing) + " toward " + (r.destName || "the destination");
      thenHtml = "Straight-line guide: roads and turns are not available offline for this trip.";
    } else if (v.joining || v.offRoute) {
      banner.classList.add(v.joining ? "join" : "off");
      var rb = v.rejoin ? v.rejoin.bearing : 0;
      els.nbIcon.innerHTML = guideArrow(rb - (S.camHeading || 0), true);
      S.guideMode = { bearing: rb };
      els.nbDist.textContent = fmt(v.rejoin ? v.rejoin.distM : v.offM);
      els.nbText.textContent = v.joining ? "Walk to the start of the route" : "Off route";
      alertHtml = (v.joining
        ? "Head " + api.compassLong(rb) + " to join the cached route."
        : "Head " + api.compassLong(rb) + " (" + api.compassWord(rb) + ") to rejoin the route.") +
        " Re-routing needs a network, so this phone can only guide you back to the cached route.";
      alertHtml = '<b>' + (v.joining ? "Not on the route yet" : "You are off the route") + '</b> ' + esc(alertHtml);
      var nx = r.steps[v.nextIdx];
      thenHtml = "Route resumes: " + esc(nx.text);
    } else {
      var atStart = v.progress < 25 && v.curIdx === 0;
      var step = atStart ? r.steps[0] : r.steps[v.nextIdx];
      els.nbIcon.innerHTML = api.iconSvg(step.icon, 48);
      els.nbDist.textContent = v.arrived ? "" : fmt(v.distToNext);
      els.nbText.textContent = v.arrived ? "You have arrived" : step.text;
      var follow = atStart ? r.steps[v.nextIdx] : r.steps[v.nextIdx + 1];
      if (follow && !v.arrived) thenHtml = "Then " + esc(follow.text.charAt(0).toLowerCase() + follow.text.slice(1));
    }

    els.nbThen.hidden = !thenHtml;
    els.nbThen.innerHTML = thenHtml;

    // hazard warning (keeps navigating)
    if (v && v.hazard && !v.offRoute && !v.joining) {
      var h = v.hazard, kind = h.kind === "bridge_out" ? "Bridge out" : "Road blocked";
      var when = h.ts ? " — photo-verified " + api.relTime(h.ts) : " — reported";
      var conf = h.confidence != null ? " · " + Math.round(h.confidence * 100) + "% confidence" : "";
      alertHtml = '<b>' + esc(kind) + ' reported ahead</b>' + (h.aheadM < 25 ? ' right here' : ' in ' + esc(fmt(h.aheadM))) + esc(when) + esc(conf) + '. Keep going with care; look for another way around.';
      els.nbAlert.className = "nb-alert hazard";
    } else if (v && (v.offRoute || v.joining)) {
      els.nbAlert.className = "nb-alert " + (v.joining ? "join" : "off");
    }
    els.nbAlert.hidden = !alertHtml;
    els.nbAlert.innerHTML = alertHtml;

    // ETA bar
    var remainingM = v ? v.remainingM : r.totalM;
    var eta = api.etaMath(remainingM, r, Date.now());
    els.etaTime.textContent = String(Math.max(1, Math.round(eta.sec / 60)));
    els.etaDist.textContent = fmt(remainingM);
    els.etaClock.textContent = new Date(eta.arriveAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    els.etaMode.textContent = (r.profile === "driving" ? "Drive" : "Walk") + (r.straight ? " · est." : "");
    els.etaMode.className = "eta-mode " + (r.profile === "driving" ? "drive" : "walk");
    renderChips();
    if (S.expanded) renderSteps();
    S.dirty = true;
  }

  function renderChips() {
    if (!S) return;
    var chips = [];
    if (S.route.straight) chips.push('<span class="nb-chip warn">Straight-line guide (no road route cached)</span>');
    if (!S.verified) chips.push('<span class="nb-chip warn">' + esc(UNVERIFIED) + "</span>");
    if (S.sim) chips.push('<span class="nb-chip sim">Simulated</span>');
    els.nbChips.innerHTML = chips.join("");
  }

  function renderSteps() {
    var r = S.route, v = S.view, cur = v ? v.curIdx : 0, u = S.units;
    if (r.straight) { els.etaSteps.innerHTML = '<p class="mini">No road steps cached for this trip. Following a straight line to ' + esc(r.destName || "the destination") + ".</p>"; return; }
    els.etaSteps.innerHTML = r.steps.map(function (s, i) {
      var cls = i <= cur && v ? "done" : (v && i === v.nextIdx ? "next" : "");
      return '<div class="es-row ' + cls + '">' + api.iconSvg(s.icon, 22, "es-ico") + '<span class="es-t">' + esc(s.text) + '</span><span class="es-d">' + (s.type === "arrive" ? "" : esc(api.fmtNavDist(s.distanceM, u))) + "</span></div>";
    }).join("");
  }

  function showArrived() {
    if (!els.navArrived.hidden) return;
    var r = S.route;
    els.navArrived.hidden = false;
    els.navArrived.innerHTML =
      '<div class="arr-card"><div class="arr-ico">' + api.iconSvg("arrive", 40) + "</div>" +
      "<h3>You have arrived</h3><p>" + esc(r.destName || "Destination") + "</p>" +
      (S.verified ? "" : '<p class="arr-warn">' + esc(UNVERIFIED) + ".</p>") +
      (S.sim ? '<p class="mini">Simulated drive finished.</p>' : "") +
      '<button type="button" class="btn btn-primary btn-block" data-act="done">Done</button></div>';
  }

  /* ---- canvas map ---- */
  var tileList = null;
  function tiles() {
    if (!tileList) tileList = Array.from(host.tileKeys).map(function (k) { var p = k.split("/").map(Number); return { z: p[0], x: p[1], y: p[2] }; }).sort(function (a, b) { return a.z - b.z; });
    return tileList;
  }
  function sizeCanvas() {
    var c = els.navCanvas, r = c.getBoundingClientRect(), d = Math.max(1, root.devicePixelRatio || 1);
    S.w = r.width; S.h = r.height;
    c.width = Math.round(r.width * d); c.height = Math.round(r.height * d);
    S.dpr = d;
  }

  function draw() {
    var c = els.navCanvas, ctx = c.getContext("2d");
    var w = S.w, h = S.h, d = S.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.fillStyle = "#0A0A0B";
    ctx.fillRect(0, 0, w, h);
    var lat = S.disp.lat, lon = S.disp.lon;
    var pxPerM = S.route.profile === "driving" ? 0.22 : 0.5;
    var Wd = pxPerM * EARTH_M * Math.cos(lat * RAD);
    var wx = function (lo) { return ((lo + 180) / 360) * Wd; };
    var wy = function (la) { var sn = Math.sin(la * RAD); return (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * Wd; };
    var cx = wx(lon), cy = wy(lat), hd = S.camHeading || 0;
    var py = h * 0.68, pxs = w / 2;
    ctx.save();
    ctx.translate(pxs, py);
    ctx.rotate(-hd * RAD);
    ctx.translate(-cx, -cy);

    // tiles (coarse -> fine, from the same-origin cached pack)
    var reach = Math.hypot(w, h) * 0.75;
    tiles().forEach(function (t) {
      var scale = Wd / (256 * (1 << t.z)), s = 256 * scale;
      var tx = t.x * s, ty = t.y * s;
      if (Math.abs(tx + s / 2 - cx) > reach + s * 0.71 || Math.abs(ty + s / 2 - cy) > reach + s * 0.71) return;
      var img = host.tileImg(t.z, t.x, t.y);
      if (img) ctx.drawImage(img, tx - 0.5, ty - 0.5, s + 1, s + 1);
    });

    var coords = S.route.coords;
    if (!S.route.straight) {
      var along = S.view ? S.view.progress : 0;
      var P = pointAtAlong(S.route, along);
      var done = [[wx(coords[0][0]), wy(coords[0][1])]];
      for (var i = 1; i <= P.seg; i++) done.push([wx(coords[i][0]), wy(coords[i][1])]);
      done.push([wx(P.lon), wy(P.lat)]);
      var rest = [[wx(P.lon), wy(P.lat)]];
      for (var j = P.seg + 1; j < coords.length; j++) rest.push([wx(coords[j][0]), wy(coords[j][1])]);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      stroke(ctx, done, "rgba(255,255,255,0.42)", 14);
      stroke(ctx, done, "rgba(120,150,200,0.55)", 9);
      stroke(ctx, rest, "#FFFFFF", 15);
      stroke(ctx, rest, "#1A73E8", 10);
    } else {
      ctx.setLineDash([2, 14]); ctx.lineCap = "round";
      stroke(ctx, [[cx, cy], [wx(S.route.dest.lon), wy(S.route.dest.lat)]], "#FFFFFF", 7);
      ctx.setLineDash([]);
    }

    // hazard markers on/near the route (upright)
    (S.markers || []).forEach(function (m) {
      var X = wx(m.lon), Y = wy(m.lat);
      if (Math.hypot(X - cx, Y - cy) > reach * 1.2) return;
      ctx.save(); ctx.translate(X, Y); ctx.rotate(hd * RAD);
      ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(14, 11); ctx.lineTo(-14, 11); ctx.closePath();
      ctx.fillStyle = "#F0A34E"; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.stroke();
      ctx.fillStyle = "#1a1005"; ctx.font = "800 15px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("!", 0, 3);
      ctx.restore();
    });

    // destination pin (upright)
    var DX = wx(S.route.dest.lon), DY = wy(S.route.dest.lat);
    ctx.save(); ctx.translate(DX, DY); ctx.rotate(hd * RAD);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.bezierCurveTo(-18, -20, -16, -40, 0, -40); ctx.bezierCurveTo(16, -40, 18, -20, 0, 0);
    ctx.fillStyle = "#EA4335"; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, -26, 6, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
    ctx.restore();
    ctx.restore();

    // location puck at fixed screen position, heading cone relative to camera
    var devH = S.compass != null && !(S.sim) ? S.compass : (S.course != null ? S.course : hd);
    var rel = (devH - hd) * RAD;
    ctx.save();
    ctx.translate(pxs, py);
    ctx.rotate(rel);
    var grad = ctx.createRadialGradient(0, 0, 4, 0, 0, 62);
    grad.addColorStop(0, "rgba(26,115,232,0.55)"); grad.addColorStop(1, "rgba(26,115,232,0)");
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 62, -Math.PI / 2 - 0.52, -Math.PI / 2 + 0.52); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.arc(pxs, py, 14, 0, Math.PI * 2); ctx.fillStyle = "rgba(26,115,232,0.22)"; ctx.fill();
    ctx.beginPath(); ctx.arc(pxs, py, 10.5, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 6; ctx.fill(); ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.arc(pxs, py, 7.5, 0, Math.PI * 2); ctx.fillStyle = "#1A73E8"; ctx.fill();
  }
  function stroke(ctx, pts, color, width) {
    if (pts.length < 2) return;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  }

  function frame(ts) {
    if (!S || !S.open) return;
    S.raf = requestAnimationFrame(frame);
    if (document.hidden) return;
    var dt = S.lastTs ? (ts - S.lastTs) / 1000 : 0.033;
    if (S.lastTs && ts - S.lastTs < 32) return; // ~30 fps cap
    S.lastTs = ts;
    // camera position: ease toward the latest fix (jump when reduced-motion)
    if (S.target) {
      if (reduced()) S.disp = { lat: S.target.lat, lon: S.target.lon };
      else {
        var k = 1 - Math.exp(-dt / 0.35);
        S.disp = { lat: S.disp.lat + (S.target.lat - S.disp.lat) * k, lon: S.disp.lon + (S.target.lon - S.disp.lon) * k };
      }
    }
    // camera heading: course when moving, else compass, else last course, else the route's own direction
    var want = null;
    var moving = S.fix && (S.fix.speed || 0) >= 1.5;
    if (S.sim && S.fix && S.fix.heading != null) want = S.fix.heading;
    else if (moving && S.course != null) want = S.course;
    else if (S.compass != null) want = S.compass;
    else if (S.course != null) want = S.course;
    else if (S.view && S.view.rejoin && (S.view.joining || S.view.offRoute)) want = S.view.rejoin.bearing; // no heading source: point the map at the way back
    else if (S.view && S.view.segBearing != null) want = S.view.segBearing;
    else want = pointAtAlong(S.route, 0).bearing;
    S.camHeading = reduced() || S.camHeading == null ? want : lerpAngle(S.camHeading, want, 1 - Math.exp(-dt / 0.4));
    // guide arrows (off-route / straight-line) stay relative to the live camera heading
    if (S.guideMode && S.view) {
      var g = S.view.straight ? S.view.guideBearing : (S.view.rejoin ? S.view.rejoin.bearing : null);
      var svg = els.nbIcon.firstElementChild;
      if (g != null && svg && svg.classList.contains("nb-guide")) svg.style.transform = "rotate(" + Math.round(g - S.camHeading) + "deg)";
    }
    if (!S.disp) return;
    draw();
  }

  /* ---- public: start / end ---- */
  api.start = function (opts) {
    if (!host) return;
    buildLayer();
    if (S && S.open) api.end(true);
    var res = opts.res;
    var route = opts.route ? api.normalizeRoute(opts.route) : null;
    var me = host.myLoc();
    if (!route) route = api.straightRoute(me, { lat: res.lat, lon: res.lon }, res.name);
    else if (!route.destName) route.destName = res.name;
    var verified = res.status === "open" && (res.confidence || 0) >= 0.5;
    var units = lsGet("skywatch.nav.units") || api.defaultUnits(navigator.language);
    S = {
      open: true, res: res, route: route, verified: verified, units: units, muted: lsGet("skywatch.nav.muted") === "1",
      engine: api.createEngine(route, { snap: host.snapToPolyline }),
      view: null, fix: null, course: null, compass: null, target: null, disp: null, camHeading: null,
      sim: null, expanded: false, arrived: false, markers: [], raf: 0, lastTs: 0, watch: null, wake: null, gpsErr: null, dpr: 1, w: 0, h: 0
    };
    // before any fix, frame the route start (or the straight line start)
    var start = pointAtAlong(route, 0);
    S.target = { lat: start.lat, lon: start.lon };
    S.disp = { lat: start.lat, lon: start.lon };
    S.camHeading = start.bearing;
    api.active = true;
    layer.hidden = false;
    document.getElementById("phone") && document.getElementById("phone").classList.add("nav-on");
    els.navArrived.hidden = true; els.navArrived.innerHTML = "";
    els.etaSim.hidden = true; els.navNoGps.hidden = true;
    els.etaSteps.hidden = true; els.etaHandle.setAttribute("aria-expanded", "false"); els.etaBar.classList.remove("open");
    toggleMenu(false);
    sizeCanvas();
    root.addEventListener("resize", onResize);
    refreshUi();
    startCompass();
    startGps();
    acquireWake();
    S.raf = requestAnimationFrame(frame);
    if (host.haptic) host.haptic(10);
    if (opts.simulate) startSim();
  };
  function onResize() { if (S && S.open) sizeCanvas(); }

  api.end = function (silent) {
    if (!S) return;
    S.open = false;
    if (S.sim) { clearInterval(S.sim.timer); S.sim = null; }
    stopGps(); stopCompass(); releaseWake();
    cancelAnimationFrame(S.raf);
    root.removeEventListener("resize", onResize);
    try { if (root.speechSynthesis) root.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    layer.hidden = true;
    api.active = false;
    var ph = document.getElementById("phone");
    if (ph) ph.classList.remove("nav-on");
    if (!silent && host.toast) host.toast("Navigation ended.", "ok");
    if (!silent && host.afterEnd) host.afterEnd();
  };

  api._debug = function () { return S; };
})();
