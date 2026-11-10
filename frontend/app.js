"use strict";

const ADELAIDE = [-34.9265, 138.6010];
const THEME_KEY = "apf_theme";
const VEHICLE_KEY = "apf_vehicle";
const REPO = "https://github.com/baomun0304/adelaide-parking-finder";
const STALE_DAYS = 3;
const TILES = {
  light: ["World_Light_Gray_Base", "World_Light_Gray_Reference"],
  dark: ["World_Dark_Gray_Base", "World_Dark_Gray_Reference"],
};
const tileUrl = (name) => `https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/${name}/MapServer/tile/{z}/{y}/{x}`;
const NEEDS = [[0, "Any"], [30, "30 min"], [60, "1 hr"], [120, "2 hr"], [180, "3 hr"], [240, "4 hr"], [600, "All day"]];
const VEHICLES = [["car", "Car"], ["moto", "Motorbike"], ["disabled", "Disability permit"]];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: the page still works */ } },
};
const dateText = (iso, opts) => new Date(iso).toLocaleDateString("en-AU", { timeZone: "Australia/Adelaide", ...opts });
const nf = new Intl.NumberFormat("en-AU");

// ---------- map and theme ----------

const map = L.map("map", { zoomControl: false, minZoom: 12, maxZoom: 18 }).setView(ADELAIDE, 15);
map.attributionControl.setPrefix(false);

function tileLayers(theme) {
  const base = { maxZoom: 18, maxNativeZoom: 16, crossOrigin: true }; // CORS lets the service worker keep tiles for offline
  return [
    L.tileLayer(tileUrl(TILES[theme][0]), { ...base, attribution: "Esri, HERE, Garmin, &copy; OpenStreetMap contributors" }),
    L.tileLayer(tileUrl(TILES[theme][1]), base),
  ];
}

const systemDark = matchMedia("(prefers-color-scheme: dark)");
const activeTheme = () => store.get(THEME_KEY) || (systemDark.matches ? "dark" : "light");
let shownTheme = activeTheme();
document.documentElement.dataset.theme = shownTheme;
let tiles = tileLayers(shownTheme);
tiles.forEach((l) => l.addTo(map));

// The new tiles load on top of the old ones, and the old ones go only once the new ones are in,
// so switching never shows a half-and-half map.
function applyTheme(theme, remember) {
  if (remember) store.set(THEME_KEY, theme);
  if (theme === shownTheme) return;
  const old = tiles;
  shownTheme = theme;
  document.documentElement.dataset.theme = theme;
  tiles = tileLayers(theme);
  tiles.forEach((l) => l.addTo(map));
  tiles[0].once("load", () => old.forEach((l) => map.removeLayer(l)));
}
$("theme-btn").onclick = () => applyTheme(shownTheme === "dark" ? "light" : "dark", true);
systemDark.addEventListener?.("change", () => { if (!store.get(THEME_KEY)) applyTheme(activeTheme(), false); });

// ---------- state ----------

let bays = [];
let matched = [];
let feed = null;
let loadFailed = false;
let started = false; // the map stays empty until the visitor has had their say on the welcome sheet
const filters = { ...Logic.DEFAULT_FILTERS, vehicle: store.get(VEHICLE_KEY) || "car" };
if (!VEHICLES.some(([v]) => v === filters.vehicle)) filters.vehicle = "car";

const moment = () => filters.later || Logic.adelaideNow();

// ---------- markers: only what is on screen is ever in the page ----------

function pinHtml(p) {
  const label = {
    unrestricted: "&#8734;", disabled: "&#9855;", motorcycle: "MC", residential: "RES",
    loading: "LZ", taxi: "TAXI", "no-parking": "NP",
  }[p.category] || Logic.stayLabel(p.max_stay);
  const kind = { free: "free", ticket: "ticket", unrestricted: "unrestricted",
    disabled: "special", motorcycle: "special", residential: "special" }[p.category] || "stop";
  const unknown = (p.category === "free" || p.category === "ticket") && !p.windows ? " pin-unknown" : "";
  return `<span class="pin pin-${kind}${unknown}">${label}${kind === "ticket" ? "<i></i>" : ""}</span>`;
}

const WORDS = {
  free: "Free time-limited bay", ticket: "Ticket bay", unrestricted: "Unrestricted bay", motorcycle: "Motorcycle bay",
  disabled: "Disabled permit bay", residential: "Residents permit bay", taxi: "Taxi rank", loading: "Loading zone", "no-parking": "No parking zone",
};
const bayLabel = (b) => `${WORDS[b.category]}${b.max_stay ? `, ${Logic.stayWords(b.max_stay)}` : ""}. ${b.hours_text || "Check the sign"}. Press Enter for details.`;

const layer = L.layerGroup().addTo(map);
const live = new Map(); // key -> marker currently on the map
let index = null;
let picked = null;

function bayMarker(b) {
  const [k, n] = b.dup;
  const shift = (k - (n - 1) / 2) * 50; // bays that share a spot fan out side by side at full zoom
  const m = L.marker([b.lat, b.lng], {
    icon: L.divIcon({ html: pinHtml(b), className: "pin-wrap", iconSize: [44, 26], iconAnchor: [22 - shift, 13] }),
    title: bayLabel(b),
  });
  m.on("add", () => m.getElement().setAttribute("aria-label", bayLabel(b)));
  m.on("click", () => openBay(b, m.getElement()));
  return m;
}

function clusterMarker(c) {
  const [lng, lat] = c.geometry.coordinates;
  const { cluster_id: id, point_count: n, t } = c.properties;
  const size = n > 99 ? 48 : 40;
  const label = `${nf.format(n)} bays here. Press Enter to zoom in.`;
  const m = L.marker([lat, lng], {
    icon: L.divIcon({ html: `<div class="cluster${t > n / 2 ? " mostly-ticket" : ""}">${nf.format(n)}</div>`, className: "", iconSize: [size, size] }),
    title: label,
  });
  m.on("add", () => m.getElement().setAttribute("aria-label", label));
  m.on("click", () => map.setView([lat, lng], Math.min(index.getClusterExpansionZoom(id), 18)));
  return m;
}

function render() {
  if (!index || !started) return;
  const b = map.getBounds().pad(0.25);
  const zoom = Math.min(Math.round(map.getZoom()), 18);
  const keep = new Set();
  for (const item of index.getClusters([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], zoom)) {
    const isCluster = item.properties.cluster;
    const key = isCluster ? `c${item.properties.cluster_id}` : `b${item.properties.i}`;
    keep.add(key);
    if (live.has(key)) continue;
    const m = isCluster ? clusterMarker(item) : bayMarker(bays[item.properties.i]);
    live.set(key, m);
    layer.addLayer(m);
  }
  for (const [key, m] of live) {
    if (!keep.has(key)) { layer.removeLayer(m); live.delete(key); }
  }
  markPicked();
}

function markPicked() {
  for (const m of live.values()) m._icon?.classList.remove("pin-picked");
  if (picked != null) live.get(`b${picked}`)?._icon?.classList.add("pin-picked");
}

let frame = 0;
map.on("moveend", () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(render); });

function applyFilters() {
  const m = moment();
  matched = Logic.isFiltering(filters) ? bays.filter((b) => Logic.matches(b, filters, m)) : bays;
  index = new Supercluster({ radius: 50, extent: 256, maxZoom: 17, minPoints: 2, map: (p) => ({ t: p.t }), reduce: (a, p) => { a.t += p.t; } });
  index.load(matched.map((b) => b.pt));
  layer.clearLayers();
  live.clear();
  render();
  updateChrome();
}

// ---------- chips, status line ----------

const activeCount = () => [filters.free, filters.need > 0, filters.later, filters.vehicle !== "car", filters.sureOnly].filter(Boolean).length;

function updateChrome() {
  const filtering = Logic.isFiltering(filters);
  $("chip-free").setAttribute("aria-pressed", filters.free);
  $("chip-free").textContent = filters.later ? "Free" : "Free now";
  for (const c of document.querySelectorAll(".chip[data-need]")) c.setAttribute("aria-pressed", filters.need === Number(c.dataset.need));
  const n = activeCount();
  $("chip-badge").hidden = !n;
  $("chip-badge").textContent = n;
  $("chip-more").classList.toggle("on", n > 0 && !filters.free && !filters.need);

  const when = filters.later ? `For ${Logic.momentLabel(filters.later)}` : `Now, ${Logic.momentLabel(moment())}`;
  const main = !bays.length ? (loadFailed ? "Couldn't load the bays" : "Loading bays...")
    : !filtering ? `All ${nf.format(bays.length)} bays`
    : matched.length ? `${nf.format(matched.length)} of ${nf.format(bays.length)} bays match`
    : "No bays match. Try fewer filters.";
  const fresh = feed?.checked ? ` &middot; data checked ${esc(dateText(feed.checked, { day: "numeric", month: "short" }))}` : "";
  const html = `<span class="status-main">${esc(main)}</span>
    <span class="status-sub">${esc(when)} (Adelaide)${fresh}</span>
    <span class="status-actions">${filtering ? '<button type="button" data-act="reset">Reset</button>' : ""}${filters.later ? '<button type="button" data-act="now">Back to now</button>' : ""}</span>`;
  if ($("status").dataset.html !== html) { $("status").innerHTML = html; $("status").dataset.html = html; }
  if (sheetKind === "filters" || sheetKind === "welcome") syncFilterSheet();
}

$("status").addEventListener("click", (e) => {
  const act = e.target.closest("button")?.dataset.act;
  if (act === "reset") resetFilters();
  if (act === "now") setFilter({ later: null });
});

function setFilter(change) {
  Object.assign(filters, change);
  if ("vehicle" in change) store.set(VEHICLE_KEY, filters.vehicle);
  applyFilters();
}
function resetFilters() { setFilter({ ...Logic.DEFAULT_FILTERS, vehicle: "car" }); }

$("chip-free").onclick = () => setFilter({ free: !filters.free });
for (const c of document.querySelectorAll(".chip[data-need]")) {
  c.onclick = () => setFilter({ need: filters.need === Number(c.dataset.need) ? 0 : Number(c.dataset.need) });
}
$("chip-more").onclick = () => openFilters();

// ---------- the sheet ----------

const sheet = $("sheet");
const sheetBody = $("sheet-body");
let sheetKind = null;
let opener = null;

function openSheet(kind, html, { focus = true, from = null } = {}) {
  const wasOpen = !sheet.hidden && !sheet.classList.contains("closing");
  sheetKind = kind;
  sheetBody.innerHTML = html;
  if (from) opener = from;
  if (!wasOpen) {
    sheet.hidden = false;
    sheet.classList.add("closing");
    requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.remove("closing")));
  }
  if (focus) sheet.querySelector(".sheet-close").focus({ preventScroll: true });
}

function closeSheet() {
  if (sheet.hidden) return;
  const wasWelcome = sheetKind === "welcome";
  sheet.classList.add("closing");
  sheetKind = null;
  setTimeout(() => { if (sheet.classList.contains("closing")) sheet.hidden = true; }, 300);
  picked = null;
  markPicked();
  if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  opener = null;
  if (wasWelcome) startMap();
}

sheet.querySelector(".sheet-close").onclick = closeSheet;
map.on("click", closeSheet);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("search-results").hidden) hideResults(); else closeSheet();
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
  return `<div class="plate ${cls}"><div class="plate-big">${big}</div>${word ? `<div class="plate-word">${word}</div>` : ""}${hours ? `<div class="plate-hours">${hours}</div>` : ""}</div>`;
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
    const k = `${label} ${Logic.daysText(days)} ${Logic.clockText(start)} to ${Logic.clockText(end)}`;
    seen.set(k, true);
  }
  return [...seen.keys()].slice(0, 4).join("; ") + (seen.size > 4 ? "; more on the sign" : "");
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
    <h2 id="sheet-title" class="sr-only">Parking bay details</h2>
    <div class="bay tone-${d.tone}">
      ${plateHtml(b)}
      <div><p class="verdict">${esc(d.head)}</p><p class="verdict-sub">${esc(d.sub)}</p>${d.note ? `<p class="verdict-note">${esc(d.note)}</p>` : ""}</div>
    </div>
    ${filters.later ? `<p class="when-note">Showing ${esc(Logic.momentLabel(m))}, Adelaide time.</p>` : ""}
    ${directionsHtml(b)}
    <ul class="facts">${facts.map(([k, v]) => `<li><span>${k}</span><span>${esc(v)}</span></li>`).join("")}</ul>
    <p class="fine">Always read the sign at the bay too. Event days, works and public holidays can change the rules.</p>`,
  { focus: !quiet, from });
}

// ---------- key and about ----------

function aboutHtml() {
  const timed = feed?.timed_bays, bad = feed?.unreadable_bays;
  const readable = timed ? Math.round(((timed - bad) / timed) * 100) : null;
  const updated = feed?.data_updated ? dateText(feed.data_updated, { day: "numeric", month: "short", year: "numeric" }) : null;
  const checked = feed?.checked ? dateText(feed.checked, { day: "numeric", month: "short", year: "numeric" }) : null;
  return `
  <h2 id="sheet-title" class="sheet-title">Reading the map</h2>
  <p class="sheet-lead">Each tag is a small copy of the sign on the pole. The number is the time limit, so <b>2P</b> means 2 hours.</p>
  <ul class="key">
    <li><span class="pin pin-free">2P</span><span><b>Free, time limited</b><br>Park for free up to the limit while the sign applies.</span></li>
    <li><span class="pin pin-ticket">2P<i></i></span><span><b>Ticket</b><br>Pay at the machine or in an app while the sign applies.</span></li>
    <li><span class="pin pin-unrestricted">&#8734;</span><span><b>Unrestricted</b><br>No time limit, no ticket.</span></li>
    <li><span class="pin pin-special">&#9855;</span><span><b>Disabled permit</b></span></li>
    <li><span class="pin pin-special">MC</span><span><b>Motorcycles only</b></span></li>
    <li><span class="pin pin-special">RES</span><span><b>Residents with a permit</b></span></li>
    <li><span class="pin pin-stop">LZ</span><span><b>Loading zone</b><br>Commercial vehicles loading, not for parking.</span></li>
    <li><span class="pin pin-stop">TAXI</span><span><b>Taxi rank</b></span></li>
    <li><span class="pin pin-stop">NP</span><span><b>No parking</b></span></li>
    <li><span class="pin pin-free pin-unknown">2P</span><span><b>Check the sign</b><br>The council's data has no readable hours for this bay.</span></li>
  </ul>
  <h3 class="sheet-sub">About the data</h3>
  <ul class="about">
    <li><b>Free</b> means no payment. It does not mean there is an empty space. We have no live availability.</li>
    <li>Rules are in <b>Adelaide time</b>, whatever time your phone says.</li>
    <li>Outside the hours on a sign, a bay usually has no limit. Public holidays and event days can be different, and signs change. The sign on the street always wins.</li>
    ${readable != null ? `<li>We can read the hours on <b>${readable}%</b> of the ${nf.format(timed)} free and ticket bays. The rest say "Check the sign" instead of guessing.</li>` : ""}
    ${checked ? `<li>Data checked ${esc(checked)}${updated ? `, last changed ${esc(updated)}` : ""}. It updates once a day.</li>` : ""}
    <li>Your location stays on your phone. Search sends what you type to OpenStreetMap's Nominatim service.</li>
  </ul>
  <p class="fine">Parking data: City of Adelaide, CC BY 4.0. Map: Esri, OpenStreetMap contributors. An independent project, not affiliated with the council. <a href="${REPO}/issues" target="_blank" rel="noopener">Report a wrong bay</a>.</p>`;
}
$("key-btn").onclick = (e) => openSheet("key", aboutHtml(), { from: e.currentTarget });

// ---------- filters sheet ----------

function optGroup(title, name, options, hint = "") {
  return `<fieldset class="fgroup"><legend>${title}</legend><div class="opts">${options.map(([v, label]) =>
    `<button type="button" class="opt" data-set="${name}" data-v="${v}" aria-pressed="false">${label}</button>`).join("")}</div>${hint}</fieldset>`;
}

function dayOptions() {
  const today = Logic.adelaideNow().day;
  return [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : dateText(Date.now() + i * 864e5, { weekday: "short", day: "numeric", month: "short" });
    return `<option value="${(today + i) % 7}">${label}</option>`;
  }).join("");
}

function openFilters(from) {
  openSheet("filters", `
    <h2 id="sheet-title" class="sheet-title">Filters</h2>
    <p class="sheet-lead">Pick what matters. The map updates as you tap.</p>
    ${optGroup("When are you parking?", "when", [["now", "Now"], ["later", "Later"]])}
    <div id="later-box" class="later" hidden>
      <label>Day <select id="when-day">${dayOptions()}</select></label>
      <label>Arrive at <input id="when-time" type="time" step="900"></label>
    </div>
    ${optGroup("How long do you need?", "need", NEEDS)}
    ${optGroup("Cost", "free", [["0", "Any"], ["1", "Free only"]])}
    ${optGroup("Your vehicle", "vehicle", VEHICLES, '<p class="hint">Shows the bays you can legally use. Motorbikes and permit holders can also use normal bays.</p>')}
    <label class="toggle"><input type="checkbox" id="sure-only"><span>Only bays with a readable sign</span></label>
    <div class="sheet-actions">
      <button type="button" id="f-reset" class="btn">Reset</button>
      <button type="button" id="f-done" class="btn primary"></button>
    </div>`, { from: from || $("chip-more") });
  syncFilterSheet();
}

function syncFilterSheet() {
  const current = {
    when: filters.later ? "later" : "now", need: String(filters.need), free: filters.free ? "1" : "0", vehicle: filters.vehicle,
  };
  for (const b of sheetBody.querySelectorAll(".opt")) b.setAttribute("aria-pressed", current[b.dataset.set] === b.dataset.v);
  $("later-box").hidden = !filters.later;
  if (filters.later) {
    $("when-day").value = String(filters.later.day);
    const mins = filters.later.mins;
    $("when-time").value = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  }
  if ($("sure-only")) $("sure-only").checked = filters.sureOnly;
  const label = !bays.length ? "Show the map" : !Logic.isFiltering(filters) ? "Show all bays" : matched.length ? `Show ${nf.format(matched.length)} bays` : "No bays match";
  for (const id of ["f-done", "w-go"]) if ($(id)) $(id).textContent = label;
}

// ---------- welcome: ask first, then draw the map ----------

const SEEN_KEY = "apf_welcome_seen";
const seenThisVisit = () => { try { return !!sessionStorage.getItem(SEEN_KEY); } catch { return false; } };

function startMap() {
  if (started) return;
  started = true;
  try { sessionStorage.setItem(SEEN_KEY, "1"); } catch { /* fine, it will just ask again next time */ }
  applyFilters();
}

function openWelcome() {
  openSheet("welcome", `
    <h2 id="sheet-title" class="sheet-title">Where are you parking?</h2>
    <p class="sheet-lead">Tell us a little and we will show only the bays that suit you. Or skip and look at the whole map.</p>
    <form id="w-search" class="w-where" role="search">
      <input id="w-q" type="search" placeholder="Street or place, e.g. Rundle Mall" aria-label="Street or place" enterkeyhint="search" maxlength="80" autocomplete="off">
      <button type="submit" class="btn">Search</button>
    </form>
    <button type="button" id="w-near" class="btn w-near">Use my location</button>
    ${optGroup("When are you parking?", "when", [["now", "Now"], ["later", "Later"]])}
    <div id="later-box" class="later" hidden>
      <label>Day <select id="when-day">${dayOptions()}</select></label>
      <label>Arrive at <input id="when-time" type="time" step="900"></label>
    </div>
    ${optGroup("How long do you need?", "need", NEEDS)}
    ${optGroup("Cost", "free", [["0", "Any"], ["1", "Free only"]], '<p class="hint">We have no prices, only whether a bay is free or ticketed. Check the machine for the rate.</p>')}
    <div class="sheet-actions">
      <button type="button" id="w-skip" class="btn">Skip, show the map</button>
      <button type="button" id="w-go" class="btn primary"></button>
    </div>`, { focus: false });
  syncFilterSheet();
}

function nextQuarter() {
  const n = Logic.adelaideNow();
  return { day: n.day, mins: Math.min(Math.ceil((n.mins + 1) / 15) * 15, 1425) };
}

sheetBody.addEventListener("click", (e) => {
  const opt = e.target.closest(".opt");
  if (opt) {
    const v = opt.dataset.v;
    const set = opt.dataset.set;
    if (set === "when") setFilter({ later: v === "later" ? (filters.later || nextQuarter()) : null });
    if (set === "need") setFilter({ need: Number(v) });
    if (set === "free") setFilter({ free: v === "1" });
    if (set === "vehicle") setFilter({ vehicle: v });
  }
  if (e.target.id === "f-reset") resetFilters();
  if (e.target.id === "f-done" || e.target.id === "w-go" || e.target.id === "w-skip") closeSheet();
  if (e.target.id === "w-near") { startWatching(); closeSheet(); }
});
sheetBody.addEventListener("submit", (e) => {
  if (e.target.id !== "w-search") return;
  e.preventDefault();
  const q = $("w-q").value.trim();
  if (q.length < 2) return;
  $("search-input").value = q;
  runSearch(q); // picking a result closes this sheet, which starts the map
});
sheetBody.addEventListener("change", (e) => {
  if (e.target.id === "sure-only") setFilter({ sureOnly: e.target.checked });
  if (e.target.id === "when-day" || e.target.id === "when-time") {
    const [h, m] = ($("when-time").value || "00:00").split(":").map(Number);
    setFilter({ later: { day: Number($("when-day").value), mins: h * 60 + m } });
  }
});

// ---------- the clock ----------

setInterval(() => {
  if (!bays.length) return;
  if (!filters.later && Logic.isFiltering(filters)) applyFilters(); else updateChrome();
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
  searchPin = L.marker([lat, lon], {
    icon: L.divIcon({ html: '<div class="target"></div>', className: "", iconSize: [26, 26] }), interactive: false, keyboard: false,
  }).addTo(map);
  map.setView([lat, lon], 18);
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
map.on("click", hideResults);

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
        me = L.marker(lastFix, { icon: L.divIcon({ html: '<div class="me"></div>', className: "", iconSize: [20, 20] }), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
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
    b.pt = { type: "Feature", properties: { i, t: b.category === "ticket" ? 1 : 0 }, geometry: { type: "Point", coordinates: [lng, lat] } };
    const key = `${lat},${lng}`;
    (spots.get(key) || spots.set(key, []).get(key)).push(b);
    return b;
  });
  for (const group of spots.values()) group.forEach((b, k) => { b.dup = [k, group.length]; });
  return list;
}

async function load() {
  loadFailed = false;
  const [s, geojson] = await Promise.all([getJson("data/status.json"), getJson("data/parking.geojson")]);
  feed = s;
  if (geojson?.features?.length) {
    bays = prepare(geojson.features);
    applyFilters();
  } else if (!s) {
    loadFailed = true;
  }
  updateChrome();
  renderBanner();
}
load();
updateChrome();
if (seenThisVisit()) startMap(); else openWelcome();

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
