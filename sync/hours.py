"""Turn council sign text into time windows the map can check against the clock.

"2 hr Ticket Monday to Friday 8am-6pm Saturday 8am-noon" becomes
[[[0,1,2,3,4], 480, 1080], [[5], 480, 720]]  (days Mon=0, minutes since midnight).

Careful on purpose: if any part of the text can't be read, we return None and
the app tells the driver to check the sign. A wrong "free now" costs a real fine.
"""
import re

_DAY = r"\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?"
_DAYS = rf"{_DAY}(?:\s*(?:to|-|&|and|,)\s*{_DAY})*"
_TIME = r"\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|noon|midnight"
_WINDOW = re.compile(
    rf"(?:(?P<days>{_DAYS})\s*,?\s*)?(?P<start>{_TIME})\s*(?:-|to)\s*(?P<end>{_TIME})", re.I
)
_LEFTOVER = re.compile(rf"{_DAY}|\d\s*(?:am|pm)\b|noon|midnight", re.I)
_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
DEFAULT_DAYS = {"weekday": [0, 1, 2, 3, 4], "weekend": [5, 6], "any": list(range(7))}


def _minutes(text):
    text = text.lower().replace(" ", "")
    if text == "noon":
        return 720
    if text == "midnight":
        return 1440
    m = re.fullmatch(r"(\d{1,2})(?:[:.](\d{2}))?(am|pm)", text)
    hour, minute = int(m[1]), int(m[2] or 0)
    if not 1 <= hour <= 12 or minute > 59:
        raise ValueError(text)
    return (hour % 12 + (12 if m[3] == "pm" else 0)) * 60 + minute


def _days(expr):
    days, in_range = [], False
    for token in re.findall(r"[a-z]+|-", expr.lower()):
        if token[:3] in _ORDER:
            day = _ORDER.index(token[:3])
            if in_range and days:
                first = days[-1]
                days += [(first + i) % 7 for i in range(1, (day - first) % 7 + 1)]
            else:
                days.append(day)
            in_range = False
        elif token in ("to", "-"):
            in_range = True
    return sorted(set(days))


def parse_windows(text, layer_days="any"):
    if not text:
        return None
    windows, days, leftover = [], DEFAULT_DAYS[layer_days], text
    for m in _WINDOW.finditer(text):
        if m["days"]:
            days = _days(m["days"])
        try:
            start, end = _minutes(m["start"]), _minutes(m["end"])
        except ValueError:
            return None
        if start >= end or start == 1440:  # overnight windows: too easy to get wrong, say "check the sign"
            return None
        windows.append([days, start, end])
        leftover = leftover.replace(m[0], " ", 1)
    if not windows or _LEFTOVER.search(leftover):
        return None
    return windows
