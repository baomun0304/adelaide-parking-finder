"""Run from the sync folder: python -m unittest -v"""
import unittest
from unittest.mock import MagicMock

from arcgis import fetch_layer
from hours import parse_windows
from layers import LAYERS, VALID_CATEGORIES
from sync_parking import build_feature

WEEKDAYS = [0, 1, 2, 3, 4]


class Hours(unittest.TestCase):
    def test_real_council_sample(self):
        text = "2 hr Ticket Monday to Friday 8am-6pm Saturday 8am-noon"
        self.assertEqual(parse_windows(text, "weekday"), [[WEEKDAYS, 480, 1080], [[5], 480, 720]])

    def test_no_days_falls_back_to_layer_days(self):
        self.assertEqual(parse_windows("1P 9am-5pm", "weekend"), [[[5, 6], 540, 1020]])

    def test_short_day_names_and_minutes(self):
        self.assertEqual(parse_windows("Mon-Thu 7:30am-6.30pm", "any"), [[[0, 1, 2, 3], 450, 1110]])

    def test_midnight_end(self):
        self.assertEqual(parse_windows("Sat & Sun 10am-midnight"), [[[5, 6], 600, 1440]])

    def test_unreadable_text_is_none_never_a_guess(self):
        for text in ["", None, "Unrestricted", "Permit holders only", "8am-6pm Mon-Fri",
                     "Mon-Fri 10pm-6am", "Mon-Fri 8am-6pm Sat 8am"]:
            self.assertIsNone(parse_windows(text, "weekday"), text)


class Layers(unittest.TestCase):
    def test_registry(self):
        self.assertEqual(len(LAYERS), 34)  # every parking layer in the council web map
        self.assertEqual(len({l["name"] for l in LAYERS}), 34)
        for layer in LAYERS:
            self.assertIn(layer["category"], VALID_CATEGORIES)
            if layer["category"] in ("free", "ticket"):
                self.assertTrue(layer["max_stay"], layer["name"])


class Fetch(unittest.TestCase):
    def test_follows_pages_until_done(self):
        session = MagicMock()
        session.get.return_value.json.side_effect = [
            {"features": [{}, {}], "exceededTransferLimit": True},
            {"features": [{}], "exceededTransferLimit": False},
        ]
        self.assertEqual(len(fetch_layer("https://x/FeatureServer", 2, session)), 3)
        self.assertEqual(session.get.call_args.kwargs["params"]["resultOffset"], 2)
        self.assertEqual(session.get.call_args.kwargs["params"]["outSR"], 4326)

    def test_arcgis_error_body_raises(self):
        session = MagicMock()
        session.get.return_value.json.return_value = {"error": {"message": "Invalid URL"}}
        with self.assertRaises(RuntimeError):
            fetch_layer("https://x/FeatureServer", 2, session)


class BuildFeature(unittest.TestCase):
    def test_ticket_bay(self):
        raw = {
            "attributes": {"NO_SPACES": 13, "ZONEANGLE": "90", "Exemptions": None,
                           "CLASS1": "2 hr Ticket Monday to Friday 8am-6pm Saturday 8am-noon  ",
                           "CLASS2": " ", "CLASS3": None, "CLASS4": " "},
            "geometry": {"x": 138.6123456789, "y": -34.9271234567},
        }
        layer = {"category": "ticket", "days": "weekday", "max_stay": 120}
        f = build_feature(raw, layer)
        self.assertEqual(f["geometry"]["coordinates"], [138.612346, -34.927123])
        p = f["properties"]
        self.assertEqual(p["hours_text"], "2 hr Ticket Monday to Friday 8am-6pm Saturday 8am-noon")
        self.assertEqual(p["windows"][1], [[5], 480, 720])
        self.assertEqual((p["spaces"], p["angle"], p["max_stay"], p["exemptions"]), (13, "90", 120, None))

    def test_untimed_category_has_no_windows(self):
        raw = {"attributes": {"CLASS1": "Unrestricted  "}, "geometry": {"x": 138.6, "y": -34.9}}
        p = build_feature(raw, {"category": "unrestricted", "days": "any", "max_stay": None})["properties"]
        self.assertIsNone(p["windows"])
        self.assertEqual(p["hours_text"], "Unrestricted")


if __name__ == "__main__":
    unittest.main()
