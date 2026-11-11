# Adelaide Parking Finder

A phone-first map of every on-street parking bay in the Adelaide CBD, built so a driver can glance at it and know where they can park right now.

Live: https://adelaide-parking-finder.vercel.app

## What it does

- Shows free (time limited), ticket, unrestricted, motorcycle, disabled, residential, taxi, loading and no-parking bays. Each map tag copies the real sign, so a 2 hour bay reads **2P**.
- Tap a bay to see what applies at that moment, for example "Ticket, 2 hours max, until 6pm", when you need to move the car, and when the rules change soon. One tap opens directions in Google Maps (or Apple Maps on an iPhone).
- **Search** a street or place and the map jumps to it.
- **Filters** answer the questions a driver actually has:
  - *How long do you need?* 30 min, 1 hr, 2 hr, 3 hr, 4 hr or all day. The limit is checked against the time you would spend inside each sign's hours, so a 2 hour bay that stops applying at 6pm still counts for a longer stay that starts at 5pm.
  - *Free only* hides bays where you would have to pay during your stay.
  - *When*: now, or any day and time in the coming week.
  - *Vehicle*: car, motorbike or disability permit. You only see bays you can legally use.
  - *Only bays with a readable sign* hides the bays marked "Check the sign".
  - Quick chips on the map (Free now, 1 hr+, 2 hr+, 4 hr+) set the same filters in one tap.
- **Follow me** keeps the map centred on the car. Dragging the map turns it off, like Google Maps.
- Light and dark map, large touch targets, readable font (Atkinson Hyperlegible), works one-handed.
- Works offline once opened: the app, the last parking data and the map tiles you have looked at are kept on the phone. Add it to the home screen and it opens like an app.

"Free" means no payment. It does not mean there is an empty space, because the council publishes no live availability.

## Staying honest about the data

A wrong "you can park here" costs someone a real fine, so the app says "Check the sign" instead of guessing.

- Council sign text often holds several signs in one field, for example "No Stopping Monday to Friday 7am-10am 3 hr Ticket Monday to Friday 10am-7pm Saturday & Sunday 7am-7pm". `sync/hours.py` splits it into signs and reads each one: its days, times, time limit, whether it is a ticket, and the periods when you cannot park at all (No Stopping, Bus Lane, Loading, Taxi, Residents only, including "At all other times"). Different limits on weekdays and weekends are kept apart.
- If any part of the text cannot be read, or the sign and the council layer disagree, the bay is marked "Check the sign".
- About 73% of free and ticket bays have readable hours (3,000 of 4,123 on 10 Nov 2026). Most of the rest have no sign text at all in the council data.
- All rules use Adelaide time, whatever time the phone says.
- The app shows when the data was last checked, and warns if the daily update stops for more than 3 days or the council server is down.
- Public holidays and event days are not modelled. The sign on the street always wins.

## How it works

There is no backend. A Python script pulls the City of Adelaide's 34 public parking layers (ArcGIS FeatureServer), turns the sign text into rules, and writes one static file, `frontend/data/parking.geojson`. GitHub Actions runs it every day and commits only when something changed, Vercel redeploys on each commit, and the browser loads the file directly.

```
council ArcGIS  ->  sync/sync_parking.py (GitHub Actions, daily)  ->  frontend/data/*.json  ->  Vercel  ->  phone
```

`frontend/data/status.json` records whether the council server answered, when the data was checked and last changed, and how many bays could not be read. If the council server is down, the old data stays in place and the site shows a notice.

The map shows only what is on screen. About 6,000 bays are grouped with [Supercluster](https://github.com/mapbox/supercluster) and only the visible tags are ever in the page, so it stays smooth on an older phone. MapLibre GL and Supercluster are self-hosted in `frontend/vendor`, so the page loads from one origin and runs under a strict Content-Security-Policy (see `vercel.json`).

| File | Job |
| --- | --- |
| `frontend/logic.js` | Pure rules: Adelaide time, what applies to a bay at a moment, the filters. Runs in the browser and in Node. |
| `frontend/app.js` | Map, chips, filter sheet, search, banners. |
| `frontend/sw.js` | Offline: caches the app, the data and map tiles. |
| `sync/hours.py` | Reads council sign text into rules. |

## Run it yourself

```bash
cd sync
python -m venv .venv
.venv/Scripts/activate        # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python -m unittest -v
python sync_parking.py
cd ../frontend
python -m http.server 5190    # then open http://localhost:5190
```

## Tests

```bash
cd sync && python -m unittest -v      # sign reading, data build
node --test tests/logic.test.js       # time, rules, filters (Node 20 or newer)
```

CI runs both on every push (`.github/workflows/ci.yml`).

## Data

Parking data: City of Adelaide, licensed CC BY 4.0 (data.sa.gov.au, "On-Street Parking Zones"). Base map: OpenFreeMap, OpenMapTiles, OpenStreetMap contributors. Search: OpenStreetMap Nominatim (what you type is sent to them, only when you press search). This is an independent project, not affiliated with the council. Always follow the sign on the street.
