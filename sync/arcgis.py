"""Download every feature from one ArcGIS FeatureServer layer, page by page."""
import requests

PAGE_SIZE = 1000


def fetch_layer(base_url, index, session=None):
    session = session or requests.Session()
    features, offset = [], 0
    while True:
        response = session.get(
            f"{base_url}/{index}/query",
            params={
                "where": "1=1", "outFields": "*", "f": "json", "outSR": 4326,
                "resultOffset": offset, "resultRecordCount": PAGE_SIZE,
            },
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()
        if "error" in data:  # ArcGIS reports errors with HTTP 200 and an "error" key
            raise RuntimeError(data["error"].get("message", "ArcGIS error"))
        page = data.get("features", [])
        features += page
        if not data.get("exceededTransferLimit") or not page:
            return features
        offset += len(page)
