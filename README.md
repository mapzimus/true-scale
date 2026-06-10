# TrueScale

See how big places **really** are. The Web Mercator map you grew up with stretches land near the
poles — Greenland looks as big as Africa, but it's 14× smaller. TrueScale lets you drag any country,
US state, or province across the map and keeps its **true on-the-ground size**, so you can see the
distortion for yourself.

A faster, ad-free, tracker-free take on the classic [thetruesize.com](https://thetruesize.com).

## Features

- **Drag-to-compare** — grab any shape and move it. It keeps its real size and balloons toward the
  poles, exactly as Mercator distorts it (each vertex is re-stamped by its geodesic distance +
  bearing from the centroid, so true ground area is preserved at every latitude).
- **Live area + ratio readout** — km² / mi², share of Earth's land, and a "_X is 3.2× the size of
  Y_" comparison line between any two shapes.
- **Mercator-distortion meter** — "on this map it looks **N× bigger** than reality" (the `sec²(lat)`
  area-inflation factor), updating as you drag. This is the part TheTrueSize only implies.
- **Countries + states + provinces** — Natural Earth admin-0 and admin-1 in one searchable index.
- **One-click classics** — "Greenland vs Australia", "Greenland vs India", "Canada vs Brazil" drop
  both shapes side-by-side on the equator (zero distortion) so the size shock lands instantly.
- **Latitude grid** — toggle a graticule to see Mercator's poleward stretch directly.
- **Reset to true location** — snap any shape back to where it really is.
- **Shareable URL** — every shape and position is encoded in the link; copy and send.
- **Keyboard + touch** — arrow keys nudge (Shift = bigger step), Delete removes, touch-drag works.
- **No ads, no trackers, no cookies.**

## Run

It's a static site — no build step.

```sh
# any static server, e.g.
python -m http.server 8000
# then open http://localhost:8000
```

## Stack

- [Leaflet](https://leafletjs.com) — slippy map (Web Mercator).
- [Turf.js](https://turfjs.org) — geodesic translation + area math.
- [Natural Earth](https://www.naturalearthdata.com) boundaries (public domain), via jsDelivr.
- CARTO dark basemap / OpenStreetMap.

## Roadmap

- **Beyond Mercator** (phase 2): an orthographic globe + equal-area projection view via d3-geo, so
  you can see distortion under multiple projections, not just correct for Mercator. Leaflet is
  Mercator-locked, so this is a separate render path. (For now the `sec²(lat)` meter teaches the
  distortion in place.)
- Rotate shapes; pin a "reference" outline; PNG export of a comparison.
- Higher-res boundaries (50m/10m) toggle for sharper coastlines.
