"use strict";

const ADELAIDE = [-34.9265, 138.6010];
const THEME_KEY = "apf_theme";
const TILES = {
  light: ["World_Light_Gray_Base", "World_Light_Gray_Reference"],
  dark: ["World_Dark_Gray_Base", "World_Dark_Gray_Reference"],
};
const tileUrl = (name) => `https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/${name}/MapServer/tile/{z}/{y}/{x}`;
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- map and theme ----------

const map = L.map("map", { zoomControl: false, minZoom: 12, maxZoom: 18 }).setView(ADELAIDE, 15);
map.attributionControl.setPrefix(false);
const base = L.tileLayer(tileUrl(TILES.light[0]), { maxZoom: 18, maxNativeZoom: 16, attribution: "Esri, HERE, Garmin, &copy; OpenStreetMap contributors" }).addTo(map);
const labels = L.tileLayer(tileUrl(TILES.light[1]), { maxZoom: 18, maxNativeZoom: 16 }).addTo(map);

function savedTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}
function activeTheme() {
  return savedTheme() || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function applyTheme(theme, remember) {
  document.documentElement.dataset.theme = theme;
  base.setUrl(tileUrl(TILES[theme][0]));
  labels.setUrl(tileUrl(TILES[theme][1]));
  if (remember) try { localStorage.setItem(THEME_KEY, theme); } catch {}
}
applyTheme(activeTheme(), false);
$("theme-btn").onclick = () => applyTheme(activeTheme() === "dark" ? "light" : "dark", true);

// ---------- reading a bay ----------

function stayLabel(minutes) {
  if (!minutes) return "";
  return { 15: "¼P", 30: "½P" }[minutes] || `${minutes / 60}P`;
}

function stayWords(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return `${h} hour${h === 1 ? "" : "s"}`;
}

function clockText(minutes) {
  if (minutes === 1440 || minutes === 0) return "midnight";
  if (minutes === 720) return "noon";
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`;
}

function daysText(days) {
  if (days.length === 7) return "Daily";
  const runs = [];
  for (const d of days) {
    const last = runs[runs.length - 1];
    if (last && d === last[1] + 1) last[1] = d; else runs.push([d, d]);
  }
  return runs.map(([a, b]) => a === b ? DAY_NAMES[a] : `${DAY_NAMES[a]}${b - a > 1 ? "-" : ", "}${DAY_NAMES[b]}`).join(", ");
}

// What applies to this bay at this moment. Everything the driver reads comes from here.
function rightNow(p, now = new Date()) {
  const fixed = {
    unrestricted: ["ok", "No time limit", "Park as long as you like."],
    "no-parking": ["no", "No parking", "Not a place to leave the car."],
    loading: ["no", "Loading zone", "For vehicles loading or unloading, not parking."],
    taxi: ["no", "Taxi rank", "Taxis only."],
    disabled: ["special", "Disabled permit only", "Needs a valid disability parking permit on display."],
    residential: ["special", "Residents with a permit", "Other drivers may be fined."],
    motorcycle: ["special", "Motorcycles only", "No cars."],
  }[p.category];
  if (fixed) return { tone: fixed[0], head: fixed[1], sub: fixed[2], blocksFree: fixed[0] === "no" };

  if (!p.windows) {
    return { tone: "special", head: "Check the sign", sub: "We couldn't read this sign's hours for sure.", unknown: true };
  }
  const day = (now.getDay() + 6) % 7;
  const mins = now.getHours() * 60 + now.getMinutes();
  const today = p.windows.filter((w) => w[0].includes(day));
  const active = today.find((w) => mins >= w[1] && mins < w[2]);
  const limit = stayWords(p.max_stay);

  if (active) {
    const until = `until ${clockText(active[2])}`;
    return p.category === "ticket"
      ? { tone: "paid", head: `Ticket, ${limit} max`, sub: `Pay at the machine or in an app, ${until}.`, blocksFree: true }
      : { tone: "ok", head: `Free for ${limit}`, sub: `Time limit applies ${until}.` };
  }
  const next = today.filter((w) => w[1] > mins).sort((a, b) => a[1] - b[1])[0];
  return {
    tone: "ok",
    head: "No limit right now",
    sub: next
      ? `${p.category === "ticket" ? "Ticket" : limit + " limit"} starts at ${clockText(next[1])}.`
      : today.length ? "The sign's hours are over for today." : "This sign doesn't apply today.",
  };
}

// ---------- markers ----------

function pinHtml(p) {
  const label = {
    unrestricted: "&#8734;", disabled: "&#9855;", motorcycle: "MC", residential: "RES",
    loading: "LZ", taxi: "TAXI", "no-parking": "NP",
  }[p.category] || stayLabel(p.max_stay);
  const kind = { free: "free", ticket: "ticket", unrestricted: "unrestricted",
    disabled: "special", motorcycle: "special", residential: "special" }[p.category] || "stop";
  const unknown = (p.category === "free" || p.category === "ticket") && !p.windows ? " pin-unknown" : "";
  return `<span class="pin pin-${kind}${unknown}">${label}${kind === "ticket" ? "<i></i>" : ""}</span>`;
}

const cluster = L.markerClusterGroup({
  maxClusterRadius: (zoom) => (zoom >= 17 ? 28 : 55),
  disableClusteringAtZoom: 17,
  showCoverageOnHover: false,
  spiderfyOnMaxZoom: false,
  iconCreateFunction(c) {
    const kids = c.getAllChildMarkers();
    const tickets = kids.filter((m) => m.bay.category === "ticket").length;
    const size = kids.length > 99 ? 48 : 40;
    return L.divIcon({
      html: `<div class="cluster${tickets > kids.length / 2 ? " mostly-ticket" : ""}">${kids.length}</div>`,
      className: "", iconSize: [size, size],
    });
  },
}).addTo(map);

let markers = [];
let picked = null;

function buildMarkers(geojson) {
  markers = geojson.features.map((f) => {
    const [lng, lat] = f.geometry.coordinates;
    const m = L.marker([lat, lng], {
      icon: L.divIcon({ html: pinHtml(f.properties), className: "pin-wrap", iconSize: [44, 26], iconAnchor: [22, 13] }),
      keyboard: true,
      title: f.properties.hours_text || f.properties.category,
    });
    m.bay = f.properties;
    m.on("click", () => openBay(m));
    return m;
  });
}

let freeOnly = false;

function refreshMarkers() {
  const now = new Date();
  const shown = freeOnly ? markers.filter((m) => !rightNow(m.bay, now).blocksFree) : markers;
  cluster.clearLayers();
  cluster.addLayers(shown);
}

// ---------- the sheet ----------

const sheet = $("sheet");
const sheetBody = $("sheet-body");

function openSheet(html) {
  sheetBody.innerHTML = html;
  if (!sheet.hidden && !sheet.classList.contains("closing")) return;
  sheet.hidden = false;
  sheet.classList.add("closing");
  requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.remove("closing")));
}

function closeSheet() {
  if (sheet.hidden) return;
  sheet.classList.add("closing");
  setTimeout(() => { if (sheet.classList.contains("closing")) sheet.hidden = true; }, 300);
  if (picked) { picked._icon?.classList.remove("pin-picked"); picked = null; }
}

function plateHtml(p) {
  const cls = { free: "", ticket: "ticket", unrestricted: "unrestricted", disabled: "special",
    motorcycle: "special", residential: "special" }[p.category] ?? "stop";
  const big = { unrestricted: "&#8734;", disabled: "&#9855;", motorcycle: "MC", residential: "P",
    loading: "LZ", taxi: "TAXI", "no-parking": "NP" }[p.category] || stayLabel(p.max_stay);
  const word = { ticket: "Ticket", free: "", unrestricted: "No limit", residential: "Permit",
    loading: "Loading", taxi: "Zone", "no-parking": "", disabled: "Permit", motorcycle: "Only" }[p.category];
  const hours = (p.windows || []).map((w) => `${clockText(w[1])}-${clockText(w[2])}<br>${daysText(w[0])}`).join("<br>");
  return `<div class="plate ${cls}"><div class="plate-big">${big}</div>${word ? `<div class="plate-word">${word}</div>` : ""}${hours ? `<div class="plate-hours">${hours}</div>` : ""}</div>`;
}

function openBay(marker) {
  if (picked) picked._icon?.classList.remove("pin-picked");
  picked = marker;
  marker._icon?.classList.add("pin-picked");
  const p = marker.bay;
  const now = rightNow(p);
  const facts = [
    ["Sign says", p.hours_text],
    ["Spaces", p.spaces > 0 ? p.spaces : null],
    ["Parking angle", p.angle && /^\d+$/.test(p.angle) ? `${p.angle}°` : p.angle],
    ["Exemptions", p.exemptions],
  ].filter(([, v]) => v != null && v !== "");
  openSheet(`
    <div class="bay tone-${now.tone}">
      ${plateHtml(p)}
      <div><p class="verdict">${esc(now.head)}</p><p class="verdict-sub">${esc(now.sub)}</p></div>
    </div>
    <ul class="facts">${facts.map(([k, v]) => `<li><span>${k}</span><span>${esc(v)}</span></li>`).join("")}</ul>
    <p class="fine">Always read the sign at the bay too. Event days, works and public holidays can change the rules.</p>`);
}

sheet.querySelector(".sheet-close").onclick = closeSheet;
map.on("click", closeSheet);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

$("key-btn").onclick = () => openSheet($("key-template").innerHTML);

// ---------- free now ----------

function tickClock() {
  const now = new Date();
  $("clock").textContent = `${DAY_NAMES[(now.getDay() + 6) % 7]} ${clockText(now.getHours() * 60 + now.getMinutes())}`;
}
tickClock();
setInterval(() => {
  tickClock();
  if (freeOnly) refreshMarkers(); // windows open and close while you drive around
}, 30000);

$("free-btn").onclick = (e) => {
  freeOnly = !freeOnly;
  e.currentTarget.setAttribute("aria-pressed", freeOnly);
  refreshMarkers();
};

// ---------- where am I, and follow me ----------

let me = null;
let follow = false;
let watching = false;
let lastFix = null;

function startWatching() {
  if (watching || !navigator.geolocation) return;
  watching = true;
  $("locate-btn").classList.add("busy");
  navigator.geolocation.watchPosition(
    (pos) => {
      $("locate-btn").classList.remove("busy");
      const firstFix = !lastFix;
      lastFix = [pos.coords.latitude, pos.coords.longitude];
      if (!me) {
        me = L.marker(lastFix, { icon: L.divIcon({ html: '<div class="me"></div>', className: "", iconSize: [20, 20] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      } else me.setLatLng(lastFix);
      if (follow || firstFix) map.setView(lastFix, Math.max(map.getZoom(), 17), { animate: true });
    },
    (err) => {
      $("locate-btn").classList.remove("busy");
      watching = false;
      setFollow(false);
      flash(err.code === 1 ? "Location is blocked. Allow it in your browser settings to use this." : "Couldn't find your location just now.");
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

function setFollow(on) {
  follow = on;
  $("follow-btn").setAttribute("aria-pressed", on);
}

$("locate-btn").onclick = () => {
  if (lastFix) map.setView(lastFix, Math.max(map.getZoom(), 17));
  startWatching();
};
$("follow-btn").onclick = () => {
  setFollow(!follow);
  if (follow) {
    startWatching();
    if (lastFix) map.setView(lastFix, Math.max(map.getZoom(), 17));
  }
};
// Dragging the map means you want to look around, so stop chasing the car (same as Google Maps).
map.on("dragstart", () => setFollow(false));

// ---------- banner ----------

let flashTimer;
function flash(text) {
  const b = $("banner");
  b.innerHTML = esc(text);
  b.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { b.hidden = true; showCouncilStatus(); }, 5000);
}

let councilStatus = null;
function showCouncilStatus() {
  const s = councilStatus;
  const b = $("banner");
  if (!s || s.ok) { b.hidden = true; return; }
  const since = new Date(s.since).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  const old = s.bays
    ? `You're seeing the last copy we saved (${new Date(s.data_updated).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}).`
    : "Bays will show up here by themselves once it's back.";
  b.innerHTML = `<b>City of Adelaide's data server is down</b>
    The council's parking data server has been refusing connections since ${since}. This is on the council's side, not a fault in this app. ${old} We check again every day.
    <br><button type="button">Got it</button>`;
  b.hidden = false;
  b.querySelector("button").onclick = () => { b.hidden = true; };
}

// ---------- load ----------

async function getJson(url) {
  try {
    const r = await fetch(url, { cache: "no-cache" });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

Promise.all([getJson("data/status.json"), getJson("data/parking.geojson")]).then(([status, geojson]) => {
  councilStatus = status;
  if (geojson?.features?.length) {
    buildMarkers(geojson);
    refreshMarkers();
  } else if (!status) {
    councilStatus = { ok: false, since: new Date().toISOString(), bays: 0 };
  }
  showCouncilStatus();
  if (status?.data_updated) {
    const tpl = $("key-template");
    tpl.innerHTML = tpl.innerHTML.replace("CC BY 4.0.", `CC BY 4.0, last updated ${new Date(status.data_updated).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}.`);
  }
});

document.addEventListener("touchstart", () => {}, { passive: true }); // lets :active styles fire on iOS
