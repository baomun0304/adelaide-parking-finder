"""Pull every City of Adelaide on-street parking layer into frontend/data/.

Writes two files:
  parking.geojson  all bays, only replaced when EVERY layer downloaded fine
  status.json      whether the council server answered, and since when

Run it locally with `python sync/sync_parking.py`. GitHub Actions runs it daily.
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

from arcgis import fetch_layer
from hours import parse_sign
from layers import LAYERS

SERVICE_ROOT = "https://gis.cityofadelaide.com.au/server/rest/services/External_Facing_Data"
DATA_DIR = Path(__file__).resolve().parent.parent / "frontend" / "data"


def build_feature(raw, layer):
    attrs, geom = raw["attributes"], raw["geometry"]
    hours_text = " ".join((attrs.get(f"CLASS{i}") or "").strip() for i in range(1, 5)).strip()
    hours_text = " ".join(hours_text.split())  # the council pads some fields with spaces
    timed = layer["category"] in ("free", "ticket")
    parsed = parse_sign(hours_text, layer["days"], layer["max_stay"]) if timed else None
    props = {
        "category": layer["category"],
        "max_stay": layer["max_stay"],
        "spaces": attrs.get("NO_SPACES"),
        "angle": (str(attrs.get("ZONEANGLE") or "").strip() or None),
        "hours_text": hours_text or None,
        "windows": parsed["windows"] if parsed else None,
        "exemptions": (attrs.get("Exemptions") or "").strip() or None,
    }
    if parsed and parsed["closed"]:
        props["closed"] = parsed["closed"]
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(geom["x"], 6), round(geom["y"], 6)]},
        "properties": props,
    }


def _now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def main():
    session = requests.Session()
    session.headers["User-Agent"] = "adelaide-parking-finder (github.com/baomun0304/adelaide-parking-finder)"
    features, failed, unreadable = [], [], set()
    timed_bays = unreadable_bays = 0

    for layer in LAYERS:
        try:
            raw = fetch_layer(f"{SERVICE_ROOT}/{layer['name']}/FeatureServer", layer["index"], session)
        except Exception as e:
            print(f"FAILED {layer['name']}: {e}", file=sys.stderr)
            failed.append(str(e).split(" for url")[0][:120])
            continue
        for item in raw:
            feature = build_feature(item, layer)
            props = feature["properties"]
            if props["category"] in ("free", "ticket"):
                timed_bays += 1
                if props["windows"] is None:
                    unreadable_bays += 1
                    unreadable.add(props["hours_text"])
            features.append(feature)
        print(f"{layer['name']}: {len(raw)}")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    status_path = DATA_DIR / "status.json"
    old = json.loads(status_path.read_text()) if status_path.exists() else {}
    ok = not failed
    changed = False

    if ok:
        geojson_path = DATA_DIR / "parking.geojson"
        text = json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":"))
        changed = not geojson_path.exists() or geojson_path.read_text() != text
        if changed:
            geojson_path.write_text(text)
        print(f"{len(features)} bays, {'updated' if changed else 'no change'}")
    else:
        # ponytail: all-or-nothing keeps half a map from looking like empty streets;
        # if the council ever retires a layer for good, drop it from layers.py.
        print(f"{len(failed)}/{len(LAYERS)} layers failed, keeping the previous parking.geojson", file=sys.stderr)

    status = {
        "ok": ok,
        "since": old.get("since") if old.get("ok") == ok and old.get("since") else _now(),
        "data_updated": _now() if changed else old.get("data_updated"),
        "bays": len(features) if ok else old.get("bays", 0),
        "failed_layers": len(failed),
        "error": failed[0] if failed else None,
        "unreadable_hours": len(unreadable) if ok else old.get("unreadable_hours", 0),
        "timed_bays": timed_bays if ok else old.get("timed_bays", 0),
        "unreadable_bays": unreadable_bays if ok else old.get("unreadable_bays", 0),
        "checked": _now(),
    }
    status_path.write_text(json.dumps(status, indent=2) + "\n")

    if unreadable:
        print(f"\n{len(unreadable)} sign texts couldn't be read (app shows 'check the sign'):", file=sys.stderr)
        for text in sorted(t or "" for t in unreadable)[:40]:
            print(f"  {text!r}", file=sys.stderr)


if __name__ == "__main__":
    main()
