# Maps, distance, and ETA — how Offkay handles geography

## Current provider (what the app uses today)

The Explore "Map" mode uses **OpenStreetMap embed tiles** (`osmEmbed` in
`public/app.js`): a no-key, no-billing `<iframe>` per property that shows the
area around the listing with a pin. The "View on map" deep link in a property
detail opens `openstreetmap.org` with the coordinates (owners' view) or an
area search query (public view).

It is **not** Google Maps. Loading the Maps JavaScript SDK requires an API
key with billing enabled, which is not configured for this project, so the
OSM embed is used instead. Nothing blocks adding Google later:

1. Add a `GOOGLE_MAPS_API_KEY` env var (Maps JavaScript API + Directions API).
2. Swap `osmEmbed()` for a Google map that reads
   `listing.proximity.destination` (public university coordinates) and a
   jittered property point (see privacy).
3. Routing/ETA upgrades automatically — see below.

## Distance + ETA pipeline (implemented)

All distances are **computed server-side** from stored coordinates; nothing
is hardcoded per property.

1. `UNIVERSITY_LOCATIONS` in `server.js` stores the real latitude/longitude
   of every supported campus. The same constant feeds the university
   dropdowns and the distance math.
2. Listings store optional `latitude`/`longitude` (entered by landlords).
3. When both points exist, the server computes great-circle distance
   (haversine) and a banded time estimate, exposed as `listing.proximity`
   on every bootstrap listing:
   `{ distanceText, etaText, distanceKm, provider, approximate }`.
4. `GET /api/distance/university?listingId=...` (or `?university=...`)
   recomputes on demand, returning `available:false` gracefully for unknown
   universities or un-geocoded properties.

### Routing providers (swap-in without touching the property system)

`routeEtaKm()` tries providers in order and caches for 30 minutes:

| Provider | Env var | Result |
| --- | --- | --- |
| Google Directions | `GOOGLE_MAPS_API_KEY` | Real road distance + duration (`provider: "google_directions"`) |
| OSRM (self-hosted or public) | `OSRM_BASE_URL` | Real road distance + duration (`provider: "osrm"`) |
| Fallback | none needed | Haversine distance + banded estimate (`provider: "estimate"`, `approximate: true`) |

The UI renders whichever provider answered and labels the fallback
"straight-line estimate — actual road distance may differ".

## Privacy model

- **Property coordinates never leave the server.** `listingPayload()` strips
  `latitude`/`longitude` from every client payload (verified by a smoke
  test). Clients only ever see the proximity summary, which contains the
  *public university* coordinates.
- The OSM embed for owners is the one exact-coordinate surface; the public
  "View on map" link for un-geocoded context uses an area-text search, not a
  pin. If the Google SDK is added, keep property points jittered/circle-
  approximated and plot exact coordinates only for universities.
- Verification documents are **admin-only**: document bytes are served only
  under `/api/admin/*` (bearer `ADMIN_TOKEN`, timing-safe compare). No
  public or user-scoped route returns document data; users see only their
  own masked NIN and submission metadata.
