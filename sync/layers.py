"""The City of Adelaide publishes each parking type as its own ArcGIS layer.

The layer name already tells us the category, which days it applies to and
the time limit, so we hardcode that here instead of guessing it from text.
Layer indexes were read from the council's own web map (item
839001facd0b4d78b845ad1e56ccc0c0), which lists the exact URL of each one.
"""

VALID_CATEGORIES = {
    "free", "ticket", "unrestricted", "motorcycle", "disabled",
    "residential", "taxi", "loading", "no-parking",
}


def _layer(name, category, days="any", max_stay=None, index=2):
    return {"name": name, "index": index, "category": category, "days": days, "max_stay": max_stay}


LAYERS = [
    _layer("10_Hr_Weekday_Ticket_Parking", "ticket", "weekday", 600),
    _layer("4_Hr_Weekday_Ticket_Parking", "ticket", "weekday", 240),
    _layer("3_Hr_Weekday_Ticket_Parking", "ticket", "weekday", 180),
    _layer("2_Hr_Weekday_Ticket_Parking", "ticket", "weekday", 120),
    _layer("1_Hr_Weekday_Ticket_Parking", "ticket", "weekday", 60),
    _layer("30_Min_Weekday_Ticket_Parking", "ticket", "weekday", 30),
    _layer("4_Hr_Weekend_Ticket_Parking", "ticket", "weekend", 240),
    _layer("3_Hr_Weekend_Ticket_Parking", "ticket", "weekend", 180),
    _layer("2_Hr_Weekend_Ticket_Parking", "ticket", "weekend", 120),
    _layer("1_Hr_Weekend_Ticket_Parking", "ticket", "weekend", 60),
    _layer("30_Min_Weekend_Ticket_Parking", "ticket", "weekend", 30),
    _layer("10_Hr_Weekday_Free_Parking", "free", "weekday", 600),
    _layer("6_Hr_Weekday_Free_Parking", "free", "weekday", 360),
    _layer("5_Hr_Weekday_Free_Parking", "free", "weekday", 300),
    _layer("4_Hr_Weekday_Free_Parking", "free", "weekday", 240),
    _layer("3_Hr_Weekday_Free_Parking", "free", "weekday", 180),
    _layer("2_Hr_Free_Weekday_Parking", "free", "weekday", 120),  # the council's name really is in this order
    _layer("30_Min_Weekday_Free_Parking", "free", "weekday", 30),
    _layer("15_Min_Weekday_Free_Parking", "free", "weekday", 15),
    _layer("6_Hr_Weekend_Free_Parking", "free", "weekend", 360),
    _layer("5_Hr_Weekend_Free_Parking", "free", "weekend", 300),
    _layer("4_Hr_Weekend_Free_Parking", "free", "weekend", 240),
    _layer("3_Hr_Weekend_Free_Parking", "free", "weekend", 180),
    _layer("2_Hr_Weekend_Free_Parking", "free", "weekend", 120),
    _layer("1_Hr_Weekend_Free_Parking", "free", "weekend", 60),
    _layer("30_Min_Weekend_Free_Parking", "free", "weekend", 30, index=3),
    _layer("15_Min_Weekend_Free_Parking", "free", "weekend", 15),
    _layer("Unrestricted_Parking", "unrestricted", index=3),
    _layer("Motorcycle_Parking", "motorcycle", index=1),
    _layer("Disabled_Parking", "disabled", index=1),
    _layer("Residential_Parking", "residential", index=1),
    _layer("Taxi_Rank", "taxi", index=1),
    _layer("Loading_Zones", "loading", index=1),
    _layer("No_Parking_Zone", "no-parking", index=1),
]
