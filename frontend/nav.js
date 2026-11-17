// In-app driving directions to a bay, so the parking tags stay on screen the whole way.
// Pure route maths sits at the top (tested in Node); the on-screen part is NavUI.create().
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Nav = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ROUTER = "https://routing.openstreetmap.de/routed-car/route/v1/driving/";
  const OFF_ROUTE_M = 45;     // further than this from the line, twice in a row: work out a new route
  const ARRIVED_M = 35;       // close enough to call it arrived
  const REROUTE_GAP_MS = 10000;
  const ANNOUNCE_AT_M = 200;  // say the next turn this far ahead
  const NEARBY_M = 250;       // "other places near your bay"
  const CLOSE_M = 500;        // from here on, zoom in far enough to see each bay's own tag

  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  function metres(aLat, aLng, bLat, bLng) {
    const x = rad(bLng - aLng) * Math.cos(rad((aLat + bLat) / 2));
    return Math.hypot(x, rad(bLat - aLat)) * R;
  }

  // Where a point sits against a route line ([lng, lat] pairs): how far off it is, and how far along.
  function nearestOnLine(lat, lng, coords) {
    const kx = Math.cos(rad(lat)) * R * Math.PI / 180;
    const ky = R * Math.PI / 180;
    let best = { off: Infinity, along: 0 };
    let walked = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const ax = (coords[i][0] - lng) * kx, ay = (coords[i][1] - lat) * ky;
      const bx = (coords[i + 1][0] - lng) * kx, by = (coords[i + 1][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const off = Math.hypot(ax + t * dx, ay + t * dy);
      const seg = Math.sqrt(len2);
      if (off < best.off) best = { off, along: walked + t * seg };
      walked += seg;
    }
    return best;
  }

  const TURN = { left: "Turn left", right: "Turn right", "slight left": "Keep left", "slight right": "Keep right",
    "sharp left": "Turn sharp left", "sharp right": "Turn sharp right", uturn: "Make a U-turn", straight: "Go straight" };

  // OSRM step -> one plain sentence a driver can take in at a glance.
  function stepText(step) {
    const m = step.maneuver || {};
    const onto = step.name ? ` onto ${step.name}` : "";
    if (m.type === "arrive") return "You have arrived at your bay";
    if (m.type === "depart") return step.name ? `Head off along ${step.name}` : "Head off";
    if (m.type === "roundabout" || m.type === "rotary") return `At the roundabout, take exit ${m.exit || 1}${onto}`;
    if (m.type === "continue" || m.type === "new name") return step.name ? `Continue onto ${step.name}` : "Continue";
    return `${TURN[m.modifier] || "Continue"}${onto}`;
  }

  // Which arrow to draw for a step.
  function stepIcon(step) {
    const m = step.maneuver || {};
    if (m.type === "arrive") return "arrive";
    if (m.type === "roundabout" || m.type === "rotary") return "roundabout";
    const mod = m.modifier || "straight";
    if (mod.includes("left")) return mod === "slight left" ? "slight-left" : "left";
    if (mod.includes("right")) return mod === "slight right" ? "slight-right" : "right";
    if (mod === "uturn") return "uturn";
    return "straight";
  }

  const distText = (m) => (m < 50 ? "now" : m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
  const awayText = (m) => (m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);
  const minutesText = (s) => (s < 60 ? "under 1 min" : `${Math.round(s / 60)} min`);

  // Steps with the distance at which each manoeuvre happens, counted from the start of the route.
  function stepPoints(steps) {
    let at = 0;
    return steps.map((s) => { const p = { ...s, at }; at += s.distance; return p; });
  }

  // The next manoeuvre still ahead of us. Step i's manoeuvre happens at steps[i].at; the departure step is skipped.
  function nextStep(points, along) {
    for (let i = 1; i < points.length; i++) if (points[i].at > along - 15) return { step: points[i], toGo: Math.max(0, points[i].at - along) };
    return { step: points[points.length - 1], toGo: 0 };
  }

  // The browser's default voice is often a flat, robotic one. Prefer the smooth "natural" or
  // well-known female English voices that phones and computers ship with, Australian first.
  const GOOD_VOICES = [
    /natasha.*natural/i, /libby.*natural/i, /sonia.*natural/i, /aria.*natural/i, /jenny.*natural/i, /(natural|neural).*female/i,
    /google uk english female/i, /google us english/i,
    /^karen/i, /^catherine/i, /^samantha/i, /^serena/i, /^moira/i, /^tessa/i, /^martha/i,
    /natasha/i, /libby/i, /sonia/i, /aria/i, /jenny/i, /zira/i, /hazel/i, /susan/i, /female/i,
  ];
  function pickVoice(voices) {
    const english = voices.filter((v) => /^en[-_]/i.test(v.lang || ""));
    for (const pattern of GOOD_VOICES) {
      const hits = english.filter((v) => pattern.test(v.name));
      if (hits.length) return hits.find((v) => /AU/i.test(v.lang)) || hits.find((v) => /GB/i.test(v.lang)) || hits[0];
    }
    return english.find((v) => /AU/i.test(v.lang)) || english[0] || null;
  }

  async function fetchRoute(from, to, fetchImpl = fetch) {
    const url = `${ROUTER}${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson&steps=true`;
    const r = await fetchImpl(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined });
    if (!r.ok) throw new Error(`routing ${r.status}`);
    const d = await r.json();
    if (d.code !== "Ok" || !d.routes?.length) throw new Error(d.code || "no route");
    const route = d.routes[0];
    return { coords: route.geometry.coordinates, distance: route.distance, duration: route.duration, steps: stepPoints(route.legs[0].steps) };
  }

  const ARROWS = {
    straight: '<path d="M12 21V5M6 11l6-6 6 6"/>',
    left: '<path d="M18 21v-7a4 4 0 0 0-4-4H5M10 5 5 10l5 5"/>',
    right: '<path d="M6 21v-7a4 4 0 0 1 4-4h9M14 5l5 5-5 5"/>',
    "slight-left": '<path d="M16 21v-6L8 7M8 13V7h6"/>',
    "slight-right": '<path d="M8 21v-6l8-8M10 7h6v6"/>',
    uturn: '<path d="M8 21V9a4 4 0 0 1 8 0v4M12 9l4 4 4-4"/>',
    roundabout: '<circle cx="12" cy="9" r="4"/><path d="M12 13v8M16 9h4"/>',
    arrive: '<path d="M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2"/>',
  };

  // ---------- the on-screen part (browser only) ----------
  // ctx: { map, esc, flash, startWatching, getFix, nearestMatches(bay, n), openBay(bay), onNavChange(active) }
  function create(ctx) {
    const $ = (id) => document.getElementById(id);
    const MUTE_KEY = "apf_nav_mute";
    let muted = (() => { try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; } })();
    let state = null; // { bay, route, offCount, lastReroute, spoken, arrived, following }
    let wakeLock = null;

    function routeLayer() {
      const map = ctx.map;
      if (map.getSource("nav-route")) return;
      map.addSource("nav-route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      const below = map.getLayer("clusters") ? "clusters" : undefined; // the line runs under the parking tags
      map.addLayer({ id: "nav-route-casing", type: "line", source: "nav-route", layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#0b2e8a", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 6, 17, 14] } }, below);
      map.addLayer({ id: "nav-route-line", type: "line", source: "nav-route", layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#3b6ff5", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 17, 10] } }, below);
      if (state?.route) drawRoute();
    }

    function drawRoute() {
      ctx.map.getSource("nav-route")?.setData(state?.route
        ? { type: "Feature", geometry: { type: "LineString", coordinates: state.route.coords }, properties: {} }
        : { type: "FeatureCollection", features: [] });
    }

    // Voices arrive late on some browsers, so look again when the list changes.
    let voice = null;
    const loadVoice = () => { voice = pickVoice(speechSynthesis.getVoices()); };
    if ("speechSynthesis" in window) { loadVoice(); speechSynthesis.addEventListener?.("voiceschanged", loadVoice); }

    function speak(text) {
      if (muted || !("speechSynthesis" in window)) return;
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        if (!voice) loadVoice();
        if (voice) u.voice = voice;
        u.lang = voice?.lang || "en-AU";
        u.rate = 1.0;
        u.pitch = 1.05;
        speechSynthesis.speak(u);
      } catch { /* no voice on this device: the banner still shows it */ }
    }

    async function keepAwake(on) {
      try {
        if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
        if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
      } catch { wakeLock = null; } // refused (battery saver): the drive still works, the screen may dim
    }
    document.addEventListener("visibilitychange", () => { if (state && document.visibilityState === "visible") { wakeLock = null; keepAwake(true); } });

    function renderBanner(next) {
      const icon = stepIcon(next.step);
      $("nav-arrow").innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ARROWS[icon]}</svg>`;
      $("nav-dist").textContent = next.step.maneuver?.type === "arrive" ? distText(next.toGo) : distText(next.toGo);
      $("nav-text").textContent = stepText(next.step);
    }

    function renderBar(along) {
      const r = state.route;
      const left = Math.max(0, r.distance - along);
      const secs = r.distance ? r.duration * (left / r.distance) : 0;
      const arrive = new Date(Date.now() + secs * 1000).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", timeZone: "Australia/Adelaide" });
      const backups = ctx.nearestMatches(state.bay, 99).filter((x) => x.d <= NEARBY_M).length;
      $("nav-eta").textContent = `${minutesText(secs)} · ${distText(left).replace("now", "0 m")} · arrive ${arrive}`;
      $("nav-backup").textContent = backups ? `${backups} other matching ${backups === 1 ? "place" : "places"} within ${NEARBY_M} m of your bay.` : "No other matching places close to this bay.";
    }

    function follow(lat, lng, heading, speed) {
      if (!state?.following) return;
      // Far away the groups are enough; close to the bay, single tags show which ones are free or paid.
      const near = metres(lat, lng, state.bay.lat, state.bay.lng) < CLOSE_M;
      const opts = { center: [lng, lat], zoom: near ? 17 : 15.6, pitch: 45, duration: 900,
        // keep the car between the turn banner and the trip card, whatever their height right now
        padding: { top: $("nav-top").getBoundingClientRect().bottom + 20, bottom: Math.min($("nav-bottom").offsetHeight + 20, innerHeight * 0.6), left: 0, right: 0 } };
      if (heading != null && !Number.isNaN(heading) && speed > 2) opts.bearing = heading; // course-up once moving
      ctx.map.easeTo(opts);
    }

    async function plan(bay, from) {
      $("nav-text").textContent = "Finding the way...";
      $("nav-dist").textContent = "";
      const route = await fetchRoute(from, [bay.lat, bay.lng]);
      if (!state || state.bay !== bay) return;
      state.route = route;
      state.spoken = new Set();
      state.offCount = 0;
      drawRoute();
      onFix({ coords: { latitude: from[0], longitude: from[1], heading: null, speed: 0 } });
    }

    function arrive() {
      state.arrived = true;
      speak("You have arrived. If it's taken, tap Taken, next bay.");
      const others = ctx.nearestMatches(state.bay, 20).filter((x) => !state.tried.has(x.b.i)).slice(0, 3);
      $("nav-arrival").innerHTML = `
        <p class="nav-arrived">You're at your bay.</p>
        <p class="nav-sub">${others.length ? "Taken? These are the closest other places that match your filters:" : "Taken? Nothing else close matches your filters. Try fewer filters."}</p>
        <ol class="near">${others.map(({ b, d }) => `<li><button type="button" data-nav-bay="${b.i}">${ctx.pinHtml(b)}<span class="near-text"><b>${ctx.esc(ctx.describe(b).head)}</b><span>${ctx.esc(ctx.describe(b).sub)}</span></span><span class="near-d">${distText(d).replace("now", "here")}</span></button></li>`).join("")}</ol>`;
      $("nav-arrival").hidden = false;
    }

    function onFix(pos) {
      if (!state?.route) return;
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      const toBay = metres(lat, lng, state.bay.lat, state.bay.lng);
      const where = nearestOnLine(lat, lng, state.route.coords);
      if (!state.arrived && toBay <= ARRIVED_M) arrive();
      if (state.arrived) {
        renderBanner({ step: { maneuver: { type: "arrive" } }, toGo: 0 });
        renderBar(state.route.distance);
        $("nav-backup").hidden = true; // the arrival list already shows the backups
        follow(lat, lng, null, 0);
        return;
      }
      // Off the line twice in a row: ask for a fresh route from here (at most every 10 seconds).
      state.offCount = where.off > OFF_ROUTE_M ? state.offCount + 1 : 0;
      if (state.offCount >= 2 && Date.now() - state.lastReroute > REROUTE_GAP_MS) {
        state.lastReroute = Date.now();
        speak("Finding a new route");
        plan(state.bay, [lat, lng]).catch(() => ctx.flash("Couldn't find a new route. Keep going, we'll try again."));
        return;
      }
      const next = nextStep(state.route.steps, where.along);
      updateTakenButton();
      renderBanner(next);
      renderBar(where.along);
      const key = `${next.step.at}`;
      if (next.toGo <= ANNOUNCE_AT_M && !state.spoken.has(key)) {
        state.spoken.add(key);
        speak(next.toGo < 50 ? stepText(next.step) : `In ${distText(next.toGo)}, ${stepText(next.step).toLowerCase()}`);
      }
      follow(lat, lng, pos.coords.heading, pos.coords.speed || 0);
    }

    // The closest place that suits the filters and has not been tried on this trip.
    function nextBay() {
      return ctx.nearestMatches(state.bay, 40).find(({ b }) => !state.tried.has(b.i)) || null;
    }

    function updateTakenButton() {
      const next = state && nextBay();
      $("nav-taken").disabled = !next;
      $("nav-taken").textContent = next ? `Taken? Next bay, ${awayText(next.d)}` : "Taken? No other bay near";
    }

    function takeNext() {
      if (!state) return;
      const next = nextBay();
      if (!next) { ctx.flash("No other matching place close by. Try fewer filters."); return; }
      speak(`Okay. Going to the next closest bay, ${awayText(next.d).replace(" m", " metres").replace(" km", " kilometres")} away.`);
      start(next.b, state.tried);
    }

    async function start(bay, tried = new Set()) {
      const fix = ctx.getFix();
      ctx.startWatching();
      tried.add(bay.i);
      state = { bay, tried, route: null, offCount: 0, lastReroute: Date.now(), spoken: new Set(), arrived: false, following: true };
      updateTakenButton();
      $("nav-arrival").hidden = true;
      $("nav-recentre").hidden = true;
      $("nav-backup").hidden = false;
      document.body.classList.add("navigating");
      ctx.onNavChange(true, bay);
      routeLayer();
      keepAwake(true);
      $("nav-mute").setAttribute("aria-pressed", muted);
      $("nav-mute").textContent = muted ? "Voice off" : "Mute voice";
      if (!fix) {
        $("nav-text").textContent = "Waiting for your location...";
        state.waitingForFix = true;
        return;
      }
      try {
        await plan(bay, fix);
        speak(`Starting. ${stepText(state.route.steps[1] || state.route.steps[0])}`);
      } catch {
        stop();
        ctx.flash("Couldn't work out directions right now. Try Google Maps from the bay details.");
      }
    }

    function stop() {
      state = null;
      drawRoute();
      document.body.classList.remove("navigating");
      $("nav-arrival").hidden = true;
      keepAwake(false);
      if ("speechSynthesis" in window) speechSynthesis.cancel();
      ctx.map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
      ctx.onNavChange(false);
    }

    // First fix after "Drive here" without a location yet.
    function onFirstFix(pos) {
      if (!state?.waitingForFix) return;
      state.waitingForFix = false;
      plan(state.bay, [pos.coords.latitude, pos.coords.longitude])
        .then(() => speak(`Starting. ${stepText(state.route.steps[1] || state.route.steps[0])}`))
        .catch(() => { stop(); ctx.flash("Couldn't work out directions right now. Try Google Maps from the bay details."); });
    }

    $("nav-end").onclick = stop;
    $("nav-taken").onclick = takeNext;
    $("nav-mute").onclick = () => {
      muted = !muted;
      try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch { /* private mode */ }
      $("nav-mute").setAttribute("aria-pressed", muted);
      $("nav-mute").textContent = muted ? "Voice off" : "Mute voice";
      if (muted && "speechSynthesis" in window) speechSynthesis.cancel();
    };
    $("nav-recentre").onclick = () => { if (!state) return; state.following = true; $("nav-recentre").hidden = true; const f = ctx.getFix(); if (f) follow(f[0], f[1], null, 0); };
    $("nav-arrival").addEventListener("click", (e) => {
      const row = e.target.closest("[data-nav-bay]");
      if (!row) return;
      const bay = ctx.bayById(Number(row.dataset.navBay));
      start(bay, state ? state.tried : new Set());
    });
    ctx.map.on("dragstart", () => { if (state) { state.following = false; $("nav-recentre").hidden = false; } });
    ctx.map.on("style.load", routeLayer);

    return {
      start, stop, routeLayer,
      onFix(pos) { if (!state) return; if (state.waitingForFix) onFirstFix(pos); else onFix(pos); },
      get active() { return !!state; },
    };
  }

  return { metres, nearestOnLine, stepText, stepIcon, distText, stepPoints, nextStep, fetchRoute, create, pickVoice,
    OFF_ROUTE_M, ARRIVED_M };
});
