"use strict";
/* Pure parking rules: time in Adelaide, what applies to a bay at a moment, and the filters.
   No DOM in here, so tests/logic.test.js can run it in Node.

   A moment is {day, mins}: day Mon=0..Sun=6, mins since midnight.
   A bay is {category, max_stay, windows, closed, ...} as written by sync/hours.py:
     windows [[days, start, end, stayMinutes, paid]]   a time limit or ticket applies
     closed  [[days, start, end, label]]               you can't park at all */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Logic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const WEEK = 7 * 1440;
  const TIMED = new Set(["free", "ticket"]);
  const NEVER = new Set(["loading", "taxi", "no-parking"]); // nobody parks here
  const PERMIT_ONLY = {
    car: ["motorcycle", "disabled", "residential"],
    moto: ["disabled", "residential"],
    disabled: ["motorcycle", "residential"],
  };
  const DEFAULT_FILTERS = Object.freeze({ free: false, need: 0, vehicle: "car", sureOnly: false, later: null });

  // ---------- time ----------

  const dayFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Adelaide", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23",
  });

  // Rules are written in Adelaide time, so the phone's own time zone must not matter.
  function adelaideNow(date = new Date()) {
    const get = (type) => dayFormat.formatToParts(date).find((p) => p.type === type).value;
    return { day: DAY_NAMES.indexOf(get("weekday")), mins: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
  }

  const weekMinute = (m) => m.day * 1440 + m.mins;

  function addMinutes(m, n) {
    const t = (((weekMinute(m) + n) % WEEK) + WEEK) % WEEK;
    return { day: Math.floor(t / 1440), mins: t % 1440 };
  }

  function clockText(minutes) {
    if (minutes === 1440 || minutes === 0) return "midnight";
    if (minutes === 720) return "noon";
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`;
  }

  const momentLabel = (m) => `${DAY_NAMES[m.day]} ${clockText(m.mins)}`;

  function stayWords(minutes) {
    if (minutes < 60) return `${minutes} min`;
    const h = minutes / 60;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }

  function stayLabel(minutes) {
    if (!minutes) return "";
    return { 15: "¼P", 30: "½P" }[minutes] || `${minutes / 60}P`;
  }

  function daysText(days) {
    if (days.length === 7) return "Daily";
    const runs = [];
    for (const d of days) {
      const last = runs[runs.length - 1];
      if (last && d === last[1] + 1) last[1] = d; else runs.push([d, d]);
    }
    return runs.map(([a, b]) => (a === b ? DAY_NAMES[a] : `${DAY_NAMES[a]}${b - a > 1 ? "-" : ", "}${DAY_NAMES[b]}`)).join(", ");
  }

  // "8am", "tomorrow 8am" or "Mon 8am", for a moment `after` minutes after `from`.
  function whenText(from, after) {
    const at = addMinutes(from, after);
    if (after < 1440 - from.mins || (at.mins === 0 && after <= 1440 - from.mins)) return clockText(at.mins);
    if (after < 2 * 1440 - from.mins) return `tomorrow ${clockText(at.mins)}`;
    return momentLabel(at);
  }

  // ---------- what applies to one bay ----------

  const inWindow = (w, m) => w[0].includes(m.day) && m.mins >= w[1] && m.mins < w[2];

  function stateAt(bay, m) {
    const closed = (bay.closed || []).find((w) => inWindow(w, m));
    if (closed) return { kind: "closed", label: closed[3] };
    const limit = (bay.windows || []).find((w) => inWindow(w, m));
    return limit ? { kind: "limit", w: limit } : { kind: "open" };
  }

  // Every minute of the week at which some rule of this bay starts or stops.
  function boundaries(bay) {
    if (!bay._b) {
      const set = new Set();
      for (const w of [...(bay.windows || []), ...(bay.closed || [])]) {
        for (const d of w[0]) { set.add(d * 1440 + w[1]); set.add((d * 1440 + w[2]) % WEEK); }
      }
      bay._b = [...set];
    }
    return bay._b;
  }

  // Minutes until a rule next starts (0 < n <= a week), and what it is.
  function nextStart(bay, m) {
    const now = weekMinute(m);
    let best = null;
    for (const w of bay.windows || []) {
      for (const d of w[0]) best = soonest(best, (d * 1440 + w[1] - now + WEEK) % WEEK, { limit: w });
    }
    for (const w of bay.closed || []) {
      for (const d of w[0]) best = soonest(best, (d * 1440 + w[1] - now + WEEK) % WEEK, { closed: w });
    }
    return best;
  }

  function soonest(best, delta, what) {
    if (delta === 0) return best; // already started, so it is not "next"
    return !best || delta < best.delta ? { delta, ...what } : best;
  }

  // How long a closed spell lasts from m, following it across midnight.
  function closedFor(bay, m) {
    let t = m, total = 0;
    for (let i = 0; i < 8; i++) {
      const w = (bay.closed || []).find((c) => inWindow(c, t));
      if (!w) break;
      const step = w[2] - t.mins;
      total += step;
      t = addMinutes(t, step);
    }
    return total;
  }

  const FIXED = {
    unrestricted: ["ok", "No time limit", "Park as long as you like."],
    "no-parking": ["no", "No parking", "Not a place to leave the car."],
    loading: ["no", "Loading zone", "For vehicles loading or unloading, not parking."],
    taxi: ["no", "Taxi rank", "Taxis only."],
    disabled: ["special", "Disabled permit only", "Needs a valid disability parking permit on display."],
    residential: ["special", "Residents with a permit", "Other drivers may be fined."],
    motorcycle: ["special", "Motorcycles only", "No cars."],
  };

  // Everything the driver reads about a bay comes from here.
  function describe(bay, m, isNow = true) {
    const fixed = FIXED[bay.category];
    if (fixed) return { tone: fixed[0], head: fixed[1], sub: fixed[2], blocksFree: fixed[0] === "no" };

    if (!bay.windows) {
      let sub;
      if (bay.hours_text) sub = "The sign text in the council's data looks wrong or too complicated for us to read, so we can't say if it's free right now. The text is below. Read the sign on the street before you park.";
      else if (bay.hint) sub = `The council has no hours for this bay. The bay beside it says "${bay.hint}", so this one is probably the same. Read the sign to be sure.`;
      else sub = "The council has no hours for this bay, so we can't say if it's free right now. Read the sign on the street before you park.";
      return { tone: "special", head: "Check the sign", sub, unknown: true, blocksFree: bay.category === "ticket" };
    }
    const at = isNow ? "right now" : "at that time";
    const s = stateAt(bay, m);

    if (s.kind === "closed") {
      const left = closedFor(bay, m);
      return { tone: "no", head: `${s.label} ${at}`, sub: `Until ${whenText(m, left)}. Don't leave the car here.`, blocksFree: true };
    }
    if (s.kind === "limit") {
      const [, , end, stay, paid] = s.w;
      const left = end - m.mins;
      const next = stateAt(bay, addMinutes(m, left));
      let note;
      if (stay < left) note = `Move your car by ${clockText(m.mins + stay)}.`;
      else if (next.kind === "closed") note = `${next.label} from ${clockText(end)}, so move before then.`;
      else note = `After ${clockText(end)} there's no limit.`;
      return paid
        ? { tone: "paid", head: `Ticket, ${stayWords(stay)} max`, sub: `Pay at the machine or in an app, until ${clockText(end)}.`, note, blocksFree: true }
        : { tone: "ok", head: `Free for ${stayWords(stay)}`, sub: `Time limit applies until ${clockText(end)}.`, note };
    }
    const next = nextStart(bay, m);
    let sub = "This sign doesn't apply right now.";
    let soon = false;
    if (next) {
      const what = next.closed ? `${next.closed[3]} starts` : next.limit[4] ? "Ticket starts" : `${stayWords(next.limit[3])} limit starts`;
      sub = `${what} ${whenText(m, next.delta)}${next.delta <= 60 ? ` (in ${next.delta} min)` : ""}.`;
      soon = next.delta <= 60;
    }
    return { tone: soon ? "warn" : "ok", head: `No limit ${at}`, sub };
  }

  // ---------- filters ----------

  const isFiltering = (f) => Boolean(f.free || f.need > 0 || f.later || f.vehicle !== "car" || f.sureOnly);

  // Could you park here from m for `need` minutes? Walks through each rule change during the stay.
  // The limit is checked against the time spent inside each window, which is the safe reading.
  function spanOk(bay, m, need, wantFree) {
    const start = weekMinute(m);
    const offsets = [0];
    for (const b of boundaries(bay)) {
      const o = (((b - start) % WEEK) + WEEK) % WEEK;
      if (o > 0 && o < need) offsets.push(o);
    }
    for (const o of offsets) {
      const t = addMinutes(m, o);
      const s = stateAt(bay, t);
      if (s.kind === "closed") return false;
      if (s.kind === "limit") {
        if (wantFree && s.w[4]) return false;
        if (s.w[3] < Math.min(need - o, s.w[2] - t.mins)) return false;
      }
    }
    return true;
  }

  // Can this vehicle legally park in this kind of bay at all, ignoring the clock?
  const isStopZone = (bay) => NEVER.has(bay.category);
  const canPark = (bay, vehicle) => !NEVER.has(bay.category) && !(PERMIT_ONLY[vehicle] || []).includes(bay.category);

  function matches(bay, f, m) {
    if (!canPark(bay, f.vehicle)) return false;
    const timed = TIMED.has(bay.category);
    if (f.sureOnly && timed && !bay.windows) return false;
    if (bay.category === "unrestricted") return true;
    if (!timed) return !f.need || !bay.max_stay || bay.max_stay >= f.need; // permit bays: sign text is shown in the sheet
    if (!bay.windows && bay.hint_windows) return spanOk({ ...bay, windows: bay.hint_windows, closed: bay.hint_closed }, m, f.need, f.free);
    if (!bay.windows) return (!f.free || bay.category === "free") && (!f.need || bay.max_stay >= f.need);
    return spanOk(bay, m, f.need, f.free);
  }

  return {
    DAY_NAMES, DEFAULT_FILTERS, adelaideNow, addMinutes, clockText, momentLabel, stayWords, stayLabel,
    daysText, stateAt, nextStart, describe, isFiltering, matches, whenText, canPark, isStopZone,
  };
});
