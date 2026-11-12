"use strict";

const ADELAIDE = [-34.9265, 138.6010];
const THEME_KEY = "apf_theme";
const VEHICLE_KEY = "apf_vehicle";
const BASE_KEY = "apf_base";
const REPO = "https://github.com/baomun0304/adelaide-parking-finder";
const STALE_DAYS = 3;
const STYLE_URL = "https://tiles.openfreemap.org/styles/";
const STYLES = { light: "bright", dark: "fiord" };
const ESRI = "https://services.arcgisonline.com/ArcGIS/rest/services/";
const esriTiles = (name, attribution) => ({ type: "raster", tiles: [`${ESRI}${name}/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19, attribution });
const SATELLITE = {
  version: 8,
  sources: { imagery: esriTiles("World_Imagery", "Esri, Maxar, Earthstar Geographics"), roads: esriTiles("Reference/World_Transportation", "") },
  layers: [{ id: "imagery", type: "raster", source: "imagery" }, { id: "roads", type: "raster", source: "roads" }],
};
const QUICK_NEEDS = [[0, "Any"], [60, "1 hr"], [120, "2 hr"], [240, "4 hr"], [600, "All day"]];
const WELCOME_NEEDS = [[30, "30 min"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"], [600, "All day"], [0, "Just looking"]];
const MORE_NEEDS = [[30, "30 min"], [180, "3 hr"]];
const VEHICLES = [["car", "Car"], ["moto", "Motorbike"], ["disabled", "Disability permit"]];
const LIST_SIZE = 25;
const DESKTOP = matchMedia("(min-width: 900px)");

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: the page still works */ } },
};
const dateText = (iso, opts) => new Date(iso).toLocaleDateString("en-AU", { timeZone: "Australia/Adelaide", ...opts });
const nf = new Intl.NumberFormat("en-AU");

// ---------- map and theme ----------

const systemDark = matchMedia("(prefers-color-scheme: dark)");
const activeTheme = () => store.get(THEME_KEY) || (systemDark.matches ? "dark" : "light");
let shownTheme = activeTheme();
document.documentElement.dataset.theme = shownTheme;
let satellite = store.get(BASE_KEY) === "satellite";
let tilted = false; // 3D is a way of looking, so every visit starts flat
const styleFor = () => (satellite ? SATELLITE : STYLE_URL + STYLES[shownTheme]);

// MapLibre's zoom is one lower than the 256px tile zoom the pins were tuned for, so ZOOM_SHIFT converts.
const ZOOM_SHIFT = 1;
const map = new maplibregl.Map({
  container: "map", style: styleFor(), center: [ADELAIDE[1], ADELAIDE[0]], zoom: 15 - ZOOM_SHIFT,
  minZoom: 12 - ZOOM_SHIFT, maxZoom: 18 - ZOOM_SHIFT, dragRotate: false, pitchWithRotate: false, touchPitch: false,
  attributionControl: false, fadeDuration: 0,
  pixelRatio: Math.min(devicePixelRatio || 1, 2), // a 3x phone screen would draw 2.25 times the pixels for no visible gain
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right"); // each style names its own sources
new ResizeObserver(() => map.resize()).observe($("map")); // phone toolbars and rotation change the size without a window resize
const tileZoom = () => map.getZoom() + ZOOM_SHIFT;

// What the panel and sheet cover, so "centre on this" means the visible part of the map.
function mapPadding() {
  if (DESKTOP.matches) return { left: 404, right: 70, top: 20, bottom: 20 };
  const covered = sheetKind ? sheet.offsetHeight : $("panel").offsetHeight;
  return { left: 0, right: 0, top: 80, bottom: Math.min(covered, innerHeight * 0.75) };
}
const lookAt = (lat, lng, zoom) => map.easeTo({ center: [lng, lat], zoom: zoom - ZOOM_SHIFT, duration: 600, padding: mapPadding() });

// ---- 3D buildings: extruded footprints from the same vector tiles, only while tilted
function addBuildings() {
  if (!tilted || !map.getSource("openmaptiles") || map.getLayer("apf-3d")) return;
  map.addLayer({
    id: "apf-3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 14,
    paint: {
      "fill-extrusion-color": shownTheme === "dark" ? "#4a5470" : "#d3cbbb",
      "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
      "fill-extrusion-opacity": 0.88,
    },
  }, map.getLayer("clusters") ? "clusters" : undefined); // buildings go under the parking tags
}

function setTilt(on) {
  tilted = on;
  if (on) addBuildings(); else if (map.getLayer("apf-3d")) map.removeLayer("apf-3d");
  map.easeTo({ pitch: on ? 55 : 0, duration: 600 });
  syncLayersMenu();
}
function setSatellite(on) {
  satellite = on;
  store.set(BASE_KEY, on ? "satellite" : "map");
  map.setStyle(styleFor(), { diff: false }); // a full reload fires style.load, so our layers come back
  syncLayersMenu();
}
// A new style swaps the look in place, so switching never shows a half-and-half map.
function applyTheme(theme, remember) {
  if (remember) store.set(THEME_KEY, theme);
  if (theme === shownTheme) return;
  shownTheme = theme;
  document.documentElement.dataset.theme = theme;
  if (!satellite) map.setStyle(styleFor(), { diff: false }); // a full reload fires style.load, so our layers come back
  else if (map.getLayer("clusters")) { // in satellite view the style stays, so point the layers at theme-matched pictures
    map.setLayoutProperty("clusters", "icon-image", clusterImage());
    map.setLayoutProperty("picked", "icon-image", ["concat", ["get", "img"], "|p|", shownTheme]);
  }
  syncLayersMenu();
}
systemDark.addEventListener?.("change", () => { if (!store.get(THEME_KEY)) applyTheme(activeTheme(), false); });

// ---- the map-style menu: one button instead of three
function syncLayersMenu() {
  for (const b of $("layers-menu").querySelectorAll("[data-layer]")) {
    const on = { map: !satellite, satellite, tilt: tilted, dark: shownTheme === "dark" }[b.dataset.layer];
    b.setAttribute("aria-checked", on);
  }
}
function toggleLayersMenu(open) {
  const menu = $("layers-menu");
  const show = open ?? menu.hidden;
  menu.hidden = !show;
  $("layers-btn").setAttribute("aria-expanded", show);
  if (show) { syncLayersMenu(); menu.querySelector("button").focus(); }
}
// Arrow keys move through the menu, and leaving it with Tab closes it.
$("layers-menu").addEventListener("keydown", (e) => {
  const items = [...$("layers-menu").querySelectorAll("button")];
  const at = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
  }
});
$("layers-menu").addEventListener("focusout", (e) => {
  // Only when focus really moved elsewhere: Safari does not focus buttons on tap, so a missing target means a tap inside.
  if (e.relatedTarget && !e.currentTarget.parentElement.contains(e.relatedTarget)) toggleLayersMenu(false);
});
$("layers-btn").onclick = () => toggleLayersMenu();
$("layers-menu").addEventListener("click", (e) => {
  const what = e.target.closest("[data-layer]")?.dataset.layer;
  if (what === "map") setSatellite(false);
  if (what === "satellite") setSatellite(true);
  if (what === "tilt") setTilt(!tilted);
  if (what === "dark") applyTheme(shownTheme === "dark" ? "light" : "dark", true);
});

// ---------- state ----------

let bays = [];
let matched = [];
let matchedKey = "";
let feed = null;
let loadFailed = false;
let started = false; // nothing is drawn until the visitor has had their say on the welcome sheet
const filters = { ...Logic.DEFAULT_FILTERS, vehicle: store.get(VEHICLE_KEY) || "car", allKinds: false };
if (!VEHICLES.some(([v]) => v === filters.vehicle)) filters.vehicle = "car";

const moment = () => filters.later || Logic.adelaideNow();
const isFiltering = () => Logic.isFiltering(filters);

// ---------- parking tags: drawn by the GPU as one map layer, not hundreds of page elements ----------

const KIND = { free: "free", ticket: "ticket", unrestricted: "unrestricted", disabled: "special", motorcycle: "special", residential: "special" };
const INK = { free: "#0f7a3d", ticket: "#1f4fd1", unrestricted: "#0f7a3d", special: "#4b34b0", stop: "#c42a1f" };
const SHORT = { unrestricted: "∞", disabled: "♿", motorcycle: "MC", residential: "RES", loading: "LZ", taxi: "TAXI", "no-parking": "NP" };
const pinKind = (b) => KIND[b.category] || "stop";
const pinLabel = (b) => SHORT[b.category] || Logic.stayLabel(b.max_stay);
const isUnknown = (b) => (b.category === "free" || b.category === "ticket") && !b.windows;

function pinHtml(b) {
  const kind = pinKind(b);
  return `<span class="pin pin-${kind}${isUnknown(b) ? " pin-unknown" : ""}">${esc(pinLabel(b))}${kind === "ticket" ? "<i></i>" : ""}</span>`;
}

const WORDS = {
  free: "Free time-limited bay", ticket: "Ticket bay", unrestricted: "Unrestricted bay", motorcycle: "Motorcycle bay",
  disabled: "Disabled permit bay", residential: "Residents permit bay", taxi: "Taxi rank", loading: "Loading zone", "no-parking": "No parking zone",
};

// Tag pictures are drawn on a canvas the first time the map asks for one, so they look exactly like the CSS tags.
const DPR = Math.min(devicePixelRatio || 1, 2);
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function badge(ctx, x, y, fill, text) {
  ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
  ctx.fillStyle = "#fff"; ctx.font = "900 9px Overpass, Arial, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + 0.5);
}
function drawPin(kind, label, unknown, picked) {
  const big = kind === "unrestricted";
  const font = `800 ${big ? 16 : 13}px Overpass, "Arial Narrow", Arial, sans-serif`;
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = font;
  const w = Math.max(28, Math.ceil(probe.measureText(label).width) + 14);
  const h = 22;
  const pad = 9;
  const scale = picked ? 1.25 : 1;
  const W = Math.ceil((w + pad * 2) * scale);
  const H = Math.ceil((h + pad * 2) * scale);
  const c = document.createElement("canvas");
  c.width = W * DPR; c.height = H * DPR;
  const ctx = c.getContext("2d");
  ctx.scale(DPR * scale, DPR * scale);
  const ink = INK[kind];
  if (picked) { roundRect(ctx, pad - 4, pad - 4, w + 8, h + 8, 8); ctx.fillStyle = shownTheme === "dark" ? "#f1eee6" : "#1d1c19"; ctx.fill(); }
  ctx.shadowColor = "rgba(0,0,0,.28)"; ctx.shadowBlur = 5; ctx.shadowOffsetY = 1.5;
  roundRect(ctx, pad, pad, w, h, 5);
  ctx.fillStyle = big ? ink : "#fff"; ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 2; ctx.strokeStyle = ink;
  roundRect(ctx, pad + 1, pad + 1, w - 2, h - 2, 4); ctx.stroke();
  ctx.fillStyle = big ? "#fff" : ink; ctx.font = font; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(label, pad + w / 2, pad + h / 2 + 1.5);
  if (kind === "ticket") badge(ctx, pad + w, pad, ink, "$");
  if (unknown) badge(ctx, pad + w, pad + h, "#1d1c19", "?");
  return { width: c.width, height: c.height, data: new Uint8Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer) };
}
function drawCluster(n, ticket) {
  const size = n > 99 ? 48 : 40;
  const W = size + 8;
  const c = document.createElement("canvas");
  c.width = W * DPR; c.height = W * DPR;
  const ctx = c.getContext("2d");
  ctx.scale(DPR, DPR);
  const dark = shownTheme === "dark";
  ctx.shadowColor = "rgba(0,0,0,.3)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
  ctx.beginPath(); ctx.arc(W / 2, W / 2, size / 2 - 1.5, 0, Math.PI * 2);
  ctx.fillStyle = dark ? "#20201d" : "#fffdf8"; ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 3; ctx.strokeStyle = ticket ? (dark ? "#7d9dff" : "#1f4fd1") : (dark ? "#3fbf73" : "#0f7a3d"); ctx.stroke();
  ctx.fillStyle = dark ? "#f1eee6" : "#1d1c19"; ctx.font = "800 13px Overpass, Arial, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(nf.format(n), W / 2, W / 2 + 1);
  return { width: c.width, height: c.height, data: new Uint8Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer) };
}
const BLANK = { width: 1, height: 1, data: new Uint8Array(4) };
map.on("styleimagemissing", (e) => {
  const [type, ...rest] = e.id.split("|");
  if (map.hasImage(e.id)) return;
  let img = BLANK; // icons the base style forgot: an empty picture keeps the console quiet
  if (type === "p") img = drawPin(rest[0], rest[1], rest[2] === "1", rest[3] === "p");
  if (type === "c") img = drawCluster(Number(rest[0]), rest[1] === "t");
  map.addImage(e.id, img, { pixelRatio: DPR });
});

const clusterImage = () => ["concat", "c|", ["to-string", ["get", "point_count"]], "|",
  ["case", [">", ["*", 2, ["get", "t"]], ["get", "point_count"]], "t", "f"], "|", shownTheme];
// Bays that share one spot fan out side by side once clustering stops.
const FAN = ["step", ["zoom"], ["literal", [0, 0]], 16.5,
  ["match", ["get", "slot"], -2, ["literal", [-50, 0]], -1, ["literal", [-25, 0]], 1, ["literal", [25, 0]], 2, ["literal", [50, 0]], ["literal", [0, 0]]]];
const EMPTY = { type: "FeatureCollection", features: [] };
const shownData = () => (started ? { type: "FeatureCollection", features: matched.map((b) => b.f) } : EMPTY);

let picked = null;
// Bus stops and small shops compete with the parking tags, so the base map keeps only big landmarks.
const QUIET_LAYERS = ["poi_transit", "poi_r20", "poi_r7"];

function addBayLayers() {
  for (const id of QUIET_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
  if (map.getLayer("poi_r1")) map.setFilter("poi_r1", ["all", map.getFilter("poi_r1") ?? true, ["!", ["match", ["get", "class"], ["bus", "rail"], true, false]]]);
  if (map.getSource("bays")) return;
  map.addSource("bays", {
    type: "geojson", data: shownData(), cluster: true, clusterRadius: 50, clusterMaxZoom: 16,
    clusterProperties: { t: ["+", ["get", "t"]] },
  });
  const symbol = { "icon-allow-overlap": true, "icon-ignore-placement": true };
  map.addLayer({ id: "clusters", type: "symbol", source: "bays", filter: ["has", "point_count"], layout: { ...symbol, "icon-image": clusterImage() } });
  map.addLayer({ id: "bays", type: "symbol", source: "bays", filter: ["!", ["has", "point_count"]], layout: { ...symbol, "icon-image": ["get", "img"], "icon-offset": FAN } });
  map.addLayer({
    id: "picked", type: "symbol", source: "bays", filter: ["==", ["get", "i"], picked ?? -1],
    layout: { ...symbol, "icon-image": ["concat", ["get", "img"], "|p|", shownTheme], "icon-offset": FAN },
  });
  addBuildings();
}
map.on("style.load", addBayLayers); // a new style wipes our source and layers, so put them back

function markPicked() {
  if (map.getLayer("picked")) map.setFilter("picked", ["==", ["get", "i"], picked ?? -1]);
}

// Touch is not precise, so a tap looks a few pixels around the finger.
function featureAt(point) {
  const box = [[point.x - 10, point.y - 10], [point.x + 10, point.y + 10]];
  const layers = ["picked", "bays", "clusters"].filter((l) => map.getLayer(l));
  return map.queryRenderedFeatures(box, { layers })[0];
}
map.on("click", (e) => {
  toggleLayersMenu(false);
  hideResults();
  if (sheetKind === "welcome") return; // the welcome question is answered with its own buttons
  const f = featureAt(e.point);
  if (!f) { closeSheet(); return; }
  if (f.layer.id === "clusters") {
    const [lng, lat] = f.geometry.coordinates;
    map.getSource("bays").getClusterExpansionZoom(f.properties.cluster_id)
      .then((z) => lookAt(lat, lng, Math.min(z + ZOOM_SHIFT, 18)))
      .catch(() => lookAt(lat, lng, tileZoom() + 2));
  } else {
    openBay(bays[f.properties.i]);
  }
});
map.on("mousemove", (e) => { map.getCanvas().style.cursor = featureAt(e.point) ? "pointer" : ""; });

function applyFilters() {
  const m = moment();
  const stops = filters.allKinds ? bays.filter(Logic.isStopZone) : [];
  const usable = bays.filter((b) => Logic.canPark(b, filters.vehicle));
  matched = (isFiltering() ? usable.filter((b) => Logic.matches(b, filters, m)) : usable).concat(stops);
  const key = `${started}|${matched.map((b) => b.i).join(",")}`;
  if (key !== matchedKey) { // the 30 second clock usually changes nothing, so the map is left alone
    matchedKey = key;
    map.getSource("bays")?.setData(shownData());
  }
  updateChrome();
}

// ---------- the panel: what you are looking for, always in view ----------

const activeMore = () => [filters.later, filters.vehicle !== "car", filters.sureOnly, filters.allKinds, !QUICK_NEEDS.some(([v]) => v === filters.need)].filter(Boolean).length;

function updateChrome() {
  const n = activeMore();
  $("more-badge").hidden = !n;
  $("more-badge").textContent = n;
  $("when-btn").textContent = filters.later ? Logic.momentLabel(filters.later) : "Now";
  $("when-btn").setAttribute("aria-pressed", !!filters.later);
  syncFilters();

  const free = filters.free ? " free" : "";
  const main = !bays.length ? (loadFailed ? "Couldn't load the bays" : "Loading bays...")
    : !matched.length ? "No bays match. Try fewer filters."
    : `${nf.format(matched.length)}${free} ${matched.length === 1 ? "place" : "places"} to park${filters.allKinds ? " or stop" : ""}`;
  const when = filters.later ? `For ${Logic.momentLabel(filters.later)}` : `Now, ${Logic.momentLabel(moment())}`;
  const fresh = feed?.checked ? ` &middot; data checked ${esc(dateText(feed.checked, { day: "numeric", month: "short" }))}` : "";
  const html = `<span class="status-main">${esc(main)}</span>
    <span class="status-sub">${esc(when)} (Adelaide)${fresh}</span>
    <span class="status-actions">${isFiltering() || filters.allKinds ? '<button type="button" data-act="reset">Reset</button>' : ""}${filters.later ? '<button type="button" data-act="now">Back to now</button>' : ""}</span>`;
  if ($("status").dataset.html !== html) { $("status").innerHTML = html; $("status").dataset.html = html; }
  if (sheetKind === "list") renderList();
  setPanelHeight();
}

// Map buttons in the corner sit above the panel, wherever its height ends up.
function setPanelHeight() {
  document.documentElement.style.setProperty("--panel-h", DESKTOP.matches ? "0px" : `${$("panel").offsetHeight}px`);
  if (!sheetKind) map.setPadding(mapPadding()); // the middle of the map is the middle of what you can see
}
new ResizeObserver(setPanelHeight).observe($("panel"));
DESKTOP.addEventListener?.("change", () => { setPanelHeight(); showMore(DESKTOP.matches); });

function setFilter(change) {
  Object.assign(filters, change);
  if ("vehicle" in change) store.set(VEHICLE_KEY, filters.vehicle);
  applyFilters();
}
function resetFilters() { setFilter({ ...Logic.DEFAULT_FILTERS, vehicle: "car", allKinds: false }); }

function nextQuarter() {
  const n = Logic.adelaideNow();
  return { day: n.day, mins: Math.min(Math.ceil((n.mins + 1) / 15) * 15, 1425) };
}

function optButtons(name, options, cls = "opt") {
  return options.map(([v, label]) => `<button type="button" class="${cls}" data-set="${name}" data-v="${v}" aria-pressed="false">${label}</button>`).join("");
}

function dayOptions() {
  const today = Logic.adelaideNow().day;
  return [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : dateText(Date.now() + i * 864e5, { weekday: "short", day: "numeric", month: "short" });
    return `<option value="${(today + i) % 7}">${label}</option>`;
  }).join("");
}

$("quick-need").innerHTML = optButtons("need", QUICK_NEEDS);
$("more").innerHTML = `
  <p class="more-legend">Parking later?</p>
  <div class="later">
    <label>Day <select id="when-day">${dayOptions()}</select></label>
    <label>Arrive at <input id="when-time" type="time" step="900"></label>
  </div>
  <p class="hint">Pick a day and time to see what applies then, up to a week ahead.</p>
  <fieldset class="fgroup"><legend>Other lengths</legend><div class="opts">${optButtons("need", MORE_NEEDS)}</div></fieldset>
  <fieldset class="fgroup"><legend>Your vehicle</legend><div class="opts">${optButtons("vehicle", VEHICLES)}</div>
    <p class="hint">Motorbikes and permit holders also see the normal bays they can use.</p></fieldset>
  <label class="toggle"><input type="checkbox" id="sure-only"><span>Only bays with a readable sign</span></label>
  <label class="toggle"><input type="checkbox" id="all-kinds"><span>Also show loading zones, taxi ranks and no-parking kerbs</span></label>
  <p class="hint">We have no prices, only whether a bay is free or ticketed.</p>`;

// Every filter control on the page, in the panel or a sheet, shows the same state.
function syncFilters() {
  const current = { need: String(filters.need), free: filters.free ? "1" : "0", vehicle: filters.vehicle };
  for (const b of document.querySelectorAll(".opt[data-set], .big-opt[data-set]")) {
    if (b.dataset.set === "free") b.setAttribute("aria-pressed", filters.free);
    else b.setAttribute("aria-pressed", current[b.dataset.set] === b.dataset.v);
  }
  const editing = document.activeElement?.id === "when-time" || document.activeElement?.id === "when-day";
  if (!editing) {
    const later = filters.later || nextQuarter();
    $("when-day").value = String(later.day);
    $("when-time").value = `${String(Math.floor(later.mins / 60)).padStart(2, "0")}:${String(later.mins % 60).padStart(2, "0")}`;
  }
  $("sure-only").checked = filters.sureOnly;
  $("all-kinds").checked = filters.allKinds;
  const label = !bays.length ? "Show the map" : matched.length ? `Show ${nf.format(matched.length)} places` : "No places match";
  if ($("w-go")) $("w-go").textContent = label;
}

function showMore(open) {
  $("more").hidden = !open;
  $("more-btn").setAttribute("aria-expanded", open);
  setPanelHeight();
}

function onFilterClick(e) {
  const opt = e.target.closest("[data-set]");
  if (!opt) return;
  const v = opt.dataset.v;
  const set = opt.dataset.set;
  if (set === "need") setFilter({ need: Number(v) });
  if (set === "free") setFilter({ free: !filters.free });
  if (set === "vehicle") setFilter({ vehicle: v });
}
$("panel").addEventListener("click", (e) => {
  onFilterClick(e);
  const act = e.target.closest("button")?.dataset.act;
  if (act === "reset") resetFilters();
  if (act === "now") setFilter({ later: null });
});
$("more-btn").onclick = () => showMore($("more").hidden);
$("when-btn").onclick = () => {
  if (filters.later) { setFilter({ later: null }); return; }
  setFilter({ later: nextQuarter() });
  showMore(true);
  $("when-time").focus();
};
$("list-btn").onclick = (e) => openList(e.currentTarget);
$("panel").addEventListener("change", (e) => {
  if (e.target.id === "sure-only") setFilter({ sureOnly: e.target.checked });
  if (e.target.id === "all-kinds") setFilter({ allKinds: e.target.checked });
  if (e.target.id === "when-day" || e.target.id === "when-time") {
    const [h, m] = ($("when-time").value || "00:00").split(":").map(Number);
    setFilter({ later: { day: Number($("when-day").value), mins: h * 60 + m } });
  }
});

// ---------- the sheet: one bay, the list, the key, or the welcome ----------

const sheet = $("sheet");
const sheetBody = $("sheet-body");
let sheetKind = null;
let opener = null;

function openSheet(kind, html, { focus = true, from = null, modal = false } = {}) {
  const wasOpen = !sheet.hidden && !sheet.classList.contains("closing");
  sheetKind = kind;
  sheetBody.innerHTML = html;
  delete sheetBody.dataset.html;
  sheet.setAttribute("aria-modal", modal);
  sheet.dataset.kind = kind;
  if (from) opener = from;
  if (!wasOpen) {
    sheet.hidden = false;
    sheet.classList.add("closing");
    requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.remove("closing")));
  }
  sheet.scrollTop = 0;
  if (focus) $("sheet-title")?.focus({ preventScroll: true });
}

function closeSheet() {
  if (sheet.hidden) return;
  const wasWelcome = sheetKind === "welcome";
  sheet.classList.add("closing");
  sheetKind = null;
  setTimeout(() => { if (sheet.classList.contains("closing")) { sheet.hidden = true; setPanelHeight(); } }, 300);
  picked = null;
  markPicked();
  if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  opener = null;
  if (wasWelcome) startMap();
}

sheet.querySelector(".sheet-close").onclick = closeSheet;
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("layers-menu").hidden) { toggleLayersMenu(false); $("layers-btn").focus(); } else if (!$("search-results").hidden) hideResults(); else closeSheet();
});

// Drag the handle down to close, like any phone sheet.
let dragFrom = null;
sheet.querySelector(".sheet-grip").addEventListener("pointerdown", (e) => { dragFrom = e.clientY; sheet.classList.add("dragging"); e.target.setPointerCapture(e.pointerId); });
sheet.querySelector(".sheet-grip").addEventListener("pointermove", (e) => {
  if (dragFrom != null) sheet.style.transform = `translateY(${Math.max(0, e.clientY - dragFrom)}px)`;
});
sheet.querySelector(".sheet-grip").addEventListener("pointerup", (e) => {
  const moved = dragFrom == null ? 0 : e.clientY - dragFrom;
  dragFrom = null;
  sheet.classList.remove("dragging");
  sheet.style.transform = "";
  if (moved > 70) closeSheet();
});

// ---------- a bay ----------

function plateHtml(p) {
  const cls = { free: "", ticket: "ticket", unrestricted: "unrestricted", disabled: "special",
    motorcycle: "special", residential: "special" }[p.category] ?? "stop";
  const big = { unrestricted: "&#8734;", disabled: "&#9855;", motorcycle: "MC", residential: "P",
    loading: "LZ", taxi: "TAXI", "no-parking": "NP" }[p.category] || Logic.stayLabel(p.max_stay);
  const word = { ticket: "Ticket", free: "", unrestricted: "No limit", residential: "Permit",
    loading: "Loading", taxi: "Zone", "no-parking": "", disabled: "Permit", motorcycle: "Only" }[p.category];
  const wins = (p.windows || []).slice(0, 3);
  const mixed = new Set(wins.map((w) => w[3])).size > 1; // different limits on different days: name each one
  const hours = wins.map((w) => `${mixed ? `${Logic.stayLabel(w[3])} ` : ""}${Logic.clockText(w[1])}-${Logic.clockText(w[2])}<br>${Logic.daysText(w[0])}`).join("<br>");
  return `<div class="plate ${cls}" aria-hidden="true"><div class="plate-big">${big}</div>${word ? `<div class="plate-word">${word}</div>` : ""}${hours ? `<div class="plate-hours">${hours}</div>` : ""}</div>`;
}

const isApple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function directionsHtml(b) {
  const g = `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}&travelmode=driving`;
  const a = `https://maps.apple.com/?daddr=${b.lat},${b.lng}&dirflg=d`;
  return `<div class="actions"><a class="btn primary" href="${g}" target="_blank" rel="noopener">Directions in Google Maps</a>${isApple ? `<a class="btn" href="${a}" target="_blank" rel="noopener">Apple Maps</a>` : ""}</div>`;
}

function closedLines(b) {
  const seen = new Map();
  for (const [days, start, end, label] of b.closed || []) {
    seen.set(`${label} ${Logic.daysText(days)} ${Logic.clockText(start)} to ${Logic.clockText(end)}`, true);
  }
  return [...seen.keys()].slice(0, 4).join("; ") + (seen.size > 4 ? "; more on the sign" : "");
}

// Opens a pre-filled GitHub issue, so reports cost nothing to run. Only the bay's own details go in it.
function reportUrl(b, d) {
  const body = [
    `Bay at ${b.lat.toFixed(5)}, ${b.lng.toFixed(5)} (https://www.google.com/maps/search/?api=1&query=${b.lat},${b.lng})`,
    `Type: ${WORDS[b.category]}${b.max_stay ? `, ${Logic.stayWords(b.max_stay)}` : ""}`,
    `Council sign text: ${b.hours_text || "(none)"}`,
    `The app said: ${d.head}. ${d.sub}`,
    "", "What the sign on the street says (a photo helps):", "",
  ].join("\n");
  return `${REPO}/issues/new?title=${encodeURIComponent(d.unknown ? "Missing hours for a bay" : "Wrong bay details")}&body=${encodeURIComponent(body)}`;
}

function openBay(b, from, quiet = false) {
  picked = b.i;
  markPicked();
  const m = moment();
  const d = Logic.describe(b, m, !filters.later);
  const facts = [
    ["Sign says", b.hours_text],
    ["Bay beside it says", b.hours_text ? null : b.hint],
    ["Not allowed", closedLines(b)],
    ["Spaces", b.spaces > 0 ? b.spaces : null],
    ["Parking angle", b.angle && /^\d+$/.test(b.angle) ? `${b.angle}°` : b.angle],
    ["Exemptions", b.exemptions],
  ].filter(([, v]) => v != null && v !== "");
  openSheet("bay", `
    <h2 id="sheet-title" class="sr-only" tabindex="-1">${esc(WORDS[b.category])}: ${esc(d.head)}</h2>
    <div class="bay tone-${d.tone}">
      ${plateHtml(b)}
      <div><p class="verdict">${esc(d.head)}</p><p class="verdict-sub">${esc(d.sub)}</p>${d.note ? `<p class="verdict-note">${esc(d.note)}</p>` : ""}</div>
    </div>
    ${filters.later ? `<p class="when-note">Showing ${esc(Logic.momentLabel(m))}, Adelaide time.</p>` : ""}
    ${directionsHtml(b)}
    <ul class="facts">${facts.map(([k, v]) => `<li><span>${k}</span><span>${esc(v)}</span></li>`).join("")}</ul>
    <p class="fine">Always read the sign at the bay too. Event days, works and public holidays can change the rules. <a href="${reportUrl(b, d)}" target="_blank" rel="noopener">${d.unknown ? "Know what this sign says? Tell us" : "Wrong? Report this bay"}</a>.</p>`,
  { focus: !quiet, from });
  // Keep the tapped bay in sight above the sheet.
  if (!quiet) requestAnimationFrame(() => lookAt(b.lat, b.lng, Math.max(tileZoom(), 16)));
}

// ---------- the list: the closest matching places, for a quick read or a screen reader ----------

function metres(aLat, aLng, bLat, bLng) {
  const k = Math.PI / 180;
  const x = (bLng - aLng) * k * Math.cos(((aLat + bLat) / 2) * k);
  return Math.hypot(x, (bLat - aLat) * k) * 6371000;
}
const distanceText = (m) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

function renderList() {
  const html = listHtml();
  if (sheetBody.dataset.html === html) return; // same rows: keep focus and scroll where they are
  sheetBody.innerHTML = html;
  sheetBody.dataset.html = html;
}

function listHtml() {
  const from = lastFix || (() => { const c = map.getCenter(); return [c.lat, c.lng]; })();
  const m = moment();
  const near = matched
    .map((b) => ({ b, d: metres(from[0], from[1], b.lat, b.lng) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, LIST_SIZE);
  const where = lastFix ? "from you" : "from the middle of the map";
  return `
    <h2 id="sheet-title" class="sheet-title" tabindex="-1">Closest places</h2>
    <p class="sheet-lead">${near.length ? `The ${near.length} nearest of ${nf.format(matched.length)} matching places, measured ${where}.` : "Nothing matches. Try fewer filters."}</p>
    <ol class="near">${near.map(({ b, d }) => {
      const say = Logic.describe(b, m, !filters.later);
      return `<li><button type="button" data-bay="${b.i}">${pinHtml(b)}<span class="near-text"><b>${esc(say.head)}</b><span>${esc(say.sub)}</span></span><span class="near-d">${distanceText(d)}</span></button></li>`;
    }).join("")}</ol>`;
}
function openList(from) {
  openSheet("list", "", { from });
  renderList();
  $("sheet-title")?.focus({ preventScroll: true });
}
sheetBody.addEventListener("click", (e) => {
  const row = e.target.closest("[data-bay]");
  if (row) { openBay(bays[Number(row.dataset.bay)], $("list-btn")); return; }
  onFilterClick(e);
  if (e.target.id === "w-go" || e.target.id === "w-skip") closeSheet();
});

// ---------- key and about ----------

function aboutHtml() {
  const timed = feed?.timed_bays, bad = feed?.unreadable_bays;
  const readable = timed ? Math.round(((timed - bad) / timed) * 100) : null;
  const updated = feed?.data_updated ? dateText(feed.data_updated, { day: "numeric", month: "short", year: "numeric" }) : null;
  const checked = feed?.checked ? dateText(feed.checked, { day: "numeric", month: "short", year: "numeric" }) : null;
  return `
  <h2 id="sheet-title" class="sheet-title" tabindex="-1">Reading the map</h2>
  <p class="sheet-lead">Each tag is a small copy of the sign on the pole. The number is the time limit, so <b>2P</b> means 2 hours. A ring with a number is a group of bays: tap it to zoom in. Green rings are mostly free, blue mostly ticket.</p>
  <ul class="key">
    <li><span class="pin pin-free">2P</span><span><b>Free, time limited</b><br>Park for free up to the limit while the sign applies.</span></li>
    <li><span class="pin pin-ticket">2P<i></i></span><span><b>Ticket</b><br>Pay at the machine or in an app while the sign applies.</span></li>
    <li><span class="pin pin-unrestricted">&#8734;</span><span><b>Unrestricted</b><br>No time limit, no ticket.</span></li>
    <li><span class="pin pin-free pin-unknown">2P</span><span><b>Check the sign</b><br>The council's data has no readable hours for this bay.</span></li>
    <li><span class="pin pin-special">&#9855;</span><span><b>Disabled permit</b>, <b>MC</b> motorcycles, <b>RES</b> residents with a permit</span></li>
    <li><span class="pin pin-stop">LZ</span><span><b>Loading zone</b>, <b>TAXI</b> rank, <b>NP</b> no parking. Hidden unless you ask for them in More.</span></li>
  </ul>
  <details class="about-more">
    <summary>About the data</summary>
    <ul class="about">
      <li><b>Free</b> means no payment. It does not mean there is an empty space. We have no live availability.</li>
      <li>Rules are in <b>Adelaide time</b>, whatever time your phone says.</li>
      <li>Outside the hours on a sign, a bay usually has no limit. Public holidays and event days can be different, and signs change. The sign on the street always wins.</li>
      ${readable != null ? `<li>We can read the hours on <b>${readable}%</b> of the ${nf.format(timed)} free and ticket bays. The rest say "Check the sign" instead of guessing.</li>` : ""}
      ${checked ? `<li>Data checked ${esc(checked)}${updated ? `, last changed ${esc(updated)}` : ""}. It updates once a day.</li>` : ""}
      <li>Your location stays on your phone. Search sends what you type to OpenStreetMap's Nominatim service.</li>
    </ul>
  </details>
  <p class="fine">Parking data: City of Adelaide, CC BY 4.0. Map: OpenFreeMap, OpenMapTiles, OpenStreetMap contributors; satellite imagery Esri. An independent project, not affiliated with the council. <a href="${REPO}/issues" target="_blank" rel="noopener">Report a wrong bay</a>.</p>`;
}
$("key-btn").onclick = (e) => openSheet("key", aboutHtml(), { from: e.currentTarget });

// ---------- welcome: ask first, then draw the map ----------

const SEEN_KEY = "apf_welcome_seen";
const seenThisVisit = () => { try { return !!sessionStorage.getItem(SEEN_KEY); } catch { return false; } };

function startMap() {
  if (started) return;
  started = true;
  try { sessionStorage.setItem(SEEN_KEY, "1"); } catch { /* fine, it will just ask again next time */ }
  matchedKey = "";
  applyFilters();
}

function openWelcome() {
  openSheet("welcome", `
    <h2 id="sheet-title" class="sheet-title" tabindex="-1">How long do you need to park?</h2>
    <p class="sheet-lead">We'll show only the bays that let you stay that long, starting now.</p>
    <div class="big-opts" role="group" aria-label="How long">${optButtons("need", WELCOME_NEEDS, "big-opt")}</div>
    <button type="button" class="opt free-opt" data-set="free" aria-pressed="false">Free only</button>
    <p class="hint">Change this any time in the panel at the bottom. Search for a street or use your location from the top of the map.</p>
    <div class="sheet-actions sticky">
      <button type="button" id="w-skip" class="btn">Skip</button>
      <button type="button" id="w-go" class="btn primary"></button>
    </div>`, { modal: true });
  syncFilters();
}

// ---------- the clock ----------

setInterval(() => {
  if (!bays.length) return;
  if (!filters.later && isFiltering()) applyFilters(); else updateChrome();
  if (sheetKind === "bay" && picked != null) openBay(bays[picked], null, true);
}, 30000);

// ---------- search ----------

const results = $("search-results");
let searching = false;
let searchPin = null;

function hideResults() { results.hidden = true; results.innerHTML = ""; }

function goTo(lat, lon, name) {
  hideResults();
  closeSheet();
  searchPin?.remove();
  const dot = document.createElement("div");
  dot.className = "target";
  searchPin = new maplibregl.Marker({ element: dot }).setLngLat([lon, lat]).addTo(map);
  lookAt(lat, lon, 17);
  flash(`Showing bays near ${name}.`);
}

async function runSearch(q) {
  if (searching) return;
  searching = true;
  results.hidden = false;
  results.innerHTML = '<li class="result-note">Searching...</li>';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    // Nominatim asks for light use: one request per search, only when the user submits.
    const params = new URLSearchParams({ format: "jsonv2", q: `${q}, Adelaide`, limit: "5", countrycodes: "au",
      viewbox: "138.57,-34.89,138.64,-34.96", bounded: "1", "accept-language": "en" });
    const r = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { signal: ctl.signal });
    if (!r.ok) throw new Error(r.status);
    const found = await r.json();
    if (!found.length) {
      results.innerHTML = '<li class="result-note">Nothing found in the city centre. Try a street name or a landmark.</li>';
    } else {
      results.innerHTML = found.map((f, i) => {
        const [head, ...rest] = f.display_name.split(",");
        return `<li><button type="button" data-i="${i}"><b>${esc(head)}</b><span>${esc(rest.slice(0, 2).join(","))}</span></button></li>`;
      }).join("");
      results.onclick = (e) => {
        const f = found[e.target.closest("button")?.dataset.i];
        if (f) goTo(Number(f.lat), Number(f.lon), f.display_name.split(",")[0]);
      };
    }
  } catch {
    results.innerHTML = '<li class="result-note">Search isn\'t working right now. Check your connection and try again.</li>';
  } finally {
    clearTimeout(timer);
    searching = false;
  }
}

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("search-input").value.trim();
  if (q.length >= 2) runSearch(q);
});
$("search-input").addEventListener("input", (e) => {
  if (!e.target.value) { hideResults(); searchPin?.remove(); searchPin = null; }
});

// ---------- where am I, and follow me ----------

let me = null;
let follow = false;
let watching = false;
let lastFix = null;

const toMe = () => lookAt(lastFix[0], lastFix[1], Math.max(tileZoom(), 17));

function onFix(pos) {
  $("locate-btn").classList.remove("busy");
  const firstFix = !lastFix;
  lastFix = [pos.coords.latitude, pos.coords.longitude];
  if (!me) {
    const dot = document.createElement("div");
    dot.className = "me";
    me = new maplibregl.Marker({ element: dot }).setLngLat([lastFix[1], lastFix[0]]).addTo(map);
  } else me.setLngLat([lastFix[1], lastFix[0]]);
  if (follow || firstFix) toMe();
  if (sheetKind === "list") renderList();
}

function onFixError(err) {
  $("locate-btn").classList.remove("busy");
  if (err.code === 1) {
    watching = false;
    setFollow(false);
    flash("Location is blocked. Allow it in your browser settings to use this.");
  } else if (!lastFix) {
    flash("Still looking for your location. Moving outside helps.");
  } // with a fix already, a slow update is fine: keep the dot where it is
}

// Two requests: a fast rough fix (Wi-Fi or a recent one) puts the dot on the map in a second or two,
// while the slow GPS watch refines it. Asking only for GPS can take minutes indoors or on a laptop.
function startWatching() {
  if (watching || !navigator.geolocation) return;
  watching = true;
  $("locate-btn").classList.add("busy");
  navigator.geolocation.getCurrentPosition((pos) => { if (!lastFix) onFix(pos); }, () => {}, { enableHighAccuracy: false, maximumAge: 600000, timeout: 10000 });
  navigator.geolocation.watchPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}

function setFollow(on) {
  follow = on;
  $("follow-btn").setAttribute("aria-pressed", on);
}

$("locate-btn").onclick = () => {
  if (lastFix) toMe();
  startWatching();
};
$("follow-btn").onclick = () => {
  setFollow(!follow);
  if (follow) {
    startWatching();
    if (lastFix) toMe();
  }
};
// Dragging the map means you want to look around, so stop chasing the car (same as Google Maps).
map.on("dragstart", () => setFollow(false));

// ---------- banner: one message at a time, most important first ----------

let flashText = null;
let flashTimer;
const dismissed = new Set();

function flash(text) {
  flashText = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashText = null; renderBanner(); }, 5000);
  renderBanner();
}

function pickBanner() {
  if (flashText) return { id: "flash", html: esc(flashText) };
  if (loadFailed) return { id: "load", html: "<b>Couldn't load the parking data</b>Check your connection.<br><button type=\"button\" data-act=\"retry\">Try again</button>" };
  const s = feed;
  if (s && !s.ok) {
    const since = dateText(s.since, { day: "numeric", month: "short", year: "numeric" });
    const old = s.bays ? `You're seeing the last copy we saved (${dateText(s.data_updated, { day: "numeric", month: "short" })}).` : "Bays will show up here by themselves once it's back.";
    return { id: "council", html: `<b>City of Adelaide's data server is down</b>The council's parking data server has been refusing connections since ${esc(since)}. This is on the council's side, not a fault in this app. ${esc(old)} We check again every day.`, dismiss: true };
  }
  if (s?.checked && Date.now() - new Date(s.checked) > STALE_DAYS * 864e5) {
    return { id: "stale", html: `<b>This data may be out of date</b>It was last checked ${esc(dateText(s.checked, { day: "numeric", month: "short" }))}. The daily update seems to have stopped, so read the signs carefully.`, dismiss: true };
  }
  if (!navigator.onLine) return { id: "offline", html: "<b>You're offline</b>Showing the last data and map tiles saved on this phone." };
  return null;
}

function renderBanner() {
  const b = $("banner");
  const pick = pickBanner();
  if (!pick || dismissed.has(pick.id)) { b.hidden = true; return; }
  b.innerHTML = pick.html + (pick.dismiss ? '<br><button type="button" data-act="dismiss">Got it</button>' : "");
  b.dataset.id = pick.id;
  b.hidden = false;
}
$("banner").addEventListener("click", (e) => {
  const act = e.target.closest("button")?.dataset.act;
  if (act === "dismiss") { dismissed.add($("banner").dataset.id); renderBanner(); }
  if (act === "retry") load();
});
addEventListener("online", renderBanner);
addEventListener("offline", renderBanner);

// ---------- load ----------

async function getJson(url) {
  try {
    const r = await fetch(url, { cache: "no-cache" });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function prepare(features) {
  const spots = new Map();
  const list = features.map((f, i) => {
    const [lng, lat] = f.geometry.coordinates;
    const b = { ...f.properties, i, lat, lng };
    const img = `p|${pinKind(b)}|${pinLabel(b)}|${isUnknown(b) ? 1 : 0}`;
    b.f = { type: "Feature", geometry: f.geometry, properties: { i, t: b.category === "ticket" ? 1 : 0, img, slot: 0 } };
    const key = `${lat},${lng}`;
    (spots.get(key) || spots.set(key, []).get(key)).push(b);
    return b;
  });
  for (const group of spots.values()) group.forEach((b, k) => { b.f.properties.slot = 2 * k - (group.length - 1); }); // whole numbers: map styles can only match integers
  return list;
}

async function load() {
  loadFailed = false;
  const [s, geojson] = await Promise.all([getJson("data/status.json"), getJson("data/parking.geojson")]);
  feed = s;
  if (geojson?.features?.length) {
    bays = prepare(geojson.features);
    matchedKey = "";
    applyFilters();
  } else if (!s) {
    loadFailed = true;
  }
  updateChrome();
  renderBanner();
}

syncLayersMenu();
showMore(DESKTOP.matches);
// Tags are drawn with the Overpass font, so wait briefly for it (never longer than a second and a half).
Promise.race([document.fonts?.load("800 13px Overpass") ?? Promise.resolve(), new Promise((r) => setTimeout(r, 1500))])
  .catch(() => {})
  .then(load);
updateChrome();
if (seenThisVisit()) startMap(); else openWelcome();

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
