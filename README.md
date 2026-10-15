# gev-open-sources

A self-maintaining directory of live data sources that need no API key, for
[God's Eye View](https://github.com/bilawalsidhu/gods-eye-view). Every six
hours a GitHub Actions run:

1. **Discovers** keyless feeds:
   - GTFS-Realtime vehicle positions from the [Mobility Database](https://mobilitydatabase.org)
     catalog, [Transitland Atlas](https://github.com/transitland/transitland-atlas)
     and [Transitous](https://github.com/public-transport/transitous). Catalogue
     feeds are fetched once and added only if they carry vehicle positions;
     failures are retried after a week (`harvest-rejects.json`).
   - Bike-share systems from MobilityData's [GBFS systems list](https://github.com/MobilityData/gbfs)
     and Transitous: docked stations (`bikeshare.stations`, `gbfs.station-status`)
     and free-floating vehicles (`sharedmobility.vehicles`, `gbfs.vehicle-status`:
     scooters, bikes, mopeds and cars from `vehicle_status`, or
     `free_bike_status` before v3). A system with both gets one entry for
     each. Vehicles entries count only vehicles without a `station_id`
     (docked ones belong to the stations entry) and list
     `gbfs.form_factors` from `vehicle_types` (empty means unknown).
     Peer-to-peer car sharing (Getaround and similar: private owners' cars,
     often parked at home) is left out; fleet car sharing stays.
   - USGS [earthquake summary feeds](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php)
     (`hazards.earthquakes`, GeoJSON, public domain).
   - GDACS [latest Orange and Red disaster alerts](https://www.gdacs.org/)
     (`hazards.disasters`, format `geojson.gdacs-events`): earthquakes,
     tropical cyclones, floods, volcanoes, droughts and wildfires, one point
     per event (`properties.iscurrent` marks active ones). Public domain by
     GDACS's own declaration in its RSS feed; the licence job re-reads that
     declaration every run and drops to referral-only if it is gone.
   - Still traffic cameras (`cameras.stills`, format `cameras.list`): Finland's
     Digitraffic weather cameras (CC BY 4.0), TfL JamCams and Caltrans CCTV
     (12 districts). Each entry carries a `mapping` that says where each
     camera's id, position and image sit in the list; the prober also checks
     one sample image (200, an image type, at least 2 KB). TfL and Caltrans
     stay referral-only until the licence job verifies their terms.

   URLs that carry a credential parameter, and catalogue entries marked as
   needing a key, are skipped. Cross-domain permalinks are pointed at their
   final URL, and plain-http feeds move to https when it serves the same data.
2. **Decides licences** with no human step: a known open licence
   (`src/licence/known-licences.json`). A transit feed with no licence of its
   own takes the one Transitland Atlas records for it, or (borrowed, known
   licences only) for its own static feed. GBFS 3.x systems with no licence are
   CC0 per the spec; operator terms pages are read by Claude and accepted only
   when every quote is verbatim in the page, two runs agree, and every
   obligation is one an app meets on its own. Everything else is
   referral-only (`licence.display: false`).
3. **Probes** every entry with the decoder an app would use, and moves it
   through `candidate → verified ⇄ degraded → dead` (verified: 3 passes in a
   row with records seen in 7 days). A passing candidate is probed up to three
   times in one run, 5 minutes apart, so a working new feed is verified in the
   run that finds it. Dead for 30 days → removed.
4. **Publishes** `directory.json` to GitHub Pages:
   `https://quanticsoul4772.github.io/gev-open-sources/directory.json`.

An entry is usable when `health.status === 'verified'` and
`licence.display === true`. Schema: `schema/entry.schema.json`.

### Contract and versions

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

### For consumers

- The directory is harvested from third-party catalogues: treat it as
  untrusted input and validate every entry yourself. It publishes facts
  (access recipe, coverage, licence, health), never a per-app "compatible"
  flag.
- Two rules are shared with gods-eye-view on purpose: which URLs and request
  headers carry a credential, and how large a coverage box of each class
  (`regional`, `national`, `global`) may be. Their cases live in
  [`conformance/cases.json`](conformance/cases.json); this repo's tests run
  every case, and the app vendors the file, so the two copies can't drift.
- `coverage.class` is optional; absent means `regional`. Deliberately wide
  entries carry a hand-set class (Amtrak is `national`), and hazard feeds
  are published as `global`.
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

```
npm ci
npm test
npm run cycle        # harvest → licence → probe → build (ANTHROPIC_API_KEY for tier 2)
node src/scan-secrets.js entries dist   # gate: no credentials in any output
node src/validate-dist.js entries dist  # gate: every entry valid against the schema
```
