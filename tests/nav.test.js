"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../frontend/nav.js");

// A straight east-west street through the CBD, about 1 km long.
const LINE = [[138.590, -34.925], [138.601, -34.925]];

test("a point on the line is 0 m off it, and its distance along is measured from the start", () => {
  const w = N.nearestOnLine(-34.925, 138.5955, LINE);
  assert.ok(w.off < 1);
  assert.ok(Math.abs(w.along - N.metres(-34.925, 138.590, -34.925, 138.5955)) < 2);
});

test("a point 50 m north of the street is about 50 m off the route", () => {
  const north = -34.925 + 50 / 111195;
  const w = N.nearestOnLine(north, 138.595, LINE);
  assert.ok(Math.abs(w.off - 50) < 2, `off ${w.off}`);
  assert.ok(w.off > N.OFF_ROUTE_M);
});

test("steps read as plain sentences", () => {
  assert.equal(N.stepText({ name: "Grenfell Street", maneuver: { type: "turn", modifier: "left" } }), "Turn left onto Grenfell Street");
  assert.equal(N.stepText({ name: "", maneuver: { type: "turn", modifier: "slight right" } }), "Keep right");
  assert.equal(N.stepText({ name: "King William Street", maneuver: { type: "roundabout", exit: 2 } }), "At the roundabout, take exit 2 onto King William Street");
  assert.equal(N.stepText({ maneuver: { type: "arrive" } }), "You have arrived at your bay");
  assert.equal(N.stepIcon({ maneuver: { type: "turn", modifier: "sharp right" } }), "right");
});

test("the next step is the first manoeuvre still ahead, skipping the departure", () => {
  const steps = N.stepPoints([
    { distance: 300, maneuver: { type: "depart" } },
    { distance: 400, maneuver: { type: "turn", modifier: "left" }, name: "A" },
    { distance: 0, maneuver: { type: "arrive" } },
  ]);
  assert.deepEqual(steps.map((s) => s.at), [0, 300, 700]);
  let n = N.nextStep(steps, 100);
  assert.equal(n.step.name, "A");
  assert.equal(n.toGo, 200);
  n = N.nextStep(steps, 320); // just past the turn: the arrival is next
  assert.equal(n.step.maneuver.type, "arrive");
  assert.equal(n.toGo, 380);
});

test("distances read like a driver says them", () => {
  assert.equal(N.distText(20), "now");
  assert.equal(N.distText(234), "230 m");
  assert.equal(N.distText(1520), "1.5 km");
});

test("fetchRoute turns an OSRM answer into coords and steps with distances", async () => {
  const fake = async () => ({ ok: true, json: async () => ({ code: "Ok", routes: [{ distance: 700, duration: 120,
    geometry: { coordinates: LINE }, legs: [{ steps: [{ distance: 700, maneuver: { type: "depart" } }, { distance: 0, maneuver: { type: "arrive" } }] }] }] }) });
  const r = await N.fetchRoute([-34.925, 138.590], [-34.925, 138.601], fake);
  assert.equal(r.coords.length, 2);
  assert.equal(r.steps[1].at, 700);
  await assert.rejects(N.fetchRoute([0, 0], [0, 0], async () => ({ ok: true, json: async () => ({ code: "NoRoute" }) })));
});
