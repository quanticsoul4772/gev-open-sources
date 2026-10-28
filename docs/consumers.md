# Using the directory

## Quick start

Fetch the domain you decode, check the contract version, and keep the usable
entries:

```js
const url = 'https://quanticsoul4772.github.io/gev-open-sources/v1/transit.vehicles.json';
const { version, entries } = await (await fetch(url)).json();
if (version !== 1) throw new Error(`expected contract version 1, got ${version}`);
const usable = entries.filter((e) => e.health.status === 'verified' && e.licence.display === true);
```

Then validate each entry yourself before you request its URL (see
[Rules for consumers](#rules-for-consumers)), and credit
`licence.attribution` wherever you show its data.

## An entry

From `v1/transit.vehicles.json` on 28 October 2026:

```json
{
  "id": "atlas-f-75cj-mobi-rio-rt",
  "domain": "transit.vehicles",
  "name": "dados.mobilidade.rio",
  "provider": "dados.mobilidade.rio",
  "coverage": { "bbox": [-23.0411, -43.7248, -22.7752, -43.1616], "countries": ["BR"] },
  "access": {
    "url": "https://dados.mobilidade.rio/gtfs/realtime",
    "redirectHosts": [],
    "unzip": null,
    "headers": {},
    "min_interval_s": 15
  },
  "format": "gtfs-rt.vehicle-positions",
  "licence": {
    "id": "CC-BY-4.0",
    "url": "https://spdx.org/licenses/CC-BY-4.0",
    "display": true,
    "commercial": true,
    "attribution": "dados.mobilidade.rio"
  },
  "licence_decision": {
    "by": "known-licence",
    "evidence": [{ "field": "licence", "quote": "https://spdx.org/licenses/CC-BY-4.0" }],
    "terms_sha256": null,
    "at": "2026-10-14T16:46:39.562Z"
  },
  "provenance": ["transitland-atlas:f-75cj-mobi~rio~rt"],
  "health": {
    "status": "verified",
    "success_7d": 1,
    "median_age_s": 6,
    "records": 199,
    "last_ok": 1793212117,
    "last_probe": 1793212117
  }
}
```

## Fields

The schema ([`schema/entry.schema.json`](../schema/entry.schema.json)) is the
authority; in short:

- `coverage.bbox`: `[minLat, minLon, maxLat, maxLon]`, latitude first. This
  is not GeoJSON's `[minLon, minLat, maxLon, maxLat]`. `null` means unknown.
- `coverage.countries`: ISO 3166-1 alpha-2 codes; empty for global and
  continental feeds, and for feeds no country can be inferred for.
- `coverage.class`: `regional` (the default when absent), `national` or
  `global`.
- `access.url`: the URL to request. `access.related` (GBFS entries): the
  system's other files by name, such as `station_information`.
  `access.redirectHosts`: hosts a redirect may lead to besides the URL's own
  origin. `access.unzip`: when set, the response is a zip archive and this
  names the file inside it to read. `access.headers`: request headers to send.
  `access.min_interval_s`: the shortest interval between requests.
- `licence.display`: whether the data may be shown. `licence.commercial`:
  whether commercial use is allowed, `null` if unknown.
  `licence.attribution`: the credit to show. `licence.obligations`: the
  conditions an operator's terms page imposes, set by an `llm-terms` decision;
  it can remain on an entry whose terms were later rejected (referral-only).
- `licence_decision.by`: `known-licence`, `gbfs-v3-default`, `llm-terms`
  (an operator's terms page read by Claude) or `none`.
- `provenance`: where the entry came from: catalogue records (such as
  `transitland-atlas:`), hand-written source ids (such as `usgs:`), and
  markers for an earlier URL (`via:`) or a borrowed licence
  (`licence-borrowed:`, `licence-atlas:`).
- `health.status`: `candidate`, `verified` or `degraded` (`dead` entries
  are not published).
  `health.success_7d`: share of passing probes in 7 days. `median_age_s`: the
  median age of the newest record at probe time. `last_ok` and `last_probe`:
  Unix seconds.
- `gbfs` (GBFS entries) and `mapping` (cameras and fire perimeters): see
  the format list below.

## Formats

- `gtfs-rt.vehicle-positions`: a GTFS-Realtime `FeedMessage` (protobuf)
  with `VehiclePosition` entities.
- `gbfs.station-status`: GBFS `station_status`; station positions are in
  `access.related.station_information`.
- `gbfs.vehicle-status`: GBFS `vehicle_status` (v3) or `free_bike_status`
  (earlier versions); `gbfs.form_factors` lists the vehicle kinds (empty
  means unknown).
- `geojson.earthquakes`: a USGS GeoJSON summary feed.
- `geojson.gdacs-events`: GDACS's event list, a GeoJSON `FeatureCollection`
  with one Point per event.
- `csv.firms-active-fire`: a NASA FIRMS CSV with `latitude`, `longitude`,
  `acq_date` and `acq_time` (UTC, `HHMM`) columns.
- `geojson.fire-perimeters`: GeoJSON polygons; `mapping` names the
  properties holding the fire number, size and date, and the status and
  incident page where the province publishes them; `mapping.region` is the
  province's ISO 3166-2 code, not a property.
- `json.sensor-community`: Sensor.Community's `data.1h.json` array.
- `cameras.list`: a JSON list of cameras; `mapping` says where each camera's
  id, position and image are.

Each format's source is described in [how-it-works.md](how-it-works.md).

## Contract and versions

Published files, contract version 1:

| Path | Contents |
|---|---|
| `v1/directory.json` | every entry, with its health summary |
| `v1/<domain>.json` | one domain's entries, e.g. `v1/transit.vehicles.json` |
| `v1/index.json` | `generated_at`, and each file's path, domain, entry counts and bytes |
| `v1/entry.schema.json` | the entry schema; its `$id` names the version |
| `directory.json`, `entry.schema.json` | aliases of the v1 files |
| `state/*.json` | job state for the next run; not part of the contract |

Pages serves every file gzipped with an ETag, so a daily conditional GET of
the domain files a consumer reads costs little.

Version policy:

- **Additive changes keep the version**: a new optional field, a new
  `domain` or `format` value, a new per-domain file.
- **Breaking changes bump it**: removing or renaming a field, changing a
  field's type or meaning, or weakening a documented guarantee. The new
  version is published as `v2/` beside `v1/`, and `v1/` keeps being
  generated from the same data for at least 30 days before it is retired.
- Every document carries `version`. Pin `v1/` paths; the unversioned aliases
  follow the newest version.

## Rules for consumers

- The directory is harvested from third-party catalogues: treat it as
  untrusted input and validate every entry yourself. It publishes facts
  (access recipe, coverage, licence, health), never a per-app "compatible"
  flag.
- Two rules are shared with gods-eye-view on purpose: which URLs and request
  headers carry a credential, and how large a coverage box of each class
  (`regional`, `national`, `global`) may be. Their cases live in
  [`conformance/cases.json`](../conformance/cases.json); this repo's tests run
  every case, and the app vendors the file, so the two copies can't drift.
- `coverage.class` is optional; absent means `regional`. Deliberately wide
  entries carry a hand-set class (Amtrak is `national`), and hazard feeds
  default to `global` unless the entry sets a class (fire perimeters are
  `regional`). Other worldwide feeds set `global` themselves
  (Sensor.Community).
- `coverage.countries` comes from the catalogue, dropping a code whose
  country misses the bbox. An entry the catalogue gave none (every Transitland
  Atlas feed) takes the one country holding most of its bbox, from simplified
  Natural Earth outlines (`src/harvest/country-outlines.json`), or, for a
  small coastal bbox the outlines put all at sea, the country whose coast is
  nearest its centre within 25 km. Global and continental feeds, and feeds
  whose bbox lies farther out at sea, keep an empty list.
- Hand-written entries (USGS, GDACS, FIRMS, fire perimeters,
  Sensor.Community) are never
  redirect-rewritten and never tombstoned: after a long outage they stay
  dead (unpublished) and come back when the source answers again. A change
  to one of them in the code doesn't reach its existing `entries/` file;
  edit that file by hand.
- Its size changes gradually. A harvest adds at most 8 % of the current
  entries, and of each domain's, per run (the rest wait for later runs), and
  a directory whose total is under 85 % or over 180 % of any copy published
  in the last 30 hours is not published (`published.json` in the state). A
  domain of 50 or more entries that moves out of that range only logs a
  warning: one operator going dark must not stop every domain publishing. A
  consumer that refreshes daily can reject copies under 80 % or over twice
  its own in total, and should keep its own copy of a domain file that moves
  out of range.
- Free-floating vehicle feeds carry per-vehicle ids and rental links. GBFS
  2.0+ asks operators to rotate ids after each trip, but not all do (car
  sharing in particular): don't keep per-vehicle history or trails.
- Redirects are followed only to the same origin or a host in
  `access.redirectHosts`. New entries carry `coverage.bbox`; a few older
  transit candidates still have `null` (unknown) until their vehicles are
  seen. URLs carry no credential the gate recognises (`src/util/secrets.js`),
  but treat that as a filter, not a proof. Feed URLs may be plain http, an
  IP address or a non-default port: apply your own URL policy. New `domain`
  and `format` values may appear: ignore the ones you don't decode.
