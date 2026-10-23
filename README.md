# Adelaide Parking Finder

A phone-first map of every on-street parking bay in the Adelaide CBD, built so a driver can glance at it and know where they can park right now.

Live: https://adelaide-parking-finder.vercel.app

## What it does

- Shows free (time limited), ticket, unrestricted, motorcycle, disabled, residential, taxi, loading and no-parking bays. Each map tag copies the real sign, so a 2 hour bay reads **2P**.
- Tap a bay to see what applies at this moment, for example "Ticket, 2 hours max, until 6pm" or "No limit right now".
- **Free now** hides bays you'd have to pay for (or can't use) at the current time, and keeps re-checking as the clock moves.
- **Follow me** keeps the map centred on the car. Dragging the map turns it off, like Google Maps.
- Light and dark map, large touch targets, readable font (Atkinson Hyperlegible), works one-handed.

When the sign text can't be read with confidence, the app says "Check the sign" instead of guessing. A wrong "free now" costs someone a real fine.

## How it works

There is no backend. A Python script pulls the City of Adelaide's 34 public parking layers (ArcGIS FeatureServer), turns the sign text into time windows, and writes one static file, `frontend/data/parking.geojson`. GitHub Actions runs it every day and commits only when something changed, Vercel redeploys on each commit, and the browser loads the file directly.

```
council ArcGIS  ->  sync/sync_parking.py (GitHub Actions, daily)  ->  frontend/data/*.json  ->  Vercel  ->  phone
```

`frontend/data/status.json` records whether the council server answered. If it is down, the old data stays in place and the site shows a notice saying the problem is on the council's side.

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

## Data

Parking data: City of Adelaide, licensed CC BY 4.0 (data.sa.gov.au, "On-Street Parking Zones"). Base map: Esri, OpenStreetMap contributors. This is an independent project, not affiliated with the council. Always follow the sign on the street.
