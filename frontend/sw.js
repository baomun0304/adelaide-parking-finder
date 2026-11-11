"use strict";
// Keeps the app, the parking data and the map tiles you've looked at, so it still opens with no signal.
// Pages and data go to the network first (so they are never stale when you're online); tiles are cached first.
const VERSION = "apf-v3";
const TILES = "apf-tiles";
const MAX_TILES = 600;
const SHELL = [
  "/", "/style.css", "/app.js", "/logic.js", "/manifest.webmanifest",
  "/vendor/supercluster.min.js", "/vendor/maplibre-gl.js", "/vendor/maplibre-gl.css",
  "/icons/icon-192.png", "/data/parking.geojson", "/data/status.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
    return res;
  } catch {
    const hit = await caches.match(req, { ignoreSearch: req.mode === "navigate" });
    return hit || (req.mode === "navigate" ? caches.match("/") : Response.error());
  }
}

async function tileFirst(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === "cors") {
    cache.put(req, res.clone());
    const keys = await cache.keys();
    if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => cache.delete(k)));
  }
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname === "tiles.openfreemap.org" || url.hostname === "services.arcgisonline.com") e.respondWith(tileFirst(req));
  else if (url.origin === location.origin && !url.pathname.startsWith("/_vercel/")) e.respondWith(networkFirst(req));
});
