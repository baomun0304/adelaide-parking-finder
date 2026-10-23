# Adelaide Parking Finder — v1 design spec

Status: approved by Bao 2026-09-22, ready for implementation planning.

## Purpose

A static, mobile-first map showing on-street parking restrictions in the
Adelaide CBD (free, ticketed, unrestricted, motorcycle, disabled,
residential, taxi rank, loading zone, no-parking), so a driver can glance
at it and understand where they can legally park without slowly circling
blocks reading signs. On-street parking only, no off-street/paid carpark
comparison, no live occupancy, no routing, no accounts, no payments — all
explicitly out of scope for v1 (see Scope section).

## Architecture

Static site only. No backend server, no database, no always-on VM.

```
GitHub Actions (weekly cron)
  -> sync/sync_parking.py
    -> queries ~35 ArcGIS FeatureServer layers on gis.cityofadelaide.com.au
    -> writes frontend/data/parking.geojson
  -> commits + pushes if the file changed
Vercel (static hosting, root = frontend/)
  -> auto-deploys on push to main
Browser
  -> fetches frontend/data/parking.geojson directly (same origin, no API, no CORS hop)
  -> Leaflet renders it
```

This mirrors the sibling project (adelaide-transit-predictor) only where
it makes sense — same map stack (Leaflet, Esri Gray Canvas tiles),
same light/dark theme pattern. It deliberately does NOT copy that
project's FastAPI+SQLite+24/7-collector backend, because parking
restriction data is near-static (changes when the council changes a
sign, not every 30 seconds), so there's nothing that needs a live
server or a database.

## Data source

`gis.cityofadelaide.com.au`, folder `External_Facing_Data`, ArcGIS
REST FeatureServer, no auth, no API key. Confirmed working by direct
query during design (see chat history 2026-09-21/22 for the verified
sample responses). The council's own "official" static export channel
(`data.sa.gov.au` CSV/KMZ, CC BY 4.0 licensed) was checked and found
broken (CSV: SQL Server permission error) or stale (KMZ: mismatched
schema) at design time — use the ArcGIS layers directly instead, and
re-check the data.sa.gov.au channel occasionally in case it gets fixed,
since that's the cleaner-licensed option long term.

Layers to sync (one HTTP GET each, `outSR=4326` for lat/lon,
`resultOffset` pagination when `exceededTransferLimit` is true):

- Free parking: 15/30 min, 1/2/3/4/5/6/10 hr, each split Weekday/Weekend
- Ticket parking: 30 min, 1/2/3/4/10 hr, each split Weekday/Weekend
- Unrestricted_Parking
- Motorcycle_Parking
- Disabled_Parking
- Residential_Parking
- Taxi_Rank
- Loading_Zones
- No_Parking_Zone

Each layer's rows get tagged with a `category` field, one of:
`free`, `ticket`, `unrestricted`, `motorcycle`, `disabled`,
`residential`, `taxi`, `loading`, `no-parking` — derived from which
layer the row came from (the sync script hardcodes the layer-name to
category mapping, no guessing at runtime).

Each layer's `CLASS1`-`CLASS4` fields carry the human-readable hours
text (example: `"2 hr Ticket Monday to Friday 8am-6pm Saturday
8am-noon"`). These follow a small number of recurring patterns across
the ~35 layers — hand-map each layer's pattern once into a
`(days, start_time, end_time, max_stay_minutes)` tuple in the sync
script's config, rather than writing a general free-text parser. This
is a one-time, ~35-entry lookup table, not runtime NLP.

## Output format

`frontend/data/parking.geojson` — a single GeoJSON `FeatureCollection`,
one `Feature` (Point geometry) per parking bay/zone row, `properties`
containing: `category`, `spaces` (NO_SPACES), `angle` (ZONEANGLE),
`hours_text` (raw CLASS1-4, for the popup), `hours_days`,
`hours_start`, `hours_end`, `max_stay_minutes` (the hand-mapped
structured fields, for the client-side "free now" filter),
`exemptions`.

## Frontend

Single `frontend/index.html`, vanilla JS, no build step — same
approach as adelaide-transit-predictor. Reused as-is from that
project: Leaflet + leaflet.markercluster, Esri Gray Canvas basemap
(light/dark pair), the `applyTheme`/`toggleTheme` light/dark system,
`lastKnownPosition` GPS tracking pattern.

New for this project:

- **Font**: Atkinson Hyperlegible instead of Inter — chosen for fast
  at-a-glance legibility over general aesthetics, matches the
  "Accessible & Ethical" design pattern recommended for this kind of
  public utility tool.
- **Color = primary information channel, not text.** Marker fill color
  by category: green = unrestricted, amber = free (timed), red =
  ticket, grey = no-parking/loading, blue = disabled, purple =
  residential/taxi/motorcycle (or split further if testing shows this
  bucket needs separating). Because color alone isn't accessible
  (colorblindness), each category also gets a distinct small icon
  glyph inside the marker, not color alone.
- **Clustering by design, not just performance.** At city-wide/suburb
  zoom, bays cluster into colored blobs sized by count — meant to be
  read as "there's a lot of green here" in under a second. Individual
  bay markers only render past a zoom threshold (roughly street-level
  zoom), which naturally only happens when the user has already slowed
  down or stopped, not while driving at speed.
- **No dense text on the main map view.** Hours, space count, and
  exemptions live inside the marker's tap popup, never as always-on
  map labels.
- **Touch targets**: all buttons (locate, follow-me, free-now filter,
  theme toggle) minimum 44x44px, minimum 8px spacing between adjacent
  targets.
- **Follow-me mode**: a toggle button (map-relative, same corner
  pattern as the existing locate button) that keeps the map centered
  on `lastKnownPosition` as it updates via `watchPosition`, so the map
  pans with the car without the driver touching it. Panning the map
  manually while follow-me is on turns follow-me off automatically
  (standard nav-app pattern — Google/Apple Maps do this) and shows a
  small "re-center" button to turn it back on; this avoids the map
  fighting the driver's own pan/zoom gestures. Off by default on page
  load (opt in, not opt out — the intent is glanceable-when-stopped,
  not "watch the screen while driving").
- **Free-now filter**: a toggle that hides any bay whose
  `hours_days`/`hours_start`/`hours_end`/`max_stay_minutes` says it is
  currently restricted, computed against the device's local clock,
  client-side, no server round-trip.

## Error handling

- **Sync script**: if one layer's query fails (network error, ArcGIS
  service hiccup), log a warning, skip that layer, continue with the
  rest. The GitHub Actions job should still commit whatever succeeded
  rather than fail the whole run over one flaky layer — stale data for
  one category beats no data update at all.
- **Frontend**: if `parking.geojson` fails to fetch (e.g. a deploy
  race), show a small non-blocking banner ("couldn't load parking
  data, try reloading") — same visual pattern as the existing
  offline-banner in adelaide-transit-predictor. Never a blank white
  screen or a JS crash.

## Testing

- Sync script: run locally first (`python sync/sync_parking.py`),
  sanity-check the resulting feature count and category breakdown
  before ever letting GitHub Actions run it unattended.
- Frontend: same manual browser-pane pass used throughout
  adelaide-transit-predictor — load locally, check console for errors,
  verify clustering/colors/popups, verify the free-now filter against
  a manually-injected fake time, verify follow-me against an injected
  fake `lastKnownPosition`, check light/dark theme, check mobile
  viewport width, before pushing.

## Explicitly out of scope for v1

- Live occupancy (on-street sensors are proprietary to the official
  "Park Adelaide" app / Smart Parking Ltd, not open data; off-street
  UPark live data exists and is open, but was deliberately rejected —
  Bao's call: "nếu muốn dùng UPark thì người ta vào UPark luôn cho
  tiện", i.e. it adds a middleman with no value over the source app).
- Turn-by-turn routing to a parking spot.
- Off-street/paid carpark comparison (Wilson, UPark, etc.).
- User accounts, payments.
- Address search / destination-guided journey planning (this was
  explicitly ruled out for the *sibling* transit project for the same
  "keep it minimal" reason and the same call applies here).

## Roadmap (not v1, not scheduled)

- **Real in-app turn-by-turn routing** — Bao wants this eventually, but
  explicitly deferred until phase 1 (this spec) ships:
  *"vậy hãy thêm routing thật in app là task làm trong tương lai khi
  xong phase 1"*. This is a large addition (a routing engine like
  OSRM/GraphHopper, likely its own backend/VM, detailed road-network
  data beyond the Adelaide CBD, no live traffic without a paid third
  party) — closer in size to the rest of this app combined, and should
  get its own brainstorming/design pass when it's actually taken up,
  not be squeezed into this spec.
