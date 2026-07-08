/* TrueScale — compare the real size of places by dragging them across the lying Mercator map.
   Leaflet for the slippy map, Turf for honest geodesy. No ads, no trackers. */
(function () {
  "use strict";

  // ---- constants -----------------------------------------------------------
  var EARTH_LAND_KM2 = 148940000;          // total land area, km²
  var KM2_TO_MI2 = 0.386102159;
  var US_ADMIN = "United States of America"; // only this country's admin-1 shapes are indexed
  var REPO = "https://github.com/mapzimus/maxwellhowegis/tree/main/truescale";
  var DATA = {
    countries: "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_admin_0_countries.geojson",
    admin1: "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_admin_1_states_provinces.geojson"
  };
  var PALETTE = ["#ffc24b","#56c596","#6ca8ff","#ff7d7d","#c08bff","#4fd0e0","#ff9f4b","#9be15d","#ff79c6","#5bd6b0"];
  // Curated "wow" comparisons — both shapes dropped side-by-side on the equator (zero Mercator
  // distortion) so the true-size shock lands the instant you click. [name, lat, lng].
  var PRESETS = [
    { label: "Greenland vs Australia", members: [["Greenland", 0, -52], ["Australia", 0, 12]] },
    { label: "Greenland vs India",     members: [["Greenland", 0, -34], ["India", 0, 30]] },
    { label: "Canada vs Brazil",       members: [["Canada", 0, -58], ["Brazil", 0, 4]] }
  ];

  // ---- state ---------------------------------------------------------------
  var map, pieces = [], selected = null, recIndex = new Map(), recList = [], colorTick = 0;
  var restoring = false;

  // ---- dom -----------------------------------------------------------------
  var $ = function (s) { return document.querySelector(s); };
  var searchEl = $("#search"), resultsEl = $("#results"), readoutEl = $("#readout"),
      piecesEl = $("#pieces"), countEl = $("#count"), shareBtn = $("#shareBtn"),
      clearBtn = $("#clearBtn"), compareField = $("#compareField"), compareTo = $("#compareTo"),
      compareLine = $("#compareLine");

  // ---- map setup -----------------------------------------------------------
  function initMap() {
    map = L.map("map", { worldCopyJump: true, minZoom: 1, zoomControl: true, maxBoundsViscosity: 0.6 })
            .setView([25, 0], 2);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      subdomains: "abcd", maxZoom: 12, attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(map);
  }

  // ---- data load -----------------------------------------------------------
  function recName(f) {
    var p = f.properties || {};
    return { country: p.NAME || p.ADMIN || p.SOVEREIGNT || "Unknown" };
  }
  function buildIndex(countries, admin1) {
    countries.features.forEach(function (f) {
      var p = f.properties || {}, name = p.NAME || p.ADMIN || p.SOVEREIGNT;
      if (!name) return;
      addRec("c::" + name, name, p.ADMIN && p.ADMIN !== name ? p.ADMIN : "", "Country", f);
    });
    (admin1.features || []).forEach(function (f) {
      var p = f.properties || {}, name = p.name || p.name_en || p.gn_name;
      if (!name) return;
      var admin = p.admin || "";
      // Only US states/territories come in as sub-national shapes; every other place
      // (Russia, China, etc.) stays whole as a country. Otherwise searching "Russia"
      // buries the country under dozens of its oblasts.
      if (admin !== US_ADMIN) return;
      var kind = p.type_en || p.type || "Region";
      addRec("s::" + admin + "::" + name, name, admin, kind, f);
    });
    recList.sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  function addRec(key, name, sub, kind, feature) {
    if (recIndex.has(key)) return;
    var rec = { key: key, name: name, sub: sub, kind: kind, feature: feature,
                hay: (name + " " + sub).toLowerCase() };
    recIndex.set(key, rec); recList.push(rec);
  }

  function load() {
    readoutEl.innerHTML = '<span class="empty">Loading the world…</span>';
    Promise.all([fetchJSON(DATA.countries), fetchJSON(DATA.admin1)])
      .then(function (res) {
        buildIndex(res[0], res[1] || { features: [] });
        readoutEl.innerHTML = '<span class="empty">Search for a place, then drag it around. Watch it grow toward the poles.</span>';
        if (!restoreFromHash()) addByKey("c::Greenland");
      })
      .catch(function (err) {
        readoutEl.innerHTML = '<span class="empty">Could not load boundary data. Check your connection and reload.</span>';
        console.error(err);
      });
  }
  function fetchJSON(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status + " " + url); return r.json(); });
  }

  // ---- geometry helpers ----------------------------------------------------
  function geomToLatLngs(geom) {
    var swap = function (ring) { return ring.map(function (c) { return [c[1], c[0]]; }); };
    if (geom.type === "Polygon") return geom.coordinates.map(swap);
    return geom.coordinates.map(function (poly) { return poly.map(swap); });
  }
  function centroidOf(feature) {
    try { return turf.centroid(feature).geometry.coordinates; } // [lng,lat]
    catch (e) { return [0, 0]; }
  }
  // Rigid spherical move: re-plant every vertex by its geodesic distance + bearing from a
  // reference point. This PRESERVES true ground area (azimuthal re-stamp), unlike
  // turf.transformTranslate, which lets a shape's real area collapse as it moves poleward.
  function restamp(feature, from, to) {
    var f = JSON.parse(JSON.stringify(feature));
    (function walk(co) {
      if (typeof co[0] === "number") {
        var d = turf.distance(from, co, { units: "kilometers" });
        var b = turf.bearing(from, co);
        var p = turf.destination(to, d, b, { units: "kilometers" }).geometry.coordinates;
        co[0] = p[0]; co[1] = p[1]; return;
      }
      for (var i = 0; i < co.length; i++) walk(co[i]);
    })(f.geometry.coordinates);
    return f;
  }
  function nextColor() { return PALETTE[colorTick++ % PALETTE.length]; }

  // ---- pieces --------------------------------------------------------------
  function addByKey(key, center) {
    var rec = recIndex.get(key);
    if (!rec) return null;
    return addPiece(rec, center);
  }
  function addPiece(rec, center) {
    var feature = JSON.parse(JSON.stringify(rec.feature));
    var color = nextColor();
    var layer = L.geoJSON(feature, {
      style: { color: color, weight: 2, fillColor: color, fillOpacity: 0.45, className: "piece-path" }
    }).addTo(map);
    var poly = layer.getLayers()[0];
    var piece = { id: "p" + Date.now() + "_" + Math.round(performance.now()),
                  rec: rec, feature: feature, color: color, layer: layer, poly: poly,
                  area: turf.area(feature),
                  home: JSON.parse(JSON.stringify(feature)) };  // true location, for reset
    poly.bindTooltip(rec.name, { permanent: true, direction: "center", className: "piece-label", opacity: 0.95 });
    pieces.push(piece);
    attachDrag(piece);

    if (center) moveTo(piece, center[0], center[1]);
    select(piece);
    renderPieces();
    updateCompareOptions();
    if (!restoring) {
      if (center) map.panTo([center[0], center[1]], { animate: true });
      else map.fitBounds(layer.getBounds(), { maxZoom: 4, padding: [40, 40] });
      pushHash();
    }
    return piece;
  }
  function findRec(name, preferCountry) {
    var n = name.toLowerCase(), fallback = null;
    for (var i = 0; i < recList.length; i++) {
      if (recList[i].name.toLowerCase() === n) {
        if (!preferCountry || recList[i].kind === "Country") return recList[i];
        if (!fallback) fallback = recList[i];
      }
    }
    return fallback;
  }
  function applyPreset(idx) {
    var preset = PRESETS[idx];
    if (!preset) return;
    pieces.slice().forEach(function (p) { map.removeLayer(p.layer); });
    pieces = []; selected = null;
    restoring = true;                       // batch: no per-add fit/hash
    var added = [];
    preset.members.forEach(function (m) {
      var rec = findRec(m[0], true);
      if (!rec) return;
      var p = addPiece(rec);
      moveTo(p, m[1], m[2]);
      added.push(p);
    });
    restoring = false;
    if (added.length) {
      select(added[0]);
      var grp = L.featureGroup(added.map(function (p) { return p.layer; }));
      map.fitBounds(grp.getBounds(), { padding: [60, 60] });
      pushHash();
    }
  }

  // latitude/longitude graticule — makes Mercator's poleward stretch visible
  var gratLayer = null;
  function makeGraticule() {
    var feats = [], lat, lng, pts;
    for (lat = -75; lat <= 75; lat += 15) {
      pts = []; for (lng = -180; lng <= 180; lng += 5) pts.push([lng, lat]);
      feats.push({ type: "Feature", properties: { major: lat === 0 }, geometry: { type: "LineString", coordinates: pts } });
    }
    for (lng = -180; lng <= 180; lng += 30) {
      pts = []; for (lat = -82; lat <= 82; lat += 5) pts.push([lng, lat]);
      feats.push({ type: "Feature", properties: { major: lng === 0 }, geometry: { type: "LineString", coordinates: pts } });
    }
    return { type: "FeatureCollection", features: feats };
  }
  function toggleGraticule(on) {
    if (on) {
      if (!gratLayer) gratLayer = L.geoJSON(makeGraticule(), {
        interactive: false,
        style: function (f) { return { color: f.properties.major ? "#5b6f86" : "#3a4a5e", weight: f.properties.major ? 1.2 : 0.8, opacity: 0.7 }; }
      });
      gratLayer.addTo(map); gratLayer.bringToBack();
    } else if (gratLayer) { map.removeLayer(gratLayer); }
  }

  function removePiece(piece) {
    map.removeLayer(piece.layer);
    pieces = pieces.filter(function (p) { return p !== piece; });
    if (selected === piece) select(pieces[pieces.length - 1] || null);
    renderPieces(); updateCompareOptions(); pushHash();
  }
  function moveTo(piece, lat, lng) {
    // Re-stamping nudges the centroid slightly off-target on irregular shapes; iterate a few
    // times so it converges on the requested point (kills the share-link restore drift).
    for (var i = 0; i < 4; i++) {
      var c = centroidOf(piece.feature);
      if (Math.abs(c[1] - lat) < 0.02 && Math.abs(c[0] - lng) < 0.02) break;
      piece.feature = restamp(piece.feature, c, [lng, lat]);
    }
    redraw(piece);
  }
  function resetHome(piece) {
    piece.feature = JSON.parse(JSON.stringify(piece.home));
    redraw(piece); pushHash();
    if (!restoring) map.panTo(L.latLng(centroidOf(piece.feature)[1], centroidOf(piece.feature)[0]));
  }
  function moveBy(piece, km, bearing) {
    var c = centroidOf(piece.feature);
    var to = turf.destination(c, km, bearing, { units: "kilometers" }).geometry.coordinates;
    piece.feature = restamp(piece.feature, c, to);
    redraw(piece); pushHash();
  }

  // ---- redraw (rAF-throttled) ---------------------------------------------
  var rafPending = false, rafQueue = null;
  function redraw(piece) {
    if (selected === piece) updateReadout();   // cheap; keep numbers live every frame
    rafQueue = piece;                           // geometry repaint is rAF-batched for smoothness
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      var p = rafQueue;
      p.poly.setLatLngs(geomToLatLngs(p.feature.geometry));
      var c = centroidOf(p.feature);
      var tt = p.poly.getTooltip();
      if (tt) tt.setLatLng(L.latLng(c[1], c[0]));
    });
  }

  // ---- drag (pointer events, mouse + touch unified) ------------------------
  function attachDrag(piece) {
    var el = piece.poly.getElement();
    if (!el) return;
    el.style.touchAction = "none";
    var grab = null, snapshot = null, snapC = null;

    el.addEventListener("pointerdown", function (e) {
      if (e.button && e.button !== 0) return;
      e.preventDefault();
      select(piece);
      map.dragging.disable();
      el.classList.add("dragging");
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
      grab = map.mouseEventToLatLng(e);
      snapshot = JSON.parse(JSON.stringify(piece.feature));
      snapC = centroidOf(snapshot);
    });
    el.addEventListener("pointermove", function (e) {
      if (!grab) return;
      var cur = map.mouseEventToLatLng(e);
      var d = turf.distance([grab.lng, grab.lat], [cur.lng, cur.lat], { units: "kilometers" });
      if (d <= 0) return;
      var b = turf.bearing([grab.lng, grab.lat], [cur.lng, cur.lat]);
      var newC = turf.destination(snapC, d, b, { units: "kilometers" }).geometry.coordinates;
      piece.feature = restamp(snapshot, snapC, newC);
      redraw(piece);
    });
    var end = function (e) {
      if (!grab) return;
      grab = null; snapshot = null;
      el.classList.remove("dragging");
      try { el.releasePointerCapture(e.pointerId); } catch (x) {}
      map.dragging.enable();
      pushHash();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  // ---- selection -----------------------------------------------------------
  function select(piece) {
    selected = piece;
    pieces.forEach(function (p) {
      var on = p === piece;
      p.poly.setStyle({ weight: on ? 3.5 : 2, fillOpacity: on ? 0.6 : 0.4 });
      if (on && p.poly.bringToFront) p.poly.bringToFront();
    });
    renderPieces(); updateReadout(); updateCompareOptions();
  }

  // ---- readout -------------------------------------------------------------
  function fmt(n) { return Math.round(n).toLocaleString("en-US"); }
  function updateReadout() {
    if (!selected) {
      readoutEl.innerHTML = '<span class="empty">Select a shape to see its real area.</span>';
      compareField.hidden = true;
      return;
    }
    var km2 = selected.area / 1e6;
    var mi2 = km2 * KM2_TO_MI2;
    var share = km2 / EARTH_LAND_KM2 * 100;
    var lat = centroidOf(selected.feature)[1];
    var c = Math.cos(lat * Math.PI / 180);
    var distort = c > 0.02 ? 1 / (c * c) : 2500; // sec²(lat) area inflation on Mercator
    readoutEl.innerHTML =
      '<div class="ro-name"><span class="swatch" style="background:' + selected.color + '"></span>' +
        esc(selected.rec.name) + (selected.rec.sub ? ' <span class="ro-sub">· ' + esc(selected.rec.sub) + '</span>' : '') + '</div>' +
      '<div class="ro-area">' + fmt(km2) + ' km²</div>' +
      '<div class="ro-sub">' + fmt(mi2) + ' mi² · ' + share.toFixed(share < 1 ? 2 : 1) + '% of Earth’s land</div>' +
      '<div class="ro-distort">On this map it looks <b>' + distort.toFixed(distort < 10 ? 1 : 0) +
        '×</b> bigger than its true size.</div>';
    renderCompare();
  }

  // ---- compare -------------------------------------------------------------
  function updateCompareOptions() {
    if (!selected || pieces.length < 2) { compareField.hidden = true; return; }
    compareField.hidden = false;
    var prev = compareTo.value;
    compareTo.innerHTML = "";
    pieces.forEach(function (p) {
      if (p === selected) return;
      var o = document.createElement("option");
      o.value = p.id; o.textContent = p.rec.name;
      compareTo.appendChild(o);
    });
    if ([].some.call(compareTo.options, function (o) { return o.value === prev; })) compareTo.value = prev;
    renderCompare();
  }
  function renderCompare() {
    if (compareField.hidden || !selected) return;
    var other = pieces.filter(function (p) { return p.id === compareTo.value; })[0];
    if (!other) { compareLine.textContent = ""; return; }
    var ratio = selected.area / other.area;
    var word = ratio >= 1 ? "as big as" : "the size of";
    var n = ratio >= 1 ? ratio : 1 / ratio;
    var subj = ratio >= 1 ? selected : other;
    var obj = ratio >= 1 ? other : selected;
    compareLine.innerHTML = esc(subj.rec.name) + " is <b>" + n.toFixed(n < 10 ? 1 : 0) +
      "×</b> " + word + " " + esc(obj.rec.name) + ".";
  }
  compareTo.addEventListener("change", renderCompare);

  // ---- pieces list ---------------------------------------------------------
  function renderPieces() {
    countEl.textContent = pieces.length ? pieces.length : "";
    piecesEl.innerHTML = "";
    pieces.forEach(function (p) {
      var li = document.createElement("li");
      li.className = p === selected ? "selected" : "";
      li.tabIndex = 0;
      li.innerHTML =
        '<span class="swatch" style="background:' + p.color + '"></span>' +
        '<span class="p-name">' + esc(p.rec.name) + '</span>' +
        '<span class="p-area">' + fmt(p.area / 1e6) + ' km²</span>' +
        '<button class="p-home" title="Reset to true location" aria-label="Reset ' + esc(p.rec.name) + ' to its true location">⌂</button>' +
        '<button class="p-del" title="Remove" aria-label="Remove ' + esc(p.rec.name) + '">×</button>';
      li.addEventListener("click", function (e) {
        if (e.target.classList.contains("p-del")) { removePiece(p); return; }
        if (e.target.classList.contains("p-home")) { select(p); resetHome(p); return; }
        select(p); map.panInsideBounds && map.fitBounds(p.layer.getBounds(), { maxZoom: 4, padding: [40, 40] });
      });
      li.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(p); }
      });
      piecesEl.appendChild(li);
    });
  }

  // ---- search --------------------------------------------------------------
  var activeResult = -1, currentResults = [];
  function runSearch(q) {
    q = q.trim().toLowerCase();
    if (!q) { closeResults(); return; }
    var starts = [], contains = [];
    for (var i = 0; i < recList.length && (starts.length + contains.length) < 60; i++) {
      var r = recList[i];
      if (r.name.toLowerCase().indexOf(q) === 0) starts.push(r);
      else if (r.hay.indexOf(q) >= 0) contains.push(r);
    }
    currentResults = starts.concat(contains).slice(0, 30);
    activeResult = -1;
    renderResults();
  }
  function renderResults() {
    if (!currentResults.length) { closeResults(); return; }
    resultsEl.innerHTML = "";
    currentResults.forEach(function (r, i) {
      var li = document.createElement("li");
      li.id = "res" + i; li.setAttribute("role", "option");
      li.setAttribute("aria-selected", i === activeResult ? "true" : "false");
      li.innerHTML = '<span>' + esc(r.name) + (r.sub ? ' <span style="opacity:.6">· ' + esc(r.sub) + '</span>' : '') +
                     '</span><span class="kind">' + esc(r.kind) + '</span>';
      li.addEventListener("mousedown", function (e) { e.preventDefault(); chooseResult(r); });
      resultsEl.appendChild(li);
    });
    resultsEl.hidden = false;
    searchEl.setAttribute("aria-expanded", "true");
  }
  function closeResults() {
    resultsEl.hidden = true; resultsEl.innerHTML = "";
    searchEl.setAttribute("aria-expanded", "false");
    currentResults = []; activeResult = -1;
  }
  function chooseResult(r) {
    addByKey(r.key);
    searchEl.value = ""; closeResults(); searchEl.focus();
  }
  searchEl.addEventListener("input", function () { runSearch(searchEl.value); });
  searchEl.addEventListener("keydown", function (e) {
    if (resultsEl.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); activeResult = Math.min(activeResult + 1, currentResults.length - 1); syncActive(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeResult = Math.max(activeResult - 1, 0); syncActive(); }
    else if (e.key === "Enter") { e.preventDefault(); chooseResult(currentResults[activeResult >= 0 ? activeResult : 0]); }
    else if (e.key === "Escape") { closeResults(); }
  });
  function syncActive() {
    [].forEach.call(resultsEl.children, function (li, i) {
      li.setAttribute("aria-selected", i === activeResult ? "true" : "false");
      if (i === activeResult) li.scrollIntoView({ block: "nearest" });
    });
    searchEl.setAttribute("aria-activedescendant", activeResult >= 0 ? "res" + activeResult : "");
  }
  document.addEventListener("click", function (e) {
    if (!resultsEl.contains(e.target) && e.target !== searchEl) closeResults();
  });

  // ---- keyboard nudge / delete on selected --------------------------------
  document.addEventListener("keydown", function (e) {
    if (!selected) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    var step = e.shiftKey ? 500 : 100;
    var b = { ArrowUp: 0, ArrowRight: 90, ArrowDown: 180, ArrowLeft: 270 };
    if (e.key in b) { e.preventDefault(); moveBy(selected, step, b[e.key]); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removePiece(selected); }
  });

  // ---- share / hash state --------------------------------------------------
  function pushHash() {
    if (restoring) return;
    var tokens = pieces.map(function (p) {
      var c = centroidOf(p.feature);
      return encodeURIComponent(p.rec.key) + "@" + c[1].toFixed(3) + "," + c[0].toFixed(3);
    });
    var hash = tokens.length ? "#p=" + tokens.join("~") : "";
    history.replaceState(null, "", location.pathname + location.search + hash);
  }
  function restoreFromHash() {
    var m = /[#&]p=([^&]+)/.exec(location.hash);
    if (!m) return false;
    restoring = true;
    var ok = false;
    decodeURIComponent(m[1]).split("~").forEach(function (tok) {
      var at = tok.lastIndexOf("@");
      if (at < 0) return;
      var key = decodeURIComponent(tok.slice(0, at));
      var ll = tok.slice(at + 1).split(",");
      var lat = parseFloat(ll[0]), lng = parseFloat(ll[1]);
      var p = addByKey(key, isFinite(lat) && isFinite(lng) ? [lat, lng] : null);
      if (p) ok = true;
    });
    restoring = false;
    if (ok && pieces.length) {
      var grp = L.featureGroup(pieces.map(function (p) { return p.layer; }));
      map.fitBounds(grp.getBounds(), { padding: [50, 50] });
      pushHash();
    }
    return ok;
  }

  shareBtn.addEventListener("click", function () {
    pushHash();
    var url = location.href;
    var done = function () { var t = shareBtn.textContent; shareBtn.textContent = "Link copied ✓"; setTimeout(function () { shareBtn.textContent = t; }, 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, done);
    else { prompt("Copy this link:", url); }
  });
  clearBtn.addEventListener("click", function () {
    pieces.slice().forEach(function (p) { map.removeLayer(p.layer); });
    pieces = []; select(null); renderPieces(); updateCompareOptions(); pushHash();
  });

  // ---- about dialog --------------------------------------------------------
  var aboutDialog = $("#aboutDialog");
  $("#aboutBtn").addEventListener("click", function () { aboutDialog.hidden = false; $("#aboutClose").focus(); });
  $("#aboutClose").addEventListener("click", function () { aboutDialog.hidden = true; });
  aboutDialog.addEventListener("click", function (e) { if (e.target === aboutDialog) aboutDialog.hidden = true; });
  $("#srcLink").href = REPO;
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !aboutDialog.hidden) aboutDialog.hidden = true; });

  // ---- util ----------------------------------------------------------------
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ---- presets + graticule wiring -----------------------------------------
  var presetsEl = $("#presets"), gratToggle = $("#gratToggle");
  PRESETS.forEach(function (p, i) {
    var b = document.createElement("button");
    b.className = "chip"; b.type = "button"; b.textContent = p.label;
    b.addEventListener("click", function () { applyPreset(i); });
    presetsEl.appendChild(b);
  });
  gratToggle.addEventListener("change", function () { toggleGraticule(gratToggle.checked); });

  // ---- go ------------------------------------------------------------------
  initMap();
  load();
})();
