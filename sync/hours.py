"""Turn council sign text into rules the map can check against the clock.

One council field can hold several signs glued together, for example

  "No Stopping Monday to Friday 7am-10am 3 hr Ticket Monday to Friday 10am-7pm Saturday & Sunday 7am-7pm"

parse_sign() splits that into signs, reads each one's days and times, and returns

  {"windows": [[days, start, end, stay_minutes, paid]],   # when a time limit or ticket applies
   "closed":  [[days, start, end, label]]}                # when you can't park at all

Days are Mon=0..Sun=6, times are minutes since midnight.

Careful on purpose: if any part of the text can't be read, we return None and the
app tells the driver to check the sign. A wrong "you can park here" costs a real fine.
"""
import re

_DAYNAME = r"\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?"
_DAYITEM = rf"(?:any\s*day|{_DAYNAME})"
_DAYS = rf"{_DAYITEM}(?:\s*(?:to|-|&|and|,)\s*{_DAYITEM})*"
_TIME = r"\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|(?:12\s*)?noon|midnight"
_WINDOW = re.compile(
    rf"(?:(?P<days>{_DAYS})\s*,?\s*)?(?P<start>{_TIME})\s*(?:-|to)\s*(?P<end>{_TIME})", re.I
)
_SIGN = re.compile(
    r"(?P<closed>No\s+Parking|No\s+Stopping|Bus(?:\s+Lane)?|Loading(?:\s+Zone)?|Taxi)\b"
    r"|(?P<permit>Residential)\b"
    r"|(?P<n>\d+)\s*(?P<unit>hrs?|mins?)\s*(?:Area\s+)?(?P<what>Ticket|Parking)\b",
    re.I,
)
_LABELS = {
    "no parking": "No parking", "no stopping": "No stopping", "bus lane": "Bus lane", "bus": "Bus lane",
    "loading": "Loading zone", "loading zone": "Loading zone", "taxi": "Taxi rank",
    "residential": "Residents only",
}
_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
ALL_DAYS = list(range(7))
DEFAULT_DAYS = {"weekday": [0, 1, 2, 3, 4], "weekend": [5, 6], "any": ALL_DAYS}
# Evening starts are read as overnight ("10pm-6am"). A morning start with an earlier end
# ("8am-6am") is a typo in the council data, so it stays unreadable instead of guessed.
OVERNIGHT_FROM = 18 * 60


def _minutes(text, is_end):
    text = text.lower().replace(" ", "")
    if text == "midnight":
        return 1440 if is_end else 0
    if text in ("noon", "12noon"):
        return 720
    m = re.fullmatch(r"(\d{1,2})(?:[:.](\d{2}))?(am|pm)", text)
    hour, minute = int(m[1]), int(m[2] or 0)
    if not 1 <= hour <= 12 or minute > 59:
        raise ValueError(text)
    return (hour % 12 + (12 if m[3] == "pm" else 0)) * 60 + minute


def _days(expr):
    if re.search(r"any\s*day", expr, re.I):
        return list(ALL_DAYS)
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


def _clause(text, default_days):
    """Read one sign's days and times. Returns a list of [days, start, end], or None."""
    text = text.strip()
    if re.fullmatch(r"at all times", text, re.I):
        return [[list(ALL_DAYS), 0, 1440]]
    out, days = [], default_days
    for m in _WINDOW.finditer(text):
        if m["days"]:
            days = _days(m["days"])
        if not days:
            return None
        try:
            start, end = _minutes(m["start"], False), _minutes(m["end"], True)
        except ValueError:
            return None
        if start == end:
            return None
        if start < end:
            out.append([days, start, end])
        elif start >= OVERNIGHT_FROM:
            out.append([days, start, 1440])
            out.append([sorted((d + 1) % 7 for d in days), 0, end])
        else:
            return None
    rest = _WINDOW.sub(" ", text)
    if not out or not re.fullmatch(r"[\s,]*", rest):
        return None
    return out


def _complement(spans):
    """Per-day gaps left over once the given [days, start, end] spans are removed."""
    by_gap = {}
    for day in ALL_DAYS:
        cursor = 0
        for start, end in sorted((s, e) for d, s, e in spans if day in d):
            if start > cursor:
                by_gap.setdefault((cursor, start), []).append(day)
            cursor = max(cursor, end)
        if cursor < 1440:
            by_gap.setdefault((cursor, 1440), []).append(day)
    return [[days, s, e] for (s, e), days in sorted(by_gap.items())]


def parse_sign(text, layer_days="any", layer_stay=None):
    if not text:
        return None
    text = " ".join(text.split())
    signs = list(_SIGN.finditer(text))
    if not signs or text[: signs[0].start()].strip():
        return None

    parsed = []  # (sign match, spans or "other")
    for i, sign in enumerate(signs):
        end = signs[i + 1].start() if i + 1 < len(signs) else len(text)
        clause = text[sign.end():end].strip()
        if re.fullmatch(r"at all other times", clause, re.I):
            parsed.append((sign, "other"))
            continue
        timed = sign["n"] is not None
        spans = _clause(clause, DEFAULT_DAYS[layer_days] if timed else None)
        if spans is None:
            return None
        parsed.append((sign, spans))

    explicit = [s for _, spans in parsed if spans != "other" for s in spans]
    if sum(spans == "other" for _, spans in parsed) > 1:
        return None
    windows, closed = [], []
    for sign, spans in parsed:
        if spans == "other":
            spans = _complement(explicit)
        if sign["n"] is not None:
            stay = int(sign["n"]) * (60 if sign["unit"].lower().startswith("h") else 1)
            paid = 1 if sign["what"].lower() == "ticket" else 0
            windows += [[d, s, e, stay, paid] for d, s, e in spans]
        else:
            label = _LABELS[re.sub(r"\s+", " ", (sign["closed"] or sign["permit"]).lower())]
            closed += [[d, s, e, label] for d, s, e in spans]

    if not windows:
        return None
    if layer_stay and not any(w[3] == layer_stay for w in windows):
        return None  # sign text and council layer disagree, so trust neither
    for i, a in enumerate(windows):  # two different limits at the same time is ambiguous
        for b in windows[i + 1:]:
            if set(a[0]) & set(b[0]) and a[1] < b[2] and b[1] < a[2] and a[3:] != b[3:]:
                return None
    return {"windows": windows, "closed": closed}
