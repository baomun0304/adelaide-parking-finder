"""Run from the sync folder: python -m unittest -v"""
import unittest
from unittest.mock import MagicMock

from arcgis import fetch_layer
from hours import parse_sign
from layers import LAYERS, VALID_CATEGORIES
from sync_parking import build_feature

WEEKDAYS = [0, 1, 2, 3, 4]


class Hours(unittest.TestCase):
    def test_real_council_sample(self):
        text = "2 hr Ticket Monday to Friday 8am-6pm Saturday 8am-noon"
        r = parse_sign(text, "weekday", 120)
        self.assertEqual(r["windows"], [[WEEKDAYS, 480, 1080, 120, 1], [[5], 480, 720, 120, 1]])
        self.assertEqual(r["closed"], [])

    def test_different_limit_on_saturday(self):
        r = parse_sign("2 hr Ticket Monday to Friday 8am-6pm 3 hr Ticket Saturday 8am-noon", "weekday", 120)
        self.assertEqual(r["windows"][1], [[5], 480, 720, 180, 1])

    def test_no_stopping_then_ticket(self):
        text = "No Stopping Monday to Friday 7am-10am 3 hr Ticket Monday to Friday 10am-7pm Saturday & Sunday 7am-7pm"
        r = parse_sign(text, "weekday", 180)
        self.assertEqual(r["closed"], [[WEEKDAYS, 420, 600, "No stopping"]])
        self.assertEqual(r["windows"][0], [WEEKDAYS, 600, 1140, 180, 1])
        self.assertEqual(r["windows"][1], [[5, 6], 420, 1140, 180, 1])

    def test_all_other_times_becomes_the_gaps(self):
        r = parse_sign("5 hr Area Parking Any Day 6am-10pm No Stopping At all other times", "any", 300)
        self.assertEqual(r["windows"], [[list(range(7)), 360, 1320, 300, 0]])
        self.assertEqual(r["closed"], [[list(range(7)), 0, 360, "No stopping"], [list(range(7)), 1320, 1440, "No stopping"]])

    def test_residents_outside_the_sign(self):
        r = parse_sign("2 hr Parking Monday to Friday 8am-6pm Saturday 8am-noon Residential At all other times", "weekday", 120)
        labels = {c[3] for c in r["closed"]}
        self.assertEqual(labels, {"Residents only"})
        sunday = [c for c in r["closed"] if 6 in c[0]]
        self.assertEqual(sunday, [[sunday[0][0], 0, 1440, "Residents only"]])

    def test_overnight_evening_window_is_split(self):
        r = parse_sign("Taxi Friday 10pm-6am 1 hr Ticket Any Day 9am-6pm", "any", 60)
        self.assertEqual(r["closed"], [[[4], 1320, 1440, "Taxi rank"], [[5], 0, 360, "Taxi rank"]])

    def test_bus_lane_and_noon(self):
        r = parse_sign("Bus Lane Monday to Friday 7am-10am 15 min Parking Monday to Friday 10am-7pm Saturday 7am-12noon", "weekday", 15)
        self.assertEqual(r["closed"][0][3], "Bus lane")
        self.assertEqual(r["windows"][1], [[5], 420, 720, 15, 0])

    def test_no_days_falls_back_to_layer_days(self):
        self.assertEqual(parse_sign("1 hr Parking 9am-5pm", "weekend")["windows"], [[[5, 6], 540, 1020, 60, 0]])

    def test_unreadable_text_is_none_never_a_guess(self):
        for text in ["", None, "Unrestricted", "Permit holders only", "2 hr Parking 8am-6pm Mon-Fri extra",
                     "2 hr Parking Monday to Friday 8am-6am",   # council typo, morning start
                     "2 hr Parking Monday to Friday 8pm-8pm",
                     "2 hr Ticket Monday to Friday 3 hr Ticket Saturday 8am-noon",
                     "No Stopping Monday to Friday 7am-9am",    # no time limit anywhere
                     "Residential At all other times 3 hr Ticket Monday to Friday 8am-6pm Disabled At all other times"]:
            self.assertIsNone(parse_sign(text, "weekday"), text)

    def test_layer_and_sign_disagreeing_is_none(self):
        self.assertIsNone(parse_sign("2 hr Ticket Monday to Friday 8am-6pm", "weekday", 60))


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
        self.assertEqual(p["windows"][1], [[5], 480, 720, 120, 1])
        self.assertNotIn("closed", p)
        self.assertEqual((p["spaces"], p["angle"], p["max_stay"], p["exemptions"]), (13, "90", 120, None))

    def test_untimed_category_has_no_windows(self):
        raw = {"attributes": {"CLASS1": "Unrestricted  "}, "geometry": {"x": 138.6, "y": -34.9}}
        p = build_feature(raw, {"category": "unrestricted", "days": "any", "max_stay": None})["properties"]
        self.assertIsNone(p["windows"])
        self.assertEqual(p["hours_text"], "Unrestricted")


if __name__ == "__main__":
    unittest.main()


class HintTests(unittest.TestCase):
    def _bay(self, x, text, windows, stay=120):
        return {"geometry": {"coordinates": [x, -34.92]},
                "properties": {"category": "free", "max_stay": stay, "hours_text": text, "windows": windows}}

    def test_empty_bay_borrows_the_neighbour_sign(self):
        from sync_parking import add_hints
        donor = self._bay(138.6000, "2 hr Parking Monday to Friday 8am-6pm", [[[1], 480, 1080, 120, False]])
        empty = self._bay(138.60002, None, None)
        far = self._bay(138.6100, None, None)
        add_hints([donor, empty, far])
        self.assertEqual(empty["properties"]["hint"], donor["properties"]["hours_text"])
        self.assertNotIn("hint", far["properties"])
        self.assertIsNone(empty["properties"]["windows"])  # a hint never becomes a rule
