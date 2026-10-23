# Adelaide Parking Finder Implementation Plan

> **Execution note:** Bao is implementing this himself, task by task, copying
> code/commands from this plan into his own repo. No subagent or automated
> executor runs this plan — each task's steps are written so he can follow
> them directly. Checkboxes are for him to tick off as he goes.

**Goal:** A static, mobile-first map of Adelaide CBD on-street parking
restrictions (free/ticket/unrestricted/motorcycle/disabled/residential/
taxi/loading/no-parking), fed by a weekly-synced GeoJSON file, no backend.

**Architecture:** GitHub Actions (weekly cron) runs a Python sync script
that queries ~35 ArcGIS FeatureServer layers on `gis.cityofadelaide.com.au`
and writes `frontend/data/parking.geojson`; Vercel serves `frontend/`
statically; the browser fetches that GeoJSON directly, no API server.

**Tech Stack:** Python 3 + `requests` (sync script only, stdlib `unittest`
for its tests), vanilla JS + Leaflet + leaflet.markercluster (frontend, no
build step), GitHub Actions, Vercel.

**Spec:** `docs/superpowers/specs/2026-09-22-adelaide-parking-finder-design.md`
(move the file from the scratchpad path this was drafted at into that path
once the repo exists — Task 1 covers this).

## Global Constraints

- No backend server, no database — this is the whole point of the design (spec §Architecture).
- Data source is `gis.cityofadelaide.com.au` ArcGIS FeatureServer directly, `outSR=4326` on every query (spec §Data source).
- Every feature must carry a `category` field, one of: `free`, `ticket`, `unrestricted`, `motorcycle`, `disabled`, `residential`, `taxi`, `loading`, `no-parking` (spec §Data source).
- Never fabricate or guess a layer's structured hours — if the parser can't confidently extract a time range, leave the structured fields `null` and keep the raw text; never show something as "free now" based on a guess (spec §Data source, and general project safety: wrong parking info can get someone a real fine).
- No em dash character anywhere, in code, comments, strings, or commit messages (global user rule).

---

### Task 1: Repo scaffold

**Files:**
- Create: `README.md`, `.gitignore`
- Create: `sync/requirements.txt`
- Create: `frontend/data/.gitkeep`
- Move: the spec file into `docs/superpowers/specs/2026-09-22-adelaide-parking-finder-design.md`

**Interfaces:** none yet, this task only creates structure.

- [ ] **Step 1: Create the GitHub repo**

Create a new repo named `adelaide-parking-finder` (or whatever name you
prefer) on GitHub, then clone it locally:

```bash
git clone https://github.com/<your-username>/adelaide-parking-finder.git
cd adelaide-parking-finder
```

- [ ] **Step 2: Create the folder structure and base files**

```bash
mkdir -p sync frontend/data docs/superpowers/specs docs/superpowers/plans
```

`.gitignore`:
```
__pycache__/
*.pyc
.venv/
.DS_Store
```

`sync/requirements.txt`:
```
requests==2.32.3
```

`README.md`:
```markdown
# Adelaide Parking Finder

A mobile-first map of on-street parking restrictions in the Adelaide CBD
(free, ticketed, unrestricted, motorcycle, disabled, residential, taxi,
loading zones, no-parking), sourced from the City of Adelaide's public
GIS data. Static site, no backend, data refreshed weekly via GitHub
Actions.

See `docs/superpowers/specs/2026-09-22-adelaide-parking-finder-design.md`
for the full design.
```

- [ ] **Step 3: Copy the spec file in**

Copy the spec from
`C:\Users\trann\AppData\Local\Temp\claude\D--Claude\2d4e5afa-190a-4bdd-a40f-52090bfe78f8\scratchpad\2026-09-22-adelaide-parking-finder-design.md`
into `docs/superpowers/specs/2026-09-22-adelaide-parking-finder-design.md`
in the new repo, and copy this plan file into
`docs/superpowers/plans/2026-09-22-adelaide-parking-finder-plan.md`.

- [ ] **Step 4: Commit**

```bash
git add README.md .gitignore sync/requirements.txt frontend/data/.gitkeep docs/
git commit -m "Scaffold repo structure"
git push
```

---

### Task 2: Layer registry (category + duration + days, no network calls)

**Files:**
- Create: `sync/layers.py`
- Test: `sync/test_layers.py`

**Interfaces:**
- Produces: `LAYERS: list[dict]`, each dict has keys `name` (str, ArcGIS
  service name), `layer_index` (int), `category` (str, one of the 9 valid
  categories), `days` (str, one of `"weekday"`, `"weekend"`, `"any"`),
  `max_stay_minutes` (int | None).

This task hardcodes what we already confirmed by direct query during
design (29 layers) and flags 6 layers whose sub-layer index still needs
verifying against the live service, since ArcGIS doesn't use a fixed
index across different services (Unrestricted_Parking turned out to be
index 3, not 2, when we checked it directly).

- [ ] **Step 1: Write the failing test**

`sync/test_layers.py`:
```python
import unittest
from layers import LAYERS, VALID_CATEGORIES


class TestLayers(unittest.TestCase):
    def test_every_layer_has_required_keys(self):
        required = {"name", "layer_index", "category", "days", "max_stay_minutes"}
        for layer in LAYERS:
            self.assertEqual(required, set(layer.keys()) & required, layer["name"])

    def test_every_category_is_valid(self):
        for layer in LAYERS:
            self.assertIn(layer["category"], VALID_CATEGORIES, layer["name"])

    def test_every_days_value_is_valid(self):
        for layer in LAYERS:
            self.assertIn(layer["days"], {"weekday", "weekend", "any"}, layer["name"])

    def test_no_duplicate_names(self):
        names = [l["name"] for l in LAYERS]
        self.assertEqual(len(names), len(set(names)))

    def test_free_and_ticket_layers_have_a_duration(self):
        for layer in LAYERS:
            if layer["category"] in ("free", "ticket"):
                self.assertIsNotNone(layer["max_stay_minutes"], layer["name"])

    def test_expected_layer_count(self):
        # 29 confirmed during design + 6 pending index verification (Task 2b)
        self.assertEqual(len(LAYERS), 35)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd sync
python -m unittest test_layers.py -v
```
Expected: `ModuleNotFoundError: No module named 'layers'`

- [ ] **Step 3: Write the layer registry**

`sync/layers.py`:
```python
"""Static registry of City of Adelaide ArcGIS FeatureServer parking layers.

Each entry's category, days, and max_stay_minutes are derived from the
layer's own name (which encodes them), not parsed at runtime. Only the
clock start/end time (e.g. "8am-6pm") needs extracting from the layer's
CLASS1 text at sync time, see hours.py.
"""

VALID_CATEGORIES = {
    "free", "ticket", "unrestricted", "motorcycle", "disabled",
    "residential", "taxi", "loading", "no-parking",
}

_BASE = "External_Facing_Data"


def _timed(name, category, days, max_stay_minutes, layer_index=2):
    return {
        "name": f"{_BASE}/{name}",
        "layer_index": layer_index,
        "category": category,
        "days": days,
        "max_stay_minutes": max_stay_minutes,
    }


LAYERS = [
    # Ticket parking, weekday
    _timed("10_Hr_Weekday_Ticket_Parking", "ticket", "weekday", 600),
    _timed("4_Hr_Weekday_Ticket_Parking", "ticket", "weekday", 240),
    _timed("3_Hr_Weekday_Ticket_Parking", "ticket", "weekday", 180),
    _timed("2_Hr_Weekday_Ticket_Parking", "ticket", "weekday", 120),
    _timed("1_Hr_Weekday_Ticket_Parking", "ticket", "weekday", 60),
    _timed("30_Min_Weekday_Ticket_Parking", "ticket", "weekday", 30),
    # Ticket parking, weekend
    _timed("4_Hr_Weekend_Ticket_Parking", "ticket", "weekend", 240),
    _timed("3_Hr_Weekend_Ticket_Parking", "ticket", "weekend", 180),
    _timed("2_Hr_Weekend_Ticket_Parking", "ticket", "weekend", 120),
    _timed("1_Hr_Weekend_Ticket_Parking", "ticket", "weekend", 60),
    _timed("30_Min_Weekend_Ticket_Parking", "ticket", "weekend", 30),
    # Free parking, weekday
    _timed("10_Hr_Weekday_Free_Parking", "free", "weekday", 600),
    _timed("6_Hr_Weekday_Free_Parking", "free", "weekday", 360),
    _timed("5_Hr_Weekday_Free_Parking", "free", "weekday", 300),
    _timed("4_Hr_Weekday_Free_Parking", "free", "weekday", 240),
    _timed("3_Hr_Weekday_Free_Parking", "free", "weekday", 180),
    _timed("2_Hr_Free_Weekday_Parking", "free", "weekday", 120),
    _timed("30_Min_Weekday_Free_Parking", "free", "weekday", 30),
    _timed("15_Min_Weekday_Free_Parking", "free", "weekday", 15),
    # Free parking, weekend
    _timed("6_Hr_Weekend_Free_Parking", "free", "weekend", 360),
    _timed("5_Hr_Weekend_Free_Parking", "free", "weekend", 300),
    _timed("4_Hr_Weekend_Free_Parking", "free", "weekend", 240),
    _timed("3_Hr_Weekend_Free_Parking", "free", "weekend", 180),
    _timed("2_Hr_Weekend_Free_Parking", "free", "weekend", 120),
    _timed("1_Hr_Weekend_Free_Parking", "free", "weekend", 60),
    _timed("30_Min_Weekend_Free_Parking", "free", "weekend", 30, layer_index=3),
    _timed("15_Min_Weekend_Free_Parking", "free", "weekend", 15),
    # No duration in the name, always any-day
    _timed("Unrestricted_Parking", "unrestricted", "any", None, layer_index=3),
    # Layers below: sub-layer index unconfirmed, fix in Task 2b before syncing
    _timed("Motorcycle_Parking", "motorcycle", "any", None, layer_index=None),
    _timed("Disabled_Parking", "disabled", "any", None, layer_index=None),
    _timed("Residential_Parking", "residential", "any", None, layer_index=None),
    _timed("Taxi_Rank", "taxi", "any", None, layer_index=None),
    _timed("Loading_Zones", "loading", "any", None, layer_index=None),
    _timed("No_Parking_Zone", "no-parking", "any", None, layer_index=None),
]
```

- [ ] **Step 4: Run test to verify it passes (except the count, see Step 5)**

```bash
python -m unittest test_layers.py -v
```
Expected: all pass. If `test_expected_layer_count` fails because you
count differently, that's fine, just make sure the count matches
`len(LAYERS)` for now, it'll matter once Task 2b fills in real indices.

- [ ] **Step 5: Commit**

```bash
git add sync/layers.py sync/test_layers.py
git commit -m "Add parking layer registry with category/days/duration"
git push
```

---

### Task 2b: Verify the 6 unconfirmed layer indices

**Files:**
- Modify: `sync/layers.py` (fill in the 6 `layer_index=None` entries)

**Interfaces:**
- Consumes: `LAYERS` from Task 2.
- Produces: `LAYERS` with no `None` `layer_index` values left.

The 6 layers added in Task 2 (Motorcycle_Parking, Disabled_Parking,
Residential_Parking, Taxi_Rank, Loading_Zones, No_Parking_Zone) were
never directly queried during design, so their FeatureServer sub-layer
index (the `/2` or `/3` at the end of the URL) is unconfirmed. ArcGIS
doesn't use a fixed index across different services, guessing wrong
gets you a 404 or the wrong layer's data.

- [ ] **Step 1: Query each service's root to find its point layer**

For each of the 6, open this URL in a browser (or `curl`) and read the
`layers` array in the JSON response, find the one with
`"geometryType": "esriGeometryPoint"`, note its `"id"`:

```
https://gis.cityofadelaide.com.au/server/rest/services/External_Facing_Data/Motorcycle_Parking/FeatureServer?f=json
https://gis.cityofadelaide.com.au/server/rest/services/External_Facing_Data/Disabled_Parking/FeatureServer?f=json
https://gis.cityofadelaide.com.au/server/rest/services/External_Facing_Data/Residential_Parking/FeatureServer?f=json
https://gis.cityofadelaide.com.au/server/rest/services/External_Facing_Data/Taxi_Rank/FeatureServer?f=json
https://gis.cityofadelaide.com.au/server/rest/services/External_Facing_Data/Loading_Zones/FeatureServer?f=json
https://gis.cityofadelaide.com.au/server/rest/services/External_Facing_Data/No_Parking_Zone/FeatureServer?f=json
```

- [ ] **Step 2: Fill in `layer_index` for each of the 6 entries in `sync/layers.py`**

Replace each `layer_index=None` with the real `id` you found.

- [ ] **Step 3: Re-run the layer registry tests**

```bash
cd sync
python -m unittest test_layers.py -v
```
Expected: all pass, no `None` left.

- [ ] **Step 4: Commit**

```bash
git add sync/layers.py
git commit -m "Fill in verified sub-layer indices for the remaining 6 layers"
git push
```

---

### Task 3: ArcGIS fetch with pagination

**Files:**
- Create: `sync/arcgis.py`
- Test: `sync/test_arcgis.py`

**Interfaces:**
- Consumes: nothing from earlier tasks (standalone HTTP helper).
- Produces: `fetch_layer_features(base_url: str, layer_index: int, session=None) -> list[dict]`
  where each returned dict is one ArcGIS feature (`{"attributes": {...}, "geometry": {...}}`),
  already paginated to completion.

- [ ] **Step 1: Write the failing test**

`sync/test_arcgis.py`:
```python
import unittest
from unittest.mock import MagicMock
from arcgis import fetch_layer_features


class TestFetchLayerFeatures(unittest.TestCase):
    def test_single_page(self):
        session = MagicMock()
        session.get.return_value.json.return_value = {
            "features": [{"attributes": {"OBJECTID": 1}, "geometry": {"x": 138.6, "y": -34.9}}],
            "exceededTransferLimit": False,
        }
        result = fetch_layer_features("https://example.com/FeatureServer", 2, session=session)
        self.assertEqual(len(result), 1)
        self.assertEqual(session.get.call_count, 1)

    def test_paginates_until_not_exceeded(self):
        session = MagicMock()
        page1 = {
            "features": [{"attributes": {"OBJECTID": i}, "geometry": {}} for i in range(2)],
            "exceededTransferLimit": True,
        }
        page2 = {
            "features": [{"attributes": {"OBJECTID": 2}, "geometry": {}}],
            "exceededTransferLimit": False,
        }
        session.get.return_value.json.side_effect = [page1, page2]
        result = fetch_layer_features("https://example.com/FeatureServer", 2, session=session)
        self.assertEqual(len(result), 3)
        self.assertEqual(session.get.call_count, 2)

    def test_passes_expected_query_params(self):
        session = MagicMock()
        session.get.return_value.json.return_value = {"features": [], "exceededTransferLimit": False}
        fetch_layer_features("https://example.com/FeatureServer", 2, session=session)
        _, kwargs = session.get.call_args
        params = kwargs["params"]
        self.assertEqual(params["outSR"], 4326)
        self.assertEqual(params["where"], "1=1")
        self.assertEqual(params["outFields"], "*")
        self.assertEqual(params["f"], "json")
        self.assertEqual(params["resultOffset"], 0)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd sync
python -m unittest test_arcgis.py -v
```
Expected: `ModuleNotFoundError: No module named 'arcgis'`

- [ ] **Step 3: Write the implementation**

`sync/arcgis.py`:
```python
"""Thin client for querying an ArcGIS FeatureServer layer with pagination."""
import requests

PAGE_SIZE = 1000


def fetch_layer_features(base_url: str, layer_index: int, session=None) -> list[dict]:
    """Fetch every feature from one FeatureServer layer, following ArcGIS's
    exceededTransferLimit pagination until a page reports no more remain."""
    session = session or requests.Session()
    url = f"{base_url}/{layer_index}/query"
    features = []
    offset = 0
    while True:
        params = {
            "where": "1=1",
            "outFields": "*",
            "f": "json",
            "outSR": 4326,
            "resultOffset": offset,
            "resultRecordCount": PAGE_SIZE,
        }
        response = session.get(url, params=params, timeout=30)
        data = response.json()
        page = data.get("features", [])
        features.extend(page)
        if not data.get("exceededTransferLimit", False):
            break
        offset += len(page)
    return features
```

- [ ] **Step 4: Run test to verify it passes**

```bash
python -m unittest test_arcgis.py -v
```
Expected: PASS, all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add sync/arcgis.py sync/test_arcgis.py
git commit -m "Add ArcGIS FeatureServer client with pagination"
git push
```

---

### Task 4: Clock-time extraction from CLASS1 text

**Files:**
- Create: `sync/hours.py`
- Test: `sync/test_hours.py`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure string function).
- Produces: `extract_time_range(text: str) -> tuple[str, str] | None`,
  returns `(start, end)` as `"HH:MM"` 24-hour strings, or `None` if no
  confident match, never a guess.

Only extracts the clock start/end time, since `days` and
`max_stay_minutes` already come from the layer registry (Task 2), not
from this text. The two verified real samples from design are
`"Unrestricted"` (no time range) and
`"2 hr Ticket Monday to Friday 8am-6pm Saturday 8am-noon"` (time range
`8am-6pm`, the first one found). If real data later has a layer whose
text this doesn't match, `extract_time_range` returns `None` for it
rather than guessing, log those in Task 5 and extend this function
instead of hardcoding a guess.

- [ ] **Step 1: Write the failing test**

`sync/test_hours.py`:
```python
import unittest
from hours import extract_time_range


class TestExtractTimeRange(unittest.TestCase):
    def test_real_sample_weekday_ticket(self):
        text = "2 hr Ticket Monday to Friday 8am-6pm Saturday 8am-noon"
        self.assertEqual(extract_time_range(text), ("08:00", "18:00"))

    def test_unrestricted_has_no_time_range(self):
        self.assertIsNone(extract_time_range("Unrestricted"))

    def test_empty_string(self):
        self.assertIsNone(extract_time_range(""))

    def test_none_input(self):
        self.assertIsNone(extract_time_range(None))

    def test_pm_start_and_end(self):
        self.assertEqual(extract_time_range("Ticket 2pm-6pm"), ("14:00", "18:00"))

    def test_noon_as_end(self):
        self.assertEqual(extract_time_range("Free 8am-noon"), ("08:00", "12:00"))

    def test_midnight_as_end(self):
        self.assertEqual(extract_time_range("Free 8am-midnight"), ("08:00", "00:00"))

    def test_unrecognized_text_returns_none_not_a_guess(self):
        self.assertIsNone(extract_time_range("Permit holders only, see sign"))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd sync
python -m unittest test_hours.py -v
```
Expected: `ModuleNotFoundError: No module named 'hours'`

- [ ] **Step 3: Write the implementation**

`sync/hours.py`:
```python
"""Extract a clock start/end time range from a City of Adelaide CLASS1
restriction text, e.g. "2 hr Ticket Monday to Friday 8am-6pm Saturday
8am-noon" -> ("08:00", "18:00"). Deliberately conservative: returns
None rather than guessing when the text doesn't match a known shape,
since a wrong "free now" claim can get a driver a real fine.
"""
import re

_TIME = r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)|noon|midnight"
_RANGE = re.compile(rf"({_TIME})\s*-\s*({_TIME})", re.IGNORECASE)


def _to_24h(hour_str, minute_str, meridiem, whole_match):
    whole_match = whole_match.strip().lower()
    if whole_match == "noon":
        return "12:00"
    if whole_match == "midnight":
        return "00:00"
    hour = int(hour_str)
    minute = int(minute_str) if minute_str else 0
    meridiem = meridiem.lower()
    if meridiem == "am":
        hour = 0 if hour == 12 else hour
    else:
        hour = 12 if hour == 12 else hour + 12
    return f"{hour:02d}:{minute:02d}"


def extract_time_range(text: str) -> tuple[str, str] | None:
    if not text:
        return None
    match = _RANGE.search(text)
    if not match:
        return None
    start_whole, start_h, start_m, start_mer, end_whole, end_h, end_m, end_mer = match.groups()
    start = _to_24h(start_h, start_m, start_mer, start_whole)
    end = _to_24h(end_h, end_m, end_mer, end_whole)
    return (start, end)
```

- [ ] **Step 4: Run test to verify it passes**

```bash
python -m unittest test_hours.py -v
```
Expected: PASS, all 8 tests. If `test_real_sample_weekday_ticket` picks
up "8am-noon" instead of "8am-6pm" (the regex is greedy left-to-right
so it should find the first range first, but double check), fix the
regex to anchor on the first match only, which it already does via
`.search()` returning the first match in the string.

- [ ] **Step 5: Commit**

```bash
git add sync/hours.py sync/test_hours.py
git commit -m "Add clock-time-range extractor for CLASS1 restriction text"
git push
```

---

### Task 5: Build the GeoJSON and run the sync for real

**Files:**
- Create: `sync/sync_parking.py`
- Test: `sync/test_sync_parking.py`

**Interfaces:**
- Consumes: `LAYERS` (Task 2), `fetch_layer_features` (Task 3), `extract_time_range` (Task 4).
- Produces: `build_feature(arcgis_feature: dict, layer: dict) -> dict` (one GeoJSON Feature),
  `main()` (writes `frontend/data/parking.geojson`).

- [ ] **Step 1: Write the failing test**

`sync/test_sync_parking.py`:
```python
import unittest
from sync_parking import build_feature


class TestBuildFeature(unittest.TestCase):
    def test_builds_geojson_point_feature(self):
        arcgis_feature = {
            "attributes": {
                "CTYPE_1": "Ticket",
                "NO_SPACES": 13,
                "ZONEANGLE": "90",
                "CLASS1": "2 hr Ticket Monday to Friday 8am-6pm Saturday 8am-noon",
                "CLASS2": " ",
                "CLASS3": " ",
                "CLASS4": " ",
                "Exemptions": None,
            },
            "geometry": {"x": 138.612, "y": -34.927},
        }
        layer = {
            "category": "ticket",
            "days": "weekday",
            "max_stay_minutes": 120,
        }

        feature = build_feature(arcgis_feature, layer)

        self.assertEqual(feature["type"], "Feature")
        self.assertEqual(feature["geometry"], {"type": "Point", "coordinates": [138.612, -34.927]})
        props = feature["properties"]
        self.assertEqual(props["category"], "ticket")
        self.assertEqual(props["spaces"], 13)
        self.assertEqual(props["angle"], "90")
        self.assertEqual(props["hours_text"], "2 hr Ticket Monday to Friday 8am-6pm Saturday 8am-noon")
        self.assertEqual(props["hours_days"], "weekday")
        self.assertEqual(props["hours_start"], "08:00")
        self.assertEqual(props["hours_end"], "18:00")
        self.assertEqual(props["max_stay_minutes"], 120)
        self.assertIsNone(props["exemptions"])

    def test_missing_time_range_leaves_hours_null_not_a_guess(self):
        arcgis_feature = {
            "attributes": {
                "CTYPE_1": "Unrestricted", "NO_SPACES": 7, "ZONEANGLE": "60",
                "CLASS1": "Unrestricted", "CLASS2": " ", "CLASS3": " ", "CLASS4": " ",
                "Exemptions": None,
            },
            "geometry": {"x": 138.6, "y": -34.9},
        }
        layer = {"category": "unrestricted", "days": "any", "max_stay_minutes": None}

        feature = build_feature(arcgis_feature, layer)

        self.assertIsNone(feature["properties"]["hours_start"])
        self.assertIsNone(feature["properties"]["hours_end"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd sync
python -m unittest test_sync_parking.py -v
```
Expected: `ModuleNotFoundError: No module named 'sync_parking'`

- [ ] **Step 3: Write the implementation**

`sync/sync_parking.py`:
```python
"""Sync all City of Adelaide on-street parking layers into one
frontend/data/parking.geojson FeatureCollection. Run weekly by GitHub
Actions (see .github/workflows/sync-parking-data.yml), safe to run
locally too: python sync_parking.py
"""
import json
import sys
from pathlib import Path

from layers import LAYERS
from arcgis import fetch_layer_features
from hours import extract_time_range

BASE_SERVICE_URL = "https://gis.cityofadelaide.com.au/server/rest/services"
OUTPUT_PATH = Path(__file__).parent.parent / "frontend" / "data" / "parking.geojson"


def build_feature(arcgis_feature: dict, layer: dict) -> dict:
    attrs = arcgis_feature["attributes"]
    geom = arcgis_feature["geometry"]
    hours_text = " ".join(
        (attrs.get(f"CLASS{i}") or "").strip() for i in range(1, 5)
    ).strip()
    time_range = extract_time_range(hours_text)
    start, end = time_range if time_range else (None, None)
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [geom["x"], geom["y"]]},
        "properties": {
            "category": layer["category"],
            "spaces": attrs.get("NO_SPACES"),
            "angle": attrs.get("ZONEANGLE"),
            "hours_text": hours_text or None,
            "hours_days": layer["days"],
            "hours_start": start,
            "hours_end": end,
            "max_stay_minutes": layer["max_stay_minutes"],
            "exemptions": attrs.get("Exemptions"),
        },
    }


def main():
    features = []
    unmatched_hours = []
    for layer in LAYERS:
        if layer["layer_index"] is None:
            print(f"skipping {layer['name']}: layer_index not set, run Task 2b", file=sys.stderr)
            continue
        base_url = f"{BASE_SERVICE_URL}/{layer['name']}/FeatureServer"
        try:
            arcgis_features = fetch_layer_features(base_url, layer["layer_index"])
        except Exception as e:
            print(f"skipping {layer['name']}: {e}", file=sys.stderr)
            continue
        for f in arcgis_features:
            built = build_feature(f, layer)
            if layer["category"] in ("free", "ticket") and built["properties"]["hours_start"] is None:
                unmatched_hours.append((layer["name"], built["properties"]["hours_text"]))
            features.append(built)
        print(f"{layer['name']}: {len(arcgis_features)} features")

    geojson = {"type": "FeatureCollection", "features": features}
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(geojson))
    print(f"wrote {len(features)} features to {OUTPUT_PATH}")

    if unmatched_hours:
        print(f"\n{len(unmatched_hours)} free/ticket features had no extractable hours, review these:", file=sys.stderr)
        seen = set()
        for name, text in unmatched_hours:
            key = (name, text)
            if key not in seen:
                seen.add(key)
                print(f"  {name}: {text!r}", file=sys.stderr)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

```bash
python -m unittest test_sync_parking.py -v
```
Expected: PASS, both tests.

- [ ] **Step 5: Run the real sync**

```bash
cd sync
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python sync_parking.py
```

Watch the output. If it prints a list of "features had no extractable
hours" for `free`/`ticket` layers, open a couple of those exact
`hours_text` strings and extend `extract_time_range`'s regex in
`sync/hours.py` (re-run its tests after) until that list is empty or
only contains genuinely unusual signage text.

Check `frontend/data/parking.geojson` was written and its feature
count roughly matches what you'd expect (thousands, not zero, not
millions).

- [ ] **Step 6: Commit**

```bash
git add sync/sync_parking.py sync/test_sync_parking.py frontend/data/parking.geojson
git commit -m "Add sync script, generate first parking.geojson"
git push
```

---

### Task 6: Frontend scaffold (map, tiles, theme)

**Files:**
- Create: `frontend/index.html`

**Interfaces:**
- Consumes: `frontend/data/parking.geojson` (Task 5).
- Produces: a working map page, no parking-specific rendering yet (that's Task 7+).

This reuses the Leaflet + Esri Gray Canvas + light/dark theme pattern
from the sibling `adelaide-transit-predictor` project's
`frontend/index.html` almost verbatim, minus everything
transit-specific (stops, arrivals, countdown, reminders). Open that
file for reference while building this one, same tile URLs, same
`applyTheme`/`toggleTheme` structure, same CSS variable approach.

- [ ] **Step 1: Write the HTML/CSS shell with the theme system**

`frontend/index.html` (part 1, head + CSS):
```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Adelaide Parking Finder</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css" />
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #ffffff;
  --panel: #f8fafc;
  --card: #ffffff;
  --line: #e2e8f0;
  --text: #0f172a;
  --muted: #475569;
  --accent: #2563eb;
  --accent-ink: #ffffff;
  --unrestricted: #16a34a;
  --free: #f59e0b;
  --ticket: #dc2626;
  --other: #7c3aed;
  --no-parking: #64748b;
  --shadow: 0 2px 8px rgba(0,0,0,0.12);
  --radius: 12px;
}
:root[data-theme="dark"] {
  --bg: #0f172a;
  --panel: #1e293b;
  --card: #1e293b;
  --line: rgba(255,255,255,0.08);
  --text: #f1f5f9;
  --muted: #94a3b8;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f172a;
    --panel: #1e293b;
    --card: #1e293b;
    --line: rgba(255,255,255,0.08);
    --text: #f1f5f9;
    --muted: #94a3b8;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; font-family: 'Atkinson Hyperlegible', sans-serif; background: var(--bg); color: var(--text); }
#map { position: absolute; inset: 0; }
.control-btn {
  min-width: 44px; min-height: 44px;
  background: var(--card); color: var(--text);
  border: 1px solid var(--line); border-radius: var(--radius);
  box-shadow: var(--shadow); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px;
}
#controls {
  position: absolute; top: 16px; right: 16px; z-index: 500;
  display: flex; flex-direction: column; gap: 8px;
}
#status-banner {
  position: absolute; top: 16px; left: 16px; right: 76px; z-index: 500;
  background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 10px 14px; box-shadow: var(--shadow); font-size: 14px; color: var(--muted);
  display: none;
}
</style>
</head>
<body>
<div id="map"></div>
<div id="status-banner"></div>
<div id="controls">
  <button id="theme-toggle" class="control-btn" title="Toggle theme">&#9728;</button>
  <button id="locate-btn" class="control-btn" title="My location">&#9678;</button>
  <button id="follow-btn" class="control-btn" title="Follow me">&#9673;</button>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
<script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write the base map JS (tiles, theme, geojson load)**

`frontend/app.js`:
```javascript
const THEME_KEY = "apf_theme";

const lightTiles = "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const darkTiles = "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const lightRef = "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}";
const darkRef = "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}";

const map = L.map("map", { zoomControl: false }).setView([-34.9285, 138.6007], 15);
const baseTiles = L.tileLayer(lightTiles, { maxZoom: 19 }).addTo(map);
const refTiles = L.tileLayer(lightRef, { maxZoom: 19 }).addTo(map); // added after base, layers on top by default
L.control.zoom({ position: "bottomright" }).addTo(map);

function currentTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_KEY, theme);
  baseTiles.setUrl(theme === "dark" ? darkTiles : lightTiles);
  refTiles.setUrl(theme === "dark" ? darkRef : lightRef);
  document.getElementById("theme-toggle").textContent = theme === "dark" ? "\u2600" : "\u263D";
}

document.getElementById("theme-toggle").addEventListener("click", () => {
  applyTheme(currentTheme() === "dark" ? "light" : "dark");
});
applyTheme(currentTheme());

function showStatus(message) {
  const el = document.getElementById("status-banner");
  el.textContent = message;
  el.style.display = message ? "block" : "none";
}

async function loadParkingData() {
  try {
    const response = await fetch("data/parking.geojson");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    showStatus("Couldn't load parking data, try reloading.");
    return null;
  }
}

loadParkingData().then((geojson) => {
  if (geojson) {
    window.__parkingData = geojson;
    console.log(`loaded ${geojson.features.length} parking features`);
  }
});
```

- [ ] **Step 3: Test it manually**

You don't have a local dev server yet, use Python's built-in one:

```bash
cd frontend
python -m http.server 5173
```

Open `http://localhost:5173` in a browser. You should see the Adelaide
CBD map, tiles loading, theme toggle working (check both light and
dark, and that it persists on reload). Open devtools console, confirm
you see `loaded N parking features` with a real number (from the
`parking.geojson` Task 5 generated). If you see the "Couldn't load
parking data" banner instead, check the file actually exists at
`frontend/data/parking.geojson` and the dev server's working directory
is `frontend/`.

- [ ] **Step 4: Commit**

```bash
cd ..
git add frontend/index.html frontend/app.js
git commit -m "Add frontend scaffold: map, tiles, theme, geojson load"
git push
```

---

### Task 7: Render parking markers with category colors and clustering

**Files:**
- Modify: `frontend/app.js`

**Interfaces:**
- Consumes: `window.__parkingData` (Task 6), Leaflet's `L.markerClusterGroup`.
- Produces: `renderParkingLayer(geojson)`, called once data loads.

- [ ] **Step 1: Add the category-to-color map and marker builder**

Append to `frontend/app.js`:
```javascript
const CATEGORY_COLOR = {
  unrestricted: "#16a34a",
  free: "#f59e0b",
  ticket: "#dc2626",
  "no-parking": "#64748b",
  disabled: "#7c3aed",
  motorcycle: "#7c3aed",
  residential: "#7c3aed",
  taxi: "#7c3aed",
  loading: "#7c3aed",
};

const CATEGORY_LABEL = {
  unrestricted: "Unrestricted",
  free: "Free (timed)",
  ticket: "Ticket",
  "no-parking": "No parking",
  disabled: "Disabled permit",
  motorcycle: "Motorcycle",
  residential: "Residential permit",
  taxi: "Taxi rank",
  loading: "Loading zone",
};

// Short glyph per category so markers are distinguishable without relying
// on color alone (color-blind accessibility, spec requirement).
const CATEGORY_GLYPH = {
  unrestricted: "U",
  free: "F",
  ticket: "$",
  "no-parking": "X",
  disabled: "P",
  motorcycle: "M",
  residential: "R",
  taxi: "T",
  loading: "L",
};

function makeMarkerIcon(category) {
  const color = CATEGORY_COLOR[category] || "#64748b";
  const glyph = CATEGORY_GLYPH[category] || "?";
  return L.divIcon({
    className: "",
    html: `<div style="width:20px;height:20px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:white;font-family:'Atkinson Hyperlegible',sans-serif">${glyph}</div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

function popupHtml(props) {
  const label = CATEGORY_LABEL[props.category] || props.category;
  const spaces = props.spaces != null ? `${props.spaces} space${props.spaces === 1 ? "" : "s"}` : "";
  const hours = props.hours_text || "";
  return `<strong>${label}</strong><br>${spaces}${spaces && hours ? " &middot; " : ""}${hours}`;
}

let parkingLayer = null;

function renderParkingLayer(geojson) {
  parkingLayer = L.markerClusterGroup({ maxClusterRadius: 50 });
  const layer = L.geoJSON(geojson, {
    pointToLayer: (feature, latlng) => L.marker(latlng, { icon: makeMarkerIcon(feature.properties.category) }),
    onEachFeature: (feature, marker) => marker.bindPopup(popupHtml(feature.properties)),
  });
  parkingLayer.addLayer(layer);
  parkingLayer.addTo(map);
}
```

- [ ] **Step 2: Call it after data loads**

Replace the `loadParkingData().then(...)` block at the bottom of
`frontend/app.js` with:
```javascript
loadParkingData().then((geojson) => {
  if (geojson) {
    window.__parkingData = geojson;
    renderParkingLayer(geojson);
  }
});
```

- [ ] **Step 3: Test it manually**

Reload `http://localhost:5173`. You should see colored dots clustered
into numbered blobs at city zoom, zoom in and they should split apart
into individual colored markers, tap one to see the popup with
category/spaces/hours. Check both light and dark theme, check a couple
of different categories actually show different colors (compare a
green unrestricted spot to a red ticket spot).

- [ ] **Step 4: Commit**

```bash
git add frontend/app.js
git commit -m "Render parking markers with category colors and clustering"
git push
```

---

### Task 8: Free-now filter

**Files:**
- Modify: `frontend/index.html` (add the filter toggle button)
- Modify: `frontend/app.js`

**Interfaces:**
- Consumes: `parkingLayer`, `CATEGORY_COLOR` (Task 7), feature properties
  `hours_days`, `hours_start`, `hours_end`, `max_stay_minutes` (Task 5).
- Produces: `isFreeRightNow(props: object, now: Date) -> bool`.

Only `free` and `ticket` categories are time-gated (the point of this
filter is "can I park here for free right now"). Every other category
is always shown regardless of the filter, since they're not
availability info in the same sense (a disabled bay isn't "free" just
because it's currently within some time window, a no-parking zone is
never an option).

- [ ] **Step 1: Add the filter button to the HTML**

In `frontend/index.html`, inside `#controls`, after the follow button:
```html
  <button id="free-now-btn" class="control-btn" title="Show only free right now">&#128337;</button>
```

- [ ] **Step 2: Write `isFreeRightNow` and wire the toggle**

Append to `frontend/app.js`:
```javascript
function isFreeRightNow(props, now = new Date()) {
  if (props.category !== "free" && props.category !== "ticket") return true;
  if (!props.hours_start || !props.hours_end) return true; // unknown hours: don't hide it, we're not sure
  const day = now.getDay(); // 0 = Sunday
  const isWeekend = day === 0 || day === 6;
  if (props.hours_days === "weekday" && isWeekend) return true;
  if (props.hours_days === "weekend" && !isWeekend) return true;
  const [startH, startM] = props.hours_start.split(":").map(Number);
  const [endH, endM] = props.hours_end.split(":").map(Number);
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH === 0 && endM === 0 ? 24 * 60 : endH * 60 + endM;
  const insideRestrictedWindow = minutesNow >= startMinutes && minutesNow < endMinutes;
  return !insideRestrictedWindow; // free means outside the restricted window
}

let freeNowActive = false;

function applyFreeNowFilter() {
  if (!parkingLayer || !window.__parkingData) return;
  const now = new Date();
  // Rebuild the layer from source data with the filter applied, simpler
  // and less error-prone than mutating markers inside the cluster group.
  map.removeLayer(parkingLayer);
  parkingLayer = L.markerClusterGroup({ maxClusterRadius: 50 });
  const filtered = {
    type: "FeatureCollection",
    features: window.__parkingData.features.filter((f) => !freeNowActive || isFreeRightNow(f.properties, now)),
  };
  const layer = L.geoJSON(filtered, {
    pointToLayer: (feature, latlng) => L.marker(latlng, { icon: makeMarkerIcon(feature.properties.category) }),
    onEachFeature: (feature, marker) => marker.bindPopup(popupHtml(feature.properties)),
  });
  parkingLayer.addLayer(layer);
  parkingLayer.addTo(map);
}

document.getElementById("free-now-btn").addEventListener("click", (e) => {
  freeNowActive = !freeNowActive;
  e.target.style.background = freeNowActive ? "var(--accent)" : "var(--card)";
  e.target.style.color = freeNowActive ? "var(--accent-ink)" : "var(--text)";
  applyFreeNowFilter();
});
```

- [ ] **Step 3: Test it manually**

Reload, click the free-now button, confirm ticket/free markers whose
current time falls inside their restricted window disappear, and
unrestricted/disabled/motorcycle/etc markers never disappear. To test
both branches without waiting for a real time boundary, open devtools
console and temporarily call
`isFreeRightNow({category: "ticket", hours_days: "weekday", hours_start: "08:00", hours_end: "18:00"}, new Date("2026-09-23T10:00:00"))`
(should be `false`, a Wednesday at 10am) and again with
`new Date("2026-09-23T20:00:00")` (should be `true`, after 6pm).

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/app.js
git commit -m "Add free-now filter"
git push
```

---

### Task 9: Locate and follow-me

**Files:**
- Modify: `frontend/app.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `lastKnownPosition` (global), locate/follow button behavior.

- [ ] **Step 1: Add location tracking and the two buttons' behavior**

Append to `frontend/app.js`:
```javascript
let lastKnownPosition = null;
let userMarker = null;
let followActive = false;

function setUserLocation(lat, lng) {
  lastKnownPosition = { lat, lng };
  if (!userMarker) {
    userMarker = L.circleMarker([lat, lng], {
      radius: 8, color: "#2563eb", fillColor: "#2563eb", fillOpacity: 1, weight: 2,
    }).addTo(map);
  } else {
    userMarker.setLatLng([lat, lng]);
  }
  if (followActive) {
    map.panTo([lat, lng], { animate: true });
  }
}

if (navigator.geolocation) {
  navigator.geolocation.watchPosition(
    (pos) => setUserLocation(pos.coords.latitude, pos.coords.longitude),
    () => showStatus("Couldn't get your location."),
    { enableHighAccuracy: true, maximumAge: 15000 }
  );
}

document.getElementById("locate-btn").addEventListener("click", () => {
  if (lastKnownPosition) {
    map.panTo([lastKnownPosition.lat, lastKnownPosition.lng], { animate: true });
  } else {
    showStatus("Still finding your location...");
  }
});

const followBtn = document.getElementById("follow-btn");
function setFollow(active) {
  followActive = active;
  followBtn.style.background = active ? "var(--accent)" : "var(--card)";
  followBtn.style.color = active ? "var(--accent-ink)" : "var(--text)";
}
followBtn.addEventListener("click", () => {
  setFollow(!followActive);
  if (followActive && lastKnownPosition) {
    map.panTo([lastKnownPosition.lat, lastKnownPosition.lng], { animate: true });
  }
});

// Manual pan/zoom turns follow-me off, same pattern as Google/Apple Maps,
// so the map never fights the driver's own gesture.
map.on("dragstart", () => { if (followActive) setFollow(false); });
```

- [ ] **Step 2: Test it manually**

Your browser will ask for location permission, allow it, confirm your
blue dot appears and the locate button pans to it. Click follow, drag
the map, confirm follow turns itself off (button loses its highlight).
If testing in an environment that can't grant real geolocation, open
devtools console and call
`setUserLocation(-34.9285, 138.6007)` directly to simulate a position
update, then `setFollow(true)` and call `setUserLocation` again with a
slightly different coordinate, confirm the map pans.

- [ ] **Step 3: Commit**

```bash
git add frontend/app.js
git commit -m "Add locate and follow-me"
git push
```

---

### Task 10: GitHub Actions weekly sync + Vercel deploy

**Files:**
- Create: `.github/workflows/sync-parking-data.yml`

**Interfaces:** none, this is deployment config, not code other tasks depend on.

- [ ] **Step 1: Write the workflow**

`.github/workflows/sync-parking-data.yml`:
```yaml
name: Sync parking data

on:
  schedule:
    - cron: "0 18 * * 0"   # Sunday 18:00 UTC = Monday ~03:30-04:30 ACST/ACDT
  workflow_dispatch: {}

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install -r sync/requirements.txt
      - run: python sync/sync_parking.py
        working-directory: sync
      - name: Commit if changed
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add frontend/data/parking.geojson
          git diff --staged --quiet || git commit -m "Weekly parking data sync"
          git push
```

- [ ] **Step 2: Push it and test manually**

```bash
git add .github/workflows/sync-parking-data.yml
git commit -m "Add weekly parking data sync workflow"
git push
```

On GitHub, go to the repo's Actions tab, select "Sync parking data",
click "Run workflow" to trigger it manually (don't wait a week to find
out if it works). Confirm it runs green and, if the data actually
changed, that it commits.

- [ ] **Step 3: Deploy to Vercel**

In the Vercel dashboard: New Project, import the `adelaide-parking-finder`
GitHub repo, set root directory to `frontend`, deploy. No environment
variables needed, no `vercel.json` needed (matches how
adelaide-transit-predictor's frontend is configured).

- [ ] **Step 4: Verify the live site**

Open the Vercel URL on your phone, confirm the map loads, markers
render, theme toggle/free-now/locate/follow all work on a real mobile
browser, not just desktop devtools' mobile emulation.
