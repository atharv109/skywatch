/**
 * Skywatch on-device damage check - UI/controller (classic script, loaded by app.html before app.js).
 *
 *   photo attached in the Mesh composer -> SkyVision.analyze(photo)
 *     -> (first time) consent sheet, lazy-load worker + ~86 MB MobileCLIP-S1 vision tower w/ progress
 *     -> zero-shot rank vs precomputed label embeddings (vision-core.js, pure)
 *     -> confirm sheet "Looks like: Bridge damaged 87% - Report?"
 *     -> mesh hazard fact (queuePacket w/ hazard={kind,lat,lon,confidence,label}) + map marker
 *   Fails safe: no model / offline-uncached / low confidence -> manual kind chooser; the photo
 *   still rides the existing flow so the server xAI photovision can check it after sync.
 *
 * Map layer: state.hazardMarkers (array, persisted in localStorage "skywatch.hazardMarkers",
 * same store family as the pending-photo markers). Directions reads it via hazardMarkersAll().
 * Host wiring (app.js boot): SkyVision.attach({ state, toast, haptic, openSheet, closeSheet, myLoc, esc,
 *   redraw, stashPhoto, queueHazard, afterReport }). Accuracy is zero-shot and UNVALIDATED.
 */
(function () {
  "use strict";
  var LS_MARKERS = "skywatch.hazardMarkers";
  var LS_READY = "skywatch.vision.ready"; // weights fully cached once -> skip the consent sheet
  var MODEL_MB = 86;
  var host = null, worker = null, loadP = null, coreP = null, labelsP = null, seq = 0;
  var pending = {}; // classify id -> {resolve,reject}
  var hitCache = [];

  function lsGet(k, d) { try { var r = localStorage.getItem(k); return r ? JSON.parse(r) : d; } catch (_e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_e) { /* session only */ } }
  function core() { return coreP || (coreP = import("./vision-core.js")); }
  function labels() {
    return labelsP || (labelsP = fetch("vision-labels.json").then(function (r) { if (!r.ok) throw new Error("labels"); return r.json(); }));
  }

  var KIND = {
    flood:        { color: "#4DA3FF", name: "Flooded road" },
    blocked:      { color: "#FF6B5E", name: "Road blocked" },
    "road-damage":{ color: "#F0A34E", name: "Road damaged" },
    bridge:       { color: "#FF4D8D", name: "Bridge damaged" },
    landslide:    { color: "#B08968", name: "Landslide" },
    "power-line": { color: "#F5D547", name: "Downed power line" },
    fire:         { color: "#FF7A1A", name: "Fire / smoke" },
  };
  function kcolor(k) { return (KIND[k] || { color: "#A494F2" }).color; }

  /* ---- styles (self-contained; app.css is shared with other agents) ---- */
  function injectStyles() {
    if (document.getElementById("vision-css")) return;
    var s = document.createElement("style");
    s.id = "vision-css";
    s.textContent =
      ".vz-bar{height:8px;border-radius:4px;background:rgba(255,255,255,.12);overflow:hidden;margin:12px 0 6px}" +
      ".vz-bar>i{display:block;height:100%;width:0;background:#42CE93;transition:width .2s}" +
      ".vz-big{font-size:19px;font-weight:700;margin:6px 0 2px}" +
      ".vz-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}";
    document.head.appendChild(s);
  }

  /* ---- markers ---- */
  function markers() { return host && Array.isArray(host.state.hazardMarkers) ? host.state.hazardMarkers : []; }
  function saveMarkers() { lsSet(LS_MARKERS, host.state.hazardMarkers); }

  function ago(ts) {
    var m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago";
  }

  /** canvas layer: per-kind glyph in a colored disc. Called from drawMap with the projection fns. */
  function drawMarkers(ctx, px, py, zoom) {
    hitCache = [];
    markers().forEach(function (m) {
      var X = px(m.lon), Y = py(m.lat), R = 11;
      hitCache.push({ x: X, y: Y, r: R + 6, m: m });
      var col = kcolor(m.kind);
      ctx.save();
      ctx.beginPath(); ctx.arc(X, Y, R + 3, 0, Math.PI * 2); ctx.fillStyle = "rgba(13,13,15,0.85)"; ctx.fill();
      ctx.beginPath(); ctx.arc(X, Y, R, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = "#111114"; ctx.fillStyle = "#111114"; ctx.lineWidth = 1.8; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath();
      switch (m.kind) {
        case "flood": // waves
          ctx.moveTo(X - 6, Y - 2); ctx.quadraticCurveTo(X - 3, Y - 5, X, Y - 2); ctx.quadraticCurveTo(X + 3, Y + 1, X + 6, Y - 2);
          ctx.moveTo(X - 6, Y + 3); ctx.quadraticCurveTo(X - 3, Y, X, Y + 3); ctx.quadraticCurveTo(X + 3, Y + 6, X + 6, Y + 3); break;
        case "blocked": // no-entry bar
          ctx.moveTo(X - 6, Y); ctx.lineTo(X + 6, Y); ctx.lineWidth = 3.4; break;
        case "road-damage": // crack zigzag
          ctx.moveTo(X - 6, Y - 5); ctx.lineTo(X - 1, Y - 1); ctx.lineTo(X - 3, Y + 2); ctx.lineTo(X + 6, Y + 6); break;
        case "bridge": // arch with a gap
          ctx.moveTo(X - 7, Y + 4); ctx.quadraticCurveTo(X - 5, Y - 6, X - 1, Y - 4);
          ctx.moveTo(X + 1, Y - 4); ctx.quadraticCurveTo(X + 5, Y - 6, X + 7, Y + 4); break;
        case "landslide": // slope with rocks
          ctx.moveTo(X - 7, Y - 4); ctx.lineTo(X + 7, Y + 5); ctx.moveTo(X - 2, Y + 4); ctx.arc(X - 3, Y + 4, 1.3, 0, 6.3); ctx.moveTo(X + 4, Y - 2); ctx.arc(X + 3, Y - 2, 1.3, 0, 6.3); break;
        case "power-line": // bolt
          ctx.moveTo(X + 2, Y - 7); ctx.lineTo(X - 4, Y + 1); ctx.lineTo(X, Y + 1); ctx.lineTo(X - 2, Y + 7); ctx.lineTo(X + 4, Y - 2); ctx.lineTo(X, Y - 2); ctx.closePath(); break;
        default: // fire: flame
          ctx.moveTo(X, Y - 7); ctx.quadraticCurveTo(X + 7, Y, X, Y + 6); ctx.quadraticCurveTo(X - 7, Y, X, Y - 7);
      }
      ctx.stroke();
      if (zoom > 0.9) {
        ctx.font = "700 9px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.fillStyle = "#fff";
        ctx.fillText(Math.round(m.confidence * 100) + "%", X, Y + R + 12);
      }
      ctx.restore();
    });
  }

  function hitMarker(X, Y) {
    for (var i = hitCache.length - 1; i >= 0; i--) {
      var h = hitCache[i];
      if (Math.hypot(h.x - X, h.y - Y) <= h.r) return h.m;
    }
    return null;
  }

  function openMarkerSheet(m) {
    var esc = host.esc, k = KIND[m.kind] || { name: m.kind };
    host.openSheet(
      '<div><div class="chips"><span class="chip chip-mono" style="border-color:' + kcolor(m.kind) + '">' + esc(k.name) + "</span>" +
      '<span class="chip chip-n chip-mono">' + Math.round(m.confidence * 100) + "% " + (m.source === "manual" ? "(reported by you)" : "on-device AI") + "</span></div>" +
      '<div class="vz-big">' + esc(m.label) + "</div>" +
      '<p class="mini dim">' + esc(ago(m.ts)) + " - " + m.lat.toFixed(4) + ", " + m.lon.toFixed(4) +
      (m.count > 1 ? " - " + m.count + " reports merged" : "") + "</p>" +
      '<p class="mini dim">Zero-shot AI guess from a photo - not verified. Routes passing within 60 m are warned.</p>' +
      '<div class="vz-row"><button class="btn btn-block" id="vzDel">Remove this marker</button></div></div>',
      function (sheet) {
        var b = sheet.querySelector("#vzDel");
        if (b) b.addEventListener("click", function () {
          host.state.hazardMarkers = markers().filter(function (x) { return x.id !== m.id; });
          saveMarkers(); host.closeSheet(); host.redraw();
        });
      }, "sheet-detail");
  }

  /* ---- worker / model ---- */
  function spawn(onProgress) {
    if (loadP) return loadP;
    loadP = new Promise(function (resolve, reject) {
      var files = {};
      try { worker = new Worker("vision-worker.js", { type: "module" }); } catch (e) { loadP = null; reject(e); return; }
      var fail = function (m) { try { worker.terminate(); } catch (_e) { /* gone */ } worker = null; loadP = null; reject(new Error(m)); };
      worker.onerror = function (ev) { fail((ev && ev.message) || "worker failed (offline and not cached yet?)"); };
      worker.onmessage = function (ev) {
        var d = ev.data || {};
        if (d.t === "progress") {
          files[d.file] = { l: d.loaded || 0, t: d.total || 0 };
          var l = 0, t = 0; Object.keys(files).forEach(function (f) { l += files[f].l; t += files[f].t; });
          if (onProgress && t) onProgress(l / t, l, t);
        } else if (d.t === "ready") { lsSet(LS_READY, 1); resolve(d.device); }
        else if (d.t === "embedding" && pending[d.id]) { pending[d.id].resolve(d.data); delete pending[d.id]; }
        else if (d.t === "error") {
          if (d.id != null && pending[d.id]) { pending[d.id].reject(new Error(d.message)); delete pending[d.id]; }
          else fail(d.message);
        }
      };
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_e) { /* best effort */ }
      worker.postMessage({ t: "load" });
    });
    return loadP;
  }

  function classifyBlob(blob) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      worker.postMessage({ t: "classify", id: id, blob: blob });
    });
  }

  function dataUrlToBlob(u) {
    var i = u.indexOf(","), mime = (u.slice(5, i).split(";")[0]) || "image/jpeg";
    var bin = atob(u.slice(i + 1)), a = new Uint8Array(bin.length);
    for (var n = 0; n < bin.length; n++) a[n] = bin.charCodeAt(n);
    return new Blob([a], { type: mime });
  }

  /* ---- confirm flow ---- */
  function manualChooser(photo, note) {
    var esc = host.esc;
    host.openSheet(
      "<div><b>" + esc(note) + "</b>" +
      '<p class="mini dim" style="margin-top:6px">Pick what the photo shows, or skip - the photo still sends with your message and the Skywatch core checks it after sync.</p>' +
      '<div class="vz-row">' + Object.keys(KIND).map(function (k) {
        return '<button class="chip chip-n" data-vz-kind="' + k + '" style="border-color:' + kcolor(k) + '">' + esc(KIND[k].name) + "</button>";
      }).join("") + "</div>" +
      '<div class="vz-row"><button class="btn btn-block" data-close>Skip</button></div></div>',
      function (sheet) {
        sheet.querySelectorAll("[data-vz-kind]").forEach(function (b) {
          b.addEventListener("click", function () {
            var kind = b.getAttribute("data-vz-kind");
            report(photo, { kind: kind, label: KIND[kind].name, confidence: 1, source: "manual" });
          });
        });
      }, "sheet-detail");
  }

  function report(photo, r) {
    core().then(function (c) {
      var loc = host.myLoc();
      var res = { kind: r.kind, label: r.label, confidence: r.confidence, lat: +loc.lat, lon: +loc.lon, ts: Date.now() };
      var pl = c.buildHazardPayload(res, photo && photo.ref);
      if (photo) host.stashPhoto(photo.ref, photo.data, pl.label);
      host.queueHazard(pl);
      var merged = c.mergeMarker(markers(), Object.assign({ source: r.source }, res));
      host.state.hazardMarkers = merged;
      saveMarkers();
      host.closeSheet();
      host.afterReport();
      host.redraw();
      host.haptic(10);
      host.toast("Hazard queued to the mesh - " + res.label + ".", "mesh");
    });
  }

  function showResult(photo, ranked, c) {
    var r = c.decide(ranked, host.myLoc(), Date.now());
    var esc = host.esc;
    if (!r) { manualChooser(photo, "No hazard recognised with confidence"); return; }
    host.openSheet(
      '<div><div class="chips"><span class="chip chip-ok">on-device AI</span><span class="chip chip-n">offline-capable</span></div>' +
      '<div class="vz-big">' + esc(c.confirmText(r)) + "</div>" +
      '<p class="mini dim">Report to the mesh and pin it on the map?</p>' +
      '<div class="vz-row"><button class="btn btn-ok btn-block" id="vzYes">Report</button>' +
      '<button class="btn btn-block" id="vzNo">Not right - choose</button></div>' +
      '<p class="mini dim" style="margin-top:8px">Zero-shot guess, not verified - runner-up: ' + esc(ranked[1].label) + " " + Math.round(ranked[1].score * 100) + "%.</p></div>",
      function (sheet) {
        sheet.querySelector("#vzYes").addEventListener("click", function () { report(photo, r); });
        sheet.querySelector("#vzNo").addEventListener("click", function () { manualChooser(photo, "Choose what the photo shows"); });
      }, "sheet-detail");
  }

  function runModel(photo) {
    host.openSheet(
      '<div><b>Checking the photo on this phone</b><div class="vz-bar"><i id="vzProg"></i></div><p class="mini dim" id="vzMsg">Starting...</p></div>',
      null, "sheet-detail");
    var prog = function (f, l, t) {
      var bar = document.getElementById("vzProg"), msg = document.getElementById("vzMsg");
      if (bar) bar.style.width = Math.round(f * 100) + "%";
      if (msg) msg.textContent = "Downloading model " + Math.round(l / 1048576) + " / " + Math.round(t / 1048576) + " MB (one time)";
    };
    Promise.all([core(), labels(), spawn(prog)]).then(function (a) {
      var msg = document.getElementById("vzMsg"); if (msg) msg.textContent = "Analysing...";
      return classifyBlob(dataUrlToBlob(photo.data)).then(function (emb) {
        showResult(photo, a[0].rankLabels(emb, a[1].embeddings), a[0]);
      });
    }).catch(function (err) {
      try { console.warn("vision: on-device model unavailable", err); } catch (_e) { /* no console */ }
      manualChooser(photo, "On-device check unavailable " + (navigator.onLine === false ? "(offline, model not downloaded yet)" : "on this phone"));
    });
  }

  /** entry point: a photo was attached in the Mesh composer */
  function analyze(photo) {
    if (!host || !photo || !photo.data) return;
    if (lsGet(LS_READY, 0)) { runModel(photo); return; }
    host.openSheet(
      '<div><b>Check this photo for damage on your phone?</b>' +
      '<p class="mini dim" style="margin-top:6px">A small AI model (' + MODEL_MB + ' MB, downloaded once, then works offline) can spot flooded or blocked roads, damaged bridges, landslides, downed lines and fire. The photo never leaves your phone for this check.</p>' +
      '<div class="vz-row"><button class="btn btn-ok btn-block" id="vzGo">Download and check</button>' +
      '<button class="btn btn-block" id="vzManual">Choose manually</button></div></div>',
      function (sheet) {
        sheet.querySelector("#vzGo").addEventListener("click", function () { runModel(photo); });
        sheet.querySelector("#vzManual").addEventListener("click", function () { manualChooser(photo, "Choose what the photo shows"); });
      }, "sheet-detail");
  }

  function attach(h) {
    host = h;
    injectStyles();
    host.state.hazardMarkers = lsGet(LS_MARKERS, []);
    if (!Array.isArray(host.state.hazardMarkers)) host.state.hazardMarkers = [];
    core(); // tiny; warm it so merge/report never waits
  }

  window.SkyVision = { attach: attach, analyze: analyze, drawMarkers: drawMarkers, hitMarker: hitMarker, openMarkerSheet: openMarkerSheet, KIND: KIND };
})();
