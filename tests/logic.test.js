"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../frontend/logic.js");

const WK = [0, 1, 2, 3, 4];
const ALL = [0, 1, 2, 3, 4, 5, 6];
const at = (day, h, m = 0) => ({ day, mins: h * 60 + m });
const TUE = 1, SAT = 5, SUN = 6;

// 2 hr Ticket Mon-Fri 8am-6pm, 3 hr Ticket Saturday 8am-noon
const ticket = { category: "ticket", max_stay: 120, windows: [[WK, 480, 1080, 120, 1], [[5], 480, 720, 180, 1]] };
// 2 hr free Mon-Fri 8am-6pm, residents only the rest of the time
const free2 = { category: "free", max_stay: 120, windows: [[WK, 480, 1080, 120, 0]], closed: [[WK, 0, 480, "Residents only"], [WK, 1080, 1440, "Residents only"], [[5, 6], 0, 1440, "Residents only"]] };
const unknown = { category: "free", max_stay: 120, windows: null };

test("Adelaide time ignores the device time zone", () => {
  // 06:31 UTC on Tue 10 Nov 2026 is 5:01pm in Adelaide (UTC+10:30 daylight time)
  assert.deepEqual(L.adelaideNow(new Date("2026-11-10T06:31:00Z")), { day: TUE, mins: 17 * 60 + 1 });
  // winter is UTC+9:30
  assert.deepEqual(L.adelaideNow(new Date("2026-07-14T14:30:00Z")), { day: 2, mins: 0 });
});

test("addMinutes wraps over midnight and the week", () => {
  assert.deepEqual(L.addMinutes(at(SUN, 23, 30), 60), at(0, 0, 30));
  assert.deepEqual(L.addMinutes(at(0, 0, 10), -20), at(SUN, 23, 50));
});

test("ticket bay in its window shows the limit and a move-by time", () => {
  const d = L.describe(ticket, at(TUE, 14));
  assert.equal(d.head, "Ticket, 2 hours max");
  assert.equal(d.note, "Move your car by 4pm.");
  assert.equal(d.blocksFree, true);
});

test("limit that outlasts the window says there is no limit afterwards", () => {
  assert.equal(L.describe(ticket, at(TUE, 16, 1)).note, "After 6pm there's no limit.");
});

test("Saturday uses the Saturday limit, not the weekday one", () => {
  assert.equal(L.describe(ticket, at(SAT, 9)).head, "Ticket, 3 hours max");
});

test("outside the window is open, and warns when a ticket starts soon", () => {
  const sun = L.describe(ticket, at(SUN, 12));
  assert.equal(sun.head, "No limit right now");
  assert.equal(sun.sub, "Ticket starts tomorrow 8am.");
  const soon = L.describe(ticket, at(TUE, 7, 35));
  assert.equal(soon.tone, "warn");
  assert.match(soon.sub, /in 25 min/);
});

test("closed spell is reported, including how long it lasts across midnight", () => {
  const d = L.describe(free2, at(TUE, 23));
  assert.equal(d.tone, "no");
  assert.equal(d.head, "Residents only right now");
  assert.equal(d.sub, "Until tomorrow 8am. Don't leave the car here.");
  assert.equal(L.describe(free2, at(SAT, 10)).sub, "Until Mon 8am. Don't leave the car here.");
});

test("a bay we could not read says check the sign", () => {
  const d = L.describe(unknown, at(TUE, 10));
  assert.equal(d.unknown, true);
  assert.equal(d.head, "Check the sign");
});

const f = (over) => ({ ...L.DEFAULT_FILTERS, ...over });

test("free filter hides ticket bays while the ticket applies, shows them after", () => {
  assert.equal(L.matches(ticket, f({ free: true }), at(TUE, 16)), false);
  assert.equal(L.matches(ticket, f({ free: true }), at(TUE, 19)), true);
});

test("a stay that runs into a ticket window is not free", () => {
  assert.equal(L.matches(ticket, f({ free: true, need: 150 }), at(TUE, 6)), false); // ticket from 8am
  assert.equal(L.matches(ticket, f({ free: true, need: 120 }), at(TUE, 6)), true);  // gone by 8am sharp
});

test("duration filter compares the limit with time spent inside the window", () => {
  assert.equal(L.matches(ticket, f({ need: 180 }), at(TUE, 10)), false); // 2 hr limit
  assert.equal(L.matches(ticket, f({ need: 120 }), at(TUE, 10)), true);
  assert.equal(L.matches(ticket, f({ need: 180 }), at(TUE, 17)), true);  // only 1 hr left in the window
  assert.equal(L.matches(ticket, f({ need: 180 }), at(SAT, 9)), true);   // Saturday allows 3 hr
});

test("a stay that runs into a closed spell is rejected", () => {
  assert.equal(L.matches(free2, f({ need: 60 }), at(TUE, 17, 30)), false); // residents from 6pm
  assert.equal(L.matches(free2, f({ need: 30 }), at(TUE, 17, 30)), true);
});

test("stay running past midnight into Saturday is checked on the next day", () => {
  assert.equal(L.matches(ticket, f({ need: 900 }), at(4, 23)), false); // 4 hr inside Sat 8am-noon, limit 3 hr
  assert.equal(L.matches(ticket, f({ need: 600 }), at(4, 23)), true);  // only 1 hr inside it
});

test("vehicle decides which permit bays are offered", () => {
  const moto = { category: "motorcycle", max_stay: null };
  const dis = { category: "disabled", max_stay: null };
  assert.equal(L.matches(moto, f(), at(TUE, 10)), false);
  assert.equal(L.matches(moto, f({ vehicle: "moto" }), at(TUE, 10)), true);
  assert.equal(L.matches(dis, f({ vehicle: "disabled" }), at(TUE, 10)), true);
  assert.equal(L.matches(dis, f({ vehicle: "moto" }), at(TUE, 10)), false);
});

test("nobody can park in loading, taxi and no parking zones", () => {
  for (const category of ["loading", "taxi", "no-parking"]) {
    assert.equal(L.matches({ category }, f({ vehicle: "disabled" }), at(TUE, 10)), false);
  }
});

test("unread bays follow the layer, and 'sure only' hides them", () => {
  assert.equal(L.matches(unknown, f({ need: 120 }), at(TUE, 10)), true);
  assert.equal(L.matches(unknown, f({ need: 180 }), at(TUE, 10)), false);
  assert.equal(L.matches(unknown, f({ sureOnly: true }), at(TUE, 10)), false);
  assert.equal(L.matches({ ...unknown, category: "ticket" }, f({ free: true }), at(TUE, 10)), false);
});

test("isFiltering ignores the defaults", () => {
  assert.equal(L.isFiltering(L.DEFAULT_FILTERS), false);
  assert.equal(L.isFiltering(f({ need: 60 })), true);
  assert.equal(L.isFiltering(f({ later: at(TUE, 9) })), true);
});

test("labels", () => {
  assert.equal(L.stayLabel(15), "¼P");
  assert.equal(L.stayLabel(120), "2P");
  assert.equal(L.daysText([0, 1, 2, 3, 4, 5]), "Mon-Sat");
  assert.equal(L.daysText([5, 6]), "Sat, Sun");
  assert.equal(L.momentLabel(at(TUE, 16, 1)), "Tue 4:01pm");
});
